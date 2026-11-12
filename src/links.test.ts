import { describe, expect, test } from 'bun:test'
import { compileUser, linksAt, lineAt, type LinkCtx, type Screen } from './web/links'
import { checkUserLinks, riskyPattern } from './linkuser'
import type { Row } from './web/compactLink'

const screen = (rows: (string | Row)[]): Screen => ({ row: (y) => (typeof rows[y] === 'string' ? { text: rows[y] as string, wrapped: false } : (rows[y] as Row | undefined)) })
const ALL: LinkCtx = { git: true, github: 'maribol/overvibe', tasks: true, compact: true }
/** [matcher, text, where it goes] for each link on a one-row screen */
const on = (line: string, c: LinkCtx = ALL) =>
  linksAt(screen([line]), 0, c).map((l) => [l.matcher, l.text, 'url' in l.target ? l.target.url : 'path' in l.target ? l.target.path : 'id' in l.target ? l.target.id : 'text' in l.target ? l.target.text : l.target.args])
const kinds = (line: string, c: LinkCtx = ALL) => on(line, c).map(([m, t]) => `${m}:${t}`)

describe('the types that were there before, unchanged [T1112-137]', () => {
  test('full URLs', () => {
    expect(on('see https://github.com/maribol/overvibe/pull/3, then')).toEqual([['url', 'https://github.com/maribol/overvibe/pull/3', 'https://github.com/maribol/overvibe/pull/3']])
    expect(kinds('(https://example.com/a?b=1#c)')).toEqual(['url:https://example.com/a?b=1#c'])
  })
  test('sites without https:// [T1112-133]', () => {
    expect(on('read docs.elasticfunnels.io/analytics/tracking-metrics.')).toEqual([['site', 'docs.elasticfunnels.io/analytics/tracking-metrics', 'https://docs.elasticfunnels.io/analytics/tracking-metrics']])
    expect(on('go to overvibe.dev')).toEqual([['site', 'overvibe.dev', 'https://overvibe.dev']])
  })
  test('paths and bare names', () => {
    expect(kinds('edit src/web/links.ts:12 and ~/x/y.png')).toEqual(['path:src/web/links.ts:12', 'path:~/x/y.png'])
    expect(kinds('wrote walkthrough.mp4 and notes.md.')).toEqual(['path:walkthrough.mp4', 'path:notes.md'])
    expect(kinds('e.g. this, i.e. that')).toEqual([])
    expect(kinds('the Overvibe.app/Contents folder')).toEqual(['path:Overvibe.app/Contents'])
  })
  test('/compact over its wrapped rows wins over the paths inside it', () => {
    const s = screen(['⏺ Done.', '', '  /compact keep: src/web/links.ts and the', '  branch ov/x', '', 'see src/a.ts'])
    for (const y of [2, 3]) expect(linksAt(s, y, ALL).map((l) => l.matcher)).toEqual(['compact'])
    expect(linksAt(s, 2, ALL)[0]!.target).toEqual({ kind: 'compact', args: 'keep: src/web/links.ts and the branch ov/x' })
    expect(linksAt(s, 2, { ...ALL, compact: false }).map((l) => l.text)).toEqual(['src/web/links.ts'])
    expect(linksAt(s, 5, ALL).map((l) => l.text)).toEqual(['src/a.ts'])
  })
})

