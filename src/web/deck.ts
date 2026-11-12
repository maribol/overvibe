// The page's one store: the server's /api/state, polled every 3 s, plus which session is selected
// and which terminals are open as tabs.
import { swapTabs } from '../tabswap'
import { computed, reactive, ref } from 'vue'
import { isSettingsSection } from './settingsNav'
import { nextAfterGroup, type Planned } from '../closeall'

export type Status = 'busy' | 'idle' | 'waiting' | 'ended' | 'blocked'
export type Session = {
  key: string
  where: 'deck' | 'terminal' | 'background' | 'past'
  status: Status
  title: string
  cwd: string
  /** its project's name, from the server (deck.json, Settings, git repo, folder) */
  project: string
  account: string | null
  sessionId: string | null
  tmux: string | null
  kind: 'claude' | 'login' | 'shell'
  last: number
  waitingReason?: string | null
  /** waiting on a deploy OK [T1112-134] */
  deploy?: boolean
  bg?: boolean
  apiError?: string
  /** Close old sessions calls it done (idle a while, nothing asked, nothing running): why [T1112-4] */
  tidy?: string
  /** waiting on the owner with no question on screen: why (a decision left to them...) [T1112-10] */
  owes?: string
  noTranscript?: boolean
  prompt?: { title: string; context: string[]; options: string[]; hints?: string[]; cursor: number; sig: string } | null
  pid?: number | null
  question?: string | null
  lastPrompt?: string | null
  tool?: 'claude' | 'codex' | 'agy'
  /** started with `deck new --attach`: the key of its parent's row; the sidebar nests it there [T1110-44] */
  parent?: string | null
  attached?: boolean
  /** a shell's current folder after `cd`, and its project (header only; the sidebar keeps cwd) */
  here?: string
  hereProject?: string
  /** `overvibe send` messages waiting until its input box is free (oldest first) [T1110-60] */
  queue?: QueuedMessage[]
  /** started in ask mode: the tool's own approval prompts instead of auto mode [T1110-85] */
  mode?: 'ask'
  /** tokens so far (Claude Code's message usage, Codex's token counts) [T1111-13] */
  tokens?: { in: number; out: number; cacheRead?: number; cacheWrite?: number }
  /** an agent CLI started by hand in a terminal row: Overvibe chose none of its flags [T1111-19] */
  hand?: boolean
  /** the row's earlier conversation ids, for its task tags [T1112-116] */
  pastIds?: string[]
}
export type PermissionMode = 'auto' | 'ask'
export type QueuedMessage = { id: string; from: string; preview: string; at: number; why: string | null; stale: boolean }
export type AccountTool = 'claude' | 'codex'
export type Account = {
  name: string
  /** Claude Code (CLAUDE_CONFIG_DIR) or Codex (CODEX_HOME); agy has one login */
  tool: AccountTool
  dir: string
  email?: string
  plan?: string
  windows?: Record<string, { used: number; resetsAt: number | null }>
  checkedAt?: number
  error?: string
  /** a login terminal for it is open; the server probes it the moment the login lands [T1110-84] */
  loggingIn?: boolean
  /** paused in Settings: nothing new runs on it [T1112-11] */
  paused?: boolean
}

/** Whether each CLI is installed (and its version); agy has no accounts. */
export type ToolStatus = { tool: 'claude' | 'codex' | 'agy'; installed: boolean; version?: string; accounts: boolean; note?: string; update?: { latest: string; cmd: string; how: string } }
/** A newer Overvibe (src/updates.ts SelfUpdate): installed mode gets the Update button, a clone the git pull to run */
export type SelfUpdate = { installed: string; latest: string; source: 'release' | 'tag' | 'commit'; mode: 'installed' | 'dev' | 'plain'; cmd: string; why?: string; url: string }
/** "0.160.0" out of "codex-cli 0.160.0" */
export const versionOf = (t: ToolStatus) => t.version?.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? t.version ?? ''

