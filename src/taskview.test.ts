import { describe, expect, test } from 'bun:test'
import { FOLLOW_ALL_ASK, countsDetail, countsTip, followupAllMessage, followupContext, followupGroups, followupMessage, fileForCwd, followupTargets, openCounts, sessionTip, shortText, type TaskLine } from './taskview'

const row = (o: Partial<{ key: string; where: string; status: string; sessionId: string | null; tmux: string | null; kind: string; title: string; tool: string; noTranscript: boolean }>) => ({ key: 'k', where: 'deck', status: 'idle', sessionId: 'aaaaaaaa-1111', tmux: 'k', kind: 'claude', title: 'adder', ...o })
const line = (o: Partial<TaskLine>): TaskLine => ({ done: false, id: 'T1112-1', date: '2026-11-12', text: 'x', sessions: [], section: 'todo', day: null, ...o })

describe('followupTargets', () => {
  test('running adder first: typed into it', () => {
    const t = followupTargets(['aaaaaaaa'], [row({})])
    expect(t[0]).toEqual({ kind: 'send', key: 'k', title: 'adder' })
    expect(t.slice(1).map((x) => x.kind)).toEqual(['new', 'new'])
  })
  test('stopped adder: resumed', () => {
    const t = followupTargets(['aaaaaaaa'], [row({ tmux: null, key: 'aaaaaaaa-1111' })])
    expect(t[0]).toMatchObject({ kind: 'resume', sessionId: 'aaaaaaaa-1111' })
  })
  test('past row resumed; gone transcript is not', () => {
    expect(followupTargets(['aaaaaaaa'], [row({ where: 'past', tmux: null })])[0]!.kind).toBe('resume')
    expect(followupTargets(['aaaaaaaa'], [row({ where: 'past', tmux: null, noTranscript: true })])[0]).toEqual({ kind: 'new', tool: 'claude' })
  })
  test('adder in a Terminal tab or unknown: new session in the project', () => {
    expect(followupTargets(['aaaaaaaa'], [row({ where: 'terminal' }), row({ where: 'past', tmux: null })])[0]).toEqual({ kind: 'new', tool: 'claude' })
    expect(followupTargets(['bbbbbbbb'], [row({})])[0]).toEqual({ kind: 'new', tool: 'claude' })
    expect(followupTargets([], [])).toEqual([{ kind: 'new', tool: 'claude' }, { kind: 'new', tool: 'codex' }])
  })
  test('a shell with the same id prefix is never a target', () => {
    expect(followupTargets(['aaaaaaaa'], [row({ kind: 'shell' })])[0]!.kind).toBe('new')
  })
  test('running wins over its stopped copy', () => {
    const t = followupTargets(['aaaaaaaa'], [row({ where: 'past', tmux: null, key: 'p' }), row({ key: 'live' })])
    expect(t[0]).toMatchObject({ kind: 'send', key: 'live' })
  })
})

describe('followupContext', () => {
  test('id and the quoted line', () => {
    expect(followupContext({ id: 'T1112-1', text: 'Google never  fetches\\nsitemaps' })).toBe('About T1112-1 in TASKS.md ("Google never fetches\\nsitemaps"):')
  })
  test('long lines are cut at a word', () => {
    const p = followupContext({ id: 'T1', text: 'word '.repeat(200) }, 20)
    expect(p).toBe('About T1 in TASKS.md ("word word word word..."):')
  })
})

describe('followupMessage [T1112-92]', () => {
  const t = { id: 'T1112-1', text: 'Google never fetches sitemaps' }
  test('nothing typed: nothing to send', () => {
    expect(followupMessage(t, '')).toBeNull()
    expect(followupMessage(t, '  \n\t ')).toBeNull()
  })
  test('the answer on the line after the context, every line kept', () => {
    expect(followupMessage(t, 'keep .cc\n\nand resubmit weekly\n')).toBe('About T1112-1 in TASKS.md ("Google never fetches sitemaps"):\nkeep .cc\n\nand resubmit weekly')
  })
  test('a long answer is not cut', () => {
    const a = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    expect(followupMessage(t, a)!.endsWith('line 199')).toBe(true)
  })
})

describe('openCounts', () => {
  test('every open line counts, with or without an id; waiting counted apart [T1112-117]', () => {
    const f = [{ tasks: [line({}), line({ section: 'waiting' }), line({ done: true }), line({ section: 'done' }), line({ id: null }), line({ id: null, date: null }), line({ date: '2026-11-01' })] }]
    expect(openCounts(f, '')).toEqual({ open: 5, waiting: 1, projects: 1 })
  })
  test('a fresh start counts only lines dated on or after it; undated lines are older', () => {
    const f = [{ tasks: [line({}), line({ section: 'waiting' }), line({ id: null }), line({ id: null, date: null }), line({ date: '2026-11-01' })] }]
    expect(openCounts(f, '2026-11-10')).toEqual({ open: 3, waiting: 1, projects: 1 })
  })
  test('projects with an open line; a worktree copy is not counted twice', () => {
    const f = [{ tasks: [line({})] }, { tasks: [line({ done: true })] }, { tasks: [line({}), line({})] }, { tasks: [line({})], copyOf: '~/Work/a/TASKS.md' }]
    expect(openCounts(f, '')).toEqual({ open: 3, waiting: 0, projects: 2 })
  })
})

