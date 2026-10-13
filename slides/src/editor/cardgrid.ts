// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Shared reorderable card grid (thumbnail, name input, delete-with-confirm,
// ‹/› move buttons with wrap-around, HTML5 drag-and-drop reorder) —
// parameterized by thumbnail rendering + rename/delete/move/star callbacks
// (the actual doc mutation) and a `dragGroup` tag (a drop tagged with a
// DIFFERENT group is rejected; `null` for one flat grid). Its one caller
// today is the Layout Manager's Objects grid
// (`renderObjectsGrid`); the Slide types tab moved to its own sidebar
// (typetree.ts) on 2026-09-23, since a tree that reparents on drop is a
// different shape from a flat reorderable grid. Same extraction
// idiom as `insertgroup.ts`'s `buildInsertGroup`/`applyto.ts`'s
// `buildApplyToDialog`: a plain builder function over `Store` + callbacks,
// no state of its own.
//
// Owns the `store.commit()` wrapping for every mutating callback itself, so
// callers pass the RAW mutation (e.g. `(ly) => removeLayout(doc, ly.id)`),
// not an already-`store.commit`-wrapped one — mirrors the doc comment on
// `model.ts`'s `create*` functions ("caller wraps in store.commit").

import type { Store } from '../store'
import { ICONS } from '../icons'
import { t } from '../i18n'

export interface CardGridStar<T> {
  isDefault: (item: T) => boolean
  /** Title shown when this card IS the default. */
  defaultTitle: string
  /** Title shown on the button that would MAKE it the default. */
  makeDefaultTitle: string
  /** Raw mutation — buildCardGrid wraps it in `store.commit`. */
  onToggle: (item: T) => void
}

export interface CardGridOptions<T> {
  store: Store
  items: T[]
  renderThumb: (item: T) => HTMLElement
  /** Omit for a grid with no default-item concept (Reusable Objects). */
  star?: CardGridStar<T>
  getName: (item: T) => string | undefined
  /** Fallback shown/stored when the name is empty — e.g. `t('Untitled')` vs.
   *  `t('Untitled object')`. */
  defaultName: string
  /** Raw mutation (the trimmed-or-default name is already computed). */
  onRename: (item: T, name: string) => void
  deleteTitle: string
  deleteConfirm: (item: T) => string
  /** Raw mutation — buildCardGrid wraps it in `store.commit`. */
  onDelete: (item: T) => void
  /** NOT wrapped in `store.commit` — opening a card is a nav-only change,
   *  same as before extraction (only `nav.editing*Id` + a re-render, never
   *  part of the undo stack). Caller is responsible for re-rendering. */
  onOpen: (item: T) => void
  /** Raw mutation — buildCardGrid wraps it in `store.commit`. */
  onMove: (from: number, to: number) => void
  /** Drag-and-drop origin tag for a grid shown as one of several groups;
   *  `null` for a single flat grid (Reusable Objects). A drop whose origin
   *  tag differs from this grid's tag is rejected. */
  dragGroup: string | null
  /** Called after any mutating action (delete/move/star-toggle) — NOT after
   *  rename, matching the pre-extraction behavior (renaming never
   *  re-rendered the pane; the input already shows what was typed). */
  onChange: () => void
}

export function buildCardGrid<T>(opts: CardGridOptions<T>): HTMLElement {
  const { store, items, renderThumb, star, getName, defaultName, onRename, deleteTitle, deleteConfirm, onDelete, onOpen, onMove, dragGroup, onChange } = opts
  const grid = div('ed-layoutmgr-grid')
  const n = items.length

  items.forEach((item, i) => {
    const card = div('ed-layoutmgr-card')
    card.draggable = true
    card.appendChild(renderThumb(item))

    if (star) {
      const starBtn = document.createElement('button')
      starBtn.className = 'ed-layoutmgr-star'
      const isDefault = star.isDefault(item)
      starBtn.textContent = isDefault ? '★' : '☆'
      starBtn.title = isDefault ? star.defaultTitle : star.makeDefaultTitle
      starBtn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        store.commit(() => star.onToggle(item))
        onChange()
      })
      card.appendChild(starBtn)
    }

    const nameIn = document.createElement('input')
    nameIn.type = 'text'
    nameIn.className = 'ed-layoutmgr-name'
    nameIn.value = getName(item) ?? defaultName
    nameIn.addEventListener('click', (ev) => ev.stopPropagation())
    nameIn.addEventListener('change', () => {
      store.commit(() => onRename(item, nameIn.value.trim() || defaultName))
    })
    card.appendChild(nameIn)

    const del = document.createElement('button')
    del.className = 'ed-layoutmgr-del'
    del.innerHTML = ICONS.trash
    del.title = deleteTitle
    del.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (!window.confirm(deleteConfirm(item))) return
      store.commit(() => onDelete(item))
      onChange()
    })
    card.appendChild(del)

    // Touch/no-drag fallback for reordering — the grid WRAPS (earliest
    // card's "earlier" lands it last, and vice versa), so ‹/› reads better
    // than up/down. Hidden with a single card: nothing to move relative to.
    if (n > 1) {
      const moveWrap = div('ed-layoutmgr-move')
      const earlier = document.createElement('button')
      earlier.type = 'button'
      earlier.className = 'ed-layoutmgr-move-btn'
      earlier.textContent = '‹'
      earlier.title = t('Move earlier')
      earlier.addEventListener('click', (ev) => {
        ev.stopPropagation()
        store.commit(() => onMove(i, ((i - 1) % n + n) % n))
        onChange()
      })
      const later = document.createElement('button')
      later.type = 'button'
      later.className = 'ed-layoutmgr-move-btn'
      later.textContent = '›'
      later.title = t('Move later')
      later.addEventListener('click', (ev) => {
        ev.stopPropagation()
        store.commit(() => onMove(i, (i + 1) % n))
        onChange()
      })
      moveWrap.append(earlier, later)
      card.appendChild(moveWrap)
    }

    card.addEventListener('click', () => onOpen(item))

    // drag-to-reorder — plain HTML5 dnd. The payload carries the ORIGIN
    // dragGroup so a drop into a differently-tagged grid/subsection can
    // refuse it (see this file's header comment).
    card.addEventListener('dragstart', (ev) => {
      ev.dataTransfer!.setData('text/plain', JSON.stringify({ group: dragGroup, index: i }))
      card.classList.add('dragging')
    })
    card.addEventListener('dragend', () => card.classList.remove('dragging'))
    card.addEventListener('dragover', (ev) => ev.preventDefault())
    card.addEventListener('drop', (ev) => {
      ev.preventDefault()
      let payload: { group: string | null; index: number }
      try { payload = JSON.parse(ev.dataTransfer!.getData('text/plain')) }
      catch { return }
      if (payload.group !== dragGroup) return // forbid cross-group drop
      const from = payload.index
      if (typeof from !== 'number' || Number.isNaN(from) || from === i) return
      store.commit(() => onMove(from, from < i ? i - 1 : i))
      onChange()
    })

    grid.appendChild(card)
  })
  return grid
}

function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}
