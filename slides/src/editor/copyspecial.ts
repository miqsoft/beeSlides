// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Copy special: the selected objects (or, with none, the whole slide) onto
// the system clipboard in ONE chosen format, so the app it is pasted into
// cannot pick a different one (copyspecialmenu.ts is the ⇧⌘C / right-click
// popup):
//   powerpoint — PowerPoint's own drawing package (kernel/src/convert/gvml.ts):
//              text, shapes, pictures, tables and groups paste as native,
//              editable objects, anything else as a picture of it; + a PNG
//              of the whole selection for other apps. Desktop app only: a
//              browser cannot write that clipboard type (main/officeclip.ts)
//   picture  — image/png + text/html (an <img> of that PNG with its size on
//              the slide: what a browser's own "Copy image" writes; PowerPoint
//              pastes this one, at that size) + image/svg+xml where the
//              browser can write it, for design tools
//   png      — image/png only
//   svg      — image/svg+xml only (Chromium/Electron; PowerPoint for Mac
//              does not paste SVG from the clipboard, checked by hand)
//   svgCode  — the SVG as text/plain, for a code editor
//   html     — text, tables and code as HTML whose formatting is written
//              inline (Word, mail, Google Docs keep it editable), every
//              other object as an <img>, in reading order; + text/plain
// Pictures come from svgexport.ts. Our own ⌘C payload is text
// (clipboard.ts); a copy event cannot carry an image, so this rides the
// async clipboard. The items are promises so the write starts inside the
// click's or key's user activation (Safari refuses one started after an
// await) while the content is still rendering.
//
// Size: a slide is taken as 7.5 in tall (PowerPoint's own slide height for
// 16:9 and 4:3), a figure at its 96 dpi. Not as a PNG pHYs chunk: Chromium
// re-encodes clipboard images and drops it.

import type { Slide, SlidomingoDoc, SlideElement } from '../model'
import { renderSlide } from '../render'
import { emuPerPxFor, writeGvml } from '../../../kernel/src/convert/gvml.ts'
import type { WElement } from '../../../kernel/src/convert/drawingml-write.ts'
import { exportFigureSvg } from '../svgexport'
import { PNG_MAX_SIDE, altText, drawPicture, nativeContext, pictureArea, rasterize, toNative, withFonts, type Area } from './officeshapes'
import { t } from '../i18n'
import { lsJson, lsSetJson } from '../../../kernel/src/storage.ts'

export type CopyFormat = 'powerpoint' | 'picture' | 'png' | 'svg' | 'svgCode' | 'html'
export const COPY_FORMATS: readonly CopyFormat[] = ['powerpoint', 'picture', 'png', 'svg', 'svgCode', 'html']

/** Settings ▸ Copy special. Per browser, never in the document. */
export interface CopyPrefs {
  /** PNG pixels per slide px */
  scale: 1 | 2 | 4
  /** a selection on the slide's background colour instead of transparent */
  background: boolean
  /** SVG text as outlines (needs the network once for the font reader) */
  outlineText: boolean
}
const PREFS_KEY = 'slidomingo-copy-special-v1'
const PREF_DEFAULTS: CopyPrefs = { scale: 2, background: false, outlineText: false }

export function copyPrefs(): CopyPrefs {
  const p = lsJson<Partial<CopyPrefs>>(PREFS_KEY, {})
  return {
    scale: p.scale === 1 || p.scale === 4 ? p.scale : PREF_DEFAULTS.scale,
    background: typeof p.background === 'boolean' ? p.background : PREF_DEFAULTS.background,
    outlineText: typeof p.outlineText === 'boolean' ? p.outlineText : PREF_DEFAULTS.outlineText,
  }
}
export function setCopyPrefs(patch: Partial<CopyPrefs>): void {
  lsSetJson(PREFS_KEY, { ...copyPrefs(), ...patch })
}

