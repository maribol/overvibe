// User link matchers [T1112-137]: entries in <data dir>/links.json, checked here on the server (bad ones are
// skipped with a reason) and compiled again in the page. Pure: no file or DOM access.
//
//   [{ "name": "Jira", "pattern": "\\b[A-Z]{2,6}-\\d{1,6}\\b", "url": "https://acme.atlassian.net/browse/$0", "label": "Open $0 in Jira" }]
//
// `url` and `label` take $0 (the whole match) and $1..$9 (the pattern's groups). The url must start with
// http:// or https://, so a match can't change where it goes.

export type UserLink = { name: string; pattern: string; url: string; label?: string; flags?: string }
export type UserLinkCheck = { ok: UserLink[]; skipped: { name: string; why: string }[] }

export const MAX_PATTERN = 300
/** a user match longer than this is not a link (also bounds how far a bad pattern can run on a line) */
export const MAX_MATCH = 300

/**
 * Patterns that can backtrack for a very long time on a line that almost matches: a group holding an unbounded
 * quantifier, repeated itself ((a+)+, (\w*)*, (x|y+){2,}), and a back-reference. A heuristic, kept on the safe side.
 */
export function riskyPattern(src: string): string | null {
  if (/\\[1-9]|\\k</.test(src)) return 'back-references are not allowed'
  // per open group: did something inside it repeat without a bound
  const stack: boolean[] = []
  let inClass = false
  let repeats = 0
  const unbounded = (i: number) => {
    const c = src[i]
    if (c === '*' || c === '+') return true
    if (c === '{') return /^\{\d*,\}/.test(src.slice(i)) || /^\{\d*,\d{2,}\}/.test(src.slice(i))
    return false
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') { i++; continue }
    if (inClass) { if (c === ']') inClass = false; continue }
    if (c === '[') { inClass = true; continue }
    if (c === '(') { stack.push(false); continue }
    if (c === ')') {
      const inner = stack.pop() ?? false
      if (inner && unbounded(i + 1)) return 'a repeated group that holds a repeat (like (a+)+) can run for a very long time'
      if (inner || unbounded(i + 1)) if (stack.length) stack[stack.length - 1] = true
      continue
    }
    if (unbounded(i)) {
      if (++repeats > 3) return 'more than 3 unbounded repeats (+, *, {n,}) can run for a very long time'
      if (stack.length) stack[stack.length - 1] = true
    }
  }
  return null
}

/** Check links.json's content: the entries that can be used, and why the others were skipped. */
export function checkUserLinks(raw: unknown): UserLinkCheck {
  const out: UserLinkCheck = { ok: [], skipped: [] }
  if (!Array.isArray(raw)) {
    if (raw !== undefined) out.skipped.push({ name: '(file)', why: 'links.json must hold a list: [{ "name", "pattern", "url" }]' })
    return out
  }
  raw.slice(0, 100).forEach((e: any, i) => {
    const name = typeof e?.name === 'string' && e.name.trim() ? e.name.trim().slice(0, 40) : `entry ${i + 1}`
    const skip = (why: string) => out.skipped.push({ name, why })
    if (!e || typeof e !== 'object') return skip('not an object')
    if (typeof e.pattern !== 'string' || !e.pattern) return skip('pattern is missing')
    if (e.pattern.length > MAX_PATTERN) return skip(`pattern is over ${MAX_PATTERN} characters`)
    if (typeof e.url !== 'string' || !/^https?:\/\/[^\s/$]/.test(e.url)) return skip('url must start with http:// or https:// and a host')
    if (e.label !== undefined && typeof e.label !== 'string') return skip('label must be text')
    const flags = typeof e.flags === 'string' ? e.flags : ''
    if (!/^[imu]*$/.test(flags)) return skip('flags may only be i, m or u')
    const risk = riskyPattern(e.pattern)
    if (risk) return skip(risk)
    let re: RegExp
    try {
      re = new RegExp(e.pattern, flags + 'g')
    } catch (err: any) {
      return skip(`bad regex: ${err.message}`)
    }
    if (re.test('')) return skip('pattern matches empty text')
    out.ok.push({ name, pattern: e.pattern, url: e.url, ...(e.label ? { label: String(e.label).slice(0, 80) } : {}), ...(flags ? { flags } : {}) })
  })
  if (raw.length > 100) out.skipped.push({ name: '(file)', why: 'only the first 100 entries are used' })
  return out
}

/** $0..$9 in a template, from a match; `enc` is applied to each inserted group */
export function fillTemplate(t: string, m: RegExpExecArray, enc: (s: string) => string = (s) => s): string {
  return t.replace(/\$(\d)/g, (_, d) => enc(m[Number(d)] ?? ''))
}
