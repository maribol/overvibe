# Overvibe desktop

An Electron window on http://127.0.0.1:7777, so the keys Chrome keeps for itself reach the deck.
It serves and binds nothing: the deck server still runs on its own (`bun --watch server.ts` and
`bunx vite build --watch` in the repo).

## Run and build

```sh
bun run desktop         # from the repo root: dev run (installs desktop/ deps the first time)
bun run desktop:build   # packages ~/Applications/Overvibe.app (unsigned, this Mac only) and records
                        # this checkout in ~/.config/overvibe/repo so the app can start the server
```

Or inside `desktop/`: `bun install`, then `bun run start` / `bun run build`. `bun run icon` remakes
`build/icon.icns` from scratch (needs ImageMagick); the built icon is checked in.

## What it does

- Logs in by setting the `deck` cookie (HttpOnly, SameSite=Strict) from `~/.config/overvibe/token`
  before loading, so the token never goes in a URL. Window size and position are remembered.
- The window only navigates within http://127.0.0.1:7777; other links open in the default browser.
  The page runs with contextIsolation, sandbox and no Node. `preload.cjs` exposes one thing,
  `window.deckDesktop`, which `src/web/App.vue` listens to.
- If the deck doesn't answer, the window shows "Overvibe isn't running" with Start, which spawns
  the server and vite build detached from the repo (logs appended to `server.log` and `vite.log`
  in `~/.config/overvibe/logs`, or `logDir` in `~/.config/overvibe/config.json`), then opens the deck once it answers.
- ⌘Q quits the window only. Sessions keep running in tmux and the server keeps serving.

## Keys

Caught in the main process (`before-input-event`), so they work while the terminal has focus, and sent
to the page as the same actions the ⌥ shortcuts use:

| Key | Action |
| --- | --- |
| ⌘N | New session |
| ⌘W | Stop the open session (asks first, like ⌥W) |
| ⌘T | New shell in this folder |
| Ctrl+Tab / Ctrl+⇧Tab | Next / previous session in sidebar order |
| ⌘] / ⌘[ (also ⌘⇧] / ⌘⇧[) | Next / previous session |
| ⌘1 to ⌘9 | The Nth open tab |
| ⌘K, ⌘P | Quick open |

⌘C, ⌘V and everything else pass through unchanged. In a browser none of this applies; the ⌥ keys stay.
