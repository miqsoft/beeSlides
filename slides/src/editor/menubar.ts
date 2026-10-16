// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The in-page menu bar of the BROWSER editor (File / Edit / Insert / Slide /
// Arrange / View / Play / Help). It draws the very model the desktop shell
// turns into its native menu bar — `CommandRegistry.serialize()` (commands.ts
// over menumodel.ts's catalog): translated labels, live enabled/checked
// state, the UI profile's accelerators. Nothing here knows what a command
// does; a click hands the id back to `run` (= `commands.run`). The desktop
// shell never mounts this (macOS: system menu bar; Windows/Linux: ☰ pops up
// the native application menu).
//
// `{ slot }` blocks are the items the desktop MAIN process owns (New Window,
// Open Recent, Cut/Copy/Paste roles, UI zoom, the Claude terminal…). The
// caller maps each to its web equivalent — or to nothing (`[]`); see
// Editor.webMenuSlot. The model's `app` section (Settings…) is not a menu of
// its own here: main places it in the macOS app menu, the web in File.
//
// Pure layout, like ribbon.ts/titlebar.ts: never imports Editor.
//
// Accelerators are DISPLAY-ONLY, exactly as on desktop: the page's own
// keydown handler (editor.ts wireKeyboard) stays the one owner of every key.

import { displayChord } from './customize/logic'
import { positionAtRect } from './floatingposition'
import type { MenuModel, WireItem } from './menumodel'

/** One entry the bar can draw: a model item, or a web stand-in for a slot
 *  (`run` set — those are not registry commands). */
export type BarItem =
  | { type: 'separator' }
  | { label: string; submenu: BarItem[] }
  | { id?: string; label: string; accel?: string; enabled: boolean; checked?: boolean; radio?: boolean; run?: () => void }

type Leaf = Extract<BarItem, { enabled: boolean }>

export interface MenuBarOpts {
  /** a fresh, state-aware model — called on every open */
  model: () => MenuModel
  /** run a registry command by id */
  run: (id: string) => void
  /** the web stand-in for a main-owned `{ slot }` block ([] = omit it) */
  slot: (name: string, model: MenuModel) => BarItem[]
  mac: boolean
  /** aria-label of the bar */
  label: string
}

export interface MenuBarHandle {
  el: HTMLElement
  close(): void
  /** which menu is open (its key), or null — for tests and scripting */
  openKey(): string | null
}

const isSep = (i: BarItem): i is { type: 'separator' } => 'type' in i
const isSub = (i: BarItem): i is { label: string; submenu: BarItem[] } => 'submenu' in i

/** Slots resolved, empty submenus dropped, doubled/leading/trailing
 *  separators collapsed (the same tidy rule as serializeMenuModel). */
export function resolveMenuItems(items: WireItem[], model: MenuModel, slot: MenuBarOpts['slot']): BarItem[] {
  const out: BarItem[] = []
  const push = (it: BarItem) => {
    if (isSep(it) && (!out.length || isSep(out[out.length - 1]))) return
    out.push(it)
  }
  for (const it of items) {
    if ('slot' in it) { for (const s of slot(it.slot, model)) push(s); continue }
    if ('submenu' in it) {
      const sub = resolveMenuItems(it.submenu, model, slot)
      if (sub.length) push({ label: it.label, submenu: sub })
      continue
    }
    push(it as BarItem)
  }
  while (out.length && isSep(out[out.length - 1])) out.pop()
  return out
}

