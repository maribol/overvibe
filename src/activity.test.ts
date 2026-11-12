import { expect, test } from 'bun:test'
import { screenSig, step } from './activity'
import { lastStamp } from './stamp'

// [T1112-7] idle time from real activity, not file mtimes or redraws
test('lastStamp: the newest line with a time, skipping lines without one', () => {
  const lines = [
    '{"type":"user","timestamp":"2026-11-11T19:45:35.814Z"}',
    '{"type":"system","subtype":"turn_duration","timestamp":"2026-11-11T19:45:40.558Z"}',
    '{"type":"custom-title","customTitle":"x"}',
    '',
  ]
  expect(lastStamp(lines)).toBe(Date.parse('2026-11-11T19:45:40.558Z'))
  expect(lastStamp(['{"type":"agent-name"}'])).toBe(0)
  expect(lastStamp([])).toBe(0)
})

test('lastStamp: a timestamp quoted inside a message does not count, a future one is clamped to now', () => {
  expect(lastStamp(['{"message":"see \\"timestamp\\":\\"2030-01-01T00:00:00Z\\"","timestamp":"2026-11-11T10:00:00.000Z"}'])).toBe(Date.parse('2026-11-11T10:00:00.000Z'))
  const t = lastStamp(['{"timestamp":"2099-01-01T00:00:00.000Z"}'])
  expect(t).toBeLessThanOrEqual(Date.now())
})

test('screenSig: a resize that rewraps the prompt or moves a right-hand prompt gives the same text', () => {
  const wide = 'user@mac ~/Work %                                  12:00\n\n'
  const narrow = 'user@mac ~/Work %      12:00\n'
  expect(screenSig(wide)).toBe(screenSig(narrow))
  expect(screenSig('a\nb\n$ ls\nfile1\n')).not.toBe(screenSig('a\nb\n$\n'))
})

test('step: a redraw keeps the last real time, new text moves it', () => {
  let s = step(undefined, 1000, 'prompt %')
  expect(s.real).toBe(1000)
  s = step(s, 5000, 'prompt %') // a page attached: tmux activity moved, the text did not
  expect(s.real).toBe(1000)
  expect(s.act).toBe(5000)
  s = step(s, 9000, 'prompt % ls\nfile1\nprompt %') // the owner typed
  expect(s.real).toBe(9000)
  expect(step(s, 9000, 'other')).toBe(s) // same activity time: nothing to look at
})
