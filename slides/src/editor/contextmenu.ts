// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Right-click canvas menu. No logic of its own — every item calls the same
// function the properties panel already uses (panels.ts) or a handful of
// callbacks the editor wires in (copy/cut/paste, whose real homes are
// editor.ts's keyboard/paste handlers). Positioning follows comments.ts's
// point-anchored popover: position:fixed, viewport-clamped, deferred
// outside-click dismiss.

import type { Store } from '../store'
import type { SlideElement } from '../model'
import type { PropsPanel } from './panels'
import type { SlideCanvas } from './canvas'
import { openSaveSelectionDialog } from './saveselection'
import { t } from '../i18n'
import { canFlip } from '../render'
import { TABLE_OPS } from './tablerange'
import { isZoomElement, zoomCover } from '../model'
import { ICONS } from '../icons'
import type { MenuCustomization } from './customize/apply'

export interface ContextMenuActions {
  copySelection(): void
  cutSelection(): void
  pasteFromClipboardAsync(): Promise<void>
  /** the Copy special popup at this point (copyspecialmenu.ts) */
  copySpecial(x: number, y: number): void
}

const TYPE_ICON: Record<string, string> = {
  text: 'T', shape: '◼', image: '🖼', svg: '◇', chart: '📊', table: '▦', code: '‹›', embed: '⧉', media: '▶',
  math: '∑',
  zoom: '⤢',
}

/** Short row label: first ~30 chars of text, else the type name. */
export function elementLabel(el: SlideElement): string {
  if (el.type === 'text') {
    const txt = el.html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    if (txt) return txt.length > 30 ? txt.slice(0, 30) + '…' : txt
  }
  if (el.type === 'math' && el.tex?.trim()) {
    const tex = el.tex.replace(/\s+/g, ' ').trim()
    return tex.length > 30 ? tex.slice(0, 30) + '…' : tex
  }
  const key = el.type === 'media' ? (el.kind === 'audio' ? 'Audio' : 'Video')
    : ({ text: 'Text', shape: 'Shape', image: 'Image', svg: 'Diagram', chart: 'Chart', table: 'Table', code: 'Code', embed: 'Embed', math: 'Equation', zoom: 'Zoom' } as Record<string, string>)[el.type]
  return t(key)
}

export class ContextMenu {
  constructor(
    private store: Store,
    private panel: PropsPanel,
    private canvas: SlideCanvas,
    private actions: ContextMenuActions,
    /** the UI profile's pins and hidden items (editor/customize/) */
    private custom: () => MenuCustomization | null = () => null,
  ) {}

