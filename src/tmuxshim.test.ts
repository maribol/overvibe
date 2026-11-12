import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installShim, pathWithShim } from './tmuxshim'
import { isTmuxShim, realTmux } from './env'

// the shim runs for real, with a fake "real tmux" that prints what it was given
const root = mkdtempSync(join(tmpdir(), 'ov-shim-'))
const fake = join(root, 'real-tmux')
writeFileSync(fake, '#!/bin/sh\necho "REAL $*"\n')
chmodSync(fake, 0o755)
const { dir, zdotdir } = installShim(root, fake, 'deck-sock')
const DECK = '/private/tmp/tmux-501/deck-sock,123,4'

function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(['/bin/sh', join(dir, 'tmux'), ...args], { env: { PATH: '/usr/bin:/bin', TMUX: DECK, ...env } })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}
const blocked = (args: string[], env?: Record<string, string>) => {
  const r = run(args, env)
  expect(r.code).toBe(1)
  expect(r.out).toBe('')
  return r.err
}
const passes = (args: string[], env?: Record<string, string>) => {
  const r = run(args, env)
  expect(r.code).toBe(0)
  expect(r.out).toBe(`REAL ${args.join(' ')}`.trimEnd())
}

describe('tmux shim: which server', () => {
  test('$TMUX on the deck, no -L/-S: the deck', () => expect(blocked(['capture-pane', '-p', '-t', 'abc'])).toContain('overvibe peek "abc"'))
  test('-L deck socket, outside any tmux', () => expect(blocked(['-L', 'deck-sock', 'ls'], { TMUX: '' })).toContain('overvibe ls'))
  test('-Ldeck-sock glued', () => expect(blocked(['-Ldeck-sock', 'ls'], { TMUX: '' })).toContain('overvibe ls'))
  test('-S deck socket path', () => expect(blocked(['-S', '/tmp/tmux-501/deck-sock', 'kill-server'], { TMUX: '' })).toContain('overvibe stop'))
  test('another -L socket passes', () => passes(['-L', 'mine', 'capture-pane', '-p']))
  test('another -S socket passes', () => passes(['-S', '/tmp/x/other', 'list-sessions']))
  test('the user tmux ($TMUX elsewhere) passes', () => passes(['list-sessions'], { TMUX: '/private/tmp/tmux-501/default,1,0' }))
  test('no $TMUX, no -L: the default server passes', () => passes(['ls'], { TMUX: '' }))
  test('-L other beats a deck $TMUX', () => passes(['-L', 'other', 'ls']))
})

describe('tmux shim: which command', () => {
  test('send-keys, send, paste-buffer -> overvibe send', () => {
    expect(blocked(['send-keys', '-t', '=abc:', 'hi', 'Enter'])).toContain('overvibe send "abc" "<message>"')
    expect(blocked(['send', '-t', 'abc', 'x'])).toContain('overvibe send')
    expect(blocked(['paste-buffer', '-t', 'abc'])).toContain('overvibe send')
  })
  test('lists -> overvibe ls', () => {
    for (const c of ['list-sessions', 'ls', 'list-panes', 'lsp', 'list-windows', 'list-clients']) expect(blocked([c])).toContain('use: overvibe ls')
  })
  test('attach and switching -> overvibe open / attach', () => {
    for (const c of ['attach-session', 'attach', 'a', 'switch-client', 'switchc', 'select-window', 'select-pane']) {
      const e = blocked([c, '-t', 'abc'])
      expect(e).toContain('overvibe open "abc"')
      expect(e).toContain('overvibe attach "abc"')
    }
  })
  test('kills -> overvibe stop', () => {
    for (const c of ['kill-session', 'kill-server', 'kill-pane', 'killw']) expect(blocked([c, '-t', 'abc'])).toContain('overvibe stop')
  })
  test('new and splits -> overvibe new', () => {
    for (const c of ['new-session', 'new', 'new-window', 'split-window', 'splitw', 'respawn-pane']) expect(blocked([c])).toContain('overvibe new')
    expect(blocked([])).toContain('overvibe new') // bare tmux starts a session
  })
  test('unique prefixes count, ambiguous ones are left to tmux', () => {
    expect(blocked(['capture-p', '-p'])).toContain('overvibe peek')
    expect(blocked(['capturep', '-p'])).toContain('overvibe peek')
    passes(['li']) // list-buffers, list-clients, list-commands...: tmux itself says ambiguous
  })
  test('global flags before the command', () => expect(blocked(['-u', '-2', '-f', '/dev/null', 'capture-pane', '-p'])).toContain('overvibe peek'))
  test('a blocked command later in a ; chain', () => {
    expect(blocked(['display-message', '-p', 'x', ';', 'capture-pane', '-p'])).toContain('capture-pane')
    expect(blocked(['display-message', '-p', 'x;', 'ls'])).toContain('overvibe ls')
  })
  test('no target names a placeholder; pane ids are no name', () => {
    expect(blocked(['capture-pane', '-p'])).toContain('overvibe peek "<session name>"')
    expect(blocked(['capture-pane', '-p', '-t', '%3'])).toContain('overvibe peek "<session name>"')
    expect(blocked(['capture-pane', '-p', '-tabc:0.1'])).toContain('overvibe peek "abc"')
  })
  test('the hint never mentions the escape hatch', () => expect(blocked(['ls'])).not.toContain('RAW'))
})

