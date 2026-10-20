// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon sets (docs/DECISIONS.md, "Icon sets"): a doc with `kind: 'iconset'`,
// one icon per slide on a `grid × gridH` canvas (square unless the set picked
// another aspect ratio, `ICON_CANVASES`). This module is the pure side:
//
//   - `applyIconsetStyle`  the set's stroke/caps/ink onto an icon's shapes
//                          (what "Apply set style" commits; fixes drift)
//   - `iconSlideSvg`       one icon → a small standalone SVG in GRID units
//                          (`viewBox="0 0 24 24"`, ink → currentColor), built
//                          from the MODEL, not the rendered DOM, so the file is
//                          as plain as a hand-made icon and runs in node
//   - `iconFileNames`, `iconManifest`, `parseIconManifest`, `manifestMatches`
//                          the exported folder's names and its `icons.json`,
//                          which a folder icon source reads for keywords
//
// Only shapes are icon material (path, rect, ellipse, triangle, arrow, line);
// anything else is reported in `skipped` and left out of the file.
//
// Pure — no DOM, no i18n — so scripts/test-iconset.ts runs it in node.

import type { IconsetInfo, ShapeElement, Slide, SlideElement, SlidomingoDoc } from './model.ts'
import { ICONSET_STYLE_DEFAULTS, newIconSlide } from './model.ts'
import { IDENTITY, mul, parsePath, pointsSegs, rectSegs, ellipseSegs, rotateAbout, segsToD, transformSegs, translate, type Mat, type Seg } from './svgpath.ts'

/** An icon set's settings with every field present, `gridH` too. */
export type IconsetGrid = IconsetInfo & { gridH: number }

/** The doc's icon-set settings with every field present, or null for any other doc. */
export function iconsetInfo(doc: SlidomingoDoc): IconsetGrid | null {
  if (doc.kind !== 'iconset') return null
  const raw = doc.iconset
  const grid = raw && raw.grid > 0 ? raw.grid : 24
  const gridH = raw && typeof raw.gridH === 'number' && raw.gridH > 0 ? raw.gridH : grid
  const scale = raw && raw.scale > 0 ? raw.scale : Math.max(1, doc.size.width / grid)
  return { ...raw, grid, gridH, scale, style: { ...ICONSET_STYLE_DEFAULTS, ...raw?.style } }
}

/** `iconsetInfo`, or a 24-unit square over the doc's width for any other doc. */
function gridOf(doc: SlidomingoDoc): IconsetGrid {
  return iconsetInfo(doc) ?? { grid: 24, gridH: 24, scale: doc.size.width / 24, style: ICONSET_STYLE_DEFAULTS }
}

/** The set's shorter side in grid units: what a stroke width, the padding or
 *  an example icon's size is measured against. */
export const iconShortSide = (info: IconsetGrid): number => Math.min(info.grid, info.gridH)

// ---- the canvas's aspect ratio ------------------------------------------------------------

/** The canvases an icon set offers, in grid units for a 24-unit set (a set
 *  drawn on another short side scales them, `iconCanvasUnits`). */
export const ICON_CANVASES = [
  { id: '1:1', w: 24, h: 24 },
  { id: '4:3', w: 32, h: 24 },
  { id: '3:2', w: 36, h: 24 },
  { id: '16:9', w: 48, h: 27 },
  { id: '2:1', w: 48, h: 24 },
  { id: '3:4', w: 24, h: 32 },
] as const

export type IconCanvasId = (typeof ICON_CANVASES)[number]['id']

/** A canvas preset in this set's units: the presets are for 24, a 16-unit set gets 16 × 16, 21 × 16 … */
export function iconCanvasUnits(info: IconsetGrid, id: IconCanvasId): { w: number; h: number } {
  const c = ICON_CANVASES.find((k) => k.id === id) ?? ICON_CANVASES[0]
  const k = iconShortSide(info) / 24
  return { w: Math.max(1, Math.round(c.w * k)), h: Math.max(1, Math.round(c.h * k)) }
}

/** Which preset the set is on, or null for a size none of them makes. */
export function iconCanvasId(info: IconsetGrid): IconCanvasId | null {
  return ICON_CANVASES.find((c) => {
    const u = iconCanvasUnits(info, c.id)
    return u.w === info.grid && u.h === info.gridH
  })?.id ?? null
}

