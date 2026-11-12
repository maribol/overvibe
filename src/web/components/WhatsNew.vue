<script setup lang="ts">
// What's new: a slide-over list of announcements (palette "What's new", or the megaphone in the
// sidebar header) and a one-time dialog for an unseen item marked modal. Bodies are plain text,
// rendered with text nodes only (parseBody), never as HTML.
import { defineComponent, h, nextTick, onMounted, onUnmounted, ref, watch, type PropType } from 'vue'
import { ArrowUpRight, Megaphone, X } from 'lucide-vue-next'
import { dialogOpen } from '../deck'
import { TAG_LABEL, loadNews, maybeShowModal, news, newsDate, parseBody, tagStyle } from '../news'

const panel = ref<HTMLElement>()
const gotIt = ref<HTMLButtonElement>()
const close = () => (news.panelOpen = false)
const closeModal = () => (news.modal = null)

watch(
  () => news.panelOpen,
  async (open) => {
    if (open) (await nextTick(), panel.value?.focus())
  },
)
watch(
  () => news.modal,
  async (m) => {
    if (m) (await nextTick(), gotIt.value?.focus())
  },
)

const Body = defineComponent({
  props: { body: { type: String as PropType<string>, required: true } },
  setup(p) {
    return () =>
      h(
        'div',
        { class: 'space-y-2 text-[13.5px] leading-relaxed text-ink-soft' },
        parseBody(p.body).map((b) =>
          b.kind === 'list' ? h('ul', { class: 'list-disc space-y-1 pl-5 marker:text-faint' }, b.items.map((l) => h('li', l))) : h('p', { class: 'whitespace-pre-line' }, b.text),
        ),
      )
  },
})

// the feed is checked when the page opens and every 30 minutes (the server fetches at most every 6 hours);
// the dialog waits until no other dialog is open
let timer: ReturnType<typeof setInterval>
let tries: ReturnType<typeof setInterval>
onMounted(async () => {
  await loadNews()
  tries = setInterval(() => {
    maybeShowModal(dialogOpen())
    if (news.modal || !news.items.some((i) => i.modal && !news.modalShown.includes(i.id))) clearInterval(tries)
  }, 1500)
  timer = setInterval(loadNews, 30 * 60 * 1000)
})
onUnmounted(() => (clearInterval(timer), clearInterval(tries)))
</script>

<template>
  <Teleport to="body">
    <div v-if="news.panelOpen" class="fixed inset-0 z-[60] backdrop" @mousedown="close"></div>
    <aside
      v-if="news.panelOpen" ref="panel" tabindex="-1" role="dialog" aria-modal="true" aria-label="What's new"
      class="fixed inset-y-0 right-0 z-[61] flex w-full max-w-[420px] flex-col border-l border-line bg-surface text-ink outline-none"
      @keydown.esc="close"
    >
      <header class="flex items-center gap-3 border-b border-line px-5 py-4">
        <Megaphone :size="17" class="text-[var(--color-brand-600)]" />
        <h2 class="text-[15px] font-bold tracking-[-0.02em]">What's new</h2>
        <button class="ml-auto rounded-md p-1 text-faint hover:bg-[var(--color-row-hover)] hover:text-ink" title="Close (Esc)" @click="close"><X :size="17" /></button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <p v-if="!news.items.length" class="px-5 py-16 text-center text-[13px] text-faint">No news yet.</p>
        <article v-for="i in news.items" :key="i.id" class="border-b border-line px-5 py-5 last:border-0">
          <div class="flex items-center gap-2 text-[12px] text-faint">
            <span class="chip" :style="tagStyle(i.tag)">{{ TAG_LABEL[i.tag] }}</span>
            <time :datetime="i.date">{{ newsDate(i.date) }}</time>
            <span v-if="i.draft" class="chip" style="background: var(--color-chip-amber-bg); color: var(--color-chip-amber-fg)">draft</span>
            <span v-if="news.openedUnread.includes(i.id)" class="chip ml-auto" style="background: var(--color-chip-accent-bg); color: var(--color-chip-accent-fg)">New</span>
          </div>
          <h3 class="mt-2 text-[15px] font-semibold leading-snug">{{ i.title }}</h3>
          <Body :body="i.body" class="mt-2" />
          <a v-if="i.url" :href="i.url" target="_blank" rel="noopener noreferrer" class="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-brand-600)] hover:underline">Read more <ArrowUpRight :size="14" /></a>
        </article>
      </div>
    </aside>

    <div v-if="news.modal" class="fixed inset-0 z-[72] grid place-items-start justify-center backdrop p-4 pt-[14vh]" @mousedown.self="closeModal" @keydown.esc="closeModal">
      <div class="dialog w-full max-w-md p-5" role="dialog" aria-modal="true" aria-label="What's new">
        <div class="flex items-center gap-2 text-[12px] text-faint">
          <Megaphone :size="14" class="text-[var(--color-brand-600)]" />
          <span class="col-label">What's new</span>
          <span class="chip ml-auto" :style="tagStyle(news.modal.tag)">{{ TAG_LABEL[news.modal.tag] }}</span>
          <time :datetime="news.modal.date">{{ newsDate(news.modal.date) }}</time>
        </div>
        <h3 class="mt-3 text-[17px] font-semibold leading-snug tracking-[-0.02em]">{{ news.modal.title }}</h3>
        <Body :body="news.modal.body" class="mt-2" />
        <div class="mt-5 flex items-center justify-end gap-2">
          <a v-if="news.modal.url" :href="news.modal.url" target="_blank" rel="noopener noreferrer" class="btn btn-ghost" @click="closeModal">Read more <ArrowUpRight :size="14" /></a>
          <button ref="gotIt" type="button" class="btn btn-brand" @click="closeModal">Got it</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
