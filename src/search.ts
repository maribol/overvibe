// Search inside every conversation [T1112-18]: ⌘K's "In sessions" group and `overvibe search`.
//
// Claude transcripts (~/.claude/projects/*/<id>.jsonl, every one on this Mac, not only the sidebar's 7 days)
// and Codex rollouts ($CODEX_HOME/sessions/**/rollout-*.jsonl) are big (8 GB of Claude alone), but what can be
// searched in them is small: the owner's messages, a peer's `overvibe send`, and the agent's own text replies
// come to ~1% of the bytes (tool calls and results are left out). That text is kept in memory per file with
// the read offset, so a search only reads what was appended since the last one, and saved in the data dir
// (search.json, mode 600: it holds conversation text) so a restart does not read 10 GB again.
// Matching is case-insensitive; several words must all be in the same message. Newest match first.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ownerText, deckHeader } from './transcripts'
import { B, eachLine } from './lines'

export type Role = 'you' | 'claude' | 'codex' | 'peer' | 'screen'
export type Doc = { at: number; role: Role; text: string }
type FileEntry = {
  tool: 'claude' | 'codex'
  off: number
  sid: string | null
  cwd: string | null
  title: string | null
  first: string | null
  /** not a session of its own (a Codex subagent or `codex exec` run), or not JSONL */
  skip?: boolean
  docs: Doc[]
}
export type Hit = { sessionId: string; tool: 'claude' | 'codex'; at: number; role: Role; snippet: string; hl: [number, number][] }
export type SessionHits = { sessionId: string; tool: 'claude' | 'codex'; cwd: string | null; title: string | null; at: number; hits: Hit[] }

const V = 1
const MAX_DOC = 20_000 // a pasted log or a long plan: its first 20k characters are searched

// ---------- matching ----------

