// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Settings ▸ Customize, the parts that ADD and TRIM: your own ribbon tabs
// and their buttons, items pinned to (or hidden from) the right-click menu
// and the quick-format bar, toolbar buttons and ribbon groups to show or
// hide, and the Import / Export dialogs with their part pickers ("Add to
// mine" vs "Replace mine"). settingspane.ts owns the pane and calls in here;
// every change is one strictly validated write through its `edit`.
// Keyboard shortcuts have their own pane (keymappane.ts).

import { t } from '../../i18n'
import { CONTEXT_ITEMS, CONTEXT_SCOPES, MINIBAR_ITEMS, MINIBAR_SCOPES, PANEL_SECTIONS, RIBBON_LAYOUT, RIBBON_TABS, TOOLBAR_ITEMS, type CatalogItem, type PanelSection } from './catalog'
import { freshId, mergeProfiles, movePanelSection, panelScopeOrder, pickParts, profileParts, type MergeNote } from './logic'
import { targetLabel } from './apply'
import { UI_LIMITS } from './validate'
import { PROFILE_PARTS, QUICKBAR_PLACES, emptyProfile, type QuickBarPlace, type UiMenu, type UiPart, type UiProfile } from './schema'
import { button, el, pickTarget } from './ui'

export type Edit = (mutate: (p: UiProfile) => void, summary: string) => Promise<boolean>

export const partLabel = (p: UiPart): string => ({
  buttons: t('Tabs and buttons'), menus: t('Menu items'), toolbar: t('Toolbar'), panel: t('Side panel'), shortcuts: t('Shortcuts'),
  styles: t('My styles'), presets: t('Presets'), look: t('Look'), defaults: t('Default styles'),
} as Record<UiPart, string>)[p]

export const scopeLabel = (s: string): string => ({
  '*': t('Everywhere'), canvas: t('Empty slide'), multi: t('Several elements'), 'text-edit': t('While editing text'),
  line: t('Line'), text: t('Text'), shape: t('Shape'), image: t('Image'), svg: t('Diagram'), chart: t('Chart'),
  table: t('Table'), code: t('Code'), embed: t('Embed'), media: t('Video or audio'), math: t('Equation'), zoom: t('Zoom'),
} as Record<string, string>)[s] ?? s

/** A removable chip: the label and a × that runs `remove`. */
function chip(label: string, remove: () => void, removeTitle: string): HTMLElement {
  const c = el('span', 'ed-cz-chip')
  c.appendChild(el('span', undefined, label))
  const x = button('×', remove, removeTitle, 'ed-cz-chipx')
  x.setAttribute('aria-label', `${removeTitle}: ${label}`)
  c.appendChild(x)
  return c
}

/** A text field that writes on change (Enter or leaving it). */
function renameField(value: string, label: string, onRename: (v: string) => void): HTMLInputElement {
  const f = el('input', 'ed-cz-name')
  f.value = value
  f.maxLength = UI_LIMITS.label
  f.setAttribute('aria-label', label)
  f.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') f.blur() })
  f.addEventListener('change', () => { const v = f.value.trim(); if (v && v !== value) onRename(v); else f.value = value })
  return f
}

/** Your own ribbon tabs (desktop) — in a browser the same buttons sit in the
 *  top bar's "My tools" menu. Rename, add and remove buttons, add a tab. */
