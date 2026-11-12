<script setup lang="ts">
// Sessions grouped by project (the server's name: deck.json, Settings, git repo, folder), then by folder. Groups follow
// the owner's saved project order (Settings, or drag a group header here). Past sessions (last 7 days, not running) hide behind a toggle.
// Pinned sessions (right-click > Pin to top) sit in their own box at the top, in pin order, and only there.
// Attached children (deck new --attach) sit indented right under their parent's row, in first-seen order; a child
// whose parent is not in the list (closed, hidden, pinned, filtered out) is a normal row.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { BrushCleaning, Hand, X, ChevronDown, ChevronRight, CircleAlert, MessageCircleQuestion, Moon, Rocket, Pin, PinOff, Plus, Search, SquareTerminal, Star } from 'lucide-vue-next'
import { SESSION_MIME } from '../../sessionref'
import { fileForCwd } from '../../taskview'
import { taskFiles, tasksOn } from '../tasks'
import TaskTip from './TaskTip.vue'
import { ago, askStop, deck, draggedSession, isCoordinator, isPinned, openNew, orderProjects, OTHER, pinId, projectOf, rememberProjects, saveProjectOrder, select, setPinned, shortCwd, type Session } from '../deck'

const q = ref('')
const closedOpen = ref(localStorage.getItem('deck.closedOpen') !== '0')
watch(closedOpen, (v) => localStorage.setItem('deck.closedOpen', v ? '1' : '0'))
const folded = ref(new Set<string>(JSON.parse(localStorage.getItem('deck.folded') || '[]')))
function toggle(g: string) {
  const s = new Set(folded.value)
  s.has(g) ? s.delete(g) : s.add(g)
  folded.value = s
  localStorage.setItem('deck.folded', JSON.stringify([...s]))
}

const groupOf = (s: Session) => projectOf(s)
const isLive = (s: Session) => s.where !== 'past' && s.status !== 'ended'

// pinned: in pin order (newest pin last). One row per pin; when a session id shows up twice, the running copy wins.
const pinned = computed(() => {
  const needle = q.value.trim().toLowerCase()
  const best = new Map<string, Session>()
  for (const s of deck.sessions) {
    if (!isPinned(s)) continue
    const id = pinId(s), had = best.get(id)
    if (!had || (isClosed(had) && !isClosed(s))) best.set(id, s)
  }
  return (deck.settings.pins ?? []).map((id) => best.get(id)).filter((s): s is Session => !!s && (!needle || hay(s).includes(needle)))
})

// in first-seen order too: the server sends sessions newest-activity first, which would reshuffle this box
const coordinators = computed(() => deck.sessions.filter((s) => s.kind === 'claude' && isCoordinator(s) && !isPinned(s) && s.where !== 'past' && !(s.where === 'deck' && !s.tmux)).sort((a, b) => seen(a.key) - seen(b.key)))
const isClosed = (s: Session) => s.where === 'past' || (s.where === 'deck' && !s.tmux)
const hay = (s: Session) => `${s.title} ${s.cwd} ${s.project ?? ''} ${s.lastPrompt ?? ''}`.toLowerCase()

// closed sessions, newest first; searching looks through all of them
const closed = computed(() => {
  const needle = q.value.trim().toLowerCase()
  const list = deck.sessions.filter((s) => s.kind === 'claude' && isClosed(s) && !isPinned(s) && (!needle || hay(s).includes(needle)))
  return list.sort((a, b) => b.last - a.last).slice(0, needle ? 40 : 15)
})

