// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Figure export to a standalone vector SVG (docs/DECISIONS.md, "Figure mode").
//
// The figure is rendered with the editor's own renderer into an off-screen
// host, then walked element by element:
//   - shapes / charts / raw svg   → their inline <svg> is cloned in verbatim
//   - images                      → <image href="data:…">
//   - text, code, table cells     → <text> at positions MEASURED from the live
//     layout (Range rects per character), so the browser's exact line
//     breaking survives; optionally glyph outlines via opentype.js. List
//     markers (CSS ::marker, no text node to measure) are drawn from the
//     list's style and the item's first line; a rich-text link becomes an
//     SVG <a> (http/https/mailto only, judged again here)
//   - $…$ math                    → re-typeset by MathJax (tex-svg, glyphs as
//     paths) and fitted into the measured math box
// MathJax and opentype.js are fetched ONLY when an export needs them, so the
// single-file build does not carry them.

import type { Slide, SlidomingoDoc, SlideElement } from './model'
import { canFlip, renderSlide, sanitizeLinkHref } from './render'
import { zoomCover, type ZoomElement } from './model'
import { zoomTileRect } from './zoom'
import { t } from './i18n'

export interface FigureSvgOpts {
  /** Convert text to <path> outlines (needs readable font files). */
  outlineText?: boolean
  /** Export only these elements (a selection) — then no slide background
   *  unless `background` asks for it. */
  only?: ReadonlySet<string>
  /** Paint the slide's background colour (default: unless `only` is set). */
  background?: boolean
  /** The part of the slide to export, in slide px (default: all of it). */
  area?: { x: number; y: number; w: number; h: number }
  /** width/height attributes, e.g. "240pt" (default: the figure's size, or px). */
  size?: { width: string; height: string }
}
export interface FigureSvgResult { svg: string; warnings: string[] }

const SVG_NS = 'http://www.w3.org/2000/svg'
const MATHJAX_URL = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js'
const OPENTYPE_URL = 'https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.module.js'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n: number): string => String(Math.round(n * 1000) / 1000)

/** Any CSS colour → `fill`/`opacity` attribute pair ("rgba()" is unevenly supported). */
function paint(css: string): { color: string; alpha: number } | null {
  const m = css.match(/rgba?\(([^)]+)\)/)
  if (!m) return css && css !== 'transparent' && css !== 'none' ? { color: css, alpha: 1 } : null
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
  const a = p.length > 3 ? p[3] : 1
  if (a === 0) return null
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0')
  return { color: `#${hex(p[0])}${hex(p[1])}${hex(p[2])}`, alpha: a }
}
const fillAttr = (css: string, attr = 'fill'): string => {
  const p = paint(css)
  if (!p) return ` ${attr}="none"`
  return ` ${attr}="${p.color}"` + (p.alpha < 1 ? ` ${attr}-opacity="${num(p.alpha)}"` : '')
}

// ---- lazy libraries -------------------------------------------------------------------

let mathJaxLoad: Promise<any | null> | null = null
function loadMathJax(): Promise<any | null> {
  if (mathJaxLoad) return mathJaxLoad
  mathJaxLoad = new Promise((resolve) => {
    const w = window as any
    if (w.MathJax?.tex2svg) return resolve(w.MathJax)
    w.MathJax = { startup: { typeset: false }, svg: { fontCache: 'local' } }
    const s = document.createElement('script')
    s.src = MATHJAX_URL
    const timer = setTimeout(() => resolve(null), 15000)
    s.onload = () => {
      const mj = w.MathJax
      Promise.resolve(mj?.startup?.promise).then(() => { clearTimeout(timer); resolve(mj?.tex2svg ? mj : null) }, () => resolve(null))
    }
    s.onerror = () => { clearTimeout(timer); resolve(null) }
    document.head.appendChild(s)
  })
  return mathJaxLoad.then((m) => { if (!m) mathJaxLoad = null; return m })
}

let opentypeLoad: Promise<any | null> | null = null
function loadOpentype(): Promise<any | null> {
  opentypeLoad ??= import(/* @vite-ignore */ OPENTYPE_URL).then((m) => m.default ?? m, () => null)
  return opentypeLoad
}

// ---- fonts for outlining --------------------------------------------------------------

type OtFont = { getPath(text: string, x: number, y: number, size: number, opts?: object): { toPathData(d?: number): string } }

/** Font files by family|weight|style: embedded first, then installed (Chromium). */
class FontSource {
  private cache = new Map<string, Promise<OtFont | null>>()
  constructor(private doc: SlidomingoDoc, private ot: any) {}

  get(family: string, weight: number, italic: boolean): Promise<OtFont | null> {
    const key = `${family.toLowerCase()}|${weight}|${italic}`
    let p = this.cache.get(key)
    if (!p) this.cache.set(key, (p = this.load(family, weight, italic)))
    return p
  }

  private async load(family: string, weight: number, italic: boolean): Promise<OtFont | null> {
    const bytes = (await this.embedded(family, weight, italic)) ?? (await this.installed(family, weight, italic))
    if (!bytes) return null
    try { return this.ot.parse(bytes) } catch { return null } // e.g. WOFF2, which opentype.js cannot read
  }

  private async embedded(family: string, weight: number, italic: boolean): Promise<ArrayBuffer | null> {
    const cands = (this.doc.fonts ?? []).filter((f) => f.family.toLowerCase() === family.toLowerCase())
    if (!cands.length) return null
    const score = (f: { weight?: string; style?: string }) =>
      Math.abs((parseInt(f.weight ?? '400', 10) || 400) - weight) + ((f.style === 'italic') === italic ? 0 : 1000)
    cands.sort((a, b) => score(a) - score(b))
    const src = this.doc.assets?.[cands[0].asset]
    if (!src?.startsWith('data:')) return null
    try { return await (await fetch(src)).arrayBuffer() } catch { return null }
  }

