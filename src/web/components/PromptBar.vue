<script setup lang="ts">
// A slim bar over the terminal while its session's menu waits and the dialog is closed: switching to
// a session never pops a dialog at you. Answer opens it; "in the terminal" sets it aside (../prompt.ts).
// It floats over the top of the terminal, so the terminal never resizes (and redraws) for it.
import { computed } from 'vue'
import { MessageCircleQuestion } from 'lucide-vue-next'
import { inTerminal, openModal, openSig, waiting } from '../prompt'

const props = defineProps<{ title: string; active: boolean }>()
const p = computed(() => (props.active && waiting.value && waiting.value.sig !== openSig.value ? waiting.value : null))
</script>

<template>
  <div v-if="p" class="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-line bg-[var(--color-chip-amber-bg)] px-4 py-1.5 shadow-sm text-[12.5px] text-[var(--color-chip-amber-fg)]" role="status">
    <MessageCircleQuestion :size="14" class="flex-none" />
    <span class="min-w-0 flex-1 truncate" :title="`${title} asks: ${p.title}`"><span class="font-medium">{{ title }} asks:</span> {{ p.title }}</span>
    <button class="btn btn-brand btn-sm flex-none" @click="openModal">Answer</button>
    <button class="btn btn-ghost btn-sm flex-none" title="Answer in the terminal: hide this until the menu is gone" @click="inTerminal">in the terminal</button>
  </div>
</template>