// Stable order: projects in the saved order (new ones appended once), and inside a project the order sessions first appeared in (new ones at
// the bottom). Activity never moves a row, so nothing jumps under the mouse.
const firstSeen: Record<string, number> = JSON.parse(localStorage.getItem('deck.firstSeen') || '{}')
let seenN = Math.max(0, ...Object.values(firstSeen))
function seen(key: string) {
  if (firstSeen[key] === undefined) {
    firstSeen[key] = ++seenN
    localStorage.setItem('deck.firstSeen', JSON.stringify(firstSeen))
  }
  return firstSeen[key]!
}
// a parent's children can be folded away (the chevron on its row)
const foldedKids = ref(new Set<string>(JSON.parse(localStorage.getItem('deck.foldedKids') || '[]')))
function toggleKids(key: string) {
  const s = new Set(foldedKids.value)
  s.has(key) ? s.delete(key) : s.add(key)
  foldedKids.value = s
  localStorage.setItem('deck.foldedKids', JSON.stringify([...s]))
}
type Row = { s: Session; depth: number; kids: number }
// the running rows the project groups show (pinned ones live in their own box)
const unpinned = computed(() => {
  const needle = q.value.trim().toLowerCase()
  return deck.sessions
    .filter((s) => s.kind !== 'login' || s.tmux)
    .filter((s) => !isClosed(s) && !isPinned(s))
    .filter((s) => !needle || hay(s).includes(needle))
})
// attached children: nested under their parent's row wherever it is shown (a pinned row or a group row)
const tree = computed(() => {
  const shown = [...pinned.value, ...unpinned.value]
  // nest a child when its parent's row is shown; a chain of parents that comes back to it (a cycle) stays flat
  const byKey = new Map(shown.map((s) => [s.key, s]))
  const nests = (s: Session) => {
    if (!s.attached || !s.parent || !byKey.has(s.parent)) return false
    let x = byKey.get(s.parent)
    for (let i = 0; x && i < 16; i++) {
      if (x === s) return false
      x = x.attached && x.parent ? byKey.get(x.parent) : undefined
    }
    return true
  }
  const kidsOf = new Map<string, Session[]>()
  for (const s of shown) if (nests(s)) kidsOf.set(s.parent!, [...(kidsOf.get(s.parent!) ?? []), s])
  const rowsOf = (s: Session, depth: number): Row[] => {
    const kids = (kidsOf.get(s.key) ?? []).sort((a, b) => seen(a.key) - seen(b.key))
    return [{ s, depth, kids: kids.length }, ...(foldedKids.value.has(s.key) ? [] : kids.flatMap((k) => rowsOf(k, depth + 1)))]
  }
  return { nests, rowsOf }
})
const pinnedRows = computed(() => pinned.value.filter((s) => !tree.value.nests(s)).flatMap((s) => tree.value.rowsOf(s, 0)))
const newest = computed(() => deck.settings.sidebarOrder === 'newest')
const groups = computed(() => {
  const { nests, rowsOf } = tree.value
  const list = unpinned.value.filter((s) => !nests(s))
  // Settings > Sidebar, newest at the top [T1112-138]: one list by when each session first showed up, newest first.
  // A row keeps its place while it works or waits; only a session that starts later goes above it.
  if (newest.value) {
    const rows = [...list].sort((a, b) => seen(b.key) - seen(a.key)).flatMap((s) => rowsOf(s, 0))
    return rows.length ? [{ name: '', live: 0, folders: [{ cwd: '', rows }] }] : []
  }
  const by = new Map<string, Map<string, Session[]>>()
  for (const s of list) {
    const g = groupOf(s)
    if (!by.has(g)) by.set(g, new Map())
    const f = by.get(g)!
    if (!f.has(s.cwd)) f.set(s.cwd, [])
    f.get(s.cwd)!.push(s)
  }
  return orderProjects(by.keys())
    .map((name) => [name, by.get(name)!] as const)
    .map(([name, folders]) => ({
      name,
      live: [...folders.values()].flat().filter(isLive).length,
      // coordinators first: the project's main session; each row followed by its attached children
      folders: [...folders.entries()].map(([cwd, sessions]) => ({ cwd, rows: [...sessions].sort((a, b) => Number(isCoordinator(b)) - Number(isCoordinator(a)) || seen(a.key) - seen(b.key)).flatMap((s) => rowsOf(s, 0)) })).sort((a, b) => a.cwd.localeCompare(b.cwd)),
    }))
})

