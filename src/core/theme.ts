import { InlayError } from './errors.js'
import type { AdminTheme, ThemeColor } from './types.js'

export type { AdminTheme, CustomTheme, ThemeColor } from './types.js'

export const DAISY_THEMES: readonly string[] = [
  'abyss', 'acid', 'aqua', 'autumn', 'black', 'bumblebee', 'business', 'caramellatte', 'cmyk', 'coffee',
  'corporate', 'cupcake', 'cyberpunk', 'dark', 'dim', 'dracula', 'emerald', 'fantasy', 'forest', 'garden',
  'halloween', 'lemonade', 'light', 'lofi', 'luxury', 'night', 'nord', 'pastel', 'retro', 'silk',
  'sunset', 'synthwave', 'valentine', 'winter', 'wireframe',
]

export interface ResolvedTheme {
  name: string
  css: string
}

export const INLAY_THEME: { scheme: 'light'; colors: Record<ThemeColor, string> } = {
  scheme: 'light',
  colors: {
    'base-100': '#ffffff',
    'base-200': '#f5f5f4',
    'base-300': '#e7e5e4',
    'base-content': '#1c1917',
    primary: '#1d4ed8',
    'primary-content': '#ffffff',
    secondary: '#475569',
    'secondary-content': '#ffffff',
    accent: '#0f766e',
    'accent-content': '#ffffff',
    neutral: '#292524',
    'neutral-content': '#fafaf9',
    info: '#0369a1',
    'info-content': '#ffffff',
    success: '#15803d',
    'success-content': '#ffffff',
    warning: '#fcd34d',
    'warning-content': '#292524',
    error: '#b91c1c',
    'error-content': '#ffffff',
  },
}

const INLAY_SHAPE = '--radius-box:.75rem;--radius-field:.5rem;--radius-selector:.5rem;--depth:0;--noise:0'

const COLOR_KEYS: ReadonlySet<string> = new Set(Object.keys(INLAY_THEME.colors))
const COLOR_VALUE = /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9a-zA-Z.,%\s/+-]*\))$/
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function invalid(value: string): InlayError {
  return new InlayError('config', 'config.adminTheme', { value })
}

function declarations(colors: Partial<Record<string, string>>): string {
  return Object.entries(colors)
    .map(([key, value]) => `--color-${key}:${value}`)
    .join(';')
}

export function resolveTheme(theme?: AdminTheme): ResolvedTheme {
  if (theme === undefined) {
    const css = `html[data-theme="inlay"]{color-scheme:${INLAY_THEME.scheme};${declarations(INLAY_THEME.colors)};${INLAY_SHAPE}}`
    return { name: 'inlay', css }
  }
  if (typeof theme === 'string') {
    if (!DAISY_THEMES.includes(theme)) throw invalid(theme)
    return { name: theme, css: '' }
  }
  const name = theme.base ?? 'inlay'
  if (name !== 'inlay' && !DAISY_THEMES.includes(name)) throw invalid(name)
  if (theme.scheme !== undefined && theme.scheme !== 'light' && theme.scheme !== 'dark') throw invalid(String(theme.scheme))
  for (const [key, value] of Object.entries(theme.colors)) {
    if (!COLOR_KEYS.has(key)) throw invalid(key)
    if (typeof value !== 'string' || !COLOR_VALUE.test(value)) throw invalid(String(value))
  }
  const custom = declarations(theme.colors)
  const scheme = theme.scheme === undefined ? '' : `color-scheme:${theme.scheme};`
  const rules: string[] = []
  if (name === 'inlay') {
    rules.push(`html[data-theme="inlay"]{color-scheme:${INLAY_THEME.scheme};${declarations(INLAY_THEME.colors)};${INLAY_SHAPE}}`)
  }
  if (custom !== '' || scheme !== '') {
    rules.push(`html[data-theme="${name}"]{${scheme}${custom}}`)
  }
  return { name, css: rules.join('') }
}

function parseHex(value: string): [number, number, number] | null {
  if (!HEX.test(value)) return null
  const h = value.slice(1)
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(a: string, b: string): number | null {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return null
  const la = luminance(ca)
  const lb = luminance(cb)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The text and background pairs that must reach 4.5:1: body text, each `X-content` on `X`, and the theme colors the
 * admin uses as text on the page (`text-primary` links, `text-error` problems and outline buttons).
 */
export const CONTRAST_PAIRS: ReadonlyArray<[ThemeColor, ThemeColor]> = [
  ['base-content', 'base-100'],
  ['base-content', 'base-200'],
  ['primary', 'base-100'],
  ['primary', 'base-200'],
  ['error', 'base-100'],
  ['error', 'base-200'],
  ['primary-content', 'primary'],
  ['secondary-content', 'secondary'],
  ['accent-content', 'accent'],
  ['neutral-content', 'neutral'],
  ['info-content', 'info'],
  ['success-content', 'success'],
  ['warning-content', 'warning'],
  ['error-content', 'error'],
]

export function themeContrastProblems(
  colors: Partial<Record<ThemeColor, string>>,
  base?: string,
): Array<{ pair: [ThemeColor, ThemeColor]; ratio: number }> {
  const all: Partial<Record<ThemeColor, string>> =
    base !== undefined && base !== 'inlay' ? colors : { ...INLAY_THEME.colors, ...colors }
  const problems: Array<{ pair: [ThemeColor, ThemeColor]; ratio: number }> = []
  for (const pair of CONTRAST_PAIRS) {
    const fg = all[pair[0]]
    const bg = all[pair[1]]
    if (fg === undefined || bg === undefined) continue
    const ratio = contrastRatio(fg, bg)
    if (ratio !== null && ratio < 4.5) problems.push({ pair, ratio })
  }
  return problems
}
