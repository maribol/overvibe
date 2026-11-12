<script setup lang="ts">
// Close old sessions [T1111-30]: the running sessions in three groups (done, waiting on you, unsure) with
// each one's last reply, so old ones can be closed together. Close selected does what ⌘W does to each
// (stop, unpin, hide; the conversation is kept in past sessions), after one confirm. Nothing closes by itself.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { BrushCleaning, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Hand, RefreshCw } from 'lucide-vue-next'
import { api, closeRow, deck, select, setView, stopSession } from '../deck'

type Row = {
  key: string; tmux: string; title: string; tool: string; kind: string; cwd: string; project: string; status: string
  idleSince: number; idleMs: number; pinned: boolean; children: number; queued: number; prompt: string | null
  reply: string | null; replyFrom: 'transcript' | 'rollout' | 'screen' | null; verdict: 'done' | 'waiting' | 'unsure'; reason: string
}
type Report = { hours: number; counts: Record<Row['verdict'], number>; sessions: Row[] }

const hours = ref(Number(localStorage.getItem('deck.tidyHours')) || 2)
const report = ref<Report | null>(null)
const err = ref('')
const loading = ref(false)
/** ticks the owner changed by hand; everything else follows the default (Done rows that are not pinned) */
const picked = ref<Record<string, boolean>>({})
const open = ref<Record<string, boolean>>({})
const asking = ref(false)
const closing = ref(false)
const progress = ref('')

async function load() {
  loading.value = true
  try {
    report.value = await api<Report>(`/api/tidy?hours=${hours.value}`)
    err.value = ''
  } catch (e: any) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}
function setHours(h: number) {
  hours.value = h
  localStorage.setItem('deck.tidyHours', String(h))
  void load()
}
let t: ReturnType<typeof setInterval>
onMounted(() => {
  void load()
  t = setInterval(() => !closing.value && !asking.value && load(), 30_000)
})
onUnmounted(() => clearInterval(t))

const ticked = (r: Row) => picked.value[r.key] ?? (r.verdict === 'done' && !r.pinned)
const toggle = (r: Row) => (picked.value = { ...picked.value, [r.key]: !ticked(r) })
const groups = computed(() => {
  const all = report.value?.sessions ?? []
  return [
    { id: 'done', label: 'Done, safe to close', note: `Idle ${hours.value} h or more, no menu open, and the last reply asks you nothing.`, icon: CheckCircle2, tone: 'text-[var(--color-chip-green-fg)]', rows: all.filter((r) => r.verdict === 'done') },
    { id: 'waiting', label: 'Waiting on you', note: 'A menu is open, or the last reply asks you something.', icon: Hand, tone: 'text-[var(--color-chip-amber-fg)]', rows: all.filter((r) => r.verdict === 'waiting') },
    { id: 'unsure', label: 'Unsure', note: 'Working, recent, has running helpers or queued messages, or said it will do more.', icon: CircleHelp, tone: 'text-faint', rows: all.filter((r) => r.verdict === 'unsure') },
  ]
})
const chosen = computed(() => (report.value?.sessions ?? []).filter(ticked))

const idle = (ms: number) => (ms < 3600_000 ? `${Math.floor(ms / 60_000)}m` : ms < 48 * 3600_000 ? `${Math.floor(ms / 3600_000)}h` : `${Math.floor(ms / 86400_000)}d`)
// folded, a reply shows its end: where a question or the last screen line is
const short = (t: string) => {
  const lines = t.split('\n').filter((l) => l.trim())
  const end = lines.slice(-3).join('\n')
  return end.length > 260 ? '…' + end.slice(-260) : lines.length > 3 && !end.startsWith('…') ? '…' + end : end
}
const toolName = (r: Row) => (r.tool === 'claude' ? 'Claude' : r.tool === 'codex' ? 'Codex' : r.tool === 'agy' ? 'agy' : 'Terminal')
function go(r: Row) {
  setView('terminal')
  select(r.key)
}

