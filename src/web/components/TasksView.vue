<script setup lang="ts">
// Every project's TASKS.md in one place: what waits on the owner (all projects) on top, then the
// chosen project's To do and what was done today. A line's "· session <id>" links to that session.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { CheckCircle2, Circle, Hand, MessageSquareReply, Search } from 'lucide-vue-next'
import { current, deck, openSession, projectOf, select } from '../deck'
import { countsTip, isRecent, type TaskLine as Task } from '../../taskview'
import { loadTasks, setSince, since, taskCounts, taskFiles as files, tasksFocus, tasksPick, type TaskFile } from '../tasks'
import FollowupModal from './FollowupModal.vue'
import FollowupAllModal from './FollowupAllModal.vue'

const q = ref('')
const pick = ref<string>('')
// a click on a line in a sidebar row's task tooltip opens this view on that project [T1112-116]
watch(tasksPick, (f) => {
  if (!f) return
  pick.value = f
  tasksPick.value = ''
}, { immediate: true })
let t: ReturnType<typeof setInterval>
const load = loadTasks
onMounted(() => {
  load()
  t = setInterval(load, 10000)
})
onUnmounted(() => clearInterval(t))

// a TASKS.md is named after the project of the sessions under it
const nameOf = (f: TaskFile) => {
  const s = deck.sessions.find((x) => x.cwd === f.root || x.cwd.startsWith(f.root + '/'))
  const n = s ? projectOf(s) : f.root.split('/').pop()!
  return f.copyOf ? `${n} (worktree ${f.root.split('/').pop()})` : n
}
const projects = computed(() => files.value.map((f) => ({ f, name: nameOf(f), open: f.tasks.filter((x) => !x.done && x.section !== 'done' && fresh(x)).length })).sort((a, b) => a.name.localeCompare(b.name)))
// the menu lists projects with open lines; one with none shows only while it is the chosen one [T1112-136]
const listed = computed(() => projects.value.filter((p) => p.open || p.f.file === chosen.value?.f.file))
const chosen = computed(() => {
  if (pick.value) return projects.value.find((p) => p.f.file === pick.value) ?? null
  const cur = current.value
  return (cur && projects.value.find((p) => cur.cwd === p.f.root || cur.cwd.startsWith(p.f.root + '/'))) || projects.value.find((p) => p.open) || projects.value[0] || null
})
// "Start fresh": only lines dated on or after that day are shown. TASKS.md files are not touched;
// older lines stay there and come back with "Show older".
const showOld = ref(false)
// every line counts, with an id or not; only a fresh start hides older (and undated) lines [T1112-117]
const recent = (x: Task) => isRecent(x, since.value)
const fresh = (x: Task) => showOld.value || recent(x)
function startFresh() {
  setSince(new Date().toISOString().slice(0, 10))
  showOld.value = false
}
const clearFresh = () => setSince('')
const older = computed(() => files.value.reduce((n, f) => n + (f.copyOf ? 0 : f.tasks.filter((x) => !x.done && x.section !== 'done' && !recent(x)).length), 0))
const summary = computed(() => countsTip(taskCounts.value, ''))
// open lines only by default (To do, Waiting on the owner); today's ticked lines behind "Show done", remembered [T1112-117]
const showDone = ref(localStorage.getItem('deck.tasksShowDone') === '1')
watch(showDone, (v) => (v ? localStorage.setItem('deck.tasksShowDone', '1') : localStorage.removeItem('deck.tasksShowDone')))
const match = (x: Task) => fresh(x) && (!q.value.trim() || `${x.id ?? ''} ${x.text}`.toLowerCase().includes(q.value.trim().toLowerCase()))
const waiting = computed(() => projects.value.filter((p) => !p.f.copyOf).flatMap((p) => p.f.tasks.filter((x) => x.section === 'waiting' && !x.done && match(x)).map((x) => ({ ...x, project: p.name, root: p.f.root }))))
const todo = computed(() => (chosen.value?.f.tasks ?? []).filter((x) => x.section === 'todo' && !x.done && match(x)))
const today = new Date().toISOString().slice(0, 10)
const doneToday = computed(() => (chosen.value?.f.tasks ?? []).filter((x) => x.done && (x.day === today || x.date === today) && match(x)))
const doneCount = computed(() => (chosen.value?.f.tasks ?? []).filter((x) => x.done && (x.day === today || x.date === today)).length)