  /** elId is the .beeslides-el hit (already selected by canvas.ts before this
   *  fires), or null for an empty-canvas right-click. */
  open(elId: string | null, clientX: number, clientY: number, stack: SlideElement[] = []) {
    document.querySelector('.ed-ctx-menu')?.remove()
    const menu = document.createElement('div')
    menu.className = 'ed-ctx-menu'

    // `id` = the catalog id a UI profile hides it by (customize/catalog.ts CONTEXT_ITEMS)
    const item = (label: string, onClick: () => void, enabled = true, id?: string) => {
      const b = document.createElement('button')
      b.className = 'ed-btn'
      b.textContent = label
      b.disabled = !enabled
      if (id) b.dataset.uiItem = id
      b.addEventListener('click', () => { close(); onClick() })
      menu.appendChild(b)
      return b
    }
    const sep = () => { const s = document.createElement('div'); s.className = 'ed-menu-sep'; menu.appendChild(s) }

    // Comments only ever surface for real doc.slides entries — comments.ts
    // has no editingSurface awareness, so one added while editing a master's
    // building blocks or a layout's own placeholders would land on
    // buildingBlocks.comments/layout.comments, which the sidebar/badge UI
    // never iterates. A silent dead end, so don't offer it there.
    const commentsAvailable = !this.store.editingSurface

    // "Select" block: every element under the pointer, top first — the way to
    // reach something buried, locked or hidden. Selects WITHOUT expanding
    // groups (like Alt-click) so a single group member is reachable.
    if (stack.length > 1 || stack.some((e) => e.locked || e.hidden)) {
      const cap = document.createElement('div')
      cap.className = 'ed-arrange-cap'
      cap.textContent = t('Select')
      menu.appendChild(cap)
      const list = document.createElement('div')
      list.className = 'ed-ctx-select'
      for (const el of stack) {
        const b = document.createElement('button')
        b.className = 'ed-btn'
        const ic = document.createElement('span')
        ic.textContent = TYPE_ICON[el.type] ?? '◼'
        const lb = document.createElement('span')
        lb.textContent = elementLabel(el)
        b.append(ic, lb)
        const badge = (el.locked ? '🔒' : '') + (el.hidden ? '🙈' : '')
        if (badge) {
          const bd = document.createElement('span')
          bd.className = 'ed-sel-badge'
          bd.textContent = badge
          b.appendChild(bd)
        }
        b.addEventListener('mouseenter', () => this.canvas.highlightElement(el.id))
        b.addEventListener('mouseleave', () => this.canvas.highlightElement(null))
        b.addEventListener('click', () => { close(); this.store.select([el.id]) })
        list.appendChild(b)
      }
      menu.appendChild(list)
      sep()
    }

    // the UI profile's own items for what was right-clicked, on top
    const custom = this.custom()
    if (custom) {
      const sel = elId ? this.store.selectedElements : []
      const scopes = !sel.length ? ['canvas']
        : ['*', ...(sel.length > 1 ? ['multi'] : []), ...(sel.every((e) => e.type === sel[0].type) ? [sel[0].type] : [])]
      const pins = custom.pins('context', scopes)
      for (const pin of pins) {
        const b = item(pin.label, () => pin.run())
        b.classList.add('ed-ctx-custom')
        if (pin.icon && pin.icon in ICONS) b.insertAdjacentHTML('afterbegin', ICONS[pin.icon as keyof typeof ICONS])
        if (pin.chord) {
          const k = document.createElement('span')
          k.className = 'ed-ctx-key'
          k.textContent = pin.chord
          b.appendChild(k)
        }
      }
      if (pins.length) sep()
    }

    if (!elId) {
      // Empty canvas: nothing to cut/copy/duplicate/delete/reorder.
      item(t('Paste'), () => void this.actions.pasteFromClipboardAsync(), true, 'paste')
      item(t('Copy special…'), () => this.actions.copySpecial(clientX, clientY), true, 'copy-special')
      const nHidden = this.store.slide.elements.filter((e) => e.hidden).length
      if (nHidden) {
        item(nHidden === 1 ? t('Show 1 hidden element') : t('Show {n} hidden elements', { n: nHidden }),
          () => this.panel.setHidden(this.store.slide.elements.filter((e) => e.hidden), false), true, 'show-hidden')
      }
      if (commentsAvailable) {
        sep()
        item(t('Add comment here'), () => this.canvas.addCommentAt(undefined, { x: clientX, y: clientY }), true, 'comment-here')
      }
    } else {
      const els = this.store.selectedElements
      item(t('Cut'), () => this.actions.cutSelection(), true, 'cut')
      item(t('Copy'), () => this.actions.copySelection(), true, 'copy')
      item(t('Paste'), () => void this.actions.pasteFromClipboardAsync(), true, 'paste')
      item(t('Copy special…'), () => this.actions.copySpecial(clientX, clientY), true, 'copy-special')
      sep()
      // a lone table: the cell commands, on the right-clicked cell (or the
      // selected range it lies in — canvas.pickCellAt)
      if (els.length === 1 && els[0].type === 'table') {
        const cells = this.canvas.tableRange
        for (const [op, label] of TABLE_OPS) {
          item(t(label), () => { cells.run(op) }, cells.can(op), 'table')
          if (op === 'split' || op === 'colRight') sep()
        }
        sep()
      }
      if (els.length === 1 && els[0].type === 'math') {
        const id = els[0].id
        item(t('Edit equation…'), () => document.dispatchEvent(new CustomEvent('slidomingo:edit-math', { detail: { id } })), true, 'edit-equation')
        sep()
      }
      // a lone diagram: the way out of opaque artwork and into editable objects
      if (els.length === 1 && els[0].type === 'svg') {
        const id = els[0].id
        item(t('Convert to objects'), () => this.panel.convertSvg(id), !els[0].locked, 'convert-svg')
        sep()
      }
      // a lone zoom tile: jump to what it zooms into
      if (els.length === 1 && isZoomElement(els[0])) {
        const cover = zoomCover(this.store.doc, els[0], this.store.slide.id)
        item(t('Go to target'), () => {
          const i = cover ? this.store.doc.slides.indexOf(cover) : -1
          if (i >= 0) this.store.goTo(i)
        }, !!cover, 'go-to-target')
        sep()
      }
      item(t('Duplicate'), () => this.panel.duplicate(els), true, 'duplicate')
      item(t('Delete'), () => this.panel.deleteEls(els), true, 'delete')
      sep()
      const allLocked = els.every((e) => e.locked)
      item(allLocked ? t('Unlock') : t('Lock'), () => this.panel.setLocked(els, !allLocked), true, 'lock')
      item(t('Hide'), () => this.panel.setHidden(els, true), true, 'hide')
      sep()
      // Unlike "Add Comment" below, this has no editingSurface gating —
      // doc.reusableObjects is a flat top-level array and the library is a
      // separate file, so saving works identically from an ordinary slide or
      // a slide-type sub-editor. The dialog asks which of the two.
      item(t('Save selection…'), () => void openSaveSelectionDialog(this.store, els), true, 'save-selection')
      sep()
      item(t('Bring to Front'), () => this.panel.reorder(els, 'front'), true, 'order')
      item(t('Bring Forward'), () => this.panel.step(els, +1), true, 'order')
      item(t('Send Backward'), () => this.panel.step(els, -1), true, 'order')
      item(t('Send to Back'), () => this.panel.reorder(els, 'back'), true, 'order')
      if (els.some(canFlip)) {
        sep()
        item(t('Flip Horizontal'), () => this.panel.flip(els, 'flipH'), true, 'flip')
        item(t('Flip Vertical'), () => this.panel.flip(els, 'flipV'), true, 'flip')
      }
      sep()
      const grouped = els.some((e) => e.groupId)
      const allSameGroup = els.length > 1 && els.every((e) => e.groupId && e.groupId === els[0].groupId)
      if (allSameGroup || (grouped && els.length === 1)) {
        item(t('Ungroup'), () => this.panel.ungroup(els), true, 'group')
      } else if (els.length > 1) {
        item(t('Group'), () => this.panel.group(els), true, 'group')
      }
      const alignSub = document.createElement('div')
      alignSub.className = 'ed-ctx-align'
      alignSub.dataset.uiItem = 'align'
      const alignBtn = (label: string, edge: Parameters<PropsPanel['align']>[1]) => {
        const b = document.createElement('button')
        b.className = 'ed-btn'
        b.textContent = label
        b.addEventListener('click', () => { close(); this.panel.align(els, edge) })
        alignSub.appendChild(b)
      }
      const alignCap = document.createElement('div')
      alignCap.className = 'ed-arrange-cap'
      alignCap.dataset.uiItem = 'align'
      alignCap.textContent = t('Align')
      menu.appendChild(alignCap)
      alignBtn('⇤ ' + t('Left'), 'left')
      alignBtn('⇹ ' + t('Center'), 'centerX')
      alignBtn('⇥ ' + t('Right'), 'right')
      alignBtn('⤒ ' + t('Top'), 'top')
      alignBtn('⇳ ' + t('Middle'), 'middleY')
      alignBtn('⤓ ' + t('Bottom'), 'bottom')
      menu.appendChild(alignSub)
      if (commentsAvailable) {
        sep()
        item(t('Add Comment'), () => this.canvas.addCommentAt(elId), true, 'comment')
      }
      // Only offered while the recorded change still matches this element's
      // LIVE state (store.canRevert) — a global undo or any other edit since
      // silently drops it, no separate invalidation bookkeeping needed.
      const change = this.store.actionLog.lastChangeFor(this.store.slide.id, elId)
      if (change && this.store.canRevert(change)) {
        sep()
        item(t('Revert last change'), () => this.panel.revertChange(change), true, 'revert')
      }
    }

    // the profile's hidden built-ins, then the separators they leave behind
    const hidden = custom?.hidden('context')
    if (hidden?.size) {
      for (const n of [...menu.querySelectorAll<HTMLElement>('[data-ui-item]')]) if (hidden.has(n.dataset.uiItem!)) n.remove()
      let prevSep = true
      for (const n of [...menu.children]) {
        const isSep = n.classList.contains('ed-menu-sep')
        if (isSep && prevSep) n.remove()
        else prevSep = isSep
      }
      while (menu.lastElementChild?.classList.contains('ed-menu-sep')) menu.lastElementChild.remove()
      if (!menu.children.length) return
    }

    document.body.appendChild(menu)
    // Viewport-clamped, same idiom as comments.ts's ed-comment-pop.
    const r = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - r.width - 4))}px`
    menu.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - r.height - 4))}px`

    const close = () => {
      this.canvas.highlightElement(null)
      menu.remove()
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('keydown', onKey, true)
    }
    const onOutside = (ev: PointerEvent) => { if (!menu.contains(ev.target as Node)) close() }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close() }
    // Deferred: the contextmenu event that opened this IS a pointerdown-family
    // event on some platforms, and would otherwise close the menu it just opened.
    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true)
      document.addEventListener('keydown', onKey, true)
    })
  }
}
