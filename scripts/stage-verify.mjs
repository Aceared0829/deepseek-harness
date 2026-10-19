#!/usr/bin/env node
/**
 * Gate a Harness plugin bundle before it touches the live profile.
 *
 * Stages, in order:
 *   S0 static  - manifest, encoding, Host entry import, Client factory
 *   S1 stage   - create a disposable profile from the `web` template
 *   S2 install - install the bundle into that profile
 *   S3 boot    - start it on its own port and wait for HTTP 200
 *   S4 inspect - no FAILED fiber, process still alive
 *
 * Every stage runs against a throwaway DSH_HOME under the OS temp directory, so
 * the live profile is never written. A passing run proves the bundle loads and
 * serves in a fresh profile; it does not replace looking at it once promoted.
 *
 * Usage:
 *   node scripts/stage-verify.mjs <plugin-dir> [options]
 *
 *   --static-only    run S0 and exit
 *   --dsh <path>     CLI entry to stage with (default: Desktop dev runtime)
 *   --home <path>    live DSH_HOME; used only to validate the binding
 *   --port <n>       port for the staged instance (default: OS-assigned)
 *   --timeout <s>    boot timeout (default 90)
 *   --keep           keep the staging directory and log on success too
 *   --open           open the staged instance in a browser
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const devRoot = join(repoRoot, 'apps', 'desktop', '.desktop-build', 'development')
const DEFAULT_DSH = join(devRoot, 'project', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const DEFAULT_HOME = join(devRoot, 'home')
const STAGE_PROFILE = 'verify'

const state = { failures: [], warnings: [], reported: false }
const pass = (msg) => console.log(`  PASS  ${msg}`)
const fail = (msg) => { state.failures.push(msg); console.log(`  FAIL  ${msg}`) }
const warn = (msg) => { state.warnings.push(msg); console.log(`  WARN  ${msg}`) }
const stage = (title) => console.log(`\n== ${title}`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** @typedef {{ dir?: string, staticOnly: boolean, keep: boolean, open: boolean, dsh?: string, home?: string, port?: number, timeout: number }} Options */

/**
 * Parse argv.
 * @param {string[]} argv arguments after the script path
 * @returns {Options}
 */
function parseArgs(argv) {
  /** @type {Options} */
  const out = { staticOnly: false, keep: false, open: false, timeout: 90 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--static-only') out.staticOnly = true
    else if (arg === '--keep') out.keep = true
    else if (arg === '--open') out.open = true
    else if (arg === '--dsh') out.dsh = optionValue(argv, ++i, arg)
    else if (arg === '--home') out.home = optionValue(argv, ++i, arg)
    else if (arg === '--port') out.port = Number(optionValue(argv, ++i, arg))
    else if (arg === '--timeout') out.timeout = Number(optionValue(argv, ++i, arg))
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else if (out.dir === undefined) out.dir = resolve(arg)
    else throw new Error(`unexpected argument ${arg}`)
  }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)) {
    throw new Error('--port needs an integer from 1 to 65535')
  }
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) throw new Error('--timeout needs a positive number of seconds')
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
 * Run a command synchronously and capture its output.
 * @param {string} command executable
 * @param {string[]} args arguments
 * A Windows `.cmd` shim cannot be spawned directly, so the pnpm probe goes
 * through `cmd.exe`.
 * @param {{cwd?: string, env?: Record<string, string | undefined>, timeout?: number}} [opts]
 * @returns {{status: number | null, stdout: string, stderr: string}}
 */
function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    timeout: opts.timeout ?? 120_000,
    windowsHide: true,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Flags a file that would fail to load in the Host.
 * @param {string} path file to inspect
 * @returns {string | undefined} problem description
 */
function encodingProblem(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch { return undefined }
  if (text.charCodeAt(0) === 0xfeff) return `${path} starts with a UTF-8 BOM`
  const broken = text.match(/\uFFFD/g)
  if (broken) return `${path} holds ${broken.length} U+FFFD replacement characters`
  return undefined
}