describe('overlaps are settled by order', () => {
  test('a URL keeps the path, Reddit and npm look-alikes inside it', () => {
    expect(kinds('https://www.reddit.com/r/ClaudeCode/ https://www.npmjs.com/package/@anthropic-ai/sdk')).toEqual(['url:https://www.reddit.com/r/ClaudeCode/', 'url:https://www.npmjs.com/package/@anthropic-ai/sdk'])
  })
  test('owner/repo#12 is an issue, not a path', () => {
    expect(on('fixed in maribol/overvibe#12')).toEqual([['github', 'maribol/overvibe#12', 'https://github.com/maribol/overvibe/issues/12']])
    expect(on('github.com/maribol/overvibe#3 and github.com/maribol/overvibe')).toEqual([
      ['github', 'github.com/maribol/overvibe#3', 'https://github.com/maribol/overvibe/issues/3'],
      ['site', 'github.com/maribol/overvibe', 'https://github.com/maribol/overvibe'],
    ])
  })
  test('@scope/name is a package, a path below it is a path', () => {
    expect(kinds('bun add @anthropic-ai/sdk')).toEqual(['npm:@anthropic-ai/sdk'])
    expect(kinds('see @types/node/index.d.ts and node_modules/@types/node')).toEqual(['path:@types/node/index.d.ts', 'path:node_modules/@types/node'])
  })
  test('r/sub inside a path stays the path', () => {
    expect(kinds('cd dir/r/ClaudeCode and r/ClaudeCode/x.ts')).toEqual(['path:dir/r/ClaudeCode', 'path:r/ClaudeCode/x.ts'])
  })
  test('a wrapped line is one line: a URL across two rows is one link on both', () => {
    const s = screen([{ text: 'see https://example.com/aaaa', wrapped: false }, { text: 'bbbb/c done', wrapped: true }])
    for (const y of [0, 1]) expect(linksAt(s, y, ALL).map((l) => [l.text, l.range])).toEqual([['https://example.com/aaaabbbb/c', { start: { x: 4, y: 0 }, end: { x: 5, y: 1 } }]])
    expect(lineAt(s, 1).top).toBe(0)
  })
  test('wide characters: the link lands on its cells', () => {
    const s = screen([{ text: '漢 src/a.ts', wrapped: false, xs: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10] }])
    expect(linksAt(s, 0, ALL)[0]!.range).toEqual({ start: { x: 3, y: 0 }, end: { x: 10, y: 0 } })
  })
})

describe('local servers', () => {
  test('localhost and 127.0.0.1 with a port, without http://', () => {
    expect(on('listening on 127.0.0.1:7777, open localhost:5173/app.')).toEqual([
      ['local', '127.0.0.1:7777', 'http://127.0.0.1:7777'],
      ['local', 'localhost:5173/app', 'http://localhost:5173/app'],
    ])
    expect(kinds('http://localhost:3000/x')).toEqual(['url:http://localhost:3000/x'])
    expect(kinds('bound to 0.0.0.0:80; localhost alone; ssh me@localhost:22')).toEqual([])
  })
})

describe('Reddit', () => {
  test('r/ and u/', () => {
    expect(on('posted on r/ClaudeCode by u/some_user.')).toEqual([['reddit', 'r/ClaudeCode', 'https://www.reddit.com/r/ClaudeCode'], ['reddit', 'u/some_user', 'https://www.reddit.com/user/some_user']])
    expect(linksAt(screen(['r/ClaudeCode']), 0, ALL)[0]!.label).toBe('Open r/ClaudeCode on Reddit')
  })
  test('not r/w, w/o, ./r/x or a/r/x', () => {
    // short ones were path links before and stay so; none is Reddit
    expect(kinds('mount r/w and w/o it; also r/o').filter((k) => k.startsWith('reddit'))).toEqual([])
    expect(kinds('./r/foo')).toEqual(['path:./r/foo'])
  })
})

