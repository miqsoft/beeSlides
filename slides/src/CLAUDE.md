# slides/src — document model, renderer, runtime

Repo rules and commands: root `AGENTS.md`. Editor UI/interaction internals:
`slides/src/editor/CLAUDE.md`. Design rationale: `docs/DECISIONS.md` (dates below
name entries there).

## Save, load, file shell

- Every path that reads a `#slidomingo-doc` out of a FILE must resolve asset-store
  refs (`resolveDocText`, live DOM: `readEmbeddedDoc`, desktop `docfile.extractDocBlockText`)
  or the deck opens without pictures.
- Every new write or merge path must call `refuseGatedWrite` (writes) or `refuseNewerDoc`
  (foreign docs); `formatgate.ts`. Unknown `requires` = read-only.
- `requires:['rich-text'|'table-merge']` is synced by `model.syncContentRequires` in Store
  AND at write time (`save.ts withContentRequires`, `library.ts spliceForeignDoc`). A writer
  that builds file text without save.ts must call it too.
- Block is written with kernel `canonicalJson` (reordered keys): compare docs deeply, never
  as JSON strings.
- `assetSrc` returns cached `blob:` URLs on the live page; any render whose output leaves the
  page (static layer, preview, speaker view, print, export) MUST pass `inlineData: true`. The
  model never holds a blob URL.
- Encrypted decks: no asset store, no IndexedDB autosave snapshots, no preview.
  `serializeAuto`/`serializeDocInto` are the encryption-aware paths; `serializeFile` is plain.
- Anything injected into the DOM before `capturePristine()` must carry
  `data-slidomingo-transient`, or it is saved back into the shell on every save.
- Compressed shell byte order: chrome → NOTICE → tooling comment → plaintext
  `#slidomingo-doc` → splash → payloads. `scripts/shell-gate.mjs` is the splice-contract gate.
- `ZOPFLI=0` (zlib fallback) is for local builds only, never a release. `@gfx/zopfli` resolves
  from the app's cwd (scripts/ has no package.json).
- Library writes splice into the library file's own HTML (`spliceForeignDoc`), never via save.ts.

## Preview (file-manager thumbnail)

- Preview = plain `[data-slidomingo-preview]` element followed IMMEDIATELY by a
  parser-blocking remover `<script data-slidomingo-preview>`. Not `<noscript>` (iOS ignores it).
  Nothing paintable may sit between them.
- Removing the old preview on save is UNCONDITIONAL (replace, never append).
- Never strip `id` from the preview render (svg `url(#…)` refs). `staticize()` inlines the
  needed `.slidomingo-*` rules — runtime CSS is not inflated there.
- Verify with `qlmanage -t`, not Chrome alone; no `<svg><foreignObject>` (QuickLook mangles it).
  Headless Chrome JS-off: CDP `Emulation.setScriptExecutionDisabled`.
- Rig: `scripts/test-preview.ts` (+ shell-gate preview invariant).

## Viewer build

- Never import `editor/` or `startuppicker` from `viewer.ts`/`player.ts`;
  `scripts/check-viewer.mjs` fails the build on editor markers.
- Only File ▸ Export ▸ Present-only writes the viewer shell; Save/Save As writes the editor shell.

## Model and render invariants

- Morph key = `el.morphId || el.id` (`data-flip-id`). `id` is identity; never mutate it to
  re-pair a morph. Morph keys must be unique per slide.
- Fields (`{{page}}`, `{{term:Name}}`, `{{prop:Name}}` …): the model stores raw tokens, only
  output resolves. `canvas.startTextEdit` swaps raw `el.html` back while editing.
- `RenderOpts.fieldMarkers` and `RenderOpts.language` are editor-only; no output path may set them.
- Doc terms table is template-only (editable only in the template window).
- `layoutId` resolves ONLY against `doc.layouts`, never built-ins — a built-in id is a silently
  dangling link. Importers materialize built-ins into `doc.layouts` (qmd: `qmd-*` ids).
- `applyLayout`: only a `text` donor may match a text placeholder by id (others lose content);
  elements with `parentId` are never donors; ties match by nearest x, not array order;
  `role:'media'` matches any image/media/chart/table donor and keeps the slot id.
- Delete a slide type only via `model.removeLayout` (bakes content into children, clears links).
- Moving a slide type = `moveSlideTypeInTree` + `resyncLinkedSlides` in ONE commit
  (`syncLayoutInstances` only resyncs the open surface). Deleted ancestor ids go via
  `resyncLinkedSlides(…, retiredIds)`.
- Change slide type: doc type = `model.relinkSlide`; built-in = apply + `delete layoutId`.
  Picker badges come from `relinkPreview` (same matching as `matchLayout`).
- New object-creation paths use `shapeDefaultsFor`/`lineDefaultsFor`/`textDefaultsFor`, not
  `SHAPE_DEFAULT`/`readableInk`.
- Template mode: every write goes through `editor.serializeForDisk` → `templateFileDoc`; never
  serialize `store.doc` raw (in-memory docId, `template: true`).
