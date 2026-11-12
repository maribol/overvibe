<script setup lang="ts">
// First-run setup [T1110-67]: Welcome (with the ElasticFunnels and task list boxes, ticked on a first run), Projects folder,
// Your agents, Shared skills, Safety, Done. Every step can be skipped (Esc), Enter goes on, X closes it for
// good (it stays in Settings and the palette). Logging in sets it aside for the login terminal; a pill
// brings it back on the same step.
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Command, Copy, Download, FolderLock, KeyRound, LogIn, MessagesSquare, Monitor, Plus, RefreshCw, ShieldCheck, SquareTerminal, TerminalSquare, X } from 'lucide-vue-next'
import Spinner from './Spinner.vue'
import SafetyPoints from './SafetyPoints.vue'
import WorkRootField from './WorkRootField.vue'
import Wordmark from './Wordmark.vue'
import { accountsFor, api, deck, openNew, refresh, select, showToast, updateTool, versionOf, workRoot, type Account, type ToolStatus } from '../deck'
import { ackSafety, finishSetup, onSetupClose, putSetupAside, setup } from '../setup'
import { IS_MAC_UI, alt } from '../keys'

const TOOL_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'agy' }
const GLYPH: Record<string, string> = { claude: 'C', codex: 'X', agy: 'A' }

// ---------- the skills library (src/skills.ts, /api/skills) ----------
type Place = { tool: string; scope: string; state: string }
type Skill = { name: string; description: string; on: boolean; pending?: boolean; recommended?: string; tools: string[]; places: Place[] }
type Other = { tool: string; name: string; inLibrary: boolean }
const lib = ref<{ library: string; skills: Skill[]; others: Other[] } | null>(null)
const skillBusy = ref('')
const skillMsg = ref('')
async function loadSkills() {
  try {
    lib.value = await api('/api/skills')
    seedTasks()
  } catch {
    lib.value = null // a build without the skills library: the step and the box are left out
  }
}
const ef = computed(() => lib.value?.skills.find((s) => s.name === 'elasticfunnels') ?? null)
const librarySkills = computed(() => lib.value?.skills.filter((s) => !s.recommended) ?? [])
const linked = (s: Skill, tool: string) => s.places.some((p) => p.tool === tool && p.state === 'ok')
const importable = computed(() => {
  const by: Record<string, string[]> = {}
  for (const o of lib.value?.others ?? []) if (!o.inLibrary) (by[o.tool] ??= []).push(o.name)
  return Object.entries(by).map(([tool, names]) => ({ tool, names }))
})
async function toggleSkill(s: Skill) {
  skillBusy.value = s.name
  skillMsg.value = ''
  try {
    await api('/api/skills/on', { name: s.name, on: !s.on })
    await loadSkills()
  } catch (e: any) {
    skillMsg.value = e.message
  } finally {
    skillBusy.value = ''
  }
}
async function importAll(tool: string, names: string[]) {
  skillBusy.value = 'import:' + tool
  skillMsg.value = ''
  let n = 0
  try {
    for (const name of names) {
      await api('/api/skills/import', { tool, name, replace: true })
      n++
    }
    skillMsg.value = `${n} skill${n === 1 ? '' : 's'} from ${TOOL_LABEL[tool]} moved into the library. The originals are backed up in ~/.config/overvibe/skills-backup/.`
  } catch (e: any) {
    skillMsg.value = `${n} imported, then: ${e.message}`
  } finally {
    skillBusy.value = ''
    await loadSkills()
  }
}

// the Welcome step's ElasticFunnels box: ticked until a choice is recorded (pending), else the skill's current state;
// the choice is recorded on leaving Welcome or closing the setup
const efWanted = ref(true)
let efApplied = false
async function applyEf() {
  if (efApplied || !ef.value) return
  efApplied = true
  if (ef.value.pending || ef.value.on !== efWanted.value) await api('/api/skills/on', { name: 'elasticfunnels', on: efWanted.value }).catch((e) => showToast(e.message))
  await loadSkills()
}
const efOpen = ref(false)

// the Welcome step's usage ping box [T1110-72, T1112-101]: ticked unless turned off; recorded with the ElasticFunnels box
const ping = ref<{ on: boolean; chosen: boolean } | null>(null)
const pingWanted = ref(true)
api<{ on: boolean; chosen: boolean }>('/api/usage-ping')
  .then((r) => ((ping.value = r), (pingWanted.value = r.on)))
  .catch(() => {})
