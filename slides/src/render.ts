// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Shared model → DOM renderer. One code path draws slides everywhere:
// editor canvas, sidebar thumbnails, and Reveal.js sections.

import { offlineEnabled, isRemoteUrl, remoteSrcBlocked } from '../../kernel/src/net.ts'
import type { FooterRole, ImageElement, ReflectionSpec, SlidomingoDoc, ShapeElement, Slide, SlideElement, SvgElement, TableElement } from './model'
import { tableLayout } from './tablespans'
import { ancestorChain, footerHidden, morphKey, normalizeCrop, paginates, docLanguage, termText, svgVarValue, SVG_VAR_NAME } from './model'
import { chartSnapshotSvg } from './charts'
import { blobUrlFor } from './bloburls'
import { renderMath, renderTex } from './math'
import { renderCodeInto } from './code'
import { t } from './i18n'
import { PALETTE_SLOTS, paletteOf } from './palette.ts'
import type { ZoomElement } from './model'
import { zoomCover } from './model'
import { zoomTileRect } from './zoom'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface RenderOpts {
  /** static output only: draw motion-path routes as a faint dotted trail */
  stillTrails?: boolean
  /** render svg elements as <img> (cheap DOM) — used by thumbnails */
  svgAsImage?: boolean
  /** hide empty placeholder text entirely — present mode and print */
  hidePlaceholders?: boolean
  /** media (video/audio) accepts pointer input — PRESENT only. On the editor
   *  canvas it stays inert so its native controls don't swallow selection. */
  liveMedia?: boolean
  /** render `embed` as the inert placeholder instead of mounting its
   *  sandboxed iframe — same idea as svgAsImage but independent of it: the
   *  full-fidelity static layer wants real inline svg (not flattened to
   *  <img>) while still never mounting a live, scripted embed. */
  inertEmbed?: boolean
  /** render `media` as the cheap poster/icon still instead of a real
   *  <video>/<audio> element — the static layer's size-budget fallback tier
   *  (embedded video is its single biggest byte cost), independent of
   *  svgAsImage/inertEmbed so svg/embed can stay full-fidelity while only
   *  media degrades. */
  staticMediaStill?: boolean
  /** keep embedded bytes as the document's own `data:` URIs instead of the
   *  live page's cached `blob:` URLs (bloburls.ts). REQUIRED for any output
   *  that leaves this page — the static layer and preview written into the
   *  saved file, the speaker view's window, print — because a blob URL means
   *  nothing anywhere else. */
  inlineData?: boolean
  /** dynamic-field values ({{page}} etc.) for this slide; auto-filled by renderSlide */
  fields?: FieldContext
  /** Editor-only: make live fields recognisable (`resolveFields`' marker
   *  mode). On a slide the value is wrapped in a tinted `.sl-field`; on a
   *  slide-type surface the field's NAME shows instead ("‹Page›"), since a
   *  sample value there looks exactly like typed text. renderSlide picks
   *  which from the surface; never set for output that leaves the editor. */
  fieldMarkers?: boolean | 'value' | 'name'
  /** the governing master's cascading font pair for this slide; auto-filled
   *  by renderSlide (resolves `slide.masterId`, or the layout's masterId
   *  when `slide` IS a `doc.layouts` entry, or `doc.masters?.[0]`) — see
   *  `renderElement`'s font fallback chain. */
  fonts?: { fontFamily?: string; headingFamily?: string }
  /** Editor-only: ids to render dimmed/inert — "this is context, not what
   *  you're editing right now." Never set outside the Layout Manager. */
  ghostIds?: Set<string>
  /** Editor-only: ids to render with a "locked" cursor, no opacity/pointer-
   *  events change — the slide-type direction's building-block elements. */
  lockedCursorIds?: Set<string>
  /** Editor canvas only: elements with `hidden` are still emitted (tagged
   *  `.beeslides-el-hidden`, which the stylesheet collapses) so the Select
   *  menu can reach and unhide them. Every other output omits them. */
  showHidden?: boolean
  /** Editor canvas only: empty parts of shapes/text boxes stop catching
   *  pointer events (`data-hit="paint"`), so clicks reach what is underneath. */
  paintHit?: boolean
  /** Surface box size, in px — overrides `doc.size` for the rendered
   *  `.beeslides-slide` surface (which clips overflow: hidden). Used by the
   *  reusable-object editing surface, whose authoring canvas is much bigger
   *  than the deck's own slide size; omitted everywhere else, where the
   *  surface is simply the deck's page. */
  size?: { width: number; height: number }
  /** How many zoom tiles deep this render is (render.ts `case 'zoom'`): a
   *  tile renders its cover slide nested at depth + 1, and a tile met at
   *  depth >= 1 is drawn as a still box, so a tile can never recurse. */
  zoomDepth?: number
  /** editor preview (Layout Manager): {{term:…}} and dates in this language
   *  instead of the document's. No output path may set it. */
  language?: string
}

/** Values dynamic field tokens resolve against, computed per slide. */
export interface FieldContext {
  page: number; pages: number; title: string; date: Date
  author: string; company: string; subject: string; event: string
  /** `doc.headerFooter.footer.text`, for {{footer}} */
  footer?: string
  /** `doc.headerFooter.date.fixed` — {{date}} shows this instead of today */
  dateFixed?: string
  /** `doc.meta.custom`, for {{prop:Name}} */
  props?: Record<string, string>
  /** the document language (`model.docLanguage`): formats {{date}}/{{time}};
   *  absent = the viewer's locale */
  language?: string
  /** {{term:Name}} in the document language (`model.termText`) */
  term?: (name: string) => string
}

/** Field context for a slide: page = 1-based position among non-state slides. */
export function fieldContext(doc: SlidomingoDoc, slide: Slide, language = docLanguage(doc)): FieldContext {
  const idx = doc.slides.indexOf(slide)
  const upto = idx < 0 ? doc.slides : doc.slides.slice(0, idx + 1)
  const m = doc.meta ?? {}
  return {
    page: upto.filter((s) => paginates(s, doc)).length,
    pages: doc.slides.filter((s) => paginates(s, doc)).length,
    title: doc.title,
    date: new Date(),
    author: m.author ?? '',
    company: m.company ?? '',
    subject: m.subject ?? '',
    event: m.event ?? '',
    footer: doc.headerFooter?.footer?.text ?? '',
    dateFixed: doc.headerFooter?.date?.fixed || undefined,
    props: m.custom ?? {},
    language,
    term: (name) => termText(doc, name, language),
  }
}

/** What a field is called where its name shows instead of a value (a slide
 *  type in the editor) — PowerPoint's ‹#› on a master, spelled out. */
const FIELD_NAMES: Record<string, string> = {
  page: 'Page', pages: 'Pages', title: 'Title', date: 'Date', time: 'Time',
  author: 'Author', company: 'Company', subject: 'Subject', event: 'Event', footer: 'Footer',
}

/** A locale `toLocale*String` accepts, else the viewer's (a bad code in a
 *  file must not throw out of every render). */
const fieldLocale = (lang?: string): string | undefined => {
  if (!lang) return undefined
  try { return Intl.DateTimeFormat.supportedLocalesOf([lang]).length ? lang : undefined } catch { return undefined }
}

const escapeFieldText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Resolve dynamic field tokens in text: {{page}}, {{pages}}, {{title}},
 * {{date}}, {{time}}, plus the document-property fields {{author}}, {{company}},
 * {{subject}}, {{event}}, the footer text {{footer}} and custom properties
 * {{prop:Name}}, and translated terms {{term:Name}} (`doc.terms`, in the
 * document language — which also formats date and time). page/pages take an optional zero-pad width — {{page:2}}
 * → "06". The MODEL stores the raw token; only rendered output is resolved, so
 * inserting/removing slides re-numbers everything and editing doc properties
 * updates every slide automatically. Groundwork for the wider office suite.
 *
 * `markers` (editor only): 'value' wraps each resolved value in
 * `<span class="sl-field" data-field="…">`, 'name' puts the field's name
 * there instead ("‹Page›"). Marker output is markup, so it must be applied
 * AFTER sanitizing (renderElement does); the values stay escaped.
 */
export function resolveFields(html: string, ctx?: FieldContext, markers?: 'value' | 'name'): string {
  if (!ctx || html.indexOf('{{') < 0) return html
  const pad = (n: number, arg?: string) => { const w = parseInt(arg ?? '', 10); return w > 0 ? String(n).padStart(w, '0') : String(n) }
  return html.replace(/\{\{\s*(page|pages|title|date|time|author|company|subject|event|footer|prop|term)(?::([^}]*))?\s*\}\}/gi, (_m, raw: string, arg?: string) => {
    const name = raw.toLowerCase()
    const value = (() => {
      switch (name) {
        case 'page': return pad(ctx.page, arg)
        case 'pages': return pad(ctx.pages, arg)
        case 'title': return escapeFieldText(ctx.title)
        case 'date': return escapeFieldText(ctx.dateFixed ?? ctx.date.toLocaleDateString(fieldLocale(ctx.language)))
        case 'time': return escapeFieldText(ctx.date.toLocaleTimeString(fieldLocale(ctx.language) ?? [], { hour: '2-digit', minute: '2-digit' }))
        case 'author': return escapeFieldText(ctx.author)
        case 'company': return escapeFieldText(ctx.company)
        case 'subject': return escapeFieldText(ctx.subject)
        case 'event': return escapeFieldText(ctx.event)
        case 'footer': return escapeFieldText(ctx.footer ?? '')
        case 'prop': return escapeFieldText(ctx.props?.[(arg ?? '').trim()] ?? '')
        case 'term': return escapeFieldText(ctx.term?.((arg ?? '').trim()) ?? (arg ?? '').trim())
        default: return ''
      }
    })()
    if (!markers) return value
    const named = name === 'prop' || name === 'term'
    const key = named ? `${name}:${(arg ?? '').trim()}` : name
 // a term shows its WORD even on a slide type: the template author
    // checks there that "Seite 12 von 140" still fits
    const shown = markers === 'name' && name !== 'term'
      ? `\u2039${escapeFieldText(named ? (arg ?? '').trim() : t(FIELD_NAMES[name] ?? name))}\u203A`
      : value
    return `<span class="sl-field" data-field="${escapeFieldText(key).replace(/"/g, '&quot;')}">${shown}</span>`
  })
}

/** Resolve "asset:<key>" references against the document's asset table. */
export function resolveAsset(doc: SlidomingoDoc, ref: string): string {
  return ref.startsWith('asset:') ? (doc.assets?.[ref.slice(6)] ?? '') : ref
}

/**
 * The src to actually put on an element, or '' when offline mode must not let
 * it out. Media and images are loaded by the BROWSER from a src attribute,
 * not by us from a fetch — so no wrapper around fetch() can see them, and a
 * deck's remote <video> sailed straight through the offline switch
 * (GHSA-5c3x-xqp6-g94r: measured, 4 requests). A remote src in a document is
 * also a tracking beacon, and offline mode is exactly what a careful reader
 * turns on before opening a deck they do not trust.
 *
 * Callers must OMIT the attribute rather than set it to '', because
 * `video.src = ''` resolves against the page and makes browsers request the
 * document's own URL — a blank src is a request, not the absence of one.
 */
export function assetSrc(doc: SlidomingoDoc, ref: string, inlineData = false): string {
  const url = resolveAsset(doc, ref)
  if (remoteSrcBlocked(url)) return ''
  return inlineData ? url : blobUrlFor(url)
}

/** Attributes a browser will go to the network for, all element types. */
const URL_ATTRS = ['src', 'href', 'xlink:href', 'poster', 'srcset', 'data'] as const

/**
 * Last line of defence for offline mode: strip every remote reference from a
 * rendered subtree.
 *
 * assetSrc covers the srcs the RENDERER emits, but author content is markup —
 * an svg's `<image href="https://…">` (which the sanitizer allows on purpose,
 * because it is a legitimate picture), an `<img>` inside a text box or a table
 * cell — and that markup is injected as HTML without passing through any of
 * our src helpers. A browser fetches those the moment they are in the
 * document. No wrapper around fetch() can see it and no allowlist can, since
 * the markup is perfectly legitimate; the only question offline mode asks is
 * where it POINTS.
 *
 * A remote reference in a document you were sent is also the cheapest tracking
 * beacon there is, and offline mode is precisely what a careful reader turns
 * on before opening one.
 */
export function stripRemoteRefs(node: HTMLElement): void {
  if (!offlineEnabled()) return
  const all = [node, ...node.querySelectorAll<HTMLElement>('*')]
  for (const e of all) {
    for (const a of URL_ATTRS) {
      const v = e.getAttribute?.(a)
      if (v && isRemoteUrl(v)) {
        e.removeAttribute(a)
        e.dataset.beeslidesOffline = '1'
      }
    }
  }
}

function svgMarkup(el: SvgElement, doc: SlidomingoDoc): string {
  return (el.asset ? doc.assets?.[el.asset] : el.markup) ?? ''
}

/**
 * Scope injected svg CSS to one element instance. svg <style> applies
 * document-wide, so unscoped rules from one diagram would leak into every
 * other svg on the page (including other slides' copies of the same asset).
 * @keyframes blocks stay top-level; everything else gets the scope prefix.
 */
