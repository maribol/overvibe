import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { knownIds, mask, scanDir, scanText, type Ctx } from './releasescan'

// Every fake value is assembled at run time, so this file never trips the scan itself.
const ID = '3f9a2c71-0b4d-4e8a-9c16-5d7e8f901a2b'
const ctx: Ctx = { ids: new Set([ID]), licenseFile: 'LICENSE', licenseEmails: new Set() }
const rules = (text: string, file = 'a.ts') => scanText(file, text, ctx).map((h) => h.rule)

describe('release scan', () => {
  test('owner and company names, any case', () => {
    expect(rules('built by ' + 'As' + 'per Digital')).toEqual(['name'])
    expect(rules('x ' + 'TODOSI' + 'CIUC y')).toEqual(['name'])
    expect(rules('thanks ' + 'Bian' + 'ca')).toEqual(['name'])
    expect(rules('Copyright (c) 2026 Samuel ' + 'Todo' + 'siciuc', 'LICENSE')).toEqual([])
  })

  test('home paths other than /Users/x and /Users/me', () => {
    expect(rules('/Users/x/Work and /Users/me/a')).toEqual([])
    expect(rules('cd /Users/' + 'jane/Work')).toEqual(['home path'])
    expect(rules('/Users/' + 'meg/x')).toEqual(['home path'])
  })

  test('emails other than placeholders and ssh remotes', () => {
    expect(rules('git@github.com:a/b and a@b.co, me@x.dev, who@example.com')).toEqual([])
    expect(rules('mail ' + 'jane' + '@' + 'company.io')).toEqual(['email'])
    expect(scanText('a', 'by ' + 'me' + '@' + 'real.dev', { ...ctx, licenseEmails: new Set(['me' + '@' + 'real.dev']) })).toEqual([])
  })

  test('keys and tokens', () => {
    const r = (s: string) => 'abcdEFGH1234ijklMNOP5678qrstUVWXyz90'.repeat(2).slice(0, s.length ? Number(s) : 0)
    expect(rules('k=' + 'sk-' + 'ant-api03-' + r('40'))).toEqual(['anthropic key'])
    expect(rules('ghp' + '_' + r('36'))).toEqual(['github token'])
    expect(rules('github' + '_pat_' + r('40'))).toEqual(['github token'])
    expect(rules('xox' + 'b-1234-5678-' + r('20'))).toEqual(['slack token'])
    expect(rules('AKIA' + 'ABCDEFGH12345678')).toEqual(['aws key'])
    expect(rules('AIza' + r('35'))).toEqual(['google key'])
    expect(rules('-----BEGIN ' + 'OPENSSH PRIVATE KEY-----')).toEqual(['private key'])
    expect(rules('-----BEGIN ' + 'PRIVATE KEY-----')).toEqual(['private key'])
    expect(rules('bot' + '123456789:' + r('35'))).toEqual(['telegram token'])
    // not a token: too short after the colon, or a time
    expect(rules('123456789:abc 12:30:45')).toEqual([])
  })

  test('session links and attribution lines', () => {
    expect(rules('https://claude.ai/code/' + 'session_01AbC')).toEqual(['session link'])
    expect(rules('Co-' + 'Authored-By: X <x@example.com>')).toEqual(['attribution'])
    expect(rules('🤖 Generated with ' + '[Claude Code](https://claude.com/claude-code)')).toEqual(['attribution'])
    expect(rules('<' + 'noreply' + '@anthropic.com>')).toEqual(['attribution', 'email'])
  })

  test('conversation ids: full or first 8 characters, only when known', () => {
    expect(rules('resume ' + ID)).toEqual(['conversation id'])
    expect(rules('resume ' + ID.toUpperCase())).toEqual(['conversation id'])
    expect(rules('ls: ' + ID.slice(0, 8) + ' shop: lead')).toEqual(['conversation id (8)'])
    expect(rules('resume 11111111-2222-4333-8444-555555555555 and deadbeef')).toEqual([])
  })

  test('mask never prints a whole secret', () => {
    expect(mask('sk-' + 'ant-' + 'x'.repeat(40))).toBe('sk-ant…(47)')
    expect(mask('short')).toBe('short')
  })

  test('scanDir: file contents and file names, skips .git and binaries', () => {
    const d = mkdtempSync(join(tmpdir(), 'relscan-'))
    try {
      mkdirSync(join(d, '.git'))
      writeFileSync(join(d, '.git', 'config'), 'email = ' + 'jane' + '@' + 'company.io')
      writeFileSync(join(d, 'ok.md'), 'nothing here, /Users/x/a')
      writeFileSync(join(d, 'bin.png'), Buffer.from([0, 1, 2, ...Buffer.from('/Users/' + 'jane')]))
      writeFileSync(join(d, ID.slice(0, 8) + '.txt'), 'x')
      writeFileSync(join(d, 'cfg.ts'), 'a\nconst t = "' + 'sk-' + 'ant-' + 'z'.repeat(30) + '"')
      const hits = scanDir(d, ctx).map((h) => `${h.file}:${h.line}:${h.rule}`).sort()
      expect(hits).toEqual([ID.slice(0, 8) + '.txt:0:conversation id (8)', 'cfg.ts:2:anthropic key'])
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  test('knownIds reads transcripts of every account, Codex rollouts and sessions.json', () => {
    const h = mkdtempSync(join(tmpdir(), 'relhome-'))
    try {
      const ids = ['aaaaaaaa-1111-4111-8111-000000000001', 'bbbbbbbb-1111-4111-8111-000000000002', 'cccccccc-1111-4111-8111-000000000003', 'dddddddd-1111-4111-8111-000000000004']
      mkdirSync(join(h, '.claude/projects/-a'), { recursive: true })
      writeFileSync(join(h, '.claude/projects/-a', ids[0] + '.jsonl'), '')
      mkdirSync(join(h, '.claude-accounts/work/projects/-b'), { recursive: true })
      writeFileSync(join(h, '.claude-accounts/work/projects/-b', ids[1] + '.jsonl'), '')
      mkdirSync(join(h, '.codex/sessions/2026/11/16'), { recursive: true })
      writeFileSync(join(h, '.codex/sessions/2026/11/16', 'rollout-2026-11-16T10-00-00-' + ids[2] + '.jsonl'), '')
      mkdirSync(join(h, '.config/agent-deck'), { recursive: true })
      writeFileSync(join(h, '.config/agent-deck/sessions.json'), JSON.stringify([{ claudeId: ids[3].toUpperCase() }]))
      expect([...knownIds(h)].sort()).toEqual(ids)
    } finally { rmSync(h, { recursive: true, force: true }) }
  })
})
