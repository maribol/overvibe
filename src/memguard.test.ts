import { describe, expect, test } from 'bun:test'
import { isAgentCli, killNote, parseMemPs, procLimitMb, sessionProcs, toKill, totalLimitMb } from './memguard'

const GB = 2 ** 30
describe('memory guard [T1117-3]', () => {
  test('limits: a quarter of RAM per process, between 4 and 16 GB; 75% for all', () => {
    expect(procLimitMb(36 * GB)).toBe(9216)
    expect(procLimitMb(8 * GB)).toBe(4096)
    expect(procLimitMb(128 * GB)).toBe(16384)
    expect(totalLimitMb(36 * GB)).toBe(27648)
  })

  test('agent CLIs are protected, test runners are not', () => {
    expect(isAgentCli('/Users/x/.local/bin/claude --permission-mode auto -n agent-deck')).toBe(true)
    expect(isAgentCli('codex resume abc')).toBe(true)
    expect(isAgentCli('node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')).toBe(true)
    expect(isAgentCli('bun test')).toBe(false)
    expect(isAgentCli('bun test src/claude.test.ts')).toBe(false)
  })

  const ps = parseMemPs(
    [
      '  100     1   2000 /bin/zsh', // pane shell of s1
      '  101   100 600000 /Users/x/.local/bin/claude --resume abc', // the agent CLI
      '  102   101   9000 /bin/zsh -c bun test', // tool shell
      '  103   102 38000000 bun test', // runaway: ~36 GB
      '  200     1   2000 /bin/zsh', // pane shell of s2
      '  201   200 1800000 bun test', // 1.7 GB, fine
      '  300     1 50000000 /Applications/Other.app/x', // not under a session: never touched
    ].join('\n'),
  )
  const roots = new Map([[100, 's1'], [200, 's2']])

  test('processes are attributed to their session; outside ones are left alone', () => {
    const list = sessionProcs(ps, roots)
    expect(list.map((p) => [p.pid, p.tmux])).toEqual([[100, 's1'], [101, 's1'], [102, 's1'], [103, 's1'], [200, 's2'], [201, 's2']])
    expect(list.some((p) => p.pid === 300)).toBe(false)
  })

  test('kills the process over the limit, never the CLI or the shell', () => {
    const kills = toKill(sessionProcs(ps, roots), { procMb: 9216, totalMb: 27648 })
    expect(kills.map((k) => [k.pid, k.tmux, k.why])).toEqual([[103, 's1', 'process']])
  })

  test('over the total, the largest killable process goes first, and only as many as needed', () => {
    const many = parseMemPs(['10 1 1000 /bin/zsh', '11 10 8000000 bun a', '12 10 7000000 bun b', '13 10 3000000 bun c', '14 10 9000000 /x/.local/bin/claude'].join('\n'))
    const kills = toKill(sessionProcs(many, new Map([[10, 's']])), { procMb: 9216, totalMb: 20000 })
    expect(kills.map((k) => [k.pid, k.why])).toEqual([[11, 'total']])
  })

  test('the note says what was killed and why', () => {
    const [k] = toKill(sessionProcs(ps, roots), { procMb: 9216, totalMb: 27648 })
    const n = killNote(k!, { procMb: 9216, totalMb: 27648 })
    expect(n).toContain('`bun test` (pid 103)')
    expect(n).toContain('36.2 GB')
    expect(n).toContain('9.0 GB on this Mac')
  })
})
