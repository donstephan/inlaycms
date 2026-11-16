import { jsx, Fragment } from './jsx-runtime.js'

export { Fragment }
export type { JSX } from './jsx-runtime.js'

export function jsxDEV(
  type: Parameters<typeof jsx>[0],
  props: Parameters<typeof jsx>[1],
  key?: unknown,
  _isStatic?: boolean,
  _source?: unknown,
  _self?: unknown,
) {
  return jsx(type, props, key)
}
