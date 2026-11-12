<script setup lang="ts">
// Right-click on a project header in the sidebar [T1112-102]: like the row menu (SessionMenu), for the whole group.
import { computed, onMounted, onUnmounted } from 'vue'
import { deck, projectRows } from '../deck'
import { planClose } from '../../closeall'

const m = deck.projectMenu!
const close = () => (deck.projectMenu = null)
const n = computed(() => planClose(projectRows(m.name)).filter((x) => x.action !== 'skip').length)
function closeAll() {
  close()
  deck.closeAllFor = m.name
}
const pos = computed(() => ({ left: Math.min(m.x, innerWidth - 230) + 'px', top: Math.min(m.y, innerHeight - 90) + 'px' }))
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
onMounted(() => addEventListener('keydown', onKey))
onUnmounted(() => removeEventListener('keydown', onKey))
</script>

<template>
  <div class="fixed inset-0 z-[80]" @mousedown.self="close" @contextmenu.prevent="close">
    <div class="dialog absolute w-56 py-1" :style="pos" data-test="project-menu">
      <div class="truncate px-3 pb-1 pt-1.5 text-[11px] font-semibold text-faint">{{ m.name }}</div>
      <button class="block w-full px-3 py-1.5 text-left text-[13px] text-[var(--color-danger)] hover:bg-[var(--color-row-sel)] disabled:opacity-50" :disabled="!n" @click="closeAll">
        Close all{{ n ? '…' : '' }}<span class="float-right text-[11.5px] text-faint">{{ n || 'none' }}</span>
      </button>
    </div>
  </div>
</template>
