// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The shared insert-element button set — Text, Shape (full menu), Image,
// Media, Table, Chart, Code, Embed, Icons, Objects. Used by BOTH the main
// editor topbar (web + the desktop ribbon, which used to keep two
// hand-maintained copies of this list) and the Layout Manager's Slide types
// and Objects panes. "Objects" is the one "Insert object…" picker over both
// scopes — this deck's objects and the global library (reusableobjects.ts).
// Managing the library itself is NOT an insert action: its panel is an
// editor-toolbar button only (editor.ts, librarypanel.ts), since the library
// is not part of the document the Layout Manager edits.
//
// Every action here only ever touches `canvas.insert(...)`/`store.slide`/
// `store.doc` — no other Editor-only state — so the SAME buttons work
// unmodified against a reparented SlideCanvas/Store pair editing a master's
// building blocks or a `doc.layouts[]` entry: `store.slide` is already
// redirected there (store.ts's enterBuildingBlocksEdit/enterLayoutEdit), the
// same mechanism that already made Slide Master mode work.
//
// Format Painter, Reapply Change and Comment are deliberately NOT part of
// this group — they're workflow tools tied to "the currently/recently
// selected element" on the main editing canvas, not simple insertion (and
// Comment is explicitly excluded from masters/layouts elsewhere — see
// contextmenu.ts). Callers layer those on top where they make sense.

import type { Store } from '../store'
import { effectiveCanvasSize } from '../store'
import { SlideCanvas } from './canvas'
import {
  applyChartPalette, defaultChart, defaultCode, defaultEmbed, defaultImage, defaultMedia, defaultShape, defaultTable, defaultText,
  isLightBg, MEDIA_EMBED_BUDGET, readableInk, shapeDefaultsFor, textDefaultsFor,
  type ShapeKind, type StyleShapeKind, type TableElement,
} from '../model'
import { CHART_PRESETS } from '../charts'
import { ICONS } from '../icons'
import { t } from '../i18n'
import { flipMenuIfNeeded } from './floatingposition'
import { openIconSearchPopover } from './iconlibrary'
import { openReusableObjectPicker } from './reusableobjects'
import { readImageFile } from './elementactions'
import { PRESET_CATEGORIES, SHAPE_PRESETS, type ShapePreset } from './shapepresets'

export const SHAPE_MENU: Array<{ kind: ShapeKind; label: string; icon: string; draw?: 'line' | 'path' | 'connector' | 'free' | 'poly'; tip: string }> = [
  { kind: 'rect', label: 'Rectangle', icon: ICONS.rect, tip: 'A rectangle — rounded corners, fills, gradients and shadows in the panel' },
  { kind: 'ellipse', label: 'Ellipse', icon: ICONS.ellipse, tip: 'An ellipse or circle' },
  { kind: 'triangle', label: 'Triangle', icon: ICONS.triangle, tip: 'A triangle' },
  { kind: 'arrow', label: 'Arrow', icon: ICONS.arrow, tip: 'A solid arrow shape' },
  { kind: 'line', label: 'Line', icon: ICONS.line, draw: 'line', tip: 'Drag on the slide to draw a straight line — drag its endpoints to adjust' },
  { kind: 'path', label: 'Curved line', icon: ICONS.curve, draw: 'path', tip: 'Drag to draw a curve — then drag its points; double-click to add or remove one' },
  { kind: 'line', label: 'Connector', icon: ICONS.connector, draw: 'connector', tip: 'Drag between two elements — the ends snap on and re-route when they move' },
  { kind: 'path', label: 'Freeform', icon: ICONS.freeform, draw: 'free', tip: 'Draw by hand — the stroke smooths into an editable curve' },
  { kind: 'path', label: 'Polygon', icon: ICONS.polygon, draw: 'poly', tip: 'Click to place corners; click the first point (or double-click) to close the shape' },
]

export interface InsertGroup {
  text: HTMLElement
  shape: HTMLElement
  image: HTMLElement
  media: HTMLElement
  table: HTMLElement
  chart: HTMLElement
  code: HTMLElement
  embed: HTMLElement
  icons: HTMLElement
  objects: HTMLElement
  math: HTMLElement
}

/** Canonical flat order — Text, Shape, Image, Media, Table, Chart, Code,
 *  Embed, Icons, Objects — for a caller (the Layout
 *  Manager) that wants one toolbar rather than the desktop ribbon's
 *  finer-grained groupings. */
