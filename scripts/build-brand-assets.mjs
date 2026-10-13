#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Regenerates the static copies of the BeeSlides mark from its single source,
// slides/src/brand.ts. These copies exist because they must work before (or
// without) any JS: the favicon and boot splash in slides/index.html paint while
// the compressed payload is still inflating, and the README can't import TS.
//
//   node scripts/build-brand-assets.mjs
//
// Node ≥ 22.18 / 23.6 (native TypeScript type-stripping imports brand.ts).
//
// Writes:
//   slides/index.html            <link rel="icon"> data URI + the .bs-mark SVG
//                                (postbuild-compress.mjs carries both into
//                                every shell; the splash CSS stays hand-written
//                                in index.html and targets .sm-disc/.sm-bee/
//                                .sm-arm/.sm-wings/.sm-pulse)
//   docs/assets/beeslides-logo.svg  (the repo's asset path; the mark is BeeSlides')
//
// NOT written: desktop/build/icon.png (electron-builder derives .icns/.ico from
// it). Regenerate it with scripts/export-app-icon.mjs after changing the mark,
// and the shareable docs/assets/brand/ kit with scripts/export-brand-kit.mjs
// (run it after this script: its video renders the splash written here).

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logoSvg } from '../slides/src/brand.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function replaceOnce(src, re, fn, what) {
  let hits = 0
  const out = src.replace(re, (...m) => { hits++; return fn(...m) })
  if (hits !== 1) throw new Error(`${what}: expected exactly one match, got ${hits}`)
  return out
}

// Data-URI form: single quotes (the attribute is double-quoted), and only the
// characters that must be escaped in a URL are.
const dataUri = svg =>
  'data:image/svg+xml,' + svg.replaceAll('"', "'").replaceAll('#', '%23').replaceAll('<', '%3C').replaceAll('>', '%3E')

const indexPath = join(root, 'slides/index.html')
let html = readFileSync(indexPath, 'utf8')
html = replaceOnce(html, /<link rel="icon" href="[^"]*" \/>/,
  () => `<link rel="icon" href="${dataUri(logoSvg(32, { id: 'f' }).replace(' aria-hidden="true"', ''))}" />`, 'favicon')
// The splash div must never contain `</div></div>` before its own end —
// postbuild-compress.mjs finds it with a lazy match on exactly that.
html = replaceOnce(html, /(<div class="bs-mark">)[\s\S]*?(<\/div>)/,
  (_, open, close) => open + logoSvg(104, { id: 'bs', animated: true }) + close, 'splash mark')
writeFileSync(indexPath, html)

writeFileSync(join(root, 'docs/assets/beeslides-logo.svg'),
  logoSvg(112, { id: 'l' }).replace('aria-hidden="true"', 'role="img" aria-label="BeeSlides"') + '\n')

console.log('brand assets written: slides/index.html (favicon, splash), docs/assets/beeslides-logo.svg')
