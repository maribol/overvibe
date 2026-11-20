// Add-ons that live only on the owner's Mac [T1120-3]: src/private/ (and src/web/private/ for the page) is left out of
// the public release (scripts/release.sh). The server loads src/private/index.ts when it is there; without it these
// stand-ins answer: no help cards, no Settings page, nothing polled.

type Cards = {
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
const none: Cards = {
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
export let cards: Cards = none
/** the private add-on is loaded */
export let cardsLoaded = false

export async function loadAddons() {
  const path = './private/index' // a variable, so the public build has nothing to resolve
  try {
    const m = await import(path)
    cards = m.cards as Cards
    cardsLoaded = true
    m.startCards()
  } catch (e: any) {
    if (!/Cannot find module|not found/i.test(String(e?.message))) console.log(`[addons] ${e?.message ?? e}`)
  }
}
