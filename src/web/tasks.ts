// The TASKS.md lines the page has, shared by the Tasks view and the sidebar's Tasks button count [T1112-14].
import { computed, ref } from 'vue'
import { api, deck } from './deck'
import { openCounts, sessionTip, type TaskLine } from '../taskview'

/** `copyOf`: a worktree copy of a listed TASKS.md, left out of the counts [T1112-117] */
export type TaskFile = { root: string; file: string; tasks: TaskLine[]; copyOf?: string }
export const taskFiles = ref<TaskFile[]>([])
/** Settings > Tasks view [T1112-16]: unset counts as on until the server says (it decides at first run) */
export const tasksOn = computed(() => deck.settings.tasksView !== false)
// "Start fresh": only lines dated on or after that day are shown (TASKS.md files are not touched)
export const since = ref(localStorage.getItem('deck.tasksSince') || '')
export function setSince(v: string) {
  since.value = v
  if (v) localStorage.setItem('deck.tasksSince', v)
  else localStorage.removeItem('deck.tasksSince')
}
let loadedAt = 0
export async function loadTasks() {
  if (!tasksOn.value) return void (taskFiles.value = [])
  try {
    taskFiles.value = (await api<{ files: TaskFile[] }>('/api/tasks')).files
    loadedAt = Date.now()
  } catch {}
}
/** at most once a minute, for the sidebar count (the Tasks view loads every 10 s while open) */
export const loadTasksSoon = () => (Date.now() - loadedAt >= 60_000 ? loadTasks() : undefined)
export const taskCounts = computed(() => openCounts(taskFiles.value, since.value))

/** a sidebar row's task tooltip [T1112-116]: from the lines already loaded (no file reads per hover) */
export const tipFor = (s: { cwd: string; sessionId: string | null; pastIds?: string[]; kind: string }) =>
  tasksOn.value && s.kind !== 'login' ? sessionTip(taskFiles.value, s.cwd, [s.sessionId, ...(s.pastIds ?? [])], since.value) : null
/** the TASKS.md the Tasks view should show next (a click in the sidebar's task tooltip); the view takes it and clears it */
export const tasksPick = ref('')
/** a task id clicked in a terminal [T1112-137]: the Tasks view opens on that line (the project whose folder holds `cwd` first) */
export const tasksFocus = ref<{ id: string; cwd: string } | null>(null)