describe('countsTip [T1112-117]', () => {
  test('numbers in words', () => {
    expect(countsTip({ open: 2176, waiting: 1, projects: 9 }, '')).toBe('2,176 open in 9 projects, 1 waiting on you')
    expect(countsTip({ open: 1, waiting: 0, projects: 1 }, '')).toBe('1 open in 1 project')
    expect(countsTip({ open: 0, waiting: 0, projects: 0 }, '')).toBe('Nothing open')
  })
  test('says when Start fresh hides older lines', () => {
    expect(countsTip({ open: 35, waiting: 1, projects: 9 }, '2026-11-12')).toBe('35 open in 9 projects, 1 waiting on you. Start fresh is on: only lines dated 2026-11-12 or later count.')
  })
})

describe('sessionTip [T1112-116]', () => {
  const files = [
    { root: '~/Work/a', tasks: [
      line({ id: 'T1112-1', text: 'todo mine', sessions: ['e411f976'] }),
      line({ id: 'T1112-2', text: 'todo other', sessions: ['bbbbbbbb'] }),
      line({ id: 'T1112-3', text: 'waits on owner', sessions: ['e411f976'], section: 'waiting' }),
      line({ id: 'T1112-4', text: 'ticked', sessions: ['e411f976'], done: true, section: 'done' }),
      line({ id: 'T1112-5', text: 'ticked under To do', sessions: ['e411f976'], done: true }),
      line({ id: 'T1112-6', text: 'earlier id', sessions: ['cccccccc'] }),
    ] },
    { root: '~/Work/a/sub', tasks: [line({ id: 'T1112-9', sessions: ['e411f976'] })] },
  ]
  test('its open tagged lines, waiting first, plus the project totals', () => {
    const t = sessionTip(files, '~/Work/a/src', ['e411f976-5be7-4470-bb9d-204cc963de47'], '')!
    // a line without an id (before the id rule) is open too and listed [T1112-117]
    expect(t.lines.map((x) => x.id)).toEqual(['T1112-3', 'T1112-1'])
    expect(t.lines[0]!.waiting).toBe(true)
    expect(t).toMatchObject({ more: 0, open: 4, waiting: 1 })
  })
  test('ids from earlier conversations of the same row count too', () => {
    const t = sessionTip(files, '~/Work/a', ['e411f976-x', null, 'cccccccc-y'], '')!
    expect(t.lines.map((x) => x.id)).toEqual(['T1112-3', 'T1112-1', 'T1112-6'])
  })
  test('no tagged lines: only the totals; no TASKS.md: null', () => {
    expect(sessionTip(files, '~/Work/a', ['dddddddd-1'], '')).toMatchObject({ lines: [], open: 4, waiting: 1 })
    expect(sessionTip(files, '~/Work/a', [null], '')!.lines).toEqual([])
    expect(sessionTip(files, '~/Work/b', ['e411f976'], '')).toBeNull()
    expect(sessionTip(files, '~/Work/ab', ['e411f976'], '')).toBeNull()
  })
  test('the nearest TASKS.md wins', () => {
    expect(fileForCwd(files, '~/Work/a/sub/x')!.root).toBe('~/Work/a/sub')
    expect(sessionTip(files, '~/Work/a/sub', ['e411f976'], '')!.lines.map((x) => x.id)).toEqual(['T1112-9'])
  })
  test('up to max lines, then how many more', () => {
    const many = [{ root: '~/r', tasks: Array.from({ length: 9 }, (_, i) => line({ id: `T1112-${i}`, sessions: ['e411f976'] })) }]
    const t = sessionTip(many, '~/r', ['e411f976'], '')!
    expect(t.lines.length).toBe(6)
    expect(t.more).toBe(3)
  })
  test('"start fresh" hides older lines from both the list and the totals', () => {
    const t = sessionTip([{ root: '~/r', tasks: [line({ date: '2026-11-01', sessions: ['e411f976'] }), line({ date: '2026-11-12', sessions: ['e411f976'] })] }], '~/r', ['e411f976'], '2026-11-10')!
    expect(t).toMatchObject({ open: 1 })
    expect(t.lines.length).toBe(1)
  })
  test('shortText cuts at a word', () => {
    expect(shortText('a  b')).toBe('a b')
    expect(shortText('one two three four', 10)).toBe('one two...')
  })
})

