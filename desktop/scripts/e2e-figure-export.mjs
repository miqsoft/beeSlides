#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Figure export regression harness (docs/DECISIONS.md, "Figure mode"):
// one figure covering aligned text, stroked shapes, a rotated ellipse, an
// arrow, a raw-svg hatch that runs past its viewBox, an image, a shadow and a
// table is exported as PDF, SVG and outlined SVG through the real Export
// menu. Every output is rasterised by every renderer on this machine and
// compared with the PDF raster, so a drifting exporter fails loudly.
//
//   cd desktop && npx electron-vite build && node scripts/e2e-figure-export.mjs
//   (needs slides/dist-single built; pdftoppm, rsvg-convert and Inkscape are
//   used when present; E2E_KEEP=1 keeps the output folder)
//
// Same two-mode shape as e2e-template-window.mjs: run with node it
// ORCHESTRATES (throwaway profile, one Electron launch per step); run by
// Electron it DRIVES the built main process with the Save dialog stubbed.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const repo = resolve(desktopDir, '..')
const SHELL_PATH = join(repo, 'slides/dist-single/BeeSlides.beeslides.html')
const BLOCK_RE = /(<script[^>]*\bid=["']slidomingo-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i
const INKSCAPE = '/Applications/Inkscape.app/Contents/MacOS/inkscape'
const SCALE = 3 // raster pixels per CSS px
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

// =================================================================================
// DRIVER (inside Electron)
// =================================================================================
async function driver() {
  const { app, dialog, BrowserWindow, webContents } = await import('electron')
  const step = process.env.E2E_STEP
  const arg = JSON.parse(process.env.E2E_ARG || '{}')
  const saves = [...(arg.saves ?? [])]
  dialog.showMessageBox = async () => ({ response: 1 })
  dialog.showSaveDialog = async () => (saves.length ? { canceled: false, filePath: saves.shift() } : { canceled: true })
  if (!process.env.E2E_SHOW) {
    BrowserWindow.prototype.show = function () {}
    BrowserWindow.prototype.focus = function () {}
    app.dock?.hide()
  }
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  // Every step is a fresh launch: forget what the previous step's quit left
  // open, or a launch without --open would reopen it (restoreSession, index.ts).
  try {
    const sp = join(process.env.SLIDOMINGO_USER_DATA, 'app-settings.json')
    const s = JSON.parse(readFileSync(sp, 'utf8'))
    if (s.session) { delete s.session; writeFileSync(sp, JSON.stringify(s, null, 2)) }
  } catch { /* no settings yet */ }
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  const hardStop = setTimeout(() => { ok(false, `step ${step} timed out`); report(); app.exit(3) }, 120000)
  function report() { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ } }
  const quit = () => { report(); clearTimeout(hardStop); app.quit() }
  async function waitFor(fn, ms = 20000) {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn().catch(() => null)
      if (v) return v
      if (Date.now() > end) return null
      await sleep(150)
    }
  }

  if (step === 'export') {
    const wc = await waitFor(async () => {
      for (const w of webContents.getAllWebContents()) {
        if (w.isDestroyed() || w.isLoading() || !/BeeSlides\.beeslides\.html/.test(w.getURL())) continue
        if (await w.executeJavaScript('!!(window.slidomingo && window.slidomingo.doc && document.querySelector(".ed-dropdown .ed-menu"))').catch(() => false)) return w
      }
      return null
    })
    ok(!!wc, 'the figure opens in the editor')
    // the real Export menu: PDF, SVG, SVG with outlined text
    for (const [label, file] of [['PDF (vector)', 'figure.pdf'], ['SVG', 'figure.svg'], ['SVG, text as outlines', 'figure-outlined.svg']]) {
      await wc.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.ed-dropdown .ed-menu button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); b.click() })()`)
      ok(!!await waitFor(async () => existsSync(join(arg.out, file)), 40000), `${label} → ${file}`)
    }
    quit()
  }

  if (step === 'raster') {
    // Chromium's own rendering of each SVG: an <img> at SCALE× the figure size
    for (const name of arg.svgs) {
      const win = new BrowserWindow({ show: false, width: arg.w * arg.scale, height: arg.h * arg.scale, useContentSize: true, webPreferences: { sandbox: true } })
      win.webContents.setZoomFactor(1)
      const html = `<!doctype html><body style="margin:0;background:#fff"><img src="${pathToFileURL(join(arg.out, name + '.svg')).href}" style="display:block;width:${arg.w * arg.scale}px;height:${arg.h * arg.scale}px">`
      writeFileSync(join(arg.out, name + '.chromium.html'), html)
      await win.loadFile(join(arg.out, name + '.chromium.html'))
      await sleep(600)
      let img = await win.webContents.capturePage()
      const sz = img.getSize()
      if (sz.width !== arg.w * arg.scale) img = img.resize({ width: arg.w * arg.scale, height: arg.h * arg.scale, quality: 'best' })
      writeFileSync(join(arg.out, name + '.chromium.png'), img.toPNG())
      win.destroy()
    }
    quit()
  }
}

// =================================================================================
// ORCHESTRATOR
// =================================================================================
async function orchestrator() {
  const electronPath = createRequire(join(desktopDir, 'package.json'))('electron')
  const { PNG } = createRequire(join(repo, 'slides/package.json'))('pngjs')
  if (!existsSync(SHELL_PATH)) { console.error('build slides first: cd slides && npm run build:single'); process.exit(2) }
  const shell = readFileSync(SHELL_PATH, 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-fig-'))
  const userData = join(root, 'userData')
  const out = join(root, 'out')
  for (const d of [userData, out]) mkdirSync(d, { recursive: true })

  function run(step, { open, arg = {} } = {}) {
    console.log(`\n# ${step}`)
    const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), ...(open ? ['--open', open] : [])], {
      cwd: desktopDir,
      env: { ...process.env, E2E_STEP: step, E2E_ARG: JSON.stringify(arg), SLIDOMINGO_USER_DATA: userData, ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '' },
      encoding: 'utf8', timeout: 150000,
    })
    const o = res.stdout ?? ''
    for (const line of o.split('\n')) if (/^\s+(ok|FAIL)\s/.test(line)) console.log(line)
    const m = o.match(/E2E_RESULT (\d+) (\d+)/)
    if (!m) { checks++; failures++; console.log(`  FAIL  step ${step} produced no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-15).join('\n')}`); return }
    checks += Number(m[1]); failures += Number(m[2])
  }

  // ---- the figure ------------------------------------------------------------------
  const { newFigureDoc } = await import(join(repo, 'slides/src/model.ts'))
  const doc = newFigureDoc(85, 60, 'mm')
  const { width: W, height: H } = doc.size // 321 × 227
  const base = { x: 0, y: 0, w: 100, h: 30, rotation: 0, opacity: 1 }
  const text = (id, html, x, y, w, align) => ({
    ...base, id, type: 'text', html, x, y, w, h: 24, fontSize: 12, fontFamily: 'Helvetica, Arial, sans-serif', fontWeight: 400,
    color: '#000000', align, valign: 'top', lineHeight: 1.2,
  })
  const shape = (id, kind, x, y, w, h, extra = {}) => ({
    ...base, id, type: 'shape', shape: kind, x, y, w, h, fill: '#FFFFFF', stroke: '#000000', strokeWidth: 2, radius: 0, ...extra,
  })
  const hatch = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40"><style>.h{stroke:var(--hc,#c00);stroke-width:2}</style>' +
    Array.from({ length: 14 }, (_, i) => `<line class="h" x1="${i * 8 - 40}" y1="60" x2="${i * 8 + 20}" y2="-20"/>`).join('') + '</svg>'
  const stripes = new PNG({ width: 64, height: 64 }) // a gentle gradient, so resampling differences stay out of the diff
  for (let i = 0; i < 4096; i++) stripes.data.set([100 + (i % 64) / 8, 150 + Math.floor(i / 64) / 8, 200, 255], i * 4)
  const png = 'data:image/png;base64,' + PNG.sync.write(stripes).toString('base64')
  doc.slides[0].elements = [
    text('t-left', 'Left aligned', 8, 6, 140, 'left'),
    text('t-center', 'Centred label', 8, 30, 140, 'center'),
    text('t-right', 'Right aligned', 8, 54, 140, 'right'),
    shape('box', 'rect', 170, 8, 60, 40, { fill: '#DDEEFF', stroke: '#223399', strokeWidth: 3, radius: 6 }),
    shape('disk', 'ellipse', 240, 8, 70, 36, { fill: '#FFD27F', rotation: 20 }),
    shape('arrow', 'line', 170, 62, 60, 20, { lineEnd: 'arrow', fill: '#000000', strokeWidth: 2 }),
    { ...base, id: 'hatch', type: 'svg', markup: hatch, css: '', x: 170, y: 90, w: 60, h: 40 },
    { ...base, id: 'img', type: 'image', src: png, fit: 'cover', radius: 0, x: 240, y: 60, w: 70, h: 50 },
    shape('card', 'rect', 8, 90, 70, 40, { fill: '#FFFFFF', stroke: '#888888', strokeWidth: 1, shadow: { x: 3, y: 3, blur: 6, color: 'rgba(0,0,0,0.5)' } }),
    {
      ...base, id: 'tbl', type: 'table', x: 8, y: 150, w: 200, h: 60, header: true,
      columns: [{ w: 70 }, { w: 65 }, { w: 65 }],
      rows: [['A', 'B', 'C'], ['1', '2', '3'], ['4', '5', '6']].map((r) => ({ cells: r.map((html) => ({ html })) })),
      style: { headerBg: '#EEEEEE', headerColor: '#000000', borderColor: '#444444', borderWidth: 1, cellPadX: 6, cellPadY: 4, fontSize: 12, color: '#000000', radius: 0 },
    },
  ]
  const figurePath = join(root, 'figure.beeslides.html')
  writeFileSync(figurePath, shell.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`))

  // ---- export through the real UI -----------------------------------------------------
  const saves = ['figure.pdf', 'figure.svg', 'figure-outlined.svg'].map((f) => join(out, f))
  run('export', { open: figurePath, arg: { out, saves } })
  const have = (f) => existsSync(join(out, f))

  // ---- rasterise with every renderer available ------------------------------------------
  const pxW = W * SCALE, pxH = H * SCALE
  const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000 })
  const renders = {} // `${name}.${renderer}` → png path
  if (have('figure.pdf')) {
    if (existsSync('/opt/homebrew/bin/pdftoppm')) {
      // 96 CSS px per inch × SCALE
      sh('/opt/homebrew/bin/pdftoppm', ['-png', '-singlefile', '-r', String(96 * SCALE), join(out, 'figure.pdf'), join(out, 'figure.pdf-ref')])
      renders['figure.pdf'] = join(out, 'figure.pdf-ref.png')
    }
  }
  const svgs = ['figure', 'figure-outlined'].filter((n) => have(n + '.svg'))
  run('raster', { arg: { out, svgs, w: W, h: H, scale: SCALE } })
  for (const n of svgs) {
    renders[`${n}.chromium`] = join(out, `${n}.chromium.png`)
    if (existsSync('/opt/homebrew/bin/rsvg-convert')) {
      sh('/opt/homebrew/bin/rsvg-convert', ['-w', String(pxW), '-h', String(pxH), '-b', 'white', '-o', join(out, `${n}.rsvg.png`), join(out, n + '.svg')])
      renders[`${n}.rsvg`] = join(out, `${n}.rsvg.png`)
    }
    if (existsSync(INKSCAPE)) {
      sh(INKSCAPE, [join(out, n + '.svg'), '--export-type=png', `--export-filename=${join(out, n + '.inkscape.png')}`, `--export-width=${pxW}`, `--export-background=white`, '--export-background-opacity=1'])
      renders[`${n}.inkscape`] = join(out, `${n}.inkscape.png`)
    }
  }

  // ---- compare with the PDF raster ---------------------------------------------------------
  const load = (p) => { try { return PNG.sync.read(readFileSync(p)) } catch { return null } }
  const flat = (img, i) => { const a = img.data[i + 3] / 255; return [0, 1, 2].map((k) => img.data[i + k] * a + 255 * (1 - a)) }
  /** Share of CSS pixels whose mean colour differs clearly. Averaging SCALE×SCALE blocks
   *  first keeps anti-aliasing and ±1 px glyph placement out of the number, so it
   *  measures what is drawn where. */
  function diff(a, b) {
    const w = Math.floor(Math.min(a.width, b.width) / SCALE), h = Math.floor(Math.min(a.height, b.height) / SCALE)
    const mean = (img, bx, by) => {
      const m = [0, 0, 0]
      for (let y = 0; y < SCALE; y++) for (let x = 0; x < SCALE; x++) {
        const p = flat(img, ((by * SCALE + y) * img.width + bx * SCALE + x) * 4)
        for (let k = 0; k < 3; k++) m[k] += p[k] / (SCALE * SCALE)
      }
      return m
    }
    let bad = 0
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const pa = mean(a, x, y), pb = mean(b, x, y)
      if (Math.max(...pa.map((v, k) => Math.abs(v - pb[k]))) > 60) bad++
    }
    return bad / (w * h)
  }
  // the outlined SVG draws text as paths in the same face, so its tolerance matches the plain SVG's
  const LIMIT = { chromium: 0.03, rsvg: 0.04, inkscape: 0.04 }
  const ref = renders['figure.pdf'] ? load(renders['figure.pdf']) : null
  console.log('\n# cross-renderer diff against the PDF raster')
  if (!ref) console.log('  (no PDF rasteriser — skipped)')
  else {
    ok(Math.abs(ref.width - pxW) <= 2 && Math.abs(ref.height - pxH) <= 2, `PDF page is the figure's size (${ref.width}×${ref.height} vs ${pxW}×${pxH})`)
    for (const [key, p] of Object.entries(renders)) {
      if (key === 'figure.pdf') continue
      const img = load(p)
      const renderer = key.split('.')[1]
      if (!img) { ok(false, `${key}: no raster produced`); continue }
      const d = diff(ref, img)
      ok(d <= LIMIT[renderer], `${key}: ${(d * 100).toFixed(2)}% of pixels differ (limit ${LIMIT[renderer] * 100}%)`)
    }
  }

  // ---- the SVG is plain enough for vector tools --------------------------------------------
  console.log('\n# SVG structure')
  if (have('figure.svg')) {
    const svg = readFileSync(join(out, 'figure.svg'), 'utf8')
    ok(/width="85mm" height="60mm"/.test(svg), 'document size is 85 × 60 mm')
    ok(!/feDropShadow/.test(svg), 'no SVG 2 feDropShadow')
    ok(!/paint-order/.test(svg) && !/<style/.test(svg) && !/var\(--/.test(svg), 'no paint-order, <style> or CSS variables')
    ok(!/-apple-system|system-ui/.test(svg), 'no system font stack')
    ok(!/<foreignObject/.test(svg), 'no foreignObject')
    ok(/xlink:href="data:image\/png/.test(svg), 'images carry xlink:href')
    ok(/text-anchor="middle"/.test(svg) && /text-anchor="end"/.test(svg), 'centred and right-aligned text use text-anchor')
    ok(!/<svg[\s\S]*<svg/.test(svg), 'no nested <svg> viewports (only charts keep one)')
    const labels = [...svg.matchAll(/inkscape:label="([^"]+)"/g)].map((m) => m[1])
    ok(labels.length === doc.slides[0].elements.length, `one labelled object per element (${labels.length}): ${labels.join(' | ')}`)
    ok(labels.some((l) => l === 'Text: Centred label') && labels.includes('Ellipse') && labels.includes('SVG'), 'labels name type and text')
    ok(new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])).size === [...svg.matchAll(/\sid="([^"]+)"/g)].length, 'ids are unique')
    if (existsSync(INKSCAPE)) {
      const q = sh(INKSCAPE, ['--query-all', join(out, 'figure.svg')])
      const rows = (q.stdout ?? '').trim().split('\n').map((l) => l.split(','))
      const ids = new Set(rows.map((r) => r[0]))
      const top = [...svg.matchAll(/<g id="([^"]+)" inkscape:label/g)].map((m) => m[1])
      ok(top.length > 0 && top.every((id) => ids.has(id)), `Inkscape finds all ${top.length} objects by id`)
      const hatchId = svg.match(/<g id="([^"]+)"[^>]*data-el-id="hatch"/)?.[1]
      const [x, y, w, h] = rows.find((r) => r[0] === hatchId)?.slice(1).map(Number) ?? []
      ok(w !== undefined && w * 1 <= 60 + 1 && h <= 40 + 1, `hatch is clipped to its box in Inkscape (${w}×${h} user units)`)
      void x; void y
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed   (${process.env.E2E_KEEP ? 'output: ' + root : 'set E2E_KEEP=1 to keep ' + root})`)
  if (failures) process.exit(1)
}
