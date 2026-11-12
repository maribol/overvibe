// deck.json: a project folder's own description for the deck. Agents keep it up to date (skill
// `agent-deck`); the deck reads it, and its project wins over Settings names and the git repo name.
//   { "project": "my-app", "name": "my-app", "tasks": "TASKS.md", "account": "auto",
//     "dev": "bun run dev", "url": "http://localhost:5173", "notes": "..." }
//   "mode": "ask" starts its sessions with the tools' own approval prompts instead of auto mode [T1110-85]
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { untildify } from './env'

export type DeckJson = { project?: string; name?: string; tasks?: string; account?: string; mode?: string; dev?: string; url?: string; notes?: string }
const cache = new Map<string, { mtime: number; data: DeckJson | null }>()

/** deck.json of the folder or the nearest parent that has one (a session in a repo's subfolder). */
export function deckJsonFor(cwd: string): (DeckJson & { dir: string }) | null {
  let p = untildify(cwd)
  for (let i = 0; i < 6 && p && p !== '/'; i++) {
    const f = join(p, 'deck.json')
    if (existsSync(f)) {
      const mtime = statSync(f).mtimeMs
      let c = cache.get(f)
      if (!c || c.mtime !== mtime) {
        let data: DeckJson | null = null
        try {
          data = JSON.parse(readFileSync(f, 'utf8'))
        } catch {}
        c = { mtime, data }
        cache.set(f, c)
      }
      return c.data ? { ...c.data, dir: p } : null
    }
    p = p.replace(/\/[^/]+$/, '')
  }
  return null
}
