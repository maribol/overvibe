// An account switch restarts a session under a new tmux name [T1112-128]. Its tab keeps its place: each old name
// is replaced where it stands, and a name already open elsewhere is not listed twice.
export function swapTabs(tabs: string[], pairs: [from: string, to: string][]): string[] {
  const to = new Map(pairs)
  const out: string[] = []
  for (const t of tabs) {
    const n = to.get(t) ?? t
    if (!out.includes(n)) out.push(n)
  }
  return out
}
