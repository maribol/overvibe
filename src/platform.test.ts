import { expect, test } from 'bun:test'
import { IS_MAC, clipboardBytes, clipboardCommand, clipboardShell, linuxDistro, osInfo } from './platform'

test('linuxDistro reads ID and VERSION_ID, quoted or not', () => {
  expect(linuxDistro('NAME="Debian GNU/Linux"\nID=debian\nVERSION_ID="12"\n')).toBe('debian 12')
  expect(linuxDistro('ID=arch\n')).toBe('arch')
  expect(linuxDistro('ID="ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu; rm -rf"\n')).toBe('ubuntu 24.04')
  expect(linuxDistro('')).toBe('')
})

test('macOS keeps pbcopy and the old copy-command line', () => {
  if (!IS_MAC) return
  expect(clipboardCommand()).toEqual(['/usr/bin/pbcopy'])
  expect(clipboardShell()).toBe('LANG=en_US.UTF-8 /usr/bin/pbcopy')
})

test('osInfo names the OS and keeps macos for a Mac', async () => {
  const o = await osInfo()
  if (IS_MAC) {
    expect(o.os).toMatch(/^macos( \d+(\.\d+)*)?$/)
    expect(o.os).toBe(o.macos ? `macos ${o.macos}` : 'macos')
  } else {
    expect(o.macos).toBe('')
    expect(o.os).toMatch(/^(linux|wsl)/)
  }
})

test('clip.exe gets UTF-16LE with a byte order mark; other commands get the text', () => {
  expect(clipboardBytes(['/usr/bin/pbcopy'], 'aă')).toBe('aă')
  expect([...(clipboardBytes(['/mnt/c/Windows/System32/clip.exe'], 'aă') as Uint8Array)]).toEqual([0xff, 0xfe, 0x61, 0x00, 0x03, 0x01])
})
