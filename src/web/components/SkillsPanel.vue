<script setup lang="ts">
// Skills [T1110-64]: one library linked into Claude Code, Codex and agy. Which CLIs and folders each goes to,
// whether every link is in place, clashes with the CLIs' own skills, and one-click import of a skill a CLI
// already has. Recommended integrations are labeled and have their own switch (on by default; the setup screen asks first).
import { computed, onMounted, ref } from 'vue'
import { Download, RefreshCw } from 'lucide-vue-next'
import Spinner from './Spinner.vue'
import { ago, api } from '../deck'

type Place = { path: string; tool: string; scope: string; kind: string; state: 'ok' | 'clash' | 'modified' | 'error'; note?: string }
type Skill = { name: string; description: string; tools: string[]; projects: string[]; aliases: string[]; on: boolean; defaultOn: boolean; pending: boolean; recommended?: string; source: 'library' | 'bundled'; dir: string; problems: string[]; places: Place[] }
type Other = { tool: string; name: string; description: string; path: string; inLibrary: boolean }
type Report = { library: string; bundled: string; syncedAt: number; changes: string[]; dirs: Record<string, string[]>; skills: Skill[]; others: Other[] }

const r = ref<Report | null>(null)
const busy = ref('')
const msg = ref('')
const showOthers = ref(false)
const TOOL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'agy' }

async function load() {
  r.value = await api<Report>('/api/skills')
}
async function run(key: string, path: string, body: unknown, done?: string) {
  busy.value = key
  msg.value = ''
  try {
    await api(path, body)
    await load()
    if (done) msg.value = done
  } catch (e: any) {
    msg.value = e.message
  } finally {
    busy.value = ''
  }
}
const toggle = (s: Skill) => run(s.name, '/api/skills/on', { name: s.name, on: !s.on })
const importOne = (o: Other) =>
  run(`${o.tool}/${o.name}`, '/api/skills/import', { tool: o.tool, name: o.name, replace: true }, `"${o.name}" is in the library; the ${TOOL[o.tool]} copy was backed up to ~/.config/overvibe/skills-backup/ and replaced by a link.`)

const recommended = computed(() => r.value?.skills.filter((s) => s.recommended) ?? [])
const regular = computed(() => r.value?.skills.filter((s) => !s.recommended) ?? [])
const others = computed(() => r.value?.others.filter((o) => !o.inLibrary) ?? [])
const bad = (s: Skill) => s.places.filter((p) => p.state !== 'ok')
const linked = (s: Skill, tool: string) => s.places.some((p) => p.tool === tool && p.state === 'ok') || (tool === 'codex' && s.places.some((p) => p.tool === 'agy' && p.scope !== 'user' && p.state === 'ok'))

onMounted(load)
</script>