export function tabsSection(host: HTMLElement, p: UiProfile, edit: Edit): void {
  const tabs = p.ribbon?.tabs ?? []
  if (!tabs.length) host.appendChild(el('p', 'ed-hint', t('You have no buttons of your own yet. Make a tab, then add any command, style or preset to it.')))
  for (const tab of tabs) {
    const card = el('div', 'ed-cz-card')
    const top = el('div', 'ed-cz-cardhead')
    top.appendChild(renameField(tab.label, t('Tab name'), (v) => void edit((q) => {
      const x = q.ribbon?.tabs?.find((tt) => tt.id === tab.id)
      if (x) x.label = v
    }, t('Renamed the tab to “{name}”', { name: v }))))
    top.appendChild(button(t('Delete tab'), () => void edit((q) => {
      q.ribbon!.tabs = q.ribbon!.tabs!.filter((x) => x.id !== tab.id)
      if (!q.ribbon!.tabs.length) delete q.ribbon!.tabs
    }, t('Removed the tab “{name}”', { name: tab.label })), undefined, 'ed-btn ed-cz-danger'))
    card.appendChild(top)
    for (const g of tab.groups) {
      const grp = el('div', 'ed-cz-group')
      if (tab.groups.length > 1 || g.label !== t('Buttons')) {
        grp.appendChild(renameField(g.label, t('Group name'), (v) => void edit((q) => {
          const x = q.ribbon?.tabs?.find((tt) => tt.id === tab.id)?.groups.find((gg) => gg.id === g.id)
          if (x) x.label = v
        }, t('Renamed the group to “{name}”', { name: v }))))
      }
      const chips = el('div', 'ed-cz-chips')
      g.buttons.forEach((b, bi) => {
        const name = targetLabel(p, b.target, b.label)
        chips.appendChild(chip(name, () => void edit((q) => {
          const x = q.ribbon?.tabs?.find((tt) => tt.id === tab.id)?.groups.find((gg) => gg.id === g.id)
          if (x) x.buttons.splice(bi, 1)
        }, t('Removed the button “{name}”', { name })), t('Remove')))
      })
      const add = button(t('+ Add button…'), () => void pickTarget(p, { title: t('Add a button to “{name}”', { name: tab.label }), okLabel: t('Add') }).then((target) => {
        if (!target) return
        void edit((q) => {
          const x = q.ribbon?.tabs?.find((tt) => tt.id === tab.id)?.groups.find((gg) => gg.id === g.id)
          if (x) x.buttons.push({ target })
        }, t('Added “{name}” to {tab}', { name: targetLabel(p, target), tab: tab.label }))
      }), undefined, 'ed-btn ed-cz-addbtn')
      add.disabled = g.buttons.length >= UI_LIMITS.buttons
      chips.appendChild(add)
      grp.appendChild(chips)
      card.appendChild(grp)
    }
    host.appendChild(card)
  }
  const newTab = button(t('+ New tab'), () => void edit((q) => {
    q.ribbon ??= {}
    q.ribbon.tabs ??= []
    const taken = Object.fromEntries([...q.ribbon.tabs.map((x) => [x.id, 1]), ...Object.keys(RIBBON_TABS).map((k) => [k, 1])])
    const n = q.ribbon.tabs.length + 1
    const label = n === 1 ? t('My tab') : t('My tab {n}', { n })
    q.ribbon.tabs.push({ id: freshId('my-tab', taken), label, groups: [{ id: 'main', label: t('Buttons'), buttons: [] }] })
  }, t('Added a tab')), undefined, 'ed-btn')
  newTab.disabled = tabs.length >= UI_LIMITS.tabs
  host.appendChild(newTab)
}

/** One menu (right-click or quick-format): pins per scope, a picker to pin
 *  more, and the built-ins to show/hide. */
