// Logins, one config dir each, per tool. Claude: CLAUDE_CONFIG_DIR, "default" is ~/.claude, others are
// ~/.claude-accounts/<name>/. Codex: CODEX_HOME, "default" is ~/.codex, others are ~/.codex-accounts/<name>/.
// Each extra account has its own login and the owner's shared setup symlinked in, so it behaves exactly like the default one.
// agy has no accounts: it keeps one Google login of its own (the macOS keychain on a Mac) and has no config-dir setting.
// Claude Code keeps its login in the keychain on a Mac and in <config dir>/.credentials.json on Linux; neither is in
// SHARED, so each account dir keeps its own login on both [T1111-8].
//
// Why not a login switcher that parks logins in the keychain and swaps one in? A parked login is never
// refreshed and expires. Here every account is a live login the CLI refreshes itself, and the
// keepalive below touches each one every few hours.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACCOUNTS_DIR, AGY_BIN, CLAUDE_BIN, CODEX_ACCOUNTS_DIR, CODEX_BIN, DATA_DIR, HOME, cleanEnv } from './env'
import { updateFor, type Update } from './updates'

const DEFAULT_DIR = join(HOME, '.claude')
const CODEX_DEFAULT_DIR = join(HOME, '.codex')

/** The tools with accounts. */
export type AccountTool = 'claude' | 'codex'
export const ACCOUNT_TOOLS: AccountTool[] = ['claude', 'codex']
export const hasAccounts = (tool: string | undefined): tool is AccountTool => tool === 'claude' || tool === 'codex'

/** Linked from ~/.claude into every account dir. Never the login (.credentials / keychain) or .claude.json. */
const SHARED = [
  'CLAUDE.md', 'copy-rules.md', 'settings.json', 'settings.local.json', 'keybindings.json',
  'skills', 'hooks', 'plugins', 'agents', 'commands', 'output-styles',
  // transcripts and history in one place: any account can resume any session, and the deck reads every one
  'projects', 'history.jsonl', 'file-history', 'plans', 'session-env', 'todos',
  // live-session registry: `claude agents`, ListAgents and SendMessage see sessions on every account
  'sessions',
]

/**
 * Linked from ~/.codex into every Codex account dir. Never auth.json (the login). sessions/, the session
 * index and history are shared so any account can resume any Codex session and the deck lists them all.
 * Codex's own sqlite state stays per account (a shared live sqlite db across homes is asking for trouble).
 */
const CODEX_SHARED = [
  'config.toml', 'AGENTS.md', 'rules', 'skills', 'prompts', 'plugins', 'memories',
  'sessions', 'archived_sessions', 'session_index.jsonl', 'history.jsonl',
]

/** Keys copied from ~/.claude.json into a new account's .claude.json, so it skips onboarding and trust prompts. */
const SEED_KEYS = ['hasCompletedOnboarding', 'lastOnboardingVersion', 'installMethod', 'autoUpdates', 'theme',
  'hasSeenAutoModeEntryWarning', 'optionAsMetaKeyInstalled', 'mcpServers', 'projects', 'githubRepoPaths']

export type Window = { used: number; resetsAt: number | null }
export type AccountInfo = {
  name: string
  tool: AccountTool
  dir: string
  email?: string
  plan?: string
  windows?: Record<string, Window>
  checkedAt?: number
  error?: string
  /** a login terminal for it is open and being watched; it is probed the moment the login lands [T1110-84] */
  loggingIn?: boolean
}

const STATE = join(DATA_DIR, 'accounts.json')
// keyed by name for Claude (as before), "codex:<name>" for Codex
const state: Record<string, Omit<AccountInfo, 'name' | 'dir' | 'tool'>> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 })
export const keyOf = (name: string, tool: AccountTool = 'claude') => (tool === 'claude' ? name : `${tool}:${name}`)

export const validName = (n: string) => /^[a-z0-9][a-z0-9-]{0,30}$/.test(n)

export function dirOf(name: string, tool: AccountTool = 'claude'): string {
  if (name === 'default') return tool === 'codex' ? CODEX_DEFAULT_DIR : DEFAULT_DIR
  if (!validName(name)) throw new Error(`bad account name "${name}"`)
  return join(tool === 'codex' ? CODEX_ACCOUNTS_DIR : ACCOUNTS_DIR, name)
}

/** CLAUDE_CONFIG_DIR / CODEX_HOME for a session on this account (none for default). */
export const envFor = (name: string, tool: AccountTool = 'claude'): Record<string, string> =>
  !name || name === 'default' ? {} : tool === 'codex' ? { CODEX_HOME: dirOf(name, 'codex') } : { CLAUDE_CONFIG_DIR: dirOf(name) }

