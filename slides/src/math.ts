// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// LaTeX → MathML through Temml. One module for both ways math reaches a slide:
//
//   * `$…$` / `$$…$$` inside text and table cells — render.ts `resolveMath`
//     splices `renderMath` output into SANITIZED html, so the source arrives
//     entity-escaped and is decoded first;
//   * the `math` element (model.ts `MathElement`) — its `tex` is raw LaTeX,
//     never escaped, and goes through `renderTex` untouched.
//
// MathML, not HTML+CSS, is what makes this affordable. Temml emits MathML and
// the browser lays it out with its own math fonts; KaTeX would have to ship a
// layout engine AND ~20 webfont faces (measured: +421KB against Temml's +64KB).
// Temml runs with trust off, so \href, \url, \html… are refused outright.
//
// Works without a DOM (node rigs, validate.ts): the entity decoder is pure,
// and symbol tagging — a present-mode morph aid — is skipped when there is no
// `document` to parse with.

import temml from 'temml'

const mathCache = new Map<string, string>()

/** Cap on cached renders: a deck has a few hundred formulas at most, and a
 *  live editor preview types one keystroke at a time into this cache. */
const CACHE_MAX = 2000

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Undo the entity escaping sanitizeHtml applied, so `x &lt; y` reaches TeX as
 *  `x < y`. Pure — the serializer only ever writes these few entities. */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
    }
    return NAMED[e.toLowerCase()] ?? m
  })
}

/**
 * Tag each MathML token with a key that identifies "the same symbol" across
 * two slides, so present.ts can morph a formula symbol by symbol instead of
 * crossfading it — a term crossing the equals sign visibly travels there.
 *
 * The key is the token's own text plus its occurrence index (`x#0`, `x#1`),
 * which is what makes rearrangement work: the second `x` in one formula pairs
 * with the second `x` in the next, wherever each has moved to. Purely a
 * RENDER-time attribute — nothing about it enters the document.
 */
function tagSymbols(mathml: string): string {
  if (typeof document === 'undefined') return mathml
  const tpl = document.createElement('template')
  tpl.innerHTML = mathml
  const seen = new Map<string, number>()
  for (const leaf of Array.from(tpl.content.querySelectorAll('mi, mn, mo'))) {
    const txt = (leaf.textContent ?? '').trim()
    if (!txt) continue
    const n = seen.get(txt) ?? 0
    seen.set(txt, n + 1)
      ; (leaf as HTMLElement).dataset.sym = `${txt}#${n}`
  }
  // Scaffolding gets its own key, on a SEPARATE attribute. A fraction bar and
  // a radical are drawn by the mfrac/msqrt box itself, not by any token, so
  // they carry no data-sym and used to be the one part of a formula that
  // neither travelled nor faded — they were simply there from frame one while
  // everything around them animated. They must never enter the symbol morph:
  // transforming a container would move its children a second time, on top of
  // their own travel. Keyed by tag occurrence so scaffolding that SURVIVES a
  // step (the outer fraction of a rearranged equation) is recognised and left
  // alone, while genuinely new scaffolding can be faded in.
  const struct = new Map<string, number>()
  for (const box of Array.from(tpl.content.querySelectorAll('mfrac, msqrt, mroot, menclose, mover, munder, munderover'))) {
    const tag = box.tagName.toLowerCase()
    const n = struct.get(tag) ?? 0
    struct.set(tag, n + 1)
      ; (box as HTMLElement).dataset.msx = `${tag}#${n}`
  }
  return tpl.innerHTML
}

/** Raw LaTeX → tagged MathML, or null when it is not valid TeX. Cached. */
function typeset(tex: string, display: boolean): string | null {
  const key = (display ? 'D' : 'I') + tex
  const hit = mathCache.get(key)
  if (hit !== undefined) return hit || null
  let out: string | null = null
  try {
    out = tagSymbols(
      temml.renderToString(tex, { displayMode: display, throwOnError: true, trust: false }),
    )
    // The source rides along (render-time only) so Figure export can re-typeset it as SVG paths
    out = out.replace('<math', `<math data-tex="${tex.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`)
  } catch {
    out = null
  }
  if (mathCache.size >= CACHE_MAX) mathCache.clear()
  mathCache.set(key, out ?? '')
  return out
}

/**
 * `$…$` source as it sits in sanitized html (entity-escaped) → MathML, or
 * null when it is not valid TeX — the caller then leaves the author's text
 * exactly as typed.
 */
export function renderMath(src: string, display: boolean): string | null {
  return typeset(decodeEntities(src), display)
}

/** Raw LaTeX (a `math` element's `tex`) → MathML, or null when invalid. */
export function renderTex(tex: string, display: boolean): string | null {
  return typeset(tex, display)
}

/**
 * Why `tex` does not typeset, as one line — or null when it does. Temml's
 * own wording (English, untranslatable) with its position decoration cut
 * off; the caller prefixes something localized.
 */
export function texError(tex: string): string | null {
  if (!tex.trim()) return null
  try {
    temml.renderToString(tex, { displayMode: true, throwOnError: true, trust: false })
    return null
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).replace(/^\s*ParseError:\s*/, '').trim()
    // "… at position 7: \frac{a" carries a combining-underline excerpt that
    // reads as noise outside a monospace console
    return msg.replace(/\s+at position \d+:[\s\S]*$/, '').trim() || 'invalid TeX'
  }
}
