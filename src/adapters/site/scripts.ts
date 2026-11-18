import { createHash } from 'node:crypto'
import { InlayError } from '../../core/errors.js'
import { isSafeUrl } from '../../core/fields/define.js'
import { JsCode } from '../../core/registry/js.js'
import type { ScriptApi } from '../../core/registry/render.js'
import { escapeHtml, raw } from '../../jsx/html.js'

const UNSAFE_CODE = /<\/script|<!--/i

/** The `ctx.script` of one render, and the `'sha256-…'` hashes of the inline scripts it wrote, in call order. */
export function createScriptCollector(): { api: ScriptApi; hashes(): string[] } {
  const hashes = new Set<string>()
  const api: ScriptApi = (input) => {
    if (typeof input === 'string' || input instanceof JsCode) {
      // the browser hashes the text as it parsed it: line breaks as \n, and NUL replaced, so NUL is refused
      const code = (typeof input === 'string' ? input : input.code).replace(/\r\n?/g, '\n')
      if (UNSAFE_CODE.test(code) || code.includes('\u0000')) throw new InlayError('config', 'config.scriptCode')
      hashes.add(`'sha256-${createHash('sha256').update(code).digest('base64')}'`)
      return raw(`<script>${code}</script>`)
    }
    const { src } = input
    const ok = isSafeUrl(src) && (/^https:\/\//i.test(src) || (src.startsWith('/') && !src.startsWith('//')))
    if (!ok) throw new InlayError('config', 'config.scriptSrc', { src })
    const type = input.type === 'module' ? ' type="module"' : ''
    return raw(
      `<script${type} src="${escapeHtml(src)}"${input.async ? ' async' : ''}${input.defer ? ' defer' : ''}></script>`,
    )
  }
  return { api, hashes: () => [...hashes] }
}
