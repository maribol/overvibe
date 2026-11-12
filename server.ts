// Overvibe: http://127.0.0.1:7777. One page, a JSON API, and a WebSocket per open terminal.
//
// SECURITY. This page is a shell on the owner's computer (Mac, Linux, or Linux in WSL2). Three locks, all required:
//   1. it listens on 127.0.0.1 only;
//   2. every request needs the token (~/.config/overvibe/token), via the cookie that /?token=... sets;
//   3. Host and Origin must be this server, so a web page in another tab (or a DNS-rebinding trick)
//      cannot drive it: browsers send cookies on cross-site WebSocket opens, and CORS does not cover them.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { timingSafeEqual, randomBytes } from 'node:crypto'
import { checkoutOf, makeWorktree, type Worktree } from './src/worktree'
import { checkSender, escapeHeaders, wrap, type Sender } from './src/peer'
import { DATA_DIR, DEMO, HOME, SCOPE, WORK_ROOT, cleanEnv, inScope, tildify, untildify } from './src/env'
import { attachArgv, countSize, listSessions } from './src/tmux'
import { guardedInput } from './src/mouseguard'
import { deckClient, deliverNow, discard, kick as kickQueue, ownerInput, queueView } from './src/sendqueue'
import { checkSpawn, modeOfRecord, recordByProof, ownerSay, findResumable, pastSessions, resumeSession, forget, getRecord, moveLater, moveSession, moveToFolder, sendTo, startShell, preview, startLogin, startSession, stopSession, stopFor, stopFromPage, sharingWith, watchChildren, WATCH_MS, renameSession, focusOn, getFocus, hide, bgCommand, answerPrompt, switchAccount, switchAll, view } from './src/sessions'
import { accountFor, accountsOf, chromeAccountNow, getSettings, isMode, isPaused, modeFor, modeUnsaved, needsChrome, refusePaused, routeFor, ruleFor, setSettings, type Mode } from './src/routing'
import { loadRouter, routerActive } from './src/localrouter'
import { chromeOf, ensureAccount, fullUntil, hasAccounts, keyOf, listAccounts, loginArgv, probe, probeAll, toolStatus, forgetToolStatus, validName, watchLogin, type AccountTool } from './src/accounts'
import { forgetSelfUpdate, forgetUpdate, selfUpdate, selfUpdateCommand } from './src/updates'
import { feedbackEnv, sendFeedback } from './src/feedback'
import { edges, messages, meta as transcriptMeta, pendingAll, start as startTranscripts } from './src/transcripts'
import { extras as setupExtras, installCli, openDesktop } from './src/setup'
import { WORK, checkWorkRoot, makeFolder, saveWorkRoot, searchFolders, typedFolder, workFolders, workRootInfo } from './src/folders'
import { projectFor } from './src/projects'
import { anyTasksFile, tasksFor } from './src/tasks'
import { capMode } from './src/modecap'
// the Tasks view starts on when this Mac already keeps TASKS.md files, else off; stored, so it never flips on its own [T1112-16]
if (getSettings().tasksView === undefined) setSettings({ tasksView: anyTasksFile(WORK_ROOT) })
// auto mode for new sessions: off on a new install, on where Overvibe was already in use; stored at once [T1112-99]
if (modeUnsaved()) setSettings({ permissionMode: getSettings().permissionMode })
import { summary } from './src/summary'
import { searchSessions, startSearch } from './src/searchapi'
import { stats } from './src/stats'
import { tidyReport } from './src/tidyreport'
import { waitFor } from './src/inbox'
import { findLink, openFile, tailOf, wideRoots } from './src/openfile'
import { previewFile } from './src/filepreview'
import { LINKS_FILE, commitsIn, repoInfo, userLinksReport } from './src/linkinfo'
import { codexFile } from './src/codex'
import { contextFor } from './src/contextapi'
import { byId as peerById, read as readPeerLog } from './src/peerlog'
import { MAX_UPLOAD, locate, safeName, saveUpload } from './src/drop'
import { getSeen, markSeen, news } from './src/news'
import { clipboardBytes, clipboardCommand } from './src/platform'
import { pingState, setPing, startUsagePing } from './src/usageping'
import { add as addSkill, importFrom, remove as removeSkill, report as skillsReport, setAlias, setOn, startSkills, sync as syncSkills } from './src/skills'
/** file links this session already found, rel -> real path, for its lifetime (until the server restarts) [T1112-17] */
const linkCache = new Map<string, Map<string, string>>()

const PORT = Number(process.env.DECK_PORT ?? 7777)
/** the sidebar's sessions; with OVERVIBE_SCOPE only those in folders under it */
// Close old sessions, shown in the sidebar too [T1112-4]: the sessions tidyReport calls done (idle 2 h, nothing
// asked, nothing running), refreshed in the background at most once a minute so /api/state stays quick
let tidyDone = new Map<string, string>()
// with the session's last-active time at that read: a hand from before the owner answered (the session moved on since) is dropped [T1112-115]
let tidyOwes = new Map<string, { reason: string; since: number }>()
let tidyAt = 0
let tidyBusy = false
function refreshTidy() {
  if (tidyBusy || Date.now() - tidyAt < 60_000) return
  tidyBusy = true
  scopedView()
    .then(({ sessions }) => tidyReport(sessions))
    .then((r) => {
      tidyDone = new Map(r.sessions.filter((x) => x.verdict === 'done' && !x.pinned).map((x) => [x.key, x.reason]))
      // waiting on the owner without a question on screen (a decision left to them, a step only they can take) [T1112-10]
      tidyOwes = new Map(r.sessions.filter((x) => x.verdict === 'waiting' && !x.prompt && !x.question).map((x) => [x.key, { reason: x.reason, since: x.idleSince }]))
    })
    .catch((e) => console.log(`[tidy] ${e?.message ?? e}`))
    .finally(() => ((tidyAt = Date.now()), (tidyBusy = false)))
}
const owesNow = (s: { key: string; status: string; last: number; queue?: unknown[] }) => {
  const o = tidyOwes.get(s.key)
  return !!o && s.status !== 'busy' && s.status !== 'waiting' && !s.queue?.length && s.last <= o.since + 2000
}
const withQueue = <T extends { where: string; tmux: string | null }>(s: T) => {
  const queue = s.where === 'deck' ? queueView(s.tmux) : undefined
  return queue ? { ...s, queue } : s
}
const scopedView = async (o: { all?: boolean } = {}) => {
  const v = await view(o)
  return SCOPE ? { ...v, sessions: v.sessions.filter((s) => inScope(s.cwd)) } : v
}
/** Open a login terminal for an account and watch it, so the account refreshes itself once the login lands [T1110-84]. */
// the permission mode a new or resumed session may get, capped at its starter's (src/modecap.ts) [T1112-99]
const modeAsked = (asked: unknown, by?: ReturnType<typeof getRecord>) => capMode(asked, by)