/** Every account of one tool (or of all), "default" first. Hidden accounts (Settings > Hide) are left out unless `all`. */
/**
 * Claude in Chrome on a Claude account, from its Claude Code config [T1111-26]: 'paired' the extension is paired
 * with it (chromeExtension.pairedDeviceId), 'set up' its Chrome onboarding is done but no pairing is recorded,
 * 'installed' it only saw the extension, '' never. Read by mtime, the files are large.
 */
/** When a usage window of this account is used up: the latest reset among full windows, null when none is full [T1111-26] */
export function fullUntil(a: Pick<AccountInfo, 'windows'> | undefined, now = Date.now()): number | null {
  let until: number | null = null
  for (const w of Object.values(a?.windows ?? {})) if (w.used >= 100 && (w.resetsAt ?? Infinity) > now) until = Math.max(until ?? 0, w.resetsAt ?? Infinity)
  return until
}

export type ChromeState = 'paired' | 'set up' | 'installed' | ''
const chromeCache = new Map<string, { mtime: number; v: ChromeState }>()
export function chromeOf(name: string): ChromeState {
  const file = name === 'default' ? join(HOME, '.claude.json') : join(dirOf(name), '.claude.json')
  try {
    const mtime = statSync(file).mtimeMs
    const c = chromeCache.get(file)
    if (c && c.mtime === mtime) return c.v
    const d = JSON.parse(readFileSync(file, 'utf8'))
    const v: ChromeState = d.chromeExtension?.pairedDeviceId ? 'paired' : d.hasCompletedClaudeInChromeOnboarding ? 'set up' : d.cachedChromeExtensionInstalled ? 'installed' : ''
    chromeCache.set(file, { mtime, v })
    return v
  } catch {
    return ''
  }
}

export function listAccounts(tool?: AccountTool, o: { all?: boolean; hidden?: string[] } = {}): AccountInfo[] {
  const out: AccountInfo[] = []
  for (const t of tool ? [tool] : ACCOUNT_TOOLS) {
    const root = t === 'codex' ? CODEX_ACCOUNTS_DIR : ACCOUNTS_DIR
    const names = ['default']
    if (existsSync(root)) {
      for (const n of readdirSync(root).sort()) if (validName(n) && n !== 'default' && lstatSync(join(root, n)).isDirectory()) names.push(n)
    }
    for (const name of names) {
      if (!o.all && name !== 'default' && o.hidden?.includes(keyOf(name, t))) continue
      out.push({ name, tool: t, dir: dirOf(name, t), ...state[keyOf(name, t)], ...(watching.has(keyOf(name, t)) ? { loggingIn: true } : {}) })
    }
  }
  return out
}

/** Make the account dir, link the shared setup in (idempotent: also adds links that appeared since). */
export function ensureAccount(name: string, tool: AccountTool = 'claude') {
  if (!name || name === 'default') return
  const dir = dirOf(name, tool)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (tool === 'codex') {
    // made in ~/.codex first if missing, so every account writes its transcripts to the one shared place
    for (const d of ['sessions', 'archived_sessions']) mkdirSync(join(CODEX_DEFAULT_DIR, d), { recursive: true })
    return linkShared(CODEX_DEFAULT_DIR, dir, CODEX_SHARED)
  }
  linkShared(DEFAULT_DIR, dir, SHARED)
  const cfg = join(dir, '.claude.json')
  if (!existsSync(cfg)) {
    let base: Record<string, unknown> = {}
    try {
      base = JSON.parse(readFileSync(join(HOME, '.claude.json'), 'utf8'))
    } catch {}
    const seed: Record<string, unknown> = {}
    for (const k of SEED_KEYS) if (k in base) seed[k] = base[k]
    writeFileSync(cfg, JSON.stringify(seed, null, 2), { mode: 0o600 })
  }
}

function linkShared(from: string, dir: string, items: string[]) {
  for (const item of items) {
    const src = join(from, item)
    const dst = join(dir, item)
    if (!existsSync(src)) continue
    try {
      lstatSync(dst)
      continue // already there (a link, or a real file the owner made on purpose)
    } catch {}
    symlinkSync(src, dst)
  }
}

/**
 * A cheap fingerprint of an account's login, read from disk without starting the CLI: Codex rewrites
 * auth.json on login; Claude Code writes the signed-in account (oauthAccount) into the config dir's
 * .claude.json (~/.claude.json for default). It changes when a login completes.
 */
export function loginStamp(name: string, tool: AccountTool = 'claude'): string {
  try {
    if (tool === 'codex') {
      const st = statSync(join(dirOf(name, 'codex'), 'auth.json'))
      return `${st.mtimeMs}:${st.size}`
    }
    const o = JSON.parse(readFileSync(name === 'default' ? join(HOME, '.claude.json') : join(dirOf(name), '.claude.json'), 'utf8'))?.oauthAccount
    return o ? `${o.accountUuid ?? ''}:${o.emailAddress ?? ''}:${o.organizationUuid ?? ''}` : ''
  } catch {
    return ''
  }
}

