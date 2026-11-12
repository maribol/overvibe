<script setup lang="ts">
// One real terminal: xterm.js on a WebSocket to `tmux attach` on the deck's tmux server.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal, type IBufferCell } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { BrushCleaning, Check, ChevronDown, Copy, Ellipsis, FolderInput, Square, UserRound, Zap, ZapOff } from 'lucide-vue-next'
import StatusPill from './StatusPill.vue'
import QueueChip from './QueueChip.vue'
import PromptBar from './PromptBar.vue'
import CompactModal from './CompactModal.vue'
import ContextMeter from './ContextMeter.vue'
import { type Row } from '../compactLink'
import { compileUser, linksAt, pathsOn, type Link, type LinkCtx, type Target, type UserMatcher } from '../links'
import type { UserLink } from '../../linkuser'
import { tasksFocus, tasksOn } from '../tasks'
import { midPath } from '../midPath'
import { alt } from '../keys'
import { ago, api, closeRow, setView, stopSession, STATUS, pillOf, accountsFor, askStop, copy, deck, draggedSession, switchSessionAccount, type Session } from '../deck'
import { SESSION_MIME, sessionRef } from '../../sessionref'
import { splitBracketed } from '../../slashpaste'

const props = defineProps<{ s: Session; active: boolean }>()
const el = ref<HTMLDivElement>()
const ended = ref(false)
let term: Terminal
let fit: FitAddon
const accEmail = computed(() => accountsFor(props.s.tool).find((a) => a.name === (props.s.account || 'default'))?.email ?? '')
let ws: WebSocket | null = null
let ro: ResizeObserver

function send(d: string) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(d)
}
// a pasted "/compact <long note>" would arrive as "[Pasted text #1]" and go to the model: type the
// command name, then paste the rest [T1112-132]
function input(d: string) {
  const s = props.s.kind === 'claude' && props.s.tool !== 'agy' ? splitBracketed(d) : null
  if (!s) return send(d)
  send(s[0])
  setTimeout(() => send(s[1]), 150)
}
// Copy on select, like Claude Code: every finished selection lands on the system clipboard. The server
// runs the clipboard command (pbcopy, clip.exe on WSL, wl-copy or xclip; the page's clipboard API fails whenever the tab lacks focus, as with an OSC 52 that
// arrives a moment after the mouse-up); the browser API is the fallback while the socket is down.
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
let lastCopy = { text: '', at: 0 }
function toClipboard(text: string) {
  if (!text) return
  // tmux's copy and the OSC 52 it forwards are one copy: one hint
  const now = Date.now()
  if (text === lastCopy.text && now - lastCopy.at < 1000) return
  lastCopy = { text, at: now }
  if (ws?.readyState === WebSocket.OPEN) send('\x00' + JSON.stringify({ copy: text }))
  else navigator.clipboard.writeText(text).catch(() => {})
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = false), 1200)
}
/** OSC 52 "set clipboard" from tmux or the agent; a read request ("?") is ignored, never answered */
function onOsc52(data: string): boolean {
  const b64 = data.slice(data.indexOf(';') + 1)
  if (!b64 || b64 === '?') return true
  try {
    toClipboard(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))))
  } catch {}
  return true
}

