import { expect, test } from 'bun:test'
import { swapTabs } from './tabswap'

test('swapTabs keeps the place [T1112-128]', () => {
  expect(swapTabs(['a', 'b', 'c'], [['b', 'x']])).toEqual(['a', 'x', 'c'])
  expect(swapTabs(['a', 'b', 'c'], [['a', 'y'], ['c', 'z']])).toEqual(['y', 'b', 'z'])
  expect(swapTabs(['a', 'x', 'b'], [['b', 'x']])).toEqual(['a', 'x'])
  expect(swapTabs(['a'], [['q', 'r']])).toEqual(['a'])
})
