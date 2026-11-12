// GET /api/context?session=<name | tmux | id | id prefix>: which row is meant, and its context report [T1112-107].
import { claudeContext, claudeFile, codexContext, type ContextReport } from './context'
import { dirOf } from './accounts'
import { codexFile } from './codex'
import { meta as tmeta } from './transcripts'

type Row = { key: string; title: string; tool?: string; kind: string; sessionId: string | null; tmux: string | null; account: string | null; last: number; where: string }
export type ContextAnswer = { session: { key: string; title: string; tool: string; sessionId: string | null }; report: ContextReport | null; unavailable?: string }

/** a session by key, tmux id, conversation id or its first 8+ characters, exact name, else the newest whose name contains it */
export function pickRow<R extends Row>(rows: R[], q: string): R | undefined {
  const want = q.trim().toLowerCase()
  if (!want) return undefined
  const live = (r: R) => r.where !== 'past'
  return (
    rows.find((r) => r.key === q || r.tmux === q || r.sessionId === q) ??
    (want.length >= 8 ? rows.find((r) => r.sessionId?.startsWith(want)) : undefined) ??
    rows.filter((r) => r.title.toLowerCase() === want).sort((a, b) => Number(live(b)) - Number(live(a)) || b.last - a.last)[0] ??
    rows.filter((r) => r.title.toLowerCase().includes(want)).sort((a, b) => Number(live(b)) - Number(live(a)) || b.last - a.last)[0]
  )
}

export function contextFor(rows: Row[], q: string): ContextAnswer | { error: string; status: number } {
  if (!q) return { error: 'which session? ?session=<name or id>', status: 400 }
  let r = pickRow(rows, q)
  // a whole conversation id Overvibe never listed (a Codex or Claude run elsewhere): read its file all the same
  if (!r && /^[0-9a-f-]{36}$/i.test(q)) {
    const tool = codexFile(q) ? 'codex' : claudeFile(q) ? 'claude' : null
    if (tool) r = { key: q, title: q.slice(0, 8), tool, kind: 'claude', sessionId: q, tmux: null, account: null, last: 0, where: 'past' }
  }
  if (!r) return { error: `no session called "${q}" (overvibe ls lists them)`, status: 404 }
  const tool = r.kind === 'shell' ? 'shell' : (r.tool ?? 'claude')
  const session = { key: r.key, title: r.title, tool, sessionId: r.sessionId }
  if (tool === 'agy') return { session, report: null, unavailable: 'not available for agy: its history is a database of undocumented records, so its token counts cannot be read reliably' }
  if (tool === 'shell') return { session, report: null, unavailable: 'a terminal has no context' }
  if (!r.sessionId) return { session, report: null, unavailable: 'no conversation yet' }
  try {
    if (tool === 'codex') {
      const f = codexFile(r.sessionId)
      return f ? { session, report: codexContext(f) } : { session, report: null, unavailable: 'its rollout file was not found (older than 7 days?)' }
    }
    const f = claudeFile(r.sessionId, tmeta(r.sessionId)?.file)
    if (!f) return { session, report: null, unavailable: 'its transcript was not found' }
    const rep = claudeContext(f, r.account && r.account !== 'default' ? dirOf(r.account) : undefined)
    return rep.requests ? { session, report: rep } : { session, report: null, unavailable: 'no reply yet' }
  } catch (e: any) {
    return { error: `could not read its transcript: ${e.message}`, status: 500 }
  }
}
