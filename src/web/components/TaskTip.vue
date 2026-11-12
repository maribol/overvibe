<script setup lang="ts">
// A sidebar row's task tooltip [T1112-116]: the session's open TASKS.md lines (tagged with one of its ids),
// waiting-on-you ones first, and the project's totals. Sits right of the sidebar so it never covers a row
// (or the row's ✕ close). Built from the lines the page already loaded; a hover reads no file.
import { computed, nextTick, ref, watch } from 'vue'
import { Hand } from 'lucide-vue-next'
import { setView, type Session } from '../deck'
import { fileForCwd } from '../../taskview'
import { taskFiles, tasksPick, tipFor } from '../tasks'

const props = defineProps<{ s: Session; left: number; top: number }>()
const emit = defineEmits<{ enter: []; leave: []; done: [] }>()
const tip = computed(() => tipFor(props.s))
const el = ref<HTMLElement | null>(null)
// keep it on screen: start at the row's top, move up when it would run off the bottom
const y = ref(props.top)
watch(() => [props.top, tip.value], () => {
  y.value = props.top
  nextTick(() => {
    const h = el.value?.offsetHeight ?? 0
    y.value = Math.max(8, Math.min(props.top, innerHeight - h - 8))
  })
}, { immediate: true })

function openTasks() {
  const f = fileForCwd(taskFiles.value, props.s.cwd)
  if (!f) return
  tasksPick.value = f.file
  setView('tasks')
  emit('done')
}
</script>

<template>
  <div v-if="tip" ref="el" class="dialog fixed z-[70] w-[340px] px-3 py-2.5 text-[12.5px]" :style="{ left: left + 'px', top: y + 'px' }" data-tasktip
    @pointerenter="emit('enter')" @pointerleave="emit('leave')">
    <div class="truncate font-medium text-ink">{{ s.title }}</div>
    <div class="pill-mono truncate text-[11px] text-faint">{{ s.cwd }}</div>
    <p v-if="s.question" class="mt-1 line-clamp-2 text-[var(--color-st-wait)]">Needs you: {{ s.question }}</p>
    <ul v-if="tip.lines.length" class="mt-2 space-y-0.5">
      <li v-for="(x, i) in tip.lines" :key="x.id ?? i">
        <button class="flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left hover:bg-[var(--color-row-hover)]" title="Open the Tasks view on this project" @click="openTasks">
          <Hand v-if="x.waiting" :size="11" class="mt-[2px] flex-none self-start text-[var(--color-chip-amber-fg)]" />
          <span v-if="x.id" class="pill-mono flex-none text-[11px] text-faint">{{ x.id }}</span>
          <span class="min-w-0 text-ink-soft">{{ x.text }}<span v-if="x.waiting" class="text-[var(--color-chip-amber-fg)]"> · waiting on you</span></span>
        </button>
      </li>
      <li v-if="tip.more" class="px-1 text-faint">+{{ tip.more }} more</li>
    </ul>
    <button class="mt-2 block w-full border-t border-line pt-1.5 text-left text-[11.5px] text-faint hover:text-ink" title="Open the Tasks view on this project" @click="openTasks">
      Project: {{ tip.open }} open<template v-if="tip.waiting">, {{ tip.waiting }} waiting on you</template>
    </button>
  </div>
</template>
