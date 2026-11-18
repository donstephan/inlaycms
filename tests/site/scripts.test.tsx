import { createHash } from 'node:crypto'
import { createScriptCollector } from '../../src/adapters/site/scripts.js'
import { createRenderContext } from '../../src/adapters/site/context.js'
import { js, JsCode } from '../../src/core/registry/js.js'
import { makeCore } from '../helpers/core.js'

const hash = (code: string) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`

describe('js', () => {
  it('writes interpolated values as escaped JSON', () => {
    const evil = '"</script><!-- \u2028'
    const out = js`init(${evil}, ${{ a: 1 }}, ${3})`
    expect(out).toBeInstanceOf(JsCode)
    expect(out.code).not.toContain('</script')
    expect(out.code).not.toContain('<!--')
    expect(out.code).not.toContain('\u2028')
    expect(new Function('init', `return ${out.code}`)((...a: unknown[]) => a)).toEqual([evil, { a: 1 }, 3])
  })

  it('throws for a value JSON cannot write', () => {
    expect(() => js`x(${undefined})`).toThrow()
    expect(() => js`x(${() => 1})`).toThrow()
    expect(() => js`x(${1n})`).toThrow()
  })
})

describe('script collector', () => {
  it('inline: returns the script element and records its hash', () => {
    const s = createScriptCollector()
    expect(s.api('console.log(1)').value).toBe('<script>console.log(1)</script>')
    expect(s.hashes()).toEqual([hash('console.log(1)')])
  })

  it('inline: accepts JsCode', () => {
    const s = createScriptCollector()
    expect(s.api(js`a(${'b'})`).value).toBe('<script>a("b")</script>')
    expect(s.hashes()).toEqual([hash('a("b")')])
  })

  it('inline: the same code twice is hashed once', () => {
    const s = createScriptCollector()
    s.api('a()')
    s.api('b()')
    s.api('a()')
    expect(s.hashes()).toEqual([hash('a()'), hash('b()')])
  })

  it('inline: code containing </script or <!-- throws', () => {
    const s = createScriptCollector()
    for (const code of ['a</script>', 'a</SCRIPT>', 'a<!--b']) {
      expect(() => s.api(code)).toThrow()
    }
    expect(s.hashes()).toEqual([])
  })

  it('inline: line breaks are written and hashed as the browser reads them', () => {
    const s = createScriptCollector()
    const out = s.api('a()\r\nb()\rc()\n').value
    expect(out).toBe('<script>a()\nb()\nc()\n</script>')
    const text = out.slice('<script>'.length, -'</script>'.length)
    expect(s.hashes()).toEqual([hash(text)])
    expect(s.hashes()).toEqual([hash('a()\nb()\nc()\n')])
  })

  it('inline: code containing NUL throws', () => {
    const s = createScriptCollector()
    for (const code of ['a()\u0000', 'b\u0000()']) {
      expect(() => s.api(code)).toThrow(expect.objectContaining({ messageId: 'config.scriptCode' }))
    }
    expect(s.hashes()).toEqual([])
  })

  it('external: writes src, async, defer and type, and records no hash', () => {
    const s = createScriptCollector()
    expect(s.api({ src: 'https://x.example/a.js', async: true }).value).toBe('<script src="https://x.example/a.js" async></script>')
    expect(s.api({ src: '/public/a.js', defer: true, type: 'module' }).value).toBe(
      '<script type="module" src="/public/a.js" defer></script>',
    )
    expect(s.api({ src: '/a.js?x=1&y="2"' }).value).toBe('<script src="/a.js?x=1&amp;y=&quot;2&quot;"></script>')
    expect(s.hashes()).toEqual([])
  })

  it('external: an unsafe src throws', () => {
    const s = createScriptCollector()
    for (const src of ['javascript:alert(1)', '//x.example/a.js', 'http://x.example/a.js', 'data:text/javascript,1']) {
      expect(() => s.api({ src }), src).toThrow()
    }
  })
})

it('ctx.script is on the render context and feeds scriptHashes()', async () => {
  const { core } = await makeCore()
  const ctx = createRenderContext(core, { locale: 'en', state: 'published', page: 1, baseUrl: 'https://example.com', alternates: [] })
  expect(ctx.script('go()').value).toBe('<script>go()</script>')
  expect(ctx.scriptHashes()).toEqual([hash('go()')])
})
