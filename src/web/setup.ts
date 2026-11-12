// First-run setup [T1110-67]: shown once per install (the `setup-done` id in the What's new seen list on the
// server, so every browser and the desktop app agree), reopened from Settings and the palette ("Setup").
// The safety note is its last step; its own flag (`first-run-safety`) stays separate, so someone who
// already read it is not asked again, and closing the setup early still shows the note on its own.
import { reactive } from 'vue'
import { api, deck } from './deck'
import { news } from './news'

const DONE = 'setup-done'
const SAFETY = 'first-run-safety'

/** SetupView sets this: work to do however the setup is closed (save the Welcome step's checkbox) */
let beforeClose: (() => Promise<void>) | null = null
export const onSetupClose = (f: (() => Promise<void>) | null) => (beforeClose = f)

export const setup = reactive({
  /** the first-run check has answered (until then the safety note waits) */
  checked: false,
  /** the safety note was acknowledged on this install; null while unknown */
  safetySeen: null as boolean | null,
  /** the step on screen, kept while the setup is put aside for a login */
  step: 0,
})

export async function checkFirstRun() {
  let shown: string[] | null = null
  try {
    shown = (await api<{ modalShown: string[] }>('/api/news')).modalShown
  } catch {
    /* unsure: show the safety note, skip the setup */
  }
  setup.safetySeen = !!shown?.includes(SAFETY)
  if (setup.safetySeen) news.safetyPending = false
  if (shown && !shown.includes(DONE)) openSetup()
  setup.checked = true
}

export function openSetup(step = 0) {
  setup.step = step
  deck.setupAway = false
  deck.setupOpen = true
}

/** set the setup aside (a login terminal or the add-account dialog needs the screen); a pill brings it back */
export function putSetupAside() {
  deck.setupOpen = false
  deck.setupAway = true
}
export function resumeSetup() {
  deck.setupAway = false
  deck.setupOpen = true
}

/** closed by finishing or skipping it: record it so it does not open by itself again */
export async function finishSetup() {
  await beforeClose?.()
  deck.setupOpen = false
  deck.setupAway = false
  try {
    await api('/api/news/seen', { ids: [DONE], modal: true })
  } catch {}
}

export async function ackSafety() {
  setup.safetySeen = true
  news.safetyPending = false
  try {
    await api('/api/news/seen', { ids: [SAFETY], modal: true })
  } catch {}
}
