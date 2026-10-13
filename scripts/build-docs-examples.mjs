#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The example decks in docs/examples/ — present-only files (the viewer shell),
// so a reader downloads one, opens it in any browser and the show starts.
//
//   node scripts/build-docs-examples.mjs [outDir]     (default: docs/examples/)
//
// Each deck goes through the app's OWN export, not a hand splice: the deck is
// loaded into the built editor (slides/dist-single), and File ▸ Export
// (`file.presentOnly`) writes it into the viewer shell (slides/dist-viewer),
// exactly as the desktop app does. That way the file carries what the writer
// adds — `requires` (rich text), the asset store, the first-page preview,
// `readonly` — and nothing here has to know about any of it.
// Needs both builds (`npm run build:single` in slides/) and playwright-core
// ($PLAYWRIGHT_CORE, the package, or the npx cache).
//
// The decks: scripts/lib/bee-deck.mjs, lake-scene.mjs, seasons-scene.mjs.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { beeDeck } from './lib/bee-deck.mjs'
import { lakeDeck } from './lib/lake-scene.mjs'
import { seasonsDeck } from './lib/seasons-scene.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = process.argv[2] ?? join(root, 'docs/examples')
const editor = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const viewer = join(root, 'slides/dist-viewer/BeeSlides_Viewer.beeslides.html')
for (const f of [editor, viewer]) {
  if (!existsSync(f)) { console.error(`Missing ${f} — run "npm run build:single" in slides/ first.`); process.exit(1) }
}

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
const chromium = await loadChromium()
if (!chromium) { console.error('playwright-core not found (set PLAYWRIGHT_CORE)'); process.exit(1) }

// Stable ids, so a rebuild changes a file only where its deck changed.
const EXAMPLES = [
  { file: 'wie-fliegt-eine-biene.beeslides.html', docId: '6b1f2c1e-0d55-4c8a-9b0e-bee5f1000001', build: (base) => ({ ...beeDeck({ fontFamily: base.theme?.fontFamily }) }) },
  { file: 'ein-tag-am-see.beeslides.html', docId: '6b1f2c1e-0d55-4c8a-9b0e-bee5f1000002', build: lakeDeck },
  { file: 'jahreszeiten.beeslides.html', docId: '6b1f2c1e-0d55-4c8a-9b0e-bee5f1000003', build: seasonsDeck },
]

mkdirSync(outDir, { recursive: true })
const viewerHtml = readFileSync(viewer, 'utf8')
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(pathToFileURL(editor).href)
  await page.waitForFunction(() => !!window.slidomingo?.loadDoc, null, { timeout: 30_000 })
  const base = await page.evaluate(() => JSON.parse(JSON.stringify(window.slidomingo.doc)))
  // the export's two seams: the viewer shell comes from the "desktop" (as in
  // the app), and with no file picker the browser path hands the file to a
  // download, which is where it is caught
  await page.evaluate((html) => {
    window.slidomingoDesktop = { getViewerShell: async () => html }
    window.showSaveFilePicker = undefined
  }, viewerHtml)
  for (const ex of EXAMPLES) {
    const deck = { ...ex.build(base), docId: ex.docId }
    const ok = await page.evaluate((json) => window.slidomingo.loadDoc(json), JSON.stringify(deck))
    if (ok === false) throw new Error(`${ex.file}: the editor refused the deck`)
    await page.waitForTimeout(500)
    // an example is held to the app's own checks: warnings and errors fail
    // the build (contrast, cut-off text, overflow…); notes (margins, a
    // deliberate bleed) are printed and allowed
    const { findings } = await page.evaluate(() => window.slidomingo.validate())
    const serious = findings.filter((f) => f.severity !== 'info')
    for (const f of serious) console.error(`  ${f.severity} ${f.code} ${f.slide ?? ''} ${f.element ?? ''}: ${f.message}`)
    if (serious.length) throw new Error(`${ex.file}: ${serious.length} validator finding(s) above`)
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.evaluate(() => window.slidomingo.menu.run('file.presentOnly')),
    ])
    const target = join(outDir, ex.file)
    await download.saveAs(target)
    const html = readFileSync(target, 'utf8')
    if (!html.includes('id="slidomingo-doc"') || html.includes('slidomingo-editor')) throw new Error(`${ex.file}: not a viewer file`)
    console.log(`${ex.file} — ${deck.slides.length} slides, ${Math.round(html.length / 1024)} KB, ${findings.length} note(s)`)
  }
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
} finally {
  await browser.close()
}
