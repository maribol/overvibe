<script setup lang="ts">
// New session (⌥N). Folders you have used, most recent first, with the current session's folder on
// top and picked. Type to autocomplete any folder under the work root (default ~/Work, so it is left
// out: "shop" finds shop, shop-cli, …). ↑↓ to choose, Enter to start.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Folder, FolderGit2, FolderPlus, X } from 'lucide-vue-next'
import SettingsLink from './SettingsLink.vue'
import { accountsFor, ago, api, autoLabel, refresh, current, deck, projectOf, shortCwd, startSession, startShell, workRoot, type NewTool, type PermissionMode } from '../deck'

const start0 = deck.newCwd || current.value?.cwd || ''
const q = ref('')
const picked = ref(start0)
const account = ref('auto')
const name = ref('')
const prompt = ref('')
const chrome = ref(false)
// permission mode [T1110-85]: follows the picked folder's rule (deck.json "mode", Settings) until the owner flips it
const mode = ref<PermissionMode>(deck.settings.permissionMode ?? 'ask')
const modeFrom = ref('default')
const modeTouched = ref(false)
watch(
  () => picked.value,
  async (cwd) => {
    if (!cwd || modeTouched.value) return
    try {
      const r = await api<{ mode: PermissionMode; modeFrom: string }>('/api/rule', { cwd })
      if (picked.value === cwd && !modeTouched.value) (mode.value = r.mode), (modeFrom.value = r.modeFrom)
    } catch {}
  },
  { immediate: true },
)
// another live agent in this checkout [T1111-10]: say so, and offer the session its own git worktree
const sharing = ref<string[]>([])
const repoHere = ref(false)
const worktree = ref(false)
watch(
  () => picked.value,
  async (cwd) => {
    sharing.value = []
    repoHere.value = false
    worktree.value = false
    if (!cwd) return
    try {
      const r = await api<{ sharing?: string[]; repo?: boolean }>('/api/rule', { cwd, sharing: true })
      if (picked.value === cwd) (sharing.value = r.sharing ?? []), (repoHere.value = !!r.repo)
    } catch {}
  },
  { immediate: true },
)
const setMode = (m: PermissionMode) => ((mode.value = m), (modeTouched.value = true))
const MODE_NOTE: Record<PermissionMode, string> = {
  auto: 'Runs commands and edits files without stopping to ask, with the tool’s own safety checks.',
  ask: 'The tool asks before commands and edits; the session turns yellow in the sidebar and you allow or refuse in its terminal.',
}
const launchNote = computed(() => {
  const a = mode.value === 'ask'
  // Remote Control is set per Claude account (Settings > Accounts)
  const rc = account.value === 'auto' ? ' · Remote Control as the account is set' : (deck.settings.remoteOff ?? []).includes(account.value) ? '' : ' · Remote Control'
  if (tool.value === 'claude') return (a ? 'ask mode (--permission-mode manual)' : 'auto mode') + rc
  if (tool.value === 'codex') return a ? 'codex -a on-request -s workspace-write (stock sandbox)' : 'codex --approve-for-me · network on, work root writable'
  if (tool.value === 'agy') return a ? 'agy default mode (asks) · Remote Control' : 'agy --mode auto · Remote Control'
  return 'plain login shell, no agent'
})
async function setChromeAccount(v: string) {
  if (!v) return
  await api('/api/settings', { chromeAccount: v })
  await refresh()
}
// Terminal is a plain login shell (the ⌥T shell, with a name) [T1110-54]; it is not remembered as the
// next default, so ⌥N keeps opening on the last agent
const tool = ref<NewTool>(deck.newTool || (localStorage.getItem('deck.tool') as any) || 'claude')
watch(tool, (t) => t !== 'shell' && localStorage.setItem('deck.tool', t))
// a Codex session only offers Codex accounts; a name picked for the other tool goes back to auto
watch(tool, (t) => {
  if (account.value !== 'auto' && !accountsFor(t).some((a) => a.name === account.value && !a.paused)) account.value = 'auto'
})
const TOOL_LABEL: Record<NewTool, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'agy', shell: 'Terminal' }
const err = ref('')
const busy = ref(false)
const found = ref<{ cwd: string; repo: boolean; project?: string }[]>([])
const input = ref<HTMLInputElement>()
// what the server makes of a typed path: an existing folder, one it can create, or why it can't [T1110-6]
const typed = ref<{ cwd: string; exists: boolean; error?: string } | null>(null)

const groupOf = (cwd: string) => {
  const s = deck.sessions.find((x) => x.cwd === cwd)
  return s ? projectOf(s) : ''
}

