/**
 * Event-loop delay sampling for the Desktop Host, so a stall reported by the shell's liveness probe carries how
 * long the loop was actually blocked instead of only that it stopped answering.
 *
 * Node delivers the histogram's samples from a timer this process owns, which is exactly what a blocked loop
 * stalls: while a synchronous task runs, no sample is recorded. `max` therefore reports the longest single
 * unbroken stretch of loop occupancy, which is the number that separates a long task from a slow request.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

/** One delay histogram in integer nanoseconds; exported so the control reply and its tests share one shape. */
export interface EventLoopDelaySnapshot {
  /** Observation window in milliseconds; 0 when the sampler never started. */
  readonly observedMs: number
  /** Sample count behind the percentiles; 0 when nothing was recorded. */
  readonly samples: number
  readonly p50Ms: number
  readonly p99Ms: number
  readonly maxMs: number
}

/** The sampler a Host runs for its whole lifetime. */
export interface EventLoopDelaySampler {
  /** Current delay distribution over everything observed since the last reset. */
  snapshot(): EventLoopDelaySnapshot
  /** Drop recorded samples without releasing the histogram, so the next stall measures its own window. */
  reset(): void
  /** Release the histogram; safe to call once. */
  stop(): void
}

/** Nothing was ever sampled, which is what a Host reports when it cannot start the histogram. */
const EMPTY_SNAPSHOT: EventLoopDelaySnapshot = { observedMs: 0, samples: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 }

/** Convert nanoseconds to whole milliseconds; the histogram reports integer nanoseconds. */
function ms(nanoseconds: number): number {
  return Number.isFinite(nanoseconds) ? Math.round(nanoseconds / 1_000_000) : 0
}

/**
 * Start sampling event-loop delay at one-millisecond resolution.
 * @param resolutionMs - Histogram resolution; one millisecond is fine enough to see a blocked loop and cheap enough
 *   to leave running for the process lifetime.
 * @param monitor - Histogram factory, injectable so the refusal path is reachable without a platform that refuses.
 * @returns The sampler, or undefined when the platform refuses one; callers then report no measurement rather than
 *   failing the Host.
 */
export function startEventLoopDelaySampler(
  resolutionMs = 1,
  monitor: typeof monitorEventLoopDelay = monitorEventLoopDelay,
): EventLoopDelaySampler | undefined {
  let histogram: IntervalHistogram
  try {
    histogram = monitor({ resolution: resolutionMs })
    histogram.enable()
  } catch (error) {
    // A missing or refused perf hook must not cost the Host: an unmeasured stall is reported as unmeasured.
    console.warn('desktop host: event-loop delay sampling is unavailable', error)
    return undefined
  }
  let stopped = false
  let startedAt = Date.now()
  return {
    snapshot(): EventLoopDelaySnapshot {
      if (stopped) return EMPTY_SNAPSHOT
      // The histogram's own count is authoritative: a fresh one reports zero before its first sample.
      if (histogram.count === 0) return { ...EMPTY_SNAPSHOT, observedMs: Date.now() - startedAt }
      return {
        observedMs: Date.now() - startedAt,
        samples: histogram.count,
        p50Ms: ms(histogram.percentile(50)),
        p99Ms: ms(histogram.percentile(99)),
        maxMs: ms(histogram.max),
      }
    },
    reset(): void {
      if (stopped) return
      histogram.reset()
      startedAt = Date.now()
    },
    stop(): void {
      if (stopped) return
      stopped = true
      histogram.disable()
    },
  }
}
