import type { AuthService } from '../../src/core/auth/service.js'
import type { Core } from '../../src/core/core.js'
import { InlayError } from '../../src/core/errors.js'
import type { Actor } from '../../src/core/types.js'
import { makeAuth } from '../helpers/auth.js'

async function rejection(promise: Promise<unknown>): Promise<InlayError> {
  try {
    await promise
  } catch (e) {
    expect(e).toBeInstanceOf(InlayError)
    return e as InlayError
  }
  throw new Error('expected a rejection')
}

const issueAt = (e: InlayError) => (e.details.issues ?? []).map((i) => i.path[0])

describe('user management', () => {
  let auth: AuthService
  let core: Core
  let owner: Actor
  let editor: Actor
  let ownerKey: string
  let editorKey: string

  beforeEach(async () => {
    ;({ auth, core, owner, editor, ownerKey, editorKey } = await makeAuth())
  })

  async function sessionHeaders(email: string, password: string): Promise<Headers> {
    const signIn = await auth.auth.api.signInEmail({ body: { email, password }, returnHeaders: true })
    const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    return new Headers({ cookie })
  }

  it('is for owners only', async () => {
    expect((await rejection(auth.listUsers(editor))).code).toBe('forbidden')
    const input = { name: 'Nina', email: 'nina@example.com', password: 'nina-password', role: 'editor' as const }
    expect((await rejection(auth.addUser(editor, input))).code).toBe('forbidden')
    expect((await rejection(auth.setRole(editor, editor.id!, 'owner'))).code).toBe('forbidden')
    expect((await rejection(auth.setPassword(editor, owner.id!, 'new-password-1'))).code).toBe('forbidden')
    expect((await rejection(auth.removeUser(editor, owner.id!))).code).toBe('forbidden')
    expect((await auth.actorForUser(editor.id!))?.role).toBe('editor')
  })

  it('lists users sorted by name', async () => {
    const users = await auth.listUsers(owner)
    expect(users.map((u) => u.name)).toEqual(['Eddie Editor', 'Olivia Owner'])
    expect(users[1]).toMatchObject({ id: owner.id, email: 'olivia@example.com', role: 'owner', banned: false })
    expect(Number.isNaN(Date.parse(users[1]!.createdAt))).toBe(false)
  })

  it('adds a user, and refuses an email already in use', async () => {
    const input = { name: 'Nina Newman', email: 'nina@example.com', password: 'nina-password', role: 'editor' as const }
    const added = await auth.addUser(owner, input)
    expect(added).toMatchObject({ name: 'Nina Newman', email: 'nina@example.com', role: 'editor' })
    expect((await auth.listUsers(owner)).map((u) => u.email)).toContain('nina@example.com')

    const again = await rejection(auth.addUser(owner, { ...input, name: 'Other Nina' }))
    expect(again.code).toBe('validation')
    expect(issueAt(again)).toEqual(['email'])

    const short = await rejection(auth.addUser(owner, { ...input, email: 'n2@example.com', password: 'short' }))
    expect(issueAt(short)).toEqual(['password'])
  })

  it('never leaves the site without an owner', async () => {
    const last = await rejection(auth.setRole(owner, owner.id!, 'editor'))
    expect(last.code).toBe('invalid_operation')
    expect(last.messageId).toBe('error.lastOwner')
    expect((await auth.actorForUser(owner.id!))?.role).toBe('owner')

    await auth.setRole(owner, editor.id!, 'owner')
    expect((await auth.actorForUser(editor.id!))?.role).toBe('owner')
    await auth.setRole(owner, owner.id!, 'editor')
    expect((await auth.actorForUser(owner.id!))?.role).toBe('editor')
  })

  it('refuses two demotions at once that would leave no owner', async () => {
    await auth.setRole(owner, editor.id!, 'owner')
    const results = await Promise.allSettled([auth.setRole(owner, owner.id!, 'editor'), auth.setRole(owner, editor.id!, 'editor')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await auth.hasOwner()).toBe(true)
  })

  it('refuses an unknown user', async () => {
    expect((await rejection(auth.setRole(owner, 'nobody', 'editor'))).code).toBe('not_found')
    expect((await rejection(auth.setPassword(owner, 'nobody', 'new-password-1'))).code).toBe('not_found')
    expect((await rejection(auth.removeUser(owner, 'nobody'))).code).toBe('not_found')
  })

  it('refuses to remove yourself', async () => {
    const e = await rejection(auth.removeUser(owner, owner.id!))
    expect(e.code).toBe('invalid_operation')
    expect(e.messageId).toBe('error.removeSelf')
    expect(await auth.actorForUser(owner.id!)).not.toBeNull()
  })

  it('removes a user with their sessions and API keys, and history keeps their name', async () => {
    await core.applyShippedContent()
    const home = (await core.getDocument((await core.findSingleton('home'))!.id))!
    await core.patchDraft(
      home.id,
      { baseRevisionId: home.headRev, ops: [{ path: ['slots', 'quotes', 'data', 'heading'], value: 'Kind words' }] },
      { actor: editor, source: 'admin' },
    )
    const session = await sessionHeaders('eddie@example.com', 'editor-password')
    expect(await auth.apiKeyActor(editorKey)).toEqual({ actor: editor, permissions: { release: [] } })

    await auth.removeUser(owner, editor.id!)
    expect(await auth.actorForUser(editor.id!)).toBeNull()
    expect(await auth.apiKeyActor(editorKey)).toBeNull()
    expect(await auth.sessionActor(session)).toBeNull()
    expect(await auth.listApiKeys(editor.id!)).toEqual([])
    expect((await auth.listUsers(owner)).map((u) => u.id)).toEqual([owner.id])
    const revisions = await core.listRevisions(home.id)
    expect(revisions[0]).toMatchObject({ authorId: editor.id, authorName: 'Eddie Editor' })
  })

  it('setting a password ends that user’s sessions', async () => {
    const session = await sessionHeaders('eddie@example.com', 'editor-password')
    expect(await auth.sessionActor(session)).toEqual(editor)
    await auth.setPassword(owner, editor.id!, 'brand-new-password')
    expect(await auth.sessionActor(session)).toBeNull()
    await expect(sessionHeaders('eddie@example.com', 'editor-password')).rejects.toThrow()
    expect(await auth.sessionActor(await sessionHeaders('eddie@example.com', 'brand-new-password'))).toEqual(editor)

    const short = await rejection(auth.setPassword(owner, editor.id!, 'short'))
    expect(short.code).toBe('validation')
    expect(issueAt(short)).toEqual(['password'])
  })

  it('changes your own password, ending your other sessions', async () => {
    const wrong = await rejection(auth.changePassword(editor.id!, 'not-my-password', 'brand-new-password'))
    expect(wrong.code).toBe('validation')
    expect(issueAt(wrong)).toEqual(['current'])

    const short = await rejection(auth.changePassword(editor.id!, 'editor-password', 'short'))
    expect(issueAt(short)).toEqual(['password'])

    const here = await sessionHeaders('eddie@example.com', 'editor-password')
    const elsewhere = await sessionHeaders('eddie@example.com', 'editor-password')
    await auth.changePassword(editor.id!, 'editor-password', 'brand-new-password', here)
    expect(await auth.sessionActor(here)).toEqual(editor)
    expect(await auth.sessionActor(elsewhere)).toBeNull()
    expect(await auth.sessionActor(await sessionHeaders('eddie@example.com', 'brand-new-password'))).toEqual(editor)
  })

  it('lists and deletes only your own API keys', async () => {
    const keys = await auth.listApiKeys(editor.id!)
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({ name: 'editor key', lastUsedAt: null })
    expect(editorKey.startsWith(keys[0]!.start ?? 'none')).toBe(true)

    const [ownerKeyInfo] = await auth.listApiKeys(owner.id!)
    expect((await rejection(auth.deleteApiKey(editor.id!, ownerKeyInfo!.id))).code).toBe('not_found')
    expect((await rejection(auth.deleteApiKey(editor.id!, 'no-such-key'))).code).toBe('not_found')
    expect(await auth.apiKeyActor(ownerKey)).toEqual({ actor: owner, permissions: { release: [] } })

    await auth.deleteApiKey(editor.id!, keys[0]!.id)
    expect(await auth.apiKeyActor(editorKey)).toBeNull()
    expect(await auth.listApiKeys(editor.id!)).toEqual([])
  })

  it('lists only your own connected assistants, newest first', async () => {
    const { adapter } = await auth.auth.$context
    async function connect(userId: string, clientId: string, name: string | undefined, redirect: string, at: string) {
      const createdAt = new Date(at)
      await adapter.create({
        model: 'oauthClient',
        data: { clientId, ...(name !== undefined && { name }), redirectUris: [redirect], createdAt, updatedAt: createdAt },
      })
      await adapter.create({ model: 'oauthConsent', data: { clientId, userId, scopes: ['openid'], createdAt, updatedAt: createdAt } })
    }

    expect(await auth.listAssistants(editor.id!)).toEqual([])
    await connect(editor.id!, 'code-client', 'Claude Code', 'http://localhost:7777/callback', '2026-10-01T10:00:00.000Z')
    await connect(editor.id!, 'web-client', 'Claude', 'https://claude.ai/api/mcp/auth_callback', '2026-10-05T10:00:00.000Z')
    await connect(editor.id!, 'nameless-client', undefined, 'https://app.example/cb', '2026-09-01T10:00:00.000Z')
    await connect(owner.id!, 'owner-client', 'Owner tool', 'https://owner.example/cb', '2026-10-09T10:00:00.000Z')

    expect(await auth.listAssistants(editor.id!)).toEqual([
      { clientId: 'web-client', name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], connectedAt: '2026-10-05T10:00:00.000Z' },
      { clientId: 'code-client', name: 'Claude Code', redirectUris: ['http://localhost:7777/callback'], connectedAt: '2026-10-01T10:00:00.000Z' },
      { clientId: 'nameless-client', name: 'nameless-client', redirectUris: ['https://app.example/cb'], connectedAt: '2026-09-01T10:00:00.000Z' },
    ])
  })
})