// every folder with a session, by last use; the starting folder first
const folders = computed(() => {
  const last = new Map<string, number>()
  for (const s of deck.sessions) if (s.kind === 'claude') last.set(s.cwd, Math.max(last.get(s.cwd) ?? 0, s.last))
  const list = [...last.entries()].sort((a, b) => b[1] - a[1]).map(([cwd, at]) => ({ cwd, at, group: groupOf(cwd) }))
  const i = list.findIndex((f) => f.cwd === start0)
  if (i > 0) list.unshift(...list.splice(i, 1))
  else if (i < 0 && start0) list.unshift({ cwd: start0, at: 0, group: groupOf(start0) })
  // a new install has no folder with a session yet: offer the projects folder itself, so the first session can start
  if (!list.length && workRoot.value) list.push({ cwd: workRoot.value, at: 0, group: '' })
  return list
})
// recent folders that match, then everything else under the work root that matches
// ⌥N leaves a "˜" behind (Option+N is the ñ dead key on a Mac); never let it into the search
watch(q, (v) => {
  const c = v.replace(/[\u02dc\u0303]/g, '')
  if (c !== v) q.value = c
})
const shown = computed(() => {
  const n = q.value.trim().toLowerCase().replace(/^~\/work\/?/, '')
  if (!n) return folders.value
  const recent = folders.value.filter((f) => `${shortCwd(f.cwd)} ${f.group}`.toLowerCase().includes(n))
  const have = new Set(recent.map((f) => f.cwd))
  return [...recent, ...found.value.filter((f) => !have.has(f.cwd)).map((f) => ({ cwd: f.cwd, at: 0, group: f.project ?? groupOf(f.cwd) }))]
})
let t: ReturnType<typeof setTimeout>
watch(q, (v) => {
  clearTimeout(t)
  if (!v.trim()) return (found.value = [], typed.value = null)
  t = setTimeout(async () => {
    try {
      const r = await api<{ root: string; folders: { rel: string; cwd?: string; repo: boolean; project?: string }[]; typed: typeof typed.value }>(`/api/folders?q=${encodeURIComponent(v)}`)
      if (q.value !== v) return
      found.value = r.folders.map((f) => ({ cwd: f.cwd ?? `${r.root}/${f.rel}`, repo: f.repo, project: f.project }))
      typed.value = r.typed
    } catch {}
  }, 120)
})
// typed something that looks like a path ("~/x", "/x", "projects/x" under the work root): offer it as
// is, or offer to create it; the folder is made only when the session starts
const typedPath = computed(() => (typed.value && !typed.value.error ? typed.value.cwd : ''))
const creating = computed(() => !!typedPath.value && !typed.value!.exists)
const extra = computed(() => (typedPath.value && !shown.value.some((f) => f.cwd === typedPath.value) ? typedPath.value : ''))
// every row the arrows move through: the matches, then the typed path
const rows = computed(() => [...shown.value.map((f) => f.cwd), ...(extra.value ? [extra.value] : [])])

watch(
  rows,
  (l) => {
    if (!l.includes(picked.value)) picked.value = l[0] ?? ''
  },
  { immediate: true },
)

function onKey(e: KeyboardEvent) {
  const l = rows.value.map((cwd) => ({ cwd }))
  const i = l.findIndex((f) => f.cwd === picked.value)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    picked.value = l[Math.min(l.length - 1, i + 1)]?.cwd ?? picked.value
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    picked.value = l[Math.max(0, i - 1)]?.cwd ?? picked.value
  } else if (e.key === 'Escape') deck.newOpen = false
  nextTick(() => document.querySelector('[data-picked="1"]')?.scrollIntoView({ block: 'nearest' }))
}


