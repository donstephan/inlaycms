import { InlayError } from '../core/errors.js'
import { escapeHtml, SafeHtml, toHtml, type Html, type Renderable } from './html.js'

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
])
const ATTRIBUTE_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/

type Props = Record<string, unknown>
type Component = (props: any) => Renderable

export const Fragment = Symbol.for('inlay.fragment')

function renderAttributes(props: Props): string {
  let out = ''
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children') continue
    if (!ATTRIBUTE_NAME.test(name)) throw new InlayError('definition', 'definition.jsxAttribute', { name })
    if (value === false || value === null || value === undefined) continue
    if (value === true) out += ` ${name}`
    else out += ` ${name}="${escapeHtml(String(value))}"`
  }
  return out
}

function wrap(html: Html, before: string, after: string): Html {
  if (html instanceof SafeHtml) return new SafeHtml(before + html.value + after)
  return html.then((h) => new SafeHtml(before + h.value + after))
}

export function jsx(type: string | Component | typeof Fragment, props: Props | null, _key?: unknown): Html {
  const p = props ?? {}
  const children = p.children as Renderable
  if (type === Fragment) return toHtml(children)
  if (typeof type === 'function') return toHtml(type(p))
  const open = `<${type}${renderAttributes(p)}>`
  if (VOID_ELEMENTS.has(type)) return new SafeHtml(open)
  return wrap(toHtml(children), open, `</${type}>`)
}

export const jsxs = jsx

export namespace JSX {
  export type Element = Html
  export type ElementType = string | ((props: any) => Renderable)
  export interface ElementChildrenAttribute {
    children: {}
  }
  export interface IntrinsicElements {
    [tag: string]: Record<string, any>
  }
}
