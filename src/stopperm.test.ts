import { describe, expect, test } from 'bun:test'
import { childrenOf, mayStop, starterOf, startedBy, type DeckRecord } from './sessions'

const rec = (o: Partial<DeckRecord>): DeckRecord => ({ tmux: 'x', sessionId: '', cwd: '/tmp', account: '', name: 'x', createdAt: 0, kind: 'claude', ...o }) as DeckRecord

describe('who may stop a terminal [T1111-21]', () => {
  const me = rec({ tmux: 'me', sessionId: 'sid-me', name: 'me' })
  const other = rec({ tmux: 'other', sessionId: 'sid-other', name: 'other' })
  const mine = rec({ tmux: 't1', kind: 'shell', name: 't21 test', ...starterOf(me) })
  const owners = rec({ tmux: 't2', kind: 'shell', name: 'links test' })
  const theirs = rec({ tmux: 't3', kind: 'shell', name: 'their test', ...starterOf(other) })

  test('a terminal records the session that started it, not attached', () => {
    expect(starterOf(me)).toEqual({ parent: 'me', parentId: 'sid-me' })
    expect(starterOf(undefined)).toEqual({})
    expect(mine.attached).toBeUndefined()
    expect(startedBy(mine, me)).toBe(true)
  })
  test('the starter may stop its own terminal, after a move too (by conversation id)', () => {
    expect(mayStop(mine, me)).toBe(true)
    const moved = rec({ tmux: 'me2', sessionId: 'sid-me' })
    expect(mayStop(mine, moved)).toBe(true)
  })
  test("a session can't stop a terminal it did not start, or the owner's", () => {
    expect(mayStop(owners, me)).toBe(false)
    expect(mayStop(theirs, me)).toBe(false)
    expect(mayStop(other, me)).toBe(false)
  })
  test('a terminal with no conversation id does not match a starter with none', () => {
    const shellCaller = rec({ tmux: 's', kind: 'shell', sessionId: '' })
    expect(mayStop(rec({ tmux: 't4', kind: 'shell', parent: 'zz' }), shellCaller)).toBe(false)
  })
  test('the owner (no calling session) may stop anything; a session may stop itself', () => {
    expect(mayStop(owners, undefined)).toBe(true)
    expect(mayStop(theirs, undefined)).toBe(true)
    expect(mayStop(me, me)).toBe(true)
  })
  test('--children: attached agent children and running terminals it started, nothing else', () => {
    const kid = rec({ tmux: 'k1', ...starterOf(me), attached: true })
    const loose = rec({ tmux: 'k2', ...starterOf(me) })
    const closed = rec({ tmux: 'k3', ...starterOf(me), attached: true, closedAt: 1 })
    const gone = rec({ tmux: 't5', kind: 'shell', ...starterOf(me) })
    const all = [me, other, mine, owners, theirs, kid, loose, closed, gone]
    const got = childrenOf(all, me, new Set(['me', 'other', 't1', 't2', 't3', 'k1', 'k2']))
    expect(got.map((r) => r.tmux).sort()).toEqual(['k1', 't1'])
  })
})
