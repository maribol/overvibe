// Follows every Claude Code transcript on this Mac (~/.claude/projects/<folder>/<session>.jsonl, which
// every account shares through its symlink), so sessions started anywhere (a Terminal tab, `claude --bg`,
// the deck) show up with what matters to the owner:
//   · the session's name: `/rename` writes a custom-title line, and agent-name is its messaging name
//   · every message the owner typed, newest first, with the session it went to
//   · messages between sessions: SendMessage calls going out, <cross-session-message> lines coming in
//
// Transcripts are big (1.5 GB a week), so lines are filtered by substring before JSON.parse, and each
// file's read offset is kept in index.json: a restart reads only what was appended since.
import { lastStampIn } from './stamp'
import { B, eachLine } from './lines'
import { existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { join, basename } from 'node:path'
import { DATA_DIR, HOME } from './env'

const ROOT = join(HOME, '.claude', 'projects')
const INDEX = join(DATA_DIR, 'index.json')
const DAYS = 7
const KEEP_MESSAGES = 400
const KEEP_EDGES = 6000 // a busy week is ~1500 messages; the Stats view counts 7 days [T1110-89]

export type Meta = {
  id: string
  file: string
  cwd: string | null
  title: string | null // /rename
  aiTitle?: string | null // Claude Code's own summary title, kept up to date as the session goes
  agentName: string | null // the name other sessions address it by
  firstPrompt: string | null
  lastPrompt: string | null
  lastAt: number
  startedAt: number | null
  /** a question or plan approval the session is waiting on (tool_use with no result yet) */
  pending?: Pending | null
  /** false once the last turn ended (a turn_duration entry after the last user entry) */
  turnOpen?: boolean
  /** its last reply ended on an API error ("Your computer went to sleep mid-response", overloaded, ...) [T1112-1]; null once it replies again */
  apiError?: { code: string; text: string; at: number } | null
  /** the last line of its last reply when that reply ends with a real question (not "Want me to deploy it?"), else null */
  asking?: string | null
  /** working time per local hour (YYYY-MM-DDTHH -> ms), summed from Claude Code's turn_duration lines (Stats) [T1110-84] [T1110-89] */
  work?: Record<string, number>
  /** tokens so far, from the assistant entries' message.usage, one count per message id [T1111-13] */
  tokens?: Tokens
  /** the last message id counted and what it added, so its repeat lines (one per content block) replace it */
  usage?: { id: string; t: Tokens }
}
/** in: every input token, cached ones included; cacheRead: the cached part of in; cacheWrite: written to the cache */
export type Tokens = { in: number; out: number; cacheRead?: number; cacheWrite?: number }
export type Pending = { toolUseId: string; tool: string; at: number; questions?: { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[]; plan?: string }
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
export type OwnerMessage = { sessionId: string; at: number; text: string }
export type Edge = { at: number; from: string; to: string; fromSession: string | null; toSession: string | null; summary: string; dir: 'out' | 'in'; fromPid?: number; toPid?: number; via?: 'deck' }

type Index = { offsets: Record<string, number>; metas: Record<string, Meta>; messages: OwnerMessage[]; edges: Edge[]; pids?: Record<string, string>; v?: number }
// bump when a new field needs every transcript read again from the start
// 4: Meta.work [T1110-84]; 5: work per hour, overvibe/deck send headers read from transcripts [T1110-89]
// 6: Meta.tokens [T1111-13]; 7: Meta.apiError [T1112-1]; 8: lastAt from the newest line, not the mtime [T1112-7]
const INDEX_V = 8

let idx: Index = { offsets: {}, metas: {}, messages: [], edges: [], v: INDEX_V }
try {
  if (existsSync(INDEX)) {
    const old: Index = JSON.parse(readFileSync(INDEX, 'utf8'))
    if (old.v === INDEX_V) idx = old
    // `overvibe send` messages to Codex and agy are in no transcript: keep them through a rebuild
    // (v4 did not mark them; there they are the incoming ones with no socket pid)
    else idx.edges = (old.edges ?? []).filter((e) => e.via === 'deck' || (old.v === 4 && e.dir === 'in' && !e.fromPid)).map((e) => ({ ...e, via: 'deck' as const }))
  }
} catch {}

let dirty = false
const listeners = new Set<() => void>()
export const onChange = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn))

// ---------- parsing ----------

