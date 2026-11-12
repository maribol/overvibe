<script setup lang="ts">
// Move a session that was started in the wrong folder. The server stops it (idle only), moves its
// transcript to the new folder and resumes it there with a note about the move.
import { computed, onMounted, ref, watch } from 'vue'
import { CornerLeftUp, Folder, X } from 'lucide-vue-next'
import SettingsLink from './SettingsLink.vue'
import { accountsFor, api, autoLabel, deck, refresh, select, shortCwd, type Session, workRoot } from '../deck'

const props = defineProps<{ s: Session }>()
const cwd = ref('')
const account = ref(props.s.account ?? 'auto')
const err = ref('')
const busy = ref(false)
const listing = ref<{ path: string; dirs: string[]; git: boolean; project?: string } | null>(null)
const recent = computed(() => [...new Set(deck.sessions.filter((x) => x.kind === 'claude' && x.cwd !== props.s.cwd).map((x) => x.cwd))].slice(0, 12))
const place = computed(() => {
  const p = listing.value?.path ?? cwd.value
  const project = deck.sessions.find((x) => x.cwd === p)?.project ?? listing.value?.project ?? ''
  return project ? `project ${project}${listing.value?.git ? ' · git repo' : ''}` : listing.value?.git ? 'git repo' : ''
})
async function browse(p: string) {
  try {
    listing.value = await api(`/api/ls?path=${encodeURIComponent(p || '~')}`)
  } catch {
    listing.value = null
  }
}
const go = (p: string) => ((cwd.value = p), browse(p))
let t: ReturnType<typeof setTimeout>
watch(cwd, (v) => {
  clearTimeout(t)
  t = setTimeout(() => browse(v), 250)
})
onMounted(() => browse(workRoot.value))
const up = computed(() => (listing.value ? listing.value.path.replace(/\/[^/]+$/, '') || '~' : '~'))
const close = () => (deck.moveFor = null)

async function move() {
  if (!cwd.value.trim()) return (err.value = 'Pick a folder')
  busy.value = true
  err.value = ''
  try {
    const r = await api<{ tmux: string }>('/api/sessions/move-folder', { sessionId: props.s.sessionId, cwd: cwd.value, account: account.value })
    close()
    await refresh()
    select(r.tmux)
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-center backdrop p-4" @mousedown.self="close">
    <form class="dialog w-full max-w-xl p-6" @submit.prevent="move">
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold">Move “{{ s.title }}”</h3>
        <button type="button" class="rounded-md p-1 text-faint hover:bg-canvas-2 hover:text-ink" @click="close"><X :size="18" /></button>
      </div>
      <p class="mt-1 text-[13px] text-muted">
        Now in <span class="pill-mono">{{ shortCwd(s.cwd) }}</span>. It stops (once idle), its conversation moves to the new folder, and it
        continues there with a note that its folder changed.
      </p>
      <label class="mt-4 block text-[12px] font-medium text-muted">New folder</label>
      <input v-model="cwd" class="input pill-mono mt-1 !text-[13px]" :placeholder="`${workRoot}/…`" autofocus autocomplete="off" />
      <p class="mt-1 h-4 text-[12px] text-[var(--color-brand-600)]">{{ place }}</p>
      <div v-if="recent.length" class="mt-1 flex flex-wrap gap-1.5">
        <button v-for="r in recent" :key="r" type="button" class="rounded-md bg-canvas-2 px-2 py-1 text-[11.5px] text-ink-soft hover:bg-line" @click="go(r)">{{ shortCwd(r) }}</button>
      </div>
      <div v-if="listing" class="mt-2 max-h-44 overflow-y-auto rounded-lg hair">
        <button type="button" class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-muted hover:bg-canvas-2" @click="go(up)"><CornerLeftUp :size="13" /> ..</button>
        <button v-for="d in listing.dirs" :key="d" type="button" class="pill-mono flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-canvas-2" @click="go(`${listing!.path}/${d}`)">
          <Folder :size="13" class="text-faint" /> {{ d }}
        </button>
      </div>
      <label class="mt-4 block text-[12px] font-medium text-muted">Account
        <select v-model="account" class="input mt-1 !py-2">
          <option value="auto">{{ autoLabel() }}</option>
          <option v-for="a in accountsFor('claude')" :key="a.name" :value="a.name" :disabled="a.paused">{{ a.name }}{{ a.paused ? ' · paused' : '' }}</option>
        </select>
      </label>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}<SettingsLink :text="err" @open="close" /></p>
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn btn-ghost" @click="close">Cancel</button>
        <button class="btn btn-brand" :disabled="busy || s.status === 'busy'">{{ s.status === 'busy' ? 'Wait until idle' : 'Move session' }}</button>
      </div>
    </form>
  </div>
</template>
