import { describe, expect, test } from 'bun:test'
import { bangAt } from './web/bangLink'
import { linksAt } from './web/links'
import { splitBang } from './slashpaste'
import type { Row } from './web/compactLink'

const screen = (lines: string[]) => (y: number): Row | undefined => (y < lines.length ? { text: lines[y]!, wrapped: false } : undefined)

describe('! command links [T1114-1]', () => {
  test('a row of its own, after prose and a blank row', () => {
    const rows = screen(['  The deploy is what blocks everything else.', '', '  ! cd ~/Work/app && HOST=fsn bash deploy/push.sh', '', '  It also ships T1112-2.'])
    const hit = bangAt(rows, 2)!
    expect(hit.cmd).toBe('cd ~/Work/app && HOST=fsn bash deploy/push.sh')
    expect([hit.top, hit.bottom, hit.x]).toEqual([2, 2, 2])
    expect(bangAt(rows, 0)).toBeNull()
    expect(bangAt(rows, 4)).toBeNull()
  })
  test('a reply line and a command Claude wrapped onto the next row', () => {
    const cols = 40
    const rows = screen(['⏺ ! cd ~/Work/app && bun run build &&', '  bun run deploy --prod', '  Then tell me what it printed.'])
    // row 0 is 37 long; "bun" would not fit on it at width 40: the command goes on. Row 1 is short: it ends there.
    const hit = bangAt(rows, 1, cols)!
    expect(hit.cmd).toBe('cd ~/Work/app && bun run build && bun run deploy --prod')
    expect([hit.top, hit.bottom]).toEqual([0, 1])
    expect(bangAt(rows, 2, cols)).toBeNull()
  })
  test('prose on the next row is not taken when the row before had room', () => {
    const rows = screen(['  ! ls', '  That lists it.'])
    expect(bangAt(rows, 0, 80)!.cmd).toBe('ls')
    expect(bangAt(rows, 1, 80)).toBeNull()
  })
  test('left alone: the prompt, mid-sentence, exclamations', () => {
    for (const t of ['❯ ! ls', '  Done! ls it', '  !!', '  ! ...', '  !'])
      expect(bangAt(screen([t]), 0)).toBeNull()
  })
  test('one link, claimed before the paths inside it', () => {
    const s = { row: screen(['  ! cd ~/Work/app && bash deploy/push.sh']), cols: 80 }
    const ls = linksAt(s, 0, { run: true })
    expect(ls.map((l) => l.matcher)).toEqual(['run'])
    expect(ls[0]!.target).toEqual({ kind: 'run', cmd: 'cd ~/Work/app && bash deploy/push.sh' })
    // off for sessions where it is not asked for: the paths are links again
    expect(linksAt(s, 0, {}).map((l) => l.matcher)).not.toContain('run')
  })
  test('the typed "!" and the pasted command', () => {
    expect(splitBang('! cd ~/x && ls')).toEqual(['!', 'cd ~/x && ls'])
    expect(splitBang('!ls')).toEqual(['!', 'ls'])
    expect(splitBang('!')).toBeNull()
    expect(splitBang('ls')).toBeNull()
  })
})