export function menuSection(host: HTMLElement, p: UiProfile, edit: Edit, which: 'context' | 'minibar'): void {
  const m: UiMenu = p.menus?.[which] ?? {}
  const scopes = which === 'context' ? CONTEXT_SCOPES : MINIBAR_SCOPES
  const items = which === 'context' ? CONTEXT_ITEMS : MINIBAR_ITEMS
  const mutateMenu = (q: UiProfile, fn: (mm: UiMenu) => void) => {
    q.menus ??= {}
    const mm = (q.menus[which] ??= {})
    fn(mm)
    if (mm.add && !Object.keys(mm.add).length) delete mm.add
    if (mm.hide && !mm.hide.length) delete mm.hide
    if (!mm.add && !mm.hide) delete q.menus[which]
    if (!q.menus.context && !q.menus.minibar) delete q.menus
  }
  host.appendChild(el('div', 'ed-cz-sub', t('Pinned')))
  const pinned = Object.entries(m.add ?? {})
  if (!pinned.length) host.appendChild(el('p', 'ed-hint', t('Nothing pinned yet.')))
  for (const [scope, list] of pinned) {
    const r = el('div', 'ed-cz-pinrow')
    r.appendChild(el('span', 'ed-cz-scope', scopeLabel(scope)))
    const chips = el('div', 'ed-cz-chips')
    for (const target of list) {
      chips.appendChild(chip(targetLabel(p, target), () => void edit((q) => mutateMenu(q, (mm) => {
        mm.add![scope] = mm.add![scope].filter((x) => x !== target)
        if (!mm.add![scope].length) delete mm.add![scope]
      }), t('Unpinned {what}', { what: targetLabel(p, target) })), t('Unpin')))
    }
    r.appendChild(chips)
    host.appendChild(r)
  }
  const pin = button(t('+ Pin a command…'), () => {
    const where = el('label', 'ed-cz-field ed-cz-where')
    const scopeSel = el('select', 'ed-cz-select')
    for (const s of scopes) { const o = el('option', undefined, scopeLabel(s)); o.value = s; scopeSel.appendChild(o) }
    where.append(el('span', undefined, t('Show it for')), scopeSel)
    void pickTarget(p, { title: which === 'context' ? t('Pin to the right-click menu') : t('Pin to the quick-format bar'), okLabel: t('Pin'), footer: where }).then((target) => {
      if (!target) return
      const scope = scopeSel.value
      void edit((q) => mutateMenu(q, (mm) => {
        mm.add ??= {}
        mm.add[scope] = [...new Set([...(mm.add[scope] ?? []), target])]
      }), t('Pinned {what} ({where})', { what: targetLabel(p, target), where: scopeLabel(scope) }))
    })
  }, undefined, 'ed-btn ed-cz-addbtn')
  host.appendChild(pin)
  host.appendChild(el('div', 'ed-cz-sub', t('Built-in items (untick to hide)')))
  host.appendChild(visibilityGrid(items, new Set(m.hide ?? []), (id, show) => void edit((q) => mutateMenu(q, (mm) => {
    const hide = new Set(mm.hide ?? [])
    if (show) hide.delete(id); else hide.add(id)
    mm.hide = [...hide]
  }), show ? t('Showed {what} again', { what: t(itemLabel(items, id)) }) : t('Hid {what}', { what: t(itemLabel(items, id)) }))))
}

const itemLabel = (items: readonly CatalogItem[], id: string) => items.find((i) => i.id === id)?.label ?? id

/** Checkboxes, one per built-in item: checked = shown. */
function visibilityGrid(items: readonly CatalogItem[], hidden: ReadonlySet<string>, set: (id: string, show: boolean) => void): HTMLElement {
  const grid = el('div', 'ed-cz-visgrid')
  for (const item of items) {
    const l = el('label', 'ed-cz-check')
    const cb = el('input')
    cb.type = 'checkbox'
    cb.checked = !hidden.has(item.id)
    cb.addEventListener('change', () => set(item.id, cb.checked))
    l.append(cb, document.createTextNode(' ' + t(item.label)))
    grid.appendChild(l)
  }
  return grid
}

/** Toolbar buttons (web top bar + desktop ribbon): show/hide, and a reset
 *  for an order the AI or an import set. */
