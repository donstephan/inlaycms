import { en } from './en.js'

export type MessageId = keyof typeof en

/**
 * The message `id` with `{name}` replaced by `params.name`. `{name|one|other}` gives `one` when the param is 1
 * and `other` otherwise, for words that follow a count ("{count} {count|item|items}").
 */
export function t(id: MessageId, params: Record<string, string | number> = {}): string {
  return en[id].replace(/\{(\w+)(?:\|([^|{}]*)\|([^|{}]*))?\}/g, (_, name: string, one?: string, other?: string) => {
    if (!(name in params)) throw new Error(`Message "${id}" is missing param "${name}"`)
    if (one !== undefined && other !== undefined) return Number(params[name]) === 1 ? one : other
    return String(params[name])
  })
}
