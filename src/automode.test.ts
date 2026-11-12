import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capMode } from './modecap'
import { modeArgs } from './sessions'

// routing.ts decides the default when it loads, so each case loads it fresh in its own process and data folder
function loadIn(files: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'ov-automode-'))
  for (const [f, v] of Object.entries(files)) writeFileSync(join(dir, f), JSON.stringify(v))
  const r = Bun.spawnSync(['bun', '-e', `const r = await import(${JSON.stringify(join(import.meta.dir, 'routing.ts'))}); console.log(JSON.stringify({ mode: r.getSettings().permissionMode, unsaved: r.modeUnsaved() }))`], { env: { ...process.env, OVERVIBE_DATA_DIR: dir } })
  return { ...JSON.parse(r.stdout.toString().trim().split('\n').at(-1)!), dir }
}

describe('the auto mode default [T1112-99]', () => {
  test('a new install starts with auto mode off', () => expect(loadIn({})).toMatchObject({ mode: 'ask', unsaved: true }))
  test('an install with sessions keeps auto mode on', () => expect(loadIn({ 'sessions.json': [] })).toMatchObject({ mode: 'auto', unsaved: true }))
  test('an install with a settings file and no choice keeps auto mode on', () => expect(loadIn({ 'settings.json': { pins: [] } })).toMatchObject({ mode: 'auto', unsaved: true }))
  test('a saved choice wins either way', () => {
    expect(loadIn({ 'settings.json': { permissionMode: 'ask' }, 'sessions.json': [] })).toMatchObject({ mode: 'ask', unsaved: false })
    expect(loadIn({ 'settings.json': { permissionMode: 'auto' } })).toMatchObject({ mode: 'auto', unsaved: false })
  })
  test('loading never writes the settings file (server.ts stores the choice)', () => {
    const r = loadIn({ 'settings.json': { pins: [] } })
    expect(JSON.parse(readFileSync(join(r.dir, 'settings.json'), 'utf8'))).toEqual({ pins: [] })
  })
})

describe('launch flags follow the mode [T1112-99]', () => {
  test('auto mode: each tool its auto flag, Codex its loosened sandbox', () => {
    expect(modeArgs('claude', 'auto')).toEqual(['--permission-mode', 'auto'])
    const codex = modeArgs('codex', 'auto')
    expect(codex[0]).toBe('--approve-for-me')
    expect(codex).toContain('sandbox_workspace_write.network_access=true')
    expect(codex.some((a) => a.startsWith('sandbox_workspace_write.writable_roots='))).toBe(true)
    expect(modeArgs('agy', 'auto')).toEqual(['--mode', 'auto'])
  })
  test('auto mode off: approval prompts, and no sandbox loosening at all', () => {
    expect(modeArgs('claude', 'ask')).toEqual(['--permission-mode', 'manual'])
    expect(modeArgs('codex', 'ask')).toEqual(['-a', 'on-request', '-s', 'workspace-write'])
    expect(modeArgs('agy', 'ask')).toEqual([])
  })
})

describe('a helper is never more permissive than its starter [T1112-99]', () => {
  const off = { name: 'strict parent', mode: 'ask' }
  const on = { name: 'loose parent' }
  test('the owner (no starter) picks freely, or leaves it to the folder rule', () => {
    expect(capMode('auto')).toBe('auto')
    expect(capMode('ask')).toBe('ask')
    expect(capMode(undefined)).toBeUndefined()
  })
  test('from a session with auto mode off: ask, and --auto refused with a 403', () => {
    expect(capMode(undefined, off)).toBe('ask')
    expect(capMode('ask', off)).toBe('ask')
    let err: any
    try {
      capMode('auto', off)
    } catch (e) {
      err = e
    }
    expect(err?.status).toBe(403)
    expect(err?.message).toContain('--auto')
  })
  test('from a session in auto mode: either, explicit choice kept', () => {
    expect(capMode('auto', on)).toBe('auto')
    expect(capMode('ask', on)).toBe('ask')
    expect(capMode(undefined, on)).toBeUndefined()
  })
  test('a bad value is refused', () => expect(() => capMode('yolo')).toThrow())
})
