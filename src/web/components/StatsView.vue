<script setup lang="ts">
// Stats [T1110-84] [T1110-89]: what the agents did in the last 24 hours or the last 7 days (rolling windows;
// the switch drives the whole view, the chart included). Computed by the server from this computer's own data
// (GET /api/stats); nothing leaves it. Working time is the CLIs' own turn durations.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ago, api, deck, openSession, select, topUse } from '../deck'

type Tool = 'claude' | 'codex' | 'agy'
type RangeId = '24h' | '7d'
type Range = {
  buckets: string[]
  since: number
  tools: Record<Tool, { active: number; started: number; workMs: number | null; series: number[] | null }>
  messages: { count: number; series: number[]; pairs: { from: string; to: string; n: number }[] }
  projects: { name: string; workMs: number; active: number; started: number }[]
}
type Stats = {
  ranges: Record<RangeId, Range>
  waiting: { key: string; title: string; tool: Tool; project: string; since: number; reason: string | null }[]
  at: number
}
const data = ref<Stats | null>(null)
const err = ref('')
// saved before T1110-89 as today / week
const saved = localStorage.getItem('deck.statsRange')
const range = ref<RangeId>(saved === '7d' || saved === 'week' ? '7d' : '24h')
function setRange(r: RangeId) {
  range.value = r
  hover.value = null
  localStorage.setItem('deck.statsRange', r)
}
let t: ReturnType<typeof setInterval>
async function load() {
  try {
    data.value = await api<Stats>('/api/stats')
    err.value = ''
  } catch (e: any) {
    err.value = e.message
  }
}
onMounted(() => {
  load()
  t = setInterval(load, 10_000)
})
onUnmounted(() => clearInterval(t))

const TOOLS: { id: Tool; label: string }[] = [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }, { id: 'agy', label: 'agy' }]
// one colour per tool, the same in every chart (validated with the dataviz palette check, dark and light)
const COLOR: Record<'claude' | 'codex', string> = { claude: 'var(--viz-claude)', codex: 'var(--viz-codex)' }
const R = computed(() => data.value?.ranges[range.value] ?? null)
const span = computed(() => (range.value === '24h' ? 'in the last 24 hours' : 'in the last 7 days'))

