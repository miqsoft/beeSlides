#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Document validation rig.
//
//   esbuild scripts/test-validate.ts --bundle --platform=node --format=esm ...
//   node <bundle>
//
// (bundled because model.ts and charts.ts use extensionless imports)
//
// WHAT THIS PROVES. `validate()` exists so an agent can see what the runtime
// silently swallows. Its whole value rests on being TRUSTED, and the way it
// loses that is FALSE POSITIVES: an agent told that a real property is unknown
// will delete working configuration, which is worse than never having warned.
//
// So the rig pushes from both sides:
//
//   1. Real content stays quiet. A deck built the way the editor builds one —
//      a new deck, a slide of every built-in slide type, and a chart from a
//      preset — must report NO errors, and a realistic chart option must
//      produce no chart findings at all.
//   2. Broken content is caught. A deck built to trip every check must trip
//      exactly the expected codes, so a check silently ceasing to fire shows up
//      here rather than in somebody's deck.

import { applyChartPalette, builtinLayouts, defaultChart, instantiateLayout, newDoc, relinkSlide } from '../slides/src/model.ts'
import { CHART_PRESETS } from '../slides/src/charts.ts'
import { contrastRatio, parseCssColor, validateDoc } from '../slides/src/validate.ts'
import type { SlidomingoDoc } from '../slides/src/model.ts'
import { sanitizeElement } from '../slides/src/untrusted.ts'
import { canFlip, reflectionCss } from '../slides/src/render.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// ---------------------------------------------------------------- real content
/** What the editor makes: newDoc(), one slide per built-in slide type, and
 *  ＋ Chart's bar preset in the deck's palette on the last one. */
function editorBuiltDoc(): SlidomingoDoc {
  const doc = newDoc()
  doc.slides = builtinLayouts(doc.size).map(instantiateLayout)
  doc.slides[doc.slides.length - 1].elements.push(defaultChart(applyChartPalette(CHART_PRESETS.bar(), doc.theme)))
  return doc
}
const real = validateDoc(editorBuiltDoc(), { measure: false })
ok(real.ok && real.counts.error === 0,
  `an editor-built deck reports no errors (${real.counts.error} error, ${real.counts.warning} warning, ${real.counts.info} info)`)
ok(!real.findings.some((f) => f.code === 'unknown-key'),
  'an editor-built deck has no unknown keys — the generated key tables match the format it is written in')
ok(!real.findings.some((f) => f.code === 'chart-key-ignored'),
  'an editor-built deck has no dead chart options')
ok(!real.findings.some((f) => f.code === 'font-not-embedded'),
  'an editor-built deck carries every typeface it names')
ok(!real.findings.some((f) => f.code === 'overridden-enter-fx'),
  'an editor-built deck has no entrance animations the morph would override')
ok(real.measured === false, 'measured is false without a DOM rather than silently skipping')

// ------------------------------------------------------------- a clean deck
const clean: SlidomingoDoc = {
  format: 'beeslides/slides', version: '1.0.0', docId: 'test', title: 'clean',
  size: { width: 1280, height: 720 }, theme: { accent: '#F7A600', fontFamily: 'system-ui' },
  assets: {}, fonts: null,
  slides: [{
    id: 's1', name: 'one', background: '#FFF', transition: 'fade', notes: '', elements: [
      { id: 'a', type: 'text', x: 96, y: 100, w: 600, h: 120, rotation: 0, opacity: 1,
        html: 'hello', fontSize: 40, fontFamily: 'system-ui', fontWeight: 700,
        color: '#111', align: 'left', valign: 'middle', lineHeight: 1.2 },
    ],
  }],
} as any
const cleanResult = validateDoc(clean, { measure: false })
ok(cleanResult.findings.length === 0,
  `a clean deck produces no findings at all (got ${cleanResult.findings.length}: ${cleanResult.findings.map((f) => f.code).join(', ')})`)