export function insertGroupList(g: InsertGroup): HTMLElement[] {
  return [g.text, g.shape, g.image, g.media, g.table, g.chart, g.code, g.math, g.embed, g.icons, g.objects]
}

/** Build the shared insert-element buttons against `store`/`canvas` — safe to
 *  call against any SlideCanvas/Store pair, including the Layout Manager's
 *  reparented one (see file header). */
export function buildInsertGroup(store: Store, canvas: SlideCanvas): InsertGroup {
  const text = btn(ICONS.text, t('Text'),
    () => insertText(store, canvas),
    t('Add a text box — double-click it to edit; **bold**, *italic*, `code` and “- ” bullets format as you type'))

  const shape = shapeDropdown(store, canvas)

  const image = btn(ICONS.image, t('Image'), () => pickImage(store, canvas),
    t('Add an image — or just paste one (⌘V) straight onto the slide'))

  const media = mediaDropdown(store, canvas)

  const table = btn(ICONS.table, t('Table'), () => insertTable(store, canvas),
    t('Add a table — edit cells inline; turn it into a live chart from the panel'))

  const chart = btn(ICONS.chart, t('Chart'), () => insertChart(store, canvas),
    t('Add a chart — edit it visually or link it to a table so it updates live'))

  const code = btn(ICONS.code, t('Code'), () => insertCode(store, canvas),
    t('Add a code snippet'))

  const embed = btn(ICONS.embed, t('Embed'), () => insertEmbed(canvas),
    t('Add a sandboxed HTML embed — scripts and canvas run, but it can’t read this page, navigate it, or open popups'))

  const icons = btn(ICONS.sparkle, t('Icons'), (ev) => openIconSearchPopover(store, ev.currentTarget as HTMLElement, (el) => canvas.insert(el)),
    t('Search and insert an icon'))

  const objects = btn(ICONS.objects, t('Objects'), (ev) => openReusableObjectPicker(store, ev.currentTarget as HTMLElement),
    t('Insert object… — from this deck’s objects or your library'))

  const math = btn(ICONS.equation, t('Equation'), () => insertMath(),
    t('Add an equation — type LaTeX or pick from the palette; it typesets as you type'))

  // UI profile ids (customize/catalog.ts TOOLBAR_ITEMS): a profile hides and orders them by CSS
  const group = { text, shape, image, media, table, chart, code, embed, icons, objects, math }
  for (const [id, el] of Object.entries(group)) el.dataset.uiTool = id
  return group
}

// ---- the actions themselves — shared by the buttons here and the native menu
// commands (editor/commands.ts), so Insert ▸ … can never drift from the ribbon.

export function insertText(store: Store, canvas: SlideCanvas) {
  canvas.insert(defaultText({ ...textDefaultsFor(store.doc, store.slide), y: 120 + Math.random() * 200 }), true)
}

export function insertChart(store: Store, canvas: SlideCanvas) {
  canvas.insert(defaultChart(applyChartPalette(CHART_PRESETS.bar(), store.doc.theme)))
}

export function insertCode(store: Store, canvas: SlideCanvas) {
  canvas.insert(defaultCode({ color: readableInk(store.slide.background) }), true)
}

export function insertEmbed(canvas: SlideCanvas) {
  canvas.insert(defaultEmbed())
}

/** Open the equation popover for a NEW equation: the element is created by
 *  its commit, so cancelling inserts nothing (canvas.startMathEdit). */
export function insertMath() {
  document.dispatchEvent(new CustomEvent('slidomingo:edit-math', { detail: {} }))
}

export function insertTable(store: Store, canvas: SlideCanvas) {
  canvas.insert(newTable(store))
}

export function insertShape(store: Store, canvas: SlideCanvas, item: (typeof SHAPE_MENU)[number]) {
  // line / curve / connector arm a draw tool — drag on the canvas to draw
  // (or click to drop a default); other shapes insert straight away.
  if (item.draw) { canvas.armDraw(item.draw); return }
  // the slide type's default look (Layout Manager ▸ Default styles)
  canvas.insert(defaultShape(item.kind, shapeDefaultsFor(store.doc, store.slide, item.kind as StyleShapeKind)))
}

