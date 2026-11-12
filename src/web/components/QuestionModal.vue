<script setup lang="ts">
// A session asked you something (AskUserQuestion) or wants a plan approved (ExitPlanMode). It pops up
// over whatever you are doing, from any session, Terminal tabs included. "Later" hides it here; the
// session stays marked in the sidebar until it is answered. Only with Settings > Questions on [T1111-23].
import { computed, ref } from 'vue'
import { MessageCircleQuestion, X } from 'lucide-vue-next'
import { ago, agoText, deck, openSession, shortCwd } from '../deck'
import { promptDialogs } from '../prompt'

const dismissed = ref(new Set<string>(JSON.parse(localStorage.getItem('deck.dismissed') || '[]')))
const queue = computed(() => deck.pending.filter((p) => !dismissed.value.has(p.toolUseId)))
const p = computed(() => (promptDialogs.value ? queue.value[0] ?? null : null)) // off by default [T1111-23]
const title = computed(() => (p.value ? deck.sessions.find((s) => s.sessionId === p.value!.sessionId)?.title ?? p.value.title ?? 'A session' : ''))
const cwd = computed(() => (p.value?.cwd ? shortCwd(p.value.cwd.replace(deck.homeAbs, '~')) : ''))

function later() {
  if (!p.value) return
  const s = new Set(dismissed.value)
  s.add(p.value.toolUseId)
  dismissed.value = s
  localStorage.setItem('deck.dismissed', JSON.stringify([...s].slice(-200)))
}
function open() {
  if (!p.value) return
  const id = p.value.sessionId
  later()
  openSession(id)
}
</script>

<template>
  <div v-if="p" class="fixed inset-0 z-[60] grid place-items-start justify-center backdrop p-4 pt-[10vh]" @keydown.esc="later">
    <div class="dialog w-full max-w-xl !border-[var(--color-st-wait)]/40 p-5">
      <div class="flex items-start gap-3">
        <span class="grid size-9 flex-none place-items-center rounded-lg bg-[var(--color-st-wait)]/15 text-[var(--color-st-wait)]"><MessageCircleQuestion :size="18" /></span>
        <div class="min-w-0 flex-1">
          <div class="text-[13px] text-muted">
            <span class="font-semibold text-ink">{{ title }}</span>
            {{ p.tool === 'ExitPlanMode' ? 'wants a plan approved' : 'is asking you' }}
            <span class="text-faint">· {{ agoText(p.at) }}</span>
          </div>
          <div class="pill-mono truncate text-faint">{{ cwd }}</div>
        </div>
        <span v-if="queue.length > 1" class="chip" style="background: var(--color-chip-amber-bg); color: var(--color-chip-amber-fg)">{{ queue.length }} waiting</span>
        <button class="rounded-md p-1 text-faint hover:bg-canvas-2 hover:text-ink" title="Later" @click="later"><X :size="17" /></button>
      </div>

      <div class="mt-4 max-h-[50vh] space-y-4 overflow-y-auto">
        <div v-for="(q, i) in p.questions ?? []" :key="i">
          <div v-if="q.header" class="col-label mb-1">{{ q.header }}{{ q.multiSelect ? ' · pick any' : '' }}</div>
          <p class="whitespace-pre-wrap text-[14px] leading-snug">{{ q.question }}</p>
          <ol class="mt-2 space-y-1.5">
            <li v-for="(o, j) in q.options" :key="j" class="rounded-md border border-line bg-canvas px-3 py-2">
              <div class="text-[13px] font-medium">{{ j + 1 }}. {{ o.label }}</div>
              <div v-if="o.description" class="text-[12px] text-muted">{{ o.description }}</div>
            </li>
          </ol>
        </div>
        <pre v-if="p.plan" class="whitespace-pre-wrap rounded-lg bg-canvas-2 p-3 text-[12.5px] leading-snug text-ink-soft">{{ p.plan }}</pre>
      </div>

      <div class="mt-5 flex items-center justify-end gap-2">
        <button class="btn btn-ghost" @click="later">Later</button>
        <button class="btn btn-brand" @click="open">Open session to answer</button>
      </div>
    </div>
  </div>
</template>
