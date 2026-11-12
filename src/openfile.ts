// ⌘-click on a file path in a terminal [T1112-2]: open that file on this computer. On a Mac, in Google Chrome
// when it is installed (images, PDFs, HTML show there), else in the file's default app; on Linux xdg-open,
// in WSL wslview. Only an existing file or folder under the home folder or /tmp.
// Bare names (walkthrough.mp4) and partial paths [T1112-8] are looked up in the folders named on the lines
// above the click (nearest first), then the session's folders, then a short search under the session folder.
// When those miss [T1112-17] (findLink): paths the session itself used (its transcript), its repo and scratch
// folders (~/scratchpad/<folder name>/), then a wider search under the project, ~/scratchpad, the work root,
// ~/Downloads and ~/Desktop. Several matches there come back as choices.
import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { HOME, cleanEnv, tildify } from './env'
import { gitRoot } from './projects'
import { IS_MAC, IS_WSL } from './platform'

const CHROME = '/Applications/Google Chrome.app'
const SKIP = new Set(['node_modules', 'Library', 'vendor'])

function unlink(raw: string): string {
  let p = raw.trim()
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname)
    } catch {
      throw new Error('not a file link')
    }
  }
  p = p.replace(/[:]\d+(?::\d+)?$/, '') // path:line:col from compiler output
  if (p === '~' || p.startsWith('~/')) p = join(HOME, p.slice(2))
  return p
}

/** context paths from the screen as folders: a folder stays, a file gives its folder, a missing one drops out */
function contextDirs(context: string[], bases: string[]): string[] {
  const out: string[] = []
  for (const c of context.slice(0, 60)) {
    let p: string
    try {
      p = unlink(String(c).slice(0, 4000))
    } catch {
      continue
    }
    if (!p) continue
    const full = isAbsolute(p) ? [p] : bases.map((b) => resolve(b, p))
    for (const f of full) {
      try {
        const d = statSync(f).isDirectory() ? f : dirname(f)
        if (!out.includes(d)) out.push(d)
        break
      } catch {}
    }
  }
  return out
}

export type SearchOpts = { depth?: number; budgetMs?: number }

/**
 * A short search for `rel` under `roots`: folders at most `depth` deep (node_modules, .git and other dot
 * folders skipped), stopped after `budgetMs`. Several matches: the newest file wins.
 */
export function findNear(rel: string, roots: string[], { depth = 4, budgetMs = 300 }: SearchOpts = {}): string | undefined {
  const until = Date.now() + budgetMs
  let best: { p: string; t: number } | undefined
  const seen = new Set<string>()
  let level = roots.filter(Boolean)
  for (let d = 0; d <= depth && level.length; d++) {
    const next: string[] = []
    for (const dir of level) {
      if (Date.now() > until) return best?.p
      if (seen.has(dir)) continue
      seen.add(dir)
      const hit = join(dir, rel)
      try {
        const t = statSync(hit).mtimeMs
        if (!best || t > best.t) best = { p: hit, t }
      } catch {}
      if (d === depth) continue
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) next.push(join(dir, e.name))
      } catch {}
    }
    level = next
  }
  return best?.p
}

/**
 * The real path a link points at, or an error that says why it can't be opened.
 * `bases`: the session's folders (its current folder, then its own). `context`: paths seen on the screen near
 * the link, nearest first; a relative path or bare name is tried in their folders first, then in `bases`, then
 * in the home folder, then by a short search under `bases`.
 */
export function resolveLink(raw: string, bases: string[] = [], context: string[] = [], search: SearchOpts = {}): string {
  let p = unlink(raw)
  if (!isAbsolute(p)) {
    const rel = p
    const own = bases.filter(Boolean)
    const dirs = [...contextDirs(context, [...own, HOME]), ...own, HOME]
    p =
      dirs.map((b) => resolve(b, rel)).find((x) => existsSync(x)) ??
      (own.length ? findNear(rel, [...new Set(own)], search) : undefined) ??
      resolve(own[0] || HOME, rel)
  }
  if (!existsSync(p)) throw new Error(`no such file: ${p}`)
  return guard(p)
}

/** the real path of an existing `p`, refused outside the home folder and /tmp */
function guard(p: string): string {
  const real = realpathSync(p)
  const tmp = realpathSync('/tmp')
  const under = (root: string) => real === root || real.startsWith(root + '/')
  if (!under(realpathSync(HOME)) && !under(tmp) && !under('/private/var/folders')) throw new Error('only files under your home folder or /tmp open from here')
  statSync(real)
  return real
}

/** `how`: open the file (Chrome on a Mac, a folder in Finder), or reveal it (selected in Finder; its folder elsewhere) */
export async function openFile(path: string, how: 'open' | 'reveal' = 'open') {
  const dir = statSync(path).isDirectory()
  let argv: string[]
  if (how === 'reveal') argv = IS_MAC ? ['open', '-R', path] : [IS_WSL ? 'wslview' : 'xdg-open', dirname(path)]
  else argv = IS_MAC ? (existsSync(CHROME) && !dir ? ['open', '-a', 'Google Chrome', path] : ['open', path]) : IS_WSL ? ['wslview', path] : ['xdg-open', path]
  const p = Bun.spawn(argv, { env: cleanEnv(), stdout: 'ignore', stderr: 'pipe' })
  if ((await p.exited) !== 0) throw new Error((await new Response(p.stderr).text()).trim() || `could not open ${path}`)
}