export function toolbarSection(host: HTMLElement, p: UiProfile, edit: Edit): void {
  const order = p.toolbar?.order ?? []
  if (order.length) {
    const r = el('div', 'ed-cz-row')
    r.append(el('span', 'ed-cz-label', t('Button order')), el('span', 'ed-cz-extra', order.map((id) => t(itemLabel(TOOLBAR_ITEMS, id))).join(', ')))
    r.appendChild(button(t('Reset'), () => void edit((q) => { delete q.toolbar!.order; if (!q.toolbar!.hide) delete q.toolbar }, t('Reset the button order'))))
    host.appendChild(r)
  }
  host.appendChild(visibilityGrid(TOOLBAR_ITEMS, new Set(p.toolbar?.hide ?? []), (id, show) => void edit((q) => {
    q.toolbar ??= {}
    const hide = new Set(q.toolbar.hide ?? [])
    if (show) hide.delete(id); else hide.add(id)
    if (hide.size) q.toolbar.hide = [...hide]; else delete q.toolbar.hide
    if (!q.toolbar.hide && !q.toolbar.order) delete q.toolbar
  }, show ? t('Showed {what} again', { what: t(itemLabel(TOOLBAR_ITEMS, id)) }) : t('Hid {what}', { what: t(itemLabel(TOOLBAR_ITEMS, id)) }))))
}

/** The built-in ribbon groups, per tab: checked = shown (desktop ribbon). */
export function ribbonGroupsSection(host: HTMLElement, p: UiProfile, edit: Edit): void {
  const hidden = new Set(p.ribbon?.hide ?? [])
  for (const [tab, groups] of Object.entries(RIBBON_LAYOUT)) {
    const r = el('div', 'ed-cz-pinrow')
    r.appendChild(el('span', 'ed-cz-scope', t(RIBBON_TABS[tab])))
    const grid = el('div', 'ed-cz-visgrid')
    for (const g of groups) {
      const l = el('label', 'ed-cz-check')
      const cb = el('input')
      cb.type = 'checkbox'
      cb.checked = !hidden.has(g.id)
      cb.addEventListener('change', () => void edit((q) => {
        q.ribbon ??= {}
        const hide = new Set(q.ribbon.hide ?? [])
        if (cb.checked) hide.delete(g.id); else hide.add(g.id)
        if (hide.size) q.ribbon.hide = [...hide]; else delete q.ribbon.hide
      }, cb.checked ? t('Showed a ribbon group again') : t('Hid the ribbon group {what}', { what: t(g.caption) })))
      l.append(cb, document.createTextNode(' ' + t(g.caption)))
      grid.appendChild(l)
    }
    r.appendChild(grid)
    host.appendChild(r)
  }
  if (Object.keys(p.ribbon?.order ?? {}).length) {
    host.appendChild(button(t('Reset the ribbon group order'), () => void edit((q) => { delete q.ribbon!.order }, t('Reset the ribbon group order'))))
  }
}

// ---- quick-format bar placement + side-panel order --------------------------------

/** Where the quick-format bar shows: four picture cards, the current one lit. */
export function quickBarPlaceSection(host: HTMLElement, current: QuickBarPlace, edit: Edit): void {
  const words: Record<QuickBarPlace, [string, string]> = {
    top: [t('At the top'), t('Docked above the slide — always in the same place')],
    floating: [t('Next to the selection'), t('Floats under what you selected — short mouse trips')],
    both: [t('Both'), t('Docked at the top and floating by the selection')],
    off: [t('Off'), t('Only the side panel and the ribbon')],
  }
  const grid = el('div', 'ed-qb-cards')
  grid.setAttribute('role', 'radiogroup')
  for (const place of QUICKBAR_PLACES) {
    const card = el('button', 'ed-qb-card' + (place === current ? ' is-on' : ''))
    card.type = 'button'
    card.setAttribute('role', 'radio')
    card.setAttribute('aria-checked', String(place === current))
    const art = el('span', `ed-qb-art is-${place}`)
    art.append(el('span', 'ed-qb-art-slide'), el('span', 'ed-qb-art-obj'), el('span', 'ed-qb-art-top'), el('span', 'ed-qb-art-float'))
    card.append(art, el('span', 'ed-qb-card-title', words[place][0]), el('span', 'ed-qb-card-sub', words[place][1]))
    card.addEventListener('click', () => void edit((q) => {
      q.toolbar ??= {}
      q.toolbar.quickbar = place
    }, t('Quick-format bar: {where}', { where: words[place][0] })))
    grid.appendChild(card)
  }
  host.appendChild(grid)
}