// --------------------------------------------------------------- broken deck
const broken: SlidomingoDoc = {
  ...clean,
  slides: [
    {
      id: 's1', name: 'one', background: '#FFF', transition: 'fade', notes: '', elements: [
        // unknown key, out of canvas, broken link, duplicate id
        { id: 'dup', type: 'text', x: 1000, y: 100, w: 600, h: 120, rotation: 0, opacity: 1,
          html: 'over the edge', fontSize: 40, fontFamily: 'system-ui', fontWeight: 700,
          color: '#111', align: 'left', valign: 'middle', lineHeight: 1.2,
          fontStyle: 'italic', link: 'nope' } as any,
        { id: 'dup', type: 'text', x: 96, y: 300, w: 400, h: 80, rotation: 0, opacity: 1,
          html: 'same id', fontSize: 20, fontFamily: 'system-ui', fontWeight: 400,
          color: '#111', align: 'left', valign: 'middle', lineHeight: 1.2 } as any,
        // dash-march on a solid stroke, and a morph-key collision with 'dup'
        { id: 'dash', morphId: 'dup', type: 'shape', shape: 'line', x: 96, y: 500, w: 400, h: 4,
          rotation: 0, opacity: 1, fill: '#000', stroke: '#000', strokeWidth: 2,
          fx: { loop: { type: 'dash-march' } } } as any,
        // missing asset
        { id: 'img', type: 'image', x: 96, y: 560, w: 100, h: 100, rotation: 0, opacity: 1,
          src: 'asset:nope', fit: 'cover' } as any,
      ],
    },
    {
      id: 's2', name: 'two', background: '#FFF', transition: 'morph', notes: '', elements: [
        // entrance on a morph arrival; also an unknown fx key
        // an entrance on an element that MORPHS in (it shares 'dup' with the
        // previous slide) — already in motion, so fx.enter is skipped. Also
        // carries an unknown fx key.
        { id: 'dup', type: 'text', x: 96, y: 100, w: 400, h: 80, rotation: 0, opacity: 1,
          html: 'x', fontSize: 20, fontFamily: 'system-ui', fontWeight: 400,
          color: '#111', align: 'left', valign: 'middle', lineHeight: 1.2,
          fx: { enter: 'fade-up', wobble: true } } as any,
        // an entrance on an element that is NEW to this slide — nothing to
        // fight, so it runs and must NOT be reported
        { id: 'fresh', type: 'text', x: 96, y: 220, w: 400, h: 80, rotation: 0, opacity: 1,
          html: 'y', fontSize: 20, fontFamily: 'system-ui', fontWeight: 400,
          color: '#111', align: 'left', valign: 'middle', lineHeight: 1.2,
          fx: { enter: 'slide-left' } } as any,
        // a chart with options charts-lite does not implement
        { id: 'c', type: 'chart', x: 600, y: 100, w: 400, h: 300, rotation: 0, opacity: 1,
          preset: 'bar',
          option: {
            xAxis: { type: 'category', data: ['a'] }, yAxis: { type: 'value', inverse: true },
            // `stack` piles bars and lines (read) but does nothing on a scatter (ignored)
            series: [
              { type: 'bar', data: [1], label: { show: true }, stack: 's' },
              { type: 'scatter', data: [[1, 1]], stack: 's' },
              { type: 'line', data: [1], stack: 's' },
            ],
            toolbox: { show: true },
          } } as any,
      ],
    },
  ],
} as any

const r = validateDoc(broken, { measure: false })
const codes = new Set(r.findings.map((f) => f.code))
for (const expected of [
  'unknown-key', 'out-of-canvas', 'broken-link', 'duplicate-id',
  'morph-key-collision', 'dash-march-no-dash', 'missing-asset',
  'overridden-enter-fx', 'chart-key-ignored',
]) {
  ok(codes.has(expected), `the broken deck trips ${expected}`)
}
ok(!r.ok, 'a deck with broken references is not ok')
ok(r.findings.some((f) => f.code === 'chart-key-ignored' && f.path === 'option.series[0].label'),
  'a label on a bar series is reported (it is read for pie only)')
ok(!r.findings.some((f) => f.path === 'option.series[0].stack'),
  'a stack on a bar series is not reported (charts-lite piles stacked bars)')
ok(r.findings.some((f) => f.code === 'chart-key-ignored' && f.path === 'option.series[1].stack'),
  'a stack on a scatter series is reported (charts-lite stacks bars and lines only)')
ok(!r.findings.some((f) => f.path === 'option.series[2].stack'),
  'a stack on a line series is not reported (charts-lite piles stacked lines/areas)')
ok(!r.findings.some((f) => f.path === 'option.yAxis[0].inverse'),
  'inverse on an axis is not reported (read by horizontal bars)')
ok(r.findings.some((f) => f.code === 'unknown-key' && f.path === 'fx.wobble'),
  'an unknown key nested under fx is reported with its path')
ok(!r.findings.some((f) => f.code === 'overridden-enter-fx' && f.element === 'fresh'),
  'an entrance on an element NEW to a morph slide is not reported — it runs')
ok(r.findings.some((f) => f.code === 'overridden-enter-fx' && f.element === 'dup'),
  'an entrance on an element that morphs in IS reported')

// ------------------------------------------------- fonts named but not carried
// The failure mode is invisible to whoever authored the deck, because they are
// exactly the person with the typeface installed. Two gallery templates shipped
// naming Instrument Sans and carrying nothing; on this machine they LOOKED
// right. Only the document can be checked, never the local font list.
const fontDoc = (fontFamily: string, fonts: unknown = null): SlidomingoDoc => ({
  ...clean, fonts,
  theme: { accent: '#F7A600', fontFamily },
} as any)
const named = (d: SlidomingoDoc) => validateDoc(d, { measure: false })
  .findings.filter((f) => f.code === 'font-not-embedded')

