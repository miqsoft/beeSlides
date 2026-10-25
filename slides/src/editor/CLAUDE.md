# slides/src/editor/ — editor UI and interaction

Repo-wide rules: root `AGENTS.md`. The model, renderer and present mode:
`slides/src/CLAUDE.md`. Settled design: `docs/DECISIONS.md`.

## Do not regress (editor DOM)

- Moveable's control box mounts INSIDE `.ed-stage-scale` with `rootContainer: document.body` and `moveable.zoom = 1/scale` on relayout; mounted outside, its coordinates are garbage.
- Never reset `moveable.target` to an identical array: listeners re-attach a frame later and a drag started in that frame is swallowed (`syncTargets` checks).
- `[data-el-id=…]` also matches sidebar thumbnails; scope queries to the surface (`.ed-stage-scale …`, `.beeslides-el[data-el-id]`).
- Small interactive labels get a padded transparent `link` hit-rect; never put `link` on both a rect and its label text.
- `.ed-topbar` / `.ed-titlebar` / `.ed-ribbon` z-index is a CEILING (a flex item opens a stacking context even when static). Raising a child menu never escapes it; diagnose with `document.elementsFromPoint()`.
- `overflow-y: auto` also clips horizontally. Popovers demoted into a scrolling menu (phone ⋯ menu) must render `position: static` inside it.
- Selecto's container/dragContainer is the SCROLLER, not the stage (marquee starts on the grey surround); floating controls are exempted in its dragStart guard.
- Selecto's continue-select list is synced in `syncTargets` (stale cross-slide shift-click selections were a real bug).
- Topbar fits by MEASURING (`fitTopbar` tier classes via Resize/MutationObserver), never width breakpoints, and hides text, never scrolls.
- FULLSCREEN paints only the fullscreen element's subtree: body-mounted UI (chart tooltips) must reparent into `document.fullscreenElement`.
- svg gradients rendered per instance need unique ids: `url(#…)` refs are document-global across canvas/thumbs/present.
- `editor/markdown.ts` contains literal invisible chars (NBSP, ZWSP, U+E000); edit it with line-targeted scripts, not retyped strings.

## Selection and hit-testing

- `canvas.hitStack(px,py,{includeHidden})` is THE stack query (rotated boxes, skips inherited-locked); Alt-click deep-select and the right-click "Select" block use it; menu rows select without `expandGroups`.
- Click-through is CSS on `data-hit` (render.ts `paintHit`); selected nodes get `data-sel` so Moveable keeps the whole box. `selectEnd` re-resolves plain clicks via `resolveClickTarget` (DOM stack) because Selecto hit-tests geometrically; don't "simplify" it away.
- `el.locked` (user) is not `lockedIds()` (inherited from a slide type): user-locked stays in `hitStack`; gestures/handles/line editors are disabled when any selected element is locked.
- `el.hidden` renders as `.beeslides-el-hidden` only on the canvas (`showHidden`); every other output omits it.
- Group (`groupId`, G/⇧G) is distinct from presentation `group`; ⌘G is the grid toggle.

## Containers (live-drag cascade)

