// Close old sessions [T1111-30]: sort running sessions into "done" (safe to close), "waiting" (it asks the
// owner something) and "unsure". Pure functions only, so the rules are tested without tmux or transcripts;
// src/tidyreport.ts gathers the facts. Nothing here closes anything: the page closes what the owner ticks,
// and `overvibe tidy` only prints.

export type Verdict = 'done' | 'waiting' | 'unsure'

export type TidyFacts = {
  kind: 'claude' | 'shell' | 'login'
  tool?: string
  status: 'busy' | 'idle' | 'waiting' | 'ended' | 'blocked'
  /** ms since it last did anything */
  idleMs: number
  /** a choice menu on its screen (its title, or '' when it has none) */
  prompt?: string | null
  /** an open question the transcript shows (AskUserQuestion, a plan to approve) */
  question?: string | null
  /** its last reply, whole (from the transcript, the rollout, or the screen) */
  reply?: string | null
  /** running sessions it started */
  children?: number
  /** Claude: its last reply stopped on an API error [T1112-1] */
  apiError?: string | null
  /** Claude: a background shell or task of its own still runs (closing would end it) */
  bg?: boolean
  /** messages queued for it */
  queued?: number
  /** Claude: the owner wrote after its last reply (a newer prompt, or one queued on its input) [T1112-115] */
  answered?: boolean
  /** a shell: its foreground program is the shell itself, so nothing runs in it */
  atPrompt?: boolean
  /** the foreground program when it is not the shell */
  running?: string | null
}

export const DEFAULT_HOURS = 2
const CLIP = 600

/** "35m", "3h", "2d" */
export function idleText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

/** The end of a long reply (where a question is), with "…" in front when cut. */
export function clipReply(t: string | null | undefined, n = CLIP): string | null {
  const s = (t ?? '').trim()
  if (!s) return null
  return s.length > n ? '…' + s.slice(-n).replace(/^\S*\s/, '') : s
}

const ASKS: [RegExp, string][] = [
  [/\b(should|shall) (i|we)\b/i, 'asks "should I"'],
  [/\b(want|would you like) me to\b/i, 'offers "want me to"'],
  [/\bdo you want\b/i, 'asks "do you want"'],
  [/\blet me know\b/i, 'says "let me know"'],
  [/\b(please confirm|can you confirm|could you confirm|confirm (if|whether|which|that you|you want|before))\b/i, 'asks you to confirm'],
  [/\byour (call|decision|choice)\b/i, 'leaves a decision to you'],
  [/\b(waiting (for|on) (you|your)|need(s)? (your|you to))\b/i, 'needs something from you'],
  [/\buntil you\b/i, 'waits on something you do'],
]
// work it said it would still do: closing it would cut that off
const LATER: RegExp[] = [
  /\bI(['’]ll| will) (check|report|look|watch|follow|come back|ping|tick|merge|deploy|retry|run|let you know|send|post|update)\b/i,
  /\b(a |the )?background (watch|job|task|check|loop|monitor)\b/i,
  /\b(still running|in progress|once it (finishes|lands|is done|completes))\b/i,
]

// A context-size note the owner's rules put at the end of a reply ("Context is at 99%, so compact now:
// `/compact keep: ...`", "Context is getting large; a fresh session is better"). It is about the chat, not
// the work, and a /compact keep note runs to 1000+ characters, which pushed the real ask ("Still waiting on
// you: ...") out of the window asksOwner reads [T1112-106].
const CONTEXT_NOTE = /^\W{0,3}(context\b.{0,200}\b(\d{1,3}\s?%|compact|fresh session|getting (large|big|full))|\/compact\b)|`\/compact\b[^`]*`\W*$/i

/** A reply without its trailing context notes. */
export function withoutContextNote(reply: string | null | undefined): string {
  const paras = (reply ?? '').trim().split(/\n\s*\n/)
  while (paras.length > 1 && CONTEXT_NOTE.test(paras.at(-1)!.trim())) paras.pop()
  return paras.join('\n\n').trim()
}

/** Whether the end of a reply says it will still do something (a watch, a check later, a report to come). */
export function promisesMore(reply: string | null | undefined): boolean {
  const tail = withoutContextNote(reply).slice(-500)
  return !!tail && LATER.some((re) => re.test(tail))
}
const CHOICE = /\b(options?|which|pick|choose|prefer|approach(es)?|either)\b/i
const NUMBERED = /^\s*(\(?\d{1,2}[.)]|\(?[a-d]\)|[-*]\s+\*\*option)\s+\S/i

/**
 * Why a reply asks the owner something, or null. Looks at its end only (the last ~500 characters and
 * the last line): a question mark at the very end, the asking phrases, or a list of choices it ends on.
 */
/** the sentence records the open point somewhere the owner tracks it */
const PARKED = /\b(TASKS(\.md)?|waiting on the owner|to-?do list|logged it|noted it|added (it|T\d{4}-\d+))\b/i

export function asksOwner(reply: string | null | undefined): string | null {
  const text = withoutContextNote(reply)
  if (!text) return null
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean)
  // markdown and closing brackets after the question mark: "**Ship it?**", "(yes/no?)"
  const last = (lines.at(-1) ?? '').replace(/[*_`)\]"'”’\s]+$/, '')
  if (/\?$/.test(last)) return 'ends with a question'
  const tail = text.slice(-500)
  // a decision the session wrote down for later (a TASKS line under "Waiting on the owner") is parked there,
  // so that sentence does not hold this session open [T1112-9]
  const sentences = tail.split(/(?<=[.!?])\s+|\n+/)
  for (const [re, why] of ASKS) if (sentences.some((x) => re.test(x) && !PARKED.test(x))) return why
  // the reply ends on a numbered list of choices
  const end = lines.slice(-6)
  const numbered = end.filter((l) => NUMBERED.test(l)).length
  if (numbered >= 2 && NUMBERED.test(lines.at(-1) ?? '') && CHOICE.test(tail)) return 'offers numbered options'
  return null
}

