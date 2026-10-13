// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The equation palette widget: a row of group tabs over a grid of typeset
// buttons (content and text surgery: mathpalette.ts). One widget, four hosts:
//
//   * the equation popover (matheditor.ts) and the equation panel's TeX
//     field (panels.ts) — a <textarea> target (`textareaTarget`);
//   * a live text-box or table-cell edit — the mini toolbar's ∑ button and
//     Typography's "Insert equation…" open it as a popover over the edit
//     (`openProsePalette`); a pick there is typed as `$…$` unless the caret
//     already sits inside math.
//
// Every button acts on MOUSEDOWN with preventDefault, so picking never takes
// focus from the field being typed into (the mini toolbar's rule): the
// textarea keeps its selection, the contentEditable its caret, and a live
// text edit is never blurred into committing.

import { lsGet, lsSet } from '../../../kernel/src/storage.ts'
import { t } from '../i18n'
import { renderTex } from '../math'
import { MATH_PALETTE, insertSnippet, mathContextAt, nextSlot, proseSnippet, type MathGroup, type MathSnippet } from './mathpalette'
import { RT_KEEP, editRoot } from './richtext'
import { positionAtRect } from './floatingposition'

const GROUP_KEY = 'slidomingo-math-palette-group'

/** Groups whose items read better in display style (big operators, stacked
 *  fractions); symbols stay text-sized. */
const DISPLAY_GROUPS = new Set(['structures', 'operators', 'matrices', 'formulas'])

/**
 * Build a palette that calls `pick` with each chosen snippet. The open group
 * is remembered per viewer (localStorage) — a convenience, never state.
 */
export function buildMathPalette(pick: (s: MathSnippet) => void): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ed-math-palette'
  root.setAttribute(RT_KEEP, '')
  const tabs = document.createElement('div')
  tabs.className = 'ed-math-tabs'
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', t('Equation palette'))
  const grid = document.createElement('div')
  grid.className = 'ed-math-grid'
  grid.setAttribute('role', 'tabpanel')
  root.append(tabs, grid)

  let active = MATH_PALETTE.find((g) => g.id === lsGet(GROUP_KEY)) ?? MATH_PALETTE[0]
  const show = (g: MathGroup) => {
    active = g
    lsSet(GROUP_KEY, g.id)
    for (const b of tabs.querySelectorAll<HTMLElement>('button')) {
      const on = b.dataset.group === g.id
      b.setAttribute('aria-selected', String(on))
      b.classList.toggle('is-on', on)
    }
    grid.classList.toggle('ed-math-grid-wide', !!g.wide)
    grid.replaceChildren(...g.items.map((it) => itemButton(g, it, pick)))
  }
  for (const g of MATH_PALETTE) {
    const b = pressButton(g.icon, t(g.label), () => show(g))
    b.dataset.group = g.id
    b.setAttribute('role', 'tab')
    b.className = 'ed-math-tab'
    tabs.appendChild(b)
  }
  show(active)
  return root
}

function itemButton(g: MathGroup, it: MathSnippet, pick: (s: MathSnippet) => void): HTMLButtonElement {
  const label = it.label ? `${t(it.label)} — ${it.tex}` : it.tex
  const b = pressButton(it.preview ?? it.tex, label, () => pick(it), DISPLAY_GROUPS.has(g.id))
  b.className = 'ed-math-item'
  b.dataset.tex = it.tex
  if (g.wide && it.label) {
    const cap = document.createElement('span')
    cap.className = 'ed-math-item-cap'
    cap.textContent = t(it.label)
    b.appendChild(cap)
  }
  return b
}

/** A button showing typeset TeX that acts on mousedown and never takes focus. */
function pressButton(tex: string, label: string, onPress: () => void, display = false): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.title = label
  b.setAttribute('aria-label', label)
  const glyph = document.createElement('span')
  glyph.className = 'ed-math-glyph'
  // Temml output of our OWN constant TeX — never author input
  const ml = renderTex(tex, display)
  if (ml) glyph.innerHTML = ml
  else glyph.textContent = tex
  b.appendChild(glyph)
  b.addEventListener('mousedown', (ev) => { if (ev.button === 0) { ev.preventDefault(); onPress() } })
  b.addEventListener('click', (ev) => { if (ev.detail === 0) onPress() })
  return b
}

// --- targets -------------------------------------------------------------------

