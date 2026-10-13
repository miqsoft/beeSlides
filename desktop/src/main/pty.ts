// A GUI-launched Electron app (opened via Finder/Dock, or any packaged
// build) inherits macOS's minimal default PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// which excludes Homebrew's /opt/homebrew/bin — a bare `spawn('claude', ...)`
// from the main process would ENOENT even though `claude` is a real,
// installed binary. Fix: capture the user's real login-shell environment
// once and use IT for the pty's env, never `process.env` as Electron sees it.
import { spawn as spawnPty, type IPty } from 'node-pty'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { ensureClaudeTrust, claudeJsonPath } from './claudeTrust.ts'
import { isChatId } from './chathistory.ts'
import { ADD_DIR_ENV_PREFIX, claudeLaunchCommand, DECK_DIR_ENV, type ClaudeChat } from './claudeLaunch.ts'
import { isValidCommand, resolveEnv, referencedVars, type ClaudeCodeProfile } from './aiprofiles.ts'

export type { ClaudeChat }

let cachedEnv: Record<string, string> | null = null

function userShell(): string {
  return process.env.SHELL || (platform() === 'win32' ? 'powershell.exe' : '/bin/zsh')
}

/** Resolves the user's real PATH/env once via `$SHELL -ilc env` (login +
 *  interactive, so profile files that only run interactively still apply),
 *  and caches the parsed result. */
export function loginShellEnv(): Promise<Record<string, string>> {
  if (cachedEnv) return Promise.resolve(cachedEnv)
  if (platform() === 'win32') {
    cachedEnv = { ...process.env } as Record<string, string>
    return Promise.resolve(cachedEnv)
  }
  return new Promise((resolve) => {
    const child = spawn(userShell(), ['-ilc', 'env'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.setEncoding('utf8') // decodes across chunk boundaries (multi-byte values)
    child.stdout.on('data', (chunk: string) => { out += chunk })
    child.on('error', () => {
      cachedEnv = { ...process.env } as Record<string, string>
      resolve(cachedEnv)
    })
    child.on('exit', () => {
      const env: Record<string, string> = {}
      for (const line of out.split('\n')) {
        const i = line.indexOf('=')
        if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
      }
      // A shell that failed to produce any output (bad profile, etc.) still
      // needs SOME env to spawn into — fall back to what we already have.
      cachedEnv = Object.keys(env).length > 0 ? env : ({ ...process.env } as Record<string, string>)
      resolve(cachedEnv)
    })
  })
}

/** Values of login-shell variables by name. Exported ones are in
 *  `loginShellEnv()`; a variable the user's rc files set WITHOUT `export`
 *  (e.g. an `. ~/.config/x/key.env` that only assigns) is not, so the rest are
 *  asked of an interactive login shell directly. Names are validated by the
 *  caller (isValidEnvName), so they are safe inside the command. */
export async function shellVars(names: string[]): Promise<Record<string, string>> {
  const env = await loginShellEnv()
  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const n of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) continue
    if (env[n] !== undefined) out[n] = env[n]
    else missing.push(n)
  }
  if (missing.length === 0 || platform() === 'win32') return out
  const script = missing.map((n) => `printf '%s\\0' "\${${n}-}"`).join('; ')
  const text = await new Promise<string>((resolve) => {
    const child = spawn(userShell(), ['-ilc', script], { stdio: ['ignore', 'pipe', 'ignore'] })
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { buf += c })
    child.on('error', () => resolve(''))
    child.on('exit', () => resolve(buf))
  })
  const parts = text.split('\0')
  missing.forEach((n, i) => { if (parts[i]) out[n] = parts[i] })
  return out
}

export interface PtyHandle {
  onData(cb: (data: string) => void): () => void
  onExit(cb: (code: number | null) => void): () => void
  write(data: string): void
  resize(cols: number, rows: number): void
  dispose(): void
}

