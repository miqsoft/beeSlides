// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon-set actions (docs/DECISIONS.md, "Icon sets"): add icons, change the
// set's style, "Apply set style", "Draw with AI", one comment on several
// icons, and the two exports. The pure parts (style patch, SVG, manifest) are
// in ../iconset.ts; this file is the editor glue.

import { ICONSET_STYLE_DEFAULTS, iconsetStyleDefaults, newIconSlide, uid, type IconsetInfo, type IconsetStyle, type ShapeElement, type SlidomingoDoc } from '../model'
import { ICON_MANIFEST_FILE, iconFileNames, iconManifest, iconSlideSvg, iconStylePatch, iconsetInfo, iconsToDraw, iconSlug } from '../iconset'
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
    title: slideIds.length === 1 ? t('Comment on this icon') : t('Comment on {n} icons', { n: slideIds.length }),
    placeholder: t('e.g. thinner details, rounder corners, more like the others'),
    okLabel: send && window.slidomingoDesktop?.sendAgentPrompt ? t('Send to Claude') : t('Comment'),
  })
  if (!text?.trim()) return 0
  const ids = new Set<string>()
  const at = new Date().toISOString()
  const author = commentAuthor()
  store.commit(() => {
    for (const s of store.doc.slides) {
      if (!slideIds.includes(s.id)) continue
      const id = uid('cmt')
      ids.add(id)
      ;(s.comments ??= []).push({ id, author, text: text.trim(), at })
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

/** Every file of the exported set: one SVG per icon, icons.json, LICENSE.txt. */
export function iconSetFiles(store: Store): { files: Array<{ name: string; text: string }>; skipped: Set<string> } {
  const doc = store.doc
  const names = iconFileNames(doc.slides)
  const skipped = new Set<string>()
  const files = doc.slides.map((s, i) => {
    const r = iconSlideSvg(doc, s, { title: true })
    r.skipped.forEach((k) => skipped.add(k))
    return { name: names[i], text: r.svg }
  })
  files.push({ name: ICON_MANIFEST_FILE, text: JSON.stringify(iconManifest(doc, names), null, 2) + '\n' })
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
    toast(t('Exported {n} icons to {p}', { n: store.doc.slides.length, p: r.path }) + note)
    return
  }
  const enc = new TextEncoder()
  const zip = await writeZip(files.map((f) => ({ name: `${stem}/${f.name}`, data: enc.encode(f.text) })))
  download(`${stem}.zip`, zip as BlobPart, 'application/zip')
  toast(t('Exported {n} icons', { n: store.doc.slides.length }) + note)
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

/** The icon at real size for the panel's preview strip (ink as the set colour, never currentColor black). */
export function iconPreviewUrl(store: Store, slideId: string): string {
  const slide = store.doc.slides.find((s) => s.id === slideId)
  if (!slide) return ''
  const info = iconsetInfo(store.doc)
  const { svg } = iconSlideSvg(store.doc, slide)
  const ink = (info?.style.color ?? '#000000').replace(/[^#0-9a-zA-Z(),.% ]/g, '')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/currentColor/g, ink))}`
}
