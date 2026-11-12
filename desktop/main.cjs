// Overvibe desktop: one window on http://127.0.0.1:7777, so ⌘N, ⌘W, ⌘T and Ctrl+Tab reach the deck
// (Chrome keeps them for itself). The page is the same one Chrome shows; nothing new is served or bound.
//
// Security: the window logs in by setting the `deck` cookie from ~/.config/overvibe/token (never a
// URL), may only navigate within the deck's origin, opens every other link in the default browser,
// and runs the page with contextIsolation + sandbox and no Node. The server's own Host/Origin checks
// stay as they are: this window's Origin is http://127.0.0.1:7777 like the browser's.
const { app, BrowserWindow, Menu, ipcMain, session, shell, screen } = require('electron')
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const PORT = Number(process.env.DECK_PORT || 7777)
const ORIGIN = `http://127.0.0.1:${PORT}`
const HOME = os.homedir()
// the config folder, as src/env.ts dataDirFor picks it: ~/.config/overvibe, or ~/.config/overvibe on an
// install from before the rename [T1110-80]
const DATA_DIR = (() => {
  if (process.env.OVERVIBE_DATA_DIR) return process.env.OVERVIBE_DATA_DIR.replace(/^~(?=\/|$)/, HOME)
  const neu = path.join(HOME, '.config/overvibe')
  const old = path.join(HOME, '.config/agent-deck')
  const realDir = (p) => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink() } catch { return false } }
  return realDir(old) && (fs.existsSync(path.join(old, 'token')) || !realDir(neu)) ? old : neu
})()
const TOKEN_FILE = path.join(DATA_DIR, 'token')
const readText = (f) => { try { return fs.readFileSync(f, 'utf8').trim() } catch { return '' } }
const CONFIG = (() => { try { return JSON.parse(readText(path.join(DATA_DIR, 'config.json')) || '{}') } catch { return {} } })()
const untildify = (p) => (p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p)
// the repo the server runs from: env, else the path `bun run desktop:build` recorded, else the checkout
// this file sits in (a dev run with `bun run desktop`)
const REPO = untildify(process.env.AGENT_DECK_REPO || readText(path.join(DATA_DIR, 'repo')) || path.resolve(__dirname, '..'))
// server.log and vite.log when the window starts the server: config.json logDir, else ~/.config/overvibe/logs
const LOG_DIR = untildify(process.env.DECK_LOG_DIR || CONFIG.logDir || path.join(DATA_DIR, 'logs'))
const OFFLINE = path.join(__dirname, 'offline.html')
const STATE_FILE = () => path.join(app.getPath('userData'), 'window.json')

/** @type {BrowserWindow | null} */
let win = null

// ---------- server reachability and start ----------

/** Any HTTP answer (even 401/403) means the deck is up. */
function reachable(timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health-probe', timeout, headers: { host: `127.0.0.1:${PORT}` } }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => (req.destroy(), resolve(false)))
    req.on('error', () => resolve(false))
  })
}

async function waitUp(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await reachable()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** The PATH a terminal would have (an app opened from Finder only gets /usr/bin:/bin). */
let shellPath = null
function loginPath() {
  if (shellPath) return shellPath
  const extra = [path.join(HOME, '.bun/bin'), path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  try {
    const out = execFileSync('/bin/zsh', ['-ilc', 'printf "__DECKPATH__%s" "$PATH"'], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const p = out.split('__DECKPATH__').pop().trim()
    if (p) shellPath = [...new Set([...p.split(':'), ...extra])].join(':')
  } catch {}
  return (shellPath ||= extra.join(':'))
}

function childEnv() {
  const env = { ...process.env, PATH: loginPath() }
  for (const k of Object.keys(env)) if (k.startsWith('ELECTRON_') || k === '__CFBundleIdentifier') delete env[k]
  return env
}

const bin = (name) => {
  const p = path.join(HOME, '.bun/bin', name)
  return fs.existsSync(p) ? p : name
}

function viteRunning() {
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' })
    return out.split('\n').some((l) => l.includes('vite build --watch') && l.includes(REPO))
  } catch {
    return false
  }
}

/** Start the deck the way it runs from a terminal: detached, so quitting this app leaves it running. */
function startServer() {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const env = childEnv()
  const run = (cmd, args, log) => {
    const fd = fs.openSync(path.join(LOG_DIR, log), 'a')
    const p = spawn(cmd, args, { cwd: REPO, env, detached: true, stdio: ['ignore', fd, fd] })
    p.unref()
    fs.closeSync(fd)
  }
  if (!viteRunning()) run(bin('bunx'), ['vite', 'build', '--watch'], 'vite.log')
  run(bin('bun'), ['--watch', 'server.ts'], 'server.log')
}

// ---------- window ----------

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'))
    // only reuse a position that is still on a connected display
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return s.x < a.x + a.width && s.x + s.width > a.x && s.y < a.y + a.height && s.y + s.height > a.y
    })
    return onScreen ? s : { width: s.width, height: s.height }
  } catch {
    return { width: 1440, height: 900 }
  }
}

