// Right-click a project header > Close all [T1112-102]: which of the project's rows close and how, what to flag
// in the confirm, and where the selection goes after. Pure functions, so the rules are tested without the page;
// src/web/deck.ts closeProject does the stopping and hiding.

export type Row = {
  key: string
  where: 'deck' | 'terminal' | 'background' | 'past'
  status: 'busy' | 'idle' | 'waiting' | 'ended' | 'blocked'
  title: string
  kind: 'claude' | 'login' | 'shell'
  tmux: string | null
  sessionId: string | null
  tool?: string
  hand?: boolean
  question?: string | null
  waitingReason?: string | null
  prompt?: { title: string } | null
  apiError?: string
  owes?: string
}

/** stop: a running Overvibe session (stop, unpin, hide, like ⌘W); hide: stopped or past, only hidden; skip: not Overvibe's to stop */
export type Action = 'stop' | 'hide' | 'skip'
export type Planned<R extends Row = Row> = { s: R; action: Action; flag: string | null }

/** The tool's name for the dialog's list. */
export const toolLabel = (s: Pick<Row, 'kind' | 'tool'>) =>
  s.kind === 'shell' ? 'Terminal' : s.kind === 'login' ? 'Login' : s.tool === 'codex' ? 'Codex' : s.tool === 'agy' ? 'agy' : 'Claude'

/** Why closing this one may cut something off: it is working, or it waits on the owner. null when it looks safe. */
export function flagOf(s: Row, tidy?: { verdict: string; reason: string }): string | null {
  if (s.status === 'busy') return 'working right now'
  if (s.prompt) return `waiting on you: a choice is open${s.prompt.title ? `: ${s.prompt.title}` : ''}`
  if (s.question) return `waiting on you: ${s.question}`
  if (s.apiError) return `stopped on an error: ${s.apiError}`
  // Close old sessions' verdict, when the page has it, gives the reason a reply asks the owner something
  if (tidy?.verdict === 'waiting') return `waiting on you: ${tidy.reason}`
  if (s.status === 'waiting') return `waiting on you${s.waitingReason ? `: ${s.waitingReason}` : ''}`
  if (s.owes) return `waiting on you: ${s.owes}`
  return null
}

/** What Close all does to each row of a project (pinned rows are left out by the caller: they sit in the Pinned box). */
export function planClose<R extends Row>(rows: R[], tidy: Record<string, { verdict: string; reason: string }> = {}): Planned<R>[] {
  return rows.map((s) => {
    const action: Action =
      s.where === 'deck' ? (s.tmux && s.status !== 'ended' ? 'stop' : 'hide') : s.where === 'past' ? (s.sessionId ? 'hide' : 'skip') : 'skip'
    return { s, action, flag: action === 'stop' ? flagOf(s, tidy[s.key]) : null }
  })
}

/**
 * Where the selection goes when a whole group closes: the first running row below the group in the sidebar, else
 * the nearest one above it, like closing one row (neighbourOf). `rows` is the sidebar top to bottom, with the group's
 * header in it as one of `group` (so a folded group still has a place); a key shown twice counts at its first place.
 */
export function nextAfterGroup(rows: string[], group: Set<string>, live: (k: string) => boolean): string | null {
  const keys = rows.filter((k, i) => rows.indexOf(k) === i)
  const at = keys.map((k, i) => (group.has(k) ? i : -1)).filter((i) => i >= 0)
  const ok = (k: string) => !group.has(k) && live(k)
  if (!at.length) return keys.find(ok) ?? null
  return keys.slice(Math.max(...at) + 1).find(ok) ?? keys.slice(0, Math.min(...at)).reverse().find(ok) ?? null
}
