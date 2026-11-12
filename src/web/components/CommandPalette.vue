<script setup lang="ts">
// Ctrl+P: one box for everything. Sessions (running first), actions, and any folder under the work root
// to start a new session in. ↑↓ and Enter.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { BrushCleaning, ChartColumn, CircleArrowUp, MessageSquareHeart, FolderPlus, TextSearch, Megaphone, Sparkles, Pencil, MessageSquareText, Moon, Network, Plus, Settings, SquareTerminal, Sun, TerminalSquare } from 'lucide-vue-next'
import { type Session, ago, api, current, deck, extraRow, recentKeys, openNew, openRename, projectOf, select, setView, shortCwd, startSession, startShell, theme, toggleTheme, workRoot } from '../deck'
import { tasksOn } from '../tasks'
import { openNews, unreadNews } from '../news'
import { openSetup } from '../setup'
import { alt } from '../keys'
import { STRONG, bestHit, rankSessions } from '../paletteRank'

type Item = { id: string; kind: 'session' | 'action' | 'folder' | 'hit'; label: string; hint?: string; icon: any; run: () => void; live?: boolean; at?: number; parts?: { t: string; on: boolean }[]; more?: number }
// "In sessions" [T1112-18]: text from any conversation or running terminal, from /api/search
type Hit = { at: number; role: 'you' | 'claude' | 'codex' | 'peer' | 'screen'; snippet: string; hl: [number, number][] }
type Found = { key: string; sessionId: string | null; tool: string; title: string; cwd: string; project: string; state: 'running' | 'stopped' | 'hidden'; old?: boolean; at: number; hits: Hit[]; row?: any }

const q = ref('')
const at = ref(0)
const input = ref<HTMLInputElement>()
const found = ref<{ cwd: string }[]>([])
const inSessions = ref<Found[]>([])
const searching = ref(false)
// stopped, past and hidden rows the sidebar may not list, so a name match finds them too [T1112-108]
const past = ref<(Session & { hidden?: boolean; closed?: boolean })[]>([])
api<{ sessions: typeof past.value }>('/api/past').then((r) => (past.value = r.sessions)).catch(() => {})
const ROLE = { you: 'You', claude: 'Claude', codex: 'Codex', peer: 'From a session', screen: 'On screen' } as const
const partsOf = (h: Hit) => {
  const out: { t: string; on: boolean }[] = []
  let i = 0
  for (const [a, b] of h.hl) {
    if (a > i) out.push({ t: h.snippet.slice(i, a), on: false })
    out.push({ t: h.snippet.slice(a, b), on: true })
    i = b
  }
  if (i < h.snippet.length) out.push({ t: h.snippet.slice(i), on: false })
  return out
}
/** a running or listed session opens like a sidebar click; a hidden or older one shows its card (Resume brings it back) */
function openFound(r: Found) {
  const listed = deck.sessions.find((s) => s.key === r.key) ?? (r.sessionId ? deck.sessions.find((s) => s.sessionId === r.sessionId && s.tmux) ?? deck.sessions.find((s) => s.sessionId === r.sessionId) : undefined)
  if (listed) return select(listed.key)
  if (r.row?.key) {
    extraRow.value = r.row
    select(r.row.key)
  }
}
const close = () => (deck.paletteOpen = false)

