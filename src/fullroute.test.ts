import { expect, test } from 'bun:test'
import { roomierThan, useOf } from './fullroute'

const now = 1_000_000
const acc = (name: string, used?: number, resetsAt: number | null = now + 3600_000) => ({ name, windows: used === undefined ? undefined : { seven_day: { used, resetsAt } } })

test('a full pick moves to the account with the most room', () => {
  const r = roomierThan('default', [acc('default', 100), acc('a', 84), acc('b', 92)], [], now)
  expect(r?.account).toBe('a')
  expect(r?.note).toContain('default is at 100%')
})
test('room left, unknown usage, or everything full: keep the pick', () => {
  expect(roomierThan('a', [acc('a', 60), acc('b', 10)], [], now)).toBeNull()
  expect(roomierThan('a', [acc('a'), acc('b', 10)], [], now)).toBeNull()
  expect(roomierThan('a', [acc('a', 100), acc('b', 99)], [], now)).toBeNull()
})
test('paused accounts are never picked; a window past its reset does not count', () => {
  expect(roomierThan('a', [acc('a', 100), acc('b', 5), acc('c', 50)], ['b'], now)?.account).toBe('c')
  expect(useOf(acc('a', 100, now - 1), now)).toBeNull()
  expect(roomierThan('a', [acc('a', 100, now - 1), acc('b', 5)], [], now)).toBeNull()
})