function sendSize() {
  // a hidden tab measures as a sliver; sending that would shrink the session for everyone
  if (!visible() || term.cols < 20 || term.rows < 5) return
  send('\x00' + JSON.stringify({ resize: [term.cols, term.rows] }))
}
const visible = () => props.active && (el.value?.offsetWidth ?? 0) > 200 && (el.value?.offsetHeight ?? 0) > 80
/** fit to the box, only while this terminal is the one on screen */
function refit() {
  if (visible()) fit.fit()
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/pty?t=${encodeURIComponent(props.s.tmux!)}`)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => {
    tries = 0
    ended.value = false
    refit()
    sendSize()
  }
  ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data))
  ws.onclose = () => {
    ws = null
    ended.value = true
    retry()
  }
}

// Reconnect on its own: the server restarting, the computer sleeping or a network blip all close the
// socket, but the tmux session keeps running. Back off to 5 s; stop once the session is gone.
let tries = 0
let timer: ReturnType<typeof setTimeout> | undefined
let gone = false
function retry() {
  clearTimeout(timer)
  if (gone || !props.s.tmux || props.s.status === 'ended') return
  timer = setTimeout(() => {
    if (ws || gone) return
    tries++
    connect()
  }, Math.min(5000, 300 * 2 ** tries))
}
// back from sleep or another tab: try now instead of waiting for the next retry
function wake() {
  if (!ws && !gone && document.visibilityState === 'visible') {
    tries = 0
    retry()
  }
}
document.addEventListener('visibilitychange', wake)
window.addEventListener('online', wake)

// the terminal's colours come from the theme tokens in style.css (--color-term*), read once at mount
function termTheme() {
  const v = (n: string, d: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d
  return { background: v('--color-term', '#101114'), foreground: v('--color-term-fg', '#e4e6eb'), cursor: v('--color-st-busy', '#c3f53c'), cursorAccent: v('--color-term', '#101114'), selectionBackground: v('--color-term-sel', '#3a4a12') }
}

const IS_MAC = navigator.platform.startsWith('Mac')
const wantsOpen = (e: MouseEvent) => (IS_MAC ? e.metaKey : e.ctrlKey)
/** the screen line (wrapped rows joined) holding buffer row `y0` (0-based), and its first row */
function logicalLine(y0: number): { text: string; top: number } {
  const b = term.buffer.active
  let top = y0
  while (top > 0 && b.getLine(top)?.isWrapped) top--
  let text = '', y = top
  do text += b.getLine(y)?.translateToString(true) ?? ''
  while (b.getLine(++y)?.isWrapped)
  return { text, top }
}
/**
 * The folders named near a link, nearest first [T1112-8]: paths before it on its own line, then on the
 * ~30 lines above (each right to left). The server tries a bare name or partial path in them first.
 */
function contextFor(y0: number, x0 = Infinity): string[] {
  const out: string[] = []
  const add = (p: string) => !out.includes(p) && out.push(p)
  const first = logicalLine(y0)
  const col = (y0 - first.top) * term.cols + x0
  for (const [t, at] of pathsOn(first.text).reverse()) if (at < col) add(t)
  for (let y = first.top - 1, n = 0; y >= 0 && n < 30; n++) {
    const l = logicalLine(y)
    for (const [t] of pathsOn(l.text).reverse()) add(t)
    y = l.top - 1
  }
  return out.slice(0, 40)
}
// the link under the pointer, for the right-click menu [T1112-8]; 'link' is one from the matcher list [T1112-137]
type Hovered = { kind: 'path' | 'url' | 'link'; text: string; y0: number; x0: number; link?: Link }
let hovered: Hovered | null = null
/** folder: the server says the path is a folder (a folder link without a trailing slash still opens in Finder) [T1112-131] */
const menu = ref<(Hovered & { left: number; top: number; folder?: boolean }) | null>(null)
// the "looks done" bar [T1112-6]: Close it is the click that closes (no second ask); Not now hides it for this session
const tidyLater = ref(new Set<string>(JSON.parse(sessionStorage.getItem('deck.tidyLater') || '[]')))
const closingIt = ref(false)
async function closeIt() {
  closingIt.value = true
  try {
    await stopSession(props.s.tmux!)
    await closeRow(props.s)
  } catch (err: any) {
    alert(err.message)
  } finally {
    closingIt.value = false
  }
}
function laterIt() {
  tidyLater.value = new Set([...tidyLater.value, props.s.key])
  sessionStorage.setItem('deck.tidyLater', JSON.stringify([...tidyLater.value]))
}
// a link the server is still looking for, the choices when it found several, or why it found none [T1112-17]
type Choice = { path: string; label: string; mtime: number }
type Finding = { left: number; top: number; rel: string; how: 'open' | 'reveal'; looking?: boolean; choices?: Choice[]; error?: string }
const finding = ref<Finding | null>(null)
let findSeq = 0
let findTimer: ReturnType<typeof setTimeout> | undefined
/** where a popover goes for a click at (x, y) in the page */
function spot(x: number, y: number) {
  const box = el.value!.parentElement!.getBoundingClientRect()
  return { left: Math.max(8, Math.min(x - box.left, box.width - 340)), top: Math.max(8, Math.min(y - box.top + 14, box.height - 220)) }
}
function closeFinding() {
  finding.value = null
  clearTimeout(findTimer)
}
/**
 * Open a path from the screen. The server tries the screen, the session's folders, its transcript and its
 * scratch folders, then searches wider; while that runs (over 250 ms) a "Looking for" note sits by the link.
 * Several matches: pick one here. `as`: the link's own text, when a choice is opened.
 */
async function openPath(path: string, context: string[] = [], how: 'open' | 'reveal' = 'open', at = { left: 16, top: 16 }, as?: string) {
  const seq = ++findSeq
  const rel = as ?? path
  clearTimeout(findTimer)
  finding.value = null
  findTimer = setTimeout(() => seq === findSeq && (finding.value = { ...at, rel, how, looking: true }), 250)
  try {
    const r = await api<{ path?: string; choices?: Choice[] }>('/api/open-file', { path, tmux: props.s.tmux, context, how, as })
    if (seq !== findSeq) return
    clearTimeout(findTimer)
    finding.value = r.choices?.length ? { ...at, rel, how, choices: r.choices } : null
  } catch (err: any) {
    if (seq !== findSeq) return
    clearTimeout(findTimer)
    finding.value = { ...at, rel, how, error: err.message }
    findTimer = setTimeout(() => seq === findSeq && (finding.value = null), 8000)
  }
}
/** the folder all choices share, so the list shows only the part that tells them apart */
const choiceRoot = computed(() => {
  const ls = finding.value?.choices?.map((c) => c.label) ?? []
  if (ls.length < 2) return ''
  let pre = ls[0]!
  for (const l of ls) while (!l.startsWith(pre)) pre = pre.slice(0, -1)
  return pre.slice(0, pre.lastIndexOf('/') + 1)
})
// a /compact the agent suggested, ⌘-clicked: its instructions, for the confirm dialog [T1112-91]
const compactAsk = ref<string | null>(null)
// Claude Code and Codex both have /compact; agy and plain shells don't
const compacts = computed(() => props.s.kind === 'claude' && props.s.where === 'deck' && !!props.s.tmux && props.s.tool !== 'agy')
function screenRow(y: number): Row | undefined {
  const b = term.buffer.active
  const l = b.getLine(y)
  if (!l) return undefined
  // a row xterm wrapped keeps its trailing spaces: the next row carries on from them
  const text = l.translateToString(!b.getLine(y + 1)?.isWrapped)
  // each character's foreground colour, so the link can end where Claude's inline-code colour ends [T1112-125]
  const fg: string[] = []
  // and the cell each character sits in: a wide character takes two [T1112-137]
  const xs: number[] = []
  let c: IBufferCell | undefined
  for (let i = 0; i < l.length && fg.length < text.length; i++) {
    c = l.getCell(i, c)
    if (!c) break
    if (!c.getWidth()) continue
    const k = c.isFgDefault() ? '' : `${c.getFgColorMode()}:${c.getFgColor()}`
    for (let n = Math.max(1, c.getChars().length); n > 0; n--) (fg.push(k), xs.push(i))
  }
  return { text, wrapped: l.isWrapped, fg, xs }
}
function closeCompact() {
  compactAsk.value = null
  nextTick(() => term.focus())
}
function pick(c: Choice) {
  const f = finding.value
  if (f) openPath(c.path, [], f.how, { left: f.left, top: f.top }, f.rel)
}

// What the link matchers know about this session's folder [T1112-137]: git repo, GitHub remote (both from the
// server, never guessed from the screen) and the user's links.json, loaded when the terminal opens or its folder changes.
const linkCwd = computed(() => props.s.here ?? props.s.cwd)
const linkInfo = ref<{ git: boolean; github: string | null }>({ git: false, github: null })
let userMatchers: UserMatcher[] = []
async function loadLinks() {
  try {
    const r = await api<{ git: boolean; github: string | null; user: UserLink[] }>(`/api/links?cwd=${encodeURIComponent(linkCwd.value)}`)
    linkInfo.value = { git: r.git, github: r.github }
    userMatchers = compileUser(r.user, (w) => console.warn(w))
  } catch {}
}
const linkCtx = (): LinkCtx => ({ compact: compacts.value, git: linkInfo.value.git, github: linkInfo.value.github, tasks: tasksOn.value, user: userMatchers })
// a hex word is only a commit link once the folder's repo says it has that commit
const commitOk = new Map<string, boolean>()
async function verified(links: Link[]): Promise<Link[]> {
  const key = (l: Link) => `${linkCwd.value}\0${l.text}`
  const need = links.filter((l) => l.verify === 'commit' && !commitOk.has(key(l)))
  if (need.length) {
    try {
      const r = await api<{ commits: string[] }>('/api/links/commits', { cwd: linkCwd.value, shas: need.map((l) => l.text) })
      for (const l of need) commitOk.set(key(l), r.commits.includes(l.text))
      if (commitOk.size > 2000) commitOk.clear()
    } catch {}
  }
  return links.filter((l) => l.verify !== 'commit' || commitOk.get(key(l)))
}
/** follow a link's target: a web page, the Tasks view on a line, or a copy */
function go(t: Target) {
  if (t.kind === 'url') window.open(t.url, '_blank', 'noopener')
  else if (t.kind === 'task') ((tasksFocus.value = { id: t.id, cwd: linkCwd.value }), setView('tasks'))
  else if (t.kind === 'copy') toClipboard(t.text)
  else if (t.kind === 'compact') compactAsk.value = t.args
}
const copyOf = (t: Target) => (t.kind === 'url' ? t.url : t.kind === 'task' ? t.id : t.kind === 'copy' ? t.text : t.kind === 'path' ? t.path : `/compact ${t.args}`)

// Hover a file link for 400 ms: a popover under it with a look inside (image, first lines, folder entries)
// and the link's actions [T1112-114]. The server finds the file as ⌘-click does, with the same cache. It
// closes when the pointer leaves the link and the popover, on scroll and on Esc, and never takes the focus.
type PeekData = {
  path?: string; label?: string; name?: string; kind?: 'image' | 'text' | 'folder' | 'pdf' | 'video' | 'file'
  size?: number; mtime?: number; width?: number; height?: number; thumb?: string
  lines?: string[]; lineCount?: number; over?: boolean; entries?: { name: string; dir: boolean }[]; total?: number
  missing?: boolean; choices?: Choice[]; error?: string
}
/** card: a link that is not a file, named with where it goes [T1112-137] */
type Peek = { text: string; left: number; top: number; above: boolean; data?: PeekData; card?: { title: string; where: string; link: Link } }
const peek = ref<Peek | null>(null)
let peekWait: ReturnType<typeof setTimeout> | undefined
let peekShut: ReturnType<typeof setTimeout> | undefined
let peekSeq = 0
let peekText = ''
let peekPending = false
// the hovered link's cells and the pointer's last spot over the terminal: xterm drops a link (a leave with no
// new hover) when its row is drawn again, though the pointer never moved
let peekCells = { y0: -1, x0: 0, len: 0 }
let pointer = { x: -1, y: -1 }
const peekCache = new Map<string, { at: number; data: PeekData }>()
/** the popover's place: under the link's first cell, or above it when the terminal has no room below */
function cellBox() {
  const screen = el.value!.querySelector('.xterm-screen') as HTMLElement | null
  const sr = (screen ?? el.value!).getBoundingClientRect()
  return { sr, cw: sr.width / term.cols, ch: sr.height / term.rows }
}
function under(y0: number, x0: number) {
  const box = el.value!.parentElement!.getBoundingClientRect()
  const { sr, cw, ch } = cellBox()
  const row = y0 - term.buffer.active.viewportY
  const left = Math.max(8, Math.min(sr.left - box.left + x0 * cw, box.width - 352))
  const below = sr.top - box.top + (row + 1) * ch + 2
  const above = below + 300 > box.height && row * ch > box.height / 2
  return { left, top: above ? sr.top - box.top + row * ch - 2 : below, above }
}
function closePeek() {
  peekSeq++
  peekText = ''
  peekPending = false
  clearTimeout(peekWait)
  clearTimeout(peekShut)
  peek.value = null
}
/** the pointer is on a path link: after 400 ms, look it up (cached for 20 s) and show the popover */
function peekSoon(text: string, ctx: () => string[], y0: number, x0: number) {
  clearTimeout(peekShut)
  if (peekText === text && (peek.value || peekPending)) return
  closePeek()
  peekText = text
  peekPending = true
  peekCells = { y0, x0, len: text.length }
  const seq = peekSeq
  peekWait = setTimeout(async () => {
    peekPending = false
    if (seq !== peekSeq || menu.value || finding.value) return
    const context = ctx()
    const key = `${text}\0${context.slice(0, 3).join('\0')}`
    peek.value = { text, ...under(y0, x0) }
    const hit = peekCache.get(key)
    let data = hit && Date.now() - hit.at < 20_000 ? hit.data : undefined
    if (!data) {
      const q = new URLSearchParams({ session: props.s.tmux ?? '', path: text, context: JSON.stringify(context.slice(0, 40)) })
      data = await api<PeekData>(`/api/file-preview?${q}`).catch((e: any) => ({ error: e.message }) as PeekData)
      peekCache.set(key, { at: Date.now(), data })
      if (peekCache.size > 100) peekCache.delete(peekCache.keys().next().value!)
    }
    if (seq === peekSeq && peek.value) peek.value = { ...peek.value, data }
  }, 400)
}
/** the pointer is on a link that goes somewhere else than a file: after 400 ms, a card saying where. Nothing is fetched. */
function cardSoon(link: Link) {
  clearTimeout(peekShut)
  if (peekText === link.text && (peek.value || peekPending)) return
  closePeek()
  peekText = link.text
  peekPending = true
  const { x, y } = link.range.start
  peekCells = { y0: y, x0: x, len: link.range.end.y === y ? link.range.end.x - x + 1 : term.cols - x }
  const seq = peekSeq
  peekWait = setTimeout(() => {
    peekPending = false
    if (seq !== peekSeq || menu.value || finding.value) return
    peek.value = { text: link.text, ...under(y, x), card: { title: link.card, where: whereOf(link.target), link } }
  }, 400)
}
const whereOf = (t: Target) =>
  t.kind === 'url' ? t.url : t.kind === 'task' ? `Tasks view, the ${t.id} line` : t.kind === 'copy' ? `Copies ${t.text}` : t.kind === 'path' ? t.path : '/compact'
const keepPeek = () => clearTimeout(peekShut)
/** the pointer left the link or the popover: close unless it reaches the other one soon */
function peekLeave() {
  clearTimeout(peekWait)
  clearTimeout(peekShut)
  peekPending = false
  if (!peek.value) return void (peekText = '')
  peekShut = setTimeout(closePeek, 180)
}
/** xterm says the pointer left the link: ignored while the pointer is still on the link's cells (a redraw) */
function linkLeave() {
  if (peekText && el.value) {
    const { sr, cw, ch } = cellBox()
    const col = Math.floor((pointer.x - sr.left) / cw), row = Math.floor((pointer.y - sr.top) / ch) + term.buffer.active.viewportY
    if (row === peekCells.y0 && col >= peekCells.x0 && col < peekCells.x0 + peekCells.len) return
  }
  peekLeave()
}
function peekAct(how: 'open' | 'reveal' | 'copy', path?: string) {
  const p = peek.value
  if (!p) return
  if (p.card) {
    closePeek()
    if (how === 'copy') toClipboard(copyOf(p.card.link.target))
    else go(p.card.link.target)
    return void term.focus()
  }
  const target = path ?? p.data?.path ?? p.text
  closePeek()
  if (how === 'copy') toClipboard(target)
  else openPath(target, [], how, { left: p.left, top: p.top }, path ? p.text : undefined)
  term.focus()
}
const bytes = (n = 0) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(1)} GB`)
const changed = (t?: number) => (t ? (ago(t) === 'now' ? 'changed just now' : `changed ${ago(t)} ago`) : '')
const peekMeta = computed(() => {
  const d = peek.value?.data
  if (!d?.kind) return ''
  const n = (x: number) => x.toLocaleString()
  if (d.kind === 'image') return [d.width && d.height ? `${n(d.width)} × ${n(d.height)}` : '', bytes(d.size)].filter(Boolean).join(' · ')
  if (d.kind === 'text') return `${d.over ? 'over ' : ''}${n(d.lineCount ?? 0)} ${d.lineCount === 1 ? 'line' : 'lines'} · ${bytes(d.size)}`
  if (d.kind === 'folder') return `${d.over ? 'over ' : ''}${n(d.total ?? 0)} ${d.total === 1 ? 'item' : 'items'} · ${changed(d.mtime)}`
  return `${bytes(d.size)} · ${changed(d.mtime)}`
})

