/**
 * Persisted evidence of Desktop launches that never reached Host readiness, and the profile rollback it authorizes.
 * A composition that fails every launch is rolled back once instead of being retried forever: the shell owns the
 * profile write lock before the Host starts, so the rollback happens before the next attempt loads any plugin.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Profile files that decide which plugins the next launch loads. */
const COMPOSITION_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml'] as const

/** Consecutive failed launches tolerated before the next launch rolls the profile back. */
export const DEFAULT_BOOT_FAILURE_LIMIT = 3

/** The `listen EADDRINUSE` diagnostic another DSH instance produces, which no profile change can fix. */
const ADDRESS_IN_USE = /\blisten EADDRINUSE\b/u

/**
 * The distinction the rollback decision needs: a port conflict is another running instance, while any other
 * pre-readiness failure may be a composition that cannot start.
 */
export type BootFailureKind = 'address-in-use' | 'composition'

/** The persisted failure streak; the file is absent while the previous launch reached readiness. */
export interface BootFailureRecord {
  readonly version: 1
  /** {@link profileFingerprint} of the composition that failed. */
  readonly fingerprint: string
  /** Failures of this exact composition, counted consecutively. */
  readonly failures: number
  readonly kind: BootFailureKind
  readonly firstFailureAt: string
  readonly lastFailureAt: string
  /**
   * Whether this composition already received its one automatic rollback. Set records never authorize another,
   * so a profile that still cannot start after recovery reports the failure instead of rewriting itself again.
   */
  readonly rollbackApplied: boolean
}

/** What the launcher should do with the profile before starting the Host. */
export interface BootLaunchDecision {
  /** Whether this launch must roll the profile back instead of loading it. */
  readonly rollback: boolean
  /** Failures recorded for the current composition; zero when none apply. */
  readonly failures: number
  /** Fingerprint of the composition as it is now. */
  readonly fingerprint: string
}

/**
 * Identify the composition files by content, so a launch after any profile write counts as a new attempt rather
 * than a repeated failure. Absent files are part of the identity: removing a patch is also a composition change.
 * @param profileDir Absolute profile directory.
 * @returns Stable hexadecimal digest of the composition files.
 * @throws When a composition file exists but cannot be read.
 */
