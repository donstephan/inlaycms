import { InlayError } from '../errors.js'

const SCRIPT_UNSAFE: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

/** `value` as JSON that can't end its `<script>` or open an HTML comment in it. */
export function scriptJson(value: unknown): string {
  const json = JSON.stringify(value) as string | undefined
  if (json === undefined) throw new InlayError('config', 'config.headJsonLd')
  return json.replace(/[<>&\u2028\u2029]/g, (c) => SCRIPT_UNSAFE[c]!)
}

/** Script code written with `js`, safe to put between `<script>` and `</script>`. */
export class JsCode {
  readonly code: string

  constructor(code: string) {
    this.code = code
  }
}

/** A template tag for script code: each value is written as JSON, so it stays data whatever it contains. */
export function js(strings: TemplateStringsArray, ...values: unknown[]): JsCode {
  let code = strings[0] ?? ''
  values.forEach((value, i) => {
    let json: string | undefined
    try {
      json = JSON.stringify(value) as string | undefined
    } catch {
      json = undefined
    }
    if (json === undefined) throw new InlayError('config', 'config.scriptValue', { position: i + 1 })
    code += scriptJson(value) + (strings[i + 1] ?? '')
  })
  return new JsCode(code)
}
