<script setup lang="ts">
// Requests [T1113-3]: what customers asked in the Telegram groups linked to a project, each with its research, verdict,
// plan and draft reply. Apart from TASKS.md: a line goes there only on Add task or Start session. The same actions
// as the Telegram buttons, and the Telegram message follows whichever you use.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Inbox } from 'lucide-vue-next'
import Spinner from './Spinner.vue'
import { ago, api, deck, refresh, select } from '../deck'

type Kind = 'question' | 'bug' | 'feature' | 'chatter'
type Worth = 'yes' | 'no' | 'unsure' | 'n/a'
type Row = { rid: string; at: number; chat: string; project: string; cwd: string; from: string[]; kind: Kind; worth: Worth; call: string; effort: string; summary: string; task: string; done: string[]; taskId: string | null; session: string | null; canReply: boolean }
type Said = { at: number; from: string; text: string; owner?: boolean; replyTo?: string }
type Full = Row & { v: { summary: string; answer: string; why: string; brand: string; effort: string; plan: string; reply: string; worth: Worth }; msgs: Said[]; sent: string | null; file: string }

const rows = ref<Row[] | null>(null)
const pick = ref<string>('')
const one = ref<Full | null>(null)
const draft = ref('')
const busy = ref('')
const msg = ref('')
const show = ref<'open' | 'all'>('open')

async function load() {
  rows.value = (await api<{ requests: Row[] }>('/api/requests')).requests
  if (!pick.value && list.value[0]) pick.value = list.value[0].rid
}
const list = computed(() => (rows.value ?? []).filter((r) => show.value === 'all' || !r.done.length))
watch(pick, async (rid) => {
  msg.value = ''
  one.value = rid ? await api<Full>(`/api/requests?rid=${encodeURIComponent(rid)}`).catch(() => null) : null
  draft.value = one.value?.v.reply ?? ''
})
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
const sessionKey = computed(() => one.value?.session && deck.sessions.find((s) => s.tmux === one.value!.session)?.key)

let t: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void load()
  t = setInterval(() => void load().catch(() => {}), 10_000)
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
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div v-if="rows && !list.length" class="px-4 py-6 text-[13px] text-faint">
          <Inbox :size="18" class="mb-2" />
          {{ show === 'open' ? 'Nothing open.' : 'No requests yet.' }} When a customer writes in a linked Telegram group, the research and plan show up here.
        </div>
        <button v-for="r in list" :key="r.rid" class="block w-full border-b border-line px-4 py-2.5 text-left hover:bg-[var(--color-row-hover)]" :class="pick === r.rid ? 'bg-[var(--color-row-sel)]' : ''" :data-request="r.rid" @click="pick = r.rid">
          <div class="flex items-center gap-2 text-[11.5px]">
            <span class="font-medium">{{ KIND[r.kind] }}</span>
            <span v-if="WORTH[r.worth]" :class="worthClass(r.worth)">{{ WORTH[r.worth] }}</span>
            <span class="ml-auto text-faint">{{ ago(r.at) }}</span>
          </div>
          <div class="mt-0.5 line-clamp-2 text-[13px] leading-snug">{{ r.summary }}</div>
          <div v-if="r.call" class="mt-0.5 line-clamp-1 text-[12px] font-medium" :class="worthClass(r.worth)">→ {{ r.call }}</div>
          <div class="mt-1 flex items-center gap-2 text-[11.5px] text-faint">
            <span class="truncate">{{ r.from.join(', ') }} · {{ r.project }}</span>
            <span v-if="stateOf(r)" class="ml-auto flex-none">{{ stateOf(r) }}</span>
          </div>
        </button>
      </div>
    </div>

    <!-- one request -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="one" class="mx-auto max-w-3xl px-6 py-6 text-[13.5px] leading-relaxed" data-request-detail>
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
            <button class="btn btn-primary btn-sm" :disabled="did('start') || !!busy" @click="act('start')"><Spinner v-if="busy === 'start'" /> Start session</button>
            <button v-if="sessionKey" class="btn btn-ghost btn-sm" @click="select(sessionKey!)">Open the session</button>
            <button v-if="!one.done.length" class="btn btn-ghost btn-sm ml-auto" :disabled="!!busy" @click="act('skip')">Skip</button>
          </div>
          <p v-if="msg" class="mt-2 text-[12.5px] text-muted">{{ msg }}</p>
          <p class="mt-2 text-[12px] text-faint">Add task writes a line to {{ one.project }}'s TASKS.md. Start session adds it too and opens an Overvibe session in {{ one.cwd }} that builds from this plan.</p>
        </div>

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
      <div v-else-if="rows && rows.length" class="px-6 py-6 text-[13px] text-faint">Pick a request.</div>
    </div>
  </div>
</template>
