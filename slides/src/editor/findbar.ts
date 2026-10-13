// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The find / replace bar — the UI half of find & replace (the search itself
// is findreplace.ts, pure and rig-tested). Floats at the top-right of
// `.ed-canvas-wrap`. ⌘F opens it, ⌥⌘F (and Ctrl+H off the Mac) opens it with
// the replace row; Edit ▸ Find… / Find and replace… do the same.
//
// Navigation selects the slide + element; the match itself is painted with
// the CSS Custom Highlight API (no DOM surgery on the canvas, so Moveable and
// text editing never see it), where the browser has it. A notes match opens
// the notes pane and selects the text there. "Replace all" is ONE store
// commit, so one undo step; "Replace" re-verifies the match before writing.

import type { Store } from '../store'
import type { SlideCanvas } from './canvas'
import type { Slide, SlideElement } from '../model'
import { ancestorElementIds } from '../model'
import { t, tc } from '../i18n'
import { refuseGatedWrite } from '../formatgate'
import { isMacOS } from '../screens'
import {
  findMatches, replaceAll, planReplaceMatch, renderedSpans, fieldSource, fieldKey,
  type FindMatch, type FindOptions,
} from './findreplace'

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICON = {
  chevron: svg('<polyline points="9 6 15 12 9 18"/>'),
  up: svg('<polyline points="6 15 12 9 18 15"/>'),
  down: svg('<polyline points="6 9 12 15 18 9"/>'),
  close: svg('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
}

/** The find chords: ⌘F → 'find', ⌥⌘F → 'replace' (⌘H hides the app on a
 *  Mac and ⇧⌘H is the desktop Start Page, so neither can be ours); off the
 *  Mac Ctrl+F / Ctrl+Alt+F, plus Ctrl+H, the Windows convention. ⌥ turns F
 *  into "ƒ", hence `code` there. Off the Mac Ctrl+Alt IS AltGr (Windows
 *  reports AltGr as Ctrl+Alt): AltGr+F types "[" on Czech, Slovak and
 *  Hungarian keyboards, so a chord that is AltGr or types a non-letter is
 *  left alone (a non-Latin layout's Ctrl+Alt+F types its own LETTER, e.g.
 *  Russian "а", and is still the chord); Ctrl+H always works. Shared by editor.ts and the inline text
 *  editors (canvas.ts), which let these through to the editor. */
export function findChord(ev: KeyboardEvent): 'find' | 'replace' | null {
  const mac = isMacOS()
  const mod = mac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey
  if (!mod || ev.shiftKey) return null
  if (ev.altKey) {
    if (ev.code !== 'KeyF') return null
    if (!mac && (ev.getModifierState?.('AltGraph') || (ev.key.length === 1 && ev.key.toLowerCase() !== 'f' && !/\p{L}/u.test(ev.key)))) return null
    return 'replace'
  }
  const k = ev.key.toLowerCase()
  if (k === 'f') return 'find'
  if (!mac && k === 'h') return 'replace'
  return null
}

/** Highlight names (styled with `::highlight()` in styles.css). */
const HL_ALL = 'slidomingo-find'
const HL_CUR = 'slidomingo-find-current'

export interface FindBarHost {
  toast(msg: string): void
  /** the find bar has nothing to do while the Layout Manager owns the canvas */
  blocked(): boolean
  /** open the notes pane (if closed) and hand back its textarea */
  showNotes(): HTMLTextAreaElement | null
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void }
const highlights = (): HighlightRegistry | null =>
  (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights ?? null
const HighlightCtor = (): (new (...r: Range[]) => unknown) | null =>
  (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight ?? null

export class FindBar {
  readonly el: HTMLElement
  private findInput: HTMLInputElement
  private replaceInput: HTMLInputElement
  private countEl: HTMLElement
  private caseBtn: HTMLButtonElement
  private wordBtn: HTMLButtonElement
  private replaceRow: HTMLElement
  private toggleBtn: HTMLButtonElement
  private matchCase = false
  private wholeWord = false
  private matches: FindMatch[] = []
  private index = -1
  /** our own commit is running — the 'doc' listener must not re-search */
  private applying = false
  /** The bar changed the deck since the user last typed in it: ⌘Z / ⇧⌘Z
   *  in the bar then mean the deck, not the field. */
  private deckUndo = false
  private refreshTimer = 0

  constructor(private store: Store, private canvas: SlideCanvas, private host: HTMLElement, private h: FindBarHost) {
    const el = document.createElement('div')
    el.className = 'ed-findbar'
    el.setAttribute('role', 'search')
    el.setAttribute('aria-label', t('Find and replace'))
    el.hidden = true
    this.el = el

    const button = (cls: string, html: string, title: string, onClick: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `ed-findbar-btn ${cls}`
      b.innerHTML = html
      b.title = title
      b.setAttribute('aria-label', title)
      // mousedown default would steal focus from the find field
      b.addEventListener('mousedown', (ev) => ev.preventDefault())
      b.addEventListener('click', onClick)
      return b
    }

    const row1 = document.createElement('div')
    row1.className = 'ed-findbar-row'
    this.toggleBtn = button('ed-findbar-toggle', ICON.chevron, t('Show replace'), () => this.setReplaceVisible(this.replaceRow.hidden))
    this.findInput = document.createElement('input')
    this.findInput.type = 'text'
    this.findInput.className = 'ed-findbar-input'
    this.findInput.placeholder = t('Find')
    this.findInput.spellcheck = false
    this.findInput.setAttribute('aria-label', t('Find'))
    this.countEl = document.createElement('span')
    this.countEl.className = 'ed-findbar-count'
    this.countEl.setAttribute('aria-live', 'polite')
    this.caseBtn = button('ed-findbar-opt', '<span>Aa</span>', t('Match case'), () => {
      this.matchCase = !this.matchCase
      this.caseBtn.setAttribute('aria-pressed', String(this.matchCase))
      this.search(true)
    })
    this.wordBtn = button('ed-findbar-opt', '<span class="ed-findbar-word">ab</span>', t('Whole words'), () => {
      this.wholeWord = !this.wholeWord
      this.wordBtn.setAttribute('aria-pressed', String(this.wholeWord))
      this.search(true)
    })
    this.caseBtn.setAttribute('aria-pressed', 'false')
    this.wordBtn.setAttribute('aria-pressed', 'false')
    const prev = button('', ICON.up, t('Previous match'), () => this.step(-1))
    const next = button('', ICON.down, t('Next match'), () => this.step(1))
    const close = button('', ICON.close, t('Close'), () => this.close())
    row1.append(this.toggleBtn, this.findInput, this.countEl, this.caseBtn, this.wordBtn, prev, next, close)

    this.replaceRow = document.createElement('div')
    this.replaceRow.className = 'ed-findbar-row ed-findbar-replace'
    this.replaceRow.hidden = true
    const spacer = document.createElement('span')
    spacer.className = 'ed-findbar-spacer'
    this.replaceInput = document.createElement('input')
    this.replaceInput.type = 'text'
    this.replaceInput.className = 'ed-findbar-input'
    this.replaceInput.placeholder = t('Replace with')
    this.replaceInput.spellcheck = false
    this.replaceInput.setAttribute('aria-label', t('Replace with'))
    // its own key: the desktop replace-file dialog's "Replace" is another word in some languages
    const one = button('ed-findbar-text', tc('Replace', 'find bar'), t('Replace this match'), () => this.replaceCurrent())
    const all = button('ed-findbar-text', t('Replace all'), t('Replace every match in the deck (one undo step)'), () => this.replaceEvery())
    this.replaceRow.append(spacer, this.replaceInput, one, all)

    el.append(row1, this.replaceRow)
    host.appendChild(el)

    this.findInput.addEventListener('input', () => { this.deckUndo = false; this.search(true) })
    this.replaceInput.addEventListener('input', () => { this.deckUndo = false })
    const keys = (ev: KeyboardEvent, inReplace: boolean) => {
      // the bar's own keys. The editor's keydown ignores text fields, so
      // only document-wide chords (⌘S, ⌘F…) reach it from here — and undo
      // would be the INPUT's own undo, which is why ⌘Z is taken here.
      const mod = ev.metaKey || ev.ctrlKey
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.close(); return }
      // ⌘Z / ⇧⌘Z / Ctrl+Y undo and redo the DECK once the bar has changed it
      // (after "Replace all" focus stays in the replace field, and its typed
      // text is not what ⌘Z means). Typing in the bar hands undo back to the
      // field, so a mistyped query is undone where it was typed.
      const k = ev.key.toLowerCase()
      if (this.deckUndo && mod && !ev.altKey && (k === 'z' || (k === 'y' && !ev.shiftKey))) {
        ev.preventDefault(); ev.stopPropagation()
        this.undoDeck(k === 'y' || ev.shiftKey)
        return
      }
      if (ev.key === 'Enter' && !ev.isComposing) {
        ev.preventDefault()
        if (inReplace) { if (mod) this.replaceEvery(); else this.replaceCurrent() }
        else this.step(ev.shiftKey ? -1 : 1)
        return
      }
      // ⌘G / ⇧⌘G and F3 / ⇧F3: next / previous (⌘G is the grid elsewhere)
      if ((mod && ev.key.toLowerCase() === 'g') || ev.key === 'F3') {
        ev.preventDefault(); ev.stopPropagation()
        this.step(ev.shiftKey ? -1 : 1)
      }
    }
    this.findInput.addEventListener('keydown', (ev) => keys(ev, false))
    this.replaceInput.addEventListener('keydown', (ev) => keys(ev, true))

    // the deck changed under us (typing, undo, another replace): re-search,
    // keep the place. Debounced — a notes burst fires per keystroke.
    const refresh = () => {
      if (this.el.hidden || this.applying) return
      clearTimeout(this.refreshTimer)
      this.refreshTimer = window.setTimeout(() => this.search(false), 120)
    }
    store.on('doc', refresh)
    store.on('slides', refresh)
    // the canvas repaints on these — the highlight ranges died with its nodes
    const repaint = () => { if (!this.el.hidden) this.paintSoon() }
    store.on('current', repaint)
    store.on('selection', repaint)
  }

  get isOpen(): boolean { return !this.el.hidden }

  /** Undo / redo the deck from inside the bar, then search again at once
   *  (the 'doc' listener would, but debounced). */
  private undoDeck(redo: boolean) {
    if (this.h.blocked()) return
    this.canvas.commitTextEdit()
    if (redo) this.store.redo()
    else this.store.undo()
    clearTimeout(this.refreshTimer)
    this.search(false)
  }

  /** Open (or re-focus) the bar. `seed` replaces the query — the text that
   *  was selected when ⌘F was pressed. */
  open(withReplace: boolean, seed?: string) {
    if (this.h.blocked()) return
    const wasOpen = this.isOpen
    this.el.hidden = false
    if (withReplace) this.setReplaceVisible(true)
    if (seed && !seed.includes('\n')) this.findInput.value = seed
    const field = withReplace && this.findInput.value ? this.replaceInput : this.findInput
    field.focus()
    field.select()
    if (!wasOpen || seed) this.search(true)
    else this.paintSoon()
  }

  close() {
    if (this.el.hidden) return
    this.el.hidden = true
    clearTimeout(this.refreshTimer)
    this.clearPaint()
    const a = document.activeElement
    if (a instanceof HTMLElement && this.el.contains(a)) a.blur()
  }

  private setReplaceVisible(on: boolean) {
    this.replaceRow.hidden = !on
    this.toggleBtn.classList.toggle('is-open', on)
    this.toggleBtn.setAttribute('aria-expanded', String(on))
    const label = on ? t('Hide replace') : t('Show replace')
    this.toggleBtn.title = label
    this.toggleBtn.setAttribute('aria-label', label)
  }

  private options(): FindOptions {
    const doc = this.store.doc
    const inherited = new Map<string, Set<string>>()
    return {
      matchCase: this.matchCase,
      wholeWord: this.wholeWord,
      // a linked slide's inherited chrome belongs to its slide type: the next
      // resync would undo an edit made on the slide (canvas.ts lockedIds)
      skip: (slide: Slide, el: SlideElement) => {
        if (!slide.layoutId) return false
        let ids = inherited.get(slide.id)
        if (!ids) {
          const layout = doc.layouts?.find((l) => l.id === slide.layoutId)
          ids = layout ? ancestorElementIds(doc, layout) : new Set()
          inherited.set(slide.id, ids)
        }
        return ids.has(el.id)
      },
    }
  }

  /** Re-run the search. `jump` = a NEW query/option: go to the first match
   *  from the current slide on. Otherwise keep the current match's place. */
  private search(jump: boolean) {
    const prev = this.matches[this.index]
    const prevIndex = this.index
    this.matches = findMatches(this.store.doc, this.findInput.value, this.options())
    if (!this.matches.length) this.index = -1
    else if (jump) {
      const from = this.matches.findIndex((m) => m.slideIndex >= this.store.currentIndex)
      this.index = from < 0 ? 0 : from
    } else {
      const same = prev ? this.matches.findIndex((m) => sameMatch(m, prev)) : -1
      this.index = same >= 0 ? same : Math.min(Math.max(prevIndex, 0), this.matches.length - 1)
    }
    this.updateCount()
    if (jump && this.index >= 0) this.reveal()
    else this.paintSoon()
  }

  private step(dir: 1 | -1) {
    if (!this.findInput.value) { this.findInput.focus(); return }
    if (!this.matches.length) { this.search(true); return }
    this.index = (this.index + dir + this.matches.length) % this.matches.length
    this.updateCount()
    this.reveal()
  }

  private updateCount() {
    const n = this.matches.length
    const m = this.matches[this.index]
    this.el.classList.toggle('ed-findbar-none', !!this.findInput.value && n === 0)
    if (!this.findInput.value) this.countEl.textContent = ''
    else if (!n) this.countEl.textContent = t('No results')
    else {
      this.countEl.textContent = t('{i} of {n}', { i: String(this.index + 1), n: String(n) })
      this.countEl.title = m?.ref.kind === 'notes' ? t('In the speaker notes') : ''
    }
  }

  /** Select the current match's slide + element and paint it. */
  private reveal() {
    const m = this.matches[this.index]
    if (!m || this.h.blocked()) return
    this.canvas.commitTextEdit()
    if (m.slideIndex !== this.store.currentIndex) this.store.goTo(m.slideIndex)
    if (m.ref.kind === 'notes') {
      if (this.store.selection.length) this.store.select([])
      const ta = this.h.showNotes()
      if (ta) {
        // a textarea paints its selection only while focused, so this mainly
        // scrolls it into view; the counter's tooltip says where it is
        // notes are plain text: unit indices ARE string offsets
        const [a, b] = [m.g0, m.g1]
        ta.setSelectionRange(a, b)
        const lines = ta.value.slice(0, a).split('\n').length - 1
        ta.scrollTop = Math.max(0, lines * 18 - ta.clientHeight / 2)
      }
    } else if (this.store.selection.length !== 1 || this.store.selection[0] !== m.ref.elId) {
      this.store.select([m.ref.elId])
    }
    this.paintSoon()
  }

  private replaceCurrent() {
    if (!this.writable()) return
    const m = this.matches[this.index]
    if (!m) { this.search(true); return }
    // first press on a match that isn't on screen: show it, don't write yet
    if (m.slideIndex !== this.store.currentIndex) { this.reveal(); return }
    this.canvas.commitTextEdit()
    const query = this.findInput.value
    // checked BEFORE the commit — store.commit records an undo step whatever
    // the mutation does, so a refused (stale) or no-op replace must not run one
    const plan = planReplaceMatch(this.store.doc, m, query, this.replaceInput.value, this.options())
    if (!plan) { this.search(false); return }
    if (plan.changed) {
      this.applying = true
      try { this.store.commit(() => plan.apply()) } finally { this.applying = false }
      this.deckUndo = true
    }
    // the replacement may itself contain the query — then step past it
    const at = this.index
    this.matches = findMatches(this.store.doc, query, this.options())
    const again = this.matches.findIndex((x) => x.slideId === m.slideId && fieldKey(x.ref) === fieldKey(m.ref) && x.g0 === m.g0)
    this.index = !this.matches.length ? -1 : again >= 0 ? (again + 1) % this.matches.length : at % this.matches.length
    this.updateCount()
    if (this.index >= 0) this.reveal()
    else this.paintSoon()
  }

  private replaceEvery() {
    if (!this.writable()) return
    const query = this.findInput.value
    if (!query) return
    this.canvas.commitTextEdit()
    if (!findMatches(this.store.doc, query, this.options()).length) { this.h.toast(t('No results')); return }
    let n = 0
    this.applying = true
    try {
      this.store.commit(() => { n = replaceAll(this.store.doc, query, this.replaceInput.value, this.options()) })
    } finally { this.applying = false }
    if (n > 0) this.deckUndo = true
    this.search(false)
    this.h.toast(n === 1 ? t('Replaced 1 match') : t('Replaced {n} matches', { n: String(n) }))
  }

  private writable(): boolean {
    if (this.store.readOnly) { this.h.toast(t('This deck is read-only.')); return false }
    return !refuseGatedWrite((msg) => this.h.toast(msg))
  }

  // ---- highlighting -----------------------------------------------------------

  private paintSoon() {
    // after the canvas has re-rendered off the same event
    window.setTimeout(() => this.paint(), 0)
  }

  private clearPaint() {
    const reg = highlights()
    reg?.delete(HL_ALL)
    reg?.delete(HL_CUR)
  }

  private paint() {
    const reg = highlights()
    const H = HighlightCtor()
    if (!reg || !H) return
    this.clearPaint()
    if (this.el.hidden || !this.findInput.value) return
    const slide = this.store.doc.slides[this.store.currentIndex]
    if (!slide || this.store.editingSurface) return
    const stage = this.host.querySelector('.ed-stage-scale')
    if (!stage) return
    const cur = this.matches[this.index]
    const all: Range[] = []
    let current: Range | null = null
    // the MODEL's matches, mapped onto each field's rendered text — never a
    // second search over the DOM, so the marks are exactly what the counter counts
    const byField = new Map<string, FindMatch[]>()
    for (const m of this.matches) {
      if (m.slideId !== slide.id || m.ref.kind === 'notes' || m.ref.kind === 'chart' || m.ref.kind === 'code' ||
        m.ref.kind === 'math') continue
      const key = fieldKey(m.ref)
      const list = byField.get(key)
      if (list) list.push(m)
      else byField.set(key, [m])
    }
    for (const ms of byField.values()) {
      const ref = ms[0].ref
      if (ref.kind === 'notes') continue
      const node = stage.querySelector(`[data-el-id="${CSS.escape(ref.elId)}"]`)
      const root = ref.kind === 'cell'
        ? node?.querySelector(`td[data-r="${ref.row}"][data-c="${ref.col}"] .slidomingo-cell-inner`)
        : node?.querySelector('.slidomingo-text-inner')
      const src = fieldSource(this.store.doc, ms[0])
      if (!root || !src) continue
      const dom = renderedText(root)
      renderedSpans(src.value, src.html, dom.text, ms.map((m) => [m.g0, m.g1])).forEach((span, i) => {
        const r = span && dom.range(span[0], span[1])
        if (!r) return
        all.push(r)
        if (cur && sameMatch(cur, ms[i])) current = r
      })
    }
    if (all.length) reg.set(HL_ALL, new H(...all))
    if (current) reg.set(HL_CUR, new H(current))
  }
}

function sameField(a: FindMatch, b: FindMatch): boolean {
  return a.slideId === b.slideId && fieldKey(a.ref) === fieldKey(b.ref)
}
function sameMatch(a: FindMatch, b: FindMatch): boolean {
  return sameField(a, b) && a.g0 === b.g0 && a.g1 === b.g1
}

/** The rendered text of one field — its text nodes in order, field chips
 *  (resolved {{page}} values, which the model's units skip) left out — and a
 *  way back from offsets in it to a DOM Range. */
function renderedText(root: Element): { text: string; range(a: number, b: number): Range | null } {
  const nodes: Array<{ node: Text; start: number }> = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.sl-field') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length })
    text += (n as Text).data
  }
  // the node holding offset `o`: a start belongs to the node it begins, an end to the one it closes
  const locate = (o: number, end: boolean) => {
    for (const x of nodes) {
      const len = x.node.data.length
      if (end ? o > x.start && o <= x.start + len : o >= x.start && o < x.start + len) return { node: x.node, offset: o - x.start }
    }
    return null
  }
  return {
    text,
    range(a, b) {
      const s = locate(a, false), e = locate(b, true)
      if (!s || !e) return null
      const r = document.createRange()
      r.setStart(s.node, s.offset)
      r.setEnd(e.node, e.offset)
      return r
    },
  }
}
