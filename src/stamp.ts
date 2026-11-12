// The time of the newest line in a chunk of JSONL (a Claude transcript or a Codex rollout) [T1112-7].
// Idle time comes from these, never from the file's mtime: something touches running sessions'
// transcripts every hour without writing a line, and the mtime then made every session look active.
const TS = /"timestamp":"(\d{4}-\d\d-\d\dT[^"]+)"/g

/** The latest "timestamp" in these lines, or 0 when none has one. Looks from the end and stops at the first line with one. */
export function lastStamp(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"timestamp":"')) continue
    let best = 0
    // a line can hold several (a nested message has its own): take the newest
    for (const x of line.matchAll(TS)) {
      const t = Date.parse(x[1]!)
      if (Number.isFinite(t) && t > best) best = t
    }
    if (best) return Math.min(best, Date.now())
  }
  return 0
}

const NL = 10
const TS_BYTES = Buffer.from('"timestamp":"')
/** The newest "timestamp" on the last line of `whole` that has one, or 0 (lastStamp on the bytes of src/lines.ts eachLine). */
export function lastStampIn(whole: Buffer): number {
  let from = whole.length
  while (from > 0) {
    const at = whole.lastIndexOf(TS_BYTES, from - 1)
    if (at < 0) return 0
    const a = whole.lastIndexOf(NL, at) + 1
    let b = whole.indexOf(NL, at)
    if (b < 0) b = whole.length
    let best = 0
    // a line can hold several (a nested message has its own): take the newest
    for (const x of whole.toString('utf8', a, b).matchAll(TS)) {
      const t = Date.parse(x[1]!)
      if (Number.isFinite(t) && t > best) best = t
    }
    if (best) return Math.min(best, Date.now())
    from = a
  }
  return 0
}

