import { groupActivity } from '../../src/adapters/admin/activity.js'
import type { Activity, DocumentSummary, RevisionSource } from '../../src/core/types.js'

const now = new Date('2026-11-02T10:00:00.000Z')

const doc = (id: string): DocumentSummary => ({ id, title: `Doc ${id}` }) as DocumentSummary

const edit = (at: string, id: string, authorName = 'Eddie Editor', source: RevisionSource = 'admin'): Activity => ({
  kind: 'edit',
  at,
  authorName,
  source,
  document: doc(id),
  revisionId: 1,
  count: 1,
})

/** `count` items, newest first, `gapMs` apart, ending at `end`. */
const burst = (end: string, count: number, gapMs: number, make: (at: string, i: number) => Activity): Activity[] =>
  Array.from({ length: count }, (_, i) => make(new Date(Date.parse(end) - i * gapMs).toISOString(), i))

describe('groupActivity', () => {
  it('merges a burst of edits by the same person into one line', () => {
    const items = burst('2026-11-02T09:00:00.000Z', 18, 1000, (at, i) => edit(at, `d${i}`, 'Inlay', 'release'))
    const days = groupActivity(items, now)
    expect(days).toHaveLength(1)
    expect(days[0]!.lines).toHaveLength(1)
    const line = days[0]!.lines[0]!
    expect(line.kind).toBe('edits')
    if (line.kind !== 'edits') throw new Error('expected edits')
    expect(line.documents).toHaveLength(18)
    expect(line.authorName).toBe('Inlay')
    expect(line.source).toBe('release')
    expect(line.at).toBe('2026-11-02T09:00:00.000Z')
  })

  it('keeps edits apart when the person, the source or a 10-minute gap differs', () => {
    const items: Activity[] = [
      edit('2026-11-02T09:30:00.000Z', 'a'),
      edit('2026-11-02T09:29:00.000Z', 'b', 'Olivia Owner'),
      edit('2026-11-02T09:28:00.000Z', 'c', 'Olivia Owner', 'mcp'),
      edit('2026-11-02T09:27:00.000Z', 'd', 'Olivia Owner', 'mcp'),
      edit('2026-11-02T09:10:00.000Z', 'e', 'Olivia Owner', 'mcp'),
    ]
    const lines = groupActivity(items, now)[0]!.lines
    expect(lines.map((l) => l.kind)).toEqual(['edit', 'edit', 'edits', 'edit'])
    const merged = lines[2]!
    if (merged.kind !== 'edits') throw new Error('expected edits')
    expect(merged.documents.map((d) => d.id)).toEqual(['c', 'd'])
  })

  it('does not merge across publishes', () => {
    const items: Activity[] = [
      edit('2026-11-02T09:30:00.000Z', 'a'),
      { kind: 'publish', at: '2026-11-02T09:29:00.000Z', authorName: 'Eddie Editor', source: 'admin', documents: [doc('a')] },
      edit('2026-11-02T09:28:00.000Z', 'b'),
    ]
    expect(groupActivity(items, now)[0]!.lines.map((l) => l.kind)).toEqual(['edit', 'publish', 'edit'])
  })

  it('labels days Today, Yesterday, then by date', () => {
    const items = [
      edit('2026-11-02T08:00:00.000Z', 'a'),
      edit('2026-11-01T08:00:00.000Z', 'b'),
      edit('2026-10-30T08:00:00.000Z', 'c'),
      edit('2025-12-31T08:00:00.000Z', 'd'),
    ]
    expect(groupActivity(items, now).map((d) => d.day)).toEqual(['Today', 'Yesterday', 'Oct 30', 'Dec 31, 2025'])
  })

  it('uses UTC calendar days', () => {
    const items = [edit('2026-11-01T23:59:00.000Z', 'a'), edit('2026-11-02T00:01:00.000Z', 'b')].reverse()
    expect(groupActivity(items, now).map((d) => d.day)).toEqual(['Today', 'Yesterday'])
  })
})
