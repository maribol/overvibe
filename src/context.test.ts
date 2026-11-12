import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.OVERVIBE_DATA_DIR = mkdtempSync(join(tmpdir(), 'ov-context-'))
const { ClaudeReader, CodexReader, readInto, claudeWindow, bodyOf, toolLabel } = await import('./context')

// entry shapes as Claude Code 2.1 writes them (trimmed to the fields the reader looks at)
const T = (s: number) => new Date(Date.UTC(2026, 10, 12, 9, 0, s)).toISOString()
const usage = (input: number, read: number, write: number, out: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: out })
const userText = (uuid: string, s: number, text: string, extra: object = {}) => ({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid, timestamp: T(s), cwd: '/w/app', origin: { kind: 'human' }, ...extra })
const asst = (uuid: string, s: number, id: string, content: any[], u: object) => ({ parentUuid: null, isSidechain: false, type: 'assistant', message: { model: 'claude-opus-5-5', id, role: 'assistant', content, usage: u }, uuid, timestamp: T(s) })
const toolResult = (uuid: string, s: number, id: string, content: any) => ({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content }] }, uuid, timestamp: T(s), toolUseResult: {} })
const att = (uuid: string, s: number, attachment: object) => ({ parentUuid: null, isSidechain: false, type: 'attachment', attachment, uuid, timestamp: T(s) })

function claude(entries: object[]) {
  const r = new ClaudeReader()
  for (const e of entries) r.line(JSON.stringify(e))
  return r
}
const cat = (rep: any, k: string) => rep.categories.find((c: any) => c.key === k)?.tokens ?? 0