async function start() {
  const cwd = picked.value
  if (!cwd) return (err.value = 'Pick a folder')
  busy.value = true
  err.value = ''
  try {
    const mkdir = creating.value && cwd === typedPath.value ? true : undefined
    if (tool.value === 'shell') await startShell(cwd, prompt.value.trim() || undefined, name.value.trim() || undefined, mkdir)
    else await startSession({ tool: tool.value, cwd, account: account.value, name: name.value, prompt: prompt.value, chrome: chrome.value || undefined, mkdir, mode: mode.value, worktree: (repoHere.value && worktree.value) || undefined })
    deck.newOpen = false
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
// read the box on every input event, even mid-accent (v-model waits for an accent to finish)
const onInput = (e: Event) => (q.value = (e.target as HTMLInputElement).value.replace(/[\u02dc\u0303]/g, ''))
const openedAt = Date.now()
onMounted(() => input.value?.focus())
// ⌥N is a Mac accent key: the box can open with a "˜" accent pending, and while it is pending the
// page never sees what is typed. Cancel it (blur and refocus) and drop the "˜".
function onCompose() {
  if (Date.now() - openedAt > 1500) return // a real accent typed later on purpose
  const el = input.value
  if (!el) return
  el.blur()
  setTimeout(() => {
    el.value = el.value.replace(/[\u02dc\u0303~]/g, '')
    q.value = el.value
    el.focus()
  }, 0)
}
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-start justify-center overflow-y-auto backdrop p-4 pt-[8vh]" @mousedown.self="deck.newOpen = false">
    <form class="dialog w-full max-w-xl p-5" @submit.prevent="start" @keydown.esc="deck.newOpen = false">
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-bold tracking-[-0.03em]">New session</h3>
        <span class="flex items-center gap-2 text-[11.5px] text-faint">↑↓ pick · Enter start · Esc close
          <button type="button" class="rounded-md p-1 hover:bg-canvas-2 hover:text-ink" @click="deck.newOpen = false"><X :size="17" /></button>
        </span>
      </div>

      <input ref="input" :value="q" class="input mt-3" @input="onInput" @compositionstart="onCompose" @compositionend="onInput" placeholder="Project or folder, e.g. my-app" autocomplete="off" @keydown="onKey" />

      <div class="mt-2 max-h-[300px] overflow-y-auto rounded-lg hair bg-canvas">
        <button
          v-for="f in shown" :key="f.cwd" type="button" :data-picked="f.cwd === picked ? '1' : undefined"
          class="flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left last:border-0"
          :class="f.cwd === picked ? 'bg-[var(--color-row-sel)] shadow-[inset_2px_0_0_var(--color-brand-500)]' : 'hover:bg-[var(--color-row-hover)]'"
          @click="picked = f.cwd" @dblclick="start"
        >
          <FolderGit2 :size="15" :class="f.cwd === picked ? 'text-[var(--color-brand-600)]' : 'text-faint'" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13.5px] font-medium">{{ shortCwd(f.cwd).split('/').pop() }}</span>
            <span class="pill-mono block truncate text-faint">{{ shortCwd(f.cwd) }}</span>
          </span>
          <span v-if="f.group && f.group !== shortCwd(f.cwd).split('/').pop()" class="rounded bg-canvas-2 px-1.5 py-0.5 text-[11px] text-muted">{{ f.group }}</span>
          <span v-if="f.cwd === start0 && current" class="chip" style="background: var(--color-chip-accent-bg); color: var(--color-chip-accent-fg)">current</span>
          <span v-else-if="f.at" class="text-[11px] tabular-nums text-faint">{{ ago(f.at) }}</span>
        </button>
        <button v-if="extra" type="button" :data-picked="picked === extra ? '1' : undefined" class="flex w-full items-center gap-3 px-3 py-2 text-left"
          :class="picked === extra ? 'bg-[var(--color-row-sel)] shadow-[inset_2px_0_0_var(--color-brand-500)]' : 'hover:bg-[var(--color-row-hover)]'" @click="picked = extra" @dblclick="start">
          <template v-if="creating">
            <FolderPlus :size="15" :class="picked === extra ? 'text-[var(--color-brand-600)]' : 'text-faint'" />
            <span class="min-w-0 flex-1 truncate text-[13.5px]">Create <span class="pill-mono">{{ extra }}</span></span>
          </template>
          <template v-else><Folder :size="15" class="text-faint" /><span class="pill-mono">{{ extra }}</span></template>
        </button>
        <div v-if="typed?.error" class="px-3 py-3 text-[13px] text-[var(--color-chip-red-fg)]">{{ typed.error }}</div>
        <div v-else-if="!shown.length && !typedPath" class="px-3 py-3 text-[13px] text-faint">No folder under {{ workRoot }} matches. Type a path such as ~/my-app to make one.</div>
      </div>

      <div class="mt-4 flex gap-1 rounded-lg border border-line bg-canvas p-1">
        <button v-for="t in (['claude', 'codex', 'agy', 'shell'] as const)" :key="t" type="button" class="flex-1 rounded-md py-1.5 text-[13px] font-medium"
          :class="tool === t ? 'bg-[var(--color-row-sel)] text-ink ring-1 ring-line-strong' : 'text-muted hover:text-ink'" @click="tool = t">{{ TOOL_LABEL[t] }}</button>
      </div>
      <div class="mt-3 grid grid-cols-2 gap-3">
        <label v-if="tool === 'claude' || tool === 'codex'" class="text-[12px] font-medium text-muted">{{ tool === 'codex' ? 'Codex account' : 'Account' }}
          <select v-model="account" class="input mt-1 !py-2">
            <option value="auto">{{ tool === 'codex' ? 'Folder or default account' : autoLabel() }}</option>
            <option v-for="a in accountsFor(tool)" :key="a.name" :value="a.name" :disabled="a.paused">{{ a.name }}{{ a.paused ? ' · paused' : a.email ? '' : ' · not logged in' }}</option>
          </select>
        </label>
        <div v-else-if="tool === 'agy'" class="text-[12px] font-medium text-muted">Account
          <p class="mt-1 py-2 text-[12.5px] font-normal text-faint">agy uses one login</p>
        </div>
        <label class="text-[12px] font-medium text-muted">Name <span class="font-normal text-faint">(optional)</span>
          <input v-model="name" class="input mt-1 !py-2" :placeholder="tool === 'shell' ? `shell: ${(picked || 'folder').split('/').pop()} if empty` : 'Claude names it if empty'" />
        </label>
      </div>
      <label class="mt-3 block text-[12px] font-medium text-muted">{{ tool === 'shell' ? 'Command to run first' : 'First message' }} <span class="font-normal text-faint">(optional)</span>
        <textarea v-model="prompt" rows="2" class="input mt-1" :placeholder="tool === 'shell' ? 'e.g. bun run dev; leave empty for a prompt' : 'Leave empty to start at the prompt'" @keydown.meta.enter.prevent="start"></textarea>
      </label>

      <div v-if="tool !== 'shell'" class="mt-3">
        <div class="flex items-center gap-3">
          <span class="text-[12px] font-medium text-muted">Auto mode</span>
          <div class="flex gap-1 rounded-lg border border-line bg-canvas p-0.5" role="radiogroup" aria-label="Permission mode">
            <button v-for="m in (['auto', 'ask'] as const)" :key="m" type="button" role="radio" :aria-checked="mode === m" class="rounded-md px-3 py-1 text-[12.5px] font-medium"
              :class="mode === m ? 'bg-[var(--color-row-sel)] text-ink ring-1 ring-line-strong' : 'text-muted hover:text-ink'" @click="setMode(m)">{{ m === 'auto' ? 'On' : 'Off (ask)' }}</button>
          </div>
          <span v-if="!modeTouched && modeFrom !== 'default'" class="text-[11.5px] text-faint">{{ modeFrom === 'deck.json' ? 'from deck.json' : 'from this folder’s setting' }}</span>
        </div>
        <p class="mt-1 text-[12px] text-faint">{{ MODE_NOTE[mode] }}</p>
      </div>
      <div v-if="tool !== 'shell' && sharing.length" class="mt-3 rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px]">
        <p class="text-ink-soft"><span class="font-medium text-ink">{{ sharing.length === 1 ? sharing[0] : `${sharing.length} sessions` }}</span> {{ sharing.length === 1 ? 'is' : 'are' }} already working in this {{ repoHere ? 'repo' : 'folder' }}. Two agents editing one checkout can overwrite each other's changes.</p>
        <label v-if="repoHere" class="mt-1.5 flex items-center gap-2 text-muted"><input v-model="worktree" type="checkbox" /> Give this session its own worktree <span class="text-faint">(a new branch ov/&lt;name&gt;)</span></label>
      </div>
      <div v-if="tool === 'claude'" class="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
        <label class="flex items-center gap-2" :title="deck.settings.chromeAccount ? `Runs on ${deck.settings.chromeAccount}, the account Claude in Chrome is signed in to` : ''">
          <input v-model="chrome" type="checkbox" /> Needs Claude in Chrome
        </label>
        <span v-if="chrome && deck.settings.chromeAccount" class="text-faint">· runs on {{ deck.settings.chromeAccount }}</span>
        <!-- first use: ask which account the extension is signed in to, and remember it (Settings has the same choice) -->
        <template v-else-if="chrome">
          <span class="text-faint">· Chrome is signed in to</span>
          <select class="input !w-auto !py-1 text-[12.5px]" value="" @change="setChromeAccount(($event.target as HTMLSelectElement).value)">
            <option value="" disabled>pick an account</option>
            <option v-for="a in accountsFor('claude')" :key="a.name" :value="a.name">{{ a.name }}</option>
          </select>
        </template>
      </div>
      <p class="mt-3 truncate text-[12px] text-faint">{{ creating && picked === typedPath ? 'Creates and starts in' : 'In' }} <span class="pill-mono text-muted">{{ picked ? shortCwd(picked) : '…' }}</span> · {{ launchNote }}</p>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}<SettingsLink :text="err" @open="deck.newOpen = false" /></p>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn btn-ghost" @click="deck.newOpen = false">Cancel</button>
        <button class="btn btn-brand" :disabled="busy || !picked">{{ tool === 'shell' ? 'Open terminal' : 'Start session' }}</button>
      </div>
    </form>
  </div>
</template>
