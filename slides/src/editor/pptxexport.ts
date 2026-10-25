// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// File ▸ Export to ▸ PowerPoint: the deck as a .pptx whose slide types are
// PowerPoint's own masters and layouts (kernel/src/convert/pptx-write.ts
// spells it; DECISIONS "PowerPoint export"). The mapping, the other way
// round from the importer's (pptx.ts, 2026-09-27):
//
//   root slide type        → a slide master: its decoration, and its title,
//                            body and footer slots as the master's own
//   every pickable type    → a layout under its root's master: the
//                            decoration of the types between them, and
//                            every slot of the chain (PowerPoint layouts
//                            declare all their slots themselves)
//   a slide on a type      → its own content; chrome it inherits is left to
//                            the master and layout, its slot copies fill the
//                            layout's slots (same type + idx), in the slot's
//                            frame unless it moved
//   a slide with no type   → everything on the slide, a blank layout
//
// Slots: text with a role, a prompt or a footer piece, and media slots.
// PowerPoint draws master and layout decoration UNDER every slide's own
// shapes, and a slot's text only while editing: the same as a slide type
// here, except chrome painted above a slot, which lands below it.
// Hidden slides and interactive states are hidden slides; element links to
// other slides become slide jumps; shared morph keys become "!!" names so
// PowerPoint's Morph pairs them. Builds and animations are not exported.

import { ancestorChain, footerHidden, morphKey, sectionsInOrder, type Slide, type SlidomingoDoc, type SlideElement } from '../model'
import { paletteOf } from '../palette'
import { parseColor, type WElement, type WPh } from '../../../kernel/src/convert/drawingml-write.ts'
import { slidePart, writePptx, type PptxFill, type PptxLayoutIn, type PptxMasterIn, type PptxSlideIn, type PptxTransition } from '../../../kernel/src/convert/pptx-write.ts'
import { parseLinearGradient } from '../htmlslide'
import { drawPicture, nativeContext, toNative, type NativeContext } from './officeshapes'
import { t } from '../i18n'

/** Pictures of what PowerPoint cannot draw natively, at 2× slide px. */
const PICTURE_SCALE = 2

/** Fixed slot numbers for the footer pieces, the same on every master and layout. */
const FOOTER_IDX = { dt: 10, ftr: 11, sldNum: 12 } as const

/** What PowerPoint slot an element of a slide type is, or null: decoration. */
function slotKind(e: SlideElement): WPh['type'] | null {
  if (e.type === 'text' && e.footerRole) return e.footerRole === 'date' ? 'dt' : e.footerRole === 'slideNumber' ? 'sldNum' : 'ftr'
  if (e.role === 'media') return 'pic'
  if (e.type !== 'text') return null
  if (e.role === 'title') return 'title'
  if (e.role === 'subtitle') return 'subTitle'
  return e.role || e.placeholder ? 'body' : null
}

/** One element written for the package: native, or a picture of it. */
type Emit = (el: SlideElement, surface: Slide, ctx: NativeContext, extra?: Partial<WElement>) => Promise<WElement | null>

