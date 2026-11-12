// What the Tasks view shows and who a task's follow-up goes to [T1112-14]. Pure, so the page and the tests share it.
export type TaskLine = { done: boolean; id: string | null; date: string | null; text: string; sessions: string[]; section: 'waiting' | 'todo' | 'done'; day: string | null }

/**
 * Shown and counted: every line, with or without an id; after "Start fresh" only lines dated on or after that day
 * (an undated line is older than any fresh start). Until 2026-11-12 lines without an id were hidden and left out of
 * the count too, which with a fresh start the same day made the footer read 35 of 2,000+ open lines [T1112-117].
 */
export const isRecent = (x: TaskLine, since: string) => !since || (!!x.date && x.date >= since)
export const isOpen = (x: TaskLine) => !x.done && x.section !== 'done'

/**
 * The sidebar Tasks button's count: every open line the view lists (To do and Waiting on the owner), how many of
 * them wait on the owner, and in how many projects. A worktree's copy of a listed TASKS.md (`copyOf`) is skipped:
 * its lines are the main repo's.
 */
export function openCounts(files: { tasks: TaskLine[]; copyOf?: string }[], since: string) {
  let open = 0
  let waiting = 0
  let projects = 0
  for (const f of files) {
    if (f.copyOf) continue
    let n = 0
    for (const x of f.tasks)
      if (isOpen(x) && isRecent(x, since)) {
        n++
        if (x.section === 'waiting') waiting++
      }
    open += n
    if (n) projects++
  }
  return { open, waiting, projects }
}

/**
 * The hover tooltips on the sidebar's Tasks counters [T1112-126]: the projects behind the open and waiting numbers
 * (most first), lines added and done today, and how many open lines a fresh start hides. Same files and rules as
 * openCounts. `today` is the local day, YYYY-MM-DD.
 */
export function countsDetail(files: { root: string; tasks: TaskLine[]; copyOf?: string }[], since: string, today: string) {
  const projects: { name: string; open: number; waiting: number }[] = []
  let addedToday = 0
  let doneToday = 0
  let hidden = 0
  for (const f of files) {
    if (f.copyOf) continue
    let open = 0
    let waiting = 0
    for (const x of f.tasks) {
      if (x.date === today) addedToday++
      if (x.done && x.day === today) doneToday++
      if (!isOpen(x)) continue
      if (!isRecent(x, since)) {
        hidden++
        continue
      }
      open++
      if (x.section === 'waiting') waiting++
    }
    if (open) projects.push({ name: f.root.split('/').filter(Boolean).pop() ?? f.root, open, waiting })
  }
  projects.sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
  const byWaiting = projects.filter((p) => p.waiting).sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name))
  return { projects, byWaiting, addedToday, doneToday, hidden }
}

/** The Tasks button's tooltip: the numbers in words, and the fresh start when one hides older lines. */
export function countsTip(c: { open: number; waiting: number; projects: number }, since: string) {
  const n = (k: number, one: string, many = one + 's') => `${k.toLocaleString('en-US')} ${k === 1 ? one : many}`
  const base = c.open ? `${c.open.toLocaleString('en-US')} open in ${n(c.projects, 'project')}${c.waiting ? `, ${c.waiting.toLocaleString('en-US')} waiting on you` : ''}` : 'Nothing open'
  return since ? `${base}. Start fresh is on: only lines dated ${since} or later count.` : base
}

/** The follow-up's context line, shown above the message box (not editable): which task, quoted (trimmed). */
export function followupContext(x: Pick<TaskLine, 'id' | 'text'>, max = 300) {
  const t = x.text.replace(/\s+/g, ' ').trim()
  const q = t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + '...' : t
  return `About ${x.id ?? 'this task'} in TASKS.md ("${q}"):`
}

/**
 * What a follow-up sends: the context line, then the owner's answer on the next line, newlines kept.
 * Null while the answer is blank, so the dialog cannot send the context alone (2026-11-12: a session got
 * only the pre-filled quote and answered "Your message stops after the quote") [T1112-92].
 */
export function followupMessage(x: Pick<TaskLine, 'id' | 'text'>, answer: string) {
  const a = answer.replace(/^\s*\n|\s+$/g, '')
  return a.trim() ? `${followupContext(x)}\n${a}` : null
}

type Row = { key: string; where: string; status: string; sessionId: string | null; tmux: string | null; kind: string; title: string; tool?: string; noTranscript?: boolean }
export type Target = { kind: 'send'; key: string; title: string } | { kind: 'resume'; key: string; sessionId: string; title: string; tool: string } | { kind: 'new'; tool: 'claude' | 'codex' }

/**
 * Where a follow-up can go, the default first: the session that added the line when it runs in Overvibe
 * (typed into it), else that session resumed when its conversation is still there, then a new Claude or
 * Codex session in the project. A session running outside Overvibe (a Terminal tab) can be neither typed
 * into nor resumed, so it is left out.
 */
export function followupTargets(adders: string[], rows: Row[]): Target[] {
  const out: Target[] = []
  for (const id8 of adders) {
    const mine = rows.filter((s) => s.sessionId?.startsWith(id8) && s.kind === 'claude')
    const live = mine.find((s) => s.where === 'deck' && s.tmux && s.status !== 'ended')
    if (live) {
      out.push({ kind: 'send', key: live.key, title: live.title })
      continue
    }
    if (mine.some((s) => s.where === 'terminal' || s.where === 'background')) continue
    const past = mine.find((s) => (s.where === 'past' || (s.where === 'deck' && !s.tmux)) && !s.noTranscript)
    if (past) out.push({ kind: 'resume', key: past.key, sessionId: past.sessionId!, title: past.title, tool: past.tool ?? 'claude' })
  }
  out.push({ kind: 'new', tool: 'claude' }, { kind: 'new', tool: 'codex' })
  return out
}

