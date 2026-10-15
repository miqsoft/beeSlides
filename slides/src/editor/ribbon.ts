// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// slidomingo/desktop ONLY: shell detection + the PowerPoint-style ribbon (tab
// strip + one visible group row per tab, collapsible down to the title bar).
// A plain browser tab (the hosted web app or any web/mobile use) never sees any of
// this — window.slidomingoDesktop is undefined there, isDesktopShell() is false,
// and editor.ts never calls into this module at all.
//
// This file deliberately never imports Editor's type and never calls a
// private Editor method — it only lays out finished, already-wired
// HTMLElements that Editor built at the call site (where `this` is
// available). That keeps this module decoupled, independently testable, and
// guarantees zero reimplemented command logic: every button the ribbon shows
// is either a relocated existing node or a one-line call to an
// already-public method, built in editor.ts's buildDesktopChrome().

import { lsGet, lsSet } from '../../../kernel/src/storage.ts'
import { t } from '../i18n'
import { RIBBON_LAYOUT } from './customize/catalog.ts'

/** Present only inside the slidomingo/desktop Electron shell (preload/index.ts's
 *  contextBridge) — undefined in a plain browser tab. Set synchronously
 *  before the page's own scripts run (preload timing), so a plain function
 *  call is enough; no async probe needed. */
