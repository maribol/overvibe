// Folders under the work root (WORK_ROOT, default ~/Work), three levels deep, for the new-session
// autocomplete. Rebuilt at most once a minute; a walk takes a few ms.
import { readdirSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { CONFIG, HOME, WORK_ROOT, WORK_ROOT_ENV, defaultWorkRoot, setWorkRoot, tildify, untildify } from './env'
import { getSettings } from './routing'

/** the work root, live: Settings and the setup can change it while the server runs */
export { WORK_ROOT as WORK } from './env'
const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'storage', 'tmp', 'cache', 'worktrees', '__pycache__', 'Pods', 'target'])
const DEPTH = 3

type Dir = { rel: string; name: string; repo: boolean; depth: number }
let cache: { at: number; root: string; dirs: Dir[] } = { at: 0, root: '', dirs: [] }

function walk(): Dir[] {
  const out: Dir[] = []
  const go = (abs: string, depth: number) => {
    let ents
    try {
      ents = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue
      const p = join(abs, e.name)
      const repo = existsSync(join(p, '.git'))
      out.push({ rel: relative(WORK_ROOT, p), name: e.name, repo, depth })
      // inside a repo, only its top level is a project; don't list every source folder
      if (depth < DEPTH && !repo) go(p, depth + 1)
    }
  }
  go(WORK_ROOT, 1)
  return out
}

function dirs(): Dir[] {
  if (Date.now() - cache.at > 60_000 || cache.root !== WORK_ROOT) cache = { at: Date.now(), root: WORK_ROOT, dirs: walk() }
  return cache.dirs
}

/** Every folder the walk knows (absolute), the work root first: where the Tasks view looks for TASKS.md [T1112-117]. */
export const workFolders = (): string[] => [WORK_ROOT, ...dirs().map((d) => join(WORK_ROOT, d.rel))]

/**
 * Best matches for what the owner typed: a project name from Settings first ("acme" finds
 * ~/Work/acme-site), then a folder whose name starts with it, then a path segment does, then anywhere.
 */
export function searchFolders(q: string, limit = 12): { rel: string; cwd: string; repo: boolean; project?: string }[] {
  const root = tildify(WORK_ROOT).toLowerCase() + '/'
  let n = q.trim().toLowerCase()
  if (n.startsWith(root) || n + '/' === root) n = n.slice(root.length)
  n = n.replace(/^\//, '')
  if (!n) return []
  const named: { rel: string; cwd: string; repo: boolean; project: string }[] = []
  for (const [abs, name] of Object.entries(getSettings().projectNames ?? {})) {
    const nm = name.toLowerCase()
    if (!(nm.startsWith(n) || nm.includes(n)) || !existsSync(abs)) continue
    named.push({ rel: relative(WORK_ROOT, abs), cwd: tildify(abs), repo: existsSync(join(abs, '.git')), project: name })
  }
  named.sort((a, b) => Number(!a.project.toLowerCase().startsWith(n)) - Number(!b.project.toLowerCase().startsWith(n)) || a.project.localeCompare(b.project))
  const have = new Set(named.map((x) => x.cwd))
  const scored: [number, Dir][] = []
  for (const d of dirs()) {
    const rel = d.rel.toLowerCase()
    const name = d.name.toLowerCase()
    let s = -1
    // a path from the root ("shop", "shop-cli") beats the same name nested deeper
    if (rel === n) s = 0
    else if (rel.startsWith(n)) s = 1
    else if (name === n || name.startsWith(n)) s = 2
    else if (rel.split('/').some((seg) => seg.startsWith(n))) s = 3
    else if (rel.includes(n)) s = 4
    if (s < 0) continue
    // repos first, then shallower, then shorter
    scored.push([s * 1000 + (d.repo ? 0 : 300) + d.depth * 50 + rel.length, d])
  }
  const rest = scored.sort((a, b) => a[0] - b[0]).map(([, d]) => ({ rel: d.rel, cwd: tildify(join(WORK_ROOT, d.rel)), repo: d.repo })).filter((d) => !have.has(d.cwd))
  return [...named, ...rest].slice(0, limit)
}

// ---- new folders from the New session box and deck new --mkdir ----

/** A typed path: "~/x" under home, "/x" as is, "a/b" under the work root (the same root the search uses). Anything else is a search. */
export function resolveTyped(q: string): string | null {
  const t = q.trim()
  if (!t || !(t.startsWith('~') || t.startsWith('/') || t.includes('/'))) return null
  if (t.startsWith('~') && t !== '~' && !t.startsWith('~/')) return null // ~user is not supported
  const abs = t.startsWith('~') ? untildify(t) : t.startsWith('/') ? t : join(WORK_ROOT, t)
  return abs.length > 1 ? abs.replace(/\/+$/, '') : abs
}

const present = (p: string) => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}
// top-level folders under home that hold the system's or apps' own files
const SYSTEM = new Set(['Library', 'Applications', 'System', 'Movies', 'Music', 'Pictures', 'Public'])
function outOfBounds(abs: string, home: string): string | null {
  if (!abs.startsWith(home + '/')) return 'it must be under your home folder'
  const segs = abs.slice(home.length + 1).split('/')
  if (segs.some((s) => s.startsWith('.'))) return 'hidden folders (starting with ".") are not allowed'
  if (SYSTEM.has(segs[0]!)) return `~/${segs[0]} is a system folder`
  return null
}

