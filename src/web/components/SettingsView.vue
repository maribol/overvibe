<script setup lang="ts">
// Accounts (Claude Code and Codex logins; agy has one): log in, keep alive, usage, hide; which account new sessions use
// (default, per project); moving running sessions to another account; project names for folders;
// the sidebar's project order.
import { computed, nextTick, ref, watch } from 'vue'
import { ChevronDown, ChevronUp, EyeOff, GripVertical, LogIn, Plus, RefreshCw, Sparkles } from 'lucide-vue-next'
import Spinner from './Spinner.vue'
import WorkRootField from './WorkRootField.vue'
import { openSetup } from '../setup'
import { promptDialogs, setPromptDialogs } from '../prompt'
import SkillsPanel from './SkillsPanel.vue'
import SettingsNav from './SettingsNav.vue'
import { SETTINGS_GROUPS, isSettingsSection, pageFor } from '../settingsNav'
import { accountsFor, ago, agoText, api, deck, keepTabsWhile, updateTool, versionOf, orderProjects, rulesFor, type Account, type AccountTool, projectOf, pushUrl, refresh, saveProjectOrder, select, settingsAt, shortCwd } from '../deck'

// the second sidebar [T1112-19]: Settings is one page per section [T1112-100]. The nav (or the select on narrow panes)
// switches the page; #/settings/<id> opens one and plain #/settings the first. A switch from the nav is a history
// step, so Back and Forward walk the pages; a link from elsewhere (⌘K, an error's Settings button) lands the same way.
// Every section stays mounted (v-show), so what each one loads and saves is unchanged.
const scroller = ref<HTMLElement | null>(null)
const current = ref(pageFor(settingsAt.section))
// Terminal links [T1112-137]: what links.json holds, read when that page opens
const links = ref<{ file: string; user: { name: string; pattern: string }[]; skipped: { name: string; why: string }[] } | null>(null)
const loadLinks = async () => void (links.value = await api('/api/links').catch(() => links.value))
watch(current, (c) => c === 'links' && loadLinks(), { immediate: true })
function show(id: string) {
  if (current.value === id) return
  current.value = id
  nextTick(() => scroller.value?.scrollTo({ top: 0 }))
}
function go(id: string) {
  if (!isSettingsSection(id)) return
  show(id)
  if (settingsAt.section !== id) {
    settingsAt.section = id
    pushUrl()
  }
}
// a link from elsewhere while Settings is open, or Back/Forward between its pages
watch(() => settingsAt.jump, () => show(pageFor(settingsAt.section)))

const busy = ref<string | null>(null)

