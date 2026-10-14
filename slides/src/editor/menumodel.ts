// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The desktop menu catalog — pure data, NO imports. One file answers "which
// commands exist, what are they called, in what order do they appear in the
// native menu bar". Two consumers:
//
//   • the renderer (commands.ts) binds each id to a handler and serialises
//     this tree, translated and with live enabled/checked state, to main;
//   • the desktop main process (desktop/src/main/menu.ts) imports it to draw a
//     fully-DISABLED skeleton while no editor is mounted (start page, player
//     mode, boot) — so those windows show the same menus, greyed out, instead
//     of items that silently do nothing.
//
// Labels are the English i18n keys: they are passed through t() by the
// renderer. Accelerators are Electron strings. For every renderer command
// they are DISPLAY-ONLY (main sets registerAccelerator:false): the page's own
// keydown handler (editor.ts wireKeyboard) stays the one owner of the key, so
// a shortcut can never fire twice (native accelerator + keydown).
// Main-owned items (slots below) keep real accelerators; main never also
// listens in the page.

export interface CmdMeta {
  label: string
  accel?: string
  /** 'check' = checkbox, 'radio' = radio group member */
  kind?: 'check' | 'radio'
}

export const COMMANDS: Record<string, CmdMeta> = {
  'app.settings': { label: 'Settings…', accel: 'CmdOrCtrl+,' },

  'file.save': { label: 'Save', accel: 'CmdOrCtrl+S' },
  'file.saveCopy': { label: 'Save a copy…' },
  'file.duplicate': { label: 'Duplicate as new deck…' },
  'file.saveLayout': { label: 'Save as layout…' },
  'file.newFromLayout': { label: 'New deck from this layout' },
  'file.copyLayout': { label: 'Copy as new layout…' },
  'file.presentOnly': { label: 'Export' },
  'file.pwSet': { label: 'Encrypt with password…' },
  'file.pwChange': { label: 'Change password…' },
  'file.pwRemove': { label: 'Remove password' },
  'file.history': { label: 'Version history…' },
  'file.importPptx': { label: 'Import PowerPoint…' },
  'file.importMarkdown': { label: 'Import Quarto / Markdown…' },
  'file.replaceJson': { label: 'Replace from JSON…' },
  'file.exportPdf': { label: 'Export PDF…', accel: 'CmdOrCtrl+P' },
  'file.exportFigurePdf': { label: 'Export figure as PDF…' },
  'file.exportFigureSvg': { label: 'Export figure as SVG…' },
  'file.exportFigureSvgOutlined': { label: 'Export figure as SVG (text as outlines)…' },
  'file.copyJson': { label: 'Copy document JSON' },
  'file.copyJsonLight': { label: 'Copy document JSON without pictures' },
  'file.scratch': { label: 'Start from scratch…' },

  'edit.undo': { label: 'Undo', accel: 'CmdOrCtrl+Z' },
  'edit.redo': { label: 'Redo', accel: 'Shift+CmdOrCtrl+Z' },
  'edit.formatPainter': { label: 'Format Painter' },
  'edit.reapply': { label: 'Reapply Change' },
  'edit.find': { label: 'Find…', accel: 'CmdOrCtrl+F' },
  'edit.replace': { label: 'Find and replace…', accel: 'Alt+CmdOrCtrl+F' },
  // the selected cells of a table (editor/tablerange.ts TABLE_OPS)
  'table.merge': { label: 'Merge cells' },
  'table.split': { label: 'Split cell' },
  'table.rowAbove': { label: 'Insert row above' },
  'table.rowBelow': { label: 'Insert row below' },
  'table.colLeft': { label: 'Insert column left' },
  'table.colRight': { label: 'Insert column right' },
  'table.deleteRows': { label: 'Delete row' },
  'table.deleteCols': { label: 'Delete column' },

  'insert.text': { label: 'Text' },
  'insert.image': { label: 'Image' },
  'insert.icons': { label: 'Icons' },
  'insert.mediaFile': { label: 'Video or audio file…' },
  'insert.videoLink': { label: 'Video from a link…' },
  'insert.audioLink': { label: 'Audio from a link…' },
  'insert.table': { label: 'Table' },
  'insert.chart': { label: 'Chart' },
  'insert.code': { label: 'Code' },
  'insert.embed': { label: 'Embed' },
  'insert.math': { label: 'Equation' },
  'insert.objects': { label: 'Objects' },
  'insert.saveSelection': { label: 'Save selection…' },
  'insert.library': { label: 'Library' },
  'insert.comment': { label: 'Comment' },
  'insert.zoom': { label: 'Slide or section zoom…' },
  'insert.summaryZoom': { label: 'Summary zoom…' },

  'slide.new': { label: 'New slide' },
  'slide.changeType': { label: 'Change slide type…' },
  'slide.saveType': { label: 'Save as slide type…' },
  'slide.layoutManager': { label: 'Layout Manager…' },
  'slide.settings': { label: 'Slide settings…' },
  'slide.hide': { label: 'Hide slide', kind: 'check' },

  'arrange.left': { label: 'Align left', accel: 'Alt+Shift+L' },
  'arrange.centerX': { label: 'Align horizontal centers', accel: 'Alt+Shift+C' },
  'arrange.right': { label: 'Align right', accel: 'Alt+Shift+R' },
  'arrange.top': { label: 'Align top', accel: 'Alt+Shift+U' },
  'arrange.middleY': { label: 'Align vertical middles', accel: 'Alt+Shift+M' },
  'arrange.bottom': { label: 'Align bottom', accel: 'Alt+Shift+B' },
  'arrange.centerSlide': { label: 'Center on slide', accel: 'Alt+Shift+E' },
  'arrange.toSlide': { label: 'Relative to slide', kind: 'check', accel: 'Alt+Shift+S' },
  'arrange.distX': { label: 'Distribute horizontally', accel: 'Alt+Shift+H' },
  'arrange.distY': { label: 'Distribute vertically', accel: 'Alt+Shift+V' },
  'arrange.group': { label: 'Group', accel: 'G' },
  'arrange.ungroup': { label: 'Ungroup', accel: 'Shift+G' },

  'view.sorter': { label: 'Slide Sorter' },
  'view.panelSlides': { label: 'Slides', kind: 'check' },
  'view.panelFormat': { label: 'Format', kind: 'check' },
  'view.panelNotes': { label: 'Notes', kind: 'check' },
  'view.safeZone': { label: 'Margin guides', kind: 'check' },
  'view.buildBadges': { label: 'Click step badges', kind: 'check' },
  'view.grid': { label: 'Grid', kind: 'check', accel: 'CmdOrCtrl+G' },
  'view.layoutGrid': { label: 'Columns', kind: 'check' },
  'view.guides': { label: 'Guides', kind: 'check' },
  'view.gridSnap': { label: 'Grid & Snap…' },
  'view.checkDeck': { label: 'Check slides' },
  'view.ribbon': { label: 'Ribbon', kind: 'check' },
  'view.customize': { label: 'Customize…' },

  'play.slideshow': { label: 'Present', accel: 'F5' },
  'play.noSpeaker': { label: 'Present without Speaker View' },
  'play.inTab': { label: 'Present in tab' },
  'play.kiosk': { label: 'Kiosk (self-running)' },
  'play.sendComments': { label: 'Send to Claude' },

  'help.shortcuts': { label: 'Shortcuts & tips' },
  'help.keymap': { label: 'Keyboard Shortcuts…' },
}

