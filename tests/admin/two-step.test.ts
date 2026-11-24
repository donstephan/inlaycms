import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { AuthService } from '../../src/core/auth/service.js'
import { t } from '../../src/core/messages/index.js'
import { parseHtml, setUpTwoStep, signIn, totpCode, type AdminClient } from '../helpers/admin.js'
import { makeApp, OWNER_PASSWORD } from '../helpers/app.js'

const EDITOR = 'editor@example.com'
const SETUP = '/admin/account/two-step/setup'
const CONFIRM = '/admin/account/two-step/confirm'
const OFF = '/admin/account/two-step/off'

const wrongPassword = () => t('issue.wrongPassword', { field: t('admin.account.twoStep.password') })

/** A six-digit code the plugin won't accept now (it allows one step either side). */
function wrongCode(key: string): string {
  const now = Date.now()
  const valid = new Set([-30_000, 0, 30_000].map((d) => totpCode(key, now + d)))
  return ['000000', '111111', '222222', '333333'].find((c) => !valid.has(c))!
}

/** The account page's two-step login section. */
function section(res: LightMyRequestResponse): Element {
  const found = parseHtml(res.body).querySelector('section[aria-labelledby="two-step-heading"]')
  if (!found) throw new Error(`No two-step login section in a ${res.statusCode} answer`)
  return found
}

const textOf = (el: Element) => el.textContent.replace(/\s+/g, ' ')

/** The status the section shows: On or Off. */
const stateOf = (res: LightMyRequestResponse) => textOf(section(res).querySelector('[data-two-step-state]')!).trim()

