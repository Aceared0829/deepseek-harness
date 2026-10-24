/** Host configuration supplies the Browser default address to browser pages. */
import { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import { BROWSER_CONFIG_GLOBAL, Config } from '../src/config.ts'
import * as host from '../src/index.ts'

const peer: PeerScope = {
  id: 'test-peer' as PeerScope['id'],
  ctx: new Context(),
  principal: { kind: 'owner' },
  signal: new AbortController().signal,
  interactions: 'none',
  dispose: async () => {},
}

it('exposes the Browser options on the Host entry', () => {
  expect(host.Config).toBe(Config)
  expect(Config({})).toEqual({ homeUrl: 'https://www.google.com' })
  expect(Config({ homeUrl: 'https://example.test/start' })).toEqual({ homeUrl: 'https://example.test/start' })
  expect(Config({ homeUrl: '' })).toEqual({ homeUrl: '' })
  expect(() => Config({ homeUrl: 'file:///work/index.html' })).toThrow()
  expect(() => Config({ homeUrl: 'example.test' })).toThrow()
})

it('embeds Browser options in browser pages and withdraws them on disposal', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const config = Config({ homeUrl: 'https://example.test/start' })
  const fiber = ctx.plugin(host, config)
  await fiber.await()
  const rows: IndexInjection[] = []
  ctx.emit('webserver/index-inject', rows, peer)
  expect(rows).toEqual([{ kind: 'global', name: BROWSER_CONFIG_GLOBAL, value: config }])
  await fiber.dispose()
  const after: IndexInjection[] = []
  ctx.emit('webserver/index-inject', after, peer)
  expect(after).toEqual([])
})
