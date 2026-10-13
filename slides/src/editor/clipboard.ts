// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// System-clipboard copy/paste: external objects (images, text) onto the canvas,
// and BeeSlides elements or whole slides between decks (across tabs/windows).
//
// BeeSlides content is written to the clipboard as JSON tagged with `__slidomingo:"clip"`
// (plain text, so it survives the OS clipboard). Referenced assets (image data,
// fonts) travel inside the payload, so pasting into another deck brings the
// pixels and typefaces along; asset-key collisions with different content are
// remapped so nothing clobbers the target deck.
//
// Reading that channel is the untrusted direction — the clipboard is public,
// and a payload on it need not have come from a BeeSlides deck. parseClip rebuilds
// what it finds through untrusted.ts before anything reaches the document, so
// that a fragment the format cannot express never becomes part of one.

import type { ElementBase, ShapeElement, SlidomingoDoc, Slide, SlideElement, TextElement } from '../model'
import { lineDefaultsFor, shapeDefaultsFor, textDefaultsFor, uid, type StyleShapeKind } from '../model'
import { firstFamily } from '../fonts'
import { LIMITS, sanitizeAssets, sanitizeElement, sanitizeFonts, sanitizeSlide } from '../untrusted'
import { isZoomElement, remapZoomTarget } from '../model'

export interface ClipPayload {
  __slidomingo: 'clip'
  kind: 'elements' | 'slides'
  elements?: SlideElement[]
  slides?: Slide[]
  assets?: Record<string, string>
  fonts?: SlidomingoDoc['fonts']
}

function assetKeysOf(els: SlideElement[]): Set<string> {
  const keys = new Set<string>()
  for (const el of els) {
    // image AND media: both embed through doc.assets, so both can carry a ref
    if ((el.type === 'image' || el.type === 'media') && typeof el.src === 'string' && el.src.startsWith('asset:')) keys.add(el.src.slice(6))
    const a = (el as { asset?: string }).asset
    if (typeof a === 'string') keys.add(a) // svg elements reference an asset key
  }
  return keys
}

function fontsFor(els: SlideElement[], doc: SlidomingoDoc): NonNullable<SlidomingoDoc['fonts']> {
  const families = new Set(
    els
      .filter((el): el is TextElement => el.type === 'text')
      .map((el) => firstFamily(el.fontFamily)),
  )
  return (doc.fonts ?? []).filter((font) => families.has(firstFamily(font.family)))
}

function collectAssets(els: SlideElement[], fonts: NonNullable<SlidomingoDoc['fonts']>, doc: SlidomingoDoc): Record<string, string> {
  const out: Record<string, string> = {}
  const keys = assetKeysOf(els)
  for (const font of fonts) keys.add(font.asset)
  for (const k of keys) if (doc.assets?.[k] != null) out[k] = doc.assets[k]
  return out
}

export function serializeElements(els: SlideElement[], doc: SlidomingoDoc): string {
  const fonts = fontsFor(els, doc)
  const payload: ClipPayload = {
    __slidomingo: 'clip', kind: 'elements',
    elements: JSON.parse(JSON.stringify(els)),
    assets: collectAssets(els, fonts, doc),
    fonts,
  }
  return JSON.stringify(payload)
}

export function serializeSlides(slides: Slide[], doc: SlidomingoDoc): string {
  const els = slides.flatMap((s) => s.elements)
  const fonts = fontsFor(els, doc)
  const payload: ClipPayload = {
    __slidomingo: 'clip', kind: 'slides',
    slides: JSON.parse(JSON.stringify(slides)),
    assets: collectAssets(els, fonts, doc),
    fonts,
  }
  return JSON.stringify(payload)
}

