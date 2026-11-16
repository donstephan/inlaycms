import type { ContentInput } from '../types.js'
import type { TemplateDef } from './define.js'
import type { RenderContext } from './render.js'

export type RouteMethod = 'GET' | 'POST'

export interface RouteRequest {
  method: RouteMethod
  path: string
  query: Record<string, string>
  /** Lower-cased, without `cookie` and `authorization`: routes are anonymous. */
  headers: Record<string, string>
  /** Form fields for a urlencoded body, parsed JSON for a JSON body, `null` otherwise. */
  body: Record<string, string> | unknown | null
  /** The `locale` query or form field when it names a site locale, else the default locale. */
  locale: string
}

export interface RouteResponse {
  /** Defaults to 200, or 204 when neither `body` nor `json` is given. */
  status?: number
  headers?: Record<string, string>
  body?: string
  /** Wins over `body`. */
  json?: unknown
}

/** Published content only. */
export type QueryApi = Pick<RenderContext, 'query' | 'global' | 'entries'>

export interface RouteContext {
  query: QueryApi
  render(template: TemplateDef, data?: ContentInput, opts?: { status?: number }): Promise<RouteResponse>
  fetch: typeof fetch
  secrets: Readonly<Record<string, string>>
  redirect(location: string, status?: 302 | 303): RouteResponse
  baseUrl: string
  locale: string
}

export interface RouteDef {
  method: RouteMethod
  path: string
  handler: (request: RouteRequest, ctx: RouteContext) => Promise<RouteResponse> | RouteResponse
}

export function defineRoute(def: RouteDef): RouteDef {
  return def
}
