// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The Grid & Snap panel (View ▸ Grid & Snap…, the ribbon's Grid ▾, the web
// View menu). One place answers "what do I see, and what do things snap to":
//
//   a Show × Snap matrix over every target (grid, layout columns, guides,
//   margins, other objects, the slide itself), then the details of the three
//   things you define — grid spacing (any value, any unit, with the steps
//   that fit the page exactly), the deck's column grid and its guides.
//
// The matrix and the grid are VIEWER preferences (gridpref.ts); the column
// grid and guides are DOCUMENT data (src/layoutgrid.ts), each change one undo
// step. DECISIONS 2026-10-13 ("Grid & Snap").

import type { Store } from '../store'
import { t } from '../i18n'
import { ICONS } from '../icons'
import { positionAtRect } from './floatingposition'
import { defaultLayoutGrid, normalizeGuides, normalizeLayoutGrid, MAX_TRACKS, type LayoutGrid } from '../layoutgrid'
import {
  FIGURE_GRID_STEPS_MM, LENGTH_UNITS, fittingSteps, formatLength, fromUnit, gridOnKey, loadGridPref, saveGridPref, toUnit,
  type GridPref, type LengthUnit, type SnapTargets,
} from './gridpref'
import { isMacOS } from '../screens'

export interface GridSnapHost {
  store: Store
  isFigure: boolean
  safeZoneShown(): boolean
  toggleSafeZone(): void
  /** re-apply the saved preference to the canvas and every control showing it */
  applyPref(): void
  /** the selection's box in slide px, or null */
  selectionBox(): { x: number; y: number; w: number; h: number } | null
  addGuides(xs: number[], ys: number[]): void
}

/** The unit lengths are shown in: a figure's own unit, else the preference. */
export function displayUnit(store: Store, pref: GridPref): LengthUnit {
  return store.doc.kind === 'figure' ? (store.doc.figure?.unit ?? 'mm') : pref.unit
}

/** Fired by the editor after it re-applies the preference (⌘G, menus, this panel). */
export const GRID_PREF_EVENT = 'slidomingo:grid-pref-applied'

let current: { close: () => void; anchor: Element | null } | null = null

/** Open the panel under `anchor` (a control, or a client rect for menu
 *  commands); a second call from the same control closes it. */
