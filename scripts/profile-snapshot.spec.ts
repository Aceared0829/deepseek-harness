import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'profile-snapshot.mjs')
const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  readonly home: string
  readonly profile: string
}

function fixture(profile = 'desktop'): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-snapshot-'))
  fixtureRoots.push(home)
  const profileDir = join(home, 'profiles', profile)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"private":true}\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: base\n')
  return { home, profile: profileDir }
}

function invoke(args: string[]): string {
  return execFileSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function snapshotId(home: string): string {
  const ids = readdirSync(join(home, 'profile-backups'))
  expect(ids).toHaveLength(1)
  return ids[0]!
}

function metadata(home: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'profile-backups', id, 'meta.json'), 'utf8')) as Record<string, unknown>
}

/** Read one file's metadata record, failing the test when the snapshot did not record it. */
function fileRecord(home: string, id: string, name: string): { bytes: number; sha256: string } {
  const files = metadata(home, id).files
  if (typeof files !== 'object' || files === null || !(name in files)) {
    throw new Error(`snapshot ${id} recorded no file ${name}`)
  }
  return (files as Record<string, { bytes: number; sha256: string }>)[name] as { bytes: number; sha256: string }
}

describe('profile snapshot', () => {
  it('creates a snapshot and lists its label and files', () => {
    const f = fixture()
    const created = invoke(['snapshot', '--home', f.home, '--profile', f.profile.split(/[\\/]/u).at(-1)!, '--label', 'before promotion'])
    expect(created).toContain('snapshot desktop-')

    const id = snapshotId(f.home)
    expect(metadata(f.home, id)).toMatchObject({ id, profile: 'desktop', label: 'before promotion' })
    // Each recorded file carries a byte count and a 16-character digest of its contents.
    for (const name of ['package.json', 'cordis.patch.yml']) {
      const record = fileRecord(f.home, id, name)
      expect(record.bytes).toBeGreaterThan(0)
      expect(record.sha256).toMatch(/^[\da-f]{16}$/u)
    }
    expect(invoke(['list', '--home', f.home])).toContain('before promotion  package.json, cordis.patch.yml')
  })

  it('restores files and removes composition files that the snapshot proves were absent', () => {
    const f = fixture()
    const originalPackage = readFileSync(join(f.profile, 'package.json'), 'utf8')
    invoke(['snapshot', '--home', f.home, '--profile', 'desktop'])
    const id = snapshotId(f.home)

    writeFileSync(join(f.profile, 'package.json'), '{"private":false}\n')
    writeFileSync(join(f.profile, 'cordis.patch.yml'), '- id: promoted\n')
    writeFileSync(join(f.profile, 'cordis.yml'), '- id: added-by-promotion\n')

    const dryRun = invoke(['restore', '--home', f.home, '--id', id, '--dry-run'])
    expect(dryRun).toContain('would restore  package.json')
    expect(dryRun).toContain('would remove  cordis.yml')
    expect(readFileSync(join(f.profile, 'package.json'), 'utf8')).toBe('{"private":false}\n')
    expect(existsSync(join(f.profile, 'cordis.yml'))).toBe(true)

    const restored = invoke(['restore', '--home', f.home, '--id', id])
    expect(restored).toContain('restored  package.json')
    expect(restored).toContain('removed  cordis.yml')
    expect(readFileSync(join(f.profile, 'package.json'), 'utf8')).toBe(originalPackage)
    expect(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')).toBe('- id: base\n')
    expect(existsSync(join(f.profile, 'cordis.yml'))).toBe(false)
  })

  it('rejects missing snapshots and path-bearing metadata that escapes its owner', () => {
    const f = fixture()
    expect(() => invoke(['restore', '--home', f.home, '--id', '../outside'])).toThrow(/invalid snapshot id/u)

    invoke(['snapshot', '--home', f.home, '--profile', 'desktop'])
    const id = snapshotId(f.home)
    const metaPath = join(f.home, 'profile-backups', id, 'meta.json')
    const meta = metadata(f.home, id)
    writeFileSync(metaPath, JSON.stringify({ ...meta, profile: '..' }))
    expect(() => invoke(['restore', '--home', f.home, '--id', id])).toThrow(/invalid profile name/u)

    writeFileSync(metaPath, JSON.stringify({ ...meta, files: { ...(meta.files as object), '../outside': { bytes: 0, sha256: '0000000000000000' } } }))
    expect(() => invoke(['list', '--home', f.home])).toThrow(/unsupported file/u)
  })

  it('rejects snapshot data changed after its metadata was written', () => {
    const f = fixture()
    invoke(['snapshot', '--home', f.home, '--profile', 'desktop'])
    const id = snapshotId(f.home)
    writeFileSync(join(f.home, 'profile-backups', id, 'package.json'), 'tampered\n')
    expect(() => invoke(['restore', '--home', f.home, '--id', id])).toThrow(/does not match its metadata/u)
  })
})