/** The words of a query, lowercased; quotes are dropped ("right click" means both words). */
export function terms(q: string): string[] {
  return [...new Set(q.toLowerCase().replace(/["“”]/g, ' ').split(/\s+/).filter(Boolean))]
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** a word matches where a word starts ("click" finds "Click", "clicking", "ClickBank", not "brightpath" for "right") */
const wordRe = (w: string, flags = 'i') => new RegExp((/^\w/.test(w) ? '\\b' : '') + esc(w), flags)
export const matcher = (words: string[]) => {
  const res = words.map((w) => wordRe(w))
  return (text: string) => res.every((r) => r.test(text))
}

/**
 * A short piece of `text` around the match, on one line, with the ranges of every word in it to highlight.
 * It centers on the whole phrase when it is there, else on the first word found.
 */
export function snippet(text: string, words: string[], before = 50, after = 110): { snippet: string; hl: [number, number][] } {
  let at = words.length > 1 ? text.search(wordRe(words.join(' '))) : -1
  if (at < 0) {
    const found = words.map((w) => text.search(wordRe(w))).filter((i) => i >= 0)
    at = found.length ? Math.min(...found) : 0
  }
  let a = Math.max(0, at - before)
  let b = Math.min(text.length, at + after)
  if (a > 0) {
    const sp = text.lastIndexOf(' ', at)
    const sp2 = text.indexOf(' ', a)
    if (sp2 >= 0 && sp2 < at) a = sp2 + 1
    else if (sp >= a) a = sp + 1
  }
  if (b < text.length) {
    const sp = text.lastIndexOf(' ', b)
    if (sp > at + 20) b = sp
  }
  let s = text.slice(a, b).replace(/\s+/g, ' ').trim()
  if (a > 0) s = '…' + s
  if (b < text.length) s += '…'
  const hl: [number, number][] = []
  for (const w of words) for (const m of s.matchAll(wordRe(w, 'gi'))) hl.push([m.index!, m.index! + w.length])
  hl.sort((x, y) => x[0] - y[0])
  // overlapping words ("click" in "right click"): one range
  const out: [number, number][] = []
  for (const r of hl) {
    const last = out.at(-1)
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([...r])
  }
  return { snippet: s, hl: out }
}

// ---------- reading ----------

const stamp = (d: any) => {
  const t = d?.timestamp ? Date.parse(d.timestamp) : NaN
  return Number.isFinite(t) ? t : 0
}
const cut = (s: string) => (s.length > MAX_DOC ? s.slice(0, MAX_DOC) : s)

const USER = B('"type":"user"')
const ASST = B('"type":"assistant"')
const TEXT = B('"type":"text"')
const QUEUED = B('"queued_command"')
const CTITLE = B('"custom-title"')
const ATITLE = B('"ai-title"')
const CWD = B('"cwd"')
const RESPONSE_ITEM = B('"response_item"')
const MESSAGE = B('"type":"message"')
const COMPACTED = B('"type":"compacted"') // a compact repeats the whole history on one line

/** One Claude transcript line (bytes, src/lines.ts) into the file's entry. */
function claudeLine(e: FileEntry, line: Buffer) {
  const user = line.includes(USER)
  const asst = !user && line.includes(ASST) && line.includes(TEXT)
  const queued = !user && !asst && line.includes(QUEUED)
  const titled = !user && !asst && (line.includes(CTITLE) || line.includes(ATITLE))
  if (!user && !asst && !queued && !titled && (e.cwd || !line.includes(CWD))) return
  let d: any
  try {
    d = JSON.parse(line.toString())
  } catch {
    return
  }
  if (d.cwd && !e.cwd) e.cwd = d.cwd
  if (d.type === 'custom-title' && d.customTitle) e.title = String(d.customTitle)
  if (d.type === 'ai-title' && d.aiTitle && !e.title) e.title = String(d.aiTitle)
  if (d.isSidechain) return
  const at = stamp(d) || e.docs.at(-1)?.at || 0
  if (d.type === 'user') {
    const t = ownerText(d)
    if (t) {
      e.first ??= t.slice(0, 120)
      e.docs.push({ at, role: 'you', text: cut(t) })
      return
    }
    // a peer's `overvibe send`: searchable too, marked as from another session
    const c = d.message?.content
    const s = typeof c === 'string' ? c : Array.isArray(c) && !c.some((b: any) => b?.type === 'tool_result') ? c.map((b: any) => b?.text ?? '').join('\n') : ''
    const p = s && deckHeader(s.trimStart())
    if (p && p.body) e.docs.push({ at, role: 'peer', text: cut(p.body) })
  } else if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
    const t = d.message.content.filter((b: any) => b?.type === 'text' && b.text?.trim()).map((b: any) => b.text).join('\n')
    if (t) e.docs.push({ at, role: 'claude', text: cut(t) })
  } else if (d.type === 'attachment' && d.attachment?.type === 'queued_command' && d.attachment.origin?.kind === 'human' && typeof d.attachment.prompt === 'string') {
    const t = d.attachment.prompt.trim()
    if (t && !t.startsWith('<') && !t.startsWith('[overvibe ') && !t.startsWith('[deck message')) e.docs.push({ at, role: 'you', text: cut(t) })
  }
}

/** One Codex rollout line: the first one says whose it is; then the user's and Codex's messages. */
function codexLine(e: FileEntry, line: Buffer) {
  if (!e.sid) {
    let d: any
    try {
      d = JSON.parse(line.toString())
    } catch {
      e.skip = true
      return
    }
    const p = d?.type === 'session_meta' ? d.payload : null
    const sub = p?.parent_thread_id || (p?.source && typeof p.source === 'object' && p.source.subagent)
    if (!p?.id || sub || p.source === 'exec' || p.originator === 'codex_exec') {
      e.skip = true
      return
    }
    e.sid = String(p.id)
    e.cwd = p.cwd ?? null
    return
  }
  // response_item messages carry both sides in every Codex version (event_msg repeats them in older ones)
  if (line.subarray(0, 200).includes(COMPACTED) || !line.includes(RESPONSE_ITEM) || !line.includes(MESSAGE)) return
  let d: any
  try {
    d = JSON.parse(line.toString())
  } catch {
    return
  }
  const p = d?.payload
  if (d?.type !== 'response_item' || p?.type !== 'message' || !Array.isArray(p.content)) return
  const at = stamp(d) || e.docs.at(-1)?.at || 0
  if (p.role === 'user') {
    const t = p.content.filter((b: any) => b?.type === 'input_text').map((b: any) => b.text).join('\n').trim()
    if (!t || t.startsWith('<') || t.startsWith('# AGENTS.md instructions')) return
    const peer = deckHeader(t)
    if (peer) return void (peer.body && e.docs.push({ at, role: 'peer', text: cut(peer.body) }))
    e.first ??= t.slice(0, 120)
    e.docs.push({ at, role: 'you', text: cut(t) })
  } else if (p.role === 'assistant') {
    const t = p.content.filter((b: any) => b?.type === 'output_text').map((b: any) => b.text).join('\n').trim()
    if (t) e.docs.push({ at, role: 'codex', text: cut(t) })
  }
}

// ---------- the index ----------

// search.json is JSON lines: a header, then one [path, entry] array per file, so it is written and read an
// entry at a time. One JSON.stringify or JSON.parse of the whole 28 MB made the server's memory jump by 130 MB at
// every save [T1112-112]. The first layout (one JSON object, {"v":1,"files":{...}}) is still read, once.
const HEAD = JSON.stringify({ v: V, layout: 'lines' })

function loadFile(file: string): Record<string, FileEntry> | null {
  if (!existsSync(file)) return null
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const head = Buffer.alloc(HEAD.length + 1)
    readSync(fd, head, 0, head.length, 0)
    if (head.toString() === HEAD + '\n') {
      const out: Record<string, FileEntry> = {}
      eachLine(fd, head.length, statSync(file).size, (b) => {
        const [k, e] = JSON.parse(b.toString())
        out[k] = e
      })
      return out
    }
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return j?.v === V && j.files ? j.files : null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function saveFile(file: string, files: Record<string, FileEntry>) {
  const tmp = file + '.tmp'
  const fd = openSync(tmp, 'w', 0o600)
  try {
    let out = HEAD + '\n'
    for (const k in files) {
      out += JSON.stringify([k, files[k]]) + '\n'
      if (out.length > 1 << 20) {
        writeSync(fd, out)
        out = ''
      }
    }
    writeSync(fd, out)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

export type IndexOpts = { claudeRoot: string; codexRoot: string; file?: string | null }

export function createIndex(o: IndexOpts) {
  let files: Record<string, FileEntry> = (o.file && loadFile(o.file)) || {}
  let dirty = false

  /** Read what was appended to one file since last time (8 MB at a time, whole lines only). */
  function readNew(path: string, tool: 'claude' | 'codex', size: number) {
    let e = files[path]
    if (!e) files[path] = e = { tool, off: 0, sid: tool === 'claude' ? basename(path, '.jsonl') : null, cwd: null, title: null, first: null, docs: [] }
    if (e.skip) return
    if (size < e.off) Object.assign(e, { off: 0, docs: [], first: null, ...(tool === 'codex' ? { sid: null } : {}) }) // rewritten
    if (size === e.off) return
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch {
      return
    }
    try {
      const en = e
      // lines arrive as bytes (src/lines.ts): tool calls and their output never become strings [T1112-112]
      const off = eachLine(fd, e.off, size, (line) => {
        if (tool === 'claude') claudeLine(en, line)
        else codexLine(en, line)
        if (en.skip) return false
      })
      if (e.skip) {
        e.docs = []
        return
      }
      e.off = off
      dirty = true
    } finally {
      closeSync(fd)
    }
  }

  /** Every transcript and rollout with its size, newest first. */
  function list(): { path: string; tool: 'claude' | 'codex'; size: number; mtime: number }[] {
    const out: { path: string; tool: 'claude' | 'codex'; size: number; mtime: number }[] = []
    const add = (path: string, tool: 'claude' | 'codex') => {
      try {
        const st = statSync(path)
        out.push({ path, tool, size: st.size, mtime: st.mtimeMs })
      } catch {}
    }
    const dir = (p: string) => {
      try {
        return readdirSync(p)
      } catch {
        return []
      }
    }
    for (const d of dir(o.claudeRoot)) for (const n of dir(join(o.claudeRoot, d))) if (n.endsWith('.jsonl')) add(join(o.claudeRoot, d, n), 'claude')
    // sessions/YYYY/MM/DD/rollout-*.jsonl
    for (const y of dir(o.codexRoot)) for (const m of dir(join(o.codexRoot, y))) for (const dd of dir(join(o.codexRoot, y, m))) {
      const p = join(o.codexRoot, y, m, dd)
      for (const n of dir(p)) if (n.endsWith('.jsonl')) add(join(p, n), 'codex')
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  let ready = false
  let building: Promise<void> | null = null
  let listedAt = 0
  /** First read of everything, a file at a time so the server keeps answering; a search meanwhile sees what is in. */
  function build() {
    building ??= (async () => {
      for (const f of list()) {
        readNew(f.path, f.tool, f.size)
        await new Promise((r) => setTimeout(r, 0))
      }
      listedAt = Date.now()
      ready = true
      save()
    })()
    return building
  }
  /** Catch up with what was written since (at most every 2 s): a stat per file, a read for those that grew. */
  function refresh() {
    if (!ready || Date.now() - listedAt < 2000) return
    listedAt = Date.now()
    for (const f of list()) if ((files[f.path]?.off ?? -1) !== f.size) readNew(f.path, f.tool, f.size)
  }
  function save() {
    if (!o.file || !dirty) return
    dirty = false
    try {
      saveFile(o.file, files)
    } catch (e: any) {
      console.log(`[search] save: ${e?.message ?? e}`)
    }
  }

  /** Sessions whose messages hold every word of `q`, newest match first, at most `per` hits each. */
  function search(q: string, opts: { limit?: number; per?: number } = {}): SessionHits[] {
    const words = terms(q)
    if (!words.length) return []
    refresh()
    const limit = opts.limit ?? 20
    const per = opts.per ?? 3
    const ok = matcher(words)
    const by = new Map<string, SessionHits>()
    for (const e of Object.values(files)) {
      if (e.skip || !e.sid || !e.docs.length) continue
      let n = 0
      // newest first within a file, and a file stops at `per` hits
      for (let i = e.docs.length - 1; i >= 0 && n < per; i--) {
        const d = e.docs[i]!
        if (!ok(d.text)) continue
        n++
        let s = by.get(e.sid)
        if (!s) by.set(e.sid, (s = { sessionId: e.sid, tool: e.tool, cwd: e.cwd, title: e.title ?? e.first, at: 0, hits: [] }))
        s.hits.push({ sessionId: e.sid, tool: e.tool, at: d.at, role: d.role, ...snippet(d.text, words) })
        s.at = Math.max(s.at, d.at)
      }
    }
    const out = [...by.values()]
    for (const s of out) s.hits = s.hits.sort((a, b) => b.at - a.at).slice(0, per)
    return out.sort((a, b) => b.at - a.at).slice(0, limit)
  }

  const stats = () => {
    let docs = 0
    let chars = 0
    for (const e of Object.values(files)) for (const d of e.docs) (docs++, (chars += d.text.length))
    return { files: Object.keys(files).length, docs, chars, ready }
  }
  return { build, refresh, search, save, stats, isReady: () => ready }
}

// ---------- terminal screens ----------

/** Lines of a terminal's screen and scrollback holding every word, newest (lowest on screen) first. */
export function screenHits(text: string, q: string, per = 3): { line: number; snippet: string; hl: [number, number][] }[] {
  const words = terms(q)
  if (!words.length) return []
  const ok = matcher(words)
  const lines = text.split('\n')
  const out: { line: number; snippet: string; hl: [number, number][] }[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < per; i--) {
    const l = lines[i]!
    if (l.trim() && ok(l)) out.push({ line: i, ...snippet(l, words) })
  }
  return out
}
