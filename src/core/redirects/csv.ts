import { t } from '../messages/index.js'

export interface CsvResult {
  rows: Array<{ line: number; cells: string[] }>
  problems: Array<{ line: number; message: string }>
}

/**
 * Parses RFC 4180 CSV: quoted cells, doubled quotes, CRLF or LF line endings.
 * Strips a BOM and skips blank lines. Each row carries the line it starts on.
 */
export function parseCsv(text: string): CsvResult {
  const src = text.startsWith('﻿') ? text.slice(1) : text
  const rows: CsvResult['rows'] = []
  const problems: CsvResult['problems'] = []
  let line = 1
  let i = 0
  while (i < src.length) {
    const start = line
    const cells: string[] = []
    let cell = ''
    let fresh = true
    let quoted = false
    while (i < src.length) {
      const c = src[i]!
      if (quoted) {
        if (c === '"' && src[i + 1] === '"') {
          cell += '"'
          i += 2
        } else if (c === '"') {
          quoted = false
          i++
        } else {
          if (c === '\n') line++
          cell += c
          i++
        }
        continue
      }
      if (c === '"' && fresh) {
        quoted = true
        fresh = false
        i++
      } else if (c === ',') {
        cells.push(cell)
        cell = ''
        fresh = true
        i++
      } else if (c === '\n' || c === '\r') {
        i += c === '\r' && src[i + 1] === '\n' ? 2 : 1
        line++
        break
      } else {
        cell += c
        fresh = false
        i++
      }
    }
    if (quoted) {
      problems.push({ line: start, message: t('csv.unterminatedQuote', { line: start }) })
      break
    }
    cells.push(cell)
    if (cells.length > 1 || cells[0]!.trim() !== '') rows.push({ line: start, cells })
  }
  return { rows, problems }
}
