import { z } from 'zod'
import { createCore, readOnlyCore } from '../../src/core/core.js'
import { f } from '../../src/core/fields/builtins.js'
import { readIntegrationRows } from '../../src/core/integrations/integrations.js'
import { defineIntegration } from '../../src/core/registry/integration.js'
import { site as fixtureSite } from '../fixtures/site.js'
import { makeCore } from '../helpers/core.js'

const gtm = (pattern = /^GTM-[A-Z0-9]+$/) =>
  defineIntegration({
    name: 'gtm',
    label: 'Tag manager',
    fields: z.object({ id: f.text({ label: 'Container ID', pattern }), note: f.text({ label: 'Note' }).optional() }),
    head: () => '',
  })
const chat = defineIntegration({ name: 'chat', label: 'Chat', head: () => '' })
const siteWith = (...integrations: ReturnType<typeof defineIntegration>[]) => ({ ...fixtureSite, integrations })

describe('integration settings', () => {
  it('lists every defined integration, off and empty before any save', async () => {
    const { core, owner } = await makeCore({ site: siteWith(gtm(), chat) })
    const list = await core.integrations(owner)
    expect(list.map((s) => [s.def.name, s.enabled, s.values, s.active, s.updatedAt])).toEqual([
      ['gtm', false, {}, false, null],
      ['chat', false, {}, false, null],
    ])
  })

  it('an editor cannot list or save', async () => {
    const { core, editor } = await makeCore({ site: siteWith(gtm()) })
    await expect(core.integrations(editor)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(core.saveIntegration('gtm', { enabled: false, values: {} }, editor)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('saves switched off with a missing or non-matching value', async () => {
    const { core, owner } = await makeCore({ site: siteWith(gtm()) })
    await core.saveIntegration('gtm', { enabled: false, values: { id: 'nope' } }, owner)
    const [state] = await core.integrations(owner)
    expect(state?.values).toEqual({ id: 'nope' })
    expect(state?.active).toBe(false)
    expect(state?.updatedAt).not.toBeNull()
    await core.saveIntegration('gtm', { enabled: false, values: {} }, owner)
  })

  it('refuses to switch on with a missing required value', async () => {
    const { core, owner } = await makeCore({ site: siteWith(gtm()) })
    const err = await core.saveIntegration('gtm', { enabled: true, values: {} }, owner).catch((e) => e)
    expect(err).toMatchObject({ code: 'validation' })
    expect(JSON.stringify(err.details.issues[0])).toContain('Container ID')
  })

  it('refuses to switch on with a non-matching value', async () => {
    const { core, owner } = await makeCore({ site: siteWith(gtm()) })
    await expect(core.saveIntegration('gtm', { enabled: true, values: { id: 'nope' } }, owner)).rejects.toMatchObject({ code: 'validation' })
  })

  it('saves switched on with valid values and reports it active', async () => {
    const def = gtm()
    const { core, owner } = await makeCore({ site: siteWith(def) })
    await core.saveIntegration('gtm', { enabled: true, values: { id: 'GTM-A1' } }, owner)
    expect(await core.activeIntegrations()).toEqual([{ def, values: { id: 'GTM-A1' } }])
    expect((await core.integrations(owner))[0]?.active).toBe(true)
  })

  it('an integration with no fields is active as soon as it is on', async () => {
    const { core, owner } = await makeCore({ site: siteWith(gtm(), chat) })
    await core.saveIntegration('chat', { enabled: true, values: {} }, owner)
    expect((await core.activeIntegrations()).map((a) => a.def.name)).toEqual(['chat'])
  })

  it('unknown values are dropped and an unknown name is refused', async () => {
    const { core, owner, db } = await makeCore({ site: siteWith(gtm()) })
    await core.saveIntegration('gtm', { enabled: true, values: { id: 'GTM-A1', extra: 1 } }, owner)
    expect(await readIntegrationRows(db)).toEqual([{ name: 'gtm', enabled: true, values: { id: 'GTM-A1' } }])
    await expect(core.saveIntegration('nope', { enabled: false, values: {} }, owner)).rejects.toMatchObject({ messageId: 'integrations.unknown' })
  })

  it('a save is a live change', async () => {
    const { core, owner } = await makeCore({ site: siteWith(gtm()) })
    const spy = vi.fn()
    core.onLiveChange(spy)
    await core.saveIntegration('gtm', { enabled: true, values: { id: 'GTM-A1' } }, owner)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a read-only core refuses the save', async () => {
    const { core, owner } = await makeCore({ site: siteWith(gtm()) })
    await expect(readOnlyCore(core).saveIntegration('gtm', { enabled: false, values: {} }, owner)).rejects.toMatchObject({
      code: 'read_only',
      messageId: 'error.previewReadOnly',
    })
  })

  it('saved values that no longer pass are kept but not active', async () => {
    const { core, owner, db } = await makeCore({ site: siteWith(gtm()) })
    await core.saveIntegration('gtm', { enabled: true, values: { id: 'GTM-A1' } }, owner)
    const second = createCore({ site: siteWith(gtm(/^G-/)), db })
    expect(await second.activeIntegrations()).toEqual([])
    const [state] = await second.integrations(owner)
    expect(state).toMatchObject({ enabled: true, values: { id: 'GTM-A1' }, active: false })
  })

  it('a row for an integration the site no longer defines is ignored and kept', async () => {
    const { core, owner, db } = await makeCore({ site: siteWith(gtm()) })
    await core.saveIntegration('gtm', { enabled: true, values: { id: 'GTM-A1' } }, owner)
    const second = createCore({ site: siteWith(chat), db })
    expect((await second.integrations(owner)).map((s) => s.def.name)).toEqual(['chat'])
    expect((await readIntegrationRows(db)).map((r) => r.name)).toEqual(['gtm'])
    const third = createCore({ site: siteWith(gtm()), db })
    expect(await third.integrations(owner)).toMatchObject([{ enabled: true, values: { id: 'GTM-A1' } }])
  })
})
