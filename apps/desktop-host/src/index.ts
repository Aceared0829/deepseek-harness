/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { delimiter, join } from 'node:path'
import { inspect } from 'node:util'
import { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as desktopOffice from './office.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { installDesktopQuitInspection } from './quit-inspection.ts'
import { installPlatformSessionPublisher } from './platform-session.ts'
import { installOfficeEngineResolution } from './office-engine.ts'

async function main(): Promise<void> {
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  installOfficeEngineResolution(runtimeDir)
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  reportSkippedBundles('dsh', profile)
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    ...(process.argv[5] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[5]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  let stopping: Promise<void> | undefined
  const control: {
    updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl>
    quitInspection?: ReturnType<typeof installDesktopQuitInspection>
    bootInjections?: () => { injections: readonly unknown[]; lease: string }
  } = {}
  const bootLeases = new Map<string, () => void>()
  let nextBootLease = 1
  const send = createIpcSender(process)
  const stop = (): Promise<void> => stopping ??= (async () => {
    for (const release of bootLeases.values()) release()
    bootLeases.clear()
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type === 'quit-inspection') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return
      const requestId = message.requestId
      void (async () => {
        try {
          if (stopping !== undefined || control.quitInspection === undefined) throw new Error('desktop quit: Host is unavailable')
          const inspection = await control.quitInspection()
          await send({ type: 'quit-inspection', requestId, ...inspection })
        } catch (error) {
          // The shell treats an unknown state as interruptible work and asks before quitting.
          await send({ type: 'quit-inspection', requestId, activeTasks: true, scheduledTasks: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type === 'boot-injections') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return
      const requestId = message.requestId
      void (async () => {
        let lease: string | undefined
        try {
          if (stopping !== undefined || control.bootInjections === undefined) throw new Error('desktop boot: Host is unavailable')
          const boot = control.bootInjections()
          lease = boot.lease
          try {
            await send({ type: 'boot-injections', requestId, ...boot })
          } catch (error) {
            bootLeases.get(boot.lease)?.()
            bootLeases.delete(boot.lease)
            throw error
          }
        } catch (error) {
          await send({ type: 'boot-injections', requestId, error: error instanceof Error ? error.message : String(error) })
            .catch((failure: unknown) => {
              if (lease !== undefined) {
                bootLeases.get(lease)?.()
                bootLeases.delete(lease)
              }
              console.error(failure)
            })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type === 'boot-injections-release') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)
        || !('lease' in message) || typeof message.lease !== 'string') return
      const requestId = message.requestId
      const release = bootLeases.get(message.lease)
      if (release !== undefined) {
        bootLeases.delete(message.lease)
        release()
      }
      void send({ type: 'boot-injections-release', requestId })
        .catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  control.quitInspection = installDesktopQuitInspection(ctx)
  control.bootInjections = () => {
    const clientModules = ctx.get('clientModules')
    if (clientModules === undefined) throw new Error('desktop boot: client modules are unavailable')
    const release = clientModules.retainBootResponses()
    try {
      const injections = ctx.webServer.collectIndexInjections()
      const lease = `boot-${String(nextBootLease)}`
      nextBootLease += 1
      bootLeases.set(lease, release)
      return { injections, lease }
    } catch (error) {
      release()
      throw error
    }
  }
  await ctx.plugin(desktopOffice, {
    runtimeDir,
    source: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  installPlatformSessionPublisher(ctx, (session) => {
    void send({ type: 'platform-session', session }).catch((error: unknown) => { console.error(error) })
  })
  const url = ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`)
  await send({ type: 'ready', url })
}

/** Upper bound of the startup diagnostic carried over IPC; the head holds the message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
    // This path runs without the main closure, so keep the receiver assignment local.
    const write = process.send?.bind(process)
    if (process.connected && write !== undefined) {
      write({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    }
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}

/** The process surface used to send one lifecycle message. */
interface IpcProcess {
  /** Whether the parent IPC channel still accepts writes. */
  readonly connected: boolean
  /** Writes one lifecycle message; omitted when no IPC channel was created. */
  readonly send?: (this: IpcProcess, message: object, callback: (error: Error | null) => void) => boolean
}

/**
 * Write one lifecycle message without detaching the method from its process.
 * Electron's Node-mode `process.send` requires the process as `this`, unlike
 * the pre-bound method exposed by a plain Node child.
 */
export function createIpcSender(target: IpcProcess): (message: object) => Promise<void> {
  return message => new Promise((resolve, reject) => {
    const write = target.send
    if (!target.connected || write === undefined) { resolve(); return }
    write.call(target, message, (error) => { if (error === null) resolve(); else reject(error) })
  })
}
