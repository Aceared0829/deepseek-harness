// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

const boot = vi.hoisted(() => ({
  run: vi.fn(),
  applyIndexInjections: vi.fn(async () => {}),
}))
vi.mock('@deepseek-ai/dsh-client-web', () => ({
  AppWebEntry: class { run = boot.run },
  applyIndexInjections: boot.applyIndexInjections,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.resetModules()
  boot.run.mockReset()
  boot.applyIndexInjections.mockReset().mockResolvedValue(undefined)
  document.body.replaceChildren()
})

it('forwards client initialization failures to native recovery', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const gate = Promise.withResolvers<undefined>()
  const failed = vi.fn(async () => {})
  const release = vi.fn(async () => {})
  vi.stubGlobal('__DSH_BOOT_READY__', gate)
  vi.stubGlobal('dshDesktopBoot', { ready: async () => ({ injections: [], lease: 'boot-1', streamBaseUrl: 'http://127.0.0.1:3080' }), release, failed })
  vi.stubGlobal('__DSH_TRANSPORT__', undefined)
  await import('../src/main.ts')
  await gate.promise
  expect(boot.applyIndexInjections).toHaveBeenCalledWith([], expect.any(Function))
  const report = boot.run.mock.calls[0]![0] as (reason: unknown) => void
  report(new Error('client plugin activation failed'))
  expect(failed).toHaveBeenCalledWith('client plugin activation failed')
  expect(release).toHaveBeenCalledExactlyOnceWith('boot-1')
})

it('rejects the shared boot wait when the Desktop Host cannot start', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const gate = Promise.withResolvers<undefined>()
  const failure = new Error('Host failed')
  const rejected = expect(gate.promise).rejects.toBe(failure)
  const release = vi.fn(async () => {})
  vi.stubGlobal('__DSH_BOOT_READY__', gate)
  vi.stubGlobal('dshDesktopBoot', { ready: async () => { throw failure }, release, failed: vi.fn() })
  await import('../src/main.ts')
  await rejected
  expect(boot.applyIndexInjections).not.toHaveBeenCalled()
  expect(boot.run).toHaveBeenCalledWith(expect.any(Function))
  expect(release).not.toHaveBeenCalled()
})

it('leaves browser failure presentation with the Web boot kernel', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  vi.stubGlobal('dshDesktopBoot', undefined)
  await import('../src/main.ts')
  expect(boot.run).toHaveBeenCalledWith(undefined)
})

it.each(['root', 'readiness'])('reports missing %s before client plugin startup', async (missing) => {
  if (missing !== 'root') document.body.innerHTML = '<div id="root"></div>'
  const failed = vi.fn(async () => {})
  vi.stubGlobal('dshDesktopBoot', { ready: vi.fn(), release: vi.fn(), failed })
  vi.stubGlobal('__DSH_BOOT_READY__', undefined)
  await import('../src/main.ts')
  expect(failed).toHaveBeenCalledWith(missing === 'root'
    ? 'web app: missing #root' : 'desktop web: boot readiness is missing')
  expect(boot.run).not.toHaveBeenCalled()
})

it('releases the boot lease only after plugin startup settles', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const gate = Promise.withResolvers<undefined>()
  const app = Promise.withResolvers<undefined>()
  const release = vi.fn(async () => {})
  boot.run.mockReturnValueOnce(app.promise)
  vi.stubGlobal('__DSH_BOOT_READY__', gate)
  vi.stubGlobal('dshDesktopBoot', {
    ready: async () => ({ injections: [], lease: 'boot-1', streamBaseUrl: 'http://127.0.0.1:3080' }),
    release,
    failed: vi.fn(),
  })
  await import('../src/main.ts')
  gate.resolve(undefined)
  await vi.waitFor(() => { expect(boot.run).toHaveBeenCalledOnce() })
  expect(release).not.toHaveBeenCalled()
  app.resolve(undefined)
  await vi.waitFor(() => { expect(release).toHaveBeenCalledExactlyOnceWith('boot-1') })
})

it('releases the boot lease after injection failure without replacing native recovery', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const gate = Promise.withResolvers<undefined>()
  const release = vi.fn(async () => {})
  const failure = new Error('asset failed')
  boot.applyIndexInjections.mockRejectedValueOnce(failure)
  vi.stubGlobal('__DSH_BOOT_READY__', gate)
  vi.stubGlobal('dshDesktopBoot', {
    ready: async () => ({ injections: [], lease: 'boot-1', streamBaseUrl: 'http://127.0.0.1:3080' }),
    release,
    failed: vi.fn(),
  })
  await import('../src/main.ts')
  await expect(gate.promise).rejects.toBe(failure)
  await vi.waitFor(() => { expect(release).toHaveBeenCalledExactlyOnceWith('boot-1') })
})

it('releases the boot lease only after boot fails and the remaining app run settles', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const gate = Promise.withResolvers<undefined>()
  const app = Promise.withResolvers<undefined>()
  const release = vi.fn(async () => {})
  const failure = new Error('asset failed')
  boot.run.mockReturnValueOnce(app.promise)
  boot.applyIndexInjections.mockRejectedValueOnce(failure)
  vi.stubGlobal('__DSH_BOOT_READY__', gate)
  vi.stubGlobal('dshDesktopBoot', {
    ready: async () => ({ injections: [], lease: 'boot-1', streamBaseUrl: 'http://127.0.0.1:3080' }),
    release,
    failed: vi.fn(),
  })
  await import('../src/main.ts')
  await expect(gate.promise).rejects.toBe(failure)
  await Promise.resolve()
  expect(release).not.toHaveBeenCalled()
  app.resolve(undefined)
  await vi.waitFor(() => { expect(release).toHaveBeenCalledExactlyOnceWith('boot-1') })
})
