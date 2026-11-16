import { expect, test } from 'bun:test'
import { keepRunning, suspendMinutes, type SuspendRow } from './suspend'

const now = 10_000_000
const row = (o: Partial<SuspendRow> = {}): SuspendRow => ({ where: 'deck', kind: 'claude', tool: 'claude', status: 'idle', tmux: 'abc', sessionId: 'id', last: now - 40 * 60_000, ...o })
const opt = { now, afterMs: 30 * 60_000, queued: 0 }

test('an idle agent past the wait may be suspended', () => {
  expect(keepRunning(row(), opt)).toBeNull()
  expect(keepRunning(row({ tool: 'codex' }), opt)).toBeNull()
})

test('anything still in use stays running', () => {
  expect(keepRunning(row({ status: 'busy' }), opt)).toContain('busy')
  expect(keepRunning(row({ status: 'waiting' }), opt)).toContain('waiting')
  expect(keepRunning(row({ bg: true }), opt)).toContain('background')
  expect(keepRunning(row({ prompt: { title: 'x' } }), opt)).toContain('choice')
  expect(keepRunning(row({ apiError: 'overloaded' }), opt)).toContain('API error')
  expect(keepRunning(row(), { ...opt, queued: 1 })).toContain('messages')
  expect(keepRunning(row({ last: now - 5 * 60_000 }), opt)).toContain('idle 5 min')
  // typed into it lately, even though the screen did not change
  expect(keepRunning(row(), { ...opt, typedAt: now - 60_000 })).toContain('idle 1 min')
})

test('only agents Overvibe started, with a conversation', () => {
  expect(keepRunning(row({ kind: 'shell' }), opt)).not.toBeNull()
  expect(keepRunning(row({ hand: true }), opt)).not.toBeNull()
  expect(keepRunning(row({ tool: 'agy' }), opt)).toContain('agy')
  expect(keepRunning(row({ sessionId: null }), opt)).not.toBeNull()
  expect(keepRunning(row({ where: 'terminal' }), opt)).not.toBeNull()
  expect(keepRunning(row({ tmux: null }), opt)).not.toBeNull()
})

test('the owner suspends an idle one at once', () => {
  expect(keepRunning(row({ last: now }), { ...opt, afterMs: 0 })).toBeNull()
})

test('setting: allowed choices, else 30', () => {
  expect(suspendMinutes(0)).toBe(0)
  expect(suspendMinutes(60)).toBe(60)
  expect(suspendMinutes(undefined)).toBe(30)
  expect(suspendMinutes(7)).toBe(30)
  expect(suspendMinutes(null)).toBe(30)
})

import { isToolShell, pendingTimer } from './suspend'
const use = (name: string, input: object, at: number) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_use', name, input }] } })

test('a running background job or Monitor keeps it running', () => {
  expect(keepRunning(row(), { ...opt, jobs: 1 })).toContain('background job')
  expect(isToolShell('/bin/zsh -c source /Users/x/.claude-accounts/a/shell-snapshots/snapshot-zsh-1-abc.sh 2>/dev/null')).toBe(true)
  expect(isToolShell('/Users/x/.bun/bin/bun /x/bin/overvibe wait-message st')).toBe(false)
})

test('a /loop wakeup still to fire, or a cron job not deleted, keeps it running', () => {
  expect(pendingTimer([use('ScheduleWakeup', { delaySeconds: 1800 }, now - 20 * 60_000)], now)).toContain('/loop')
  // fired long ago and no new one: the loop ended
  expect(pendingTimer([use('ScheduleWakeup', { delaySeconds: 60 }, now - 60 * 60_000)], now)).toBeNull()
  expect(pendingTimer([use('ScheduleWakeup', { stop: true }, now - 60_000)], now)).toBeNull()
  expect(pendingTimer([use('CronCreate', { cron: '*/5 * * * *' }, now - 86400_000)], now)).toContain('CronCreate')
  expect(pendingTimer([use('CronCreate', {}, now - 9000), use('CronDelete', { id: 'x' }, now - 1000)], now)).toBeNull()
  expect(pendingTimer(['not json', '{"type":"user"}'], now)).toBeNull()
  expect(keepRunning(row(), { ...opt, timer: 'a /loop wakeup is scheduled' })).toContain('/loop')
})