/** The TASKS.md a folder belongs to: the file whose folder is the longest one at or above it (as the server picks, nearest first). */
export function fileForCwd<F extends { root: string }>(files: F[], cwd: string): F | null {
  let best: F | null = null
  for (const f of files) if ((cwd === f.root || cwd.startsWith(f.root + '/')) && (!best || f.root.length > best.root.length)) best = f
  return best
}

export type TipLine = { id: string | null; text: string; waiting: boolean }
export type SessionTip = { lines: TipLine[]; more: number; open: number; waiting: number }

/** a task's text cut at a word to about `max` characters */
export const shortText = (t: string, max = 70) => {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max).replace(/\s+\S*$/, '') + '...' : s
}

/**
 * The sidebar's task tooltip for one session [T1112-116]: its open lines (tagged "· session <first 8 of one of
 * its ids>"), waiting-on-the-owner ones first, up to `max`, then how many more; and the project's open and
 * waiting totals (the Tasks button's count rule). Null when the project has no TASKS.md.
 */
export function sessionTip(files: { root: string; tasks: TaskLine[] }[], cwd: string, ids: (string | null | undefined)[], since: string, max = 6): SessionTip | null {
  const f = fileForCwd(files, cwd)
  if (!f) return null
  const tags = new Set(ids.filter((x): x is string => !!x && x.length >= 8).map((x) => x.slice(0, 8)))
  const shown = f.tasks.filter((x) => isOpen(x) && isRecent(x, since))
  const mine = shown.filter((x) => x.sessions.some((t) => tags.has(t)))
  mine.sort((a, b) => Number(b.section === 'waiting') - Number(a.section === 'waiting'))
  return {
    lines: mine.slice(0, max).map((x) => ({ id: x.id, text: shortText(x.text), waiting: x.section === 'waiting' })),
    more: Math.max(0, mine.length - max),
    open: shown.length,
    waiting: shown.filter((x) => x.section === 'waiting').length,
  }
}

/** "Follow up with all" [T1112-118]: one group per session the open lines are tagged with. */
export type FollowGroup =
  | { kind: 'send'; key: string; title: string; status: string; lines: TaskLine[] }
  | { kind: 'resume'; key: string; sessionId: string; tool: string; title: string; lines: TaskLine[] }
  | { kind: 'unknown'; key: string; tag: string; lines: TaskLine[] }
  | { kind: 'none'; key: string; lines: TaskLine[] }

export const FOLLOW_ALL_ASK = "Where are these? Finish what you can and tell me what's blocking the rest."

/**
 * Groups the open lines by the session they go to, as the single follow-up picks it (followupTargets): a running
 * session (typed in through the send queue), else a stopped one that can be resumed. A line tagged by several
 * sessions goes to the latest tag that resolves (tags are added in order). A tag that matches no session, or a
 * session running outside Overvibe, is "unknown"; a line without a tag is "none". Running groups first, then
 * stopped, unknown, none; each keeps the lines' file order.
 */
export function followupGroups(lines: TaskLine[], rows: Row[]): FollowGroup[] {
  const groups = new Map<string, FollowGroup>()
  for (const x of lines) {
    if (!isOpen(x)) continue
    let g: FollowGroup | undefined
    for (const tag of [...x.sessions].reverse()) {
      const t = followupTargets([tag], rows)[0]!
      if (t.kind === 'new') continue
      g = groups.get(t.key) ?? (t.kind === 'send' ? { kind: 'send', key: t.key, title: t.title, status: rows.find((r) => r.key === t.key)?.status ?? '', lines: [] } : { kind: 'resume', key: t.key, sessionId: t.sessionId, tool: t.tool, title: t.title, lines: [] })
      break
    }
    if (!g && x.sessions.length) {
      const tag = x.sessions[x.sessions.length - 1]!
      g = groups.get('?' + tag) ?? { kind: 'unknown', key: '?' + tag, tag, lines: [] }
    }
    if (!g) g = groups.get('-') ?? { kind: 'none', key: '-', lines: [] }
    g.lines.push(x)
    groups.set(g.key, g)
  }
  const rank = { send: 0, resume: 1, unknown: 2, none: 3 }
  return [...groups.values()].sort((a, b) => rank[a.kind] - rank[b.kind])
}

/**
 * One session's message: its lines quoted (each cut like the single follow-up's), then the owner's ask. Lines that
 * would push it past `max` (the most /api/say types in) are left out and counted, so the message is never refused.
 * Null while the ask is blank.
 */
export function followupAllMessage(lines: Pick<TaskLine, 'id' | 'text'>[], ask: string, max = 8000) {
  const a = ask.replace(/^\s*\n|\s+$/g, '')
  if (!a.trim()) return null
  const head = lines.length === 1 ? 'About this open line in TASKS.md:' : `About these ${lines.length} open lines in TASKS.md:`
  const quote = (x: Pick<TaskLine, 'id' | 'text'>) => `- ${x.id ?? '(no id)'}: "${shortText(x.text, 200)}"`
  const out = [head]
  let len = head.length + a.length + 40
  let left = 0
  for (const x of lines) {
    const q = quote(x)
    if (len + q.length + 1 > max) left++
    else (out.push(q), (len += q.length + 1))
  }
  if (left) out.push(`- and ${left} more in TASKS.md`)
  return `${out.join('\n')}\n${a}`
}
