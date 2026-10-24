#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The MCP server of the BeeSlides plugin for Claude Code (claude-plugin/,
// built by scripts/build-claude-plugin.mjs, which copies this file to
// claude-plugin/mcp/launch.mjs). It holds no tools of its own: it finds the
// folder the BeeSlides app writes for outside AI apps (agentendpoint.ts:
// <userData>/agent, with beeslides-mcp.mjs, endpoint.json and the token) and
// runs that server as `--endpoint <dir>`, so the tools always match the app
// that is installed. On the way it adds the plugin's instruction to the MCP
// `initialize` answer (claudeLaunch.ts outsideInstruction): what the panel's
// system prompt says, for a chat that has no panel next to it.
//
// Not set up yet (no app, or "Allow AI apps outside BeeSlides" never turned
// on): it answers by itself, with one tool that tells the user what to do.
//
// Plain Node, no dependencies. BEESLIDES_AGENT_DIR overrides where the folder is.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(here)
const instruction = readFileSync(join(here, 'instruction.txt'), 'utf8').replaceAll('@REFDIR@', join(pluginRoot, 'reference'))

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

/** The folder with a server in it; of several, the one switched on most
 *  recently (its endpoint.json is newest). */
function findAgentDir() {
  const switchedOn = (dir) => { try { return statSync(join(dir, 'endpoint.json')).mtimeMs } catch { return 0 } }
  const found = candidates().filter((dir) => existsSync(join(dir, 'beeslides-mcp.mjs')))
  return found.sort((a, b) => switchedOn(b) - switchedOn(a))[0] ?? null
}

const SETUP = [
  'BeeSlides is not set up for AI apps outside it yet. Tell the user:',
  '1. Install BeeSlides (https://miqsoft.github.io/beeSlides/) and open it.',
  '2. In BeeSlides, open Settings ▸ AI chat ▸ Advanced and turn on "Allow AI apps outside BeeSlides".',
  '3. Open the deck to work on.',
  '4. Here, run /mcp and reconnect beeslides (or start a new chat).',
  'BeeSlides asks once whether to allow this app the first time it connects.',
].join('\n')

const withInstruction = (result) => ({ ...result, instructions: result?.instructions ? `${instruction}\n\n${result.instructions}` : instruction })

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

const dir = findAgentDir()

if (dir) {
  // The app's own server, with this process in the middle of its stdio only to
  // add the instruction to the initialize answer.
  const child = spawn(process.execPath, [join(dir, 'beeslides-mcp.mjs'), '--endpoint', dir], { stdio: ['pipe', 'pipe', 'inherit'] })
  const initIds = new Set()
  createInterface({ input: process.stdin }).on('line', (line) => {
    try { const msg = JSON.parse(line); if (msg?.method === 'initialize') initIds.add(msg.id) } catch { /* passed on as it is */ }
    child.stdin.write(line + '\n')
  }).on('close', () => child.stdin.end())
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { process.stdout.write(line + '\n'); return }
    if (msg && initIds.has(msg.id) && msg.result) {
      initIds.delete(msg.id)
      msg = { ...msg, result: withInstruction(msg.result) }
    }
    write(msg)
  })
  child.on('exit', (code) => process.exit(code ?? 0))
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
} else {
  // Nothing to connect to: one tool that says how to set it up.
  const TOOLS = [{
    name: 'setup_status',
    description: 'BeeSlides is not connected yet. Call this to get the steps that connect it, and pass them on to the user.',
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
