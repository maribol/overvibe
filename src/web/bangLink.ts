// A `! <command>` the agent asks the owner to run [T1114-1] ("run this yourself: ! cd ~/app && bash deploy.sh"),
// as one link over every row it wraps to. Only a paragraph that starts with it counts: a reply line, a list item's
// text, or a row of its own. Claude Code wraps long lines itself, indenting the rest like the paragraph; a row
// continues the command only when the row before was full (its next word would not have fitted), so the prose
// after it, even with no blank row between, stays out.
import type { Row } from './compactLink'

export type BangHit = { top: number; bottom: number; x: number; endX: number; cmd: string }

// where a row's text starts: indent plus an optional reply marker (Claude ⏺, Codex •) or list bullet
const LEAD = /^\s*(?:(?:[⏺•]|[-*]|\d+[.)])\s+)?/
// the command: "!" then a space or not, then something that is not more punctuation ("!!", "! ..." stay prose)
const BANG = /^!\s*(?=[\w~$"'(-]|\.{1,2}\/|\/)/
// rows that open something else: the prompt, a box, a tool result, a spinner, a list item
const BLOCK = /^(?:[⏺•❯›>⎿✻✳✽✢·*│╭╰─┌└]|[-*]\s|\d+[.)]\s)/

/** The `!` command whose first row is `top`, or null. `cols`: the terminal's width, for Claude's own wrapping. */
export function bangFrom(row: (y: number) => Row | undefined, top: number, cols = 0, maxRows = 12): BangHit | null {
  const first = row(top)
  if (!first || first.wrapped) return null
  const lead = LEAD.exec(first.text)![0]
  // the prompt row is the owner's own input, not a suggestion
  if (/^\s*[❯›>]/.test(first.text)) return null
  const rest = first.text.slice(lead.length)
  if (!BANG.test(rest)) return null
  const x = lead.length
  const parts = [first.text.slice(x).trimEnd()]
  let bottom = top
  let endX = x + parts[0]!.length - 1
  let prev = first.text.trimEnd()
  for (let y = top + 1; y < top + maxRows; y++) {
    const r = row(y)
    if (!r) break
    if (r.wrapped) {
      const t = r.text.trimEnd()
      if (!t) break
      parts[parts.length - 1] += t
      ;(bottom = y), (endX = t.length - 1), (prev = t)
      continue
    }
    const t = r.text.trimEnd()
    const body = t.trimStart()
    const ind = t.length - body.length
    if (!body || ind !== x || BLOCK.test(body) || !cols) break
    // the row before was full: its next word would not have fitted on it
    const word = body.split(/\s/)[0]!.length
    if (prev.length + 1 + word <= cols) break
    parts.push(body)
    ;(bottom = y), (endX = t.length - 1), (prev = t)
  }
  // a cell index, when wide characters moved the text off its cells
  const cell = (r: Row | undefined, i: number) => r?.xs?.[i] ?? i
  const cmd = parts.join(' ').replace(/^!\s*/, '').replace(/\s+/g, ' ').trim()
  if (!cmd) return null
  return { top, bottom, x: cell(first, x), endX: cell(row(bottom), endX), cmd }
}

/** The `!` command covering row `y`: it starts on `y` or on a row above it. */
export function bangAt(row: (y: number) => Row | undefined, y: number, cols = 0, maxRows = 12): BangHit | null {
  for (let top = y; top >= 0 && top > y - maxRows; top--) {
    const hit = bangFrom(row, top, cols, maxRows)
    if (hit) return hit.bottom >= y ? hit : null
    const r = row(top)
    if (!r || (!r.wrapped && !r.text.trim())) return null
  }
  return null
}
