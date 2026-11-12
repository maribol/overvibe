// What a session's context is made of, read from its transcript, without typing anything into it [T1112-107].
//
// Claude Code writes the exact input size of every request (message.usage on each assistant entry) and Codex
// writes it in token_count events. Between two requests the context grows by exactly the difference, so each
// difference is shared out over the entries written in between (the reply that came back, the tool results,
// the next prompt) by their estimated size (chars / 4). What the first request holds beyond its own entries
// is the fixed overhead: system prompt, tool definitions, and whatever the CLI adds that the transcript leaves
// out. At the end every share is scaled so the parts sum to the exact total of the newest request.
//
// After a compact only what follows counts (and what the compact kept), with "since last compact" set.
// Files can be 50+ MB, so each one is read once in chunks and then only from where the last read stopped;
// the result is cached by size and mtime.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { ACCOUNTS_DIR, HOME } from './env'
import { eachLine } from './lines'

export type Cat = 'overhead' | 'you' | 'replies' | 'thinking' | 'toolCalls' | 'toolOutput' | 'skills' | 'subagents' | 'peers' | 'hooks' | 'system' | 'files' | 'images' | 'summary'
export const CAT_LABEL: Record<Cat, string> = {
  overhead: 'Fixed overhead',
  you: 'Your messages',
  replies: 'Replies',
  thinking: 'Thinking',
  toolCalls: 'Tool calls',
  toolOutput: 'Tool output',
  skills: 'Skill loads',
  subagents: 'Subagent reports',
  peers: 'Messages from sessions',
  hooks: 'Hook output',
  system: 'System notes',
  files: 'Attached files',
  images: 'Images',
  summary: 'Compact summary',
}
const ORDER = Object.keys(CAT_LABEL) as Cat[]

type Item = { cat: Cat; sub?: string; label: string; at: number; est: number; tok: number; uuid?: string }

export type ContextReport = {
  tool: 'claude' | 'codex'
  /** tokens in context now: the newest request's exact input plus the estimate of what came after it */
  total: number
  /** the newest request's exact input (input + cache read + cache write) */
  exactInput: number
  window: number | null
  windowNote: string | null
  percent: number | null
  sinceCompact: boolean
  compactedAt: number | null
  model: string | null
  at: number | null
  requests: number
  categories: { key: Cat; label: string; tokens: number; parts?: { label: string; tokens: number }[] }[]
  top: { label: string; cat: Cat; tokens: number; at: number }[]
}

export const est = (chars: number) => Math.ceil(chars / 4)
const IMAGE_TOKENS = 1600

/** The shared part of both readers: requests, the items between them, the overhead. */
export class Acc {
  seg: Item[] = []
  pend: Item[] = []
  overhead: number | null = null
  prevIn = 0
  lastIn = 0
  requests = 0
  compactedAt: number | null = null
  lastAt: number | null = null
  shape: { system: number; tools: number } | null = null

  /** `held`: an output of the request still going (Codex writes it before the request's token count) */
  add(it: Omit<Item, 'tok'>, held = false): Item {
    const item = { ...it, tok: 0 }
    if (item.est > 0 || item.cat === 'thinking') {
      if (!held) this.pend.push(item)
      this.seg.push(item)
    }
    return item
  }

  /** a request went out whose input was `total` tokens */
  request(total: number) {
    if (!(total > 0)) return
    this.requests++
    const sum = this.pend.reduce((a, i) => a + i.est, 0)
    if (this.overhead === null) {
      this.overhead = Math.max(0, total - sum)
      const f = sum > total ? total / sum : 1
      for (const i of this.pend) i.tok = i.est * f
    } else {
      const delta = total - this.prevIn
      if (delta > 0 && sum > 0) for (const i of this.pend) i.tok = (i.est * delta) / sum
      else if (delta > 0) {
        const it = { cat: 'system' as Cat, label: 'Not in the transcript', at: this.lastAt ?? 0, est: delta, tok: delta }
        this.seg.push(it)
      }
    }
    this.prevIn = total
    this.lastIn = total
    this.pend = []
  }

