// A session that waits on a deploy OK gets its own flag in the sidebar [T1112-134]: its open question
// (the last reply's closing question, AskUserQuestion, a choice menu) asks to deploy, publish, ship or
// release, or to put something live or on production.
const DEPLOY = /\b(deploy\w*|publish\w*|go(?:es|ing)? live|(?:to|on|in)(?: the)? (?:prod|production|live site)|ship (?:it|this|that)|merge (?:it|this|that)|push (?:it|this|that) (?:live|to (?:prod|main|production))|release (?:it|this|v?\d)|roll(?:ing)? (?:it )?out)\b/i

/** true when the question asks to deploy */
export function asksDeploy(question: string | null | undefined): boolean {
  return !!question && DEPLOY.test(question)
}
