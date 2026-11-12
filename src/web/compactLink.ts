// A suggested `/compact <what to keep>` on an agent's screen, as one link over all its rows [T1112-91].
// It can start anywhere in a row, also mid-sentence after prose ("a good moment to compact: /compact keep: ...")
// [T1112-125]. Claude Code and Codex wrap a reply themselves (no xterm isWrapped): the rows after it indented
// like the paragraph belong to it, up to a blank row, the next block or a change in indentation.
// Where it ends: Claude Code shows inline code in its own colour (no backticks on screen), so with cell colours
// the link ends where that colour run ends; without them, at a closing backtick, or at the paragraph's end
// minus a trailing sentence ("... Support). Say "go" after it.").

/** A screen row. `fg`, when known, is one colour key per character of `text` ('' = the default colour); `xs`, the
 * cell each character sits in (a wide character takes two cells, so they can drift from the index). */
export type Row = { text: string; wrapped: boolean; fg?: string[]; xs?: number[] }
export type CompactHit = { top: number; bottom: number; x: number; endX: number; args: string }

// /compact as a word: at the row's start, after a space or after a backtick
const CMD = /(^|[\s`])\/compact(?=[\s`]|$)/
// a row that opens something else: a reply, the prompt, a tool result, a box, a spinner
const BLOCK = /^[⏺•❯›>⎿✻✳✽✢·*│╭╰─┌└]/
// a list item starts a new block too
const ITEM = /^(?:[-*]|\d+[.)])\s/
// rows that are never reply prose: the prompt, a box, a tool result, a spinner
const NOT_PROSE = /^[❯›>⎿✻✳✽✢·*│╭╰─┌└]/
// where a row's text starts: indent plus an optional reply marker (Claude ⏺, Codex •) or list bullet
const LEAD = /^\s*(?:(?:[⏺•]|[-*]|\d+[.)])\s+)?/

const indent = (t: string) => t.length - t.trimStart().length
const newBlock = (t: string) => BLOCK.test(t) || ITEM.test(t)

/** the command's arguments as one line: backticks around it dropped, whitespace made single spaces */
export function compactArgs(joined: string): string {
  return joined.replace(/^\s*`?\/compact/, '').replace(/`\s*$/, '').replace(/\s+/g, ' ').trim()
}

// one character of the command, where it sits on screen (y < 0: the space joining two rows Claude wrapped)
type Ch = { c: string; y: number; x: number; fg?: string }

/** The /compact that starts on row `top`, or null. `row(y)` gives a screen row (undefined past the end). */
export function compactFrom(row: (y: number) => Row | undefined, top: number, maxRows = 40): CompactHit | null {
  const first = row(top)
  if (!first || NOT_PROSE.test(first.text.trimStart())) return null
  const m = CMD.exec(first.text)
  if (!m) return null
  const slash = m.index + m[1]!.length
  const tick = first.text[slash - 1] === '`'
  const x = tick ? slash - 1 : slash
  // the paragraph's text indent: its continuation rows start there
  const base = first.wrapped ? -1 : LEAD.exec(first.text)![0].length
  const chs: Ch[] = []
  const add = (r: Row, y: number, from: number, to: number) => {
    for (let i = from; i < to; i++) chs.push({ c: r.text[i]!, y, x: i, fg: r.fg?.[i] })
  }
  add(first, top, x, first.text.length)
  let paraBase = base
  for (let y = top + 1; y < top + maxRows; y++) {
    const r = row(y)
    if (!r) break
    if (r.wrapped) {
      add(r, y, 0, r.text.length)
      continue
    }
    const t = r.text.trimEnd()
    const ind = indent(t)
    // a paragraph that began on a wrapped row: take the first own row's indent as the paragraph's
    if (paraBase < 0) paraBase = ind
    if (!t.trim() || ind !== paraBase || newBlock(t.trimStart())) break
    while (chs.length && !chs[chs.length - 1]!.c.trim()) chs.pop()
    chs.push({ c: ' ', y: -1, x: -1 })
    add(r, y, ind, t.length)
  }
  let end = chs.length
  const K = first.fg?.[slash]
  // the colour tells only when the command has its own: not the default, and not the prose's before it
  const coloured = !!K && ![...first.text.slice(0, x)].some((c, i) => c.trim() && first.fg?.[i] === K)
  if (coloured) {
    let last = 0
    for (let i = 0; i < chs.length; i++) {
      const ch = chs[i]!
      if (!ch.c.trim()) continue
      if (ch.fg !== K) break
      last = i
    }
    end = last + 1
  } else if (tick) {
    const close = chs.findIndex((ch, i) => i > 0 && ch.c === '`')
    if (close > 0) end = close + 1
  } else {
    const s = chs.map((ch) => ch.c).join('')
    // the last ". X" in it, when what follows reads as a whole sentence of prose
    let cut = -1
    for (const mm of s.matchAll(/\.\s+(?=[A-Z])/g)) cut = mm.index!
    if (cut > 0 && /[.!?]["'”’)]*\s*$/.test(s.slice(cut + 1))) end = cut
  }
  while (end > 1 && !chs[end - 1]!.c.trim()) end--
  const kept = chs.slice(0, end)
  const lastCh = [...kept].reverse().find((ch) => ch.y >= 0)!
  return { top, bottom: lastCh.y, x, endX: lastCh.y === top ? Math.max(x, lastCh.x) : lastCh.x, args: compactArgs(kept.map((ch) => ch.c).join('')) }
}

/** The /compact that covers row `y`: it starts on `y` or on a row above it. */
export function compactAt(row: (y: number) => Row | undefined, y: number, maxRows = 40): CompactHit | null {
  for (let top = y; top >= 0 && top > y - maxRows; top--) {
    const hit = compactFrom(row, top, maxRows)
    if (hit) return hit.bottom >= y ? hit : null
    const r = row(top)
    if (!r) return null
    // a blank row or another block's start: the command can't reach over it
    if (!r.wrapped && (!r.text.trim() || newBlock(r.text.trimStart()))) return null
  }
  return null
}