  /** a compact: only what it kept stays (Claude names the kept entries; Codex hands the new history over) */
  compact(at: number, keep?: Set<string>) {
    this.seg = keep ? this.seg.filter((i) => i.uuid && keep.has(i.uuid)) : []
    for (const i of this.seg) i.tok = 0
    this.pend = [...this.seg]
    this.overhead = null
    this.prevIn = 0
    this.compactedAt = at
  }

  report(tool: 'claude' | 'codex', window: number | null, windowNote: string | null, model: string | null): ContextReport {
    const pendSum = this.pend.reduce((a, i) => a + i.est, 0)
    for (const i of this.pend) i.tok = i.est
    const total = this.lastIn + pendSum
    // scale what came before the newest request so overhead + parts = its exact input
    const before = this.seg.filter((i) => !this.pend.includes(i))
    const got = before.reduce((a, i) => a + i.tok, 0)
    const want = Math.max(0, this.lastIn - (this.overhead ?? 0))
    if (got > 0) for (const i of before) i.tok *= want / got
    else if (want > 0 && before.length) {
      const s = before.reduce((a, i) => a + i.est, 0) || 1
      for (const i of before) i.tok = (i.est * want) / s
    }
    const by = new Map<Cat, { tokens: number; parts: Map<string, number> }>()
    const bump = (cat: Cat, sub: string | undefined, n: number) => {
      let c = by.get(cat)
      if (!c) by.set(cat, (c = { tokens: 0, parts: new Map() }))
      c.tokens += n
      if (sub) c.parts.set(sub, (c.parts.get(sub) ?? 0) + n)
    }
    const base = this.overhead ?? 0
    if (this.shape && this.shape.system + this.shape.tools > 0) {
      const sys = Math.round((base * this.shape.system) / (this.shape.system + this.shape.tools))
      bump('overhead', 'System prompt', sys)
      bump('overhead', 'Tool definitions', base - sys)
    } else bump('overhead', tool === 'codex' ? 'Instructions and tools' : 'System prompt and tools', base)
    for (const i of this.seg) bump(i.cat, i.sub, i.tok)
    const categories = ORDER.filter((k) => (by.get(k)?.tokens ?? 0) >= 0.5).map((k) => {
      const c = by.get(k)!
      const parts = [...c.parts].map(([label, t]) => ({ label, tokens: Math.round(t) })).filter((p) => p.tokens > 0).sort((a, b) => b.tokens - a.tokens)
      return { key: k, label: CAT_LABEL[k], tokens: Math.round(c.tokens), ...(parts.length > 1 || (parts[0] && parts[0].label !== CAT_LABEL[k]) ? { parts } : {}) }
    })
    const top = this.seg
      .filter((i) => i.cat !== 'overhead' && i.tok >= 1)
      .sort((a, b) => b.tok - a.tok)
      .slice(0, 5)
      .map((i) => ({ label: i.label, cat: i.cat, tokens: Math.round(i.tok), at: i.at }))
    const t = Math.round(total)
    return {
      tool,
      total: t,
      exactInput: this.lastIn,
      window,
      windowNote,
      percent: window ? Math.round((t / window) * 1000) / 10 : null,
      sinceCompact: this.compactedAt !== null,
      compactedAt: this.compactedAt,
      model,
      at: this.lastAt,
      requests: this.requests,
      categories,
      top,
    }
  }
}

// ---------------------------------------------------------------------------------------------- text sizes

/** characters of the text a content value carries (string, or blocks of text / tool_result / images) */
function sizeOf(c: any): { chars: number; images: number } {
  if (typeof c === 'string') return { chars: c.length, images: 0 }
  let chars = 0
  let images = 0
  if (Array.isArray(c))
    for (const b of c) {
      if (typeof b === 'string') chars += b.length
      else if (b?.type === 'image' || b?.type === 'input_image') images++
      else if (typeof b?.text === 'string') chars += b.text.length
      else if (b?.content !== undefined) {
        const s = sizeOf(b.content)
        chars += s.chars
        images += s.images
      }
    }
  return { chars, images }
}
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n') : ''
/** the words of a hand-back or a message from a session, without the frame around them */
export function bodyOf(text: string): string {
  const i = text.indexOf('The report follows:')
  const t = i >= 0 ? text.slice(i + 'The report follows:'.length) : text.replace(/^Another Claude session sent a message:\s*/, '')
  return t.replace(/<[^>]+>/g, ' ').replace(/\[Subagent hand-back\]/g, ' ')
}
const clip = (s: string, n = 60) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** "Read src/App.vue", "Bash Run the tests", "Agent Review the diff" */
export function toolLabel(name: string, input: any, cwd?: string | null): string {
  const rel = (p: unknown) => {
    if (typeof p !== 'string') return ''
    if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1)
    return p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p
  }
  const i = input ?? {}
  const what =
    rel(i.file_path ?? i.notebook_path ?? i.path) ||
    i.description ||
    i.skill ||
    i.pattern ||
    i.url ||
    i.query ||
    i.prompt ||
    i.command ||
    i.cmd ||
    ''
  return clip(`${name}${what ? ' ' + String(what) : ''}`.split(HOME + '/').join('~/'), 70)
}

