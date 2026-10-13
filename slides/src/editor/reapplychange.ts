// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Reapply Change: arm the tool, click an element that was recently edited to
// capture that edit, then click any number of other elements of the SAME
// type (and shape sub-kind, if a shape) to apply it — Format Painter's
// stay-armed paintbrush idiom (formatpainter.ts), but replaying a REAL
// recorded change from actionlog.ts instead of an ad-hoc style bag. Click-
// capture mechanics (armed cursor, capture-phase hit test, Esc to disarm)
// live in canvas.ts beside formatpainter.ts's own block; this file owns only
// what a click DOES.
//
// The same computeReapplicablePatch/applyReapplicablePatch pair backs the
// apply_change_pattern agent verb (editor.ts) — a human using this tool and
// Claude Code calling that verb apply byte-identical patches for the same
// source change.

import type { Store } from '../store'
import type { SlideCanvas } from './canvas'
import type { ShapeElement, SlideElement } from '../model'
import { applyReapplicablePatch, computeReapplicablePatch } from '../actionlog'
import { t } from '../i18n'

function sameKind(target: SlideElement, source: SlideElement): boolean {
  if (target.type !== source.type) return false
  if (target.type === 'shape') return (target as ShapeElement).shape === (source as ShapeElement).shape
  return true
}

/** Same tiny toast idiom as panels.ts/editor.ts — duplicated rather than
 *  imported to avoid a cycle back into editor.ts (which instantiates this
 *  tool), mirroring notes-pane.ts's own standalone burst-edit helper. */
function toast(message: string) {
  document.querySelector('.ed-toast')?.remove()
  const el = document.createElement('div')
  el.className = 'ed-toast'
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.classList.add('show'))
  setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => el.remove(), 300)
  }, 2200)
}

export class ReapplyChangeTool {
  private captured: { source: SlideElement; patch: Partial<SlideElement> } | null = null

  /** notified when the tool arms/disarms (topbar button state) */
  onArmedChange: ((on: boolean) => void) | null = null

  constructor(
    private store: Store,
    private canvas: SlideCanvas,
  ) {
    this.canvas.onReapplyChangeClick = (elId) => this.handleClick(elId)
    this.canvas.onReapplyChangeModeChange = (on) => {
      if (!on) this.captured = null
      this.onArmedChange?.(on)
    }
  }

  get isArmed() {
    return this.canvas.isReapplyChangeArmed
  }

  toggle() {
    if (this.canvas.isReapplyChangeArmed) this.canvas.disarmReapplyChange()
    else this.canvas.armReapplyChange()
  }

  private handleClick(elId: string) {
    if (!this.captured) {
      const change = this.store.actionLog.lastChangeFor(this.store.slide.id, elId)
      const patch = change ? computeReapplicablePatch(change) : null
      const source = change?.after ?? this.store.element(elId) ?? null
      if (!patch || !source) {
        toast(t('No recent change on that element to reapply'))
        return
      }
      this.captured = { source, patch }
      return
    }
    const { source, patch } = this.captured
    const target = this.store.element(elId)
    if (!target) return
    if (!sameKind(target, source)) {
      toast(t('That element doesn’t match — same element type needed'))
      return
    }
    this.store.commit(() => applyReapplicablePatch(patch, target))
  }
}
