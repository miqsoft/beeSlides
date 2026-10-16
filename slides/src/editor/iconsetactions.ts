// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon-set actions (docs/DECISIONS.md, "Icon sets", "Icon styles"): add
// icons, change the set's style, "Apply set style", "Draw with AI", one
// comment on several icons, the extra styles (add, learn, describe with AI)
// and the two exports. The pure parts (style patch, SVG, manifest) are
// in ../iconset.ts; this file is the editor glue.

import { ICONSET_STYLE_DEFAULTS, iconsetStyleDefaults, newIconSlide, uid, type IconLook, type IconsetInfo, type IconsetStyle, type ShapeElement, type SlidomingoDoc } from '../model'
import { ICON_MANIFEST_FILE, iconFileNames, iconManifest, iconSlideSvg, iconStylePatch, iconsetInfo, iconsToDraw, iconSlug, isNoPaint, styleFolderNames } from '../iconset'
import { iconLookSvg, learnLookFromIcon, learnLookFromSvgStats, safeColor, type SvgPaintStat } from '../iconstyles'
import { writeZip } from '../../../kernel/src/convert/zip.ts'
import { askText, commentAuthor, sendCommentsToClaude } from './comments'
import { t } from '../i18n'
import type { Store } from '../store'

/** The set's settings, written back whole (the theme's new-shape look follows).
 *  Call inside a commit. */
export function writeIconsetInfo(doc: SlidomingoDoc, info: IconsetInfo): void {
  doc.iconset = info
  doc.theme.color = info.style.color
  doc.theme.styleDefaults = iconsetStyleDefaults(info)
}

/** The set's info with `style` patched (ICONSET_STYLE_DEFAULTS fill the gaps). */
export function withStyle(info: IconsetInfo, patch: Partial<IconsetStyle>): IconsetInfo {
  return { ...info, style: { ...ICONSET_STYLE_DEFAULTS, ...info.style, ...patch } }
}

function restyle(store: Store, info: IconsetInfo, slideIds: readonly string[]): number {
  let n = 0
  for (const s of store.doc.slides) {
    if (!slideIds.includes(s.id)) continue
    for (const el of s.elements) {
      const p = iconStylePatch(el, info)
      if (p) { Object.assign(el as ShapeElement, p); n++ }
    }
  }
  return n
}

/** "Apply set style" to these icons: stroke, caps, joins and ink from the set. One undo step. */
export function applyIconsetStyle(store: Store, slideIds: readonly string[]): number {
  const info = iconsetInfo(store.doc)
  if (!info) return 0
  let n = 0
  store.commit(() => { n = restyle(store, info, slideIds) })
  return n
}

/** Ask for icon names (one per line) and add an empty icon for each after `at`. */
export async function addIcons(store: Store, at: number): Promise<number> {
  const raw = await askText({
    title: t('Add icons'),
    placeholder: t('One name per line, e.g.\nfingerprint\nevidence bag\nhash'),
    okLabel: t('Add'),
  })
  const names = (raw ?? '').split(/\n|,/).map((s) => s.trim()).filter(Boolean).slice(0, 200)
  if (!names.length) return 0
  const slides = names.map((n) => newIconSlide(n))
  store.commit(() => { store.doc.slides.splice(at, 0, ...slides) })
  store.goTo(at)
  return slides.length
}

/** One empty icon after `at` (Enter in the slide list, the + button). */
export function addOneIcon(store: Store, at: number): void {
  const slide = newIconSlide(t('icon'))
  store.commit(() => { store.doc.slides.splice(at, 0, slide) })
  store.goTo(at)
}

/** "Plan with AI": the user's request, in their words, to Claude — it writes
 *  the plan as empty, named icons (agent `icons` op "plan") and draws nothing. */
export function planIconsWithAi(store: Store, request: string): boolean {
  const send = window.slidomingoDesktop?.sendAgentPrompt
  const info = iconsetInfo(store.doc)
  if (!send || !info || !request.trim()) return false
  send('plan-icons', { request: request.trim(), brief: info.brief ?? '' })
  return true
}

/** "Draw with AI": the selected icons (several), else every empty one, to Claude. */
export function drawIconsWithAi(store: Store, selectedIds: readonly string[]): number {
  const send = window.slidomingoDesktop?.sendAgentPrompt
  const info = iconsetInfo(store.doc)
  if (!send || !info) return 0
  const todo = iconsToDraw(store.doc, selectedIds)
  if (!todo.length) return 0
  const index = new Map(store.doc.slides.map((s, i) => [s.id, i + 1]))
  send('draw-icons', {
    brief: info.brief ?? '',
    icons: todo.map((s) => ({ slide: index.get(s.id), slideId: s.id, name: s.name ?? '', prompt: s.icon?.prompt ?? '' })),
  })
  return todo.length
}

