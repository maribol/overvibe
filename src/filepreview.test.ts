// hover preview of a file link [T1112-114]
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LIMITS, imageSize, looksText, previewFile } from './filepreview'
import { findLink } from './openfile'

const base = realpathSync(mkdtempSync(join(homedir(), 'scratchpad', '.filepreview-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))

// a 3x2 png
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGP8z8Dwn4EBCQAAJ/IC/2hUHGMAAAAASUVORK5CYII=', 'base64')

test('an image gives its pixel size and the file as the thumbnail when small', async () => {
  const f = join(base, 'shot.png')
  writeFileSync(f, PNG)
  const p = await previewFile(f, { sips: false })
  expect(p.kind).toBe('image')
  expect([p.width, p.height]).toEqual([3, 2])
  expect(p.size).toBe(PNG.length)
  expect(p.thumb).toStartWith('data:image/png;base64,')
})

test('an image over the raw cap gets no thumbnail without sips, but keeps its size', async () => {
  const f = join(base, 'big.png')
  writeFileSync(f, Buffer.concat([PNG, Buffer.alloc(LIMITS.rawImage)]))
  const p = await previewFile(f, { sips: false })
  expect(p.thumb).toBeUndefined()
  expect([p.width, p.height]).toEqual([3, 2])
})

test('jpeg, gif and webp headers give their size', () => {
  const gif = Buffer.from('474946383961' + '0a00' + '0500', 'hex')
  expect(imageSize(Buffer.concat([gif, Buffer.alloc(4)]))).toEqual({ width: 10, height: 5 })
  const jpg = Buffer.from('ffd8' + 'ffe00004' + '0000' + 'ffc00011' + '08' + '0040' + '0080' + '03' + '0000000000', 'hex')
  expect(imageSize(jpg)).toEqual({ width: 128, height: 64 })
})

test('an svg reads its size from the root element and is sent as it is', async () => {
  const f = join(base, 'logo.svg')
  writeFileSync(f, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"><rect width="48" height="24"/></svg>')
  const p = await previewFile(f, { sips: false })
  expect([p.kind, p.width, p.height]).toEqual(['image', 48, 24])
  expect(p.thumb).toStartWith('data:image/svg+xml;base64,')
})

test('text gives its first lines, each cut short, and its line count', async () => {
  const f = join(base, 'notes.md')
  writeFileSync(f, Array.from({ length: 50 }, (_, i) => (i === 0 ? 'x'.repeat(1000) : `line ${i}`)).join('\n') + '\n')
  const p = await previewFile(f)
  expect(p.kind).toBe('text')
  expect(p.lines).toHaveLength(LIMITS.lines)
  expect(p.lines![0]!.length).toBe(LIMITS.lineChars + 1)
  expect(p.lines![1]).toBe('line 1')
  expect([p.lineCount, p.over]).toEqual([50, false])
  const short = join(base, 'a.txt')
  writeFileSync(short, 'one\ntwo')
  expect(await previewFile(short)).toMatchObject({ lines: ['one', 'two'], lineCount: 2 })
})

test('a big text file is read only at its head, and its count stops at the cap', async () => {
  const f = join(base, 'huge.log')
  writeFileSync(f, 'abc\n'.repeat((LIMITS.countBytes >> 2) + 1000))
  const p = await previewFile(f)
  expect(p.lines).toHaveLength(LIMITS.lines)
  expect(p.over).toBe(true)
  expect(p.lineCount).toBe(LIMITS.countBytes >> 2)
})

test('binary content, PDFs and videos give name, size and time only', async () => {
  const bin = join(base, 'blob.dat')
  writeFileSync(bin, Buffer.from([0, 1, 2, 3, 0, 255]))
  expect(looksText(Buffer.from([0, 1]))).toBe(false)
  const b = await previewFile(bin)
  expect(b.kind).toBe('file')
  expect(b.lines).toBeUndefined()
  const vid = join(base, 'demo.mp4')
  writeFileSync(vid, 'not really')
  expect(await previewFile(vid)).toMatchObject({ kind: 'video', name: 'demo.mp4', size: 10 })
  const pdf = join(base, 'doc.pdf')
  writeFileSync(pdf, '%PDF-1.4 broken')
  expect(await previewFile(pdf, { sips: false })).toMatchObject({ kind: 'pdf', thumb: undefined })
})

test('a folder lists its first entries, folders first, and counts them', async () => {
  const d = join(base, 'many')
  mkdirSync(join(d, 'sub'), { recursive: true })
  for (let i = 0; i < 20; i++) writeFileSync(join(d, `f${String(i).padStart(2, '0')}.txt`), '')
  writeFileSync(join(d, '.hidden'), '')
  const p = await previewFile(d)
  expect(p.kind).toBe('folder')
  expect(p.total).toBe(22)
  expect(p.entries).toHaveLength(LIMITS.entries)
  expect(p.entries![0]).toEqual({ name: 'sub', dir: true })
  expect(p.entries!.some((e) => e.name === '.hidden')).toBe(false)
})

test('device files are refused', async () => {
  await expect(previewFile('/dev/null')).rejects.toThrow(/not a regular file/)
})

test('only what ⌘-click would open: missing names and paths outside home are refused before a preview', async () => {
  await expect(findLink('nowhere-xyz.png', { bases: [base], roots: false })).rejects.toThrow(/no such file/)
  await expect(findLink('/etc/hosts', { bases: [base], roots: false })).rejects.toThrow(/only files under your home/)
  await expect(findLink('/dev/null', { bases: [base], roots: false })).rejects.toThrow(/only files under your home/)
  // hover and click share the session's cache: a find kept by one is what the other gets
  const cache = new Map([['gone/shot.png', join(base, 'shot.png')]])
  expect(await findLink('gone/shot.png', { bases: [base], cache, roots: false })).toEqual({ path: join(base, 'shot.png'), step: 'cache' })
})