ok(named(fontDoc("'Instrument Sans', 'Helvetica Neue', sans-serif")).length === 1,
  'a face named but not carried is reported')
ok(named(fontDoc("'Instrument Sans', sans-serif",
  [{ family: 'Instrument Sans', asset: 'font-instrument', weight: '100 900' }])).length === 0,
  'the same face IS carried → no finding')
for (const stack of [
  'system-ui, sans-serif',
  "'Helvetica Neue', Arial, sans-serif",
  'Georgia, serif',
  "ui-monospace, 'SF Mono', Menlo, monospace",
]) {
  ok(named(fontDoc(stack)).length === 0, `a system stack is not reported (${stack.split(',')[0]})`)
}

// ------------------------------------------------- chart false-positive guard
// The shape a styled chart uses. Every key here IS implemented,
// so any finding is the validator lying about working configuration.
const realisticChart = {
  color: ['#F7A600', '#5B8DEF'],
  grid: { left: 48, right: 16, top: 24, bottom: 56 },
  legend: { show: true, top: 0, textStyle: { fontSize: 13 } },
  tooltip: { trigger: 'axis' },
  xAxis: { type: 'category', data: ['Mon', 'Tue'], axisLine: { lineStyle: { color: '#D8D2C4' } }, axisLabel: { color: '#6B7280' } },
  yAxis: [
    { type: 'value', axisLabel: { color: '#6B7280' }, splitLine: { lineStyle: { color: '#EAE4D6' } } },
    { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
  ],
  series: [
    { type: 'bar', name: 'Signups', data: [1, 2], itemStyle: { borderRadius: [6, 6, 0, 0] } },
    { type: 'line', name: 'Rate', yAxisIndex: 1, data: [3, 4], smooth: true, symbolSize: 8, lineStyle: { width: 3 } },
  ],
}
const chartDoc: SlidomingoDoc = {
  ...clean,
  slides: [{
    id: 's1', name: 'one', background: '#FFF', transition: 'fade', notes: '', elements: [
      { id: 'ch', type: 'chart', x: 96, y: 96, w: 800, h: 400, rotation: 0, opacity: 1,
        // described, as an accessible deck's chart is — this case is about the
        // option, and missing-alt has its own section below
        preset: 'bar', option: realisticChart, alt: 'Signups rose from 1 to 2; rate from 3% to 4%' } as any,
    ],
  }],
} as any
const chartFindings = validateDoc(chartDoc, { measure: false }).findings
ok(chartFindings.length === 0,
  `a realistic dual-axis chart produces no findings (got ${chartFindings.map((f) => f.path).join(', ') || 'none'})`)

// ------------------------------------------------- hidden slides
// Hidden is the one state a slide can be in where nothing on screen reveals a
// mistake: it is skipped silently, exactly as intended, whether or not anyone
// can still get to it.
const hiddenDoc = (link?: string): SlidomingoDoc => ({
  ...clean,
  slides: [
    { id: 's1', name: 'one', background: '#FFF', transition: 'fade', notes: '', elements:
      link ? [{ id: 'go', type: 'shape', shape: 'rect', x: 10, y: 10, w: 50, h: 50, rotation: 0,
                opacity: 1, fill: '#000', stroke: 'none', strokeWidth: 0, radius: 0, link }] : [] },
    { id: 's2', name: 'appendix', background: '#FFF', transition: 'fade', notes: '', hidden: true, elements: [] },
  ],
} as any)
// a hidden slide BEFORE the first normal slide has no parent to press X on
const orphanHiddenDoc = (link?: string): SlidomingoDoc => {
  const d = hiddenDoc(link)
  return { ...d, slides: [d.slides[1], d.slides[0]] }
}
const unreachable = (d: SlidomingoDoc) => validateDoc(d, { measure: false })
  .findings.filter((f) => f.code === 'unreachable-hidden-slide')

ok(unreachable(orphanHiddenDoc()).length === 1,
  'a hidden slide with no slide before it and no link is reported as unreachable')
ok(unreachable(orphanHiddenDoc('s2')).length === 0,
  'a hidden slide with an inbound link is not reported — that is the point of hiding it')
ok(unreachable(hiddenDoc()).length === 0,
  'a hidden slide after a normal slide is its extra (X opens it) — not unreachable')
ok(unreachable(clean).length === 0, 'an ordinary deck reports nothing')
ok(validateDoc(hiddenDoc('s2'), { measure: false }).ok,
  'hiding a slide is never an error')

// ------------------------------------------------- brand palette references
// Both failures are silent: an unresolvable ref simply never updates, and a
// literal that disagrees with its ref is about to be overwritten by the next
// palette edit, which reads as the app changing a colour by itself.
const refDoc = (refs: Record<string, string>, fill = '#F7A600'): SlidomingoDoc => ({
  ...clean,
  slides: [{
    id: 's1', name: 'one', background: '#FFF', transition: 'fade', notes: '', elements: [
      { id: 'sh', type: 'shape', shape: 'rect', x: 96, y: 96, w: 100, h: 100, rotation: 0,
        opacity: 1, fill, stroke: 'none', strokeWidth: 0, radius: 0, themeRefs: refs } as any,
    ],
  }],
} as any)
const refCodes = (d: SlidomingoDoc) => new Set(validateDoc(d, { measure: false }).findings.map((f) => f.code))
ok(refCodes(refDoc({ fill: 'accent1' })).size === 0,
  'a correct palette reference is silent')
ok(refCodes(refDoc({ fill: 'ghost' })).has('theme-ref-malformed'),
  'a reference naming something that is not a slot is reported as malformed')
// hlink/folHlink are the only slots that can genuinely be empty — every other
// one falls back in paletteOf, deliberately, so a reference never dangles just
// because nobody opened the theme editor.
ok(refCodes(refDoc({ fill: 'hlink' })).has('theme-ref-unknown-slot'),
  'a reference to a slot with no value set is reported')
ok(refCodes(refDoc({ fill: 'accent1 nonsense' })).has('theme-ref-malformed'),
  'a malformed reference token is reported')
ok(refCodes(refDoc({ 'shadow.color': 'accent1' })).has('theme-ref-dangling'),
  'a reference with no colour to control is reported')
ok(refCodes(refDoc({ fill: 'accent1' }, '#123456')).has('theme-ref-stale'),
  'a literal that disagrees with its reference is reported before the palette overwrites it')

// ---------------------------------------------------------------- reflection
console.log('\nreflection')
const reflDoc = (reflection: unknown): SlidomingoDoc => ({
  ...clean,
  slides: [{
    id: 's1', name: 'one', background: '#FFF', transition: 'fade', notes: '', elements: [
      { id: 'sh', type: 'shape', shape: 'rect', x: 96, y: 96, w: 100, h: 100, rotation: 0,
        opacity: 1, fill: '#123456', stroke: 'none', strokeWidth: 0, radius: 0, reflection } as any,
    ],
  }],
} as any)
ok(!validateDoc(reflDoc({ opacity: 0.4, size: 0.5, gap: 4 }), { measure: false })
  .findings.some((f) => f.severity === 'error' || /reflection/.test(f.message)),
  'a reflection is a known property — validate() stays quiet')
const sane = (v: unknown) => (sanitizeElement({
  id: 'a', type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1,
  fill: '#fff', stroke: 'none', strokeWidth: 0, radius: 0, reflection: v,
}) as any)?.reflection
ok(JSON.stringify(sane({ opacity: 0.3, size: 1, gap: 6 })) === JSON.stringify({ opacity: 0.3, size: 1, gap: 6 }),
  'a valid reflection survives sanitizing unchanged')
ok(JSON.stringify(sane({ opacity: 7, size: -2, gap: 5 })) === JSON.stringify({ gap: 5 }),
  'out-of-range reflection numbers are dropped (the renderer then uses the defaults)')
ok(!('url' in (sane({ opacity: 0.3, url: 'https://evil/x' }) ?? {})),
  'unknown reflection keys are dropped')
ok(reflectionCss(undefined) === 'none', 'no reflection clears the CSS')
ok(reflectionCss({}) === 'below 0px linear-gradient(transparent 50%, rgba(0,0,0,0.35))',
  'an empty reflection renders with the documented defaults (opacity .35, size .5, gap 0)')
ok(reflectionCss({ opacity: 9, size: 9, gap: 3 }) === 'below 3px linear-gradient(transparent 0%, rgba(0,0,0,1))',
  'rendering clamps opacity and size too — a hand-edited file cannot emit broken CSS')

// ---------------------------------------------------------------- flip
console.log('\nflip')
const flipOf = (type: string, extra: object) => (sanitizeElement({
  id: 'a', type, x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, ...extra, flipH: true, flipV: 'yes',
}) as any)
const shapeFlip = flipOf('shape', { shape: 'rect', fill: '#fff', stroke: 'none', strokeWidth: 0, radius: 0 })
ok(shapeFlip?.flipH === true && !('flipV' in shapeFlip),
  'a shape keeps a boolean flipH and drops a non-boolean flipV')
ok(!('flipH' in (flipOf('text', { html: 'x', fontSize: 20, fontFamily: 'a', fontWeight: 400, color: '#000', align: 'left', valign: 'top', lineHeight: 1.2 }) ?? {})),
  'text has no flip — the field is not part of its format')
ok(canFlip({ type: 'image' } as any) && canFlip({ type: 'svg' } as any) && !canFlip({ type: 'chart' } as any),
  'canFlip covers shape / image / svg only')

// ---------------------------------------------------------------- accessibility
// Each check is held to the same bar as the rest of this file: it must fire on
// the case it exists for and stay QUIET on everything it cannot be sure about.
console.log('\naccessibility')
const T = (id: string, extra: object = {}) => ({
  id, type: 'text', x: 96, y: 300, w: 600, h: 80, rotation: 0, opacity: 1,
  html: 'Body text', fontSize: 20, fontFamily: 'system-ui', fontWeight: 400,
  color: '#111111', align: 'left', valign: 'top', lineHeight: 1.2, ...extra,
})
const TITLE = (extra: object = {}) => T('ti', { y: 60, html: 'A title', fontSize: 44, role: 'title', ...extra })
const RECT = (id: string, fill: string, extra: object = {}) => ({
  id, type: 'shape', shape: 'rect', x: 60, y: 260, w: 700, h: 200, rotation: 0, opacity: 1,
  fill, stroke: 'none', strokeWidth: 0, radius: 0, ...extra,
})
const IMG = (id: string, extra: object = {}) => ({
  id, type: 'image', x: 800, y: 100, w: 300, h: 200, rotation: 0, opacity: 1,
  src: 'data:image/png;base64,AAAA', fit: 'cover', radius: 0, ...extra,
})
const a11yDoc = (slides: Array<{ elements: object[]; background?: string; stateOf?: string; layoutId?: string }>, extra: object = {}): SlidomingoDoc => ({
  ...clean,
  slides: slides.map((sl, i) => ({ id: `s${i + 1}`, name: '', background: '#FFFFFF', transition: 'fade', notes: '', ...sl })),
  ...extra,
} as any)
const a11y = (d: SlidomingoDoc, code: string) => validateDoc(d, { measure: false }).findings.filter((f) => f.code === code)

// colour reading + the WCAG arithmetic itself
ok(Math.abs(contrastRatio(parseCssColor('#000')!, parseCssColor('white')!) - 21) < 1e-9, 'black on white is 21:1')
ok(contrastRatio(parseCssColor('#777777')!, parseCssColor('#FFF')!) < 4.5 && contrastRatio(parseCssColor('#767676')!, parseCssColor('#FFF')!) >= 4.5,
  '#767676 is the lightest grey that passes 4.5:1 on white — the textbook boundary')
ok(JSON.stringify(parseCssColor('rgba(255, 0, 0, 0.5)')) === JSON.stringify([255, 0, 0, 0.5])
  && JSON.stringify(parseCssColor('rgb(0 128 255 / 50%)')) === JSON.stringify([0, 128, 255, 0.5])
  && JSON.stringify(parseCssColor('#0f08')) === JSON.stringify([0, 255, 0, 136 / 255]),
  'rgba(), space-separated rgb() with a % alpha and #rgba all read')
ok(parseCssColor('color(srgb 1 1 1 / 0.5)')?.[0] === 255, 'color(srgb …) — the longest notation real decks carry — reads')
ok(parseCssColor('linear-gradient(#000, #fff)') === null && parseCssColor('var(--x)') === null
  && parseCssColor('rebeccapurple') === null && parseCssColor('color(display-p3 1 0 0)') === null,
  'gradients, variables, unlisted names and other colour spaces are "unknown", never guessed')

// missing-alt
ok(a11y(a11yDoc([{ elements: [IMG('i')] }]), 'missing-alt').length === 1, 'a picture with no alt is reported')
ok(a11y(a11yDoc([{ elements: [IMG('i', { alt: 'A bicycle' })] }]), 'missing-alt').length === 0, 'one with alt text is not')
ok(a11y(a11yDoc([{ elements: [IMG('i', { alt: '' })] }]), 'missing-alt').length === 0, 'alt "" (decorative) is an answer, not a gap')
ok(a11y(a11yDoc([{ elements: [IMG('i', { alt: '   ' })] }]), 'missing-alt').length === 1, 'whitespace is not a description')
ok(a11y(a11yDoc([{ elements: [IMG('i', { hidden: true })] }]), 'missing-alt').length === 0, 'a hidden picture is never shown, so never asked about')
ok(a11y(a11yDoc([{ elements: [
  { id: 'c', type: 'chart', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, option: {} },
  { id: 'v', type: 'svg', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, markup: '<svg/>' },
  { id: 'm', type: 'media', kind: 'video', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, src: 'x.mp4' },
  RECT('r', '#eee'), T('t'),
] }]), 'missing-alt').map((f) => f.element).join() === 'c,v,m', 'charts, svgs and media are asked too — shapes and text never')
{
  const logo = IMG('logo')
  const d = a11yDoc([{ elements: [logo], layoutId: 'L' }, { elements: [logo], layoutId: 'L' }],
    { layouts: [{ id: 'L', name: 'L', background: '#FFF', transition: 'fade', notes: '', elements: [logo] }] })
  ok(a11y(d, 'missing-alt').length === 1, "a slide type's logo, on every linked slide, is ONE finding — it is one fix")
  ok(a11y(d, 'missing-alt')[0].layout === 'L', '…and it names the slide type, where the fix lasts (Check slides opens it there)')
}
{
  // The fix the finding leads to: describe the logo IN THE SLIDE TYPE, and
  // every linked slide carries it through a resync — the finding is gone,
  // not moved on to the next slide.
  const d: any = a11yDoc([], { layouts: [{ id: 'L', name: 'L', background: '#FFFFFF', transition: 'fade', notes: '', elements: [IMG('logo')] }] })
  d.slides = [0, 1, 2].map(() => ({ ...instantiateLayout(d.layouts[0]), layoutId: 'L' }))
  ok(a11y(d, 'missing-alt').length === 1, 'three slides of one type: one logo finding')
  d.layouts[0].elements[0].alt = 'Company logo'
  for (const sl of d.slides) relinkSlide(d, sl.id, 'L')
  ok(a11y(d, 'missing-alt').length === 0 && d.slides.every((sl: any) => sl.elements[0].alt === 'Company logo'),
    'described in the slide type, then resynced: every slide carries it and nothing is left to report')
  // a slide whose copy has not been resynced yet is stale, and is its own gap
  d.slides[1].elements[0].alt = undefined
  const stale = a11y(d, 'missing-alt')
  ok(stale.length === 1 && stale[0].slide === d.slides[1].id && !stale[0].layout,
    'a stale copy of an already-described slide-type element is reported on its slide, not as slide-type work')
  // a slide that swapped the logo for its own picture holds content now
  d.slides[1].elements[0].alt = 'Company logo'
  d.slides[0].elements[0].src = 'data:image/png;base64,BBBB'; d.slides[0].elements[0].alt = undefined
  d.slides[2].elements[0].src = 'data:image/png;base64,CCCC'; d.slides[2].elements[0].alt = undefined
  ok(a11y(d, 'missing-alt').length === 2, 'copies whose picture differs from the slide type are each their own finding')
}
{
  // A FILLED media slot keeps the layout's slot id (model.ts applyLayout), so
  // ten picture slides of one type share one element id while each shows its
  // own photo — every one of them is a separate gap.
  const doc: any = newDoc()
  const L = builtinLayouts(doc).find((l) => l.elements.some((e) => e.role === 'media'))!
  doc.layouts = [JSON.parse(JSON.stringify(L))]
  const photo = (src: string) => {
    const sl: any = { ...instantiateLayout(doc.layouts[0]), layoutId: L.id }
    const slot = sl.elements.find((e: any) => e.role === 'media')
    Object.assign(slot, { type: 'image', src, fit: 'cover', radius: 0 })
    return sl
  }
  doc.slides = [photo('data:image/png;base64,AAAA'), photo('data:image/png;base64,BBBB')]
  const f = a11y(doc, 'missing-alt')
  ok(f.length === 2 && f.every((x) => !x.layout), 'two picture slides of one slide type with different undescribed photos: two findings, each on its slide')
  doc.slides[1].elements.find((e: any) => e.role === 'media').src = 'data:image/png;base64,AAAA'
  ok(a11y(doc, 'missing-alt').length === 2, 'even the SAME photo in two slots is two findings — a slot is content, never chrome')
}
{
  // low-contrast: placeholder text keeps the layout's ids too
  const ti = (html: string) => T('ti', { html, role: 'title', color: '#BBBBBB' })
  const chrome = T('tag', { y: 600, html: 'CONFIDENTIAL', color: '#BBBBBB' })
  const lay = { id: 'L', name: 'L', background: '#FFFFFF', transition: 'fade', notes: '', elements: [ti('Title'), chrome] }
  const d = a11yDoc([{ elements: [ti('One'), chrome], layoutId: 'L' }, { elements: [ti('Two'), chrome], layoutId: 'L' }], { layouts: [lay] })
  const f = a11y(d, 'low-contrast')
  ok(f.filter((x) => x.element === 'ti').length === 2, "each slide's own title in a title slot is its own low-contrast finding")
  ok(f.filter((x) => x.element === 'tag').length === 1, 'unchanged slide-type text on the same backdrop is ONE')
}

// low-contrast
ok(a11y(a11yDoc([{ elements: [T('t', { color: '#777777' })] }]), 'low-contrast').length === 1, '#777 body text on white is reported (4.48:1 < 4.5)')
ok(a11y(a11yDoc([{ elements: [T('t', { color: '#767676' })] }]), 'low-contrast').length === 0, '#767676 is not (4.54:1)')
ok(a11y(a11yDoc([{ elements: [T('t', { color: '#777777', fontSize: 24 })] }]), 'low-contrast').length === 0, 'large text (24px) only needs 3:1')
ok(a11y(a11yDoc([{ elements: [T('t', { color: '#777777', fontSize: 19, fontWeight: 700 })] }]), 'low-contrast').length === 0, 'so does bold text from 18.66px')
ok(a11y(a11yDoc([{ elements: [T('t', { color: '#AAAAAA', fontSize: 40 })] }]), 'low-contrast').length === 1, 'large text below 3:1 is still reported')
ok(a11y(a11yDoc([{ elements: [T('t', { color: '#111111', opacity: 0.3 })] }]), 'low-contrast').length === 1, "element opacity fades the text toward its backdrop, and counts")
ok(a11y(a11yDoc([{ elements: [RECT('card', '#1D1119'), T('t', { color: '#FFFFFF' })] }]), 'low-contrast').length === 0,
  'white text on a dark card is judged against the CARD, not the white slide')
ok(a11y(a11yDoc([{ elements: [RECT('card', '#1D1119'), T('t', { color: '#222222' })] }]), 'low-contrast').length === 1,
  'and dark text on that dark card is reported')
{
  // a 50% black card over white reads as #808080: black text 5.3:1 (passes),
  // large white text 3.9:1 (passes 3:1), #333 text 3.2:1 (fails 4.5:1). Only
  // real compositing gets all three — treating the card as opaque, ignoring
  // it, or skipping translucent cards each gets at least one wrong.
  const onHalf = (t: object) => a11y(a11yDoc([{ elements: [RECT('card', 'rgba(0,0,0,0.5)'), T('t', t)] }]), 'low-contrast').length
  ok(onHalf({ color: '#000000' }) === 0 && onHalf({ color: '#FFFFFF', fontSize: 30 }) === 0 && onHalf({ color: '#333333' }) === 1,
    'a translucent card is composited over the slide behind it')
}
ok(a11y(a11yDoc([{ elements: [RECT('card', '#1D1119', { w: 300 }), T('t', { color: '#FFFFFF' })] }]), 'low-contrast').length === 0,
  'a card that covers only PART of the text box: unknowable, so quiet')
ok(a11y(a11yDoc([{ elements: [IMG('ph', { x: 0, y: 0, w: 1280, h: 720, alt: '' }), T('t', { color: '#FFFFFF' })] }]), 'low-contrast').length === 0,
  'text over a photo: unknowable, so quiet')
ok(a11y(a11yDoc([{ elements: [RECT('o', 'none', { stroke: '#000', strokeWidth: 2 }), T('t', { color: '#777777' })] }]), 'low-contrast').length === 1,
  'an outline-only frame is looked through to the slide behind it')
ok(a11y(a11yDoc([{ elements: [T('t', { color: '#FFFFFF' })], background: 'linear-gradient(#000, #333)' }]), 'low-contrast').length === 0,
  'a gradient slide background: unknowable, so quiet')
ok(a11y(a11yDoc([{ elements: [T('t', { color: '#FFFFFF', colorGradient: { angle: 90, stops: [{ at: 0, color: '#fff' }, { at: 1, color: '#eee' }] } })] }]), 'low-contrast').length === 0,
  'gradient text: unknowable, so quiet')
ok(a11y(a11yDoc([{ elements: [T('t', { color: '#FFFFFF', html: '<span style="color:#000">dark</span>' })] }]), 'low-contrast').length === 0,
  'inline colour runs override the element colour: quiet rather than wrong')
ok(a11y(a11yDoc([{ elements: [T('t', { color: '#FFFFFF', html: '', placeholder: 'Click to add text' })] }]), 'low-contrast').length === 0,
  'an empty placeholder is hidden while presenting, so it is not read at all')

// missing-title
ok(a11y(a11yDoc([{ elements: [TITLE(), T('a'), T('b', { y: 400 })] }]), 'missing-title').length === 0, 'a slide with a written title is fine')
ok(a11y(a11yDoc([{ elements: [T('a'), T('b', { y: 400 })] }]), 'missing-title').length === 1, 'two pieces of body text and no title is reported')
ok(a11y(a11yDoc([{ elements: [TITLE({ html: '' }), T('a')] }]), 'missing-title').length === 1, 'an EMPTY title slot beside written text is reported')
ok(a11y(a11yDoc([{ elements: [] }]), 'missing-title').length === 0, 'a blank slide is not')
ok(a11y(a11yDoc([{ elements: [IMG('i', { alt: 'x' })] }]), 'missing-title').length === 0, 'nor a picture-only slide')
ok(a11y(a11yDoc([{ elements: [T('a', { fontSize: 64 })] }]), 'missing-title').length === 0, 'nor a one-statement / section-divider slide')
ok(a11y(a11yDoc([{ elements: [TITLE({ html: '' }), T('b', { html: '', placeholder: 'Body' })] }]), 'missing-title').length === 0,
  'nor a fresh slide whose placeholders are all still empty')
ok(a11y(a11yDoc([{ elements: [TITLE()] }, { elements: [T('a'), T('b', { y: 400 })], stateOf: 's1' }]), 'missing-title').length === 0,
  "an interactive state shares its parent's title")
ok(a11y(a11yDoc([{ elements: [T('a'), T('b', { y: 400 })] }], { kind: 'figure' }), 'missing-title').length === 0,
  'a figure document has no slides to title')
ok(a11y(a11yDoc([{ elements: [T('a'), T('pg', { x: 1180, y: 680, w: 60, h: 24, fontSize: 12, footerRole: 'slideNumber' })] }]), 'missing-title').length === 0,
  'footer furniture is not body text')
{
  const built = validateDoc(editorBuiltDoc(), { measure: false }).findings
  ok(!built.some((f) => f.code === 'low-contrast' || f.code === 'missing-title'),
    `an editor-built deck (every built-in slide type, still empty) raises no contrast or title findings (${built.filter((f) => f.code === 'low-contrast' || f.code === 'missing-title').map((f) => f.code + '@' + f.slide).join(', ')})`)
}

// --------------------------------------------------------------- equations
console.log('\nequations')
{
  const eq = (over: Record<string, unknown>) => ({
    id: 'q', type: 'math', x: 200, y: 200, w: 600, h: 160, rotation: 0, opacity: 1,
    tex: 'x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}', fontSize: 48, color: '#111', align: 'center', valign: 'middle', ...over,
  })
  const deck = (...els: unknown[]) => ({ ...clean, slides: [{ ...clean.slides[0], elements: [...clean.slides[0].elements, ...els] }] }) as any
  const of = (d: SlidomingoDoc, code: string) => validateDoc(d, { measure: false }).findings.filter((f) => f.code === code)
  const good = validateDoc(deck(eq({}), eq({ id: 'q2', y: 400, tex: '\\sum_{i=1}^{n} i', inline: true })), { measure: false })
  ok(good.findings.length === 0, `a valid equation (display and inline) raises nothing (${good.findings.map((f) => f.code).join(', ') || 'none'})`)
  const bad = of(deck(eq({ tex: '\\frac{a' })), 'math-parse-error')
  ok(bad.length === 1 && bad[0].severity === 'error' && bad[0].element === 'q' && bad[0].path === 'tex',
    'TeX that does not typeset is an error on the element’s tex')
  ok(/not typeset/.test(bad[0]?.message ?? '') && !/\n/.test(bad[0]?.message ?? ''), 'the message says why, on one line')
  ok(of(deck(eq({ tex: '\\href{javascript:alert(1)}{x}' })), 'math-parse-error').length === 1, 'refused TeX (trust off) is reported, not typeset')
  ok(of(deck(eq({ tex: '  ' })), 'math-empty').length === 1, 'an empty equation is reported')
  ok(of(deck(eq({ tex: '  ' })), 'math-parse-error').length === 0, 'an empty equation is not also a parse error')
  ok(of(deck(eq({ fontFamily: 'serif' })), 'unknown-key').length === 1, 'a key the math element does not define is reported (no fontFamily)')
  ok(sanitizeElement(eq({})) !== null, 'a valid equation passes the clipboard check too')
}

// unlicensed-artwork: only artwork that CARRIES a provenance is judged
{
  const lic = (d: SlidomingoDoc) => a11y(d, 'unlicensed-artwork')
  const prov = { origin: 'Team icons', url: 'https://icons.example/cloud.svg' }
  ok(lic(a11yDoc([{ elements: [IMG('i')] }])).length === 0, 'a picture with no recorded origin is never flagged')
  const flagged = lic(a11yDoc([{ elements: [IMG('i', { provenance: prov })] }]))
  ok(flagged.length === 1 && flagged[0].severity === 'info' && flagged[0].path === 'provenance.license' && /Team icons/.test(flagged[0].message),
    'a recorded origin without a license is reported, naming the origin')
  ok(lic(a11yDoc([{ elements: [IMG('i', { provenance: { ...prov, license: 'CC0-1.0' } })] }])).length === 0, 'with a license it is quiet')
  ok(lic(a11yDoc([{ elements: [IMG('i', { provenance: { ...prov, license: '  ' } })] }])).length === 1, 'a blank license is no license')
  ok(lic(a11yDoc([{ elements: [{ id: 'v', type: 'svg', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, markup: '<svg/>', provenance: prov }] }])).length === 1, 'diagrams are judged too')
  ok(lic(a11yDoc([{ elements: [IMG('i', { provenance: 'x' })] }])).length === 0, 'a malformed provenance is not this check’s business')
  const logo = IMG('logo', { provenance: prov })
  ok(lic(a11yDoc([{ elements: [logo] }, { elements: [logo] }])).length === 1, 'the same element on several slides is one finding')
  ok(a11y(a11yDoc([{ elements: [IMG('i', { provenance: { ...prov, license: 'MIT' } })] }]), 'unknown-key').length === 0
    && validateDoc(a11yDoc([{ elements: [IMG('i', { provenance: prov })] }]), { measure: false }).findings.every((f) => f.code !== 'unknown-key'),
    'provenance is a format key, not reported as unknown')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