/**
 * Read a clip payload off the system clipboard — the ONE place foreign
 * document fragments enter the deck, and so the place they are checked.
 *
 * Nothing about clipboard text says a BeeSlides deck wrote it: any page with a
 * Copy button can leave a `__slidomingo:"clip"` payload there, and this used to
 * hand whatever it contained to insertElements/insertSlides unread. So the
 * payload is REBUILT through untrusted.ts — known kind, known element types,
 * known keys, values of the right shape — and anything that does not conform
 * is dropped rather than repaired.
 *
 * This is the model-shape layer, not the escaping layer: render.ts escapes and
 * validates what it writes into markup on its own (it has to — a deck opened
 * from disk never passes through here). What this adds is that the DOCUMENT
 * never holds the value in the first place, which is the part every future
 * renderer inherits for free.
 *
 * A payload with nothing left after the rebuild returns null, so the paste
 * handler falls through to its plain-text branch: the JSON lands as a visible
 * text element instead of silently doing nothing. That fallback is a poor fit
 * for the SIZE ceiling — an over-budget but perfectly legitimate slide copy
 * deserves "that paste is too large", not 4000 characters of raw JSON — so the
 * ceiling is set where real payloads cannot reach it (LIMITS.clipText).
 *
 * Split in two: `parseClipPayload` does the actual rebuild against an
 * already-parsed value, and is the entry point for anything that already has
 * a JS object rather than clipboard text — the desktop terminal integration's
 * `insert_elements` MCP verb (editor.ts's applyAgentAction) hands it an
 * elements-kind payload built from an agent's JSON args, going through the
 * exact same untrusted-fragment checks a paste does. `parseClip` stays the
 * thin OS-clipboard wrapper: parse the text, then defer to the shared rebuild.
 */
export function parseClipPayload(raw: unknown): ClipPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (p.__slidomingo !== 'clip') return null
  if (p.kind !== 'elements' && p.kind !== 'slides') return null

  const payload: ClipPayload = {
    __slidomingo: 'clip', kind: p.kind,
    assets: sanitizeAssets(p.assets),
    fonts: sanitizeFonts(p.fonts),
  }
  if (p.kind === 'elements') {
    if (!Array.isArray(p.elements) || p.elements.length > LIMITS.elements) return null
    payload.elements = p.elements.map(sanitizeElement).filter((el): el is SlideElement => el !== null)
    if (!payload.elements.length) return null
  } else {
    if (!Array.isArray(p.slides) || p.slides.length > LIMITS.slides) return null
    payload.slides = p.slides.map(sanitizeSlide).filter((s): s is Slide => s !== null)
    if (!payload.slides.length) return null
  }
  return payload
}

export function parseClip(text: string): ClipPayload | null {
  if (!text || text.length > LIMITS.clipText) return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  return parseClipPayload(raw)
}

/** The slice of ClipPayload mergeAssets/mergeFonts/mergeClipResources actually
 *  need — loosened from ClipPayload itself (which also carries `__slidomingo`/
 *  `kind`/`elements`/`slides`) so callers with just an asset/font BUNDLE, no
 *  clip envelope, can pass one straight in. propose_variants' pending state
 *  (editor.ts) is exactly that: assets/fonts sanitized once at proposal time,
 *  with no clip shape around them. */
export interface AssetFontSource {
  assets?: Record<string, string>
  fonts?: SlidomingoDoc['fonts']
}

/** Merge payload assets into doc. Bytes the doc already holds are reused
 *  under whatever key holds them (remapped when that key differs — the
 *  `internAsset` rule, so pasting the same picture twice stores it once);
 *  only new bytes are added, under a fresh key when theirs is taken by
 *  different content. */
function mergeAssets(payload: AssetFontSource, doc: SlidomingoDoc): Map<string, string> {
  const remap = new Map<string, string>()
  if (!payload.assets) return remap
  const assets = (doc.assets ??= {})
  for (const [k, v] of Object.entries(payload.assets)) {
    if (assets[k] === v) continue
    let same: string | undefined
    for (const dk in assets) if (assets[dk] === v) { same = dk; break }
    if (same !== undefined) remap.set(k, same)
    else if (assets[k] === undefined) assets[k] = v
    else { const nk = `${k}-${uid('a')}`; assets[nk] = v; remap.set(k, nk) }
  }
  return remap
}

/** Merge embedded-font records after their asset keys have been remapped. */
function mergeFonts(payload: AssetFontSource, doc: SlidomingoDoc, remap: Map<string, string>) {
  if (!payload.fonts?.length) return
  doc.fonts = doc.fonts ?? []
  for (const source of payload.fonts) {
    if (doc.fonts.some((font) => font.family === source.family)) continue
    doc.fonts.push({ ...source, asset: remap.get(source.asset) ?? source.asset })
  }
}

/**
 * One-call bundle merge: mergeAssets + mergeFonts + rewriteRefs, in that
 * order, against `doc` — the sequence insertElements/insertSlides already run
 * inline, factored out so a caller with elements OUTSIDE a ClipPayload (a
 * propose_variants candidate slide's own elements, not a clip) doesn't have
 * to re-derive it. Mutates `doc` (assets/fonts) and `els` (asset refs) in
 * place; callers wrap this in their own store.commit for undo grouping.
 */