export function scopeCss(css: string, scope: string): string {
  let out = ''
  let i = 0
  while (i < css.length) {
    const rest = css.slice(i)
    const at = rest.match(/^\s*@(keyframes|-webkit-keyframes)/)
    if (at) {
      // copy the whole block verbatim, tracking brace depth
      let depth = 0
      let j = i
      let seen = false
      while (j < css.length) {
        if (css[j] === '{') { depth++; seen = true }
        if (css[j] === '}') { depth--; if (seen && depth === 0) { j++; break } }
        j++
      }
      out += css.slice(i, j) + '\n'
      i = j
      continue
    }
    const open = css.indexOf('{', i)
    if (open === -1) break
    const close = css.indexOf('}', open)
    if (close === -1) break
    const selectors = css.slice(i, open).trim()
    if (selectors) {
      out += selectors.split(',').map((s) => `${scope} ${s.trim()}`).join(', ')
      out += ' ' + css.slice(open, close + 1) + '\n'
    }
    i = close + 1
  }
  return out
}

/** An svg's `vars` as custom-property declarations (`--leaf`, `#3a7d2c`), each re-judged. */
export function svgVarDecls(el: SvgElement): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [k, raw] of Object.entries(el.vars ?? {})) {
    const v = svgVarValue(raw)
    if (SVG_VAR_NAME.test(k) && v !== undefined) out.push([`--${k}`, String(v)])
  }
  return out
}

/** CSS `-webkit-box-reflect` value for a reflection ('none' clears it). */
export function reflectionCss(r: ReflectionSpec | undefined): string {
  if (!r) return 'none'
  const opacity = Math.min(Math.max(r.opacity ?? 0.35, 0), 1)
  const size = Math.min(Math.max(r.size ?? 0.5, 0), 1)
  const gap = r.gap ?? 0
  return `below ${gap}px linear-gradient(transparent ${Math.round((1 - size) * 100)}%, rgba(0,0,0,${opacity}))`
}

/** A fraction as a CSS percentage, rounded so saved markup stays short. */
const pct = (f: number) => `${Math.round(f * 1e6) / 1e4}%`

/** Whether `el` is one of the types that can be mirrored (see model.ts `Flippable`). */
export const canFlip = (el: SlideElement): el is ShapeElement | ImageElement | SvgElement =>
  el.type === 'shape' || el.type === 'image' || el.type === 'svg'

/**
 * Mirror the element's CONTENT (its child layer), leaving the frame's own
 * transform — rotate(), and whatever anim/morph compose on top — untouched.
 * Called from applyElementFrame (live restyling) and again by renderElement
 * once the children exist.
 */
export function applyFlip(node: HTMLElement, el: SlideElement) {
  if (!canFlip(el)) return
  const tf = el.flipH || el.flipV ? `scale(${el.flipH ? -1 : 1}, ${el.flipV ? -1 : 1})` : ''
  for (const child of Array.from(node.children)) (child as HTMLElement).style.transform = tf
}

export function applyElementFrame(node: HTMLElement, el: SlideElement) {
  node.style.left = `${el.x}px`
  node.style.top = `${el.y}px`
  node.style.width = `${el.w}px`
  node.style.height = `${el.h}px`
  node.style.transform = el.rotation ? `rotate(${el.rotation}deg)` : ''
  node.style.opacity = String(el.opacity)
  const shadows = Array.isArray(el.shadow) ? el.shadow : el.shadow ? [el.shadow] : []
  const parts = shadows.map((s) => `drop-shadow(${s.x ?? 0}px ${s.y ?? 0}px ${s.blur}px ${s.color})`)
  if (el.blur) parts.push(`blur(${el.blur}px)`)
  node.style.filter = parts.length ? parts.join(' ') : ''
  node.style.mixBlendMode = el.blend || ''
  // Not in the CSSStyleDeclaration typings, and Firefox has no equivalent —
  // there the element just renders without its reflection.
  node.style.setProperty('-webkit-box-reflect', reflectionCss(el.reflection))
  applyFlip(node, el)
  if (el.backdropFilter) {
    const bf = `blur(${el.backdropFilter}px)`
    node.style.backdropFilter = bf
    node.style.setProperty('-webkit-backdrop-filter', bf)
  } else {
    node.style.backdropFilter = ''
  }
}

// Gradient ids must be unique per rendered instance: the same element renders
// on the canvas, in sidebar thumbnails and in the present overlay, and svg
// url(#…) references resolve document-wide.
let gradSeq = 0

/** Gradient line endpoints (objectBoundingBox units) for a CSS-convention
 *  angle: 0deg points up, 90deg points right. Shared with morph tweening. */
export function gradientLineCoords(angle: number) {
  const rad = ((angle ?? 180) * Math.PI) / 180
  const dx = Math.sin(rad) / 2
  const dy = -Math.cos(rad) / 2
  return { x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy }
}

/** CSS linear-gradient() from a GradientFill. CSS angle convention matches the
 *  model (0deg = bottom->top, 90deg = left->right), so pass angle straight. */
export function cssLinearGradient(g: NonNullable<ShapeElement['fillGradient']>): string {
  const stops = g.stops
    .map((s) => `${s.color} ${Math.round(Math.min(Math.max(s.at, 0), 1) * 100)}%`)
    .join(', ')
  return `linear-gradient(${g.angle}deg, ${stops})`
}

/** Materialize a GradientFill as a <defs> gradient; returns its url() ref. */
function gradientRef(svg: SVGSVGElement, g: NonNullable<ShapeElement['fillGradient']>): string {
  const id = `beeslides-grad-${gradSeq++}`
  const defs = document.createElementNS(SVG_NS, 'defs')
  const lin = document.createElementNS(SVG_NS, 'linearGradient')
  lin.setAttribute('id', id)
  const { x1, y1, x2, y2 } = gradientLineCoords(g.angle)
  lin.setAttribute('x1', String(x1))
  lin.setAttribute('y1', String(y1))
  lin.setAttribute('x2', String(x2))
  lin.setAttribute('y2', String(y2))
  for (const s of g.stops) {
    const stop = document.createElementNS(SVG_NS, 'stop')
    stop.setAttribute('offset', String(Math.min(Math.max(s.at, 0), 1)))
    stop.setAttribute('stop-color', s.color)
    lin.appendChild(stop)
  }
  defs.appendChild(lin)
  svg.appendChild(defs)
  return `url(#${id})`
}

/** stroke-dasharray for the element's line style (undefined = solid). */
function dashArray(el: ShapeElement, w: number): string | undefined {
  if (el.strokeStyle === 'dashed') return `${Math.max(w * 2.4, 7)} ${Math.max(w * 1.8, 5)}`
  if (el.strokeStyle === 'dotted') return `0.1 ${Math.max(w * 2.2, 5)}`
  if (el.strokeStyle === 'solid') return undefined
  if (el.strokeDash) return `${el.strokeDash} ${el.strokeDash}` // legacy numeric dash
  return undefined
}

let markSeq = 0

/** A line-tip marker in <defs>; sized in strokeWidth units, colored like the line. */
function markerRef(svg: SVGSVGElement, kind: NonNullable<ShapeElement['lineStart']>, color: string, start: boolean): string | null {
  if (kind === 'none') return null
  const id = `beeslides-mark-${markSeq++}`
  const marker = document.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', id)
  marker.setAttribute('viewBox', '0 0 8 8')
  marker.setAttribute('refY', '4')
  marker.setAttribute('orient', start ? 'auto-start-reverse' : 'auto')
  marker.setAttribute('markerWidth', '5.5')
  marker.setAttribute('markerHeight', '5.5')
  let tip: SVGElement
  if (kind === 'arrow') {
    tip = document.createElementNS(SVG_NS, 'path')
    tip.setAttribute('d', 'M 0 0.4 L 7.6 4 L 0 7.6 Z')
    marker.setAttribute('refX', '6.4')
  } else if (kind === 'dot') {
    tip = document.createElementNS(SVG_NS, 'circle')
    tip.setAttribute('cx', '4')
    tip.setAttribute('cy', '4')
    tip.setAttribute('r', '2.6')
    marker.setAttribute('refX', '4')
  } else {
    tip = document.createElementNS(SVG_NS, 'rect')
    tip.setAttribute('x', '3.2')
    tip.setAttribute('y', '0.4')
    tip.setAttribute('width', '1.6')
    tip.setAttribute('height', '7.2')
    marker.setAttribute('refX', '4')
  }
  tip.setAttribute('fill', color)
  marker.appendChild(tip)
  let defs = svg.querySelector('defs')
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs')
    svg.appendChild(defs)
  }
  defs.appendChild(marker)
  return `url(#${id})`
}

/** Near-full-slide element (photo, scrim, imported background): treated as
 *  scenery rather than something a click on "empty" slide area should grab. */
export function isBackdrop(el: { w: number; h: number }, size: { width: number; height: number }): boolean {
  return el.w * el.h >= size.width * size.height * 0.8
}

/** A shape whose interior paints nothing (lines, curves, outline-only
 *  rects/ellipses): only its stroke should catch clicks in the editor. */
