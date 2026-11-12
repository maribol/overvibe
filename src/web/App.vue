<script setup lang="ts">
// The shell: a 288px hairline sidebar (sessions by project, accounts) inside a
// rounded card on the shell colour, and the main column with terminal tabs.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import Wordmark from './components/Wordmark.vue'
import { BrushCleaning, ChartColumn, CircleArrowUp, ListTodo, Megaphone, MessageSquareText, Plus, Sparkles } from 'lucide-vue-next'
import SessionList from './components/SessionList.vue'
import AccountsPanel from './components/AccountsPanel.vue'
import TerminalTabs from './components/TerminalTabs.vue'
import SessionCard from './components/SessionCard.vue'
import NewSessionModal from './components/NewSessionModal.vue'
import AddAccountModal from './components/AddAccountModal.vue'
import MessagesView from './components/MessagesView.vue'
import TidyView from './components/TidyView.vue'
import StatsView from './components/StatsView.vue'
import SettingsView from './components/SettingsView.vue'
import TasksView from './components/TasksView.vue'
import MoveFolderModal from './components/MoveFolderModal.vue'
import RenameModal from './components/RenameModal.vue'
import SessionMenu from './components/SessionMenu.vue'
import PromptModal from './components/PromptModal.vue'
import QuestionModal from './components/QuestionModal.vue'
import CommandPalette from './components/CommandPalette.vue'
import StopModal from './components/StopModal.vue'
import ProjectMenu from './components/ProjectMenu.vue'
import CloseAllModal from './components/CloseAllModal.vue'
import WhatsNew from './components/WhatsNew.vue'
import SafetyNote from './components/SafetyNote.vue'
import SetupView from './components/SetupView.vue'
import SelfUpdateModal from './components/SelfUpdateModal.vue'
import FeedbackModal from './components/FeedbackModal.vue'
import { checkFirstRun, resumeSetup } from './setup'
import { loadTasksSoon, since as tasksSince, taskCounts, taskFiles, tasksOn } from './tasks'
import { countsDetail, countsTip } from '../taskview'
import { vTip, type TipBody } from './tip'
import { openNews, unreadNews } from './news'
import { alt } from './keys'
import { api, applyUrl, openSettings, replaceUrl, versionOf, askStop, closeRow, closeTab, current, deck, openNew, openRename, refresh, select, setView, startShell, workRoot } from './deck'

// Shortcuts use Option: Chrome keeps ⌘N/⌘T/⌘W for itself and never hands them to a page.
// e.code, not e.key: Option turns N into "˜" on a Mac keyboard. Capture phase, so the terminal
// (which would read ⌥ as Meta) never sees them. The desktop app (desktop/) sends the same actions
// for ⌘N, ⌘W, ⌘T, Ctrl+Tab / Ctrl+⇧Tab (next and previous running session), ⌘1-9, ⌘K/⌘P and ⌘[ ⌘], caught before the page sees the key.

/** Like Terminal's tabs: the next (or previous) running session in the sidebar's visible order,
 *  wrapping; closed and past rows are skipped. From a closed row it goes to the nearest running one.
 *  A pinned session shows twice (Pinned and its project): it steps on from the copy you clicked or
 *  last stepped to, so the next row is the one under it on screen [T1111-29]. */
let at: HTMLElement | null = null
const rowEl = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>('[data-key]') : null)
const remember = (e: Event) => {
  const el = rowEl(e.target)
  if (el?.closest('aside')) at = el
}
/** sessions that look done and safe to close, counted by the brush button [T1112-6] */
const tidyCount = computed(() => deck.sessions.filter((x) => x.tidy).length)
function step(back: boolean) {
  const els = [...document.querySelectorAll<HTMLElement>('aside [data-key]')].filter((el) => el.getClientRects().length)
  const live = (k: string) => {
    const s = deck.sessions.find((x) => x.key === k)
    return !!s && s.where !== 'past' && s.status !== 'ended'
  }
  const n = els.length
  if (!n) return
  const here = at && at.isConnected && at.dataset.key === deck.selected ? els.indexOf(at) : -1
  const i = here >= 0 ? here : els.findIndex((el) => el.dataset.key === deck.selected)
  for (let d = 1; d <= n; d++) {
    const el = els[(((i < 0 ? (back ? 0 : -1) : i) + (back ? -d : d)) % n + n) % n]!
    const k = el.dataset.key!
    if (live(k) && k !== deck.selected) {
      at = el
      return select(k)
    }
  }
}

