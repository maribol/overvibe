// Page add-ons that live only on the owner's Mac [T1120-3]: src/web/private/ is left out of the public release. Its
// index.ts, when there, adds Settings sections here; the public page has none.
import type { Component } from 'vue'
import { SETTINGS_GROUPS, SETTINGS_ITEMS, type SettingsItem } from './settingsNav'

export const addonPanels: Record<string, Component> = {}
/** a Settings section of an add-on, under Integrations */
export function addSettingsPanel(item: SettingsItem, panel: Component) {
  const g = SETTINGS_GROUPS.find((x) => x.label === 'Integrations') ?? SETTINGS_GROUPS.at(-1)!
  if (!g.items.some((i) => i.id === item.id)) g.items.push(item)
  if (!SETTINGS_ITEMS.some((i) => i.id === item.id)) SETTINGS_ITEMS.push(item)
  addonPanels[item.id] = panel
}
// the private index, if this checkout has one (an empty glob in the public build): its panels, registered here
const privateMods = import.meta.glob<{ panels?: { item: SettingsItem; panel: Component }[] }>('./private/index.ts', { eager: true })
for (const m of Object.values(privateMods)) for (const p of m.panels ?? []) addSettingsPanel(p.item, p.panel)