let saveTimer = null
function saveState() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return
    try {
      fs.writeFileSync(STATE_FILE(), JSON.stringify(win.getNormalBounds()))
    } catch {}
  }, 300)
}

const onDeck = () => !!win && !win.isDestroyed() && win.webContents.getURL().startsWith(ORIGIN + '/')

async function login() {
  let token = ''
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch {}
  if (!token) return
  await session.defaultSession.cookies.set({
    url: ORIGIN,
    name: 'deck',
    value: token,
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
  })
}

async function openDeck() {
  if (!win) return
  if (await reachable()) {
    await login() // the server makes the token file on first start, so read it again each time
    await win.loadURL(ORIGIN + '/').catch(() => {})
  } else {
    await win.loadFile(OFFLINE).catch(() => {})
  }
}

/** Keys the deck wants, caught here so they work while the terminal has focus. */
function commandFor(input) {
  if (input.type !== 'keyDown') return null
  const { meta, control, alt, shift, code } = input
  if (control && !meta && !alt && code === 'Tab') return shift ? 'prev' : 'next'
  if (!meta || control || alt) return null
  if (shift) {
    // ⌘⇧[ / ⌘⇧], the Mac tab-switch keys
    if (code === 'BracketLeft') return 'prev'
    if (code === 'BracketRight') return 'next'
    return null
  }
  if (code === 'KeyN') return 'new'
  if (code === 'KeyW') return 'stop'
  if (code === 'KeyT') return 'shell'
  if (code === 'KeyK' || code === 'KeyP') return 'palette'
  if (code === 'BracketLeft') return 'prev'
  if (code === 'BracketRight') return 'next'
  if (/^Digit[1-9]$/.test(code)) return 'tab:' + code.slice(5)
  return null
}

const send = (cmd) => {
  if (onDeck()) win.webContents.send('deck', cmd)
}

function createWindow() {
  const s = readState()
  win = new BrowserWindow({
    ...s,
    minWidth: 720,
    minHeight: 480,
    title: 'Overvibe',
    backgroundColor: '#191920',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.on('resize', saveState)
  win.on('move', saveState)
  win.on('closed', () => (win = null))

  const wc = win.webContents
  wc.on('before-input-event', (e, input) => {
    if (!onDeck()) return
    const cmd = commandFor(input)
    if (!cmd) return // ⌘C, ⌘V and everything else go on as usual
    e.preventDefault()
    send(cmd)
  })

  // the window stays on the deck: other links open in the default browser
  const external = (url) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url)
  }
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith(ORIGIN + '/')) return
    e.preventDefault()
    external(url)
  })
  wc.on('will-redirect', (e, url) => {
    if (!url.startsWith(ORIGIN + '/')) e.preventDefault()
  })
  wc.setWindowOpenHandler(({ url }) => {
    external(url)
    return { action: 'deny' }
  })
  wc.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && url.startsWith(ORIGIN)) win.loadFile(OFFLINE).catch(() => {})
  })

  openDeck()
}

// ---------- IPC from the offline page ----------

const fromOffline = (e) => (e.senderFrame?.url ?? '').startsWith('file://')
ipcMain.handle('deck:retry', async (e) => {
  if (!fromOffline(e)) return false
  if (!(await reachable())) return false
  await openDeck()
  return true
})
ipcMain.handle('deck:start', async (e) => {
  if (!fromOffline(e)) return false
  if (!(await reachable())) startServer()
  if (!(await waitUp(30000))) return false
  await new Promise((r) => setTimeout(r, 800)) // let the first vite build land
  await openDeck()
  return true
})

// ---------- menu ----------

function buildMenu() {
  const item = (label, accelerator, cmd) => ({ label, accelerator, registerAccelerator: false, click: () => send(cmd) })
  const template = [
    {
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }],
    },
    {
      label: 'Session',
      submenu: [
        item('New Session', 'Cmd+N', 'new'),
        item('New Shell Here', 'Cmd+T', 'shell'),
        item('Close Session…', 'Cmd+W', 'stop'),
        { type: 'separator' },
        item('Quick Open', 'Cmd+K', 'palette'),
        item('Next Session', 'Ctrl+Tab', 'next'),
        item('Previous Session', 'Ctrl+Shift+Tab', 'prev'),
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    // no Close item: ⌘W stops the session in the deck; the red button still closes the window
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- app ----------

app.setName('Overvibe')
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (win) (win.isMinimized() && win.restore(), win.focus())
})

app.whenReady().then(() => {
  // the page needs the clipboard (OSC 52 copy, paste) and nothing else
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'])
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allowed.has(perm) && wc.getURL().startsWith(ORIGIN + '/')))
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => allowed.has(perm) && (origin || '').startsWith(ORIGIN))
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (!win) createWindow()
    else win.show()
  })
})

// quitting closes this window only: sessions keep running in tmux and the server keeps serving
app.on('window-all-closed', () => {})

// no other web content (popups, webviews) may load anything
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault())
})