// every project the deck knows gets its place in the saved order the first time it shows up
watch(() => [deck.loaded, deck.sessions, deck.settings], () => rememberProjects(deck.sessions.map(projectOf)), { immediate: true })

// drag a group header onto another to move it there
const dragging = ref<string | null>(null)
const dropOn = ref<string | null>(null)
function drop(target: string) {
  const from = dragging.value
  dragging.value = dropOn.value = null
  if (!from || from === target) return
  const all = orderProjects([...(deck.settings.projectOrder ?? []), ...deck.sessions.map(projectOf)])
  const rest = all.filter((n) => n !== from)
  const at = rest.indexOf(target)
  // dragging down lands after the target, dragging up lands before it
  rest.splice(all.indexOf(from) < all.indexOf(target) ? at + 1 : at, 0, from)
  saveProjectOrder(rest).catch(() => {})
}

// drag a running row onto another agent's terminal to mention it there (TerminalView takes the drop) [T1111-17];
// rows only start a drag, nothing in the list accepts one, so the order never changes from it
const canDrag = (s: Session) => s.where === 'deck' && !!s.tmux && s.kind !== 'login'
function onRowDragStart(e: DragEvent) {
  const key = (e.target as HTMLElement | null)?.closest?.('[data-key]')?.getAttribute('data-key')
  const s = key ? deck.sessions.find((x) => x.key === key) : undefined
  if (!s || !canDrag(s) || !e.dataTransfer) return
  e.dataTransfer.setData(SESSION_MIME, s.tmux!)
  e.dataTransfer.effectAllowed = 'copy'
  draggedSession.value = s.tmux
}

// status dot classes (colours in style.css: .dot-*)
const dot: Record<string, string> = {
  busy: 'dot dot-busy',
  idle: 'dot dot-idle',
  waiting: 'dot dot-waiting',
  blocked: 'dot dot-blocked',
  ended: 'dot dot-ended',
}
const whereLabel: Record<string, string | null> = { deck: null, terminal: 'Terminal', background: 'bg', past: null }
// the red question mark: why the session is waiting on you
/** a running deck session: hovering its time shows a close button [T1112-5] */
const canClose = (s: { where: string; tmux?: string | null; status: string }) => s.where === 'deck' && !!s.tmux && s.status !== 'ended'
/** done and safe to close, per Close old sessions [T1112-4] */
const doneHint = (why: string) => `Looks done: ${why}. ⌘W closes it; Close old sessions lists all of them.`
/** a session whose last reply stopped on an API error [T1112-1] */
const stoppedOn = (e: string) => `Stopped on an error: ${e} It does nothing until you tell it to go on.`
const needsYou = (s: { question?: string | null; waitingReason?: string | null; deploy?: boolean }) =>
  s.deploy ? `Waiting for a deploy OK: ${s.question}` : s.question ? `Needs you: ${s.question}` : s.waitingReason === 'last reply ends with a question' ? 'Needs you: its last reply asked you something' : `Needs you${s.waitingReason ? ': ' + s.waitingReason : ''}`
const openMenu = (e: MouseEvent, s: any) => (deck.menu = { x: e.clientX, y: e.clientY, s })

