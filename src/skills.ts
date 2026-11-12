// Cross-agent skills [T1110-64]: one library, linked into Claude Code, Codex and agy.
//
// Sources, by priority: the owner's library (~/.config/overvibe/skills/<name>/SKILL.md) and the skills
// bundled in this repo (skills/<name>/, e.g. overvibe). A library skill with the same name wins.
//
// Where each CLI loads skills from (checked on this Mac with Claude Code 2.1, Codex 0.160 and agy 1.5):
//   Claude Code  user ~/.claude/skills/<name>/    project <dir>/.claude/skills/<name>/   symlinks followed
//   Codex        user ~/.codex/skills/<name>/     project <dir>/.codex/skills and <dir>/.agents/skills;
//                                                 symlinks followed (also ~/.agents/skills, unused here)
//   agy          user ~/.gemini/config/skills/    project <dir>/.agents/skills/<name>/; symlinks followed at
//                                                 user level only: a symlinked skill (or SKILL.md) in a
//                                                 workspace is skipped, so project-level agy skills are copies
// All three read the standard name/description frontmatter and ignore keys they do not know.
//
// Frontmatter keys Overvibe reads on top of name/description (all optional):
//   tools: [claude, codex, agy]   which CLIs get it (default: all three)
//   projects: [~/code/app, ...]   only these folders (and folders under them), at project level; default:
//                                 everywhere, at user level
//   aliases: [old-name]           extra folder names at user level, so old paths keep working
//   default: off                  not synced until switched on (Skills view or `overvibe skills on <name>`)
//                                 (on, the default: synced until switched off; `pending` in the report until the user chose)
//   recommended: <label>          shown as a recommended integration in the Skills view
//
// Overvibe only touches what it made: every link or copy is in skills-manifest.json. A folder that is
// already there and not in the manifest is the owner's: reported as a clash, never replaced.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, watch, writeFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { ACCOUNTS_DIR, CODEX_ACCOUNTS_DIR, DATA_DIR, HOME, TOOLS, tildify, untildify, type Tool } from './env'

export const LIBRARY = join(DATA_DIR, 'skills')
export const BUNDLED = resolve(import.meta.dir, '..', 'skills')
const MANIFEST = join(DATA_DIR, 'skills-manifest.json')
const STATE = join(DATA_DIR, 'skills-state.json')
const BACKUP = join(DATA_DIR, 'skills-backup')
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

export type Skill = {
  name: string
  description: string
  tools: Tool[]
  /** absolute folders; empty = user level, everywhere */
  projects: string[]
  aliases: string[]
  defaultOn: boolean
  on: boolean
  /** no on/off choice recorded yet (the setup screen asks for recommended integrations) */
  pending: boolean
  recommended?: string
  source: 'library' | 'bundled'
  dir: string
  problems: string[]
}
type Scope = 'user' | 'project' | 'session' | 'pass'
type Entry = { path: string; skill: string; tool: Tool; scope: Scope; kind: 'link' | 'copy'; target: string; hash?: string; at: number }
export type EntryStatus = Entry & { state: 'ok' | 'clash' | 'modified' | 'error'; note?: string }

const readJson = <T>(f: string, d: T): T => {
  try {
    return JSON.parse(readFileSync(f, 'utf8')) ?? d
  } catch {
    return d
  }
}
let manifest: Entry[] = readJson(MANIFEST, [])
const saveManifest = () => writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), { mode: 0o600 })
/** on: switched on/off by the owner (wins over `default:`); aliases: extra user-level folder names kept locally */
type State = { on: Record<string, boolean>; aliases?: Record<string, string[]> }
const getState = (): State => {
  const s = readJson<Partial<State>>(STATE, {})
  return { ...s, on: s.on ?? {} }
}
const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 })

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
const exists = (p: string) => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** frontmatter of a SKILL.md: the YAML between the first two --- lines */
export function frontmatter(text: string): Record<string, any> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return null
  try {
    const y = Bun.YAML.parse(m[1]!)
    if (y && typeof y === 'object' && !Array.isArray(y)) return y as Record<string, any>
  } catch {}
  // the CLIs accept `description: a: b` (not valid YAML); so does this: one `key: value` per line
  const out: Record<string, any> = {}
  for (const l of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(l)
    if (!kv) continue
    const v = kv[2]!.trim()
    out[kv[1]!] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : v.replace(/^"(.*)"$/, '$1')
  }
  return Object.keys(out).length ? out : null
}
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()) : [])

