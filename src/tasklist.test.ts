import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addTask, allocateId, checkTasks, insertLine, nextNumber, SKELETON, taskLine, usedNumbers } from './tasklist'
import { readTasks } from './tasks'

const NOW = new Date(2026, 10, 12, 10)
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasklist-'))
  Bun.spawnSync(['git', 'init', '-q', dir])
  return { dir, data: mkdtempSync(join(tmpdir(), 'tasklist-data-')) }
}

describe('ids', () => {
  test('the highest number for today plus one, other days ignored', () => {
    const text = '- [ ] T1112-3 2026-11-12 a\n- [x] T1111-40 2026-11-11 b\n- [ ] T1112-12 c'
    expect(usedNumbers(text, '1112')).toEqual([3, 12])
    expect(nextNumber(usedNumbers(text, '1112'), [14])).toBe(15)
    expect(nextNumber([])).toBe(1)
  })
  test('ids handed out are not given out again, even before they are written', () => {
    const { dir, data } = scratch()
    expect(allocateId(dir, data, NOW, null)).toBe('T1112-1')
    expect(allocateId(dir, data, NOW, null)).toBe('T1112-2')
  })
  test('commit subjects count', () => {
    const { dir, data } = scratch()
    const g = (...a: string[]) => Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
    g('commit', '-q', '--allow-empty', '-m', `Ship it [T${'1112'}-7]`)
    // the commit is from today, so it counts only when its prefix is today's
    const today = new Date()
    const id = allocateId(dir, data, today, null)
    const p = `${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
    expect(id).toBe(p === '1112' ? 'T1112-8' : `T${p}-1`)
  })
})

describe('add', () => {
  test('a missing file gets the three sections, and the line reads back in the Tasks view', () => {
    const { dir, data } = scratch()
    const r = addTask({ dir, dataDir: data, what: 'Fix the  login\nbutton', session: 'e411f976', now: NOW, tdState: null })
    expect(r.id).toBe('T1112-1')
    const text = readFileSync(r.file, 'utf8')
    expect(text).toContain('## Waiting on the owner\n\n## To do\n- [ ] T1112-1 2026-11-12 Fix the login button · session e411f976\n')
    const t = readTasks(r.file).tasks[0]!
    expect(t).toMatchObject({ id: 'T1112-1', date: '2026-11-12', text: 'Fix the login button', sessions: ['e411f976'], section: 'todo', done: false })
  })
  test('--waiting goes under Waiting on the owner, newest first', () => {
    const { dir, data } = scratch()
    addTask({ dir, dataDir: data, what: 'first', waiting: true, now: NOW, tdState: null })
    addTask({ dir, dataDir: data, what: 'second', waiting: true, now: NOW, tdState: null })
    const text = readFileSync(join(dir, 'TASKS.md'), 'utf8')
    expect(text).toContain('## Waiting on the owner\n- [ ] T1112-2 2026-11-12 second\n- [ ] T1112-1 2026-11-12 first\n')
    expect(readTasks(join(dir, 'TASKS.md')).tasks.every((t) => t.section === 'waiting')).toBe(true)
  })
  test('an existing file without the section gets it before Done', () => {
    const out = insertLine('# TASKS\n\n## Done\n- [x] old · checked: test\n', taskLine({ id: 'T1112-1', day: '2026-11-12', what: 'new' }), 'todo')
    expect(out).toBe('# TASKS\n\n## To do\n- [ ] T1112-1 2026-11-12 new\n\n## Done\n- [x] old · checked: test\n')
  })
  test('an empty task is refused', () => {
    const { dir, data } = scratch()
    expect(() => addTask({ dir, dataDir: data, what: '  ', tdState: null })).toThrow('say what')
  })
})

describe('check', () => {
  test('a clean file has no problems', () => {
    expect(checkTasks(SKELETON)).toEqual([])
    expect(checkTasks('## To do\n- [ ] T1112-1 2026-11-12 a\n## Done\n### 2026-11-12\n- [x] T1112-2 2026-11-12 b · checked: bun test')).toEqual([])
  })
  test('ticked outside Done, no id, duplicate, tick without a check, shipped but open', () => {
    const text = [
      '## To do',
      '- [x] T1112-1 2026-11-12 ticked here · checked: test',
      '- [ ] 2026-11-12 no id',
      '- [ ] 2026-10-01 old line, exempt',
      '- [ ] T1112-3 2026-11-12 shipped',
      '- [ ] T1112-3 2026-11-12 twice',
      '## Done',
      '- [x] T1112-4 2026-11-12 done, says nothing',
    ].join('\n')
    const kinds = checkTasks(text, { 'T1112-3': ['abc123'] }).map((p) => `${p.line} ${p.kind}`)
    expect(kinds).toEqual([
      '2 ticked but not moved to Done',
      '3 line without an id (overvibe tasks id)',
      '5 shipped (commits abc123) but still open: verify, then tick or say what is left',
      '6 shipped (commits abc123) but still open: verify, then tick or say what is left',
      '8 ticked without saying how it was checked',
      '5 duplicate id T1112-3',
    ])
  })
})

test('file written by add passes check', () => {
  const { dir, data } = scratch()
  addTask({ dir, dataDir: data, what: 'x', now: NOW, tdState: null })
  expect(checkTasks(readFileSync(join(dir, 'TASKS.md'), 'utf8'))).toEqual([])
  writeFileSync(join(dir, 'TASKS.md'), '')
})

test('a deck.json "tasks" names the file, as for the Tasks view', () => {
  const { dir, data } = scratch()
  writeFileSync(join(dir, 'deck.json'), JSON.stringify({ tasks: 'docs-TASKS.md' }))
  const r = addTask({ dir, dataDir: data, what: 'y', now: NOW, tdState: null })
  expect(r.file.endsWith(dir.replace(/^\/private/, '') + '/docs-TASKS.md')).toBe(true)
})
