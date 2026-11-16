// @vitest-environment happy-dom
// happy-dom has no XPathEvaluator, which htmx creates when it loads (to find `hx-on` attributes).
vi.hoisted(() => {
  Object.assign(globalThis, {
    XPathEvaluator: class {
      createExpression() {
        return { evaluate: () => ({ iterateNext: () => null }) }
      }
    },
  })
})

import { applyPick, clearField, removeChip } from '../../client/admin/picker.js'
import type { AgentRefs, AdminWidget } from '../../src/core/fields/define.js'
import { fieldMeta } from '../../src/core/fields/define.js'
import { imageWidget, refsWidget } from '../../src/core/fields/widgets.js'
import { f } from '../../src/core/fields/builtins.js'
import { renderToString } from '../../src/jsx/html.js'

const refs: AgentRefs = {
  document: () => null,
  media: () => ({ status: 'unknown' }),
  mediaUrl: (id) => `/media/${id}`,
}

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const SHA = 'c'.repeat(64)

async function mount(widget: AdminWidget, name: string, schema: Parameters<typeof fieldMeta>[0], value: unknown): Promise<HTMLElement> {
  const html = await renderToString(
    widget.render({
      name,
      id: `f-${name.replaceAll('.', '-')}`,
      value,
      meta: fieldMeta(schema)!,
      optional: true,
      readOnly: false,
      describedBy: undefined,
      invalid: false,
      refs,
      locale: 'en',
    }),
  )
  document.body.innerHTML = `<form>${html}</form>`
  return document.querySelector<HTMLElement>(`[data-name="${name}"]`)!
}

const hidden = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)].map((i) => i.value)

describe('picker client', () => {
  it('sets a single image field and shows its name and thumbnail', async () => {
    const field = await mount(imageWidget, 'fields.hero', f.image({ label: 'Hero' }), undefined)
    applyPick(field, { value: SHA, label: 'photo.jpg', thumb: `/media/${SHA}/320.webp` })
    expect(document.querySelector<HTMLInputElement>('input[name="fields.hero.media"]')!.value).toBe(SHA)
    expect(field.textContent).toContain('photo.jpg')
    const img = field.querySelector('img')!
    expect(img.getAttribute('src')).toBe(`/media/${SHA}/320.webp`)
    expect(img.hidden).toBe(false)

    clearField(field)
    expect(document.querySelector<HTMLInputElement>('input[name="fields.hero.media"]')!.value).toBe('')
    expect(field.textContent).not.toContain('photo.jpg')
    expect(img.hidden).toBe(true)
  })

  it('adds chips to a many-reference field in order, ignoring repeats, and removes them', async () => {
    const field = await mount(refsWidget, 'fields.quotes', f.ref('testimonials', { label: 'Quotes', many: true }), [])
    applyPick(field, { value: A, label: 'María' })
    applyPick(field, { value: B, label: 'Sam' })
    applyPick(field, { value: A, label: 'María' })
    expect(hidden('fields.quotes')).toEqual([A, B])
    const removes = [...field.querySelectorAll<HTMLButtonElement>('[data-picker-remove]')]
    expect(removes.map((b) => b.getAttribute('aria-label'))).toEqual(['Remove María', 'Remove Sam'])
    expect(field.textContent).toContain('María')

    removeChip(removes[0]!)
    expect(hidden('fields.quotes')).toEqual([B])
    expect(field.textContent).not.toContain('María')
  })

  it('fires a bubbling change event when a pick changes a hidden input', async () => {
    const seen: string[] = []
    const listen = (event: Event) => {
      const target = event.target
      if (target instanceof HTMLInputElement && target.type === 'hidden') seen.push(`${target.name}=${target.value}`)
    }
    document.addEventListener('change', listen)
    try {
      const single = await mount(imageWidget, 'fields.hero', f.image({ label: 'Hero' }), undefined)
      applyPick(single, { value: SHA, label: 'photo.jpg' })
      clearField(single)
      expect(seen).toEqual([`fields.hero.media=${SHA}`, 'fields.hero.media='])

      seen.length = 0
      const many = await mount(refsWidget, 'fields.quotes', f.ref('testimonials', { label: 'Quotes', many: true }), [])
      applyPick(many, { value: A, label: 'María' })
      applyPick(many, { value: B, label: 'Sam' })
      removeChip(many.querySelector<HTMLElement>('[data-picker-remove]')!)
      clearField(many)
      expect(seen).toEqual([`fields.quotes=${A}`, `fields.quotes=${B}`, `fields.quotes=${A}`, `fields.quotes=${B}`])
    } finally {
      document.removeEventListener('change', listen)
    }
  })
})
