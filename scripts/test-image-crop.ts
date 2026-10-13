#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Picture crop (ImageElement.crop): the stored shape, the paste validator,
// and the crop-mode geometry an edit writes back — a round trip through the
// model, the store's undo and the file's JSON. Needs no DOM. BUNDLED, not run
// directly, because the editor modules import './model' extensionless:
//
//   slides/node_modules/.bin/esbuild scripts/test-image-crop.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-image-crop.mjs" \
//     && node "$TMPDIR/test-image-crop.mjs"

import {
  applyLayout, defaultImage, defaultShape, emptySlide, newDoc, normalizeCrop, refitCrop, MIN_CROP, type ImageElement,
} from '../slides/src/model.ts'
import { MODEL_KEYS } from '../slides/src/modelkeys.generated.ts'
import { checkElementProp, isWholePictureCrop, sanitizeElement } from '../slides/src/untrusted.ts'
import { validateDoc } from '../slides/src/validate.ts'
import { Store } from '../slides/src/store.ts'
import { ElementEdits } from '../slides/src/editor/elementactions.ts'
import {
  applyCropEdit, cropFor, frameFor, pictureRect, resetCrop, unstretched, visibleWindow, type Rect,
} from '../slides/src/editor/cropmode.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps
const nearRect = (a: Rect, b: Rect, eps = 1e-3) =>
  near(a.x, b.x, eps) && near(a.y, b.y, eps) && near(a.w, b.w, eps) && near(a.h, b.h, eps)

/** Where a point of the NATURAL picture (fractions u,v) lands on the slide —
 *  the thing a crop edit must not move. */
function slidePoint(el: ImageElement, natW: number, natH: number, u: number, v: number) {
  const r = pictureRect(el, natW, natH) // display space: flips already applied
  const du = el.flipH ? 1 - u : u
  const dv = el.flipV ? 1 - v : v
  const lx = r.x + du * r.w - el.w / 2
  const ly = r.y + dv * r.h - el.h / 2
  const rad = ((el.rotation || 0) * Math.PI) / 180
  return {
    x: el.x + el.w / 2 + lx * Math.cos(rad) - ly * Math.sin(rad),
    y: el.y + el.h / 2 + lx * Math.sin(rad) + ly * Math.cos(rad),
  }
}

console.log('\nnormalizeCrop')
{
  ok(normalizeCrop(undefined) === null, 'no crop → null')
  ok(normalizeCrop({ x: 0, y: 0, w: 1, h: 1 }) === null, 'the whole picture is not a crop')
  const c = normalizeCrop({ x: 0.8, y: 0.5, w: 0.5, h: 0.7 })!
  ok(near(c.x, 0.5) && near(c.w, 0.5) && near(c.y, 0.3) && near(c.h, 0.7), 'x+w / y+h past the edge slide back inside')
  const tiny = normalizeCrop({ x: 0.2, y: 0.2, w: 0, h: 0.0001 })!
  ok(tiny.w === MIN_CROP && tiny.h === MIN_CROP, 'a sliver grows to MIN_CROP (keeps 1/w finite)')
  const partial = normalizeCrop({ x: 0.25, w: 0.5 } as never)!
  ok(partial.x === 0.25 && partial.y === 0 && partial.h === 1, 'a missing side defaults to the full extent')
}

console.log('\nformat keys + validator')
{
  ok((MODEL_KEYS.element.image as readonly string[]).includes('crop'), 'crop is an image key in modelkeys.generated')
  ok(!(MODEL_KEYS.element.shape as readonly string[]).includes('crop'), '…and only an image key')
  const doc = newDoc()
  doc.slides = [emptySlide({ id: 's1' })]
  doc.slides[0].elements.push(defaultImage('data:image/png;base64,AA==', { id: 'p', crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } }))
  const found = validateDoc(doc).findings.filter((f) => f.code === 'unknown-key' && f.path === 'crop')
  ok(found.length === 0, 'validateDoc does not report crop as unknown')
}