// the usage ping, on by default [T1110-72, T1112-101]
const pingOn = ref<boolean | null>(null)
api<{ on: boolean }>('/api/usage-ping').then((r) => (pingOn.value = r.on)).catch(() => {})
async function setPingOn(on: boolean) {
  try {
    pingOn.value = (await api<{ on: boolean }>('/api/usage-ping', { on })).on
  } catch (e: any) {
    msg.value = e.message
  }
}
const msg = ref('')
// spawn limits for sessions that start sessions [T1110-81]
const limits = computed(() => deck.settings.spawnLimits ?? { maxDepth: 3, maxChildren: 8 })
async function saveLimits(next: { maxDepth?: number; maxChildren?: number }) {
  msg.value = ''
  try {
    const r = await api<{ spawnLimits: { maxDepth: number; maxChildren: number } }>('/api/settings', { spawnLimits: { ...limits.value, ...next } })
    deck.settings = { ...deck.settings, spawnLimits: r.spawnLimits }
  } catch (e: any) {
    msg.value = e.message
    deck.settings = { ...deck.settings }
  }
}
// permission mode for new sessions [T1110-85]: the default, and per-folder overrides (deck.json "mode" wins over both)
async function setPermissionMode(m: 'auto' | 'ask') {
  msg.value = ''
  try {
    await api('/api/settings', { permissionMode: m })
    await refresh()
  } catch (e: any) {
    msg.value = e.message
  }
}
const modeOfFolder = (cwd: string) => deck.settings.modeProjects?.[cwd.replace(/^~/, deck.homeAbs)] ?? ''
async function setModeProject(cwd: string, mode: string) {
  await api('/api/settings', { modeProject: { cwd, mode: mode || null } })
  refresh()
}
const idOf = (a: Account) => `${a.tool}:${a.name}`
async function check(a: Account) {
  busy.value = idOf(a)
  try {
    await api(`/api/accounts/${a.name}/probe`, { tool: a.tool })
    await refresh()
  } finally {
    busy.value = null
  }
}
async function login(a: Account) {
  const r = await api<{ tmux: string }>(`/api/accounts/${a.name}/login`, { tool: a.tool })
  await refresh()
  select(r.tmux)
}
// Remove = hide: the account's folder and login stay on disk; adding the same name again brings it back
async function hideAccount(a: Account) {
  if (!confirm(`Hide the ${a.tool === 'codex' ? 'Codex' : 'Claude Code'} account "${a.name}"? Its folder (${a.dir.replace(deck.homeAbs, '~')}) and login stay on disk; add it again with the same name to bring it back.`)) return
  await api('/api/settings', { hideAccount: { name: a.name, tool: a.tool, hidden: true } })
  refresh()
}
const remoteOn = (a: Account) => !(deck.settings.remoteOff ?? []).includes(a.name)
async function setRemote(a: Account, on: boolean) {
  await api('/api/settings', { remoteControl: { name: a.name, on } })
  refresh()
}
async function setSidebar(body: { sidebarAccounts?: boolean; sidebarOrder?: 'project' | 'newest' }) {
  await api('/api/settings', body)
  refresh()
}
async function setTasksView(on: boolean) {
  await api('/api/settings', { tasksView: on })
  refresh()
}
// Pause [T1112-11]: nothing new runs on the account; sessions already on it keep running
async function setPaused(a: Account, paused: boolean) {
  await api('/api/settings', { pauseAccount: { name: a.name, tool: a.tool, paused } })
  refresh()
}
const GROUPS: { tool: AccountTool; label: string }[] = [{ tool: 'claude', label: 'Claude Code' }, { tool: 'codex', label: 'Codex' }]
// the dashboard row per tool: installed (version), how many accounts are logged in, the tightest window now
const TOOL_LABEL = { claude: 'Claude Code', codex: 'Codex', agy: 'agy' } as const
const toolRows = computed(() =>
  (deck.tools.length ? deck.tools : (['claude', 'codex', 'agy'] as const).map((tool) => ({ tool, installed: true, accounts: tool !== 'agy' }) as any)).map((t: any) => {
    const list = t.accounts ? accountsFor(t.tool) : []
    const tops = list.map((a) => Object.values(a.windows ?? {}).map((w) => w.used)).flat()
    return { ...t, label: TOOL_LABEL[t.tool as keyof typeof TOOL_LABEL], total: list.length, loggedIn: list.filter((a) => a.email && !a.error).length, top: tops.length ? Math.max(...tops) : null }
  }),
)
async function setDefault(v: string, tool: AccountTool = 'claude') {
  await api('/api/settings', { defaultAccount: v, tool })
  refresh()
}
async function setChromeAccount(v: string) {
  await api('/api/settings', { chromeAccount: v || null })
  refresh()
}
async function setChromeProject(cwd: string, on: boolean) {
  await api('/api/settings', { chromeProject: { cwd, on } })
  refresh()
}
const chromeOf = (cwd: string) => !!deck.settings.chromeProjects[cwd.replace(/^~/, deck.homeAbs)]
async function setProject(cwd: string, v: string, tool: AccountTool = 'claude') {
  await api('/api/settings', { project: { cwd, account: v }, tool })
  refresh()
}
// project names: a folder's name in the sidebar and in folder search. deck.json's "project" wins over it;
// without either, the folder's git repo (or its own name) names it.
const nameOf = (cwd: string) => deck.settings.projectNames?.[cwd.replace(/^~/, deck.homeAbs)] ?? ''
const nameFolders = computed(() => {
  const seen = new Map<string, { cwd: string; project: string }>()
  for (const s of deck.sessions) if (s.kind === 'claude' && !seen.has(s.cwd)) seen.set(s.cwd, { cwd: s.cwd, project: projectOf(s) })
  for (const [k, v] of Object.entries(deck.settings.projectNames ?? {})) {
    const t = k.replace(deck.homeAbs, '~')
    if (!seen.has(t)) seen.set(t, { cwd: t, project: v })
  }
  return [...seen.values()].sort((a, b) => a.cwd.localeCompare(b.cwd))
})
async function setName(cwd: string, name: string) {
  if (name.trim() === nameOf(cwd)) return
  await api('/api/settings', { projectName: { cwd, name: name.trim() } })
  refresh()
}
const switchTo = ref('')
async function switchAll() {
  if (!switchTo.value) return
  busy.value = 'all'
  msg.value = ''
  try {
    let r = { done: [] as string[], skipped: [] as string[] }
    await keepTabsWhile(async () => {
      const x = await api<{ done: string[]; skipped: string[]; moved?: [string, string][] }>('/api/accounts/switch-all', { account: switchTo.value })
      r = x
      return x.moved ?? []
    })
    msg.value = `Moved ${r.done.length} session(s) to ${switchTo.value}.` + (r.skipped.length ? ` Skipped: ${r.skipped.join('; ')}` : '')
  } catch (e: any) {
    msg.value = e.message
  } finally {
    busy.value = null
  }
}

