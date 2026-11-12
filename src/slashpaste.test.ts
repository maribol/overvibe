import { describe, expect, test } from 'bun:test'
import { splitBracketed, splitSlash } from './slashpaste'

describe('splitSlash [T1112-132]', () => {
  test('a command with an argument', () => {
    expect(splitSlash('/compact keep: the open tasks')).toEqual(['/compact ', 'keep: the open tasks'])
    expect(splitSlash('/plugin:cmd  a\nb')).toEqual(['/plugin:cmd  ', 'a\nb'])
  })
  test('left alone: no argument, a path, plain text', () => {
    expect(splitSlash('/compact')).toBeNull()
    expect(splitSlash('/compact ')).toBeNull()
    expect(splitSlash('/usr/bin/env bun')).toBeNull()
    expect(splitSlash('hello /compact x')).toBeNull()
  })
  test('bracketed paste from the page', () => {
    expect(splitBracketed('\x1b[200~/compact keep: x\x1b[201~')).toEqual(['/compact ', '\x1b[200~keep: x\x1b[201~'])
    expect(splitBracketed('/compact keep: x')).toBeNull()
    expect(splitBracketed('\x1b[200~notes\x1b[201~')).toBeNull()
  })
})
