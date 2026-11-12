// Clicks never answer a choice menu [T1111-25].
//
// Claude Code turns on mouse tracking (all motion, SGR), so tmux hands it every click in the browser
// terminal, and a click on a row of its menus (AskUserQuestion, a permission prompt) picks that row at
// once. The click that focuses the terminal after opening a session was enough to answer a menu the
// owner had not read yet. While a choice menu is on the session's screen, the page's mouse presses,
// releases and drags go nowhere; the wheel and plain pointer motion still pass, and keys answer the menu.
import { readPrompt } from './prompts'

// SGR (1006) mouse reports, and X10 ones (\e[M plus three bytes)
const MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]|\x1b\[M([\s\S])[\s\S]{2}/g

/** a press, release or drag (button held while moving); not the wheel, not plain motion */
const isButton = (b: number) => !(b & 64) && (!(b & 32) || (b & 3) !== 3)
const codeOf = (m: RegExpMatchArray) => (m[1] !== undefined ? Number(m[1]) : m[2]!.charCodeAt(0) - 32)

/** does this input carry a mouse press, release or drag */
export const hasClick = (s: string) => [...s.matchAll(MOUSE)].some((m) => isButton(codeOf(m)))

/** the input without its mouse presses, releases and drags */
export const dropClicks = (s: string) => s.replace(MOUSE, (all, sgr, x10) => (isButton(sgr !== undefined ? Number(sgr) : x10.charCodeAt(0) - 32) ? '' : all))

type Data = string | Uint8Array
const menuOnScreen = (tmux: string) => readPrompt(tmux).then((p) => !!p, () => false)

/**
 * The browser terminal's input for one session, in order. Input without a click is written at once;
 * a click waits for one look at the screen, and anything typed meanwhile waits behind it.
 */
export function guardedInput(tmux: string, write: (d: Data) => void, menuOn: (tmux: string) => Promise<boolean> = menuOnScreen) {
  let chain: Promise<void> | null = null
  return (d: Data) => {
    const s = typeof d === 'string' ? d : Buffer.from(d).toString('latin1')
    const click = hasClick(s)
    if (!click && !chain) return write(d)
    const run = async () => {
      if (!click || !(await menuOn(tmux))) return write(d)
      const rest = dropClicks(s)
      if (rest) write(typeof d === 'string' ? rest : Buffer.from(rest, 'latin1'))
    }
    const c: Promise<void> = (chain ?? Promise.resolve()).then(run).catch(() => {})
    chain = c
    void c.then(() => {
      if (chain === c) chain = null
    })
  }
}
