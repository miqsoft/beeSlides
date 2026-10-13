#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// One command to run the full app stack for hands-on testing.
//
//   node scripts/dev-all.mjs     (run from slidomingo/; `npm run dev`)
//
// Starts, in order: the slides dev server, then the desktop Electron
// shell — waited to start second because createDocumentWindow() loads
// slides' dev URL immediately on boot, and starting it before slides is
// actually accepting connections would just show a connection-refused page.
//
// This is deliberately NOT folded into .claude/launch.json — that file
// holds per-app single-process launch configs, not a multi-process stack.
//
// Lifecycle — the stack lives and dies as one:
//
// - Preflight: every unpackaged run shares one userData folder
//   ('slidomingo-desktop'), and Electron's single-instance lock makes a
//   second instance focus the first and quit silently. So if an unpackaged
//   instance already holds that lock (a stray from an earlier run, a branch
//   build started with `npx electron .`), refuse to start rather than
//   launch into it and end up driving someone else's window. The running
//   app is never touched.
// - The desktop app exiting for any reason (⌘Q, or closing the last window
//   — desktop gets SLIDOMINGO_DEV_ALL=1, which makes window-all-closed quit
//   on macOS too) stops slides and ends this script. An exit right after
//   launch is reported as the lock collision it almost certainly is.
// - slides exiting on its own stops desktop too; the app can't load without it.
// - Ctrl+C (or a TERM, or closing the terminal) stops the stack and WAITS until
//   every group is really empty. Electron's main process is TERMed on its own
//   (see shutdown()) so its quit can run the flush protocol, which may sit on
//   a "couldn't be saved" box; slides' group is TERMed right away. After
//   GRACE_MS the stragglers are SIGKILLed and named; a second Ctrl+C kills at
//   once. Exit code is non-zero if anything had to be killed. Each child is
//   spawned in its own process group (`detached: true`) so this reaches
//   children-of-children (npm → electron-vite → Electron → helpers), not
//   just the immediate child.

import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { connect } from 'node:net'
import { readlinkSync } from 'node:fs'
import { homedir } from 'node:os'

const slidomingoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const SLIDES_DIR = join(slidomingoRoot, 'slides')
const DESKTOP_DIR = join(slidomingoRoot, 'desktop')
const SLIDES_HOST = '127.0.0.1'
const SLIDES_PORT = 5199
const GRACE_MS = 8_000
// A desktop exit this soon after launch is (almost always) the single-instance
// lock bouncing it; a real session lasts longer than electron-vite's startup.
const EARLY_EXIT_MS = 5_000
// Printed by desktop/src/main/index.ts when an unpackaged run loses the lock.
const LOCK_MARKER = 'another instance with this userData is running'

// Mirrors desktop/src/main/index.ts: SLIDOMINGO_USER_DATA (inherited by the
// desktop child) overrides; otherwise the pinned unpackaged folder.
const USER_DATA = process.env.SLIDOMINGO_USER_DATA || join(
  process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'slidomingo-desktop',
)

const lockMessage = (outcome) =>
  `another BeeSlides dev instance is already running (single-instance lock on userData '${USER_DATA}'); ` +
  `${outcome}. Quit it (⌘Q) and run npm run dev again.`

const children = []

function log(msg) {
  console.log(`[dev-all] ${msg}`)
}

