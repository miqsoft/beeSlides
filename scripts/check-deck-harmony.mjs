#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Measures how much a saved deck looks like ONE system (docs/deck-pipeline.md,
// "Testing"): slide types and their runs, title frames per type, typefaces,
// off-palette colours, effects, motion, text per slide, notes. With a profile
// (design-rules.md DeckProfile, as JSON) it also lists what goes against it.
// A measuring tool for before/after comparisons, not a test rig: it never
// fails, it reports.
//
//   node scripts/check-deck-harmony.mjs deck.beeslides.html [--profile p.json] [--json]

import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--') && !a.endsWith('.json'))
const profileArg = args.indexOf('--profile')
const profile = profileArg >= 0 ? JSON.parse(readFileSync(args[profileArg + 1], 'utf8')) : null
const asJson = args.includes('--json')
if (!file) {
  console.log('usage: node scripts/check-deck-harmony.mjs <deck.beeslides.html> [--profile p.json] [--json]')
  process.exit(2)
}

// both names: kernel/src/legacynames.ts
const BLOCK_RE = /<script[^>]*\bid=["'](?:beeslides|slidomingo)-doc["'][^>]*>([\s\S]*?)<\/script>/i
const m = BLOCK_RE.exec(readFileSync(file, 'utf8'))
if (!m) { console.log(`no document block in ${file}`); process.exit(2) }
const doc = JSON.parse(m[1])

/** Characters a slide's text needs before it fits the typical-slide budget
 *  (DeckProfile.balance 1 = mostly text … 5 = visual only). A heuristic. */
const TEXT_BUDGET = { 1: 700, 2: 450, 3: 300, 4: 160, 5: 80 }
const CALM_FX = new Set(['enter', 'enterDur', 'order', 'step', 'exit', 'exitStep', 'exitDur', 'byParagraph', 'countUp'])
const CALM_TRANSITIONS = new Set([undefined, '', 'none', 'fade'])

const plain = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
const firstFamily = (f) => String(f ?? '').split(',')[0].replace(/["']/g, '').trim().toLowerCase()
const hex = (c) => {
  if (typeof c !== 'string') return null
  const s = c.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map((x) => x + x).join('')
  return /^#[0-9a-f]{6}$/.test(s) ? s : /^#[0-9a-f]{8}$/.test(s) ? s.slice(0, 7) : null
}

const theme = doc.theme ?? {}
const palette = new Set([theme.background, theme.color, theme.accent, ...Object.values(theme.palette ?? {})].map(hex).filter(Boolean))
const NEUTRAL = new Set(['#000000', '#ffffff'])
const layouts = new Map((doc.layouts ?? []).map((l) => [l.id, l]))
const typeName = (id) => (id ? layouts.get(id)?.name ?? id : '(none)')

// the slides an audience walks through: states are reached by links only
const slides = (doc.slides ?? []).filter((s) => !s.stateOf)
const shown = slides.filter((s) => !s.hidden)

const out = {
  file, slides: slides.length, shown: shown.length,
  slideTypes: 0, linkedShare: 0, longestRun: null, runsOver3: [],
  titleFrames: [], typefaces: [], offPalette: [], effects: {}, motion: {}, text: {}, notesShare: 0,
  againstProfile: [],
}

// ---- slide types and runs
const used = new Map()
for (const s of shown) used.set(s.layoutId ?? null, (used.get(s.layoutId ?? null) ?? 0) + 1)
out.slideTypes = [...used.keys()].filter(Boolean).length
out.linkedShare = shown.length ? +(shown.filter((s) => s.layoutId).length / shown.length).toFixed(2) : 0
let run = { type: null, from: 0, len: 0 }
const runs = []
shown.forEach((s, i) => {
  const t = s.layoutId ?? null
  if (t && t === run.type) run.len++
  else { if (run.type) runs.push(run); run = { type: t, from: i + 1, len: 1 } }
})
if (run.type) runs.push(run)
const longest = runs.reduce((a, r) => (r.len > (a?.len ?? 0) ? r : a), null)
out.longestRun = longest && { type: typeName(longest.type), from: longest.from, length: longest.len }
out.runsOver3 = runs.filter((r) => r.len > 3).map((r) => ({ type: typeName(r.type), from: r.from, length: r.len }))

// ---- title frames per type: one frame per type is a system
const titles = new Map()
for (const s of shown) {
  const t = (s.elements ?? []).find((e) => e.role === 'title')
  if (!t) continue
  const key = typeName(s.layoutId)
  const frame = `${Math.round(t.x)},${Math.round(t.y)} ${Math.round(t.fontSize ?? 0)}px`
  if (!titles.has(key)) titles.set(key, new Map())
  titles.get(key).set(frame, (titles.get(key).get(frame) ?? 0) + 1)
}
out.titleFrames = [...titles].map(([type, frames]) => ({ type, distinct: frames.size, frames: Object.fromEntries(frames) }))

// ---- typefaces, colours, effects, motion, text, notes
const faces = new Set([firstFamily(theme.fontFamily), firstFamily(theme.headingFamily)].filter(Boolean))
const off = new Map()
const effects = { maxRadius: 0, shadows: 0, gradients: 0, blur: 0, libraryArt: 0 }
const motion = { calmSlides: 0, subtleSlides: 0, expressiveSlides: 0, expressive: [] }
const chars = []
let withNotes = 0
shown.forEach((s, i) => {
  let level = CALM_TRANSITIONS.has(s.transition) ? 0 : s.transition === 'morph' ? 1 : 2
  let n = 0
  for (const e of s.elements ?? []) {
    if (e.fontFamily) faces.add(firstFamily(e.fontFamily))
    for (const field of ['color', 'fill', 'stroke']) {
      const c = hex(e[field])
      if (!c || palette.has(c) || NEUTRAL.has(c) || e.themeRefs?.[field]) continue
      off.set(c, (off.get(c) ?? 0) + 1)
    }
    if (typeof e.radius === 'number') effects.maxRadius = Math.max(effects.maxRadius, e.radius)
    if (e.shadow) effects.shadows++
    if (e.fillGradient) effects.gradients++
    if (e.backdropFilter) effects.blur++
    if (e.provenance) effects.libraryArt++
    for (const k of Object.keys(e.fx ?? {})) level = Math.max(level, CALM_FX.has(k) ? 1 : 2)
    if (e.type === 'text' || e.type === 'code') n += plain(e.html ?? e.content).length
    if (e.type === 'table') for (const r of e.rows ?? []) for (const c of r.cells ?? []) n += plain(c.html).length
  }
  if (level === 0) motion.calmSlides++
  else if (level === 1) motion.subtleSlides++
  else { motion.expressiveSlides++; motion.expressive.push(i + 1) }
  chars.push(n)
  if (plain(s.notes)) withNotes++
})
// ---- density per slide: how much there is, and how much structure it needs
// boxes = filled shapes holding a text (cards, panels, badges), not drawings;
// coverage = share of the slide some non-backdrop element covers (a 64×36
// grid sample); font sizes and left edges = levels of hierarchy and the
// alignment lines a reader has to follow.
const { width: W = 1280, height: H = 720 } = doc.size ?? {}
const DENSE = { textEls: 8, boxes: 6, fontSizes: 4, leftEdges: 5, coverage: 0.55 }
const isBackdrop = (e) => e.w * e.h >= 0.5 * W * H
const filled = (e) => e.type === 'shape' && e.shape !== 'line' && e.shape !== 'path' && e.fill && !/^(none|transparent)$/i.test(e.fill) && !/rgba\([^)]*,\s*0\)/.test(e.fill)
out.density = shown.map((s, i) => {
  const els = (s.elements ?? []).filter((e) => !e.hidden && !isBackdrop(e))
  const texts = els.filter((e) => e.type === 'text' && plain(e.html))
  const grid = new Uint8Array(64 * 36)
  for (const e of els) {
    if (e.type === 'shape' && (e.shape === 'line' || e.shape === 'path')) continue
    const x0 = Math.max(0, Math.floor((e.x / W) * 64)), x1 = Math.min(64, Math.ceil(((e.x + e.w) / W) * 64))
    const y0 = Math.max(0, Math.floor((e.y / H) * 36)), y1 = Math.min(36, Math.ceil(((e.y + e.h) / H) * 36))
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) grid[y * 64 + x] = 1
  }
  return {
    slide: i + 1,
    textEls: texts.length,
    boxes: els.filter((e) => filled(e) && texts.some((t) => t.x + t.w / 2 > e.x && t.x + t.w / 2 < e.x + e.w && t.y + t.h / 2 > e.y && t.y + t.h / 2 < e.y + e.h)).length,
    fontSizes: new Set(texts.map((e) => Math.round(e.fontSize ?? 0))).size,
    leftEdges: new Set(texts.map((e) => Math.round(e.x / 8))).size,
    coverage: +(grid.reduce((a, b) => a + b, 0) / grid.length).toFixed(2),
    // readable from the back of a room: under 18px on a 720px-high slide is not
    tiny: texts.filter((e) => (e.fontSize ?? 24) * (720 / H) < 18).length,
    heroNumbers: texts.filter((e) => (e.fontSize ?? 0) * (720 / H) >= 96 && /^[\s\d.,%×x+−-]+[%a-zµ]*$/i.test(plain(e.html))).length,
    countUps: els.filter((e) => e.fx?.countUp).length,
    // share of the slide left empty between the lowest content and the
    // footer zone (bottom 10%): content crammed into the top
    emptyBelow: (() => {
      // source lines, captions and rules sit low on purpose; they are not the content
      const body = els.filter((e) => e.y < 0.9 * H && e.y > 0.18 * H && e.h > 0.02 * H
        && !(e.type === 'text' && (e.fontSize ?? 24) * (720 / H) <= 20))
      if (!body.length) return 0
      return +Math.max(0, (0.9 * H - Math.max(...body.map((e) => e.y + e.h))) / H).toFixed(2)
    })(),
  }
})
out.dense = Object.fromEntries(Object.entries(DENSE).map(([k, lim]) => [k, out.density.filter((d) => d[k] > lim).map((d) => d.slide)]))

out.typefaces = [...faces]
out.offPalette = [...off].sort((a, b) => b[1] - a[1]).map(([color, uses]) => ({ color, uses }))
out.effects = effects
out.motion = motion
out.text = {
  avg: chars.length ? Math.round(chars.reduce((a, b) => a + b, 0) / chars.length) : 0,
  max: Math.max(0, ...chars),
  perSlide: chars,
}
out.notesShare = shown.length ? +(withNotes / shown.length).toFixed(2) : 0

// ---- against the profile
if (profile) {
  const against = out.againstProfile
  if (profile.motion === 'none' && motion.subtleSlides + motion.expressiveSlides) against.push(`motion none, but ${motion.subtleSlides + motion.expressiveSlides} slides animate`)
  if (profile.motion === 'subtle' && motion.expressiveSlides) against.push(`motion subtle, but expressive motion on slides ${motion.expressive.join(', ')}`)
  if (profile.decoration === 'plain' && effects.libraryArt) against.push(`decoration plain, but ${effects.libraryArt} library icons/artwork`)
  const budget = TEXT_BUDGET[profile.balance]
  if (budget) {
    const over = chars.map((c, i) => (c > budget ? i + 1 : 0)).filter(Boolean)
    if (over.length) against.push(`typical slide ${profile.balance} (≈ ${budget} characters), but slides ${over.join(', ')} carry more`)
  }
  if (profile.purpose && profile.purpose !== 'pitch') {
    const heroes = out.density.reduce((a, d) => a + d.heroNumbers, 0)
    if (heroes > 1) against.push(`${profile.purpose}: ${heroes} hero-size numbers (at most one, for the main result)`)
    const counts = out.density.reduce((a, d) => a + d.countUps, 0)
    if (counts) against.push(`${profile.purpose}: ${counts} count-ups (pitch only)`)
    const tiny = out.density.reduce((a, d) => a + d.tiny, 0)
    if (tiny) against.push(`${profile.purpose}: ${tiny} text blocks under 18px`)
  }
  const lim = profile.limits ?? {}
  if (lim.maxRadius !== undefined && effects.maxRadius > lim.maxRadius) against.push(`maxRadius ${lim.maxRadius}, but a radius of ${effects.maxRadius}`)
  if (lim.shadows === false && effects.shadows) against.push(`no shadows, but ${effects.shadows}`)
  if (lim.gradients === false && effects.gradients) against.push(`no gradients, but ${effects.gradients}`)
}

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0) }

