import { articleSite } from '../fixtures/articles.js'
import { pdf, png } from '../fixtures/media.js'
import { makeCore } from '../helpers/core.js'

async function setup() {
  const ctx = await makeCore({ site: articleSite, media: true })
  await ctx.core.applyShippedContent()
  const home = (await ctx.core.findSingleton('home'))!
  return { ...ctx, home }
}

type S = Awaited<ReturnType<typeof setup>>

async function setHero(s: S, value: unknown) {
  const doc = (await s.core.getDocument(s.home.id))!
  return s.core.patchDraft(
    s.home.id,
    { baseRevisionId: doc.headRev, ops: [{ path: ['slots', 'hero', 'data', 'image'], value }] },
    s.owner,
  )
}

const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e)

describe('media references', () => {
  it('rejects a hash the library has never had', async () => {
    const s = await setup()
    const err = await fail(setHero(s, { media: 'a'.repeat(64) }))
    expect(err).toMatchObject({ code: 'validation' })
    expect(err.details.issues).toMatchObject([{ code: 'not_found', labels: ['Hero', 'Image'] }])
  })

  it('keeps a PDF out of an image field but allows it in a file field', async () => {
    const s = await setup()
    const { media } = await s.core.addMedia({ data: pdf(), filename: 'doc.pdf' }, s.owner)
    const err = await fail(setHero(s, { media: media.id }))
    expect(err.details.issues).toMatchObject([{ code: 'wrong_media_type', labels: ['Hero', 'Image'] }])

    const bad = await fail(s.core.createEntry('articles', { fields: { title: 'A', cover: { media: media.id } } }, s.owner))
    expect(bad.details.issues).toMatchObject([{ code: 'wrong_media_type' }])

    const ok = await s.core.createEntry('articles', { fields: { title: 'A', attachment: { media: media.id } } }, s.owner)
    expect(ok).toBeTruthy()
  })

  it('restores a revision using deleted media, blocks publishing, then recovers on re-upload', async () => {
    const s = await setup()
    const bytes = await png(40, 20)
    const { media } = await s.core.addMedia({ data: bytes, filename: 'photo.png' }, s.owner)
    await setHero(s, { media: media.id })
    const revA = (await s.core.getDocument(s.home.id))!.headRev!
    await setHero(s, undefined)
    await s.core.deleteMedia(media.id, s.owner)

    await s.core.restoreRevision(s.home.id, revA, s.owner)
    const err = await fail(s.core.publish([s.home.id], s.owner))
    expect(err).toMatchObject({ code: 'validation' })
    const issue = err.details.documents[0].issues[0]
    expect(issue).toMatchObject({ code: 'missing_media', labels: ['Hero', 'Image'] })
    expect(issue.message).toContain('photo.png')

    const doc = (await s.core.getDocument(s.home.id))!
    const headline = await s.core.patchDraft(
      s.home.id,
      { baseRevisionId: doc.headRev, ops: [{ path: ['slots', 'hero', 'data', 'headline'], value: 'New' }] },
      s.owner,
    )
    expect(headline).toBeTruthy()

    await s.core.addMedia({ data: bytes, filename: 'other.png' }, s.owner)
    await expect(s.core.publish([s.home.id], s.owner)).resolves.toBeTruthy()
  })
})