export function copyFormatLabel(f: CopyFormat): string {
  return f === 'powerpoint' ? t('PowerPoint') : f === 'picture' ? t('Picture') : f === 'png' ? t('PNG') : f === 'svg' ? t('SVG') : f === 'svgCode' ? t('SVG code') : t('HTML')
}
export function copyFormatHint(f: CopyFormat): string {
  return f === 'powerpoint' ? (canCopyFormat('powerpoint') ? t('Editable shapes and text') : t('In the desktop app'))
    : f === 'picture' ? t('For PowerPoint, Keynote, Google Slides')
    : f === 'png' ? t('Only the image')
    : f === 'svg' ? (canCopyFormat('svg') ? t('Vector, for Figma, Illustrator, Inkscape') : t('This browser cannot copy SVG'))
    : f === 'svgCode' ? t('As text, for a code editor')
    : t('Editable text, for Word, mail, Google Docs')
}
export function canCopyFormat(f: CopyFormat): boolean {
  if (f === 'powerpoint') return !!window.slidomingoDesktop?.copyOffice
  if (typeof ClipboardItem !== 'function' || !navigator.clipboard?.write) return false
  return f !== 'svg' || !!ClipboardItem.supports?.('image/svg+xml')
}
function copiedToast(f: CopyFormat): string {
  return f === 'powerpoint' ? t('Copied for PowerPoint — paste it there as editable shapes')
    : f === 'picture' ? t('Copied as a picture — paste it into PowerPoint, Keynote or Google Slides')
    : f === 'png' ? t('Copied as PNG') : f === 'svg' ? t('Copied as SVG')
    : f === 'svgCode' ? t('Copied the SVG code') : t('Copied as HTML')
}

/** Write `els` (null = the whole slide) to the clipboard as `format`. Resolves
 *  to the toast to show; rejects when the clipboard refuses or nothing can be
 *  drawn. */
export function copySpecial(format: CopyFormat, doc: SlidomingoDoc, slide: Slide, els: SlideElement[] | null): Promise<string> {
  if (!canCopyFormat(format)) return Promise.reject(new Error(`cannot copy ${format}`))
  const prefs = copyPrefs()
  if (format === 'powerpoint') {
    // main writes the clipboard (no user activation needed there)
    return buildPowerPoint(doc, slide, els, prefs).then(async (b) => {
      const r = await window.slidomingoDesktop!.copyOffice!({ gvml: b.gvml, png: b.png })
      if ('refused' in r) throw new Error(r.error)
      return b.warnings[0] ?? copiedToast(format)
    })
  }
  let items: Record<string, Promise<Blob>>
  let done: Promise<string[]>
  if (format === 'html') {
    const built = buildHtml(doc, slide, els, prefs)
    items = { 'text/html': built.then((h) => h.html), 'text/plain': built.then((h) => h.text) }
    done = built.then((h) => h.warnings)
  } else {
    const built = buildPicture(doc, slide, els, prefs)
    const blob = (k: 'png' | 'html' | 'svg') => built.then((p) => p[k])
    items = format === 'picture' ? { 'image/png': blob('png'), 'text/html': blob('html') }
      : format === 'png' ? { 'image/png': blob('png') }
      : format === 'svg' ? { 'image/svg+xml': blob('svg') }
      : { 'text/plain': built.then((p) => new Blob([p.svgText], { type: 'text/plain' })) }
    if (format === 'picture' && canCopyFormat('svg')) items['image/svg+xml'] = blob('svg')
    done = built.then((p) => p.warnings)
  }
  return navigator.clipboard.write([new ClipboardItem(items)]).then(() => done).then((w) => w[0] ?? copiedToast(format))
}

// ---- pictures ---------------------------------------------------------------------

/** Inches per slide px. */
const inchPerPx = (doc: SlidomingoDoc): number => (doc.kind === 'figure' ? 1 / 96 : 7.5 / doc.size.height)

/** The ids a selection draws: a container brings its children (flat
 *  elements with a parentId). Hidden ones never draw. */
function drawnIds(slide: Slide, els: SlideElement[]): Set<string> {
  const ids = new Set(els.map((e) => e.id))
  for (const e of slide.elements) if (e.parentId && ids.has(e.parentId)) ids.add(e.id)
  for (const e of slide.elements) if (e.hidden) ids.delete(e.id)
  return ids
}

async function buildPicture(doc: SlidomingoDoc, slide: Slide, els: SlideElement[] | null, prefs: CopyPrefs) {
  const W = doc.size.width
  const H = doc.size.height
  let only: Set<string> | undefined
  let area: Area = { x: 0, y: 0, w: W, h: H }
  if (els) {
    only = drawnIds(slide, els)
    const picked = slide.elements.filter((e) => only!.has(e.id))
    if (!picked.length) throw new Error('nothing visible to copy')
    area = pictureArea(picked)
  }
  const inch = inchPerPx(doc)
  const size = { width: `${round(area.w * inch * 72)}pt`, height: `${round(area.h * inch * 72)}pt` }
  const background = !els || prefs.background
  const { svg, warnings } = await exportFigureSvg(doc, slide, { only, area, size, background, outlineText: prefs.outlineText })

  const scale = Math.min(prefs.scale, PNG_MAX_SIDE / Math.max(area.w, area.h))
  const png = await rasterize(withFonts(doc, svg), Math.max(1, Math.round(area.w * scale)), Math.max(1, Math.round(area.h * scale)))
  const alt = els ? els.map(altText).filter(Boolean).join(' ') : ''
  const html = imgTag(await dataUrl(png), area.w * inch * 96, area.h * inch * 96, alt)
  return {
    png,
    html: new Blob([html], { type: 'text/html' }),
    svg: new Blob([svg], { type: 'image/svg+xml' }),
    svgText: svg,
    warnings,
  }
}

