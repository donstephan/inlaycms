import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { applyFormOp, DocumentFields, formId, formNames, parseDocumentForm, placeIssues, readOpenState, remapOpen, type FormContext } from '../../src/adapters/admin/form/walk.js'
import { validateContent } from '../../src/core/content/validate.js'
import { defineField, fieldMeta, type AgentRefs, type FormValues } from '../../src/core/fields/define.js'
import { f } from '../../src/core/fields/builtins.js'
import { richTextWidget } from '../../src/core/fields/widgets.js'
import { defineBlock, defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { buildRegistry } from '../../src/core/registry/registry.js'
import type { ContentIssue, DocumentData } from '../../src/core/types.js'
import { renderToString } from '../../src/jsx/html.js'
import { jsx } from '../../src/jsx/jsx-runtime.js'
import { adminSite } from '../fixtures/admin.js'
import { megaMenuSite } from '../fixtures/mega-menu.js'
import { parseHtml, submittedForm } from '../helpers/admin.js'
import { makeApp } from '../helpers/app.js'

const registry = buildRegistry(adminSite)

const refs: AgentRefs = {
  document: () => null,
  media: () => ({ status: 'unknown' }),
  mediaUrl: (id) => `/media/${id}`,
}

const SHA = 'a'.repeat(64)
const FILE_SHA = 'b'.repeat(64)
const MARIA = '11111111-1111-4111-8111-111111111111'
const JUAN = '22222222-2222-4222-8222-222222222222'
const ABOUT = '33333333-3333-4333-8333-333333333333'

const stored = (): DocumentData => ({
  fields: {
    title: 'Kitchen',
    intro: 'Line one\nLine two',
    count: 3.5,
    featured: true,
    tone: 'bold',
    topics: ['news', 'events'],
    day: '2026-03-01',
    at: '2026-03-01T11:30:00.000+02:00',
    contact: { email: 'a@example.com', phone: '555' },
    faq: [
      { question: 'Why?', answer: 'Because.' },
      { question: 'How?', answer: 'Like this.' },
    ],
    seo: { title: 'SEO title', description: 'SEO description', image: { media: SHA, alt: 'Alt' } },
    custom: { x: 1 },
    hero: { media: SHA, alt: 'Hero alt' },
    doc: { media: FILE_SHA },
    quote: MARIA,
    quotes: [MARIA, JUAN],
    cta: { document: ABOUT, text: 'Read about us' },
    more: { url: 'https://example.com/more', text: 'More' },
    body: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'text', text: 'about us', marks: [{ type: 'link', attrs: { document: ABOUT } }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'this', marks: [{ type: 'link', attrs: { href: 'https://example.com/' } }, { type: 'bold' }] },
            { type: 'image', attrs: { media: SHA, alt: 'A picture' } },
          ],
        },
      ],
    },
  },
  slots: { extra: { enabled: false, data: { text: 'kept' } } },
})

const ctxOf = (over: Partial<FormContext> = {}): FormContext => ({
  registry,
  type: 'kitchen',
  locale: 'en',
  refs,
  action: '/admin/documents/doc-1',
  ...over,
})

async function render(data: DocumentData, over: Partial<FormContext> = {}): Promise<string> {
  const fields = await renderToString(jsx(DocumentFields, { ctx: ctxOf(over), data }))
  return `<form id="editor-form" method="post">${fields}</form>`
}

function valuesOf(params: URLSearchParams): FormValues {
  return {
    get: (name) => params.get(name) ?? undefined,
    all: (name) => params.getAll(name),
    names: () => [...new Set(params.keys())],
  }
}

const roundTrip = async (data: DocumentData, edit?: (p: URLSearchParams) => void) => {
  const params = submittedForm(await render(data))
  edit?.(params)
  return parseDocumentForm(registry, 'kitchen', valuesOf(params))
}

const issue = (path: ContentIssue['path'], code: ContentIssue['code'] = 'invalid'): ContentIssue => ({
  path,
  labels: [],
  code,
  message: `Problem at ${path.join('.')}`,
})

