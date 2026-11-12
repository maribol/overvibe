// What's new: announcements from announcements.json in the public repo, read by the server (never by
// the page, so the page talks to nothing but this server). Modelled on CommentGrab's feed.
//
// The remote copy (raw.githubusercontent.com) is fetched at most every 6 hours (15 minutes after a
// failed try), cached in ~/.config/overvibe/news-cache.json, and merged over the copy in this repo,
// so the list works offline and before the public repo exists. Any failure is quiet.
//
// This is DATA: items are validated strictly, every string is plain text (the page renders it with
// text nodes, never as HTML), and links are https on a short allowlist.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './env'

export const FEED_URL = 'https://raw.githubusercontent.com/maribol/overvibe/main/announcements.json'
const LOCAL_FILE = join(import.meta.dir, '..', 'announcements.json')
const CACHE_FILE = join(DATA_DIR, 'news-cache.json')
const SEEN_FILE = join(DATA_DIR, 'news-seen.json')

const TTL_MS = 6 * 60 * 60 * 1000
const RETRY_MS = 15 * 60 * 1000
const TIMEOUT_MS = 5000
const MAX_FEED_BYTES = 200_000
const MAX_ITEMS = 50
const MAX_IDS = 300
const LIMITS = { id: 80, title: 120, body: 2000, url: 500 }
const VERSION_RE = /^\d+(\.\d+){0,3}$/

export type NewsTag = 'release' | 'news' | 'tip'
const TAGS: NewsTag[] = ['release', 'news', 'tip']
export type NewsItem = { id: string; date: string; title: string; body: string; tag: NewsTag; minVersion?: string; url?: string; modal?: boolean; draft?: boolean }

/** The app's version (package.json), compared with an item's minVersion. */
export const APP_VERSION: string = (() => {
  try {
    const v = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')).version
    return typeof v === 'string' && VERSION_RE.test(v) ? v : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// ---------- validation ----------

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > LIMITS.url) return undefined
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return undefined
  const host = u.hostname.toLowerCase()
  const ok = host === 'overvibe.dev' || host === 'www.overvibe.dev' || (host === 'github.com' && (u.pathname === '/maribol' || u.pathname.startsWith('/maribol/')))
  return ok ? u.href : undefined
}

/** Plain text: no control or bidi characters (newlines kept), trimmed, capped. */
function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const s = value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .trim()
  if (!s) return undefined
  return s.length > max ? s.slice(0, max).trimEnd() : s
}

const isRealDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

export function validateItem(raw: unknown): NewsItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id.length <= LIMITS.id && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.id) ? r.id : null
  let date: string | null = null
  try {
    date = typeof r.date === 'string' && isRealDate(r.date) ? r.date : null
  } catch {}
  const title = cleanText(r.title, LIMITS.title)
  const body = cleanText(r.body, LIMITS.body)
  if (!id || !date || !title || !body) return null
  // an unknown future tag shows as "news" on this build
  const tag: NewsTag = TAGS.includes(r.tag as NewsTag) ? (r.tag as NewsTag) : 'news'
  const item: NewsItem = { id, date, title, body, tag }
  if (r.minVersion !== undefined) {
    if (typeof r.minVersion !== 'string' || !VERSION_RE.test(r.minVersion)) return null // a bad range must not widen the audience
    item.minVersion = r.minVersion
  }
  const url = safeUrl(r.url)
  if (url) item.url = url
  if (r.modal === true) item.modal = true
  if (r.draft === true) item.draft = true
  return item
}

export function validateFeed(raw: unknown): NewsItem[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('feed: not an object')
  const r = raw as Record<string, unknown>
  if (r.version !== 1) throw new Error('feed: unsupported version')
  if (!Array.isArray(r.items)) throw new Error('feed: no items')
  const out: NewsItem[] = []
  const ids = new Set<string>()
  for (const it of r.items.slice(0, MAX_ITEMS * 2)) {
    const v = validateItem(it)
    if (!v || ids.has(v.id)) continue
    ids.add(v.id)
    out.push(v)
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

// ---------- feed ----------

type Cache = { fetchedAt: number; attemptAt: number; items: NewsItem[] }

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}
const writeJson = (file: string, v: unknown) => {
  try {
    writeFileSync(file, JSON.stringify(v), { mode: 0o600 })
  } catch {}
}

function localItems(): NewsItem[] {
  try {
    return validateFeed(readJson(LOCAL_FILE))
  } catch {
    return []
  }
}

function readCache(): Cache {
  const c = readJson<Cache>(CACHE_FILE)
  if (!c || !Array.isArray(c.items)) return { fetchedAt: 0, attemptAt: 0, items: [] }
  return { fetchedAt: Number(c.fetchedAt) || 0, attemptAt: Number(c.attemptAt) || 0, items: c.items.map(validateItem).filter((x): x is NewsItem => !!x) }
}

async function fetchRemote(): Promise<NewsItem[]> {
  const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`feed: HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_FEED_BYTES) throw new Error('feed: too large')
  return validateFeed(JSON.parse(text))
}

let inflight: Promise<void> | null = null
/** Refresh the cached remote copy when it is stale; one request at a time, never throws. */
async function refreshRemote() {
  const c = readCache()
  const now = Date.now()
  if (now - c.fetchedAt < TTL_MS || now - c.attemptAt < RETRY_MS) return
  inflight ??= (async () => {
    try {
      writeJson(CACHE_FILE, { fetchedAt: now, attemptAt: now, items: await fetchRemote() } satisfies Cache)
    } catch {
      // offline, a 404 before the public repo exists, or a bad document: keep the last good copy
      writeJson(CACHE_FILE, { ...c, attemptAt: now } satisfies Cache)
    }
  })().finally(() => (inflight = null))
  await inflight
}

/** Items for this build, newest first: remote over local by id, drafts out (unless asked), minVersion checked. */
export async function news(o: { drafts?: boolean } = {}): Promise<NewsItem[]> {
  await refreshRemote()
  const byId = new Map<string, NewsItem>()
  for (const i of localItems()) byId.set(i.id, i)
  for (const i of readCache().items) byId.set(i.id, i)
  return [...byId.values()]
    .filter((i) => (o.drafts || !i.draft) && (!i.minVersion || compareVersions(APP_VERSION, i.minVersion) >= 0))
    .sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date)))
}

// ---------- seen state (this Mac, shared by every tab and the desktop app) ----------

export type Seen = { ids: string[]; modalShown: string[] }

export function getSeen(): Seen {
  const s = readJson<Partial<Seen>>(SEEN_FILE)
  const ids = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string').slice(-MAX_IDS) : [])
  return { ids: ids(s?.ids), modalShown: ids(s?.modalShown) }
}

/** Mark ids as read; `modal` also records that their one-time dialog has been shown. */
export function markSeen(ids: string[], modal = false): Seen {
  const clean = ids.filter((x) => typeof x === 'string' && x.length <= LIMITS.id && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(x)).slice(0, MAX_ITEMS)
  const s = getSeen()
  const next: Seen = {
    ids: [...new Set([...s.ids, ...clean])].slice(-MAX_IDS),
    modalShown: modal ? [...new Set([...s.modalShown, ...clean])].slice(-MAX_IDS) : s.modalShown,
  }
  writeJson(SEEN_FILE, next)
  return next
}