function readSkill(dir: string, source: Skill['source'], state: State): Skill | null {
  const file = join(dir, 'SKILL.md')
  if (!existsSync(file)) return null
  const folder = basename(dir)
  const fm = frontmatter(readFileSync(file, 'utf8'))
  const problems: string[] = []
  if (!fm) problems.push('SKILL.md has no frontmatter (--- name/description ---)')
  const name = String(fm?.name ?? folder)
  if (name !== folder) problems.push(`name "${name}" differs from its folder "${folder}" (agy needs them equal)`)
  if (!NAME.test(folder)) problems.push('folder name: lowercase letters, digits and dashes, at most 64')
  const description = String(fm?.description ?? '').trim()
  if (!description) problems.push('no description: agents use it to decide when to load the skill')
  else if (description.length > 1024) problems.push(`description is ${description.length} characters; keep it under 1024`)
  const tools0 = list(fm?.tools).map((t) => t.toLowerCase())
  const bad = tools0.filter((t) => !TOOLS.includes(t as Tool))
  if (bad.length) problems.push(`unknown tools: ${bad.join(', ')} (claude, codex, agy)`)
  const tools = tools0.length ? (TOOLS.filter((t) => tools0.includes(t)) as Tool[]) : [...TOOLS]
  const projects = list(fm?.projects).map((p) => resolve(untildify(p)))
  const aliases = [...new Set([...list(fm?.aliases), ...(state.aliases?.[folder] ?? [])])].filter((a) => NAME.test(a) && a !== folder)
  const defaultOn = !['off', 'false', 'no'].includes(String(fm?.default ?? 'on').toLowerCase())
  return {
    name: folder,
    description,
    tools,
    projects,
    aliases,
    defaultOn,
    on: state.on[folder] ?? defaultOn,
    pending: state.on[folder] === undefined,
    recommended: fm?.recommended ? String(fm.recommended) : undefined,
    source,
    dir,
    problems,
  }
}

/** every skill Overvibe knows: the library first, then bundled ones the library does not override */
export function skills(): Skill[] {
  const state = getState()
  const out: Skill[] = []
  for (const [root, source] of [[LIBRARY, 'library'], [BUNDLED, 'bundled']] as const) {
    if (!isDir(root)) continue
    for (const d of readdirSync(root).sort()) {
      if (d.startsWith('.') || out.some((s) => s.name === d)) continue
      const s = readSkill(join(root, d), source, state)
      if (s) out.push(s)
    }
  }
  return out
}

/** user-level skill folders per CLI: the default config dir, plus any account whose skills folder is its own */
export function userDirs(tool: Tool): string[] {
  const base = tool === 'claude' ? join(HOME, '.claude') : tool === 'codex' ? join(HOME, '.codex') : join(HOME, '.gemini')
  if (!isDir(base)) return [] // that CLI was never run here
  const main = tool === 'agy' ? join(base, 'config', 'skills') : join(base, 'skills')
  const extra: string[] = []
  const accounts = tool === 'claude' ? ACCOUNTS_DIR : tool === 'codex' ? CODEX_ACCOUNTS_DIR : ''
  if (accounts && isDir(accounts))
    for (const a of readdirSync(accounts)) {
      const d = join(accounts, a, 'skills')
      // accounts.ts links each account's skills folder to the default one; only a real folder needs its own links
      if (isDir(d) && !isLink(d)) extra.push(d)
    }
  return [main, ...extra]
}

/** project-level places for one skill in one folder, for the given tools (one agy copy also serves Codex) */
function projectPlaces(s: Skill, dir: string, tools: Tool[]): { path: string; tool: Tool; kind: Entry['kind'] }[] {
  const out: { path: string; tool: Tool; kind: Entry['kind'] }[] = []
  if (tools.includes('claude')) out.push({ path: join(dir, '.claude', 'skills', s.name), tool: 'claude', kind: 'link' })
  if (tools.includes('agy')) out.push({ path: join(dir, '.agents', 'skills', s.name), tool: 'agy', kind: 'copy' })
  else if (tools.includes('codex')) out.push({ path: join(dir, '.codex', 'skills', s.name), tool: 'codex', kind: 'link' })
  return out
}

