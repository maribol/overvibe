// A choice menu on the open session's screen (permission, question, folder trust), shared by the
// dialog (PromptModal) and the slim bar over the terminal (PromptBar).
// The dialog opens by itself only when a new menu appears while you are already on that session.
// Switching to a session whose menu was already waiting shows the bar instead; its Answer button
// opens the dialog. "Answer in the terminal" (dialog or bar) hides both for that session until its
// menu is gone, so the next question of the same set, or text typed into the menu, stays quiet.
// Off by default [T1111-23]: no dialog and no bar, you answer in the terminal and the sidebar marks
// the session yellow. Settings > Questions turns them back on (a browser preference, localStorage).
import { computed, ref, watch } from 'vue'
import { current, deck } from './deck'

/** show question dialogs and the bar over the terminal (Settings > Questions; off by default) */
export const promptDialogs = ref(localStorage.getItem('deck.promptDialogs') === '1')
export function setPromptDialogs(on: boolean) {
  promptDialogs.value = on
  localStorage.setItem('deck.promptDialogs', on ? '1' : '0')
}

/** sigs answered from the dialog: hidden until the screen moves on */
export const answered = ref(new Set<string>())
/** sessions set to "answer in the terminal" until their menu is gone */
export const later_ = ref(new Set<string>())
/** the sig the dialog is open for (null: closed, the bar shows instead) */
export const openSig = ref<string | null>(null)

watch(
  () => deck.sessions.map((x) => [x.key, !!x.prompt] as const),
  (rows) => {
    for (const [k, has] of rows) if (!has && later_.value.has(k)) later_.value.delete(k)
  },
)

/** the open session's menu, unless it was answered here or set aside */
export const waiting = computed(() => {
  const s = current.value
  if (!promptDialogs.value || s?.where !== 'deck' || !s.prompt || answered.value.has(s.prompt.sig) || later_.value.has(s.key)) return null
  return s.prompt
})
/** the dialog shows only for the sig it was opened for */
export const modalPrompt = computed(() => (waiting.value && waiting.value.sig === openSig.value ? waiting.value : null))

// Auto-open: the menu is new (none before, or a different question title; typing into a "Type
// something" row only changes an option) and the same session was on screen before and after.
// The page loading counts as a switch (current goes from none to the session).
watch(
  () => [current.value?.key ?? null, current.value?.prompt ?? null] as const,
  ([key, pr], [prevKey, prevPr]) => {
    if (key !== prevKey) {
      openSig.value = null // switching never opens it, and closes one left open elsewhere
      return
    }
    if (!pr || pr.sig === prevPr?.sig) return
    // the menu just answered, redrawn with the typed answer in it before it goes: still answered
    if (prevPr && answered.value.has(prevPr.sig) && prevPr.title === pr.title) {
      answered.value.add(pr.sig)
      return
    }
    if (openSig.value && prevPr && openSig.value === prevPr.sig) openSig.value = pr.sig // already open: follow it
    else if (!prevPr || prevPr.title !== pr.title) openSig.value = pr.sig
  },
)

export const openModal = () => (openSig.value = waiting.value?.sig ?? null)
/** close the dialog back to the bar */
export const closeModal = () => (openSig.value = null)
/** answer in the terminal: no dialog and no bar for this session until its menu is gone */
export function inTerminal() {
  const s = current.value
  if (s) later_.value.add(s.key)
  openSig.value = null
}
