#!/usr/bin/env bun
// Pre-launch smoke test [T1112-98]: drives the real overvibe CLI (this checkout's bin/overvibe) and the HTTP API of
// the running server (127.0.0.1:7777), starts real Claude, Codex and agy sessions with cheap prompts, checks the
// prompt, name, messages, resume, move, stop, tidy, search, tasks and accounts, then the page in headless
// Playwright. Prints PASS / FAIL / SKIP per check and exits 1 on any FAIL. Rerun it after every change:
//   bun run smoke                 everything (unit tests, typecheck and build too)
//   bun run smoke --quick         skip bun test / typecheck / build
//   bun run smoke --no-page       skip the Playwright part
// Every session it starts is named "smoke <run> ..." (plain ones live in a smoke-* folder), works in
// ~/scratchpad/agent-deck/smoke/<run>/, and is stopped and hidden at the end (never deleted). It never prints
// the login link or the token, and never touches a session it did not start.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const T0 = Date.now()
const ARGS = process.argv.slice(2)
const QUICK = ARGS.includes('--quick')
const NO_PAGE = ARGS.includes('--no-page')
const REPO = resolve(import.meta.dir, '..')
const OV = join(REPO, 'bin', 'overvibe')
const HOME = homedir()
const DATA = process.env.OVERVIBE_DATA_DIR ?? (existsSync(join(HOME, '.config', 'overvibe', 'token')) ? join(HOME, '.config', 'overvibe') : join(HOME, '.config', 'agent-deck'))
const BASE = `http://127.0.0.1:${process.env.OVERVIBE_PORT ?? 7777}`
const TOKEN = readFileSync(join(DATA, 'token'), 'utf8').trim()
const PLAYWRIGHT = process.env.PLAYWRIGHT || 'playwright' // a path to playwright's index.mjs, or the package name when it is installed

const d = new Date()
const pad = (n: number) => String(n).padStart(2, '0')
const RUN = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
const DIR = join(HOME, 'scratchpad', 'agent-deck', 'smoke', RUN)
const tild = (p: string) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p)
// a word nothing else has said, so search finds only this run
const MARK = `zqsmoke${RUN.replace('-', 'x')}`

// ---------- reporting ----------
type State = 'PASS' | 'FAIL' | 'SKIP'
const results: { name: string; state: State; note: string }[] = []
const scrub = (s: string) => s.split(TOKEN).join('<token>')
function report(name: string, state: State, note = '') {
  results.push({ name, state, note: scrub(note) })
  const secs = ((Date.now() - T0) / 1000).toFixed(0).padStart(4)
  console.log(`${state.padEnd(4)} ${secs}s  ${name}${note ? `  (${scrub(note).replace(/\s+/g, ' ').slice(0, 300)})` : ''}`)
}
/** run one check: true or a string note = PASS, false or a thrown error = FAIL, {skip} = SKIP */
async function check(name: string, fn: () => Promise<boolean | string | { skip: string } | { fail: string }>) {
  try {
    const r = await fn()
    if (r && typeof r === 'object' && 'skip' in r) report(name, 'SKIP', r.skip)
    else if (r && typeof r === 'object' && 'fail' in r) report(name, 'FAIL', r.fail)
    else report(name, r === false ? 'FAIL' : 'PASS', typeof r === 'string' ? r : '')
    return r !== false && !(r && typeof r === 'object' && 'fail' in r)
  } catch (e: any) {
    report(name, 'FAIL', String(e?.message ?? e))
    return false
  }
}

