// Hover a file link in a terminal [T1112-114]: what the popover shows for a path findLink already resolved
// (so only what ⌘-click would open). Images: pixel size and a small thumbnail (sips on a Mac, else the file
// itself when it is small); text: the first lines, reading at most a few KB; folders: the first entries;
// PDFs and videos: name, size and time (a PDF gets its first page through sips on a Mac). Device files,
// sockets and pipes are refused; nothing reads a whole large file.
import { closeSync, mkdtempSync, openSync, opendirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { cleanEnv, tildify } from './env'
import { IS_MAC } from './platform'

export const LIMITS = {
  /** bytes read for the first lines of a text file */
  headBytes: 16 << 10,
  lines: 20,
  lineChars: 240,
  /** lines are counted only up to this size (read in chunks); bigger files say "over" */
  countBytes: 4 << 20,
  /** an image this small is sent as it is when it can't be resized */
  rawImage: 2 << 20,
  /** an image or PDF bigger than this gets no thumbnail */
  thumbSource: 80 << 20,
  // shown at up to 320 css px; twice that stays sharp on a retina screen
  thumbPx: 640,
  entries: 12,
  /** folder entries read to count them */
  scanEntries: 2000,
  thumbTtlMs: 120_000,
  thumbCacheMax: 60,
}

const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' }
const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'])
const BINARY = new Set(['.zip', '.gz', '.tgz', '.dmg', '.pkg', '.app', '.exe', '.so', '.dylib', '.o', '.a', '.class', '.jar', '.wasm', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.heic', '.tiff', '.ico', '.psd', '.sqlite', '.db', '.woff', '.woff2', '.ttf', '.otf', '.docx', '.xlsx', '.pptx'])

export type Preview = {
  path: string
  label: string
  name: string
  kind: 'image' | 'text' | 'folder' | 'pdf' | 'video' | 'file'
  size: number
  mtime: number
  width?: number
  height?: number
  /** a data: URL */
  thumb?: string
  lines?: string[]
  /** every line in the file; with `over`, at least this many */
  lineCount?: number
  over?: boolean
  entries?: { name: string; dir: boolean }[]
  total?: number
}

/** pixel size from the first bytes of a png, gif, jpeg or webp */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  if (buf.length >= 10 && buf.toString('latin1', 0, 4) === 'GIF8') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const k = buf.toString('latin1', 12, 16)
    if (k === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    if (k === 'VP8L') {
      const b = buf.readUInt32LE(21)
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
    }
    if (k === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return
      const m = buf[i + 1]!
      const len = buf.readUInt16BE(i + 2)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      i += 2 + len
    }
  }
}

/** width and height from an svg's root element (attributes, else its viewBox) */
function svgSize(text: string): { width: number; height: number } | undefined {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0]
  if (!root) return
  const num = (n: string) => Number(new RegExp(`\\b${n}=["']\\s*([\\d.]+)(?:px)?\\s*["']`).exec(root)?.[1])
  const w = num('width'), h = num('height')
  if (w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) }
  const vb = /viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(root)
  if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) }
}

/** the first `bytes` of a file */
function head(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0))
  } finally {
    closeSync(fd)
  }
}

/** newlines in the file, read in chunks up to `cap` bytes; past it, `over` */
function countLines(path: string, size: number, cap: number): { n: number; over: boolean } {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(256 << 10)
    let n = 0, at = 0, last = 10
    while (at < Math.min(size, cap)) {
      const got = readSync(fd, buf, 0, Math.min(buf.length, cap - at), at)
      if (!got) break
      for (let i = 0; i < got; i++) if (buf[i] === 10) n++
      last = buf[got - 1]!
      at += got
    }
    // a last line without a newline counts too
    return { n: n + (at > 0 && last !== 10 ? 1 : 0), over: size > cap }
  } finally {
    closeSync(fd)
  }
}

/** text, as far as a quick look can tell: no NUL bytes and mostly printable */
export function looksText(buf: Buffer): boolean {
  if (!buf.length) return true
  let odd = 0
  for (const b of buf.subarray(0, 4096)) {
    if (b === 0) return false
    if (b < 9 || (b > 13 && b < 32)) odd++
  }
  return odd / Math.min(buf.length, 4096) < 0.05
}

// thumbnails made recently, by path, size and mtime
const thumbs = new Map<string, { at: number; data?: string }>()
function cached(key: string): { data?: string } | undefined {
  const c = thumbs.get(key)
  if (c && Date.now() - c.at < LIMITS.thumbTtlMs) return c
  if (c) thumbs.delete(key)
}
function remember(key: string, data?: string) {
  thumbs.set(key, { at: Date.now(), data })
  while (thumbs.size > LIMITS.thumbCacheMax) thumbs.delete(thumbs.keys().next().value!)
}

