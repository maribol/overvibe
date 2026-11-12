// Send feedback [T1112-120]: the dialog's entry goes into the "Overvibe feedback" collection on overvibe.dev
// (src/feedbackform.ts has the fields), posted like the usage ping. "Include version and OS" adds Overvibe's
// version, the OS and its version (src/platform.ts osInfo) and which CLIs are installed with their versions.
import { APP_VERSION } from './news'
import { toolStatus } from './accounts'
import { osInfo } from './platform'
import { parseVersion } from './updates'
import { postToCollection } from './usageping'
import { buildEntry, FEEDBACK_COLLECTION, type FeedbackEnv } from './feedbackform'

/** OVERVIBE_FEEDBACK_URL sends entries somewhere else (a local mock in tests) */
const URL_ = process.env.OVERVIBE_FEEDBACK_URL || `https://overvibe.dev/api/collection/${FEEDBACK_COLLECTION}/store`

export async function feedbackEnv(): Promise<FeedbackEnv> {
  const tools = (await toolStatus()).filter((t) => t.installed).map((t) => [t.tool, parseVersion(t.version)].filter(Boolean).join(' '))
  const { os } = await osInfo()
  return { version: APP_VERSION, os, tools: tools.join(', ') }
}

export async function sendFeedback(input: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  const e = buildEntry(input, await feedbackEnv())
  if (!e.ok) return e
  try {
    // a field left empty stays out (the email is a text field, checked here: an email-type field refused a blank one)
    const r = await postToCollection(URL_, Object.fromEntries(Object.entries(e.fields).filter(([, v]) => v !== '')))
    const j: any = await r.json().catch(() => ({}))
    if (!r.ok || j?.success === false) return { ok: false, error: [].concat(j?.errors ?? j?.message ?? `overvibe.dev answered ${r.status}; try again in a minute`).join('; ') }
    return { ok: true }
  } catch (err) {
    console.log('feedback: send failed:', String((err as Error)?.message ?? err))
    return { ok: false, error: 'could not reach overvibe.dev (no connection?)' }
  }
}