  private async installed(family: string, weight: number, italic: boolean): Promise<ArrayBuffer | null> {
    const q = (navigator as any).queryLocalFonts as undefined | (() => Promise<any[]>)
    if (!q) return null
    try {
      const all = (await q.call(navigator)).filter((f) => f.family.toLowerCase() === family.toLowerCase())
      if (!all.length) return null
      const score = (f: any) => {
        const s = String(f.style).toLowerCase()
        const w = /bold/.test(s) ? 700 : /light/.test(s) ? 300 : 400
        return Math.abs(w - weight) + (/italic|oblique/.test(s) === italic ? 0 : 1000)
      }
      all.sort((a, b) => score(a) - score(b))
      return await (await all[0].blob()).arrayBuffer()
    } catch { return null }
  }
}

// ---- export ---------------------------------------------------------------------------

interface Ctx {
  doc: SlidomingoDoc
  opts: FigureSvgOpts
  warnings: Set<string>
  uid: number
  fonts: FontSource | null
  mathJax: any | null
  measure: CanvasRenderingContext2D
  ids: Set<string>
  fontMemo: Map<string, string>
  /** inside a zoom tile's nested slide: a tile met there exports as its frame only */
  inZoom?: boolean
}

/** Rewrite every id (and its url(#…)/href references) in a serialized fragment so
 *  two charts or gradients from different elements can never collide. */
function uniquify(markup: string, prefix: string): string {
  const ids = new Set<string>()
  for (const m of markup.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1])
  let out = markup
  for (const id of ids) {
    const re = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out
      .replace(new RegExp(`(\\sid=")${re}"`, 'g'), `$1${prefix}${id}"`)
      .replace(new RegExp(`url\\(\\s*(['"]?)#${re}\\1\\s*\\)`, 'g'), `url(#${prefix}${id})`)
      .replace(new RegExp(`((?:xlink:)?href=")#${re}"`, 'g'), `$1#${prefix}${id}"`)
  }
  return out
}

const GENERIC_FALLBACK: Record<string, string> = {
  'sans-serif': 'Helvetica, Arial, sans-serif',
  'system-ui': 'Helvetica, Arial, sans-serif',
  '-apple-system': 'Helvetica, Arial, sans-serif',
  'blinkmacsystemfont': 'Helvetica, Arial, sans-serif',
  'ui-sans-serif': 'Helvetica, Arial, sans-serif',
  'segoe ui': 'Helvetica, Arial, sans-serif',
  serif: "'Times New Roman', Times, serif",
  'ui-serif': "'Times New Roman', Times, serif",
  monospace: "'Courier New', Courier, monospace",
  'ui-monospace': "'Courier New', Courier, monospace",
}

/** A family is usable if it renders differently from both fallbacks (or the document embeds it). */
function fontInstalled(name: string, ctx: Ctx): boolean {
  if ((ctx.doc.fonts ?? []).some((f) => f.family.toLowerCase() === name.toLowerCase())) return true
  const probe = 'mmmmmmlliWW@#0123'
  const w = (face: string) => { ctx.measure.font = `72px ${face}`; return ctx.measure.measureText(probe).width }
  const q = `"${name}"`
  return w(`${q}, monospace`) !== w('monospace') || w(`${q}, serif`) !== w('serif')
}

/** The CSS font stack → one concrete stack other tools can resolve: the first
 *  family that is really available, with a generic tail. System/generic names
 *  (what a figure's default stack starts with) map to Helvetica, Arial. */
function concreteFont(stack: string, ctx: Ctx): string {
  let hit = ctx.fontMemo.get(stack)
  if (hit) return hit
  const fams = stack.split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  for (const f of fams) {
    const generic = GENERIC_FALLBACK[f.toLowerCase()]
    if (generic) { hit = generic; break }
    if (fontInstalled(f, ctx)) {
      const tail = fams.find((x) => GENERIC_FALLBACK[x.toLowerCase()])
      hit = `'${f}', ${GENERIC_FALLBACK[(tail ?? 'sans-serif').toLowerCase()].split(', ').slice(-1)[0]}`
      break
    }
  }
  hit ??= GENERIC_FALLBACK['sans-serif']
  ctx.fontMemo.set(stack, hit)
  return hit
}

function filterDefs(el: SlideElement | undefined, id: string): string {
  if (!el) return ''
  const shadows = Array.isArray(el.shadow) ? el.shadow : el.shadow ? [el.shadow] : []
  if (!shadows.length && !el.blur) return ''
  let prim = ''
  let prev = 'SourceGraphic'
  // SVG 1.1 primitives only: feDropShadow (SVG 2) is ignored by Inkscape/Illustrator/rsvg
  shadows.forEach((s, i) => {
    const p = paint(s.color)
    prim +=
      `<feGaussianBlur in="${prev}" stdDeviation="${num(s.blur / 2)}" result="sb${i}"/>` +
      `<feOffset in="sb${i}" dx="${num(s.x ?? 0)}" dy="${num(s.y ?? 0)}" result="so${i}"/>` +
      `<feFlood flood-color="${p?.color ?? '#000000'}" flood-opacity="${num(p?.alpha ?? 1)}" result="sc${i}"/>` +
      `<feComposite in="sc${i}" in2="so${i}" operator="in" result="sd${i}"/>` +
      `<feMerge result="s${i}"><feMergeNode in="sd${i}"/><feMergeNode in="${prev}"/></feMerge>`
    prev = `s${i}`
  })
  if (el.blur) prim += `<feGaussianBlur in="${prev}" stdDeviation="${num(el.blur)}"/>`
  return `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${prim}</filter>`
}

