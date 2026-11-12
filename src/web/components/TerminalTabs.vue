<script setup lang="ts">
// The current project's deck sessions as tabs. A terminal, once opened, keeps its xterm and
// WebSocket while hidden, so switching is instant and nothing reconnects.
import { computed } from 'vue'
import { current, deck, isCoordinator, projectOf, select } from '../deck'
import { Star } from 'lucide-vue-next'
import TerminalView from './TerminalView.vue'

// terminals that are mounted (opened at least once); they stay connected while hidden
const mounted = computed(() =>
  deck.tabs.map((t) => deck.sessions.find((s) => s.tmux === t)).filter((s): s is NonNullable<typeof s> => !!s),
)
// the strip: every running deck session of the current project, coordinators first
let lastProject = ''
const strip = computed(() => {
  const cur = current.value
  const proj = cur ? projectOf(cur) : lastProject
  if (cur) lastProject = proj
  return deck.sessions
    .filter((s) => s.where === 'deck' && s.tmux && projectOf(s) === proj)
    .sort((a, b) => Number(isCoordinator(b)) - Number(isCoordinator(a)) || a.title.localeCompare(b.title))
})
</script>

<template>
  <div class="flex flex-col">
    <div v-show="deck.selected && deck.tabs.includes(deck.selected)" class="relative min-h-0 flex-1">
      <TerminalView v-for="s in mounted" :key="s.tmux!" :s="s" :active="s.tmux === deck.selected" />
    </div>
  </div>
</template>