export const deck = reactive({
  sessions: [] as Session[],
  accounts: [] as Account[],
  tools: [] as ToolStatus[],
  loaded: false,
  selected: localStorage.getItem('deck.selected') as string | null,
  tabs: JSON.parse(localStorage.getItem('deck.tabs') || '[]') as string[], // tmux names
  newOpen: false,
  newCwd: '',
  /** the tool New session opens on ('' = the last one used); the palette's "New terminal" sets shell */
  newTool: '' as '' | NewTool,
  addAccountOpen: false,
  /** the setup screen (SetupView.vue) is open; setupAway: put aside for a login terminal, a pill brings it back [T1110-67] */
  setupOpen: false,
  setupAway: false,
  // the Agent map became Stats [T1110-84]: an old saved 'map' opens Stats
  view: ((v) => (v === 'map' ? 'stats' : v))(localStorage.getItem('deck.view') as View | 'map' | null) || 'terminal',
  settings: { defaultAccount: 'auto', projects: {}, permissionMode: 'ask', modeProjects: {}, codex: { defaultAccount: 'auto', projects: {} }, hiddenAccounts: [], pausedAccounts: [], remoteOff: [], chromeAccount: null, chromeProjects: {}, projectOrder: [], projectNames: {}, pins: [] } as { defaultAccount: string; projects: Record<string, string>; permissionMode: PermissionMode; modeProjects: Record<string, PermissionMode>; codex: { defaultAccount: string; projects: Record<string, string> }; hiddenAccounts: string[]; pausedAccounts?: string[]; remoteOff?: string[]; chromeAccount: string | null; chromeProjects: Record<string, boolean>; projectOrder: string[]; projectNames: Record<string, string>; pins: string[]; tasksView?: boolean; sidebarAccounts?: boolean; sidebarOrder?: 'project' | 'newest'; spawnLimits?: { maxDepth: number; maxChildren: number } },
  /** a local router file (~/.config/overvibe/router.ts) is loaded and may choose accounts for new sessions */
  router: false,
  homeAbs: '',
  moveFor: null as Session | null,
  /** Tasks > Follow up with agent is open (its text must survive a new build's reload) [T1112-14] */
  followupOpen: false,
  /** the "Compact <session>?" dialog from a ⌘-clicked /compact suggestion is open [T1112-91] */
  compactOpen: false,
  /** Send feedback is open (what is typed there must survive a new build) [T1112-120] */
  feedbackOpen: false,
  /** the Overvibe update panel is open [T1112-119] */
  selfOpen: false,
  /** a newer Overvibe, from the server's quiet check [T1112-119] */
  self: null as SelfUpdate | null,
  renameFor: null as Session | null,
  menu: null as { x: number; y: number; s: Session } | null, // right-click menu on a session row // the session the rename dialog is for
  pending: [] as Pending[],
  paletteOpen: false,
  toast: null as string | null,
  stopFor: null as Session | null, // the stop confirmation is open for this session
  stopClose: false, // it came from ⌘W / ⌥W: stopping also unpins and hides the row [T1111-27]
  /** right-click menu on a project header, and the Close all confirm for a project [T1112-102] */
  projectMenu: null as { x: number; y: number; name: string } | null,
  closeAllFor: null as string | null,
})
export type Pending = {
  toolUseId: string; tool: string; at: number; sessionId: string; cwd: string | null; title: string | null; plan?: string
  questions?: { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[]
}
export type View = 'terminal' | 'messages' | 'stats' | 'settings' | 'tasks' | 'tidy'

export function setView(v: View) {
  if (v === 'settings' && deck.view !== 'settings') settingsAt.section = '' // opens at the top unless a section is asked for
  deck.view = v
  localStorage.setItem('deck.view', v)
  syncUrl()
}

// The address bar follows what is open: #/s/<session key> for a session, #/<view> for the other
// views. Back and Forward work, and a copied link opens the same place.
const VIEWS: View[] = ['terminal', 'messages', 'stats', 'settings', 'tasks', 'tidy']
/** Settings' section in view (#/settings/<id>), and a counter that asks Settings to show that page [T1112-19, T1112-100] */
export const settingsAt = reactive({ section: '', jump: 0 })
/** Open Settings at one of its sections (src/web/settingsNav.ts ids), or at the top. */
export function openSettings(section?: string) {
  setView('settings')
  settingsAt.section = isSettingsSection(section) ? section : ''
  settingsAt.jump++
}
const hashFor = () =>
  deck.view === 'terminal' ? (deck.selected ? `#/s/${encodeURIComponent(deck.selected)}` : '#/')
  : deck.view === 'settings' && settingsAt.section ? `#/settings/${settingsAt.section}`
  : `#/${deck.view}`
let urlQueued = false
let fromHash = false
function syncUrl() {
  if (urlQueued || fromHash) return
  urlQueued = true
  queueMicrotask(() => {
    urlQueued = false
    const h = hashFor()
    if (location.hash !== h) history.pushState(null, '', h)
  })
}
export const replaceUrl = () => history.replaceState(null, '', hashFor())
/** A history step to where the page is now (Settings' pages [T1112-100]); never while following the address bar. */
export const pushUrl = () => {
  const h = hashFor()
  if (!fromHash && location.hash !== h) history.pushState(null, '', h)
}
/** Open what the address bar names (on load, Back/Forward, or a pasted link). */
export function applyUrl() {
  const m = /^#\/(?:s\/(.+)|([a-z]+)(?:\/([a-z-]+))?)?$/.exec(location.hash)
  if (!m) return syncUrl()
  fromHash = true
  try {
    if (m[1]) select(decodeURIComponent(m[1]))
    else if (m[2] === 'map') setView('stats') // an old #/map link [T1110-84]
    else if (m[2] === 'settings') openSettings(m[3])
    else if (m[2] && VIEWS.includes(m[2] as View)) setView(m[2] as View)
    else setView('terminal')
  } finally {
    fromHash = false
  }
}
window.addEventListener('popstate', applyUrl)

/** Open a session by Claude session id: its deck terminal if it has one, else its card. */
export function openSession(sessionId: string) {
  const s = deck.sessions.find((x) => x.sessionId === sessionId)
  setView('terminal')
  select(s ? s.key : sessionId)
}

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j as T
}