/** The verdict for one session and a short reason. */
export function classify(f: TidyFacts, hours = DEFAULT_HOURS): { verdict: Verdict; reason: string } {
  const limit = hours * 3600_000
  const idle = idleText(f.idleMs)
  const old = f.idleMs >= limit
  if (f.kind === 'shell') {
    if (f.status === 'busy') return { verdict: 'unsure', reason: 'output in the last few seconds' }
    if (!f.atPrompt) return { verdict: 'unsure', reason: f.running ? `runs ${f.running}` : 'something runs in it' }
    if (!old) return { verdict: 'unsure', reason: `idle ${idle}, under ${hours} h` }
    return { verdict: 'done', reason: `at its prompt, idle ${idle}` }
  }
  if (f.prompt != null) return { verdict: 'waiting', reason: f.prompt ? `a choice is open: ${f.prompt}` : 'a choice is open on its screen' }
  if (f.status === 'busy') return { verdict: 'unsure', reason: 'working right now' }
  // the owner already answered: its reply to that is still to come [T1112-115]
  if (f.answered) return { verdict: 'unsure', reason: 'you answered; its reply is still to come' }
  if (f.queued) return { verdict: 'unsure', reason: `${f.queued} message${f.queued > 1 ? 's' : ''} queued for it` }
  if (f.apiError) return { verdict: 'waiting', reason: `stopped on an error: ${f.apiError}` }
  if (f.question) return { verdict: 'waiting', reason: `asked: ${f.question}` }
  const ask = asksOwner(f.reply)
  if (ask) return { verdict: 'waiting', reason: `last reply ${ask}` }
  if (promisesMore(f.reply)) return { verdict: 'unsure', reason: 'its last reply says it will still do something' }
  if (f.bg) return { verdict: 'unsure', reason: 'a background task of its own still runs' }
  if (f.children) return { verdict: 'unsure', reason: `${f.children} session${f.children > 1 ? 's' : ''} it started still running` }
  if (f.status === 'blocked') return { verdict: 'unsure', reason: 'blocked' }
  if (!f.reply) return { verdict: 'unsure', reason: old ? `idle ${idle}, no reply found` : `idle ${idle}, under ${hours} h` }
  if (!old) return { verdict: 'unsure', reason: `idle ${idle}, under ${hours} h` }
  return { verdict: 'done', reason: `idle ${idle}, last reply asks nothing` }
}

// ---------- Claude Code's screen [T1112-115] ----------
// `claude agents` can say idle, and the transcript can show the last turn closed, while Claude Code still
// works: compacting writes no user entry ("✶ Compacting conversation… (31s)"), and the owner's message
// waits queued on its input ("Press up to edit queued messages"). The screen says so.

/** Claude Code's last lines above its input box: the box, its footer and blank lines dropped. */
function aboveInput(screen: string, n = 14): string[] {
  const lines = screen.split('\n').map((l) => l.trim())
  // the input box is the last "❯" line between two rules; everything from the rule above it down is the box and footer
  let end = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯/.test(lines[i]!) && i > 0 && /^[─━]{8,}/.test(lines[i - 1]!)) {
      end = i - 1
      break
    }
  }
  return lines.slice(0, end).filter(Boolean).slice(-n)
}

/**
 * A spinner line with its elapsed timer: "✶ Compacting conversation… (31s)", "✽ Actualizing… (3s · ↓ 263
 * tokens · thought for 1s)", "✢ Running PostToolUse hooks… (2s)", "· Thinking… (esc to interrupt)". The
 * done line ("✻ Cooked for 5s · done 10:45 AM") has no "…" and does not count.
 */
const SPINNER = /^[^\w\s❯›>⏺⎿│|]\s+\S[^…]{0,80}…\s*\((\d+\s*[smh]\b|esc to interrupt)/

/** Whether Claude Code's screen shows it working (a spinner with a timer above the input box). */
export function claudeScreenBusy(screen: string | null | undefined): boolean {
  return aboveInput(screen ?? '').some((l) => SPINNER.test(l))
}

/** Whether a message waits queued on Claude Code's input ("Press up to edit queued messages"). */
export function claudeScreenQueued(screen: string | null | undefined): boolean {
  return /press up to edit queued messages/i.test((screen ?? '').split('\n').slice(-30).join('\n'))
}
