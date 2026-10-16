#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The icon library in a real browser, against a MOCK icon server that speaks
// the generic contract (slides/src/editor/iconlibrary.ts) — hermetic, no
// network, no real server:
//   node scripts/test-icons-e2e.mjs [url] [--shots <dir>]
// url defaults to the built editor, slides/dist-single/BeeSlides.beeslides.html
// (npm run build:single first); pass http://localhost:<port>/ for a dev server.
// Needs playwright-core: $PLAYWRIGHT_CORE (path to its index.mjs), the
// package itself, or the npx cache. Without one (or without a build) it
// SKIPS with exit 0 and says so. Headless only.
//
// Checks:
//  1. Settings ▸ Icon library: URL + token typed there are what the popover
//     uses, and a source card's Test button reports ✓/✗ with the reason
//     (every scenario below also clicks Test and expects the matching verdict).
//     The legacy one-server/one-folder settings migrate into a source list.
//  2. Open server: grid + thumbnails really load, no Authorization header is
//     sent, search filters, "No icons found.", an svg insert is ONE undo step
//     and interns the markup, a png insert becomes an image element.
//  3. SECURITY: a hostile svg is stored raw but rendered sanitized (no
//     <script>, no on* handler on the canvas).
//  4. Token server: missing token ("wants an API token"), a login page served
//     as 200 HTML (same message), a wrong token ("rejected"), the right token
//     (Bearer on EVERY request, blob: thumbnails, `png_url` shrunk to size 128).
//  5. Failure messages: no CORS headers, nothing listening, HTTP 500.
//  6. Offline mode: nothing reaches the server, the popover says why.
//  7. Local folder (File System Access, stubbed with OPFS): choose, search by
//     filename, insert; then folder + server searched together. SKIPS itself
//     where the browser has no OPFS here.
//  8. Several sources: results merged, tagged with their source, a picker that
//     narrows to one, a disabled source never contacted, one failing source
//     listed beside the others' results, none switched on; adding, switching
//     off and removing a source in Settings, and persistence across reload.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const shotsAt = argv.indexOf('--shots')
const shots = shotsAt >= 0 ? argv.splice(shotsAt, 2)[1] : null
if (shots) mkdirSync(shots, { recursive: true })

async function loadChromium() {
  const tries = []
  if (process.env.PLAYWRIGHT_CORE) tries.push(pathToFileURL(process.env.PLAYWRIGHT_CORE).href)
  tries.push('playwright-core')
  const npx = join(homedir(), '.npm/_npx')
  if (existsSync(npx)) {
    for (const d of readdirSync(npx)) {
      const p = join(npx, d, 'node_modules/playwright-core/index.mjs')
      if (existsSync(p)) tries.push(pathToFileURL(p).href)
    }
  }
  for (const spec of tries) {
    try { return (await import(spec)).chromium } catch { /* next */ }
  }
  return null
}

const skip = (why) => { console.log(`test-icons-e2e: SKIP — ${why}`); process.exit(0) }

const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : null)
if (!url) skip('no build (npm run build:single in slides/) and no url given')
const chromium = await loadChromium()
if (!chromium) skip('playwright-core not found (set PLAYWRIGHT_CORE)')

let browser
try { browser = await chromium.launch({ headless: true }) } catch (e) { skip(`no browser: ${String(e.message).split('\n')[0]}`) }

