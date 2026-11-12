<script setup lang="ts">
// Rename a deck session. For Claude this types /rename into it, so it needs to be idle.
import { onMounted, ref } from 'vue'
import { api, deck } from '../deck'

const s = deck.renameFor!
const name = ref(s.title)
const err = ref('')
const busy = ref(false)
const input = ref<HTMLInputElement>()
const close = () => (deck.renameFor = null)
onMounted(() => (input.value?.focus(), input.value?.select()))
async function save() {
  const n = name.value.replace(/[˜̃®]/g, '').trim() // "®" left behind by ⌥R
  if (!n || n === s.title) return close()
  busy.value = true
  err.value = ''
  try {
    await api(`/api/sessions/${s.tmux}/rename`, { name: n })
    s.title = n
    close()
  } catch (e: any) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="fixed inset-0 z-[70] grid place-items-start justify-center backdrop p-4 pt-[18vh]" @mousedown.self="close">
    <form class="dialog w-full max-w-md p-5" @submit.prevent="save">
      <div class="col-label mb-2">Rename session</div>
      <input ref="input" v-model="name" class="input w-full" maxlength="80" @keydown.esc="close" />
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}</p>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn btn-ghost" @click="close">Cancel</button>
        <button class="btn btn-brand" :disabled="busy">Rename</button>
      </div>
    </form>
  </div>
</template>
