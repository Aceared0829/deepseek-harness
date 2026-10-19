#!/usr/bin/env node
/**
 * Snapshot and restore a profile's composition files before promoting a change.
 *
 * A snapshot copies the files that decide what the profile loads. Restoring one
 * is the manual rollback for a plugin that installs cleanly but breaks the app.
 *
 * Usage:
 *   node scripts/profile-snapshot.mjs snapshot [--profile desktop] [--home <path>] [--label <text>]
 *   node scripts/profile-snapshot.mjs list [--home <path>]
 *   node scripts/profile-snapshot.mjs restore --id <id> [--home <path>] [--dry-run]
 *
 * Defaults bind to the Desktop development home. The `desktop` profile is
 * Electron-owned, so its files are copied without ever being asked of the CLI.
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_HOME = join(repoRoot, 'apps', 'desktop', '.desktop-build', 'development', 'home')
const SNAPSHOT_FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
const BACKUP_DIR = 'profile-backups'

/** @typedef {{ action: 'snapshot' | 'list' | 'restore', profile: string, home: string, id?: string, label?: string, dryRun: boolean }} Command */

/**
 * Parse argv.
 * @param {string[]} argv arguments after the script path
 * @returns {Command}
 */
function parseArgs(argv) {
  /** @type {Command} */
  const out = { action: 'snapshot', profile: 'desktop', home: DEFAULT_HOME, dryRun: false }
  const action = argv[0]
  if (action === 'snapshot' || action === 'list' || action === 'restore') out.action = action
  else throw new Error('first argument must be snapshot, list, or restore')
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') out.profile = argv[++i]
    else if (arg === '--home') out.home = resolve(argv[++i])
    else if (arg === '--id') out.id = argv[++i]
    else if (arg === '--label') out.label = argv[++i]
    else if (arg === '--dry-run') out.dryRun = true
    else throw new Error(`unknown option ${arg}`)
  }
  out.home = resolve(out.home)
  return out
}

/**
 * Hash a file's bytes.
 * @param {string} path file path
 * @returns {string}
 */
function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
}

/** @param {string} home DSH_HOME */
function backupRoot(home) {
  return join(home, BACKUP_DIR)
}

/**
 * List snapshot ids, newest first.
 * @param {string} home DSH_HOME
 * @returns {string[]}
 */
function listSnapshots(home) {
  const root = backupRoot(home)
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((entry) => existsSync(join(root, entry, 'meta.json')))
    .sort()
    .reverse()
}

/**
 * Create a snapshot of the profile composition files.
 * @param {Command} command parsed command
 */
function snapshot(command) {
  const profileDir = join(command.home, 'profiles', command.profile)
  if (!existsSync(profileDir)) {
    console.error(`profile directory not found: ${profileDir}`)
    process.exitCode = 1
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const id = `${command.profile}-${stamp}`
  const target = join(backupRoot(command.home), id)
  mkdirSync(target, { recursive: true })

  const files = {}
  for (const name of SNAPSHOT_FILES) {
    const source = join(profileDir, name)
    if (!existsSync(source)) continue
    cpSync(source, join(target, name))
    files[name] = { bytes: statSync(source).size, sha256: hashFile(source) }
  }
  if (Object.keys(files).length === 0) {
    console.error(`nothing to snapshot in ${profileDir}`)
    process.exitCode = 1
    return
  }
  writeFileSync(join(target, 'meta.json'), JSON.stringify({
    id,
    profile: command.profile,
    home: command.home,
    createdAt: new Date().toISOString(),
    label: command.label ?? null,
    files,
  }, null, 2), 'utf8')

  console.log(`snapshot ${id}`)
  for (const [name, info] of Object.entries(files)) console.log(`  ${name}  ${info.bytes} bytes  ${info.sha256}`)
  console.log(`\nrestore with: node scripts/profile-snapshot.mjs restore --id ${id}`)
}

/**
 * Print snapshots for the bound home.
 * @param {Command} command parsed command
 */
function list(command) {
  const ids = listSnapshots(command.home)
  if (ids.length === 0) {
    console.log(`no snapshots under ${backupRoot(command.home)}`)
    return
  }
  for (const id of ids) {
    const meta = JSON.parse(readFileSync(join(backupRoot(command.home), id, 'meta.json'), 'utf8'))
    const files = Object.keys(meta.files).join(', ')
    console.log(`${id}  ${meta.label ? `${meta.label}  ` : ''}${files}`)
  }
}

/**
 * Restore the composition files recorded in a snapshot.
 * @param {Command} command parsed command
 */
function restore(command) {
  if (!command.id) {
    console.error('restore needs --id')
    process.exitCode = 1
    return
  }
  const source = join(backupRoot(command.home), command.id)
  const metaPath = join(source, 'meta.json')
  if (!existsSync(metaPath)) {
    console.error(`snapshot not found: ${source}`)
    process.exitCode = 1
    return
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const profileDir = join(command.home, 'profiles', meta.profile)
  if (!existsSync(profileDir)) {
    console.error(`profile directory not found: ${profileDir}`)
    process.exitCode = 1
    return
  }

  for (const [name, info] of Object.entries(meta.files)) {
    const destination = join(profileDir, name)
    const current = existsSync(destination) ? hashFile(destination) : 'missing'
    const mark = current === info.sha256 ? 'unchanged' : 'differs'
    const line = `${name}  ${current} -> ${info.sha256}  (${mark})`
    if (command.dryRun) {
      console.log(`would restore  ${line}`)
      continue
    }
    cpSync(join(source, name), destination)
    console.log(`restored  ${line}`)
  }

  if (command.dryRun) {
    console.log('\ndry run: nothing written')
    return
  }
  console.log(`\nrestored ${command.id} into ${profileDir}`)
  console.log('Restart the app before trusting the result: a running process still holds the old composition.')
}

const command = parseArgs(process.argv.slice(2))
if (command.action === 'snapshot') snapshot(command)
else if (command.action === 'list') list(command)
else restore(command)