function prefixLines(label, chunk, out, onLine) {
  const text = chunk.toString('utf8')
  const lines = text.split('\n')
  // A trailing '' from the split means the chunk ended on a newline — drop it
  // so we don't print a bare, empty prefixed line for every complete chunk.
  if (lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) {
    out.write(`[${label}] ${line}\n`)
    onLine?.(line)
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// Chromium's lock is a symlink `SingletonLock -> <hostname>-<pid>` that
// outlives a crashed holder, so a stale link is fine: only a live Electron
// pid counts. (No symlink on Windows — nothing to check there.)
function findLockHolder() {
  if (process.platform === 'win32') return null
  let target
  try {
    target = readlinkSync(join(USER_DATA, 'SingletonLock'))
  } catch {
    return null
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1])
  if (!pid || !isAlive(pid)) return null
  let command = ''
  try {
    command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
  // Guard against pid reuse: the holder has to actually be an Electron.
  return /electron/i.test(command) ? { pid, command } : null
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// The desktop group's Electron main process, i.e. the lock holder, if it's ours.
function electronMainOf(entry) {
  const holder = findLockHolder()
  if (!holder) return null
  try {
    const pgid = Number(execFileSync('ps', ['-p', String(holder.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim())
    return pgid === entry.child.pid ? holder.pid : null
  } catch {
    return null
  }
}

function killGroup(entry, signal) {
  try {
    // Negative pid = the whole process group (requires detached: true).
    process.kill(-entry.child.pid, signal)
  } catch (err) {
    if (err.code !== 'ESRCH') console.error(`[${entry.label}] failed to ${signal} process group:`, err.message)
  }
}

// Done = the immediate child has exited AND nothing is left in its group
// (npm exiting doesn't mean the Electron it started below it has).
function isGone(entry) {
  return entry.exited && !groupAlive(entry.child.pid)
}

function run(label, command, args, cwd, { env, onExit, onLine } = {}) {
  const child = spawn(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    detached: true, // own process group, so we can kill children-of-children on teardown
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const entry = { label, child, exited: false, startedAt: Date.now() }
  child.stdout.on('data', (chunk) => prefixLines(label, chunk, process.stdout, onLine))
  child.stderr.on('data', (chunk) => prefixLines(label, chunk, process.stderr, onLine))
  child.on('exit', (code, signal) => {
    entry.exited = true
    console.log(`[${label}] exited (${signal ?? code})`)
    onExit?.(entry, code, signal)
  })
  children.push(entry)
  return entry
}

function waitForPort(host, port, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    function attempt() {
      if (shuttingDown) return reject(new Error('stopped while waiting for slides'))
      const socket = connect({ host, port }, () => {
        socket.destroy()
        resolve()
      })
      socket.on('error', () => {
        socket.destroy()
        if (Date.now() > deadline) {
          reject(new Error(`timed out waiting for ${host}:${port}`))
        } else {
          setTimeout(attempt, intervalMs)
        }
      })
    }
    attempt()
  })
}

let shuttingDown = false
let forceKill = null
let firstSignalAt = 0

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  const live = children.filter((e) => !isGone(e))
  if (live.length) log(`${reason} — stopping ${live.map((e) => e.label).join(', ')}...`)
  // Electron gets its SIGTERM alone: it quits through before-quit (the flush
  // protocol) and takes its helpers down itself. A group-wide TERM would also
  // kill its GPU/network/renderer helpers out from under that flush, and the
  // main process then hangs until SIGKILL. The rest of its group (npm,
  // electron-vite) is TERMed once Electron is gone.
  const pending = []
  for (const entry of live) {
    const electron = entry.label === 'desktop' ? electronMainOf(entry) : null
    if (electron) {
      process.kill(electron, 'SIGTERM')
      pending.push({ entry, electron })
    } else {
      killGroup(entry, 'SIGTERM')
    }
  }

  let killed = []
  const forced = new Promise((resolve) => { forceKill = resolve })
  const deadline = Date.now() + GRACE_MS
  while (children.some((e) => !isGone(e))) {
    for (const p of pending) {
      if (!p.done && !isAlive(p.electron)) {
        p.done = true
        killGroup(p.entry, 'SIGTERM')
      }
    }
    const timedOut = Date.now() >= deadline
    const now = await Promise.race([
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
      forced.then(() => true),
    ])
    if (now || timedOut) {
      killed = children.filter((e) => !isGone(e))
      log(`${now ? 'forced' : `still running after ${GRACE_MS / 1000}s`} — SIGKILL ${killed.map((e) => e.label).join(', ')}`)
      for (const entry of killed) killGroup(entry, 'SIGKILL')
      // SIGKILL can't be refused; just give the kernel a moment to reap.
      const reapBy = Date.now() + 2_000
      while (children.some((e) => !isGone(e)) && Date.now() < reapBy) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      break
    }
  }
  const leftover = children.filter((e) => !isGone(e))
  if (leftover.length) log(`could not stop: ${leftover.map((e) => `${e.label} (pgid ${e.child.pid})`).join(', ')}`)
  process.exit(killed.length || leftover.length ? 1 : exitCode)
}

function onSignal(signal) {
  if (!shuttingDown) {
    firstSignalAt = Date.now()
    void shutdown(`received ${signal}`)
    return
  }
  // npm relays the terminal's SIGINT to us, so one Ctrl+C can arrive twice
  // within milliseconds — only a later, deliberate second press forces.
  if (Date.now() - firstSignalAt > 500) forceKill?.()
}

process.on('SIGINT', () => onSignal('SIGINT'))
process.on('SIGTERM', () => onSignal('SIGTERM'))
// Closing the terminal window: SIGHUP, and our own stdout/stderr go away. By
// default either would kill this script outright and orphan the (detached)
// stack, so both tear it down like a Ctrl+C — without a terminal to log to.
process.on('SIGHUP', () => onSignal('SIGHUP'))
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err.code !== 'EPIPE') throw err
    void shutdown('output closed')
  })
}

const holder = findLockHolder()
if (holder) {
  console.error(`[dev-all] ${lockMessage('not launching into it')}`)
  console.error(`[dev-all]   holder: pid ${holder.pid} — ${holder.command}`)
  process.exit(1)
}

console.log('slidomingo dev-all: starting slides + desktop\n')

run('slides', 'npm', ['run', 'dev', '--', '--host', SLIDES_HOST, '--port', String(SLIDES_PORT), '--strictPort'], SLIDES_DIR, {
  onExit: () => {
    if (!shuttingDown) void shutdown('slides exited', 1)
  },
})

try {
  await waitForPort(SLIDES_HOST, SLIDES_PORT)
  log(`slides dev server is up on ${SLIDES_HOST}:${SLIDES_PORT}, launching desktop`)
  let sawLockMarker = false
  run('desktop', 'npm', ['run', 'dev'], DESKTOP_DIR, {
    env: { SLIDOMINGO_DEV_ALL: '1' },
    onLine: (line) => { if (line.includes(LOCK_MARKER)) sawLockMarker = true },
    onExit: (entry) => {
      if (shuttingDown) return
      if (sawLockMarker || Date.now() - entry.startedAt < EARLY_EXIT_MS) {
        console.error(`[dev-all] ${sawLockMarker ? '' : 'desktop exited right after launch — likely '}${lockMessage('it was focused instead')}`)
        void shutdown('desktop exited', 1)
      } else {
        void shutdown('desktop exited', 0)
      }
    },
  })
} catch (err) {
  if (!shuttingDown) {
    console.error('[dev-all]', err.message)
    void shutdown('startup failure', 1)
  }
}