function treeHash(dir: string): string {
  const h = createHash('sha256')
  const walk = (d: string, rel: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f)
      const st = statSync(p)
      if (st.isDirectory()) walk(p, `${rel}${f}/`)
      else {
        h.update(`${rel}${f}\0`)
        h.update(readFileSync(p))
      }
    }
  }
  try {
    walk(dir, '')
  } catch {
    return ''
  }
  return h.digest('hex')
}

/** keep a project-level skill out of `git status`: one line in that repo's .git/info/exclude */
function gitExclude(path: string) {
  const dir = dirname(dirname(dirname(path)))
  const r = Bun.spawnSync(['git', '-C', dir, 'rev-parse', '--show-toplevel', '--git-path', 'info/exclude'], { stdout: 'pipe', stderr: 'ignore' })
  if (r.exitCode !== 0) return
  const [top, ex0] = r.stdout.toString().trim().split('\n')
  if (!top || !ex0) return
  const ex = ex0.startsWith('/') ? ex0 : join(dir, ex0)
  const rel = realpathSync(dirname(path)).slice(realpathSync(top).length) + '/' + basename(path)
  const now = existsSync(ex) ? readFileSync(ex, 'utf8') : ''
  if (now.split('\n').some((l) => l.trim() === rel)) return
  mkdirSync(dirname(ex), { recursive: true })
  // gitignore has no trailing comments: the note goes on its own line
  appendFileSync(ex, (now && !now.endsWith('\n') ? '\n' : '') + `# added by Overvibe skills\n${rel}\n`)
}

type Want = Omit<Entry, 'at' | 'hash'>

/** what should exist right now */
function wanted(all: Skill[]): Want[] {
  const out: Want[] = []
  const add = (w: Want) => {
    if (!out.some((o) => o.path === w.path)) out.push(w)
  }
  for (const s of all) {
    if (!s.on || s.problems.some((p) => p.startsWith('folder name') || p.startsWith('SKILL.md has no'))) continue
    if (!s.projects.length) {
      for (const tool of s.tools) for (const d of userDirs(tool)) for (const n of [s.name, ...s.aliases]) add({ path: join(d, n), skill: s.name, tool, scope: 'user', kind: 'link', target: s.dir })
    } else {
      for (const p of s.projects) if (isDir(p)) for (const x of projectPlaces(s, p, s.tools)) add({ ...x, skill: s.name, scope: 'project', target: s.dir })
    }
  }
  // placed at a session start: kept while the skill is there (and switched on, for folder matches)
  for (const e of manifest) {
    if (e.scope !== 'session' && e.scope !== 'pass') continue
    const s = all.find((x) => x.name === e.skill)
    if (!s || (e.scope === 'session' && !s.on)) continue
    add({ path: e.path, skill: e.skill, tool: e.tool, scope: e.scope, kind: e.kind, target: s.dir })
  }
  return out
}

