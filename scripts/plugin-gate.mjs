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
 *   --fixtures <path>   a directory of real input files, or one such file
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

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

/** Node's resolver, used to locate the shell-provided modules the bundle requests. */
const require = createRequire(import.meta.url)

/** Why the browser half could not be mounted, reported instead of a bare skip. */
let lastClientError

/**
 * Where the progress lines go. `--json` promises a machine-readable stdout, so
 * once it is parsed every human line moves to stderr and stdout carries the
 * result object alone.
 */
let progress = line => console.log(line)

/** Line-prefix style shared with stage-verify.mjs. */
const pass = message => progress(`  PASS  ${message}`)
const fail = (state, message) => { state.failures.push(message); progress(`  FAIL  ${message}`) }
const skip = (state, message) => { state.skipped.push(message); progress(`  SKIP  ${message}`) }
const info = message => progress(`        ${message}`)

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
  const count = (index, arg, minimum) => {
    const raw = value(index, arg)
    const parsed = Number(raw)
    // `Number('abc')` is NaN and every comparison against NaN is false, so an
    // unvalidated budget silently disables the check it configures.
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
      throw new Error(`${arg} needs an integer >= ${minimum}, got ${JSON.stringify(raw)}`)
    }
    return parsed
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') out.json = true
    else if (arg === '--bundle') out.bundle = value(++index, arg)
    else if (arg === '--module') out.module = value(++index, arg)
    else if (arg === '--client') out.client = value(++index, arg)
    else if (arg === '--fixtures') out.fixtures = value(++index, arg)
    else if (arg === '--helper') out.helper = value(++index, arg)
    else if (arg === '--max-state') out.maxState = count(++index, arg, 1)
    else if (arg === '--limit') out.limit = count(++index, arg, 0)
    else if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0) }
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (out.bundle === undefined) {
    printUsage()
    throw new Error('--bundle is required')
  }
  if (out.json) progress = line => console.error(line)
  return out
}

