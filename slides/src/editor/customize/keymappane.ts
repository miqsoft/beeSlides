// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Settings ▸ Keyboard shortcuts: a keymap table in the manner of an IDE's.
// Every command (and every one of the profile's own) is a row with its keys;
// search by name or by pressing the key itself, filter to what you changed,
// and double-click / Enter on a row to record a new key. A key that is taken
// says by whom before it moves. keymap.ts is the model; every change is one
// strictly validated write to the UI profile, like every other pane.

import { t } from '../../i18n'
import { ICONS } from '../../icons'
import { isMacOS } from '../../screens'
import { targetLabel } from './apply'
import { chordFromEvent, clone, displayChord, pruneDangling } from './logic'
import {
  assignKey, buildKeymap, checkAssign, filterRows, keyText, removeKey, resetRow, rowsWithKey,
  type KeyBinding, type KeymapRow,
} from './keymap'
import { emptyProfile, type UiProfile } from './schema'
import type { UiProfileStore } from './store'
import { button, el } from './ui'

export interface KeymapPaneDeps {
  profiles: UiProfileStore
  toast(message: string): void
  /** Prefilled search (Settings' own search box sends it). */
  query?: string
  /** Opens Help ▸ Shortcuts & tips (the fixed keys: arrows, G, C, …). */
  openHelp?: () => void
}

type Filter = 'all' | 'keyed' | 'mine'

/** "Shift+G" for a keydown nobody can bind (a plain letter, ⇧ + letter) —
 *  what the built-in raw accelerators look like, so find-by-key finds G. */
function rawKey(ev: KeyboardEvent): string | null {
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(ev.code)
  if (!m || ev.metaKey || ev.ctrlKey || ev.altKey) return null
  return `${ev.shiftKey ? 'Shift+' : ''}${m[1] ?? m[2]}`
}

