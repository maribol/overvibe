import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// env.ts makes its DATA_DIR on import: point it at a temp folder so the test never touches ~/.config
process.env.OVERVIBE_DATA_DIR = mkdtempSync(join(tmpdir(), 'ov-env-test-'))
const { dataDirFor, linkNewName } = await import('./env')

const home = () => mkdtempSync(join(tmpdir(), 'ov-home-'))
const none = {}

describe('config folder [T1110-80]', () => {
  test('a new install uses ~/.config/overvibe', () => {
    const h = home()
    expect(dataDirFor(h, none)).toBe(join(h, '.config', 'overvibe'))
  })
  test('an install from before the rename keeps ~/.config/agent-deck, and gets a link from the new name', () => {
    const h = home()
    mkdirSync(join(h, '.config', 'agent-deck'), { recursive: true })
    writeFileSync(join(h, '.config', 'agent-deck', 'token'), 'x')
    const dir = dataDirFor(h, none)
    expect(dir).toBe(join(h, '.config', 'agent-deck'))
    linkNewName(h, dir)
    expect(lstatSync(join(h, '.config', 'overvibe')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(h, '.config', 'overvibe'))).toBe('agent-deck')
    expect(existsSync(join(h, '.config', 'overvibe', 'token'))).toBe(true)
    // the next start still picks the real folder, not the link
    expect(dataDirFor(h, none)).toBe(join(h, '.config', 'agent-deck'))
  })
  test('an old folder in use wins over a new one made by hand', () => {
    const h = home()
    for (const n of ['agent-deck', 'overvibe']) {
      mkdirSync(join(h, '.config', n), { recursive: true })
      writeFileSync(join(h, '.config', n, 'token'), n)
    }
    expect(dataDirFor(h, none)).toBe(join(h, '.config', 'agent-deck'))
  })
  test('an old folder that was never used (no token) gives way to a real new one', () => {
    const h = home()
    mkdirSync(join(h, '.config', 'agent-deck'), { recursive: true })
    mkdirSync(join(h, '.config', 'overvibe'), { recursive: true })
    expect(dataDirFor(h, none)).toBe(join(h, '.config', 'overvibe'))
  })
  test('OVERVIBE_DATA_DIR wins, with ~ expanded', () => {
    const h = home()
    expect(dataDirFor(h, { OVERVIBE_DATA_DIR: '~/x' })).toBe(join(h, 'x'))
  })
  test('the link is only made for the old folder, and never over something already there', () => {
    const h = home()
    linkNewName(h, join(h, '.config', 'overvibe'))
    expect(existsSync(join(h, '.config', 'overvibe'))).toBe(false)
    mkdirSync(join(h, '.config', 'overvibe'), { recursive: true })
    linkNewName(h, join(h, '.config', 'agent-deck'))
    expect(lstatSync(join(h, '.config', 'overvibe')).isSymbolicLink()).toBe(false)
  })
})
