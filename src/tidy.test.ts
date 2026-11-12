import { describe, expect, test } from 'bun:test'
import { asksOwner, classify, clipReply, idleText, promisesMore, withoutContextNote, type TidyFacts } from './tidy'

const H = 3600_000
const agent = (o: Partial<TidyFacts> = {}): TidyFacts => ({ kind: 'claude', tool: 'claude', status: 'idle', idleMs: 3 * H, reply: 'Done. Tests pass and the fix is on main.', ...o })

describe('asksOwner', () => {
  test('a plain report asks nothing', () => {
    expect(asksOwner('Shipped in 1a2b3c. bun test: 40 pass.')).toBeNull()
    expect(asksOwner('')).toBeNull()
    expect(asksOwner(null)).toBeNull()
  })
  test('a question at the end', () => {
    expect(asksOwner('All set.\n\nShip it?')).toBe('ends with a question')
    expect(asksOwner('Found two ways.\n**Which one do you prefer?**')).toBe('ends with a question')
  })
  test('a question earlier in a long reply does not count, but asking phrases near the end do', () => {
    expect(asksOwner('Why did it fail? The cache was stale. Fixed in abc.')).toBeNull()
    expect(asksOwner('Fixed the build. Want me to also update the docs.')).toBe('offers "want me to"')
    expect(asksOwner('The deploy is ready. Let me know when to push.')).toBe('says "let me know"')
    expect(asksOwner('Should I merge it now or wait for review.')).toBe('asks "should I"')
    expect(asksOwner('Please confirm the account before I send it.')).toBe('asks you to confirm')
    expect(asksOwner('Do you want the long version.')).toBe('asks "do you want"')
  })
  test('"confirmed" in a report is not a request', () => {
    expect(asksOwner('I confirmed the tests pass. Done.')).toBeNull()
  })
  test('ending on numbered choices', () => {
    expect(asksOwner('Two options:\n1. Keep the cache\n2. Drop it')).toBe('offers numbered options')
    // a numbered summary of work done is not a choice
    expect(asksOwner('Done:\n1. Fixed the parser\n2. Added tests')).toBeNull()
    // the list is not at the end
    expect(asksOwner('Options were:\n1. A\n2. B\nI went with A and shipped it.')).toBeNull()
  })
})

// real reply shapes from a long session (T1112-106): the ask sits above a /compact keep note of 1000+ characters
const KEEP = '`/compact keep: smoke done T1112-98 (517edef, fixes e0477f3 fbee4e1; bun run smoke 52 pass); owner decisions pending: T1112-103 Codex update check off (recommended), maker copy+PNG (gated until assets-src/sami-f1.png), copywriting menu, telemetry row; follow-ups T1112-104 agy/Codex no conversation id, T1112-105 queued msg survives stop; site review agent (T1112-6) owns site push incl. nav restyle + double-highlight fix + T1112-5/7 strings; auto-mode agent on T1112-100 Settings pages; site-features agent running; done: T1112-99 fda69c2, T1112-101 0de255c, T1112-102 6cb6246; rule: pre-launch no change framing; go-live: clean-HOME install + Linux/WSL, memory ~690 MB, README hero, SECURITY.md, leftover-English sweep; owner: GitHub repos, private reporting, logo, launch day; push = fresh single commit, confirm first`'
const SMOKE = [
  'The smoke test is in and passing: `bun run smoke` checks 52 things in about 1½ minutes, with 0 failures and 2 skips.',
  'The 2 skips:\n- **Codex started without a prompt.** Decision for you (T1112-103): should Overvibe start Codex with its update check off? I\'d turn the check off.\n- **Resuming agy.** Overvibe doesn\'t record agy\'s conversation id (T1112-104).',
  'Also logged: a message queued to a session that then stops could be typed into it later if it\'s resumed (T1112-105).',
  'Still waiting on you: Codex\'s update check (I\'d turn it off), the "Hi, I\'m Sam" wording plus your PNG, the copywriting menu, and the comparison telemetry row.',
].join('\n\n')

describe('a trailing context note is not where the ask is [T1112-106]', () => {
  test('"Still waiting on you:" above a long /compact keep line', () => {
    expect(asksOwner(`${SMOKE}\n\nContext is at 99%, so compact now: ${KEEP}`)).toBe('needs something from you')
    expect(asksOwner(`${SMOKE}\n\nContext is about 99%, so compact now: ${KEEP}`)).toBe('needs something from you')
    expect(classify(agent({ reply: `${SMOKE}\n\nContext is at 99%, so compact now: ${KEEP}`, bg: true, idleMs: 60_000 })).verdict).toBe('waiting')
  })
  test('a question just above the note', () => {
    expect(asksOwner(`Both builds are green.\n\nShip it to the site now?\n\nContext is at 60%; compact at the next break: ${KEEP}`)).toBe('ends with a question')
    expect(asksOwner('Two ways to do it.\n\n**Which one do you prefer?**\n\nContext is getting large; a fresh session is better for the next task.')).toBe('ends with a question')
  })
  test('a status-only reply with the same note asks nothing', () => {
    const status = 'Close all is in (commit 6cb6246) and works on the live app. Confirming stops and hides them all; nothing is deleted. 220 tests pass.'
    expect(asksOwner(`${status}\n\nContext is at 99%, so compact now: ${KEEP}`)).toBeNull()
    expect(classify(agent({ reply: `${status}\n\nContext is at 99%, so compact now: ${KEEP}`, bg: true })).verdict).toBe('unsure')
  })
  test('withoutContextNote keeps the reply when it is only the note, and keeps other paragraphs', () => {
    expect(withoutContextNote('Context is at 99%, so compact now.')).toBe('Context is at 99%, so compact now.')
    expect(withoutContextNote(`Done.\n\n${KEEP}`)).toBe('Done.')
    expect(withoutContextNote('Done.\n\nThe context menu now has Close all.')).toBe('Done.\n\nThe context menu now has Close all.')
  })
})