export function renderKeymapPane(host: HTMLElement, deps: KeymapPaneDeps): void {
  const { profiles } = deps
  const mac = isMacOS()
  const root = el('div', 'ed-km')
  host.appendChild(root)

  // ---- head ------------------------------------------------------------------
  const head = el('div', 'ed-cz-head')
  head.appendChild(el('div', 'ed-about-h', t('Keyboard shortcuts')))
  head.appendChild(el('p', 'ed-hint', t('Search by name or press a key to see what it does. Double-click a command, or select it and press Enter, to give it a key.')))
  root.appendChild(head)

  const bar = el('div', 'ed-km-bar')
  const searchWrap = el('label', 'ed-km-search')
  searchWrap.innerHTML = ICONS.search
  const search = el('input')
  search.type = 'search'
  search.placeholder = t('Search commands or keys…')
  search.setAttribute('aria-label', t('Search commands or keys…'))
  search.value = deps.query ?? ''
  searchWrap.appendChild(search)
  const byKey = button('', () => setKeyMode(!keyMode), t('Find by key: press a shortcut to see which command has it'), 'ed-btn ed-km-bykey')
  byKey.innerHTML = `${ICONS.keyboard}<span>${t('Find by key')}</span>`
  byKey.setAttribute('aria-pressed', 'false')
  const filterSel = el('select', 'ed-cz-select')
  for (const [v, l] of [['all', t('All commands')], ['keyed', t('With a shortcut')], ['mine', t('Changed by me')]] as const) {
    const o = el('option', undefined, l)
    o.value = v
    filterSel.appendChild(o)
  }
  bar.append(searchWrap, byKey, filterSel)
  root.appendChild(bar)

  const status = el('div', 'ed-km-status')
  status.setAttribute('role', 'status')
  root.appendChild(status)

  const tableWrap = el('div', 'ed-km-wrap')
  const table = el('table', 'ed-km-table')
  table.setAttribute('role', 'grid')
  const thead = el('thead')
  const hr = el('tr')
  hr.append(el('th', 'ed-km-cmd', t('Command')), el('th', 'ed-km-keys', t('Shortcut')), el('th', 'ed-km-act'))
  thead.appendChild(hr)
  const tbody = el('tbody')
  table.append(thead, tbody)
  tableWrap.appendChild(table)
  root.appendChild(tableWrap)

  const foot = el('div', 'ed-km-foot')
  root.appendChild(foot)

  // ---- state -----------------------------------------------------------------
  let rows: KeymapRow[] = []
  let profile: UiProfile | null = null
  let filter: Filter = 'all'
  let keyMode = false
  let keyChord: string | null = null
  let selected: string | null = null
  let recording: string | null = null
  let pending: { chord: string; target: string; message: string } | null = null
  const collapsed = new Set<string>()

  const alive = () => root.isConnected
  const off = profiles.onChange(() => { if (!alive()) off(); else reload() })

  const say = (text: string, kind: 'ok' | 'error' | '' = '') => {
    status.textContent = text
    status.className = `ed-km-status${kind ? ` ed-km-${kind}` : ''}`
  }

  const write = async (mutate: (p: UiProfile) => void, summary: string): Promise<boolean> => {
    const p = clone(profiles.current().profile) ?? emptyProfile()
    mutate(p)
    pruneDangling(p)
    const r = await profiles.write(p, 'settings', summary)
    if (!r.ok) say(r.errors?.[0]?.message ?? t('Could not save the change'), 'error')
    else say(summary, 'ok')
    return r.ok
  }

  const reload = () => {
    profile = profiles.current().profile
    rows = buildKeymap(profile, { targetLabel: (id) => targetLabel(profile ?? emptyProfile(), id), t })
    paint()
  }

  const visibleRows = (): KeymapRow[] => {
    let out = keyMode && keyChord ? rowsWithKey(rows, keyChord) : keyMode ? rows : filterRows(rows, search.value, mac)
    if (filter === 'keyed') out = out.filter((r) => r.keys.length)
    else if (filter === 'mine') out = out.filter((r) => r.modified)
    return out
  }

  const chordName = (c: string) => keyText(c, mac)

  // ---- painting ----------------------------------------------------------------
  const chip = (row: KeymapRow, k: KeyBinding): HTMLElement => {
    const c = el('span', `ed-km-chip ed-km-${k.source}`)
    const kbd = el('kbd', undefined, chordName(k.chord))
    c.appendChild(kbd)
    if (k.off) { c.classList.add('ed-km-struck'); c.title = t('Switched off') }
    else if (k.movedTo) {
      c.classList.add('ed-km-struck')
      c.title = t('Now runs “{what}”', { what: rows.find((r) => r.target === k.movedTo)?.label ?? k.movedTo })
    } else if (k.locked) {
      c.classList.add('ed-km-locked')
      c.title = t('Built in — can’t be changed')
      const lock = el('span', 'ed-km-lock')
      lock.innerHTML = ICONS.lock
      c.appendChild(lock)
    } else if (k.source === 'mine') c.title = t('Your shortcut')
    else c.title = t('Built-in shortcut')
    const removable = k.source === 'mine' || (!k.locked && !k.off && !k.movedTo)
    if (removable) {
      const x = button('×', () => void removeOne(row, k), k.source === 'mine' ? t('Remove this shortcut') : t('Switch this key off'), 'ed-km-x')
      x.setAttribute('aria-label', x.title)
      c.appendChild(x)
    }
    return c
  }

  const rowEl = (row: KeymapRow): HTMLTableRowElement => {
    const tr = el('tr', 'ed-km-row')
    tr.dataset.target = row.target
    tr.tabIndex = -1
    tr.setAttribute('aria-selected', String(selected === row.target))
    if (row.modified) tr.classList.add('ed-km-modified')
    if (selected === row.target) tr.classList.add('selected')
    const cmd = el('td', 'ed-km-cmd')
    cmd.appendChild(el('span', 'ed-km-label', row.label))
    if (row.path) cmd.appendChild(el('span', 'ed-km-path', row.path))
    if (row.kind === 'key') cmd.appendChild(el('span', 'ed-km-path', t('editor key')))
    const keys = el('td', 'ed-km-keys')
    const act = el('td', 'ed-km-act')
    if (recording === row.target) {
      const rec = el('input', 'ed-cz-chord ed-km-rec')
      rec.readOnly = true
      rec.placeholder = t('Press keys…')
      rec.setAttribute('aria-label', t('Press the new shortcut for “{what}”, or Esc to cancel', { what: row.label }))
      rec.addEventListener('keydown', (ev) => onRecordKey(ev, row))
      rec.addEventListener('blur', () => { if (recording === row.target && !pending) { recording = null; paint() } })
      keys.append(...row.keys.map((k) => chip(row, k)), rec)
      act.appendChild(button(t('Cancel'), () => { recording = null; pending = null; paint() }))
      queueMicrotask(() => rec.focus())
    } else {
      keys.append(...row.keys.map((k) => chip(row, k)))
      if (row.kind !== 'key') {
        act.appendChild(button(row.keys.some((k) => !k.locked || k.source === 'mine') || !row.keys.length ? t('Add key') : t('Add another key'),
          () => startRecording(row.target), t('Record a shortcut for this command')))
      }
      if (row.modified) act.appendChild(button(t('Reset'), () => void resetOne(row), t('Back to the built-in keys')))
    }
    tr.append(cmd, keys, act)
    tr.addEventListener('click', (ev) => {
      if ((ev.target as Element).closest('button, input')) return
      select(row.target)
    })
    tr.addEventListener('dblclick', (ev) => {
      if ((ev.target as Element).closest('button, input')) return
      if (row.kind !== 'key') startRecording(row.target)
    })
    return tr
  }

  function paint() {
    const scroll = tableWrap.scrollTop
    tbody.replaceChildren()
    const shown = visibleRows()
    const searching = !!search.value.trim() || (keyMode && !!keyChord)
    let group = ''
    for (const row of shown) {
      if (row.group !== group) {
        group = row.group
        const g = group
        const n = shown.filter((r) => r.group === g).length
        const gr = el('tr', 'ed-km-group')
        const th = el('th')
        th.colSpan = 3
        const open = searching || !collapsed.has(g)
        const tog = button(`${open ? '▾' : '▸'} ${g}`, () => {
          if (collapsed.has(g)) collapsed.delete(g); else collapsed.add(g)
          paint()
        }, undefined, 'ed-km-grouptoggle')
        tog.setAttribute('aria-expanded', String(open))
        th.append(tog, el('span', 'ed-km-count', String(n)))
        gr.appendChild(th)
        tbody.appendChild(gr)
      }
      if (!searching && collapsed.has(group)) continue
      tbody.appendChild(rowEl(row))
      if (pending && pending.target === row.target) {
        const note = el('tr', 'ed-km-note')
        const td = el('td')
        td.colSpan = 3
        td.appendChild(el('span', undefined, pending.message))
        const p = pending
        td.append(
          button(t('Assign anyway'), () => void commitAssign(p.chord, p.target), undefined, 'ed-btn ed-btn-primary'),
          button(t('Cancel'), () => { pending = null; recording = null; paint() }),
        )
        note.appendChild(td)
        tbody.appendChild(note)
      }
    }
    if (!shown.length) {
      const tr = el('tr', 'ed-km-empty')
      const td = el('td')
      td.colSpan = 3
      td.textContent = keyMode && keyChord
        ? t('{key} isn’t used — double-click a command to give it this key.', { key: chordName(keyChord) })
        : t('No command matches.')
      tr.appendChild(td)
      tbody.appendChild(tr)
    }
    tableWrap.scrollTop = scroll
    paintFoot()
  }

  const paintFoot = () => {
    foot.replaceChildren()
    const changed = rows.filter((r) => r.modified).length
    foot.appendChild(el('span', 'ed-km-total', changed
      ? t('{n} commands · {m} changed by you', { n: rows.length, m: changed })
      : t('{n} commands', { n: rows.length })))
    if (deps.openHelp) {
      foot.appendChild(button(t('Fixed keys (arrows, G, C, Delete…)'), () => deps.openHelp!(), t('The keys that always do the same thing: Shortcuts & tips'), 'ed-btn ed-km-link'))
    }
    const resetAll = button(t('Reset all shortcuts'), () => {
      if (!confirm(t('Remove all your shortcuts and turn every built-in key back on?'))) return
      void write((p) => { delete p.shortcuts }, t('Reset all shortcuts'))
    }, undefined, 'ed-btn ed-cz-danger')
    resetAll.disabled = !profile?.shortcuts || !Object.keys(profile.shortcuts).length
    foot.appendChild(resetAll)
  }

  // ---- actions -------------------------------------------------------------------
  function select(target: string | null, focus = true) {
    selected = target
    for (const tr of tbody.querySelectorAll<HTMLTableRowElement>('tr.ed-km-row')) {
      const on = tr.dataset.target === target
      tr.classList.toggle('selected', on)
      tr.setAttribute('aria-selected', String(on))
      if (on && focus) { tr.focus({ preventScroll: true }); tr.scrollIntoView({ block: 'nearest' }) }
    }
  }

  function startRecording(target: string) {
    selected = target
    recording = target
    pending = null
    say('')
    paint()
  }

  function onRecordKey(ev: KeyboardEvent, row: KeymapRow) {
    if (ev.key === 'Tab') return
    ev.preventDefault()
    ev.stopPropagation()
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(ev.key)) return
    if (ev.key === 'Escape') { recording = null; pending = null; say(''); paint(); select(row.target); return }
    const chord = chordFromEvent(ev, mac)
    if (!chord) { say(t('Use ⌘/Ctrl or ⌥/Alt with a letter or digit, or an F-key'), 'error'); return }
    const check = checkAssign(profile, rows, chord, row.target)
    if (!check.ok) {
      say(check.reason === 'locked'
        ? t('{chord} can’t be changed — clipboard, undo, save, text editing and system keys stay as they are.', { chord: chordName(chord) })
        : t('Use ⌘/Ctrl or ⌥/Alt with a letter or digit, or an F-key'), 'error')
      return
    }
    if (check.same) { say(t('{chord} already runs “{what}”', { chord: chordName(chord), what: row.label })); recording = null; paint(); return }
    if (check.takesFrom) {
      pending = {
        chord, target: row.target,
        message: check.takesFrom.kind === 'builtin'
          ? t('{chord} is the built-in key for “{what}”. Give it to “{mine}” instead?', { chord: chordName(chord), what: check.takesFrom.label, mine: row.label })
          : t('{chord} already runs “{what}”. Move it to “{mine}”?', { chord: chordName(chord), what: check.takesFrom.label, mine: row.label }),
      }
      paint()
      return
    }
    void commitAssign(chord, row.target)
  }

  async function commitAssign(chord: string, target: string) {
    const label = rows.find((r) => r.target === target)?.label ?? target
    pending = null
    recording = null
    await write((p) => assignKey(p, chord, target), t('{chord} runs {what}', { chord: displayChord(chord, mac), what: label }))
    select(target)
  }

  async function removeOne(row: KeymapRow, k: KeyBinding) {
    await write((p) => { removeKey(p, k) }, k.source === 'mine'
      ? t('Removed the shortcut {chord}', { chord: chordName(k.chord) })
      : t('Switched {chord} off', { chord: chordName(k.chord) }))
    select(row.target)
  }

  async function resetOne(row: KeymapRow) {
    await write((p) => resetRow(p, row), t('“{what}” has its built-in keys again', { what: row.label }))
    select(row.target)
  }

  // ---- search + find by key --------------------------------------------------------
  function setKeyMode(on: boolean) {
    keyMode = on
    keyChord = null
    byKey.classList.toggle('active', on)
    byKey.setAttribute('aria-pressed', String(on))
    search.readOnly = on
    search.value = ''
    search.placeholder = on ? t('Press a shortcut…') : t('Search commands or keys…')
    search.classList.toggle('ed-km-listening', on)
    search.focus()
    paint()
  }

  search.addEventListener('input', () => { if (!keyMode) paint() })
  search.addEventListener('keydown', (ev) => {
    if (keyMode) {
      if (ev.key === 'Tab') return
      ev.preventDefault()
      ev.stopPropagation()
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(ev.key)) return
      if (ev.key === 'Escape') { setKeyMode(false); return }
      if (ev.key === 'Backspace') { keyChord = null; search.value = ''; paint(); return }
      const chord = chordFromEvent(ev, mac) ?? rawKey(ev) ?? (/^F\d+$/.test(ev.key) ? ev.key : null)
      if (!chord) return
      keyChord = chord
      search.value = chordName(chord)
      paint()
      return
    }
    ev.stopPropagation()
    if (ev.key === 'Escape' && search.value) { ev.preventDefault(); search.value = ''; paint() }
    else if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      const first = visibleRows()[0]
      if (first) select(first.target)
    } else if (ev.key === 'Enter') {
      const first = visibleRows()
      if (first.length === 1) { ev.preventDefault(); startRecording(first[0].target) }
    }
  })
  filterSel.addEventListener('change', () => { filter = filterSel.value as Filter; paint() })

  // ---- keyboard in the table -------------------------------------------------------
  tbody.addEventListener('keydown', (ev) => {
    if ((ev.target as Element).closest('input, button')) return
    const list = [...tbody.querySelectorAll<HTMLTableRowElement>('tr.ed-km-row')].map((tr) => tr.dataset.target!)
    const i = selected ? list.indexOf(selected) : -1
    const row = rows.find((r) => r.target === selected)
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      ev.stopPropagation()
      const next = ev.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : i - 1
      if (next < 0) { search.focus(); return }
      select(list[next])
    } else if (ev.key === 'Enter' && row && row.kind !== 'key') {
      ev.preventDefault()
      ev.stopPropagation()
      startRecording(row.target)
    } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && row) {
      ev.preventDefault()
      ev.stopPropagation()
      const removable = row.keys.filter((k) => k.source === 'mine' || (!k.locked && !k.off && !k.movedTo))
      if (!removable.length) { say(t('“{what}” has no key you can remove', { what: row.label })); return }
      void write((p) => { for (const k of removable) removeKey(p, k) }, t('Removed the keys of “{what}”', { what: row.label }))
    } else if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      // typing in the list searches, as in a file manager
      if (keyMode) setKeyMode(false)
      search.focus()
    }
  })

  reload()
  if (deps.query) queueMicrotask(() => search.focus())
}
