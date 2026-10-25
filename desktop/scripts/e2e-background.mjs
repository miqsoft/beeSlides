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
//
//   cd desktop && npx electron-vite build && node scripts/e2e-background.mjs
//   (needs slides/dist-single built)
//
// The driver does NOT override BrowserWindow.show: it tests the real hiding.
// E2E_DUMP=1 keeps the screenshots (review.png, canvas.png, design*.png) in
// the profile folder it prints.

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

async function driver() {
  const { app, BrowserWindow, webContents, nativeImage } = await import('electron')
  const { E2E_ROOT: root } = process.env
  const userData = process.env.SLIDOMINGO_USER_DATA
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
  // the user's own app settings: read for viewerPrefs, never written
  const userSettings = join(root, 'user-app-settings.json')
  writeFileSync(userSettings, JSON.stringify({ viewerPrefs: { 'slidomingo-lang': 'de' }, session: [{ path: '/nope', name: 'x' }] }, null, 2))
  const userBefore = readFileSync(userSettings, 'utf8')
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--background'], {
    cwd: desktopDir,
    env: {
      ...process.env, HOME: home, E2E_ROOT: root,
      SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: join(root, 'templates'), SLIDOMINGO_UI_PROFILE_PATH: join(root, 'ui.json'),
      BEESLIDES_USER_SETTINGS: userSettings,
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
  ok(readFileSync(userSettings, 'utf8') === userBefore, 'the user\'s settings file is untouched')
  console.log(`\n${checks - failures}/${checks} checks passed   (profile: ${root})`)
  if (failures) process.exit(1)
}
