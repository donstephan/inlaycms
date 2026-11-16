import { z } from 'zod'
import { docLabels, documentSchema } from '../content/schema.js'
import { fieldRegistry, type FieldMeta } from '../fields/define.js'
import type { Registry } from '../registry/registry.js'

interface Lookup {
  get(schema: object): FieldMeta | undefined
}

type Json = Record<string, unknown>

/**
 * The JSON Schema (draft 2020-12) of a document of `type` as it is stored:
 * every field titled with its label and described with its help.
 */
export function storedTypeSchema(registry: Registry, type: string): Record<string, unknown> {
  const { template } = registry.getType(type)
  const json = z.toJSONSchema(documentSchema(registry, type, 'strict'), {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema }) => {
      const meta = (fieldRegistry as unknown as Lookup).get(zodSchema)
      if (!meta) return
      const out = jsonSchema as Json
      out.title = meta.label
      if (meta.help !== undefined) out.description = meta.help
      if (meta.setting) out['x-setting'] = true
    },
  }) as Json

  const props = (json.properties ?? {}) as Record<string, Json>
  for (const key of ['slug', 'path'] as const) {
    const labels = docLabels(registry, type, [key])
    const prop = props[key]
    if (labels && prop) prop.title = labels.at(-1)
  }
  const slots = (props.slots?.properties ?? {}) as Record<string, Json>
  for (const [key, slot] of Object.entries(template.slots)) {
    const prop = slots[key]
    if (!prop) continue
    prop.title = slot.label ?? slot.block.label
    if (slot.block.help !== undefined) prop.description = slot.block.help
  }
  return json
}

/** The stored-shape JSON Schema of every type in `registry`, by type name. */
export function typeSchemas(registry: Registry): Record<string, unknown> {
  return Object.fromEntries([...registry.types.keys()].map((name) => [name, storedTypeSchema(registry, name)]))
}