/** One comment, written once, on each of these icons; with `send`, straight to Claude. */
export async function commentOnIcons(store: Store, slideIds: readonly string[], send: boolean): Promise<number> {
  if (!slideIds.length) return 0
  const text = await askText({
    title: (slideIds.length === 1 ? t('Comment on this icon') : t('Comment on {n} icons', { n: slideIds.length }))
      + (store.shownLook ? ` · ${t('In the style “{name}”', { name: store.shownLook.name })}` : ''),
    placeholder: t('e.g. thinner details, rounder corners, more like the others'),
    okLabel: send && window.slidomingoDesktop?.sendAgentPrompt ? t('Send to Claude') : t('Comment'),
  })
  if (!text?.trim()) return 0
  const ids = new Set<string>()
  const at = new Date().toISOString()
  const author = commentAuthor()
  // with a style shown, the comment is about the icons in that style
  const look = store.shownLook
  store.commit(() => {
    for (const s of store.doc.slides) {
      if (!slideIds.includes(s.id)) continue
      const id = uid('cmt')
      ids.add(id)
      ;(s.comments ??= []).push({ id, author, text: text.trim(), at, ...(look ? { look: look.id } : {}) })
    }
  })
  if (send) sendCommentsToClaude(store, ids)
  return ids.size
}

// ---- export ---------------------------------------------------------------------------

/** What an export could not draw, in words (iconSlideSvg's `skipped`). */
function skippedNote(kinds: Set<string>): string {
  const parts: string[] = []
  if ([...kinds].some((k) => k !== 'line-ending' && k !== 'gradient')) parts.push(t('only shapes are icon material — text, pictures and other objects were left out'))
  if (kinds.has('line-ending')) parts.push(t('arrowheads on lines were left out'))
  if (kinds.has('gradient')) parts.push(t('gradients were exported as their solid colour'))
  return parts.join(' · ')
}

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

/** Every file of the exported set: one SVG per icon, the same again in a
 *  folder per extra style, icons.json, LICENSE.txt. */
export function iconSetFiles(store: Store): { files: Array<{ name: string; text: string }>; skipped: Set<string> } {
  const doc = store.doc
  const names = iconFileNames(doc.slides)
  const skipped = new Set<string>()
  const files = doc.slides.map((s, i) => {
    const r = iconSlideSvg(doc, s, { title: true })
    r.skipped.forEach((k) => skipped.add(k))
    return { name: names[i], text: r.svg }
  })
  const looks = iconsetInfo(doc)?.variants ?? []
  const folders = styleFolderNames(looks.map((l) => l.name))
  looks.forEach((look, k) => {
    doc.slides.forEach((s, i) => {
      const r = iconLookSvg(doc, s, look, { title: true })
      r.skipped.forEach((x) => skipped.add(x))
      files.push({ name: `${folders[k]}/${names[i]}`, text: r.svg })
    })
  })
  const styles = looks.map((l, k) => ({ name: l.name, folder: folders[k] }))
  files.push({ name: ICON_MANIFEST_FILE, text: JSON.stringify(iconManifest(doc, names, styles), null, 2) + '\n' })
  const info = iconsetInfo(doc)
  if (info?.license) {
    const by = info.author ? `\n${t('Author: {a}', { a: info.author })}` : ''
    files.push({ name: 'LICENSE.txt', text: `${doc.title}\n${t('License: {l}', { l: info.license })}${by}\n` })
  }
  return { files, skipped }
}

/** "Export set…": desktop writes a folder (pick where); the browser downloads a .zip. */
export async function exportIconSet(store: Store, toast: (m: string) => void): Promise<void> {
  const { files, skipped } = iconSetFiles(store)
  const stem = iconSlug(store.doc.title || 'icons')
  const note = skipped.size ? ` — ${skippedNote(skipped)}` : ''
  const api = window.slidomingoDesktop
  if (api?.exportIconset) {
    const r = await api.exportIconset({ folderName: store.doc.title || stem, files })
    if ('error' in r) { toast(t('Export failed: {m}', { m: r.error })); return }
    if ('cancelled' in r) return
    toast(exportedMsg(store) + ` — ${r.path}` + note)
    return
  }
  const enc = new TextEncoder()
  const zip = await writeZip(files.map((f) => ({ name: `${stem}/${f.name}`, data: enc.encode(f.text) })))
  download(`${stem}.zip`, zip as BlobPart, 'application/zip')
  toast(exportedMsg(store) + note)
}

