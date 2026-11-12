# Overvibe

Claude Code, Codex and Gemini (agy) side by side, each one the real CLI, and an `overvibe` command that lets any of
them start another, hand it a job and get the answer back.

<p align="center">
  <a href="https://overvibe.dev"><img src=".github/assets/hero.gif" width="800" alt="Overvibe: Claude is asked for a second opinion, starts Codex by itself, and Codex's review lands back in Claude's terminal"></a>
</p>

<p align="center"><sub>A real run on a demo machine, waits sped up. <a href="https://elasticfunnels-cdn.b-cdn.net/581/assets/images/hero-ui-f5.mp4">Full-size video</a> · <a href="https://overvibe.dev">overvibe.dev</a></sub></p>

```sh
curl -fsSL https://overvibe.dev/install.sh | sh
```

- **Agents start and message each other.** From inside any session, `overvibe new --tool codex --prompt "..."`
  starts a helper, `overvibe send` passes the answer back, and it arrives in the starter's prompt with a header
  Overvibe writes itself, naming the checked sender. Claude Code, Codex and agy all speak it.
- **The real CLIs, in tmux.** Each session is the tool you already use, running in tmux and shown in your browser
  (or a small desktop app on macOS) with xterm.js. Slash commands, skills, hooks, auto mode and Remote Control
  work as they do in Terminal.
- **One window for all of them.** Sessions grouped by project, the ones that need you turn amber, a tool's choice
  menus become buttons, and a Stats view shows working time per tool, who's waiting on you and which agents
  message each other most.

<table>
  <tr>
    <td width="40%"><img src=".github/assets/stats.webp" alt="Stats view: sessions and working time per tool, sessions waiting on you, messages between agents, busiest projects and usage per account"></td>
    <td width="32%"><img src=".github/assets/messages.webp" alt="Messages view: what each session was told, with the header Overvibe writes on a peer's message"></td>
    <td width="28%"><img src=".github/assets/choice-prompt.webp" alt="A Claude choice menu shown as buttons, with a box for your own answer"></td>
  </tr>
</table>

**Runs on** macOS and Linux (tested on Debian and Ubuntu; other distros with tmux 3.2 or newer should work). Windows
works through WSL2, which hasn't been tried on real Windows hardware yet: see [Windows](#windows-use-wsl2).