export function openGridSnapPanel(anchor: HTMLElement | DOMRect, host: GridSnapHost): void {
  if (current) {
    const same = anchor instanceof Element && current.anchor === anchor
    current.close()
    if (same) return
  }
  const pop = document.createElement('div')
  pop.className = 'ed-gs-pop'
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', t('Grid & Snap'))
  const { store } = host

  const setPref = (patch: Partial<GridPref>) => {
    saveGridPref({ ...loadGridPref(), ...patch })
    host.applyPref() // → GRID_PREF_EVENT → render()
  }
  const setSnap = (k: keyof SnapTargets, v: boolean) => setPref({ snap: { ...loadGridPref().snap, [k]: v } })
  const commit = (fn: () => void) => store.commit(fn) // the 'doc' listener re-renders

  const render = () => {
    const pref = loadGridPref()
    const unit = displayUnit(store, pref)
    const doc = store.doc
    const grid = normalizeLayoutGrid(doc.layoutGrid, doc.size)
    const guides = normalizeGuides(doc.guides, doc.size)
    const nGuides = guides.x.length + guides.y.length
    const stepPx = host.isFigure ? fromUnit(pref.figureStepMm, 'mm') : pref.slideStepPx
    const icon = doc.kind === 'iconset' ? doc.iconset : undefined
    const iconGrid = !!icon
    const onKey = gridOnKey(iconGrid)
    pop.replaceChildren()

    // --- head -------------------------------------------------------------
    const head = el('div', 'ed-gs-head')
    const title = el('div', 'ed-gs-title', t('Grid & Snap'))
    head.appendChild(title)
    if (!host.isFigure) {
      const us = document.createElement('select')
      us.className = 'ed-gs-unit'
      us.title = t('Units for the lengths below')
      us.setAttribute('aria-label', t('Units for the lengths below'))
      for (const u of LENGTH_UNITS) us.appendChild(new Option(u, u, false, u === unit))
      us.addEventListener('change', () => setPref({ unit: us.value as LengthUnit }))
      head.appendChild(us)
    }
    pop.appendChild(head)

    // --- the Show × Snap matrix ------------------------------------------
    const m = el('div', 'ed-gs-matrix')
    m.append(el('span'), el('span'), el('span', 'ed-gs-colhead', t('Show')), el('span', 'ed-gs-colhead', t('Snap')))
    const row = (
      icon: string, label: string, detail: string,
      show: { on: boolean; set: (v: boolean) => void; disabled?: boolean } | null,
      snap: { on: boolean; set: (v: boolean) => void; disabled?: boolean; why?: string },
    ) => {
      const ic = el('span', 'ed-gs-icon')
      ic.innerHTML = icon
      const lab = el('span', 'ed-gs-label')
      lab.append(el('span', 'ed-gs-name', label), el('span', 'ed-gs-detail', detail))
      m.append(ic, lab)
      m.append(show ? check(show.on, show.set, t('Show {what}', { what: label }), show.disabled) : el('span', 'ed-gs-na', '—'))
      const sc = check(snap.on, snap.set, t('Snap to {what}', { what: label }), snap.disabled)
      if (snap.why) sc.title = snap.why
      m.append(sc)
    }
    const hiddenWhy = t('Things snap only while they are shown')
    const gridOn = pref[onKey]
    row(ICONS.grid, t('Grid'), !gridOn ? t('Off') : icon ? t('{n} × {m} cells', { n: icon.grid, m: icon.gridH ?? icon.grid }) : formatLength(stepPx, unit),
      { on: gridOn, set: (v) => setPref({ [onKey]: v }) },
      { on: pref.snap.grid, set: (v) => setSnap('grid', v), disabled: !gridOn, why: !gridOn ? hiddenWhy : undefined })
    if (!iconGrid) row(ICONS.layoutColumns, t('Columns'), grid ? columnsLabel(grid) : t('None yet'),
      { on: pref.showLayout && !!grid, set: (v) => setPref({ showLayout: v }), disabled: !grid },
      { on: pref.snap.layout, set: (v) => setSnap('layout', v), disabled: !grid || !pref.showLayout, why: grid && !pref.showLayout ? hiddenWhy : undefined })
    row(ICONS.guides, t('Guides'), nGuides ? String(nGuides) : t('None yet'),
      { on: pref.showGuides, set: (v) => setPref({ showGuides: v }) },
      { on: pref.snap.guides, set: (v) => setSnap('guides', v), disabled: !pref.showGuides, why: !pref.showGuides ? hiddenWhy : undefined })
    row(ICONS.ruler, t('Margins'), t('Snap even when hidden'),
      { on: host.safeZoneShown(), set: () => { host.toggleSafeZone(); render() } },
      { on: pref.snap.margins, set: (v) => setSnap('margins', v), why: t('The template’s borders: the safe zone at the sides and the column grid’s outer margins') })
    row(ICONS.objects, t('Objects'), t('Edges, centers, equal gaps'), null,
      { on: pref.snap.objects, set: (v) => setSnap('objects', v) })
    row(ICONS.centerSlide, host.isFigure || iconGrid ? t('Canvas') : t('Slide'), t('Edges and center'), null,
      { on: pref.snap.slide, set: (v) => setSnap('slide', v) })
    pop.appendChild(m)

    // an icon set's grid is its units, and it has no columns: neither section applies
    let gs: HTMLElement | null = null
    if (!iconGrid) {
      // --- grid spacing -----------------------------------------------------
      gs = section(t('Grid spacing'))
      const spacing = el('div', 'ed-gs-line')
      spacing.appendChild(lengthInput(stepPx, unit, (px) => {
        if (!(px > 0.5)) return render()
        setPref(host.isFigure ? { on: true, figureStepMm: round(toUnit(px, 'mm'), 3) } : { on: true, slideStepPx: round(px, 3) })
      }, t('Grid spacing')))
      gs.appendChild(spacing)
      const presets = host.isFigure ? FIGURE_GRID_STEPS_MM.map((mm) => fromUnit(mm, 'mm')) : fittingSteps(doc.size)
      const chips = el('div', 'ed-gs-chips')
      if (!host.isFigure) chips.appendChild(el('span', 'ed-gs-hint', t('Fit the slide exactly:')))
      for (const px of presets) {
        const on = pref.on && Math.abs(px - stepPx) < 0.01
        const c = chip(host.isFigure ? `${round(toUnit(px, 'mm'), 2)} mm` : formatLength(px, unit), on, () =>
          setPref(host.isFigure ? { on: true, figureStepMm: round(toUnit(px, 'mm'), 3) } : { on: true, slideStepPx: px }))
        if (!host.isFigure) c.title = t('{n} × {m} cells', { n: Math.round(doc.size.width / px), m: Math.round(doc.size.height / px) })
        chips.appendChild(c)
      }
      gs.appendChild(chips)
      pop.appendChild(gs)

      // --- layout columns (document) -----------------------------------------
      const ls = section(t('Columns'), t('Saved with the deck — every slide and slide type shares them, and AI agents place content by them.'))
      if (!grid) {
        const add = el('div', 'ed-gs-chips')
        add.appendChild(el('span', 'ed-gs-hint', t('Add a column grid:')))
        for (const n of [2, 3, 4, 6, 12]) {
          add.appendChild(chip(String(n), false, () => {
            if (!loadGridPref().showLayout) setPref({ showLayout: true })
            commit(() => { store.doc.layoutGrid = { ...defaultLayoutGrid(doc.size), columns: n } })
          }, t('{n} columns', { n })))
        }
        ls.appendChild(add)
      } else {
        const set = (patch: Partial<LayoutGrid>) => commit(() => {
          const g = normalizeLayoutGrid(store.doc.layoutGrid, store.doc.size)
          if (g) store.doc.layoutGrid = { ...g, ...patch }
        })
        const form = el('div', 'ed-gs-form')
        form.append(
          field(t('Columns'), countInput(grid.columns, 1, (n) => set({ columns: n }))),
          field(t('Rows'), countInput(grid.rows ?? 0, 0, (n) => set({ rows: n }))),
          field(t('Gutter'), lengthInput(grid.gutter, unit, (px) => set({ gutter: Math.max(0, px) }), t('Gutter'))),
          field(t('Side margins'), lengthInput(grid.marginX, unit, (px) => set({ marginX: Math.max(0, px) }), t('Side margins'))),
          field(t('Top & bottom'), lengthInput(grid.marginY, unit, (px) => set({ marginY: Math.max(0, px) }), t('Top & bottom'))),
        )
        ls.appendChild(form)
        const acts = el('div', 'ed-gs-actions')
        acts.appendChild(button(t('Remove columns'), () => commit(() => { delete store.doc.layoutGrid })))
        ls.appendChild(acts)
      }
      pop.appendChild(ls)
    }

    // --- guides (document) ---------------------------------------------------
    const gd = section(t('Guides'), t('Drag one out from the top or left edge of the slide. Drag a guide off the slide to remove it.'))
    const gacts = el('div', 'ed-gs-actions')
    const freeSpot = (list: number[], mid: number, max: number) => {
      let v = Math.round(mid)
      while (list.some((x) => Math.abs(x - v) < 1) && v < max) v += 40
      return v
    }
    gacts.append(
      button(t('Vertical'), () => host.addGuides([freeSpot(guides.x, doc.size.width / 2, doc.size.width)], []), t('Add a vertical guide'), ICONS.plus),
      button(t('Horizontal'), () => host.addGuides([], [freeSpot(guides.y, doc.size.height / 2, doc.size.height)]), t('Add a horizontal guide'), ICONS.plus),
    )
    const box = host.selectionBox()
    const fromSel = button(t('Around selection'), () => {
      const b = host.selectionBox()
      if (b) host.addGuides([b.x, b.x + b.w], [b.y, b.y + b.h])
    }, t('Add guides along the edges of what is selected'))
    if (!box) (fromSel as HTMLButtonElement).disabled = true
    gacts.appendChild(fromSel)
    if (nGuides) gacts.appendChild(button(t('Clear'), () => commit(() => { delete store.doc.guides }), t('Remove every guide')))
    gd.appendChild(gacts)
    pop.appendChild(gd)

    // --- footer -----------------------------------------------------------------
    const mac = isMacOS()
    pop.appendChild(el('div', 'ed-gs-foot', t('Hold {key} while dragging to place freely · {grid} shows or hides the grid', {
      key: mac ? '⌥' : 'Alt', grid: mac ? '⌘G' : 'Ctrl+G',
    })))
    if (store.readOnly) pop.querySelectorAll<HTMLElement>('.ed-gs-sec input, .ed-gs-sec button').forEach((n) => {
      if (n.closest('.ed-gs-sec') !== gs) (n as HTMLInputElement).disabled = true
    })
  }

  render()
  document.body.appendChild(pop)
  const place = () => {
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor
    positionAtRect(r, pop, { placement: 'bottom', align: 'start', gap: 6, margin: 8 })
  }
  place()

  const offDoc = store.on('doc', () => { render() })
  const onPref = () => render()
  document.addEventListener(GRID_PREF_EVENT, onPref)
  const outside = (ev: PointerEvent) => {
    const target = ev.target as Node
    if (pop.contains(target)) return
    if (anchor instanceof Element && anchor.contains(target)) return // the trigger's own click toggles
    close()
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); close() }
  }
  const close = () => {
    offDoc()
    document.removeEventListener(GRID_PREF_EVENT, onPref)
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', place)
    pop.remove()
    current = null
  }
  setTimeout(() => document.addEventListener('pointerdown', outside, true))
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', place)
  current = { close, anchor: anchor instanceof Element ? anchor : null }
}

