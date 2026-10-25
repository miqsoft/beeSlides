// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// propose_variants compare view: an LLM proposes up to 6 designs for ONE
// slide (desktop/src/mcp/slides-mcp-server.mjs's propose_variants tool,
// built by editor.ts's proposeVariants into Editor.pendingVariants) and the
// person compares them with the slide as it is and picks one, keeps the
// slide, or decides later.
//
// A modal <dialog> (top layer: above the title bar's z-index ceiling, focus
// kept inside, Esc for free) with two views over the same set:
//   - all designs: a grid sized so every design fits on screen at once;
//   - one design: large, with a strip to flip between it, the others and
//     the current slide (← →, 0–6), Enter uses it.
//
// Closing it (Esc, ×, "Decide later") discards NOTHING: only Use, Keep
// current slide, or a later propose_variants call replacing the set clears
// Editor.pendingVariants, and the ✨ badges (title bar, the slide's
// thumbnail) reopen it.
//
// Candidates are NOT part of `store.doc` yet — never committed until Use
// (editor.ts's applyVariant) — so they render against a THROWAWAY doc: a
// shallow copy of store.doc with the pending assets merged in for preview
// only, never assigned back to store.doc.

import type { SlidomingoDoc, Slide } from '../model'
import type { Store } from '../store'
import type { Editor } from './editor'
import { renderThumbnail } from '../render'
import { ICONS } from '../icons'
import { t } from '../i18n'
import { themedDoc, type ThemePatch } from './agentops'

/** The most designs one propose_variants call offers. */
export const MAX_VARIANTS = 6

/** One candidate design of the target slide. */
export interface PendingVariant {
  slide: Slide
  label?: string
  /** One line on what the design does differently (from the agent). */
  note?: string
  /** A look offered with its own theme: previewed under it, and Use sets
   *  it as the deck theme (in the same undo step). */
  theme?: ThemePatch
}

/** Editor.pendingVariants' shape — a single pending slot (not a queue): a
 *  later propose_variants call REPLACES this wholesale. */
