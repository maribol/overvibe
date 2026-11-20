<script setup lang="ts">
// A session's running subagents under its row [T1118-2]: one row each (the first 4, then "N more"), a click shows
// Claude Code's own view of that subagent (its keys, src/subnav.ts), or a read-only view when it can't switch. They come and go with the session's Agent tool calls; nothing to stop or move here.
import { computed, ref } from 'vue'
import { Bot } from 'lucide-vue-next'
import { ago, deck, showSubagent, shownAgentOf, type Session } from '../deck'

const props = defineProps<{ s: Session; depth?: number }>()
const all = ref(false)
const list = computed(() => props.s.agents ?? [])
const shown = computed(() => (all.value || list.value.length <= 5 ? list.value : list.value.slice(0, 4)))
const pad = computed(() => ({ paddingLeft: `${10 + ((props.depth ?? 0) + 1) * 16}px` }))
// open read-only here, or shown in Claude Code's own view of the selected session [T1118-5]
const isOpen = (id: string) => (deck.subagent?.key === props.s.key && deck.subagent.id === id) || (!deck.subagent && deck.selected === props.s.key && shownAgentOf(props.s) === id)
</script>

<template>
  <template v-if="list.length">
    <button
      v-for="a in shown" :key="a.id" type="button" class="side-row is-child !py-[3px] text-[12.5px]" :style="pad"
      :class="isOpen(a.id) ? 'is-sel' : ''" :data-subagent="a.id"
      :title="`${a.desc}${a.step ? `\nNow: ${a.step}` : ''}\nSubagent (${a.type}) of “${s.title}”, running. Click to show it in Claude Code.`"
      @click="showSubagent(s.key, a.id)"
    >
      <Bot :size="12" class="-ml-0.5 flex-none text-[var(--color-st-busy)] opacity-80" />
      <span class="min-w-0 flex-1 truncate text-ink-soft">{{ a.step ?? a.desc }}</span>
      <span class="row-time w-6 flex-none text-right text-[10.5px] tabular-nums text-faint opacity-70">{{ ago(a.at) }}</span>
    </button>
    <button v-if="list.length > shown.length || all" type="button" class="side-row is-child !py-[2px] text-[11.5px] text-faint" :style="pad" @click="all = !all">
      <span class="w-3 flex-none"></span>
      <span class="flex-1 text-left">{{ all ? 'Show fewer' : `${list.length - shown.length} more subagents` }}</span>
    </button>
  </template>
</template>