declare global {
  interface Window {
    slidomingoDesktop?: {
      /** OS login name — fallback comment author (editor/comments.ts). */
      userName?: string
      getLaunchPath: () => Promise<string | null>
      onOpenPath: (cb: (path: string | null) => void) => void
      /** The native menu bar is drawn from this model (editor/commands.ts,
       *  desktop menu.ts): sent on mount, window focus and — debounced — when
       *  its inputs change. */
      setMenuModel?: (model: unknown) => void
      /** A renderer command chosen in the native menu — `commands.run(id)`. */
      onMenuCommand?: (cb: (id: string) => void) => void
      /** Windows/Linux ☰ button: pop the application menu up at the cursor. */
      popupAppMenu?: () => Promise<void>
      toggleTerminal: () => Promise<void>
      writeSelectionContext: (json: string) => void
      /** `sessionId` names which terminal TAB (parallel `claude` session) a
       *  request came from — see docs/DECISIONS.md's parallel-claude-sessions
       *  entry and terminalPanel.ts's per-session contextDir subfolders. */
      onApplyEdit: (cb: (cmd: { elementId: string; text?: string; html?: string; sessionId?: string }) => void) => void
      sendApplyEditResult: (result: { ok: boolean; summary?: string; error?: string; sessionId?: string }) => void
      /** get_slide MCP tool's write-back trigger — see editor.ts
       *  respondSlideRequest and terminalPanel.ts's slide-request watcher. */
      onSlideRequest: (cb: (req: { requestId: string; slideId?: string; sessionId?: string }) => void) => void
      sendSlideResponse: (result: { requestId: string; ok: boolean; slide?: unknown; error?: string }) => void
      /** write_slide MCP tool's write-back trigger — see editor.ts
       *  applyExternalSlideWrite and terminalPanel.ts's slide-write watcher.
       *  `sessionId` is the lock registry's owner id for this write. */
      onSlideWrite: (cb: (cmd: { requestId: string; slideId?: string; slide?: unknown; sessionId?: string }) => void) => void
      sendSlideWriteResult: (result: { requestId: string; ok: boolean; summary?: string; error?: string }) => void
      /** Progressive-disclosure MCP read verbs (doc_info/outline/measure/
       *  validate/comments/recent_changes/render_preview) — see editor.ts
       *  respondAgentQuery and terminalPanel.ts's agent-query watcher. Never
       *  lock-gated. */
      onAgentQuery: (cb: (req: { requestId: string; verb?: string; args?: Record<string, unknown>; sessionId?: string }) => void) => void
      sendAgentQueryResponse: (result: { requestId: string; ok: boolean; result?: unknown; error?: string }) => void
      /** Agent-action write verbs (insert_elements/set_frame/
       *  duplicate_element/delete_element/reorder_element/
       *  apply_change_pattern/propose_variants/release_slide) — see editor.ts
       *  applyAgentAction and terminalPanel.ts's agent-action watcher.
       *  `sessionId` is the lock registry's owner id — see store.ts. */
      onAgentAction: (cb: (cmd: { requestId: string; verb?: string; args?: Record<string, unknown>; sessionId?: string }) => void) => void
      sendAgentActionResult: (result: { requestId: string; ok: boolean; [key: string]: unknown }) => void
      /** "Polish with Claude" / "Send comments to Claude": type a prompt into
       *  the panel's session (`comments` = editor/comments.ts SentComment[]). */
      sendAgentPrompt?: (kind: 'polish' | 'fix-comments' | 'draw-icons', payload?: unknown) => void
      /** "Fix with Claude" on a PowerPoint import's report (editor/importfix.ts). */
      fixImportWithAi?: (request: { name: string; sourcePath?: string; items: unknown[] }) => Promise<{ ok: boolean; source?: boolean; pdf?: boolean; error?: string }>
      sendTerminalTheme: (theme: 'light' | 'dark') => void
      /** Fires whenever this window's terminal panel opens or closes (docked
       *  or popped out — popping/docking alone doesn't change "open").
       *  Returns an unsubscribe — `ipcRenderer.on` stacks a new listener per
       *  call, so a caller that (re-)subscribes more than once per window
       *  lifetime (the Layout Manager overlay's header button, rebuilt on
       *  every open) must call it on its own teardown or listeners
       *  accumulate; the main editor's title bar (built once per window)
       *  never needs to. */
      onTerminalStateChange: (cb: (state: { open: boolean }) => void) => () => void
      /** Fires whenever one parallel `claude` session (terminal tab) closes —
       *  its own tab, or the whole panel closing. The editor releases every
       *  slide lock that sessionId held (store.releaseSessionLocks). */
      onAgentSessionClosed: (cb: (info: { sessionId: string }) => void) => void
      onFullscreenChange: (cb: (state: { fullscreen: boolean }) => void) => void
      listRecent: () => Promise<{ path: string; openedAt: number; pinned?: boolean; figure?: boolean; iconset?: boolean }[]>
      openRecent: (path: string) => void
      openRecentReplacing: (path: string) => void
      listTemplates: () => Promise<{ path: string; json: unknown }[]>
      saveTemplate: (html: string, suggestedBaseName: string) => Promise<string | null>
      /** desktop/src/main/pictures.ts: lossless JPEG/PNG optimization; the
       *  accepted (smaller, pixel-identical) replacements, or null */
      optimizePictures?: (uris: string[]) => Promise<Array<{ uri: string; next: string; saved: number }> | null>
      onOptimizeProgress?: (cb: (p: { done: number; total: number }) => void) => () => void
      deleteTemplate: (path: string) => Promise<boolean>
      openTemplatesFolder: () => void
      getPathForFile: (file: File) => string
      recordRecent: (path: string) => void
      /** Fires off an AI template-generation request (startuppicker.ts's
       *  Describe-it path) — launches the terminal panel with `claude`
       *  already working the request if none is open yet ('launched'), or
       *  just drops the request files into an already-open panel's context
       *  dir for the user to point Claude Code at ('queued'). */
      requestGenerate: (request: { kind: 'describe'; description: string } | { kind: 'pptx'; target: 'deck' | 'layout'; sourcePath: string; name: string; baseline?: unknown }) =>
        Promise<{ status: 'launched' | 'queued' }>
      /** Fires every time `claude` writes generate-result.json for this
       *  window's terminal panel — replaces any previously registered
       *  callback (last registrant wins), so re-calling this from a fresh
       *  startuppicker.ts flow never double-fires an old one. */
      onGenerateResult: (cb: (doc: unknown) => void) => void
      // --- disk-backed documents (desktop documents.ts; editor/desktopdoc.ts) ---
      readLaunchDocument?: () => Promise<DesktopLaunchDocument | null>
      getAppShell?: () => Promise<string | null>
      getViewerShell?: () => Promise<string | null>
      /** The bundled example deck's doc JSON, without a docId (start page). */
      getExampleDeck?: () => Promise<string | null>
      writeDocument?: (html: string, opts?: { force?: boolean }) => Promise<DesktopWriteResult>
      saveDocumentAs?: (req: { html: string; suggestedName: string; mode: 'move' | 'copy'; strings?: Record<string, string> }) =>
        Promise<{ ok: true; path: string; name: string } | { cancelled: true } | { error: string }>
      exportFigure?: (req:
        | { kind: 'svg'; svg: string; suggestedName: string }
        | { kind: 'pdf'; html: string; widthPx: number; heightPx: number; suggestedName: string }) =>
        Promise<{ ok: true; path: string } | { cancelled: true } | { error: string }>
      /** Icon sets: pick a folder; main writes the files into a subfolder named `folderName`. */
      exportIconset?: (req: { folderName: string; files: Array<{ name: string; text: string }> }) =>
        Promise<{ ok: true; path: string } | { cancelled: true } | { error: string }>
      presentBegin?: () => Promise<{ speaker: boolean }>
      presentEnd?: () => Promise<void>
      /** A clicked web/mail link, to the user's browser / mail app (main
       *  checks the scheme and the click's user activation). */
      openExternal?: (url: string) => Promise<boolean>
      reloadFromDisk?: () => Promise<{ text: string | null; mtimeMs: number } | null>
      /** Opens replace this window's deck (flushed first); `newWindow` opens
       *  in a new window instead. Resolve once main accepted the request. */
      openDialog?: (opts?: { newWindow?: boolean }) => Promise<boolean>
      openDocument?: (path: string, opts?: { newWindow?: boolean }) => Promise<boolean>
      newWindow?: () => Promise<boolean>
      /** This window's deck (flushed first) gives way to the start page. */
      goHome?: () => Promise<boolean>
      openAsDraft?: (text: string, opts?: { newWindow?: boolean }) => Promise<boolean>
      reportDocState?: (state: { dirty: boolean; title?: string; untouched?: boolean; docId?: string }) => void
      onFileChangedOnDisk?: (cb: (info: { changed?: boolean; missing?: boolean; mtimeMs?: number }) => void) => void
      onFlushRequest?: (cb: (req: { requestId: string; kind: 'flush' | 'save-as' }) => void) => void
      flushAck?: (requestId: string) => void
      flushResult?: (msg: { requestId: string; status: DesktopFlushStatus; strings?: Record<string, string> }) => void
      listDrafts?: () => Promise<Array<{ path: string; title: string | null; mtimeMs: number; open: boolean; figure?: boolean; iconset?: boolean }>>
      deleteDraft?: (path: string) => Promise<boolean>
      listBackups?: () => Promise<Array<{ path: string; at: number }>>
      openBackup?: (path: string) => Promise<boolean>
      revealPath?: (path: string) => void
      // ---- Template registry (metadata-first; desktop templates.ts) ----
      /** Metadata of every template (name from the filename; no doc JSON). */
      listTemplateMeta?: () => Promise<Array<{
        path: string; templateId: string | null; name: string
        slideCount: number; layoutCount: number; samples: boolean; mtime: number
      }>>
      /** One template's raw doc-block JSON text → model.instantiateTemplate. */
      loadTemplate?: (path: string) => Promise<string | null>
      /** Overwrites an existing template with a serialized template shell. */
      updateTemplate?: (path: string, html: string) => Promise<boolean>
      /** Renames a template file (never overwrites); the new path or null. */
      renameTemplate?: (path: string, newBase: string) => Promise<string | null>
      revealTemplate?: (path: string) => Promise<boolean>
      /** Edit Template: the template FILE in a template window (new window,
       *  or this one with `replace`); false outside the templates folder. */
      editTemplate?: (path: string, opts?: { replace?: boolean }) => Promise<boolean>
      /** The bound file was renamed by main (a template rename). */
      onBindingMoved?: (cb: (info: { path: string; name: string }) => void) => void
      /** The start page's default template (by templateId, then path), or null. */
      getDefaultTemplate?: () => Promise<{
        path: string; templateId: string | null; name: string
        slideCount: number; layoutCount: number; samples: boolean; mtime: number
      } | null>
      setDefaultTemplate?: (path: string | null) => Promise<boolean>
      // ---- Global element library (desktop library.ts) ----
      readLibrary?: () => Promise<
        | { ok: true; path: string; name: string; html: string; isDefault: boolean }
        | { ok: false; path: string; name: string; reason: 'missing' | 'unreadable' | 'not-a-library'; isDefault: boolean }
      >
      writeLibrary?: (html: string) => Promise<boolean>
      chooseLibrary?: () => Promise<{ path: string; name: string } | null>
      useDefaultLibrary?: () => Promise<boolean>
      /** Start page ▸ "Remove from list" (the file stays where it is). */
      removeRecent?: (path: string) => void
      /** Start page ▸ Pin / Unpin (a pinned deck never ages out of Recent). */
      pinRecent?: (path: string, pinned: boolean) => void
      /** Start-page tile for a deck (desktop thumbs.ts): a 640×360 PNG data
       *  URL of its first-page preview, or `lock` (password-protected) /
       *  `doc` (no preview, unreadable, render failed). Never rejects. */
      getThumbnail?: (path: string) => Promise<{ dataUrl: string } | { placeholder: 'lock' | 'doc' }>
    }
  }
}

