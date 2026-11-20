import { expect, test } from 'bun:test'
import { applyLineForTest, meta, opensTurn } from './transcripts'

// [T1119-8] an AI employee's session (2026-11-19) read busy for good: its turn ended, the desk typed /compact,
// and the compaction's own user lines reopened the turn with no turn_duration after them; a background shell kept
// `claude agents` on "busy", so isBusy stayed true and the session's queued words were never typed.
const at = (s: number) => new Date(Date.UTC(2026, 10, 19, 7, 52, 0) + s * 1000).toISOString()
const sid = 'compact-turn-test-0001'
const L = (o: object) => ({ sessionId: sid, isSidechain: false, ...o })
const PAUL = [
  L({ type: 'user', message: { role: 'user', content: "this is good but i don't like the shadows" }, timestamp: at(0) }),
  L({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Shadows removed.' }], usage: { output_tokens: 5 } }, timestamp: at(50) }),
  L({ type: 'system', subtype: 'turn_duration', durationMs: 177082, timestamp: at(59) }),
  L({ type: 'user', isMeta: true, message: { content: '<local-command-caveat>The command below was run directly in Claude Code</local-command-caveat>' }, timestamp: at(61) }),
  L({ type: 'user', message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep: ids</command-args>' }, timestamp: at(61) }),
  L({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: at(97) }),
  L({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: 'This session is being continued from a previous conversation' }, timestamp: at(97) }),
  L({ type: 'user', message: { content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' }, timestamp: at(97) }),
]

test('a /compact after a finished turn leaves the turn closed; the next prompt opens one', () => {
  const file = `/nonexistent/${sid}.jsonl`
  for (const d of PAUL.slice(0, 3)) applyLineForTest(file, d)
  expect(meta(sid)?.turnOpen).toBe(false)
  for (const d of PAUL.slice(3)) applyLineForTest(file, d)
  expect(meta(sid)?.turnOpen).toBe(false)
  applyLineForTest(file, L({ type: 'user', message: { content: 'publish it when done' }, timestamp: at(600) }))
  expect(meta(sid)?.turnOpen).toBe(true)
})

test('which lines open a turn', () => {
  expect(opensTurn(PAUL[0])).toBe(true)
  expect(opensTurn(PAUL[1])).toBe(true)
  for (const d of PAUL.slice(3)) expect(opensTurn(d)).toBe(false)
  expect(opensTurn({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } })).toBe(true)
  expect(opensTurn({ type: 'user', message: { content: [{ type: 'text', text: '<command-name>/context</command-name>' }] } })).toBe(false)
  expect(opensTurn({ type: 'user', message: { content: '[overvibe message from build] done' } })).toBe(true)
})

test("Claude Code's own compaction mid-turn: the turn stays open", () => {
  const id = 'compact-turn-test-0002'
  const file = `/nonexistent/${id}.jsonl`
  applyLineForTest(file, { ...PAUL[0], sessionId: id })
  applyLineForTest(file, { ...PAUL[5], sessionId: id })
  applyLineForTest(file, { ...PAUL[6], sessionId: id })
  expect(meta(id)?.turnOpen).toBe(true)
})