onMounted(() => {
  term = new Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    macOptionIsMeta: true,
    // tmux (or Claude Code) owns the mouse; Option-drag makes xterm's own selection instead
    macOptionClickForcesSelection: true,
    allowProposedApi: true,
    scrollback: 10000,
    theme: termTheme(),
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  const hoverUrl = (_e: MouseEvent, text: string) => (hovered = { kind: 'url', text, y0: 0, x0: 0 })
  const leave = () => (hovered = null)
  // file paths: ⌘-click (Ctrl-click off a Mac) opens the file on this computer, in Chrome on a Mac [T1112-2].
  // Claude Code prints some as terminal links (file://...); the rest come from the matcher list below.
  term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (e, uri) => {
      if (/^file:/i.test(uri)) return void (wantsOpen(e) && openPath(uri, [], 'open', spot(e.clientX, e.clientY)))
      if (/^(https?|mailto):/i.test(uri)) window.open(uri, '_blank', 'noopener')
    },
    hover: (e, uri, r) => {
      hovered = /^file:/i.test(uri) ? { kind: 'path', text: uri, y0: r.start.y - 1, x0: r.start.x - 1 } : /^(https?|mailto):/i.test(uri) ? (hoverUrl(e, uri), hovered) : null
      if (hovered?.kind === 'path') peekSoon(uri, () => [], r.start.y - 1, r.start.x - 1)
    },
    leave: () => (leave(), linkLeave()),
  }
  // every other link on screen: one ordered matcher list (src/web/links.ts) [T1112-137]
  const screen = { row: screenRow }
  term.registerLinkProvider({
    provideLinks(y, cb) {
      const found = linksAt(screen, y - 1, linkCtx())
      const xlink = (l: Link) => {
        const { start, end } = l.range
        const t = l.target
        return {
          text: l.text,
          range: { start: { x: start.x + 1, y: start.y + 1 }, end: { x: end.x + 1, y: end.y + 1 } },
          decorations: { underline: true, pointerCursor: true },
          // web links open on a click, as they always did; files, /compact, tasks and copies on ⌘-click
          activate: (e: MouseEvent) => {
            if (t.kind === 'url') return void window.open(t.url, '_blank', 'noopener')
            if (!wantsOpen(e)) return
            if (t.kind === 'path') openPath(t.path, contextFor(start.y, start.x), 'open', spot(e.clientX, e.clientY))
            else go(t)
          },
          hover: () => {
            if (t.kind === 'compact') return void (hovered = null)
            if (t.kind === 'path') return void ((hovered = { kind: 'path', text: t.path, y0: start.y, x0: start.x }), peekSoon(t.path, () => contextFor(start.y, start.x), start.y, start.x))
            hovered = { kind: 'link', text: l.text, y0: start.y, x0: start.x, link: l }
            cardSoon(l)
          },
          leave: () => (leave(), linkLeave()),
        }
      }
      if (!found.some((l) => l.verify)) return cb(found.length ? found.map(xlink) : undefined)
      void verified(found).then((ok) => cb(ok.length ? ok.map(xlink) : undefined))
    },
  })
  // OSC 52 from tmux / Claude Code (their copy on select) -> the system clipboard
  term.parser.registerOscHandler(52, onOsc52)
  term.open(el.value!)
  // right-click on a link: our menu, and the press never reaches the session (Claude Code tracks the
  // mouse, so tmux would get it as a click, and a click can answer a choice menu) [T1112-8]
  const onLink = (e: MouseEvent) => e.button === 2 && !!(hovered || menu.value)
  for (const t of ['mousedown', 'mouseup', 'auxclick'] as const)
    el.value!.addEventListener(t, (e) => {
      if (!onLink(e)) return
      e.preventDefault()
      e.stopPropagation()
    }, true)
  el.value!.addEventListener('contextmenu', (e) => {
    if (!hovered) return
    e.preventDefault()
    e.stopPropagation()
    const box = el.value!.parentElement!.getBoundingClientRect()
    menu.value = { ...hovered, left: Math.min(e.clientX - box.left, box.width - 180), top: Math.min(e.clientY - box.top, box.height - 80) }
    if (hovered.kind === 'path') void folderCheck(menu.value)
  }, true)
  // xterm's own selection (Option-drag, or any drag in a program without mouse use): copy when the
  // mouse is released, not on every change while dragging. ⌘C copies it too (the browser's copy).
  el.value!.addEventListener('mouseup', () => setTimeout(() => term.hasSelection() && toClipboard(term.getSelection())))
  // ⌘C with a selection: copy it through the server as well (the browser's own copy needs focus);
  // without one, ⌘C does nothing, as in Terminal.app (Ctrl-C is the interrupt)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'c' && term.hasSelection()) toClipboard(term.getSelection())
    return true
  })
  // scrolling moves the link away from its popover [T1112-114]
  term.onScroll(() => peek.value && closePeek())
  el.value!.addEventListener('wheel', () => peek.value && closePeek(), { passive: true, capture: true })
  el.value!.addEventListener('mousemove', (e) => (pointer = { x: e.clientX, y: e.clientY }), { passive: true, capture: true })
  el.value!.addEventListener('mouseleave', () => peekText && peekLeave())
  term.onData(input)
  term.onBinary(send)
  term.onResize(sendSize)
  ro = new ResizeObserver(() => refit())
  ro.observe(el.value!)
  connect()
  void loadLinks()
  if (props.active) nextTick(() => term.focus())
})