function columnsLabel(g: LayoutGrid): string {
  return g.rows ? t('{c} × {r}', { c: g.columns, r: g.rows }) : t('{n} columns', { n: g.columns })
}

// --- small builders ----------------------------------------------------------

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function section(title: string, hint?: string): HTMLElement {
  const s = el('div', 'ed-gs-sec')
  s.appendChild(el('div', 'ed-gs-sectitle', title))
  if (hint) s.appendChild(el('div', 'ed-gs-hint', hint))
  return s
}

function check(on: boolean, set: (v: boolean) => void, label: string, disabled?: boolean): HTMLElement {
  const wrap = el('label', 'ed-gs-check')
  const i = document.createElement('input')
  i.type = 'checkbox'
  i.checked = on && !disabled
  i.disabled = !!disabled
  i.setAttribute('aria-label', label)
  i.addEventListener('change', () => set(i.checked))
  wrap.appendChild(i)
  return wrap
}

function chip(label: string, on: boolean, run: () => void, title?: string): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = on ? 'ed-gs-chip on' : 'ed-gs-chip'
  b.textContent = label
  if (title) b.title = title
  b.addEventListener('click', run)
  return b
}

function button(label: string, run: () => void, title?: string, icon?: string): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-btn ed-gs-btn'
  if (icon) b.innerHTML = icon
  b.appendChild(el('span', undefined, label))
  if (title) b.title = title
  b.addEventListener('click', run)
  return b
}

