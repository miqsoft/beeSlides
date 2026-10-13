// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// propose_variants picker: an LLM proposes up to 6 candidate treatments of
// ONE slide (desktop/src/mcp/slides-mcp-server.mjs's propose_variants tool,
// dispatched by editor.ts's applyAgentAction into Editor.pendingVariants) and
// the human picks one, or discards the lot. Modeled directly on
// openLayoutPicker (editor.ts): a grid popover, positionFloating-anchored,
// appended to body then positioned, closed by an outside pointerdown.
//
// UNLIKE openLayoutPicker, closing this popover via outside-click does NOT
// discard anything — only Apply, Discard, or a later propose_variants call
// replacing the set clears Editor.pendingVariants. The topbar badge
// (editor.ts's variantBadge) persists after an outside-click close so the
// human can reopen the same set later.
//
// Candidates are NOT part of `store.doc` yet — Editor.pendingVariants lives
// outside it, never committed until Apply (editor.ts's applyVariant) — so
// thumbnails render against a THROWAWAY doc: a shallow copy of store.doc with
// the pending variant's assets merged in for preview only, built fresh here
// and never assigned back to store.doc.

import type { SlidomingoDoc, Slide } from '../model'
import type { Store } from '../store'
import type { Editor } from './editor'
import { renderThumbnail } from '../render'
import { positionFloating } from './floatingposition'
import { t } from '../i18n'

/** One candidate treatment of the target slide. */
export interface PendingVariant {
  slide: Slide
  label?: string
}

/** Editor.pendingVariants' shape — a single pending slot (not a queue): a
 *  later propose_variants call REPLACES this wholesale. */
export interface PendingVariants {
  requestId: string
  slideId: string
  variants: PendingVariant[]
  assets: Record<string, string>
  fonts: NonNullable<SlidomingoDoc['fonts']>
}

function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

export function openVariantPicker(editor: Editor, store: Store, anchor: HTMLElement): void {
  document.querySelector('.ed-variantpick')?.remove()
  const pending = editor.getPendingVariants()
  if (!pending) return

  const pick = div('ed-variantpick')
  const title = div('ed-variantpick-title')
  title.textContent = t('Pick a variant for this slide')
  pick.appendChild(title)

  // Fresh, throwaway preview doc — never store.doc itself, and never
  // assigned back to it. Only `assets` are merged (renderThumbnail needs
  // them to resolve image/svg refs); fonts aren't needed to preview a still
  // thumbnail's box layout.
  const previewDoc: SlidomingoDoc = { ...store.doc, assets: { ...store.doc.assets, ...pending.assets } }

  const grid = div('ed-variantpick-grid')
  pending.variants.forEach((variant, i) => {
    const item = div('ed-variantpick-item')
    try {
      item.appendChild(renderThumbnail(variant.slide, previewDoc, 160))
    } catch {
      const broken = div('ed-variantpick-broken')
      broken.textContent = t('Preview unavailable')
      item.appendChild(broken)
    }
    const name = div('ed-variantpick-name')
    name.textContent = variant.label || t('Variant {n}', { n: i + 1 })
    item.appendChild(name)
    item.addEventListener('click', () => {
      pick.remove()
      document.removeEventListener('pointerdown', close, true)
      editor.applyVariant(i)
    })
    grid.appendChild(item)
  })
  pick.appendChild(grid)

  const footer = div('ed-variantpick-footer')
  const discardBtn = document.createElement('button')
  discardBtn.type = 'button'
  discardBtn.className = 'ed-btn'
  discardBtn.textContent = t('Discard all')
  discardBtn.addEventListener('click', () => {
    pick.remove()
    document.removeEventListener('pointerdown', close, true)
    editor.discardVariants()
  })
  footer.appendChild(discardBtn)
  pick.appendChild(footer)

  // Append BEFORE positioning — positionFloating measures the panel's real
  // rendered box (getBoundingClientRect), never a guessed constant.
  document.body.appendChild(pick)
  positionFloating(anchor, pick, { placement: 'bottom-start' })

  const close = (ev: PointerEvent) => {
    if (!pick.contains(ev.target as Node)) {
      pick.remove()
      document.removeEventListener('pointerdown', close, true)
    }
  }
  setTimeout(() => document.addEventListener('pointerdown', close, true))
}
