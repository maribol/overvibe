import { describe, expect, test } from 'bun:test'
import { hostUrl } from './web/hostLink'

describe('hostUrl [T1112-133]', () => {
  test('a site with or without a path', () => {
    expect(hostUrl('docs.elasticfunnels.io/analytics/tracking-metrics')).toBe('https://docs.elasticfunnels.io/analytics/tracking-metrics')
    expect(hostUrl('overvibe.dev')).toBe('https://overvibe.dev')
    expect(hostUrl('github.com/maribol/overvibe/')).toBe('https://github.com/maribol/overvibe/')
  })
  test('files and folders stay paths', () => {
    for (const t of ['notes.md', 'src/index.ts', 'install.sh', 'Overvibe.app/Contents', 'logo.ai', 'out/png', '~/x.com/y', './a.io/b', '/abs/a.io', 'config.json/x'])
      expect(hostUrl(t)).toBeNull()
  })
})
