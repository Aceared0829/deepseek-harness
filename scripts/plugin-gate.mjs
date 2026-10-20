/**
 * Does this bundle still work? Run the three stages the product runs, against
 * real data, before anyone restarts to find out.
 *
 * `stage-verify.mjs` proves the Host still starts. That is a different question
 * from "does the plugin work": a bundle can install cleanly, activate cleanly,
 * and still throw inside its own projection, publish a payload the gateway
 * rejects, or crash its own view. All three are invisible until a person clicks
 * into it, and by then the only fix is another restart.
 *
 * This script answers the second question. It is bundle-agnostic: you name how
 * to build state, how to validate it, and how to render the view, and it runs
 * that over your real data.
 *
 * Usage:
 *
 *   node scripts/plugin-gate.mjs --bundle <dir> [options]
 *
 *   --bundle <dir>      the bundle package directory (required)
 *   --module <spec>     module inside it exporting the plugin (default: lib/index.js)
 *   --client <spec>     browser half, mounted through the module loader
 *   --fixtures <dir>    directory of real input files, or a glob-free path list
 *   --helper <spec>     module exporting review(inputPath) -> { steps, render? }
 *                       for a bundle whose pipeline this script cannot guess
 *   --max-state <n>     byte budget for the persisted state (default 131072)
 *   --limit <n>         newest N fixtures only
 *   --json              machine-readable result on stdout
 *
 * How it decides what to run, in order:
 *
 *   1. `--helper`: the bundle supplies its own three stages. Most precise.
 *   2. A projection definition discovered on the exported plugin: the script
 *      folds `--fixtures` through it and renders the wire view.
 *   3. Neither: the script reports what it could not verify and exits 3, which
 *      is NOT a pass.
 *
 * Exit codes: 0 pass, 1 failed, 2 nothing to check, 3 unverifiable.
 *
 * Everything runs read-only against the live profile. This script writes
 * nothing outside its own temporary directory.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

/** Node's resolver, used to locate the shell-provided modules the bundle requests. */
const require = createRequire(import.meta.url)

/** Why the browser half could not be mounted, reported instead of a bare skip. */
let lastClientError

/** Line-prefix style shared with stage-verify.mjs. */
const pass = message => console.log(`  PASS  ${message}`)
const fail = (state, message) => { state.failures.push(message); console.log(`  FAIL  ${message}`) }
const skip = (state, message) => { state.skipped.push(message); console.log(`  SKIP  ${message}`) }
const info = message => console.log(`        ${message}`)

/**
 * Parse the command line.
 * @param argv - arguments after the script path.
 * @returns the resolved options.
 */