function findElement(slide: Slide, id: string): SlideElement | undefined {
  return slide.elements.find((e) => e.id === id)
}

/** Build the standalone SVG for a figure document's (single) slide. */
export async function exportFigureSvg(doc: SlidomingoDoc, slide: Slide, opts: FigureSvgOpts = {}): Promise<FigureSvgResult> {
  const warnings = new Set<string>()
  const needMath = slide.elements.some((e) => e.type === 'math' && !!e.tex?.trim()) ||
    /\$[^$]+\$/.test(slide.elements.map((e) => ('html' in e ? e.html : '')).join('\n'))
  const [mathJax, ot] = await Promise.all([needMath ? loadMathJax() : null, opts.outlineText ? loadOpentype() : null])
  if (needMath && !mathJax) warnings.add(t('Math could not be converted to paths (MathJax unavailable offline) — it is kept as MathML'))
  if (opts.outlineText && !ot) warnings.add(t('Text outlining needs a network connection to load its font reader — text is kept as text'))

  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;visibility:hidden'
  const surface = renderSlide(slide, doc, { hidePlaceholders: true, inlineData: true })
  host.appendChild(surface)
  document.body.appendChild(host)
  try {
    await document.fonts?.ready
    await Promise.all(Array.from(surface.querySelectorAll('img')).map((i) => (i as HTMLImageElement).decode().catch(() => {})))
    const ctx: Ctx = {
      doc, opts, warnings, uid: 0,
      fonts: ot ? new FontSource(doc, ot) : null,
      mathJax,
      measure: document.createElement('canvas').getContext('2d')!,
      ids: new Set(), fontMemo: new Map(),
    }
    const { width: W, height: H } = doc.size
    const defs: string[] = []
    const body: string[] = []
    if (opts.background ?? !opts.only) {
      const bg = paint(getComputedStyle(surface).backgroundColor)
      if (bg) body.push(`<rect width="${num(W)}" height="${num(H)}"${fillAttr(getComputedStyle(surface).backgroundColor)}/>`)
      if (getComputedStyle(surface).backgroundImage !== 'none') warnings.add(t('A background image/gradient is not exported — only its colour'))
    }
    for (const node of Array.from(surface.children) as HTMLElement[]) {
      if (!node.classList.contains('beeslides-el') || node.style.display === 'none') continue
      if (opts.only && !opts.only.has(node.dataset.elId ?? '')) continue
      const g = await elementToSvg(node, slide, ctx, defs)
      if (g) body.push(g)
    }
    const f = doc.figure
    const a = opts.area ?? { x: 0, y: 0, w: W, h: H }
    const wAttr = opts.size?.width ?? (f ? `${num(f.width)}${f.unit}` : `${num(W)}`)
    const hAttr = opts.size?.height ?? (f ? `${num(f.height)}${f.unit}` : `${num(H)}`)
    const svg =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${wAttr}" height="${hAttr}" viewBox="${num(a.x)} ${num(a.y)} ${num(a.w)} ${num(a.h)}">\n` +
      `<title>${esc(doc.title)}</title>\n` +
      (defs.length ? `<defs>${defs.join('')}</defs>\n` : '') +
      body.join('\n') + '\n</svg>\n'
    return { svg, warnings: [...warnings] }
  } finally {
    host.remove()
  }
}

async function elementToSvg(node: HTMLElement, slide: Slide, ctx: Ctx, defs: string[]): Promise<string> {
  const id = node.dataset.elId ?? ''
  const model = findElement(slide, id)
  const x = parseFloat(node.style.left) || 0
  const y = parseFloat(node.style.top) || 0
  const w = parseFloat(node.style.width) || 0
  const h = parseFloat(node.style.height) || 0
  const rot = /rotate\(([-\d.]+)deg\)/.exec(node.style.transform)?.[1]
  const opacity = node.style.opacity === '' ? 1 : parseFloat(node.style.opacity)
  // measure un-rotated: rects of a rotated box would be its bounding box
  node.style.transform = ''
  // the flip is re-applied below as an SVG transform; a CSS one left on the
  // cloned content would be copied into the markup and flip it twice
  if (model && canFlip(model)) for (const c of Array.from(node.children)) (c as HTMLElement).style.transform = ''
  const origin = node.getBoundingClientRect()

  const type = Array.from(node.classList).find((c) => c.startsWith('beeslides-el-'))?.slice('beeslides-el-'.length) ?? ''
  let inner = ''
  switch (type) {
    case 'shape':
    case 'chart':
    case 'svg': inner = cloneInlineSvg(node, w, h, ctx, type); break
    case 'image': inner = imageToSvg(node, w, h, ctx); break
    case 'text': inner = await textToSvg(node, origin, ctx); break
    case 'code': {
      const clip = `clip${ctx.uid++}`
      defs.push(`<clipPath id="${clip}"><rect width="${num(w)}" height="${num(h)}"/></clipPath>`)
      inner = `<g clip-path="url(#${clip})">${await textToSvg(node, origin, ctx)}</g>`
      break
    }
    case 'table': inner = (await tableToSvg(node, origin, ctx)) + (await textToSvg(node, origin, ctx)); break
    // an equation is its <math>, which textToSvg re-typesets through MathJax
    // (or keeps as MathML offline); an invalid one is its source as text
    case 'math': inner = await textToSvg(node, origin, ctx); break
    case 'zoom': inner = await zoomToSvg(node, model?.type === 'zoom' ? model : undefined, w, h, ctx, defs); break
    default:
      ctx.warnings.add(t('A {kind} element cannot be exported to SVG and was skipped', { kind: type }))
      return ''
  }
  if (!inner) return ''
  // content-only flip, same as render.ts applyFlip: mirror inside the frame, before the rotation
  if (model && canFlip(model) && (model.flipH || model.flipV)) {
    const fx = model.flipH ? -1 : 1
    const fy = model.flipV ? -1 : 1
    inner = `<g transform="translate(${model.flipH ? num(w) : 0} ${model.flipV ? num(h) : 0}) scale(${fx} ${fy})">${inner}</g>`
  }
  if (model?.reflection) ctx.warnings.add(t('A reflection is not exported to SVG'))

  let filter = ''
  const fid = `f${ctx.uid++}`
  const fdef = filterDefs(model, fid)
  if (fdef) { defs.push(fdef); filter = ` filter="url(#${fid})"` }
  const tf = `translate(${num(x)} ${num(y)})` + (rot ? ` rotate(${rot} ${num(w / 2)} ${num(h / 2)})` : '')
  const blend = node.style.mixBlendMode ? ` style="mix-blend-mode:${esc(node.style.mixBlendMode)}"` : ''
  if (blend) ctx.warnings.add(t('A blend mode is kept as CSS mix-blend-mode — Inkscape, Illustrator and rsvg ignore it'))
  const label = elementLabel(node, model, type)
  const gid = uniqueId(label, ctx)
  return `<g id="${gid}" inkscape:label="${esc(label)}" data-el-id="${esc(id)}" transform="${tf}"${opacity < 1 ? ` opacity="${num(opacity)}"` : ''}${filter}${blend}>${inner}</g>`
}

