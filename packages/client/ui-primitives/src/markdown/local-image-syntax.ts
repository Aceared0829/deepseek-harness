/** Recover standalone local image references with bare spaces without changing code or source offsets. */
import type { Root, RootContent, PhrasingContent } from 'mdast'
import { classifyFileType } from '../FileTypeIcon.tsx'

/** `![alt](dest)` with an optional `<...>` destination, anchored at the node's own source slice. */
const INLINE_IMAGE = /^!\[[^\]\n]*\]\(\s*(?:<([^>\n]*)>|([^\s)]*))/u

/**
 * Restore backslashes that Markdown treated as punctuation escapes inside a local
 * Windows image destination.
 *
 * `![x](<D:\shots\.probe\a.png>)` parses with the `\.` consumed as an escape, so the
 * node URL loses a separator and the file route answers 404. Paths are not prose:
 * `\` is a separator, and the only escape that can be meant is `\\` for one literal
 * backslash. Rewriting the raw source destination that way keeps both spellings
 * (`C:\a\b.png` and `C:\\a\\b.png`) pointing at the same file.
 * @param url - URL produced by the Markdown parser.
 * @param raw - Destination text exactly as authored.
 * @returns The repaired local path, or the original URL when no repair applies.
 */
function repairWindowsPath(url: string, raw: string): string {
  if (!raw.includes('\\')) return url
  const repaired = raw.replace(/\\\\/gu, '\\')
  // Only claim the repair when the parser really did mangle this destination.
  return repaired === url ? url : repaired
}

/**
 * Recover only unambiguous, unescaped image-only paragraphs containing a local path with spaces,
 * and repair Windows backslash destinations damaged by Markdown escaping.
 * @param root - Parsed Markdown tree, modified in place.
 * @param source - Original source used to distinguish authored syntax from escaped examples.
 * @returns The same root with recovered image nodes.
 */
export function recoverLocalImages(root: Root, source: string): Root {
  const visit = (node: Root | RootContent): void => {
    if (node.type === 'paragraph' && node.children.length === 1) {
      const [child] = node.children as [PhrasingContent]
      if (child.type === 'text' && child.position !== undefined
        && source.slice(child.position.start.offset, child.position.end.offset) === child.value) {
        const pattern = /^!\[([^\]\n]*)\]\(((?:\/(?!\/)|\.{1,2}\/|[a-z]:[\\/])[^\n<>()[\]"']+\.[a-z\d]+)\)$/iu
        const match = pattern.exec(child.value) as [string, string, string] | null
        if (match !== null && match[2].includes(' ') && classifyFileType(match[2]) === 'image') {
          node.children = [{ type: 'image', alt: match[1], url: match[2], position: child.position }]
        }
      }
    }
    if (node.type === 'image' && node.position !== undefined) {
      const slice = source.slice(node.position.start.offset, node.position.end.offset)
      const match = INLINE_IMAGE.exec(slice)
      if (match !== null) node.url = repairWindowsPath(node.url, match[1] ?? match[2] ?? '')
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(root)
  return root
}
