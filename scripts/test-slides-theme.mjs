#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Theme token gate for beeslides/slides.
//
//   node scripts/test-slides-theme.mjs
//
// WHAT THIS PROVES. A theme is only as good as the rules nobody can quietly
// break, and every failure mode here is INVISIBLE in the light theme — which is
// the one the author is looking at.
//
//   1. A chrome surface hard-coded to white keeps its light background in dark
//      and turns light text onto it. Measured before this gate existed: the
//      properties panel's selects and inputs sat at 1.21:1 against WCAG AA's
//      4.5 floor. They LOOKED perfect in light.
//   2. A document token pulled into a themed block would invert the deck. A
//      slide's background is the author's data, and someone proofing at
//      midnight still needs to see what will be projected.
//   3. The light palette drifting from the other apps. slides, spaces and type
//      share one palette character for character; a fork shows up as two
//      BeeSlides windows side by side in slightly different greys.
//
// DELIBERATE EXCEPTIONS, listed rather than silently tolerated — each is a
// surface that must NOT follow the chrome theme.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'slides/src/styles.css'), 'utf8')

let failures = 0
let checks = 0
const ok = (cond, msg) => {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const block = (selector) => {
  const i = css.indexOf(selector)
  if (i < 0) return null
  const open = css.indexOf('{', i)
  return css.slice(open + 1, css.indexOf('}', open))
}
const rolesIn = (body) => new Set([...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gmi)].map((m) => m[1]))

// ---- 1. both themes define the same roles ---------------------------------
const light = block(':root, :root[data-theme="light"]')
const dark = block(':root[data-theme="dark"]')
ok(!!light && !!dark, 'both a light and a dark token block exist')
if (light && dark) {
  const L = rolesIn(light), D = rolesIn(dark)
  const missing = [...L].filter((r) => !D.has(r))
  const extra = [...D].filter((r) => !L.has(r))
  ok(missing.length === 0, `dark defines every role light does${missing.length ? ` — missing ${missing.join(', ')}` : ''}`)
  ok(extra.length === 0, `dark invents no role light lacks${extra.length ? ` — extra ${extra.join(', ')}` : ''}`)
}

// ---- 2. the DOCUMENT does not invert --------------------------------------
// A themed block may not define anything that renders document content. The
// deck is the author's; only the chrome around it follows the reader.
const DOCUMENT_TOKENS = /--(slide-bg|paper|slidomingo-|r-)/
for (const [name, body] of [['light', light], ['dark', dark]]) {
  if (!body) continue
  const doc = [...rolesIn(body)].filter((r) => DOCUMENT_TOKENS.test(r))
  ok(doc.length === 0, `the ${name} block themes no document token${doc.length ? ` — ${doc.join(', ')}` : ''}`)
}

// ---- 3. no chrome surface is hard-coded white -----------------------------
// The 1.21:1 bug. A surface pinned to #fff stays light while its text follows
// the theme. Exceptions are surfaces that are deliberately NOT chrome:
//
//   .beeslides-speaker*  the presenter window is always dark — you present in a
//                    darkened room, and it should not brighten at dawn
//   .beeslides-splash    boot brand art, the starter deck's own palette
//   #beeslides-print     paper is white because paper is white
//   .slidomingo-          anything rendering document content
//   .ed-comment-hl   a comment pin sits ON the slide, over document content
//                    the author chose — a white dot ringed in accent has to
//                    read against a dark deck AND a light one, so it follows
//                    neither theme
//   .ed-pwcard       the password gate is a full-screen dark card in both
//                    themes, like the splash; its input is translucent white
//                    ON that card, not a chrome surface
//   .ed-sp-thumb.is-blank
//                    the start page's Blank / New figure thumbnails are a
//                    PICTURE of the page the click creates (newDoc paints
//                    #FFFFFF), like the rendered template thumbnails beside
//                    them; a dark tile in the dark theme would promise a
//                    dark deck that never appears. Its icon colour is pinned
//                    with it (styles.css), so nothing on it follows the theme.
//   .ed-sp-col.is-figure .ed-sp-thumb
//                    the figure-size thumbnails beside them, same reason.
//   .ed-color-trigger-swatch
//                    a colour chip's transparency checkerboard (white + grey
//                    squares under the colour) — a picture of "transparent",
//                    the same in both themes like every paint program's.
//
// Only an OPAQUE white SURFACE counts: translucent white (`rgb(255 255 255 /
// 0.06)` lifting a button on an always-dark card) and white stops inside a
// gradient (a hatch, a glint) are tints over whatever is beneath, not a
// surface the text sits on.
const EXEMPT = /^(\.beeslides-speaker|\.sv-|\.beeslides-splash|#beeslides-print|\.slidomingo-|\.ed-comment-hl|\.ed-pwcard|\.ed-sp-thumb\.is-blank|\.ed-sp-col\.is-figure \.ed-sp-thumb|\.ed-color-trigger-swatch|@|:root|\*)/
const rules = [...css.matchAll(/(^|\n)([^@{}\n][^{}]*)\{([^}]*)\}/g)]
const whiteSurfaces = []
for (const [, , sel, body] of rules) {
  const opaqueWhite = body.split(';').some((decl) => {
    const m = decl.match(/^\s*background(?:-color)?\s*:\s*(.+)$/i)
    if (!m || /var\(/.test(m[1])) return false
    const v = m[1].replace(/(?:repeating-)?(?:linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))*\)/gi, '')
    return /#fff\b|#ffffff\b|rgba?\(\s*255[ ,]+255[ ,]+255\s*(?:[,/]\s*(?:1|1\.0+|100%)\s*)?\)/i.test(v)
  })
  if (!opaqueWhite) continue
  // strip any comment sitting above the rule, or the failure names the
  // comment instead of the selector and sends the reader to the wrong place
  const s = sel.replace(/\/\*[\s\S]*?\*\//g, '').trim().split(',')[0].trim()
  if (EXEMPT.test(s)) continue
  whiteSurfaces.push(s)
}
ok(whiteSurfaces.length === 0,
  `no chrome surface is pinned to white${whiteSurfaces.length ? `\n        ${whiteSurfaces.join('\n        ')}` : ''}`)

