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
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_HOME = join(repoRoot, 'apps', 'desktop', '.desktop-build', 'development', 'home')
const SNAPSHOT_FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
const BACKUP_DIR = 'profile-backups'
const SNAPSHOT_FILE_SET = new Set(SNAPSHOT_FILES)

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
    if (arg === '--profile') out.profile = optionValue(argv, ++i, arg)
    else if (arg === '--home') out.home = resolve(optionValue(argv, ++i, arg))
    else if (arg === '--id') out.id = optionValue(argv, ++i, arg)
    else if (arg === '--label') out.label = optionValue(argv, ++i, arg)
    else if (arg === '--dry-run') out.dryRun = true
    else throw new Error(`unknown option ${arg}`)
  }
  out.home = resolve(out.home)
  validateProfileName(out.profile)
  return out
}

/**
 * Read a required option value.
 * @param {string[]} argv arguments after the script path
 * @param {number} index value position
 * @param {string} option option that needs the value
 * @returns {string}
 */
function optionValue(argv, index, option) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} needs a value`)
  return value
}

/**
 * Reject names that can escape their owning directory.
 * @param {string} name profile or snapshot id
 * @param {string} subject diagnostic subject
 */
function validatePathName(name, subject) {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`invalid ${subject} ${JSON.stringify(name)}`)
  }
}

/** @param {string} name profile name */
function validateProfileName(name) {
  validatePathName(name, 'profile name')
  if (name === 'node_modules') throw new Error(`invalid profile name ${JSON.stringify(name)}`)
}

/**
 * Ensure a path stays in its owning directory.
 * @param {string} parent owning directory
 * @param {string} path candidate path
 */
function assertContained(parent, path) {
  const relativePath = relative(resolve(parent), resolve(path))
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error(`path escapes ${parent}: ${path}`)
}

/**
 * Parse one snapshot's metadata and validate every path-bearing field.
 * @param {string} home DSH_HOME
 * @param {string} id snapshot directory name
 * @returns {{id: string, profile: string, home: string, createdAt: string, label: string | null, files: Record<string, {bytes: number, sha256: string}>}}
 */
function readMetadata(home, id) {
  const root = backupRoot(home)
  validatePathName(id, 'snapshot id')
  assertContained(root, join(root, id))
  const metaPath = join(root, id, 'meta.json')
  if (!existsSync(metaPath)) throw new Error(`snapshot not found: ${join(root, id)}`)
  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (error) {
    throw new Error(`snapshot metadata does not parse: ${metaPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) throw new Error(`snapshot metadata is not an object: ${metaPath}`)
  if (meta.id !== id) throw new Error(`snapshot metadata id ${JSON.stringify(meta.id)} does not match ${JSON.stringify(id)}`)
  if (typeof meta.profile !== 'string') throw new Error(`snapshot metadata has no profile: ${metaPath}`)
  validateProfileName(meta.profile)
  if (meta.files === null || typeof meta.files !== 'object' || Array.isArray(meta.files)) {
    throw new Error(`snapshot metadata has no files map: ${metaPath}`)
  }
  for (const [name, info] of Object.entries(meta.files)) {
    if (!SNAPSHOT_FILE_SET.has(name)) throw new Error(`snapshot metadata names an unsupported file: ${JSON.stringify(name)}`)
    if (info === null || typeof info !== 'object' || Array.isArray(info)) throw new Error(`snapshot metadata for ${name} is not an object`)
    if (!Number.isSafeInteger(info.bytes) || info.bytes < 0) throw new Error(`snapshot metadata for ${name} has invalid bytes`)
    if (typeof info.sha256 !== 'string' || !/^[0-9a-f]{16}$/.test(info.sha256)) {
      throw new Error(`snapshot metadata for ${name} has invalid sha256`)
    }
    const packed = join(root, id, name)
    assertContained(join(root, id), packed)
    if (!existsSync(packed)) throw new Error(`snapshot data is missing: ${packed}`)
    if (hashFile(packed) !== info.sha256) throw new Error(`snapshot data does not match its metadata: ${packed}`)
  }
  return meta
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
  validateProfileName(command.profile)
  const profileDir = join(command.home, 'profiles', command.profile)
  assertContained(join(command.home, 'profiles'), profileDir)
  if (!existsSync(profileDir)) {
    console.error(`profile directory not found: ${profileDir}`)
    process.exitCode = 1
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const id = `${command.profile}-${stamp}`
  const root = backupRoot(command.home)
  const target = join(root, id)
  assertContained(root, target)

  const files = {}
  for (const name of SNAPSHOT_FILES) {
    const source = join(profileDir, name)
    if (!existsSync(source)) continue
    files[name] = { bytes: statSync(source).size, sha256: hashFile(source) }
  }
  if (Object.keys(files).length === 0) {
    console.error(`nothing to snapshot in ${profileDir}`)
    process.exitCode = 1
    return
  }
  mkdirSync(target, { recursive: true })
  for (const name of Object.keys(files)) cpSync(join(profileDir, name), join(target, name))
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
    const meta = readMetadata(command.home, id)
    const files = Object.keys(meta.files).join(', ')
    console.log(`${id}  ${meta.label ? `${meta.label}  ` : ''}${files}`)
  }
}

/**
 * Remove a composition file that the snapshot proves was absent.
 * @param {string} path path to remove
 */
function removeAbsentFile(path) {
  if (!existsSync(path)) return
  if (!lstatSync(path).isSymbolicLink() && !statSync(path).isFile()) {
    throw new Error(`refusing to remove a non-file path not present in the snapshot: ${path}`)
  }
  unlinkSync(path)
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
  const root = backupRoot(command.home)
  validatePathName(command.id, 'snapshot id')
  assertContained(root, join(root, command.id))
  const source = join(root, command.id)
  const metaPath = join(source, 'meta.json')
  if (!existsSync(metaPath)) {
    console.error(`snapshot not found: ${source}`)
    process.exitCode = 1
    return
  }
  const meta = readMetadata(command.home, command.id)
  const profileDir = join(command.home, 'profiles', meta.profile)
  assertContained(join(command.home, 'profiles'), profileDir)
  if (!existsSync(profileDir)) {
    console.error(`profile directory not found: ${profileDir}`)
    process.exitCode = 1
    return
  }

  for (const [name, info] of Object.entries(meta.files)) {
    const destination = join(profileDir, name)
    assertContained(profileDir, destination)
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
  for (const name of SNAPSHOT_FILES) {
    if (Object.hasOwn(meta.files, name)) continue
    const destination = join(profileDir, name)
    assertContained(profileDir, destination)
    if (!existsSync(destination)) continue
    if (command.dryRun) {
      console.log(`would remove  ${name}  (absent from snapshot)`)
      continue
    }
    removeAbsentFile(destination)
    console.log(`removed  ${name}  (absent from snapshot)`)
  }

  if (command.dryRun) {
    console.log('\ndry run: nothing written')
    return
  }
  console.log(`\nrestored ${command.id} into ${profileDir}`)
  console.log('Restart the app before trusting the result: a running process still holds the old composition.')
}

/**
 * Run one profile snapshot command.
 * @param {string[]} argv arguments after the script path
 */
export function main(argv) {
  const command = parseArgs(argv)
  if (command.action === 'snapshot') snapshot(command)
  else if (command.action === 'list') list(command)
  else restore(command)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
