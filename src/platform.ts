// What differs between macOS, Linux and Windows through WSL2 [T1111-8]: the clipboard command, the OS name
// the usage ping reports, and whether Mac-only extras (the desktop app) exist. Everything else (tmux, the
// loopback server, the token, the Host/Origin checks) is the same on every OS.
import { existsSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'

export const IS_MAC = process.platform === 'darwin'
export const IS_LINUX = process.platform === 'linux'

/** WSL sets WSL_DISTRO_NAME in shells, but not under systemd; its kernel release always says "microsoft" */
export const IS_WSL =
  IS_LINUX &&
  (!!process.env.WSL_DISTRO_NAME ||
    (() => {
      try {
        return /microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8'))
      } catch {
        return false
      }
    })())

/** the first of these found on PATH (or at its usual path) */
function find(...names: string[]): string | null {
  for (const n of names) {
    if (n.startsWith('/')) {
      if (existsSync(n)) return n
    } else {
      const p = Bun.which(n)
      if (p) return p
    }
  }
  return null
}

/**
 * The command that puts stdin on the system clipboard, or null when there is none (then OSC 52 through
 * the browser is the only way, which needs the tab focused). macOS: pbcopy. WSL: Windows' clip.exe.
 * Linux: wl-copy on Wayland, xclip or xsel on X11; each needs the display variables in the server's env.
 */
export function clipboardCommand(env: Record<string, string | undefined> = process.env): string[] | null {
  if (IS_MAC) return ['/usr/bin/pbcopy']
  if (!IS_LINUX) return null
  if (IS_WSL) {
    const clip = find('clip.exe', '/mnt/c/Windows/System32/clip.exe')
    if (clip) return [clip]
  }
  if (env.WAYLAND_DISPLAY) {
    const w = find('wl-copy')
    if (w) return [w]
  }
  if (env.DISPLAY) {
    const x = find('xclip')
    if (x) return [x, '-selection', 'clipboard']
    const s = find('xsel')
    if (s) return [s, '--clipboard', '--input']
  }
  return null
}

/** what to write to the clipboard command's stdin: clip.exe reads UTF-8 as the console code page and
 *  garbles anything past ASCII, but takes UTF-16LE with a byte order mark as it is */
export function clipboardBytes(cmd: string[], text: string): string | Uint8Array {
  if (!/clip\.exe$/i.test(cmd[0] ?? '')) return text
  const out = new Uint8Array(2 + text.length * 2)
  out[0] = 0xff
  out[1] = 0xfe
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    out[2 + i * 2] = c & 0xff
    out[3 + i * 2] = c >> 8
  }
  return out
}

/** the clipboard command as one shell line for tmux's copy-command ('' when there is none). Not on WSL:
 *  clip.exe needs UTF-16 (clipboardBytes), so there the copy goes through the page and the server */
export function clipboardShell(): string {
  const c = clipboardCommand()
  if (!c || IS_WSL) return ''
  const q = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
  return `LANG=en_US.UTF-8 ${c.map(q).join(' ')}`
}

/** os-release's ID and VERSION_ID, e.g. "debian 12" or "ubuntu 24.04" ('' when unreadable) */
export function linuxDistro(text?: string): string {
  try {
    const s = text ?? readFileSync('/etc/os-release', 'utf8')
    const get = (k: string) => new RegExp(`^${k}="?([^"\\n]*)"?$`, 'm').exec(s)?.[1]?.trim() ?? ''
    return [get('ID'), get('VERSION_ID')].filter(Boolean).join(' ').replace(/[^\w .-]/g, '').slice(0, 40)
  } catch {
    return ''
  }
}

async function macVersion(): Promise<string> {
  try {
    const p = Bun.spawn(['sw_vers', '-productVersion'], { stdout: 'pipe', stderr: 'ignore' })
    const out = await Promise.race([new Response(p.stdout).text(), Bun.sleep(3000).then(() => '')])
    p.kill()
    const v = out.trim()
    return /^\d+(\.\d+){0,3}$/.test(v) ? v : ''
  } catch {
    return ''
  }
}

/** for the usage ping: the macOS version (its old `macos` field) and an `os` field for every OS:
 *  "macos 15.5", "linux debian 12", "wsl ubuntu 24.04" */
export async function osInfo(): Promise<{ macos: string; os: string }> {
  if (IS_MAC) {
    const v = await macVersion()
    return { macos: v, os: v ? `macos ${v}` : 'macos' }
  }
  if (IS_LINUX) {
    const d = linuxDistro()
    return { macos: '', os: `${IS_WSL ? 'wsl' : 'linux'}${d ? ' ' + d : ''}` }
  }
  return { macos: '', os: process.platform }
}

/** the user's login shell: $SHELL, else the passwd entry's (a systemd unit or `docker -u` may leave SHELL unset),
 *  else zsh, bash or sh, whichever exists */
export function loginShell(): string {
  const ok = (p: string | undefined | null): p is string => !!p && p.startsWith('/') && !/nologin|false$/.test(p) && existsSync(p)
  if (ok(process.env.SHELL)) return process.env.SHELL
  try {
    const u = userInfo().shell
    if (ok(u)) return u
  } catch {}
  return ['/bin/zsh', '/bin/bash', '/bin/sh'].find((p) => existsSync(p)) ?? '/bin/sh'
}
