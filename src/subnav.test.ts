import { describe, expect, test } from 'bun:test'
import { alreadyShown, listRows, nextKey, targetRow } from './subnav'

const footer = (sel: number | null) =>
  [
    '❯ ',
    '────────',
    '  Opus 5.5 · subnav · ctx 42k/500k (9%)',
    sel === null ? '  ⏵⏵ auto mode on · 2 shells · ← 3 agents' : '  ↑/↓ to select',
    '',
    `${sel === 0 ? '❯ ' : '  '}⏺ main`,
    `${sel === 1 ? '❯ ' : '  '}◯ general-purpose  Subagent A sleep 600                                  7s · ↓ 28.0k tokens`,
    `${sel === 2 ? '❯ ' : '  '}◯ general-purpose  Subagent B sleep 610                                  6s · ↓ 27.7k tokens`,
  ].join('\n')

describe('subagent navigation [T1118-3]', () => {
  test('reads main and the subagent rows, and which one is chosen', () => {
    expect(listRows(footer(null)).map((r) => [r.label, r.selected])).toEqual([
      ['main', false],
      ['general-purpose  Subagent A sleep 600', false],
      ['general-purpose  Subagent B sleep 610', false],
    ])
    expect(listRows(footer(2)).findIndex((r) => r.selected)).toBe(2)
    expect(listRows('no list here\n❯ hello')).toEqual([])
  })

  test('the target: by description, else by position; main by name', () => {
    const rows = listRows(footer(null))
    expect(targetRow(rows, { desc: 'Subagent B sleep 610', index: 0 })).toBe(2)
    expect(targetRow(rows, { desc: 'cut owner DM noise', index: 1 })).toBe(2) // not on screen: second subagent
    expect(targetRow(rows, { main: true })).toBe(0)
    expect(targetRow(rows, { desc: 'x', index: 5 })).toBe(-1)
  })

  test('keys: down until the target is chosen, then Enter; up when past it', () => {
    expect(nextKey(listRows(footer(null)), 2)).toBe('Down')
    expect(nextKey(listRows(footer(1)), 2)).toBe('Down')
    expect(nextKey(listRows(footer(2)), 2)).toBe('Enter')
    expect(nextKey(listRows(footer(2)), 0)).toBe('Up')
  })

  test('the row Claude Code shows now has a filled dot: main shown means nothing to do', () => {
    const rows = listRows(footer(null))
    expect(rows.map((r) => r.shown)).toEqual([true, false, false])
    expect(alreadyShown(rows, 0)).toBe(true)
    expect(alreadyShown(rows, 1)).toBe(false)
    const onFork = listRows(['  ○ main', '  ○ fork  Waiting for review cards', '❯ ● fork  Trimming s027 continuity key'].join('\n'))
    expect(onFork.map((r) => [r.shown, r.selected])).toEqual([[false, false], [false, false], [true, true]])
    expect(alreadyShown(onFork, 0)).toBe(false)
    expect(nextKey(onFork, 0)).toBe('Up')
  })
})