/** The side panel's sections, per panel, in the order they show: drag a row
 *  (or use its arrows) to move it. Writes the full order (logic.movePanelSection). */
export function panelOrderSection(host: HTMLElement, p: UiProfile, edit: Edit): void {
  const order = p.panel?.order ?? []
  const scopes: Array<[PanelSection['scope'], string]> = [
    ['object', t('One object')], ['selection', t('Several objects')], ['slide', t('The slide')],
  ]
  const cols = el('div', 'ed-po-cols')
  const label = (id: string) => t(PANEL_SECTIONS.find((s) => s.id === id)?.label ?? id)
  const move = (id: string, to: number) => void edit((q) => {
    q.panel = { order: movePanelSection(q.panel?.order ?? [], id, to) }
  }, t('Moved {what} in the side panel', { what: label(id) }))
  for (const [scope, title] of scopes) {
    const col = el('div', 'ed-po-col')
    col.appendChild(el('div', 'ed-po-title', title))
    const list = el('ol', 'ed-po-list')
    const ids = panelScopeOrder(order, scope)
    ids.forEach((id, i) => {
      const li = el('li', 'ed-po-item')
      li.draggable = true
      li.dataset.id = id
      li.append(el('span', 'ed-po-grip', '⠿'), el('span', 'ed-po-label', label(id)))
      const up = button('↑', () => move(id, i - 1), t('Move up'), 'ed-po-btn')
      const down = button('↓', () => move(id, i + 1), t('Move down'), 'ed-po-btn')
      up.disabled = i === 0
      down.disabled = i === ids.length - 1
      li.append(up, down)
      li.addEventListener('dragstart', (ev) => {
        ev.dataTransfer?.setData('text/plain', id)
        li.classList.add('is-dragging')
        list.dataset.dragging = id
      })
      li.addEventListener('dragend', () => { li.classList.remove('is-dragging'); delete list.dataset.dragging })
      li.addEventListener('dragover', (ev) => {
        if (!list.dataset.dragging) return // another column's row
        ev.preventDefault()
        const r = li.getBoundingClientRect()
        li.classList.toggle('drop-before', ev.clientY < r.top + r.height / 2)
        li.classList.toggle('drop-after', ev.clientY >= r.top + r.height / 2)
      })
      li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'))
      li.addEventListener('drop', (ev) => {
        const from = list.dataset.dragging
        li.classList.remove('drop-before', 'drop-after')
        if (!from || from === id) return
        ev.preventDefault()
        const r = li.getBoundingClientRect()
        let to = i + (ev.clientY >= r.top + r.height / 2 ? 1 : 0)
        if (ids.indexOf(from) < to) to--
        move(from, to)
      })
      list.appendChild(li)
    })
    col.appendChild(list)
    cols.appendChild(col)
  }
  host.appendChild(cols)
  if (order.length) {
    host.appendChild(button(t('Reset the side panel order'), () => void edit((q) => { delete q.panel }, t('Reset the side panel order'))))
  }
}

// ---- Import / Export dialogs -----------------------------------------------------

/** A modal with a checkbox per part (all on); resolves the picked parts and,
 *  for an import, the mode. Null = cancelled. */
