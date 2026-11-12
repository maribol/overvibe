<script setup lang="ts">
// Messages from other sessions (`overvibe send`) waiting until this session's input box is free:
// the deck never types over a draft or while the owner is typing [T1110-60]. Nothing is dropped on
// its own; the owner can deliver one now or discard it.
import { computed, ref } from 'vue'
import { Mail } from 'lucide-vue-next'
import { api, refresh, type QueuedMessage } from '../deck'

const props = defineProps<{ queue: QueuedMessage[]; name: string }>()
const open = ref(false)
const err = ref('')
const busy = ref('')
const note = ref('')
const stale = computed(() => props.queue.some((q) => q.stale))
const label = computed(() => `${props.queue.length} message${props.queue.length === 1 ? '' : 's'} waiting`)
const ago = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000))
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}
async function act(q: QueuedMessage, what: 'deliver' | 'discard') {
  if (what === 'discard' && !confirm(`Discard the message from "${q.from}"? It will not be typed into "${props.name}".`)) return
  err.value = ''
  note.value = ''
  busy.value = q.id
  try {
    const r = await api<{ already?: boolean }>(`/api/send/${what}`, { id: q.id })
    await refresh()
    // it went in on its own a moment ago: say so instead of typing it twice
    if (r.already) note.value = 'Already delivered.'
    if (props.queue.length <= 1) open.value = false
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="relative flex-none">
    <button
      class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold"
      :style="{ background: stale ? 'var(--color-chip-amber-bg)' : 'var(--color-chip-blue-bg)', color: stale ? 'var(--color-chip-amber-fg)' : 'var(--color-chip-blue-fg)' }"
      :title="`Sent with overvibe send. It is typed in once the input box is empty and nobody has typed for a few seconds.`"
      @click="open = !open"
    >
      <Mail :size="12" /> {{ label }}<span v-if="queue[0]" class="font-normal opacity-80"> · from {{ queue[0].from }}</span>
    </button>
    <div v-if="open" class="absolute left-0 top-full z-30 mt-1.5 w-[420px] max-w-[80vw] rounded-lg border border-line bg-surface p-2 text-[12.5px] shadow-lg">
      <div v-for="q in queue" :key="q.id" class="rounded-md px-2 py-1.5 hover:bg-[var(--color-chip-gray-bg)]">
        <div class="flex items-center gap-2 text-[11.5px] text-faint">
          <span class="truncate font-semibold text-ink-soft">{{ q.from }}</span>
          <span>· {{ ago(q.at) }}</span>
          <span v-if="q.stale" class="rounded px-1 text-[10.5px] font-semibold" style="background: var(--color-chip-amber-bg); color: var(--color-chip-amber-fg)">waiting over 30 min</span>
        </div>
        <p class="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-ink">{{ q.preview }}</p>
        <div class="mt-1 flex items-center gap-2">
          <span v-if="q.why" class="truncate text-[11.5px] text-faint">Waiting: {{ q.why }}</span>
          <span class="flex-1"></span>
          <button class="btn btn-soft btn-sm" :disabled="!!busy" @click="act(q, 'deliver')">Deliver now</button>
          <button class="btn btn-ghost btn-sm hover:!text-[var(--color-danger)]" :disabled="!!busy" @click="act(q, 'discard')">Discard</button>
        </div>
      </div>
      <p v-if="note" class="px-2 pt-1 text-[11.5px] text-faint">{{ note }}</p>
      <p v-if="err" class="px-2 pt-1 text-[11.5px] text-[var(--color-chip-red-fg)]">{{ err }}</p>
    </div>
  </div>
</template>
