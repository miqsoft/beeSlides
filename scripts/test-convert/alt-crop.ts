#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert rig — text alternatives and picture crops.
//
//   node scripts/test-convert/alt-crop.ts        (Node ≥ 23.6 strips types natively)
//
// The fixture (_fixtures.ts fxImportFollowups, slide 1) and every expected
// value are hand-computed. The traps, each with its wrong answer pinned:
//
//   • alt precedence: descr beats title; title alone still counts; nothing at
//     all stays ABSENT (not "") — an empty alt claims "decorative", which
//     would silence the editor's accessibility check about a real picture.
//   • decorative: the a16/adec flag wins even over a leftover descr.
//   • crop: srcRect l/t/r/b are in 1/100000 and name what is CUT, so the
//     model crop is {x:l, y:t, w:1-l-r, h:1-t-b} — not {l,t,r,b} copied.
//   • padding: a NEGATIVE side is space around the picture; the model has no
//     padding, so the frame shrinks to the painted part. The no-trim answer
//     (the box as written) is pinned as an inequality.
//   • markdown: the bracket text is the caption AND the default alt;
//     {fig-alt="…"} overrides only the alt.

import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import { convertMarkdown } from '../../kernel/src/convert/qmd.ts'
import { srcRectCrop, pictureInset, insetFrame } from '../../kernel/src/convert/media.ts'
import { parseXml } from '../../kernel/src/convert/xml.ts'
import type { OutImage, OutChart, OutText } from '../../kernel/src/convert/types.ts'
import { fxImportFollowups } from './_fixtures.ts'
import { fakePng } from './_mdfixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const r = await convertPptx(await fxImportFollowups(), { link: false })
const el = (id: string) => r.doc.slides[0].elements.find((e) => e.id === id)
const codes = (where: string) => r.report.entries.filter((e) => e.where.includes(where)).map((e) => e.code)

// ------------------------------------------------------------------ alt text
{
  const photo = el('s1-2') as OutImage
  ok(photo.alt === 'A red bicycle', `descr is the alt, and beats the title (got ${JSON.stringify(photo.alt)})`)
  const deco = el('s1-3') as OutImage
  ok(deco.alt === '', `a picture marked decorative gets alt "" even with a leftover descr (got ${JSON.stringify(deco.alt)})`)
  const logo = el('s1-4') as OutImage
  ok(logo.alt === 'Company logo', 'a title-only picture takes its title')
  const bare = el('s1-6') as OutImage
  ok(bare !== undefined && !('alt' in bare), 'NEGATIVE — an undescribed picture has NO alt key (not "", which means decorative)')
  const chart = el('s1-7') as OutChart
  ok(chart?.type === 'chart' && chart.alt === 'Sales by region', `a chart takes its graphicFrame's descr (got ${JSON.stringify(chart?.alt)})`)
}

// ---------------------------------------------------------------------- crop
{
  const photo = el('s1-2') as OutImage
  ok(JSON.stringify(photo.crop) === '{"x":0.1,"y":0.2,"w":0.6,"h":0.8}',
    `srcRect l=10% t=20% r=30% → crop {0.1, 0.2, 0.6, 0.8} (got ${JSON.stringify(photo.crop)})`)
  ok(photo.fit === 'cover', 'and fit:cover beside it, as the editor writes a crop')
  ok(photo.x === 96 && photo.y === 96 && photo.w === 192 && photo.h === 96, 'a plain crop leaves the frame alone')
  ok(!r.report.entries.some((e) => e.code === 'image-crop-dropped'), 'no image-crop-dropped report any more')

  const padded = el('s1-5') as OutImage
  ok(padded.x === 48 && padded.y === 192 && padded.w === 192 && padded.h === 96,
    `l=r=-25%: the 288px box trims by 1/6 per side to (48,192,192,96) (got ${padded.x},${padded.y},${padded.w},${padded.h})`)
  ok(padded.w !== 288, 'NEGATIVE — the untrimmed box (288px wide) is absent')
  ok(padded.crop === undefined && padded.fit === 'fill', 'padding alone is no crop: the trimmed box shows the whole picture')
  const pictureCodes = codes('slide 1').filter((c) => c !== 'chart-imported')
  ok(pictureCodes.length === 0, `slide 1's pictures report nothing — every mapping is exact (got ${pictureCodes.join(', ')})`)
}

// ----------------------------------------------------- crop/inset edge cases
{
  const bf = (rect: string) => parseXml(
    `<p:blipFill xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${rect}</p:blipFill>`)
  ok(JSON.stringify(srcRectCrop(bf('<a:srcRect/>'))) === '{}', 'an all-zero srcRect is no crop')
  ok(srcRectCrop(bf('<a:srcRect l="60000" r="50000"/>')).invalid === true, 'a srcRect that cuts everything is invalid')
  ok(JSON.stringify(srcRectCrop(bf('<a:srcRect l="-10000" t="25000" r="10000"/>')).crop) === '{"x":0,"y":0.25,"w":0.9,"h":0.75}',
    'a padded side contributes nothing to the crop (x starts at 0, w = 1 - 0 - r)')
  ok(srcRectCrop(bf('<a:srcRect l="49950" r="49950"/>')).crop?.w === 0.01,
    'a sliver crop is clamped to model.ts MIN_CROP (0.01), as normalizeCrop would')
  // rotation: the painted part's centre moves within the ROTATED box
  const pic = parseXml(
    '<p:pic xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:blipFill><a:srcRect l="-100000"/></p:blipFill></p:pic>')
  const inset = pictureInset(pic)
  ok(inset !== undefined && inset.l === 0.5 && inset.r === 0, 'l=-100%: the left half of the box is padding')
  const img = { x: 0, y: 0, w: 200, h: 100, rotation: 90 } as OutImage
  insetFrame(img, inset)
  // unrotated the picture is the right half: centre (150,50). Rotated 90°
  // about (100,50), that offset (+50,0) becomes (0,+50): centre (100,100).
  ok(img.w === 100 && img.h === 100 && img.x === 50 && img.y === 50,
    `a rotated padded picture keeps its rotation centre honest (got ${img.x},${img.y},${img.w},${img.h})`)
}

// ------------------------------------------------------------- markdown alt
{
  const md = convertMarkdown(
    '## Caption only\n\n![Posterior *draws*](a.png)\n\n' +
    '## With fig-alt\n\n![A caption](a.png){fig-alt="Scatter of draws, slope near 2"}\n\n' +
    '## No words\n\n![](a.png)\n',
    { assets: { 'a.png': fakePng(800, 600) }, name: 'alt.qmd' })
  const imgOf = (i: number) => md.doc.slides[i].elements.find((e) => e.type === 'image') as OutImage | undefined
  ok(imgOf(0)?.alt === 'Posterior draws', `![alt](src): the alt text, as plain text, is the image's alt (got ${JSON.stringify(imgOf(0)?.alt)})`)
  ok(md.doc.slides[0].elements.some((e) => e.type === 'text' && (e as OutText).html.includes('Posterior <i>draws</i>')),
    'and it is still the caption, formatted')
  ok(imgOf(1)?.alt === 'Scatter of draws, slope near 2', 'Quarto fig-alt overrides the alt …')
  ok(md.doc.slides[1].elements.some((e) => e.type === 'text' && (e as OutText).html.includes('A caption')),
    '… and the bracket text stays the caption')
  ok(imgOf(2) !== undefined && !('alt' in imgOf(2)!), 'an empty ![]() leaves the picture undescribed (no alt key)')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
