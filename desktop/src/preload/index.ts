// The renderer's bridge to the desktop shell. Since every window boots the
// current app shell (windows.ts), document bytes DO cross it now: the deck's
// doc-block text on the way in (readLaunchDocument), the serialized file on
// the way out (writeDocument / saveDocumentAs) — see documents.ts.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { userInfo } from 'node:os'

/** OS login name — the default comment author (never prompted for). */
let userName = ''
try { userName = userInfo().username } catch { userName = process.env.USER ?? '' }

// Viewer preferences (theme, language, panel sizes …) are app-wide, but the
// renderer's localStorage is per deck (one session partition per path). Seed
// this window's localStorage from main's store BEFORE any page script runs
// (the theme is applied before first paint); writes go back through
// setViewerPref (kernel/src/storage.ts mirrors lsSet/lsDel to it).
try {
  const snap = ipcRenderer.sendSync('slidomingo:viewer-prefs') as { keys: string[]; values: Record<string, string> | null; adoptIfMissing?: string[] }
  if (snap && Array.isArray(snap.keys)) {
    if (snap.values) {
      for (const k of snap.keys) {
        const v = snap.values[k]
        if (typeof v === 'string') localStorage.setItem(k, v)
        else if (snap.adoptIfMissing?.includes(k)) {
          // a key newer than the store: this window's value becomes the app's
          const have = localStorage.getItem(k)
          if (have !== null) ipcRenderer.send('slidomingo:set-viewer-pref', k, have)
        } else localStorage.removeItem(k)
      }
    } else {
      // first run of this feature: adopt what this window already has
      const have: Record<string, string> = {}
      for (const k of snap.keys) { const v = localStorage.getItem(k); if (v !== null) have[k] = v }
      ipcRenderer.send('slidomingo:viewer-prefs-adopt', have)
    }
  }
} catch { /* preferences simply stay per-deck */ }

// …and kept current while open: another window changed one (viewerprefs.ts).
// Each deck has its own storage partition, so the browser never fires
// `storage` here on its own; this does, so kernel/src/net.ts's guard (offline
// mode cuts every OTHER window off at once) works across desktop windows.
ipcRenderer.on('slidomingo:viewer-pref-changed', (_ev, key: unknown, value: unknown) => {
  if (typeof key !== 'string' || (value !== null && typeof value !== 'string')) return
  try {
    const oldValue = localStorage.getItem(key)
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: value, url: location.href, storageArea: localStorage }))
  } catch { /* storage unavailable: the value applies at the next launch */ }
})

// The editor's per-install UI profile (desktop/src/main/uiprofile.ts, the
// renderer half is slides/src/editor/customize/): seeded into localStorage
// BEFORE any page script runs, so a customized chrome paints customized from
// the first frame, and kept current when any writer changes it.
const UI_PROFILE_KEY = 'slidomingo-ui-profile'
let uiProfileDisabled = false
const uiProfileListeners = new Set<(change: unknown) => void>()
try {
  const seed = ipcRenderer.sendSync('slidomingo:ui-profile-seed') as { disabled?: boolean; profile?: unknown; rev?: number; refused?: boolean }
  if (seed && !seed.refused) {
    uiProfileDisabled = !!seed.disabled
    localStorage.setItem(UI_PROFILE_KEY, JSON.stringify({ profile: seed.disabled ? null : seed.profile ?? null, rev: seed.rev ?? 0 }))
  }
} catch { /* no profile this run */ }
ipcRenderer.on('slidomingo:ui-profile-changed', (_ev, change: { profile?: unknown; rev?: number; source?: string; summary?: string }) => {
  if (!change || typeof change !== 'object') return
  try { localStorage.setItem(UI_PROFILE_KEY, JSON.stringify({ profile: change.profile ?? null, rev: change.rev ?? 0, source: change.source, summary: change.summary })) } catch { /* */ }
  for (const cb of uiProfileListeners) { try { cb(change) } catch { /* a listener's own problem */ } }
})

// A clicked web/mail link (`<a target="_blank">` in About/Help, a deck's svg
// link in the player) goes to the user's browser through main, which checks
// the click's user activation (navguard.ts) — the doc view denies every
// window.open, and a followed link would navigate the app away. Registered
// here, in the isolated world, so only a TRUSTED click counts and the page
// can't remove it; on `window` in the bubble phase, so anything the page
// already handled (the editor keeps slide links inert, present mode opens
// its own) arrives defaultPrevented and is left alone.
function linkClick(ev: MouseEvent): void {
  if (!ev.isTrusted || ev.defaultPrevented || (ev.button !== 0 && ev.button !== 1)) return
  const a = (ev.target as Element | null)?.closest?.('a')
  const raw = a?.getAttribute('href') ?? a?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
  if (!raw) return
  let url: URL
  try { url = new URL(raw, document.baseURI) } catch { return }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return
  ev.preventDefault()
  void ipcRenderer.invoke('slidomingo:open-external', url.href).catch(() => { /* refused: the link does nothing */ })
}
window.addEventListener('click', linkClick)
window.addEventListener('auxclick', linkClick)