// cheap pre-filter: a line is parsed only if it can carry something we keep
const WANT = ['"type":"user"', '"custom-title"', '"ai-title"', '"agent-name"', '"SendMessage"', '"queued_command"', '"turn_duration"'].map(B)
const ASSISTANT = B('"type":"assistant"')
const TEXT = B('"type":"text"')
const OUTPUT_TOKENS = B('"output_tokens"')
const ASK = B('"AskUserQuestion"')
const PLAN = B('"ExitPlanMode"')

/** Text the owner typed, or null for everything the harness injects into a user turn. */
export function ownerText(d: any): string | null {
  if (d.type !== 'user' || d.isMeta || d.isSidechain || d.userType !== 'external') return null
  const c = d.message?.content
  let text: string | null = null
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) {
    if (c.some((b: any) => b?.type === 'tool_result')) return null
    text = c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
  }
  if (!text) return null
  const t = text.trim()
  if (!t || t.startsWith('<') || t.startsWith('Another Claude session sent a message') || t.startsWith('[Request interrupted')) return null
  if (t.startsWith('[overvibe ') || t.startsWith('[deck message from')) return null // a peer's `overvibe send`, not the owner [T1110-89]
  if (t.startsWith('Caveat: ') || t.startsWith('This session is being continued from a previous conversation')) return null
  return t
}

