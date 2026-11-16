// Privacy scan for a public export (scripts/release.sh) [T1112-123].
//   bun scripts/releasescan.ts <dir> [--message <commit message>]
// Prints one line per hit (values masked) and exits 1 if there is any.
// The patterns are written so this file and its test never match themselves
// (a character class like [p] breaks the literal), so the scan needs no skip list.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'

export type Hit = { file: string; line: number; rule: string; text: string }

/** /Users/<name> allowed in docs and fixtures */
export const ALLOWED_USERS = new Set(['x', 'me'])
/** placeholder emails used in fixtures; git@host is an ssh remote, not a person */
const ALLOWED_EMAIL = [/^git@/i, /^a@b\.co$/i, /^me@x\.dev$/i, /@example\.(com|org|net)$/i]

const RULES: { rule: string; re: RegExp }[] = [
  { rule: 'name', re: /as[p]er|todosici[u]c|bianc[a]/gi },
  { rule: 'anthropic key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { rule: 'github token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}/g },
  { rule: 'slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { rule: 'aws key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: 'google key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { rule: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: 'telegram token', re: /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  { rule: 'session link', re: /claude\.ai\/code\/session_/gi },
  { rule: 'attribution', re: /co[-]authored[-]by|generated with \[?[C]laude|noreply@anthropi[c]/gi },
]
const USERS_RE = /\/Users\/([A-Za-z0-9._-]+)/g
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const SHORT_RE = /\b[0-9a-f]{8}\b/gi

export type Ctx = {
  /** full conversation ids (lower case) known on this Mac */
  ids: Set<string>
  /** emails the LICENSE author uses */
  licenseEmails?: Set<string>
  /** names allowed in this file only (LICENSE carries the author's name) */
  licenseFile?: string
}

/** shows enough to find the hit, never the whole value */
export function mask(s: string): string {
  return s.length <= 10 ? s : s.slice(0, 6) + '…' + `(${s.length})`
}

export function scanText(file: string, text: string, ctx: Ctx): Hit[] {
  const hits: Hit[] = []
  const short = new Set([...ctx.ids].map((id) => id.slice(0, 8)))
  const lines = text.split('\n')
  lines.forEach((ln, i) => {
    const add = (rule: string, v: string) => hits.push({ file, line: i + 1, rule, text: mask(v) })
    for (const { rule, re } of RULES) {
      for (const m of ln.matchAll(re)) {
        if (rule === 'name' && ctx.licenseFile && file === ctx.licenseFile) continue
        add(rule, m[0])
      }
    }
    for (const m of ln.matchAll(USERS_RE)) if (!ALLOWED_USERS.has(m[1])) add('home path', m[0])
    for (const m of ln.matchAll(EMAIL_RE)) {
      const e = m[0]
      if (ALLOWED_EMAIL.some((r) => r.test(e)) || ctx.licenseEmails?.has(e.toLowerCase())) continue
      add('email', e)
    }
    const uuidStarts = new Set<number>()
    for (const m of ln.matchAll(UUID_RE)) {
      uuidStarts.add(m.index!)
      if (ctx.ids.has(m[0].toLowerCase())) add('conversation id', m[0])
    }
    // an 8-hex word that starts a known id (a full uuid's first block was checked above)
    for (const m of ln.matchAll(SHORT_RE)) {
      if (!uuidStarts.has(m.index!) && short.has(m[0].toLowerCase())) add('conversation id (8)', m[0])
    }
  })
  return hits
}

const UUID_FILE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

function walkIds(dir: string, out: Set<string>, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    const m = n.match(UUID_FILE)
    if (m) out.add(m[1].toLowerCase())
    const p = join(dir, n)
    try { if (statSync(p).isDirectory()) walkIds(p, out, depth + 1) } catch {}
  }
}

/** every conversation id on this Mac: Claude transcripts (all accounts), Overvibe's sessions.json, Codex rollouts */
export function knownIds(home = homedir()): Set<string> {
  const ids = new Set<string>()
  walkIds(join(home, '.claude/projects'), ids)
  const accts = join(home, '.claude-accounts')
  if (existsSync(accts)) for (const a of readdirSync(accts)) walkIds(join(accts, a, 'projects'), ids)
  walkIds(join(home, '.codex/sessions'), ids)
  for (const f of [join(home, '.config/agent-deck/sessions.json'), join(home, '.config/overvibe/sessions.json')]) {
    try { for (const m of readFileSync(f, 'utf8').matchAll(UUID_RE)) ids.add(m[0].toLowerCase()) } catch {}
  }
  return ids
}

function files(dir: string, root = dir, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === '.git' && dir === root) continue
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) files(p, root, out)
    else out.push(relative(root, p))
  }
  return out
}

export function scanDir(dir: string, ctx: Ctx): Hit[] {
  const hits: Hit[] = []
  for (const f of files(dir)) {
    hits.push(...scanText('(path)', f, ctx).map((h) => ({ ...h, file: f, line: 0 })))
    const buf = readFileSync(join(dir, f))
    if (buf.subarray(0, 8000).includes(0)) continue // binary
    hits.push(...scanText(f, buf.toString('utf8'), ctx))
  }
  return hits
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const dir = args[0]
  if (!dir) { console.error('usage: bun scripts/releasescan.ts <dir> [--message <msg>]'); process.exit(2) }
  const mi = args.indexOf('--message')
  const ids = knownIds()
  const ctx: Ctx = { ids, licenseFile: 'LICENSE', licenseEmails: new Set() }
  const hits = scanDir(dir, ctx)
  if (mi >= 0) hits.push(...scanText('(commit message)', args[mi + 1] ?? '', ctx))
  for (const h of hits) console.log(`${h.file}:${h.line}: ${h.rule}: ${h.text}`)
  console.log(hits.length ? `scan: ${hits.length} hit(s)` : `scan: clean (${ids.size} conversation ids checked)`)
  process.exit(hits.length ? 1 : 0)
}