contextBridge.exposeInMainWorld('slidomingoDesktop', {
  /** Mirror one viewer preference into the app-wide store (null = forget). */
  setViewerPref: (key: string, value: string | null): void => { ipcRenderer.send('slidomingo:set-viewer-pref', key, value) },

  /** OS username, the fallback comment author. */
  userName,

  /** Absolute path this window was opened for, or null for a fresh document. */
  getLaunchPath: (): Promise<string | null> => ipcRenderer.invoke('slidomingo:get-launch-path'),

  /** Fires once, after the file this window loaded has finished loading. */
  onOpenPath: (cb: (path: string | null) => void): void => {
    ipcRenderer.on('slidomingo:open-path', (_ev, path) => cb(path))
  },

  /** The native menu bar is drawn from the model the editor sends here
   *  (slides/src/editor/commands.ts → desktop menu.ts): on mount, on window
   *  focus and — debounced — when selection/mode/locale/panels change. */
  setMenuModel: (model: unknown): void => ipcRenderer.send('slidomingo:menu-model', model),

  /** A renderer command picked in the native menu (or its accelerator, for
   *  main-owned keys): the id runs through the editor's command registry. */
  onMenuCommand: (cb: (id: string) => void): void => {
    ipcRenderer.on('slidomingo:menu-command', (_ev, id) => cb(id))
  },

  /** Windows/Linux ☰ button: pops the application menu up in this window. */
  popupAppMenu: (): Promise<void> => ipcRenderer.invoke('slidomingo:popup-app-menu'),

  /** Docks/undocks the Claude Code terminal panel in THIS window — same
   *  action as View ▸ Toggle Claude Code Terminal (⌘\`), reachable from the
   *  editor's own chrome. */
  toggleTerminal: (): Promise<void> => ipcRenderer.invoke('slidomingo:toggle-terminal'),

  /** Fire-and-forget: pushes a JSON snapshot of the current selection into
   *  this window's terminal panel context directory (no-op if no panel is
   *  open — see terminalPanel.ts writeSelectionContext). */
  writeSelectionContext: (json: string): void => ipcRenderer.send('slidomingo:selection-context', json),

  /** Fires when `claude` (via the terminal panel's edit.json write-back
   *  channel — see terminalPanel.ts processEditFile) asks to change a text
   *  or code element's content. `sessionId` says which terminal TAB this
   *  came from (see terminalPanel.ts's per-session contextDir subfolders) —
   *  applyExternalEdit doesn't currently enforce a lock on it, but echoes it
   *  back on the result so the main process can route the write-back to the
   *  right session's subfolder. */
  onApplyEdit: (cb: (cmd: { elementId: string; text?: string; html?: string; sessionId?: string }) => void): void => {
    ipcRenderer.on('slidomingo:apply-edit', (_ev, cmd) => cb(cmd))
  },

  /** Reports whether the edit above was applied — main writes this to
   *  edit-result.json and clears edit.json (see terminalPanel.ts). Must echo
   *  back the `sessionId` the request carried. */
  sendApplyEditResult: (result: { ok: boolean; summary?: string; error?: string; sessionId?: string }): void =>
    ipcRenderer.send('slidomingo:apply-edit-result', result),

  /** Fires when the get_slide MCP tool (slidomingo-slides server, see
   *  desktop/src/mcp/slides-mcp-server.mjs) asks to read one whole slide —
   *  forwarded from terminalPanel.ts's slide-request-*.json watcher.
   *  `sessionId` identifies which terminal tab asked (read verbs are never
   *  lock-gated, but the id still routes the response to the right session's
   *  subfolder — see terminalPanel.ts's pendingRequestSession). */
  onSlideRequest: (cb: (req: { requestId: string; slideId?: string; sessionId?: string }) => void): void => {
    ipcRenderer.on('slidomingo:slide-request', (_ev, req) => cb(req))
  },

  /** Answers the request above — main writes it to slide-response-<id>.json
   *  and clears slide-request-<id>.json (see terminalPanel.ts). */
  sendSlideResponse: (result: { requestId: string; ok: boolean; slide?: unknown; error?: string }): void =>
    ipcRenderer.send('slidomingo:slide-response', result),

  /** Fires when the write_slide MCP tool asks to replace one whole slide —
   *  forwarded from terminalPanel.ts's slide-write-*.json watcher. Distinct
   *  from onApplyEdit above, which only ever touches a single element.
   *  `sessionId` identifies which terminal tab asked — write_slide is one of
   *  the lock-triggering verbs (see slides/src/store.ts's lock registry and
   *  editor.ts's applyExternalSlideWrite), so this is load-bearing here,
   *  unlike onApplyEdit's. */
  onSlideWrite: (cb: (cmd: { requestId: string; slideId?: string; slide?: unknown; sessionId?: string }) => void): void => {
    ipcRenderer.on('slidomingo:apply-slide-write', (_ev, cmd) => cb(cmd))
  },

  /** Reports whether the whole-slide write above was applied — main writes
   *  this to slide-write-result-<id>.json and clears slide-write-<id>.json.
   *  `warnings` (added alongside the agent-action write verbs' identical
   *  field) is a non-blocking validateDoc() pass for the written slide, so
   *  the calling agent sees e.g. a resulting text overflow immediately. */
  sendSlideWriteResult: (result: { requestId: string; ok: boolean; summary?: string; error?: string; warnings?: unknown[] }): void =>
    ipcRenderer.send('slidomingo:apply-slide-write-result', result),

  /** Fires when one of the progressive-disclosure MCP read verbs (doc_info/
   *  outline/measure/validate/comments — see desktop/src/mcp/
   *  slides-mcp-server.mjs) asks a question — forwarded from
   *  terminalPanel.ts's agent-query-*.json watcher. `verb` selects which;
   *  `sessionId` identifies the terminal tab that asked (read verbs are never
   *  lock-gated, this is here only for response routing). */
  onAgentQuery: (cb: (req: { requestId: string; verb?: string; args?: Record<string, unknown>; sessionId?: string }) => void): void => {
    ipcRenderer.on('slidomingo:agent-query', (_ev, req) => cb(req))
  },

  /** Answers the query above — main writes it to agent-query-result-<id>.json
   *  and clears agent-query-<id>.json (see terminalPanel.ts). */
  sendAgentQueryResponse: (result: { requestId: string; ok: boolean; result?: unknown; error?: string }): void =>
    ipcRenderer.send('slidomingo:agent-query-response', result),

  /** Fires when one of the agent-action write verbs (insert_elements/
   *  set_frame/duplicate_element/delete_element/reorder_element/
   *  apply_change_pattern/propose_variants/release_slide) asks for a
   *  structural edit — forwarded from terminalPanel.ts's agent-action-*.json
   *  watcher (that watcher, and this channel, are verb-agnostic; only the
   *  renderer's dispatch cares which verb it is). `verb` selects which;
   *  distinct from onSlideWrite above, which only ever replaces a whole
   *  slide. `sessionId` identifies which terminal tab (parallel `claude`
   *  session) sent this — the editor's applyAgentAction uses it as the lock
   *  registry's owner id (see slides/src/store.ts): the first write verb a
   *  session issues against a slide locks it to that sessionId, and a write
   *  from a different sessionId against an already-locked slide is refused.
   *
   *  propose_variants is the ODD ONE OUT here: every other verb's handler
   *  calls store.commit and responds once the document has actually
   *  changed. propose_variants responds immediately with {ok, count} and
   *  makes NO document change at all — it stashes candidates for a human to
   *  pick from later (or never), entirely outside store.doc/the undo stack,
   *  via the editor's own applyVariant/discardVariants, not this channel. It
   *  still participates in locking (see the lock-contract note in
   *  docs/agents.md) since it targets one slide exclusively while pending. */
  onAgentAction: (cb: (cmd: { requestId: string; verb?: string; args?: Record<string, unknown>; sessionId?: string }) => void): void => {
    ipcRenderer.on('slidomingo:agent-action', (_ev, cmd) => cb(cmd))
  },

  /** Reports the result of the action above — main writes this to
   *  agent-action-result-<id>.json and clears agent-action-<id>.json. */
  /** Types a prompt (named by `kind`; the text lives in main) into this
   *  window's Claude Code session — "Polish with Claude". `fix-comments`
   *  carries the comments to list, `draw-icons` the icons to draw (main
   *  validates + formats both). */
  sendAgentPrompt: (kind: 'polish' | 'fix-comments' | 'draw-icons', payload?: unknown): void => ipcRenderer.send('slidomingo:agent-prompt', kind, payload),
  sendAgentActionResult: (result: { requestId: string; ok: boolean; [key: string]: unknown }): void =>
    ipcRenderer.send('slidomingo:agent-action-result', result),
  /** "Fix with Claude" on a PowerPoint import's report: the work list
   *  (slides/src/importrepair.ts) plus the picked file's path — main copies
   *  the file in beside the session, renders it to PDF when LibreOffice is
   *  installed, and types the list into this window's Claude session. */
  fixImportWithAi: (request: { name: string; sourcePath?: string; items: unknown[] }): Promise<{ ok: boolean; source?: boolean; pdf?: boolean; error?: string }> =>
    ipcRenderer.invoke('slidomingo:fix-import', request),

  /** Pushes the app's resolved Auto/Light/Dark theme to this window's
   *  terminal panel — a separate renderer with no access to this window's
   *  localStorage, so it can't resolve the preference on its own (see
   *  terminalPanel.ts / terminal/main.ts). */
  sendTerminalTheme: (theme: 'light' | 'dark'): void => ipcRenderer.send('slidomingo:terminal-theme', theme),

  /** Fires whenever this window's terminal panel opens or closes (docked or
   *  popped out — popping/docking alone doesn't change "open") — see
   *  terminalPanel.ts openPanel/disposePanel. Drives the ribbon button's
   *  armed/pressed state. Returns an unsubscribe: `ipcRenderer.on` stacks a
   *  new listener per call rather than deduping by callback identity, so a
   *  caller that (re-)subscribes more than once per window lifetime — the
   *  Layout Manager overlay's header button, rebuilt on every open — must
   *  unsubscribe on its own teardown or listeners accumulate forever. The
   *  main editor's title bar (built once per window) never needs to. */
  onTerminalStateChange: (cb: (state: { open: boolean }) => void): (() => void) => {
    const listener = (_ev: IpcRendererEvent, state: { open: boolean }) => cb(state)
    ipcRenderer.on('slidomingo:terminal-state', listener)
    return () => ipcRenderer.removeListener('slidomingo:terminal-state', listener)
  },

  /** Fires whenever one parallel `claude` session (terminal tab) closes —
   *  either its own ✕ or the whole panel closing — see terminalPanel.ts's
   *  closeSession/disposePanel. The editor releases every slide lock that
   *  sessionId held immediately (store.releaseSessionLocks), rather than
   *  waiting out the idle timeout. */
  onAgentSessionClosed: (cb: (info: { sessionId: string }) => void): void => {
    ipcRenderer.on('slidomingo:agent-session-closed', (_ev, info) => cb(info))
  },

  /** Fires whenever this window enters or leaves native macOS fullscreen —
   *  drives collapsing the traffic-light gutter reserved in .ed-titlebar. */
  onFullscreenChange: (cb: (state: { fullscreen: boolean }) => void): void => {
    ipcRenderer.on('slidomingo:fullscreen-state', (_ev, state) => cb(state))
  },

  /** Most-recently-opened first — mirrors the native File ▸ Open Recent
   *  submenu so the in-app File dropdown (and the startup picker's Recent
   *  section) can show the same list. */
  listRecent: (): Promise<{ path: string; openedAt: number; pinned?: boolean; figure?: boolean; iconset?: boolean }[]> => ipcRenderer.invoke('slidomingo:list-recent'),

  /** Older alias of openDocument(path): opens a recent file in place of
   *  this window's deck. */
  openRecent: (path: string): void => ipcRenderer.send('slidomingo:open-recent', path),

  /** Older alias, same as openRecent. */
  openRecentReplacing: (path: string): void => ipcRenderer.send('slidomingo:open-recent-replacing', path),

  /** Every `*.beeslides.html` file in the templates folder, parsed — the startup
   *  picker's dynamic template tiles (slides/src/startuppicker.ts). */
  listTemplates: (): Promise<{ path: string; json: unknown }[]> => ipcRenderer.invoke('slidomingo:list-templates'),

  /** Document properties ▸ Clean up ▸ Optimize pictures (lossless)…: the
   *  JPEG/PNG data: URIs to try; resolves with the ones main accepted
   *  (smaller AND pixel-identical — desktop/src/main/pictures.ts), or null
   *  on failure. Nothing is written anywhere. */
  optimizePictures: (uris: string[]): Promise<Array<{ uri: string; next: string; saved: number }> | null> =>
    ipcRenderer.invoke('slidomingo:optimize-pictures', uris),
  onOptimizeProgress: (cb: (p: { done: number; total: number }) => void): (() => void) => {
    const fn = (_ev: IpcRendererEvent, p: { done: number; total: number }) => cb(p)
    ipcRenderer.on('slidomingo:optimize-progress', fn)
    return () => { ipcRenderer.off('slidomingo:optimize-progress', fn) }
  },

  /** Writes a template into the templates folder (de-duped filename); resolves
   *  to the path actually written, or `null` if the write failed (disk full,
   *  permissions, …) — never rejects, see templates.ts saveTemplateFile.
   *  Used by the in-app "Save as template" flow and the startup picker's
   *  "＋ Add a template" import. */
  saveTemplate: (html: string, suggestedBaseName: string): Promise<string | null> =>
    ipcRenderer.invoke('slidomingo:save-template', { html, suggestedBaseName }),

  /** Deletes one template file after a native confirm (moved to the
   *  Trash) — `false` when cancelled, or refused outside the templates folder. */
  deleteTemplate: (path: string): Promise<boolean> => ipcRenderer.invoke('slidomingo:delete-template', path),

  /** Reveals the templates folder in Finder/Explorer — the fully-manual
   *  creation path. */
  openTemplatesFolder: (): void => ipcRenderer.send('slidomingo:open-templates-folder'),

  /** A `File` from the File System Access API (in-app Open…, drag-drop, or a
   *  save picker's resulting handle) carries no OS path — webUtils is
   *  Electron's fix, callable only from a preload script. Used to record
   *  Recent Files entries for opens/saves that never go through
   *  createDocumentWindow(path) (see editor.ts openFileLike/save). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Records an absolute path in File ▸ Open Recent — the missing half of
   *  the in-app open/save flows (windows.ts's addRecent otherwise only ever
   *  runs for a Finder/Dock double-click or an existing Recent entry). */
  recordRecent: (path: string): void => ipcRenderer.send('slidomingo:record-recent', path),

  /** startuppicker.ts's AI paths (Describe it, PowerPoint with AI…) — see
   *  terminalPanel.ts's requestGenerate. Rejects on a malformed request. */
  requestGenerate: (request: { kind: 'describe'; description: string } | { kind: 'pptx'; target: 'deck' | 'layout'; sourcePath: string; name: string; baseline?: unknown }):
    Promise<{ status: 'launched' | 'queued' }> => ipcRenderer.invoke('slidomingo:request-generate', request),

  /** Fires every time `claude` writes generate-result.json for this window's
   *  terminal panel (terminalPanel.ts's generateWatcher). Replaces any
   *  previously registered callback — last registrant wins — so a fresh
   *  startuppicker.ts flow calling this again never double-fires a stale one. */
  onGenerateResult: (cb: (doc: unknown) => void): void => {
    ipcRenderer.removeAllListeners('slidomingo:generate-result')
    ipcRenderer.on('slidomingo:generate-result', (_ev, doc) => cb(doc))
  },

  // --- disk-backed documents (desktop/src/main/documents.ts, windows.ts) -----
  // Every window boots the CURRENT app shell and asks for its deck here; main
  // writes the deck back to the window's bound file (or its draft).

  /** The deck this window is bound to: doc-block `text` (null = blank draft),
   *  `kind` file|draft, and for files the path/name/folder. Null = unbound
   *  (a legacy file loaded directly — read the embedded block instead). */
  readLaunchDocument: (): Promise<{
    text: string | null; kind: 'file' | 'draft'; role: 'deck' | 'template'
    path: string; name: string | null; dir: string | null; mtimeMs: number | null
    opened?: boolean; startIntent?: 'default-template' | 'new-template' | 'new-figure' | 'new-iconset' | null
  } | null> =>
    ipcRenderer.invoke('slidomingo:read-launch-document'),

  /** Dev mode only: the built single-file shell saves are spliced into. */
  getAppShell: (): Promise<string | null> => ipcRenderer.invoke('slidomingo:get-app-shell'),

  /** The viewer-only shell saves are spliced into (null = not built). */
  getViewerShell: (): Promise<string | null> => ipcRenderer.invoke('slidomingo:get-viewer-shell'),

  /** Start page ▸ Example deck: the bundled example's doc JSON, without a
   *  docId (a fresh copy on every open); null = not bundled. */
  getExampleDeck: (): Promise<string | null> => ipcRenderer.invoke('slidomingo:get-example-deck'),

  /** Write the full file to this window's bound path. `force` overwrites a
   *  file changed on disk (the conflict banner's "Keep mine"). */
  writeDocument: (html: string, opts?: { force?: boolean }): Promise<{ ok: true; mtimeMs: number } | { conflict: true; mtimeMs: number } | { missing: true } | { error: string }> =>
    ipcRenderer.invoke('slidomingo:write-document', html, opts),

  /** Native Save dialog + write. `move` rebinds this window to the new file. */
  saveDocumentAs: (req: { html: string; suggestedName: string; mode: 'move' | 'copy'; strings?: Record<string, string> }): Promise<{ ok: true; path: string; name: string } | { cancelled: true } | { error: string }> =>
    ipcRenderer.invoke('slidomingo:save-document-as', req),

  /** Figure mode: native Save dialog + write of a finished SVG, or a print of
   *  the figure's 1:1 HTML page to an exact-size vector PDF. */
  exportFigure: (req:
    | { kind: 'svg'; svg: string; suggestedName: string }
    | { kind: 'pdf'; html: string; widthPx: number; heightPx: number; suggestedName: string },
  ): Promise<{ ok: true; path: string } | { cancelled: true } | { error: string }> =>
    ipcRenderer.invoke('slidomingo:export-figure', req),
  /** Icon sets: native folder picker; main writes the SVGs + icons.json into
   *  a subfolder named `folderName` (names and sizes checked in main). */
  exportIconset: (req: { folderName: string; files: Array<{ name: string; text: string }> }): Promise<{ ok: true; path: string } | { cancelled: true } | { error: string }> =>
    ipcRenderer.invoke('slidomingo:export-iconset', req),

  /** One-click Present: main moves this window to the audience display (2+
   *  displays) and says whether to open the speaker view; presentEnd puts the
   *  window back. */
  presentBegin: (): Promise<{ speaker: boolean }> => ipcRenderer.invoke('slidomingo:present-begin'),
  presentEnd: (): Promise<void> => ipcRenderer.invoke('slidomingo:present-end'),

  /** Open a web/mail link the user just clicked in the user's browser / mail
   *  app (present mode's rich-text links). Main opens only http(s)/mailto, and
   *  only while this page has a user activation; resolves whether it did. */
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('slidomingo:open-external', url),

  /** The bound file's current doc text (conflict → Reload). */
  reloadFromDisk: (): Promise<{ text: string | null; mtimeMs: number } | null> => ipcRenderer.invoke('slidomingo:reload-from-disk'),

  /** Native Open dialog. The first pick replaces this window's deck (flushed
   *  first); `newWindow` opens every pick in a new window. */
  openDialog: (opts?: { newWindow?: boolean }): Promise<boolean> => ipcRenderer.invoke('slidomingo:open-dialog', opts),

  /** Open a known path in place of this window's deck, or in a new window
   *  with `newWindow`. A path open in another window focuses that window. */
  openDocument: (path: string, opts?: { newWindow?: boolean }): Promise<boolean> => ipcRenderer.invoke('slidomingo:open-document', path, opts),

  /** A fresh window (start page). */
  newWindow: (): Promise<boolean> => ipcRenderer.invoke('slidomingo:new-window'),

  /** File ▸ Start page: this window's deck (flushed first) gives way to the
   *  start page. Resolves once main accepted it. */
  goHome: (): Promise<boolean> => ipcRenderer.invoke('slidomingo:go-home'),

  /** A NEW draft booted with this doc text (imports), in place of this
   *  window's deck or in a new window with `newWindow`. */
  openAsDraft: (text: string, opts?: { newWindow?: boolean }): Promise<boolean> => ipcRenderer.invoke('slidomingo:open-as-draft', text, opts),

  /** Dirty flag + window title (+ whether this is still an untouched blank,
   *  and the deck's docId — the key of its chat history). */
  reportDocState: (state: { dirty: boolean; title?: string; untouched?: boolean; docId?: string }): void => ipcRenderer.send('slidomingo:doc-state', state),

  /** The bound file changed (or vanished) on disk behind our back. */
  onFileChangedOnDisk: (cb: (info: { changed?: boolean; missing?: boolean; mtimeMs?: number }) => void): void => {
    ipcRenderer.on('slidomingo:file-changed-on-disk', (_ev, info) => cb(info))
  },

  /** Close/quit: main asks this window to get its pending edits on disk.
   *  Ack with flushAck at once, then answer with flushResult. `kind:'save-as'`
   *  = the user chose Save As… in main's fallback box. */
  onFlushRequest: (cb: (req: { requestId: string; kind: 'flush' | 'save-as' }) => void): void => {
    ipcRenderer.removeAllListeners('slidomingo:flush-request')
    ipcRenderer.on('slidomingo:flush-request', (_ev, req) => cb(req))
  },
  flushAck: (requestId: string): void => ipcRenderer.send('slidomingo:flush-ack', requestId),
  flushResult: (msg: { requestId: string; status: 'clean' | 'flushed' | 'failed' | 'unsaveable'; strings?: Record<string, string> }): void =>
    ipcRenderer.send('slidomingo:flush-result', msg),

  /** userData/Drafts, newest first (`open` = bound to a window right now). */
  listDrafts: (): Promise<Array<{ path: string; title: string | null; mtimeMs: number; open: boolean; figure?: boolean; iconset?: boolean }>> => ipcRenderer.invoke('slidomingo:list-drafts'),
  deleteDraft: (path: string): Promise<boolean> => ipcRenderer.invoke('slidomingo:delete-draft', path),

  /** Session backups of this window's file ("the file as opened"). */
  listBackups: (): Promise<Array<{ path: string; at: number }>> => ipcRenderer.invoke('slidomingo:list-backups'),
  /** Opens a backup as a new draft window. */
  openBackup: (path: string): Promise<boolean> => ipcRenderer.invoke('slidomingo:open-backup', path),

  /** Reveal a file in Finder/Explorer. */
  revealPath: (path: string): void => ipcRenderer.send('slidomingo:reveal-path', path),
  // ---- Template registry (metadata-first; desktop/src/main/templates.ts) ----

  /** Every template's metadata — name from the FILENAME, no document JSON.
   *  Cached in main per (path, mtime). Never rejects (resolves `[]`). */
  listTemplateMeta: (): Promise<Array<{
    path: string; templateId: string | null; name: string
    slideCount: number; layoutCount: number; samples: boolean; mtime: number
  }>> => ipcRenderer.invoke('slidomingo:list-template-meta'),

  /** One template's raw doc-block JSON text (feed to model.ts's
   *  `instantiateTemplate`); `null` if missing or outside the folder. */
  loadTemplate: (path: string): Promise<string | null> => ipcRenderer.invoke('slidomingo:load-template', path),

  /** Overwrites an existing template file with a full serialized template
   *  shell (atomic). `false` when refused (outside the folder, not a shell,
   *  not a template) or the write failed. */
  updateTemplate: (path: string, html: string): Promise<boolean> =>
    ipcRenderer.invoke('slidomingo:update-template', { path, html }),

  /** Renames a template file (never overwrites); resolves to the new path,
   *  or `null` when refused. */
  renameTemplate: (path: string, newBase: string): Promise<string | null> =>
    ipcRenderer.invoke('slidomingo:rename-template', { path, newBase }),

  /** Shows one template file in Finder/Explorer. */
  revealTemplate: (path: string): Promise<boolean> => ipcRenderer.invoke('slidomingo:reveal-template', path),

  /** Edit Template: open the template FILE itself in a template window (the
   *  Layout Manager, saving back into the file) — a new window by default,
   *  or in place of this window's document with `replace`. An already-open
   *  template window is focused. `false` outside the templates folder. */
  editTemplate: (path: string, opts?: { replace?: boolean }): Promise<boolean> =>
    ipcRenderer.invoke('slidomingo:edit-template', path, opts),

  /** The bound file was renamed by main (a template rename): the new path. */
  onBindingMoved: (cb: (info: { path: string; name: string }) => void): void => {
    ipcRenderer.removeAllListeners('slidomingo:binding-moved')
    ipcRenderer.on('slidomingo:binding-moved', (_ev, info) => cb(info))
  },

  /** The start page's default template (main settings.ts; resolved by
   *  templateId, then path), or `null`. Never rejects. */
  getDefaultTemplate: (): Promise<{
    path: string; templateId: string | null; name: string
    slideCount: number; layoutCount: number; samples: boolean; mtime: number
  } | null> => ipcRenderer.invoke('slidomingo:get-default-template'),
  /** Make a template the default (`null` = none). */
  setDefaultTemplate: (path: string | null): Promise<boolean> => ipcRenderer.invoke('slidomingo:set-default-template', path),
  /** Start-page tile for a deck: a 640×360 PNG data URL of its static
   *  first-page preview, or which placeholder to draw — `lock` for a
   *  password-protected deck, `doc` for anything without a preview (older
   *  file, unreadable, render failed). Never rejects; cached on disk by main
   *  (thumbs.ts). */
  getThumbnail: (path: string): Promise<{ dataUrl: string } | { placeholder: 'lock' | 'doc' }> =>
    ipcRenderer.invoke('slidomingo:get-thumbnail', path),

  // ---- Global element library (desktop/src/main/library.ts) ----
  // A user-wide registry, not part of any deck: main owns its location (a
  // default file next to the templates folder, or one the user chose).

  /** The library file's full HTML, or why it can't be read. Never rejects. */
  readLibrary: (): Promise<
    | { ok: true; path: string; name: string; html: string; isDefault: boolean }
    | { ok: false; path: string; name: string; reason: 'missing' | 'unreadable' | 'not-a-library'; isDefault: boolean }
  > => ipcRenderer.invoke('slidomingo:library-read'),
  /** Writes a full serialized shell back to the library file (atomic). */
  writeLibrary: (html: string): Promise<boolean> => ipcRenderer.invoke('slidomingo:library-write', html),
  /** Native Open dialog: the picked file becomes the library. Null = cancelled or not a deck. */
  chooseLibrary: (): Promise<{ path: string; name: string } | null> => ipcRenderer.invoke('slidomingo:library-choose'),
  /** Back to the default library (created if missing). */
  useDefaultLibrary: (): Promise<boolean> => ipcRenderer.invoke('slidomingo:library-use-default'),

  // ---- icon-server tokens (desktop/src/main/icontokens.ts) ----
  /** Stores (encrypted, bound to `url`) or, with null, forgets a source's token. */
  setIconToken: (id: string, url: string, token: string | null): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('slidomingo:icon-token-set', id, url, token),
  /** Which sources have a token stored for their current URL (never the token). */
  iconTokenStatus: (list: Array<{ id: string; url: string }>): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('slidomingo:icon-token-status', list),
  /** Tokens an older build kept in the list; kept unless one is stored already. */
  adoptIconTokens: (list: Array<{ id: string; url: string; token: string }>): Promise<boolean> =>
    ipcRenderer.invoke('slidomingo:icon-tokens-adopt', list),
  /** A GET to an icon server made by main, which adds the token itself. */
  iconFetch: (id: string, url: string): Promise<unknown> => ipcRenderer.invoke('slidomingo:icon-fetch', id, url),

  // ---- AI chat profiles (desktop/src/main/aiprofilesStore.ts) ----
  /** The profiles (no secrets: an API key is write-only) and the default's id. */
  getAiProfiles: (): Promise<{ profiles: unknown[]; defaultId: string }> => ipcRenderer.invoke('slidomingo:ai-profiles-get'),
  /** Replaces the profile list; main validates every field. Resolves to what was stored. */
  saveAiProfiles: (profiles: unknown[], defaultId: string): Promise<{ profiles: unknown[]; defaultId: string }> =>
    ipcRenderer.invoke('slidomingo:ai-profiles-save', profiles, defaultId),
  /** Stores (encrypted) or, with null, forgets an API profile's key. */
  setAiProfileKey: (profileId: string, key: string | null): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('slidomingo:ai-profiles-set-key', profileId, key),
  /** The user's `claude*` shell functions not yet profiles, as ready-made profiles. */
  importAiShellFunctions: (): Promise<{ profiles: unknown[]; error?: string }> => ipcRenderer.invoke('slidomingo:ai-profiles-import-shell'),
  /** `claude --version` through the profile, or a one-token API request. */
  testAiProfile: (profile: unknown): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('slidomingo:ai-profiles-test', profile),
  /** Opens userData/api-skills (created first) in the file manager. */
  openAiSkillsFolder: (): Promise<{ ok: boolean; path: string; error?: string }> => ipcRenderer.invoke('slidomingo:ai-open-skills-folder'),
  /** View ▸ New Chat With… : the profiles to pick from, and a new tab with one. */
  newChatWith: (profileId?: string): void => { ipcRenderer.send('slidomingo:new-chat-with', profileId) },

  // ---- the editor's UI profile (desktop/src/main/uiprofile.ts) ----
  /** SLIDOMINGO_NO_UI_PROFILE=1: customizations are off for this run. */
  uiProfileDisabled,
  /** A strictly validated write (main validates again); null clears it. */
  uiProfileWrite: (profile: unknown, meta: { source: string; summary: string }): Promise<unknown> =>
    ipcRenderer.invoke('slidomingo:ui-profile-write', profile, meta),
  uiProfileHistory: (): Promise<unknown> => ipcRenderer.invoke('slidomingo:ui-profile-history'),
  uiProfileRevert: (rev: number): Promise<unknown> => ipcRenderer.invoke('slidomingo:ui-profile-revert', rev),
  uiProfileReset: (): Promise<unknown> => ipcRenderer.invoke('slidomingo:ui-profile-reset'),
  /** Any writer changed it (this window, another one, the chat, an agent). */
  onUiProfileChanged: (cb: (change: unknown) => void): (() => void) => {
    uiProfileListeners.add(cb)
    return () => { uiProfileListeners.delete(cb) }
  },

  // ---- Settings ▸ Customize's chat (desktop/src/main/apichat/customizechat.ts) ----
  customizeChatInfo: (): Promise<unknown> => ipcRenderer.invoke('slidomingo:customize-chat-info'),
  /** `digest`: one line about the selection's look, for "save THIS look". */
  customizeChatSend: (text: string, digest: string | null): Promise<unknown> => ipcRenderer.invoke('slidomingo:customize-chat-send', text, digest),
  customizeChatStop: (): Promise<unknown> => ipcRenderer.invoke('slidomingo:customize-chat-stop'),
  customizeChatClear: (): Promise<unknown> => ipcRenderer.invoke('slidomingo:customize-chat-clear'),
  onCustomizeChatEvent: (cb: (ev: unknown) => void): (() => void) => {
    const fn = (_ev: IpcRendererEvent, e: unknown) => cb(e)
    ipcRenderer.on('slidomingo:customize-chat-event', fn)
    return () => { ipcRenderer.removeListener('slidomingo:customize-chat-event', fn) }
  },

  /** Start page ▸ "Remove from list" (the file stays where it is). */
  removeRecent: (path: string): void => ipcRenderer.send('slidomingo:remove-recent', path),
  /** Start page ▸ Pin / Unpin: a pinned deck stays on top and never ages out. */
  pinRecent: (path: string, pinned: boolean): void => ipcRenderer.send('slidomingo:pin-recent', path, pinned),
})