/** A closing offer ("Want me to deploy it?", "Anything else?") means the agent is done, not blocked on the owner. */
function politeClose(line: string): boolean {
  const t = line.replace(/^[\s>*_\-#]+/, '').replace(/\*\*/g, '').trim()
  return /^(want me to|would you like( me)? to|do you want( me)? to|shall i|should i|should we|i can also|i could also|happy to|let me know|anything else|need anything else|ready (for|to)|ok to|okay to|good to go)\b/i.test(t)
    || /^(want|ok|okay|go|proceed|ship it|deploy( it| now)?)\s*\?$/i.test(t)
}
/** The reply's last line if it is a question for the owner, else null. */
function askingLine(text: string): string | null {
  const last = text.trim().split('\n').map((x) => x.trim()).filter(Boolean).at(-1) ?? ''
  return /\?\s*$/.test(last) && !politeClose(last) ? last.slice(0, 400) : null
}

/** Local calendar day of a time, YYYY-MM-DD. */
export const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** Local hour of a time, YYYY-MM-DDTHH (its first 10 characters are its dayKey). */
export const hourKey = (t: number) => `${dayKey(t)}T${String(new Date(t).getHours()).padStart(2, '0')}`
/** Add a turn of `ms` that ended at `end` to per-hour buckets, split at each hour it spans. */
export function addWork(work: Record<string, number>, end: number, ms: number) {
  let t = end
  let left = Math.min(ms, 7 * 86400_000)
  while (left > 0) {
    const d = new Date(t - 1)
    const hourStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime()
    const part = Math.min(left, t - hourStart)
    const k = hourKey(t - 1)
    work[k] = (work[k] ?? 0) + part
    left -= part
    t -= part
  }
}

// what the server types in front of an `overvibe send` (src/peer.ts header; `[deck message` before the rename).
// Only kind "message": resume notes and the like are not messages between agents.
const OV = /^\[(?:overvibe|deck) message from (?:"([^"]*)"|a shell outside any Overvibe session)[^\]]*\]\s*([\s\S]*)$/
/** The sender and text of an `overvibe send` message as typed into a session, or null for anything else. */
export function deckHeader(s: string): { from: string; body: string } | null {
  const x = OV.exec(s.trimStart())
  return x ? { from: x[1] ?? 'a shell', body: x[2]!.trim() } : null
}
/** an `overvibe send` edge already recorded for this message (by the server at delivery, or by an earlier read) */
// (the sender's name is left out: the header's copy of it is cleaned, and a shell has none)
const sameDeck = (e: Edge, toSession: string | null, summary: string, at: number) =>
  e.dir === 'in' && e.via === 'deck' && e.toSession === toSession && e.summary.slice(0, 40) === summary.slice(0, 40) && Math.abs(e.at - at) < 15 * 60_000

const XS = /<cross-session-message\s+from="([^"]*)"\s+from-name="([^"]*)"[^>]*>([\s\S]*?)(?:<\/cross-session-message>|$)/

function apply(file: string, d: any) {
  const id: string = d.sessionId || basename(file, '.jsonl')
  const m = (idx.metas[id] ??= { id, file, cwd: null, title: null, agentName: null, firstPrompt: null, lastPrompt: null, lastAt: 0, startedAt: null })
  m.file = file
  const at = d.timestamp ? Date.parse(d.timestamp) : NaN
  if (Number.isFinite(at)) {
    m.lastAt = Math.max(m.lastAt, at)
    if (m.startedAt === null) m.startedAt = at
  }
  if (d.cwd && !m.cwd) m.cwd = d.cwd
  if (d.type === 'custom-title' && d.customTitle) m.title = d.customTitle
  if (d.type === 'ai-title' && d.aiTitle) m.aiTitle = d.aiTitle
  if (d.type === 'agent-name' && d.agentName) m.agentName = d.agentName

  // a line without a time (titles, names) is as old as the session's last timed line, not "now" [T1112-7]
  const when = Number.isFinite(at) ? at : m.lastAt || Date.now()
  const owner = (t: string) => {
    m.asking = null
    m.firstPrompt ??= t.slice(0, 200)
    m.lastPrompt = t.slice(0, 200)
    idx.messages.push({ sessionId: id, at: when, text: t.slice(0, 600) })
  }
  // a message from another session, as it reaches this one (as a user turn, or queued mid-turn)
  const incoming = (s: string) => {
    const x = XS.exec(s)
    if (!x) return
    const summary = x[3]!.trim().slice(0, 240)
    // the same message can land twice (queued, then delivered): keep the first
    if (idx.edges.some((e) => e.dir === 'in' && e.toSession === id && e.from === x[2] && e.summary === summary)) return
    const pid = /cc-socks\/(\d+)\.sock/.exec(x[1]!)?.[1]
    idx.edges.push({ at: when, from: x[2]!, to: m.agentName ?? m.title ?? id.slice(0, 8), fromSession: null, toSession: id, summary, dir: 'in', fromPid: pid ? +pid : undefined })
  }

  // a message typed in by `overvibe send` [T1110-89]: it is in the transcript, so a rebuild finds it again
  const deckIncoming = (s: string) => {
    const x = deckHeader(s)
    if (!x) return
    const from = x.from
    const summary = x.body.slice(0, 240)
    if (idx.edges.some((e) => sameDeck(e, id, summary, when))) return
    idx.edges.push({ at: when, from, to: m.agentName ?? m.title ?? id.slice(0, 8), fromSession: null, toSession: id, summary, dir: 'in', via: 'deck' })
  }

  if (d.type === 'user' && m.pending && Array.isArray(d.message?.content) && d.message.content.some((b: any) => b?.type === 'tool_result' && b.tool_use_id === m.pending!.toolUseId)) {
    m.pending = null
  }
  if (d.type === 'user' && !d.isSidechain) m.turnOpen = true
  if (d.type === 'system' && d.subtype === 'turn_duration') {
    m.turnOpen = false
    if (!d.isSidechain && typeof d.durationMs === 'number' && d.durationMs > 0) addWork((m.work ??= {}), when, d.durationMs)
  }
  if (d.type === 'user') {
    const t = ownerText(d)
    if (t) owner(t)
    const c = d.message?.content
    const s = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => b?.text ?? '').join('\n') : ''
    if (s.includes('<cross-session-message')) incoming(s)
    if (!d.isSidechain && (s.includes('[overvibe message from') || s.includes('[deck message from'))) deckIncoming(s)
  }

  // typed while the session was busy: Claude Code queues it and records it as an attachment
  if (d.type === 'attachment' && d.attachment?.type === 'queued_command' && typeof d.attachment.prompt === 'string') {
    const p: string = d.attachment.prompt
    if (p.includes('<cross-session-message')) incoming(p)
    else if (!d.isSidechain && OV.test(p.trimStart())) deckIncoming(p)
    else if (d.attachment.origin?.kind === 'human' && !d.isSidechain) {
      const t = p.trim()
      if (t && !t.startsWith('<')) owner(t)
    }
  }

  if (d.type === 'assistant' && d.message?.usage) addUsage(m, d.message.id, d.message.usage)
  if (d.type === 'assistant' && !d.isSidechain) {
    if (d.isApiErrorMessage) {
      const c = d.message?.content
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => b?.text ?? '').join(' ') : ''
      m.apiError = { code: String(d.apiError ?? d.error ?? 'error'), text: t.replace(/^API Error:\s*/i, '').trim().slice(0, 200) || 'an API error', at: when }
    } else if (d.message?.model !== '<synthetic>') m.apiError = null
  }
  if (d.type === 'assistant' && Array.isArray(d.message?.content) && !d.isSidechain) {
    const text = d.message.content.filter((b: any) => b?.type === 'text' && b.text?.trim()).map((b: any) => b.text).join('\n')
    if (text) m.asking = askingLine(text)
    for (const b of d.message.content) {
      if (b?.type === 'tool_use' && ASK_TOOLS.has(b.name)) {
        m.pending = {
          toolUseId: b.id, tool: b.name, at: when,
          questions: Array.isArray(b.input?.questions) ? b.input.questions.slice(0, 4).map((q: any) => ({
            question: String(q.question ?? '').slice(0, 600), header: q.header, multiSelect: !!q.multiSelect,
            options: (q.options ?? []).slice(0, 6).map((o: any) => ({ label: String(o.label ?? ''), description: o.description ? String(o.description).slice(0, 300) : undefined })),
          })) : undefined,
          plan: typeof b.input?.plan === 'string' ? b.input.plan.slice(0, 3000) : undefined,
        }
      }
    }
    for (const b of d.message.content) {
      if (b?.type !== 'tool_use' || b.name !== 'SendMessage' || !b.input?.to) continue
      const to = String(b.input.to).replace(/\s*\[[^\]]*\]\s*$/, '')
      if (/^a[0-9a-f]{12,}$/.test(to)) continue // an in-process subagent, not another session
      const toPid = /cc-socks\/(\d+)\.sock/.exec(to)?.[1]
      idx.edges.push({
        at: when, from: m.agentName ?? m.title ?? id.slice(0, 8), to, fromSession: id, toSession: null,
        summary: String(b.input.summary ?? b.input.message ?? '').slice(0, 240), dir: 'out', toPid: toPid ? +toPid : undefined,
      })
    }
  }
}

