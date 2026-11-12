<script setup lang="ts">
defineProps<{ size?: number }>()
</script>

<template>
  <svg :width="size || 18" :height="size || 18" viewBox="0 0 24 24" fill="none" class="animate-spin" style="animation: spin 0.8s linear infinite">
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-opacity="0.18" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
  </svg>
</template>

<style scoped>
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
