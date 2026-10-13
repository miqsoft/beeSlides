// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Settings ▸ Keyboard shortcuts, the model: one row per thing a key can run
// (every menu command, every action of the profile, and the editor's own
// keys that no command owns), each with its built-in key(s) and the
// profile's. keymappane.ts draws it; this file only answers "who has this
// key", "what happens if I give it to that" and makes the profile edits.
//
// Pure: no DOM, `.ts` import specifiers (the node rig imports it). Labels
// are English i18n keys unless a function to translate them is passed.

import { COMMANDS } from '../menumodel.ts'
import { OVERRIDABLE_CHORDS, commandCatalog, isBuiltinChord, isLockedChord } from './catalog.ts'
import { displayChord, normalizeChord } from './logic.ts'
import { SHORTCUT_NONE, type UiProfile } from './schema.ts'

/** Built-in keys the editor handles (editor.ts wireKeyboard) for a command
 *  whose menu entry shows no accelerator. */
const EXTRA_BUILTIN: Record<string, string[]> = {
  'view.sorter': ['Mod+1'],
  'view.outline': ['Mod+2'],
  'play.slideshow': ['Shift+F5'],
}

export interface KeyBinding {
  /** Normalized chord ("Mod+Shift+B") — or, for a built-in key a profile can
   *  never name (G, ⌘,), the raw accelerator. */
  chord: string
  source: 'builtin' | 'mine'
  /** A built-in key the profile switched off ("none")… */
  off?: boolean
  /** …or gave to something else (that target). */
  movedTo?: string
  /** A built-in key nobody can change (clipboard, undo, save, G…). */
  locked?: boolean
}

export interface KeymapRow {
  /** A command id, an action id, or `key:<chord>` for an editor key no
   *  command owns (it can be switched off, nothing can be bound to it). */
  target: string
  kind: 'command' | 'action' | 'key'
  label: string
  /** Top-level menu ("Edit"), "My commands" or "Editor keys". */
  group: string
  /** The rest of the menu path ("Table"), if any. */
  path: string
  keys: KeyBinding[]
  /** Differs from the built-in setup. */
  modified: boolean
}

export const GROUP_MINE = 'My commands'
export const GROUP_KEYS = 'Editor keys'

export interface KeymapOpts {
  /** Display label of a profile action / any target. */
  targetLabel: (target: string) => string
  /** Translate an English label (default: as is). */
  t?: (s: string) => string
}

/** Every row, in menu-bar order: my commands first, editor keys last. */
export function buildKeymap(p: UiProfile | null, opts: KeymapOpts): KeymapRow[] {
  const tr = opts.t ?? ((s: string) => s)
  const shortcuts = p?.shortcuts ?? {}
  const rows: KeymapRow[] = []
  const builtinKey = (raw: string): KeyBinding => {
    const norm = normalizeChord(raw)
    if (!norm) return { chord: raw, source: 'builtin', locked: true }
    const b: KeyBinding = { chord: norm, source: 'builtin' }
    if (isLockedChord(norm) || !isBuiltinChord(norm)) b.locked = true
    const now = shortcuts[norm]
    if (now === SHORTCUT_NONE) b.off = true
    else if (now) b.movedTo = now
    return b
  }
  const mine = (target: string): KeyBinding[] => Object.entries(shortcuts)
    .filter(([, t]) => t === target)
    .map(([chord]) => ({ chord, source: 'mine' as const }))
  const finish = (r: Omit<KeymapRow, 'modified'>): KeymapRow => {
    const row = r as KeymapRow
    row.modified = row.keys.some((k) => k.source === 'mine' || k.off || k.movedTo)
    return row
  }

  for (const [id, a] of Object.entries(p?.actions ?? {})) {
    void a
    rows.push(finish({ target: id, kind: 'action', label: opts.targetLabel(id), group: tr(GROUP_MINE), path: '', keys: mine(id) }))
  }
  const claimed = new Set<string>()
  for (const c of commandCatalog()) {
    const [top, ...rest] = c.menu.split(' ▸ ')
    const raws = [...(COMMANDS[c.id]?.accel ? [COMMANDS[c.id].accel!] : []), ...(EXTRA_BUILTIN[c.id] ?? [])]
    const builtin = raws.map(builtinKey)
    for (const b of builtin) claimed.add(b.chord)
    rows.push(finish({
      target: c.id, kind: 'command', label: tr(c.label), group: tr(top), path: rest.map(tr).join(' ▸ '),
      keys: [...builtin, ...mine(c.id)],
    }))
  }
  for (const [chord, label] of Object.entries(OVERRIDABLE_CHORDS)) {
    if (claimed.has(chord)) continue
    rows.push(finish({ target: `key:${chord}`, kind: 'key', label: tr(label), group: tr(GROUP_KEYS), path: '', keys: [builtinKey(chord)] }))
  }
  return rows
}

