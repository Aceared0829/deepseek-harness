/** Replace sharp's native decoder with its WebAssembly build on Linux. */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Packages the native prebuild leaves behind that the WebAssembly build replaces. */
const NATIVE_PACKAGES = ['sharp-linux-x64', 'sharp-libvips-linux-x64']

/** Runtime dependencies the WebAssembly build needs beside sharp itself. */
const SUPPORT_PACKAGES = ['tslib', '@emnapi', 'semver', 'detect-libc']

/**
 * Swap the packaged sharp for the WebAssembly build.
 *
 * Electron on Linux exports its own libpng/libjpeg symbols. sharp's glibc prebuild resolves those at decode time and
 * segfaults the whole Electron process, which for the Desktop Host means every session dies on the first image
 * operation. The WebAssembly build carries its own codecs, so the same call decodes correctly at some CPU cost. This
 * substitution applies to the local Linux artifact only; macOS and Windows keep the native build.
 *
 * @param root - Materialized Desktop runtime tree whose node_modules holds sharp.
 * @param pnpm - Absolute path to the bundled pnpm CLI script.
 * @param node - Electron binary used as the Node runtime for the pnpm run.
 * @param environment - Environment for the install, including the registry and pnpm store settings.
 * @returns Resolves after the tree is swapped, or immediately when the tree carries no sharp.
 */
export function replaceSharpWithWasm(
  root: string,
  pnpm: string,
  node: string,
  environment: NodeJS.ProcessEnv,
): void {
  const modules = join(root, 'node_modules')
  const manifestPath = join(modules, 'sharp', 'package.json')
  if (!existsSync(manifestPath)) return
  const { version } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-sharp-wasm-'))
  try {
    writeFileSync(join(scratch, 'package.json'), `${JSON.stringify({ name: 'dsh-sharp-wasm-swap', private: true })}\n`)
    const install = spawnSync(node, [
      pnpm, 'add', `sharp@${version}`, `@img/sharp-wasm32@${version}`,
      '--ignore-scripts', '--config.node-linker=hoisted',
    ], { cwd: scratch, env: environment, stdio: 'inherit' })
    if (install.error !== undefined) throw install.error
    if (install.status !== 0) {
      throw new Error(`desktop runtime: sharp WebAssembly install exited with ${String(install.status ?? install.signal)}`)
    }
    const source = join(scratch, 'node_modules')
    rmSync(join(modules, 'sharp'), { recursive: true, force: true })
    for (const name of NATIVE_PACKAGES) rmSync(join(modules, '@img', name), { recursive: true, force: true })
    cpSync(join(source, 'sharp'), join(modules, 'sharp'), { recursive: true, dereference: true })
    for (const name of readdirSync(join(source, '@img'))) {
      cpSync(join(source, '@img', name), join(modules, '@img', name), { recursive: true, dereference: true })
    }
    for (const name of NATIVE_PACKAGES) rmSync(join(modules, '@img', name), { recursive: true, force: true })
    if (!existsSync(join(modules, '@img', 'sharp-wasm32'))) {
      throw new Error('desktop runtime: sharp WebAssembly package is missing after installation')
    }
    for (const name of SUPPORT_PACKAGES) {
      if (existsSync(join(modules, name)) || !existsSync(join(source, name))) continue
      cpSync(join(source, name), join(modules, name), { recursive: true, dereference: true })
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
