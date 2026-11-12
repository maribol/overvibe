import { expect, test } from 'bun:test'
import { SETTINGS_ITEMS, isSettingsSection, settingsLinkIn } from './web/settingsNav'

test('section ids are unique and known', () => {
  const ids = SETTINGS_ITEMS.map((i) => i.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(isSettingsSection('accounts')).toBe(true)
  expect(isSettingsSection('nope')).toBe(false)
  expect(isSettingsSection('')).toBe(false)
})

test('messages that name a Settings section link to it', () => {
  expect(settingsLinkIn('Claude Code personal is paused (Settings > Accounts); unpause it or pick another')?.id).toBe('accounts')
  expect(settingsLinkIn('the limit is 3 (Settings > Spawn limits). Do the work in this session')?.id).toBe('limits')
  expect(settingsLinkIn('Turn it off any time in Settings, under Skills.')?.id).toBe('skills')
  expect(settingsLinkIn('Settings > Tasks view [T1112-16]')?.id).toBe('tasks')
  expect(settingsLinkIn('Settings > Hide')?.id).toBe('accounts')
  expect(settingsLinkIn('no settings named here')).toBeNull()
  expect(settingsLinkIn('Settings > Nowhere')).toBeNull()
})

test('a link opens its page, anything else the first one [T1112-100]', async () => {
  const { pageFor, SETTINGS_ITEMS: items } = await import('./web/settingsNav')
  expect(pageFor('permissions')).toBe('permissions')
  expect(pageFor('')).toBe(items[0]!.id)
  expect(pageFor(undefined)).toBe(items[0]!.id)
  expect(pageFor('nope')).toBe(items[0]!.id)
  expect(settingsLinkIn('Settings > Permission mode')?.id).toBe('permissions')
})
