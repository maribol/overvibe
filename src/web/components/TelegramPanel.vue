<script setup lang="ts">
// Telegram bots [T1113-3]: add a bot by its token, pair it with your Telegram account, link the groups it is in to
// project folders. Customer messages in a linked group get a read-only research run in that folder; the report comes
// to you privately. The token never comes back to the page.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Spinner from './Spinner.vue'
import { ago, api, deck } from '../deck'
async function setHelpCards(on: boolean) {
  await api('/api/settings', { helpCardsTelegram: on })
  deck.settings.helpCardsTelegram = on
}

type Chat = { id: number; title: string; type: string; cwd: string | null; project: string | null; autoReply?: boolean }
type Bot = { id: string; username: string; name: string; readsAll: boolean; owner: { id: number; name: string } | null; pairCode: string | null; cwd: string | null; project: string | null; readDirs: string[]; chats: Chat[]; on: boolean; running: boolean; status: { ok: boolean; at: number; error?: string } | null }
type View = { bots: Bot[]; dir: string }

const v = ref<View | null>(null)
const token = ref('')
const busy = ref('')
const msg = ref('')

async function load() {
  v.value = await api<View>('/api/telegram')
}
async function run(key: string, path: string, body: unknown) {
  busy.value = key
  msg.value = ''
  try {
    v.value = await api<View>(path, body)
    return true
  } catch (e: any) {
    msg.value = e.message
    return false
  } finally {
    busy.value = ''
  }
}
async function add() {
  if (await run('add', '/api/telegram/add', { token: token.value.trim() })) token.value = ''
}
const change = (b: Bot, body: Record<string, unknown>, key = b.id) => run(key, '/api/telegram/bot', { id: b.id, ...body })

// folders the sidebar knows, as suggestions
const folders = computed(() => [...new Set(deck.sessions.filter((s) => s.kind === 'claude').map((s) => s.cwd))].sort())
const groups = (b: Bot) => b.chats.filter((c) => c.type !== 'private')

let t: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void load()
  // pairing and new groups happen in Telegram: keep the page current while it is open
  t = setInterval(() => void load().catch(() => {}), 5000)
})
onUnmounted(() => clearInterval(t))
</script>

