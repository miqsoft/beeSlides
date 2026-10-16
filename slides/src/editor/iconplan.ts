// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Plan with AI (icon sets, DECISIONS 2026-10-16 "Add icons in place"): a
// small card under the ribbon button (or the canvas, from the menu) that
// takes what the set is for, in the user's words, and hands it to Claude as
// the `plan-icons` prompt. Adding icons by name happens in the grid itself
// (Editor.iconAddTile), not here.

import { t } from '../i18n'
import { ICONS } from '../icons'
import { isMacOS } from '../screens'
import { positionAtRect } from './floatingposition'

let current: { close: () => void; anchor: Element | null } | null = null

/** Open the card under `anchor`; a second call from the same control closes it. */
export function openPlanIcons(anchor: HTMLElement | DOMRect, plan: (request: string) => void): void {
  if (current) {
    const same = anchor instanceof Element && current.anchor === anchor
    current.close()
    if (same) return
  }
  const pop = document.createElement('div')
  pop.className = 'ed-iconplan'
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', t('Plan with AI'))

  const head = document.createElement('div')
  head.className = 'ed-iconplan-head'
  const mark = document.createElement('span')
  mark.className = 'ed-iconplan-mark'
  mark.innerHTML = ICONS.sparkle // a built-in icon (trusted markup)
  const title = document.createElement('span')
  title.textContent = t('Plan with AI')
  head.append(mark, title)

  const sub = document.createElement('p')
  sub.className = 'ed-iconplan-sub'
  sub.textContent = t('Say which icons you need in your own words — Claude plans them as empty icons for you to check')

  const ask = document.createElement('textarea')
  ask.className = 'ed-iconplan-ask'
  ask.rows = 4
  ask.placeholder = t('e.g. think about 12 icons for a digital forensics course: evidence handling, analysis tools, reporting')
  ask.setAttribute('aria-label', t('Plan with AI'))

  const foot = document.createElement('div')
  foot.className = 'ed-iconplan-foot'
  const keys = document.createElement('kbd')
  keys.textContent = isMacOS() ? '⌘↩' : 'Ctrl+↩'
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'ed-iconplan-go'
  go.textContent = t('Plan with AI')
  go.disabled = true
  foot.append(keys, go)
  pop.append(head, sub, ask, foot)

  const send = () => {
    const request = ask.value.trim()
    if (!request) { ask.focus(); return }
    close()
    plan(request)
  }
  ask.addEventListener('input', () => { go.disabled = !ask.value.trim() })
  go.addEventListener('click', send)
  ask.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.isComposing) { ev.preventDefault(); send() }
  })

  document.body.appendChild(pop)
  const place = () => {
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor
    positionAtRect(r, pop, { placement: 'bottom', align: 'start', gap: 6, margin: 8 })
  }
  place()
  ask.focus()

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
