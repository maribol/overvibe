<script setup lang="ts">
// The projects folder (config.json workRoot), in the setup and in Settings [T1110-67]. Typing checks the
// path on the server (under home, exists or can be made); saving writes config.json and the server uses
// it right away. DECK_WORK_ROOT, when set, still wins.
import { computed, onMounted, ref, watch } from 'vue'
import { Check, Folder, FolderGit2, FolderPlus, RotateCcw } from 'lucide-vue-next'
import Spinner from './Spinner.vue'
import { api, workRoot } from '../deck'

type Info = { workRoot: string; saved: string | null; default: string; env: string | null }
const info = ref<Info | null>(null)
const path = ref('')
const check = ref<{ cwd?: string; exists?: boolean; error?: string } | null>(null)
const saving = ref(false)
const err = ref('')
const savedNote = ref('')
const picks = ref<string[]>([])
/** preview: show the folders found under the typed path (the setup's live preview) */
const props = defineProps<{ preview?: boolean }>()
const found = ref<{ path: string; dirs: { name: string; git: boolean }[]; total: number } | null>(null)
let pt: ReturnType<typeof setTimeout>
function loadPreview(p: string) {
  clearTimeout(pt)
  if (!props.preview) return
  pt = setTimeout(async () => {
    try {
      const r = await api<{ path: string; dirs: string[] }>(`/api/ls?path=${encodeURIComponent(p.trim() || '~')}`)
      const top = r.dirs.slice(0, 7)
      const git = await Promise.all(top.map((d) => api<{ git: boolean }>(`/api/ls?path=${encodeURIComponent(`${r.path}/${d}`)}`).then((x) => x.git).catch(() => false)))
      if (path.value === p) found.value = { path: r.path, dirs: top.map((name, i) => ({ name, git: git[i]! })), total: r.dirs.length }
    } catch {
      if (path.value === p) found.value = null
    }
  }, 200)
}

// the folder in use when there is no env override, else the saved one (what Save changes)
const current = computed(() => (info.value ? (info.value.env ? info.value.saved ?? info.value.default : info.value.workRoot) : ''))
const dirty = computed(() => !!info.value && path.value.trim().replace(/\/+$/, '') !== current.value)

async function load() {
  info.value = await api<Info>('/api/setup')
  path.value = current.value
  check.value = null
}
onMounted(async () => {
  await load().catch((e) => (err.value = e.message))
  loadPreview(path.value)
  try {
    // your home's own folders as one-click picks (system and hidden ones are left out)
    const r = await api<{ dirs: string[] }>('/api/ls?path=~')
    const skip = new Set(['Library', 'Applications', 'System', 'Movies', 'Music', 'Pictures', 'Public', 'Desktop', 'Downloads', 'Documents'])
    picks.value = r.dirs.filter((d) => !skip.has(d)).slice(0, 8).map((d) => `~/${d}`)
  } catch {}
})

let t: ReturnType<typeof setTimeout>
watch(path, (v) => {
  loadPreview(v)
  clearTimeout(t)
  if (!dirty.value) return void (check.value = null)
  savedNote.value = ''
  err.value = ''
  if (!v.trim()) return void (check.value = null)
  t = setTimeout(async () => {
    try {
      const r = await api<{ cwd: string; exists: boolean }>('/api/setup/work-root', { path: v, check: true })
      if (path.value === v && dirty.value) check.value = r
    } catch (e: any) {
      if (path.value === v && dirty.value) check.value = { error: e.message }
    }
  }, 250)
})

/** save what is typed; '' = back to the default. Returns false when it could not be saved. */
async function save(p = path.value): Promise<boolean> {
  err.value = ''
  saving.value = true
  try {
    const r = await api<Info>('/api/setup/work-root', { path: p.trim(), create: true })
    info.value = r
    workRoot.value = r.workRoot
    path.value = current.value
    check.value = null
    loadPreview(path.value)
    savedNote.value = r.env ? `Saved. DECK_WORK_ROOT still wins while it is set.` : `Saved. Folder search now looks under ${r.workRoot}.`
    return true
  } catch (e: any) {
    err.value = e.message
    return false
  } finally {
    saving.value = false
  }
}
/** for the setup's Next: save a pending change first */
async function commit() {
  return dirty.value ? save() : true
}
defineExpose({ commit, dirty })
</script>

