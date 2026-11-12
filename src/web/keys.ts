// Key labels for the browser this runs in [T1111-8]: a Mac shows ⌥ and ⌘, Linux and Windows show Alt and
// Ctrl. The keys themselves are the same everywhere (e.code, Option is Alt); only the labels change.
export const IS_MAC_UI = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
/** the Option/Alt prefix: "⌥N" on a Mac, "Alt+N" elsewhere */
export const alt = (k: string) => (IS_MAC_UI ? `⌥${k}` : `Alt+${k}`)
