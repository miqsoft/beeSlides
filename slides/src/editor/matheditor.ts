// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The equation popover — `MathEditSession`. Opened by Insert ▸ Equation, by
// double-clicking an equation, or from its panel / mini toolbar / context
// menu (all via canvas.startMathEdit). It holds:
//
//   palette (mathpalettebar.ts) · TeX textarea · live preview · error line ·
//   Display/Inline toggle · Cancel / Insert (Done)
//
// Rules it keeps:
//   * ONE commit = ONE undo step, and only when something changed. Insert ▸
//     Equation opens the popover FIRST: the element is created by the
//     commit, so cancelling (Esc, Cancel, ⌘Z) leaves the deck untouched.
//   * Typing previews live — in the popover, and for an existing equation on
//     the canvas node itself (DOM only; the model is not touched until the
//     commit, and a cancel re-renders).
//   * ⌘/Ctrl+Enter commits, Esc cancels, Tab/Shift+Tab walk the empty `{}`
//     slots. A click outside commits (like crop mode), except on the undo/
//     redo buttons (`data-keeps-crop`), whose undo cancels the session instead.
//   * The commit fits the box (measure.ts fitMathFrame): the height to the
//     formula, the width only ever grows.

import type { Store } from '../store'
import { effectiveCanvasSize } from '../store'
import type { SlideCanvas } from './canvas'
import { defaultMath, readableInk, textDefaultsFor, type MathElement, type Slide } from '../model'
import { renderElement } from '../render'
import { renderTex, texError } from '../math'
import { fitMathFrame } from '../measure'
import { t } from '../i18n'
import { buildMathPalette, insertIntoTextarea, tabToSlot } from './mathpalettebar'
import { positionAtRect } from './floatingposition'

const ERROR_DELAY = 350

let current: MathEditSession | null = null

/** The open session, if any. */
export function activeMathEdit(): MathEditSession | null {
  return current
}

export interface MathEditOpts {
  store: Store
  canvas: SlideCanvas
  /** the equation to edit; absent = a new one, inserted by the commit */
  elId?: string
  /** called once the session has ended, committed or not */
  onEnd?: () => void
}

export class MathEditSession {
  readonly el: HTMLElement
  private ta: HTMLTextAreaElement
  private preview: HTMLElement
  private err: HTMLElement
  private inline: boolean
  private readonly original: { tex: string; inline: boolean }
  /** the surface the session began on — a slide switch must not retarget it */
  private readonly slide: Slide
  private errTimer = 0
  private ended = false
  private readonly offDoc: () => unknown
  private readonly onOutside: (ev: MouseEvent) => void

  constructor(private opts: MathEditOpts) {
    current?.cancel()
    current = this
    const { store } = opts
    this.slide = store.slide
    const el = this.model()
    this.original = { tex: el?.tex ?? '', inline: !!el?.inline }
    this.inline = this.original.inline

    const pop = document.createElement('div')
    this.el = pop
    pop.className = 'ed-math-pop'
    pop.setAttribute('role', 'dialog')
    pop.setAttribute('aria-label', t('Equation'))

    const head = document.createElement('div')
    head.className = 'ed-math-head'
    const title = document.createElement('strong')
    title.textContent = opts.elId ? t('Edit equation') : t('Insert equation')
    const seg = document.createElement('div')
    seg.className = 'ed-math-seg'
    seg.setAttribute('role', 'group')
    seg.setAttribute('aria-label', t('Style'))
    const mode = (label: string, tip: string, inline: boolean) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.title = tip
      b.dataset.inline = String(inline)
      b.addEventListener('mousedown', (ev) => ev.preventDefault())
      b.addEventListener('click', () => { this.inline = inline; this.syncMode(); this.update() })
      seg.appendChild(b)
    }
    mode(t('Display'), t('Display style — full-size fractions, limits above and below big operators'), false)
    mode(t('Inline'), t('Inline style — compact, the way a formula sits inside a line of text'), true)
    head.append(title, seg)

    const ta = document.createElement('textarea')
    this.ta = ta
    ta.className = 'ed-math-tex'
    ta.rows = 3
    ta.spellcheck = false
    ta.autocapitalize = 'off'
    ta.setAttribute('autocorrect', 'off')
    ta.setAttribute('aria-label', t('TeX source'))
    ta.placeholder = t('Type LaTeX, e.g. \\frac{a}{b} — or pick from the palette')
    ta.value = this.original.tex

    const palette = buildMathPalette((s) => insertIntoTextarea(ta, s, () => this.update()))

    this.preview = document.createElement('div')
    this.preview.className = 'ed-math-preview'
    this.preview.setAttribute('aria-hidden', 'true')
    this.err = document.createElement('div')
    this.err.className = 'ed-math-err'
    this.err.setAttribute('role', 'status')
    this.err.setAttribute('aria-live', 'polite')

    const foot = document.createElement('div')
    foot.className = 'ed-math-foot'
    const hint = document.createElement('span')
    hint.className = 'ed-math-hint'
    hint.textContent = t('⌘↵ apply · Esc cancel · Tab next box')
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'ed-btn'
    cancel.textContent = t('Cancel')
    cancel.addEventListener('click', () => this.cancel())
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'ed-btn ed-btn-primary'
    ok.textContent = opts.elId ? t('Done') : t('Insert')
    ok.addEventListener('click', () => this.commit())
    foot.append(hint, cancel, ok)

    pop.append(head, palette, ta, this.preview, this.err, foot)
    document.body.appendChild(pop)
    this.syncMode()

