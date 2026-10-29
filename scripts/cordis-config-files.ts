/** Cordis Loader configuration file discovery. */

import { globSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

/**
 * Whether `file` is a git symlink whose checkout produced a placeholder file instead of a link.
 *
 * A repository stores such an entry as mode `120000` with the target path as its content. Where
 * symlink creation is unavailable (Windows without Developer Mode, `core.symlinks=false`), git
 * writes that target text as ordinary file content, so the path exists, is not a link, and holds
 * one relative path where YAML was expected. The Loader can never load that placeholder as a
 * configuration, and validating it would report the degraded checkout as a malformed config.
 *
 * @param file Absolute path to the candidate.
 * @returns Whether the file is an unmaterialized symlink rather than authored YAML.
 */
function isUnmaterializedSymlink(file: string): boolean {
  let stats
  try {
    stats = lstatSync(file)
  } catch {
    return false
  }
  if (stats.isSymbolicLink()) return false
  const content = readFileSync(file, 'utf8')
  // The stored content is exactly the target path: no trailing newline, no other line.
  if (content === '' || content.includes('\n') || content.includes('\0')) return false
  if (isAbsolute(content)) return false
  try {
    // A real unmaterialized symlink resolves to an existing file beside the placeholder.
    realpathSync(resolve(dirname(file), content))
    return true
  } catch {
    return false
  }
}

/**
 * Return repository-relative Cordis Loader YAML paths under `root`.
 *
 * Translation consistency records are YAML sidecars, never Loader inputs. Paths stored as symlinks
 * that this checkout could not materialize are also excluded: their placeholder content is the
 * link target, not a configuration, and reporting it would blame the composition for the checkout.
 *
 * @param root Repository root to scan.
 * @returns Sorted repository-relative Loader configuration paths.
 */
export function cordisConfigFiles(root: string): string[] {
  return globSync(['**/*cordis*.yml', '**/*cordis*.yaml'], {
    cwd: root,
    exclude: ['.claude/**', 'node_modules/**', 'vendor/**', '**/*.i18n.yaml'],
  })
    .filter(file => !isUnmaterializedSymlink(resolve(root, file)))
    .sort()
}
