import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIVENESS_INTERVAL_MS, DEFAULT_STALL_PROBES, resolveDurationMs, resolveLivenessInterval,
  resolveProbeDeadline, resolveStallProbes, resolveStallRecoveries,
} from '../src/duration-env.ts'

describe('desktop duration settings', () => {
  it.each([
    [undefined, 1_000],
    ['1000', 1_000],
    ['60000', 60_000],
  ])('reads %s as %i milliseconds', (value, expected) => {
    expect(resolveDurationMs({ DSH_TEST: value }, 'DSH_TEST', 1_000)).toBe(expected)
  })

  it.each([
    ['999', 'below one second'],
    ['0', 'zero'],
    ['-1', 'negative'],
    ['1.5', 'fractional'],
    ['2147483648', 'past the timer maximum'],
    ['soon', 'not a number'],
  ])('rejects %s (%s)', (value) => {
    expect(() => resolveDurationMs({ DSH_TEST: value }, 'DSH_TEST', 1_000))
      .toThrow('DSH_TEST must be an integer from 1000 through 2147483647')
  })

  it('probes a ready Host every 30 seconds by default', () => {
    // Freezing a window is worse than losing one long task, so detection is on unless it is turned off.
    expect(resolveLivenessInterval({})).toBe(DEFAULT_LIVENESS_INTERVAL_MS)
    expect(DEFAULT_LIVENESS_INTERVAL_MS).toBe(30_000)
    expect(resolveLivenessInterval({ DSH_DESKTOP_HOST_LIVENESS_INTERVAL_MS: '0' })).toBe(0)
    expect(resolveLivenessInterval({ DSH_DESKTOP_HOST_LIVENESS_INTERVAL_MS: '30000' })).toBe(30_000)
  })

  it.each(['-1', '1.5', '3000000000', 'often'])('rejects an invalid liveness interval of %s', (value) => {
    expect(() => resolveLivenessInterval({ DSH_DESKTOP_HOST_LIVENESS_INTERVAL_MS: value }))
      .toThrow('DSH_DESKTOP_HOST_LIVENESS_INTERVAL_MS must be an integer from 0 through 2147483647')
  })

  it('gives one probe ten seconds to answer by default', () => {
    expect(resolveProbeDeadline({})).toBe(10_000)
    expect(resolveProbeDeadline({ DSH_DESKTOP_HOST_PROBE_TIMEOUT_MS: '2000' })).toBe(2_000)
    expect(() => resolveProbeDeadline({ DSH_DESKTOP_HOST_PROBE_TIMEOUT_MS: '500' }))
      .toThrow('DSH_DESKTOP_HOST_PROBE_TIMEOUT_MS must be an integer from 1000 through 2147483647')
  })

  it('restarts a stalled Host after three consecutive missed probes by default', () => {
    expect(resolveStallProbes({})).toBe(DEFAULT_STALL_PROBES)
    expect(DEFAULT_STALL_PROBES).toBe(3)
    // `0` keeps detection only, for deployments whose long tasks must never be sacrificed.
    expect(resolveStallProbes({ DSH_DESKTOP_HOST_STALL_PROBES: '0' })).toBe(0)
    expect(resolveStallProbes({ DSH_DESKTOP_HOST_STALL_PROBES: '5' })).toBe(5)
  })

  it.each(['-1', '1.5', '101', 'many'])('rejects an invalid stall threshold of %s', (value) => {
    expect(() => resolveStallProbes({ DSH_DESKTOP_HOST_STALL_PROBES: value }))
      .toThrow('DSH_DESKTOP_HOST_STALL_PROBES must be an integer from 0 through 100')
  })

  it('restarts a stalled Host once per application process by default', () => {
    expect(resolveStallRecoveries({})).toBe(1)
    expect(resolveStallRecoveries({ DSH_DESKTOP_HOST_STALL_RECOVERIES: '3' })).toBe(3)
  })

  it.each(['0', '-1', '1.5', '11'])('rejects an invalid restart budget of %s', (value) => {
    expect(() => resolveStallRecoveries({ DSH_DESKTOP_HOST_STALL_RECOVERIES: value }))
      .toThrow('DSH_DESKTOP_HOST_STALL_RECOVERIES must be an integer from 1 through 10')
  })
})
