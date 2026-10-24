/** Electron Node-mode child lifecycle for the shared Web application. */

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import { desktopNodeEnvironment } from './node-environment.ts'

interface ReadyEvent {
  readonly type: 'ready'
  readonly url: string
}

interface FatalEvent {
  readonly type: 'fatal'
  readonly message: string
  /** The Host's complete inspected error: stack, enumerable properties, cause chain. */
  readonly diagnostic?: string
}

interface PlatformSessionEvent {
  readonly type: 'platform-session'
  readonly session: PlatformSession | null
}

type DesktopHostEvent = ReadyEvent | FatalEvent | PlatformSessionEvent | { readonly type: 'shutdown-complete' } | {
  readonly type: 'file-drag-resource'
  readonly requestId: number
  readonly resource: { readonly path: string; readonly sha256: string; readonly size: number } | null
  readonly error?: string
} | {
  readonly type: 'update-tasks'
  readonly requestId: number
  readonly active: boolean
  /** Event-loop delay observed by the Host; present on `inspect` answers, absent on handoff actions. */
  readonly eventLoopDelay?: DesktopEventLoopDelay
  readonly error?: string
} | {
  readonly type: 'boot-injections'
  readonly requestId: number
  readonly injections?: readonly unknown[]
  readonly lease?: string
  readonly error?: string
} | {
  readonly type: 'boot-injections-release'
  readonly requestId: number
  readonly error?: string
} | {
  readonly type: 'quit-inspection'
  readonly requestId: number
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
  readonly error?: string
}

/** Correlated answer to one shell control request. */
type DesktopHostControlResponse = Extract<DesktopHostEvent, { readonly requestId: number }>

/** Event-loop delay the Host measured, in whole milliseconds; all zeros when it recorded nothing. */
export interface DesktopEventLoopDelay {
  /** Observation window in milliseconds; 0 when the Host ran no sampler. */
  readonly observedMs: number
  readonly samples: number
  readonly p50Ms: number
  readonly p99Ms: number
  readonly maxMs: number
}

/** What quitting now would affect, as reported by the Host. */
export interface DesktopQuitInspection {
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
}

/** Quit inspection deadline; a slower Host counts as unknown work and the shell asks before quitting. */
export const QUIT_INSPECTION_DEADLINE_MS = 2_000

/**
 * Upper bound on Host startup. A Host that never reports readiness is either waiting forever on a plugin the
 * profile mounts or blocked in one: without a deadline the shell waits on `start()` for the process lifetime and
 * the window stays in its starting state.
 */
export const HOST_READY_TIMEOUT_MS = 120_000

const MAX_HOST_DIAGNOSTIC_CHARS = 64 * 1024

/** Whether a control reply carries a delay measurement this shell can report. */
function isEventLoopDelay(value: unknown): value is DesktopEventLoopDelay {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return ['observedMs', 'samples', 'p50Ms', 'p99Ms', 'maxMs'].every((field) => {
    const field_ = candidate[field]
    return Number.isSafeInteger(field_) && (field_ as number) >= 0
  })
}

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'shutdown-complete':
      return true
    case 'ready':
      return typeof candidate.url === 'string' && candidate.injections === undefined
    case 'platform-session': {
      const session = candidate.session
      if (session === null) return true
      if (typeof session !== 'object' || !('origin' in session) || !('token' in session)
        || typeof session.origin !== 'string' || typeof session.token !== 'string' || session.token.length === 0) return false
      if (!('userId' in session) || (session.userId !== null
        && (typeof session.userId !== 'string' || session.userId.length === 0))) return false
      if ('embeddedPageDist' in session && typeof session.embeddedPageDist !== 'string') return false
      if ('requestHeaders' in session && (typeof session.requestHeaders !== 'object' || session.requestHeaders === null
        || Array.isArray(session.requestHeaders)
        || Object.entries(session.requestHeaders).some(([name, value]) => typeof value !== 'string'
          || name !== name.toLowerCase() || /[\r\n]/.test(value)
          || ['authorization', 'x-dsh-auth-token', 'host', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(name)))) return false
      try {
        const url = new URL(session.origin)
        return url.origin === session.origin && !url.username && !url.password
          && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      } catch { return false }
    }
    case 'fatal':
      return typeof candidate.message === 'string' && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'update-tasks':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.active === 'boolean'
        && (candidate.error === undefined || typeof candidate.error === 'string')
        && (candidate.eventLoopDelay === undefined || isEventLoopDelay(candidate.eventLoopDelay))
    case 'boot-injections':
      return Number.isSafeInteger(candidate.requestId)
        && ((Array.isArray(candidate.injections) && typeof candidate.lease === 'string' && candidate.lease.length > 0
          && candidate.error === undefined)
          || (candidate.injections === undefined && typeof candidate.error === 'string'))
    case 'boot-injections-release':
      return Number.isSafeInteger(candidate.requestId)
        && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'file-drag-resource': {
      const resource = candidate.resource
      return Number.isSafeInteger(candidate.requestId) && (candidate.error === undefined || typeof candidate.error === 'string')
        && (resource === null || (typeof resource === 'object' && 'path' in resource && typeof resource.path === 'string'
          && 'sha256' in resource && typeof resource.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(resource.sha256)
          && 'size' in resource && typeof resource.size === 'number' && Number.isSafeInteger(resource.size) && resource.size >= 0))
    }
    case 'quit-inspection':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === 'boolean'
        && typeof candidate.scheduledTasks === 'boolean' && (candidate.error === undefined || typeof candidate.error === 'string')
    default:
      return false
  }
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Browser authentication URL reported by the running Web application. */
export interface DesktopHostReady {
  readonly url: string
}