/** The Arrange commands' ⌥⇧ + letter keys by KeyboardEvent.code, for
 *  editor.ts wireKeyboard — derived from the accelerators above so the menu
 *  and the key can never disagree. */
export const ALIGN_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(COMMANDS)
    .filter(([id, m]) => id.startsWith('arrange.') && /^Alt\+Shift\+[A-Z]$/.test(m.accel ?? ''))
    .map(([id, m]) => [`Key${m.accel!.slice(-1)}`, id]),
)

/** Shapes, transitions and languages are generated: their ids are
 *  `insert.shape.<n>` (index into SHAPE_MENU), `insert.preset.<id>` (a
 *  SHAPE_PRESETS id, in Shape ▸ Preset shapes ▸ <category>),
 *  `slide.transition.<kind>` and `view.lang.<code>`. Transition labels come
 *  from these tables. */
export const TRANSITION_KINDS = ['none', 'fade', 'slide', 'zoom', 'morph', 'push', 'wipe', 'cover', 'split'] as const
export const TRANSITION_LABELS: Record<(typeof TRANSITION_KINDS)[number], string> = {
  none: 'None', fade: 'Fade', slide: 'Slide', zoom: 'Zoom', morph: 'Morph',
  push: 'Push', wipe: 'Wipe', cover: 'Cover', split: 'Split',
}
/** English labels of `TransitionDir` values (push/wipe/cover come FROM a side). */
export const TRANSITION_DIR_LABELS: Record<string, string> = {
  right: 'From right', left: 'From left', bottom: 'From bottom', top: 'From top',
  vertical: 'Vertical', horizontal: 'Horizontal',
}
export const SHAPE_COUNT = 9

export type MenuNode =
  | string                                            // a command id
  | '-'                                               // separator
  | { slot: string }                                  // a block main fills in (see desktop menu.ts)
  | { label: string; items: MenuNode[] }              // submenu
  | { label: string; dynamic: 'shapes' | 'transitions' | 'languages' | 'custom' }

