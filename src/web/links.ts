// Every kind of link in a terminal, in one ordered list [T1112-137]. Each matcher finds its links on a screen line
// and says where each goes (a web address, a file, or something in Overvibe), what the right-click menu calls it
// and what its hover card says. Matchers run in order and the first to claim a stretch of the screen keeps it, so
// overlaps (a URL that holds a path, a package name that looks like a path, a /compact with paths in its note)
// are settled here and nowhere else. Pure: the terminal is read through `Screen`, nothing here touches the DOM.
//
// Order: /compact, full URLs, the user's own (links.json), GitHub issues, npm packages, local servers, Reddit, task ids,
// commit shas, sites without https://, file paths, bare file names.

import { compactAt, type Row } from './compactLink'
import { hostUrl } from './hostLink'
import { MAX_MATCH, fillTemplate, type UserLink } from '../linkuser'

/** where a link goes */
export type Target =
  | { kind: 'url'; url: string }
  | { kind: 'path'; path: string }
  | { kind: 'compact'; args: string }
  | { kind: 'task'; id: string }
  | { kind: 'copy'; text: string }

/** A screen cell, 0-based. A link's range runs from `start` to `end`, both included. */
export type Cell = { x: number; y: number }
export type Link = {
  matcher: string
  text: string
  /** where the link starts in its line's text (wrapped rows joined) */
  at: number
  range: { start: Cell; end: Cell }
  target: Target
  /** the right-click menu's first item */
  label: string
  /** the hover card's first line ('' = no card: file paths show a preview instead, /compact none) */
  card: string
  /** a commit sha only counts once the server says the folder's repo has it */
  verify?: 'commit'
}

/** what the session's folder adds: set by the page from /api/links */
export type LinkCtx = {
  /** the session takes /compact (Claude Code, Codex) */
  compact?: boolean
  /** the folder is in a git repo */
  git?: boolean
  /** "owner/repo" when the folder's remote is on GitHub (resolved by the server) */
  github?: string | null
  /** the Tasks view is on */
  tasks?: boolean
  /** the user's own matchers, compiled */
  user?: UserMatcher[]
}

export type Screen = { row(y: number): Row | undefined }

type Found = { text: string; at: number; target: Target; label: string; card?: string; verify?: 'commit' }
type LineMatcher = { id: string; kind: 'line'; when?: (c: LinkCtx) => boolean; find(line: string, c: LinkCtx): Found[] }
type ScreenMatcher = { id: string; kind: 'screen'; when?: (c: LinkCtx) => boolean; find(s: Screen, y: number): Link[] }
export type Matcher = LineMatcher | ScreenMatcher

/** each match of a global regex, without looping on an empty one */
function* each(re: RegExp, s: string) {
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (!m[0]) re.lastIndex++
    yield m
  }
}
/** where group `g` of a match starts in the line */
const groupAt = (m: RegExpExecArray, g = 1) => m.index + m[0].indexOf(m[g]!)
const web = (url: string, label: string, card = label): Omit<Found, 'text' | 'at'> => ({ target: { kind: 'url', url }, label: `Open ${label}`, card })

// ---- files: paths and bare names (unchanged from T1112-8; sites without https:// split off as in T1112-133)

