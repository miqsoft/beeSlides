#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// One drawing, a different state per slide: svg `vars`, the shared clock for
// endless svg CSS animations, and `fx.loop.origin` — in a real (headless)
// browser, against the four-season demo deck (scripts/lib/seasons-scene.mjs:
// a tree that sways in the wind; spring blossoms, summer green and fruit,
// autumn leaves falling, a winter dusk with snow).
//
//   node scripts/test-svg-vars-e2e.mjs [editor-url] [--shots dir] [--save file]
//
// editor-url defaults to slides/dist-single/BeeSlides.beeslides.html. --save
// writes the four-season deck as a .beeslides.html to open and present by
// hand. Needs playwright-core ($PLAYWRIGHT_CORE, the package, or the npx
// cache); without one or without a build it SKIPS with exit 0 and says so.
//
// Editor: the vars reach the artwork as custom properties; thumbnails (an
//   <img>, where nothing inherits) carry them as the svg's own root rule;
//   a hostile value in an opened file is never rendered.
// Show (manual engine clock): the sway runs on the document timeline
//   (startTime 0) on every slide and actually moves; spring → summer by morph
//   blends the leaf colour (mid-morph between the two, at the end summer's)
//   without a crossfade ghost; autumn and winter reach their states; a wiggle
//   with origin:bottom on a ROTATED element keeps its bottom-centre fixed
//   while the top swings, and sits exactly on its model frame. Arrival: an
//   all-endless drawing keeps its nodes (re-aligned, never re-cloned); one
//   with a finite animation is cloned so it replays on every visit. Slides
//   off screen hold no svg animations (parked); the one just left stays
//   paused until its transition is surely over.
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { SEASONS, seasonsDeck } from './lib/seasons-scene.mjs'

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

const skip = (why) => { console.log(`test-svg-vars-e2e: SKIP — ${why}`); process.exit(0) }
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
const rgb = (h) => `rgb(${hex(h).join(', ')})`
const [SPRING, SUMMER] = SEASONS