const line = (k, v) => console.log(`  ${k.padEnd(16)} ${v}`)
console.log(`${file}`)
line('slides', `${out.shown} shown of ${out.slides}`)
line('slide types', `${out.slideTypes} used, ${Math.round(out.linkedShare * 100)}% of slides linked`)
line('longest run', out.longestRun ? `${out.longestRun.length} × ${out.longestRun.type} (from slide ${out.longestRun.from})` : '—')
line('runs over 3', out.runsOver3.length ? out.runsOver3.map((r) => `${r.length} × ${r.type} @${r.from}`).join('; ') : 'none')
line('title frames', out.titleFrames.length ? out.titleFrames.map((t) => `${t.type}: ${t.distinct}`).join('; ') : 'no role:title elements')
line('typefaces', `${out.typefaces.length} (${out.typefaces.join(', ')})`)
line('off-palette', out.offPalette.length ? `${out.offPalette.length} colours: ${out.offPalette.slice(0, 8).map((c) => `${c.color}×${c.uses}`).join(' ')}` : 'none')
line('effects', `max radius ${effects.maxRadius}, ${effects.shadows} shadows, ${effects.gradients} gradients, ${effects.blur} blurs, ${effects.libraryArt} library art`)
line('motion', `${motion.calmSlides} calm, ${motion.subtleSlides} subtle, ${motion.expressiveSlides} expressive slides`)
line('text/slide', `avg ${out.text.avg}, max ${out.text.max} characters`)
line('notes', `${Math.round(out.notesShare * 100)}% of slides`)
const avg = (k) => (out.density.length ? (out.density.reduce((a, d) => a + d[k], 0) / out.density.length).toFixed(k === 'coverage' ? 2 : 1) : 0)
const maxOf = (k) => Math.max(0, ...out.density.map((d) => d[k]))
line('density avg/max', Object.keys(DENSE).map((k) => `${k} ${avg(k)}/${maxOf(k)}`).join(', '))
const dense = Object.entries(out.dense).filter(([, s]) => s.length)
const where = (k) => out.density.filter((d) => d[k]).map((d) => `${d.slide}${d[k] > 1 ? `×${d[k]}` : ''}`).join(',') || 'none'
line('tiny text', `${out.density.reduce((a, d) => a + d.tiny, 0)} blocks under 18px, on slides ${where('tiny')}`)
line('hero numbers', `${where('heroNumbers')}; count-ups ${where('countUps')}`)
const topHeavy = out.density.filter((d) => d.emptyBelow > 0.25).map((d) => `${d.slide} (${Math.round(d.emptyBelow * 100)}%)`)
line('top-heavy', topHeavy.length ? `empty below the content on ${topHeavy.join(', ')}` : 'none')
line('over density', dense.length ? dense.map(([k, s]) => `${k} > ${DENSE[k]} on ${s.join(',')}`).join('; ') : 'none')
if (profile) line('vs profile', out.againstProfile.length ? '\n    - ' + out.againstProfile.join('\n    - ') : 'nothing against it')