describe('admin form engine', () => {
  it('gives back the stored data when the form is submitted untouched', async () => {
    const data = stored()
    const parsed = await roundTrip(data)
    expect(parsed).toEqual(data)
    expect(isDeepStrictEqual(parsed, data)).toBe(true)
  })

  it('keeps a switched-on slot and absent optional values', async () => {
    const data: DocumentData = {
      fields: { title: 'Only', featured: false, tone: 'calm', contact: { email: '' }, faq: [], quotes: [] },
      slots: { extra: { enabled: true, data: { text: 'Shown' } } },
    }
    expect(isDeepStrictEqual(await roundTrip(data), data)).toBe(true)
  })

  it('round-trips media, references and links', async () => {
    const parsed = await roundTrip(stored(), (p) => p.delete('fields.quotes', JUAN))
    expect(parsed.fields.quotes).toEqual([MARIA])
    expect(parsed.fields.cta).toEqual({ document: ABOUT, text: 'Read about us' })
    expect(parsed.fields.more).toEqual({ url: 'https://example.com/more', text: 'More' })

    const data = stored()
    data.fields.hero = { media: SHA }
    const noAlt = await roundTrip(data)
    expect(noAlt.fields.hero).toEqual({ media: SHA })
    expect(Object.hasOwn(noAlt.fields.hero as object, 'alt')).toBe(false)
    expect(isDeepStrictEqual(noAlt, data)).toBe(true)

    delete data.fields.quotes
    expect(Object.hasOwn((await roundTrip(data)).fields, 'quotes')).toBe(false)
  })

  it('edits a multi-select as checkboxes and keeps the options\' order', async () => {
    const doc = parseHtml(await render(stored()))
    const boxes = [...doc.querySelectorAll('input[type="checkbox"][name="fields.topics"]')]
    expect(boxes.map((b) => b.getAttribute('value'))).toEqual(['news', 'tips', 'events'])
    expect(boxes.map((b) => b.hasAttribute('checked'))).toEqual([true, false, true])
    expect(boxes.map((b) => b.closest('label')?.textContent)).toEqual(['news', 'tips', 'events'])
    expect(boxes[0]!.getAttribute('id')).toBe(formId('fields.topics'))
    expect(new Set(boxes.map((b) => b.getAttribute('id'))).size).toBe(3)
    expect(boxes[0]!.closest('fieldset')!.querySelector('legend')!.textContent).toContain('Topics')

    const parsed = await roundTrip(stored(), (p) => {
      p.delete('fields.topics')
      p.append('fields.topics', 'tips')
      p.append('fields.topics', 'news')
    })
    expect(parsed.fields.topics).toEqual(['tips', 'news'])
    const saved = validateContent(registry, 'kitchen', parsed, 'draft')
    expect(saved.ok).toBe(true)
    if (saved.ok) expect(saved.data.fields.topics).toEqual(['news', 'tips'])
  })

  it('stores an empty multi-select as []', async () => {
    const parsed = await roundTrip(stored(), (p) => p.delete('fields.topics'))
    expect(parsed.fields.topics).toEqual([])

    const data = stored()
    delete data.fields.topics
    const doc = parseHtml(await render(data))
    expect(doc.querySelector('input[name="fields.topics.many"]')).toBeNull()
    expect(Object.hasOwn((await roundTrip(data)).fields, 'topics')).toBe(false)
  })

  it('reads empty pickers as absent, and links by the chosen mode', async () => {
    const parsed = await roundTrip(stored(), (p) => {
      p.set('fields.hero.media', '')
      p.set('fields.doc.media', '')
      p.set('fields.quote', '')
      p.delete('fields.quotes')
      p.set('fields.more.mode', 'document')
      p.set('fields.cta.mode', 'url')
    })
    for (const key of ['hero', 'doc', 'quote', 'more', 'cta']) expect(Object.hasOwn(parsed.fields, key), key).toBe(false)
    expect(parsed.fields.quotes).toEqual([])

    const url = await roundTrip(stored(), (p) => {
      p.set('fields.cta.mode', 'url')
      p.set('fields.cta.url', '/blog')
      p.set('fields.cta.text', '')
    })
    expect(url.fields.cta).toEqual({ url: '/blog' })
  })

  it('shows chosen media, entries and pages by name, and missing ones as missing', async () => {
    const present: AgentRefs = {
      document: (id) => (id === MARIA ? { title: 'María', url: null } : null),
      media: (id) =>
        id === SHA
          ? {
              status: 'present',
              media: { id, filename: 'hero.jpg', mime: 'image/jpeg', size: 1, width: 1, height: 1, defaultAlt: 'Default alt', createdBy: 'Olivia', createdAt: '2026-01-01T00:00:00Z' },
            }
          : { status: 'deleted', filename: 'report.pdf', deletedAt: '2026-10-03T00:00:00Z' },
      mediaUrl: (id) => `/media/${id}`,
    }
    const doc = parseHtml(await render(stored(), { refs: present }))
    const hero = doc.querySelector('[data-name="fields.hero"]')!
    expect(hero.getAttribute('data-picker')).toBe('/admin/pick/media?kind=image')
    expect(hero.querySelector('img')!.getAttribute('src')).toBe(`/media/${SHA}/320.webp`)
    expect(hero.textContent).toContain('hero.jpg')
    expect(doc.querySelector('input[name="fields.hero.alt"]')!.getAttribute('placeholder')).toBe('Default alt')

    const file = doc.querySelector('[data-name="fields.doc"]')!
    expect(file.getAttribute('data-picker')).toBe('/admin/pick/media?kind=file')
    const missing = file.querySelector('.text-warning-content')!
    expect(missing.textContent).toContain('Missing: report.pdf (deleted Oct 3, 2026)')

    const quotes = doc.querySelector('[data-name="fields.quotes"]')!
    expect(quotes.hasAttribute('data-many')).toBe(true)
    expect(quotes.getAttribute('data-picker')).toBe('/admin/pick/entries?collection=testimonials&locale=en')
    const removes = [...quotes.querySelectorAll('[data-picker-remove]')]
    expect(removes.map((b) => b.getAttribute('aria-label'))).toEqual(['Remove María', expect.stringContaining('Remove')])
    expect(quotes.textContent).toContain('no longer exists')
    expect(quotes.querySelector('template')).not.toBeNull()

    const quote = doc.querySelector('[data-name="fields.quote"]')!
    expect(quote.hasAttribute('data-many')).toBe(false)
    expect(quote.querySelector('[data-picker-clear]')).not.toBeNull()

    const cta = doc.querySelector('[data-name="fields.cta.document"]')!
    expect(cta.getAttribute('data-picker')).toBe('/admin/pick/documents?locale=en')
  })

  it('never puts an unsafe link address in an href', async () => {
    const data = stored()
    data.fields.more = { url: 'javascript:alert(1)' }
    const html = await render(data)
    const doc = parseHtml(html)
    expect(doc.querySelector('input[name="fields.more.url"]')!.getAttribute('value')).toBe('javascript:alert(1)')
    expect(doc.querySelector('[href^="javascript"]')).toBeNull()
    expect((await roundTrip(data)).fields.more).toEqual({ url: 'javascript:alert(1)' })
  })

  it('shows a character counter, and the hint past the suggested length', async () => {
    const data = stored()
    data.fields.seo = { title: 'x'.repeat(96), description: 'short' }
    const doc = parseHtml(await render(data))
    const titleInput = doc.querySelector('[name="fields.seo.title"]')!
    const title = doc.querySelector(`[data-length-for="${titleInput.id}"]`)!
    expect(title.querySelector('[data-length-count]')!.textContent).toContain('96 of 70')
    expect(title.querySelector('[data-length-hint]')!.hasAttribute('hidden')).toBe(false)
    expect(titleInput.getAttribute('aria-describedby')).toContain(title.id)
    const descInput = doc.querySelector('[name="fields.seo.description"]')!
    const desc = doc.querySelector(`[data-length-for="${descInput.id}"]`)!
    expect(desc.querySelector('[data-length-count]')!.textContent).toContain('5 of 160')
    expect(desc.querySelector('[data-length-hint]')!.hasAttribute('hidden')).toBe(true)
    expect(descInput.getAttribute('aria-describedby')).toContain(desc.id)
    const plain = doc.querySelector('[name="fields.title"]')!
    expect(doc.querySelector(`[data-length-for="${plain.id}"]`)).toBeNull()
  })

  it('puts settings and SEO in their own collapsed areas', async () => {
    const doc = parseHtml(await render(stored()))
    const tone = doc.querySelector('select[name="fields.tone"]')!
    const settings = tone.closest('details')!
    expect(settings.querySelector('summary')!.textContent).toContain('Settings')
    const seo = doc.querySelector('[name="fields.seo.title"]')!.closest('details')!
    expect(seo).not.toBe(settings)
    expect(seo.querySelector('summary')!.textContent).toContain('Search engines')
    expect(doc.querySelector('input[name="fields.title"]')!.closest('details:not([data-card])')).toBeNull()
  })

  it('shows an optional slot with an on/off checkbox, and keeps a switched-off slot inside a collapsed area', async () => {
    const doc = parseHtml(await render(stored()))
    const toggle = doc.querySelector('input[name="slots.extra.enabled"]')!
    expect(toggle.getAttribute('type')).toBe('checkbox')
    expect(toggle.hasAttribute('checked')).toBe(false)
    const section = toggle.closest('details[data-card]')!
    expect(section.querySelector('h2')!.textContent).toBe('Note')
    expect(section.textContent).toContain('A short note at the end of the page.')
    const text = section.querySelector('input[name="slots.extra.data.text"]')!
    expect(text.closest('details')).not.toBeNull()
    expect(text.getAttribute('value')).toBe('kept')
  })

  it('reads numbers, keeping what is not a number for validation to report', async () => {
    const bad = await roundTrip(stored(), (p) => p.set('fields.count', '12abc'))
    expect(bad.fields.count).toBe('12abc')
    const empty = await roundTrip(stored(), (p) => p.set('fields.count', ''))
    expect(Object.hasOwn(empty.fields, 'count')).toBe(false)
  })

  it('edits datetimes in UTC and keeps the stored text when unchanged', async () => {
    const html = await render(stored())
    const input = parseHtml(html).querySelector('input[name="fields.at"]')!
    expect(input.getAttribute('type')).toBe('datetime-local')
    expect(input.getAttribute('step')).toBe('1')
    expect(input.getAttribute('value')).toBe('2026-03-01T09:30:00')
    expect(parseHtml(html).querySelector(`label[for="${input.id}"]`)!.textContent).toContain('UTC')

    expect((await roundTrip(stored())).fields.at).toBe('2026-03-01T11:30:00.000+02:00')
    expect((await roundTrip(stored(), (p) => p.set('fields.at', '2026-03-01T10:00:05'))).fields.at).toBe('2026-03-01T10:00:05Z')
    expect((await roundTrip(stored(), (p) => p.set('fields.at', '2026-03-01T10:00'))).fields.at).toBe('2026-03-01T10:00:00Z')
    expect((await roundTrip(stored(), (p) => p.set('fields.at', '2026-02-30T10:00:00'))).fields.at).toBe('2026-02-30T10:00:00')
    expect(Object.hasOwn((await roundTrip(stored(), (p) => p.set('fields.at', ''))).fields, 'at')).toBe(false)
  })

  it('reads an unchecked box as false and an empty optional text as absent', async () => {
    const parsed = await roundTrip(stored(), (p) => {
      p.delete('fields.featured')
      p.set('fields.intro', '')
      p.set('fields.title', '')
    })
    expect(parsed.fields.featured).toBe(false)
    expect(Object.hasOwn(parsed.fields, 'intro')).toBe(false)
    expect(parsed.fields.title).toBe('')
  })

  it('switches an optional slot on when its box is checked', async () => {
    const parsed = await roundTrip(stored(), (p) => p.set('slots.extra.enabled', 'true'))
    expect(parsed.slots.extra).toEqual({ enabled: true, data: { text: 'kept' } })
  })

  it('adds, removes and moves list items', () => {
    const data = stored()
    const faq = (d: DocumentData) => d.fields.faq as unknown[]
    const added = applyFormOp(registry, 'kitchen', data, 'add:fields.faq')
    expect(faq(added)).toHaveLength(3)
    expect(faq(added)[2]).toEqual({})
    expect(faq(data)).toHaveLength(2)

    expect(faq(applyFormOp(registry, 'kitchen', data, 'remove:fields.faq.0'))).toEqual([{ question: 'How?', answer: 'Like this.' }])
    expect(faq(applyFormOp(registry, 'kitchen', data, 'down:fields.faq.0'))).toEqual([faq(data)[1], faq(data)[0]])
    expect(faq(applyFormOp(registry, 'kitchen', data, 'up:fields.faq.1'))).toEqual([faq(data)[1], faq(data)[0]])
    expect(applyFormOp(registry, 'kitchen', data, 'up:fields.faq.0')).toEqual(data)
    expect(applyFormOp(registry, 'kitchen', data, 'down:fields.faq.1')).toEqual(data)

    for (const op of ['add:fields.title', 'remove:fields.faq.99', 'nonsense', 'add:', 'remove:fields.faq', 'add:fields.__proto__', 'up:fields.faq.-1']) {
      expect(applyFormOp(registry, 'kitchen', data, op)).toBe(data)
    }
    expect(data).toEqual(stored())
  })

  it('adds an item to a list that is absent', () => {
    const data = stored()
    delete data.fields.faq
    expect(applyFormOp(registry, 'kitchen', data, 'add:fields.faq').fields.faq).toEqual([{}])
  })

  it('keeps a required group and list absent when the form is submitted untouched', async () => {
    const data = stored()
    delete data.fields.contact
    delete data.fields.faq
    const parsed = await roundTrip(data)
    expect(Object.hasOwn(parsed.fields, 'contact')).toBe(false)
    expect(Object.hasOwn(parsed.fields, 'faq')).toBe(false)
    expect(isDeepStrictEqual(parsed, data)).toBe(true)
  })

  it('saves an absent group once something is typed in it', async () => {
    const data = stored()
    delete data.fields.contact
    const parsed = await roundTrip(data, (p) => p.set('fields.contact.email', 'typed@example.com'))
    expect(parsed.fields.contact).toEqual({ email: 'typed@example.com' })
  })

  it('saves a list whose items were all removed as an empty list', async () => {
    const first = await roundTrip(stored())
    const removed = applyFormOp(registry, 'kitchen', applyFormOp(registry, 'kitchen', first, 'remove:fields.faq.0'), 'remove:fields.faq.0')
    expect(removed.fields.faq).toEqual([])
    const parsed = await roundTrip(removed)
    expect(parsed.fields.faq).toEqual([])
    expect(isDeepStrictEqual(parsed, removed)).toBe(true)
  })

  it('adds an item to an absent list, and the re-rendered form keeps it', async () => {
    const data = stored()
    delete data.fields.faq
    const params = submittedForm(await render(data))
    params.set('_op', 'add:fields.faq')
    const added = applyFormOp(registry, 'kitchen', parseDocumentForm(registry, 'kitchen', valuesOf(params)), params.get('_op')!)
    expect(added.fields.faq).toHaveLength(1)
    const parsed = await roundTrip(added)
    expect(parsed.fields.faq).toHaveLength(1)
  })

  it('places each problem on the closest field the form shows', () => {
    const data = stored()
    const names = formNames(registry, 'kitchen', data)
    expect(names.has('fields.faq.1.answer')).toBe(true)
    expect(names.has('fields.faq.1')).toBe(true)
    expect(names.has('fields.contact')).toBe(true)
    expect(names.has('slots.extra.enabled')).toBe(true)
    expect(names.has('slots.extra.data.text')).toBe(true)

    const { byName, unplaced } = placeIssues(registry, 'kitchen', data, [
      issue(['fields', 'faq', 1, 'answer']),
      issue(['fields', 'faq'], 'too_few'),
      issue(['fields', 'custom', 'x']),
      issue(['fields', 'nope']),
    ])
    expect(byName.get('fields.faq.1.answer')).toEqual(['Problem at fields.faq.1.answer'])
    expect(byName.get('fields.faq')).toEqual(['Problem at fields.faq'])
    expect(byName.get('fields.custom')).toEqual(['Problem at fields.custom.x'])
    expect(unplaced.map((i) => i.path)).toEqual([['fields', 'nope']])
  })

  it('ties problems and hints to their control', async () => {
    const problems = new Map([['fields.title', ['Title is too long']]])
    const hints = new Map([['fields.contact.email', ['Needed before publishing: Email']]])
    const doc = parseHtml(await render(stored(), { problems, hints }))
    const title = doc.querySelector('input[name="fields.title"]')!
    expect(title.getAttribute('aria-invalid')).toBe('true')
    const describedBy = title.getAttribute('aria-describedby')!.split(' ')
    expect(describedBy).toContain(`${title.id}-problem`)
    expect(describedBy).toContain(`${title.id}-help`)
    expect(doc.getElementById(`${title.id}-problem`)!.textContent).toContain('Title is too long')
    expect(doc.getElementById(`${title.id}-problem`)!.className).toContain('text-error')

    const email = doc.querySelector('input[name="fields.contact.email"]')!
    expect(email.hasAttribute('aria-invalid')).toBe(false)
    expect(email.getAttribute('aria-describedby')).toBe(`${email.id}-hint`)
    expect(doc.getElementById(`${email.id}-hint`)!.className).toMatch(/\bbg-warning\b.*\btext-warning-content\b/)
  })

  it('marks optional fields, and no field as required', async () => {
    const html = await render(stored())
    const doc = parseHtml(html)
    const label = (name: string) => doc.querySelector(`label[for="${formId(name)}"]`)!.textContent
    expect(label('fields.intro')).toContain('Optional')
    expect(label('fields.title')).not.toContain('Optional')
    expect(doc.body.textContent).not.toContain('Required to publish')
    expect(doc.querySelectorAll('[required]')).toHaveLength(0)
  })

  it('escapes stored values', async () => {
    const data = stored()
    data.fields.title = '"><script>alert(1)</script>'
    data.fields.custom = { x: 1, y: '</textarea><script>alert(2)</script>' }
    const html = await render(data)
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;/textarea&gt;')
  })

  it('renders rich text as an island with its JSON in a hidden input', async () => {
    const doc = parseHtml(await render(stored()))
    const root = doc.querySelector('[data-richtext]')!
    expect(root.getAttribute('data-name')).toBe('fields.body')
    expect(root.getAttribute('data-features')).toBe('bold link image')
    const labels = JSON.parse(root.getAttribute('data-labels')!) as Record<string, string>
    expect(labels.bold).toBe('Bold')
    expect(root.querySelector('[role="toolbar"]')!.getAttribute('aria-label')).toContain('Body')
    expect(root.querySelector('[role="toolbar"]')!.children).toHaveLength(0)
    expect(root.querySelector('[data-richtext-mount]')!.getAttribute('aria-label')).toBe('Body')
    const hidden = root.querySelector('input[type="hidden"][name="fields.body"]')!
    expect(JSON.parse(hidden.getAttribute('value')!)).toEqual(stored().fields.body)
    expect(root.querySelector('noscript')).not.toBeNull()
    expect(root.closest('fieldset')!.querySelector('legend')!.textContent).toContain('Body')
  })

  it('escapes rich text inside the hidden input', async () => {
    const data = stored()
    data.fields.body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '</script><script>alert(1)</script>' }] }] }
    const html = await render(data)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(isDeepStrictEqual(await roundTrip(data), data)).toBe(true)
  })

  it('reads rich text, keeping what is not JSON for validation to report', async () => {
    const meta = fieldMeta(f.richText({ label: 'Notes' }))!
    const parse = (raw: string | undefined, optional: boolean) =>
      richTextWidget.parse(valuesOf(new URLSearchParams(raw === undefined ? {} : { x: raw })), 'x', meta, optional)
    expect(parse(undefined, false)).toBeUndefined()
    expect(parse('', false)).toBeUndefined()
    expect(parse('{not json', false)).toBe('{not json')
    const blank = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(parse(blank, true)).toBeUndefined()
    expect(parse(blank, false)).toEqual({ type: 'doc', content: [] })
    // What the island writes (Tiptap's JSON, with null attrs) is read back in its stored form.
    const written = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi', marks: [{ type: 'link', attrs: { href: null, document: ABOUT } }] }] }] }
    expect(parse(JSON.stringify(written), false)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi', marks: [{ type: 'link', attrs: { document: ABOUT } }] }] }],
    })
  })

  it('places a rich text problem on the rich text field', () => {
    const data = stored()
    data.fields.body = { type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }] }
    const result = validateContent(registry, 'kitchen', data, 'draft')
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { byName, unplaced } = placeIssues(registry, 'kitchen', data, result.issues)
    expect(byName.get('fields.body')).toHaveLength(1)
    expect(unplaced).toEqual([])
  })

  it('reads hostile form names without touching Object.prototype', () => {
    const params = new URLSearchParams()
    params.append('__proto__.polluted', '1')
    params.append('fields.__proto__.x', '1')
    params.append('constructor.prototype.y', '1')
    params.append('fields.faq.__proto__.question', '1')
    params.append('fields.title', 'Hi')
    const parsed = parseDocumentForm(registry, 'kitchen', valuesOf(params))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).y).toBeUndefined()
    expect(Object.hasOwn(parsed, '__proto__')).toBe(false)
    expect(Object.hasOwn(parsed.fields, '__proto__')).toBe(false)
    expect(parsed.fields.title).toBe('Hi')
    expect(Object.hasOwn(parsed.fields, 'faq')).toBe(false)
  })

  it('labels every control, with unique ids', async () => {
    const doc = parseHtml(await render(stored()))
    const ids = new Set<string>()
    for (const el of doc.querySelectorAll('[id]')) {
      expect(ids.has(el.id)).toBe(false)
      ids.add(el.id)
    }
    const controls = doc.querySelectorAll('input:not([type=hidden]), select, textarea')
    expect(controls.length).toBeGreaterThan(10)
    for (const el of controls) {
      const labeled = el.id !== '' && doc.querySelector(`label[for="${el.id}"]`) !== null
      const legend = el.closest('fieldset')?.querySelector('legend')
      expect(labeled || legend !== undefined, `control ${el.getAttribute('name')}`).toBe(true)
    }
    expect(doc.querySelector(`label[for="${formId('fields.featured')}"]`)).not.toBeNull()
  })

  it('renders list buttons that work with and without htmx', async () => {
    const doc = parseHtml(await render(stored()))
    const ops = [...doc.querySelectorAll('button[name=_op]')]
    const values = ops.map((b) => b.getAttribute('value'))
    expect(values).toEqual(
      expect.arrayContaining(['add:fields.faq', 'remove:fields.faq.0', 'remove:fields.faq.1', 'down:fields.faq.0', 'up:fields.faq.1']),
    )
    for (const b of ops) {
      expect(b.getAttribute('type')).toBe('submit')
      expect(b.hasAttribute('formnovalidate')).toBe(true)
      expect(b.getAttribute('hx-post')).toBe('/admin/documents/doc-1')
      expect(b.getAttribute('hx-target')).toBe('#editor-form')
      expect(b.getAttribute('hx-select')).toBe('#editor-form')
      expect(b.getAttribute('hx-swap')).toBe('outerHTML')
    }
    const remove = ops.find((b) => b.getAttribute('value') === 'remove:fields.faq.1')!
    expect(remove.getAttribute('aria-label')).toContain('How?')
    const legends = [...doc.querySelectorAll('legend.sr-only')].map((l) => l.textContent.trim())
    expect(legends).toEqual(expect.arrayContaining(['Why?', 'How?']))
  })

  it('titles list items by their content, falling back to the list label and number', async () => {
    const data = stored()
    data.fields.faq = [
      { question: 'Why?', answer: 'Because.' },
      { question: '  ', answer: 'No question yet.' },
    ]
    const doc = parseHtml(await render(data))
    const title = (name: string) => doc.querySelector(`details[data-item="${name}"] > summary span`)!.textContent.trim()
    expect(title('fields.faq.0')).toBe('Why?')
    expect(title('fields.faq.1')).toBe('Question 2')
    expect(doc.querySelector('details[data-item="fields.faq.0"] > summary')!.textContent).toContain('Because.')
  })

  it('keeps item button labels unique when titles repeat', async () => {
    const data = stored()
    data.fields.faq = [
      { question: 'Same', answer: 'One' },
      { question: 'Same', answer: 'Two' },
    ]
    const doc = parseHtml(await render(data))
    const label = (op: string) => doc.querySelector(`button[value="${op}"]`)!.getAttribute('aria-label')!
    const first = label('remove:fields.faq.0')
    const second = label('remove:fields.faq.1')
    expect(first).not.toBe(second)
    expect(first).toContain('(1)')
    expect(second).toContain('(2)')

    data.fields.faq = [
      { question: 'Same', answer: 'One' },
      { question: 'Same', answer: 'Two' },
      { question: 'Same (2)', answer: 'Three' },
    ]
    const again = parseHtml(await render(data))
    const labels = [0, 1, 2].map((i) => again.querySelector(`button[value="remove:fields.faq.${i}"]`)!.getAttribute('aria-label')!)
    expect(new Set(labels).size).toBe(3)
    const titles = [0, 1, 2].map((i) => again.querySelector(`details[data-item="fields.faq.${i}"] > summary span`)!.textContent.trim())
    expect(new Set(titles).size).toBe(3)
  })

  it('puts each slot in a card with a summary and a count of what is needed', async () => {
    const hints = new Map([['slots.extra.data.text', ['Needed before publishing: Text']]])
    const doc = parseHtml(await render(stored(), { hints }))
    const card = doc.querySelector('details[data-card="extra"]')!
    expect(card.querySelector('summary h2')!.textContent).toBe('Note')
    expect(card.hasAttribute('open')).toBe(true)
    expect(card.querySelector('summary .badge-warning')!.textContent).toBe('1 needed to publish')
    expect(card.querySelector('summary')!.textContent).toContain('Hidden from the page')

    const fields = doc.querySelector('details[data-card="fields"]')!
    expect(fields.querySelector('summary h2')!.textContent).toBe('Kitchen sink')
    expect(fields.querySelector('summary .badge')).toBeNull()
  })

  it('names a card\'s only list by the card heading, without a second legend', async () => {
    const Links = defineBlock({
      name: 'links',
      label: 'Links',
      schema: z.object({ items: f.list(z.object({ label: f.text({ label: 'Label' }) }), { label: 'Links' }) }),
    })
    const Linked = defineTemplate({ name: 'linked', label: 'Linked', fields: z.object({ title: f.text({ label: 'Title' }) }), slots: { links: { block: Links } } })
    const linkedRegistry = buildRegistry(
      defineSite({
        locales: ['en'],
        defaultLocale: 'en',
        singletons: [defineSingleton({ name: 'linked', label: 'Linked', template: Linked, path: null })],
        collections: adminSite.collections,
      }),
    )
    const data: DocumentData = { fields: { title: 'Linked' }, slots: { links: { enabled: true, data: { items: [{ label: 'One' }, { label: 'Two' }] } } } }
    const ctx: FormContext = { registry: linkedRegistry, type: 'linked', locale: 'en', refs }
    const doc = parseHtml(`<form>${await renderToString(jsx(DocumentFields, { ctx, data }))}</form>`)
    const card = doc.querySelector('details[data-card="links"]')!
    const heading = card.querySelector('summary h2')!
    const list = card.querySelector('fieldset')!
    expect(list.querySelector(':scope > legend')).toBeNull()
    expect(list.getAttribute('aria-labelledby')).toBe(heading.id)
    expect(card.querySelector('summary')!.textContent).toContain('2 items')
  })

  it('opens items that are listed as open or have notes, and closes listed cards', async () => {
    const isOpen = (doc: Document, selector: string) => doc.querySelector(selector)!.hasAttribute('open')
    const plain = parseHtml(await render(stored()))
    expect(isOpen(plain, 'details[data-item="fields.faq.0"]')).toBe(false)
    expect(isOpen(plain, 'details[data-card="fields"]')).toBe(true)
    expect(isOpen(plain, 'details[data-card="extra"]')).toBe(true)

    const opened = parseHtml(await render(stored(), { open: new Set(['fields.faq.1']) }))
    expect(isOpen(opened, 'details[data-item="fields.faq.0"]')).toBe(false)
    expect(isOpen(opened, 'details[data-item="fields.faq.1"]')).toBe(true)

    const hinted = parseHtml(await render(stored(), { hints: new Map([['fields.faq.0.answer', ['Needed']]]) }))
    expect(isOpen(hinted, 'details[data-item="fields.faq.0"]')).toBe(true)
    expect(isOpen(hinted, 'details[data-item="fields.faq.1"]')).toBe(false)

    const closed = parseHtml(await render(stored(), { closed: new Set(['fields', 'extra']) }))
    expect(isOpen(closed, 'details[data-card="fields"]')).toBe(false)
    expect(isOpen(closed, 'details[data-card="extra"]')).toBe(false)

    const noted = parseHtml(await render(stored(), { closed: new Set(['fields']), hints: new Map([['fields.title', ['Needed']]]) }))
    expect(isOpen(noted, 'details[data-card="fields"]')).toBe(true)
  })

  it('remaps open items through list operations', () => {
    const data = stored()
    const cases: Array<[string, string[], string[]]> = [
      ['up:fields.faq.1', ['fields.faq.1'], ['fields.faq.0']],
      ['down:fields.faq.0', ['fields.faq.1'], ['fields.faq.0']],
      ['remove:fields.faq.0', ['fields.faq.0', 'fields.faq.2'], ['fields.faq.1']],
      ['add:fields.faq', [], ['fields.faq.2']],
    ]
    for (const [op, open, expected] of cases) expect(remapOpen(registry, 'kitchen', data, op, open), op).toEqual(expected)
  })

  it('ignores _open and _closed when reading the form', async () => {
    const params = submittedForm(await render(stored()))
    const without = parseDocumentForm(registry, 'kitchen', valuesOf(params))
    params.set('_open', 'fields.faq.0,fields.faq.1')
    params.set('_closed', 'fields,extra')
    expect(parseDocumentForm(registry, 'kitchen', valuesOf(params))).toEqual(without)
    expect(readOpenState(valuesOf(params))).toEqual({ open: ['fields.faq.0', 'fields.faq.1'], closed: ['fields', 'extra'] })
  })

  it('renders read-only forms disabled, without list buttons', async () => {
    const doc = parseHtml(await render(stored(), { readOnly: true }))
    const controls = doc.querySelectorAll('input, select, textarea')
    for (const el of controls) expect(el.hasAttribute('disabled'), `control ${el.getAttribute('name')}`).toBe(true)
    expect(doc.querySelectorAll('button[name=_op]')).toHaveLength(0)
  })

  it('shows the slug and path of entries', async () => {
    const data: DocumentData = { slug: 'hello', path: '/hi', fields: { title: 'Hello', date: '2026-01-01' }, slots: {} }
    const html = `<form>${await renderToString(
      jsx(DocumentFields, { ctx: ctxOf({ type: 'posts' }), data, entry: { customPaths: true } }),
    )}</form>`
    const doc = parseHtml(html)
    const slug = doc.querySelector('input[name="slug"]')!
    expect(slug.getAttribute('value')).toBe('hello')
    expect(slug.getAttribute('aria-describedby')).toContain(`${slug.id}-help`)
    expect(doc.getElementById(`${slug.id}-help`)!.textContent).toContain('Leave empty')
    expect(doc.querySelector('input[name="path"]')!.getAttribute('value')).toBe('/hi')
    const parsed = parseDocumentForm(registry, 'posts', valuesOf(submittedForm(html)))
    expect(parsed.slug).toBe('hello')
    expect(parsed.path).toBe('/hi')
    expect(parsed.fields.title).toBe('Hello')

    const noSlug = new URLSearchParams({ slug: '', path: '', 'fields.title': 'x' })
    const empty = parseDocumentForm(registry, 'posts', valuesOf(noSlug))
    expect(Object.hasOwn(empty, 'slug')).toBe(false)
    expect(Object.hasOwn(empty, 'path')).toBe(false)
  })
})

