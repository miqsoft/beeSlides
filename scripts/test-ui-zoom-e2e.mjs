#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// UI zoom in a real browser (docs/DECISIONS.md 2026-10-11):
//   node scripts/test-ui-zoom-e2e.mjs [url]
// url defaults to the built editor (slides/dist-single, npm run build:single
// first); pass http://localhost:<port>/ for a dev server. Needs playwright-core
// ($PLAYWRIGHT_CORE, the package, or the npx cache); SKIPS with exit 0 without.
// Checks: ⌘/Ctrl + − 0 are left to the browser (never preventDefault-ed, so
// native page zoom works; desktop handles them in View ▸ Zoom) and no longer
// move the slide canvas; the canvas still zooms with its bar and ⌘/Ctrl+wheel;
// Settings opens bigger than the rest of the UI (zoom 1.25, still filling the
// window) and at 1× on a phone-width window.
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
async function loadChromium() {
  const tries = []
  if (process.env.PLAYWRIGHT_CORE) tries.push(pathToFileURL(process.env.PLAYWRIGHT_CORE).href)
  tries.push('playwright-core')
  const npx = join(homedir(), '.npm/_npx')
  if (existsSync(npx)) for (const d of readdirSync(npx)) {
    const p = join(npx, d, 'node_modules/playwright-core/index.mjs')
    if (existsSync(p)) tries.push(pathToFileURL(p).href)
  }
  for (const spec of tries) { try { return (await import(spec)).chromium } catch { /* next */ } }
  return null
}
const skip = (why) => { console.log(`test-ui-zoom-e2e: SKIP — ${why}`); process.exit(0) }
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = process.argv[2] ?? (existsSync(built) ? pathToFileURL(built).href : null)
if (!url) skip('no build (npm run build:single in slides/) and no url given')
const chromium = await loadChromium()
if (!chromium) skip('playwright-core not found (set PLAYWRIGHT_CORE)')
let browser
try { browser = await chromium.launch({ headless: true }) } catch (e) { skip(`no browser: ${String(e.message).split('\n')[0]}`) }

let fails = 0, passes = 0
const check = (ok, label, detail) => {
  if (ok) { passes++; console.log(`  ok    ${label}`) }
  else { fails++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`) }
}

async function boot(width, height) {
  const p = await browser.newPage({ viewport: { width, height } })
  p.on('pageerror', (e) => check(false, 'no page errors', e.message))
  await p.goto(url)
  await p.waitForFunction(() => !!window.slidomingo?.loadDoc, null, { timeout: 30_000 })
  await p.waitForSelector('.ed-stage-scale', { timeout: 30_000 })
  await p.waitForFunction(() => !document.getElementById('slidomingo-splash'), null, { timeout: 15_000 }).catch(() => {})
  await p.waitForTimeout(500)
  return p
}

try {
  let p = await boot(1440, 900)
  console.log('\nkeys are left to the browser')
  await p.evaluate(() => { window.__prevented = []; window.addEventListener('keydown', (e) => { if (/^[=+\-0]$/.test(e.key)) window.__prevented.push([e.key, e.ctrlKey || e.metaKey, e.defaultPrevented]) }) })
  const zoomLabel = () => p.locator('.ed-zoomlabel').innerText()
  const before = await zoomLabel()
  for (const mod of ['Control', 'Meta']) {
    for (const k of ['=', '+', '-', '0']) { await p.keyboard.down(mod); await p.keyboard.press(k); await p.keyboard.up(mod) }
  }
  const seen = await p.evaluate(() => window.__prevented)
  check(seen.length === 8 && seen.every(([, mod]) => mod), 'the chords reach the page', seen)
  check(seen.every(([, , prevented]) => prevented === false), 'none is preventDefault-ed — native zoom (browser) / View ▸ Zoom (desktop) can act', seen)
  check((await zoomLabel()) === before, `the slide canvas did not move (${before})`, await zoomLabel())

  console.log('\nthe canvas still zooms its own way')
  const bar = p.locator('.ed-zoombtn')
  await bar.filter({ hasText: '+' }).click()
  const z1 = await zoomLabel()
  check(z1 !== before, 'the zoom bar "+" zooms the canvas', { before, z1 })
  await bar.filter({ hasText: '−' }).click()
  await p.locator('.ed-zoomlabel').click()
  check((await zoomLabel()) === before, 'the % button resets it')
  const box = await p.locator('.ed-stage').boundingBox()
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await p.keyboard.down('Control'); await p.mouse.wheel(0, -300); await p.keyboard.up('Control')
  await p.waitForTimeout(300)
  check((await zoomLabel()) !== before, 'Ctrl+wheel zooms the canvas', await zoomLabel())
  const tips = await bar.evaluateAll((bs) => bs.map((b) => b.title))
  check(!tips.some((t) => /[⌘]|Ctrl/.test(t)), 'zoom-bar tooltips no longer advertise the shortcuts', tips)

  console.log('\nSettings is bigger by default')
  await p.locator('button:visible[title^="Settings"]').first().click()
  await p.waitForSelector('.ed-settings-overlay')
  const m = await p.evaluate(() => {
    const r = document.querySelector('.ed-settings-box').getBoundingClientRect()
    return { w: r.width, h: r.height, zoom: getComputedStyle(document.querySelector('.ed-settings-box')).zoom, iw: innerWidth, ih: innerHeight,
      navItem: document.querySelector('.ed-settings-navitem').getBoundingClientRect().height }
  })
  check(m.zoom === '1.25', 'Settings is scaled 1.25× on top of the UI', m)
  check(Math.abs(m.w - m.iw) < 1 && Math.abs(m.h - m.ih) < 1, 'and still fills the window', m)
  await p.close()

  p = await boot(600, 800)
  await p.locator('button:visible[title^="Settings"]').first().click().catch(async () => { await p.keyboard.press('Control+,') })
  await p.waitForSelector('.ed-settings-overlay')
  const z = await p.evaluate(() => getComputedStyle(document.querySelector('.ed-settings-box')).zoom)
  check(z === '1', 'on a phone-width window it stays 1×', z)
  await p.close()
} catch (e) {
  fails++
  console.log(`FAIL the rig threw: ${e.stack ?? e}`)
} finally {
  await browser.close()
}
console.log(`\ntest-ui-zoom-e2e: ${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
