<script setup lang="ts">
// A session the deck has no terminal for: open in a Terminal tab, in the background, or past.
// Past ones resume here. Running ones get "Copy here" (a fork), because resuming a conversation
// that is open somewhere else would put two copies on it.
import { computed, onMounted, ref, watch } from 'vue'
import { Copy, Play, GitFork, ArrowRightToLine, FolderInput, Square, EyeOff } from 'lucide-vue-next'
import StatusPill from './StatusPill.vue'
import SettingsLink from './SettingsLink.vue'
import { STATUS, pillOf, accountsFor, ago, agoText, api, openSession, autoLabel, bestAccount, copy, deck, refresh, select, selectNeighbour, startSession, topUse, type Session } from '../deck'

const props = defineProps<{ s: Session }>()
const account = ref(bestAccount())
const err = ref('')
const busy = ref(false)
const live = computed(() => props.s.where === 'terminal' || props.s.where === 'background')
const where = computed(() => ({ terminal: 'Open in a Terminal tab', background: 'Running in the background (claude --bg)', past: 'Not running', deck: 'Ended' })[props.s.where])
// what it was about: facts, prompts, the last exchanges, its tasks and messages (GET /api/summary)
type Summary = {
  tool: 'claude' | 'codex' | 'agy'; aiTitle: string | null; startedAt: number | null; lastAt: number | null
  account: string | null; email: string | null; model: string | null; turns: number | null; tokens: number | null
  firstPrompt: string | null; lastPrompt: string | null; transcript: string | null; partial: boolean; lastReply: string | null
  exchanges: { at: number | null; you: string; reply: string | null }[]
  tasks: { done: boolean; id: string | null; date: string | null; text: string; section: string; file: string }[]
  talk: { at: number; dir: 'to' | 'from'; who: string; session: string | null; text: string }[]
}
const sum = ref<Summary | null>(null)
async function loadSummary() {
  if (!props.s.sessionId) return
  try {
    sum.value = await api<Summary>(`/api/summary?id=${props.s.sessionId}`)
  } catch {}
}
onMounted(loadSummary)
watch(() => props.s.last, loadSummary)
const when = (ms: number) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
function span(ms: number) {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'under a minute'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
const tool = computed(() => ({ claude: 'Claude Code', codex: 'Codex', agy: 'agy' })[sum.value?.tool ?? props.s.tool ?? 'claude'])
const toolName = computed(() => (sum.value?.tool ?? props.s.tool ?? 'claude') === 'claude' ? 'Claude' : tool.value)
const lastAt = computed(() => Math.max(sum.value?.lastAt ?? 0, props.s.last))
const accountLabel = computed(() => {
  const a = props.s.account || sum.value?.account
  const e = sum.value?.email
  return a ? (e ? `${a} · ${e}` : a) : e
})
// the first prompt is worth its own line only when the exchanges below don't start with it
const showFirst = computed(() => sum.value?.firstPrompt && !sum.value.exchanges.some((x) => x.you.startsWith(sum.value!.firstPrompt!.slice(0, 120))))
const openTasks = computed(() => sum.value?.tasks.filter((t) => !t.done) ?? [])
const doneTasks = computed(() => sum.value?.tasks.filter((t) => t.done) ?? [])
const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`)

const resumeCmd = computed(() => `cd ${props.s.cwd} && claude --resume ${props.s.sessionId}`)

async function resume() {
  busy.value = true
  err.value = ''
  try {
    await startSession({ tool: props.s.tool ?? 'claude', cwd: props.s.cwd, account: account.value, name: props.s.title, resume: props.s.sessionId!, fork: live.value })
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
async function move() {
  if (!confirm(`Move "${props.s.title}" into the deck? Its Terminal tab will exit, and the same conversation continues here.`)) return
  busy.value = true
  err.value = ''
  try {
    const r = await api<{ tmux: string }>('/api/sessions/move', { sessionId: props.s.sessionId, account: account.value, cwd: props.s.cwd })
    await refresh()
    select(r.tmux)
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
async function act(fn: () => Promise<unknown>) {
  busy.value = true
  err.value = ''
  try {
    await fn()
    selectNeighbour(props.s.key)
    await refresh()
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
const hideIt = () => act(() => api('/api/hide', { sessionId: props.s.sessionId }))
const bgStop = () => act(() => api(`/api/bg/${props.s.sessionId}/stop`, {}))
async function forget() {
  await api(`/api/sessions/${props.s.key}/forget`, {})
  selectNeighbour(props.s.key)
  refresh()
}
</script>

<template>
  <div class="p-8">
    <div class="card mx-auto max-w-2xl p-6">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h2 class="truncate text-lg font-semibold">{{ s.title }}</h2>
          <p class="pill-mono mt-1 truncate text-muted">{{ s.cwd }}</p>
        </div>
        <StatusPill :label="s.where === 'past' ? 'Past' : pillOf(s).label" :tone="s.where === 'past' ? 'gray' : pillOf(s).tone" :pulse="pillOf(s).pulse" />
      </div>

      <dl class="mt-5 grid grid-cols-[120px_1fr] gap-y-2 text-[13.5px]">
        <dt class="text-muted">Where</dt><dd>{{ where }}</dd>
        <dt class="text-muted">Tool</dt><dd>{{ tool }}<span v-if="sum?.model" class="text-muted"> · {{ sum.model }}</span></dd>
        <template v-if="sum?.startedAt">
          <dt class="text-muted">Started</dt><dd>{{ when(sum.startedAt) }} <span class="text-muted">· {{ agoText(sum.startedAt) }}</span></dd>
        </template>
        <dt class="text-muted">Last active</dt><dd>{{ when(lastAt) }} <span class="text-muted">· {{ agoText(lastAt) }}</span></dd>
        <template v-if="sum?.startedAt">
          <dt class="text-muted">Ran for</dt>
          <dd>{{ span(lastAt - sum.startedAt) }}<span v-if="sum.turns" class="text-muted"> · {{ sum.turns }} turns</span><span v-if="sum.tokens" class="text-muted"> · {{ fmtTokens(sum.tokens) }} tokens</span></dd>
        </template>
        <template v-if="accountLabel">
          <dt class="text-muted">Account</dt><dd class="truncate">{{ accountLabel }}</dd>
        </template>
        <template v-if="s.project">
          <dt class="text-muted">Project</dt><dd>{{ s.here ? s.hereProject : s.project }}</dd>
        </template>
        <template v-if="s.waitingReason">
          <dt class="text-muted">Needs you</dt><dd>{{ s.waitingReason }}</dd>
        </template>
      </dl>

      <p v-if="live && s.where === 'terminal'" class="mt-5 rounded-lg bg-canvas-2 px-3 py-2 text-[13px] text-ink-soft">
        It is open in a Terminal tab, so its screen can't show here. <b>Move here</b> closes it there and continues the same conversation in the deck.
        <span v-if="s.status === 'busy'" class="text-[var(--color-chip-amber-fg)]">It is working now; you can move it once it is idle.</span>
        <span v-else-if="s.bg" class="text-[var(--color-chip-amber-fg)]">Its turn is done, but Claude Code still lists a background shell or agent. Moving stops those.</span>
      </p>
      <p v-else-if="live" class="mt-5 rounded-lg bg-canvas-2 px-3 py-2 text-[13px] text-ink-soft">
        It runs in the background (<code class="pill-mono">claude --bg</code>). <b>Copy here</b> starts a deck session that continues from it; the background one keeps going.
      </p>

      <div v-if="s.sessionId" class="mt-5 flex flex-wrap items-end gap-3">
        <label class="min-w-[240px] flex-1 text-[12px] text-muted">
          Account
          <select v-model="account" class="input mt-1 !py-2">
            <option value="auto">{{ autoLabel() }}</option>
            <option v-for="a in accountsFor('claude')" :key="a.name" :value="a.name" :disabled="a.paused">
              {{ a.name }}{{ a.paused ? ' · paused' : '' }}{{ a.email ? ' · ' + a.email : '' }}{{ topUse(a) != null ? ` · ${Math.round(topUse(a)!)}% used` : '' }}
            </option>
          </select>
        </label>
        <button v-if="s.where === 'terminal'" class="btn btn-brand" :disabled="busy || s.status === 'busy'" @click="move">
          <ArrowRightToLine :size="15" /> Move here
        </button>
        <button v-if="live" class="btn" :class="s.where === 'terminal' ? 'btn-ghost' : 'btn-brand'" :disabled="busy || s.noTranscript" title="A new deck session that continues from this conversation; the original keeps running" @click="resume">
          <GitFork :size="15" /> Copy here
        </button>
        <button v-else class="btn btn-brand" :disabled="busy" @click="resume"><Play :size="15" /> Resume here</button>
      </div>
      <p v-if="s.noTranscript" class="mt-3 text-[13px] text-[var(--color-chip-amber-fg)]">Its conversation file is gone (Claude Code deletes old ones), so it can't be copied or resumed. Hide it to clear it from the list.</p>
      <p v-if="err" class="mt-3 text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}<SettingsLink :text="err" /></p>

      <div class="mt-5 flex gap-2 border-t border-line pt-4">
        <button v-if="s.sessionId && s.where !== 'background'" class="btn btn-ghost btn-sm" @click="deck.moveFor = s"><FolderInput :size="13" /> Move to another folder</button>
        <button v-if="s.sessionId" class="btn btn-ghost btn-sm" @click="copy(resumeCmd)"><Copy :size="13" /> Copy resume command</button>
        <button v-if="s.where === 'deck'" class="btn btn-ghost btn-sm" @click="forget"><EyeOff :size="13" /> Hide</button>
        <button v-if="s.where === 'background' && s.status !== 'blocked'" class="btn btn-ghost btn-sm" :disabled="busy" title="claude stop: ends it, keeps the conversation" @click="bgStop"><Square :size="13" /> Stop</button>
        <button v-if="s.where !== 'deck' && s.sessionId" class="btn btn-ghost btn-sm" :disabled="busy" title="Hide it here until it does something new" @click="hideIt"><EyeOff :size="13" /> Hide</button>
      </div>

      <template v-if="sum">
        <section class="mt-6">
          <div class="col-label mb-2">What it was doing</div>
          <p v-if="sum.aiTitle && sum.aiTitle !== s.title" class="mb-3 text-[13.5px] text-ink-soft">{{ sum.aiTitle }}</p>
          <div v-if="showFirst" class="mb-3 text-[13px]">
            <div class="text-[11.5px] text-faint">First prompt</div>
            <p class="whitespace-pre-wrap break-words">{{ sum.firstPrompt }}</p>
          </div>
          <p v-if="sum.exchanges.length" class="mb-2 text-[11.5px] text-faint">The last {{ sum.exchanges.length === 1 ? 'exchange' : sum.exchanges.length + ' exchanges' }}</p>
          <div v-for="(x, i) in sum.exchanges" :key="i" class="mb-3 rounded-lg border border-line px-3 py-2 text-[13px]">
            <div class="text-[11.5px] text-faint">You<span v-if="x.at"> · {{ when(x.at) }}</span></div>
            <p class="whitespace-pre-wrap break-words">{{ x.you }}</p>
            <template v-if="x.reply">
              <div class="mt-2 text-[11.5px] text-faint">{{ toolName }}</div>
              <p class="whitespace-pre-wrap break-words text-ink-soft">{{ x.reply }}</p>
            </template>
          </div>
          <div v-if="sum.lastReply" class="mb-3 rounded-lg border border-line px-3 py-2 text-[13px]">
            <div class="text-[11.5px] text-faint">{{ toolName }}'s latest reply</div>
            <p class="whitespace-pre-wrap break-words text-ink-soft">{{ sum.lastReply }}</p>
          </div>
          <template v-if="!sum.exchanges.length">
            <p v-if="sum.lastPrompt" class="text-[13px]"><span class="text-faint">Last prompt: </span><span class="whitespace-pre-wrap break-words">{{ sum.lastPrompt }}</span></p>
            <p class="mt-1 text-[12.5px] text-faint">{{ sum.tool !== 'claude' ? `The deck does not read ${tool} transcripts yet.` : sum.transcript ? 'No messages from you in the end of its transcript.' : 'Its transcript file is not on this computer.' }}</p>
          </template>
        </section>

        <section v-if="sum.tasks.length" class="mt-5">
          <div class="col-label mb-2">Tasks</div>
          <ul class="space-y-1 text-[13px]">
            <li v-for="(t, i) in [...openTasks, ...doneTasks]" :key="i" class="flex gap-2" :title="t.file">
              <span class="flex-none" :class="t.done ? 'text-[var(--color-chip-green-fg)]' : 'text-faint'">{{ t.done ? '✓' : '○' }}</span>
              <span class="min-w-0 break-words" :class="t.done ? 'text-muted' : ''"><span v-if="t.id" class="pill-mono mr-1.5 text-faint">{{ t.id }}</span>{{ t.text }}<span v-if="t.section === 'waiting'" class="text-[var(--color-chip-amber-fg)]"> · waiting on you</span></span>
            </li>
          </ul>
        </section>

        <section v-if="sum.talk.length" class="mt-5">
          <div class="col-label mb-2">Messages with other sessions</div>
          <ul class="space-y-1.5 text-[13px]">
            <li v-for="(m, i) in sum.talk" :key="i" class="break-words">
              <span class="text-faint">{{ m.dir === 'to' ? 'To' : 'From' }} </span>
              <button v-if="m.session" class="font-medium hover:underline" @click="openSession(m.session)">{{ m.who }}</button><b v-else class="font-medium">{{ m.who }}</b>
              <span class="text-faint"> · {{ agoText(m.at) }}: </span>{{ m.text }}
            </li>
          </ul>
        </section>
      </template>
    </div>
  </div>
</template>
