import { expect, test } from 'bun:test'
import { noRead } from './telegram'

// a live run read an --add-dir folder's .env with only relative "**/.env" rules: every folder needs absolute ones [T1113-3]
test('secret rules cover each readable folder by absolute path', () => {
  const r = noRead(['/Users/x/proj', '/Users/x/site'])
  for (const b of ['/Users/x/proj', '/Users/x/site']) {
    expect(r).toContain(`Read(/${b}/**/.env)`)
    expect(r).toContain(`Read(/${b}/.env)`)
    expect(r).toContain(`Read(/${b}/**/.history/**)`)
    expect(r).toContain(`Read(/${b}/**/.mcp.json)`)
  }
  expect(r).toContain('Read(**/.env)')
})
