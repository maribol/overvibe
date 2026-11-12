// Paused accounts [T1112-11]: the owner pauses a Claude or Codex account in Settings > Accounts so nothing new runs
// on it: no new session, no resume, no account switch. Sessions already running on it keep running; pausing stops
// and moves nothing by itself. Keys are like hiddenAccounts: "name" for Claude, "codex:name" for Codex.
// No imports, so the rules are tested without the settings file.

export type PauseTool = 'claude' | 'codex'
export const pauseKey = (name: string, tool: PauseTool = 'claude') => (tool === 'claude' ? name : `${tool}:${name}`)
const label = (tool: PauseTool) => (tool === 'codex' ? 'Codex account' : 'account')

export const pausedMessage = (name: string, tool: PauseTool = 'claude') =>
  `${label(tool)} ${name} is paused (Settings > Accounts); unpause it or pick another`

export type Settle = {
  tool: PauseTool
  /** the account the rules, the router, Chrome or the request picked */
  account: string
  /** how it was picked: "asked" (explicit, never replaced), or anything else */
  by: string
  /** every account of the tool (names), in list order */
  accounts: string[]
  paused: string[]
  /** the tool's default account (already resolved to a real name) */
  defaultAccount: string
  /** what the note says the account was, e.g. "the account this session ran on" */
  why?: string
}

/**
 * The account to use once paused ones are left out, with a note when it changed. An explicit paused account is
 * refused; any other paused pick falls back to the default account, else the first unpaused one; none left: refused.
 */
export function settle(s: Settle): { account: string; note?: string } {
  const isPaused = (n: string) => s.paused.includes(pauseKey(n, s.tool))
  if (!isPaused(s.account)) return { account: s.account }
  if (s.by === 'asked') throw new Error(pausedMessage(s.account, s.tool))
  const next = [s.defaultAccount, ...s.accounts].find((n) => n !== s.account && s.accounts.includes(n) && !isPaused(n))
  if (!next) throw new Error(`every ${s.tool === 'codex' ? 'Codex' : 'Claude'} account is paused (Settings > Accounts); unpause one to start a session`)
  const what = s.why ?? (s.by === 'chrome' ? 'the account Claude in Chrome is paired with' : s.by === 'router' ? 'the local router\'s pick' : 'the account this folder uses')
  const chrome = s.by === 'chrome' ? `; the browser tools may not connect there` : ''
  return { account: next, note: `${s.account} (${what}) is paused, so it runs on ${next}${chrome}` }
}
