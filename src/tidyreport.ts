// GET /api/tidy and `overvibe tidy` [T1111-30]: every running deck session with what Close old sessions
// needs (idle time, open menu, children, queue, pin, last reply) and its verdict from src/tidy.ts.
// Read only: nothing here stops, hides or types anything.
import { capture, listSessions } from './tmux'
import { queueView } from './sendqueue'
import { getSettings } from './routing'
import { meta as tmeta } from './transcripts'
import { codexInfo, codexLastReply } from './codex'
import { lastReplyStateOf } from './summary'
import { isShellCommand } from './handcli'
import type { ViewSession } from './sessions'
import { DEFAULT_HOURS, classify, claudeScreenBusy, claudeScreenQueued, clipReply, type Verdict } from './tidy'

export type TidyRow = {
  key: string
  tmux: string
  title: string
  tool: string
  kind: ViewSession['kind']
  cwd: string
  project: string
  status: ViewSession['status']
  /** when it last did anything (transcript, rollout, else the screen) */
  idleSince: number
  idleMs: number
  pinned: boolean
  children: number
  queued: number
  /** the open choice menu's title, if one is on its screen */
  prompt: string | null
  question: string | null
  /** its last reply, the end of it when long (about 600 characters) */
  reply: string | null
  replyFrom: 'transcript' | 'rollout' | 'screen' | null
  verdict: Verdict
  reason: string
}

/** A screen without the input box, footer and blank lines: what an agent or a shell last printed. */
export function screenTail(screen: string, n = 15): string | null {
  const lines = screen
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !/^[\s─━═│┃╭╮╰╯┌┐└┘├┤▔▁\-_|>❯›]*$/.test(l))
  return lines.slice(-n).join('\n') || null
}

export async function tidyReport(sessions: ViewSession[], hours = DEFAULT_HOURS) {
  const panes = new Map((await listSessions()).map((p) => [p.name, p]))
  const pins = new Set(getSettings().pins ?? [])
  const live = sessions.filter((s) => s.where === 'deck' && s.tmux && s.kind !== 'login')
  const now = Date.now()
  const rows: TidyRow[] = []
  for (const s of live) {
    const tool = s.kind === 'shell' ? 'shell' : s.tool ?? 'claude'
    const pane = panes.get(s.tmux!)
    let reply: string | null = null
    let replyFrom: TidyRow['replyFrom'] = null
    let last = s.last
    let answered = false
    let status = s.status
    if (tool === 'claude' && s.sessionId) {
      const st = lastReplyStateOf(s.sessionId)
      reply = st.reply
      answered = st.answered
      replyFrom = reply ? 'transcript' : null
      last = tmeta(s.sessionId)?.lastAt || last
    }
    // Claude compacting or with the owner's message queued on its input: the screen says so [T1112-115]
    if (tool === 'claude' && s.kind === 'claude' && status !== 'busy') {
      const screen = await capture(s.tmux!, 0)
      if (claudeScreenBusy(screen)) status = 'busy'
      if (claudeScreenQueued(screen)) answered = true
    } else if (tool === 'codex' && s.sessionId) {
      reply = codexLastReply(s.sessionId)
      replyFrom = reply ? 'rollout' : null
      last = codexInfo(s.sessionId)?.lastAt || last
    }
    if (!reply && (tool === 'agy' || tool === 'shell' || !s.sessionId)) {
      reply = screenTail(await capture(s.tmux!, 40), tool === 'shell' ? 12 : 20)
      replyFrom = reply ? 'screen' : null
    }
    const children = sessions.filter((c) => c.parent === s.key && c.tmux && c.status !== 'ended').length
    const queued = queueView(s.tmux)?.length ?? 0
    const pinned = pins.has(s.hand ? s.key : s.sessionId ?? s.key)
    const atPrompt = tool === 'shell' ? !!pane && isShellCommand(pane.cmd) : undefined
    const idleMs = Math.max(0, now - last)
    const v = classify(
      {
        kind: s.kind, tool, status, idleMs, prompt: s.prompt ? s.prompt.title ?? '' : null,
        question: s.prompt ? null : s.question ?? null, reply, answered, children, queued, bg: !!s.bg, apiError: s.apiError ?? null, atPrompt, running: pane && tool === 'shell' && !atPrompt ? pane.cmd : null,
      },
      hours,
    )
    rows.push({
      key: s.key, tmux: s.tmux!, title: s.title, tool, kind: s.kind, cwd: s.cwd, project: s.project, status,
      idleSince: last, idleMs, pinned, children, queued, prompt: s.prompt ? s.prompt.title ?? '' : null, question: s.question ?? null,
      reply: clipReply(reply), replyFrom, verdict: v.verdict, reason: v.reason,
    })
  }
  // longest idle first within each group
  rows.sort((a, b) => b.idleMs - a.idleMs)
  const counts = { done: 0, waiting: 0, unsure: 0 }
  for (const r of rows) counts[r.verdict]++
  return { hours, at: now, counts, sessions: rows }
}
