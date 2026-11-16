import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTRAST_PAIRS, contrastRatio, INLAY_THEME, resolveTheme, themeContrastProblems } from '../../src/adapters/admin/theme.js'

describe('resolveTheme', () => {
  it('defaults to the inlay theme', () => {
    const theme = resolveTheme()
    expect(theme.name).toBe('inlay')
    expect(theme.css).toContain('--color-primary:')
    expect(theme.css).toContain('--color-base-300:#e7e5e4')
    expect(theme.css).toMatch(/;--radius-box:\.75rem;--radius-field:\.5rem;--radius-selector:\.5rem;--depth:0;--noise:0\}$/)
  })

  it('passes built-in names through', () => {
    expect(resolveTheme('dark')).toEqual({ name: 'dark', css: '' })
  })

  it('rejects unknown names', () => {
    expect(() => resolveTheme('nope')).toThrow(expect.objectContaining({ code: 'config' }))
  })

  it('overrides colors on a base theme', () => {
    expect(resolveTheme({ base: 'corporate', colors: { primary: '#0b5fff' } }).css).toBe(
      'html[data-theme="corporate"]{--color-primary:#0b5fff}',
    )
  })

  it('keeps the shape tokens out of other themes', () => {
    expect(resolveTheme({ base: 'corporate', colors: { primary: '#0b5fff' } }).css).not.toContain('--radius-box')
  })

  it('rejects unsafe colors and keys', () => {
    expect(() => resolveTheme({ colors: { primary: 'red;}body{x' } })).toThrow(expect.objectContaining({ code: 'config' }))
    expect(() => resolveTheme({ colors: { '--x': '#fff' } as never })).toThrow(expect.objectContaining({ code: 'config' }))
    expect(() => resolveTheme({ colors: { primary: 'url(x)' } })).toThrow(expect.objectContaining({ code: 'config' }))
  })
})

describe('contrast', () => {
  it('passes for the default theme', () => {
    expect(themeContrastProblems(INLAY_THEME.colors)).toEqual([])
  })

  it('computes WCAG ratios for hex only', () => {
    const ratio = contrastRatio('#777777', '#ffffff')!
    expect(ratio).toBeGreaterThan(4.47)
    expect(ratio).toBeLessThan(4.49)
    expect(contrastRatio('oklch(50% 0 0)', '#fff')).toBeNull()
  })

  it('reports failing pairs', () => {
    const problems = themeContrastProblems({ primary: '#ffff00', 'primary-content': '#ffffff' })
    expect(problems.map((p) => p.pair)).toEqual([
      ['primary', 'base-100'],
      ['primary', 'base-200'],
      ['primary-content', 'primary'],
    ])
  })

  it('checks every theme color the admin uses as text on the page', () => {
    const files = [
      ...readdirSync('src/adapters/admin', { recursive: true, encoding: 'utf8' }).map((f) => join('src/adapters/admin', f)),
      ...readdirSync('client/admin', { recursive: true, encoding: 'utf8' }).map((f) => join('client/admin', f)),
      'src/core/fields/widgets.tsx',
    ].filter((f) => /\.(ts|tsx)$/.test(f))
    const used = new Set<string>()
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/\btext-(primary|secondary|accent|info|success|warning|error|neutral)\b(?!-content)/g)) used.add(m[1]!)
      for (const m of source.matchAll(/btn-(primary|secondary|accent|info|success|warning|error|neutral) btn-outline|btn-outline btn-(primary|secondary|accent|info|success|warning|error|neutral)/g)) {
        used.add((m[1] ?? m[2])!)
      }
    }
    expect(used.size).toBeGreaterThan(0)
    const pairs = CONTRAST_PAIRS.map(([fg, bg]) => `${fg} on ${bg}`)
    for (const color of used) {
      expect(pairs).toContain(`${color} on base-100`)
      expect(pairs).toContain(`${color} on base-200`)
    }
    expect(used.has('warning')).toBe(false)
  })
})
