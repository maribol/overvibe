import { expect, test } from 'bun:test'
import { compactAt, compactArgs, type Row } from './web/compactLink'

const screen = (lines: string[], wrapped: number[] = []) => (y: number): Row | undefined =>
  y < 0 || y >= lines.length ? undefined : { text: lines[y]!, wrapped: wrapped.includes(y) }

// a Claude reply that ends with a suggestion Claude Code wrapped itself (indented continuation rows)
const claude = [
  '⏺ Shipped: the link opens the file.',
  '',
  '  Context is about 60% of the window; a good break.',
  '  /compact keep: T1111-7 queued (waits on the deploy window); the',
  '  findpath scratch in ~/scratchpad/agent-deck/findpath; not mine',
  '  to push',
  '',
  '❯ ',
]

test('a wrapped Claude suggestion is one link from /compact to the end of the paragraph', () => {
  const want = { top: 3, bottom: 5, x: 2, endX: 8, args: 'keep: T1111-7 queued (waits on the deploy window); the findpath scratch in ~/scratchpad/agent-deck/findpath; not mine to push' }
  for (const y of [3, 4, 5]) expect(compactAt(screen(claude), y)).toEqual(want)
  for (const y of [0, 1, 2, 6, 7]) expect(compactAt(screen(claude), y)).toBeNull()
})

test('xterm-wrapped rows join without a space; the next block ends it', () => {
  const lines = ['⏺ /compact keep: the open tas', 'ks and the branch', '⏺ Next reply', '  more']
  expect(compactAt(screen(lines, [1]), 1)).toEqual({ top: 0, bottom: 1, x: 2, endX: 16, args: 'keep: the open tasks and the branch' })
  expect(compactAt(screen(lines, [1]), 3)).toBeNull()
})

test('Codex bullets, backticks and a bare /compact', () => {
  expect(compactAt(screen(['• `/compact keep the plan`']), 0)?.args).toBe('keep the plan')
  expect(compactAt(screen(['  /compact']), 0)).toEqual({ top: 0, bottom: 0, x: 2, endX: 9, args: '' })
})

test('not a suggestion: the typed prompt, other commands, less indented rows', () => {
  expect(compactAt(screen(['❯ /compact keep x']), 0)).toBeNull()
  expect(compactAt(screen(['> /compact keep x']), 0)).toBeNull()
  expect(compactAt(screen(['  /compact is how you start']), 0)?.args).toBe('is how you start')
  expect(compactAt(screen(['  /compacted']), 0)).toBeNull()
  const lines = ['    /compact keep: a', '  b is a new paragraph']
  expect(compactAt(screen(lines), 0)?.bottom).toBe(0)
  expect(compactAt(screen(lines), 1)).toBeNull()
})

test('arguments come out on one line', () => {
  expect(compactArgs('/compact   keep:\n  a;   b  ')).toBe('keep: a; b')
})

// [T1112-125] the owner's two real shapes: the suggestion starts mid-row after prose and wraps over 3 to 4 rows.
// Claude Code word-wraps a reply itself ("⏺ " on the first row, two spaces on the rest) and shows the inline
// code in its own colour, without backticks.
const PROSE1 = 'Nothing is running, so this is a good moment to compact before I start them: '
const KEEP1 = 'keep: next = Checkouts section T1111-62, dunning emails T1112-28, refund webhooks T1112-31 (src/billing/refunds.ts; waits on Stripe test keys); owner asks (Billing for Ops, subscriptions.retry for Support)'
const TAIL1 = '. Say "go" after it and I\'ll start them.'
const PROSE2 = 'A good moment to compact: '
const KEEP2 = 'keep: launched 1.0.0 public (f8d8c7c, tag v1.0.0, private reporting on); header declutter agent running (T1112-124); compact link fix queued (T1112-125, ~/Work/apps/agent-deck/src/web/compactLink.ts); per-project account menu, ⌘T button'

