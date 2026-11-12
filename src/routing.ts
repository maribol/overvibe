// Which account a new session runs on.
//
// Settings: one default for everything, overridden per project folder. An explicit account (picker, --account NAME)
// always wins. Without one (or with "auto"), a local router file may choose (src/localrouter.ts); otherwise the
// folder's account, else the default account, else "default" (~/.claude). "auto" in a setting means the same: no
// fixed account, let the router or the default decide.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, untildify } from './env'
import { chromeOf, hasAccounts, listAccounts, type AccountTool } from './accounts'
import { askRouter } from './localrouter'
import { deckJsonFor } from './deckjson'
import { pauseKey, pausedMessage, settle } from './pause'

const FILE = join(DATA_DIR, 'settings.json')

// chromeAccount: the account the Claude in Chrome extension is signed in to. The extension only pairs
// with sessions on that account, so a session that needs the browser must run there.
// chromeProjects: folders whose sessions need Chrome (deck.json "chrome": true does the same).
// projectOrder: the owner's order of project groups in the sidebar (names as projectOf gives them).
// projectNames: folder (absolute) -> the project name the owner gave it; covers its subfolders too. deck.json's
// `project` wins over it; without either, a folder's project is its git repo's name (src/projects.ts).
// pins: sessions pinned to the top of the sidebar, oldest pin first. Each is a Claude session id (it survives resume and
// move), else the deck key.
// codex: the same default and per-folder rules for Codex accounts.
// hiddenAccounts: accounts the owner hid (Remove in Settings), as "name" (Claude) or "codex:name". Their folders stay on disk.
// pausedAccounts: accounts nothing new may run on, same keys (src/pause.ts) [T1112-11].
// tasksView: the Tasks view and its TASKS.md reads on or off; unset until the first run decides (server.ts) [T1112-16].
export type Rules = { defaultAccount: string; projects: Record<string, string> }
// spawnLimits: how deep sessions may start sessions (levels below one the owner started) and how many running ones each may have [T1110-81]
export type SpawnLimits = { maxDepth: number; maxChildren: number }
export const SPAWN_DEFAULTS: SpawnLimits = { maxDepth: 3, maxChildren: 8 }
// permissionMode: how new sessions run [T1110-85]: "auto" (each tool's auto mode) or "ask" (the tool's own approval
// prompts). modeProjects: folder -> mode, covering its subfolders; deck.json "mode" wins over both.
// Settings shows it as "Start new sessions in auto mode" [T1112-99]: off (ask) on a new install, on for an install that
// already had a settings file or sessions before the setting existed (firstMode), stored so it never flips by itself.
export type Mode = 'auto' | 'ask'
export const isMode = (m: unknown): m is Mode => m === 'auto' || m === 'ask'
export type Settings = Rules & { permissionMode: Mode; modeProjects: Record<string, Mode>; spawnLimits: SpawnLimits; codex: Rules; hiddenAccounts: string[]; pausedAccounts: string[]; remoteOff: string[]; chromeAccount: string | null; chromeProjects: Record<string, boolean>; projectOrder: string[]; projectNames: Record<string, string>; pins: string[]; tasksView?: boolean; sidebarAccounts?: boolean; sidebarOrder?: 'project' | 'newest' }
let settings: Settings = { defaultAccount: 'auto', projects: {}, permissionMode: 'auto', modeProjects: {}, spawnLimits: { ...SPAWN_DEFAULTS }, codex: { defaultAccount: 'auto', projects: {} }, hiddenAccounts: [], pausedAccounts: [], remoteOff: [], chromeAccount: null, chromeProjects: {}, projectOrder: [], projectNames: {}, pins: [] }
const hadFile = existsSync(FILE)
let savedMode: unknown
try {
  if (hadFile) {
    const saved = JSON.parse(readFileSync(FILE, 'utf8'))
    savedMode = saved?.permissionMode
    settings = { ...settings, ...saved }
  }
} catch {}
settings.codex = { ...{ defaultAccount: 'auto', projects: {} }, ...(settings.codex as Partial<Rules>) }
settings.hiddenAccounts ??= []
settings.pausedAccounts ??= []
settings.remoteOff ??= []
/** The auto mode default for an install with no saved choice [T1112-99]: on when it was already in use (a settings file or deck sessions), off for a new one. */
export const firstMode = (o: { settingsFile: boolean; sessions: boolean }): Mode => (o.settingsFile || o.sessions ? 'auto' : 'ask')
if (!isMode(savedMode)) settings.permissionMode = firstMode({ settingsFile: hadFile, sessions: existsSync(join(DATA_DIR, 'sessions.json')) })
/** No auto mode choice in settings.json yet: server.ts stores the one firstMode made, so it never changes on its own. */
export const modeUnsaved = () => !isMode(savedMode)
settings.modeProjects ??= {}
settings.spawnLimits = { ...SPAWN_DEFAULTS, ...(settings.spawnLimits as Partial<SpawnLimits>) }

