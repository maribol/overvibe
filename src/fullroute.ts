// Routing around a used-up account [T1116-15]: a session started without naming an account should not land on
// one at its usage limit (it stops on the limit message at once). Pure, so it is tested on its own.

export type Usage = { name: string; windows?: Record<string, { used: number; resetsAt: number | null }> }
export const FULL_AT = 95

/** The highest use of any window that has not reset yet; null when unknown. */
export function useOf(a: Usage, now = Date.now()): number | null {
  const w = Object.values(a.windows ?? {}).filter((x) => x.resetsAt === null || x.resetsAt > now)
  return w.length ? Math.max(...w.map((x) => x.used)) : null
}

/**
 * The account to use instead of `picked` when it is at its limit: the non-paused account with the most room
 * (known usage first). Null: keep `picked` (it has room, its usage is unknown, or every account is full).
 */
export function roomierThan(picked: string, accounts: Usage[], paused: string[], now = Date.now()): { account: string; note: string } | null {
  const mine = accounts.find((a) => a.name === picked)
  const used = mine ? useOf(mine, now) : null
  if (used === null || used < FULL_AT) return null
  const other = accounts
    .filter((a) => a.name !== picked && !paused.includes(a.name))
    .map((a) => ({ a, u: useOf(a, now) }))
    .filter((x) => x.u === null || x.u < FULL_AT)
    .sort((x, y) => (x.u ?? 101) - (y.u ?? 101))[0]
  if (!other) return null
  return { account: other.a.name, note: `${picked} is at ${Math.round(used)}% of its usage limit, so it runs on ${other.a.name}${other.u === null ? '' : ` (${Math.round(other.u)}% used)`}` }
}
