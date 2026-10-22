// Main process entry. Owns window/menu/file-association/recent-docs
// lifecycle; document reads/writes live in documents.ts (see windows.ts's
// doc comment for why main now touches deck bytes). Personal dev build: no
// code signing, no notarization, no auto-updater.
import { hasDocExt } from '../../../kernel/src/docext.ts'
import { app, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readSettings, updateSettings } from './settings.ts'
import { registerViewerPrefIpc } from './viewerprefs.ts'
import { registerAiProfileIpc } from './aiprofilesStore.ts'
import { registerIconTokenIpc } from './icontokens.ts'
import { registerCustomizeChatIpc, registerUiProfileIpc } from './uiprofile.ts'
import {
  createDocumentWindow, launchPathFor, allDocumentWindows, windowForDocWebContents,
  closeAllWindows, openPathsFrom, focusedDocumentWindow, registerFlushIpc, sweepDraftPartitions, isUntouchedBlank, sessionSnapshot,
  isAppShellUrl,
} from './windows.ts'
import { handleFrom, onFrom } from './ipcguard.ts'
import { installDefaultGuards, openExternalFromUser } from './navguard.ts'
import { registerDocumentIpc, pruneAllBackups } from './documents.ts'
import { registerFigureIpc } from './figureexport.ts'
import { registerPresentIpc } from './present.ts'
import { registerPictureIpc } from './pictures.ts'
import { buildMenu, registerMenuIpc } from './menu.ts'
import { registerAgentBridgeIpc } from './agentbridge.ts'
import { registerAgentExec } from './agentexec.ts'
import { refreshAgentEndpointServer, startAgentEndpoint, stopAgentEndpoint } from './agentendpoint.ts'
import { claudeWorkspacesRoot, isTerminalRendererUrl, isValidGenerateRequest, registerTerminalIpc, requestGenerate, toggleTerminalPanel } from './terminalPanel.ts'
import { sweepWorkspaces } from './workspaces.ts'
import { addRecent, listRecent, pinRecent, removeRecent } from './recent.ts'
import { registerTemplateIpc } from './templates.ts'
import { registerLibraryIpc } from './library.ts'
import { registerThumbnailIpc } from './thumbs.ts'

// E2E/isolation overrides (desktop/scripts/e2e-*.mjs): a throwaway profile
// must be set before anything reads userData — including the single-instance
// lock below, so a test instance never collides with the user's running app.
//
// Otherwise userData is PINNED, so a rename never silently loses recent
// files, drafts, backups, thumbnails and the draft partitions: installed
// (packaged) builds use "BeeSlides" — the first public install, `npm run
// setup` (DECISIONS.md 2026-10-13); unpackaged dev runs keep the folder
// they used before the BeeSlides rename, "slidomingo-desktop" (2026-09-28),
// so the two never share a profile or a single-instance lock. Set before
// app.setName below, which would otherwise move it too.
if (process.env.SLIDOMINGO_USER_DATA) app.setPath('userData', process.env.SLIDOMINGO_USER_DATA)
else app.setPath('userData', join(app.getPath('appData'), app.isPackaged ? 'BeeSlides' : 'slidomingo-desktop'))
// Packaged builds already take productName from package.json; an unpackaged
// run would show the npm package name in the app menu (Hide/Quit …).
if (!app.isPackaged) app.setName('BeeSlides (dev)')

// A broken stdout/stderr pipe (npm run dev-all's orchestrator going away
// mid-session, or any other reader disappearing) surfaces as an 'error'
// event on the stream itself, NOT a synchronous throw from the console.*
// call that triggered the write — so the per-call try/catch already used
// around every console.log/console.error in this app's main process
// (windows.ts's docView instrumentation, terminalPanel.ts's
// wireDevDiagnostics) cannot catch it: the write is queued, console.log
// returns normally, and EPIPE arrives on a later tick as an uncaught
// exception. This is Node's own documented fix (nodejs/node#947) — an
// 'error' listener on the stream absorbs it before it can crash the
// process, independent of which call site produced the write.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err
  })
}

// Belt-and-suspenders backstop: the stream-level listener above should be
// sufficient, but this exact crash survived a first attempt at fixing it
// (a per-call try/catch that assumed a synchronous throw), so don't trust
// any single layer here. Whatever internal path an EPIPE from a dead
// stdout/stderr pipe takes to become an uncaught exception, swallow it at
// the process level too — the alternative is losing the whole app over a
// best-effort debug log. Anything that ISN'T an EPIPE is a real bug:
// registering this handler suppresses Node's default crash-and-exit, so we
// have to do that ourselves for everything else.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return
  try { console.error('[uncaughtException]', err) } catch { /* pipe gone too */ }
  app.exit(1)
})

