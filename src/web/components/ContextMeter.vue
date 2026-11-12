<script setup lang="ts">
// The terminal header's Context meter [T1112-107]: how full this session's context is, read from its transcript
// (nothing is typed into the session). Click: a stacked bar, one row per part, and the biggest single items.
// The session's token totals (in / out) live in the popover too [T1112-124]; `compact` drops the words for a narrow header.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, tokenLine, type Session } from '../deck'

type Report = {
  total: number; exactInput: number; window: number | null; windowNote: string | null; percent: number | null
  sinceCompact: boolean; compactedAt: number | null; model: string | null; at: number | null
  categories: { key: string; label: string; tokens: number; parts?: { label: string; tokens: number }[] }[]
  top: { label: string; cat: string; tokens: number; at: number }[]
}
const props = defineProps<{ s: Session; compact?: boolean }>()
const used = computed(() => tokenLine(props.s.tokens))
const usedTitle = computed(() => {
  const t = props.s.tokens
  return t && used.value ? `Tokens this session used so far: ${t.in.toLocaleString()} input (${(t.cacheRead ?? 0).toLocaleString()} of them read from the cache), ${t.out.toLocaleString()} output` : ''
})
const rep = ref<Report | null>(null)
const err = ref('')
const open = ref(false)
const box = ref<HTMLElement>()

