#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon-server tokens, the EDITOR's desktop path, in a real browser: the built
// editor with a stub `slidomingoDesktop` whose icon calls are answered by
// this node process standing in for main (it holds the token and makes the
// requests, like desktop/src/main/icontokens.ts). Main's own half is
// scripts/test-icon-tokens-main.ts.
//
//   node scripts/test-icon-tokens-renderer-e2e.mjs [url]
//
// url defaults to slides/dist-single/BeeSlides.beeslides.html. Needs
// playwright-core (same lookup as test-icons-e2e.mjs); SKIPS with exit 0
// without it or a build.
//
// Checks: an old inline token is handed to main and dropped from the page;
// Settings shows "stored" without the token, Test passes against a server
// with NO CORS headers (so the request went through main), thumbnails come
// shrunk from png_url as blob: URLs; a typed token goes to main and the
// field empties; Remove forgets it; the popover searches and inserts through
// main; main's "unreachable" is reported without blaming CORS; the token is
// never in localStorage, the DOM or anything mirrored to main's prefs.
import { createServer } from 'node:http'
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

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

const skip = (why) => { console.log(`test-icon-tokens-renderer-e2e: SKIP — ${why}`); process.exit(0) }
const chromium = await loadChromium()
if (!chromium) skip('no playwright-core (set PLAYWRIGHT_CORE)')
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : skip('no build (npm run build:single in slides/) and no url given'))

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#0a0"/></svg>'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

