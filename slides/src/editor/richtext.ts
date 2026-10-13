// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Rich text phase 1 — the editing half (DECISIONS 2026-10-08). The renderer's
// half is render.ts sanitizeHtml, and it is the only security boundary: this
// file shapes what a live text edit WRITES, the sanitizer decides what any
// html — this file's, a pasted document's, an agent's — is allowed to SAY.
//
// What it edits, always inside the live contentEditable (canvas.startTextEdit
// or a table cell):
//   * run colour  — a span `color` (hex/rgb, or a palette slot as
//                   `var(--sl-accent1)`, which follows a re-brand)
//   * run size    — a span `font-size` in px (slide pixels, like el.fontSize)
//   * links       — <a href>, http/https/mailto only (sanitizeLinkHref)
//   * lists       — real <ul>/<ol>/<li>, nested inside their item, Tab and
//                   Shift-Tab change the level (MAX_LIST_DEPTH)
//
// HOW: through the browser's own editing commands wherever one exists
// (insertUnorderedList, indent, createLink, foreColor with styleWithCSS),
// because those land on contentEditable's native undo stack — ⌘Z inside a
// text edit keeps working. Where a command can only say part of what we
// mean (fontSize knows 1–7, foreColor knows no palette slot) the command
// runs with a marker value and the spans it produced are finished by hand.
//
// FOCUS: the colour and link popovers carry `data-rt-keep`, and the canvas's
// blur-commit stands down while focus is inside one (canvas.armBlurCommit),
// so typing a URL never ends the text edit underneath it. They save the
// selection when they open and put it back before they act.

import { MAX_LIST_DEPTH, sanitizeHtml, sanitizeLinkHref, sanitizeRunColor } from '../render'
import { paletteOf, type PaletteSlot } from '../palette'
import type { SlidomingoDoc } from '../model'
import { t } from '../i18n'
import { positionFloating } from './floatingposition'

/** The attribute that keeps a text edit alive while focus is inside. */
export const RT_KEEP = 'data-rt-keep'

const PX_PER_PT = 4 / 3

/** The live text edit's editable root, if any (text box or table cell). */
export function editRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.slidomingo-editing [contenteditable="true"]')
}

/** The selection's range when it lies inside `root`. */
function rangeIn(root: HTMLElement): Range | null {
  const sel = document.getSelection()
  if (!sel || !sel.rangeCount) return null
  const r = sel.getRangeAt(0)
  return root.contains(r.commonAncestorContainer) ? r : null
}

function restoreRange(root: HTMLElement, range: Range | null) {
  root.focus({ preventScroll: true })
  if (!range) return
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/** The element the caret (or the selection's start) sits in. */
function caretElement(root: HTMLElement): HTMLElement | null {
  const r = rangeIn(root)
  if (!r) return null
  const n = r.startContainer
  const el = n.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement) : n.parentElement
  return el && root.contains(el) ? el : null
}

// --- lists ---------------------------------------------------------------------

/** 'ul' / 'ol' when the caret is in a list item of that kind, else null. */
export function listAt(root: HTMLElement | null = editRoot()): 'ul' | 'ol' | null {
  if (!root) return null
  const li = caretElement(root)?.closest('li')
  const list = li?.parentElement
  if (!li || !list || !root.contains(list)) return null
  return list.tagName === 'OL' ? 'ol' : list.tagName === 'UL' ? 'ul' : null
}

/** Turn the current line(s) into a bulleted / numbered list, or back. */
export function toggleList(ordered: boolean): boolean {
  const root = editRoot()
  if (!root || !rangeIn(root)) return false
  document.execCommand(ordered ? 'insertOrderedList' : 'insertUnorderedList')
  return true
}

/** How deep the caret's list item sits (1 = top-level list). */
function listDepthAt(root: HTMLElement): number {
  let depth = 0
  for (let n: HTMLElement | null = caretElement(root); n && n !== root; n = n.parentElement) {
    if (n.tagName === 'UL' || n.tagName === 'OL') depth++
  }
  return depth
}

