// The first-run setup's extras [T1110-67]: is the overvibe CLI on PATH (and install it with the repo's own
// scripts/install-cli.sh), is the desktop app built (and open it). The desktop app is Mac only, so off a Mac
// `mac` is false and the page leaves its card out [T1111-8].
import { existsSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { HOME, cleanEnv, tildify } from './env'
import { IS_MAC } from './platform'

const REPO = resolve(import.meta.dir, '..')
const DESKTOP_APP = join(HOME, 'Applications', 'Overvibe.app')

/** the PATH a login shell would have: the server's own, plus ~/.local/bin where install-cli links */
const which = (name: string) => Bun.which(name, { PATH: `${process.env.PATH ?? ''}:${join(HOME, '.local', 'bin')}` })

export function extras() {
  const cli = which('overvibe')
  const ov = which('ov')
  let ovOurs = false
  try {
    ovOurs = !!ov && readlinkSync(ov).startsWith(join(REPO, 'bin'))
  } catch {}
  return { cli: cli ? tildify(cli) : null, ov: ov ? tildify(ov) : null, ovOurs, desktop: IS_MAC && existsSync(DESKTOP_APP) ? tildify(DESKTOP_APP) : null, mac: IS_MAC }
}

export async function installCli(): Promise<{ out: string }> {
  const p = Bun.spawn(['bash', join(REPO, 'scripts', 'install-cli.sh')], { stdout: 'pipe', stderr: 'pipe', env: cleanEnv() })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  if ((await p.exited) !== 0) throw new Error(err.trim() || 'install-cli failed')
  return { out: out.trim() }
}

export async function openDesktop() {
  if (!IS_MAC) throw new Error('the desktop app is for macOS only; use the page in your browser')
  if (!existsSync(DESKTOP_APP)) throw new Error('the desktop app is not built yet: bun run desktop:build')
  await Bun.spawn(['open', DESKTOP_APP]).exited
  return { ok: true }
}
