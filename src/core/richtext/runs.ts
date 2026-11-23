import type { RichTextDoc, RichTextNode, RichTextText } from './schema.js'

export interface TextPiece {
  node: RichTextText
  start: number
  end: number
}

export interface TextRun {
  text: string
  pieces: TextPiece[]
}

/** The text of a document in runs: one per block, split again at each hard break and image. Runs with no text are left out. */
export function textRuns(doc: RichTextDoc): TextRun[] {
  const runs: TextRun[] = []
  let current: TextRun = { text: '', pieces: [] }
  const flush = () => {
    if (current.pieces.length > 0) runs.push(current)
    current = { text: '', pieces: [] }
  }
  const walk = (node: RichTextNode) => {
    if (node.type === 'text') {
      if (node.text === '') return
      current.pieces.push({ node, start: current.text.length, end: current.text.length + node.text.length })
      current.text += node.text
      return
    }
    if (node.type === 'hardBreak' || node.type === 'image') {
      flush()
      return
    }
    flush()
    for (const child of (node.content ?? []) as RichTextNode[]) walk(child)
    flush()
  }
  for (const node of doc.content) walk(node)
  flush()
  return runs
}