export interface DesktopLaunchDocument {
  text: string | null
  kind: 'file' | 'draft'
  /** `template`: a template window (desktop Edit Template) — the file is a
   *  template and main.ts boots the editor in template mode. Absent from an
   *  older main process = `deck`. */
  role?: 'deck' | 'template'
  path: string
  name: string | null
  dir: string | null
  mtimeMs: number | null
  /** This deck replaced another one in the window (say "Opened …"). */
  opened?: boolean
  /** A blank draft with a start intent, for showStartupPicker:
   *  `default-template` (File ▸ New from Default Template) skips the start
   *  page; `new-template` (File ▸ New Layout…) opens it with the Create
   *  layout chooser up. */
  startIntent?: 'default-template' | 'new-template' | 'new-figure' | 'new-iconset' | null
}
export type DesktopWriteResult =
  | { ok: true; mtimeMs: number }
  | { conflict: true; mtimeMs: number }
  | { missing: true }
  | { error: string }
export type DesktopFlushStatus = 'clean' | 'flushed' | 'failed' | 'unsaveable'

export function isDesktopShell(): boolean {
  return typeof window.slidomingoDesktop !== 'undefined'
}

function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

/** One ribbon group: a caption under a row of controls — visually matches
 *  Office's ribbon groups. `items` are finished nodes (buttons, dropdowns). */