// ---- PowerPoint ---------------------------------------------------------------------

/** The package for PowerPoint (native where the writer can, a picture of
 *  the rest) and a PNG of the whole selection for every other app. */
async function buildPowerPoint(doc: SlidomingoDoc, slide: Slide, els: SlideElement[] | null, prefs: CopyPrefs) {
  const ids = drawnIds(slide, els ?? slide.elements)
  const picked = slide.elements.filter((e) => ids.has(e.id))
  if (!picked.length) throw new Error('nothing visible to copy')
  const ctx = nativeContext(doc, slide)
  const out: WElement[] = []
  const warnings: string[] = []
  for (const el of picked) {
    // an empty placeholder is only a prompt on the canvas
    if (el.type === 'text' && el.placeholder && !el.html.replace(/<[^>]*>/g, '').trim()) continue
    const native = toNative(el, doc, ctx)
    if (native) { out.push(native); continue }
    const drawn = await drawPicture(doc, slide, el, { scale: prefs.scale, outlineText: prefs.outlineText })
    if (!drawn) continue
    warnings.push(...drawn.warnings)
    out.push(drawn.picture)
  }
  const emuPerPx = doc.kind === 'figure' ? 9525 : emuPerPxFor(doc.size.height)
  const g = await writeGvml(out, { emuPerPx, theme: doc.theme })
  const pic = await buildPicture(doc, slide, els, prefs)
  return { gvml: g.bytes, png: new Uint8Array(await pic.png.arrayBuffer()), warnings: [...warnings, ...g.warnings] }
}

// ---- HTML -------------------------------------------------------------------------

/** Element types whose content stays editable HTML; everything else is a picture. */
const HTML_TYPES = new Set(['text', 'table', 'code'])

async function buildHtml(doc: SlidomingoDoc, slide: Slide, els: SlideElement[] | null, prefs: CopyPrefs) {
  const ids = drawnIds(slide, els ?? slide.elements)
  // reading order: top to bottom, then left to right; a container's frame is
  // decoration, its children carry the content
  const picked = slide.elements
    .filter((e) => ids.has(e.id) && !(e.type === 'shape' && e.container))
    .sort((a, b) => a.y - b.y || a.x - b.x)
  if (!picked.length) throw new Error('nothing visible to copy')
  const inch = inchPerPx(doc)
  const ptPerPx = inch * 72

  // off-screen but rendered: innerText (the plain-text flavour) is empty
  // under visibility:hidden
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;opacity:0'
  const surface = renderSlide(slide, doc, { hidePlaceholders: true, inlineData: true })
  host.appendChild(surface)
  document.body.appendChild(host)
  const parts: string[] = []
  const texts: string[] = []
  const warnings: string[] = []
  try {
    await document.fonts?.ready
    for (const el of picked) {
      const node = surface.querySelector<HTMLElement>(`.beeslides-el[data-el-id="${CSS.escape(el.id)}"]`)
      if (!node || node.style.display === 'none') continue
      if (HTML_TYPES.has(el.type)) {
        const src = el.type === 'table' ? node.querySelector('table') : node.querySelector('.beeslides-text-inner')
        if (!src) continue
        const html = inlineStyled(src, ptPerPx)
        parts.push(el.type === 'code' ? `<pre style="margin:0 0 12pt;white-space:pre-wrap">${html}</pre>` : html)
        texts.push(el.type === 'table' ? tableText(src) : (src as HTMLElement).innerText.trim())
      } else {
        const one = await exportFigureSvg(doc, slide, {
          only: new Set([el.id]), area: pictureArea([el]), background: false, outlineText: prefs.outlineText,
        }).catch(() => null)
        if (!one) continue
        warnings.push(...one.warnings)
        const a = pictureArea([el])
        const scale = Math.min(prefs.scale, PNG_MAX_SIDE / Math.max(a.w, a.h))
        const png = await rasterize(withFonts(doc, one.svg), Math.max(1, Math.round(a.w * scale)), Math.max(1, Math.round(a.h * scale)))
        parts.push(`<p>${imgTag(await dataUrl(png), a.w * inch * 96, a.h * inch * 96, altText(el))}</p>`)
      }
    }
  } finally {
    host.remove()
  }
  return {
    html: new Blob([`<meta charset="utf-8">${parts.join('\n')}`], { type: 'text/html' }),
    text: new Blob([texts.filter(Boolean).join('\n\n')], { type: 'text/plain' }),
    warnings,
  }
}