let fails = 0
let passes = 0
const check = (ok, label, detail) => {
  if (ok) { passes++; console.log(`  ok    ${label}`) }
  else { fails++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`) }
}

// ——— the mock icon server ————————————————————————————————————————————————

// a real 1×1 PNG, so <img> decodes it and a raster insert has bytes to embed
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const svgOf = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="${fill}"/></svg>`
const EVIL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="window.__pwned=1"><script>window.__pwned=1</script><rect width="24" height="24" fill="#c00" onclick="window.__pwned=1"/></svg>`

const ICONS = [
  { relative_path: 'shapes/star.svg', display_name: 'star', description: 'five-pointed', category: 'shapes', license: 'CC-BY-4.0', author: 'S. Tar', body: svgOf('#fa0'), type: 'image/svg+xml', png_url: '/png/shapes/star.svg?size=512' },
  { relative_path: 'shapes/circle.svg', display_name: 'circle', category: 'shapes', body: svgOf('#09f'), type: 'image/svg+xml' },
  { relative_path: 'logos/evil one.svg', display_name: 'evil', category: 'logos', body: EVIL, type: 'image/svg+xml' },
  { relative_path: 'photos/dot.png', display_name: 'dot', category: 'photos', body: PNG, type: 'image/png' },
]

/** opts: { cors = true, token = null, mode = 'ok'|'login'|'500', only = [display names] }. */
async function mockServer(opts = {}) {
  const { cors = true, token = null, mode = 'ok', only = null } = opts
  const log = []
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const auth = req.headers.authorization ?? null
    const head = cors ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Allow-Methods': 'GET' } : {}
    if (req.method === 'OPTIONS') { res.writeHead(cors ? 204 : 405, head); res.end(); return }
    log.push({ path: u.pathname, q: u.searchParams.get('q'), size: u.searchParams.get('size'), auth })
    const send = (code, type, body) => { res.writeHead(code, { ...head, 'Content-Type': type }); res.end(body) }
    if (mode === '500') return send(500, 'text/plain', 'boom')
    if (mode === 'login') return send(200, 'text/html', '<html><body>Please sign in</body></html>')
    if (token && auth !== `Bearer ${token}`) return send(401, 'application/json', '{"error":"unauthorized"}')
    if (u.pathname === '/api/search') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase()
      const results = ICONS.filter((i) => (!only || only.includes(i.display_name)) && i.display_name.includes(q)).map(({ body, type, ...r }) => r)
      return send(200, 'application/json', JSON.stringify({ results }))
    }
    if (u.pathname.startsWith('/png/')) return send(200, 'image/png', PNG)
    if (u.pathname.startsWith('/files/')) {
      const rel = decodeURIComponent(u.pathname.slice('/files/'.length))
      const icon = ICONS.find((i) => i.relative_path === rel)
      return icon ? send(200, icon.type, icon.body) : send(404, 'text/plain', 'nope')
    }
    send(404, 'text/plain', 'nope')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${srv.address().port}`, log, close: () => new Promise((r) => srv.close(r)) }
}

// ——— page helpers ————————————————————————————————————————————————————————

const KEYS = { url: 'slidomingo-icon-server-url', token: 'slidomingo-icon-server-token', mode: 'slidomingo-icon-source', offline: 'slidomingo-offline', sources: 'slidomingo-icon-sources' }
const errors = []

/** A fresh editor page whose localStorage is seeded BEFORE boot (undefined = key
 *  removed; a null seed leaves whatever the context already holds — a "later session"). */
async function boot(ctx, seed = {}) {
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(e.message))
  if (seed) await p.addInitScript(({ KEYS, seed }) => {
    for (const k of Object.keys(KEYS)) {
      const v = seed[k]
      if (v === undefined) localStorage.removeItem(KEYS[k]); else localStorage.setItem(KEYS[k], v)
    }
  }, { KEYS, seed })
  await p.goto(url)
  await p.waitForFunction(() => !!window.slidomingo?.loadDoc, null, { timeout: 30_000 })
  await p.waitForSelector('.ed-stage-scale', { timeout: 30_000 })
  await p.waitForFunction(() => !document.getElementById('slidomingo-splash'), null, { timeout: 15_000 }).catch(() => {})
  await p.waitForTimeout(400)
  // a blank slide to insert into
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.slidomingo.doc))
    d.slides = [{ ...d.slides[0], id: 's1', elements: [] }]
    window.slidomingo.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(300)
  return p
}

// a desktop-width tab has the ribbon (DECISIONS 2026-10-13): Icons lives on its Insert tab
async function clickIconsButton(p) {
  const tab = p.locator('.ed-ribbon-tab[data-tab-key="insert"]')
  if (await tab.count()) await tab.click()
  await p.locator('button:visible[title^="Search and insert an icon"]').first().click()
}
const statusOf = (p) => p.locator('.ed-icon-status').innerText()

