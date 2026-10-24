#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The BeeSlides plugin for Claude Code (claude-plugin/, built by
// scripts/build-claude-plugin.mjs):
//   - claude-plugin/ matches its sources (it is generated and committed)
//   - the marketplace lists it, manifest and .mcp.json are what Claude Code reads
//   - every skill carries the line that says where the reference docs are
//   - the launcher with no app at all: one tool that explains the setup
//   - the visible app reachable: its own server and tools, the plugin's
//     instruction (pointing at real files) and the visible mode line; calls
//     reach the app
//   - no app reachable, an app installed (a fake one, BEESLIDES_APP): the
//     bundled server lists the tools without it; the first real call starts
//     it as `--background` with a temp userData; the end of the chat sends it
//     SIGTERM and removes the folder
//
//   node scripts/test-claude-plugin.mjs
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const plugin = join(root, 'claude-plugin')
let failed = 0
const ok = (cond, msg) => { if (cond) console.log(`  ok  ${msg}`); else { failed++; console.log(`FAIL  ${msg}`) } }
const json = (p) => JSON.parse(readFileSync(p, 'utf8'))

/** A stand-in BeeSlides: answers hello by token and every request with its
 *  verb. `visible` listens where argv says; `background` (as the launcher
 *  starts the app) makes its own folder under SLIDOMINGO_USER_DATA, says so
 *  in endpoint.json, and leaves marks of its start and of a SIGTERM. */
const FAKE_APP = `
import { createServer } from 'node:net'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const bg = process.argv.includes('--background')
const marks = process.env.FAKE_MARKS
const ud = process.env.SLIDOMINGO_USER_DATA
const agent = bg ? join(ud, 'agent') : process.argv[2]
const socketPath = join(agent, 'fake.sock')
mkdirSync(agent, { recursive: true })
if (bg) {
  writeFileSync(join(marks, 'started'), JSON.stringify({ argv: process.argv.slice(2), userData: ud }))
  writeFileSync(join(agent, 'token'), 'secret')
}
rmSync(socketPath, { force: true })
const server = createServer((socket) => {
  let buf = '', authed = false
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1)
      if (!authed) {
        authed = msg.type === 'hello' && msg.token === 'secret'
        socket.write(JSON.stringify({ type: 'hello', ok: authed, sessionId: 'ext-1' }) + '\\n')
        continue
      }
      const { requestId, verb } = msg.payload
      socket.write(JSON.stringify({ type: 'response', result: { requestId, ok: true, result: { verb, mode: bg ? 'background' : 'visible' } } }) + '\\n')
    }
  })
})
server.listen(socketPath, () => {
  writeFileSync(join(agent, 'endpoint.json'), JSON.stringify(bg ? { socket: socketPath, background: true } : { socket: socketPath }))
  if (process.send) process.send('up')
})
process.on('SIGTERM', () => { if (bg) writeFileSync(join(marks, 'terminated'), '1'); process.exit(0) })
`

