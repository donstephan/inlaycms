import { assertCan, can, systemCtx, type Action } from '../../src/core/auth/roles.js'
import { InlayError } from '../../src/core/errors.js'
import type { Ctx } from '../../src/core/types.js'

const actions: Action[] = [
  'content.read',
  'content.write',
  'content.publish',
  'entry.delete',
  'entry.restore',
  'backup.create',
  'backup.read',
  'content.export',
  'content.import',
  'media.write',
  'redirects.write',
  'users.manage',
  'site.protect',
]
const ownerOnly: Action[] = ['entry.restore', 'backup.create', 'backup.read', 'content.export', 'content.import', 'users.manage', 'site.protect']

describe('roles', () => {
  it('lets owners and the system do everything', () => {
    for (const action of actions) {
      expect(can('owner', action)).toBe(true)
      expect(can('system', action)).toBe(true)
    }
  })

  it('lets editors do everything except restoring entries, backups and managing users', () => {
    for (const action of actions) {
      expect(can('editor', action), action).toBe(!ownerOnly.includes(action))
    }
    expect(can('editor', 'backup.create')).toBe(false)
    expect(can('editor', 'backup.read')).toBe(false)
    expect(can('editor', 'content.export')).toBe(false)
    expect(can('editor', 'content.import')).toBe(false)
    expect(can('editor', 'users.manage')).toBe(false)
    expect(can('editor', 'media.write')).toBe(true)
    expect(can('editor', 'redirects.write')).toBe(true)
  })

  it('assertCan throws forbidden', () => {
    const editor: Ctx = { actor: { id: 'e', name: 'Ed', role: 'editor' }, source: 'admin' }
    expect(() => assertCan(editor, 'entry.delete')).not.toThrow()
    try {
      assertCan(editor, 'entry.restore')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(InlayError)
      expect((e as InlayError).code).toBe('forbidden')
    }
  })

  it('systemCtx acts as System', () => {
    expect(systemCtx('release')).toEqual({
      actor: { id: null, name: 'System', role: 'system' },
      source: 'release',
    })
  })
})