/**
 * `sips` resizes (or renders a PDF's first page) to at most `px` on its long side, 4 s at most: a png where the
 * source may be see-through (png, webp), else a jpeg
 */
async function sipsThumb(path: string, px: number, alpha: boolean): Promise<string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'overvibe-thumb-'))
  const fmt = alpha ? 'png' : 'jpeg'
  const out = join(dir, 't.' + fmt)
  try {
    const p = Bun.spawn(['sips', '-Z', String(px), '-s', 'format', fmt, ...(alpha ? [] : ['-s', 'formatOptions', '70']), path, '--out', out], { env: cleanEnv(), stdout: 'ignore', stderr: 'ignore' })
    const timer = setTimeout(() => p.kill(), 4000)
    const code = await p.exited
    clearTimeout(timer)
    if (code !== 0) return
    return `data:image/${fmt};base64,` + readFileSync(out).toString('base64')
  } catch {
    return
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export type PreviewOpts = { sips?: boolean }

async function thumbFor(path: string, ext: string, size: number, mtime: number, o: PreviewOpts): Promise<string | undefined> {
  if (size > LIMITS.thumbSource) return
  const key = `${path}\0${size}\0${mtime}`
  const c = cached(key)
  if (c) return c.data
  let data: string | undefined
  const sips = o.sips ?? IS_MAC
  // gifs and svgs stay as they are (animation, vectors); others are resized when it saves something
  const raw = () => (size <= LIMITS.rawImage && IMAGE[ext] ? `data:${IMAGE[ext]};base64,${readFileSync(path).toString('base64')}` : undefined)
  if (ext === '.gif' || ext === '.svg') data = raw()
  else if (ext === '.pdf') data = sips ? await sipsThumb(path, LIMITS.thumbPx, false) : undefined
  else if (sips && size > 200 << 10) data = (await sipsThumb(path, LIMITS.thumbPx, ext === '.png' || ext === '.webp')) ?? raw()
  else data = raw()
  remember(key, data)
  return data
}

/** what the hover popover shows for `path`, a real path findLink returned */
export async function previewFile(path: string, o: PreviewOpts = {}): Promise<Preview> {
  const st = statSync(path)
  const base = { path, label: tildify(path), name: basename(path), size: st.size, mtime: st.mtimeMs }
  if (st.isDirectory()) {
    const names: { name: string; dir: boolean }[] = []
    let total = 0, over = false
    const d = opendirSync(path)
    try {
      for (let e = d.readSync(); e; e = d.readSync()) {
        if (++total > LIMITS.scanEntries) {
          over = true
          total--
          break
        }
        names.push({ name: e.name, dir: e.isDirectory() })
      }
    } finally {
      d.closeSync()
    }
    // folders first, dot entries last, then by name
    const rank = (x: { name: string; dir: boolean }) => (x.name.startsWith('.') ? 2 : 0) + (x.dir ? 0 : 1)
    names.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    return { ...base, kind: 'folder', entries: names.slice(0, LIMITS.entries), total, over }
  }
  if (!st.isFile()) throw new Error('not a regular file')
  const ext = extname(path).toLowerCase()
  if (IMAGE[ext]) {
    const first = head(path, ext === '.svg' ? 64 << 10 : 256 << 10)
    const dims = ext === '.svg' ? svgSize(first.toString('utf8')) : imageSize(first)
    return { ...base, kind: 'image', ...dims, thumb: await thumbFor(path, ext, st.size, st.mtimeMs, o) }
  }
  if (ext === '.pdf') return { ...base, kind: 'pdf', thumb: await thumbFor(path, ext, st.size, st.mtimeMs, o) }
  if (VIDEO.has(ext)) return { ...base, kind: 'video' }
  if (BINARY.has(ext)) return { ...base, kind: 'file' }
  const buf = head(path, LIMITS.headBytes)
  if (!looksText(buf)) return { ...base, kind: 'file' }
  let text = buf.toString('utf8')
  // a cut in the middle of a character or a line: drop the partial end
  if (buf.length === LIMITS.headBytes && text.lastIndexOf('\n') > 0) text = text.slice(0, text.lastIndexOf('\n'))
  // the empty piece after a final newline is not a line
  const all = text.split(/\r?\n/)
  if (all.length > 1 && all.at(-1) === '') all.pop()
  const lines = all.slice(0, LIMITS.lines).map((l) => (l.length > LIMITS.lineChars ? l.slice(0, LIMITS.lineChars) + '…' : l))
  const { n, over } = countLines(path, st.size, LIMITS.countBytes)
  return { ...base, kind: 'text', lines, lineCount: n, over }
}
