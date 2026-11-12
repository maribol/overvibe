import { expect, test } from 'bun:test'
import { pauseKey, settle } from './pause'

const base = { tool: 'claude' as const, accounts: ['default', 'personal', 'work'], defaultAccount: 'work', paused: [] as string[] }

test('pause: an unpaused pick stays as it is [T1112-11]', () => {
  expect(settle({ ...base, account: 'personal', by: 'asked' })).toEqual({ account: 'personal' })
  expect(settle({ ...base, account: 'personal', by: 'rules', paused: ['codex:personal'] })).toEqual({ account: 'personal' })
})

test('pause: an explicit paused account is refused', () => {
  expect(() => settle({ ...base, account: 'personal', by: 'asked', paused: ['personal'] })).toThrow('account personal is paused (Settings > Accounts); unpause it or pick another')
  expect(() => settle({ ...base, tool: 'codex', account: 'x', by: 'asked', accounts: ['default', 'x'], paused: [pauseKey('x', 'codex')] })).toThrow('Codex account x is paused')
})

test('pause: a folder rule on a paused account falls back to the default, with a note', () => {
  const r = settle({ ...base, account: 'personal', by: 'rules', paused: ['personal'] })
  expect(r.account).toBe('work')
  expect(r.note).toBe('personal (the account this folder uses) is paused, so it runs on work')
})

test('pause: default paused too: the first unpaused account', () => {
  expect(settle({ ...base, account: 'work', by: 'rules', paused: ['work'] }).account).toBe('default')
  expect(settle({ ...base, account: 'personal', by: 'router', paused: ['personal', 'work', 'default'], accounts: [...base.accounts, 'z'] }).account).toBe('z')
  const c = settle({ ...base, account: 'personal', by: 'chrome', paused: ['personal'] })
  expect(c.note).toContain('Claude in Chrome is paired with')
  expect(c.note).toContain('browser tools may not connect')
})

test('pause: every account paused is refused', () => {
  expect(() => settle({ ...base, account: 'work', by: 'rules', paused: ['default', 'personal', 'work'] })).toThrow('every Claude account is paused')
  expect(() => settle({ tool: 'codex', account: 'default', by: 'rules', accounts: ['default'], defaultAccount: 'default', paused: ['codex:default'] })).toThrow('every Codex account is paused')
})

test('pause: a resume whose account is paused is routed like a new session', () => {
  const r = settle({ ...base, account: 'personal', by: 'rules', paused: ['personal'], why: 'the account this session ran on' })
  expect(r).toEqual({ account: 'work', note: 'personal (the account this session ran on) is paused, so it runs on work' })
})
