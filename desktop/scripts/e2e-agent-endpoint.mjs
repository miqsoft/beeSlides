#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Agent endpoint + Code Mode E2E: an AI app outside BeeSlides runs the slides
// MCP server as `--endpoint <userData>/agent` (main/agentendpoint.ts) and
// edits the open deck through the app's local socket; `execute` runs programs
// in the hidden sandbox window (main/agentexec.ts).
//   - the endpoint writes its address, a private token and the server script
//   - a wrong token is refused
//   - a plain tool call (update_element) edits the deck
//   - a program adds a slide and writes two slides from HTML (one through the
//     DOM) as ONE undo step
//   - a program that throws, and one that runs out of time, change nothing
//   - the sandbox has no network; its window is gone after each run
//
//   cd desktop && npx electron-vite build && node scripts/e2e-agent-endpoint.mjs
//   (needs slides/dist-single built)
//
// Same two-mode shape as e2e-api-chat.mjs: node runs the ORCHESTRATOR,
// Electron the DRIVER.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const repo = resolve(desktopDir, '..')
const SHELL_PATH = join(repo, 'slides/dist-single/BeeSlides.beeslides.html')
const BLOCK_RE = /(<script[^>]*\bid=["']beeslides-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) failures++
  try { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`) } catch { /* pipe gone */ }
}

if (process.versions.electron) {
  driver().catch(async (err) => {
    ok(false, `driver error: ${err?.stack ?? err}`)
    try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ }
    const { app } = await import('electron')
    app.exit(4)
  })
}
else await orchestrator()

/** The MCP server as an outside AI app runs it, and a JSON-RPC line client for it. */
function mcpClient(agentDir) {
  const child = spawn(process.execPath, [join(agentDir, 'beeslides-mcp.mjs'), '--endpoint', agentDir], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'ignore'],
  })
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
  const rpc = (method, params, ms = 60000) => new Promise((resolve, reject) => {
    const id = next++
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), ms)
    replies.set(id, (m) => { clearTimeout(timer); resolve(m) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const tool = async (name, args, ms) => (await rpc('tools/call', { name, arguments: args }, ms)).result
  return { rpc, tool, close: () => child.kill() }
}

async function driver() {
  const { app, BrowserWindow, webContents } = await import('electron')
  const net = await import('node:net')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  BrowserWindow.prototype.show = function () { this.setOpacity(0); this.showInactive() }
  BrowserWindow.prototype.focus = function () {}
  app.dock?.hide()
  const { E2E_USERDATA: userData } = process.env
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  const report = () => { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ } }
  const hardStop = setTimeout(() => { ok(false, 'timed out'); report(); app.exit(3) }, 150000)
  async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn().catch(() => null)
      if (v) return v
      if (Date.now() > end) return null
      await sleep(150)
    }
  }
  const wc = await waitFor(async () => {
    for (const w of webContents.getAllWebContents()) {
      if (w.isDestroyed() || w.isLoading() || !/BeeSlides\.beeslides\.html/.test(w.getURL())) continue
      if (await w.executeJavaScript('!!(window.beeslides && window.beeslides.doc && document.querySelector(".ed-root"))')) return w
    }
    return null
  })
  ok(!!wc, 'the deck opened')
  if (!wc) { report(); app.exit(1); return }
  const js = (code) => wc.executeJavaScript(code)
  const doc = () => js('JSON.parse(JSON.stringify(window.beeslides.doc))')
  const textOf = (d, i) => (d.slides[i]?.elements ?? []).map((e) => e.html ?? '').join(' ')

  // ---- 1. the endpoint's files
  const agentDir = join(userData, 'agent')
  const ep = await waitFor(async () => JSON.parse(readFileSync(join(agentDir, 'endpoint.json'), 'utf8')))
  ok(!!ep?.socket && existsSync(join(agentDir, 'beeslides-mcp.mjs')), 'endpoint.json and the server script are written')
  ok((statSync(join(agentDir, 'token')).mode & 0o077) === 0, 'the token file is private to the user')

  // ---- 2. a wrong token is refused
  const refused = await new Promise((resolve) => {
    const s = net.connect(ep.socket)
    let buf = ''
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); resolve(JSON.parse(buf.split('\n')[0])) } })
    s.on('error', () => resolve(null))
    s.on('connect', () => s.write(JSON.stringify({ type: 'hello', token: 'f'.repeat(64) }) + '\n'))
  })
  ok(refused && refused.ok === false, 'a wrong token is refused')

  const mcp = mcpClient(agentDir)
  try {
    await mcp.rpc('initialize', { protocolVersion: '2024-11-05' })
    const names = (await mcp.rpc('tools/list', {})).result.tools.map((t) => t.name)
    ok(names.includes('execute') && names.includes('api_search') && names.includes('slide_html'), 'the outside app gets execute, api_search and the deck tools')

    // ---- 3. a plain tool call
    const before = await doc()
    const s0 = before.slides[0].id
    const s1 = before.slides[1].id
    const upd = await mcp.tool('update_element', { slideId: s0, elementId: 't1', props: { color: '#ff0000' } })
    ok(!upd.isError && (await doc()).slides[0].elements.find((e) => e.id === 't1').color === '#ff0000', `update_element through the endpoint recoloured the title (${upd.content?.[0]?.text?.slice(0, 80)})`)
    const windowsBefore = BrowserWindow.getAllWindows().length

    // ---- 4. a program: a new slide + two slides written from HTML, one undo step
    const prog = await mcp.tool('execute', { code: `
      const { slideIds } = await deck.op('deck', 'add', { count: 1 })
      const d = await deck.slide(${JSON.stringify(s1)}).dom()
      d.body.innerHTML = '<main style="padding:72px var(--bs-margin)"><h1 id="title">Written by a program</h1></main>'
      await deck.slide(${JSON.stringify(s1)}).write(d)
      await deck.slide(slideIds[0]).write('<h1 id="title">' + deck.esc('New & shiny') + '</h1>')
      console.log('added', slideIds[0])
      return { added: slideIds[0], count: (await deck.outline()).length }
    ` }, 90000)
    const progText = prog.content?.[0]?.text ?? ''
    ok(!prog.isError && /"count":3/.test(progText) && /console:\nadded /.test(progText), `the program ran and reported back (${progText.split('\n')[0]})`)
    const after = await doc()
    ok(after.slides.length === 3, 'it added a slide')
    ok(textOf(after, 1).includes('Written by a program'), 'it rewrote slide 2 through the DOM')
    ok(textOf(after, 2).includes('New &amp; shiny') || textOf(after, 2).includes('New & shiny'), 'it wrote the new slide')
    await js('window.beeslides.undo()')
    const undone = await doc()
    ok(undone.slides.length === 2 && !textOf(undone, 1).includes('Written by a program'), 'ONE undo takes the whole program back')
    ok(undone.slides[0].elements.find((e) => e.id === 't1').color === '#ff0000', '…and only the program: the earlier tool call stays')
    await js('window.beeslides.redo()')
    ok((await doc()).slides.length === 3, 'one redo brings it all back')
    await js('window.beeslides.undo()')
    ok(BrowserWindow.getAllWindows().length === windowsBefore, 'the sandbox window is gone after the run')

    // ---- 5. a program that throws changes nothing
    const thrown = await mcp.tool('execute', { code: `
      await deck.slide(${JSON.stringify(s0)}).update('t1', { color: '#00ff00' })
      throw new Error('boom')
    ` })
    const thrownText = thrown.content?.[0]?.text ?? ''
    ok(thrown.isError && /boom/.test(thrownText) && /rolled back/.test(thrownText), `a throw is reported and rolled back (${thrownText.replace(/\n/g, ' | ').slice(0, 120)})`)
    ok((await doc()).slides[0].elements.find((e) => e.id === 't1').color === '#ff0000', '…the deck is as before the program')

    // ---- 6. no network; an endless loop is stopped
    const netTry = await mcp.tool('execute', { code: `try { await fetch('https://example.com/'); return 'fetched' } catch { return 'blocked' }` })
    ok(/Result: "blocked"/.test(netTry.content?.[0]?.text ?? ''), 'the sandbox has no network')
    const started = Date.now()
    const loop = await mcp.tool('execute', { code: `await deck.slide(${JSON.stringify(s0)}).update('t1', { color: '#0000ff' }); while (true) {}`, timeoutSeconds: 2 })
    ok(loop.isError && /ran out of time/.test(loop.content?.[0]?.text ?? '') && Date.now() - started < 20000, 'an endless loop is stopped at its time budget')
    ok((await doc()).slides[0].elements.find((e) => e.id === 't1').color === '#ff0000', '…and its edit rolled back')
    const info = await mcp.tool('doc_info', {})
    ok(!info.isError && BrowserWindow.getAllWindows().length === windowsBefore, 'the app still answers and no sandbox window is left')
  } finally {
    mcp.close()
  }

  clearTimeout(hardStop)
  report()
  app.exit(0)
}

async function orchestrator() {
  if (!existsSync(SHELL_PATH)) { console.log(`missing ${SHELL_PATH} — run npm run build:single in slides/`); process.exit(2) }
  if (!existsSync(join(desktopDir, 'out/main/index.js'))) { console.log('missing out/main — run npx electron-vite build'); process.exit(2) }
  const electronPath = createRequire(import.meta.url)('electron')
  const root = mkdtempSync(join(tmpdir(), 'beeslides-e2e-endpoint-'))
  const work = join(root, 'work')
  const home = join(root, 'home')
  const userData = join(root, 'u') // short: the socket path must stay under ~100 bytes
  for (const d of [work, home, userData]) mkdirSync(d, { recursive: true })
  const shellHtml = readFileSync(SHELL_PATH, 'utf8')
  const { newDoc, emptySlide } = await import(join(repo, 'slides/src/model.ts'))
  const doc = Object.assign(newDoc(), { title: 'Endpoint', docId: '0a0a0a0a-0000-4000-8000-0000000e0e01' })
  doc.slides[0].elements = [{ id: 't1', type: 'text', x: 80, y: 60, w: 800, h: 100, rotation: 0, opacity: 1, html: 'Title', fontSize: 24, fontFamily: 'system-ui, sans-serif', fontWeight: 400, color: '#111111', align: 'left', valign: 'top', lineHeight: 1.1 }]
  doc.slides.push(emptySlide({ id: 'second', name: 'Second' }))
  const deck = join(work, 'Endpoint.beeslides.html')
  writeFileSync(deck, shellHtml.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`))
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', deck], {
    cwd: desktopDir,
    env: {
      ...process.env, HOME: home, E2E_USERDATA: userData,
      SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: join(root, 'templates'), SLIDOMINGO_UI_PROFILE_PATH: join(root, 'ui.json'),
      ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '',
      BEESLIDES_AGENT_ENDPOINT: '1', BEESLIDES_CODE_MODE: '1',
    },
    encoding: 'utf8', timeout: 180000,
  })
  const out = res.stdout ?? ''
  for (const line of out.split('\n')) if (/^\s+(ok|FAIL|debug)\s/.test(line)) console.log(line)
  const m = out.match(/E2E_RESULT (\d+) (\d+)/)
  if (!m) { console.log(`FAIL  no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-15).join('\n')}`); process.exit(1) }
  checks += Number(m[1]); failures += Number(m[2])
  console.log(`\n${checks - failures}/${checks} checks passed   (profile: ${root})`)
  if (failures) process.exit(1)
}