/** Startup injection rows and the Host lease that keeps their resources resolvable. */
export interface DesktopBootInjections {
  readonly injections: readonly unknown[]
  readonly lease: string
}

/** The child has exited, but task teardown did not finish successfully. */
export class DesktopHostUncleanExitError extends Error {}

/**
 * A Host failure reported over IPC before the process exited. `message` is what
 * the Host chose to show; `diagnostic` is its complete inspected error, kept
 * separately so a crash report can print it verbatim instead of a string escaped
 * inside another error's properties.
 */
export class DesktopHostFatalError extends Error {
  readonly #diagnostic: string | undefined

  /**
   * @param message - The Host's failure message.
   * @param diagnostic - The Host's inspected error, when the Host supplied one.
   */
  constructor(message: string, diagnostic: string | undefined) {
    super(message)
    this.#diagnostic = diagnostic
  }

  /** The Host's inspected error; a getter so `util.inspect` of this error does not repeat it as an escaped property. */
  get diagnostic(): string | undefined { return this.#diagnostic }
}

/**
 * The Host did not report readiness before {@link HOST_READY_TIMEOUT_MS}. Unlike a crash or a reported fatal error,
 * nothing inside the Host observed the failure, so this is the only record that startup stalled.
 */
export class DesktopHostReadyTimeoutError extends Error {}

/** One Web backend running under the Electron executable in Node mode. */
export class DesktopHostProcess {
  private child: ChildProcess | undefined
  private readyResolve!: (ready: DesktopHostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  /** Startup deadline; cleared once readiness arrives or the attempt fails. */
  private readyDeadline: ReturnType<typeof setTimeout> | undefined
  private stderr = ''
  private failureReported = false
  private stopping = false
  private shutdownCompleted = false
  private nextControlId = 1
  private readonly controlRequests = new Map<number, {
    resolve: (response: DesktopHostControlResponse) => void
    reject: (error: Error) => void
  }>()

  /**
   * @param node - Absolute Electron executable in Node mode.
   * @param runtimeDir - Immutable packages carried by the current application.
   * @param projectDir - Desktop plugin profile and child working directory.
   * @param inspectPort - Optional loopback inspector port for workspace development.
   * @param environment - Environment inherited by the Host and its plugin subprocesses.
   * @param onFailure - Receives the first unexpected child failure, including after readiness.
   * @param primaryRuntime - Optional bundled dependency payload; when supplied, missing sibling
   *   `office-skills` resources fail Host startup.
   * @param packageManager - Bundled pnpm entry and Node launcher directory, scoped to package operations.
   * @param onPlatformSession - Private credential updates for embedded Platform views.
   * @param readyTimeoutMs - Startup deadline after which a silent Host is treated as failed and stopped.
   */
  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
    private readonly primaryRuntime?: string,
    private readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string },

    private readonly onPlatformSession?: (session: PlatformSession | null) => void,
    private readonly readyTimeoutMs: number = HOST_READY_TIMEOUT_MS,
  ) {}

