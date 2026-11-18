// Memory guard [T1117-3]: a command an agent runs in a session (a test suite, a build) can grow until the Mac
// runs out of memory and panics; 2026-11-17 two test-suite runs at 37 GB each did, on a 36 GB Mac.
// Every few seconds the server looks at each session's process tree and kills a process over the limit, then
// tells that session why. The agent CLIs themselves (Claude Code, Codex, agy) and the pane's shell are never
// killed: that would end the conversation's process, and they are not where the runaway memory has been.
// Pure parts here (tested in memguard.test.ts); sessions.ts memGuard() reads ps and acts.

export type MemProc = { pid: number; ppid: number; rssMb: number; args: string }
export type Kill = { pid: number; tmux: string; rssMb: number; args: string; why: 'process' | 'total' }

const GB = 1024
/** One process may use a quarter of the RAM, between 4 and 16 GB. */
export const procLimitMb = (totalBytes: number) => Math.round(Math.min(16 * GB, Math.max(4 * GB, totalBytes / 4 / 2 ** 20)))
/** All sessions' processes together: 75% of the RAM. */
export const totalLimitMb = (totalBytes: number) => Math.round((totalBytes * 0.75) / 2 ** 20)

/** An agent CLI's process: never killed. */
export const isAgentCli = (args: string) =>
  /(^|\/)(claude|codex|agy|gemini)(\s|$)/.test(args) || /\/(\.local\/share\/claude\/versions|@openai\/codex|codex\/bin)\//.test(args)

/** `ps -axo pid=,ppid=,rss=,args=` (rss in KB) */
export function parseMemPs(out: string): MemProc[] {
  const procs: MemProc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) procs.push({ pid: +m[1]!, ppid: +m[2]!, rssMb: Math.round(+m[3]! / 1024), args: m[4]! })
  }
  return procs
}

/** Each process under a session's pane, with the session it belongs to (roots: pane pid -> tmux name). */
export function sessionProcs(procs: MemProc[], roots: Map<number, string>): (MemProc & { tmux: string; root: boolean })[] {
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]))
  const owner = (pid: number): string | undefined => {
    for (let at = pid, hops = 0; at > 1 && hops < 64; at = parent.get(at) ?? 0, hops++) {
      const t = roots.get(at)
      if (t) return t
    }
  }
  const out: (MemProc & { tmux: string; root: boolean })[] = []
  for (const p of procs) {
    const tmux = owner(p.pid)
    if (tmux) out.push({ ...p, tmux, root: roots.has(p.pid) })
  }
  return out
}

/** What to kill: every killable process over the per-process limit, then, while all of them together are over
 * the total limit, the largest killable one left. */
export function toKill(list: (MemProc & { tmux: string; root: boolean })[], o: { procMb: number; totalMb: number }): Kill[] {
  const killable = list.filter((p) => !p.root && !isAgentCli(p.args))
  const kills: Kill[] = killable.filter((p) => p.rssMb > o.procMb).map((p) => ({ pid: p.pid, tmux: p.tmux, rssMb: p.rssMb, args: p.args, why: 'process' }))
  const gone = new Set(kills.map((k) => k.pid))
  let total = list.reduce((s, p) => s + p.rssMb, 0) - kills.reduce((s, k) => s + k.rssMb, 0)
  for (const p of killable.filter((x) => !gone.has(x.pid)).sort((a, b) => b.rssMb - a.rssMb)) {
    if (total <= o.totalMb) break
    kills.push({ pid: p.pid, tmux: p.tmux, rssMb: p.rssMb, args: p.args, why: 'total' })
    total -= p.rssMb
  }
  return kills
}

const gb = (mb: number) => `${(mb / GB).toFixed(1)} GB`
/** The note the session gets, so the agent knows its command did not just crash. */
export function killNote(k: Kill, o: { procMb: number; totalMb: number }): string {
  const cmd = k.args.length > 160 ? `${k.args.slice(0, 160)}…` : k.args
  const why = k.why === 'process' ? `it passed the per-process memory limit (${gb(o.procMb)} on this Mac)` : `all sessions' processes together passed ${gb(o.totalMb)}, and it was the largest`
  return `Overvibe killed a process in this session to keep the Mac from running out of memory: \`${cmd}\` (pid ${k.pid}) was using ${gb(k.rssMb)}; ${why}. Running it the same way will be killed again. Find what grows (run one test file at a time and watch its memory), and never run two large suites at once.`
}
