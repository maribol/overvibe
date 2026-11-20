<script setup lang="ts">
// Requests [T1113-3]: what customers asked in the Telegram groups linked to a project, each with its research, verdict,
// plan and draft reply. Apart from TASKS.md: a line goes there only on Add task or Start session. The same actions
// as the Telegram buttons, and the Telegram message follows whichever you use.
// Help cards from an add-on are a second kind here: an AI employee could not do a job with a tool; Add task,
// Start session, Reply and Won't fix act on the card (the add-on), and it hears each one.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Inbox } from 'lucide-vue-next'
import Spinner from './Spinner.vue'
import { ago, api, deck, refresh, select } from '../deck'

type Kind = 'question' | 'bug' | 'feature' | 'chatter'
type Worth = 'yes' | 'no' | 'unsure' | 'n/a'
type Row = { updates?: number; rid: string; at: number; chat: string; project: string; cwd: string; from: string[]; kind: Kind; worth: Worth; call: string; effort: string; summary: string; task: string; done: string[]; taskId: string | null; session: string | null; canReply: boolean }
type Said = { at: number; from: string; text: string; owner?: boolean; replyTo?: string }
type Help = { id: string; key: string; at: number; employee: { name: string; picture: string | null }; tool: string; reason: string; what: string; command: string | null; error: string | null; trace: string | null; project: string | null; status: string; repo: string | null; taskId: string | null; done: string[]; session: string | null; closed: boolean; resolved: { at: number; text: string; commit: string | null } | null; replies: { at: number; act: 'reply' | 'wontfix'; text: string }[]; link: string | null }
type Item = { type: 'tg'; pick: string; at: number; r: Row } | { type: 'help'; pick: string; at: number; h: Help }
type Full = Row & { v: { summary: string; answer: string; why: string; brand: string; effort: string; plan: string; reply: string; worth: Worth }; msgs: Said[]; sent: string | null; file: string; /** its session's conversation, found by its first message [T1119-22] */ conversation?: string | null }

const rows = ref<Row[] | null>(null)
const helps = ref<Help[]>([])
const pick = ref<string>('')
const one = ref<Full | null>(null)
const help = ref<Help | null>(null)
const helpText = ref('')
const draft = ref('')
const busy = ref('')
const msg = ref('')
const show = ref<'open' | 'all'>('open')

