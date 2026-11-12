// GET /api/search [T1112-18]: conversation hits from src/search.ts joined to the sidebar's rows (running,
// stopped, hidden; older than the sidebar's 7 days too), plus lines from running terminals' and agy's
// screens and scrollback. overvibe search asks screens=agents: a shell's screen can hold a secret (a TOTP code
// was found on one), so agents get agy's screen only, as overvibe tidy leaves shell screens out.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG, DATA_DIR, HOME, inScope, tildify } from './env'
import { createIndex, screenHits, type Role } from './search'
import { projectFor } from './projects'
import { capture } from './tmux'
import { view, type ViewSession } from './sessions'

const index = createIndex({
  claudeRoot: join(HOME, '.claude', 'projects'),
  codexRoot: join(process.env.CODEX_HOME || join(HOME, '.codex'), 'sessions'),
  file: join(DATA_DIR, 'search.json'),
})
let started = false
export function startSearch() {
  if (started) return
  started = true
  index.build().catch((e) => console.log(`[search] ${e?.message ?? e}`))
  setInterval(() => index.save(), 10 * 60_000).unref?.()
}

export type SearchResult = {
  key: string
  sessionId: string | null
  tool: 'claude' | 'codex' | 'agy' | 'shell'
  title: string
  cwd: string
  project: string
  state: 'running' | 'stopped' | 'hidden'
  /** older than the sidebar's 7 days: not in the sidebar, opened from its card */
  old?: boolean
  at: number
  hits: { at: number; role: Role; snippet: string; hl: [number, number][] }[]
  /** a row the page does not list (hidden, or older than 7 days), so it can show its card */
  row?: Partial<ViewSession>
}

// view({ all }) asks `claude agents`; a search while typing reuses one for a few seconds
let rowsCache: { at: number; p: Promise<ViewSession[]> } | null = null
const rows = () => {
  if (!rowsCache || Date.now() - rowsCache.at > 4000) rowsCache = { at: Date.now(), p: view({ all: true }).then((v) => v.sessions) }
  return rowsCache.p
}
const live = (s: ViewSession) => (s.where === 'deck' && !!s.tmux) || s.where === 'terminal' || s.where === 'background'
const JOB_DIRS = (CONFIG.jobFolders ?? []).map((n: string) => `/.${n}/`)
const isJob = (cwd: string) => JOB_DIRS.some((d: string) => (cwd + '/').includes(d))
function hiddenIds(): Record<string, number> {
  try {
    const f = join(DATA_DIR, 'hidden.json')
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
  } catch {
    return {}
  }
}

export async function searchSessions(q: string, o: { limit?: number; screens?: 'all' | 'agents' | 'none'; hidden?: boolean } = {}) {
  const t0 = performance.now()
  const limit = Math.max(1, Math.min(50, o.limit ?? 20))
  const all = await rows()
  const out: SearchResult[] = []
  const bySid = new Map<string, ViewSession[]>()
  for (const s of all) if (s.sessionId) bySid.set(s.sessionId, [...(bySid.get(s.sessionId) ?? []), s])
  const hid = hiddenIds()
  for (const h of index.search(q, { limit: limit * 2 })) {
    const cands = bySid.get(h.sessionId) ?? []
    const r = cands.find(live) ?? cands.find((s) => s.where === 'deck') ?? cands[0]
    const cwd = r?.cwd ?? (h.cwd ? tildify(h.cwd) : '')
    if (!cwd || !inScope(cwd.replace(/^~(?=\/|$)/, HOME)) || (!r && isJob(cwd))) continue
    const hidden = r ? !!(r.hidden || r.closed) : !!hid[h.sessionId]
    const state = r && live(r) ? 'running' : hidden ? 'hidden' : 'stopped'
    if (state === 'hidden' && o.hidden === false) continue
    const title = r?.title ?? h.title ?? h.sessionId.slice(0, 8)
    const project = r?.project ?? projectFor(cwd.replace(/^~(?=\/|$)/, HOME))
    const row: Partial<ViewSession> | undefined = r && !r.hidden && !r.closed ? undefined : r ?? {
      key: h.sessionId, where: 'past', tool: h.tool, status: 'ended', title, cwd, project, account: null, sessionId: h.sessionId, tmux: null, kind: 'claude', last: h.at,
    }
    out.push({ key: r?.key ?? h.sessionId, sessionId: h.sessionId, tool: h.tool, title, cwd, project, state, ...(r ? {} : { old: true }), at: h.at, hits: h.hits.map(({ at, role, snippet, hl }) => ({ at, role, snippet, hl })), ...(row ? { row } : {}) })
  }
  // running terminals and agy: their screen and scrollback (the last 2000 lines)
  if (o.screens !== 'none') {
    const panes = all.filter((s) => s.where === 'deck' && s.tmux && s.status !== 'ended' && ((s.kind === 'shell' && o.screens !== 'agents') || (s.kind === 'claude' && s.tool === 'agy')) && inScope(s.cwd.replace(/^~(?=\/|$)/, HOME))).slice(0, 40)
    const caps = await Promise.all(panes.map((s) => capture(s.tmux!, 2000).catch(() => '')))
    panes.forEach((s, i) => {
      const hits = screenHits(caps[i] ?? '', q)
      if (hits.length) out.push({ key: s.key, sessionId: s.sessionId, tool: s.kind === 'shell' ? 'shell' : 'agy', title: s.title, cwd: s.cwd, project: s.project, state: 'running', at: s.last, hits: hits.map((x) => ({ at: s.last, role: 'screen' as const, snippet: x.snippet, hl: x.hl })) })
    })
  }
  // newest match first; a running session wins a tie
  out.sort((a, b) => b.at - a.at || Number(b.state === 'running') - Number(a.state === 'running'))
  return { results: out.slice(0, limit), ready: index.isReady(), ms: Math.round(performance.now() - t0) }
}
