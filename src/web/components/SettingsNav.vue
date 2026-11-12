<script setup lang="ts">
// Settings' second sidebar [T1112-19]: the sections in groups, the page shown highlighted [T1112-100]. ↑/↓ (and Home/End) move
// through it. Narrow panes show SettingsView's select instead.
import { ref } from 'vue'
import { SETTINGS_GROUPS, SETTINGS_ITEMS } from '../settingsNav'

const props = defineProps<{ current: string }>()
const emit = defineEmits<{ go: [id: string] }>()
const root = ref<HTMLElement | null>(null)

function onKey(e: KeyboardEvent) {
  const keys: Record<string, (i: number) => number> = {
    ArrowDown: (i) => Math.min(SETTINGS_ITEMS.length - 1, i + 1),
    ArrowUp: (i) => Math.max(0, i - 1),
    Home: () => 0,
    End: () => SETTINGS_ITEMS.length - 1,
  }
  const step = keys[e.key]
  if (!step || e.metaKey || e.ctrlKey || e.altKey) return
  e.preventDefault()
  const at = SETTINGS_ITEMS.findIndex((i) => i.id === props.current)
  const next = SETTINGS_ITEMS[step(at < 0 ? -1 : at)]!
  emit('go', next.id)
  root.value?.querySelector<HTMLElement>(`[data-nav="${next.id}"]`)?.focus()
}
</script>

<template>
  <nav ref="root" aria-label="Settings sections" class="w-52 flex-none overflow-y-auto overscroll-contain border-r border-line px-3 py-5" @keydown="onKey">
    <template v-for="(g, gi) in SETTINGS_GROUPS" :key="g.label">
      <p class="col-label px-2.5 pb-1" :class="gi ? 'pt-4' : ''">{{ g.label }}</p>
      <div class="space-y-0.5">
        <button
          v-for="it in g.items"
          :key="it.id"
          type="button"
          :data-nav="it.id"
          :tabindex="it.id === current || (!current && it.id === SETTINGS_ITEMS[0]!.id) ? 0 : -1"
          :aria-current="it.id === current ? 'true' : undefined"
          class="block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)]"
          :class="it.id === current ? 'bg-canvas-2 font-medium text-ink' : 'text-ink-soft hover:bg-[var(--color-row-hover)] hover:text-ink'"
          @click="emit('go', it.id)"
        >{{ it.label }}</button>
      </div>
    </template>
  </nav>
</template>
