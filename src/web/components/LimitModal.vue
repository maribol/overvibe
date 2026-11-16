<script setup lang="ts">
// A session hit its subscription's usage limit [T1116-8]: offer to move it to another Claude account that still
// has room (same conversation, restarted on that account), and type "continue" so it picks up where the limit
// cut it off. Shown once per limit message, and only when an account with room exists.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Gauge } from 'lucide-vue-next'
import Spinner from './Spinner.vue'
import { deck, topUse, select, switchSessionAccount, type Account } from '../deck'

const SEEN = 'deck.limitSeen'
const seen = ref<string[]>(JSON.parse(localStorage.getItem(SEEN) ?? '[]'))
const keyOf = (s: { sessionId: string | null; limit?: string }) => `${s.sessionId}|${s.limit}`
const markSeen = (k: string) => {
  seen.value = [...seen.value.filter((x) => x !== k), k].slice(-200)
  localStorage.setItem(SEEN, JSON.stringify(seen.value))
}

/** Claude accounts a session can move to: not paused, not over 95% on any window; most room first (unknown last). */
const roomy = (except: string | null): Account[] =>
  deck.accounts
    .filter((a) => a.tool === 'claude' && !a.paused && !a.error && a.name !== except && (topUse(a) ?? 0) < 95)
    .sort((a, b) => (topUse(a) ?? 101) - (topUse(b) ?? 101))

// the first session on a limit not seen yet, with somewhere to go
const s = computed(() => deck.sessions.find((x) => x.where === 'deck' && x.tmux && x.limit && x.sessionId && !seen.value.includes(keyOf(x)) && roomy(x.account).length))
const options = computed(() => (s.value ? roomy(s.value.account) : []))
const account = ref('')
const resume = ref(true)
const busy = ref(false)
const err = ref('')
watch(s, (v, old) => {
  if (v?.key !== old?.key) (account.value = options.value[0]?.name ?? ''), (err.value = '')
}, { immediate: true })

const pct = (a: Account) => (topUse(a) === null ? 'usage unknown' : `${Math.round(topUse(a)!)}% used`)
function later() {
  if (s.value) markSeen(keyOf(s.value))
}
async function go() {
  const v = s.value
  if (!v || !account.value || busy.value) return
  busy.value = true
  err.value = ''
  try {
    markSeen(keyOf(v))
    await switchSessionAccount(v.tmux!, account.value, { resume: resume.value })
    select(deck.sessions.find((x) => x.sessionId === v.sessionId && x.tmux)?.key ?? v.key)
  } catch (e: any) {
    err.value = e.message
    seen.value = seen.value.filter((x) => x !== keyOf(v)) // let it come back after a failure
  } finally {
    busy.value = false
  }
}
// Esc anywhere while it shows (focus is usually still in a terminal)
function onKey(e: KeyboardEvent) {
  if (s.value && e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), later())
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div v-if="s" class="fixed inset-0 z-[70] grid place-items-start justify-center backdrop p-4 pt-[16vh]" data-limit-modal @mousedown.self="later">
    <div class="dialog w-full max-w-md p-5" role="dialog" aria-modal="true">
      <div class="flex items-center gap-2.5">
        <span class="grid size-8 flex-none place-items-center rounded-full bg-[var(--color-chip-amber-bg)] text-[var(--color-chip-amber-fg)]"><Gauge :size="16" /></span>
        <div class="min-w-0">
          <div class="text-[11px] font-medium uppercase tracking-[0.08em] text-faint">Usage limit{{ s.account ? ` on ${s.account}` : '' }}</div>
          <div class="truncate text-[14.5px] font-semibold" :title="s.title">{{ s.title }}</div>
        </div>
      </div>
      <p class="mt-3 rounded-lg bg-canvas-2 px-3 py-2 text-[12.5px] text-muted">{{ s.limit }}</p>
      <label class="mt-4 block text-[13px] font-medium">Move it to</label>
      <select v-model="account" class="input mt-1.5 w-full !py-1.5" data-limit-account>
        <option v-for="a in options" :key="a.name" :value="a.name">{{ a.name }}{{ a.email ? ` · ${a.email}` : '' }} · {{ pct(a) }}</option>
      </select>
      <label class="mt-3 flex cursor-pointer items-start gap-2.5 text-[13px]">
        <input v-model="resume" type="checkbox" class="mt-0.5 flex-none" />
        <span>Continue where it stopped <span class="text-muted">(types "continue" once it is back)</span></span>
      </label>
      <p class="mt-3 text-[12.5px] text-muted">It restarts on that account with the same conversation; nothing is lost.</p>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-danger)]">{{ err }}</p>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="later">Not now <kbd class="ml-0.5 text-[10.5px] opacity-70">Esc</kbd></button>
        <button type="button" class="btn btn-brand" :disabled="busy || !account" data-limit-switch @click="go"><Spinner v-if="busy" :size="14" /> Switch account</button>
      </div>
    </div>
  </div>
</template>
