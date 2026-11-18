<script setup lang="ts">
// One subagent of a session, read-only [T1118-2]: its task, its replies and the tools it runs, from its transcript,
// refreshed every 2 s while it runs. "Back to the session" returns to the terminal; a subagent takes no input.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, Bot, CircleAlert, CircleCheck, SquareTerminal, Wrench } from 'lucide-vue-next'
import { agoText, api, deck, select, showSubagent, type Session } from '../deck'

type Ev = { at: number; kind: 'prompt' | 'text' | 'tool' | 'error'; text: string }
type Log = { id: string; task: string | null; desc: string; type: string; running: boolean; at: number; events: Ev[] }
const props = defineProps<{ s: Session; id: string }>()
const log = ref<Log | null>(null)
const err = ref('')
const box = ref<HTMLElement>()
let timer: ReturnType<typeof setInterval> | undefined

const atBottom = () => !box.value || box.value.scrollHeight - box.value.scrollTop - box.value.clientHeight < 60
async function load() {
  try {
    const stick = atBottom()
    const r = await api<Log>(`/api/sessions/${props.s.key}/agents/${props.id}`)
    const grew = r.events.length !== log.value?.events.length
    log.value = r
    err.value = ''
    if (grew && stick) await nextTick(() => box.value && (box.value.scrollTop = box.value.scrollHeight))
    if (!r.running) clearInterval(timer)
  } catch (e: any) {
    err.value = e.message
  }
}
const start = () => {
  clearInterval(timer)
  log.value = null
  load()
  timer = setInterval(load, 2000)
}
onMounted(start)
watch(() => props.id, start)
onBeforeUnmount(() => clearInterval(timer))
const back = () => ((deck.subagent = null), select(props.s.key))
const prompt = computed(() => (log.value?.task ? { text: log.value.task } : log.value?.events.find((e) => e.kind === 'prompt')))
const rest = computed(() => (log.value?.events ?? []).filter((e) => e !== prompt.value))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col bg-[var(--color-term)]" data-subagent-view>
    <div class="flex items-center gap-3 border-b border-line px-4 py-2.5">
      <button class="btn btn-ghost btn-sm" title="Back to the session's terminal" @click="back"><ArrowLeft :size="14" /> {{ s.title }}</button>
      <Bot :size="15" class="flex-none text-[var(--color-st-busy)]" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-[13.5px] font-semibold">{{ log?.desc ?? 'Subagent' }}</div>
        <div class="text-[11.5px] text-faint">{{ log?.type ?? '' }} subagent · {{ log ? (log.running ? `running, last step ${agoText(log.at)}` : `finished ${agoText(log.at)}`) : 'loading…' }} · read-only</div>
      </div>
      <CircleCheck v-if="log && !log.running" :size="15" class="flex-none text-[var(--color-chip-green-fg)]" />
      <button v-if="s.tmux" class="btn btn-sm flex-none" title="Switch Claude Code's own view to this subagent (it takes messages there)" @click="showSubagent(s.key, id)"><SquareTerminal :size="14" /> Show in Claude Code</button>
    </div>
    <p v-if="deck.subagent?.why" class="border-b border-line bg-[var(--color-chip-amber-bg)] px-4 py-1.5 text-[12.5px] text-[var(--color-chip-amber-fg)]">{{ deck.subagent.why }}. Showing it here instead, read-only.</p>
    <div ref="box" class="min-h-0 flex-1 overflow-y-auto px-5 py-4 font-mono text-[12.5px] leading-relaxed">
      <p v-if="err" class="text-[var(--color-danger)]">{{ err }}</p>
      <details v-if="prompt" class="mb-4 rounded-lg border border-line bg-surface/40 px-3 py-2" open>
        <summary class="cursor-pointer select-none text-[11.5px] font-sans font-medium uppercase tracking-[0.06em] text-faint">Its task</summary>
        <div class="mt-2 max-h-[30vh] overflow-y-auto whitespace-pre-wrap text-ink-soft">{{ prompt.text }}</div>
      </details>
      <div v-for="(e, i) in rest" :key="i" class="mb-1.5">
        <div v-if="e.kind === 'tool'" class="flex items-start gap-2 text-muted"><Wrench :size="12" class="mt-[3px] flex-none opacity-60" /><span class="min-w-0 break-words">{{ e.text }}</span></div>
        <div v-else-if="e.kind === 'error'" class="flex items-start gap-2 text-[var(--color-danger)]"><CircleAlert :size="12" class="mt-[3px] flex-none" /><span class="min-w-0 break-words">{{ e.text }}</span></div>
        <div v-else class="my-2 whitespace-pre-wrap font-sans text-[13.5px] text-ink">{{ e.text }}</div>
      </div>
      <p v-if="log && !rest.length" class="text-faint">Nothing yet.</p>
    </div>
  </div>
</template>
