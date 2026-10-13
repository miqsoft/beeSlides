// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Figure mode actions (docs/DECISIONS.md, "Figure mode"): export a figure as
// vector SVG / exact-size PDF, and crop its canvas to its content. The SVG is
// built by svgexport.ts; the PDF is Chromium's own print of the 1:1 render
// (text stays fonts, shapes stay paths) — via a hidden window on desktop
// (exportFigure IPC) or the print dialog in the browser build.

import { inLinearFlow, pxToUnit, type SlidomingoDoc, type SlideElement } from '../model'
import { renderSlide } from '../render'
import { exportFigureSvg } from '../svgexport'
import { applyHoverDefault } from '../staticlayer'
import { t } from '../i18n'
import type { Store } from '../store'

const fileStem = (doc: SlidomingoDoc): string => (doc.title || 'figure').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'figure'

function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Everything the app's stylesheets say, so a detached page renders elements exactly as the canvas does. */
function allCss(): string {
  return Array.from(document.styleSheets)
    .map((sh) => { try { return Array.from(sh.cssRules).map((r) => r.cssText).join('\n') } catch { return '' } })
    .join('\n')
}

/** A self-contained page holding the figure at 1:1, sized to the figure. */
export function figurePrintHtml(doc: SlidomingoDoc): string {
  const { width: w, height: h } = doc.size
  const surface = renderSlide(doc.slides[0], doc, { hidePlaceholders: true, inlineData: true })
  return `<!doctype html><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">` +
    `<style>${allCss()}</style>` +
    `<style>@page{size:${w}px ${h}px;margin:0}html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent}` +
    `.slidomingo-slide{position:relative;overflow:hidden;-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>` +
    `<body>${surface.outerHTML}`
}

/** Page geometry of a deck PDF: width normalised to 1600, the deck's aspect kept. */
export function deckPdfSize(doc: SlidomingoDoc): { w: number; h: number } {
  return { w: 1600, h: Math.round((1600 * doc.size.height) / doc.size.width) }
}

/** A self-contained print page of the deck: one page per slide in the linear flow. */
export function deckPrintHtml(doc: SlidomingoDoc): string {
  const { w, h } = deckPdfSize(doc)
  const s = w / doc.size.width
  const pages: string[] = []
  for (const slide of doc.slides) {
    if (!inLinearFlow(slide)) continue
    const surface = renderSlide(slide, doc, { svgAsImage: true, hidePlaceholders: true, inlineData: true, stillTrails: true })
    surface.style.transformOrigin = '0 0'
    if (s !== 1) surface.style.transform = `scale(${s})`
    const page = document.createElement('div')
    page.className = 'bp-page'
    page.appendChild(surface)
    applyHoverDefault(page, slide) // showOnHover sets must not print stacked
    pages.push(page.outerHTML)
  }
  return `<!doctype html><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">` +
    `<style>${allCss()}</style>` +
    `<style>@page{size:${w}px ${h}px;margin:0}html,body{margin:0;padding:0;background:transparent}` +
    `.bp-page{position:relative;width:${w}px;height:${h}px;overflow:hidden;break-after:page;page-break-after:always;-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
    `.bp-page:last-child{break-after:auto;page-break-after:auto}</style>` +
    `<body>${pages.join('')}`
}

/** Desktop: the whole deck as a PDF straight to the native Save dialog. False = not available here (use the print path). */
export async function exportDeckAsPdfDesktop(doc: SlidomingoDoc, toast: (m: string) => void): Promise<boolean> {
  const api = window.slidomingoDesktop
  if (!api?.exportFigure) return false
  const { w, h } = deckPdfSize(doc)
  const r = await api.exportFigure({ kind: 'pdf', html: deckPrintHtml(doc), widthPx: w, heightPx: h, suggestedName: `${fileStem(doc)}.pdf` })
  if ('error' in r) toast(t('Export failed: {m}', { m: r.error }))
  else if ('ok' in r) toast(t('Exported PDF'))
  return true
}

export async function exportFigureAsSvg(doc: SlidomingoDoc, opts: { outlineText: boolean }, toast: (m: string) => void): Promise<void> {
  toast(t('Building SVG…'))
  const { svg, warnings } = await exportFigureSvg(doc, doc.slides[0], opts)
  const name = `${fileStem(doc)}.svg`
  const api = window.slidomingoDesktop
  if (api?.exportFigure) {
    const r = await api.exportFigure({ kind: 'svg', svg, suggestedName: name })
    if ('error' in r) { toast(t('Export failed: {m}', { m: r.error })); return }
    if ('cancelled' in r) return
  } else {
    download(name, svg, 'image/svg+xml')
  }
  toast(warnings.length ? t('Exported SVG — note: {w}', { w: warnings.join(' · ') }) : t('Exported SVG'))
}

/** Desktop: exact-size vector PDF through main. False = not available here (use the print path). */
export async function exportFigureAsPdfDesktop(doc: SlidomingoDoc, toast: (m: string) => void): Promise<boolean> {
  const api = window.slidomingoDesktop
  if (!api?.exportFigure) return false
  const r = await api.exportFigure({
    kind: 'pdf', html: figurePrintHtml(doc), widthPx: doc.size.width, heightPx: doc.size.height, suggestedName: `${fileStem(doc)}.pdf`,
  })
  if ('error' in r) toast(t('Export failed: {m}', { m: r.error }))
  else if ('ok' in r) toast(t('Exported PDF'))
  return true
}

/** Corners of an element's rotated box → axis-aligned bounds. */
function bounds(el: SlideElement): { x0: number; y0: number; x1: number; y1: number } {
  const pad = el.type === 'shape' ? (el.shape === 'line' ? Math.max(el.strokeWidth, 2) : el.strokeWidth) / 2 : 0
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2
  const a = ((el.rotation || 0) * Math.PI) / 180
  const cos = Math.cos(a), sin = Math.sin(a)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const ox = (dx * (el.w / 2 + pad)), oy = (dy * (el.h / 2 + pad))
    const x = cx + ox * cos - oy * sin, y = cy + ox * sin + oy * cos
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  return { x0, y0, x1, y1 }
}

/** Crop the canvas to the content plus `marginPx`, moving every element so nothing changes relative to anything else. */
export function fitCanvasToContent(store: Store, marginPx: number, toast: (m: string) => void): void {
  const els = store.slide.elements
  if (!els.length) { toast(t('Nothing to fit — the canvas is empty')); return }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const el of els) {
    const b = bounds(el)
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1)
  }
  const dx = marginPx - x0, dy = marginPx - y0
  const width = Math.max(1, Math.round(x1 - x0 + 2 * marginPx))
  const height = Math.max(1, Math.round(y1 - y0 + 2 * marginPx))
  store.commit(() => {
    for (const el of els) { el.x = Math.round((el.x + dx) * 100) / 100; el.y = Math.round((el.y + dy) * 100) / 100 }
    const doc = store.doc
    doc.size = { width, height }
    const unit = doc.figure?.unit ?? 'mm'
    const round = (v: number) => Math.round(v * 10) / 10
    doc.figure = { unit, width: round(pxToUnit(width, unit)), height: round(pxToUnit(height, unit)) }
  })
}
