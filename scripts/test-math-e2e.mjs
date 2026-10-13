#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Equations in a real browser (the parts scripts/test-math-palette.ts, which
// is pure, cannot see):
//   node scripts/test-math-e2e.mjs [url] [--shots <dir>]
// url defaults to the built editor, slides/dist-single/BeeSlides.beeslides.html
// (npm run build:single first); pass http://localhost:<port>/ for a dev server.
// Needs playwright-core: $PLAYWRIGHT_CORE (path to its index.mjs), the
// package itself, or the npx cache. Without one (or without a build) it
// SKIPS with exit 0 and says so. Headless only.
// Checks: equations render and honour align (the display <math> is inline);
// invalid TeX shows its source and validate() reports it; Insert ▸ Equation
// creates nothing when cancelled and exactly ONE undo step when applied
// (palette pick + Tab slot); editing an equation is one step, and undo while
// the popover is open only cancels it; the panel's TeX field commits on blur;
// the mini toolbar's ∑ types $…$ into a live text edit; a table cell typesets
// $…$ and its edit shows the source; two equations morph symbol by symbol.
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

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

const skip = (why) => { console.log(`test-math-e2e: SKIP — ${why}`); process.exit(0) }

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

const BOX = { rotation: 0, opacity: 1 }
const eq = (id, over) => ({ id, type: 'math', x: 140, y: 100, w: 1000, h: 160, ...BOX,
  tex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', fontSize: 56, color: '#1D1119', align: 'center', valign: 'middle', ...over })

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(url)
  await p.waitForFunction(() => !!window.slidomingo?.loadDoc, null, { timeout: 30_000 })
  await p.waitForSelector('.ed-stage-scale', { timeout: 30_000 })
  // the boot splash sits in the flow above the editor until it is removed
  await p.waitForFunction(() => !document.getElementById('slidomingo-splash'), null, { timeout: 15_000 }).catch(() => {})
  await p.waitForTimeout(500)
  const settle = (ms = 250) => p.waitForTimeout(ms)
  const load = (slides) => p.evaluate((slides) => {
    const d = JSON.parse(JSON.stringify(window.slidomingo.doc))
    const base = d.slides[0]
    d.slides = slides.map((s, i) => ({ ...base, id: `s${i + 1}`, ...s }))
    window.slidomingo.loadDoc(JSON.stringify(d))
  }, slides)
  const els = () => p.evaluate(() => window.slidomingo.doc.slides[0].elements.map((e) => ({ id: e.id, type: e.type, tex: e.tex, html: e.html, h: e.h, w: e.w })))
  const blank = async () => {
    const box = await p.locator('.ed-stage').boundingBox()
    await p.mouse.click(box.x + 8, box.y + 8, { delay: 80 })
    await settle(200)
  }
  const pick = async (scope, group, tex) => {
    await p.locator(`${scope} .ed-math-tab[data-group="${group}"]`).dispatchEvent('mousedown', { button: 0 })
    await p.locator(`${scope} .ed-math-item[data-tex="${tex.replace(/\\/g, '\\\\')}"]`).dispatchEvent('mousedown', { button: 0 })
  }

  // 1) render + align ----------------------------------------------------------
  console.log('\nrender and align')
  await load([{ elements: [
    eq('m1', {}),
    eq('m2', { y: 320, w: 500, tex: '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', fontSize: 40, align: 'left', inline: true, color: '#0b5394' }),
    eq('m3', { x: 700, y: 320, w: 440, tex: '\\frac{a', fontSize: 40, align: 'right' }),
    eq('m4', { y: 500, w: 500, tex: 'e^{i\\pi} + 1 = 0', fontSize: 48, align: 'right' }),
  ] }])
  await settle(400)
  const geo = await p.evaluate(() => Object.fromEntries(['m1', 'm2', 'm3', 'm4'].map((id) => {
    const n = document.querySelector(`.ed-stage-scale [data-el-id="${id}"]`)
    const b = n?.querySelector('.slidomingo-math-box')
    const m = b?.querySelector('math')
    const nr = n.getBoundingClientRect(), br = b.getBoundingClientRect()
    return [id, { nl: nr.left, nr: nr.right, nc: (nr.left + nr.right) / 2, bl: br.left, br: br.right, bc: (br.left + br.right) / 2, bw: br.width,
      math: !!m, display: m ? getComputedStyle(m).display : null, block: m?.getAttribute('display'), err: b.classList.contains('slidomingo-math-error'), text: b.textContent }]
  })))
  check(geo.m1.math && geo.m1.block === 'block' && (geo.m1.display === 'math' || /inline/.test(geo.m1.display)), 'a display formula typesets, display style kept, laid out inline', geo.m1)
  check(Math.abs(geo.m1.bc - geo.m1.nc) < 2 && geo.m1.bw < (geo.m1.nr - geo.m1.nl) - 50, 'align center: the formula is centred, not stretched', geo.m1)
  check(geo.m2.math && !geo.m2.block && Math.abs(geo.m2.bl - geo.m2.nl) < 2, 'align left + inline style', geo.m2)
  check(geo.m4.math && Math.abs(geo.m4.br - geo.m4.nr) < 2, 'align right', geo.m4)
  check(geo.m3.err && geo.m3.text === '\\frac{a', 'invalid TeX shows its source', geo.m3)
  const v = await p.evaluate(() => window.slidomingo.validate().findings.filter((f) => f.code.startsWith('math-')).map((f) => `${f.code}@${f.element}`))
  check(v.length === 1 && v[0] === 'math-parse-error@m3', 'validate() reports exactly the broken equation', v)
  if (shots) await p.screenshot({ path: join(shots, 'equations-on-slide.png') })

  // 2) Insert ▸ Equation -------------------------------------------------------
  console.log('\ninsert')
  await load([{ elements: [] }])
  await settle()
  const insertBtn = p.locator('button:visible[title^="Add an equation"]').first()
  await insertBtn.click()
  await p.waitForSelector('.ed-math-pop')
  await p.keyboard.press('Escape')
  await settle(200)
  check((await els()).length === 0 && !(await p.locator('.ed-math-pop').count()), 'Esc on a new equation creates nothing')
  await insertBtn.click()
  await p.waitForSelector('.ed-math-pop')
  await p.locator('.ed-math-pop .ed-btn:has-text("Cancel")').click()
  await settle(200)
  check((await els()).length === 0, 'Cancel creates nothing')
  await insertBtn.click()
  await p.waitForSelector('.ed-math-pop')
  await pick('.ed-math-pop', 'structures', '\\frac{}{}')
  await p.keyboard.type('a+b')
  await p.keyboard.press('Tab')
  await p.keyboard.type('c')
  await settle(500)
  const pop = await p.evaluate(() => ({ ta: document.querySelector('.ed-math-pop textarea').value, preview: !!document.querySelector('.ed-math-preview math'), err: document.querySelector('.ed-math-pop .ed-math-err').hidden }))
  check(pop.ta === '\\frac{a+b}{c}' && pop.preview && pop.err, 'palette pick lands in the numerator, Tab jumps to the denominator, preview typesets', pop)
  if (shots) await p.screenshot({ path: join(shots, 'equation-popover.png') })
  await p.keyboard.press('Meta+Enter')
  await settle(300)
  let list = await els()
  check(list.length === 1 && list[0].type === 'math' && list[0].tex === '\\frac{a+b}{c}' && !(await p.locator('.ed-math-pop').count()),
    '⌘↵ inserts one equation', list)
  check(list[0]?.h >= 56 && list[0]?.h < 200, 'the box was fitted to the formula', list[0])
  await p.evaluate(() => window.slidomingo.undo())
  await settle()
  check((await els()).length === 0, 'ONE undo removes the inserted equation')
  await p.evaluate(() => window.slidomingo.redo())
  await settle()

  // 3) edit: double-click, one step; undo while open only cancels ---------------
  console.log('\nedit')
  const node = p.locator('.ed-stage-scale .slidomingo-el-math').first()
  await node.click({ delay: 80 }); await settle(150)
  await node.dblclick({ delay: 80 })
  await p.waitForSelector('.ed-math-pop')
  await p.locator('.ed-math-pop textarea').fill('\\frac{a+b}{c} = d')
  await settle(200)
  const live = await p.evaluate(() => (document.querySelector('.ed-stage-scale .slidomingo-el-math math')?.getAttribute('data-tex')))
  check(live === '\\frac{a+b}{c} = d', 'typing previews live on the canvas', live)
  // the toolbar's undo button: cancels the session, the deck is untouched
  await p.locator('button:visible[title^="Undo"]').first().click()
  await settle(300)
  list = await els()
  check(list.length === 1 && list[0].tex === '\\frac{a+b}{c}' && !(await p.locator('.ed-math-pop').count()),
    'undo while the popover is open cancels it and undoes nothing else', list)
  check(await p.evaluate(() => document.querySelector('.ed-stage-scale .slidomingo-el-math math')?.getAttribute('data-tex')) === '\\frac{a+b}{c}',
    'and the canvas shows the committed formula again')
  await node.dblclick({ delay: 80 })
  await p.waitForSelector('.ed-math-pop')
  await p.locator('.ed-math-pop textarea').fill('\\frac{a+b}{c} = d')
  await p.locator('.ed-math-pop .ed-btn-primary').click()
  await settle(300)
  check((await els())[0].tex === '\\frac{a+b}{c} = d', 'Done applies the edit')
  await p.evaluate(() => window.slidomingo.undo())
  await settle()
  check((await els())[0].tex === '\\frac{a+b}{c}', 'one undo restores the previous TeX')

  // 4) the panel's TeX field ------------------------------------------------------
  console.log('\npanel')
  await node.click({ delay: 80 }); await settle(300)
  const ta = p.locator('.ed-props .ed-math-tex-panel')
  check(await ta.count() === 1, 'the panel shows the TeX field')
  await ta.click()
  await p.keyboard.press('End')
  await p.keyboard.type(' + 1')
  if (shots) await p.screenshot({ path: join(shots, 'equation-panel.png') })
  await p.evaluate(() => document.activeElement.blur())
  await settle(300)
  check((await els())[0].tex === '\\frac{a+b}{c} + 1', 'the panel commits the TeX on blur', (await els())[0])
  await p.evaluate(() => window.slidomingo.undo())
  await settle()
  check((await els())[0].tex === '\\frac{a+b}{c}', 'one undo takes the panel edit back')

  // 5) palette into a live text edit ----------------------------------------------
  console.log('\ntext box palette')
  await load([{ elements: [{ id: 't1', type: 'text', x: 100, y: 80, w: 900, h: 100, ...BOX, html: 'Area', fontSize: 40, fontFamily: '', fontWeight: 400,
    color: '#1D1119', align: 'left', valign: 'top', lineHeight: 1.25 }] }])
  await settle()
  const t1 = p.locator('.ed-stage-scale [data-el-id="t1"]')
  await t1.click({ delay: 80 }); await settle(150)
  await t1.dblclick({ delay: 80 }); await settle(250)
  await p.keyboard.press('Meta+ArrowDown'); await p.keyboard.press('End')
  await p.keyboard.type(' ')
  await p.locator('.ed-minibar button[data-rt="math"]').dispatchEvent('mousedown', { button: 0 })
  await p.waitForSelector('.ed-math-pop-prose')
  await pick('.ed-math-pop-prose', 'structures', '\\sqrt{}')
  await p.keyboard.type('x')
  if (shots) await p.screenshot({ path: join(shots, 'text-palette.png') })
  await p.keyboard.press('Escape') // the palette
  await p.keyboard.press('Escape') // the edit
  await settle(300)
  const t = (await els())[0]
  check(/\$\\sqrt\{x\}\$/.test(t.html ?? ''), 'the ∑ palette types $…$ at the caret (caret lands in the slot)', t.html)
  check(await p.evaluate(() => !!document.querySelector('.ed-stage-scale [data-el-id="t1"] math')), 'and it typesets once the edit ends')

  // 6) table cells ---------------------------------------------------------------------
  console.log('\ntable cells')
  await load([{ elements: [{ id: 'tb', type: 'table', x: 100, y: 200, w: 700, h: 200, ...BOX, columns: [{ w: 1 }, { w: 1 }], header: false,
    rows: [{ cells: [{ html: 'Area' }, { html: '$\\pi r^2$' }] }, { cells: [{ html: 'b' }, { html: 'c' }] }],
    style: { fontSize: 28, color: '#1D1119', borderColor: '#999', borderWidth: 1, cellPadX: 12, cellPadY: 8, radius: 0 } }] }])
  await settle()
  const cellMath = () => p.evaluate(() => !!document.querySelector('.ed-stage-scale [data-el-id="tb"] td[data-r="0"][data-c="1"] math'))
  check(await cellMath(), 'a cell typesets $…$')
  const cell = p.locator('.ed-stage-scale [data-el-id="tb"] td[data-r="0"][data-c="1"]')
  await cell.click({ delay: 80, position: { x: 12, y: 12 } }); await settle(150)
  await cell.dblclick({ delay: 80, position: { x: 12, y: 12 } }); await settle(250)
  check(await p.evaluate(() => document.querySelector('.slidomingo-editing [contenteditable="true"]')?.textContent) === '$\\pi r^2$', 'editing the cell shows its TeX source')
  await p.keyboard.press('Escape'); await settle(300)
  const cellHtml = () => p.evaluate(() => window.slidomingo.doc.slides[0].elements[0].rows[0].cells[1].html)
  check(await cellHtml() === '$\\pi r^2$' && await cellMath(), 'an unchanged edit keeps the source and typesets again')
  await cell.dblclick({ delay: 80, position: { x: 12, y: 12 } }); await settle(250)
  await p.keyboard.press('Meta+ArrowDown'); await p.keyboard.press('End')
  await p.keyboard.type(' m²')
  await p.keyboard.press('Escape'); await settle(300)
  check(await cellHtml() === '$\\pi r^2$ m²' && await cellMath(), 'an edited cell keeps the TeX (not sanitized MathML)', await cellHtml())

  // 7) morph, symbol by symbol -------------------------------------------------------------
  console.log('\nmorph')
  const m = (tex) => eq('mm', { x: 240, y: 260, w: 800, h: 160, fontSize: 72, tex })
  await load([{ elements: [m('a + b = c')], transition: 'fade' }, { elements: [m('b + a = c')], transition: 'morph' }])
  await settle()
  await p.evaluate(() => window.slidomingo.anim.setManual(true))
  await p.locator('button[title="More ways to present"]:visible').click()
  await p.locator('button:has-text("Present in this tab"):visible').click()
  await p.waitForSelector('.reveal section.present', { timeout: 10_000 })
  await settle(500)
  const symX = () => p.evaluate(() => {
    const s = document.querySelector('.reveal section.present [data-flip-id="mm"] [data-sym="a#0"]')
    return s ? s.getBoundingClientRect().left : null
  })
  const a0 = await symX()
  await p.keyboard.press('ArrowRight')
  await settle(350)
  // MORPH_DURATION is 0.65 s (power2.inOut): just under half way through,
  // a travelling symbol sits strictly between its two places
  await p.evaluate(() => window.slidomingo.anim.tick(0.3))
  const aMid = await symX()
  await p.evaluate(() => { for (let i = 0; i < 40; i++) window.slidomingo.anim.tick(0.1) })
  await settle(100)
  const aEnd = await symX()
  check(a0 !== null && aEnd !== null && aEnd > a0 + 20, '"a" ends right of where it started (it moved past "+ b")', { a0, aEnd })
  check(aMid !== null && aMid > a0 + 10 && aMid < aEnd - 10, '…and is between the two half way through — it travels, it does not cut', { a0, aMid, aEnd })
  console.log('        a.x: start', Math.round(a0), 'mid', Math.round(aMid), 'end', Math.round(aEnd))
  await p.keyboard.press('Escape')
  await settle(300)
  await p.evaluate(() => window.slidomingo.anim.setManual(false))

  check(errors.length === 0, 'no page errors', errors)
} catch (e) {
  fails++
  console.log(`FAIL the rig threw: ${e.stack ?? e}`)
} finally {
  await browser.close()
}
console.log(`\ntest-math-e2e: ${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
