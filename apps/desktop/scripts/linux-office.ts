/** Route Linux Office conversion to the bundled WebAssembly engine. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Native engine probe that assumes a Linux glibc package the kit never publishes. */
const NATIVE_PROBE = 'return report().header?.glibcVersionRuntime ? `linux-${arch}-glibc` : void 0;'

/**
 * Disable the native Linux engine probe in the materialized Desktop runtime.
 *
 * LibreOfficeKit declares native engines only for macOS and Windows, yet its resolver still asks for
 * `linux-<arch>-glibc` on Linux glibc hosts. That package does not exist, and the failed probe aborts conversion
 * instead of falling back to the WASM engine that is already installed. Returning no native target makes the resolver
 * use the bundled WASM engine. This patch applies to the local Linux artifact only.
 *
 * @param root - Materialized Desktop runtime tree whose node_modules holds LibreOfficeKit.
 * @throws Error when the resolver no longer matches the patched probe.
 */
export function forceWebAssemblyOffice(root: string): void {
  const file = join(root, 'node_modules/@deepseek-ai/libreoffice-kit/lib/index.js')
  if (!existsSync(file)) return
  const source = readFileSync(file, 'utf8')
  if (!source.includes(NATIVE_PROBE)) {
    if (source.includes('if (platform === "linux") return void 0;')) return
    throw new Error('desktop runtime: LibreOfficeKit native engine probe changed; update the Linux Office patch')
  }
  writeFileSync(file, source.replace(NATIVE_PROBE, 'return void 0;'))
}