// ------------------------------------------------------------------------------------------- Claude Code

const SETUP: Record<string, string> = {
  skill_listing: 'Skills list',
  instructions: 'CLAUDE.md',
  nested_memory: 'CLAUDE.md',
  deferred_tools_delta: 'Tool and MCP lists',
  mcp_instructions_delta: 'Tool and MCP lists',
  agent_listing_delta: 'Tool and MCP lists',
  environment: 'Session setup',
  model: 'Session setup',
  session_context: 'Session setup',
  date: 'Session setup',
  auto_mode: 'Session setup',
  credential_org: 'Session setup',
  remote_session_change: 'Session setup',
  output_style: 'Session setup',
}
const SKIP_TYPES = ['queue-operation', 'api-request"', 'api-request-blob', 'last-prompt', 'mode', 'permission-mode', 'session-owner', 'atis-latch', 'ai-title', 'bridge-session', 'custom-title', 'agent-name', 'file-history-snapshot', 'file-history-delta', 'tools-used', 'cost-state', 'summary']
const SKIP_PREFIX = SKIP_TYPES.map((t) => `{"type":"${t.endsWith('"') ? t : t + '"'}`)

export class ClaudeReader {
  acc = new Acc()
  tools = new Map<string, { name: string; label: string }>()
  msgId: string | null = null
  msgItems: Item[] = []
  thinking: Item | null = null
  lastOut = 0
  model: string | null = null
  cwd: string | null = null

