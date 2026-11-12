import { describe, expect, test } from 'bun:test'
import { sessionRef, tildePath } from './sessionref'

describe('sessionRef', () => {
  test('names the session, its tool and its ~ folder on one line', () => {
    expect(sessionRef({ title: 'api: login fix', tool: 'codex', cwd: '/Users/me/Work/api' }, '/Users/me')).toBe('the Overvibe session "api: login fix" (Codex, ~/Work/api) ')
    expect(sessionRef({ title: 'x', cwd: '/Users/me' }, '/Users/me')).toBe('the Overvibe session "x" (Claude Code, ~) ')
    expect(sessionRef({ title: 'x', tool: 'agy', cwd: '~/a' }, '/Users/me')).toBe('the Overvibe session "x" (agy, ~/a) ')
  })
  test('keeps any script, never carries a line break, escapes quotes', () => {
    const r = sessionRef({ title: 'фронт: 修复\n登录 "v2"\r', tool: 'claude', cwd: '/Users/me/Work/中文' }, '/Users/me/')
    expect(r).toBe('the Overvibe session "фронт: 修复 登录 \\"v2\\"" (Claude Code, ~/Work/中文) ')
    expect(/[\r\n\u001b]/.test(r)).toBe(false)
  })
  test('a folder outside home stays absolute; a look-alike prefix is not home', () => {
    expect(tildePath('/opt/x', '/Users/me')).toBe('/opt/x')
    expect(tildePath('/Users/meg/x', '/Users/me')).toBe('/Users/meg/x')
    expect(tildePath('/Users/me/x', '')).toBe('/Users/me/x')
  })
})