function parseArgs(argv) {
  const out = {
    bundle: undefined,
    module: 'lib/index.js',
    client: 'lib/client.js',
    fixtures: undefined,
    helper: undefined,
    maxState: 128 * 1024,
    limit: 0,
    json: false,
  }
  const value = (index, arg) => {
    const next = argv[index]
    if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`)
    return next
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') out.json = true
    else if (arg === '--bundle') out.bundle = value(++index, arg)
    else if (arg === '--module') out.module = value(++index, arg)
    else if (arg === '--client') out.client = value(++index, arg)
    else if (arg === '--fixtures') out.fixtures = value(++index, arg)
    else if (arg === '--helper') out.helper = value(++index, arg)
    else if (arg === '--max-state') out.maxState = Number(value(++index, arg))
    else if (arg === '--limit') out.limit = Number(value(++index, arg))
    else if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0) }
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (out.bundle === undefined) {
    printUsage()
    throw new Error('--bundle is required')
  }
  return out
}

/** Print usage. */
function printUsage() {
  console.log(`Usage: node scripts/plugin-gate.mjs --bundle <dir> [options]

  --bundle <dir>    bundle package directory (required)
  --module <spec>   host module inside it (default lib/index.js)
  --client <spec>   browser half (default lib/client.js)
  --fixtures <dir>  real input files to fold
  --helper <spec>   module exporting review(inputPath)
  --max-state <n>   byte budget for persisted state (default 131072)
  --limit <n>       newest N fixtures only
  --json            machine-readable result

Exit: 0 pass, 1 failed, 2 nothing to check, 3 unverifiable.`)
}

/**
 * Collect every `undefined`-valued path; JSON drops these silently.
 * @param value - value to walk.
 * @param path - current path label.
 * @param out - accumulator.
 * @returns the offending paths.
 */
function undefinedPaths(value, path = '$', out = []) {
  if (value === undefined) {
    out.push(path)
    return out
  }
  if (value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    value.forEach((item, index) => undefinedPaths(item, `${path}[${index}]`, out))
    return out
  }
  for (const key of Object.keys(value)) undefinedPaths(value[key], `${path}.${key}`, out)
  return out
}

/**
 * Find a projection definition by mounting the plugin against a stub context.
 *
 * The plugin is not started: this captures whatever it registers, which is how
 * the product itself discovers the unit.
 * @param plugin - the host module.
 * @returns the definition, or undefined when the bundle registers none.
 */
function discoverProjection(plugin) {
  let definition
  const noop = () => () => {}
  const stub = new Proxy({}, {
    get: (_target, key) => {
      if (key === 'sessionProjections') {
        return { register: value => { definition = value; return () => {} } }
      }
      if (key === 'effect' || key === 'on' || key === 'plugin' || key === '$on') return noop
      if (key === 'get') return () => undefined
      if (key === 'inject') return () => noop()
      // Anything else is a service this stub does not provide; a property read
      // must not throw, or discovery fails on a correct plugin.
      return undefined
    },
    has: () => true,
  })
  try {
    plugin.apply(stub, undefined)
  } catch (error) {
    // A plugin that throws while mounting under a stub is still discoverable
    // when it registered before throwing; the caller decides.
    if (definition === undefined) {
      throw new Error(`mounting the plugin threw: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return definition
}

/**
 * Load the browser half through the page's module-loader facade.
 * @param clientPath - absolute path to the client bundle.
 * @param bundleDir - the bundle root, so the shell modules resolve from it.
 * @returns a render function, or undefined when it cannot be mounted.
 */
async function loadClient(clientPath, bundleDir) {
  if (!existsSync(clientPath)) return undefined
  // React is shell-provided; the bundle must not import it, so the gate has to
  // supply it. Node's own resolver is used rather than a guessed path, because
  // the shell modules sit in the pnpm store and not at a fixed depth. The repo
  // root comes from THIS script, so the roots hold wherever the bundle lives.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const roots = [
    join(bundleDir, 'node_modules'),
    join(repoRoot, 'packages', 'client', 'web', 'node_modules'),
    join(repoRoot, 'node_modules'),
  ]
  const resolveFrom = (root, request) => {
    try {
      // `createRequire` needs an existing file as the base; a synthesized
      // `<root>/noop.js` does not exist and resolution silently fails on some
      // Node versions. `require.resolve` with explicit `paths` has no such
      // requirement.
      return require.resolve(request, { paths: [root] })
    } catch {
      return undefined
    }
  }
  let modules
  for (const root of roots) {
    const react = resolveFrom(root, 'react')
    const jsx = resolveFrom(root, 'react/jsx-runtime')
    const dom = resolveFrom(root, 'react-dom/server')
    if (react === undefined || jsx === undefined || dom === undefined) continue
    modules = {
      react: await import(pathToFileURL(react).href),
      'react/jsx-runtime': await import(pathToFileURL(jsx).href),
      renderToStaticMarkup: (await import(pathToFileURL(dom).href)).renderToStaticMarkup,
    }
    try {
      modules.zod = await import(pathToFileURL(resolveFrom(root, 'zod') ?? 'zod').href)
    } catch {
      modules.zod = await import('zod')
    }
    break
  }
  if (modules === undefined) {
    lastClientError = `no root resolved react, react/jsx-runtime and react-dom/server from: ${roots.join(', ')}`
    return undefined
  }
  const renderToStaticMarkup = modules.renderToStaticMarkup
  globalThis.window = { __ModuleLoader__: { load: value => { globalThis.__registration = value } } }
  await import(pathToFileURL(clientPath).href)
  const registration = globalThis.__registration
  if (registration === undefined) {
    lastClientError = 'the bundle did not call window.__ModuleLoader__.load'
    return undefined
  }
  const plugin = registration.factory(specifier => modules[specifier])
  if (plugin === undefined || typeof plugin.apply !== 'function') {
    lastClientError = 'the bundle factory did not return a Cordis browser plugin'
    return undefined
  }
  const captured = {}
  plugin.apply({
    effect: fn => fn(),
    locale: {
      register: () => () => {},
      bind: () => key => key,
    },
    slots: {
      inject: (_name, install) => install(),
      register: (definition, component) => {
        captured.definition = definition
        captured.component = component
        return () => {}
      },
    },
    remote: { $mount: () => Promise.resolve(() => {}), get harnessMarks() { return undefined } },
    get: () => undefined,
  })
  if (captured.component === undefined) {
    lastClientError = 'the bundle mounted but registered no view component'
    return undefined
  }
  return {
    definition: captured.definition,
    /**
     * Render one payload the way the tab does.
     * @param props - the projection value the slot would supply.
     * @returns the static markup.
     */
    render: props => {
      const View = () => captured.component({ t: key => key, useProjection: () => props })
      return renderToStaticMarkup(modules.react.createElement(View))
    },
  }
}