/**
 * Count one assistant entry's usage into the session's tokens [T1111-13]. Claude Code writes one line per
 * content block of a message, each with that message's usage: a line with the id counted last replaces what
 * that id added (its later lines can carry the final output count), so each message counts once.
 */
export function addUsage(m: Pick<Meta, 'tokens' | 'usage'>, id: unknown, u: any) {
  const n = (x: unknown) => (typeof x === 'number' && x > 0 ? x : 0)
  const cacheRead = n(u?.cache_read_input_tokens)
  const cacheWrite = n(u?.cache_creation_input_tokens)
  const t: Tokens = { in: n(u?.input_tokens) + cacheRead + cacheWrite, out: n(u?.output_tokens), cacheRead, cacheWrite }
  const tot = (m.tokens ??= { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })
  const key = typeof id === 'string' && id ? id : ''
  if (key && m.usage?.id === key) {
    const p = m.usage.t
    tot.in -= p.in
    tot.out -= p.out
    tot.cacheRead = (tot.cacheRead ?? 0) - (p.cacheRead ?? 0)
    tot.cacheWrite = (tot.cacheWrite ?? 0) - (p.cacheWrite ?? 0)
  }
  tot.in += t.in
  tot.out += t.out
  tot.cacheRead = (tot.cacheRead ?? 0) + (t.cacheRead ?? 0)
  tot.cacheWrite = (tot.cacheWrite ?? 0) + (t.cacheWrite ?? 0)
  m.usage = key ? { id: key, t } : undefined
}

