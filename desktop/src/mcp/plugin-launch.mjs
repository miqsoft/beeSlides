#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The MCP server of the BeeSlides plugin for Claude Code (claude-plugin/,
// built by scripts/build-claude-plugin.mjs, which copies this file to
// claude-plugin/mcp/launch.mjs). It decides once, at start, which BeeSlides
// the chat works with (DECISIONS 2026-10-24):
//
//   visible     The BeeSlides app is open and lets outside apps in (Settings ▸
//               AI chat ▸ Advanced): its folder (<userData>/agent, written by
//               agentendpoint.ts) has endpoint.json and its socket answers.
//               Runs the app's own server from there (`--endpoint <dir>`), so
//               the tools always match the installed app — but never lets it
//               start the app (BEESLIDES_NO_LAUNCH=1).
//   background  Otherwise. Runs the server bundled with the plugin
//               (mcp/server.mjs) against a temp folder of its own, so the
//               tools list without any app; the first tool call starts a
//               hidden instance of the installed app there
//               (`<app> --background`, SLIDOMINGO_USER_DATA = that folder,
//               main/background.ts). When Claude Code ends (stdin closes) the
//               instance gets SIGTERM — it saves every deck and quits — and
//               the folder is removed. Nothing is ever shown; the visible app
//               is never started from here.
//   setup       No app found: one tool that says how to get it.
//
// Where the app is: <userData>/agent/app.json, which the visible app writes at
// every start (agentendpoint.ts recordAppLaunch); BEESLIDES_APP (a path, run
// as it is) overrides it. Never a guess at where an app is installed: an app
// from before background mode ignores --background and would open a window,
// so only an app that wrote app.json is known to understand it.
//
// On the way it adds the plugin's instruction to the MCP `initialize` answer
// (claudeLaunch.ts outsideInstruction) with a line saying which mode this is.
//
// Plain Node, no dependencies. BEESLIDES_AGENT_DIR overrides where the app's
// folder is.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(here)
const instruction = readFileSync(join(here, 'instruction.txt'), 'utf8').replaceAll('@REFDIR@', join(pluginRoot, 'reference'))

/** How long the first call waits for a hidden instance to be up. */
const START_WAIT_MS = 30_000
/** How long a quitting instance gets to save its decks. */
const QUIT_WAIT_MS = 20_000

/** Where the app keeps its folder: the installed app (BeeSlides) and a
 *  development build (slidomingo-desktop), per platform. */
function candidates() {
  if (process.env.BEESLIDES_AGENT_DIR) return [process.env.BEESLIDES_AGENT_DIR]
  const home = homedir()
  const base = process.platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : process.platform === 'win32' ? (process.env.APPDATA || join(home, 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME || join(home, '.config'))
  return ['BeeSlides', 'slidomingo-desktop'].map((name) => join(base, name, 'agent'))
}

const mtime = (p) => { try { return statSync(p).mtimeMs } catch { return 0 } }
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

/** Does something answer on `socket`? Connects only: no hello, so the app
 *  asks the user nothing until the first real call. */
function answers(socket) {
  if (typeof socket !== 'string' || !socket) return Promise.resolve(false)
  return new Promise((resolve) => {
    const s = connect(socket)
    const done = (v) => { clearTimeout(timer); s.destroy(); resolve(v) }
    const timer = setTimeout(() => done(false), 1500)
    s.on('connect', () => done(true))
    s.on('error', () => done(false))
  })
}

/** The visible app's folder when it is open and lets outside apps in: of
 *  several, the one switched on most recently. */
async function reachableApp() {
  const dirs = candidates()
    .filter((dir) => existsSync(join(dir, 'beeslides-mcp.mjs')) && existsSync(join(dir, 'endpoint.json')))
    .sort((a, b) => mtime(join(b, 'endpoint.json')) - mtime(join(a, 'endpoint.json')))
  for (const dir of dirs) {
    const ep = readJson(join(dir, 'endpoint.json'))
    if (ep && !ep.background && await answers(ep.socket)) return dir
  }
  return null
}

/** How to start the installed app: BEESLIDES_APP, else the app.json the
 *  visible app wrote (newest), or null. */
function findApp() {
  if (process.env.BEESLIDES_APP) return { command: process.env.BEESLIDES_APP, args: [] }
  const recorded = candidates().map((dir) => join(dir, 'app.json')).filter(existsSync).sort((a, b) => mtime(b) - mtime(a))
  for (const file of recorded) {
    const a = readJson(file)
    if (typeof a?.command === 'string' && existsSync(a.command)) return { command: a.command, args: Array.isArray(a.args) ? a.args.filter((x) => typeof x === 'string') : [] }
  }
  return null
}

const MODE_LINES = {
  visible:
    'Mode: the BeeSlides app is open on this computer. Without open_deck every tool works on the deck window the user ' +
    'last focused there; to work on a file the user names, call open_deck with its path (create:true makes a new deck), ' +
    'which opens it in a window. The user sees every change in the app and picks designs in its compare view.',
  background:
    'Mode: the BeeSlides app is not open, so the tools run in a hidden BeeSlides that nobody sees. Call open_deck with ' +
    'the path of the deck first (create:true makes a new one); every change is saved to that file. The user sees ' +
    'slides only in the BeeSlides pane of this chat: after propose_variants call variants {op:"previews"} so they can ' +
    'pick there, and learn the pick from variants {op:"status"}.',
}

const SETUP = [
  'BeeSlides is not installed on this computer, or it has not been opened since it was installed or updated. Tell the user:',
  '1. Install BeeSlides (https://miqsoft.github.io/beeSlides/), or update it, and open it once.',
  '2. Here, run /mcp and reconnect beeslides (or start a new chat).',
  'Then the tools work on deck files without the app window. To work in the open app instead, turn on Settings ▸ AI chat ▸ Advanced ▸ "Allow AI apps outside BeeSlides" in BeeSlides.',
].join('\n')

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const withInstruction = (result, mode) => {
  const ours = mode ? `${instruction}\n\n${MODE_LINES[mode]}` : instruction
  return { ...result, instructions: result?.instructions ? `${ours}\n\n${result.instructions}` : ours }
}

/** Runs `server` with `args`, this process in the middle of its stdio: it adds
 *  the instruction to the initialize answer, and `beforeCall` may hold a
 *  tools/call (start the app) or answer it itself (return a result). */
function proxy(server, args, env, mode, beforeCall = null, onEnd = null) {
  const child = spawn(process.execPath, [server, ...args], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } })
  const initIds = new Set()
  // calls keep their order: one held for the app holds the ones after it
  let queue = Promise.resolve()
  createInterface({ input: process.stdin }).on('line', (line) => {
    let msg = null
    try { msg = JSON.parse(line) } catch { /* passed on as it is */ }
    if (msg?.method === 'initialize') initIds.add(msg.id)
    queue = queue.then(async () => {
      if (beforeCall && msg?.method === 'tools/call') {
        const answer = await beforeCall(msg.params)
        if (answer) { write({ jsonrpc: '2.0', id: msg.id, result: answer }); return }
      }
      child.stdin.write(line + '\n')
    })
  }).on('close', () => { void queue.then(() => child.stdin.end()).then(() => onEnd?.()) })
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { process.stdout.write(line + '\n'); return }
    if (msg && initIds.has(msg.id) && msg.result) {
      initIds.delete(msg.id)
      msg = { ...msg, result: withInstruction(msg.result, mode) }
    }
    write(msg)
  })
  // the server ends with its stdin; with an end of our own (background) that
  // runs first, else this process goes with it
  child.on('exit', (code) => { if (onEnd) onEnd(); else process.exit(code ?? 0) })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); onEnd?.() })
  return child
}

