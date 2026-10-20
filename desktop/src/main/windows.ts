// Window lifecycle, and which file each window is bound to.
//
// EVERY WINDOW BOOTS THE CURRENT APP SHELL (docs/DECISIONS.md, 2026-09-24).
// This file used to `loadFile(path)` the deck itself — the file IS the app, so
// a deck opened here ran whatever editor build it was last saved with, and
// every save re-spliced that same old shell (kernel capturePristine clones the
// live page). With self-update gone, no save-path fix could ever reach an
// existing deck. Now a window always loads this build's shell
// (APPS.slides.prodShellPath, or the dev server) and the renderer asks for the
// deck's `#beeslides-doc` text over IPC (documents.ts
// `slidomingo:read-launch-document`). Files of another app/format fall back to
// the old `loadFile(path)`, with no binding and so no disk writes — and no
// preload: a foreign page never gets the desktop bridge (mountDocument).
//
// THE MAIN PROCESS WRITES DOCUMENT BYTES (docs/DECISIONS.md, 2026-09-24,
// reversing "main never touches bytes"): a window opened from Finder/Recent/
// the CLI has no File System Access handle, so nothing reached disk before the
// first ⌘S. Each window is BOUND to one path (`Binding`) — a real file, or a
// draft under userData/Drafts for an untitled deck — and documents.ts writes
// only to the sender's bound path. The binding is kept separate from
// `launchPathFor` (the terminal panel's cwd), so a draft never makes the
// Drafts folder the cwd `claude` gets write access to.
//
// The document itself lives in an explicit `docView` (a WebContentsView)
// rather than the BrowserWindow's own implicit webContents, so a sibling
// WebContentsView (the Claude Code terminal panel, terminalPanel.ts) can be
// composited alongside it in the same native window.
import { DOC_EXT } from '../../../kernel/src/docext.ts'
import { BrowserWindow, WebContentsView, app, dialog, screen, session, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebPreferences, type WebContents } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addRecent } from './recent.ts'
import { readSettings, updateSettings } from './settings.ts'
import { disposeTerminalPanel, hasTerminalPanel, isTerminalPanelOpen, layoutDockedPanel, noteDeckIdentityChanged, panelWidthFor, toggleTerminalPanel } from './terminalPanel.ts'
import { extractDocBlockText, isInside, openAsFor } from './docfile.ts'
import { attachSpeakerOpenHandler } from './present.ts'
import { guardNavigation } from './navguard.ts'
import { onFrom } from './ipcguard.ts'
import { applyUiZoom } from './uizoom.ts'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/** One entry per BeeSlides app this shell can host. Only 'slides' is wired today
 *  (dash/spaces/type can slot in later without restructuring this map). */
interface AppDef {
  /** Vite dev server this app's own `npm run dev` serves (fast-iteration mode).
   *  Overridable via SLIDOMINGO_DEV_URL so a worktree's dev server on another
   *  port can be driven without editing code. */
  devUrl: string
  /** Built single-file shell — what every window loads in production, and
   *  (via `slidomingo:get-app-shell`) the pristine copy a dev window splices
   *  saves into, since Vite's index.html must never reach a real deck. */
  prodShellPath: string
  /** Built VIEWER-only shell (slides `build:viewer`): what saved decks are
   *  spliced into, so a file carries a viewer and not the editor — the editor
   *  is this app (DECISIONS 2026-10-07). Optional: absent → saves use the
   *  app shell. */
  viewerShellPath?: string
}

/** Where the built slides shells live. Unpackaged: the sibling slides/ build
 *  folders, relative to out/main. Packaged: electron-builder's extraResources
 *  copies them to Resources/slides-dist-single and Resources/slides-dist-viewer
 *  (desktop/package.json) — out/main is then inside app.asar, so the relative
 *  path would point at a Resources/slides/ folder that does not exist. */
const shellFile = (dir: 'dist-single' | 'dist-viewer', name: string): string =>
  app.isPackaged ? join(process.resourcesPath, `slides-${dir}`, name) : resolve(__dirname, '../../../slides', dir, name)

const APPS: Record<string, AppDef> = {
  slides: {
    devUrl: process.env.SLIDOMINGO_DEV_URL || 'http://127.0.0.1:5199',
    prodShellPath: shellFile('dist-single', 'BeeSlides.beeslides.html'),
    viewerShellPath: shellFile('dist-viewer', 'BeeSlides_Viewer.beeslides.html'),
  },
}

const isDev = !app.isPackaged
/** Load the slides dev server rather than the built shell: only under
 *  `electron-vite dev` (which sets ELECTRON_RENDERER_URL, the same signal
 *  terminalPanel.ts uses) or when SLIDOMINGO_DEV_URL names one. A plain
 *  unpackaged `electron .` run — E2E, `electron-vite preview` — boots the
 *  built shell, exactly like a packaged app. */
const useDevServer = isDev && !!(process.env.SLIDOMINGO_DEV_URL || process.env['ELECTRON_RENDERER_URL'])

/** Is `raw` this build's own slides shell — the built file, or the dev
 *  server under `electron-vite dev`? */
export function isAppShellUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (useDevServer) return url.origin === new URL(APPS.slides.devUrl).origin
    return url.protocol === 'file:' && resolve(fileURLToPath(url)) === resolve(APPS.slides.prodShellPath)
  } catch { return false }
}

/** Did this IPC come from the main frame of a doc view running this build's
 *  own shell? Not from a legacy page, a speaker window, a subframe, or
 *  anything a view was navigated to. Every `slidomingo:*` handler requires it
 *  (ipcguard.ts). */
export function isAppShellSender(ev: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (!stateByDocWcId.has(ev.sender.id)) return false
  const frame = ev.senderFrame
  if (!frame || frame.parent) return false
  return isAppShellUrl(frame.url)
}

/** The built shell's bytes, or null when it hasn't been built. */
export function readAppShell(): string | null {
  try { return readFileSync(APPS.slides.prodShellPath, 'utf8') } catch { return null }
}

/** The built viewer-only shell's bytes, or null when it hasn't been built. */
export function readViewerShell(): string | null {
  const path = APPS.slides.viewerShellPath
  if (!path) return null
  try { return readFileSync(path, 'utf8') } catch { return null }
}

