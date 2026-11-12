import { expect, test } from 'bun:test'
import { fullUntil } from './accounts'

test('fullUntil: a used-up window that has not reset yet [T1111-26]', () => {
  const now = 1_000_000
  expect(fullUntil({ windows: { seven_day: { used: 51, resetsAt: now + 5 } } }, now)).toBeNull()
  expect(fullUntil({ windows: { five_hour: { used: 100, resetsAt: now + 60_000 }, seven_day: { used: 40, resetsAt: now + 9e6 } } }, now)).toBe(now + 60_000)
  expect(fullUntil({ windows: { five_hour: { used: 100, resetsAt: now - 1 } } }, now)).toBeNull()
  expect(fullUntil(undefined, now)).toBeNull()
})