function exportedMsg(store: Store): string {
  const n = store.doc.slides.length
  const styles = iconsetInfo(store.doc)?.variants?.length ?? 0
  return styles ? t('Exported {n} icons in {k} styles', { n, k: styles + 1 }) : t('Exported {n} icons', { n })
}

/** Export ▸ "This icon as SVG". */
export async function exportOneIcon(store: Store, toast: (m: string) => void): Promise<void> {
  const slide = store.slide
  const { svg, skipped } = iconSlideSvg(store.doc, slide, { title: true })
  const name = iconFileNames([slide])[0]
  const note = skipped.length ? ` — ${skippedNote(new Set(skipped))}` : ''
  const api = window.slidomingoDesktop
  if (api?.exportFigure) {
    const r = await api.exportFigure({ kind: 'svg', svg, suggestedName: name })
    if ('error' in r) { toast(t('Export failed: {m}', { m: r.error })); return }
    if ('cancelled' in r) return
  } else {
    download(name, svg, 'image/svg+xml')
  }
  toast(t('Exported SVG') + note)
}

/** The icon at real size for the panel's preview strip (ink as the set colour,
 *  never currentColor black; `ink` shows it in another, e.g. on dark). */
export function iconPreviewUrl(store: Store, slideId: string, inkOverride?: string): string {
  const slide = store.doc.slides.find((s) => s.id === slideId)
  if (!slide) return ''
  const info = iconsetInfo(store.doc)
  const { svg } = iconSlideSvg(store.doc, slide)
  const ink = (inkOverride ?? info?.style.color ?? '#000000').replace(/[^#0-9a-zA-Z(),.% ]/g, '')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/currentColor/g, ink))}`
}

// ---- icon styles (iconstyles.ts) -------------------------------------------------------

/** The icon at real size in one style (null = the set's own style), ink shown
 *  as its colour — or as `inkOverride` (a one-colour style on a dark background). */
export function lookPreviewUrl(store: Store, slideId: string, look: IconLook | null, inkOverride?: string): string {
  if (!look) return iconPreviewUrl(store, slideId, inkOverride)
  const slide = store.doc.slides.find((s) => s.id === slideId)
  if (!slide) return ''
  const { svg } = iconLookSvg(store.doc, slide, look)
  const ink = safeColor(inkOverride ?? look.stroke.color).replace(/[^#0-9a-zA-Z(),.% ]/g, '')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/currentColor/g, ink))}`
}

export function findLook(doc: SlidomingoDoc, id: string): IconLook | undefined {
  return doc.iconset?.variants?.find((l) => l.id === id)
}

/** `name`, or `name 2`, `name 3` … whichever no style of this set has yet. */
export function uniqueLookName(doc: SlidomingoDoc, name: string): string {
  const taken = new Set((doc.iconset?.variants ?? []).map((l) => l.name.toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  for (let k = 2; ; k++) if (!taken.has(`${name} ${k}`.toLowerCase())) return `${name} ${k}`
}

/** Add a style to the set (a fresh id, a free name). One undo step. Returns its id. */
export function addLook(store: Store, look: IconLook): string {
  const copy: IconLook = { ...structuredClone(look), id: uid('look'), name: uniqueLookName(store.doc, look.name) }
  store.commit(() => {
    const doc = store.doc
    if (!doc.iconset) return
    doc.iconset.variants = [...(doc.iconset.variants ?? []), copy]
  })
  return copy.id
}

export function removeLook(store: Store, id: string): void {
  store.commit(() => {
    const info = store.doc.iconset
    if (!info?.variants) return
    info.variants = info.variants.filter((l) => l.id !== id)
    if (!info.variants.length) delete info.variants
  })
}

/** Move a style one place earlier (-1) or later (+1) in the set. */
export function moveLook(store: Store, id: string, by: -1 | 1): void {
  const list = store.doc.iconset?.variants
  const i = list?.findIndex((l) => l.id === id) ?? -1
  if (!list || i < 0 || i + by < 0 || i + by >= list.length) return
  store.commit(() => {
    const v = store.doc.iconset!.variants!
    const [l] = v.splice(i, 1)
    v.splice(i + by, 0, l)
  })
}

/** Put an icon someone painted by hand back in the set style (after learning
 *  its look): strokes, caps, joins and ink from the set; a stroked shape's
 *  painted inside goes in an outline set, a stroke-less one (a dot) keeps its
 *  fill, in the ink. One undo step; the count of shapes changed. */
export function restoreIconToSet(store: Store, slideId: string): number {
  const info = iconsetInfo(store.doc)
  if (!info) return 0
  let n = 0
  store.commit(() => {
    const slide = store.doc.slides.find((s) => s.id === slideId)
    for (const el of slide?.elements ?? []) {
      if (el.type !== 'shape') continue
      const p: Partial<ShapeElement> = iconStylePatch(el, info) ?? {}
      const stroked = el.shape === 'line' || (!isNoPaint(el.stroke) && el.strokeWidth > 0)
      if (info.style.fill !== 'solid' && stroked && el.shape !== 'line' && !isNoPaint(el.fill)) p.fill = 'transparent'
      if (Object.keys(p).length) { Object.assign(el, p); n++ }
    }
  })
  return n
}

/** A style read off the current icon, as someone painted it by hand. */
export function learnFromIcon(store: Store): IconLook | null {
  const l = learnLookFromIcon(store.doc, store.slide)
  if (!l) return null
  return { id: 'learned', name: t('Learned from “{name}”', { name: store.slide.name ?? t('icon') }), ...l }
}

const PAINTED = 'path, circle, ellipse, rect, line, polyline, polygon'

/** One SVG file's painted elements, for learnLookFromSvgStats. The file is
 *  only parsed (never put in the page), and only paint attributes are read. */
export function svgPaintStats(text: string, grid: number): SvgPaintStat[] {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return []
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const width = vb.length === 4 && vb[2] > 0 ? vb[2] : parseFloat(root.getAttribute('width') ?? '') || 24
  const k = grid / width
  /** an attribute or a `style` declaration, nearest ancestor first (SVG inheritance) */
  const prop = (el: Element, name: string): string | null => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(n.getAttribute('style') ?? '')
      if (m) return m[1].trim()
      const a = n.getAttribute(name)
      if (a !== null) return a.trim()
    }
    return null
  }
  const out: SvgPaintStat[] = []
  for (const el of Array.from(root.querySelectorAll(PAINTED)).slice(0, 400)) {
    if (el.closest('defs, clipPath, mask, pattern, symbol, marker')) continue
    const stroke = prop(el, 'stroke')
    const fill = prop(el, 'fill') ?? '#000000' // the SVG default
    const sw = parseFloat(prop(el, 'stroke-width') ?? '1')
    const op = parseFloat(prop(el, 'fill-opacity') ?? '1') * parseFloat(prop(el, 'opacity') ?? '1')
    const lineLike = el.nodeName.toLowerCase() === 'line' || el.nodeName.toLowerCase() === 'polyline'
    out.push({
      stroke: stroke && stroke !== 'none' ? stroke : null,
      strokeWidth: Number.isFinite(sw) ? sw * k : 0,
      fill: lineLike || fill === 'none' ? null : fill,
      opacity: Number.isFinite(op) ? op : 1,
      cap: prop(el, 'stroke-linecap') ?? undefined,
      join: prop(el, 'stroke-linejoin') ?? undefined,
    })
  }
  return out
}

/** "Learn from SVG files…": pick icons you like (any library), get their style. */
export function learnFromSvgFiles(store: Store): Promise<IconLook | null | 'unreadable'> {
  const info = iconsetInfo(store.doc)
  if (!info) return Promise.resolve(null)
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.svg,image/svg+xml'
    input.multiple = true
    input.addEventListener('change', async () => {
      const files = Array.from(input.files ?? []).filter((f) => f.size < 2_000_000).slice(0, 50)
      if (!files.length) { resolve(null); return }
      const stats: SvgPaintStat[] = []
      for (const f of files) stats.push(...svgPaintStats(await f.text(), info.grid))
      const l = learnLookFromSvgStats(stats, info.style, info.style.color)
      if (!l) { resolve('unreadable'); return }
      const base = files.length === 1 ? files[0].name.replace(/\.svg$/i, '') : t('{n} icons', { n: files.length })
      resolve({ id: 'learned', name: t('Learned from “{name}”', { name: base.slice(0, 40) }), ...l })
    })
    input.click()
  })
}

/** "Describe with AI": the look in the user's words → Claude writes it (icons op "style"). */
export function describeStyleWithAi(store: Store, request: string): boolean {
  const send = window.slidomingoDesktop?.sendAgentPrompt
  const info = iconsetInfo(store.doc)
  if (!send || !info || !request.trim()) return false
  send('style-icons', { request: request.trim(), brief: info.brief ?? '' })
  return true
}
