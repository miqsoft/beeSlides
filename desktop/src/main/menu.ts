import { app, BrowserWindow, Menu, MenuItemConstructorOptions, shell } from 'electron'
import { handleFrom, onFrom } from './ipcguard.ts'
import {
  allDocumentWindows, createDocumentWindow, docWebContentsFor, focusedDocumentWindow, goHome, layoutWindow, onDocumentsChanged,
  openPathsFrom, windowForDocWebContents,
} from './windows.ts'
import { showOpenDialogFor } from './documents.ts'
import { stepUiZoom } from './uizoom.ts'
import { listRecent, clearRecent, onRecentChanged } from './recent.ts'
import { showChatHistory, showNewChatMenu, toggleTerminalPanel } from './terminalPanel.ts'
import { serializeMenuModel, type MenuModel, type WireItem } from '../../../slides/src/editor/menumodel.ts'

const isMac = process.platform === 'darwin'

// ---------------------------------------------------------------------------
// One command registry, one menu catalog (docs/DECISIONS.md 2026-10-06).
//
// The editor (slides/src/editor/commands.ts) owns every document command. It
// sends this process a translated, state-aware MODEL of the renderer-owned
// menu items (`slidomingo:menu-model`, on mount / focus / state change); this
// file draws the native menu bar from it. Choosing an item sends the command
// id back (`slidomingo:menu-command`) and the editor runs it.
//
// Two kinds of item, each with exactly ONE owner of its shortcut:
//   • renderer commands (the model): accelerators are DISPLAY-ONLY
//     (registerAccelerator:false) — the page's keydown handler fires them, so
//     ⌘S/⌘Z/⌘, can never run twice (native accelerator + keydown);
//   • main-owned items (New/Open/Recent/Start Page, Terminal, Developer, the
//     Edit roles, Window, Help links) — real accelerators, handled here; the
//     page never listens for them.
// No model for the focused window (start page, player mode, boot) → the same
// renderer items are drawn all-disabled instead of silently doing nothing.
// Main-owned labels are translated by the renderer (`model.labels`), so main
// carries no catalog of its own; before a model arrives they are English.
//
// Changes to this file need a full app restart (main is not hot-reloaded).
// ---------------------------------------------------------------------------

/** The editor's latest model, per doc webContents (so a swapped deck — Start
 *  Page, Open — starts with none, i.e. disabled, until its editor mounts). */
const models = new Map<number, MenuModel>()
const watched = new Set<number>()

/** Fully-disabled model for windows without an editor. Translated when any
 *  window ever reported a model (same locale — it is the viewer's), else English. */
function skeleton(): MenuModel {
  const any = [...models.values()].pop()
  const disable = (items: WireItem[]): WireItem[] => items.map((it) =>
    'submenu' in it ? { ...it, submenu: disable(it.submenu) } : 'id' in it ? { ...it, enabled: false } : it)
  if (any) return { ...any, menus: any.menus.map((m) => ({ ...m, items: disable(m.items) })) }
  return serializeMenuModel({ tr: (s) => s, state: () => undefined, expand: () => [], disabled: true })
}

function modelForFocused(): MenuModel {
  const win = focusedDocumentWindow()
  const wc = win && docWebContentsFor(win)
  return (wc && models.get(wc.id)) || skeleton()
}

function sendCommand(id: string): void {
  const win = focusedDocumentWindow()
  if (!win) return
  docWebContentsFor(win)?.send('slidomingo:menu-command', id)
}

/** File ▸ Open…: a native dialog in main. The first pick replaces the
 *  focused window's deck (flushed first — windows.ts replaceDocument), any
 *  others open in new windows; Open in New Window… puts every pick in a new
 *  window. A path already open just focuses its window. */
async function openViaDialog(opts: { newWindow?: boolean } = {}): Promise<void> {
  const from = focusedDocumentWindow()
  const paths = await showOpenDialogFor(from)
  if (paths.length) await openPathsFrom(from, paths, opts)
}

/** Docks/undocks the Claude Code terminal panel in the focused window. */
function toggleTerminalInFocusedWindow(): void {
  const win = focusedDocumentWindow()
  if (!win) return
  void toggleTerminalPanel(win).then(() => layoutWindow(win))
}

function findItem(model: MenuModel, id: string): WireItem | null {
  const walk = (items: WireItem[]): WireItem | null => {
    for (const it of items) {
      if ('id' in it && it.id === id) return it
      if ('submenu' in it) { const f = walk(it.submenu); if (f) return f }
    }
    return null
  }
  for (const m of model.menus) { const f = walk(m.items); if (f) return f }
  return null
}

interface Ctx { model: MenuModel; L: (k: string) => string; hasWindow: boolean }

