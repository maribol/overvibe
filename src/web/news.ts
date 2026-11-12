// What's new: the items the server read from announcements.json (see src/news.ts), which ones this
// Mac has seen, and the one-time dialog for an item marked modal. The page never fetches the feed
// itself; everything comes from this server's /api/news.
import { computed, reactive } from 'vue'
import { api } from './deck'

export type NewsItem = { id: string; date: string; title: string; body: string; tag: 'release' | 'news' | 'tip'; url?: string; modal?: boolean; draft?: boolean }

export const news = reactive({
  items: [] as NewsItem[],
  seen: [] as string[],
  modalShown: [] as string[],
  loaded: false,
  panelOpen: false,
  /** the unseen modal item on screen now */
  modal: null as NewsItem | null,
  /** ids that were unread when the panel opened, so their "New" chip stays while it is open */
  openedUnread: [] as string[],
  /** the first-run safety note (SafetyNote.vue) goes first; no news dialog until it is settled */
  safetyPending: true,
})

export const unreadNews = computed(() => news.items.filter((i) => !news.seen.includes(i.id)))

/** Drafts are hidden; set localStorage deck.newsDrafts = "1" to preview them before publishing. */
const drafts = () => localStorage.getItem('deck.newsDrafts') === '1'

export async function loadNews() {
  try {
    const r = await api<{ items: NewsItem[]; seen: string[]; modalShown: string[] }>(`/api/news${drafts() ? '?drafts=1' : ''}`)
    news.items = r.items
    news.seen = r.seen
    news.modalShown = r.modalShown
    news.loaded = true
  } catch {
    /* quiet: no news is fine */
  }
}

async function markSeen(ids: string[], modal = false) {
  if (!ids.length) return
  try {
    const r = await api<{ seen: string[]; modalShown: string[] }>('/api/news/seen', { ids, modal })
    news.seen = r.seen
    news.modalShown = r.modalShown
  } catch {}
}

export function openNews() {
  news.modal = null
  news.openedUnread = unreadNews.value.map((i) => i.id)
  news.panelOpen = true
  markSeen(news.openedUnread)
}

/**
 * Show the newest unseen modal item once. Its id is recorded as shown before it renders, so however
 * the dialog is closed (or the page reloaded) it never opens again.
 */
export function maybeShowModal(busy: boolean) {
  if (busy || news.panelOpen || news.modal || news.safetyPending) return
  const next = news.items.find((i) => i.modal && !news.modalShown.includes(i.id) && !news.seen.includes(i.id))
  if (!next) return
  news.modal = next
  news.modalShown = [...news.modalShown, next.id]
  markSeen([next.id], true)
}

// ---------- body: plain text, never HTML ----------

export type BodyBlock = { kind: 'list'; items: string[] } | { kind: 'p'; text: string }
const BULLET = /^\s*[-*•]\s+/

/** Blank lines split paragraphs; a block whose lines all start with "- " is a list. */
export function parseBody(body: string): BodyBlock[] {
  return body.split(/\n{2,}/).map((b) => {
    const lines = b.split('\n')
    return lines.every((l) => BULLET.test(l)) ? { kind: 'list', items: lines.map((l) => l.replace(BULLET, '')) } : { kind: 'p', text: lines.join('\n') }
  })
}

export function newsDate(d: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`))
  } catch {
    return d
  }
}

export const TAG_LABEL: Record<NewsItem['tag'], string> = { release: 'Release', news: 'News', tip: 'Tip' }
export const tagStyle = (t: NewsItem['tag']) =>
  t === 'release' ? 'background: var(--color-chip-accent-bg); color: var(--color-chip-accent-fg)' : t === 'tip' ? 'background: var(--color-chip-amber-bg); color: var(--color-chip-amber-fg)' : 'background: var(--color-chip-blue-bg); color: var(--color-chip-blue-fg)'