/** Opens the popover and waits for the first search to settle (cells or a status line). */
async function openPopover(p) {
  await clickIconsButton(p)
  await p.waitForSelector('.ed-icon-pop')
  await settled(p)
}
async function settled(p) {
  await p.waitForFunction(() => {
    const s = document.querySelector('.ed-icon-status')?.textContent ?? ''
    return !/^Searching/.test(s) && (s !== '' || document.querySelector('.ed-icon-cell'))
  }, null, { timeout: 8000 }).catch(() => {})
  await p.waitForTimeout(250)
}
async function typeQuery(p, q) {
  await p.locator('.ed-icon-search').fill(q)
  await p.waitForTimeout(450) // 250 ms debounce
  await settled(p)
}
const cells = (p) => p.evaluate(() => [...document.querySelectorAll('.ed-icon-cell')].map((c) => ({ label: c.textContent, title: c.title, src: c.querySelector('img')?.src ?? '' })))
const thumbsLoaded = (p) => p.evaluate(async () => {
  const imgs = [...document.querySelectorAll('.ed-icon-cell img')]
  await Promise.all(imgs.map((i) => i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 3000) })))
  return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0)
})
const slideEls = (p) => p.evaluate(() => window.slidomingo.doc.slides[0].elements.map((e) => ({ id: e.id, type: e.type, asset: e.asset, src: e.src, provenance: e.provenance })))
const clickCell = async (p, label) => {
  await p.locator('.ed-icon-cell', { hasText: label }).first().click()
  await p.waitForTimeout(400)
}
/** Settings ▸ Icon library ▸ Test: opens Settings, clicks it, returns the result line, closes Settings. */
async function settingsTest(p) {
  await p.locator('button:visible[title^="Settings"]').first().click()
  await p.waitForSelector('.ed-settings-overlay')
  await p.locator('.ed-settings-navitem', { hasText: 'Icon library' }).click()
  const out = await clickTest(p)
  await p.keyboard.press('Escape')
  await p.waitForSelector('.ed-settings-overlay', { state: 'detached' })
  return out
}
async function clickTest(p, card = 0) {
  const c = p.locator('.ed-isrc').nth(card)
  await c.locator('button', { hasText: /^Test$/ }).click()
  await p.waitForFunction((i) => { const t = document.querySelectorAll('.ed-isrc')[i]?.querySelector('.ed-isrc-result')?.textContent ?? ''; return t && !/^Testing/.test(t) }, card, { timeout: 10_000 }).catch(() => {})
  return c.locator('.ed-isrc-result').innerText()
}
const sourcesStored = (p) => p.evaluate((K) => JSON.parse(localStorage.getItem(K.sources) ?? 'null'), KEYS)
/** Seeds the source list directly (instead of the legacy keys) and boots. */
const bootSources = (ctx, list, extra = {}) => boot(ctx, { sources: JSON.stringify(list), ...extra })
const srvSource = (id, name, url, over = {}) => ({ id, kind: 'server', name, enabled: true, url, token: '', ...over })
const closePopover = async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(150) }

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })

  // 1+2+3) open server, configured THROUGH Settings ———————————————————————————
  console.log('\nopen server (configured in Settings ▸ Icon library)')
  {
    const srv = await mockServer()
    const p = await boot(ctx, {})
    await p.locator('button:visible[title^="Settings"]').first().click()
    await p.waitForSelector('.ed-settings-overlay')
    await p.locator('.ed-settings-navitem', { hasText: 'Icon library' }).click()
    await p.locator('input[placeholder="Server URL"]').fill(srv.base + '/')
    await p.locator('input[placeholder^="API token"]').fill('  ')
    await p.locator('input[placeholder^="API token"]').press('Tab')
    // what the person declares for the whole source; a server's own word per icon wins
    await p.locator('input[placeholder^="License of these icons"]').fill('  Company-owned ')
    await p.locator('input[placeholder^="License of these icons"]').press('Tab')
    const stored = await sourcesStored(p)
    check(stored?.length === 1 && stored[0].kind === 'server' && stored[0].url === srv.base + '/' && !stored[0].token, 'the URL typed in Settings is stored in the source list; a blank token stays empty', stored)
    check(stored?.[0]?.license === 'Company-owned', 'the license typed on the source card is stored, trimmed', stored)
    const verdict = await clickTest(p)
    check(verdict === '✓ Works — the search returned 4 icons', 'Test → ✓ with the icon count', verdict)
    check(srv.log.some((r) => r.path === '/files/shapes/star.svg'), 'Test loads a real icon file, like an insert would')
    await p.keyboard.press('Escape')
    await p.waitForSelector('.ed-settings-overlay', { state: 'detached' })

    await openPopover(p)
    check((await p.locator('.ed-icon-hint').innerText()).includes(new URL(srv.base).host), 'the popover says which server it is searching')
    let c = await cells(p)
    check(c.map((x) => x.label).sort().join() === 'circle,dot,evil,star', 'an empty search lists every icon, extension stripped from labels', c.map((x) => x.label))
    check(c.find((x) => x.label === 'star')?.title === 'star — five-pointed', 'the tooltip carries name — description')
    check(await thumbsLoaded(p), 'every thumbnail really decodes (naturalWidth > 0)')
    check(c.every((x) => x.src.startsWith(srv.base + '/files/')), 'tokenless thumbnails are plain <img src> URLs on the server', c.map((x) => x.src))
    check(srv.log.every((r) => r.auth === null), 'no Authorization header without a token')
    check(srv.log.some((r) => r.path.includes('evil%20one')), 'a path with a space is percent-encoded segment by segment')
    if (shots) await p.screenshot({ path: join(shots, 'icons-open-server.png') })

    await typeQuery(p, 'sta')
    c = await cells(p)
    check(c.length === 1 && c[0].label === 'star' , 'typing filters on the server (q=sta → star)', c.map((x) => x.label))
    check(srv.log.some((r) => r.q === 'sta'), 'the query reached the server URL-encoded as q=sta')
    await typeQuery(p, 'zzz')
    check((await statusOf(p)) === 'No icons found.' && (await cells(p)).length === 0, 'no match says "No icons found."')

    // svg insert: one undo step, markup interned
    await typeQuery(p, '')
    await clickCell(p, 'star')
    let els = await slideEls(p)
    check(els.length === 1 && els[0].type === 'svg', 'clicking an svg icon inserts one svg element', els)
    const interned = await p.evaluate(() => { const e = window.slidomingo.doc.slides[0].elements[0]; return window.slidomingo.doc.assets?.[e.asset] ?? null })
    check(typeof interned === 'string' && interned.includes('fill="#fa0"'), 'its markup is interned in doc.assets')
    const host = new URL(srv.base).host
    check(JSON.stringify(els[0].provenance) === JSON.stringify({ origin: host, url: srv.base + '/files/shapes/star.svg', author: 'S. Tar', license: 'CC-BY-4.0' }),
      'the inserted icon records its source, address, and the license the SERVER gave for it', els[0].provenance)
    check((await p.locator('.ed-icon-pop').count()) === 1, 'the popover stays open so several icons can be dropped in a row')
    await p.evaluate(() => window.slidomingo.undo())
    await p.waitForTimeout(200)
    check((await slideEls(p)).length === 0, 'ONE undo removes the inserted icon')
    // the same icon twice shares one asset
    await clickCell(p, 'star'); await clickCell(p, 'star')
    els = await slideEls(p)
    check(els.length === 2 && els[0].asset === els[1].asset, 'the same icon inserted twice shares one asset', els)

    // an icon whose server says nothing about license falls back to what the source card declares
    await clickCell(p, 'circle')
    els = await slideEls(p)
    check(els.at(-1)?.provenance?.license === 'Company-owned' && els.at(-1)?.provenance?.author === undefined, 'no license from the server → the source card\'s license, no invented author', els.at(-1)?.provenance)

    // png insert: an image element carrying the bytes
    await clickCell(p, 'dot')
    els = await slideEls(p)
    const png = els.at(-1)
    check(png?.provenance?.license === 'Company-owned' && png.provenance.origin === host, 'a raster icon records its provenance too', png?.provenance)
    check(png?.type === 'image' && /^(data:image\/png;base64,|asset:)/.test(png.src ?? ''), 'clicking a png icon inserts an image element with the bytes', png)

    // 3) security: hostile svg is stored raw, rendered sanitized
    await clickCell(p, 'evil')
    els = await slideEls(p)
    const evil = els.at(-1)
    await p.waitForTimeout(300)
    const dom = await p.evaluate((id) => {
      const n = document.querySelector(`.ed-stage-scale [data-el-id="${id}"]`)
      return { found: !!n, scripts: n?.querySelectorAll('script').length, handlers: n ? /\son(load|click)=/i.test(n.innerHTML) : null, pwned: !!window.__pwned }
    }, evil.id)
    check(dom.found && dom.scripts === 0 && dom.handlers === false, 'a hostile svg renders with no <script> and no on* handler on the canvas', dom)
    check(!dom.pwned, 'and nothing of it ever ran')
    await closePopover(p)
    check((await p.locator('.ed-icon-pop').count()) === 0, 'Esc closes the popover')
    await p.close(); await srv.close()
  }

  // 4) token server ————————————————————————————————————————————————————————
  console.log('\ntoken-protected server')
  {
    const TOKEN = 'ict_secret123'
    const srv = await mockServer({ token: TOKEN })

    let p = await boot(ctx, { url: srv.base })
    await openPopover(p)
    check(/wants an API token/.test(await statusOf(p)), 'no token → "wants an API token"', await statusOf(p))
    await closePopover(p)
    let verdict = await settingsTest(p)
    check(/^✗ Couldn't search: .*wants an API token/.test(verdict), 'Test without a token → ✗ wants an API token', verdict)
    await p.close()

    const login = await mockServer({ mode: 'login' })
    p = await boot(ctx, { url: login.base })
    await openPopover(p)
    check(/wants an API token/.test(await statusOf(p)), 'a 200 login PAGE (not JSON) → the same hint, not a parse error', await statusOf(p))
    await closePopover(p)
    verdict = await settingsTest(p)
    check(/^✗ .*wants an API token/.test(verdict), 'Test on a login page → ✗ wants an API token', verdict)
    await p.close(); await login.close()

    p = await boot(ctx, { url: srv.base, token: 'wrong' })
    await openPopover(p)
    check(/rejected the API token \(HTTP 401\)/.test(await statusOf(p)), 'a wrong token → "rejected the API token (HTTP 401)"', await statusOf(p))
    await closePopover(p)
    verdict = await settingsTest(p)
    check(/^✗ .*rejected the API token/.test(verdict), 'Test with a wrong token → ✗ rejected', verdict)
    await p.close()

    srv.log.length = 0
    p = await boot(ctx, { url: srv.base, token: TOKEN })
    await openPopover(p)
    const c = await cells(p)
    check(c.length === 4, 'the right token lists every icon', c.map((x) => x.label))
    check(c.every((x) => x.src.startsWith('blob:')), 'thumbnails are blob: URLs (an <img> cannot carry the header)', c.map((x) => x.src))
    check(await thumbsLoaded(p), 'the blob thumbnails decode')
    check(srv.log.length > 0 && srv.log.every((r) => r.auth === `Bearer ${TOKEN}`), 'EVERY request carried Authorization: Bearer <token>', srv.log.filter((r) => r.auth !== `Bearer ${TOKEN}`))
    check(srv.log.some((r) => r.path === '/png/shapes/star.svg' && r.size === '128'), 'a result with png_url is previewed from it, shrunk to size=128', srv.log.map((r) => `${r.path}?size=${r.size}`))
    check(!srv.log.some((r) => r.path === '/files/shapes/star.svg'), '…and its full original is NOT downloaded for the grid')
    await closePopover(p)
    verdict = await settingsTest(p)
    check(verdict === '✓ Works — the search returned 4 icons', 'Test with the right token → ✓', verdict)
    check(srv.log.filter((r) => r.auth !== `Bearer ${TOKEN}`).length === 0, 'the Test requests carried the token too')
    await openPopover(p)
    await clickCell(p, 'star')
    check((await slideEls(p)).some((e) => e.type === 'svg'), 'inserting an svg from the protected server works')
    await clickCell(p, 'dot')
    check((await slideEls(p)).some((e) => e.type === 'image'), 'inserting a png from the protected server works')
    if (shots) await p.screenshot({ path: join(shots, 'icons-token-server.png') })
    await p.close(); await srv.close()
  }

  // 5) failure messages ———————————————————————————————————————————————————
  console.log('\nfailures say something useful')
  {
    const noCors = await mockServer({ cors: false })
    let p = await boot(ctx, { url: noCors.base })
    await openPopover(p)
    check(/can't reach .* CORS|Access-Control-Allow-Origin/.test(await statusOf(p)), 'a server without CORS headers → the CORS explanation, not "Failed to fetch"', await statusOf(p))
    await closePopover(p)
    let v = await settingsTest(p)
    check(/^✗ Couldn't search: can't reach .*CORS/.test(v), 'Test without CORS → ✗ with the CORS explanation', v)
    await p.close(); await noCors.close()

    const dead = await mockServer()
    const deadBase = dead.base
    await dead.close()
    p = await boot(ctx, { url: deadBase })
    await openPopover(p)
    check(/^can't reach/.test(await statusOf(p)), 'nothing listening → "can\'t reach <server>"', await statusOf(p))
    await closePopover(p)
    v = await settingsTest(p)
    check(/^✗ Couldn't search: can't reach/.test(v), 'Test with nothing listening → ✗ can\'t reach', v)
    await p.close()

    const broken = await mockServer({ mode: '500' })
    p = await boot(ctx, { url: broken.base })
    await openPopover(p)
    check(/HTTP 500/.test(await statusOf(p)), 'an HTTP 500 is reported as such', await statusOf(p))
    await closePopover(p)
    v = await settingsTest(p)
    check(/^✗ .*HTTP 500/.test(v), 'Test on a broken server → ✗ HTTP 500', v)
    await p.close(); await broken.close()
  }

  // 6) offline ———————————————————————————————————————————————————————————
  console.log('\noffline mode')
  {
    const srv = await mockServer()
    const p = await boot(ctx, { url: srv.base, offline: 'on' })
    await openPopover(p)
    check(/Offline mode is on/.test(await statusOf(p)), 'offline → the popover says nothing leaves this computer', await statusOf(p))
    check(srv.log.length === 0, 'and the server saw NO request at all', srv.log)
    await closePopover(p)
    const v = await settingsTest(p)
    check(/^✗ .*Offline mode is on/.test(v) && srv.log.length === 0, 'Test while offline → ✗ and still no request', v)
    await p.close(); await srv.close()
  }
  await ctx.close()

  // 7) local folder ——————————————————————————————————————————————————————
  console.log('\nlocal folder')
  {
    // FSA handles read back from IndexedDB need a persistent profile (see
    // the headless-driving notes); a stubbed picker hands out an OPFS dir
    const profile = mkdtempSync(join(tmpdir(), 'slidomingo-icons-'))
    const fctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1440, height: 900 } })
    try {
      const p = await fctx.newPage()
      p.on('pageerror', (e) => errors.push(e.message))
      await p.addInitScript(() => {
        window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('icons')
      })
      await p.goto(url)
      await p.waitForFunction(() => !!window.slidomingo?.loadDoc, null, { timeout: 30_000 })
      await p.waitForSelector('.ed-stage-scale', { timeout: 30_000 })
      await p.waitForFunction(() => !document.getElementById('slidomingo-splash'), null, { timeout: 15_000 }).catch(() => {})
      const opfs = await p.evaluate(async (svg) => {
        try {
          const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('icons', { create: true })
          const sub = await dir.getDirectoryHandle('arrows', { create: true })
          // an icons.json, as an exported icon set carries (iconset.ts iconManifest)
          const manifest = JSON.stringify({ format: 'slidomingo-icons', version: 1, name: 'Mine', license: 'CC-BY-4.0', author: 'Icon Maker',
            icons: [{ file: 'sun.svg', name: 'sun', keywords: ['daylight'] }] })
          for (const [d, name, data] of [[dir, 'sun.svg', svg], [sub, 'arrow-left.svg', svg], [dir, 'readme.txt', 'not an icon'], [dir, 'icons.json', manifest]]) {
            const w = await (await d.getFileHandle(name, { create: true })).createWritable()
            await w.write(data); await w.close()
          }
          return true
        } catch (e) { return String(e) }
      }, svgOf('#0a0'))
      if (opfs !== true) {
        console.log(`  skip  local folder — no OPFS here (${opfs})`)
      } else {
        await p.evaluate((K) => { localStorage.setItem(K.mode, 'folder') }, KEYS)
        await p.reload()
        await p.waitForFunction(() => !!window.slidomingo?.loadDoc, null, { timeout: 30_000 })
        await p.waitForSelector('.ed-stage-scale', { timeout: 30_000 })
        await p.waitForFunction(() => !document.getElementById('slidomingo-splash'), null, { timeout: 15_000 }).catch(() => {})
        await p.waitForTimeout(400)
        await p.evaluate(() => {
          const d = JSON.parse(JSON.stringify(window.slidomingo.doc))
          d.slides = [{ ...d.slides[0], id: 's1', elements: [] }]
          window.slidomingo.loadDoc(JSON.stringify(d))
        })

        await openPopover(p)
        check(/No folder chosen/.test(await statusOf(p)), 'folder mode with no folder chosen says so', await statusOf(p))
        await closePopover(p)
        const nv = await settingsTest(p)
        check(/^✗ .*No folder chosen yet/.test(nv), 'Test with no folder → ✗ No folder chosen yet', nv)

        await p.locator('button:visible[title^="Settings"]').first().click()
        await p.waitForSelector('.ed-settings-overlay')
        await p.locator('.ed-settings-navitem', { hasText: 'Icon library' }).click()
        await p.locator('button:has-text("Choose folder")').click()
        await p.waitForFunction(() => /Folder: icons/.test(document.querySelector('.ed-settings-content')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {})
        check(/Folder: icons/.test(await p.locator('.ed-settings-content').innerText()), 'Choose folder… remembers the folder (shown as "Folder: icons")')
        const fv = await clickTest(p)
        check(fv === '✓ Works — the search returned 2 icons', 'Test on the folder → ✓ 2 icons (sub-folder included, readme.txt not)', fv)
        await p.keyboard.press('Escape')

        await openPopover(p)
        let c = await cells(p)
        check(c.map((x) => x.label).sort().join() === 'arrow-left,sun', 'folder search walks sub-folders and lists only image files (readme.txt skipped)', c.map((x) => x.label))
        check(c.every((x) => x.src.startsWith('blob:')) && await thumbsLoaded(p), 'folder thumbnails are blob: URLs that decode')
        await typeQuery(p, 'arrow')
        c = await cells(p)
        check(c.length === 1 && c[0].label === 'arrow-left', 'folder search is a filename substring match', c.map((x) => x.label))
        await clickCell(p, 'arrow-left')
        const els = await slideEls(p)
        check(els.length === 1 && els[0].type === 'svg', 'inserting from the folder creates an svg element', els)
        // the icons.json: its keywords are searched, its licence travels with the icon
        await closePopover(p)
        await openPopover(p)
        await typeQuery(p, 'daylight')
        c = await cells(p)
        check(c.length === 1 && c[0].label === 'sun', 'icons.json keywords are searched (daylight → sun)', c.map((x) => x.label))
        await clickCell(p, 'sun')
        const sunEl = (await slideEls(p)).at(-1)
        check(sunEl?.provenance?.license === 'CC-BY-4.0' && sunEl.provenance.author === 'Icon Maker', 'the manifest licence and author travel with the inserted icon', sunEl?.provenance)
        if (shots) await p.screenshot({ path: join(shots, 'icons-folder.png') })

        // folder + server in ONE search
        const both = await mockServer({ only: ['star'] })
        await closePopover(p)
        await p.evaluate(([K, list]) => localStorage.setItem(K.sources, list), [KEYS, JSON.stringify([
          { id: 'dir', kind: 'folder', name: 'Folder', enabled: true }, srvSource('b', 'Server', both.base)])])
        await openPopover(p)
        c = await cells(p)
        check(c.map((x) => x.label).sort().join() === 'arrow-left,star,sun', 'a folder and a server are searched together', c.map((x) => x.label))
        check(c.find((x) => x.label === 'star')?.title.endsWith('· Server') && c.find((x) => x.label === 'sun')?.title.endsWith('· Folder'), 'each icon says which source it came from', c.map((x) => x.title))
        await both.close()
      }
    } finally {
      await fctx.close().catch(() => {})
      rmSync(profile, { recursive: true, force: true })
    }
  }


  // 8) several sources ———————————————————————————————————————————————————
  console.log('\nseveral sources')
  {
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const alpha = await mockServer({ only: ['star', 'circle'] })
    const beta = await mockServer({ only: ['dot'] })
    const idle = await mockServer()
    let p = await bootSources(ctx2, [srvSource('a', 'Alpha', alpha.base), srvSource('b', 'Beta', beta.base), srvSource('c', 'Idle', idle.base, { enabled: false })])
    await openPopover(p)
    let c = await cells(p)
    check(c.map((x) => x.label).sort().join() === 'circle,dot,star', 'results from every switched-on source appear together', c.map((x) => x.label))
    check(c.find((x) => x.label === 'dot')?.title.endsWith('· Beta') && c.find((x) => x.label === 'star')?.title.endsWith('· Alpha'), 'tooltips name the source', c.map((x) => x.title))
    check(idle.log.length === 0, 'a switched-off source is never contacted', idle.log)
    const opts = await p.locator('.ed-icon-source option').allInnerTexts()
    check(opts.join('|') === 'All sources|Alpha|Beta', 'a picker lists "All sources" and only the switched-on ones', opts)
    check(/Alpha, Beta/.test(await p.locator('.ed-icon-hint').innerText()), 'the hint names what is being searched')
    await p.locator('.ed-icon-source').selectOption({ label: 'Beta' })
    await settled(p)
    c = await cells(p)
    check(c.length === 1 && c[0].label === 'dot', 'picking one source narrows the search to it', c.map((x) => x.label))
    await p.locator('.ed-icon-source').selectOption({ label: 'All sources' })
    await settled(p)
    check((await cells(p)).length === 3, 'back to All sources')
    await closePopover(p); await p.close()

    // one source failing does not hide the others
    const deadSrv = await mockServer(); const deadBase = deadSrv.base; await deadSrv.close()
    p = await bootSources(ctx2, [srvSource('x', 'Broken', deadBase), srvSource('a', 'Alpha', alpha.base)])
    await openPopover(p)
    c = await cells(p)
    const probs = await p.locator('.ed-icon-problem').allInnerTexts()
    check(c.length === 2 && probs.length === 1 && /^Broken: can't reach/.test(probs[0]), 'a failing source is listed by name beside the other\'s results', { cells: c.map((x) => x.label), probs })
    if (shots) await p.screenshot({ path: join(shots, 'icons-popover-multi.png') })
    await closePopover(p); await p.close()

    // nothing switched on
    p = await bootSources(ctx2, [srvSource('a', 'Alpha', alpha.base, { enabled: false })])
    await openPopover(p)
    check(/No icon source is switched on/.test(await statusOf(p)), 'with every source off the popover says how to turn one on', await statusOf(p))
    await closePopover(p); await p.close()

    // Settings: add, name, test, switch off, remove — and it all survives a reload
    p = await bootSources(ctx2, [srvSource('a', 'Alpha', alpha.base)])
    await p.locator('button:visible[title^="Settings"]').first().click()
    await p.waitForSelector('.ed-settings-overlay')
    await p.locator('.ed-settings-navitem', { hasText: 'Icon library' }).click()
    check((await p.locator('.ed-isrc').count()) === 1 && (await p.locator('.ed-isrc-name').first().inputValue()) === 'Alpha', 'Settings lists each source as a card')
    await p.locator('button', { hasText: 'Add icon server' }).click()
    check((await p.locator('.ed-isrc').count()) === 2, 'Add icon server adds a card')
    const card2 = p.locator('.ed-isrc').nth(1)
    check(await card2.locator('input[placeholder="Server URL"]').evaluate((e) => e === document.activeElement), 'the new card\'s URL field has focus')
    check(/Enter the server URL first/.test(await clickTest(p, 1)), 'Test on a new card without a URL says so')
    await card2.locator('input[placeholder="Server URL"]').fill(beta.base)
    await card2.locator('.ed-isrc-name').fill('Beta')
    await card2.locator('.ed-isrc-name').press('Tab')
    const v2 = await clickTest(p, 1)
    check(v2 === '✓ Works — the search returned 1 icons', 'the new source tests green', v2)
    let st = await sourcesStored(p)
    check(st?.length === 2 && st[1].name === 'Beta' && st[1].url === beta.base && st[1].enabled === true, 'edits are stored as they are made', st)
    await p.locator('.ed-isrc').nth(0).locator('.ed-switch').click()
    st = await sourcesStored(p)
    check(st[0].enabled === false && (await p.locator('.ed-isrc').nth(0).getAttribute('class')).includes('off'), 'the switch turns a source off (stored, card dimmed)')
    await p.keyboard.press('Escape')
    await p.close()
    p = await boot(ctx2, null) // a later session: same storage, nothing re-seeded
    await p.locator('button:visible[title^="Settings"]').first().click()
    await p.waitForSelector('.ed-settings-overlay')
    await p.locator('.ed-settings-navitem', { hasText: 'Icon library' }).click()
    check((await p.locator('.ed-isrc').count()) === 2 && (await p.locator('.ed-isrc').nth(0).getAttribute('class')).includes('off'), 'both cards and the off state survive a reload')
    p.once('dialog', (d) => d.dismiss())
    await p.locator('.ed-isrc').nth(1).locator('.ed-isrc-remove').click()
    check((await p.locator('.ed-isrc').count()) === 2, 'declining the confirmation keeps the source')
    p.once('dialog', (d) => d.accept())
    await p.locator('.ed-isrc').nth(1).locator('.ed-isrc-remove').click()
    await p.waitForTimeout(200)
    st = await sourcesStored(p)
    check((await p.locator('.ed-isrc').count()) === 1 && st.length === 1 && st[0].id === 'a', 'removing a source takes its card and its settings', st)
    p.once('dialog', (d) => d.accept())
    await p.locator('.ed-isrc-remove').click()
    check(/No icon sources yet/.test(await p.locator('.ed-isrc-list').innerText()), 'with none left the list says how to add one')
    if (shots) await p.screenshot({ path: join(shots, 'icons-settings-empty.png') })
    await p.close()

    // the old single-source settings carry over
    p = await boot(ctx2, { url: alpha.base, token: 'tok-1' })
    await openPopover(p) // first use migrates
    st = await sourcesStored(p)
    check(st?.length === 1 && st[0].kind === 'server' && st[0].url === alpha.base && st[0].token === 'tok-1' && st[0].enabled, 'legacy URL + token migrate into a one-server source list', st)
    await p.close()
    p = await boot(ctx2, { mode: 'folder' })
    await openPopover(p) // first use migrates
    st = await sourcesStored(p)
    check(st?.length === 1 && st[0].kind === 'folder' && st[0].id === 'dir' && st[0].enabled, 'legacy folder mode migrates to a folder source (keeps its remembered handle id)', st)
    await p.close()
    p = await boot(ctx2, {})
    await openPopover(p) // first use migrates
    st = await sourcesStored(p)
    check(st?.length === 1 && st[0].url === 'http://localhost:5050', 'a fresh install starts with the default server', st)
    await p.close()
    await ctx2.close()
    await alpha.close(); await beta.close(); await idle.close()
  }

  check(errors.length === 0, 'no page errors', errors)
} catch (e) {
  fails++
  console.log(`FAIL the rig threw: ${e.stack ?? e}`)
} finally {
  await browser.close()
}
console.log(`\ntest-icons-e2e: ${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
