#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Live edits during a show, in a real (headless) browser from a file:// URL.
// The editor keeps editing its document while the show runs (Claude, a reload
// from disk, undo); the show presents its own copy and takes each new state
// through PresentSession.update (present.ts).
//
//   node scripts/test-present-live-edit-e2e.mjs [--editor editor-file]
//
// Needs playwright-core ($PLAYWRIGHT_CORE, the package, or the npx cache);
// without one or without a build it SKIPS with exit 0 and says so.
//
// Checks: an edit to the slide on screen shows at once, without a slide change
// and at the click it stood at; an edit to another slide leaves the one on
// screen untouched (same DOM); a notes-only edit changes the notes and nothing
// else; a slide inserted before the current one keeps the show where it is and
// navigation (clicks, next, back) stays right; deleting the slide on screen
// cuts to the nearest slide after it; undo brings it back; changing the
// editor's document WITHOUT telling anyone never reaches the show (it runs on
// a copy). Editor commands are blocked while presenting, so an in-place
// store.commit mid-show comes only from an agent write (desktop); it raises
// the same 'doc' event as loadDoc and undo, which is what the editor forwards.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined }
const editorFile = opt('--editor') ?? join(root, 'slides/dist-single/BeeSlides.beeslides.html')

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

const skip = (why) => { console.log(`test-present-live-edit-e2e: SKIP — ${why}`); process.exit(0) }
if (!existsSync(editorFile)) skip('no build (npm run build:single in slides/)')
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

// ---- the deck: four slides; S2 builds over two clicks ---------------------------------
const text = (id, html, y = 60, fx) => ({
  id, type: 'text', x: 80, y, w: 1120, h: 110, rotation: 0, opacity: 1, html, fontSize: 56,
  fontFamily: 'system-ui, sans-serif', fontWeight: 700, color: '#1D1119', align: 'left', valign: 'middle', lineHeight: 1.2,
  ...(fx ? { fx } : {}),
})
const slide = (id, bg, notes, extra = []) => ({ id, background: bg, transition: 'none', elements: [text(`t-${id}`, id), ...extra], notes })
function buildDeck(base) {
  const d = JSON.parse(JSON.stringify(base))
  d.title = 'Live edit deck'
  d.slides = [
    slide('S1', '#FDE2E4', 'notes one'),
    slide('S2', '#E2ECE9', 'notes two', [text('b1', 'first click', 260, { step: 1 }), text('b2', 'second click', 420, { step: 2 })]),
    slide('S3', '#BEE1E6', 'notes three'),
    slide('S4', '#F0EFEB', 'notes four'),
  ]
  d.sections = []
  d.present = {}
  return d
}
const splice = (html, deck) => {
  const json = JSON.stringify(deck).replace(/</g, '\\u003c')
  const out = html.replace(/(<script type="application\/beeslides\+json" id="beeslides-doc">)([\s\S]*?)(<\/script>)/, `$1${json}$3`)
  if (out === html) throw new Error('doc block not found in shell')
  return out
}

// ---- helpers ----------------------------------------------------------------------
const SHOW = '.beeslides-present-overlay'
const cur = (p) => p.evaluate((s) =>
  document.querySelector(`${s} section.present > .beeslides-slide`)?.getAttribute('data-slide-id') ?? null, SHOW)
const curText = (p, elId) => p.evaluate(([s, id]) =>
  document.querySelector(`${s} section.present [data-el-id="${id}"]`)?.textContent?.trim() ?? null, [SHOW, elId])
const builtIn = (p, elId) => p.evaluate(([s, id]) => {
  const n = document.querySelector(`${s} section.present [data-el-id="${id}"]`)
  return !!n && !n.classList.contains('beeslides-build-hidden')
}, [SHOW, elId])
const sectionIds = (p) => p.evaluate((s) =>
  [...document.querySelectorAll(`${s} .slides > section > .beeslides-slide`)].map((n) => n.getAttribute('data-slide-id')), SHOW)
