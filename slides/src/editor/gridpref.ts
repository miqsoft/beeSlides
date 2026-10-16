// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Grid & Snap VIEWER preferences (like the safe-zone guides): kept in
// localStorage, never in the document, so toggling never dirties a file.
// Slides and figures keep separate steps — px vs mm — but share the rest.
// What the deck's layout grid and guides ARE lives in the document
// (src/layoutgrid.ts); whether they are shown and snapped to lives here.
//
// The rule the Grid & Snap panel teaches: grid, column lines and guides snap
// only while shown (and their Snap box is ticked); the template's borders
// (margins), objects and the slide's edges/center snap whenever ticked.

import { lsGet, lsSet } from '../../../kernel/src/storage.ts'
import { unitToPx, pxToUnit } from '../model'

const KEY = 'slidomingo-grid'

/** Where things snap. Each is a checkbox in the Grid & Snap panel. */
export interface SnapTargets {
  grid: boolean
  /** the deck's layout columns/rows and their margins */
  layout: boolean
  guides: boolean
  /** the template's borders — safe-zone sides + the column grid's outer
   *  margins — snapped to even while hidden */
  margins: boolean
  /** other objects' edges and centers, and equal gaps between them */
  objects: boolean
  /** the slide's edges and center lines */
  slide: boolean
}

/** Units the panel shows lengths in. The model stays in px (96 dpi). */
export type LengthUnit = 'px' | 'pt' | 'mm' | 'cm' | 'in'
export const LENGTH_UNITS: LengthUnit[] = ['px', 'pt', 'mm', 'cm', 'in']

export interface GridPref {
  on: boolean
  /** Icon sets keep their own switch, on unless turned off: an icon is drawn
   *  on its unit grid, so it is shown there by default. */
  iconOn: boolean
  slideStepPx: number
  figureStepMm: number
  /** the slide unit for the panel's lengths (figures follow their own unit) */
  unit: LengthUnit
  showLayout: boolean
  showGuides: boolean
  snap: SnapTargets
}

/** Fallback presets for figures, in mm. Slides offer the steps that divide
 *  the page exactly (`fittingSteps`) instead. */
export const FIGURE_GRID_STEPS_MM = [1, 2, 5, 10]

const SNAP_DEFAULTS: SnapTargets = { grid: true, layout: true, guides: true, margins: true, objects: true, slide: true }
const DEFAULTS: GridPref = { on: false, iconOn: true, slideStepPx: 20, figureStepMm: 2, unit: 'px', showLayout: true, showGuides: true, snap: SNAP_DEFAULTS }

export function loadGridPref(): GridPref {
  try {
    const j = JSON.parse(lsGet(KEY) ?? '{}')
    const pos = (v: unknown, d: number) => (typeof v === 'number' && v > 0 && Number.isFinite(v) ? v : d)
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
    const s = j.snap && typeof j.snap === 'object' ? j.snap : {}
    const snap = Object.fromEntries(
      (Object.keys(SNAP_DEFAULTS) as Array<keyof SnapTargets>).map((k) => [k, bool(s[k], SNAP_DEFAULTS[k])]),
    ) as unknown as SnapTargets
    return {
      on: j.on === true,
      iconOn: j.iconOn !== false,
      slideStepPx: pos(j.slideStepPx, DEFAULTS.slideStepPx),
      figureStepMm: pos(j.figureStepMm, DEFAULTS.figureStepMm),
      unit: LENGTH_UNITS.includes(j.unit) ? j.unit : DEFAULTS.unit,
      showLayout: bool(j.showLayout, DEFAULTS.showLayout),
      showGuides: bool(j.showGuides, DEFAULTS.showGuides),
      snap,
    }
  } catch {
    return { ...DEFAULTS, snap: { ...SNAP_DEFAULTS } }
  }
}

export function saveGridPref(p: GridPref) {
  lsSet(KEY, JSON.stringify(p))
}

/** The switch that shows the grid in this kind of document (icon sets have their own). */
export function gridOnKey(iconset: boolean): 'on' | 'iconOn' {
  return iconset ? 'iconOn' : 'on'
}

/** Active grid step in model px (0 when off). */
export function gridStepPx(isFigure: boolean, p: GridPref = loadGridPref()): number {
  if (!p.on) return 0
  return isFigure ? unitToPx(p.figureStepMm, 'mm') : p.slideStepPx
}

/** px → the unit, and back. `cm` is mm/10; px is identity. */
export function toUnit(px: number, unit: LengthUnit): number {
  if (unit === 'px') return px
  if (unit === 'cm') return pxToUnit(px, 'mm') / 10
  return pxToUnit(px, unit)
}
export function fromUnit(v: number, unit: LengthUnit): number {
  if (unit === 'px') return v
  if (unit === 'cm') return unitToPx(v * 10, 'mm')
  return unitToPx(v, unit)
}

/** "20 px", "0.53 cm", "1.5 mm" — at most two decimals, no trailing zeros. */
export function formatLength(px: number, unit: LengthUnit): string {
  const v = toUnit(px, unit)
  const digits = unit === 'px' || unit === 'pt' ? 1 : 2
  return `${Number(v.toFixed(digits))} ${unit}`
}

/**
 * Grid steps (px) that divide the page EXACTLY in both directions — so the
 * grid never leaves a sliver at the right or bottom edge. These are the
 * divisors of gcd(width, height) within a usable range; 1280×720 gives
 * 5, 8, 10, 16, 20, 40, 80. Falls back to the plain px presets when the page
 * has no such divisors (an odd size).
 */
export function fittingSteps(size: { width: number; height: number }, min = 5, max = 160): number[] {
  const w = Math.round(size.width), h = Math.round(size.height)
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const g = gcd(w, h)
  const out: number[] = []
  for (let d = min; d <= Math.min(g, max); d++) if (g % d === 0) out.push(d)
  return out.length >= 2 ? out : [10, 20, 40, 80]
}