- Containers: children are flat `slide.elements` with `parentId` + `parentOffset`; `x/y/w/h`
  stay the source of truth. Paste and duplicate must remap `parentId` AND `groupId`;
  pasted slides drop `stateOf`.
  No nested containers.
- Extras/states: generators must emit deterministic element ids (state "Sync from parent",
  cross-state morph).
- `parseDoc` migrates old `doc.master`/`doc.masters[]`; don't break
  `scripts/test-slide-type-migration.mjs`.
- New `fx` keys and new untrusted string fields must be bounded in `untrusted.ts`.
- svg `vars` values pass `model.svgVarValue` at load AND at render (`svgVarDecls`) — opened
  files skip untrusted.ts. Endless svg CSS animations run on the document timeline
  (`alignEndlessAnimations`); finite ones replay on entry.

## Rich text, tables, math

- `render.ts sanitizeHtml` is a strict allowlist and THE security boundary for text/cell html;
  never loosen it with pass-through. Output is spliced as a string later, so a kept attribute
  must never carry `$`, `{`, `}` or quotes.
- Lists: nested list inside its item, none inside a line div, depth ≤ `MAX_LIST_DEPTH`.
- `builds.splitParagraphs` and `tagParagraphs` are twins — keep them in step.
- Merged cells: read spans ONLY through `tablespans.ts` (`tableLayout`); covered cells stay in
  the grid and are derived, never stored.
- Image crop: read ONLY via `model.normalizeCrop`. The img sits inside `div.slidomingo-crop`;
  code that looks for an image's `<img>` must allow that wrapper.
- Math: `math.ts` is the one Temml path. A cell edit holding `$` swaps in raw html
  (`editingShowedRaw`) — never commit rendered MathML. Frames fit via `measure.fitMathFrame`.
- `flipH`/`flipV`: `applyFlip` scales the node's CHILD, never the frame (Moveable, rotate
  parsing, morph). svgexport clears it and wraps in SVG `scale` instead.
- svg-element CSS must be scoped (`render.ts scopeCss`) or it leaks document-wide.
- Zoom covers render nested with ALL `data-*` and hrefs stripped; canvas queries use
  `.slidomingo-el[data-el-id]` for that reason.
- Any new insert path for third-party artwork sets `el.provenance` (origin + license).
- Diagrams are ordinary elements + groups (interactivity = linked state slides + morph,
  motion = `fx.loop`); opaque `svg` is only for geography/static artwork.
- Convert to objects (`svgconvert.ts`) reads the live rendered DOM — never add a second SVG parser.
- `validate.ts` a11y checks (`missing-alt`, `low-contrast`) stay silent when unsure.
- Canvas media: `pointer-events:none` unless `liveMedia`. Autoplay is NEVER set at render
  time; present.ts starts/pauses flagged clips.

## Charts (`charts.ts`, own engine, ECharts option shape)

- Options stay pure JSON (template formatters, never functions).
- Bar/line data must be plain numbers (`{value,itemStyle}` coerces to 0; only pie takes
  `{name,value}`). Per-item bar colours unsupported.
- Which axis holds categories: only `chartaxes.ts` knows — never read `xAxis.data` directly.
- New charts get `applyChartPalette` (`doc.theme.chartPalette` or `deriveChartPalette`).
- Linked charts (`chart.source`) are re-derived from the table by `model.syncLinkedChart`
  (data only); the editor's `syncLinkedCharts` is signature-guarded so it can't loop.

## Presenting

- ALL navigation goes through present.ts `slideTo` (never `deck.slide` directly —
  `prepTransition` must see the pair).
- Next/prev/extras logic: `model.presentNext`/`presentPrev`/`presentToggleExtras` only; don't
  re-derive. Rig `scripts/test-present-nav.ts`.
- Builds: `builds.ts` is the single source of truth. Apply a section's build state at ARRIVAL,
  never at exit.
- Zoom frames pop from the top in `slidechanged`; don't add per-route zoom handling.
- Ghost clones carry NO `data-flip-id`/`data-el-id`.
- Call `resetXform` after `applyElementFrame`, or stale y/scale re-emerge.
- Never put entrance tweens on motion-path elements (transform conflict).
- A morph's frame tween writes `transform` outside the engine: anything that starts a
  transform tween on arrival must wait on `frameMorphing` (as `startGenericLoop` does).
- Slide exit kills tweens AND restores model frames.
- Reveal `viewDistance` must stay ≥ 2 (Reveal uses `distance < viewDistance`).
- Reveal's `.reveal-viewport` paints white; overlay CSS overrides it black.
- Don't use Reveal's notes plugin (it reloads the URL → second editor).
- The speaker popup has its own keydown handler; keys handled in both windows (L, X, S) must
  be wired in both.
- `motion-path speeds[]` stays 1:1 with on-curve anchors (`serializeBezier` emits one per node).
- Reduce-motion and presenter ink are viewer state; never in the doc.
- `openingSpeaker` guards `onFsChange` against the fullscreen bounce ending the show.