// ---------- the CLI, the API, waiting ----------
async function ov(...a: string[]) {
  const p = Bun.spawn(['bun', OV, ...a], { stdout: 'pipe', stderr: 'pipe', cwd: DIR })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, out, err }
}
async function ovOk(...a: string[]) {
  const r = await ov(...a)
  if (r.code !== 0) throw new Error(`overvibe ${a[0]} exited ${r.code}: ${(r.err || r.out).trim().slice(0, 400)}`)
  return r.out
}
async function api(path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { cookie: `deck=${TOKEN}`, origin: BASE, 'content-type': 'application/json' }
  const r = await fetch(BASE + path, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${path}: ${r.status} ${j.error ?? ''}`)
  return j
}
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 120_000, every = 2000): Promise<T | null> {
  const t = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {}
    if (Date.now() - t > ms) return null
    await Bun.sleep(every)
  }
}
async function rows(): Promise<any[]> {
  return (await api('/api/state')).sessions
}
const live = async (tmux: string) => (await rows()).find((s) => s.where === 'deck' && s.tmux === tmux)

// ---------- transcripts ----------
type Log = { users: string[]; assistant: string[] }
function claudeFile(id: string): string | null {
  const roots = [join(HOME, '.claude', 'projects'), ...(existsSync(join(HOME, '.claude-accounts')) ? readdirSync(join(HOME, '.claude-accounts')).map((a) => join(HOME, '.claude-accounts', a, 'projects')) : [])]
  for (const r of roots) {
    if (!existsSync(r)) continue
    for (const dir of readdirSync(r)) if (existsSync(join(r, dir, `${id}.jsonl`))) return join(r, dir, `${id}.jsonl`)
  }
  return null
}
const texts = (c: any): string[] => (typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === 'text' || b?.type === 'input_text' || b?.type === 'output_text').map((b) => String(b.text)) : [])
function claudeLog(id: string): Log | null {
  const f = claudeFile(id)
  if (!f) return null
  const log: Log = { users: [], assistant: [] }
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let j: any
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (j.type === 'user' && !j.isMeta && j.message?.role === 'user') log.users.push(...texts(j.message.content))
    if (j.type === 'assistant') log.assistant.push(...texts(j.message?.content))
  }
  return log
}
function codexFile(id: string): string | null {
  const roots = [join(HOME, '.codex', 'sessions'), ...(existsSync(join(HOME, '.codex-accounts')) ? readdirSync(join(HOME, '.codex-accounts')).map((a) => join(HOME, '.codex-accounts', a, 'sessions')) : [])]
  for (const r of roots) {
    if (!existsSync(r)) continue
    for (const f of new Bun.Glob(`*/*/*/rollout-*${id}.jsonl`).scanSync(r)) return join(r, f)
  }
  return null
}
function codexLog(id: string): Log | null {
  const f = codexFile(id)
  if (!f) return null
  const log: Log = { users: [], assistant: [] }
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let j: any
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    const p = j.payload
    if (j.type === 'response_item' && p?.type === 'message') (p.role === 'user' ? log.users : p.role === 'assistant' ? log.assistant : []).push(...texts(p.content))
  }
  return log
}
const logOf = (s: Sess) => (s.sessionId ? (s.tool === 'codex' ? codexLog(s.sessionId) : s.tool === 'claude' ? claudeLog(s.sessionId) : null) : null)
async function peek(s: Sess, lines = 120) {
  return ovOk('peek', s.tmux, '--lines', String(lines))
}

// ---------- prompts: a small sum, so the answer is not in the question ----------
let seq = 0
function ask(extra = '') {
  const a = 11 + Math.floor(Math.random() * 80) + seq * 100
  const b = 3 + Math.floor(Math.random() * 9)
  seq++
  return { text: `${extra}Reply with only the number that is ${a} plus ${b}, nothing else, and do not run any command (smoke check ${MARK}).`, want: String(a + b) }
}
const answered = (texts: string[], want: string) => texts.some((t) => new RegExp(`(^|\\D)${want}(\\D|$)`).test(t))
/** the answer on screen, on a line that is not the question itself */
const onScreen = (screen: string, want: string) => screen.split('\n').some((l) => !/plus/.test(l) && new RegExp(`(^|\\D)${want}(\\D|$)`).test(l))

// ---------- sessions this run started ----------
type Sess = { label: string; tool: 'claude' | 'codex' | 'agy'; name: string; tmux: string; sessionId: string; cwd: string }
const mine: Sess[] = []
const name = (x: string) => `smoke ${RUN} ${x}`

async function start(label: string, tool: Sess['tool'], o: { name?: string; prompt?: string; cwd?: string; account?: string }): Promise<Sess | null> {
  const cwd = o.cwd ?? DIR
  const a = ['new', '--tool', tool, '--cwd', cwd, ...(o.name ? ['--name', o.name] : []), ...(o.prompt ? ['--prompt', o.prompt] : []), ...(o.account ? ['--account', o.account] : [])]
  let got: Sess | null = null
  await check(`new ${label}: overvibe new starts it`, async () => {
    const out = await ovOk(...a)
    const title = /started "([^"]+)"/.exec(out)?.[1]
    if (!title) return { fail: `no "started" line: ${out.trim()}` }
    // the newest deck row in that folder with that title (a plain one is found by its own folder)
    const row = await until(async () => (await rows()).filter((s) => s.where === 'deck' && s.tmux && s.cwd === tild(cwd) && (s.title === title || !o.name)).sort((x, y) => (y.createdAt ?? y.last) - (x.createdAt ?? x.last))[0], 20_000, 1000)
    if (!row) return { fail: `"${title}" is not in /api/state` }
    got = { label, tool, name: row.title, tmux: row.tmux, sessionId: row.sessionId ?? '', cwd }
    mine.push(got)
    return `"${title}", tmux ${row.tmux}`
  })
  return got
}
/** the conversation id: Claude has it at once; Codex and agy once the deck has read it from the CLI */
async function sessionIdOf(s: Sess, ms = 90_000) {
  if (s.sessionId) return s.sessionId
  const id = await until(async () => (await live(s.tmux))?.sessionId, ms)
  if (id) s.sessionId = id
  return s.sessionId
}

async function stop(s: Sess, label = `stop ${s.label}`) {
  return check(label, async () => {
    const out = await ovOk('stop', s.tmux)
    if (!/stopped|closed/.test(out)) return { fail: out.trim() }
    const gone = await until(async () => !(await live(s.tmux)), 20_000, 1000)
    return gone ? out.trim().split('\n')[0]! : { fail: 'still running 20s after overvibe stop' }
  })
}

// ---------- the checks ----------
function sh(cmd: string[], cwd = REPO) {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(([out, err, code]) => ({ out, err, code }))
}
const tail = (s: string, n = 6) => s.trim().split('\n').slice(-n).join(' | ')

async function main() {
  mkdirSync(DIR, { recursive: true })
  for (const t of ['claude', 'codex', 'agy']) mkdirSync(join(DIR, `smoke-${t}-plain`), { recursive: true })
  mkdirSync(join(DIR, 'moved'), { recursive: true })
  console.log(`overvibe smoke ${RUN} in ${tild(DIR)}\n`)

  // unit tests and typecheck run while the sessions come up
  const unit = QUICK ? null : sh(['bun', 'test', 'src'])
  const types = QUICK ? null : sh(['bun', 'run', 'typecheck'])

  const st = await api('/api/state')
  const claudeAccts = st.accounts.filter((a: any) => a.tool === 'claude' && !a.paused)
  const remoteOff: string[] = st.settings?.remoteOff ?? []
  const rcAcct = claudeAccts.find((a: any) => a.name === 'default' && !remoteOff.includes(a.name)) ?? claudeAccts.find((a: any) => !remoteOff.includes(a.name))
  const used = (a: any) => Math.max(0, ...Object.values(a.windows ?? {}).map((w: any) => Number(w.used) || 0))
  const altAcct = claudeAccts.filter((a: any) => a.name !== rcAcct?.name && used(a) < 95).sort((x: any, y: any) => used(x) - used(y))[0]

  // 1. overvibe new, each tool
  const p1 = ask(), p2 = ask(), p3 = ask()
  const cPlain = await start('claude plain', 'claude', { cwd: join(DIR, 'smoke-claude-plain') })
  const cNamed = await start('claude --name', 'claude', { name: name('claude named') })
  const cRc = rcAcct ? await start('claude Remote Control + --name + --prompt', 'claude', { name: name('claude rc'), prompt: p1.text, account: rcAcct.name }) : null
  if (!rcAcct) report('new claude Remote Control', 'SKIP', 'every Claude account has Remote Control off or is paused')
  const xPlain = await start('codex plain', 'codex', { cwd: join(DIR, 'smoke-codex-plain') })
  const xNamed = await start('codex --name + --prompt', 'codex', { name: name('codex'), prompt: p2.text })
  const gPlain = await start('agy plain', 'agy', { cwd: join(DIR, 'smoke-agy-plain') })
  const gNamed = await start('agy --name + --prompt', 'agy', { name: name('agy'), prompt: p3.text })

  // plain and named ones come up and keep their name
  for (const s of [cPlain, xPlain, gPlain, cNamed]) {
    if (!s) continue
    await check(`new ${s.label}: comes up idle`, async () => {
      // Codex's own update menu ("Update available ... Skip") would hold a prompt-less start; Overvibe starts Codex
      // with check_for_update_on_startup=false [T1112-103], so the menu showing at all is a failure.
      let menu = false
      const r = await until(async () => {
        const scr = await peek(s, 30)
        if (s.tool === 'codex' && /Update available/.test(scr) && /Skip/.test(scr)) return (menu = true)
        return (await live(s.tmux))?.status === 'idle' && scr.split('\n').filter((l) => l.trim()).length > 3
      }, 90_000)
      if (menu) return { fail: "Codex's \"Update available\" menu showed; the launch should turn it off (check_for_update_on_startup=false)" }
      return r ? true : { fail: `status ${(await live(s.tmux))?.status ?? 'gone'} after 90s` }
    })
  }
  if (cNamed) await check('new claude --name: the sidebar name is the --name', async () => ((await live(cNamed.tmux))?.title === name('claude named') ? true : { fail: `title "${(await live(cNamed.tmux))?.title}"` }))

  if (cRc) {
    await check('new claude rc: the --prompt is the first message, the name is not a prompt [T1112-20 regression]', async () => {
      const log = await until(() => {
        const l = claudeLog(cRc.sessionId)
        return l && l.users.length ? l : null
      }, 90_000)
      if (!log) return { fail: 'no transcript with a user message after 90s' }
      if (log.users.some((u) => u.trim() === cRc.name)) return { fail: `the name "${cRc.name}" arrived as a prompt` }
      return log.users[0]!.trim() === p1.text ? true : { fail: `first message: "${log.users[0]!.slice(0, 120)}"` }
    })
    await check('new claude rc: Claude answers the prompt', async () => ((await until(() => answered(claudeLog(cRc.sessionId)?.assistant ?? [], p1.want), 120_000)) ? true : { fail: `no reply with ${p1.want}` }))
    await check('new claude rc: name kept and Remote Control on screen', async () => {
      const row = await live(cRc.tmux)
      if (row?.title !== cRc.name) return { fail: `title "${row?.title}"` }
      const scr = await peek(cRc, 200)
      return /remote[- ]control is active/i.test(scr) ? true : { fail: 'no "/remote-control is active" on its screen' }
    })
  }
  if (xNamed) {
    await check('new codex --prompt: the prompt reached Codex, the name did not', async () => {
      if (!(await sessionIdOf(xNamed))) return { fail: 'no Codex session id after 90s' }
      const log = await until(() => {
        const l = codexLog(xNamed.sessionId)
        return l && l.users.some((u) => u.includes(p2.text)) ? l : null
      }, 90_000)
      if (!log) return { fail: 'the prompt is not in its rollout' }
      return log.users.some((u) => u.trim() === xNamed.name) ? { fail: 'the name arrived as a prompt' } : true
    })
    await check('new codex --prompt: Codex answers it', async () => ((await until(() => answered(codexLog(xNamed.sessionId)?.assistant ?? [], p2.want), 120_000)) ? true : { fail: `no reply with ${p2.want}` }))
    await check('new codex --name: the sidebar name is the --name', async () => ((await live(xNamed.tmux))?.title === name('codex') ? true : { fail: `title "${(await live(xNamed.tmux))?.title}"` }))
  }
  if (gNamed) {
    await check('new agy --prompt: the prompt reached agy and it answered', async () => {
      const ok = await until(async () => {
        const scr = await peek(gNamed, 200)
        return scr.includes(MARK) && onScreen(scr, p3.want)
      }, 150_000, 3000)
      if (ok) return true
      const scr = await peek(gNamed, 200)
      return { fail: scr.includes(MARK) ? `prompt typed, no answer ${p3.want} on screen` : 'the prompt is not on its screen' }
    })
    await check('new agy --name: the sidebar name is the --name', async () => ((await live(gNamed.tmux))?.title === name('agy') ? true : { fail: `title "${(await live(gNamed.tmux))?.title}"` }))
  }

  // 2. stop the plain ones (stop for each tool), ls, peek
  for (const s of [cPlain, xPlain, gPlain]) if (s) await stop(s)
  await check('overvibe ls: lists the running smoke sessions', async () => {
    const out = await ovOk('ls')
    const want = [cNamed, cRc, xNamed, gNamed].filter(Boolean).map((s) => s!.name)
    const miss = want.filter((n) => !out.includes(n.slice(0, 40)))
    const js = JSON.parse(await ovOk('ls', '--json'))
    const missJ = want.filter((n) => !js.some((r: any) => r.title === n))
    return miss.length || missJ.length ? { fail: `missing: ${[...new Set([...miss, ...missJ])].join(', ')}` } : `${want.length} found, --json too`
  })
  if (cRc) await check('overvibe peek: prints its screen', async () => {
    const out = await peek(cRc, 20)
    return out.startsWith(`"${cRc.name}" (claude,`) && out.split('\n').length > 5 ? true : { fail: out.slice(0, 200) }
  })

  // send: Claude through its hook (a system note), Codex and agy typed; a long one to Codex (preview + overvibe read)
  if (cRc) {
    const m = ask()
    await check('send claude: delivered through the hook as an "overvibe message" note, not typed', async () => {
      const out = await ovOk('send', cRc.tmux, m.text)
      if (!/delivered|queued/.test(out)) return { fail: out.trim() }
      const log = await until(() => {
        const l = claudeLog(cRc.sessionId)
        return l && l.users.some((u) => u.includes(m.text)) ? l : null
      }, 90_000)
      if (!log) return { fail: 'the message is not in the transcript after 90s' }
      const u = log.users.find((x) => x.includes(m.text))!
      if (/^\s*\[overvibe message from/.test(u)) return { fail: 'it was typed into the prompt, not handed to the hook' }
      return /<summary>overvibe message<\/summary>/.test(u) ? true : { fail: `arrived as: ${u.slice(0, 120)}` }
    })
    await check('send claude: it answers the message', async () => ((await until(() => answered(claudeLog(cRc.sessionId)?.assistant ?? [], m.want), 120_000)) ? true : { fail: `no reply with ${m.want}` }))
  }
  if (gNamed) {
    const m = ask()
    await check('send agy: typed as an [overvibe message from ...] line, and answered', async () => {
      const out = await ovOk('send', gNamed.tmux, m.text)
      if (!/delivered|queued/.test(out)) return { fail: out.trim() }
      const ok = await until(async () => {
        const scr = await peek(gNamed, 200)
        return /overvibe message from/.test(scr) && scr.includes(m.text.slice(0, 40)) && onScreen(scr.slice(scr.lastIndexOf('overvibe message from')), m.want)
      }, 150_000, 3000)
      if (ok) return true
      const scr = await peek(gNamed, 200)
      return { fail: /overvibe message from/.test(scr) ? `typed, no answer ${m.want}` : 'no "[overvibe message from" line on its screen' }
    })
  }
  if (xNamed) {
    const m = ask()
    const long = `${m.text} ` + 'This sentence is padding so the message is longer than the preview limit and arrives cut, with a command to read the rest. '.repeat(5)
    let id = ''
    await check('send codex long: typed as a preview with "overvibe read <id>"', async () => {
      const out = await ovOk('send', xNamed.tmux, long)
      if (!/delivered|queued/.test(out)) return { fail: out.trim() }
      const msgs = (await api(`/api/peer-messages?with=${encodeURIComponent(xNamed.name)}&limit=10`)).messages
      id = msgs.filter((x: any) => x.text === long.trim()).at(-1)?.id ?? ''
      if (!id) return { fail: 'not in the peer log' }
      const typed = await until(() => {
        const l = codexLog(xNamed.sessionId)
        return l?.users.find((u) => u.includes(`overvibe read ${id}`))
      }, 90_000)
      if (!typed) return { fail: `no typed line with "overvibe read ${id}" in its rollout` }
      return /^\s*\[overvibe message from/.test(typed) && typed.includes(`more characters: run overvibe read ${id}`) && !typed.includes(long.trim()) ? `id ${id}` : { fail: `typed: ${typed.slice(0, 160)}` }
    })
    await check('overvibe read <id>: prints the whole long message', async () => {
      if (!id) return { skip: 'no message id' }
      const out = await ovOk('read', id)
      return out.includes(long.trim()) && /overvibe message from/.test(out) ? true : { fail: out.slice(0, 200) }
    })
    await check('send codex: it answers the long message', async () => ((await until(() => answered(codexLog(xNamed.sessionId)?.assistant.slice(-5) ?? [], m.want), 150_000)) ? true : { fail: `no reply with ${m.want}` }))
  }

  // resume: Claude (named, Remote Control, prompt: the same launch path as the regression) and Codex
  for (const s of [cRc, xNamed]) {
    if (!s) continue
    const m = ask()
    const before = s.sessionId
    if (!(await stop(s, `stop ${s.label} (before resume)`))) continue
    await check(`resume ${s.tool}: same conversation, same name, the --prompt arrives`, async () => {
      const out = await ovOk('resume', s.name, '--prompt', m.text)
      if (!/^resumed/.test(out)) return { fail: out.trim() }
      const row = await until(async () => (await rows()).find((r) => r.where === 'deck' && r.tmux && r.title === s.name), 30_000, 1000)
      if (!row) return { fail: 'not running again' }
      s.tmux = row.tmux
      if (row.sessionId && row.sessionId !== before) return { fail: `new conversation ${row.sessionId}` }
      const got = await until(() => {
        const l = logOf(s)
        return l && l.users.some((u) => u.includes(m.text)) && answered(l.assistant.slice(-3), m.want)
      }, 150_000)
      return got ? true : { fail: `the prompt or its answer ${m.want} is missing` }
    })
  }
  if (gNamed) {
    await check('resume agy', async () => {
      if (!(await sessionIdOf(gNamed, 5000))) return { skip: 'Overvibe has no agy conversation id for it, so it cannot be resumed' }
      const before = gNamed.sessionId
      if (!(await stop(gNamed, 'stop agy (before resume)'))) return { fail: 'could not stop it' }
      const out = await ovOk('resume', gNamed.name)
      if (!/^resumed/.test(out)) return { fail: out.trim() }
      const row = await until(async () => (await rows()).find((r) => r.where === 'deck' && r.tmux && r.title === gNamed.name), 30_000, 1000)
      if (!row) return { fail: 'not running again' }
      gNamed.tmux = row.tmux
      return row.sessionId === before ? true : { fail: `conversation ${row.sessionId} is not ${before}` }
    })
  }

  // move: to another folder (overvibe move), then to another account (never a paused one)
  if (cRc) {
    const to = join(DIR, 'moved')
    await check('overvibe move --to: moves the Claude session to another folder, same conversation', async () => {
      await until(async () => (await live(cRc.tmux))?.status === 'idle', 60_000)
      const out = await ovOk('move', '--to', to, '--session', cRc.tmux)
      if (!/will move/.test(out)) return { fail: out.trim() }
      const row = await until(async () => (await rows()).find((r) => r.where === 'deck' && r.tmux && r.sessionId === cRc.sessionId && r.cwd === tild(to)), 120_000)
      if (!row) return { fail: 'not running in the new folder after 120s' }
      cRc.tmux = row.tmux
      cRc.cwd = to
      return row.title === cRc.name ? true : { fail: `name changed to "${row.title}"` }
    })
    await check('move to another account: same conversation on the other account', async () => {
      if (!altAcct) return { skip: 'no second Claude account that is not paused' }
      await until(async () => (await live(cRc.tmux))?.status === 'idle', 90_000)
      const next = await api(`/api/sessions/${cRc.tmux}/account`, { account: altAcct.name })
      const row = await until(async () => (await rows()).find((r) => r.where === 'deck' && r.tmux === next.tmux && r.status !== 'ended'), 30_000, 1000)
      if (!row) return { fail: 'not running after the switch' }
      cRc.tmux = row.tmux
      if (row.account !== altAcct.name) return { fail: `on ${row.account}` }
      if (row.sessionId !== cRc.sessionId) return { fail: `new conversation ${row.sessionId}` }
      if (row.title !== cRc.name) return { fail: `name changed to "${row.title}"` }
      return `now on ${altAcct.name}`
    })
  }

  // 3. tidy, search, tasks, accounts
  await check('overvibe tidy and GET /api/tidy: list the running smoke sessions', async () => {
    const cli = JSON.parse(await ovOk('tidy', '--json'))
    const http = await api('/api/tidy')
    const want = [cNamed, cRc].filter(Boolean).map((s) => s!.name)
    const miss = want.filter((n) => !cli.sessions.some((x: any) => x.title === n) || !http.sessions.some((x: any) => x.title === n))
    const plain = await ov('tidy')
    if (plain.code !== 0 || !/Done, safe to close/.test(plain.out)) return { fail: 'overvibe tidy (text) did not print its groups' }
    return miss.length ? { fail: `missing ${miss.join(', ')}` } : `${cli.sessions.length} sessions sorted`
  })
  await check('overvibe search and GET /api/search: find this run\'s prompt', async () => {
    const hit = await until(async () => {
      const cli = JSON.parse(await ovOk('search', MARK, '--json'))
      const http = await api(`/api/search?q=${MARK}&limit=20`)
      const titles = cli.map((x: any) => x.title)
      return titles.some((t: string) => t.startsWith(`smoke ${RUN}`)) && http.results.some((x: any) => x.title.startsWith(`smoke ${RUN}`)) ? titles : null
    }, 90_000, 5000)
    return hit ? `${hit.length} sessions` : { fail: 'no smoke session found for the run marker' }
  })
  let taskId = ''
  await check('overvibe tasks id / add / check on a scratch TASKS.md', async () => {
    const id = (await ovOk('tasks', 'id', '--dir', DIR)).trim()
    if (!/^T\d{4}-\d+$/.test(id)) return { fail: `id "${id}"` }
    const tag = cRc?.sessionId.slice(0, 8) ?? cNamed?.sessionId.slice(0, 8) ?? 'abcdef12'
    taskId = (await ovOk('tasks', 'add', `smoke task ${RUN}`, '--dir', DIR, '--session', tag)).trim()
    if (!/^T\d{4}-\d+$/.test(taskId) || taskId === id) return { fail: `add gave "${taskId}" (id gave ${id})` }
    const text = readFileSync(join(DIR, 'TASKS.md'), 'utf8')
    if (!text.includes(`- [ ] ${taskId} `) || !text.includes(`· session ${tag}`)) return { fail: 'the line is not in TASKS.md' }
    const chk = await ovOk('tasks', 'check', '--dir', DIR)
    return /1 open/.test(chk) && /\bok\b/.test(chk) ? `${taskId}` : { fail: chk.trim() }
  })
  await check('overvibe accounts (and --json without folders)', async () => {
    const out = await ovOk('accounts')
    const js = JSON.parse(await ovOk('accounts', '--json'))
    if (!js.accounts?.length || js.accounts.some((a: any) => 'dir' in a)) return { fail: 'bad --json' }
    const names = js.accounts.map((a: any) => a.name)
    return names.every((n: string) => out.includes(n)) ? `${names.length} accounts${altAcct ? '' : '; only one usable Claude account'}` : { fail: 'text and --json disagree' }
  })

  // build checks
  if (unit) await check('bun test src', async () => ((r) => (r.code === 0 ? tail(r.err || r.out, 3) : { fail: tail(r.err + r.out, 12) }))(await unit))
  if (types) await check('bun run typecheck', async () => ((r) => (r.code === 0 ? true : { fail: tail(r.err + r.out, 12) }))(await types))
  if (!QUICK) await check('bun run build', async () => ((r) => (r.code === 0 ? true : { fail: tail(r.err + r.out, 12) }))(await sh(['bun', 'run', 'build'])))

  // 4. the page
  if (NO_PAGE) report('page', 'SKIP', '--no-page')
  else await page(taskId)

  // cleanup: stop and hide every session this run started (Remove means Hide: nothing is deleted)
  for (const s of mine) {
    if (await live(s.tmux)) await stop(s, `cleanup: stop ${s.label}`)
  }
  await check('cleanup: hide every smoke session', async () => {
    const ids = [...new Set(mine.map((s) => s.sessionId).filter((x) => /^[0-9a-f-]{8,36}$/.test(x)))]
    for (const id of ids) await api('/api/hide', { sessionId: id, hide: true })
    const left = (await rows()).filter((r) => r.where === 'deck' && r.tmux && r.title.startsWith(`smoke ${RUN}`))
    const noId = mine.filter((s) => !s.sessionId).map((s) => s.label)
    if (left.length) return { fail: `still running: ${left.map((r) => r.title).join(', ')}` }
    return `${ids.length} hidden${noId.length ? `; no conversation id to hide for ${noId.join(', ')}` : ''}`
  })
}

async function page(taskId: string) {
  let pw: any
  try {
    pw = await import(PLAYWRIGHT)
  } catch {
    return report('page', 'SKIP', `no Playwright at ${PLAYWRIGHT}`)
  }
  const browser = await pw.chromium.launch()
  try {
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    const url = readFileSync(join(DATA, 'login-url'), 'utf8').trim()
    await check('page: logs in and the sidebar loads', async () => {
      await p.goto(url)
      await p.waitForSelector('[data-key]', { timeout: 20_000 })
      return `${await p.locator('[data-key]').count()} rows`
    })
    await check('page: the smoke sessions are in the sidebar', async () => {
      const want = mine.filter((s) => s.name.startsWith('smoke '))
      const running = []
      for (const s of want) if (await live(s.tmux)) running.push(s)
      if (!running.length) return { skip: 'none running' }
      await p.waitForTimeout(1500)
      const miss: string[] = []
      for (const s of running) if (!(await p.locator(`[data-key="${s.tmux}"]`).count())) miss.push(s.name)
      return miss.length ? { fail: `missing ${miss.join(', ')}` } : `${running.length} rows`
    })
    await check('page: ⌘K finds this run\'s prompt inside a session', async () => {
      await p.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
      await p.keyboard.press('Meta+k')
      const box = p.locator('input[placeholder^="Search sessions"]')
      await box.waitFor({ timeout: 5000 })
      await box.fill(MARK)
      const hit = p.locator('text=In sessions')
      await hit.waitFor({ timeout: 20_000 })
      const label = await p.locator('button:has(mark)').first().innerText()
      await p.keyboard.press('Escape')
      return label.includes(`smoke ${RUN}`) ? true : { fail: `first hit: ${label.slice(0, 80)}` }
    })
    await check('page: the follow-up dialog refuses an empty answer', async () => {
      if (!taskId) return { skip: 'no task line was added' }
      const st = await api('/api/state')
      if (st.settings?.tasksView === false) return { skip: 'Settings > Tasks view is off' }
      await p.locator('nav button, button').filter({ hasText: /^\s*Tasks/ }).first().click()
      const sel = p.locator('select').filter({ has: p.locator(`option[value="${tild(join(DIR, 'TASKS.md'))}"]`) })
      await sel.waitFor({ timeout: 15_000 })
      await sel.selectOption(tild(join(DIR, 'TASKS.md')))
      const line = p.locator('div.flex-1', { hasText: `smoke task ${RUN}` }).locator('button.followup').first()
      await line.click()
      const send = p.locator('form button', { hasText: 'Send' })
      await send.waitFor({ timeout: 5000 })
      let posted = 0
      p.on('request', (r: any) => /\/api\/(say|resume|sessions)$/.test(new URL(r.url()).pathname) && r.method() === 'POST' && posted++)
      if (!(await send.isDisabled())) return { fail: 'Send is enabled with an empty answer' }
      await p.locator('[data-followup-answer]').fill('   \n  ')
      if (!(await send.isDisabled())) return { fail: 'Send is enabled with only spaces' }
      await p.keyboard.press('Meta+Enter')
      await p.waitForTimeout(800)
      const open = await p.locator('[data-followup-answer]').count()
      await p.keyboard.press('Escape')
      return open && !posted ? true : { fail: posted ? 'it sent something' : 'the dialog closed on ⌘Enter with no answer' }
    })
  } finally {
    await browser.close()
  }
}

let crashed = ''
try {
  await main()
} catch (e: any) {
  crashed = String(e?.stack ?? e)
  report('smoke script', 'FAIL', `crashed: ${String(e?.message ?? e)}`)
  // never leave a session running: stop what this run started
  for (const s of mine) if (await live(s.tmux).catch(() => null)) await ov('stop', s.tmux)
}
// tick the scratch TASKS.md line: an open one would count in the Tasks view's numbers for good [T1112-127]
try {
  const f = join(DIR, 'TASKS.md')
  if (existsSync(f)) writeFileSync(f, readFileSync(f, 'utf8').replace(/^- \[ \] /gm, '- [x] '))
} catch {}
const n = (s: State) => results.filter((r) => r.state === s).length
const secs = Math.round((Date.now() - T0) / 1000)
console.log(`\n${n('PASS')} passed, ${n('FAIL')} failed, ${n('SKIP')} skipped in ${Math.floor(secs / 60)}m${pad(secs % 60)}s (run ${RUN}, ${tild(DIR)})`)
for (const r of results.filter((x) => x.state === 'FAIL')) console.log(`  FAIL ${r.name}: ${r.note.slice(0, 400)}`)
writeFileSync(join(DIR, 'smoke-results.json'), JSON.stringify({ run: RUN, secs, results, crashed: crashed ? scrub(crashed) : undefined }, null, 2))
process.exit(n('FAIL') ? 1 : 0)