/** Tags other apps understand; anything else is unwrapped to its children. */
const KEEP_TAGS = new Set([
  'P', 'DIV', 'SPAN', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'SUB', 'SUP', 'A', 'CODE',
  'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'IMG',
])
/** Inherited text styles, written where they differ from the parent. */
const TEXT_PROPS = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration-line', 'background-color'] as const
/** Box styles a table keeps. */
const CELL_PROPS = ['border-top', 'border-right', 'border-bottom', 'border-left', 'padding', 'vertical-align', 'text-align', 'width', 'background-color'] as const

/** `src` (laid out on the page) as standalone HTML: classes and data
 *  attributes dropped, the computed text and table styles written inline,
 *  px font sizes as slide pt. MathML is kept as it is. */
function inlineStyled(src: Element, ptPerPx: number): string {
  const css = (cs: CSSStyleDeclaration, p: string): string => {
    const v = cs.getPropertyValue(p)
    if (p === 'font-size') return `${round(parseFloat(v) * ptPerPx)}pt`
    return v
  }
  const walk = (node: Node, parent: CSSStyleDeclaration | null): string => {
    if (node.nodeType === Node.TEXT_NODE) return esc(node.textContent ?? '')
    if (!(node instanceof Element)) return ''
    if (node.localName === 'math') {
      const m = node.cloneNode(true) as Element
      for (const n of [m, ...m.querySelectorAll('*')]) for (const a of [...n.attributes]) if (a.name === 'class' || a.name.startsWith('data-')) n.removeAttribute(a.name)
      return m.outerHTML
    }
    const cs = getComputedStyle(node)
    const inner = [...node.childNodes].map((c) => walk(c, cs)).join('')
    const tag = node.tagName
    if (!KEEP_TAGS.has(tag)) return inner
    const style: string[] = []
    for (const p of TEXT_PROPS) {
      const v = css(cs, p)
      if (p === 'background-color' && (v === 'rgba(0, 0, 0, 0)' || v === 'transparent')) continue
      if (p === 'text-decoration-line' && v === 'none') continue
      if (!parent || v !== css(parent, p)) style.push(`${p}:${v}`)
    }
    if (!parent) style.push(`text-align:${cs.textAlign}`, `line-height:${round(parseFloat(cs.lineHeight) * ptPerPx) || 'normal'}${Number.isFinite(parseFloat(cs.lineHeight)) ? 'pt' : ''}`, 'margin:0 0 12pt')
    if (tag === 'TABLE') style.push('border-collapse:collapse')
    if (tag === 'TD' || tag === 'TH') for (const p of CELL_PROPS) style.push(`${p}:${cs.getPropertyValue(p)}`)
    const attrs: string[] = []
    if (style.length) attrs.push(`style="${escAttr(style.join(';'))}"`)
    if (tag === 'A') { const href = node.getAttribute('href'); if (href) attrs.push(`href="${escAttr(href)}"`) }
    if (tag === 'TD' || tag === 'TH') for (const a of ['colspan', 'rowspan']) { const v = node.getAttribute(a); if (v) attrs.push(`${a}="${escAttr(v)}"`) }
    if (tag === 'IMG') {
      const r = node.getBoundingClientRect()
      attrs.push(`src="${escAttr((node as HTMLImageElement).src)}"`, `width="${round(r.width)}"`, `height="${round(r.height)}"`)
    }
    const name = tag.toLowerCase()
    return tag === 'BR' || tag === 'IMG' ? `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}>` : `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</${name}>`
  }
  return walk(src, null)
}

function tableText(table: Element): string {
  return [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td,th')].map((c) => (c as HTMLElement).innerText.trim()).join('\t')).join('\n')
}

// ---- helpers ----------------------------------------------------------------------

function imgTag(src: string, cssW: number, cssH: number, alt: string): string {
  return `<img src="${src}" width="${round(cssW)}" height="${round(cssH)}" alt="${escAttr(alt)}">`
}

function dataUrl(b: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result))
    r.onerror = () => fail(r.error)
    r.readAsDataURL(b)
  })
}

const round = (n: number): number => Math.round(n * 100) / 100
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
