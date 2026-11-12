import { describe, expect, test } from 'bun:test'
import { buildEntry, issueUrl } from './feedbackform'

const env = { version: '1.0.0', os: 'macos 15.5', tools: 'claude 2.1.3, codex 0.160.0' }

describe('Send feedback [T1112-120]', () => {
  test('an entry: the seven fields, version and OS only when ticked', () => {
    expect(buildEntry({ kind: 'bug', message: '  The tab froze  ', email: 'a@b.co', include: true }, env)).toEqual({
      ok: true,
      fields: { kind: 'bug', message: 'The tab froze', email: 'a@b.co', version: '1.0.0', os: 'macos 15.5', tools: 'claude 2.1.3, codex 0.160.0', source: 'app' },
    })
    const off = buildEntry({ kind: 'feature', message: 'Dark terminal theme', include: false }, env)
    expect(off).toEqual({ ok: true, fields: { kind: 'feature', message: 'Dark terminal theme', email: '', version: '', os: '', tools: '', source: 'app' } })
  })
  test('refused: no kind, no message, a bad email, too long', () => {
    expect(buildEntry({ kind: 'spam', message: 'x' }, env).ok).toBe(false)
    expect(buildEntry({ kind: 'other', message: '   ' }, env).ok).toBe(false)
    expect(buildEntry({ kind: 'other', message: 'x', email: 'not-an-email' }, env).ok).toBe(false)
    expect(buildEntry({ kind: 'other', message: 'x'.repeat(5001) }, env).ok).toBe(false)
  })
  test('the GitHub issue link: first line as title, environment in the body when given', () => {
    const u = new URL(issueUrl('Tab froze\nafter a resize', env))
    expect(u.origin + u.pathname).toBe('https://github.com/maribol/overvibe/issues/new')
    expect(u.searchParams.get('title')).toBe('Tab froze')
    expect(u.searchParams.get('body')).toContain('after a resize')
    expect(u.searchParams.get('body')).toContain('- Overvibe 1.0.0')
    expect(u.searchParams.get('body')).toContain('- CLIs: claude 2.1.3, codex 0.160.0')
    const bare = new URL(issueUrl('', null))
    expect(bare.searchParams.get('title')).toBe('Bug report')
    expect(bare.searchParams.get('body')).not.toContain('Environment')
    expect(issueUrl('x'.repeat(20000), env).length).toBeLessThan(12000)
  })
})
