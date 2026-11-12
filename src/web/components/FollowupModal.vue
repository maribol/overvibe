<script setup lang="ts">
// Tasks > Follow up with agent [T1112-14]: the owner's answer about one TASKS.md line, to the session that
// added it (typed in through the send queue, or resumed with it as the prompt) or to a new session in the project.
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { api, deck, refresh, select, showToast, startSession } from '../deck'
import { followupContext, followupMessage, followupTargets, type TaskLine, type Target } from '../../taskview'

const props = defineProps<{ task: TaskLine; root: string; project: string }>()
const emit = defineEmits<{ close: [] }>()

// the context is shown above the box and sent first; the box holds only the owner's answer, so Send waits
// for one and nothing typed can be lost behind a pre-fill [T1112-92]
const context = followupContext(props.task)
const answer = ref('')
const msg = computed(() => followupMessage(props.task, answer.value))
const room = 8000 - context.length - 1
// worked out once when the dialog opens, so the picker does not change under the owner as the state refreshes
const targets = followupTargets(props.task.sessions, deck.sessions)
const pick = ref(0)
const target = computed<Target>(() => targets[pick.value]!)
const label = (t: Target) => (t.kind === 'send' ? `${t.title} (running: type it in)` : t.kind === 'resume' ? `${t.title} (stopped: resume it with this)` : `New ${t.tool === 'codex' ? 'Codex' : 'Claude'} session in ${props.project}`)
const err = ref('')
const busy = ref(false)
const box = ref<HTMLTextAreaElement>()

onMounted(async () => {
  deck.followupOpen = true
  await nextTick()
  box.value?.focus()
})
onUnmounted(() => (deck.followupOpen = false))

async function send() {
  const text = msg.value
  if (!text || busy.value) return
  busy.value = true
  err.value = ''
  const t = target.value
  try {
    if (t.kind === 'send') {
      const r = await api<{ to: string; delivered: boolean; why?: string | null }>('/api/say', { to: t.key, text })
      if (!r.delivered) showToast(`Waiting to type it into "${r.to}"${r.why ? `: ${r.why}` : ''}`)
      select(t.key)
    } else if (t.kind === 'resume') {
      const r = await api<{ tmux: string; pausedNote?: string }>('/api/resume', { target: t.sessionId, prompt: text })
      await refresh()
      select(r.tmux)
      if (r.pausedNote) showToast(r.pausedNote.charAt(0).toUpperCase() + r.pausedNote.slice(1))
    } else {
      await startSession({ tool: t.tool, cwd: props.root, account: 'auto', prompt: text })
    }
    emit('close')
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') e.preventDefault(), emit('close')
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.preventDefault(), send()
}
</script>

<template>
  <div class="fixed inset-0 z-[70] grid place-items-start justify-center backdrop p-4 pt-[14vh]" @mousedown.self="emit('close')" @keydown="onKey">
    <form class="dialog w-full max-w-xl p-5" @submit.prevent="send">
      <div class="col-label mb-2">Follow up with agent</div>
      <blockquote class="mb-2 max-h-28 overflow-y-auto border-l-2 border-[var(--color-line)] pl-3 text-[13px] leading-snug text-muted" data-followup-context>{{ context }}</blockquote>
      <textarea ref="box" v-model="answer" rows="6" class="input w-full resize-y !text-[13.5px] leading-snug" :maxlength="room" placeholder="Your answer (Enter adds a line)" data-followup-answer />
      <label class="mt-3 flex items-center gap-2 text-[13px]">
        <span class="text-muted">Send to</span>
        <select v-model.number="pick" class="input !w-auto min-w-0 flex-1 !py-1.5" data-followup-target>
          <option v-for="(t, i) in targets" :key="i" :value="i">{{ label(t) }}</option>
        </select>
      </label>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}</p>
      <div class="mt-4 flex items-center justify-end gap-2">
        <span class="mr-auto text-[12px] text-faint">⌘Enter sends · Esc closes</span>
        <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button class="btn btn-brand" :disabled="busy || !msg">Send</button>
      </div>
    </form>
  </div>
</template>