/** Read what was appended to one file since last time, in 8 MB chunks, whole lines only. */
// file -> the tool_use id it waits on, so the answering tool_result line gets parsed
const pendingIn = new Map<string, string>()
function readNew(file: string) {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return
  }
  let off = idx.offsets[file] ?? 0
  if (size < off) off = 0 // rewritten
  if (size === off) return
  const fd = openSync(file, 'r')
  try {
    let newest = 0
    // lines arrive as bytes (src/lines.ts): only the ones the filter keeps become strings [T1112-112]
    const end = eachLine(fd, off, size, (line) => {
      const pend = pendingIn.get(file)
      // an assistant line is parsed only when it holds text (it may end with a question for the owner)
      // an assistant line with text, or with usage (every one has it: tokens per session) [T1111-13]
      const said = line.includes(ASSISTANT) && (line.includes(TEXT) || line.includes(OUTPUT_TOKENS))
      if (!said && !WANT.some((w) => line.includes(w)) && !(pend && line.includes(pend)) && !line.includes(ASK) && !line.includes(PLAN)) return
      try {
        const d = JSON.parse(line.toString())
        apply(file, d)
        const m = idx.metas[d.sessionId || basename(file, '.jsonl')]
        if (m?.pending) pendingIn.set(file, m.pending.toolUseId)
        else pendingIn.delete(file)
      } catch {}
    }, {
      // lines the filter skips (tool calls, progress) are activity too: the newest line's own time counts
      chunk: (whole) => void (newest = Math.max(newest, lastStampIn(whole))),
    })
    idx.offsets[file] = end
    // never the file's mtime: running sessions' transcripts get touched without a new line [T1112-7]
    const m = idx.metas[basename(file, '.jsonl')]
    if (m && newest) m.lastAt = Math.max(m.lastAt, newest)
    dirty = true
  } finally {
    closeSync(fd)
  }
}

function trim() {
  idx.messages.sort((a, b) => a.at - b.at)
  if (idx.messages.length > KEEP_MESSAGES) idx.messages = idx.messages.slice(-KEEP_MESSAGES)
  idx.edges.sort((a, b) => a.at - b.at)
  if (idx.edges.length > KEEP_EDGES) idx.edges = idx.edges.slice(-KEEP_EDGES)
}

function recentFiles(): string[] {
  const cutoff = Date.now() - DAYS * 86400_000
  const out: string[] = []
  if (!existsSync(ROOT)) return out
  for (const dir of readdirSync(ROOT)) {
    const p = join(ROOT, dir)
    let names: string[]
    try {
      names = readdirSync(p)
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const f = join(p, n)
      try {
        if (statSync(f).mtimeMs >= cutoff) out.push(f)
      } catch {}
    }
  }
  return out
}

export function scanAll() {
  for (const f of recentFiles()) readNew(f)
  // session ids learnt from incoming messages: resolve names now that metas are fresh
  resolveEdges()
  trim()
  flush()
}

/**
 * Turn names into session ids. Three sources: a session's /rename and agent-name lines; the pid in a
 * message's socket path (uds:/tmp/cc-socks/<pid>.sock) with the pid->session pairs `claude agents`
 * reports while a session runs; and auto names (my-app-0b), which no transcript records but every
 * incoming message pairs with its sender's socket.
 */
function resolveEdges() {
  const pids = idx.pids ?? {}
  const byName = new Map<string, string>()
  const metas = Object.values(idx.metas).sort((a, b) => a.lastAt - b.lastAt) // newest wins a shared name
  for (const m of metas) {
    if (m.agentName) byName.set(m.agentName, m.id)
    if (m.title) byName.set(m.title, m.id)
  }
  for (const e of idx.edges) {
    if (e.dir === 'in' && e.fromPid && pids[e.fromPid]) {
      e.fromSession ??= pids[e.fromPid]!
      if (!byName.has(e.from)) byName.set(e.from, pids[e.fromPid]!)
    }
  }
  for (const e of idx.edges) {
    if (!e.toSession) e.toSession = (e.toPid && pids[e.toPid]) || byName.get(e.to) || null
    if (!e.fromSession) e.fromSession = (e.fromPid && pids[e.fromPid]) || byName.get(e.from) || null
  }
}

/** pid -> session pairs from `claude agents --json`, kept so later messages from that pid resolve. */
export function notePids(list: { pid?: number; sessionId: string }[]) {
  const pids = (idx.pids ??= {})
  let changed = false
  for (const a of list) {
    if (a.pid && pids[a.pid] !== a.sessionId) {
      pids[a.pid] = a.sessionId
      changed = true
    }
  }
  if (changed) {
    resolveEdges()
    dirty = true
  }
}

function flush() {
  if (!dirty) return
  dirty = false
  writeFileSync(INDEX, JSON.stringify(idx), { mode: 0o600 })
  for (const fn of listeners) fn()
}

