// Switching Claude Code's own view to a subagent [T1118-3]. Claude Code lists `main` and its subagents under the
// footer; from an empty prompt, ↓ walks the footer's pills (shells, monitors) and then that list, where a ❯ marks the
// chosen row and Enter shows it (its transcript, with a prompt to message it). No command does this, so Overvibe
// presses the keys: ↓/↑ while reading the screen until ❯ sits on the wanted row, then Enter. ← on an empty prompt
// asks to background the session, so it is never sent. Pure parts here, tested in subnav.test.ts.

/** selected: ❯ is on it (↑/↓ moved there); shown: its dot is filled (● ⏺), the view Claude Code shows now */
export type ListRow = { label: string; selected: boolean; main: boolean; shown: boolean }

const ROW = /^(❯\s)?\s*([◯⏺●○◉])\s+(\S.*?)\s*$/
/** The agent list under the footer: `main` and one row per subagent, in screen order; [] when not on screen. */
export function listRows(screen: string): ListRow[] {
  const lines = screen.split('\n')
  const start = lines.findIndex((l) => ROW.exec(l)?.[3]!.replace(/\s{3,}.*$/, '') === 'main')
  if (start < 0) return []
  const rows: ListRow[] = []
  for (const l of lines.slice(start)) {
    const m = ROW.exec(l)
    if (!m) break
    const label = m[3]!.replace(/\s{3,}.*$/, '').replace(/\s{2,}/g, '  ')
    rows.push({ label, selected: !!m[1], main: /^main$/.test(label), shown: /[⏺●◉]/.test(m[2]!) })
  }
  return rows
}

/** Which row to land on: `main`, or the subagent whose row names its description, else the n-th subagent row. */
export function targetRow(rows: ListRow[], want: { main: true } | { desc: string; index: number }): number {
  if ('main' in want) return rows.findIndex((r) => r.main)
  const subs = rows.map((r, i) => ({ r, i })).filter((x) => !x.r.main)
  const d = want.desc.trim().toLowerCase()
  const byDesc = d ? subs.find((x) => x.r.label.toLowerCase().includes(d)) : undefined
  return byDesc?.i ?? subs[want.index]?.i ?? -1
}

/** The next key: Enter on the target, ↓ when nothing in the list is chosen yet or the target is below, else ↑. */
export function nextKey(rows: ListRow[], target: number): 'Enter' | 'Down' | 'Up' {
  const at = rows.findIndex((r) => r.selected)
  if (at === target) return 'Enter'
  return at < 0 || at < target ? 'Down' : 'Up'
}

/** Claude Code already shows that row, and ↑/↓ have not moved off it: nothing to press. */
export const alreadyShown = (rows: ListRow[], target: number) => rows[target]?.shown === true && !rows.some((r, i) => r.selected && i !== target)
