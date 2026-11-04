import { afterEach, describe, expect, it, vi } from 'vitest'
import { startEventLoopDelaySampler, type EventLoopDelaySampler } from '../src/event-loop-delay.ts'

const samplers: EventLoopDelaySampler[] = []

function start(resolutionMs?: number): EventLoopDelaySampler {
  const sampler = startEventLoopDelaySampler(resolutionMs)
  if (sampler === undefined) throw new Error('the sampler is unavailable in this runtime')
  samplers.push(sampler)
  return sampler
}

/** Block the event loop for a while, so the histogram records at least one delayed sample. */
function blockFor(milliseconds: number): void {
  const until = Date.now() + milliseconds
  while (Date.now() < until) { /* spin: this is the defect the sampler exists to measure */ }
}

afterEach(() => {
  for (const sampler of samplers.splice(0)) sampler.stop()
  vi.restoreAllMocks()
})

describe('desktop host event-loop delay sampler', () => {
  it('reports nothing before the first sample arrives', () => {
    const sampler = start()
    const snapshot = sampler.snapshot()
    expect(snapshot.samples).toBe(0)
    expect(snapshot.maxMs).toBe(0)
    expect(snapshot.p99Ms).toBe(0)
  })

  it('measures a blocked event loop as a large maximum', async () => {
    const sampler = start()
    // The histogram's own timer needs a turn to publish samples, hence the await either side.
    await new Promise(resolve => setTimeout(resolve, 10))
    blockFor(60)
    await new Promise(resolve => setTimeout(resolve, 40))
    const snapshot = sampler.snapshot()
    expect(snapshot.samples).toBeGreaterThan(0)
    // A 60 ms spin cannot produce a maximum below the resolution that watched it.
    expect(snapshot.maxMs).toBeGreaterThanOrEqual(50)
    expect(snapshot.p99Ms).toBeLessThanOrEqual(snapshot.maxMs)
    expect(snapshot.p50Ms).toBeLessThanOrEqual(snapshot.p99Ms)
    expect(snapshot.observedMs).toBeGreaterThan(0)
  })

  it('drops recorded samples on reset so the next measurement describes its own window', async () => {
    const sampler = start()
    await new Promise(resolve => setTimeout(resolve, 10))
    blockFor(50)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(sampler.snapshot().samples).toBeGreaterThan(0)
    sampler.reset()
    expect(sampler.snapshot()).toMatchObject({ samples: 0, maxMs: 0 })
  })

  it('reports nothing once stopped, without throwing', async () => {
    const sampler = start()
    await new Promise(resolve => setTimeout(resolve, 10))
    blockFor(20)
    await new Promise(resolve => setTimeout(resolve, 30))
    sampler.stop()
    expect(sampler.snapshot()).toMatchObject({ observedMs: 0, samples: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 })
    // Repeated release is idempotent; a second stop must not throw.
    expect(() => { sampler.stop() }).not.toThrow()
    expect(() => { sampler.reset() }).not.toThrow()
  })

  it('rounds sub-millisecond percentiles to whole milliseconds', async () => {
    const sampler = start()
    await new Promise(resolve => setTimeout(resolve, 10))
    for (let index = 0; index < 5; index += 1) await new Promise(resolve => setTimeout(resolve, 2))
    const snapshot = sampler.snapshot()
    for (const value of [snapshot.p50Ms, snapshot.p99Ms, snapshot.maxMs]) {
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })

  it('reports a measurement of nothing rather than failing when the platform refuses a histogram', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A refused histogram must cost the Host nothing: the caller gets no sampler, not an exception.
    const refused = (): never => { throw new Error('unsupported platform') }
    expect(startEventLoopDelaySampler(1, refused)).toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('event-loop delay sampling is unavailable'),
      expect.any(Error))
  })

  it('reports nothing rather than failing when the histogram refuses to enable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusing = ((): never => {
      throw new Error('enable refused')
    }) as never
    // `enable()` runs inside the same guard as construction, so a histogram that refuses to start is also inert.
    const histogram = {
      enable: refusing,
      disable: () => {},
      reset: () => {},
      count: 0,
      min: 0,
      max: 0,
      percentile: () => 0,
    }
    expect(startEventLoopDelaySampler(1, (() => histogram) as never)).toBeUndefined()
  })})