function isUnfilledShape(el: ShapeElement): boolean {
  if (el.shape === 'line') return true
  if (el.fillGradient?.stops.length) return false
  const f = (el.fill ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (!f || f === 'none' || f === 'transparent') return true
  if (/^#[0-9a-f]{8}$/.test(f)) return f.slice(7) === '00'
  if (/^#[0-9a-f]{4}$/.test(f)) return f[4] === '0'
  const m = /^rgba?\([^)]*,(0|0?\.0+)\)$/.exec(f)
  return !!m
}

export function shapeSvg(el: ShapeElement): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const { w, h } = el
  const sw = el.strokeWidth
  const inset = sw / 2
  svg.setAttribute('viewBox', `0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible'

  let node: SVGElement
  switch (el.shape) {
    case 'path': {
      // arbitrary vector data, stretched from its authored viewBox into the box
      if (el.pathBox) svg.setAttribute('viewBox', el.pathBox.join(' '))
      node = document.createElementNS(SVG_NS, 'path')
      node.setAttribute('d', el.d ?? '')
      if (sw > 0) node.setAttribute('vector-effect', 'non-scaling-stroke')
      if (el.fillRule === 'evenodd') node.setAttribute('fill-rule', 'evenodd')
      if (el.strokeCap) node.setAttribute('stroke-linecap', el.strokeCap)
      if (el.strokeJoin) node.setAttribute('stroke-linejoin', el.strokeJoin)
      break
    }
    case 'rect': {
      node = document.createElementNS(SVG_NS, 'rect')
      node.setAttribute('x', String(inset))
      node.setAttribute('y', String(inset))
      node.setAttribute('width', String(Math.max(w - sw, 0)))
      node.setAttribute('height', String(Math.max(h - sw, 0)))
      // the stroke is inset by sw/2, so the corner radius shrinks with it —
      // the border's OUTER edge keeps the radius the user set
      if (el.radius) node.setAttribute('rx', String(Math.max(el.radius - inset, 0)))
      break
    }
    case 'ellipse': {
      node = document.createElementNS(SVG_NS, 'ellipse')
      node.setAttribute('cx', String(w / 2))
      node.setAttribute('cy', String(h / 2))
      node.setAttribute('rx', String(Math.max(w / 2 - inset, 0)))
      node.setAttribute('ry', String(Math.max(h / 2 - inset, 0)))
      break
    }
    case 'triangle': {
      node = document.createElementNS(SVG_NS, 'polygon')
      node.setAttribute('points', `${w / 2},${inset} ${w - inset},${h - inset} ${inset},${h - inset}`)
      break
    }
    case 'arrow': {
      // right-pointing arrow: shaft + head, proportional to the box, inset by
      // sw/2 like rect/ellipse/triangle so the border stays inside the box
      node = document.createElementNS(SVG_NS, 'polygon')
      const iw = Math.max(w - sw, 0), ih = Math.max(h - sw, 0)
      const shaftH = ih * 0.44
      const headW = Math.min(iw * 0.38, ih)
      const x0 = inset, x1 = inset + iw, xh = x1 - headW
      const y0 = inset + (ih - shaftH) / 2, y1 = y0 + shaftH
      node.setAttribute(
        'points',
        `${x0},${y0} ${xh},${y0} ${xh},${inset} ${x1},${h / 2} ${xh},${inset + ih} ${xh},${y1} ${x0},${y1}`,
      )
      break
    }
    case 'line': {
      node = document.createElementNS(SVG_NS, 'line')
      const lw = Math.max(sw, 2)
      // inset the endpoints so tip decorations sit inside the element box
      const tipPad = (k?: string) => (k && k !== 'none' ? lw * 2.6 : 0)
      node.setAttribute('x1', String(tipPad(el.lineStart)))
      node.setAttribute('y1', String(h / 2))
      node.setAttribute('x2', String(w - tipPad(el.lineEnd)))
      node.setAttribute('y2', String(h / 2))
      node.setAttribute('stroke', el.fill)
      node.setAttribute('stroke-width', String(lw))
      node.setAttribute('stroke-linecap', el.strokeCap ?? (el.strokeStyle === 'dashed' ? 'butt' : 'round'))
      const lineDash = dashArray(el, lw)
      if (lineDash) node.setAttribute('stroke-dasharray', lineDash)
      const mStart = el.lineStart ? markerRef(svg, el.lineStart, el.fill, true) : null
      const mEnd = el.lineEnd ? markerRef(svg, el.lineEnd, el.fill, false) : null
      if (mStart) node.setAttribute('marker-start', mStart)
      if (mEnd) node.setAttribute('marker-end', mEnd)
      svg.appendChild(node)
      return svg
    }
  }
  node.setAttribute('fill', el.fillGradient?.stops.length ? gradientRef(svg, el.fillGradient) : el.fill)
  if (el.stroke && el.stroke !== 'transparent' && sw > 0) {
    node.setAttribute('stroke', el.stroke)
    node.setAttribute('stroke-width', String(sw))
    const dash = dashArray(el, sw)
    if (dash) node.setAttribute('stroke-dasharray', dash)
    if (el.strokeStyle === 'dotted') node.setAttribute('stroke-linecap', 'round')
  }
  svg.appendChild(node)
  return svg
}

// --- math ($…$ → MathML) -----------------------------------------------------

/**
 * LaTeX math in text, resolved at RENDER time — the same trick resolveFields
 * uses for {{page}}. The MODEL stores the raw source (`$E=mc^2$`), so the
 * format gains nothing to version: an older build opening a newer file shows
 * the literal `$E=mc^2$` — degraded, legible, and nothing is lost. The Temml
 * side (cache, entity decoding, symbol tagging) lives in math.ts, shared with
 * the `math` element.
 *
 * MUST run AFTER sanitizeHtml, never before: the sanitizer unwraps every tag
 * outside its allowlist and strips all attributes, so it would demolish the
 * MathML. Running after is also why the allowlist needs no widening — this
 * markup is GENERATED by us from LaTeX source, never accepted from the author.
 */
export function resolveMath(html: string): string {
  if (html.indexOf('$') < 0) return html
  // $$…$$ first (display), then $…$ (inline). The inline form is deliberately
  // fussy so ordinary prose survives: no whitespace just inside the delimiters
  // and no digit straight after the closer, which is what keeps "it costs $5
  // and $10" from parsing as math. A backslash-escaped \$ is a literal dollar.
  let out = html.replace(/(^|[^\\])\$\$([^$]+?)\$\$/g, (m, pre: string, src: string) => {
    const ml = renderMath(src, true)
    return ml ? pre + ml : m
  })
  out = out.replace(/(^|[^\\$])\$(\S(?:[^$\n]*?\S)?)\$(?!\d)/g, (m, pre: string, src: string) => {
    const ml = renderMath(src, false)
    return ml ? pre + ml : m
  })
  return out.replace(/\\\$/g, '$') // the escape has done its job
}

// --- rich text ----------------------------------------------------------------
//
// Text element and table cell `html` is the one place author markup reaches
// the page as markup on EVERY surface (canvas, thumbnails, present, print, the
// static layer, the preview). Rich text phase 1 (DECISIONS 2026-10-08) widened
// it from b/i/u/s/code to coloured and sized runs, links and real lists — so
// the sanitizer is a STRICT ALLOWLIST at three levels, and nothing an author
// wrote is ever passed through as written:
//
//   * tags: RICH_TAGS below. Anything else is unwrapped (its text stays) or,
//     for the raw-text carriers in RICH_DROP, removed whole.
//   * attributes: per tag. `a` keeps `href`, `span` keeps `style`; every
//     other attribute on every element is removed.
//   * values: an href is PARSED (sanitizeLinkHref) and a style is PARSED
//     (sanitizeRunStyle), then each is re-serialised from the parsed parts.
//     A value that does not parse is dropped, never repaired.
//
// The output is also re-run through renderer steps that splice strings —
// resolveMath (`$…$`) and the field markers (`{{…}}`) — so a kept attribute
// can never carry `$`, `{`, `}` or a quote: an href percent-encodes them and a
// style is built only from digits, hex, fixed keywords and font names made
// of plain words (letters, digits, hyphens; no quotes).

/** Tag → the attributes it may keep. Not in the map = not allowed. */
const RICH_TAGS: Readonly<Record<string, readonly string[]>> = {
  B: [], I: [], U: [], S: [], STRONG: [], EM: [], CODE: [], BR: [], DIV: [], P: [],
  SPAN: ['style'], A: ['href'], UL: [], OL: [], LI: [],
}
/** Removed WITH their content: script/style text is not prose, and a
 *  <template>'s children live where the walk would never see them. */
const RICH_DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
  'TEXTAREA', 'TITLE', 'XMP', 'NOEMBED', 'NOFRAMES', 'SELECT', 'HEAD', 'META', 'LINK', 'BASE'])
/** Deepest list the editor will make (Tab stops there); a deeper one in a
 *  document is flattened to its text. */
export const MAX_LIST_DEPTH = 6
/** Any element nested deeper than this is replaced by its text — a nesting
 *  bomb costs a few characters of formatting, never a stack. */
const MAX_RICH_DEPTH = 40
/** A link longer than this is not a link anyone typed. */
export const MAX_LINK_LENGTH = 2048
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/**
 * The only hrefs a text link may carry: http:, https: and mailto:, parsed by
 * the URL parser and re-serialised from it. Null = no link.
 *
 * The raw value is what getAttribute returns — entities already decoded, so
 * `jav&#x61;script:` arrives as `javascript:` and fails the scheme test like
 * any other spelling. Before testing, it gets exactly the clean-up the URL
 * parser itself performs (tab/LF/CR removed anywhere, C0 controls and spaces
 * trimmed at both ends), so `java\tscript:` and ` javascript:` are judged as
 * the browser would read them. Credentials (`https://bank.example@evil/`) are
 * refused: that shape exists to make a link lie about where it goes.
 */
export function sanitizeLinkHref(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_LINK_LENGTH * 2) return null
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '')
  // eslint-disable-next-line no-control-regex
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) return null
  if (!/^(?:https?|mailto):/i.test(s)) return null
  let url: URL
  try { url = new URL(s) } catch { return null }
  if (!LINK_SCHEMES.has(url.protocol)) return null
  if (url.protocol !== 'mailto:' && !url.hostname) return null
  if (url.username || url.password) return null
  // Characters the renderer's string passes (resolveMath, field markers) or
  // an attribute could read as syntax. The URL parser leaves several of them
  // literal in a query; percent-encoding them means the same URL.
  const out = url.href.replace(/[$\\{}"'<>`\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
  return out.length <= MAX_LINK_LENGTH ? out : null
}

const RUN_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RUN_CHANNEL = /^\d{1,3}(?:\.\d{1,4})?$/
const RUN_ALPHA = /^(?:\d{1,3}(?:\.\d{1,4})?%|0|1|0?\.\d{1,4}|1\.0{1,4})$/
/** Palette slots a run may point at (palette.ts PALETTE_SLOTS). */
const RUN_THEME = /^var\(\s*--sl-(bg1|tx1|bg2|tx2|accent[1-6]|hlink|folHlink)\s*\)$/

/** A run colour: #hex, rgb()/rgba() with numeric channels, or a palette
 *  slot as `var(--sl-<slot>)` (renderSlide defines those on every surface).
 *  Returned re-serialised; null = not a colour this format holds. */
export function sanitizeRunColor(raw: string): string | null {
  const v = raw.trim()
  if (RUN_HEX.test(v)) return v.toLowerCase()
  const theme = RUN_THEME.exec(v)
  if (theme) return `var(--sl-${theme[1]})`
  const fn = /^rgba?\(([^()]*)\)$/i.exec(v)
  if (!fn) return null
  const parts = fn[1].trim().split(/\s*[,/]\s*|\s+/)
  if (parts.length !== 3 && parts.length !== 4) return null
  if (!parts.slice(0, 3).every((p) => RUN_CHANNEL.test(p))) return null
  const [r, g, b] = parts.slice(0, 3).map((p) => Math.min(255, Math.round(Number(p))))
  if (parts.length === 3) return `rgb(${r}, ${g}, ${b})`
  const a = parts[3]
  if (!RUN_ALPHA.test(a)) return null
  const alpha = Math.max(0, Math.min(1, a.endsWith('%') ? Number(a.slice(0, -1)) / 100 : Number(a)))
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`
}

/** Bounds per unit: big enough for a 1000px display numeral, small enough
 *  that a run cannot be made invisible or blow the layout up by orders of
 *  magnitude. */
const RUN_SIZE_BOUNDS: Record<string, [number, number]> = { px: [1, 1000], em: [0.05, 20], '%': [5, 2000] }

/** A run font size: a plain number in px, em or %, inside RUN_SIZE_BOUNDS.
 *  Re-serialised (at most 2 decimals); null = rejected. */
export function sanitizeRunFontSize(raw: string): string | null {
  const m = /^(\d{1,4}(?:\.\d{1,4})?|\.\d{1,4})(px|em|%)$/i.exec(raw.trim())
  if (!m) return null
  const unit = m[2].toLowerCase()
  const n = Number(m[1])
  const [lo, hi] = RUN_SIZE_BOUNDS[unit]
  if (!(n >= lo && n <= hi)) return null
  return `${Math.round(n * 100) / 100}${unit}`
}

/** One family name: words of letters, digits and hyphens (a CSS identifier
 *  each, so it needs no quotes), or a generic family. */
const RUN_FAMILY_WORD = /^-?[a-z_][a-z0-9_-]*$/i
const RUN_FAMILY_RESERVED = new Set(['inherit', 'initial', 'unset', 'revert', 'default'])

/** A run font family: a list of up to 8 names, each unquoted, at most 64
 *  characters. A name that is not plain words is left out of the list;
 *  null when none is left. Written without quotes, as the splice passes
 *  need (see the block comment above). */
export function sanitizeRunFontFamily(raw: string): string | null {
  const out: string[] = []
  for (const part of raw.split(',').slice(0, 8)) {
    const name = part.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
    if (!name || name.length > 64) continue
    const words = name.split(/\s+/)
    if (!words.every((w) => RUN_FAMILY_WORD.test(w) && !RUN_FAMILY_RESERVED.has(w.toLowerCase()))) continue
    out.push(words.join(' '))
  }
  return out.length ? out.join(', ') : null
}

/** A run font weight: a number from 100 to 900, or normal / bold. */
export function sanitizeRunFontWeight(raw: string): string | null {
  const v = raw.trim().toLowerCase()
  if (v === 'normal') return '400'
  if (v === 'bold') return '700'
  if (!/^\d{3}$/.test(v)) return null
  const n = Number(v)
  return n >= 100 && n <= 900 ? String(n) : null
}

/** A run letter spacing: px from -20 to 100, or em from -0.5 to 1. */
export function sanitizeRunLetterSpacing(raw: string): string | null {
  const m = /^(-?)(\d{1,3}(?:\.\d{1,4})?|\.\d{1,4})(px|em)$/i.exec(raw.trim())
  if (!m) return null
  const unit = m[3].toLowerCase()
  const n = Number(m[1] + m[2])
  const [lo, hi] = unit === 'px' ? [-20, 100] : [-0.5, 1]
  if (!(n >= lo && n <= hi)) return null
  return `${Math.round(n * 1000) / 1000}${unit}`
}

/**
 * A run's `style`: `color`, `font-size`, `font-family`, `font-weight`,
 * `font-style` (normal or italic) and `letter-spacing`, each parsed by its
 * own rule above and written back from the parsed value. Every other
 * property, any `!important`, comment,
 * escape, url(), expression() or behavior is simply not one of these shapes
 * and is dropped. Returns '' for "no style". Older readers keep only colour
 * and size: the run then shows in the text's own typeface and weight.
 */
export function sanitizeRunStyle(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 1024) return ''
  let color: string | null = null
  let size: string | null = null
  let family: string | null = null
  let weight: string | null = null
  let spacing: string | null = null
  let fontStyle: string | null = null
  for (const decl of raw.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    const value = decl.slice(i + 1)
    if (prop === 'color') color = sanitizeRunColor(value) ?? color
    else if (prop === 'font-size') size = sanitizeRunFontSize(value) ?? size
    else if (prop === 'font-family') family = sanitizeRunFontFamily(value) ?? family
    else if (prop === 'font-weight') weight = sanitizeRunFontWeight(value) ?? weight
    else if (prop === 'letter-spacing') spacing = sanitizeRunLetterSpacing(value) ?? spacing
    else if (prop === 'font-style' && /^\s*(normal|italic)\s*$/i.test(value)) fontStyle = value.trim().toLowerCase()
  }
  return [
    color && `color:${color}`, size && `font-size:${size}`, family && `font-family:${family}`,
    weight && `font-weight:${weight}`, fontStyle && `font-style:${fontStyle}`, spacing && `letter-spacing:${spacing}`,
  ].filter(Boolean).join(';')
}

/** Keep pasted/edited rich text down to the allowlisted subset above. */
export function sanitizeHtml(html: string): string {
  if (typeof document === 'undefined') return stripAllTags(html)
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  cleanRich(tpl.content, 0, 0, false)
  hoistLists(tpl.content)
  // Serialize from the template's inert content document. Cloning into a div
  // of the LIVE document adopts the nodes there, and an <img> in an active
  // document starts loading (and fires onerror) even while detached.
  return tpl.innerHTML
}

/**
 * The walk. A sibling cursor rather than a snapshot of childNodes: an
 * unwrapped element's children land in its place and are visited NEXT, so a
 * disallowed tag can never smuggle an allowed-looking (or any) child past the
 * walk by being unwrapped around it.
 */
function cleanRich(parent: ParentNode, depth: number, listDepth: number, inLink: boolean) {
  const isList = parent instanceof Element && (parent.tagName === 'UL' || parent.tagName === 'OL')
  if (isList) normalizeListChildren(parent as Element)
  let child = parent.firstChild
  while (child) {
    const next: ChildNode | null = child.nextSibling
    if (child.nodeType === Node.TEXT_NODE) { child = next; continue }
    if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); child = next; continue }
    const el = child as Element
    // Foreign content (svg/math) parses with lower-case tag names, so it
    // never matches an upper-case allowlist entry — unwrapped like the rest.
    const tag = el.tagName
    if (RICH_DROP.has(tag.toUpperCase())) { el.remove(); child = next; continue }
    const keep = RICH_TAGS[tag]
    const unwrap = !keep
      || (tag === 'A' && inLink) // a link inside a link: the outer one wins
      || (tag === 'LI' && !isList)
    if (unwrap) {
      const first = el.firstChild
      el.replaceWith(...Array.from(el.childNodes))
      child = first ?? next
      continue
    }
    if (depth >= MAX_RICH_DEPTH || ((tag === 'UL' || tag === 'OL') && listDepth >= MAX_LIST_DEPTH)) {
      el.replaceWith(el.ownerDocument.createTextNode(el.textContent ?? ''))
      child = next
      continue
    }
    const href = tag === 'A' ? sanitizeLinkHref(el.getAttribute('href')) : null
    const style = tag === 'SPAN' ? sanitizeRunStyle(el.getAttribute('style')) : ''
    for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name)
    if (tag === 'A') {
      if (!href) {
        const first = el.firstChild
        el.replaceWith(...Array.from(el.childNodes))
        child = first ?? next
        continue
      }
      el.setAttribute('href', href)
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    }
    if (style) el.setAttribute('style', style)
    cleanRich(el, depth + 1, listDepth + (tag === 'UL' || tag === 'OL' ? 1 : 0), inLink || tag === 'A')
    child = next
  }
}

/**
 * A list is a block of its own, never the content of a line: contentEditable
 * builds lists INSIDE the `<div>` line it was started on (`<div><ul>…</ul></div>`),
 * and click builds, which split text into paragraphs by top-level block, would
 * then see the whole list as one line. So a div/p holding a list is split
 * around it — what came before and after stays in a div/p of its own, the
 * list moves out between them. Blocks inside a list item are left alone.
 * Deepest first, so nested line divs empty outwards.
 */
function hoistLists(root: DocumentFragment) {
  // only the runs THIS split creates may be dropped as empty below — an
  // author's own blank line (<div>&nbsp;</div>, <p> </p>) is content
  const runs = new Set<Element>()
  for (const block of Array.from(root.querySelectorAll('div, p')).reverse()) {
    if (!Array.from(block.children).some((c) => c.tagName === 'UL' || c.tagName === 'OL')) continue
    if (block.parentElement?.closest('li')) continue
    const parent = block.parentNode!
    let run: Element | null = null
    for (const n of Array.from(block.childNodes)) {
      if (n instanceof Element && (n.tagName === 'UL' || n.tagName === 'OL')) {
        parent.insertBefore(n, block)
        run = null
        continue
      }
      if (!run) {
        run = block.ownerDocument.createElement(block.tagName.toLowerCase())
        parent.insertBefore(run, block)
        runs.add(run)
      }
      run.appendChild(n)
    }
    block.remove()
  }
  // the runs a split left holding nothing but whitespace
  for (const b of runs) {
    if (!b.childNodes.length || (!b.children.length && !(b.textContent ?? '').trim())) {
      if (!b.querySelector('br')) b.remove()
    }
  }
}

/**
 * The list model: a `ul`/`ol` holds only `li`, and a nested list lives INSIDE
 * the item it indents under. Browsers' own indent command writes the nested
 * list as a sibling of the items instead, and pasted markup can hold anything,
 * so this folds both into the one shape: a nested list joins the previous
 * item (or a new one), stray inline content is wrapped in an item of its own,
 * whitespace between items goes.
 */
function normalizeListChildren(list: Element) {
  const doc = list.ownerDocument
  let loose: HTMLElement | null = null // the item collecting a run of stray inline content
  for (const node of Array.from(list.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'LI') { loose = null; continue }
    if (node.nodeType === Node.TEXT_NODE && !(node.textContent ?? '').trim()) { node.remove(); continue }
    const tag = node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName : ''
    if (tag === 'UL' || tag === 'OL') {
      let prev = node.previousSibling
      while (prev && prev.nodeType !== Node.ELEMENT_NODE) prev = prev.previousSibling
      if (prev && (prev as Element).tagName === 'LI') prev.appendChild(node)
      else {
        const li = doc.createElement('li')
        list.insertBefore(li, node)
        li.appendChild(node)
      }
      loose = null
      continue
    }
    if (!loose) {
      loose = doc.createElement('li')
      list.insertBefore(loose, node)
    }
    loose.appendChild(node)
  }
}

/** No-DOM fallback (node rigs): drop every tag, keep the words. */
function stripAllTags(html: string): string {
  return String(html).replace(/<[^>]*>/g, '')
}

// --- untrusted svg ----------------------------------------------------------
//
// An `svg` element's markup is opaque author content that goes into the page as
// markup — the one element type whose content is not text we lay out but nodes
// the browser builds. Every deck is untrusted input: mailed, pasted, or
// delivered as a collab op. Script running in this page holds `doc.collab.key`,
// `ownerPriv`/`writerPriv`, the plaintext IndexedDB autosave store and the File
// System Access handle ⌘S writes through, so "the document can run script" is
// the document AND the file on disk.

/**
 * The svg vocabulary an untrusted diagram may use. AN ALLOWLIST, and that is
 * the whole point of this rewrite.
 *
 * The first version of this sanitizer named five tags and three attributes,
 * and a verifier walked through the gap five ways in Chrome 141 (2026-08-09):
 * `<form action="javascript:…">` under a full-slide transparent submit button
 * (ONE click anywhere on the slide), `<button formaction="javascript:…">`,
 * `<meta http-equiv="refresh">` — which actually navigated the reader's page
 * off to an attacker host, and which the html parser lets break out of foreign
 * content so `<svg><rect/><meta …></svg>` reaches the body too — `<base href>`
 * (a media `src` is documented as possibly relative, so retargeting resolution
 * is a live fetch), and `<link rel=stylesheet>`. Not one of those is on this
 * list, so not one of them had to be named, and neither does whatever the next
 * browser ships.
 *
 * Sized against the content that exists: every svg asset the old showcase deck
 * used (userSpaceOnUse patterns, feTurbulence + feColorMatrix grain,
 * feGaussianBlur bokeh, radialGradient auroras) draws unchanged through it. NO html tag is on
 * the list — an svg element's markup is svg, and the html tags that reach it
 * are exactly the carriers: `foreignObject` children, and the foreign-content
 * breakout list, which is where `meta` came from. A diagram that wants a name
 * added here is a one-line change; a diagram that wants `<form>` is not a
 * diagram. An element not on the list is REMOVED WHOLE rather than unwrapped:
 * unwrapping would spill a refused element's text onto the slide, and "refuse"
 * is the rule this list exists to state.
 *
 * `template` is on nobody's list twice over — its children live in `.content`,
 * not `childNodes`, so the walk below would never have seen them while
 * `importNode(n, true)` copied them wholesale.
 */
export const SVG_TAGS = new Set([
  // structure. `style` stays: it cannot execute, its text is run through
  // sanitizeSvgCss, and sanitizeSvg SCOPES it to the element instance (hard-won
  // detail #7) so its rules cannot leak into every other svg on the page.
  // That scoping is passed IN — the sanitizer has no element to name on its
  // own. An earlier version of this comment credited scopeCss directly, which
  // was false: scopeCss's only caller took `el.css`, the model field, and the
  // markup path below was never scoped at all.
  'svg', 'g', 'defs', 'symbol', 'use', 'switch', 'desc', 'title', 'metadata', 'style', 'view', 'a',
  // shapes and text
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'image',
  // paint servers, clipping, masking
  'lineargradient', 'radialgradient', 'stop', 'pattern', 'solidcolor',
  'clippath', 'mask', 'marker',
  // filters
  'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite',
  'feconvolvematrix', 'fediffuselighting', 'fedisplacementmap', 'fedistantlight',
  'fedropshadow', 'feflood', 'fefunca', 'fefuncb', 'fefuncg', 'fefuncr',
  'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology',
  'feoffset', 'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile',
  'feturbulence',
  // SMIL — judged by what they WRITE, see the attributeName rule below
  'animate', 'animatemotion', 'animatetransform', 'set', 'mpath',
])

/** SMIL: these can WRITE an attribute, so they are judged by their target. */
const SVG_ANIM = new Set(['animate', 'set', 'animatetransform', 'animatemotion'])

/**
 * Attributes an untrusted svg may keep. Same argument as SVG_TAGS: `action`,
 * `formaction`, `http-equiv`, `srcdoc` and every `on*` are refused because they
 * were never permitted, not because a list enumerates them.
 *
 * Matched case-INSENSITIVELY, which is what makes the html parser's foreign-
 * content case fixups (`viewBox`, `attributeName`, `stdDeviation`,
 * `patternUnits`) line up with the lowercase entries here.
 */
const SVG_ATTRS = new Set([
  // core
  'id', 'class', 'style', 'lang', 'xml:lang', 'xml:space', 'xmlns', 'xmlns:xlink',
  'role', 'title', 'version', 'baseprofile', 'tabindex', 'media', 'type', 'target',
  'href', 'xlink:href',
  // geometry
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height',
  'd', 'points', 'pathlength', 'dx', 'dy', 'rotate', 'textlength', 'lengthadjust',
  'transform', 'transform-origin', 'transform-box', 'viewbox', 'preserveaspectratio', 'zoomandpan',
  // coordinate systems, paint servers, markers
  'refx', 'refy', 'markerwidth', 'markerheight', 'markerunits', 'orient',
  'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy', 'fr', 'offset',
  'patternunits', 'patterncontentunits', 'patterntransform', 'clippathunits',
  'maskunits', 'maskcontentunits', 'primitiveunits', 'filterunits',
  'startoffset', 'method', 'spacing', 'side',
  'systemlanguage', 'requiredfeatures', 'requiredextensions',
  // presentation
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-opacity', 'opacity', 'color', 'color-interpolation', 'color-interpolation-filters',
  'display', 'visibility', 'overflow', 'cursor', 'pointer-events', 'shape-rendering',
  'text-rendering', 'image-rendering', 'vector-effect', 'paint-order', 'mix-blend-mode',
  'isolation', 'font', 'font-family', 'font-size', 'font-size-adjust', 'font-stretch',
  'font-style', 'font-variant', 'font-weight', 'letter-spacing', 'word-spacing',
  'text-anchor', 'text-decoration', 'dominant-baseline', 'alignment-baseline',
  'baseline-shift', 'writing-mode', 'direction', 'unicode-bidi', 'white-space',
  'clip', 'clip-path', 'clip-rule', 'mask', 'marker', 'marker-start', 'marker-mid',
  'marker-end', 'filter', 'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity',
  'lighting-color', 'enable-background',
  // filter primitives
  'in', 'in2', 'result', 'mode', 'values', 'tablevalues', 'slope', 'intercept',
  'amplitude', 'exponent', 'operator', 'k1', 'k2', 'k3', 'k4', 'order', 'kernelmatrix',
  'divisor', 'bias', 'targetx', 'targety', 'edgemode', 'kernelunitlength', 'preservealpha',
  'surfacescale', 'diffuseconstant', 'specularconstant', 'specularexponent', 'scale',
  'xchannelselector', 'ychannelselector', 'stddeviation', 'radius', 'basefrequency',
  'numoctaves', 'seed', 'stitchtiles', 'azimuth', 'elevation', 'pointsatx', 'pointsaty',
  'pointsatz', 'limitingconeangle', 'z',
  // SMIL timing
  'attributename', 'attributetype', 'from', 'to', 'by', 'dur', 'begin', 'end', 'min',
  'max', 'restart', 'repeatcount', 'repeatdur', 'calcmode', 'keytimes', 'keysplines',
  'keypoints', 'path', 'additive', 'accumulate', 'origin',
])

/**
 * `data-*` names this renderer, its editor and the kernel read. An author svg
 * carrying one would answer a `[data-el-id="…"]` lookup that is already
 * ambiguous between the canvas and the sidebar thumbnails (hard-won detail #3),
 * so the open `data-*` door below stops short of them.
 *
 * `data-slidomingo` is reserved as a PREFIX, not as one name: the shell's own marks
 * are `data-beeslides-transient` (kernel `serializeBody` deletes those nodes from
 * the clone it saves) and `data-beeslides-preview` (which save.ts removes
 * unconditionally, replace-never-append). Reserving the exact string only would
 * have left an author element able to answer either query.
 */
// `data-slidomingo-*` too: the shell names of files saved before 2026-10-20.
const SVG_DATA_RESERVED = /^data-(el-id|flip-id|slide-id|autoplay|r|c)$|^data-(?:beeslides|slidomingo)/

/**
 * `aria-*` is open-ended by design and inert; `data-*` is how a diagram's own
 * `<style>` selects its parts. Everything else is the list.
 *
 * Exported for `scripts/test-sanitize.ts` — this is a pure decision, so it is
 * pinned in node while the walk that applies it is measured in a browser.
 */
export function svgAttrAllowed(name: string): boolean {
  const n = name.toLowerCase()
  if (n.startsWith('aria-')) return true
  if (n.startsWith('data-')) return !SVG_DATA_RESERVED.test(n)
  return SVG_ATTRS.has(n)
}

/**
 * Tags whose href may leave this document. An `<image>` or `<feImage>` paints
 * a picture and an `<a>` navigates on a click the reader made; every other
 * href in svg (`use`, `pattern`, gradient inheritance, `mpath`, `textPath`)
 * pulls a SUBTREE out of the target document, which is both a fetch and a
 * trust boundary.
 */
const SVG_HREF_REMOTE = new Set(['a', 'image', 'feimage'])

/**
 * May an untrusted svg keep this href?
 *
 * Same-document fragments must survive — gradients, markers and `<use>` all
 * paint through `url(#…)`, and dropping those refs is what would render a
 * diagram blank. Beyond that only the tags above, and only http(s) or a
 * `data:image/` (which the browser loads script-disabled). Everything else
 * goes: `javascript:` obviously, but the bare relative form too, because
 * `//host/x` is relative as well and is a network fetch out of a file the
 * reader believes is self-contained (PLATFORM §1).
 *
 * ASCII whitespace and control characters come out before the test, because a
 * browser ignores them inside a scheme: `java&#9;script:alert(1)` navigates.
 *
 * Exported for `scripts/test-sanitize.ts`: the walk below needs a DOM, this
 * decision does not. `tag` defaults to the permissive case so a caller asking
 * only "is this url shape allowed anywhere" gets that answer.
 */
export function svgHrefAllowed(value: string, tag = 'image'): boolean {
  const v = value.replace(/[\u0000-\u0020]/g, '').toLowerCase()
  if (v.startsWith('#')) return true
  if (!SVG_HREF_REMOTE.has(tag.toLowerCase())) return false
  return /^https?:/.test(v) || v.startsWith('data:image/')
}

/** Every `url(…)` target in a CSS-ish string, quotes and padding removed. */
function urlTargets(value: string): string[] {
  return Array.from(value.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi))
    .map((m) => m[2].replace(/[\u0000-\u0020]/g, '').toLowerCase())
}

/**
 * `url(#grad)` is the gradient/marker idiom every diagram is built on;
 * `url(https://…)` in the same attribute is a live fetch out of a self-
 * contained file, and a read receipt for a mailed deck. So attribute values
 * are checked for their url targets, not just their scheme — `fill`,
 * `filter`, `clip-path`, `mask` and `style` all take one.
 *
 * Exported for `scripts/test-sanitize.ts`.
 */
export function svgUrlRefsAllowed(value: string): boolean {
  return urlTargets(value).every((t) => t.startsWith('#') || t.startsWith('data:image/')) &&
    !Array.from(value.matchAll(CSS_FN)).some((m) => cssFetchFn(m[1]))
}

/**
 * A CSS function token: an ident directly followed by `(`. Backslashes count
 * as name characters (the browser decodes `\72` and `\r` inside an ident), as
 * does the one whitespace a hex escape may consume. Anchored at a token start
 * by the lookbehinds, so a long run with no `(` is scanned once, not once per
 * character — this runs on up to 64 KB of untrusted css.
 */
const CSS_FN = /(?<![-\w\u0080-\uffff\\])(?<!\\[0-9a-fA-F]{1,6}[ \t\r\n\f])((?:[-\w\u0080-\uffff\\]|(?<=\\[0-9a-fA-F]{1,6})[ \t\r\n\f])+)\(/g

/** Functions that fetch from a bare STRING, which the url() check cannot see. */
const CSS_FETCH_FNS = new Set(['image-set', '-webkit-image-set', 'image', 'src'])

/**
 * Whether a CSS function name could reach the network past the url() check
 * (both kinds measured fetching in Chromium, 2026-10-08 review):
 *
 * - a name written with a CSS ESCAPE: `u\72l(http://…)` and `u\rl(…)` are
 *   url() to the browser and match no regex spelling `url(`. Refused on sight,
 *   the same rule as an escaped at-keyword: nobody spells a function name with
 *   an escape, and decoding one is a second chance to disagree with the
 *   browser about what it says.
 * - `image-set("https://…" 1x)` and its -webkit- twin, which take a bare
 *   string URL, plus `image()` and `src()`, which are specified to.
 */
function cssFetchFn(name: string): boolean {
  return name.includes('\\') || CSS_FETCH_FNS.has(name.toLowerCase())
}

/**
 * At-rules an untrusted sheet may keep — layout, motion and typography, which
 * is what a diagram's own CSS is for.
 *
 * An ALLOWLIST, and the reason is measured. The first pass cut `@import` by
 * name; Chrome 141 fetched anyway (2026-08-09 — the probe server logged the
 * request), because a CSS at-keyword is an IDENT and an ident may be written
 * with escapes: `@\69mport "https://…";` is the same at-rule and matches no
 * regex spelling `import`. `@im\port` and `@\49MPORT` are two more spellings of
 * it, and there is no end to that list — so the question asked here is which
 * at-rules are WANTED.
 *
 * It also covers the fetch spelled as a bare string, which the url() rewrite
 * below cannot see: `@import "https://…"` has no `url(` in it.
 */
const CSS_AT_ALLOWED = new Set([
  'media', 'supports', 'layer', 'container', 'scope', 'page', 'starting-style',
  'font-face', 'font-feature-values', 'counter-style', 'property',
  'keyframes', '-webkit-keyframes', '-moz-keyframes',
])

/**
 * CSS an untrusted svg may carry, in a `<style>` element or in the model's
 * `css` field. Neutralised rather than refused: a diagram's rules are how it
 * draws, so dropping the sheet costs the artwork, while dropping one fetch
 * costs nothing that was legitimate.
 *
 * A refused at-rule is RENAMED to one no browser implements rather than cut
 * out. CSS error recovery discards an unknown at-rule whole — its prelude, and
 * its block if it has one — so the payload goes and the rest of the sheet still
 * parses, and this stays a string rewrite with no brace matching in it. It is
 * also what makes the missing-semicolon form (`@import "x.css"` with a newline
 * where the `;` should be) a non-case: the parser, not this regex, decides
 * where the at-rule ends.
 *
 * An external `url()` is the same fetch with different syntax (`@font-face`
 * src, `background-image`, `fill`) — rewritten to `none`, which is a valid
 * value everywhere url() is legal, so a sheet stays parseable. Both are the
 * no-CDN rule (PLATFORM §1) and, for a deck sent by mail, a read receipt with
 * the reader's IP on it.
 *
 * The at-keyword scan requires the `@` to start a token, so an `@` inside a
 * value (`content:"a@b"`) is left alone.
 */
export function sanitizeSvgCss(css: string): string {
  const atFiltered = css.replace(/(^|[\s{};,)])@([-\w\\]+)/g, (_m, pre: string, kw: string) =>
    // Written plainly AND wanted. An escape inside the keyword is refused on
    // sight: nobody spells `@media` as `@\6dedia`, so decoding one would only
    // be a second chance to disagree with the browser about what the ident says.
    (/^-?[a-zA-Z][-\w]*$/.test(kw) && CSS_AT_ALLOWED.has(kw.toLowerCase())
      ? `${pre}@${kw}`
      : `${pre}@beeslides-refused `))
    // A function that fetches past the url() rewrite below is RENAMED, like a
    // refused at-rule: an unknown function invalidates its one declaration,
    // and the rest of the sheet still parses.
    .replace(CSS_FN, (m, name: string) => (cssFetchFn(name) ? 'beeslides-refused(' : m))
  return atFiltered.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q: string, target: string) => {
    const v = String(target).replace(/[\u0000-\u0020]/g, '').toLowerCase()
    return v.startsWith('#') || v.startsWith('data:image/') ? m : 'none'
  })
    // No raw `<` in the output: this text lands in a <style>, and an
    // html-namespace one (markup with the <style> outside its <svg>) is
    // serialized VERBATIM, so `</style` in it ends the element on any
    // re-parse and the rest of the sheet becomes markup. `\3c ` is the same
    // character to CSS (the hex escape eats the one space), in a string and
    // in an identifier alike, and it is not a tag to html.
    .replace(/</g, '\\3c ')
}

/**
 * Author svg markup → nodes this document can safely hold.
 *
 * AT RENDER, EVERY RENDER — not on the load path. An svg element also arrives
 * from a clipboard paste and from a collab op, and rendering is the one place
 * all three meet. Sanitizing here also keeps the FORMAT additive: nothing is
 * stamped on the model, so a file cleaned by this build is byte-identical to
 * one an older build wrote.
 *
 * Parsed INERT. `div.innerHTML = hostile` looks safe because the div is
 * detached and is not: the elements it creates belong to the live document, so
 * their resources load and `<img src=x onerror=…>` fires from a div that was
 * never inserted (measured for spaces, 2026-08-03 — same reason
 * spaces/src/sanitize.ts parses through DOMParser). `text/html`, not
 * `image/svg+xml`: the XML parser is FATAL on the first unclosed tag, and
 * refusing to draw a slightly sloppy diagram is a worse answer than drawing it.
 * The HTML parser applies the browser's own foreign-content rules, so
 * `foreignObject`, `clipPath`, `viewBox` and `xlink:href` come back correctly
 * cased and namespaced.
 *
 * `id` is deliberately never stripped: svg gradients and markers resolve
 * through document-global `url(#…)`, so an id sweep blanks the artwork.
 */
/**
 * `scope` is REQUIRED, not optional. The bug this signature exists to prevent
 * was precisely a markup path that never got scoped, so an optional parameter
 * would leave the leak one omission away and make the unsafe call the shorter
 * one. There is one caller; costing it a selector is free.
 */
export function sanitizeSvg(markup: string, scope: string): DocumentFragment {
  const out = document.createDocumentFragment()
  if (!markup) return out
  const parsed = new DOMParser().parseFromString(markup, 'text/html')

  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) continue
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue }
      const el = child as Element
      const tag = el.localName.toLowerCase()
      if (!SVG_TAGS.has(tag)) { el.remove(); continue }

      let gone = false
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase()
        if (!svgAttrAllowed(name)) { el.removeAttribute(attr.name); continue }
        if (SVG_ANIM.has(tag) && name === 'attributename') {
          // An animation WRITES an attribute, and it writes it long after this
          // walk has finished — so it is judged by its target. Anything off the
          // allowlist (`onclick`, `formaction`) is refused here even though
          // Blink declines to apply an on* through SMIL today: the refusal must
          // not rest on a browser's restraint. `href`/`style` ARE on the
          // allowlist and still refused, because their values are policed once,
          // below, and an animation is a second chance to set them.
          const target = attr.value.trim().toLowerCase()
          if (!svgAttrAllowed(target) || /(^|:)(href|style)$/.test(target)) { gone = true; break }
          continue
        }
        if (!svgUrlRefsAllowed(attr.value) || (name === 'style' && /@import|expression\s*\(/i.test(attr.value))) {
          el.removeAttribute(attr.name)
          continue
        }
        if (name !== 'href' && name !== 'xlink:href') continue
        if (svgHrefAllowed(attr.value, tag)) continue
        // a <use> IS its href, and one that cannot be resolved in-document
        // instances a subtree from a document that is not ours to trust; a dead
        // <a> or <image> is merely inert, so it keeps its place in the layout.
        if (tag === 'use') { gone = true; break }
        el.removeAttribute(attr.name)
      }
      if (gone) { el.remove(); continue }

      if (tag === 'style') {
        // Assigning textContent also discards any element children, which the
        // html parser really does build here: inside foreign content the
        // tokenizer stays in the data state, so `<svg><style><img src=x
        // onerror=…></style>` parses that img as an ELEMENT, not as css text.
        // Scoped as well as sanitized. An svg <style> applies DOCUMENT-WIDE, so
        // one diagram's rules reach every other svg on the page — the exact
        // hazard scopeCss exists for, which until now only `el.css` got.
        el.textContent = scopeCss(sanitizeSvgCss(el.textContent ?? ''), scope)
        continue
      }
      walk(el)
    }
  }
  walk(parsed.body)
  // importNode, not a bare append: the nodes live in the inert parsed document,
  // and relying on DOM4's implicit adopt is a trap for the next edit.
  for (const n of Array.from(parsed.body.childNodes)) out.appendChild(document.importNode(n, true))
  return out
}