describe('Claude Code context [T1112-107]', () => {
  const big = 'x'.repeat(40_000) // 10k estimated tokens
  const entries = [
    { type: 'last-prompt', leafUuid: 'u9', sessionId: 's' },
    att('a1', 0, { type: 'skill_listing', content: 's'.repeat(8_000), skillCount: 40, isInitial: true }),
    userText('u1', 1, 'read the app file please'),
    // request 1: 30k in, so 30k minus the 2k skills list minus the prompt is the overhead
    asst('m1a', 2, 'msg_1', [{ type: 'thinking', thinking: '', signature: 'sig' }], usage(3, 0, 30_000, 120)),
    asst('m1b', 2, 'msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/w/app/src/App.vue' } }], usage(3, 0, 30_000, 120)),
    toolResult('u2', 3, 'toolu_1', big),
    // request 2: grew by 12k: the call, its thinking and the 10k file share it
    asst('m2', 4, 'msg_2', [{ type: 'text', text: 'Done reading.' }], usage(1, 30_000, 12_000, 10)),
    toolResult('u3', 5, 'toolu_x', 'unknown call'),
    userText('u4', 6, 'Base directory for this skill: /h/.claude/skills/tasks\n\n# tasks\n' + 'k'.repeat(4_000), { isMeta: true, origin: undefined }),
    userText('u5', 7, 'Another Claude session sent a message:\n<agent-message from="a1">\n[Subagent hand-back] The text below is the final report. The report follows:\n  Fixed the bug in a.ts\n</agent-message>', { isMeta: true, origin: { kind: 'peer', from: 'a1' } }),
    asst('m3', 8, 'msg_3', [{ type: 'text', text: 'ok' }], usage(1, 42_000, 1_400, 5)),
  ]

  test('the total is the newest request exactly, plus what came after it', () => {
    const rep = claude(entries).report(500_000, 'auto-compact window')
    expect(rep.exactInput).toBe(43_401)
    expect(rep.total).toBe(43_401 + 1) // "ok" after the last request
    expect(rep.percent).toBe(8.7)
    expect(rep.sinceCompact).toBe(false)
    const sum = rep.categories.reduce((a, c) => a + c.tokens, 0)
    expect(Math.abs(sum - rep.total)).toBeLessThanOrEqual(rep.categories.length)
  })

  test('overhead is the first request minus what its own entries hold', () => {
    const rep = claude(entries).report(null, null)
    const oh = rep.categories.find((c) => c.key === 'overhead')!
    expect(oh.parts!.find((p) => p.label === 'Skills list')!.tokens).toBe(2001) // the JSON string's quotes
    expect(oh.tokens).toBeGreaterThan(29_000)
    expect(oh.tokens).toBeLessThan(30_003)
  })

  test('tool output is split by tool and named after the call', () => {
    const rep = claude(entries).report(null, null)
    const out = rep.categories.find((c) => c.key === 'toolOutput')!
    expect(out.parts?.[0]?.label).toBe('Read')
    expect(rep.top[0]!.label).toBe('Read src/App.vue')
    expect(rep.top[0]!.at).toBe(Date.parse(T(3)))
    // the 12k growth went mostly to the 10k file; the thinking is what the 120 output tokens don't explain
    expect(rep.top[0]!.tokens).toBeGreaterThan(9_000)
    expect(cat(rep, 'thinking')).toBeGreaterThan(50)
  })

  test('skill loads and subagent hand-backs get their own rows', () => {
    const rep = claude(entries).report(null, null)
    expect(cat(rep, 'skills')).toBeGreaterThan(900)
    expect(cat(rep, 'subagents')).toBeGreaterThan(10)
    expect(rep.top.some((t) => t.label === 'Skill tasks')).toBe(true)
    expect(rep.top.find((t) => t.cat === 'subagents')?.label).toBe('Subagent: Fixed the bug in a.ts')
  })

  test('after a compact only what follows counts, and what the compact kept', () => {
    const r = claude([
      ...entries,
      { parentUuid: null, isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 43_000, preservedMessages: { uuids: ['u4'], allUuids: ['u4'] } }, uuid: 'b1', timestamp: T(20) },
      userText('u6', 20, 'This session is being continued from a previous conversation. ' + 'y'.repeat(2_000), { isCompactSummary: true, origin: undefined }),
      asst('m4', 21, 'msg_4', [{ type: 'text', text: 'Carrying on.' }], usage(5, 0, 33_000, 4)),
    ])
    const rep = r.report(null, null)
    expect(rep.sinceCompact).toBe(true)
    expect(rep.compactedAt).toBe(Date.parse(T(20)))
    expect(rep.exactInput).toBe(33_005)
    expect(cat(rep, 'toolOutput')).toBe(0) // the Read result went with the compact
    expect(cat(rep, 'skills')).toBeGreaterThan(900) // the kept skill load stays
    expect(cat(rep, 'summary')).toBe(516) // chars / 4 of the whole summary line
  })

  test('sidechain entries and synthetic replies are left out', () => {
    const r = claude([...entries, { ...asst('s1', 9, 'msg_s', [{ type: 'text', text: 'side' }], usage(1, 0, 900_000, 1)), isSidechain: true }, asst('x1', 9, 'msg_x', [{ type: 'text', text: 'API Error' }], usage(0, 0, 0, 0))].map((e: any) => (e.uuid === 'x1' ? { ...e, message: { ...e.message, model: '<synthetic>' } } : e)))
    expect(r.report(null, null).exactInput).toBe(43_401)
  })
})

