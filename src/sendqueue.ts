// `overvibe send` without typing over the owner [T1110-60].
// A message is typed into the target's input box only when nobody is using it: the box is empty (no
// draft), no key went to that session in the last 4 s, and no choice menu is open. Otherwise it waits
// in a per-session queue (sendqueue.json, so it survives a restart) and goes out in order once the
// session is free. While the deck types, the owner's keystrokes for that session are held and replayed
// after it, so a key pressed mid-delivery never lands inside the message.
// Nothing is ever dropped on its own: an old message stays queued (flagged in the UI) until it is
// delivered or the owner discards it.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './env'
import { captureStyled, clientActivity, listSessions, typeInto } from './tmux'
import { parsePrompt } from './prompts'
import { noteDeckMessage } from './transcripts'
import { handTo, hookState } from './inbox'

import type { Tool } from './env'
export type { Tool }
export type Queued = {
  id: string
  /** target tmux session */
  tmux: string
  tool: Tool
  toName: string
  toSession: string | null
  from: string
  fromSession: string | null
  /** the message as the sender wrote it, and what gets typed (with the reply header) */
  text: string
  body: string
  at: number
  /** why it is still waiting, from the last check */
  why?: string
  /** set (and saved) just before typing starts: a restart mid-delivery must not type it again */
  delivering?: number
  /** the target is a Claude session with the wait-message hook: `full` goes to its hook, not its input box [T1111-24] */
  hook?: boolean
  full?: string
  /** the owner's own words from the page (Tasks > Follow up): typed with no header, not logged as an agent message [T1112-14] */
  owner?: boolean
}

