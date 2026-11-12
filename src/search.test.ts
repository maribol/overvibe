// Search inside sessions [T1112-18]: fixture transcripts and rollouts, matching, snippets, ranking, catching up.
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { createIndex, matcher, screenHits, snippet, terms } from './search'

const ts = (min: number) => new Date(Date.UTC(2026, 10, 12, 9, min)).toISOString()
const user = (text: string, min: number, extra: object = {}) => JSON.stringify({ type: 'user', userType: 'external', cwd: '/w/app', timestamp: ts(min), message: { role: 'user', content: text }, ...extra })
const said = (text: string, min: number) => JSON.stringify({ type: 'assistant', timestamp: ts(min), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const tool = (min: number) => JSON.stringify({ type: 'assistant', timestamp: ts(min), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo right click' } }] } })
const result = (min: number) => JSON.stringify({ type: 'user', userType: 'external', timestamp: ts(min), message: { role: 'user', content: [{ type: 'tool_result', content: 'right click output' }] } })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ov-search-'))
  const claude = join(root, 'claude')
  const codex = join(root, 'codex')
  mkdirSync(join(claude, '-w-app'), { recursive: true })
  mkdirSync(join(codex, '2026', '11', '12'), { recursive: true })
  writeFileSync(join(claude, '-w-app', 'aaaa1111-0000-0000-0000-000000000001.jsonl'), [
    JSON.stringify({ type: 'custom-title', customTitle: 'menus', sessionId: 'aaaa1111-0000-0000-0000-000000000001' }),
    user('Add a Right Click menu to the sidebar rows', 1),
    said('Done: right-click a row for Rename and Stop. The right click menu closes on Escape.', 2),
    tool(3),
    result(4),
    user('<system-reminder>right click injected</system-reminder>', 5),
    user('caveat right click', 6, { isMeta: true }),
    user('[overvibe message from "lead" (claude)] check the right click menu again', 7),
  ].join('\n') + '\n')
  writeFileSync(join(claude, '-w-app', 'bbbb2222-0000-0000-0000-000000000002.jsonl'), [
    user('what does a click on the right side do', 10),
    said('A click opens it.', 11),
  ].join('\n') + '\n')
  writeFileSync(join(codex, '2026', '11', '12', 'rollout-x.jsonl'), [
    JSON.stringify({ timestamp: ts(20), type: 'session_meta', payload: { id: 'cccc3333', cwd: '/w/api', timestamp: ts(20) } }),
    JSON.stringify({ timestamp: ts(21), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>right click</environment_context>' }] } }),
    JSON.stringify({ timestamp: ts(22), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'make right click copy the path' }] } }),
    JSON.stringify({ timestamp: ts(23), type: 'event_msg', payload: { type: 'user_message', message: 'make right click copy the path' } }),
    JSON.stringify({ timestamp: ts(24), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Right click now copies it.' }] } }),
  ].join('\n') + '\n')
  // a Codex subagent: never a session of its own
  writeFileSync(join(codex, '2026', '11', '12', 'rollout-sub.jsonl'), [
    JSON.stringify({ timestamp: ts(30), type: 'session_meta', payload: { id: 'dddd4444', cwd: '/w/api', parent_thread_id: 'cccc3333' } }),
    JSON.stringify({ timestamp: ts(31), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'right click review' }] } }),
  ].join('\n') + '\n')
  return { root, claude, codex, file: join(root, 'search.json') }
}

test('terms: lowercased words, quotes dropped, no repeats', () => {
  expect(terms('  "Right  Click" right ')).toEqual(['right', 'click'])
})

test('every word in the same message, any case; tool calls, results and injected text are not searched', async () => {
  const f = fixture()
  const ix = createIndex({ claudeRoot: f.claude, codexRoot: f.codex, file: null })
  await ix.build()
  const r = ix.search('right click')
  // newest match first: the Codex thread (minute 24), then the Claude ones (minutes 10 and 7)
  expect(r.map((s) => s.sessionId)).toEqual(['cccc3333', 'bbbb2222-0000-0000-0000-000000000002', 'aaaa1111-0000-0000-0000-000000000001'])
  const a = r[2]!
  expect(a.title).toBe('menus')
  expect(a.tool).toBe('claude')
  // at most 3 per session, newest first: the peer's note, Claude's reply, the owner's message
  expect(a.hits.map((h) => h.role)).toEqual(['peer', 'claude', 'you'])
  expect(a.hits.every((h) => !/injected|output|echo|caveat/.test(h.snippet))).toBe(true)
  // Codex: the user message once (event_msg repeats it), its reply, nothing from <environment_context>
  expect(r[0]!.hits.map((h) => [h.role, h.snippet])).toEqual([['codex', 'Right click now copies it.'], ['you', 'make right click copy the path']])
  expect(r[0]!.cwd).toBe('/w/api')
  // "right" and "click" apart in one message still match; in two messages they don't
  expect(r[1]!.hits.map((h) => h.snippet)).toEqual(['what does a click on the right side do'])
  expect(ix.search('opens right')).toEqual([])
  expect(ix.search('ESCAPE')[0]!.hits[0]!.role).toBe('claude')
  // the subagent's text is not in it
  expect(ix.search('review')).toEqual([])
})

test('a word matches where a word starts', () => {
  const ok = matcher(['right', 'click'])
  expect(ok('ClickBank, top right')).toBe(true)
  expect(ok('brightpath clicks')).toBe(false)
  expect(matcher(['~/work'])('in ~/Work/app')).toBe(true)
})

test('snippet: centred on the phrase, cut at spaces, highlights every word', () => {
  const long = 'x '.repeat(80) + 'then a Right Click on the row opens the menu ' + 'y '.repeat(80)
  const s = snippet(long, ['right', 'click'])
  expect(s.snippet.startsWith('…')).toBe(true)
  expect(s.snippet.endsWith('…')).toBe(true)
  expect(s.snippet.length).toBeLessThan(180)
  expect(s.hl.map(([a, b]) => s.snippet.slice(a, b))).toEqual(['Right', 'Click'])
  // overlapping words make one range; newlines become spaces
  const t = snippet('line one\nclicking here', ['click', 'clicking'])
  expect(t.snippet).toBe('line one clicking here')
  expect(t.hl.map(([a, b]) => t.snippet.slice(a, b))).toEqual(['clicking'])
})

test('catches up with appended lines and keeps the index across a restart', async () => {
  const f = fixture()
  const ix = createIndex({ claudeRoot: f.claude, codexRoot: f.codex, file: f.file })
  await ix.build()
  expect(ix.search('zebra')).toEqual([])
  appendFileSync(join(f.claude, '-w-app', 'bbbb2222-0000-0000-0000-000000000002.jsonl'), said('a zebra crossing', 40) + '\n')
  // refresh runs at most every 2 s; a new index from the saved file reads only what was appended
  ix.save()
  const again = createIndex({ claudeRoot: f.claude, codexRoot: f.codex, file: f.file })
  await again.build()
  const z = again.search('zebra')
  expect(z.map((s) => s.sessionId)).toEqual(['bbbb2222-0000-0000-0000-000000000002'])
  expect(again.search('right click').length).toBe(3)
})

test('screens: lines with every word, lowest on screen first, at most 3', () => {
  const screen = ['$ ls', 'right click here', 'nothing', 'Right-click there', 'click right', 'right click last'].join('\n')
  const h = screenHits(screen, 'right click')
  expect(h.map((x) => x.snippet)).toEqual(['right click last', 'click right', 'Right-click there'])
})
