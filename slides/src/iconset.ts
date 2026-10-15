// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon sets (docs/DECISIONS.md, "Icon sets"): a doc with `kind: 'iconset'`,
// one icon per slide on a `grid × grid` square. This module is the pure side:
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
import { ICONSET_STYLE_DEFAULTS } from './model.ts'
import { IDENTITY, mul, parsePath, pointsSegs, rectSegs, ellipseSegs, rotateAbout, segsToD, transformSegs, translate, type Mat, type Seg } from './svgpath.ts'

/** The doc's icon-set settings with every field present, or null for any other doc. */
export function iconsetInfo(doc: SlidomingoDoc): IconsetInfo | null {
  if (doc.kind !== 'iconset') return null
  const raw = doc.iconset
  const grid = raw && raw.grid > 0 ? raw.grid : 24
  const scale = raw && raw.scale > 0 ? raw.scale : Math.max(1, doc.size.width / grid)
  return { ...raw, grid, scale, style: { ...ICONSET_STYLE_DEFAULTS, ...raw?.style } }
}

/** Everything written into an attribute or text goes through this: an opened
 *  file skips untrusted.ts, so a colour string is whatever the file says. */
const escXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// ---- colours -------------------------------------------------------------------------

/** `#abc` / `#AABBCC` → `#aabbcc`; anything else lower-cased as is. */
function normColor(c: string): string {
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

const n3 = (v: number): string => {
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

/** One icon slide → a standalone SVG, `grid` units square, ink as currentColor. */
export function iconSlideSvg(doc: SlidomingoDoc, slide: Slide, opts: { title?: boolean } = {}): IconSvg {
  const info = iconsetInfo(doc) ?? { grid: 24, scale: doc.size.width / 24, style: ICONSET_STYLE_DEFAULTS }
  const ink = info.style.color
  const toGrid: Mat = [1 / info.scale, 0, 0, 1 / info.scale, 0, 0]
  const skipped = new Set<string>()
  const body: string[] = []
  for (const el of slide.elements) {
    if (el.hidden) continue
    if (el.type !== 'shape') { skipped.add(el.type); continue }
    const geo = localGeometry(el)
    if (!geo.segs?.length) continue
    const toCanvas = mul(toGrid, frameMatrix(el))
    const full = mul(toCanvas, geo.boxToLocal)
    // a path already drawn in grid units (the agent's way: pathBox = the grid,
    // frame = the canvas) keeps its own `d`, arcs and all
    const d = el.shape === 'path' && isIdentity(full) && el.d ? el.d.trim() : segsToD(transformSegs(geo.segs, full))
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
  const g = n3(info.grid)
  const title = opts.title && slide.name ? `  <title>${escXml(slide.name)}</title>\n` : ''
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${g}" height="${g}" viewBox="0 0 ${g} ${g}" fill="none">\n` +
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
  format: 'slidomingo-icons'
  version: 1
  name: string
  license?: string
  author?: string
  grid: number
  icons: Array<{ file: string; name: string; keywords?: string[] }>
}

export const ICON_MANIFEST_FILE = 'icons.json'

export function iconManifest(doc: SlidomingoDoc, files: readonly string[]): IconManifest {
  const info = iconsetInfo(doc)
  const out: IconManifest = { format: 'slidomingo-icons', version: 1, name: doc.title, grid: info?.grid ?? 24, icons: [] }
  if (info?.license) out.license = info.license
  if (info?.author) out.author = info.author
  doc.slides.forEach((s, i) => {
    const entry: IconManifest['icons'][number] = { file: files[i], name: s.name ?? files[i].replace(/\.svg$/, '') }
    const kw = (s.icon?.keywords ?? []).map((k) => k.trim()).filter(Boolean)
    if (kw.length) entry.keywords = kw
    out.icons.push(entry)
  })
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