  line(line: string) {
    if (line.length < 20) return
    for (const p of SKIP_PREFIX) if (line.startsWith(p)) return
    if (line.startsWith('{"type":"api-request-shape"')) {
      try {
        const sh = JSON.parse(line)?.shape
        if (sh) this.acc.shape = { system: JSON.stringify(sh.system ?? '').length, tools: JSON.stringify(sh.tools ?? '').length }
      } catch {}
      return
    }
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      return
    }
    this.entry(d)
  }

  entry(d: any) {
    if (!d || d.isSidechain) return
    const at = Date.parse(d.timestamp ?? '') || this.acc.lastAt || 0
    if (at) this.acc.lastAt = at
    this.cwd ??= d.cwd ?? null
    const acc = this.acc
    if (d.type === 'system') {
      if (d.subtype === 'compact_boundary') {
        const keep = d.compactMetadata?.preservedMessages?.allUuids ?? d.compactMetadata?.preservedMessages?.uuids
        acc.compact(at, Array.isArray(keep) ? new Set(keep) : undefined)
        this.msgId = null
      }
      return
    }
    if (d.type === 'assistant') return this.assistant(d, at)
    if (d.type === 'user') return this.user(d, at)
    if (d.type === 'attachment') return this.attachment(d.attachment, at, d.uuid)
  }

  assistant(d: any, at: number) {
    const m = d.message
    if (!m || m.model === '<synthetic>') return
    const u = m.usage
    const id = m.id ?? d.requestId ?? d.uuid
    if (id !== this.msgId) {
      this.msgId = id
      this.msgItems = []
      this.thinking = null
      if (u) this.acc.request((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))
      if (m.model) this.model = m.model
    }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'text' && b.text) this.msgItems.push(this.acc.add({ cat: 'replies', label: 'Reply: ' + clip(b.text), at, est: est(b.text.length), uuid: d.uuid }))
      else if (b?.type === 'tool_use') {
        const label = toolLabel(b.name ?? 'tool', b.input, this.cwd)
        this.tools.set(b.id, { name: b.name ?? 'tool', label })
        this.msgItems.push(this.acc.add({ cat: 'toolCalls', sub: b.name, label: 'Call ' + label, at, est: est(JSON.stringify(b.input ?? {}).length + 20), uuid: d.uuid }))
      } else if ((b?.type === 'thinking' || b?.type === 'redacted_thinking') && !this.thinking) {
        this.thinking = this.acc.add({ cat: 'thinking', label: 'Thinking', at, est: 0, uuid: d.uuid })
      }
    }
    // the output count is exact: what the visible blocks don't explain is thinking
    const out = u?.output_tokens ?? 0
    if (out) {
      this.lastOut = Math.max(this.lastOut, out)
      if (this.thinking) {
        const vis = this.msgItems.reduce((a, i) => a + i.est, 0)
        this.thinking.est = Math.max(this.thinking.est, out - vis)
      }
    }
  }

  user(d: any, at: number) {
    const c = d.message?.content
    const uuid = d.uuid
    const add = (cat: Cat, label: string, chars: number, sub?: string) => chars > 0 && this.acc.add({ cat, sub, label, at, est: est(chars), uuid })
    const images = (n: number, label: string) => n > 0 && this.acc.add({ cat: 'images', label, at, est: n * IMAGE_TOKENS, uuid })
    if (Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')) {
      for (const b of c) {
        if (b?.type !== 'tool_result') continue
        const t = this.tools.get(b.tool_use_id)
        const name = t?.name ?? 'tool'
        const s = sizeOf(b.content)
        const cat: Cat = name === 'Agent' || name === 'Task' ? 'subagents' : name === 'Skill' ? 'skills' : 'toolOutput'
        add(cat, t?.label ?? name, s.chars + 10, cat === 'toolOutput' ? name : undefined)
        images(s.images, `${t?.label ?? name} (image)`)
      }
      return
    }
    const text = textOf(c)
    const s = sizeOf(c)
    const kind = d.origin?.kind
    if (d.isCompactSummary) add('summary', 'Compact summary', s.chars)
    else if (text.startsWith('Base directory for this skill')) add('skills', 'Skill ' + basename(text.split('\n')[0]!.replace(/^Base directory for this skill:\s*/, '')), s.chars)
    else if (text.includes('[Subagent hand-back]') || (text.startsWith('<task-notification>') && text.includes('<result>'))) add('subagents', 'Subagent: ' + clip(text.includes('<result>') ? (text.match(/<summary>([^<]*)/)?.[1] ?? '') : bodyOf(text), 50), s.chars)
    else if (text.startsWith('<task-notification>')) add('system', 'Note: ' + clip(text.match(/<summary>([^<]*)/)?.[1] ?? 'background task', 50), s.chars)
    else if (kind === 'peer' || text.startsWith('Another Claude session sent a message') || /^\[(overvibe|deck) message from/.test(text)) add('peers', 'Message: ' + clip(bodyOf(text), 50), s.chars)
    else if (/^\[(overvibe|deck|Agent Deck)\b/i.test(text)) add('system', 'Overvibe note: ' + clip(text.replace(/^\[[^\]]*\]\s*/, ''), 45), s.chars)
    else if (kind === 'human' || (!d.isMeta && !text.startsWith('<') && !text.startsWith('['))) add('you', 'You: ' + clip(text), s.chars)
    else if (/^<(command-name|command-message|local-command)/.test(text)) add('system', 'Command: ' + clip(text.replace(/<[^>]+>/g, ' '), 40), s.chars)
    else add('system', 'Note: ' + clip(text.replace(/<[^>]+>/g, ' '), 50), s.chars)
    images(s.images, 'Image')
  }

  attachment(a: any, at: number, uuid?: string) {
    if (!a?.type) return
    const add = (cat: Cat, label: string, chars: number, sub?: string) => chars > 0 && this.acc.add({ cat, sub, label, at, est: est(chars), uuid })
    const t = a.type as string
    if (SETUP[t]) {
      const chars = t === 'instructions' ? JSON.stringify(a.files ?? []).length : JSON.stringify(a.content ?? a.addedLines ?? a.addedBlocks ?? a.addedNames ?? a.text ?? a.context ?? a.snapshot ?? a.date ?? '').length
      return add('overhead', SETUP[t]!, chars, SETUP[t])
    }
    if (t === 'queued_command') {
      const text = textOf(a.prompt)
      const kind = a.origin?.kind
      if (kind === 'task-notification' || text.startsWith('<task-notification>'))
        return text.includes('<result>') ? add('subagents', 'Subagent: ' + clip(text.match(/<summary>([^<]*)/)?.[1] ?? '', 50), text.length) : add('system', 'Note: ' + clip(text.match(/<summary>([^<]*)/)?.[1] ?? 'background task', 50), text.length)
      if (text.includes('[Subagent hand-back]')) return add('subagents', 'Subagent: ' + clip(bodyOf(text), 50), text.length)
      if (kind === 'peer') return add('peers', 'Message: ' + clip(bodyOf(text), 50), text.length)
      return add('you', 'You: ' + clip(text), text.length)
    }
    if (t === 'hook_additional_context' || t === 'hook_success' || t === 'hook_blocking_error' || t === 'hook_non_blocking_error') {
      // only what reaches the model: SessionStart/UserPromptSubmit stdout and additional context
      if (t === 'hook_success' && !/^(SessionStart|UserPromptSubmit)/.test(a.hookName ?? a.hookEvent ?? '')) return
      const text = Array.isArray(a.content) ? a.content.join('\n') : String(a.content ?? a.stdout ?? a.stderr ?? '')
      return add('hooks', `Hook ${a.hookName ?? a.hookEvent ?? ''}`.trim(), text.length, a.hookEvent)
    }
    if (t === 'file' || t === 'edited_text_file' || t === 'directory' || t === 'compact_file_reference' || t === 'pdf_reference' || t === 'selected_lines_in_ide') {
      const chars = JSON.stringify(a.content ?? a.snippet ?? '').length + (a.filename ?? a.path ?? '').length
      return add('files', `File ${toolLabel('', { file_path: a.filename ?? a.path }, this.cwd).trim()}`, chars)
    }
    if (t === 'thinking_drop' || t === 'deferred_tools_record' || t === 'command_permissions' || t === 'prompt_snapshot') return
    const text = typeof a.content === 'string' ? a.content : typeof a.text === 'string' ? a.text : typeof a.prompt === 'string' ? a.prompt : a.content ? JSON.stringify(a.content) : ''
    return add('system', `Note: ${t.replace(/_/g, ' ')}`, text.length)
  }

  report(window: number | null, note: string | null) {
    return this.acc.report('claude', window, note, this.model)
  }
}