// ---- 4. every themed role is actually WIRED UP ----------------------------
// A token defined in both blocks and referenced nowhere is not harmless: it is
// a wire that was never connected, and the literal it was meant to replace is
// still sitting in the stylesheet painting a light value in dark. That is
// exactly how the canvas dot grid kept glaring after `--grid-dot` was added —
// defined twice, used never, `#d5dbe4` still in the gradient.
{
  const unused = [...rolesIn(light ?? '')].filter((r) => !new RegExp(`var\\(${r}[,)]`).test(css))
  ok(unused.length === 0,
    `every themed role is referenced by a rule${unused.length ? ` — defined but unused: ${unused.join(', ')}` : ''}`)
}

// ---- 4b. a themed background never carries a literal foreground -----------
// The pairing that breaks on a theme flip. `.ed-btn-primary` was
// `background: var(--ink); color: #fff` — correct in light, and in dark the
// background followed --ink to a light value while the text stayed white:
// measured 1.21:1, unreadable, on six buttons across the app. It survived
// review because the About dialog has its own override, so the one instance
// anybody looked at was fine.
//
// Only tokens that ACTUALLY INVERT are an offence. `--accent` is the same
// peach in both themes, so a literal foreground on it is stable and allowed —
// flagging those would train people to ignore this check.
{
  const valuesIn = (body) => Object.fromEntries(
    [...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gmi)].map((m) => [m[1], m[2].trim().toLowerCase()]))
  const L = valuesIn(light ?? ''), D = valuesIn(dark ?? '')
  const inverts = (tok) => L[tok] && D[tok] && L[tok] !== D[tok]

  const offenders = []
  for (const [, , sel, body] of rules) {
    const bg = body.match(/background(?:-color)?\s*:\s*var\((--[a-z0-9-]+)/i)
    if (!bg || !inverts(bg[1])) continue
    // A literal colour, i.e. one that is not itself a token. Tested on the
    // CAPTURED value rather than with a lookahead: `\s*(?!var\()` backtracks —
    // it gives back a space and then happily matches ` var(--ink)`, which had
    // this check reporting three false positives on its first run.
    const fg = body.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)
    // `inherit` / `currentColor` follow the parent's (themed) colour
    if (!fg || /^(var\(|inherit\b|currentcolor\b|transparent\b)/i.test(fg[1].trim())) continue
    const s2 = sel.replace(/\/\*[\s\S]*?\*\//g, '').trim().split(',')[0].trim()
    if (EXEMPT.test(s2)) continue
    offenders.push(`${s2} — background ${bg[1]} inverts, but color is ${fg[1].trim()}`)
  }
  ok(offenders.length === 0,
    `no rule pairs an inverting background token with a literal text colour${offenders.length ? `\n        ${offenders.join('\n        ')}` : ''}`)
}

// ---- 5. the light palette still follows the brand -----------------------
// The honey palette (docs/DECISIONS.md, 2026-09-28): chrome greys tinted
// warm toward the logo's night, BRAND.honey as accent (brand.ts). This pin
// held the Flamingo palette before that, and the old upstream suite's amber
// before that.
const SHARED = { '--ink': '#17120a', '--ink-2': '#3d3222', '--chrome': '#faf7f1',
  '--chrome-2': '#f3eee4', '--line': '#eae3d6', '--muted': '#726651',
  '--accent': '#ffc233', '--accent-ink': '#17120a', '--accent-text': '#8f5700', '--blue': '#5b8def' }
const wrong = []
for (const [k, v] of Object.entries(SHARED)) {
  const m = light?.match(new RegExp(`${k}\\s*:\\s*([^;]+);`, 'i'))
  if (!m || m[1].trim().toLowerCase() !== v) wrong.push(`${k} is ${m ? m[1].trim() : 'missing'}, the brand says ${v}`)
}
ok(wrong.length === 0, `the light theme still matches the honey palette${wrong.length ? `\n        ${wrong.join('\n        ')}` : ''}`)

// ---- 6. the theme never reaches a saved file ------------------------------
// startTheme() writes data-theme + color-scheme onto <html>. capturePristine()
// clones the LIVE document and saves re-serialize that clone, so the call must
// come AFTER it or a reader's preference ships inside every file they save —
// the same ordering applyDirection() already depends on.
const main = readFileSync(join(root, 'slides/src/main.ts'), 'utf8')
ok(main.indexOf('startTheme()') > main.indexOf('capturePristine()'),
  'startTheme() runs after capturePristine(), so no theme reaches a saved file')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
