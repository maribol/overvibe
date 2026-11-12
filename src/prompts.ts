// Read a choice prompt off a session's screen: Claude's "Do you want to proceed?" for a shell
// command, its AskUserQuestion picker, folder trust, and Codex's equivalents. These never reach the
// transcript, so the screen is the only place to see them. Answering moves the cursor with the arrow
// keys and presses Enter, which works for numbered and unnumbered menus alike.
import { capture } from './tmux'

export type ScreenPrompt = {
  title: string
  context: string[]
  options: string[]
  /** the help line under each option, '' when there is none */
  hints: string[]
  cursor: number
  /** what the prompt looked like; an answer is only typed while the screen still matches it */
  sig: string
  trust: boolean
}

const FOOTER = /(Esc to cancel|Enter to confirm|enter continue|esc quit|Esc to exit|Enter to select|Navigate · enter Confirm|enter Confirm)/i
const CURSOR = /^(\s*)(?:❯|›|>)\s+(.*\S)\s*$/
const RULE = /^[\s─━═╌┄▔▁-]+$/
const SOLID = /^[\s─━═▔▁]+$/ // a box edge (newer Claude Code draws the top with ▔); dashed rules inside the box only frame the command

const NUM = /^(\s*)(?:(?:❯|›|>)\s+)?(\d+)\.\s+(.*\S)\s*$/
const strip = (l: string) => l.trim().replace(/^│\s*/, '').replace(/\s*│$/, '')

export function parsePrompt(screen: string): ScreenPrompt | null {
  const lines = screen.replace(/\s+$/, '').split('\n').slice(-45)
  // the hint line under a menu is the most reliable sign one is open
  // (within the last few non-blank lines: a short menu leaves the bottom of the pane empty)
  let foot = -1
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 8; i--) {
    if (!lines[i]!.trim()) continue
    seen++
    if (FOOTER.test(lines[i]!)) (foot = i), (i = -1)
  }
  if (foot < 0) return null
  // the cursor row is the selected option, above the hint (AskUserQuestion puts a line of help under each option)
  let cur = -1
  for (let i = foot - 1; i >= Math.max(0, foot - 30); i--) if (CURSOR.test(lines[i]!)) (cur = i), (i = -1)
  if (cur < 0) return null
  let idx: number[] = []
  const hints: string[] = []
  const n = NUM.exec(lines[cur]!)
  if (n) {
    // numbered menu: rows "N. label" with the number in one column; deeper-indented lines under a row
    // are its help text, and blank or rule lines may sit between rows ("5. Chat about this")
    const col = lines[cur]!.indexOf(n[2]! + '.', n[1]!.length)
    const isRow = (l: string) => {
      const m = NUM.exec(l)
      return !!m && l.indexOf(m[2]! + '.', m[1]!.length) === col
    }
    const filler = (l: string) => !l.trim() || RULE.test(l) || l.length - l.trimStart().length > col
    let a = cur
    for (let i = cur - 1; i >= 0 && (isRow(lines[i]!) || filler(lines[i]!)); i--) if (isRow(lines[i]!)) a = i
    for (let i = a; i < foot; i++) {
      const l = lines[i]!
      if (isRow(l)) idx.push(i), hints.push('')
      else if (filler(l)) {
        if (l.trim() && !RULE.test(l) && idx.length) hints[hints.length - 1] = (hints[hints.length - 1] + ' ' + l.trim()).trim()
      } else break
    }
    // numbers must run 1, 2, 3...; anything else is not one menu
    const nums = idx.map((i) => Number(NUM.exec(lines[i]!)![2]))
    if (nums.some((v, k) => v !== nums[0]! + k)) return null
  } else {
    // unnumbered menu: other options line up with the text after the cursor mark ("❯ No" / "  Yes")
    const indent = CURSOR.exec(lines[cur]!)![1]!.length
    const textCol = lines[cur]!.length - lines[cur]!.replace(/^\s*(?:❯|›|>)\s+/, '').length
    const isOpt = (l: string) => {
      if (!l.trim() || RULE.test(l) || FOOTER.test(l)) return false
      const m = CURSOR.exec(l)
      if (m) return m[1]!.length === indent
      return l.length - l.trimStart().length === textCol
    }
    let a = cur
    while (a - 1 >= 0 && isOpt(lines[a - 1]!) && cur - a < 9) a--
    let b = cur
    while (b + 1 < foot && isOpt(lines[b + 1]!)) b++
    for (let i = a; i <= b; i++) idx.push(i), hints.push('')
    // a long wrapped line after a mark is the echo of a typed message (agy shows "> <prompt>" above
    // its "esc to cancel" while it works), not a menu: real unnumbered options are short
    if (idx.some((i) => lines[i]!.trim().length > 100)) return null
  }
  if (idx.length < 2) return null
  const options = idx.map((i) => lines[i]!.replace(/^\s*(?:❯|›|>)?\s*/, '').replace(/^\d+\.\s+/, '').replace(/\s+$/, ''))
  const cursor = idx.indexOf(cur)
  if (cursor < 0) return null
  // what the menu is about: the non-empty lines above it, up to a box edge or the input box
  const top = idx[0]!
  const ctx: string[] = []
  for (let i = top - 1; i >= Math.max(0, top - 14); i--) {
    const l = lines[i]!
    if (SOLID.test(l) && l.trim()) break
    const t = strip(l)
    if (t && !RULE.test(t) && !/^Tip:/.test(t)) ctx.unshift(t)
  }
  const title = [...ctx].reverse().find((l) => l.endsWith('?')) ?? ctx[0] ?? 'Choose an option'
  const all = options.join(' ')
  return {
    title,
    context: ctx.filter((l) => l !== title).slice(-8),
    options,
    hints,
    cursor,
    sig: `${title}|${options.join('|')}`,
    trust: /Yes, I trust this folder|Trust and continue/i.test(all) && /trust/i.test(ctx.join(' ') + all),
  }
}

export async function readPrompt(tmux: string) {
  return parsePrompt(await capture(tmux, 45))
}
