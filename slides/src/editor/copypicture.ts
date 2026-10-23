// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Copy for PowerPoint: the selected objects (or, with none, the whole slide)
// onto the system clipboard as a PICTURE other apps paste:
//   - image/png      — everywhere (PowerPoint, Keynote, Word, Google Slides)
//   - text/html      — an <img> of that PNG with its size on the slide: what
//                      a browser's own "Copy image" writes. PowerPoint pastes
//                      this one, at that size
//   - image/svg+xml  — the vector (svgexport.ts) for design tools, only where
//                      the browser can write it (ClipboardItem.supports).
//                      PowerPoint for Mac does not paste SVG from the clipboard
// Our own ⌘C payload is text (clipboard.ts); a copy event cannot carry an
// image, so this rides the async clipboard from a menu click. The items are
// promises so the write starts inside the click's user activation (Safari
// refuses one started after an await) while the picture is still rendering.
//
// Size: a slide is taken as 7.5 in tall (PowerPoint's own slide height for
// 16:9 and 4:3), a figure at its 96 dpi. Not as a PNG pHYs chunk: Chromium
// re-encodes clipboard images and drops it.

import type { Slide, SlidomingoDoc, SlideElement } from '../model'
import { exportFigureSvg } from '../svgexport'
import { fontFaceCss } from '../fonts'

type Area = { x: number; y: number; w: number; h: number }

/** Supersampling of the PNG against slide px, capped so a big slide stays a sane image. */
const PNG_SCALE = 2
const PNG_MAX_SIDE = 8192

export interface CopyPictureResult { warnings: string[] }

/** Write `els` (null = the whole slide) to the clipboard. Rejects when the
 *  clipboard refuses or the picture cannot be drawn. */
export function copyPicture(doc: SlidomingoDoc, slide: Slide, els: SlideElement[] | null): Promise<CopyPictureResult> {
  if (typeof ClipboardItem !== 'function' || !navigator.clipboard?.write) return Promise.reject(new Error('no async clipboard'))
  const built = buildPicture(doc, slide, els)
  const items: Record<string, Promise<Blob>> = {
    'image/png': built.then((p) => p.png),
    'text/html': built.then((p) => p.html),
  }
  if (ClipboardItem.supports?.('image/svg+xml')) items['image/svg+xml'] = built.then((p) => p.svg)
  return navigator.clipboard.write([new ClipboardItem(items)]).then(() => built).then((p) => ({ warnings: p.warnings }))
}

async function buildPicture(doc: SlidomingoDoc, slide: Slide, els: SlideElement[] | null) {
  const W = doc.size.width
  const H = doc.size.height
  let only: Set<string> | undefined
  let area: Area = { x: 0, y: 0, w: W, h: H }
  if (els) {
    only = new Set(els.map((e) => e.id))
    // a container brings its children (flat elements with a parentId)
    for (const e of slide.elements) if (e.parentId && only.has(e.parentId)) only.add(e.id)
    const picked = slide.elements.filter((e) => only!.has(e.id) && !e.hidden)
    if (!picked.length) throw new Error('nothing visible to copy')
    area = pictureArea(picked)
  }
  // inches per slide px
  const inch = doc.kind === 'figure' ? 1 / 96 : 7.5 / H
  const size = { width: `${round(area.w * inch * 72)}pt`, height: `${round(area.h * inch * 72)}pt` }
  const { svg, warnings } = await exportFigureSvg(doc, slide, { only, area, size })

  const scale = Math.min(PNG_SCALE, PNG_MAX_SIDE / Math.max(area.w, area.h))
  const pxW = Math.max(1, Math.round(area.w * scale))
  const pxH = Math.max(1, Math.round(area.h * scale))
  // an <img> sees no page stylesheet: the deck's embedded fonts go inside
  const fonts = fontFaceCss(doc)
  const rasterSvg = fonts ? svg.replace(/<svg\b[^>]*>/, (open) => `${open}<style><![CDATA[${fonts.replace(/]]>/g, '')}]]></style>`) : svg
  const png = await rasterize(rasterSvg, pxW, pxH)
  const alt = els ? els.map(altText).filter(Boolean).join(' ') : ''
  const html = `<img src="${await dataUrl(png)}" width="${round(area.w * inch * 96)}" height="${round(area.h * inch * 96)}" alt="${escAttr(alt)}">`
  return {
    png,
    html: new Blob([html], { type: 'text/html' }),
    svg: new Blob([svg], { type: 'image/svg+xml' }),
    warnings,
  }
}

/** The elements' rotated bounding box, grown by what they paint outside it
 *  (shadows, blur, strokes), in whole slide px. */
function pictureArea(els: SlideElement[]): Area {
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

async function rasterize(svg: string, w: number, h: number): Promise<Blob> {
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

function dataUrl(b: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result))
    r.onerror = () => fail(r.error)
    r.readAsDataURL(b)
  })
}

function altText(e: SlideElement): string {
  if (e.type === 'text') return e.html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  return 'alt' in e && typeof e.alt === 'string' ? e.alt : ''
}

const round = (n: number): number => Math.round(n * 100) / 100
const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
