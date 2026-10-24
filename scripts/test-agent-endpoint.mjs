#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// slides-mcp-server.mjs in `--endpoint <agentDir>` mode — the way an AI app
// outside BeeSlides runs it — against a stand-in for the app's local socket
// (desktop/src/main/agentendpoint.ts speaks the same lines):
//   - a tool call goes out as a hello + request line and comes back as text
//   - a wrong token is refused, and the call says so instead of hanging
//   - the hello carries the chat app's name (MCP initialize clientInfo), for
//     the app's "allow this app?" question; a "no" comes back as words the
//     model can pass on, without starting the app again
//   - never switched on (no endpoint.json): the call says how to set it up
//   - the app quitting mid-call answers `app-closed`
//   - with nothing listening, the server starts the app from endpoint.json
//   - Code Mode: execute/api_search are listed only when switched on, and an
//     execute result comes back as text (main/agentexec.ts runs the program)
//
//   node scripts/test-agent-endpoint.mjs
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const serverScript = join(root, 'desktop/src/mcp/slides-mcp-server.mjs')
let failed = 0
const ok = (cond, msg) => { if (cond) console.log(`  ok  ${msg}`); else { failed++; console.log(`FAIL  ${msg}`) } }

// The stand-in app: answers hello by token and every request by verb.
// Written out so the launch case can start it as its own process, the way
// the server starts BeeSlides.
const FAKE_APP = `
import { createServer } from 'node:net'
import { existsSync, rmSync } from 'node:fs'
const [socketPath, token, mode] = process.argv.slice(2)
rmSync(socketPath, { force: true })
let helloClient = ''
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
        authed = msg.type === 'hello' && msg.token === token
        const denied = authed && mode === 'deny'
        if (denied) authed = false
        socket.write(JSON.stringify({ type: 'hello', ok: authed, ...(authed ? { sessionId: 'ext-1' } : { error: denied ? 'denied' : 'bad-token' }) }) + '\\n')
        if (!authed) socket.end()
        helloClient = msg.client
        continue
      }
      const { requestId, verb } = msg.payload
      if (mode === 'quit') { socket.destroy(); server.close(); continue }
      if (verb === 'execute') {
        socket.write(JSON.stringify({ type: 'response', result: { requestId, ok: true, value: '{"n":1}', logs: ['hi'], calls: 2, writes: 1, code: msg.payload.args.code } }) + '\\n')
        continue
      }
      socket.write(JSON.stringify({ type: 'response', result: { requestId, ok: true, result: { verb, channel: msg.channel, client: helloClient } } }) + '\\n')
    }
  })
})
server.listen(socketPath, () => { if (process.send) process.send('up') })
// launched detached by the server under test: gone with the test's folder
setInterval(() => { if (!existsSync(socketPath)) process.exit(0) }, 300)
`

const work = mkdtempSync(join(tmpdir(), 'bs-endpoint-'))
const fakeApp = join(work, 'fake-app.mjs')
writeFileSync(fakeApp, FAKE_APP)
const children = []

function startFakeApp(socket, token, mode = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fakeApp, socket, token, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    children.push(child)
    child.on('message', () => resolve(child))
  })
}

/** Runs the MCP server against `dir`; `talk(rpc)` makes the calls. */
async function withServer(dir, talk, { timeoutMs = 15000, script = serverScript, clientInfo, env } = {}) {
  const child = spawn(process.execPath, [script, '--endpoint', dir], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } })
  children.push(child)
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
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)
    replies.set(id, (m) => { clearTimeout(timer); resolve(m) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', ...(clientInfo ? { clientInfo } : {}) })
    return await talk(rpc)
  } finally {
    child.kill()
  }
}

/** Runs the MCP server against `dir` and makes one doc_info call. */
const callDocInfo = (dir, timeoutMs = 15000, env) =>
  withServer(dir, async (rpc) => (await rpc('tools/call', { name: 'doc_info', arguments: {} })).result, { timeoutMs, env })

/** What the real app writes into userData/agent (agentendpoint.ts). */
function writeEndpoint(dir, socket, token, launch) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'token'), token)
  writeFileSync(join(dir, 'endpoint.json'), JSON.stringify({ socket, ...(launch ? { launch } : {}) }))
}