/**
 * Tab / Shift-Tab inside a list item: one level in or out. Returns false when
 * the caret is not in a list (the key then means whatever it meant before).
 * Indenting past MAX_LIST_DEPTH is swallowed — the sanitizer would flatten
 * that level to plain text on the next commit.
 */
export function indentList(dir: 1 | -1): boolean {
  const root = editRoot()
  if (!root || !listAt(root)) return false
  if (dir > 0 && listDepthAt(root) >= MAX_LIST_DEPTH) return true
  document.execCommand(dir > 0 ? 'indent' : 'outdent')
  return true
}

// --- run colour and size -------------------------------------------------------

/** Chrome's spelling of fontSize 7 with styleWithCSS on (older: -webkit-). */
const SIZE_MARK = new Set(['xxx-large', '-webkit-xxx-large'])
/** A colour nobody picks, for runs whose real value foreColor cannot take. */
const COLOR_MARK = '#fe01fd'

/** Normalise any colour to the browser's computed spelling, to compare. */
function computedColor(value: string): string {
  const probe = document.createElement('span')
  probe.style.color = value
  return probe.style.color
}

/**
 * Run `cmd` with styleWithCSS on, then hand every span whose style it
 * created or changed to `finish`. Returns false (and does nothing) for a
 * collapsed selection — a colour or size applies to text, not to a caret.
 */
function styleSelection(cmd: 'foreColor' | 'fontSize', arg: string, isMark: (s: HTMLElement) => boolean, finish: (s: HTMLElement) => void): boolean {
  const root = editRoot()
  const r = root && rangeIn(root)
  if (!root || !r || r.collapsed) return false
  const before = new Map<Element, string | null>()
  for (const s of Array.from(root.querySelectorAll('span'))) before.set(s, s.getAttribute('style'))
  document.execCommand('styleWithCSS', false, 'true')
  try { document.execCommand(cmd, false, arg) } finally { document.execCommand('styleWithCSS', false, 'false') }
  for (const s of Array.from(root.querySelectorAll<HTMLElement>('span[style]'))) {
    if (before.get(s) === s.getAttribute('style')) continue
    if (isMark(s)) finish(s)
  }
  return true
}

/** Drop `prop` from every styled span inside `span` — the new outer value
 *  is meant for the whole selection, not just its unstyled parts. */
function clearInside(span: HTMLElement, prop: 'color' | 'font-size') {
  for (const inner of Array.from(span.querySelectorAll<HTMLElement>('span[style]'))) {
    inner.style.removeProperty(prop)
    if (!inner.getAttribute('style')?.trim()) inner.removeAttribute('style')
  }
}

/**
 * Colour the selected text. `value` is a hex/rgb colour, a palette slot
 * (`accent1` …), or null for "automatic" (the element's own colour).
 */
export function applyRunColor(value: string | null, doc: SlidomingoDoc): boolean {
  const slot = value && /^(bg1|tx1|bg2|tx2|accent[1-6]|hlink|folHlink)$/.test(value) ? value as PaletteSlot : null
  if (slot) {
    if (!paletteOf(doc)[slot]) return false
    // foreColor knows no var(): colour with the marker (never the slot's own
    // literal — when that equals the text's colour already, the browser
    // writes no span at all), then point the spans it made at the slot so a
    // re-brand recolours them
    const mark = computedColor(COLOR_MARK)
    return styleSelection('foreColor', COLOR_MARK, (s) => s.style.color === mark, (s) => {
      s.style.color = `var(--sl-${slot})`
      clearInside(s, 'color')
    })
  }
  if (value === null) {
    const mark = computedColor(COLOR_MARK)
    return styleSelection('foreColor', COLOR_MARK, (s) => s.style.color === mark, (s) => {
      s.style.removeProperty('color')
      clearInside(s, 'color')
      if (!s.getAttribute('style')?.trim()) unwrap(s)
    })
  }
  const clean = sanitizeRunColor(value)
  if (!clean) return false
  const mark = computedColor(clean)
  return styleSelection('foreColor', clean, (s) => s.style.color === mark, (s) => clearInside(s, 'color'))
}

