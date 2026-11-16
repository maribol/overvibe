<script setup lang="ts">
// Attach to… [T1116-12]: pick the session this one nests under, while both keep running. The list is the
// agent sessions in Overvibe, minus this one and those already under it (no loops); type to filter, Enter picks.
import { computed, onMounted, ref } from 'vue'
import { deck, projectOf, setParent, type Session } from '../deck'

const props = defineProps<{ s: Session }>()
const q = ref('')
const at = ref(0)
const err = ref('')
const input = ref<HTMLInputElement>()
const close = () => (deck.attachFor = null)

// this session and everything attached under it can't become its parent
const below = computed(() => {
  const out = new Set([props.s.key])
  for (let grew = true; grew; ) {
    grew = false
    for (const x of deck.sessions) if (x.attached && x.parent && out.has(x.parent) && !out.has(x.key)) (out.add(x.key), (grew = true))
  }
  return out
})
const list = computed(() => {
  const n = q.value.trim().toLowerCase()
  return deck.sessions
    .filter((x) => x.where === 'deck' && x.kind === 'claude' && (x.tmux || x.suspended) && !below.value.has(x.key) && x.key !== props.s.parent)
    .filter((x) => !n || `${x.title} ${projectOf(x)}`.toLowerCase().includes(n))
    .slice(0, 40)
})
async function pick(p?: Session) {
  if (!p) return
  try {
    await setParent(props.s.key, p.key)
    close()
  } catch (e: any) {
    err.value = e.message
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') (e.preventDefault(), close())
  else if (e.key === 'ArrowDown') (e.preventDefault(), (at.value = Math.min(at.value + 1, list.value.length - 1)))
  else if (e.key === 'ArrowUp') (e.preventDefault(), (at.value = Math.max(at.value - 1, 0)))
  else if (e.key === 'Enter') (e.preventDefault(), pick(list.value[at.value]))
}
onMounted(() => input.value?.focus())
</script>

<template>
  <div class="fixed inset-0 z-[70] grid place-items-start justify-center backdrop p-4 pt-[16vh]" data-attach-modal @mousedown.self="close" @keydown="onKey">
    <div class="dialog w-full max-w-md p-4" role="dialog" aria-modal="true">
      <div class="col-label mb-2">Attach "{{ s.title }}" to</div>
      <input ref="input" v-model="q" class="input w-full" placeholder="Filter sessions" @input="at = 0" />
      <div class="mt-2 max-h-[46vh] overflow-y-auto">
        <button
          v-for="(x, i) in list" :key="x.key" type="button" class="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]"
          :class="i === at ? 'bg-[var(--color-row-sel)] text-ink' : 'text-ink-soft hover:bg-[var(--color-row-hover)]'" @mouseenter="at = i" @click="pick(x)">
          <span class="min-w-0 flex-1 truncate">{{ x.title }}</span>
          <span class="flex-none text-[11.5px] text-faint">{{ projectOf(x) }}</span>
        </button>
        <p v-if="!list.length" class="px-2.5 py-3 text-[13px] text-muted">No other agent session to attach it to.</p>
      </div>
      <p class="mt-2 text-[12px] text-faint">It keeps running. Attached, it nests under that session, which gets Overvibe's notes about it and may stop it.</p>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-danger)]">{{ err }}</p>
    </div>
  </div>
</template>