/** Print usage. */
function printUsage() {
  console.log(`Usage: node scripts/plugin-gate.mjs --bundle <dir> [options]

  --bundle <dir>    bundle package directory (required)
  --module <spec>   host module inside it (default lib/index.js)
  --client <spec>   browser half (default lib/client.js)
  --fixtures <path> a directory of real input files, or one such file
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
 * @param seen - objects already walked, so a cycle cannot overflow the stack.
 * @returns the offending paths.
 */
function undefinedPaths(value, path = '$', out = [], seen = new WeakSet()) {
  if (value === undefined) {
    out.push(path)
    return out
  }
  if (value === null || typeof value !== 'object') return out
  if (seen.has(value)) return out
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => undefinedPaths(item, `${path}[${index}]`, out, seen))
    return out
  }
  for (const key of Object.keys(value)) undefinedPaths(value[key], `${path}.${key}`, out, seen)
  return out
}

/**
 * Find the first path where a value differs from its JSON round trip.
 *
 * `JSON.parse(JSON.stringify(v))` is not `v` for `NaN` and `Infinity` (both
 * become `null`) or for functions and symbols (dropped entirely, which also
 * changes a key's presence). `stringify` reports none of these, so the only way
 * to see them is to compare the two values structurally.
 * @param original - the value before serialization.
 * @param reparsed - the value after a JSON round trip.
 * @param path - current path label.
 * @param seen - pairs already compared, so a cycle terminates.
 * @returns the first diverging path, or undefined when they match.
 */
function firstDivergence(original, reparsed, path = '$', seen = new WeakSet()) {
  if (original === reparsed) return undefined
  const type = typeof original
  if (type === 'number') {
    // Covers NaN -> null and Infinity -> null; Object.is keeps -0 distinct.
    return Number.isFinite(original) && Number.isFinite(reparsed) && Object.is(original, reparsed)
      ? undefined
      : path
  }
  if (type === 'function' || type === 'symbol' || type === 'bigint' || type === 'undefined') return path
  if (original === null || reparsed === null || typeof original !== 'object' || typeof reparsed !== 'object') {
    return type === typeof reparsed ? undefined : path
  }
  if (seen.has(original)) return undefined
  seen.add(original)
  if (Array.isArray(original) !== Array.isArray(reparsed)) return path
  if (Array.isArray(original)) {
    if (original.length !== reparsed.length) return path
    for (let index = 0; index < original.length; index += 1) {
      const found = firstDivergence(original[index], reparsed[index], `${path}[${index}]`, seen)
      if (found !== undefined) return found
    }
    return undefined
  }
  const keys = Object.keys(original)
  for (const key of keys) {
    // A dropped value removes the key entirely, so "is the key still there" has
    // to be answered per key; comparing key counts first would report the
    // parent instead of the field that vanished.
    if (!(key in reparsed)) return `${path}.${key}`
    const found = firstDivergence(original[key], reparsed[key], `${path}.${key}`, seen)
    if (found !== undefined) return found
  }
  for (const key of Object.keys(reparsed)) {
    if (!(key in original)) return `${path}.${key}`
  }
  return undefined
}

/**
 * Find a projection definition by mounting the plugin against a stub context.
 *
 * The plugin is not started: this captures whatever it registers, which is how
 * the product itself discovers the unit.
 *
 * `apply` may be `async` — Cordis accepts both — and a registration made after
 * an `await` is not visible to a synchronous probe. The returned promise is
 * therefore awaited before this function decides the bundle registers nothing.
 * @param plugin - the host module.
 * @returns the definition, or undefined when the bundle registers none.
 */
async function discoverProjection(plugin) {
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
    await plugin.apply(stub, undefined)
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
  // The bundle is written against the page's globals, so they have to be
  // installed to import it — and removed again, or this process keeps a fake
  // `window` and a stale registration for everything that runs after the gate.
  const previousWindow = globalThis.window
  const previousRegistration = globalThis.__registration
  let registration
  try {
    globalThis.window = { __ModuleLoader__: { load: value => { globalThis.__registration = value } } }
    globalThis.__registration = undefined
    await import(pathToFileURL(clientPath).href)
    // Read the result before the restore below removes it.
    registration = globalThis.__registration
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousRegistration === undefined) delete globalThis.__registration
    else globalThis.__registration = previousRegistration
  }
  if (registration === undefined) {
    lastClientError = 'the bundle did not call window.__ModuleLoader__.load'
    return undefined
  }
  // The factory and the plugin's own apply both run against a stub that models
  // only what this script can supply. A real bundle reaches for a shell package
  // the stub does not resolve, so a throw here is "the harness could not mount
  // it", not "the plugin is broken" — it becomes a skip (exit 3) rather than a
  // crash that reads as a failed verdict.
  let plugin
  try {
    plugin = registration.factory(specifier => modules[specifier])
  } catch (error) {
    lastClientError = `the bundle factory threw while resolving its imports (${error instanceof Error ? error.message : String(error)})`
    return undefined
  }
  if (plugin === undefined || typeof plugin.apply !== 'function') {
    lastClientError = 'the bundle factory did not return a Cordis browser plugin'
    return undefined
  }
  const captured = {}
  try {
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
  } catch (error) {
    lastClientError = `the browser half threw while mounting against the stub (${error instanceof Error ? error.message : String(error)})`
    return undefined
  }
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
  progress(`gate: ${bundleDir}`)

  const modulePath = resolve(bundleDir, options.module)
  if (!existsSync(modulePath)) throw new Error(`host module does not exist: ${modulePath}`)
  const plugin = await import(pathToFileURL(modulePath).href)
  if (typeof plugin.apply !== 'function') throw new Error(`${options.module} does not export apply()`)
  pass('the host module loads and exports apply()')

  const client = await loadClient(resolve(bundleDir, options.client), bundleDir)
  if (client === undefined) skip(state, `the browser half could not be mounted; render is unverified (${lastClientError ?? 'unknown reason'})`)
  else pass(`the browser half mounts and registers on ${client.definition?.name ?? 'a slot'}`)

  // A helper owns the stages it knows how to run: it understands its own input
  // and output shape. What it does NOT get is a free pass — `render` is optional
  // in the helper contract, but the sentence printed on success claims all three
  // stages ran, so a helper that never renders must produce exit 3, not exit 0.
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
    let rendered = 0
    let renderable = 0
    for (const input of targeted) {
      let outcome
      try {
        outcome = await helper.review(input)
      } catch (error) {
        fail(state, `${input}: review threw (${error instanceof Error ? error.message : String(error)})`)
        continue
      }
      // A review that returns nothing verified nothing; counting it would let a
      // stub helper turn the whole run green.
      if (outcome === undefined || outcome === null) {
        skip(state, `${input}: the helper returned no outcome`)
        continue
      }
      if (outcome.stateBytes !== undefined && outcome.stateBytes > options.maxState) {
        fail(state, `${input}: state is ${outcome.stateBytes} bytes, over the ${options.maxState} budget`)
      }
      // The helper may hand back the wire payload so the transport rule still
      // applies; without it the transport stage simply did not run.
      if (outcome.view !== undefined) {
        const drift = firstDivergence(outcome.view, JSON.parse(JSON.stringify(outcome.view)))
        if (drift !== undefined) fail(state, `${input}: view changes through JSON at ${drift}`)
      }
      reviewed += 1
      if (typeof outcome.render !== 'function') {
        skip(state, `${input}: the helper returned no renderer; the view was not rendered`)
        continue
      }
      renderable += 1
      try {
        const markup = await outcome.render()
        if (typeof markup !== 'string' || markup === '') fail(state, `${input}: render produced no markup`)
        else rendered += 1
      } catch (error) {
        fail(state, `${input}: render threw (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    if (reviewed > 0) pass(`the helper reviewed ${reviewed} input(s)`)
    if (rendered > 0) pass(`the helper rendered ${rendered} payload(s)`)
    // A helper that offers render for some inputs must render all of them.
    if (renderable > 0 && rendered < renderable) {
      fail(state, `render verified ${rendered} of ${renderable} payload(s)`)
    }
    return finish(state, options, reviewed)
  }

  // No helper: use the projection the bundle registers.
  let definition
  try {
    definition = await discoverProjection(plugin)
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
  let foldedEvents = 0
  // `wire` is optional in the contract ("omit for host-only units"), so a bundle
  // without one has no third stage and no second stage either. Say so instead of
  // failing a correct bundle on a TypeError.
  const hostOnly = definition.wire === undefined
  if (hostOnly) skip(state, `"${definition.key}" is host-only (no wire view); transport and render have nothing to verify`)
  for (const input of targeted) {
    let state_ = definition.init({ id: 'gate-probe', createdAt: 0 })
    let events
    try {
      events = readEvents(input)
    } catch (error) {
      fail(state, `${input}: cannot read input (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    // A fixture that yields no events folds nothing, so every later stage
    // passes on the untouched `init` state. Counting it as verified is how a
    // gate goes green over input it never read.
    if (events.length === 0) {
      skip(state, `${input}: no events to fold; this input verifies nothing`)
      continue
    }
    // 1. Fold.
    let stateBytes
    try {
      for (const event of events) state_ = definition.apply(state_, event)
      definition.stateSchema?.parse(state_)
      // Measuring can throw on a cycle or a bigint and is part of the fold's
      // contract, so it stays inside this guard rather than aborting the run.
      stateBytes = JSON.stringify(JSON.parse(JSON.stringify(state_))).length
    } catch (error) {
      fail(state, `${input}: fold threw (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    foldedEvents += events.length
    // 2. Transport. A host-only unit has nothing to send.
    let view
    if (!hostOnly) {
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
    }
    if (!hostOnly) {
      // `JSON.stringify(JSON.parse(serialized)) === serialized` is a tautology
      // for any stable key order, so comparing the text proves nothing. Compare
      // the values instead: that catches `NaN`/`Infinity` turning into `null`
      // and functions or symbols being dropped, neither of which `stringify`
      // reports. The undefined scan above stays, because a dropped `undefined`
      // leaves no trace in either form.
      const serialized = JSON.stringify(view)
      if (serialized === undefined) {
        fail(state, `${input}: view is not serializable`)
      } else {
        const reparsed = JSON.parse(serialized)
        const drift = firstDivergence(view, reparsed)
        if (drift !== undefined) {
          fail(state, `${input}: view changes through JSON at ${drift}`)
        }
      }
    }
    sizes.push(stateBytes)
    if (stateBytes > options.maxState) {
      fail(state, `${input}: state is ${stateBytes} bytes, over the ${options.maxState} budget`)
    }
    checked += 1
    // 3. Render.
    if (client === undefined || hostOnly) continue
    try {
      const markup = client.render(view)
      if (typeof markup !== 'string' || markup === '') fail(state, `${input}: render produced no markup`)
      else rendered += 1
    } catch (error) {
      fail(state, `${input}: render threw (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  if (foldedEvents > 0) pass(`folded ${checked} input(s), ${foldedEvents} event(s)`)
  // `checked` counts folds, so it says nothing about render. A run where every
  // render failed would still exit 0 on the strength of the folds alone; the
  // render stage only counts as verified when it ran for every folded payload.
  if (client !== undefined) {
    if (rendered > 0) pass(`rendered ${rendered} payload(s)`)
    if (rendered < checked) {
      fail(state, `render verified ${rendered} of ${checked} payload(s)`)
    }
  }
  if (sizes.length > 0) {
    sizes.sort((left, right) => left - right)
    const kb = value => `${(value / 1024).toFixed(1)} KB`
    info(`state size median ${kb(sizes[sizes.length >> 1])} p95 ${kb(sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.95))])} max ${kb(sizes.at(-1))}`)
  }
  return finish(state, options, checked)
}

/**
 * List input files under a directory, newest last.
 *
 * A symlink pointing back up the tree would otherwise recurse forever, and one
 * pointing outside the root would silently widen the gate to an unrelated tree,
 * so a visited set breaks cycles and a resolved path outside the root is
 * skipped. `--limit` is documented as "newest N", so the result is ordered by
 * modification time rather than by path.
 * @param directory - a directory to scan, or a single file to use as-is.
 * @returns absolute paths, oldest first.
 */
function listInputs(directory) {
  const root = resolve(directory)
  if (!existsSync(root)) return []
  if (!statSync(root).isDirectory()) return [root]
  const realRoot = realpathSync(root)
  const visited = new Set()
  const walk = current => {
    let real
    try {
      real = realpathSync(current)
    } catch {
      return []
    }
    if (visited.has(real)) return []
    visited.add(real)
    let names
    try {
      names = readdirSync(current)
    } catch {
      // An unreadable directory is one skipped input, not a crash for the run.
      return []
    }
    const found = []
    for (const name of names) {
      const path = join(current, name)
      let entry
      try {
        entry = statSync(path)
      } catch {
        continue
      }
      if (entry.isDirectory()) {
        // Only descend while the resolved target is still under the root.
        let inside
        try {
          inside = realpathSync(path)
        } catch {
          continue
        }
        if (!inside.startsWith(realRoot)) continue
        found.push(...walk(path))
      } else {
        found.push(path)
      }
    }
    return found
  }
  const mtimeOf = path => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return 0
    }
  }
  return walk(root).sort((left, right) => {
    const delta = mtimeOf(left) - mtimeOf(right)
    // mtime ties are possible (a copied fixture set); keep the order stable.
    return delta !== 0 ? delta : left.localeCompare(right)
  })
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
  const verdict = state.failures.length > 0
    ? 'failed'
    : checked === 0
      ? 'nothing-checked'
      : state.skipped.length > 0
        ? 'partial'
        : 'passed'
  const result = {
    ok: verdict === 'passed',
    verdict,
    checked,
    failures: state.failures,
    skipped: state.skipped,
  }
  // `--json` promises machine-readable stdout, so the human summary goes to
  // stderr; mixing the two makes the stream unparseable for a caller that
  // asked for JSON precisely to parse it.
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  const report = progress
  if (verdict === 'failed') {
    report(`\nFAILED — ${state.failures.length} problem(s). Do not ask for a restart.`)
    return 1
  }
  if (verdict === 'nothing-checked') {
    report('\nNOTHING CHECKED — this is not a pass. Supply --fixtures or --helper.')
    return 2
  }
  if (verdict === 'partial') {
    report(`\nPARTIAL — ${state.skipped.length} stage(s) could not run. Report the plugin as unverified, not as working.`)
    return 3
  }
  report('\nPASS — the host folds, the transport accepts, and the view renders. Safe to restart.')
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