/** Set the selected text to `px` slide pixels. */
export function applyRunSize(px: number): boolean {
  if (!Number.isFinite(px) || px <= 0) return false
  const size = `${Math.round(Math.min(1000, Math.max(1, px)) * 100) / 100}px`
  return styleSelection('fontSize', '7', (s) => SIZE_MARK.has(s.style.fontSize), (s) => {
    s.style.fontSize = size
    clearInside(s, 'font-size')
  })
}

/** The selection's current size in points (computed — the canvas's scale is
 *  a transform, so this is slide px, the unit el.fontSize uses). */
export function selectionSizePt(): number | null {
  const root = editRoot()
  const el = root && caretElement(root)
  if (!el) return null
  const px = parseFloat(getComputedStyle(el).fontSize)
  return Number.isFinite(px) ? Math.round((px / PX_PER_PT) * 10) / 10 : null
}

/** A− / A+ on the selection, stepping `step` (the mini toolbar's ladder). */
export function stepRunSize(dir: 1 | -1, step: (pt: number, dir: 1 | -1) => number): boolean {
  const pt = selectionSizePt()
  if (pt === null) return false
  return applyRunSize(step(pt, dir) * PX_PER_PT)
}

function unwrap(el: Element) {
  el.replaceWith(...Array.from(el.childNodes))
}

/**
 * Tidy the edit's DOM just before it is committed (canvas.commitTextEdit):
 * the browser writes things the format does not hold, and a few it holds
 * but nobody asked for.
 *
 *   * <strike> → <s>, <font color> → a coloured span (the sanitizer keeps
 *     neither <strike> nor <font>).
 *   * A run style equal to what the run would inherit anyway is removed.
 *     Chrome writes `<span style="font-size:…;color:…">` copying the
 *     surrounding computed style whenever it merges two lines, and kept,
 *     that literal would pin the run: change the box's colour later and that
 *     one fragment stays the old one. A palette-slot colour is kept even when
 *     it matches — it is a choice to follow the palette, not a copy.
 *   * A span left with no style is unwrapped.
 */
export function normalizeRuns(root: HTMLElement): void {
  for (const n of Array.from(root.querySelectorAll('strike'))) {
    const s = document.createElement('s')
    s.append(...Array.from(n.childNodes))
    n.replaceWith(s)
  }
  for (const f of Array.from(root.querySelectorAll('font'))) {
    const span = document.createElement('span')
    const c = f.getAttribute('color')
    const clean = c ? sanitizeRunColor(c) : null
    if (clean) span.style.color = clean
    span.append(...Array.from(f.childNodes))
    f.replaceWith(span)
  }
  // innermost first, so an outer span is judged against what is left inside
  const spans = Array.from(root.querySelectorAll<HTMLElement>('span[style]')).reverse()
  for (const s of spans) {
    const parent = s.parentElement
    if (!parent) continue
    const own = getComputedStyle(s)
    const up = getComputedStyle(parent)
    if (s.style.color && !s.style.color.startsWith('var(') && own.color === up.color) s.style.removeProperty('color')
    if (s.style.fontSize && own.fontSize === up.fontSize) s.style.removeProperty('font-size')
  }
  for (const s of Array.from(root.querySelectorAll<HTMLElement>('span'))) {
    if (!s.style.color && !s.style.fontSize && !s.className) unwrap(s)
  }
}

// --- links ---------------------------------------------------------------------

/** The link the caret is in, if any. */
export function linkAt(root: HTMLElement | null = editRoot()): HTMLAnchorElement | null {
  if (!root) return null
  const a = caretElement(root)?.closest('a')
  return a && root.contains(a) ? a as HTMLAnchorElement : null
}

