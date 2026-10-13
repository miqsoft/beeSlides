// ARCHIVAL — the retired Flamingo S brand (2026-09-24 → 2026-09-28). NOT imported by anything; see README.md here to restore it.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The BeeSlides mark — the "Flamingo S" (docs/DECISIONS.md, 2026-09-24): the
// letter S drawn as a flamingo, thin neck swelling into a body with a wing and
// a raised tail, head with a downturned black-tipped beak, on a night tile.
//
// SINGLE SOURCE. The editor imports logoSvg()/WORDMARK_HTML; the static copies
// that paint before any JS runs (index.html favicon + splash, the README asset)
// are GENERATED from this file by scripts/build-brand-assets.mjs — edit here,
// then rerun that script, never the copies. desktop/build/icon.png is a 1024px
// render of logoSvg() (see that script's header for how to re-export it).

export const BRAND = {
  night: '#1D1119',      // tile, ink on light
  aubergine: '#4A2242',  // tile glow
  blush: '#FFB3C4',      // neck highlight
  flamingo: '#FF7098',   // primary; "mingo" on dark
  deep: '#EC4679',       // body shade
  wing: '#D8336A',
  mingoOnLight: '#E23D72', // "mingo" on light grounds (flamingo is too pale there)
  cream: '#FFF0EA',      // "Slido" on dark
} as const

// 32×32 grid. BODY is the variable-width S (neck → body → tail), generated
// once from a centreline with a width profile. The splash reveals BODY by
// drawing that centreline as a mask, tail first — REVEAL is it split into its
// three segments (body, lower neck, upper neck), each reversed to run tail →
// head and each as wide as the shape it uncovers: one wide stroke for the
// whole S uncovered the neck before the pen got there.
const BODY = 'M20.6 10.17Q19.15 10.11 19.12 9.93Q19.1 9.74 19 9.58Q18.9 9.41 18.7 9.24Q18.5 9.07 18.22 8.92Q17.94 8.78 17.6 8.67Q17.27 8.56 16.91 8.5Q16.55 8.44 16.18 8.42Q15.81 8.4 15.43 8.43Q15.05 8.46 14.7 8.53Q14.34 8.6 14.02 8.72Q13.7 8.84 13.44 9Q13.18 9.15 12.99 9.34Q12.79 9.53 12.67 9.74Q12.56 9.95 12.51 10.2Q12.45 10.45 12.47 10.64Q12.48 10.83 12.58 11Q12.68 11.17 12.89 11.37Q13.1 11.57 13.41 11.78Q13.71 11.99 14.07 12.19Q14.44 12.39 14.82 12.57Q15.21 12.76 15.63 12.94Q16.06 13.12 16.5 13.28Q16.95 13.43 17.41 13.58Q17.88 13.72 18.35 13.86Q18.81 14 19.33 14.18Q19.84 14.35 20.37 14.57Q20.89 14.79 21.45 15.12Q22.02 15.45 22.56 15.9Q23.1 16.35 23.58 17Q24.06 17.65 24.38 18.5Q24.69 19.34 24.76 20.22Q24.83 21.1 24.63 22.03Q24.42 22.95 23.98 23.77Q23.54 24.58 22.94 25.21Q22.35 25.84 21.7 26.27Q21.06 26.71 20.39 27.01Q19.71 27.31 19.03 27.45Q18.34 27.59 17.7 27.59Q17.05 27.59 16.39 27.48Q15.72 27.37 15.13 27.16Q14.54 26.95 13.99 26.67Q13.43 26.39 12.94 26.06Q12.45 25.73 11.99 25.36Q11.54 24.99 11.15 24.6Q10.76 24.22 10.39 23.83Q10.03 23.44 9.71 23.06Q9.38 22.69 9.06 22.32Q8.74 21.95 8.43 21.62Q8.12 21.29 8.2 21.2Q8.28 21.11 8.62 21.4Q8.96 21.69 9.35 21.94Q9.74 22.18 10.15 22.36Q10.55 22.54 10.99 22.66Q11.42 22.79 11.85 22.86Q12.29 22.93 12.73 22.95Q13.17 22.97 13.59 22.95Q14.01 22.92 14.43 22.86Q14.84 22.79 15.23 22.7Q15.61 22.6 15.99 22.47Q16.37 22.35 16.69 22.21Q17.01 22.07 17.32 21.92Q17.62 21.77 17.89 21.62Q18.16 21.46 18.38 21.31Q18.61 21.16 18.78 21Q18.95 20.84 19.07 20.68Q19.19 20.53 19.27 20.37Q19.35 20.21 19.39 20.02Q19.43 19.83 19.44 19.66Q19.44 19.49 19.37 19.25Q19.29 19.01 19.14 18.76Q18.98 18.5 18.74 18.24Q18.5 17.97 18.21 17.72Q17.92 17.47 17.57 17.23Q17.22 16.99 16.86 16.78Q16.51 16.58 16.1 16.37Q15.7 16.17 15.28 15.98Q14.86 15.79 14.42 15.59Q13.98 15.39 13.55 15.18Q13.11 14.97 12.66 14.72Q12.21 14.47 11.75 14.16Q11.3 13.84 10.85 13.41Q10.41 12.98 10.06 12.32Q9.71 11.66 9.63 10.95Q9.56 10.23 9.7 9.58Q9.84 8.93 10.18 8.33Q10.51 7.74 10.98 7.28Q11.45 6.82 11.96 6.52Q12.47 6.22 13.02 6.01Q13.57 5.81 14.12 5.69Q14.67 5.58 15.23 5.54Q15.79 5.5 16.33 5.53Q16.87 5.55 17.42 5.65Q17.96 5.75 18.51 5.92Q19.05 6.1 19.59 6.38Q20.13 6.67 20.62 7.11Q21.12 7.55 21.48 8.17Q21.84 8.79 21.94 9.51Q22.05 10.23 20.6 10.17Z'
const REVEAL: [d: string, width: number][] = [
  ['M8.2 21.2C13.6 26.6 22.4 24.2 21.4 19.2', 9.6],
  ['M21.4 19.2C20.2 14.6 11 14.4 11 10.6', 6.4],
  ['M11 10.6C11 5.6 20.8 6 20.6 10.2', 4.4],
]
// The wing stands proud of the body's back line (that overhang IS the raised
// back); its lower edge dips into the body near the tail so no sliver of tile
// shows between the two.
const WING = 'M20.3 18.2C21.5 21.6 18.2 23.5 14.4 23.3C12.2 23.5 9.6 22.5 8.4 21.4C11.4 21.7 13.8 21.2 15.8 20.2C17.8 19.2 19.1 18.3 20.3 18.2Z'
const BEAK = 'M20.4 7.3C22.6 6.8 24.9 7.6 25.6 9.3C26.1 10.6 25.8 12 25.2 13.2Q24.9 13.7 24.6 13.3C24.5 12.2 24.1 11.2 23.3 10.7C22.6 10.3 21.7 10.6 20.8 11.2Z'
const BEAK_TIP = 'M23.5 11.3L25.9 10.1L27 15L23 15Z' // clipped to BEAK: the downturned half is black

