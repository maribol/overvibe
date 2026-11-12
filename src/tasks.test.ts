import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainCopyOf, tasksFor } from './tasks'
import { openCounts } from './taskview'

// a work root with a repo, its worktree (a copy of the same TASKS.md) and a project no session ran in [T1112-117]
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tasks-'))
  const repo = join(root, 'books'), wt = join(root, 'books-wt'), quiet = join(root, 'quiet')
  for (const d of [repo, wt, quiet, join(repo, '.git', 'worktrees', 'books-wt')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${repo}/.git/worktrees/books-wt\n`)
  const md = '# TASKS\n\n## Waiting on the owner\n\n- [ ] T1112-1 2026-11-12 decide\n\n## To do\n\n- [ ] T1112-2 2026-11-12 build\n- [ ] an old line without an id\n\n## Done\n\n### 2026-11-12\n\n- [x] T1112-3 2026-11-12 shipped\n'
  writeFileSync(join(repo, 'TASKS.md'), md)
  writeFileSync(join(wt, 'TASKS.md'), md)
  writeFileSync(join(quiet, 'TASKS.md'), '## To do\n\n- [ ] T1101-1 2026-11-01 waiting for a session\n')
  return { root, repo, wt, quiet }
}

describe('tasksFor [T1112-117]', () => {
  test('folders under the work root count, not only the sessions\' folders', () => {
    const { root, repo, wt, quiet } = fixture()
    const files = tasksFor([], [root, repo, wt, quiet])
    expect(files.length).toBe(3)
    expect(openCounts(files, '')).toEqual({ open: 4, waiting: 1, projects: 2 })
  })
  test('a repo\'s second list one folder down is found too', () => {
    const { repo } = fixture()
    mkdirSync(join(repo, 'server'))
    writeFileSync(join(repo, 'server', 'TASKS.md'), '## To do\n\n- [ ] T1112-9 2026-11-12 server side\n')
    expect(tasksFor([], [repo]).map((f) => f.file.split('/').slice(-2).join('/')).sort()).toEqual(['books/TASKS.md', 'server/TASKS.md'])
  })
  test('a worktree copy is listed with its main file and counted once', () => {
    const { repo, wt } = fixture()
    expect(mainCopyOf(join(wt, 'TASKS.md'))).toBe(join(repo, 'TASKS.md'))
    expect(mainCopyOf(join(repo, 'TASKS.md'))).toBeNull()
    // only the worktree is known: the main repo's file is added and the copy marked
    const files = tasksFor([], [wt])
    expect(files.length).toBe(2)
    expect(files.filter((f) => f.copyOf).length).toBe(1)
    expect(openCounts(files, '')).toEqual({ open: 3, waiting: 1, projects: 1 })
  })
})
