# desktop/ — Electron shell

Electron shell around `slides/`; see the root `AGENTS.md` for the repo map and hard rules.

## Running and testing

- Desktop e2e (`desktop/scripts/e2e-*.mjs`) opens real windows and steals focus: do not run it unless the user asks. `npm test` is fine.
- Main-process changes (IPC handlers, menu) need a full `npm run dev` restart; `electron-vite dev` runs without `-w`, so a new window only picks up the new renderer and preload. Symptom: the renderer calls a handler that main lacks.
- Only one unpackaged instance can run at a time: all unpackaged runs share userData `slidomingo-desktop`, and a second instance focuses the first one and quits. Find the holder with `readlink ~/Library/Application\ Support/slidomingo-desktop/SingletonLock`. Use `SLIDOMINGO_USER_DATA` to run a second instance.
- Isolate a run with `SLIDOMINGO_USER_DATA`, `SLIDOMINGO_TEMPLATES_DIR`, `SLIDOMINGO_LIBRARY_PATH`, and `SLIDOMINGO_UI_PROFILE_PATH`. `--open <path>` works everywhere.
- Unpackaged runs load the built shell unless they run under `electron-vite dev` or `SLIDOMINGO_DEV_URL` is set.
- Electron e2e drivers launch the Electron entry directly. playwright-core's `_electron.launch` hangs on this app, and an ESM Electron entry must not use top-level await (`ready` deadlocks). Copy the pattern in `scripts/e2e-autosave.mjs`.
- In e2e, use `wc.executeJavaScript(code, true)` for a user gesture and `sendInputEvent` for a trusted click. A synthetic `dispatchEvent` click counts as neither.
- In tests, count document windows by their doc views: start-page thumbnails render in hidden BrowserWindows of their own.
- Worktrees installed with `--ignore-scripts` need `node_modules/electron/dist` and `path.txt` copied from a full install. They also need `node scripts/rebuild-pty.mjs` before any e2e run ("posix_spawnp failed" = spawn-helper lost its exec bit).
- Code imported by node unit tests (strip-types) must not use TS parameter properties or enums, and must import with `.ts` specifiers.
- `e2e-api-chat.mjs` needs `npx electron-vite build` and `slides/dist-single` first.

## Windows, files, documents (DECISIONS 2026-09-24)

- Every window boots the CURRENT app shell and receives its deck over IPC. Main writes the deck back to the window's bound file or draft (`windows.ts` bindings and the close/quit flush). The renderer side is `slides/src/editor/desktopdoc.ts`.
- Save and Save As splice into the editor shell, so saved files stay editable. File ▸ Export writes the viewer shell (`readViewerShell`).
- Opening a deck replaces the window's deck: `runLeaveFlow` flushes first, then `replaceDocument` creates a NEW doc view in the same BrowserWindow, because the session partition is fixed per webContents. ⇧⌘O, ⌘/⌥-click, or `{newWindow:true}` open a new window instead.
- Register window-level listeners once and resolve `stateByWinId` when the event fires; never close over a `WinState`.
- Use `WinState.docWc`, not `docView.webContents`: that getter returns undefined once the window is gone.
- On deck replace, an open terminal panel is disposed and reopened in the new deck's folder.
- Template windows (`Binding.role: 'template'`, only via `slidomingo:edit-template`, only for paths inside the templates folder) accept template writes only, never enter Recent, and follow renames (`rebindPath` → `slidomingo:binding-moved`).
- The UI says "layout" and "slide type"; code, IPC, the format, and the "Slidomingo Templates" folder keep "template" (DECISIONS 2026-09-30).
- App-wide settings live in main's `settings.ts`. Renderer localStorage is per deck.
- Bump `THUMB_CACHE_VERSION` (`thumbscan.ts`) when the look of thumbnails changes.
- Global library: there is ONE file per user (`libraryfs.ts`). Write only to that path, and only a complete slides shell.

## IPC and security (DECISIONS 2026-10-08)

- Register EVERY ipcMain handler through `ipcguard.ts` `handleFrom/onFrom('app-shell' | 'terminal', …)`: `slidomingo:*` for the app shell, `terminal:*`/`chat:*` for the terminal renderer. `test-desktop-ipc-guard.mjs` fails on a bare `ipcMain.handle/.on`.
- Refusals resolve to `{ refused: true, error }` and never throw.
- Every webContents denies `window.open` and off-app navigation (`navguard.ts installDefaultGuards`). Only the doc view has a popup handler, for the `slidomingo-speaker` frame, which gets NO preload.
- External links open only from a real click: `slidomingo:open-external` requires live user activation, and a followed link must match the last trusted click (isolated world 1077).
- Wrap every new bare `console.*` call in main-process code in try/catch. It has crashed main with EIO/EPIPE several times. Never remove the EPIPE `uncaughtException` and stream `'error'` backstops in `index.ts`.

