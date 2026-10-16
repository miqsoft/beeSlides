#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// A living scene from ordinary, editable elements only ("A Day at the Lake",
// scripts/lib/lake-scene.mjs): Morph blends gradient and solid fills and text
// colours across four slides while generic loops run on the same elements —
// including ones that ALSO travel between slides (the balloon), where the loop
// must wait for the morph's frame tween instead of fighting it for transform.
//
//   node scripts/test-native-scene-e2e.mjs [editor-url] [--shots dir] [--save file]
//
// editor-url defaults to slides/dist-single/BeeSlides.beeslides.html; --save
// writes the deck as a .beeslides.html. Needs playwright-core
// ($PLAYWRIGHT_CORE, the package, or the npx cache); without one or without a
// build it SKIPS with exit 0 and says so.
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { TIMES, lakeDeck } from './lib/lake-scene.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined }
const shots = opt('--shots')
const saveTo = opt('--save')
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

const skip = (why) => { console.log(`test-native-scene-e2e: SKIP — ${why}`); process.exit(0) }
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : null)
if (!url) skip('no build (npm run build:single in slides/) and no url given')
const chromium = await loadChromium()
if (!chromium) skip('playwright-core not found (set PLAYWRIGHT_CORE)')

let browser
try { browser = await chromium.launch() } catch (e) { skip(`no browser: ${String(e.message).split('\n')[0]}`) }

