<script setup lang="ts">
// A suspended session [T1116-3]: its CLI was stopped to free memory. Its last screen is drawn read-only
// and dimmed under a Revive overlay; Revive (or Enter) resumes the same conversation in this row.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CircleCheck, CircleHelp, CirclePause, Hand, MessageCircleQuestion, Play, Rocket, X } from 'lucide-vue-next'
import Spinner from './Spinner.vue'
import { agoText, api, closeRow, reviveSession, selectNeighbour, type Session } from '../deck'

const props = defineProps<{ s: Session }>()
const el = ref<HTMLElement>()
const busy = ref(false)
const err = ref('')
let term: Terminal | null = null
let fit: FitAddon | null = null
let ro: ResizeObserver | null = null

const css = (n: string, d: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d

// what it was doing as it stopped, and so whether closing it is safe [T1116-3]
const state = computed(() => {
  const s = props.s
  if (s.deploy) return { icon: Rocket, tone: 'violet', label: 'Deploy pending', text: s.question ?? s.suspendedReason ?? 'it asked whether to deploy', safe: false }
  if (s.status === 'waiting' && s.question) return { icon: MessageCircleQuestion, tone: 'amber', label: 'Needs you', text: s.question, safe: false }
  if (s.suspendedVerdict === 'waiting') return { icon: Hand, tone: 'amber', label: 'Waiting on you', text: s.suspendedReason ?? '', safe: false }
  if (s.suspendedVerdict === 'done') return { icon: CircleCheck, tone: 'green', label: 'Looks done', text: s.suspendedReason ?? '', safe: true }
  if (s.suspendedVerdict === 'unsure') return { icon: CircleHelp, tone: 'gray', label: 'Maybe not finished', text: s.suspendedReason ?? '', safe: false }
  return null
})
const toneClass = (t: string) =>
  ({ violet: 'bg-[var(--color-chip-violet-bg)] text-[var(--color-chip-violet-fg)]', amber: 'bg-[var(--color-chip-amber-bg)] text-[var(--color-chip-amber-fg)]', green: 'bg-[var(--color-chip-green-bg)] text-[var(--color-chip-green-fg)]', gray: 'bg-canvas-2 text-muted' })[t] ?? 'bg-canvas-2 text-muted'
// Close = hide the row (the conversation stays in past sessions). Not advised: the first click asks again.
const confirmClose = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | undefined
async function close() {
  if (state.value && !state.value.safe && !confirmClose.value) {
    confirmClose.value = true
    clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => (confirmClose.value = false), 5000)
    return
  }
  busy.value = true
  try {
    selectNeighbour(props.s.key)
    await closeRow(props.s)
  } catch (e: any) {
    err.value = e.message
    busy.value = false
  }
}

async function revive() {
  if (busy.value) return
  busy.value = true
  err.value = ''
  try {
    await reviveSession(props.s.key)
  } catch (e: any) {
    err.value = e.message
    busy.value = false
  }
}
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !(e.target as HTMLElement)?.closest('input, textarea, select')) {
    e.preventDefault()
    void revive()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  term = new Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    disableStdin: true,
    cursorBlink: false,
    cursorInactiveStyle: 'none',
    scrollback: 0,
    theme: { background: css('--color-term', '#101114'), foreground: css('--color-term-fg', '#e4e6eb'), cursor: css('--color-term', '#101114') },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el.value!)
  fit.fit()
  ro = new ResizeObserver(() => fit?.fit())
  ro.observe(el.value!)
  try {
    const r = await api<{ screen: string | null }>(`/api/sessions/${props.s.key}/screen`)
    // tmux's capture ends each line with \n; xterm needs \r\n, and no newline after the last row
    if (r.screen) term.write(r.screen.replace(/\n+$/, '').replace(/\r?\n/g, '\r\n'))
  } catch {}
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  ro?.disconnect()
  term?.dispose()
})
</script>

<template>
  <div class="relative min-h-0 flex-1 overflow-hidden bg-[var(--color-term)] p-2 pr-0" data-suspended>
    <div ref="el" class="pointer-events-none h-full w-full opacity-30 blur-[1.5px] saturate-50"></div>
    <div class="absolute inset-0 grid place-items-center bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,0.25),rgba(0,0,0,0.6))] p-6">
      <div class="w-[400px] max-w-full rounded-2xl border border-line bg-surface/95 p-5 shadow-2xl backdrop-blur-md">
        <div class="flex items-center gap-2.5">
          <span class="grid size-8 flex-none place-items-center rounded-full bg-canvas-2 text-muted"><CirclePause :size="17" /></span>
          <div class="min-w-0 flex-1">
            <div class="text-[11px] font-medium uppercase tracking-[0.08em] text-faint">Suspended {{ agoText(s.suspended ?? 0) }}</div>
            <div class="truncate text-[14.5px] font-semibold" :title="s.title">{{ s.title }}</div>
          </div>
        </div>
        <div v-if="state" class="mt-3.5 flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] leading-snug" :class="toneClass(state.tone)" data-suspended-state>
          <component :is="state.icon" :size="14" class="mt-px flex-none" />
          <span class="min-w-0"><span class="font-semibold">{{ state.label }}</span><span v-if="state.text" class="opacity-90">: {{ state.text }}</span></span>
        </div>
        <p class="mt-3 text-[13px] leading-relaxed text-muted">
          {{ s.suspendedBy === 'owner' ? 'You stopped it' : 'It sat idle, so Overvibe stopped it' }} to free its memory. The conversation is saved and picks up right where it left off.
        </p>
        <div class="mt-4 flex gap-2">
          <button class="btn btn-brand flex-1 justify-center" :disabled="busy" data-revive @click="revive">
            <Spinner v-if="busy" :size="14" /><Play v-else :size="14" />
            <span>{{ busy ? 'Working…' : 'Revive' }}</span>
            <kbd v-if="!busy" class="ml-1 rounded border border-white/25 px-1.5 text-[11px] font-normal opacity-80">↵</kbd>
          </button>
          <button class="btn flex-none" :class="confirmClose ? 'btn-danger' : 'btn-ghost'" :disabled="busy" data-close title="Hide this row; the conversation stays in past sessions" @click="close">
            <X :size="14" /> {{ confirmClose ? 'Close anyway' : 'Close' }}
          </button>
        </div>
        <p v-if="confirmClose" class="mt-2 text-[12px] text-[var(--color-chip-amber-fg)]">{{ state?.label === 'Maybe not finished' ? 'It may not be finished.' : 'It still needs you.' }} Close hides the row; the conversation stays in past sessions.</p>
        <p v-else class="mt-2.5 text-center text-[11.5px] text-faint">{{ state?.safe ? 'Safe to close: nothing is left for you here.' : 'A message from another session wakes it too.' }}</p>
        <p v-if="err" class="mt-2 text-[12.5px] text-[var(--color-danger)]">{{ err }}</p>
      </div>
    </div>
  </div>
</template>
