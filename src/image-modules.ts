/**
 * The type of an image a site imports (`import hero from './hero.jpg'`): a `CodeImage` measured when the site is
 * bundled, for `ctx.image`. One declaration per extension in `MARKDOWN_IMAGE_TYPES`. A script file, so the
 * declarations are global wherever it is referenced.
 */
declare module '*.png' {
  const image: import('./core/registry/code-image.js').CodeImage
  export default image
}
declare module '*.jpg' {
  const image: import('./core/registry/code-image.js').CodeImage
  export default image
}
declare module '*.jpeg' {
  const image: import('./core/registry/code-image.js').CodeImage
  export default image
}
declare module '*.gif' {
  const image: import('./core/registry/code-image.js').CodeImage
  export default image
}
declare module '*.webp' {
  const image: import('./core/registry/code-image.js').CodeImage
  export default image
}
declare module '*.avif' {
  const image: import('./core/registry/code-image.js').CodeImage
  export default image
}
