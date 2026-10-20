/** Millisecond settings read from the Desktop process environment. */

/** How often the shell probes a ready Host for a wedged event loop. */
export const DEFAULT_LIVENESS_INTERVAL_MS = 30_000

/** Consecutive missed probes that replace a Host. Three probes at the default cadence is 90 seconds of silence. */
export const DEFAULT_STALL_PROBES = 3

/**
 * Read a duration that `setTimeout` accepts without clamping.
 * @param env - Desktop process environment.
 * @param name - Variable to read; the validation error names it.
 * @param fallback - Value used when the variable is unset.
 * @returns Integer milliseconds from 1000 through 2147483647.
 */
export function resolveDurationMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 2_147_483_647) {
    throw new Error(`${name} must be an integer from 1000 through 2147483647`)
  }
  return value
}

/**
 * Read the interval between Host liveness probes. Probing is on by default so a Host whose event loop is wedged is
 * replaced instead of leaving a frozen window; `0` turns it off.
 * @param env - Desktop process environment.
 * @returns Integer milliseconds from 0 through 2147483647.
 */
export function resolveLivenessInterval(env: NodeJS.ProcessEnv): number {
  const value = Number(env.DSH_DESKTOP_HOST_LIVENESS_INTERVAL_MS ?? DEFAULT_LIVENESS_INTERVAL_MS)
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error('DSH_DESKTOP_HOST_LIVENESS_INTERVAL_MS must be an integer from 0 through 2147483647')
  }
  return value
}

/**
 * Read how long one Host liveness probe waits before it counts as missed.
 * @param env - Desktop process environment.
 * @returns Integer milliseconds from 1000 through 2147483647.
 */
export function resolveProbeDeadline(env: NodeJS.ProcessEnv): number {
  return resolveDurationMs(env, 'DSH_DESKTOP_HOST_PROBE_TIMEOUT_MS', 10_000)
}

/**
 * Read how many consecutive missed probes replace a stalled Host. The default replaces it: a frozen window is worse
 * than losing one long task. `0` keeps detection only, for deployments whose tasks must never be sacrificed.
 * @param env - Desktop process environment.
 * @returns Integer probe count from 0 through 100; `0` disables restarts.
 */
export function resolveStallProbes(env: NodeJS.ProcessEnv): number {
  const value = Number(env.DSH_DESKTOP_HOST_STALL_PROBES ?? DEFAULT_STALL_PROBES)
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error('DSH_DESKTOP_HOST_STALL_PROBES must be an integer from 0 through 100')
  }
  return value
}

/**
 * Read how many times one application process may restart a stalled Host before it reports the failure instead.
 * @param env - Desktop process environment.
 * @returns Integer restart count from 1 through 10.
 */
export function resolveStallRecoveries(env: NodeJS.ProcessEnv): number {
  const value = Number(env.DSH_DESKTOP_HOST_STALL_RECOVERIES ?? 1)
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new Error('DSH_DESKTOP_HOST_STALL_RECOVERIES must be an integer from 1 through 10')
  }
  return value
}