// ---- the smarter lookup [T1112-17] ----

export type Choice = { path: string; label: string; mtime: number }
export type Found = { path: string; step: 'direct' | 'cache' | 'transcript' | 'convention' | 'search' } | { choices: Choice[]; step: 'search' }
export type FindOpts = {
  bases?: string[]
  context?: string[]
  /** the session's transcript (Claude Code) or rollout (Codex) */
  transcript?: string | null
  /** this session's earlier finds, rel -> real path; filled in by findLink */
  cache?: Map<string, string>
  /** tiers of the wider search (wideRoots); empty or false skips it */
  roots?: string[][] | false
  search?: SearchOpts
  wide?: SearchOpts & { max?: number }
}

/** `rel` without ./ ../ in front and / at the end: the part that must end a real path */
export const tailOf = (rel: string) => rel.replace(/^(?:\.{1,2}\/)+/, '').replace(/\/+$/, '')

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const PATH_CHARS = '[^\\s"\'`<>|\\\\;,*(){}\\[\\]]+'

/** the last `bytes` of a file, as text */
function tail(file: string, bytes: number): string {
  const fd = openSync(file, 'r')
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.allocUnsafe(size - start)
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, start)).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** absolute paths in a transcript's tail (home, ~ and /tmp ones), newest first, each once */
export function transcriptPaths(file: string, bytes = 8 << 20): string[] {
  let text: string
  try {
    text = tail(file, bytes)
  } catch {
    return []
  }
  const re = new RegExp(`(?:${esc(HOME)}|~|/private/tmp|/tmp)/${PATH_CHARS}`, 'g')
  const out: string[] = []
  const seen = new Set<string>()
  const all = text.match(re) ?? []
  for (let i = all.length - 1; i >= 0; i--) {
    let p = all[i]!.replace(/[.:]+$/, '')
    if (p.startsWith('~/')) p = HOME + p.slice(1)
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/**
 * Step 2: the session's own paths. First a path it used that ends with `rel` (or has `rel` as its folders,
 * like .../client-emails/cold-imgs/a.png for client-emails/cold-imgs), newest first; then `rel` inside the
 * folders of the paths it used.
 */
export function fromTranscript(rel: string, file: string): string | undefined {
  const t = tailOf(rel)
  if (!t) return
  const paths = transcriptPaths(file)
  const needle = '/' + t
  for (const p of paths) {
    let i = p.lastIndexOf(needle)
    while (i >= 0) {
      const end = i + needle.length
      if (end === p.length || p[end] === '/') {
        const hit = p.slice(0, end)
        if (existsSync(hit)) return hit
      }
      i = i > 0 ? p.lastIndexOf(needle, i - 1) : -1
    }
  }
  const tried = new Set<string>()
  for (const p of paths.slice(0, 400)) {
    for (const d of [p, dirname(p)]) {
      if (tried.has(d)) continue
      tried.add(d)
      const hit = join(d, t)
      if (existsSync(hit)) return hit
    }
  }
}

/** the nearest folder with a .git (a worktree's own root, where gitRoot gives its main repo) */
function ownRepo(abs: string): string | null {
  for (let p = abs, i = 0; i < 12 && p && p !== '/'; i++, p = dirname(p)) if (existsSync(join(p, '.git'))) return p
  return null
}

/** Step 3: folders next to the session's by convention: its repo, the worktree's main repo, ~/scratchpad/<name>/ */
export function conventionRoots(bases: string[]): string[] {
  const out: string[] = []
  const add = (p: string | null | undefined) => p && !out.includes(p) && existsSync(p) && out.push(p)
  const scratch = join(HOME, 'scratchpad')
  for (const b of bases.filter(Boolean)) {
    const own = ownRepo(b)
    const main = gitRoot(b)
    add(own)
    add(main)
    for (const n of [basename(b), own && basename(own), main && basename(main)]) if (n) add(join(scratch, n))
  }
  return out
}

export type WideOpts = SearchOpts & { max?: number }
/** build output and package folders, skipped by the wide part of the search (not in the session's own project) */
const SKIP_WIDE = new Set([...SKIP, 'build', 'dist', 'intermediates', 'DerivedData', 'Pods', '__pycache__', 'site-packages', 'venv', 'target', 'coverage'])

/**
 * Step 4: every place `rel` ends a path, newest first. `tiers` are searched in order (the session's project
 * and scratch folders, then the wide roots), and a tier with a match ends the search. `rel` may start at most
 * `depth` folders down; dot folders, node_modules, vendor and Library are skipped (build output too after the
 * first tier), links not followed; at most `max` matches; stopped after `budgetMs` in all. Folders are read
 * 32 at a time without blocking (one at a time took 11 s for ~/scratchpad and ~/Work here, this takes 2).
 */
export async function searchWide(rel: string, tiers: string[][], { depth = 8, budgetMs = 4000, max = 20 }: WideOpts = {}): Promise<{ hits: Choice[]; done: boolean }> {
  const t = tailOf(rel)
  const seg = t.split('/')[0]!
  const until = Date.now() + budgetMs
  const hits = new Map<string, number>()
  const seen = new Set<string>()
  let done = true
  const full = () => hits.size >= max
  for (const [n, roots] of tiers.entries()) {
    const skip = n === 0 ? SKIP : SKIP_WIDE
    let level = [...new Set(roots.filter((r) => r && existsSync(r)))]
    for (let d = 0; d <= depth && level.length && done && !full(); d++) {
      const next: string[] = []
      let i = 0
      const worker = async () => {
        while (i < level.length && !full()) {
          if (Date.now() > until) return void (done = false)
          const dir = level[i++]!
          if (seen.has(dir)) continue
          seen.add(dir)
          let list
          try {
            list = await readdir(dir, { withFileTypes: true })
          } catch {
            continue
          }
          for (const e of list) {
            if (seg && e.name === seg && !full()) {
              try {
                const real = realpathSync(join(dir, t))
                if (!hits.has(real)) hits.set(real, statSync(real).mtimeMs)
              } catch {}
            }
            if (d < depth && e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name)) next.push(join(dir, e.name))
          }
        }
      }
      await Promise.all(Array.from({ length: 32 }, worker))
      level = next
    }
    if (hits.size || !done) break
  }
  const out = [...hits].map(([path, mtime]) => ({ path, label: tildify(path), mtime })).sort((a, b) => b.mtime - a.mtime)
  return { hits: out, done }
}

/**
 * Where the wider search looks for a session in `bases`, as two tiers: its project (the repo, a worktree's
 * main repo) and its scratch folders; then ~/scratchpad, the work root, ~/Downloads and ~/Desktop.
 */
export function wideRoots(bases: string[], workRoot: string): string[][] {
  const near: string[] = []
  for (const b of bases.filter(Boolean)) for (const r of [ownRepo(b), gitRoot(b) ?? b]) if (r && r !== HOME && !near.includes(r)) near.push(r)
  for (const r of conventionRoots(bases)) if (!near.includes(r)) near.push(r)
  const far = [join(HOME, 'scratchpad'), workRoot, join(HOME, 'Downloads'), join(HOME, 'Desktop')].filter((r) => r && r !== HOME && !near.includes(r))
  return [near, far]
}

/**
 * The real path a link points at, steps in order, the first hit wins: what resolveLink finds (the screen, the
 * session's folders, home, a short search), this session's earlier finds, its transcript, its repo and
 * scratch folders, then the wider search (one match: that path; several: choices, newest first). Throws
 * "Not found ... Looked in ..." when nothing matches, and refuses paths outside home and /tmp.
 */
export async function findLink(raw: string, o: FindOpts = {}): Promise<Found> {
  const bases = (o.bases ?? []).filter(Boolean)
  const p0 = unlink(raw)
  try {
    return { path: resolveLink(raw, bases, o.context ?? [], o.search), step: 'direct' }
  } catch (e: any) {
    if (isAbsolute(p0) || !/^no such file/.test(e.message)) throw e
  }
  const rel = tailOf(p0)
  if (!rel) throw new Error(`no such file: ${p0}`)
  const keep = (path: string, step: 'transcript' | 'convention' | 'search'): Found => {
    const real = guard(path)
    o.cache?.set(rel, real)
    return { path: real, step }
  }
  const cached = o.cache?.get(rel)
  if (cached && existsSync(cached)) return { path: guard(cached), step: 'cache' }
  if (o.transcript) {
    const hit = fromTranscript(rel, o.transcript)
    if (hit) return keep(hit, 'transcript')
  }
  const conv = conventionRoots(bases)
  const hit = conv.map((r) => join(r, rel)).find((x) => existsSync(x)) ?? findNear(rel, conv, { depth: 3, budgetMs: 300 })
  if (hit) return keep(hit, 'convention')
  const roots = o.roots || []
  if (roots.some((r) => r.length)) {
    const { hits, done } = await searchWide(rel, roots, o.wide)
    const ok = hits.filter((h) => {
      try {
        return guard(h.path) === h.path
      } catch {
        return false
      }
    })
    if (ok.length === 1) return keep(ok[0]!.path, 'search')
    if (ok.length > 1) return { choices: ok, step: 'search' }
    const where = [o.transcript ? 'its transcript' : '', ...new Set([...bases, ...conv, ...roots.flat()].map(tildify))].filter(Boolean)
    throw new Error(`Not found: ${rel}. Looked in ${where.join(', ')}${done ? '' : ' (stopped after the time limit)'}.`)
  }
  throw new Error(`no such file: ${resolve(bases[0] || HOME, rel)}`)
}
