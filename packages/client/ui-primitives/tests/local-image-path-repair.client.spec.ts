import { describe, expect, it } from 'vitest'
import { parseGfm } from '../src/markdown/parse.ts'

/** Collect every image node's url from a parsed document. */
function imageUrls(src: string): string[] {
  const out: string[] = []
  const walk = (node: { type: string; url?: string; children?: unknown[] }): void => {
    if (node.type === 'image' && typeof node.url === 'string') out.push(node.url)
    for (const child of (node.children ?? []) as typeof node[]) walk(child)
  }
  walk(parseGfm(src))
  return out
}

describe('local image path repair', () => {
  it('keeps a separator that Markdown would have consumed as an escape', () => {
    expect(imageUrls('![shot](<D:\\shots\\.probe\\a.png>)'))
      .toStrictEqual(['D:\\shots\\.probe\\a.png'])
  })

  it('normalises a doubled separator to the same path', () => {
    expect(imageUrls('![shot](<D:\\\\shots\\\\.probe\\\\a.png>)'))
      .toStrictEqual(['D:\\shots\\.probe\\a.png'])
  })

  it('repairs an unparenthesised Windows destination', () => {
    expect(imageUrls('![shot](D:\\shots\\.probe\\a.png)'))
      .toStrictEqual(['D:\\shots\\.probe\\a.png'])
  })

  it('leaves forward-slash and POSIX destinations alone', () => {
    expect(imageUrls('![shot](<D:/shots/.probe/a.png>)')).toStrictEqual(['D:/shots/.probe/a.png'])
    expect(imageUrls('![shot](/tmp/graph.png)')).toStrictEqual(['/tmp/graph.png'])
  })

  it('leaves prose escapes outside an image destination alone', () => {
    expect(imageUrls('a\\.b ![shot](/tmp/graph.png)')).toStrictEqual(['/tmp/graph.png'])
  })
})