function dur(ms: number) {
  const m = Math.round(ms / 60_000)
  if (ms > 0 && m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}
// bucket keys: YYYY-MM-DDTHH (an hour) or YYYY-MM-DD (a day), local time
const dateOf = (k: string) => (k.length > 10 ? new Date(`${k}:00:00`) : new Date(`${k}T12:00:00`))
const hourLabel = (k: string) => dateOf(k).toLocaleTimeString(undefined, { hour: 'numeric' })
function tick(k: string, i: number, n: number) {
  if (i === n - 1) return k.length > 10 ? 'now' : 'Today'
  if (k.length === 10) return dateOf(k).toLocaleDateString(undefined, { weekday: 'short' })
  return i % 6 === 2 ? hourLabel(k) : ''
}
function longLabel(k: string) {
  const d = dateOf(k)
  if (k.length === 10) return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
  const end = new Date(d.getTime() + 3600_000)
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric' })} to ${end.toLocaleTimeString(undefined, { hour: 'numeric' })}`
}

const tiles = computed(() => (!R.value ? [] : TOOLS.map((x) => ({ ...x, ...R.value!.tools[x.id] }))))

// working time per bucket (hour or day), Claude Code and Codex stacked (agy reports no turn times)
const chart = computed(() => {
  const r = R.value
  if (!r) return null
  const cols = r.buckets.map((k, i) => ({ k, claude: r.tools.claude.series?.[i] ?? 0, codex: r.tools.codex.series?.[i] ?? 0 }))
  const top = Math.max(0, ...cols.map((c) => c.claude + c.codex))
  if (!top) return { cols, ticks: [] as number[], max: 1 }
  // a clean step so the gridlines land on round values
  const M = 60_000
  const H = 60 * M
  const steps = [5 * M, 10 * M, 15 * M, 30 * M, H, 2 * H, 3 * H, 4 * H, 6 * H, 12 * H, 24 * H]
  const step = steps.find((s) => top / s <= 3) ?? 48 * H
  const max = Math.ceil(top / step) * step
  const ticks: number[] = []
  for (let v = step; v <= max; v += step) ticks.push(v)
  return { cols, ticks, max }
})
const hover = ref<number | null>(null)

const waiting = computed(() => data.value?.waiting ?? [])
const pairs = computed(() => (R.value?.messages.pairs ?? []).slice(0, 6))
const projects = computed(() => (R.value?.projects ?? []).filter((p) => p.workMs || p.active).slice(0, 8))
const projMax = computed(() => Math.max(1, ...projects.value.map((p) => p.workMs)))

const WINDOW: Record<string, string> = { five_hour: '5 hours', seven_day: 'week', seven_day_opus: 'week, Opus', seven_day_sonnet: 'week, Sonnet' }
const tone = (u: number) => (u >= 90 ? 'var(--color-chip-red-fg)' : u >= 70 ? 'var(--color-chip-amber-fg)' : 'var(--color-chip-green-fg)')
const resets = (at: number | null) => {
  if (!at) return ''
  const m = Math.max(0, Math.round((at - Date.now()) / 60_000))
  return m < 60 ? `resets in ${m}m` : m < 48 * 60 ? `resets in ${Math.floor(m / 60)}h` : `resets in ${Math.round(m / 1440)}d`
}

function openWaiting(w: Stats['waiting'][number]) {
  const s = deck.sessions.find((x) => x.key === w.key)
  if (s) select(s.key)
  else openSession(w.key)
}
</script>

<template>
  <div class="stats min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto max-w-4xl px-6 py-6">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">Stats</h2>
          <p class="text-[13px] text-muted">From this computer's sessions, transcripts and accounts. Nothing is sent anywhere.</p>
        </div>
        <div class="flex gap-1">
          <button class="btn btn-sm" :class="range === '24h' ? 'btn-primary' : 'btn-ghost'" @click="setRange('24h')">24 hours</button>
          <button class="btn btn-sm" :class="range === '7d' ? 'btn-primary' : 'btn-ghost'" @click="setRange('7d')">7 days</button>
        </div>
      </div>
      <p v-if="err" class="mt-3 text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}</p>
      <div v-if="!data && !err" class="mt-10 text-center text-[13px] text-faint">Counting…</div>

      <template v-if="data && R">
        <!-- per tool: active sessions (any with turns in the window), then started and working time -->
        <div class="mt-5 grid grid-cols-3 gap-3">
          <div v-for="x in tiles" :key="x.id" class="card px-4 py-3">
            <div class="flex items-center gap-1.5 text-[12px] font-medium text-muted">
              <span v-if="x.id !== 'agy'" class="size-2 rounded-full" :style="{ background: COLOR[x.id] }"></span>{{ x.label }}
            </div>
            <div class="mt-1.5 text-[22px] font-semibold leading-tight" :title="`Sessions with turns or activity ${span}`">{{ x.active }} <span class="text-[12px] font-normal text-muted">active</span></div>
            <div class="mt-0.5 text-[12.5px] text-ink-soft">
              {{ x.started }} started ·
              <template v-if="x.workMs !== null">{{ dur(x.workMs) }} working</template>
              <span v-else class="text-faint" title="agy does not record how long its turns take">working time not recorded</span>
            </div>
          </div>
        </div>

        <!-- working time per hour (24 hours) or per day (7 days): the one chart -->
        <section class="card mt-3 px-4 pb-3 pt-3">
          <div class="flex items-center justify-between">
            <div class="text-[13px] font-medium" title="The CLIs' own turn times, added up over every session, so sessions running side by side can add up to more than the hour or day itself">Agent working time per {{ range === '24h' ? 'hour' : 'day' }} <span class="font-normal text-faint">· {{ range === '24h' ? 'last 24 hours' : 'last 7 days' }}, all sessions added up</span></div>
            <div class="flex items-center gap-3 text-[12px] text-muted">
              <span class="flex items-center gap-1.5"><span class="size-2 rounded-[2px]" :style="{ background: COLOR.claude }"></span>Claude Code</span>
              <span class="flex items-center gap-1.5"><span class="size-2 rounded-[2px]" :style="{ background: COLOR.codex }"></span>Codex</span>
            </div>
          </div>
          <div v-if="chart && !chart.ticks.length" class="grid h-[140px] place-items-center text-[13px] text-faint">No agent turns {{ span }}.</div>
          <div v-else-if="chart" class="relative mt-3 flex h-[140px] pl-12" :class="range === '24h' ? 'gap-[2px]' : 'gap-2'" role="img" :aria-label="`Working time per ${range === '24h' ? 'hour' : 'day'}: ` + chart.cols.map((c) => `${longLabel(c.k)} Claude Code ${dur(c.claude)}, Codex ${dur(c.codex)}`).join('; ')">
            <!-- gridlines and their values -->
            <div v-for="v in chart.ticks" :key="v" class="pointer-events-none absolute left-12 right-0 border-t border-line" :style="{ bottom: (v / chart.max) * 100 + '%' }">
              <span class="absolute -left-12 -top-2 w-10 text-right text-[10.5px] tabular-nums text-faint">{{ dur(v) }}</span>
            </div>
            <div class="pointer-events-none absolute bottom-0 left-12 right-0 border-t border-line-strong"></div>
            <div
              v-for="(c, i) in chart.cols" :key="c.k"
              class="relative flex flex-1 flex-col items-center justify-end"
              @mouseenter="hover = i" @mouseleave="hover = null"
            >
              <div class="flex w-full max-w-[24px] flex-col-reverse gap-[2px]" :class="hover === i ? 'opacity-100' : hover !== null ? 'opacity-60' : ''">
                <div v-if="c.claude" class="w-full" :style="{ height: (c.claude / chart.max) * 136 + 'px', background: COLOR.claude, borderRadius: c.codex ? '0' : '4px 4px 0 0' }"></div>
                <div v-if="c.codex" class="w-full rounded-t-[4px]" :style="{ height: (c.codex / chart.max) * 136 + 'px', background: COLOR.codex }"></div>
              </div>
              <span class="absolute -bottom-5 whitespace-nowrap text-[10.5px]" :class="i === chart.cols.length - 1 ? 'font-medium text-ink-soft' : 'text-faint'">{{ tick(c.k, i, chart.cols.length) }}</span>
              <div v-if="hover === i" class="dialog pointer-events-none absolute bottom-full z-10 mb-2 w-max px-3 py-2 text-[12px] shadow-lg" :class="i > chart.cols.length / 2 ? 'right-0' : 'left-0'">
                <div class="font-medium">{{ longLabel(c.k) }}</div>
                <div class="mt-1 flex items-center gap-1.5 text-ink-soft"><span class="size-2 rounded-[2px]" :style="{ background: COLOR.claude }"></span>Claude Code <span class="ml-auto pl-3 tabular-nums">{{ dur(c.claude) }}</span></div>
                <div class="flex items-center gap-1.5 text-ink-soft"><span class="size-2 rounded-[2px]" :style="{ background: COLOR.codex }"></span>Codex <span class="ml-auto pl-3 tabular-nums">{{ dur(c.codex) }}</span></div>
              </div>
            </div>
          </div>
          <div class="h-6"></div>
        </section>

        <div class="mt-3 grid grid-cols-2 gap-3">
          <!-- waiting on you now -->
          <section class="card">
            <div class="flex items-center justify-between border-b border-line px-4 py-2.5">
              <div class="text-[13px] font-medium">Waiting on you now</div>
              <span class="text-[12px] tabular-nums text-muted">{{ waiting.length }}</span>
            </div>
            <div v-if="!waiting.length" class="px-4 py-4 text-[13px] text-faint">Nothing is waiting on you.</div>
            <button v-for="w in waiting" :key="w.key" class="flex w-full items-center gap-2 border-b border-line px-4 py-2 text-left last:border-b-0 hover:bg-[var(--color-row-hover)]" :title="w.reason ?? ''" @click="openWaiting(w)">
              <span class="size-2 flex-none rounded-full bg-[var(--color-st-wait)]"></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13px]">{{ w.title }}</span>
                <span class="block truncate text-[11.5px] text-faint">{{ w.project }}<template v-if="w.tool !== 'claude'"> · {{ w.tool }}</template><template v-if="w.reason"> · {{ w.reason }}</template></span>
              </span>
              <span class="flex-none text-[12px] tabular-nums" :class="Date.now() - w.since > 30 * 60_000 ? 'text-[var(--color-chip-amber-fg)]' : 'text-muted'">{{ ago(w.since) === 'now' ? 'just now' : ago(w.since) }}</span>
            </button>
          </section>

          <!-- messages between agents -->
          <section class="card">
            <div class="flex items-center justify-between border-b border-line px-4 py-2.5">
              <div class="text-[13px] font-medium">Messages between agents</div>
              <span class="text-[12px] tabular-nums text-muted">{{ R.messages.count }}</span>
            </div>
            <div v-if="!pairs.length" class="px-4 py-4 text-[13px] text-faint">No messages between sessions {{ span }}.</div>
            <div v-for="p in pairs" :key="p.from + '>' + p.to" class="flex items-center gap-1.5 border-b border-line px-4 py-2 text-[12.5px] last:border-b-0">
              <span class="min-w-0 truncate text-ink-soft">{{ p.from }}</span>
              <span class="flex-none text-faint">→</span>
              <span class="min-w-0 flex-1 truncate text-ink-soft">{{ p.to }}</span>
              <span class="flex-none tabular-nums text-muted">{{ p.n }}</span>
            </div>
          </section>

          <!-- busiest projects -->
          <section class="card">
            <div class="border-b border-line px-4 py-2.5 text-[13px] font-medium">Busiest projects</div>
            <div v-if="!projects.length" class="px-4 py-4 text-[13px] text-faint">No sessions {{ span }}.</div>
            <div v-for="p in projects" :key="p.name" class="border-b border-line px-4 py-2 last:border-b-0">
              <div class="flex items-center gap-2 text-[12.5px]">
                <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
                <span class="flex-none tabular-nums text-ink-soft">{{ dur(p.workMs) }}</span>
                <span class="w-16 flex-none text-right tabular-nums text-faint" :title="`${p.started} started ${span}`">{{ p.active }} active</span>
              </div>
              <div class="mt-1 h-1 overflow-hidden rounded-full bg-canvas-2"><div class="h-full rounded-full bg-[var(--color-brand-500)]" :style="{ width: (p.workMs / projMax) * 100 + '%' }"></div></div>
            </div>
          </section>

          <!-- usage per account: the same bars as the sidebar, every window -->
          <section class="card">
            <div class="border-b border-line px-4 py-2.5 text-[13px] font-medium">Usage per account <span class="font-normal text-faint">· now</span></div>
            <div v-if="!deck.accounts.length" class="px-4 py-4 text-[13px] text-faint">No accounts yet.</div>
            <div v-for="a in deck.accounts" :key="a.tool + ':' + a.name" class="border-b border-line px-4 py-2 last:border-b-0">
              <div class="flex items-center gap-2 text-[12.5px]">
                <span class="truncate font-medium" :class="a.email ? 'text-ink' : 'text-faint'">{{ a.name }}</span>
                <span class="text-[11px] text-faint">{{ a.tool === 'codex' ? 'codex' : 'claude' }}</span>
                <span class="min-w-0 flex-1 truncate text-right text-[11.5px] text-faint">{{ a.loggingIn ? 'logging in…' : a.email || a.error || '' }}</span>
              </div>
              <div v-for="(w, k) in a.windows ?? {}" :key="k" class="mt-1 flex items-center gap-2 text-[11.5px]" :title="resets(w.resetsAt)">
                <span class="w-24 flex-none text-faint">{{ WINDOW[k] ?? k }}</span>
                <div class="h-1 flex-1 overflow-hidden rounded-full bg-canvas-2"><div class="h-full rounded-full" :style="{ width: Math.min(100, w.used) + '%', background: tone(w.used) }"></div></div>
                <span class="w-9 flex-none text-right tabular-nums text-muted">{{ Math.round(w.used) }}%</span>
              </div>
              <div v-if="!a.windows || !Object.keys(a.windows).length" class="mt-1 text-[11.5px] text-faint">{{ topUse(a) == null ? 'no usage reported yet' : '' }}</div>
            </div>
          </section>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* tool colours for the chart (dataviz palette slots: orange for Claude Code, blue for Codex) */
.stats { --viz-claude: #d95926; --viz-codex: #3987e5; }
:root[data-theme='light'] .stats { --viz-claude: #eb6834; --viz-codex: #2a78d6; }
</style>