describe('tmux shim: passes through', () => {
  // what Claude Code and Codex run themselves: clipboard, passthrough, option reads
  for (const a of [['load-buffer', '-w', '-'], ['load-buffer', '-'], ['show', '-g', 'mouse'], ['show-options', '-gv', 'set-clipboard'], ['display-message', '-p', '#{client_termname}'], ['set-buffer', 'x'], ['has-session', '-t', 'abc'], ['show-environment'], ['-V'], ['-c', 'ls']])
    test(a.join(' '), () => passes(a))
  test('arguments keep their spaces', () => {
    const r = run(['display-message', '-p', 'a  b'])
    expect(r.out).toBe('REAL display-message -p a  b')
  })
  test('OVERVIBE_RAW_TMUX=1 lets a blocked call through', () => passes(['capture-pane', '-p'], { OVERVIBE_RAW_TMUX: '1' }))
  test('OVERVIBE_TMUX_BIN picks the real tmux', () => {
    const other = join(root, 'other-tmux')
    writeFileSync(other, '#!/bin/sh\necho "OTHER $*"\n')
    chmodSync(other, 0o755)
    expect(run(['show', '-g'], { OVERVIBE_TMUX_BIN: other }).out).toBe('OTHER show -g')
  })
})

describe('the real tmux is never the shim', () => {
  test('isTmuxShim', () => {
    expect(isTmuxShim(join(dir, 'tmux'))).toBe(true)
    expect(isTmuxShim(fake)).toBe(false)
  })
  test('realTmux skips the shim folder on PATH', () => {
    const bin = mkdtempSync(join(tmpdir(), 'ov-bin-'))
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\n')
    chmodSync(join(bin, 'tmux'), 0o755)
    expect(realTmux({ PATH: `${dir}:${bin}` })).toBe(join(bin, 'tmux'))
    expect(realTmux({ PATH: `${dir}:${bin}`, OVERVIBE_TMUX_BIN: join(dir, 'tmux') })).toBe(join(bin, 'tmux'))
    expect(realTmux({ PATH: dir, OVERVIBE_TMUX_BIN: fake })).toBe(fake)
  })
  test('pathWithShim puts it first once', () => expect(pathWithShim('/s', '/a:/s:/b')).toBe('/s:/a:/b'))
})

describe('zsh wrappers keep the shim first after a login shell', () => {
  // a fake home whose .zprofile does what brew shellenv does: put a folder with its own tmux first
  const home = mkdtempSync(join(tmpdir(), 'ov-home-'))
  const brew = join(home, 'brew')
  Bun.spawnSync(['mkdir', '-p', brew])
  writeFileSync(join(brew, 'tmux'), '#!/bin/sh\necho BREW\n')
  chmodSync(join(brew, 'tmux'), 0o755)
  writeFileSync(join(home, '.zprofile'), `export PATH="${brew}:$PATH"\nexport FROM_ZPROFILE=1\n`)
  writeFileSync(join(home, '.zshrc'), `export FROM_ZSHRC=1\n`)
  const zsh = (args: string[]) =>
    Bun.spawnSync(['/bin/zsh', ...args], { env: { HOME: home, PATH: `${dir}:/usr/bin:/bin`, ZDOTDIR: zdotdir, TMUX: DECK, OVERVIBE_TMUX_BIN: fake } }).stdout.toString().trim()
  const has = existsSync('/bin/zsh')
  test.if(has)('zsh -lc: the user files ran and tmux is still the shim', () => {
    expect(zsh(['-lc', 'echo $FROM_ZPROFILE; command -v tmux; echo $ZDOTDIR'])).toBe(`1\n${join(dir, 'tmux')}\n${zdotdir}`)
  })
  test.if(has)('zsh -ic (interactive): .zshrc ran, history is the user one', () => {
    const out = zsh(['-ic', 'echo $FROM_ZSHRC; command -v tmux; echo $HISTFILE'])
    expect(out.split('\n').slice(0, 2)).toEqual(['1', join(dir, 'tmux')])
    expect(out).not.toContain(join(zdotdir, '.zsh_history'))
  })
  test.if(has)('zsh -c', () => expect(zsh(['-c', 'command -v tmux'])).toBe(join(dir, 'tmux')))
})