  /**
   * Start this child once and await its Web application URL. A Host that never reports readiness fails at
   * {@link HOST_READY_TIMEOUT_MS} instead of holding the caller open; the caller's cleanup then stops it.
   * @returns Ready facts supplied by the child after application startup.
   */
  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise
    const entry = join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
    const child = spawn(this.node, [
      '--expose-internals',
      ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
      entry,
      this.runtimeDir,
      this.projectDir,
      this.primaryRuntime ?? join(this.runtimeDir, '..', 'runtime', 'primary-runtime'),
      ...this.packageManager === undefined ? [] : [this.packageManager.pnpm, this.packageManager.nodeBin],
    ], {
      cwd: this.projectDir,
      env: desktopNodeEnvironment(this.node, undefined, this.environment),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    this.readyDeadline = setTimeout(() => {
      // Nothing the shell can wait for arrives: a synchronous loop in one plugin holds the Host's event loop, so
      // even its own `fatal` report could not be sent. Fail here and let the caller's cleanup kill the tree.
      const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
      this.fail(new DesktopHostReadyTimeoutError(
        `dsh desktop host did not report readiness within ${String(this.readyTimeoutMs)} ms${suffix}`,
      ))
    }, this.readyTimeoutMs)
    this.readyDeadline.unref()
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-MAX_HOST_DIAGNOSTIC_CHARS) })
    child.stdout?.pipe(process.stdout)
    child.on('message', (message: unknown) => {
      if (!isDesktopHostEvent(message)) {
        this.fail(new Error('dsh desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      if (message.type === 'ready') {
        this.clearReadyDeadline()
        this.readyResolve({ url: message.url })
      }
      else if (message.type === 'platform-session') this.onPlatformSession?.(message.session)
      else if (message.type === 'shutdown-complete') {
        if (this.stopping) this.shutdownCompleted = true
        else this.fail(new Error('dsh desktop host acknowledged an unrequested shutdown'))
      }
      else if (message.type === 'fatal') this.fail(new DesktopHostFatalError(message.message, message.diagnostic))
      else {
        const request = this.controlRequests.get(message.requestId)
        if (message.error === undefined) request?.resolve(message)
        else request?.reject(new Error(message.error))
      }
    })
    child.once('error', (error) => { this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('close', (code) => {
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
        else this.fail(new Error(`dsh desktop host stopped${suffix}`))
        resolve()
      })
    })
    return this.readyPromise
  }

  /**
   * Ask the Host whether its event loop still answers, without changing anything.
   * A Host blocked in a plugin's synchronous loop leaves the request unanswered, which is the only symptom an
   * outside process can observe. When it does answer, the reply also carries how long its loop had been blocked,
   * which separates a long task from a slow request.
   * @param deadlineMs - Time the Host is given to answer before the probe reports unresponsive.
   * @returns The measurement the Host reported with its answer, or undefined when it did not answer in time.
   */
  async probe(deadlineMs = 5_000): Promise<DesktopEventLoopDelay | undefined> {
    // No child, or one already stopping or failed, is owned by its own lifecycle path, not by a probe.
    if (this.unavailable()) return undefined
    try {
      const response = await this.control({ type: 'update-tasks', action: 'inspect' }, deadlineMs,
        'desktop liveness: probe timed out', 'desktop liveness')
      return response.type === 'update-tasks' ? response.eventLoopDelay : undefined
    } catch (error) {
      // The child can finish exiting between the check above and this answer.
      if (this.unavailable()) return undefined
      console.warn('desktop liveness: Host did not answer a probe', error)
      return undefined
    }
  }

  /** Whether this instance currently owns no answerable child; read through a call so it is never narrowed. */
  private unavailable(): boolean {
    return this.child === undefined || this.stopping || this.failureReported
  }

  /**
   * Inspect active work or lock request admission for update handoff.
   * @param action - Read-only inspection, admission lock, or recovery unlock.
   * @returns Whether live tasks would be affected. Locking drains admitted API requests before inspecting tasks;
   * an unanswered drain fails at the control-request deadline without authorizing installation.
   */
  async updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    const response = await this.control({ type: 'update-tasks', action }, 10_000, 'desktop update: task inspection timed out', 'desktop update')
    if (response.type !== 'update-tasks') throw new Error('desktop update: Host answered with a different control response')
    return response.active
  }

  /**
   * Ask the Host what quitting now would interrupt.
   * @returns Active tasks and armed scheduled reminders; rejects when the Host is unavailable or misses
   * {@link QUIT_INSPECTION_DEADLINE_MS}, and the shell then asks before quitting.
   */
  async inspectQuit(): Promise<DesktopQuitInspection> {
    const response = await this.control({ type: 'quit-inspection' }, QUIT_INSPECTION_DEADLINE_MS, 'desktop quit: inspection timed out', 'desktop quit')
    if (response.type !== 'quit-inspection') throw new Error('desktop quit: Host answered with a different control response')
    return { activeTasks: response.activeTasks, scheduledTasks: response.scheduledTasks }
  }

  /**
   * Collect the injection rows for the Host's current client bundle generation
   * and retain its resources until {@link releaseBootInjections}.
   * @returns The current boot injection table and its Host lease.
   */
  async bootInjections(): Promise<DesktopBootInjections> {
    const response = await this.control({ type: 'boot-injections' }, 10_000,
      'desktop boot: injections timed out', 'desktop boot')
    if (response.type !== 'boot-injections' || response.injections === undefined || response.lease === undefined) {
      throw new Error(response.error === undefined
        ? 'desktop boot: Host answered without injections'
        : `desktop boot: ${response.error}`)
    }
    return { injections: response.injections, lease: response.lease }
  }

  /**
   * Release a startup injection lease after the renderer no longer needs its URLs.
   * @param lease - Lease returned by {@link bootInjections}.
   */
  async releaseBootInjections(lease: string): Promise<void> {
    if (lease === '') throw new Error('desktop boot: lease must not be empty')
    const response = await this.control({ type: 'boot-injections-release', lease }, 10_000,
      'desktop boot: lease release timed out', 'desktop boot')
    if (response.type !== 'boot-injections-release') {
      throw new Error('desktop boot: Host answered with a different control response')
    }
    if (response.error !== undefined) throw new Error(`desktop boot: ${response.error}`)
  }

  /**
   * @param address - Session-scoped file reference.
   * @param signal - preparation cancellation.
   * @returns privately authorized local resource, or null when nonlocal.
   */
  async resolveDragResource(address: string, signal?: AbortSignal): Promise<
    { readonly path: string; readonly sha256: string; readonly size: number } | null
  > {
    const response = await this.control({ type: 'file-drag-resource', address }, 12_000, 'File drag authorization timed out', 'file drag', signal)
    if (response.type !== 'file-drag-resource') throw new Error('Host returned a different control response')
    return response.resource
  }

  private async control(
    request: { readonly type: 'update-tasks'; readonly action: 'inspect' | 'lock' | 'unlock' }
      | { readonly type: 'quit-inspection' } | { readonly type: 'boot-injections' }
      | { readonly type: 'boot-injections-release'; readonly lease: string }
      | { readonly type: 'file-drag-resource'; readonly address: string },
    deadlineMs: number, deadlineMessage: string, operation: string, signal?: AbortSignal,
  ): Promise<DesktopHostControlResponse> {
    const child = this.child
    if (child === undefined || !child.connected || this.failureReported || this.stopping) {
      throw new Error(`${operation}: Host is unavailable`)
    }
    signal?.throwIfAborted()
    const requestId = this.nextControlId++
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = (): void => {
      if (request.type === 'file-drag-resource' && child.connected) child.send({ type: 'file-drag-cancel', requestId }, (_error) => {
        // The request still rejects locally if the Host has disconnected.
      })
      const reason: unknown = signal?.reason
      this.controlRequests.get(requestId)?.reject(reason instanceof Error ? reason : new Error(deadlineMessage))
    }
    try {
      return await new Promise<DesktopHostControlResponse>((resolve, reject) => {
        this.controlRequests.set(requestId, { resolve, reject })
        timer = setTimeout(abort, deadlineMs)
        signal?.addEventListener('abort', abort, { once: true })
        child.send({ ...request, requestId }, (error) => { if (error !== null) reject(error) })
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      this.controlRequests.delete(requestId)
    }
  }

  /**
   * Request teardown and await child exit, escalating termination when needed.
   * @param requireGraceful - Reject update handoff after forced termination or unsuccessful child exit.
   * @returns Completion of owned process teardown. DesktopHostUncleanExitError confirms exit but refuses installation;
   * other failures do not confirm exit.
   */
  async stop(requireGraceful = false): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.clearReadyDeadline()
    this.stopping = true
    this.onPlatformSession?.(null)
    if (child.connected) child.send({ type: 'shutdown' }, (error) => { if (error !== null) this.fail(error) })
    const exited = this.exitPromise ?? Promise.resolve()
    const graceful = await exitsWithin(exited, 10_000)
    if (!graceful) child.kill('SIGTERM')
    if (!await exitsWithin(exited, 5_000)) {
      child.kill('SIGKILL')
      if (!await exitsWithin(exited, 5_000)) {
        throw new Error('dsh desktop host did not exit after SIGKILL')
      }
    }
    this.child = undefined
    if (requireGraceful && (!graceful || child.exitCode !== 0 || !this.shutdownCompleted)) {
      // This diagnostic reaches expandable UI; arbitrary plugin stderr can contain credentials.
      throw new DesktopHostUncleanExitError(`desktop update: Host did not complete graceful task teardown (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, shutdown acknowledged ${String(this.shutdownCompleted)}, graceful deadline exceeded ${String(!graceful)})`)
    }
  }

  /** Stop the startup deadline from firing against an attempt that already settled. */
  private clearReadyDeadline(): void {
    if (this.readyDeadline === undefined) return
    clearTimeout(this.readyDeadline)
    this.readyDeadline = undefined
  }

  private fail(error: Error): void {
    this.clearReadyDeadline()
    this.onPlatformSession?.(null)
    this.readyReject(error)
    for (const request of this.controlRequests.values()) request.reject(error)
    this.controlRequests.clear()
    if (!this.failureReported && !this.stopping) {
      this.failureReported = true
      try { this.onFailure?.(error) } catch (listenerError) {
        console.error('desktop host failure listener failed', listenerError)
      }
    }
  }
}
