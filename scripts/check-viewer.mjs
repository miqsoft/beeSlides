#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Post-build check for the viewer-only shell (slides `npm run build:viewer`):
//   1. the conformance gate (splice contract etc.) — scripts/shell-gate.mjs
//   2. the editor really tree-shook out: no editor-only marker may survive in
//      the inflated runtime JS (CSS is shared with the editor build and is
//      deliberately not checked).
// Prints the size, so a regression (an import creeping in from editor/) is
// visible as a number as well as a failure.
//
//   node scripts/check-viewer.mjs slides/dist-viewer/BeeSlides_Viewer.beeslides.html

import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { gateShell } from './shell-gate.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/check-viewer.mjs <viewer-shell.html>')
  process.exit(2)
}

gateShell(file)

const html = readFileSync(file, 'utf8')
const payloads = [...html.matchAll(/<script id="beeslides-rt" type="beeslides\/deflate-b64">([\s\S]*?)<\/script>/g)]
  .map((m) => inflateRawSync(Buffer.from(m[1].trim(), 'base64')).toString('utf8'))
if (!payloads.length) {
  console.error('check-viewer: no #beeslides-rt payload found — run it on the compressed shell')
  process.exit(1)
}
const js = payloads.join('\n')

// Strings that only editor code carries. Class names, not library names:
// "Selecto" is inside querySelector, and the license line in the i18n table
// names Moveable.
// 'slidomingo/ui-profile' + 'ed-mytools': the per-install UI profile
// (editor/customize/) is editor-only — a viewer must never apply one.
const EDITOR_MARKERS = ['moveable-control', 'selecto-selection', 'ed-ribbon', 'ed-topbar', 'ed-layoutmgr', 'ed-startpick', 'slidomingo/ui-profile', 'ed-mytools']
const found = EDITOR_MARKERS.filter((m) => js.includes(m))
if (found.length) {
  console.error(`check-viewer: editor code leaked into the viewer shell: ${found.join(', ')}`)
  process.exit(1)
}
console.log(`viewer shell OK: ${(html.length / 1024).toFixed(0)} KB, no editor markers (${EDITOR_MARKERS.length} checked)`)