<template>
  <section>
    <h2 class="text-lg font-semibold">Telegram</h2>
    <p class="text-[13px] text-muted">
      Add a bot to your customer groups and link each group to a project. When a customer writes, a read-only agent researches it in that project: what they want, what is true today, whether a fix or feature is worth it and fits the brand, a plan and a draft reply. The report comes to you in a private chat with the bot. Nothing goes to a customer until you tap Send reply.
    </p>

    <datalist id="tg-folders"><option v-for="f in folders" :key="f" :value="f" /></datalist>

    <div class="card mt-3 p-4 text-[13px]">
      <div class="font-medium">Add a bot</div>
      <p class="text-muted">Make one with @BotFather (/newbot) and paste its token. It is kept in {{ v?.dir ?? '~/.config/overvibe/telegram' }}/bots.json, readable only by you.</p>
      <form class="mt-2 flex gap-2" @submit.prevent="add">
        <input v-model="token" type="password" autocomplete="off" class="input flex-1 !py-1.5 font-mono !text-[12.5px]" placeholder="123456789:AA..." data-tg-token />
        <button class="btn btn-soft btn-sm" :disabled="!token.trim() || busy === 'add'"><Spinner v-if="busy === 'add'" /> Add</button>
      </form>
    </div>

    <p v-if="msg" class="mt-2 text-[13px] text-[var(--color-chip-red-fg)]">{{ msg }}</p>

    <div v-for="b in v?.bots ?? []" :key="b.id" class="card mt-3 p-4 text-[13px]" :data-tg-bot="b.username">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <span class="font-medium">{{ b.name }}</span>
          <span class="text-muted"> @{{ b.username }}</span>
          <div class="text-[12px]" :class="b.status && !b.status.ok ? 'text-[var(--color-chip-red-fg)]' : 'text-faint'">
            <template v-if="!b.on">Off</template>
            <template v-else-if="b.status && !b.status.ok">{{ b.status.error }}</template>
            <template v-else-if="b.running">Listening{{ b.status ? `, last checked ${ago(b.status.at)}` : '' }}</template>
            <template v-else>Starting…</template>
          </div>
        </div>
        <label class="flex items-center gap-1.5 text-[12.5px]"><input type="checkbox" :checked="b.on" @change="change(b, { on: ($event.target as HTMLInputElement).checked })" /> On</label>
        <button class="btn btn-ghost btn-sm" @click="change(b, { recheck: true })">Re-check</button>
        <button class="btn btn-ghost btn-sm" @click="change(b, { remove: true })">Remove</button>
      </div>

      <!-- add-on help cards [T1118-19] -->
      <label class="mt-3 flex items-start gap-2 border-t border-line pt-3" data-tg-addonhelp>
        <input type="checkbox" class="mt-1" :checked="deck.settings.helpCardsTelegram !== false" @change="setHelpCards(($event.target as HTMLInputElement).checked)" />
        <span><span class="font-medium">Send add-on help cards here</span><br /><span class="text-[12.5px] text-muted">Off: help cards from the add-on show only in Requests, with the same buttons, and nothing arrives in Telegram.</span></span>
      </label>

      <!-- pairing -->
      <div class="mt-3 border-t border-line pt-3">
        <div v-if="b.owner" class="flex items-center gap-2">
          <span>Reports go to <span class="font-medium">{{ b.owner.name }}</span> in a private chat with the bot.</span>
          <button class="btn btn-ghost btn-sm" @click="change(b, { unpair: true })">Unpair</button>
        </div>
        <div v-else>
          <span class="font-medium">Pair it with your Telegram account:</span> open a private chat with @{{ b.username }} and send
          <span class="pill-mono select-all" data-tg-pair>/pair {{ b.pairCode }}</span>
          <button class="btn btn-ghost btn-sm" @click="change(b, { newCode: true })">New code</button>
        </div>
        <p v-if="!b.readsAll" class="mt-2 text-[12.5px] text-[var(--color-chip-amber-fg,inherit)]">Privacy mode is on: in groups this bot only sees commands and replies to it. In @BotFather send /setprivacy, pick the bot, choose Disable, then remove the bot from each group and add it again, and press Re-check.</p>
      </div>

      <!-- groups -->
      <div class="mt-3 border-t border-line pt-3">
        <div class="font-medium">Groups</div>
        <p class="text-muted">Add the bot to a group in Telegram and it shows up here. A group with no project is ignored.</p>
        <div v-for="c in groups(b)" :key="c.id" class="mt-1.5 flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate">{{ c.title }}</span>
          <input class="input !w-72 !py-1 !text-[12.5px]" list="tg-folders" :value="c.cwd ?? ''" placeholder="no project (ignored)" @change="change(b, { chat: c.id, chatCwd: ($event.target as HTMLInputElement).value }, `c${c.id}`)" />
          <span class="w-28 truncate text-[12px] text-faint">{{ c.project ?? '' }}</span>
          <label class="flex flex-none items-center gap-1.5 text-[12px] text-muted" title="Post the drafted reply in this group as soon as the research is done, as a reply to the last message. Off: it waits for you to press Send reply." data-tg-autoreply>
            <input type="checkbox" :checked="!!c.autoReply" :disabled="!c.cwd" @change="change(b, { chat: c.id, autoReply: ($event.target as HTMLInputElement).checked })" /> Auto reply
          </label>
          <button class="btn btn-ghost btn-sm" title="Forget this group (it comes back if the bot sees a message there)" @click="change(b, { chat: c.id, forget: true })">Forget</button>
        </div>
        <div v-if="!groups(b).length" class="mt-1 text-faint">No groups yet.</div>
      </div>

      <!-- the bot's own project and extra reading -->
      <div class="mt-3 grid gap-2 border-t border-line pt-3">
        <label class="flex items-center gap-2">
          <span class="flex-1"><span class="font-medium">Messages you send the bot</span><span class="text-muted"> (forwards too) are researched in</span></span>
          <input class="input !w-72 !py-1 !text-[12.5px]" list="tg-folders" :value="b.cwd ?? ''" placeholder="a project folder" @change="change(b, { cwd: ($event.target as HTMLInputElement).value })" />
        </label>
        <label class="flex items-center gap-2">
          <span class="flex-1"><span class="font-medium">Also readable</span><span class="text-muted"> by the research agent (docs, the marketing site), comma separated</span></span>
          <input class="input !w-72 !py-1 !text-[12.5px]" :value="b.readDirs.join(', ')" placeholder="~/Work/project-docs" @change="change(b, { readDirs: ($event.target as HTMLInputElement).value.split(',') })" />
        </label>
      </div>
    </div>

    <p class="mt-3 text-[12.5px] text-faint">The research agent runs as a headless Claude Code in restricted mode: it reads the project folder (keys and .env files excluded) and can search the web, and cannot run commands, fetch pages or change files. It waits for a minute of quiet so a burst of messages gets one run, skips small talk, and runs at most two at a time on the account the folder's rules pick.</p>
  </section>
</template>