const actions: Item[] = [
  { id: 'a:new', kind: 'action', label: 'New session…', hint: alt('N'), icon: Plus, run: () => openNew() },
  { id: 'a:msgs', kind: 'action', label: 'My messages', hint: alt('M'), icon: MessageSquareText, run: () => setView('messages') },
  { id: 'a:stats', kind: 'action', label: 'Stats', icon: ChartColumn, run: () => setView('stats') },
  { id: 'a:tasks', kind: 'action', label: 'Tasks', icon: Network, run: () => setView('tasks') },
  { id: 'a:tidy', kind: 'action', label: 'Close old sessions', hint: 'done, waiting on you, unsure', icon: BrushCleaning, run: () => setView('tidy') },
  { id: 'a:settings', kind: 'action', label: 'Accounts & settings', icon: Settings, run: () => setView('settings') },
  { id: 'a:theme', kind: 'action', label: theme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', icon: theme() === 'dark' ? Sun : Moon, run: toggleTheme },
  { id: 'a:shell', kind: 'action', label: 'Terminal in this folder', hint: alt('T'), icon: TerminalSquare, run: () => startShell(here()) },
  { id: 'a:newterm', kind: 'action', label: 'New terminal…', hint: 'pick a folder and a name', icon: TerminalSquare, run: () => openNew('', 'shell') },
  { id: 'a:setup', kind: 'action', label: 'Setup', hint: 'projects folder, agents, logins', icon: Sparkles, run: () => openSetup() },
  { id: 'a:feedback', kind: 'action', label: 'Send feedback', hint: 'feature request, bug report', icon: MessageSquareHeart, run: () => (deck.feedbackOpen = true) },
  ...(deck.self ? [{ id: 'a:self', kind: 'action' as const, label: `Update Overvibe to ${deck.self.latest}`, hint: `you have ${deck.self.installed}`, icon: CircleArrowUp, run: () => (deck.selfOpen = true) }] : []),
  { id: 'a:news', kind: 'action', label: "What's new", hint: unreadNews.value.length ? `${unreadNews.value.length} new` : undefined, icon: Megaphone, run: openNews },
]
// rename the session that is open (deck sessions only), listed first so ⌥K then Enter works
if (current.value?.where === 'deck' && current.value.tmux) actions.unshift({ id: 'a:rename', kind: 'action', label: `Rename "${current.value.title}"…`, hint: alt('R'), icon: Pencil, run: openRename })
const here = () => current.value?.cwd ?? workRoot.value

const groupOf = (s: { project?: string; cwd: string }) => projectOf(s)

const items = computed<Item[]>(() => {
  // "$ cmd": run a shell command in the current folder, in a new terminal tab
  const raw = q.value.trim()
  if (raw.startsWith('$')) {
    const cmd = raw.slice(1).trim()
    return [{ id: 'run', kind: 'action', label: cmd ? `Run: ${cmd}` : 'Type a command after $', hint: shortCwd(here()), icon: TerminalSquare, run: () => cmd && startShell(here(), cmd) }]
  }
  const n = q.value.trim().toLowerCase()
  const match = (t: string) => !n || t.toLowerCase().includes(n)
  // Sessions [T1112-108]: name, folder or project, word-aware, ranked on the client (exact name, every word,
  // prefix, folder or project, fuzzy); listed rows first, then stopped, past and hidden ones the sidebar leaves out
  const listed = deck.sessions.filter((s) => s.kind === 'claude' || (s.kind === 'shell' && s.tmux))
  const seen = new Set(listed.flatMap((s) => [s.key, s.sessionId].filter(Boolean)))
  const extra = past.value.filter((s) => !seen.has(s.key) && !(s.sessionId && seen.has(s.sessionId)))
  const pool = [...listed.map((s) => ({ s, hidden: false, extra: false })), ...extra.map((s) => ({ s, hidden: !!(s.hidden || s.closed), extra: true }))]
    .map((x) => ({ ...x, title: x.s.title, cwd: x.s.cwd, project: groupOf(x.s), live: x.s.where !== 'past' && x.s.status !== 'ended' && !(x.s.where === 'deck' && !x.s.tmux), at: x.s.last }))
  const ranked = n ? rankSessions(n, pool).slice(0, 12) : []
  const strong = ranked.length > 0 && ranked[0]!.tier <= STRONG
  const sessions = ranked.map<Item>(({ item: x }) => ({
    id: 's:' + x.s.key, kind: 'session', label: x.s.title, hint: [x.project || shortCwd(x.s.cwd), x.hidden ? 'hidden' : ''].filter(Boolean).join(' · '), icon: SquareTerminal,
    live: x.live, at: x.s.last, run: () => (x.extra ? ((extraRow.value = x.s), select(x.s.key)) : select(x.s.key)),
  }))
  const shown = new Set(ranked.flatMap(({ item: x }) => [x.s.key, x.s.sessionId].filter(Boolean)))
  // no Tasks entry while Settings > Tasks view is off [T1112-16]
  const acts = actions.filter((a) => match(a.label) && (a.id !== 'a:tasks' || tasksOn.value))
  const folders = n
    ? found.value.map<Item>((f) => ({
        id: 'f:' + f.cwd, kind: 'folder', label: `New session in ${shortCwd(f.cwd)}`, icon: FolderPlus,
        run: () => startSession({ cwd: f.cwd, account: 'auto' }),
      }))
    : []
  const hits = n
    ? inSessions.value
        // one row per session, its best snippet; a session already in the Sessions group is not repeated
        .filter((r) => !shown.has(r.key) && !(r.sessionId && shown.has(r.sessionId)) && r.hits.length)
        .map<Item>((r) => {
          const h = bestHit(r.hits)!
          return {
            id: `h:${r.key}`, kind: 'hit', label: r.title, icon: TextSearch, at: h.at, parts: partsOf(h), more: r.hits.length - 1,
            hint: [ROLE[h.role], r.state === 'running' ? '' : r.state === 'hidden' ? 'hidden' : 'stopped'].filter(Boolean).join(' · '),
            live: r.state === 'running', run: () => openFound(r),
          }
        })
    : []
  // a strong name match goes above the commands; a weak one (folder, project, fuzzy) below them
  if (n) return strong ? [...sessions, ...acts, ...hits, ...folders] : [...acts, ...sessions, ...hits, ...folders]
  // nothing typed: the last 5 sessions you opened (not the one on screen), then the actions
  const recent = recentKeys()
    .filter((k) => k !== deck.selected)
    .map((k) => deck.sessions.find((s) => s.key === k || s.sessionId === k))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .slice(0, 5)
    .map<Item>((s) => ({ id: 'r:' + s.key, kind: 'session', label: s.title, hint: groupOf(s) || shortCwd(s.cwd), icon: SquareTerminal, live: s.where !== 'past' && s.status !== 'ended', at: s.last, run: () => select(s.key) }))
  return [...recent, ...acts]
})

let t: ReturnType<typeof setTimeout>
let ts: ReturnType<typeof setTimeout>
watch(q, (v) => {
  const c = v.replace(/[\u02dc\u0303\u03c0]/g, '') // "˜" or "π" left behind by an Option shortcut
  if (c !== v) return (q.value = c)
  at.value = 0
  clearTimeout(t)
  clearTimeout(ts)
  if (!v.trim() || v.trim().startsWith('$')) return ((found.value = []), (inSessions.value = []), (searching.value = false))
  if (v.trim().length < 3) (inSessions.value = []), (searching.value = false)
  else {
    searching.value = true
    ts = setTimeout(async () => {
      try {
        const r = await api<{ results: Found[] }>(`/api/search?q=${encodeURIComponent(v.trim())}&limit=12`)
        if (q.value === v) inSessions.value = r.results
      } catch {}
      if (q.value === v) searching.value = false
    }, 150)
  }
  t = setTimeout(async () => {
    try {
      const r = await api<{ root: string; folders: { rel: string; cwd?: string }[] }>(`/api/folders?q=${encodeURIComponent(v)}`)
      if (q.value === v) found.value = r.folders.slice(0, 6).map((f) => ({ cwd: f.cwd ?? `${r.root}/${f.rel}` }))
    } catch {}
  }, 120)
})

function onKey(e: KeyboardEvent) {
  // the list wraps: ↑ on the first row goes to the last, ↓ on the last back to the first
  const n = items.value.length
  if (e.key === 'ArrowDown') (e.preventDefault(), n && (at.value = (at.value + 1) % n))
  else if (e.key === 'ArrowUp') (e.preventDefault(), n && (at.value = (at.value - 1 + n) % n))
  else if (e.key === 'Enter') (e.preventDefault(), run(items.value[at.value]))
  else if (e.key === 'Escape') close()
  nextTick(() => document.querySelector('[data-at="1"]')?.scrollIntoView({ block: 'nearest' }))
}
function run(i?: Item) {
  if (!i) return
  close()
  i.run()
}
onMounted(() => input.value?.focus())
</script>

<template>
  <div class="fixed inset-0 z-[70] flex items-start justify-center backdrop p-4 pt-[12vh]" @mousedown.self="close">
    <div class="dialog w-[36rem] max-w-full overflow-hidden">
      <input ref="input" :value="q" @input="q = ($event.target as HTMLInputElement).value" @compositionend="q = ($event.target as HTMLInputElement).value" class="w-full border-b border-line bg-transparent px-4 py-3.5 text-[15px] outline-none placeholder:text-faint" placeholder="Search sessions and their text, folders, actions… or $ command" @keydown="onKey" />
      <div class="max-h-[55vh] overflow-y-auto py-1">
        <template v-for="(i, k) in items" :key="i.id">
        <div v-if="i.kind === 'hit' && items[k - 1]?.kind !== 'hit'" class="px-4 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-faint">In sessions</div>
        <div v-else-if="q.trim() && i.kind === 'session' && items[k - 1]?.kind !== 'session'" class="px-4 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-faint">Sessions</div>
        <button
          v-if="i.kind === 'hit'" :data-at="k === at ? '1' : undefined"
          class="flex w-full items-start gap-3 px-4 py-2 text-left"
          :class="k === at ? 'bg-[var(--color-row-sel)] shadow-[inset_2px_0_0_var(--color-brand-500)]' : 'hover:bg-[var(--color-row-hover)]'"
          @mousemove="at = k" @click="run(i)"
        >
          <component :is="i.icon" :size="15" class="mt-0.5 flex-none" :class="k === at ? 'text-[var(--color-brand-600)]' : 'text-faint'" />
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="dot flex-none" :class="i.live ? 'dot-idle' : 'dot-ended'"></span>
              <span class="min-w-0 flex-1 truncate text-[13.5px]">{{ i.label }}</span>
              <span class="flex-none text-[12px] text-faint">{{ i.hint }}</span>
              <span v-if="i.more" class="flex-none text-[11.5px] text-faint">+{{ i.more }} more</span>
              <span class="w-7 flex-none text-right text-[11px] tabular-nums text-faint">{{ ago(i.at!) }}</span>
            </span>
            <span class="mt-0.5 line-clamp-2 block text-[12.5px] text-ink-soft"><template v-for="(p, pi) in i.parts" :key="pi"><mark v-if="p.on" class="rounded-sm bg-[var(--color-chip-amber-bg,#fde68a)] px-px text-ink">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></span>
          </span>
        </button>
        <button
          v-else :data-at="k === at ? '1' : undefined"
          class="flex w-full items-center gap-3 px-4 py-2 text-left"
          :class="k === at ? 'bg-[var(--color-row-sel)] shadow-[inset_2px_0_0_var(--color-brand-500)]' : 'hover:bg-[var(--color-row-hover)]'"
          @mousemove="at = k" @click="run(i)"
        >
          <component :is="i.icon" :size="15" :class="k === at ? 'text-[var(--color-brand-600)]' : 'text-faint'" />
          <span v-if="i.kind === 'session'" class="dot" :class="i.live ? 'dot-idle' : 'dot-ended'"></span>
          <span class="min-w-0 flex-1 truncate text-[13.5px]">{{ i.label }}</span>
          <span v-if="i.hint" class="truncate text-[12px] text-faint">{{ i.hint }}</span>
          <span v-if="i.at" class="w-7 text-right text-[11px] tabular-nums text-faint">{{ ago(i.at) }}</span>
        </button>
        </template>
        <div v-if="searching && !items.some((i) => i.kind === 'hit')" class="px-4 py-2.5 text-[12.5px] text-faint">Searching inside sessions…</div>
        <div v-else-if="!items.length" class="px-4 py-3 text-[13px] text-faint">Nothing matches.</div>
      </div>
    </div>
  </div>
</template>
