// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Small DOM helpers the Settings panes share, and the command picker: a
// searchable list of everything a button, pin or shortcut may run (the
// profile's own commands first, then every menu command by menu) — what used
// to be one very long <select>.

import { t } from '../../i18n'
import { commandCatalog } from './catalog'
import { actionLabel } from './apply'
import type { UiProfile } from './schema'

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function button(label: string, onClick: () => void, title?: string, cls = 'ed-btn'): HTMLButtonElement {
  const b = el('button', cls, label)
  b.type = 'button'
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}

interface PickItem { value: string; label: string; group: string; hay: string }

function pickItems(p: UiProfile): PickItem[] {
  const out: PickItem[] = []
  for (const [id, a] of Object.entries(p.actions ?? {})) {
    const label = actionLabel(p, id, a)
    out.push({ value: id, label, group: t('My commands'), hay: label.toLowerCase() })
  }
  for (const c of commandCatalog()) {
    const label = t(c.label)
    const group = c.menu.split(' ▸ ').map((m) => t(m)).join(' ▸ ')
    out.push({ value: c.id, label, group, hay: `${label} ${group} ${c.id}`.toLowerCase() })
  }
  return out
}

/**
 * A modal list to pick one command from, with a search field (type to
 * filter, ↑↓ to move, Enter to pick, Esc to cancel). `footer` adds controls
 * under the list (e.g. "where to pin it"). Resolves the picked target id,
 * or null.
 */
export function pickTarget(p: UiProfile, opts: { title: string; okLabel?: string; footer?: HTMLElement } ): Promise<string | null> {
  return new Promise((resolve) => {
    const items = pickItems(p)
    const dlg = el('dialog', 'ed-dialog ed-cz-dialog ed-cz-picker')
    dlg.appendChild(el('h2', undefined, opts.title))
    const search = el('input', 'ed-cz-search')
    search.type = 'search'
    search.placeholder = t('Search commands…')
    search.setAttribute('aria-label', t('Search commands…'))
    const list = el('div', 'ed-cz-picklist')
    list.setAttribute('role', 'listbox')
    dlg.append(search, list)
    if (opts.footer) dlg.appendChild(opts.footer)
    const actions = el('div', 'ed-dialog-actions')
    const cancel = button(t('Cancel'), () => done(null), undefined, '')
    const ok = button(opts.okLabel ?? t('Choose'), () => done(chosen), undefined, 'ed-primary')
    actions.append(cancel, ok)
    dlg.appendChild(actions)

    let shown: PickItem[] = []
    let active = 0
    let chosen: string | null = null
    const rows: HTMLElement[] = []
    const mark = () => {
      rows.forEach((r, i) => r.classList.toggle('active', i === active))
      rows[active]?.scrollIntoView({ block: 'nearest' })
      chosen = shown[active]?.value ?? null
      ok.disabled = !chosen
    }
    const paint = () => {
      const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
      shown = items.filter((it) => words.every((w) => it.hay.includes(w)))
      list.replaceChildren()
      rows.length = 0
      let group = ''
      shown.forEach((it, i) => {
        if (it.group !== group) { group = it.group; list.appendChild(el('div', 'ed-cz-pickgroup', group)) }
        const r = el('div', 'ed-cz-pickrow', it.label)
        r.setAttribute('role', 'option')
        r.addEventListener('mousemove', () => { if (active !== i) { active = i; mark() } })
        r.addEventListener('click', () => { active = i; mark() })
        r.addEventListener('dblclick', () => done(it.value))
        list.appendChild(r)
        rows.push(r)
      })
      if (!shown.length) list.appendChild(el('p', 'ed-hint', t('Nothing matches “{q}”', { q: search.value.trim() })))
      active = 0
      mark()
    }
    search.addEventListener('input', paint)
    search.addEventListener('keydown', (ev) => {
      ev.stopPropagation()
      if (ev.key === 'ArrowDown') { ev.preventDefault(); active = Math.min(shown.length - 1, active + 1); mark() }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); active = Math.max(0, active - 1); mark() }
      else if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); if (chosen) done(chosen) }
    })
    document.body.appendChild(dlg)
    let settled = false
    function done(v: string | null) {
      if (settled) return
      settled = true
      dlg.close()
      dlg.remove()
      resolve(v)
    }
    dlg.addEventListener('cancel', () => done(null))
    dlg.showModal()
    paint()
    search.focus()
  })
}