// keep the open session in view: on load and when it changes from elsewhere (⌘P, a link, Back),
// scroll the list so its row sits in the middle; a row already on screen is left alone
// a click inside the list never scrolls it (the row is already where the mouse is)
let clickedAt = 0
const noteClick = () => (clickedAt = Date.now())
function reveal() {
  if (Date.now() - clickedAt < 800) return
  nextTick(() => {
    const el = document.querySelector<HTMLElement>('[data-sel="1"]')
    if (!el) return
    const box = el.closest('.overflow-y-auto') as HTMLElement | null
    const r = el.getBoundingClientRect()
    const b = box?.getBoundingClientRect()
    if (!box || !b || (r.top >= b.top && r.bottom <= b.bottom)) return
    // scroll only the list, never the page around it
    box.scrollTop += r.top - b.top - (b.height - r.height) / 2
  })
}
watch(() => deck.selected, reveal)
// the first time sessions arrive after a reload
let revealed = false
watch(() => deck.sessions.length, (n) => { if (n && !revealed) { revealed = true; setTimeout(reveal, 50) } })
onMounted(reveal)

// Hover a row ~500 ms: its open TASKS.md lines in a tooltip right of the sidebar [T1112-116]. A row whose project
// has a TASKS.md drops its native title (the tooltip repeats the name and folder), others keep it.
const hasTip = (s: Session) => tasksOn.value && s.kind !== 'login' && !!fileForCwd(taskFiles.value, s.cwd)
const rowTitle = (s: Session, text: string) => (hasTip(s) ? undefined : text)
const tipAt = ref<{ s: Session; left: number; top: number } | null>(null)
let showT: ReturnType<typeof setTimeout> | undefined
let hideT: ReturnType<typeof setTimeout> | undefined
let hoverKey: string | null = null
const rowEl = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.<HTMLElement>('[data-key]') ?? null
function hideTip() {
  clearTimeout(showT)
  clearTimeout(hideT)
  hoverKey = null
  tipAt.value = null
}
const keepTip = () => clearTimeout(hideT)
const hideSoon = () => {
  clearTimeout(hideT)
  hideT = setTimeout(hideTip, 200)
}
function onOver(e: PointerEvent) {
  const el = rowEl(e.target)
  const key = el?.getAttribute('data-key') ?? null
  if (!el || !key) return
  clearTimeout(hideT)
  if (key === hoverKey) return
  hoverKey = key
  clearTimeout(showT)
  // a tooltip already open follows the mouse to the next row at once; a fresh one waits
  const wait = tipAt.value ? 0 : 500
  showT = setTimeout(() => {
    const s = deck.sessions.find((x) => x.key === key)
    if (!s || !hasTip(s) || !el.isConnected) return void (tipAt.value = null)
    const side = el.closest('aside')?.getBoundingClientRect() ?? el.getBoundingClientRect()
    tipAt.value = { s, left: side.right + 8, top: el.getBoundingClientRect().top }
  }, wait)
}
function onOut(e: PointerEvent) {
  const to = e.relatedTarget as HTMLElement | null
  if (to && rowEl(e.target) && rowEl(to) === rowEl(e.target)) return
  if (to?.closest?.('[data-tasktip]')) return
  if (!rowEl(to)) {
    hoverKey = null
    clearTimeout(showT)
  }
  hideSoon()
}
</script>