// Telegram messages on their way to a report: gathering, queued or researching [T1118-10]
type Researching = { key: string; chat: string; project: string; from: string[]; text: string; at: number; state: 'gathering' | 'queued' | 'researching' | 'failed'; error?: string; steps: { at: number; text: string }[]; msgs: { from: string; at: number; text: string }[]; since: number }
// the in-flight card open on the right (its messages, while the run works)
const flight = computed(() => (pick.value.startsWith('rf:') ? inFlight.value.find((f) => f.key === pick.value.slice(3)) ?? null : null))
const inFlight = ref<Researching[]>([])
const stateText = { gathering: 'Waiting for more messages', queued: 'Queued', researching: 'Researching…', failed: 'Failed' }
const stateClass = (st: Researching['state']) => (st === 'researching' ? 'text-[var(--color-st-busy)]' : st === 'failed' ? 'text-[var(--color-danger)]' : 'text-muted')
async function failedAct(key: string, act: 'retry' | 'dismiss') {
  busy.value = act
  try {
    await api('/api/requests/act', { failed: key, act })
    await load()
  } catch (e: any) {
    msg.value = e.message
  } finally {
    busy.value = ''
  }
}
async function startNow(key: string, act: 'research' | 'session' = 'research') {
  busy.value = act === 'session' ? 'session' : 'start'
  try {
    const r = await api<{ session?: string; account?: string }>('/api/requests/act', { gathering: key, act })
    if (r.session) msg.value = `Started "${r.session}" on ${r.account}.`
    await load()
  } catch (e: any) {
    msg.value = e.message
  } finally {
    busy.value = ''
  }
}
async function load() {
  const r = await api<{ requests: Row[]; help?: Help[]; researching?: Researching[] }>('/api/requests')
  const had = inFlight.value.length
  inFlight.value = r.researching ?? []
  // poll faster while something is in flight, so its report shows up soon after it lands
  if (!!had !== !!inFlight.value.length) restartPoll()
  rows.value = r.requests
  helps.value = r.help ?? []
  if (help.value) help.value = helps.value.find((h) => h.id === help.value!.id) ?? help.value
  // the top row is selected first: an in-flight one when there is one, as in the list [T1119-7]; one whose report just
  // landed moves to the newest row (its report)
  const gone = pick.value.startsWith('rf:') && !inFlight.value.some((f) => 'rf:' + f.key === pick.value)
  if (!pick.value || gone) pick.value = inFlight.value[0] ? 'rf:' + inFlight.value[0].key : list.value[0]?.pick ?? ''
}
const items = computed((): Item[] => [...(rows.value ?? []).map((r) => ({ type: 'tg' as const, pick: `tg:${r.rid}`, at: r.at, r })), ...helps.value.map((h) => ({ type: 'help' as const, pick: `help:${h.id}`, at: h.at, h }))].sort((a, b) => b.at - a.at))
// a reply alone keeps a bug or feature open: it still waits on a task, a session or Skip (src/telegram.ts isOpen) [T1118-18]
const tgOpen = (r: Row) => !r.done.some((d) => d !== 'send') && (!r.done.includes('send') || r.kind === 'bug' || r.kind === 'feature')
// per Telegram group [T1118-22]: a filter over the list, and the group's other requests under each one
const groupQ = ref('')
const groupsSeen = computed(() => [...new Set((rows.value ?? []).map((r) => r.chat))].sort())
const sameGroup = computed(() => (one.value ? (rows.value ?? []).filter((r) => r.chat === one.value!.chat && r.rid !== one.value!.rid).sort((a, b) => b.at - a.at).slice(0, 10) : []))
const list = computed(() => items.value.filter((x) => !groupQ.value || (x.type === 'tg' && x.r.chat === groupQ.value)).filter((x) => show.value === 'all' || !(x.type === 'tg' ? !tgOpen(x.r) : x.h.done.length || x.h.closed)))
watch(pick, async (p) => {
  msg.value = ''
  helpText.value = ''
  const rid = p.startsWith('tg:') ? p.slice(3) : ''
  help.value = p.startsWith('help:') ? helps.value.find((h) => h.id === p.slice(5)) ?? null : null
  one.value = rid ? await api<Full>(`/api/requests?rid=${encodeURIComponent(rid)}`).catch(() => null) : null
  draft.value = one.value?.v.reply ?? ''
})
async function helpAct(what: 'task' | 'start' | 'reply' | 'wontfix' | 'close') {
  if (!help.value) return
  busy.value = what
  msg.value = ''
  try {
    const r = await api<{ msg: string; help: Help }>('/api/requests/act', { help: help.value.id, act: what, ...(what === 'reply' || what === 'wontfix' ? { text: helpText.value } : {}) })
    help.value = r.help
    msg.value = r.msg
    if (what === 'reply' || what === 'wontfix') helpText.value = ''
    await load()
    if (what === 'start' && r.help.session) {
      await refresh()
      select(r.help.session)
    } else refresh()
  } catch (e: any) {
    msg.value = e.message
  } finally {
    busy.value = ''
  }
}
const REASON: Record<string, string> = { refused: 'Refused', missing: 'Missing command', bug: 'Bug', access: 'Missing access' }
const HELP_STATE: Record<string, string> = { open: '', task_added: 'Task added', in_progress: 'Fixing', resolved: 'Resolved', wont_fix: "Won't fix" }
const helpSessionKey = computed(() => help.value?.session && deck.sessions.find((s) => s.tmux === help.value!.session)?.key)
/** Resume the conversation of a request's closed session in a new row, unhidden, and open it [T1119-22] */
async function resumeIt(sessionId: string) {
  busy.value = 'resume'
  msg.value = ''
  try {
    await api('/api/hide', { sessionId, hide: false })
    const r = await api<{ tmux?: string; key?: string }>('/api/resume', { target: sessionId })
    await refresh()
    const k = r.key ?? r.tmux
    if (k) select(k)
  } catch (e: any) {
    msg.value = e.message
  } finally {
    busy.value = ''
  }
}
async function act(what: 'send' | 'task' | 'start' | 'skip') {
  if (!one.value) return
  busy.value = what
  msg.value = ''
  try {
    const r = await api<{ msg: string; request: Full }>('/api/requests/act', { rid: one.value.rid, act: what, ...(what === 'send' ? { text: draft.value } : {}) })
    one.value = r.request
    msg.value = r.msg
    await load()
    // Start session opens the new session, like New does [T1116-6]
    if (what === 'start' && r.request.session) {
      await refresh()
      select(r.request.session)
    } else refresh()
  } catch (e: any) {
    msg.value = e.message
  } finally {
    busy.value = ''
  }
}
const did = (what: string) => !!one.value?.done.includes(what)
const KIND: Record<Kind, string> = { question: 'Question', bug: 'Bug', feature: 'Feature request', chatter: 'Chatter' }
// "unsure" means the agent leaves the decision to the owner: its call line says what would decide it
const WORTH: Record<Worth, string> = { yes: 'Worth building', no: 'Not worth building', unsure: 'Your call', 'n/a': '' }
const worthClass = (w: Worth) => (w === 'yes' ? 'text-[var(--color-chip-green-fg)]' : w === 'no' ? 'text-[var(--color-chip-red-fg)]' : 'text-[var(--color-chip-amber-fg)]')
const stateOf = (r: Row) => (r.done.includes('skip') ? 'Skipped' : r.done.includes('start') ? 'Building' : r.done.includes('task') ? 'Task added' : r.done.includes('send') ? 'Answered' : '')
// its session's row, running, stopped or suspended; none when it was closed (hidden) [T1119-21]
const sessionKey = computed(() => one.value?.session && deck.sessions.find((s) => s.key === one.value!.session || s.tmux === one.value!.session || (!!one.value!.conversation && s.sessionId === one.value!.conversation && s.where !== 'past'))?.key)
/** started once, but that session was closed: Start session starts a new one */
const startedGone = computed(() => did('start') && !sessionKey.value)