/** Background mode: the bundled server now, a hidden instance on first use. */
function runBackground(app) {
  // short: the instance's socket lives in it (~100 bytes at most)
  const root = mkdtempSync(join(tmpdir(), 'bs-bg-'))
  const agent = join(root, 'agent')
  mkdirSync(agent, { recursive: true, mode: 0o700 })
  let instance = null // the running app process
  let starting = null

  const up = () => instance && instance.exitCode === null && instance.signalCode === null
  async function start() {
    rmSync(join(agent, 'endpoint.json'), { force: true }) // a crashed run's
    const env = { ...process.env, SLIDOMINGO_USER_DATA: root }
    delete env.ELECTRON_RUN_AS_NODE // this process may be an app's binary run as node
    const child = spawn(app.command, [...app.args, '--background'], { stdio: 'ignore', env })
    child.on('error', () => { /* reported as not started below */ })
    instance = child
    const deadline = Date.now() + START_WAIT_MS
    while (Date.now() < deadline && up()) {
      const ep = readJson(join(agent, 'endpoint.json'))
      if (ep?.socket && await answers(ep.socket)) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }

  /** Holds a call until the instance is up; answers it with an error when
   *  BeeSlides could not be started. `op:"help"` needs no app. */
  async function beforeCall(params) {
    if (params?.arguments?.op === 'help') return null
    if (up() && existsSync(join(agent, 'endpoint.json'))) return null
    starting ??= start().finally(() => { starting = null })
    if (await starting) return null
    return { content: [{ type: 'text', text: `BeeSlides could not be started in the background (${app.command}). Tell the user; opening BeeSlides once and starting a new chat usually fixes it.` }], isError: true }
  }

  let ending = false
  async function end() {
    if (ending) return
    ending = true
    if (up()) {
      const gone = new Promise((r) => instance.once('exit', r))
      instance.kill('SIGTERM') // the instance saves every deck, then quits
      await Promise.race([gone, new Promise((r) => setTimeout(r, QUIT_WAIT_MS))])
      if (up()) instance.kill('SIGKILL')
    }
    try { rmSync(root, { recursive: true, force: true }) } catch { /* temp folder */ }
    process.exit(0)
  }

  proxy(join(here, 'server.mjs'), ['--endpoint', agent], { BEESLIDES_NO_LAUNCH: '1', BEESLIDES_BACKGROUND: '1' }, 'background', beforeCall, end)
}

/** No app at all: one tool that says how to get it. */
function runSetup() {
  const TOOLS = [{
    name: 'setup_status',
    description: 'BeeSlides is not installed yet. Call this to get the steps that set it up, and pass them on to the user.',
    inputSchema: { type: 'object', properties: {} },
  }]
  createInterface({ input: process.stdin }).on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    const { id, method, params } = msg ?? {}
    if (id === undefined || id === null) return // a notification
    if (method === 'initialize') {
      write({ jsonrpc: '2.0', id, result: withInstruction({
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'beeslides', version: 'setup' },
        instructions: SETUP,
      }) })
    } else if (method === 'tools/list') write({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    else if (method === 'tools/call') write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: SETUP }], isError: params?.name !== 'setup_status' } })
    else if (method === 'ping') write({ jsonrpc: '2.0', id, result: {} })
    else write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  })
}

const visible = await reachableApp()
if (visible) proxy(join(visible, 'beeslides-mcp.mjs'), ['--endpoint', visible], { BEESLIDES_NO_LAUNCH: '1' }, 'visible')
else {
  const app = findApp()
  if (app) runBackground(app)
  else runSetup()
}
