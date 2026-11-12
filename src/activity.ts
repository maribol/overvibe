// When a session last really did something, for the sidebar's time and Close old sessions [T1112-7].
// tmux's window_activity moves on any output, and a page attaching or resizing its terminal makes the
// program redraw (zsh reprints its prompt, a TUI repaints), so a shell idle a day read "now". Here the
// activity counts only when the text on screen changed: a redraw prints the same text, typing or new
// output does not. Claude and Codex rows use their transcript or rollout instead (src/sessions.ts).
// What it learned is kept in <data dir>/activity.json (a hash of the screen, never its text), so a
// server restart does not take the first redraw it sees for real activity.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './env'
import { captureJoined } from './tmux'

type Seen = { act: number; sig: string; real: number }
const FILE = join(DATA_DIR, 'activity.json')
const seen = new Map<string, Seen>()
try {
  if (existsSync(FILE)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Seen>)) seen.set(k, v)
} catch {}
let saveTimer: ReturnType<typeof setTimeout> | null = null
function save() {
  saveTimer ??= setTimeout(() => {
    saveTimer = null
    try {
      writeFileSync(FILE, JSON.stringify(Object.fromEntries(seen)), { mode: 0o600 })
    } catch {}
  }, 10_000)
}

/**
 * What the screen says, without what a redraw or resize changes: the last 12 non-blank lines with
 * wrapped lines joined (capture -J) and every run of spaces as one (a right-hand prompt moves with the width).
 */
export function screenSig(screen: string, n = 12): string {
  return screen
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-n)
    .join('\n')
}

/** The pure step: given the last state and a new (activity, screen), the new state. */
export function step(prev: Seen | undefined, act: number, sig: string): Seen {
  if (!prev) return { act, sig, real: act }
  if (act === prev.act) return prev
  return { act, sig, real: sig === prev.sig ? prev.real : act }
}

/** The time of the session's last real screen change (ms), from tmux's activity time and its screen. */
export async function realActivity(name: string, act: number): Promise<number> {
  const prev = seen.get(name)
  if (prev && prev.act === act) return prev.real
  const screen = await captureJoined(name)
  if (screen === null) return prev?.real ?? act
  const next = step(prev, act, createHash('sha1').update(screenSig(screen)).digest('hex'))
  seen.set(name, next)
  save()
  return next.real
}
