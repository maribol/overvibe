// The "waiting on you" hand clears once the owner answers [T1112-115]: Claude compacting reads busy from
// its screen, and a newer owner prompt or a queued message counts as the answer.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.OVERVIBE_DATA_DIR = mkdtempSync(join(tmpdir(), 'ov-handclear-'))
const { claudeScreenBusy, claudeScreenQueued, classify } = await import('./tidy')
const { replyState } = await import('./summary')

const RULE = '─'.repeat(120)
const box = (title = '') => [`${RULE}${title ? ` ${title} ─` : ''}`, '❯ ', RULE, '  Opus 5.5 · videogen · ctx 69k/500k (14%)', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n')

// the live case: the owner typed "hows it going" while Claude Code compacted
const COMPACTING = [
  '✻ Cooked for 5s · done 10:45 AM',
  '',
  '❯ /compact keep T1111-12: parts 1 and 3 held',
  '',
  '✶ Compacting conversation… (31s)',
  '',
  '❯ hows it going',
  '',
  box('social media video clipping'),
  '  Press up to edit queued messages',
].join('\n')

const WORKING = ['❯ hows it going', '', '⏺ Running 1 shell command…', '', '✽ Actualizing… (3s · ↓ 263 tokens · thought for 1s)', '', box('social media video clipping')].join('\n')
const HOOKS = ['⏺ Bash(bun test)', '  ⎿  40 pass', '', '✢ Running PostToolUse hooks… (2s)', '', box()].join('\n')
const LONG = ['✳ Thinking… (1m 12s · ↑ 3.1k tokens · esc to interrupt)', '', box()].join('\n')
const IDLE = ['⏺ Both builds are green. Ship it to the site now?', '', '✻ Cooked for 5s · done 10:45 AM', '', box()].join('\n')
// a reply that quotes a spinner, and a spinner typed into the input box, are not the tool working
const QUOTED = ['⏺ The screen showed "✶ Compacting conversation… (31s)" at the time.', '', box()].join('\n').replace('❯ ', '❯ ✶ Compacting conversation… (31s)')

describe('Claude screen', () => {
  test('a spinner with a timer above the input box is busy', () => {
    expect(claudeScreenBusy(COMPACTING)).toBe(true)
    expect(claudeScreenBusy(WORKING)).toBe(true)
    expect(claudeScreenBusy(HOOKS)).toBe(true)
    expect(claudeScreenBusy(LONG)).toBe(true)
  })
  test('the done line, a quoted spinner and an empty screen are not', () => {
    expect(claudeScreenBusy(IDLE)).toBe(false)
    expect(claudeScreenBusy(QUOTED)).toBe(false)
    expect(claudeScreenBusy('')).toBe(false)
    expect(claudeScreenBusy(null)).toBe(false)
  })
  test('a message queued on its input', () => {
    expect(claudeScreenQueued(COMPACTING)).toBe(true)
    expect(claudeScreenQueued(WORKING)).toBe(false)
    expect(claudeScreenQueued(IDLE)).toBe(false)
  })
})

describe('the owner answered', () => {
  const ASK = 'Part 2 is held for your OK.\n\nStill waiting on you: the stricter picture rule.'
  const dir = mkdtempSync(join(tmpdir(), 'ov-handclear-t-'))
  let n = 0
  const file = (lines: object[]) => {
    const f = join(dir, `${++n}.jsonl`)
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return f
  }
  const user = (text: string) => ({ type: 'user', userType: 'external', timestamp: '2026-11-12T10:00:00Z', message: { role: 'user', content: text } })
  const reply = (text: string) => ({ type: 'assistant', timestamp: '2026-11-12T10:01:00Z', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] } })
  const turnEnd = { type: 'system', subtype: 'turn_duration', durationMs: 5000 }

  test('the ask alone is not answered', () => {
    expect(replyState(file([user('how are parts 1 to 3'), reply(ASK), turnEnd]))).toEqual({ reply: ASK, answered: false })
  })
  test('a newer owner prompt answers it', () => {
    expect(replyState(file([user('go'), reply(ASK), turnEnd, user('hows it going')])).answered).toBe(true)
  })
  test('a message Claude Code queued mid-turn answers it', () => {
    const q = { type: 'attachment', attachment: { type: 'queued_command', prompt: 'hows it going', origin: { kind: 'human' } } }
    expect(replyState(file([user('go'), reply(ASK), q])).answered).toBe(true)
  })
  test('a slash command, a peer message or a tool result is not an answer', () => {
    const cmd = user('<command-name>/compact</command-name>')
    const peer = user('[overvibe message from build] done')
    const tool = { type: 'user', userType: 'external', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }
    expect(replyState(file([user('go'), reply(ASK), turnEnd, cmd, peer, tool])).answered).toBe(false)
  })
  test('a newer reply after the answer resets it', () => {
    expect(replyState(file([user('go'), reply(ASK), user('yes ship it'), reply('Shipped. Anything else?')]))).toEqual({ reply: 'Shipped. Anything else?', answered: false })
  })
})

describe('classify', () => {
  const base = { kind: 'claude' as const, tool: 'claude', status: 'idle' as const, idleMs: 60_000, reply: 'Both are pushed. Whether to keep the .cc domains is your call.' }
  test('the ask waits on the owner until answered', () => {
    expect(classify(base).verdict).toBe('waiting')
    expect(classify({ ...base, answered: true })).toEqual({ verdict: 'unsure', reason: 'you answered; its reply is still to come' })
    expect(classify({ ...base, queued: 1 }).verdict).toBe('unsure')
    expect(classify({ ...base, status: 'busy' }).verdict).toBe('unsure')
  })
})
