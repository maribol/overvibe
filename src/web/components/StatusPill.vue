<script setup lang="ts">
import { computed } from 'vue'

type Tone = 'gray' | 'violet' | 'amber' | 'green' | 'blue' | 'red' | 'accent'
const props = withDefaults(defineProps<{ label: string; tone?: Tone; dot?: boolean; pulse?: boolean }>(), {
  tone: 'gray',
  dot: true,
  pulse: false,
})

const TONES: Record<Tone, { bg: string; fg: string }> = {
  gray: { bg: 'var(--color-chip-gray-bg)', fg: 'var(--color-chip-gray-fg)' },
  violet: { bg: 'var(--color-chip-violet-bg)', fg: 'var(--color-chip-violet-fg)' },
  amber: { bg: 'var(--color-chip-amber-bg)', fg: 'var(--color-chip-amber-fg)' },
  green: { bg: 'var(--color-chip-green-bg)', fg: 'var(--color-chip-green-fg)' },
  blue: { bg: 'var(--color-chip-blue-bg)', fg: 'var(--color-chip-blue-fg)' },
  red: { bg: 'var(--color-chip-red-bg)', fg: 'var(--color-chip-red-fg)' },
  accent: { bg: 'var(--color-chip-accent-bg)', fg: 'var(--color-chip-accent-fg)' },
}
const c = computed(() => TONES[props.tone])
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold"
    :style="{ background: c.bg, color: c.fg }"
  >
    <span
      v-if="dot"
      class="size-1.5 flex-none rounded-full"
      :class="pulse ? 'animate-pulse-ring' : ''"
      :style="{ background: c.fg }"
    ></span>
    {{ label }}
  </span>
</template>
