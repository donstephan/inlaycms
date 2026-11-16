import { InlayError } from '../../src/core/errors.js'
import { html, raw, renderToString, SafeHtml, toHtml } from '../../src/jsx/html.js'
import { jsx } from '../../src/jsx/jsx-runtime.js'

describe('jsx runtime', () => {
  it('escapes string children', async () => {
    expect(await renderToString(<p>{'<script>alert(1)</script>'}</p>)).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
  })

  it('escapes attribute values', async () => {
    expect(await renderToString(<a href={'"><img onerror=x>'}>x</a>)).toBe(
      '<a href="&quot;&gt;&lt;img onerror=x&gt;">x</a>',
    )
  })

  it('renders boolean and numeric attributes, void elements', async () => {
    expect(await renderToString(<input disabled={true} value={0} hidden={false} />)).toBe(
      '<input disabled value="0">',
    )
  })

  it('trusts raw and does not double-escape nested elements', async () => {
    expect(await renderToString(<div>{raw('<b>x</b>')}</div>)).toBe('<div><b>x</b></div>')
    expect(await renderToString(<ul>{['a<', 'b'].map((x) => <li>{x}</li>)}</ul>)).toBe(
      '<ul><li>a&lt;</li><li>b</li></ul>',
    )
  })

  it('drops nullish and boolean children in fragments', async () => {
    expect(await renderToString(<>{null}{false}{undefined}{0}</>)).toBe('0')
  })

  it('supports async components and stays sync otherwise', async () => {
    const A = async () => <b>hi</b>
    expect(await renderToString(<div><A /></div>)).toBe('<div><b>hi</b></div>')
    expect(toHtml(<div>x</div>)).toBeInstanceOf(SafeHtml)
  })

  it('rejects invalid attribute names', () => {
    expect(() => jsx('div', { 'on click': 'x' })).toThrow(InlayError)
    try {
      jsx('div', { 'on click': 'x' })
    } catch (e) {
      expect((e as InlayError).code).toBe('definition')
    }
  })

  it('html escapes interpolations, trusts SafeHtml and stays sync', () => {
    const out = html`<p>${'<b>'}</p>${raw('<i>x</i>')}`
    expect(out).toBeInstanceOf(SafeHtml)
    expect(out.value).toBe('<p>&lt;b&gt;</p><i>x</i>')
    expect(html`<ul>${['a<', html`<li>${1}</li>`, null, false]}</ul>`.value).toBe('<ul>a&lt;<li>1</li></ul>')
  })

  it('html rejects a Promise value', () => {
    expect(() => html`<p>${Promise.resolve('x')}</p>`).toThrow()
    expect(() => html`<p>${[Promise.resolve('x')]}</p>`).toThrow()
  })
})