export const getSettings = () => settings
/** Remote Control on for new sessions of this Claude account (Settings > Accounts; on unless switched off) */
export const remoteFor = (account: string) => !settings.remoteOff.includes(account)
export function setSettings(next: Partial<Settings>) {
  settings = {
    ...settings, ...next,
    projects: { ...settings.projects, ...(next.projects ?? {}) },
    codex: { ...settings.codex, ...(next.codex ?? {}), projects: { ...settings.codex.projects, ...(next.codex?.projects ?? {}) } },
    chromeProjects: { ...settings.chromeProjects, ...(next.chromeProjects ?? {}) },
    modeProjects: { ...settings.modeProjects, ...(next.modeProjects ?? {}) },
    projectNames: { ...settings.projectNames, ...(next.projectNames ?? {}) },
    spawnLimits: { ...settings.spawnLimits, ...(next.spawnLimits ?? {}) },
  }
  for (const [k, v] of Object.entries(settings.projectNames)) if (!v) delete settings.projectNames[k]
  for (const [k, v] of Object.entries(settings.projects)) if (!v) delete settings.projects[k]
  for (const [k, v] of Object.entries(settings.codex.projects)) if (!v) delete settings.codex.projects[k]
  for (const [k, v] of Object.entries(settings.chromeProjects)) if (!v) delete settings.chromeProjects[k]
  for (const [k, v] of Object.entries(settings.modeProjects)) if (!isMode(v)) delete settings.modeProjects[k]
  writeFileSync(FILE, JSON.stringify(settings, null, 2), { mode: 0o600 })
}

const rulesOf = (tool: AccountTool): Rules => (tool === 'codex' ? settings.codex : settings)

/** Is this account paused (Settings > Accounts) [T1112-11]? */
export const isPaused = (name: string, tool: AccountTool = 'claude') => settings.pausedAccounts.includes(pauseKey(name, tool))
/** Throws the paused message when it is: for an account the request named (switch, explicit --account). */
export function refusePaused(name: string, tool: AccountTool = 'claude') {
  if (isPaused(name, tool)) throw new Error(pausedMessage(name, tool))
}

/** The accounts a tool offers, hidden ones left out. */
export const accountsOf = (tool: AccountTool) => listAccounts(tool, { hidden: settings.hiddenAccounts })

/** The rule for a folder: its own setting, else the nearest parent folder's, else the default. */
export function ruleFor(cwd: string, tool: AccountTool = 'claude'): { account: string; from: string } {
  const r = rulesOf(tool)
  let p = untildify(cwd)
  while (p && p !== '/') {
    if (r.projects[p]) return { account: r.projects[p]!, from: p }
    p = p.replace(/\/[^/]+$/, '')
  }
  return { account: r.defaultAccount, from: 'default' }
}

/** Does a session in this folder need Claude in Chrome? deck.json "chrome": true, or a Settings toggle on it or a parent. */
export function needsChrome(cwd: string): boolean {
  if ((deckJsonFor(cwd) as any)?.chrome === true) return true
  let p = untildify(cwd)
  while (p && p !== '/') {
    if (settings.chromeProjects[p]) return true
    p = p.replace(/\/[^/]+$/, '')
  }
  return false
}

/**
 * The permission mode a new session in this folder gets when nobody chose one [T1110-85]: deck.json "mode",
 * else the nearest folder rule in Settings, else the Settings default (auto unless the owner changed it).
 */
