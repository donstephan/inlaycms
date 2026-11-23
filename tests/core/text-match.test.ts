import { findPhrase, snippetAround } from '../../src/core/content/text-match.js'
import { textRuns } from '../../src/core/richtext/runs.js'
import { markdownToRichText } from '../../src/core/richtext/markdown.js'

const texts = (t: string, p: string, mode: 'loose' | 'exact' = 'loose') => findPhrase(t, p, mode).map((h) => h.text)

describe('findPhrase', () => {
  it('ignores case, accents and whitespace runs when loose, reporting the written form', () => {
    expect(texts('Acme and ACME and Acmé', 'acme')).toEqual(['Acme', 'ACME', 'Acmé'])
    expect(texts('Get  started\nnow', 'get started now')).toEqual(['Get  started\nnow'])
  })
  it('matches exactly when exact', () => {
    expect(texts('Acme and ACME', 'Acme', 'exact')).toEqual(['Acme'])
    expect(texts('Get  started', 'Get started', 'exact')).toEqual([])
  })
  it('only matches whole words at the edges', () => {
    expect(texts('Acmeville, AcmeCorp, preAcme', 'acme')).toEqual([])
    expect(texts("Acme's Acme, (Acme) Acme Corp", 'acme')).toEqual(['Acme', 'Acme', 'Acme', 'Acme'])
    expect(texts('Pros and Pro', 'pro', 'exact')).toEqual([])
    expect(texts('Pros and Pro', 'Pro', 'exact')).toEqual(['Pro'])
  })
  it('applies no edge rule on a side where the phrase ends in punctuation', () => {
    expect(texts('Save 50%off now', '50%')).toEqual(['50%'])
    expect(texts('Price: $9.99each', '$9.99')).toEqual([])
  })
  it('treats the phrase literally, not as a pattern', () => {
    expect(texts('Learn C++ today, or C+ maybe', 'c++')).toEqual(['C++'])
    expect(texts('Costs $9.99 (new)', '$9.99 (new)', 'exact')).toEqual(['$9.99 (new)'])
    expect(texts('Costs $9x99', '$9.99')).toEqual([])
  })
  it('returns original offsets and nothing for a blank phrase', () => {
    expect(findPhrase('Hi Ámé there', 'ame', 'loose')).toEqual([{ start: 3, end: 6, text: 'Ámé' }])
    expect(findPhrase('anything', '  ', 'loose')).toEqual([])
  })
  it('finds nothing for a phrase that folds to nothing', () => {
    expect(findPhrase('(x)', '\u0301', 'loose')).toEqual([])
    expect(findPhrase('a\ufe0f b', '\ufe0f', 'loose')).toEqual([])
    expect(findPhrase('(x)', ' \u0301 ', 'loose')).toEqual([])
  })
  it('makes a snippet around a hit', () => {
    const text = `${'a '.repeat(100)}Acme${' b'.repeat(100)}`
    const [hit] = findPhrase(text, 'acme', 'loose')
    const snippet = snippetAround(text, hit!, 100)
    expect(snippet).toContain('Acme')
    expect(snippet.length).toBeLessThanOrEqual(100)
  })
})

describe('textRuns', () => {
  it('splits at blocks, hard breaks and images and keeps node identity', () => {
    const parsed = markdownToRichText('Hello **Acme** world\n\nSecond  \nline')
    if (!parsed.ok) throw new Error('markdown did not parse')
    const runs = textRuns(parsed.doc)
    expect(runs.map((r) => r.text)).toEqual(['Hello Acme world', 'Second', 'line'])
    const bold = runs[0]!.pieces[1]!
    expect(bold).toMatchObject({ start: 6, end: 10 })
    expect(bold.node.marks).toEqual([{ type: 'bold' }])
  })
})