// ------------------------------------------------------------------------------------------------- Codex

export class CodexReader {
  acc = new Acc()
  calls = new Map<string, string>()
  /** outputs of the request still going, and inputs written after them (a tool's output comes before the count) */
  cur: Item[] = []
  curReason: Item[] = []
  after: Item[] = []
  lastTotal = -1
  window: number | null = null
  model: string | null = null
  cwd: string | null = null

  line(line: string) {
    if (line.length < 20) return
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      return
    }
    this.entry(d)
  }

  entry(d: any) {
    const at = Date.parse(d?.timestamp ?? '') || this.acc.lastAt || 0
    if (at) this.acc.lastAt = at
    const p = d?.payload
    if (!p) return
    if (d.type === 'session_meta') {
      this.cwd = p.cwd ?? null
      return
    }
    if (d.type === 'turn_context') {
      if (p.model) this.model = p.model
      return
    }
    if (d.type === 'compacted') {
      this.acc.compact(at)
      this.cur = []
      this.curReason = []
      this.after = []
      for (const it of Array.isArray(p.replacement_history) ? p.replacement_history : []) this.item(it, at, true)
      return
    }
    if (d.type === 'event_msg') {
      if (p.type === 'task_started' && p.model_context_window) this.window = p.model_context_window
      if (p.type === 'token_count' && p.info) {
        if (p.info.model_context_window) this.window = p.info.model_context_window
        const tot = p.info.total_token_usage?.total_tokens ?? -1
        const last = p.info.last_token_usage
        if (!last || tot === this.lastTotal) return
        this.lastTotal = tot
        this.acc.request(last.input_tokens ?? 0)
        // this request's outputs: the exact output count, shared over what it wrote (reasoning gets its own count)
        const reason = last.reasoning_output_tokens ?? 0
        for (const r of this.curReason) r.est = reason / Math.max(1, this.curReason.length)
        const vis = this.cur.filter((i) => i.cat !== 'thinking')
        const visEst = vis.reduce((a, i) => a + i.est, 0)
        const visOut = Math.max(0, (last.output_tokens ?? 0) - (this.curReason.length ? reason : 0))
        if (visEst > 0 && visOut > 0) for (const i of vis) i.est = (i.est * visOut) / visEst
        this.acc.pend.push(...this.cur, ...this.after)
        this.cur = []
        this.after = []
        this.curReason = []
      }
      return
    }
    if (d.type === 'response_item') this.item(p, at, false)
  }

  item(p: any, at: number, history: boolean) {
    const acc = this.acc
    // an input written after this request's first output belongs to the next request
    const late = () => !history && this.cur.length > 0
    const add = (cat: Cat, label: string, chars: number, sub?: string, out = false) => {
      if (chars <= 0) return
      const held = !history && (out || late())
      const it = acc.add({ cat, sub, label, at, est: est(chars) }, held)
      if (held) (out ? this.cur : this.after).push(it)
      return it
    }
    const image = (n: number, label: string) => {
      if (!n) return
      const held = late()
      const it = acc.add({ cat: 'images', label, at, est: n * IMAGE_TOKENS }, held)
      if (held) this.after.push(it)
    }
    const t = p?.type
    if (t === 'message') {
      const text = textOf(p.content)
      const s = sizeOf(p.content)
      if (p.role === 'assistant') add('replies', 'Reply: ' + clip(text), s.chars, undefined, true)
      else if (p.role === 'developer' || p.role === 'system') add('overhead', /<skills_instructions>/.test(text) ? 'Skills list' : 'Developer instructions', s.chars, /<skills_instructions>/.test(text) ? 'Skills list' : 'Developer instructions')
      else if (text.startsWith('# AGENTS.md instructions') || text.includes('<INSTRUCTIONS>')) add('overhead', 'AGENTS.md', s.chars, 'AGENTS.md')
      else if (text.startsWith('<environment_context>') || text.startsWith('<user_instructions>')) add('overhead', 'Session setup', s.chars, 'Session setup')
      else if (/^\[(overvibe|deck) message from/.test(text.trim())) add('peers', 'Message: ' + clip(text, 50), s.chars)
      else if (/^\[(overvibe|deck)\b/i.test(text.trim())) add('system', 'Overvibe note: ' + clip(text.trim().replace(/^\[[^\]]*\]\s*/, ''), 45), s.chars)
      else if (text.trim().startsWith('<')) add('system', 'Note: ' + clip(text.replace(/<[^>]+>/g, ' '), 50), s.chars)
      else add('you', 'You: ' + clip(text), s.chars)
      image(s.images, p.role === 'user' ? 'Image you sent' : 'Image')
      return
    }
    if (t === 'reasoning') {
      const it = acc.add({ cat: 'thinking', label: 'Reasoning', at, est: history ? est((p.encrypted_content ?? '').length * 0.5) : 0 }, !history)
      if (!history) {
        this.curReason.push(it)
        this.cur.push(it)
      }
      return
    }
    if (t === 'function_call' || t === 'custom_tool_call' || t === 'local_shell_call' || t === 'web_search_call' || t === 'tool_search_call') {
      const raw = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.action ?? p.arguments ?? p.input ?? {})
      const inner = raw.match(/tools\.(\w+)\(/)?.[1]
      const name = inner ?? p.name ?? t.replace(/_call$/, '')
      let input: any = {}
      try {
        input = JSON.parse(raw)
      } catch {}
      const cmd = raw.match(/cmd:\s*"((?:[^"\\]|\\.)*)"/)?.[1]
      const label = toolLabel(name, cmd ? { cmd } : inner ? { cmd: raw.replace(/^\s*(const|let)\s+\w+\s*=\s*/, '') } : input, this.cwd)
      if (p.call_id) this.calls.set(p.call_id, label)
      add('toolCalls', 'Call ' + label, raw.length + 20, name, true)
      return
    }
    if (t === 'function_call_output' || t === 'custom_tool_call_output' || t === 'local_shell_call_output' || t === 'tool_search_output') {
      const out = p.output
      const s = typeof out === 'string' ? { chars: out.length, images: 0 } : sizeOf(Array.isArray(out) ? out : out?.content ?? JSON.stringify(out ?? ''))
      const label = this.calls.get(p.call_id) ?? 'tool'
      add('toolOutput', label, s.chars + 10, label.split(' ')[0])
      image(s.images, `${label} (image)`)
      return
    }
    if (t === 'additional_tools') add('overhead', 'Tool definitions', JSON.stringify(p.tools ?? '').length, 'Tool definitions')
  }

  report() {
    return this.acc.report('codex', this.window, this.window ? 'Codex context window' : null, this.model)
  }
}

