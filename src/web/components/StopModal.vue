<script setup lang="ts">
// ⌥W, the terminal's Stop button and the row menu's Stop: ask first, in the page. S stops, Esc or Enter cancels
// (Cancel has focus, so a stray Enter or Space typed into the page can't stop a session).
import { onMounted, ref } from 'vue'
import { closeRow, deck, isPinned, stopSession } from '../deck'

const s = deck.stopFor!
const err = ref('')
const busy = ref(false)
const cancelBtn = ref<HTMLButtonElement>()
const shell = s.kind === 'shell'
// ⌘W / ⌥W: closing also unpins and hides it [T1111-27]
const closing = deck.stopClose
const pinned = isPinned(s)
// back to the terminal the dialog was opened over (only the visible one has a size)
const refocus = () => [...document.querySelectorAll<HTMLTextAreaElement>('.xterm-helper-textarea')].find((t) => t.closest('.xterm')?.getClientRects().length)?.focus()
const close = () => {
  deck.stopFor = null
  setTimeout(refocus)
}
onMounted(() => cancelBtn.value?.focus())
async function stop() {
  if (busy.value) return
  busy.value = true
  err.value = ''
  try {
    await stopSession(s.tmux!)
    if (closing) await closeRow(s)
    close()
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') (e.preventDefault(), close())
  else if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey && !e.altKey) (e.preventDefault(), stop())
}
</script>

<template>
  <div class="fixed inset-0 z-[70] grid place-items-start justify-center backdrop p-4 pt-[18vh]" @mousedown.self="close" @keydown="onKey">
    <div class="dialog w-full max-w-md p-5" role="dialog" aria-modal="true">
      <div class="col-label mb-2">{{ closing ? 'Close session' : 'Stop session' }}</div>
      <p class="text-[14px]">{{ closing ? 'Close' : 'Stop' }} <b class="break-words">{{ s.title }}</b>?</p>
      <p class="mt-1 text-[13px] text-muted">{{ shell ? 'The shell exits.' : closing ? 'The conversation is kept: overvibe ls --past lists it and overvibe resume brings it back.' : 'The conversation is kept; resume it from the sidebar.' }}</p>
      <p v-if="closing" class="mt-1 text-[13px] text-muted">It also leaves the sidebar{{ pinned ? ' and its pin' : '' }}.</p>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-danger)]">{{ err }}</p>
      <div class="mt-4 flex justify-end gap-2">
        <button ref="cancelBtn" type="button" class="btn btn-ghost" @click="close">Cancel <kbd class="ml-0.5 text-[10.5px] opacity-70">Esc</kbd></button>
        <button type="button" class="btn btn-danger" :disabled="busy" @click="stop">{{ closing ? 'Close' : 'Stop' }} <kbd class="ml-0.5 text-[10.5px] opacity-70">S</kbd></button>
      </div>
    </div>
  </div>
</template>