test('promisesMore: follow-up work in the reply', () => {
  expect(promisesMore('A background watch checks both sites every 30 minutes; I will report what it shows.')).toBe(true)
  expect(promisesMore("I'll check the cleanup log after it runs.")).toBe(true)
  expect(promisesMore('Merged and deployed; nothing left.')).toBe(false)
  expect(classify(agent({ reply: "Deployed. I'll check the logs in an hour." })).reason).toBe('its last reply says it will still do something')
  expect(asksOwner('It stays in the cache until you purge it in Bunny.')).toBe('waits on something you do')
})

describe('classify', () => {
  test('done: old, quiet, nothing asked', () => {
    expect(classify(agent())).toEqual({ verdict: 'done', reason: 'idle 3h, last reply asks nothing' })
  })
  test('waiting: an open menu, an open question, or a reply that asks', () => {
    expect(classify(agent({ prompt: 'Allow this command?' })).verdict).toBe('waiting')
    expect(classify(agent({ prompt: '' })).reason).toBe('a choice is open on its screen')
    expect(classify(agent({ question: 'Approve the plan?', status: 'waiting' })).reason).toBe('asked: Approve the plan?')
    expect(classify(agent({ reply: 'Ready. Deploy now?' })).verdict).toBe('waiting')
    // waiting does not need the idle time
    expect(classify(agent({ reply: 'Ready. Deploy now?', idleMs: 60_000 })).verdict).toBe('waiting')
  })
  test('unsure: busy, children, queued, too recent, no reply', () => {
    expect(classify(agent({ status: 'busy' })).reason).toBe('working right now')
    expect(classify(agent({ status: 'busy', reply: 'Ship it?' })).verdict).toBe('unsure')
    expect(classify(agent({ children: 2 })).reason).toBe('2 sessions it started still running')
    expect(classify(agent({ queued: 1 })).reason).toBe('1 message queued for it')
    expect(classify(agent({ idleMs: 40 * 60_000 })).reason).toBe('idle 40m, under 2 h')
    expect(classify(agent({ reply: null })).reason).toBe('idle 3h, no reply found')
  })
  test('hours changes the bar', () => {
    expect(classify(agent({ idleMs: 40 * 60_000 }), 0.5).verdict).toBe('done')
    expect(classify(agent(), 4).verdict).toBe('unsure')
  })
  test('shells: done only at a bare prompt after the idle time', () => {
    const sh = (o: Partial<TidyFacts>): TidyFacts => ({ kind: 'shell', status: 'idle', idleMs: 3 * H, atPrompt: true, ...o })
    expect(classify(sh({})).verdict).toBe('done')
    expect(classify(sh({ atPrompt: false, running: 'node' })).reason).toBe('runs node')
    expect(classify(sh({ idleMs: H })).verdict).toBe('unsure')
    expect(classify(sh({ status: 'busy' })).verdict).toBe('unsure')
  })
})

test('idleText and clipReply', () => {
  expect(idleText(5 * 60_000)).toBe('5m')
  expect(idleText(5 * H)).toBe('5h')
  expect(idleText(72 * H)).toBe('3d')
  expect(clipReply('short')).toBe('short')
  const long = 'word '.repeat(300) + 'Ship it?'
  const c = clipReply(long, 50)!
  expect(c.startsWith('…')).toBe(true)
  expect(c.endsWith('Ship it?')).toBe(true)
  expect(c.length).toBeLessThanOrEqual(51)
})

test('a Claude session with its own background task still running is unsure', async () => {
  const { classify } = await import('./tidy')
  expect(classify({ kind: 'claude', tool: 'claude', status: 'idle', idleMs: 5 * 3600_000, reply: 'All done.', bg: true }, 2).verdict).toBe('unsure')
})

test('a session stopped on an API error waits on the owner [T1112-1]', async () => {
  const { classify } = await import('./tidy')
  const v = classify({ kind: 'claude', tool: 'claude', status: 'idle', idleMs: 5 * 3600_000, reply: 'Part 2 looks fine.', apiError: 'Your computer went to sleep mid-response.' }, 2)
  expect(v.verdict).toBe('waiting')
})

test('a decision parked in TASKS does not hold the session open [T1112-9]', async () => {
  const { asksOwner } = await import('./tidy')
  expect(asksOwner('In TASKS.md I ticked T1111-5. I added T1112-1 under "Waiting on the owner": the .cc sitemap problem and your decision on whether to keep using .cc domains. Both changes are committed and pushed.')).toBeNull()
  expect(asksOwner('Both are pushed. Whether to keep the .cc domains is your call.')).toBe('leaves a decision to you')
  expect(asksOwner('I added it to TASKS. Ship it now?')).toBe('ends with a question')
})