let pingApplied = false
async function applyPing() {
  if (pingApplied || !ping.value) return
  pingApplied = true
  if (!ping.value.chosen || ping.value.on !== pingWanted.value) {
    ping.value = await api<{ on: boolean; chosen: boolean }>('/api/usage-ping', { on: pingWanted.value }).catch((e) => (showToast(e.message), ping.value))
  }
}
// the Welcome step's task list box [T1112-15]: ticked until the tasks skill has a recorded choice, else on when both the
// skill and the Tasks view are; ticked, it switches on the bundled tasks skill (every tool) and the Tasks view
const tasksSkill = computed(() => lib.value?.skills.find((s) => s.name === 'tasks') ?? null)
const tasksWanted = ref(true)
let tasksSeeded = false
const seedTasks = () => {
  if (tasksSeeded || !tasksSkill.value) return
  tasksSeeded = true
  tasksWanted.value = tasksSkill.value.pending || (tasksSkill.value.on && deck.settings.tasksView !== false)
}
let tasksApplied = false
async function applyTasks() {
  if (tasksApplied || !tasksSkill.value) return
  tasksApplied = true
  const on = tasksWanted.value
  if (tasksSkill.value.pending || tasksSkill.value.on !== on) await api('/api/skills/on', { name: 'tasks', on }).catch((e) => showToast(e.message))
  if (on && deck.settings.tasksView === false) await api('/api/settings', { tasksView: true }).catch((e) => showToast(e.message))
  await Promise.all([loadSkills(), refresh()])
}
const tasksOpen = ref(false)
// the Welcome step's auto mode box [T1112-99]: shows the saved default (off on a new install) until the owner ticks
// or unticks it, saved when you go on, only when it changed
const autoPicked = ref<boolean | null>(null)
const autoWanted = computed({ get: () => autoPicked.value ?? deck.settings.permissionMode === 'auto', set: (v: boolean) => (autoPicked.value = v) })
async function applyAuto() {
  if (autoPicked.value === null) return
  const permissionMode = autoPicked.value ? 'auto' : 'ask'
  autoPicked.value = null
  if (permissionMode === deck.settings.permissionMode) return
  await api('/api/settings', { permissionMode }).catch((e) => showToast(e.message))
  await refresh()
}
const applyWelcome = () => Promise.all([applyEf(), applyTasks(), applyAuto(), applyPing()])

// ---------- steps ----------
type StepId = 'welcome' | 'folder' | 'agents' | 'skills' | 'safety' | 'done'
const steps = computed<StepId[]>(() => ['welcome', 'folder', 'agents', ...(lib.value ? (['skills'] as const) : []), 'safety', 'done'])
const at = computed(() => Math.min(setup.step, steps.value.length - 1))
const id = computed(() => steps.value[at.value]!)
const dir = ref<'fwd' | 'back'>('fwd')
const folderField = ref<InstanceType<typeof WorkRootField>>()
const panel = ref<HTMLElement>()

async function next() {
  if (id.value === 'welcome') await applyWelcome()
  if (id.value === 'folder' && folderField.value && !(await folderField.value.commit())) return
  if (id.value === 'safety' && !setup.safetySeen) await ackSafety()
  if (id.value === 'done') return start()
  go(at.value + 1)
}
function skip() {
  if (id.value === 'done') return void finishSetup()
  if (id.value === 'welcome') void applyWelcome()
  go(at.value + 1)
}
function go(i: number) {
  const to = Math.max(0, Math.min(steps.value.length - 1, i))
  dir.value = to < at.value ? 'back' : 'fwd'
  setup.step = to
  nextTick(() => panel.value?.focus({ preventScroll: true }))
}
async function start() {
  await finishSetup()
  openNew()
}
function onKey(e: KeyboardEvent) {
  if (!deck.setupOpen) return
  const t = e.target as HTMLElement
  if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), skip())
  else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.altKey && !(t instanceof HTMLButtonElement) && !(t instanceof HTMLAnchorElement)) (e.preventDefault(), next())
}

