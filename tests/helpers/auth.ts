import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { createAuthService, type AuthService } from '../../src/core/auth/service.js'
import type { Core } from '../../src/core/core.js'
import type { Database } from '../../src/core/db/schema.js'
import type { Actor } from '../../src/core/types.js'
import { makeCore } from './core.js'

export const TEST_BASE_URL = 'http://localhost:3000'

/**
 * `makeCore` plus migrated better-auth tables, an owner and an editor, and an
 * API key for each. better-auth uses the real clock, unlike the core.
 */
export async function makeAuth(): Promise<{
  core: Core
  db: Kysely<Database>
  auth: AuthService
  owner: Actor
  editor: Actor
  ownerKey: string
  editorKey: string
}> {
  const { core, db } = await makeCore()
  const auth = createAuthService({ db, secret: randomBytes(32).toString('base64url'), baseUrl: TEST_BASE_URL, rateLimit: false })
  await auth.migrate()
  const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia Owner', password: 'owner-password', role: 'owner' })
  const editor = await auth.createUser({ email: 'eddie@example.com', name: 'Eddie Editor', password: 'editor-password', role: 'editor' })
  const ownerKey = await auth.createApiKey(owner.id!, 'owner key')
  const editorKey = await auth.createApiKey(editor.id!, 'editor key')
  return { core, db, auth, owner, editor, ownerKey, editorKey }
}
