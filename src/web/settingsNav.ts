// Settings' second sidebar [T1112-19]: its sections, grouped, in nav order. Each section is its own page and the nav
// switches between them [T1112-100]. #/settings/<id> opens one, plain #/settings the first (other places link to it, and an
// error that names "Settings > Accounts" gets a button to that section).

export type SettingsItem = { id: string; label: string; /** other names the section goes by in messages */ aka?: string[] }
export type SettingsGroup = { label: string; items: SettingsItem[] }

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { label: 'General', items: [{ id: 'folder', label: 'Projects folder', aka: ['Setup'] }] },
  {
    label: 'Accounts',
    items: [
      { id: 'accounts', label: 'Accounts', aka: ['Hide', 'Remote Control', 'Pause'] },
      { id: 'routing', label: 'Account rules', aka: ['Which account new sessions use', 'Default account', 'Chrome'] },
      { id: 'running', label: 'Running sessions' },
    ],
  },
  {
    label: 'Sessions',
    items: [
      { id: 'permissions', label: 'Auto mode', aka: ['Permission mode'] },
      { id: 'questions', label: 'Questions' },
      { id: 'sidebar', label: 'Sidebar', aka: ['Newest at the top', 'Usage bars'] },
      { id: 'tasks', label: 'Tasks', aka: ['Tasks view'] },
      { id: 'links', label: 'Terminal links', aka: ['Links', 'links.json'] },
    ],
  },
  {
    label: 'Agents & skills',
    items: [
      { id: 'skills', label: 'Skills' },
      { id: 'limits', label: 'Spawn limits' },
    ],
  },
  {
    label: 'Projects',
    items: [
      { id: 'names', label: 'Project names' },
      { id: 'order', label: 'Project order' },
    ],
  },
  { label: 'Privacy', items: [{ id: 'usage', label: 'Usage ping' }] },
]

export const SETTINGS_ITEMS: SettingsItem[] = SETTINGS_GROUPS.flatMap((g) => g.items)
export const isSettingsSection = (id: string | undefined | null): id is string => !!id && SETTINGS_ITEMS.some((i) => i.id === id)
/** The page Settings shows for a link's section: that one, else the first [T1112-100]. */
export const pageFor = (id: string | undefined | null): string => (isSettingsSection(id) ? id : SETTINGS_ITEMS[0]!.id)

/** The section a message points at with "Settings > Accounts" (or "Settings, under Skills"), if any. */
export function settingsLinkIn(text: string): SettingsItem | null {
  const m = /Settings\s*(?:>|›|→|, under)\s*([A-Za-z][A-Za-z ]*[A-Za-z])/.exec(text)
  if (!m) return null
  const said = m[1]!.toLowerCase()
  const names = (i: SettingsItem) => [i.label, ...(i.aka ?? [])].map((n) => n.toLowerCase())
  // the longest name the message starts with: "Spawn limits" over "Spawn", "Tasks view" over "Tasks"
  let best: { item: SettingsItem; len: number } | null = null
  for (const item of SETTINGS_ITEMS)
    for (const n of names(item))
      if ((said === n || said.startsWith(n + ' ')) && (!best || n.length > best.len)) best = { item, len: n.length }
  return best?.item ?? null
}
