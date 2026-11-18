import { z } from 'zod'
import { validateValues } from '../../src/core/content/validate.js'
import { f } from '../../src/core/fields/builtins.js'

const fields = z.object({
  id: f.text({ label: 'Container ID', pattern: /^GTM-[A-Z0-9]+$/, patternHint: 'It looks like GTM-ABC123.' }),
  note: f.text({ label: 'Note' }).optional(),
})

describe('validateValues', () => {
  it('strict: a missing required field is reported by its label', () => {
    const r = validateValues(fields, {}, 'strict')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]?.message).toContain('Container ID is required')
  })

  it('strict: a pattern failure names the field and carries the hint', () => {
    const r = validateValues(fields, { id: '<script>' }, 'strict')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.issues[0]?.message).toContain('Container ID')
      expect(r.issues[0]?.message).toContain('It looks like GTM-ABC123.')
    }
  })

  it('strict: a blank optional field is fine', () => {
    expect(validateValues(fields, { id: 'GTM-A1', note: '' }, 'strict').ok).toBe(true)
  })

  it('draft: an empty object and a non-matching id are both fine', () => {
    expect(validateValues(fields, {}, 'draft').ok).toBe(true)
    expect(validateValues(fields, { id: 'nope' }, 'draft').ok).toBe(true)
  })

  it('returns the parsed data on success', () => {
    const r = validateValues(fields, { id: 'GTM-A1' }, 'strict')
    expect(r.ok && (r.data as Record<string, unknown>).id).toBe('GTM-A1')
  })
})