/**
 * Run the gate.
 * @param argv - arguments after the script path.
 * @returns the exit code.
 */
async function main(argv) {
  const options = parseArgs(argv)
  const state = { failures: [], skipped: [] }
  const bundleDir = resolve(options.bundle)
  if (!existsSync(bundleDir)) throw new Error(`bundle directory does not exist: ${bundleDir}`)
  console.log(`gate: ${bundleDir}`)

  const modulePath = resolve(bundleDir, options.module)
  if (!existsSync(modulePath)) throw new Error(`host module does not exist: ${modulePath}`)
  const plugin = await import(pathToFileURL(modulePath).href)
  if (typeof plugin.apply !== 'function') throw new Error(`${options.module} does not export apply()`)
  pass('the host module loads and exports apply()')

  const client = await loadClient(resolve(bundleDir, options.client), bundleDir)
  if (client === undefined) skip(state, `the browser half could not be mounted; render is unverified (${lastClientError ?? 'unknown reason'})`)
  else pass(`the browser half mounts and registers on ${client.definition?.name ?? 'a slot'}`)

  // A helper owns the three stages: it knows its own input and output shape.
  if (options.helper !== undefined) {
    const helperPath = resolve(bundleDir, options.helper)
    if (!existsSync(helperPath)) throw new Error(`helper does not exist: ${helperPath}`)
    const helper = await import(pathToFileURL(helperPath).href)
    if (typeof helper.review !== 'function') throw new Error(`${options.helper} must export review()`)
    const inputs = options.fixtures === undefined ? [] : listInputs(options.fixtures)
    const targeted = options.limit > 0 ? inputs.slice(-options.limit) : inputs
    if (targeted.length === 0) {
      skip(state, 'no fixtures given; the helper had nothing to run over')
    }
    let reviewed = 0
    for (const input of targeted) {
      try {
        const outcome = await helper.review(input)
        if (outcome?.stateBytes !== undefined && outcome.stateBytes > options.maxState) {
          fail(state, `${input}: state is ${outcome.stateBytes} bytes, over the ${options.maxState} budget`)
        }
        reviewed += 1
      } catch (error) {
        fail(state, `${input}: review threw (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    if (reviewed > 0) pass(`the helper reviewed ${reviewed} input(s)`)
    return finish(state, options, reviewed)
  }

  // No helper: use the projection the bundle registers.
  let definition
  try {
    definition = discoverProjection(plugin)
  } catch (error) {
    fail(state, error instanceof Error ? error.message : String(error))
    return finish(state, options, 0)
  }
  if (definition === undefined) {
    skip(state, 'the bundle registers no session projection, and no --helper was given')
    return finish(state, options, 0)
  }
  pass(`the bundle registers projection "${definition.key}" v${definition.stateVersion}`)

  if (options.fixtures === undefined) {
    skip(state, 'no --fixtures; the fold and the view over real data are unverified')
    return finish(state, options, 0)
  }
  const inputs = listInputs(options.fixtures)
  const targeted = options.limit > 0 ? inputs.slice(-options.limit) : inputs
  if (targeted.length === 0) {
    fail(state, `no input files under ${options.fixtures}`)
    return finish(state, options, 0)
  }

  const sizes = []
  let checked = 0
  let rendered = 0
  for (const input of targeted) {
    let state_ = definition.init({ id: 'gate-probe', createdAt: 0 })
    let events
    try {
      events = readEvents(input)
    } catch (error) {
      fail(state, `${input}: cannot read input (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    // 1. Fold.
    try {
      for (const event of events) state_ = definition.apply(state_, event)
      definition.stateSchema?.parse(state_)
    } catch (error) {
      fail(state, `${input}: fold threw (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    // 2. Transport.
    let view
    try {
      view = definition.wire.view(state_)
      definition.wire.viewSchema?.parse(view)
    } catch (error) {
      fail(state, `${input}: wire.view threw (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    const undefinedKeys = undefinedPaths(view)
    if (undefinedKeys.length > 0) {
      fail(state, `${input}: view carries undefined at ${undefinedKeys.slice(0, 3).join(', ')}`)
    }
    const serialized = JSON.stringify(view)
    if (serialized === undefined) fail(state, `${input}: view is not serializable`)
    else if (JSON.stringify(JSON.parse(serialized)) !== serialized) {
      fail(state, `${input}: view does not survive a JSON round trip`)
    }
    const stateBytes = JSON.stringify(JSON.parse(JSON.stringify(state_))).length
    sizes.push(stateBytes)
    if (stateBytes > options.maxState) {
      fail(state, `${input}: state is ${stateBytes} bytes, over the ${options.maxState} budget`)
    }
    checked += 1
    // 3. Render.
    if (client === undefined) continue
    try {
      const markup = client.render(view)
      if (typeof markup !== 'string' || markup === '') fail(state, `${input}: render produced no markup`)
      else rendered += 1
    } catch (error) {
      fail(state, `${input}: render threw (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  pass(`folded ${checked} input(s)`)
  if (client !== undefined) pass(`rendered ${rendered} payload(s)`)
  if (sizes.length > 0) {
    sizes.sort((left, right) => left - right)
    const kb = value => `${(value / 1024).toFixed(1)} KB`
    info(`state size median ${kb(sizes[sizes.length >> 1])} p95 ${kb(sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.95))])} max ${kb(sizes.at(-1))}`)
  }
  return finish(state, options, checked)
}

/**
 * List input files under a directory, newest last.
 * @param directory - directory to scan.
 * @returns absolute paths.
 */
function listInputs(directory) {
  const root = resolve(directory)
  if (!existsSync(root)) return []
  const found = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) found.push(...listInputs(path))
    else found.push(path)
  }
  return found.sort()
}

/**
 * Read one fixture into events.
 *
 * `.json` is an event array or a single event; `.jsonl` is one event per line;
 * `.jsonl.zstd` is the harness session-log shape, where EVERY LINE IS ITS OWN
 * ZSTD FRAME. `zlib.zstdDecompressSync` returns only the first frame of a
 * multi-frame buffer and does not throw, so the frames are split on the magic
 * before decompressing — reading it the naive way silently loses almost the
 * whole file.
 * @param path - fixture path.
 * @returns the events.
 */
function readEvents(path) {
  const buffer = readFileSync(path)
  if (path.endsWith('.zstd')) {
    return decodeFrames(buffer)
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line))
  }
  const text = buffer.toString('utf8')
  if (path.endsWith('.jsonl')) {
    return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
  }
  const value = JSON.parse(text)
  if (Array.isArray(value)) return value
  return [value]
}

/** Zstd frame magic; every appended session-log line starts one. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decompress every zstd frame in a buffer.
 * @param buffer - raw bytes.
 * @returns the concatenated text.
 */
function decodeFrames(buffer) {
  const starts = []
  for (let at = buffer.indexOf(ZSTD_MAGIC); at >= 0; at = buffer.indexOf(ZSTD_MAGIC, at + 4)) {
    starts.push(at)
  }
  if (starts.length === 0) return buffer.toString('utf8')
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8'))
    } catch {
      // A frame cut short by a concurrent append: keep the rest.
    }
  }
  return parts.join('')
}

/**
 * Report and return the exit code.
 * @param state - accumulated failures and skips.
 * @param options - resolved options.
 * @param checked - how many inputs were actually verified.
 * @returns the exit code.
 */
function finish(state, options, checked) {
  const result = {
    ok: state.failures.length === 0 && checked > 0 && state.skipped.length === 0,
    checked,
    failures: state.failures,
    skipped: state.skipped,
  }
  if (options.json) console.log(JSON.stringify(result, null, 2))
  if (state.failures.length > 0) {
    console.log(`\nFAILED — ${state.failures.length} problem(s). Do not ask for a restart.`)
    return 1
  }
  if (checked === 0) {
    console.log('\nNOTHING CHECKED — this is not a pass. Supply --fixtures or --helper.')
    return 2
  }
  if (state.skipped.length > 0) {
    console.log(`\nPARTIAL — ${state.skipped.length} stage(s) could not run. Report the plugin as unverified, not as working.`)
    return 3
  }
  console.log('\nPASS — the host folds, the transport accepts, and the view renders. Safe to restart.')
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(`gate could not run: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