const label = (k: string) => ({ five_hour: '5-hour', seven_day: 'Week', seven_day_opus: 'Week · Opus', seven_day_sonnet: 'Week · Sonnet' })[k] ?? k.replace(/_/g, ' ')
const tone = (u: number) => (u >= 90 ? 'var(--color-chip-red-fg)' : u >= 70 ? 'var(--color-chip-amber-fg)' : 'var(--color-chip-green-fg)')
const resets = (ms: number | null) => {
  if (!ms) return ''
  const h = (ms - Date.now()) / 3600_000
  return h < 1 ? `resets in ${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `resets in ${Math.round(h)} h` : `resets ${new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`
}

// folders the owner works in, by project, for per-project rules
const folders = computed(() => {
  const seen = new Map<string, { cwd: string; group: string }>()
  for (const s of deck.sessions) {
    if (s.kind !== 'claude' || seen.has(s.cwd)) continue
    seen.set(s.cwd, { cwd: s.cwd, group: projectOf(s) })
  }
  for (const k of [...Object.keys(deck.settings.projects), ...Object.keys(deck.settings.codex?.projects ?? {}), ...Object.keys(deck.settings.modeProjects ?? {})]) {
    const t = k.replace(deck.homeAbs, '~')
    if (!seen.has(t)) seen.set(t, { cwd: t, group: 'Other folders' })
  }
  return [...seen.values()].sort((a, b) => a.group.localeCompare(b.group) || a.cwd.localeCompare(b.cwd))
})
const ruleOf = (cwd: string, tool: AccountTool = 'claude') => rulesFor(tool).projects[cwd.replace(/^~/, deck.homeAbs)] ?? ''
// the sidebar's project order: every project the deck knows, in the saved order
const order = computed(() => orderProjects([...(deck.settings.projectOrder ?? []), ...deck.sessions.map(projectOf)]))
const known = computed(() => new Set(deck.sessions.map(projectOf)))
function move(from: number, to: number) {
  const list = [...order.value]
  if (to < 0 || to >= list.length || from === to) return
  const [n] = list.splice(from, 1)
  list.splice(to, 0, n!)
  saveProjectOrder(list).catch(() => refresh())
}
const dragFrom = ref<number | null>(null)
const dragOver = ref<number | null>(null)
function dropAt(i: number) {
  if (dragFrom.value !== null) move(dragFrom.value, i)
  dragFrom.value = dragOver.value = null
}
const deckSessions = computed(() => deck.sessions.filter((s) => s.where === 'deck' && s.tmux && s.kind === 'claude' && (s.tool ?? 'claude') === 'claude'))
</script>

<template>
  <!-- @container: the nav sits beside the page from 48rem of pane width; narrower panes get a select on top [T1112-19] -->
  <div class="@container flex min-h-0 flex-1">
    <SettingsNav class="hidden @3xl:block" :current="current" @go="go" />
    <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto">
      <div class="sticky top-0 z-10 border-b border-line bg-canvas px-6 py-2 @3xl:hidden">
        <select class="input !py-1.5" aria-label="Settings section" :value="current" @change="go(($event.target as HTMLSelectElement).value)">
          <optgroup v-for="g in SETTINGS_GROUPS" :key="g.label" :label="g.label">
            <option v-for="it in g.items" :key="it.id" :value="it.id">{{ it.label }}</option>
          </optgroup>
        </select>
      </div>
      <div class="mx-auto max-w-4xl px-6 py-6">
        <!-- projects folder (config.json workRoot) and the first-run setup [T1110-67] -->
        <section v-show="current === 'folder'" data-section="folder">
          <div class="flex items-end justify-between gap-4">
            <div>
              <h2 class="text-lg font-semibold">Projects folder</h2>
              <p class="text-[13px] text-muted">New session and the palette search folders under this one, and Codex sessions may write to it. Saved in ~/.config/overvibe/config.json as workRoot.</p>
            </div>
            <button class="btn btn-ghost btn-sm flex-none" title="Welcome, projects folder, agents and logins, safety" @click="openSetup()"><Sparkles :size="14" /> Open setup</button>
          </div>
          <div class="card mt-3 p-4"><WorkRootField /></div>
        </section>

        <!-- accounts -->
        <section v-show="current === 'accounts'" data-section="accounts">
          <div class="flex items-end justify-between">
            <div>
              <h2 class="text-lg font-semibold">Accounts</h2>
              <p class="text-[13px] text-muted">Each account is its own login, kept alive with a free check every 3 hours, so none expires from sitting unused. agy has one login of its own, so it has no accounts here. A paused account takes no new, resumed or switched sessions; folder rules and the default skip to another account, and sessions already running on it keep running.</p>
            </div>
            <button class="btn btn-brand btn-sm" @click="deck.addAccountOpen = true"><Plus :size="15" /> Add account</button>
          </div>
          <div class="card mt-4 overflow-hidden">
            <div class="flex border-b border-line px-4 py-2"><span class="col-label w-32">Tool</span><span class="col-label flex-1">Installed</span><span class="col-label w-40">Logged in</span><span class="col-label w-32 text-right">Highest use now</span></div>
            <div v-for="t in toolRows" :key="t.tool" class="flex items-center border-b border-line px-4 py-2 text-[13px] last:border-0">
              <span class="w-32 font-medium">{{ t.label }}</span>
              <span v-if="t.update" class="flex min-w-0 flex-1 items-center gap-2" data-update-flag>
                <span class="min-w-0 truncate text-muted">{{ versionOf(t) }} · <span class="font-medium" style="color: var(--color-chip-amber-fg)">update available: {{ t.update.latest }}</span></span>
                <button class="btn btn-soft btn-sm flex-none" :title="`Runs ${t.update.cmd} in a terminal row, so you can watch it`" @click="updateTool(t.tool)">Update</button>
              </span>
              <span v-else class="min-w-0 flex-1 truncate" :class="t.installed ? 'text-muted' : 'text-[var(--color-chip-red-fg)]'">{{ t.installed ? t.version || 'yes' : 'not installed' }}</span>
              <span class="w-40 text-muted" :title="t.note || ''">{{ t.accounts ? `${t.loggedIn} of ${t.total} account${t.total === 1 ? '' : 's'}` : 'one login · not reported' }}</span>
              <span class="w-32 text-right tabular-nums" :style="t.top != null ? { color: tone(t.top) } : {}" :class="t.top == null ? 'text-faint' : ''">{{ t.top != null ? Math.round(t.top) + '%' : 'not available' }}</span>
            </div>
          </div>
          <template v-for="g in GROUPS" :key="g.tool">
          <h3 v-if="accountsFor(g.tool).length" class="col-label mt-4">{{ g.label }}</h3>
          <div class="mt-2 grid gap-3 md:grid-cols-2">
            <div v-for="a in accountsFor(g.tool)" :key="idOf(a)" class="card p-4">
              <div class="flex items-start gap-3">
                <span class="grid size-9 flex-none place-items-center rounded-lg bg-canvas-2 text-[13px] font-semibold uppercase">{{ a.name.charAt(0) }}</span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-semibold">{{ a.name }}</span>
                    <span v-if="a.plan" class="chip" style="background: var(--color-chip-violet-bg); color: var(--color-chip-violet-fg)">{{ a.plan }}</span>
                    <span v-if="a.paused" class="chip" style="background: var(--color-chip-amber-bg); color: var(--color-chip-amber-fg)">paused</span>
                  </div>
                  <div class="truncate text-[12.5px] text-muted">{{ a.email || (a.error || a.checkedAt ? 'Not logged in' : 'Checking…') }}</div>
                  <div class="pill-mono truncate text-faint">{{ a.dir.replace(deck.homeAbs, '~') }}</div>
                  <label v-if="a.tool !== 'codex'" class="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-ink-soft" title="Start new sessions on this account with Claude Code's Remote Control (open them from claude.ai or the phone app)">
                    <input type="checkbox" :checked="remoteOn(a)" @change="setRemote(a, ($event.target as HTMLInputElement).checked)" /> Remote Control for new sessions
                  </label>
                  <label class="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-ink-soft" title="New, resumed and switched sessions never run on a paused account. Sessions already running on it keep running.">
                    <input type="checkbox" :checked="!!a.paused" @change="setPaused(a, ($event.target as HTMLInputElement).checked)" /> Paused
                  </label>
                </div>
                <button class="btn btn-ghost btn-sm" title="Free check: reads usage and refreshes the login" :disabled="busy === idOf(a)" @click="check(a)">
                  <Spinner v-if="busy === idOf(a)" :size="13" /><RefreshCw v-else :size="13" />
                </button>
                <button class="btn btn-ghost btn-sm" title="Log in (again)" @click="login(a)"><LogIn :size="13" /> Log in</button>
                <button v-if="a.name !== 'default'" class="btn btn-ghost btn-sm !px-1.5" title="Hide this account (its folder and login stay on disk)" @click="hideAccount(a)"><EyeOff :size="13" /></button>
              </div>
              <div v-for="(w, k) in a.windows" :key="k" class="mt-3">
                <div class="flex justify-between text-[12px]"><span class="text-ink-soft">{{ label(String(k)) }}</span><span class="tabular-nums text-muted">{{ Math.round(w.used) }}% · {{ resets(w.resetsAt) }}</span></div>
                <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-canvas-2"><div class="h-full rounded-full" :style="{ width: Math.min(100, w.used) + '%', background: tone(w.used) }"></div></div>
              </div>
              <div v-if="!a.windows || !Object.keys(a.windows).length" class="mt-3 text-[12px] text-faint">Usage: not available{{ a.email ? ' (the CLI reported none)' : '' }}</div>
              <div class="mt-3 text-[11.5px] text-faint">
                <span v-if="a.error && !a.email" class="text-[var(--color-chip-red-fg)]">{{ a.error }} · </span>
                {{ a.checkedAt ? `checked ${agoText(a.checkedAt)}` : 'not checked yet' }}
              </div>
            </div>
          </div>
          </template>
        </section>

        <!-- routing -->
        <section v-show="current === 'routing'" data-section="routing">
          <h2 class="text-lg font-semibold">Which account new sessions use</h2>
          <div class="card mt-3 p-4">
            <div class="flex flex-wrap items-center gap-3">
              <span class="w-44 text-[13.5px] font-medium">Claude Code default</span>
              <select class="input !w-56 !py-1.5" :value="deck.settings.defaultAccount" @change="setDefault(($event.target as HTMLSelectElement).value)">
                <option value="auto">{{ deck.router ? 'No fixed account (local router)' : 'No fixed account (~/.claude)' }}</option>
                <option v-for="a in accountsFor('claude')" :key="a.name" :value="a.name">{{ a.name }}</option>
              </select>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-3">
              <span class="w-44 text-[13.5px] font-medium">Codex default</span>
              <select class="input !w-56 !py-1.5" :value="rulesFor('codex').defaultAccount" @change="setDefault(($event.target as HTMLSelectElement).value, 'codex')">
                <option value="auto">No fixed account (~/.codex)</option>
                <option v-for="a in accountsFor('codex')" :key="a.name" :value="a.name">{{ a.name }}</option>
              </select>
            </div>
            <p class="mt-3 text-[12.5px] text-muted">New sessions use the folder's account below, else this default, each tool its own. Picking an account when you start or move a session always wins. agy has one login.<span v-if="deck.router"> A local router file (~/.config/overvibe/router.ts) is loaded and chooses the Claude account when you don't pick one.</span></p>
          </div>

          <div class="card mt-3 p-4">
            <div class="flex flex-wrap items-center gap-3">
              <span class="text-[13.5px] font-medium">Claude in Chrome is signed in to</span>
              <select class="input !w-56 !py-1.5" :value="deck.settings.chromeAccount ?? ''" @change="setChromeAccount(($event.target as HTMLSelectElement).value)">
                <option value="">not set</option>
                <option v-for="a in accountsFor('claude')" :key="a.name" :value="a.name">{{ a.name }}{{ a.email ? ' · ' + a.email : '' }}</option>
              </select>
            </div>
            <p class="mt-2 text-[12.5px] text-muted">The Chrome extension only works with sessions on the account it is signed in to. Sessions in folders marked "Chrome" below (or with <code class="pill-mono">"chrome": true</code> in their deck.json) start on that account unless you pick another one.</p>
          </div>

          <div class="card mt-3 overflow-hidden">
            <div class="flex border-b border-line px-4 py-2.5"><span class="col-label flex-1">Per project folder</span><span class="col-label w-16 text-center">Chrome</span><span class="col-label w-40 pl-1">Claude account</span><span class="col-label w-40 pl-1">Codex account</span></div>
            <div v-for="f in folders" :key="f.cwd" class="flex items-center gap-3 border-b border-line px-4 py-2 last:border-0">
              <span class="w-36 truncate text-[12px] font-semibold uppercase tracking-wide text-faint">{{ f.group }}</span>
              <span class="pill-mono min-w-0 flex-1 truncate">{{ shortCwd(f.cwd) }}</span>
              <span class="flex w-16 justify-center"><input type="checkbox" :checked="chromeOf(f.cwd)" title="Sessions here use Claude in Chrome" @change="setChromeProject(f.cwd, ($event.target as HTMLInputElement).checked)" /></span>
              <select class="input !w-40 !py-1 !text-[13px]" :value="ruleOf(f.cwd)" @change="setProject(f.cwd, ($event.target as HTMLSelectElement).value)">
                <option value="">Default ({{ deck.settings.defaultAccount }})</option>
                <option value="auto">{{ deck.router ? 'Local router' : 'No fixed account' }}</option>
                <option v-for="a in accountsFor('claude')" :key="a.name" :value="a.name">{{ a.name }}</option>
              </select>
              <select class="input !w-40 !py-1 !text-[13px]" :value="ruleOf(f.cwd, 'codex')" @change="setProject(f.cwd, ($event.target as HTMLSelectElement).value, 'codex')">
                <option value="">Default ({{ rulesFor('codex').defaultAccount }})</option>
                <option value="auto">No fixed account</option>
                <option v-for="a in accountsFor('codex')" :key="a.name" :value="a.name">{{ a.name }}</option>
              </select>
            </div>
          </div>
        </section>

        <!-- move running sessions -->
        <section v-show="current === 'running'" data-section="running">
          <h2 class="text-lg font-semibold">Running sessions</h2>
          <p class="text-[13px] text-muted">Switching restarts a session on the other account with the same conversation. Sessions that are working are skipped until they are idle. Switch one session from its terminal header.</p>
          <div class="card mt-3 flex flex-wrap items-center gap-3 p-4">
            <span class="text-[13.5px]">Move all {{ deckSessions.length }} Claude deck session(s) to</span>
            <select v-model="switchTo" class="input !w-48 !py-1.5">
              <option value="" disabled>account…</option>
              <option v-for="a in accountsFor('claude')" :key="a.name" :value="a.name">{{ a.name }}</option>
            </select>
            <button class="btn btn-primary btn-sm" :disabled="!switchTo || busy === 'all'" @click="switchAll"><Spinner v-if="busy === 'all'" :size="13" /> Switch</button>
            <p v-if="msg" class="w-full text-[12.5px] text-muted">{{ msg }}</p>
          </div>
        </section>

        <!-- permission mode [T1110-85]; the default as one plain switch, off on a new install [T1112-99] -->
        <section v-show="current === 'permissions'" data-section="permissions">
          <h2 class="text-lg font-semibold">Auto mode</h2>
          <p class="text-[13px] text-muted">How new sessions start. You can still choose per session.</p>
          <div class="card mt-3 p-4 text-[13.5px]">
            <label class="flex cursor-pointer items-start gap-3">
              <input type="checkbox" class="mt-0.5 flex-none" :checked="deck.settings.permissionMode === 'auto'" @change="setPermissionMode(($event.target as HTMLInputElement).checked ? 'auto' : 'ask')" />
              <span class="min-w-0">
                <span class="font-medium">Start new sessions in auto mode</span>
                <span class="ml-2 rounded-md px-1.5 py-0.5 text-[11.5px]" :class="deck.settings.permissionMode === 'auto' ? 'border border-line text-ink-soft' : 'bg-[var(--color-chip-green-bg)] text-[var(--color-chip-green-fg)]'">{{ deck.settings.permissionMode === 'auto' ? 'on' : 'off' }}</span>
                <span class="mt-1 block text-[12.5px] text-muted">Off: each tool asks before commands and edits, and Overvibe shows the question. Helpers never get more than the session that started them.</span>
              </span>
            </label>
          </div>
          <div v-if="folders.length" class="card mt-3 overflow-hidden">
            <div class="flex border-b border-line px-4 py-2.5"><span class="col-label flex-1">Per project folder</span><span class="col-label w-40 pl-1">Mode</span></div>
            <div v-for="f in folders" :key="f.cwd" class="flex items-center gap-3 border-b border-line px-4 py-2 last:border-0">
              <span class="w-36 truncate text-[12px] font-semibold uppercase tracking-wide text-faint">{{ f.group }}</span>
              <span class="pill-mono min-w-0 flex-1 truncate">{{ shortCwd(f.cwd) }}</span>
              <select class="input !w-40 !py-1 !text-[13px]" :value="modeOfFolder(f.cwd)" @change="setModeProject(f.cwd, ($event.target as HTMLSelectElement).value)">
                <option value="">Default ({{ deck.settings.permissionMode === 'auto' ? 'auto' : 'ask' }})</option>
                <option value="auto">Auto</option>
                <option value="ask">Ask (auto off)</option>
              </select>
            </div>
          </div>
        </section>

        <!-- questions: dialogs over the terminal, off by default [T1111-23] -->
        <section v-show="current === 'questions'" data-section="questions">
          <h2 class="text-lg font-semibold">Questions</h2>
          <p class="text-[13px] text-muted">When a session asks you something or waits for a permission, it turns yellow in the sidebar and you answer in its terminal.</p>
          <label class="card mt-3 flex cursor-pointer items-start gap-3 p-4">
            <input type="checkbox" class="mt-0.5 flex-none" :checked="promptDialogs" @change="setPromptDialogs(($event.target as HTMLInputElement).checked)" />
            <span class="text-[13.5px] leading-relaxed">
              <span class="font-medium">Show choice menus as a dialog</span>
              <span class="text-muted"> over the terminal, with a bar to reopen it, and pop up questions from other sessions. Saved in this browser.</span>
            </span>
          </label>
        </section>

        <!-- the sidebar: usage bars, and projects or newest at the top [T1112-138] -->
        <section v-show="current === 'sidebar'" data-section="sidebar">
          <h2 class="text-lg font-semibold">Sidebar</h2>
          <p class="text-[13px] text-muted">How the list of sessions on the left looks.</p>
          <label class="card mt-3 flex cursor-pointer items-start gap-3 p-4">
            <input type="checkbox" class="mt-0.5 flex-none" :checked="deck.settings.sidebarAccounts !== false" data-sidebar-accounts @change="setSidebar({ sidebarAccounts: ($event.target as HTMLInputElement).checked })" />
            <span class="text-[13.5px] leading-relaxed">
              <span class="font-medium">Show account usage bars</span>
              <span class="text-muted"> under Accounts &amp; settings: each account's limit used, with its reset on hover. Settings > Accounts shows them either way.</span>
            </span>
          </label>
          <div class="card mt-3 p-4">
            <div class="text-[13.5px] font-medium">Order</div>
            <label class="mt-2 flex cursor-pointer items-start gap-3 text-[13.5px] leading-relaxed">
              <input type="radio" name="sidebar-order" class="mt-1 flex-none" value="project" :checked="deck.settings.sidebarOrder !== 'newest'" @change="setSidebar({ sidebarOrder: 'project' })" />
              <span><span class="font-medium">By project</span><span class="text-muted">, in your project order (drag a project's name to move it).</span></span>
            </label>
            <label class="mt-2 flex cursor-pointer items-start gap-3 text-[13.5px] leading-relaxed">
              <input type="radio" name="sidebar-order" class="mt-1 flex-none" value="newest" data-sidebar-newest :checked="deck.settings.sidebarOrder === 'newest'" @change="setSidebar({ sidebarOrder: 'newest' })" />
              <span><span class="font-medium">Newest at the top</span><span class="text-muted">, one list with each session's project beside it. A session takes its place when it starts and stays there; working or waiting never moves it.</span></span>
            </label>
          </div>
        </section>

        <!-- the Tasks view on or off [T1112-16] -->
        <section v-show="current === 'tasks'" data-section="tasks">
          <h2 class="text-lg font-semibold">Tasks</h2>
          <p class="text-[13px] text-muted">The Tasks view reads each project's TASKS.md and lists what is open and what waits on you. Agents keep it through the tasks skill (on or off under Skills) or their own instructions.</p>
          <label class="card mt-3 flex cursor-pointer items-start gap-3 p-4">
            <input type="checkbox" class="mt-0.5 flex-none" :checked="deck.settings.tasksView !== false" @change="setTasksView(($event.target as HTMLInputElement).checked)" />
            <span class="text-[13.5px] leading-relaxed">
              <span class="font-medium">Show the Tasks view</span>
              <span class="text-muted"> and its count in the sidebar. While it is off, Overvibe reads no TASKS.md files.</span>
            </span>
          </label>
        </section>

        <!-- terminal links [T1112-137]: the built-in kinds, and the user's own from links.json -->
        <section v-show="current === 'links'" data-section="links">
          <h2 class="text-lg font-semibold">Terminal links</h2>
          <p class="text-[13px] text-muted">Overvibe underlines web addresses (also without https://, and local servers like localhost:5173), file paths and file names, a suggested /compact, Reddit's r/ and u/ names, npm packages (@scope/name and the names after npm i or bun add), GitHub references (owner/repo#12; "PR #12" when the folder's remote is on GitHub), commit shas the folder's repo has, and task ids like T1112-3. Right-click one to see where it goes; hover it for a card. Hovering never loads the page.</p>
          <div class="card mt-3 p-4 text-[13px] leading-relaxed">
            <div class="font-medium">Your own links</div>
            <p class="text-muted">Add entries to <span class="pill-mono select-text">{{ links?.file ?? '~/.config/overvibe/links.json' }}</span>. Each has a name, a regular expression and a URL where $0 is the match and $1 to $9 its groups; a label for the right-click menu is optional. Open terminals pick up changes when they reopen or the page reloads.</p>
            <pre class="mt-2 overflow-x-auto rounded-md bg-canvas-2 px-3 py-2 font-mono text-[12px]">[
  { "name": "Jira", "pattern": "\\b[A-Z]{2,6}-\\d{1,6}\\b",
    "url": "https://acme.atlassian.net/browse/$0", "label": "Open $0 in Jira" }
]</pre>
            <p class="mt-2 text-[12.5px] text-faint">URLs must start with http:// or https://. A pattern that does not compile, can run for a very long time (like (a+)+) or matches empty text is skipped and the reason shows below; one that takes over 25 ms on a line is turned off until the page reloads.</p>
            <div v-if="links" class="mt-3 text-[12.5px]">
              <div v-if="!links.user.length && !links.skipped.length" class="text-faint">No entries yet.</div>
              <div v-for="u in links.user" :key="u.name" class="flex gap-2"><span class="text-[var(--color-chip-green-fg)]">On</span><span class="font-medium">{{ u.name }}</span><span class="pill-mono truncate text-faint">{{ u.pattern }}</span></div>
              <div v-for="u in links.skipped" :key="'s' + u.name" class="flex gap-2"><span class="text-[var(--color-chip-red-fg)]">Skipped</span><span class="font-medium">{{ u.name }}</span><span class="text-faint">{{ u.why }}</span></div>
            </div>
            <button class="btn btn-ghost btn-sm mt-2" @click="loadLinks">Check the file again</button>
          </div>
        </section>

        <SkillsPanel v-show="current === 'skills'" data-section="skills" />

        <!-- spawn limits [T1110-81] -->
        <section v-show="current === 'limits'" data-section="limits">
          <h2 class="text-lg font-semibold">Spawn limits</h2>
          <p class="text-[13px] text-muted">Caps on sessions that start other sessions with overvibe new. Sessions you start yourself are never capped.</p>
          <div class="card mt-3 grid gap-3 p-4 text-[13.5px] sm:grid-cols-2">
            <label class="flex items-center justify-between gap-3">
              <span><span class="font-medium">Nesting depth</span><span class="text-muted"> (helpers of helpers)</span></span>
              <input type="number" min="1" max="10" class="input !w-20 !py-1.5" :value="limits.maxDepth" @change="saveLimits({ maxDepth: +($event.target as HTMLInputElement).value })" />
            </label>
            <label class="flex items-center justify-between gap-3">
              <span><span class="font-medium">Children per session</span><span class="text-muted"> (running at once)</span></span>
              <input type="number" min="1" max="50" class="input !w-20 !py-1.5" :value="limits.maxChildren" @change="saveLimits({ maxChildren: +($event.target as HTMLInputElement).value })" />
            </label>
          </div>
        </section>

        <!-- project names -->
        <section v-show="current === 'names'" data-section="names">
          <h2 class="text-lg font-semibold">Project names</h2>
          <p class="text-[13px] text-muted">Name a folder's project. The name covers its subfolders, groups the sidebar and finds the folder in New session. Leave it empty to use the repo's folder name. A <code class="pill-mono">"project"</code> in the folder's deck.json wins over this.</p>
          <div class="card mt-3 overflow-hidden">
            <div v-for="f in nameFolders" :key="f.cwd" class="flex items-center gap-3 border-b border-line px-4 py-1.5 last:border-0">
              <span class="pill-mono min-w-0 flex-1 truncate">{{ shortCwd(f.cwd) }}</span>
              <input class="input !w-56 !py-1 !text-[13px]" :value="nameOf(f.cwd)" :placeholder="f.project" @change="setName(f.cwd, ($event.target as HTMLInputElement).value)" @keydown.enter="($event.target as HTMLInputElement).blur()" />
            </div>
            <div v-if="!nameFolders.length" class="px-4 py-3 text-[13px] text-faint">No folders yet.</div>
          </div>
        </section>

        <!-- project order -->
        <section v-show="current === 'order'" data-section="order">
          <h2 class="text-lg font-semibold">Project order</h2>
          <p class="text-[13px] text-muted">The sidebar always lists projects in this order. Drag a row, or use the arrows. A new project goes to the bottom the first time it shows up.</p>
          <div class="card mt-3 overflow-hidden">
            <div v-for="(n, i) in order" :key="n"
              class="flex items-center gap-2 border-b border-line px-3 py-1.5 last:border-0"
              :class="[dragOver === i && dragFrom !== i ? 'bg-[var(--color-brand-500)]/15' : '', dragFrom === i ? 'opacity-50' : '']"
              draggable="true"
              @dragstart="dragFrom = i; $event.dataTransfer?.setData('text/plain', n)"
              @dragend="dragFrom = dragOver = null"
              @dragover.prevent="dragFrom !== null && (dragOver = i)"
              @drop.prevent="dropAt(i)">
              <GripVertical :size="14" class="flex-none cursor-grab text-faint" />
              <span class="w-6 flex-none text-right text-[11px] tabular-nums text-faint">{{ i + 1 }}</span>
              <span class="min-w-0 flex-1 truncate text-[13px] font-semibold uppercase tracking-wide" :class="known.has(n) ? 'text-ink-soft' : 'text-faint'" :title="known.has(n) ? '' : 'No sessions right now'">{{ n }}</span>
              <button class="btn btn-ghost btn-sm !px-1.5" title="Move up" :disabled="i === 0" @click="move(i, i - 1)"><ChevronUp :size="14" /></button>
              <button class="btn btn-ghost btn-sm !px-1.5" title="Move down" :disabled="i === order.length - 1" @click="move(i, i + 1)"><ChevronDown :size="14" /></button>
            </div>
            <div v-if="!order.length" class="px-4 py-3 text-[13px] text-faint">No projects yet.</div>
          </div>
        </section>

        <!-- the usage ping, on by default [T1110-72, T1112-101] -->
        <section v-show="current === 'usage'" data-section="usage">
          <h2 class="text-lg font-semibold">Usage ping</h2>
          <label v-if="pingOn !== null" class="card mt-3 flex cursor-pointer items-start gap-3 p-4">
            <input type="checkbox" class="mt-0.5 flex-none" :checked="pingOn" @change="setPingOn(($event.target as HTMLInputElement).checked)" />
            <span class="text-[13.5px] leading-relaxed">
              <span class="font-medium">Send an anonymous usage ping, on by default</span>
              <span class="block text-muted">Once a day: a random install id, the Overvibe version, the OS and its version, and which of Claude Code, Codex and agy are installed.</span>
            </span>
          </label>
        </section>
      </div>
    </div>
  </div>
</template>
