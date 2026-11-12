// Send feedback [T1112-120]: what one entry holds, shared by the server (src/feedback.ts) and the dialog
// (src/web/components/FeedbackModal.vue). Pure, so the page can import it and the test can check it.
// An entry goes into the ElasticFunnels form collection "Overvibe feedback" on overvibe.dev (code below), the
// same public form endpoint the site's /feedback page posts to, so no key ships in this repo.

export const FEEDBACK_COLLECTION = 'fr6ujp'
export const ISSUES_URL = 'https://github.com/maribol/overvibe/issues/new'
export const KINDS = [
  { id: 'feature', label: 'Feature request' },
  { id: 'bug', label: 'Bug report' },
  { id: 'other', label: 'Other' },
] as const
export type Kind = (typeof KINDS)[number]['id']
/** what "Include version and OS" adds, and nothing else: no paths, sessions, accounts or names */
export type FeedbackEnv = { version: string; os: string; tools: string }
export const MAX_MESSAGE = 5000

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The fields that go out, or an error for the dialog. Empty strings for what was left out. */
export function buildEntry(
  input: { kind?: unknown; message?: unknown; email?: unknown; include?: unknown },
  env: FeedbackEnv,
): { ok: true; fields: Record<string, string> } | { ok: false; error: string } {
  const kind = KINDS.some((k) => k.id === input.kind) ? (input.kind as Kind) : null
  if (!kind) return { ok: false, error: 'pick Feature request, Bug report or Other' }
  const message = String(input.message ?? '').trim()
  if (!message) return { ok: false, error: 'write a few words first' }
  if (message.length > MAX_MESSAGE) return { ok: false, error: `that is ${message.length} characters; ${MAX_MESSAGE} is the most` }
  const email = String(input.email ?? '').trim()
  if (email && (email.length > 200 || !EMAIL_RE.test(email))) return { ok: false, error: 'that email address does not look right' }
  const inc = input.include !== false
  return {
    ok: true,
    fields: { kind, message, email, version: inc ? env.version : '', os: inc ? env.os : '', tools: inc ? env.tools : '', source: 'app' },
  }
}

/** A new GitHub issue, prefilled: the first line as the title, the report and (when ticked) the environment in the body. */
export function issueUrl(message: string, env: FeedbackEnv | null): string {
  // a long report is cut in the body, so the URL stays well under what browsers and GitHub accept
  const text = message.trim().slice(0, 3000)
  const first = text.split('\n')[0]!.trim()
  const title = first.length > 80 ? first.slice(0, 77).trimEnd() + '...' : first
  const lines = [text || 'What happened, and what you expected:', '']
  if (env) lines.push('Environment:', `- Overvibe ${env.version}`, `- ${env.os || 'OS unknown'}`, `- CLIs: ${env.tools || 'none found'}`)
  const q = new URLSearchParams({ title: title || 'Bug report', body: lines.join('\n').trim() })
  return `${ISSUES_URL}?${q.toString()}`
}