export async function buildPptx(doc: SlidomingoDoc): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const warnings = new Set<string>()
  const emit: Emit = async (el, surface, ctx, extra = {}) => {
    const native = toNative(el, doc, ctx)
    if (native) return { ...native, ...extra } as WElement
    const drawn = await drawPicture(doc, surface, el, { scale: PICTURE_SCALE })
    if (!drawn) return null
    drawn.warnings.forEach((w) => warnings.add(w))
    return { ...drawn.picture, ...extra } as WElement
  }
  const types = doc.layouts ?? []
  const typeById = new Map(types.map((l) => [l.id, l]))
  const used = new Set(doc.slides.map((s) => s.layoutId).filter((id): id is string => !!id && typeById.has(id)))

  // ---- masters: one per root slide type
  const roots = types.filter((l) => ancestorChain(doc, l)[0] === l)
  const masterOf = new Map<string, number>()
  const masters: PptxMasterIn[] = []
  for (const root of roots) {
    const ctx = nativeContext(doc, root, true)
    const els: WElement[] = []
    const taken = new Set<WPh['type']>()
    for (const el of visible(root)) {
      const kind = slotKind(el)
      if (!kind) { const w = await emit(el, root, ctx); if (w) els.push(w); continue }
      // a master has one title, one body and the footer pieces; the rest are the layouts'
      const master = kind === 'title' || kind === 'body' || kind in FOOTER_IDX
      if (!master || taken.has(kind)) continue
      taken.add(kind)
      const idx = kind === 'title' ? undefined : kind === 'body' ? 1 : FOOTER_IDX[kind as keyof typeof FOOTER_IDX]
      const w = await emit(promptOf(el), root, ctx, { ph: { type: kind, idx, template: true } })
      if (w) els.push(w)
    }
    masterOf.set(root.id, masters.length)
    masters.push({
      name: root.name || t('Slide type'), elements: els, background: fillOf(root.background, warnings),
      theme: { ...themeOf(doc), fontFamily: root.fontFamily || doc.theme.fontFamily, headingFamily: root.headingFamily || doc.theme.headingFamily },
    })
  }

  // ---- layouts: every type a slide can use; slots numbered per layout
  const layouts: PptxLayoutIn[] = []
  const layoutOf = new Map<string, number>()
  const slotsOf = new Map<string, Map<string, { ph: WPh; el: SlideElement }>>()
  for (const type of types) {
    if (type.parentOnly && !used.has(type.id)) continue
    const chain = ancestorChain(doc, type)
    const root = chain[0]
    const ctx = nativeContext(doc, type, true)
    const slots = new Map<string, { ph: WPh; el: SlideElement }>()
    const els: WElement[] = []
    let nextIdx = 1
    let hasTitle = false
    for (const owner of chain) {
      for (const el of visible(owner)) {
        let kind = slotKind(el)
        if (!kind) {
          // the root's decoration is the master's
          if (owner === root) continue
          const w = await emit(el, owner, ctx)
          if (w) els.push(w)
          continue
        }
        if (kind === 'title' && hasTitle) kind = 'body'
        if (kind === 'title') hasTitle = true
        const ph: WPh = { type: kind, idx: kind === 'title' ? undefined : kind in FOOTER_IDX ? FOOTER_IDX[kind as keyof typeof FOOTER_IDX] : nextIdx++ }
        slots.set(el.id, { ph, el })
        const w = await emit(promptOf(el), owner, ctx, { ph: { ...ph, template: true } })
        if (w) els.push(w)
      }
    }
    const background = type === root || sameCss(type.background, root.background) ? undefined : fillOf(type.background, warnings)
    layoutOf.set(type.id, layouts.length)
    slotsOf.set(type.id, slots)
    layouts.push({ name: type.name || t('Slide type'), master: masterOf.get(root.id)!, elements: els, background })
  }

  // ---- slides
  const index = new Map(doc.slides.map((s, i) => [s.id, i]))
  const written: Array<{ src: SlideElement; out: WElement }[]> = []
  const slides: PptxSlideIn[] = []
  for (const slide of doc.slides) {
    const type = slide.layoutId ? typeById.get(slide.layoutId) : undefined
    const layout = type ? layoutOf.get(type.id) : undefined
    const slots = type ? slotsOf.get(type.id)! : undefined
    const inherited = new Set(type ? ancestorChain(doc, type).flatMap((l) => l.elements.map((e) => e.id)) : [])
    const off = footerHidden(doc, slide)
    const ctx = nativeContext(doc, slide, true)
    const pairs: { src: SlideElement; out: WElement }[] = []
    for (const el of visible(slide)) {
      const slot = slots?.get(el.id)
      if (!slot && inherited.has(el.id)) continue // chrome: the master's or layout's
      if (el.type === 'text' && el.footerRole && off.has(el.footerRole)) continue
      const jump = el.link && index.has(el.link) ? slidePart(index.get(el.link)!) : undefined
      let ph: WPh | undefined
      const native = toNative(el, doc, ctx)
      // a slot keeps its tie to the layout's only as what PowerPoint can put
      // there (a table is no picture); it follows the slot's frame only when
      // what is written fills exactly that frame (not a letterboxed picture,
      // not a drawn one with room for its shadow)
      if (slot && (slot.ph.type !== 'pic' || el.type === 'image' || el.type === 'shape' || !native)) {
        const fills = !!native && (el.type !== 'image' || el.fit !== 'contain')
        ph = { ...slot.ph, inheritFrame: fills && sameFrame(el, slot.el) }
      }
      const out = await emit(el, slide, ctx, { ...(ph ? { ph } : {}), ...(jump ? { jump } : {}) })
      if (out) pairs.push({ src: el, out })
    }
    written.push(pairs)
    const own = sameCss(slide.background, type?.background) ? undefined : fillOf(slide.background, warnings)
    slides.push({
      elements: pairs.map((p) => p.out),
      layout, background: own,
      notes: slide.notes || undefined,
      hidden: !!slide.hidden || !!slide.stateOf,
      transition: transitionOf(slide),
      number: String(ctx.fields.page),
    })
    if (slide.elements.some((e) => e.fx && Object.keys(e.fx).length)) warnings.add(t('Animations and builds are not exported'))
  }

  // Morph pairs by name in PowerPoint: a key shared with the slide it morphs to or from is named "!!key"
  slides.forEach((s, i) => {
    if (s.transition?.kind !== 'morph' || i === 0) return
    const before = new Set(written[i - 1].map((p) => morphKey(p.src)))
    const shared = written[i].filter((p) => before.has(morphKey(p.src))).map((p) => morphKey(p.src))
    for (const k of shared) {
      for (const p of [...written[i - 1], ...written[i]]) if (morphKey(p.src) === k) p.out.name = `!!${k}`
    }
  })

  const sections = sectionsInOrder(doc).map((sec) => ({ name: sec.name, first: index.get(sec.startSlideId)! }))
  const r = await writePptx({ size: doc.size, slides, masters, layouts, theme: themeOf(doc), sections, title: doc.title })
  r.warnings.forEach((w) => warnings.add(w))
  return { bytes: r.bytes, warnings: [...warnings] }
}

