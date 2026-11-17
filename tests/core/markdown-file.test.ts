import { rewriteImageTargets } from '../../src/core/release/markdown-file.js'
import { markdownImages } from '../../src/core/richtext/markdown.js'

const file = '/site/posts/p.md'
const rewrite = (text: string) => rewriteImageTargets(text, file).text

describe('rewriteImageTargets', () => {
  it("rewrites relative image targets against the file's folder", () => {
    expect(rewrite('![a](./x.png)')).toBe('![a](file:///site/posts/x.png)')
    expect(rewrite('![a](x.png)')).toBe('![a](file:///site/posts/x.png)')
    expect(rewrite('![a](../shared/x.png)')).toBe('![a](file:///site/shared/x.png)')
    expect(rewrite('Some ![a](x.png "Title") text and ![b](y.png).')).toBe(
      'Some ![a](file:///site/posts/x.png "Title") text and ![b](file:///site/posts/y.png).',
    )
    expect(rewrite('[![a](x.png)](https://example.com)')).toBe('[![a](file:///site/posts/x.png)](https://example.com)')
  })

  it('lists reference-style images by line and leaves them as written', () => {
    const text = 'Intro\n\n![a][pic]\n\n![b]\n\n[pic]: ./x.png\n[b]: ./y.png\n'
    expect(rewriteImageTargets(text, file)).toEqual({ text, references: [3, 5], unplaced: [] })
    const collapsed = 'Intro\n![a][]\n\n[a]: ./x.png\n'
    expect(rewriteImageTargets(collapsed, file)).toEqual({ text: collapsed, references: [2], unplaced: [] })
    const link = 'A [link][l] and [l].\n\n[l]: ./x.png\n'
    expect(rewriteImageTargets(link, file)).toEqual({ text: link, references: [], unplaced: [] })
  })

  it('leaves file:, inlay:, http(s): and /-rooted targets alone', () => {
    const text = [
      '![a](file:///elsewhere/x.png)',
      '![b](inlay:media/abc)',
      '![c](http://example.com/x.png)',
      '![d](HTTPS://example.com/x.png)',
      '![e](/x.png)',
      '![f]()',
      '![g](mailto:x@example.com)',
    ].join('\n\n')
    expect(rewriteImageTargets(text, file)).toEqual({ text, references: [], unplaced: [] })
  })

  it('leaves code spans, code blocks and escaped brackets alone', () => {
    const text = [
      'Code `![a](x.png)` here.',
      '```\n![b](x.png)\n```',
      '    ![c](x.png)',
      '\\![d](x.png) and !\\[e](x.png)',
    ].join('\n\n')
    expect(rewriteImageTargets(text, file)).toEqual({ text, references: [], unplaced: [] })
  })

  it('rewrites images in lists, quotes and headings, and keeps every line where it was', () => {
    const text = [
      '# Title ![h](h.png)',
      '',
      '- one ![l](l.png)',
      '  - two',
      '    ![n](n.png)',
      '1. 1. ![o](o.png)',
      '',
      '> quote',
      '> ![q](q.png) and ![r](r.png)',
      '',
      '| a | b |',
      '| - | - |',
      '| ![t](t.png) | ![t](t.png) |',
      '',
      'Setext ![s](s.png)',
      '===',
      '',
    ].join('\n')
    const out = rewrite(text)
    expect(out.split('\n')).toHaveLength(text.split('\n').length)
    const lines = out.split('\n')
    expect(lines[0]).toBe('# Title ![h](file:///site/posts/h.png)')
    expect(lines[2]).toBe('- one ![l](file:///site/posts/l.png)')
    expect(lines[4]).toBe('    ![n](file:///site/posts/n.png)')
    expect(lines[5]).toBe('1. 1. ![o](file:///site/posts/o.png)')
    expect(lines[8]).toBe('> ![q](file:///site/posts/q.png) and ![r](file:///site/posts/r.png)')
    expect(lines[12]).toBe('| ![t](file:///site/posts/t.png) | ![t](file:///site/posts/t.png) |')
    expect(lines[14]).toBe('Setext ![s](file:///site/posts/s.png)')
    expect(markdownImages(out).map((i) => i.line)).toEqual(markdownImages(text).map((i) => i.line))
  })

  it('keeps CRLF line endings', () => {
    const text = 'Intro\r\n\r\n![a](x.png)\r\nmore ![b](./y.png)\r\n\r\n![c][c]\r\n\r\n[c]: ./z.png\r\n'
    const result = rewriteImageTargets(text, file)
    expect(result.text).toBe(
      'Intro\r\n\r\n![a](file:///site/posts/x.png)\r\nmore ![b](file:///site/posts/y.png)\r\n\r\n![c][c]\r\n\r\n[c]: ./z.png\r\n',
    )
    expect(result.references).toEqual([6])
    expect(markdownImages(result.text)).toEqual([
      { src: 'file:///site/posts/x.png', line: 3 },
      { src: 'file:///site/posts/y.png', line: 4 },
      { src: './z.png', line: 6 },
    ])
  })

  it('wraps a target with spaces or parentheses in angle brackets', () => {
    expect(rewrite('![a](<my chart (1).png>)')).toBe('![a](<file:///site/posts/my%20chart%20(1).png>)')
    expect(rewrite('![a](chart\\(1\\).png)')).toBe('![a](<file:///site/posts/chart(1).png>)')
    expect(markdownImages(rewrite('![a](<my chart (1).png>)'))).toEqual([
      { src: 'file:///site/posts/my%20chart%20(1).png', line: 1 },
    ])
  })

  it("lists by line an image whose place in the file it can't find, and leaves it as written", () => {
    const text = 'Intro\n\nA\0 ![a](x.png)\n\n![b](y.png)\n'
    expect(rewriteImageTargets(text, file)).toEqual({
      text: 'Intro\n\nA\0 ![a](x.png)\n\n![b](file:///site/posts/y.png)\n',
      references: [],
      unplaced: [3],
    })
  })

  it('finds an image on a list item line indented with a tab', () => {
    expect(rewriteImageTargets('- item\n\t![shot](shot.png)\n', file)).toEqual({
      text: '- item\n\t![shot](file:///site/posts/shot.png)\n',
      references: [],
      unplaced: [],
    })
    expect(rewriteImageTargets('1. Step one:\n\t![shot](shot.png)\n', file)).toEqual({
      text: '1. Step one:\n\t![shot](file:///site/posts/shot.png)\n',
      references: [],
      unplaced: [],
    })
  })

  it("doesn't list an image in a table cell with an escaped pipe, which rich text refuses on its own", () => {
    const text = '| a | b |\n| - | - |\n| x \\| y ![t](t.png) | z |\n'
    expect(rewriteImageTargets(text, file)).toEqual({ text, references: [], unplaced: [] })
  })
})