<template>
  <div class="flex flex-col">
    <div class="flex items-center gap-2 px-3 pb-2">
      <div class="relative flex-1">
        <Search :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        <input v-model="q" class="input !py-1.5 !pl-8 !text-[13px]" placeholder="Filter sessions" />
      </div>

    </div>

    <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-3 text-[13.5px]" @pointerdown="noteClick(); hideTip()" @contextmenu="noteClick(); hideTip()" @dragstart="hideTip(); onRowDragStart($event)" @dragend="draggedSession = null" @pointerover="onOver" @pointerout="onOut" @scroll.passive="hideTip">
      <div v-if="!deck.loaded" class="px-2.5 py-3 text-[13px] text-faint">Loading…</div>
      <div v-if="pinned.length" class="mb-2 mt-1">
        <div class="side-label flex items-center gap-1 px-2 pb-1"><Pin :size="11" /> Pinned</div>
        <button
          v-for="{ s, depth, kids } in pinnedRows" :key="'p' + s.key"
          class="side-row group"
          :style="depth ? { paddingLeft: `${10 + depth * 16}px` } : undefined"
          :data-sel="s.key === deck.selected ? '1' : undefined" :data-key="s.key" :draggable="canDrag(s) ? 'true' : undefined" :class="[s.key === deck.selected ? 'is-sel' : s.status === 'waiting' ? 'is-wait' : s.apiError ? 'is-err' : s.tidy ? 'is-tidy' : '', depth ? 'is-child' : '']"
          :title="rowTitle(s, `${s.title}\n${s.cwd}${isClosed(s) ? '\nNot running: click to open its card' : ''}${s.question ? '\nNeeds you: ' + s.question : ''}`)"
          @click="select(s.key)"
          @contextmenu.prevent="openMenu($event, s)"
        >
          <span v-if="depth" class="-ml-1 flex-none text-[11px] leading-none text-[var(--color-line-strong)]" title="Attached to the session above (deck new --attach)">↳</span>
          <Star v-if="isCoordinator(s)" :size="12" class="flex-none fill-[var(--color-brand-400)] text-[var(--color-brand-400)]" :class="isClosed(s) ? 'opacity-50' : ''" />
          <span v-else :class="dot[isClosed(s) ? 'ended' : s.status]"></span>
          <span class="min-w-0 flex-1 truncate" :class="isClosed(s) ? 'text-faint' : ''">{{ s.title }}</span>
          <span v-if="kids" class="flex flex-none items-center text-[10.5px] text-faint hover:text-ink" :title="foldedKids.has(s.key) ? `Show its ${kids} attached session${kids > 1 ? 's' : ''}` : 'Fold its attached sessions'" @click.stop="toggleKids(s.key)">
            <component :is="foldedKids.has(s.key) ? ChevronRight : ChevronDown" :size="12" /><span v-if="foldedKids.has(s.key)">{{ kids }}</span>
          </span>
          <span v-if="s.status === 'waiting' && !isClosed(s)" class="flex flex-none" :title="needsYou(s)"><Rocket v-if="s.deploy" :size="14" class="flex-none text-[var(--color-chip-violet-fg)]" /><MessageCircleQuestion v-else :size="14" class="flex-none text-[var(--color-st-wait)]" /></span>
          <span v-if="s.apiError && s.status !== 'waiting'" class="flex flex-none" :title="stoppedOn(s.apiError)"><CircleAlert :size="14" class="flex-none text-[var(--color-danger)]" /></span>
          <span v-if="s.tidy && !s.apiError && s.status !== 'waiting'" class="flex flex-none" :title="doneHint(s.tidy)"><BrushCleaning :size="14" class="flex-none opacity-70" /></span>
          <span v-if="s.owes && !s.apiError && s.status !== 'waiting'" class="flex flex-none" :title="`Waiting on you: ${s.owes}`"><Hand :size="14" class="flex-none text-[var(--color-st-wait)]" /></span>
          <SquareTerminal v-else-if="s.where === 'terminal'" :size="12" class="flex-none text-faint opacity-60" />
          <Moon v-else-if="s.where === 'background'" :size="12" class="flex-none text-faint opacity-60" />
          <span v-if="s.tool && s.tool !== 'claude'" class="tag bg-[var(--color-chip-blue-bg)] text-[var(--color-chip-blue-fg)]">{{ s.tool }}</span>
          <!-- every agent row says its mode, so a mix of auto and ask is visible at a glance [T1112-99] -->
          <span v-if="s.mode === 'ask'" class="tag bg-[var(--color-chip-green-bg)] text-[var(--color-chip-green-fg)]" title="Auto mode off: the tool asks before commands and edits">ask</span>
          <span v-else-if="s.kind === 'claude' && s.where === 'deck' && !s.hand" class="tag bg-[var(--color-chip-gray-bg)] text-[var(--color-chip-gray-fg)]" title="Auto mode: the tool runs commands and edits without asking">auto</span>
          <span v-if="isPinned(s)" class="hidden flex-none text-faint hover:text-ink group-hover:flex" title="Unpin" @click.stop="setPinned(s, false).catch(() => {})"><PinOff :size="12" /></span>
          <span class="row-time w-6 flex-none text-right text-[10.5px] tabular-nums text-faint opacity-70">{{ ago(s.last) }}</span>
          <button v-if="canClose(s)" type="button" class="row-x w-6 flex-none items-center justify-end text-faint hover:text-[var(--color-danger)]" title="Close (⌘W): stops it, unpins and hides it; the conversation is kept" @click.stop="askStop(s, { close: true })" @mousedown.stop><X :size="13" /></button>
        </button>
      </div>
      <div v-if="coordinators.length && !q" class="mb-2 mt-1 rounded-lg border border-line p-1">
        <div class="side-label px-1.5 pb-1 pt-0.5">Coordinators</div>
        <button v-for="s in coordinators" :key="'k' + s.key" class="side-row !px-1.5 text-[13px]"
          :data-sel="s.key === deck.selected ? '1' : undefined" :data-key="s.key" :draggable="canDrag(s) ? 'true' : undefined" :class="s.key === deck.selected ? 'is-sel' : s.status === 'waiting' ? 'is-wait' : s.apiError ? 'is-err' : s.tidy ? 'is-tidy' : ''" @click="select(s.key)" @contextmenu.prevent="openMenu($event, s)">
          <Star :size="12" class="flex-none fill-[var(--color-brand-400)] text-[var(--color-brand-400)]" />
          <span class="min-w-0 flex-1 truncate font-medium">{{ s.title }}</span>
          <span v-if="s.status === 'waiting'" class="flex flex-none" :title="needsYou(s)"><Rocket v-if="s.deploy" :size="13" class="text-[var(--color-chip-violet-fg)]" /><MessageCircleQuestion v-else :size="13" class="text-[var(--color-st-wait)]" /></span>
          <span v-if="s.apiError && s.status !== 'waiting'" class="flex flex-none" :title="stoppedOn(s.apiError)"><CircleAlert :size="13" class="flex-none text-[var(--color-danger)]" /></span>
          <span v-if="s.tidy && !s.apiError && s.status !== 'waiting'" class="flex flex-none" :title="doneHint(s.tidy)"><BrushCleaning :size="13" class="flex-none opacity-70" /></span>
          <span v-if="s.owes && !s.apiError && s.status !== 'waiting'" class="flex flex-none" :title="`Waiting on you: ${s.owes}`"><Hand :size="13" class="flex-none text-[var(--color-st-wait)]" /></span>
          <span :class="dot[s.status]"></span>
        </button>
      </div>
      <div v-else-if="!groups.length && !pinned.length" class="px-2.5 py-3 text-[13px] text-faint">No sessions{{ q ? ' match' : ' running' }}.</div>
      <div v-for="g in groups" :key="g.name" class="mt-3 first:mt-1">
        <button v-if="g.name" class="side-label flex w-full items-center gap-1 rounded px-2 pb-1 text-left hover:!text-ink-soft"
          :class="[dropOn === g.name && dragging !== g.name ? 'bg-[var(--color-row-sel)] !text-ink-soft' : '', dragging === g.name ? 'opacity-50' : '']"
          draggable="true" title="Drag to reorder projects; right-click for Close all" :data-group-head="g.name"
          @click="toggle(g.name)"
          @contextmenu.prevent="deck.projectMenu = { x: $event.clientX, y: $event.clientY, name: g.name }"
          @dragstart="dragging = g.name; $event.dataTransfer?.setData('text/plain', g.name)"
          @dragend="dragging = dropOn = null"
          @dragover.prevent="dragging && (dropOn = g.name)"
          @dragleave="dropOn === g.name && (dropOn = null)"
          @drop.prevent="drop(g.name)">
          <component :is="folded.has(g.name) ? ChevronRight : ChevronDown" :size="13" />
          <span class="flex-1 truncate">{{ g.name }}</span>
          <span v-if="g.live" class="font-medium normal-case tracking-normal">{{ g.live }}</span>
        </button>
        <template v-if="!folded.has(g.name)">
          <div v-for="f in g.folders" :key="f.cwd">
            <button
              v-for="{ s, depth, kids } in f.rows"
              :key="s.key"
              class="side-row group"
              :style="depth ? { paddingLeft: `${10 + depth * 16}px` } : undefined"
              :data-sel="s.key === deck.selected ? '1' : undefined" :data-key="s.key" :draggable="canDrag(s) ? 'true' : undefined" :class="[s.key === deck.selected ? 'is-sel' : s.status === 'waiting' ? 'is-wait' : s.apiError ? 'is-err' : s.tidy ? 'is-tidy' : '', depth ? 'is-child' : '']"
              :title="rowTitle(s, `${s.title}\n${s.cwd}${s.where === 'terminal' ? '\nOpen in a Terminal tab' : s.where === 'background' ? '\nRunning in the background' : ''}${s.question ? '\nNeeds you: ' + s.question : ''}`)"
              @click="select(s.key)"
            @contextmenu.prevent="openMenu($event, s)"
            >
              <span v-if="depth" class="-ml-1 flex-none text-[11px] leading-none text-[var(--color-line-strong)]" title="Attached to the session above (deck new --attach)">↳</span>
              <Star v-if="isCoordinator(s)" :size="12" class="flex-none fill-[var(--color-brand-400)] text-[var(--color-brand-400)]" />
              <span v-else :class="dot[s.where === 'past' ? 'ended' : s.status]"></span>
              <span class="flex-1 truncate" :class="[s.where === 'past' ? 'text-faint' : '', isCoordinator(s) ? 'font-semibold text-ink' : '', g.name ? 'min-w-0' : 'min-w-[8ch]']">{{ s.title }}</span>
              <span v-if="!g.name && !depth" class="min-w-0 max-w-[9ch] shrink truncate text-[10.5px] text-faint" data-row-project>{{ projectOf(s) }}</span>
              <span v-if="kids" class="flex flex-none items-center text-[10.5px] text-faint hover:text-ink" :title="foldedKids.has(s.key) ? `Show its ${kids} attached session${kids > 1 ? 's' : ''}` : 'Fold its attached sessions'" @click.stop="toggleKids(s.key)">
                <component :is="foldedKids.has(s.key) ? ChevronRight : ChevronDown" :size="12" /><span v-if="foldedKids.has(s.key)">{{ kids }}</span>
              </span>
              <span v-if="s.status === 'waiting'" class="flex flex-none" :title="needsYou(s)"><Rocket v-if="s.deploy" :size="14" class="flex-none text-[var(--color-chip-violet-fg)]" /><MessageCircleQuestion v-else :size="14" class="flex-none text-[var(--color-st-wait)]" /></span>
              <span v-if="s.apiError && s.status !== 'waiting'" class="flex flex-none" :title="stoppedOn(s.apiError)"><CircleAlert :size="14" class="flex-none text-[var(--color-danger)]" /></span>
              <span v-if="s.tidy && !s.apiError && s.status !== 'waiting'" class="flex flex-none" :title="doneHint(s.tidy)"><BrushCleaning :size="14" class="flex-none opacity-70" /></span>
              <span v-if="s.owes && !s.apiError && s.status !== 'waiting'" class="flex flex-none" :title="`Waiting on you: ${s.owes}`"><Hand :size="14" class="flex-none text-[var(--color-st-wait)]" /></span>
              <SquareTerminal v-else-if="s.where === 'terminal'" :size="12" class="flex-none text-faint opacity-60" />
              <Moon v-else-if="s.where === 'background'" :size="12" class="flex-none text-faint opacity-60" />
              <span v-if="s.tool && s.tool !== 'claude'" class="tag bg-[var(--color-chip-blue-bg)] text-[var(--color-chip-blue-fg)]">{{ s.tool }}</span>
          <!-- every agent row says its mode, so a mix of auto and ask is visible at a glance [T1112-99] -->
          <span v-if="s.mode === 'ask'" class="tag bg-[var(--color-chip-green-bg)] text-[var(--color-chip-green-fg)]" title="Auto mode off: the tool asks before commands and edits">ask</span>
          <span v-else-if="s.kind === 'claude' && s.where === 'deck' && !s.hand" class="tag bg-[var(--color-chip-gray-bg)] text-[var(--color-chip-gray-fg)]" title="Auto mode: the tool runs commands and edits without asking">auto</span>
              <span v-if="s.account && s.account !== 'default'" class="tag bg-[var(--color-chip-gray-bg)] text-[var(--color-chip-gray-fg)]">{{ s.account }}</span>
              <span v-if="s.kind !== 'login'" class="hidden flex-none text-faint hover:text-ink group-hover:flex" title="Pin to top" @click.stop="setPinned(s, true).catch(() => {})"><Pin :size="12" /></span>
              <span class="row-time w-6 flex-none text-right text-[10.5px] tabular-nums text-faint opacity-70">{{ ago(s.last) }}</span>
          <button v-if="canClose(s)" type="button" class="row-x w-6 flex-none items-center justify-end text-faint hover:text-[var(--color-danger)]" title="Close (⌘W): stops it, unpins and hides it; the conversation is kept" @click.stop="askStop(s, { close: true })" @mousedown.stop><X :size="13" /></button>
            </button>
          </div>
        </template>
      </div>

      <div v-if="closed.length" class="mt-4">
        <button class="side-label flex w-full items-center gap-1 px-2 pb-1 text-left hover:!text-ink-soft" @click="closedOpen = !closedOpen">
          <component :is="closedOpen || q ? ChevronDown : ChevronRight" :size="13" />
          <span class="flex-1">{{ q ? 'Closed sessions' : 'Recently closed' }}</span>
          <span class="font-medium normal-case tracking-normal">{{ closed.length }}</span>
        </button>
        <template v-if="closedOpen || q">
          <button
            v-for="s in closed" :key="'c' + s.key"
            class="side-row !block !py-1.5"
            :data-sel="s.key === deck.selected ? '1' : undefined" :data-key="s.key" :draggable="canDrag(s) ? 'true' : undefined" :class="s.key === deck.selected ? 'is-sel' : ''"
            :title="rowTitle(s, s.cwd)"
            @click="select(s.key)"
            @contextmenu.prevent="openMenu($event, s)"
          >
            <span class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-[13px] text-ink-soft">{{ s.title }}</span>
              <span class="flex-none text-[10.5px] text-faint">{{ projectOf(s) }}</span>
              <span class="row-time w-6 flex-none text-right text-[10.5px] tabular-nums text-faint opacity-70">{{ ago(s.last) }}</span>
          <button v-if="canClose(s)" type="button" class="row-x w-6 flex-none items-center justify-end text-faint hover:text-[var(--color-danger)]" title="Close (⌘W): stops it, unpins and hides it; the conversation is kept" @click.stop="askStop(s, { close: true })" @mousedown.stop><X :size="13" /></button>
            </span>
            <span v-if="s.lastPrompt" class="block truncate text-[11.5px] text-faint">you: {{ s.lastPrompt }}</span>
          </button>
        </template>
      </div>
    </nav>
    <TaskTip v-if="tipAt" :key="tipAt.s.key" :s="tipAt.s" :left="tipAt.left" :top="tipAt.top" @enter="keepTip" @leave="hideSoon" @done="hideTip" />
  </div>
</template>
