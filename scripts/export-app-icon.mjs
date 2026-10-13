#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Renders desktop/build/icon.png (electron-builder derives .icns/.ico from it)
// from the single source of the mark, slides/src/brand.ts: logoSvg(824)
// centred on a transparent 1024px canvas, per the macOS icon grid, with a soft
// drop shadow. Rerun after changing the mark (build-brand-assets.mjs covers
// the other copies).
//
//   node scripts/export-app-icon.mjs
//
// Node ≥ 22.18 / 23.6 (native TypeScript type-stripping imports brand.ts).
// Needs playwright-core and a Chromium it can launch. It is not a repo
// dependency: the script tries `import('playwright-core')`, then the path in
// $PLAYWRIGHT_CORE (…/node_modules/playwright-core/index.mjs). Browsers come
// from ~/Library/Caches/ms-playwright (`npx playwright-core install chromium`).

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { logoSvg } from '../slides/src/brand.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

async function loadPlaywright() {
  try {
    return await import('playwright-core')
  } catch {
    const p = process.env.PLAYWRIGHT_CORE
    if (!p) {
      console.error('playwright-core not found. Install it, or set PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.mjs')
      process.exit(1)
    }
    return import(pathToFileURL(p).href)
  }
}

const CANVAS = 1024, TILE = 824
const html = `<!doctype html><html><head><style>svg{display:block}</style></head><body style="margin:0;background:transparent">
<div style="width:${CANVAS}px;height:${CANVAS}px;display:grid;place-items:center">
  <div style="width:${TILE}px;height:${TILE}px;border-radius:${Math.round(TILE * 7 / 32)}px;box-shadow:0 12px 36px rgba(0,0,0,.30),0 2px 6px rgba(0,0,0,.18)">
    ${logoSvg(TILE, { id: 'ic' })}
  </div>
</div></body></html>`

const { chromium } = await loadPlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: CANVAS, height: CANVAS }, deviceScaleFactor: 1 })
  await page.setContent(html)
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: CANVAS, height: CANVAS } })
  const out = join(root, 'desktop/build/icon.png')
  writeFileSync(out, png)
  console.log(`app icon written: desktop/build/icon.png (${CANVAS}px, ${TILE}px tile)`)
} finally {
  await browser.close()
}
