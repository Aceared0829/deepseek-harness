import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'stage-verify.mjs')
const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface PluginFixture {
  readonly root: string
  readonly plugin: string
}

function write(path: string, content: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function pluginFixture(options: {
  readonly bundlePatch?: boolean
  readonly hostEntry?: string
  readonly hostSource?: string
  readonly client?: boolean
} = {}): PluginFixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stage-verify-'))
  fixtureRoots.push(root)
  const plugin = join(root, 'plugin')
  const main = options.hostEntry ?? 'index.js'
  write(join(plugin, 'package.json'), JSON.stringify({
    name: '@fixture/plugin',
    type: 'module',
    main,
    exports: {
      '.': `./${main}`,
      ...options.client === true && { './client': './client.js' },
    },
    ...(options.bundlePatch !== false || options.client === true) && {
      dsh: {
        ...options.bundlePatch !== false && { bundle: { patch: './cordis.patch.yml' } },
        ...options.client === true && { client: { platform: 'web' } },
      },
    },
  }, null, 2))
  if (options.bundlePatch !== false) write(join(plugin, 'cordis.patch.yml'), '[]\n')
  write(join(plugin, main), options.hostSource ?? 'export const name = "fixture"\n')
  if (options.client === true) {
    write(join(plugin, 'client.js'), 'window.__ModuleLoader__.load({ id: \'fixture-client\', factory: () => ({ apply() {} }) })\n')
  }
  return { root, plugin }
}

function runStatic(plugin: string, extra: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, plugin, '--static-only', ...extra], {
    encoding: 'utf8',
    timeout: 30_000,
    env: testEnvironment(),
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function testEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    Path: process.env.Path,
    path: process.env.path,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATHEXT: process.env.PATHEXT,
    SYSTEMROOT: process.env.SYSTEMROOT,
  }
}

/**
 * A fake CLI must be a file whose basename is bin.js because stage-verify
 * invokes it through Node; its JSON state records the exact argv it received.
 */
function fakeCli(root: string, options: {
  readonly mutateBundles?: boolean
  readonly boot?: 'serve' | 'exit' | 'inactive'
  readonly announce?: boolean
} = {}): string {
  const bin = join(root, 'dsh', 'lib', 'bin.js')
  const state = join(root, 'cli-state.json')
  write(bin, `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const statePath = ${JSON.stringify(state)}
const records = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : []
records.push(args)
writeFileSync(statePath, JSON.stringify(records))

if (args.includes('--version')) {
  process.stdout.write('0.0.0-fixture\\n')
  process.exit(0)
}

const profileIndex = args.indexOf('--profile')
const profile = args[profileIndex + 1]
const home = process.env.DSH_HOME
if (!home) throw new Error('DSH_HOME missing')
const profileDir = join(home, 'profiles', profile)

if (args.includes('--from-default-profile')) {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }))
  process.exit(0)
}

if (args[0] === 'plugin') {
  const plugin = args.at(-1)
  const manifest = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'))
  const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  profileManifest.dependencies[manifest.name] = 'file:' + plugin
  ${options.mutateBundles === false ? '' : 'profileManifest.dsh.profile.bundles.push(manifest.name)'}
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(profileManifest))
  mkdirSync(join(profileDir, 'node_modules', ...manifest.name.split('/')), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', ...manifest.name.split('/'), 'package.json'), JSON.stringify(manifest))
  process.exit(0)
}

if (args.includes('--port')) {
  ${options.boot === 'exit' ? "process.stderr.write('fixture boot failed\\n'); process.exit(1)" : ''}
  ${options.boot === 'inactive' ? "console.log('warning: 1 entry did not activate')" : ''}
  if (${JSON.stringify(options.announce !== false)}) {
    const server = createServer((request, response) => {
      response.end(${JSON.stringify('<html>@fixture/plugin</html>')})
    })
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      console.log('dsh web: http://127.0.0.1:' + port + '/?token=fixture-token')
    })
  } else {
    setInterval(() => {}, 1000)
  }
}
`)
  return bin
}

