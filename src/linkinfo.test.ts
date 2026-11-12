import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitsIn, githubRepoOf, repoInfo, userLinks } from './linkinfo'

describe('githubRepoOf [T1112-137]', () => {
  test('https, ssh, scp-like and host aliases', () => {
    expect(githubRepoOf('https://github.com/maribol/overvibe.git')).toBe('maribol/overvibe')
    expect(githubRepoOf('git@github.com:maribol/overvibe.git')).toBe('maribol/overvibe')
    expect(githubRepoOf('ssh://git@github.com:22/maribol/overvibe')).toBe('maribol/overvibe')
    expect(githubRepoOf('git@github-maribol:maribol/overvibe.git', (h) => (h === 'github-maribol' ? 'github.com' : h))).toBe('maribol/overvibe')
  })
  test('other hosts are not GitHub', () => {
    expect(githubRepoOf('git@gitlab.com:a/b.git')).toBeNull()
    expect(githubRepoOf('git@my-alias:a/b.git', () => 'git.example.com')).toBeNull()
    expect(githubRepoOf('/local/path/repo')).toBeNull()
  })
})

describe('repo checks', () => {
  const here = import.meta.dir
  test('this repo is git; a temp folder is not', () => {
    expect(repoInfo(here).git).toBe(true)
    const d = mkdtempSync(join(tmpdir(), 'ovlinks-'))
    expect(repoInfo(d)).toEqual({ git: false, github: null })
    rmSync(d, { recursive: true })
  })
  test('only real commits pass', () => {
    const head = Bun.spawnSync(['git', '-C', here, 'rev-parse', 'HEAD']).stdout.toString().trim()
    expect(commitsIn(here, [head.slice(0, 7), head, 'abc1234def', 'zzzz'])).toEqual([head.slice(0, 7), head])
  })
})

describe('links.json', () => {
  test('read, checked, read again when it changes; bad JSON is a log line', () => {
    const d = mkdtempSync(join(tmpdir(), 'ovlinks-'))
    const f = join(d, 'links.json')
    const log: string[] = []
    expect(userLinks(f, (m) => log.push(m))).toEqual([])
    writeFileSync(f, JSON.stringify([{ name: 'Jira', pattern: '[A-Z]+-\\d+', url: 'https://j.dev/$0' }, { name: 'x', pattern: '(', url: 'https://x' }]))
    expect(userLinks(f, (m) => log.push(m)).map((u) => u.name)).toEqual(['Jira'])
    expect(log.some((l) => l.includes('"x" skipped'))).toBe(true)
    writeFileSync(f, '{ nope')
    utimesSync(f, new Date(), new Date(Date.now() + 5000))
    expect(userLinks(f, (m) => log.push(m))).toEqual([])
    expect(log.some((l) => l.includes('not valid JSON'))).toBe(true)
    rmSync(d, { recursive: true })
  })
})
