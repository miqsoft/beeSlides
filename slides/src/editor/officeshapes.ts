// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Slide elements as the DrawingML writer (kernel/src/convert/drawingml-write.ts)
// takes them — shared by Copy special ▸ PowerPoint (copyspecial.ts) and the
// .pptx export (pptxexport.ts). Text, shapes, png/jpeg/gif pictures and
// tables go natively; everything else (charts, svg, code, math, media, $…$
// text) as a PNG of it that svgexport.ts draws.
//
// The writer has no DOM and knows nothing of the deck, so what the renderer
// works out is settled here: fields, a slide type's fonts, palette-slot
// run colours (`var(--sl-accent1)`), asset refs.

import type { Slide, SlidomingoDoc, SlideElement } from '../model'
import { fieldContext, resolveFields, resolveSlideFonts, sanitizeHtml } from '../render'
import { paletteOf, type Palette } from '../palette'
import { SLIDE_NUMBER, type WElement, type WPicture } from '../../../kernel/src/convert/drawingml-write.ts'
import { exportFigureSvg } from '../svgexport'
import { fontFaceCss } from '../fonts'

export type Area = { x: number; y: number; w: number; h: number }

export const PNG_MAX_SIDE = 8192

const MATH_RE = /\$[^$\n]+\$/

/** What every element of one surface (a slide or a slide type) shares. */
export interface NativeContext {
  fields: ReturnType<typeof fieldContext>
  fonts: { fontFamily?: string; headingFamily?: string }
  palette: Palette
  /** write {{page}} as PowerPoint's slide-number field (a .pptx; the clipboard has no slide to count) */
  pageField?: boolean
}

export function nativeContext(doc: SlidomingoDoc, surface: Slide, pageField = false): NativeContext {
  return { fields: fieldContext(doc, surface), fonts: resolveSlideFonts(doc, surface), palette: paletteOf(doc), pageField }
}

/** The face render.ts resolveFontFamily draws: the element's own, else the
 *  slide type's, else the deck's — a title prefers the heading face. */
function fontOf(el: { fontFamily: string; role?: string }, doc: SlidomingoDoc, ctx: NativeContext): string {
  const heading = el.role === 'title'
  return el.fontFamily ||
    (heading ? ctx.fonts.headingFamily : undefined) || ctx.fonts.fontFamily ||
    (heading ? doc.theme.headingFamily : undefined) || doc.theme.fontFamily
}

/** Rich html as the writer reads it: fields resolved, sanitized, palette slots as their colours. */
function richHtml(html: string, ctx: NativeContext): string {
  const marked = ctx.pageField ? html.replace(/\{\{\s*page\s*\}\}/gi, SLIDE_NUMBER) : html
  return sanitizeHtml(resolveFields(marked, ctx.fields))
    .replace(/var\(\s*--sl-([A-Za-z0-9]+)\s*\)/g, (all, slot: string) => (slot in ctx.palette ? ctx.palette[slot as keyof Palette] : undefined) ?? all)
}

/** The element as the writer takes it natively, or null: draw a picture of it. */
export function toNative(el: SlideElement, doc: SlidomingoDoc, ctx: NativeContext): WElement | null {
  switch (el.type) {
    case 'text': {
      // $…$ is typeset math: PowerPoint gets it as a picture
      if (MATH_RE.test(el.html)) return null
      return { ...el, html: richHtml(el.html, ctx), fontFamily: fontOf(el, doc, ctx) } as unknown as WElement
    }
    case 'shape': return el as unknown as WElement
    case 'image': {
      const src = el.src.startsWith('asset:') ? doc.assets?.[el.src.slice(6)] ?? '' : el.src
      if (!/^data:image\/(png|jpeg|gif)[;,]/i.test(src)) return null
      return { ...el, src } as unknown as WElement
    }
    case 'table': {
      if (el.rows.some((r) => r.cells.some((c) => MATH_RE.test(c.html)))) return null
      const style = { ...el.style, fontFamily: el.style.fontFamily || ctx.fonts.fontFamily || doc.theme.fontFamily }
      return { ...el, style, rows: el.rows.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, html: richHtml(c.html, ctx) })) })) } as unknown as WElement
    }
    default: return null
  }
}

/** A PNG of one element of `surface` at its painted area, `scale` × slide px. */
export async function drawPicture(doc: SlidomingoDoc, surface: Slide, el: SlideElement, o: { scale: number; outlineText?: boolean }): Promise<{ picture: WPicture; warnings: string[] } | null> {
  const a = pictureArea([el])
  const one = await exportFigureSvg(doc, surface, { only: new Set([el.id]), area: a, background: false, outlineText: o.outlineText }).catch(() => null)
  if (!one) return null
  const scale = Math.min(o.scale, PNG_MAX_SIDE / Math.max(a.w, a.h))
  const png = await rasterize(withFonts(doc, one.svg), Math.max(1, Math.round(a.w * scale)), Math.max(1, Math.round(a.h * scale)))
  return {
    picture: { type: 'picture', id: el.id, ...a, groupId: el.groupId, png: new Uint8Array(await png.arrayBuffer()), alt: altText(el) },
    warnings: one.warnings,
  }
}

/** The elements' rotated bounding box, grown by what they paint outside it
 *  (shadows, blur, strokes), in whole slide px. */
export function pictureArea(els: SlideElement[]): Area {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of els) {
    const shadows = Array.isArray(e.shadow) ? e.shadow : e.shadow ? [e.shadow] : []
    const stroke = 'strokeWidth' in e && typeof e.strokeWidth === 'number' ? e.strokeWidth / 2 : 0
    const pad = Math.max(1, stroke, (e.blur ?? 0) * 2,
      ...shadows.map((s) => s.blur + Math.max(Math.abs(s.x ?? 0), Math.abs(s.y ?? 0))))
    const a = ((e.rotation || 0) * Math.PI) / 180
    const cos = Math.abs(Math.cos(a))
    const sin = Math.abs(Math.sin(a))
    const hw = (e.w * cos + e.h * sin) / 2 + pad
    const hh = (e.w * sin + e.h * cos) / 2 + pad
    const cx = e.x + e.w / 2
    const cy = e.y + e.h / 2
    x0 = Math.min(x0, cx - hw); y0 = Math.min(y0, cy - hh)
    x1 = Math.max(x1, cx + hw); y1 = Math.max(y1, cy + hh)
  }
  const x = Math.floor(x0)
  const y = Math.floor(y0)
  return { x, y, w: Math.max(1, Math.ceil(x1) - x), h: Math.max(1, Math.ceil(y1) - y) }
}

/** An <img> sees no page stylesheet: the deck's embedded fonts go inside. */
export function withFonts(doc: SlidomingoDoc, svg: string): string {
  const fonts = fontFaceCss(doc)
  return fonts ? svg.replace(/<svg\b[^>]*>/, (open) => `${open}<style><![CDATA[${fonts.replace(/]]>/g, '')}]]></style>`) : svg
}

export async function rasterize(svg: string, w: number, h: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
    return await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('toBlob failed'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function altText(e: SlideElement): string {
  if (e.type === 'text') return e.html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  if (e.type === 'math') return e.tex ?? ''
  return 'alt' in e && typeof e.alt === 'string' ? e.alt : ''
}