const actions = {
  palette: () => (deck.paletteOpen = !deck.paletteOpen),
  new: () => {
    if (!deck.newOpen) openNew()
  },
  // stop the open deck session, after asking (the conversation is kept)
  stop: () => {
    const c = current.value
    // ⌘W closes: stop (after asking), unpin and hide the row [T1111-27]
    if (c?.status === 'ended' && c.tmux && deck.tabs.includes(c.tmux)) {
      closeTab(c.tmux) // nothing left to stop
      if (c.where === 'deck') void closeRow(c).catch((err) => alert(err.message))
    } else if (!deck.stopFor) askStop(c, { close: true })
  },
  shell: () => startShell(current.value?.cwd ?? workRoot.value).catch((err) => alert(err.message)),
  rename: () => {
    if (current.value?.where === 'deck') openRename()
  },
  next: () => step(false),
  prev: () => step(true),
  messages: () => setView(deck.view === 'messages' ? 'terminal' : 'messages'),
  /** the Nth open tab; false when there is none */
  tab: (n: number) => {
    const t = deck.tabs[n - 1]
    if (t) select(t)
    return !!t
  },
}

/** A command from the desktop app: 'new', 'stop', 'tab:3', ... */
function runCommand(cmd: string) {
  const m = /^tab:([1-9])$/.exec(cmd)
  if (m) actions.tab(Number(m[1]))
  else if (cmd === 'new' || cmd === 'stop' || cmd === 'shell' || cmd === 'palette' || cmd === 'next' || cmd === 'prev') actions[cmd]()
}

function onKey(e: KeyboardEvent) {
  // Ctrl+P or ⌘K: quick access (taken from the terminal on purpose; there Ctrl+P recalls the previous prompt)
  // also ⌘P (instead of printing) and ⌥P; e.code because Option turns P into "π"
  const only = (k: 'ctrlKey' | 'metaKey' | 'altKey') => e[k] && !['ctrlKey', 'metaKey', 'altKey'].some((o) => o !== k && (e as any)[o])
  const hit = () => (e.preventDefault(), e.stopPropagation())
  if ((e.code === 'KeyP' && (only('ctrlKey') || only('metaKey') || only('altKey'))) || (e.code === 'KeyK' && (only('metaKey') || only('altKey')))) {
    hit()
    actions.palette()
    return
  }
  if (!e.altKey || e.metaKey || e.ctrlKey) return
  if (e.code === 'KeyN') (hit(), actions.new())
  else if (e.code === 'KeyW') (hit(), actions.stop())
  else if (/^Digit[1-9]$/.test(e.code)) {
    if (deck.tabs[Number(e.code.slice(5)) - 1]) (hit(), actions.tab(Number(e.code.slice(5))))
  } else if (e.code === 'KeyT') (hit(), actions.shell())
  else if (e.code === 'KeyR' && current.value?.where === 'deck') (hit(), actions.rename())
  // ⌥Tab / ⌥] next session in the sidebar's visible order, ⌥⇧Tab / ⌥[ the one above (wraps)
  else if (e.code === 'Tab' || e.code === 'BracketRight' || e.code === 'BracketLeft') {
    hit()
    if (e.code === 'BracketLeft' || (e.code === 'Tab' && e.shiftKey)) actions.prev()
    else actions.next()
  }
  else if (e.code === 'KeyM') (hit(), actions.messages())
}

// sidebar width: drag its right edge (200-560 px), remembered per browser; double-click resets
const sideW = ref(Number(localStorage.getItem('deck.sideW')) || 288)
function startResize(e: PointerEvent) {
  e.preventDefault()
  const x0 = e.clientX
  const w0 = sideW.value
  const move = (ev: PointerEvent) => (sideW.value = Math.max(200, Math.min(560, w0 + ev.clientX - x0)))
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    document.body.style.cursor = ''
    localStorage.setItem('deck.sideW', String(sideW.value))
  }
  document.body.style.cursor = 'col-resize'
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
function resetWidth() {
  sideW.value = 288
  localStorage.setItem('deck.sideW', '288')
}

const newKey = window.deckDesktop ? '⌘N' : alt('N')

const UPDATE_LABEL = { claude: 'Claude Code', codex: 'Codex', agy: 'agy' } as const
const updates = computed(() => deck.tools.filter((t) => t.update))

