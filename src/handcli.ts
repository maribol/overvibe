// A shell session that runs claude, codex or agy by hand becomes that agent's row while the CLI runs
// [T1111-19]. This file holds the pure parts: which process in a shell pane is an agent CLI (from `ps`
// output), and which conversation it is (Claude Code's transcript, Codex's rollout). src/sessions.ts
// promotes and demotes the record.
//
// How a CLI is recognised: the shell is the pane's process (pane_pid); the CLI is one of its descendants
// whose argv names it: argv0's basename is claude / codex / agy, Claude Code's native build under
// .../claude/versions/<v>, or a node/bun/deno script from @anthropic-ai/claude-code or @openai/codex.
// One-shot runs and subcommands (claude -p, claude auth, codex exec, codex login, agy -p, --version...)
// are not sessions and are left alone.
//
// Which conversation: Claude Code first by its pid in `claude agents --json` (exact, also follows /clear),
// then by an id on its command line (--resume / --session-id), then the first transcript in its folder
// that started after the process did and no other session has. Codex: `codex resume <id>`, else the first
// rollout in its folder that started after the process (two in one folder are given out in process start
// order), else for `codex resume` with no id the rollout in that folder written to since it started.
import { basename } from 'node:path'
import type { Tool } from './env'

export type Proc = { pid: number; ppid: number; start: number; args: string }

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'elvish', 'xonsh', 'login'])
/** pane_current_command is a shell (the prompt is up, nothing runs in front of it). */
export const isShellCommand = (cmd: string) => SHELLS.has(basename(cmd.trim().replace(/^-/, '')))

const NOT_SESSION: Record<Tool, Set<string>> = {
  claude: new Set(['agents', 'auth', 'mcp', 'config', 'update', 'upgrade', 'doctor', 'install', 'setup-token', 'plugin', 'plugins', 'migrate-installer', 'stop', 'attach', 'logs', '-p', '--print', '-v', '--version', '-h', '--help']),
  codex: new Set(['exec', 'e', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'apply', 'a', 'sandbox', 'debug', 'cloud', 'features', 'proto', 'generate-ts', 'help', '-V', '--version', '-h', '--help']),
  agy: new Set(['-p', '--print', '-v', '--version', '-h', '--help', 'auth', 'login', 'logout', 'update', 'mcp']),
}

/** Split ps's args on spaces (ps prints argv joined by spaces; a path with a space in it is rare enough here). */
const words = (args: string) => args.trim().split(/\s+/)

/** The agent CLI this command line runs as an interactive session, or null. */
export function cliOf(args: string): Tool | null {
  const w = words(args)
  const a0 = w[0] ?? ''
  if (a0.includes('.app/')) return null // the ChatGPT / Codex desktop apps and their helpers
  let tool: Tool | null = null
  let rest = w.slice(1)
  const b = basename(a0)
  if (b === 'claude' || /\/claude\/versions\/[^/]+$/.test(a0)) tool = 'claude'
  else if (b === 'codex') tool = 'codex'
  else if (b === 'agy') tool = 'agy'
  else if (b === 'node' || b === 'bun' || b === 'deno') {
    // a script: the first argument that is not a runtime flag
    const i = rest.findIndex((x) => !x.startsWith('-'))
    const script = i >= 0 ? rest[i]! : ''
    rest = rest.slice(i + 1)
    if (/@anthropic-ai\/claude-code\//.test(script) || basename(script) === 'claude') tool = 'claude'
    else if (/@openai\/codex\//.test(script) || basename(script) === 'codex' || basename(script) === 'codex.js') tool = 'codex'
    else if (basename(script) === 'agy') tool = 'agy'
  }
  if (!tool) return null
  const skip = NOT_SESSION[tool]
  // a subcommand is the first word; -p / --print anywhere makes it a one-shot run
  if (rest[0] && skip.has(rest[0])) return null
  if (tool !== 'codex' && rest.some((x) => x === '-p' || x === '--print')) return null
  return tool
}

/** `ps -axo pid=,ppid=,lstart=,args=`: lstart is five words (Wed Nov 11 10:00:00 2026), local time. */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line)
    if (!m) continue
    const start = new Date(m[3]!.replace(/\s+/g, ' ')).getTime()
    procs.push({ pid: +m[1]!, ppid: +m[2]!, start: Number.isFinite(start) ? start : 0, args: m[4]! })
  }
  return procs
}

/**
 * The agent CLI running under `root` (a shell pane's pid): the shallowest descendant that is one, so
 * `npx claude` is found and Claude's own children (a codex it started, say) are not. Null when none.
 */
export function findCli(procs: Proc[], root: number): (Proc & { tool: Tool }) | null {
  const kids = new Map<number, Proc[]>()
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p])
  let level = kids.get(root) ?? []
  const seen = new Set<number>([root])
  for (let depth = 0; level.length && depth < 8; depth++) {
    const hits = level.map((p) => ({ p, tool: cliOf(p.args) })).filter((x) => x.tool)
    if (hits.length) {
      // two at one level (one in the background): the newest is the one in front
      const h = hits.sort((a, b) => b.p.start - a.p.start || b.p.pid - a.p.pid)[0]!
      return { ...h.p, tool: h.tool! }
    }
    const next: Proc[] = []
    for (const p of level) if (!seen.has(p.pid)) seen.add(p.pid), next.push(...(kids.get(p.pid) ?? []))
    level = next
  }
  return null
}

/** Whether `pid` is `root` or one of its descendants. */
export function under(procs: Proc[], pid: number, root: number): boolean {
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]))
  for (let x: number | undefined = pid, i = 0; x && i < 64; x = parent.get(x), i++) if (x === root) return true
  return false
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A conversation id on the command line: claude --resume/-r/--session-id <id>, codex resume <id>, agy --conversation <id>. */
export function idFromArgs(tool: Tool, args: string): string | null {
  const w = words(args)
  for (let i = 1; i < w.length; i++) {
    const x = w[i]!
    const eq = /^--(?:resume|session-id|conversation)=(.+)$/.exec(x)
    if (eq && UUID.test(eq[1]!)) return eq[1]!
    const takes = tool === 'claude' ? ['--resume', '-r', '--session-id'] : tool === 'codex' ? ['resume'] : ['--conversation']
    if (takes.includes(x) && w[i + 1] && UUID.test(w[i + 1]!)) return w[i + 1]!
  }
  return null
}

export type Conv = { id: string; cwd: string | null; startedAt: number | null; lastAt: number }
/** ps start times are whole seconds and a CLI writes its first line a moment after it starts */
const SLACK = 5_000

/**
 * The conversation a hand-started CLI is in, from its folder and start time: the first one in `cwd` that
 * started at or after the process did (within `within`) and is not `taken` by another session. With
 * `resumed` (codex resume with no id), the one in that folder written to since it started is also taken.
 */
export function pickConversation(convs: Conv[], o: { cwd: string; start: number; taken: Set<string>; resumed?: boolean; within?: number }): string | null {
  const within = o.within ?? 30 * 60_000
  const free = convs.filter((c) => c.cwd === o.cwd && !o.taken.has(c.id))
  const fresh = free.filter((c) => c.startedAt != null && c.startedAt >= o.start - SLACK && c.startedAt < o.start + within).sort((a, b) => a.startedAt! - b.startedAt!)
  if (fresh[0]) return fresh[0].id
  if (o.resumed) return free.filter((c) => c.lastAt >= o.start - SLACK).sort((a, b) => b.lastAt - a.lastAt)[0]?.id ?? null
  return null
}
