<script setup lang="ts">
// First-run safety note: once per install, before anything else, what running real agents here means.
// "Got it" records the id on the server (the What's new seen list in the data folder), so it stays
// dismissed in every browser and the desktop app. Only Got it closes it. While the first-run setup is
// open (or set aside for a login) the note waits: the setup shows the same points as its last step.
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowUpRight, ShieldAlert } from 'lucide-vue-next'
import SafetyPoints from './SafetyPoints.vue'
import { deck } from '../deck'
import { ackSafety, setup } from '../setup'

const open = computed(() => setup.checked && setup.safetySeen === false && !deck.setupOpen && !deck.setupAway)
const gotIt = ref<HTMLButtonElement>()
watch(open, async (o) => {
  if (!o) return
  await nextTick()
  gotIt.value?.focus()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[90] grid place-items-start justify-center backdrop p-4 pt-[12vh]">
      <div class="dialog w-full max-w-lg p-6" role="alertdialog" aria-modal="true" aria-labelledby="safety-title">
        <div class="flex items-center gap-2 text-[12px] text-faint">
          <ShieldAlert :size="15" class="text-[var(--color-brand-600)]" />
          <span class="col-label">Before you start</span>
        </div>
        <h3 id="safety-title" class="mt-3 text-[17px] font-semibold leading-snug tracking-[-0.02em]">Agents here can run commands on this computer</h3>
        <SafetyPoints class="mt-3" />
        <div class="mt-6 flex items-center justify-end gap-2">
          <a href="https://overvibe.dev/security" target="_blank" rel="noopener noreferrer" class="btn btn-ghost">How Overvibe is secured <ArrowUpRight :size="14" /></a>
          <button ref="gotIt" type="button" class="btn btn-brand" @click="ackSafety">Got it</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