## Comments and agents

- Claude gets comments through ONE path: `sendCommentsToClaude` (sets `forAgent`).
- Prompts typed into the terminal must stay free of `'`, `$`, backtick and backslash
  (pty.ts quotes unescaped).
- `commentAuthor()` is sync and never prompts; empty author is valid.
- `window.slidomingo.comments()` = typed-anchor list for agents.
- Agent writes go through `editor.commitAgentWrite` (layout guard).
- Import repair: a converter code a model could restore goes in `importrepair.ts REPAIRABLE`;
  one the format cannot express never does.

## i18n

- English string is the key; keys must match source EXACTLY.
- Context variants: `t(en, vars, context)` looks up `"{en} ({context})"`.
- `setLocale('x-pseudo')` reveals unswept strings.
- Known debt: icon-hover tooltip strings are English placeholders in non-English catalogs and
  language packs (inserted to keep `scripts/test-i18n-coverage.mjs` green); still need translating.
- UI language never enters the document; `select()` localizes labels only.

## Figure mode

- `doc.kind === 'figure'`; `.ed-figure` hides anything marked `ed-slides-only`.
- SVG export measures the live layout: rotation is stripped while measuring and re-applied on
  the `<g>`. Verify with `rsvg-convert`/`pdftoppm` vs a canvas screenshot; `pdffonts`/`pdftotext`
  prove the PDF is not rasterised.

## Icon sets (DECISIONS 2026-10-15)

- `doc.kind === 'iconset'`; `.ed-iconset` hides `ed-slides-only` unless it also carries
  `ed-iconset-too` (slide list, sorter). `Editor.isCanvasDoc` = figure or icon set.
- Pure side in `iconset.ts` (style patch, model → SVG, file names, `icons.json`); editor glue in
  `editor/iconsetactions.ts`. The export reads the MODEL, never the DOM: path strokes are
  non-scaling on the canvas, so stroke px ÷ `scale` = grid units.
- Agents draw icons only as path shapes (copies of `doc_info.iconset.pathElement`); svg stays
  refused. Rigs: `test-iconset.ts`, `test-iconset-e2e.mjs`.
- Icon styles (`doc.iconset.variants`, DECISIONS "Icon styles") are recipes rendered by
  `iconstyles.ts iconLookSvg` from `iconset.iconShapes` — never redraw for a style. Every
  untrusted look goes through `readLook`; colours pass `safeColor` again at render.
  `pathElement` must not carry an `iconPart` (copies would all be body). Rig `test-iconstyles.ts`.
- Drawing vs Styles (DECISIONS 2026-10-16): `iconset.style` + `brief` + `examples` are how icons
  are DRAWN (Claude reads them first); `variants` only repaint. Example icons are stored only
  through `iconexamples.ts readIconExample` (allowlist, no text/url/quotes) and re-read where
  used; agents get them as SVG text and must not copy them. Rig `test-iconexamples.ts`.
- The style shown on the canvas is `store.iconLook` (view state, never saved; read `shownLook`).
  Per-icon changes in a style are `IconLook.tweaks[slideId][elementId]`; they never leave the
  set (`lookRecipe` for My styles / Copy style). In an icon set no shape is a click-through
  backdrop (`render.ts hitNone`).
- The icon list is the slide list laid out as a grid (`.ed-iconset .ed-sidebar`,
  `Editor.iconTiles`, `thumbSurface` placeholder for empty icons) — never a second sidebar.
  `ed-not-iconset` hides a control in icon sets; the grid switch is `GridPref.iconOn`, not `on`.
- Adding icons happens IN the grid: the + tile becomes a name field (`Editor.iconAddTile`,
  state `iconAdding` survives the list rebuild; one commit per name via `iconset.addIconNames`:
  blank starter first, no duplicate names). Plan with AI without a request is `editor/iconplan.ts`.

## Rigs worth knowing (all in `scripts/`)

- `test-sanitize.ts`, `test-rich-text.ts`, `test-table-merge.ts`, `test-layoutguard.ts`,
  `test-alignment.ts`, `test-import-repair.ts`, `test-import-layout.ts`, `test-zoom.ts`,
  `test-zoom-e2e.mjs`, `test-math-palette.ts`, `test-svg-path.ts`, `test-svg-convert-e2e.mjs`,
  `test-anim-inline.ts`, `test-svg-vars-e2e.mjs`, `test-native-scene-e2e.mjs`.

## Testing traps

- Reading back a style you just wrote is not a measurement (transform on an inline element
  moves nothing). Use `getBoundingClientRect`, or `anim.setManual(true)` + `tick()`.
- `requestAnimationFrame` is throttled to zero in hidden tabs; check `document.visibilityState`.
- Instrument the decision (did it pair? did onUpdate run?) rather than polling the DOM mid-animation.
- Synthetic `PointerEvent`s don't drive Moveable/Selecto — dispatch `MouseEvent`s; wait a frame
  after changing selection before a synthetic drag.
