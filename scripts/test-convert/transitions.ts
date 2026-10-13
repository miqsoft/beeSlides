#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert rig — p:transition → Slide.transition / transitionDir.
//
//   node scripts/test-convert/transitions.ts        (Node ≥ 23.6 strips types natively)
//
// Fixture: _fixtures.ts fxImportFollowups, slides 1–8. The traps:
//
//   • absence is 'none', never omitted: slides' constructors default to
//     'fade', so a missing key would fade every cut.
//   • direction flips: OOXML names the way the slide MOVES (push dir="u" =
//     moves up), the model where it comes FROM (bottom). The unflipped answer
//     ('top') is pinned as an inequality.
//   • mc:AlternateContent: a Choice we cannot draw (p14:prism) falls back to
//     the producer's own Fallback — reported, naming the effect that was
//     replaced (the report is honest about every approximation); Morph does NOT — its fade
//     fallback is exactly the unwanted whole-slide fade pptx.ts's header
//     warns about, so it stays a cut and says so.
//   • a default direction is left absent, as model.ts TRANSITION_DIRS does.

import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import { fxImportFollowups } from './_fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

for (const link of [false, true]) {
  const r = await convertPptx(await fxImportFollowups(), { link })
  const tag = link ? 'linked' : 'flattened'
  const s = (n: number) => r.doc.slides[n - 1]
  const codesAt = (n: number) => r.report.entries.filter((e) => e.where === `slide ${n}`).map((e) => e.code)
  const t = (n: number) => `${s(n).transition}${s(n).transitionDir ? `/${s(n).transitionDir}` : ''}`

  ok(s(1).transition === 'none' && !('transitionDir' in s(1)), `${tag}: no p:transition → 'none' written explicitly`)
  ok(t(2) === 'push/bottom', `${tag}: push dir="u" (moves up) → push from the bottom (got ${t(2)})`)
  ok(s(2).transitionDir !== 'top', `${tag}: NEGATIVE — the unflipped direction (top) is absent`)
  const prism = r.report.entries.filter((e) => e.where === 'slide 3' && e.code === 'transition-approximated')
  ok(t(3) === 'fade' && prism.length === 1 && prism[0].detail.includes('"prism"') && prism[0].detail.includes('fallback'),
    `${tag}: an unknown p14 Choice falls back to its Fallback fade, reported as replacing "prism" (got ${t(3)}, ${prism.map((e) => e.detail).join(' | ')})`)
  ok(!codesAt(2).includes('transition-approximated') && !codesAt(6).includes('transition-approximated'),
    `${tag}: NEGATIVE — an exact effect with nothing skipped is not reported`)
  ok(t(4) === 'none' && codesAt(4).includes('transition-morph-dropped'),
    `${tag}: Morph stays a cut — NOT its Fallback fade — and is reported (got ${t(4)})`)
  ok(t(5) === 'split', `${tag}: split orient="vert" is the model's default split (dir absent) (got ${t(5)})`)
  ok(t(6) === 'wipe/top', `${tag}: wipe dir="d" → from the top (got ${t(6)})`)
  ok(t(7) === 'cover/left' && codesAt(7).includes('transition-approximated'),
    `${tag}: cover dir="rd" keeps its horizontal half (moves right = from the left), approximated (got ${t(7)})`)
  ok(t(8) === 'fade' && codesAt(8).includes('transition-approximated'),
    `${tag}: an effect known nowhere (p14:vortex, no Fallback) becomes a fade, reported (got ${t(8)})`)
  ok(t(9) === 'none', `${tag}: the lists slide has no transition`)
  ok(r.doc.slides.every((sl) => sl.transitionDir === undefined || ['push', 'wipe', 'cover', 'split'].includes(sl.transition)),
    `${tag}: transitionDir only on kinds that take one`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
