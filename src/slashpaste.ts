// A slash command with a long argument, pasted whole, never runs [T1112-132]: Claude Code shows a long
// paste as "[Pasted text #1]", and on Enter that goes to the model as a message. Typing the command
// name first and pasting only the argument runs it ("/compact [Pasted text #1]" compacts with the note).

/** ["/compact ", "keep: ..."] when the text starts with a slash command and an argument, else null. */
export function splitSlash(text: string): [string, string] | null {
  const m = /^\/[a-z][\w:.-]*[ \t]+(?=\S)/i.exec(text)
  return m ? [m[0], text.slice(m[0].length)] : null
}

const START = '\x1b[200~'
const END = '\x1b[201~'

/** The page's side: a bracketed paste of a slash command becomes [typed name, bracketed rest]. */
export function splitBracketed(data: string): [string, string] | null {
  if (!data.startsWith(START) || !data.endsWith(END)) return null
  const s = splitSlash(data.slice(START.length, -END.length))
  return s ? [s[0], START + s[1] + END] : null
}
