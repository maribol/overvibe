import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveLink } from './openfile'

const base = realpathSync(mkdtempSync(join(homedir(), 'scratchpad', '.openfile-')))
mkdirSync(join(base, 'studio'))
writeFileSync(join(base, 'studio', 'test.jpg'), 'x')

test('a partial path is read from the session folder [T1112-2]', () => {
  expect(resolveLink('studio/test.jpg', ['', base])).toBe(join(base, 'studio', 'test.jpg'))
  expect(resolveLink('studio/test.jpg:12:3', [base])).toBe(join(base, 'studio', 'test.jpg'))
  expect(resolveLink('./studio', [base])).toBe(join(base, 'studio'))
})
test('absolute, ~ and file:// paths', () => {
  const f = join(base, 'studio', 'test.jpg')
  expect(resolveLink(f)).toBe(f)
  expect(resolveLink('file://' + f)).toBe(f)
  expect(resolveLink('~/' + f.slice(realpathSync(homedir()).length + 1))).toBe(f)
})
test('missing files and paths outside home are refused', () => {
  expect(() => resolveLink('studio/nope.jpg', [base])).toThrow(/no such file/)
  expect(() => resolveLink('/etc/hosts')).toThrow(/only files under your home/)
})

// bare names and context folders [T1112-8]
import { utimesSync } from 'node:fs'
import { findNear } from './openfile'
const rec = join(base, 'acme-video', 'recording')
const clips = join(base, 'acme-video', 'screens', 'final-clips')
mkdirSync(rec, { recursive: true })
mkdirSync(clips, { recursive: true })
writeFileSync(join(rec, 'walk.mp4'), 'x')
writeFileSync(join(clips, 'walk.mp4'), 'x')
writeFileSync(join(clips, 'clip1.mp4'), 'x')

test('a bare name is found in a folder named above it, nearest first', () => {
  expect(resolveLink('walk.mp4', [base], [rec + '/', clips])).toBe(join(rec, 'walk.mp4'))
  expect(resolveLink('walk.mp4', [base], [clips, rec])).toBe(join(clips, 'walk.mp4'))
  // a context folder without the file is passed over
  expect(resolveLink('clip1.mp4', [base], [rec, clips])).toBe(join(clips, 'clip1.mp4'))
  // ~ and relative context paths, and a file path gives its folder
  const tilde = '~/' + rec.slice(realpathSync(homedir()).length + 1)
  expect(resolveLink('walk.mp4:3', [base], [tilde])).toBe(join(rec, 'walk.mp4'))
  expect(resolveLink('walk.mp4', [base], ['acme-video/screens/final-clips/clip1.mp4'])).toBe(join(clips, 'walk.mp4'))
})
test('a partial path uses the context folders before the session folder', () => {
  mkdirSync(join(base, 'studio2', 'x'), { recursive: true })
  mkdirSync(join(rec, 'studio2', 'x'), { recursive: true })
  writeFileSync(join(base, 'studio2', 'x', 'a.png'), 'x')
  writeFileSync(join(rec, 'studio2', 'x', 'a.png'), 'x')
  expect(resolveLink('studio2/x/a.png', [base], [rec])).toBe(join(rec, 'studio2', 'x', 'a.png'))
  expect(resolveLink('studio2/x/a.png', [base])).toBe(join(base, 'studio2', 'x', 'a.png'))
})
test('without context, a short search under the session folder; the newest file wins', () => {
  const old = new Date(Date.now() - 86400e3)
  utimesSync(join(rec, 'walk.mp4'), old, old)
  expect(resolveLink('walk.mp4', [base])).toBe(join(clips, 'walk.mp4'))
  utimesSync(join(clips, 'walk.mp4'), new Date(old.getTime() - 1000), new Date(old.getTime() - 1000))
  expect(resolveLink('walk.mp4', [base])).toBe(join(rec, 'walk.mp4'))
})
test('the search stays within its depth and skips node_modules and dot folders', () => {
  const deep = join(base, 'a', 'b', 'c', 'd', 'e')
  mkdirSync(deep, { recursive: true })
  writeFileSync(join(deep, 'deep.txt'), 'x')
  expect(findNear('deep.txt', [base], { depth: 4 })).toBeUndefined()
  expect(findNear('deep.txt', [base], { depth: 5 })).toBe(join(deep, 'deep.txt'))
  for (const d of ['node_modules', '.git']) {
    mkdirSync(join(base, d), { recursive: true })
    writeFileSync(join(base, d, 'hidden.txt'), 'x')
  }
  expect(findNear('hidden.txt', [base])).toBeUndefined()
  expect(() => resolveLink('hidden.txt', [base])).toThrow(/no such file/)
  // a spent time budget stops before reading any folder
  expect(findNear('deep.txt', [base], { depth: 5, budgetMs: -1 })).toBeUndefined()
})
test('a context folder outside home does not make a file there open', () => {
  expect(() => resolveLink('hosts', [base], ['/etc'])).toThrow(/only files under your home/)
})

