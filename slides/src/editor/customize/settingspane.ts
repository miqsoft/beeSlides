// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Settings ▸ Customize. Settings is a full-screen view like every other
// category, so the slide is not on screen here: changes apply live behind it
// and show on Close. "Save style as…" works on whatever was selected when
// Settings was opened.
//
// The pane is split into tabs — Buttons & toolbar, Menus, Styles & presets,
// Look, Backup & history — so each page is short and about one thing;
// keyboard shortcuts have their own Settings category (keymappane.ts).
//
// Every edit here is a strictly validated write through UiProfileStore
// (Settings is just one more writer, like Import and the AI). Labels the
// person typed are shown with textContent and never translated.

import type { Store } from '../../store'
import { t } from '../../i18n'
import { lsGet, lsSet } from '../../../../kernel/src/storage.ts'
import { askText } from '../comments'
import { PATCH_KEYS, PRESET_TYPES, TOKENS } from './catalog'
import { clone, freshId, pruneDangling, styleFromElement, summarizeProfile } from './logic'
import { actionLabel, type UiCustomizer } from './apply'
import { emptyProfile, UI_PROFILE_EXT, type UiIssue, type UiProfile, type UiTab } from './schema'
import type { UiRevision, UiSource } from './store'
import { validateProfile } from './validate'
import { legacyQuickBarPlace } from '../minitoolbar'
import { chooseExport, chooseImport, menuSection, mergeNotesText, panelOrderSection, quickBarPlaceSection, ribbonGroupsSection, tabsSection, toolbarSection } from './settingsparts'
import { button, el } from './ui'

export type CustomizeTab = 'buttons' | 'menus' | 'styles' | 'look' | 'backup'
export const CUSTOMIZE_TABS: readonly CustomizeTab[] = ['buttons', 'menus', 'styles', 'look', 'backup']

export const customizeTabLabel = (tab: CustomizeTab): string => ({
  buttons: t('Buttons & toolbar'), menus: t('Menus'), styles: t('Styles & presets'), look: t('Look'), backup: t('Backup & history'),
} as Record<CustomizeTab, string>)[tab]

export interface CustomizePaneDeps {
  customizer: UiCustomizer
  store: Store
  toast(message: string): void
  /** Open on this tab (else the last one used). */
  tab?: CustomizeTab
  /** Settings ▸ Keyboard shortcuts. */
  openShortcuts?: () => void
  /** The AI chat sidebar is available: offer to open it. */
  openChat?: () => void
}

const TAB_KEY = 'slidomingo-customize-tab'

const sourceLabel = (s: UiSource): string => ({
  settings: t('Settings'), import: t('Import'), chat: t('AI chat'), agent: t('Claude'), revert: t('Revert'), reset: t('Reset'),
} as Record<UiSource, string>)[s] ?? s

/** The tab Settings' own "Save as…" buttons put their buttons on. */
function ensureMineTab(p: UiProfile, group: 'styles' | 'presets'): UiTab['groups'][number] {
  p.ribbon ??= {}
  p.ribbon.tabs ??= []
  let tab = p.ribbon.tabs.find((x) => x.id === 'mine')
  if (!tab) { tab = { id: 'mine', label: t('My tab'), groups: [] }; p.ribbon.tabs.push(tab) }
  let g = tab.groups.find((x) => x.id === group)
  if (!g) { g = { id: group, label: group === 'styles' ? t('Styles') : t('Presets'), buttons: [] }; tab.groups.push(g) }
  return g
}

export function summaryText(p: UiProfile | null): string {
  const s = summarizeProfile(p)
  const parts: string[] = []
  if (s.tabs) parts.push(s.tabs === 1 ? t('1 tab') : t('{n} tabs', { n: s.tabs }))
  if (s.buttons) parts.push(s.buttons === 1 ? t('1 button') : t('{n} buttons', { n: s.buttons }))
  if (s.shortcuts) parts.push(s.shortcuts === 1 ? t('1 shortcut') : t('{n} shortcuts', { n: s.shortcuts }))
  if (s.styles) parts.push(s.styles === 1 ? t('1 style') : t('{n} styles', { n: s.styles }))
  if (s.presets) parts.push(s.presets === 1 ? t('1 preset') : t('{n} presets', { n: s.presets }))
  if (s.hidden) parts.push(s.hidden === 1 ? t('1 hidden group') : t('{n} hidden groups', { n: s.hidden }))
  if (s.pinned) parts.push(s.pinned === 1 ? t('1 pinned menu item') : t('{n} pinned menu items', { n: s.pinned }))
  if (s.hiddenItems) parts.push(s.hiddenItems === 1 ? t('1 hidden item') : t('{n} hidden items', { n: s.hiddenItems }))
  if (s.density === 'compact') parts.push(t('compact'))
  if (s.tokens) parts.push(t('custom colours'))
  if (s.defaults) parts.push(t('default styles'))
  return parts.length ? parts.join(' · ') : t('Nothing customized yet.')
}