/** Insert a gallery preset (shapepresets.ts) — an ordinary `path` shape at
 *  the preset's default size, centred, in the slide type's default closed-
 *  shape look (the same `shapeDefaultsFor(…, 'path')` the Polygon tool uses).
 *  Nothing remembers it was a preset: it saves and edits as a plain path. */
export function insertPresetShape(store: Store, canvas: SlideCanvas, preset: ShapePreset) {
  const [w, h] = preset.size
  // centre on the surface being edited (a reusable object's canvas is larger)
  const { width: dw, height: dh } = effectiveCanvasSize(store)
  canvas.insert(defaultShape('path', {
    ...shapeDefaultsFor(store.doc, store.slide, 'path'),
    x: Math.round((dw - w) / 2), y: Math.round((dh - h) / 2), w, h,
    d: preset.path(w, h), pathBox: [0, 0, w, h],
  }))
}

function shapeDropdown(store: Store, canvas: SlideCanvas): HTMLElement {
  const wrap = div('ed-dropdown')
  const menu = div('ed-menu ed-shape-menu')
  const trigger = btn(ICONS.shapes, t('Shape'), () => {
    wrap.classList.toggle('open')
    if (wrap.classList.contains('open')) flipMenuIfNeeded(wrap, menu)
  }, t('Insert a shape'))
  // two columns: the basic shapes + draw tools as before, the preset
  // gallery beside them (it wraps underneath when the menu is narrow)
  const basic = div('ed-shape-basic')
  for (const item of SHAPE_MENU) {
    const b = btn(item.icon, t(item.label), () => {
      wrap.classList.remove('open')
      insertShape(store, canvas, item)
    }, t(item.tip))
    basic.appendChild(b)
  }
  menu.append(basic, shapeGallery((preset) => {
    wrap.classList.remove('open')
    insertPresetShape(store, canvas, preset)
  }))
  wrap.append(trigger, menu)
  document.addEventListener('pointerdown', (ev) => {
    if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
  })
  return wrap
}

/** The preset gallery: one titled grid of small previews per category. */
function shapeGallery(onPick: (preset: ShapePreset) => void): HTMLElement {
  const gallery = div('ed-shape-gallery')
  for (const cat of PRESET_CATEGORIES) {
    const head = div('ed-menu-sep-label')
    head.textContent = t(cat.label)
    const grid = div('ed-shape-grid')
    grid.setAttribute('role', 'group')
    grid.setAttribute('aria-label', t(cat.label))
    for (const p of SHAPE_PRESETS) {
      if (p.category !== cat.id) continue
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-shape-tile'
      b.dataset.preset = p.id
      b.title = t(p.label)
      b.setAttribute('aria-label', t(p.label))
      b.innerHTML = presetPreview(p)
      b.addEventListener('click', () => onPick(p))
      grid.appendChild(b)
    }
    gallery.append(head, grid)
  }
  return gallery
}

/** A preset drawn by its own generator at preview scale (longest side 100,
 *  centred in a square), so the tile shows the shape's real proportions. */
function presetPreview(p: ShapePreset): string {
  const k = 100 / Math.max(p.size[0], p.size[1])
  const w = p.size[0] * k
  const h = p.size[1] * k
  return `<svg viewBox="${-(100 - w) / 2 - 5} ${-(100 - h) / 2 - 5} 110 110" aria-hidden="true">`
    + `<path d="${p.path(w, h)}" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`
}

export function pickImage(store: Store, canvas: SlideCanvas) {
  void readImageFile().then((picked) => {
    if (!picked) return
    const { width: dw, height: dh } = store.doc.size
    const scale = Math.min((dw * 0.5) / picked.width, (dh * 0.5) / picked.height, 1)
    const w = Math.round(picked.width * scale)
    const h = Math.round(picked.height * scale)
    canvas.insert(defaultImage(picked.src, { w, h, x: (dw - w) / 2, y: (dh - h) / 2 }))
  })
}

/** Media insert menu: a file (embeds) or a link (stays a URL — keeps the
 *  deck small; good for big clips that shouldn't ride inside the file). */