// the footer tabs; Tasks only while Settings > Tasks view is on [T1112-16], with its open count [T1112-14]
const navTabs = computed((): { id: 'tasks' | 'messages' | 'stats'; label: string; tip: string; icon: unknown }[] => [
  ...(tasksOn.value ? [{ id: 'tasks' as const, label: 'Tasks', tip: 'Tasks from every TASKS.md', icon: ListTodo }] : []),
  { id: 'messages', label: 'Messages', tip: 'Messages you sent to sessions', icon: MessageSquareText },
  { id: 'stats', label: 'Stats', tip: 'Stats: sessions, working time, waiting, usage', icon: ChartColumn },
])
// "2,176 open in 41 projects, 621 waiting on you", and the fresh start when one is on [T1112-117]
const tasksTip = computed(() => countsTip(taskCounts.value, tasksSince.value))

// the hover cards on the Tasks counters and the Stats tab [T1112-126]
const localDay = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const TOP = 6
const tasksDetail = computed(() => countsDetail(taskFiles.value, tasksSince.value, localDay()))
const openTip = computed((): TipBody => {
  const c = taskCounts.value
  const d = tasksDetail.value
  const rest = d.projects.length - TOP
  return {
    title: `${c.open.toLocaleString('en-US')} open in ${c.projects} project${c.projects === 1 ? '' : 's'}`,
    rows: [
      ...d.projects.slice(0, TOP).map((p): [string, number] => [p.name, p.open]),
      ...(rest > 0 ? [`+${rest} more project${rest === 1 ? '' : 's'}`] : []),
      ['Added today', d.addedToday],
      ['Done today', d.doneToday],
    ],
    foot: 'Click to open the Tasks view',
  }
})
const waitingTip = computed((): TipBody => {
  const d = tasksDetail.value
  const rest = d.byWaiting.length - TOP
  return {
    title: `${taskCounts.value.waiting.toLocaleString('en-US')} waiting on you`,
    rows: [...d.byWaiting.slice(0, TOP).map((p): [string, number] => [p.name, p.waiting]), ...(rest > 0 ? [`+${rest} more`] : [])],
    foot: 'Lines under "Waiting on the owner" in each TASKS.md',
  }
})
const sinceTip = computed((): TipBody => ({
  title: `Start fresh is on, from ${tasksSince.value}`,
  rows: [
    'Only lines dated that day or later count.',
    ['Older open lines hidden', tasksDetail.value.hidden],
  ],
  foot: 'Turn it off in the Tasks view. TASKS.md files are not changed.',
}))
type StatsRange = { tools: Record<'claude' | 'codex' | 'agy', { active: number; started: number; workMs: number | null }>; messages: { count: number } }
let statsAt = 0
let statsTipCache: TipBody | null = null
const hm = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}
async function statsTip(): Promise<TipBody> {
  if (statsTipCache && Date.now() - statsAt < 30_000) return statsTipCache
  try {
    const s = await api<{ ranges: { '24h': StatsRange }; waiting: unknown[] }>('/api/stats')
    const r = s.ranges['24h']
    const names = { claude: 'Claude Code', codex: 'Codex', agy: 'agy' } as const
    const rows: [string, string | number][] = []
    for (const t of ['claude', 'codex', 'agy'] as const) {
      const x = r.tools[t]
      if (!x.active && !x.started) continue
      rows.push([`${names[t]} sessions`, x.active], ...(x.workMs ? [[`${names[t]} working`, hm(x.workMs)] as [string, string]] : []))
    }
    rows.push(['Messages between sessions', r.messages.count], ['Sessions waiting on you', s.waiting.length])
    statsTipCache = { title: 'Last 24 hours', rows, foot: 'Click for charts and the 7-day view' }
    statsAt = Date.now()
  } catch {
    statsTipCache = { title: 'Stats: sessions, working time, waiting, usage' }
  }
  return statsTipCache
}
// the footer is 200 px at its narrowest: 2,176 reads "2.2k" there, the tooltip has the exact number
const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
watch(tasksOn, (on) => {
  if (!on && deck.view === 'tasks') setView('terminal')
  if (on) loadTasksSoon()
})

