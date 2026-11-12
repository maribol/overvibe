// `overvibe new --worktree` [T1110-79]: a helper gets its own git worktree, on a new branch ov/<name>
// made from the folder's HEAD, so parallel helpers never edit the same checkout. The worktree sits
// beside the repo, in <repo>.worktrees/<name> (not inside it, where watchers, builds and searches of the
// main checkout would pick it up). Overvibe never deletes a worktree or its branch: when the helper
// stops, its coordinator is told the branch, what is in it and how to merge it, and cleans up itself.
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { HOME, tildify } from './env'

export type Worktree = { path: string; branch: string; repo: string; base: string }

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

/** A branch-safe name: lowercase letters, digits and dashes, from the session name (or a random one). */
export function slugOf(name: string | undefined): string {
  const s = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return s || `helper-${crypto.randomUUID().slice(0, 6)}`
}

/** The top folder of the git checkout `cwd` is in (a worktree counts as its own checkout), or null. */
export function checkoutOf(cwd: string): string | null {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  return top.ok && top.out ? top.out : null
}

/**
 * Make the worktree for a new helper started in `cwd` (any folder inside a git repo). Returns where the
 * helper runs (the same subfolder inside the new worktree) and the worktree record.
 */
export function makeWorktree(cwd: string, name: string | undefined): { cwd: string; worktree: Worktree } {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok || !top.out) throw new Error(`--worktree needs a folder inside a git repo; ${tildify(cwd)} is not in one`)
  const head = git(cwd, ['rev-parse', '--verify', 'HEAD'])
  if (!head.ok) throw new Error('--worktree: this repo has no commit yet, so there is no HEAD to branch from')
  const slug = slugOf(name)
  const branch = `ov/${slug}`
  if (git(top.out, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok)
    throw new Error(`--worktree: branch ${branch} already exists (an earlier helper's work, maybe unmerged). Merge or delete it first, or pick another --name`)
  const path = join(dirname(top.out), `${basename(top.out)}.worktrees`, slug)
  if (existsSync(path)) throw new Error(`--worktree: ${tildify(path)} already exists; remove it (git worktree remove) or pick another --name`)
  mkdirSync(dirname(path), { recursive: true })
  const add = git(top.out, ['worktree', 'add', '-b', branch, path, head.out])
  if (!add.ok) throw new Error(`--worktree: git worktree add failed: ${(add.err || add.out).replaceAll(HOME + '/', '~/')}`)
  const sub = relative(top.out, cwd)
  const inside = sub && !sub.startsWith('..') && existsSync(join(path, sub)) ? join(path, sub) : path
  return { cwd: inside, worktree: { path, branch, repo: top.out, base: head.out } }
}

/**
 * Where a helper's worktree stands, and how to merge it: what its coordinator is told when it stops.
 * Paths print with ~ for the home folder (they end up in terminals, screenshots and pasted output) [T1110-83].
 */
export function worktreeReport(w: Worktree, name: string): string {
  const path = tildify(w.path)
  const repo = tildify(w.repo)
  if (!existsSync(w.path)) return `"${name}" worked on branch ${w.branch}; its worktree ${path} is gone. Merge with: git -C ${repo} merge --squash ${w.branch}`
  const dirty = git(w.path, ['status', '--porcelain']).out.split('\n').filter(Boolean).length
  const ahead = Number(git(w.repo, ['rev-list', '--count', `${w.base}..${w.branch}`]).out || 0)
  const parts = [`"${name}" worked in its own worktree ${path} on branch ${w.branch}: ${ahead} commit${ahead === 1 ? '' : 's'} on top of ${w.base.slice(0, 7)}`]
  if (dirty) parts.push(`${dirty} uncommitted file${dirty === 1 ? '' : 's'} left in the worktree (kept; Overvibe never deletes them): review and commit them there first (git -C ${path} status)`)
  if (ahead) parts.push(`to merge it: git -C ${repo} merge --squash ${w.branch} && git -C ${repo} commit (or git merge ${w.branch} to keep its commits)`)
  else if (!dirty) parts.push('nothing to merge')
  parts.push(`once merged: git -C ${repo} worktree remove ${path} && git -C ${repo} branch -D ${w.branch}`)
  return parts.join('; ')
}