/** "1a2b3c4d" -> the session it names, if the deck knows it */
const sessionOf = (id8: string) => deck.sessions.find((s) => s.sessionId?.startsWith(id8))
function go(id8: string) {
  const s = sessionOf(id8)
  if (s) s.tmux ? select(s.key) : openSession(s.sessionId!)
}
// Follow up with agent [T1112-14]
const followup = ref<{ task: Task; root: string; project: string } | null>(null)
const followOn = (task: Task, root: string, project: string) => (followup.value = { task, root, project })
// Follow up with all [T1112-118]: the chosen project's open lines as filtered here (search, fresh start)
const allLines = computed(() => (chosen.value?.f.tasks ?? []).filter((x) => x.section !== 'done' && !x.done && match(x)))
const followAll = ref(false)
// a task id clicked in a terminal [T1112-137]: its project, searched for the id, older and done lines shown
watch(tasksFocus, async (f) => {
  if (!f) return
  tasksFocus.value = null
  if (!files.value.length) await load()
  const has = files.value.filter((x) => !x.copyOf && x.tasks.some((t) => t.id === f.id))
  const file = has.find((x) => f.cwd === x.root || f.cwd.startsWith(x.root + '/')) ?? has[0]
  if (file) pick.value = file.file
  q.value = f.id
  showOld.value = true
  if (file?.tasks.some((t) => t.id === f.id && t.done)) showDone.value = true
}, { immediate: true })
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto max-w-4xl px-6 py-6">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">Tasks</h2>
          <p class="text-[13px] text-muted">Open lines from each project's TASKS.md. Click a session tag to open the session that added the line, or a line to follow up with an agent.</p>
          <p class="mt-1 text-[12.5px] text-faint" data-test="tasks-summary">{{ summary }}<template v-if="since">. <span class="font-medium text-[var(--color-chip-amber-fg)]">Start fresh is on</span>: only lines dated {{ since }} or later<template v-if="older && !showOld">, {{ older.toLocaleString('en-US') }} older hidden</template></template></p>
        </div>
        <div class="flex items-center gap-2">
          <button v-if="older" class="btn btn-ghost btn-sm" title="Lines dated before the fresh start, or with no date" @click="showOld = !showOld">{{ showOld ? 'Hide' : 'Show' }} {{ older }} older</button>
          <template v-if="since">
            <button class="btn btn-ghost btn-sm" @click="clearFresh">Undo fresh start</button>
          </template>
          <button v-if="doneCount" class="btn btn-ghost btn-sm" :title="'Lines ticked today in ' + (chosen?.name ?? 'this project')" @click="showDone = !showDone">{{ showDone ? 'Hide' : 'Show' }} done ({{ doneCount }})</button>
          <button v-if="!since" class="btn btn-soft btn-sm" title="Hide every line dated before today. The TASKS.md files are not changed." @click="startFresh">Start fresh</button>
        </div>
        <div class="relative w-64">
          <Search :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input v-model="q" class="input !py-1.5 !pl-8 !text-[13px]" placeholder="Search tasks" />
        </div>
      </div>

      <section v-if="waiting.length" class="mt-6">
        <div class="col-label mb-2 flex items-center gap-1.5"><Hand :size="13" /> Waiting on you · all projects · {{ waiting.length }}</div>
        <div class="card divide-y divide-line">
          <div v-for="(x, i) in waiting" :key="'w' + i" class="flex items-start gap-3 px-4 py-2.5">
            <Circle :size="15" class="mt-0.5 flex-none text-[var(--color-chip-amber-fg)]" />
            <div class="min-w-0 flex-1">
              <p class="cursor-pointer text-[13.5px] leading-snug" title="Follow up with agent" @click="followOn(x, x.root, x.project)">{{ x.text }}</p>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-faint">
                <span class="rounded bg-canvas-2 px-1.5 py-0.5 text-muted">{{ x.project }}</span>
                <span v-if="x.id" class="pill-mono">{{ x.id }}</span><span v-if="x.date">{{ x.date }}</span>
                <button v-for="sid in x.sessions" :key="sid" class="pill-mono hover:text-ink hover:underline" :disabled="!sessionOf(sid)" @click="go(sid)">{{ sessionOf(sid)?.title ?? sid }}</button>
                <button class="followup ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-[var(--color-row-hover)] hover:text-ink" @click="followOn(x, x.root, x.project)"><MessageSquareReply :size="12" /> Follow up with agent</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div class="mt-8 flex items-center gap-2">
        <span class="col-label">Project</span>
        <select class="input !w-64 !py-1.5" :value="chosen?.f.file ?? ''" @change="pick = ($event.target as HTMLSelectElement).value">
          <option v-for="p in listed" :key="p.f.file" :value="p.f.file">{{ p.name }} · {{ p.open }} open</option>
        </select>
        <span class="pill-mono truncate text-faint">{{ chosen?.f.file }}</span>
        <button v-if="allLines.length" class="btn btn-soft btn-sm ml-auto flex-none" title="One message to each session these open lines are tagged with" data-follow-all @click="followAll = true"><MessageSquareReply :size="13" /> Follow up with all ({{ allLines.length }})</button>
      </div>

      <section class="mt-3">
        <div class="col-label mb-2">To do · {{ todo.length }}</div>
        <div v-if="!todo.length" class="text-[13px] text-faint">Nothing open.</div>
        <div v-else class="card divide-y divide-line">
          <div v-for="(x, i) in todo" :key="'t' + i" class="flex items-start gap-3 px-4 py-2.5">
            <Circle :size="15" class="mt-0.5 flex-none text-faint" />
            <div class="min-w-0 flex-1">
              <p class="cursor-pointer text-[13.5px] leading-snug" title="Follow up with agent" @click="followOn(x, chosen!.f.root, chosen!.name)">{{ x.text }}</p>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-faint">
                <span v-if="x.id" class="pill-mono">{{ x.id }}</span><span v-if="x.date">{{ x.date }}</span>
                <button v-for="sid in x.sessions" :key="sid" class="pill-mono hover:text-ink hover:underline" :disabled="!sessionOf(sid)" @click="go(sid)">{{ sessionOf(sid)?.title ?? sid }}</button>
                <button class="followup ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-[var(--color-row-hover)] hover:text-ink" @click="followOn(x, chosen!.f.root, chosen!.name)"><MessageSquareReply :size="12" /> Follow up with agent</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="showDone && doneToday.length" class="mt-6">
        <div class="col-label mb-2">Done today · {{ doneToday.length }}</div>
        <div class="card divide-y divide-line">
          <div v-for="(x, i) in doneToday" :key="'d' + i" class="flex items-start gap-3 px-4 py-2.5">
            <CheckCircle2 :size="15" class="mt-0.5 flex-none text-[var(--color-chip-green-fg)]" />
            <p class="min-w-0 flex-1 text-[13px] leading-snug text-muted">{{ x.text }}</p>
          </div>
        </div>
      </section>
    </div>
    <FollowupAllModal v-if="followAll && chosen" :lines="allLines" :project="chosen.name" @close="followAll = false" />
    <FollowupModal v-if="followup" :key="followup.task.id ?? followup.task.text" :task="followup.task" :root="followup.root" :project="followup.project" @close="followup = null" />
  </div>
</template>
