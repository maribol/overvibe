// Task keeping for agents [T1112-15]: `overvibe tasks id|add|check` on a project's TASKS.md, the same format
// src/tasks.ts reads for the Tasks view and the bundled "tasks" skill describes:
//   ## Waiting on the owner / ## To do / ## Done (ticked lines under "### <date>")
//   - [ ] T1112-15 2026-11-12 <what> · session <first 8 of the session id>
// Ids are T<MMDD>-<n>: the highest n for today in the file, in recent git subjects and in the ids already handed
// out today + 1. Handed-out ids are kept per repo and day under Overvibe's data dir, and also in tasks-doctor's
// state folder when that exists (~/.local/state/tasks-doctor, same key), so both tools never give out one id twice.
// Kept free of src/env.ts so bin/overvibe can load it without the server's setup.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const SECTIONS = { waiting: '## Waiting on the owner', todo: '## To do', done: '## Done' } as const
export const SKELETON = `# TASKS\n\n${SECTIONS.waiting}\n\n${SECTIONS.todo}\n\n${SECTIONS.done}\n`
/** lines dated before this come from before ids existed and are not flagged for having none (tasks-doctor's rule) */
const CUTOVER = '2026-10-23'
const ID = /\bT(\d{4})-(\d+)\b/g
const CHECK_WORDS = /test|flow|prod|live|screenshot|curl|200|pass|verified|checked|probe|read/i

const pad = (n: number) => String(n).padStart(2, '0')
export const dayOf = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const prefixOf = (d = new Date()) => `${pad(d.getMonth() + 1)}${pad(d.getDate())}`

function git(dir: string, ...args: string[]): string {
  try {
    const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'ignore' })
    return r.exitCode === 0 ? r.stdout.toString() : ''
  } catch {
    return ''
  }
}

/**
 * The project's TASKS.md: at the git repo's top (a worktree is its own checkout), else in the folder itself; a
 * deck.json there with "tasks" names another file, as for the Tasks view (src/tasks.ts).
 */
export function tasksPath(dir: string): string {
  const top = git(dir, 'rev-parse', '--show-toplevel').trim() || resolve(dir)
  try {
    const t = JSON.parse(readFileSync(join(top, 'deck.json'), 'utf8'))?.tasks
    if (typeof t === 'string' && t.trim() && !t.split('/').includes('..')) return join(top, t)
  } catch {}
  return join(top, 'TASKS.md')
}

/** Ids numbered for this day prefix (e.g. "1112") anywhere in the text. */
export function usedNumbers(text: string, prefix: string): number[] {
  return [...text.matchAll(ID)].filter((m) => m[1] === prefix).map((m) => Number(m[2]))
}

/** The next free number: one above every number already used. */
export const nextNumber = (...used: number[][]) => Math.max(0, ...used.flat()) + 1

/** Where handed-out ids are recorded: Overvibe's own folder, plus tasks-doctor's if it is installed. */
export const TASKS_DOCTOR_STATE = join(homedir(), '.local', 'state', 'tasks-doctor')
function idFiles(dir: string, prefix: string, dataDir: string, tdState: string | null): string[] {
  const common = git(dir, 'rev-parse', '--git-common-dir').trim()
  const repo = common ? resolve(dir, common) : resolve(dir)
  let real = repo
  try {
    real = realpathSync(repo)
  } catch {}
  const key = createHash('sha1').update(real).digest('hex').slice(0, 10)
  const own = join(dataDir, 'task-ids')
  mkdirSync(own, { recursive: true })
  const files = [join(own, `${key}-${prefix}.ids`)]
  if (tdState && existsSync(tdState)) files.push(join(tdState, `${key}-${prefix}.ids`))
  return files
}

/** Hold a lock folder while fn runs, so two sessions asking at once get different ids. */
function locked<T>(lock: string, fn: () => T): T {
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock)
      break
    } catch {
      // a lock left by a crashed call is stale after 10 s
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmdirSync(lock)
      } catch {}
      if (i > 200) throw new Error(`could not take the task id lock ${lock}`)
      Bun.sleepSync(25)
    }
  }
  try {
    return fn()
  } finally {
    try {
      rmdirSync(lock)
    } catch {}
  }
}

/** Hand out the next free id for today in this folder's repo, and record it. */
export function allocateId(dir: string, dataDir: string, now = new Date(), tdState: string | null = TASKS_DOCTOR_STATE): string {
  const prefix = prefixOf(now)
  const file = tasksPath(dir)
  const files = idFiles(dir, prefix, dataDir, tdState)
  return locked(files[0] + '.lock', () => {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const ref = ['origin/main', 'origin/master', 'main', 'master'].find((r) => git(dir, 'rev-parse', '--verify', '-q', r).trim()) ?? 'HEAD'
    const log = git(dir, 'log', ref, '--since=2 days ago', '--format=%s%n%b')
    const handed = files.map((f) => (existsSync(f) ? readFileSync(f, 'utf8').split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number) : []))
    const n = nextNumber(usedNumbers(text, prefix), usedNumbers(log, prefix), ...handed)
    for (const f of files) appendFileSync(f, `${n}\n`)
    return `T${prefix}-${n}`
  })
}

