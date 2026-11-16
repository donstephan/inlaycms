import { InlayError } from '../core/errors.js'

export class SafeHtml {
  readonly value: string

  constructor(value: string) {
    this.value = value
  }

  toString(): string {
    return this.value
  }
}

export type Html = SafeHtml | Promise<SafeHtml>

export type Renderable =
  | SafeHtml
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Renderable[]
  | Promise<Renderable>

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

export function raw(html: string): SafeHtml {
  return new SafeHtml(html)
}

function isPromise(x: unknown): x is Promise<unknown> {
  return typeof x === 'object' && x !== null && typeof (x as { then?: unknown }).then === 'function'
}

export function toHtml(node: Renderable): Html {
  if (node instanceof SafeHtml) return node
  if (isPromise(node)) return node.then((v) => toHtml(v as Renderable))
  if (typeof node === 'string') return new SafeHtml(escapeHtml(node))
  if (typeof node === 'number') return new SafeHtml(escapeHtml(String(node)))
  if (node === null || node === undefined || typeof node === 'boolean') return new SafeHtml('')
  if (Array.isArray(node)) {
    const parts = (node as readonly Renderable[]).map((child) => toHtml(child))
    if (parts.some(isPromise)) {
      return Promise.all(parts).then((done) => new SafeHtml(done.map((p) => p.value).join('')))
    }
    return new SafeHtml((parts as SafeHtml[]).map((p) => p.value).join(''))
  }
  return new SafeHtml(escapeHtml(String(node)))
}

export async function renderToString(node: Renderable): Promise<string> {
  return (await toHtml(node)).value
}

/**
 * A tagged template for Inlay's own pages: interpolations are escaped, `SafeHtml` is kept as is, and arrays are
 * joined. It is synchronous, so a Promise anywhere in a value throws.
 */
export function html(strings: TemplateStringsArray, ...values: Renderable[]): SafeHtml {
  let out = strings[0] ?? ''
  values.forEach((value, i) => {
    const part = toHtml(value)
    if (isPromise(part)) {
      part.catch(() => undefined)
      throw new InlayError('definition', 'definition.htmlPromise')
    }
    out += part.value + (strings[i + 1] ?? '')
  })
  return new SafeHtml(out)
}
