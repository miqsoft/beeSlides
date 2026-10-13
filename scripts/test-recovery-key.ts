#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Crash-recovery content key (slides/src/autosave.ts docContentKey).
//
//   slides/node_modules/.bin/esbuild scripts/test-recovery-key.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-recovery-key.mjs" \
//     && node "$TMPDIR/test-recovery-key.mjs"
//
// (Bundled, not run directly: model.ts imports extensionless siblings.)
//
// WHAT THIS PROVES. On boot the editor compares the latest recovery snapshot
// with the opened file by docContentKey; an EQUAL key means "the file already
// has these edits" and no Restore banner. So every field an author can edit
// has to be in the key, or an unsaved edit to it is lost with the tab (on
// Safari/Firefox there is no file write-back to catch it). The key used to
// list eight fields and missed sections, headerFooter, meta, present and the
// default slide type (2026-10-08 review). The other direction matters as
// much: a volatile stamp, or the same content in another key order (the file
// comes back canonically ordered, a snapshot in session order), must NOT
// raise a banner for nothing.

import { docContentKey } from '../slides/src/autosave.ts'
import { newDoc, type SlidomingoDoc } from '../slides/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.error(`  ✗ ${msg}`) } else console.log(`  ✓ ${msg}`)
}

const base = newDoc()
const clone = (d: SlidomingoDoc): SlidomingoDoc => JSON.parse(JSON.stringify(d))
const key = docContentKey(base)

console.log('\nan edit to any authored field changes the key')
const edits: Array<[string, (d: SlidomingoDoc) => void]> = [
  ['a section', (d) => { d.sections = [{ id: 'sec1', name: 'Intro', start: d.slides[0].id } as any] }],
  ['footer text', (d) => { d.headerFooter = { footer: { text: 'ACME confidential' } } as any }],
  ['a fixed date', (d) => { d.headerFooter = { date: { fixed: '2026-10-08' } } as any }],
  ['document properties', (d) => { d.meta = { author: 'Ada' } }],
  ['present settings', (d) => { d.present = { controls: true } as any }],
  ['the default slide type', (d) => { d.defaultLayoutId = 'lay1' }],
  ['the root font slide type', (d) => { d.rootFontLayoutId = 'lay1' }],
  ['player mode', (d) => { d.readonly = true }],
  ['the title (always covered)', (d) => { d.title = 'Other' }],
  ['a slide (always covered)', (d) => { d.slides[0].notes = 'say hello' }],
]
for (const [what, edit] of edits) {
  const d = clone(base)
  edit(d)
  ok(docContentKey(d) !== key, what)
}

console.log('\nnoise does not')
{
  const d = clone(base)
  d.modified = new Date(Date.parse(base.modified) + 60_000).toISOString()
  ok(docContentKey(d) === key, 'the modified stamp')
  ;(d as any).collab = { key: 'x', peers: 3 }
  ok(docContentKey(d) === key, 'legacy collab state')
}
{
  // the same content, every object's keys reversed
  const reorder = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(reorder)
    if (!v || typeof v !== 'object') return v
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).reverse()) out[k] = reorder((v as Record<string, unknown>)[k])
    return out
  }
  ok(docContentKey(reorder(clone(base)) as SlidomingoDoc) === key, 'the same content in another key order')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