export interface MenuSection { key: string; label: string; items: MenuNode[] }

const ALIGN = ['arrange.left', 'arrange.centerX', 'arrange.right', 'arrange.top', 'arrange.middleY', 'arrange.bottom']

export const MENU_MODEL: MenuSection[] = [
  { key: 'app', label: 'Settings…', items: ['app.settings'] }, // main places it in the macOS app menu / File
  {
    key: 'file', label: 'File', items: [
      { slot: 'file-new' }, '-', { slot: 'file-open' }, '-', { slot: 'file-close' }, '-',
      'file.save', 'file.presentOnly',
      {
        label: 'Export to…', items: [
          'file.exportPdf', 'file.exportFigurePdf', 'file.exportFigureSvg', 'file.exportFigureSvgOutlined',
          '-', 'file.copyJson', 'file.copyJsonLight',
        ],
      },
      'file.saveCopy', 'file.duplicate', 'file.newFromLayout', 'file.saveLayout', 'file.copyLayout',
      { label: 'Password', items: ['file.pwSet', 'file.pwChange', 'file.pwRemove'] },
      '-', 'file.history', '-',
      { label: 'Import', items: ['file.importPptx', 'file.importMarkdown', 'file.replaceJson'] },
      '-', 'file.scratch', { slot: 'file-quit' },
    ],
  },
  {
    key: 'edit', label: 'Edit', items: [
      'edit.undo', 'edit.redo', '-', { slot: 'edit-roles' }, '-', 'edit.find', 'edit.replace', '-', 'edit.formatPainter', 'edit.reapply',
      {
        label: 'Table', items: [
          'table.merge', 'table.split', '-', 'table.rowAbove', 'table.rowBelow', 'table.colLeft', 'table.colRight',
          '-', 'table.deleteRows', 'table.deleteCols',
        ],
      },
    ],
  },
  {
    key: 'insert', label: 'Insert', items: [
      'insert.text', 'insert.image', { label: 'Shape', dynamic: 'shapes' }, 'insert.icons',
      { label: 'Media', items: ['insert.mediaFile', 'insert.videoLink', 'insert.audioLink'] }, 'insert.table', 'insert.chart', 'insert.code', 'insert.embed',
      'insert.math',
      { label: 'Zoom', items: ['insert.zoom', 'insert.summaryZoom'] },
      '-', 'insert.objects', 'insert.saveSelection', 'insert.library', '-', 'insert.comment',
    ],
  },
  {
    key: 'slide', label: 'Slide', items: [
      'slide.new', 'slide.changeType', 'slide.saveType', 'slide.layoutManager', '-',
      { label: 'Transition', dynamic: 'transitions' }, 'slide.settings', 'slide.hide',
    ],
  },
  {
    key: 'arrange', label: 'Arrange', items: [
      { label: 'Align', items: [...ALIGN, '-', 'arrange.centerSlide'] }, { label: 'Distribute', items: ['arrange.distX', 'arrange.distY'] },
      'arrange.toSlide',
      '-', 'arrange.group', 'arrange.ungroup',
    ],
  },
  {
    key: 'view', label: 'View', items: [
      'view.sorter', '-', 'view.panelSlides', 'view.panelFormat', 'view.panelNotes', '-',
      'view.safeZone', 'view.buildBadges', 'view.grid', 'view.layoutGrid', 'view.guides', 'view.gridSnap', 'view.checkDeck', '-', 'view.ribbon', { label: 'Language', dynamic: 'languages' },
      '-', 'view.customize', { label: 'My commands', dynamic: 'custom' },
      '-', { slot: 'view-zoom' }, '-', { slot: 'view-terminal' }, { slot: 'view-developer' },
    ],
  },
  { key: 'play', label: 'Play', items: ['play.slideshow', 'play.noSpeaker', 'play.inTab', 'play.kiosk', 'play.sendComments'] },
  { key: 'window', label: 'Window', items: [{ slot: 'window' }] },
  { key: 'help', label: 'Help', items: ['help.shortcuts', 'help.keymap', { slot: 'help-links' }] },
]

/** English labels of the main-owned items. The renderer sends them translated
 *  (`MenuModel.labels`), so main needs no catalog of its own. */
export const MAIN_LABELS = [
  'New Window', 'New from Default Layout', 'New Layout…', 'New Figure…', 'Open…', 'Open in New Window…',
  'Open Recent', 'No Recent Decks', 'Clear Recent', 'Start Page', 'Paste without Design', 'Actual Size', 'Zoom In', 'Zoom Out',
  'Claude Code Terminal', 'Claude Chats…', 'Developer', 'BeeSlides on GitHub', 'File', 'Edit', 'View', 'Window', 'Help',
] as const

