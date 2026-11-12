<script setup lang="ts">
// Close all on a project header [T1112-102]: one confirm listing the project's sessions with their tool, flagging the
// ones working right now or waiting on the owner. Each closes the way ⌘W does (stop, unpin, hide); stopped and past
// ones are hidden too. Nothing is deleted: the conversations stay in past sessions. Esc or Enter cancels (Cancel has focus).
import { computed, onMounted, ref } from 'vue'
import { CircleAlert } from 'lucide-vue-next'
import { api, closeProject, deck, projectPinned, projectRows } from '../deck'
import { planClose, toolLabel } from '../../closeall'

const name = deck.closeAllFor!
const tidy = ref<Record<string, { verdict: string; reason: string }>>({})
// in the order the sidebar shows them (the server sends newest activity first)
const shown = [...document.querySelectorAll<HTMLElement>('aside [data-key]')].map((el) => el.dataset.key!)
const at = (k: string) => (shown.indexOf(k) + 1 || shown.length + 1)
const plan = computed(() => planClose([...projectRows(name)].sort((a, b) => at(a.key) - at(b.key)), tidy.value))
const stop = computed(() => plan.value.filter((x) => x.action === 'stop'))
const hide = computed(() => plan.value.filter((x) => x.action === 'hide'))
const skip = computed(() => plan.value.filter((x) => x.action === 'skip'))
const pinned = projectPinned(name).length
const n = computed(() => stop.value.length + hide.value.length)
const flagged = computed(() => stop.value.filter((x) => x.flag).length)
const err = ref('')
const busy = ref(false)
const cancelBtn = ref<HTMLButtonElement>()
const close = () => (deck.closeAllFor = null)
onMounted(() => {
  cancelBtn.value?.focus()
  // Close old sessions' reading of each reply: why one waits on the owner (a question at its end, a choice left to them)
  api<{ sessions: { key: string; verdict: string; reason: string }[] }>('/api/tidy?hours=2')
    .then((r) => (tidy.value = Object.fromEntries(r.sessions.map((x) => [x.key, x]))))
    .catch(() => {})
})
async function go() {
  if (busy.value || !n.value) return
  busy.value = true
  err.value = ''
  try {
    const failed = await closeProject(name, plan.value)
    if (failed.length) err.value = `Not closed: ${failed.join('; ')}`
    else close()
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), close())
</script>

<template>
  <div class="fixed inset-0 z-[70] grid place-items-start justify-center backdrop p-4 pt-[14vh]" @mousedown.self="close" @keydown="onKey">
    <div class="dialog flex max-h-[72vh] w-full max-w-lg flex-col p-5" role="dialog" aria-modal="true" data-test="close-all">
      <div class="col-label mb-2">Close all in {{ name }}</div>
      <p class="text-[14px]">Close {{ n }} session{{ n === 1 ? '' : 's' }} in <b class="break-words">{{ name }}</b>?</p>
      <p class="mt-1 text-[13px] text-muted">Each one stops, leaves the sidebar and its pin, like ⌘W. The conversations are kept: overvibe ls --past lists them and overvibe resume brings one back.</p>
      <p v-if="flagged" class="mt-2 flex items-center gap-1.5 text-[13px] text-[var(--color-st-wait)]"><CircleAlert :size="14" class="flex-none" /> {{ flagged }} of them {{ flagged === 1 ? 'is' : 'are' }} working or waiting on you.</p>
      <div class="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-line">
        <div v-for="x in stop" :key="x.s.key" class="flex items-start gap-2 border-b border-line px-3 py-1.5 last:border-b-0" :data-key-row="x.s.key">
          <div class="min-w-0 flex-1">
            <div class="truncate text-[13px]">{{ x.s.title }}</div>
            <div v-if="x.flag" class="text-[12px] text-[var(--color-st-wait)]">{{ x.flag }}</div>
          </div>
          <span class="flex-none pt-0.5 text-[11.5px] text-faint">{{ toolLabel(x.s) }}</span>
        </div>
        <template v-if="hide.length">
          <div class="col-label border-b border-line px-3 pb-1 pt-2">Stopped or past, hidden too · {{ hide.length }}</div>
          <div v-for="x in hide" :key="x.s.key" class="flex items-center gap-2 border-b border-line px-3 py-1 last:border-b-0" :data-key-row="x.s.key">
            <span class="min-w-0 flex-1 truncate text-[12.5px] text-muted">{{ x.s.title }}</span>
            <span class="flex-none text-[11.5px] text-faint">{{ toolLabel(x.s) }}</span>
          </div>
        </template>
      </div>
      <p v-if="skip.length" class="mt-2 text-[12px] text-faint">Left as they are: {{ skip.map((x) => x.s.title).join(', ') }} ({{ skip.length === 1 ? 'it runs' : 'they run' }} outside Overvibe).</p>
      <p v-if="pinned" class="mt-2 text-[12px] text-faint">{{ pinned }} pinned session{{ pinned === 1 ? '' : 's' }} of this project stay{{ pinned === 1 ? 's' : '' }} in Pinned.</p>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-danger)]">{{ err }}</p>
      <div class="mt-4 flex justify-end gap-2">
        <button ref="cancelBtn" type="button" class="btn btn-ghost" @click="close">Cancel <kbd class="ml-0.5 text-[10.5px] opacity-70">Esc</kbd></button>
        <button type="button" class="btn btn-danger" data-test="close-all-go" :disabled="busy || !n" @click="go">{{ busy ? 'Closing…' : `Close ${n} session${n === 1 ? '' : 's'}` }}</button>
      </div>
    </div>
  </div>
</template>
