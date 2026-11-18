import type { z } from 'zod'
import { z as zod } from 'zod'
import type { Renderable } from '../../jsx/html.js'
import type { ScriptApi } from './render.js'

export const CONSENT_CATEGORIES = ['analytics', 'marketing', 'functional'] as const
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number]

export const CSP_DIRECTIVES = [
  'script-src',
  'style-src',
  'img-src',
  'font-src',
  'connect-src',
  'frame-src',
  'media-src',
  'form-action',
  'worker-src',
] as const
export type CspDirective = (typeof CSP_DIRECTIVES)[number]

/** Sources a site or integration adds to the Content-Security-Policy, by directive. */
export type CspSources = Partial<Record<CspDirective, readonly string[]>>

export interface IntegrationPage {
  path: string
  locale: string
  preview: boolean
  /** Writes an inline script the page's Content-Security-Policy allows. */
  script: ScriptApi
}

export type IntegrationRender<V> = (values: V, page: IntegrationPage) => Renderable

export interface IntegrationDef<T extends z.ZodObject = z.ZodObject> {
  kind: 'integration'
  name: string
  label: string
  description?: string
  /** What the owner fills in; `z.object({})` when the integration has none. */
  fields: T
  /** When set, the integration's output stays inert until the visitor agrees to this category. */
  consent?: ConsentCategory
  /** Also render in the admin's preview (default `false`). */
  preview: boolean
  csp: CspSources
  head?: IntegrationRender<z.output<T>>
  bodyStart?: IntegrationRender<z.output<T>>
  bodyEnd?: IntegrationRender<z.output<T>>
}

export interface IntegrationInput<T extends z.ZodObject> {
  name: string
  label: string
  description?: string
  fields?: T
  consent?: ConsentCategory
  preview?: boolean
  csp?: CspSources
  head?: IntegrationRender<z.output<T>>
  bodyStart?: IntegrationRender<z.output<T>>
  bodyEnd?: IntegrationRender<z.output<T>>
}

export function defineIntegration<T extends z.ZodObject = z.ZodObject>(def: IntegrationInput<T>): IntegrationDef<T> {
  return {
    ...def,
    kind: 'integration',
    fields: def.fields ?? (zod.object({}) as unknown as T),
    preview: def.preview ?? false,
    csp: def.csp ?? {},
  }
}

const KEYWORDS = new Set(["'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'"])
const SCHEME = /^[a-z][a-z0-9+.-]*:$/
const ORIGIN = /^(https?|wss?):\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d+)?$/

/** True for a Content-Security-Policy source Inlay accepts: a keyword, a bare scheme or an origin. */
export function isCspSource(source: string): boolean {
  return typeof source === 'string' && (KEYWORDS.has(source) || SCHEME.test(source) || ORIGIN.test(source))
}