watch(linkCwd, () => void loadLinks())
watch(
  () => props.active,
  (a) => a && nextTick(() => { refit(); sendSize(); term.focus() }),
)

/** is the menu's path a folder: the hover preview's answer when it has one, else ask the server [T1112-131] */
async function folderCheck(m: NonNullable<typeof menu.value>) {
  const context = /^file:/i.test(m.text) ? [] : contextFor(m.y0, m.x0)
  const key = `${m.text}\0${context.slice(0, 3).join('\0')}`
  let data = peekCache.get(key)?.data
  if (!data) {
    const q = new URLSearchParams({ session: props.s.tmux ?? '', path: m.text, context: JSON.stringify(context.slice(0, 40)) })
    data = await api<PeekData>(`/api/file-preview?${q}`).catch(() => undefined)
    if (data) peekCache.set(key, { at: Date.now(), data })
  }
  if (menu.value === m && data && 'kind' in data && data.kind === 'folder') menu.value = { ...m, folder: true }
}
function closeMenu() {
  menu.value = null
}
function menuOpen(how: 'open' | 'reveal') {
  const m = menu.value
  closeMenu()
  if (!m) return
  if (m.kind === 'url') return void window.open(m.text, '_blank', 'noopener')
  if (m.link) return go(m.link.target)
  openPath(m.text, /^file:/i.test(m.text) ? [] : contextFor(m.y0, m.x0), how, { left: m.left, top: m.top })
}
function menuCopy() {
  const m = menu.value
  closeMenu()
  if (m) toClipboard(m.link ? copyOf(m.link.target) : m.text)
}
/** the menu's second item for a matcher's link: copy what it points at (a copy link has only its one item) */
const menuCopyLabel = (l: Link) => (l.target.kind === 'url' ? 'Copy link' : l.target.kind === 'task' ? `Copy ${l.target.id}` : '')
const outside = (e: MouseEvent) => {
  const t = e.target as HTMLElement
  if (menu.value && !t?.closest?.('[data-link-menu]')) closeMenu()
  if (finding.value && !finding.value.looking && !t?.closest?.('[data-link-find]')) closeFinding()
  if (peek.value && !t?.closest?.('[data-link-peek]')) closePeek()
}
const onEsc = (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return
  if (menu.value) closeMenu()
  if (finding.value) (findSeq++, closeFinding())
  if (peek.value) closePeek()
}
window.addEventListener('mousedown', outside, true)
window.addEventListener('keydown', onEsc, true)
window.addEventListener('blur', closeMenu)
window.addEventListener('blur', closePeek)

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', outside, true)
  window.removeEventListener('keydown', onEsc, true)
  window.removeEventListener('blur', closeMenu)
  window.removeEventListener('blur', closePeek)
  clearTimeout(peekWait)
  clearTimeout(peekShut)
  gone = true
  clearTimeout(timer)
  clearTimeout(copiedTimer)
  document.removeEventListener('visibilitychange', wake)
  window.removeEventListener('online', wake)
  ro?.disconnect()
  ws?.close()
  term?.dispose()
})