/** The start page's "Example deck": the bee explainer from docs/examples.
 *  Packaged, extraResources copies it to Resources/examples (desktop/package.json). */
const EXAMPLE_DECK = 'how-bees-fly.beeslides.html'
export function readExampleDeck(): string | null {
  const path = app.isPackaged ? join(process.resourcesPath, 'examples', EXAMPLE_DECK) : resolve(__dirname, '../../../docs/examples', EXAMPLE_DECK)
  try { return readFileSync(path, 'utf8') } catch { return null }
}

/** Stable, non-reversible id for a file path — same path always gets the same
 *  partition (and backup folder), without exposing the real path in the name. */
export function hashPath(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex').slice(0, 24)
}

/** `persist:` = saved to disk and reused if the SAME path is opened again
 *  later (autosave recovery and version history survive a relaunch). Drafts
 *  get one too, keyed by their draft path, so reopening a draft from the start
 *  page brings its version history back. A draft that is never written has
 *  its partition deleted when the window closes (dropPartition), so an
 *  untouched blank deck leaves nothing behind.
 *  VERIFIED (with a throwaway Electron spike): two windows loading the
 *  IDENTICAL file:// path under different partitions get fully isolated
 *  localStorage + IndexedDB. */
function partitionFor(path: string): string {
  return `persist:doc-${hashPath(path)}`
}

export const draftsDir = (): string => join(app.getPath('userData'), 'Drafts')

// --- draft partition bookkeeping ------------------------------------------------
//
// Chromium can hold a partition's files open until the session is gone, so a
// delete at window close can fail. Every draft partition is recorded here when
// minted; anything whose draft file no longer exists is swept on the next
// launch (sweepDraftPartitions), which is what finally guarantees an untouched
// blank leaves nothing behind.

const draftRegistryPath = (): string => join(app.getPath('userData'), 'draft-partitions.json')