/** S0: everything provable without starting a Harness. */
function staticChecks(dir) {
  stage(`S0 static gate: ${dir}`)
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) { fail('package.json missing'); return undefined }
  const problem = encodingProblem(pkgPath)
  if (problem) fail(problem)
  if (problem) return undefined

  let pkg
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '')) } catch (error) {
    fail(`package.json does not parse: ${error.message}`)
    return undefined
  }
  if (pkg.name) pass(`name ${pkg.name}`)
  else fail('package.json has no name')

  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target !== 'string' || target.includes('*')) continue
    if (!existsSync(join(dir, target))) fail(`exports["${key}"] -> ${target} does not exist`)
  }
  if (typeof pkg.main === 'string' && !existsSync(join(dir, pkg.main))) {
    fail(`main -> ${pkg.main} does not exist`)
  }

  const patch = pkg.dsh?.bundle?.patch
  const patches = patch === undefined ? [] : Array.isArray(patch) ? patch : [patch]
  if (patches.length === 0) warn('dsh.bundle.patch is missing; full staging requires an installable bundle')
  for (const file of patches) {
    if (typeof file !== 'string' || !existsSync(join(dir, file))) fail(`dsh.bundle.patch -> ${file} does not exist`)
    else pass(`bundle patch ${file}`)
  }

  const hostEntry = typeof pkg.main === 'string' ? join(dir, pkg.main) : join(dir, 'index.js')
  if (existsSync(hostEntry)) {
    const entryProblem = encodingProblem(hostEntry)
    if (entryProblem) fail(entryProblem)
    const result = run(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(pathToFileURL(hostEntry).href)})`], { cwd: dir, timeout: 30_000 })
    if (result.status === 0) pass(`Host entry loads (${relative(dir, hostEntry)})`)
    else fail(`Host entry failed to load: ${errorSummary(result.stderr || result.stdout)}`)
  } else {
    warn('no Host entry found; the bundle only contributes configuration')
  }

  const clientTarget = typeof pkg.exports?.['./client'] === 'string' ? pkg.exports['./client'] : undefined
  if (clientTarget) {
    if (pkg.dsh?.client?.platform !== 'web') fail('exports["./client"] present but dsh.client.platform is not web')
    const clientPath = join(dir, clientTarget)
    if (!existsSync(clientPath)) fail(`client bundle ${clientTarget} does not exist`)
    else {
      const clientProblem = encodingProblem(clientPath)
      if (clientProblem) fail(clientProblem)
      const probeDir = mkdtempSync(join(tmpdir(), 'dsh-client-probe-'))
      const probe = join(probeDir, 'probe.mjs')
      let result
      try {
        writeFileSync(probe, CLIENT_PROBE, 'utf8')
        result = run(process.execPath, [probe, pathToFileURL(clientPath).href], { cwd: dir, timeout: 30_000 })
      } finally {
        rmSync(probeDir, { recursive: true, force: true })
      }
      for (const line of result.stdout.split('\n').filter(Boolean)) {
        if (line.startsWith('FAIL ')) fail(line.slice(5))
        else if (line.startsWith('WARN ')) warn(line.slice(5))
        else if (line.startsWith('PASS ')) pass(line.slice(5))
      }
      if (result.status !== 0 && !result.stdout.includes('FAIL ')) {
        fail(`client bundle probe crashed: ${tail(result.stderr, 3)}`)
      }
    }
  }
  return pkg
}

const CLIENT_PROBE = String.raw`
const href = process.argv[2]
let loaded
const React = {
  createElement: () => null,
  Fragment: 'Fragment',
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useMemo: (build) => build(),
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
}
const passthrough = new Proxy(function () {}, { get: () => () => null, apply: () => null })
globalThis.window = { __ModuleLoader__: { load: (mod) => { loaded = mod } } }
globalThis.document = { createElement: () => ({}), body: {} }
try {
  await import(href)
} catch (error) {
  console.log('FAIL client bundle import failed: ' + error.message)
  process.exit(0)
}
if (!loaded) {
  console.log('FAIL client bundle never called __ModuleLoader__.load')
  process.exit(0)
}
if (typeof loaded.id === 'string' && loaded.id) console.log('PASS client module id ' + loaded.id)
else console.log('FAIL client module id missing')
if (typeof loaded.factory !== 'function') {
  console.log('FAIL client module factory missing')
  process.exit(0)
}
try {
  const module = loaded.factory((name) => (name === 'react' ? React : passthrough))
  if (module && typeof module.apply === 'function') console.log('PASS client factory returned apply()')
  else console.log('WARN client factory returned no apply()')
} catch (error) {
  console.log('WARN client factory threw outside the Host: ' + error.message)
}
`

/**
 * Read the authenticated URL the Web app prints once it is listening.
 * @param {string} text captured output
 * @returns {string | undefined}
 */
function extractUrl(text) {
  const match = text.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)
  return match ? match[0] : undefined
}

/**
 * First error line of a failing command, so the report names the cause instead
 * of the last stack frames.
 * @param {string} text captured output
 * @returns {string}
 */
function errorSummary(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const named = lines.find((line) => /^(?:[A-Za-z]*Error|Error:)/.test(line))
  return named ?? tail(text, 3)
}

/**
 * Last n non-empty lines of a command output.
 * @param {string} text output
 * @param {number} n line count
 * @returns {string}
 */
function tail(text, n) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-n).join(' | ')
}

/**
 * Kill a process and its descendants.
 * @param {number} pid process id
 */
function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}

/**
 * Stop a staged Host and wait for its process to exit.
 * @param {import('node:child_process').ChildProcess | undefined} child spawned Host
 */
async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((done) => child.once('exit', done))
  killTree(child.pid)
  await exited
}

/**
 * Print the verdict once and clean up the staging directory unless it is kept.
 * @param {Options} options parsed options
 * @param {{stageHome: string, logPath: string, dsh: string}} context staging artifacts
 */
function report(options, context) {
  if (state.reported) return
  state.reported = true
  stage('result')
  if (state.failures.length === 0) {
    console.log('\n  VERDICT  PASS')
    if (options.staticOnly) {
      console.log('  Static checks passed. Boot was not exercised; run without --static-only for that.')
    } else {
      console.log('  The bundle loads and serves in a fresh profile.')
      console.log('  Next: snapshot the live profile, then promote with plugin_manager.')
    }
  } else {
    console.log(`\n  VERDICT  FAIL (${state.failures.length} problem${state.failures.length === 1 ? '' : 's'})`)
    for (const item of state.failures) console.log(`    - ${item}`)
    console.log('  The live profile was never touched.')
  }
  if (state.warnings.length > 0) {
    console.log('\n  warnings:')
    for (const item of state.warnings) console.log(`    - ${item}`)
  }
  if (context?.stageHome) {
    if (options.keep || state.failures.length > 0) {
      console.log(`\n  staging kept: ${context.stageHome}`)
      console.log(`  log:          ${context.logPath}`)
      console.log(`  inspect it:   ${inspectCommand(context)}`)
    } else {
      try { rmSync(context.stageHome, { recursive: true, force: true }) } catch { console.log(`\n  staging dir busy: ${context.stageHome}`) }
    }
  }
  process.exitCode = state.failures.length === 0 ? 0 : 1
}

/**
 * Render a copyable command that binds inspection to the kept staging home.
 * @param {{stageHome: string, dsh: string}} context staging artifacts
 * @returns {string}
 */
function inspectCommand(context) {
  if (process.platform === 'win32') {
    return `$env:DSH_HOME=${JSON.stringify(context.stageHome)}; node ${JSON.stringify(context.dsh)} --profile ${STAGE_PROFILE} --port 53699`
  }
  return `DSH_HOME=${JSON.stringify(context.stageHome)} node ${JSON.stringify(context.dsh)} --profile ${STAGE_PROFILE} --port 53699`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.dir) {
    console.error('usage: node scripts/stage-verify.mjs <plugin-dir> [--static-only] [--keep] [--open]')
    process.exit(2)
  }
  if (!existsSync(options.dir) || !statSync(options.dir).isDirectory()) {
    console.error(`not a directory: ${options.dir}`)
    process.exit(2)
  }

  const pkg = staticChecks(options.dir)
  if (options.staticOnly || state.failures.length > 0) { report(options); return }
  if (pkg?.dsh?.bundle?.patch === undefined) {
    fail('package does not declare dsh.bundle.patch, so dsh plugin add cannot activate it as a bundle')
    report(options)
    return
  }

  const dsh = resolve(options.dsh ?? DEFAULT_DSH)
  if (!existsSync(dsh)) {
    fail(`CLI entry not found: ${dsh}`)
    fail('pass --dsh <the bin.js of the dsh build you are changing>')
    report(options)
    return
  }
  const liveHome = resolve(options.home ?? DEFAULT_HOME)

  stage('binding')
  const version = run(process.execPath, [dsh, '--version'], { timeout: 60_000 })
  if (version.status !== 0) fail(`CLI does not run: ${tail(version.stderr || version.stdout, 3)}`)
  else pass(`CLI ${version.stdout.trim()}`)
  if (existsSync(liveHome)) pass(`live DSH_HOME ${liveHome}`)
  else warn(`live DSH_HOME not found: ${liveHome}`)
  const pnpm = process.platform === 'win32'
    ? run('cmd.exe', ['/d', '/s', '/c', 'pnpm --version'], { timeout: 60_000 })
    : run('pnpm', ['--version'], { timeout: 60_000 })
  if (pnpm.status !== 0) fail('pnpm is not on PATH; bundle install needs it')
  else pass(`pnpm ${pnpm.stdout.trim()}`)
  if (state.failures.length > 0) { report(options); return }

  const stageHome = mkdtempSync(join(tmpdir(), 'dsh-stage-'))
  const logPath = join(stageHome, 'stage.log')
  const env = { ...process.env, DSH_HOME: stageHome }
  const profileDir = join(stageHome, 'profiles', STAGE_PROFILE)
  const context = { stageHome, logPath, dsh }
  let child

  try {
    stage('S1 create staging profile')
    const created = run(process.execPath,
      [dsh, '--profile', STAGE_PROFILE, '--from-default-profile', 'web', '--dump-default-config'],
      { env, timeout: 180_000 })
    if (created.status !== 0) fail(`profile creation failed: ${tail(created.stderr || created.stdout, 4)}`)
    else if (!existsSync(join(profileDir, 'package.json'))) fail('profile manifest was not created')
    else pass(`disposable profile at ${profileDir}`)
    if (state.failures.length > 0) { report(options, context); return }

    stage('S2 install bundle')
    const installed = run(process.execPath, [dsh, 'plugin', '--profile', STAGE_PROFILE, 'add', options.dir],
      { env, cwd: stageHome, timeout: 300_000 })
    if (installed.status !== 0) {
      fail(`install failed: ${errorSummary(installed.stderr || installed.stdout)}`)
      report(options, context)
      return
    }
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    if (pkg?.name && bundles.includes(pkg.name)) pass(`bundle list includes ${pkg.name}`)
    else fail(`bundle list does not include ${pkg?.name ?? 'the package'}; installation did not activate its bundle layer`)
    if (state.failures.length > 0) { report(options, context); return }
    if (pkg?.name && existsSync(join(profileDir, 'node_modules', ...pkg.name.split('/')))) {
      pass('package resolvable from the staging profile')
    } else {
      warn('package not found under the staging profile node_modules')
    }

    stage('S3 boot + S4 probe')
    const port = options.port ?? 0
    let probeUrl
    child = spawn(process.execPath, [dsh, '--profile', STAGE_PROFILE, '--port', String(port), '--no-open'], {
      cwd: stageHome,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => chunks.push(chunk))
    let exitCode = null
    child.once('exit', (code) => { exitCode = code })

    const deadline = Date.now() + options.timeout * 1000
    let status = 0
    let body = ''
    let served = false
    while (Date.now() < deadline) {
      if (exitCode !== null) break
      const announced = extractUrl(Buffer.concat(chunks).toString('utf8'))
      if (announced) probeUrl = announced
      if (probeUrl === undefined) {
        await sleep(400)
        continue
      }
      try {
        const response = await fetch(probeUrl, { signal: AbortSignal.timeout(3000), redirect: 'manual' })
        status = response.status
        // The tokenized URL answers 200 or redirects into the authenticated shell.
        if (status === 200 || status === 302 || status === 303) {
          served = true
          if (status === 200) body = await response.text()
          break
        }
      } catch { /* not listening yet */ }
      await sleep(400)
    }
    const log = Buffer.concat(chunks).toString('utf8')
    writeFileSync(logPath, log, 'utf8')

    if (exitCode !== null) {
      fail(`staged instance exited with code ${exitCode} during boot`)
      fail(tail(log, 8))
      report(options, context)
      return
    }
    const target = probeUrl === undefined ? `port ${port}` : new URL(probeUrl).origin
    if (served) pass(`${target} accepted the token and served the shell (HTTP ${status})`)
    else if (status === 401) fail(`${target} answered 401: reachable but the token was rejected`)
    else fail(`${target} did not serve within ${options.timeout}s (last status ${status})`)

    const failedFibers = log.split('\n').filter((line) => /\bFAILED\b/.test(line) || /\): Error: /.test(line))
    const inactive = log.match(/warning: (\d+) entr(?:y|ies) did not activate/)
    if (inactive) {
      fail(`${inactive[1]} entry did not activate`)
      fail(failedFibers.slice(0, 3).map((line) => line.trim()).join(' | ') || 'see the staging log')
    } else if (failedFibers.length > 0) {
      fail(`${failedFibers.length} plugin error line(s) in the log`)
      fail(failedFibers.slice(0, 3).map((line) => line.trim()).join(' | '))
    } else {
      pass('every entry activated; no plugin error lines')
    }

    if (served && pkg?.name && body) {
      if (body.includes(pkg.name)) pass(`boot payload names ${pkg.name}`)
      else warn('boot payload does not name the bundle; confirm it registered after promotion')
    }

    if (options.open) {
      if (probeUrl === undefined) {
        fail('cannot open the staged instance because it never announced a URL')
        return
      }
      const command = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', probeUrl]]
        : process.platform === 'darwin' ? ['open', [probeUrl]] : ['xdg-open', [probeUrl]]
      spawnSync(command[0], command[1], { windowsHide: true, stdio: 'ignore' })
      console.log(`\n  open  ${new URL(probeUrl).origin}  (fresh home: no credentials, log in there to interact)`)
      await sleep(1500)
    }
  } finally {
    await stopChild(child)
    report(options, context)
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