export function ribbonGroup(label: string, items: HTMLElement[]): HTMLElement {
  const g = div('ed-ribbon-group')
  const body = div('ed-ribbon-group-body')
  body.append(...items)
  const caption = div('ed-ribbon-group-caption')
  caption.textContent = label
  g.append(body, caption)
  return g
}

/** One tab's full group row (several ribbonGroup()s side by side). */
export function ribbonRow(groups: HTMLElement[]): HTMLElement {
  const row = div('ed-ribbon-row')
  row.append(...groups)
  return row
}

export interface RibbonTabDef {
  key: string
  label: string
  /** This tab's pre-built group row (see ribbonRow()) — shown/hidden, never
   *  cloned or rebuilt, so listeners and any live state stay intact. */
  row: HTMLElement
}

export interface RibbonOpts {
  tabs: RibbonTabDef[]
}

export interface RibbonHandle {
  el: HTMLElement
  setCollapsed(on: boolean): void
  isCollapsed(): boolean
  /** Tabs a UI profile adds after the built-in ones (editor/customize/
   *  apply.ts) — replaces the previous set; [] removes them. */
  setCustomTabs(tabs: RibbonTabDef[]): void
  /** Hide and reorder BUILT-IN groups by their `data-group-id` (catalog.ts
   *  RIBBON_LAYOUT). A tab whose every group is hidden is hidden too. */
  applyLayout(layout: { hide?: readonly string[]; order?: Readonly<Record<string, readonly string[]>> }): void
}

const COLLAPSE_KEY = 'slidomingo-ribbon-collapsed'

/** Tags each built-in group with its catalog id by its caption — matched
 *  against the TRANSLATED English caption, so editor.ts's ribbonGroup()
 *  calls need no ids of their own. A group nobody listed stays untagged. */