## Claude terminal panel

- `claude` runs in a pty per window, in the app-owned workspace `userData/claude-workspaces/<docId>` (`workspaces.ts`). It must NEVER run in the deck's folder, whose CLAUDE.md, hooks, and git must not become the project.
- The deck folder and attached folders reach `claude` only through env vars (`--add-dir "$SLIDOMINGO_DECK_DIR"`, `"$SLIDOMINGO_ADD_DIR_<n>"`). Never splice paths or file names into the shell line or `generateTask`.
- A profile's `command` is the only user-controlled text in the launch line (`claudeLaunch.ts`). Keep it behind `isValidCommand`.
- `claude` honours only the LAST `--settings`, so `createSession` merges a profile's `settingsFile` into the session settings.
- Validate generate requests in main (`isValidGenerateRequest`). Uploaded `.pptx` files are COPIED into the context dir.
- Never forward pty output before the view's `terminal:ready` ack. Ink draws its first screen once, so any chunk sent early is lost. Main buffers `SessionState.scrollback` and gates live output (`viewGates`), and the renderer must `sessions.set` in `createSessionFromInit`. Breaking either one gives a blank pane.
- Chat tabs use an inert `NO_PTY`. They catch up from a full `chat:sync` snapshot on `terminal:ready`, not by replaying events.
- Changing a tab's attached folders marks it stale (`SessionState.extraDirs`), and `terminal:restart-stale` relaunches it with `--resume`.
- Chat transcripts stay in Claude Code's config folder: never write them next to or into a deck. Chat history and attached folders are keyed by docId (else path) in userData and NEVER go in the deck.
- The trust prompt cannot be reliably pre-accepted through `~/.claude.json` (`claudeTrust.ts`). This is a known limitation, so don't try more JSON workarounds without new evidence.
- `edit.json` still works but is deliberately not advertised to Claude.

## AI profiles, API chat, tokens

- Read `docs/DECISIONS.md` (2026-10-07) before changing profiles (`aiprofiles.ts` pure, `aiprofilesStore.ts` for safeStorage and IPC).
- Grouped agent tools come from `slides/src/agentops/spec.ts` via `main/agenttools.ts`; add new agent ops there.
- Empty completions are never stored in the transcript.
- Icon-server tokens (`icontokens.ts`, safeStorage, write-only) are bound to the server root they were entered for. Main makes every icon request and adds the header only under that root. Keep the `slidomingo-icon-sources` pref token-free (`sanitizeIconSourcesPref`).

## Menu (DECISIONS 2026-10-06, "One command registry")

- The editor's registry (`slides/src/editor/menumodel.ts` + `commands.ts`) is the single source of truth; main's `menu.ts` only draws the model it receives.
- Adding a command takes one `COMMANDS` entry, a place in `MENU_MODEL`, and one `reg(...)` in `registerCommands`. `test-menu-model.ts` and `e2e-menu.mjs` fail if these disagree.
- A label that depends on the document (icon set: All icons, Center on canvas) is `reg(…, { menuLabel })` with an English key; a top-level title is `commands.menuTitle`. Never a second command id.
- Each shortcut has exactly one owner. Renderer commands get `registerAccelerator:false` in main, so that only the page's keydown fires them. Main-owned items keep real accelerators and the page never listens for them.
- A window with no editor shows the renderer items disabled, not hidden. Models are kept per doc webContents.
- Main has no i18n catalog: the renderer translates every menu label, including main-owned ones.
- UI zoom uses custom menu items (`uizoom.ts`), not the zoom roles, which forget the level and touch only one window. The terminal view is not zoomed.

## UI profile (Customize, DECISIONS 2026-10-09)

- Renderers may claim only the `settings`/`import` sources on `slidomingo:ui-profile-*`.
- The `ui_profile` tool schema in `uiprofiletool.ts` is duplicated in `mcp/slides-mcp-server.mjs` (that file is written out alone). `test-ai-profiles.ts` fails if they differ.
- Per-area guidance goes in the catalog's `howto`, not in the skill.
- `SLIDOMINGO_NO_UI_PROFILE=1` turns the UI profile off.

## Pictures and installs

- Lossless picture optimization (`pictures.ts`) accepts only results that are smaller AND whose `nativeImage` bitmap is byte-identical. `@gfx/zopfli` is a runtime dependency.
- Packaged userData is `BeeSlides`; dev runs keep `slidomingo-desktop`. Only Linux compiles node-pty (`rebuild-pty.mjs`).