console.log('\nuntrusted intake (paste)')
{
  const base = { type: 'image', id: 'p', x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1, src: 'data:image/png;base64,AA==', fit: 'cover', radius: 0 }
  const keep = sanitizeElement({ ...base, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } }) as ImageElement
  ok(!!keep?.crop && keep.crop.x === 0.1 && keep.crop.h === 0.6, 'a valid crop survives')
  const coerced = sanitizeElement({ ...base, crop: { x: '0.1', y: 0, w: '0.5', h: 1 } }) as ImageElement
  ok(coerced?.crop?.x === 0.1 && coerced.crop.w === 0.5, 'numeric strings coerce (the one repair allowed)')
  const clamped = sanitizeElement({ ...base, crop: { x: 0.9, y: 0, w: 0.5, h: 1 } }) as ImageElement
  ok(!!clamped?.crop && near(clamped.crop.x + clamped.crop.w, 1), 'x+w past 1 is clamped inside the picture')
  for (const [bad, why] of [
    [{ x: -0.1, y: 0, w: 0.5, h: 0.5 }, 'a negative side'],
    [{ x: 0, y: 0, w: 2, h: 0.5 }, 'a side above 1'],
    [{ x: 0, y: 0, w: 0.5 }, 'a missing side'],
    [{ x: 0, y: 0, w: 1, h: 1 }, 'the whole picture'],
    ['0 0 1 1', 'a string'],
    [{ x: 0, y: 0, w: 0.5, h: 0.5, evil: '"><script>' }, 'an extra key (stripped, crop kept)'],
  ] as Array<[unknown, string]>) {
    const out = sanitizeElement({ ...base, crop: bad }) as ImageElement
    if (why.startsWith('an extra key')) ok(!!out?.crop && !('evil' in out.crop), `drops ${why}`)
    else ok(!!out && out.crop === undefined, `drops ${why}; the element stays`)
  }
}

console.log('\ngeometry: entering crop mode')
{
  // 1600×900 picture in a 400×300 frame
  const contain = defaultImage('x', { x: 100, y: 50, w: 400, h: 300, fit: 'contain' })
  const r = pictureRect(contain, 1600, 900)
  ok(nearRect(r, { x: 0, y: 37.5, w: 400, h: 225 }), 'contain: the picture letterboxes inside the frame')
  ok(nearRect(visibleWindow(contain, r), r), 'contain: the kept window starts as the picture')
  const cover = defaultImage('x', { w: 400, h: 300, fit: 'cover' })
  const rc = pictureRect(cover, 1600, 900)
  ok(near(rc.h, 300) && near(rc.w, 533.333) && near(rc.x, -66.667), 'cover: the picture overflows sideways')
  ok(nearRect(visibleWindow(cover, rc), { x: 0, y: 0, w: 400, h: 300 }), 'cover: the kept window starts as the frame')
  ok(nearRect(pictureRect(defaultImage('x', { fit: 'contain' })), { x: 0, y: 0, w: 400, h: 300 }), 'unknown natural size → the frame')
}

console.log('\ngeometry: an edit keeps the picture where it is')
for (const [label, extra] of [
  ['plain', {}],
  ['rotated 30°', { rotation: 30 }],
  ['flipped H', { flipH: true }],
  ['flipped H+V, rotated -70°', { flipH: true, flipV: true, rotation: -70 }],
] as Array<[string, Partial<ImageElement>]>) {
  const el = defaultImage('x', { x: 200, y: 100, w: 400, h: 300, fit: 'cover', ...extra })
  const nat = [1600, 900] as const
  const before = [[0.3, 0.4], [0.9, 0.1]].map(([u, v]) => slidePoint(el, nat[0], nat[1], u, v))
  const pic = pictureRect(el, ...nat)
  // keep the right half and the top two thirds of what the frame shows
  applyCropEdit(el, pic, { x: 200, y: 0, w: 200, h: 200 })
  ok(!!el.crop && el.fit === 'cover', `${label}: crop stored, fit set to cover (the older-reader fallback)`)
  ok(near(el.w, 200) && near(el.h, 200), `${label}: the frame is the kept window`)
  const after = [[0.3, 0.4], [0.9, 0.1]].map(([u, v]) => slidePoint(el, nat[0], nat[1], u, v))
  ok(before.every((p, i) => near(p.x, after[i].x, 0.02) && near(p.y, after[i].y, 0.02)),
    `${label}: picture points stay put on the slide`)
  // round trip: reopening crop mode on the cropped element finds the same picture rect
  const again = pictureRect(el)
  const back = cropFor(again, { x: 0, y: 0, w: el.w, h: el.h }, el.flipH, el.flipV)!
  ok(near(back.x, el.crop!.x) && near(back.w, el.crop!.w) && near(back.y, el.crop!.y), `${label}: reopening reads the same crop back`)
  // reset: the whole picture again, still in place
  ok(resetCrop(el) && !el.crop, `${label}: reset removes the crop`)
  const reset = [[0.3, 0.4], [0.9, 0.1]].map(([u, v]) => slidePoint(el, el.w, el.h, u, v))
  ok(before.every((p, i) => near(p.x, reset[i].x, 0.02) && near(p.y, reset[i].y, 0.02)), `${label}: …and the picture still has not moved`)
}
{
  const el = defaultImage('x', { w: 400, h: 300, fit: 'contain' })
  const pic = pictureRect(el, 1600, 900)
  applyCropEdit(el, pic, pic)
  ok(!el.crop && near(el.h, 225), 'applying the whole picture removes the crop and fits the frame to it')
  ok(nearRect(frameFor({ x: 0, y: 0, w: 100, h: 50, rotation: 0 }, { x: 10, y: 5, w: 20, h: 10 }), { x: 10, y: 5, w: 20, h: 10 }),
    'frameFor without rotation is a plain offset')
}

