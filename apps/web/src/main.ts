/** Browser entry for the Web client. */
import '@deepseek-ai/dsh-client-ui-theme/brand-font.css'
import { AppWebEntry, applyIndexInjections } from '@deepseek-ai/dsh-client-web'

interface DesktopBootGlobal {
  dshDesktopBoot?: {
    failed(message: string): Promise<void>
    ready(): Promise<{ injections: Parameters<typeof applyIndexInjections>[0]; lease: string; streamBaseUrl: string }>
    release(lease: string): Promise<void>
  }
}
const desktop = (globalThis as DesktopBootGlobal).dshDesktopBoot
const reportFailure = (reason: unknown): void => {
  if (desktop === undefined) throw reason
  void desktop.failed(reason instanceof Error ? reason.message : String(reason)).catch(console.error)
}

try {
  const el = document.getElementById('root')
  if (el === null) throw new Error('web app: missing #root')
  const entry = new AppWebEntry(el)
  let lease: string | undefined
  let boot: Promise<void> | undefined
  if (desktop !== undefined) {
    const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
    if (gate === undefined) throw new Error('desktop web: boot readiness is missing')
    boot = desktop.ready().then(async ({ injections, lease: acquiredLease, streamBaseUrl }) => {
      lease = acquiredLease
      const transport = globalThis as { __DSH_TRANSPORT__?: { ownsHost: boolean; streamBaseUrl: string } }
      transport.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
      await applyIndexInjections(injections, src => new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = src
        script.onload = () => { resolve() }
        script.onerror = () => { reject(new Error(`desktop web: failed to load ${src}`)) }
        document.head.append(script)
      }))
      gate.resolve()
    }).catch((error: unknown) => { gate.reject(error) })
  }
  const run = Promise.resolve(entry.run(desktop === undefined ? undefined : reportFailure))
  const bootAndRun = desktop === undefined || boot === undefined ? run : Promise.allSettled([boot, run])
  void bootAndRun.finally(() => {
    if (lease === undefined || desktop === undefined) return
    void desktop.release(lease).catch((error: unknown) => {
      console.error('desktop web: failed to release boot responses', error)
    })
  })
} catch (reason) {
  reportFailure(reason)
}