// ------------------------------------------------------------------------------------- files and caching

type Cached = { off: number; size: number; mtime: number; reader: ClaudeReader | CodexReader }
/** the readers of the last few transcripts asked about (each holds its items since the last compact) [T1112-112] */
const cache = new Map<string, Cached>()
const KEEP = 24
const SKIP_BYTES = SKIP_PREFIX.map((p) => Buffer.from(p))
/** a Claude line the reader would skip, told from its first bytes so it is never decoded */
const skipped = (b: Buffer) => SKIP_BYTES.some((p) => b.length >= p.length && b.subarray(0, p.length).equals(p))

/** reads only what was added since the last read (a file that shrank is read again from the start) */
export function readInto(file: string, make: () => ClaudeReader | CodexReader) {
  const st = statSync(file)
  let c = cache.get(file)
  if (!c || st.size < c.off) c = { off: 0, size: 0, mtime: 0, reader: make() }
  // newest use last; the oldest goes once there are more than KEEP
  cache.delete(file)
  cache.set(file, c)
  if (cache.size > KEEP) cache.delete(cache.keys().next().value!)
  if (st.size === c.size && st.mtimeMs === c.mtime) return c.reader
  const fd = openSync(file, 'r')
  try {
    const r = c.reader
    const claude = r instanceof ClaudeReader
    // whole lines only: a partial last line is read again next time (src/lines.ts)
    c.off = eachLine(fd, c.off, st.size, (ln) => {
      if (claude && skipped(ln)) return
      r.line(ln.toString())
    })
    c.size = st.size
    c.mtime = st.mtimeMs
  } finally {
    closeSync(fd)
  }
  return c.reader
}