let timer: ReturnType<typeof setInterval>
onMounted(() => {
  // a link to a session or view wins over the one remembered from last time
  if (location.hash.length > 2) applyUrl()
  else replaceUrl()
  refresh()
  timer = setInterval(() => (refresh(), loadTasksSoon()), 3000)
  loadTasksSoon()
  checkFirstRun() // the first-run setup, once per install [T1110-67]
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('mousedown', remember, true)
  window.deckDesktop?.on(runCommand)
})
onUnmounted(() => {
  clearInterval(timer)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('mousedown', remember, true)
})
</script>

<template>
  <div class="flex h-svh flex-col bg-surface text-ink">
    <div class="relative flex min-h-0 w-full flex-1 overflow-hidden bg-surface">
      <aside class="relative flex shrink-0 flex-col border-r border-line bg-surface" :style="{ width: sideW + 'px' }">
        <div class="absolute -right-1 top-0 z-20 h-full w-2 cursor-col-resize hover:bg-[var(--color-brand-500)]/25" title="Drag to resize · double-click to reset" @pointerdown="startResize" @dblclick="resetWidth"></div>
        <div class="flex items-center justify-between px-4 pb-3 pt-4">
          <div class="flex items-center gap-2">
            <Wordmark class="h-[22px] w-auto text-ink" />
          </div>
          <div class="flex items-center gap-1">
            <!-- Close old sessions [T1111-30] -->
            <button class="relative flex items-center gap-1 rounded-md p-1.5 hover:bg-[var(--color-row-hover)] hover:text-ink" :class="deck.view === 'tidy' ? 'text-ink' : 'text-faint'" :title="tidyCount ? `Close old sessions: ${tidyCount} look done and safe to close` : 'Close old sessions'" aria-label="Close old sessions" @click="setView(deck.view === 'tidy' ? 'terminal' : 'tidy')">
              <BrushCleaning :size="16" :stroke-width="1.8" />
              <span v-if="tidyCount" class="text-[11px] tabular-nums">{{ tidyCount }}</span>
            </button>
            <!-- What's new: a quiet icon, with a small dot while something is unread [T1110-53] -->
            <button class="relative rounded-md p-1.5 text-faint hover:bg-[var(--color-row-hover)] hover:text-ink" :title="unreadNews.length ? `What's new (${unreadNews.length} unread)` : `What's new`" :aria-label="`What's new`" @click="openNews">
              <Megaphone :size="16" :stroke-width="1.8" />
              <span v-if="unreadNews.length" class="absolute right-1 top-1 size-[7px] rounded-full bg-[var(--color-brand-500)] ring-2 ring-[var(--color-surface)]"></span>
            </button>
            <button class="btn btn-brand btn-sm" title="New session" @click="openNew()"><Plus :size="15" /> New <kbd class="ml-0.5 text-[10.5px] font-medium opacity-70">{{ newKey }}</kbd></button>
          </div>
        </div>
        <SessionList class="min-h-0 flex-1" />
        <!-- a newer Overvibe: a quiet line that opens the update panel [T1112-119] -->
        <button v-if="deck.self" class="flex items-center gap-1.5 border-t border-line px-4 py-1.5 text-left text-[11.5px] text-muted hover:bg-[var(--color-row-hover)] hover:text-ink" data-self-badge :title="`Overvibe ${deck.self.installed} · ${deck.self.latest} is out`" @click="deck.selfOpen = true">
          <CircleArrowUp :size="13" :stroke-width="1.8" class="flex-none" style="color: var(--color-chip-amber-fg)" />
          <span class="min-w-0 truncate">Overvibe {{ deck.self.latest }} available</span>
        </button>
        <!-- a CLI has an update: a quiet line that opens Settings > Accounts, where Update runs it [T1112-103] -->
        <button v-if="updates.length" class="flex items-center gap-1.5 border-t border-line px-4 py-1.5 text-left text-[11.5px] text-muted hover:bg-[var(--color-row-hover)] hover:text-ink" data-update-badge :title="updates.map((t) => `${UPDATE_LABEL[t.tool]} ${versionOf(t)} · update available: ${t.update!.latest}`).join('\n')" @click="openSettings('accounts')">
          <CircleArrowUp :size="13" :stroke-width="1.8" class="flex-none" style="color: var(--color-chip-amber-fg)" />
          <span class="min-w-0 truncate">{{ updates.map((t) => `${UPDATE_LABEL[t.tool]} ${t.update!.latest}`).join(', ') }} available</span>
        </button>
        <!-- three short tabs, icon over label, so nothing truncates down to the 200 px minimum width [T1110-84] -->
        <nav class="grid gap-1 border-t border-line px-2 py-1.5" :class="navTabs.length === 3 ? 'grid-cols-3' : 'grid-cols-2'">
          <button
            v-for="v in navTabs"
            :key="v.id"
            class="flex min-w-0 flex-col items-center gap-0.5 rounded-md px-1 pb-1 pt-1.5 text-[11.5px] leading-none"
            :class="deck.view === v.id ? 'bg-[var(--color-row-sel)] font-medium text-ink' : 'text-muted hover:bg-[var(--color-row-hover)] hover:text-ink'"
            v-tip="v.id === 'tasks' ? tasksTip : v.id === 'stats' ? statsTip : v.tip"
            :aria-current="deck.view === v.id ? 'page' : undefined"
            @click="setView(deck.view === v.id ? 'terminal' : v.id)"
          >
            <component :is="v.icon" :size="16" :stroke-width="1.7" :class="deck.view === v.id ? 'text-[var(--color-brand-600)]' : 'text-faint'" />
            <span class="whitespace-nowrap"
              >{{ v.label
              }}<template v-if="v.id === 'tasks' && taskCounts.open"
                ><span v-tip="openTip" class="ml-1 text-faint">{{ short(taskCounts.open) }}</span
                ><span v-if="taskCounts.waiting" v-tip="waitingTip" class="ml-1 rounded px-1 font-semibold" style="background: var(--color-chip-amber-bg); color: var(--color-chip-amber-fg)">{{ short(taskCounts.waiting) }}</span
                ><span v-if="tasksSince" v-tip="sinceTip" class="text-faint">*</span></template
              ></span
            >
          </button>
        </nav>
        <AccountsPanel />
      </aside>

      <main class="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <MessagesView v-if="deck.view === 'messages'" />
        <TidyView v-else-if="deck.view === 'tidy'" />
        <StatsView v-else-if="deck.view === 'stats'" />
        <SettingsView v-else-if="deck.view === 'settings'" />
        <TasksView v-else-if="deck.view === 'tasks' && tasksOn" />
        <!-- terminals stay mounted while another view is shown, so their connections survive -->
        <TerminalTabs v-if="deck.tabs.length" v-show="deck.view === 'terminal'" :class="current?.tmux ? 'min-h-0 flex-1' : ''" />
        <SessionCard v-if="deck.view === 'terminal' && current && !current.tmux" :key="current.key" :s="current" class="min-h-0 flex-1 overflow-y-auto" />
        <div v-if="deck.view === 'terminal' && !current" class="grid flex-1 place-items-center p-8">
          <div class="max-w-md text-center">
            <h2 class="text-xl font-bold tracking-[-0.03em]">No session open</h2>
            <p class="mt-2 text-sm text-muted">Pick a session on the left, or start one. Sessions keep running when you close this page.</p>
            <button class="btn btn-brand mt-5" @click="openNew()"><Plus :size="16" /> New session</button>
          </div>
        </div>
      </main>
    </div>
    <NewSessionModal v-if="deck.newOpen" />
    <AddAccountModal v-if="deck.addAccountOpen" />
    <MoveFolderModal v-if="deck.moveFor" :s="deck.moveFor" />
    <RenameModal v-if="deck.renameFor" />
    <SessionMenu v-if="deck.menu" />
    <PromptModal />
    <QuestionModal />
    <CommandPalette v-if="deck.paletteOpen" />
    <StopModal v-if="deck.stopFor" :key="deck.stopFor.key" />
    <ProjectMenu v-if="deck.projectMenu" />
    <CloseAllModal v-if="deck.closeAllFor" :key="deck.closeAllFor" />
    <WhatsNew />
    <SafetyNote />
    <SetupView v-if="deck.setupOpen" />
    <SelfUpdateModal v-if="deck.selfOpen && deck.self" />
    <FeedbackModal v-if="deck.feedbackOpen" />
    <!-- the setup, set aside for a login terminal or a new account -->
    <button v-if="deck.setupAway && !deck.addAccountOpen" class="btn btn-brand btn-sm fixed bottom-5 right-5 z-[60] shadow-lg" @click="resumeSetup"><Sparkles :size="14" /> Continue setup</button>
    <div v-if="deck.toast" class="dialog pointer-events-none fixed bottom-5 left-1/2 z-[80] max-w-md -translate-x-1/2 px-4 py-2 text-[13px] shadow-lg">{{ deck.toast }}</div>
  </div>
</template>
