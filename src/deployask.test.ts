import { describe, expect, test } from 'bun:test'
import { asksDeploy } from './deployask'

describe('asksDeploy [T1112-134]', () => {
  test('deploy questions', () => {
    for (const q of ['Should I deploy it now, or wait for the review?', 'can I deploy the server part of crash reporting?', 'Should I start it with publishing included?', 'Ship it?', 'Want me to push it to prod?', 'Merge this and release v1.0.1?', 'OK to make it go live?'])
      expect(asksDeploy(q)).toBe(true)
  })
  test('other questions', () => {
    for (const q of ['Should I build it now, so it is in the launch push?', 'Want me to add a delivery section to the email?', 'live Blackout Mode, screen types?', 'Shall I add it?', null, ''])
      expect(asksDeploy(q)).toBe(false)
  })
})
