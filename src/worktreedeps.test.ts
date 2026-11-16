import { describe, expect, test } from 'bun:test'
import { depsCommand } from './worktree'

describe('depsCommand [T1112-141]', () => {
  test('the lockfile picks the install', () => {
    expect(depsCommand(['package.json', 'bun.lock'])?.slice(1)).toEqual(['install'])
    expect(depsCommand(['package.json', 'bun.lockb'])?.slice(1)).toEqual(['install'])
    expect(depsCommand(['package.json', 'pnpm-lock.yaml'])).toEqual(['pnpm', 'install', '--frozen-lockfile'])
    expect(depsCommand(['package.json', 'yarn.lock'])).toEqual(['yarn', 'install', '--frozen-lockfile'])
    expect(depsCommand(['package.json', 'package-lock.json'])).toEqual(['npm', 'ci'])
  })
  test('no lockfile: no guess', () => {
    expect(depsCommand(['package.json'])).toBeNull()
    expect(depsCommand([])).toBeNull()
  })
})