// Drag a file from Finder onto the terminal: type its full path at the cursor, like Terminal.app does.
// The browser never says where a file lives, so the server looks it up by name, size and mtime;
// a file it can't find (from another app, a zip, a browser download in flight) is uploaded instead.
const dragging = ref(false)
const dropBusy = ref(false)
const dropErr = ref('')
let dragDepth = 0
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
// a sidebar row dragged here [T1111-17]: an agent's terminal gets a one-line mention of it in its input box;
// its own terminal and a plain shell refuse it with a hint
const hasSession = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes(SESSION_MIME)
const draggingSession = ref(false)
const isAgent = computed(() => props.s.kind === 'claude' && props.s.where === 'deck' && !!props.s.tmux)
const sessionRefusal = computed(() =>
  !isAgent.value ? "Only an agent's terminal takes a session" : draggedSession.value && draggedSession.value === props.s.tmux ? 'Drop it on another session' : '')
const draggedTitle = computed(() => deck.sessions.find((x) => x.tmux === draggedSession.value)?.title ?? 'the session')
function onDragEnter(e: DragEvent) {
  const session = hasSession(e)
  if (!hasFiles(e) && !session) return
  e.preventDefault()
  dragDepth++
  dragging.value = true
  draggingSession.value = session
}
function onDragOver(e: DragEvent) {
  if (hasSession(e)) {
    e.preventDefault()
    e.dataTransfer!.dropEffect = sessionRefusal.value ? 'none' : 'copy'
    return
  }
  if (!hasFiles(e)) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
}
function onDragLeave(e: DragEvent) {
  if (!hasFiles(e) && !hasSession(e)) return
  if (--dragDepth <= 0) (dragDepth = 0), (dragging.value = false)
}
// a refused drop fires no drop event here; the row's dragend clears the highlight
watch(draggedSession, (v) => !v && draggingSession.value && ((dragDepth = 0), (dragging.value = false), (draggingSession.value = false)))
function onSessionDrop(e: DragEvent) {
  e.preventDefault()
  dragDepth = 0
  dragging.value = false
  draggingSession.value = false
  const key = e.dataTransfer?.getData(SESSION_MIME)
  const src = key ? deck.sessions.find((x) => x.tmux === key) : undefined
  if (!src || key === props.s.tmux || !isAgent.value) return
  // a paste (bracketed when the tool asked for it), so nothing is typed as keys and no Enter goes with it
  term.paste(sessionRef(src, deck.homeAbs))
  term.focus()
}
/** shell-safe: plain paths as they are, anything else in single quotes */
const quote = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)
async function pathFor(f: File): Promise<string> {
  const r = await fetch('/api/locate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, size: f.size, lastModified: f.lastModified }) })
  const found = r.ok ? (await r.json()).path : null
  if (found) return found
  const u = await fetch('/api/upload', { method: 'POST', headers: { 'x-file-name': encodeURIComponent(f.name), 'content-type': 'application/octet-stream' }, body: f })
  const j = await u.json().catch(() => ({}))
  if (!u.ok || !j.path) throw new Error(`${f.name}: ${j.error ?? 'upload failed'}`)
  return j.path
}
async function onDrop(e: DragEvent) {
  if (hasSession(e)) return onSessionDrop(e)
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  dragging.value = false
  const files = [...(e.dataTransfer?.files ?? [])]
  if (!files.length) return
  dropErr.value = ''
  dropBusy.value = true
  try {
    const paths: string[] = []
    for (const f of files) {
      try {
        paths.push(await pathFor(f))
      } catch (err: any) {
        dropErr.value = err.message
      }
    }
    // a paste, as a real terminal does on drop: lands at the cursor, no Enter
    if (paths.length) term.paste(paths.map(quote).join(' ') + ' ')
    term.focus()
  } finally {
    dropBusy.value = false
  }
}

const resumeCmd = () => `cd ${props.s.cwd} && claude --resume ${props.s.sessionId}`
const switchErr = ref('')
async function switchTo(to: string) {
  acctOpen.value = false
  if (to === (props.s.account ?? 'default')) return
  if (!confirm(`Restart "${props.s.title}" on ${to}? Same conversation, other subscription.`)) return
  try {
    await switchSessionAccount(props.s.tmux!, to)
  } catch (err: any) {
    switchErr.value = err.message
  }
}
const stop = () => askStop(props.s)

// The header [T1112-124]: the folder gets the room. Its path is cut from the middle to fit, never below about
// 30 characters; as the header narrows, the tags turn into icons first, then Move and Resume go into a ⋯ menu.
const hdr = ref<HTMLElement>()
const pathEl = ref<HTMLElement>()
const hdrW = ref(1200)
const tight = computed(() => hdrW.value < 1000)
const narrow = computed(() => hdrW.value < 800)
const fullPath = computed(() => props.s.here ?? props.s.cwd)
const projectName = computed(() => (props.s.here ? props.s.hereProject : props.s.project) || '')
const pathTitle = computed(() => (props.s.here ? `${fullPath.value}\nStarted in ${props.s.cwd}` : fullPath.value))
const shownPath = ref(fullPath.value)
const measureEl = ref<HTMLElement>()
function fitPath() {
  const box = pathEl.value, m = measureEl.value
  const w = box?.clientWidth ?? 0
  if (!box || !m || w < 20) return void (shownPath.value = fullPath.value)
  // measured in a hidden twin of the path (same font), so the real font's widths count
  shownPath.value = midPath(fullPath.value, (t) => ((m.textContent = t), m.scrollWidth <= w))
}
/** copying from the path copies the whole path, even when the middle is cut */
function copyPath(e: ClipboardEvent) {
  if (!e.clipboardData) return
  e.clipboardData.setData('text/plain', fullPath.value)
  e.preventDefault()
}
let hdrRo: ResizeObserver | undefined
onMounted(() => {
  hdrRo = new ResizeObserver(() => {
    if (hdr.value?.clientWidth) hdrW.value = hdr.value.clientWidth
    fitPath()
  })
  if (hdr.value) hdrRo.observe(hdr.value)
  if (pathEl.value) hdrRo.observe(pathEl.value)
  document.fonts?.ready.then(fitPath)
})
onBeforeUnmount(() => hdrRo?.disconnect())
watch(fullPath, () => nextTick(fitPath))

// one account control: the name on a button, the email and the picker in its menu
const acctOpen = ref(false)
const moreOpen = ref(false)
const accountName = computed(() => props.s.account || 'default')
const hasAccount = computed(() => props.s.kind === 'claude' && !props.s.hand && (props.s.tool === 'codex' || (props.s.tool ?? 'claude') === 'claude'))
const canSwitch = computed(() => hasAccount.value && (props.s.tool ?? 'claude') === 'claude')
const acctTitle = computed(() =>
  `${props.s.tool === 'codex' ? 'Codex account' : 'Account'}: ${accountName.value}${accEmail.value ? ` · ${accEmail.value}` : ''}${canSwitch.value ? '. Click to switch' : ''}`)
const shut = (e: MouseEvent) => {
  const t = e.target as HTMLElement
  if (acctOpen.value && !t?.closest?.('[data-acct-menu]')) acctOpen.value = false
  if (moreOpen.value && !t?.closest?.('[data-more-menu]')) moreOpen.value = false
}
const shutEsc = (e: KeyboardEvent) => e.key === 'Escape' && ((acctOpen.value = false), (moreOpen.value = false))
window.addEventListener('mousedown', shut, true)
window.addEventListener('keydown', shutEsc, true)
onBeforeUnmount(() => {
  window.removeEventListener('mousedown', shut, true)
  window.removeEventListener('keydown', shutEsc, true)
})
const canMove = computed(() => !!props.s.sessionId && props.s.kind === 'claude' && !props.s.hand)
const moveTitle = 'Move to another folder (started in the wrong one?)'
const resumeTitle = 'Copy a command that resumes this session in any terminal'
const stopTitle = computed(() => `Stop (asks first; the conversation is kept). ${alt('W')} stops and closes it`)
const autoTitle = computed(() =>
  props.s.mode === 'ask' ? 'Auto mode off (ask mode): the tool asks before commands and edits; the session turns yellow until you answer' : 'Auto mode on: the tool runs commands and edits without asking, with its own safety checks')
</script>

<template>
  <div v-show="active" class="absolute inset-0 flex flex-col bg-canvas">
    <div ref="hdr" data-term-header class="flex flex-none items-center border-b border-line bg-surface px-4 py-2 text-[12.5px] text-muted" :class="narrow ? 'gap-1.5' : 'gap-2'">
      <StatusPill class="flex-none" :label="pillOf(s).label" :tone="pillOf(s).tone" :pulse="pillOf(s).pulse" />
      <!-- the folder: project, then the path cut from the middle; selectable, and a copy takes the whole path -->
      <div class="relative flex min-w-0 flex-1 items-baseline gap-1.5">
        <template v-if="projectName">
          <span class="min-w-0 truncate font-medium text-ink-soft" :class="narrow ? 'max-w-[12ch]' : 'max-w-[22ch]'" :title="`Project: ${projectName}`">{{ projectName }}</span>
          <span class="flex-none text-faint">·</span>
        </template>
        <span ref="pathEl" data-term-path class="pill-mono min-w-[30ch] flex-1 select-text overflow-hidden whitespace-nowrap" :title="pathTitle" @copy="copyPath">{{ shownPath }}</span>
        <span ref="measureEl" aria-hidden="true" class="pill-mono pointer-events-none invisible absolute whitespace-nowrap"></span>
      </div>
      <span v-if="s.kind === 'claude' && s.tool === 'agy'" class="flex-none rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-ink-soft" title="agy uses one login">agy</span>
      <span v-if="s.kind === 'claude' && s.tool === 'codex' && s.hand" class="flex-none rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-ink-soft">codex</span>
      <span v-if="s.kind === 'claude' && (s.tool ?? 'claude') === 'claude' && s.hand" class="flex-none rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-ink-soft">claude</span>
      <span v-if="s.hand" class="flex-none rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-ink-soft" title="Started by hand in this terminal: Overvibe did not choose its account, mode or Remote Control. When it exits, this row is a terminal again and the conversation stays in past sessions.">{{ tight ? 'by hand' : 'started by hand' }}</span>
      <span v-if="s.kind === 'claude' && s.where === 'deck' && !s.hand" data-auto-mode class="inline-flex flex-none items-center rounded-md border py-0.5 text-[11.5px]"
        :class="[s.mode === 'ask' ? 'border-transparent bg-[var(--color-chip-green-bg)] text-[var(--color-chip-green-fg)]' : 'border-line text-ink-soft', tight ? 'px-1' : 'px-1.5']"
        :title="autoTitle"><template v-if="tight"><ZapOff v-if="s.mode === 'ask'" :size="13" /><Zap v-else :size="13" /></template><template v-else>{{ s.mode === 'ask' ? 'auto mode off' : 'auto mode' }}</template></span>
      <ContextMeter v-if="s.kind === 'claude'" :key="s.sessionId ?? s.key" :s="s" :compact="tight" />
      <QueueChip v-if="s.queue?.length" class="flex-none" :queue="s.queue" :name="s.title" />
      <span v-if="switchErr" class="min-w-0 max-w-[30%] truncate text-[var(--color-chip-red-fg)]" :title="switchErr" @click="switchErr = ''">{{ switchErr }}</span>
      <span v-if="dropErr" class="min-w-0 max-w-[30%] truncate text-[var(--color-chip-red-fg)]" :title="dropErr" @click="dropErr = ''">{{ dropErr }}</span>
      <!-- the account: one button, the email and the picker in its menu -->
      <div v-if="hasAccount" class="relative flex-none" data-acct-menu>
        <button class="btn btn-ghost btn-sm !gap-1 !px-2 !py-1 !text-[12px]" data-acct-button :title="acctTitle" @click="acctOpen = !acctOpen">
          <UserRound :size="13" class="flex-none" />
          <span class="truncate" :class="narrow ? 'max-w-[10ch]' : 'max-w-[18ch]'"><template v-if="s.tool === 'codex' && !narrow">codex · </template>{{ accountName }}</span>
          <ChevronDown :size="12" class="flex-none text-faint" />
        </button>
        <div v-if="acctOpen" class="absolute right-0 top-full z-30 mt-1.5 min-w-[220px] max-w-[320px] rounded-lg border border-line bg-surface py-1 text-[12.5px] text-ink shadow-lg">
          <div class="px-3 pb-1 pt-1.5">
            <div class="text-[11px] text-faint">{{ s.tool === 'codex' ? 'Codex account' : 'Runs on' }}</div>
            <div class="truncate font-medium">{{ accountName }}</div>
            <div v-if="accEmail" class="select-text truncate text-[11.5px] text-faint" :title="accEmail">{{ accEmail }}</div>
          </div>
          <template v-if="canSwitch">
            <div class="mt-1 border-t border-line px-3 pb-0.5 pt-1.5 text-[11px] text-faint">Switch to (restarts it, same conversation)</div>
            <button v-for="a in accountsFor('claude')" :key="a.name" class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-canvas-2 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="a.paused && a.name !== accountName" :title="a.email || undefined" @click="switchTo(a.name)">
              <Check :size="13" class="flex-none" :class="a.name === accountName ? '' : 'invisible'" />
              <span class="truncate">{{ a.name }}{{ a.paused ? ' · paused' : '' }}</span>
            </button>
          </template>
        </div>
      </div>
      <button v-if="ended" class="btn btn-soft btn-sm flex-none" title="Reconnecting on its own; click to try now" @click="(tries = 0), connect()">{{ narrow ? 'Reconnect' : 'Reconnecting…' }}</button>
      <template v-if="!narrow">
        <button v-if="canMove" class="btn btn-ghost btn-sm flex-none !px-2" data-move :title="moveTitle" :aria-label="moveTitle" @click="deck.moveFor = s"><FolderInput :size="14" /></button>
        <button v-if="s.sessionId" class="btn btn-ghost btn-sm flex-none !px-2" data-resume :title="resumeTitle" :aria-label="resumeTitle" @click="copy(resumeCmd())"><Copy :size="14" /></button>
      </template>
      <div v-else-if="canMove || s.sessionId" class="relative flex-none" data-more-menu>
        <button class="btn btn-ghost btn-sm !px-2" data-more title="More: move to another folder, copy the resume command" aria-label="More" @click="moreOpen = !moreOpen"><Ellipsis :size="14" /></button>
        <div v-if="moreOpen" class="absolute right-0 top-full z-30 mt-1.5 min-w-[220px] rounded-lg border border-line bg-surface py-1 text-[12.5px] text-ink shadow-lg">
          <button v-if="canMove" class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-canvas-2" @click="(moreOpen = false), (deck.moveFor = s)"><FolderInput :size="13" /> Move to another folder…</button>
          <button v-if="s.sessionId" class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-canvas-2" @click="(moreOpen = false), copy(resumeCmd())"><Copy :size="13" /> Copy resume command</button>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm flex-none !px-2 hover:!border-[var(--color-danger)] hover:!text-[var(--color-danger)]" data-stop :title="stopTitle" aria-label="Stop" @click="stop"><Square :size="13" /></button>
    </div>
    <!-- a session that looks done: close it in one click [T1112-6] -->
    <div v-if="s.tidy && !tidyLater.has(s.key)" class="flex flex-none items-center gap-3 border-b border-line bg-canvas-2 px-4 py-1.5 text-[12.5px] text-muted">
      <BrushCleaning :size="14" class="flex-none" />
      <span class="min-w-0 flex-1 truncate">Looks done: {{ s.tidy }}. Closing stops it and hides it; the conversation is kept.</span>
      <button class="btn btn-sm btn-danger" :disabled="closingIt" @click="closeIt">Close it</button>
      <button class="btn btn-sm btn-ghost" @click="laterIt">Not now</button>
    </div>
    <div class="relative min-h-0 flex-1 bg-[var(--color-term)] p-2 pr-0" @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
      <div ref="el" class="h-full w-full" @contextmenu.prevent="term.hasSelection() && toClipboard(term.getSelection())"></div>
      <PromptBar :title="s.title" :active="active" />
      <CompactModal v-if="compactAsk !== null" :s="s" :args="compactAsk" @close="closeCompact" />
      <div v-if="menu" data-link-menu class="absolute z-30 min-w-[160px] rounded-lg border border-line bg-surface py-1 text-[12.5px] text-ink shadow-lg" :style="{ left: menu.left + 'px', top: menu.top + 'px' }" @contextmenu.prevent>
        <template v-if="menu.kind === 'path'">
          <button class="block w-full px-3 py-1.5 text-left hover:bg-canvas-2" @click="menuOpen('open')">{{ menu.text.endsWith('/') || menu.folder ? (IS_MAC ? 'Open in Finder' : 'Open folder') : IS_MAC ? 'Open in Chrome' : 'Open' }}</button>
          <button class="block w-full px-3 py-1.5 text-left hover:bg-canvas-2" @click="menuOpen('reveal')">{{ IS_MAC ? 'Show in Finder' : 'Show in folder' }}</button>
        </template>
        <template v-else-if="menu.link">
          <button data-link-go class="block w-full px-3 py-1.5 text-left hover:bg-canvas-2" @click="menuOpen('open')">{{ menu.link.label }}</button>
          <button v-if="menuCopyLabel(menu.link)" class="block w-full px-3 py-1.5 text-left hover:bg-canvas-2" @click="menuCopy">{{ menuCopyLabel(menu.link) }}</button>
        </template>
        <template v-else>
          <button class="block w-full px-3 py-1.5 text-left hover:bg-canvas-2" @click="menuOpen('open')">Open</button>
          <button class="block w-full px-3 py-1.5 text-left hover:bg-canvas-2" @click="menuCopy">Copy link</button>
        </template>
      </div>
      <div v-if="finding" data-link-find class="absolute z-30 max-w-[340px] rounded-lg border border-line bg-surface py-1 text-[12.5px] text-ink shadow-lg" :style="{ left: finding.left + 'px', top: finding.top + 'px' }" @contextmenu.prevent>
        <div v-if="finding.looking" class="flex items-center gap-2 px-3 py-1.5 text-ink-soft">
          <span class="inline-block h-3 w-3 flex-none animate-spin rounded-full border-2 border-line border-t-[var(--color-brand-500)]"></span>
          <span class="truncate">Looking for {{ finding.rel }}…</span>
        </div>
        <template v-else-if="finding.choices">
          <div class="px-3 py-1 text-[11.5px] text-faint">{{ finding.choices.length }} places have {{ finding.rel }}<template v-if="choiceRoot">, all in {{ choiceRoot }}</template>. Which one?</div>
          <button v-for="c in finding.choices" :key="c.path" class="block w-full px-3 py-1.5 text-left hover:bg-canvas-2" :title="c.path" @click="pick(c)">
            <span class="block truncate">{{ c.label.slice(choiceRoot.length) }}</span>
            <span class="block text-[11px] text-faint">{{ ago(c.mtime) === 'now' ? 'changed just now' : `changed ${ago(c.mtime)} ago` }}</span>
          </button>
          <button class="block w-full px-3 py-1 text-left text-[11.5px] text-faint hover:bg-canvas-2" @click="closeFinding">Cancel</button>
        </template>
        <button v-else class="block w-full px-3 py-1.5 text-left text-ink-soft" @click="closeFinding">{{ finding.error }}</button>
      </div>
      <!-- hover preview of a file link [T1112-114]: buttons keep the focus in the terminal (mousedown.prevent) -->
      <div v-if="peek" data-link-peek class="absolute z-30 w-[340px] rounded-lg border border-line bg-surface text-[12.5px] text-ink shadow-lg"
        :style="{ left: peek.left + 'px', top: peek.top + 'px', transform: peek.above ? 'translateY(-100%)' : undefined }"
        @mouseenter="keepPeek" @mouseleave="peekLeave" @mousedown.prevent @contextmenu.prevent>
        <!-- a link that goes somewhere else than a file: where it goes, nothing fetched [T1112-137] -->
        <template v-if="peek.card">
          <div data-link-card class="cursor-pointer px-3 pb-1 pt-2" @click="peekAct('open')">
            <div class="truncate font-medium">{{ peek.card.title }}</div>
            <div class="break-all font-mono text-[11.5px] text-faint">{{ peek.card.where }}</div>
          </div>
          <div class="flex gap-1 px-2 py-2">
            <button class="btn btn-ghost btn-sm" @click="peekAct('open')">{{ peek.card.link.target.kind === 'copy' ? 'Copy' : 'Open' }}</button>
            <button v-if="menuCopyLabel(peek.card.link)" class="btn btn-ghost btn-sm" @click="peekAct('copy')">{{ menuCopyLabel(peek.card.link) }}</button>
          </div>
        </template>
        <div v-else-if="!peek.data" class="flex items-center gap-2 px-3 py-2 text-ink-soft">
          <span class="inline-block h-3 w-3 flex-none animate-spin rounded-full border-2 border-line border-t-[var(--color-brand-500)]"></span>
          <span class="truncate">{{ peek.text }}</span>
        </div>
        <template v-else-if="peek.data.kind">
          <div class="cursor-pointer px-3 pb-1.5 pt-2" @click="peekAct('open')">
            <div class="truncate font-medium" :title="peek.data.path">{{ peek.data.name }}</div>
            <div class="truncate text-[11.5px] text-faint" :title="peek.data.path">{{ peek.data.label }}</div>
            <div class="text-[11.5px] text-faint tabular-nums">{{ peekMeta }}</div>
          </div>
          <!-- the preview itself opens the file, as Open does -->
          <div v-if="peek.data.thumb" class="mx-2 flex max-h-[240px] cursor-pointer justify-center overflow-hidden rounded-md bg-canvas-2" title="Open" @click="peekAct('open')">
            <img :src="peek.data.thumb" alt="" class="max-h-[240px] max-w-[320px] object-contain" draggable="false" />
          </div>
          <pre v-else-if="peek.data.lines" title="Open" @click="peekAct('open')" class="mx-2 cursor-pointer max-h-[260px] overflow-hidden rounded-md bg-[var(--color-term)] px-2 py-1.5 font-mono text-[11px] leading-[1.35] text-[var(--color-term-fg)]">{{ peek.data.lines.join('\n') || ' ' }}</pre>
          <ul v-else-if="peek.data.entries" title="Open" @click="peekAct('open')" class="mx-2 cursor-pointer rounded-md bg-canvas-2 px-2 py-1 font-mono text-[11.5px]">
            <li v-for="e in peek.data.entries" :key="e.name" class="truncate" :class="e.name.startsWith('.') ? 'text-faint' : ''">{{ e.name }}{{ e.dir ? '/' : '' }}</li>
            <li v-if="!peek.data.entries.length" class="text-faint">empty folder</li>
            <li v-else-if="(peek.data.total ?? 0) > peek.data.entries.length" class="text-faint">and {{ peek.data.over ? 'over ' : '' }}{{ ((peek.data.total ?? 0) - peek.data.entries.length).toLocaleString() }} more</li>
          </ul>
          <div class="flex gap-1 px-2 py-2">
            <button class="btn btn-ghost btn-sm" @click="peekAct('open')">Open</button>
            <button class="btn btn-ghost btn-sm" @click="peekAct('reveal')">{{ IS_MAC ? 'Show in Finder' : 'Show in folder' }}</button>
            <button class="btn btn-ghost btn-sm" @click="peekAct('copy')">Copy path</button>
          </div>
        </template>
        <template v-else-if="peek.data.choices?.length">
          <div class="px-3 pb-1 pt-2 text-[11.5px] text-faint">{{ peek.data.choices.length }} places have {{ peek.text }}. Which one?</div>
          <button v-for="c in peek.data.choices.slice(0, 8)" :key="c.path" class="block w-full px-3 py-1 text-left hover:bg-canvas-2" :title="c.path" @click="peekAct('open', c.path)">
            <span class="block truncate">{{ c.label }}</span>
            <span class="block text-[11px] text-faint">{{ changed(c.mtime) }}</span>
          </button>
          <div class="h-1"></div>
        </template>
        <div v-else class="px-3 py-2">
          <div class="font-medium">{{ peek.data.missing ? 'Not found' : "Can't preview this" }}</div>
          <div class="break-words text-[11.5px] text-faint">{{ peek.data.error }}</div>
        </div>
      </div>
      <div v-if="copied" class="pointer-events-none absolute right-3 top-3 rounded-md bg-surface/90 px-2 py-0.5 text-[11.5px] text-ink-soft shadow-sm">Copied</div>
      <div v-if="dragging && draggingSession" class="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed text-[13px] text-ink-soft"
        :class="sessionRefusal ? 'border-line-strong bg-surface/10' : 'border-[var(--color-brand-500)] bg-[var(--color-brand-500)]/10'">
        {{ sessionRefusal || `Drop to mention "${draggedTitle}" here` }}
      </div>
      <div v-else-if="dragging || dropBusy" class="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-brand-500)] bg-[var(--color-brand-500)]/10 text-[13px] text-ink-soft">
        {{ dropBusy ? 'Finding the file…' : 'Drop to insert the file path' }}
      </div>
    </div>
  </div>
</template>