function tagGroups(tab: RibbonTabDef): HTMLElement[] {
  const groups = [...tab.row.querySelectorAll<HTMLElement>(':scope > .ed-ribbon-group')]
  const layout = RIBBON_LAYOUT[tab.key] ?? []
  for (const g of groups) {
    const caption = g.querySelector('.ed-ribbon-group-caption')?.textContent ?? ''
    const hit = layout.find((l) => t(l.caption) === caption)
    if (hit) g.dataset.groupId = hit.id
  }
  return groups
}

/**
 * Builds the tab strip + rows into `container` and returns a handle for the
 * collapse control (built separately, in the title bar, so it stays
 * reachable even while collapsed).
 */
export function buildRibbon(container: HTMLElement, opts: RibbonOpts): RibbonHandle {
  const wrap = div('ed-ribbon')
  const tabStrip = div('ed-ribbon-tabs')
  const rows = div('ed-ribbon-rows')
  rows.append(...opts.tabs.map((t) => t.row))
  for (const t of opts.tabs) t.row.hidden = true
  // the authored order of each built-in row's groups (applyLayout reorders)
  const authored = new Map(opts.tabs.map((tab) => [tab.key, tagGroups(tab)]))

  let tabs: RibbonTabDef[] = [...opts.tabs]
  let active = ''
  const tabButtons = new Map<string, HTMLButtonElement>()
  const showTab = (key: string) => {
    active = key
    for (const t of tabs) t.row.hidden = t.key !== key
    for (const [k, b] of tabButtons) b.classList.toggle('ed-ribbon-tab-active', k === key)
  }
  const addTabButton = (t: RibbonTabDef, custom: boolean) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = custom ? 'ed-ribbon-tab ed-ribbon-tab-custom' : 'ed-ribbon-tab'
    b.textContent = t.label
    b.dataset.tabKey = t.key
    b.addEventListener('click', () => showTab(t.key))
    tabButtons.set(t.key, b)
    tabStrip.appendChild(b)
  }
  for (const t of opts.tabs) addTabButton(t, false)
  if (opts.tabs[0]) showTab(opts.tabs[0].key)

  wrap.append(tabStrip, rows)
  container.appendChild(wrap)

  const setCollapsed = (on: boolean) => {
    wrap.classList.toggle('ed-ribbon-collapsed', on)
    lsSet(COLLAPSE_KEY, on ? '1' : '0')
  }
  if (lsGet(COLLAPSE_KEY) === '1') setCollapsed(true)

  /** The active tab when it is still showing, else the first visible one. */
  const settle = () => {
    const visible = tabs.filter((t) => !tabButtons.get(t.key)?.hidden)
    if (!visible.some((t) => t.key === active) && visible[0]) showTab(visible[0].key)
    else showTab(active)
  }

  const setCustomTabs = (next: RibbonTabDef[]) => {
    for (const t of tabs.slice(opts.tabs.length)) {
      t.row.remove()
      tabButtons.get(t.key)?.remove()
      tabButtons.delete(t.key)
    }
    tabs = [...opts.tabs, ...next]
    for (const t of next) {
      t.row.hidden = true
      rows.appendChild(t.row)
      addTabButton(t, true)
    }
    settle()
  }

  const applyLayout = (layout: { hide?: readonly string[]; order?: Readonly<Record<string, readonly string[]>> }) => {
    const hide = new Set(layout.hide ?? [])
    for (const tab of opts.tabs) {
      const groups = authored.get(tab.key) ?? []
      const order = layout.order?.[tab.key] ?? []
      const rank = (g: HTMLElement) => { const i = order.indexOf(g.dataset.groupId ?? ''); return i < 0 ? order.length : i }
      const sorted = [...groups].sort((a, b) => rank(a) - rank(b) || groups.indexOf(a) - groups.indexOf(b))
      for (const g of sorted) {
        g.hidden = !!g.dataset.groupId && hide.has(g.dataset.groupId)
        tab.row.appendChild(g)
      }
      const b = tabButtons.get(tab.key)
      if (b) b.hidden = groups.length > 0 && groups.every((g) => g.hidden) && tab.key !== 'home'
    }
    settle()
  }

  return {
    el: wrap, setCollapsed, isCollapsed: () => wrap.classList.contains('ed-ribbon-collapsed'),
    setCustomTabs, applyLayout,
  }
}

