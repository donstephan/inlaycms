/**
 * The type of a `.md` file a site imports (`import post from './posts/x.md'`): its text, with relative image targets
 * already pointing at their files. A script file, so the declaration is global wherever it is referenced.
 */
declare module '*.md' {
  const text: string
  export default text
}