/** a Claude conversation's transcript: the deck's index first, else ~/.claude/projects and each account's own */
export function claudeFile(id: string, known?: string | null): string | null {
  if (known && existsSync(known)) return known
  if (!/^[0-9a-f-]{8,}$/i.test(id)) return null
  const roots = [join(HOME, '.claude', 'projects')]
  try {
    for (const a of readdirSync(ACCOUNTS_DIR)) roots.push(join(ACCOUNTS_DIR, a, 'projects'))
  } catch {}
  for (const r of roots) {
    let dirs: string[] = []
    try {
      dirs = readdirSync(r)
    } catch {
      continue
    }
    for (const d of dirs) {
      const f = join(r, d, id + '.jsonl')
      if (existsSync(f)) return f
    }
  }
  return null
}

/** the window Claude Code compacts at: CLAUDE_CODE_AUTO_COMPACT_WINDOW (env, or the env block of settings.json) */
export function claudeWindow(model: string | null, configDir?: string): { window: number | null; note: string | null } {
  let v = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  if (!(v > 0)) {
    for (const dir of [configDir, join(HOME, '.claude')]) {
      if (!dir) continue
      try {
        const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
        v = Number(s?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
        if (v > 0) break
      } catch {}
    }
  }
  if (v > 0) return { window: v, note: 'auto-compact window' }
  if (model && /\[1m\]/i.test(model)) return { window: 1_000_000, note: '1M context model' }
  if (model && /claude-(opus|sonnet|haiku)-4|claude-3/.test(model)) return { window: 200_000, note: '200k context model' }
  return { window: null, note: null }
}

export function claudeContext(file: string, configDir?: string): ContextReport {
  const r = readInto(file, () => new ClaudeReader()) as ClaudeReader
  const w = claudeWindow(r.model, configDir)
  return r.report(w.window, w.note)
}

export function codexContext(file: string): ContextReport {
  return (readInto(file, () => new CodexReader()) as CodexReader).report()
}

/** for tests: forget what was read */
export const clearContextCache = () => cache.clear()