async function loginWatched(name: string, tool: AccountTool) {
  const rec = await startLogin(name, loginArgv(tool), tool)
  void watchLogin(name, tool, async () => (await listSessions()).some((x) => x.name === rec.tmux)).catch(() => {})
  return rec
}
const HOST = '127.0.0.1'
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])

const TOKEN_FILE = join(DATA_DIR, 'token')
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(24).toString('hex'), { mode: 0o600 })
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim()

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const cookieToken = (req: Request) => /(?:^|;\s*)deck=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1] ?? ''

function sameSite(req: Request): boolean {
  if (!ALLOWED_HOSTS.has(req.headers.get('host') ?? '')) return false
  const origin = req.headers.get('origin')
  if (req.method === 'GET' && !req.headers.get('upgrade')) return origin === null || ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))
  return origin !== null && ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ''))
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const bad = (msg: string, status = 400) => json({ error: msg }, status)

// the built UI (vite build -> dist/): index.html and hashed files under /assets/
const DIST = resolve(import.meta.dir, 'dist')
function staticFile(pathname: string): string | null {
  if (pathname === '/') return join(DIST, 'index.html')
  if (!/^\/assets\/[\w.-]+$/.test(pathname)) return null
  return join(DIST, pathname)
}

type WsData = { tmux: string; proc?: ReturnType<typeof Bun.spawn>; sized?: boolean; input?: (d: string | Uint8Array) => void }
// GET /api/health names the app on this port (install.sh and overvibe doctor tell an Overvibe server from
// anything else there); no token needed, so it says nothing more
const HEALTH = JSON.stringify({ app: 'overvibe', version: String(JSON.parse(readFileSync(join(import.meta.dir, 'package.json'), 'utf8')).version ?? '') })

// which UI build is on disk: the page reloads itself when this changes
const buildId = () => {
  try {
    return String(statSync(join(import.meta.dir, 'dist', 'index.html')).mtimeMs)
  } catch {
    return ''
  }
}

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  idleTimeout: 120,
  // dropped files that Spotlight can't find are uploaded (POST /api/upload)
  maxRequestBodySize: MAX_UPLOAD + 1024 * 1024,
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (!sameSite(req)) {
      console.warn(`403 ${req.method} ${url.pathname} host=${req.headers.get('host')} origin=${req.headers.get('origin')} via=${req.headers.get('via') ?? ''}`)
      return new Response('forbidden', { status: 403 })
    }
    if (url.pathname === '/api/health' && req.method === 'GET') return new Response(HEALTH, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

    // login: /?token=... sets the cookie and drops the token from the address bar
    const t = url.searchParams.get('token')
    if (t !== null) {
      if (!eq(t, TOKEN)) return new Response('bad token', { status: 401 })
      return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `deck=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` } })
    }
    if (!eq(cookieToken(req), TOKEN)) {
      return new Response(`Overvibe: open the login link in ${tildify(DATA_DIR)}/login-url.`, { status: 401 })
    }

    if (url.pathname === '/pty') {
      const tmux = url.searchParams.get('t') ?? ''
      if (!getRecord(tmux)) return bad('unknown session', 404)
      if (srv.upgrade(req, { data: { tmux } })) return undefined as any
      return bad('upgrade failed')
    }

    const file = req.method === 'GET' ? staticFile(url.pathname) : null
    if (file) {
      if (!existsSync(file)) return new Response(url.pathname === '/' ? 'UI not built: run `bun run build`' : 'not found', { status: 404 })
      const immutable = url.pathname.startsWith('/assets/')
      return new Response(Bun.file(file), { headers: { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store' } })
    }

    try {
      return await api(req, url)
    } catch (e: any) {
      return bad(String(e?.message ?? e))
    }
  },
  // a quiet terminal is not a dead one: long idle limit, and Bun pings to keep it open
  websocket: {
    idleTimeout: 960,
    sendPings: true,
    open(ws) {
      const { tmux } = ws.data
      const proc = Bun.spawn(attachArgv(tmux), {
        env: cleanEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }),
        terminal: {
          cols: 120,
          rows: 40,
          data(_t, d) {
            ws.sendBinary(d)
          },
        },
      })
      ws.data.proc = proc
      deckClient(proc.pid, true)
      proc.exited.then(() => (deckClient(proc.pid, false), ws.close(1000, 'ended')))
    },
    message(ws, msg) {
      const term = (ws.data.proc as any)?.terminal
      if (!term) return
      // the owner's keys: timed per session so `overvibe send` waits for a pause, and held while the deck types [T1110-60];
      // a click never answers a choice menu on the screen (src/mouseguard.ts) [T1111-25]
      const key = (ws.data.input ??= guardedInput(ws.data.tmux, (d) => {
        if (!ownerInput(ws.data.tmux, d, () => term.write(d))) term.write(d)
      }))
      if (typeof msg !== 'string') return key(msg)
      if (msg.startsWith('\x00')) {
        try {
          const m = JSON.parse(msg.slice(1))
          if (m.resize) {
            term.resize(Math.max(20, Math.min(500, m.resize[0] | 0)), Math.max(5, Math.min(200, m.resize[1] | 0)))
            // the first real size: from now on this client counts for the window's size
            if (!ws.data.sized) (ws.data.sized = true), void countSize(ws.data.proc!.pid)
          }
          // a selection the page copied (xterm's own, or OSC 52 from tmux / the agent): onto the system
          // clipboard here, since the browser's clipboard API fails whenever the tab lacks focus (pbcopy on
          // a Mac, clip.exe on WSL, wl-copy/xclip/xsel on Linux; none found means the browser's copy only)
          const clip = typeof m.copy === 'string' && m.copy && m.copy.length <= 1 << 20 ? clipboardCommand() : null
          if (clip) {
            const pb = Bun.spawn(clip, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore', env: cleanEnv({ LANG: 'en_US.UTF-8' }) })
            pb.stdin.write(clipboardBytes(clip, m.copy))
            pb.stdin.end()
          }
        } catch {}
        return
      }
      key(msg)
    },
    close(ws) {
      // detaches the client only; the session keeps running in tmux
      try {
        ws.data.proc?.kill()
      } catch {}
    },
  },
})

/**
 * A file link from a session's screen, found as ⌘-click finds it [T1112-2/8/17]: the folders shown above it
 * (`context`), the session's folders, its transcript, its repo and scratch folders, then a wider search. Finds
 * are kept per session, so a hover and a click on the same link agree [T1112-114].
 */