function recentSubmenu(c: Ctx): MenuItemConstructorOptions[] {
  const recent = listRecent()
  const items: MenuItemConstructorOptions[] = recent.length
    ? recent.map(({ path }) => ({
        label: path,
        // ⌘/⌥-click: in a new window instead of replacing this deck
        click: (_item, _win, ev) => { void openPathsFrom(focusedDocumentWindow(), [path], { newWindow: !!(ev?.metaKey || ev?.altKey) }) },
      }))
    : [{ label: c.L('No Recent Decks'), enabled: false }]
  items.push({ type: 'separator' })
  items.push({
    label: c.L('Clear Recent'),
    enabled: recent.length > 0,
    click: () => clearRecent(), // rebuilds via onRecentChanged below
  })
  return items
}

/** Blocks the model marks `{ slot }` — the items main owns. */
const SLOTS: Record<string, (c: Ctx) => MenuItemConstructorOptions[]> = {
  'file-new': (c) => [
    { label: c.L('New Window'), accelerator: 'CmdOrCtrl+N', click: () => createDocumentWindow(null) },
    {
      label: c.L('New from Default Layout'),
      accelerator: 'Alt+CmdOrCtrl+N',
      // straight into a deck — no start page (it falls back to one when no default template is set)
      click: () => createDocumentWindow(null, { startIntent: 'default-template' }),
    },
    {
      label: c.L('New Layout…'),
      // asks for a name, writes an empty template into the templates folder,
      // and the window becomes its template window (Layout Manager)
      click: () => createDocumentWindow(null, { startIntent: 'new-template' }),
    },
    {
      label: c.L('New Figure…'),
      // the start page, straight on its figure-size chooser (vector PDF/SVG export)
      click: () => createDocumentWindow(null, { startIntent: 'new-figure' }),
    },
    {
      label: c.L('New Icon Set…'),
      // the start page, straight on the icon-set setup (name, brief, icons)
      click: () => createDocumentWindow(null, { startIntent: 'new-iconset' }),
    },
  ],
  'file-open': (c) => [
    { label: c.L('Open…'), accelerator: 'CmdOrCtrl+O', click: () => { void openViaDialog() } },
    { label: c.L('Open in New Window…'), accelerator: 'Shift+CmdOrCtrl+O', click: () => { void openViaDialog({ newWindow: true }) } },
    { label: c.L('Open Recent'), submenu: recentSubmenu(c) },
    {
      label: c.L('Start Page'),
      accelerator: 'Shift+CmdOrCtrl+H',
      enabled: c.hasWindow,
      // this window's deck gives way to the start page (flushed first)
      click: () => { const win = focusedDocumentWindow(); if (win) void goHome(win) },
    },
  ],
  'file-close': () => (isMac ? [{ role: 'close' }] : []),
  'file-quit': (c) => [
    // macOS keeps Settings in the app menu
    ...(isMac ? [] : [{ type: 'separator' as const }, ...settingsItem(c), { type: 'separator' as const }, { role: 'quit' as const }]),
  ],
  // Deliberately roles, not Undo/Redo: the document's own undo/redo is the
  // model's (a renderer command, display-only accelerators above). Cut/Copy/
  // Paste/Select-All are needed for text FIELDS to work via the menu/
  // accelerator at all — and on the canvas they fire the copy/cut/paste EVENTS
  // the editor copies and pastes objects through (editor.ts wireCopy/
  // wirePaste). macOS delivers ⌘⇧V to the page only as this menu item, so
  // "Paste without Design" needs to exist for its paste event to fire at all.
  'edit-roles': (c) => [
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'pasteAndMatchStyle', label: c.L('Paste without Design'), accelerator: 'CmdOrCtrl+Shift+V' },
    { role: 'selectAll' },
  ],
  // Not the zoom ROLES: those would forget the level at the next launch and
  // leave other windows alone (uizoom.ts). Zoom In is on ⌘+ as printed and,
  // hidden, on ⌘= — the unshifted key everyone actually presses.
  'view-zoom': (c) => {
    const zoom = (dir: 1 | -1 | 0) => () => stepUiZoom(dir, allDocumentWindows().map(docWebContentsFor))
    return [
      { label: c.L('Actual Size'), accelerator: 'CmdOrCtrl+0', click: zoom(0) },
      { label: c.L('Zoom In'), accelerator: 'CmdOrCtrl+Plus', click: zoom(1) },
      { label: c.L('Zoom In'), accelerator: 'CmdOrCtrl+=', visible: false, click: zoom(1) },
      { label: c.L('Zoom Out'), accelerator: 'CmdOrCtrl+-', click: zoom(-1) },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ]
  },

  'view-terminal': (c) => [
    { label: c.L('Claude Code Terminal'), accelerator: 'CmdOrCtrl+`', enabled: c.hasWindow, click: toggleTerminalInFocusedWindow },
    {
      label: c.L('Claude Chats…'),
      enabled: c.hasWindow,
      click: () => {
        const win = focusedDocumentWindow()
        if (win) void showChatHistory(win).then(() => layoutWindow(win))
      },
    },
    {
      label: c.L('New Chat With…'),
      enabled: c.hasWindow,
      click: () => {
        const win = focusedDocumentWindow()
        if (win) void showNewChatMenu(win).then(() => layoutWindow(win))
      },
    },
  ],
  'view-developer': (c) => [
    { type: 'separator' },
    { label: c.L('Developer'), submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] },
  ],
  window: () => [
    { role: 'minimize' },
    { role: 'zoom' },
    ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [{ role: 'close' as const }]),
  ],
  'help-links': (c) => [
    { type: 'separator' },
    { label: c.L('BeeSlides on GitHub'), click: () => { void shell.openExternal('https://github.com/miqsoft/beeslides') } },
  ],
}

