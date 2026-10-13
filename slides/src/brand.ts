// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The BeeSlides mark — the "Needle Bee" (docs/DECISIONS.md, 2026-09-28): a
// chibi bee whose stinger is the stylus of a record player, playing a black
// record with a rainbow shine (the colours light splits into on real grooves)
// and a honeycomb-hex label, on a night tile. Chosen as "full plate, bigger
// bee": the record fills the tile, the bee reaches in from the top right like
// a tonearm, and its needle sits on the groove next to the label.
//
// SINGLE SOURCE. The editor imports logoSvg()/spinnerSvg()/WORDMARK_HTML; the
// static copies that paint before any JS runs (index.html favicon + splash,
// the README asset) are GENERATED from this file by
// scripts/build-brand-assets.mjs, desktop/build/icon.png by
// scripts/export-app-icon.mjs, and the shareable kit in docs/assets/brand/
// (logo PNGs, lockups, the intro as MP4/GIF) by scripts/export-brand-kit.mjs —
// edit here, then rerun those scripts, never the copies. The Flamingo S this replaced is archived in
// docs/assets/archive/flamingo-s/.

export const BRAND = {
  night: '#17120A',      // tile, ink on light, text on honey
  glow: '#3A2A0C',       // tile glow, top right
  honey: '#FFC233',      // primary: bee, hex label; "Bee" on dark
  amber: '#F5A300',      // honey gradient foot
  deep: '#D97F00',       // record rim
  stripe: '#1A1408',     // bee stripes, eyes
  wing: '#FFF6E0',       // wings (drawn at 90% opacity)
  vinyl: '#0D0B08',      // the record
  cream: '#FFF6E0',      // tonearm; "Slides" on dark
  honeyOnLight: '#9A5F00', // "Bee" and accent text on light (5.2:1 on white; honey is 1.6:1)
} as const

/** The rainbow shine, outer band first. */
export const RAINBOW = ['#FF4D6D', '#FF9F1C', '#FFE14D', '#4CD97B', '#3FA9F5', '#8E6CFF'] as const

/** The tile's outer stop (its glow centre is BRAND.glow). */
export const TILE_EDGE = '#100C06'

const r2 = (n: number) => Math.round(n * 100) / 100
const rad = (deg: number) => (deg * Math.PI) / 180

// ── Geometry (32×32 grid) ──────────────────────────────────────────────────
// The record fills the tile: centre (16,16), radius 15 — inside the rx-7
// corners, so nothing is clipped. The bee's thorax (its pivot, like a
// tonearm's) sits at PIVOT; the stylus lands on the STYLUS_RING groove at
// STYLUS_DEG. The bee's tilt and arm length follow from those.
const CX = 16, CY = 16, R = 15
const GROOVES = [12.6, 10.4, 7.6, 5.2]
const LABEL = 3.3
const PIVOT = [24.4, 7.4] as const
const BEE_SCALE = 0.8
const STYLUS_RING = 5.2, STYLUS_DEG = -52
/** Where the needle touches the record — the splash's sound rings start here. */
export const STYLUS = [r2(CX + STYLUS_RING * Math.cos(rad(STYLUS_DEG))), r2(CY + STYLUS_RING * Math.sin(rad(STYLUS_DEG)))] as const

// In bee-local coordinates (upright, head up, thorax at the origin) the tip of
// the stinger is at y = 6.2, and the arm starts at the belly (y = 5.2).
const TIP = 6.2
function aim(scale: number) {
  const dx = STYLUS[0] - PIVOT[0], dy = STYLUS[1] - PIVOT[1]
  return { rot: r2((Math.atan2(-dx, dy) * 180) / Math.PI), len: r2(Math.hypot(dx, dy) / scale - TIP) }
}

