// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Add icons (icon sets, DECISIONS 2026-10-16 "Add icons"): a popover next to
// the + tile / the ribbon button. Type a name, press Enter, and the icon is
// in the grid at once; type the next one. A pasted list adds every line.
// With Claude set up, the lower half takes a description instead and asks
// Claude to plan the list (the same `plan-icons` prompt as Plan with AI).
// Each name is one commit (one undo step); an empty Enter, Esc or a click
// outside closes it.

import type { Store } from '../store'
import { t } from '../i18n'
import { addIconNames } from '../iconset'
import { positionAtRect } from './floatingposition'

let current: { close: () => void; anchor: Element | null } | null = null

export interface AddIconsOptions {
  /** where the first new icon goes (the next ones follow it) */
  at: number
  /** start in the describe box instead of the name field */
  focus?: 'name' | 'plan'
  /** Claude plans the icons from a description; absent = no AI half */
  plan?: (request: string) => void
  /** after icons were added (the editor selects and reveals them) */
  onAdded?: (slideIds: string[]) => void
  /** the anchor again once the list was rebuilt (the + tile is a new node then) */
  reanchor?: () => Element | null
}

/** Open the popover under `anchor`; a second call from the same control closes it. */
export function openAddIcons(store: Store, anchor: HTMLElement | DOMRect, opts: AddIconsOptions): void {
  if (current) {
    const same = anchor instanceof Element && current.anchor === anchor
    current.close()
    if (same) return
  }
  const pop = document.createElement('div')
  pop.className = 'ed-iconadd'
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', t('Add icons'))

  const title = document.createElement('div')
  title.className = 'ed-iconadd-title'
  title.textContent = t('Add icons')

  const name = document.createElement('input')
  name.type = 'text'
  name.className = 'ed-iconadd-name'
  name.placeholder = t('Name an icon, press Enter')
  name.maxLength = 120
  name.setAttribute('aria-label', t('Name an icon, press Enter'))

  const status = document.createElement('div')
  status.className = 'ed-iconadd-status'
  status.setAttribute('aria-live', 'polite')
  const hint = t('Each Enter adds an icon. Paste a list to add them all.')
  status.textContent = hint

  pop.append(title, name, status)

  let at = opts.at
  let total = 0
  const add = (names: string[]) => {
    const list = names.map((n) => n.trim()).filter(Boolean)
    if (!list.length) return
    let res: { slideIds: string[]; added: number } = { slideIds: [], added: 0 }
    const before = store.doc.slides.length
    store.commit(() => { res = addIconNames(store.doc, list, at) })
    at += store.doc.slides.length - before // the next ones follow these
    total += res.added
    status.textContent = res.added
      ? (total === 1 ? t('Added 1 icon') : t('Added {n} icons', { n: total }))
      : t('Already in the set')
    status.classList.toggle('is-done', res.added > 0)
    if (res.slideIds.length) opts.onAdded?.(res.slideIds)
    name.value = ''
    name.focus()
    requestAnimationFrame(place) // the + tile has moved
  }
  name.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.isComposing) return
    ev.preventDefault()
    if (!name.value.trim()) { close(); return } // an empty Enter = done
    add([name.value])
  })
  // a pasted list: every line (or comma-separated name) becomes an icon
  name.addEventListener('paste', (ev) => {
    const text = ev.clipboardData?.getData('text/plain') ?? ''
    if (!/[\n,]/.test(text)) return
    ev.preventDefault()
    add(text.split(/\r?\n|,/).slice(0, 200))
  })

  let plan: HTMLTextAreaElement | null = null
  if (opts.plan) {
    const or = document.createElement('div')
    or.className = 'ed-iconadd-or'
    or.textContent = t('or describe them, and Claude plans the list')
    plan = document.createElement('textarea')
    plan.className = 'ed-iconadd-plan'
    plan.rows = 3
    plan.placeholder = t('e.g. think about 12 icons for a digital forensics course: evidence handling, analysis tools, reporting')
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'ed-btn ed-primary ed-iconadd-go'
    go.textContent = t('Plan with AI')
    go.title = t('Say which icons you need in your own words — Claude plans them as empty icons for you to check')
    const send = () => {
      const request = plan!.value.trim()
      if (!request) { plan!.focus(); return }
      close()
      opts.plan!(request)
    }
    go.addEventListener('click', send)
    plan.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.isComposing) { ev.preventDefault(); send() }
    })
    pop.append(or, plan, go)
  }

  document.body.appendChild(pop)
  const place = () => {
    if (anchor instanceof Element && !anchor.isConnected) {
      const again = opts.reanchor?.()
      if (again instanceof HTMLElement) anchor = again
    }
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor
    // from the + tile: beside the icon list, level with the tile (it moves
    // down as icons are added), never on top of the icons being added
    const list = anchor instanceof Element ? anchor.closest('.ed-sidebar') : null
    if (list) {
      const top = Math.max(8, Math.min(r.top, window.innerHeight - pop.offsetHeight - 8))
      positionAtRect(new DOMRect(list.getBoundingClientRect().right + 8, top, 0, 0), pop, { placement: 'bottom', align: 'start', gap: 0, margin: 8 })
    } else positionAtRect(r, pop, { placement: 'bottom', align: 'start', gap: 6, margin: 8 })
  }
  place()
  ;(opts.focus === 'plan' && plan ? plan : name).focus()

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
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', place)
    pop.remove()
    if (current?.close === close) current = null
  }
  setTimeout(() => document.addEventListener('pointerdown', outside, true))
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', place)
  current = { close, anchor: anchor instanceof Element ? anchor : null }
}
