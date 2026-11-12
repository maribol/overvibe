<script setup lang="ts">
// Right-click on a session row: the actions from its card, without opening it first.
import { computed, onMounted, onUnmounted } from 'vue'
import { api, copy, deck, isPinned, refresh, select, setPinned, startSession, askStop, type Session } from '../deck'

const m = deck.menu!
const s: Session = m.s
const close = () => (deck.menu = null)
type Item = { label: string; run: () => unknown; danger?: boolean } | 'sep'
const live = s.where === 'terminal' || s.where === 'background'
const items = computed<Item[]>(() => {
  const out: Item[] = [{ label: 'Open', run: () => select(s.key) }]
  if (s.kind !== 'login') out.push(isPinned(s) ? { label: 'Unpin', run: () => setPinned(s, false) } : { label: 'Pin to top', run: () => setPinned(s, true) })
  if (s.where === 'deck' && s.tmux) out.push({ label: 'Rename…', run: () => (deck.renameFor = s) })
  if (s.sessionId && s.kind === 'claude' && !s.noTranscript) {
    if (s.where === 'terminal') out.push({ label: 'Move here', run: () => select(s.key) })
    out.push({ label: live ? 'Copy here' : s.where === 'deck' && s.tmux ? 'Copy into a new session' : 'Resume here', run: () => startSession({ tool: s.tool ?? 'claude', cwd: s.cwd, account: 'auto', name: s.title, resume: s.sessionId!, fork: live || !!s.tmux }) })
    if (s.where !== 'background') out.push({ label: 'Move to another folder…', run: () => (deck.moveFor = s) })
  }
  out.push('sep')
  if (s.sessionId) out.push({ label: 'Copy resume command', run: () => copy(`cd ${s.cwd} && claude --resume ${s.sessionId}`) })
  out.push({ label: 'Copy folder path', run: () => copy(s.cwd) })
  out.push('sep')
  if (s.where === 'deck' && s.tmux) out.push({ label: 'Stop', danger: true, run: () => askStop(s) })
  if (s.where === 'deck' && !s.tmux) out.push({ label: 'Hide', run: () => api(`/api/sessions/${s.key}/forget`, {}) })
  if (s.where === 'background' && s.status !== 'blocked') out.push({ label: 'Stop', danger: true, run: () => api(`/api/bg/${s.sessionId}/stop`, {}) })
  if (s.where !== 'deck' && s.sessionId) out.push({ label: 'Hide', run: () => api('/api/hide', { sessionId: s.sessionId }) })
  return out.filter((x, i, a) => x !== 'sep' || (i > 0 && a[i - 1] !== 'sep' && i < a.length - 1))
})
async function run(i: Exclude<Item, 'sep'>) {
  close()
  try {
    await i.run()
  } catch (e: any) {
    alert(e.message)
  }
  refresh()
}
// keep it on screen
const pos = computed(() => ({ left: Math.min(m.x, innerWidth - 230) + 'px', top: Math.min(m.y, innerHeight - 40 - items.value.length * 30) + 'px' }))
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
onMounted(() => addEventListener('keydown', onKey))
onUnmounted(() => removeEventListener('keydown', onKey))
</script>

<template>
  <div class="fixed inset-0 z-[80]" @mousedown.self="close" @contextmenu.prevent="close">
    <div class="dialog absolute w-56 py-1" :style="pos">
      <div class="truncate px-3 pb-1 pt-1.5 text-[11px] font-semibold text-faint">{{ s.title }}</div>
      <template v-for="(i, k) in items" :key="k">
        <div v-if="i === 'sep'" class="my-1 border-t border-line"></div>
        <button v-else class="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-[var(--color-row-sel)]" :class="i.danger ? 'text-[var(--color-danger)]' : 'text-ink'" @click="run(i)">{{ i.label }}</button>
      </template>
    </div>
  </div>
</template>