/** File ▸ Export to ▸ PowerPoint: build it, then the native Save dialog (desktop) or a download. */
export async function exportPptx(doc: SlidomingoDoc, toast: (m: string) => void): Promise<void> {
  toast(t('Building PowerPoint…'))
  let built: { bytes: Uint8Array; warnings: string[] }
  try {
    built = await buildPptx(doc)
  } catch (err) {
    toast(t('Export failed: {m}', { m: err instanceof Error ? err.message : String(err) }))
    return
  }
  const name = `${(doc.title || 'presentation').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'presentation'}.pptx`
  const api = window.slidomingoDesktop
  if (api?.exportFigure) {
    const r = await api.exportFigure({ kind: 'pptx', bytes: built.bytes, suggestedName: name })
    if ('error' in r) { toast(t('Export failed: {m}', { m: r.error })); return }
    if ('cancelled' in r) return
  } else {
    const url = URL.createObjectURL(new Blob([built.bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  toast(built.warnings.length ? t('Exported PowerPoint — note: {w}', { w: built.warnings.join(' · ') }) : t('Exported PowerPoint'))
}

// ---- helpers ------------------------------------------------------------------------

/** What a surface shows when nothing is hovered: hidden objects and the
 *  other hover sets are left out (staticlayer.ts applyHoverDefault). */
function visible(s: Slide): SlideElement[] {
  const first = s.hover?.type === 'reveal' ? s.elements.find((e) => e.showOnHover)?.showOnHover : undefined
  const chosen = s.hover?.default ?? first
  return s.elements.filter((e) => !e.hidden && !(e.showOnHover && s.hover?.type === 'reveal' && e.showOnHover !== chosen))
}

/** A slot as the master/layout writes it: its prompt is its text while it has none. */
function promptOf(el: SlideElement): SlideElement {
  if (el.type !== 'text' || el.html.replace(/<[^>]*>/g, '').trim() || !el.placeholder) return el
  return { ...el, html: el.placeholder.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
}

function sameFrame(a: SlideElement, b: SlideElement): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5
  return near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h) && near(a.rotation || 0, b.rotation || 0)
}

const sameCss = (a: string | undefined, b: string | undefined): boolean => (a ?? '').replace(/\s+/g, '').toLowerCase() === (b ?? '').replace(/\s+/g, '').toLowerCase()

/** A CSS background as a PowerPoint one: a colour, a linear gradient, else its colour (noted). */
function fillOf(css: string | undefined, warnings: Set<string>): PptxFill | undefined {
  if (!css?.trim()) return undefined
  const c = parseColor(css)
  if (c) return { color: css }
  const probe = document.createElement('div')
  probe.style.background = css
  document.body.appendChild(probe)
  try {
    const cs = getComputedStyle(probe)
    const g = parseLinearGradient(cs.backgroundImage)
    if (g) return { gradient: g }
    warnings.add(t('A background PowerPoint cannot draw was written as its colour'))
    const base = parseColor(cs.backgroundColor) ? cs.backgroundColor : /(#[0-9a-f]{3,8}\b|rgba?\([^)]*\))/i.exec(css)?.[1]
    return base ? { color: base } : undefined
  } finally {
    probe.remove()
  }
}

/** model.ts TransitionDir names where the new slide comes FROM; PowerPoint, the way it moves. */
const MOVES: Record<string, PptxTransition['dir']> = { right: 'l', left: 'r', bottom: 'u', top: 'd' }

function transitionOf(s: Slide): PptxTransition | undefined {
  switch (s.transition) {
    case 'fade': case 'zoom': case 'morph': return { kind: s.transition }
    case 'slide': return { kind: 'push', dir: 'l' }
    case 'push': case 'wipe': case 'cover': return { kind: s.transition, dir: MOVES[s.transitionDir ?? 'right'] ?? 'l' }
    case 'split': return { kind: 'split', orient: s.transitionDir === 'horizontal' ? 'horz' : 'vert' }
    default: return undefined
  }
}

function themeOf(doc: SlidomingoDoc) {
  const p = paletteOf(doc)
  return {
    fontFamily: doc.theme.fontFamily, headingFamily: doc.theme.headingFamily,
    background: doc.theme.background, color: doc.theme.color, accent: doc.theme.accent,
    palette: { bg2: p.bg2, tx2: p.tx2, accent2: p.accent2, accent3: p.accent3, accent4: p.accent4, accent5: p.accent5, accent6: p.accent6, hlink: p.hlink, folHlink: p.folHlink },
  }
}