const watching = new Set<string>()
/**
 * Watch an account while its login terminal is open [T1110-84]: as soon as the login lands on disk (or
 * the terminal closes, which `claude auth login` and `codex login` do when they finish), probe it, so the
 * page's account row gets its email and usage bars by itself. One watch per account; gives up after 30 min.
 */
export async function watchLogin(name: string, tool: AccountTool, isOpen: () => Promise<boolean>) {
  const k = keyOf(name, tool)
  if (watching.has(k)) return
  watching.add(k)
  const before = loginStamp(name, tool)
  const t0 = Date.now()
  try {
    while (Date.now() - t0 < 30 * 60_000) {
      await Bun.sleep(1500)
      const changed = loginStamp(name, tool) !== before
      if (!changed && (await isOpen())) continue
      if (changed) await Bun.sleep(1500) // let the CLI finish writing its login
      const a = await probe(name, tool)
      // the first probe can beat the login to the keychain: one more try a few seconds later
      if (changed && !a.email) {
        await Bun.sleep(4000)
        await probe(name, tool)
      }
      return
    }
  } finally {
    watching.delete(k)
  }
}

/** The argv that logs this account in, run in a deck terminal so the owner can finish the browser step. */
export const loginArgv = (tool: AccountTool = 'claude') => (tool === 'codex' ? [CODEX_BIN, 'login'] : [CLAUDE_BIN, 'auth', 'login'])

/**
 * Open a session on the account, send NO message, read the usage windows, close. No turn is billed,
 * and opening the session makes the CLI refresh the login, which is what keeps an idle account alive.
 */
export async function probe(name: string, tool: AccountTool = 'claude'): Promise<AccountInfo> {
  if (tool === 'codex') return probeCodex(name)
  const s = (state[name] ??= {})
  if (!existsSync(CLAUDE_BIN)) return notInstalled(s, name, 'claude')
  let q: any
  const TIMEOUT = 30_000
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const silent = (async function* () {
      await new Promise<void>((r) => setTimeout(r, TIMEOUT * 2).unref?.())
    })()
    q = query({
      prompt: silent as any,
      options: {
        tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], persistSession: false,
        cwd: DATA_DIR,
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        env: cleanEnv(name === 'default' ? { CLAUDE_CONFIG_DIR: undefined } : envFor(name)),
      } as any,
    })
    const timeout = <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error('timed out')), TIMEOUT).unref?.())])
    const info: any = typeof q.accountInfo === 'function' ? await timeout(q.accountInfo()).catch(() => null) : null
    if (info?.email) s.email = info.email
    const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    const answer: any = typeof fn === 'function' ? await timeout(fn.call(q)) : null
    if (answer?.subscription_type) s.plan = answer.subscription_type
    if (answer?.rate_limits) {
      const windows: Record<string, Window> = {}
      for (const [k, w] of Object.entries<any>(answer.rate_limits)) {
        if (!w || typeof w.utilization !== 'number') continue
        const at = w.resets_at ? Date.parse(w.resets_at) : NaN
        windows[k] = { used: w.utilization, resetsAt: Number.isFinite(at) ? at : null }
      }
      s.windows = windows
    }
    s.error = info || answer ? undefined : 'no answer (not logged in?)'
  } catch (e: any) {
    s.error = String(e?.message ?? e).slice(0, 200)
  } finally {
    try {
      q?.close?.()
    } catch {}
  }
  s.checkedAt = Date.now()
  save()
  return { name, tool: 'claude', dir: dirOf(name), ...s }
}

/**
 * Codex: ask `codex app-server` on the account's CODEX_HOME for the login (account/read) and the usage
 * windows (account/rateLimits/read). No turn is run. Primary is the 5-hour window, secondary the week.
 */