// ── The chibi bee ──────────────────────────────────────────────────────────
// A big round head with eyes, rosy cheeks and a smile, a round body with two
// curved bands, two round wings behind. `small` (≤ 24px) drops the face
// detail and antennae, which would only blur there.
function bee(id: string, small: boolean, animated: boolean): string {
  const band = (y: number, h: number) =>
    `M-4.5 ${y}Q0 ${r2(y + 0.8)} 4.5 ${y}V${r2(y + h)}Q0 ${r2(y + h + 0.8)}-4.5 ${r2(y + h)}Z`
  const wings =
    `<g fill="${BRAND.wing}" opacity=".9">` +
    `<ellipse cx="-3.4" cy="-.6" rx="2" ry="1.6" transform="rotate(-25 -3.4 -.6)"/>` +
    `<ellipse cx="3.4" cy="-.6" rx="2" ry="1.6" transform="rotate(25 3.4 -.6)"/></g>`
  const face = small
    ? `<circle cx="-.95" cy="-3.3" r=".6" fill="${BRAND.stripe}"/><circle cx=".95" cy="-3.3" r=".6" fill="${BRAND.stripe}"/>`
    : `<ellipse cx="-1" cy="-3.4" rx=".5" ry=".65" fill="${BRAND.stripe}"/><ellipse cx="1" cy="-3.4" rx=".5" ry=".65" fill="${BRAND.stripe}"/>` +
      `<circle cx="-.84" cy="-3.62" r=".18" fill="#FFFFFF"/><circle cx="1.16" cy="-3.62" r=".18" fill="#FFFFFF"/>` +
      `<ellipse cx="-1.85" cy="-2.55" rx=".6" ry=".38" fill="#FF7E8E" fill-opacity=".85"/><ellipse cx="1.85" cy="-2.55" rx=".6" ry=".38" fill="#FF7E8E" fill-opacity=".85"/>` +
      `<path d="M-.55-2.45Q0-1.95.55-2.45" stroke="${BRAND.stripe}" stroke-width=".3" stroke-linecap="round" fill="none"/>`
  const antennae = small ? '' :
    `<path d="M-.9-5.6Q-1.3-6.9-2-7.1M.9-5.6Q1.3-6.9 2-7.1" stroke="${BRAND.honey}" stroke-width=".4" stroke-linecap="round" fill="none"/>` +
    `<circle cx="-2.05" cy="-7.1" r=".5" fill="${BRAND.honey}"/><circle cx="2.05" cy="-7.1" r=".5" fill="${BRAND.honey}"/>`
  return (
    (animated ? `<g class="sm-wings">${wings}</g>` : wings) +
    // a night outline behind body and head, so the bee holds on any ground
    `<g fill="${BRAND.night}" stroke="${BRAND.night}" stroke-width="${small ? 1.1 : 0.8}" stroke-linejoin="round">` +
      `<circle cx="0" cy="2.2" r="3.1"/><circle cx="0" cy="-3.2" r="2.75"/></g>` +
    `<circle cx="0" cy="2.2" r="3.1" fill="url(#${id}h)"/>` +
    `<g clip-path="url(#${id}b)" fill="${BRAND.stripe}"><path d="${band(0.4, 1.1)}"/><path d="${band(2.6, 1.1)}"/></g>` +
    antennae +
    `<circle cx="0" cy="-3.2" r="2.75" fill="url(#${id}h)"/>` + face
  )
}

// The tonearm: from the belly straight on to a honey stylus tip.
function arm(len: number, small: boolean): string {
  return (
    `<path d="M0 5.2V${r2(TIP + len)}" stroke="${BRAND.cream}" stroke-width="${small ? 1.05 : 0.72}" stroke-linecap="round"/>` +
    `<circle cx="0" cy="${r2(TIP + len)}" r="${small ? 0.8 : 0.6}" fill="${BRAND.honey}"/>`
  )
}

// ── The record ─────────────────────────────────────────────────────────────
// Rainbow shine: thin wedges on both sides of the centre, like light split on
// real grooves. It turns with the record, which is what makes a spin visible.
function rainbow(small: boolean): string {
  const r0 = Math.max(LABEL * 1.5, 3.5), r1 = R - 0.8
  const band = small ? 5.5 : 4.2 // degrees per colour
  const p = (r: number, a: number) => `${r2(CX + r * Math.cos(rad(a)))} ${r2(CY + r * Math.sin(rad(a)))}`
  let out = ''
  for (const base of [202, 22]) RAINBOW.forEach((c, i) => {
    const a0 = base + i * band, a1 = a0 + band
    out += `<path d="M${p(r0, a0)}L${p(r1, a0)}A${r1} ${r1} 0 0 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 0 0 ${p(r0, a0)}Z" fill="${c}" fill-opacity="${small ? 0.85 : 0.72}"/>`
  })
  return `<g class="sm-sheen">${out}</g>`
}

function hexPath(r: number): string {
  let d = ''
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2
    d += (i ? 'L' : 'M') + r2(CX + r * Math.cos(a)) + ' ' + r2(CY + r * Math.sin(a))
  }
  return d + 'Z'
}

function record(id: string, small: boolean, spin: boolean): string {
  const rings = small ? '' : GROOVES.map((g, i) =>
    `<circle cx="${CX}" cy="${CY}" r="${g}" fill="none" stroke="${BRAND.cream}" stroke-opacity="${i ? 0.06 : 0.08}" stroke-width=".32"/>`).join('')
  const label = small ? LABEL * 1.08 : LABEL
  return (
    `<g class="sm-disc"${spin ? ` style="transform-origin:${CX}px ${CY}px"` : ''}>` +
    `<circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#${id}v)"/>` +
    rainbow(small) +
    `<circle cx="${CX}" cy="${CY}" r="${r2(R - (small ? 0.55 : 0.3))}" fill="none" stroke="${BRAND.deep}" stroke-opacity="${small ? 0.8 : 0.6}" stroke-width="${small ? 1.1 : 0.6}"/>` +
    rings +
    `<path class="sm-label" d="${hexPath(label)}" fill="url(#${id}h)"/>` +
    `<circle cx="${CX}" cy="${CY}" r="${small ? 0.7 : 0.55}" fill="${BRAND.vinyl}"/>` +
    `</g>`
  )
}

