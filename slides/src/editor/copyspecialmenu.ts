// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The Copy special popup (⇧⌘C, right-click ▸ Copy special…): the formats of
// copyspecial.ts numbered 1–5, a digit picks one, then Copy settings…. Same
// point-anchored, viewport-clamped popover as contextmenu.ts. Its keys are
// taken in the capture phase and stopped there, so Enter or a digit never
// also reaches the editor's own shortcuts (wireKeyboard); any other key
// closes it and goes on as usual. renderCopySettings is its Settings page.

import { t } from '../i18n'
import { COPY_FORMATS, canCopyFormat, copyFormatHint, copyFormatLabel, copyPrefs, setCopyPrefs, type CopyFormat, type CopyPrefs } from './copyspecial'

export interface CopySpecialMenuOpts {
  x: number
  y: number
  /** what is copied: "Copy 2 objects as" / "Copy the slide as" */
  caption: string
  pick(format: CopyFormat): void
  settings(): void
}

export function openCopySpecialMenu(o: CopySpecialMenuOpts): void {
  document.querySelector('.ed-ctx-menu')?.remove()
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const menu = document.createElement('div')
  menu.className = 'ed-ctx-menu ed-copy-special'
  menu.setAttribute('role', 'menu')
  const cap = document.createElement('div')
  cap.className = 'ed-arrange-cap'
  cap.textContent = o.caption
  menu.appendChild(cap)

  const rows: HTMLButtonElement[] = []
  // keys run these directly: a synthetic button.click() can be swallowed by
  // the canvas's drag library (Gesto drops the click after a press)
  const runs: Array<() => void> = []
  const choose = (i: number) => {
    if (!rows[i] || rows[i].disabled) return
    close()
    runs[i]()
  }
  const row = (num: string, label: string, hint: string, enabled: boolean, run: () => void) => {
    const b = document.createElement('button')
    b.className = 'ed-btn ed-cs-row'
    b.setAttribute('role', 'menuitem')
    b.disabled = !enabled
    const n = document.createElement('kbd')
    n.className = 'ed-cs-num'
    n.textContent = num
    const text = document.createElement('span')
    text.className = 'ed-cs-text'
    const l = document.createElement('span')
    l.textContent = label
    text.appendChild(l)
    if (hint) {
      const h = document.createElement('small')
      h.textContent = hint
      text.appendChild(h)
    }
    b.append(n, text)
    b.addEventListener('click', () => choose(rows.indexOf(b)))
    menu.appendChild(b)
    rows.push(b)
    runs.push(run)
  }
  COPY_FORMATS.forEach((f, i) => row(String(i + 1), copyFormatLabel(f), copyFormatHint(f), canCopyFormat(f), () => o.pick(f)))
  const sep = document.createElement('div')
  sep.className = 'ed-menu-sep'
  menu.appendChild(sep)
  row('', t('Copy settings…'), '', true, () => o.settings())

  document.body.appendChild(menu)
  const r = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(o.x, window.innerWidth - r.width - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(o.y, window.innerHeight - r.height - 4))}px`
  rows.find((b) => !b.disabled)?.focus()

  const close = () => {
    menu.remove()
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('keydown', onKey, true)
    if (back?.isConnected) back.focus({ preventScroll: true })
  }
  const onOutside = (ev: PointerEvent) => { if (!menu.contains(ev.target as Node)) close() }
  const onKey = (ev: KeyboardEvent) => {
    if (!menu.isConnected) { close(); return }
    const take = () => { ev.preventDefault(); ev.stopPropagation() }
    // by code too: on AZERTY the digits need Shift
    const digit = /^[1-9]$/.test(ev.key) ? Number(ev.key) : /^(Digit|Numpad)[1-9]$/.test(ev.code) ? Number(ev.code.slice(-1)) : 0
    if (digit && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      take()
      if (digit <= COPY_FORMATS.length) choose(digit - 1)
      return
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      take()
      const live = rows.filter((b) => !b.disabled)
      const i = live.indexOf(document.activeElement as HTMLButtonElement)
      live[(i + (ev.key === 'ArrowDown' ? 1 : live.length - 1)) % live.length]?.focus()
      return
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      take()
      choose(rows.indexOf(document.activeElement as HTMLButtonElement))
      return
    }
    if (ev.key === 'Escape') { take(); close(); return }
    if (ev.key === 'Tab' || ev.key === 'Shift') return
    close()
  }
  // Deferred: the right-click or key that opened this must not close it.
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
  })
}

/** Settings ▸ Copy special. */
export function renderCopySettings(host: HTMLElement): void {
  const prefs = copyPrefs()
  const intro = document.createElement('p')
  intro.className = 'ed-hint'
  intro.textContent = t('What Copy special puts on the clipboard. Kept in this browser, never in the file.')
  host.appendChild(intro)

  const scaleRow = document.createElement('label')
  scaleRow.className = 'ed-about-auto'
  const scaleSel = document.createElement('select')
  for (const s of [1, 2, 4] as const) {
    const o = document.createElement('option')
    o.value = String(s)
    o.textContent = s === 1 ? t('1× (as on the slide)') : `${s}×`
    o.selected = s === prefs.scale
    scaleSel.appendChild(o)
  }
  scaleSel.addEventListener('change', () => setCopyPrefs({ scale: Number(scaleSel.value) as CopyPrefs['scale'] }))
  scaleRow.append(document.createTextNode(t('Picture resolution') + ' '), scaleSel)
  host.appendChild(scaleRow)

  const check = (label: string, on: boolean, set: (v: boolean) => void) => {
    const row = document.createElement('label')
    row.className = 'ed-about-auto'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = on
    cb.addEventListener('change', () => set(cb.checked))
    row.append(cb, document.createTextNode(' ' + label))
    host.appendChild(row)
  }
  check(t('Selected objects on the slide’s background colour (else transparent)'), prefs.background, (v) => setCopyPrefs({ background: v }))
  check(t('Text as outlines in SVG and pictures (needs the network once)'), prefs.outlineText, (v) => setCopyPrefs({ outlineText: v }))
}
