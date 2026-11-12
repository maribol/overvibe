// A helper is never more permissive than the session that started it [T1110-85, T1112-99].
import { isMode, type Mode } from './routing'

/**
 * The permission mode asked for a new or resumed session. `by` is the session the call proved it comes from (server.ts
 * checks OVERVIBE_SESSION against OVERVIBE_PROOF, or finds the session by its proof alone). From a session with auto
 * mode off the helper runs with auto mode off too (and Codex in its stock sandbox), and asking for auto there is
 * refused. Only the owner (the page, a terminal outside any session, so no `by`) picks auto freely.
 * Returns undefined for "the folder's rule".
 */
export function capMode(asked: unknown, by?: { name: string; mode?: string }): Mode | undefined {
  if (asked !== undefined && asked !== null && asked !== '' && !isMode(asked)) throw new Error('--mode: ask or auto')
  if (by && by.mode === 'ask') {
    if (asked === 'auto') throw Object.assign(new Error(`"${by.name}" runs with auto mode off, so the sessions it starts run with auto mode off too; --auto / --mode auto is refused. Ask the owner to start it, or leave the flag out.`), { status: 403 })
    return 'ask'
  }
  return (asked || undefined) as Mode | undefined
}
