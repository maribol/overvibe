// ⌘K ranking [T1112-108]: sessions whose name, folder or project matches the typed words come first,
// word-aware ("videogen swipe" finds "videogen-swipe", "videogen: swipe" and "swipe videogen"). Pure, so the
// palette ranks on the client from the session list it already has, without waiting for /api/search.

/** lowercase words: runs of letters and digits, so "-", ":", "/" and spaces all split */
export const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** 0 exact name, 1 every word in the name, 2 every word starts a name word, 3 every word in the name, folder
 * or project, 4 fuzzy (the letters in order, close together, in the name); null: no match */
export type Tier = 0 | 1 | 2 | 3 | 4
/** tiers 0 to 2 are a strong name match: the Sessions group goes above the commands */
export const STRONG: Tier = 2

/** `t` holds the letters of `q` in order, spread over at most twice their length */
function fuzzy(q: string, t: string) {
  if (q.length < 3) return false
  for (let start = t.indexOf(q[0]!); start !== -1; start = t.indexOf(q[0]!, start + 1)) {
    let i = 1
    let j = start + 1
    for (; i < q.length && j < t.length && j - start < q.length * 2; j++) if (t[j] === q[i]) i++
    if (i === q.length) return true
  }
  return false
}

export function tierOf(query: string, s: { title: string; cwd?: string; project?: string }): Tier | null {
  const q = words(query)
  if (!q.length) return null
  const name = words(s.title)
  if (!name.length && !s.cwd && !s.project) return null
  if (name.join(' ') === q.join(' ') || s.title.trim().toLowerCase() === query.trim().toLowerCase()) return 0
  if (q.every((w) => name.includes(w))) return 1
  if (q.every((w) => name.some((n) => n.startsWith(w)))) return 2
  const rest = [...words(s.cwd ?? ''), ...words(s.project ?? '')]
  if (q.every((w) => name.some((n) => n.includes(w)) || rest.some((n) => n.startsWith(w)))) return 3
  if (fuzzy(q.join(''), name.join(''))) return 4
  return null
}

export type Rankable = { title: string; cwd?: string; project?: string; live?: boolean; at?: number }

/** the matches, best first: tier, then a running session, then the most recent */
export function rankSessions<T extends Rankable>(query: string, list: T[]): { item: T; tier: Tier }[] {
  return list
    .map((item) => ({ item, tier: tierOf(query, item) }))
    .filter((x): x is { item: T; tier: Tier } => x.tier !== null)
    .sort((a, b) => a.tier - b.tier || Number(!!b.item.live) - Number(!!a.item.live) || (b.item.at ?? 0) - (a.item.at ?? 0))
}

type Hit = { at: number; hl: [number, number][] }
/** a session's best text hit: the most highlighted characters, then the newest */
export function bestHit<H extends Hit>(hits: H[]): H | undefined {
  const lit = (h: H) => h.hl.reduce((n, [a, b]) => n + b - a, 0)
  return [...hits].sort((a, b) => lit(b) - lit(a) || b.at - a.at)[0]
}
