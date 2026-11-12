<script setup lang="ts">
// Tasks > Follow up with all [T1112-118]: the single follow-up (FollowupModal) for every open line in view at once.
// One message per session the lines are tagged with, its lines quoted and the owner's shared ask after them, sent as
// the owner through /api/say (the send queue types it in when the session is free). Stopped sessions are unticked;
// ticking one resumes it with the message. Lines whose tag matches no session, and untagged lines, are only listed.
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { api, deck, refresh, showToast } from '../deck'
import { FOLLOW_ALL_ASK, followupAllMessage, followupGroups, type FollowGroup, type TaskLine } from '../../taskview'

const props = defineProps<{ lines: TaskLine[]; project: string }>()
const emit = defineEmits<{ close: [] }>()

// worked out once when the dialog opens, so the list does not change under the owner as the state refreshes
const groups = followupGroups(props.lines, deck.sessions)
const ticked = ref<Record<string, boolean>>(Object.fromEntries(groups.map((g) => [g.key, g.kind === 'send'])))
const ask = ref(FOLLOW_ALL_ASK)
const chosen = computed(() => groups.filter((g) => (g.kind === 'send' || g.kind === 'resume') && ticked.value[g.key]))
const ready = computed(() => !!ask.value.trim() && chosen.value.length > 0)
const err = ref('')
const busy = ref(false)
const box = ref<HTMLTextAreaElement>()

const head = (g: FollowGroup) => (g.kind === 'send' ? g.title : g.kind === 'resume' ? g.title : g.kind === 'unknown' ? `session ${g.tag}` : 'No session')
const state = (g: FollowGroup) =>
  g.kind === 'send' ? g.status || 'running' : g.kind === 'resume' ? `stopped (${g.tool === 'codex' ? 'Codex' : 'Claude'})` : g.kind === 'unknown' ? 'not found in Overvibe' : 'no session tag'

onMounted(async () => {
  deck.followupOpen = true
  await nextTick()
  box.value?.focus()
})
onUnmounted(() => (deck.followupOpen = false))

async function send() {
  if (!ready.value || busy.value) return
  busy.value = true
  err.value = ''
  const failed: string[] = []
  let queued = 0
  let resumed = 0
  for (const g of chosen.value) {
    const text = followupAllMessage(g.lines, ask.value)
    if (!text) continue
    try {
      if (g.kind === 'send') {
        const r = await api<{ delivered: boolean }>('/api/say', { to: g.key, text })
        if (!r.delivered) queued++
      } else if (g.kind === 'resume') {
        await api('/api/resume', { target: g.sessionId, prompt: text })
        resumed++
      }
    } catch (e: any) {
      failed.push(`${head(g)}: ${e.message}`)
    }
  }
  busy.value = false
  if (resumed) await refresh()
  if (failed.length) return void (err.value = failed.join('\n'))
  const n = chosen.value.length
  showToast(`Sent to ${n} session${n === 1 ? '' : 's'}${queued ? `, ${queued} waiting until free` : ''}${resumed ? `, ${resumed} resumed` : ''}`)
  emit('close')
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') e.preventDefault(), emit('close')
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.preventDefault(), send()
}
</script>

<template>
  <div class="fixed inset-0 z-[70] grid place-items-start justify-center backdrop p-4 pt-[8vh]" @mousedown.self="emit('close')" @keydown="onKey">
    <form class="dialog flex max-h-[84vh] w-full max-w-2xl flex-col p-5" data-followup-all @submit.prevent="send">
      <div class="col-label mb-1">Follow up with all · {{ project }}</div>
      <p class="mb-3 text-[12.5px] text-faint">One message to each ticked session: its open lines, quoted, then your message.</p>
      <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        <div v-for="g in groups" :key="g.key" class="rounded-md border border-line px-3 py-2" :data-group="g.kind">
          <label class="flex items-center gap-2 text-[13px]">
            <input v-if="g.kind === 'send' || g.kind === 'resume'" v-model="ticked[g.key]" type="checkbox" />
            <span class="min-w-0 truncate font-medium" :class="g.kind === 'send' || g.kind === 'resume' ? '' : 'text-muted'">{{ head(g) }}</span>
            <span class="flex-none text-[11.5px] text-faint">{{ state(g) }}</span>
            <span v-if="g.kind === 'resume'" class="ml-auto flex-none text-[11.5px] text-faint">Resume and send</span>
            <span class="flex-none text-[11.5px] text-faint" :class="g.kind === 'resume' ? '' : 'ml-auto'">{{ g.lines.length }} open</span>
          </label>
          <ul class="mt-1 space-y-0.5 pl-6 text-[12.5px] leading-snug text-muted">
            <li v-for="(x, i) in g.lines.slice(0, 5)" :key="i" class="truncate"><span v-if="x.id" class="pill-mono mr-1">{{ x.id }}</span>{{ x.text }}</li>
            <li v-if="g.lines.length > 5" class="text-faint">and {{ g.lines.length - 5 }} more</li>
          </ul>
        </div>
      </div>
      <textarea ref="box" v-model="ask" rows="3" class="input mt-3 w-full resize-y !text-[13.5px] leading-snug" data-followup-ask />
      <p v-if="err" class="mt-2 whitespace-pre-line text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}</p>
      <div class="mt-4 flex items-center justify-end gap-2">
        <span class="mr-auto text-[12px] text-faint">⌘Enter sends · Esc closes</span>
        <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button class="btn btn-brand" :disabled="busy || !ready">Send to {{ chosen.length }} session{{ chosen.length === 1 ? '' : 's' }}</button>
      </div>
    </form>
  </div>
</template>