const QUIET_MS = 4000
export const STALE_MS = 30 * 60_000
const FILE = join(DATA_DIR, 'sendqueue.json')
let queue: Queued[] = []
const LOG = join(DATA_DIR, 'sendqueue.log')
const qlog = (s: string) => {
  console.log(`[send] ${s}`)
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`, { mode: 0o600 })
  } catch {}
}
try {
  if (existsSync(FILE)) queue = JSON.parse(readFileSync(FILE, 'utf8'))
} catch {}
const save = () => writeFileSync(FILE, JSON.stringify(queue, null, 2), { mode: 0o600 })
// a message the last server was typing when it stopped (bun --watch reloads on every edit) was typed
// already, at least in part: never type it twice; it is kept in sendqueue.log
for (const q of queue.filter((x) => x.delivering)) qlog(`was being typed into "${q.toName}" from "${q.from}" when the server restarted; not typed again: ${q.text.slice(0, 200)}`)
if (queue.some((x) => x.delivering)) (queue = queue.filter((x) => !x.delivering)), save()

// ---------- the owner's keystrokes ----------
const lastKey = new Map<string, number>()
const held = new Map<string, (() => void)[]>()
// not typing: mouse reports (SGR, X10), focus in/out, and the terminal's own replies to queries
// (device attributes, cursor position, mode reports, OSC colour answers, DCS strings)
const NOT_TYPING = /^(?:\x1b\[<\d+;\d+;\d+[mM]|\x1b\[M[\s\S]{3}|\x1b\[[IO]|\x1b\[[?>=]?[\d;]*(?:c|R|n|t|\$y)|\x1b\[\?[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\)+$/
/** pids of the tmux clients this server attached for browser terminals; their keys are timed above */
const deckClients = new Set<number>()
export const deckClient = (pid: number, on: boolean) => (on ? deckClients.add(pid) : deckClients.delete(pid))

/**
 * Every byte the browser terminal sends for a session goes through here. Returns true when the deck
 * is typing into that session right now: the caller must not write; `write` runs once it is done.
 */
export function ownerInput(tmux: string, data: string | Uint8Array, write: () => void): boolean {
  const s = typeof data === 'string' ? data : Buffer.from(data).toString('latin1')
  if (!NOT_TYPING.test(s)) lastKey.set(tmux, Date.now())
  const h = held.get(tmux)
  if (!h) return false
  h.push(write)
  return true
}

/** Type `text` into a session with the owner's input held back meanwhile, then replay what they typed. */
export async function typeHeld(tmux: string, text: string) {
  if (held.has(tmux)) throw new Error('already typing into it')
  held.set(tmux, [])
  try {
    await typeInto(tmux, text)
  } finally {
    const h = held.get(tmux) ?? []
    held.delete(tmux)
    for (const w of h)
      try {
        w()
      } catch {}
  }
}

// ---------- reading the input box ----------
const ESC = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
/** a screen line as plain text, with dim runs (placeholders like `Try "edit <filepath> to..."`) removed */
function plain(l: string) {
  let out = ''
  let dim = false
  let i = 0
  for (const m of l.matchAll(ESC)) {
    if (!dim) out += l.slice(i, m.index)
    i = m.index! + m[0].length
    const sgr = /^\x1b\[([\d;]*)m$/.exec(m[0])
    if (sgr) {
      const codes = sgr[1] === '' ? [0] : sgr[1]!.split(';').map(Number)
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k]!
        // 38/48/58;5;n and ;2;r;g;b are colours, not attributes
        if (c === 38 || c === 48 || c === 58) k += codes[k + 1] === 5 ? 2 : codes[k + 1] === 2 ? 4 : 0
        else if (c === 2) dim = true
        else if (c === 0 || c === 22) dim = false
      }
    }
  }
  if (!dim) out += l.slice(i)
  return out.replace(/\s+$/, '')
}

const RULE = /^\s*[─━]{10,}/
/**
 * What is typed in the session's input box: '' when it is empty, null when no input box is on screen.
 * Claude and agy: a "❯ " / "> " line under a box rule, down to the next rule. Codex: the last "› " line
 * and its continuation lines, down to a blank line.
 */
export function inputText(styled: string, tool: Tool): string | null {
  const lines = styled.replace(/\s+$/, '').split('\n').map(plain)
  const from = Math.max(0, lines.length - 60)
  if (tool === 'codex') {
    for (let i = lines.length - 1; i >= Math.max(from, lines.length - 25); i--) {
      const m = /^\s*›(?:\s(.*)|$)/.exec(lines[i]!)
      if (!m) continue
      const parts = [m[1] ?? '']
      for (let j = i + 1; j < lines.length && lines[j]!.trim() && /^\s{2}/.test(lines[j]!); j++) {
        if (/^\s{2}(?:gpt|GPT|o\d|\? for shortcuts)/.test(lines[j]!) || /·\s*~\//.test(lines[j]!)) break
        parts.push(lines[j]!.trim())
      }
      return parts.join('\n').trim()
    }
    return null
  }
  for (let i = lines.length - 1; i > from; i--) {
    const m = /^\s*[❯>](?:\s(.*)|$)/.exec(lines[i]!)
    if (!m || !RULE.test(lines[i - 1]!)) continue
    const parts = [m[1] ?? '']
    for (let j = i + 1; j < lines.length && !RULE.test(lines[j]!); j++) parts.push(lines[j]!.trim())
    return parts.join('\n').trim()
  }
  return null
}

/** Why the deck should not type into this session right now, or null when it may. */
export async function busyReason(tmux: string, tool: Tool, o: { force?: boolean } = {}): Promise<string | null> {
  if (held.has(tmux)) return 'already typing into it'
  if (!o.force) {
    // browser terminals: the key timer above. tmux's client_activity only for other clients (a Terminal
    // tab running `overvibe attach`): the deck's own clients are timed by key, not by what tmux counts
    const ago = Date.now() - Math.max(lastKey.get(tmux) ?? 0, (await clientActivity(deckClients)).get(tmux) ?? 0)
    if (ago < QUIET_MS) return `someone typed in it ${Math.max(0, Math.round(ago / 1000))} s ago`
  }
  const styled = await captureStyled(tmux)
  if (styled === null) return 'its terminal is not running'
  if (parsePrompt(styled.replace(ESC, ''))) return 'a choice is open on its screen'
  const draft = inputText(styled, tool)
  if (draft === null) return o.force ? null : 'its input box is not on screen'
  if (draft) return 'its input box has a draft in it'
  return null
}

// ---------- the queue ----------
export const queued = (tmux: string) => queue.filter((q) => q.tmux === tmux)
/** for the page: what waits for each session */
export function queueView(tmux: string | null) {
  if (!tmux) return undefined
  const q = queued(tmux).filter((x) => !x.delivering)
  if (!q.length) return undefined
  const now = Date.now()
  return q.map((x) => ({ id: x.id, from: x.from, preview: x.text.slice(0, 160), at: x.at, why: x.why ?? null, stale: now - x.at > STALE_MS }))
}

async function deliver(q: Queued) {
  // saved before the first key: if the server restarts while typing, the next one will not type it again
  q.delivering = Date.now()
  save()
  try {
    await typeHeld(q.tmux, q.body)
  } catch (e) {
    delete q.delivering
    save()
    throw e
  }
  finish(q, 'typed')
}

function finish(q: Queued, how: string) {
  queue = queue.filter((x) => x !== q)
  save()
  if (!q.owner) noteDeckMessage({ from: q.from, fromSession: q.fromSession, to: q.toName, toSession: q.toSession, text: q.text })
  console.log(`[send] delivered to "${q.toName}" from "${q.from}" (${how}) after ${Math.round((Date.now() - q.at) / 1000)} s`)
}

/** A hook wait just opened: give it the session's oldest message at once rather than at the next tick. */
export const kick = (tmux: string) => void tryNext(tmux).catch(() => {})

const working = new Set<string>()
/** Deliver the oldest message for this session if it is free. Returns what happened to it. */
async function tryNext(tmux: string): Promise<'delivered' | 'waiting' | 'empty'> {
  const q = queued(tmux)[0]
  if (!q) return 'empty'
  if (q.delivering) return 'waiting'
  if (working.has(tmux)) return 'waiting'
  working.add(tmux)
  try {
    // a Claude session with the hook: hand it over while its wait is open, else hold it for the next one [T1111-24]
    if (q.hook && q.full) {
      const st = hookState(tmux)
      if (st === 'open' && handTo(tmux, q.full)) {
        finish(q, 'its hook')
        return 'delivered'
      }
      if (st !== 'none') {
        const why = 'waits for its current turn to end'
        if (q.why !== why) (q.why = why), save()
        return 'waiting'
      }
    }
    const why = await busyReason(tmux, q.tool)
    if (why) {
      if (q.why !== why) (q.why = why), save()
      return 'waiting'
    }
    await deliver(q)
    return 'delivered'
  } finally {
    working.delete(tmux)
  }
}

/** Queue a message (behind any already waiting for that session) and deliver it at once if the session is free. */
export async function enqueue(m: Omit<Queued, 'id' | 'at'>) {
  const q: Queued = { ...m, id: crypto.randomUUID().slice(0, 8), at: Date.now() }
  queue.push(q)
  save()
  const ahead = queued(m.tmux).length - 1
  if (!ahead && (await tryNext(m.tmux)) === 'delivered') return { delivered: true as const, ahead: 0 }
  return { delivered: false as const, ahead, why: q.why ?? null, id: q.id }
}

/** The owner's "Deliver now": skips the typing pause, still never types over a draft or into an open menu. */
export async function deliverNow(id: string): Promise<{ already?: boolean }> {
  const q = queue.find((x) => x.id === id)
  // delivered on its own meanwhile (or being typed right now): never type it a second time
  if (!q || q.delivering) return { already: true }
  if (working.has(q.tmux)) return { already: true }
  working.add(q.tmux)
  try {
    const why = await busyReason(q.tmux, q.tool, { force: true })
    if (why === 'its input box has a draft in it') throw new Error('Its input box has text in it. Send or clear that first.')
    if (why) throw new Error(`Can't type into it now: ${why}.`)
    await deliver(q)
    return {}
  } finally {
    working.delete(q.tmux)
  }
}

/** The owner's "Discard": the only way a queued message goes without being delivered. */
export function discard(id: string) {
  const q = queue.find((x) => x.id === id)
  if (!q || q.delivering) throw new Error('That message was delivered already.')
  queue = queue.filter((x) => x !== q)
  save()
  console.log(`[send] discarded by the owner: to "${q.toName}" from "${q.from}"`)
}

// every 1.5 s: each session with something waiting gets its next message if it is free now
setInterval(async () => {
  if (!queue.length) return
  const alive = new Set((await listSessions()).map((p) => p.name))
  for (const tmux of new Set(queue.map((q) => q.tmux))) {
    if (!alive.has(tmux)) {
      for (const q of queued(tmux)) if (q.why !== 'its terminal is not running') (q.why = 'its terminal is not running'), save()
      continue
    }
    tryNext(tmux).catch((e) => console.log(`[send] ${tmux}: ${e?.message ?? e}`))
  }
}, 1500)