/** "Shift+CmdOrCtrl+Z" → ⇧⌘Z on a Mac, Shift+Ctrl+Z elsewhere. */
export function displayAccel(accel: string, mac: boolean): string {
  return displayChord(accel.replace(/\b(?:CmdOrCtrl|CommandOrControl|Cmd|Command)\b/g, 'Mod'), mac)
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function buildMenuBar(opts: MenuBarOpts): MenuBarHandle {
  const bar = el('div', 'ed-menubar')
  bar.setAttribute('role', 'menubar')
  bar.setAttribute('aria-label', opts.label)
  // Never take focus from the canvas / a live text edit — a native menu
  // doesn't either (Format Painter, Insert ▸ … act on what is being edited).
  bar.addEventListener('mousedown', (ev) => ev.preventDefault())

  /** the menus that have anything to show — filled once the editor that
   *  owns the commands has finished building (the model reads its panels) */
  let menus: Array<{ key: string; label: string }> = []
  const tops: HTMLButtonElement[] = []
  /** open panels, outermost first; [0] belongs to tops[openIndex] */
  let stack: HTMLElement[] = []
  let openIndex = -1
  /** what Enter / → does on a highlighted row */
  const rowActs = new WeakMap<HTMLElement, { run?: () => void; open?: () => void }>()

  const rtl = () => getComputedStyle(bar).direction === 'rtl'

  const closeFrom = (level: number) => {
    for (const p of stack.splice(level)) p.remove()
  }
  const close = () => {
    closeFrom(0)
    if (openIndex >= 0) tops[openIndex]?.classList.remove('ed-menubar-open')
    openIndex = -1
    window.removeEventListener('keydown', onKey, true)
  }

  const rows = (panel: HTMLElement) =>
    [...panel.querySelectorAll<HTMLElement>(':scope > .ed-menubar-row:not(.ed-menubar-disabled)')]
  const hot = (panel: HTMLElement) => panel.querySelector<HTMLElement>(':scope > .ed-menubar-hot')
  const setHot = (panel: HTMLElement, row: HTMLElement | null) => {
    hot(panel)?.classList.remove('ed-menubar-hot')
    row?.classList.add('ed-menubar-hot')
  }

  const activate = (item: Leaf) => {
    if (!item.enabled) return
    close()
    if (item.run) item.run()
    else if (item.id) opts.run(item.id)
  }

  /** Builds one panel for `items` at `level`, positioned against `anchor`
   *  (below a top button, beside a submenu row). */
  const openPanel = (items: BarItem[], level: number, anchor: HTMLElement) => {
    closeFrom(level)
    const panel = el('div', 'ed-menubar-panel')
    panel.setAttribute('role', 'menu')
    panel.dataset.level = String(level)
    const hasChecks = items.some((i) => !isSep(i) && !isSub(i) && i.checked !== undefined)
    if (hasChecks) panel.classList.add('ed-menubar-checks')
    for (const item of items) {
      if (isSep(item)) { panel.appendChild(el('div', 'ed-menubar-sep')); continue }
      const row = el('button', 'ed-menubar-row')
      row.type = 'button'
      row.tabIndex = -1
      const mark = el('span', 'ed-menubar-mark')
      const label = el('span', 'ed-menubar-label', item.label)
      const tail = el('span', 'ed-menubar-accel')
      row.append(mark, label, tail)
      if (isSub(item)) {
        row.setAttribute('aria-haspopup', 'menu')
        row.classList.add('ed-menubar-parent')
        tail.textContent = rtl() ? '◂' : '▸'
        const openSub = () => {
          if (stack[level + 1]?.dataset.parent === item.label) return
          openPanel(item.submenu, level + 1, row)
          stack[level + 1].dataset.parent = item.label
        }
        row.addEventListener('mouseenter', () => { setHot(panel, row); openSub() })
        row.addEventListener('click', openSub)
        rowActs.set(row, { open: openSub })
      } else {
        row.setAttribute('role', item.checked === undefined ? 'menuitem' : item.radio ? 'menuitemradio' : 'menuitemcheckbox')
        if (item.checked !== undefined) {
          row.setAttribute('aria-checked', String(item.checked))
          if (item.checked) mark.textContent = item.radio ? '•' : '✓'
        }
        if (item.id) row.dataset.command = item.id
        if (item.accel) tail.textContent = displayAccel(item.accel, opts.mac)
        if (!item.enabled) { row.classList.add('ed-menubar-disabled'); row.setAttribute('aria-disabled', 'true') }
        row.addEventListener('mouseenter', () => { setHot(panel, item.enabled ? row : null); closeFrom(level + 1) })
        row.addEventListener('click', () => activate(item))
        rowActs.set(row, { run: () => activate(item) })
      }
      panel.appendChild(row)
    }
    bar.appendChild(panel)
    stack[level] = panel
    if (level === 0) {
      positionAtRect(anchor.getBoundingClientRect(), panel, { placement: 'bottom', align: rtl() ? 'end' : 'start', gap: 2, margin: 6 })
    } else {
      // beside the row, flipped to the other side when it would leave the window
      const r = anchor.getBoundingClientRect()
      const pr = panel.getBoundingClientRect()
      const parent = stack[level - 1].getBoundingClientRect()
      const after = rtl() ? parent.left - pr.width + 2 : parent.right - 2
      const before = rtl() ? parent.right - 2 : parent.left - pr.width + 2
      const fits = (x: number) => x >= 6 && x + pr.width <= window.innerWidth - 6
      const x = fits(after) ? after : fits(before) ? before : Math.max(6, window.innerWidth - pr.width - 6)
      const y = Math.max(6, Math.min(r.top - 5, window.innerHeight - pr.height - 6))
      panel.style.position = 'fixed'
      panel.style.left = `${Math.round(x)}px`
      panel.style.top = `${Math.round(y)}px`
    }
    return panel
  }

  const open = (i: number) => {
    const m = menus[i]
    if (!m) return
    const model = opts.model()
    const fresh = model.menus.find((x) => x.key === m.key)
    closeFrom(0)
    if (openIndex >= 0) tops[openIndex]?.classList.remove('ed-menubar-open')
    openIndex = i
    tops[i].classList.add('ed-menubar-open')
    openPanel(resolveMenuItems(fresh?.items ?? [], model, opts.slot), 0, tops[i])
    window.removeEventListener('keydown', onKey, true)
    window.addEventListener('keydown', onKey, true)
  }

  // While a menu is open it owns the keyboard, like a native one: nothing
  // reaches the canvas (arrows would nudge, Esc would deselect).
  function onKey(ev: KeyboardEvent) {
    if (openIndex < 0) return
    if (ev.metaKey || ev.ctrlKey) { close(); return } // a shortcut: let it through
    ev.preventDefault()
    ev.stopImmediatePropagation()
    const level = stack.length - 1
    const panel = stack[level]
    if (!panel) return
    const list = rows(panel)
    const cur = hot(panel)
    const idx = cur ? list.indexOf(cur) : -1
    const back = rtl() ? 'ArrowRight' : 'ArrowLeft'
    const fwd = rtl() ? 'ArrowLeft' : 'ArrowRight'
    switch (ev.key) {
      case 'Escape':
        if (level > 0) closeFrom(level)
        else close()
        return
      case 'ArrowDown':
        if (list.length) setHot(panel, list[(idx + 1) % list.length])
        return
      case 'ArrowUp':
        if (list.length) setHot(panel, list[(idx - 1 + list.length) % list.length])
        return
      case 'Enter':
      case ' ': {
        const a = cur ? rowActs.get(cur) : undefined
        if (a?.open) { a.open(); const sub = stack[level + 1]; if (sub) setHot(sub, rows(sub)[0] ?? null) } else a?.run?.()
        return
      }
      default:
        if (ev.key === fwd) {
          const a = cur ? rowActs.get(cur) : undefined
          if (a?.open) { a.open(); const sub = stack[level + 1]; if (sub) setHot(sub, rows(sub)[0] ?? null); return }
          open((openIndex + 1) % menus.length)
          return
        }
        if (ev.key === back) {
          if (level > 0) { closeFrom(level); return }
          open((openIndex - 1 + menus.length) % menus.length)
        }
    }
  }

  const fill = () => {
    const initial = opts.model()
    menus = initial.menus.filter((m) => m.key !== 'app' && resolveMenuItems(m.items, initial, opts.slot).length)
    menus.forEach(addTop)
  }
  const addTop = (m: { key: string; label: string }, i: number) => {
    const b = el('button', 'ed-menubar-top', m.label)
    b.type = 'button'
    b.dataset.menu = m.key
    b.setAttribute('aria-haspopup', 'menu')
    b.addEventListener('click', () => (openIndex === i ? close() : open(i)))
    // the native feel: once one menu is open, hovering the bar switches menus
    b.addEventListener('mouseenter', () => { if (openIndex >= 0 && openIndex !== i) open(i) })
    tops.push(b)
    bar.appendChild(b)
  }
  queueMicrotask(fill)

  document.addEventListener('pointerdown', (ev) => {
    if (openIndex >= 0 && !bar.contains(ev.target as Node)) close()
  }, true)
  window.addEventListener('blur', () => close())
  window.addEventListener('resize', () => close())

  return { el: bar, close, openKey: () => (openIndex >= 0 ? menus[openIndex].key : null) }
}
