<script setup lang="ts">
// A button to the Settings section a message names ("... is paused (Settings > Accounts)") [T1112-19]. Renders
// nothing when the text names none.
import { computed } from 'vue'
import { openSettings } from '../deck'
import { settingsLinkIn } from '../settingsNav'

const props = defineProps<{ text: string }>()
const emit = defineEmits<{ open: [] }>()
const item = computed(() => settingsLinkIn(props.text))
</script>

<template>
  <button v-if="item" type="button" class="ml-1 font-medium text-[var(--color-brand-600)] underline underline-offset-2 hover:text-ink" @click="emit('open'); openSettings(item.id)">Open Settings &gt; {{ item.label }}</button>
</template>