function readDraftRegistry(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(draftRegistryPath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

function writeDraftRegistry(reg: Record<string, string>): void {
  try {
    mkdirSync(dirname(draftRegistryPath()), { recursive: true })
    writeFileSync(draftRegistryPath(), JSON.stringify(reg, null, 2), 'utf8')
  } catch { /* best effort — the sweep just has less to go on */ }
}

function registerDraftPartition(partition: string, draftPath: string): void {
  const reg = readDraftRegistry()
  reg[partition] = draftPath
  writeDraftRegistry(reg)
}

function partitionDir(partition: string): string {
  return join(app.getPath('userData'), 'Partitions', partition.replace(/^persist:/, ''))
}

/** Delete a partition's storage. Returns once the attempt is done; failures
 *  leave the registry entry for the next launch's sweep. */
export async function dropPartition(partition: string): Promise<void> {
  try { await session.fromPartition(partition).clearStorageData() } catch { /* best effort */ }
  try { rmSync(partitionDir(partition), { recursive: true, force: true }) } catch { /* swept next launch */ }
  if (!existsSync(partitionDir(partition))) {
    const reg = readDraftRegistry()
    if (partition in reg) { delete reg[partition]; writeDraftRegistry(reg) }
  }
}

/** Launch-time cleanup of draft partitions whose draft was never written (or
 *  was deleted/moved). Call before any window opens. */
export function sweepDraftPartitions(): void {
  const reg = readDraftRegistry()
  let changed = false
  for (const [partition, draftPath] of Object.entries(reg)) {
    if (existsSync(draftPath)) continue
    try { rmSync(partitionDir(partition), { recursive: true, force: true }) } catch { continue }
    delete reg[partition]
    changed = true
  }
  if (changed) writeDraftRegistry(reg)
}

// --- per-window state ---------------------------------------------------------------

export interface Binding {
  path: string
  kind: 'file' | 'draft'
  /** `template` = a template file opened with Edit Template (a template
   *  window): the renderer runs in template mode and every write must still
   *  be a template (documents.ts writeDocument). Everything else is `deck`. */
  role: 'deck' | 'template'
  /** mtime main last read or wrote (null = a draft not yet on disk). */
  knownMtime: number | null
  /** true after the first successful write this session — gates the session
   *  backup copy and whether a closing draft's partition is kept. */
  wroteThisSession: boolean
}

interface WinState {
  win: BrowserWindow
  docView: WebContentsView
  /** docView's webContents, kept from mount: the view's own getter returns
   *  undefined once the window is gone. */
  docWc: WebContents
  binding: Binding | null
  /** Seed doc-block text for a draft not yet on disk (an import, a template,
   *  a backup). Dropped after the first write — from then on, and for every
   *  bound file, boot text is re-read from disk (launchTextFor), so a 24MB
   *  deck never sits in main's memory for the session. */
  launchText: string | null
  /** The draft this window started on, if any. Its partition is deleted at
   *  close when the draft file doesn't exist by then — never written (an
   *  untouched blank), or moved away by Save As (the live session keeps
   *  using the partition until the window closes). */
  ownedDraft: { path: string; partition: string } | null
  /** From the renderer's `doc-state` reports. */
  dirty: boolean
  /** The deck's docId, once the renderer has reported it — what the terminal
   *  panel's chat history is keyed by (chathistory.ts). */
  docId: string | null
  untouched: boolean
  allowClose: boolean
  closeFlow: Promise<boolean> | null
  /** Set while replaceDocument is leaving this deck for another. */
  swap: Promise<void> | null
  /** Replaced another deck in this window: the renderer says "Opened …"
   *  once (takeAnnounce). */
  announce: boolean
  /** What a new blank draft boots into instead of the start page, read once
   *  (takeStartIntent) — a reload then shows the start page. */
  startIntent: StartIntent | null
  watcher: FSWatcher | null
  watchTimer: ReturnType<typeof setTimeout> | null
  lastNotifiedMtime: number | null
  /** true while documents.ts is writing — fs.watch events are ignored. */
  writing: boolean
  /** The speaker-notes window the doc view opened (present.ts); closed with the deck. */
  speakerWin: BrowserWindow | null
}

const stateByDocWcId = new Map<number, WinState>()
const stateByWinId = new Map<number, WinState>()

const launchPathByWebContentsId = new Map<number, string | null>()

/** The terminal panel's notion of "the folder this deck lives in" — null for
 *  drafts and fresh windows (terminalPanel.ts gives those a scratch dir). */
export function launchPathFor(webContentsId: number): string | null {
  return launchPathByWebContentsId.get(webContentsId) ?? null
}

/** What identifies the deck in a window across renames and Save As: its
 *  docId (once reported) and its bound path — chathistory.ts's DeckKey. */
export function deckKeyFor(docWebContentsId: number): { docId: string | null; path: string | null } {
  const st = stateByDocWcId.get(docWebContentsId)
  return { docId: st?.docId ?? null, path: st?.binding?.path ?? null }
}

export function bindingFor(docWebContentsId: number): Binding | null {
  return stateByDocWcId.get(docWebContentsId)?.binding ?? null
}

/**
 * The doc text a window boots with. Re-read from disk on EVERY call for a
 * file that exists — View ▸ Reload (or a dev reload) must show the file, never
 * a blank deck that autosave would then write over it — and the re-read
 * mtime becomes the known one, since that is now what the renderer holds.
 * A draft not yet on disk gets its seed (or null = blank).
 */
export function launchTextFor(docWebContentsId: number): string | null {
  const st = stateByDocWcId.get(docWebContentsId)
  const b = st?.binding
  if (!st || !b) return null
  if (existsSync(b.path)) {
    const html = readFileSync(b.path, 'utf8')
    b.knownMtime = statSync(b.path).mtimeMs
    st.lastNotifiedMtime = null
    st.launchText = null
    return extractDocBlockText(html)
  }
  return st.launchText
}

/** After the first write the file is the source of truth; drop the seed. */
export function dropSeed(docWebContentsId: number): void {
  const st = stateByDocWcId.get(docWebContentsId)
  if (st) st.launchText = null
}

export function setWriting(docWebContentsId: number, writing: boolean): void {
  const st = stateByDocWcId.get(docWebContentsId)
  if (st) st.writing = writing
}

/** Point a window at a new path (Save As "move", documents.ts). The live
 *  session keeps its partition; a draft's is scheduled for deletion. */
export function rebind(docWebContentsId: number, path: string, mtimeMs: number): void {
  const st = stateByDocWcId.get(docWebContentsId)
  if (!st) return
  const prev = st.binding
  if (prev?.kind === 'draft') {
    try { rmSync(prev.path, { force: true }) } catch { /* best effort */ }
  }
  st.binding = {
    path, kind: isInside(path, draftsDir()) ? 'draft' : 'file', role: prev?.role ?? 'deck', knownMtime: mtimeMs, wroteThisSession: true,
  }
  st.untouched = false
  if (st.binding.kind === 'file') {
    launchPathByWebContentsId.set(docWebContentsId, path)
    st.win.setRepresentedFilename(path)
    if (st.binding.role === 'deck') addRecent(path)
  }
  startWatch(st)
  noteDeckIdentityChanged(st.win)
}

/** A bound file was renamed on disk by main itself (templates.ts
 *  renameTemplate): the window bound to `from`, if any, follows it to `to`
 *  and its renderer is told the new name. The session and partition stay. */
export function rebindPath(from: string, to: string): void {
  const st = stateForPath(from)
  const b = st?.binding
  if (!st || !b) return
  b.path = to
  try { b.knownMtime = statSync(to).mtimeMs } catch { /* checked again at the next write */ }
  st.lastNotifiedMtime = null
  if (launchPathByWebContentsId.get(st.docWc.id)) launchPathByWebContentsId.set(st.docWc.id, to)
  try { st.win.setRepresentedFilename(to) } catch { /* not on this platform */ }
  startWatch(st)
  noteDeckIdentityChanged(st.win)
  if (!st.docWc.isDestroyed()) st.docWc.send('slidomingo:binding-moved', { path: to, name: basename(to) })
}

export function noteDocState(docWebContentsId: number, s: { dirty: boolean; title?: string; untouched?: boolean; docId?: string }): void {
  const st = stateByDocWcId.get(docWebContentsId)
  if (!st) return
  st.dirty = !!s.dirty
  if (typeof s.docId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(s.docId) && s.docId !== st.docId) {
    st.docId = s.docId
    noteDeckIdentityChanged(st.win)
  }
  if (typeof s.untouched === 'boolean') st.untouched = s.untouched
  try {
    st.win.setDocumentEdited(st.dirty)
    if (s.title) st.win.setTitle(s.title)
  } catch { /* window going away */ }
}

/** Paths currently bound to an open window. */
export function openBoundPaths(): Set<string> {
  const out = new Set<string>()
  for (const st of stateByDocWcId.values()) if (st.binding) out.add(resolve(st.binding.path))
  return out
}

function stateForPath(path: string): WinState | null {
  const want = resolve(path)
  for (const st of stateByDocWcId.values()) if (st.binding && resolve(st.binding.path) === want) return st
  return null
}

/** A fresh blank window nobody has typed into — a Finder/CLI open lands in
 *  it rather than in a new window (index.ts). */
export function isUntouchedBlank(win: BrowserWindow): boolean {
  const st = stateByWinId.get(win.id)
  return !!st && st.binding?.kind === 'draft' && !st.binding.wroteThisSession && st.untouched
}

const preloadPath = join(__dirname, '../preload/index.mjs')

/** The document's own webContents for a window. Null once it's destroyed — a
 *  terminal-panel event can arrive between the doc view closing and the
 *  window going away, and `.send` on a destroyed webContents throws. */
export function docWebContentsFor(win: BrowserWindow): WebContents | null {
  const wc = stateByWinId.get(win.id)?.docWc
  return wc && !wc.isDestroyed() ? wc : null
}

/** A docView's own webContents.id → the BrowserWindow that owns it. An
 *  ipcMain handler only sees `event.sender`, and BrowserWindow.fromWebContents()
 *  does not resolve a child WebContentsView back to its parent window. */
export function windowForDocWebContents(webContentsId: number): BrowserWindow | null {
  const st = stateByDocWcId.get(webContentsId)
  return st && !st.win.isDestroyed() ? st.win : null
}

/** Sets docView's bounds to the full content area minus the current
 *  terminal-panel width (0 when there is none, or it's hidden/popped out).
 *  Call after any panel state change, and on the window's own 'resize'. */
export function layoutWindow(win: BrowserWindow): void {
  const st = stateByWinId.get(win.id)
  if (!st) return
  const { width, height } = win.getContentBounds()
  const panelWidth = panelWidthFor(win.id)
  st.docView.setBounds({ x: 0, y: 0, width: Math.max(0, width - panelWidth), height })
  layoutDockedPanel(win, { width, height })
}

/**
 * The permission REQUESTS a document window may make; everything else is
 * refused.
 *
 * - 'local-fonts': forward-compatible insurance for the font picker's
 *   queryLocalFonts() call (slides/src/localfonts.ts). Per
 *   electron/electron#39140, Chromium's local-fonts permission currently
 *   bypasses this handler's dispatch entirely in Electron 33 — but wiring
 *   this now costs nothing and means we're already correct once Electron
 *   catches up.
 * - 'clipboard-read' / 'clipboard-sanitized-write': the context menu's
 *   Copy/Cut/Paste (editor.ts copySelection/pasteFromClipboardAsync) use
 *   navigator.clipboard, which a menu click has no native copy/paste event
 *   to replace. Refusing them made those items fail silently. The page is
 *   our own editor and the user asked for the clipboard by clicking.
 *
 * No setPermissionCheckHandler: with none set, Electron answers every CHECK
 * with "granted", which is what these already get; a handler here would
 * have to re-list every check the page relies on (fullscreen, media…).
 */
const GRANTED_PERMISSIONS = new Set(['local-fonts', 'clipboard-read', 'clipboard-sanitized-write'])

function configureSessionPermissions(sess: Session): void {
  sess.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(GRANTED_PERMISSIONS.has(permission as string))
  })
}