describe('Codex context [T1112-107]', () => {
  const ev = (s: number, type: string, payload: object) => ({ timestamp: T(s), type, payload })
  const tc = (s: number, input: number, out: number, reason: number, total: number) =>
    ev(s, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: total, output_tokens: out, total_tokens: total + out }, last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: out, reasoning_output_tokens: reason, total_tokens: input + out }, model_context_window: 258_400 } })
  const lines = [
    ev(0, 'session_meta', { id: 'c1', cwd: '/w/app', timestamp: T(0) }),
    ev(0, 'event_msg', { type: 'task_started', model_context_window: 258_400 }),
    ev(1, 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>\n' + 's'.repeat(4_000) }] }),
    ev(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the tests' }] }),
    ev(1, 'turn_context', { model: 'gpt-5.6-sol', cwd: '/w/app' }),
    ev(2, 'response_item', { type: 'reasoning', summary: [], encrypted_content: 'gAAA' }),
    ev(2, 'response_item', { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: 'const r = await tools.exec_command({\n  cmd: "bun test",\n})' }),
    tc(2, 12_000, 300, 200, 12_000),
    ev(3, 'response_item', { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'o'.repeat(20_000) }] }),
    ev(4, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'All green.' }] }),
    tc(4, 17_300, 6, 0, 29_300),
    tc(4, 17_300, 6, 0, 29_300), // a repeat (rate limits only) changes nothing
  ]
  const read = (ls: object[]) => {
    const r = new CodexReader()
    for (const l of ls) r.line(JSON.stringify(l))
    return r.report()
  }

  test('totals come from token_count, the window from Codex', () => {
    const rep = read(lines)
    expect(rep.exactInput).toBe(17_300)
    expect(rep.total).toBe(17_306)
    expect(rep.window).toBe(258_400)
    expect(rep.requests).toBe(2)
    expect(rep.model).toBe('gpt-5.6-sol')
  })

  test('a request\'s own outputs are not part of its input', () => {
    const rep = read(lines)
    // the 5,300 growth: last request's call and reasoning (300 output) plus the 5k output
    expect(cat(rep, 'thinking')).toBeGreaterThan(150)
    expect(cat(rep, 'toolOutput')).toBeGreaterThan(4_500)
    expect(rep.top[0]!.label).toBe('exec_command bun test')
    const oh = rep.categories.find((c) => c.key === 'overhead')!
    expect(oh.parts!.find((p) => p.label === 'Skills list')!.tokens).toBe(1006)
  })

  test('a tool output written before its request\'s count goes to the next request', () => {
    // code mode: call, its output, then the count of the request that made the call
    const rep = read([
      ev(0, 'session_meta', { id: 'c2', cwd: '/w/app' }),
      ev(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }] }),
      ev(2, 'response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'tools.exec_command({cmd:"cat a.ts"})' }),
      ev(2, 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'a'.repeat(40_000) }] }),
      tc(2, 10_000, 20, 0, 10_000),
      ev(3, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Read it.' }] }),
      tc(3, 20_020, 4, 0, 30_020),
    ])
    expect(rep.top[0]!.label).toBe('exec_command cat a.ts')
    expect(rep.top[0]!.tokens).toBeGreaterThan(9_900)
    expect(rep.categories.find((c) => c.key === 'toolCalls')!.tokens).toBeLessThan(40)
  })

  test('a compact starts over from the history it hands over', () => {
    const rep = read([...lines, ev(9, 'compacted', { message: '', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the tests' }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summary '.repeat(500) }] }] }), tc(10, 9_000, 10, 0, 38_300)])
    expect(rep.sinceCompact).toBe(true)
    expect(rep.exactInput).toBe(9_000)
    expect(cat(rep, 'toolOutput')).toBe(0)
  })
})

describe('reading files [T1112-107]', () => {
  test('a growing file is read only from where the last read stopped', () => {
    const f = join(process.env.OVERVIBE_DATA_DIR!, 's.jsonl')
    writeFileSync(f, JSON.stringify(userText('u1', 1, 'hi')) + '\n' + JSON.stringify(asst('m1', 2, 'msg_1', [{ type: 'text', text: 'hello' }], usage(1, 0, 20_000, 2))) + '\n')
    const r1 = readInto(f, () => new ClaudeReader()) as InstanceType<typeof ClaudeReader>
    expect(r1.report(null, null).exactInput).toBe(20_001)
    // half a line: waits for the rest
    const next = JSON.stringify(asst('m2', 3, 'msg_2', [{ type: 'text', text: 'again' }], usage(1, 20_000, 500, 2)))
    appendFileSync(f, next.slice(0, 40))
    const r2 = readInto(f, () => new ClaudeReader()) as InstanceType<typeof ClaudeReader>
    expect(r2).toBe(r1)
    expect(r2.report(null, null).exactInput).toBe(20_001)
    appendFileSync(f, next.slice(40) + '\n')
    expect((readInto(f, () => new ClaudeReader()) as any).report(null, null).exactInput).toBe(20_501)
  })
})

describe('helpers [T1112-107]', () => {
  test('the window is the auto-compact setting, else the model\'s, else unknown', () => {
    const old = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '500000'
    expect(claudeWindow('claude-opus-5-5').window).toBe(500_000)
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = ''
    const dir = mkdtempSync(join(tmpdir(), 'ov-cfg-'))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' } }))
    expect(claudeWindow('claude-opus-5-5', dir).window).toBe(400_000)
    if (old === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = old
  })
  test('labels', () => {
    expect(toolLabel('Bash', { command: 'ls', description: 'List files' })).toBe('Bash List files')
    expect(bodyOf('Another Claude session sent a message:\n<agent-message from="a">\nhello\n</agent-message>').trim()).toBe('hello')
  })
})
