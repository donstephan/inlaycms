import type { FastifyInstance } from 'fastify'
import type { AuthService } from '../../src/core/auth/service.js'
import { t } from '../../src/core/messages/index.js'
import type { Actor } from '../../src/core/types.js'
import { makeApp, OWNER_PASSWORD } from '../helpers/app.js'
import { parseHtml, setUpTwoStep, signIn, type AdminClient } from '../helpers/admin.js'

const textOf = (html: string) => parseHtml(html).body.textContent.replace(/\s+/g, ' ')

describe('admin users and account', () => {
  let app: FastifyInstance
  let service: AuthService
  let owner: Actor
  let editor: Actor
  let olivia: AdminClient
  let eddie: AdminClient

  beforeEach(async () => {
    const made = await makeApp({ withOwner: true })
    ;({ app, service } = made)
    owner = made.owner.actor
    editor = made.editor.actor
    await app.ready()
    olivia = await signIn(app, 'owner@example.com')
    eddie = await signIn(app, 'editor@example.com')
  })
  afterEach(() => app.close())

  const mcpStatus = async (key: string) =>
    (await app.inject({ method: 'GET', url: '/mcp', headers: { 'x-api-key': key, accept: 'text/event-stream' } })).statusCode

  describe('users', () => {
    it('lists users, marking you', async () => {
      const res = await olivia.get('/admin/users')
      expect(res.statusCode).toBe(200)
      const doc = parseHtml(res.body)
      const rows = [...doc.querySelectorAll('tbody tr')].map((tr) => tr.textContent.replace(/\s+/g, ' '))
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.includes('Olivia Owner'))).toContain('You')
      expect(rows.find((r) => r.includes('Eddie Editor'))).not.toContain('You')
      expect(doc.querySelector('a[href="/admin/users"][aria-current="page"]')).not.toBeNull()
      for (const id of ['name', 'email', 'password', 'confirm', 'role']) {
        expect(doc.querySelector(`label[for="${id}"]`), id).not.toBeNull()
      }
    })

    it('shows who has two-step login on', async () => {
      await setUpTwoStep(eddie)
      const doc = parseHtml((await olivia.get('/admin/users')).body)
      const headers = [...doc.querySelectorAll('thead th')].map((th) => th.textContent.trim())
      const column = headers.indexOf(t('admin.users.twoStep'))
      expect(column).toBe(headers.indexOf(t('admin.users.role')) + 1)
      const cellOf = (name: string) => {
        const row = [...doc.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes(name))
        return row?.children[column]?.textContent.trim()
      }
      expect(cellOf('Eddie Editor')).toBe(t('admin.account.twoStep.on'))
      expect(cellOf('Olivia Owner')).not.toContain(t('admin.account.twoStep.on'))
    })

    it('puts the intro under the heading and Add a user beside it', async () => {
      const doc = parseHtml((await olivia.get('/admin/users')).body)
      expect(doc.querySelector('h1 + p')?.textContent.trim()).toBe('The people who can log in to this site.')
      const open = doc.querySelector('button[data-sheet-open="add-user"]')
      expect(open?.classList.contains('btn-primary')).toBe(true)
      expect(open?.textContent.trim()).toBe('Add a user')
      const dialog = doc.querySelector('dialog#add-user')
      expect(dialog).not.toBeNull()
      expect(dialog?.hasAttribute('data-sheet-autoopen')).toBe(false)
      expect(dialog?.querySelector('h2')?.textContent.trim()).toBe('Add a user')
      expect(dialog?.textContent).toContain("doesn't send emails")
      expect(dialog?.querySelector('form[method="post"][action="/admin/users"]')).not.toBeNull()
      for (const id of ['name', 'email', 'password', 'confirm', 'role']) expect(dialog?.querySelector(`#${id}`), id).not.toBeNull()
      expect(doc.querySelector('#role-hint')?.textContent).toContain('Owners can do everything')
      expect(doc.querySelector('#role')?.getAttribute('aria-describedby')).toContain('role-hint')
      expect(doc.querySelector('#add-heading')).toBeNull()
    })

    it('adds an editor, who can then log in', async () => {
      const res = await olivia.post('/admin/users', {
        name: 'Nina Newman',
        email: 'nina@example.com',
        password: 'nina-password',
        confirm: 'nina-password',
        role: 'editor',
      })
      expect(res.statusCode).toBe(303)
      expect(res.headers.location).toBe('/admin/users?notice=userAdded')
      expect(textOf((await olivia.get(res.headers.location as string)).body)).toContain('Nina Newman')
      const nina = await signIn(app, 'nina@example.com', 'nina-password')
      expect((await nina.get('/admin')).statusCode).toBe(200)
      expect((await nina.get('/admin/users')).statusCode).toBe(403)
    })

    it('shows problems with a new user next to their fields, keeping what was typed', async () => {
      const taken = await olivia.post('/admin/users', {
        name: 'Nina',
        email: 'editor@example.com',
        password: 'nina-password',
        confirm: 'nina-password',
        role: 'editor',
      })
      expect(taken.statusCode).toBe(400)
      const doc = parseHtml(taken.body)
      expect(doc.querySelector('#email')?.getAttribute('aria-invalid')).toBe('true')
      expect(doc.querySelector('#email')?.getAttribute('value')).toBe('editor@example.com')
      expect(doc.querySelector('#name')?.getAttribute('value')).toBe('Nina')
      expect(textOf(taken.body)).toContain('already used by another account')
      expect(doc.querySelector('dialog#add-user[data-sheet-autoopen]')).not.toBeNull()
      expect(doc.querySelector('dialog#add-user #email')).not.toBeNull()

      const short = await olivia.post('/admin/users', { name: 'Nina', email: 'nina@example.com', password: 'short', confirm: 'short', role: 'editor' })
      expect(short.statusCode).toBe(400)
      expect(parseHtml(short.body).querySelector('#password')?.getAttribute('aria-invalid')).toBe('true')

      const differ = await olivia.post('/admin/users', {
        name: 'Nina',
        email: 'nina@example.com',
        password: 'nina-password',
        confirm: 'nina-passwort',
        role: 'editor',
      })
      expect(differ.statusCode).toBe(400)
      expect(parseHtml(differ.body).querySelector('#confirm')?.getAttribute('aria-invalid')).toBe('true')
      expect((await service.listUsers(owner)).map((u) => u.email)).not.toContain('nina@example.com')
    })

    it('refuses editors every user page and action', async () => {
      expect((await eddie.get('/admin/users')).statusCode).toBe(403)
      expect((await eddie.get(`/admin/users/${owner.id}`)).statusCode).toBe(403)
      expect((await eddie.get(`/admin/users/${owner.id}/remove`)).statusCode).toBe(403)
      expect((await eddie.post(`/admin/users/${owner.id}/role`, { role: 'editor' })).statusCode).toBe(403)
      expect((await eddie.post(`/admin/users/${editor.id}/role`, { role: 'owner' })).statusCode).toBe(403)
      expect((await eddie.post(`/admin/users/${owner.id}/password`, { password: 'x'.repeat(12), confirm: 'x'.repeat(12) })).statusCode).toBe(403)
      expect((await eddie.post(`/admin/users/${owner.id}/remove`, {})).statusCode).toBe(403)
      const add = await eddie.post('/admin/users', { name: 'X', email: 'x@example.com', password: 'x'.repeat(12), confirm: 'x'.repeat(12), role: 'owner' })
      expect(add.statusCode).toBe(403)
      expect((await service.actorForUser(owner.id!))?.role).toBe('owner')
      expect((await service.actorForUser(editor.id!))?.role).toBe('editor')
      expect(await service.actorForUser(owner.id!)).not.toBeNull()
      expect(parseHtml((await eddie.get('/admin')).body).querySelector('a[href="/admin/users"]')).toBeNull()
    })

    it('refuses a POST from another origin', async () => {
      const res = await olivia.post(`/admin/users/${editor.id}/role`, { role: 'owner' }, { origin: 'https://evil.example' })
      expect(res.statusCode).toBe(403)
      expect((await service.actorForUser(editor.id!))?.role).toBe('editor')
    })

    it('changes a role', async () => {
      const page = parseHtml((await olivia.get(`/admin/users/${editor.id}`)).body)
      expect(page.querySelector('h1')?.textContent).toContain('Eddie Editor')
      const res = await olivia.post(`/admin/users/${editor.id}/role`, { role: 'owner' })
      expect(res.statusCode).toBe(303)
      expect(res.headers.location).toBe(`/admin/users/${editor.id}?notice=userUpdated`)
      expect((await service.actorForUser(editor.id!))?.role).toBe('owner')
      expect((await eddie.get('/admin/users')).statusCode).toBe(200)
    })

    it('refuses to demote the only owner, in plain words', async () => {
      const res = await olivia.post(`/admin/users/${owner.id}/role`, { role: 'editor' })
      expect(res.statusCode).toBe(400)
      expect(textOf(res.body)).toContain('The site needs at least one owner.')
      expect((await service.actorForUser(owner.id!))?.role).toBe('owner')
    })

    it('sets a new password, logging the user out', async () => {
      const differ = await olivia.post(`/admin/users/${editor.id}/password`, { password: 'brand-new-password', confirm: 'other' })
      expect(differ.statusCode).toBe(400)
      const res = await olivia.post(`/admin/users/${editor.id}/password`, { password: 'brand-new-password', confirm: 'brand-new-password' })
      expect(res.statusCode).toBe(303)
      expect(res.headers.location).toBe(`/admin/users/${editor.id}?notice=userUpdated`)
      expect((await eddie.get('/admin')).statusCode).toBe(302)
      await expect(signIn(app, 'editor@example.com')).rejects.toThrow()
      await signIn(app, 'editor@example.com', 'brand-new-password')
    })

    it('removes a user after asking', async () => {
      const confirm = await olivia.get(`/admin/users/${editor.id}/remove`)
      expect(confirm.statusCode).toBe(200)
      expect(parseHtml(confirm.body).querySelector(`form[action="/admin/users/${editor.id}/remove"]`)).not.toBeNull()
      const res = await olivia.post(`/admin/users/${editor.id}/remove`, {})
      expect(res.statusCode).toBe(303)
      expect(res.headers.location).toBe('/admin/users?notice=userRemoved')
      expect(await service.actorForUser(editor.id!)).toBeNull()
      expect((await eddie.get('/admin')).statusCode).toBe(302)
    })

    it('refuses to remove yourself', async () => {
      const res = await olivia.post(`/admin/users/${owner.id}/remove`, {})
      expect(res.statusCode).toBe(400)
      expect(textOf(res.body)).toContain("You can't remove your own account.")
      expect(await service.actorForUser(owner.id!)).not.toBeNull()
    })

    it('answers 404 for an unknown user', async () => {
      expect((await olivia.get('/admin/users/nobody')).statusCode).toBe(404)
      expect((await olivia.post('/admin/users/nobody/role', { role: 'owner' })).statusCode).toBe(404)
      expect((await olivia.post('/admin/users/nobody/remove', {})).statusCode).toBe(404)
    })
  })

  describe('account', () => {
    it('shows the forms to everyone', async () => {
      const res = await eddie.get('/admin/account')
      expect(res.statusCode).toBe(200)
      const doc = parseHtml(res.body)
      for (const id of ['current', 'password', 'confirm', 'key-name']) {
        expect(doc.querySelector(`label[for="${id}"]`), id).not.toBeNull()
      }
      expect(textOf(res.body)).toContain('editor key')
      expect(doc.querySelector('h1 + p')?.textContent).toContain('Signed in as')
      const keysSection = doc.querySelector('section[aria-labelledby="keys-heading"]')
      expect(keysSection?.querySelector('button[data-sheet-open="create-key"]')?.textContent).toContain('Create an API key')
      const dialog = doc.querySelector('dialog#create-key')
      expect(dialog).not.toBeNull()
      expect(dialog?.hasAttribute('data-sheet-autoopen')).toBe(false)
      expect(dialog?.querySelector(`form[method=post][action="/admin/account/keys"] #key-name`)).not.toBeNull()
      expect(doc.querySelector('#create-heading')).toBeNull()
      expect(doc.querySelector('dialog #current')).toBeNull()
      expect(doc.querySelector('form[action="/admin/account/password"] #current')).not.toBeNull()
    })

    it('shows how to connect an assistant, and only your own connected assistants', async () => {
      const { adapter } = await service.auth.$context
      const at = new Date('2026-10-05T10:00:00.000Z')
      const redirectUris = ['https://claude.ai/api/mcp/auth_callback']
      await adapter.create({ model: 'oauthClient', data: { clientId: 'web-client', name: 'Claude', redirectUris, createdAt: at, updatedAt: at } })
      await adapter.create({ model: 'oauthConsent', data: { clientId: 'web-client', userId: editor.id!, scopes: ['openid'], createdAt: at, updatedAt: at } })

      const doc = parseHtml((await eddie.get('/admin/account')).body)
      const headings = [...doc.querySelectorAll('section[aria-labelledby]')].map((s) => s.getAttribute('aria-labelledby'))
      expect(headings).toEqual(['password-heading', 'two-step-heading', 'assistants-heading', 'keys-heading'])
      const section = doc.querySelector('section[aria-labelledby="assistants-heading"]')!
      expect(section.querySelector<HTMLInputElement>('input#mcp-url')?.value).toBe('https://example.com/mcp')
      expect(section.querySelector<HTMLInputElement>('input#mcp-command')?.value).toBe('claude mcp add --transport http inlay https://example.com/mcp')
      const rows = [...section.querySelectorAll('tbody tr')].map((tr) => tr.textContent.replace(/\s+/g, ' '))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain('Claude')
      expect(rows[0]).toContain('claude.ai')
      expect(section.querySelector('form, button[type=submit]')).toBeNull()

      const ownView = parseHtml((await olivia.get('/admin/account')).body).querySelector('section[aria-labelledby="assistants-heading"]')!
      expect(ownView.querySelector('tbody')).toBeNull()
      expect(ownView.textContent).toContain('No assistants connected yet.')
    })

    it('creates an API key, shown once, and revokes it', async () => {
      const res = await eddie.post('/admin/account/keys', { name: 'ci' })
      expect(res.statusCode).toBe(200)
      const input = parseHtml(res.body).querySelector('input[readonly]')
      const key = input?.getAttribute('value') ?? ''
      expect(key).not.toBe('')
      expect(res.body).toContain(key)
      expect(textOf(res.body)).toContain('shown only once')
      expect(await mcpStatus(key)).toBe(405)

      const account = await eddie.get('/admin/account')
      expect(account.body).not.toContain(key)
      const [ci] = (await service.listApiKeys(editor.id!)).filter((k) => k.name === 'ci')
      const form = parseHtml(account.body).querySelector(`form[action="/admin/account/keys/${ci!.id}/delete"]`)
      expect(form).not.toBeNull()

      const revoke = await eddie.post(`/admin/account/keys/${ci!.id}/delete`, {})
      expect(revoke.statusCode).toBe(303)
      expect(revoke.headers.location).toBe('/admin/account?notice=keyRevoked')
      expect(await mcpStatus(key)).toBe(401)
    })

    it('lets only owners make a key that can push releases', async () => {
      const keyOf = (body: string) => parseHtml(body).querySelector('input[readonly]')?.getAttribute('value') ?? ''
      const editorForm = parseHtml((await eddie.get('/admin/account')).body).querySelector('dialog#create-key form')
      expect(editorForm?.querySelector('#key-push')).toBeNull()
      const ownerForm = parseHtml((await olivia.get('/admin/account')).body).querySelector('dialog#create-key form')
      const box = ownerForm?.querySelector<HTMLInputElement>('input#key-push[type=checkbox][name=push]')
      expect(box).not.toBeNull()
      expect(box?.hasAttribute('checked')).toBe(false)
      expect(ownerForm?.querySelector('label[for="key-push"]')?.textContent).toContain('For pushing releases only')

      const pushing = await olivia.post('/admin/account/keys', { name: 'deploy', push: 'on' })
      expect(pushing.statusCode).toBe(200)
      expect(await service.apiKeyActor(keyOf(pushing.body))).toEqual({ actor: owner, permissions: { release: ['push'] } })
      const plain = await olivia.post('/admin/account/keys', { name: 'laptop' })
      expect(await service.apiKeyActor(keyOf(plain.body))).toEqual({ actor: owner, permissions: { release: [] } })
      const editors = await eddie.post('/admin/account/keys', { name: 'ci', push: 'on' })
      expect(editors.statusCode).toBe(200)
      expect(await service.apiKeyActor(keyOf(editors.body))).toEqual({ actor: editor, permissions: { release: [] } })
    })

    it('keeps the push choice when the key name is missing', async () => {
      const res = await olivia.post('/admin/account/keys', { name: ' ', push: 'on' })
      expect(res.statusCode).toBe(400)
      expect(parseHtml(res.body).querySelector('dialog#create-key #key-push')?.hasAttribute('checked')).toBe(true)
    })

    it('gives tests an owner push key', async () => {
      const made = await makeApp({ withOwner: true })
      try {
        const found = await made.service.apiKeyActor(made.pushKey)
        expect(found?.actor.role).toBe('owner')
        expect(found?.permissions.release).toEqual(['push'])
      } finally {
        await made.app.close()
      }
    })

    it("can't revoke someone else's key", async () => {
      const [ownerKey] = await service.listApiKeys(owner.id!)
      expect((await eddie.post(`/admin/account/keys/${ownerKey!.id}/delete`, {})).statusCode).toBe(404)
      expect(await service.listApiKeys(owner.id!)).toHaveLength(2)
    })

    it('asks for a key name', async () => {
      const res = await eddie.post('/admin/account/keys', { name: '  ' })
      expect(res.statusCode).toBe(400)
      const doc = parseHtml(res.body)
      expect(doc.querySelector('#key-name')?.getAttribute('aria-invalid')).toBe('true')
      expect(doc.querySelector('dialog#create-key[data-sheet-autoopen]')).not.toBeNull()
      expect(doc.querySelector('dialog#create-key #key-name')).not.toBeNull()
    })

    it('changes your password, keeping you logged in here only', async () => {
      const elsewhere = await signIn(app, 'editor@example.com')
      const res = await eddie.post('/admin/account/password', {
        current: OWNER_PASSWORD,
        password: 'brand-new-password',
        confirm: 'brand-new-password',
      })
      expect(res.statusCode).toBe(303)
      expect(res.headers.location).toBe('/admin/account?notice=passwordChanged')
      expect((await eddie.get('/admin/account')).statusCode).toBe(200)
      expect((await elsewhere.get('/admin/account')).statusCode).toBe(302)
      await signIn(app, 'editor@example.com', 'brand-new-password')
    })

    it('refuses a mismatched confirmation or a wrong current password', async () => {
      const differ = await eddie.post('/admin/account/password', {
        current: OWNER_PASSWORD,
        password: 'brand-new-password',
        confirm: 'brand-new-passwort',
      })
      expect(differ.statusCode).toBe(400)
      expect(parseHtml(differ.body).querySelector('#confirm')?.getAttribute('aria-invalid')).toBe('true')

      const wrong = await eddie.post('/admin/account/password', {
        current: 'not-my-password',
        password: 'brand-new-password',
        confirm: 'brand-new-password',
      })
      expect(wrong.statusCode).toBe(400)
      expect(parseHtml(wrong.body).querySelector('#current')?.getAttribute('aria-invalid')).toBe('true')
      await signIn(app, 'editor@example.com')
    })
  })
})