// --- watching the bound file ---------------------------------------------------------
//
// The DIRECTORY is watched, not the file: our own writes are atomic renames,
// which replace the inode a file watcher would be attached to. Events are
// debounced and re-checked with a stat; a change matching the mtime our last
// write recorded is ours and ignored.

function stopWatch(st: WinState): void {
  try { st.watcher?.close() } catch { /* already closed */ }
  st.watcher = null
  if (st.watchTimer) clearTimeout(st.watchTimer)
  st.watchTimer = null
}

function startWatch(st: WinState): void {
  stopWatch(st)
  const b = st.binding
  if (!b || b.kind !== 'file') return
  const name = basename(b.path)
  try {
    st.watcher = watch(dirname(b.path), (_ev, filename) => {
      if (filename && filename !== name) return
      if (st.watchTimer) clearTimeout(st.watchTimer)
      st.watchTimer = setTimeout(() => checkOnDisk(st), 300)
    })
    st.watcher.on('error', () => stopWatch(st))
  } catch { /* unwatchable folder (network share…) — conflicts still caught at write time */ }
}

function checkOnDisk(st: WinState): void {
  const b = st.binding
  if (!b || st.writing || st.docWc.isDestroyed()) return
  let mtimeMs: number | null = null
  try { mtimeMs = statSync(b.path).mtimeMs } catch { /* gone */ }
  if (mtimeMs == null) {
    if (st.lastNotifiedMtime === -1) return
    st.lastNotifiedMtime = -1
    st.docWc.send('slidomingo:file-changed-on-disk', { missing: true })
    return
  }
  if (b.knownMtime == null || Math.abs(mtimeMs - b.knownMtime) <= 1) { st.lastNotifiedMtime = null; return }
  if (st.lastNotifiedMtime === mtimeMs) return
  st.lastNotifiedMtime = mtimeMs
  st.docWc.send('slidomingo:file-changed-on-disk', { changed: true, mtimeMs })
}

// --- close / quit protocol ------------------------------------------------------------
//
// 1. The window's 'close' is prevented and the renderer gets a flush-request.
// 2. It acks at once, then answers with a status once its pending write is on
//    disk. No ack within 3s = no answer; once acked it gets up to 15s (a 24MB
//    deck serializes slowly).
// 3. `clean`/`flushed` → the doc view is closed, then the window.
// 4. Only `failed`/`unsaveable`/no answer shows a native box — Save as… /
//    Don't save / Cancel — whose strings the renderer localized (main-only UI
//    stays English, like menu.ts, when it never answered).

export type FlushStatus = 'clean' | 'flushed' | 'failed' | 'unsaveable'

interface FlushAnswer {
  status: FlushStatus
  strings?: { message?: string; detail?: string; saveAs?: string; dontSave?: string; cancel?: string }
}

const pendingFlush = new Map<string, { ack: () => void; done: (a: FlushAnswer) => void }>()

export function registerFlushIpc(): void {
  onFrom('app-shell', 'slidomingo:flush-ack', (_ev, requestId: string) => pendingFlush.get(requestId)?.ack())
  onFrom('app-shell', 'slidomingo:flush-result', (_ev, msg: { requestId: string } & FlushAnswer) => pendingFlush.get(msg?.requestId)?.done(msg))
}

function askRenderer(st: WinState, kind: 'flush' | 'save-as'): Promise<FlushAnswer | null> {
  const wc = st.docWc
  if (wc.isDestroyed() || wc.isCrashed()) return Promise.resolve({ status: 'clean' })
  const requestId = randomUUID()
  return new Promise((resolveAnswer) => {
    let timer: ReturnType<typeof setTimeout>
    const finish = (a: FlushAnswer | null) => {
      clearTimeout(timer)
      pendingFlush.delete(requestId)
      resolveAnswer(a)
    }
    // save-as waits on a native dialog the user may sit in for a while
    const afterAck = kind === 'save-as' ? 30 * 60_000 : 15_000
    pendingFlush.set(requestId, {
      ack: () => { clearTimeout(timer); timer = setTimeout(() => finish(null), afterAck) },
      done: (a) => finish(a),
    })
    timer = setTimeout(() => finish(null), 3_000)
    try { wc.send('slidomingo:flush-request', { requestId, kind }) } catch { finish({ status: 'clean' }) }
  })
}

/** The flush protocol for leaving a deck — closing its window, or switching
 *  the window to another deck (replaceDocument). Resolves true when it's
 *  safe to go (flushed, or the user chose not to save), false on Cancel. */