const VALIGN: Record<string, string> = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }

/** The three alignments the format defines. Anything else is data, not a value. */
const ALIGN: Record<string, string> = { left: 'left', center: 'center', right: 'right' }

/**
 * A colour string safe to paste into a `style` attribute, or the fallback.
 *
 * A table's colours are ordinary untrusted input — the rows of a mailed deck, a
 * paste, a collab op — so the model's `string` says nothing about the value, and
 * escaping for markup does not cover where it lands. Inside `style="…"` the
 * dangerous characters are `"` (which ends the attribute and lets the next word
 * be an event handler) and `;`/`}` (which start a new declaration); `<` means
 * nothing there. A cell whose `bg` read `x" onmouseover="…` used to mint a real
 * handler on the canvas, in present, in print AND in every thumbnail.
 *
 * So: an allowlist of the characters colour notations actually use, no `url(`,
 * and a length cap. Anything else falls back rather than being "cleaned" — a
 * colour we do not recognise is not worth guessing at. Same rule and same
 * reasons as dash's preview (`dash/src/preview.ts` cssColor); `url` is matched
 * as `url(` rather than as a word because `burlywood` is a colour.
 *
 * Exported for `scripts/test-sanitize.ts`.
 */
export function cssColor(v: unknown, fallback: string, max = 48): string {
  if (typeof v !== 'string') return fallback
  const s = v.trim()
  if (!s || s.length > max) return fallback
  if (!/^[#a-zA-Z0-9(),.%\s/-]+$/.test(s)) return fallback
  if (/url\s*\(|expression|@|\\/i.test(s)) return fallback
  return s
}

/**
 * An image/video `fit` as an object-fit keyword. The model's union says
 * nothing about a deck someone sent you: `contain;background-image:url(…)`
 * used to land in cssText as a second declaration — a remote fetch, past
 * offline mode.
 */
const cssFit = (v: unknown): string => (v === 'cover' || v === 'fill' ? v : 'contain')

/** A model number as a CSS length: finite and in range, or the fallback. */
export function cssNum(v: unknown, fallback: number, max = 4096): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : fallback
}

/**
 * An author font stack, reduced to what a stylesheet can hold. Rejected by
 * CHARACTER rather than by allowlist, unlike cssColor: font names are ordinary
 * words in any script (`ヒラギノ角ゴ` is a font family), so the test is for the
 * few characters that end a declaration or start a fetch.
 */
function cssFont(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const s = v.trim()
  if (!s || s.length > 160) return fallback
  return /[;{}<>()\\]/.test(s) ? fallback : s
}

/**
 * Render a table element as a real HTML <table> string (table-layout: fixed).
 * Column widths are fractional weights normalised to %. Cells carry data-r /
 * data-c so the editor can target them for in-cell editing.
 *
 * Every author value is escaped for the attribute AND validated for the CSS it
 * lands in (cssColor/cssNum/cssFont/ALIGN) — see cssColor for what that stops.
 * Markup as a string, not DOM built and serialized, is kept deliberately: it is
 * what makes this whole function testable in node with no DOM at all, which is
 * what `scripts/test-sanitize.ts` exercises.
 */
export function renderTableHtml(el: TableElement, doc: SlidomingoDoc): string {
  const st = el.style ?? ({} as TableElement['style'])
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  const totalW = el.columns.reduce((s, c) => s + cssNum(c.w, 0), 0) || 1
  const cols = el.columns
    .map((c) => `<col style="width:${((cssNum(c.w, 0) / totalW) * 100).toFixed(4)}%">`)
    .join('')
  const font = esc(cssFont(st.fontFamily || doc.theme.fontFamily, 'inherit'))
  const bw = cssNum(st.borderWidth, 0, 64)
  const border = bw ? `border:${bw}px solid ${cssColor(st.borderColor, 'transparent')};` : ''
  const padY = cssNum(st.cellPadY, 0, 512)
  const padX = cssNum(st.cellPadX, 0, 512)
  // merged cells (tablespans.ts): an anchor carries colspan/rowspan, the
  // cells it covers are not drawn at all
  const layout = tableLayout(el)
  const rowsHtml = el.rows
    .map((row, r) => {
      const isHeader = el.header && r === 0
      const bodyIndex = el.header ? r - 1 : r
      const stripe = !isHeader && st.zebra && bodyIndex % 2 === 1 ? st.zebra : ''
      const cells = row.cells
        .map((cell, c) => {
          const sp = layout.span[r]?.[c]
          if (!sp) return ''
          const spans = (sp.cs > 1 ? ` colspan="${sp.cs}"` : '') + (sp.rs > 1 ? ` rowspan="${sp.rs}"` : '')
          const align = ALIGN[cell.align as string] ?? 'left'
          const bg = cssColor(cell.bg || (isHeader ? st.headerBg : stripe || 'transparent'), 'transparent')
          const color = cssColor(cell.color || (isHeader ? st.headerColor : st.color), 'inherit')
          const weight = cell.bold || isHeader ? 700 : 400
          return (
            `<td data-r="${r}" data-c="${c}"${spans} style="${border}padding:${padY}px ${padX}px;` +
            `text-align:${align};vertical-align:middle;color:${color};background:${bg};` +
            `font-weight:${weight};overflow:hidden;word-break:break-word;">` +
            // dir="auto" per cell for the same reason text elements carry it:
            // a table of Arabic terms is otherwise laid out as if it were
            // English. Per cell, so a bilingual table stays correct in both
            // columns.
            // $…$ math typesets in cells as in text boxes (after sanitizing —
            // see resolveMath); canvas.editCellAt shows the source while editing
            `<div class="beeslides-cell-inner" dir="auto">${resolveMath(sanitizeHtml(String(cell.html ?? ''))) || '<br>'}</div></td>`
          )
        })
        .join('')
      return `<tr data-r="${r}">${cells}</tr>`
    })
    .join('')
  const rad = cssNum(st.radius, 0, 512)
  const radius = rad ? `border-radius:${rad}px;overflow:hidden;` : ''
  return (
    `<div class="beeslides-table-wrap" style="width:100%;height:100%;${radius}">` +
    `<table class="beeslides-table" style="width:100%;height:100%;border-collapse:collapse;` +
    `table-layout:fixed;font-family:${font};font-size:${cssNum(st.fontSize, 16, 512)}px;line-height:1.3;">` +
    `<colgroup>${cols}</colgroup>${rowsHtml}</table></div>`
  )
}

/**
 * Font fallback chain for a text/code element: its own explicit
 * `fontFamily` always wins (an unset override is the empty string, which is
 * falsy — the panel's "theme default" option), then the governing master's
 * matching font (`opts.fonts`, auto-filled by `renderSlide`), then the
 * document theme's matching font. `role:'title'` elements — and ONLY those,
 * deliberately conservative; subtitle/kicker/body stay on the body font —
 * prefer the heading face at each tier before falling through to that
 * tier's body face. This is what makes `doc.theme.headingFamily` and
 * `Master.headingFamily` live at render time.
 */
function resolveFontFamily(el: { fontFamily: string; role?: string }, doc: SlidomingoDoc, opts: RenderOpts): string {
  const heading = el.role === 'title'
  return (
    el.fontFamily ||
    (heading ? opts.fonts?.headingFamily : undefined) ||
    opts.fonts?.fontFamily ||
    (heading ? doc.theme.headingFamily : undefined) ||
    doc.theme.fontFamily
  )
}

/**
 * An element's text alternative (model.ts `Describable`) on a node that is
 * not an <img>: `role="img"` + `aria-label`, so assistive tech announces the
 * description instead of walking into svg paths or chart tick labels. `''`
 * marks the picture decorative — hidden from assistive tech entirely. No
 * `alt` at all leaves the node as it always was. Set through setAttribute,
 * never string-built markup, so the text can hold any character.
 */
function labelAsImage(node: Element, alt: string | undefined): void {
  if (alt === undefined) return
  if (alt === '') { node.setAttribute('aria-hidden', 'true'); return }
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', alt)
}

/**
 * Render one element. The wrapper carries data-el-id (edit-time selection)
 * and data-flip-id (morph matching across slides). The flip id is the
 * element's `morphId` when set, else its `id` — so morph pairing can be
 * re-targeted without disturbing the stable identity used everywhere else.
 */
export function renderElement(el: SlideElement, doc: SlidomingoDoc, opts: RenderOpts = {}): HTMLElement {
  const node = document.createElement('div')
  node.className = `beeslides-el beeslides-el-${el.type}`
  if (opts.ghostIds?.has(el.id)) node.classList.add('beeslides-el-ghost')
  if (opts.lockedCursorIds?.has(el.id)) node.classList.add('beeslides-el-locked')
  node.dataset.elId = el.id
  node.dataset.flipId = morphKey(el)
  if (el.link) node.dataset.link = el.link
  if (el.group) node.dataset.group = el.group
  if (el.showOnHover) node.dataset.showOnHover = el.showOnHover
  if (el.type === 'shape' && el.container) node.dataset.container = '1'
  applyElementFrame(node, el)
  if (el.hidden) node.classList.add('beeslides-el-hidden')
  // Editor: user-locked elements and unselected backdrops are click-through
  // (canvas.ts selects them via the Select menu / plain-click fallback). An
  // icon set has no backdrops: its paths are drawn on the whole canvas, and
  // a click must pick the line under the pointer, not the top path.
  const hitNone = !!opts.paintHit &&
    (!!el.locked || ((el.type === 'shape' || el.type === 'image' || el.type === 'svg') && doc.kind !== 'iconset' && isBackdrop(el, opts.size ?? doc.size)))
  if (hitNone) node.dataset.hit = 'none'

  switch (el.type) {
    case 'text': {
      node.style.display = 'flex'
      node.style.flexDirection = 'column'
      node.style.justifyContent = VALIGN[el.valign]
      const inner = document.createElement('div')
      inner.className = 'beeslides-text-inner'
      // Base direction from the text itself. Without it every box is LTR, and
      // Arabic/Hebrew/Persian/Urdu render with their neutral characters in the
      // wrong place — a trailing full stop jumps to the head of the line, and
      // mixed-language runs reorder. PER ELEMENT, not per document: one deck
      // can hold an Arabic heading and an English caption and both are right.
      // This is about the CONTENT the author typed; it says nothing about the
      // editor's own language.
      inner.dir = 'auto'
      // The slide title is the page's heading for assistive tech (screen
      // readers jump by heading). Level 2: the document title is the page's
      // level 1. On the INNER box, so it holds exactly the text and every
      // render path (canvas, Reveal, static layer, preview) carries it.
      if (el.role === 'title') {
        inner.setAttribute('role', 'heading')
        inner.setAttribute('aria-level', '2')
      }
      inner.style.fontSize = `${el.fontSize}px`
      inner.style.fontFamily = resolveFontFamily(el, doc, opts)
      inner.style.fontWeight = String(el.fontWeight)
      const cg = el.colorGradient
      if (cg && cg.stops && cg.stops.length) {
        inner.style.backgroundImage = cssLinearGradient(cg)
        inner.style.setProperty('-webkit-background-clip', 'text')
        inner.style.setProperty('background-clip', 'text')
        inner.style.color = 'transparent'
      } else {
        inner.style.color = el.color
      }
      // text-stroke composes on top: outline the glyphs (over gradient or solid fill)
      const ts = el.textStroke
      if (ts && ts.width) {
        inner.style.setProperty('-webkit-text-stroke', `${ts.width}px ${ts.color}`)
        if (ts.fill === 'none') inner.style.color = 'transparent'
      }
      inner.style.textAlign = el.align
      inner.style.lineHeight = String(el.lineHeight)
      if (el.letterSpacing) inner.style.letterSpacing = `${el.letterSpacing}px`
      inner.style.width = '100%'
      // Marker spans are our own markup, so they go in after sanitizing; the
      // plain path keeps its historical order (resolved values sanitized too).
      const markers = opts.fieldMarkers === true ? 'value' : opts.fieldMarkers || undefined
      inner.innerHTML = markers
        ? resolveMath(resolveFields(sanitizeHtml(el.html), opts.fields, markers))
        : resolveMath(sanitizeHtml(resolveFields(el.html, opts.fields)))
      // layout placeholder: prompt while empty (editor), gone while presenting
      const isEmpty = !inner.textContent?.trim() && !el.html.includes('<img')
      if (el.placeholder && isEmpty) {
        if (opts.hidePlaceholders) {
          node.style.display = 'none'
        } else {
          inner.textContent = el.placeholder
          inner.style.opacity = '0.38'
        }
      }
      node.appendChild(inner)
      if (opts.paintHit && !hitNone) node.dataset.hit = 'paint'
      break
    }
    case 'shape': {
      const svg = shapeSvg(el)
      node.appendChild(svg)
      if (opts.paintHit && !hitNone && isUnfilledShape(el)) {
        node.dataset.hit = 'paint'
        // The painted stroke can be 1-2px wide: add a fat invisible twin so
        // a line/outline is still easy to hit (the fill-less interior isn't).
        const geom = svg.querySelector(':scope > line, :scope > path, :scope > rect, :scope > ellipse, :scope > polygon')
        if (geom) {
          const hit = geom.cloneNode(false) as SVGElement
          for (const a of ['marker-start', 'marker-end', 'stroke-dasharray', 'filter']) hit.removeAttribute(a)
          hit.setAttribute('fill', 'none')
          hit.setAttribute('stroke', 'transparent')
          hit.setAttribute('stroke-width', String(Math.max(el.strokeWidth, 10)))
          hit.setAttribute('stroke-linecap', 'round')
          if (el.shape === 'path') hit.setAttribute('vector-effect', 'non-scaling-stroke')
          else hit.removeAttribute('vector-effect')
          hit.setAttribute('data-hit-stroke', '1')
          svg.appendChild(hit)
        }
      }
      break
    }
    case 'table':
      node.dataset.table = '1'
      node.innerHTML = renderTableHtml(el, doc)
      break
    case 'image': {
      const img = document.createElement('img')
      const imgSrc = assetSrc(doc, el.src, opts.inlineData)
      if (imgSrc) img.src = imgSrc
      else img.dataset.beeslidesOffline = '1'
      img.draggable = false
      // '' is a real value here (decorative), so only absence skips it; the
      // kernel's asset store carries a description over as aria-label when it
      // swaps the <img> for a div[role=img] in the saved no-JS layer — but not
      // an empty one, so decorative is ALSO marked on the wrapper, which that
      // swap leaves alone
      if (el.alt !== undefined) img.alt = el.alt
      if (el.alt === '') node.setAttribute('aria-hidden', 'true')
      const crop = normalizeCrop(el.crop)
      if (crop) {
        // Cropped: a clipping box the size of the frame, and inside it the
        // WHOLE picture scaled so the crop region exactly covers the box.
        // Plain percentages, no natural size and no object-view-box (not in
        // Safari/Firefox), so it draws the same in every output — the
        // static layer's store keeps the img's own inline style (staticrender
        // markStorable accepts this shape too).
        const box = document.createElement('div')
        box.className = 'beeslides-crop'
        box.style.cssText = `position:relative;width:100%;height:100%;overflow:hidden;border-radius:${cssNum(el.radius, 0)}px`
        img.style.cssText = `position:absolute;left:${pct(-crop.x / crop.w)};top:${pct(-crop.y / crop.h)};` +
          `width:${pct(1 / crop.w)};height:${pct(1 / crop.h)};max-width:none;object-fit:fill;display:block`
        box.appendChild(img)
        node.appendChild(box)
        break
      }
      img.style.cssText = `width:100%;height:100%;object-fit:${cssFit(el.fit)};border-radius:${cssNum(el.radius, 0)}px;display:block`
      node.appendChild(img)
      break
    }
    case 'media': {
      const radius = cssNum(el.radius, 0)
      if (opts.svgAsImage || opts.staticMediaStill) {
        // thumbnails: a cheap still — poster (video) or an icon chip, never a
        // live media element.
        const still = document.createElement('div')
        still.style.cssText = `width:100%;height:100%;border-radius:${radius}px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:${el.kind === 'video' ? '#0b0f14' : '#e7edf4'}`
        if (el.kind === 'video' && el.poster) {
          const img = document.createElement('img')
          const posterSrc = assetSrc(doc, el.poster, opts.inlineData)
          if (posterSrc) img.src = posterSrc
          img.style.cssText = `width:100%;height:100%;object-fit:${cssFit(el.fit)};display:block`
          still.appendChild(img)
        } else {
          still.style.color = el.kind === 'video' ? '#ffffff' : '#5e7699'
          still.style.fontSize = '24px'
          still.textContent = el.kind === 'video' ? '▶' : '♪'
        }
        labelAsImage(still, el.alt)
        node.appendChild(still)
        break
      }
      const inert = opts.liveMedia ? '' : ';pointer-events:none'
      if (el.kind === 'audio') {
        // Render the browser's native <audio controls> AS-IS: it's already a
        // self-contained pill with its own surface. We add nothing behind it
        // and don't clip it to a radius (that just cut the control's own shape
        // and looked odd) — only centre it in the element box. Size the box to
        // the control's ~54px intrinsic height (defaultMedia audio uses 56).
        const audio = document.createElement('audio')
        const audioSrc = assetSrc(doc, el.src, opts.inlineData)
        if (audioSrc) audio.src = audioSrc
        audio.controls = el.controls !== false
        audio.loop = !!el.loop
        audio.preload = 'metadata'
        // OMITTED, not emptied, when autoplay is off. Reveal decides autoplay
        // with hasAttribute('data-autoplay') — presence, not value — so
        // data-autoplay="" made it play a clip the author had switched OFF
        // (reported 2026-08-22). Our own startMediaIn reads [data-autoplay="1"]
        // and was never the problem; Reveal simply gets there first.
        if (el.autoplay) audio.dataset.autoplay = '1'
        // a live player is a control, not a picture: label it, but never
        // role=img / aria-hidden it — its buttons must stay reachable
        if (el.alt) audio.setAttribute('aria-label', el.alt)
        audio.style.cssText = 'width:100%;display:block' + inert
        const wrap = document.createElement('div')
        wrap.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center'
        if (!el.src) {
          wrap.style.cssText += ';background:#eef2f7;border-radius:10px;color:#93a2b6;font-size:13px'
          wrap.textContent = '♪ ' + 'No audio source'
        } else wrap.appendChild(audio)
        node.appendChild(wrap)
        break
      }
      const video = document.createElement('video')
      const videoSrc = assetSrc(doc, el.src, opts.inlineData)
      if (videoSrc) video.src = videoSrc
      else if (el.src) video.dataset.beeslidesOffline = '1'
      const posterUrl = assetSrc(doc, el.poster ?? '', opts.inlineData)
      if (posterUrl) video.poster = posterUrl
      video.controls = el.controls !== false
      video.loop = !!el.loop
      video.muted = el.muted !== false
      video.playsInline = true
      video.preload = 'metadata'
      if (el.autoplay) video.dataset.autoplay = '1' // presence is the flag — see the audio case
      if (el.alt) video.setAttribute('aria-label', el.alt) // a control — see the audio case
      video.style.cssText = `width:100%;height:100%;object-fit:${cssFit(el.fit)};border-radius:${radius}px;display:block;background:#0b0f14` + inert
      if (!el.src) {
        const ph = document.createElement('div')
        ph.style.cssText = `width:100%;height:100%;border-radius:${radius}px;display:flex;align-items:center;justify-content:center;background:#0b0f14;color:#8fa0b6;font-size:14px`
        ph.textContent = '▶ No video source'
        node.appendChild(ph)
      } else {
        node.appendChild(video)
      }
      break
    }
    case 'chart': {
      // Static SVG snapshot everywhere; present mode swaps in a live ECharts
      // instance (mountLiveCharts) for tooltips/zoom. Kept as innerHTML so
      // print and thumbnails need no chart runtime at render time.
      node.dataset.chart = '1'
      // on the wrapper, not the svg: present mode swaps the svg for a live
      // chart (mountLiveCharts) and the label has to survive that
      labelAsImage(node, el.alt)
      node.innerHTML = chartSnapshotSvg(el)
      const csvg = node.querySelector('svg')
      if (csvg) {
        csvg.setAttribute('preserveAspectRatio', 'none')
        csvg.style.cssText = 'width:100%;height:100%;display:block'
      }
      break
    }
    case 'svg': {
      let markup = svgMarkup(el, doc)
      const vars = svgVarDecls(el)
      if (opts.svgAsImage) {
        // thumbnails: one <img> instead of thousands of svg nodes. An <img>
        // is its own document, so the vars cannot inherit from the frame —
        // they go in as the svg's own root rule (tokens only, see svgVarValue).
        // And it holds still: every thumbnail of an animated drawing kept
        // its CSS animations running, a full extra copy of the work per
        // slide in the sidebar. Paused, it shows a pose from mid-animation.
        const root = vars.length ? `:root{${vars.map(([k, v]) => `${k}:${v}`).join(';')}}` : ''
        const rule = `<style>${root}*{animation-play-state:paused!important}</style>`
        markup = markup.replace(/<svg\b[^>]*>/i, (open) => (open.endsWith('/>') ? open : open + rule))
        const img = document.createElement('img')
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
        img.draggable = false
        if (el.alt !== undefined) img.alt = el.alt
        if (el.alt === '') node.setAttribute('aria-hidden', 'true') // see the image case
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block'
        node.appendChild(img)
        break
      }
      // NOT innerHTML: this markup is author content, and assigning it ran
      // whatever the deck carried in a <script> or an onload — see sanitizeSvg.
      // The <img> branch above is inert already (an image is script-disabled),
      // which is why only this path changes.
      node.appendChild(sanitizeSvg(markup, `[data-el-id="${CSS.escape(el.id)}"]`))
      // on the frame, so they inherit into the artwork and its scoped css
      for (const [k, v] of vars) node.style.setProperty(k, v)
      labelAsImage(node, el.alt)
      const svg = node.querySelector('svg')
      if (svg) {
        svg.style.width = '100%'
        svg.style.height = '100%'
        svg.style.display = 'block'
        if (el.css) {
          const style = document.createElementNS(SVG_NS, 'style')
          // Same sheet, same policy: this lands in the very `<style>` element
          // sanitizeSvg cleans, so leaving `css` unfiltered would have left an
          // @import sitting beside the one that was just removed.
          style.textContent = scopeCss(sanitizeSvgCss(el.css), `[data-el-id="${CSS.escape(el.id)}"]`)
          svg.prepend(style)
        }
      }
      break
    }
    case 'code': {
      node.style.display = 'flex'
      node.style.flexDirection = 'column'
      node.style.justifyContent = VALIGN[el.valign]
      // Clip at the ELEMENT box — the size the author chose — and never at the
      // <pre> (see below). Code sets `white-space: pre`, so a long line does
      // not wrap and would otherwise run across the slide over whatever sits
      // beside it; bounding it to its own box keeps the author's layout
      // contract. The box is normally far larger than the lines inside it,
      // which is exactly the room a morphing token needs.
      node.style.overflow = 'hidden'
      const inner = document.createElement('pre')
      inner.className = 'beeslides-text-inner'
      inner.dir = 'auto'
      inner.style.fontSize = `${el.fontSize}px`
      inner.style.fontFamily = resolveFontFamily(el, doc, opts)
      inner.style.textAlign = el.align
      inner.style.lineHeight = String(el.lineHeight)
      inner.style.width = '100%'
      inner.style.color = el.color
      inner.classList.add('beeslides-code')
      inner.style.whiteSpace = 'pre'
      inner.style.margin = '0'
      // NOT overflow:hidden here. A <pre> is only as tall as its own lines,
      // and a morphing token starts at its position on the OTHER slide —
      // outside those bounds whenever the block gets shorter. Clipping at this
      // level painted a travelling token 48px below the box and cut it away:
      // it vanished for the first half of its journey and popped into view
      // mid-flight, and only in the direction where the code got shorter,
      // since the taller side had room for the same motion. That asymmetry is
      // what made it read as a pairing bug rather than a painting one.
      // Found in a screenshot — the DOM reported opacity 1, a correct 80px
      // transform and a sensible rect, all true, all outside a clipping box.
      if (!renderCodeInto(inner, el, doc)) {
        // Fallback to unformatted text
        inner.innerText = el.content
      }
      node.appendChild(inner)
      break
    }
    case 'math': {
      node.style.display = 'flex'
      node.style.flexDirection = 'column'
      node.style.justifyContent = VALIGN[el.valign] ?? 'center'
      const inner = document.createElement('div')
      inner.className = 'beeslides-math-inner'
      inner.style.fontSize = `${cssNum(el.fontSize, 48)}px`
      inner.style.color = cssColor(el.color, 'inherit')
      inner.style.textAlign = ALIGN[el.align as string] ?? 'center'
      inner.style.lineHeight = '1.2'
      inner.style.width = '100%'
      // An inline-block box: it is what measure.ts measures, and what
      // text-align moves. Styled inline (not in styles.css) so the static
      // layer and the no-JS preview lay it out the same way.
      const box = document.createElement('span')
      box.className = 'beeslides-math-box'
      box.style.display = 'inline-block'
      box.style.maxWidth = '100%'
      const tex = typeof el.tex === 'string' ? el.tex : ''
      const ml = tex.trim() ? renderTex(tex, !el.inline) : null
      if (ml) {
        box.innerHTML = ml
        // Temml writes `style="display:block math"` on a display formula,
        // which stretches it to the full width and ignores text-align. The
        // DISPLAY STYLE (big operators, full-size fractions) is math-style,
        // which the display="block" attribute keeps; only the box changes.
        const m = box.querySelector('math')
        if (m) (m as unknown as HTMLElement).style.display = 'inline math'
      } else if (tex.trim()) {
        // not valid TeX: the source, legibly, so the author sees what to fix
        box.classList.add('beeslides-math-error')
        box.style.cssText += ';font-family:ui-monospace,Menlo,Consolas,monospace;font-size:0.5em;' +
          'white-space:pre-wrap;text-decoration:underline wavy rgba(200,40,40,0.7);text-underline-offset:0.2em'
        box.textContent = tex
      } else if (!opts.hidePlaceholders) {
        // nothing typed yet: a dim prompt on the canvas, nothing in output
        box.classList.add('beeslides-math-empty')
        box.style.opacity = '0.38'
        box.textContent = '∑ ' + t('Equation')
      }
      inner.appendChild(box)
      node.appendChild(inner)
      break
    }
    case 'embed': {
      if (opts.svgAsImage || opts.inertEmbed) {
        // thumbnails / the static first-page preview / the full-deck static
        // layer: never mount a live, scripted iframe in any of them — a
        // cheap inert placeholder instead, same idiom as media's poster/icon
        // still above. Belt-and-suspenders with preview.ts's own BANNED
        // list, which strips any iframe that reached it regardless.
        const still = document.createElement('div')
        still.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
          'background:#0b0f14;color:#5e7699;font-size:24px'
        still.textContent = '◱'
        node.appendChild(still)
        break
      }
      const frame = document.createElement('iframe')
      // Fixed at ONE safe value, never taken from the model (see
      // model.ts EmbedElement) — allow-scripts only, so the content can run
      // JS and draw to a canvas but gets a null/opaque origin: no read/write
      // access to this document's cookies, localStorage or DOM, no form
      // submission, no top navigation, no popups.
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute('referrerpolicy', 'no-referrer')
      // Same reasoning as media: inert on the editor canvas so Selecto/
      // Moveable keep the click for selection; interactive only in present
      // mode (renderSlide is called with liveMedia:true there).
      frame.style.cssText = `width:100%;height:100%;display:block;border:0` +
        (opts.liveMedia ? '' : ';pointer-events:none')
      // A DOM property assignment, not string-built markup — el.html reaches
      // the iframe's own document as-is, with no attribute to break out of.
      frame.srcdoc = el.html ?? ''
      node.appendChild(frame)
      break
    }
    case 'zoom':
      renderZoomTile(node, el, doc, opts)
      break
  }
  // Every element type funnels through here, so this is the one place that
  // sees author markup after it has been built into DOM.
  stripRemoteRefs(node)
  applyFlip(node, el) // children exist now; applyElementFrame ran before they did
  return node
}

/**
 * A zoom tile: its cover slide (model.zoomCover) rendered nested and scaled
 * into the tile, contained in the slide's aspect (zoom.ts zoomTileRect — the
 * SAME rect the present-mode camera dives into), plus an optional frame.
 *
 * The nested render is a picture, never a second live slide: cheap stills for
 * svg/embed/media (as in thumbnails), and every `data-*` attribute and link
 * `href` stripped, so nothing that queries a surface by `data-el-id`,
 * `data-flip-id`, `data-link`, `data-slide-id` or build tags — selection,
 * morph, links, builds, find — can ever reach into it. It is `inert` and
 * `aria-hidden` (the tile itself is what a reader or a keyboard meets); ids
 * stay, because svg gradients paint through document-global `url(#…)`.
 * Depth >= 1 (a tile on a covered slide) draws a still box instead.
 */
function renderZoomTile(node: HTMLElement, el: ZoomElement, doc: SlidomingoDoc, opts: RenderOpts) {
  node.dataset.zoomTile = '1'
  const depth = opts.zoomDepth ?? 0
  const radius = cssNum(el.radius, 0)
  const box = document.createElement('div')
  box.className = 'beeslides-zoom-box'
  box.style.cssText = `position:relative;width:100%;height:100%;overflow:hidden;border-radius:${radius}px`
  const cover = zoomCover(doc, el)
  if (!cover) {
    // the editor says why the tile is empty; present/print just leave it empty
    if (!opts.hidePlaceholders) {
      box.classList.add('beeslides-zoom-missing')
      box.textContent = t('Zoom target missing')
    }
  } else if (depth >= 1) {
    box.classList.add('beeslides-zoom-still')
    box.style.background = cssColor(cover.background, '#d0d0d0', 200)
  } else {
    const r = zoomTileRect({ x: 0, y: 0, w: el.w, h: el.h }, doc.size)
    const inner = renderSlide(cover, doc, {
      svgAsImage: true, inertEmbed: true, staticMediaStill: true, hidePlaceholders: true,
      inlineData: opts.inlineData, stillTrails: opts.stillTrails, zoomDepth: depth + 1,
    })
    inner.classList.add('beeslides-zoom-inner')
    inner.style.position = 'absolute'
    inner.style.left = '0'
    inner.style.top = '0'
    inner.style.transformOrigin = '0 0'
    inner.style.transform = `translate(${r.x}px,${r.y}px) scale(${r.w / doc.size.width})`
    for (const n of [inner, ...inner.querySelectorAll('*')]) {
      for (const a of Array.from(n.attributes)) if (a.name.startsWith('data-')) n.removeAttribute(a.name)
      if (n.localName === 'a') n.removeAttribute('href')
      n.removeAttribute('tabindex')
    }
    inner.setAttribute('inert', '')
    inner.setAttribute('aria-hidden', 'true')
    box.appendChild(inner)
  }
  node.appendChild(box)
  const sw = cssNum(el.strokeWidth, 0, 200)
  if (sw > 0) {
    const frame = document.createElement('div')
    frame.className = 'beeslides-zoom-frame'
    frame.style.cssText = `position:absolute;inset:0;box-sizing:border-box;pointer-events:none;` +
      `border:${sw}px solid ${cssColor(el.stroke, '#ffffff')};border-radius:${radius}px`
    node.appendChild(frame)
  }
}

/**
 * The cascading font pair for whatever `Slide` is about to be rendered: the
 * `doc.layouts` entry governing it — itself, when `slide` IS a `doc.layouts`
 * entry (identity-by-id match, so editing a non-root slide type previews
 * with ITS OWN cascade, not its root's); else the entry a real slide's
 * `layoutId` names; else, for a slide with no `layoutId` at all,
 * `doc.rootFontLayoutId` (migration-only — see its doc comment in model.ts).
 * `fontFamily`/`headingFamily` each resolve INDEPENDENTLY nearest-wins up
 * that layout's `ancestorChain` — an unset field on one tier falls through
 * to the next ancestor that sets it, then to `doc.theme` in `renderElement`.
 */
export function resolveSlideFonts(doc: SlidomingoDoc, slide: Slide): { fontFamily?: string; headingFamily?: string } {
  const asLayout = doc.layouts?.find((l) => l.id === slide.id)
  const governingLayout = asLayout
    ?? (slide.layoutId ? doc.layouts?.find((l) => l.id === slide.layoutId) : undefined)
    ?? (doc.rootFontLayoutId ? doc.layouts?.find((l) => l.id === doc.rootFontLayoutId) : undefined)
  if (!governingLayout) return {}
  const chain = ancestorChain(doc, governingLayout)
  const nearest = (pick: (l: Slide) => string | undefined): string | undefined => {
    for (let i = chain.length - 1; i >= 0; i--) {
      const v = pick(chain[i])
      if (v) return v
    }
    return undefined
  }
  return { fontFamily: nearest((l) => l.fontFamily), headingFamily: nearest((l) => l.headingFamily) }
}

/** Render a full slide surface (background + elements) at model coordinates. */
export function renderSlide(slide: Slide, doc: SlidomingoDoc, opts: RenderOpts = {}): HTMLElement {
  const size = opts.size ?? doc.size
  const surface = document.createElement('div')
  surface.className = 'beeslides-slide'
  surface.dataset.slideId = slide.id
  surface.style.width = `${size.width}px`
  surface.style.height = `${size.height}px`
  // A CSS `background` shorthand straight from the deck: the colour rule at
  // the shorthand's length (the one untrusted.ts applies to a paste), so a
  // gradient draws and `url(https://…)` — a fetch past offline mode — does not.
  surface.style.background = cssColor(slide.background, '', 200)
  // Palette slots as custom properties, for rich-text runs coloured
  // `var(--sl-accent1)` (sanitizeRunColor): such a run follows a re-brand
  // with no rewrite of any text. An empty slot is simply not defined, and
  // the run then inherits the element's own colour.
  const palette = doc.theme ? paletteOf(doc) : null
  for (const slot of palette ? PALETTE_SLOTS : []) {
    const v = palette![slot]
    if (v) surface.style.setProperty(`--sl-${slot}`, v)
  }
  const ctx = slideRenderContext(slide, doc, opts)
  for (const el of slide.elements) {
    const node = renderSlideElement(el, doc, ctx)
    if (!node) continue
    const loop = el.fx?.loop
    if (opts.stillTrails && loop?.type === 'motion-path' && loop.trail !== false && !el.showOnHover) {
      surface.appendChild(renderMotionTrail(el, loop.path, size))
    }
    surface.appendChild(node)
  }
  return surface
}

/** What `renderSlide` works out once per slide and hands every element: the
 *  field values, the slide type's fonts, the footer pieces switched off. */
export interface SlideRenderContext {
  /** the element options: the caller's, with fields/fonts/fieldMarkers filled */
  opts: RenderOpts
  fields: FieldContext
  fonts: { fontFamily?: string; headingFamily?: string }
  footerOff: Set<FooterRole>
  /** the slide is a `doc.layouts` entry (a slide type) */
  isType: boolean
}

export function slideRenderContext(slide: Slide, doc: SlidomingoDoc, opts: RenderOpts = {}): SlideRenderContext {
  const fields = opts.fields ?? fieldContext(doc, slide, opts.language || undefined)
  const fonts = opts.fonts ?? resolveSlideFonts(doc, slide)
  // A slide type (the Layout Manager's surface, its thumbnails) is where the
  // footer is designed: a switched-off piece stays visible there, dimmed.
  const isType = !!doc.layouts?.some((l) => l.id === slide.id)
  const fieldMarkers = opts.fieldMarkers === true ? (isType ? 'name' : 'value') : opts.fieldMarkers
  const footerOff = footerHidden(doc, slide)
  return { opts: { ...opts, fields, fonts, fieldMarkers }, fields, fonts, footerOff, isType }
}

/** One element of a slide surface exactly as `renderSlide` draws it, or null
 *  when the surface leaves it out (hidden, a footer piece switched off). The
 *  editor canvas re-renders single elements through this (canvas.ts render). */
export function renderSlideElement(el: SlideElement, doc: SlidomingoDoc, ctx: SlideRenderContext): HTMLElement | null {
  if (el.hidden && !ctx.opts.showHidden) return null
  const off = el.type === 'text' && !!el.footerRole && ctx.footerOff.has(el.footerRole)
  if (off && !ctx.isType) return null
  const node = renderElement(el, doc, ctx.opts)
  if (off) node.classList.add('beeslides-el-footer-off')
  return node
}

/** Dotted route of a motion-path element for static output (which never runs
 *  the animation). GSAP offsets the element by the path's points, so its centre
 *  traces `centre + path`. `path` is already validated by untrusted.ts. */
function renderMotionTrail(el: SlideElement, path: string, size: { width: number; height: number }): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(size.width))
  svg.setAttribute('height', String(size.height))
  svg.setAttribute('style', `position:absolute;left:0;top:0;width:${size.width}px;height:${size.height}px;overflow:visible;pointer-events:none`)
  svg.setAttribute('data-motion-trail', el.id)
  const g = document.createElementNS(NS, 'g')
  g.setAttribute('transform', `translate(${el.x + el.w / 2},${el.y + el.h / 2})`)
  const p = document.createElementNS(NS, 'path')
  const stroke = el.type === 'shape' ? el.stroke || el.fill : el.type === 'text' ? el.color : ''
  p.setAttribute('d', path)
  p.setAttribute('fill', 'none')
  p.setAttribute('stroke', stroke && stroke !== 'transparent' ? stroke : '#888')
  p.setAttribute('stroke-width', '2')
  p.setAttribute('stroke-dasharray', '2 6')
  p.setAttribute('stroke-linecap', 'round')
  p.setAttribute('opacity', '.4')
  g.appendChild(p)
  svg.appendChild(g)
  return svg
}

