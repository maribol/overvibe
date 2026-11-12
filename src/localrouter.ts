// A local router file can choose the account for new sessions. It lives outside the repo, at
// ~/.config/overvibe/router.ts, and exports `pick(ctx)`. The deck asks it only when a new session has no
// explicit account (none given, or "auto"). It returns an account name, or null for the normal rules (the
// folder's account, else the default account, else "default"). An unknown name, a throw or a slow answer
// (over 2 s) also means the normal rules. The file is loaded at startup and again whenever it changes.
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, tildify } from './env'
import type { AccountInfo } from './accounts'

export const ROUTER_FILE = join(DATA_DIR, 'router.ts')

export type RouterContext = {
  cwd: string
  tool: string
  /** what the request asked for: null or "auto" */
  requested: string | null
  /** the folder's account setting (or the default's) and where it came from: a folder path or "default" */
  rule: { account: string; from: string }
  /** the account the normal rules would use */
  defaultAccount: string
  accounts: Pick<AccountInfo, 'name' | 'email' | 'plan' | 'windows' | 'checkedAt' | 'error'>[]
}
type PickFn = (ctx: RouterContext) => string | null | undefined | Promise<string | null | undefined>

let loaded: { mtime: number; pick: PickFn } | null = null
let failed = 0

async function load(): Promise<PickFn | null> {
  if (!existsSync(ROUTER_FILE)) {
    if (loaded) console.log('local router removed; using the normal account rules')
    loaded = null
    return null
  }
  const mtime = statSync(ROUTER_FILE).mtimeMs
  if (loaded?.mtime === mtime) return loaded.pick
  if (failed === mtime) return null
  try {
    const mod = await import(`${ROUTER_FILE}?v=${mtime}`)
    if (typeof mod.pick !== 'function') throw new Error('it has no exported pick(ctx)')
    loaded = { mtime, pick: mod.pick }
    console.log(`local router loaded from ${tildify(ROUTER_FILE)}`)
    return loaded.pick
  } catch (e: any) {
    failed = mtime
    loaded = null
    console.log(`local router in ${tildify(ROUTER_FILE)} not loaded: ${e?.message ?? e}`)
    return null
  }
}

export const loadRouter = () => load()
export const routerActive = () => !!loaded && existsSync(ROUTER_FILE)

/** The router's choice, or null when there is no router or it declines, fails or takes too long. */
export async function askRouter(ctx: RouterContext): Promise<string | null> {
  const pick = await load()
  if (!pick) return null
  try {
    const r = await Promise.race([Promise.resolve(pick(ctx)), new Promise<null>((ok) => setTimeout(() => ok(null), 2000))])
    return typeof r === 'string' && r ? r : null
  } catch (e: any) {
    console.log(`local router failed: ${e?.message ?? e}`)
    return null
  }
}