function field(label: string, control: HTMLElement): HTMLElement {
  const f = el('label', 'ed-gs-field')
  f.append(el('span', 'ed-gs-fieldlabel', label), control)
  return f
}

const STEP: Record<LengthUnit, number> = { px: 1, pt: 1, mm: 0.5, cm: 0.05, in: 0.01 }

/** A number field in `unit` holding a px length; commits on change/Enter. */
function lengthInput(px: number, unit: LengthUnit, commit: (px: number) => void, label: string): HTMLElement {
  const wrap = el('span', 'ed-gs-len')
  const i = document.createElement('input')
  i.type = 'number'
  i.min = '0'
  i.step = String(STEP[unit])
  i.value = String(round(toUnit(px, unit), unit === 'px' || unit === 'pt' ? 1 : unit === 'mm' ? 2 : 3))
  i.setAttribute('aria-label', label)
  i.addEventListener('change', () => {
    const v = parseFloat(i.value)
    if (Number.isFinite(v)) commit(fromUnit(v, unit))
  })
  wrap.append(i, el('span', 'ed-gs-suffix', unit))
  return wrap
}

function countInput(n: number, min: number, commit: (n: number) => void): HTMLElement {
  const i = document.createElement('input')
  i.type = 'number'
  i.min = String(min)
  i.max = String(MAX_TRACKS)
  i.step = '1'
  i.value = String(n)
  i.className = 'ed-gs-count'
  i.addEventListener('change', () => {
    const v = Math.round(parseFloat(i.value))
    if (Number.isFinite(v)) commit(Math.min(MAX_TRACKS, Math.max(min, v)))
  })
  return i
}

function round(v: number, digits: number): number {
  const k = 10 ** digits
  return Math.round(v * k) / k
}