describe('admin fixture site', () => {
  it('boots an app with the kitchen singleton', async () => {
    const { app } = await makeApp({ withOwner: true, site: adminSite })
    try {
      expect(await app.inlay.core.findSingleton('kitchen')).not.toBeNull()
    } finally {
      await app.close()
    }
  })
})

/** Optional containers, a required group with a box in it, and sanitized controls, for untouched round trips. */
const Edges = defineTemplate({
  name: 'edges',
  label: 'Edges',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    notes: f.textarea({ label: 'Notes' }).optional(),
    count: f.number({ label: 'Count' }).optional(),
    day: f.date({ label: 'Day' }).optional(),
    at: f.datetime({ label: 'At' }).optional(),
    links: f.list(z.object({ label: f.text({ label: 'Label' }) }), { label: 'Links' }).optional(),
    tags: defineField(z.array(f.text({ label: 'Tag' })), { kind: 'list', label: 'Tags' }).optional(),
    quotes: f.ref('testimonials', { label: 'Quotes', many: true }).optional(),
    extra: f.group({ note: f.text({ label: 'Note' }).optional() }, { label: 'Extra' }).optional(),
    flags: f.group({ name: f.text({ label: 'Name' }), on: f.boolean({ label: 'On' }) }, { label: 'Flags' }),
    aside: f.richText({ label: 'Aside' }).optional(),
  }),
  slots: {},
})