/**
 * What the author typed → an href the sanitizer will keep, or null. A bare
 * host ("example.com/x") gets https://, a bare address gets mailto: — the
 * two things people paste without a scheme. Anything else must already be
 * http(s)/mailto.
 */
export function normalizeLinkInput(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (/^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(s)) return sanitizeLinkHref(`mailto:${s}`)
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[^\s/]+\.[^\s/]+/.test(s)) return sanitizeLinkHref(`https://${s}`)
  return sanitizeLinkHref(s)
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;')

/** Make the saved selection a link to `href` (already normalised). A caret in
 *  an existing link retargets it; a bare caret inserts the address itself. */
function applyLink(root: HTMLElement, range: Range | null, href: string) {
  restoreRange(root, range)
  const existing = linkAt(root)
  if (existing && (!range || range.collapsed)) {
    existing.setAttribute('href', href)
    return
  }
  if (!range || range.collapsed) {
    const shown = href.replace(/^mailto:/, '')
    document.execCommand('insertHTML', false, `<a href="${escapeAttr(href)}">${escapeText(shown)}</a>`)
    return
  }
  document.execCommand('createLink', false, href)
}

/** Remove the link around the caret / selection, keeping its words. */
export function removeLink(root: HTMLElement | null = editRoot()): boolean {
  if (!root) return false
  const a = linkAt(root)
  if (a && rangeIn(root)?.collapsed) {
    const r = document.createRange()
    r.selectNodeContents(a)
    const sel = document.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(r)
  }
  document.execCommand('unlink')
  return true
}

let openPop: { el: HTMLElement; close: (refocus: boolean) => void } | null = null

/** Close whichever rich-text popover is open (refocusing the edit). */
export function closeRichPopover(refocus = true) {
  openPop?.close(refocus)
}

/** A popover that keeps the text edit alive while focus is inside it. */
function popover(trigger: HTMLElement, className: string, label: string): { el: HTMLElement; root: HTMLElement; range: Range | null; done: (refocus: boolean) => void } | null {
  closeRichPopover(false)
  const root = editRoot()
  if (!root) return null
  const range = rangeIn(root)?.cloneRange() ?? null
  const el = document.createElement('div')
  el.className = `ed-rt-pop ${className}`
  el.setAttribute(RT_KEEP, '')
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', label)
  document.body.appendChild(el)
  const done = (refocus: boolean) => {
    if (openPop?.el !== el) return
    openPop = null
    document.removeEventListener('mousedown', outside, true)
    // focus goes back BEFORE the popover leaves the DOM: a focused element
    // that is removed fires no focusout, and the canvas would never learn
    // that the edit's focus came home
    if (refocus && root.isConnected) restoreRange(root, range)
    el.remove()
  }
  const outside = (ev: MouseEvent) => {
    if (el.contains(ev.target as Node) || trigger.contains(ev.target as Node)) return
    // A click elsewhere closes it without pulling focus back — but only once
    // that click has moved focus, so the canvas sees where it went (back into
    // the text: the edit goes on; anywhere else: the edit commits).
    setTimeout(() => done(false))
  }
  document.addEventListener('mousedown', outside, true)
  el.addEventListener('keydown', (ev) => {
    ev.stopPropagation()
    if (ev.key === 'Escape') { ev.preventDefault(); done(true) }
  })
  openPop = { el, close: done }
  return { el, root, range, done }
}

function place(trigger: HTMLElement, el: HTMLElement) {
  positionFloating(trigger, el, { placement: 'bottom-start', gap: 6 })
}

/** A button that acts on mousedown and never takes focus (the mini toolbar's
 *  rule — a live text edit must not blur). */
