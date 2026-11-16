// Suspend idle sessions [T1116-3]: an agent session that has sat idle a while is stopped to free its memory
// (each Claude Code is 300-800 MB), its last screen kept so its row still shows where it was. Revive resumes
// the same conversation in the same row. Pure parts here; the actions are in sessions.ts.

/** Settings > Running sessions: minutes idle before a session is suspended; 0 = never. */
export const SUSPEND_DEFAULT_MIN = 30
export const SUSPEND_CHOICES = [0, 15, 30, 60, 120, 240] as const

export type SuspendRow = {
  where: string
  kind: string
  tool?: string
  status: string
  tmux: string | null
  sessionId: string | null
  last: number
  bg?: boolean
  prompt?: unknown
  apiError?: string
  hand?: boolean
  queue?: unknown[]
}

/** Claude Code runs each Bash command (foreground, run_in_background, Monitor) as a child shell that sources its snapshot. */
export const isToolShell = (args: string) => /\/shell-snapshots\/snapshot-/.test(args)

/**
 * A timer inside the CLI that dies with it [T1116-3]: a /loop wakeup still to fire (ScheduleWakeup, not stop),
 * or a cron job made with CronCreate and not deleted. `lines`: the transcript's JSONL lines, oldest first.
 */
export function pendingTimer(lines: string[], now: number): string | null {
  let wake: { at: number; delay: number; stop: boolean } | null = null
  let crons = 0
  for (const l of lines) {
    if (!l.includes('"ScheduleWakeup"') && !l.includes('"CronCreate"') && !l.includes('"CronDelete"')) continue
    let d: any
    try {
      d = JSON.parse(l)
    } catch {
      continue
    }
    const content = d?.message?.content
    if (d?.type !== 'assistant' || !Array.isArray(content)) continue
    const at = Date.parse(d.timestamp ?? '') || 0
    for (const c of content) {
      if (c?.type !== 'tool_use') continue
      if (c.name === 'ScheduleWakeup') wake = { at, delay: Number(c.input?.delaySeconds) || 0, stop: c.input?.stop === true }
      else if (c.name === 'CronCreate') crons++
      else if (c.name === 'CronDelete') crons = Math.max(0, crons - 1)
    }
  }
  if (crons) return `${crons} scheduled job${crons > 1 ? 's' : ''} (CronCreate) still set`
  // a wakeup that already fired without a new one means the loop ended; 10 min of slack for a late fire
  if (wake && !wake.stop && now < wake.at + wake.delay * 1000 + 10 * 60_000) return 'a /loop wakeup is scheduled'
  return null
}

/**
 * Why `r` must stay running, or null when it may be suspended now. Only an agent that has finished its
 * turn and waits on nobody: busy, a choice or question on screen, background work (a shell or subagent),
 * queued messages, someone typing in it, a hand-started CLI (the owner chose its flags) and a shell all stay.
 */
export function keepRunning(r: SuspendRow, o: { now: number; afterMs: number; typedAt?: number; queued: number; /** its tool shells running now (background jobs, Monitors) */ jobs?: number; /** pendingTimer's answer */ timer?: string | null }): string | null {
  if (r.where !== 'deck' || !r.tmux) return 'not running in Overvibe'
  if (r.kind !== 'claude' || r.hand) return 'not an agent Overvibe started'
  const tool = r.tool ?? 'claude'
  if (tool !== 'claude' && tool !== 'codex') return `${tool} sessions are not suspended`
  if (!r.sessionId) return 'no conversation yet'
  if (r.status !== 'idle') return `it is ${r.status}`
  if (r.bg) return 'background work is running'
  if (o.jobs) return `${o.jobs} background job${o.jobs > 1 ? 's' : ''} or Monitor${o.jobs > 1 ? 's' : ''} still running`
  if (o.timer) return o.timer
  if (r.prompt) return 'a choice is on its screen'
  if (r.apiError) return 'it stopped on an API error'
  if (o.queued || r.queue?.length) return 'messages are waiting for it'
  const quiet = o.now - Math.max(r.last, o.typedAt ?? 0)
  if (quiet < o.afterMs) return `idle ${Math.round(quiet / 60000)} min`
  return null
}

/** The suspend setting as minutes: an allowed choice, else the default. */
export const suspendMinutes = (v: unknown): number => (SUSPEND_CHOICES as readonly number[]).includes(Number(v)) && v !== null && v !== '' ? Number(v) : SUSPEND_DEFAULT_MIN
