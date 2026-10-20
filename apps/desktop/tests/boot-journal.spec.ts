import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyBootFailure, DEFAULT_BOOT_FAILURE_LIMIT, DesktopBootJournal, profileFingerprint, type BootFailureRecord,
} from '../src/boot-journal.ts'

const roots: string[] = []

/** The record as the file holds it; parsing it as the record type keeps the assertions type-checked. */
function readRecord(path: string): BootFailureRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as BootFailureRecord
}

function profile(files: Record<string, string> = {}): string {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-boot-journal-profile-'))
  roots.push(profileDir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(profileDir, name), content)
  return profileDir
}

function userData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-boot-journal-user-data-'))
  roots.push(directory)
  return directory
}

function journal(profileDir = profile({ 'cordis.patch.yml': 'patches: []\n' }), limit?: number) {
  return new DesktopBootJournal(userData(), profileDir, limit)
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop boot journal', () => {
  it('authorizes no rollback before any failure is recorded', () => {
    const boot = journal()
    const decision = boot.evaluate()
    expect(decision).toMatchObject({ rollback: false, failures: 0 })
    expect(decision.fingerprint).toHaveLength(16)
  })

  it('rolls back only once the same composition failed the configured number of times', () => {
    const boot = journal(undefined, 2)
    boot.recordFailure(new Error('plugin did not activate'))
    expect(boot.evaluate()).toMatchObject({ rollback: false, failures: 1 })
    boot.recordFailure(new Error('plugin did not activate'))
    expect(boot.evaluate()).toMatchObject({ rollback: true, failures: 2 })
  })

  it('starts a new streak when the composition changed since the last failure', () => {
    const profileDir = profile({ 'cordis.patch.yml': 'patches: []\n' })
    const boot = journal(profileDir, 2)
    boot.recordFailure(new Error('first'))
    boot.recordFailure(new Error('second'))
    expect(boot.evaluate().rollback).toBe(true)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), 'patches:\n  - name: broken\n')
    expect(boot.evaluate()).toMatchObject({ rollback: false, failures: 0 })
  })

  it('treats a listener conflict as no reason to rewrite the profile', () => {
    const boot = journal(undefined, 1)
    boot.recordFailure(new AggregateError([
      new Error('webserver (@deepseek-ai/dsh-host-webserver): Error: listen EADDRINUSE: address already in use 127.0.0.1:3080'),
    ], 'required startup failure'))
    expect(boot.evaluate().rollback).toBe(false)
  })

  it('never authorizes a second rollback for the same composition', () => {
    const boot = journal(undefined, 1)
    boot.recordFailure(new Error('did not start'))
    expect(boot.evaluate().rollback).toBe(true)
    boot.recordRollback()
    expect(boot.evaluate().rollback).toBe(false)
    boot.recordFailure(new Error('still does not start'))
    expect(boot.evaluate()).toMatchObject({ rollback: false, failures: 2 })
  })

  it('clears the record once a launch reaches readiness', () => {
    const boot = journal(undefined, 1)
    boot.recordFailure(new Error('did not start'))
    expect(existsSync(boot.path)).toBe(true)
    boot.markReady()
    expect(existsSync(boot.path)).toBe(false)
    expect(boot.evaluate()).toMatchObject({ rollback: false, failures: 0 })
  })

  it('ignores an unreadable record instead of failing the launch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const boot = journal()
    writeFileSync(boot.path, '{not json')
    expect(boot.evaluate().rollback).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it.each([
    ['{"version":2,"fingerprint":"x"}'],
    ['{"version":1,"fingerprint":7,"failures":1,"kind":"composition","firstFailureAt":"a","lastFailureAt":"b","rollbackApplied":false}'],
    ['{"version":1,"fingerprint":"x","failures":-1,"kind":"composition","firstFailureAt":"a","lastFailureAt":"b","rollbackApplied":false}'],
    ['{"version":1,"fingerprint":"x","failures":1,"kind":"unknown","firstFailureAt":"a","lastFailureAt":"b","rollbackApplied":false}'],
    ['[]'],
  ])('rejects a record that is not a version 1 failure: %s', (content) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const boot = journal()
    writeFileSync(boot.path, content)
    expect(boot.evaluate()).toMatchObject({ rollback: false, failures: 0 })
  })

  it('records the failure count and both timestamps it observed', () => {
    const boot = journal()
    boot.recordFailure(new Error('first'))
    boot.recordFailure(new Error('second'))
    const record = readRecord(boot.path)
    expect(record).toMatchObject({ version: 1, failures: 2, kind: 'composition', rollbackApplied: false })
    expect(record.firstFailureAt <= record.lastFailureAt).toBe(true)
  })

  it('reports no rollback when the composition cannot be identified', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missing = join(tmpdir(), 'dsh-boot-journal-missing-profile-does-not-exist')
    // An existing directory whose composition files are unreadable stands in for a damaged profile.
    const profileDir = profile({ 'cordis.patch.yml': 'patches: []\n' })
    mkdirSync(join(profileDir, 'cordis.yml'), { recursive: true })
    const boot = new DesktopBootJournal(userData(), profileDir)
    expect(boot.evaluate()).toMatchObject({ rollback: false, fingerprint: '' })
    // Recording is best effort too: the launch proceeds with the record it had.
    boot.recordFailure(new Error('unreadable'))
    expect(existsSync(boot.path)).toBe(false)
    expect(missing).not.toBe(profileDir)
  })

  it('counts no failure for a profile this launch initializes', () => {
    const boot = new DesktopBootJournal(userData(), join(tmpdir(), 'dsh-boot-journal-never-created'))
    boot.recordFailure(new Error('cannot initialize'))
    boot.recordFailure(new Error('cannot initialize'))
    expect(existsSync(boot.path)).toBe(false)
    expect(boot.evaluate()).toMatchObject({ rollback: false, failures: 0 })
  })

  it('rejects a limit that is not a positive integer', () => {
    expect(() => new DesktopBootJournal(userData(), profile(), 0)).toThrow('positive integer')
    expect(() => new DesktopBootJournal(userData(), profile(), 1.5)).toThrow('positive integer')
  })

  it('uses the default failure limit', () => {
    const boot = journal()
    for (let attempt = 1; attempt < DEFAULT_BOOT_FAILURE_LIMIT; attempt += 1) {
      boot.recordFailure(new Error('did not start'))
      expect(boot.evaluate().rollback).toBe(false)
    }
    boot.recordFailure(new Error('did not start'))
    expect(boot.evaluate().rollback).toBe(true)
  })
})

describe('boot failure classification', () => {
  it.each([
    [new Error('listen EADDRINUSE: address already in use'), 'address-in-use'],
    [new AggregateError([new Error('listen EADDRINUSE')], 'outer'), 'address-in-use'],
    [new Error('plugin did not activate'), 'composition'],
    ['not an error', 'composition'],
  ] as const)('classifies %s as %s', (error, kind) => {
    expect(classifyBootFailure(error)).toBe(kind)
  })
})

describe('profile fingerprint', () => {
  it('changes with the content of any composition file and with absence', () => {
    const profileDir = profile({ 'package.json': '{}', 'cordis.patch.yml': 'a\n' })
    const initial = profileFingerprint(profileDir)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), 'b\n')
    expect(profileFingerprint(profileDir)).not.toBe(initial)
    rmSync(join(profileDir, 'cordis.patch.yml'))
    expect(profileFingerprint(profileDir)).not.toBe(initial)
  })

  it('ignores files that decide no composition', () => {
    const profileDir = profile({ 'cordis.patch.yml': 'a\n' })
    const initial = profileFingerprint(profileDir)
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    expect(profileFingerprint(profileDir)).toBe(initial)
  })
})