async function probeCodex(name: string): Promise<AccountInfo> {
  const s = (state[keyOf(name, 'codex')] ??= {})
  if (!existsSync(CODEX_BIN)) return notInstalled(s, name, 'codex')
  const p = Bun.spawn([CODEX_BIN, 'app-server'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', cwd: DATA_DIR,
    env: cleanEnv(name === 'default' ? { CODEX_HOME: undefined } : envFor(name, 'codex')),
  })
  const answers = new Map<number, any>()
  try {
    const send = (m: unknown) => {
      p.stdin.write(JSON.stringify(m) + '\n')
      p.stdin.flush()
    }
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'overvibe', version: '1' } } })
    send({ method: 'initialized' })
    send({ id: 2, method: 'account/read', params: {} })
    send({ id: 3, method: 'account/rateLimits/read' })
    const read = (async () => {
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of p.stdout) {
        buf += dec.decode(chunk)
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          try {
            const j = JSON.parse(line)
            if (typeof j.id === 'number') answers.set(j.id, j)
          } catch {}
          if (answers.has(2) && answers.has(3)) return
        }
      }
    })()
    await Promise.race([read, Bun.sleep(20_000)])
    const acc = answers.get(2)?.result?.account
    const rl = answers.get(3)?.result?.rateLimits
    if (acc?.email) s.email = acc.email
    else if (acc?.type === 'apiKey') s.email = 'API key'
    if (acc?.planType || rl?.planType) s.plan = acc?.planType ?? rl?.planType
    if (rl) {
      const windows: Record<string, Window> = {}
      for (const [k, w] of [['five_hour', rl.primary], ['seven_day', rl.secondary]] as const) {
        if (!w || typeof w.usedPercent !== 'number') continue
        const key = w.windowDurationMins === 300 ? 'five_hour' : w.windowDurationMins === 10080 ? 'seven_day' : k
        windows[key] = { used: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null }
      }
      s.windows = windows
    }
    s.error = acc ? undefined : answers.has(2) ? 'not logged in' : 'no answer from codex app-server'
    if (!acc) delete s.email
  } catch (e: any) {
    s.error = String(e?.message ?? e).slice(0, 200)
  } finally {
    try {
      p.kill()
    } catch {}
  }
  s.checkedAt = Date.now()
  save()
  return { name, tool: 'codex', dir: dirOf(name, 'codex'), ...s }
}

/** the CLI is missing: say so plainly (the probe would fail with a spawn error or the SDK's own message) */
function notInstalled(s: Omit<AccountInfo, 'name' | 'tool' | 'dir'>, name: string, tool: AccountTool): AccountInfo {
  s.error = `${tool === 'codex' ? 'Codex' : 'Claude Code'} is not installed`
  delete s.email
  s.checkedAt = Date.now()
  save()
  return { name, tool, dir: dirOf(name, tool), ...s }
}

export async function probeAll(hidden: string[] = []) {
  for (const a of listAccounts(undefined, { hidden })) await probe(a.name, a.tool).catch(() => {}) // one failing probe never skips the rest
}

/**
 * Is each CLI installed, and which version. Read once a while (cached 10 min): Settings shows it beside
 * the accounts. Login and usage come from the account probes; agy exposes neither, so it says so.
 */
export type ToolStatus = { tool: 'claude' | 'codex' | 'agy'; installed: boolean; version?: string; accounts: boolean; note?: string; update?: Update }
let toolCache: { at: number; list: ToolStatus[]; stamp: string } | null = null
/** where each CLI really lives and when it changed: an update (even one run by hand in a terminal) moves the
 * link or rewrites the file, so the versions are read again on the next look instead of after 10 minutes */
const binStamp = () =>
  [CLAUDE_BIN, CODEX_BIN, AGY_BIN]
    .map((b) => {
      try {
        const r = realpathSync(b)
        return `${r}@${statSync(r).mtimeMs}`
      } catch {
        return '-'
      }
    })
    .join('|')
/** fresh: skip the cache (the setup's "Check again" after installing a CLI) */
export async function toolStatus(fresh = false): Promise<ToolStatus[]> {
  // the update flag is read from its own cache each time, so a background check shows on the next poll [T1112-103]
  const withUpdate = (list: ToolStatus[]) => list.map((t) => ({ ...t, update: (t.installed && updateFor(t.tool, t.version)) || undefined }))
  const stamp = binStamp()
  if (!fresh && toolCache && toolCache.stamp === stamp && Date.now() - toolCache.at < 10 * 60_000) return withUpdate(toolCache.list)
  const ver = async (bin: string) => {
    if (!existsSync(bin)) return undefined
    try {
      const p = Bun.spawn([bin, '--version'], { stdout: 'pipe', stderr: 'pipe', env: cleanEnv() })
      const out = await Promise.race([new Response(p.stdout).text(), Bun.sleep(5000).then(() => '')])
      p.kill()
      return out.trim().split('\n')[0]?.slice(0, 60) || ''
    } catch {
      return ''
    }
  }
  const [c, x, g] = await Promise.all([ver(CLAUDE_BIN), ver(CODEX_BIN), ver(AGY_BIN)])
  const list: ToolStatus[] = [
    { tool: 'claude', installed: c !== undefined, version: c, accounts: true },
    { tool: 'codex', installed: x !== undefined, version: x, accounts: true },
    { tool: 'agy', installed: g !== undefined, version: g, accounts: false, note: 'one login, kept by agy itself; agy does not report its login or usage' },
  ]
  toolCache = { at: Date.now(), list, stamp }
  return withUpdate(list)
}

/** Read the versions again on the next look (an update just ran in a terminal) [T1112-103]. */
export const forgetToolStatus = () => void (toolCache = null)
