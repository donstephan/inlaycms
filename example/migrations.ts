import type { ReleaseMigration } from 'inlaycms/site'

/**
 * Migration functions run once per release, in order, when the release is activated.
 * Add one when a release changes the shape of stored content. `read` returns the stored
 * data and `save` takes the same shape back, so edit what you read and save it:
 *
 *   defineMigration({
 *     name: '2026-11-rename-summary',
 *     async run(ctx) {
 *       const changed: string[] = []
 *       for (const doc of await ctx.list('services')) {
 *         const { head, published } = await ctx.read(doc.id)
 *         if (!head) continue
 *         const { summary, ...fields } = head.fields
 *         await ctx.save(doc.id, { ...head, fields: { ...fields, intro: summary } })
 *         if (published) changed.push(doc.id)
 *       }
 *       await ctx.publish(changed)
 *     },
 *   })
 */
export const migrations: ReleaseMigration[] = []
