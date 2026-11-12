// The whole history of messages between sessions [T1111-12]: every message sendTo() queues (overvibe send,
// and Overvibe's own notes such as the worktree report) is appended whole, one JSON line each, to
// peer-messages.jsonl in the data folder (readable by the owner only). It answers "which agent told which
// what": `overvibe messages`, GET /api/peer-messages and Messages > Between agents read it. Nothing here
// ever deletes or trims the file (owner rule: history is never deleted); reads only look at its tail.
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './env'

export type PeerMessage = {
  /** short id, for `overvibe read <id>` (messages from before T1111-22 have none) */
  id?: string
  at: number
  from: string
  fromSession: string | null
  fromTmux: string | null
  fromTool: string | null
  /** 'overvibe': a note Overvibe itself wrote (a helper ended, hit a limit, waits) [T1111-11] */
  sender: 'checked' | 'legacy' | 'outside' | 'overvibe'
  to: string
  toSession: string | null
  toTmux: string | null
  toTool: string | null
  text: string
}

export const peerLogFile = (dir = DATA_DIR) => join(dir, 'peer-messages.jsonl')

export function append(m: PeerMessage, file = peerLogFile()) {
  try {
    const fresh = !existsSync(file)
    appendFileSync(file, JSON.stringify(m) + '\n', { mode: 0o600 })
    if (fresh) chmodSync(file, 0o600)
  } catch (e: any) {
    console.log(`[peerlog] could not record a message: ${e?.message ?? e}`)
  }
}

const TAIL = 8 << 20 // the last 8 MB: tens of thousands of messages

/** Messages oldest first; `with` matches either side (name, session id or tmux id, any case); the newest `limit`. */
export function read(o: { with?: string; limit?: number; since?: number } = {}, file = peerLogFile()): PeerMessage[] {
  if (!existsSync(file)) return []
  const fd = openSync(file, 'r')
  let text: string
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1) // a partial first line
  } finally {
    closeSync(fd)
  }
  const want = o.with?.trim().toLowerCase()
  const hit = (m: PeerMessage) =>
    !want || [m.from, m.to, m.fromSession, m.toSession, m.fromTmux, m.toTmux].some((x) => x && x.toLowerCase() === want) || m.from.toLowerCase().includes(want) || m.to.toLowerCase().includes(want)
  const out: PeerMessage[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const m = JSON.parse(line) as PeerMessage
      if (o.since && m.at < o.since) continue
      if (hit(m)) out.push(m)
    } catch {}
  }
  return o.limit && o.limit > 0 ? out.slice(-o.limit) : out
}

/** One message by its id (`overvibe read`), newest match first; null when the tail holds none [T1111-22]. */
export function byId(id: string, file = peerLogFile()): PeerMessage | null {
  const want = id.trim().toLowerCase()
  if (!want) return null
  return read({}, file).reverse().find((m) => m.id === want) ?? null
}