export function profileFingerprint(profileDir: string): string {
  const hash = createHash('sha256')
  for (const name of COMPOSITION_FILES) {
    hash.update(`${name}\0`)
    let content: Buffer | undefined
    try {
      content = readFileSync(join(profileDir, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    hash.update(content ?? '\u0001absent')
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Classify one pre-readiness failure by the only distinction the rollback decision makes.
 * @param error Failure reported before the Host reached readiness.
 * @returns `address-in-use` for a listener conflict, otherwise `composition`.
 */
export function classifyBootFailure(error: unknown): BootFailureKind {
  const messages = error instanceof AggregateError
    ? [error.message, ...error.errors.map(item => item instanceof Error ? item.message : String(item))]
    : [error instanceof Error ? error.message : String(error)]
  return ADDRESS_IN_USE.test(messages.join('\n')) ? 'address-in-use' : 'composition'
}

/** One composition's failure streak, owned by the Desktop shell's user-data directory. */
export class DesktopBootJournal {
  /** Absolute path of the record file; absent while launches succeed. */
  readonly path: string

  /**
   * @param directory Absolute user-data directory receiving the record.
   * @param profileDir Absolute profile directory the record describes.
   * @param limit Consecutive failures that authorize one rollback; must be a positive integer.
   */
  constructor(
    directory: string,
    readonly profileDir: string,
    readonly limit: number = DEFAULT_BOOT_FAILURE_LIMIT,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('desktop boot journal: limit must be a positive integer')
    this.path = join(directory, 'boot-failures.json')
  }

  /**
   * Decide whether this launch rolls back. A record for another composition, a listener conflict, or a composition
   * that already used its rollback authorizes nothing.
   * @returns The decision and the failures recorded for the current composition.
   */
  evaluate(): BootLaunchDecision {
    // A profile that does not exist yet is initialized by this launch and has attempted no composition.
    if (!existsSync(this.profileDir)) return { rollback: false, failures: 0, fingerprint: '' }
    let fingerprint: string
    try {
      fingerprint = profileFingerprint(this.profileDir)
    } catch (error) {
      // An unreadable profile fails during startup with its own diagnostic; guessing a rollback here would
      // replace that diagnostic with a profile rewrite.
      console.warn('desktop boot journal: the profile composition could not be identified', error)
      return { rollback: false, failures: 0, fingerprint: '' }
    }
    const record = this.read()
    if (record === undefined || record.fingerprint !== fingerprint) return { rollback: false, failures: 0, fingerprint }
    if (record.kind === 'address-in-use' || record.rollbackApplied) {
      return { rollback: false, failures: record.failures, fingerprint }
    }
    return { rollback: record.failures >= this.limit, failures: record.failures, fingerprint }
  }

  /**
   * Count one launch that failed before readiness. The streak restarts when the composition changed since the
   * previous failure, and a consumed rollback latch survives within the same composition.
   * @param error Failure that ended the launch.
   */
  recordFailure(error: unknown): void {
    if (!existsSync(this.profileDir)) return
    try {
      const fingerprint = profileFingerprint(this.profileDir)
      const previous = this.read()
      const same = previous !== undefined && previous.fingerprint === fingerprint
      const now = new Date().toISOString()
      this.write({
        version: 1,
        fingerprint,
        failures: same ? previous.failures + 1 : 1,
        kind: classifyBootFailure(error),
        firstFailureAt: same ? previous.firstFailureAt : now,
        lastFailureAt: now,
        rollbackApplied: same && previous.rollbackApplied,
      })
    } catch (error) {
      // Evidence must never decide a launch by failing it: a lost record only costs the automatic rollback.
      console.warn('desktop boot journal: the failure could not be recorded', error)
    }
  }

  /** Mark this composition as having used its rollback, so recovery itself cannot loop. */
  recordRollback(): void {
    try {
      const fingerprint = profileFingerprint(this.profileDir)
      const previous = this.read()
      const same = previous !== undefined && previous.fingerprint === fingerprint
      const now = new Date().toISOString()
      this.write({
        version: 1,
        fingerprint,
        failures: same ? previous.failures : 0,
        kind: 'composition',
        firstFailureAt: same ? previous.firstFailureAt : now,
        lastFailureAt: now,
        rollbackApplied: true,
      })
    } catch (error) {
      console.warn('desktop boot journal: the rollback could not be recorded', error)
    }
  }

  /** Forget every failure once a launch reaches readiness. */
  markReady(): void {
    try {
      rmSync(this.path, { force: true })
    } catch (error) {
      console.warn('desktop boot journal: the record could not be cleared', error)
    }
  }

  /** The stored record, or undefined when absent or unusable. */
  private read(): BootFailureRecord | undefined {
    let source: string
    try {
      source = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch (error) {
      console.warn('desktop boot journal: the record does not parse and is ignored', error)
      return undefined
    }
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (record.version !== 1 || typeof record.fingerprint !== 'string' || typeof record.firstFailureAt !== 'string'
      || typeof record.lastFailureAt !== 'string' || typeof record.rollbackApplied !== 'boolean'
      || !Number.isSafeInteger(record.failures) || (record.failures as number) < 0
      || (record.kind !== 'address-in-use' && record.kind !== 'composition')) {
      console.warn('desktop boot journal: the record is not a version 1 boot failure and is ignored')
      return undefined
    }
    return record as unknown as BootFailureRecord
  }

  /** Replace the record; the caller observes either the previous or the new complete record. */
  private write(record: BootFailureRecord): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(record, undefined, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