/**
 * Insert a snippet into a textarea at its selection (wrapping a selection
 * into the first slot) and put the caret in the first empty slot. `changed`
 * runs after, for hosts that react to input.
 */
export function insertIntoTextarea(ta: HTMLTextAreaElement, s: MathSnippet, changed?: () => void) {
  const e = insertSnippet(ta.value, ta.selectionStart, ta.selectionEnd, s.tex)
  ta.focus({ preventScroll: true })
  // through execCommand, so the textarea's own undo (⌘Z) takes a pick back
  ta.setSelectionRange(0, ta.value.length)
  if (!document.execCommand('insertText', false, e.text)) ta.value = e.text
  ta.setSelectionRange(e.selStart, e.selEnd)
  changed?.()
}

/** Tab / Shift+Tab in a TeX textarea: jump to the next/previous empty `{}`
 *  slot. Returns true when it moved (the caller prevents the default). */
export function tabToSlot(ta: HTMLTextAreaElement, back: boolean): boolean {
  const s = nextSlot(ta.value, back ? ta.selectionStart : ta.selectionEnd, back)
  if (!s) return false
  ta.setSelectionRange(s.start, s.end)
  return true
}

/**
 * Type a snippet into the live text-box / table-cell edit at its caret —
 * wrapped as `$…$` unless the caret is already inside math — and put the
 * caret in its first slot. Through execCommand, so the edit's own undo
 * takes it back. False when no edit is live.
 */
export function insertIntoProse(s: MathSnippet, range?: Range | null): boolean {
  const root = editRoot()
  if (!root) return false
  root.focus({ preventScroll: true })
  const sel = document.getSelection()
  if (range && sel && root.contains(range.commonAncestorContainer)) {
    sel.removeAllRanges()
    sel.addRange(range)
  }
  if (!sel || !sel.rangeCount || !root.contains(sel.getRangeAt(0).commonAncestorContainer)) return false
  const head = document.createRange()
  head.setStart(root, 0)
  head.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset)
  const before = head.toString()
  const p = proseSnippet(s.tex, mathContextAt(before, before.length) !== null)
  document.execCommand('insertText', false, p.text)
  for (let i = 0; i < p.caretBack; i++) sel.modify('move', 'backward', 'character')
  return true
}

let openProse: { el: HTMLElement; trigger: HTMLElement; close: () => void } | null = null

/** Close the prose palette popover, if one is open. */
export function closeProsePalette() {
  openProse?.close()
}

/**
 * The palette as a popover over a live text or cell edit (the mini
 * toolbar's ∑, Typography's "Insert equation…"). It stays open for several
 * picks; Esc, the trigger again or a click elsewhere closes it. `fallback`
 * runs instead when no edit is live (the panel's button on a merely
 * selected text box).
 */
export function openProsePalette(trigger: HTMLElement, fallback?: (s: MathSnippet) => void): void {
  const same = openProse?.trigger === trigger
  closeProsePalette()
  if (same) return
  const root = editRoot()
  const sel = document.getSelection()
  const range = root && sel?.rangeCount && root.contains(sel.getRangeAt(0).commonAncestorContainer)
    ? sel.getRangeAt(0).cloneRange() : null
  const el = document.createElement('div')
  el.className = 'ed-math-pop ed-math-pop-prose'
  el.setAttribute(RT_KEEP, '')
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', t('Equation palette'))
  el.appendChild(buildMathPalette((s) => {
    if (!insertIntoProse(s, range)) fallback?.(s)
  }))
  const hint = document.createElement('p')
  hint.className = 'ed-math-hint'
  hint.textContent = t('Typed at the caret as $…$ math')
  el.appendChild(hint)
  document.body.appendChild(el)
  positionAtRect(trigger.getBoundingClientRect(), el, { placement: 'bottom', align: 'start', gap: 6 })
  const close = () => {
    if (openProse?.el !== el) return
    openProse = null
    document.removeEventListener('mousedown', outside, true)
    document.removeEventListener('keydown', onKey, true)
    el.remove()
  }
  const outside = (ev: MouseEvent) => {
    if (el.contains(ev.target as Node) || trigger.contains(ev.target as Node)) return
    close()
  }
  // capture: Esc closes the palette first, and only the palette
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); close() } }
  document.addEventListener('mousedown', outside, true)
  document.addEventListener('keydown', onKey, true)
  openProse = { el, trigger, close }
}