// ---- wire format (renderer → main) -----------------------------------------

export type WireItem =
  | { type: 'separator' }
  | { slot: string }
  | { label: string; submenu: WireItem[] }
  | { id: string; label: string; accel?: string; enabled: boolean; checked?: boolean; radio?: boolean }

export interface MenuModel {
  locale: string
  labels: Record<string, string>
  menus: Array<{ key: string; label: string; items: WireItem[] }>
}

/** One entry of a generated list: a leaf command, a separator, or a
 *  submenu of more entries (its label already translated, like a leaf's). */
export type ExpandItem =
  | { id: string; label: string; checked?: boolean; radio?: boolean; enabled?: boolean }
  | { label: string; submenu: ExpandItem[] }
  | '-'

export interface ItemState { enabled?: boolean; checked?: boolean; visible?: boolean }

export interface SerializeEnv {
  /** translate an English key */
  tr: (en: string) => string
  /** live state of one command id; undefined → enabled, unchecked, visible */
  state: (id: string) => ItemState | undefined
  /** expand a generated list into leaf commands (or translated groups of them) */
  expand: (kind: 'shapes' | 'transitions' | 'languages' | 'custom') => ExpandItem[]
  /** every item disabled (skeleton) */
  disabled?: boolean
  /** the accelerator to SHOW for a command (a UI profile can rebind or switch
   *  off a built-in key, or give a command a key it had none for); absent =
   *  the catalog's own */
  accel?: (id: string, builtin: string | undefined) => string | undefined
}

/** Every static (non-generated) command id the tree references. */
export function menuCommandIds(): string[] {
  const out: string[] = []
  const walk = (nodes: MenuNode[]) => {
    for (const n of nodes) {
      if (typeof n === 'string') { if (n !== '-') out.push(n) } else if ('items' in n) walk(n.items)
    }
  }
  for (const s of MENU_MODEL) walk(s.items)
  return out
}

/** Tree → wire items: translated, invisible items dropped, empty submenus and
 *  doubled/leading/trailing separators collapsed. */
export function serializeMenuModel(env: SerializeEnv, locale = 'en'): MenuModel {
  const leaf = (id: string, meta: CmdMeta, st: ItemState | undefined): WireItem | null => {
    if (st?.visible === false) return null
    const item: WireItem = {
      id, label: env.tr(meta.label),
      enabled: env.disabled ? false : st?.enabled !== false,
    }
    const accel = env.accel ? env.accel(id, meta.accel) : meta.accel
    if (accel) item.accel = accel
    if (meta.kind) { item.checked = !!st?.checked; if (meta.kind === 'radio') item.radio = true }
    return item
  }
  const tidy = (items: WireItem[]): WireItem[] => {
    const out: WireItem[] = []
    for (const it of items) {
      const isSep = 'type' in it
      if (isSep && (!out.length || 'type' in out[out.length - 1])) continue
      out.push(it)
    }
    while (out.length && 'type' in out[out.length - 1]) out.pop()
    return out
  }
  const expanded = (items: ExpandItem[]): WireItem[] => tidy(items.flatMap((g): WireItem[] => {
    if (g === '-') return [{ type: 'separator' }]
    if ('submenu' in g) {
      const sub = expanded(g.submenu)
      return sub.length ? [{ label: g.label, submenu: sub }] : []
    }
    return [{
      id: g.id, label: g.label, enabled: env.disabled ? false : g.enabled !== false,
      ...(g.checked !== undefined ? { checked: g.checked } : {}), ...(g.radio ? { radio: true } : {}),
    }]
  }))
  const build = (nodes: MenuNode[]): WireItem[] => {
    const out: WireItem[] = []
    for (const n of nodes) {
      if (n === '-') { out.push({ type: 'separator' }); continue }
      if (typeof n === 'string') {
        const meta = COMMANDS[n]
        const it = meta && leaf(n, meta, env.state(n))
        if (it) out.push(it)
      } else if ('slot' in n) {
        out.push({ slot: n.slot })
      } else if ('dynamic' in n) {
        const sub = expanded(env.expand(n.dynamic))
        if (sub.length) out.push({ label: env.tr(n.label), submenu: sub })
      } else {
        const sub = tidy(build(n.items))
        if (sub.length) out.push({ label: env.tr(n.label), submenu: sub })
      }
    }
    return out
  }
  const menus = MENU_MODEL.map((s) => ({ key: s.key, label: env.tr(s.label), items: tidy(build(s.items)) }))
  const labels: Record<string, string> = {}
  for (const k of MAIN_LABELS) labels[k] = env.tr(k)
  return { locale, labels, menus }
}