const COLOR: Record<string, string> = {
  overhead: 'var(--color-chip-gray-fg)',
  you: 'var(--color-chip-accent-fg)',
  replies: 'var(--color-chip-blue-fg)',
  thinking: 'var(--color-chip-violet-fg)',
  toolCalls: 'color-mix(in oklab, var(--color-chip-green-fg) 55%, var(--color-chip-gray-fg))',
  toolOutput: 'var(--color-chip-green-fg)',
  skills: 'var(--color-chip-amber-fg)',
  subagents: 'var(--color-chip-red-fg)',
  peers: 'color-mix(in oklab, var(--color-chip-red-fg) 50%, var(--color-chip-amber-fg))',
}
const color = (k: string) => COLOR[k] ?? 'color-mix(in oklab, var(--color-chip-gray-fg) 60%, transparent)'
const k = (n: number) => (n >= 999_500 ? `${(n / 1e6).toFixed(2)}M` : n >= 9_950 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const hm = (t: number) => new Date(t).toTimeString().slice(0, 5)
const label = computed(() => {
  const r = rep.value
  if (!r) return ''
  return r.window ? `${k(r.total)} / ${k(r.window)} · ${Math.round(r.percent ?? 0)}%` : `${k(r.total)} tokens`
})
const tone = computed(() => {
  const p = rep.value?.percent ?? 0
  return p >= 80 ? 'var(--color-chip-red-fg)' : p >= 50 ? 'var(--color-chip-amber-fg)' : 'var(--color-chip-green-fg)'
})
const base = computed(() => Math.max(1, rep.value?.window ?? rep.value?.total ?? 1))

let timer: ReturnType<typeof setTimeout> | undefined
let loading = false
async function load() {
  if (props.s.tool === 'agy') return void (err.value = 'not available for agy')
  if (loading || !props.s.sessionId) return
  loading = true
  try {
    const r = await api<{ report: Report | null; unavailable?: string }>(`/api/context?session=${encodeURIComponent(props.s.key)}`)
    rep.value = r.report
    err.value = r.report ? '' : (r.unavailable ?? '')
  } catch (e: any) {
    err.value = e.message
  } finally {
    loading = false
  }
}
// tokens change after every request: read again then, at most every few seconds
watch(
  () => [props.s.sessionId, props.s.tokens?.in, props.s.tokens?.out],
  () => {
    clearTimeout(timer)
    timer = setTimeout(load, 1500)
  },
)
function toggle() {
  open.value = !open.value
  if (open.value) void load()
}
const away = (e: MouseEvent) => open.value && box.value && !box.value.contains(e.target as Node) && (open.value = false)
onMounted(() => {
  void load()
  document.addEventListener('mousedown', away)
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  document.removeEventListener('mousedown', away)
})
</script>

<template>
  <div v-if="rep || err" ref="box" class="relative flex-none" data-context-meter>
    <button v-if="rep" class="inline-flex items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5 text-[11.5px] tabular-nums text-ink-soft hover:border-line-strong"
      :title="`Context: ${rep.total.toLocaleString()} tokens${rep.window ? ` of ${rep.window.toLocaleString()} (${rep.windowNote})` : ''}${used ? `. Used so far: ${used}` : ''}. Click for what fills it.`" @click="toggle">
      <span v-if="!compact || !rep.window" class="text-faint">Context</span>
      <span v-if="rep.window" class="relative h-1.5 w-10 overflow-hidden rounded-full bg-[var(--color-chip-gray-bg)]">
        <span class="absolute inset-y-0 left-0 rounded-full" :style="{ width: Math.min(100, rep.percent ?? 0) + '%', background: tone }"></span>
      </span>
      {{ compact && rep.window ? `${Math.round(rep.percent ?? 0)}%` : label }}
    </button>
    <span v-else class="whitespace-nowrap text-[11.5px] text-faint" :title="[err, usedTitle].filter(Boolean).join('. ')">Context: {{ err.startsWith('not available') ? 'not available for agy' : 'none yet' }}</span>
    <div v-if="open && rep" class="absolute left-0 top-full z-30 mt-1.5 w-[440px] max-w-[85vw] rounded-lg border border-line bg-surface p-3 text-[12.5px] text-ink shadow-lg" data-context-popover>
      <div class="flex items-baseline gap-2">
        <span class="font-semibold">{{ rep.total.toLocaleString() }} tokens</span>
        <span v-if="rep.window" class="text-muted">of {{ k(rep.window) }} · {{ rep.percent }}%</span>
        <span class="flex-1"></span>
        <span v-if="rep.sinceCompact && rep.compactedAt" class="text-[11.5px] text-faint">since last compact, {{ hm(rep.compactedAt) }}</span>
      </div>
      <div v-if="used" class="mt-0.5 text-[11.5px] tabular-nums text-faint" :title="usedTitle" data-context-used>Used so far: {{ used }}<template v-if="s.tokens?.cacheRead"> · {{ k(s.tokens.cacheRead) }} of the input read from the cache</template></div>
      <div class="mt-2 flex h-3 w-full overflow-hidden rounded bg-[var(--color-chip-gray-bg)]">
        <span v-for="c in rep.categories" :key="c.key" class="h-full" :style="{ width: (c.tokens / base) * 100 + '%', background: color(c.key) }" :title="`${c.label}: ${c.tokens.toLocaleString()}`"></span>
      </div>
      <div v-if="rep.window" class="mt-1 text-[11px] text-faint">{{ k(Math.max(0, rep.window - rep.total)) }} free · {{ rep.windowNote }}</div>
      <table class="mt-2 w-full border-collapse text-[12px]">
        <tbody>
          <template v-for="c in rep.categories" :key="c.key">
            <tr>
              <td class="py-0.5 pr-2"><span class="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" :style="{ background: color(c.key) }"></span>{{ c.label }}</td>
              <td class="py-0.5 text-right tabular-nums">{{ k(c.tokens) }}</td>
              <td class="w-12 py-0.5 text-right tabular-nums text-faint">{{ Math.round((c.tokens / Math.max(1, rep.total)) * 100) }}%</td>
            </tr>
            <tr v-if="c.parts?.length">
              <td colspan="3" class="pb-1 pl-5 text-[11.5px] leading-snug text-faint">{{ c.parts.slice(0, 6).map((p) => `${p.label} ${k(p.tokens)}`).join(' · ') }}</td>
            </tr>
          </template>
        </tbody>
      </table>
      <div v-if="rep.top.length" class="mt-2 border-t border-line pt-2">
        <div class="mb-1 text-[11.5px] font-semibold text-ink-soft">Biggest items</div>
        <div v-for="(t, i) in rep.top" :key="i" class="flex items-center gap-2 py-0.5 text-[12px]">
          <span class="inline-block h-2 w-2 flex-none rounded-sm" :style="{ background: color(t.cat) }"></span>
          <span class="min-w-0 flex-1 truncate" :title="t.label">{{ t.label }}</span>
          <span class="flex-none tabular-nums">{{ k(t.tokens) }}</span>
          <span class="w-10 flex-none text-right tabular-nums text-faint">{{ hm(t.at) }}</span>
        </div>
      </div>
      <p class="mt-2 text-[11px] leading-snug text-faint">Read from the transcript; nothing was typed into the session. The total is the last request's exact input plus what came after it. The parts are estimates scaled to fit that total.</p>
    </div>
  </div>
</template>