/** ⌘, — the standard macOS Settings spot (not ⌘;, Check Spelling). It is a
 *  renderer command: the editor's keydown owns the key (display-only here). */
function settingsItem(c: Ctx): MenuItemConstructorOptions[] {
  const it = findItem(c.model, 'app.settings')
  return it && 'id' in it ? [leaf(it)] : []
}

function leaf(it: Extract<WireItem, { id: string }>): MenuItemConstructorOptions {
  return {
    label: it.label,
    enabled: it.enabled,
    ...(it.accel ? { accelerator: it.accel, registerAccelerator: false } : {}),
    ...(it.radio ? { type: 'radio' as const, checked: !!it.checked } : it.checked !== undefined ? { type: 'checkbox' as const, checked: it.checked } : {}),
    click: () => sendCommand(it.id),
  }
}

function tidy(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const it of items) {
    if (it.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue
    out.push(it)
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop()
  return out
}

function toTemplate(items: WireItem[], c: Ctx): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const it of items) {
    if ('type' in it) out.push({ type: 'separator' })
    else if ('slot' in it) out.push(...(SLOTS[it.slot]?.(c) ?? []))
    else if ('submenu' in it) out.push({ label: it.label, submenu: toTemplate(it.submenu, c) })
    else out.push(leaf(it))
  }
  return tidy(out)
}

/** Rebuilt on demand — on focus, on a new model for the focused window, when
 *  a deck is mounted/unmounted, and after Recent changes. Cheap. */
export function buildMenu(): void {
  const model = modelForFocused()
  const c: Ctx = { model, L: (k) => model.labels[k] ?? k, hasWindow: !!focusedDocumentWindow() }
  const template: MenuItemConstructorOptions[] = []
  if (isMac) {
    template.push({
      label: app.name,
      submenu: tidy([
        { role: 'about' },
        { type: 'separator' },
        ...settingsItem(c),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ]),
    })
  }
  for (const m of model.menus) {
    if (m.key === 'app') continue
    const submenu = toTemplate(m.items, c)
    if (!submenu.length) continue
    template.push(m.key === 'help' ? { role: 'help', label: m.label, submenu } : { label: m.label, submenu })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** IPC + rebuild triggers. Call once after app ready (index.ts), before the
 *  first window. */
export function registerMenuIpc(): void {
  onFrom('app-shell', 'slidomingo:menu-model', (ev, model: MenuModel) => {
    if (!model || !Array.isArray(model.menus)) return
    const id = ev.sender.id
    models.set(id, model)
    if (!watched.has(id)) {
      watched.add(id)
      ev.sender.once('destroyed', () => { models.delete(id); watched.delete(id) })
    }
    const win = windowForDocWebContents(id)
    if (win && win === focusedDocumentWindow()) buildMenu()
  })
  // Windows/Linux ☰ button: the same application menu, popped up in the caller's window.
  handleFrom('app-shell', 'slidomingo:popup-app-menu', (ev) => {
    const win = windowForDocWebContents(ev.sender.id) ?? BrowserWindow.fromWebContents(ev.sender)
    if (win) Menu.getApplicationMenu()?.popup({ window: win })
  })
  // Coalesced: a window switch is a blur then a focus; building twice would
  // flash the disabled skeleton for no reason.
  let timer: NodeJS.Timeout | undefined
  const soon = () => { clearTimeout(timer); timer = setTimeout(buildMenu, 30) }
  app.on('browser-window-focus', soon)
  app.on('browser-window-blur', soon)
  onDocumentsChanged(() => buildMenu())
  // Keeps Open Recent current after every successful open, not just at launch
  // or after Clear Recent — windows.ts's mountDocument already calls
  // addRecent(path), which notifies via this same import.
  onRecentChanged(() => buildMenu())
}