function pressButton(content: string, label: string, onPress: () => void, className = 'ed-rt-btn'): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = className
  b.innerHTML = content
  b.title = label
  b.setAttribute('aria-label', label)
  b.addEventListener('mousedown', (ev) => { if (ev.button === 0) { ev.preventDefault(); onPress() } })
  b.addEventListener('click', (ev) => { if (ev.detail === 0) onPress() })
  return b
}

/** ⌘K / the toolbar's link button: edit the link at the selection. */
export function openLinkEditor(trigger: HTMLElement): void {
  const p = popover(trigger, 'ed-rt-link', t('Link'))
  if (!p) return
  const { el, root, range, done } = p
  const current = linkAt(root)
  const input = document.createElement('input')
  input.type = 'text'
  input.inputMode = 'url'
  input.className = 'ed-rt-input'
  input.placeholder = 'https://…'
  input.setAttribute('aria-label', t('Link address'))
  input.value = current?.getAttribute('href') ?? ''
  const err = document.createElement('div')
  err.className = 'ed-rt-err'
  err.hidden = true
  const row = document.createElement('div')
  row.className = 'ed-rt-row'
  const apply = () => {
    const href = normalizeLinkInput(input.value)
    if (!href) {
      err.textContent = t('Only web (http, https) and e-mail (mailto) links are allowed')
      err.hidden = false
      input.focus()
      return
    }
    done(true)
    applyLink(root, range, href)
  }
  const ok = document.createElement('button')
  ok.type = 'button'
  ok.className = 'ed-btn ed-btn-primary'
  ok.textContent = t('Apply')
  ok.addEventListener('click', apply)
  row.append(input, ok)
  if (current) {
    const rm = document.createElement('button')
    rm.type = 'button'
    rm.className = 'ed-btn'
    rm.textContent = t('Remove link')
    rm.addEventListener('click', () => { done(true); removeLink(root) })
    row.append(rm)
  }
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); apply() }
  })
  input.addEventListener('input', () => { err.hidden = true })
  el.append(row, err)
  place(trigger, el)
  input.focus()
  input.select()
}

/** The standard run colours offered beside the deck's own palette. */
const STANDARD_COLORS = ['#000000', '#ffffff', '#e03131', '#f08c00', '#fcc419', '#2f9e44', '#1971c2', '#6741d9']
const THEME_SLOTS: PaletteSlot[] = ['tx1', 'bg1', 'tx2', 'bg2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']

/** The toolbar's text-colour button: palette slots, standard colours, a
 *  custom picker and "Automatic". */
export function openColorPicker(trigger: HTMLElement, doc: SlidomingoDoc): void {
  const p = popover(trigger, 'ed-rt-color', t('Text color'))
  if (!p) return
  const { el, done } = p
  const pal = paletteOf(doc)
  const pick = (value: string | null) => {
    done(true)
    applyRunColor(value, doc)
  }
  const swatchRow = (title: string, entries: Array<[string, string, string]>) => {
    const h = document.createElement('div')
    h.className = 'ed-rt-caption'
    h.textContent = title
    const row = document.createElement('div')
    row.className = 'ed-rt-swatches'
    for (const [value, paint, label] of entries) {
      const b = pressButton('', label, () => pick(value), 'ed-rt-swatch')
      b.style.background = paint
      row.appendChild(b)
    }
    el.append(h, row)
  }
  // the same names the panel's palette swatches use (colorpicker.ts)
  const slotLabel: Partial<Record<PaletteSlot, string>> = {
    bg1: t('Background 1 (theme background color)'),
    tx1: t('Text 1 (theme text color)'),
    bg2: t('Background 2 (theme secondary background color)'),
    tx2: t('Text 2 (theme secondary text color)'),
    accent1: t('Accent 1 (theme accent color)'),
    accent2: t('Accent 2 (theme accent color)'),
    accent3: t('Accent 3 (theme accent color)'),
    accent4: t('Accent 4 (theme accent color)'),
    accent5: t('Accent 5 (theme accent color)'),
    accent6: t('Accent 6 (theme accent color)'),
  }
  swatchRow(t('Theme colors'), THEME_SLOTS.filter((s) => pal[s]).map((s) => [s, pal[s]!, slotLabel[s] ?? s]))
  swatchRow(t('Standard colors'), STANDARD_COLORS.map((c) => [c, c, c]))
  const foot = document.createElement('div')
  foot.className = 'ed-rt-row'
  const auto = pressButton(t('Automatic'), t('Use the text box’s own color'), () => pick(null), 'ed-btn')
  const custom = document.createElement('input')
  custom.type = 'color'
  custom.className = 'ed-rt-custom'
  custom.title = t('Custom color…')
  custom.setAttribute('aria-label', t('Custom color…'))
  custom.addEventListener('change', () => {
    done(true)
    applyRunColor(custom.value, doc)
  })
  foot.append(auto, custom)
  el.append(foot)
  place(trigger, el)
}