// Registers an ipcMain.handle whose promise can NEVER reject. A rejected
// ipcMain.handle promise is caught by Electron's own internal
// error-reporting path, which logs via console.warn — and in this app's
// environment that write can itself throw EIO, crashing the whole main
// process over what should be a recoverable, best-effort failure (see
// terminalPanel.ts's openPanel and templates.ts's saveTemplateFile, the two
// confirmed instances of this landmine). Those two functions are already
// fixed at their own try/catch boundary; this wrapper is a second, general
// line of defense for their ipcMain.handle registrations. App-shell callers
// only, like every `slidomingo:*` channel (ipcguard.ts).
// Not applied to every registration below: the untouched ones return typed
// arrays/objects their renderer callers assume are always present, and
// swallowing a failure into `undefined` there would trade a rare crash for
// a silent type mismatch — a broader audit is a reasonable follow-up, not
// something to force here.
function safeHandle<T>(
  channel: string,
  fn: (ev: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>,
): void {
  handleFrom('app-shell', channel, async (ev, ...args) => {
    try {
      return await fn(ev, ...args)
    } catch (err) {
      try { console.error(`[ipc] ${channel} failed:`, err) } catch { /* pipe gone */ }
      return undefined
    }
  })
}

/** A Finder / second-instance open: a new window, like any document app —
 *  unless the focused window is an untouched blank (the start page), which
 *  simply becomes the deck. In-app opens replace instead (windows.ts). */
function openFromOs(path: string): void {
  const from = focusedDocumentWindow()
  void openPathsFrom(from, [path], { newWindow: !from || !isUntouchedBlank(from) })
}

// macOS delivers a double-clicked/dragged .beeslides.html via 'open-file', but
// ONLY if the listener is registered before the app is ready.
const macLaunchPaths: string[] = []
app.on('open-file', (ev, path) => {
  ev.preventDefault()
  if (app.isReady()) openFromOs(path)
  else macLaunchPaths.push(path)
})

// Windows/Linux: no 'open-file' event — the path arrives as an argv entry,
// both on first launch and (via second-instance, below) on every later
// double-click while the app is already running.
function pathFromArgv(argv: string[]): string | null {
  // `--open <path>` works on every platform (the CLI and E2E use it; macOS
  // Finder opens still arrive via 'open-file').
  const i = argv.indexOf('--open')
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  // argv[0] is the electron binary; a packaged app's argv[0] is itself.
  // Skip flags (electron-vite/dev tooling can prepend --inspect etc.).
  const arg = argv.slice(app.isPackaged ? 1 : 2).find((a) => hasDocExt(a) || a.endsWith('.html'))
  return arg ?? null
}

// Deny-by-default for every webContents (navguard.ts): no window.open unless
// a view allows one itself, no navigation off the app's own pages. Before any
// window exists, so nothing is ever created unguarded.
installDefaultGuards((url) => isAppShellUrl(url) || isTerminalRendererUrl(url) || url.startsWith('devtools:'))

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Every unpackaged run shares one userData folder, so a second `npm run
  // dev` / `npx electron .` would otherwise vanish without a word while the
  // first instance takes focus. scripts/dev-all.mjs keys off this line.
  if (!app.isPackaged) {
    try { process.stderr.write('another instance with this userData is running; focusing it instead\n') } catch { /* best-effort */ }
  }
  app.quit()
} else {
  app.on('second-instance', (_ev, argv) => {
    const path = pathFromArgv(argv)
    if (path) openFromOs(path)
    else {
      const existing = allDocumentWindows()[0]
      if (existing) { if (existing.isMinimized()) existing.restore(); existing.focus() }
      else createDocumentWindow(null)
    }
  })

  void app.whenReady().then(() => {
    // An unpackaged run has no bundle icon, so the Dock shows Electron's. Packaged
    // builds get the mark from build/icon.png via electron-builder instead.
    if (!app.isPackaged && process.platform === 'darwin') {
      try { app.dock?.setIcon(join(app.getAppPath(), 'build', 'icon.png')) } catch { /* cosmetic only */ }
    }
    sweepDraftPartitions()
    pruneAllBackups()
    sweepWorkspaces(claudeWorkspacesRoot())
    registerMenuIpc()
    buildMenu()
    registerTerminalIpc()
    registerAgentBridgeIpc()
    registerAgentExec(refreshAgentEndpointServer)
    registerDocumentIpc()
    registerFigureIpc()
    registerPresentIpc()
    registerPictureIpc()
    registerFlushIpc()
    registerViewerPrefIpc()
    registerAiProfileIpc()
    registerIconTokenIpc()
    registerUiProfileIpc()
    registerCustomizeChatIpc()
    registerThumbnailIpc()
    // Outside AI apps reach the open decks through this (agentendpoint.ts;
    // BEESLIDES_AGENT_ENDPOINT=1 for now).
    startAgentEndpoint()

    handleFrom('app-shell', 'slidomingo:get-launch-path', (ev) => launchPathFor(ev.sender.id))

    // A web or mail link the user clicked in the doc view (the preload's
    // click handler, or present mode's — slides/src/present.ts). Main
    // re-checks the scheme and that the page has a user activation right
    // now (navguard.ts); a window.open of a link is denied (present.ts).
    handleFrom('app-shell', 'slidomingo:open-external', (ev, url: unknown) => openExternalFromUser(ev.sender, url))

    // Docks/undocks the Claude Code terminal panel for the window that owns
    // the sending docView — a pure adapter over toggleTerminalPanel, which
    // already relayouts internally (see terminalPanel.ts).
    safeHandle('slidomingo:toggle-terminal', async (ev) => {
      const win = windowForDocWebContents(ev.sender.id)
      if (win) await toggleTerminalPanel(win)
    })

    // startuppicker.ts's AI paths (Describe it, PowerPoint with AI…) — see
    // terminalPanel.ts's requestGenerate for what 'launched' vs 'queued'
    // means to the renderer. A malformed request (or a pptx path that is
    // not an existing .pptx/.potx file) rejects.
    handleFrom('app-shell', 'slidomingo:request-generate', async (ev, request: unknown) => {
      if (!isValidGenerateRequest(request)) throw new Error('invalid generate request')
      const win = windowForDocWebContents(ev.sender.id)
      if (!win) return { status: 'queued' } as const
      return requestGenerate(win, request)
    })

    // Start-page Open Recent list (startuppicker.ts) — mirrors the
    // native menu's own list; both read the same recent.ts store.
    handleFrom('app-shell', 'slidomingo:list-recent', () => listRecent())
    onFrom('app-shell', 'slidomingo:remove-recent', (_ev, path: string) => { if (typeof path === 'string') removeRecent(path) })
    onFrom('app-shell', 'slidomingo:pin-recent', (_ev, path: string, pinned: boolean) => { if (typeof path === 'string') pinRecent(path, !!pinned) })
    // Older aliases of documents.ts's slidomingo:open-document: both replace
    // the caller's deck now (windows.ts replaceDocument).
    onFrom('app-shell', 'slidomingo:open-recent', (ev, path: string) => {
      if (typeof path === 'string') void openPathsFrom(windowForDocWebContents(ev.sender.id), [path])
    })
    onFrom('app-shell', 'slidomingo:open-recent-replacing', (ev, path: string) => {
      if (typeof path === 'string') void openPathsFrom(windowForDocWebContents(ev.sender.id), [path])
    })

    // In-app Open…/⌘O and a first Save both resolve a path via
    // webUtils.getPathForFile (preload) and report it here — the two gaps
    // windows.ts's own addRecent (Finder/Dock opens only) never covered.
    onFrom('app-shell', 'slidomingo:record-recent', (_ev, path: string) => addRecent(path))

    // Template registry (start picker, Save as Template, template updates) —
    // the templates folder itself is the registry, see templates.ts.
    registerTemplateIpc()
    // The global element library (library.ts): a user-wide registry, not
    // part of any deck — the default file is created here on first run.
    registerLibraryIpc()

    // Through openPathsFrom, which catches per path: createDocumentWindow
    // throws for a missing/unreadable file (`--open` typo, a file deleted
    // before launch), and that used to escape this callback — no window at
    // all, and the remaining Finder paths skipped. Nothing opened → the
    // usual blank window.
    const initialPath = pathFromArgv(process.argv)
    const launchPaths = macLaunchPaths.length ? macLaunchPaths.splice(0) : initialPath ? [initialPath] : []
    if (launchPaths.length) {
      void openPathsFrom(null, launchPaths).then((opened) => { if (!opened.length) createDocumentWindow(null) })
    } else {
      restoreSession()
    }
  })

  // Quit goes through every window's flush protocol (windows.ts): pending
  // edits land on disk first, and only a failed/unsaveable one asks. A
  // cancelled box aborts the quit.
  let quitting = false
  app.on('before-quit', (ev) => {
    if (quitting) return
    ev.preventDefault()
    // What was open, taken before the windows go — reopened next launch.
    const open = sessionSnapshot()
    void closeAllWindows().then((ok) => {
      if (!ok) return
      updateSettings({ session: open.length ? open : undefined })
      quitting = true
      app.quit()
    })
  })

  app.on('will-quit', () => stopAgentEndpoint())

  // Under `npm run dev` (scripts/dev-all.mjs) closing the last window ends
  // the app on macOS too, and with it the whole dev stack.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || process.env.SLIDOMINGO_DEV_ALL === '1') app.quit()
  })

  app.on('activate', () => {
    // documents only: a hidden thumbnail renderer is a window too
    if (allDocumentWindows().length === 0) createDocumentWindow(null)
  })
}

/** Cold launch without a file: reopen what the last quit left open (missing
 *  files dropped); nothing to restore → the usual blank/start-page window.
 *  Single-use: the record is cleared as soon as it's read. */
function restoreSession(): void {
  const saved = (readSettings().session ?? []).filter((s) => existsSync(s.path))
  updateSettings({ session: undefined })
  if (!saved.length) { createDocumentWindow(null); return }
  for (const s of saved) createDocumentWindow(s.path)
}
