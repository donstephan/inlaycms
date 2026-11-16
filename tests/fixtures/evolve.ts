import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import {
  defineBlock,
  defineTemplate,
  type BlockDef,
  type SiteDefinition,
  type TemplateDef,
  type TypeDef,
} from '../../src/core/registry/define.js'
import { Hero, HomePage, Post, site, Testimonial } from './site.js'

/** A copy of `site` with the type called `name` replaced by `{ ...type, ...patch }`. */
export function withType(site: SiteDefinition, name: string, patch: Partial<TypeDef>): SiteDefinition {
  const swap = <T extends TypeDef>(types: T[]): T[] =>
    types.map((t) => (t.name === name ? ({ ...t, ...patch } as T) : t))
  return {
    ...site,
    singletons: swap(site.singletons),
    collections: swap(site.collections),
    globals: swap(site.globals),
  }
}

/** A copy of `template` with slot `key` set to `block` (added at the end if new). */
export function withSlot(template: TemplateDef, key: string, block: BlockDef): TemplateDef {
  return { ...template, slots: { ...template.slots, [key]: { ...template.slots[key], block } } }
}

const { headline: _headline, ...heroWithoutHeadline } = Hero.schema.shape

/** Hero with `headline` renamed to `title`: a removal plus an addition (spec §6.1). */
export const HeroTitled = defineBlock({
  ...Hero,
  schema: z.object({ ...heroWithoutHeadline, title: f.text({ label: 'Title', maxLength: 60 }) }),
  render: (p) => `<section class="hero hero--${p.variant}"><h1>${p.title}</h1></section>`,
})

export const homeTitledSite = withType(site, 'home', { template: withSlot(HomePage, 'hero', HeroTitled) })

export const PostWithSummary = defineTemplate({
  ...Post,
  fields: Post.fields.extend({ summary: f.textarea({ label: 'Summary' }) }),
})

export const postSummarySite = withType(site, 'posts', { template: PostWithSummary })

export const TestimonialRated = defineTemplate({
  ...Testimonial,
  fields: Testimonial.fields.extend({ rating: f.number({ label: 'Rating', integer: true }) }),
})

export const ratedSite = withType(site, 'testimonials', { template: TestimonialRated })

const { quotes: _quotes, ...slotsWithoutQuotes } = HomePage.slots

/** `site` without the testimonials collection and without the home slot that references it: testimonial content is hidden. */
export const noTestimonialsSite: SiteDefinition = {
  ...withType(site, 'home', { template: { ...HomePage, slots: slotsWithoutQuotes } }),
  collections: site.collections.filter((c) => c.name !== 'testimonials'),
  content: site.content.filter((c) => c.type !== 'testimonials'),
}