<template>
  <div>
    <form class="flex gap-2" @submit.prevent="save()">
      <input v-model="path" class="input pill-mono !text-[13px]" placeholder="~/Work" spellcheck="false" autocomplete="off" aria-label="Projects folder" />
      <button class="btn btn-brand flex-none" :disabled="!dirty || saving || !!check?.error">
        <Spinner v-if="saving" :size="13" />
        <FolderPlus v-else-if="check && !check.error && !check.exists" :size="15" />
        <Check v-else :size="15" />
        {{ check && !check.error && !check.exists ? 'Create and use' : 'Use this folder' }}
      </button>
    </form>
    <div class="mt-2 min-h-[18px] text-[12.5px]">
      <span v-if="err || check?.error" class="text-[var(--color-chip-red-fg)]">{{ err || check?.error }}</span>
      <span v-else-if="check && !check.exists" class="text-muted">{{ check.cwd }} does not exist yet. Overvibe will create it.</span>
      <span v-else-if="check" class="text-muted">{{ check.cwd }} exists.</span>
      <span v-else-if="savedNote" class="text-[var(--color-chip-green-fg)]">{{ savedNote }}</span>
      <span v-else-if="info" class="text-faint">In use now: <span class="pill-mono">{{ info.workRoot }}</span><template v-if="!info.saved"> (the default)</template></span>
    </div>
    <div v-if="picks.length" class="mt-2 flex flex-wrap gap-1.5">
      <button v-for="p in picks" :key="p" type="button" class="rounded-md border border-line px-2 py-1 font-mono text-[12px] text-ink-soft hover:border-line-strong hover:bg-[var(--color-row-hover)]" :class="path === p ? '!border-[var(--color-brand-500)] text-ink' : ''" @click="path = p">{{ p }}</button>
      <button v-if="info?.saved && info.saved !== info.default" type="button" class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted hover:text-ink" :title="`Remove workRoot from config.json and use ${info.default}`" @click="save('')"><RotateCcw :size="12" /> Default ({{ info.default }})</button>
    </div>
    <div v-if="preview" class="mt-5 overflow-hidden rounded-xl border border-line bg-canvas">
      <div class="flex items-center justify-between border-b border-line px-4 py-2 text-[11.5px] text-faint">
        <span class="pill-mono truncate">{{ found?.path ?? path }}</span>
        <span v-if="found">{{ found.total }} folder{{ found.total === 1 ? '' : 's' }}</span>
      </div>
      <div v-if="found?.dirs.length" class="grid grid-cols-2 gap-x-4 px-4 py-2.5">
        <div v-for="d in found.dirs" :key="d.name" class="flex min-w-0 items-center gap-2 py-1 text-[13px] text-ink-soft">
          <FolderGit2 v-if="d.git" :size="14" class="flex-none text-[var(--color-brand-600)]" /><Folder v-else :size="14" class="flex-none text-faint" />
          <span class="truncate">{{ d.name }}</span>
        </div>
        <div v-if="found.total > found.dirs.length" class="py-1 text-[12.5px] text-faint">and {{ found.total - found.dirs.length }} more</div>
      </div>
      <div v-else class="px-4 py-4 text-[12.5px] text-faint">{{ found ? 'Empty so far. New projects you create go here.' : 'Nothing here yet. Overvibe creates the folder when you use it.' }}</div>
    </div>
    <p v-if="info?.env" class="mt-3 rounded-lg border border-line bg-canvas-2 px-3 py-2 text-[12.5px] text-muted">
      DECK_WORK_ROOT is set to <span class="pill-mono">{{ info.env }}</span> for this server, and it wins over the folder saved here until you remove it.
    </p>
  </div>
</template>