const press = async (p, k) => { await p.keyboard.press(k); await p.waitForTimeout(300) }
/** replace the editor's document the way a reload / an agent round-trip does, then let the show catch up */
const edit = async (p, mutate) => {
  const ok = await p.evaluate(`(() => { const d = JSON.parse(JSON.stringify(window.beeslides.doc)); (${mutate})(d); return window.beeslides.loadDoc(JSON.stringify(d)) })()`)
  await p.waitForTimeout(600)
  return ok
}
/** tag the surface on screen so a later read can tell whether it was re-rendered */
const tagSurface = (p) => p.evaluate((s) => { document.querySelector(`${s} section.present > .beeslides-slide`).__tag = 1 }, SHOW)
const sameSurface = (p) => p.evaluate((s) => document.querySelector(`${s} section.present > .beeslides-slide`)?.__tag === 1, SHOW)
const slideChanges = (p) => p.evaluate(() => window.__changes)

// the base doc comes from the editor shell
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
let p = await ctx.newPage()
await p.goto(pathToFileURL(editorFile).href)
await p.waitForFunction(() => !!window.beeslides?.loadDoc, null, { timeout: 30_000 })
const base = await p.evaluate(() => JSON.parse(JSON.stringify(window.beeslides.doc)))
await p.close()
const dir = mkdtempSync(join(tmpdir(), 'beeslides-live-edit-'))
const file = join(dir, 'live.beeslides.html')
writeFileSync(file, splice(readFileSync(editorFile, 'utf8'), buildDeck(base)))

p = await ctx.newPage()
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
await p.goto(`${pathToFileURL(file).href}#present`)
await p.waitForSelector(`${SHOW} section.present`, { timeout: 30_000 })
await p.waitForTimeout(600)
await p.evaluate(() => document.getElementById('beeslides-splash')?.remove())
// count Reveal slide changes from here on: an edit must never produce one
await p.evaluate((s) => {
  window.__changes = 0
  document.querySelector(`${s} .reveal`).addEventListener('slidechanged', () => { window.__changes++ })
}, SHOW)

check(await cur(p) === 'S1', 'the show starts on slide 1')
await press(p, 'ArrowRight')
await press(p, 'ArrowRight')
check(await cur(p) === 'S2' && await builtIn(p, 'b1') && !(await builtIn(p, 'b2')), 'on S2 at click 1 of 2')

// — an edit to the slide on screen —
let changes = await slideChanges(p)
await edit(p, (d) => { d.slides[1].elements[0].html = 'S2 edited' })
check(await curText(p, 't-S2') === 'S2 edited', 'an edit to the slide on screen shows at once', await curText(p, 't-S2'))
check(await cur(p) === 'S2' && await slideChanges(p) === changes, 'without a slide change')
check(await builtIn(p, 'b1') && !(await builtIn(p, 'b2')), 'and at the click it stood at')

// — an edit to another slide —
await tagSurface(p)
await edit(p, (d) => { d.slides[3].elements[0].html = 'S4 edited' })
check(await sameSurface(p), 'an edit to another slide leaves the one on screen untouched (same DOM)')
check(await p.evaluate((s) => document.querySelectorAll(`${s} .slides > section`)[3].textContent.includes('S4 edited'), SHOW),
  'and the other slide is re-rendered')

// — notes only —
await edit(p, (d) => { d.slides[1].notes = 'new notes two' })
check(await sameSurface(p), 'a notes-only edit does not re-render the slide')
check(await p.evaluate((s) => document.querySelector(`${s} section.present > aside.notes`)?.textContent, SHOW) === 'new notes two',
  'and the notes change')

