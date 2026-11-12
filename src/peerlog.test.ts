import { expect, test } from 'bun:test'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { append, read, type PeerMessage } from './peerlog'
import { addUsage } from './transcripts'

const msg = (o: Partial<PeerMessage>): PeerMessage => ({ at: 1, from: 'lead', fromSession: 's1', fromTmux: 'd1', fromTool: 'claude', sender: 'checked', to: 'helper', toSession: 's2', toTmux: 'd2', toTool: 'codex', text: 'hi', ...o })

test('peer log keeps whole messages, filters by either side, limits to the newest', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'peerlog-')), 'peer-messages.jsonl')
  const long = 'x'.repeat(5000)
  append(msg({ at: 1, text: long }), file)
  append(msg({ at: 2, from: 'helper', to: 'lead', fromTmux: 'd2', toTmux: 'd1', text: 'done' }), file)
  append(msg({ at: 3, from: 'other', to: 'third', fromTmux: 'd3', toTmux: 'd4', fromSession: null, toSession: null }), file)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(read({}, file).map((m) => m.at)).toEqual([1, 2, 3])
  expect(read({}, file)[0]!.text.length).toBe(5000)
  expect(read({ with: 'HELPER' }, file).map((m) => m.at)).toEqual([1, 2])
  expect(read({ with: 'd3' }, file).map((m) => m.at)).toEqual([3])
  expect(read({ limit: 2 }, file).map((m) => m.at)).toEqual([2, 3])
  expect(read({ since: 2 }, file).map((m) => m.at)).toEqual([2, 3])
  expect(read({}, file + '.missing')).toEqual([])
})

test('usage counts each message id once, the last line of a message wins', () => {
  const m: any = {}
  addUsage(m, 'msg_a', { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 1 })
  addUsage(m, 'msg_a', { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 40 })
  addUsage(m, 'msg_b', { input_tokens: 3, output_tokens: 7 })
  expect(m.tokens).toEqual({ in: 118, out: 47, cacheRead: 100, cacheWrite: 5 })
})