// a path on a terminal line: ~/..., /abs/..., ./x, or dir/file.ext (with an optional :line:col)
export const PATH_RE = /(?:^|[\s('"`[<])((?:~|\.{1,2})?\/?[\w.@+%-]+(?:\/[\w.@+%-]+)+\/?(?::\d+(?::\d+)?)?)/g
// a bare file name with an extension (walkthrough.mp4, notes.md:12) [T1112-8]
export const NAME_RE = /(?:^|[\s('"`[<])([\w@+%-][\w.@+%-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?::\d+)?)?)(?=$|[\s)\]'"`>,;:!?]|\.(?:\s|$))/g
export const trimLink = (t: string) => t.replace(/[.,;:)\]'"]+$/, '')

/** paths on a line, as [text, start column] */
export function pathsOn(line: string): [string, number][] {
  const out: [string, number][] = []
  for (const m of line.matchAll(PATH_RE)) {
    const text = trimLink(m[1]!)
    if (!text.includes('/') || !/[a-z]/i.test(text) || /:\/\//.test(text)) continue
    out.push([text, m.index! + m[0].length - m[1]!.length])
  }
  return out
}
/** paths, then bare names where no path covers them */
function fileish(line: string): [string, number][] {
  const found = pathsOn(line)
  for (const m of line.matchAll(NAME_RE)) {
    const text = trimLink(m[1]!)
    const at = m.index! + m[0].length - m[1]!.length
    // a letter in the name; not e.g / i.e
    if (!/[a-z]/i.test(text.slice(0, text.lastIndexOf('.'))) || /^\w\.\w$/.test(text)) continue
    if (found.some(([t, a]) => at < a + t.length && a < at + text.length)) continue
    found.push([text, at])
  }
  return found
}

// ---- full URLs: the same pattern and check as xterm's web links addon
const URL_RE = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g
function isUrl(s: string) {
  try {
    const u = new URL(s)
    const base = u.password && u.username ? `${u.protocol}//${u.username}:${u.password}@${u.host}` : u.username ? `${u.protocol}//${u.username}@${u.host}` : `${u.protocol}//${u.host}`
    return s.toLowerCase().startsWith(base.toLowerCase())
  } catch {
    return false
  }
}
const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ---- GitHub
// owner/repo#123, github.com/owner/repo#123 (owner: GitHub's rules, letters, digits and inner hyphens)
const GH_REF_RE = /(?<![\w./@#-])((?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([\w.-]{1,100})#(\d{1,7}))(?![\w-])/g
// a bare #123, only where the words around it say it is an issue or pull request: "PR #12", "fixes #12", or a
// squash-merge subject in git log --oneline ("a1b2c3d Title (#12)"). Any other "(#12)" is too often some other id
// (an order, a CRM row, an affiliate: all seen in transcripts).
const ISSUE_RE = /(?<![\w&#/-])#(\d{1,6})(?![\w-]|\.\d)/g
const ISSUE_BEFORE = /\b(?:PRs?|pull requests?|pull|issues?|fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+$/i
const ISSUE_SUBJECT = /^\)\s*$/

// ---- npm: @scope/name (a lone @word is a decorator or a mention), and names after npm i / bun add / ...
const NPM_SCOPED_RE = /(?<![\w@/.:=-]|=")(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)(?![\w/])/g
// the command at a line's start (after a prompt), in backticks, inside Bash(...), or after && ; |
const NPM_CMD_RE = /(^\s*(?:[$❯›>%#]\s+)?|`|Bash\(|&&\s*|;\s*|\|\s*)(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|i|install)|yarn\s+(?:global\s+)?add|bun\s+(?:add|i|install))((?:\s+[^\s`)&;|]+)+)/g
const NPM_NAME = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@[\w.^~<>=*|-]+)?$/
// scopes that are almost always something else: import aliases (@shared/x), Android resources (@drawable/x)
const NOT_NPM_SCOPE = /^@(?:shared|app|lib|libs|src|components|utils|core|common|config|server|client|web|modules|assets|styles|mipmap|drawable|string|color|dimen|layout|id|style|anim|xml|raw|menu|android)\//
const npmFound = (name: string, at: number): Found => ({ text: name, at, ...web(`https://www.npmjs.com/package/${name}`, `${name} on npm`) })

// ---- a local server without http:// (localhost:7777/x, 127.0.0.1:5173): about 740 of them in two days of
// transcripts. 0.0.0.0 is a bind address, not one to open.
const LOCAL_RE = /(?<![\w/.:@-])((?:localhost|127\.0\.0\.1|\[::1\]):\d{2,5}(?:\/[^\s'"`<>()[\]{}|\\^]*)?)(?![\w:])/g

// ---- Reddit: r/sub and u/user as their own word ("dir/r/x" and "r/x/y.ts" stay paths)
const REDDIT_RE = /(?<![\w/.@~:-])([ru])\/([A-Za-z0-9_]{3,21})(?![\w/-]|\.\w)/g

// ---- Overvibe task ids: T<month><day>-<n>, as tasks-doctor writes them
// (not inside a path: ~/scratchpad/x/T1110-16/web stays the path)
const TASK_RE = /(?<![\w/.-])T(\d\d)(\d\d)-(\d{1,4})(?![\w/-])/g

// ---- commit shas: 7 to 40 hex with a letter and a digit, not part of a word, a path, a uuid or a colour
const SHA_RE = /(?<![\w./:#@-])([0-9a-f]{7,40})(?![\w/-]|\.\w)/g

export const BUILTIN: Matcher[] = [
  // the whole suggested /compact, over every row it wraps to, is one link; paths inside it are not [T1112-91]
  {
    id: 'compact', kind: 'screen', when: (c) => !!c.compact,
    find(s, y) {
      const hit = compactAt((yy) => s.row(yy), y)
      if (!hit) return []
      const text = '/compact ' + hit.args
      return [{ matcher: 'compact', text, at: 0, range: { start: { x: hit.x, y: hit.top }, end: { x: hit.endX, y: hit.bottom } }, target: { kind: 'compact', args: hit.args }, label: 'Compact', card: '' }]
    },
  },
  {
    id: 'url', kind: 'line',
    find: (line) => [...each(URL_RE, line)].filter((m) => isUrl(m[0])).map((m) => ({ text: m[0], at: m.index, ...web(m[0], 'link', hostOf(m[0])), label: 'Open' })),
  },
  {
    id: 'github', kind: 'line',
    find: (line) => [...each(GH_REF_RE, line)].map((m) => {
      const [, text, owner, repo, n] = m
      const name = `${owner}/${repo!.replace(/\.git$/, '')}`
      return { text: text!, at: groupAt(m), ...web(`https://github.com/${name}/issues/${n}`, `${name}#${n} on GitHub`) }
    }),
  },
  {
    id: 'issue', kind: 'line', when: (c) => !!c.github,
    find: (line, c) => [...each(ISSUE_RE, line)]
      .filter((m) => ISSUE_BEFORE.test(line.slice(0, m.index)) || (line[m.index - 1] === '(' && ISSUE_SUBJECT.test(line.slice(m.index + m[0].length)) && /^\s*(?:[*|/\\ ]+)?[0-9a-f]{7,40}\s/.test(line)))
      .map((m) => ({ text: m[0], at: m.index, ...web(`https://github.com/${c.github}/issues/${m[1]}`, `${c.github}#${m[1]} on GitHub`) })),
  },
  {
    id: 'npm', kind: 'line',
    find(line) {
      const out: Found[] = []
      for (const m of each(NPM_SCOPED_RE, line)) {
        const name = m[1]!.replace(/[.-]+$/, '')
        if (name.split('/')[1] && !NOT_NPM_SCOPE.test(name) && !/eslint-(?:disable|enable)/.test(line)) out.push(npmFound(name, groupAt(m)))
      }
      for (const m of each(NPM_CMD_RE, line)) {
        const [, lead, args] = m as unknown as [string, string, string]
        let off = m.index + m[0].length - args.length
        const names: Found[] = []
        for (const tok of args.split(/(\s+)/)) {
          const n = NPM_NAME.exec(tok)
          const name = n?.[1]!.replace(/\.+$/, '')
          if (name && !tok.startsWith('-')) names.push(npmFound(name, off))
          off += tok.length
        }
        // at a bare line start it could be a row of prose ("npm install fails when the..."): only a short
        // command that is the whole line counts
        const bare = !/[$❯›>%#`(&;|]/.test(lead)
        if (bare && (names.length > 3 || line.slice(m.index + m[0].length).trim())) continue
        out.push(...names)
      }
      return out.sort((a, b) => a.at - b.at)
    },
  },
  {
    id: 'local', kind: 'line',
    find: (line) => [...each(LOCAL_RE, line)].map((m) => {
      const text = trimLink(m[1]!)
      return { text, at: groupAt(m), ...web(`http://${text}`, 'link', text.replace(/\/.*/, '')), label: 'Open' }
    }),
  },
  {
    id: 'reddit', kind: 'line',
    find: (line) => [...each(REDDIT_RE, line)].map((m) => {
      const [text, k, name] = m
      return { text, at: m.index, ...web(`https://www.reddit.com/${k === 'r' ? 'r' : 'user'}/${name}`, `${text} on Reddit`) }
    }),
  },
  {
    id: 'task', kind: 'line', when: (c) => !!c.tasks,
    find: (line) => [...each(TASK_RE, line)]
      .filter((m) => +m[1]! >= 1 && +m[1]! <= 12 && +m[2]! >= 1 && +m[2]! <= 31)
      .map((m) => ({ text: m[0], at: m.index, target: { kind: 'task', id: m[0] }, label: `Open ${m[0]} in Tasks`, card: `${m[0]} in Tasks` })),
  },
  {
    id: 'commit', kind: 'line', when: (c) => !!c.git,
    find: (line, c) => [...each(SHA_RE, line)]
      .filter((m) => /[a-f]/.test(m[1]!) && /\d/.test(m[1]!))
      .map((m) => {
        const sha = m[1]!
        const short = sha.slice(0, 7)
        return c.github
          ? { text: sha, at: m.index, ...web(`https://github.com/${c.github}/commit/${sha}`, `commit ${short} on GitHub`), verify: 'commit' as const }
          : { text: sha, at: m.index, target: { kind: 'copy', text: sha }, label: `Copy commit ${short}`, card: `Commit ${short}`, verify: 'commit' as const }
      }),
  },
  // a site's address without https:// opens the site, as a full URL does [T1112-133]
  {
    id: 'site', kind: 'line',
    find: (line) => fileish(line).flatMap(([text, at]) => {
      const url = hostUrl(text)
      return url ? [{ text, at, ...web(url, 'link', text.split('/')[0]!), label: 'Open' }] : []
    }),
  },
  {
    id: 'path', kind: 'line',
    find: (line) => fileish(line).filter(([t]) => !hostUrl(t)).map(([text, at]) => ({ text, at, target: { kind: 'path', path: text }, label: 'Open', card: '' })),
  },
]

// ---- the user's own, from links.json (checked on the server, src/linkuser.ts)
export type UserMatcher = LineMatcher & { slow?: boolean }
/** a user pattern that took longer than this on one line is turned off until the page reloads */
export const USER_BUDGET_MS = 25
/** user patterns see at most this much of a line */
export const USER_LINE_MAX = 512

export function compileUser(list: UserLink[], warn: (msg: string) => void = () => {}): UserMatcher[] {
  const out: UserMatcher[] = []
  for (const u of list) {
    let re: RegExp
    try {
      re = new RegExp(u.pattern, (u.flags ?? '').replace(/g/g, '') + 'g')
    } catch (e: any) {
      warn(`links.json: "${u.name}" skipped: ${e.message}`)
      continue
    }
    const me: UserMatcher = {
      id: `user:${u.name}`, kind: 'line',
      find(line) {
        if (me.slow) return []
        const t0 = performance.now()
        const found: Found[] = []
        for (const m of each(re, line.slice(0, USER_LINE_MAX))) {
          if (m[0].length > MAX_MATCH || found.length >= 50) break
          if (!m[0].trim()) continue
          const url = fillTemplate(u.url, m, encodeURI)
          const label = u.label ? fillTemplate(u.label, m) : `Open ${m[0]} in ${u.name}`
          found.push({ text: m[0], at: m.index, target: { kind: 'url', url }, label, card: label.replace(/^Open /, '') })
        }
        if (performance.now() - t0 > USER_BUDGET_MS) {
          me.slow = true
          warn(`links.json: "${u.name}" took over ${USER_BUDGET_MS} ms on one line and is off until the page reloads`)
        }
        return found
      },
    }
    out.push(me)
  }
  return out
}

/** the list for a session: the built-in ones, with the user's after full URLs */
export function matchersFor(c: LinkCtx): Matcher[] {
  const i = BUILTIN.findIndex((m) => m.id === 'url') + 1
  return [...BUILTIN.slice(0, i), ...(c.user ?? []), ...BUILTIN.slice(i)].filter((m) => !m.when || m.when(c))
}

/** the line (wrapped rows joined) holding row `y`: its text and each character's cell */
export function lineAt(s: Screen, y: number, maxRows = 40): { text: string; cells: Cell[]; top: number } {
  let top = y
  while (top > 0 && y - top < maxRows && s.row(top)?.wrapped) top--
  let text = ''
  const cells: Cell[] = []
  for (let yy = top; yy < top + maxRows; yy++) {
    const r = s.row(yy)
    if (!r || (yy > top && !r.wrapped)) break
    text += r.text
    for (let i = 0; i < r.text.length; i++) cells.push({ x: r.xs?.[i] ?? i, y: yy })
  }
  return { text, cells, top }
}

const lin = (c: Cell) => c.y * 100_000 + c.x

/**
 * The links that cover row `y`, after every matcher had its turn: a stretch one matcher claimed is not
 * looked at by the ones after it.
 */
export function linksAt(s: Screen, y: number, c: LinkCtx, list: Matcher[] = matchersFor(c)): Link[] {
  const line = lineAt(s, y)
  const claimed: [number, number][] = []
  const free = (a: number, b: number) => !claimed.some(([p, q]) => a <= q && p <= b)
  const out: Link[] = []
  for (const m of list) {
    const found: Link[] = m.kind === 'screen'
      ? m.find(s, y)
      : m.find(line.text, c).flatMap((f) => {
          const start = line.cells[f.at], end = line.cells[f.at + f.text.length - 1]
          return start && end && f.text ? [{ matcher: m.id, card: '', ...f, range: { start, end } }] : []
        })
    for (const l of found) {
      const a = lin(l.range.start), b = lin(l.range.end)
      if (!free(a, b)) continue
      claimed.push([a, b])
      out.push(l)
    }
  }
  return out.filter((l) => l.range.start.y <= y && y <= l.range.end.y).sort((p, q) => lin(p.range.start) - lin(q.range.start))
}