export function mergeClipResources(bundle: AssetFontSource, doc: SlidomingoDoc, els: SlideElement[]): void {
  const remap = mergeAssets(bundle, doc)
  mergeFonts(bundle, doc, remap)
  rewriteRefs(els, remap)
}

/** Applies `remap` to every asset ref in `els` in ONE pass (so a→b, b→c
 *  never chains): `asset:<key>` inside any string (`src`, …) and a bare
 *  `asset` property (svg elements). */
function rewriteRefs(els: SlideElement[], remap: Map<string, string>) {
  if (!remap.size) return
  const visit = (o: Record<string, unknown>): void => {
    for (const [k, x] of Object.entries(o)) {
      if (typeof x === 'string') {
        if (k === 'asset' && remap.has(x)) o[k] = remap.get(x)
        else if (x.includes('asset:')) o[k] = x.replace(/asset:([A-Za-z0-9_-]+)/g, (m, key: string) => remap.has(key) ? 'asset:' + remap.get(key) : m)
      } else if (x && typeof x === 'object') visit(x as Record<string, unknown>)
    }
  }
  for (const el of els) visit(el as unknown as Record<string, unknown>)
}

// --- ⌘⇧V: which paste is this? ----------------------------------------------
// A `paste` event carries no modifier keys, so "paste without design" is
// told apart from ⌘V by the keydown that caused it: the editor arms this on
// mod+Shift+V (capture phase, so a text field's own handlers can't hide it)
// and whichever paste handler runs next takes it. The window is generous
// because the Electron menu's pasteAndMatchStyle round-trips through main.

let plainPasteUntil = 0

export function armPlainPaste(now = performance.now()): void {
  plainPasteUntil = now + 1000
}

/** True (once) when the paste being handled came from ⌘⇧V. */
export function takePlainPaste(now = performance.now()): boolean {
  const on = now < plainPasteUntil
  plainPasteUntil = 0
  return on
}

/** Plain-text paste into the model's inline-HTML dialect: the same escaping
 *  the canvas uses for pasted text (editor.ts wirePaste), newlines → <br>. */
export function plainTextHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}

/** An element's inline HTML reduced to its words and line breaks — DOM-free,
 *  so it runs wherever the clipboard code does. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n+$/, '')
}

/** Look-only fields every element type can carry. */
const DESIGN_KEYS = ['shadow', 'blur', 'blend', 'backdropFilter', 'themeRefs'] as const

/**
 * "Paste without design" (⌘⇧V): keep what an element IS — its frame,
 * rotation, words, picture, data, links and animations — and give it the
 * look a freshly inserted one would have on `slide`: its slide type's
 * default styles (model.ts resolveStyleDefaults), else the deck's, else the
 * built-in look. Layout-ish properties stay: a text box's alignment, a
 * rectangle's corner radius, a line's tips. Pictures, charts, tables and the
 * rest have no separable "design" and pass through as they are. Mutates `el`.
 */
export function restyleToDefaults(el: SlideElement, slide: Slide, doc: SlidomingoDoc): void {
  if (el.type === 'shape') {
    for (const k of DESIGN_KEYS) delete (el as ElementBase)[k]
    el.opacity = 1
    const s = el as ShapeElement
    delete s.fillGradient
    delete s.strokeStyle
    delete s.strokeDash
    delete s.strokeCap
    // a curve/freeform is an open path: it is a line, not a shape
    const open = s.shape === 'path' && !/z\s*$/i.test(s.d ?? '')
    if (s.shape === 'line' || open) {
      const { lineStart: _s, lineEnd: _e, ...look } = lineDefaultsFor(doc, slide, open ? 'path' : 'line')
      Object.assign(s, look)
    } else {
      const { radius: _r, ...look } = shapeDefaultsFor(doc, slide, s.shape as StyleShapeKind)
      Object.assign(s, look)
    }
  } else if (el.type === 'text') {
    for (const k of DESIGN_KEYS) delete (el as ElementBase)[k]
    el.opacity = 1
    const t = el as TextElement
    const { align: _a, ...look } = textDefaultsFor(doc, slide)
    Object.assign(t, look)
    delete t.colorGradient
    delete t.textStroke
    delete t.letterSpacing
    t.html = plainTextHtml(htmlToPlainText(t.html))
  }
}