/** The line `overvibe tasks add` writes. */
export function taskLine(o: { id: string; day: string; what: string; session?: string | null }) {
  const what = o.what.replace(/\s+/g, ' ').trim()
  return `- [ ] ${o.id} ${o.day} ${what}${o.session ? ` · session ${o.session}` : ''}`
}

/** Put a line first under its section heading (newest first), adding the section, or the whole skeleton, if missing. */
export function insertLine(text: string, line: string, section: 'waiting' | 'todo'): string {
  if (!text.trim()) text = SKELETON
  const lines = text.split('\n')
  const isHead = (l: string, s: keyof typeof SECTIONS) => {
    const h = /^##\s+(.*)/.exec(l)
    if (!h || l.startsWith('###')) return false
    const t = h[1]!.toLowerCase()
    return s === 'waiting' ? t.includes('waiting') : s === 'done' ? t.startsWith('done') : !t.includes('waiting') && !t.startsWith('done') && /to ?do|open|tasks/.test(t)
  }
  let at = lines.findIndex((l) => isHead(l, section))
  if (at < 0) {
    // a missing section goes before Done (To do) or before To do (Waiting), else at the end
    const before = lines.findIndex((l) => isHead(l, section === 'waiting' ? 'todo' : 'done'))
    const head = [SECTIONS[section], '']
    if (before >= 0) lines.splice(before, 0, ...head)
    else lines.push('', ...head)
    at = before >= 0 ? before : lines.length - 2
  }
  lines.splice(at + 1, 0, line)
  return lines.join('\n')
}

/** Add a task line to the folder's TASKS.md (made if missing). Returns the id and the file. */
export function addTask(o: { dir: string; dataDir: string; what: string; waiting?: boolean; session?: string | null; now?: Date; tdState?: string | null }) {
  if (!o.what.trim()) throw new Error('say what the task is: overvibe tasks add "<what>"')
  const now = o.now ?? new Date()
  const id = allocateId(o.dir, o.dataDir, now, o.tdState === undefined ? TASKS_DOCTOR_STATE : o.tdState)
  const file = tasksPath(o.dir)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  writeFileSync(file, insertLine(text, taskLine({ id, day: dayOf(now), what: o.what, session: o.session }), o.waiting ? 'waiting' : 'todo'))
  return { id, file, created: !text }
}

export type Problem = { kind: string; line: number; text: string }

/**
 * What is wrong in a TASKS.md, by tasks-doctor's rules: ticked but not under Done, a new line without an id, the same
 * id twice, ticked without saying how it was checked, and (given the ids named in commits on main) shipped but open.
 */
export function checkTasks(text: string, shipped: Record<string, string[]> = {}): Problem[] {
  const out: Problem[] = []
  const seen = new Map<string, number[]>()
  let section = ''
  text.split('\n').forEach((l, i) => {
    const n = i + 1
    if (l.startsWith('## ')) return void (section = l.slice(3).trim().toLowerCase())
    const box = /^\s*- \[( |x|X)\]/.exec(l)
    if (!box) return
    const own = /\bT\d{4}-\d+\b/.exec(l)?.[0] ?? null
    if (own) seen.set(own, [...(seen.get(own) ?? []), n])
    const done = box[1] !== ' '
    const dated = /20\d\d-\d\d-\d\d/.exec(l)?.[0]
    const newStyle = !!own || (!!dated && dated >= CUTOVER)
    const short = l.trim().slice(0, 110)
    if (done && !section.includes('done') && newStyle) out.push({ kind: 'ticked but not moved to Done', line: n, text: short })
    if (!done && own && shipped[own]?.length) out.push({ kind: `shipped (commits ${shipped[own]!.slice(0, 4).join(',')}) but still open: verify, then tick or say what is left`, line: n, text: short })
    if (!done && !own && dated && dated >= CUTOVER) out.push({ kind: 'line without an id (overvibe tasks id)', line: n, text: short })
    if (done && own && !CHECK_WORDS.test(l)) out.push({ kind: 'ticked without saying how it was checked', line: n, text: short })
  })
  for (const [id, ns] of seen) if (ns.length > 1) out.push({ kind: `duplicate id ${id}`, line: ns[0]!, text: `lines ${ns.join(', ')}` })
  return out
}

/** Ids named in commit messages on the main branch over the last 90 days, with their short hashes. */
export function shippedIds(dir: string): Record<string, string[]> {
  const ref = ['origin/main', 'origin/master', 'main', 'master'].find((r) => git(dir, 'rev-parse', '--verify', '-q', r).trim())
  if (!ref) return {}
  const out: Record<string, string[]> = {}
  for (const row of git(dir, 'log', ref, '--since=90 days ago', '--format=%h\x1f%s%n%b\x1e').split('\x1e')) {
    const [h, msg] = row.trim().split('\x1f')
    if (!h || !msg) continue
    for (const id of new Set([...msg.matchAll(ID)].map((m) => m[0]))) (out[id] ??= []).push(h)
  }
  return out
}