// the icon server: wants Bearer t-good, and sends NO CORS headers — a page
// fetch would fail, so every success below went through "main"
const hits = []
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  hits.push({ path: u.pathname, size: u.searchParams.get('size'), auth: req.headers.authorization ?? null })
  if (req.headers.authorization !== 'Bearer t-good') { res.writeHead(401).end(); return }
  if (u.pathname === '/lib/api/search') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ results: [{ relative_path: 'cloud.svg', display_name: 'Cloud', png_url: '/png/cloud.svg?size=512' }] }))
  } else if (u.pathname === '/lib/files/cloud.svg') res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(SVG)
  else if (u.pathname === '/lib/png/cloud.svg') res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
  else res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/lib`

// ---- "main": the token store and the requests it makes ----
const tokens = new Map() // id → { root, token }
const calls = { set: [], adopt: [], prefs: [] }
let unreachable = false
let refusal = ''
const rootOf = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, '') } catch { return null } }

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.error(`  FAIL  ${m}`) } }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const pageErrors = []
page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('pageerror', e.message) })
await page.exposeFunction('__mainIconFetch', async (id, u) => {
  if (unreachable) return { ok: false, error: 'unreachable' }
  if (refusal) return { ok: false, error: refusal }
  const t = tokens.get(id)
  const authed = !!t && t.root === rootOf(base) && u.startsWith(base)
  const res = await fetch(u, { headers: authed ? { Authorization: `Bearer ${t.token}` } : {} })
  return { ok: true, status: res.status, contentType: res.headers.get('content-type') ?? '', body: Buffer.from(await res.arrayBuffer()).toString('base64'), authed }
})
await page.exposeFunction('__mainSetToken', (id, u, token) => {
  calls.set.push([id, u, token])
  if (token === null || token === '') tokens.delete(id)
  else tokens.set(id, { root: rootOf(u), token: token.trim() })
  return { ok: true }
})
await page.exposeFunction('__mainStatus', (list) => Object.fromEntries(list.map((s) => [s.id, tokens.get(s.id)?.root === rootOf(s.url)])))
await page.exposeFunction('__mainAdopt', (list) => {
  calls.adopt.push(list)
  for (const t of list) if (!tokens.has(t.id)) tokens.set(t.id, { root: rootOf(t.url), token: t.token })
  return true
})
await page.exposeFunction('__mainPref', (k, v) => { calls.prefs.push([k, v]) })

await page.addInitScript((base) => {
  // what an older build left in this deck's storage: the token inline
  if (!sessionStorage.getItem('seeded')) {
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('slidomingo-icon-sources', JSON.stringify([{ id: 'src_lib', kind: 'server', name: 'Lib', enabled: true, url: base, token: 't-good' }]))
  }
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  const impl = {
    setViewerPref: (k, v) => { void window.__mainPref(k, v) },
    iconFetch: async (id, u) => { const r = await window.__mainIconFetch(id, u); return r.ok ? { ...r, body: b64(r.body) } : r },
    setIconToken: (id, u, t) => window.__mainSetToken(id, u, t),
    iconTokenStatus: (list) => window.__mainStatus(list),
    adoptIconTokens: (list) => window.__mainAdopt(list),
  }
  const thenable = () => Promise.resolve(undefined)
  window.slidomingoDesktop = new Proxy(impl, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? () => thenable() : undefined)) })
}, base)
await page.goto(url)
await page.waitForTimeout(1500)
const blank = page.locator('button:visible:has-text("Blank")').first()
if (await blank.count()) await blank.click()
await page.waitForFunction(() => !!window.slidomingo?.doc && !!document.querySelector('.ed-root'), null, { timeout: 15000 })
// the start page's own errors come from the catch-all stub (its template
// list is undefined here), not from anything under test
pageErrors.length = 0

const pageHas = (s) => page.evaluate((s) => JSON.stringify({ ...localStorage }).includes(s) || document.documentElement.outerHTML.includes(s), s)
const openSettings = async () => {
  await page.evaluate(() => window.slidomingo.menu.run('app.settings'))
  await page.locator('.ed-settings-navitem', { hasText: 'Icon library' }).click()
  await page.waitForSelector('.ed-isrc[data-source-id="src_lib"]')
}
const card = () => page.locator('.ed-isrc[data-source-id="src_lib"]')
const runTest = async () => {
  await card().locator('.ed-isrc-result').evaluate((e) => { e.textContent = '' })
  await card().locator('.ed-isrc-head button', { hasText: 'Test' }).click()
  await page.waitForFunction(() => { const t = document.querySelector('.ed-isrc[data-source-id="src_lib"] .ed-isrc-result')?.textContent ?? ''; return t && !/^Testing/.test(t) }, null, { timeout: 15000 })
  return card().locator('.ed-isrc-result').innerText()
}
const placeholder = () => card().locator('input[type=password]').getAttribute('placeholder')

try {
  // ---- migration of the inline token
  await openSettings()
  ok(calls.adopt.length === 1 && calls.adopt[0][0]?.token === 't-good' && calls.adopt[0][0]?.id === 'src_lib', 'the old inline token is handed to main (adopt)')
  ok(!(await pageHas('t-good')), 'and is gone from the page: localStorage and DOM')
  ok(calls.prefs.filter(([k]) => k === 'slidomingo-icon-sources').every(([, v]) => !String(v).includes('t-good') && !String(v).includes('"token"')), 'what is mirrored to main\'s prefs never carries a token (not even an empty key)')
  await page.waitForFunction(() => /stored/.test(document.querySelector('.ed-isrc[data-source-id="src_lib"] input[type=password]')?.placeholder ?? ''), null, { timeout: 5000 }).catch(() => {})
  ok(/stored/.test(await placeholder() ?? '') && (await card().locator('input[type=password]').inputValue()) === '', `the card says a token is stored, the field is empty ("${await placeholder()}")`)
  ok(await card().locator('button', { hasText: 'Remove stored token' }).isVisible(), '"Remove stored token" is shown')
  ok(/encrypted/.test(await card().locator('input[type=password]').getAttribute('title') ?? ''), 'the tooltip says it is stored encrypted')

  // ---- Test through main
  hits.length = 0
  const v1 = await runTest()
  ok(/^✓/.test(v1), `Test passes against a server with no CORS headers (${v1})`)
  ok(hits.length >= 3 && hits.every((h) => h.auth === 'Bearer t-good'), `every request carried the token (${hits.map((h) => h.path).join(' ')})`)
  ok(hits.some((h) => h.path === '/lib/png/cloud.svg' && h.size === '128'), 'the thumbnail came from png_url, shrunk to 128')

  // ---- type a new token, then remove it
  calls.set.length = 0
  await card().locator('input[type=password]').fill('t-typed')
  await card().locator('input[type=password]').dispatchEvent('change')
  await page.waitForFunction(() => document.querySelector('.ed-isrc[data-source-id="src_lib"] input[type=password]')?.value === '', null, { timeout: 5000 }).catch(() => {})
  ok(calls.set.length === 1 && calls.set[0][0] === 'src_lib' && calls.set[0][1] === base && calls.set[0][2] === 't-typed', 'a typed token goes to main with its source and URL')
  ok((await card().locator('input[type=password]').inputValue()) === '' && !(await pageHas('t-typed')), 'the field is emptied and the token is not left in the page')
  hits.length = 0
  const v2 = await runTest()
  ok(/rejected the API token/.test(v2) && hits[0]?.auth === 'Bearer t-typed', `the new token is the one sent; the server rejects it (${v2})`)
  await card().locator('button', { hasText: 'Remove stored token' }).click()
  await page.waitForFunction(() => !/stored/.test(document.querySelector('.ed-isrc[data-source-id="src_lib"] input[type=password]')?.placeholder ?? 'stored'), null, { timeout: 5000 }).catch(() => {})
  ok(calls.set.at(-1)?.[2] === null && !(await card().locator('button', { hasText: 'Remove stored token' }).isVisible()), 'Remove forgets it (main gets null) and the button goes')
  hits.length = 0
  const v3 = await runTest()
  ok(/wants an API token/.test(v3) && hits.every((h) => h.auth === null), `without a token nothing is sent; the card says the server wants one (${v3})`)

  // ---- Test right after typing (no blur first): the token is stored before the test runs
  calls.set.length = 0
  await card().locator('input[type=password]').fill('t-good')
  hits.length = 0
  const v4 = await runTest()
  ok(/^✓/.test(v4) && hits[0]?.auth === 'Bearer t-good', `Test right after typing uses the typed token (${v4})`)

  // ---- the popover: search and insert through main
  await page.locator('.ed-settings-close').click()
  await page.evaluate(() => window.slidomingo.menu.run('insert.icons'))
  await page.waitForSelector('.ed-icon-pop')
  await page.waitForFunction(() => document.querySelectorAll('.ed-icon-pop .ed-icon-grid img').length > 0, null, { timeout: 10000 }).catch(() => {})
  const thumb = await page.locator('.ed-icon-pop .ed-icon-grid img').first().getAttribute('src').catch(() => null)
  ok(!!thumb && thumb.startsWith('blob:'), `the grid shows an authed thumbnail as a blob: URL (${thumb?.slice(0, 20)})`)
  const before = await page.evaluate(() => window.slidomingo.doc.slides[0].elements.length)
  await page.locator('.ed-icon-pop .ed-icon-grid > *').first().click()
  await page.waitForFunction((n) => window.slidomingo.doc.slides[0].elements.length > n, before, { timeout: 10000 }).catch(() => {})
  const added = await page.evaluate(() => window.slidomingo.doc.slides[0].elements.at(-1))
  ok(added?.type === 'svg' && !!added.asset, 'clicking it inserts the svg (fetched through main)')
  await page.keyboard.press('Escape')

  // ---- main could not reach the server: no CORS blame
  unreachable = true
  await openSettings()
  const v5 = await runTest()
  ok(/is the server running/.test(v5) && !/CORS/.test(v5), `"unreachable" from main reads as such, not as CORS (${v5})`)
  unreachable = false

  // ---- main refused the answer (a library sending 51 MB for an empty query)
  refusal = 'the response is too large'
  await openSettings()
  const v6 = await runTest()
  ok(/the response is too large/.test(v6) && !/is the server running/.test(v6), `a refusal from main says what it was (${v6})`)
  refusal = ''

  ok(!(await pageHas('t-good')) && !(await pageHas('t-typed')), 'at the end, no token anywhere in the page')
  ok(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
  server.close()
}
console.log(`\ntest-icon-tokens-renderer-e2e: ${checks - failures} passed, ${failures} failed`)
if (failures) process.exit(1)