describe('npm', () => {
  test('scoped names, with or without a version', () => {
    expect(on('uses @anthropic-ai/sdk@0.3.1.')).toEqual([['npm', '@anthropic-ai/sdk', 'https://www.npmjs.com/package/@anthropic-ai/sdk']])
    expect(linksAt(screen(['@xterm/xterm']), 0, ALL)[0]!.label).toBe('Open @xterm/xterm on npm')
  })
  test('import aliases, Android resources and eslint rules are not packages (seen in transcripts)', () => {
    const npm = (l: string) => kinds(l).filter((k) => k.startsWith('npm'))
    expect(npm("import { PACK } from '@shared/pack'")).toEqual([])
    expect(npm('android:icon="@mipmap/ic_launcher"')).toEqual([])
    expect(npm('// eslint-disable-next-line @typescript-eslint/no-require-imports')).toEqual([])
    expect(kinds('  "@types/bun": "latest",')).toEqual(['npm:@types/bun'])
  })
  test('a lone @word, an email and a git address are not packages', () => {
    expect(kinds('@Component and @param x, mail me@x.dev, git@github.com:a/b')).not.toContain('npm:@param')
    expect(kinds('@Component and @param x').filter((k) => k.startsWith('npm'))).toEqual([])
    expect(kinds('git@github.com:a/b.git').filter((k) => k.startsWith('npm'))).toEqual([])
  })
  test('names after an install command', () => {
    expect(kinds('$ npm i -D vite @types/bun')).toEqual(['npm:vite', 'npm:@types/bun'])
    expect(kinds('⏺ Bash(bun add zod@3 && bun test)')).toEqual(['npm:zod'])
    expect(kinds('run `pnpm add left-pad` first')).toEqual(['npm:left-pad'])
    expect(kinds('npm install')).toEqual([])
    expect(kinds('bun add ./local-pkg')).toEqual(['path:./local-pkg'])
  })
  test('prose that starts with an install command is not a package list', () => {
    expect(kinds('npm install fails when the lockfile is old and the cache')).toEqual([])
    expect(kinds('  bun install')).toEqual([])
  })
})

describe('GitHub issues', () => {
  test('a bare #12 only with a GitHub remote and words that say issue or PR', () => {
    expect(on('merged PR #12, fixes #14')).toEqual([
      ['issue', '#12', 'https://github.com/maribol/overvibe/issues/12'],
      ['issue', '#14', 'https://github.com/maribol/overvibe/issues/14'],
    ])
    // a squash-merge subject
    expect(kinds('a1b2c3d Terminal links (#13)', { github: 'maribol/overvibe' })).toEqual(['issue:#13'])
    // ids in parentheses mid-line are something else (seen in transcripts: affiliates, CRM rows)
    expect(kinds('affiliate (#1156 ×9, #2736); Leads CRM (#112, slug leads)')).toEqual([])
    expect(kinds('merged PR #12', { ...ALL, github: null })).toEqual([])
    expect(kinds('step #2, item #3, color #fff, a#1')).toEqual([])
  })
})

describe('commit shas', () => {
  test('7 to 40 hex with a letter and a digit, in a git folder, checked by the server', () => {
    const [l] = linksAt(screen(['f36a662 Terminal links']), 0, ALL)
    expect(l).toMatchObject({ matcher: 'commit', text: 'f36a662', verify: 'commit', label: 'Open commit f36a662 on GitHub', target: { kind: 'url', url: 'https://github.com/maribol/overvibe/commit/f36a662' } })
    expect(linksAt(screen(['f36a662']), 0, { git: true })[0]).toMatchObject({ label: 'Copy commit f36a662', target: { kind: 'copy', text: 'f36a662' } })
    expect(kinds('f36a662', { github: null })).toEqual([])
  })
  test('not words, numbers, uuids, colours or longer hashes', () => {
    expect(kinds('deadbeef 1234567 #a1b2c3d 3f2a9c1e-1111-2222-3333-444455556666 sha256:' + 'ab12'.repeat(16))).toEqual([])
    expect(kinds('facade0 decade1').map((k) => k.split(':')[0])).toEqual(['commit', 'commit'])
  })
})

