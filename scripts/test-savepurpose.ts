#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Save-intent rig.
//
//   node scripts/test-savepurpose.ts
//
// WHAT THIS PROVES. A HOST that polyfills `showSaveFilePicker` — home/ios over
// UIDocument, home/webext over a directory grant — sees only the options bag.
// It has to answer "am I being asked to overwrite the open document, or to make
// a second file?" from that alone, and the two failure directions are not
// symmetric: guessing "copy" costs a prompt, guessing "in-place" overwrites
// somebody's work with no dialog and no warning.
//
// Measured, in a browser extension, 2026-08-02: it overwrote the open deck,
// because ⌘S and "Save a copy…" reached the picker with byte-identical
// arguments. `id` is now the signal. If these three ever collapse back to one
// value, every host silently loses the ability to tell them apart — and finds
// out the way we did.

import { readFileSync } from 'node:fs'
import { fileBase, pickerIdFor, suggestedFileName as suggestedName, type SavePurpose } from '../kernel/src/save.ts'
import { DOC_EXT, LEGACY_DOC_EXT, hasDocExt } from '../kernel/src/docext.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const purposes: SavePurpose[] = ['in-place', 'copy', 'share']
const ids = purposes.map(pickerIdFor)

ok(new Set(ids).size === purposes.length,
  `every purpose has its own picker id (${ids.join(', ')})`)
ok(pickerIdFor('in-place') === 'slidomingo-doc',
  'in-place keeps the original id, so no existing deck changes where its picker opens')
ok(pickerIdFor('copy') !== pickerIdFor('in-place'),
  'a copy is distinguishable from an in-place save — the case that overwrote a file')
ok(pickerIdFor('share') !== pickerIdFor('in-place'),
  'a share export is distinguishable from an in-place save')
ok(ids.every((id) => /^[a-z0-9-]+$/.test(id) && id.length <= 32),
  'ids are plain and short enough for the picker to accept')

// ------------------------------------------------- every app announces itself
// A host must know whether a document predates `pickerIdFor` (#213), because
// before it every save sent `slidomingo-doc` and acting on that overwrites the open
// document. The signal used to live in `window.slidomingo.updates.version`, which
// each app assembles by hand — and slidomingo/dash never included `updates`, so
// every Cmd-S in Dash fell through to a destination prompt. The fix is that the
// signal cannot live in a per-app object at all: `configureApp` is the one call
// every app makes, so it announces the version and the next app inherits it.
const appSrc = readFileSync(new URL('../kernel/src/app.ts', import.meta.url), 'utf8')
ok(/__slidomingoRuntime/.test(appSrc), 'the kernel announces the runtime version to a host')
ok(appSrc.indexOf('announceRuntime()') < appSrc.indexOf('function announceRuntime'),
  'and does it from configureApp, which every app calls — not from each app in turn')
ok(/writable: false/.test(appSrc),
  'the announcement is not writable: a document shares that realm and must not fake its own version')

// ------------------------------------------------- the convention is the id
// The compound extension is what identifies a document by NAME — hosts that
// add a save bridge, file associations and the template gallery all match on
// it — so a document named `Q3.html` is a second-class citizen. New files are
// `.beeslides.html` (DOC_EXT); files saved before the rename are
// `.slidomingo.html` and must keep being recognised (kernel/src/docext.ts).
//
// The save PICKER must accept only the new extension: with `.html` accepted,
// an author who typed a bare name got `Q3.html`; accepting only DOC_EXT makes
// the browser append it.
const saveSrc = readFileSync(new URL('../kernel/src/save.ts', import.meta.url), 'utf8')
ok(DOC_EXT === '.beeslides.html' && LEGACY_DOC_EXT === '.slidomingo.html', 'the extensions are .beeslides.html (new) and .slidomingo.html (legacy)')
ok(suggestedName({ title: 'Q3 Board Review' } as any).endsWith(DOC_EXT),
  `suggestedFileName produces the new extension (${suggestedName({ title: 'Q3 Board Review' } as any)})`)
ok(!/accept: \{ 'text\/html': \['\.html'\] \}/.test(saveSrc),
  'and the picker no longer accepts a bare .html, which is how bare names slipped through')
const accepts = [...saveSrc.matchAll(/accept: \{ 'text\/html': \[([^\]]*)\] \}/g)].map((m) => m[1])
ok(accepts.length >= 1 && accepts.every((a) => a === 'DOC_EXT'), `every save picker accepts only DOC_EXT (found ${accepts.join(' | ')})`)
ok(hasDocExt('Q3.beeslides.html') && hasDocExt('Q3.SLIDOMINGO.HTML') && !hasDocExt('Q3.html') && !hasDocExt('Q3.beeslides.htm'),
  'both extensions are recognised as documents, a bare .html is not')
ok(fileBase('Q3.beeslides.html') === 'Q3' && fileBase('Q3.slidomingo.html') === 'Q3' && fileBase('Q3.html') === 'Q3',
  'fileBase strips the new, the legacy and a bare .html extension')


console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
