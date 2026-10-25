#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Background mode E2E (main/background.ts, DECISIONS 2026-10-24): the app run
// as `--background` with a userData of its own, the way the Claude Code
// plugin starts it, driven through its endpoint like an outside AI app.
//   - no window is ever visible, no Dock icon
//   - endpoint.json says background and carries no launch
//   - with no deck open, a call says to use open_deck
//   - open_deck create writes a new deck file and binds the client to it
//   - doc_info says background and names the file
//   - slide_html write lays HTML out in the hidden window
//   - review_slide returns the slide as drawn (not the splash, not blank)
//   - the hidden doc view itself paints, captures and runs rAF (the spike)
//   - autosave lands on disk
//   - propose_variants → variants previews (one picture per design) →
//     status pending → pick → status picked, the design on the slide
//   - close_deck flushes and closes; open_deck reopens the file
//   - SIGTERM quits through the flush: the last edit is in the file
//   - no Recent entries, no session; the user's settings are only read
//   - icons: the user's token-protected server and folder work there — the
//     token is decrypted from the USER's icon-tokens.bin, encrypted by a
//     separate Electron run with that userData (as the visible app does),
//     and the folder comes from the user's icon-folders.json; neither file
//     is written
//
//   cd desktop && npx electron-vite build && node scripts/e2e-background.mjs
//   (needs slides/dist-single built)
//
// The driver does NOT override BrowserWindow.show: it tests the real hiding.
// E2E_DUMP=1 keeps the screenshots (review.png, canvas.png, design*.png) in
// the profile folder it prints.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const repo = resolve(desktopDir, '..')
const SHELL_PATH = join(repo, 'slides/dist-single/BeeSlides.beeslides.html')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) failures++
  try { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`) } catch { /* pipe gone */ }
}

if (process.versions.electron && process.argv.includes('--seed-token')) seedToken()
else if (process.versions.electron) {
  driver().catch(async (err) => {
    ok(false, `driver error: ${err?.stack ?? err}`)
    try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ }
    const { app } = await import('electron')
    app.exit(4)
  })
}
else await orchestrator()

/** The MCP server as the plugin runs it against a hidden instance. */
function mcpClient(agentDir, cwd) {
  const child = spawn(process.execPath, [join(agentDir, 'beeslides-mcp.mjs'), '--endpoint', agentDir], {
    cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BEESLIDES_NO_LAUNCH: '1', BEESLIDES_BACKGROUND: '1' }, stdio: ['pipe', 'pipe', 'ignore'],
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
    const timer = setTimeout(() => reject(new Error(`${method} ${params?.name ?? ''} timed out`)), ms)
    replies.set(id, (m) => { clearTimeout(timer); resolve(m) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const tool = async (name, args, ms) => (await rpc('tools/call', { name, arguments: args }, ms)).result
  return { rpc, tool, close: () => child.kill() }
}

/** Plays the visible app storing an icon-server token: a separate Electron
 *  run with the USER's userData and the name index.ts gives an unpackaged
 *  run, encrypting with safeStorage into icon-tokens.bin the way
 *  main/icontokens.ts does. */
async function seedToken() {
  const { app, safeStorage } = await import('electron')
  app.setPath('userData', process.env.E2E_USER_DIR)
  app.setName('BeeSlides (dev)')
  await app.whenReady()
  const ok = safeStorage.isEncryptionAvailable()
  if (ok) {
    const enc = safeStorage.encryptString('t-e2e').toString('base64')
    writeFileSync(join(process.env.E2E_USER_DIR, 'icon-tokens.bin'), JSON.stringify({ src_tok: { root: process.env.E2E_ICON_ROOT, enc } }))
  }
  try { console.log(`SEEDED ${ok}`) } catch { /* */ }
  app.exit(ok ? 0 : 5)
}

/** The token-protected icon server (run in the driver: the orchestrator is
 *  blocked in spawnSync). Wants Bearer t-e2e, sends no CORS headers. */
async function iconServer(port) {
  const { createServer } = await import('node:http')
  const hits = []
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#0a0"/></svg>'
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    hits.push({ path: u.pathname, auth: req.headers.authorization ?? null })
    if (req.headers.authorization !== 'Bearer t-e2e') { res.writeHead(401).end(); return }
    if (u.pathname === '/lib/api/search') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: [{ relative_path: 'cloud.svg', display_name: 'Server cloud' }] }))
    else if (u.pathname === '/lib/files/cloud.svg') res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(SVG)
    else res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return { hits, close: () => server.close() }
}

async function driver() {
  const { app, BrowserWindow, webContents, nativeImage } = await import('electron')
  const { E2E_ROOT: root } = process.env
  const userData = process.env.SLIDOMINGO_USER_DATA
  // index.js sets this name too, but only once its import graph has loaded —
  // later than the app entry does it, and after safeStorage has fixed which
  // Keychain item ("<name> Safe Storage") it uses. Set it as early as the
  // seeder and the real entry do, or the token case decrypts with another key.
  app.setName('BeeSlides (dev)')
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  const report = () => { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ } }
  const hardStop = setTimeout(() => { ok(false, 'timed out'); report(); app.exit(3) }, 170000)
  async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn().catch(() => null)
      if (v) return v
      if (Date.now() > end) return null
      await sleep(150)
    }
  }
  const textOf = (c) => (c?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const imagesOf = (c) => (c?.content ?? []).filter((b) => b.type === 'image')
  const nothingVisible = () => BrowserWindow.getAllWindows().every((w) => !w.isVisible())
  /** The share of a PNG's pixels that are clearly red / blue. Hue, not the
   *  exact value: captures are colour-managed (#C0102A comes back ~#A51F2E). */
  const RED = (r, g, b) => r > 130 && g < 80 && b < 90
  const BLUE = (r, g, b) => b > 150 && r < 100 && g < 130
  const share = (b64, is) => {
    const bmp = nativeImage.createFromBuffer(Buffer.from(b64, 'base64')).toBitmap() // BGRA
    let hit = 0
    for (let i = 0; i < bmp.length; i += 4) if (is(bmp[i + 2], bmp[i + 1], bmp[i])) hit++
    return hit / (bmp.length / 4)
  }

  // ---- 1. the instance's endpoint
  const agentDir = join(userData, 'agent')
  const ep = await waitFor(async () => JSON.parse(readFileSync(join(agentDir, 'endpoint.json'), 'utf8')))
  ok(ep?.background === true && !ep.launch && !!ep.socket, `endpoint.json says background, no launch (${JSON.stringify(ep)})`)
  ok(!existsSync(join(agentDir, 'app.json')), 'a hidden instance does not record itself as the app to start')
  ok(nothingVisible(), 'no window is visible at start')
  if (process.platform === 'darwin') ok(app.dock?.isVisible?.() === false, 'no Dock icon')

  const work = join(root, 'work')
  const mcp = mcpClient(agentDir, work)
  try {
    await mcp.rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'e2e' } })
    const names = (await mcp.rpc('tools/list', {})).result.tools.map((t) => t.name)
    ok(names.includes('open_deck') && names.includes('close_deck') && names.includes('variants'), 'the endpoint server lists open_deck, close_deck and variants')

    // ---- 2. no deck yet
    const none = await mcp.tool('doc_info', {})
    ok(none.isError && /open_deck/.test(textOf(none)), `with no deck open, a call says to use open_deck (${textOf(none).slice(0, 80)})`)

    // ---- 3. open_deck create (a relative path: the server resolves it)
    const deck = join(work, 'bg.beeslides.html')
    const opened = await mcp.tool('open_deck', { path: 'bg.beeslides.html', create: true }, 60000)
    ok(!opened.isError && /Created and opened bg\.beeslides\.html/.test(textOf(opened)), `open_deck create (${textOf(opened).slice(0, 100)})`)
    ok(existsSync(deck) && statSync(deck).size > 100_000, 'the new deck file is written')
    ok(nothingVisible(), 'the deck window is not visible')
    const again = await mcp.tool('open_deck', { path: join(work, 'nope.beeslides.html') })
    ok(again.isError && /create:true/.test(textOf(again)), 'a missing file without create is refused')
    const notDeck = join(work, 'x.txt')
    writeFileSync(notDeck, 'hi')
    ok((await mcp.tool('open_deck', { path: notDeck })).isError, 'a file that is not a deck is refused')

    // ---- 4. doc_info
    const info = JSON.parse(textOf(await mcp.tool('doc_info', {})))
    ok(info.background === true && info.file === 'bg.beeslides.html' && info.slideCount === 1 && info.size?.width === 1280, `doc_info: background, file, one 1280px slide (${info.file}, ${info.background})`)
    const s0 = JSON.parse(textOf(await mcp.tool('outline', {})))[0]?.id

    // ---- 5. slide_html write in the hidden window
    const html = '<main><div id="block" style="position:absolute;left:80px;top:160px;width:640px;height:400px;background:#C0102A"></div><h1 id="title" style="position:absolute;left:80px;top:40px;width:1000px">Hidden but here</h1></main>'
    const w = await mcp.tool('slide_html', { op: 'write', slideId: s0, html }, 30000)
    ok(!w.isError && /Wrote/.test(textOf(w)), `slide_html write (${textOf(w).split('\n')[0].slice(0, 90)})`)

    // ---- 6. review_slide: the slide as drawn
    const rv = await mcp.tool('review_slide', { slideId: s0 }, 30000)
    const shot = imagesOf(rv)[0]
    ok(!rv.isError && !!shot?.data, 'review_slide returns a screenshot')
    if (shot && process.env.E2E_DUMP) writeFileSync(join(root, 'review.png'), Buffer.from(shot.data, 'base64'))
    const red = shot ? share(shot.data, RED) : 0
    ok(red > 0.15 && red < 0.6, `the screenshot shows the slide's red block (${(red * 100).toFixed(0)}% of pixels), not the splash or a blank`)

    // ---- 6b. a chart, shot off screen, has its bars
    const added = await mcp.tool('deck', { op: 'add', count: 1 })
    const chartSlide = JSON.parse(textOf(await mcp.tool('outline', {}))).at(-1)?.id
    const chart = { preset: 'bar', option: { xAxis: { type: 'category', data: ['A', 'B', 'C'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [3, 5, 4] }] } }
    const cw = await mcp.tool('slide_html', { op: 'write', slideId: chartSlide, html: `<div id="c1" style="position:absolute;left:80px;top:80px;width:1100px;height:560px" data-chart='${JSON.stringify(chart)}'></div>` }, 30000)
    ok(!added.isError && !cw.isError, `a chart slide (${textOf(cw).split('\n')[0].slice(0, 80)})`)
    const crv = await mcp.tool('review_slide', { slideId: chartSlide }, 30000)
    const cshot = imagesOf(crv)[0]
    if (cshot && process.env.E2E_DUMP) writeFileSync(join(root, 'chart.png'), Buffer.from(cshot.data, 'base64'))
    const inked = cshot ? share(cshot.data, (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 60) : 0
    ok(inked > 0.05, `the chart's bars are in the off-screen screenshot (${(inked * 100).toFixed(1)}% coloured pixels)`)
    await mcp.tool('deck', { op: 'delete', slideIds: [chartSlide] })

    // ---- 6b'. icons: the user's token-protected server and folder
    const icons = await iconServer(Number(process.env.E2E_ICON_PORT))
    try {
      const found = await mcp.tool('icons', { op: 'search', query: 'cloud' }, 30000)
      const ft = textOf(found)
      ok(!found.isError && /"Server cloud"/.test(ft) && /"Folder cloud"/.test(ft), `icons search finds the server's and the folder's icon (${ft.split('\n').slice(0, 3).join(' | ').slice(0, 200)})`)
      ok(icons.hits.length > 0 && icons.hits.every((h) => h.auth === 'Bearer t-e2e'), `every server request carried the user's token (${icons.hits.map((h) => `${h.path}:${h.auth ? 'auth' : 'none'}`).join(' ')})`)
      ok(/license: CC0-1\.0/.test(ft), 'the folder\'s icons.json licence comes along')
      const refOf = (name) => [...ft.matchAll(/(i\d+) "([^"]+)"/g)].find((m) => m[2] === name)?.[1]
      for (const [name, x] of [['Server cloud', 100], ['Folder cloud', 300]]) {
        const ins = await mcp.tool('icons', { op: 'insert', slideId: s0, ref: refOf(name), x, y: 500, size: 64 }, 30000)
        ok(!ins.isError, `insert "${name}" (${textOf(ins).slice(0, 80)})`)
      }
      const svgs = (textOf(await mcp.tool('get_slide', { slideId: s0 })).match(/"type":\s*"svg"/g) ?? []).length
      ok(svgs === 2, `both icons are on the slide (${svgs} svg elements)`)
      ok(!existsSync(join(userData, 'icon-tokens.bin')) || !readFileSync(join(userData, 'icon-tokens.bin'), 'utf8').includes('src_tok'), 'the token was not copied into the hidden instance\'s folder')
      ok(!existsSync(join(userData, 'icon-folders.json')), 'nor the folder')
    } finally { icons.close() }

    // ---- 6c. the pane's comments (claude-mod pane_comment): never listed, a
    //          thread flagged for the agent, Accept / Reopen after resolve_comment
    ok(!names.includes('pane_comment'), 'pane_comment is not listed: a model cannot call it')
    const thread = async () => JSON.parse(textOf(await mcp.tool('comments', { slideId: s0 })))[0]
    const pc = await mcp.tool('pane_comment', { op: 'add', slideId: s0, text: 'Shorter title' })
    const cid = /"commentId":"([^"]+)"/.exec(textOf(pc))?.[1]
    let t = await thread()
    ok(!pc.isError && !!cid && t?.id === cid && t.forAgent && !t.resolved && t.text === 'Shorter title', `pane_comment add: a thread flagged for the agent (${textOf(pc).slice(0, 80)})`)
    await mcp.tool('resolve_comment', { commentId: cid, reply: 'Cut it' })
    await mcp.tool('pane_comment', { op: 'reopen', commentId: cid, text: 'Still too long' })
    t = await thread()
    ok(!t.resolved && !t.awaitingCheck && t.replies.at(-1)?.text === 'Still too long', 'pane_comment reopen: open again, the feedback as a reply')
    await mcp.tool('resolve_comment', { commentId: cid })
    await mcp.tool('pane_comment', { op: 'accept', commentId: cid })
    t = await thread()
    ok(t.resolved && !t.awaitingCheck, 'pane_comment accept: resolved, nothing left to check')
    ok((await mcp.tool('pane_comment', { op: 'add', slideId: 'nope', text: 'x' })).isError, 'pane_comment add on a missing slide is refused')
    // the pane reads elements off get_slide's summary: `  <id> <type> … "text"`
    const summary = textOf(await mcp.tool('get_slide', { slideId: s0, view: 'summary' }))
    const textEl = /^ {2}(\S+) text\b.*"Hidden but here"/m.exec(summary)?.[1]
    ok(!!textEl, `get_slide summary has the element line the pane parses (${summary.split('\n')[1]?.slice(0, 80)})`)
    const onEl = await mcp.tool('pane_comment', { op: 'add', slideId: s0, elementId: textEl, text: 'Bigger' })
    const anchored = JSON.parse(textOf(await mcp.tool('comments', { slideId: s0, resolved: false })))
    ok(!onEl.isError && anchored.some((c) => c.text === 'Bigger' && c.anchor?.type === 'element' && c.anchor.elementId === textEl), 'pane_comment add on an element anchors the thread to it')
    ok((await mcp.tool('pane_comment', { op: 'add', slideId: s0, elementId: 'nope', text: 'x' })).isError, 'pane_comment add on a missing element is refused')

    // ---- 7. the spike: the hidden doc view itself paints and runs rAF
    const doc = webContents.getAllWebContents().find((c) => !c.isDestroyed() && /BeeSlides\.beeslides\.html/.test(c.getURL()))
    ok(!!doc, 'the doc view exists')
    if (doc) {
      const raf = await Promise.race([doc.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'), sleep(3000).then(() => false)])
      ok(raf === true, 'requestAnimationFrame runs in the hidden doc view')
      const vis = await doc.executeJavaScript('document.visibilityState')
      ok(typeof vis === 'string', `the page reports visibilityState ${vis}`)
      // the boot splash holds for ~1.3 s (main.ts): the canvas is under it until then
      const ready = await waitFor(() => doc.executeJavaScript("!document.getElementById('beeslides-splash')"), 5000)
      ok(!!ready, 'the boot splash goes away in the hidden window (its timers run)')
      const img = await doc.capturePage()
      if (process.env.E2E_DUMP) writeFileSync(join(root, 'canvas.png'), img.toPNG())
      const size = img.getSize()
      ok(!img.isEmpty() && size.width > 100, `the hidden doc view captures (${size.width}x${size.height})`)
      const onCanvas = img.isEmpty() ? 0 : share(img.toPNG().toString('base64'), RED)
      ok(onCanvas > 0.02, `…and its capture shows the slide on the canvas (${(onCanvas * 100).toFixed(1)}% red)`)
    }

    // ---- 8. autosave
    const saved = await waitFor(async () => readFileSync(deck, 'utf8').includes('Hidden but here'), 15000)
    ok(!!saved, 'autosave writes the edit to the file')

    // ---- 9. designs: propose → previews → status → pick
    const pv = await mcp.tool('propose_variants', { slideId: s0, variants: [
      { html: '<h1 id="title" style="position:absolute;left:80px;top:300px;width:1000px">Design A</h1>', label: 'Low title' },
      { html: '<main><div id="block" style="position:absolute;left:0;top:0;width:1280px;height:720px;background:#1050C0"></div><h1 id="title" style="position:absolute;left:80px;top:40px;width:1000px;color:#fff">Design B</h1></main>', label: 'Full blue' },
    ] }, 30000)
    ok(!pv.isError && /variants \{op:\\?"previews/.test(textOf(pv)), `propose_variants points at the previews in background (${textOf(pv).slice(0, 120)})`)
    ok(nothingVisible(), 'no compare view or window shows up')
    const previews = await mcp.tool('variants', { op: 'previews', slideId: s0 }, 30000)
    const pics = imagesOf(previews)
    ok(!previews.isError && pics.length === 2, `variants previews: one picture per design (${pics.length})`)
    if (process.env.E2E_DUMP) pics.forEach((p, i) => writeFileSync(join(root, `design${i + 1}.png`), Buffer.from(p.data, 'base64')))
    if (pics.length === 2) {
      ok(share(pics[1].data, BLUE) > 0.5, 'the second picture is the blue design')
      ok(nativeImage.createFromBuffer(Buffer.from(pics[0].data, 'base64')).getSize().width <= 800, 'previews are at most 800 px wide')
    }
    ok(/Design 2: Full blue/.test(textOf(previews)), 'each picture is labelled with its number and label')
    ok(/pending/.test(textOf(await mcp.tool('variants', { op: 'status' }))), 'status: pending')
    const pick = await mcp.tool('variants', { op: 'pick', slideId: s0, index: 2 })
    ok(!pick.isError && /Used design 2 "Full blue"/.test(textOf(pick)), `pick index 2 (${textOf(pick).slice(0, 80)})`)
    ok(/picked design 2 "Full blue"/.test(textOf(await mcp.tool('variants', { op: 'status' }))), 'status: picked')
    const after = textOf(await mcp.tool('get_slide', { slideId: s0, view: 'summary' }))
    ok(/Design B/.test(after), 'the picked design is on the slide')

    // ---- 10. close_deck flushes; open_deck reopens
    const closed = await mcp.tool('close_deck', {}, 30000)
    ok(!closed.isError && /Saved and closed/.test(textOf(closed)), `close_deck (${textOf(closed)})`)
    ok(readFileSync(deck, 'utf8').includes('Design B'), 'close_deck flushed the pick to the file')
    ok(BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).every((w) => !w.webContents.getURL().includes('beeslides.html')), 'its window is gone')
    const gone = await mcp.tool('doc_info', {})
    ok(gone.isError && /open_deck/.test(textOf(gone)), 'with the deck closed, calls ask for open_deck again')
    const re = await mcp.tool('open_deck', { path: deck }, 60000)
    ok(!re.isError && /Opened bg\.beeslides\.html/.test(textOf(re)), 'open_deck reopens the file')
    const last = await mcp.tool('slide_html', { op: 'write', slideId: s0, html: '<h1 id="title">Written right before SIGTERM</h1>' }, 30000)
    ok(!last.isError, 'a last edit')
  } finally {
    mcp.close()
  }

  // ---- 11. bookkeeping
  const settings = JSON.parse(readFileSync(join(userData, 'app-settings.json'), 'utf8'))
  ok(!settings.session, 'no session recorded')
  ok(settings.viewerPrefs?.['slidomingo-lang'] === 'de', 'viewerPrefs were seeded from the user\'s settings')
  ok(!existsSync(join(userData, 'recent-files.json')), 'no Recent entries')

  clearTimeout(hardStop)
  report()
  // the quit the plugin sends when Claude Code ends: flush, then exit
  process.kill(process.pid, 'SIGTERM')
}

async function orchestrator() {
  if (!existsSync(SHELL_PATH)) { console.log(`missing ${SHELL_PATH} — run npm run build:single in slides/`); process.exit(2) }
  if (!existsSync(join(desktopDir, 'out/main/index.js'))) { console.log('missing out/main — run npx electron-vite build'); process.exit(2) }
  const electronPath = createRequire(import.meta.url)('electron')
  const root = mkdtempSync(join(tmpdir(), 'bs-bg-e2e-'))
  const work = join(root, 'work')
  const home = join(root, 'home')
  const userData = join(root, 'u') // short: the socket path must stay under ~100 bytes
  for (const d of [work, home]) mkdirSync(d, { recursive: true })
  // a throwaway HOME, but the user's login keychain: macOS finds it through
  // HOME, and safeStorage's key (the "BeeSlides (dev) Safe Storage" item) is
  // what the icon-token case decrypts with — as a real hidden instance does
  if (process.platform === 'darwin') {
    mkdirSync(join(home, 'Library'), { recursive: true })
    symlinkSync(join(homedir(), 'Library/Keychains'), join(home, 'Library/Keychains'))
  }
  // the user's own userData: settings read for viewerPrefs, never written;
  // an icon server with a token and an icon folder set up in the visible app
  const userDir = join(root, 'user')
  const iconDir = join(root, 'icons')
  mkdirSync(join(iconDir, 'sub'), { recursive: true })
  writeFileSync(join(iconDir, 'sub/cloud.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#00f"/></svg>')
  writeFileSync(join(iconDir, 'sub/icons.json'), JSON.stringify({ license: 'CC0-1.0', icons: [{ file: 'cloud.svg', name: 'Folder cloud' }] }))
  const iconPort = await new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const iconRoot = `http://127.0.0.1:${iconPort}/lib`
  const sources = [
    { id: 'src_tok', kind: 'server', name: 'Team server', enabled: true, url: iconRoot },
    { id: 'src_dir', kind: 'folder', name: 'Team folder', enabled: true },
  ]
  mkdirSync(userDir)
  const userSettings = join(userDir, 'app-settings.json')
  writeFileSync(userSettings, JSON.stringify({ viewerPrefs: { 'slidomingo-lang': 'de', 'slidomingo-icon-sources': JSON.stringify(sources) }, session: [{ path: '/nope', name: 'x' }] }, null, 2))
  writeFileSync(join(userDir, 'icon-folders.json'), JSON.stringify({ src_dir: realpathSync(iconDir) }))
  const seeded = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--seed-token'], {
    cwd: desktopDir, env: { ...process.env, E2E_USER_DIR: userDir, E2E_ICON_ROOT: iconRoot }, encoding: 'utf8', timeout: 60000,
  })
  ok(/SEEDED true/.test(seeded.stdout ?? '') && existsSync(join(userDir, 'icon-tokens.bin')), `a separate run with the user's userData stored the token encrypted (exit ${seeded.status})`)
  const userFiles = ['app-settings.json', 'icon-tokens.bin', 'icon-folders.json']
  const userBefore = Object.fromEntries(userFiles.map((f) => [f, existsSync(join(userDir, f)) ? readFileSync(join(userDir, f), 'utf8') : null]))
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--background'], {
    cwd: desktopDir,
    env: {
      ...process.env, HOME: home, E2E_ROOT: root,
      SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: join(root, 'templates'), SLIDOMINGO_UI_PROFILE_PATH: join(root, 'ui.json'),
      BEESLIDES_USER_SETTINGS: userSettings, E2E_ICON_PORT: String(iconPort),
      ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '',
    },
    encoding: 'utf8', timeout: 200000,
  })
  const out = res.stdout ?? ''
  for (const line of out.split('\n')) if (/^\s+(ok|FAIL|debug)\s/.test(line)) console.log(line)
  const m = out.match(/E2E_RESULT (\d+) (\d+)/)
  if (!m) { console.log(`FAIL  no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-15).join('\n')}`); process.exit(1) }
  checks += Number(m[1]); failures += Number(m[2])
  ok(res.status === 0, `SIGTERM quit the instance cleanly (exit ${res.status})`)
  ok(readFileSync(join(work, 'bg.beeslides.html'), 'utf8').includes('Written right before SIGTERM'), 'the quit flushed the last edit to the file')
  ok(userFiles.every((f) => (existsSync(join(userDir, f)) ? readFileSync(join(userDir, f), 'utf8') : null) === userBefore[f]), 'the user\'s settings, icon tokens and icon folders are untouched')
  console.log(`\n${checks - failures}/${checks} checks passed   (profile: ${root})`)
  if (failures) process.exit(1)
}
