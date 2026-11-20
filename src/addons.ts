// Add-ons that live only on the owner's Mac [T1120-3]: src/private/ (and src/web/private/ for the page) is left out of
// the public release (scripts/release.sh). The server loads src/private/addon.ts when it is there; without it these
// stand-ins answer: no help cards, no Settings page, nothing polled.

type Addon = {
  on(): boolean
  view(): unknown
  setConfig(body: unknown): unknown
  pollSoon(): Promise<void>
  refreshApps(force?: boolean): Promise<unknown>
  rows(): unknown[]
  one(id: string): unknown
  act(id: string, what: unknown, text?: unknown): Promise<string>
  openCount(): number
  picture(key: string): Promise<Response | null>
}
const none: Addon = {
  on: () => false,
  view: () => ({ available: false }),
  setConfig: () => {
    throw new Error('not in this build')
  },
  pollSoon: async () => {},
  refreshApps: async () => null,
  rows: () => [],
  one: () => {
    throw new Error('not in this build')
  },
  act: async () => {
    throw new Error('not in this build')
  },
  openCount: () => 0,
  picture: async () => null,
}
export let addon: Addon = none
/** the private desk module is loaded: the page shows its Settings section and toggles */
export let addonLoaded = false

export async function loadAddons() {
  const path = './private/addon' // a variable, so the public build has nothing to resolve
  try {
    const m = await import(path)
    addon = m.addon as Addon
    addonLoaded = true
    m.startAddon()
  } catch (e: any) {
    if (!/Cannot find module|not found/i.test(String(e?.message))) console.log(`[addons] addon: ${e?.message ?? e}`)
  }
}