export function modeFor(cwd: string): { mode: Mode; from: string } {
  const dj = deckJsonFor(cwd)
  if (dj && isMode(dj.mode)) return { mode: dj.mode, from: 'deck.json' }
  let p = untildify(cwd)
  while (p && p !== '/') {
    const m = settings.modeProjects[p]
    if (isMode(m)) return { mode: m, from: p }
    p = p.replace(/\/[^/]+$/, '')
  }
  return { mode: settings.permissionMode, from: 'default' }
}

/** The account the normal rules give a folder: its named account, else the named default, else "default". */
export function defaultFor(cwd: string, tool: AccountTool = 'claude'): string {
  const ok = (n: string) => n !== 'auto' && accountsOf(tool).some((a) => a.name === n)
  const rule = ruleFor(cwd, tool).account
  if (ok(rule)) return rule
  const d = rulesOf(tool).defaultAccount
  return ok(d) ? d : 'default'
}

/** The account a new session in this folder should use. `asked`: an account name, or "auto"/empty for no explicit choice. */
/**
 * The account Chrome sessions run on: Settings' chromeAccount, else the one Claude account the extension is
 * paired with (when exactly one is) [T1111-26]. Null when neither says.
 */
export function chromeAccountNow(): string | null {
  if (settings.chromeAccount) return settings.chromeAccount
  const paired = listAccounts('claude', { hidden: settings.hiddenAccounts }).filter((a) => chromeOf(a.name) === 'paired')
  return paired.length === 1 ? paired[0]!.name : null
}

export type Route = { account: string; by: 'asked' | 'chrome' | 'router' | 'rules'; note?: string }

/**
 * The account a new session (or a resume) runs on. Paused accounts [T1112-11]: one asked for by name is
 * refused; one a rule, the default, the router or Chrome picked is replaced (src/pause.ts settle) and note says so.
 */
export async function routeFor(cwd: string, asked?: string, chrome?: boolean, tool = 'claude'): Promise<Route> {
  // agy (and a shell) have no accounts
  if (!hasAccounts(tool)) return { account: '', by: 'rules' }
  const r = await pickFor(cwd, asked, chrome, tool)
  const d = rulesOf(tool).defaultAccount
  const names = accountsOf(tool).map((a) => a.name)
  const s = settle({ tool, account: r.account, by: r.by, accounts: names, paused: settings.pausedAccounts, defaultAccount: d !== 'auto' && names.includes(d) ? d : 'default' })
  return { ...r, ...s }
}

async function pickFor(cwd: string, asked: string | undefined, chrome: boolean | undefined, tool: AccountTool): Promise<Route> {
  const explicit = asked && asked !== 'auto' ? asked : null
  if (explicit) {
    if (!listAccounts(tool, { all: true }).some((a) => a.name === explicit)) throw new Error(`no ${tool === 'codex' ? 'Codex' : 'Claude'} account "${explicit}"`)
    return { account: explicit, by: 'asked' }
  }
  // Codex: the folder's Codex account, else the Codex default; Chrome and the local router are Claude-only
  if (tool === 'codex') return { account: defaultFor(cwd, 'codex'), by: 'rules' }
  // Chrome pins the account: the extension only talks to sessions on the account it is signed in to
  if (chrome ?? needsChrome(cwd)) {
    const c = chromeAccountNow()
    if (c) return { account: c, by: 'chrome' }
  }
  const fallback = defaultFor(cwd)
  // the router only sees accounts it may pick: paused ones are left out
  const accounts = accountsOf('claude').filter((a) => !isPaused(a.name))
  const picked = await askRouter({
    cwd, tool, requested: asked || null, rule: ruleFor(cwd), defaultAccount: fallback,
    accounts: accounts.map(({ name, email, plan, windows, checkedAt, error }) => ({ name, email, plan, windows, checkedAt, error })),
  })
  if (picked && accounts.some((a) => a.name === picked)) return { account: picked, by: 'router' }
  return { account: fallback, by: 'rules' }
}

export const accountFor = async (cwd: string, asked?: string, chrome?: boolean, tool = 'claude') => (await routeFor(cwd, asked, chrome, tool)).account
