// Codex's own session files, for the sidebar's past sessions: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl.
// The first line is session_meta (id, cwd, start, source); the owner's messages are event_msg user_message
// lines; Codex's title for a thread is in session_index.jsonl. Only the last 7 days, and a file is read
// again only from where the last read stopped, so a sweep costs a few stat calls.
// Skipped: Codex's own subagents (guardian reviews and the like) and `codex exec` runs.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HOME } from './env'
import { addWork, type Tokens } from './transcripts'
import { lastStampIn } from './stamp'
import { B, eachLine } from './lines'

const CODEX_HOME = process.env.CODEX_HOME || join(HOME, '.codex')
const ROOT = join(CODEX_HOME, 'sessions')
const NAMES = join(CODEX_HOME, 'session_index.jsonl')
const DAYS = 7

export type CodexSession = {
  id: string; cwd: string; startedAt: number | null; lastAt: number; firstPrompt: string | null; lastPrompt: string | null; title: string | null
  /** working time per local hour (YYYY-MM-DDTHH -> ms), from task_complete duration_ms (Stats) [T1110-84] [T1110-89] */
  work?: Record<string, number>
  /** tokens so far: the latest token_count's total_token_usage (in counts cached input too) [T1111-13] */
  tokens?: Tokens
}
type Entry = { off: number; skip: boolean; s: CodexSession | null }
const TOKEN_COUNT = B('"token_count"')
const TASK_COMPLETE = B('"task_complete"')
const USER_MESSAGE = B('"user_message"')
const ROLE_USER = B('"role":"user"')
const COMPACTED = B('"type":"compacted"')
const files = new Map<string, Entry>()
let names: { mtime: number; map: Map<string, string> } = { mtime: -1, map: new Map() }
let swept = 0

function readNames() {
  try {
    const mtime = statSync(NAMES).mtimeMs
    if (mtime === names.mtime) return
    const map = new Map<string, string>()
    for (const ln of readFileSync(NAMES, 'utf8').split('\n')) {
      try {
        const j = JSON.parse(ln)
        if (j.id && j.thread_name) map.set(j.id, j.thread_name)
      } catch {}
    }
    names = { mtime, map }
  } catch {}
}

/** The owner's text from a user message line, without what Codex injects (<environment_context> etc). */
function userText(d: any): string | null {
  const p = d?.payload
  let t: unknown = null
  if (d?.type === 'event_msg' && p?.type === 'user_message') t = p.message
  else if (d?.type === 'response_item' && p?.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
    t = p.content.filter((b: any) => b?.type === 'input_text').map((b: any) => b.text).join('\n')
  }
  if (typeof t !== 'string') return null
  const s = t.trim()
  return s && !s.startsWith('<') && !s.startsWith('# AGENTS.md instructions') ? s : null
}

function readNew(file: string, mtime: number, size: number) {
  let e = files.get(file)
  if (!e) files.set(file, (e = { off: 0, skip: false, s: null }))
  if (e.skip) return
  if (size < e.off) e.off = 0
  if (size === e.off) return
  const fd = openSync(file, 'r')
  try {
    const en = e
    let skipped = false
    // lines arrive as bytes (src/lines.ts): only the ones below become strings [T1112-112]
    const off = eachLine(fd, e.off, size, (line) => {
      if (!en.s) {
        // the first line: who this session is
        let d: any
        try {
          d = JSON.parse(line.toString())
        } catch {
          en.skip = skipped = true
          return false
        }
        const p = d?.type === 'session_meta' ? d.payload : null
        const sub = p?.parent_thread_id || (p?.source && typeof p.source === 'object' && p.source.subagent)
        if (!p?.id || !p.cwd || sub || p.source === 'exec' || p.originator === 'codex_exec') {
          en.skip = skipped = true
          return false
        }
        const started = Date.parse(p.timestamp ?? d.timestamp)
        en.s = { id: p.id, cwd: p.cwd, startedAt: Number.isFinite(started) ? started : null, lastAt: 0, firstPrompt: null, lastPrompt: null, title: null }
        return
      }
      if (line.includes(TOKEN_COUNT)) {
        try {
          const u = JSON.parse(line.toString())?.payload?.info?.total_token_usage
          if (u && typeof u.input_tokens === 'number')
            en.s.tokens = { in: u.input_tokens, out: (u.output_tokens ?? 0), cacheRead: u.cached_input_tokens ?? 0, cacheWrite: u.cache_write_input_tokens ?? 0 }
        } catch {}
        return
      }
      if (line.includes(TASK_COMPLETE)) {
        try {
          const d = JSON.parse(line.toString())
          const ms = d?.payload?.type === 'task_complete' ? d.payload.duration_ms : null
          const end = Date.parse(d.timestamp)
          if (typeof ms === 'number' && ms > 0 && Number.isFinite(end)) addWork((en.s.work ??= {}), end, ms)
        } catch {}
        return
      }
      // a compact's line carries the whole history again (25 MB seen) and no new message: never decoded
      if (line.subarray(0, 200).includes(COMPACTED)) return
      if (!line.includes(USER_MESSAGE) && !line.includes(ROLE_USER)) return
      try {
        const t = userText(JSON.parse(line.toString()))
        if (t) {
          en.s.firstPrompt ??= t.slice(0, 200)
          en.s.lastPrompt = t.slice(0, 200)
        }
      } catch {}
    }, {
      // idle time is the newest line's own time, never the mtime (files get touched without a line) [T1112-7]
      chunk: (whole) => {
        const newest = lastStampIn(whole)
        if (en.s && newest) en.s.lastAt = Math.max(en.s.lastAt, newest)
      },
    })
    if (skipped) return
    e.off = off
    // no line with a time yet: the mtime is the best there is
    if (e.s && !e.s.lastAt) e.s.lastAt = Math.min(mtime, Date.now())
  } finally {
    closeSync(fd)
  }
}