/**
 * Whether a typed path can be created: under home, no "..", no hidden or system folder, and no
 * symlink on the way that leads somewhere else. Throws the reason; returns the absolute path.
 */
export function checkNewFolder(input: string): string {
  const abs0 = resolveTyped(input)
  if (!abs0) throw new Error('type a path, e.g. ~/Work/projects/new-thing or projects/new-thing')
  if (input.split('/').some((s) => s === '..' || s === '.')) throw new Error('no "." or ".." in the path')
  const abs = normalize(abs0)
  const bad = outOfBounds(abs, HOME)
  if (bad) throw new Error(`can't create ${tildify(abs)}: ${bad}`)
  let a = abs
  while (!present(a)) a = dirname(a)
  let real: string
  try {
    real = realpathSync(a)
  } catch {
    throw new Error(`can't create ${tildify(abs)}: ${tildify(a)} is a broken link`)
  }
  if (!statSync(real).isDirectory()) throw new Error(`can't create ${tildify(abs)}: ${tildify(a)} is a file`)
  const realHome = realpathSync(HOME)
  const realAbs = join(real, relative(a, abs))
  const bad2 = outOfBounds(realAbs, realHome)
  if (bad2) throw new Error(`can't create ${tildify(abs)}: a link on the way leads to ${realAbs} (${bad2})`)
  return abs
}

/** mkdir -p after checkNewFolder; only called when a session is started with the create flag. */
export function makeFolder(input: string): string {
  const abs = checkNewFolder(input)
  mkdirSync(abs, { recursive: true })
  return abs
}

/** What the New session box shows for a typed path: an existing folder, a folder it can create, or why not. */
export function typedFolder(q: string): { cwd: string; exists: boolean; error?: string } | null {
  const abs = resolveTyped(q)
  if (!abs) return null
  if (existsSync(abs) && statSync(abs).isDirectory()) return { cwd: tildify(abs), exists: true }
  try {
    return { cwd: tildify(checkNewFolder(q)), exists: false }
  } catch (e: any) {
    return { cwd: tildify(abs), exists: false, error: e.message }
  }
}

// ---- the work root, from the setup screen and Settings [T1110-67] ----

/** What the setup shows about the work root: the one in use, the saved one, the default, and the env override. */
export function workRootInfo() {
  return { workRoot: tildify(WORK_ROOT), saved: CONFIG.workRoot ?? null, default: tildify(defaultWorkRoot()), env: WORK_ROOT_ENV ? tildify(WORK_ROOT_ENV) : null }
}

/** A work root the owner typed: "~", "~/x" or "/x" under home, an existing folder or one that can be made. Throws the reason. */
export function checkWorkRoot(input: string): { abs: string; exists: boolean } {
  const t = input.trim().replace(/\/+$/, '')
  if (!t.startsWith('~') && !t.startsWith('/')) throw new Error('start the path with ~/ (your home folder) or /')
  if (t === '~' || untildify(t) === HOME) return { abs: HOME, exists: true }
  let abs: string
  try {
    abs = checkNewFolder(t)
  } catch (e: any) {
    throw new Error(String(e.message).replace(/^can't create /, "can't use "))
  }
  return { abs, exists: present(abs) }
}

/** Save the work root ("" = back to the default), making the folder first when asked. */
export function saveWorkRoot(input: string, create = false) {
  if (!input.trim()) {
    setWorkRoot(null)
    return workRootInfo()
  }
  const { abs, exists } = checkWorkRoot(input)
  if (!exists) {
    if (!create) throw new Error(`${tildify(abs)} does not exist yet`)
    mkdirSync(abs, { recursive: true })
  }
  setWorkRoot(abs)
  return workRootInfo()
}