/** Spawns a real interactive login SHELL as the pty's direct child (not
 *  `claude` itself, so exiting Claude Code drops back to an ordinary working
 *  shell instead of killing the pane), pre-accepting its one-time
 *  per-directory trust prompt and auto-launching Claude Code in `cwd`.
 *
 *  The launch is baked into the shell's OWN startup invocation (`-c`) rather
 *  than typed into an already-spawned interactive shell after guessing it's
 *  ready — an earlier version wrote the launch line on the pty's first
 *  `onData` chunk, which raced a login shell's MOTD/profile-init noise
 *  (oh-my-zsh, powerlevel10k instant-prompt, nvm/direnv hooks, etc.): the pty
 *  echoes typed characters regardless of whether the shell is actually
 *  reading them as input yet, so the line could render visibly but never run
 *  ("text appears, nothing happens"). `-c` guarantees the shell finishes
 *  sourcing its profile/rc files (still with `-i`, so interactive-only rc
 *  sections still load — same `-i`+`-c` combo `loginShellEnv` above already
 *  relies on) BEFORE running our command, so there is no race and nothing to
 *  time or poll for. Appending `exec <shell> -li` once Claude exits keeps the
 *  documented fall-back-to-an-ordinary-shell behavior without leaving a
 *  dangling `-c` subshell.
 *
 *  `initialTask`, when given, is appended as one more positional argument on
 *  the same launch line — `claude` starts working it immediately, still
 *  inside a normal, fully interactive session the user can keep talking to.
 *
 *  `sharedDirName`/`sessionDirName` are both relative to `cwd` — see
 *  `claudeInstruction`'s header comment for what lives in each. One `claude`
 *  process (one pty) per call: terminalPanel.ts calls this once per session
 *  tab, all sharing the same `cwd` (the deck's managed workspace, workspaces.ts) but
 *  each with its own `sessionDirName`. `deckDir`, for a saved deck, is the
 *  deck's own folder, granted via `--add-dir` (not made the project);
 *  `extraDirs` are the folders the user attached (attachedfolders.ts), each
 *  granted the same way. */
export async function createPty(
  cwd: string, sharedDirName: string, sessionDirName: string, chat: ClaudeChat, cols = 80, rows = 24, initialTask?: string, deckDir?: string, profile?: ClaudeCodeProfile, extraDirs: string[] = [],
): Promise<PtyHandle> {
  if (!isChatId(chat.id)) throw new Error('invalid conversation id')
  // Never inherit these: CLAUDE.md from --add-dir folders must stay unloaded,
  // and a stale deck dir from the user's shell must not leak in.
  const env = { ...(await loginShellEnv()) }
  delete env['CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD']
  delete env[DECK_DIR_ENV]
  if (deckDir) env[DECK_DIR_ENV] = deckDir
  for (const k of Object.keys(env)) if (k.startsWith(ADD_DIR_ENV_PREFIX)) delete env[k]
  extraDirs.forEach((d, i) => { env[`${ADD_DIR_ENV_PREFIX}${i + 1}`] = d })
  // The profile's env travels only in the pty env, never in the command string.
  const command = profile?.command ?? 'claude'
  if (!isValidCommand(command)) throw new Error('invalid claude command')
  if (profile?.env) {
    const vars = await shellVars(referencedVars(profile.env))
    Object.assign(env, resolveEnv(profile.env, (n) => vars[n]))
  }
  if (profile?.configDir) env['CLAUDE_CONFIG_DIR'] = profile.configDir
  const shell = userShell()
  const plat = platform()
  if (plat !== 'win32') ensureClaudeTrust(cwd, profile?.configDir ? claudeJsonPath(profile.configDir) : undefined)

  // Windows: powershell.exe's `-NoExit -Command` is the equivalent
  // one-shot-then-fall-back-to-interactive idiom. No --append-system-prompt/
  // --mcp-config quoting has been worked out for it (this repo ships no
  // Windows build yet) — keep the bare launch, just no longer racing a typed
  // command against shell startup.
  const args = plat === 'win32'
    ? ['-NoExit', '-Command', command]
    : ['-lic', `${claudeLaunchCommand(sharedDirName, sessionDirName, chat, initialTask, !!deckDir, command, extraDirs.length)}; exec '${shell}' -li`]

  const pty: IPty = spawnPty(shell, args, { name: 'xterm-256color', cwd, env, cols, rows })

  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(code: number | null) => void>()

  pty.onData((data) => {
    for (const cb of dataListeners) cb(data)
  })
  let exited = false
  pty.onExit(({ exitCode }) => {
    exited = true
    for (const cb of exitListeners) cb(exitCode)
  })

  return {
    onData: (cb) => { dataListeners.add(cb); return () => dataListeners.delete(cb) },
    onExit: (cb) => { exitListeners.add(cb); return () => exitListeners.delete(cb) },
    write: (data) => { if (!exited) try { pty.write(data) } catch { /* pty closed under us */ } },
    // A resize racing the shell's exit (panel resize, or a tab torn down)
    // hits a closed pty fd: node-pty throws ENOTTY synchronously, which as an
    // uncaught main-process exception killed the whole app.
    resize: (c, r) => {
      if (exited) return
      try { pty.resize(Math.max(1, c), Math.max(1, r)) } catch { /* pty closed under us */ }
    },
    dispose: () => {
      try { pty.kill() } catch { /* already gone */ }
    },
  }
}