console.log('\nstore round trip')
{
  const doc = newDoc()
  doc.slides = [emptySlide({ id: 's1' })]
  const store = new Store(doc)
  store.slide.elements.push(defaultImage('data:image/png;base64,AA==', { id: 'p', x: 100, y: 100, w: 400, h: 300, fit: 'contain' }))
  const el = () => store.element('p') as ImageElement
  const pic = pictureRect(el(), 1600, 900)
  store.commit(() => applyCropEdit(el(), pic, { x: 100, y: 50, w: 200, h: 150 }))
  const cropped = { ...el().crop! }
  ok(near(cropped.x, 0.25) && near(cropped.w, 0.5), 'a crop edit lands in one commit')
  const json = JSON.parse(JSON.stringify(store.doc))
  const reread = json.slides[0].elements.find((e: ImageElement) => e.id === 'p') as ImageElement
  ok(JSON.stringify(normalizeCrop(reread.crop)) === JSON.stringify(cropped), 'the crop survives the document JSON unchanged')
  store.undo()
  ok(!el().crop && el().w === 400 && el().fit === 'contain', 'one undo restores frame, fit and no crop')
  store.redo()
  ok(!!el().crop && near(el().w, 200), 'redo brings the crop back')
  const edits = new ElementEdits(store)
  edits.resetImageCrop('p')
  ok(!el().crop && near(el().w, 400) && near(el().h, 225), 'Reset crop: whole picture, frame grown back to it')
  store.undo()
  ok(!!el().crop && near(el().w, 200), 'Reset crop is one undo step')
}

console.log('\nreset after a free resize (stretched crop)')
{
  // 1600×900 picture, crop of the middle half: an unstretched frame is 400×225
  const el = defaultImage('x', { x: 100, y: 100, w: 400, h: 225, fit: 'cover', crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } })
  el.h = 450 // a free resize: the picture now draws twice as tall as it is
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  const stretched = { ...el }
  ok(resetCrop(stretched) && near(stretched.w / stretched.h, 800 / 900), 'without the natural size, reset keeps the stretch (old behaviour)')
  ok(resetCrop(el, 1600, 900) && !el.crop, 'reset with the natural size removes the crop')
  ok(near(el.w / el.h, 16 / 9), 'reset restores the natural aspect (16:9), not the stretched one')
  ok(near(el.w, 800) && near(el.x + el.w / 2, cx) && near(el.y + el.h / 2, cy), '…keeping the picture width and centre')
  const r = { x: 10, y: 20, w: 300, h: 300 }
  ok(nearRect(unstretched(r, 0, 0), r), 'unstretched without a natural size is a no-op')
  ok(nearRect(unstretched(r, 1600, 900), { x: 10, y: 20 + (300 - 168.75) / 2, w: 300, h: 168.75 }), 'unstretched: width + centre kept, height from the ratio')
  // an unstretched crop resets exactly as before
  const plain = defaultImage('x', { x: 100, y: 100, w: 400, h: 225, fit: 'cover', crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } })
  ok(resetCrop(plain, 1600, 900) && near(plain.w, 800) && near(plain.h, 450) && near(plain.x, -100) && near(plain.y, -12.5),
    'an unstretched crop resets to the same frame with or without the natural size')
}

