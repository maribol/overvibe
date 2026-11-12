// A folder's project name, the deck's own: deck.json `project` in the folder or a parent, else
// the name the owner set in Settings for the folder or a parent (projectNames), else the git repo's
// folder name (a worktree counts as its main repo), else the folder's own name.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { untildify } from './env'
import { deckJsonFor } from './deckjson'
import { getSettings } from './routing'

const gitCache = new Map<string, { at: number; root: string | null }>()

/** The repo a folder belongs to: the nearest parent with .git; a worktree's .git file points at its main repo. */
export function gitRoot(abs: string): string | null {
  const hit = gitCache.get(abs)
  if (hit && Date.now() - hit.at < 60_000) return hit.root
  let root: string | null = null
  let p = abs
  for (let i = 0; i < 12 && p && p !== '/'; i++) {
    const g = join(p, '.git')
    if (existsSync(g)) {
      root = p
      try {
        if (statSync(g).isFile()) {
          // "gitdir: /path/to/main/.git/worktrees/<name>"
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(g, 'utf8'))
          const i = m ? m[1]!.indexOf('/.git/worktrees/') : -1
          if (i > 0) root = m![1]!.slice(0, i)
        }
      } catch {}
      break
    }
    p = dirname(p)
  }
  gitCache.set(abs, { at: Date.now(), root })
  return root
}

/** The Settings name for this folder or its nearest named parent. */
export function namedProject(abs: string): string | null {
  const names = getSettings().projectNames ?? {}
  let p = abs
  while (p && p !== '/') {
    if (names[p]) return names[p]!
    p = dirname(p)
  }
  return null
}

export function projectFor(cwd: string): string {
  const abs = untildify(cwd).replace(/\/+$/, '') || '/'
  const dj = deckJsonFor(abs)
  if (dj?.project) return dj.project
  const named = namedProject(abs)
  if (named) return named
  const root = gitRoot(abs)
  return basename(root ?? abs) || abs
}