// ---------- agents ----------
const INSTALL: Record<string, { cmd?: string; text: string }> = {
  claude: { cmd: 'curl -fsSL https://claude.ai/install.sh | bash', text: 'Overvibe needs Claude Code.' },
  codex: { cmd: 'npm i -g @openai/codex', text: 'Optional. With Homebrew: brew install codex.' },
  agy: { text: 'Optional. The Antigravity CLI: install it and put agy on your PATH.' },
}
const tools = computed<ToolStatus[]>(() => (deck.tools.length ? deck.tools : (['claude', 'codex', 'agy'] as const).map((tool) => ({ tool, installed: true, accounts: tool !== 'agy' }))))
const loggedIn = (a: Account) => !!a.email && !a.error
type State = { tone: 'green' | 'amber' | 'gray' | 'red'; label: string }
function stateOf(t: ToolStatus): State {
  if (!t.installed) return t.tool === 'claude' ? { tone: 'red', label: 'Not installed' } : { tone: 'gray', label: 'Not installed' }
  if (!t.accounts) return { tone: 'green', label: 'Installed' }
  const list = accountsFor(t.tool)
  if (list.some(loggedIn)) return { tone: 'green', label: 'Ready' }
  return list.some((a) => a.checkedAt) ? { tone: 'amber', label: 'Log in needed' } : { tone: 'gray', label: 'Checking' }
}
const TONE = {
  green: 'background: var(--color-chip-green-bg); color: var(--color-chip-green-fg)',
  amber: 'background: var(--color-chip-amber-bg); color: var(--color-chip-amber-fg)',
  gray: 'background: var(--color-chip-gray-bg); color: var(--color-chip-gray-fg)',
  red: 'background: var(--color-chip-red-bg); color: var(--color-chip-red-fg)',
}
const checking = ref(false)
async function checkAgain() {
  checking.value = true
  try {
    deck.tools = (await api<{ tools: ToolStatus[] }>('/api/setup/tools')).tools
    for (const a of deck.accounts) await api(`/api/accounts/${a.name}/probe`, { tool: a.tool }).catch(() => {})
    await refresh()
  } finally {
    checking.value = false
  }
}
async function login(a: Account) {
  try {
    const r = await api<{ tmux: string }>(`/api/accounts/${a.name}/login`, { tool: a.tool })
    putSetupAside()
    await refresh()
    select(r.tmux)
    showToast('Log in in this terminal, then press Continue setup at the bottom right.')
  } catch (e: any) {
    showToast(e.message)
  }
}
function addAccount() {
  putSetupAside()
  deck.addAccountOpen = true
}
async function copy(t: string) {
  try {
    await navigator.clipboard.writeText(t)
    showToast('Copied')
  } catch {}
}
const ready = computed(() => tools.value.filter((t) => stateOf(t).tone === 'green').map((t) => TOOL_LABEL[t.tool]!))

// ---------- extras on the Done step: the CLI on PATH, the desktop app ----------
type Extras = { cli: string | null; ov: string | null; ovOurs: boolean; desktop: string | null; mac?: boolean }
const extras = ref<Extras | null>(null)
const extraBusy = ref('')
async function loadExtras() {
  try {
    extras.value = (await api<{ extras: Extras }>('/api/setup')).extras
  } catch {}
}
async function installCli() {
  extraBusy.value = 'cli'
  try {
    const r = await api<{ out: string }>('/api/setup/install-cli', {})
    showToast(r.out.split('\n').pop() || 'Installed')
    await loadExtras()
  } catch (e: any) {
    showToast(e.message)
  } finally {
    extraBusy.value = ''
  }
}
async function openDesktop() {
  try {
    await api('/api/setup/open-desktop', {})
  } catch (e: any) {
    showToast(e.message)
  }
}
const mod = window.deckDesktop ? '⌘' : IS_MAC_UI ? '⌥' : 'Alt+'