// the smarter lookup [T1112-17]
import { afterAll } from 'bun:test'
import { rmSync } from 'node:fs'
import { basename } from 'node:path'
import { findLink, fromTranscript, searchWide, wideRoots } from './openfile'

const f17 = realpathSync(mkdtempSync(join(homedir(), 'scratchpad', '.findpath-')))
// a session folder that is a git repo, and the scratch folder of the same name
const proj = join(f17, 'work', `proj-${basename(f17).slice(10)}`)
mkdirSync(join(proj, '.git'), { recursive: true })
const scratchOf = join(homedir(), 'scratchpad', basename(proj))
afterAll(() => {
  rmSync(f17, { recursive: true, force: true })
  rmSync(scratchOf, { recursive: true, force: true })
})
// the agent worked elsewhere and wrote "I downloaded the originals to client-emails/cold-imgs/"
const elsewhere = join(f17, 'elsewhere', 'offer')
mkdirSync(join(elsewhere, 'client-emails', 'cold-imgs'), { recursive: true })
writeFileSync(join(elsewhere, 'client-emails', 'cold-imgs', 'a.png'), 'x')
const transcript = join(f17, 'session.jsonl')
const line = (o: unknown) => JSON.stringify(o) + '\n'
writeFileSync(
  transcript,
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `cd ${elsewhere} && mkdir -p client-emails/cold-imgs` } }] } }) +
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: `saved ${elsewhere}/client-emails/cold-imgs/a.png\n` }] } }) +
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${elsewhere}/notes/readme.md` } }] } }),
)
mkdirSync(join(elsewhere, 'notes', 'drafts'), { recursive: true })
writeFileSync(join(elsewhere, 'notes', 'drafts', 'plan.md'), 'x')

test('a path the session used that ends with the link wins, before any search', async () => {
  expect(fromTranscript('client-emails/cold-imgs/', transcript)).toBe(join(elsewhere, 'client-emails', 'cold-imgs'))
  const r = await findLink('client-emails/cold-imgs/', { bases: [proj], transcript, roots: [[f17]] })
  expect(r).toEqual({ path: join(elsewhere, 'client-emails', 'cold-imgs'), step: 'transcript' })
  // ~ paths in the transcript count too
  const t2 = join(f17, 'tilde.jsonl')
  writeFileSync(t2, line({ input: { command: `ls ~/${join(elsewhere, 'client-emails').slice(realpathSync(homedir()).length + 1)}` } }))
  expect(fromTranscript('client-emails/cold-imgs', t2)).toBe(join(elsewhere, 'client-emails', 'cold-imgs'))
})
test('the folders of paths the session used are bases too', () => {
  // drafts/plan.md is not in the transcript, but notes/readme.md was read: its folder has drafts/plan.md
  expect(fromTranscript('drafts/plan.md', transcript)).toBe(join(elsewhere, 'notes', 'drafts', 'plan.md'))
  expect(fromTranscript('drafts/none.md', transcript)).toBeUndefined()
})
test('the scratch folder named after the session folder, even a level down', async () => {
  mkdirSync(join(scratchOf, 'task', 'out'), { recursive: true })
  writeFileSync(join(scratchOf, 'task', 'out', 'shot.png'), 'x')
  mkdirSync(join(scratchOf, 'top'), { recursive: true })
  expect(await findLink('top', { bases: [proj], roots: false })).toEqual({ path: join(scratchOf, 'top'), step: 'convention' })
  expect(await findLink('out/shot.png', { bases: [join(proj, 'sub')], roots: false })).toEqual({ path: join(scratchOf, 'task', 'out', 'shot.png'), step: 'convention' })
})
test('the wide search: one match opens, several come back newest first, none says where it looked', async () => {
  const a = join(f17, 'wide', 'a', 'deep', 'er', 'reports', 'q3')
  const b = join(f17, 'wide', 'b', 'reports', 'q3')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  const old = new Date(Date.now() - 3600e3)
  utimesSync(b, old, old)
  const roots = [[], [join(f17, 'wide')]]
  const r = await findLink('reports/q3', { bases: [proj], roots })
  expect('choices' in r && r.choices.map((c) => c.path)).toEqual([a, b])
  mkdirSync(join(f17, 'wide', 'b', 'only', 'one.txt'), { recursive: true })
  expect(await findLink('only/one.txt', { bases: [proj], roots })).toEqual({ path: join(f17, 'wide', 'b', 'only', 'one.txt'), step: 'search' })
  await expect(findLink('nowhere/x.txt', { bases: [proj], transcript, roots })).rejects.toThrow(/^Not found: nowhere\/x\.txt\. Looked in its transcript, .*wide/)
  // without roots it stays the old error
  await expect(findLink('nowhere/x.txt', { bases: [proj], roots: false })).rejects.toThrow(/no such file/)
})
test('the wide search keeps to its depth, its time and its match count, and skips dot folders and node_modules', async () => {
  const root = join(f17, 'bound')
  mkdirSync(join(root, '1', '2', '3', 'target'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'target'), { recursive: true })
  mkdirSync(join(root, '.cache', 'target'), { recursive: true })
  expect((await searchWide('target', [[root]], { depth: 2 })).hits).toEqual([])
  expect((await searchWide('target', [[root]], { depth: 3 })).hits.map((h) => h.path)).toEqual([join(root, '1', '2', '3', 'target')])
  const spent = await searchWide('target', [[root]], { budgetMs: -1 })
  expect(spent).toEqual({ hits: [], done: false })
  for (const n of ['x', 'y', 'z']) mkdirSync(join(root, n, 'many'), { recursive: true })
  expect((await searchWide('many', [[root]], { max: 2 })).hits.length).toBe(2)
})
test('a find is kept for the session: the next click does not look again', async () => {
  const cache = new Map<string, string>()
  const want = join(elsewhere, 'client-emails', 'cold-imgs')
  expect((await findLink('client-emails/cold-imgs/', { bases: [proj], transcript, cache, roots: false })).step).toBe('transcript')
  expect(cache.get('client-emails/cold-imgs')).toBe(want)
  expect(await findLink('./client-emails/cold-imgs', { bases: [proj], cache, roots: false })).toEqual({ path: want, step: 'cache' })
})
test('the screen and session folders still come first, and the home rule holds', async () => {
  expect(await findLink('studio/test.jpg', { bases: [base], transcript, roots: [[f17]] })).toEqual({ path: join(base, 'studio', 'test.jpg'), step: 'direct' })
  await expect(findLink('/etc/hosts', { roots: [[f17]] })).rejects.toThrow(/only files under your home/)
  // a transcript path outside home is not taken
  const t3 = join(f17, 'etc.jsonl')
  writeFileSync(t3, line({ input: { command: 'cat /etc/hosts' } }))
  expect(fromTranscript('etc/hosts', t3)).toBeUndefined()
})
test('a match in the first tier ends the search; build output is skipped only in the wide tier', async () => {
  const near = join(f17, 'tiers', 'near', 'build', 'pick-me')
  const far = join(f17, 'tiers', 'far', 'build', 'pick-me')
  mkdirSync(near, { recursive: true })
  mkdirSync(far, { recursive: true })
  expect((await searchWide('pick-me', [[join(f17, 'tiers', 'near')], [join(f17, 'tiers', 'far')]])).hits.map((h) => h.path)).toEqual([near])
  expect((await searchWide('pick-me', [[], [join(f17, 'tiers', 'far')]])).hits).toEqual([])
})
test('the wide roots: the project, scratch, work root, Downloads, Desktop', () => {
  const h = realpathSync(homedir())
  mkdirSync(scratchOf, { recursive: true })
  expect(wideRoots([join(proj, 'sub'), ''], join(h, 'Work'))).toEqual([[proj, scratchOf], [join(h, 'scratchpad'), join(h, 'Work'), join(h, 'Downloads'), join(h, 'Desktop')]])
})
