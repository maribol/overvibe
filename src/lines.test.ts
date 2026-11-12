// Reading growing JSONL as bytes [T1112-112]: whole lines only, long lines, stopping, the per-read timestamp,
// and search.json written and read a line at a time (the first layout still read).
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { eachLine } from './lines'
import { lastStamp, lastStampIn } from './stamp'
import { createIndex } from './search'

const dir = () => mkdtempSync(join(tmpdir(), 'ov-lines-'))
function read(file: string, from: number, size = 4, stop?: string) {
  const fd = openSync(file, 'r')
  try {
    const got: string[] = []
    const chunks: string[] = []
    const end = eachLine(fd, from, readFileSync(file).length, (l) => {
      got.push(l.toString())
      if (stop && l.toString() === stop) return false
    }, { size, chunk: (w) => void chunks.push(w.toString()) })
    return { got, end, chunks }
  } finally {
    closeSync(fd)
  }
}

test('eachLine: whole lines, across reads and longer than the buffer; a partial last line waits', () => {
  const f = join(dir(), 'a.jsonl')
  writeFileSync(f, 'ab\n\ncdefghijklmnop\nqr\nst')
  const r = read(f, 0, 4)
  expect(r.got).toEqual(['ab', 'cdefghijklmnop', 'qr'])
  // the offset is just past "qr\n": "st" is read again once its line ends
  expect(r.end).toBe('ab\n\ncdefghijklmnop\nqr\n'.length)
  expect(r.chunks.join('')).toBe('ab\n\ncdefghijklmnop\nqr\n')
  writeFileSync(f, 'ab\n\ncdefghijklmnop\nqr\nstu\n')
  expect(read(f, r.end, 4).got).toEqual(['stu'])
})

test('eachLine: utf-8 split between reads comes out whole; false stops after that line', () => {
  const f = join(dir(), 'b.jsonl')
  writeFileSync(f, 'héllo — wörld\nnext\nlast\n')
  expect(read(f, 0, 3).got).toEqual(['héllo — wörld', 'next', 'last'])
  const r = read(f, 0, 64, 'next')
  expect(r.got).toEqual(['héllo — wörld', 'next'])
  expect(r.end).toBe(Buffer.byteLength('héllo — wörld\nnext\n'))
})

test('lastStampIn gives what lastStamp gives on the same lines', () => {
  const lines = [
    '{"type":"user","timestamp":"2026-11-11T19:40:00.000Z"}',
    '{"type":"assistant","timestamp":"2026-11-11T19:45:40.558Z","message":{"timestamp":"2026-11-11T19:44:00.000Z"}}',
    '{"type":"agent-name"}',
    '{"message":"see \\"timestamp\\":\\"2030-01-01T00:00:00Z\\""}',
  ]
  const buf = Buffer.from(lines.join('\n') + '\n')
  expect(lastStampIn(buf)).toBe(lastStamp(lines))
  expect(lastStampIn(buf)).toBe(Date.parse('2026-11-11T19:45:40.558Z'))
  expect(lastStampIn(Buffer.from('{"type":"agent-name"}\n'))).toBe(0)
  // a line with the key but no valid time: the line before counts
  expect(lastStampIn(Buffer.from('{"timestamp":"2026-11-11T10:00:00.000Z"}\n{"timestamp":"x"}\n'))).toBe(Date.parse('2026-11-11T10:00:00.000Z'))
})

test('search.json: a line per file, read back the same; the first layout is still read', async () => {
  const d = dir()
  const claude = join(d, 'claude', '-w')
  await Bun.write(join(claude, 'eeee5555-0000-0000-0000-000000000005.jsonl'), JSON.stringify({ type: 'user', userType: 'external', cwd: '/w', timestamp: '2026-11-12T09:00:00.000Z', message: { role: 'user', content: 'find the lost — ünicode words' } }) + '\n')
  const file = join(d, 'search.json')
  const a = createIndex({ claudeRoot: join(d, 'claude'), codexRoot: join(d, 'none'), file })
  await a.build()
  const text = readFileSync(file, 'utf8')
  expect(text.split('\n')[0]).toBe('{"v":1,"layout":"lines"}')
  expect(text.trim().split('\n')).toHaveLength(2)
  const b = createIndex({ claudeRoot: join(d, 'none'), codexRoot: join(d, 'none'), file })
  expect(b.search('ünicode')[0]?.sessionId).toBe('eeee5555-0000-0000-0000-000000000005')
  // the first layout: one JSON object
  const [, entry] = JSON.parse(text.split('\n')[1]!)
  writeFileSync(file, JSON.stringify({ v: 1, files: { [join(claude, 'eeee5555-0000-0000-0000-000000000005.jsonl')]: entry } }))
  const c = createIndex({ claudeRoot: join(d, 'none'), codexRoot: join(d, 'none'), file })
  expect(c.search('lost words')[0]?.sessionId).toBe('eeee5555-0000-0000-0000-000000000005')
})
