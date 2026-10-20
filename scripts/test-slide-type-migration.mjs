#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Master → slide-type-hierarchy migration byte-identity rig.
//
//   node scripts/test-slide-type-migration.mjs
//
// WHAT THIS PROVES. The 2026-09 redesign that collapsed `doc.masters[]` into
// ordinary `doc.layouts` entries linked by `Slide.parentId` (docs/DECISIONS.md,
// reversing 2026-09-03's "Hierarchical layout masters") promised every
// existing multi-master file opens with rendered output IDENTICAL to before
// and re-saves in the new shape. `parseDoc`'s migration is the only place
// that promise is kept or broken. This rig builds a document shaped like the
// OLD format, round-trips it through `parseDoc`, and checks the new shape
// against exactly what the OLD format meant — computed independently here,
// not by re-deriving from the new code (which no longer has the old code
// path to check against).

import { parseDoc, ancestorChain, effectiveLayout } from '../slides/src/model.ts'

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

// ---- fixture: an OLD-format multi-master document --------------------------
const rect = (id, w, h, fill) => ({
  id, type: 'shape', shape: 'rect', x: 0, y: 0, w, h, rotation: 0, opacity: 1,
  fill, stroke: 'none', strokeWidth: 0, radius: 0,
})
const title = (id) => ({
  id, type: 'text', x: 0, y: 0, w: 100, h: 40, rotation: 0, opacity: 1,
  html: '', fontSize: 32, fontFamily: '', fontWeight: 400, color: '#000',
  align: 'left', valign: 'top', lineHeight: 1.2,
})

const oldDoc = {
  format: 'beeslides/slides',
  version: 1,
  docId: 'doc-1',
  title: 'Old multi-master file',
  size: { width: 1280, height: 720 },
  theme: { background: '#fff', color: '#000', accent: '#f7a600', fontFamily: 'Arial' },
  masters: [
    {
      id: 'master-a',
      name: 'Main',
      buildingBlocks: { id: 'building-blocks', background: '#fff', transition: 'fade', notes: '', elements: [rect('bb-a1', 10, 10, '#000')] },
      fontFamily: 'Georgia',
      headingFamily: 'Georgia Bold',
    },
    {
      id: 'master-b',
      name: 'Imported',
      buildingBlocks: { id: 'building-blocks', background: '#fff', transition: 'fade', notes: '', elements: [rect('bb-b1', 20, 20, '#fff')] },
      fontFamily: 'Times',
    },
  ],
  layouts: [
    // masterId unset — old fallback rule: resolves to masters[0] ('master-a')
    { id: 'layout-1', background: '#fff', transition: 'fade', notes: '', name: 'Title', elements: [title('l1-title')] },
    // masterId explicitly set to the SECOND master
    { id: 'layout-2', masterId: 'master-b', background: '#fff', transition: 'fade', notes: '', name: 'Imported title', elements: [title('l2-title')] },
  ],
  defaultLayoutId: 'layout-1',
  slides: [
    { id: 'slide-1', layoutId: 'layout-1', background: '#fff', transition: 'fade', notes: '', elements: [] },
    // an ORPHAN slide: no layoutId at all — old behavior fell back to
    // doc.masters[0]'s font, which `rootFontLayoutId` must now preserve
    { id: 'slide-2', background: '#fff', transition: 'fade', notes: '', elements: [] },
  ],
  modified: new Date().toISOString(),
}

// The OLD `effectiveLayout` was:
//   { ...layout, elements: [...masterOf(doc, layout).buildingBlocks.elements, ...layout.elements] }
// with masterOf = masters.find(masterId) ?? masters[0]. Reimplemented here,
// independent of model.ts, so this rig checks the new code against the old
// FORMAT's meaning rather than against itself.
function oldEffectiveElements(layout, masters) {
  const master = masters.find((m) => m.id === layout.masterId) ?? masters[0]
  return [...master.buildingBlocks.elements, ...layout.elements]
}
const expectedLayout1 = oldEffectiveElements(oldDoc.layouts[0], oldDoc.masters)
const expectedLayout2 = oldEffectiveElements(oldDoc.layouts[1], oldDoc.masters)

// ---- round-trip -------------------------------------------------------------
const doc = parseDoc(JSON.stringify(oldDoc))
ok(!!doc, 'parseDoc accepts the old-format fixture')

ok(doc.masters === undefined, 'doc.masters is gone after migration')

const layout1 = doc.layouts.find((l) => l.id === 'layout-1')
const layout2 = doc.layouts.find((l) => l.id === 'layout-2')
const rootA = doc.layouts.find((l) => l.id === 'master-a')
const rootB = doc.layouts.find((l) => l.id === 'master-b')

ok(!!rootA && !!rootB, 'each old master reappears as a doc.layouts entry, reusing its id verbatim')
ok(layout1.parentId === 'master-a', 'unset masterId becomes an explicit parentId at the first master (old fallback rule)')
ok(layout2.parentId === 'master-b', 'an explicit masterId becomes the same parentId')
ok(layout1.masterId === undefined && layout2.masterId === undefined, 'masterId is gone from every migrated layout')

ok(JSON.stringify(effectiveLayout(doc, layout1).elements) === JSON.stringify(expectedLayout1),
  'effectiveLayout(layout-1) matches what the OLD effectiveLayout produced')