function place(w: Want, statuses: EntryStatus[], changes: string[]) {
  const mine = manifest.find((e) => e.path === w.path)
  const at = exists(w.path)
  try {
    if (at && !mine) {
      // the owner's own folder, or a link to this same skill made by hand: adopt only the identical link
      if (isLink(w.path) && realpathSync(w.path) === realpathSync(w.target)) {
        manifest.push({ ...w, at: Date.now() })
        statuses.push({ ...w, at: Date.now(), state: 'ok', note: 'existing link to this skill, now managed' })
        return
      }
      const same = isDir(w.path) && treeHash(w.path) === treeHash(w.target)
      statuses.push({ ...w, at: Date.now(), state: 'clash', note: same ? 'your own copy, same content; left as it is' : 'a skill with this name is already there (yours); left as it is' })
      return
    }
    if (w.kind === 'link') {
      if (at && isLink(w.path) && readlinkSync(w.path) === w.target) {
        statuses.push({ ...mine!, state: 'ok' })
        return
      }
      if (at && !isLink(w.path)) {
        statuses.push({ ...mine!, state: 'modified', note: 'was a link Overvibe made; now a folder, left as it is' })
        return
      }
      if (at) unlinkSync(w.path)
      mkdirSync(dirname(w.path), { recursive: true })
      symlinkSync(w.target, w.path)
      changes.push(`linked ${tildify(w.path)} -> ${tildify(w.target)}`)
      manifest = manifest.filter((e) => e.path !== w.path)
      manifest.push({ ...w, at: Date.now() })
    } else {
      const src = treeHash(w.target)
      if (at && mine) {
        const cur = treeHash(w.path)
        if (cur === src) {
          if (mine.hash !== src) mine.hash = src
          statuses.push({ ...mine, state: 'ok' })
          return
        }
        if (cur !== mine.hash) {
          statuses.push({ ...mine, state: 'modified', note: 'edited since Overvibe copied it; not updated (remove it to get a fresh copy)' })
          return
        }
        rmSync(w.path, { recursive: true })
      }
      mkdirSync(dirname(w.path), { recursive: true })
      cpSync(w.target, w.path, { recursive: true, dereference: true })
      changes.push(`${at ? 'updated' : 'copied'} ${tildify(w.target)} -> ${tildify(w.path)}`)
      manifest = manifest.filter((e) => e.path !== w.path)
      manifest.push({ ...w, hash: treeHash(w.path), at: Date.now() })
    }
    if (w.scope !== 'user') gitExclude(w.path)
    statuses.push({ ...manifest.find((e) => e.path === w.path)!, state: 'ok' })
  } catch (e: any) {
    statuses.push({ ...w, at: Date.now(), state: 'error', note: e.message })
  }
}

/** take away one entry Overvibe made, only if it is still what Overvibe made */
function unplace(e: Entry, changes: string[]): boolean {
  try {
    if (!exists(e.path)) return true
    if (e.kind === 'link') {
      if (!isLink(e.path) || readlinkSync(e.path) !== e.target) {
        changes.push(`left ${tildify(e.path)}: it is no longer the link Overvibe made`)
        return true
      }
      unlinkSync(e.path)
    } else {
      if (treeHash(e.path) !== e.hash) {
        changes.push(`left ${tildify(e.path)}: edited since Overvibe copied it`)
        return true
      }
      rmSync(e.path, { recursive: true })
    }
    changes.push(`removed ${tildify(e.path)}`)
    return true
  } catch (err: any) {
    changes.push(`could not remove ${tildify(e.path)}: ${err.message}`)
    return false
  }
}

let last: { at: number; statuses: EntryStatus[]; changes: string[] } = { at: 0, statuses: [], changes: [] }

/** make the CLIs' skill folders match the library: add what is missing, drop what Overvibe made and no longer wants */
export function sync(): typeof last {
  const all = skills()
  const want = wanted(all)
  const statuses: EntryStatus[] = []
  const changes: string[] = []
  for (const w of want) place(w, statuses, changes)
  const keep = new Set(want.map((w) => w.path))
  manifest = manifest.filter((e) => keep.has(e.path) || !unplace(e, changes))
  saveManifest()
  last = { at: Date.now(), statuses, changes }
  if (changes.length) console.log(`skills: ${changes.join('; ')}`)
  return last
}

/**
 * A session is starting in `cwd` with `tool`: the skills whose `projects` cover this folder, plus any it was
 * handed with `overvibe new --skill`, are placed in the folder's project-level skill dir for that CLI.
 * Skills already at user level for that CLI need nothing. Returns what it placed.
 */
export function forSession(tool: Tool, cwd: string, extra: string[] = []): { placed: string[]; already: string[] } {
  const all = skills()
  const placed: string[] = []
  const already: string[] = []
  const statuses: EntryStatus[] = []
  const changes: string[] = []
  const put = (s: Skill, scope: Scope) => {
    for (const x of projectPlaces(s, cwd, [tool])) {
      place({ ...x, skill: s.name, scope, target: s.dir }, statuses, changes)
      if (statuses.at(-1)?.state === 'ok') placed.push(s.name)
    }
  }
  for (const n of extra) {
    const s = all.find((x) => x.name === n)
    if (!s) throw new Error(`no skill "${n}" in the library (overvibe skills ls)`)
    if (s.on && !s.projects.length && s.tools.includes(tool) && userDirs(tool).length) already.push(n)
    else put(s, 'pass')
  }
  for (const s of all) {
    if (!s.on || !s.tools.includes(tool) || extra.includes(s.name)) continue
    if (s.projects.some((p) => cwd === p)) already.push(s.name) // sync placed it there
    else if (s.projects.some((p) => cwd.startsWith(p + '/'))) put(s, 'session')
  }
  if (changes.length) {
    saveManifest()
    console.log(`skills for a ${tool} session in ${tildify(cwd)}: ${changes.join('; ')}`)
  }
  return { placed: [...new Set(placed)], already }
}