let started = false
/** Initial scan, then follow: fs.watch for speed, a 5 s sweep in case an event is missed. */
export function start() {
  if (started) return
  started = true
  scanAll()
  const pending = new Set<string>()
  let t: ReturnType<typeof setTimeout> | null = null
  const kick = () => {
    if (t) return
    t = setTimeout(() => {
      t = null
      for (const f of pending) readNew(f)
      pending.clear()
      resolveEdges()
      trim()
      flush()
    }, 300)
  }
  try {
    watch(ROOT, { recursive: true }, (_ev, name) => {
      if (!name || !String(name).endsWith('.jsonl') || String(name).includes('/subagents/')) return
      pending.add(join(ROOT, String(name)))
      kick()
    })
  } catch {}
  setInterval(() => scanAll(), 5000).unref?.()
}

export const meta = (id: string): Meta | undefined => idx.metas[id]

/**
 * The question a session's turn ended on, if any. Index entries from before `asking` existed get it once
 * from the file's last 256 KB, so the index is not rebuilt from scratch.
 */
/** the API error its last reply ended on, or null [T1112-1] */
export const apiErrorOf = (id: string) => idx.metas[id]?.apiError ?? null

export function askingOf(id: string): string | null {
  const m = idx.metas[id]
  if (!m) return null
  if (m.asking === undefined) {
    m.asking = null
    try {
      const size = statSync(m.file).size
      const start = Math.max(0, size - 256 * 1024)
      const fd = openSync(m.file, 'r')
      const buf = Buffer.allocUnsafe(size - start)
      const n = readSync(fd, buf, 0, buf.length, start)
      closeSync(fd)
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue
        try {
          const d = JSON.parse(line)
          if (d.isSidechain) continue
          if (d.type === 'user' && ownerText(d)) m.asking = null
          if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
            const text = d.message.content.filter((b: any) => b?.type === 'text' && b.text?.trim()).map((b: any) => b.text).join('\n')
            if (text) m.asking = askingLine(text)
          }
        } catch {}
      }
    } catch {}
    dirty = true
  }
  return m.asking ?? null
}
/** /rename wins, then the messaging name, then Claude Code's own title, then the first message. */
export function nameOf(id: string): string | null {
  const m = idx.metas[id]
  return m ? m.title ?? m.agentName ?? m.aiTitle ?? (m.firstPrompt ? m.firstPrompt.slice(0, 40) : null) : null
}
export const metas = () => idx.metas
export function messages(limit = 100): (OwnerMessage & { title: string | null; cwd: string | null })[] {
  return idx.messages
    .slice(-limit)
    .reverse()
    .map((m) => ({ ...m, title: nameOf(m.sessionId), cwd: idx.metas[m.sessionId]?.cwd ?? null }))
}
/** The owner's messages to one session that the index still holds (oldest first). */
export const ownerMessages = (id: string) => idx.messages.filter((m) => m.sessionId === id)
export function pendingAll(): (Pending & { sessionId: string; cwd: string | null; title: string | null })[] {
  const cutoff = Date.now() - 2 * 86400_000
  return Object.values(idx.metas)
    .filter((m) => m.pending && m.pending.at > cutoff)
    .map((m) => ({ ...m.pending!, sessionId: m.id, cwd: m.cwd, title: nameOf(m.id) }))
    .sort((a, b) => b.at - a.at)
}
export function edges(sinceMs = Date.now() - DAYS * 86400_000) {
  const list = idx.edges.filter((e) => e.at >= sinceMs)
  const names: Record<string, string> = {}
  for (const e of list) for (const id of [e.fromSession, e.toSession]) if (id && !names[id]) names[id] = nameOf(id) ?? id.slice(0, 8)
  return { edges: list, names }
}

/** A message sent through `deck send` (any tool to any tool), so the agent map shows it too. */
export function noteDeckMessage(m: { from: string; fromSession: string | null; to: string; toSession: string | null; text: string }) {
  const summary = m.text.trim().slice(0, 240)
  const at = Date.now()
  // the receiving transcript may already have been read (a Claude session writes the turn at once)
  const known = idx.edges.find((e) => sameDeck(e, m.toSession, summary, at))
  if (known) Object.assign(known, { from: m.from, fromSession: m.fromSession ?? known.fromSession })
  else idx.edges.push({ at, from: m.from, to: m.to, fromSession: m.fromSession, toSession: m.toSession, summary, dir: 'in', via: 'deck' })
  dirty = true
  flush()
}