/** The work root the server searches (config.json workRoot, default ~/Work), as ~/..., for places with no session folder. */
export const workRoot = ref('~')
/** the tmux key of the sidebar row being dragged, while it is dragged (a drop target can't read the drag's
 *  data until the drop, and needs it to refuse a session's own terminal) [T1111-17] */
export const draggedSession = ref<string | null>(null)
void api<{ root: string }>('/api/folders?q=').then((r) => r?.root && (workRoot.value = r.root)).catch(() => {})

let loadedBuild = ''
// a project order being saved, or saved after this refresh started, wins over what the server sent
let orderSaving = 0
let orderStamp = 0
export async function refresh() {
  const stamp = orderStamp
  const pStamp = pinStamp
  try {
    const s = await api<{ sessions: Session[]; accounts: Account[]; tools?: ToolStatus[]; settings: typeof deck.settings; router?: boolean; homeAbs: string; pending: Pending[]; focus?: Focus | null; build?: string; self?: SelfUpdate | null }>('/api/state')
    // a new UI build landed: load it, unless a dialog is open (it would lose what is typed there)
    if (s.build) {
      if (!loadedBuild) loadedBuild = s.build
      else if (s.build !== loadedBuild && !deck.newOpen && !deck.paletteOpen && !deck.renameFor && !deck.moveFor && !deck.menu && !deck.addAccountOpen && !deck.stopFor && !deck.setupOpen && !deck.followupOpen && !deck.compactOpen && !deck.feedbackOpen && !deck.projectMenu && !deck.closeAllFor) location.reload()
    }
    // only questions from sessions that are still running
    const running = new Set(s.sessions.filter((x) => x.where !== 'past' && x.status !== 'ended').map((x) => x.sessionId))
    deck.pending = s.pending.filter((p) => running.has(p.sessionId))
    deck.settings = orderSaving || stamp !== orderStamp ? { ...s.settings, projectOrder: deck.settings.projectOrder } : s.settings
    if (pinSaving || pStamp !== pinStamp) deck.settings = { ...deck.settings, pins: pinsShown }
    deck.router = !!s.router
    deck.homeAbs = s.homeAbs
    // a deck session is addressed by its tmux name
    for (const x of s.sessions) if (x.where === 'deck' && x.tmux) x.key = x.tmux
    deck.sessions = s.sessions
    deck.accounts = s.accounts
    deck.tools = s.tools ?? []
    deck.self = s.self ?? null
    deck.loaded = true
    // tabs whose session is gone close themselves; not while an account switch is restarting them [T1112-128]
    const alive = new Set(s.sessions.filter((x) => x.tmux).map((x) => x.tmux))
    const kept = deck.tabs.filter((t) => alive.has(t))
    if (!switching && kept.length !== deck.tabs.length) setTabs(kept)
    applyFocus(s.focus ?? null)
    const waiting = s.sessions.filter((x) => x.status === 'waiting' && x.where !== 'past').length
    const deploys = s.sessions.filter((x) => x.status === 'waiting' && x.deploy && x.where !== 'past').length
    document.title = waiting ? `(${waiting}${deploys ? ` · ${deploys} deploy` : ''}) Overvibe` : 'Overvibe'
  } catch {}
}