/**
 * Insert pasted (or agent-authored) elements onto a slide with fresh ids.
 *
 * `opts.nudge` (default true) offsets each element +20,+20 so a paste lands
 * visibly clear of whatever it was copied on top of — the human paste idiom.
 * An agent that already called `measure()`/`validate()` for an exact frame
 * passes `nudge:false` so its coordinates land untouched.
 *
 * `opts.plain` is "paste without design" — see restyleToDefaults.
 */
export function insertElements(payload: ClipPayload, doc: SlidomingoDoc, slide: Slide, opts: { nudge?: boolean; plain?: boolean } = {}): SlideElement[] {
  const off = (opts.nudge ?? true) ? 20 : 0
  const remap = mergeAssets(payload, doc)
  // a plain paste resets every font, so the source's typefaces aren't needed
  if (!opts.plain) mergeFonts(payload, doc, remap)
  // Fresh id per pasted element, tracked so id-shaped references within the
  // SAME paste (groupId, parentId) can be rewritten to match — otherwise a
  // pasted group/container silently re-merges into the original still in the
  // doc, the exact bug this idMap fixes for both fields.
  const idMap = new Map<string, string>()
  const els: SlideElement[] = (payload.elements ?? []).map((e) => {
    const id = uid(e.type[0])
    idMap.set(e.id, id)
    return { ...(JSON.parse(JSON.stringify(e)) as SlideElement), id, x: (e.x ?? 0) + off, y: (e.y ?? 0) + off }
  })
  rewriteRefs(els, remap)
  if (opts.plain) for (const el of els) restyleToDefaults(el, slide, doc)
  remapCopiedRefs(els, idMap)
  slide.elements.push(...els)
  return els
}

/**
 * Make a batch of copied elements self-contained — every element-copy path
 * (paste, ⌘D, the Duplicate button, ⌘-drag) runs this. `idMap` maps each
 * ORIGINAL id in the batch to its copy's id. Without it the copies keep
 * pointing at the originals still on the slide: a duplicated group merges
 * into the original group, a duplicated container's children stay parented
 * to the ORIGINAL container (and syncContainers snaps them onto it), and a
 * copied box → arrow → box arrow stays anchored to the original boxes.
 *  - `groupId`: a fresh group id, shared within the batch.
 *  - `parentId`: the copied container, else dropped (with `parentOffset`) —
 *    never silently re-parented onto the original.
 *  - connector `from.el`/`to.el`: the copied element when it is in the batch;
 *    an end anchored outside the batch keeps its anchor.
 * Mutates the (already cloned) elements.
 */
export function remapCopiedRefs(els: SlideElement[], idMap: Map<string, string>): void {
  const gidMap = new Map<string, string>()
  for (const el of els) {
    if (el.groupId) el.groupId = gidMap.get(el.groupId) ?? gidMap.set(el.groupId, `grp-${uid()}`).get(el.groupId)!
    if (el.parentId) {
      const newParent = idMap.get(el.parentId)
      if (newParent) el.parentId = newParent
      else { delete el.parentId; delete el.parentOffset }
    }
    const line = el as ShapeElement
    for (const end of [line.from, line.to]) {
      const to = end && idMap.get(end.el)
      if (end && to) end.el = to
    }
  }
}

/** Insert pasted slides at `at` with fresh slide ids; merge assets + fonts. */
export function insertSlides(payload: ClipPayload, doc: SlidomingoDoc, at: number): Slide[] {
  const remap = mergeAssets(payload, doc)
  mergeFonts(payload, doc, remap)
  const slides: Slide[] = (payload.slides ?? []).map((s) => {
    const copy = JSON.parse(JSON.stringify(s)) as Slide
    copy.id = uid('slide')
    if (copy.stateOf) delete copy.stateOf // a pasted state becomes a normal slide
    // A slide's layoutId points at a doc.layouts entry IN ITS OWN DECK — that
    // id means nothing (or worse, collides with an unrelated layout) in the
    // target doc, so a cross-doc paste must not leave it dangling.
    if (copy.layoutId) delete copy.layoutId
    rewriteRefs(copy.elements, remap)
    return copy
  })
  // zoom tiles that point inside the pasted set follow the copies (a pasted
  // Summary Zoom with its slides); anything else keeps its id
  const fresh = new Map((payload.slides ?? []).map((s, i) => [s.id, slides[i].id]))
  for (const s of slides) for (const el of s.elements) if (isZoomElement(el)) remapZoomTarget(el, fresh)
  doc.slides.splice(at, 0, ...slides)
  return slides
}
