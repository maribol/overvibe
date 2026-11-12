import { expect, test } from 'bun:test'
import { bestHit, rankSessions, tierOf, words } from './web/paletteRank'

const s = (title: string, o: { cwd?: string; project?: string; live?: boolean; at?: number } = {}) => ({ title, cwd: o.cwd ?? '~/Work/x', project: o.project ?? 'x', live: o.live, at: o.at })

test('words split on any punctuation', () => {
  expect(words('videogen: Swipe-offer/2')).toEqual(['videogen', 'swipe', 'offer', '2'])
})

test('word-aware: "videogen swipe" finds every spelling of the name', () => {
  expect(tierOf('videogen swipe', s('videogen-swipe'))).toBe(0)
  expect(tierOf('videogen swipe', s('videogen: swipe'))).toBe(0)
  expect(tierOf('videogen swipe', s('swipe videogen'))).toBe(1)
  expect(tierOf('videogen swipe', s('videogen swipe offer'))).toBe(1)
  expect(tierOf('vid swi', s('videogen-swipe'))).toBe(2)
})

test('folder and project words count, below the name', () => {
  expect(tierOf('videogen swipe', s('swipe the product vsl', { cwd: '~/Work/side-quests/videogen' }))).toBe(3)
  expect(tierOf('videogen swipe', s('social media video clipping', { cwd: '~/Work/side-quests/videogen', project: 'videogen' }))).toBeNull()
  expect(tierOf('acme', s('demo', { cwd: '~/Work/offers/acme-video', project: 'acme-video-app' }))).toBe(3)
})

test('fuzzy: the letters in order and close together', () => {
  expect(tierOf('vdgswp', s('videogen-swipe'))).toBe(4)
  expect(tierOf('vgs', s('a very long session name'))).toBeNull()
  expect(tierOf('zzz', s('videogen-swipe'))).toBeNull()
})

test('ranking: exact, every word, prefix, folder, fuzzy; then running, then newest', () => {
  const list = [
    s('acme-video app', { cwd: '~/Work/offers/acme-video', at: 9 }),
    s('swipe for videogen notes', { at: 1 }),
    s('videogen-swipe', { at: 2 }),
    s('videogenerator swiper', { at: 3 }),
    s('swipe the vsl', { cwd: '~/Work/side-quests/videogen', at: 4 }),
    s('videogen: swipe', { at: 5, live: true }),
  ]
  expect(rankSessions('videogen swipe', list).map((x) => [x.item.title, x.tier])).toEqual([
    ['videogen: swipe', 0],
    ['videogen-swipe', 0],
    ['swipe for videogen notes', 1],
    ['videogenerator swiper', 2],
    ['swipe the vsl', 3],
  ])
})

test('the best hit has the most highlighted text, then is newest', () => {
  const h = (at: number, hl: [number, number][]) => ({ at, hl })
  expect(bestHit([h(3, [[0, 2]]), h(1, [[0, 2], [5, 10]]), h(2, [[0, 6]])])?.at).toBe(1)
  expect(bestHit([h(1, [[0, 2]]), h(2, [[4, 6]])])?.at).toBe(2)
  expect(bestHit([])).toBeUndefined()
})