async function runLeaveFlow(st: WinState, why: 'close' | 'switch'): Promise<boolean> {
  let answer = await askRenderer(st, 'flush')
  let proceed = answer?.status === 'clean' || answer?.status === 'flushed'
  while (!proceed && !st.win.isDestroyed()) {
    const s = answer?.strings ?? {}
    const canSaveAs = answer != null // a renderer that never answered can't run Save As
    const buttons = canSaveAs
      ? [s.saveAs ?? 'Save As…', s.dontSave ?? 'Don’t Save', s.cancel ?? 'Cancel']
      : [s.dontSave ?? (why === 'close' ? 'Close Without Saving' : 'Continue Without Saving'), s.cancel ?? 'Cancel']
    const { response } = await dialog.showMessageBox(st.win, {
      type: 'warning',
      message: s.message ?? 'This deck could not be saved.',
      detail: s.detail ?? (canSaveAs
        ? 'Your latest changes are not on disk.'
        : 'The window is not responding, so its latest changes may not be on disk.'),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    })
    const choice = canSaveAs ? response : response + 1
    if (choice === 2) return false // Cancel
    if (choice === 1) { proceed = true; break } // Don't save
    answer = await askRenderer(st, 'save-as')
    proceed = answer?.status === 'clean' || answer?.status === 'flushed'
    if (answer === null) return false
  }
  return proceed
}

/** Close a window through the flush protocol. Resolves true once it's closed,
 *  false when the user cancelled. */
export function requestWindowClose(win: BrowserWindow): Promise<boolean> {
  const st = stateByWinId.get(win.id)
  if (!st || win.isDestroyed()) return Promise.resolve(true)
  if (st.closeFlow) return st.closeFlow
  // Mid-switch: let it settle, then close whichever deck the window shows.
  if (st.swap) return st.swap.then(() => requestWindowClose(win))
  st.closeFlow = (async () => {
    const ok = await runLeaveFlow(st, 'close').catch(() => false)
    st.closeFlow = null
    if (!ok || win.isDestroyed()) return win.isDestroyed()
    st.allowClose = true
    const closed = new Promise<boolean>((res) => win.once('closed', () => res(true)))
    try { if (!st.docWc.isDestroyed()) st.docWc.close() } catch { /* already gone */ }
    win.close()
    return closed
  })()
  return st.closeFlow
}

/** Close every window through the flush protocol — the quit path. Resolves
 *  false as soon as the user cancels one (the quit is aborted). */
export async function closeAllWindows(): Promise<boolean> {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!stateByWinId.has(win.id)) continue
    if (!(await requestWindowClose(win))) return false
  }
  return true
}

// --- opening ------------------------------------------------------------------------
//
// OPENING A DECK REPLACES THE WINDOW'S DECK (docs/DECISIONS.md, 2026-09-24,
// amending "a window never swaps decks in place"): every deck is always saved,
// so File ▸ Open…, Recent, the start page, a drop and an import flush the
// current deck (the same protocol as closing) and show the new one in the
// SAME window. A session partition is fixed when a webContents is created and
// partitions are per path, so the swap is a new doc view in the same
// BrowserWindow: unmountDocument + mountDocument. Window-level listeners are
// registered once and look the current state up at event time. The Claude
// Code panel follows the deck: open before the swap → restarted in the new
// deck's folder (a fresh session, `claude`'s cwd can't change); closed → stays
// closed. "Open in New Window" keeps side-by-side possible.

export interface OpenOpts {
  /** Doc-block text to boot a NEW draft with (import, template, backup). */
  seedText?: string
  /** An open terminal panel: `follow` (default) reopens it in the new deck's
   *  folder; `close` leaves it closed (going home — no deck to follow). */
  chat?: 'follow' | 'close'
  /** A new blank draft with a start intent: `default-template` boots
   *  straight into a deck from the default template (File ▸ New from
   *  Default Template); `new-template` opens the start page's Create
   *  template chooser, whose options each write a template and make this
   *  window its template window (File ▸ New Layout…). */
  startIntent?: StartIntent
  /** Open a TEMPLATE file for editing: bind the file itself (role
   *  `template`) instead of starting a new draft based on it. Only the
   *  `slidomingo:edit-template` channel sets it, and only for a path inside
   *  the templates folder (templates.ts). */
  editTemplate?: boolean
}

export type StartIntent = 'default-template' | 'new-template' | 'new-figure' | 'new-iconset'

/** What a path (or null = a new draft) opens as. Resolved before any view
 *  exists, so replaceDocument can send another app's file to a new window
 *  without leaving the current deck first. No side effects: Recent and the
 *  draft registry are written by mountDocument. */
interface Resolved {
  binding: Binding | null
  launchText: string | null
  /** Another app's / a pre-format file: loaded as-is, unbound. */
  legacyLoadPath: string | null
  /** The terminal panel's folder (launchPathFor). */
  launchPath: string | null
  /** Added to Recent once mounted. */
  recent: string | null
  /** A draft minted here (its partition goes into the draft registry). */
  newDraft: boolean
  startIntent: StartIntent | null
}

/**
 * What a file opens as (docfile.ts `openAsFor`):
 * - A slides deck or encrypted deck is BOUND and boots in the current shell.
 * - A template file opens as a NEW draft based on it — unless `editTemplate`
 *   (Edit Template, templates.ts): then the template file itself is bound, in
 *   template mode (role `template`, docs/DECISIONS.md 2026-09-28). It is not
 *   added to Recent: Recent lists decks, templates live on the start page.
 * - A pristine empty shell opens as a new draft.
 * - Anything else (another app's file, a pre-format file) loads as before via
 *   `loadFile(path)` — its own embedded app, no binding, no disk writes, no
 *   preload (sandboxed, without the desktop bridge).
 */
function resolveOpen(path: string | null, opts: OpenOpts): Resolved {
  const r: Resolved = {
    binding: null, launchText: opts.seedText ?? null, legacyLoadPath: null, launchPath: null, recent: null, newDraft: false,
    startIntent: !path && !opts.seedText ? opts.startIntent ?? null : null,
  }
  if (path) {
    if (!existsSync(path)) throw new Error(`no such file: ${path}`)
    const html = readFileSync(path, 'utf8')
    const as = openAsFor(html, { editTemplate: opts.editTemplate })
    if (as === 'deck' || as === 'template') {
      const inDrafts = isInside(path, draftsDir())
      r.binding = {
        path, kind: inDrafts ? 'draft' : 'file', role: as === 'template' ? 'template' : 'deck',
        knownMtime: statSync(path).mtimeMs, wroteThisSession: false,
      }
      r.launchText = extractDocBlockText(html)
      if (!inDrafts) { r.launchPath = path; r.recent = as === 'deck' ? path : null }
    } else if (as === 'from-template') {
      r.launchText = extractDocBlockText(html) // template → a fresh deck based on it
    } else if (as === 'blank') {
      // a pristine shell saved somewhere: just a new deck
    } else {
      r.legacyLoadPath = path
      r.launchPath = path
      r.launchText = null
      r.recent = path
    }
  }
  if (!r.binding && !r.legacyLoadPath) {
    const draftPath = join(draftsDir(), `${randomUUID()}${DOC_EXT}`)
    r.binding = { path: draftPath, kind: 'draft', role: 'deck', knownMtime: null, wroteThisSession: false }
    r.newDraft = true
  }
  return r
}