/** Scaled-down live preview used for sidebar thumbnails. */
export function renderThumbnail(slide: Slide, doc: SlidomingoDoc, width: number, opts: RenderOpts = {}): HTMLElement {
  const scale = width / doc.size.width
  const box = document.createElement('div')
  box.className = 'beeslides-thumb-surface'
  box.style.width = `${width}px`
  box.style.height = `${doc.size.height * scale}px`
  const inner = renderSlide(slide, doc, { svgAsImage: true, ...opts })
  inner.style.transformOrigin = '0 0'
  inner.style.transform = `scale(${scale})`
  box.appendChild(inner)
  return box
}

/** Axis-aligned bounding box of a set of elements. Ignores rotation — an
 *  acceptable approximation for a thumbnail crop, never used anywhere
 *  precision-sensitive. `null` for an empty set. */
function elementsBoundingBox(elements: SlideElement[]): { x: number; y: number; w: number; h: number } | null {
  if (!elements.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const el of elements) {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.w)
    maxY = Math.max(maxY, el.y + el.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Crop padding (model px) around a reusable object's own content — see
 *  `renderObjectThumbnail`. */
const OBJECT_THUMB_PAD = 32

/**
 * Thumbnail for a `doc.reusableObjects` entry, cropped TIGHTLY to its own
 * elements' bounding box (+padding) rather than rendering the whole
 * (much bigger) authoring canvas scaled down to a near-invisible speck.
 * Builds a translated `Slide` (elements shifted so the box's top-left sits
 * at the padding origin) plus a `doc` clone whose `size` IS the crop box,
 * then defers to the ordinary `renderThumbnail()` unmodified — no changes
 * needed to the shared renderer itself. An empty object (no elements) falls
 * back to a fixed placeholder box.
 */
export function renderObjectThumbnail(obj: Slide, doc: SlidomingoDoc, width: number): HTMLElement {
  const box = elementsBoundingBox(obj.elements)
  if (!box) {
    const empty = document.createElement('div')
    empty.className = 'beeslides-thumb-surface ed-objectthumb-empty'
    empty.style.width = `${width}px`
    empty.style.height = `${Math.round(width * 0.6)}px`
    return empty
  }
  const w = box.w + OBJECT_THUMB_PAD * 2
  const h = box.h + OBJECT_THUMB_PAD * 2
  const translated: Slide = {
    ...obj,
    elements: obj.elements.map((el) => ({ ...el, x: el.x - box.x + OBJECT_THUMB_PAD, y: el.y - box.y + OBJECT_THUMB_PAD })),
  }
  const cropDoc: SlidomingoDoc = { ...doc, size: { width: w, height: h } }
  return renderThumbnail(translated, cropDoc, width)
}
