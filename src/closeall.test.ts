import { describe, expect, test } from 'bun:test'
import { flagOf, nextAfterGroup, planClose, toolLabel, type Row } from './closeall'

const row = (o: Partial<Row> = {}): Row => ({ key: 't1', where: 'deck', status: 'idle', title: 'a', kind: 'claude', tmux: 't1', sessionId: 'id1', ...o })

describe('planClose', () => {
  test('running deck rows stop, stopped and past rows are hidden, outside rows are left', () => {
    const p = planClose([
      row({ key: 'run' }),
      row({ key: 'ended', status: 'ended' }),
      row({ key: 'gone', tmux: null }),
      row({ key: 'past', where: 'past', tmux: null }),
      row({ key: 'past-noid', where: 'past', tmux: null, sessionId: null }),
      row({ key: 'term', where: 'terminal', tmux: null }),
      row({ key: 'bg', where: 'background', tmux: null }),
    ])
    expect(p.map((x) => [x.s.key, x.action])).toEqual([
      ['run', 'stop'], ['ended', 'hide'], ['gone', 'hide'], ['past', 'hide'], ['past-noid', 'skip'], ['term', 'skip'], ['bg', 'skip'],
    ])
  })
  test('only rows that will be stopped get a flag', () => {
    const p = planClose([row({ key: 'a', status: 'busy' }), row({ key: 'b', status: 'busy', tmux: null })])
    expect(p[0]!.flag).toBe('working right now')
    expect(p[1]!.flag).toBeNull()
  })
  test("Close old sessions' waiting reason is used when there is one", () => {
    const p = planClose([row({ key: 'a' })], { a: { verdict: 'waiting', reason: 'last reply asks "should I"' } })
    expect(p[0]!.flag).toBe('waiting on you: last reply asks "should I"')
    expect(planClose([row({ key: 'a' })], { a: { verdict: 'done', reason: 'idle 3h' } })[0]!.flag).toBeNull()
  })
})

describe('flagOf', () => {
  test('working, a choice, a question, an error, waiting, owes', () => {
    expect(flagOf(row({ status: 'busy' }))).toBe('working right now')
    expect(flagOf(row({ prompt: { title: 'Allow edit?' } }))).toBe('waiting on you: a choice is open: Allow edit?')
    expect(flagOf(row({ question: 'Ship it?' }))).toBe('waiting on you: Ship it?')
    expect(flagOf(row({ apiError: 'overloaded' }))).toBe('stopped on an error: overloaded')
    expect(flagOf(row({ status: 'waiting', waitingReason: 'last reply ends with a question' }))).toBe('waiting on you: last reply ends with a question')
    expect(flagOf(row({ status: 'waiting' }))).toBe('waiting on you')
    expect(flagOf(row({ owes: 'a deploy decision' }))).toBe('waiting on you: a deploy decision')
    expect(flagOf(row())).toBeNull()
  })
})

test('toolLabel', () => {
  expect(toolLabel({ kind: 'claude' })).toBe('Claude')
  expect(toolLabel({ kind: 'claude', tool: 'codex' })).toBe('Codex')
  expect(toolLabel({ kind: 'claude', tool: 'agy' })).toBe('agy')
  expect(toolLabel({ kind: 'shell' })).toBe('Terminal')
})

describe('nextAfterGroup', () => {
  const live = (k: string) => !k.startsWith('g:') && !k.startsWith('dead')
  test('goes to the first running row below the group', () => {
    expect(nextAfterGroup(['a', 'g:p', 'p1', 'p2', 'dead1', 'b', 'c'], new Set(['g:p', 'p1', 'p2']), live)).toBe('b')
  })
  test('the last group goes to the nearest running row above', () => {
    expect(nextAfterGroup(['a', 'b', 'dead1', 'g:p', 'p1'], new Set(['g:p', 'p1']), live)).toBe('b')
  })
  test('a folded group (only its header shown) still has its place', () => {
    expect(nextAfterGroup(['a', 'g:p', 'b'], new Set(['g:p', 'p1']), live)).toBe('b')
  })
  test('a pinned copy higher up does not count as below the group', () => {
    expect(nextAfterGroup(['x', 'g:p', 'p1', 'x', 'y'], new Set(['g:p', 'p1']), live)).toBe('y')
  })
  test('nothing else running: null', () => {
    expect(nextAfterGroup(['g:p', 'p1'], new Set(['g:p', 'p1']), live)).toBeNull()
  })
})