function mediaDropdown(store: Store, canvas: SlideCanvas): HTMLElement {
  const wrap = div('ed-dropdown')
  const menu = div('ed-menu')
  const trigger = btn(ICONS.media, t('Media'), () => {
    wrap.classList.toggle('open')
    if (wrap.classList.contains('open')) flipMenuIfNeeded(wrap, menu)
  }, t('Add video or audio — from a file (embeds it) or a link (stays a URL)'))
  const item = (label: string, title: string, onClick: () => void) => {
    menu.appendChild(btn(ICONS.media, t(label), () => { wrap.classList.remove('open'); onClick() }, t(title)))
  }
  item('Video or audio file…', 'Insert a video or audio file from your device', () => pickMedia(store, canvas))
  item('Video from a link…', 'Insert a video by linking to its URL instead of embedding it', () => promptMediaUrl(store, canvas, 'video'))
  item('Audio from a link…', 'Insert audio by linking to its URL instead of embedding it', () => promptMediaUrl(store, canvas, 'audio'))
  wrap.append(trigger, menu)
  document.addEventListener('pointerdown', (ev) => {
    if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
  })
  return wrap
}

/** Insert a media element that REFERENCES a URL (not embedded). */
export function promptMediaUrl(store: Store, canvas: SlideCanvas, kind: 'video' | 'audio') {
  // t(kind), not kind: 'video'/'audio' are model words here, and dropping
  // them raw into a translated sentence leaves one English noun in it.
  const url = window.prompt(t('Paste the {kind} URL — it stays a link, the file is not embedded:', { kind: t(kind) }))?.trim()
  if (!url) return
  insertMedia(store, canvas, kind, url)
}

export function pickMedia(store: Store, canvas: SlideCanvas) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'video/*,audio/*'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    const kind: 'video' | 'audio' = file.type.startsWith('audio') ? 'audio' : 'video'
    if (file.size > MEDIA_EMBED_BUDGET) {
      const mb = Math.round(file.size / (1024 * 1024))
      const ok = confirm(t(
        'This {kind} is {mb} MB. Embedding keeps it inside the .beeslides.html but makes the file large and slow to open and save.\n\nEmbed anyway? (Cancel, then paste a hosted URL in the panel to keep the deck small.)',
        { kind: t(kind), mb }, // localise the noun — see promptMediaUrl
      ))
      if (!ok) { insertMedia(store, canvas, kind, ''); return } // empty element → panel URL field
    }
    const reader = new FileReader()
    reader.onload = () => insertMedia(store, canvas, kind, String(reader.result))
    reader.readAsDataURL(file)
  })
  input.click()
}

/** Insert a media element, sizing video to its intrinsic aspect when known. */
function insertMedia(store: Store, canvas: SlideCanvas, kind: 'video' | 'audio', src: string) {
  const { width: dw, height: dh } = store.doc.size
  if (kind === 'audio' || !src) {
    const w = kind === 'audio' ? 460 : 560
    const h = kind === 'audio' ? 56 : 315
    canvas.insert(defaultMedia(kind, src, { w, h, x: (dw - w) / 2, y: (dh - h) / 2 }))
    return
  }
  const probe = document.createElement('video')
  const place = (w: number, h: number) =>
    canvas.insert(defaultMedia('video', src, { w: Math.round(w), h: Math.round(h), x: (dw - w) / 2, y: (dh - h) / 2 }))
  probe.preload = 'metadata'
  probe.onloadedmetadata = () => {
    const ar = probe.videoWidth && probe.videoHeight ? probe.videoWidth / probe.videoHeight : 16 / 9
    const w = Math.min(dw * 0.6, 640)
    place(w, w / ar)
  }
  probe.onerror = () => place(560, 315)
  probe.src = src
}

/** A themed table adapted to the current slide. Dark backgrounds need light
 *  body text and separators; the theme still owns the header treatment. */
function newTable(store: Store): TableElement {
  const tbl = defaultTable({}, store.doc.theme)
  if (!isLightBg(store.slide.background)) {
    tbl.style.color = readableInk(store.slide.background)
    tbl.style.zebra = 'rgba(255,255,255,0.06)'
    tbl.style.borderColor = 'rgba(255,255,255,0.16)'
  }
  return tbl
}

// tiny DOM helpers (each editor/*.ts file keeps its own copy — see editor.ts)
function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}
function btn(icon: string, label: string, onClick: (ev: MouseEvent) => void, title?: string): HTMLElement {
  const b = document.createElement('button')
  b.className = 'ed-btn'
  b.innerHTML = label ? `${icon}<span>${label}</span>` : icon
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}
