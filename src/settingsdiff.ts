// The hover card on the sidebar's Accounts & settings [T1112-126]: where new sessions go, auto mode, and every
// setting that is not at its default. Pure, so the page and the tests share it.

type S = {
  defaultAccount: string
  projects: Record<string, string>
  permissionMode: string
  modeProjects: Record<string, string>
  codex?: { defaultAccount: string; projects: Record<string, string> }
  hiddenAccounts: string[]
  pausedAccounts?: string[]
  remoteOff?: string[]
  chromeAccount: string | null
  chromeProjects: Record<string, boolean>
  projectNames: Record<string, string>
  tasksView?: boolean
  sidebarAccounts?: boolean
  sidebarOrder?: 'project' | 'newest'
  spawnLimits?: { maxDepth: number; maxChildren: number }
}
const SPAWN = { maxDepth: 3, maxChildren: 8 }

const n = (k: number, one: string, many = one + 's') => `${k} ${k === 1 ? one : many}`
const acct = (a: string | undefined) => (!a || a === 'auto' ? 'auto (folder rule, else default)' : a)

/** [label, value] rows: the two always shown first, then only what differs from a fresh install. */
export function settingsSummary(s: S, router: boolean): { rows: [string, string][]; changed: number } {
  const rows: [string, string][] = [
    ['New Claude sessions', acct(s.defaultAccount)],
    ['New Codex sessions', acct(s.codex?.defaultAccount)],
    ['Auto mode for new sessions', s.permissionMode === 'auto' ? 'on' : 'off'],
  ]
  const fixed = rows.length
  const count = (o: Record<string, unknown> | undefined) => Object.keys(o ?? {}).length
  if (router) rows.push(['Local router file', 'picks accounts'])
  const folders = count(s.projects) + count(s.codex?.projects)
  if (folders) rows.push(['Folder account rules', n(folders, 'folder')])
  if (count(s.modeProjects)) rows.push(['Folder auto mode rules', n(count(s.modeProjects), 'folder')])
  if (s.pausedAccounts?.length) rows.push(['Paused accounts', s.pausedAccounts.join(', ')])
  if (s.hiddenAccounts.length) rows.push(['Hidden accounts', String(s.hiddenAccounts.length)])
  if (s.chromeAccount) rows.push(['Chrome account', s.chromeAccount])
  if (count(s.chromeProjects)) rows.push(['Folders that need Chrome', String(count(s.chromeProjects))])
  if (s.remoteOff?.length) rows.push(['Remote Control off', n(s.remoteOff.length, 'account')])
  const sp = { ...SPAWN, ...s.spawnLimits }
  if (sp.maxDepth !== SPAWN.maxDepth) rows.push(['Session depth limit', `${sp.maxDepth} (default ${SPAWN.maxDepth})`])
  if (sp.maxChildren !== SPAWN.maxChildren) rows.push(['Sessions each may start', `${sp.maxChildren} (default ${SPAWN.maxChildren})`])
  if (count(s.projectNames)) rows.push(['Renamed projects', String(count(s.projectNames))])
  if (s.tasksView === false) rows.push(['Tasks view', 'off'])
  if (s.sidebarAccounts === false) rows.push(['Usage bars in the sidebar', 'off'])
  if (s.sidebarOrder === 'newest') rows.push(['Sidebar order', 'newest at the top'])
  return { rows, changed: rows.length - fixed }
}

const WINDOW: Record<string, string> = { five_hour: '5-hour', seven_day: 'Week', seven_day_opus: 'Week, Opus', seven_day_sonnet: 'Week, Sonnet' }

/** "in 2h 10m", "in 3d" */
export function resetsIn(at: number, now: number) {
  const m = Math.max(0, Math.round((at - now) / 60_000))
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `in ${h}h ${m % 60}m` : `in ${h}h`
  return `in ${Math.round(h / 24)}d`
}

/** An account row's card: each limit with its reset, and the plan. */
export function accountRows(a: { plan?: string; windows?: Record<string, { used: number; resetsAt: number | null }>; paused?: boolean }, now: number): [string, string][] {
  const rows: [string, string][] = Object.entries(a.windows ?? {}).map(([k, w]) => [
    WINDOW[k] ?? k.replace(/_/g, ' '),
    `${Math.round(w.used)}%${w.resetsAt ? `, resets ${resetsIn(w.resetsAt, now)}` : ''}`,
  ])
  if (a.plan) rows.push(['Plan', a.plan])
  if (a.paused) rows.push(['Paused', 'nothing new runs on it'])
  return rows
}