/** `d` moved by (dx, dy) in its own units, every command kept as written
 *  (arcs stay arcs). Relative commands move with their start point, so only
 *  absolute coordinates change — and a leading `m`, which is absolute. */
export function translatePathD(d: string, dx: number, dy: number): string {
  const tokens = d.match(/[a-df-zA-DF-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []
  // per command: which arguments are x (1) and y (2)
  const AXES: Record<string, number[]> = {
    M: [1, 2], L: [1, 2], T: [1, 2], H: [1], V: [2], C: [1, 2, 1, 2, 1, 2], S: [1, 2, 1, 2], Q: [1, 2, 1, 2], A: [0, 0, 0, 0, 0, 1, 2], Z: [],
  }
  const out: string[] = []
  let cmd = ''
  let argi = 0
  let first = true
  let firstPair = false
  for (const tok of tokens) {
    if (/^[a-zA-Z]$/.test(tok)) {
      cmd = tok
      argi = 0
      firstPair = first && cmd === 'm'
      first = false
      out.push(tok)
      continue
    }
    const up = cmd.toUpperCase()
    const axes = AXES[up]
    if (!axes || !axes.length) { out.push(tok); continue }
    const axis = axes[argi % axes.length]
    const abs = cmd === up || firstPair
    let v = Number(tok)
    if (abs && axis === 1) v += dx
    else if (abs && axis === 2) v += dy
    out.push(abs && axis ? n3(v) : tok)
    argi++
    // after a leading `m`'s first pair, its implicit linetos are relative
    if (firstPair && argi >= 2) firstPair = false
  }
  return out.join(' ').replace(/ ?([a-zA-Z]) ?/g, '$1')
}

/**
 * The icon canvas resized to `w × h` grid units, every drawing kept centred:
 * a path drawn on the whole canvas in grid units (the agent's way) stays that
 * way with its `d` moved, anything else moves by the centre's shift. Edits
 * `doc` in place (call inside a commit); false when nothing changes.
 */
export function resizeIconCanvas(doc: SlidomingoDoc, w: number, h: number): boolean {
  const info = iconsetInfo(doc)
  if (!info || !(w > 0) || !(h > 0)) return false
  if (w === info.grid && h === info.gridH) return false
  const { scale } = info
  const oldW = doc.size.width, oldH = doc.size.height
  const dxU = (w - info.grid) / 2, dyU = (h - info.gridH) / 2
  const dx = dxU * scale, dy = dyU * scale
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6
  for (const slide of doc.slides) {
    for (const el of slide.elements) {
      const pb = el.type === 'shape' && el.shape === 'path' ? el.pathBox : undefined
      const onGrid = el.type === 'shape' && el.shape === 'path' && pb && !el.rotation && !el.flipH && !el.flipV &&
        near(el.x, 0) && near(el.y, 0) && near(el.w, oldW) && near(el.h, oldH) &&
        near(pb[0], 0) && near(pb[1], 0) && near(pb[2], info.grid) && near(pb[3], info.gridH)
      if (onGrid && el.type === 'shape') {
        el.w = w * scale
        el.h = h * scale
        el.pathBox = [0, 0, w, h]
        el.d = translatePathD(el.d ?? '', dxU, dyU)
      } else {
        el.x += dx
        el.y += dy
      }
    }
    // a pinned comment stays on the spot it points at
    for (const c of slide.comments ?? []) {
      if (typeof c.x === 'number') c.x += dx
      if (typeof c.y === 'number') c.y += dy
    }
  }
  const next: IconsetInfo = { ...doc.iconset!, grid: w }
  if (h === w) delete next.gridH; else next.gridH = h
  doc.iconset = next
  doc.size = { width: w * scale, height: h * scale }
  return true
}

/** Everything written into an attribute or text goes through this: an opened
 *  file skips untrusted.ts, so a colour string is whatever the file says. */
export const escXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// ---- colours -------------------------------------------------------------------------

/** `#abc` / `#AABBCC` → `#aabbcc`; anything else lower-cased as is. */
export function normColor(c: string): string {
  const v = c.trim().toLowerCase()
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v)
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : v
}

/** Nothing painted: transparent, none, or a zero alpha. */
export function isNoPaint(c: string | undefined): boolean {
  if (!c) return true
  const v = c.trim().toLowerCase()
  if (v === 'transparent' || v === 'none' || v === '') return true
  if (/^#[0-9a-f]{8}$/.test(v)) return v.endsWith('00')
  if (/^#[0-9a-f]{4}$/.test(v)) return v[4] === '0'
  return /^rgba?\([^)]*[,/]\s*0?\.?0*\s*\)$/.test(v) && !/[,/]\s*0*\.0*[1-9]/.test(v)
}

/** The ink becomes `currentColor` (the icon takes its colour from the text around it). */
function svgPaint(c: string | undefined, ink: string): string {
  if (isNoPaint(c)) return 'none'
  const v = normColor(c!)
  return v === normColor(ink) || v === 'currentcolor' ? 'currentColor' : escXml(v)
}

// ---- apply the set's style --------------------------------------------------------------

/** What "Apply set style" changes on one element; null when it already matches. */
export function iconStylePatch(el: SlideElement, info: IconsetInfo): Partial<ShapeElement> | null {
  if (el.type !== 'shape') return null
  const st = info.style
  const sw = st.strokeWidth * info.scale
  const patch: Partial<ShapeElement> = {}
  const set = <K extends keyof ShapeElement>(k: K, v: ShapeElement[K]) => { if (el[k] !== v) patch[k] = v }
  if (el.shape === 'line') {
    // a line is painted with its `fill` (render.ts)
    set('fill', st.color)
    set('strokeWidth', sw)
    set('strokeCap', st.cap)
  } else {
    if (!isNoPaint(el.stroke) || el.shape === 'path') {
      set('stroke', st.color)
      set('strokeWidth', sw)
    }
    if (el.shape === 'path') { set('strokeCap', st.cap); set('strokeJoin', st.join) }
    // a filled part (a dot, a solid glyph) keeps its fill, in the set's ink
    if (!isNoPaint(el.fill) && !el.fillGradient) set('fill', st.color)
    if (st.fill === 'solid' && isNoPaint(el.fill) && el.shape !== 'path') set('fill', st.color)
  }
  return Object.keys(patch).length ? patch : null
}

// ---- one icon → SVG ---------------------------------------------------------------------

export const n3 = (v: number): string => {
  const s = (Math.round(v * 1000) / 1000).toString()
  return s === '-0' ? '0' : s
}

/** render.ts `dashArray`'s twin, in px of the element. */
function dashArray(el: ShapeElement, w: number): string | undefined {
  if (el.strokeStyle === 'dashed') return `${Math.max(w * 2.4, 7)} ${Math.max(w * 1.8, 5)}`
  if (el.strokeStyle === 'dotted') return `0.1 ${Math.max(w * 2.2, 5)}`
  if (el.strokeStyle === 'solid') return undefined
  if (el.strokeDash) return `${el.strokeDash} ${el.strokeDash}`
  return undefined
}

const isIdentity = (m: Mat, eps = 1e-9): boolean => m.every((v, i) => Math.abs(v - IDENTITY[i]) < eps)

/** The element box → canvas px: translate, rotate about the centre, mirror inside the box. */
function frameMatrix(el: SlideElement): Mat {
  let m = translate(el.x, el.y)
  if (el.rotation) m = mul(m, rotateAbout(el.rotation, el.w / 2, el.h / 2))
  const f = el as { flipH?: boolean; flipV?: boolean }
  if (f.flipH || f.flipV) m = mul(m, [f.flipH ? -1 : 1, 0, 0, f.flipV ? -1 : 1, f.flipH ? el.w : 0, f.flipV ? el.h : 0])
  return m
}

/** The shape's outline in its own box px (or pathBox units for a path), as render.ts shapeSvg draws it. */
function localGeometry(el: ShapeElement): { segs: Seg[] | null; boxToLocal: Mat; open: boolean } {
  const { w, h } = el
  const sw = el.strokeWidth
  const inset = sw / 2
  switch (el.shape) {
    case 'path': {
      const pb = el.pathBox ?? [0, 0, Math.max(w, 1), Math.max(h, 1)]
      const sx = w / (pb[2] || 1), sy = h / (pb[3] || 1)
      return { segs: parsePath(el.d ?? ''), boxToLocal: [sx, 0, 0, sy, -pb[0] * sx, -pb[1] * sy], open: false }
    }
    case 'rect':
      return { segs: rectSegs(inset, inset, Math.max(w - sw, 0), Math.max(h - sw, 0), Math.max(el.radius - inset, 0), Math.max(el.radius - inset, 0)), boxToLocal: IDENTITY, open: false }
    case 'ellipse':
      return { segs: ellipseSegs(w / 2, h / 2, Math.max(w / 2 - inset, 0), Math.max(h / 2 - inset, 0)), boxToLocal: IDENTITY, open: false }
    case 'triangle':
      return { segs: pointsSegs(`${w / 2},${inset} ${w - inset},${h - inset} ${inset},${h - inset}`, true), boxToLocal: IDENTITY, open: false }
    case 'arrow': {
      const iw = Math.max(w - sw, 0), ih = Math.max(h - sw, 0)
      const shaftH = ih * 0.44
      const headW = Math.min(iw * 0.38, ih)
      const x0 = inset, x1 = inset + iw, xh = x1 - headW
      const y0 = inset + (ih - shaftH) / 2, y1 = y0 + shaftH
      return { segs: pointsSegs(`${x0},${y0} ${xh},${y0} ${xh},${inset} ${x1},${h / 2} ${xh},${inset + ih} ${xh},${y1} ${x0},${y1}`, true), boxToLocal: IDENTITY, open: false }
    }
    case 'line': {
      const lw = Math.max(sw, 2)
      const tipPad = (k?: string) => (k && k !== 'none' ? lw * 2.6 : 0)
      return { segs: [['M', tipPad(el.lineStart), h / 2], ['L', w - tipPad(el.lineEnd), h / 2]], boxToLocal: IDENTITY, open: true }
    }
  }
}

export interface IconSvg {
  svg: string
  /** element types (or `'line-ending'`, `'gradient'`) left out or simplified — the caller words the warning */
  skipped: string[]
}

/** One shape of an icon in grid units: what the plain export and every icon style draw. */
export interface IconShape {
  el: ShapeElement
  /** the outline, grid units */
  segs: Seg[]
  /** what to write: the path's own `d` when it is already drawn on the grid (arcs intact) */
  d: string
  /** a line, or a path without Z: only a stroke, never a fill */
  open: boolean
  /** stroke width in grid units, 0 = not stroked */
  strokeW: number
  /** the colour the stroke is drawn in (a line: its fill — render.ts) */
  strokeColor: string
  /** painted inside (a dot, a solid glyph) */
  filled: boolean
}

/** Every subpath ends with Z or back where it started (a circle drawn as two
 *  arcs without Z still has an inside to fill). */
function isClosedOutline(segs: readonly Seg[]): boolean {
  let sx = 0, sy = 0, cx = 0, cy = 0, open = false, any = false
  const done = () => { if (open && Math.hypot(cx - sx, cy - sy) > 0.01) return false; open = false; return true }
  for (const g of segs) {
    if (g[0] === 'M') { if (!done()) return false; sx = cx = g[1]; sy = cy = g[2]; open = true; any = true }
    else if (g[0] === 'Z') { open = false; cx = sx; cy = sy }
    else { cx = g[0] === 'C' ? g[5] : g[1]; cy = g[0] === 'C' ? g[6] : g[2] }
  }
  return any && done()
}

/** Every visible shape of the icon, in grid units; anything else is named in `skipped`. */
export function iconShapes(doc: SlidomingoDoc, slide: Slide): { shapes: IconShape[]; skipped: Set<string> } {
  const info = gridOf(doc)
  const toGrid: Mat = [1 / info.scale, 0, 0, 1 / info.scale, 0, 0]
  const skipped = new Set<string>()
  const shapes: IconShape[] = []
  for (const el of slide.elements) {
    if (el.hidden) continue
    if (el.type !== 'shape') { skipped.add(el.type); continue }
    const geo = localGeometry(el)
    if (!geo.segs?.length) continue
    const full = mul(mul(toGrid, frameMatrix(el)), geo.boxToLocal)
    const segs = transformSegs(geo.segs, full)
    // a path already drawn in grid units (the agent's way: pathBox = the grid,
    // frame = the canvas) keeps its own `d`, arcs and all
    const d = el.shape === 'path' && isIdentity(full) && el.d ? el.d.trim() : segsToD(segs)
    if (el.shape === 'line') {
      shapes.push({ el, segs, d, open: true, strokeW: Math.max(el.strokeWidth, 2) / info.scale, strokeColor: el.fill, filled: false })
      continue
    }
    const stroked = !isNoPaint(el.stroke) && el.strokeWidth > 0
    const open = el.shape === 'path' && !isClosedOutline(segs)
    shapes.push({ el, segs, d, open, strokeW: stroked ? el.strokeWidth / info.scale : 0, strokeColor: el.stroke, filled: !isNoPaint(el.fill) })
  }
  return { shapes, skipped }
}

/** One icon slide → a standalone SVG, `grid × gridH` units, ink as currentColor. */
export function iconSlideSvg(doc: SlidomingoDoc, slide: Slide, opts: { title?: boolean } = {}): IconSvg {
  const info = gridOf(doc)
  const ink = info.style.color
  const { shapes, skipped } = iconShapes(doc, slide)
  const body: string[] = []
  for (const { el, d } of shapes) {
    const attrs: string[] = [`d="${escXml(d)}"`]
    if (el.shape === 'line') {
      // render.ts paints a line with its fill, at least 2px wide, round-capped by default
      const lw = Math.max(el.strokeWidth, 2)
      attrs.push('fill="none"', `stroke="${svgPaint(el.fill, ink)}"`, `stroke-width="${n3(lw / info.scale)}"`,
        `stroke-linecap="${escXml(el.strokeCap ?? (el.strokeStyle === 'dashed' ? 'butt' : 'round'))}"`)
      const dash = dashArray(el, lw)
      if (dash) attrs.push(`stroke-dasharray="${dash.split(' ').map((v) => n3(Number(v) / info.scale)).join(' ')}"`)
      if ((el.lineStart && el.lineStart !== 'none') || (el.lineEnd && el.lineEnd !== 'none')) skipped.add('line-ending')
    } else {
      if (el.fillGradient?.stops.length) skipped.add('gradient')
      attrs.push(`fill="${svgPaint(el.fill, ink)}"`)
      if (el.fillRule === 'evenodd') attrs.push('fill-rule="evenodd"')
      const stroked = !isNoPaint(el.stroke) && el.strokeWidth > 0
      if (stroked) {
        attrs.push(`stroke="${svgPaint(el.stroke, ink)}"`, `stroke-width="${n3(el.strokeWidth / info.scale)}"`)
        const cap = el.strokeCap ?? (el.strokeStyle === 'dotted' ? 'round' : undefined)
        if (cap) attrs.push(`stroke-linecap="${escXml(cap)}"`)
        if (el.strokeJoin) attrs.push(`stroke-linejoin="${escXml(el.strokeJoin)}"`)
        const dash = dashArray(el, el.strokeWidth)
        if (dash) attrs.push(`stroke-dasharray="${dash.split(' ').map((v) => n3(Number(v) / info.scale)).join(' ')}"`)
      }
    }
    if (el.opacity < 1) attrs.push(`opacity="${n3(el.opacity)}"`)
    body.push(`  <path ${attrs.join(' ')}/>`)
  }
  const g = n3(info.grid), gh = n3(info.gridH)
  const title = opts.title && slide.name ? `  <title>${escXml(slide.name)}</title>\n` : ''
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${g}" height="${gh}" viewBox="0 0 ${g} ${gh}" fill="none">\n` +
    title + body.join('\n') + (body.length ? '\n' : '') + '</svg>\n'
  return { svg, skipped: [...skipped] }
}

// ---- names and the manifest ---------------------------------------------------------------

/** "Chain of Custody!" → "chain-of-custody"; never empty. */
export function iconSlug(name: string): string {
  const s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return s || 'icon'
}

/** One file name per slide (`<slug>.svg`), in slide order, made unique with -2, -3 … */
export function iconFileNames(slides: readonly Slide[]): string[] {
  const used = new Set<string>()
  return slides.map((s, i) => {
    const base = iconSlug(s.name ?? `icon-${i + 1}`)
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`
    used.add(name)
    return `${name}.svg`
  })
}

/** The `icons.json` an exported set carries (format 1). */
export interface IconManifest {
  format: 'beeslides-icons'
  version: 1
  name: string
  license?: string
  author?: string
  grid: number
  /** grid units down, when the icons are not square */
  gridH?: number
  /** the set's extra styles, one folder each (iconstyles.ts); the plain icons stay at the top */
  styles?: Array<{ name: string; folder: string }>
  /** a style's file is `<folder>/<file>` and carries `style` */
  icons: Array<{ file: string; name: string; keywords?: string[]; style?: string }>
}

export const ICON_MANIFEST_FILE = 'icons.json'

/** One folder name per style (`<slug>`), unique, never clashing with each other. */
export function styleFolderNames(names: readonly string[]): string[] {
  const used = new Set<string>()
  return names.map((n) => {
    const base = iconSlug(n)
    let name = base
    for (let k = 2; used.has(name); k++) name = `${base}-${k}`
    used.add(name)
    return name
  })
}

export function iconManifest(doc: SlidomingoDoc, files: readonly string[], styles: ReadonlyArray<{ name: string; folder: string }> = []): IconManifest {
  const info = iconsetInfo(doc)
  const out: IconManifest = { format: 'beeslides-icons', version: 1, name: doc.title, grid: info?.grid ?? 24, icons: [] }
  if (info && info.gridH !== info.grid) out.gridH = info.gridH
  if (info?.license) out.license = info.license
  if (info?.author) out.author = info.author
  doc.slides.forEach((s, i) => {
    const entry: IconManifest['icons'][number] = { file: files[i], name: s.name ?? files[i].replace(/\.svg$/, '') }
    const kw = (s.icon?.keywords ?? []).map((k) => k.trim()).filter(Boolean)
    if (kw.length) entry.keywords = kw
    out.icons.push(entry)
  })
  if (styles.length) {
    out.styles = styles.map((st) => ({ name: st.name, folder: st.folder }))
    // every style's copy is searchable by the icon's words plus the style's name
    for (const st of styles) {
      out.icons.slice(0, doc.slides.length).forEach((base) => {
        out.icons.push({ ...base, file: `${st.folder}/${base.file}`, keywords: [...(base.keywords ?? []), st.name], style: st.name })
      })
    }
  }
  return out
}

/** A parsed manifest entry, keyed by file name (lower case) for a folder walk. */
export interface ManifestEntry { name: string; keywords: string[]; license?: string; author?: string }

/** Read an `icons.json` someone else may have written: anything malformed is dropped, never thrown. */
export function parseIconManifest(text: string): Map<string, ManifestEntry> {
  const out = new Map<string, ManifestEntry>()
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return out }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  const str = (v: unknown, max = 300): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined)
  const license = str(r.license), author = str(r.author)
  if (!Array.isArray(r.icons)) return out
  for (const it of r.icons.slice(0, 10000)) {
    if (!it || typeof it !== 'object') continue
    const e = it as Record<string, unknown>
    const file = str(e.file, 500)
    if (!file) continue
    const keywords = Array.isArray(e.keywords) ? e.keywords.map((k) => str(k, 100)).filter((k): k is string => !!k).slice(0, 32) : []
    out.set(file.toLowerCase(), {
      name: str(e.name) ?? file.replace(/\.[a-z0-9]+$/i, ''),
      keywords,
      ...(str(e.license) ?? license ? { license: str(e.license) ?? license } : {}),
      ...(str(e.author) ?? author ? { author: str(e.author) ?? author } : {}),
    })
  }
  return out
}

/** Does a lower-cased query hit this file by name or keyword? */
export function manifestMatches(q: string, fileName: string, entry: ManifestEntry | undefined): boolean {
  if (!q) return true
  if (fileName.toLowerCase().includes(q)) return true
  if (!entry) return false
  return entry.name.toLowerCase().includes(q) || entry.keywords.some((k) => k.toLowerCase().includes(q))
}

/** The icons a "Draw with AI" run should draw: the selected ones, else every empty one. */
export function iconsToDraw(doc: SlidomingoDoc, selectedIds: readonly string[]): Slide[] {
  if (selectedIds.length > 1) return doc.slides.filter((s) => selectedIds.includes(s.id))
  const empty = doc.slides.filter((s) => !s.elements.length)
  if (empty.length) return empty
  return doc.slides.filter((s) => selectedIds.includes(s.id))
}

// ---- the plan ("Plan with AI") ------------------------------------------------------------

/** One planned icon, as an agent sends it (`icons` tool, op "plan"). */
export interface PlannedIcon { name: string; prompt?: string; keywords?: string[] }

/** The most icons one plan may hold. */
export const MAX_PLANNED_ICONS = 60

/** Agent input → clean planned icons, or a message saying what is wrong. */
export function readIconPlan(raw: unknown): PlannedIcon[] | string {
  if (!Array.isArray(raw) || !raw.length) return 'icons must be a non-empty list of {name, prompt, keywords}.'
  if (raw.length > MAX_PLANNED_ICONS) return `At most ${MAX_PLANNED_ICONS} icons per plan.`
  const out: PlannedIcon[] = []
  const seen = new Set<string>()
  for (const [i, it] of raw.entries()) {
    if (!it || typeof it !== 'object') return `icons[${i}] is not an object.`
    const r = it as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
    if (!name) return `icons[${i}] has no name.`
    if (seen.has(name.toLowerCase())) return `"${name}" is planned twice.`
    seen.add(name.toLowerCase())
    const entry: PlannedIcon = { name }
    if (typeof r.prompt === 'string' && r.prompt.trim()) entry.prompt = r.prompt.replace(/\s+/g, ' ').trim().slice(0, 300)
    if (Array.isArray(r.keywords)) {
      const kw = r.keywords.filter((k): k is string => typeof k === 'string').map((k) => k.trim().slice(0, 40)).filter(Boolean).slice(0, 8)
      if (kw.length) entry.keywords = kw
    }
    out.push(entry)
  }
  return out
}

/** An icon nobody has drawn, named or commented on yet (what a new set starts with). */
const isBlankIcon = (s: Slide): boolean => !s.elements.length && !s.comments?.length && (!s.name || s.name === 'icon') && !s.icon?.prompt

/**
 * Add icons by name (the Add icons popover): a blank starter icon takes the
 * first new name, a name already in the set (any case) is not added twice,
 * the rest are inserted at `at` in order. Returns the slide ids of every
 * name, in order (existing ones too), and how many were new. Mutates `doc`;
 * call inside a commit.
 */
export function addIconNames(doc: SlidomingoDoc, names: readonly string[], at: number): { slideIds: string[]; added: number } {
  const byName = new Map(doc.slides.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))
  const blanks = doc.slides.filter(isBlankIcon)
  let pos = Math.max(0, Math.min(at, doc.slides.length))
  let added = 0
  const ids: string[] = []
  for (const raw of names) {
    const name = raw.trim().slice(0, 120)
    if (!name) continue
    let slide = byName.get(name.toLowerCase())
    if (!slide) {
      slide = blanks.shift()
      if (slide) slide.name = name
      else { slide = newIconSlide(name); doc.slides.splice(pos++, 0, slide) }
      byName.set(name.toLowerCase(), slide)
      added++
    }
    ids.push(slide.id)
  }
  return { slideIds: ids, added }
}

/**
 * Write a plan into the set: an icon already there BY NAME gets the new
 * prompt/keywords (its drawing stays), blank starter icons are filled first,
 * the rest are added at the end. With `replace`, still-empty icons the plan
 * does not name are removed (drawn or commented ones never are; the set keeps
 * at least one slide). Mutates `doc`; call inside a commit.
 */
export function applyIconPlan(doc: SlidomingoDoc, plan: readonly PlannedIcon[], replace = false): { slideIds: string[]; added: number; updated: number; removed: number } {
  const byName = new Map(doc.slides.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))
  const blanks = doc.slides.filter(isBlankIcon)
  let added = 0, updated = 0
  const ids: string[] = []
  for (const p of plan) {
    let slide = byName.get(p.name.toLowerCase())
    if (slide) updated++
    else {
      slide = blanks.shift()
      if (!slide) { slide = newIconSlide(p.name); doc.slides.push(slide) }
      slide.name = p.name
      added++
    }
    const icon: NonNullable<Slide['icon']> = { ...slide.icon }
    if (p.prompt) icon.prompt = p.prompt
    if (p.keywords) icon.keywords = [...p.keywords]
    if (Object.keys(icon).length) slide.icon = icon
    ids.push(slide.id)
  }
  let removed = 0
  if (replace) {
    const keep = new Set(ids)
    const before = doc.slides.length
    const rest = doc.slides.filter((s) => keep.has(s.id) || s.elements.length || s.comments?.length)
    if (rest.length) { doc.slides = rest; removed = before - rest.length }
  }
  return { slideIds: ids, added, updated, removed }
}