// `deck open`: an agent asks the page to show a session. Only requests made after this page loaded
// count, and none while a dialog is open (it is applied on the first refresh after it closes).
type Focus = { key: string; title: string; from: string; at: number }
let focusSeen: number | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined
export const dialogOpen = () => !!(deck.newOpen || deck.paletteOpen || deck.renameFor || deck.moveFor || deck.menu || deck.addAccountOpen || deck.stopFor || deck.setupOpen || deck.followupOpen || deck.compactOpen || deck.feedbackOpen || deck.projectMenu || deck.closeAllFor)
// never switch while the owner is typing: the rest of what they type would land in the other session
let lastKeyAt = 0
window.addEventListener('keydown', () => (lastKeyAt = Date.now()), true)
function applyFocus(f: Focus | null) {
  if (focusSeen === null) return void (focusSeen = f?.at ?? 0)
  if (!f || f.at <= focusSeen || dialogOpen() || Date.now() - lastKeyAt < 2500) return
  focusSeen = f.at
  select(f.key)
  showToast(`${f.from} opened ${f.title}`)
}
export function showToast(text: string) {
  deck.toast = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (deck.toast = null), 4000)
}

function setTabs(t: string[]) {
  deck.tabs = t
  localStorage.setItem('deck.tabs', JSON.stringify(t))
}

/** sessions opened most recently first, for the palette's "Recent" list */
export const recentKeys = (): string[] => JSON.parse(localStorage.getItem('deck.recent') || '[]')
function noteRecent(key: string) {
  const r = [key, ...recentKeys().filter((k) => k !== key)].slice(0, 20)
  localStorage.setItem('deck.recent', JSON.stringify(r))
}
export function select(key: string | null) {
  if (key) noteRecent(key)
  if (key) setView('terminal')
  deck.selected = key
  if (key) localStorage.setItem('deck.selected', key)
  else localStorage.removeItem('deck.selected')
  const s = deck.sessions.find((x) => x.key === key)
  if (s?.tmux && !deck.tabs.includes(s.tmux)) setTabs([...deck.tabs, s.tmux])
  syncUrl()
}

/**
 * Where closing `key` leaves you [T1112-3]: the running session in the row below it in the sidebar, or the
 * one above when it is the last, like closing a tab in Terminal or a browser. Rows are read as shown
 * (a pinned session appears twice; its first copy counts).
 */
function neighbourOf(key: string): string | null {
  const live = (k: string) => deck.sessions.some((x) => x.key === k && x.where !== 'past' && x.status !== 'ended')
  const rows = [...document.querySelectorAll<HTMLElement>('aside [data-key]')].filter((el) => el.getClientRects().length).map((el) => el.dataset.key!)
  const keys = rows.filter((k, i) => rows.indexOf(k) === i)
  const i = keys.indexOf(key)
  if (i < 0) return keys.find(live) ?? null
  return keys.slice(i + 1).find((k) => k !== key && live(k)) ?? keys.slice(0, i).reverse().find((k) => k !== key && live(k)) ?? null
}
/** leave `key` for the row next to it (after a stop, hide or remove); you stay put when you were not on it */
export const selectNeighbour = (key: string) => {
  if (deck.selected === key) select(neighbourOf(key))
}
export function closeTab(tmux: string) {
  const next = deck.selected === tmux ? neighbourOf(tmux) : null
  setTabs(deck.tabs.filter((t) => t !== tmux))
  if (deck.selected === tmux) select(next ?? deck.tabs.at(-1) ?? null)
}

