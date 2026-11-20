// Subagents of a Claude session [T1118-2]: Claude Code writes each one (the Agent tool) next to the session's
// transcript, <session>/subagents/agent-<id>.jsonl, with agent-<id>.meta.json ({ description, agentType,
// finished: true once it ends }). The sidebar lists the running ones under their session; a click shows what
// one is doing, read-only, from its transcript. A meta without `finished` whose transcript has not moved for
// 30 minutes is taken as gone (its session was stopped mid-run).
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type SubAgent = { id: string; desc: string; type: string; started: number; at: number; /** what it is doing now: its last tool call, the line Claude Code shows in its list [T1119-23] */ step?: string }
export type SubEvent = { at: number; kind: 'prompt' | 'text' | 'tool' | 'error'; text: string }

const STALE_MS = 30 * 60_000
const dirOf = (transcript: string) => join(transcript.replace(/\.jsonl$/, ''), 'subagents')
export const validId = (id: string) => /^[a-z0-9]{6,40}$/i.test(id)

// view() runs every couple of seconds for every session: one listing per folder per 3 s
const cache = new Map<string, { at: number; list: SubAgent[] }>()
export function runningSubagents(transcript: string, now = Date.now()): SubAgent[] {
  const dir = dirOf(transcript)
  const hit = cache.get(dir)
  if (hit && now - hit.at < 3000) return hit.list
  const list: SubAgent[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {}
  for (const n of names) {
    const m = /^agent-([a-z0-9]+)\.meta\.json$/i.exec(n)
    if (!m) continue
    try {
      const meta = JSON.parse(readFileSync(join(dir, n), 'utf8'))
      if (meta.finished) continue
      const st = statSync(join(dir, `agent-${m[1]}.jsonl`))
      if (now - st.mtimeMs > STALE_MS) continue
      list.push({ step: lastStep(join(dir, `agent-${m[1]}.jsonl`), st.size), id: m[1]!, desc: String(meta.description ?? meta.agentType ?? 'subagent').slice(0, 120), type: String(meta.agentType ?? 'agent'), started: st.birthtimeMs || st.ctimeMs, at: st.mtimeMs })
    } catch {}
  }
  list.sort((a, b) => a.started - b.started)
  cache.set(dir, { at: now, list })
  return list
}

/** Its last tool call, read from the transcript's end (64 KB): the tool's own description, else what it touches. */
function lastStep(file: string, size: number): string | undefined {
  try {
    const from = Math.max(0, size - 64 * 1024)
    const buf = Buffer.alloc(size - from)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, buf.length, from)
    } finally {
      closeSync(fd)
    }
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('"tool_use"')) continue
      let d: any
      try {
        d = JSON.parse(lines[i]!)
      } catch {
        continue
      }
      const uses = (Array.isArray(d.message?.content) ? d.message.content : []).filter((b: any) => b?.type === 'tool_use')
      const b = uses.at(-1)
      if (!b) continue
      const desc = typeof b.input?.description === 'string' && b.input.description.trim()
      return (desc || toolLine(b.name, b.input)).replace(/\s+/g, ' ').slice(0, 120)
    }
  } catch {}
}

/** A subagent's description and type from its meta file, finished or not. */
export function subagentMeta(transcript: string, id: string): { desc: string; type: string } | null {
  if (!validId(id)) return null
  try {
    const m = JSON.parse(readFileSync(join(dirOf(transcript), `agent-${id}.meta.json`), 'utf8'))
    return { desc: String(m.description ?? ''), type: String(m.agentType ?? 'agent') }
  } catch {
    return null
  }
}

/** One line of what a tool call does: its description, command, file or pattern. */
function toolLine(name: string, input: any): string {
  const i = input ?? {}
  const what = i.description ?? i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.prompt ?? ''
  return `${name}${what ? `: ${String(what).replace(/\s+/g, ' ').slice(0, 220)}` : ''}`
}

/** The subagent's prompt, replies and tool calls, oldest first (the last `max`; a long transcript is read from its end). */
export function subagentLog(transcript: string, id: string, max = 200) {
  if (!validId(id)) throw new Error('bad subagent id')
  const dir = dirOf(transcript)
  let meta: any = {}
  try {
    meta = JSON.parse(readFileSync(join(dir, `agent-${id}.meta.json`), 'utf8'))
  } catch {}
  const file = join(dir, `agent-${id}.jsonl`)
  const st = statSync(file)
  const TAIL = 4 * 2 ** 20
  const from = Math.max(0, st.size - TAIL)
  const buf = Buffer.alloc(st.size - from)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buf, 0, buf.length, from)
  } finally {
    closeSync(fd)
  }
  const lines = buf.toString('utf8').split('\n')
  if (from > 0) lines.shift() // a partial first line
  const events: SubEvent[] = []
  for (const l of lines) {
    if (!l) continue
    let d: any
    try {
      d = JSON.parse(l)
    } catch {
      continue
    }
    const at = Date.parse(d.timestamp ?? '') || 0
    const c = d.message?.content
    if (d.type === 'user') {
      if (typeof c === 'string' && c.trim()) events.push({ at, kind: 'prompt', text: c.trim().slice(0, 4000) })
      else if (Array.isArray(c))
        for (const b of c) {
          if (b?.type === 'text' && b.text?.trim()) events.push({ at, kind: 'prompt', text: b.text.trim().slice(0, 4000) })
          if (b?.type === 'tool_result' && b.is_error) {
            const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x?.text ?? '').join(' ') : ''
            events.push({ at, kind: 'error', text: t.replace(/\s+/g, ' ').slice(0, 300) })
          }
        }
    } else if (d.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'text' && b.text?.trim()) events.push({ at, kind: 'text', text: b.text.trim().slice(0, 6000) })
        else if (b?.type === 'tool_use') events.push({ at, kind: 'tool', text: toolLine(b.name, b.input) })
      }
    }
  }
  // its task is the transcript's first line, which a long run's last `max` events no longer hold
  let task: string | null = null
  try {
    const head = Buffer.alloc(Math.min(st.size, 256 * 1024))
    const hfd = openSync(file, 'r')
    try {
      readSync(hfd, head, 0, head.length, 0)
    } finally {
      closeSync(hfd)
    }
    const first = JSON.parse(head.toString('utf8').split('\n')[0]!)
    const c = first.message?.content
    task = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '').trim().slice(0, 8000) || null
  } catch {}
  const tail = events.slice(-max)
  return {
    id,
    task,
    desc: String(meta.description ?? 'subagent'),
    type: String(meta.agentType ?? 'agent'),
    running: !meta.finished && Date.now() - st.mtimeMs < STALE_MS,
    at: st.mtimeMs,
    events: task ? tail.filter((e) => !(e.kind === 'prompt' && e.text === task!.slice(0, 4000))) : tail,
  }
}
