
// Copy next to a plugin directory and run: node verify-plugin.mjs
// Exits non-zero on the first rung that fails, so it can gate a restart.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = process.argv[2] ?? '.'
let failures = 0
const ok = (m) => console.log('  PASS  ' + m)
const bad = (m) => { failures++; console.log('  FAIL  ' + m) }

const pkgPath = join(dir, 'package.json')
if (!existsSync(pkgPath)) { bad('package.json missing') } else {
  const rawPkg = readFileSync(pkgPath, 'utf8')
  if (rawPkg.charCodeAt(0) === 0xFEFF) bad('package.json starts with a UTF-8 BOM; JSON.parse in the Host will reject it')
  let pkg
  try { pkg = JSON.parse(rawPkg.replace(/^\uFEFF/, '')) } catch (e) { bad('package.json does not parse: ' + e.message) }
  if (!pkg) { console.log('cannot continue without a manifest'); process.exit(1) }
  if (pkg.name) ok('name ' + pkg.name); else bad('name missing')
  const clientExport = pkg.exports?.['./client']
  if (clientExport) {
    if (pkg.dsh?.client?.platform === 'web') ok('client platform web'); else bad('dsh.client.platform is not web')
  }
  for (const key of ['.', './client']) {
    const target = pkg.exports?.[key]
    if (typeof target === 'string' && !existsSync(join(dir, target))) bad(key + ' -> ' + target + ' does not exist')
  }
}

const hostEntry = join(dir, 'index.js')
if (existsSync(hostEntry)) {
  try {
    const mod = await import(pathToFileURL(hostEntry).href)
    ok('host module loads; inject=' + JSON.stringify(mod.inject ?? []))
  } catch (e) { bad('host module failed to load: ' + e.message) }
}

// The package entry is `main`, not a file at the plugin directory root.
// Loading it catches top-level ESM and decorator failures before a restart.
const manifestHost = existsSync(pkgPath)
  ? JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '')).main
  : undefined
if (typeof manifestHost === 'string' && existsSync(join(dir, manifestHost))) {
  try {
    const mod = await import(pathToFileURL(join(dir, manifestHost)).href)
    ok('manifest host module loads; inject=' + JSON.stringify(mod.inject ?? []))
  } catch (e) { bad('manifest host module failed to load: ' + e.message) }
}

for (const name of ['src/index.js', 'lib/index.js', 'src/marks.js', 'lib/marks.js', 'src/remote-spec.js',
  'lib/typert.remote-client.js', 'lib/client.js', 'export.mjs']) {
  const p = join(dir, name)
  if (!existsSync(p)) continue
  const text = readFileSync(p, 'utf8')
  if (text.charCodeAt(0) === 0xFEFF) bad(name + ' starts with a UTF-8 BOM')
  const broken = (text.match(/\uFFFD/g) ?? []).length
  if (broken > 0) bad(name + ' holds ' + broken + ' U+FFFD replacement characters; non-ASCII was destroyed on write')
}

for (const [built, source] of [
  ['lib/index.js', 'src/index.js'],
  ['lib/marks.js', 'src/marks.js'],
  ['lib/typert.remote-client.js', 'src/remote-spec.js'],
]) {
  const builtPath = join(dir, built)
  const sourcePath = join(dir, source)
  if (!existsSync(builtPath) || !existsSync(sourcePath)) continue
  if (!readFileSync(builtPath).equals(readFileSync(sourcePath))) {
    bad(built + ' differs from ' + source + '; the profile loads the built copy, so copy the source before restarting')
  } else {
    ok(built + ' matches ' + source)
  }
}

console.log(failures === 0 ? 'OK - safe to consider a restart' : failures + ' failure(s) - fix before restart')
process.exit(failures === 0 ? 0 : 1)