/** Focus the window already bound to `path`, if any — two windows never
 *  write one file. */
function focusExisting(path: string): BrowserWindow | null {
  const existing = stateForPath(path)
  if (!existing || existing.win.isDestroyed()) return null
  if (existing.win.isMinimized()) existing.win.restore()
  existing.win.focus()
  return existing.win
}

/** Everything per-document: the partition, the doc view, the state maps, the
 *  watcher, and the load. `announce` = it replaced another deck, so the
 *  renderer says "Opened …" once it boots (takeAnnounce). */
function mountDocument(win: BrowserWindow, r: Resolved, opts: { announce?: boolean } = {}): WinState {
  const { binding, launchText, legacyLoadPath, launchPath } = r
  if (r.newDraft && binding) registerDraftPartition(partitionFor(binding.path), binding.path)
  if (r.recent) addRecent(r.recent)
  const partition = partitionFor(binding?.path ?? legacyLoadPath!)
  const sess = session.fromPartition(partition)
  configureSessionPermissions(sess)

  // Another app's / a pre-format file runs its own embedded code: it gets no
  // preload (no `slidomingoDesktop` bridge, so none of main's IPC) and a
  // sandboxed renderer — any .html can be opened here (Finder association,
  // the Open dialog), and only this build's shell is trusted with the bridge.
  const webPreferences: WebPreferences = legacyLoadPath
    ? { session: sess, contextIsolation: true, nodeIntegration: false, sandbox: true }
    : {
        session: sess,
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // personal dev build; revisit before any wider distribution
      }
  const docView = new WebContentsView({ webPreferences })
  win.contentView.addChildView(docView)
  const wc = docView.webContents
  const docWcId = wc.id
  guardNavigation(wc)

  const st: WinState = {
    win, docView, docWc: wc, binding, launchText,
    ownedDraft: binding?.kind === 'draft' ? { path: binding.path, partition } : null,
    dirty: false, docId: null,
    untouched: binding?.kind === 'draft' && binding.knownMtime == null && launchText == null,
    allowClose: false, closeFlow: null, swap: null, announce: !!opts.announce, startIntent: r.startIntent,
    watcher: null, watchTimer: null, lastNotifiedMtime: null, writing: false, speakerWin: null,
  }
  stateByWinId.set(win.id, st)
  stateByDocWcId.set(docWcId, st)
  attachSpeakerOpenHandler(wc, (child) => {
    guardNavigation(child.webContents) // no preload, but an about:blank page with the deck's origin
    st.speakerWin = child
    child.on('closed', () => { if (st.speakerWin === child) st.speakerWin = null })
  })
  launchPathByWebContentsId.set(docWcId, launchPath)
  try {
    win.setRepresentedFilename(binding?.kind === 'file' ? binding.path : '')
    win.setDocumentEdited(false)
  } catch { /* not on this platform */ }
  startWatch(st)
  notifyDocumentsChanged()

  // the remembered UI zoom (uizoom.ts) — on dom-ready, before first paint of the editor
  wc.on('dom-ready', () => applyUiZoom(wc))
  wc.on('did-finish-load', () => {
    if (wc.isDestroyed()) return
    wc.send('slidomingo:open-path', launchPath)
    wc.send('slidomingo:fullscreen-state', { fullscreen: win.isFullScreen() })
  })

  if (isDev) {
    // Surface renderer console + load failures on the terminal running
    // `npm run dev`. Guarded: a console write whose pipe went away (EPIPE,
    // `npm run dev-all`) must never crash the main process — desktop/CLAUDE.md.
    const logRenderer = (...args: unknown[]) => { try { console.log(...args) } catch { /* pipe gone, best effort */ } }
    const logRendererError = (...args: unknown[]) => { try { console.error(...args) } catch { /* pipe gone, best effort */ } }
    wc.on('console-message', (_e, _level, message) => logRenderer('[renderer]', message))
    wc.on('did-fail-load', (_e, code, desc) => logRendererError('[renderer] load failed', code, desc))
  }

  if (legacyLoadPath) {
    void wc.loadFile(legacyLoadPath)
  } else if (useDevServer) {
    void wc.loadURL(APPS.slides.devUrl)
  } else {
    void wc.loadFile(APPS.slides.prodShellPath)
  }
  return st
}

/** Undo mountDocument: stop watching, close the doc view's renderer (a
 *  WebContentsView's webContents is NOT destroyed with its window — without
 *  this every closed window or swapped deck left a live renderer behind),
 *  detach it, forget it, and drop a draft partition that was never written. */
function unmountDocument(st: WinState): void {
  stopWatch(st)
  const wc = st.docWc
  const docWcId = wc.id
  try { if (st.speakerWin && !st.speakerWin.isDestroyed()) st.speakerWin.close() } catch { /* already gone */ }
  st.speakerWin = null
  try { if (!wc.isDestroyed()) wc.close() } catch { /* already gone */ }
  try { if (!st.win.isDestroyed()) st.win.contentView.removeChildView(st.docView) } catch { /* window gone */ }
  if (stateByWinId.get(st.win.id) === st) stateByWinId.delete(st.win.id)
  stateByDocWcId.delete(docWcId)
  launchPathByWebContentsId.delete(docWcId)
  if (st.ownedDraft && !existsSync(st.ownedDraft.path)) void dropPartition(st.ownedDraft.partition)
  notifyDocumentsChanged()
}

/** A window's doc view was mounted or unmounted (open, swap, Start Page,
 *  close). The native menu is drawn from the FOCUSED window's current deck,
 *  so it rebuilds on this (menu.ts). A callback list rather than an import:
 *  menu.ts already imports this module. */
