<script setup lang="ts">
// The sidebar's account summary: one line per account (Claude, then Codex) with its tightest limit. Click for settings.
// Next to Accounts & settings: Send feedback [T1112-120].
// Hover cards [T1112-126]: the button lists where new sessions go and every setting not at its default; "auto"
// says what it means; each account row shows its limits with their resets.
import { computed } from 'vue'
import { MessageSquareHeart, Settings } from 'lucide-vue-next'
import { deck, openSettings, setView, topUse, type Account } from '../deck'
import { vTip, type TipBody } from '../tip'
import { accountRows, settingsSummary } from '../../settingsdiff'

// Settings > Sidebar can hide the usage rows [T1112-138]
const showRows = computed(() => deck.settings.sidebarAccounts !== false)
const settingsTip = computed((): TipBody => {
  const { rows, changed } = settingsSummary(deck.settings, deck.router)
  return { title: 'Accounts & settings', rows, foot: changed ? `${changed} setting${changed === 1 ? '' : 's'} changed from the defaults. Click to open.` : 'Everything else is at its default. Click to open.' }
})
const defaultTip = computed((): TipBody => {
  const d = deck.settings.defaultAccount
  return d === 'auto'
    ? { title: 'New sessions: auto', rows: ['No fixed account. A folder with its own account uses it; anything else runs on "default".', ...(deck.router ? ['Your local router file picks first.'] : [])], foot: 'Change it in Settings, Accounts' }
    : { title: `New sessions: ${d}`, rows: [`Claude Code sessions run on "${d}" unless their folder has its own account.`], foot: 'Change it in Settings, Accounts' }
})
const rowTip = (a: Account): TipBody => ({
  title: `${a.name} · ${a.tool === 'codex' ? 'Codex' : 'Claude Code'}`,
  rows: [...(a.email ? [a.email] : a.error ? [a.error] : []), ...accountRows(a, Date.now())],
  foot: a.loggingIn ? 'Logging in…' : topUse(a) != null ? 'The bar is the fullest limit' : 'No usage read yet',
})
const tone = (u: number) => (u >= 90 ? 'var(--color-chip-red-fg)' : u >= 70 ? 'var(--color-chip-amber-fg)' : 'var(--color-chip-green-fg)')
</script>

<template>
  <!-- @container: below ~250 px of sidebar the default-account hint hides and the tool word becomes a dot, so nothing wraps or truncates [T1110-84] -->
  <section class="@container border-t border-line px-3 py-2.5">
    <div class="flex items-center gap-1">
    <button
      class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-[7px] text-[13.5px]"
      :class="deck.view === 'settings' ? 'bg-canvas-2 font-medium text-ink' : 'text-ink-soft hover:bg-canvas-2'"
      v-tip="settingsTip"
      @click="deck.view === 'settings' ? setView('terminal') : openSettings('accounts')"
    >
      <Settings :size="17" :stroke-width="1.7" class="flex-none" :class="deck.view === 'settings' ? 'text-[var(--color-brand-600)]' : 'text-faint'" />
      <span class="flex-1 whitespace-nowrap text-left">Accounts &amp; settings</span>
      <span v-tip="defaultTip" class="hidden text-[11px] text-faint @[15.5rem]:inline">{{ deck.settings.defaultAccount === 'auto' ? 'auto' : deck.settings.defaultAccount }}</span>
    </button>
    <!-- Send feedback [T1112-120] -->
    <button class="flex-none rounded-lg p-[7px] text-faint hover:bg-canvas-2 hover:text-ink" v-tip="{ title: 'Send feedback', rows: ['A bug, an idea, anything. It goes to the makers of Overvibe.'] }" aria-label="Send feedback" data-feedback-open @click="deck.feedbackOpen = true">
      <MessageSquareHeart :size="17" :stroke-width="1.7" />
    </button>
    </div>
    <div v-if="showRows && deck.accounts.length" class="mx-2.5 my-1.5 border-t border-line-strong"></div>
    <div v-for="a in showRows ? deck.accounts : []" :key="`${a.tool}:${a.name}`" class="flex items-center gap-2 px-2.5 py-1 text-[12px]" v-tip="() => rowTip(a)">
      <span class="size-1.5 flex-none rounded-full @[15.5rem]:hidden" :style="{ background: a.tool === 'codex' ? '#3987e5' : '#d95926' }"></span>
      <span class="min-w-0 max-w-[50%] flex-none truncate font-medium @[15.5rem]:w-20 @[15.5rem]:max-w-none" :class="a.email ? 'text-ink-soft' : 'text-faint'">{{ a.name }}</span>
      <span class="hidden w-9 flex-none text-[10.5px] text-faint @[15.5rem]:inline">{{ a.tool === 'codex' ? 'codex' : 'claude' }}</span>
      <div class="h-1 min-w-5 flex-1 overflow-hidden rounded-full bg-canvas-2">
        <div v-if="topUse(a) != null" class="h-full rounded-full" :style="{ width: Math.min(100, topUse(a)!) + '%', background: tone(topUse(a)!) }"></div>
      </div>
      <span v-if="a.paused" class="flex-none rounded px-1 text-[10.5px]" style="background: var(--color-chip-amber-bg); color: var(--color-chip-amber-fg)" title="Paused in Settings: no new, resumed or switched sessions run on it">paused</span>
      <span class="w-8 flex-none text-right tabular-nums text-faint">{{ topUse(a) != null ? Math.round(topUse(a)!) + '%' : a.loggingIn ? 'login' : a.email ? '…' : 'off' }}</span>
    </div>
  </section>
</template>
