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

- `claude` runs in a pty per window, in the app-owned workspace `userData/claude-workspaces/<docId>` (`workspaces.ts`). Every built-in skill is written there as a project skill (`CLAUDE_CODE_SKILLS`, with a note mapping `task`/`read_reference` to Claude Code); before 2026-10-22 only customize-ui was, and Claude Code built decks without build-deck. It must NEVER run in the deck's folder, whose CLAUDE.md, hooks, and git must not become the project.
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

## Agent bridge, endpoint, Code Mode (DECISIONS 2026-10-22)

- Every agent request reaches a document window through `agentbridge.ts forwardAgentRequest`; never send `slidomingo:agent-*` from anywhere else. Verbs main answers itself go through `registerMainVerb` (`execute`), or the `ui_profile` intercept there.
- `agentendpoint.ts`: socket + token in `userData/agent/`. It must never listen on a network port. Off until Settings ▸ AI chat ▸ Advanced (`AppSettings.agentEndpoint`); `BEESLIDES_AGENT_ENDPOINT=1` forces it on and skips the "allow?" question (tests). An app not in `AppSettings.agentClients` waits for that question (`agentconsent.ts` is the pure half). Switching off deletes the token and `endpoint.json` (DECISIONS 2026-10-24).
- The Claude Code plugin (`claude-plugin/`) is GENERATED by `scripts/build-claude-plugin.mjs` from the skills, `docs/agents.md`, `docs/format.md`, `claudeLaunch.ts outsideInstruction`, `mcp/plugin-launch.mjs`, `mcp/slides-mcp-server.mjs` (as `mcp/server.mjs`) and `mcp/claude-mod/`. Re-run it after changing any of them; `scripts/test-claude-plugin.mjs` fails when it is stale.
- Code Mode (Settings ▸ AI ▸ Advanced = `AppSettings.codeMode`; `BEESLIDES_CODE_MODE=1` forces it on): applies to chats opened after the switch (`mcpServerSource` is keyed by it). When to use `execute` is told by the server's `CODE_MODE_INSTRUCTIONS` (MCP `instructions`) and build-deck.md, not by `api_search`, which a model only calls once it has decided. Electron glue in `agentexec.ts`, everything testable in `programrun.ts` (no Electron imports). The sandbox page never gets a preload or an IPC channel: main pulls. Keep `programrun.ts` RUNTIME and the server's `API_REFERENCE` in step.
- Programs on one deck run one at a time and QUEUE (`programrun.ts keyedQueue`, `QUEUE_MAX_S` = the server's `PROGRAM_QUEUE_S`). While one runs, `agentbridge.ts` refuses every other write to that deck at once (`writeBlocked`; reads pass): the store's undo group is deck-wide, so a rollback would take another agent's write with it. Never hold such a write instead: the server stops waiting after 5 s and a late write surprises its sender. Rig: `scripts/test-program-queue.ts`.
- E2E: `scripts/e2e-agent-endpoint.mjs` (needs `slides/dist-single` and `npx electron-vite build`).

## Background mode (DECISIONS 2026-10-24, "BeeSlides without its window")

- `--background` (`background.ts isBackground`) = a hidden instance the plugin launcher starts (`mcp/plugin-launch.mjs`). It requires `SLIDOMINGO_USER_DATA` and must never touch the user's userData: no Recent (`recent.ts addRecent` returns), no session at quit, settings only READ from the user's file (`seedViewerPrefs`, `BEESLIDES_USER_SETTINGS` in tests).
- Icon tokens and icon folders are READ from the user's `icon-tokens.bin` / `icon-folders.json` at each request (`background.ts userDataFile`), never copied, never written (DECISIONS 2026-10-25). safeStorage decrypts there because the macOS key is the Keychain item named after the app; it is fixed early in startup, so `app.setName` must stay at the top of the entry. Windows keys by userData: there the token silently fails (401).
- Its windows are never shown (`windows.ts openInNewWindow` → `hideWindow`). Nothing in it may wait on a native dialog: `runLeaveFlow` returns instead of asking, and a new main-process box needs an `isBackground()` branch.
- It quits through the flush on SIGTERM/SIGINT (`index.ts watchIdle`), stays alive with no window, and exits after `IDLE_EXIT_MS` with no deck and no client.
- Its endpoint is always on, asks nobody and writes no `launch`. The visible app writes `agent/app.json` at every start (`recordAppLaunch`): that is how the launcher finds the binary.
- Main-answered verbs that need no window (`open_deck`, `close_deck`) register with `registerWindowlessVerb` (`agentdecks.ts`); the endpoint binds the client to the window they return.
- A request sent before a new window's editor listens is lost: wait with `whenDeckReady` (its first doc-state report).
- `icons` with `set` (DECISIONS 2026-10-25): main reads the icon-set file in `forwardAgentRequest` (`agenticonsets.ts`, flushing a window that has it open) and sends it as `iconSet`; a caller's own `iconSet` is stripped. `open_deck` binds the whole connection, subagents included.
- E2E: `scripts/e2e-background.mjs` (does not fake `show`; `E2E_DUMP=1` keeps the screenshots). The pane mod's source is `src/mcp/claude-mod/` (`claude plugin test claude-plugin`).

## AI profiles, API chat, tokens

- Read `docs/DECISIONS.md` (2026-10-07) before changing profiles (`aiprofiles.ts` pure, `aiprofilesStore.ts` for safeStorage and IPC).
- Grouped agent tools come from `slides/src/agentops/spec.ts` via `main/agenttools.ts`; add new agent ops there.
- Empty completions are never stored in the transcript.
- Icon-server tokens (`icontokens.ts`, safeStorage, write-only) are bound to the server root they were entered for. Main makes every icon request and adds the header only under that root. Keep the `slidomingo-icon-sources` pref token-free and path-free (`sanitizeIconSourcesPref`).
- Icon-library folders are main's (`iconfolders.ts`, pure half `iconfolderscore.ts`): picked by main's dialog, validated like attached folders, kept in `userData/icon-folders.json` by source id, walked and served with realpath confinement. The page gets names, never paths; the renderer keeps manifests and matching. Rig: `scripts/test-icon-folders-main.ts` (`--experimental-test-module-mocks`).

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
