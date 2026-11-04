import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cordisConfigFiles } from './cordis-config-files.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cordisConfigFiles', () => {
  it('finds Loader YAML without treating translation records as configs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-config-files-'))
    roots.push(root)
    for (const directory of ['.claude', 'apps/cli/config/examples', 'docs', 'node_modules/pkg', 'vendor/pkg']) {
      mkdirSync(join(root, directory), { recursive: true })
    }
    for (const file of [
      '.claude/hidden.cordis.yml',
      'docs/cordis-primer.i18n.yaml',
      'apps/cli/config/examples/agent.cordis.yaml',
      'apps/cli/config/examples/headless.cordis.yml',
      'node_modules/pkg/hidden.cordis.yml',
      'vendor/pkg/hidden.cordis.yml',
    ]) {
      writeFileSync(join(root, file), '[]\n')
    }

    expect(cordisConfigFiles(root)).toEqual([
      join('apps', 'cli', 'config', 'examples', 'agent.cordis.yaml'),
      join('apps', 'cli', 'config', 'examples', 'headless.cordis.yml'),
    ])
  })

  it('skips a symlink entry this checkout could not materialize', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-config-files-'))
    roots.push(root)
    for (const directory of ['apps/cli/tests/profiles/acp', 'snapshots/acp']) {
      mkdirSync(join(root, directory), { recursive: true })
    }
    writeFileSync(join(root, 'snapshots/acp/cordis.yml'), '- id: real\n  name: real\n')
    // What git writes where a mode-120000 entry could not become a link: the target path as text.
    // Five levels back reaches the root from apps/cli/tests/profiles/acp, as the real entry does.
    writeFileSync(join(root, 'apps/cli/tests/profiles/acp/cordis.yml'), '../../../../../snapshots/acp/cordis.yml')
    writeFileSync(join(root, 'apps/cli/tests/profiles/acp/authored.cordis.yml'), '- id: authored\n')

    // The placeholder carries no YAML, so validating it would report a malformed composition.
    // The snapshot it points at stays in scope: it is real YAML and the Loader reads it.
    expect(cordisConfigFiles(root)).toEqual([
      join('apps', 'cli', 'tests', 'profiles', 'acp', 'authored.cordis.yml'),
      join('snapshots', 'acp', 'cordis.yml'),
    ])
  })

  it('keeps a one-line config whose content is not a resolvable relative path', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-config-files-'))
    roots.push(root)
    mkdirSync(join(root, 'apps'), { recursive: true })
    writeFileSync(join(root, 'apps/one-line.cordis.yml'), '../../../../nowhere.yml')

    // No file exists at that target, so the write is authored YAML and must still be validated.
    expect(cordisConfigFiles(root)).toEqual([join('apps', 'one-line.cordis.yml')])
  })
})