function runFull(f: PluginFixture, bin: string, extra: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, f.plugin, '--dsh', bin, '--home', f.root, '--timeout', '5', ...extra], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...testEnvironment(), TEMP: f.root, TMP: f.root },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('stage verify static checks', () => {
  it('passes a loadable Host entry and Client factory', () => {
    const f = pluginFixture({ client: true })
    const result = runStatic(f.plugin)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('PASS  Host entry loads (index.js)')
    expect(result.stdout).toContain('PASS  client module id fixture-client')
    expect(result.stdout).toContain('PASS  client factory returned apply()')
  })

  it('rejects options that would otherwise silently fall back to defaults', () => {
    const f = pluginFixture()
    const missing = runStatic(f.plugin, ['--dsh'])
    expect(missing.status).toBe(1)
    expect(missing.stdout + missing.stderr).toContain('--dsh needs a value')

    const invalidPort = runStatic(f.plugin, ['--port', '0'])
    expect(invalidPort.status).toBe(1)
    expect(invalidPort.stdout + invalidPort.stderr).toContain('--port needs an integer from 1 to 65535')

    const invalidTimeout = runStatic(f.plugin, ['--timeout', '0'])
    expect(invalidTimeout.status).toBe(1)
    expect(invalidTimeout.stdout + invalidTimeout.stderr).toContain('--timeout needs a positive number of seconds')
  })

  it('fails a Host entry that throws while loading', () => {
    const f = pluginFixture({ hostSource: 'throw new Error("fixture import failed")\n' })
    const result = runStatic(f.plugin)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL  Host entry failed to load')
    expect(result.stdout).toContain('fixture import failed')
  })

  it('rejects missing manifest paths and a client entry without the web platform declaration', () => {
    const f = pluginFixture({ client: true })
    writeFileSync(join(f.plugin, 'package.json'), JSON.stringify({
      name: '@fixture/plugin', main: './missing.js', exports: { './client': './client.js' },
      dsh: { bundle: { patch: './missing.yml' } },
    }))
    const result = runStatic(f.plugin)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('main -> ./missing.js does not exist')
    expect(result.stdout).toContain('dsh.bundle.patch -> ./missing.yml does not exist')
    expect(result.stdout).toContain('exports["./client"] present but dsh.client.platform is not web')
  })

  it('warns in static-only mode when the package cannot install as a bundle', () => {
    const f = pluginFixture({ bundlePatch: false })
    const result = runStatic(f.plugin)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('WARN  dsh.bundle.patch is missing')
    expect(result.stdout).toContain('VERDICT  PASS')
  })
})

describe('stage verify full gate', () => {
  it('installs, boots, probes, detects activation, and removes its staging home', () => {
    const f = pluginFixture()
    const bin = fakeCli(f.root)
    const result = runFull(f, bin)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PASS  bundle list includes @fixture/plugin')
    expect(result.stdout).toContain('accepted the token and served the shell (HTTP 200)')
    expect(result.stdout).toContain('PASS  boot payload names @fixture/plugin')
    expect(result.stdout).not.toContain('staging kept:')
    expect(readdirSync(f.root).filter(name => name.startsWith('dsh-stage-'))).toEqual([])

    const calls = JSON.parse(readFileSync(join(f.root, 'cli-state.json'), 'utf8')) as string[][]
    expect(calls).toContainEqual(['--profile', 'verify', '--from-default-profile', 'web', '--dump-default-config'])
    expect(calls).toContainEqual(['plugin', '--profile', 'verify', 'add', f.plugin])
    expect(calls.some(args => args[0] === '--profile' && args.includes('--port') && args.includes('--no-open'))).toBe(true)
  })

  it('fails before staging when dsh.bundle.patch is absent', () => {
    const f = pluginFixture({ bundlePatch: false })
    const result = runStatic(f.plugin, ['--keep'])
    expect(result.status).toBe(0)

    const bin = fakeCli(f.root)
    const full = runFull(f, bin)
    expect(full.status).toBe(1)
    expect(full.stdout).toContain('does not declare dsh.bundle.patch')
    expect(existsSync(join(f.root, 'cli-state.json'))).toBe(false)
  })

  it('fails when installation leaves the package out of the bundle list', () => {
    const f = pluginFixture()
    const bin = fakeCli(f.root, { mutateBundles: false })
    const result = runFull(f, bin)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('installation did not activate its bundle layer')
  })

  it('fails when a plugin logs an inactive entry', () => {
    const f = pluginFixture()
    const bin = fakeCli(f.root, { boot: 'inactive' })
    const result = runFull(f, bin)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL  1 entry did not activate')
  })

  it('fails and keeps staging when the staged Host exits during boot', () => {
    const f = pluginFixture()
    const bin = fakeCli(f.root, { boot: 'exit' })
    const result = runFull(f, bin)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('staged instance exited with code 1 during boot')
    expect(result.stdout).toContain('staging kept:')
    expect(result.stdout).toContain(process.platform === 'win32' ? '$env:DSH_HOME=' : 'DSH_HOME=')
    expect(readdirSync(f.root).filter(name => name.startsWith('dsh-stage-'))).toHaveLength(1)
  })
})
