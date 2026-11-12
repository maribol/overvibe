<script setup lang="ts">
// ⌘-click on a /compact the agent suggested [T1112-91]: confirm, then it goes to that session as the owner's
// message through the send queue (typed in when the session is idle, never over a draft or into an open menu).
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { api, deck, showToast, type Session } from '../deck'

const props = defineProps<{ s: Session; args: string }>()
const emit = defineEmits<{ close: [] }>()

// Codex's /compact takes no instructions: it summarises the whole conversation
const codex = computed(() => props.s.tool === 'codex')
const text = ref(props.args)
const err = ref('')
const busy = ref(false)
const box = ref<HTMLTextAreaElement>()
const btn = ref<HTMLButtonElement>()
const working = computed(() => deck.sessions.find((x) => x.tmux === props.s.tmux)?.status === 'busy')

onMounted(async () => {
  deck.compactOpen = true
  await nextTick()
  const el = box.value
  if (el) el.focus(), el.setSelectionRange(el.value.length, el.value.length)
  else btn.value?.focus()
})
onUnmounted(() => (deck.compactOpen = false))

async function run() {
  if (busy.value) return
  busy.value = true
  err.value = ''
  const keep = codex.value ? '' : text.value.replace(/\s+/g, ' ').trim()
  try {
    const r = await api<{ to: string; delivered: boolean; why?: string | null }>('/api/say', { to: props.s.tmux, text: keep ? `/compact ${keep}` : '/compact' })
    if (!r.delivered) showToast(`"${r.to}" compacts when it is free${r.why ? `: ${r.why}` : ''}`)
    emit('close')
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') e.preventDefault(), e.stopPropagation(), emit('close')
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.preventDefault(), run()
}
</script>

<template>
  <div class="fixed inset-0 z-[70] grid place-items-start justify-center backdrop p-4 pt-[14vh]" data-compact-dialog @mousedown.self="emit('close')" @keydown="onKey">
    <form class="dialog w-full max-w-xl p-5" @submit.prevent="run">
      <div class="mb-1 text-[15px] font-semibold text-ink">Compact {{ s.title }}?</div>
      <p class="mb-3 text-[13px] text-muted">
        <template v-if="codex">Codex's /compact takes no instructions: it summarises the whole conversation.</template>
        <template v-else>The summary keeps what these instructions name. Edit them first if you like.</template>
      </p>
      <textarea v-if="!codex" ref="box" v-model="text" rows="6" class="input w-full resize-y !text-[13.5px] leading-snug" maxlength="7900" />
      <p v-if="working" class="mt-2 text-[13px] text-ink-soft">It is working right now, so this waits and runs when the turn ends.</p>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}</p>
      <div class="mt-4 flex items-center justify-end gap-2">
        <span class="mr-auto text-[12px] text-faint">⌘Enter compacts · Esc cancels</span>
        <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button ref="btn" class="btn btn-brand" :disabled="busy">Compact</button>
      </div>
    </form>
  </div>
</template>