<template>
  <section>
    <div class="flex items-end justify-between gap-4">
      <div>
        <h2 class="text-lg font-semibold">Skills</h2>
        <p class="text-[13px] text-muted">
          One library for every agent. Overvibe links each skill into Claude Code, Codex and agy (agy gets a copy inside project folders), and only ever touches the links it made: a skill a CLI already has with the same name is shown as a clash and left alone.
          Library: <span class="font-mono text-[12px]">{{ r?.library ?? '…' }}</span>
        </p>
      </div>
      <button class="btn btn-soft btn-sm flex-none" :disabled="busy === 'sync'" @click="run('sync', '/api/skills/sync', {})"><Spinner v-if="busy === 'sync'" /><RefreshCw v-else :size="14" /> Sync now</button>
    </div>
    <p v-if="msg" class="mt-2 text-[13px] text-muted">{{ msg }}</p>

    <!-- recommended integrations: labeled, with their own switch (on by default once setup has asked) -->
    <div v-for="s in recommended" :key="s.name" class="card mt-4 flex items-start gap-4 p-4">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] font-semibold">Recommended integration: {{ s.recommended }}</div>
        <p class="mt-0.5 text-[13px] text-muted">{{ s.description }}</p>
        <p class="mt-1 text-[12px] text-faint">Optional{{ s.defaultOn ? ', on by default' : '' }}{{ s.pending ? ' (not chosen yet)' : '' }}. When on, the <span class="font-mono">{{ s.name }}</span> skill is linked into {{ s.tools.map((t) => TOOL[t]).join(', ') }} like any other skill; off removes those links.</p>
      </div>
      <button
        role="switch"
        :aria-checked="s.on"
        :aria-label="`${s.recommended}: ${s.on ? 'on' : 'off'}`"
        class="relative mt-1 h-5 w-9 flex-none rounded-full transition-colors"
        :class="s.on ? 'bg-[var(--color-brand-600)]' : 'bg-[var(--color-line-strong,#d4d4d8)]'"
        :disabled="busy === s.name"
        @click="toggle(s)"
      >
        <span class="absolute top-0.5 size-4 rounded-full bg-white shadow transition-all" :class="s.on ? 'left-[18px]' : 'left-0.5'"></span>
      </button>
    </div>

    <div class="card mt-4 overflow-hidden">
      <div class="flex border-b border-line px-4 py-2">
        <span class="col-label flex-1">Skill</span><span class="col-label w-56">Goes to</span><span class="col-label w-44">Status</span><span class="col-label w-16 text-right">On</span>
      </div>
      <div v-if="!r" class="px-4 py-3 text-[13px] text-muted">Loading…</div>
      <div v-for="s in regular" :key="s.name" class="border-b border-line px-4 py-2.5 text-[13px] last:border-0">
        <div class="flex items-start">
          <div class="min-w-0 flex-1 pr-3">
            <div class="font-medium">{{ s.name }} <span v-if="s.source === 'bundled'" class="ml-1 text-[11.5px] font-normal text-faint">ships with Overvibe</span><span v-if="s.aliases.length" class="ml-1 text-[11.5px] font-normal text-faint">also as {{ s.aliases.join(', ') }}</span></div>
            <div class="line-clamp-2 text-[12.5px] text-muted" :title="s.description">{{ s.description }}</div>
          </div>
          <div class="w-56 text-[12.5px]">
            <div class="flex flex-wrap gap-1">
              <span v-for="t in s.tools" :key="t" class="chip" :class="s.on && !linked(s, t) ? 'opacity-50' : ''" :title="s.on && !linked(s, t) ? 'not linked yet' : ''">{{ TOOL[t] }}</span>
            </div>
            <div class="mt-0.5 truncate text-faint" :title="s.projects.join('\n')">{{ s.projects.length ? s.projects.join(', ') : 'every folder' }}</div>
          </div>
          <div class="w-44 text-[12.5px]">
            <span v-if="!s.on" class="text-faint">off</span>
            <span v-else-if="!bad(s).length && !s.problems.length" class="text-[var(--color-chip-green-fg,#15803d)]">{{ s.places.length }} link{{ s.places.length === 1 ? '' : 's' }} in place</span>
            <span v-else class="text-[var(--color-chip-red-fg)]">{{ bad(s).length ? `${bad(s).length} clash${bad(s).length === 1 ? '' : 'es'}` : 'needs a fix' }}</span>
          </div>
          <div class="w-16 text-right">
            <input type="checkbox" class="size-4 accent-[var(--color-brand-600)]" :checked="s.on" :disabled="busy === s.name" :aria-label="`${s.name} on`" @change="toggle(s)" />
          </div>
        </div>
        <ul v-if="s.on && (bad(s).length || s.problems.length)" class="mt-1 space-y-0.5 text-[12px] text-muted">
          <li v-for="p in bad(s)" :key="p.path"><span class="font-mono">{{ p.path }}</span> ({{ TOOL[p.tool] }}): {{ p.note }}</li>
          <li v-for="p in s.problems" :key="p">{{ p }}</li>
        </ul>
      </div>
    </div>
    <p v-if="r" class="mt-2 text-[12px] text-faint">
      Synced {{ r.syncedAt ? ago(r.syncedAt) : 'not yet' }}; it syncs again on its own when the library changes. Add one: <span class="font-mono">overvibe skills add &lt;folder&gt;</span>. Mark a skill with <span class="font-mono">tools: [claude, codex]</span> or <span class="font-mono">projects: [~/code/app]</span> in its SKILL.md to narrow where it goes.
    </p>

    <!-- the CLIs' own skills, not in the library yet -->
    <div v-if="others.length" class="mt-4">
      <button class="text-[13px] font-medium text-muted hover:text-ink" @click="showOthers = !showOthers">{{ showOthers ? '▾' : '▸' }} {{ others.length }} skill{{ others.length === 1 ? '' : 's' }} only one CLI has</button>
      <div v-if="showOthers" class="card mt-2 overflow-hidden">
        <div v-for="o in others" :key="o.tool + o.name" class="flex items-center gap-3 border-b border-line px-4 py-2 text-[13px] last:border-0">
          <span class="chip w-24 flex-none justify-center">{{ TOOL[o.tool] }}</span>
          <div class="min-w-0 flex-1">
            <div class="font-medium">{{ o.name }}</div>
            <div class="truncate text-[12px] text-muted" :title="o.description">{{ o.description }}</div>
          </div>
          <button class="btn btn-soft btn-sm flex-none" :disabled="!!busy" :title="`Copy into the library so every CLI gets it; the ${TOOL[o.tool]} copy is backed up and replaced by a link`" @click="importOne(o)">
            <Spinner v-if="busy === `${o.tool}/${o.name}`" /><Download v-else :size="14" /> Import
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
