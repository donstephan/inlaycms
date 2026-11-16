import type { z } from 'zod'

export type Schema = z.core.$ZodType

interface Check {
  _zod: { def: { check: string } }
}

/** The parts of a zod def that Inlay reads. */
export interface Def {
  type: string
  innerType?: Schema
  in?: Schema
  shape?: Record<string, Schema>
  element?: Schema
  options?: readonly Schema[]
  discriminator?: string
  checks?: Check[]
}

/** Schema types that wrap one inner schema. A pipe wraps its `in` side. */
export const WRAPPERS: ReadonlySet<string> = new Set([
  'optional',
  'default',
  'nullable',
  'prefault',
  'readonly',
  'catch',
  'pipe',
])

export const defOf = (s: Schema): Def => s._zod.def as unknown as Def

/** The schema `s` wraps, or `undefined` if it isn't a wrapper. */
export function innerOf(s: Schema): Schema | undefined {
  const def = defOf(s)
  if (!WRAPPERS.has(def.type)) return undefined
  return def.type === 'pipe' ? def.in : def.innerType
}

/** `s` with every wrapper removed. */
export function unwrap(s: Schema): Schema {
  let current = s
  for (let inner = innerOf(current); inner; inner = innerOf(current)) current = inner
  return current
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
