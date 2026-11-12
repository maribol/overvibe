import { describe, expect, test } from 'bun:test'
import { claudeAutoUpdateOff, codexInstallOf, codexSource, compareVersions, isNewer, parseVersion, selfInstallOf, selfLatest, selfUpdateOf } from './updates'
import { CODEX_QUIET } from './sessions'

describe('CLI update check [T1112-103]', () => {
  test('parseVersion reads --version lines and release tags', () => {
    expect(parseVersion('codex-cli 0.160.0')).toBe('0.160.0')
    expect(parseVersion('2.1.322 (Claude Code)')).toBe('2.1.322')
    expect(parseVersion('rust-v0.167.2')).toBe('0.167.2')
    expect(parseVersion('0.168.0-alpha.3')).toBe('0.168.0-alpha.3')
    expect(parseVersion('2.1.322\n')).toBe('2.1.322')
    expect(parseVersion('1.5.6')).toBe('1.5.6')
    expect(parseVersion('')).toBeNull()
    expect(parseVersion(undefined)).toBeNull()
    expect(parseVersion('<html>not found</html>')).toBeNull()
  })

  test('compareVersions orders numerically, a pre-release before its release', () => {
    expect(compareVersions('0.160.0', '0.167.2')).toBe(-1)
    expect(compareVersions('0.167.2', '0.160.0')).toBe(1)
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1)
    expect(compareVersions('2.1.322', '2.1.322')).toBe(0)
    expect(compareVersions('1.0.0-alpha.2', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBe(1)
  })

  test('isNewer: only a newer real release counts', () => {
    expect(isNewer('0.160.0', '0.167.2')).toBe(true)
    expect(isNewer('0.167.2', '0.167.2')).toBe(false)
    expect(isNewer('0.168.0', '0.167.2')).toBe(false)
    expect(isNewer('0.160.0', '0.168.0-alpha.1')).toBe(false)
  })

  test('the install is read from where the binary really lives, and picks its source and command', () => {
    const h = '/Users/x'
    expect(codexInstallOf(`${h}/.codex/packages/standalone/releases/0.160.0-aarch64-apple-darwin/bin/codex`)).toBe('standalone')
    expect(codexInstallOf('/opt/homebrew/Caskroom/codex/0.167.2/codex-aarch64-apple-darwin')).toBe('brew')
    expect(codexInstallOf('/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')).toBe('npm')
    expect(codexInstallOf(`${h}/.bun/install/global/node_modules/@openai/codex/bin/codex.js`)).toBe('bun')
    expect(codexInstallOf(`${h}/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js`)).toBe('pnpm')
    expect(codexInstallOf('/usr/local/bin/codex')).toBe('unknown')
    expect(codexSource('standalone')).toMatchObject({ url: 'https://api.github.com/repos/openai/codex/releases/latest', cmd: 'codex update' })
    expect(codexSource('npm')).toMatchObject({ url: 'https://registry.npmjs.org/@openai%2fcodex/latest', cmd: 'npm install -g @openai/codex@latest' })
    expect(codexSource('brew')).toMatchObject({ url: 'https://formulae.brew.sh/api/cask/codex.json', cmd: 'brew upgrade --cask codex' })
    expect(codexSource('standalone').pick({ name: '0.167.2', tag_name: 'rust-v0.167.2' })).toBe('0.167.2')
    expect(codexSource('npm').pick({ version: '0.167.2' })).toBe('0.167.2')
    expect(codexSource('brew').pick({ version: '0.167.2' })).toBe('0.167.2')
  })

  test('Claude Code gets a flag only when its own updater is off', () => {
    expect(claudeAutoUpdateOff({ env: { DISABLE_AUTOUPDATER: '1' } }, null, {})).toBe(true)
    expect(claudeAutoUpdateOff({}, null, { DISABLE_AUTOUPDATER: '1' })).toBe(true)
    expect(claudeAutoUpdateOff({ autoUpdates: false }, null, {})).toBe(true)
    expect(claudeAutoUpdateOff({}, { autoUpdates: false }, {})).toBe(true)
    expect(claudeAutoUpdateOff({ env: { DISABLE_AUTOUPDATER: '0' } }, null, {})).toBe(false)
    expect(claudeAutoUpdateOff(null, null, {})).toBe(false)
  })

  test('every Codex launch turns its startup update menu off', () => {
    expect(CODEX_QUIET).toEqual(['-c', 'check_for_update_on_startup=false'])
  })
})

describe('Overvibe update check [T1112-119]', () => {
  const api = (routes: Record<string, any>) => async (url: string) => {
    const k = Object.keys(routes).find((r) => url.endsWith(r))
    if (!k || routes[k] instanceof Error) throw (k && routes[k]) || new Error('404')
    return routes[k]
  }
  const B = 'https://api.example/repos/o/r'

  test('the latest release wins', async () => {
    expect(await selfLatest(B, api({ '/releases/latest': { tag_name: 'v1.0.1', name: 'Overvibe 1.0.1' }, '/tags?per_page=100': [{ name: 'v9.9.9' }] }))).toEqual({ version: '1.0.1', source: 'release' })
  })
  test('no release (404), a draft or a pre-release: the highest release tag', async () => {
    const tags = [{ name: 'v1.0.0' }, { name: 'v1.10.0' }, { name: 'v1.9.3' }, { name: 'v2.0.0-beta.1' }, { name: 'nightly' }]
    expect(await selfLatest(B, api({ '/tags?per_page=100': tags }))).toEqual({ version: '1.10.0', source: 'tag' })
    expect(await selfLatest(B, api({ '/releases/latest': { tag_name: 'v3.0.0', prerelease: true }, '/tags?per_page=100': tags }))).toEqual({ version: '1.10.0', source: 'tag' })
    expect(await selfLatest(B, api({ '/releases/latest': { tag_name: 'v3.0.0', draft: true }, '/tags?per_page=100': tags }))).toEqual({ version: '1.10.0', source: 'tag' })
  })
  test('no release tags: main\'s commit; nothing at all (offline): null', async () => {
    const sha = 'a'.repeat(40)
    expect(await selfLatest(B, api({ '/tags?per_page=100': [{ name: 'nightly' }], '/commits/main': { sha } }))).toEqual({ sha, source: 'commit' })
    expect(await selfLatest(B, api({ '/commits/main': { sha: 'not a sha' } }))).toBeNull()
    expect(await selfLatest(B, api({}))).toBeNull()
  })

  const gitOf = (answers: Record<string, string | null>) => (args: string[]) => (args.join(' ') in answers ? answers[args.join(' ')]! : null)
  const base = { 'rev-parse HEAD': 'abc1234def', 'describe --tags --exact-match': 'v1.0.0', 'status --porcelain --untracked-files=no': '', 'symbolic-ref -q HEAD': null }
  const same = (p: string) => p

  test('installed: ~/.overvibe/app, or a clean checkout on a tag; the version from the exact tag', () => {
    expect(selfInstallOf({ appDir: '/h/.overvibe/app', installDir: '/h/.overvibe/app', git: gitOf(base), pkgVersion: '0.9.0', real: same })).toEqual({ version: '1.0.0', sha: 'abc1234def', mode: 'installed' })
    expect(selfInstallOf({ appDir: '/opt/ov', installDir: '/h/.overvibe/app', git: gitOf(base), pkgVersion: '0.9.0', real: same }).mode).toBe('installed')
    // not on a tag: package.json's version
    expect(selfInstallOf({ appDir: '/h/.overvibe/app', installDir: '/h/.overvibe/app', git: gitOf({ ...base, 'describe --tags --exact-match': null }), pkgVersion: '1.0.0', real: same }).version).toBe('1.0.0')
  })
  test('dev: a clone on a branch, or local changes; plain: no git at all', () => {
    const branch = gitOf({ ...base, 'symbolic-ref -q HEAD': 'refs/heads/main' })
    expect(selfInstallOf({ appDir: '/code/overvibe', installDir: '/h/.overvibe/app', git: branch, pkgVersion: '1.0.0', real: same })).toMatchObject({ mode: 'dev', why: 'a clone on a branch' })
    expect(selfInstallOf({ appDir: '/h/.overvibe/app', installDir: '/h/.overvibe/app', git: gitOf({ ...base, 'status --porcelain --untracked-files=no': ' M server.ts' }), pkgVersion: '1.0.0', real: same })).toMatchObject({ mode: 'dev', why: 'local changes' })
    expect(selfInstallOf({ appDir: '/x', installDir: '/h/.overvibe/app', git: () => null, pkgVersion: '1.0.0', real: same })).toEqual({ version: '1.0.0', mode: 'plain' })
  })

  test('the notice: newer only, the right command per install, the changelog anchor', () => {
    const inst = { version: '1.0.0', sha: 'abc1234', mode: 'installed' as const }
    expect(selfUpdateOf(inst, { version: '1.0.1', source: 'release' }, { appDir: '/h/.overvibe/app' })).toEqual({ installed: '1.0.0', latest: '1.0.1', source: 'release', mode: 'installed', cmd: 'overvibe update', why: undefined, url: 'https://overvibe.dev/changelog#v1.0.1' })
    expect(selfUpdateOf(inst, { version: '1.0.0', source: 'release' }, { appDir: '/a' })).toBeNull()
    expect(selfUpdateOf(inst, { version: '0.9.9', source: 'tag' }, { appDir: '/a' })).toBeNull()
    expect(selfUpdateOf(inst, null, { appDir: '/a' })).toBeNull()
    expect(selfUpdateOf({ ...inst, mode: 'dev', why: 'local changes' }, { version: '1.1.0', source: 'tag' }, { appDir: '/code/overvibe' })?.cmd).toBe('git -C /code/overvibe pull')
    expect(selfUpdateOf({ version: '1.0.0', mode: 'plain' }, { version: '1.1.0', source: 'tag' }, { appDir: '/a' })?.cmd).toBe('curl -fsSL https://overvibe.dev/install.sh | sh')
  })
  test('main\'s commit alone is never a notice: only versions are', () => {
    const inst = { version: '1.0.0', sha: 'abc1234', mode: 'installed' as const }
    const sha = 'f'.repeat(40)
    expect(selfUpdateOf(inst, { sha, source: 'commit' }, { appDir: '/a', git: () => null })).toBeNull()
    expect(selfUpdateOf(inst, { sha, source: 'commit' }, { appDir: '/a', git: (a) => (a[0] === 'merge-base' ? '' : null) })).toBeNull()
    expect(selfUpdateOf({ ...inst, sha }, { sha, source: 'commit' }, { appDir: '/a' })).toBeNull()
  })
})