// — a slide inserted before the one on screen —
// (Reveal itself reports the moved index as a slidechanged; the show ignores
// it — the clicks below prove S2 was not arrived at again, which resets builds)
await edit(p, (d) => { d.slides.unshift({ ...JSON.parse(JSON.stringify(d.slides[0])), id: 'S0', elements: [{ ...d.slides[0].elements[0], id: 't-S0', html: 'S0' }] }) })
check(JSON.stringify(await sectionIds(p)) === JSON.stringify(['S0', 'S1', 'S2', 'S3', 'S4']), 'an inserted slide joins the show in deck order', await sectionIds(p))
check(await cur(p) === 'S2', 'the slide on screen stays on screen though its index moved')
check(await sameSurface(p), 'untouched (same DOM)')
check(await p.evaluate((s) => document.querySelector(`${s} .slide-number`)?.textContent?.trim(), SHOW) === '3 / 5',
  'the slide number counts the new deck', await p.evaluate((s) => document.querySelector(`${s} .slide-number`)?.textContent?.trim(), SHOW))
await press(p, 'ArrowRight')
check(await cur(p) === 'S2' && await builtIn(p, 'b2'), '→ plays the next click of the same slide')
await press(p, 'ArrowRight')
check(await cur(p) === 'S3', '→ then moves on to the next slide')
await press(p, 'ArrowLeft')
check(await cur(p) === 'S2' && await builtIn(p, 'b2'), '← goes back into S2, fully built')
await press(p, 'ArrowRight')

// — the slide on screen is deleted —
check(await cur(p) === 'S3', 'on S3')
await edit(p, (d) => { d.slides = d.slides.filter((s) => s.id !== 'S3') })
check(await cur(p) === 'S4', 'deleting the slide on screen cuts to the nearest slide after it', await cur(p))
check(JSON.stringify(await sectionIds(p)) === JSON.stringify(['S0', 'S1', 'S2', 'S4']), 'and its section is gone', await sectionIds(p))

// — undo —
await p.evaluate(() => window.beeslides.undo())
await p.waitForTimeout(600)
check(JSON.stringify(await sectionIds(p)) === JSON.stringify(['S0', 'S1', 'S2', 'S3', 'S4']), 'undo brings it back', await sectionIds(p))
check(await cur(p) === 'S4', 'and the show stays where it is')
await press(p, 'ArrowLeft')
check(await cur(p) === 'S3', '← reaches the restored slide')

// — the show runs on a copy —
await p.evaluate(() => { window.beeslides.doc.slides.find((s) => s.id === 'S3').elements[0].html = 'silent change' })
await p.waitForTimeout(600)
check(await curText(p, 't-S3') === 'S3', 'a change nobody announced never reaches the show', await curText(p, 't-S3'))
await press(p, 'ArrowRight')
await press(p, 'ArrowLeft')
check(await curText(p, 't-S3') === 'S3', 'not even after navigating')

// — the speaker view follows —
const popupP = p.waitForEvent('popup', { timeout: 8000 }).catch(() => null)
await press(p, 's')
const sv = await popupP
if (sv) {
  await p.waitForTimeout(500)
  const thumbs = () => sv.evaluate(() => document.querySelectorAll('.sv-rail .sv-thumb').length)
  const railBefore = await thumbs()
  await edit(p, (d) => {
    d.slides.find((s) => s.id === 'S3').notes = 'speaker sees this'
    d.slides.push({ ...JSON.parse(JSON.stringify(d.slides[0])), id: 'S5', elements: [] })
  })
  check(await sv.evaluate(() => document.querySelector('.sv-notes')?.textContent) === 'speaker sees this',
    'the speaker view shows the edited notes', await sv.evaluate(() => document.querySelector('.sv-notes')?.textContent))
  check(await thumbs() === railBefore + 1, 'and its slide rail has the new slide', [railBefore, await thumbs()])
  await press(p, 's')
} else {
  console.log('  skip  no speaker popup in this browser')
}

// — leave —
await press(p, 'Escape')
check(!(await p.evaluate((s) => !!document.querySelector(s), SHOW)), 'Esc ends the show')
await p.evaluate(() => window.beeslides.loadDoc(JSON.stringify(window.beeslides.doc)))
await p.waitForTimeout(500)
check(errors.length === 0, 'no page errors', errors)

await browser.close()
console.log(`\ntest-present-live-edit-e2e: ${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
