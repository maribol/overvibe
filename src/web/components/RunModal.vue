<script setup lang="ts">
// ⌘-click on a `! <command>` the agent asked the owner to run [T1114-1]: nothing runs before this dialog. The
// command is shown whole and can be edited. "Run in this session" types it into Claude Code's shell mode through the
// send queue (when the session is free, never over a draft), so the output lands in the conversation; "New terminal"
// runs it in a plain terminal in the session's folder.
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { api, deck, showToast, startShell, type Session } from '../deck'

const props = defineProps<{ s: Session; cmd: string }>()
const emit = defineEmits<{ close: [] }>()

// only Claude Code has a shell mode ("!") whose output goes into the chat
const inSession = computed(() => props.s.kind === 'claude' && (props.s.tool ?? 'claude') === 'claude' && !!props.s.tmux)
const text = ref(props.cmd)
const err = ref('')
const busy = ref(false)
const box = ref<HTMLTextAreaElement>()
const working = computed(() => deck.sessions.find((x) => x.tmux === props.s.tmux)?.status === 'busy')
const folder = computed(() => props.s.here ?? props.s.cwd)
const cmd = () => text.value.replace(/\s*\n\s*/g, ' ').trim()

onMounted(async () => {
  // the same "a dialog is open" flag as the compact dialog: no reload or shortcut under it
  deck.compactOpen = true
  await nextTick()
  box.value?.focus()
})
onUnmounted(() => (deck.compactOpen = false))

async function here() {
  const c = cmd()
  if (busy.value || !c) return
  busy.value = true
  err.value = ''
  try {
    const r = await api<{ to: string; delivered: boolean; why?: string | null }>('/api/say', { to: props.s.tmux, text: `! ${c}`, shell: true })
    if (!r.delivered) showToast(`"${r.to}" runs it when it is free${r.why ? `: ${r.why}` : ''}`)
    emit('close')
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
async function terminal() {
  const c = cmd()
  if (busy.value || !c) return
  busy.value = true
  err.value = ''
  try {
    await startShell(folder.value, c, `run: ${c.length > 40 ? c.slice(0, 39) + '…' : c}`)
    emit('close')
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') e.preventDefault(), e.stopPropagation(), emit('close')
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.preventDefault(), inSession.value ? here() : terminal()
}
</script>

<template>
  <div class="fixed inset-0 z-[70] grid place-items-start justify-center backdrop p-4 pt-[14vh]" data-run-dialog @mousedown.self="emit('close')" @keydown="onKey">
    <form class="dialog w-full max-w-xl p-5" @submit.prevent="inSession ? here() : terminal()">
      <div class="mb-1 text-[15px] font-semibold text-ink">Run this command?</div>
      <p class="mb-3 text-[13px] text-muted">
        "{{ s.title }}" asked you to run it. Read it first: it runs as you, in {{ folder }}, with no further approval.
      </p>
      <textarea ref="box" v-model="text" rows="4" spellcheck="false" class="input w-full resize-y font-mono !text-[12.5px] leading-snug" maxlength="1900" />
      <p v-if="inSession" class="mt-2 text-[13px] text-muted">In this session, the output goes into the conversation, so "{{ s.title }}" reads it.</p>
      <p v-if="inSession && working" class="mt-1 text-[13px] text-ink-soft">It is working right now, so this waits and runs when the turn ends.</p>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}</p>
      <div class="mt-4 flex items-center justify-end gap-2">
        <span class="mr-auto text-[12px] text-faint">⌘Enter runs · Esc cancels</span>
        <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button type="button" :class="inSession ? 'btn btn-soft' : 'btn btn-brand'" :disabled="busy || !text.trim()" data-run-terminal @click="terminal">New terminal</button>
        <button v-if="inSession" class="btn btn-brand" :disabled="busy || !text.trim()" data-run-here>Run in this session</button>
      </div>
    </form>
  </div>
</template>