const defsFor = (id: string, tile: boolean) =>
  `<linearGradient id="${id}h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BRAND.honey}"/><stop offset="1" stop-color="${BRAND.amber}"/></linearGradient>` +
  `<radialGradient id="${id}v" gradientUnits="userSpaceOnUse" cx="${CX}" cy="${CY}" r="${R}"><stop offset=".3" stop-color="${BRAND.vinyl}"/><stop offset="1" stop-color="#231A0E"/></radialGradient>` +
  `<clipPath id="${id}b"><circle cx="0" cy="2.2" r="3.1"/></clipPath>` +
  (tile ? `<radialGradient id="${id}t" cx=".72" cy=".18" r="1.05"><stop offset="0" stop-color="${BRAND.glow}"/><stop offset="1" stop-color="${TILE_EDGE}"/></radialGradient>` : '')

let seq = 0

export interface LogoOptions {
  /** id prefix for the gradients/clips — must be unique per document. Auto if omitted. */
  id?: string
  className?: string
  /** Splash build: groups tagged for CSS — .sm-disc (the record, turns about
   *  its centre, holding .sm-sheen and .sm-label), .sm-bee (fly-in) >
   *  .sm-arm (tonearm swing, about the pivot) > the bee with .sm-wings, and
   *  .sm-pulse (two sound-ring circles at the stylus). Transform origins are
   *  inline, so the hand-written splash CSS never needs this file's numbers;
   *  it only has to set transform-box: view-box. */
  animated?: boolean
  /** false = the record and bee alone, no night tile — for placing it on a
   *  tile that is itself a document shape. */
  tile?: boolean
}

/** The mark as an SVG string, `size` px square. */
export function logoSvg(size: number, opts: LogoOptions = {}): string {
  const id = opts.id ?? `sm${++seq}`
  const cls = opts.className ? ` class="${opts.className}"` : ''
  const tile = opts.tile !== false
  const small = size <= 24
  const animated = !!opts.animated
  const scale = BEE_SCALE * (small ? 1.06 : 1)
  const { rot, len } = aim(scale)
  const [px, py] = PIVOT
  const placed = `<g transform="translate(${px} ${py}) rotate(${rot}) scale(${r2(scale)})">${bee(id, small, animated)}${arm(len, small)}</g>`
  const origin = ` style="transform-origin:${px}px ${py}px"`
  const beeGroup = animated ? `<g class="sm-bee"${origin}><g class="sm-arm"${origin}>${placed}</g></g>` : placed
  const [sx, sy] = STYLUS
  const pulse = animated
    ? `<g class="sm-pulse" fill="none" stroke="${BRAND.honey}" stroke-width=".5">` +
      `<circle cx="${sx}" cy="${sy}" r="2.4" style="transform-origin:${sx}px ${sy}px"/>`.repeat(2) + `</g>`
    : ''
  const body = record(id, small, animated) + beeGroup + pulse
  return (
    `<svg${cls} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">` +
    `<defs>${defsFor(id, tile)}</defs>` +
    (tile ? `<rect width="32" height="32" rx="7" fill="url(#${id}t)"/>` : '') +
    body +
    `</svg>`
  )
}

/** The record alone, no tile and no bee, as a loading spinner. It turns via
 *  .sm-spinner in styles.css (the rainbow makes the turning visible; with
 *  reduced motion it pulses instead). Decorative — put the status in text. */
export function spinnerSvg(size: number, className = ''): string {
  const id = `sp${++seq}`
  return (
    `<svg class="sm-spinner${className ? ' ' + className : ''}" xmlns="http://www.w3.org/2000/svg" viewBox="1 1 30 30" width="${size}" height="${size}" aria-hidden="true">` +
    `<defs>${defsFor(id, false)}</defs>${record(id, size <= 24, true)}</svg>`
  )
}

/** Show a loading state in `el`: the record spinner, then `text` (set as
 *  text, never HTML). The next textContent/innerHTML write replaces both. */
export function showLoading(el: Element, text: string, size = 16): void {
  el.innerHTML = `<span class="sm-loading">${spinnerSvg(size)}<span></span></span>`
  el.querySelector('.sm-loading > span')!.textContent = text
}

/** "BeeSlides", accent on "Bee". Colour comes from .sm-wm in styles.css so it
 *  follows the chrome theme. */
export const WORDMARK_HTML = '<span class="sm-wm">Bee</span>Slides'