const documentsChangedListeners = new Set<() => void>()
export function onDocumentsChanged(cb: () => void): void { documentsChangedListeners.add(cb) }
function notifyDocumentsChanged(): void {
  for (const cb of documentsChangedListeners) cb()
}

/** Read once: did this doc view replace another deck (→ "Opened …")? */
export function takeAnnounce(docWebContentsId: number): boolean {
  const st = stateByDocWcId.get(docWebContentsId)
  if (!st?.announce) return false
  st.announce = false
  return true
}

/** Read once: what this blank draft boots into instead of the start page. */
export function takeStartIntent(docWebContentsId: number): StartIntent | null {
  const st = stateByDocWcId.get(docWebContentsId)
  const intent = st?.startIntent ?? null
  if (st) st.startIntent = null
  return intent
}

/** The last-used window's size/position (settings.windowState), cascaded so
 *  a second window doesn't sit exactly on the first, and dropped when its
 *  screen is gone. Defaults to the old fixed 1400×900. */
function startingBounds(): { x?: number; y?: number; width: number; height: number; maximized: boolean; fullscreen: boolean } {
  const s = readSettings().windowState
  if (!s || !(s.width >= 400) || !(s.height >= 300)) return { width: 1400, height: 900, maximized: false, fullscreen: false }
  const out = { ...s }
  if (typeof s.x === 'number' && typeof s.y === 'number') {
    const n = allDocumentWindows().length
    const x = s.x + 26 * n, y = s.y + 26 * n
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return x < a.x + a.width - 80 && x + s.width > a.x + 80 && y >= a.y - 10 && y < a.y + a.height - 80
    })
    if (onScreen) { out.x = x; out.y = y } else { delete out.x; delete out.y }
  }
  return out
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed() || !win.isVisible()) return
  const maximized = win.isMaximized()
  const fullscreen = win.isFullScreen()
  // Normal bounds, so un-maximizing / leaving full screen later has a size to go back to.
  const b = win.getNormalBounds()
  updateSettings({ windowState: { x: b.x, y: b.y, width: b.width, height: b.height, maximized, fullscreen } })
}

function openInNewWindow(r: Resolved): BrowserWindow {
  const start = startingBounds()
  const win = new BrowserWindow({
    width: start.width,
    height: start.height,
    ...(start.x !== undefined && start.y !== undefined ? { x: start.x, y: start.y } : {}),
    show: false,
    // Native title bar merge (beeslides/slides editor/titlebar.ts): hide the OS
    // title bar and overlay the traffic lights on our own chrome instead of
    // stacking a second bar below it. hiddenInset does NOT shrink the
    // content area — layoutWindow's bounds math below needs no change.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } }
      // Windows/Linux: no in-window menu bar — the editor's ☰ button pops the
      // application menu up instead (menu.ts popup-app-menu). The application
      // menu stays SET, so its accelerators keep working with the bar hidden.
      : { autoHideMenuBar: true }),
    // Matches --chrome (light theme, slides/src/styles.css) — avoids a
    // white/wrong-theme flash before the renderer's own CSS paints.
    backgroundColor: '#FAF7F1',
  })
  const winId = win.id
  if (process.platform !== 'darwin') win.setMenuBarVisibility(false)

  // Registered ONCE per window: each looks up the window's CURRENT deck, which
  // replaceDocument may have swapped since.
  // Linux (GTK, X11 and Wayland): maximize, restore and full screen often fire
  // 'resize' before getContentBounds has the new size, or not at all — the doc
  // view stayed at its old width with the rest of the window white. Lay out
  // on those events too, and again once the window manager has settled.
  let relayoutTimer: ReturnType<typeof setTimeout> | null = null
  const relayout = () => {
    layoutWindow(win)
    if (process.platform === 'darwin') return
    if (relayoutTimer) clearTimeout(relayoutTimer)
    relayoutTimer = setTimeout(() => { relayoutTimer = null; if (!win.isDestroyed()) layoutWindow(win) }, 120)
  }
  win.on('resize', relayout)
  win.on('maximize', relayout)
  win.on('unmaximize', relayout)
  win.on('restore', relayout)
  win.on('enter-full-screen', relayout)
  win.on('leave-full-screen', relayout)
  win.on('show', relayout)
  win.on('closed', () => { if (relayoutTimer) clearTimeout(relayoutTimer) })
  let stateTimer: ReturnType<typeof setTimeout> | null = null
  const rememberState = () => {
    if (stateTimer) clearTimeout(stateTimer)
    stateTimer = setTimeout(() => saveWindowState(win), 400)
  }
  win.on('resize', rememberState)
  win.on('move', rememberState)
  win.on('maximize', rememberState)
  win.on('unmaximize', rememberState)
  win.on('enter-full-screen', rememberState)
  win.on('leave-full-screen', rememberState)
  win.on('close', () => { if (stateTimer) clearTimeout(stateTimer); saveWindowState(win) })
  // macOS: hovering the top edge in native fullscreen reveals the menu bar AND
  // the traffic lights, which would float over our title bar (its left gutter
  // is collapsed in fullscreen). Hide the buttons there; the menu bar still works.
  win.on('enter-full-screen', () => {
    if (process.platform === 'darwin') win.setWindowButtonVisibility(false)
    docWebContentsFor(win)?.send('slidomingo:fullscreen-state', { fullscreen: true })
  })
  win.on('leave-full-screen', () => {
    if (process.platform === 'darwin') win.setWindowButtonVisibility(true)
    docWebContentsFor(win)?.send('slidomingo:fullscreen-state', { fullscreen: false })
  })
  win.on('close', (ev) => {
    const st = stateByWinId.get(winId)
    // A legacy (unbound) window has nothing main could flush.
    if (!st || st.allowClose || !st.binding) return
    ev.preventDefault()
    void requestWindowClose(win)
  })
  win.on('closed', () => {
    const st = stateByWinId.get(winId)
    stateByWinId.delete(winId)
    // Otherwise a docked (or popped-out) terminal panel's pty/shell/claude
    // process would outlive the window it belonged to — verified as a real
    // leak: closing the host window left `claude` running.
    disposeTerminalPanel(winId)
    if (st) unmountDocument(st)
  })

  const st = mountDocument(win, r)
  layoutWindow(win)
  // 'ready-to-show' is tied to the WINDOW's own implicit webContents, which
  // this shell never navigates now that docView carries the content. Show
  // once the doc view itself has painted instead.
  st.docWc.once('did-finish-load', () => {
    win.show()
    if (start.fullscreen) win.setFullScreen(true)
    else if (start.maximized) win.maximize()
  })
  return win
}

