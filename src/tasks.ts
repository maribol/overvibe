// Every project's TASKS.md (one task list per repo), read by the deck itself.
// Lines: "- [ ] T1023-4 2026-10-23 <what> · session <id8>" under "## Waiting on the owner", "## To do", "## Done".
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HOME, WORK_ROOT, tildify, untildify } from './env'
import { deckJsonFor } from './deckjson'

export type Task = { done: boolean; id: string | null; date: string | null; text: string; sessions: string[]; section: 'waiting' | 'todo' | 'done'; day: string | null }
/** `copyOf`: this file sits in a git worktree whose main repo's TASKS.md is listed too (same lines, counted once there) */
export type TaskFile = { root: string; file: string; tasks: Task[]; mtime: number; copyOf?: string }

const cache = new Map<string, TaskFile>()

/** The TASKS.md for a folder: deck.json "tasks", else the nearest TASKS.md at or above it (stops at the work root). */
export function tasksFileFor(cwd: string): string | null {
  const dj = deckJsonFor(cwd)
  if (dj?.tasks) {
    const f = join(dj.dir, dj.tasks)
    if (existsSync(f)) return f
  }
  let p = untildify(cwd)
  for (let i = 0; i < 5 && p.startsWith(HOME + '/'); i++) {
    const f = join(p, 'TASKS.md')
    if (existsSync(f)) return f
    if (p === WORK_ROOT) break
    p = p.replace(/\/[^/]+$/, '')
  }
  return null
}

export function readTasks(file: string): TaskFile {
  const mtime = statSync(file).mtimeMs
  const c = cache.get(file)
  if (c && c.mtime === mtime) return c
  const tasks: Task[] = []
  let section: Task['section'] = 'todo'
  let day: string | null = null
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const h = /^##\s+(.*)/.exec(line)
    if (h && !line.startsWith('###')) {
      const t = h[1]!.toLowerCase()
      section = t.includes('waiting') ? 'waiting' : t.startsWith('done') ? 'done' : 'todo'
      day = null
      continue
    }
    const d = /^###\s+(\d{4}-\d{2}-\d{2})/.exec(line)
    if (d) {
      day = d[1]!
      continue
    }
    const m = /^\s*- \[( |x|X)\]\s+(.*)$/.exec(line)
    if (!m) continue
    let rest = m[2]!
    const id = /^(T\d{4}-\d+)\s+/.exec(rest)?.[1] ?? null
    if (id) rest = rest.slice(id.length).trim()
    const date = /^(\d{4}-\d{2}-\d{2})\s+/.exec(rest)?.[1] ?? null
    if (date) rest = rest.slice(date.length).trim()
    const sessions = [...rest.matchAll(/session ([0-9a-f]{8})/g)].map((x) => x[1]!)
    const text = rest.replace(/\s*·\s*session [0-9a-f]{8}/g, '').trim()
    tasks.push({ done: m[1] !== ' ', id, date, text, sessions, section, day })
  }
  const tf = { root: tildify(file.replace(/\/TASKS\.md$/, '')), file: tildify(file), tasks, mtime }
  cache.set(file, tf)
  return tf
}

const subdirs = (d: string) => {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'vendor').map((e) => e.name)
  } catch {
    return []
  }
}

/** A TASKS.md at the top of a git worktree: its main repo's TASKS.md, when there is one. */
export function mainCopyOf(file: string): string | null {
  const dir = file.replace(/\/TASKS\.md$/, '')
  try {
    const g = join(dir, '.git')
    if (!existsSync(g) || !statSync(g).isFile()) return null
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(g, 'utf8'))
    const i = m ? m[1]!.indexOf('/.git/worktrees/') : -1
    if (i <= 0) return null
    const main = join(m![1]!.slice(0, i), 'TASKS.md')
    return main !== file && existsSync(main) ? main : null
  } catch {
    return null
  }
}

/**
 * TASKS.md files for these folders (the sessions' folders) plus `extra` folders (every folder under the work
 * root) [T1112-117], one per file. A worktree's copy is listed with `copyOf` set to the main repo's file, which is
 * listed too, so a count can skip the copy without losing a line.
 */
export function tasksFor(cwds: string[], extra: string[] = []): TaskFile[] {
  const files = new Set<string>()
  for (const c of cwds) {
    const f = tasksFileFor(c)
    if (f) files.add(f)
  }
  for (const d of extra) {
    const f = join(d, 'TASKS.md')
    if (existsSync(f)) files.add(f)
    // the folder walk stops at a repo's top; a repo can keep a second list one folder down (elasticfunnels/ai-server)
    if (existsSync(join(d, '.git')))
      for (const sub of subdirs(d)) {
        const g = join(d, sub, 'TASKS.md')
        if (existsSync(g)) files.add(g)
      }
  }
  const out = new Map<string, TaskFile>()
  for (const f of files) {
    const main = mainCopyOf(f)
    if (main && !out.has(main)) out.set(main, readTasks(main))
    if (out.has(f)) continue
    const tf = readTasks(f)
    out.set(f, main ? { ...tf, copyOf: tildify(main) } : tf)
  }
  return [...out.values()]
}

/** Any TASKS.md in the work root or two folders below it: the Tasks view's default at first run [T1112-16]. */
export function anyTasksFile(root: string): boolean {
  const walk = (dir: string, depth: number): boolean => {
    if (existsSync(join(dir, 'TASKS.md'))) return true
    if (!depth) return false
    let names: string[] = []
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => d.name)
    } catch {}
    return names.slice(0, 500).some((n) => walk(join(dir, n), depth - 1))
  }
  return walk(root, 2)
}
