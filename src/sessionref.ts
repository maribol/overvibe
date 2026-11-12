// A sidebar row dropped on another agent's terminal pastes a one-line reference to it [T1111-17].
// Pure, so the page and the tests share it: the receiving agent reads the name and reaches the
// session with `overvibe peek` / `overvibe send` (the bundled skill says how).

/** the drag's data type; its value is the dragged session's tmux key */
export const SESSION_MIME = 'application/x-overvibe-session'

const TOOL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'agy' }

/** `/Users/me/Work/api` -> `~/Work/api` (a path already starting with ~ stays as it is) */
export function tildePath(cwd: string, home: string): string {
  const h = home.replace(/\/+$/, '')
  if (!h || h === '/') return cwd
  if (cwd === h) return '~'
  return cwd.startsWith(h + '/') ? '~' + cwd.slice(h.length) : cwd
}

/** one line, any script: `the Overvibe session "api: login fix" (Codex, ~/Work/api) ` (trailing space so the
 *  owner can keep typing). Control characters and line breaks in a title become spaces, so a paste never
 *  carries an Enter. */
export function sessionRef(s: { title: string; tool?: string | null; cwd: string }, home: string): string {
  const flat = (t: string) => t.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  const name = flat(s.title).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const tool = TOOL[s.tool ?? 'claude'] ?? flat(s.tool ?? '')
  return `the Overvibe session "${name}" (${tool}, ${flat(tildePath(s.cwd, home))}) `
}
