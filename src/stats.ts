// The Stats view [T1110-84] [T1110-89]: what the agents did in the last 24 hours and the last 7 days, from
// data the deck already keeps on this Mac (session rows, Claude Code's transcript index, Codex's rollouts,
// the message edges). Nothing is sent anywhere. Working time is the CLIs' own turn durations (Claude
// Code's turn_duration, Codex's task_complete), kept per hour; agy records none, so its time is unknown.
//
// Two rolling windows: "24h" is the last 24 hours in hourly buckets (the current hour and the 23 before),
// "7d" the last 7 days in daily buckets (today and the 6 days before). A session is active in a window
// when it finished a turn in it, wrote to its transcript in it, or is working now; started counts when
// it was first seen.
import { codexInfo } from './codex'
import { getRecord, type ViewSession } from './sessions'
import { dayKey, edges, hourKey, meta } from './transcripts'

type Tool = 'claude' | 'codex' | 'agy'
const TOOLS: Tool[] = ['claude', 'codex', 'agy']
export type RangeId = '24h' | '7d'
const RANGES: RangeId[] = ['24h', '7d']

export type Range = {
  /** bucket keys, oldest first: YYYY-MM-DDTHH (24h) or YYYY-MM-DD (7d) */
  buckets: string[]
  /** the window's start (ms) */
  since: number
  tools: Record<Tool, { active: number; started: number; workMs: number | null; series: number[] | null }>
  messages: { count: number; series: number[]; pairs: { from: string; to: string; n: number }[] }
  projects: { name: string; workMs: number; active: number; started: number }[]
}
export type Stats = {
  ranges: Record<RangeId, Range>
  waiting: { key: string; title: string; tool: Tool; project: string; since: number; reason: string | null }[]
  at: number
}

const HOUR = 3600_000
export function windows(now: number): Record<RangeId, { buckets: string[]; since: number; keyOf: (hour: string) => string }> {
  const d = new Date(now)
  const hourStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime()
  const hours: string[] = []
  for (let i = 23; i >= 0; i--) hours.push(hourKey(hourStart - i * HOUR))
  // by calendar date, not 24 h steps, so a daylight-saving change never skips or repeats a day
  const days: string[] = []
  for (let i = 6; i >= 0; i--) days.push(dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, 12).getTime()))
  return {
    '24h': { buckets: hours, since: hourStart - 23 * HOUR, keyOf: (k) => k.slice(0, 13) },
    '7d': { buckets: days, since: new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime(), keyOf: (k) => k.slice(0, 10) },
  }
}