describe('followupGroups [T1112-118]', () => {
  const rows = [
    row({ key: 'live', sessionId: 'aaaaaaaa-1', title: 'running one', status: 'working' }),
    row({ key: 'old', sessionId: 'bbbbbbbb-1', tmux: null, where: 'past', title: 'stopped one', tool: 'codex' }),
    row({ key: 'tab', sessionId: 'cccccccc-1', where: 'terminal', title: 'in a Terminal tab' }),
  ]
  test('one group per session, running first, then stopped, unknown, no session', () => {
    const g = followupGroups([
      line({ id: 'T1', sessions: [] }),
      line({ id: 'T2', sessions: ['bbbbbbbb'] }),
      line({ id: 'T3', sessions: ['aaaaaaaa'] }),
      line({ id: 'T4', sessions: ['dddddddd'] }),
      line({ id: 'T5', sessions: ['aaaaaaaa'], section: 'waiting' }),
      line({ id: 'T6', sessions: ['cccccccc'] }),
    ], rows)
    expect(g.map((x) => [x.kind, x.lines.map((l) => l.id)])).toEqual([
      ['send', ['T3', 'T5']],
      ['resume', ['T2']],
      ['unknown', ['T4']],
      ['unknown', ['T6']],
      ['none', ['T1']],
    ])
    expect(g[0]).toMatchObject({ key: 'live', title: 'running one', status: 'working' })
    expect(g[1]).toMatchObject({ sessionId: 'bbbbbbbb-1', tool: 'codex' })
  })
  test('done lines are left out', () => {
    expect(followupGroups([line({ done: true, sessions: ['aaaaaaaa'] }), line({ section: 'done', sessions: ['aaaaaaaa'] })], rows)).toEqual([])
  })
  test('several tags: the latest that resolves', () => {
    const g = followupGroups([line({ id: 'T1', sessions: ['aaaaaaaa', 'bbbbbbbb'] }), line({ id: 'T2', sessions: ['aaaaaaaa', 'dddddddd'] })], rows)
    expect(g.map((x) => [x.key, x.lines.map((l) => l.id)])).toEqual([['live', ['T2']], ['old', ['T1']]])
  })
})

describe('followupAllMessage [T1112-118]', () => {
  test('lines quoted, then the ask', () => {
    expect(followupAllMessage([{ id: 'T1', text: 'a  b' }, { id: null, text: 'c' }], FOLLOW_ALL_ASK)).toBe(`About these 2 open lines in TASKS.md:\n- T1: "a b"\n- (no id): "c"\n${FOLLOW_ALL_ASK}`)
    expect(followupAllMessage([{ id: 'T1', text: 'x' }], 'ok?')).toBe('About this open line in TASKS.md:\n- T1: "x"\nok?')
  })
  test('blank ask: nothing to send', () => {
    expect(followupAllMessage([{ id: 'T1', text: 'x' }], '  \n')).toBeNull()
  })
  test('never longer than the limit: the rest is counted', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `T${i}`, text: 'word '.repeat(60) }))
    const m = followupAllMessage(many, FOLLOW_ALL_ASK)!
    expect(m.length).toBeLessThanOrEqual(8000)
    expect(m).toMatch(/- and \d+ more in TASKS\.md\n/)
    expect(m.endsWith(FOLLOW_ALL_ASK)).toBe(true)
  })
})

describe('countsDetail [T1112-126]', () => {
  const files = [
    { root: '~/Work/apps/app-a', tasks: [line({}), line({ section: 'waiting' }), line({ date: '2026-11-01' }), line({ done: true, section: 'done', day: '2026-11-12', date: '2026-11-11' })] },
    { root: '~/Work/apps/app-b', tasks: [line({}), line({}), line({}), line({ section: 'waiting', date: null })] },
    { root: '~/Work/apps/app-b-wt', copyOf: '~/Work/apps/app-b/TASKS.md', tasks: [line({}), line({})] },
  ]
  test('projects by open count, waiting, today, hidden by a fresh start', () => {
    const d = countsDetail(files, '2026-11-10', '2026-11-12')
    expect(d.projects).toEqual([{ name: 'app-b', open: 3, waiting: 0 }, { name: 'app-a', open: 2, waiting: 1 }])
    expect(d.byWaiting).toEqual([{ name: 'app-a', open: 2, waiting: 1 }])
    expect(d.addedToday).toBe(5)
    expect(d.doneToday).toBe(1)
    expect(d.hidden).toBe(2)
  })
  test('no fresh start: nothing hidden', () => {
    const d = countsDetail(files, '', '2026-11-12')
    expect(d.hidden).toBe(0)
    expect(d.projects.map((p) => p.open)).toEqual([4, 3])
  })
})