// --- clipboard -------------------------------------------------------------------

/**
 * Text-edit copy and paste carry the formatting with them. The paste path
 * otherwise reads only text/plain (markdownToHtml), which is right for text
 * from anywhere else — but a browser's text/plain of a list is bare lines, so
 * copying a list from one box to another lost it. A copy inside a live edit
 * therefore ALSO writes this flavour, holding the selection's html; a paste
 * that finds it inserts that html. Both directions go through sanitizeHtml —
 * any page can write this type to the clipboard, so it is no more trusted
 * than any other html.
 */
export const RICH_MIME = 'text/x-slidomingo-rich'

export function richCopy(ev: ClipboardEvent, cut: boolean): void {
  const root = editRoot()
  const r = root && rangeIn(root)
  if (!root || !r || r.collapsed || !ev.clipboardData) return
  const box = document.createElement('div')
  box.appendChild(r.cloneContents())
  // a selection across items clones the <li>s without their list
  if (box.firstElementChild?.tagName === 'LI') {
    const owner = (r.commonAncestorContainer instanceof Element ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement)?.closest('ul, ol')
    const list = document.createElement(owner?.tagName === 'OL' ? 'ol' : 'ul')
    list.append(...Array.from(box.childNodes))
    box.appendChild(list)
  }
  const html = sanitizeHtml(box.innerHTML)
  ev.clipboardData.setData('text/plain', document.getSelection()?.toString() ?? box.textContent ?? '')
  ev.clipboardData.setData('text/html', html)
  ev.clipboardData.setData(RICH_MIME, html)
  ev.preventDefault()
  if (cut) document.execCommand('delete')
}

/** Paste our own flavour, if the clipboard has it. True = handled. */
export function richPaste(ev: ClipboardEvent): boolean {
  const html = ev.clipboardData?.getData(RICH_MIME)
  if (!html) return false
  ev.preventDefault()
  document.execCommand('insertHTML', false, sanitizeHtml(html))
  return true
}

/**
 * Keyboard shortcuts inside a live text edit. Returns true when it handled
 * the key (the caller then stops there):
 *   ⌘K link · ⌘⇧7 numbered list · ⌘⇧8 bulleted list · Tab / ⇧Tab list level
 */
export function handleRichKey(ev: KeyboardEvent, linkTrigger: () => HTMLElement): boolean {
  const mod = ev.metaKey || ev.ctrlKey
  if (mod && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'k') {
    ev.preventDefault()
    openLinkEditor(linkTrigger())
    return true
  }
  if (mod && ev.shiftKey && (ev.code === 'Digit7' || ev.code === 'Digit8')) {
    ev.preventDefault()
    toggleList(ev.code === 'Digit7')
    return true
  }
  if (ev.key === 'Tab' && !mod && !ev.altKey && indentList(ev.shiftKey ? -1 : 1)) {
    ev.preventDefault()
    return true
  }
  return false
}

/** Exported for the rigs: the colour a palette slot run is stored as. */
export const themeRunColor = (slot: PaletteSlot): string => `var(--sl-${slot})`