/** `scoped` (OVERVIBE_SCOPE): only messages that touch one of `sessions` count. */
export function stats(sessions: ViewSession[], o: { scoped?: boolean; now?: number } = {}): Stats {
  const now = o.now ?? Date.now()
  const win = windows(now)
  const ranges = {} as Record<RangeId, Range>
  const index = {} as Record<RangeId, Map<string, number>>
  for (const r of RANGES) {
    const w = win[r]
    index[r] = new Map(w.buckets.map((k, i) => [k, i]))
    ranges[r] = {
      buckets: w.buckets,
      since: w.since,
      tools: Object.fromEntries(TOOLS.map((t) => [t, { active: 0, started: 0, workMs: t === 'agy' ? null : 0, series: t === 'agy' ? null : w.buckets.map(() => 0) }])) as Range['tools'],
      messages: { count: 0, series: w.buckets.map(() => 0), pairs: [] },
      projects: [],
    }
  }
  const projects: Record<RangeId, Map<string, Range['projects'][number]>> = { '24h': new Map(), '7d': new Map() }
  const proj = (r: RangeId, name: string) => projects[r].get(name) ?? projects[r].set(name, { name, workMs: 0, active: 0, started: 0 }).get(name)!
  const seen = new Set<string>()
  const waiting: Stats['waiting'] = []

  for (const s of sessions) {
    if (s.kind !== 'claude') continue // shells and login terminals are not agent sessions
    const tool: Tool = (s.tool as Tool) ?? 'claude'
    const id = s.sessionId
    if (id && seen.has(id)) continue
    if (id) seen.add(id)
    const tm = id && tool === 'claude' ? meta(id) : undefined
    const cx = id && tool === 'codex' ? codexInfo(id) : undefined
    const rec = s.where === 'deck' ? getRecord(s.key) : undefined
    // the first we know of it: a resumed session counts on the day it really started
    const starts = [tm?.startedAt, cx?.startedAt, rec?.createdAt].filter((x): x is number => typeof x === 'number' && x > 0)
    const started = starts.length ? Math.min(...starts) : null
    const work = tm?.work ?? cx?.work ?? {}
    // last write to its transcript; agy has none, so its row's last activity stands in
    const wrote = tm?.lastAt ?? cx?.lastAt ?? (tool === 'agy' ? s.last : 0)
    const busy = s.where !== 'past' && s.status === 'busy'
    const name = s.project || 'other'

    for (const r of RANGES) {
      const T = ranges[r].tools[tool]
      let ms = 0
      for (const [k, v] of Object.entries(work)) {
        const i = index[r].get(win[r].keyOf(k))
        if (i === undefined) continue
        ms += v
        if (T.series) T.series[i]! += v
      }
      if (T.workMs !== null) T.workMs += ms
      const isNew = started !== null && started >= win[r].since
      const active = ms > 0 || wrote >= win[r].since || busy || isNew
      if (!active && !isNew) continue
      const P = proj(r, name)
      P.workMs += ms
      if (active) (T.active++, P.active++)
      if (isNew) (T.started++, P.started++)
    }

    if (s.status === 'waiting' && s.where !== 'past') {
      // since the question was asked, else since its last reply (the turn ended on a question), else since its screen last changed
      const since = tm?.pending?.at ?? (s.waitingReason === 'last reply ends with a question' && tm?.lastAt ? tm.lastAt : s.last)
      waiting.push({ key: s.key, title: s.title, tool, project: s.project, since, reason: s.waitingReason ?? s.question ?? null })
    }
  }
  for (const r of RANGES) ranges[r].projects = [...projects[r].values()].sort((a, b) => b.workMs - a.workMs || b.active - a.active).slice(0, 10)

  // messages between sessions: Claude Code's SendMessage (the receiver's copy when there is one, else the
  // sender's) and `overvibe send` (recorded at delivery and read back from the receiving transcript)
  const list = edges(win['7d'].since).edges
  const nodeOf = (id: string | null, name: string) => id ?? `name:${name}`
  const key = (e: (typeof list)[number]) => `${nodeOf(e.fromSession, e.from)}>${nodeOf(e.toSession, e.to)}>${e.summary.slice(0, 40)}`
  const ins = list.filter((e) => e.dir === 'in')
  const inKeys = new Set(ins.map(key))
  const msgs = [...ins, ...list.filter((e) => e.dir === 'out' && e.toSession && !inKeys.has(key(e)))]
  const titles = new Map(sessions.filter((s) => s.sessionId).map((s) => [s.sessionId!, s.title]))
  const ids = new Set(sessions.map((s) => s.sessionId).filter(Boolean))
  const pairs: Record<RangeId, Map<string, { from: string; to: string; n: number }>> = { '24h': new Map(), '7d': new Map() }
  for (const e of msgs) {
    if (o.scoped && !(e.fromSession && ids.has(e.fromSession)) && !(e.toSession && ids.has(e.toSession))) continue
    const from = (e.fromSession && titles.get(e.fromSession)) || e.from
    const to = (e.toSession && titles.get(e.toSession)) || e.to
    for (const r of RANGES) {
      const i = e.at >= win[r].since ? index[r].get(win[r].keyOf(hourKey(e.at))) : undefined
      if (i === undefined) continue
      const M = ranges[r].messages
      M.count++
      M.series[i]!++
      if (from === to) continue
      const k = `${from}\u0000${to}`
      const p = pairs[r].get(k) ?? pairs[r].set(k, { from, to, n: 0 }).get(k)!
      p.n++
    }
  }
  for (const r of RANGES) ranges[r].messages.pairs = [...pairs[r].values()].sort((a, b) => b.n - a.n).slice(0, 8)

  return { ranges, waiting: waiting.sort((a, b) => a.since - b.since), at: now }
}