**Security in brief.** The server listens on 127.0.0.1 only, wants a token on every request and checks Host and
Origin, because the page is a full shell on your computer. A message between agents carries a server-written header,
and a helper can never run looser than the session that started it. More at
[overvibe.dev/security](https://overvibe.dev/security) and in [Security](#security) below; to report a problem, see
[SECURITY.md](SECURITY.md).

**Defaults.** Auto mode is **off**: each tool asks before it edits files or runs commands, and you answer in
Overvibe. Turn it on in Settings > Auto mode or on the setup's Welcome step. An anonymous usage ping is **on**: once
a day, a random install id, the version, the OS and which CLIs are installed. Turn it off in Settings > Usage ping
or untick it on the Welcome step; nothing is sent before you have seen that step. [Details](#usage-ping).

**Docs:** [docs/index.html](docs/index.html), one static page with the install, the full `overvibe` reference, a
worked Claude to Codex example, accounts, shortcuts, the security model and a FAQ. Overvibe is made by the team
behind [ElasticFunnels](https://elasticfunnels.io).

## Agents working together

```sh
overvibe new --attach --tool codex --cwd ~/code/shop --name "shop: codex review" \
  --prompt "Review the migration. When done, run: overvibe send \"$OVERVIBE_SESSION\" \"<findings>\""
# end the turn; the findings arrive in this session's prompt as a new message, then:
overvibe stop "shop: codex review"
# later, the same conversation again for a follow-up (overvibe ls --past lists stopped ones):
overvibe resume "shop: codex review" --prompt "Does the index build still lock writes?"
```

`ov` is the short form where that name is free. `overvibe --help` lists every command; the bundled skill
[skills/overvibe/SKILL.md](skills/overvibe/SKILL.md) teaches agents to use them.

### Helpers in their own worktree

`overvibe new --worktree` starts the helper in its own git worktree, on a new branch `ov/<name>` from the folder's
HEAD, in `<repo>.worktrees/<name>` beside the repo, so parallel helpers never edit the same checkout. When it
stops, whoever started it gets the branch, its commit count, any uncommitted files and the merge command.
Overvibe never deletes a worktree or a branch; you (or the coordinator) merge and remove it.

```sh
overvibe new --attach --worktree --cwd ~/code/shop --name "shop: fix cart" \
  --prompt "Fix the cart total rounding and commit. When done, run: overvibe send \"$OVERVIBE_SESSION\" \"<summary>\""
```

### Messages between agents

Every session Overvibe starts gets its own secret (`OVERVIBE_PROOF`, next to `OVERVIBE_SESSION`), which
`overvibe` sends with every call. The server refuses a call that names a session without that session's secret, so
a helper can't speak as its coordinator by setting one variable. The server writes each message's header itself
(`[overvibe message from "<name>" (<tool>), sender checked by Overvibe; ...]`), defuses anything in the text that
looks like a header, and the header tells the receiving agent to treat a peer's message as information and
requests: deleting, force-pushing, deploying, paying or sending anything off the machine still needs your OK. A
message from a plain shell says the sender was not checked. This guards against a prompt-injected helper. It is no
wall between agents that all run as your user and can read each other's files.

Sessions that start sessions are capped at 3 levels deep and 8 running children per session by default (Settings >
Spawn limits), and `overvibe new` says which limit it hit. Sessions you start yourself are never capped.

## Install

One command, on macOS or Linux (on Windows, inside WSL2):

```sh
curl -fsSL https://overvibe.dev/install.sh | sh
```

Or read it first (one shell file):

```sh
curl -fsSLo install.sh https://overvibe.dev/install.sh; less install.sh; sh install.sh
```

It checks for Bun and tmux and offers to install what is missing (it asks first and never runs sudo), puts the app
in `~/.overvibe/app`, builds it, links `overvibe` (and `ov`, if free) into `~/.local/bin`, and adds a login service
that runs the server on http://127.0.0.1:7777: a launchd agent on macOS
(`~/Library/LaunchAgents/dev.overvibe.server.plist`), a systemd user unit on Linux
(`~/.config/systemd/user/overvibe.service`). Then it opens the page already logged in and says which of `claude`,
`codex` and `agy` it found. It installs the newest release tag (main while there is none) and prints the version;
run it again to update. A failed step (git fetch, `bun install`, the build) stops it, and so does a port held by
something other than Overvibe.

Options: `--ref <tag|branch>`, `--dir <folder>`, `--port <n>`, `--no-service` (start the server without a login
service, and remove one an earlier install left), `--yes` (install missing tools and add `~/.local/bin` to PATH
without asking). `sh install.sh --help` lists them.

Afterwards:

```sh
overvibe open        # the page, logged in (starts the server if it is down)
overvibe up          # start the server     overvibe down   stop it (sessions keep running in tmux)
overvibe doctor      # check bun, tmux, the build, the CLI links, the login service, the server, the CLIs
overvibe update      # the newest release: fetch, build, restart (the app's sidebar offers it when one is out)
overvibe uninstall   # remove the login service and the CLI links; sessions, transcripts and ~/.config/overvibe stay
```

### Requirements

[Bun](https://bun.sh), tmux, git and Claude Code. Codex and agy are optional.

- **macOS**: tmux from Homebrew (`brew install tmux`). The installer offers Homebrew for Bun and tmux.
- **Linux**: tmux 3.2 or newer from your package manager (`sudo apt install tmux`, `sudo dnf install tmux`,
  `sudo pacman -S tmux`). As a normal user the installer prints that command and stops, since it never runs sudo;
  run as root, it offers to run it. Bun comes from its official installer into `~/.bun` (it needs `unzip`). Without
  a systemd user session the server starts in the background and does not come back after a restart: run
  `overvibe up`. Copying from the terminal also fills the system clipboard when `wl-copy`, `xclip` or `xsel` is
  installed. The desktop app is macOS only; on Linux you use the page in your browser.
- **Windows**: WSL2 only, since native Windows has no tmux.

### Windows: use WSL2

Overvibe runs inside WSL2's Linux and you use it from a Windows browser. The server still listens on 127.0.0.1
only: WSL2 forwards Windows' localhost to it. These steps follow WSL's documented behaviour and haven't been run on
a real Windows machine yet; reports are welcome.

1. In PowerShell (as administrator, once): `wsl --install -d Ubuntu`, then restart Windows if it asks.
2. Open Ubuntu from the Start menu and create your Linux user.
3. For the server to start by itself, WSL needs systemd (recent Ubuntu images have it on: `systemctl --user status`
   answers). If it is off, run `sudo nano /etc/wsl.conf`, add these two lines, save, then run `wsl --shutdown` in
   PowerShell and open Ubuntu again:
   ```ini
   [boot]
   systemd=true
   ```
   Without it the installer starts the server in the background, and `overvibe up` starts it again after WSL
   restarts.
4. In Ubuntu: `sudo apt update && sudo apt install -y tmux git unzip curl`
5. Install Claude Code inside Ubuntu (`curl -fsSL https://claude.ai/install.sh | bash`) and log in there. The
   Windows copy of Claude Code has a separate login.
6. Run the installer in Ubuntu: `curl -fsSL https://overvibe.dev/install.sh | sh`. It opens the page in your
   Windows browser (with `wslview` if installed, else `explorer.exe`); if nothing opens, run `overvibe open`.

Keep projects in the Linux file system (`~/code/...`) rather than under `/mnt/c`: tmux, git and the agents are much
faster there, and the folder search starts in your Linux home. WSL can stop a distro a while after its last window
closes, which stops the sessions too, so keep one Ubuntu window open while you work. If `http://127.0.0.1:7777`
does not load in Windows, check that `localhostForwarding` is not set to false in `%UserProfile%\.wslconfig`.

### Manual install

Needs the requirements above.

```sh
git clone https://github.com/maribol/overvibe overvibe && cd overvibe
bun install
bun run dev                                   # UI build watcher + server on http://127.0.0.1:7777
open "$(cat ~/.config/overvibe/login-url)"  # log in once (Linux: xdg-open; the link holds your token: keep it private)
bun run install-cli                           # overvibe (and ov, if free) into ~/.local/bin
```

From a clone, `sh install.sh` does the same as the one command but uses the clone in place.

Desktop app, macOS only, so ⌘N, ⌘T and ⌘W reach Overvibe instead of the browser: `bun run desktop`, or
`bun run desktop:build` for an unsigned `~/Applications/Overvibe.app`. See [desktop/README.md](desktop/README.md).

## Skills

One skills library for all three CLIs. Overvibe keeps it in `~/.config/overvibe/skills/<name>/SKILL.md`
(plus the skills it ships in `skills/`) and links each skill into Claude Code (`~/.claude/skills`), Codex
(`~/.codex/skills`) and agy (`~/.gemini/config/skills`) when the server starts and whenever the library changes.

```sh
overvibe skills ls                          # the library, where each skill goes, clashes
overvibe skills add ./my-skill              # copy a skill folder into the library (--tools, --project)
overvibe skills import claude my-skill      # a skill one CLI already has, for all of them (--replace swaps it for a link)
overvibe skills remove my-skill             # unlink it everywhere; the library copy stays unless --purge --yes
overvibe new --cwd ~/code/app --tool codex --skill my-skill --prompt "..."   # hand a skill to the new session
```

Two optional keys in a skill's frontmatter narrow where it goes: `tools: [claude, codex]` and
`projects: [~/code/app]` (then it goes into that folder's project-level skill folder instead of everywhere).
Overvibe only touches the links and copies it made, listed in `~/.config/overvibe/skills-manifest.json`; a skill
a CLI already has under the same name is reported as a clash and left alone. Settings > Skills shows all of it.

Shipped skills: `overvibe` (how agents use the `overvibe` command), `tasks` (below) and `elasticfunnels`, an
optional integration with the ElasticFunnels `ef` CLI for building and publishing landing pages, funnels and sites.
It is on by default: untick it on the setup's Welcome step, or switch it off in Settings > Skills or with
`overvibe skills off elasticfunnels`.

### Task list per project

The shipped `tasks` skill has agents write every request into the project's `TASKS.md` before they start on it,
so none gets lost when messages pile up or the context is compacted. They tick a line only once it is verified and
put what only you can do under "Waiting on the owner"; the Tasks view shows every project's list. It is on by
default (the Welcome step asks), and agents use the CLI for the ids:

```sh
overvibe tasks add "Fix the login button"   # a line under To do with a new id (T1112-3), the date and the session
overvibe tasks id                           # only the next free id for today
overvibe tasks check                        # ticked outside Done, missing or duplicate ids, ticks without a check
```

## Terminal links

Overvibe underlines what you would want to open in a session's terminal: web addresses (with or without
https://, and local servers like `localhost:5173`), file paths and bare file names (⌘-click opens them, hovering shows a preview), a `/compact` an agent
suggests, Reddit names (`r/ClaudeCode`, `u/name`), npm packages (`@scope/name`, and the names after `npm i`,
`bun add`, `pnpm add`, `yarn add`), GitHub references (`owner/repo#12`; `PR #12` or `(#12)` when the folder's remote
is on GitHub), commit shas the folder's repo has (opened on GitHub, or copied), and task ids like `T1112-3` (they
open the Tasks view on that line). Right-click a link to see where it goes; hovering shows a card with the same,
and never loads the page.

Add your own in `~/.config/overvibe/links.json`:

```json
[
  { "name": "Jira", "pattern": "\\b[A-Z]{2,6}-\\d{1,6}\\b", "url": "https://acme.atlassian.net/browse/$0", "label": "Open $0 in Jira" }
]
```

`pattern` is a JavaScript regular expression (optional `"flags": "i"`), `url` must start with http:// or https://,
`$0` is the whole match and `$1` to `$9` its groups; `label` is the right-click menu's text. Your links are tried
after full web addresses and before the built-in kinds. An entry that does not compile, can run for a very long time
(a repeated group holding a repeat, like `(a+)+`), or matches empty text is skipped with a line in the server log
and in Settings > Terminal links; a pattern that takes over 25 ms on one line is turned off until the page reloads.

## Usage ping

On by default; turn it off in Settings > Usage ping, or untick the box on the setup's Welcome step (nothing is sent
before you have seen it). Once off, it stays off. Once a day the server sends one ping so the makers can count how
many people open Overvibe. It holds:

- a random install id made on your computer (kept in `~/.config/overvibe/usage-ping.json`);
- the Overvibe version;
- the OS and its version ("macos 15.5", "linux debian 12", "wsl ubuntu 24.04"; on a Mac also the macOS version on
  its own);
- yes or no for whether Claude Code, Codex and agy are installed.

No paths, names, emails, host names, sessions or prompts. It goes to an ElasticFunnels form on overvibe.dev, which,
like any web request, also sees your IP address and stores it with the entry. A failed send is dropped quietly.

## Security

The server binds 127.0.0.1 only, needs the token on every request, and checks Host and Origin. The page is a full
shell on your computer, so never expose it to a network; that holds on Linux and in WSL2 too. To report a
vulnerability, see [SECURITY.md](SECURITY.md).

Each session has a permission mode, picked in New session. The default comes from Settings > Auto mode ("Start new
sessions in auto mode", also asked on the setup's Welcome step), which is **off** on a new install. Set it per folder
there or with `"mode"` in deck.json, or for one session with `overvibe new --auto`, `--no-auto` or `--mode ask|auto`:

- **ask** (auto mode off): the tool's own approval prompts. Claude Code `--permission-mode manual`, Codex
  `-a on-request -s workspace-write` (its stock sandbox: session folder only, no network), agy with no `--mode`.
  Each request turns the row amber and pops up in Overvibe for you to allow or refuse.
- **auto**: each tool's auto mode. Claude Code `--permission-mode auto`, Codex `--approve-for-me` with network on
  and your work root writable, agy `--mode auto`. Commands and edits run without asking.

A helper is never more permissive than the session that started it: a session in ask mode can only start helpers
in ask mode (the server refuses `--auto` from it) and can't open a plain terminal. Details in the
[docs](docs/index.html#security) and at [overvibe.dev/security](https://overvibe.dev/security).

### tmux guard

Inside a session, `$TMUX` points at Overvibe's own tmux server, so a plain `tmux` would reach every session. Agents
should use `overvibe peek`, `send`, `ls`, `open` and `stop` instead, and every session Overvibe starts has a small
`tmux` script first on PATH (`~/.config/overvibe/shim/tmux`) to hold them to it. On Overvibe's server it refuses
the commands that drive sessions (capture-pane, send-keys, list-sessions, attach and switch-client, kill-*,
new-session, split-window and the like) and prints the overvibe command to use. Everything else goes to the real
tmux unchanged: other tmux servers, and the calls Claude Code and Codex make for the clipboard and terminal
passthrough (load-buffer, display-message, show-options). zsh login shells rebuild PATH (macOS's path_helper,
`brew shellenv`), so sessions also get `ZDOTDIR` on wrappers in `shim/zsh` that run your own `.zshenv`,
`.zprofile`, `.zshrc` and `.zlogin` and then put the script first again; your files stay where they are. To let
one refused call through, run it with `OVERVIBE_RAW_TMUX=1`.

## Thanks

Overvibe was built with [Claude Code](https://claude.com/claude-code), and most of its code was written in Claude
Code sessions running inside Overvibe itself. Thank you to the Claude Code team at Anthropic for a tool good enough
to build its own control room with. Thanks also to the teams behind Codex and Gemini CLI, and to tmux, Bun and
xterm.js, which do the heavy lifting underneath.