onMounted(async () => {
  window.addEventListener('keydown', onKey, true)
  onSetupClose(async () => void (await applyWelcome()))
  await loadSkills()
  efWanted.value = !ef.value || ef.value.pending ? true : ef.value.on
  loadExtras()
  await nextTick()
  panel.value?.focus({ preventScroll: true })
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey, true)
  onSetupClose(null)
})
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[85] grid place-items-center overflow-y-auto backdrop p-4">
      <div class="dialog relative flex w-full max-w-[780px] flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <!-- progress -->
        <div class="h-[3px] w-full bg-[var(--color-line)]">
          <div class="h-full bg-[var(--color-brand-500)] transition-[width] duration-500 ease-out" :style="{ width: ((at + 1) / steps.length) * 100 + '%' }"></div>
        </div>
        <div class="flex items-center gap-3 px-8 pt-5">
          <Wordmark class="h-[18px] w-auto text-ink" />
          <span class="flex-1"></span>
          <div class="flex items-center gap-1.5" aria-hidden="true">
            <span v-for="(s, i) in steps" :key="s" class="h-1.5 rounded-full transition-all duration-300" :class="i === at ? 'w-5 bg-[var(--color-brand-500)]' : i < at ? 'w-1.5 bg-[var(--color-brand-700)]' : 'w-1.5 bg-[var(--color-line-strong)]'"></span>
          </div>
          <span class="text-[12px] tabular-nums text-faint">Step {{ at + 1 }} of {{ steps.length }}</span>
          <button type="button" class="-mr-2 rounded-md p-1.5 text-faint hover:bg-canvas-2 hover:text-ink" title="Close setup (it stays in Settings and the palette)" aria-label="Close setup" @click="finishSetup"><X :size="17" /></button>
        </div>

        <div ref="panel" tabindex="-1" class="relative min-h-[440px] px-10 pb-4 pt-8 outline-none">
          <Transition :name="dir === 'fwd' ? 'step-fwd' : 'step-back'" mode="out-in">
            <!-- 1. welcome -->
            <section v-if="id === 'welcome'" key="welcome">
              <p class="col-label text-[var(--color-brand-600)]">Welcome</p>
              <h2 id="setup-title" class="mt-2 text-[28px] font-semibold leading-tight tracking-[-0.03em]">Your coding agents, side by side</h2>
              <p class="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">Overvibe runs Claude Code, Codex and agy on this computer. Each session is the real CLI in its own terminal, and agents can start and message each other.</p>
              <div class="mt-7 grid gap-3" :class="extras?.mac === false ? 'grid-cols-2' : 'grid-cols-3'">
                <div class="rounded-xl border border-line bg-canvas p-4">
                  <SquareTerminal :size="18" class="text-[var(--color-brand-600)]" />
                  <div class="mt-3 text-[13.5px] font-semibold">The real CLIs</div>
                  <p class="mt-1 text-[12.5px] leading-relaxed text-muted">Slash commands, skills, hooks and auto mode work as they do in your terminal.</p>
                </div>
                <div class="rounded-xl border border-line bg-canvas p-4">
                  <MessagesSquare :size="18" class="text-[var(--color-brand-600)]" />
                  <div class="mt-3 text-[13.5px] font-semibold">Agents talk</div>
                  <p class="mt-1 text-[12.5px] leading-relaxed text-muted"><span class="pill-mono">overvibe new</span> and <span class="pill-mono">overvibe send</span> let Claude hand work to Codex and get the answer back.</p>
                </div>
                <div class="rounded-xl border border-line bg-canvas p-4">
                  <KeyRound :size="18" class="text-[var(--color-brand-600)]" />
                  <div class="mt-3 text-[13.5px] font-semibold">Many accounts</div>
                  <p class="mt-1 text-[12.5px] leading-relaxed text-muted">Each Claude or Codex login is its own account, with its usage in the sidebar.</p>
                </div>
              </div>
              <!-- the ElasticFunnels skill: ticked on a first run, saved when you go on -->
              <div v-if="ef" class="mt-5 rounded-xl border border-line px-4 py-3">
                <label class="flex cursor-pointer items-start gap-3">
                  <input v-model="efWanted" type="checkbox" class="mt-0.5 flex-none" />
                  <span class="min-w-0 text-[13px] leading-relaxed">
                    <span class="font-medium text-ink">Add the ElasticFunnels skill</span>
                    <span class="text-muted"> (by the makers of Overvibe): agents can build and publish landing pages, funnels and sites with the <span class="pill-mono">ef</span> CLI.</span>
                    <button type="button" class="ml-1 text-[12.5px] font-medium text-[var(--color-brand-600)] hover:underline" @click.prevent="efOpen = !efOpen">{{ efOpen ? 'Hide' : 'What is this?' }}</button>
                  </span>
                </label>
                <p v-if="efOpen" class="mt-2 pl-8 text-[12.5px] leading-relaxed text-faint">{{ ef.description }} It goes to {{ ef.tools.map((t) => TOOL_LABEL[t] ?? t).join(', ') }} through the shared skills library. Turn it off any time in Settings, under Skills.</p>
              </div>
              <!-- the task list: the tasks skill and the Tasks view, ticked on a first run, saved when you go on [T1112-15] -->
              <div v-if="tasksSkill" class="mt-3 rounded-xl border border-line px-4 py-3">
                <label class="flex cursor-pointer items-start gap-3">
                  <input v-model="tasksWanted" type="checkbox" class="mt-0.5 flex-none" />
                  <span class="min-w-0 text-[13px] leading-relaxed">
                    <span class="font-medium text-ink">Keep a task list per project (TASKS.md)</span>
                    <span class="text-muted">: agents write down each request before they start on it, so none gets lost when messages pile up, and tick it once it is checked.</span>
                    <button type="button" class="ml-1 text-[12.5px] font-medium text-[var(--color-brand-600)] hover:underline" @click.prevent="tasksOpen = !tasksOpen">{{ tasksOpen ? 'Hide' : 'What is this?' }}</button>
                  </span>
                </label>
                <p v-if="tasksOpen" class="mt-2 pl-8 text-[12.5px] leading-relaxed text-faint">The tasks skill goes to {{ tasksSkill.tools.map((t) => TOOL_LABEL[t] ?? t).join(', ') }} and has agents keep TASKS.md in each project with <span class="pill-mono">overvibe tasks</span>. The Tasks view lists every project's open lines and what waits on you. Turn either off any time in Settings.</p>
              </div>
              <!-- auto mode for new sessions: unticked on a new install, saved when you go on [T1112-99] -->
              <div class="mt-3 rounded-xl border border-line px-4 py-3">
                <label class="flex cursor-pointer items-start gap-3">
                  <input v-model="autoWanted" type="checkbox" class="mt-0.5 flex-none" />
                  <span class="min-w-0 text-[13px] leading-relaxed"><span class="font-medium text-ink">Start new sessions in auto mode</span><span class="text-muted">: agents run commands and edit files without asking first.</span></span>
                </label>
              </div>
              <!-- the usage ping: ticked unless turned off, saved when you go on [T1110-72, T1112-101] -->
              <div v-if="ping" class="mt-3 rounded-xl border border-line px-4 py-3">
                <label class="flex cursor-pointer items-start gap-3">
                  <input v-model="pingWanted" type="checkbox" class="mt-0.5 flex-none" />
                  <span class="min-w-0 text-[13px] leading-relaxed">
                    <span class="font-medium text-ink">Send an anonymous usage ping</span>
                    <span class="text-muted"> once a day: a random install id, the Overvibe version, the OS and its version, and which of Claude Code, Codex and agy are installed. Turn it off any time in Settings.</span>
                  </span>
                </label>
              </div>
            </section>

            <!-- 2. projects folder -->
            <section v-else-if="id === 'folder'" key="folder">
              <p class="col-label text-[var(--color-brand-600)]">Projects folder</p>
              <h2 id="setup-title" class="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.03em]">Where do your projects live?</h2>
              <p class="mt-3 max-w-xl text-[14.5px] leading-relaxed text-muted">New session and the palette search the folders under this one, and Codex sessions may write to it. A session can still start in any folder under your home.</p>
              <WorkRootField ref="folderField" preview class="mt-6" />
            </section>

            <!-- 3. agents -->
            <section v-else-if="id === 'agents'" key="agents">
              <div class="flex items-end justify-between gap-4">
                <div>
                  <p class="col-label text-[var(--color-brand-600)]">Your agents</p>
                  <h2 id="setup-title" class="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.03em]">Agents and accounts</h2>
                  <p class="mt-3 max-w-xl text-[14.5px] leading-relaxed text-muted">The CLIs on this computer and who they are logged in as. Claude Code is the one you need. Codex and agy are optional.</p>
                </div>
                <button type="button" class="btn btn-soft btn-sm flex-none" :disabled="checking" @click="checkAgain"><Spinner v-if="checking" :size="13" /><RefreshCw v-else :size="13" /> Check again</button>
              </div>
              <div class="mt-6 grid grid-cols-3 gap-3">
                <div v-for="t in tools" :key="t.tool" class="flex flex-col rounded-xl border bg-canvas p-4" :class="stateOf(t).tone === 'green' ? 'border-[color-mix(in_oklab,var(--color-chip-green-fg)_30%,var(--color-line))]' : 'border-line'">
                  <div class="flex items-center gap-2.5">
                    <span class="grid size-9 flex-none place-items-center rounded-lg bg-canvas-2 font-mono text-[15px] font-semibold" :class="t.installed ? 'text-ink' : 'text-faint'">{{ GLYPH[t.tool] }}</span>
                    <div class="min-w-0">
                      <div class="text-[14px] font-semibold">{{ TOOL_LABEL[t.tool] }}</div>
                      <div class="pill-mono truncate text-[11px] text-faint">{{ t.installed ? t.version || 'installed' : 'not found' }}</div>
                    </div>
                  </div>
                  <div v-if="t.update" class="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px]" data-update-flag>
                    <span class="min-w-0 flex-1 truncate" style="color: var(--color-chip-amber-fg)" :title="`${TOOL_LABEL[t.tool]} ${versionOf(t)} · update available: ${t.update.latest}`">Update available: {{ t.update.latest }}</span>
                    <button type="button" class="btn btn-soft btn-sm flex-none" :title="`Runs ${t.update.cmd} in a terminal row, so you can watch it`" @click="(putSetupAside(), updateTool(t.tool))">Update</button>
                  </div>
                  <span class="chip mt-3 self-start" :style="TONE[stateOf(t).tone]"><span class="size-1.5 rounded-full bg-current"></span>{{ stateOf(t).label }}</span>

                  <div v-if="!t.installed" class="mt-3 text-[12px] leading-relaxed text-muted">
                    {{ INSTALL[t.tool]!.text }}
                    <button v-if="INSTALL[t.tool]!.cmd" type="button" class="mt-2 flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left hover:border-line-strong" title="Copy the install command" @click="copy(INSTALL[t.tool]!.cmd!)">
                      <code class="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-soft">{{ INSTALL[t.tool]!.cmd }}</code><Copy :size="12" class="flex-none text-faint" />
                    </button>
                  </div>
                  <template v-else-if="t.accounts">
                    <div class="mt-3 space-y-1.5">
                      <div v-for="a in accountsFor(t.tool)" :key="a.name" class="flex items-center gap-2 text-[12.5px]">
                        <span class="size-[7px] flex-none rounded-full" :style="{ background: loggedIn(a) ? 'var(--color-chip-green-fg)' : 'var(--color-chip-amber-fg)' }"></span>
                        <span class="min-w-0 flex-1 truncate" :title="a.email || ''"><span class="font-medium">{{ a.name }}</span> <span class="text-faint">{{ loggedIn(a) ? a.email : 'not logged in' }}</span></span>
                        <button type="button" class="flex-none rounded-md p-1 hover:bg-canvas-2" :class="loggedIn(a) ? 'text-faint hover:text-ink' : 'text-[var(--color-brand-600)]'" :title="loggedIn(a) ? 'Log in again' : 'Log in'" :aria-label="`Log in ${a.name}`" @click="login(a)"><LogIn :size="13" /></button>
                      </div>
                    </div>
                    <button type="button" class="mt-auto inline-flex items-center gap-1 pt-3 text-[12px] font-medium text-[var(--color-brand-600)] hover:underline" @click="addAccount"><Plus :size="12" /> Add another account</button>
                  </template>
                  <p v-else class="mt-3 text-[12px] leading-relaxed text-muted">One Google login, kept by agy itself. agy doesn't report it, so sign in inside an agy session.</p>
                </div>
              </div>
            </section>

            <!-- 4. shared skills -->
            <section v-else-if="id === 'skills' && lib" key="skills">
              <p class="col-label text-[var(--color-brand-600)]">Shared skills</p>
              <h2 id="setup-title" class="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.03em]">One skills library for every agent</h2>
              <p class="mt-3 max-w-xl text-[14.5px] leading-relaxed text-muted">Write a skill once and Overvibe gives it to Claude Code, Codex and agy. It lives in <span class="pill-mono">{{ lib.library }}</span>.</p>
              <div class="mt-6 max-h-[230px] space-y-2 overflow-y-auto pr-1">
                <div v-for="s in [...(ef ? [ef] : []), ...librarySkills]" :key="s.name" class="flex items-center gap-4 rounded-xl border border-line bg-canvas px-4 py-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="pill-mono text-[12.5px] font-semibold text-ink">{{ s.name }}</span>
                      <span v-if="s.recommended" class="chip" style="background: var(--color-chip-accent-bg); color: var(--color-chip-accent-fg)">Recommended</span>
                    </div>
                    <p class="mt-0.5 truncate text-[12.5px] text-muted" :title="s.description">{{ s.description }}</p>
                  </div>
                  <div class="flex flex-none gap-1">
                    <span v-for="t in ['claude', 'codex', 'agy']" :key="t" class="rounded-md px-1.5 py-0.5 text-[10.5px] font-medium"
                      :style="!s.tools.includes(t) ? 'opacity: .35' : s.on && linked(s, t) ? 'background: var(--color-chip-accent-bg); color: var(--color-chip-accent-fg)' : 'background: var(--color-chip-gray-bg); color: var(--color-chip-gray-fg)'"
                      :title="!s.tools.includes(t) ? `Not for ${TOOL_LABEL[t]}` : s.on && linked(s, t) ? `Linked into ${TOOL_LABEL[t]}` : `For ${TOOL_LABEL[t]}, not linked now`">{{ TOOL_LABEL[t] }}</span>
                  </div>
                  <button type="button" role="switch" :aria-checked="s.on" :aria-label="`${s.name}: ${s.on ? 'on' : 'off'}`" class="relative h-5 w-9 flex-none rounded-full transition-colors" :class="s.on ? 'bg-[var(--color-brand-600)]' : 'bg-[var(--color-line-strong)]'" :disabled="skillBusy === s.name" @click="toggleSkill(s)">
                    <span class="absolute top-0.5 size-4 rounded-full bg-white shadow transition-all" :class="s.on ? 'left-[18px]' : 'left-0.5'"></span>
                  </button>
                </div>
              </div>
              <div v-for="g in importable" :key="g.tool" class="mt-3 flex items-center gap-3 rounded-xl border border-dashed border-line-strong px-4 py-3">
                <Download :size="16" class="flex-none text-[var(--color-brand-600)]" />
                <p class="min-w-0 flex-1 text-[13px] text-ink-soft">{{ TOOL_LABEL[g.tool] }} has {{ g.names.length }} skill{{ g.names.length === 1 ? '' : 's' }} of its own. Import them so the other agents get them too.</p>
                <button type="button" class="btn btn-ghost btn-sm flex-none" :disabled="!!skillBusy" @click="importAll(g.tool, g.names)"><Spinner v-if="skillBusy === 'import:' + g.tool" :size="13" /> Import {{ g.names.length }}</button>
              </div>
              <p v-if="skillMsg" class="mt-2 text-[12.5px] text-muted">{{ skillMsg }}</p>
            </section>

            <!-- 5. safety -->
            <section v-else-if="id === 'safety'" key="safety">
              <p class="col-label text-[var(--color-brand-600)]">Before you start</p>
              <h2 id="setup-title" class="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.03em]">Agents here can run commands on this computer</h2>
              <div class="mt-6 flex gap-5 rounded-xl border border-line bg-canvas p-5">
                <div class="grid size-11 flex-none place-items-center rounded-xl bg-[var(--color-chip-accent-bg)]"><ShieldCheck :size="22" class="text-[var(--color-chip-accent-fg)]" /></div>
                <SafetyPoints />
              </div>
              <div class="mt-4 flex items-center gap-4 text-[12.5px] text-faint">
                <span class="inline-flex items-center gap-1.5"><FolderLock :size="13" /> 127.0.0.1 only</span>
                <span class="inline-flex items-center gap-1.5"><KeyRound :size="13" /> token on every request</span>
                <a href="https://overvibe.dev/security" target="_blank" rel="noopener noreferrer" class="ml-auto inline-flex items-center gap-1 font-medium text-[var(--color-brand-600)] hover:underline">How Overvibe is secured <ArrowUpRight :size="12" /></a>
              </div>
            </section>

            <!-- 6. done -->
            <section v-else key="done">
              <div class="grid size-11 place-items-center rounded-full bg-[var(--color-chip-green-bg)]"><Check :size="22" :stroke-width="2.5" class="text-[var(--color-chip-green-fg)]" /></div>
              <h2 id="setup-title" class="mt-4 text-[28px] font-semibold leading-tight tracking-[-0.03em]">You're set</h2>
              <p class="mt-2 text-[14.5px] text-muted">
                Projects in <span class="pill-mono">{{ workRoot }}</span>.
                {{ ready.length ? `Ready to run: ${ready.join(', ')}.` : tools.some((t) => t.installed) ? 'No agent is logged in yet: go back to log in.' : 'No agent CLI is installed yet: go back to install Claude Code.' }}
                <template v-if="ef"> ElasticFunnels skill {{ ef.on ? 'on' : 'off' }}.</template>
              </p>
              <div class="mt-7 grid grid-cols-3 gap-3">
                <div class="rounded-xl border border-line bg-canvas p-4">
                  <TerminalSquare :size="17" class="text-faint" />
                  <div class="mt-2.5 text-[13px] font-semibold">The overvibe CLI</div>
                  <p v-if="extras?.cli" class="mt-1 text-[12px] leading-relaxed text-muted">On your PATH as <span class="pill-mono">overvibe</span><template v-if="extras.ovOurs"> and <span class="pill-mono">ov</span></template>.</p>
                  <template v-else>
                    <p class="mt-1 text-[12px] leading-relaxed text-muted">Not on your PATH yet. Agents use it to start and message each other.</p>
                    <button type="button" class="btn btn-ghost btn-sm mt-2.5" :disabled="extraBusy === 'cli'" @click="installCli"><Spinner v-if="extraBusy === 'cli'" :size="12" /> Install</button>
                  </template>
                </div>
                <div v-if="extras?.mac !== false" class="rounded-xl border border-line bg-canvas p-4">
                  <Monitor :size="17" class="text-faint" />
                  <div class="mt-2.5 text-[13px] font-semibold">Desktop app</div>
                  <template v-if="extras?.desktop">
                    <p class="mt-1 text-[12px] leading-relaxed text-muted">Built in ~/Applications, with ⌘ shortcuts of its own.</p>
                    <button type="button" class="btn btn-ghost btn-sm mt-2.5" @click="openDesktop">Open it</button>
                  </template>
                  <p v-else class="mt-1 text-[12px] leading-relaxed text-muted">Optional. Build it with <span class="pill-mono">bun run desktop:build</span> in the repo.</p>
                </div>
                <div class="rounded-xl border border-line bg-canvas p-4">
                  <Command :size="17" class="text-faint" />
                  <div class="mt-2.5 text-[13px] font-semibold">Keys</div>
                  <div class="mt-1.5 space-y-1 text-[12px] text-muted">
                    <div class="flex justify-between"><span>Palette</span><kbd class="pill-mono">{{ IS_MAC_UI ? '⌘K' : 'Ctrl+P' }}</kbd></div>
                    <div class="flex justify-between"><span>New session</span><kbd class="pill-mono">{{ mod }}N</kbd></div>
                    <div class="flex justify-between"><span>Next session</span><kbd class="pill-mono">{{ mod === '⌘' ? 'Ctrl Tab' : alt(']') }}</kbd></div>
                  </div>
                </div>
              </div>
            </section>
          </Transition>
        </div>

        <!-- footer: quiet links left, the one primary action right -->
        <div class="flex items-center gap-2 px-10 pb-7 pt-2">
          <button v-if="at > 0" type="button" class="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-muted hover:text-ink" @click="go(at - 1)"><ArrowLeft :size="14" /> Back</button>
          <span class="flex-1"></span>
          <button v-if="id === 'welcome'" type="button" class="rounded-md px-3 py-1.5 text-[13px] text-muted hover:text-ink" @click="finishSetup">Skip setup</button>
          <button v-else-if="id !== 'done'" type="button" class="rounded-md px-3 py-1.5 text-[13px] text-muted hover:text-ink" @click="skip">Skip <kbd class="ml-1 text-[10.5px] opacity-60">Esc</kbd></button>
          <button v-else type="button" class="rounded-md px-3 py-1.5 text-[13px] text-muted hover:text-ink" @click="finishSetup">Close</button>
          <button type="button" class="btn btn-brand" @click="next">
            <template v-if="id === 'welcome'">Get started</template>
            <template v-else-if="id === 'safety'">Got it</template>
            <template v-else-if="id === 'done'"><Plus :size="15" /> Start your first session</template>
            <template v-else>Continue</template>
            <ArrowRight v-if="id !== 'done'" :size="15" />
            <kbd class="ml-0.5 text-[10.5px] font-medium opacity-70">↵</kbd>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.step-fwd-enter-active, .step-fwd-leave-active, .step-back-enter-active, .step-back-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.step-fwd-enter-from { opacity: 0; transform: translateX(14px); }
.step-fwd-leave-to { opacity: 0; transform: translateX(-14px); }
.step-back-enter-from { opacity: 0; transform: translateX(-14px); }
.step-back-leave-to { opacity: 0; transform: translateX(14px); }
</style>