/** a row the sidebar does not list (hidden, or older than its 7 days), opened from a ⌘K search hit: its card shows [T1112-18] */
export const extraRow = ref<Session | null>(null)
export const current = computed(() => deck.sessions.find((s) => s.key === deck.selected) ?? (extraRow.value && extraRow.value.key === deck.selected ? extraRow.value : null))

export type NewTool = 'claude' | 'codex' | 'agy' | 'shell'
export function openNew(cwd = '', tool: '' | NewTool = '') {
  // empty: the dialog starts on the current session's folder
  deck.newCwd = cwd
  deck.newTool = tool
  deck.newOpen = true
}

export async function startSession(body: { tool?: 'claude' | 'codex' | 'agy'; cwd: string; account: string; name?: string; prompt?: string; resume?: string; fork?: boolean; chrome?: boolean; mkdir?: boolean; mode?: PermissionMode; worktree?: boolean }) {
  const r = await api<{ tmux: string; pausedNote?: string }>('/api/sessions', body)
  await refresh()
  select(r.tmux)
  // the folder's or default account is paused, so it went to another one [T1112-11]
  if (r.pausedNote) showToast(r.pausedNote.charAt(0).toUpperCase() + r.pausedNote.slice(1))
  return r
}

/** Ask before stopping a deck session (⌥W, the Stop button, the row menu). */
export function askStop(s: Session | null, o: { close?: boolean } = {}) {
  if (s?.where === 'deck' && s.tmux && s.status !== 'ended') (deck.stopFor = s), (deck.stopClose = !!o.close)
}

/**
 * ⌘W / ⌥W on a stopped deck row [T1111-27]: off the pin list and hidden from the sidebar (Hide, never a
 * delete: the conversation stays in past sessions). Both are undone from the row's menu there.
 */
export async function closeRow(s: { key: string; sessionId: string | null; hand?: boolean }) {
  if (isPinned(s)) await setPinned(s, false)
  await api(`/api/sessions/${s.key}/forget`, {})
  // its conversation would come back as a past row: hide that too, like Hide on a past row
  if (s.sessionId && !s.hand) await api('/api/hide', { sessionId: s.sessionId })
  await refresh()
}

/** A project's rows for Close all [T1112-102]: its sessions in the sidebar, stopped and past ones too; pinned ones sit in the Pinned box and stay */
export const projectRows = (project: string) => deck.sessions.filter((s) => projectOf(s) === project && !isPinned(s) && (s.kind !== 'login' || s.tmux))
/** the project's pinned rows, which Close all leaves */
export const projectPinned = (project: string) => deck.sessions.filter((s) => projectOf(s) === project && isPinned(s))

/**
 * Close all on a project header [T1112-102]: each row the way ⌘W closes one (stop, unpin, hide; nothing deleted),
 * stopped and past rows only hidden. Selection moves only when the open session was in the group: to the row
 * below the group (nextAfterGroup). Returns the rows that failed.
 */
export async function closeProject(project: string, list: Planned<Session>[]): Promise<string[]> {
  const todo = list.filter((x) => x.action !== 'skip')
  const keys = new Set([`group:${project}`, ...todo.map((x) => x.s.key)])
  const live = (k: string) => deck.sessions.some((x) => x.key === k && x.where !== 'past' && x.status !== 'ended')
  const rows = [...document.querySelectorAll<HTMLElement>('aside [data-key], aside [data-group-head]')].filter((el) => el.getClientRects().length)
  const moving = !!deck.selected && keys.has(deck.selected)
  const next = moving ? nextAfterGroup(rows.map((el) => el.dataset.key ?? `group:${el.dataset.groupHead}`), keys, live) : null
  const failed: string[] = []
  for (const { s, action } of todo) {
    try {
      if (action === 'stop') await api(`/api/sessions/${s.tmux}/stop`, {})
      if (isPinned(s)) await setPinned(s, false)
      if (s.where === 'deck') await api(`/api/sessions/${s.key}/forget`, {})
      if (s.sessionId && !s.hand) await api('/api/hide', { sessionId: s.sessionId })
    } catch (e: any) {
      failed.push(`${s.title}: ${e.message}`)
    }
  }
  const stopped = new Set(todo.filter((x) => x.action === 'stop').map((x) => x.s.tmux))
  setTabs(deck.tabs.filter((t) => !stopped.has(t)))
  if (moving) select(next)
  await refresh()
  return failed
}

