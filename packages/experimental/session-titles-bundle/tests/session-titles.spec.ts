/**
 * The bundle's substance is its patch file: the first-prompt provider is
 * disabled and the all-prompts provider is inserted with a reasoning-safe
 * output budget.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface PatchRow {
  readonly id?: string
  readonly config?: Record<string, unknown>
  readonly disabled?: boolean
}

describe('dsh-experimental-session-titles bundle', () => {
  it('inserts the all-prompts provider with a budget reasoning tokens cannot exhaust', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { dsh?: { bundle?: { patch?: string } } }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const rows = (parsed as (PatchRow & { insert?: PatchRow[] })[])
      .flatMap(patch => [patch, ...(patch.insert ?? [])])
    expect(rows.find(row => row.id === 'session-title-llm')?.disabled).toBe(true)
    const config = rows.find(row => row.id === 'optional-session-title-all-prompts')?.config
    // Reasoning tokens count against the same output budget, so a small cap
    // can be spent entirely before the model writes any title text.
    expect(config?.['maxOutputTokens']).toBeGreaterThanOrEqual(1024)
  })
})