try {
  console.log('round trip')
  {
    const dir = join(work, 'a'); const socket = join(work, 'a.sock')
    writeEndpoint(dir, socket, 'secret')
    await startFakeApp(socket, 'secret')
    const r = await callDocInfo(dir)
    const text = r?.content?.[0]?.text ?? ''
    ok(!r?.isError && text.includes('"verb":"doc_info"') && text.includes('"channel":"agent-query"'), `doc_info answered over the socket (${text.slice(0, 80)})`)
  }

  console.log('wrong token')
  {
    const dir = join(work, 'b'); const socket = join(work, 'b.sock')
    writeEndpoint(dir, socket, 'not-the-token')
    await startFakeApp(socket, 'secret')
    const started = Date.now()
    const r = await callDocInfo(dir)
    ok(r?.isError && /refused the connection/.test(r.content[0].text), `a refused hello is an error, not a hang (${r?.content?.[0]?.text?.slice(0, 60)})`)
    ok(Date.now() - started < 5000, 'and it comes back at once (no launch configured)')
  }

  console.log('client name and a "no"')
  {
    const dir = join(work, 'f'); const socket = join(work, 'f.sock')
    writeEndpoint(dir, socket, 'secret')
    await startFakeApp(socket, 'secret')
    const r = await withServer(dir, async (rpc) => (await rpc('tools/call', { name: 'doc_info', arguments: {} })).result, { clientInfo: { name: 'claude-code', version: '9' } })
    ok((r?.content?.[0]?.text ?? '').includes('"client":"claude-code"'), 'the hello carries the name from initialize clientInfo')
    const dir2 = join(work, 'g'); const socket2 = join(work, 'g.sock')
    // a launch command that would leave a marker: a "no" must not start the app
    const marker = join(work, 'launched')
    writeEndpoint(dir2, socket2, 'secret', { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`] })
    await startFakeApp(socket2, 'secret', 'deny')
    const started = Date.now()
    const d = await callDocInfo(dir2)
    ok(d?.isError && /did not allow this app/.test(d.content[0].text), `a "no" says so (${d?.content?.[0]?.text?.slice(0, 60)})`)
    await new Promise((res) => setTimeout(res, 500))
    ok(Date.now() - started < 5000 && !existsSync(marker), 'at once, and without starting the app again')
  }

  console.log('never switched on')
  {
    const dir = join(work, 'h')
    mkdirSync(dir, { recursive: true })
    const r = await callDocInfo(dir)
    ok(r?.isError && /Allow AI apps outside BeeSlides/.test(r.content[0].text), 'no endpoint.json: the call says how to turn it on')
  }

  console.log('app quits mid-call')
  {
    const dir = join(work, 'c'); const socket = join(work, 'c.sock')
    writeEndpoint(dir, socket, 'secret')
    await startFakeApp(socket, 'secret', 'quit')
    const r = await callDocInfo(dir)
    ok(r?.isError && r.content[0].text.includes('app-closed'), 'the call answers app-closed')
  }

  console.log('starts the app')
  {
    const dir = join(work, 'd'); const socket = join(work, 'd.sock')
    writeEndpoint(dir, socket, 'secret', { command: process.execPath, args: [fakeApp, socket, 'secret'] })
    const r = await callDocInfo(dir, 40000)
    ok(!r?.isError && (r?.content?.[0]?.text ?? '').includes('"verb":"doc_info"'), 'nothing listening → launched from endpoint.json, then answered')
  }

  console.log('the plugin says: start nothing')
  {
    // BEESLIDES_NO_LAUNCH=1 (plugin-launch.mjs): endpoint.json's launch is never run
    const dir = join(work, 'n'); const socket = join(work, 'n.sock')
    const marker = join(work, 'launched-n')
    writeEndpoint(dir, socket, 'secret', { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`] })
    const started = Date.now()
    const r = await callDocInfo(dir, 15000, { BEESLIDES_NO_LAUNCH: '1' })
    await new Promise((res) => setTimeout(res, 500))
    ok(r?.isError && /Ask the user to open it/.test(r.content[0].text) && !existsSync(marker), `nothing is started, and the model is told to ask for the app (${r?.content?.[0]?.text?.slice(0, 60)})`)
    ok(Date.now() - started < 5000, 'at once')
    const bg = await callDocInfo(dir, 15000, { BEESLIDES_NO_LAUNCH: '1', BEESLIDES_BACKGROUND: '1' })
    ok(bg?.isError && /hidden BeeSlides instance/.test(bg.content[0].text) && !existsSync(marker), 'in background mode it names the hidden instance instead')
    const tools = await withServer(dir, async (rpc) => (await rpc('tools/list', {})).result.tools.map((t) => t.name))
    ok(tools.includes('open_deck') && tools.includes('close_deck'), 'an endpoint client gets open_deck and close_deck')
  }

  console.log('code mode')
  {
    const dir = join(work, 'e'); const socket = join(work, 'e.sock')
    writeEndpoint(dir, socket, 'secret')
    await startFakeApp(socket, 'secret')
    // what the app writes out with BEESLIDES_CODE_MODE=1 (main/agenttools.ts serverWithCodeMode)
    const source = readFileSync(serverScript, 'utf8')
    ok(source.includes('/*@CODE_MODE@*/false'), 'the server carries the CODE_MODE placeholder')
    const onScript = join(work, 'server-code-mode.mjs')
    writeFileSync(onScript, source.replace('/*@CODE_MODE@*/false', 'true'))
    const names = async (script) => withServer(dir, async (rpc) => (await rpc('tools/list', {})).result.tools.map((t) => t.name), { script })
    ok(!(await names(serverScript)).includes('execute'), 'off: no execute tool')
    const on = await names(onScript)
    ok(on.includes('execute') && on.includes('api_search'), 'on: execute and api_search are listed')
    await withServer(dir, async (rpc) => {
      const r = (await rpc('tools/call', { name: 'execute', arguments: { code: 'return 1' } })).result
      const text = r?.content?.[0]?.text ?? ''
      ok(!r.isError && text.startsWith('Result: {"n":1}') && text.includes('console:\nhi') && text.includes('1 of them edits'), `an execute result comes back as text (${text.replace(/\n/g, ' | ')})`)
      const help = (await rpc('tools/call', { name: 'api_search', arguments: { query: 'slide write dom' } })).result.content[0].text
      ok(/write\(/.test(help) && /dom\(\)/.test(help), 'api_search finds the slide API')
      const overview = (await rpc('tools/call', { name: 'api_search', arguments: {} })).result.content[0].text
      ok(/ONE undo step/.test(overview) && /Sections:/.test(overview), 'an empty api_search gives the overview')
    }, { script: onScript })
  }
} catch (err) {
  failed++
  console.log(`FAIL  ${err?.message ?? err}`)
} finally {
  for (const c of children) { try { c.kill() } catch { /* gone */ } }
  // the launched fake app is detached; it exits when its socket file goes
  rmSync(work, { recursive: true, force: true })
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall agent endpoint checks passed')
process.exit(0)
