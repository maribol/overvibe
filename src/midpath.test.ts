import { expect, test } from 'bun:test'
import { midPath } from './web/midPath'

const width = (n: number) => (s: string) => s.length <= n

test('a path that fits is shown whole', () => {
  expect(midPath('~/Work/gtm-sites', width(40))).toBe('~/Work/gtm-sites')
})

test('cut from the middle, never the end', () => {
  const p = '~/Work/acme/notes-app/apps/mobile/ios-widget'
  expect(midPath(p, width(31))).toBe('~/Work/…/apps/mobile/ios-widget')
  expect(midPath(p, width(20))).toBe('~/Work/…/ios-widget')
  expect(midPath(p, width(14))).toBe('~/…/ios-widget')
  expect(midPath(p, width(10)).endsWith('get')).toBe(true)
  expect(midPath(p, width(10)).startsWith('~/…/')).toBe(true)
})

test('absolute and relative paths', () => {
  expect(midPath('/Users/me/Work/a/b/project', width(22))).toBe('/Users/…/a/b/project')
  expect(midPath('x/y/z/long-folder', width(15))).toBe('x/…/long-folder')
})