function partsDialog(opts: {
  title: string; intro: string; parts: UiPart[]; okLabel: string; mode?: boolean
}): Promise<{ parts: UiPart[]; mode: 'merge' | 'replace' } | null> {
  return new Promise((resolve) => {
    const dlg = el('dialog', 'ed-dialog ed-cz-dialog')
    dlg.appendChild(el('h2', undefined, opts.title))
    dlg.appendChild(el('p', undefined, opts.intro))
    const boxes = new Map<UiPart, HTMLInputElement>()
    const list = el('div', 'ed-cz-visgrid')
    for (const part of opts.parts) {
      const l = el('label', 'ed-cz-check')
      const cb = el('input')
      cb.type = 'checkbox'
      cb.checked = true
      boxes.set(part, cb)
      l.append(cb, document.createTextNode(' ' + partLabel(part)))
      list.appendChild(l)
    }
    dlg.appendChild(list)
    let mode: 'merge' | 'replace' = 'merge'
    if (opts.mode) {
      const modes = el('div', 'ed-cz-modes')
      for (const [v, label, hint] of [
        ['merge', t('Add to mine'), t('Keep everything you have; where both set the same thing, yours stays.')],
        ['replace', t('Replace mine'), t('Your customizations are replaced by these (History can bring them back).')],
      ] as const) {
        const l = el('label', 'ed-cz-check')
        const r = el('input')
        r.type = 'radio'
        r.name = 'ed-cz-mode'
        r.checked = v === mode
        r.addEventListener('change', () => { if (r.checked) mode = v })
        const txt = el('span')
        txt.append(el('b', undefined, label), el('span', 'ed-cz-modehint', ' — ' + hint))
        l.append(r, txt)
        modes.appendChild(l)
      }
      dlg.appendChild(modes)
    }
    const actions = el('div', 'ed-dialog-actions')
    const cancel = button(t('Cancel'), () => done(null), undefined, '')
    const ok = button(opts.okLabel, () => done({ parts: opts.parts.filter((x) => boxes.get(x)!.checked), mode }), undefined, 'ed-primary')
    actions.append(cancel, ok)
    dlg.appendChild(actions)
    document.body.appendChild(dlg)
    let settled = false
    function done(v: { parts: UiPart[]; mode: 'merge' | 'replace' } | null) {
      if (settled) return
      settled = true
      dlg.close()
      dlg.remove()
      resolve(v && v.parts.length ? v : null)
    }
    dlg.addEventListener('cancel', () => done(null))
    dlg.showModal()
  })
}

/** Export: pick parts, get a profile holding only them (and what they need). */
export async function chooseExport(p: UiProfile | null): Promise<UiProfile | null> {
  const parts = profileParts(p)
  if (!p || !parts.length) return emptyProfile()
  const r = await partsDialog({
    title: t('Export customizations'),
    intro: t('Choose what to put in the file. Buttons and shortcuts bring the commands, styles and presets they use.'),
    parts, okLabel: t('Export…'),
  })
  return r ? pickParts(p, r.parts) : null
}

/** Import: pick parts and mode; the profile to write, and what the merge
 *  renamed or left as it was. */
export async function chooseImport(current: UiProfile | null, incoming: UiProfile, fileName: string):
  Promise<{ profile: UiProfile; notes: MergeNote[] } | null> {
  const parts = profileParts(incoming)
  if (!parts.length) return { profile: current ?? emptyProfile(), notes: [] }
  const r = await partsDialog({
    title: t('Import {name}', { name: fileName }),
    intro: t('Choose what to take from the file.'),
    parts, okLabel: t('Import'), mode: true,
  })
  if (!r) return null
  const picked = pickParts(incoming, r.parts)
  if (r.mode === 'replace' || !current) return { profile: picked, notes: [] }
  return mergeProfiles(current, picked)
}

/** One line about what an "Add to mine" import renamed or skipped. */
export function mergeNotesText(notes: MergeNote[]): string {
  const kept = notes.filter((n) => n.kind === 'kept-mine').map((n) => n.what)
  const renamed = notes.filter((n) => n.kind === 'renamed').length
  const parts: string[] = []
  if (kept.length) parts.push(t('kept yours for {list}', { list: kept.slice(0, 4).join(', ') + (kept.length > 4 ? '…' : '') }))
  if (renamed) parts.push(renamed === 1 ? t('renamed 1 item that had the same name') : t('renamed {n} items that had the same name', { n: renamed }))
  return parts.join('; ')
}

export { PROFILE_PARTS }
