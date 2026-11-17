import { isTitleTemplate } from '../../core/fields/builtins.js'
import type { RenderContext, ResolvedImage } from '../../core/registry/render.js'
import type { Registry } from '../../core/registry/registry.js'
import type { ImageValue } from '../../core/types.js'

/** The site's effective search and sharing defaults for one render. */
export interface SeoDefaults {
  titleTemplate: string | null
  description: string | null
  /** Absolute URL of the default share image. */
  image: string | null
}

const RASTER = /^image\/(jpeg|png|webp|gif|avif|tiff)$/

const filled = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** The 1280px JPEG variant of a raster `image`, as an absolute URL; `null` for none or a non-raster one. */
export function mediaShareImage(image: ResolvedImage | null, baseUrl: string): string | null {
  if (!image || !RASTER.test(image.mime)) return null
  return `${baseUrl}/media/${encodeURIComponent(image.id)}/1280.jpeg`
}

/**
 * Each default from the `f.seoDefaults()` global (read through `ctx`, so preview and its per-render cache apply)
 * when filled in, then from the site's code, then `null`.
 */
export async function resolveSeoDefaults(registry: Registry, ctx: RenderContext, baseUrl: string): Promise<SeoDefaults> {
  let stored: { titleTemplate?: unknown; description?: unknown; image?: unknown } = {}
  if (registry.seoDefaults) {
    const fields = (await ctx.global(registry.seoDefaults.global)) as Record<string, unknown> | null
    const value = fields?.[registry.seoDefaults.field]
    if (value && typeof value === 'object') stored = value
  }
  const code = registry.site.seo
  const titleTemplate = filled(stored.titleTemplate) && isTitleTemplate(stored.titleTemplate) ? stored.titleTemplate : null
  const description = filled(stored.description) ? stored.description : null
  const image = mediaShareImage(ctx.image(stored.image as ImageValue | undefined), baseUrl)
  return {
    titleTemplate: titleTemplate ?? code.titleTemplate ?? null,
    description: description ?? (filled(code.description) ? code.description : null),
    image: image ?? (code.image ? `${baseUrl}${ctx.asset(code.image)}` : null),
  }
}

/** `seoTitle` exactly when set; else `fallback`, through `titleTemplate` unless on the home page. */
export function pageTitle(fallback: string, seoTitle: string | undefined, titleTemplate: string | null, home: boolean): string {
  if (seoTitle) return seoTitle
  if (titleTemplate === null || home) return fallback
  return titleTemplate.replace('%s', () => fallback)
}

/** Whether `path` is the home page: `/` or a locale root such as `/es`. */
export function isHomePath(registry: Registry, path: string | null): boolean {
  if (path === null) return false
  return path === '/' || registry.locales.some((locale) => path === `/${locale}`)
}