const edgesRegistry = buildRegistry(
  defineSite({
    locales: ['en'],
    defaultLocale: 'en',
    singletons: [defineSingleton({ name: 'edges', label: 'Edges', template: Edges, path: null })],
    collections: adminSite.collections,
  }),
)

async function edgesRoundTrip(data: DocumentData, edit?: (p: URLSearchParams) => void): Promise<DocumentData> {
  const ctx: FormContext = { registry: edgesRegistry, type: 'edges', locale: 'en', refs }
  const html = `<form>${await renderToString(jsx(DocumentFields, { ctx, data }))}</form>`
  const params = submittedForm(html)
  edit?.(params)
  return parseDocumentForm(edgesRegistry, 'edges', valuesOf(params))
}

const edges = (fields: Record<string, unknown>): DocumentData => ({ fields: { title: 'Edges', ...fields }, slots: {} })

describe('admin form engine: untouched round trips', () => {
  it('sends textarea newlines as CRLF and reads them back as LF', async () => {
    const data = edges({ notes: 'One\nTwo\n\nThree' })
    const html = `<form>${await renderToString(jsx(DocumentFields, { ctx: { registry: edgesRegistry, type: 'edges', locale: 'en', refs }, data }))}</form>`
    expect(submittedForm(html).get('fields.notes')).toBe('One\r\nTwo\r\n\r\nThree')
    expect(isDeepStrictEqual(await edgesRoundTrip(data), data)).toBe(true)
  })

  it('reads CRLF in a JSON field as LF', async () => {
    const parsed = await roundTrip(stored(), (p) => p.set('fields.custom', '{\r\n  "x": 2\r\n}'))
    expect(parsed.fields.custom).toEqual({ x: 2 })
    const bad = await roundTrip(stored(), (p) => p.set('fields.custom', '{\r\n  oops'))
    expect(bad.fields.custom).toBe('{\n  oops')
  })

  it('keeps stored empty optional lists, many-refs and groups', async () => {
    const data = edges({ links: [], tags: [], quotes: [], extra: {} })
    const parsed = await edgesRoundTrip(data)
    expect(parsed.fields).toEqual(data.fields)
    expect(isDeepStrictEqual(parsed, data)).toBe(true)
  })

  it('keeps absent optional lists, many-refs and groups absent', async () => {
    const data = edges({})
    expect(isDeepStrictEqual(await edgesRoundTrip(data), data)).toBe(true)
  })

  it('keeps a stored scalar list', async () => {
    const data = edges({ tags: ['a', 'b'] })
    expect(isDeepStrictEqual(await edgesRoundTrip(data), data)).toBe(true)
  })

  it('keeps a stored blank rich text on an optional field, and an absent one absent', async () => {
    const data = edges({ aside: { type: 'doc', content: [] } })
    expect(isDeepStrictEqual(await edgesRoundTrip(data), data)).toBe(true)
    const typed = await edgesRoundTrip(edges({}), (p) => p.set('fields.aside', JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })))
    expect(Object.hasOwn(typed.fields, 'aside')).toBe(false)
  })

  it('keeps an absent required group with a box in it absent, and saves it once a text is typed or the box ticked', async () => {
    const data = edges({})
    const parsed = await edgesRoundTrip(data)
    expect(Object.hasOwn(parsed.fields, 'flags')).toBe(false)
    expect((await edgesRoundTrip(data, (p) => p.set('fields.flags.name', 'Typed'))).fields.flags).toEqual({ name: 'Typed', on: false })
    expect((await edgesRoundTrip(data, (p) => p.set('fields.flags.on', 'true'))).fields.flags).toEqual({ on: true })
    const stored = edges({ flags: { name: '', on: false } })
    expect(isDeepStrictEqual(await edgesRoundTrip(stored), stored)).toBe(true)
  })

  it('shows a one-line text with newlines in a text box, and keeps it', async () => {
    const data = edges({ title: 'Line one\nLine two' })
    const html = await renderToString(jsx(DocumentFields, { ctx: { registry: edgesRegistry, type: 'edges', locale: 'en', refs }, data }))
    expect(parseHtml(html).querySelector('[name="fields.title"]')!.tagName).toBe('TEXTAREA')
    expect(isDeepStrictEqual(await edgesRoundTrip(data), data)).toBe(true)
  })

  it('shows numbers, dates and datetimes the browser would blank as plain text, and keeps them', async () => {
    const data = edges({ count: '12abc', day: '2026-02-30', at: 'next tuesday' })
    const html = await renderToString(jsx(DocumentFields, { ctx: { registry: edgesRegistry, type: 'edges', locale: 'en', refs }, data }))
    const doc = parseHtml(html)
    for (const name of ['fields.count', 'fields.day', 'fields.at']) {
      expect(doc.querySelector(`input[name="${name}"]`)!.getAttribute('type')).toBe('text')
    }
    expect(isDeepStrictEqual(await edgesRoundTrip(data), data)).toBe(true)

    const good = edges({ count: 4, day: '2026-02-28', at: '2026-03-01T11:30:00+02:00' })
    const goodDoc = parseHtml(await renderToString(jsx(DocumentFields, { ctx: { registry: edgesRegistry, type: 'edges', locale: 'en', refs }, data: good })))
    expect(goodDoc.querySelector('input[name="fields.count"]')!.getAttribute('type')).toBe('number')
    expect(goodDoc.querySelector('input[name="fields.day"]')!.getAttribute('type')).toBe('date')
    expect(goodDoc.querySelector('input[name="fields.at"]')!.getAttribute('type')).toBe('datetime-local')
    expect(isDeepStrictEqual(await edgesRoundTrip(good), good)).toBe(true)
  })

  it('keeps a stored datetime on the minute although the browser drops its zero seconds', async () => {
    const data = edges({ at: '2026-03-01T09:30:00Z' })
    const html = `<form>${await renderToString(jsx(DocumentFields, { ctx: { registry: edgesRegistry, type: 'edges', locale: 'en', refs }, data }))}</form>`
    expect(submittedForm(html).get('fields.at')).toBe('2026-03-01T09:30')
    expect(isDeepStrictEqual(await edgesRoundTrip(data), data)).toBe(true)
  })
})