ok(JSON.stringify(effectiveLayout(doc, layout2).elements) === JSON.stringify(expectedLayout2),
  'effectiveLayout(layout-2) matches what the OLD effectiveLayout produced')

ok(ancestorChain(doc, layout1).map((l) => l.id).join(',') === 'master-a,layout-1',
  "layout-1's ancestor chain is root-first, itself last")
ok(ancestorChain(doc, layout2).map((l) => l.id).join(',') === 'master-b,layout-2',
  "layout-2's ancestor chain follows its OWN master, not the first one")

ok(rootA.fontFamily === 'Georgia' && rootA.headingFamily === 'Georgia Bold',
  "master-a's fonts carried straight across onto its synthetic root layout")
ok(rootB.fontFamily === 'Times', "master-b's font carried straight across too")

ok(doc.rootFontLayoutId === 'master-a', 'rootFontLayoutId points at the old masters[0]')
const rootFontLayout = doc.layouts.find((l) => l.id === doc.rootFontLayoutId)
ok(rootFontLayout.fontFamily === 'Georgia' && rootFontLayout.headingFamily === 'Georgia Bold',
  'orphan-slide (no layoutId) font resolution still resolves to the old masters[0] font via rootFontLayoutId')

ok(doc.slides.length === 2, 'no slides were dropped')
ok(doc.slides[1].layoutId === undefined, 'the orphan slide really has no layoutId (the case rootFontLayoutId exists to cover)')

// ---- a single-master file (the common case) migrates with zero new config --
const singleMasterDoc = {
  ...oldDoc,
  masters: [oldDoc.masters[0]],
  layouts: [oldDoc.layouts[0]],
}
const single = parseDoc(JSON.stringify(singleMasterDoc))
ok(single.layouts.length === 2, 'a single-master file gets exactly one synthetic root appended')
ok(single.layouts.find((l) => l.id === 'layout-1').parentId === 'master-a',
  'the single existing layout points at the single synthetic root')

// ---- a "ghost" master (ensureMaster's exact never-configured shape: no
// name, no font, no building-block elements — minted just by visiting the
// old Building Blocks tab, with nothing ever added to it) must NOT surface
// as a visible, empty root slide type, and must NOT silently nest every
// other slide type as its child via the unset-masterId fallback -----------
const ghostMaster = { id: 'ghost-master', buildingBlocks: { id: 'building-blocks', background: '#fff', transition: 'fade', notes: '', elements: [] } }

const ghostOnlyDoc = {
  ...oldDoc,
  masters: [ghostMaster],
  layouts: [{ id: 'layout-only', background: '#fff', transition: 'fade', notes: '', name: 'Only type', elements: [title('lo-title')] }],
}
const ghostOnly = parseDoc(JSON.stringify(ghostOnlyDoc))
ok(ghostOnly.masters === undefined, 'a ghost-only file still drops doc.masters')
ok((ghostOnly.layouts ?? []).length === 1, 'a lone ghost master mints NO synthetic root — only the real layout survives')
ok(ghostOnly.layouts[0].parentId === undefined, 'a layout that implicitly fell back to a ghost master stays PARENTLESS, not pointed at a deleted id')
ok(ghostOnly.rootFontLayoutId === undefined, 'rootFontLayoutId is never set to a ghost (nothing to preserve)')

const mixedDoc = {
  ...oldDoc,
  masters: [ghostMaster, oldDoc.masters[0]], // ghost is masters[0] — the fallback-prone position
  layouts: [
    // unset masterId: old rule falls back to masters[0], the ghost
    { id: 'layout-implicit', background: '#fff', transition: 'fade', notes: '', name: 'Implicit', elements: [title('li-title')] },
    // explicit masterId pointing at the ghost directly
    { id: 'layout-explicit-ghost', masterId: 'ghost-master', background: '#fff', transition: 'fade', notes: '', name: 'Explicit ghost', elements: [title('leg-title')] },
    // explicit masterId pointing at the REAL second master — must still work
    { id: 'layout-explicit-real', masterId: 'master-a', background: '#fff', transition: 'fade', notes: '', name: 'Explicit real', elements: [title('ler-title')] },
  ],
}
const mixed = parseDoc(JSON.stringify(mixedDoc))
ok(!mixed.layouts.some((l) => l.id === 'ghost-master'), 'the ghost master itself never becomes a doc.layouts entry')
ok(!!mixed.layouts.find((l) => l.id === 'master-a'), 'the REAL second master still becomes a synthetic root')
ok(mixed.layouts.find((l) => l.id === 'layout-implicit').parentId === undefined,
  'unset masterId does NOT get redirected to the real second master just because the ghost (masters[0]) was skipped')
ok(mixed.layouts.find((l) => l.id === 'layout-explicit-ghost').parentId === undefined,
  'a layout explicitly pointed at the ghost also stays parentless')
ok(mixed.layouts.find((l) => l.id === 'layout-explicit-real').parentId === 'master-a',
  'a layout explicitly pointed at the REAL master keeps that relationship')
ok(mixed.rootFontLayoutId === undefined,
  'rootFontLayoutId is skipped when masters[0] is a ghost, even though a later real master exists (matches the OLD strict masters[0]-only fallback, never "first non-empty")')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