/**
 * A zoom tile: its cover slide exported element by element from its own
 * off-screen render (so text measures at full size), scaled into the tile's
 * cover rect and clipped to it, plus the frame. A tile inside a tile (and a
 * tile with no target) is just its frame — the same depth rule as render.ts.
 */
async function zoomToSvg(node: HTMLElement, model: ZoomElement | undefined, w: number, h: number, ctx: Ctx, defs: string[]): Promise<string> {
  let out = ''
  const cover = model && !ctx.inZoom ? zoomCover(ctx.doc, model) : undefined
  if (cover) {
    const { width: W, height: H } = ctx.doc.size
    const r = zoomTileRect({ x: 0, y: 0, w, h }, ctx.doc.size)
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;visibility:hidden'
    const surface = renderSlide(cover, ctx.doc, { hidePlaceholders: true, inlineData: true, zoomDepth: 1 })
    host.appendChild(surface)
    document.body.appendChild(host)
    try {
      await Promise.all(Array.from(surface.querySelectorAll('img')).map((i) => (i as HTMLImageElement).decode().catch(() => {})))
      const clip = `clip${ctx.uid++}`
      defs.push(`<clipPath id="${clip}"><rect width="${num(W)}" height="${num(H)}"/></clipPath>`)
      const body: string[] = [`<rect width="${num(W)}" height="${num(H)}"${fillAttr(getComputedStyle(surface).backgroundColor)}/>`]
      ctx.inZoom = true
      for (const child of Array.from(surface.children) as HTMLElement[]) {
        if (!child.classList.contains('beeslides-el') || child.style.display === 'none') continue
        const g = await elementToSvg(child, cover, ctx, defs)
        if (g) body.push(g)
      }
      out = `<g transform="translate(${num(r.x)} ${num(r.y)}) scale(${num(r.w / W)})" clip-path="url(#${clip})">${body.join('')}</g>`
    } finally {
      ctx.inZoom = false
      host.remove()
    }
  }
  const frame = node.querySelector<HTMLElement>(':scope > .beeslides-zoom-frame')
  if (frame) {
    const cs = getComputedStyle(frame)
    const sw = parseFloat(cs.borderTopWidth) || 0
    const rad = parseFloat(cs.borderTopLeftRadius) || 0
    if (sw > 0) out += `<rect x="${num(sw / 2)}" y="${num(sw / 2)}" width="${num(Math.max(0, w - sw))}" height="${num(Math.max(0, h - sw))}"` +
      `${rad ? ` rx="${num(rad)}"` : ''} fill="none"${fillAttr(cs.borderTopColor, 'stroke')} stroke-width="${num(sw)}"/>`
  }
  return out
}

/** "Text: Two disks damaged", "Ellipse", "Image" … — what the Objects panel lists. */
function elementLabel(node: HTMLElement, model: SlideElement | undefined, type: string): string {
  const kind = (model as { shape?: string } | undefined)?.shape
  const base = type === 'shape' && kind ? kind : type
  const name = base === 'svg' ? 'SVG' : base === 'math' ? 'Equation' : base.charAt(0).toUpperCase() + base.slice(1)
  const text = (type === 'math' ? (model as { tex?: string } | undefined)?.tex ?? ''
    : type === 'text' || type === 'code' || type === 'table' ? node.textContent ?? '' : '').replace(/\s+/g, ' ').trim()
  return text ? `${name}: ${text.length > 40 ? text.slice(0, 40) + '…' : text}` : name
}

function uniqueId(label: string, ctx: Ctx): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'object'
  let id = /^[a-z]/.test(slug) ? slug : `o-${slug}`
  for (let n = 2; ctx.ids.has(id); n++) id = `${slug}-${n}`
  ctx.ids.add(id)
  return id
}

/** Presentation attributes copied from computed style, so tools that ignore
 *  <style>/CSS variables/currentColor still see the intended paint. */