describe('three-deep lists', () => {
  const megaRegistry = buildRegistry(megaMenuSite)
  const link = (n: string) => ({ label: `L${n}`, href: `/${n}`, description: `D${n}` })
  const column = (n: string) => ({ heading: `H${n}`, links: [link(`${n}0`), link(`${n}1`)] })
  const stored = (): DocumentData => ({
    fields: {
      menu: [
        { title: 'One', columns: [column('a'), column('b')] },
        { title: 'Two', columns: [column('c'), column('d')] },
      ],
      promo: { text: 'Sale', link: { url: '/sale', text: 'Shop' } },
    },
    slots: {},
  })
  const ctx: FormContext = { registry: megaRegistry, type: 'menu', locale: 'en', refs }
  const parse = (params: URLSearchParams) => parseDocumentForm(megaRegistry, 'menu', valuesOf(params))
  const menu = (data: DocumentData) => data.fields.menu as Array<{ title: string; columns: Array<{ heading: string; links: Array<{ label: string }> }> }>

  it('renders every level with its controls', async () => {
    const html = `<form>${await renderToString(jsx(DocumentFields, { ctx, data: stored() }))}</form>`
    const doc = parseHtml(html)
    expect(doc.querySelector('input[name="fields.menu.1.columns.0.links.1.label"]')).not.toBeNull()
    expect(doc.querySelector('input[name="fields.menu.1.columns.0.links.1.href"]')).not.toBeNull()
    expect(doc.querySelector('textarea[name="fields.menu.1.columns.0.links.1.description"]')).not.toBeNull()
    for (const list of ['fields.menu', 'fields.menu.1.columns', 'fields.menu.1.columns.0.links']) {
      expect(doc.querySelector(`button[value="add:${list}"]`), list).not.toBeNull()
    }
    expect(doc.querySelector('button[value="remove:fields.menu.1.columns.0.links.1"]')).not.toBeNull()
    expect(doc.querySelector('button[value="down:fields.menu.1.columns.0.links.0"]')).not.toBeNull()
  })

  it('round-trips the form untouched', async () => {
    const data = stored()
    const html = `<form>${await renderToString(jsx(DocumentFields, { ctx, data }))}</form>`
    expect(parse(submittedForm(html))).toEqual(data)
  })

  it('adds, removes and moves items at each depth', () => {
    const data = stored()
    const op = (o: string) => applyFormOp(megaRegistry, 'menu', data, o)
    const lists = (d: DocumentData) => ({
      top: menu(d).map((m) => m.title),
      cols: menu(d)[1]?.columns.map((c) => c.heading),
      links: menu(d)[1]?.columns[0]?.links.map((l) => l.label),
      other: menu(d)[0],
    })
    const base = lists(data)

    expect(lists(op('add:fields.menu')).top).toEqual(['One', 'Two', undefined])
    expect(menu(op('remove:fields.menu.0')).map((m) => m.title)).toEqual(['Two'])
    expect(lists(op('up:fields.menu.1')).top).toEqual(['Two', 'One'])
    expect(lists(op('down:fields.menu.0')).top).toEqual(['Two', 'One'])

    expect(lists(op('add:fields.menu.1.columns'))).toMatchObject({ cols: ['Hc', 'Hd', undefined], top: base.top, other: base.other })
    expect(lists(op('remove:fields.menu.1.columns.0'))).toMatchObject({ cols: ['Hd'], top: base.top, other: base.other })
    expect(lists(op('up:fields.menu.1.columns.1'))).toMatchObject({ cols: ['Hd', 'Hc'], other: base.other })
    expect(lists(op('down:fields.menu.1.columns.0'))).toMatchObject({ cols: ['Hd', 'Hc'], other: base.other })

    const links = 'fields.menu.1.columns.0.links'
    expect(menu(op(`add:${links}`))[1]!.columns[0]!.links).toHaveLength(3)
    expect(lists(op(`remove:${links}.0`))).toMatchObject({ links: ['Lc1'], cols: base.cols, other: base.other })
    expect(lists(op(`up:${links}.1`))).toMatchObject({ links: ['Lc1', 'Lc0'], cols: base.cols, other: base.other })
    expect(lists(op(`down:${links}.0`))).toMatchObject({ links: ['Lc1', 'Lc0'], cols: base.cols, other: base.other })
    expect(menu(op(`add:${links}`))[0]).toEqual(base.other)
  })

  it('remaps open items after a move at depth two', () => {
    expect(
      remapOpen(megaRegistry, 'menu', stored(), 'down:fields.menu.0.columns.0', [
        'fields.menu.0.columns.0',
        'fields.menu.0.columns.0.links.1',
        'fields.menu.1.columns.0',
      ]),
    ).toEqual(['fields.menu.0.columns.1', 'fields.menu.0.columns.1.links.1', 'fields.menu.1.columns.0'])
  })

  it('places validation issues on the right nested field', async () => {
    const data = stored()
    delete (menu(data)[1]!.columns[0]!.links[1] as Record<string, unknown>).href
    const result = validateContent(megaRegistry, 'menu', data, 'strict')
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { byName, unplaced } = placeIssues(megaRegistry, 'menu', data, result.issues)
    const name = 'fields.menu.1.columns.0.links.1.href'
    expect(byName.has(name)).toBe(true)
    expect(unplaced).toEqual([])

    const doc = parseHtml(await renderToString(jsx(DocumentFields, { ctx: { ...ctx, problems: byName, hints: new Map() }, data })))
    expect(doc.getElementById(`${formId(name)}-problem`)).not.toBeNull()
    expect(doc.getElementById(formId(name))!.getAttribute('aria-invalid')).toBe('true')
    const isOpen = (item: string) => doc.querySelector(`details[data-item="${item}"]`)!.hasAttribute('open')
    expect(isOpen('fields.menu.1')).toBe(true)
    expect(isOpen('fields.menu.1.columns.0')).toBe(true)
    expect(isOpen('fields.menu.1.columns.0.links.1')).toBe(true)
    expect(isOpen('fields.menu.0')).toBe(false)
    expect(isOpen('fields.menu.1.columns.1')).toBe(false)
  })
})
