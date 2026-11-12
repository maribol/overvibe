<script setup lang="ts">
// Add a login for Claude Code (CLAUDE_CONFIG_DIR) or Codex (CODEX_HOME). agy keeps one Google login in
// its own store (the macOS keychain on a Mac) and has no setting for another config folder, so it gets no accounts.
import { computed, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { api, deck, refresh, select } from '../deck'

type T = 'claude' | 'codex' | 'agy'
const TOOLS: { id: T; label: string }[] = [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }, { id: 'agy', label: 'agy' }]
const tool = ref<T>('claude')
const name = ref('')
const err = ref('')
const where = computed(() => (tool.value === 'codex' ? '~/.codex-accounts' : '~/.claude-accounts'))
async function create() {
  if (tool.value === 'agy') return
  err.value = ''
  try {
    const r = await api<{ tmux: string }>('/api/accounts', { name: name.value.trim().toLowerCase(), tool: tool.value })
    deck.addAccountOpen = false
    await refresh()
    select(r.tmux)
  } catch (e: any) {
    err.value = e.message
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-center backdrop p-4" @mousedown.self="deck.addAccountOpen = false">
    <form class="dialog w-full max-w-md p-6" @submit.prevent="create">
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold">Add an account</h3>
        <button type="button" class="rounded-md p-1 text-faint hover:bg-canvas-2 hover:text-ink" @click="deck.addAccountOpen = false"><X :size="18" /></button>
      </div>
      <div class="mt-4 flex gap-1 rounded-lg border border-line bg-canvas p-1">
        <button v-for="t in TOOLS" :key="t.id" type="button" class="flex-1 rounded-md py-1.5 text-[13px] font-medium"
          :class="tool === t.id ? 'bg-[var(--color-row-sel)] text-ink ring-1 ring-line-strong' : 'text-muted hover:text-ink'" @click="(tool = t.id), (err = '')">{{ t.label }}</button>
      </div>
      <template v-if="tool !== 'agy'">
        <p class="mt-3 text-[13px] text-muted">
          Makes <code class="pill-mono">{{ where }}/&lt;name&gt;</code> with your
          {{ tool === 'codex' ? 'config, rules, skills and sessions' : 'settings, skills and transcripts' }} linked in, then opens a
          terminal to log in{{ tool === 'codex' ? ' with codex login' : '' }}. Sign in there with the subscription you want this account to use.
        </p>
        <label class="mt-4 block text-[12px] font-medium text-muted">Name
          <input v-model="name" class="input mt-1" placeholder="e.g. work, personal" pattern="[a-z0-9][a-z0-9\-]{0,30}" required autofocus />
        </label>
      </template>
      <p v-else class="mt-3 text-[13px] text-muted">
        agy uses one login. It keeps one Google sign-in of its own and has no setting for a second config folder,
        so every agy session runs on the account you signed in to in agy. To change it, run <code class="pill-mono">/logout</code> in an agy session and sign in again.
      </p>
      <p v-if="err" class="mt-2 text-[13px] text-[var(--color-chip-red-fg)]">{{ err }}</p>
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn btn-ghost" @click="deck.addAccountOpen = false">{{ tool === 'agy' ? 'Close' : 'Cancel' }}</button>
        <button v-if="tool !== 'agy'" class="btn btn-brand">Create and log in</button>
      </div>
    </form>
  </div>
</template>
