/** The Browser Host entry mounts through the Loader and publishes its options. */
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import { BROWSER_CONFIG_GLOBAL } from '../src/config.ts'
import { Config, apply } from '../src/index.ts'

it('mounts without a Web carrier and publishes its options once one is present', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const fiber = ctx.plugin({ Config, apply })
  await expect(fiber.await()).resolves.toBeDefined()
  const rows: IndexInjection[] = []
  ctx.emit('webserver/index-inject', rows)
  expect(rows).toEqual([{ kind: 'global', name: BROWSER_CONFIG_GLOBAL, value: { homeUrl: 'https://www.google.com' } }])
})
