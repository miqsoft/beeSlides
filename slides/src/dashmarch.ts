// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Pure helpers for the dash-march loop (kept DOM-light so node tests can import them).

/** First stroked geometry that is NOT marker/defs content. A line's arrowhead
 *  `<path>` precedes the `<line>` in DOM order, so a bare querySelector grabs it. */
export const dashTarget = (node: ParentNode): SVGElement | null =>
  Array.from(node.querySelectorAll<SVGElement>('path, line, polyline, rect, ellipse, polygon'))
    .find((t) => !t.closest('defs, marker')) ?? null

/** Whole dash+gap periods nearest the requested distance, sign preserved
 *  (negative = reverse direction). `parts` is the parsed dasharray. */
export const dashTravel = (d: number, parts: number[]): number => {
  const period = parts.reduce((a, b) => a + b, 0)
  if (!(period > 0)) return d
  // SVG doubles an odd-count dasharray, so one visual period is 2× then.
  const unit = parts.length % 2 ? period * 2 : period
  return (Math.sign(d) || 1) * Math.max(1, Math.round(Math.abs(d) / unit)) * unit
}
