// Files dropped on a terminal. Browsers never say where a dropped file lives, so the page sends its
// name, size and mtime and we find it on disk (Spotlight first on a Mac, then a bounded scan of the usual
// folders). If it can't be found, the page uploads the bytes and we keep a copy under uploads/.
import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DATA_DIR, HOME, WORK_ROOT } from './env'
import { IS_MAC } from './platform'

export const MAX_UPLOAD = 200 * 1024 * 1024
const UPLOADS = join(DATA_DIR, 'uploads')

export type Wanted = { name: string; size: number; lastModified: number }

/** the same file: a regular file under home, same basename, same size, mtime within 2 s */
function matches(path: string, w: Wanted): number | null {
  if (!path.startsWith(HOME + '/') || basename(path) !== w.name) return null
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size !== w.size || Math.abs(st.mtimeMs - w.lastModified) > 2000) return null
    return st.mtimeMs
  } catch {
    return null
  }
}

async function spotlight(name: string): Promise<string[]> {
  // argv, never a shell: the name is whatever the page sent
  const proc = Bun.spawn(['mdfind', '-onlyin', HOME, '-name', name], { stdout: 'pipe', stderr: 'ignore' })
  const kill = setTimeout(() => proc.kill(), 5000)
  try {
    const out = await new Response(proc.stdout).text()
    return out.split('\n').filter(Boolean).slice(0, 2000)
  } finally {
    clearTimeout(kill)
  }
}

const SKIP = new Set(['node_modules', 'vendor', 'Library', 'dist', 'build', 'target', '__pycache__'])
/** home itself, then Downloads, Desktop, Documents and the work root, breadth first (shallow files are found
 *  first), a few levels deep, each with its own entry budget, all within a few seconds */
function scan(name: string): string[] {
  const found: string[] = []
  const until = Date.now() + 4000
  const roots: [string, number, number][] = [[HOME, 0, 2_000], [join(HOME, 'Downloads'), 3, 40_000], [join(HOME, 'Desktop'), 3, 40_000], [join(HOME, 'Documents'), 4, 60_000], ...(WORK_ROOT !== HOME ? [[WORK_ROOT, 6, 300_000] as [string, number, number]] : [])]
  for (const [root, maxDepth, cap] of roots) {
    let budget = cap
    let level = [root]
    for (let depth = 0; level.length && budget > 0 && Date.now() < until; depth++) {
      const next: string[] = []
      for (const dir of level) {
        if (budget <= 0 || Date.now() >= until) break
        let ents
        try {
          ents = readdirSync(dir, { withFileTypes: true })
        } catch {
          continue
        }
        budget -= ents.length
        for (const e of ents) {
          if (e.isFile() && e.name === name) found.push(join(dir, e.name))
          else if (depth < maxDepth && e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) next.push(join(dir, e.name))
        }
      }
      level = next
    }
  }
  return found
}

export async function locate(w: Wanted): Promise<string | null> {
  if (!w.name || w.name.includes('/') || w.name.includes('\0') || !Number.isFinite(w.size) || !Number.isFinite(w.lastModified)) return null
  const best = (paths: string[]) => {
    let pick: string | null = null
    let at = -Infinity
    for (const p of new Set(paths)) {
      const m = matches(p, w)
      if (m !== null && m > at) [pick, at] = [p, m]
    }
    return pick
  }
  // Spotlight is macOS only; on Linux and WSL the bounded scan is the whole search [T1111-8]
  return (IS_MAC ? best(await spotlight(w.name).catch(() => [])) : null) ?? best(scan(w.name))
}

/** a plain file name: no folders, no dot-dot, no control characters */
export function safeName(raw: string): string | null {
  const n = raw.normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (!n || n.includes('/') || n.includes('\\') || n === '.' || n === '..' || n.startsWith('..') || n.length > 200) return null
  return n
}

export function saveUpload(name: string, data: Uint8Array): string {
  mkdirSync(UPLOADS, { recursive: true, mode: 0o700 })
  chmodSync(UPLOADS, 0o700)
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  let path = join(UPLOADS, `${stamp}-${name}`)
  for (let i = 2; ; i++) {
    try {
      writeFileSync(path, data, { mode: 0o600, flag: 'wx' })
      return path
    } catch (e: any) {
      if (e?.code !== 'EEXIST' || i > 50) throw e
      path = join(UPLOADS, `${stamp}-${i}-${name}`)
    }
  }
}