/** Who runs `chord` today: the profile's target, else the built-in owner. */
export function keyOwner(p: UiProfile | null, rows: readonly KeymapRow[], chord: string):
  | { kind: 'mine'; target: string; label: string }
  | { kind: 'builtin'; target: string; label: string }
  | { kind: 'off'; target: string; label: string }
  | null {
  const own = p?.shortcuts?.[chord]
  const builtinRow = rows.find((r) => r.keys.some((k) => k.source === 'builtin' && k.chord === chord))
  if (own && own !== SHORTCUT_NONE) {
    const r = rows.find((x) => x.target === own)
    return { kind: 'mine', target: own, label: r?.label ?? own }
  }
  if (builtinRow) return { kind: own === SHORTCUT_NONE ? 'off' : 'builtin', target: builtinRow.target, label: builtinRow.label }
  return null
}

export type AssignCheck =
  | { ok: false; reason: 'locked' | 'not-a-target' | 'invalid' }
  | { ok: true; same: boolean; takesFrom: { kind: 'mine' | 'builtin'; target: string; label: string } | null }

/** What giving `chord` to `target` would do. */
export function checkAssign(p: UiProfile | null, rows: readonly KeymapRow[], chord: string, target: string): AssignCheck {
  if (!normalizeChord(chord)) return { ok: false, reason: 'invalid' }
  if (target.startsWith('key:')) return { ok: false, reason: 'not-a-target' }
  if (isLockedChord(chord)) return { ok: false, reason: 'locked' }
  const owner = keyOwner(p, rows, chord)
  if (!owner || owner.kind === 'off') return { ok: true, same: false, takesFrom: null }
  if (owner.target === target) return { ok: true, same: true, takesFrom: null }
  return { ok: true, same: false, takesFrom: { kind: owner.kind, target: owner.target, label: owner.label } }
}

/** Gives `chord` to `target` (mutates `p`). */
export function assignKey(p: UiProfile, chord: string, target: string): void {
  p.shortcuts = { ...p.shortcuts, [chord]: target }
  // binding a command back to its own built-in key = the built-in again
  const own = Object.entries(COMMANDS).find(([, m]) => m.accel && normalizeChord(m.accel) === chord)?.[0]
    ?? Object.entries(EXTRA_BUILTIN).find(([, ks]) => ks.includes(chord))?.[0]
  if (own === target) delete p.shortcuts[chord]
  if (!Object.keys(p.shortcuts).length) delete p.shortcuts
}

/** Removes one key from a row (mutates `p`): the profile's key goes, a
 *  built-in key is switched off. False when it can't be removed. */
export function removeKey(p: UiProfile, k: KeyBinding): boolean {
  if (k.source === 'mine') {
    if (p.shortcuts) delete p.shortcuts[k.chord]
  } else {
    if (k.locked || k.off) return false
    p.shortcuts = { ...p.shortcuts, [k.chord]: SHORTCUT_NONE }
  }
  if (p.shortcuts && !Object.keys(p.shortcuts).length) delete p.shortcuts
  return true
}

/** Puts a row back to its built-in keys (mutates `p`). */
export function resetRow(p: UiProfile, row: KeymapRow): void {
  if (!p.shortcuts) return
  for (const k of row.keys) {
    if (k.source === 'mine' || k.off || k.movedTo) delete p.shortcuts[k.chord]
  }
  if (!Object.keys(p.shortcuts).length) delete p.shortcuts
}

/** How a binding is shown: ⌘⇧B / Ctrl+Shift+B, built-in raw accelerators too. */
export function keyText(chord: string, mac: boolean): string {
  const norm = normalizeChord(chord)
  if (norm) return displayChord(norm, mac)
  const parts = chord.split('+')
  const key = parts.pop()!
  const mods = parts.map((m) => (/^(cmdorctrl|commandorcontrol|cmd|ctrl|mod)$/i.test(m) ? 'Mod' : /^(alt|option)$/i.test(m) ? 'Alt' : m))
  const order = ['Mod', 'Alt', 'Shift']
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  if (mac) return mods.map((m) => ({ Mod: '⌘', Alt: '⌥', Shift: '⇧' } as Record<string, string>)[m] ?? m).join('') + key
  return [...mods.map((m) => (m === 'Mod' ? 'Ctrl' : m)), key].join('+')
}

/** Rows a search matches: words of the label, group, path and id, or the
 *  key as shown ("⌘G", "ctrl+g", "ctrl g"). */
export function filterRows(rows: readonly KeymapRow[], query: string, mac: boolean): KeymapRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...rows]
  const words = q.split(/\s+/)
  const squash = (s: string) => s.toLowerCase().replace(/[\s+]/g, '')
  const qKey = squash(q)
  return rows.filter((r) => {
    const keys = r.keys.flatMap((k) => [squash(keyText(k.chord, mac)), squash(keyText(k.chord, !mac)), squash(k.chord)])
    if (keys.some((k) => k === qKey)) return true
    const hay = `${r.label} ${r.group} ${r.path} ${r.target}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** Rows that have `chord` (built-in or mine), for "find by key". */
export function rowsWithKey(rows: readonly KeymapRow[], chord: string): KeymapRow[] {
  return rows.filter((r) => r.keys.some((k) => k.chord === chord))
}