console.log('\nlayout slot adoption re-fits a cropped donor')
{
  const crop = { x: 0.2, y: 0.1, w: 0.4, h: 0.6 }
  ok(JSON.stringify(refitCrop(crop, 2, 2)) === JSON.stringify(normalizeCrop(crop)), 'same aspect: the crop is unchanged')
  const wider = refitCrop(crop, 1, 2)!
  ok(near(wider.w / wider.h, (0.4 / 0.6) * 2), 'a wider slot: the region takes the slot shape (no stretch)')
  ok(near(wider.w * wider.h, 0.4 * 0.6), '…at the same area of the picture (narrows one axis, widens the other)')
  ok(near(wider.x / (1 - wider.w), 0.2 / 0.6) && near(wider.y / (1 - wider.h), 0.1 / 0.4),
    '…keeping its place in the cut-away margin (object-position)')
  const taller = refitCrop(crop, 1, 0.5)!
  ok(near(taller.w / taller.h, (0.4 / 0.6) / 2) && near(taller.w * taller.h, 0.24), 'a taller slot reshapes it the other way')
  // the reversibility the layout picker needs: switching back and forth must
  // never zoom further in (narrow-only refits compounded on every switch)
  for (const [name, c0] of [
    ['a corner crop', { x: 0, y: 0, w: 0.5, h: 0.5 }],
    ['an off-centre crop', { x: 0.1, y: 0.3, w: 0.4, h: 0.5 }],
    ['a full-width strip', { x: 0, y: 0.25, w: 1, h: 0.5 }],
  ] as const) {
    let c = normalizeCrop(c0)!
    const A = 16 / 9
    const B = 1
    for (let i = 0; i < 3; i++) c = refitCrop(refitCrop(c, A, B)!, B, A)!
    ok(near(c.x, c0.x) && near(c.y, c0.y) && near(c.w, c0.w) && near(c.h, c0.h), `${name}: three A → B → A round trips give the crop back`)
  }
  {
    // no room on the widened axis: shrinks once, then a round trip is stable
    const tall = { x: 0, y: 0.05, w: 1, h: 0.9 }
    const once = refitCrop(refitCrop(tall, 2, 1)!, 1, 2)!
    const twice = refitCrop(refitCrop(once, 2, 1)!, 1, 2)!
    ok(once.w <= 1 && once.h <= 1 && once.x >= 0 && once.y >= 0 && once.x + once.w <= 1 + 1e-9 && once.y + once.h <= 1 + 1e-9,
      'a region with no room to widen shrinks to fit inside the picture')
    ok(near(once.w, twice.w) && near(once.h, twice.h) && near(once.x, twice.x) && near(once.y, twice.y),
      '…and further round trips leave it where it settled (no compounding)')
  }
  const slide = emptySlide({ id: 's1' })
  slide.elements.push(defaultImage('data:image/png;base64,AA==', { id: 'pic', x: 0, y: 0, w: 400, h: 400, fit: 'cover', crop }))
  const layout = emptySlide({ id: 'L' })
  layout.elements.push(defaultShape('rect', { id: 'slot', x: 100, y: 100, w: 800, h: 400, role: 'media' }))
  const out = applyLayout(slide, layout, new Set(['slot']))
  const got = out.find((e) => e.id === 'slot') as ImageElement
  ok(got?.type === 'image' && near(got.w / got.h, 2), 'the picture adopts the slot frame')
  ok(!!got.crop && near((got.crop.w / got.crop.h) * (400 / 400) / (0.4 / 0.6), 2) && near(got.crop.w * got.crop.h, 0.24),
    '…with its crop re-cut to the slot shape (no stretch, same picture area)')
  // and back onto a square slot: the original crop returns
  const square = emptySlide({ id: 'L2' })
  square.elements.push(defaultShape('rect', { id: 'slot', x: 100, y: 100, w: 400, h: 400, role: 'media' }))
  const back = applyLayout({ ...slide, elements: out }, square, new Set(['slot'])).find((e) => e.id === 'slot') as ImageElement
  ok(!!back.crop && near(back.crop.x, crop.x) && near(back.crop.y, crop.y) && near(back.crop.w, crop.w) && near(back.crop.h, crop.h),
    'switching back to a slot of the first shape restores the crop exactly')
  const same = emptySlide({ id: 's2' })
  same.elements.push(defaultImage('data:image/png;base64,AA==', { id: 'pic', x: 0, y: 0, w: 400, h: 200, fit: 'cover', crop }))
  const kept = applyLayout(same, layout, new Set(['slot'])).find((e) => e.id === 'slot') as ImageElement
  ok(JSON.stringify(kept.crop) === JSON.stringify(normalizeCrop(crop)), 'a donor already of the slot aspect keeps its crop')
}

console.log('\nagent update_element: a whole-picture crop removes it')
{
  ok(isWholePictureCrop({ x: 0, y: 0, w: 1, h: 1 }), '{0,0,1,1} reads as removal')
  ok(!isWholePictureCrop({ x: 0, y: 0, w: 0.5, h: 1 }), 'a real crop is not removal')
  ok(!isWholePictureCrop({ x: 0, y: 0, w: 1 }) && !isWholePictureCrop('0 0 1 1') && !isWholePictureCrop(null), 'malformed values are not removal')
  ok(!checkElementProp('image', 'crop', { x: 0, y: 0, w: 1, h: 1 }).ok, 'the element check itself still drops it (CRDT intake unchanged)')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