/** the demo deck plus a rotated stem that wiggles about its foot, and a drawing that fades in once */
function testDeck(base) {
  const d = seasonsDeck(base)
  d.slides.push({
    id: 'pivot', background: '#101418', transition: 'none', name: 'Pivot',
    elements: [{
      id: 'stem', type: 'shape', shape: 'rect', fill: '#7cc957', x: 600, y: 160, w: 80, h: 400,
      rotation: 30, opacity: 1, fx: { loop: { type: 'wiggle', amount: 12, duration: 2, origin: 'bottom' } },
    }],
  })
  d.assets.once = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.once{animation:once-in 30s linear forwards}'
    + '@keyframes once-in{from{opacity:0}to{opacity:1}}</style><rect class="once" width="100" height="100" fill="#e0a030"/></svg>'
  d.slides.push({
    id: 'once', background: '#101418', transition: 'none', name: 'Once',
    elements: [{ id: 'drawon', type: 'svg', asset: 'once', alt: 'A square', x: 440, y: 160, w: 400, h: 400, rotation: 0, opacity: 1 }],
  })
  return d
}

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
  const load = async (doc) => {
    const ok = await p.evaluate((json) => window.slidomingo.loadDoc(json), JSON.stringify(doc))
    await p.waitForTimeout(600)
    return ok
  }

  // An opened FILE is not run through untrusted.ts (paste and agent writes are;
  // scripts/test-sanitize.ts pins that half) — so render must judge every var
  // again on its own, and that is what this measures.
  console.log('— render: a hostile var in a file never reaches the page')
  {
    const hostile = seasonsDeck(base)
    hostile.slides[0].elements[0].vars = {
      leaf1: 'red;}body{display:none', 'sky-top': 'url(https://evil.example/x.svg)', bark: '"x"',
      '--bad': 1, 'ok-name': 2, wind: 0.5,
    }
    await load(hostile)
    const style = await p.evaluate(() => document.querySelector('.ed-stage-scale [data-el-id="scene"]')?.getAttribute('style') ?? '')
    const thumb = await p.evaluate(() =>
      [...document.querySelectorAll('img')].map((i) => decodeURIComponent(i.getAttribute('src') ?? ''))
        .find((s) => s.includes('--ok-name')) ?? '')
    const bad = /evil|display:none|--leaf1|--sky-top|--bark|---bad/
    check(style.includes('--ok-name: 2') && style.includes('--wind: 0.5') && !bad.test(style),
      'the frame gets only the plain tokens', style)
    const rootRule = thumb.match(/<style>:root\{[^}]*\}/)?.[0] ?? ''
    check(rootRule === '<style>:root{--ok-name:2;--wind:0.5}' && !/evil|display:none/.test(thumb), 'and so does the thumbnail', rootRule)
    check(thumb.includes('*{animation-play-state:paused!important}'), 'a thumbnail holds still (its animations are paused)')
  }

  if (saveTo) {
    await load(seasonsDeck(base))
    const html = await p.evaluate(async () => await window.slidomingo.serialize())
    writeFileSync(saveTo, html)
    console.log(`  saved the four-season deck to ${saveTo}`)
  }

  await load(testDeck(base))

  console.log('— editor: vars reach the artwork')
  {
    const r = await p.evaluate(() => {
      const node = document.querySelector('.ed-stage-scale [data-el-id="scene"]')
      const leaf = node?.querySelector('path.s1')
      return { prop: node?.style.getPropertyValue('--leaf1'), fill: leaf ? getComputedStyle(leaf).fill : null }
    })
    check(r.prop === SPRING.vars.leaf1, 'the frame carries --leaf1', r)
    check(r.fill === rgb(SPRING.vars.leaf1), 'a leaf is painted with it', r)
    const thumbs = await p.evaluate(() =>
      [...document.querySelectorAll('img')].map((i) => decodeURIComponent(i.getAttribute('src') ?? ''))
        .filter((s) => s.startsWith('data:image/svg+xml') && s.includes('class="sw"')))
    check(thumbs.some((s) => s.includes(`--leaf1:${SUMMER.vars.leaf1};`)) && thumbs.some((s) => s.includes('--snow:1;')),
      'thumbnails carry each slide\'s own vars as the svg\'s root rule', thumbs.length)
    if (shots) {
      await p.evaluate(() => window.slidomingo.select?.([]))
      await p.screenshot({ path: join(shots, 'editor-spring.png') })
    }
  }

  // ---------------------------------------------------------------- the show
  await p.evaluate(() => { window.slidomingo.anim.setManual(true) })
  await p.evaluate(() => { try { localStorage.setItem('slidomingo-reduce-motion', 'off') } catch {} })
  await p.click('button[title="More ways to present"]:visible')
  await p.click('button:has-text("Present in this tab"):visible')
  await p.waitForSelector('.slidomingo-present-overlay section.present', { timeout: 10_000 })
  await p.waitForTimeout(600)
  const tick = (s) => p.evaluate((sec) => window.slidomingo.anim.tick(sec), s)
  const key = async (k) => { await p.keyboard.press(k); await p.waitForTimeout(80) }
  const inShow = (fn, arg) => p.evaluate(fn, arg)
  const scene = '.slidomingo-present-overlay section.present [data-el-id="scene"]'
  const sway = () => inShow((sel) => {
    const g = document.querySelector(`${sel} .sw`)
    const a = g?.getAnimations()[0]
    return a ? { start: a.startTime, current: a.currentTime, now: document.timeline.currentTime, transform: getComputedStyle(g).transform } : null
  }, scene)

  console.log('— show: the wind runs on the show clock')
  {
    const s = await sway()
    check(s && s.start === 0 && Math.abs(s.current - s.now) < 1, 'spring: the endless sway starts at the timeline origin', s)
    const states = await inShow(() => {
      const out = { here: 0, hereRunning: 0, away: 0, awayRunning: 0 }
      for (const sec of document.querySelectorAll('.slidomingo-present-overlay .reveal .slides section')) {
        const here = sec.classList.contains('present')
        for (const a of sec.getAnimations({ subtree: true })) {
          out[here ? 'here' : 'away']++
          if (a.playState === 'running') out[here ? 'hereRunning' : 'awayRunning']++
        }
      }
      return out
    })
    check(states.here > 100 && states.hereRunning === states.here, 'the slide on screen animates its drawing', states)
    check(states.away === 0, 'the slides Reveal keeps mounted next to it hold no animations at all (parked: no layer each)', states)
    await p.waitForTimeout(700)
    const later = await sway()
    check(s && later && s.transform !== later.transform && /matrix/.test(later.transform),
      'and it moves: var(--wind) inside the keyframes resolves', { a: s?.transform, b: later?.transform })
    if (shots) await p.screenshot({ path: join(shots, 'show-spring.png') })
  }

  console.log('— show: spring → summer blends, no crossfade')
  {
    // summer is mounted (paused) next to spring: mark its drawing's nodes
    await inShow(() => {
      const g = document.querySelector('.slidomingo-present-overlay section:not(.present) [data-slide-id="summer"] [data-el-id="scene"] .sw')
      if (g) g.__kept = true
    })
    await key('ArrowRight')
    check(await inShow((sel) => document.querySelector(`${sel} .sw`)?.__kept === true, scene),
      'an all-endless drawing keeps its nodes on arrival (re-aligned, not re-cloned)')
    const leaving = () => inShow(() => {
      const sec = document.querySelector('.slidomingo-present-overlay [data-slide-id="spring"]')?.closest('section')
      const all = sec ? sec.getAnimations({ subtree: true }) : []
      return { n: all.length, running: all.filter((a) => a.playState === 'running').length }
    })
    const justLeft = await leaving()
    check(justLeft.n > 100 && justLeft.running === 0, 'the slide just left is only paused while it could still be fading (frozen pose)', justLeft)
    await tick(1.1) // half of morphSeconds 2.2
    const mid = await inShow((sel) => {
      const node = document.querySelector(sel)
      const sec = document.querySelector('.slidomingo-present-overlay section.present')
      // what the drawing PAINTS with, not what was written
      const seen = (k) => (node ? getComputedStyle(node).getPropertyValue(k).trim() : null)
      const leaf = node?.querySelector('path.s1')
      return {
        slide: sec?.querySelector('.slidomingo-slide')?.getAttribute('data-slide-id'),
        leaf: leaf ? getComputedStyle(leaf).fill : null,
        blossom: seen('--blossom'),
        sunX: seen('--sun-x'),
        ghosts: sec ? sec.querySelectorAll('.slidomingo-el-svg:not([data-el-id])').length : -1,
      }
    }, scene)
    const c = (mid.leaf ?? '').match(/\d+(\.\d+)?/g)?.map(Number) ?? []
    const [a, b] = [hex(SPRING.vars.leaf1), hex(SUMMER.vars.leaf1)]
    const inside = (v, x, y) => v > Math.min(x, y) && v < Math.max(x, y)
    check(mid.slide === 'summer', 'the show is on summer', mid)
    check(c.length >= 3 && inside(c[0], a[0], b[0]) && inside(c[1], a[1], b[1]), 'mid-morph the leaf colour is between spring and summer', mid)
    const bl = Number(mid.blossom)
    check(bl > 0.05 && bl < 0.95, 'mid-morph the blossoms are fading', mid)
    check(inside(Number(mid.sunX), SUMMER.vars['sun-x'], SPRING.vars['sun-x']), 'the sun is on its way across the sky', mid)
    check(mid.ghosts === 0, 'no crossfade ghost: only vars changed', mid)
    if (shots) await p.screenshot({ path: join(shots, 'show-spring-to-summer-mid.png') })
    await tick(1.5)
    const end = await inShow((sel) => {
      const leaf = document.querySelector(`${sel} path.s1`)
      return leaf ? getComputedStyle(leaf).fill : null
    }, scene)
    check(end === rgb(SUMMER.vars.leaf1), 'after the morph the leaves are summer green', end)
    await p.waitForTimeout(1700) // present.ts PARK_AFTER_MS (a real timer, not the engine clock)
    const later = await leaving()
    check(later.n === 0, 'once its transition is surely over it is parked: no animations left', later)
    const s = await sway()
    check(s && s.start === 0, 'summer: the sway is still on the show clock (same pose as the slide before)', s)
    if (shots) { await p.waitForTimeout(400); await p.screenshot({ path: join(shots, 'show-summer.png') }) }
  }

  console.log('— show: autumn and winter')
  {
    await key('ArrowRight')
    await tick(3)
    const autumn = await inShow((sel) => {
      const box = document.querySelector(`${sel} .falling`)
      const leaf = box?.querySelector('.tumble')
      return box ? { op: getComputedStyle(box).opacity, anim: leaf?.getAnimations()[0]?.startTime } : null
    }, scene)
    check(autumn && Number(autumn.op) > 0.99 && autumn.anim === 0, 'autumn: falling leaves are visible and on the show clock', autumn)
    if (shots) { await p.waitForTimeout(400); await p.screenshot({ path: join(shots, 'show-autumn.png') }) }
    await key('ArrowRight')
    await tick(3)
    const winter = await inShow((sel) => {
      const n = document.querySelector(sel)
      return {
        leaves: n ? getComputedStyle(n.querySelector('path.la')).opacity : null,
        snow: n ? getComputedStyle(n.querySelector('.snowfall')).opacity : null,
        glow: n ? getComputedStyle(n.querySelector('.win')).opacity : null,
      }
    }, scene)
    check(Number(winter.leaves) < 0.01 && Number(winter.snow) > 0.99 && Number(winter.glow) > 0.99,
      'winter: the crown is bare, it snows, the cabin windows glow', winter)
    if (shots) { await p.waitForTimeout(400); await p.screenshot({ path: join(shots, 'show-winter.png') }) }
  }

  console.log('— show: wiggle about the foot of a rotated element')
  {
    await key('ArrowRight')
    await tick(0.05)
    // where the stem's local points land, through its real computed transform
    const at = () => inShow(() => {
      const n = document.querySelector('.slidomingo-present-overlay section.present [data-el-id="stem"]')
      if (!n) return null
      const cs = getComputedStyle(n)
      const m = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform)
      const [ox, oy] = cs.transformOrigin.split(' ').map(parseFloat)
      const map = (x, y) => {
        const q = m.transformPoint(new DOMPoint(x - ox, y - oy))
        return [n.offsetLeft + ox + q.x, n.offsetTop + oy + q.y]
      }
      return { foot: map(40, 400), top: map(40, 0) }
    })
    // the model frame's own foot: centre (640, 360) + R(30°)·(0, 200)
    const r = Math.PI / 6
    const want = [640 - 200 * Math.sin(r), 360 + 200 * Math.cos(r)]
    const a = await at()
    await tick(0.5)
    const b = await at()
    await tick(0.5)
    const c = await at()
    const near = (u, v) => u && Math.hypot(u[0] - v[0], u[1] - v[1]) < 0.5
    check(a && near(a.foot, want) && near(b.foot, want) && near(c.foot, want), 'the foot stays exactly on the model frame', { a, b, c, want })
    check(a && b && Math.hypot(a.top[0] - b.top[0], a.top[1] - b.top[1]) > 20, 'the top swings', { a, b })
  }

  console.log('— show: a finite svg animation replays on every visit')
  {
    const once = () => inShow(() => {
      const r = document.querySelector('.slidomingo-present-overlay section.present [data-el-id="drawon"] .once')
      const a = r?.getAnimations()[0]
      return r ? { current: a?.currentTime ?? null } : null
    })
    await key('ArrowRight')
    const first = await once()
    await p.waitForTimeout(900)
    await key('ArrowLeft')
    await key('ArrowRight')
    const again = await once()
    check(first && typeof first.current === 'number' && first.current < 800, 'it plays from its start on arrival', first?.current)
    check(again && typeof again.current === 'number' && again.current < 800, 'and from its start again on the next visit', again?.current)
  }

  check(errors.length === 0, 'no page errors', errors)
  await ctx.close()
} finally {
  await browser.close()
}

console.log(`\ntest-svg-vars-e2e: ${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