/** a Claude reply paragraph word-wrapped at `cols`, with colours: 'code' from /compact to the code's end */
function claudeRows(prose: string, keep: string, tail: string, cols: number, colours: boolean): Row[] {
  const parts: [string, string][] = [[prose, ''], ['/compact ' + keep, 'code'], [tail, '']]
  const chars: [string, string][] = parts.flatMap(([t, k]) => [...t].map((c): [string, string] => [c, k]))
  const rows: Row[] = []
  let i = 0
  while (i < chars.length) {
    const lead = rows.length ? '  ' : '⏺ '
    let n = Math.min(cols - lead.length, chars.length - i)
    if (i + n < chars.length) {
      const sp = chars.slice(i, i + n + 1).map((c) => c[0]).lastIndexOf(' ')
      if (sp > 0) n = sp
    }
    const seg = chars.slice(i, i + n)
    i += n
    while (chars[i]?.[0] === ' ') i++
    const text = (lead + seg.map((c) => c[0]).join('')).trimEnd()
    rows.push({ text, wrapped: false, fg: colours ? [...lead].map(() => '').concat(seg.map((c) => c[1])).slice(0, text.length) : undefined })
  }
  return rows
}
const around = (rows: Row[]) => {
  const all: Row[] = [{ text: '⏺ Done.', wrapped: false }, { text: '', wrapped: false }, ...rows, { text: '', wrapped: false }, { text: '❯ ', wrapped: false }]
  return (y: number) => all[y]
}

for (const cols of [160, 120]) {
  for (const colours of [true, false]) {
    const how = `${cols} columns, ${colours ? 'with' : 'without'} colours`
    test(`mid-row suggestion followed by prose on its last row (${how})`, () => {
      const rows = claudeRows(PROSE1, KEEP1, TAIL1, cols, colours)
      expect(rows.length).toBeGreaterThanOrEqual(cols === 160 ? 2 : 3)
      const at = around(rows)
      const hit = compactAt(at, 2)!
      expect(hit.args).toBe(KEEP1)
      expect(hit.top).toBe(2)
      expect(hit.x).toBe(2 + PROSE1.length)
      // the link ends at "Support)", before ". Say" (on that row, or a row before the tail's own)
      const endRow = rows.findIndex((r) => r.text.includes('Support)'))
      expect(hit.bottom).toBe(2 + endRow)
      expect(rows[endRow]!.text.slice(0, hit.endX + 1).endsWith('Support)')).toBe(true)
      for (let y = 2; y <= 2 + endRow; y++) expect(compactAt(at, y)).toEqual(hit)
      for (let y = 3 + endRow; y < 2 + rows.length; y++) expect(compactAt(at, y)).toBeNull()
      expect(compactAt(at, 0)).toBeNull()
      expect(compactAt(at, 1)).toBeNull()
      expect(compactAt(at, 2 + rows.length)).toBeNull()
    })
    test(`mid-row suggestion running to the paragraph's end (${how})`, () => {
      const rows = claudeRows(PROSE2, KEEP2, '', cols, colours)
      expect(rows.length).toBeGreaterThanOrEqual(2)
      const at = around(rows)
      const hit = compactAt(at, 2 + rows.length - 1)!
      expect(hit.args).toBe(KEEP2)
      expect(hit.x).toBe(2 + PROSE2.length)
      expect(hit.bottom).toBe(2 + rows.length - 1)
      expect(hit.endX).toBe(rows[rows.length - 1]!.text.length - 1)
    })
  }
}

test('colours: the code ends mid-row even when the prose after it has no sentence shape', () => {
  const rows = claudeRows('Compact now: ', 'keep: a; b (c)', ' then carry on', 60, true)
  expect(compactAt(around(rows), 2)!.args).toBe('keep: a; b (c)')
})

test('mid-row inline code with backticks ends at the closing backtick', () => {
  expect(compactAt(screen(['  When ready, run `/compact keep: the plan; T1-2` and say go']), 0)).toMatchObject({ x: 18, args: 'keep: the plan; T1-2' })
})

test('a change in indentation ends the paragraph', () => {
  const lines = ['  Good break: /compact keep: a', '  b', '    c']
  expect(compactAt(screen(lines), 0)?.args).toBe('keep: a b')
})
