<script setup lang="ts">
// Send feedback [T1112-120]: a feature request, a bug report or anything else, into the feedback collection on
// overvibe.dev through the server (/api/feedback). "Include version and OS" shows exactly what it adds.
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ArrowUpRight } from 'lucide-vue-next'
import { api, deck, showToast } from '../deck'
import { issueUrl, KINDS, MAX_MESSAGE, type FeedbackEnv, type Kind } from '../../feedbackform'

const kind = ref<Kind>('feature')
const message = ref('')
const email = ref('')
const include = ref(true)
const env = ref<FeedbackEnv | null>(null)
const err = ref('')
const busy = ref(false)
const box = ref<HTMLTextAreaElement>()
const close = () => (deck.feedbackOpen = false)

const PLACEHOLDER: Record<Kind, string> = {
  feature: 'What would you like Overvibe to do?',
  bug: 'What happened, and what did you expect? Steps to get there help a lot.',
  other: "What's on your mind?",
}
const envLine = computed(() => (env.value ? [`Overvibe ${env.value.version}`, env.value.os, env.value.tools].filter(Boolean).join(' · ') : 'reading...'))
const github = computed(() => issueUrl(message.value, include.value ? env.value : null))

onMounted(async () => {
  await nextTick()
  box.value?.focus()
  env.value = await api<FeedbackEnv>('/api/feedback/env').catch(() => null)
})
onUnmounted(() => (deck.feedbackOpen = false))

async function send() {
  if (busy.value) return
  busy.value = true
  err.value = ''
  try {
    const r = await api<{ ok: boolean; error?: string }>('/api/feedback', { kind: kind.value, message: message.value, email: email.value, include: include.value })
    if (!r.ok) err.value = r.error || 'it did not go through'
    else showToast('Thanks, it was sent'), close()
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') e.preventDefault(), e.stopPropagation(), close()
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.preventDefault(), send()
}
</script>

<template>
  <div class="fixed inset-0 z-[70] grid place-items-start justify-center backdrop p-4 pt-[12vh]" data-feedback @mousedown.self="close" @keydown="onKey">
    <form class="dialog w-full max-w-lg p-5" @submit.prevent="send">
      <div class="mb-3 text-[15px] font-semibold text-ink">Send feedback</div>
      <div class="mb-3 flex gap-1 rounded-lg bg-canvas-2 p-1" role="radiogroup" aria-label="Kind">
        <button
          v-for="k in KINDS"
          :key="k.id"
          type="button"
          role="radio"
          :aria-checked="kind === k.id"
          class="flex-1 rounded-md px-2 py-1 text-[13px]"
          :class="kind === k.id ? 'bg-surface font-medium text-ink shadow-sm' : 'text-muted hover:text-ink'"
          :data-kind="k.id"
          @click="kind = k.id"
        >
          {{ k.label }}
        </button>
      </div>
      <textarea ref="box" v-model="message" rows="6" class="input w-full resize-y !text-[13.5px] leading-snug" :maxlength="MAX_MESSAGE" :placeholder="PLACEHOLDER[kind]" data-feedback-message />
      <input v-model="email" type="email" class="input mt-2 w-full !text-[13.5px]" placeholder="Email, if you'd like a reply (optional)" autocomplete="email" data-feedback-email />
      <label class="mt-3 flex items-start gap-2 text-[13px] text-ink-soft">
        <input v-model="include" type="checkbox" class="mt-0.5" data-feedback-include />
        <span>Include version and OS<span class="block text-[12px] text-faint">{{ envLine }}</span></span>
      </label>
      <a v-if="kind === 'bug'" :href="github" target="_blank" rel="noopener" class="mt-3 inline-flex items-center gap-1 text-[13px] text-[var(--color-brand-600)] hover:underline" data-feedback-github>Report on GitHub instead <ArrowUpRight :size="13" /></a>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}</p>
      <div class="mt-4 flex items-center justify-end gap-2">
        <span class="mr-auto text-[12px] text-faint">⌘Enter sends · Esc cancels</span>
        <button type="button" class="btn btn-ghost" @click="close">Cancel</button>
        <button class="btn btn-brand" :disabled="busy || !message.trim()" data-feedback-send>Send</button>
      </div>
    </form>
  </div>
</template>