export function setOn(name: string, on: boolean) {
  if (!skills().some((s) => s.name === name)) throw new Error(`no skill "${name}"`)
  const st = getState()
  st.on[name] = on
  saveState(st)
  return sync()
}

/** an extra user-level folder name for a skill (an old name that paths or prompts still use); this machine only */
export function setAlias(name: string, alias: string, on = true) {
  if (!skills().some((s) => s.name === name)) throw new Error(`no skill "${name}"`)
  if (!NAME.test(alias) || alias === name) throw new Error('bad alias')
  const st = getState()
  const cur = new Set(st.aliases?.[name] ?? [])
  if (on) cur.add(alias)
  else cur.delete(alias)
  st.aliases = { ...st.aliases, [name]: [...cur] }
  saveState(st)
  return sync()
}

/** set or replace frontmatter keys in a SKILL.md (tools, projects) */
function setKeys(file: string, keys: Record<string, string[] | undefined>) {
  let text = readFileSync(file, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) throw new Error(`${tildify(file)} has no frontmatter`)
  let body = m[1]!
  for (const [k, v] of Object.entries(keys)) {
    if (!v) continue
    const line = `${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`
    // drop the key and any indented list lines under it, then add it back
    body = body.replace(new RegExp(`^${k}:.*(?:\\r?\\n[ \\t]+-.*)*`, 'm'), '').replace(/\n{2,}/g, '\n').trim()
    body += `\n${line}`
  }
  text = text.slice(0, m.index) + `---\n${body}\n---` + text.slice(m.index + m[0].length)
  writeFileSync(file, text)
}

/** copy a skill folder (or a SKILL.md's folder) into the library */
export function add(path0: string, o: { tools?: string[]; projects?: string[] } = {}) {
  let dir = resolve(untildify(path0))
  if (basename(dir) === 'SKILL.md') dir = dirname(dir)
  if (!existsSync(join(dir, 'SKILL.md'))) throw new Error(`no SKILL.md in ${tildify(dir)}`)
  const fm = frontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
  const name = String(fm?.name ?? basename(dir))
  if (!NAME.test(name)) throw new Error(`skill name "${name}": lowercase letters, digits and dashes, at most 64`)
  const dst = join(LIBRARY, name)
  if (exists(dst)) throw new Error(`the library already has "${name}" (${tildify(dst)})`)
  if (o.tools?.some((t) => !TOOLS.includes(t as Tool))) throw new Error('--tools: claude, codex, agy')
  mkdirSync(LIBRARY, { recursive: true })
  cpSync(dir, dst, { recursive: true, dereference: true })
  // a skill whose folder name differs from its name keeps working: the library folder takes the name
  setKeys(join(dst, 'SKILL.md'), { tools: o.tools?.length ? o.tools : undefined, projects: o.projects?.length ? o.projects.map((p) => tildify(resolve(untildify(p)))) : undefined })
  return { name, dir: dst, ...sync() }
}

/**
 * A skill one CLI already has, into the library so every CLI gets it. Its original stays where it is
 * (and shows as a clash for that CLI) unless `replace`: then it moves to skills-backup/ and a link takes its place.
 */
