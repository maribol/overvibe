import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// transcripts.ts reads its index from the data folder on import: point it at an empty one
process.env.OVERVIBE_DATA_DIR = mkdtempSync(join(tmpdir(), 'ov-stats-'))
const { addWork, dayKey, hourKey, deckHeader } = await import('./transcripts')
const { windows } = await import('./stats')
const { header } = await import('./peer')

const at = (s: string) => new Date(s).getTime() // local time

describe('working time per hour [T1110-84] [T1110-89]', () => {
  test('a turn inside one hour goes to that hour', () => {
    const w: Record<string, number> = {}
    addWork(w, at('2026-11-10T15:40:00'), 90_000)
    expect(w).toEqual({ '2026-11-10T15': 90_000 })
  })
  test('a turn across midnight is split by hour', () => {
    const w: Record<string, number> = {}
    addWork(w, at('2026-11-11T00:10:00'), 30 * 60_000)
    expect(w).toEqual({ '2026-11-10T23': 20 * 60_000, '2026-11-11T00': 10 * 60_000 })
  })
  test('a turn ending exactly on the hour belongs to the hour before', () => {
    const w: Record<string, number> = {}
    addWork(w, at('2026-11-11T00:00:00'), 60_000)
    expect(w).toEqual({ '2026-11-10T23': 60_000 })
  })
  test('keys are local', () => {
    expect(dayKey(at('2026-11-10T23:59:00'))).toBe('2026-11-10')
    expect(hourKey(at('2026-11-10T23:59:00'))).toBe('2026-11-10T23')
  })
})

describe('rolling windows [T1110-89]', () => {
  const w = windows(at('2026-11-11T00:20:00'))
  test('just after midnight the 24 hours still hold yesterday', () => {
    expect(w['24h'].buckets.length).toBe(24)
    expect(w['24h'].buckets[0]).toBe('2026-11-10T01')
    expect(w['24h'].buckets.at(-1)).toBe('2026-11-11T00')
    expect(w['24h'].since).toBe(at('2026-11-10T01:00:00'))
  })
  test('7 days are today and the 6 before', () => {
    expect(w['7d'].buckets).toEqual(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'])
    expect(w['7d'].keyOf('2026-11-10T23')).toBe('2026-11-10')
  })
})

describe('overvibe send headers are read back from transcripts [T1110-89]', () => {
  test('a checked sender', () => {
    const typed = `${header({ name: 'api: coordinator', tool: 'claude', sender: 'checked' })} run the tests`
    expect(deckHeader(typed)).toEqual({ from: 'api: coordinator', body: 'run the tests' })
  })
  test('a plain shell', () => expect(deckHeader(`${header({ sender: 'outside' })} hello`)).toEqual({ from: 'a shell', body: 'hello' }))
  test('the old deck header', () => expect(deckHeader('[deck message from "ask test" (claude); reply with: deck send "ask test" "<reply>"] hi')).toEqual({ from: 'ask test', body: 'hi' }))
  test('a resume note is not a message', () => expect(deckHeader(`${header({ name: 'x', sender: 'checked', kind: 'resume note' })} go on`)).toBeNull())
  test('text the owner typed is not a message', () => expect(deckHeader('please check [overvibe message from "x"] later')).toBeNull())
})