/**
 * Open a document in a NEW window. `path` is an absolute path to a
 * `.beeslides.html` file, or null for a fresh untitled deck (a new draft). A
 * path that is already open focuses that window instead.
 */
export function createDocumentWindow(path: string | null, opts: OpenOpts = {}): BrowserWindow {
  if (path) {
    path = resolve(path)
    const existing = focusExisting(path)
    if (existing) return existing
  }
  return openInNewWindow(resolveOpen(path, opts))
}

/**
 * Show `path` (or, with a null path, a new draft seeded with `opts.seedText`)
 * in `win`, in place of its deck. Resolves to the window that now shows it:
 * `win`; another window already bound to the path (focused, nothing swapped);
 * a new window for another app's file (it can't boot in this shell); or null
 * when the user cancelled leaving the current deck.
 */
export async function replaceDocument(win: BrowserWindow, path: string | null, opts: OpenOpts = {}): Promise<BrowserWindow | null> {
  const old = stateByWinId.get(win.id)
  if (!old || win.isDestroyed()) return createDocumentWindow(path, opts)
  if (path) {
    path = resolve(path)
    const existing = focusExisting(path)
    if (existing) return existing
  }
  if (old.swap || old.closeFlow) return null // already leaving this deck
  const r = resolveOpen(path, opts)
  if (r.legacyLoadPath) return openInNewWindow(r)

  let settle!: () => void
  old.swap = new Promise<void>((res) => { settle = res })
  try {
    // A legacy (unbound) page has nothing to flush and doesn't speak the protocol.
    const ok = !old.binding || await runLeaveFlow(old, 'switch').catch(() => false)
    if (!ok || win.isDestroyed() || stateByWinId.get(win.id) !== old) return null
    if (path) {
      const existing = focusExisting(path) // opened elsewhere meanwhile
      if (existing) return existing
    }
    const terminalWasOpen = isTerminalPanelOpen(win.id)
    const reopenTerminal = terminalWasOpen && (opts.chat ?? 'follow') === 'follow'
    // Sends agent-session-closed for each session first, so the old
    // renderer releases its slide locks.
    if (hasTerminalPanel(win.id)) disposeTerminalPanel(win.id)
    unmountDocument(old)
    const st = mountDocument(win, r, { announce: true })
    layoutWindow(win)
    if (reopenTerminal) {
      // Reopened docked, with the new deck's folder as cwd (launchPathFor) —
      // a draft gets its scratch dir.
      st.docWc.once('did-finish-load', () => {
        if (!win.isDestroyed() && stateByWinId.get(win.id) === st) void toggleTerminalPanel(win)
      })
    }
    return win
  } finally {
    old.swap = null
    settle()
  }
}

/** File ▸ Start Page: this window's deck is flushed and replaced by a new
 *  blank draft, which boots to the start page (no launch text — main.ts). The
 *  chat closes: there is no deck for it to follow. An untouched blank's
 *  draft partition is dropped when the start page opens something else
 *  (unmountDocument). */
export function goHome(win: BrowserWindow): Promise<BrowserWindow | null> {
  return replaceDocument(win, null, { chat: 'close' })
}

/** Is `from` a window showing a document (not a terminal pop-out, not gone)? */
function isDocumentWindow(from: BrowserWindow | null): from is BrowserWindow {
  return !!from && !from.isDestroyed() && stateByWinId.has(from.id)
}

/** The router for File ▸ Open…, Recent, the start page and drops: the first
 *  path replaces `from`'s deck when `from` is a document window, the rest (or
 *  all of them, with `newWindow`) open in new windows. A path already open
 *  anywhere just focuses its window. */
export async function openPathsFrom(from: BrowserWindow | null, paths: string[], opts: { newWindow?: boolean } = {}): Promise<BrowserWindow[]> {
  const opened: BrowserWindow[] = []
  let replaceIn = !opts.newWindow && isDocumentWindow(from) ? from : null
  for (const p of paths) {
    const target = replaceIn
    replaceIn = null
    try {
      const win = target ? await replaceDocument(target, p) : createDocumentWindow(p)
      if (win) opened.push(win)
    } catch (err) {
      try { console.error('[open] failed:', err) } catch { /* pipe gone */ }
    }
  }
  return opened
}

/** Imports and "Duplicate as new deck": a new draft seeded with this doc
 *  text, in place of `from`'s deck (or a new window). The draft is written
 *  on its first autosave, edit or not. */
export async function openSeededInWindow(from: BrowserWindow | null, seedText: string, opts: { newWindow?: boolean } = {}): Promise<BrowserWindow | null> {
  if (!opts.newWindow && isDocumentWindow(from)) return replaceDocument(from, null, { seedText })
  return createDocumentWindow(null, { seedText })
}

/** The focused window when it shows a document — null when the focus is on a
 *  terminal pop-out, the speaker window or nothing. Menu commands act on this
 *  window's deck and terminal panel; a pop-out handed in here got a hidden,
 *  zero-size panel of its own with a live `claude` that outlived it. */
export function focusedDocumentWindow(): BrowserWindow | null {
  const win = BrowserWindow.getFocusedWindow()
  return isDocumentWindow(win) ? win : null
}

/** Every window showing a document — not a terminal pop-out, a speaker
 *  window or a hidden thumbnail renderer. */
export function allDocumentWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(isDocumentWindow)
}

/** The documents worth offering back after a restart: every window bound to a
 *  real deck (file or draft with content), not an untouched blank / start page
 *  or a template window. Taken at quit, BEFORE the windows close. */
export function sessionSnapshot(): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = []
  for (const win of BrowserWindow.getAllWindows()) {
    const st = stateByWinId.get(win.id)
    if (!st?.binding || st.binding.role !== 'deck' || isUntouchedBlank(win)) continue
    if (out.some((o) => o.path === st.binding!.path)) continue
    out.push({ path: st.binding.path, name: win.getTitle() || basename(st.binding.path) })
  }
  return out
}