export function importFrom(tool: Tool, name: string, replace = false) {
  if (!NAME.test(name)) throw new Error('bad skill name')
  const src = userDirs(tool).map((d) => join(d, name)).find((p) => existsSync(join(p, 'SKILL.md')))
  if (!src) throw new Error(`${tool} has no skill "${name}" (looked in ${userDirs(tool).map(tildify).join(', ') || 'no skills folder'})`)
  if (manifest.some((e) => e.path === src)) throw new Error(`"${name}" in ${tool} is already Overvibe's (${tildify(src)})`)
  const dst = join(LIBRARY, name)
  if (exists(dst)) {
    if (treeHash(dst) !== treeHash(src)) throw new Error(`the library already has a different "${name}" (${tildify(dst)})`)
  } else {
    mkdirSync(LIBRARY, { recursive: true })
    cpSync(src, dst, { recursive: true, dereference: true })
  }
  let backup: string | undefined
  if (replace) {
    backup = join(BACKUP, tool, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(dirname(backup), { recursive: true })
    renameSync(src, backup)
  }
  return { name, dir: dst, from: src, backup, ...sync() }
}

/** stop linking a skill anywhere (only what Overvibe made goes); purge also moves the library copy to skills-backup/ */
export function remove(name: string, purge = false) {
  const s = skills().find((x) => x.name === name)
  if (!s && !manifest.some((e) => e.skill === name)) throw new Error(`no skill "${name}"`)
  const st = getState()
  st.on[name] = false
  saveState(st)
  const changes: string[] = []
  manifest = manifest.filter((e) => e.skill !== name || !unplace(e, changes))
  saveManifest()
  let purged: string | undefined
  if (purge && s?.source === 'library') {
    purged = join(BACKUP, 'library', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(dirname(purged), { recursive: true })
    renameSync(s.dir, purged)
    const st2 = getState()
    delete st2.on[name]
    saveState(st2)
  }
  return { name, changes, purged, bundled: s?.source === 'bundled' }
}

/** clashes of a skill with the owner's own folders */
const managedNames = () => new Set(manifest.map((e) => basename(e.path)))

/** what the Skills view and `overvibe skills ls` show */
export function report() {
  const all = skills()
  const st = last.at ? last : sync()
  const mine = managedNames()
  // skills each CLI has that are not Overvibe's, for one-click import
  const others: { tool: Tool; name: string; description: string; path: string; inLibrary: boolean }[] = []
  for (const tool of TOOLS)
    for (const d of userDirs(tool).slice(0, 1)) {
      if (!isDir(d)) continue
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n)
        if (n.startsWith('.') || manifest.some((e) => e.path === p) || !existsSync(join(p, 'SKILL.md'))) continue
        const fm = frontmatter(readFileSync(join(p, 'SKILL.md'), 'utf8'))
        others.push({ tool, name: n, description: String(fm?.description ?? '').slice(0, 300), path: tildify(p), inLibrary: all.some((s) => s.name === n) || mine.has(n) })
      }
    }
  return {
    library: tildify(LIBRARY),
    bundled: tildify(BUNDLED),
    syncedAt: st.at,
    changes: st.changes,
    dirs: Object.fromEntries(TOOLS.map((t) => [t, userDirs(t).map(tildify)])),
    skills: all.map((s) => ({
      ...s,
      dir: tildify(s.dir),
      projects: s.projects.map(tildify),
      places: st.statuses.filter((e) => e.skill === s.name).map((e) => ({ path: tildify(e.path), tool: e.tool, scope: e.scope, kind: e.kind, state: e.state, note: e.note })),
    })),
    others,
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
/** sync now, and again whenever the library or the bundled skills change */
export function startSkills() {
  mkdirSync(LIBRARY, { recursive: true })
  try {
    sync()
  } catch (e: any) {
    console.warn(`skills: sync failed: ${e.message}`)
  }
  const later = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        sync()
      } catch (e: any) {
        console.warn(`skills: sync failed: ${e.message}`)
      }
    }, 800)
  }
  for (const d of [LIBRARY, BUNDLED])
    if (isDir(d))
      try {
        watch(d, { recursive: true }, later)
      } catch {}
  // a CLI run for the first time after Overvibe started (a new install: Claude Code installed or first opened
  // later) makes its config folder; link the skills into it then, without waiting for a restart
  const present = () => [join(HOME, '.claude'), join(HOME, '.codex'), join(HOME, '.gemini')].map((d) => (isDir(d) ? '1' : '0')).join('')
  let had = present()
  setInterval(() => {
    const now = present()
    if (now !== had) (had = now), later()
  }, 15_000).unref?.()
}