export async function stopSession(tmux: string) {
  await api(`/api/sessions/${tmux}/stop`, {})
  closeTab(tmux)
  await refresh()
}

/** One tool's accounts ("default" first); none for agy or a shell. */
export const accountsFor = (tool: string | undefined) => deck.accounts.filter((a) => (a.tool ?? 'claude') === (tool ?? 'claude'))
/** A tool's default-and-folder rules: Claude's are top-level in settings, Codex's under settings.codex. */
export const rulesFor = (tool: AccountTool) => (tool === 'codex' ? deck.settings.codex ?? { defaultAccount: 'auto', projects: {} } : deck.settings)

export const topUse = (a: Account) => {
  const w = Object.values(a.windows ?? {})
  return w.length ? Math.max(...w.map((x) => x.used)) : null
}

/** What a new session's account picker starts on: "auto" lets the server apply the folder's rule. */
export function bestAccount(): string {
  return 'auto'
}
/** "auto" = no fixed account: the folder's account or the default decides (or a local router file, if loaded). */
export function autoLabel(): string {
  return deck.router ? 'Folder or default (local router)' : 'Folder or default account'
}

/** an account switch is in flight: its sessions' old tmux names are gone before the new ones are listed */
let switching = 0
/**
 * Run an account switch, then put each new session in its old tab's place [T1112-128]. Closing the tab jumped to
 * the neighbour and the new session opened as a new tab at the end. The selected session stays selected.
 */
export async function keepTabsWhile(run: () => Promise<[from: string, to: string][]>) {
  switching++
  try {
    const pairs = await run()
    setTabs(swapTabs(deck.tabs, pairs))
    const sel = pairs.find(([from]) => from === deck.selected)
    await refresh()
    if (sel) select(sel[1])
    return pairs
  } finally {
    switching--
  }
}

export async function switchSessionAccount(tmux: string, account: string) {
  await keepTabsWhile(async () => {
    const r = await api<{ tmux: string }>(`/api/sessions/${tmux}/account`, { account })
    return [[tmux, r.tmux]]
  })
}

export function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}

/** "5m ago", or "just now" under a minute (never "now ago") */
export const agoText = (ms: number) => (ago(ms) === 'now' ? 'just now' : `${ago(ms)} ago`)

export const shortCwd = (cwd: string) => (workRoot.value !== '~' && cwd.startsWith(workRoot.value + '/') ? cwd.slice(workRoot.value.length + 1) : cwd)

export const STATUS: Record<Status, { label: string; tone: 'gray' | 'violet' | 'amber' | 'green' | 'blue' | 'red' | 'accent'; pulse?: boolean }> = {
  busy: { label: 'Working', tone: 'accent', pulse: true },
  idle: { label: 'Idle', tone: 'gray' },
  waiting: { label: 'Needs you', tone: 'amber' },
  blocked: { label: 'Blocked', tone: 'red' },
  ended: { label: 'Ended', tone: 'gray' },
}

/** a session's status pill: a deploy question gets its own [T1112-134] */
export const pillOf = (s: { status: Status; deploy?: boolean }) => (s.status === 'waiting' && s.deploy ? { label: 'Deploy?', tone: 'violet' as const, pulse: false } : STATUS[s.status])

export const copy = (text: string) => navigator.clipboard.writeText(text)

/** A session's project: the server's name for its folder (deck.json, Settings, git repo, folder). */
export function projectOf(s: { project?: string; cwd: string; kind?: string }): string {
  if (s.kind === 'login') return 'accounts'
  return s.project || (s.cwd.split('/').filter(Boolean).pop() ?? s.cwd)
}

export const OTHER = 'Other folders'
const byName = (a: string, b: string) => (a === OTHER ? 1 : b === OTHER ? -1 : a.localeCompare(b))

/** Project names in the owner's saved order; names not in it go after, A-Z, with "Other folders" last. */
export function orderProjects(names: Iterable<string>): string[] {
  const saved = deck.settings.projectOrder ?? []
  const rank = new Map(saved.map((n, i) => [n, i]))
  return [...new Set(names)].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || byName(a, b))
}

