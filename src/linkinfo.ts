// What the terminal's link matchers need from this computer [T1112-137]: is a folder in a git repo, is its remote on
// GitHub (an ssh host alias is resolved with `ssh -G`, never guessed), which short shas are real commits there, and
// the user's own matchers from <data dir>/links.json. Nothing here talks to the network.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './env'
import { checkUserLinks, type UserLink, type UserLinkCheck } from './linkuser'

export const LINKS_FILE = join(DATA_DIR, 'links.json')

const git = (cwd: string, args: string[], stdin?: string) => {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return p.exitCode === 0 ? p.stdout.toString() : null
}

/** "owner/repo" from a remote URL whose host is github.com; `resolve` maps an ssh host alias to its real host */
export function githubRepoOf(remote: string, resolve: (host: string) => string = (h) => h): string | null {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim())
  if (!m) return null
  const host = m[1]!.toLowerCase()
  const real = host === 'github.com' ? host : resolve(host).toLowerCase()
  return real === 'github.com' || real === 'ssh.github.com' ? `${m[2]}/${m[3]}` : null
}

const hostCache = new Map<string, string>()
function sshHost(alias: string): string {
  if (!/^[\w.-]+$/.test(alias)) return alias
  let h = hostCache.get(alias)
  if (h === undefined) {
    const p = Bun.spawnSync(['ssh', '-G', alias], { stdout: 'pipe', stderr: 'ignore' })
    h = /^hostname\s+(\S+)/m.exec(p.stdout.toString())?.[1] ?? alias
    hostCache.set(alias, h)
  }
  return h
}

export type RepoInfo = { git: boolean; github: string | null }
const repoCache = new Map<string, { at: number; info: RepoInfo }>()
/** the folder's repo, cached a minute */
export function repoInfo(cwd: string): RepoInfo {
  const hit = repoCache.get(cwd)
  if (hit && Date.now() - hit.at < 60_000) return hit.info
  let info: RepoInfo = { git: false, github: null }
  if (cwd && existsSync(cwd) && statSync(cwd).isDirectory() && git(cwd, ['rev-parse', '--git-dir']) !== null) {
    const remotes = (git(cwd, ['remote', '-v']) ?? '').split('\n').map((l) => l.split(/\s+/)).filter((p) => p[1] && p[2] === '(fetch)')
    // origin first, then upstream, then any other
    remotes.sort((a, b) => rank(a[0]!) - rank(b[0]!))
    let github: string | null = null
    for (const [, url] of remotes) if ((github = githubRepoOf(url!, sshHost))) break
    info = { git: true, github }
  }
  repoCache.set(cwd, { at: Date.now(), info })
  return info
}
const rank = (name: string) => (name === 'origin' ? 0 : name === 'upstream' ? 1 : 2)

/** of these shas, the ones that name a commit in the folder's repo (an ambiguous short one does not) */
export function commitsIn(cwd: string, shas: string[]): string[] {
  const list = [...new Set(shas.filter((s) => /^[0-9a-f]{7,40}$/.test(s)))].slice(0, 200)
  if (!list.length || !repoInfo(cwd).git) return []
  const out = git(cwd, ['cat-file', '--batch-check=%(objecttype)'], list.map((s) => s + '^{commit}').join('\n') + '\n')
  if (out === null) return []
  const types = out.split('\n')
  return list.filter((_, i) => types[i] === 'commit')
}

type UserState = { mtime: number; ok: UserLink[]; skipped: UserLinkCheck['skipped'] }
let userCache: UserState = { mtime: -1, ok: [], skipped: [] }
/** links.json, read again when it changes: the usable entries and why the others were skipped (each logged once) */
export function userLinksReport(file = LINKS_FILE, log: (msg: string) => void = console.log): UserState {
  let mtime = 0
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    userCache = { mtime: 0, ok: [], skipped: [] }
    return userCache
  }
  if (mtime === userCache.mtime) return userCache
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e: any) {
    const why = `not valid JSON (${e.message})`
    log(`[links] ${file}: ${why}, no user links`)
    return (userCache = { mtime, ok: [], skipped: [{ name: '(file)', why }] })
  }
  const r = checkUserLinks(raw)
  for (const x of r.skipped) log(`[links] ${file}: "${x.name}" skipped: ${x.why}`)
  return (userCache = { mtime, ...r })
}
/** the usable entries of links.json; a bad file or entry is skipped with a log line, never thrown */
export const userLinks = (file = LINKS_FILE, log: (msg: string) => void = console.log): UserLink[] => userLinksReport(file, log).ok