export interface PendingVariants {
  slideId: string
  variants: PendingVariant[]
  assets: Record<string, string>
  fonts: NonNullable<SlidomingoDoc['fonts']>
  /** The target slide as it was when the designs were proposed (JSON): the
   *  view warns when it has been edited since, since Use replaces it. */
  baseline: string
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function button(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, text)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

/** Closes and removes the compare view, if it is open. */
export function closeVariantPicker(): void {
  const open = document.querySelector<HTMLDialogElement>('dialog.ed-variants')
  if (!open) return
  if (open.open) open.close()
  open.remove()
}

export function openVariantPicker(editor: Editor, store: Store): void {
  closeVariantPicker()
  const pending = editor.getPendingVariants()
  if (!pending) return
  const current = store.doc.slides.find((s) => s.id === pending.slideId)
  if (!current) return
  const num = store.doc.slides.indexOf(current) + 1
  const n = pending.variants.length
  // a design stands in its slide's place, so {{page}} reads as it will once used
  // and one with a theme of its own shows under it
  const previewDocFor = (v: PendingVariant): SlidomingoDoc => ({
    ...themedDoc(store.doc, v.theme),
    assets: { ...store.doc.assets, ...pending.assets },
    slides: store.doc.slides.map((s) => (s.id === pending.slideId ? v.slide : s)),
  })
  const aspect = store.doc.size.width / store.doc.size.height
  const labelOf = (i: number) => pending.variants[i].label || t('Design {n}', { n: i + 1 })

  /** A rendered slide at `width` px, or a quiet placeholder if it fails. */
  const shot = (v: PendingVariant | null, width: number): HTMLElement => {
    try {
      return renderThumbnail(v ? v.slide : current, v ? previewDocFor(v) : store.doc, Math.max(40, Math.floor(width)))
    } catch {
      const broken = el('div', 'ed-variants-broken', t('Preview unavailable'))
      broken.style.width = `${Math.floor(width)}px`
      broken.style.height = `${Math.floor(width / aspect)}px`
      return broken
    }
  }

  const dlg = el('dialog', 'ed-variants')
  dlg.setAttribute('aria-labelledby', 'ed-variants-title')

  const head = el('header', 'ed-variants-head')
  const titles = el('div', 'ed-variants-titles')
  const h = el('h2', 'ed-variants-title')
  h.id = 'ed-variants-title'
  h.innerHTML = ICONS.sparkle
  h.append(el('span', '', n === 1 ? t('One design for slide {num}', { num }) : t('{n} designs for slide {num}', { n, num })))
  titles.append(h, el('p', 'ed-variants-sub', t('Proposed by Claude. Nothing on the slide changes until you pick one.')))
  const x = button('ed-variants-x', '×', () => closeVariantPicker())
  x.setAttribute('aria-label', t('Decide later'))
  x.title = t('Decide later')
  head.append(titles, x)

  const warn = el('div', 'ed-variants-warn', t('You changed this slide after these designs were proposed. Using one replaces those changes.'))
  warn.hidden = JSON.stringify(current) === pending.baseline

  const body = el('div', 'ed-variants-body')

  const foot = el('footer', 'ed-variants-foot')
  const hint = el('span', 'ed-variants-hint')
  const keep = button('ed-variants-btn', t('Keep current slide'), () => editor.discardVariants())
  const later = button('ed-variants-btn', t('Decide later'), () => closeVariantPicker())
  const use = button('ed-variants-btn ed-primary', t('Use this design'), () => { if (focus) editor.applyVariant(focus - 1) })
  foot.append(hint, keep, later, use)

  dlg.append(head, warn, body, foot)

  /** null = all designs; 0 = the current slide; 1…n = that design. */
  let focus: number | null = null

  /** The body's width inside its padding (clientWidth includes it). */
  const contentWidth = () => {
    const cs = getComputedStyle(body)
    return (body.clientWidth || Math.min(1180, window.innerWidth - 48)) - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  }

  const renderGrid = () => {
    body.replaceChildren()
    const cols = n <= 3 ? n : n === 4 ? 2 : 3
    const rows = Math.ceil(n / cols)
    const gap = 20
    const meta = 74 // label, note, button under each picture
    const byWidth = (contentWidth() - gap * (cols - 1)) / cols
    const byHeight = ((window.innerHeight - 250) / rows - meta - gap) * aspect
    const w = Math.max(160, Math.min(byWidth, byHeight, 560))
    const grid = el('div', 'ed-variants-grid')
    grid.style.gridTemplateColumns = `repeat(${cols}, ${Math.floor(w)}px)`
    pending.variants.forEach((v, i) => {
      const card = el('div', 'ed-variants-card')
      const pic = el('button', 'ed-variants-shot')
      pic.type = 'button'
      pic.title = t('See it large')
      pic.append(shot(v, w), el('span', 'ed-variants-key', String(i + 1)))
      pic.addEventListener('click', () => show(i + 1))
      const info = el('div', 'ed-variants-meta')
      const text = el('div', 'ed-variants-text')
      text.append(el('strong', 'ed-variants-label', labelOf(i)))
      if (v.note) text.append(el('span', 'ed-variants-note', v.note))
      if (v.theme) text.append(el('span', 'ed-variants-note', t('Also sets the colours and fonts of the whole deck.')))
      info.append(text, button('ed-variants-btn ed-primary ed-variants-use', t('Use'), () => editor.applyVariant(i)))
      card.append(pic, info)
      grid.append(card)
    })
    body.append(grid)
    hint.textContent = t('Click a design to see it large next to the current slide.')
    use.hidden = true
    body.querySelector<HTMLElement>('.ed-variants-shot')?.focus()
  }

  const renderStage = (k: number) => {
    body.replaceChildren()
    const stage = el('div', 'ed-variants-stage')
    const stripH = 64
    const w = Math.max(240, Math.min(contentWidth(), (window.innerHeight - 330 - stripH) * aspect))
    const big = el('div', 'ed-variants-big')
    big.append(shot(k === 0 ? null : pending.variants[k - 1], w))
    const caption = el('div', 'ed-variants-caption')
    caption.append(el('strong', 'ed-variants-label', k === 0 ? t('Current slide') : labelOf(k - 1)))
    const note = k === 0 ? t('The slide as it is now.') : pending.variants[k - 1].note
    if (note) caption.append(el('span', 'ed-variants-note', note))
    if (k > 0 && pending.variants[k - 1].theme) caption.append(el('span', 'ed-variants-note', t('Also sets the colours and fonts of the whole deck.')))
    const strip = el('div', 'ed-variants-strip')
    strip.setAttribute('role', 'tablist')
    for (let j = 0; j <= n; j++) {
      const tab = el('button', 'ed-variants-tab')
      tab.type = 'button'
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', String(j === k))
      tab.title = j === 0 ? t('Current slide') : labelOf(j - 1)
      tab.append(shot(j === 0 ? null : pending.variants[j - 1], stripH * aspect), el('span', 'ed-variants-key', j === 0 ? t('Now') : String(j)))
      tab.addEventListener('click', () => show(j))
      strip.append(tab)
    }
    const back = button('ed-variants-back', `← ${t('All designs')}`, () => show(null))
    stage.append(back, big, caption, strip)
    body.append(stage)
    hint.textContent = t('← → flip between them · Enter uses this one · Esc goes back')
    use.hidden = false
    use.disabled = k === 0
    ;(k === 0 ? strip.querySelector<HTMLElement>('[aria-selected="true"]') : use)?.focus()
  }

  const show = (k: number | null) => {
    focus = k
    dlg.classList.toggle('ed-variants-one', k !== null)
    if (k === null) renderGrid()
    else renderStage(k)
  }

  dlg.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return
    const typing = (ev.target as HTMLElement)?.closest?.('input, textarea, [contenteditable="true"]')
    if (typing) return
    if (/^[0-6]$/.test(ev.key) && Number(ev.key) <= n && (focus !== null || ev.key !== '0')) {
      ev.preventDefault()
      show(Number(ev.key))
    } else if (focus !== null && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
      ev.preventDefault()
      show((focus + (ev.key === 'ArrowRight' ? 1 : n)) % (n + 1))
    } else if (focus !== null && focus > 0 && ev.key === 'Enter' && !(ev.target instanceof HTMLButtonElement)) {
      ev.preventDefault()
      editor.applyVariant(focus - 1)
    }
  })
  // Esc: one design → all designs → closed (nothing discarded)
  dlg.addEventListener('cancel', (ev) => {
    if (focus === null) return
    ev.preventDefault()
    show(null)
  })
  dlg.addEventListener('close', () => {
    dlg.remove()
    window.removeEventListener('resize', onResize)
  })
  // a press on the backdrop (outside the box) is "decide later"
  dlg.addEventListener('pointerdown', (ev) => {
    if (ev.target !== dlg) return
    const r = dlg.getBoundingClientRect()
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) closeVariantPicker()
  })
  let raf = 0
  const onResize = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => show(focus))
  }
  window.addEventListener('resize', onResize)

  document.body.appendChild(dlg)
  dlg.showModal()
  show(null)
}
