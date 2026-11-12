// What a session was about, for its card: facts (times, tool, account, model), the owner's first and
// last prompts, the last few exchanges read from the tail of its transcript, its TASKS.md lines and its
// messages with other sessions. Plain text only; the page renders it as text.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HOME, tildify } from './env'
import { edges, meta, nameOf, ownerMessages, ownerText } from './transcripts'
import { recordFor } from './sessions'
import { codexInfo } from './codex'
import { listAccounts } from './accounts'
import { tasksFor } from './tasks'
import { getSettings } from './routing'

const ROOT = join(HOME, '.claude', 'projects')
const TAIL = 512 * 1024
const CLIP = 600

export type Exchange = { at: number | null; you: string; reply: string | null }

function transcriptFile(id: string): string | null {
  const f = meta(id)?.file
  if (f && existsSync(f)) return f
  try {
    for (const dir of readdirSync(ROOT)) {
      const p = join(ROOT, dir, `${id}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {}
  return null
}

const clip = (t: string) => (t.length > CLIP ? t.slice(0, CLIP).trimEnd() + '…' : t)

/** The last `n` owner messages with Claude's final text reply to each, from the file's last 512 KB. */
function lastExchanges(file: string, n = 3): { list: Exchange[]; partial: boolean; lastReply: string | null; model: string | null; lastFull: string | null; answered: boolean } {
  const size = statSync(file).size
  const start = Math.max(0, size - TAIL)
  const fd = openSync(file, 'r')
  let text: string
  try {
    const buf = Buffer.allocUnsafe(size - start)
    const got = readSync(fd, buf, 0, buf.length, start)
    text = buf.subarray(0, got).toString('utf8')
  } finally {
    closeSync(fd)
  }
  const lines = text.split('\n')
  if (start > 0) lines.shift() // a cut first line
  const list: Exchange[] = []
  let lastReply: string | null = null
  let lastFull: string | null = null
  let model: string | null = null
  // the owner wrote after the last reply (a prompt, or one Claude Code queued mid-turn) [T1112-115]
  let answered = false
  for (const line of lines) {
    const user = line.includes('"type":"user"')
    const queued = !user && line.includes('"queued_command"')
    if (!user && !queued && !line.includes('"type":"assistant"')) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.isSidechain) continue
    if (d.type === 'attachment') {
      const a = d.attachment
      const t = a?.type === 'queued_command' && a.origin?.kind === 'human' && typeof a.prompt === 'string' ? a.prompt.trim() : ''
      if (t && !t.startsWith('<') && lastFull) answered = true
    } else if (d.type === 'user') {
      const t = ownerText(d)
      if (t) list.push({ at: d.timestamp ? Date.parse(d.timestamp) : null, you: clip(t), reply: null })
      if (t && lastFull) answered = true
    } else if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
      if (d.message.model && d.message.model !== '<synthetic>') model = d.message.model
      // the last text block of the turn is its answer; tool calls and thinking are skipped
      const t = d.message.content.filter((b: any) => b?.type === 'text' && b.text?.trim()).map((b: any) => b.text.trim()).join('\n')
      if (t) {
        lastFull = t
        answered = false
        lastReply = clip(t)
        if (list.length) list.at(-1)!.reply = lastReply
      }
    }
  }
  return { list: list.slice(-n), partial: start > 0, lastReply, model, lastFull, answered }
}

/** A transcript's last reply, whole, and whether the owner has written since it [T1112-115]. */
export function replyState(file: string): { reply: string | null; answered: boolean } {
  const { lastFull, answered } = lastExchanges(file, 1)
  return { reply: lastFull, answered }
}

/** A Claude session's last reply, whole (Close old sessions reads its end) [T1111-30]. */
export function lastReplyOf(id: string): string | null {
  const file = transcriptFile(id)
  if (!file) return null
  try {
    return lastExchanges(file, 1).lastFull
  } catch {
    return null
  }
}

/** lastReplyOf, with whether the owner has answered it since [T1112-115]. */
export function lastReplyStateOf(id: string): { reply: string | null; answered: boolean } {
  const file = transcriptFile(id)
  if (!file) return { reply: null, answered: false }
  try {
    return replyState(file)
  } catch {
    return { reply: null, answered: false }
  }
}

export function summary(id: string) {
  const m = meta(id)
  const rec = recordFor(id)
  const cx = m ? undefined : codexInfo(id)
  const tool = rec?.tool ?? (cx ? 'codex' : 'claude')
  // the account it last ran on: the deck's own record, with that account's email from the deck's probe
  const account: string | null = rec?.account || null
  const email: string | null = account ? listAccounts().find((a) => a.name === account)?.email ?? null : null

  const file = tool === 'claude' ? transcriptFile(id) : null
  let exchanges: Exchange[] = []
  let partial = false
  let lastReply: string | null = null
  let model: string | null = null
  if (file) {
    try {
      ;({ list: exchanges, partial, lastReply, model } = lastExchanges(file))
    } catch {}
  }
  // a long session's tail can hold fewer than 3 of the owner's messages: older ones come from the index
  if (exchanges.length < 3) {
    const first = exchanges[0]?.at ?? Infinity
    const older = ownerMessages(id).filter((x) => x.at < first - 1000).slice(-(3 - exchanges.length))
    exchanges = [...older.map((x) => ({ at: x.at, you: clip(x.text), reply: null })), ...exchanges]
  }
  // its latest answer, when it was to another session's message rather than to the owner
  if (lastReply && lastReply === exchanges.at(-1)?.reply) lastReply = null

  const id8 = id.slice(0, 8)
  const cwd = m?.cwd ?? cx?.cwd ?? rec?.cwd ?? null
  const tasks = cwd && getSettings().tasksView !== false
    ? tasksFor([cwd]).flatMap((f) => f.tasks.filter((t) => t.sessions.includes(id8)).map((t) => ({ ...t, file: f.file })))
    : []

  const e = edges()
  const talk = e.edges
    .filter((x) => x.fromSession === id || x.toSession === id)
    .slice(-8)
    .reverse()
    .map((x) => {
      const out = x.fromSession === id
      const other = out ? x.toSession : x.fromSession
      return { at: x.at, dir: out ? 'to' : 'from', who: (other && e.names[other]) || (out ? x.to : x.from), session: other, text: x.summary }
    })

  return {
    id,
    tool,
    title: m?.title ?? null,
    aiTitle: m?.aiTitle ?? cx?.title ?? null,
    name: nameOf(id) ?? cx?.title ?? null,
    startedAt: m?.startedAt ?? cx?.startedAt ?? null,
    lastAt: m?.lastAt || cx?.lastAt || null,
    account,
    email,
    model,
    turns: null,
    tokens: null,
    firstPrompt: m?.firstPrompt ?? cx?.firstPrompt ?? null,
    lastPrompt: m?.lastPrompt ?? cx?.lastPrompt ?? null,
    transcript: file ? tildify(file) : null,
    exchanges,
    lastReply,
    partial,
    tasks,
    talk,
  }
}
