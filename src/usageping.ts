// Usage ping [T1110-72, T1112-101]: anonymous, at most once a day, so the makers can count how many people
// open Overvibe each day. On by default; turn it off in Settings (or untick the box on setup's Welcome step).
// An explicit off is kept for good. With no recorded choice it counts as on, but nothing goes out until the
// owner has been through setup's Welcome step (a choice is saved) or setup is marked done, so someone who
// unticks it during setup never sends one.
//
// The ping is a public form post into an ElasticFunnels form collection (the same endpoint a lead form
// on overvibe.dev posts to), so no key or secret ships in this repo. What it sends, and nothing else:
//   install_id  random id made on this computer (kept in ~/.config/overvibe/usage-ping.json)
//   version     Overvibe's version (package.json)
//   macos       the macOS version (sw_vers); empty on Linux and WSL
//   os          the OS and its version: "macos 15.5", "linux debian 12", "wsl ubuntu 24.04" [T1111-8]
//   claude, codex, agy   "yes" or "no": is that CLI installed
// No paths, user names, emails, host names, session data or prompts. A failure is quiet (5 s timeout),
// and the first check runs a while after startup, so it never holds the server up.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from './env'
import { APP_VERSION, getSeen } from './news'
import { toolStatus } from './accounts'
import { osInfo } from './platform'

/** the ElasticFunnels form collection on overvibe.dev that stores the pings (its code, from `ef collections create`) */
const COLLECTION = 'qaajdg'
const URL_DEFAULT = COLLECTION ? `https://overvibe.dev/api/collection/${COLLECTION}/store` : ''
/** OVERVIBE_PING_URL points the ping somewhere else (a local mock in tests) */
const PING_URL = process.env.OVERVIBE_PING_URL || URL_DEFAULT

const FILE = join(DATA_DIR, 'usage-ping.json')
const TIMEOUT_MS = 5000
const FIRST_CHECK_MS = Number(process.env.OVERVIBE_PING_DELAY_MS) || 30_000
const CHECK_EVERY_MS = 60 * 60 * 1000

/** on: null until a choice is recorded (counts as on); last: the local day (YYYY-MM-DD) the last ping went out */
type State = { on: boolean | null; id?: string; last?: string }

function load(): State {
  try {
    if (existsSync(FILE)) {
      const s = JSON.parse(readFileSync(FILE, 'utf8'))
      return { on: typeof s.on === 'boolean' ? s.on : null, id: typeof s.id === 'string' ? s.id : undefined, last: typeof s.last === 'string' ? s.last : undefined }
    }
  } catch {}
  return { on: null }
}
const save = (s: State) => writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })

/** on unless turned off: no recorded choice counts as on */
export const isOn = (s: Pick<State, 'on'>) => s.on !== false
/** may a ping go out: on, and either a choice was saved or setup is done (no ping before the Welcome box is seen) */
export const maySend = (s: Pick<State, 'on'>, setupDone: boolean) => isOn(s) && (s.on === true || setupDone)
const setupDone = () => getSeen().modalShown.includes('setup-done')

/** for the page: is it on, and has a choice been made (both boxes show ticked until someone unticks one) */
export function pingState() {
  const s = load()
  return { on: isOn(s), chosen: s.on !== null }
}

export function setPing(on: boolean) {
  const s = load()
  s.on = on
  if (on && !s.id) s.id = randomUUID()
  save(s)
  if (on) void maybePing()
  return pingState()
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** exactly the fields that go out; exported so the test can check them */
export async function payload(id: string): Promise<Record<string, string>> {
  const tools = await toolStatus()
  const has = (t: string) => (tools.find((x) => x.tool === t)?.installed ? 'yes' : 'no')
  const { macos, os } = await osInfo()
  return { install_id: id, version: APP_VERSION, macos, os, claude: has('claude'), codex: has('codex'), agy: has('agy') }
}

/** One public form post into an ElasticFunnels collection: open the site's page for its session cookie and csrf
 *  token, then POST the fields to /api/collection/<code>/store. 5 s timeout each; throws on a network error. */
export async function postToCollection(url: string, fields: Record<string, string>): Promise<Response> {
  const site = new URL(url).origin
  const page = await fetch(site + '/', { headers: { 'user-agent': 'Overvibe' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const token = /csrf_token = "([^"]+)"/.exec(await page.text())?.[1] ?? ''
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'Overvibe',
      'x-csrf-token': token, cookie, origin: site, referer: site + '/',
    },
    body: new URLSearchParams({ _csrf: token, ...fields }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
}

let busy = false
/** send today's ping unless it is off, setup has not got past its Welcome step, or one went out today; never throws */
export async function maybePing(): Promise<'off' | 'waiting' | 'sent' | 'already' | 'failed' | 'no-endpoint'> {
  if (busy) return 'already'
  const s = load()
  if (!isOn(s)) return 'off'
  if (!maySend(s, setupDone())) return 'waiting'
  if (!s.id) {
    s.id = randomUUID()
    save(s)
  }
  const day = today()
  if (s.last === day) return 'already'
  if (!PING_URL) return 'no-endpoint'
  busy = true
  try {
    const r = await postToCollection(PING_URL, await payload(s.id))
    if (!r.ok) return 'failed'
    save({ ...load(), last: day })
    return 'sent'
  } catch {
    return 'failed'
  } finally {
    busy = false
  }
}

/** first check a while after startup, then hourly (a server left running sends once on each new day) */
export function startUsagePing() {
  const run = () =>
    maybePing().then((r) => {
      if (r === 'sent') console.log('usage ping: sent')
      else if (r === 'off') console.log('usage ping: off, nothing sent')
      else if (r === 'waiting') console.log('usage ping: waiting for setup, nothing sent')
      else if (r === 'already') console.log('usage ping: already sent today, nothing sent')
      else if (r === 'no-endpoint') console.log('usage ping: on, but no endpoint is set, nothing sent')
    })
  setTimeout(() => {
    void run()
    setInterval(() => void maybePing().then((r) => r === 'sent' && console.log('usage ping: sent')), CHECK_EVERY_MS)
  }, FIRST_CHECK_MS)
}