async function closeChosen() {
  const list = chosen.value
  asking.value = false
  closing.value = true
  const failed: string[] = []
  try {
    for (const [i, r] of list.entries()) {
      progress.value = `Closing ${i + 1} of ${list.length}: ${r.title}`
      try {
        // the same as ⌘W on that session: stop it, then unpin and hide its row [T1111-27]
        const s = deck.sessions.find((x) => x.key === r.key)
        await stopSession(r.tmux)
        await closeRow(s ?? { key: r.key, sessionId: null })
      } catch (e: any) {
        failed.push(`${r.title}: ${e.message}`)
      }
    }
  } finally {
    closing.value = false
    progress.value = ''
    picked.value = {}
    err.value = failed.length ? `Not closed: ${failed.join('; ')}` : ''
    await load()
  }
}
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto max-w-4xl px-6 py-6">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="flex items-center gap-2 text-lg font-semibold"><BrushCleaning :size="18" class="text-faint" /> Close old sessions</h2>
          <p class="text-[13px] text-muted">Running sessions sorted by whether they still need you. Closing one is the same as ⌘W: it stops, leaves the sidebar and its pin, and the conversation stays in past sessions.</p>
        </div>
        <div class="flex items-center gap-2">
          <span class="col-label">Idle for</span>
          <select class="input !w-24 !py-1.5" :value="hours" @change="setHours(Number(($event.target as HTMLSelectElement).value))">
            <option v-for="h in [1, 2, 4, 8, 24]" :key="h" :value="h">{{ h }} h</option>
          </select>
          <button class="btn btn-ghost btn-sm" title="Look again" :disabled="loading" @click="load"><RefreshCw :size="14" :class="loading ? 'animate-spin' : ''" /></button>
        </div>
      </div>

      <div class="sticky top-0 z-10 mt-4 flex items-center justify-between gap-3 rounded-lg border border-line bg-[var(--color-surface)] px-4 py-2.5">
        <span class="text-[13px] text-muted">{{ progress || (chosen.length ? `${chosen.length} selected` : 'Nothing selected') }}</span>
        <button class="btn btn-danger btn-sm" data-test="close-selected" :disabled="!chosen.length || closing" @click="asking = true">Close selected</button>
      </div>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-danger)]">{{ err }}</p>
      <p v-if="!report && loading" class="mt-6 text-[13px] text-faint">Reading sessions…</p>
      <p v-else-if="report && !report.sessions.length" class="mt-6 text-[13px] text-faint">No running sessions.</p>

      <section v-for="g in groups" v-show="report && report.sessions.length" :key="g.id" class="mt-6" :data-group="g.id">
        <div class="col-label mb-1 flex items-center gap-1.5"><component :is="g.icon" :size="13" :class="g.tone" /> {{ g.label }} · {{ g.rows.length }}</div>
        <p class="mb-2 text-[12px] text-faint">{{ g.note }}</p>
        <div v-if="!g.rows.length" class="text-[13px] text-faint">None.</div>
        <div v-else class="card divide-y divide-line">
          <div v-for="r in g.rows" :key="r.key" class="flex items-start gap-3 px-4 py-2.5" :data-key="r.key">
            <input type="checkbox" class="mt-1 flex-none" :checked="ticked(r)" :disabled="closing" :aria-label="`Select ${r.title}`" @change="toggle(r)" />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <button class="truncate text-left text-[13.5px] font-medium hover:underline" title="Open this session" @click="go(r)">{{ r.title }}</button>
                <span class="rounded bg-canvas-2 px-1.5 py-0.5 text-[11.5px] text-muted">{{ r.project }}</span>
                <span class="text-[11.5px] text-faint">{{ toolName(r) }} · idle {{ idle(r.idleMs) }}</span>
                <span v-if="r.pinned" class="text-[11.5px] text-faint" title="Pinned rows are not selected by default">· pinned</span>
              </div>
              <p class="mt-0.5 text-[12.5px] text-muted">{{ r.reason }}</p>
              <template v-if="r.reply">
                <button class="mt-1 flex items-center gap-1 text-[11.5px] text-faint hover:text-ink" @click="open = { ...open, [r.key]: !open[r.key] }">
                  <component :is="open[r.key] ? ChevronDown : ChevronRight" :size="12" /> {{ r.replyFrom === 'screen' ? 'Its screen' : 'Last reply' }}{{ open[r.key] ? '' : ', the end' }}
                </button>
                <p class="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-snug text-muted" :style="r.replyFrom === 'screen' ? 'font-family: var(--font-mono, monospace); font-size: 11.5px' : ''">{{ open[r.key] ? r.reply : short(r.reply) }}</p>
              </template>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div v-if="asking" class="fixed inset-0 z-[70] grid place-items-start justify-center backdrop p-4 pt-[18vh]" @mousedown.self="asking = false" @keydown.esc="asking = false">
      <div class="dialog w-full max-w-md p-5" role="dialog" aria-modal="true">
        <div class="col-label mb-2">Close sessions</div>
        <p class="text-[14px]">Close {{ chosen.length }} session{{ chosen.length === 1 ? '' : 's' }}?</p>
        <p class="mt-1 text-[13px] text-muted">Each one stops and leaves the sidebar and its pin. Conversations are kept in past sessions, where you can resume them.</p>
        <ul class="mt-2 max-h-40 overflow-y-auto text-[12.5px] text-muted">
          <li v-for="r in chosen" :key="r.key" class="truncate">{{ r.title }}</li>
        </ul>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="btn btn-ghost" @click="asking = false">Cancel</button>
          <button type="button" class="btn btn-danger" data-test="confirm-close" @click="closeChosen">Close {{ chosen.length }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