/** The tile's outer stop (its glow centre is BRAND.aubergine). */
export const TILE_EDGE = '#190F17'
/** Tile corner radius as a fraction of its side (rx 7 on the 32 grid). */
export const TILE_RADIUS = 7 / 32

let seq = 0

export interface LogoOptions {
  /** id prefix for the gradients/clip/mask — must be unique per document. Auto if omitted. */
  id?: string
  className?: string
  /** Splash build: BODY sits under a mask of REVEAL strokes (classes sm-r1..3,
   *  pathLength 1) and the head is group .sm-head with the eye in .sm-eye, so
   *  CSS can paint the S tail → head, swing the head in, then blink. */
  animated?: boolean
  /** false = the flamingo alone, no night tile — for placing it on a tile
   *  that is itself a document shape (the Showcase deck's morphing T_D). */
  tile?: boolean
}

/** The mark as an SVG string, `size` px square. */
export function logoSvg(size: number, opts: LogoOptions = {}): string {
  const id = opts.id ?? `sm${++seq}`
  const cls = opts.className ? ` class="${opts.className}"` : ''
  const tile = opts.tile !== false
  const defs =
    `<linearGradient id="${id}p" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="26">` +
    `<stop offset="0" stop-color="${BRAND.blush}"/><stop offset=".5" stop-color="${BRAND.flamingo}"/><stop offset="1" stop-color="${BRAND.deep}"/></linearGradient>` +
    (tile ? `<radialGradient id="${id}t" cx=".72" cy=".18" r="1.05"><stop offset="0" stop-color="${BRAND.aubergine}"/><stop offset="1" stop-color="${TILE_EDGE}"/></radialGradient>` : '') +
    `<clipPath id="${id}b"><path d="${BEAK}"/></clipPath>` +
    (opts.animated
      ? `<mask id="${id}m">` +
        REVEAL.map(([d, w], i) =>
          `<path class="sm-r${i + 1}" pathLength="1" d="${d}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round"/>`).join('') +
        `</mask>`
      : '')
  const body = `<path d="${BODY}" fill="url(#${id}p)"/><path d="${WING}" fill="${BRAND.wing}"/>`
  const head =
    `<path d="${BEAK}" fill="#FFE6EB"/><path d="${BEAK_TIP}" fill="#170C13" clip-path="url(#${id}b)"/>` +
    `<circle cx="20.3" cy="9.3" r="2.45" fill="url(#${id}p)"/>` +
    `<g class="sm-eye"><circle cx="20.1" cy="8.55" r=".62" fill="#FFD27A"/><circle cx="20.25" cy="8.55" r=".3" fill="#170C13"/></g>`
  return (
    `<svg${cls} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">` +
    `<defs>${defs}</defs>` + (tile ? `<rect width="32" height="32" rx="7" fill="url(#${id}t)"/>` : '') +
    (opts.animated ? `<g mask="url(#${id}m)">${body}</g><g class="sm-head">${head}</g>` : body + head) +
    `</svg>`
  )
}

/** "BeeSlides", accent on "mingo" (never on "Slido" — that's Cisco's product).
 *  Colour comes from .sm-mingo in styles.css so it follows the chrome theme. */
export const WORDMARK_HTML = 'Slido<span class="sm-mingo">mingo</span>'
