import { defOf } from '../fields/zod-internals.js'
import type { TemplateDef } from './define.js'

/**
 * True when `template` has no fields and no slots: a page designed in code, whose words are all in the template.
 * The admin and MCP say so instead of offering an empty form.
 */
export function designedInCode(template: TemplateDef): boolean {
  return Object.keys(defOf(template.fields).shape ?? {}).length === 0 && Object.keys(template.slots).length === 0
}