const INLINE_SKIP = new Set(['style', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'marker', 'symbol', 'script', 'title', 'desc', 'metadata', 'g', 'svg'])
function inlineComputed(orig: Element, clone: Element, ctx: Ctx): void {
  const tag = orig.localName.toLowerCase()
  if (!INLINE_SKIP.has(tag) && !orig.closest('defs,clipPath,mask,pattern,marker,symbol')) {
    const cs = getComputedStyle(orig)
    const url = (v: string) => v.replace(/url\("?[^"#)]*#([^")]+)"?\)/, 'url(#$1)')
    const setPaint = (attr: string, v: string) => {
      if (/^url\(/.test(v)) { clone.setAttribute(attr, url(v)); return }
      const p = paint(v)
      clone.setAttribute(attr, p?.color ?? 'none')
      if (p && p.alpha < 1) clone.setAttribute(`${attr}-opacity`, num(p.alpha))
      else clone.removeAttribute(`${attr}-opacity`)
    }
    setPaint('fill', cs.fill)
    setPaint('stroke', cs.stroke)
    if (cs.stroke !== 'none') {
      clone.setAttribute('stroke-width', String(parseFloat(cs.strokeWidth) || 0))
      clone.setAttribute('stroke-linecap', cs.strokeLinecap)
      clone.setAttribute('stroke-linejoin', cs.strokeLinejoin)
      if (cs.strokeDasharray && cs.strokeDasharray !== 'none') clone.setAttribute('stroke-dasharray', cs.strokeDasharray.replace(/px/g, ''))
    }
    if (cs.opacity !== '1') clone.setAttribute('opacity', cs.opacity)
    if (tag === 'text' || tag === 'tspan') {
      clone.setAttribute('font-family', concreteFont(cs.fontFamily, ctx))
      clone.setAttribute('font-size', String(parseFloat(cs.fontSize)))
      clone.setAttribute('font-weight', cs.fontWeight)
      if (cs.fontStyle !== 'normal') clone.setAttribute('font-style', cs.fontStyle)
      if (cs.textAnchor !== 'start') clone.setAttribute('text-anchor', cs.textAnchor)
    }
  }
  const a = Array.from(orig.children), b = Array.from(clone.children)
  if (a.length === b.length) a.forEach((o, i) => inlineComputed(o, b[i], ctx))
}

function cloneInlineSvg(node: HTMLElement, w: number, h: number, ctx: Ctx, type: string): string {
  const svg = node.querySelector('svg')
  if (!svg) return ''
  const c = svg.cloneNode(true) as SVGSVGElement
  if (type === 'svg') {
    inlineComputed(svg, c, ctx)
    c.querySelectorAll('style').forEach((n) => n.remove())
  }
  c.querySelectorAll('script,foreignObject').forEach((n) => n.remove())
  // Keep the clipping the canvas applies: an authored <svg> (a hatch whose lines
  // run past its viewBox, say) is overflow:hidden there; only shapes opt in to
  // overflow:visible (strokes, caps, arrowheads past the box).
  const visible = getComputedStyle(svg).overflow === 'visible'
  const prefix = `e${ctx.uid++}-`
  const vb = c.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const plain = !vb || (vb.length === 4 && vb[0] === 0 && vb[1] === 0 && Math.abs(vb[2] - Math.max(w, 1)) < 0.01 && Math.abs(vb[3] - Math.max(h, 1)) < 0.01)
  if (plain && type !== 'chart') {
    // viewBox == box: no scaling, so a plain <g> does the same job as the nested
    // viewport — and shows up as ordinary objects in Inkscape/Illustrator.
    const g = document.createElementNS(SVG_NS, 'g')
    while (c.firstChild) g.appendChild(c.firstChild)
    let clip = ''
    if (!visible) {
      const id = `${prefix}clip`
      clip = `<clipPath id="${id}"><rect width="${num(w)}" height="${num(h)}"/></clipPath>`
      g.setAttribute('clip-path', `url(#${id})`)
    }
    return uniquify(clip + new XMLSerializer().serializeToString(g), prefix).replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')
  }
  c.removeAttribute('style')
  c.setAttribute('x', '0')
  c.setAttribute('y', '0')
  c.setAttribute('width', num(w))
  c.setAttribute('height', num(h))
  c.setAttribute('overflow', visible ? 'visible' : 'hidden')
  if (!c.getAttribute('viewBox')) c.setAttribute('viewBox', `0 0 ${num(w)} ${num(h)}`)
  return uniquify(new XMLSerializer().serializeToString(c), prefix)
}

function imageToSvg(node: HTMLElement, w: number, h: number, ctx: Ctx): string {
  const img = node.querySelector('img')
  if (!img?.src) return ''
  const fit = img.style.objectFit
  const par = fit === 'cover' ? 'xMidYMid slice' : fit === 'fill' ? 'none' : 'xMidYMid meet'
  // cropped (render.ts): the whole picture placed by % inside a clipping box
  const cropBox = img.parentElement?.classList.contains('beeslides-crop') ? img.parentElement : null
  const radius = parseFloat((cropBox ?? img).style.borderRadius) || 0
  let clip = ''
  let open = ''
  if (radius || cropBox) {
    const id = `clip${ctx.uid++}`
    clip = `<clipPath id="${id}"><rect width="${num(w)}" height="${num(h)}" rx="${num(radius)}"/></clipPath>`
    open = ` clip-path="url(#${id})"`
  }
  if (!/^data:/.test(img.src)) ctx.warnings.add(t('An image is linked, not embedded — the SVG refers to it by URL'))
  if (cropBox) {
    const f = (v: string) => (parseFloat(v) || 0) / 100
    const geo = `x="${num(f(img.style.left) * w)}" y="${num(f(img.style.top) * h)}" width="${num(f(img.style.width) * w)}" height="${num(f(img.style.height) * h)}"`
    return `${clip}<g${open}><image href="${esc(img.src)}" xlink:href="${esc(img.src)}" ${geo} preserveAspectRatio="none"/></g>`
  }
  return `${clip}<image href="${esc(img.src)}" xlink:href="${esc(img.src)}" x="0" y="0" width="${num(w)}" height="${num(h)}" preserveAspectRatio="${par}"${open}/>`
}

// ---- tables -----------------------------------------------------------------------------

async function tableToSvg(node: HTMLElement, origin: DOMRect, _ctx: Ctx): Promise<string> {
  let out = ''
  const lines = (r: DOMRect, cs: CSSStyleDeclaration) => {
    const x0 = r.left - origin.left, y0 = r.top - origin.top, x1 = x0 + r.width, y1 = y0 + r.height
    const edge = (side: 'Top' | 'Right' | 'Bottom' | 'Left', a: number, b: number, c: number, d: number) => {
      const bw = parseFloat(cs[`border${side}Width`] as string)
      if (!bw || cs[`border${side}Style`] === 'none') return ''
      return `<line x1="${num(a)}" y1="${num(b)}" x2="${num(c)}" y2="${num(d)}"${fillAttr(cs[`border${side}Color`] as string, 'stroke')} stroke-width="${num(bw)}"/>`
    }
    return edge('Top', x0, y0, x1, y0) + edge('Bottom', x0, y1, x1, y1) + edge('Left', x0, y0, x0, y1) + edge('Right', x1, y0, x1, y1)
  }
  const cells = Array.from(node.querySelectorAll('td,th')) as HTMLElement[]
  for (const cell of cells) {
    const r = cell.getBoundingClientRect()
    const cs = getComputedStyle(cell)
    if (paint(cs.backgroundColor)) {
      out += `<rect x="${num(r.left - origin.left)}" y="${num(r.top - origin.top)}" width="${num(r.width)}" height="${num(r.height)}"${fillAttr(cs.backgroundColor)}/>`
    }
  }
  for (const cell of cells) out += lines(cell.getBoundingClientRect(), getComputedStyle(cell))
  return out
}

// ---- text ---------------------------------------------------------------------------------

interface Run { text: string; left: number; top: number; right: number; bottom: number }

/** Split one text node into per-line runs from the characters' client rects. */
function lineRuns(node: Text): Run[] {
  const runs: Run[] = []
  const range = document.createRange()
  const s = node.data
  let offset = 0
  let cur: Run | null = null
  for (const ch of Array.from(s)) {
    range.setStart(node, offset)
    range.setEnd(node, offset + ch.length)
    offset += ch.length
    const r = range.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue // collapsed whitespace / soft hyphen
    if (ch === '\n' || ch === '\r') continue
    const mid = (r.top + r.bottom) / 2
    if (cur && Math.abs(mid - (cur.top + cur.bottom) / 2) < r.height / 2) {
      cur.text += ch
      cur.right = Math.max(cur.right, r.right)
      cur.left = Math.min(cur.left, r.left)
    } else {
      cur = { text: ch, left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      runs.push(cur)
    }
  }
  return runs
}

async function textToSvg(node: HTMLElement, origin: DOMRect, ctx: Ctx): Promise<string> {
  let out = ''
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const tn = n as Text
    if (!tn.data.trim() && !tn.parentElement?.closest('pre')) continue
    if (tn.parentElement?.closest('math,style,script')) continue
    texts.push(tn)
  }
  const gradient = node.querySelector<HTMLElement>('.beeslides-text-inner')?.style.backgroundImage
  if (gradient) ctx.warnings.add(t('Gradient text is exported with a solid colour'))

  for (const tn of texts) {
    const parent = tn.parentElement!
    const cs = getComputedStyle(parent)
    const size = parseFloat(cs.fontSize)
    const weight = parseInt(cs.fontWeight, 10) || 400
    const italic = cs.fontStyle === 'italic'
    const family = cs.fontFamily
    ctx.measure.font = `${cs.fontStyle} ${weight} ${size}px ${family}`
    const ascent = ctx.measure.measureText('x').fontBoundingBoxAscent ?? size * 0.8
    let color = cs.color
    if (gradient) color = firstStop(gradient) ?? color
    const stroke = parseFloat(cs.getPropertyValue('-webkit-text-stroke-width')) || 0
    const letter = parseFloat(cs.letterSpacing) || 0
    // text-decoration is not inherited — a link's underline (or a <u>
    // around a bold run) lives on an ancestor, and the text inside still
    // shows it
    const deco = decorationOf(parent, node)
    const bgPaint = paint(cs.backgroundColor)
    const first = family.split(',')[0].trim().replace(/^["']|["']$/g, '')
    const font = ctx.fonts ? await ctx.fonts.get(first, weight, italic) : null
    if (ctx.fonts && !font) ctx.warnings.add(t('No readable font file for “{f}” — its text is kept as text', { f: first }))

    // a rich-text link stays a link (sanitized again: this is output)
    const anchor = parent.closest('a[href]')
    const href = anchor && node.contains(anchor) ? sanitizeLinkHref(anchor.getAttribute('href')) : null
    if (href) out += `<a href="${esc(href)}" xlink:href="${esc(href)}">`

    for (const run of lineRuns(tn)) {
      const text = run.text.replace(/\s+$/, '')
      if (!text) continue
      const align = cs.textAlign === 'center' ? 'middle' : cs.textAlign === 'right' || cs.textAlign === 'end' ? 'end' : 'start'
      const x = (align === 'middle' ? (run.left + run.right) / 2 : align === 'end' ? run.right : run.left) - origin.left
      const left = run.left - origin.left
      const base = run.top - origin.top + ascent
      if (bgPaint) {
        out += `<rect x="${num(left)}" y="${num(run.top - origin.top)}" width="${num(run.right - run.left)}" height="${num(run.bottom - run.top)}"${fillAttr(cs.backgroundColor)}/>`
      }
      const strokeAttrs = stroke
        ? `${fillAttr(cs.getPropertyValue('-webkit-text-stroke-color'), 'stroke')} stroke-width="${num(stroke)}" stroke-linejoin="round"`
        : ''
      const decoration = deco ? ` text-decoration="${deco}"` : ''
      if (font) {
        const d = font.getPath(text, left, base, size, { kerning: true, letterSpacing: letter / size }).toPathData(3)
        // paint-order is SVG 2: stroke first, then the fill on top, as two elements
        if (stroke) out += `<path d="${d}" fill="none"${strokeAttrs}/>`
        out += `<path d="${d}"${fillAttr(color)}/>`
        if (deco) out += decorationLine(deco, left, base, run.right - run.left, size, color)
      } else {
        const common =
          `x="${num(x)}" y="${num(base)}" xml:space="preserve" font-family="${esc(concreteFont(family, ctx).replace(/"/g, "'"))}"` +
          ` font-size="${num(size)}" font-weight="${weight}"${italic ? ' font-style="italic"' : ''}` +
          `${align !== 'start' ? ` text-anchor="${align}"` : ''}${letter ? ` letter-spacing="${num(letter)}"` : ''}${decoration}`
        if (stroke) out += `<text ${common} fill="none"${strokeAttrs}>${esc(text)}</text>`
        out += `<text ${common}${fillAttr(color)}>${esc(text)}</text>`
      }
    }
    if (href) out += '</a>'
  }
  out += await listMarkers(node, origin, ctx)

  for (const img of Array.from(node.querySelectorAll('img')).filter((i) => i.closest('.beeslides-text-inner,.beeslides-cell-inner'))) {
    const r = img.getBoundingClientRect()
    out += `<image href="${esc(img.src)}" xlink:href="${esc(img.src)}" x="${num(r.left - origin.left)}" y="${num(r.top - origin.top)}" width="${num(r.width)}" height="${num(r.height)}"/>`
  }
  for (const math of Array.from(node.querySelectorAll('math'))) out += await mathToSvg(math, origin, ctx)
  return out
}

function firstStop(gradient: string): string | undefined {
  return gradient.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i)?.[0]
}

function decorationLine(kind: string, x: number, base: number, width: number, size: number, color: string): string {
  let out = ''
  for (const k of kind.split(/\s+/)) {
    const y = k === 'line-through' ? base - size * 0.3 : k === 'underline' ? base + size * 0.12 : k === 'overline' ? base - size * 0.8 : NaN
    if (Number.isNaN(y)) continue
    out += `<line x1="${num(x)}" y1="${num(y)}" x2="${num(x + width)}" y2="${num(y)}"${fillAttr(color, 'stroke')} stroke-width="${num(Math.max(size / 16, 0.5))}"/>`
  }
  return out
}

/** Every text-decoration line `el` shows: its own and its ancestors' up to
 *  (not including) `stop`, deduplicated — "underline line-through", or ''. */
function decorationOf(el: Element, stop: Element): string {
  const lines = new Set<string>()
  for (let e: Element | null = el; e && e !== stop; e = e.parentElement) {
    const d = getComputedStyle(e).textDecorationLine
    if (d && d !== 'none') for (const k of d.split(/\s+/)) lines.add(k)
  }
  return [...lines].join(' ')
}

// ---- list markers -------------------------------------------------------------------

const ROMAN: Array<[number, string]> = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]

/** The text a CSS list-style-type draws for item `n` (1-based); '' = none. */
export function markerText(type: string, n: number): string {
  const alpha = (k: number): string => { let s = ''; for (; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s; return s }
  const roman = (k: number): string => { let s = ''; for (const [v, r] of ROMAN) for (; k >= v; k -= v) s += r; return s }
  switch (type) {
    case 'none': return ''
    case 'disc': return '•'
    case 'circle': return '◦'
    case 'square': return '▪'
    case 'decimal': return `${n}.`
    case 'decimal-leading-zero': return `${String(n).padStart(2, '0')}.`
    case 'lower-alpha': case 'lower-latin': return `${alpha(n)}.`
    case 'upper-alpha': case 'upper-latin': return `${alpha(n).toUpperCase()}.`
    case 'lower-roman': return n > 0 && n < 4000 ? `${roman(n)}.` : `${n}.`
    case 'upper-roman': return n > 0 && n < 4000 ? `${roman(n).toUpperCase()}.` : `${n}.`
    default: return /^(disc|circle|square)$/.test(type) ? '•' : `${n}.`
  }
}

const SYMBOL_MARKERS: Record<string, 'disc' | 'circle' | 'square'> = { disc: 'disc', circle: 'circle', square: 'square' }

/** Rich-text list markers: ::marker has no text node and no Range, so it is
 *  re-drawn from the item's list-style-type and number, right-aligned a
 *  space before the item's first line (Chrome's outside marker is the glyph
 *  followed by a space), on that line's baseline, in the marker's style. */
async function listMarkers(node: HTMLElement, origin: DOMRect, ctx: Ctx): Promise<string> {
  let out = ''
  for (const li of Array.from(node.querySelectorAll('li'))) {
    if (!li.closest('.beeslides-text-inner,.beeslides-cell-inner')) continue
    const cs = getComputedStyle(li)
    // (not visibility: the whole export host is visibility:hidden)
    if (cs.display !== 'list-item') continue
    const items = Array.from(li.parentElement?.children ?? []).filter((c) => c.tagName === 'LI')
    const text = markerText(cs.listStyleType, items.indexOf(li) + 1)
    if (!text) continue
    const ms = getComputedStyle(li, '::marker')
    const size = parseFloat(ms.fontSize) || parseFloat(cs.fontSize)
    const weight = parseInt(ms.fontWeight || cs.fontWeight, 10) || 400
    const italic = (ms.fontStyle || cs.fontStyle) === 'italic'
    const family = ms.fontFamily || cs.fontFamily
    const color = ms.color || cs.color
    ctx.measure.font = `${italic ? 'italic' : 'normal'} ${weight} ${size}px ${family}`
    const ascent = ctx.measure.measureText('x').fontBoundingBoxAscent ?? size * 0.8
    const space = ctx.measure.measureText(' ').width
    const width = ctx.measure.measureText(text).width
    const base = firstLineBaseline(li, ctx) ?? (() => {
      // an empty item: its first line box, half-leading included
      const r = li.getBoundingClientRect()
      const desc = ctx.measure.measureText('x').fontBoundingBoxDescent ?? size * 0.2
      const lh = parseFloat(cs.lineHeight) || (ascent + desc)
      return r.top + (lh - (ascent + desc)) / 2 + ascent
    })()
    const r = li.getBoundingClientRect()
    const rtl = cs.direction === 'rtl'
    const start = rtl
      ? r.right - (parseFloat(cs.borderRightWidth) || 0) - (parseFloat(cs.paddingRight) || 0)
      : r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0)
    // the glyph's own box, left to right, in figure coordinates
    const left = (rtl ? start + space : start - space - width) - origin.left
    const y = base - origin.top
    const symbol = SYMBOL_MARKERS[cs.listStyleType]
    if (symbol) {
      // Chrome paints these as shapes, not glyphs: about a third of the
      // ascent across, centred a third of the ascent above the baseline
      const d = Math.max(1, ascent / 3)
      const cx = (rtl ? start + space + d / 2 : start - space - d / 2) - origin.left
      const cy = y - ascent / 3
      out += symbol === 'square'
        ? `<rect x="${num(cx - d / 2)}" y="${num(cy - d / 2)}" width="${num(d)}" height="${num(d)}"${fillAttr(color)}/>`
        : symbol === 'circle'
          ? `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(d / 2 - d / 16)}" fill="none"${fillAttr(color, 'stroke')} stroke-width="${num(d / 8)}"/>`
          : `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(d / 2)}"${fillAttr(color)}/>`
      continue
    }
    const first = family.split(',')[0].trim().replace(/^["']|["']$/g, '')
    const font = ctx.fonts ? await ctx.fonts.get(first, weight, italic) : null
    if (font) {
      out += `<path d="${font.getPath(text, left, y, size, { kerning: true }).toPathData(3)}"${fillAttr(color)}/>`
    } else {
      // anchored at the edge that faces the item, so a renderer whose font
      // measures the marker differently still keeps the gap to the words
      const x = rtl ? left : left + width
      out += `<text x="${num(x)}" y="${num(y)}" text-anchor="${rtl ? 'start' : 'end'}" font-family="${esc(concreteFont(family, ctx).replace(/"/g, "'"))}"` +
        ` font-size="${num(size)}" font-weight="${weight}"${italic ? ' font-style="italic"' : ''}${fillAttr(color)}>${esc(text)}</text>`
    }
  }
  return out
}

/** The client-space baseline of `li`'s first line: its first visible
 *  character outside a nested list, plus that run's font ascent. */
function firstLineBaseline(li: HTMLElement, ctx: Ctx): number | null {
  const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const tn = n as Text
    const holder = tn.parentElement
    if (!holder || holder.closest('ul,ol') !== li.parentElement) continue
    const run = lineRuns(tn)[0]
    if (!run) continue
    const cs = getComputedStyle(holder)
    ctx.measure.font = `${cs.fontStyle} ${parseInt(cs.fontWeight, 10) || 400} ${parseFloat(cs.fontSize)}px ${cs.fontFamily}`
    return run.top + (ctx.measure.measureText('x').fontBoundingBoxAscent ?? parseFloat(cs.fontSize) * 0.8)
  }
  return null
}

// ---- math ---------------------------------------------------------------------------------

async function mathToSvg(math: Element, origin: DOMRect, ctx: Ctx): Promise<string> {
  const r = math.getBoundingClientRect()
  const color = getComputedStyle(math).color
  const x = r.left - origin.left, y = r.top - origin.top
  const tex = math.getAttribute('data-tex')
  if (ctx.mathJax && tex) {
    try {
      const display = math.getAttribute('display') === 'block'
      const host = ctx.mathJax.tex2svg(tex, { display }) as HTMLElement
      const svg = host.querySelector('svg')
      const vb = svg?.getAttribute('viewBox')?.split(/\s+/).map(Number)
      if (svg && vb && vb.length === 4) {
        // MathJax: 1000 viewBox units = 1em
        const size = parseFloat(getComputedStyle(math).fontSize)
        const sw = (vb[2] / 1000) * size, sh = (vb[3] / 1000) * size
        const c = svg.cloneNode(true) as SVGSVGElement
        c.removeAttribute('style')
        c.removeAttribute('role')
        c.removeAttribute('focusable')
        c.removeAttribute('aria-hidden')
        c.setAttribute('x', num(x + (r.width - sw) / 2))
        c.setAttribute('y', num(y + (r.height - sh) / 2))
        c.setAttribute('width', num(sw))
        c.setAttribute('height', num(sh))
        c.setAttribute('overflow', 'visible')
        const p = paint(color)
        c.setAttribute('color', p?.color ?? '#000')
        return uniquify(new XMLSerializer().serializeToString(c), `m${ctx.uid++}-`)
      }
    } catch { /* fall through to MathML */ }
  }
  // Fallback: the MathML itself (renders in Chromium/Firefox, not in most vector tools)
  ctx.warnings.add(t('Some math is kept as MathML (not converted to paths) — vector editors such as Inkscape and Illustrator will not show it'))
  const ml = new XMLSerializer().serializeToString(math)
  return `<foreignObject x="${num(x)}" y="${num(y)}" width="${num(r.width + 2)}" height="${num(r.height + 2)}"><div xmlns="http://www.w3.org/1999/xhtml" style="color:${esc(color)};font-size:${getComputedStyle(math).fontSize}">${ml}</div></foreignObject>`
}