    ta.addEventListener('input', () => this.update())
    // Keys stay in the popover: the editor's shortcuts must not see Delete,
    // arrows or ⌘D typed into the TeX. ⌘S and ⌘, still reach it.
    pop.addEventListener('keydown', (ev) => {
      const mod = ev.metaKey || ev.ctrlKey
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.cancel(); return }
      if (mod && ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); this.commit(); return }
      if (ev.key === 'Tab' && ev.target === ta && !mod && !ev.altKey) {
        if (tabToSlot(ta, ev.shiftKey)) ev.preventDefault()
        ev.stopPropagation()
        return
      }
      if (mod && (ev.key.toLowerCase() === 's' || ev.key === ',')) return
      ev.stopPropagation()
    })
    this.onOutside = (ev: MouseEvent) => {
      const target = ev.target as Element | null
      if (!target || pop.contains(target)) return
      if (target.closest?.('[data-keeps-crop]')) return // undo/redo cancel the session instead
      this.commit()
    }
    document.addEventListener('mousedown', this.onOutside, true)
    // the model changed underneath (an agent write, a remote edit): an
    // equation that is gone ends the session
    const onDoc = () => { if (this.opts.elId && !this.model()) this.end(false) }
    this.offDoc = store.on('doc', onDoc)

    this.update(true)
    this.place()
    ta.focus()
    if (!this.original.tex) ta.setSelectionRange(0, 0)
    else ta.select()
  }

  get isNew(): boolean {
    return !this.opts.elId
  }

  /** The equation being edited, on the surface the session began on. */
  private model(): MathElement | undefined {
    const id = this.opts.elId
    if (!id) return undefined
    const el = this.slide.elements.find((e) => e.id === id)
    return el?.type === 'math' ? el : undefined
  }

  private syncMode() {
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.ed-math-seg button')) {
      const on = b.dataset.inline === String(this.inline)
      b.setAttribute('aria-pressed', String(on))
      b.classList.toggle('is-on', on)
    }
  }

  /** Re-typeset the preview (popover + canvas), and schedule the error line. */
  private update(immediate = false) {
    const tex = this.ta.value
    const ml = tex.trim() ? renderTex(tex, !this.inline) : null
    if (ml) this.preview.innerHTML = ml
    else this.preview.textContent = tex.trim() ? '' : t('Preview')
    this.preview.classList.toggle('is-empty', !tex.trim())
    this.preview.classList.toggle('is-bad', !!tex.trim() && !ml)
    this.previewOnCanvas(tex)
    clearTimeout(this.errTimer)
    const show = () => {
      const msg = texError(tex)
      this.err.textContent = msg ? t('TeX error: {msg}', { msg }) : ''
      this.err.hidden = !msg
    }
    if (immediate) show()
    else {
      this.err.hidden = true
      this.errTimer = window.setTimeout(show, ERROR_DELAY)
    }
  }

  /** Show the edit on the canvas node of an existing equation — DOM only. */
  private previewOnCanvas(tex: string) {
    const el = this.model()
    if (!el) return
    const node = document.querySelector<HTMLElement>(`.ed-stage-scale [data-el-id="${CSS.escape(el.id)}"]`)
    if (!node) return
    const fresh = renderElement({ ...el, tex, inline: this.inline || undefined }, this.opts.store.doc)
    node.replaceChildren(...Array.from(fresh.childNodes))
  }

  private place() {
    const el = this.model()
    const node = el && document.querySelector<HTMLElement>(`.ed-stage-scale [data-el-id="${CSS.escape(el.id)}"]`)
    const view = this.opts.canvas.viewportRect()
    const anchor = node?.getBoundingClientRect()
      ?? { left: view.left, right: view.right, top: view.top + 24, bottom: view.top + 24 }
    positionAtRect(anchor, this.el, { placement: 'bottom', align: 'center', gap: 12, margin: 12 })
  }

  /** Apply: one store commit (none when nothing changed), then end. */
  commit() {
    if (this.ended) return
    const { store, canvas } = this.opts
    const tex = this.ta.value
    const el = this.model()
    if (this.opts.elId) {
      if (!el || (tex === this.original.tex && this.inline === this.original.inline)) { this.end(false); return }
      const next: MathElement = { ...el, tex, inline: this.inline || undefined }
      const frame = fitMathFrame(next, store.doc)
      this.end(true)
      store.commit(() => {
        el.tex = tex
        if (this.inline) el.inline = true
        else delete el.inline
        Object.assign(el, frame)
      })
      return
    }
    if (!tex.trim()) { this.end(false); return } // nothing to insert
    const td = textDefaultsFor(store.doc, this.slide)
    const base = defaultMath({
      tex,
      ...(this.inline ? { inline: true } : {}),
      color: td.color ?? readableInk(this.slide.background ?? ''),
      ...(td.themeRefs ? { themeRefs: td.themeRefs } : {}),
    })
    const f = fitMathFrame(base, store.doc)
    const size = effectiveCanvasSize(store)
    base.w = f.w
    base.h = f.h
    base.x = Math.round((size.width - f.w) / 2)
    base.y = Math.round((size.height - f.h) / 2)
    this.end(true)
    if (this.slide === store.slide) canvas.insert(base)
    else store.commit(() => { this.slide.elements.push(base) })
  }

  /** Leave without applying anything. */
  cancel() {
    this.end(false)
  }

  private end(committing: boolean) {
    if (this.ended) return
    this.ended = true
    if (current === this) current = null
    clearTimeout(this.errTimer)
    document.removeEventListener('mousedown', this.onOutside, true)
    this.offDoc()
    this.el.remove()
    // the canvas node may still show the uncommitted preview
    if (!committing && this.opts.elId) this.opts.canvas.render()
    this.opts.onEnd?.()
  }
}