/** Save a new project order: shown at once, then stored on the server for every tab. */
export async function saveProjectOrder(order: string[]) {
  deck.settings = { ...deck.settings, projectOrder: order }
  orderSaving++
  orderStamp++
  try {
    await api('/api/settings', { projectOrder: order })
  } finally {
    orderSaving--
  }
}
/** Every project the deck knows gets a fixed place: a new one is added once at the top, so nothing else jumps. */
export function rememberProjects(names: Iterable<string>) {
  if (!deck.loaded || orderSaving) return
  const saved = deck.settings.projectOrder ?? []
  const have = new Set(saved)
  const fresh = [...new Set(names)].filter((n) => !have.has(n)).sort(byName)
  if (!fresh.length || appending) return
  appending = true
  const stamp = orderStamp
  api<{ projectOrder: string[] }>('/api/settings', { projectAppend: fresh })
    .then((r) => { if (!orderSaving && stamp === orderStamp) deck.settings = { ...deck.settings, projectOrder: r.projectOrder } })
    .catch(() => {})
    .finally(() => (appending = false))
}
let appending = false

// Pins: a session pinned to the top of the sidebar. A pin is the Claude session id (it survives resume and move), else the deck key.
// a terminal running claude by hand keeps its terminal's pin (its key), not the conversation's [T1111-19]
export const pinId = (s: { sessionId: string | null; key: string; hand?: boolean }) => (s.hand ? s.key : s.sessionId ?? s.key)
export const isPinned = (s: { sessionId: string | null; key: string; hand?: boolean }) => (deck.settings.pins ?? []).includes(pinId(s))
// a pin being saved, or saved after this refresh started, wins over what the server sent
let pinSaving = 0
let pinStamp = 0
let pinsShown: string[] = []
/** Pin or unpin a session: shown at once, then stored on the server for every tab. */
export async function setPinned(s: { sessionId: string | null; key: string; hand?: boolean }, on: boolean) {
  const id = pinId(s)
  const cur = (deck.settings.pins ?? []).filter((x) => x !== id)
  pinsShown = on ? [...cur, id] : cur
  deck.settings = { ...deck.settings, pins: pinsShown }
  pinSaving++
  pinStamp++
  const stamp = pinStamp
  try {
    const r = await api<{ pins: string[] }>('/api/settings', { pin: { id, on } })
    if (stamp === pinStamp) deck.settings = { ...deck.settings, pins: (pinsShown = r.pins) }
  } finally {
    pinSaving--
  }
}

/** A coordinator is the main session of a project: its name says so. */
export const isCoordinator = (s: { title: string }) => /coordinator/i.test(s.title)

/** Run a CLI's own update command in a terminal row and show it, so the owner watches it run [T1112-103]. */
export async function updateTool(tool: ToolStatus['tool']) {
  const r = await api<{ tmux: string }>('/api/tools/update', { tool })
  await refresh()
  setView('terminal')
  select(r.tmux)
}

/** Update Overvibe itself in a terminal row and show it [T1112-119]; the page reloads when the new server answers. */
export async function updateSelf() {
  const r = await api<{ tmux: string }>('/api/self/update', {})
  deck.selfOpen = false
  await refresh()
  setView('terminal')
  select(r.tmux)
}

export async function startShell(cwd: string, cmd?: string, name?: string, mkdir?: boolean) {
  const r = await api<{ tmux: string }>(mkdir ? '/api/sessions' : '/api/shell', mkdir ? { tool: 'shell', cwd, prompt: cmd, name, mkdir } : { cwd, cmd, name })
  await refresh()
  select(r.tmux)
}

/** Light or dark, remembered per browser; dark by default. */
export function applyTheme(t = localStorage.getItem('deck.theme') || 'dark') {
  document.documentElement.dataset.theme = t
  localStorage.setItem('deck.theme', t)
}
export const theme = () => document.documentElement.dataset.theme || 'dark'
export const toggleTheme = () => applyTheme(theme() === 'dark' ? 'light' : 'dark')

/** ⌥R or the palette: rename the current deck session */
export function openRename() {
  const s = current.value
  if (s?.where === 'deck' && s.tmux) deck.renameFor = s
}

/** "1.2M in / 38k out" for a session's tokens [T1111-13] */
export function tokenLine(t?: { in: number; out: number }) {
  if (!t || !(t.in || t.out)) return ''
  const n = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : String(x))
  return `${n(t.in)} in / ${n(t.out)} out`
}
