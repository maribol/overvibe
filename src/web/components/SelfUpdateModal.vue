<script setup lang="ts">
// Overvibe has a newer release [T1112-119]: what's new (the changelog on overvibe.dev), and the way to get it.
// An installed copy updates with `overvibe update` in a terminal row; a clone someone runs by hand gets its git pull.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ArrowUpRight, Copy } from 'lucide-vue-next'
import { deck, showToast, updateSelf } from '../deck'

const u = computed(() => deck.self)
const err = ref('')
const busy = ref(false)
const close = () => (deck.selfOpen = false)
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), close())
onMounted(() => window.addEventListener('keydown', onKey, true))
onUnmounted(() => window.removeEventListener('keydown', onKey, true))

async function run() {
  if (busy.value) return
  busy.value = true
  err.value = ''
  try {
    await updateSelf()
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
async function copy() {
  if (!u.value) return
  await navigator.clipboard.writeText(u.value.cmd).catch(() => {})
  showToast('Copied')
}
</script>

<template>
  <div v-if="u" class="fixed inset-0 z-[70] grid place-items-start justify-center backdrop p-4 pt-[14vh]" data-self-update @mousedown.self="close">
    <div class="dialog w-full max-w-md p-5">
      <div class="text-[15px] font-semibold text-ink">Overvibe {{ u.latest }}</div>
      <p class="mt-1 text-[13px] text-muted">You have {{ u.installed }}.</p>
      <a :href="u.url" target="_blank" rel="noopener" class="mt-3 inline-flex items-center gap-1 text-[13.5px] font-medium text-[var(--color-brand-600)] hover:underline" data-self-news>What's new <ArrowUpRight :size="14" /></a>
      <template v-if="u.mode === 'installed'">
        <p class="mt-3 text-[13px] text-ink-soft">Update runs <code class="rounded bg-canvas-2 px-1">overvibe update</code> in a terminal row, so you can watch it fetch the release, build it and restart the server. Your sessions keep running.</p>
        <p class="mt-2 text-[13px] text-muted">This page reloads by itself once the server is back.</p>
      </template>
      <template v-else>
        <p class="mt-3 text-[13px] text-ink-soft">
          <template v-if="u.mode === 'dev'">This Overvibe runs from a clone you run yourself ({{ u.why }}), so it leaves updating to you. Pull it:</template>
          <template v-else>Run the install command again to update:</template>
        </p>
        <div class="mt-2 flex items-center gap-2 rounded-lg border border-line bg-canvas-2 px-2.5 py-1.5">
          <code class="min-w-0 flex-1 truncate text-[12.5px]" :title="u.cmd">{{ u.cmd }}</code>
          <button class="flex-none rounded p-1 text-faint hover:text-ink" title="Copy" aria-label="Copy" @click="copy"><Copy :size="14" /></button>
        </div>
        <p class="mt-2 text-[13px] text-muted">Then restart the server; the page reloads when the new build lands.</p>
      </template>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}</p>
      <div class="mt-4 flex items-center justify-end gap-2">
        <button class="btn btn-ghost" @click="close">{{ u.mode === 'installed' ? 'Later' : 'Close' }}</button>
        <button v-if="u.mode === 'installed'" class="btn btn-brand" :disabled="busy" data-self-run @click="run">Update</button>
      </div>
    </div>
  </div>
</template>