function sweep() {
  const cutoff = Date.now() - DAYS * 86400_000
  const day = (t: number) => new Date(t).toISOString().slice(0, 10).split('-')
  for (let t = cutoff - 86400_000; t <= Date.now() + 86400_000; t += 86400_000) {
    const [y, m, d] = day(t)
    const dir = join(ROOT, y!, m!, d!)
    let list: string[]
    try {
      list = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of list) {
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue
      const file = join(dir, f)
      try {
        const st = statSync(file)
        if (st.mtimeMs < cutoff) continue
        readNew(file, st.mtimeMs, st.size)
      } catch {}
    }
  }
}

/** Codex sessions active in the last 7 days, newest first. Re-swept at most every 10 s. */
export function codexSessions(): CodexSession[] {
  if (!existsSync(ROOT)) return []
  if (Date.now() - swept > 10_000) {
    swept = Date.now()
    sweep()
    readNames()
  }
  const cutoff = Date.now() - DAYS * 86400_000
  const out: CodexSession[] = []
  for (const e of files.values()) {
    if (!e.s || e.s.lastAt < cutoff) continue
    e.s.title = names.map.get(e.s.id) ?? null
    out.push(e.s)
  }
  return out.sort((a, b) => b.lastAt - a.lastAt)
}

export const codexInfo = (id: string) => codexSessions().find((s) => s.id === id)
/** the rollout file of a Codex session seen in the last 7 days (file links read it [T1112-17]) */
export function codexFile(id: string): string | null {
  codexSessions()
  return [...files.entries()].find(([, e]) => e.s?.id === id)?.[0] ?? null
}

/**
 * A Codex session's last reply, whole: the newest task_complete's last_agent_message, or an assistant
 * message after it (a turn still going), from the rollout's last 512 KB [T1111-30].
 */
export function codexLastReply(id: string): string | null {
  codexSessions()
  const file = [...files.entries()].find(([, e]) => e.s?.id === id)?.[0]
  if (!file) return null
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - 512 * 1024)
    const fd = openSync(file, 'r')
    let text: string
    try {
      const buf = Buffer.allocUnsafe(size - start)
      text = buf.subarray(0, readSync(fd, buf, 0, buf.length, start)).toString('utf8')
    } finally {
      closeSync(fd)
    }
    let last: string | null = null
    for (const line of text.split('\n')) {
      const done = line.includes('"task_complete"')
      if (!done && !line.includes('"agent_message"') && !line.includes('"role":"assistant"')) continue
      try {
        const p = JSON.parse(line)?.payload
        let t: unknown = null
        if (p?.type === 'task_complete') t = p.last_agent_message
        else if (p?.type === 'agent_message') t = p.message
        else if (p?.type === 'message' && p.role === 'assistant' && Array.isArray(p.content))
          t = p.content.filter((b: any) => b?.type === 'output_text').map((b: any) => b.text).join('\n')
        if (typeof t === 'string' && t.trim()) last = t.trim()
      } catch {}
    }
    return last
  } catch {
    return null
  }
}
