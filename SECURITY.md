# Security policy

## Reporting a vulnerability

Please report it privately through GitHub: on [github.com/maribol/overvibe](https://github.com/maribol/overvibe),
open the **Security** tab and click **Report a vulnerability**. Only the maintainer sees the report, and the fix
and an advisory can be worked out in the same thread.

Please don't open a public issue or pull request for a security problem until a fix is out.

A useful report says which version you ran (`overvibe doctor` prints it), your OS, the steps to reproduce, and
what an attacker gains. A proof of concept helps but isn't required.

## Supported versions

Only the latest release gets security fixes. If you installed with `curl -fsSL https://overvibe.dev/install.sh | sh`,
running it again updates you to it.

## What's in scope

Overvibe gives whoever holds its page a full shell as your user, so anything that lets someone else reach it, or
lets an agent get past a limit Overvibe sets, is in scope:

- **The local server**: it should listen on 127.0.0.1 only. Anything that makes it reachable from another
  machine, or from a web page you visit, counts.
- **The token**: every HTTP and WebSocket request needs it. A way to call the API without it, to read it from
  outside your user account, or to leak it into a log, a URL another site can see, or a usage ping.
- **The Host and Origin checks**: DNS rebinding, a cross-site request or WebSocket that gets through, or a Host or
  Origin value that should be refused and isn't.
- **The `overvibe` CLI**: a command that does more than its help says, for example `overvibe stop` from inside a
  session reaching a session it didn't start, or `--mkdir` creating a folder outside your home.
- **Peer messages and the sender check**: speaking as another session without its `OVERVIBE_PROOF`, a message
  whose text passes for a header Overvibe wrote, or a forged "sender checked" line.
- **The auto mode cap**: a session running with auto mode off starting a helper in auto mode or a plain terminal,
  or a resume or fork that ends up looser than its starter. The spawn limits (depth and running children) count
  here too.
- **The installer** (`install.sh`): running sudo, writing outside the folders it names, or installing something
  other than what it fetched from the repo.
- **The usage ping**: sending anything beyond what the README lists.

## What's out of scope

- **What the agents do with your permissions.** Claude Code, Codex and agy run as your user and can read your
  files, run commands and use your logins, more so in auto mode. A prompt-injected agent deleting files or pushing
  code is the agent's own risk, which you accept by running it. Overvibe's header and caps make that harder; they
  are not a sandbox between agents that share one user account.
- Bugs in Claude Code, Codex, agy, tmux, Bun or Electron themselves. Please report those to their makers.
- Someone who already runs code as your user, or has your token, doing what you could do.
- Exposing the server on purpose (a tunnel, a reverse proxy, binding another interface). The page is a shell, and
  the docs say never to do that.
- The tmux guard. It steers agents to the `overvibe` commands and lets a call through with `OVERVIBE_RAW_TMUX=1` by
  design, so getting around it is expected.
- The overvibe.dev website. Report problems with it the same way, but they are handled separately from the app.

## What to expect

Overvibe has one maintainer, so please be patient. I aim to acknowledge a report within a week and to tell you
then whether I can reproduce it and roughly when a fix could land. Serious issues come first. Once a fix ships,
it gets a GitHub security advisory, and I'm glad to credit you there unless you'd rather stay anonymous.
