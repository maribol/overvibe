<script setup lang="ts">
// A choice menu on the open session's screen (shell command permission, a question, folder trust),
// as a dialog. Picking an option moves the menu's cursor there and presses Enter in the session.
// When it opens, and the bar shown otherwise, live in ../prompt.ts.
import { computed, ref, watch } from 'vue'
import { api, current, refresh } from '../deck'
import { answered, closeModal, inTerminal, modalPrompt, openSig } from '../prompt'

const err = ref('')
/** the menu the error belongs to: a new menu does not show an old error */
const errSig = ref('')
const busy = ref(false)
const s = computed(() => current.value)
const p = modalPrompt
// Claude's question picker has a "Type something" row just above "Chat about this"
const typeRow = computed(() => {
  const o = p.value?.options ?? []
  const i = o.findIndex((x) => /^Type something\.?$/i.test(x.trim()))
  if (i >= 0) return i
  return o.length >= 3 && /^Chat about this$/i.test(o.at(-1)!.trim()) ? o.length - 2 : -1
})
const typed = ref('')
watch(typeRow, (i) => {
  const o = p.value?.options[i]
  typed.value = o && !/^Type something\.?$/i.test(o.trim()) ? o : ''
})
// The dialog closes as soon as the answer is sent (the CLI takes a moment to redraw); it comes back,
// with the error, only if the request fails.
async function pick(i: number, text?: string) {
  if (!p.value || !s.value?.tmux) return
  const sig = p.value.sig
  const tmux = s.value.tmux
  busy.value = true
  err.value = ''
  answered.value.add(sig)
  try {
    await api(`/api/sessions/${tmux}/answer`, { sig, index: i, ...(text ? { text } : {}) })
    refresh()
  } catch (e: any) {
    answered.value.delete(sig)
    openSig.value = sig
    err.value = e.message
    errSig.value = sig
  } finally {
    busy.value = false
  }
}
const danger = (o: string) => /^(No|Quit|No, exit)\b/i.test(o)
</script>

<template>
  <div v-if="p" class="fixed inset-0 z-[65] grid place-items-center backdrop p-4" @mousedown.self="closeModal">
    <div class="dialog w-[40rem] max-w-full p-5" @keydown.esc="closeModal">
      <div class="col-label mb-1 !text-[var(--color-st-wait)]">{{ s?.title }} asks</div>
      <h3 class="text-[15px] font-semibold">{{ p.title }}</h3>
      <pre v-if="p.context.length" class="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-canvas-2 px-3 py-2 font-mono text-[12px] text-ink-soft">{{ p.context.join('\n') }}</pre>
      <div class="mt-4 flex flex-col gap-1.5">
        <template v-for="(o, i) in p.options" :key="i">
        <form v-if="i === typeRow" class="flex gap-1.5" @submit.prevent="typed.trim() && pick(i, typed)">
          <span class="self-center px-2 tabular-nums opacity-60">{{ i + 1 }}.</span>
          <input v-model="typed" class="input flex-1" placeholder="Type your own answer" :disabled="busy" />
          <button class="btn btn-brand btn-sm" :disabled="busy || !typed.trim()">Send</button>
        </form>
        <button
          v-else class="btn justify-start text-left !whitespace-normal"
          :class="danger(o) ? 'btn-ghost !text-[var(--color-danger)]' : i === 0 ? 'btn-brand' : 'btn-ghost'"
          :disabled="busy" @click="pick(i)"
        ><span class="mr-1 tabular-nums opacity-60">{{ i + 1 }}.</span>
          <span class="flex flex-col">
            <span>{{ o }}</span>
            <span v-if="p.hints?.[i]" class="text-[12px] font-normal opacity-75">{{ p.hints[i] }}</span>
          </span>
        </button>
        </template>
      </div>
      <p v-if="err && errSig === p.sig" class="mt-3 text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}</p>
      <div class="mt-4 flex justify-end">
        <button class="btn btn-ghost btn-sm" @click="inTerminal">Answer in the terminal</button>
      </div>
    </div>
  </div>
</template>