describe('task ids', () => {
  test('T<month><day>-<n> opens the Tasks view', () => {
    expect(linksAt(screen(['done [T1112-133].']), 0, ALL)[0]).toMatchObject({ text: 'T1112-133', target: { kind: 'task', id: 'T1112-133' }, label: 'Open T1112-133 in Tasks' })
    expect(kinds('T1399-1 T0000-2 XT1112-1 T1112-1x')).toEqual([])
    // inside a path it is part of the path (seen in transcripts)
    expect(kinds('~/scratchpad/ef/T1110-16/web/vite.config.js')).toEqual(['path:~/scratchpad/ef/T1110-16/web/vite.config.js'])
    expect(kinds('T1112-133', { ...ALL, tasks: false })).toEqual([])
  })
})

describe('user matchers (links.json)', () => {
  const jira = { name: 'Jira', pattern: '\\b[A-Z]{2,6}-\\d{1,6}\\b', url: 'https://acme.atlassian.net/browse/$0' }
  test('checked on the server: bad ones skipped with a reason', () => {
    const r = checkUserLinks([
      jira,
      { name: 'bad', pattern: '(', url: 'https://x.dev/$0' },
      { name: 'slow', pattern: '(a+)+$', url: 'https://x.dev/$0' },
      { name: 'js', pattern: 'x', url: 'javascript:alert(1)' },
      { name: 'empty', pattern: 'a*', url: 'https://x.dev/' },
      { name: 'many', pattern: '.*a.*b.*c.*d', url: 'https://x.dev/' },
      'nope',
    ])
    expect(r.ok.map((x) => x.name)).toEqual(['Jira'])
    expect(r.skipped.map((x) => x.name)).toEqual(['bad', 'slow', 'js', 'empty', 'many', 'entry 7'])
    expect(checkUserLinks({}).skipped[0]!.why).toMatch(/list/)
    expect(checkUserLinks(undefined)).toEqual({ ok: [], skipped: [] })
  })
  test('risky shapes', () => {
    for (const p of ['(a+)+', '(\\w*)*', '(?:x|y+){2,}', '(a)\\1', '((ab)*c)+']) expect(riskyPattern(p)).not.toBeNull()
    for (const p of ['\\b[A-Z]+-\\d+\\b', '(a|b)+', '[(+]+', 'x{2,5}', '(ab)+c+']) expect(riskyPattern(p)).toBeNull()
  })
  test('run after full URLs and before the built-in ones, with $0/$1 filled in', () => {
    const user = compileUser([jira, { name: 'Ticket', pattern: 'TK(\\d+)', url: 'https://t.dev/t/$1?q=$0', label: 'Open ticket $1' }])
    const c = { ...ALL, user }
    expect(on('fix ABC-12 and TK7, not https://x.dev/ABC-12', c)).toEqual([
      ['user:Jira', 'ABC-12', 'https://acme.atlassian.net/browse/ABC-12'],
      ['user:Ticket', 'TK7', 'https://t.dev/t/7?q=TK7'],
      ['url', 'https://x.dev/ABC-12', 'https://x.dev/ABC-12'],
    ])
    expect(linksAt(screen(['TK7']), 0, c)[0]!.label).toBe('Open ticket 7')
    expect(linksAt(screen(['ABC-12']), 0, c)[0]!.label).toBe('Open ABC-12 in Jira')
  })
  test('a pattern that runs too long on a line is turned off', () => {
    const warned: string[] = []
    const [m] = compileUser([{ name: 'slowpoke', pattern: '(?:a|a?)*?b', url: 'https://x.dev/$0' }], (w) => warned.push(w))
    const t0 = performance.now()
    linksAt(screen(['a'.repeat(30)]), 0, { user: [m!] })
    if (performance.now() - t0 > 25) expect(m!.slow).toBe(true)
    // whatever the speed of this machine, a slow one stays off
    m!.slow = true
    expect(linksAt(screen(['ab']), 0, { user: [m!] })).toEqual([])
  })
  test('long matches are dropped', () => {
    const [m] = compileUser([{ name: 'x', pattern: 'x+', url: 'https://x.dev/$0' }])
    expect(linksAt(screen(['x'.repeat(400)]), 0, { user: [m!] })).toEqual([])
  })
})