async function lookLink(tmux: string, raw: string, ctx: unknown, wide: boolean) {
  const rec = tmux ? getRecord(tmux) : undefined
  const pane = rec ? (await listSessions()).find((x) => x.name === rec.tmux) : undefined
  const context = Array.isArray(ctx) ? ctx.filter((c: unknown) => typeof c === 'string').slice(0, 60) : []
  const bases = [pane?.path ?? '', rec?.cwd ?? '']
  const key = rec ? `${rec.tmux}:${rec.sessionId}` : ''
  let cache = key ? linkCache.get(key) : undefined
  if (key && !cache) linkCache.set(key, (cache = new Map()))
  const transcript = rec?.sessionId && rec.kind === 'claude' ? ((rec.tool ?? 'claude') === 'codex' ? codexFile(rec.sessionId) : transcriptMeta(rec.sessionId)?.file) : null
  const found = await findLink(raw.slice(0, 4000), { bases, context, transcript, cache, roots: wide ? wideRoots(bases, WORK_ROOT) : false })
  return { found, cache }
}

async function api(req: Request, url: URL): Promise<Response> {
  const p = url.pathname
  // a dropped file the server could not find on disk: raw bytes, name in x-file-name (URI-encoded)
  if (p === '/api/upload' && req.method === 'POST') {
    let raw = ''
    try {
      raw = decodeURIComponent(req.headers.get('x-file-name') ?? '')
    } catch {}
    const name = safeName(raw)
    if (!name) return bad('bad file name')
    if (Number(req.headers.get('content-length') ?? 0) > MAX_UPLOAD) return bad('file too large (200 MB max)', 413)
    const data = new Uint8Array(await req.arrayBuffer())
    if (data.length > MAX_UPLOAD) return bad('file too large (200 MB max)', 413)
    return json({ path: saveUpload(name, data) })
  }
  const body: any = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  // a call that names the session it comes from (`from`, the CLI's OVERVIBE_SESSION) must carry that
  // session's OVERVIBE_PROOF; a mismatch is refused before any route runs [T1110-78]
  let sender: Sender = 'outside'
  // a call with a session's proof but no OVERVIBE_SESSION still comes from that session [T1112-99]: the caps on what a
  // session may start (auto mode, spawn limits) can't be dodged by unsetting one variable
  const proofOnly = body && typeof body === 'object' && !body.from ? recordByProof(req.headers.get('x-overvibe-proof') ?? '') : undefined
  if (proofOnly) body.from = proofOnly.tmux
  if (body && typeof body === 'object' && body.from) {
    try {
      sender = checkSender(getRecord(String(body.from)), String(body.from), req.headers.get('x-overvibe-proof') ?? '')
    } catch (e: any) {
      console.log(`[peer] refused a call to ${new URL(req.url).pathname} claiming session ${String(body.from).slice(0, 40)}: ${/not an Overvibe/.test(e.message) ? 'unknown session' : 'proof did not match'}`)
      return bad(e.message, e.status ?? 403)
    }
  }

  if (p === '/api/state' && req.method === 'GET') {
    const accounts = listAccounts(undefined, { hidden: getSettings().hiddenAccounts }).map((a) => (DEMO && a.email ? { ...a, email: `${a.name}@example.com` } : a)).map((a) => (a.tool === 'claude' ? { ...a, chrome: chromeOf(a.name) } : a)).map((a) => (isPaused(a.name, a.tool) ? { ...a, paused: true } : a))
    const v = await scopedView()
    refreshTidy()
    return json({ ...v, sessions: v.sessions.map((s) => withQueue(s)).map((s) => (tidyDone.has(s.key) && s.status !== 'busy' && s.status !== 'waiting' ? { ...s, tidy: tidyDone.get(s.key) } : owesNow(s) ? { ...s, owes: tidyOwes.get(s.key)!.reason } : s)), accounts, tools: await toolStatus(), home: tildify(HOME), homeAbs: HOME, settings: getSettings(), chromeAccount: chromeAccountNow(), router: routerActive(), self: selfUpdate(), pending: pendingAll().filter((x) => inScope(x.cwd)), focus: getFocus(), build: buildId() })
  }
  // what Send feedback's "Include version and OS" adds, shown in the dialog before it goes [T1112-120]
  if (p === '/api/feedback/env' && req.method === 'GET') return json(await feedbackEnv())
  if (p === '/api/messages' && req.method === 'GET') {
    return json({ messages: messages(Math.min(400, Number(url.searchParams.get('limit')) || 150)).filter((m) => inScope(m.cwd)) })
  }
  // overvibe messages, Messages > Between agents: the whole log of messages between sessions [T1111-12]
  if (p === '/api/peer-messages' && req.method === 'GET') {
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 200))
    const list = readPeerLog({ with: url.searchParams.get('with') || undefined, limit: SCOPE ? undefined : limit })
    if (!SCOPE) return json({ messages: list })
    // OVERVIBE_SCOPE: only messages that touch a session listed in this instance
    const { sessions } = await scopedView({ all: true })
    const ids = new Set(sessions.flatMap((s) => [s.sessionId, s.key, s.tmux]).filter(Boolean) as string[])
    return json({ messages: list.filter((m) => [m.fromSession, m.toSession, m.fromTmux, m.toTmux].some((x) => x && ids.has(x))).slice(-limit) })
  }
  // a Claude session's wait-message hook waits here for its next message [T1111-24]
  if (p === '/api/inbox/wait' && req.method === 'POST') {
    if (sender !== 'checked') return bad('only an Overvibe session waits for its own messages', 403)
    const tmux = String(body.from)
    const r = waitFor(tmux, req.signal)
    kickQueue(tmux)
    return json(await r)
  }
  // overvibe read <id>: one message whole, with the long peer rule, for a session that got its preview [T1111-22]
  if (p.startsWith('/api/peer-messages/') && req.method === 'GET') {
    const m = peerById(decodeURIComponent(p.slice('/api/peer-messages/'.length)))
    if (!m) return bad('no message with that id (overvibe messages lists them)', 404)
    if (SCOPE) {
      const { sessions } = await scopedView({ all: true })
      const ids = new Set(sessions.flatMap((s) => [s.sessionId, s.key, s.tmux]).filter(Boolean) as string[])
      if (![m.fromSession, m.toSession, m.fromTmux, m.toTmux].some((x) => x && ids.has(x))) return bad('no message with that id (overvibe messages lists them)', 404)
    }
    const sender = m.sender === 'overvibe' ? 'checked' : m.sender
    return json({ message: m, text: wrap({ name: m.from, tool: m.fromTool ?? undefined, sender }, m.text) })
  }
  // the Stats view [T1110-84]: computed here from local data, never sent anywhere
  if (p === '/api/stats' && req.method === 'GET') {
    const { sessions } = await view({ all: true })
    return json(stats(SCOPE ? sessions.filter((s) => inScope(s.cwd)) : sessions, { scoped: !!SCOPE }))
  }
  // Close old sessions and overvibe tidy [T1111-30]: running sessions sorted into done / waiting / unsure; read only
  if (p === '/api/tidy' && req.method === 'GET') {
    const h = Number(url.searchParams.get('hours'))
    const { sessions } = await scopedView()
    return json(await tidyReport(sessions, Number.isFinite(h) && h > 0 ? Math.min(h, 24 * 30) : undefined))
  }
  if (p === '/api/edges' && req.method === 'GET') {
    const days = Math.min(7, Math.max(0.05, Number(url.searchParams.get('days')) || 2))
    const e = edges(Date.now() - days * 86400_000)
    if (!SCOPE) return json(e)
    // OVERVIBE_SCOPE: only messages that touch a session listed in this instance
    const { sessions } = await scopedView()
    const ids = new Set(sessions.flatMap((s) => [s.sessionId, s.key]).filter(Boolean) as string[])
    const names = new Set(sessions.flatMap((s) => [s.title, s.tmux]).filter(Boolean) as string[])
    const keep = e.edges.filter((x) => (x.fromSession && ids.has(x.fromSession)) || (x.toSession && ids.has(x.toSession)) || names.has(x.from) || names.has(x.to))
    const kept = new Set(keep.flatMap((x) => [x.fromSession, x.toSession]).filter(Boolean) as string[])
    return json({ edges: keep, names: Object.fromEntries(Object.entries(e.names).filter(([id]) => kept.has(id))) })
  }
  if (p === '/api/preview' && req.method === 'GET') {
    const t = url.searchParams.get('t') ?? ''
    if (!getRecord(t)) return bad('unknown session', 404)
    return json({ text: await preview(t) })
  }
  if (p === '/api/tasks' && req.method === 'GET') {
    if (getSettings().tasksView === false) return json({ files: [], off: true })
    const { sessions } = await scopedView()
    // the sessions' folders (7 days of past ones) and every folder under the work root, so a project with no
    // recent session still counts (2026-11-12: 31 of 55 files were listed) [T1112-117]
    return json({ files: tasksFor([...new Set(sessions.map((s) => s.cwd))], workFolders()) })
  }
  // what a session's context is made of, from its transcript (overvibe context, the header's Context meter) [T1112-107]
  if (p === '/api/context' && req.method === 'GET') {
    const r = contextFor((await scopedView({ all: true })).sessions, url.searchParams.get('session') ?? '')
    return 'error' in r ? bad(r.error, r.status) : json(r)
  }
  if (p === '/api/summary' && req.method === 'GET') {
    const id = url.searchParams.get('id') ?? ''
    if (!/^[0-9a-f-]{36}$/.test(id)) return bad('bad session id')
    return json(summary(id))
  }
  if (p === '/api/folders' && req.method === 'GET') {
    const q = url.searchParams.get('q') ?? ''
    return json({ root: tildify(WORK), folders: searchFolders(q), typed: typedFolder(q) })
  }
  if (p === '/api/setup' && req.method === 'GET') return json({ ...workRootInfo(), extras: setupExtras() })
  if (p === '/api/setup/tools' && req.method === 'GET') return json({ tools: await toolStatus(true) })
  // the usage ping, on by default [T1110-72, T1112-101]: GET its state, POST { on } to choose
  if (p === '/api/usage-ping') {
    if (req.method === 'GET') return json(pingState())
    if (typeof body.on !== 'boolean') return bad('on: true or false')
    return json(setPing(body.on))
  }
  // What's new: the server reads the public feed (cached, every 6 h at most), so the page talks only to us [T1110-53]
  if (p === '/api/news' && req.method === 'GET') {
    const items = await news({ drafts: url.searchParams.get('drafts') === '1' })
    const s = getSeen()
    return json({ items, seen: s.ids, modalShown: s.modalShown })
  }
  if (p === '/api/ls' && req.method === 'GET') {
    const dir = untildify(url.searchParams.get('path') || '~')
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return bad('not a folder', 404)
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
    return json({ path: tildify(dir), dirs, git: existsSync(join(dir, '.git')), project: projectFor(dir) })
  }
  // ⌘K "In sessions" and overvibe search: text from every conversation and running screen [T1112-18]
  if (p === '/api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').slice(0, 200)
    if (q.trim().length < 2) return json({ results: [], ready: true, ms: 0 })
    return json(await searchSessions(q, { limit: Number(url.searchParams.get('limit')) || 20, screens: (['agents', 'none'] as const).find((x) => x === url.searchParams.get('screens')) ?? 'all', hidden: url.searchParams.get('hidden') !== '0' }))
  }
  // overvibe ls --past: stopped and past sessions (closed children and hidden rows flagged)
  if (p === '/api/past' && req.method === 'GET') {
    return json({ sessions: (await pastSessions()).filter((s) => inScope(s.cwd)) })
  }
  // cross-agent skills: the library, where each skill is linked, clashes, and the CLIs' own skills [T1110-64]
  if (p === '/api/skills' && req.method === 'GET') return json(skillsReport())
  // hovering a file link: what the popover shows, found the same way ⌘-click finds it [T1112-114]
  if (p === '/api/file-preview' && req.method === 'GET') {
    let context: unknown = []
    try {
      context = JSON.parse(url.searchParams.get('context') ?? '[]')
    } catch {}
    try {
      const { found } = await lookLink(url.searchParams.get('session') ?? '', url.searchParams.get('path') ?? '', context, true)
      if ('choices' in found) return json({ missing: true, choices: found.choices })
      return json(await previewFile(found.path))
    } catch (e: any) {
      return json({ missing: /^(no such file|Not found)/.test(e.message), error: e.message })
    }
  }
  // the terminal's link matchers [T1112-137]: the folder's repo (git? GitHub owner/repo?) and the user's links.json
  if (p === '/api/links' && req.method === 'GET') {
    const cwd = untildify(url.searchParams.get('cwd') ?? '')
    const u = userLinksReport()
    return json({ ...repoInfo(cwd), user: u.ok, skipped: u.skipped, file: tildify(LINKS_FILE) })
  }
  // which short shas on screen are commits in the folder's repo, so a hex word is only underlined when it is one
  if (p === '/api/links/commits' && req.method === 'POST') {
    const cwd = untildify(String(body.cwd ?? ''))
    return json({ commits: commitsIn(cwd, Array.isArray(body.shas) ? body.shas.map(String) : []) })
  }
  if (p.startsWith('/api/skills/') && req.method === 'POST') {
    try {
      const name = String(body.name ?? '')
      if (p === '/api/skills/sync') return json(syncSkills())
      if (p === '/api/skills/on') return json(setOn(name, !!body.on))
      if (p === '/api/skills/alias') return json(setAlias(name, String(body.alias ?? ''), body.on !== false))
      if (p === '/api/skills/add') return json(addSkill(String(body.path ?? ''), { tools: Array.isArray(body.tools) ? body.tools.map(String) : undefined, projects: Array.isArray(body.projects) ? body.projects.map(String) : undefined }))
      if (p === '/api/skills/import') {
        if (!['claude', 'codex', 'agy'].includes(body.tool)) return bad('tool: claude, codex or agy')
        return json(importFrom(body.tool, name, !!body.replace))
      }
      if (p === '/api/skills/remove') return json(removeSkill(name, body.purge === true))
    } catch (e: any) {
      return bad(e.message)
    }
    return bad('not found', 404)
  }
  if (req.method !== 'POST') return bad('not found', 404)

  // the setup screen and Settings: the work root, saved to config.json and applied live [T1110-67]
  if (p === '/api/setup/install-cli' || p === '/api/setup/open-desktop') {
    try {
      return json(p === '/api/setup/install-cli' ? await installCli() : await openDesktop())
    } catch (e: any) {
      return bad(e.message)
    }
  }
  if (p === '/api/setup/work-root') {
    const path = String(body.path ?? '')
    try {
      if (body.check) {
        const c = checkWorkRoot(path)
        return json({ cwd: tildify(c.abs), exists: c.exists })
      }
      return json(saveWorkRoot(path, !!body.create))
    } catch (e: any) {
      return bad(e.message)
    }
  }
  if (p === '/api/news/seen') {
    const s = markSeen(Array.isArray(body.ids) ? body.ids.map(String) : [], !!body.modal)
    return json({ seen: s.ids, modalShown: s.modalShown })
  }
  if (p === '/api/sessions') {
    const asked = String(body.account || 'auto')
    if (asked !== 'auto' && asked !== 'default' && !validName(asked)) return bad('bad account')
    // a plain terminal (New session's Terminal, overvibe new --tool shell): the ⌥T shell, with a name [T1110-54]
    const shell = body.tool === 'shell' || body.tool === 'terminal'
    const tool = ['claude', 'codex', 'agy'].includes(body.tool) ? body.tool : 'claude'
    // a new folder only with the explicit flag (Create row, deck new --mkdir); never on typing [T1110-6]
    if (body.mkdir) {
      try {
        body.cwd = makeFolder(String(body.cwd ?? ''))
      } catch (e: any) {
        return bad(e.message)
      }
    }
    const by0 = body.from ? getRecord(String(body.from)) : undefined
    let mode: Mode | undefined
    try {
      mode = modeAsked(body.mode, by0)
    } catch (e: any) {
      return bad(e.message, e.status ?? 400)
    }
    if (shell) {
      // a terminal runs commands with no approval at all, so a session in ask mode can't open one [T1110-85];
      // the session that opens one is recorded as its starter, so it can stop it [T1111-21]
      if (by0 && modeOfRecord(by0) === 'ask') return bad(`"${by0.name}" runs in ask mode; a terminal would run commands without approval, so it can't start one. Ask the owner.`, 403)
      if (body.attach) return bad('--attach is for agent sessions; the session that starts a terminal can still close it with overvibe stop')
      if (body.worktree) return bad('--worktree is for agent sessions')
      return json(await startShell(String(body.cwd ?? '~'), body.prompt ? String(body.prompt).slice(0, 2000) : undefined, body.name ? String(body.name) : undefined, by0))
    }
    // Claude and Codex have accounts (src/accounts.ts); agy has one login
    const route = await routeFor(untildify(String(body.cwd ?? '')), asked, body.chrome === undefined ? undefined : !!body.chrome, tool)
    const account = route.account
    if (route.by === 'router') console.log(`local router chose ${account} for ${tildify(untildify(String(body.cwd ?? '')))}`)
    // a paused account the rules picked was replaced [T1112-11]; the CLI prints it, the New session dialog shows it
    const pausedNote = route.note
    // deck new from inside a deck session: remember who started it; --attach nests it under them [T1110-44]
    const by = body.from ? getRecord(String(body.from)) : undefined
    if (body.attach && !by) return bad('--attach needs to run inside an Overvibe session (no OVERVIBE_SESSION)')
    const links = by ? { parent: by.tmux, parentId: by.sessionId || undefined, attached: !!body.attach } : {}
    // spawn limits, for sessions started by sessions (the owner's own starts are never capped) [T1110-81]
    if (by) {
      try {
        await checkSpawn(by, getSettings().spawnLimits)
      } catch (e: any) {
        return bad(e.message, 429)
      }
    }
    // overvibe new --skill <name>: library skills the new session gets in its folder [T1110-64]
    const skills = Array.isArray(body.skills) ? body.skills.map(String).filter((x: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(x)) : undefined
    if (Array.isArray(body.skills) && skills!.length !== body.skills.length) return bad('--skill: a skill name (lowercase letters, digits, dashes)')
    // other live agents in the same checkout: the CLI and the page say so and point at --worktree [T1111-10]
    const sharing = body.worktree ? [] : await sharingWith(String(body.cwd ?? ''))
    // --worktree: its own git worktree on a new branch ov/<name> from HEAD, after the limits pass [T1110-79]
    let worktree: Worktree | undefined
    if (body.worktree) {
      try {
        const w = makeWorktree(untildify(String(body.cwd ?? '')), body.name ? String(body.name) : undefined)
        body.cwd = w.cwd
        worktree = w.worktree
      } catch (e: any) {
        return bad(e.message)
      }
    }
    try {
      // a first message from another session: no header lookalikes in it [T1110-78]
      const prompt = by && body.prompt ? escapeHeaders(String(body.prompt)) : body.prompt
      // resuming a hidden row (a search hit opens one) brings it back, as overvibe resume does [T1112-18]
      if (typeof body.resume === 'string' && /^[0-9a-f-]{8,36}$/.test(body.resume) && !body.fork) hide(body.resume, false)
      const rec = await startSession({ tool, cwd: String(body.cwd ?? ''), account, name: body.name, prompt, resume: body.resume, fork: !!body.fork, skills, worktree, mode, ...links })
      // --chrome: say which account the extension is paired with when this one is not it [T1111-26]
      const chromeAt = body.chrome && tool === 'claude' ? chromeAccountNow() : undefined
      const full = chromeAt && chromeAt === account ? fullUntil(listAccounts('claude', { all: true }).find((a) => a.name === account)) : null
      const resets = full && Number.isFinite(full) ? ` (resets ${new Date(full).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })})` : ''
      const chromeNote = full ? `${account} is the account paired with Claude in Chrome, and its usage is used up${resets}: this session may stop at its first reply. Ask the owner to sign the extension in to another account, or wait` : chromeAt === null ? 'no Claude account is paired with Claude in Chrome, so the browser tools may not connect (overvibe accounts shows each account)' : chromeAt && chromeAt !== account ? `Claude in Chrome is paired with ${chromeAt}, not ${account}: the browser tools may not connect (leave out --account, or use --account ${chromeAt})` : undefined
      return json({ ...rec, sharing: sharing.map((x) => x.title), ...(chromeNote ? { chromeNote } : {}), ...(pausedNote ? { pausedNote } : {}) })
    } catch (e: any) {
      if (/^no skill /.test(e.message)) return bad(e.message)
      throw e
    }
  }
  // overvibe resume: the same conversation as a live session again, in its folder, name and row [T1110-57]
  if (p === '/api/resume') {
    const asked = String(body.account || 'auto')
    if (asked !== 'auto' && asked !== 'default' && !validName(asked)) return bad('bad account')
    try {
      const { row, rec } = await findResumable(String(body.target ?? '').slice(0, 200), !!body.fork)
      const tool = row.tool ?? 'claude'
      if (body.fork && tool !== 'claude') return bad('--fork is for Claude sessions only')
      const by = body.from ? getRecord(String(body.from)) : undefined
      if (body.attach && !by) return bad('--attach needs to run inside an Overvibe session (no OVERVIBE_SESSION)')
      // --attach: a child of the caller; otherwise it keeps the parent it had (a stopped attached child re-attaches)
      const links = body.attach && by ? { parent: by.tmux, parentId: by.sessionId || undefined, attached: true } : undefined
      if (body.attach && by) await checkSpawn(by, getSettings().spawnLimits) // [T1110-81]
      const mode = modeAsked(body.mode, by) // [T1110-85]
      // its own account again, unless that one is paused: then it is routed like a new session, and says so [T1112-11]
      const keep = asked === 'auto' && rec?.account && hasAccounts(tool) && !isPaused(rec.account, tool) ? rec.account : null
      const route = hasAccounts(tool) && !keep ? await routeFor(untildify(row.cwd), asked, undefined, tool) : null
      const account = keep ?? route?.account ?? ''
      const pausedNote = route && asked === 'auto' && rec?.account ? `${rec.account} (the account this session ran on) is paused, so it resumes on ${account}` : route?.note
      // --prompt from another session is a peer's note, so it gets the server's header like overvibe send [T1110-78]
      const prompt = body.prompt ? (by ? wrap({ name: by.name, tool: by.tool ?? 'claude', sender, kind: 'resume note' }, String(body.prompt)) : String(body.prompt)) : undefined
      const next = await resumeSession({ row, rec, account, prompt, fork: !!body.fork, links, mode })
      return json({ ...next, tool, title: row.title, fork: !!body.fork, ...(pausedNote ? { pausedNote } : {}) })
    } catch (e: any) {
      return bad(e.message, e.status ?? 400)
    }
  }
  if (p === '/api/stop') {
    try {
      return json(await stopFor({ session: body.session ? String(body.session).slice(0, 200) : undefined, children: !!body.children, from: String(body.from ?? '') }))
    } catch (e: any) {
      return bad(e.message)
    }
  }
  if (p === '/api/sessions/move') {
    const asked = String(body.account || 'auto')
    if (asked !== 'auto' && asked !== 'default' && !validName(asked)) return bad('bad account')
    const account = await accountFor(untildify(String(body.cwd ?? '~')), asked)
    if (!/^[0-9a-f-]{36}$/.test(String(body.sessionId))) return bad('bad session id')
    return json(await moveSession(String(body.sessionId), account))
  }
  if (p === '/api/focus') {
    const session = String(body.session ?? '').trim()
    if (!session) return bad('need session')
    return json(await focusOn(session.slice(0, 200), String(body.from ?? '')))
  }
  // a message waiting for a busy session (`overvibe send`): the owner delivers it now or discards it
  if (p === '/api/send/deliver') return json({ ok: true, ...(await deliverNow(String(body.id ?? ''))) })
  if (p === '/api/send/discard') return json((discard(String(body.id ?? '')), { ok: true }))
  if (p === '/api/send') {
    const text = String(body.text ?? '').trim()
    if (!text || !body.to) return bad('need to and text')
    return json(await sendTo(String(body.to), text.slice(0, 8000), String(body.from ?? ''), sender))
  }
  // Tasks > Follow up with agent [T1112-14]: the owner's own words into a running session, no header. Only the
  // page asks: a request from a session (from, or its proof header) goes through overvibe send instead.
  if (p === '/api/say') {
    if (body.from || req.headers.get('x-overvibe-proof')) return bad('sessions message each other with overvibe send', 403)
    const text = String(body.text ?? '').trim()
    if (!text || !body.to) return bad('need to and text')
    // refused whole rather than cut: the owner's message arrives exactly as written or not at all [T1112-92]
    if (text.length > 8000) return bad(`that message is ${text.length} characters; 8000 is the most that can be typed in`)
    try {
      return json(await ownerSay(String(body.to), text))
    } catch (e: any) {
      return bad(e.message)
    }
  }
  if (p === '/api/locate') {
    return json({ path: await locate({ name: String(body.name ?? ''), size: Number(body.size), lastModified: Number(body.lastModified) }) })
  }
  // Update a CLI [T1112-103]: its own update command in a terminal row the owner watches. The command comes from the
  // server's own check, never from the page; nothing updates without this click.
  if (p === '/api/tools/update') {
    const t = (await toolStatus()).find((x) => x.tool === body.tool)
    if (!t?.update) return bad('no update to run for that tool')
    const rec = await startShell('~', t.update.cmd, `update: ${t.tool === 'codex' ? 'Codex' : 'Claude Code'} ${t.update.latest}`)
    forgetUpdate(t.tool as 'claude' | 'codex')
    for (const ms of [60_000, 180_000]) setTimeout(forgetToolStatus, ms)
    return json(rec)
  }
  // Update Overvibe itself [T1112-119]: `overvibe update` in a terminal row; the row lives in tmux, so it keeps going
  // while the server restarts, and the page reloads once the new build answers. A clone run by hand never updates here.
  if (p === '/api/self/update') {
    const u = selfUpdate()
    if (!u) return bad('Overvibe is up to date')
    if (u.mode !== 'installed') return bad(`this Overvibe runs from a checkout you run yourself; update it with: ${u.cmd}`)
    const rec = await startShell('~', selfUpdateCommand(), `update: Overvibe ${u.latest}`)
    forgetSelfUpdate()
    return json(rec)
  }
  // Send feedback [T1112-120]: the page's dialog posts here, and the server sends it on to overvibe.dev
  if (p === '/api/feedback') return json(await sendFeedback(body))
  if (p === '/api/shell') {
    return json(await startShell(String(body.cwd ?? '~'), body.cmd ? String(body.cmd).slice(0, 2000) : undefined, body.name ? String(body.name) : undefined))
  }
  if (p === '/api/sessions/move-folder') {
    if (!/^[0-9a-f-]{36}$/.test(String(body.sessionId))) return bad('bad session id')
    const to = untildify(String(body.cwd ?? ''))
    if (!to.startsWith(HOME + '/')) return bad('folder must be under your home folder')
    const asked = String(body.account || 'auto')
    if (asked !== 'auto' && asked !== 'default' && !validName(asked)) return bad('bad account')
    return json(await moveToFolder(String(body.sessionId), to, await accountFor(to, asked)))
  }
  if (p === '/api/sessions/move-later') {
    const to = untildify(String(body.cwd ?? ''))
    if (!to.startsWith(HOME + '/')) return bad('folder must be under your home folder')
    if (!body.session) return bad('need session')
    return json(await moveLater(String(body.session), to, String(body.from ?? '')))
  }
  const sw = /^\/api\/sessions\/([a-z0-9]+)\/account$/.exec(p)
  if (sw) {
    const account = String(body.account ?? '')
    if (!listAccounts('claude').some((a) => a.name === account)) return bad('unknown account')
    refusePaused(account) // [T1112-11]
    return json(await switchAccount(sw[1]!, account))
  }
  if (p === '/api/accounts/switch-all') {
    const account = String(body.account ?? '')
    if (!listAccounts('claude').some((a) => a.name === account)) return bad('unknown account')
    refusePaused(account) // [T1112-11]
    return json(await switchAll(account, body.under ? untildify(String(body.under)) : undefined))
  }
  if (p === '/api/settings') {
    // tool: which tool's rules a defaultAccount / project change is for (Claude when absent)
    const ruleTool: AccountTool = body.tool === 'codex' ? 'codex' : 'claude'
    const names = new Set(['auto', ...accountsOf(ruleTool).map((a) => a.name)])
    const next: any = {}
    if (body.defaultAccount !== undefined) {
      if (!names.has(String(body.defaultAccount))) return bad('unknown account')
      if (ruleTool === 'codex') next.codex = { ...(next.codex ?? {}), defaultAccount: String(body.defaultAccount) }
      else next.defaultAccount = String(body.defaultAccount)
    }
    // Remove account = hide it (its folder and login stay on disk); { key: "name" | "codex:name", hidden }
    if (body.hideAccount) {
      const t: AccountTool = body.hideAccount.tool === 'codex' ? 'codex' : 'claude'
      const n = String(body.hideAccount.name ?? '')
      if (n === 'default' || !listAccounts(t, { all: true }).some((a) => a.name === n)) return bad('unknown account')
      const k = keyOf(n, t)
      const cur = (getSettings().hiddenAccounts ?? []).filter((x) => x !== k)
      next.hiddenAccounts = body.hideAccount.hidden === false ? cur : [...cur, k]
    }
    // Pause an account [T1112-11]: { pauseAccount: { name, tool, paused } }; nothing new runs on it, running sessions keep running
    if (body.pauseAccount) {
      const t: AccountTool = body.pauseAccount.tool === 'codex' ? 'codex' : 'claude'
      const n = String(body.pauseAccount.name ?? '')
      if (!listAccounts(t, { all: true }).some((a) => a.name === n)) return bad('unknown account')
      const k = keyOf(n, t)
      const cur = (getSettings().pausedAccounts ?? []).filter((x) => x !== k)
      next.pausedAccounts = body.pauseAccount.paused === false ? cur : [...cur, k]
    }
    // Remote Control per Claude account: { remoteControl: { name, on } }; applies to sessions started after
    if (body.remoteControl) {
      const n = String(body.remoteControl.name ?? '')
      if (!listAccounts('claude', { all: true }).some((a) => a.name === n)) return bad('unknown account')
      const cur = (getSettings().remoteOff ?? []).filter((x) => x !== n)
      next.remoteOff = body.remoteControl.on === false ? [...cur, n] : cur
    }
    // Settings > Spawn limits [T1110-81]: whole numbers, depth 1-10, children 1-50
    if (body.spawnLimits !== undefined) {
      const d = Number(body.spawnLimits?.maxDepth ?? getSettings().spawnLimits.maxDepth)
      const c = Number(body.spawnLimits?.maxChildren ?? getSettings().spawnLimits.maxChildren)
      if (!Number.isInteger(d) || d < 1 || d > 10) return bad('nesting depth: a whole number from 1 to 10')
      if (!Number.isInteger(c) || c < 1 || c > 50) return bad('children per session: a whole number from 1 to 50')
      next.spawnLimits = { maxDepth: d, maxChildren: c }
    }
    if (body.tasksView !== undefined) next.tasksView = !!body.tasksView // [T1112-16]
    // Settings > Sidebar [T1112-138]: the account usage rows on or off, and projects or newest at the top
    if (body.sidebarAccounts !== undefined) next.sidebarAccounts = !!body.sidebarAccounts
    if (body.sidebarOrder !== undefined) {
      if (body.sidebarOrder !== 'project' && body.sidebarOrder !== 'newest') return bad('sidebar order: project or newest')
      next.sidebarOrder = body.sidebarOrder
    }
    if (body.chromeAccount !== undefined) {
      if (body.chromeAccount && !names.has(String(body.chromeAccount))) return bad('unknown account')
      next.chromeAccount = body.chromeAccount ? String(body.chromeAccount) : null
    }
    // permission mode [T1110-85]: the default for new sessions, and per-folder overrides ({ cwd, mode: ask|auto|null })
    if (body.permissionMode !== undefined) {
      if (!isMode(body.permissionMode)) return bad('permission mode: ask or auto')
      next.permissionMode = body.permissionMode
    }
    if (body.modeProject) {
      const dir = untildify(String(body.modeProject.cwd ?? ''))
      if (!dir.startsWith(HOME + '/')) return bad('folder must be under your home folder')
      const m = body.modeProject.mode
      if (m !== null && m !== '' && !isMode(m)) return bad('permission mode: ask, auto or none')
      next.modeProjects = { [dir]: (isMode(m) ? m : '') as Mode }
    }
    if (body.chromeProject) {
      const dir = untildify(String(body.chromeProject.cwd ?? ''))
      if (!dir.startsWith(HOME + '/')) return bad('folder must be under your home folder')
      next.chromeProjects = { [dir]: !!body.chromeProject.on }
    }
    if (body.projectOrder !== undefined) {
      if (!Array.isArray(body.projectOrder) || body.projectOrder.length > 1000) return bad('projectOrder must be a list')
      next.projectOrder = [...new Set(body.projectOrder.map((x: unknown) => String(x).slice(0, 200)).filter(Boolean))]
    }
    // new projects are appended here, against the saved list, so a tab with a stale copy never undoes a reorder
    if (body.projectAppend !== undefined) {
      if (!Array.isArray(body.projectAppend) || body.projectAppend.length > 1000) return bad('projectAppend must be a list')
      const cur = next.projectOrder ?? getSettings().projectOrder ?? []
      const have = new Set(cur)
      const add = [...new Set(body.projectAppend.map((x: unknown) => String(x).slice(0, 200)).filter((x: string) => x && !have.has(x)))]
      if (add.length) next.projectOrder = [...add, ...cur] // a new project goes to the top; existing ones never move
    }
    // one pin on or off, applied to the saved list so two tabs pinning at once never drop each other's pin
    if (body.pin !== undefined) {
      const id = String(body.pin?.id ?? '').slice(0, 200)
      if (!id) return bad('pin needs an id')
      const cur = (getSettings().pins ?? []).filter((x) => x !== id)
      next.pins = body.pin.on ? [...cur, id].slice(-200) : cur
    }
    if (body.project) {
      const dir = untildify(String(body.project.cwd ?? ''))
      const acc = body.project.account ? String(body.project.account) : ''
      if (!dir.startsWith(HOME + '/')) return bad('folder must be under your home folder')
      if (acc && !names.has(acc)) return bad('unknown account')
      if (ruleTool === 'codex') next.codex = { ...(next.codex ?? {}), projects: { [dir]: acc } }
      else next.projects = { [dir]: acc }
    }
    // one folder's project name ('' clears it)
    if (body.projectName) {
      const dir = untildify(String(body.projectName.cwd ?? '')).replace(/\/+$/, '')
      if (!dir.startsWith(HOME + '/')) return bad('folder must be under your home folder')
      next.projectNames = { [dir]: String(body.projectName.name ?? '').trim().slice(0, 80) }
    }
    setSettings(next)
    return json(getSettings())
  }
  if (p === '/api/rule') {
    const cwd = untildify(String(body.cwd ?? '~'))
    const m = modeFor(cwd)
    // sharing / repo: New session warns when another live agent works in this checkout and offers a worktree [T1111-10]
    const sharing = body.sharing ? (await sharingWith(cwd)).map((x) => x.title) : undefined
    return json({ ...ruleFor(cwd, body.tool === 'codex' ? 'codex' : 'claude'), chrome: needsChrome(cwd), mode: m.mode, modeFrom: m.from, ...(body.sharing ? { sharing, repo: !!checkoutOf(cwd) } : {}) })
  }
  const bgm = /^\/api\/bg\/([0-9a-f-]{8,36})\/(stop)$/.exec(p)
  if (bgm) {
    try {
      return json({ ok: true, out: await bgCommand(bgm[1]!, 'stop') })
    } catch (e: any) {
      return bad(e.message)
    }
  }
  // ⌘-click on a file path in a terminal: open it on this computer (Chrome on a Mac) [T1112-2]
  if (p === '/api/open-file' && req.method === 'POST') {
    try {
      const { found, cache } = await lookLink(String(body.tmux ?? ''), String(body.path ?? ''), body.context, body.wide !== false)
      if ('choices' in found) return json({ ok: true, choices: found.choices })
      // a pick from the choices: that path, kept for the link's own text
      if (typeof body.as === 'string' && cache) cache.set(tailOf(body.as), found.path)
      if (body.dryRun !== true) await openFile(found.path, body.how === 'reveal' ? 'reveal' : 'open')
      return json({ ok: true, path: found.path, step: found.step, dryRun: body.dryRun === true || undefined })
    } catch (e: any) {
      return bad(e.message)
    }
  }
  if (p === '/api/hide') {
    const id = String(body.sessionId ?? '')
    if (!/^[0-9a-f-]{8,36}$/.test(id)) return bad('sessionId')
    hide(id, body.hide !== false)
    return json({ ok: true })
  }
  const ans = /^\/api\/sessions\/([a-z0-9]+)\/answer$/.exec(p)
  if (ans) {
    try {
      await answerPrompt(ans[1]!, String(body.sig ?? ''), Number(body.index), typeof body.text === 'string' ? body.text.slice(0, 2000) : undefined)
      return json({ ok: true })
    } catch (e: any) {
      return bad(e.message)
    }
  }
  const rn = /^\/api\/sessions\/([a-z0-9]+)\/rename$/.exec(p)
  if (rn) {
    try {
      await renameSession(rn[1]!, String(body.name ?? ''))
      return json({ ok: true })
    } catch (e: any) {
      return bad(e.message)
    }
  }
  const m = /^\/api\/sessions\/([a-z0-9]+)\/(stop|forget)$/.exec(p)
  if (m) {
    if (!getRecord(m[1]!)) return bad('unknown session', 404)
    if (m[2] === 'stop') await stopFromPage(m[1]!)
    else forget(m[1]!)
    return json({ ok: true })
  }
  // tool: claude (default) or codex; agy has one login and no accounts
  if (p === '/api/accounts') {
    if (body.tool === 'agy') return bad('agy uses one login: it keeps one Google sign-in of its own and has no setting for another config folder')
    const tool: AccountTool = body.tool === 'codex' ? 'codex' : 'claude'
    const name = String(body.name ?? '').trim().toLowerCase()
    if (!validName(name) || name === 'default') return bad('name: lowercase letters, digits and dashes')
    // an account the owner hid comes back when added again
    const k = keyOf(name, tool)
    if (getSettings().hiddenAccounts?.includes(k)) setSettings({ hiddenAccounts: getSettings().hiddenAccounts.filter((x) => x !== k) })
    ensureAccount(name, tool)
    return json(await loginWatched(name, tool))
  }
  const a = /^\/api\/accounts\/([a-z0-9-]+)\/(probe|login)$/.exec(p)
  if (a) {
    const name = a[1]!
    const tool: AccountTool = body.tool === 'codex' ? 'codex' : 'claude'
    if (!listAccounts(tool, { all: true }).some((x) => x.name === name)) return bad('unknown account', 404)
    if (a[2] === 'probe') return json(await probe(name, tool))
    return json(await loginWatched(name, tool))
  }
  return bad('not found', 404)
}

startTranscripts()
startSearch() // [T1112-18]
startSkills() // sync the skills library into each CLI now and on every change [T1110-64]
startUsagePing() // on by default, at most once a day, waits for setup's Welcome step [T1110-72, T1112-101]

// keepalive: touch every account now and every 3 hours, so no login sits unused long enough to expire
const KEEPALIVE_MS = 3 * 60 * 60 * 1000
setTimeout(() => probeAll(getSettings().hiddenAccounts).catch(() => {}), 5_000)
setInterval(() => probeAll(getSettings().hiddenAccounts).catch(() => {}), KEEPALIVE_MS)
// a coordinator hears when a session it started ends on its own, hits a limit or waits on an answer [T1111-11]
setInterval(() => watchChildren().catch((e) => console.log(`[watch] ${e?.message ?? e}`)), WATCH_MS)

// the login link holds the token: keep it in a private file, never in the log
const LOGIN = join(DATA_DIR, 'login-url')
writeFileSync(LOGIN, `http://${HOST}:${server.port}/?token=${TOKEN}\n`, { mode: 0o600 })
console.log(`Overvibe on http://${HOST}:${server.port} (login link in ${tildify(LOGIN)})`)
loadRouter() // a local router file, if there is one, logs one line when it loads