describe('two-step login on the account page', () => {
  let app: FastifyInstance
  let service: AuthService
  let editorId: string
  let editorKey: string
  let eddie: AdminClient

  beforeEach(async () => {
    const made = await makeApp({ withOwner: true })
    ;({ app, service, editorKey } = made)
    editorId = made.editor.actor.id!
    await app.ready()
    eddie = await signIn(app, EDITOR)
  })
  afterEach(() => app.close())

  it('shows two-step login as off with a password field', async () => {
    const res = await eddie.get('/admin/account')
    expect(res.statusCode).toBe(200)
    const el = section(res)
    expect(el.querySelector('#two-step-heading')?.textContent).toBe(t('admin.account.twoStep.heading'))
    expect(stateOf(res)).toBe(t('admin.account.twoStep.off'))
    const form = el.querySelector(`form[action="${SETUP}"]`)
    expect(form?.getAttribute('method')).toBe('post')
    expect(form?.querySelector('input[name="password"][type="password"]')?.getAttribute('autocomplete')).toBe('current-password')
    expect(textOf(el)).toContain(t('admin.account.twoStep.keysNote'))
  })

  it('refuses setup with a wrong password', async () => {
    const res = await eddie.post(SETUP, { password: 'not the password' })
    expect(res.statusCode).toBe(400)
    const form = section(res).querySelector(`form[action="${SETUP}"]`)!
    expect(textOf(form)).toContain(wrongPassword())
    expect(form.querySelector('input[name="password"]')?.getAttribute('aria-invalid')).toBe('true')
    expect(stateOf(res)).toBe(t('admin.account.twoStep.off'))
    expect(await service.twoStepOn(editorId)).toBe(false)
  })

  it('shows a QR code and the key after the password', async () => {
    const res = await eddie.post(SETUP, { password: OWNER_PASSWORD })
    expect(res.statusCode).toBe(200)
    expect(res.headers.location).toBeUndefined()
    const el = section(res)
    const svgs = el.querySelectorAll('svg')
    expect(svgs).toHaveLength(1)
    expect(svgs[0]?.getAttribute('role')).toBe('img')
    expect(svgs[0]?.getAttribute('aria-label')).toBe(t('admin.account.twoStep.qrAlt'))
    const form = el.querySelector(`form[action="${CONFIRM}"]`)!
    const uri = form.querySelector<HTMLInputElement>('input[name="uri"][type="hidden"]')?.value ?? ''
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    const key = new URL(uri).searchParams.get('secret') ?? ''
    expect(key).toMatch(/^[A-Z2-7]{16,}$/)
    expect(el.querySelector('code#two-step-key')?.textContent).toBe(key.match(/.{1,4}/g)!.join(' '))
    const code = form.querySelector('input[name="code"]')
    expect(code?.getAttribute('inputmode')).toBe('numeric')
    expect(code?.getAttribute('autocomplete')).toBe('one-time-code')
    expect(el.querySelector('a[href="/admin/account"]')?.textContent.trim()).toBe(t('admin.account.twoStep.cancel'))
    const doc = parseHtml(res.body)
    for (const link of doc.querySelectorAll('[href], [action], [src]')) {
      for (const name of ['href', 'action', 'src']) expect(link.getAttribute(name) ?? '').not.toContain(key)
    }
  })

  it('keeps the same key after a wrong code', async () => {
    const setup = await eddie.post(SETUP, { password: OWNER_PASSWORD })
    const uri = section(setup).querySelector<HTMLInputElement>('input[name="uri"]')!.value
    const key = new URL(uri).searchParams.get('secret')!
    const res = await eddie.post(CONFIRM, { code: wrongCode(key), uri })
    expect(res.statusCode).toBe(400)
    const el = section(res)
    expect(textOf(el)).toContain(t('auth.code.wrong'))
    expect(el.querySelector('input[name="code"]')?.getAttribute('aria-invalid')).toBe('true')
    expect(el.querySelectorAll('svg')).toHaveLength(1)
    expect(el.querySelector('#two-step-key')?.textContent.replace(/\s/g, '')).toBe(key)
    expect(el.querySelector<HTMLInputElement>('input[name="uri"]')?.value).toBe(uri)
    expect(await service.twoStepOn(editorId)).toBe(false)
  })

  it('turns on with the right code', async () => {
    const setup = await eddie.post(SETUP, { password: OWNER_PASSWORD })
    const uri = section(setup).querySelector<HTMLInputElement>('input[name="uri"]')!.value
    const key = new URL(uri).searchParams.get('secret')!
    const res = await eddie.post(CONFIRM, { code: totpCode(key), uri })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/account?notice=twoStepOn')
    const page = await eddie.get('/admin/account?notice=twoStepOn')
    expect(page.statusCode).toBe(200)
    expect(textOf(parseHtml(page.body).body)).toContain(t('admin.notice.twoStepOn'))
    expect(stateOf(page)).toBe(t('admin.account.twoStep.on'))
    expect(textOf(section(page))).toContain(t('admin.account.twoStep.onIntro'))
    expect(section(page).querySelector(`form[action="${OFF}"]`)).not.toBeNull()
    expect(section(page).querySelector(`form[action="${SETUP}"]`)).toBeNull()
    expect(await service.twoStepOn(editorId)).toBe(true)
  })

  it('finishes setup for a user whose authenticator link is longer than 512 characters', async () => {
    const label = 'long-host-name-'.padEnd(60, 'x')
    const email = `${'l'.repeat(60)}@${[label, label, label, label, label, label].join('.')}.example.com`
    const longActor = await service.createUser({ email, name: 'Long Address', password: OWNER_PASSWORD, role: 'editor' })
    const long = await signIn(app, email)
    const res = await long.post(SETUP, { password: OWNER_PASSWORD })
    expect(res.statusCode).toBe(200)
    const uri = section(res).querySelector<HTMLInputElement>(`form[action="${CONFIRM}"] input[name="uri"]`)?.value ?? ''
    expect(uri.length).toBeGreaterThan(512)
    await setUpTwoStep(long)
    expect(await service.twoStepOn(longActor.id!)).toBe(true)
  })

  it('ends the other sessions and keeps this one', async () => {
    const other = await signIn(app, EDITOR)
    await setUpTwoStep(eddie)
    expect((await eddie.get('/admin')).statusCode).toBe(200)
    const elsewhere = await other.get('/admin')
    expect(elsewhere.statusCode).toBe(302)
    expect(elsewhere.headers.location).toMatch(/^\/admin\/login\?/)
  })

  it('leaves API keys working', async () => {
    await setUpTwoStep(eddie)
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': editorKey },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })
    expect(res.statusCode).not.toBe(401)
  })

  it('asks for a code at the next login', async () => {
    const key = await setUpTwoStep(eddie)
    await expect(signIn(app, EDITOR)).rejects.toThrow(/asks for a code/)
    const again = await signIn(app, EDITOR, OWNER_PASSWORD, key)
    expect((await again.get('/admin')).statusCode).toBe(200)
  })

  it('does not count an unfinished setup', async () => {
    const first = await eddie.post(SETUP, { password: OWNER_PASSWORD })
    expect(first.statusCode).toBe(200)
    const firstKey = section(first).querySelector('#two-step-key')!.textContent
    const later = await signIn(app, EDITOR)
    expect((await later.get('/admin')).statusCode).toBe(200)
    expect(await service.twoStepOn(editorId)).toBe(false)
    expect(stateOf(await later.get('/admin/account'))).toBe(t('admin.account.twoStep.off'))
    const again = await later.post(SETUP, { password: OWNER_PASSWORD })
    expect(again.statusCode).toBe(200)
    const key = section(again).querySelector('#two-step-key')?.textContent ?? ''
    expect(key).not.toBe('')
    expect(key).not.toBe(firstKey)
  })

  it('ignores a uri that is not an authenticator link', async () => {
    await eddie.post(SETUP, { password: OWNER_PASSWORD })
    for (const uri of ['https://example.com/x?secret=JBSWY3DPEHPK3PXP', 'otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP', 'otpauth://totp/x', 'nonsense']) {
      const res = await eddie.post(CONFIRM, { code: '123456', uri })
      expect(res.statusCode, uri).toBe(400)
      const el = section(res)
      expect(el.querySelector('svg'), uri).toBeNull()
      expect(el.querySelector('#two-step-key'), uri).toBeNull()
      expect(el.querySelector('input[name="uri"]'), uri).toBeNull()
      expect(res.body).not.toContain('JBSW')
      expect(stateOf(res)).toBe(t('admin.account.twoStep.off'))
    }
    expect(await service.twoStepOn(editorId)).toBe(false)
  })

  it('turns off with the password', async () => {
    await setUpTwoStep(eddie)
    const wrong = await eddie.post(OFF, { password: 'not the password' })
    expect(wrong.statusCode).toBe(400)
    expect(textOf(section(wrong).querySelector(`form[action="${OFF}"]`)!)).toContain(wrongPassword())
    expect(stateOf(wrong)).toBe(t('admin.account.twoStep.on'))
    expect(await service.twoStepOn(editorId)).toBe(true)
    const right = await eddie.post(OFF, { password: OWNER_PASSWORD })
    expect(right.statusCode).toBe(303)
    expect(right.headers.location).toBe('/admin/account?notice=twoStepOff')
    const page = await eddie.get('/admin/account?notice=twoStepOff')
    expect(page.statusCode).toBe(200)
    expect(textOf(parseHtml(page.body).body)).toContain(t('admin.notice.twoStepOff'))
    expect(stateOf(page)).toBe(t('admin.account.twoStep.off'))
    expect(await service.twoStepOn(editorId)).toBe(false)
    expect((await (await signIn(app, EDITOR)).get('/admin')).statusCode).toBe(200)
  })

  it('refuses the forms from another origin', async () => {
    for (const [url, form] of [
      [SETUP, { password: OWNER_PASSWORD }],
      [CONFIRM, { code: '123456', uri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP' }],
      [OFF, { password: OWNER_PASSWORD }],
    ] as const) {
      const res = await eddie.post(url, form, { origin: 'https://evil.example' })
      expect(res.statusCode, url).toBe(403)
    }
    expect(await service.twoStepOn(editorId)).toBe(false)
  })
})