let t: ReturnType<typeof setInterval> | undefined
function restartPoll() {
  clearInterval(t)
  t = setInterval(() => void load().catch(() => {}), inFlight.value.length ? 3000 : 10_000)
}
onMounted(() => {
  void load()
  restartPoll()
})
onUnmounted(() => clearInterval(t))
</script>

<template>
  <div class="flex min-h-0 flex-1">
    <!-- the list -->
    <div class="flex w-80 flex-none flex-col border-r border-line">
      <div class="flex items-center justify-between gap-2 px-4 pb-2 pt-5">
        <h2 class="text-lg font-semibold">Requests</h2>
        <div class="flex gap-1 text-[12px]">
          <button class="rounded px-2 py-0.5" :class="show === 'open' ? 'bg-[var(--color-row-sel)] font-medium' : 'text-muted'" @click="show = 'open'">Open</button>
          <button class="rounded px-2 py-0.5" :class="show === 'all' ? 'bg-[var(--color-row-sel)] font-medium' : 'text-muted'" @click="show = 'all'">All</button>
        </div>
      </div>
      <div v-if="groupsSeen.length > 1" class="border-b border-line px-4 pb-2.5"><select v-if="groupsSeen.length > 1" v-model="groupQ" class="input !py-1 !text-[12.5px]" title="Only one Telegram group" data-group-filter>
          <option value="">All groups</option>
          <option v-for="g in groupsSeen" :key="g" :value="g">{{ g }}</option>
        </select></div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div v-if="rows && !list.length && !inFlight.length" class="px-4 py-6 text-[13px] text-faint">
          <Inbox :size="18" class="mb-2" />
          {{ show === 'open' ? 'Nothing open.' : 'No requests yet.' }} When a customer writes in a linked Telegram group, the research and plan show up here.
        </div>
        <button v-for="f in inFlight" :key="f.key" class="block w-full border-b border-line px-4 py-2.5 text-left hover:bg-[var(--color-row-hover)]" :class="pick === 'rf:' + f.key ? 'bg-[var(--color-row-sel)]' : ''" data-researching @click="pick = 'rf:' + f.key">
          <div class="flex items-center gap-2 text-[11.5px]">
            <Spinner v-if="f.state === 'researching'" :size="12" class="flex-none" />
            <span class="font-medium" :class="stateClass(f.state)">{{ stateText[f.state] }}</span>
            <span class="text-faint">{{ f.project || f.chat }}</span>
            <span class="ml-auto text-faint">{{ ago(f.at) }}</span>
          </div>
          <div class="mt-1 line-clamp-2 text-[13px] text-ink-soft">{{ f.text }}</div>
          <span v-if="f.state === 'gathering'" role="button" tabindex="0" class="btn btn-soft btn-sm mt-1.5" data-start-now title="Research these messages now instead of waiting for a quiet minute" @click.stop="startNow(f.key)" @keydown.enter.stop="startNow(f.key)">Start now</span>
          <span v-if="f.state === 'gathering'" role="button" tabindex="0" class="btn btn-ghost btn-sm ml-1.5 mt-1.5" data-start-session title="Skip the research: start an Overvibe session in the project on these messages" @click.stop="startNow(f.key, 'session')" @keydown.enter.stop="startNow(f.key, 'session')">Start session</span>
          <div class="mt-1 text-[11.5px] text-faint">{{ f.from.join(', ') }} · {{ f.chat }}</div>
        </button>
        <template v-for="x in list" :key="x.pick">
        <button v-if="x.type === 'help'" class="block w-full border-b border-line px-4 py-2.5 text-left hover:bg-[var(--color-row-hover)]" :class="pick === x.pick ? 'bg-[var(--color-row-sel)]' : ''" :data-help="x.h.id" @click="pick = x.pick">
          <div class="flex items-center gap-2 text-[11.5px]">
            <span class="font-medium">Help</span>
            <span class="text-[var(--color-chip-amber-fg)]">{{ x.h.tool }} · {{ REASON[x.h.reason] ?? x.h.reason }}</span>
            <span class="ml-auto text-faint">{{ ago(x.h.at) }}</span>
          </div>
          <div class="mt-0.5 line-clamp-2 text-[13px] leading-snug">{{ x.h.what }}</div>
          <div class="mt-1 flex items-center gap-2 text-[11.5px] text-faint">
            <img v-if="x.h.employee.picture" :src="x.h.employee.picture" alt="" onerror="this.style.display='none'" class="h-4 w-4 flex-none rounded-full object-cover" />
            <span class="truncate">{{ x.h.employee.name }}{{ x.h.project ? ` · ${x.h.project}` : '' }}</span>
            <span v-if="HELP_STATE[x.h.status]" class="ml-auto flex-none">{{ HELP_STATE[x.h.status] }}</span>
          </div>
        </button>
        <template v-else-if="x.type === 'tg'">
        <button v-for="r in [x.r]" :key="r.rid" class="block w-full border-b border-line px-4 py-2.5 text-left hover:bg-[var(--color-row-hover)]" :class="pick === x.pick ? 'bg-[var(--color-row-sel)]' : ''" :data-request="r.rid" @click="pick = x.pick">
          <div class="flex items-center gap-2 text-[11.5px]">
            <span class="font-medium">{{ KIND[r.kind] }}</span>
            <span v-if="WORTH[r.worth]" :class="worthClass(r.worth)">{{ WORTH[r.worth] }}</span>
            <span class="ml-auto text-faint">{{ ago(r.at) }}</span>
          </div>
          <div class="mt-0.5 line-clamp-2 text-[13px] leading-snug">{{ r.summary }}</div>
          <div v-if="r.call" class="mt-0.5 line-clamp-1 text-[12px] font-medium" :class="worthClass(r.worth)">→ {{ r.call }}</div>
          <div class="mt-1 flex items-center gap-2 text-[11.5px] text-faint">
            <span class="truncate">{{ r.from.join(', ') }} · {{ r.project }}<span v-if="r.updates" class="ml-1 text-faint" :title="`Later messages updated this request ${r.updates} time${r.updates > 1 ? 's' : ''}; the verdict shown is the latest`">· {{ r.updates + 1 }} rounds</span></span>
            <span v-if="stateOf(r)" class="ml-auto flex-none">{{ stateOf(r) }}</span>
          </div>
        </button>
        </template>
        </template>
      </div>
    </div>

    <!-- one request -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="flight" class="mx-auto max-w-3xl px-6 py-6 text-[13.5px] leading-relaxed" data-flight-detail>
        <div class="flex items-center gap-2 text-[12px] text-muted">
          <Spinner v-if="flight.state === 'researching'" :size="13" />
          <span class="font-medium" :class="stateClass(flight.state)">{{ stateText[flight.state] }}</span>
          <span>· {{ flight.project || flight.chat }} · {{ flight.chat }} · since {{ ago(flight.since) }}</span>
        </div>
        <div v-if="flight.state === 'failed'" class="mt-3 rounded-lg border border-line px-3 py-2.5" data-flight-failed>
          <p class="text-[13px] text-[var(--color-danger)]">{{ flight.error }}</p>
          <div class="mt-2.5 flex items-center gap-2">
            <button class="btn btn-soft btn-sm" :disabled="!!busy" data-flight-retry @click="failedAct(flight.key, 'retry')"><Spinner v-if="busy === 'retry'" /> Retry</button>
            <button class="btn btn-ghost btn-sm" :disabled="!!busy" @click="failedAct(flight.key, 'dismiss')">Dismiss</button>
            <span class="text-[12px] text-faint">Retry runs the research again on whichever account has room.</span>
          </div>
          <p v-if="msg" class="mt-2 text-[12.5px] text-muted">{{ msg }}</p>
        </div>
        <div v-if="flight.state === 'gathering'" class="mt-3 flex items-center gap-2">
          <button class="btn btn-soft btn-sm" :disabled="!!busy" data-flight-start @click="startNow(flight.key)"><Spinner v-if="busy === 'start'" /> Start now</button>
          <button class="btn btn-ghost btn-sm" :disabled="!!busy" data-flight-session title="Skip the research: start an Overvibe session in the project on these messages, with a task for them" @click="startNow(flight.key, 'session')"><Spinner v-if="busy === 'session'" /> Start session</button>
          <span class="text-[12px] text-faint">Start now researches the messages so far; Start session skips the research and works on them.</span>
          <span v-if="msg" class="text-[12.5px] text-muted">{{ msg }}</span>
        </div>
        <p v-if="flight.state !== 'failed'" class="mt-2 text-[12.5px] text-faint">{{ flight.state === 'gathering' ? 'The research starts after a minute with no new message, so a message sent in parts is read whole.' : flight.state === 'queued' ? 'Other research runs are going; this one starts when one finishes.' : 'A read-only research run is reading the project. The report replaces this card, and the bot sends it to you in Telegram too.' }}</p>
        <section v-if="flight.steps.length" class="mt-5" data-flight-steps>
          <div class="col-label mb-2">What the research has done ({{ flight.steps.length }})</div>
          <div class="card max-h-[40vh] overflow-y-auto px-4 py-2.5 font-mono text-[12px] leading-relaxed text-muted">
            <div v-for="(st, i) in flight.steps" :key="i" class="flex gap-3"><span class="flex-none tabular-nums text-faint">{{ new Date(st.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</span><span class="min-w-0 break-words">{{ st.text }}</span></div>
          </div>
        </section>
        <section class="mt-5">
          <div class="col-label mb-2">Messages ({{ flight.msgs.length }})</div>
          <div class="card divide-y divide-[var(--color-line)]">
            <div v-for="(m, i) in flight.msgs" :key="i" class="px-4 py-2.5">
              <div class="text-[11.5px] text-faint">{{ m.from }} · {{ ago(m.at) }}</div>
              <div class="mt-1 whitespace-pre-wrap text-[13px] text-ink-soft">{{ m.text }}</div>
            </div>
          </div>
        </section>
      </div>
      <div v-else-if="one" class="mx-auto max-w-3xl px-6 py-6 text-[13.5px] leading-relaxed" data-request-detail>
        <div class="flex flex-wrap items-center gap-2 text-[12px] text-muted">
          <span class="rounded bg-canvas-2 px-1.5 py-0.5">{{ one.project }}</span>
          <span>{{ one.chat }}</span>
          <span class="text-faint">· {{ ago(one.at) }}</span>
          <span v-if="one.taskId" class="pill-mono">{{ one.taskId }}</span>
        </div>
        <h3 class="mt-2 text-[17px] font-semibold leading-snug">{{ one.task || one.summary }}</h3>
        <div class="mt-1 flex flex-wrap gap-3 text-[12.5px]">
          <span class="font-medium">{{ KIND[one.kind] }}</span>
          <span v-if="WORTH[one.v.worth]" :class="worthClass(one.v.worth)" class="font-medium">{{ WORTH[one.v.worth] }}</span>
        </div>
        <p v-if="one.call" class="mt-2 text-[14px] font-medium" :class="worthClass(one.v.worth)" data-request-call>→ {{ one.call }}</p>
        <p v-if="one.v.effort" class="mt-1 text-[12.5px] text-muted">Effort: {{ one.v.effort }}</p>

        <!-- actions -->
        <div class="card mt-4 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <button class="btn btn-soft btn-sm" :disabled="did('task') || did('start') || !!busy" @click="act('task')"><Spinner v-if="busy === 'task'" /> {{ one.taskId ? `Task ${one.taskId}` : 'Add task' }}</button>
            <button class="btn btn-primary btn-sm" :disabled="(did('start') && !startedGone) || !!busy" :title="startedGone ? 'Its earlier session was closed; this starts a new one on the same task' : ''" @click="act('start')"><Spinner v-if="busy === 'start'" /> {{ startedGone ? 'Start a new session' : 'Start session' }}</button>
            <button v-if="sessionKey" class="btn btn-ghost btn-sm" @click="select(sessionKey!)">Open the session</button>
            <button v-else-if="startedGone && one.conversation" class="btn btn-soft btn-sm" :disabled="!!busy" data-request-resume title="Its session was closed; this resumes the same conversation in a new row" @click="resumeIt(one.conversation!)"><Spinner v-if="busy === 'resume'" /> Resume the session</button>
            <button v-if="!one.done.length" class="btn btn-ghost btn-sm ml-auto" :disabled="!!busy" @click="act('skip')">Skip</button>
          </div>
          <p v-if="msg" class="mt-2 text-[12.5px] text-muted">{{ msg }}</p>
          <p class="mt-2 text-[12px] text-faint">Add task writes a line to {{ one.project }}'s TASKS.md. Start session adds it too and opens an Overvibe session in {{ one.cwd }} that builds from this plan.</p>
        </div>

        <section v-if="sameGroup.length" class="mt-6" data-same-group>
          <div class="col-label mb-2">Other requests in {{ one.chat }} ({{ sameGroup.length }})</div>
          <div class="card divide-y divide-[var(--color-line)]">
            <button v-for="r in sameGroup" :key="r.rid" class="block w-full px-4 py-2 text-left hover:bg-[var(--color-row-hover)]" @click="pick = `tg:${r.rid}`">
              <div class="flex items-center gap-2 text-[11.5px] text-faint"><span class="font-medium text-ink-soft">{{ KIND[r.kind] }}</span><span>{{ r.from.join(', ') }}</span><span class="ml-auto">{{ ago(r.at) }}</span></div>
              <div class="mt-0.5 line-clamp-2 text-[13px] text-ink-soft">{{ r.summary }}</div>
              <div v-if="r.call" class="mt-0.5 truncate text-[12px] text-muted">→ {{ r.call }}</div>
            </button>
          </div>
          <p class="mt-1.5 text-[12px] text-faint">New research in this group reads these too, with the replies that were sent.</p>
        </section>
        <section class="mt-6">
          <div class="col-label mb-1.5">What they wrote</div>
          <div class="card divide-y divide-line">
            <div v-for="(m, i) in one.msgs" :key="i" class="px-4 py-2.5">
              <div class="text-[12px] font-medium">{{ m.from }} <span class="font-normal text-faint">{{ ago(m.at) }}</span></div>
              <div v-if="m.replyTo" class="mt-1 border-l-2 border-line pl-2 text-[12px] text-faint">{{ m.replyTo }}</div>
              <div class="whitespace-pre-wrap">{{ m.text }}</div>
            </div>
          </div>
        </section>

        <section class="mt-6">
          <div class="col-label mb-1.5">What is true today</div>
          <div class="whitespace-pre-wrap">{{ one.v.answer }}</div>
        </section>
        <section v-if="one.kind === 'bug' || one.kind === 'feature'" class="mt-6">
          <div class="col-label mb-1.5">Why</div>
          <div class="whitespace-pre-wrap">{{ one.v.why }}</div>
          <div class="col-label mb-1.5 mt-5">Brand fit</div>
          <div class="whitespace-pre-wrap">{{ one.v.brand }}</div>
        </section>
        <section v-if="one.v.plan" class="mt-6">
          <div class="col-label mb-1.5">Plan</div>
          <div class="card whitespace-pre-wrap px-4 py-3 text-[13px]">{{ one.v.plan }}</div>
        </section>

        <section v-if="one.v.reply" class="mt-6">
          <div class="col-label mb-1.5">Reply to {{ one.canReply ? `"${one.chat}"` : 'the customer' }}</div>
          <div v-if="one.sent" class="card whitespace-pre-wrap px-4 py-3 text-[13px] text-muted">Sent: {{ one.sent }}</div>
          <template v-else>
            <textarea v-model="draft" rows="9" class="input w-full !text-[13px] leading-relaxed" />
            <div class="mt-2 flex items-center gap-2">
              <button v-if="one.canReply" class="btn btn-soft btn-sm" :disabled="!draft.trim() || !!busy" @click="act('send')"><Spinner v-if="busy === 'send'" /> Send to the group</button>
              <span class="text-[12px] text-faint">{{ one.canReply ? 'Posts this text in the Telegram group as the bot, as a reply to their last message.' : 'This came from your own messages to the bot; copy the draft to answer.' }}</span>
            </div>
          </template>
        </section>
        <p class="mt-6 text-[12px] text-faint">Full report: <span class="pill-mono select-all">{{ one.file }}</span></p>
      </div>
      <div v-else-if="help" class="mx-auto max-w-3xl px-6 py-6 text-[13.5px] leading-relaxed" data-help-detail>
        <div class="flex flex-wrap items-center gap-2 text-[12px] text-muted">
          <span class="rounded bg-canvas-2 px-1.5 py-0.5">Help card</span>
          <span v-if="help.project">{{ help.project }}</span>
          <span class="text-faint">· {{ ago(help.at) }}</span>
          <span v-if="help.taskId" class="pill-mono">{{ help.taskId }}</span>
          <span v-if="HELP_STATE[help.status]" class="font-medium">{{ HELP_STATE[help.status] }}</span>
        </div>
        <div class="mt-3 flex items-center gap-3">
          <img v-if="help.employee.picture" :src="help.employee.picture" alt="" onerror="this.style.display='none'" class="h-9 w-9 rounded-full object-cover" />
          <div>
            <div class="font-medium">{{ help.employee.name }} needs help with <span class="font-mono">{{ help.tool }}</span></div>
            <div class="text-[12.5px] text-[var(--color-chip-amber-fg)]">{{ REASON[help.reason] ?? help.reason }}</div>
          </div>
        </div>
        <h3 class="mt-3 whitespace-pre-wrap text-[16px] font-semibold leading-snug">{{ help.what }}</h3>

        <div class="card mt-4 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <button class="btn btn-soft btn-sm" :disabled="help.closed || help.done.includes('task') || help.done.includes('start') || !!busy" @click="helpAct('task')"><Spinner v-if="busy === 'task'" /> {{ help.taskId ? `Task ${help.taskId}` : 'Add task' }}</button>
            <button class="btn btn-primary btn-sm" :disabled="help.closed || help.done.includes('start') || !!busy" @click="helpAct('start')"><Spinner v-if="busy === 'start'" /> Start session</button>
            <button v-if="helpSessionKey" class="btn btn-ghost btn-sm" @click="select(helpSessionKey!)">Open the session</button>
            <a v-if="help.link" class="btn btn-ghost btn-sm ml-auto" :href="help.link" target="_blank" rel="noopener">Open its source</a>
          </div>
          <p v-if="msg" class="mt-2 text-[12.5px] text-muted">{{ msg }}</p>
          <p class="mt-2 text-[12px] text-faint">Add task writes a line to {{ help.repo ?? 'the tool\'s repo (none known yet)' }}'s TASKS.md. Start session adds it too and opens a session there to fix it; when the line is ticked with its check, the card is resolved at its source with the commit.</p>
        </div>

        <section v-if="help.command" class="mt-6">
          <div class="col-label mb-1.5">Command</div>
          <div class="card whitespace-pre-wrap px-4 py-3 font-mono text-[12.5px]">{{ help.command }}</div>
        </section>
        <section v-if="help.error" class="mt-6">
          <div class="col-label mb-1.5">Error</div>
          <div class="card max-h-80 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[12.5px]">{{ help.error }}</div>
        </section>
        <p v-if="help.trace" class="mt-4 text-[12px] text-faint">Trace: <span class="pill-mono select-all">{{ help.trace }}</span></p>
        <section v-if="help.resolved" class="mt-6">
          <div class="col-label mb-1.5">Resolved</div>
          <div class="whitespace-pre-wrap">{{ help.resolved.text }}<span v-if="help.resolved.commit" class="pill-mono ml-2">{{ help.resolved.commit }}</span></div>
        </section>
        <section v-if="help.replies.length" class="mt-6">
          <div class="col-label mb-1.5">You wrote</div>
          <div class="card divide-y divide-line">
            <div v-for="(m, i) in help.replies" :key="i" class="px-4 py-2.5">
              <div class="text-[12px] text-faint">{{ m.act === 'wontfix' ? "Won't fix" : 'Reply' }} · {{ ago(m.at) }}</div>
              <div class="whitespace-pre-wrap">{{ m.text }}</div>
            </div>
          </div>
        </section>
        <section v-if="!help.closed" class="mt-6">
          <div class="col-label mb-1.5">Answer {{ help.employee.name }}</div>
          <textarea v-model="helpText" rows="4" class="input w-full !text-[13px] leading-relaxed" placeholder="Posted in their DM as you, and it wakes them" data-help-text />
          <div class="mt-2 flex items-center gap-2">
            <button class="btn btn-soft btn-sm" :disabled="!helpText.trim() || !!busy" @click="helpAct('reply')"><Spinner v-if="busy === 'reply'" /> Reply</button>
            <button class="btn btn-ghost btn-sm" :disabled="!helpText.trim() || !!busy" @click="helpAct('wontfix')"><Spinner v-if="busy === 'wontfix'" /> Won't fix</button>
            <button class="btn btn-ghost btn-sm" :disabled="!!busy" title="Take it off the open list; nothing is sent" data-help-close @click="helpAct('close')"><Spinner v-if="busy === 'close'" /> Close</button>
            <span class="text-[12px] text-faint">Reply and Won't fix send this text to {{ help.employee.name }} in their DM (Won't fix as the reason, and closes the card). Close only closes it here.</span>
          </div>
        </section>
      </div>
      <div v-else-if="items.length" class="px-6 py-6 text-[13px] text-faint">Pick a request.</div>
    </div>
  </div>
</template>
