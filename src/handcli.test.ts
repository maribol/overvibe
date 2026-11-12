import { describe, expect, test } from 'bun:test'
import { cliOf, findCli, idFromArgs, isShellCommand, parsePs, pickConversation, under, type Proc } from './handcli'

describe('cliOf', () => {
  test('interactive CLIs', () => {
    expect(cliOf('claude')).toBe('claude')
    expect(cliOf('/Users/x/.local/bin/claude --model opus fix the bug')).toBe('claude')
    expect(cliOf('/Users/x/.local/share/claude/versions/2.1.322 --resume 3855f249-a12a-498c-945e-7b2514894a93')).toBe('claude')
    expect(cliOf('node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('claude')
    expect(cliOf('codex')).toBe('codex')
    expect(cliOf('/Users/x/.codex/packages/standalone/current/bin/codex resume')).toBe('codex')
    expect(cliOf('codex -p work')).toBe('codex') // -p is codex's --profile
    expect(cliOf('node --no-warnings /opt/lib/node_modules/@openai/codex/bin/codex.js')).toBe('codex')
    expect(cliOf('agy --mode auto')).toBe('agy')
  })
  test('one-shot runs, subcommands and lookalikes are not sessions', () => {
    expect(cliOf('claude -p "hi"')).toBeNull()
    expect(cliOf('claude --print hi')).toBeNull()
    expect(cliOf('claude agents --json')).toBeNull()
    expect(cliOf('claude auth login')).toBeNull()
    expect(cliOf('claude --version')).toBeNull()
    expect(cliOf('codex exec "run tests"')).toBeNull()
    expect(cliOf('codex login')).toBeNull()
    expect(cliOf('/Users/x/.codex/packages/app-server-daemon/releases/0.167.1/bin/codex app-server --listen unix://')).toBeNull()
    expect(cliOf('/Applications/ChatGPT.app/Contents/Resources/codex')).toBeNull()
    expect(cliOf('agy -p "summarise"')).toBeNull()
    expect(cliOf('/bin/zsh -c source /Users/x/.claude-accounts/a/shell-snapshots/s.sh')).toBeNull()
    expect(cliOf('vim claude.md')).toBeNull()
    expect(cliOf('bun --watch server.ts')).toBeNull()
  })
})

test('isShellCommand', () => {
  expect(isShellCommand('zsh')).toBe(true)
  expect(isShellCommand('-zsh')).toBe(true)
  expect(isShellCommand('/bin/bash')).toBe(true)
  expect(isShellCommand('claude')).toBe(false)
  expect(isShellCommand('2.1.322')).toBe(false)
  expect(isShellCommand('node')).toBe(false)
})

test('parsePs reads pid, ppid, start and args', () => {
  const out = `  101     1 Wed Nov 11 10:00:00 2026     /bin/zsh -l\n  102   101 Wed Nov 11 10:05:07 2026     /Users/x/.local/bin/claude --model opus\n garbage\n`
  const ps = parsePs(out)
  expect(ps.length).toBe(2)
  expect(ps[1]!).toMatchObject({ pid: 102, ppid: 101, args: '/Users/x/.local/bin/claude --model opus' })
  expect(ps[1]!.start - ps[0]!.start).toBe(5 * 60_000 + 7000)
})

const P = (pid: number, ppid: number, args: string, start = 0): Proc => ({ pid, ppid, args, start })

describe('findCli', () => {
  test('the CLI under the shell, through npx; not its own children; not another pane', () => {
    const ps = [
      P(10, 1, '/bin/zsh -l'),
      P(11, 10, 'npm exec @anthropic-ai/claude-code'),
      P(12, 11, 'node /x/node_modules/@anthropic-ai/claude-code/cli.js'),
      P(13, 12, 'codex exec review'), // a subprocess Claude started
      P(14, 12, 'codex'),
      P(20, 1, '/bin/zsh -l'),
      P(21, 20, 'codex'),
    ]
    expect(findCli(ps, 10)).toMatchObject({ pid: 12, tool: 'claude' })
    expect(findCli(ps, 20)).toMatchObject({ pid: 21, tool: 'codex' })
    expect(findCli([P(30, 1, 'zsh'), P(31, 30, 'bun run dev')], 30)).toBeNull()
  })
  test('two at one level: the newest', () => {
    const ps = [P(10, 1, 'zsh'), P(11, 10, 'claude', 1000), P(12, 10, 'codex', 2000)]
    expect(findCli(ps, 10)).toMatchObject({ pid: 12, tool: 'codex' })
  })
  test('under', () => {
    const ps = [P(10, 1, 'zsh'), P(11, 10, 'npx'), P(12, 11, 'claude'), P(20, 1, 'zsh')]
    expect(under(ps, 12, 10)).toBe(true)
    expect(under(ps, 12, 20)).toBe(false)
  })
})

test('idFromArgs', () => {
  const id = '3855f249-a12a-498c-945e-7b2514894a93'
  expect(idFromArgs('claude', `claude --resume ${id}`)).toBe(id)
  expect(idFromArgs('claude', `claude -r ${id}`)).toBe(id)
  expect(idFromArgs('claude', `claude --session-id=${id}`)).toBe(id)
  expect(idFromArgs('claude', 'claude --resume')).toBeNull()
  expect(idFromArgs('codex', `codex resume ${id}`)).toBe(id)
  expect(idFromArgs('codex', 'codex resume --last')).toBeNull()
  expect(idFromArgs('agy', `agy --conversation ${id}`)).toBe(id)
})

describe('pickConversation', () => {
  const t0 = Date.parse('2026-11-11T10:00:00Z')
  const convs = [
    { id: 'old', cwd: '/w/a', startedAt: t0 - 3600_000, lastAt: t0 + 60_000 },
    { id: 'first', cwd: '/w/a', startedAt: t0 + 2000, lastAt: t0 + 5000 },
    { id: 'second', cwd: '/w/a', startedAt: t0 + 9000, lastAt: t0 + 9000 },
    { id: 'other', cwd: '/w/b', startedAt: t0 + 1000, lastAt: t0 + 1000 },
  ]
  test('the first new one in its folder, after the process started', () => {
    expect(pickConversation(convs, { cwd: '/w/a', start: t0, taken: new Set() })).toBe('first')
    expect(pickConversation(convs, { cwd: '/w/b', start: t0, taken: new Set() })).toBe('other')
  })
  test('two sessions in one folder: the one another session holds is skipped', () => {
    expect(pickConversation(convs, { cwd: '/w/a', start: t0, taken: new Set(['first']) })).toBe('second')
  })
  test('a process started later does not take an earlier conversation', () => {
    expect(pickConversation(convs, { cwd: '/w/a', start: t0 + 8000, taken: new Set() })).toBe('second')
    expect(pickConversation(convs, { cwd: '/w/a', start: t0 + 60_000, taken: new Set() })).toBeNull()
  })
  test('a resume with no id: the one in that folder written to since it started', () => {
    expect(pickConversation(convs, { cwd: '/w/a', start: t0 + 30_000, taken: new Set(), resumed: true })).toBe('old')
  })
  test('nothing yet (no message sent): null, so it is looked for again', () => {
    expect(pickConversation(convs, { cwd: '/w/c', start: t0, taken: new Set() })).toBeNull()
  })
})
