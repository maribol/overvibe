<script setup lang="ts">
// Mine: everything the owner typed into any session (Terminal tabs included), newest first, with the
// session it went to. Between agents: the whole log of messages sessions sent each other (overvibe send,
// and Overvibe's own notes) [T1111-12]. Click one to open the session it went to.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Search } from 'lucide-vue-next'
import { ago, agoText, api, deck, openSession, select, setView, shortCwd } from '../deck'

type Msg = { sessionId: string; at: number; text: string; title: string | null; cwd: string | null }
type Peer = { at: number; from: string; fromSession: string | null; fromTmux: string | null; fromTool: string | null; sender: 'checked' | 'legacy' | 'outside' | 'overvibe'; to: string; toSession: string | null; toTmux: string | null; toTool: string | null; text: string }
const list = ref<Msg[]>([])
const peers = ref<Peer[]>([])
const tab = ref<'mine' | 'agents'>(localStorage.getItem('deck.messagesTab') === 'agents' ? 'agents' : 'mine')
const setTab = (t: 'mine' | 'agents') => ((tab.value = t), localStorage.setItem('deck.messagesTab', t), load())
const q = ref('')
let t: ReturnType<typeof setInterval>
async function load() {
  try {
    if (tab.value === 'agents') peers.value = (await api<{ messages: Peer[] }>('/api/peer-messages?limit=500')).messages.slice().reverse()
    else list.value = (await api<{ messages: Msg[] }>('/api/messages?limit=300')).messages
  } catch {}
}
// the receiving session: its row now (by tmux id, then conversation id), else nothing to open
const peerRow = (m: Peer) => deck.sessions.find((s) => (m.toTmux && s.key === m.toTmux) || (m.toSession && s.sessionId === m.toSession))
const openPeer = (m: Peer) => {
  const s = peerRow(m)
  if (s) (setView('terminal'), select(s.key))
  else if (m.toSession) openSession(m.toSession)
}
const nameOf = (tmux: string | null, session: string | null, fallback: string) => deck.sessions.find((s) => (tmux && s.key === tmux) || (session && s.sessionId === session))?.title ?? fallback
const shownPeers = computed(() => {
  const n = q.value.trim().toLowerCase()
  return n ? peers.value.filter((m) => `${m.text} ${m.from} ${m.to}`.toLowerCase().includes(n)) : peers.value
})
onMounted(() => {
  load()
  t = setInterval(load, 4000)
})
onUnmounted(() => clearInterval(t))

// the sidebar's title for a session is the best one (deck name, /rename, Claude Code title)
const titleOf = (m: Msg) => deck.sessions.find((s) => s.sessionId === m.sessionId)?.title ?? m.title ?? m.sessionId.slice(0, 8)
const statusOf = (m: Msg) => deck.sessions.find((s) => s.sessionId === m.sessionId)
const shown = computed(() => {
  const n = q.value.trim().toLowerCase()
  return n ? list.value.filter((m) => `${m.text} ${titleOf(m)} ${m.cwd ?? ''}`.toLowerCase().includes(n)) : list.value
})
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto max-w-3xl px-6 py-6">
      <div class="flex items-center justify-between gap-4">
        <div>
          <h2 class="text-lg font-semibold">{{ tab === 'agents' ? 'Messages between agents' : 'My messages' }}</h2>
          <p class="text-[13px] text-muted">{{ tab === 'agents' ? 'What sessions sent each other, whole, newest first. Click one to open the session it went to.' : 'What you told each session, newest first. Click one to open it.' }}</p>
        </div>
        <div class="flex shrink-0 gap-1">
          <button class="btn btn-sm" :class="tab === 'mine' ? 'btn-primary' : 'btn-ghost'" @click="setTab('mine')">Mine</button>
          <button class="btn btn-sm" :class="tab === 'agents' ? 'btn-primary' : 'btn-ghost'" @click="setTab('agents')">Between agents</button>
        </div>
        <div class="relative w-64">
          <Search :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input v-model="q" class="input !py-1.5 !pl-8 !text-[13px]" placeholder="Search messages" />
        </div>
      </div>

      <template v-if="tab === 'agents'">
        <div v-if="!shownPeers.length" class="mt-10 text-center text-[13px] text-faint">No messages between agents{{ q ? ' match' : ' yet' }}.</div>
        <template v-for="(m, i) in shownPeers" :key="m.at + m.to + i">
          <div v-if="i === 0 || day(m.at) !== day(shownPeers[i - 1]!.at)" class="col-label mb-2 mt-6">{{ day(m.at) }}</div>
          <button class="card mb-2 block w-full p-3.5 text-left hover:border-line-strong" @click="openPeer(m)">
            <div class="flex items-center gap-2 text-[12px]">
              <span class="dot" :class="peerRow(m)?.tmux ? 'dot-idle' : 'dot-ended'"></span>
              <span class="truncate font-semibold text-ink">{{ m.sender === 'outside' ? 'a shell' : nameOf(m.fromTmux, m.fromSession, m.from) }}</span>
              <span class="text-faint">to</span>
              <span class="truncate font-semibold text-ink">{{ nameOf(m.toTmux, m.toSession, m.to) }}</span>
              <span v-if="m.sender === 'overvibe'" class="pill-mono text-faint" title="A note Overvibe wrote about a session this one started">note</span>
              <span v-else-if="m.sender !== 'checked'" class="pill-mono text-faint" :title="m.sender === 'outside' ? 'Sent from a shell outside any Overvibe session' : 'Sent by a session started before sender checks'">{{ m.sender === 'outside' ? 'outside' : 'not checked' }}</span>
              <span class="flex-1"></span>
              <span class="tabular-nums text-faint" :title="new Date(m.at).toLocaleString()">{{ agoText(m.at) }}</span>
            </div>
            <p class="mt-1.5 line-clamp-6 whitespace-pre-wrap text-[13.5px] text-ink-soft">{{ m.text }}</p>
          </button>
        </template>
      </template>
      <template v-else>
      <div v-if="!shown.length" class="mt-10 text-center text-[13px] text-faint">No messages{{ q ? ' match' : ' yet' }}.</div>
      <template v-for="(m, i) in shown" :key="m.sessionId + m.at">
        <div v-if="i === 0 || day(m.at) !== day(shown[i - 1]!.at)" class="col-label mb-2 mt-6">{{ day(m.at) }}</div>
        <button class="card mb-2 block w-full p-3.5 text-left hover:border-line-strong" @click="openSession(m.sessionId)">
          <div class="flex items-center gap-2 text-[12px]">
            <span class="dot" :class="statusOf(m) && statusOf(m)!.where !== 'past' && statusOf(m)!.status !== 'ended' ? 'dot-idle' : 'dot-ended'"></span>
            <span class="font-semibold text-ink">{{ titleOf(m) }}</span>
            <span v-if="m.cwd" class="pill-mono truncate text-faint">{{ shortCwd(m.cwd.replace(/^\/Users\/[^/]+/, '~')) }}</span>
            <span class="flex-1"></span>
            <span class="tabular-nums text-faint" :title="new Date(m.at).toLocaleString()">{{ agoText(m.at) }}</span>
          </div>
          <p class="mt-1.5 line-clamp-3 whitespace-pre-wrap text-[13.5px] text-ink-soft">{{ m.text }}</p>
        </button>
      </template>
      </template>
    </div>
  </div>
</template>
