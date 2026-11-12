import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// env.ts makes its DATA_DIR on import: point it at a temp folder so the test never touches ~/.config
process.env.OVERVIBE_DATA_DIR ||= mkdtempSync(join(tmpdir(), 'ov-ping-test-'))
const { isOn, maySend } = await import('./usageping')

describe('usage ping, on by default [T1112-101]', () => {
  test('no recorded choice counts as on', () => expect(isOn({ on: null })).toBe(true))
  test('an explicit off stays off, before and after setup', () => {
    expect(isOn({ on: false })).toBe(false)
    expect(maySend({ on: false }, false)).toBe(false)
    expect(maySend({ on: false }, true)).toBe(false)
  })
  test('undecided waits until setup is done, so unticking it during setup sends nothing', () => {
    expect(maySend({ on: null }, false)).toBe(false)
    expect(maySend({ on: null }, true)).toBe(true)
  })
  test('a saved yes sends', () => expect(maySend({ on: true }, false)).toBe(true))
})