let fails = 0
let passes = 0
const check = (ok, label, detail) => {
  if (ok) { passes++; console.log(`  ok    ${label}`) }
  else { fails++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`) }
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const channels = (s) => (String(s).match(/\d+(\.\d+)?/g) ?? []).map(Number)
const inside = (v, x, y) => v > Math.min(x, y) && v < Math.max(x, y)
const [MORNING, NOON] = TIMES

try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(url)
  await p.waitForFunction(() => !!window.slidomingo?.loadDoc, null, { timeout: 30_000 })
  await p.waitForTimeout(600)
  await p.evaluate(() => document.getElementById('slidomingo-splash')?.remove())
  const base = await p.evaluate(() => JSON.parse(JSON.stringify(window.slidomingo.doc)))
  await p.evaluate((json) => window.slidomingo.loadDoc(json), JSON.stringify(lakeDeck(base)))
  await p.waitForTimeout(600)

  console.log('— editor: every part is an ordinary element')
  {
    const r = await p.evaluate(() => {
      const s = window.slidomingo.doc.slides[0]
      const ids = s.elements.map((e) => e.id)
      return {
        n: s.elements.length,
        types: [...new Set(s.elements.map((e) => e.type))].sort(),
        drawn: ids.filter((id) => document.querySelector(`.ed-stage-scale [data-el-id="${id}"]`)).length,
        nan: !!document.querySelector('.ed-stage-scale [data-el-id] [x="NaN"], .ed-stage-scale [data-el-id] [width="NaN"]'),
      }
    })
    check(r.types.join() === 'shape,text' && r.n < 60, `${r.n} elements, all shapes and text`, r)
    check(r.drawn === r.n && !r.nan, 'each one is on the canvas with real geometry', r)
    if (saveTo) {
      writeFileSync(saveTo, await p.evaluate(async () => await window.slidomingo.serialize()))
      console.log(`  saved the deck to ${saveTo}`)
    }
    if (shots) {
      await p.evaluate(() => window.slidomingo.select?.([]))
      await p.screenshot({ path: join(shots, 'lake-editor.png') })
    }
  }

  await p.evaluate(() => { window.slidomingo.anim.setManual(true) })
  await p.evaluate(() => { try { localStorage.setItem('slidomingo-reduce-motion', 'off') } catch {} })
  // a desktop-width tab has the menu bar (DECISIONS 2026-10-13): Play ▸ Present in tab;
  // a phone-width one the Slideshow pill's menu
  if (await p.locator('.ed-menubar-top[data-menu="play"]').count()) {
    await p.click('.ed-menubar-top[data-menu="play"]')
    await p.click('.ed-menubar-row[data-command="play.inTab"]')
  } else {
    await p.click('button[title="More ways to present"]:visible')
    await p.click('button:has-text("Present in this tab"):visible')
  }
  await p.waitForSelector('.slidomingo-present-overlay section.present', { timeout: 10_000 })
  await p.waitForTimeout(500)
  const tick = (s) => p.evaluate((sec) => window.slidomingo.anim.tick(sec), s)
  const key = async (k) => { await p.keyboard.press(k); await p.waitForTimeout(80) }
  const node = (id) => `.slidomingo-present-overlay section.present [data-el-id="${id}"]`
  const loopsOf = (id) => p.evaluate((sel) => {
    const n = document.querySelector(sel)
    return n ? window.slidomingo.anim.getTweensOf(n).filter((t) => t.infinite).length : -1
  }, node(id))
  const slideRect = () => p.evaluate(() => document.querySelector('.slidomingo-present-overlay section.present .slidomingo-slide').getBoundingClientRect().toJSON())
  const top = async (id) => {
    const [r, s] = await Promise.all([p.evaluate((sel) => document.querySelector(sel)?.getBoundingClientRect().toJSON(), node(id)), slideRect()])
    return r ? ((r.y - s.y) * 1280) / s.width : null
  }

  console.log('— show: the loops run')
  {
    await tick(1)
    await tick(1) // the wiggle's delay and its first swing-out (finite) come before the endless part
    check(await loopsOf('sails') === 1, 'the windmill spins')
    check(await loopsOf('crown1') === 1, 'the crown wiggles')
    const origin = await p.evaluate((sel) => document.querySelector(sel)?.style.transformOrigin, node('crown1'))
    check(origin === '50% 100%', 'about its foot (origin: bottom)', origin)
    check(await loopsOf('ripple0') === 0 && await p.evaluate((sel) =>
      window.slidomingo.anim.getTweensOf(document.querySelector(sel)?.querySelector('line')).some((t) => t.infinite), node('ripple0')),
    'the ripples march')
    check(await loopsOf('balloon') === 1, 'the balloon floats')
    if (shots) await p.screenshot({ path: join(shots, 'lake-morning.png') })
  }

  console.log('— show: morning → noon')
  {
    const before = await top('balloon')
    await key('ArrowRight')
    await tick(0.05)
    check(await loopsOf('balloon') === 0, 'while the balloon travels, its float waits (no fight over transform)')
    await tick(1.15) // half of morphSeconds 2.4
    const mid = await p.evaluate((sel) => [...document.querySelector(sel).querySelectorAll('stop')].map((s) => s.getAttribute('stop-color')), node('sky'))
    const t0 = channels(mid[0])
    const [m, n] = [hex(MORNING.sky[0]), hex(NOON.sky[0])]
    check(t0.length >= 3 && inside(t0[0], m[0], n[0]) && inside(t0[1], m[1], n[1]), 'mid-morph the sky gradient is between morning and noon', mid)
    const midTop = await top('balloon')
    check(midTop !== null && inside(midTop, before, NOON.balloonAt[1]), 'mid-morph the balloon is on its way up', { before, midTop })
    if (shots) await p.screenshot({ path: join(shots, 'lake-morning-to-noon-mid.png') })
    await tick(1.5)
    await tick(0.2)
    check(await loopsOf('balloon') === 1, 'arrived, it floats again')
    const after = await top('balloon')
    check(after !== null && Math.abs(after - NOON.balloonAt[1]) <= 13, 'from its noon position', { after, want: NOON.balloonAt[1] })
    if (shots) await p.screenshot({ path: join(shots, 'lake-noon.png') })
  }

  console.log('— show: evening and night')
  {
    await key('ArrowRight')
    await tick(3)
    if (shots) await p.screenshot({ path: join(shots, 'lake-evening.png') })
    await key('ArrowRight')
    await tick(3)
    const op = async (id) => Number(await p.evaluate((sel) => getComputedStyle(document.querySelector(sel)).opacity, node(id)))
    const star = await op('star3')
    const fly = await op('fly0')
    const balloon = await op('balloon')
    check(star > 0.2 && await loopsOf('star3') === 1, 'night: the stars are out and twinkle', { star })
    check(fly > 0.9 && balloon < 0.01, 'fireflies on, balloon gone', { fly, balloon })
    if (shots) await p.screenshot({ path: join(shots, 'lake-night.png') })
  }

  check(errors.length === 0, 'no page errors', errors)
  await ctx.close()
} finally {
  await browser.close()
}

console.log(`\ntest-native-scene-e2e: ${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