export function renderCustomizePane(host: HTMLElement, deps: CustomizePaneDeps): void {
  const { customizer, store } = deps
  const profiles = customizer.profiles
  const root = el('div', 'ed-cz')
  host.appendChild(root)
  const issues = el('div', 'ed-cz-issues')
  let lastIssues: { errors: UiIssue[]; warnings: UiIssue[] } = { errors: [], warnings: [] }
  const saved = lsGet(TAB_KEY) as CustomizeTab | null
  let tab: CustomizeTab = deps.tab ?? (saved && CUSTOMIZE_TABS.includes(saved) ? saved : 'buttons')

  const alive = () => root.isConnected
  const offProfile = profiles.onChange(() => { if (!alive()) offProfile(); else render() })

  const current = (): UiProfile => clone(profiles.current().profile) ?? emptyProfile()

  /** One validated write from Settings; errors and warnings show in the pane. */
  const edit = async (mutate: (p: UiProfile) => void, summary: string, source: UiSource = 'settings') => {
    const p = current()
    mutate(p)
    pruneDangling(p)
    const r = await profiles.write(p, source, summary)
    // an empty group is where you are about to add buttons — not worth a warning
    const warnings = (r.warnings ?? []).filter((w) => w.code !== 'empty-group' && w.code !== 'replaces-builtin')
    lastIssues = { errors: r.errors ?? (r.ok ? [] : [{ path: '', code: r.error ?? 'error', message: t('Could not save the change') }]), warnings }
    renderIssues()
    return r.ok
  }

  const renderIssues = () => {
    issues.replaceChildren()
    for (const [list, cls] of [[lastIssues.errors, 'ed-cz-error'], [lastIssues.warnings, 'ed-cz-warning']] as const) {
      for (const i of list.slice(0, 6)) issues.appendChild(el('div', cls, i.message))
    }
  }

  const section = (parent: HTMLElement, title: string, hint?: string): HTMLElement => {
    const s = el('section', 'ed-cz-section')
    s.appendChild(el('h3', 'ed-cz-h', title))
    if (hint) s.appendChild(el('p', 'ed-hint', hint))
    parent.appendChild(s)
    return s
  }

  const row = (parent: HTMLElement, label: string, extra: string | null, actions: HTMLElement[]): HTMLElement => {
    const r = el('div', 'ed-cz-row')
    r.appendChild(el('span', 'ed-cz-label', label))
    if (extra) r.appendChild(el('span', 'ed-cz-extra', extra))
    const a = el('span', 'ed-cz-actions')
    a.append(...actions)
    r.appendChild(a)
    parent.appendChild(r)
    return r
  }

  const saveStyle = async () => {
    const [sel] = store.selectedElements
    if (!sel) return
    const patch = styleFromElement(sel, PATCH_KEYS)
    if (!Object.keys(patch).length) { deps.toast(t('That element has no look to save')); return }
    const name = await askText({ title: t('Name this style'), initial: t('My style'), okLabel: t('Save') })
    if (!name) return
    const label = name.slice(0, 40)
    const ok = await edit((p) => {
      const id = freshId(label, p.styles)
      p.styles = { ...p.styles, [id]: { label, patch } }
      const aid = freshId(`style-${id}`, p.actions)
      p.actions = { ...p.actions, [aid]: { kind: 'style', style: id } }
      const g = ensureMineTab(p, 'styles')
      if (g.buttons.length < 12) g.buttons.push({ target: aid, icon: 'paintbrush' })
    }, t('Saved the style “{name}”', { name: label }))
    if (ok) deps.toast(t('Saved “{name}” — it’s on your own tab and in View ▸ My commands', { name: label }))
  }

  const savePreset = async () => {
    const els = store.selectedElements.filter((e) => PRESET_TYPES.includes(e.type))
    if (!els.length) return
    const name = await askText({ title: t('Name this preset'), initial: t('My preset'), okLabel: t('Save') })
    if (!name) return
    const label = name.slice(0, 40)
    // keep the group's own layout, anchored at its top-left
    const x0 = Math.min(...els.map((e) => e.x)), y0 = Math.min(...els.map((e) => e.y))
    const elements = clone(els).map((e) => ({ ...e, x: e.x - x0 + 80, y: e.y - y0 + 80 }))
    const ok = await edit((p) => {
      const id = freshId(label, p.presets)
      p.presets = { ...p.presets, [id]: { label, elements } }
      const aid = freshId(`insert-${id}`, p.actions)
      p.actions = { ...p.actions, [aid]: { kind: 'insert', preset: id } }
      const g = ensureMineTab(p, 'presets')
      if (g.buttons.length < 12) g.buttons.push({ target: aid, icon: 'objects' })
    }, t('Saved the preset “{name}”', { name: label }))
    if (ok) deps.toast(t('Saved “{name}” — it’s on your own tab and in View ▸ My commands', { name: label }))
  }

  // ---- the tabs ------------------------------------------------------------------

  const pageButtons = (page: HTMLElement, p: UiProfile) => {
    tabsSection(section(page, t('My buttons'), t('Your own tabs in the ribbon (in a browser: the “My tools” menu in the top bar). Add any command, or your styles and presets.')), p, edit)
    toolbarSection(section(page, t('Toolbar buttons'), t('Untick a button to hide it from the toolbar and the ribbon.')), p, edit)
    ribbonGroupsSection(section(page, t('Ribbon groups'), t('Untick a group to hide it from its ribbon tab.')), p, edit)
  }

  const pageMenus = (page: HTMLElement, p: UiProfile) => {
    menuSection(section(page, t('Right-click menu'), t('Pin your commands, styles and presets to the menu you get by right-clicking — for one kind of element or everywhere — and hide built-in items you never use.')), p, edit, 'context')
    quickBarPlaceSection(section(page, t('Where the quick-format bar shows'), t('The short menu of everyday formatting for what you select. Its buttons are the same wherever it shows.')),
      p.toolbar?.quickbar ?? legacyQuickBarPlace(), edit)
    menuSection(section(page, t('Quick-format bar'), t('Add your own buttons to it and hide the ones you don’t need — per kind of object, or for several at once.')), p, edit, 'minibar')
    panelOrderSection(section(page, t('Side panel order'), t('The order of the sections in the side panel. Drag a row, or use its arrows. The top part with the most-used settings always stays first.')), p, edit)
  }

  const pageStyles = (page: HTMLElement, p: UiProfile) => {
    const from = section(page, t('From the selection'))
    const els = store.selectedElements
    const styleB = button(t('Save style as…'), () => void saveStyle(), t('Remember how the selected element looks, as a style you can apply with one click'), 'ed-btn ed-btn-primary')
    const presetB = button(t('Save as preset…'), () => void savePreset(), t('Remember the selected elements, to insert them again with one click'))
    styleB.disabled = els.length !== 1
    presetB.disabled = !els.length || !els.every((e) => PRESET_TYPES.includes(e.type))
    const btns = el('div', 'ed-cz-buttons')
    btns.append(styleB, presetB)
    from.appendChild(btns)
    if (!els.length) from.appendChild(el('p', 'ed-hint', t('To save a look, or the elements themselves: close Settings, select an element on the slide, then reopen Settings.')))
    else if (presetB.disabled) from.appendChild(el('p', 'ed-hint', t('Pictures, media and embeds can’t be part of a preset.')))

    const styles = Object.entries(p.styles ?? {})
    const ss = section(page, t('My styles'))
    if (!styles.length) ss.appendChild(el('p', 'ed-hint', t('No styles yet.')))
    for (const [id, st] of styles) {
      const actionId = Object.entries(p.actions ?? {}).find(([, a]) => a.kind === 'style' && a.style === id)?.[0]
      const k = Object.keys(st.patch).length
      row(ss, st.label, k === 1 ? t('1 property') : t('{n} properties', { n: k }), [
        button(t('Apply'), () => { if (actionId) customizer.runAction(actionId); else customizer.runSteps([{ style: id }]) }, t('Apply to the selection')),
        button(t('Delete'), () => void edit((q) => { delete q.styles![id] }, t('Deleted the style “{name}”', { name: st.label }))),
      ])
    }
    const presets = Object.entries(p.presets ?? {})
    const ps = section(page, t('Presets'))
    if (!presets.length) ps.appendChild(el('p', 'ed-hint', t('No presets yet.')))
    for (const [id, pr] of presets) {
      row(ps, pr.label, pr.elements.length === 1 ? t('1 element') : t('{n} elements', { n: pr.elements.length }), [
        button(t('Insert'), () => customizer.runSteps([{ insert: id }])),
        button(t('Delete'), () => void edit((q) => { delete q.presets![id] }, t('Deleted the preset “{name}”', { name: pr.label }))),
      ])
    }
    const actions = Object.entries(p.actions ?? {}).filter(([, a]) => a.kind === 'command' || a.kind === 'sequence')
    if (actions.length) {
      const s = section(page, t('My commands'), t('Commands the AI or an import made — several steps under one name.'))
      for (const [id, a] of actions) {
        row(s, actionLabel(p, id, a), customizer.chordFor(id), [
          button(t('Run'), () => customizer.runAction(id)),
          button(t('Delete'), () => void edit((q) => { delete q.actions![id] }, t('Deleted the command “{name}”', { name: actionLabel(p, id, a) }))),
        ])
      }
    }
  }

  const pageLook = (page: HTMLElement, p: UiProfile) => {
    const look = section(page, t('Look'), t('How the editor’s own chrome looks — never your slides.'))
    const dens = el('label', 'ed-cz-field')
    const sel = el('select', 'ed-cz-select')
    for (const [v, l] of [['comfortable', t('Comfortable')], ['compact', t('Compact')]] as const) {
      const o = el('option', undefined, l)
      o.value = v
      if ((p.chrome?.density ?? 'comfortable') === v) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => void edit((q) => {
      q.chrome ??= {}
      if (sel.value === 'compact') q.chrome.density = 'compact'; else delete q.chrome.density
    }, sel.value === 'compact' ? t('Compact chrome') : t('Comfortable chrome')))
    dens.append(el('span', undefined, t('Density')), sel)
    const acc = el('label', 'ed-cz-field')
    const color = el('input')
    color.type = 'color'
    color.value = (p.chrome?.light?.accent ?? TOKENS.accent.light).toLowerCase()
    color.addEventListener('change', () => void edit((q) => {
      q.chrome ??= {}
      q.chrome.light = { ...q.chrome.light, accent: color.value }
      q.chrome.dark = { ...q.chrome.dark, accent: color.value }
    }, t('Accent colour {c}', { c: color.value })))
    acc.append(el('span', undefined, t('Accent colour')), color)
    const resetLook = button(t('Reset look'), () => void edit((q) => { delete q.chrome }, t('Reset the look')))
    resetLook.disabled = !p.chrome
    const lookRow = el('div', 'ed-cz-buttons')
    lookRow.append(dens, acc, resetLook)
    look.appendChild(lookRow)
  }

  const pageBackup = (page: HTMLElement) => {
    const files = section(page, t('Share or start over'), t('Save your customizations to a file to back them up or use them on another computer.'))
    const fileRow = el('div', 'ed-cz-buttons')
    fileRow.append(
      button(t('Import…'), () => importProfile(), t('Load customizations from a {ext} file', { ext: UI_PROFILE_EXT })),
      button(t('Export…'), () => void exportProfile(), t('Save these customizations as a {ext} file — to back them up or share them', { ext: UI_PROFILE_EXT })),
      button(t('Reset everything'), () => {
        if (!confirm(t('Remove all your customizations? You can still go back from History.'))) return
        void profiles.reset()
      }, undefined, 'ed-btn ed-cz-danger'),
    )
    files.appendChild(fileRow)

    const hist = section(page, t('History'), t('Every change — yours, an import’s or the AI’s — can be undone from here.'))
    const histList = el('div', 'ed-cz-history')
    hist.appendChild(histList)
    void profiles.history().then((revs: UiRevision[]) => {
      if (!alive()) return
      if (!revs.length) { histList.appendChild(el('p', 'ed-hint', t('No changes yet.'))); return }
      const { rev: now } = profiles.current()
      for (const r of revs.slice(0, 20)) {
        const when = new Date(r.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
        const b = button(t('Revert'), () => void profiles.revert(r.rev).then((res) => {
          if (!res.ok) deps.toast(res.error === 'too-old' ? t('That change is too old to go back to') : t('Could not go back'))
        }), t('Go back to how it was right after this change'))
        b.disabled = r.rev === now
        row(histList, r.summary || sourceLabel(r.source), `${sourceLabel(r.source)} · ${when}`, [b])
      }
    })
  }

  function render() {
    const scroller = root.closest('.ed-settings-content')
    const scroll = scroller?.scrollTop ?? 0
    root.replaceChildren()
    const { profile } = profiles.current()
    const p = profile ?? emptyProfile()

    const head = el('div', 'ed-cz-head')
    head.appendChild(el('div', 'ed-about-h', t('Customize the editor')))
    head.appendChild(el('p', 'ed-hint', t('Your own tabs, buttons, menus, styles and look — for this app on this computer. Documents never carry them.')))
    root.appendChild(head)

    if (profiles.disabled()) {
      root.appendChild(el('p', 'ed-cz-error', t('Customizations are switched off for this run (SLIDOMINGO_NO_UI_PROFILE / ?no-ui-profile).')))
      return
    }

    const status = el('div', 'ed-cz-status')
    const toggle = el('label', 'ed-cz-toggle')
    const cb = el('input')
    cb.type = 'checkbox'
    cb.checked = p.enabled !== false
    cb.addEventListener('change', () => void edit((q) => { if (cb.checked) delete q.enabled; else q.enabled = false },
      cb.checked ? t('Customizations on') : t('Customizations off')))
    toggle.append(cb, document.createTextNode(' ' + t('Use my customizations')))
    status.append(toggle, el('span', 'ed-cz-summary', summaryText(profile)))
    root.appendChild(status)

    const links = el('div', 'ed-cz-links')
    if (deps.openShortcuts) links.appendChild(button(t('Keyboard shortcuts →'), () => deps.openShortcuts!(), t('Shortcuts have their own page, with search'), 'ed-btn ed-cz-link'))
    if (deps.openChat) links.appendChild(button(t('✦ Ask AI to do it'), () => deps.openChat!(), t('Describe what you want; the AI changes the editor for you'), 'ed-btn ed-cz-link'))
    if (links.childElementCount) root.appendChild(links)

    root.appendChild(issues)

    const tabs = el('div', 'ed-cz-tabs')
    tabs.setAttribute('role', 'tablist')
    const page = el('div', 'ed-cz-page')
    page.setAttribute('role', 'tabpanel')
    for (const id of CUSTOMIZE_TABS) {
      const b = button(customizeTabLabel(id), () => {
        tab = id
        lsSet(TAB_KEY, id)
        lastIssues = { errors: [], warnings: [] }
        render()
      }, undefined, 'ed-cz-tab')
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(tab === id))
      if (tab === id) b.classList.add('active')
      tabs.appendChild(b)
    }
    root.append(tabs, page)
    if (tab === 'buttons') pageButtons(page, p)
    else if (tab === 'menus') pageMenus(page, p)
    else if (tab === 'styles') pageStyles(page, p)
    else if (tab === 'look') pageLook(page, p)
    else pageBackup(page)
    if (scroller) scroller.scrollTop = scroll
  }

  const importProfile = () => {
    const input = el('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return
      let parsed: unknown
      try { parsed = JSON.parse(await file.text()) } catch {
        lastIssues = { errors: [{ path: '', code: 'not-json', message: t('That file is not a customization file.') }], warnings: [] }
        renderIssues()
        return
      }
      const v = validateProfile(parsed, 'strict')
      if (!v.profile) { lastIssues = { errors: v.errors, warnings: v.warnings }; renderIssues(); return }
      const picked = await chooseImport(profiles.current().profile, v.profile, file.name)
      if (!picked) return
      const r = await profiles.write(picked.profile, 'import', t('Imported {name}', { name: file.name }))
      lastIssues = { errors: r.errors ?? [], warnings: r.warnings ?? [] }
      renderIssues()
      const notes = mergeNotesText(picked.notes)
      if (r.ok) deps.toast(notes ? `${t('Imported {name}', { name: file.name })} — ${notes}` : t('Imported {name}', { name: file.name }))
    })
    input.click()
  }

  const exportProfile = async () => {
    const p = await chooseExport(profiles.current().profile)
    if (!p) return
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' })
    const a = el('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(p.name ?? 'my-editor').replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'my-editor'}${UI_PROFILE_EXT}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }

  render()
}
