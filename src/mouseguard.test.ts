import { describe, expect, test } from 'bun:test'
import { dropClicks, guardedInput, hasClick } from './mouseguard'

const press = '\x1b[<0;8;15M'
const release = '\x1b[<0;8;15m'
const drag = '\x1b[<32;9;15M'
const hover = '\x1b[<35;9;15M'
const wheel = '\x1b[<65;9;15M'

describe('mouse guard [T1111-25]', () => {
  test('presses, releases and drags are clicks; wheel, hover and keys are not', () => {
    for (const s of [press, release, drag, '\x1b[M #/']) expect(hasClick(s)).toBe(true)
    for (const s of [hover, wheel, '1', '\r', '\x1b[?1;2c', '\x1b[I', '\x1b[B']) expect(hasClick(s)).toBe(false)
    expect(dropClicks(press + hover + release + wheel)).toBe(hover + wheel)
  })

  const run = async (menu: boolean, inputs: (string | Uint8Array)[]) => {
    const out: string[] = []
    const input = guardedInput('t', (d) => out.push(typeof d === 'string' ? d : 'bin:' + Buffer.from(d).toString('latin1')), async () => (await Bun.sleep(5), menu))
    for (const d of inputs) input(d)
    await Bun.sleep(40)
    return out
  }

  test('with a menu on screen a click goes nowhere, keys still reach it, in order', async () => {
    expect(await run(true, [press, release, '2', wheel])).toEqual(['2', wheel])
    expect(await run(true, [new Uint8Array(Buffer.from('\x1b[M #/', 'latin1'))])).toEqual([])
  })

  test('without a menu clicks pass, and keys typed behind a click keep their order', async () => {
    expect(await run(false, ['a', press, 'b', release, 'c'])).toEqual(['a', press, 'b', release, 'c'])
  })
})
