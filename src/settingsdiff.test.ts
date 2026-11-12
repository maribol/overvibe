import { describe, expect, test } from 'bun:test'
import { accountRows, resetsIn, settingsSummary } from './settingsdiff'

const base = { defaultAccount: 'auto', projects: {}, permissionMode: 'ask', modeProjects: {}, codex: { defaultAccount: 'auto', projects: {} }, hiddenAccounts: [], chromeAccount: null, chromeProjects: {}, projectNames: {} }

describe('settingsSummary [T1112-126]', () => {
  test('a fresh install: the three fixed rows, nothing changed', () => {
    const r = settingsSummary(base, false)
    expect(r.changed).toBe(0)
    expect(r.rows.map((x) => x[0])).toEqual(['New Claude sessions', 'New Codex sessions', 'Auto mode for new sessions'])
    expect(r.rows[2]![1]).toBe('off')
  })
  test('lists only what differs', () => {
    const r = settingsSummary({ ...base, defaultAccount: 'work', permissionMode: 'auto', projects: { '/a': 'x' }, codex: { defaultAccount: 'auto', projects: { '/b': 'y' } }, pausedAccounts: ['old'], spawnLimits: { maxDepth: 3, maxChildren: 4 }, tasksView: false }, true)
    expect(r.rows).toContainEqual(['New Claude sessions', 'work'])
    expect(r.rows).toContainEqual(['Auto mode for new sessions', 'on'])
    expect(r.rows).toContainEqual(['Folder account rules', '2 folders'])
    expect(r.rows).toContainEqual(['Paused accounts', 'old'])
    expect(r.rows).toContainEqual(['Sessions each may start', '4 (default 8)'])
    expect(r.rows).toContainEqual(['Tasks view', 'off'])
    expect(r.rows).toContainEqual(['Local router file', 'picks accounts'])
    expect(r.rows.some((x) => x[0] === 'Session depth limit')).toBe(false)
    expect(r.changed).toBe(5)
  })
  test('the sidebar settings [T1112-138]', () => {
    const r = settingsSummary({ ...base, sidebarAccounts: false, sidebarOrder: 'newest' }, false)
    expect(r.rows).toContainEqual(['Usage bars in the sidebar', 'off'])
    expect(r.rows).toContainEqual(['Sidebar order', 'newest at the top'])
    expect(settingsSummary({ ...base, sidebarOrder: 'project' }, false).changed).toBe(0)
  })
})

describe('accountRows', () => {
  test('limits with resets, then the plan', () => {
    const now = 1_000_000_000_000
    expect(accountRows({ plan: 'max', windows: { five_hour: { used: 68.6, resetsAt: now + 130 * 60_000 }, seven_day: { used: 44, resetsAt: null } } }, now)).toEqual([
      ['5-hour', '69%, resets in 2h 10m'],
      ['Week', '44%'],
      ['Plan', 'max'],
    ])
  })
  test('resetsIn', () => {
    expect(resetsIn(5 * 60_000, 0)).toBe('in 5m')
    expect(resetsIn(3 * 86_400_000, 0)).toBe('in 3d')
  })
})