/** Runs the launcher with `env`; `talk(rpc, child)` makes the calls. */
async function withLauncher(env, talk) {
  const child = spawn(process.execPath, [join(plugin, 'mcp/launch.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } })
  const replies = new Map()
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += String(d)
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1)
      replies.get(msg.id)?.(msg)
    }
  })
  let next = 1
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = next++
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15000)
    replies.set(id, (m) => { clearTimeout(timer); resolve(m) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try { return await talk(rpc, child) } finally { child.kill() }
}

const work = mkdtempSync(join(tmpdir(), 'bs-plugin-'))
try {
  console.log('generated and listed')
  {
    const r = spawnSync(process.execPath, [join(root, 'scripts/build-claude-plugin.mjs'), '--check'], { encoding: 'utf8' })
    ok(r.status === 0, `claude-plugin/ matches its sources${r.status ? `\n${r.stdout}` : ''}`)
    const market = json(join(root, '.claude-plugin/marketplace.json'))
    const entry = market.plugins?.find((p) => p.name === 'beeslides')
    ok(entry?.source === './claude-plugin' && json(join(plugin, '.claude-plugin/plugin.json')).name === 'beeslides', 'the marketplace lists ./claude-plugin as beeslides')
    const mcp = json(join(plugin, '.mcp.json')).mcpServers?.beeslides
    ok(mcp?.command === 'node' && mcp.args?.[0] === '${CLAUDE_PLUGIN_ROOT}/mcp/launch.mjs', '.mcp.json starts the launcher from the plugin folder')
    const version = json(join(root, 'slides/package.json')).version
    ok(json(join(plugin, '.claude-plugin/plugin.json')).version === version, `the plugin carries the app's version (${version})`)
    const manifest = json(join(plugin, '.claude-plugin/plugin.json'))
    ok(manifest.types === './types/index.d.ts' && existsSync(join(plugin, 'types/index.d.ts')) && json(join(plugin, 'hooks/hooks.json')).modules?.[0] === './register.tsx' && existsSync(join(plugin, 'hooks/register.tsx')), 'the pane mod is in the plugin: hooks module, its state contract named in the manifest')
    const bundled = readFileSync(join(plugin, 'mcp/server.mjs'), 'utf8')
    ok(!bundled.includes('/*@AGENT_AREAS@*/') && bundled.includes('"name":"variants"') && bundled.includes('/*@CODE_MODE@*/false'), 'mcp/server.mjs: the agent areas filled in, Code Mode off')
    for (const name of ['build-deck', 'restyle-deck', 'polish-deck', 'slide-designs']) {
      const md = readFileSync(join(plugin, 'skills', name, 'SKILL.md'), 'utf8')
      ok(md.startsWith(`---\nname: ${name}\n`) && md.includes('`../../reference/agents.md`'), `skill ${name}: frontmatter first, then where the reference docs are`)
    }
  }

  console.log('no app at all')
  await withLauncher({ BEESLIDES_AGENT_DIR: join(work, 'nothing-here') }, async (rpc) => {
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } })).result
    ok(init?.protocolVersion === '2025-06-18' && /BeeSlides deck/.test(init.instructions) && /Allow AI apps outside BeeSlides/.test(init.instructions), 'initialize: the plugin instruction and the setup steps')
    const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name)
    ok(tools.length === 1 && tools[0] === 'setup_status', 'one tool: setup_status')
    const r = (await rpc('tools/call', { name: 'setup_status', arguments: {} })).result
    ok(!r.isError && /Settings ▸ AI chat ▸ Advanced/.test(r.content[0].text) && /\/mcp/.test(r.content[0].text), 'it says where to switch it on and how to reconnect')
    const other = (await rpc('tools/call', { name: 'doc_info', arguments: {} })).result
    ok(other.isError && /not installed/.test(other.content[0].text), 'any other tool answers with the same steps, as an error')
  })

  const fakeApp = join(work, 'fake-app.mjs')
  writeFileSync(fakeApp, FAKE_APP)

  console.log('the visible app, reachable')
  {
    // what the app writes into <userData>/agent (agentendpoint.ts), switched on, and it listening
    const agent = join(work, 'agent')
    mkdirSync(agent, { recursive: true })
    copyFileSync(join(root, 'desktop/src/mcp/slides-mcp-server.mjs'), join(agent, 'beeslides-mcp.mjs'))
    writeFileSync(join(agent, 'token'), 'secret')
    const app = spawn(process.execPath, [fakeApp, agent], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    await new Promise((resolve) => app.once('message', resolve))
    try {
      await withLauncher({ BEESLIDES_AGENT_DIR: agent }, async (rpc) => {
        const init = (await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code' } })).result
        ok(init?.serverInfo?.name === 'beeslides' && init.serverInfo.version !== 'setup', 'initialize comes from the app\'s own server')
        const ref = /top of (\S+)\/agents\.md/.exec(init.instructions ?? '')?.[1]
        ok(!!ref && existsSync(join(ref, 'agents.md')) && existsSync(join(ref, 'format.md')), `the instruction points at the plugin's reference docs (${ref})`)
        ok(/no editing context line/.test(init.instructions) && !/selection\.json/.test(init.instructions), 'it is the outside instruction, not the panel\'s')
        ok(/Mode: the BeeSlides app is open/.test(init.instructions), 'with the visible mode line')
        const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name)
        // the raw server source; the app adds its grouped tools (slide_html, …) when it writes it out
        ok(tools.includes('review_slide') && tools.includes('open_deck') && tools.includes('propose_variants'), `the app's tools pass through (${tools.length})`)
        const r = (await rpc('tools/call', { name: 'doc_info', arguments: {} })).result
        ok(!r.isError && /"mode":"visible"/.test(r.content[0].text), 'a call reaches the visible app')
      })
    } finally {
      app.kill()
    }
  }

  if (process.platform !== 'win32') {
    console.log('background: no app reachable, one installed')
    const agent = join(work, 'idle-agent') // the user's folder: switched off, nothing listening
    mkdirSync(agent, { recursive: true })
    const marks = join(work, 'marks')
    mkdirSync(marks)
    const bin = join(work, 'BeeSlides')
    writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeApp)} "$@"\n`)
    chmodSync(bin, 0o755)
    const env = { BEESLIDES_AGENT_DIR: agent, BEESLIDES_APP: bin, FAKE_MARKS: marks }
    await withLauncher(env, async (rpc, launcher) => {
      const init = (await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code' } })).result
      ok(/Mode: the BeeSlides app is not open/.test(init.instructions) && /open_deck/.test(init.instructions), 'initialize: the background mode line (open_deck first)')
      const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name)
      ok(tools.includes('slide_html') && tools.includes('variants') && tools.includes('open_deck') && !tools.includes('execute'), `the bundled server lists the tools, areas filled, no Code Mode (${tools.length})`)
      const help = (await rpc('tools/call', { name: 'variants', arguments: { op: 'help' } })).result
      ok(!help.isError && /variants op "pick"/.test(help.content[0].text) && !existsSync(join(marks, 'started')), 'help is answered without starting anything')
      const r = (await rpc('tools/call', { name: 'doc_info', arguments: {} }, 40000)).result
      ok(!r.isError && /"mode":"background"/.test(r.content?.[0]?.text ?? ''), `the first real call starts the app and is answered by it (${r.content?.[0]?.text?.slice(0, 60)})`)
      const started = JSON.parse(readFileSync(join(marks, 'started'), 'utf8'))
      ok(started.argv.includes('--background') && started.userData.startsWith(tmpdir()) && !started.userData.startsWith(agent), `started as --background with a temp userData of its own (${started.userData})`)
      const again = (await rpc('tools/call', { name: 'outline', arguments: {} })).result
      ok(!again.isError, 'the next call goes to the same instance')
      // Claude Code ends: stdin closes
      const exited = new Promise((resolve) => launcher.once('exit', resolve))
      launcher.stdin.end()
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))])
      ok(existsSync(join(marks, 'terminated')), 'the end of the chat sends the instance SIGTERM')
      ok(!existsSync(started.userData), 'and removes its folder')
    })
  }
} catch (err) {
  failed++
  console.log(`FAIL  ${err?.message ?? err}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall Claude plugin checks passed')
