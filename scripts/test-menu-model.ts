#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Menu catalog rig (slides/src/editor/menumodel.ts) — runs without a DOM.
//
//   node --experimental-strip-types scripts/test-menu-model.ts
//
// menumodel.ts has no imports, so plain Node runs it. Guards the invariants the
// native menu relies on: every id in the tree has metadata and vice versa,
// each accelerator has one owner, visibility/disabled state is honoured, and
// the serializer never leaves doubled or dangling separators.
import {
  COMMANDS, MENU_MODEL, MAIN_LABELS, SHAPE_COUNT, TRANSITION_KINDS, menuCommandIds, serializeMenuModel,
  type ExpandItem, type WireItem,
} from '../slides/src/editor/menumodel.ts'

let checks = 0, failures = 0
function ok(cond: boolean, msg: string) { checks++; if (!cond) failures++; console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`) }

const ids = menuCommandIds()
ok(ids.every((id) => id in COMMANDS), 'every command id in the menu tree has metadata')
const orphan = Object.keys(COMMANDS).filter((id) => !ids.includes(id))
ok(orphan.length === 0, `every COMMANDS entry is placed in a menu (orphans: ${orphan.join(', ') || 'none'})`)
ok(new Set(ids).size === ids.length, 'no command appears twice in the tree')

// accelerators: one owner. Main owns these (real accelerators, menu.ts SLOTS).
const MAIN_ACCELS = ['CmdOrCtrl+N', 'Alt+CmdOrCtrl+N', 'CmdOrCtrl+O', 'Shift+CmdOrCtrl+O', 'Shift+CmdOrCtrl+H', 'CmdOrCtrl+`', 'CmdOrCtrl+Shift+V']
const norm = (a: string) => a.split('+').sort().join('+')
const rendererAccels = Object.values(COMMANDS).flatMap((c) => (c.accel ? [norm(c.accel)] : []))
ok(new Set(rendererAccels).size === rendererAccels.length, 'renderer accelerators are unique')
ok(!rendererAccels.some((a) => MAIN_ACCELS.map(norm).includes(a)), 'no accelerator is claimed by both the renderer and main')

const tr = (s: string) => `«${s}»`
const walk = (items: WireItem[], f: (it: WireItem) => void) => { for (const it of items) { f(it); if ('submenu' in it) walk(it.submenu, f) } }
const noSepBugs = (items: WireItem[]): boolean => {
  if (!items.length) return true
  if ('type' in items[0] || 'type' in items[items.length - 1]) return false
  for (let i = 1; i < items.length; i++) if ('type' in items[i] && 'type' in items[i - 1]) return false
  return items.every((it) => !('submenu' in it) || noSepBugs(it.submenu))
}
// shapes: the basic ones, then the preset gallery as nested submenus (commands.ts)
const shapes = (): ExpandItem[] => [
  ...Array.from({ length: SHAPE_COUNT }, (_, i) => ({ id: `insert.shape.${i}`, label: `s${i}` })),
  '-',
  {
    label: 'Preset shapes', submenu: [
      { label: 'Stars', submenu: [{ id: 'insert.preset.star5', label: '5-point star' }, { id: 'insert.preset.star6', label: '6-point star' }] },
      { label: 'Empty', submenu: [] },
      { label: 'Arrows', submenu: [{ id: 'insert.preset.chevron', label: 'Chevron' }] },
    ],
  },
]
const expand = (kind: 'shapes' | 'transitions' | 'languages' | 'custom'): ExpandItem[] =>
  kind === 'custom' ? [] : kind === 'shapes' ? shapes()
    : kind === 'transitions' ? TRANSITION_KINDS.map((k) => ({ id: `slide.transition.${k}`, label: k, radio: true, checked: k === 'fade' }))
      : [{ id: 'view.lang.en', label: 'English', radio: true, checked: true }]

// default state: everything visible & enabled
const full = serializeMenuModel({ tr, state: () => undefined, expand })
const keys = full.menus.map((m) => m.key)
ok(['file', 'edit', 'insert', 'slide', 'arrange', 'view', 'play', 'window', 'help'].every((k) => keys.includes(k)), `all menus present (${keys.join(' ')})`)
ok(full.menus.every((m) => m.label.startsWith('«')), 'menu titles are translated')
ok(MAIN_LABELS.every((k) => full.labels[k] === `«${k}»`), 'main-owned labels are sent translated')
ok(full.menus.every((m) => noSepBugs(m.items)), 'no doubled, leading or trailing separators')

const all: WireItem[] = []
for (const m of full.menus) walk(m.items, (it) => all.push(it))
const leaves = all.filter((it): it is Extract<WireItem, { id: string }> => 'id' in it)
ok(leaves.length > 80, `leaf items serialized (${leaves.length})`)
ok(leaves.find((l) => l.id === 'file.save')?.accel === 'CmdOrCtrl+S', 'accelerators are carried for display')
ok(leaves.filter((l) => l.id.startsWith('slide.transition.')).every((l) => l.radio) &&
  leaves.find((l) => l.id === 'slide.transition.fade')?.checked === true, 'transitions are a radio group with the current one checked')
ok(leaves.find((l) => l.id === 'view.panelFormat')?.checked === false, 'checkbox items carry checked (default false)')

// Insert ▸ Shape: the basic shapes, a separator, then Preset shapes ▸ <category> ▸ preset
const shapeMenu = (() => {
  let found: WireItem | null = null
  walk(full.menus.find((m) => m.key === 'insert')!.items, (it) => { if ('submenu' in it && it.label === '«Shape»') found = it })
  return found as Extract<WireItem, { submenu: WireItem[] }> | null
})()
ok(!!shapeMenu && shapeMenu.submenu.filter((it) => 'id' in it).length === SHAPE_COUNT, `Shape lists the ${SHAPE_COUNT} basic shapes`)
const presetsMenu = shapeMenu?.submenu.at(-1)
ok(!!presetsMenu && 'submenu' in presetsMenu && presetsMenu.label === 'Preset shapes' && 'type' in shapeMenu!.submenu.at(-2)!,
  'then a separator and a Preset shapes submenu')
const cats = presetsMenu && 'submenu' in presetsMenu ? presetsMenu.submenu : []
ok(cats.map((c) => ('label' in c ? c.label : '-')).join() === 'Stars,Arrows', `one submenu per category, empty ones dropped (${cats.map((c) => ('label' in c ? c.label : '-')).join()})`)
ok(leaves.some((l) => l.id === 'insert.preset.star5' && l.enabled) && leaves.some((l) => l.id === 'insert.preset.chevron'),
  'preset leaves are commands (insert.preset.<id>)')

// disabled skeleton
const dis = serializeMenuModel({ tr: (s) => s, state: () => undefined, expand: () => [], disabled: true })
const disLeaves: WireItem[] = []
for (const m of dis.menus) walk(m.items, (it) => { if ('id' in it) disLeaves.push(it) })
ok(disLeaves.length > 60 && disLeaves.every((l) => 'id' in l && l.enabled === false), `skeleton: every renderer item is disabled (${disLeaves.length})`)
ok(dis.menus.every((m) => noSepBugs(m.items)), 'skeleton has no separator bugs')

// visibility: figure mode — hide slide-only, show figure exports; invisible submenus vanish
const figure = serializeMenuModel({
  tr: (s) => s, expand: (k) => (k === 'transitions' ? [] : expand(k)), // Editor.expand drops invisible transitions
  state: (id) => {
    if (id.startsWith('slide.') || id.startsWith('play.') || id === 'file.exportPdf') return { visible: false }
    if (id.startsWith('arrange.')) return { enabled: false }
    return undefined
  },
})
ok(!figure.menus.some((m) => m.key === 'slide' && m.items.length), 'figure mode: the Slide menu has no items')
ok(!figure.menus.some((m) => m.key === 'play' && m.items.length), 'figure mode: the Play menu has no items')
const figLeaves: string[] = []
for (const m of figure.menus) walk(m.items, (it) => { if ('id' in it) figLeaves.push(it.id) })
ok(figLeaves.includes('file.exportFigurePdf') && !figLeaves.includes('file.exportPdf'), 'figure mode swaps the export items')
const arrangeItems: WireItem[] = []
walk(figure.menus.find((m) => m.key === 'arrange')!.items, (it) => { if ('id' in it) arrangeItems.push(it) })
// 12 = six aligns, center on slide, two distributes, align-to-slide, group, ungroup
ok(arrangeItems.length === 12 && arrangeItems.every((it) => 'id' in it && !it.enabled), `disabled state is carried (Arrange with no selection, ${arrangeItems.length} items)`)
ok(figure.menus.every((m) => noSepBugs(m.items)), 'figure mode has no separator bugs')

// View ▸ Customize… and View ▸ My commands (a UI profile's custom.* commands)
ok(leaves.some((l) => l.id === 'view.customize' && l.label === '«Customize…»'), 'View ▸ Customize… is a renderer command')
const viewItems = (m: ReturnType<typeof serializeMenuModel>) => m.menus.find((x) => x.key === 'view')!.items
const myCommands = (m: ReturnType<typeof serializeMenuModel>) => viewItems(m).find((it) => 'submenu' in it && it.label === '«My commands»') as Extract<WireItem, { submenu: WireItem[] }> | undefined
ok(!myCommands(full), 'My commands is absent while a profile defines no commands')
const custom = serializeMenuModel({
  tr, state: () => undefined,
  expand: (k) => (k === 'custom' ? [{ id: 'custom.heading', label: 'Überschrift <b>' }, { id: 'custom.callout', label: 'Callout', enabled: false }] : expand(k)),
})
const mine = myCommands(custom)
ok(!!mine && mine.submenu.length === 2, 'My commands lists the profile\'s commands')
ok(mine?.submenu[0] && 'id' in mine.submenu[0] && mine.submenu[0].id === 'custom.heading' && mine.submenu[0].label === 'Überschrift <b>', 'a user-authored label is passed through as typed, never translated')
ok(mine?.submenu[1] && 'id' in mine.submenu[1] && mine.submenu[1].enabled === false, 'and carries its enabled state')
ok(custom.menus.every((m) => noSepBugs(m.items)) && noSepBugs(viewItems(full)), 'no separator bugs with or without My commands')
ok(!Object.values(COMMANDS).some((c) => c.accel && /customize/i.test(c.label)), 'Customize… has no accelerator of its own to steal')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
