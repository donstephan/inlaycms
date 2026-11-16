import { z } from 'zod'
import { docLabels } from '../content/schema.js'
import { fieldRegistry, type FieldMeta } from '../fields/define.js'
import { t, type MessageId } from '../messages/index.js'
import type { Registry } from '../registry/registry.js'

interface Lookup {
  get(schema: object): FieldMeta | undefined
}

type Json = Record<string, unknown>

/** The JSON Schema `format` of date fields, and how the assistant should write them. */
const FORMAT: Partial<Record<string, { format: string; description: MessageId }>> = {
  date: { format: 'date', description: 'agent.date' },
  datetime: { format: 'date-time', description: 'agent.datetime' },
}

/** Title, description and `x-setting` for a field, plus its codec's schema in place of Zod's. */
function decorate(registry: Registry, meta: FieldMeta, json: Json): void {
  if (meta.agent) {
    for (const key of Object.keys(json)) delete json[key]
    Object.assign(json, structuredClone(meta.agent.schema))
  }
  json.title = meta.label
  const format = FORMAT[meta.kind]
  if (format) json.format = format.format
  // The codec's own description (what a rich-text field allows) comes first; the developer's help follows it.
  const own = meta.agent?.schema.description
  const description = [
    typeof own === 'string' ? own : undefined,
    format ? t(format.description) : undefined,
    meta.setting ? t('agent.setting') : undefined,
    meta.kind === 'ref' && meta.target !== undefined
      ? t('agent.refTarget', { label: registry.getType(meta.target).label })
      : undefined,
    meta.help,
  ].filter((part) => part !== undefined)
  if (description.length > 0) json.description = description.join(' ')
  if (meta.setting) json['x-setting'] = true
}

/**
 * The JSON Schema (draft 2020-12) of an `AgentDocument` of `type`, as the assistant
 * writes it: every field titled with its label and described with its help.
 */
export function agentTypeSchema(registry: Registry, type: string): Record<string, unknown> {
  const { template } = registry.getType(type)
  /** Metadata for schemas built here, which aren't fields. */
  const extra = new Map<object, Json>()
  const titled = <T extends z.ZodType>(schema: T, json: Json): T => {
    extra.set(schema, json)
    return schema
  }

  const shape: Record<string, z.ZodType> = {}
  for (const key of ['slug', 'path'] as const) {
    const labels = docLabels(registry, type, [key])
    if (labels) shape[key] = titled(z.string(), { title: labels.at(-1) }).optional()
  }
  shape.fields = template.fields.optional()
  const slots: Record<string, z.ZodType> = {}
  for (const [key, slot] of Object.entries(template.slots)) {
    const parts: Record<string, z.ZodType> = {}
    if (slot.optional) {
      parts.enabled = titled(z.boolean(), { title: t('label.slotShown'), description: t('agent.slotShown') }).optional()
    }
    parts.data = slot.block.schema
    slots[key] = titled(z.object(parts), {
      title: slot.label ?? slot.block.label,
      ...(slot.block.help !== undefined && { description: slot.block.help }),
    }).optional()
  }
  shape.slots = z.object(slots).optional()

  return z.toJSONSchema(z.object(shape), {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema }) => {
      const json = jsonSchema as Json
      const added = extra.get(zodSchema)
      if (added) {
        Object.assign(json, added)
        return
      }
      // Only the schema the registry holds, not its wrappers, which inherit from it.
      const meta = (fieldRegistry as unknown as Lookup).get(zodSchema)
      if (meta) decorate(registry, meta, json)
    },
  }) as Record<string, unknown>
}