- A lone selected container feeds `[container, ...children]` to `moveable.target`, so Moveable runs every gesture as a Group variant; `store.selection` still holds only the container. `containerCascadeChildren()` returns `[]` unless exactly one element is selected.
- `commitDomFrames(…, cascadeContainerId)` re-derives children's `parentOffset` in the same commit.
- Rotate deliberately excludes children: `rotateGroupStart` snapshots `rotateCascadeChildIds` and `rotateGroup` skips their transforms. Keep that intercept if touching rotate.
- `syncContainers` is registered on `'doc'` BEFORE `syncConnectors`; both only resync the open slide. All derive passes (`syncLinkedCharts`/`syncContainers`/`syncConnectors`/`syncThemeRefs`/`syncLayoutInstances`) register BEFORE `build()` (before the canvas's own `'doc'` render) and never call `canvas.render()` themselves — one render per commit.

## Lines, paths, presets

- `LineEditor` replaces Moveable for a lone line/path; connectors (`from`/`to`) are re-derived by `syncConnectors` (derive, not commit); dragging an endpoint detaches it.
- Shape presets (`shapepresets.ts`) insert a PLAIN `path` (no format change). Each must be ONE subpath in the editors' own form, or the first edit mangles it. Rig `scripts/test-shape-presets.ts`.
- Stacked anchors move/delete as one group (`bezier.stackedIndices`); a closed path keeps its Z down to 2 nodes in `serializeBezier`; don't reintroduce a `> 2` guard.
- Motion paths (`patheditor.ts`) are parsed exactly and stored relative to the element's rest position; `fx.loop.speeds` stays 1:1 with nodes because `serializeBezier` emits one on-curve point per node.

## Snapping (`gridsnap.ts`, `snapping.ts`, rig `scripts/test-grid-snap.ts`)

- Drag handlers apply the firm grid only on an axis Moveable did not catch (`axisCaught` vs `rawOf`). Never snap the top-left after Moveable: it overrides every magnetic snap.
- Snap reach is screen px: `relayout` sets thresholds to `SNAP_SCREEN_PX / scale`. ⌥ mid-drag sets `moveable.snappable = false` (restored at drag end).
- Guide grab strips preventDefault on pointerdown, which also suppresses the compat mousedown Selecto and deep-select listen to.

## Text editing

- Rich text uses the browser's editing commands (native undo). A list command moves the caret to the item START (delete the "- " marker as a selection, never by backspace).
- Popovers are `data-rt-keep` so `canvas.armBlurCommit` keeps the edit alive; refocus the text BEFORE removing a focused popover (removal fires no focusout).
- `normalizeRuns` runs at commit while the edit is still laid out.
- Buttons/dropdowns that act during a text edit use mousedown + preventDefault so the contentEditable keeps focus (mini toolbar, Insert field).
- Mind contentEditable NBSPs and stale Selection offsets after DOM surgery in `markdown.ts`.

## Crop mode (`cropmode.ts`, rig `scripts/test-image-crop.ts`)

- Check `cropMode.engaged` (active OR waiting for decode), never just `active`, before Moveable/Selecto.
- ⌘Z cancels the session ONLY (swallowed). Every other undo entry point (native Edit menu, toolbar, Ctrl+Y) goes through `Editor.undo/redo` → `canvas.cancelCrop`; toolbar buttons carry `data-keeps-crop`.
- Crop-bar buttons preventDefault mousedown so a mouse click never leaves one focused.
- One `store.commit` per crop; no change = no step. Resizing a cropped picture keeps aspect by default; Shift frees it.

## Tables (`tablerange.ts`, rig `scripts/test-table-cells-e2e.mjs`)

- The first click only selects the table: `selAtPress` (capture-phase pointerdown) stops the selecting press's own Moveable `click` from picking a cell.
- Span logic lives only in `src/tablespans.ts`. `TABLE_OPS`: check `can(op)` first so a no-op leaves no undo step.

## Find & replace (`findbar.ts`, `findreplace.ts`, rig `scripts/test-find-replace.ts`)

- Highlights are `CSS.highlights` built from the MODEL's matches via `renderedSpans`; never touch the canvas DOM or re-search it.
- Matches stay inside one text run; field tokens are opaque. Replace all = one commit; Replace commits only a real change.
- Off-Mac AltGr / a non-letter is never the chord. E2E: `desktop/scripts/e2e-find-menu.mjs`.

## Slide panel

- `.ed-sidebar` is its own focus zone: thumb presses call `focus()` explicitly and drop the element selection (else Delete after clicking the current thumb deleted elements). `clipPayload`/`wireCopy`/`pasteSlides` check `slidesFocused()` themselves.
- `slideSel` always contains the current slide; only `setSlideSel` keeps it across a `goTo` (`panelNav`). A press on a multi-selected thumb collapses on click (`pendingCollapse`), not on press.
- Every move is a token permutation in `slideorder.ts` (pure, rig `scripts/test-slide-order.ts`) written by `applyTokens` in one commit; planners return null for no-op. States never move alone; normal slides carry their extras run.
- Drops: one `wireSlideDrop` per surface, never per-item handlers. dataTransfer is unreadable in dragover, so the source records `activeDrag`.
- "Drop as extra" hit-tests BY ROW (`nestHit`), not nearest gap. Hiding goes through `Editor.setSlidesHidden` (extra status depends on neighbours).
- Batch slide ops (`deleteSlides`, `duplicateSlides`, `moveSelectedSlides`) are one commit each.

## Panels, toolbars, Customize

- Ribbon rows fit by MEASURING (`ribbon.ts fit` tiers: labels, then groups of >6 controls fold into "Caption ▾", then all labels); a dropdown whose label IS the choice sets `data-keep-label`. Never width breakpoints, never a scrollbar.
- Title bar + ribbon (`buildRibbonChrome`) run on desktop AND in desktop-width browsers (`ribbon.ts useRibbonChrome`); phones get `buildWebTopbar`. Gate desktop-only ITEMS on the API they call (`window.slidomingoDesktop?.x`), never the chrome on `isDesktopShell()`. The browser menu bar (`menubar.ts`) draws `commands.serialize()`; main-owned slots map in `Editor.webMenuSlot`.
- `this.section(key, …)` takes the ENGLISH key: open state persists by `data-key` in `slidomingo-panel-open-v2`. A new orderable section needs an entry in `catalog.PANEL_SECTIONS`.
- `ElementEdits` (`elementactions.ts`) owns undo bursts (reset on selection/current, never on panel rebuild); setters take one id or several (one undo step).
- Non-final burst steps run their `touch()` inside `livestep.ts liveStep`: canvas render and panel rebuild wait for the next frame (at most one per frame). Final steps, commits and undo stay synchronous; a sync `render()`/`rebuild()` cancels the pending frame, a selection change flushes it.
- Mini toolbar never rebuilds while one of its fields is focused or its colour popover is open. The docked top bar is a second instance: control changes show in both.
- A NEW context-menu item, minibar control or toolbar button needs a `data-ui-item`/`data-ui-tool` id AND an entry in `customize/catalog.ts` (`CONTEXT_ITEMS`/`MINIBAR_ITEMS`/`TOOLBAR_ITEMS`), or `scripts/test-ui-profile.ts` fails. Same rig pins `RESERVED_CHORDS` to `wireKeyboard`.
- Customize: toolbar hide/order is CSS (`logic.toolbarCss`), never DOM moves. Its keydown listener registers AFTER `wireKeyboard` (built-ins win). User labels never go through `t()`; set with `textContent`.
- `insertgroup.ts` is shared by the main toolbar/ribbon and Layout Manager sub-editors; actions must only touch `canvas.insert()`/`store.slide`/`store.doc` (redirected by `store.editingSurface`). Format Painter, Reapply and Comment stay out of it; the Library panel too.
- Layout Manager REPARENTS the editor's one `SlideCanvas`/`PropsPanel` (never a second instance: document keydown would double-fire). Update its editor column in place on `'doc'`; never re-append `canvasArea`. Re-read `store.doc` on every event (undo replaces it).
- ⌘/Ctrl ± 0 zoom the whole UI, not the canvas; don't handle them in `wireKeyboard`.

## Agent tools

- Grouped agent tools are declared once in `slides/src/agentops/spec.ts` (import-free; desktop main bundles it). New op: add to spec, then handler in `agentops.ts` (typed, missing handler won't compile), then a case in `scripts/test-agent-ops.ts`. Nothing in the MCP server or desktop changes.
- Prefer one tool per area, not per verb. UI-only capabilities go in the area's `notYet`.
- Handlers reuse UI code (`slideops.ts`, `decksettings.ts`, `slideorder.ts`, `src/arrange.ts`); never reimplement a slide mutation. One handler = one `store.commit`.
- `elements` handlers write through `OpContext.writes`.
- Single agent-action verbs (`insert_elements`, `set_frame`, slide-type and comment verbs, `program`, …) are the `agentverbs/` table (verb → handler); `applyAgentAction` keeps only the shared gates and the area-tool dispatch. Handlers reach the editor only through `AgentVerbContext` (`agentverbs/context.ts`): widen it explicitly, never pass the Editor.
- No agent-authored SVG (`agentsvg.ts`): any new agent verb accepting element data must call `agentSvgViolation`/`agentSvgPatchViolation`. The `icons` tool inserts via `agentInsertElements` and must not reach those checks.
- Agent `delete` refuses slides not added this session unless `userAsked:true`.

## Icons and comments

- Desktop: icon tokens never enter the page; main stores them and makes server requests (`serverFetch` → `slidomingoDesktop.iconFetch`). New network paths go through `netFetch` (offline gate).
- Desktop folder sources are main's (`iconFolderDesktop` → `iconFolderList`/`iconFolderRead`), not FSA handles; the browser keeps handles. A folder entry reads through `FolderEntry.file()` either way.
- Icon rigs: `scripts/test-icons-e2e.mjs [url]` (skips folder cases on `file://`, so also run against a dev server), `scripts/test-icon-tokens-renderer-e2e.mjs`, `scripts/test-icon-tokens-main.ts` (`--experimental-test-module-mocks`), `scripts/test-icon-folders-renderer-e2e.mjs`, `scripts/test-agent-icons-e2e.mjs`, `scripts/test-ui-zoom-e2e.mjs`.
- Comments go to Claude only via `sendCommentsToClaude`. Prompts must stay free of `'`, `$`, backtick and backslash (pty.ts quotes them unescaped).
- Comment author is never prompted (`commentAuthor()` is sync; empty is valid).

## Present-mode controls in the editor

- Esc / browser UI leaving fullscreen ENDS the show; F is a deliberate swap (`fsToggledOut`) that keeps it running.
- The speaker window opens from the editor BEFORE fullscreen (separate gestures) and is adopted by present mode; macOS traps late popups in the fullscreen Space.

## Testing the editor DOM

- Synthetic `PointerEvent`s don't trigger Moveable/Selecto (Gesto listens for mouse events): dispatch `MouseEvent`s or use trusted input; wait a frame after changing selection.
- Synthetic drags on Moveable HANDLES never register; resize, column-width drags need a real mouse.
- Reading back a style you wrote is not a measurement (transforms on inline elements do nothing); use `getBoundingClientRect` or `anim.setManual(true)` + `tick()`.
- `requestAnimationFrame` is throttled to zero in hidden tabs; check `document.visibilityState` before concluding an animation is broken.
