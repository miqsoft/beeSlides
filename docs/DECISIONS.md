# Decision log

Append-only: add a new entry at the END of this file, so the log reads
oldest first. (The block at the top, down to the late-July 2026 entries,
was written newest-first before that practice settled, so its dates run
backwards and then interleave; leave those entries where they are.)

One entry per settled decision that a parallel agent (or future session)
might otherwise re-open or contradict. Keep entries to a few lines:
**what** was decided, **why**, and where the details live.
Reversing a decision = a new entry that supersedes the old one, not an edit.

Format:

```
## YYYY-MM-DD — Title
Decision. Why. Pointers.
```

---

## 2026-09-23 — Layout Manager: Slide Master–style sidebar; drag-and-drop reparents (reverses "reparent at creation time only")

Supersedes the 2026-09-20 part-3 rule that a slide type's parent is chosen
once, at creation, and never changed by drag (cardgrid.ts's per-parent
`dragGroup` rejection), and 2026-09-22's flat list rows.

**Layout.** The Slide types tab is one screen: an always-visible sidebar
(`editor/typetree.ts`) beside the selected type open on the canvas. The
list page, "‹ Back to slide types" and the tab's `stepBack`/`subLabel` are
gone; Escape exits the overlay. Default selection = the default slide
type, else the first root. The nav rail goes icon-only on this tab
(`.ed-layoutmgr-compactnav`) so three columns fit.

**Rows are true depth-first** (`model.ts`'s `slideTypeRows`). The old
`renderTypeTree` emitted all siblings of a level before any child, so
roots A, B with A's child A1 showed A, B, A1 and A1 read as B's child.
Cycle/dangling-parent entries are still listed.

**Drop rules** (the target row's thumbnail, by vertical position): top
25% = before it as a sibling; bottom 25% = after it as a sibling, or its
FIRST child when it has children showing below (that is where the line
sits); middle = make child; the empty area under the last row = root,
last. A drop onto yourself or your own subtree is refused (not-allowed
cursor, no indicator); a no-op drop commits nothing. The payload is the
layout id (`text/slidomingo-slidetype`), never an index.

**Reparent = inherit from the new parent** — the look changes at once; to
root = drops what it inherited (an empty child goes blank). A toast offers
Undo; one ⌘Z restores everything. **"Detach from parent (keep look)"**
(`detachSlideType`) is the alternative: it bakes the inherited chain in
(`bakeInheritedInto`, shared with `removeLayout`), then places the type as
a root right after its former family.

**Explicit resync.** `syncLayoutInstances` only resyncs the OPEN surface
when its JSON changed; a dragged row usually isn't open, yet every slide
linked to its subtree changes look. So a move calls `resyncLinkedSlides`
(the loop body moved out of editor.ts into model.ts; `syncLayoutInstances`
calls it too) inside the SAME `store.commit`. `moveLayoutWithinParent`
survives as a thin wrapper over `moveSlideTypeInTree` for
`reorder_slide_type`; new MCP verbs `move_slide_type {layoutId,
parentId|null, beforeId?}` and `detach_slide_type` keep agent access equal
to the UI.

**No canvas churn.** The pane is built once per tab/selection change; a
'doc' event refreshes the sidebar (full rebuild only when an id/parent/
name/default/link signature changes, else debounced per-row thumbnails)
and swaps the small header — `canvasArea` is never re-appended, so a
canvas edit keeps its selection. The overlay's `doc` is re-read on every
'doc' event: undo/redo REPLACE `store.doc`, and the old once-captured copy
kept showing (and editing) the pre-undo document.

Known, pre-existing (also on `main`, not caused by this): the canvas's
click-to-select starts Moveable's drag one frame late
(`waitToChangeTarget`), so an automated sub-millisecond click leaves
`gestureActive` stuck and the next drag throws "setting 'dist'". Real
clicks are unaffected; drive tests with `click({ delay: 80 })`.
Verified by `scripts/test-slide-type-tree.mjs` + a driven browser pass.

## 2026-09-23 — Fix: Claude Code terminal panel opened blank (scrollback lives in main)

Every terminal open (editor title bar and Layout Manager alike) showed an
empty pane where typing seemed to do nothing. There were two causes. (1) A
race: `openPanel` spawns the pty before the renderer loads, so claude's
one-time first Ink screen was forwarded into a page with no xterm yet.
(2) `renderer/terminal/main.ts` never put tabs into its `sessions` map, so
`onData` dropped every chunk even after the load (a regression from the
multi-session commit). **Decision:** main owns each session's scrollback
(~1 MB cap) and replays it in `terminal:init` / the `terminal:new-tab`
response. Live output is gated per view until a `terminal:ready` ack, and
main flushes the gap on that ack. This supersedes the header comment's old
"transcript resets on pop/dock" trade-off: the transcript now survives
both. `disposePanel` now also closes the view's webContents, which it had
been leaking once per close. The SIGWINCH repaint nudge from the plan was
not needed. Details: `desktop/CLAUDE.md`, `terminalPanel.ts` header.

## 2026-09-22 — Layout Manager: chat access + PowerPoint-style Slide Types list

Two independent fixes to the Layout Manager overlay (`layoutmanager.ts`),
landed together:

**Terminal toggle in the overlay header.** The overlay's own `head`/
`headRight` never got a way to reach the desktop Claude Code terminal panel
— the panel itself (window-level, not gated by the overlay) kept working
while the overlay was open, but nothing in the overlay's chrome surfaced
it. Fixed by prepending the same `terminalB` button `editor.ts`'s title bar
already has (mirrored exactly: icon, tooltip, `ed-btn-armed` wiring),
gated on `isDesktopShell()`. Because `openLayoutManager()` runs fresh on
every open (unlike the title bar, built once per `Editor`), the preload
bridge's `onTerminalStateChange` — previously `void`-returning, a bare
`ipcRenderer.on` with no unsubscribe — would have stacked one more
listener per open/close cycle forever. `onTerminalStateChange` now returns
an unsubscribe (`desktop/src/preload/index.ts`, type updated in
`ribbon.ts`); `openLayoutManager()`'s `exit()` calls it alongside `offDoc()`.
`editor.ts`'s own one-time call site ignores the new return value —
correct, since it never needs to unsubscribe.

**Slide Types tab flattened into one PowerPoint-Slide-Master-style list.**
`renderTypeTree`'s depth-first walk used to wrap each tree level in a
bordered `.ed-layoutmgr-treelevel` box with a "↳ Based on '{parent}'" text
header, and each level's siblings rendered as a full 168px-thumbnail card
grid — a parent→child chain read as several separately-boxed galleries
stacked on top of each other, not one hierarchy. Now: `cardgrid.ts`'s
`buildCardGrid` takes an optional `variant: 'grid' | 'list'` (default
`'grid'`, every other caller — Reusable Objects included — untouched);
`'list'` renders one flex row per item (small thumbnail, name, controls,
all via CSS `order` over the SAME DOM nodes/callbacks the card variant
uses — no behavior duplicated) instead of a card. `renderTypeCards` passes
`variant:'list'` + a 72px thumbnail and a new `bold` option (true when
`childrenOf(doc, ly.id).length > 0` — i.e. this slide type has children,
the PowerPoint sense of "master") for header-like visual weight with no
new data field. `renderTypeTree` drops the "Based on" header and the
boxed/bordered treelevel wrapper entirely — indentation via `--depth`
alone (now 20px/level, was 28px) is what communicates the hierarchy.
`.ed-layoutmgr-treehead` CSS deleted outright (no longer referenced).

## 2026-09-20 — Fix: the master→slide-type migration surfaced empty "ghost" master roots

Found immediately after merging all 4 redesign branches to `main`: an old
template opened with a new, empty, unnamed slide type sitting at the top of
the Slide Types tree — and in the worst case (that ghost happening to be
`doc.masters[0]`), it would silently become the PARENT of every other slide
type, since unset `masterId` used to fall back to `masters[0]`.

Root cause: the old `ensureMaster(doc)` minted `doc.masters = [{id,
buildingBlocks: emptySlide()}]` — no name, no font, no elements — the moment
ANYONE opened the (now-removed) Building Blocks tab, even without adding
anything. This was invisible in the old UI by design (2026-09-03: "a single,
never-configured master needs zero configuration and shows no new UI
chrome"), so it silently accumulated in a LOT of saved files. The migration
in `parseDoc` (`model.ts`) was minting a real, visible `doc.layouts` root
for every `doc.masters` entry unconditionally, including this ghost.

Fix: a master matching that exact never-configured shape (no name, no
`fontFamily`/`headingFamily`, zero `buildingBlocks.elements`) is now
detected and dropped outright during migration — never minted as a layout.
Anything that pointed at it, explicitly or via the unset-masterId→
`masters[0]` fallback, ends up PARENTLESS instead of pointing at a deleted
id (matches the OLD *rendered* behavior exactly, since a ghost contributed
zero elements/font to `effectiveLayout` either way — this is a UI-surfacing
fix, not a rendering behavior change). The fallback is NEVER redirected to
a later, real, non-ghost master — that would be inventing a new rule ("first
non-empty") the old format never had; a ghost-as-`masters[0]` now yields a
flat, parentless layout, full stop. 10 new regression cases in
`scripts/test-slide-type-migration.mjs` (28/28 total) cover: a lone ghost
master (zero synthetic roots minted), and a ghost sitting at `masters[0]`
beside a real second master (implicit AND explicit references to the ghost
both end up parentless; a reference to the real master still works;
`rootFontLayoutId` is left unset rather than dangling).

Confirms, as a side note, that the plan's original question — "can we have
multiple top-level (parentless) slide types?" — was never a real limitation:
`doc.layouts.filter(l => !l.parentId)` already treats every parentless entry
as its own root, and the tree UI already renders one section per root. The
bug was specifically the migration manufacturing an unwanted extra one.

## 2026-09-20 — Layout Manager redesign part 4 (final): MCP tools, and `resolveAgentSlide` grows a third array

Built `feature/slide-type-mcp` on top of part 3, closing out the 4-branch
redesign (`feature/slide-type-model` → `-wiring` → `-tree-ui` → `-mcp`).
Judgment calls not spelled out verbatim in the original plan:

**`remintElements`/`moveLayoutWithinParent` moved from closures to
module-level exports in `layoutmanager.ts`.** Both were previously nested
inside `openLayoutManager`'s closure (capturing `doc` implicitly). The new
`create_slide_type`/`reorder_slide_type` MCP verbs (`editor.ts`) needed the
exact same logic — reusing it rather than re-implementing was the whole
point of asking the plan to name these helpers explicitly — so both were
lifted verbatim (byte-identical bodies) to module scope; `moveLayoutWithinParent`
gained an explicit `doc: SlidomingoDoc` first parameter in place of the
closure capture, `remintElements` needed no signature change (it was already
pure). The one internal call site inside `openLayoutManager` was updated to
pass `doc` explicitly. No behavior change for the existing UI path.

**`model.ts`'s `resolveAgentSlide` grows a third fallback array:
`doc.layouts`.** It previously resolved an agent-supplied id against
`doc.slides` then `doc.reusableObjects` only. `promote_to_reusable_object`
needed to resolve a `slideId` that might name a slide-type sub-editor (per
the plan: promotion works "from both a real slide's context menu and from
inside a slide-type sub-editor's"), and since a slide type is already just
another editing surface with the full insert toolbar (`store.editingSurface`
already redirects generically), extending the ONE shared resolver was more
consistent than writing a second, promotion-only resolution helper. This is
a pure addition — every id that already resolved against `doc.slides`/
`doc.reusableObjects` resolves identically; the new fallback only engages
for ids that resolved to `null` before. As a side effect, every OTHER
existing agent-action verb that goes through `resolveAgentSlide`
(`insert_elements`, `set_frame`, `duplicate_element`, `delete_element`,
`reorder_element`, `apply_change_pattern`) now also accepts a slide type's
id, which was not previously possible via MCP at all — not scope creep,
just the natural consequence of one resolver serving every caller; not
separately schema-documented per verb (their existing descriptions already
say "slideId may also be a reusable object's id," which is now
incomplete/outdated wording — flagged here rather than rewritten across 6
tool descriptions in this pass, since it's a documentation-completeness nit,
not a behavior gap).

**No lock enforcement (`lockError`) on any of the 4 new verbs.**
`create_slide_type`/`rename_slide_type`/`reorder_slide_type` operate on
`doc.layouts`, which has no existing per-entry locking concept (locks exist
only for `doc.slides`/reusable-object content edits, to coordinate parallel
MCP sessions editing the SAME slide's elements). `promote_to_reusable_object`
only READS its source slide's elements (never mutates them), so there is
nothing to coordinate. Introducing slide-type locking was out of scope for
this pass and not requested by the plan.

**`doc_info`'s `slideTypes` field is unfiltered** — every `doc.layouts`
entry, including ones with no name (`name` comes back `undefined`, same
convention the UI uses — `ly.name ?? t('Untitled')` — the agent sees the
raw optional field, not a display fallback, since `t()` is a UI concern).

See `slides/src/CLAUDE.md`'s Layout Manager entry for the full current-state
writeup (kept up to date across all 4 parts).

## 2026-09-20 — Layout Manager redesign part 3: tree layout, creation dialog, per-type fonts, reusable-object promotion

Built `feature/slide-type-tree-ui` on top of part 2's wiring. Judgment calls
not spelled out verbatim in the original redesign plan:

**Tree rendering is a depth-first SEQUENCE of per-level card-grid sections**
(`layoutmanager.ts`'s `renderTypeTree`/`appendLevel`), not a nested-DOM tree
or per-card indentation. `buildCardGrid` lays out a LIST of siblings as one
grid; the natural extension is one grid per tree level (all of one parent's
direct children together, side by side), with the next level's grid
appended right after, indented one step further, before moving to the next
sibling at the current level. Root level (depth 0) gets no header/indent at
all, so a document with zero `parentId` relationships anywhere — every
existing single-family file, every fresh deck — renders as a plain flat
grid, satisfying the plan's "zero-parent case stays uncluttered" check by
construction rather than a special case.

**Cycle/dangling-parent guard is the tree walk's own `seen` set, not a
change to `model.ts`.** `childrenOf` is a plain filter (only
`ancestorChain` is cycle-safe), so a naive recursive walk over a
hand-corrupted `parentId` cycle (A→B→A) could loop forever. The walk starts
only from real roots (`parentId === undefined`) and marks every visited id
in `seen`; a cycle's members are neither a root nor anyone's reachable
child, so they're never entered at all — natural termination, not a
depth-limit hack. Rather than let them silently vanish from the tab,
whatever's left in `doc.layouts` but not in `seen` after the walk (a cycle,
or a `parentId` pointing at an id that no longer exists) gets ONE more
flat, unindented fallback section. Known accepted gap: drag/‹›-reorder
inside that fallback section can misfile against the real top-level roots
(it's rendered with a display-only `parentId: undefined` that doesn't match
these entries' actual — broken — `parentId`), since delete/rename/star all
still work correctly by id regardless. Reaching this section at all
requires a hand-edited file; the bar for that case is "doesn't hang and
degrades gracefully," not full interactivity, and building a separate
reorder scheme for an admittedly-broken sibling set felt like solving a
problem nobody has.

**Reusable-object promotion reuses the REAL clipboard pipeline
(`serializeElements`/`parseClip`/`insertElements`), unlike part 2's
`remintElements`.** Deliberately different tradeoff: `remintElements` exists
specifically to bypass clipboard.ts's `LIMITS.elements` ceiling for a
same-document Basis clone (see part 2's entry above); promoting a *selected
element subset* into `doc.reusableObjects` is the same trust shape as
`insertReusableObject`'s existing reverse direction (same-document content,
strictly less foreign than a paste), and the plan explicitly asked for the
real pipeline here — a user hand-selecting elements to promote is far less
likely to blow past clipboard limits than an entire Basis-cloned slide
type's full element set, so the ceiling isn't the wrong fit here the way it
was for part 2's case. `promoteToReusableObject(store, els, name?)` composes
`model.ts`'s `createReusableObject` (mint+append) with `insertElements(...,
{nudge:false})` — no offset, since a promoted object should keep the exact
relative layout it had on its source slide, unlike a human paste.

**The Body/Heading font pickers move into `panels.ts`'s
`buildLayoutSurfacePanel`** (the Properties panel shown for a slide-type
sub-editor with nothing selected), as a new collapsed-by-default "Fonts"
section, reusing `fonts.ts`'s existing `populateFontSelect` — the same
control the old per-master font picker used, now reading/writing the
layout's own `fontFamily`/`headingFamily` (part 1) instead of a
`Master` field. Not gated on "has children," per the plan.

18 new user-facing strings, translated (machine-drafted, matching this
catalog's existing convention) into all 8 locale catalogs in the same pass
— `node scripts/test-i18n-coverage.mjs` is clean.

## 2026-09-20 — Layout Manager redesign part 2: `openApplyToMaster` deleted, not ported; Slide Types tab is a flat list until part 3

Two judgment calls made wiring `editor.ts`/`canvas.ts`/`store.ts`/
`render.ts`/`applyto.ts`/`layoutmanager.ts` to part 1's model changes (see
the entry below), neither called out explicitly in the redesign plan:

**`applyto.ts`'s `openApplyToMaster` has no replacement — it was deleted.**
Its whole reason to exist was scoping a building-blocks edit across a
master's WHOLE governed family, a reach `openApplyTo` (single-layout scope)
couldn't match on its own. Now that a former master is just a root
`doc.layouts` entry, `linkedSlides(doc, layoutId)` already walks the FULL
descendant subtree (part 1's `ancestorChain` walk) — so opening the
existing `openApplyTo` dialog on a root layout already returns every slide
anywhere under it, several tiers down included. There is no scope
`openApplyToMaster` could reach that `openApplyTo` doesn't already reach for
free, so keeping both would be a duplicate code path with no distinct
behavior. Its only caller (`renderBlocksPane`) is deleted in this same
pass anyway.

**The Slide Types tab is a temporary FLAT list, not yet the parent/child
tree the redesign calls for.** Grouping by master is gone (there's no master
to group by); rendering `Slide.parentId` as an indented tree is explicitly
`feature/slide-type-tree-ui`'s job (part 3), not this wiring pass's. Ship
this pass with the plainest thing that compiles and isn't misleading, so
part 3 has one thing to build (the tree), not two (the tree AND untangling
whatever stopgap grouping this pass might otherwise have invented).

Also: "+ New slide type" (`layoutmanager.ts`'s `newSlideType`) now always
mints a Basis clone (`createSlideTypeAsBasis` + a local `remintElements`)
instead of offering a Blank/Parent/Basis choice — the real choice is part
3's creation-dialog job. `remintElements` is a small standalone id-remap
(mirroring clipboard.ts's `insertElements`) rather than routing through
clipboard.ts's actual `parseClip`/`sanitizeElement` pipeline: that pipeline
enforces `LIMITS.elements`/clipboard-size ceilings meant for content
arriving off the system clipboard, which would risk silently truncating a
same-document, already-trusted Basis-clone source for no reason. The same
helper replaced `mergeLayoutFamily`'s (library-import) old hand-rolled
per-element remint, incidentally fixing a pre-existing gap where an
imported layout's `groupId`/`parentId` relationships were never remapped
(a container and its children would have silently re-merged onto whatever
same-named ids already existed in the importing document).

## 2026-09-20 — Layout Manager redesign: `Master` collapses into `Slide.parentId` (reverses 2026-09-03 "Hierarchical layout masters")

Reversed because the separate `Master`/"Building Blocks" entity — a third
concept alongside slide types and reusable objects, with its own pill-strip
UI — didn't map to how the author thinks about templates: shared/inherited
chrome should be a relationship BETWEEN slide types, not a hidden parent
entity. Once `Master` disappears, "a master" is nothing but a `doc.layouts`
entry other entries point at via `parentId` — no second array, no second
identity space, no second editing surface.

**Model** (`slides/src/model.ts`, this pass): `Master` and `SlidomingoDoc.masters?`
are GONE. `Slide.parentId?: string` replaces `Slide.masterId?` — meaningful
only on `doc.layouts` entries, forms a tree (cycle-safe: `ancestorChain`
stops at a repeat rather than looping, since the UI never lets you pick a
descendant as a parent but a hand-edited file could). `Slide.fontFamily?`/
`headingFamily?` replace `Master.fontFamily?`/`headingFamily?` — each slide
type keeps its own fonts now, nearest-wins down the chain.
`effectiveLayout(doc, layout)` keeps its EXACT signature/contract (a layout
with its ancestors composited underneath) but now walks the full
`ancestorChain` instead of one governing master, so N-level chains "just
work" — `instantiateLayout`/`applyLayout`/`renderThumbnail` needed ZERO
changes, they already treated this as an opaque flattened `Slide`.
`linkedSlides` dropped its `{layoutId}|{masterId}` union — "editing a layout
with descendants" is now just "editing a layoutId." Three explicit,
named-required mint functions (`createSlideTypeBlank`/
`createSlideTypeAsParentChild`/`createSlideTypeAsBasis`) replace the old
single `createSlideType` — Parent mode starts EMPTY (content is inherited,
never duplicated); Basis mode bakes `effectiveLayout` and remints every
element id, which also fixes a latent bug where the old clone path silently
shared element ids with its source. `removeLayout` now bakes a deleted
node's effective content into each direct child before detaching it (a
Parent-mode child starts empty, so a bare unlink would leave it blank) —
this also correctly absorbs a deleted MIDDLE-of-chain node's contribution
for deeper descendants for free, since their `ancestorChain` walk is just
one tier shorter afterward.

**Migration** (`parseDoc`): reuses each old master's id VERBATIM as a
synthetic `doc.layouts` root entry (so every `masterId` reference already
names it correctly with zero remap), turns the old implicit "unset
masterId → first master" fallback into an explicit `parentId`, and sets the
new migration-only `doc.rootFontLayoutId` to preserve the exact old
orphan-slide (no `layoutId` at all) font fallback. Verified byte-identical
by `scripts/test-slide-type-migration.mjs` (a fixture shaped like the OLD
format, round-tripped through `parseDoc`, checked against the old format's
meaning computed independently — not against the new code re-deriving
itself).

**fonts**: NOT folded into `doc.fonts[]` (that field specifically means
"embedded font asset → `@font-face`"). Instead a new pure-derived
`fontsInUse(doc)` (same precedent as `sectionsInOrder`/`linkedSlides`/
`commentEntries`) collects every font family referenced anywhere — theme,
every slide type at every tier, every element override — flagged
embedded/not. Nothing to keep in sync; introducing a font anywhere makes it
show up with no separate "register" step.

**Sequencing**: this is branch 1 of 4 (`feature/slide-type-model` →
`-wiring` → `-tree-ui` → `-mcp`, each depending on the last — see the plan
that produced this pass). This branch touches ONLY `model.ts` + the new
migration rig; `render.ts`/`editor.ts`/`canvas.ts`/`layoutmanager.ts`/
`store.ts` still reference the removed `Master` API and will not
type-check until branch 2 lands — expected and intentional, not a defect
in this branch.

## 2026-09-18 — Layout Manager: Reusable objects library (4th tab)

Small compound figures (icon+label, etc.) needed a home that is neither a
one-off slide element nor a full slide type. Added `doc.reusableObjects?:
Slide[]` (`model.ts`) — Slide-shaped, same reason `Master.buildingBlocks`
is: every function that already writes through `store.slide` (panel edits,
insert tools) needs a real object to write into, but only `elements` (and
optionally `name`/`background`) are meaningful; `transition`/`notes`/
`stateOf`/`layoutId` are inert leftovers from the shared shape. Absent
until first used, same additive discipline as `layouts`/`masters`.

**Editing surface**: `store.editingSurface` gained a third variant,
`{kind:'reusableObject', id}` (`store.ts`), alongside `'layout'` and
`'buildingBlocks'` — `store.slide` resolves it to the matching
`doc.reusableObjects` entry, `enterReusableObjectEdit`/
`exitReusableObjectEdit` mirror the other two surfaces' enter/exit pair.
Deliberately **no live-link concept**: unlike a layout or a master's
building blocks, nothing ever resyncs from a saved reusable object once
inserted — `editor.ts`'s `syncLayoutInstances` explicitly skips this
surface, and insertion (`editor/reusableobjects.ts`'s
`insertReusableObject`) goes through the ordinary clipboard pipeline
(`serializeElements` → `parseClip` → `insertElements`), the same one a
library item or a system-clipboard paste already uses — so a
container+children unit gets its `groupId`/`parentId`/`parentOffset`
remapped for free, with no new sanitizer or trust boundary (same-document
content is strictly less foreign than a library file). Deleting the saved
object afterward never touches any inserted copy.

**Unbounded authoring canvas**: `REUSABLE_OBJECT_CANVAS = {width: 3200,
height: 2000}` (`model.ts`) is a fixed, generous stage — a new
`effectiveCanvasSize(store)` (`store.ts`) returns it while this surface is
open, else `doc.size`, and `canvas.ts`/`patheditor.ts`/`beziereditor.ts`/
`lineedit.ts` read it instead of `doc.size` directly so drawing/editing
near the edges of a small figure isn't invisibly clipped at the deck's
usually-much-smaller slide box. `render.ts` gained a `RenderOpts.size`
override (the actual clipping fix, since the rendered slide surface is
`overflow:hidden`) and `renderObjectThumbnail()`, which crops tightly to
the object's actual bounding box so a small figure doesn't thumbnail as a
speck on a 3200×2000 canvas.

**Minimal panel, deliberately not `buildSlidePanel()`**: `panels.ts`'s
`buildReusableObjectPanel()` shows Name + Background only, gated in
`PropsPanel.rebuild()` by `store.editingSurface?.kind === 'reusableObject'`
when nothing is selected — the full slide panel's "Page size" control
writes `doc.size`, which would let an edit meant for a small figure
accidentally resize the WHOLE DECK. (The 2026-09-19 quick-fixes pass
extends this same minimal-panel treatment to the Building Blocks/Slide
Types surfaces, which had been falling through to `buildSlidePanel()`
unguarded.)

**UI shape**: 4th Layout Manager tab — grid + sub-editor, simplified
mirrors of the Slide Types panes (no star/master/live-scope chrome, since
none of those concepts apply to an unlinked, un-typed object). The shared
insert-toolbar button set (`insertgroup.ts`) gained a new "Insert reusable
object" entry, wired into the main topbar, the desktop ribbon, and both
other Layout Manager panes, backed by `reusableobjects.ts`'s
`openReusableObjectPicker` (search-as-you-type popover, reuses
`library.ts`'s `.ed-library-*` styling verbatim).

**Known v1 limitation**: no live link — editing a saved reusable object
never propagates to copies already inserted into the deck (each insertion
is a one-time, fully independent fork). This is deliberate scope, not an
oversight: unlike a layout/building-block, a reusable object's whole
purpose is "drop an independent copy," not "stay in sync."

---

## 2026-09-18 — Layout Manager: scoped "Apply to…" workflow for slide-type edits

Editing a slide type in the Layout Manager's sub-editor is live and
global: `editor.ts`'s `syncLayoutInstances` resyncs every linked slide on
every `'doc'` event while the sub-editor is open, unconditionally, with no
way to choose who keeps following the change afterward. By the time any
"apply" dialog could open, every linked slide has ALREADY received the
edit for free — so this is not a preview-before-applying gate, it's
**retroactive scoping**: of the slides that already got the edit, which
should keep tracking this slide type going forward, and should the shared
template itself be overwritten (the default, a pure no-op) or forked into
a new, separately-named slide type?

**UI**: an "Apply to…" button on the sub-editor breadcrumb
(`layoutmanager.ts`, next to the live-scope pill), hidden when
`linkedSlides(doc, {layoutId})` is empty — no linked slides means the
template alone already fully expresses the edit, nothing to scope. Opens
`applyto.ts`'s `openApplyTo(store, layoutId, onDone)`: a modal listing
every already-resynced slide as a checked-by-default checkbox row (a
thumbnail + name), plus a destination radio pair — "Overwrite this slide
type" (default) or "Save as a new slide type" (text input for its name,
enabled only when this radio is chosen).

**`commit()` semantics** (the part most worth getting exactly right):
"Overwrite" is a pure no-op on `doc.layouts`/`slide.layoutId` — the
template already has the edit, there is no new id to retarget to, so it
returns immediately without touching the checkbox selections at all.
"Save as a new slide type" clones the current (already-edited) layout
under a fresh id and name, clears its `stateOf`/`notes`, appends it to
`doc.layouts`, and retargets `layoutId` only on the slides that are
CHECKED in the list — unchecked slides are left exactly as they are,
silently remaining linked to the original template (which keeps its old
name and now stops tracking future edits from this session's perspective,
though nothing stops someone editing it again later). One `store.commit()`
per apply = one undo step.

**v1 deliberately never reverts a deselected slide's visual content or
touches its `layoutId`-linked appearance** — it already carries the live
edit; deselecting only changes who gets retargeted if "Save as new" is
chosen. There is currently no way to give a deselected slide back its
PRE-edit appearance short of manual undo of the original edit itself. A
real revert would need a pre-edit snapshot taken at sub-editor-open time
and is out of scope for v1 — tracked as the deferred v2 this entry is the
design writeup for (see `applyto.ts`'s header comment, which points here).

**2026-09-19 fix, same file**: the checkbox list visually looked live
regardless of which radio was selected, even though "Overwrite" ignores
`selected` entirely — rows are now greyed out (`.ed-applyto-list-inert`,
`styles.css`) and every checkbox disabled while "Overwrite" is checked,
re-enabled under "Save as a new slide type", so the dialog no longer
implies the checklist matters when it doesn't.

---

## 2026-09-18 — Group Slide Types grid by governing master

Once a document can hold 2+ masters (see the 2026-09-03 "Hierarchical
layout masters" entry below), a flat Slide Types grid with an inert
per-card master badge stopped scaling — there was no visual grouping, just
a label repeated on every card. **Decision**: `layoutmanager.ts`'s
`renderTypesGrid` stays a flat `renderTypeCards(doc.layouts, null)` grid,
byte-identical to before, whenever `(doc.masters?.length ?? 0) <= 1` (the
common case gets zero new chrome). With 2+ masters, it instead partitions
`doc.layouts` via `layoutsForMaster(doc, m.id)` into one named section per
master (`renderMasterGroupHead`: name + an optional body/heading font-pair
caption), skipping any master with zero slide types — no placeholder
clutter — and drops the now-redundant per-card master badge, since the
section heading already says it.

**Reordering stays scoped to the card's own group**: the new
`moveLayoutWithinMaster(doc, masterId, from, to)` reorders within
`layoutsForMaster`'s subsequence, then splices the result back into the
flat `doc.layouts` at exactly the positions that master's entries already
occupied — other masters' relative order never shifts. Drag-and-drop's
payload now carries the origin group (`{masterId, index}` instead of a
bare index); a drop handler in a DIFFERENT master's section refuses it
outright (cross-group drop is a no-op). **Master reassignment is
deliberately NOT reachable from the grid at all** — it stays exclusively
the sub-editor breadcrumb's master `<select>`, keeping each card down to
3 interactive affordances (star/name/delete) plus the (now grouped, not
per-card) master context.

---

## 2026-09-18 — Per-slide "exclude from page numbering" flag

Distinct from `hidden`: `Slide.excludeFromNumbering?: boolean` (`model.ts`)
lets a slide opt out of the page-number COUNT while staying fully visible,
navigable, and included in the PDF — `hidden` pulls a slide out of linear
flow/PDF/thumbnail entirely, this only affects numbering. Implemented as
one added clause in `model.ts`'s `paginates`:
`!s.stateOf && !s.excludeFromNumbering && (!s.hidden || !!doc.present?.numberHidden)`.
Panel: a "Exclude from page numbering" toggle beside "Hide slide" in
`panels.ts`'s `buildSlidePanel` (offered only on ordinary slides, same
`!slide.stateOf` gate "Hide slide" already uses — a state is already
unreachable linearly, so numbering means nothing there), with a hint
clarifying it stays visible/reachable and later slides still count
normally. Setting it on a `doc.layouts` template resyncs into already-
linked slides the same way background/typography already do
(`editor.ts`'s slide-type resync: `if (effective.excludeFromNumbering)
slide.excludeFromNumbering = true; else delete slide.excludeFromNumbering`).
`untrusted.ts`'s `SLIDE_CHECKS` gained `excludeFromNumbering: bool` so a
pasted/imported slide's flag survives sanitization.

**2026-09-19 note**: this flag is only meaningful for a slide actually IN
`doc.slides`. The same quick-fixes pass that added this note also fixed
`panels.ts` falling through to the full `buildSlidePanel()` (and thus
showing this toggle, "Hide slide," deck-wide Page size, and the Slideshow
section) when nothing is selected in the Building Blocks pane or a Slide
Types sub-editor — neither a master's `buildingBlocks` Slide nor a
`doc.layouts` entry is ever itself a member of `doc.slides`, so all of
those controls were semantically nonsensical there. See `panels.ts`'s
`buildLayoutSurfacePanel`.

---

## 2026-09-03 — Master/layout building-block elements are locked against direct per-slide editing

A slide's `elements[]` are baked once at creation from
`effectiveLayout(doc, layout)` (`instantiateLayout`), which composites the
governing master's `buildingBlocks.elements` in FRONT of the layout's own
elements (i.e. painted behind them). From that point on those baked-in
block elements are indistinguishable, in `slide.elements`, from anything
the user drew — nothing marks them as "this rides in from the master." A
plain click that hit-tested onto one (typically a full-slide background)
selected it whole, which read as "clicking the slide selects the whole
slide." Worse: `editor.ts`'s building-blocks resync
(`syncLayoutInstances`) keeps these elements in lockstep with the master
on every master edit, so any hand edit made directly on the slide would be
silently stomped on the next resync anyway — the same documented
"frame+typography always wins on re-apply" trap layout placeholders
already have.

**Decision**: `model.blockIds(doc, layout)` returns the ids of a layout's
governing master's `buildingBlocks.elements`. `editor/canvas.ts`'s new
`lockedIds()` resolves that set for whatever's currently being edited —
empty while editing the blocks themselves (`editingSurface.kind ===
'buildingBlocks'`, so the Building Blocks tab is unaffected), else via the
normal slide's `layoutId` or the Layout Manager's own `layout` surface.
Plain click (Selecto `selectEnd`), drag-marquee, and Alt-click deep-select
(`deepSelect`) all filter locked ids out of their candidate set; a click
that resolves to nothing but locked chrome behaves exactly like clicking
empty canvas (deselect, empty-canvas context menu) rather than selecting
the background. `resolveClickTarget()` (real DOM hit test via
`document.elementsFromPoint`, not the elements'-bbox approximation
`deepSelect` uses) is the fallback when Selecto's native hit-test comes
back locked-only, so a click that visually lands on real content sitting
behind the locked chrome still reaches it in one click. The only reachable
escape is the existing "Unlink from layout" (drops `slide.layoutId`) —
deliberately no override valve for reaching a locked element directly,
since (per the resync trap above) any such edit would just be overwritten
regardless.

**Related, found live while verifying this**: the right-click context menu
(`.ed-ctx-menu`) shares a `z-index: 210` popover tier with several other
floating panels, but the Layout Manager's full-screen overlay
(`.ed-layoutmgr-overlay`) is `z-index: 1000` and — like the context menu —
a direct `<body>` child. The menu opened correctly from inside the Layout
Manager (right selection, right item set) but painted UNDER the overlay's
opaque background: fully wired, completely invisible and unclickable.
Fixed by raising `.ed-ctx-menu` alone to `z-index: 1010`. Also gated the
menu's two "Add Comment" items on `!store.editingSurface` — comments.ts has
no editingSurface awareness, so one added while editing a master's
building blocks or a layout's own placeholders would land on
`buildingBlocks.comments`/`layout.comments`, which the sidebar/badge UI
never iterates (`doc.slides` only) — a silent dead end.

`ShapeElement.strokeCap?: 'round'|'square'|'butt'` (line shapes only) was
added in the same pass — purely additive (`render.ts`'s line branch falls
back to the pre-existing `dashed → butt, else round` rule when unset), with
a "Cap style" panel row alongside "Line style"/"Start tip"/"End tip".
Unrelated to the locking work above beyond sharing a PR.

---

## 2026-09-03 — Hierarchical layout masters: `doc.master` → `doc.masters[]`, per-master fonts, field-insert UI

Follow-on from the 2026-09-02 "Layout Manager" entry below, whose singular
`doc.master: {buildingBlocks, defaultLayoutId}` is superseded by
`doc.masters: Master[]` (each `{id, name?, buildingBlocks, fontFamily?,
headingFamily?}`) plus a top-level `doc.defaultLayoutId` (moved out of the
old wrapper — it's doc-wide, not master-scoped). `Slide.masterId?: string`
is new, meaningful only on `doc.layouts` entries: which master governs that
slide type. Unset (or dangling, e.g. a deleted master) resolves to
`doc.masters?.[0]` — same tolerance `Section.startSlideId` already gets — so
every existing single-master file, and every fresh single-master deck, needs
zero configuration and shows no new UI chrome. **Each layout FAMILY (the set
saved/imported together) now carries its own master**, the closest analogue
to PowerPoint's Master → Layouts → Slides tree this format has — chosen over
per-section masters or a second document-wide field.

**Migration**: `parseDoc` converts an old singular `doc.master` in place —
`doc.masters = [{id: <minted>, buildingBlocks}]`, hoists `defaultLayoutId` to
the top level, deletes `doc.master` — the same idiom it already used to mint
a missing `docId` on load. Verified: a fixture built with the old shape
re-parses to the new one, renders byte-identical building blocks and default
layout, and re-saves in the new shape (see the ad-hoc DOM-based verification
rig used for this pass, not checked in — no jsdom/Playwright infra exists in
this repo; `scripts/test-clipboard.ts`/`test-sanitize.ts`/`test-validate.ts`
deliberately stick to render.ts's pure string functions for exactly this
reason, per `scripts/lib/dash-dom.ts`'s header comment on why DOM-dependent
assertions belong in a real browser, not a Node rig).

**Per-master font cascade**: `Master.fontFamily`/`headingFamily` insert into
`render.ts`'s existing `el.fontFamily || doc.theme.fontFamily` fallback
chain — `RenderOpts.fonts` (auto-resolved per slide by `renderSlide` via a
new `resolveSlideFonts`, layered ahead of `doc.theme`), so editing a master's
font pair re-fonts every linked slide live with no per-element migration.
`role:'title'` elements (and only those — deliberately conservative;
subtitle/kicker/body stay on the body font, matching the built-in layouts'
existing role conventions) prefer the heading face at each tier before
falling through to that tier's body face. This is also what makes
`doc.theme.headingFamily` — declared, validated, documented, but never once
read at render time before this — actually render for the first time.
`fonts.ts` gained `populateFontSelect(sel, doc, current, defaultLabel)`,
extracted out of panels.ts's per-element font picker so the Layout Manager's
new per-master Body/Heading font pickers share the exact same embedded/
installed/curated-stack option-building logic rather than a second copy.

**"Import layouts from library…"** (Layout Manager, Slide types tab) is the
one new capability that makes multi-master documents reachable through
normal use — without it, `doc.masters` would never hold more than one entry
(a fresh deck only ever starts with the family it was created from). Picks
any `.slidomingo.html` file via the File System Access API (gated on
`showOpenFilePicker`'s presence, not `window.slidomingoDesktop` — matching
`editor/library.ts`'s and startuppicker.ts's `importTemplate`'s existing
gate, since the picker itself is the real availability signal) and merges
the picked file's WHOLE layout family (every master + every `doc.layouts`
entry) into the open document, reminting every id (master, layout, and every
element within them) through a remap table first — the same
never-collide discipline `editor/clipboard.ts`'s cross-doc paste already
applies to asset-key collisions, reused directly via its exported
`mergeClipResources` for the shared-asset/embedded-font half of the merge.
**Deviation from the plan this was implemented from**: the plan described
reusing a `startuppicker.ts` "family" tile-grid UX and a `model.layoutLibraryDoc`
helper from a separate, unmerged `remove-templates-layout-library` worktree
this pass was explicitly told not to depend on — neither exists on this
branch's base, so the import flow was built fresh against `editor/library.ts`'s
existing "foreign Slidomingo file" trust posture (`extractForeignDoc`)
instead. The "family-carry-over spread" fix the plan named in
startuppicker.ts likewise targets code that doesn't exist here — skipped, not
missed.

**Field-insert UI**: the `{{page}}`/`{{pages}}`/`{{title}}`/`{{date}}`/
`{{time}}`/`{{author}}`/`{{company}}`/`{{subject}}`/`{{event}}` tokens
already fully worked (`render.ts` `resolveFields`/`fieldContext`) — the gap
was discoverability, not function. panels.ts's Typography section gained an
"Insert field…" control: a floating menu (not a native `<select>`, which
would steal focus and end an in-progress canvas text edit before a token
could reach it — `canvas.ts` commits on `blur`) whose trigger/option buttons
call `mousedown` + `preventDefault()` so opening it never blurs a live
`contentEditable`; mid-edit it inserts at the cursor via
`execCommand('insertText', …)`, otherwise it appends to `el.html` through
the ordinary panel `mutate()` path (documented simplification — panels don't
track cursor position outside an active edit session). The Layout Manager's
Building Blocks toolbar also gained a one-click "Add page-number footer"
button (`{{page}} / {{pages}}`, bottom-right) for the actual common case.

Everything above is additive per `docs/PLATFORM.md`'s format-additivity rule;
`scripts/build-modelkeys.mjs`/`untrusted.ts`'s `SLIDE_CHECKS` (which
`scripts/test-clipboard.ts` asserts covers every `MODEL_KEYS.slide` name)
were updated for `masterId`. PPTX import is untouched by this pass — it
still bakes chrome per-layout rather than extracting real per-master
building blocks, per the plan's explicit scope (new masters are only ever
created by hand or by Claude's Describe-it path).

## 2026-09-02 — Drop the bundled `iconserver/` reference implementation

`slidomingo/iconserver` (a standalone, zero-dependency Node HTTP server) is
removed from the repo entirely. It was never spawned, bundled, or otherwise
wired into `desktop/` — it was a fully separate process a user would run
manually — so its presence read as "our own server embedded in the app,"
which is not the intended architecture. The editor's icon-library client
(`slides/src/editor/iconlibrary.ts`) already treats "icon server" as a
generic, swappable HTTP contract (any server implementing
`GET /api/search?q=` + `GET /files/{relative_path}`, e.g. a self-hosted icon server) with
zero dependency on this package, so nothing else needed to change.

The parts of the removed `iconserver/README.md` worth keeping — the optional
multi-root addressing convention (`relative_path` as
`"<dirId>/<path-within-that-directory>"`) and the trust-boundary framing
(a compatible server is expected to bind loopback-only and is not expected to
sanitize served SVGs; `render.ts`'s `sanitizeSvg` is Slidomingo's actual
safety net regardless of origin) — were folded into `iconlibrary.ts`'s header
comment, so the contract stays documented in one place without a bundled
implementation. This is deliberate, not an oversight: a future agent/session
should NOT reintroduce a bundled server under `slidomingo/iconserver` (or
elsewhere) without reopening this decision.

---

## 2026-09-02 — bento → slidomingo: every remaining identifier renamed, deliberately breaking the splice-id "FROZEN" invariant

This is PR 2 of the two-PR decoupling (PR 1, the bento.page feature removal,
is the entry below this one). Every "bento" identifier left in the tree —
format string, splice-contract element id, MIME types, file extension,
`BentoDoc` type, `window.bento` scripting API, IPC channel prefix, MCP server
name, `appId`, CSS class/attribute prefix, localStorage key prefix, copyright
headers — is renamed to `slidomingo`. This also corrects the `SlidoMingo`
(capital S+M) mis-casing from the prior cosmetic-only rebrand commit
(`Rebrand to SlidoMingo: app name, chrome, and colors`), which deliberately
deferred internal identifiers to this change.

**Old → new, representative:**

| Category | Old | New |
|---|---|---|
| Document format string | `bento/slides` | `slidomingo/slides` |
| Splice-contract element id | `id="bento-doc"` | `id="slidomingo-doc"` |
| Splice MIME types | `application/bento+json`, `application/bento+lang` | `application/slidomingo+json`, `application/slidomingo+lang` |
| Encryption envelope | `bento/enc` | `slidomingo/enc` |
| File extension | `.bento.html` | `.slidomingo.html` |
| TS document type | `BentoDoc` | `SlidomingoDoc` |
| Scripting API | `window.bento` | `window.slidomingo` |
| CSS/attr prefix | `.bento-*`, `data-bento-*` | `.slidomingo-*`, `data-slidomingo-*` |
| IPC channel prefix | `bento:*` | `slidomingo:*` |
| Preload bridge globals | `window.bentoDesktop`, `window.bentoTerminal` | `window.slidomingoDesktop`, `window.slidomingoTerminal` |
| localStorage key prefix | `bento-*` | `slidomingo-*` |
| MCP server name | `bento-slides` | `slidomingo-slides` |
| App identity | `appId: 'bento-slides'` | `appId: 'slidomingo-slides'` |
| Copyright header | `Copyright (c) 2026 The Bento authors` | `Copyright (c) 2026 The Slidomingo authors` |

**Deliberately breaking, again.** §2 of `docs/PLATFORM.md` called the splice
id "FROZEN, same id, forever" — that invariant is intentionally broken here,
same as PR 1 broke the file extension and format string. An already-shipped
`.bento.html` file (including ones already degraded by PR 1) does not open in
a build carrying this change: the splice id it looks for
(`#bento-doc`) no longer exists in the shell, so the new shell's own
`parseDoc` finds nothing to read and boots the starter deck instead of the
user's document. This is a one-time, deliberate breaking change accepted by
the user twice during planning (see PR 1's entry below for the full
confirmation record) — not an oversight, and not something a future reader
should "fix" by reverting.

**Generated files were regenerated, not hand-edited**, per this repo's usual
rule for anything under a `scripts/build-*.mjs` generator:
`slides/src/modelkeys.generated.ts` (generator's `keysOf('BentoDoc')` call
fixed first), `slides/src/i18n/packed.ts` (rebuilt after the source string
changes below), and `scripts/starter-library/Slidomingo-Starter-Library.slidomingo.html`
(rebuilt from `slides/dist-single/Slidomingo_Slides.slidomingo.html`, replacing
the old `SlidoMingo-Starter-Library.bento.html`).

**`slides/package.json`'s `build:single` output filename** was corrected to
`Slidomingo_Slides.slidomingo.html` — matching what `scripts/apps.mjs` and
every `scripts/build-*.mjs`/test rig that reads the built shell already
hardcoded — rather than the mismatched `SlidoMingo.bento.html` the prior
cosmetic rebrand commit had left in place (a pre-existing doc/reality
mismatch: `CLAUDE.md`, `README.md` etc. already documented the
`Bento_Slides.bento.html` name that `package.json` did not actually produce).

**Live bento.page dependencies removed, not just renamed**, since PR 1 already
deleted self-update/collab/packs and no `slidomingo.page` equivalent exists to
rename them to: `README.md`'s hero section (try-it link, download link,
plugin-marketplace skill install) no longer points at a live site; the
editor's About dialog and Help panel now link to
`github.com/miqsoft/slidomingo` instead of `bento.page` and the old
`nyblnet/bento` GitHub org; the starter deck's closing-slide CTA and speaker
notes no longer name `bento.page`; `docs/agents.md` and
`docs/generate-brief.md` dropped the same dead skill-download instructions
(and, per the AI-facing-prose guidance, genericized the two "Bento's
signature move" marketing lines rather than swapping in "Slidomingo's");
`scripts/postbuild-compress.mjs`'s AI-tooling comment (shipped in every built
file) lost its `bento.page`/`nyblnet/bento` links the same way.

**Left alone, deliberately — not resolved by a mechanical rename:**
- `docs/RELEASING.md`'s description of the `nyblnet/bento`/`nyblnet/bento-site`
  release-repo pair and the `bento.page` release/DNS infra (PR 1 already added
  a decoupling-note disclaimer at the top of this file). Real replacement
  release infra, if any, is a human decision — inventing a `slidomingo.page`
  domain or a new site-repo name here would be a guess, not a fact.
- `docs/pr-build-size-design.md`'s link to GitHub Discussion #178 on
  `nyblnet/bento` — left as-is; that specific discussion does not exist on
  the new repo, so rewriting the org/repo in the URL would point at nothing.
- The 9 locale files' (`slides/src/i18n/*.ts`) translated strings for the old
  "Visit bento.page" / "Full guide at bento.page/help" UI copy are now
  orphaned (the English source strings changed to the GitHub links above) —
  left in place rather than risk mistranslating a removal across 8 languages.
  Harmless: `scripts/test-i18n-coverage.mjs` still reports 100% core coverage,
  since coverage is keyed off strings actually referenced by `t()`, and an
  unreferenced catalog entry is simply inert.
- `slides/src/CLAUDE.md` and `slides/src/editor/CLAUDE.md` still describe
  features PR 1 deleted (self-update, `window.slidomingo.updates`, a
  `slides/src/sync/CLAUDE.md` that no longer exists) under their now-renamed
  `slidomingo/*` identifiers. PR 1's own entry below already flagged this as
  follow-up doc debt rather than something to fold into either PR.

---

## 2026-09-02 — Element library is an ordinary deck; `code` elements were being silently dropped by every sanitizer

**Decision.** A shareable element/group library (slides/src/editor/library.ts,
"Insert from library…") is NOT a new format: a library file is an ordinary
`bento/slides` document, and each library item is just one `Slide` in
`doc.slides` (`slide.name` = display name; one element = a single-item share,
several sharing a `groupId` = a group). Save/splice/preview/docId/collab
dormancy are inherited for free. Browsing a picked file is template-gallery-
level trust (render.ts sanitizes at render time regardless); actually merging
a picked item into the open document goes through clipboard.ts's existing
pipeline (`serializeElements` → `parseClip` → `insertElements`) — same
sanitize+merge+asset-collision handling as a paste, no new trust boundary.
Master/layout propagation needed zero new plumbing: `store.slide` (store.ts)
already redirects to the open `doc.layouts` entry while `editingLayoutId` is
set, so an insert lands on the layout automatically — the toolbar entry point
just had to not be added to `masterDisableButtons`.

**Also fixed, found by this work's own tests.** `code` elements
(`model.ts` `CodeElement`) were being silently DROPPED by `sanitizeElement`
(untrusted.ts) on every path that uses it — clipboard paste included, not
just the new library insert — because `scripts/build-modelkeys.mjs`'s
hand-maintained `ELEMENTS` map (interface-name lookup for `MODEL_KEYS.element`)
was never taught about `CodeElement` when the code element shipped, so
`MODEL_KEYS.element.code` did not exist and `sanitizeElement` treated `code`
as an unknown type. Fixed: `ELEMENTS.code = 'CodeElement'`, regenerated
`modelkeys.generated.ts`, added the missing `untrusted.ts` checks
(`content`/`grammarAssetId`/`grammarName`/`themeAssetId`/`themeName`).
**Any future new element type must be added to that `ELEMENTS` map by hand** —
the AST walk only covers types listed there, so `build-modelkeys.mjs --check`
passing is not proof a type is covered; a caught-once regression, added to
`scripts/test-clipboard.ts`'s round-trip fixture so it cannot come back
unnoticed.

**Pointers.** `slides/src/editor/library.ts`, `slides/src/editor/clipboard.ts`
(cross-doc `insertSlides` now also clears a pasted slide's dangling
`layoutId`), `scripts/build-modelkeys.mjs`, `slides/src/untrusted.ts`,
`scripts/build-starter-library.mjs` (starter content: 5 `CodeElement` items in
js/py/rust/sql/sh + 2 shape/svg groups).

---

## 2026-08-19 — Cross-app embedding: static render + source, never a second renderer

**Decision.** One block/element shape, `bento/embed`, shared by every app in both
directions (a Dash chart in a Type contract, a Type doc in a Spaces page, either
in a Slides deck):

```
{ kind:'embed', app:'bento/dash', doc:{…}|'asset:…', view:'<svg…>', w, h, caption? }
```

Three tiers, and the ORDER is the design. `view` — a static render — is always
present, so the embed paints in any app with zero extra code, thumbnails, and
prints. `doc` — the source — is always present, so it round-trips: open in Dash,
edit, come back. A live sandboxed iframe is OPT-IN per embed, never the default.

**Why.** Embedding the other app's renderer means shipping every renderer in
every file to cover the matrix (each is 100KB+) and living with version skew
between the embedded copy and the real app. The static render is what makes a
self-contained file self-contained; the source is what stops it being a
screenshot. A Bento file IS a runnable page, so `srcdoc` genuinely works for a
live chart — but it is opt-in because most embeds do not need it and every one
of them would cost the file a full shell.

Constraints this inherits, not new ones: format additivity (PLATFORM §3) means
an app that does not know `bento/dash` still shows the render plus an "open
in…" affordance, never a hole; the splice contract (§2) means the payload can
never carry a bare `</script>`, so it is escaped like `#bento-doc` or stored as
an asset; and since every document is untrusted input, a live iframe is
sandboxed with no same-origin. Default to data + render — embedding a 500KB
shell per chart is how a contract becomes 3MB.

**Status.** The SHAPE is settled here so the apps do not each invent one. The
shared definition belongs in the kernel and is therefore a serialized kernel
change of its own (PARALLEL-WORK §1): it has not been made. bento/type
implements the consumer side in its own app zone against this shape, so the
kernel lift is a move, not a redesign.

**Pointers.** `type/src/embed.ts`, `docs/PLATFORM.md` §2–§3.

---

## 2026-08-24 — The tree moved to `home/`, and the identifiers moved with it

**Decision.** `tray/` is now `home/`, `applicationId` and
`PRODUCT_BUNDLE_IDENTIFIER` are `page.bento.home`, and the update channel is
`https://bento.page/releases/home/manifest.json`. This supersedes the scope
paragraph and the bundle-identifier bullet in the rename entry above.

**Why the earlier decision was right when it was made, and wrong to keep.** It
was written while `tray/ios` (#315) and the Android work were both open in
`tray/`; moving the tree under them would have turned two mergeable branches
into conflict resolution. That was a real cost and a correct call at the time.
Both landed, and the reason expired.

The bundle-identifier bullet expired differently. Its argument was explicitly
conditional — changing the id "creates a different one that cannot update the
installed copy". There was no installed copy, no App Store Connect record and no
Play listing. Those three facts are what made it free, and all three stop being
true at first publish. **This was the last moment the identifiers could move.**

**What did NOT move, and why the line is there.** Rename what the outside world
sees or what becomes permanent on publish; leave what is internal and guarded:

- **The IndexedDB name stays `bento-tray`** (`home/webext/src/db.js`).
  `scripts/test-webext-background.ts` asserts it — a deliberate guard against
  silently orphaning every stored grant. Nobody outside the extension ever sees
  it, so renaming it would have meant editing a gate to let a cosmetic change
  through.
- **`bento-tray://` (iOS) and `.bento-tray.invalid` (Android)** stay. They are
  per-document origins, settled in their own entries, and invisible.

**The cost, stated.** Every path reference moved: 18 files outside the tree, 35
inside it, plus the Kotlin package `page.bento.tray` → `page.bento.home` and the
`tray-icon`/`tray-logo`/`ic_tray_mark` assets. That churn is what the original
entry warned about, and it was the price of not carrying a dead name forever.
## 2026-08-25 — The tray hosts are called `bento/home`

**Decision.** All three hosts are named **`bento/home`** — lowercase, with the
slash, set like `bento/slides`. **Never "Bento Home"**, in any casing, in any
surface a user reads. This supersedes the naming half of the 2026-07-26 entry
below, which called the iOS app `bento/tray`.

**Why `home`.** It is not a component that needs distinguishing from the brand —
it is where documents live and where new ones start, on every host. The suite
convention is `bento/<what you get>`, and what you get is your documents.

**Why the qualifier route was abandoned, so it is not tried again.** The
alternative was a distinguishing second word, and every candidate died to a live
collision: **box** → BentoBox (and "bento box" is the literal object), **desk** →
Addit's furniture line, **works** → Apple's iWork, **keep** → Google Keep. That
is four independent attempts failing the same way, which is the signal that the
premise was wrong rather than the words: the front door does not need a
qualifier, because it is not one thing among several.

**Scope: the PRODUCT is renamed, not the tree.** Directories stay `tray/ios`,
`tray/android`, `tray/webext`, and `tray/bridge.js` keeps its name. Renaming
paths would churn every import, every doc link and every open branch for no
reader's benefit — the name people see is not the name the repo files it under.

**What must NOT change, on any host:**

- **The bundle identifier.** `page.bento.tray` on iOS, and its Android
  counterpart. To the OS and the store it IS the app: changing it does not rename
  the app, it creates a different one that cannot update the installed copy.
- **`PRODUCT_NAME` / `CFBundleName`** (iOS). They name the executable and the
  bundle, not the label. `CFBundleDisplayName` is the label, and it is the only
  key the rename touches.
- **The App Store listing name.** Per 2026-07-24, `/` is a mark and never a
  stored name, and store names are stored. The listing keeps a slashless form;
  the on-device label does not. Those are separate fields — see the note on the
  2026-07-26 entry for why that pair is not a contradiction.

`bento/home` is 10 characters, which fits the iOS home-screen label without
truncation. (`bento/tray` was 10 too, so this was not at risk, but it is the
constraint any future rename has to clear.)

**Where it landed.** `tray/webext` first, in PR #360 / `50d1c40` — read that as
the precedent for which strings change. `tray/ios` in PR #315: the display name,
the search screen's lockup, and the mark's `aria-label`. `tray/android` follows.

Screen readers get the spoken form, not the mark: `aria-label` and
`accessibilityLabel` say "bento home", because a slash is read out as
punctuation. Visible text keeps the slash, and only the search screen can colour
it — the home-screen label, the browser title and the Browse folder are system
chrome drawn as plain text.

**One practical note for the listing, since it is cheap to record and expensive
to rediscover:** App Store screenshots need documents that have been **saved at
least once**. A preview is only written on save, so an unsaved document
photographs as a "Not saved yet" placeholder — a whole screenshot set can be shot
and only later found to be showing empty cards.

---

## 2026-08-23 — The web demo gates on RETURN, not on save

Someone works at `https://bento.page/slides/`, saves, comes back later and gets
a fresh starter, because a never-saved deck stays dormant by design. It reads
as lost work. It is not — the file is on disk — but nothing on screen says so,
and two things genuinely do not survive: version history and recovery live in
IndexedDB keyed to the `bento.page` ORIGIN and do not follow the file to
`file://`, and neither does the session.

**Blocking straight after the save was considered and rejected.** Once an FSA
handle exists the editor silently rewrites the real file every 2.5s
(`writeUpdatedFile`), so that tab is a working session writing to disk on every
edit; interrupting it would sever something that is functioning and lose
whatever was typed since the last write. The confusion happens on the NEXT
visit, so that is where the gate goes. **"Start a new deck anyway" is always
present** — some visitors do want a fresh one, and some cannot install
anything.

**Availability gating is required from day one, not added later.** The offer is
`hasFsAccess()` × `hostCan('write')` × *which host actually has a release*.
Hardcoding "install the extension" would tell an Android user to install a
Chrome extension. `HOST_AVAILABLE` in `kernel/src/returngate.ts` carries that,
and `scripts/test-return-gate.ts` pins both states — that the mobile rows say
"keep the file" today, and that they become real offers the day the flag flips,
so the flag is wired rather than decorative.

**Capability decides what to SAY; the platform guess decides only which LINK.**
`hasFsAccess()` is a real feature test, UA sniffing is a guess. A browser that
gains the API is handled correctly on the day it ships with no change here. For
Safari/Firefox desktop the honest answer is a different browser, not a pitch
for an extension that cannot help them.

State is viewer-scoped `localStorage`, never in the document — the same rule
locale, theme and reduced motion follow. A deck carrying it would tell everyone
you sent it to that you had once saved something.

In `kernel/`, not `slides/`: Spaces, Dash and Type have the identical problem
and would each grow their own copy. The kernel owns the remembering and the
policy; the words and the markup are the app's. Spec (gitignored):
`working/team/handoffs/handover-web-demo-return-gate.md`, from the `tray-views` session.

NOT done here, and worth weighing first: making **Download** the primary action
on the landing page (it is currently `btn primary` on "Try it in your browser")
would avoid the situation for most people and costs nothing. That is a site
change, not an app one.
## 2026-08-23 — Sharing a space is a DERIVED document, and the sharer stays the owner

bento/spaces' "Invite someone…" was `saveAs('copy')`, which serializes
`store.doc`. `collab.ownerPriv` rides in that document and is the room's ROOT
key — it signs writes and it signs revocations — so everyone invited to a space
received the power to remove the person who invited them. Measured on the
branch: the bytes that button wrote contained `ownerPriv` in full, and nothing
about the copy looked wrong.

**Every share copy is now derived, never the open document.**
`spaces/src/share.ts` is the one place that says what a copy may carry:

  invite     room + read key + owner PUBLIC key + an owner-signed INVITE
             (a delegation keypair). Revocable per device, and per invite.
  view-only  room + read key + public keys, and NO private half at all.
  anything   no `collab` block, by dropping it whole — a template, a page
  else       extract, the JSON on the clipboard.

The stripper DELETES rather than rebuilds, so a private field added to
`CollabCreds` later is covered without anyone acting. That is the same
derive-by-removing rule `docForExport` already follows, and the two are NOT the
same case: the clipboard copy must carry no capability, an invite must carry
exactly one. Do not merge them.

NO RELAY CHANGE WAS NEEDED OR MADE. v2 rooms, the owner → invite → member
chain, per-socket key pinning and `rev.${pub}` are already deployed and already
verified by the worker (docs/collab-design.md, "Phase 1 wire format"); this app
was simply not using them. A new client that DEPENDS on relay behaviour still
has to be sequenced after a relay deploy — that rule is unchanged and did not
bind here.

**Read-only is the relay's, the lock is a courtesy.** A view-only copy holds no
signing key, so its socket presents no `?w=` and the relay stores and fans out
nothing it sends. `main.ts` also opens it locked (`collab.role === 'reader'` →
`store.readOnly`) with a banner, which is a THIRD reason to lock alongside
`doc.readonly` (a sealed reading copy, no session) and `frozen` (a file this
build does not understand). Only this one keeps receiving.

**Five connection states, not two, and they must be repainted.** offline /
view-only / live / connecting / off. Measured in a browser against the live
relay: the button read "Connecting…" while the panel two inches below it read
"Live — 1 connected". Both call the same `state()`; the panel is rebuilt on
every open and the button was painted once at boot, because `onPeersChanged`
was the only thing calling `sync()` — and in a room where nobody has arrived
yet, that never fires. The transport's `onStatus` now drives it. Honest states
are worth nothing if they are painted once.

**Wording is lifted from bento/slides wherever the English string exists** —
24 of the 31 new strings, including every sharing tooltip. Two apps must not
describe one guarantee in two ways, and a reworded sentence costs eight fresh
translations to say the same thing. The seven that were adapted say "space"
where slides says "deck". (Noted in passing, not fixed here: the slides
catalogs give "Editor copy saved — recipients join live with edit access" the
translation of the ROLE word "Editor" in seven of eight locales. The spaces
catalogs carry the correct sentence for that key.)

Pinned by `scripts/test-spaces-invite.ts` — real WebCrypto keys, real
functions, asserting on the bytes: the owner private key appears nowhere in an
invite (the whole serialization is scanned, not the field), the owner's
signature over the invite verifies the way the relay verifies it, and a member
copy cannot mint invites. `scripts/test-export-secrets.ts` carries the cheap
half, so a new button cannot route around the first rig.


---

## 2026-08-22 — The starter space is a release gate, not a document somebody updates when they remember

`spaces/src/starter.ts` had been written once and left. Everything that shipped
after it — tables, clips, link cards, comments, calculating lines, daily notes,
page width, export-a-page, subtree import, the mark palette with its colours,
live collaboration and presence, the properties panel — was absent from the one
document every new user reads first, and its "Sharing & limits" page still said
live collaboration was coming, months after it arrived. A starter that silent is
not neutral: **a feature the starter does not demonstrate is a feature the
starter denies**, and the tour was denying about half the app.

So the doctrine is now ASSERTED rather than remembered. `scripts/test-spaces-agent.ts`
structurally requires the starter to carry a table, a clip, a link card, an
`asset:` picture, a page-link card, a callout, a FOLDED toggle, a calculating
line, a palette colour, a comment thread, an archived page, a journal home and a
page that sets its own width — plus determinism (two calls, byte-identical: ids
here are CRDT node keys), every parent resolving IN PRE-ORDER, every `#p/` and
pagelink target existing, no orphaned page, and assets and references agreeing.
Adding a feature and not the demonstration now fails a rig instead of shipping.

WRITING THE STARTER IS HOW THE CLAIMS GET TESTED, which is the whole argument
for the doctrine. Two defects fell straight out of writing this one. A hand-authored
table with `rows` and no fallback `html` put a working link on a page that
back-linked to nothing — `buildIndex` reads `html`, and `writeTable` is the one
writer that keeps the two in step, so the starter goes through it exactly as the
issues go through `propBlock`. And `validate()` asked every AUDIO block for
intrinsic `w`/`h`: pixels an audio player does not have, on a finding that would
have fired for every correctly-authored clip in existence.

THE ARCHIVED PAGE IS THE ⌘K DEMONSTRATION, one page doing both jobs the brief
asked for: it is out of the sidebar, so search is the way in, and "Sharing &
limits" names it by name because sending the file sends it too.

IT COST 7,000 B, measured on the stack: 5,336 B of prose and 1,664 B of the two
files it ships (`spaces/src/starterdata.ts` — a hand-written SVG drawing and a
1.2 s test tone, both chosen so that deflate reduces them to almost nothing: the
tone is exactly periodic and packs to 204 B). The ceiling moved 216 → 224 KiB in
the same commit, with the numbers in `scripts/size-budgets.json`.

THE STARTER IS NOT TRANSLATED, and that is deliberate rather than pending. The
interface follows the reader (PLATFORM §8); a document is written in a language,
and this one is written in English. Nine starters would be nine feature tours to
keep in step, and the space a user then writes in would be the only untranslated
one of the ten.

---

## 2026-08-22 — Inline marks: one canonical form, and the format's SECOND attribute

Two decisions, taken together because the second only makes sense inside the
first. Details in `spaces/src/marks.ts`; pinned in `scripts/test-spaces-model.ts`.

**A block's marks have ONE canonical spelling.** §2.3 asked for "fixed mark
nesting order, adjacent runs coalesced, no style" and only the middle third was
implemented: `canonicalize` was a fixed-point loop of `</b><b>` → `''` string
replacements, which cannot ask whether an `<i>` is inside or outside a `<b>`. So
`<b><i>x</i></b>` and `<i><b>x</b></i>` were both canonical — one visible string,
two byte spellings, and therefore a conflict in every diff and every future CRDT
merge. The order, outermost first, is

    a > mark > span > strong > em > u > s > sub > sup > code

and `b`/`i` FOLD to `strong`/`em` on parse (the markdown importer already emitted
the semantic pair; contentEditable emitted the presentational one, so files
already carry a mix). `a` is outermost because a link split in two by a bold
boundary is two links; `code` is innermost so its box hugs the text.

**The engine is a pure string function, not DOM surgery.** `document.execCommand`
is forbidden by §2.4(b) and ⌘B/I/U were calling it anyway. The replacement takes
(inline html, plain-text offsets) and returns inline html — so the hard case,
un-bolding half of a bold run, is pinned in a `node` rig instead of only in a
browser. The DOM appears in two functions at the bottom of the file that convert
a live Range to those offsets and back. `canonicalize` is now
`canonicalMarks(sanitizeInline(html))`: what is ALLOWED needs a browser, what
SHAPE it takes does not.

**Colour is a CLASS on SPAN/MARK, matched by PATTERN, and never a `style`.** The
vocabulary is Notion's — nine colours in two roles, `sp-fg-<name>` for the ink
and `sp-bg-<name>` for the band behind it — and a closed vocabulary is the whole
safety argument: the sanitizer matches a NAME instead of parsing CSS, and CSS is
a language with `url()` in it. The allowlist is `/^sp-(fg|bg)-[a-z0-9-]{1,16}$/`
and NOT an enumeration of today's nine, because of PLATFORM §3: with no server to
migrate anything, a build that strips what it does not recognise DESTROYS
documents written by a later one, so an enumeration would delete a tenth colour
added in two years, silently, on the next edit touching the block. A pattern
keeps it, round-trips it byte-for-byte, and renders it unstyled — degraded, which
is recoverable. Values live in the app's stylesheet, so they can be tuned for the
surface; an arbitrary hex in the document could not be.

**Colour survives printing, and this is deliberately the opposite of the callout
ruling.** A callout keeps its box, its rule, its tone's shape and its tone's
name, so dropping the fill costs nothing. An inline colour has no second cue:
drop it and the distinction the author drew is silently gone. `print-color-adjust:
exact`, scoped to inline marks only.

**Markdown: every mark the toolbar can apply exports, and imports back.** `mark`
→ `==x==`, which is native Obsidian syntax and a Pandoc extension, so it
round-trips outside this app too — the same standard the callout tones were held
to. `u`, `sub`, `sup` and colour → raw inline html, which GFM permits and which
is what Obsidian users fall back to as well; `_x_` for underline was rejected
outright because it re-imports as ITALIC, and a mark that comes back as a
DIFFERENT mark is worse than one that comes back as nothing. `htmlToMd` moved out
of about.ts (where it was a DOM walk and therefore untestable, and where it had
been silently dropping four marks) into marks.ts, over the same run list.

---

## 2026-08-22 — bento/spaces gets a CONTENT table, and its cells are strings

**Decision.** A `table` block: `rows` (row-major, each cell INLINE HTML), `cols`
(fractional column weights), `colAlign` (per COLUMN), `header` (absent = TRUE).
No formulas, no recalculation, no cross-document references — the line from
`working/design/spaces-design.md` §2.6. The database case is unaffected: it already
shipped as the tracker (`doc.fields` + `prop` + `view`), and this is not a
second one.

**A cell is a bare string, not slides' `{html, color, bg, bold}`.** Slides' cells
carry presentation because a canvas has no cascade; a space has a theme and a
stylesheet, and a spaces cell's content is already rich — bold in a cell is
`<b>`, through the same allowlist as every other block. So the entire `style`
object and every per-cell override go away, and the only thing left in a cell is
what someone typed. Alignment stays per COLUMN because that is exactly what a
GFM rule row can say; per-cell alignment would export as a lie on every row.

**`header` absent means TRUE**, which is the opposite of every other boolean in
the model and is deliberate: a pipe table always has a header, so the header case
is the one that should need no field, and a minimal hand-written
`{type:'table', rows:[[…]]}` is then a first-class document. A headerless table
exports with an EMPTY header row (GFM has no other way to say it) and the
importer reads that back as `header:false`, dropping the empty row — otherwise a
round trip grows a blank row each time.

**The `html` fallback is the whole of format additivity for a block type**, so it
is derived and rewritten on every table edit by the ONE writer (`writeTable`),
never authored. It is the cells' own inline html joined, not their text, so a
`#p/` link in a cell still produces a backlink (`buildIndex` reads `html`) and
still exports as a link from a build that has no table case. It costs a second
copy of the table's text in the file; a table that VANISHES in the build someone
already has is not the cheaper option.

**Shape is normalised at READ time (`tableOf`), never by repairing the file** —
the same rule as `effectiveParents`, so two readers agree without exchanging an
op and opening a space repairs nothing. Under collaboration `rows` is one
last-writer-wins register: two people editing different cells at once keep one of
the two edits. Slides' table has the identical limitation; the fix is a node per
cell, which is a format change, so it is written down rather than half-built.

**Editor chrome never goes inside an editable host.** The column grips first went
into the first row's cells and were written into the document as cell content —
and `caretToEnd` put the caret INSIDE the trailing `<button>`, so the first word
typed in a column landed in the button and was eaten by the sanitizer on blur.
They live in the wrapper now, absolutely positioned over each boundary. A cell is
`data-cell` + `data-r`/`data-c`, never `data-edit`: that name means "this
element's html IS the block's html", and the generic input handler would write
one cell over the whole table.

Details: `spaces/src/model.ts` (`tableOf`, `writeTable`, `tableFallbackHtml`),
`spaces/src/blocks.ts` (the registry entry and `tableToMd`), `spaces/src/render.ts`
(`renderTable`), `spaces/src/editor.ts` (`wireTables`, `tableKey`,
`startColResize`), `spaces/src/markdown.ts` (the pipe-table branch, which replaced
the "kept verbatim in a code block, mechanically upgradable the day a table block
ships" workaround), and the table section of `scripts/test-spaces-model.ts`.
## 2026-08-22 — spaces comments: the anchor IS where the thread is stored, and the block is why

**Two anchors, and no third.** A thread is about a BLOCK or about a PAGE. A
deck is a canvas, so slides can anchor a comment to an (x, y) and to nothing
else; a space is a tree of pages of blocks, and the block is the thing that
already has durable identity — ids are unique document-wide, never reused, and
are what links, backlinks and the CRDT key on. A text RANGE inside a block is
deliberately not an anchor: an offset pair has no meaning after the concurrent
edit that moved it, the format is permanent, and shipping the wrong answer now
would put it in every file. It is listed under "Not built yet" in
`spaces/README.md` rather than half-built.

**The anchor is expressed as STORAGE, not as a field.** `Block.comments` is a
thread about that block; `Page.comments` is a thread about the page. That is a
collaboration decision rather than a filing one. Under the shared engine
(`kernel/src/sync/crdt.ts`) every non-container property is one
last-writer-wins register per (node, key), so ONE `Page.comments` array — the
slides shape, transliterated — would make every thread on a page contend for a
single register: two people commenting on two different paragraphs in the same
moment, and one comment is gone with nothing said. Per block, that case
converges, because each block is its own CRDT node.

**The caveat that remains, stated rather than pretended away.** Two people
commenting on the SAME block concurrently, or on the same page, is still
last-writer-wins on that one array — the same limitation slides' table `rows`
carries, and for the same reason. Replies and resolve are in the array too, so
a reply that races another reply on the same thread can lose. Making that
converge means threads as their own CRDT nodes, which is an engine change, and
kernel changes are serialized (docs/PARALLEL-WORK.md). It is not shipped
blind: it is written in `model.ts` beside the type.

Storing on the block also settles two lifecycle questions for free: deleting a
block takes its threads with it (undoably, in the same step), and moving a
block to another page carries them along.

**Where the UI lives.** Not the gutter — a block already has one at the start
edge, and it holds exactly two controls because a phone reserves 44px and fits
one (2026-08-10, above); a third affordance there is a control no thumb can
reach. Not a sidebar panel — the sidebar is the page tree, the one navigation
this app has. Markers sit in the END margin, opposite the gutter, outside the
text column so they never reflow the prose they are about (measured: block
column ends at x = 1124.5, the marker sits at 1137.5). Page-level threads sit
in a row under the title. The thread itself is the editor's existing popover —
bottom sheet on a phone — so it dismisses like every other menu. The page tree
carries only a COUNT of unresolved threads, which is the one comment fact worth
knowing from another page.

**Editor-only, structurally.** `render.ts` — the single renderer behind the
editor, the reading view and print — has never heard of comments, and the
editor paints markers only when it is not in the reading view. Verified in a
real browser on the actual print tree: the whole-space print root rendered 11
pages, 0 markers, and no occurrence of the substring at all. The print
stylesheet drops them anyway, as a second line. `scripts/test-spaces-model.ts`
pins all three as source assertions.

**Comment text is PLAIN TEXT.** Not "sanitized like block html" — there is
nothing to sanitize, because nothing is ever parsed as html: the model stores a
string and the UI writes it with `textContent`. A comment arrives in a file
somebody mailed you, written by a person who is by definition not the author of
the document, and it has nothing to gain from bold. Verified in the browser: a
comment reading `plain <b>text</b> please` renders as those characters.

**The agent verb is READ-ONLY.** `bento.comments({resolved?, pageId?})` returns
every thread, flat, each stating its anchor. Acting on a remark is the agent's
job; resolving it is the commenter's — an agent that closed the thread it was
asked to address would make the record untrue. Every field is coerced to the
type the report promises, so a hand-edited file cannot make it throw halfway
through and tell the caller the first two pages are all there is.

**The name is `bento-author`**, the key the people panel already reads and
writes. Two keys would let one file disagree with itself about who you are.

**Cost.** +4,396 B on the shipped shell (166,482 → 170,878 B), inside the
existing 176,128 B ceiling (97.0%); no budget change.

## 2026-08-19 — The shells are packed with zopfli, and the format does not move

Every Bento file carries its whole runtime, so the packer's efficiency is a
property of every document anybody saves. Zopfli emits a stream in the SAME
deflate format as zlib, just searched harder — so the shipped loader is
untouched, already-saved files keep working, and an old updater splicing into a
new shell sees exactly what it saw before.

MEASURED, all four shells:

    spaces   173,598 -> 166,482    -7,116 B   4.10%
    slides   690,060 -> 663,760   -26,300 B   3.81%
    dash     169,617 -> 164,813    -4,804 B   2.83%
    type      33,899 ->  33,283      -616 B   1.82%

Verified rather than assumed, because "the format does not move" is the whole
argument. A zopfli payload handed to Chrome 148's native
`DecompressionStream('deflate-raw')` inflated to a byte-identical result
(SHA-256 matched) in 2.2 ms, and all four shells boot and render from
zopfli-packed payloads — checked in a browser, not only through the gate.

15 iterations, not 100: 100 buys 36 more bytes on spaces for three times the
time. The cost is about a second of build time per shell, paid once per
release.

THE DEPENDENCY IS PER APP, RESOLVED FROM THE CALLER. `scripts/` has no
package.json and neither does the repo root, so a bare import from
postbuild-compress.mjs would look in the wrong place — but every app runs the
script from its own directory, which is where `@gfx/zopfli` is declared. It
ships WASM embedded as JSON: no node-gyp, no compiler, no platform binaries,
140 KB, one transitive dependency. `node-zopfli` (native) would not have been
reproducible on CI.

A MISSING DEPENDENCY FAILS THE BUILD rather than falling back. Verified: exit
code 1, with a message naming the fix. A release quietly built 4% larger
because someone's node_modules was stale is a regression nobody would ever
notice. `ZOPFLI=0` is the deliberate escape hatch for a local build and says in
the same message that it is never for a release.

THE SPACES CEILING DOES NOT MOVE DOWN. 166,482 of 176,128 is 94.5%, and that
9,646 B of headroom is the point: the win is spent on the next feature rather
than banked by re-tightening the budget, which would have meant a fifth raise
the first time anything grew.

Two alternatives measured and rejected earlier, recorded so they are not
re-derived: BROTLI would save 20,580 B more but Chrome's DecompressionStream
accepts only deflate, deflate-raw and gzip, and a JS decoder costs more than it
saves; a DENSER PAYLOAD ALPHABET (basE91) would save 9,676 B but shell-gate.mjs
hard-fails any data block containing a literal `<`, and base64 is relied on for
being zero-`<` by construction against hostile payloads.

---

## 2026-08-19 — Page width has TWO settings, because it answers two questions

The per-page control shipped in #325 answered "this page needs the room". It
did not answer "I have a wide screen", and it made somebody say so on every
page in a space one page at a time. Reported as still-narrow after it shipped,
and MEASURED at a 2560px viewport: a 720px column using 31% of the area with
1,591px empty beside it.

Two settings now, and the split is the whole point:

  · `Page.width`  — DOCUMENT data. What this page needs; travels with the file.
  · `bento-sp-width` — VIEWER data, in localStorage. What this reader's SCREEN
    is; never written to the file.

Precedence: the page, then the reader, then the board default, then the
measure. A reader who sets it once gets it on every page that has not asked for
something specific, and the document is byte-unchanged — verified: four pages
at 1500px with no `width` key stored on any of them and no `"width"` anywhere
in the serialized doc.

That split is the rule locale and reduced motion already follow (PLATFORM §8):
two people opening one space on a laptop and a 27-inch monitor should each get
their own answer, and neither should write theirs into the file the other
opens.

THE BUILT-IN DEFAULT ALSO GROWS, `min(max(measure, 42vw), measure × 1.25)` —
720px on a laptop, 900px at 2560px. Capped deliberately: 720px is already ~88
characters at 16px, and past ~95 a line gets harder to read rather than easier,
so the cap is a typographic limit and not a shortage of nerve. Filling a 2560px
screen with one column of prose is not the goal; not showing a ribbon in the
middle of it is.

PRINT DOES NOT INHERIT THE READER WIDTH. Paper has a fixed width, and the size
of the monitor somebody happens to be sitting at is not a fact about the page
they are printing. Pinned in the rig.

---

## 2026-08-19 — How wide a page is belongs to the PAGE, not the theme

`theme.measure` is one number for the whole document — "text column width in px
— DOCUMENT data: the same for every reader". The right answer genuinely differs
per page, and the renderer already knew it: a page carrying a `view` block
silently jumped from 720px to 1500px, with a good comment explaining that a
board is not a line of text.

The problem was that it decided for you and offered no way to disagree. MEASURED
at a 1600px viewport: a 720px column with 631px of the page empty beside it, and
0 of the 15 blocks on the starter's Welcome page reaching the limit at all. The
line length was never the complaint — 720px at 16px is ~88 characters, already
at the upper end of comfortable. Having no say was.

`Page.width?: 'wide' | 'full'` now, offered in the page menu as Column / Wide /
Full width. It makes the board rule EXPLICIT rather than magic: a board page
with no key still gets its room, and a board page set to Column now gets to be
narrow.

THE DEFAULT IS AN ABSENT KEY, never a stored `'normal'` — the rule `editView`
already follows. A page somebody set to wide and back is byte-identical to one
never touched, and a file written before this control existed stays that way. An
unknown value from a newer build falls back to the measure rather than to no
width at all.

Not raised: `theme.measure` itself stays 720. Widening it would push past 88
characters for every page in the document to solve a complaint about empty
space, which is the wrong lever.

Measured after: column 720, wide 1500, full 1895 at a 2200px viewport; a board
page with no key still 1500. +1,128 B, no ceiling change.

---

## 2026-08-18 — The spaces topbar fits itself by measuring, not by px breakpoints

The bar folded at 820px and again at 600px. Those numbers moved once already
(720 → 820, because at 768 the save caret still ended 27px off the screen) and
they would have moved again, because a px guess cannot answer the question
being asked. The same buttons need different room at the same viewport width
depending on browser zoom, OS text scaling, live content, and — this is the one
that matters here — the reader's language.

MEASURED on the shipped shell at a 1600px viewport: the control group is 568px
in English and 618px in German. Fifty pixels the 820 threshold was never
calibrated for, in a file that ships eight catalogs so that any reader can open
it in their own language. The English-calibrated breakpoint was the only
calibration there was.

Three tiers now, applied by `fitTopbar()` stepping down while the bar still
overflows its own box: `sp-bar-compact` drops the button words, `sp-bar-tight`
drops the wordmark, `sp-bar-fold` moves whole controls into ⋯. A ResizeObserver
is the primary signal; a MutationObserver catches the content that changes
width at a fixed viewport (the people count arriving when somebody joins a
session). The observer must NOT watch `class` — fitTopbar's own tier flips are
class changes on that element.

THE SECOND COPY OF THE NUMBER IS GONE, which is the real win. `isPhone()` was
`matchMedia('(max-width: 600px)')` with a comment saying the number was
duplicated from the stylesheet on purpose; it decided what the ⋯ menu carried,
and when it disagreed with the CSS the symptom was a menu offering Undo while
Undo sat in the bar two centimetres away. It is `isFolded()` now and it reads
the tier off the bar — there is nothing left to disagree with.

The drawer breakpoint STAYS a media query (820px). Whether the page list is a
column or an overlay is a layout mode, not a question about whether things fit,
and slides keeps its own for the same reason.

Follows bento/slides #239, which settled this first.

---

## 2026-08-18 — Presence in a space is a page, shown in the tree

bento/slides paints collaborator cursors on its canvas, because a deck IS a
canvas and "where is that person" means a position on it. A space is a TREE,
and the useful question is which PAGE somebody is on — a caret position two
levels down a wiki tells a reader nothing they can act on.

So presence lives in the sidebar: a coloured initial on the page each person is
reading, three of them and then a count. It costs one span per person, it is
visible without opening anything, and it is what makes a shared space feel
inhabited rather than merely synced. `SyncHost.presence()` already reported the
page rather than the block for the same reason (a block-level cursor would
republish at typing speed).

THE BUTTON REPORTS THREE STATES, NOT TWO, and this was got wrong twice before
it was got right. Same-machine tabs sync over BroadcastChannel with no relay at
all, so "has peers" and "is online" are different facts:

  · online, with people  — Live, and how many
  · peers but no relay   — another window on this computer; NOT shared online
  · neither              — not sharing yet

The first version showed a peer count of 1 under the words "Not sharing yet",
which is a control contradicting itself in a single glance. The second fixed
the button and left the same conflation in the panel, which listed nobody while
that person's dot was visible in the tree two inches away. The panel's LIST now
follows who is here; only its ACTIONS follow the relay.

TWELVE OF THE TWENTY-FOUR NEW STRINGS WERE LIFTED WORD-FOR-WORD from the
bento/slides catalogs rather than reworded — the refusal messages, join/leave,
"Your name", "Start live session". They were already written, reviewed and
translated into eight languages; rewording them would have cost eight fresh
translations to say the same thing and let the two apps drift on the one
message a user only sees when something has gone wrong.

---

## 2026-08-18 — A shared space connects on open; a fresh one still does not

bento/spaces follows the rule bento/slides already ships: `shareEligible()` —
auto-connect on open ONLY if the document arrived carrying collab credentials
(it was saved, or somebody shared it), or if the user opted in during this
session. A never-saved starter space and a template someone is kicking the
tyres on stay dormant.

The alternative was to connect whenever credentials exist. That is the obvious
call and it is wrong here for a reason this repo has already paid for: v0.9.0
of slides connected every visitor to the anonymous demo and v0.9.1 had to undo
it. The rule is also already written down for this app — "A space does not
phone home when it is opened" (2026-08-03) — and nothing about collaboration
changes what that promise means.

Worth being honest about the wrinkle, because it is the reason to revisit
rather than close this. A space is a whole wiki, so "open the file somebody
mailed me" is a far more ordinary act than opening a deck, and that file
carries credentials by construction: the capability IS the file. Receiving a
space therefore joins its room, which is what the sender intended and may not
be what the reader expected.

TO BE REVISITED WITH bento/vault, which is where per-recipient access stops
being a property of the file and starts being something a broker can answer.
Until then the file is the capability and this rule is the whole of the
protection. Decided by the user, 2026-08-18.

---

## 2026-08-18 — The healed page's id comes from the ROOM, not from docId

The kernel's `heal()` contract is explicit that a repair does not converge by
itself: it is minted as an ordinary local op, and two replicas that heal at the
same moment mint two nodes which the CRDT faithfully keeps. It tells an
implementer to derive the id from stable document data, and it suggests
`docId`.

**bento/spaces must not use `docId`**, and the reason was already written down
next to `repairId` in model.ts before collab existed: `template: true` re-mints
`docId` on every open, so a docId-derived id gives two readers of ONE file
different ids — precisely the failure derivation exists to prevent.

`doc.collab.room` is the right seed. Every replica that can race to heal is by
definition in the same room; the value is identical for all of them by
construction; and it does not move when a template is opened. The fallback to
`docId` is safe exactly where it is reached — a document with no room has no
second replica to disagree with.

Pinned by scripts/test-sync-spaces-session.ts: two replicas with the same room
and DIFFERENT docIds still heal to one page.

Also settled while binding: "empty" for a space is ZERO PAGES, not an empty
page — and a dangling `doc.home` is NOT a repair case, because `homePage()`
already falls back to `pages[0]` on its own. Minting a page for it would
manufacture a phantom to fix something that was never broken.

---

## 2026-08-18 — 'doc' is this app's dirty signal, so a remote op must not raise it

The kernel session used to emit `'doc'` after every remote change, because that
is what bento/slides calls "something changed, repaint". In bento/spaces the
same name means something else: editor.ts binds it to `status('Edited')`, the
unsaved dot and the undo buttons. Emitting it for a colleague's keystroke would
put "Edited" in this user's chrome for someone else's work.

The kernel now takes `changeEvents` and `structureEvents` from the app. Spaces
declares `changeEvents: ['page']` and `structureEvents: ['tree']`: 'page' is
bound to paintPage + paintTree and carries no status text, so it repaints
without claiming authorship, and 'tree' covers a structural change to a page
other than the one on screen.

The first version declared `changeEvents: []`, reasoning that repaints could
ride on the structural events alone. That is wrong and the rig did not catch
it — two browser tabs did. A remote TEXT edit is not structural, so nothing
fired: `block.html` held the new sentence while the DOM still showed the old
one. Every remote change must repaint; only the authorship claim was ever the
thing to withhold.

The dot still has to move: the file on disk IS out of date, however the change
arrived. The kernel calls `store.setDirty(true)` independently of the events,
and store.ts routes that to its own `'dirty'` event, which the editor binds to
the dot alone. Two facts, two signals, instead of one signal asked to carry
both.

A REMOTE APPLY ALSO BYPASSES `commit()` — deliberately, so it never joins this
person's undo stack — which leaves `store.index` describing the document as it
was. `clampView()` therefore calls `reindex()` before anything reads the index.
This was not theoretical: measured, a block that had already arrived in
`doc.pages[0].blocks` was invisible to `store.block(id)`, and the first version
of the rig hid it by reindexing by hand.

---

## 2026-08-18 — Where a reader lands when somebody deletes what they are reading

A deck clamps an INDEX. A space navigates by page identity (`#p/<id>`), so the
only question is whether the page you are reading still exists — and when it
does not, `reindex()`'s own fallback sends you to the home page, out of the
part of the space you were working in.

`clampView()` surfaces at the nearest surviving ANCESTOR instead, falling back
to home only when the whole chain is gone. It needs `captureView()` for that:
after the apply the page is simply gone and there is nothing left to be near.

Presence reports the PAGE and never the block. A block-level cursor would
republish presence at typing speed — the typing run in store.ts exists because
a notes app may never blur — while a page changes only when somebody
navigates, which is the rate presence is worth.

---
## 2026-08-16 — Creating a document: every host VERIFIES the release it downloads

**Decision.** Starter shells are bundled in no host (settled separately the same
day: they change too often, and there are three apps with more coming), so
fetch-from-the-release-channel is the ONLY way any tray host creates a document.
That path must therefore verify, in this order, in every host:

1. fetch the manifest **as text** — it is a signed envelope, `{payload, sig}`,
   and the fields (`app`, `version`, `sha256`, `url`) are inside the payload
   STRING; there is nothing useful at the top level;
2. verify the ECDSA P-256 / SHA-256 signature over the payload's **exact UTF-8
   bytes** (no canonicalisation) against the release public key;
3. check the payload's `app` matches the channel being read — the channels are
   sibling paths on one origin, so a genuine manifest from the wrong path hands
   somebody a different application;
4. download the shell and check its sha256 against the payload's pin;
5. only then touch a file handle. A refusal writes **nothing**.

**Why.** The shell is executable HTML written to the user's own disk, which they
subsequently double-click and trust. Without the chain, whoever can answer for
the release origin — compromised host, bad CDN edge, hostile-network proxy —
chooses what code the user creates. Signature over the pin, pin over the bytes;
neither half is worth anything alone.

Step 3 is the one that is invisible to the other two, so it is the one that gets
skipped: a `bento-slides` manifest and a `bento-dash` manifest are both
genuinely signed by the same key, and the shell each points at really does hash
to what its payload pins. Serving one on the other's channel passes the
signature AND the digest — every byte authentic, just not what was asked for.
Only identity catches a swap between two REAL releases, which is exactly what
survives an origin or CDN compromise where the attacker cannot forge but can
re-serve. The check must be made against the app that was **requested**, not
against the payload's own claim about itself, and an ABSENT `app` must not read
as a match. (`tray/ios` found both native hosts missing this while reviewing
webext's rig — PR #315, PR #318.)

**Ask for BYTES: send `Accept: */*` explicitly on every release fetch.**
Measured against the live shell URL on 2026-08-17, independently by tray/ios and
tray/webext: the wildcard returns 689,316 bytes and matches the signed pin; a
browser's own `Accept: text/html,…` returns 689,675 and does not. The extra 359
bytes are a Cloudflare Web Analytics beacon the edge injects before `</body>`
into anything it reads as a page being browsed. Same URL, same `.bento.html`
extension both times, so the trigger is the header — fortunate, because a
path-keyed injection could not be avoided by any host. Most platforms already
default to the wildcard; set it anyway, because the default is the platform's
and not ours. (An earlier note that this was "fixed at the origin" was wrong and
is retracted — it is live as of this entry.)

**NO DOWNGRADES: every host keeps a per-app version floor.** Decided by Andy on
2026-08-17, after `tray/ios` implemented one and `tray/webext` held pending the
call — it is a policy trade, not a pure security win, and three hosts
half-adopting it would be worse than one landing late. A replayed OLD release
passes signature, app identity AND digest: it is genuinely signed and its shell
really does hash to its pin. Only memory catches it, because a document being
created carries no version to be monotonic against (unlike the shell's own
update, which measures from its running build). Two details that bite:

- **Raise the floor only AFTER the downloaded bytes pass their hash.** Raising
  it on a merely-verified manifest lets one forged-but-unfetchable release lock
  the host out of every real release below it — a failed attack made permanent.
- **An EQUAL version must be accepted.** Re-fetching the version already held is
  the normal case (the second document somebody creates), and refusing it breaks
  creation on its second use rather than at some exotic edge.

An unreadable store reads as NO floor: availability over protection in a case
that is not an attack. An unparsable version component sorts as 0 rather than
throwing — verified identical in `kernel/src/update.ts`, `tray/webext`'s
`compareVersions` and `Releases.swift`, since `Number('x')` is NaN and
`NaN || 0` is 0. **The accepted cost:** a deliberate maintainer rollback is
refused until the version moves past the floor. That is the same trade
`kernel/src/update.ts` already makes, so the whole system is at least
consistent.

**A 404 on a channel is an ANSWER, not a fault.** Only Slides is published
today; the app list is aspirational on every host. All three say
"<App> has not been released yet" rather than surfacing an HTTP status.

**Proving the verifier REFUSES is a separate obligation from writing it.** A
verifier only ever watched saying yes is indistinguishable from `return true`,
so each host's rig runs the real captured manifest plus deliberately bad ones.
Three cases are worth naming because each catches something the others cannot:

- **A valid signature under the WRONG key** is not the same test as a bent one.
  Bending bytes proves a non-validating signature is rejected, which almost any
  bug-free crypto call manages; a signature that validates PERFECTLY under an
  untrusted key is what catches a verifier that imported the wrong key, or that
  would trust a key travelling inside the manifest. No test seam is needed —
  sign the real payload with a throwaway key and hand it to the shipped
  verifier. (The NEGATIVE cases must never go through an injected key, or a
  verifier that trusts one passes its own tampering tests.)
- **An unsigned manifest is refused as a CATEGORY**, not as a parse error. A
  flat `{url: …}` is exactly the shape the old broken reader wanted, so
  "malformed" invites someone to add a lenient fallback for it later as a
  compatibility gap. It is not a gap.
- **An absent `app` field must not read as a match** — `undefined !== 'bento-x'`
  passes by construction, and a plausible tidy-up to `info.app && info.app !== x`
  silently turns a missing field into a pass.

**Status.** `tray/webext` done (`src/release.js`, used by `library.js
newDocument`); `tray/ios` done (`Releases.swift`, PR #315); `tray/android` in
progress.

**Pointers.** `kernel/src/update.ts` is the reference implementation
(`verifySigned` / `fetchPinned` / `verifyManifest`) and hosts should reuse it
where they can import it. The extension **cannot** — it ships as unbundled ES
modules Chrome loads from disk, and adding a bundler would mean the shipped
package is no longer the reviewed source — so `tray/webext/src/release.js` is a
deliberate line-by-line mirror, with the resulting obligation stated in the
file: *if the key or the envelope format moves in the kernel, it moves here
too.* `scripts/test-webext-release.ts` pins both ends against a REAL captured
manifest (`scripts/fixtures/release-manifest-slides.json`).

**The failure this came out of, because it generalises.** `newDocument` read
`manifest.url` off the envelope's top level, where there is no `url`, and so
threw on every invocation: the `+` button had never worked in any version. Its
rig passed, because the fixture was written to the shape the CODE expected
rather than the shape the SERVER sends. A fixture that is not the real shape
proves only that the code agrees with itself — hence the captured manifest, and
hence the same warning for android and ios.

## 2026-08-16 — iOS document search: CoreSpotlight is the surface, and the port is pinned to the LIVE reference

**Decision.** `tray/ios` implements the search settled below. Three things that
the Android port and any future host should follow or knowingly diverge from:

**1. On iOS the "native list" is a screen BESIDE the document browser, and the
system index is a first-class output.** `UIDocumentBrowserViewController` stays
the root; search is one toolbar button away from it. The extracted prose is also
donated to **CoreSpotlight**, which is what the original gap statement ("the app
contributes nothing to search — no CoreSpotlight, no `NSUserActivity`") actually
asked for, and Spotlight results are resolved back through the index rather than
by re-deriving a path. Android has no equivalent obligation; its recents list IS
its root, so it has one surface where iOS has two.

**2. TWO checks, because they catch different things.**
`scripts/test-tray-index.mjs` runs both:

- **against the shared corpus** (`tray/fixtures/`, with `tray/doc-index.mjs` as
  the reference and `expected.json` as the answer key). This proves all three
  hosts give the same frozen answers — including Kotlin, which nothing on a Mac
  running the Swift rig can execute. Budgets are checked too: a port that agreed
  on every case while carrying a different `TEXT_BUDGET` agrees by luck.
- **against the RUNNING `library.js`**, imported live — `describe()` is exported
  and takes injectable deps, so a fake file handle runs the real code path.

The second is not redundant. A frozen answer key pins each port to a SNAPSHOT:
when `library.js` moves, static expectations go stale silently and every host
stays green while drifting from the thing they are copies of. Importing the
reference means it cannot move without a rig failing. Verified 2026-08-16: the
Swift port agrees with both, on all 11 corpus cases and on 59 documents against
the live reference.

**The corpus contract is the one to conform to where they differ.** It folds
`isDocument` into the same call and returns nulls throughout for a file that is
not ours; `library.js`'s `describe()` always returns a title, falling back to the
file name, because its caller sniffs first and it never faces a non-document.
`BentoIndex.describe` follows the corpus and the LISTING supplies the file-name
fallback — which is the better seam anyway: inventing a title during extraction
reports one for a file that is not a Bento document at all.

**3. Ports must count UTF-16 code units.** The reference is JavaScript, where
every index, length and budget is UTF-16; the natural Swift/Kotlin spelling uses
graphemes or code points and disagrees on any document containing an emoji or a
CJK character — that is real documents, not pathological ones. One deviation is
allowed and is written down in `BentoIndex.swift`: the final `slice(0, 40KB)` can
land inside a surrogate pair, and where JavaScript keeps the lone half a Swift
`String` cannot hold one, so it is dropped. The rig accepts exactly that shape
and nothing looser.

**Also:** enumeration needs a folder grant the app did not previously take
(folder-mode `UIDocumentPickerViewController`, persisted as a security-scoped
bookmark). Each indexed document gets its OWN bookmark, minted inside the
folder's open scope, because a file in a granted folder is readable only while
the FOLDER is scoped and an editing session outlives the walk. Encrypted
documents are never read for text or preview, and revoking a folder deletes its
documents from CoreSpotlight — both enforced in `LibraryIndex`, not just
described. Parity table: `tray/README.md`.

## 2026-08-16 — Document search: the list stays native, the indexer is shared by FIXTURE

**Decision.** When the native hosts grow a document library, each keeps its own
**native list UI** and ports the text extraction itself; the three
implementations are held together by **one shared fixture corpus**, not by a
shared runtime. Specifically NOT by moving `tray/webext`'s `home.html` /
`library.js` into a WebView on the native hosts.

**The gap this is about.** The three surfaces are at three different levels, and
only one of them can search:

| | what "search" means there |
|---|---|
| `tray/webext` | scans every granted folder; matches title, file name, folder, **and the document's own prose** (`library.js extractText`) |
| `tray/ios` | the system document browser's search field — **the app contributes nothing to it** (no CoreSpotlight, no `NSUserActivity`) |
| `tray/android` | **none**; a recents list sorted by last-opened |

`extractText` is the valuable part: up to 40KB of prose per document, pulled out
of the `#bento-doc` block as string VALUES (`:"…"`, never keys), data URIs
stripped first. Deliberately not a JSON parse, so it is format-agnostic across
slides/spaces/dash and degrades to "finds less" rather than throwing. It is free
in I/O because the same read already produced the thumbnail. That is what lets
someone find a deck by a phrase on a slide rather than by what they named the
file.

Both platforms CAN support this — it is a "not built" gap, not a "can't" one.
Android has `ACTION_OPEN_DOCUMENT_TREE` (a persistable whole-directory grant,
near-exactly `showDirectoryPicker`); iOS has the document picker in folder mode
(a security-scoped directory URL).

**Why the shared-WebView-library option was rejected.** Three costs, in
descending order of severity:

1. **iOS would throw away `UIDocumentBrowserViewController`,** which is not a
   list but a surface: Browse into iCloud Drive, Dropbox and every File Provider
   on the device, drag-and-drop, in-place rename, favourites and tags, the
   system's own sort and view controls. An HTML grid replaces all of that with
   less, and contradicts the property `tray/README.md` claims — *on iOS the app
   is a lens onto the filesystem; on Android it is a keyring*. **Android has
   nothing to lose here**, which is the asymmetry that makes a single shared
   answer wrong.
2. **Cold start costs ~0.5s,** on the first screen of every launch. MEASURED
   2026-08-16, Pixel 7 / Android 16 emulator, both cold: native list root
   **1171ms** (1241ms on a repeat) against WebView root **1728ms**. That is an
   emulator on Apple silicon, so treat it as a FLOOR — WebView provider load is
   I/O and CPU bound and a mid-range phone widens the gap. iOS was not measured.
3. **Accessibility stops being free.** Native lists get VoiceOver/TalkBack,
   Dynamic Type and system font scaling correctly with no effort; in a WebView
   Android's font-size setting does nothing unless `WebSettings.textZoom` is
   wired, and Dynamic Type does not reach web content without explicit work.
   Predictive back and interactive dismiss are native on a native screen and
   reimplemented in a WebView. `home.html` is also a desktop-first grid with a
   sidebar and would need a real mobile design pass, not a media query.

**The reasoning that settles it: the UX cost sits entirely in the part that does
not need sharing.** What is worth sharing is the INDEXER — pure data work, no UI.
The chrome is what costs cold start, accessibility and the iOS browser, and the
chrome is exactly what should stay native.

**Why this differs from `tray/bridge.js`, which IS shared.** That file is shared
because its semantics are subtle and a divergence is catastrophic and silent —
its comments record a bug that wrote users' documents out as zero bytes. Text
extraction is string scanning with a documented budget: a divergence makes search
find less, which is visible and recoverable. So the right guarantee is weaker and
cheaper. Trading "cannot diverge" for "cannot diverge SILENTLY" is the correct
trade at this level of consequence, and it is already this repo's idiom for
exactly this problem — the splice contract has a conformance gate in
`release.mjs`, the save-purpose ids have `scripts/test-savepurpose.ts`.

**Status (2026-08-16, later): BUILT ON ANDROID; iOS still to do.** The shape
above survived contact. `tray/doc-index.mjs` is the reference, `tray/fixtures/`
is the corpus (11 cases), `scripts/test-doc-index.mjs` and a JVM unit test hold
the JS and Kotlin implementations to it, and `tray/android` indexes granted
folders and searches their prose. The iOS session has been handed the same brief.

Two things the corpus caught that reasoning had not:

- **A single string value over 400 characters is not indexed at all.** The value
  regex is capped at `{1,400}`, so a long speaker note or a wordy text element is
  invisible to search — in all three hosts, today. Pinned by `longvalue.html` so
  no port can quietly "fix" it into divergence; changing it has to be a
  deliberate change everywhere.
- **JavaScript's `\s` is Unicode-aware and Java's is not** (and Java's
  `UNICODE_CHARACTER_CLASS` still excludes U+FEFF), so a port spelling it `\s`
  leaves non-breaking and ideographic spaces in the indexed text and a phrase
  search across one silently fails. The class is written out in full;
  `whitespace.html` catches it, verified by mutation.

**Thumbnails are in, and the reasoning that nearly excluded them was wrong.**
"the preview is HTML, so a native list needs a WebView per row" conflated two
different things: a WebView per scrolling row (the design this entry rejects) and
ONE offscreen WebView at index time producing cached bitmaps (which costs nothing
at launch and leaves the list plain `ImageView`s). The second is the obvious
design and it was talked past. Details and the three ways an offscreen render
silently produces the wrong picture: `tray/README.md` § Document search.

Parity table: `tray/README.md` § Android.

## 2026-08-16 — bento/tray gets an Android host (PR #87, rearchitected)

**Decision.** `tray/android/` is a document host, written against the same two
decisions as `tray/ios`: the document is served through an origin we control,
and the app ships **file access only** — no bundled runtime, no OTA channel of
its own.

It lands as **PR #87** (savrum, opened 2026-07-26), which asked the right
question first: Android needs a native host for the same reason iOS does. The
branch keeps that original commit and builds on it. Its `native/ios` half is
superseded by `tray/ios`, which arrived in the meantime; its Gradle and keystore
scaffolding is the shape used here; and the `isElementFullscreenEnabled` flag
`tray/ios` briefly used was found there.

What did NOT survive is the **architecture**, which is the one tray deliberately
rejected:

- it BUNDLES a deck and OTA-fetches a newer one from the GitHub releases API on
  every launch. tray's whole thesis is the opposite (`tray/README.md`, "What it
  is, and what it deliberately is not"), and an unsigned OTA — which the PR's own
  README flags — contradicts `docs/PLATFORM.md` §1 as well as the signed-update
  invariant.
- every save calls `ACTION_CREATE_DOCUMENT`, so Bento's 2.5s autosave write-back
  would open a file picker on a loop. It has no in-place path at all.
- the page is loaded from `file://` (opaque origin: unreliable `localStorage`
  and IndexedDB) and the shim is injected from `onPageStarted`, which races the
  boot-time capability check.

**Three Android-specific findings worth not rediscovering.**

1. **Write access is not implied by receiving a document.** `ACTION_VIEW` from a
   file manager grants READ ONLY; only the app's own `ACTION_OPEN_DOCUMENT`
   yields a persistable read+write grant. Checked per document
   (`canWriteInPlace`), and when false every save becomes a Save-As — the
   "when in doubt, prompt" rule the whole project already follows.
2. **`androidx.webkit` is a required dependency, not a convenience.**
   `addDocumentStartJavaScript` is the only true `.atDocumentStart` equivalent,
   and `addWebMessageListener` is **origin-scoped** where `addJavascriptInterface`
   is injected into every frame — a remote iframe in an untrusted document would
   otherwise be handed a channel that writes the user's file.
3. **`fitsSystemWindows = true` REPLACES a view's padding, it does not add to
   it** — and from targetSdk 35 edge-to-edge is mandatory, so insets must be
   applied by hand. Same for `enableOnBackInvokedCallback`: it stops
   `onBackPressed` being called at all on API 33+, so an override alone compiles,
   runs, and silently does nothing.

**A host must implement the page-dialog delegate, and BOTH lacked it.** Building
the Android host surfaced a bug that had been shipping in `tray/ios` too. Neither
`WKWebView` nor Android's `WebView` shows `alert`/`confirm`/`prompt` on its own,
and without the delegate they do not merely skip them — they answer wrongly and
say nothing: `alert()` is a no-op and **`confirm()` returns `false`**. Every one
of the runtime's seven uses is shaped `if (!confirm(…)) return`, so delete a
slide, remove a collaborator, reset access, replace all slides and embed an
oversized file all silently did nothing when tapped. Fixed on both
(`WKUIDelegate`, `TrayChromeClient`) and verified on both: iOS through
"Start from scratch…", Android over CDP (`true` on OK, `false` on Cancel).
Android additionally needs `onShowFileChooser` or `<input type="file">` cannot
open at all, which is how images, media and fonts get into a deck — restored
from #87's `native/android`, which had it.

**Parity is written down, not assumed.** `tray/README.md` § Android carries a
row-per-behaviour table of iOS against Android, marking each as the same, a
platform-forced difference, or a gap. The one gap is the status bar (iOS hides it
on iPad; Android does not on tablets), left undone because it cannot be tested
without a tablet target.

**The launcher icon is GENERATED from the shared mark**
(`tray/assets/make-icons.mjs`, with `--check` for CI). Android vector drawables
have no `<rect>`, so every rounded rectangle has to be re-expressed as path data
— four opaque `M…A…V…Z` strings nobody would ever diff against the SVG, so a
change to the mark would land on iOS and silently miss Android.

**`tray/bridge.js` is now SHARED** by both native hosts (was
`tray/ios/Resources/bridge.js`). The transport is ~15 lines at the top; the rest
is `FileSystemWritableFileStream` semantics whose comments record the bug that
wrote documents out as zero bytes. Forking that file forks that bug.

Details and verification state: `tray/README.md` § Android.
## 2026-08-10 — No dark topbar for now; THEMES are the right shape for it later

**Decision.** Every Bento app keeps the shared light chrome. A dark navy topbar
was prototyped on the real slides and type builds and is NOT being adopted as a
one-off. What is wanted instead is a proper light/dark theme layer across all
apps, of which a "contrasting" navy-topbar theme would be one option.

**Why.** The prototype looked good on light content — and the accent argument is
real, `#f7a600` is a faint tint on `#f5f7fa` and a clear focal point on
`#1e2a3a`, which is the brand's own navy+orange. But it fails on its own terms
in two places: the bar's dropdown MENUS and popovers stay light, so a dark bar
with light menus hanging off it reads as unfinished; and slides' content
luminance varies (the starter deck alone runs #0D1B2E / #F2F0EA / #FF9E8A), so
on a dark deck the bar merges with the slide and destroys the separation a dark
bar exists to create. Scope was measured, not guessed: the slides topbar alone
carries 25 distinct `ed-*` control classes, and a ten-line override missed one
immediately and shipped an invisible Save button into the comparison.

**What this implies now.** App chrome must refer to TOKENS only, never literal
colours, so a theme layer is a later addition rather than a rewrite.
`type/src/styles.css` is written that way and should stay that way.

**Pointers.** Tokens are shared verbatim by `slides/src/styles.css`,
`spaces/src/styles.css` and now `type/src/styles.css`.

---

## 2026-08-10 — bento/type: the app is named, and a block stores TEXT + MARKS, not HTML

**Decision.** The word processor is `bento/type`; `doc.format` is `"bento/type"`
and, like every format id, cannot be renamed once a file exists. Its block model
is plain text plus a list of marks over character ranges
(`{ t:'b', from, to }`), NOT an HTML string and not inline nodes. HTML is what
`inline.ts toHtml()` renders; it is never what is stored.

**Why.** Four things the app already depends on need a plain-text spine, and all
four break against HTML: the redline diffs text word-by-word (against HTML a
formatting change reads as a rewritten sentence); signatures cover a canonical
form (canonicalizing HTML means ruling on attribute order, tag case, whitespace
and entity spelling — four ways two honest parties produce different bytes for
one document); the caret is a model position, forced by measurement, because
with hyphenation on the renderer inserts characters and any rendered-space
address drifts; and footnote anchors are already offsets into the same string,
so marks reuse that rule rather than adding a second concept.

The cost is mark arithmetic, in one file, pinned by `scripts/test-type-inline.ts`
(38 checks incl. a 2,000-case fuzz) — which caught two bugs no hand-written case
found: a mark silently truncated when another overlapped it, and same-kind marks
failing to re-merge after a render split them (423/2,000).

**Pointers.** `type/src/inline.ts` (the argument is in the file header),
`type/src/model.ts` (tagged `parseDoc`, following the spaces load contract:
an unreadable file must never become an empty one), `scripts/test-type-model.ts`.
Design + the measured spike behind it: `working/design/type-design.md` and
`working/type-spike/RESULTS.md` (gitignored) — Path A, continuous pagination,
Knuth–Plass viable live.

---

## 2026-08-06 — The tree is DERIVED at read time, in one function, and it cannot cycle

**Decision.** `model.ts effectiveParents(page)` is the only answer to "what is
this block nested under": `b.parent` iff that block is in the SAME page and
appears STRICTLY EARLIER. Anything else — absent, itself, later — resolves to
the root. `descendantsOf(page, id)` is built on it. Every consumer delegates.

This implements the rule settled on 2026-08-03, which until now existed as a
paragraph and four disagreeing implementations: positional in `render.ts`, a
hop-capped graph walk in `blocks.ts mdLayout`, a fixed-point sweep in
`agent.ts descendants` ("rather than trusting the order"), and an id lookup in
`editor.indent`. They agreed only because the editor keeps the array in
pre-order — which is exactly the invariant collaboration breaks.

**DERIVE, NEVER REPAIR.** Normalising the array instead would mint `ord` ops and
two replicas can ping-pong over them forever. A read-time function mutates
nothing, so two replicas that agree on the array agree on the tree without
exchanging one extra op.

**Acyclic by construction, which is the point.** A parent must be earlier, so no
document — authored, hand-edited, imported or merged — can produce a loop. That
removes a whole class of defence: no visited set, no hop cap of 32, no
fixed-point sweep. `blocks.ts` capped at 32 because the graph could cycle, and a
markdown export that silently truncated at depth 32 is a quiet wrong answer
rather than an error.

**The failure it prevents.** On a merged `parent` cycle the old sweep returned
the whole connected component INCLUDING the node itself, so `planRemoveBlocks`
deleted blocks the caller never named.

**Verified against documents the merge actually produced**, not hand-built ones:
250 merged documents, 1,695 blocks, 24.4% of them violating flat pre-order —
zero rule failures, no cycles, no self-parents, no subtree containing its own
root. `scripts/test-sync-spaces.ts` now asserts this on every merged document
forever, and the negative control (reverting to a raw graph walk) fails 13
blocks out of 405.

**`Store.tree()` gains a visited set, and surfaces what a cycle orphans.**
`buildIndex` bins pages by `parent` with no position test, so two concurrent
sidebar drags converge on A.parent=B, B.parent=A. Neither is reachable from the
root, so both pages vanished from the sidebar AND from the Markdown export while
still sitting in the file, with nothing saying so; a subtree call from inside
the cycle recursed until the stack gave out. Orphaned pages are now listed at
the root — pages you can see and re-home beat pages that quietly stopped
existing.

**Still a page-level graph sweep in `planRemovePage`**, deliberately: it
terminates, and cascading a cyclic pair is what a caller asking for descendants
gets. Named here so the next reader knows it was considered rather than missed.

## 2026-08-06 — bento/spaces will not stamp the text token history, and that is only safe if everyone is lean

**Decision.** `toJSON({ text: false })` omits `txt` from a stamped state.
bento/slides keeps stamping it — every file in the field was written that way,
and the equivalence gate compares those bytes. bento/spaces will not.

**The measurement.** The token history is one entry per character, each ~26
bytes with an id, and a deletion cannot remove one — a tombstone is how
"delete" reaches a replica that has not caught up, so the history only grows.
An emptied paragraph still carries everything ever typed into it (measured:
"hello" → 159 B; type " world" → 297 B; delete it again → **333 B**; empty the
paragraph → **363 B**).

**But the cost is EDITING, not text**, which was not obvious and changes where
it matters. Identical prose, two ways of arriving:

| | stamped state | ratio |
|---|---|---|
| pasted / imported / written by an agent | 2,978 B | ×0.2 |
| typed in ~40-character runs | 479,825 B | ×25.8 |

161× apart for byte-identical content. Text that arrives as one write never
engages the RGA at all. Slides survives this because slide text is titles and
bullets; a space IS typed prose, and the state would outweigh the document
inside the plaintext `#bento-doc` block, re-serialized on every save,
re-parsed on every open, and written to IndexedDB every 2.5s.

**Why not garbage-collect the tombstones instead** (what Yjs does by default,
and it is worth being accurate that dropping the history is NOT the industry
norm — Yjs GCs, Automerge keeps everything and pays for it with a binary
encoding). GC needs to know every replica has seen the delete. A file people
mail to each other has no closed set of peers and no moment when that becomes
true — a copy can come back out of a mailbox a year later. The causal cutoff
that makes GC safe never arrives here.

**THE PRECONDITION, and it is not a detail.** A restored state with no token
history does not fall back to whole-value sets, as first assumed: the differ
RE-SEEDS a generation from the current content, and the seed is derived from
that content plus the register stamp. Two replicas that both re-seed derive the
SAME seed and still merge per character — measured on one shared paragraph,
"Friday"→"Monday" from one side and an appended sentence from the other, both
kept, byte-identical on both sides, from a stamp 10.9× smaller.

A replica that re-seeds meeting a peer that still holds the ORIGINAL generation
is a different story. The generations duel as units and the loser's edit
disappears — measured: **the two documents do not converge.** A live session
keeps the tokens in memory, so "save, close, reopen, rejoin a room that is still
live" is exactly that case.

So a lean stamp is safe only when EVERY participant is lean. **The session layer
must treat "restored without `txt`" as needs-a-snapshot, not as resume** — rejoin
by taking a peer's snapshot through `mergeSnapshot` rather than replaying from
where the file left off. That rule does not exist yet because spaces has no
session; `scripts/test-sync-shape.ts` carries the evidence and the note so it
cannot be written without it.

---

## 2026-08-06 — A journal entry is a page with a DATE on it, and the date is never the title

**Decision.** `page.journal` holds an ISO `YYYY-MM-DD`. That field, not the
page title, is what makes a page a daily entry. The title starts as the same
ISO string and the author may rename it freely.

**Why not Logseq's model.** Logseq derives a journal from its page title,
formatted by `:journal/page-title-format`. Their own tracker carries the
consequence — "Changing journal filename format causes blank journals and data
loss" (logseq/logseq#4019) — because the moment the format changes, yesterday's
journals stop being journals. A title is display; a date is data. Three things
follow from separating them, and none are available to a title-derived design:
the FILE is locale-neutral (a space written in Tokyo shows a Lisbon reader their
own format, because the label is rendered through `Intl` at display time and
never stored, per PLATFORM §8); search, grep and the Markdown export all see
`2026-08-06`, which sorts and is unambiguous in every locale; and a build that
predates journals renders an ordinary page and round-trips the field untouched.

**Created on demand, never one page per day.** Logseq makes a journal page every
day you open the app — on a filesystem that is a cheap empty file. A space is
ONE file people mail to each other, so a page per unopened day is permanent
weight for nothing.

**Entries sort by DATE in `doc.pages`, not by creation.** Inserting each new
entry after the Journal page gives reverse-creation order, which looks sorted
until someone backfills yesterday. Found by looking at the sidebar in a browser
after the node rig was already green.

**The date arithmetic is the whole risk, and it fails on other people's
machines.** `toISOString().slice(0,10)` is UTC, so "today" is the wrong day for
hours at a time outside Greenwich; `+ 86_400_000` is not a day on the two DST
boundaries each year; `new Date('2026-08-06')` is UTC midnight by spec. A
digit-shaped non-date like `2026-13-99` must be REJECTED rather than formatted,
because every Date-based formatter silently rolls it into some other real day.
`scripts/test-spaces-journal.ts` runs in five timezones in CI, including
Australia/Lord_Howe's half-hour DST offset — a date test that runs in one
timezone has not been run.

## 2026-08-06 — One CRDT engine, two document shapes, and the shape is never on the wire

**Decision.** `kernel/src/sync/crdt.ts` takes a `DocShape` at construction: two
property names — the doc key holding the parent array, the parent key holding
the child array — plus a derived set of doc keys it must never sync.
`slides/src/sync/crdt.ts` is a facade binding `SLIDES_SHAPE` and exporting
`SyncState`; bento/spaces binds `('pages','blocks')` the same way. The engine
knows nothing else about any app's content.

**Bound at construction, never serialized, never on the wire.** A room is
single-app by construction — the room id is minted per file — so no frame has
to say which shape it came from, and a shape tag in `SyncStateJSON` would
change the bytes of every bento/slides file already on a disk.

**NO DEFAULT on the shape argument.** A default is how a spaces call site
silently ends up holding slides' shape, and a room minted that way cannot be
repaired: the files are on other people's disks.

**`skipDoc` is DERIVED, not authored.** It must contain the container key: the
container is synced structurally, per node with its own position key, so
listing it as an ordinary doc property would collapse the whole document into
ONE last-writer-wins register. Measured — a shape omitting its own container
fails six checks in `scripts/test-sync-shape.ts`.

**THE WIRE VOCABULARY IS FROZEN FOR EVERY APP.** Ops keep saying
`kind:'slide'|'element'` and carrying `sl`/`el` regardless of shape. Renaming
per app buys prettier debug output and costs a second binding on the
highest-consequence bytes in the system. Settle it before spaces collab reaches
a user; after that, spaces files carry the choice permanently.

**Parameterize, THEN move.** The engine was parameterized in place and moved to
the kernel second. Moving first would have parked `doc.slides` and
`sl.elements` inside `kernel/src/` for a PR, against kernel/README.md's own
rule that the kernel never sees an app's content shape.

**What guards it.** `scripts/test-sync-equiv.ts` proves the NEGATIVE (the
engine still mints the bytes the field was written with) against a FROZEN copy
of the engine as shipped; `scripts/test-sync-shape.ts` proves the POSITIVE (a
second shape produces an engine that works and restores as itself). Neither
suffices alone: a parameterization that quietly did nothing passes the first, a
broken one passes the second.

## 2026-08-06 — bento/spaces converges under the shared engine, and converges on documents the format calls illegal

**Measured, not argued.** `scripts/test-sync-spaces.ts`, 400 seeds × 100 steps
× 4 actors, 17,227 ops, the kernel engine bound to `('pages','blocks')`:

- **Convergence is perfect.** Every replica agrees, every seed. The engine
  serves spaces as a CRDT with no change to its algebra.
- **52.4% of merged documents violate the spaces format** (209 of 399 seeds
  whose solo document was provably legal). Worst case in one document: 5 page
  cycles, 5 dangling page parents, 3 dangling block parents, 3 pages out of
  pre-order, 1 block out of pre-order, 1 duplicated block id.

The CONTROL matters as much as the result: each seed also runs a lone replica
through the same edits, receiving nothing, and a seed whose solo document is
already illegal is EXCLUDED rather than counted. Without it every number above
could have been the generator's fault. It caught three generator bugs while
this was being written — a cross-page move that orphaned children, a page
re-parent that inserted before its new parent, a subtree walk that missed
grandchildren — and the first draft of this entry overstated the finding by 36
points.

**Why it happens, and why it is nobody's bug.** `page.blocks` is flat and in
pre-order — "a child always follows its parent, so one forward pass rebuilds
the tree" — while the engine stores order as fractional position keys and
`parent` as an ordinary LWW register. Two independent merge domains describe
one visual tree. You indent a block, I move one; both edits are legal, both
apply, every replica agrees, and no forward pass can rebuild the result.
`render.ts renderBlocks` does not crash on it — it silently renders the block
at root, un-nested.

**Three things that must be settled before a spaces file carries collab
state**, because none can be corrected once files exist on other disks:

1. **Pre-order vs `parent`.** Derive the tree at render time and tolerate any
   array order, or repair after apply. A repair that COMMITS mints `ord` ops
   and can ping-pong between replicas forever — so if it repairs, it must
   derive, not commit. The effective-parent rule (2026-08-03) is the right
   rule and is implemented in exactly one consumer (`render.ts`), while
   `blocks.ts mdLayout`, `agent.ts descendants` and `editor.indent` use graph
   semantics. One exported function, invariant asserted.
2. **Page cycles.** `Store.tree()` recurses from the root with no visited set,
   so a merged cycle makes pages vanish from the sidebar AND the markdown
   export while still being in the file. `editor.reparentPage` refuses cycles
   locally, which two concurrent drags defeat by construction.
3. **Duplicate block ids.** The engine duplicates a node on concurrent moves to
   two parents BY DESIGN (docs/collab-design.md) — in slides that is the morph
   idiom and it is correct. In spaces, block ids are unique document-wide,
   `buildIndex` keys blocks by bare id, and `#p/<page>/<block>` anchors assume
   it. Same behaviour, opposite verdict.

**Status of the rig.** It asserts convergence and the control, and REPORTS the
format violations: failing the build on them would assert an answer nobody has
chosen. `STRICT=1` turns every one into an assertion — flip it in CI the day
the three decisions land, and the rig becomes their enforcement rather than
their evidence.

## 2026-08-10 — Magic notes: the expression is stored, the answer is derived, and there is no eval

**Decision.** A line whose text ends in `=` gets an answer rendered after it.
The document stores what was written — `budget * 0.3 =` — and never the number.
`spaces/src/calc.ts` is the evaluator; `render.ts` derives per page in one
forward pass.

**Why derived and not stored.** Change `budget = 5000` to 6000 and every line
below re-answers, because nothing downstream was frozen — measured in the
browser: 750 → 1,950 and 480 → 720 from one edit, with the file still holding
only the expressions. It is the rule slides settled for dynamic fields, and it
also means the file stays plain: search, grep, the Markdown export and a build
that predates this all see `budget * 0.3 =`, which reads as prose. No new block
type, no attribute for the sanitizer to strip.

**The trailing `=` is an OPT-IN, and that is the feature.** A notes app where
every line with numbers became a calculator would be unusable — "we shipped 3
of 7" is a sentence. The parser must consume the WHOLE line or return nothing;
a partial parse is a refusal. The rig spends as many assertions on what must
NOT answer as on what must.

**NO `eval`, NO `new Function`, and it is a security boundary.** Block html
comes out of a file somebody mailed you, and sanitize.ts exists so nothing in a
document can execute. Reaching for the JS parser to evaluate `2+2` would hand
that back. A recursive-descent parser over a fixed grammar can only return a
number.

**`sum above` means the run of figures DIRECTLY above.** Summing every number
on the page was the first behaviour and it was confidently wrong: on a page
with a budget, three expenses and two other answers it reported 78,732 where
the reader means 515. A heading, a sentence, a definition or another answer
ends the run — a subtotal is where a group finishes.

**Order matters, and it is fed AFTER each block is drawn.** Feeding before
meant an answering line cleared the very run its own answer needed, and
`sum above` read 0. After means a line sees what is above it and nothing of
itself.

**Precision is a note's, not a physics paper's** — 2 decimals above 100, 4
above 1, 6 below. `584.088921 mi` is noise around `584.09`.

**Dates and times use the local calendar**, for the reasons journal.ts records:
UTC makes "today" the wrong day for hours at a time outside Greenwich, and a
day is not 86,400 seconds on the two DST boundaries. `2026-08-10` is lexed as
ONE token — as three, it parses as 2026 minus 08 minus 10 and answers 2008,
which is the worst bug this file could have.

## 2026-08-03 — Sync parameterization is gated on BYTE equivalence, not convergence

Making `slides/src/sync/` serve spaces (`doc.pages[] → page.blocks[]`) by
parameterizing it over a document-shape descriptor is the agreed approach — but
`scripts/test-sync.ts` cannot police it. It proves CONVERGENCE: replicas of the
SAME engine agree. An engine that converges beautifully with itself while
minting different ops, position keys or lamport stamps than the shipped one
sails straight through it, and then every bento/slides file in the field —
each carrying persisted `SyncStateJSON` and talking to the deployed relay —
silently splits from its own copies, unfixably.

So the gate is `scripts/test-sync-equiv.ts`: run baseline and candidate off one
seeded PRNG stream and assert the emitted BYTES are identical (op batches with
field order, `SyncStateJSON`, materialized doc), per step, per actor, plus a
scripted suite for `adopt`/`mergeSnapshot`/`fromJSON`/`missingFor`. It carries
four convergent-but-different mutant engines as a self-test, because it passes
trivially until the candidate import is repointed and a comparator that has
never failed proves nothing. **No parameterization work merges without this rig
green in LIVE mode.** Fixtures now live in `scripts/lib/sync-fixtures.ts`,
shared by both rigs, so the two never drift into different opinions of what an
edit is. Wired into CI beside the convergence rig.

## 2026-08-02 — dash budgets BYTES with consent, not rows with a refusal

**Supersedes the hard stop proposed in the dash design doc §3.2** (refuse at
1,000,000 rows or 25 MB, on the importer and every other write path). The two
guards it sat on top of are unchanged and are not optional.

**What stands, because the failure past the budget is SILENT.** Measured at a
539 MB file: the `#bento-doc` element still holds exactly one child text node,
of length **zero**. `textContent` returns `''` — a string, no throw — so the
workbook opens EMPTY, and self-save then re-splices whatever is in memory over
the user's file. Unrecoverable loss caused by a successful parse of nothing. So,
from the first commit that can save:

1. `parseDoc` returns a tagged result, never `null`. Only an **absent or empty**
   block boots the starter document.
2. **Refuse to serialize if the boot parse did not succeed** — a hard error
   surface offering "Save an untouched copy" and "Copy document JSON", with the
   editor and autosave disabled.

Those two are what prevent the data loss. The row cap was belt-and-braces on
top of them, and it costs precisely the users who know what they are doing.

**What changes:**

- **Budget in BYTES, not rows.** 1M × 12 is 65 MB; 1M × 2 is ~10 MB and
  comfortable. A row cap refuses workable files and admits unworkable ones.
  Excel's 1,048,576 is a *structural* limit users have learned; ours would be a
  proxy for a quantity we can measure directly.
- **Warn, then take informed consent — never refuse.** Past the ceiling, say
  what will actually break, in this browser, with numbers.
- **The threshold scales with `canWriteInPlace()`** (`kernel/src/save.ts:470`).
  With the File System Access API a save is an in-place write; without it —
  Safari, Firefox, every iOS browser — every ⌘S downloads the whole file to
  `~/Downloads`, so the practical ceiling is far lower. One global constant
  cannot express that.
- **Import offers an alternative, not a no**: the first N rows, an aggregate, or
  the whole thing with the warning accepted.

**The target is unchanged at 100,000 rows × ~12 columns (~6 MB)** — where the
file emails under attachment limits, downloads in a second, round-trips as JSON
per PLATFORM §7, and the 2.5 s autosave rewrites it imperceptibly. It is a
target, not a cap.

Compute is not the constraint and is not close: hand-written columnar JS over
typed arrays, zero dependencies, single-threaded, measured on **10,000,000
rows** — scan-sum 5.9 ms, filter+sum 10.6 ms, two-dimension group-by 11.5 ms.

## 2026-08-02 — `bento/dash` is settled, and it stands for DAta SHeets

**Keep `bento/dash`.** The name contracts **DA**ta **SH**eets — the two halves
of the app, the typed data model and the grid. It is not short for "dashboard";
a dashboard is something the app can produce, not what it is.

Recorded because the 2026-07-24 naming entry justifies it as "spreadsheet +
tables + dashboards", which leads with the output surface and reads as
mis-scoped. That framing is what caused the name to be re-opened and argued at
length today. Don't re-open it without a new argument.

This blocked the first commit that writes a `FORMAT` constant — PLATFORM §3
puts the string into every saved file and there is no server to migrate
anything — and it is now unblocked.

**Weighed and set aside** (collisions verified live, not recalled):

- `cells` — best suite fit, but it sounds like Ex**cel**. A replacement that
  echoes the incumbent's name reads as derivative of it.
- `views` — genuinely dual (a SQL view *and* a visual view), but it names
  *looking* when the app's own boundary rule is *reckoning* ("does it
  recalculate → dash").
- `measures` — the BI term of art, and the convergent pick of two independent
  root analyses, but "bento measures" parses as a verb clause.
- `base` — its retirement reason above has **inverted**: it was dropped partly
  for reading as "database, which this platform does not have", and dash now
  is one. Set aside as flat rather than wrong; reconsider only if `dash` ever
  proves to mis-signal in the field.
- `figures` parses as a verb clause; `grid` collides with "bento grid", an
  established UI design-trend phrase; `rows` is rows.com, a live "AI Data
  Analyst" product; `calc` is LibreOffice Calc, and is clipped besides.

**Namespace was deliberately down-weighted.** PyPI `dash` is Plotly's dataviz
framework and npm `dash` is the cryptocurrency, but the app never ships as a
bare word — it is `bento/dash`, at `bento.page/dash`, in
`Bento_Dash.bento.html`. That is the mitigation the 2026-07-24 entry already
prescribes for the crowded Bento namespace: always carry the `bento/<app>`
form and the descriptor.

## 2026-07-28 — Vault is a capability broker; identity is multi-user from commit one

**Refines the 2026-07-27 vault entry rather than superseding it.** Three
capabilities arrived separately — AI, live data, key distribution — and are one
shape: **vault brokers what a travelling file structurally cannot hold** (a
secret, a private network, an authority). That definition is the test for what
belongs in vault and what does not.

Settled:

- **Vault configuration lives in the SHELL, never the document** — a second
  plaintext `#bento-vault` block under the same splice contract. In the document
  it would travel with the content and leak an internal hostname to anyone
  emailed a deck. "Export for outside" strips it, visibly.
- **A minted shell points its update channel at the vault.** Not a choice:
  `serializeWith(shell, doc)` (`kernel/src/save.ts:322`) re-splices into a
  freshly fetched shell and discards everything else, so shell config survives an
  update only if the update comes from the vault. Needs a visible "return to
  upstream" escape so a defunct vault cannot freeze former employees' files.
- **Dual signatures.** Canonical runtime = the file minus `#bento-doc` and
  `#bento-vault`; its sha256 must match upstream's signed manifest, and the vault
  signs its config BOUND to that hash. A compromised vault can then redirect
  endpoints but cannot ship modified editor code. Build in v1 — unaddable later.
- **Documents carry a query NAME, never query text.** The vault maps names to
  parameterised statements defined by an admin. Otherwise every deck anyone opens
  is an exfiltration tool against the database.
- **A bound document always carries its last known values.** A vault connection
  refreshes data, never supplies it, or "works with no network" falls by another
  route.
- **A vault refresh is a COMMIT, not a derivation.** Linked charts derive
  identically on every replica today; a fetch does not (two replicas fetching at
  different moments get different rows). Extend `scripts/test-sync.ts` first.
- **Archival is reinstated; backup stays cut.** Different products. Copying bytes
  is solved; being able to OPEN them in ten years is not, and a Bento archive
  renders itself and stays machine-readable as plaintext JSON with no vendor in
  the loop. Vault produces the archive shape; restic moves it.

**Who it serves, re-argued and resolved.** Three of the capabilities (live data,
retention archive, private release channel) are properties of a DEPLOYMENT rather
than a person, so the org case got stronger; the case against did not weaken,
because it rests on maintenance surface — every org-shaped pillar implies
multi-user identity, and that is what a single maintainer carries indefinitely.
Resolution: this decides what we PROMISE, not what we build — broker, index and
archive serve one user and fifty identically. Ship single-user and promise
nothing organisational, **but design the identity model multi-user from the first
commit**: per-user query authorisation and spend attribution cannot be retrofitted
without migrating every deployed vault. The gate for building organisational
features is a real stated requirement, not a count of pillars.

## 2026-07-27 — Thumbnails: plain markup plus a parser-blocking remover, NOT `<noscript>`

**Supersedes the 2026-07-26 entry below** on the one point of where the preview
lives. Everything else in it still stands: written at save time, replaced never
appended, `PREVIEW_BUDGET` tiers, and above all **encrypted decks get no
preview**.

`<noscript>` renders only where scripting is DISABLED, and iOS satisfies
neither half of that. Probed with a page that is red by default, turns green
from an inline script, and carries a blue `<noscript>`, the iOS thumbnailer
renders **RED** — it runs no script AND does not render `<noscript>`. So the
feature worked in Finder and macOS QuickLook and did nothing on the platform it
was built for; every deck in Bento Tray stayed a dark box.

That same gap is the fix. A renderer that runs no script still renders ordinary
markup, and every real reader does run script — so the preview ships as a plain
`[data-bento-preview]` element with a **parser-blocking inline remover**
immediately after it. The thumbnailer keeps the preview (it never runs the
remover); the reader never sees it (the script executes before the browser
paints). Measured: at removal `document.readyState` is `"loading"` and
`performance.getEntriesByType('paint')` is EMPTY — zero frames containing the
preview were ever presented. Not a fast flash; no flash.

The 2026-07-26 entry chose `<noscript>` to avoid exactly that flash, and
accepted "a thumbnailer that does run scripts sees no preview" as the trade.
Both halves turned out to be wrong about iOS, and the replacement costs neither.

**A QLThumbnailProvider extension does not work and should not be retried.** It
registers correctly (`pluginkit` shows `SDK = com.apple.quicklook.thumbnail`)
but its process never launches: iOS uses its own generator for `public.html`
and does not consult third-party extensions for types it already handles.
Likewise `NSURLThumbnailDictionaryKey` via `UIDocument.fileAttributesToWrite`,
which is accepted and then silently dropped for local files — inspecting the
xattrs afterwards finds only `com.apple.lastuseddate`.

`previewIsSafe` is now MORE load-bearing, not less: the preview lands in the
live DOM rather than sitting inert inside `<noscript>`, so the refusal that
keeps a script tag out of it protects the page and not just the file structure.
`shell-gate.mjs` gained two source assertions — that the remover is emitted at
all, and that it sits immediately after the preview, since anything between
them is markup a browser could paint first.

---

## 2026-07-27 — bento/vault is the ORG service point, and the AI broker is what forces it

**Supersedes the 2026-07-25 "personal server" entry.** Vault is not a personal
document library. It is the **service point for a group of people and their
documents**, self-hosted on hardware that group owns.

The reframe came from subtraction. Of the five promises in the old entry, four
were met or taken while it sat unbuilt: mobile reach went to `bento/tray` plus
any existing File Provider (iCloud Drive, Dropbox), sharing went to the collab
relay (the file IS the capability), per-device version history went to
`kernel/src/autosave.ts`, and plain file sync was never ours. What survived
personally was **search alone**, and it has since been narrowed by measurement:
Spotlight indexes rendered HTML text, so the `#bento-doc` script block is
invisible to it — but the save-time preview is ORDINARY MARKUP now (the
thumbnails entry above), and markup indexes. Measured 2026-07-28 with
`mdimport -d2 -t` on a deck saved from the current shell: the whole title slide
comes back in `kMDItemTextContent`, and a token planted on slide two does not.
**Page one is already searchable for free; the unmet need is FULL TEXT.** One
real problem — now a smaller one — does not need a personal server.

**The AI broker is the pillar that makes vault necessary rather than nice.** A
self-contained document travels, so it can never carry a model credential — that
is emailing your API key to everyone you share the deck with. `localStorage` is
per-device, and under tray it is per-DOCUMENT (the origin is
`bento-tray://<sha256 of path>`, `EditorViewController.swift`), so it degenerates
into configuring a key per deck. The only place a credential can live once and
serve a whole library is a server the group runs. **In-app AI is architecturally
impossible without something vault-shaped**, and the same index serves both
search and retrieval. Points a local model (Ollama on the same box) at the
library without anything leaving the network, which is the existing README claim
made real.

**SSO gates distribution, never the file.** Once someone holds the bytes they
open them forever, offline, with no server — that is the product, not a bug. SSO
can gate access to the vault and the distribution of decryption keys (the
`bento/enc` envelope and the owner→invite→member chain already exist for this).
Revocation is therefore FORWARD-ONLY: a revoked member keeps what they already
downloaded, exactly as `collab-design.md` already documents for devices. Say this
before an enterprise security review discovers it.

**The org profile deletes most of the hard design.** NAT traversal,
hole-punching, WebRTC, the dead-drop and the portable relay twin all exist to
serve one case: a personal laptop asleep behind a home NAT. A company vault is a
box on a network with a hostname and a certificate, reached directly. So
`relay-design.md` steps 2–5 are NOT v1, and neither are the equivalent vault
steps.

Corollary worth stating plainly: the org vault **is** a custody service, and that
is correct — central custody is the point of centralising. The personal vault
explicitly was not. Those were two products wearing one name; we are building the
org one.

**New invariant — AI is additive, never load-bearing.** Every app stays fully
functional with no vault and no model, the same rule as "vault is optional". If
an AI feature ever becomes required to edit, `PLATFORM.md` §1 is gone.

**Sequencing: the org deployment is the DESTINATION, not the first build.**
Architecturally this costs nothing — a single-user vault IS the org vault with
one user: same index, same key chain, same broker. Build that, design toward
multi-user, promise neither.

**Licence:** the runtime stays MIT (`THIRD_PARTY_NOTICES.md` is embedded in every
saved file, so copyleft on the shell would attach to every document a user
emails). Vault is a separate repo with its licence chosen at commit #1. Never
relicense slides.

## 2026-07-26 — File-manager thumbnails: a `<noscript>` render of page one, written at save time

**Decided:** 2026-07-26. Kernel zone (`kernel/src/save.ts`), so it binds every
Bento app; the drawing is per-app (`slides/src/preview.ts`).

**The problem.** Thumbnailers render a document's HTML but do not run its
JavaScript, so every Bento file thumbnailed as the same dark box — correctly,
because before the runtime boots every deck *is* the same bytes plus the boot
splash. Confirmed on iOS, and confirmed that the iOS-side escape hatch does not
exist: an image attached via `UIDocument.fileAttributesToWrite` under
`NSURLThumbnailDictionaryKey` is accepted and then silently dropped for local
files (only `com.apple.lastuseddate` survives on disk). **The fix has to live
in the file.** So `serializeBody` now writes a static rendering of page one
into the shell on every save, and it fixes every platform at once with no
native extension anywhere.

**`<noscript>`, not "render it and let JS remove it".** The obvious design —
always paint the preview, have the runtime delete it at boot — flashes page one
in front of every reader on every open, for as long as the 600 KB payload takes
to inflate. `<noscript>` has exactly the semantics wanted: its contents are
rendered only when scripting is off, which is precisely the audience.
Empirically the DOM proves it, not just the spec — with scripting on the host
node has **zero element children** (its content is one raw text node) and a
bounding box of 0×0, so there is nothing to flash, nothing in layout, nothing
for print or present to exclude. The cost is that a thumbnailer which *does*
run scripts sees no preview — i.e. today's behaviour. A regression is not
possible, only an improvement.

**Scaling: `transform: scale(calc(min(100vw, <aspect>vh) / <width>px))`.**
CSS Values 4 length-over-length division yields the plain `<number>` `scale()`
needs, so the whole page scales as one unit and every inline px the renderer
emitted is left alone. **`<svg viewBox><foreignObject>` was tried first and does
not work**: Chrome renders it correctly, QuickLook's WebKit does not
(absolutely-positioned children disappeared, content scaled non-uniformly), and
QuickLook is the renderer this feature exists to serve. Verify changes here
against `qlmanage -t -s 640 -o <dir> <file>` — the real macOS thumbnailer, and
the only honest test. Chrome's `--blink-settings=scriptEnabled=false` suppresses
`--screenshot` entirely in Chrome 150; drive `Emulation.setScriptExecutionDisabled`
over CDP instead.

**Encrypted decks get NO preview — the load-bearing rule.** A plaintext
rendering of page one beside a `bento/enc` envelope hands over the title slide,
usually the most disclosive page, and does it invisibly. `previewAllowed()`
checks the in-memory password flag AND re-parses the body as an envelope,
because those fail independently. Removal of any existing preview is
UNCONDITIONAL and happens before that decision, so a deck that gains a password
loses its preview on the next save.

**Shell furniture, not format.** Nothing enters `#bento-doc`; no format field
is added; old files open unchanged; an app that registers no provider (spaces)
saves as before. The preview is replaced, never appended — `capturePristine()`
snapshots the file as loaded, so the clone already carries the previous save's
copy.

**Budget: 64 KB** (`PREVIEW_BUDGET`, slides/src/model.ts), ~10% of the shipped
shell. Measured: starter deck 25 KB (2.6% of the file); a page-one chart 11 KB;
a table 16 KB; a page with a 2.5 MB photograph degrades to 1.7 KB. Over budget,
page one re-renders with raster payloads replaced by tinted boxes; over it
again, a title card. Downscaling a hero photo instead would be
better and was NOT done: image decode is async and `serializeWith`/
`serializeFile` are synchronous (update.ts, `window.bento.serialize()`), so an
async provider is a kernel API change of its own.

Guards: `scripts/test-preview.ts` (encryption veto + the refusal to emit markup
carrying a script tag or `</noscript>`), and `scripts/shell-gate.mjs`, which
now also proves a preview-carrying file satisfies the splice contract and
asserts both rules are still wired into the save path.

## 2026-07-26 — A language pack lives in the FILE and nowhere else

No browser-local install. A "keep it on this computer" option (localStorage)
was **built and then removed**, because `localStorage` is scoped per ORIGIN
and that is fatally misaligned with how Bento is used: the download comes from
`bento.page` (an https origin) and the file is then opened from disk (a
`file://` origin). A language added on the website was therefore GONE the
moment the user saved the deck and reopened it locally — the exact journey the
product encourages, and "I added Korean and it vanished" is not a bug a user
can diagnose.

One home also matches the platform: the file *is* the software, so a language
belongs to the deck. The trade — adding a language requires saving the file —
is stated plainly in the UI ("Added when you next save") rather than hidden.
Adding is staged on click and written on the next save because on browsers
without File System Access, writing on click means silently downloading a
second copy of the user's deck.

Corollary: anything that remembers pack *content* outside the file
reintroduces this. Viewer *preferences* (locale, reduce-motion) stay
browser-local on purpose; that asymmetry is deliberate. Details:
`docs/i18n-packs.md`, `slides/src/packs.ts`.

## 2026-07-26 — The pack carrier is generic; pack POLICY is not. This is not a plugin system.

The kernel mechanism is already extension-agnostic and should stay that way:
`registerShellBlocks` / `readShellBlocks` (`kernel/src/save.ts`) carry
arbitrary typed blocks in the shell and know nothing about languages, and
`registerUpdatePrepare` (`kernel/src/update.ts`) is a generic "refresh
version-bound extras" hook. Signature verification and hash pinning are being
made generic in the kernel too (branch `claude/i18n-pack-verify`). Reuse all
of that freely.

**Do not generalize the policy.** Language packs are DATA and their worst case
is bounded — a tampered or stale pack shows wrong or English words. That bound
is why degrade-per-string, keep-on-refresh-failure, and auto-refresh on update
are the right rules *for packs*.

Anything carrying CODE is categorically different: unbounded failure (it would
hold the document, the file handle, and the collab keys), and it breaks the
property that makes self-update trustworthy — that the shell only ever runs
bytes from a signed release. Such a thing would need its own policy (pinned at
install, never auto-refreshed) and must not inherit the pack rules by reusing
the pack machinery.

So: reuse the carrier and the crypto; do not treat "we have packs" as evidence
that a plugin system is designed or wanted. It is not.

## 2026-07-26 — Side-loaded artifacts: sign the index, pin the bytes, fail closed

Language packs are fetched over the network, so they get the **same two-step
the app shell's own update already gets**: an envelope signed with the release
key (`{payload, sig}`, ECDSA P-256 / SHA-256) whose payload pins each
artifact's `sha256`, and a download that is accepted only if its bytes hash to
that pin. Signature over the pin, pin over the bytes. **No second key and no
second trust root** — `PUBLIC_KEY_JWK` in `kernel/src/update.ts` is it.

The mechanism lives in the kernel (`verifySigned`, `fetchPinned`) because it is
the same for anything side-loaded; the *policy* stays in the app
(`slides/src/packs.ts`). Keep that boundary: the kernel helpers verify BYTES,
they do not decide what is safe to use. Packs are DATA with a bounded failure
mode (wrong words on screen), which is why a pack that fails a refresh is kept
at its existing version rather than dropped. Anything side-loaded that ever
carries CODE needs stricter policy — pinned at install, never auto-refreshed —
and must not inherit the pack rules by reusing the same fetch.

**Fail closed, no legacy path.** An unsigned or unpinned index yields no
listings at all. Nothing is published yet, so there is no permissive fallback
to keep — and one added later would mean whoever answers for the channel picks
the strings in the UI.

**A pack already inside a file is NOT re-verified** (`readPacksFromShell`). It
was verified at the door, and once spliced it carries exactly the trust the
document does — anyone who can rewrite that block can rewrite the checking
code too. Re-verifying would need the network at boot, which breaks offline
use. Proof rig: `node scripts/test-packs.ts` (throwaway key, real crypto).

## 2026-07-26 — Language packs are published under a SIGNED INDEX, separate from the manifest

Amends the "Signing and release" paragraph of `docs/i18n-packs.md`, which said
the update manifest would gain a `packs` array. It does not.

`release.mjs` emits the packs and signs **one index** over all of them at
`releases/slides/packs.json` — the same `{payload, sig}` envelope, the same
offline key, and literally the same signing code as the manifest (extracted to
`scripts/sign-payload.mjs`). Each listing pins its pack's `sha256`; individual
packs are not separately signed. Clients verify the index once, then hash each
download against its signed hash.

Why not inside the manifest: shipped files ignore a manifest that is not
strictly newer than themselves (downgrade-replay protection), so pack hashes
carried there could never be corrected **between** app releases — and a fixed
translation is not a new app version. A separate index is re-issuable any day,
and `manifest.json` keeps meaning exactly one thing: here is the app shell.
Signed code and signed data stay two artifacts.

Still one key, still local-only signing, and `publish-site.mjs` now gates the
index the way it already gates the shell (indexed pack missing, hash drifted,
or packs staged with no index = refuse to publish). Details and the exact
payload shape: `docs/i18n-packs.md` §"Signing and release"; `scripts/sign-packs.mjs`.

## 2026-07-25 — i18n: a bundled core of 9 languages, everything else a signed pack

The 7 non-English catalogs cost **115,572 B** of the shell even after key-once
packing — more than any dependency, and an English-only shell is 28.8%
smaller. But we want *more* languages, not fewer. So: **bundle a core, ship
everything else as signed downloadable packs.**

- **Bundled (9):** the existing 8 (en, ja, zh-Hans, zh-Hant, es, fr, de, it)
  plus **Portuguese**. Nothing regresses for current users; Portuguese is
  added because Brazil has a real English-proficiency gap and it is in the
  cheapest cost tier.
- **Everything else:** a pack, signed with the existing release key and
  released centrally alongside each app release, fetched only on explicit user
  action and spliced into the file.

**No further languages get bundled by default** — demand declares itself
through contributions (#17 offers Korean), and a pack can be revised without
cutting an app release.

Measured facts worth not re-deriving: cost is **~14 KB per language regardless
of script** (CJK is the *cheapest* — 2.6× the bytes per character but a third
of the characters). Simplified↔Traditional conversion on the fly does **not**
pay: only 43.3% of characters match, because the difference is vocabulary
(软件/軟體) not glyph form, and deflate already recovers the genuine redundancy.
Rank candidate languages by the **English-proficiency gap in the segment that
uses this tool**, not by speaker counts — which is why Hindi is not in the core
despite 610M speakers.

Full design, risks and status: **`docs/i18n-packs.md`**. The risk that will
ship broken if ignored: **self-update must carry packs forward** — `update.ts`
re-splices the document into a *new shell*, and packs live in the shell.

## 2026-07-25 — Every PR gets human review before merging to main (for now)

At this stage of development the maintainer reviews **every** PR before it
lands on `main`, including agent-authored ones. No auto-merge. The point is
visibility into what the agents are actually producing while the multi-agent
workflow is still being shaken out — the cost is throughput, and that is
currently the right trade.

Supporting config, already in place: `main` is branch-protected with one
required approval, and CI (`validate`) is a **required status check**, so a red
build cannot merge. Admin bypass stays enabled for the maintainer.

### FUTURE ACTION — revisit when review becomes the bottleneck

When PR volume outgrows one reviewer, consider auto-merging **app-zone** PRs on
green CI. If that happens, these paths must **always** require human review
regardless, because a bad merge is either silent or catastrophic:

- **`kernel/src/`** — every app depends on it.
- **`slides/src/sync/`, above all `crdt.ts`** — convergence bugs are silent and
  corrupt documents. The rig is necessary but not sufficient: it only generates
  short strings, which is why it missed the large-text stack overflow (#47).
- **`server/`** — one bad deploy breaks live collaboration for everyone at
  once, and there is no per-user rollback.
- **`scripts/release.mjs` / `sign-release.mjs` / `keygen.mjs`** — the signing
  and release path.
- **Anything touching the `#bento-doc` splice contract or the update-manifest
  shape** (`PLATFORM.md` §2, §6) — these brick files already on users' disks.

Do not enable auto-merge without that exclusion list encoded somewhere
enforceable, not just written down here.

## 2026-07-24 — Naming: the platform is `bento`, the mark is `bento/.`, all lowercase
Settled after working through the whole namespace. **Do not reopen these** —
each rejected candidate was rejected for a specific reason, recorded below.

- **Platform: `bento`** (lowercase). Not "Bento Box", not "Bento Suite" — the
  bare word is the family, and `bento/<app>` reads as members of it.
- **Wordmark: `bento/.`** — the trailing dot stands for the platform (the apps
  complete the slash). This is a MARK, not a name: `/` is a path separator and
  is illegal in filenames, URLs, package names and social handles, and
  punctuation is disregarded for trademark purposes. Anywhere a name must be
  stored or typed, it is `bento`.
- **Casing: lowercase everywhere**, brand and machine alike. This deliberately
  collapses the usual split (`Docker` the brand / `docker` the command)
  because the lowercase form is already the file's own identity — `doc.type`
  is `bento/slides`, the MIME type is `application/bento+json`.
- **Apps:** `bento/slides` (shipped), `bento/spaces` (Notion/notes-like),
  `bento/dash` (spreadsheet + tables + dashboards — absorbs what would have
  been a separate database app), `bento/vault` (document library / personal
  storage). A word-processor app is planned; **`bento/folio` is the proposed
  name, NOT yet confirmed** (alternatives considered: draft, prose, write —
  `pages` and `docs` are unusable, being Apple's and Google's).

**Rejected, with reasons:** `box` — the natural collective noun, and Box, Inc.
is a cloud-storage company; keep it as an informal collective at most.
`base` — retired once dash absorbed tables; also reads as "database", which
this platform does not have. `bits` — generic, tonally wrong for an editorial
brand, and pushes search toward snack food. `page`/`pages` — reserved: it is
the best name for a future web-publishing app, and Apple Pages owns the
word-processor association. `shelf`/`library` — weaker than vault, and library
reads as "code library" to this audience.

**Note on the crowded namespace:** several unrelated SaaS products are called
Bento (email automation, link-in-bio, analytics, a dead FileMaker database).
The field is crowded, which weakens everyone's claim — including ours. The
practical cost is discoverability, not legal exposure. Mitigation is the
`bento/<app>` form, the `bento.page` domain, and always carrying the
descriptor. Get real clearance before commercialising; a bare wordmark would
be hard to register, a composite (mark + logo) much less so.

## 2026-07-25 — bento/vault is a personal server; the relay is a separate product
**Supersedes the "map, not the keys" entry below.** Vault is not an index and
not a sync service — it is "cloud services without a cloud": your documents
live on hardware you own (desktop / NAS / homelab) and it provides
reachability, search, cross-document references and version history without
any of it running on someone else's computer. The closer reference is
Tailscale, not Dropbox.

Vault and the **relay** are separate products with separate release trains.
The relay is dumb infrastructure — rendezvous, an optional encrypted
dead-drop, presence, nothing else — hosted on Cloudflare for the masses and
self-hosted by serious users. Every actual service runs on the personal
server; if the hosted relay ever accretes features, self-hosting becomes
second-class and we lose the audience this is for.

Consequences: the relay needs a portable
(Docker) implementation because the current Worker+DO+hibernation stack is not
realistically self-hostable; independent release trains require a versioned
capability handshake (we can no longer control deploy order); background
execution is unreliable on every platform so the protocol must be correct
after unbounded offline periods; mobile uses iOS File Provider /
Android DocumentsProvider rather than a background daemon; and the agent syncs
a FOLDER, so no Bento app needs any changes. Retained from the superseded
entry: the relay only ever sees ciphertext, and **export-to-standalone-file
always works** — that invariant is what keeps "your data is a file you own"
true while vault holds it.

## 2026-07-24 — [SUPERSEDED] bento/vault holds the map, not the keys
The document library must not become a custody service. It stores an encrypted
index of what documents exist and how they reference each other; each document
keeps its own encryption password and collab credentials. Compromising the
vault reveals *what you have*, not what is in it, and losing the vault loses an
index, not your work. This preserves the property that makes the relay
defensible — files stay authoritative, server loss is survivable — and keeps
the name an honest promise. Any sync tier is E2EE and optional (DO for
coordination + R2 for encrypted blobs; never D1/plaintext), and self-hostable.

## 2026-07-24 — Suite expansion: bento/spaces and bento/dash
Two new apps begin: **bento/spaces** (Notion/notes-like) and **bento/dash**
(spreadsheet + tables). Development fans out across parallel
agents and multiple tools (Claude Code, Codex, Antigravity) — coordination
rules in `docs/PARALLEL-WORK.md`, platform contract in `docs/PLATFORM.md`.
Planned pre-fan-out groundwork: extract the shared kernel (monorepo layout,
apps beside `slides/`), add per-PR CI validation gates (typecheck +
build:single + splice conformance + test-sync). Releases stay local/signed
regardless of CI.

## 2026-07-24 — Hold marketing-surface i18n
Don't localize the bento.page landing page or README yet: the landing page
will be rebuilt around the multi-app suite, so translations now would only
drift. App UI i18n (7 locales) is the localization that matters and already
ships. Revisit once the new landing page is stable.

## 2026-07-24 — No bot/AI-agent identities in git history
External PRs get provenance review before merge (`gh api users/<login>`);
scatter-bot/AI-agent contributions are declined. A bot's merged PR was
scrubbed from history via filter-repo + force-push, and `main` is now
branch-protected (1 required review, no force-pushes). Human contributors'
authorship is preserved normally.

## 2026-07-22 — v1.0.7 launch (Show HN) and post-launch fixes
Launched publicly (#1 on HN, ~1000 pts). Post-launch priorities were driven
by thread feedback: collab focus-steal fix, chart zero-baseline for negative
values, mobile-Safari pinch, reduce-motion mode — all shipped in v1.0.8
alongside panel UI for community format features (text gradient, text-stroke,
blur/blend, backdrop-filter). Community format features are accepted when
additive + composable (unknown fields preserved; effects compose).

## v1.0.7 — Morph identity decoupled from element id
Elements carry optional `morphId` overriding the morph pairing;
`data-flip-id = morphId || id`. `id` stays the stable identity (selection,
anchors, CRDT). Chosen over mutating ids, which would have broken comment
anchors and collab node identity. Details: CLAUDE.md (render.ts section).

## v0.9.x — Charts are in-house (ECharts removed)
ECharts was 630KB (~47% of the shell); replaced with charts-lite interpreting
the same option SHAPE (pure JSON, no functions). Exotic configs degrade
gracefully rather than crash. Don't re-add a chart dependency; extend
charts-lite instead. Details: CLAUDE.md (charts section).

## v0.9.x — Collab credentials mint-at-creation, dormant until shared
Decks are born collab-capable but never auto-connect unless the doc arrived
carrying collab or the user opted in — fresh templates/demos must never phone
home. Read-only and writer roles are enforced cryptographically at the blind
relay, not honour-system. Spec: docs/collab-design.md.

## v0.x — Releases are cut locally, never in CI
The signing key never leaves the maintainer's machine; the signed bytes are
the served bytes. CI may validate (typecheck/build/gates) but never signs,
publishes, or deploys. Runbook: docs/RELEASING.md.

## v0.x — Single-file architecture is the product
One HTML file = document + viewer + editor, working offline from file://.
The splice contract on `#bento-doc` is frozen forever (shipped updaters
depend on it). Everything else is negotiable; this isn't. See
docs/PLATFORM.md §1–2.

## 2026-07-25 — Large assets travel out-of-band; the relay stays blind

Assets over 64KB (`BLOB_INLINE_MAX`) no longer ride inside CRDT ops. They are
encrypted client-side, uploaded once to the relay's R2 bucket, and referenced
from the document by a content-addressed key; peers fetch and decrypt on
receipt. This was forced by measurement, not preference: Durable Object storage
values cap at ~2MB, so the previous inline path produced frames the relay
accepted-then-dropped, and the client re-sent forever. Details and threat model
in `docs/blob-offload.md`.

Three properties are load-bearing and must not be traded away:

- **The relay cannot read a blob.** It pipes ciphertext without buffering. The
  key is `HMAC(roomKey, sha256(plaintext))`, so identical bytes dedupe *within*
  a room and are unlinkable *across* rooms — a plain content hash would have
  let the relay confirm two rooms hold the same file.
- **R2 is optional.** Absent binding = `/b/` answers 501, clients inline small
  assets and same-origin tabs still resolve from the local cache. A
  self-hoster without a bucket degrades; they are not broken. This follows
  from the relay being dumb infrastructure (see the vault entry).
- **Failures are visible, never silent-but-wrong.** An unresolved blob leaves
  the asset absent and renders empty rather than blank-looking-fine. The whole
  change set exists because the old failure mode was invisible.

Operational consequence: the relay must be deployed **before** a client that
depends on the blob endpoints — the standing rule for this split, same as the
keepalive and access-verification changes.

## 2026-07-25 — Solo review model: PR + green CI, zero required approvals

**Amends the entry below** ("Every PR gets human review before merging"). The
intent stands — every change lands via PR and the maintainer reads it — but the
*mechanism* was wrong and was quietly defeating the CI gate.

`main` required 1 approving review. GitHub forbids approving your own PR, so on
a one-person project that requirement is unsatisfiable and **every** merge had
to use `--admin`. Admin bypass skips *all* branch protection, including the
required `validate` status check. Net effect: the CI gate was decorative, and a
red build could land on `main` with nothing to stop it.

Now: `required_approving_review_count: 0`, PRs still required, `validate` still
a required status check, force-pushes and deletions still blocked. A normal
`gh pr merge` works and genuinely cannot merge a red build. Admin bypass stays
*available* (`enforce_admins: false`) but is now an exception rather than the
daily path — if you find yourself reaching for `--admin`, that is a signal
something is actually failing.

Human review is a practice, not a GitHub setting, for as long as the team is
one person. Restore a real approval count the moment a second reviewer exists;
the future-action exclusion list in the amended entry still applies.

## RTL is two separable problems; only one of them is the document's

**Decided:** 2026-07-26. Supersedes nothing; establishes the split.

Content bidi and chrome mirroring get confused constantly, and treating them
as one feature produces the wrong answer to both.

*Content* direction is a correctness bug and belongs to the document: an
Arabic sentence puts its full stop in the wrong place without `dir="auto"`,
and it is wrong for everyone who opens the file. Cheap, uncontroversial, do it.

*Chrome* mirroring is a UI convention. Nothing is incorrect without it; the
editor merely feels foreign to an RTL reader. It was deliberately sequenced
AFTER an RTL language pack existed, because mirroring a UI whose every label
is still English is worse than not mirroring — and because the point of
shipping a pack first is to learn whether RTL users actually turn up.

The invariant that falls out of the split — **the document never mirrors** —
is recorded in `PLATFORM.md` §8 and binds every Bento app. A document that
looks different depending on the viewer's locale is a format-level bug.

Cost, measured rather than guessed: ~430 bytes in the shipped shell for the
whole chrome conversion, and **zero** for the languages themselves, because
every RTL language is a pack. Size was never the constraint here. The real
constraint is that 32 of the editor's ~36 direction-adjacent coordinate sites
live in `canvas.ts` (Moveable/Selecto), which cannot be verified by an agent —
synthetic drags on Moveable handles do not register at all. Pinning the
document surfaces LTR was sufficient to leave that math untouched, and that is
the outcome to preserve: if a future change makes chrome direction reach
`canvas.ts`, stop and reconsider rather than refactoring the coordinate code.

**No plural system.** Hebrew (and later Arabic) ship without one. Of 15
count-bearing strings only 6 take a real count; the rest are index labels
(`Axis {n}`, `slide {n}`) or abbreviated times. Six strings do not justify
changing the catalog format, the build script, the CI gate and every catalog.
Translators phrase them count-agnostically instead (`מחוברים: {n}`), which is
standard practice when a framework lacks plurals and costs nothing at runtime.
Revisit only if a language arrives where the workaround genuinely fails.

## One English word, two meanings = two keys

**Decided:** 2026-07-26. Consequence of English-string-as-key; binds every
Bento app that uses `kernel/src/i18n.ts`.

Gettext-style catalogs key on the English source string, which quietly assumes
that one English word means one thing. It often doesn't. `Loop` was the
animation loop AND the media playback toggle; `solid` was a fill style AND a
line style. Every language had to pick one word and be wrong in the other
place — Swedish wants *enfärgad* for a solid colour and *heldragen* for a
solid line, and no amount of translator care fixes that from inside the
catalog. Both were found independently by pack authors, which is the signal:
if a translator has to ask "which one is this?", the key is broken, not them.

**The rule.** When one English string reaches `t()` from two call sites that
mean different things, the more specific site takes a QUALIFIED key
(`Loop animation`, `solid colour`) and the plainer one keeps the bare word.
Do not add a context-prefix convention — the key is also what English users
read, so it has to be a sentence, not `fill.solid`.

**Model words never move.** Values like `solid`/`gradient` are format words
stored in the document. Disambiguate the LABEL only: `labeledSelect()` takes
`[value, label]` pairs precisely so the displayed string and the stored string
can diverge. A "fix" that changes what is written to `doc` is a format change
wearing an i18n costume.

**The cost, so it is paid deliberately.** Re-keying invalidates that entry in
every bundled catalog AND in every pack, silently — the string simply falls
back to English. So it happens BEFORE packs are published, in one PR, with
the affected keys listed for pack authors to pick up. After packs ship,
re-keying is a coordinated break across every language and should be weighed
against living with a slightly wrong word.

**Interpolated values are strings too.** `t('This {kind} is…', { kind })` with
a model word for `kind` puts an English noun inside a translated sentence.
Localise at the call site (`{ kind: t(kind) }`) — and check the sentence still
agrees grammatically, since a substituted noun carries gender in half the
languages we ship (French needed "Ce fichier {kind}" once `vidéo` could land
in it).

## 2026-07-26 — bento/tray: the iOS host is a suite member, and it is generic

The native iOS app is named **bento/tray** — "Bento Tray" on the App Store,
bundle id `page.bento.tray`, source in `tray/` beside `slides/` and `spaces/`.

**It runs ANY self-contained HTML document, not only Bento's.** That is not
scope creep bolted on; the Swift never parses the document and never did — it
is a courier that serves bytes into a WKWebView and polyfills the one File
System Access call the page needs to save itself. Bento decks are simply the
first documents it carries. Any single-file HTML app that saves itself works
identically, which on iOS is otherwise impossible: every browser there is
WebKit and none ship that API.

Naming notes, so this is not relitigated:

- **`bento/host` was rejected.** It names the mechanism, not the thing, and the
  suite convention is `bento/<what you get>`. "tray" keeps the food metaphor and
  says what it does — a tray carries any bento, whoever made it.
- **Plain "Bento" is unavailable** on the App Store: an unrelated Food & Drink
  app holds the exact name, and App Store names are globally unique. "Bento
  Tray" and "BentoTray" were both free at time of checking. That check reads
  published listings only — reservations in App Store Connect are invisible to
  it, so confirm there before submitting.
- The App Store name carries no slash. Per the 2026-07-24 naming entry, `/` is
  a mark, never a stored name.
- **But the ON-DEVICE name does carry it: `CFBundleDisplayName` is `bento/tray`**
  (2026-08-18). These are different fields and only one of them is a stored name.
  The App Store listing name lives in App Store Connect and stays "Bento Tray";
  the bundle display name is a LABEL — it drives the home-screen caption, the
  document browser's title ("bento/tray Recents") and the app's folder in Browse,
  and iOS never turns it into a path, because the container on disk is addressed
  by uuid. Verified on iOS 26: all three render it verbatim, nothing escaped or
  substituted. The 2026-07-24 rule scopes the ban to "filenames, URLs, package
  names and social handles… anywhere a name must be stored or typed", and a
  display label is none of those — it is exactly where the mark belongs. Recorded
  because "the App Store name carries no slash" reads at a glance as "the app is
  never called bento/tray", and someone will otherwise "fix" the plist.

**One app, not two.** A separate "generic HTML runner" listing would risk
guideline 4.3 (duplicate apps from one developer) and doubles the listing
overhead — screenshots, privacy labels, review cycles — for no gain. The
Developer Program is $99/yr per ACCOUNT, so a second app costs nothing in fees;
the cost is entirely in maintenance.

Consequence already implemented: each document gets its OWN origin
(`bento-tray://<sha256 of path>`), because a shared origin would let one
document read another's localStorage and IndexedDB — tolerable when every file
is yours, a real leak between unrelated third-party apps.

## 2026-08-02 — Agents get tools to measure and check, not a layout engine

Issue #160 was an agent authoring a deck from `agents.md` alone; #194 split out
its largest finding — that an agent cannot measure text, so every card, caption
and two-line heading is a guess, and overflow and collisions all follow from
that. The proposed remedies were `h: "auto"`, declarative layout containers,
and a `validate()` call. We shipped the checking tools and deliberately did NOT
build the layout engine.

**`h: "auto"` is impossible, not merely unwise.** `h` is a required `number`
that morph does arithmetic on — `a.h + (b.h - a.h) * p`, then `scale(h / b.h)`.
A string there yields `height: "autopx"` (invalid CSS, silently dropped) and
`scale(NaN)` in every SHIPPED copy of Bento, which is frozen code we can never
fix. Any future auto-height must be an ADDITIVE flag (`autoHeight: true`) with
`h` still holding the last resolved number, so old shells read a valid box.

**Layout containers are declined for now.** A `layout: {type, gap, cols}`
container resolved to concrete pixels would work — the file would stay
absolute-pixel, so morph, the drag handles and old shells are untouched. It is
declined because the hole it was proposed to fill is now filled: with
`window.bento.measure()` an agent can compute a row or grid directly, and
`agents.md` carries the column arithmetic pre-computed. Containers would make
correct layout DECLARATIVE, not POSSIBLE — convenience, not capability.

The cost is not the arithmetic, it is the semantics. Every element is draggable
today and the model says where it is; inside a container, dragging a child must
either be disabled (confusing, the handles are right there) or break it out
(needs UI and a rule for what "out" means). That is more design work than
`measure()` and `validate()` together were.

If containers are ever built, note the constraint that makes them safe:
resolution must be PURE GEOMETRY (gaps, weights, counts) so every replica
derives the same answer, which is what lets `syncLinkedCharts` and
`syncConnectors` derive-not-commit. The moment resolution measures text it
becomes environment-dependent — a webfont that has loaded on one replica and
not another gives different heights — and replicas LWW-fight over the geometry.
That, not the layout maths, is the reason auto-height children are the hard case.

**What shipped instead** (#193, #195, #197, #198): `measure()` sizes text from
a spec, before the element exists; `validate()` reports what the runtime
silently swallows; both go through the real renderer, and through ONE module,
so they cannot disagree about whether a box fits. The unknown-key tables are
generated from `model.ts` via the TypeScript AST and pinned in CI, because a
validator that reports a real property as unknown is worse than none — an agent
acting on that deletes working configuration.

Also settled while here: on a morph arrival the rule is PER ELEMENT and turns
on whether the element has a morph partner. With a partner it is already in
motion, so `fx.enter` and `fx.countUp` are both skipped. With no partner it is
new to the slide, has no tween to fight, and both run. Do not "simplify" this
back into a blanket morph-vs-entrance branch; that blanket rule is what made
count-ups silently dead and `slide-left` silently mean "rise 14px".

## 2026-08-02 — Publishing one app may never delete another's artifacts

`site/` is assembled for ONE app and mirrored into `bento-site` with
`rsync -a --delete`, so anything that build did not write is removed from
bento.page. Measured, not theorised: a cloned `release.mjs --app spaces`
staged a spaces site, and a publish against a copy of the real published tree
removed **47 live files** — `releases/slides/Bento_Slides.bento.html`,
`releases/slides/manifest.json`, `packs.json`, all 22 signed language packs,
`slides/index.html`, all four gallery decks, `guestbook/index.html` — with
every existing gate reporting green.

Shipped slides files check `releases/slides/manifest.json` at launch
(`slides/src/main.ts`) and their pack channel at `releases/slides/packs.json`
(`slides/src/packs.ts`). Both are frozen URLs in files already on disks, so a
deletion takes those channels offline permanently, for every copy in the
world, with no client-side repair. It is the one publish mistake with no way
back.

**Why nothing caught it: the existing gates are fail-OPEN.** The
shell-consistency gate and the pack-index gate are both
`if (existsSync(<path in site/>))` — an artifact that is *missing* skips the
check instead of tripping it, and missing is exactly the dangerous case.
PR #192's `--exclude guestbook.bento.html` is one hardcoded filename, not a
mechanism; it must not be read as evidence that protection exists.

**The gate is a deletion inventory of the DESTINATION, and it is fail-closed.**
Before mirroring, walk the published tree and refuse if any path would
disappear. If the destination cannot be inventoried at all, refuse — that is
the case where we know least about what we are about to overwrite.
Deliberate removal is `--allow-deletions`, which lists what it would drop.

Deletions are singled out from changes on purpose. A changed file is a release
doing its job; the one byte-change nobody can repair, a manifest going
backwards, already has its own monotonicity gate.

Gate on the published INVENTORY, not on `releases/*/manifest.json`. The
deletion set included `slides/index.html`, the gallery, `agents.md`,
`skills/`, `LICENSE`, `404.html`, `help/`, `q/`, `og.png`, `robots.txt` and
`sitemap.xml` — none of which a manifest-shaped gate would have seen.

Rig: `scripts/test-publish-gate.mjs`; shared logic `scripts/site-inventory.mjs`.
This is the first half of the multi-app release work
(`working/design/spaces-design.md` §6.1); per-app assembly — build one app, restore
the others byte-identically from the published tree — is the second, and
spaces cannot be released until both exist.

## 2026-08-02 — bento/home runs documents in a per-document origin, or not at all

`bento/home` is a launcher (`home/`, `working/design/home-design.md`): it holds no
document content, only `FileSystemFileHandle`s in IndexedDB, so a deck you were
working on reopens with write access after one permission click. That part is
measured and built. **How a document is actually OPENED is the hard part, and
this entry records why the obvious answers are wrong.**

**The constraint.** Opening a deck with silent save means running that file's
own code somewhere AND getting the handle to it. A blob URL inherits the
creating page's origin, so `window.open(URL.createObjectURL(file))` runs the
document on *home's* origin — with full access to home's store of writable
handles to every other deck. A file someone emailed you could rewrite all of
them. That is a real escalation over double-clicking it, where the file gets an
opaque origin and reaches nothing.

**A shared runner origin (`run.bento.page`) was considered and REJECTED.** It
fixes the wrong half. Documents could no longer read home's handles, but they
would all share one origin with each other, and a Bento document persists:

- `bento-autosave` IndexedDB — `recovery` (PLAINTEXT doc JSON, keyed by docId)
  and `versions` (a timeline of the same)
- `localStorage` `bento-member-<docId>` — the device's collab member PRIVATE KEY

So one runner origin creates a pooled store, which does not exist today, holding
the full plaintext content and version history of every document opened through
it plus the keys that authorise writing to their collab rooms. Any document on
that origin can read all of it. This is the same conclusion the 2026-07-24 tray
entry reached from the other direction ("a shared origin would let one document
read another's localStorage and IndexedDB"), and it is not a coincidence: it is
the same threat with a different host.

**`file_handlers` + `launchQueue` is NOT an isolation approach.** It delivers a
double-clicked file to the *installed PWA* — home's own origin. It answers "how
does the OS reach us", not "where does the document execute". It composes with
per-document isolation; it does not substitute for it.

**Ruled: per-document origin, or home does not open documents.** Home may
acquire a handle any way it can (picker, drop, `launchQueue` when installed) and
must hand off to an origin derived from the document's identity. Until that
exists, `home/src/launch.ts` REFUSES and says so in the UI, rather than quietly
taking the blob route. A launcher that silently widened the blast radius of
every deck you open would be worse than one that does not open them yet.

Also considered: a shared runner with storage deliberately neutered (no
autosave, no member keys, `Clear-Site-Data` per load). It removes the pool by
breaking recovery, version history and collab identity, and stays safe only for
as long as every future feature remembers not to persist anything. Per-document
origins get the same property structurally. Not adopted.

**Hosting consequence, measured 2026-08-02.** `bento.page` is GitHub Pages
behind Cloudflare (`x-github-request-id` on the apex); `sync.bento.page` is
Cloudflare-only. GitHub Pages serves one custom domain per repo and no
wildcards, so per-document origins cannot be hosted the way the rest of the site
is — the runner belongs on Cloudflare beside the relay, with its own deploy
cadence and the deploy-order care that implies (`docs/PLATFORM.md` §5).

**To confirm before building** (none of it testable in an automated browser —
permission-gated APIs report `denied` there without prompting,
`working/design/home-design.md` §3.2, a trap that already produced two wrong
conclusions):

1. Does a `FileSystemFileHandle` survive a cross-origin `postMessage` and stay
   usable? Permissions are per-origin, so the receiving origin re-prompting once
   is expected and acceptable; being unusable is not, and would sink this shape.
2. Cloudflare Universal SSL covers one label (`x.bento.page`), not two
   (`x.run.bento.page`). If so, a single hyphenated label — `<hash>-run.bento.page`
   — avoids paying for Advanced Certificate Manager. Worth checking before
   committing to a naming scheme, because it is baked into every stored origin.

**Naming.** `run`, not `slides` or `deck`. The runner never parses the format —
it executes a self-contained file that may be slides, spaces or sheets. An
app-named origin would isolate nothing extra (every deck would still share an
origin with every other deck) and app names should stay free for the apps' own
pages. The precedent is `sync.bento.page`: a subdomain marks a TRUST BOUNDARY,
not a product. An origin that executes files strangers sent your users is the
last one that should share a name with anything you want trusted.

## 2026-08-02 — MEASURED: a file handle cannot be delegated across origins

Follow-up to the entry above, which ruled that bento/home must run documents in
a per-document origin. **That is not reachable, and the measurement says so
unambiguously.**

`tray/webext/probe/` (run it with `node scripts/probe-origins.mjs`) picks a file on one
origin, grants write access there, and `postMessage`s the handle to another
origin. Chrome 150, macOS, 2026-08-02:

```
SENT     control ping → http://localhost:5302
SENT     handle       → http://localhost:5302
  [runner] CONTROL  plain object arrived — the channel works.
  [runner] MESSAGEERROR — a message arrived but could not be deserialised
```

The control object lands; the handle does not. `postMessage` **succeeds on the
sending side** — the handle serialises fine — and the receiving origin fires
`messageerror` instead of `message`, meaning deserialisation was refused. This
is why the first run of the probe looked like silence: nothing was listening for
`messageerror`, and a refusal is indistinguishable from a lost message without
it.

**The consequence is larger than "option B needs a different transport".** The
origin that acquires a handle is the only origin that can ever use it. So:

- Home cannot be a broker. It cannot hold handles for an isolated runner.
- Per-document origins cannot be reached the other way either, by having the
  document's own origin do the picking: the origin name depends on which
  document it is, and you cannot know that before reading the file, and you
  cannot move the handle after. The circularity is not incidental.

**What that leaves**, none free:

1. **Home and documents share one origin.** Rejected in the entry above and the
   reasons are unchanged: `bento-autosave` (plaintext doc JSON, version
   history) and `bento-member-<docId>` (collab private keys) pool into one
   store any document can read.
2. **Home never opens documents** — a drop target and a list, with opening left
   to the OS. Safe, and much less useful.
3. **Sandboxed iframe + save proxy.** Run the document in
   `<iframe sandbox="allow-scripts">` WITHOUT `allow-same-origin`, so it gets an
   opaque origin and can reach no storage at all — not home's, not another
   document's. Home keeps the handle and performs the write itself, with the
   document asking through a postMessage protocol.

Option 3 is the tray shape, and tray already proves the protocol half:
`tray/bridge.js` polyfills `showSaveFilePicker`, so `save.ts` needs no
host-specific code and the app does not know it is hosted. Reusing that contract
rather than inventing a second one is the point of the 2026-08-01 entry on
`tray/android/`.

**To measure before committing to option 3** (again: not testable in an
automated browser): an opaque-origin document has NO localStorage and NO
IndexedDB, so `bento-autosave`, version history, `bento-member-<docId>`,
language choice and reduce-motion all fail or degrade. Whether the runtime
survives that gracefully, and whether the degradation is acceptable, decides
whether home can open documents at all.

## 2026-08-02 — MEASURED: an opaque origin is blocked by unguarded storage, not by incapability

Third measurement in the bento/home sequence (`tray/webext/probe/sandbox.html`, Chrome
150, macOS). Same deck loaded twice from a blob: once in a plain iframe, once in
`<iframe sandbox="allow-scripts">` with no `allow-same-origin`, so the second
gets an opaque origin. The control is what makes the result readable — it
separates what the sandbox breaks from what breaks anyway.

| capability | control | sandboxed (opaque) |
|---|---|---|
| `localStorage` read/write | ok | **SecurityError** — sandboxed, lacks `allow-same-origin` |
| `indexedDB` present | object | object |
| `indexedDB.open` | ok | **SecurityError** — access denied in this context |
| `caches` | object | **SecurityError** |
| `crypto.randomUUID` / `subtle` | ok | **ok** — secure context survives |
| app boot | ✓ 17 slides | ✗ nothing |

**The interesting part is the failure mode.** Nothing reached `window.onerror`
and no promise rejected, so from outside it looked like a silent death. The
shell's own loader had caught it and printed to the page:

> This file could not start: Failed to read the 'localStorage' property from
> 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.

So the runtime does not fail because it NEEDS storage. It fails on the first
unguarded `localStorage` touch during boot — `kernel/src/i18n.ts` `resolve()`
reading `bento-lang`, which runs at module scope and therefore before anything
else. There are 39 `localStorage` call sites across `kernel/src` and
`slides/src` and no safe accessor.

**That is bounded and mechanical, not architectural.** A guarded accessor
(returns null / no-ops when storage throws) would let a document boot in an
opaque origin.

> **RESOLVED, same day (#205, `c1e8902`).** `kernel/src/storage.ts` now guards
> every one of those call sites, and the table above is out of date in its last
> row: the built shell boots in an opaque origin with **17 slides and 19
> surfaces, identical to the unsandboxed control, zero errors**. Do not re-run
> the sandbox probe expecting a failure — it passes now. What the table still
> reports correctly is the *storage* rows: `localStorage`, `indexedDB.open` and
> `caches` all throw there, and always will. Worth doing on its own merits regardless of home: the same
unguarded reads mean a deck opened with cookies-and-site-data blocked, or in
some embedded webviews, shows "this file could not start" rather than working
with default preferences.

**What it does NOT fix**, and this is the actual product decision: an opaque
origin has no persistent storage at all, so a document hosted this way loses
auto-save and crash recovery, local version history, and its collab member
identity (`bento-member-<docId>` is re-minted per session). Whether a launcher
may open documents that quietly cannot autosave is a question about what Bento
promises, not about what the browser permits.

Sequence so far: handles cannot be delegated across origins (entry above), so
the only isolation left is an opaque-origin frame with home proxying saves; an
opaque-origin frame is reachable once storage access is guarded; and what
remains is deciding whether a document with no persistence is one we are willing
to serve. Not settled here.

## 2026-08-02 — bento/home is closed; the host is a WebExtension (`tray/webext/`)

Home was a web page that would remember your decks and reopen them with write
access. Three measurements in one session closed it, and the same three point at
the successor.

**What killed it.** A `FileSystemFileHandle` cannot be delegated across origins
(entry above): `postMessage` serialises it and the receiving origin fires
`messageerror`. So the origin that ACQUIRES a handle is the only origin that can
use it — home cannot be a broker. Per-document origins are unreachable from the
other side too, because the origin name depends on which document it is, which
is unknowable before reading the file, and the handle cannot move after. What
remained was: run every document on one shared origin, where `bento-autosave`
(plaintext doc JSON, version history) and `bento-member-<docId>` (collab private
keys) pool into a store any document can read. Rejected.

A launcher that can list decks but not open them is not worth building.

**MEASURED, and it is the unlock** (Chrome 150, macOS,
`tray/webext/probe/directory.html`): a DIRECTORY grant is not per-file.

```
GRANTED  <folder>                       queryPermission: granted
  ── reload ──
RESTORED <folder>  kind=directory       queryPermission, no gesture: granted
[file 1] getFileHandle('bento-probe.txt', {create:true})
[file 1] the FILE's permission, unprompted: granted   ← never picked
[file 2] the FILE's permission, unprompted: granted
```

One folder grant survived a reload — still `granted` with no gesture, and
re-grantable with one click when it does lapse — and covered files inside it
that were never picked. So a host holding a directory handle can write ANY deck
in that folder, including one the user opened by double-clicking, which no web
page can do for itself.

**The shape.** The document stays on `file://`, which the browser treats as a
unique origin per file — per-document isolation for free, the thing three probes
failed to construct. A content script is the bridge transport; the extension
holds the directory handle and performs the write.

That is `tray`, in a browser. `tray/README.md`'s contract —
`showSaveFilePicker({suggestedName}) → { name, createWritable() }` — is
explicitly "platform-neutral; only the transport lookup and the native file
layer are not". `save.ts` needs no host-specific code and the app never learns
it is hosted.

**`tray/webext/`, not `tray/chrome/`.** Chrome, Edge, Firefox and Safari
extensions are one format with different manifests, so a browser name would be
wrong at the second target. Same reasoning as the `tray/android` entry: sharing
the name makes sharing the bridge contract the default rather than a convention
someone must remember. Note it is a PARTIAL tray — it supplies the file layer
and the transport, not the document browser or thumbnails `tray/ios` provides.

**Firefox gets nothing from this.** It implements no File System Access API at
all, and its extensions cannot write arbitrary files either; that needs native
messaging with a native helper. Firefox stays download-a-copy. Safari likewise
has no FSA, and a Safari Web Extension ships inside a native macOS app anyway —
so Safari's answer is `tray/macos`, not an extension.

**Still unverified, and the next thing to measure:** whether an MV3 service
worker can use a stored directory handle to `createWritable()` at all, or
whether the write must happen in an offscreen document or extension page. Keep
the write behind one function so the answer can move without touching the
contract.

**Kept from home:** `tray/webext/probe/` (four probes, all reusable) and
`home/src/deckmeta.ts`, which reads a deck's title without executing it — the
extension needs exactly that to label what it is about to save. The launcher UI
and the recents store are superseded by the directory grant.
## 2026-08-02 — One autosave database per app, migrated once

`kernel/src/autosave.ts` used a single `DB_NAME = 'bento-autosave'` and a single
`DB_VERSION` for every app. Two problems, and the second is the dangerous one.

Snapshots from different apps piled into one store wherever they share an
origin — `bento.page`, or any local server. bento/spaces has been writing into
bento/slides' database since its scaffold landed (`spaces/src/main.ts` calls
`putRecovery` on a 2.5s debounce).

`DB_VERSION` was shared too, and that breaks in one direction only: a new app
bumping it to 2 makes every ALREADY-SHIPPED shell of every other app throw
`VersionError` on open and lose autosave entirely. Shipped shells are frozen
code — 1.0.11 files are in the world and will go on opening version 1 forever.
There is no way to reach them.

**The name is `${appId}-autosave`.** `appId` is already `bento-slides` /
`bento-spaces`, so this reads `bento-slides-autosave` with no doubled prefix
and — deliberately — **no special case for the app that happened to be
first**. An earlier draft grandfathered `bento-autosave` for slides to avoid
orphaning data; carrying the data over is a better answer than a permanent
exception, and each app now owns its own version line.

**Migration copies, once, and never moves.** Renaming alone would silently drop
every user's recovery snapshot and their whole version timeline — a visible
feature emptying itself, which is a bug report, not a migration. It runs only
into an empty target, so a second pass cannot duplicate the timeline or
resurrect a snapshot the user deleted. The legacy database is left intact
because shells already shipped keep writing to it, and the copy of the app the
user opens next must still work; `pruneOld` ages its contents out on its own.

Everything is copied, not just the running app's rows. Nothing in a snapshot
records which app wrote it, and it does not need to: `docId` is a uuid, so
another app's rows can never match a lookup. Filtering would mean guessing.

`appConfig()` is read LAZILY inside `openDb()`. It throws before
`configureApp()` runs, and a kernel module that explodes at import time
depending on evaluation order is the trap `app.ts` exists to avoid — its header
comment named autosave as config-free and is corrected in the same change.

Rig: `scripts/test-autosave.ts`, run for both apps in CI. It fails against the
old shared-name code (7/8), which is the property that makes it a gate.

## 2026-08-02 — A release seeds from what is published, and builds one app

Second half of the multi-app release work (`working/design/spaces-design.md` §6.1).
The first half made a destructive publish impossible; this one makes a
non-destructive one possible.

`release.mjs` was slides-shaped end to end: `rmSync(site)` then stage slides.
One release builds ONE app, and `site/` is mirrored with `rsync --delete`, so
every other app's signed shell, manifest and packs — fetched by shipped files
at frozen URLs — were simply absent and would be deleted.

**A release now SEEDS `site/` from the published tree and overwrites only what
it built.** "Restore every untouched app byte-identically" becomes the default
rather than a step someone remembers. It composes with the publish-time
deletion gate: this fills the gap, that one refuses if a gap remains.

Verified in both directions against a copy of the live tree: a spaces release
leaves all 47 published files byte-identical and adds only `releases/spaces/`
and `spaces/` (`diff -r` reports nothing but "Only in"); a slides release with
spaces already published rebuilds slides and leaves spaces intact. Both report
`deletion gate: none would be removed`.

**Without a published tree, a release REFUSES** (`--allow-missing-published`
for a genuinely first release). Continuing would stage a partial site whose
publish deletes every other app; the gate would catch it, but failing here says
what to do about it.

**Site content has exactly one owner.** Landing, gallery, agent guide, skills,
`/help`, `/q`, 404 and the guestbook are slides-derived — the gallery and 404
decks literally embed the slides shell — so only a slides release rebuilds
them. A spaces release must not regenerate them from a shell it did not build.
`ownsSiteContent` says so, and the rig asserts exactly one app claims it.

**Packs stay slides-only.** `build-i18n.mjs` and `sign-packs.mjs` are
slides-hardcoded (§6.5) and spaces has no catalog, so a spaces release stages
NO packs rather than unsigned ones — `publish-site.mjs` refuses unsigned packs,
correctly.

`sign-release.mjs` gains `--app`; it hardcoded `bento-slides`. This is the
silent failure of the set: a shipped shell verifies the manifest's `app`
against its own `configureApp()` id (`kernel/src/update.ts`), so a wrong value
signs and publishes a channel every file quietly declines — nothing errors,
updates just stop.

The registry lives in `scripts/apps.mjs` with a rig, `test-release-apps.mjs`,
because a release signs and the key never reaches CI: the pipeline is not
CI-testable, but the registry drifting from the tree is. It pins `appId`
against each app's own `configureApp()` call and the manifest URL against the
path the release publishes to.

## 2026-08-05 — The board's order IS the page order, and a view's filter is two keys

**Decision.** Dragging a card between columns sets that issue's field value.
Dragging it *within* a column reorders `doc.pages`. There is **no per-view
order field**, and nobody may add one in a drag handler. A view's filter is
`filter: { is?: {key: string[]}, open?: boolean }` on the `view` block, and
absent means everything.

**Why order is the page array.** An issue IS a page, and pages are already an
ordered list — the sidebar renders it, the markdown export walks it, and a
saved file preserves it. A stored per-view order is a permanent format field
that has to answer what happens to an issue no view has ever seen, what happens
when two views disagree, and what a build that predates it does with the
orphaned key. Reordering the pages answers none of those questions because it
does not ask them. The consequence is deliberate and worth saying out loud: the
board's order and the sidebar's order are the same order. `fields.ts
reorderPages` is the whole mechanism, and it returns null when a drop changes
nothing, which is what keeps a drag that went nowhere out of the undo stack.

**Why `sort` is NOT implemented.** `sort: [...]` appears in the shape sketched
in the ruling below. It is still unimplemented, and now it is not free: a
stored sort and a hand-dragged order contradict each other, and which one wins
is a format decision, not a rendering detail. Whoever needs sort settles that
first. Until then a `sort` key round-trips untouched and is ignored.
*(SETTLED 2026-08-06 — see "A sorted board is a different question" below.)*

**Why the filter is two keys.** `is` (a field's values) and `open` (a phase).
A filter language grows without limit and can never shrink — every operator is
in files on other people's disks the moment it ships. These two answer the two
questions a tracker is actually asked. Rules: an absent filter, an absent key
and an empty value list all mean "no constraint", so every view block written
before filters keeps working and an empty stored filter is deleted rather than
kept; a value this build does not know is compared LITERALLY, so a filter a
newer build wrote still selects what it meant; `open` is derived from
`FieldOption.group` on the first field whose options declare one (never
hardcoded to `status`), and an unknown value counts as OPEN, because hiding
work this build cannot read is a loss and showing one issue too many is not; a
filter key this build cannot evaluate is kept, is not applied, and the view
SAYS SO — a count that is silently too high is the failure additivity would
otherwise trade for.

**Touch.** A phone cannot drag an HTML5 draggable, and the board is the
tracker's main screen, so every card carries a status BUTTON that opens the
same picker the issue's own header strip opens, through the same writer
(`editor.applyField` → `fields.propHtml`). There is exactly one place where
`value` and `html` are written, and there must stay exactly one.

## 2026-08-06 — A sorted board is a different question, and it never eats the hand order

**Decision.** `sort?: ViewSort[]` on the `view` block ships, where
`ViewSort = { key, dir?: 'asc'|'desc' }`. Absent means the page order. The entry
above deferred this until somebody settled which of a stored sort and a
hand-dragged order wins; this is that settlement, and it also makes `layout` and
`groupBy` reachable, which they were not.

**A sort never overwrites the manual order — it OVERRIDES it, for as long as it
is there.** The two orders live in different places: the hand order is
`doc.pages`, the sort is a key on one block. Nothing about sorting a view
touches the page array, so clearing the sort returns the board to exactly the
arrangement it had, and a second view of the same issues sorted differently
takes nothing away from the first. That is the whole reason the contradiction
dissolves rather than needing a winner: they were never competing for the same
storage. "Manual order" is the first item in the Sort menu because it is the
absence of a sort, not a sort called manual.

**A sorted board stops offering positional drops.** With a sort in force the
order within a column is computed, so a drop position would write into
`doc.pages` an order the next paint discards — a gesture that appears to do
nothing and leaves an undo step behind. The column still highlights and still
accepts the card (the value change is real); only the insertion point stops
being offered. `dropIssue` takes a null aim for exactly this.

**Ordering rules, because each one is silently wrong the other way.** A select
sorts by its DECLARED position — "Backlog, Todo, In progress, Done" is a
direction, and alphabetising it throws away the only thing the list was saying.
An UNSET value sorts last in BOTH directions: it is not the smallest value, it
is the absence of one, and flipping the direction must not promote every blank
to the top. A value a NEWER build wrote has no declared seat and sorts after
everything this build knows, rather than leading a board with a status nobody
here can read. Ties keep the page order (a stable sort), so a hand-arranged
board still reads that way within each band. A sort key naming a field this
build has no schema for is skipped and the view SAYS SO — the same honesty rule
`unknownFilterKeys` already carries.

**An ARRAY holding one entry.** The editor only ever writes one key; the format
takes a list because that is the shape already published in the ruling below,
and because a second key can be added later without touching a file, where
widening a scalar afterwards could not be done at all.

**Storing a default is storing a lie.** Choosing Board, or grouping by `status`,
or Manual order DELETES the key rather than writing what absence already means,
so a view somebody switched to a list and back is byte-identical to one that was
never touched — the same rule the filter already followed.

## 2026-08-05 — An issue is a page: the tracker format for bento/spaces

**Decision.** bento/spaces gains an opinionated, Linear-shaped issue tracker.
An ISSUE IS A PAGE. Its fields are `prop` BLOCKS. The schema those fields draw
on is `doc.fields`. A saved view is a `view` BLOCK. Nothing about this is a new
document type and nothing is a page-level key.

**Why spaces rather than a new app.** A tracker is a pile of short documents
with typed fields and a few saved queries over them. Spaces already has pages,
rich bodies, links, backlinks, search, archive, print, i18n, nine languages and
an agent surface — which is most of a tracker — and Linear's own model is
"an issue is a document with fields". A separate app would rebuild all of it,
and would land where Jira is: a tracker whose issues cannot hold a real
document. The suite's other half, bento/dash, owns typed COLUMNS over rows;
this owns typed FIELDS on documents. That is the seam.

**The format.**

    doc.fields: [                       // the schema, document-level
      { key: 'status', label: 'Status', vt: 'select', options: [
          { id: 'todo', label: 'Todo', color: '#…', group: 'unstarted' }, … ] },
      { key: 'assignee', label: 'Assignee', vt: 'person' },
      …
    ]

    // …and on an issue page, its values, as ordinary blocks:
    { id:'b1', type:'prop', key:'status', value:'todo', html:'Status: Todo' }

    // …and a board, which is also just a block:
    { id:'v1', type:'view', layout:'board', groupBy:'status',
      filter:{…}, sort:[…], html:'Board — all issues by status' }

**Why values are blocks and the schema is not.** The ruling above already
settled values: a `prop` block degrades losslessly on a build that predates it
(render.ts's `default:` branch shows its `html`), and it is found by ⌘F, ⌘K,
undo and the block registry for free, because every one of those iterates
`page.blocks`. A page-level key renders as nothing and is invisible to all of
them. But the SCHEMA is not a value: putting the status list on every issue
would copy it into every page and let two pages disagree about what "Todo"
means. Document-level is the only place it can live, and `doc.fields` is
additive — a build that predates it ignores the key and still renders every
`prop` block's `html`.

**Every `prop` block carries a human-readable `html`.** That is what makes the
format degrade rather than vanish, and it is not redundancy: it is the same
discipline as the static preview and the markdown export. An older build, a
thumbnailer, a grep, and a markdown export all see "Status: In progress"
without knowing what a field is.

**Fields render as a header strip, by CONVENTION not by a new container.**
`prop` blocks that precede the first non-prop block on a page are drawn as a
compact strip under the title; the same blocks later in the body render inline.
No format flag says "this is a header" — the position does — so an older build
shows the same information in the same order, just stacked.

**What this buys the day collaboration lands.** Nothing needs doing. The CRDT
syncs pages and blocks; properties ARE blocks, so per-field last-writer-wins
falls out of the existing per-(node,key) registers, and two people changing
status and assignee at the same time both win. Had properties been one object
on the page, that would have been one register and one of the two edits would
have been lost silently — which is the measured reason the ruling exists.

**Deliberately NOT in this format.** No teams (a file IS the team boundary), no
per-user permissions (the file is the capability, per PLATFORM §5), no
notifications, no server-side automation. Those are Buzz's problem shape — a
relay, signed events, agents as members — and Buzz is a Rust service with
Postgres behind it. The thing Bento can do that neither Linear nor Buzz can is
hand you the whole tracker as one file that opens offline, forever, with no
account. That is the feature, and it is the reason the format has to stay
small enough to keep that promise.

## 2026-08-05 — The tracker's agent surface: written, warned about, never refused

**Decision.** `window.bento` gains `fields()`, `issues(query?)`,
`setField(pageId, key, value)` and `newIssue({title, ...fields})`, and
`validate()` learns about fields. Three shapes are settled here because they are
an API other work will be built on.

**1. A value this build does not know is WRITTEN, and warned about — never
refused.** The format is permanent and additive: a status a newer build declared
has to round-trip through an older one, and a verb that refused it would make
the older build unable to edit a document the newer one wrote. But an agent
typing `'In progress'` where the option id is `'doing'` has made a mistake and
silence would leave it confident, so the result carries
`warning: {code:'unknown-option', options:[…]}` and `validate()` reports
`unknown-field-value` at **info**. Refuse the shapes JSON cannot carry, warn
about the vocabulary. The same reasoning makes `unknown-field-key` info, and
`prop-html-stale` a warning — but that check STANDS DOWN when the value names no
known option, because then the writer knew a label this build does not and its
`html` is right where ours would be a guess.

**2. An unknown key in an ARGUMENT is a typo, not additivity.** `newIssue` and
`setField` refuse a key that is in no schema (`err: 'no-such-field'`). Unknown
keys in a *document* are how a future build's data survives; unknown keys in a
*call* are how an agent believes it set a priority it did not set.

**3. "Open" means NOT FINISHED.** `issues({group:'open'})` is one predicate —
not `done`, not `cancelled` — so a status with no phase and a status this build
has never heard of both count as work, and a status naming no option reports
`group:'unknown'` rather than being folded in with the rest. An issue wrongly
shown in a backlog costs a glance; an issue wrongly hidden from one costs the
issue.

`setField` is the ONLY supported way to write a value, because it writes `value`
and `html` together through fields.ts `propHtml()` — the same call the editor's
own field picker makes, so the two cannot drift. Guarded by
`scripts/test-spaces-agent.ts`; guide in `docs/spaces-agents.md`.

## 2026-08-03 — bento/spaces: the format decisions that must precede parallel work

Five independent design reviews of bento/spaces proposed overlapping feature
sets. Most of it is schedulable in any order. These are not: each is a place
where two workstreams would otherwise invent conflicting PERMANENT shapes for
the same thing, and the format has no server and no migration. Settled here so
nobody has to guess. Nothing below ships this round except where noted.

**1. Properties, tags and table columns are BLOCKS — never keys on `Page`.**
Three reviews proposed three incompatible shapes for the same data: prefixed
keys on the page (`p:status`), a `prop` block, and `Page.tags: string[]`.
Ruling: `{ type: 'prop', key, value, vt, html }`. A `prop` block degrades
losslessly on an older build — render.ts's `default:` branch renders its html —
whereas an unknown `col:` key on a Page renders as *nothing at all* and is
invisible to search, find-and-replace, undo and the block registry, all of
which iterate `page.blocks`. Tags stay literal text in `html` with a derived
index; no `page.tags` array. A markdown importer preserves YAML front matter as
a `code` block with `lang: 'yaml'` and never invents `page.meta`.

**2. Containers are one mechanism, declared once.** Tables, callouts and
columns are all "a block that holds blocks", and three agents each generalising
`renderBlocks`' host stack would make render.ts the conflict magnet
PARALLEL-WORK names by name. The contract: `container: true` in the BlockSpec;
a container gets NO gutter and NO inline text host (inside a `<tr>` either one
fabricates a phantom cell); a child whose parent chain does not resolve renders
as a plain block, never a stray `<td>`; and list grouping resets at every
container boundary, or a bullet before a table adopts the first bullet after it.

**3. A render-time transform may never decorate EDITABLE content.** The
rendered DOM *is* the model here: editor.ts:575 writes `b.html =
host.innerHTML` on every input. So any injected decoration is captured into the
file on the next keystroke — and then the allowlist deletes it. Verified:
sanitize.ts removes an element that is in neither ALLOWED nor UNWRAP *together
with its children* (the child-lifting happens only inside the UNWRAP branch),
so a rendered `<math>` costs both the rendering and the source text. Rule:
render-time transforms are gated on `opts.editable === false`, or use the CSS
Custom Highlight API, which touches no DOM. Slides solved the same problem by
swapping the raw token back while editing; spaces has no equivalent and must
not grow one by accident. This binds tag chips, inline math, mention
highlighting and pasted-markup decoration.

**4. `#p/<page>/<block>` is a legal href, tolerated from today.** Shipped in
this round — see the commit that made `resolveAnchor` the one resolver. It
could not wait: sanitize.ts's allowlist already admits the two-segment form, so
such links can arrive in a file this build did not write, and its own comment
records why a NEW fragment form can never be added later (a stricter build
strips it on the next edit that touches the block). Addressing — actually
scrolling to the block — comes whenever it comes; tolerance had to be now.

**5. `Page.stencil`, not `Page.template`.** `SpacesDoc.template` is declared
and documented in two comments as "re-mint docId on every open", and
implemented by nothing. Page-level templates get the name `stencil` so the two
meanings can never collide, and `doc.template` must either be implemented or
have its comments deleted. A dead field with a documented meaning is more
dangerous than an undocumented one.

**6. The effective-parent rule.** A block's effective parent is `b.parent` iff
that block exists in the same page's array AND appears strictly earlier in it;
otherwise the block is a root block. Same for pages. This is total (nothing
vanishes), acyclic by construction (every effective edge points backwards in
the materialised order), orphan-free, and — the point — a pure READ-TIME
function that mutates nothing, so two replicas that agree on the array agree on
the tree. It is what makes concurrent re-parenting safe under collaboration
without restricting what anyone can drag, and `renderBlocks`' host stack
already implements a narrower version of it.

**Shell ceiling for the round: 100KB compressed** (from 73KB). Spaces is 1/8th
of slides' size and that is a feature, not an accident.

*Amended 2026-08-04, after the round landed at 105KB.* Callouts (+4), syntax
highlighting (+5), markdown import (+15) and the agent surface (+8) came in 5KB
over. Raised to **110KB** rather than trimmed, and the reasoning is recorded so
the next person can disagree with it: import is the migration path and is worth
more than its bytes; the agent surface is the "designed for AI" claim made
executable rather than asserted; and at 105KB spaces is still a fifth of
slides. What is NOT allowed is discovering the breach at release time — the
ceiling is checked per feature from here, and the next one has 5KB, not 5KB and
a shrug.

*Corrected 2026-08-04, same day.* That sentence shipped with NO MECHANISM
behind it, and a reviewer found the gap by reading the number rather than the
build failing. It is real now: `scripts/size-budgets.json` holds the ceiling,
`scripts/test-spaces-size.mjs` enforces it, and CI runs it. Raising the ceiling
is expected; raising it SILENTLY is what the check stops — the budget moves in
the commit that spends the bytes, where a reviewer can see it. Recording an
intention and calling it a rule is how the 100KB ceiling got missed at all.

*Superseded 2026-08-24 — bento/spaces has no hard ceiling.* The maintainer's
call, and the number that prompted it: 258,454 B against a 256 KiB ceiling,
98.6%, with the polish round declining worthwhile fixes over a few hundred
bytes. A find-highlight refinement was dropped for size; an `aria-current` fix
landed only because it cost 32. When a ceiling starts choosing which
accessibility fixes ship, it is costing more than it saves.

**What went, and what did not.** Only the failure. `spaces` is now
`enforce: false` with a `reference` watermark, and every run still prints its
size and the drift since that number — `track spaces 258454 B (+312 B since
reference, no ceiling)`. The original entry's point was never the block; it was
that a budget nobody measures is a wish, and that the breach must not be found
by a reviewer weeks later. Measuring survives. Move `reference` when a change
buys real bytes and say what bought them, exactly as before.

**Do not quietly put it back.** `enforce: true` restores the ceiling for any
shell, and the other apps keep theirs — this decision is about spaces only. If
a future round wants the discipline back, that is a conversation, not a
one-line edit to a config file.

## 2026-08-03 — An encrypted space is never written to disk in the clear

**Decision.** bento/spaces skips the autosave recovery snapshot while a space
is encrypted, and setting a password clears both the version timeline and the
recovery snapshot already written.

**The bug.** `main.ts` called `putRecovery(store.doc)` on a 2.5s debounce,
unconditionally. The snapshot is the document as plain JSON, so an encrypted
space wrote its full plaintext into IndexedDB every few seconds — defeating the
password completely, for the one author who has demonstrably asked for secrecy.
`about.ts` already cleared the version timeline when a password was set, which
made the gap easy to miss: half of it was handled, and the half that ran
continuously was not.

**`putRecovery` does not guard this, by design** — it is a kernel primitive and
the encryption state is app-side. That makes it a CALLER contract, and a caller
contract with no gate is a bug waiting for the next app. Slides holds the same
contract in its own autosave layer.

**Measured, on the built shell:** typing into a plaintext space put the marker
text in the `recovery` store within three seconds (correct — it is the only
backstop on iOS, where no browser can write back to a file). Setting a password
removed that row; every later edit wrote nothing; and the saved file was still
a `bento/enc` envelope with no plaintext anywhere in it.

**Guarded** by two source assertions in `scripts/test-spaces-model.ts`, both
negative-controlled. Same reasoning as the inert-parse guard above: the
behaviour needs IndexedDB and a real clock, the mistake is made at the call
site.

## 2026-08-03 — A space does not phone home when it is opened

**Decision.** bento/spaces renders a remote image `src` as a placeholder naming
the host, with a "Load this image" button. Only `asset:` and `data:` load
without asking. Consent is per-url, per-session, in memory, and never enters
the document.

**Measured.** A space carrying `<img src="https://…/pixel.png">`, opened from
`file://`, issued the request — observed via `PerformanceObserver`, one
`resource` entry, before any interaction. That is a tracking pixel: the
recipient's IP address and the moment they opened your document, delivered to
whoever authored the file. In a format whose entire premise is that you can
mail it to someone, it is the wrong default by a wide margin. It also breaks
PLATFORM §1 — no network required to open.

**Why it costs authors nothing.** The editor never writes a remote src. A
picked image is downscaled, interned by content hash, and stored as `asset:`.
Only hand- or agent-authored documents can carry a url, so the only documents
affected are exactly the ones where a reader should be asked.

**The predicate is an allowlist,** not a blocklist of `http:`. A relative path
is a real request on a static host; so are `//host/x`, `blob:`, `filesystem:`
and any scheme this build has not heard of. `isRemote()` lives in `model.ts`
(pure, testable in node) and returns false only for `asset:` and `data:`.

**Consent is VIEWER state, like locale and reduced motion.** Putting it in the
file would let the author decide whether the reader phones home, and would
carry one reader's decision to everyone the file is forwarded to. It is a plain
`Set` on the editor, it dies with the session, and the click does not commit —
so undo, the dirty flag and autosave never see it. All four verified.

**The placeholder names the host.** "Load images" with no indication of who is
being contacted is not consent. It also shows the `alt` text, which is now the
thing a reader actually reads when an image does not load — so the agent guide
tells agents to always write one, and to embed bytes rather than link them.

## 2026-08-03 — Untrusted html is parsed INERT; a detached div is not safe

**Decision.** All untrusted html in bento/spaces goes through
`sanitize.ts inertBody()`, which parses with `DOMParser` into an inert
document. `document.createElement('div').innerHTML = untrusted` is banned, and
`scripts/test-spaces-model.ts` refuses it in the source.

**Measured, in a browser, on the real shell over `file://`:**

| construction | `<img src="404" onerror="…">` |
|---|---|
| `document.createElement('div').innerHTML = …` | **FIRES** |
| `new DOMParser().parseFromString(…, 'text/html')` | inert |
| `<template>.innerHTML = …` | inert |
| `document.implementation.createHTMLDocument()` | inert |

A detached div reads as safe — nothing was inserted into the page — but the
elements it creates belong to the LIVE document, so their resources load. The
handler runs from a node that was never attached to anything.

**Why this was the worst possible instance of it.** The sanitizer has to parse
hostile markup before it can strip it, so the sanitizer was itself the vector,
and the payload ran BEFORE the strip. `sanitizeInline` is called at render time
(`render.ts`), so the trigger was *opening a space someone sent you* — no
click, no edit. Sanitizing at render rather than at load is otherwise the right
call (every path into the DOM is covered by one line); it just meant this bug
sat on the open path.

Four call sites had the shape: `sanitizeInline`, `textOf`, `render.ts`'s
code-block text extraction, and — found by the guard, not by reading —
`about.ts`'s markdown export, so "Export as Markdown" ran what it was
exporting.

**The guard is a source assertion,** like the `.href`-IDL one above it: the
behaviour needs a DOM and a failing network request, and the mistake is made in
the source. It caught the fourth site the moment it was written, which is the
argument for writing it that way.

**Verified after the fix,** on the built shell from `file://`, with the removed
construction kept in the same page as a control: only the control fired. No
`[onerror]`, no smuggled `<img>`, no `svg[onload]`, no `javascript:` href
reached the DOM; the `#p/` link survived, external links kept
`rel="noopener noreferrer"`, `<p>a</p><p>b</p>` still unwrapped to "a b", and
markdown export produced `alpha **bold** *it* \`c\` [link](#p/sd-home)`.

**One consequence to remember.** The sanitizer's host now lives in a different
document, so nodes it inserts must come from `el.ownerDocument`, not the global
`document`. DOM4 adopts implicitly, so the wrong one would work — which is
exactly why it is written explicitly and pinned by the rig.

## 2026-08-03 — Release notes, agent guides and tags are PER APP

**Decision.** `scripts/apps.mjs` gained `changelog` and `agents` per app. A
release reads its own app's changelog (`CHANGELOG.md` for slides,
`spaces/CHANGELOG.md` for spaces) and publishes its own agent guide at
`bento.page/<app>/agents.md`. Tags are prefixed for every app but slides.

**The bug this fixes.** `release.mjs` read `join(root, 'CHANGELOG.md')`
unconditionally, and that file's first line is "All notable changes to
**bento/slides**". The first spaces release would therefore have SIGNED slides'
release notes into the spaces manifest — and every shipped spaces file fetches
that manifest at launch and renders `notes` inline in the About dialog. So the
failure is not a build error; it is a correct-looking release that tells all of
one product's users about a different product's changes.

It is unrecoverable in the ordinary way. The notes are inside the signed
envelope, so fixing them means re-signing — and the updater enforces version
monotonicity, so the same version cannot be re-signed. The fix would be
burning a version number.

**Why it was invisible.** Every gate was app-scoped. The registry rig checked
`dir`, `shell` and `appId` against each app's own source of truth, and each
check passed for each app in isolation. The wrongness only exists in the PAIR:
two apps naming one file. That is now a single assertion — the set of
changelogs has the same size as the set of apps — plus, per app, "your
changelog has a section for the version being released, and that section has
bold lead-ins" (a section of pure prose signs EMPTY notes, which is the same
class of silent failure).

**`--print-notes`.** `node scripts/release.mjs --app <app> --print-notes`
prints exactly what would be signed and exits before anything is built, wiped
or signed. A one-way artifact should be readable before it is committed to;
this makes reading it a one-second step rather than an act of faith. It runs
ahead of the `site/` wipe, which is why `cmpVer` is a function declaration and
not a const arrow — the const is in the TDZ at that point in the file.

**Agent guides.** `docs/agents.md` already advertised
`bento.page/<app>/agents.md` as the convention, but only the site-root
`/agents.md` was ever written. Each app now publishes its own guide at the
advertised URL, and slides copies its own to `/agents.md` for compatibility —
the README and the harness `SKILL.md` point there, and that SKILL.md ships
inside a zip people upload to claude.ai, so the root URL is effectively frozen.
One source, two paths.

**Tags.** Slides has 23 tags in the bare `vX.Y.Z` form and is at 1.0.15;
spaces starts at 0.1.0. An unprefixed spaces tag would sort into the middle of
slides' history and permanently claim a version slides cannot reuse. Slides
keeps bare; everything else is `<app>-vX.Y.Z`.

**Reconciled with #234.** bento/dash hit the same bug independently and landed
a convention-based resolver (`<dir>/CHANGELOG.md`, else the root) while this was
in flight. Both now go through ONE `changelogPath()` in release.mjs — registry
field first, convention second, root last — used by the signing path and by
`--print-notes` alike, so what a release reports and what it reads cannot
drift. The registry states it explicitly for all three apps, and the rig
asserts each app RESOLVES to its own file, which is what keeps the root
fallback unreachable. That matters because the fallback is only harmless while
version numbers do not overlap: the day a second app reaches 1.0.x, an empty
manifest would quietly become a wrong one.

## 2026-08-03 — One bento/spaces file is one SPACE, and the reason is a save primitive

Spaces is a tree of pages in ONE `.bento.html`, with links as same-document
fragments (`#p/<pageId>`) resolved against a map built from the file's own
`#bento-doc` block. Not one file per page with a folder as the workspace —
the Obsidian shape — and not cross-file links.

Five shapes were developed and each adversarially attacked. This records why
the folder shape is **unbuildable on this platform**, rather than merely more
expensive, because that is the part nobody should have to rediscover.

**The write primitive does not exist.** Without the File System Access API —
Chrome and Edge only — a save is a *download*. The page lands in the browser's
download directory, outside the folder its relative links resolve against. So
on Safari, Firefox and every iOS browser, the FIRST save of any page ejects it
from its own workspace. No design gets around this; it is not a link problem.

**On iOS a relative link returns the wrong answer, not an error.**
`tray/ios/EditorViewController.swift` answers every request on a document's
origin with that document's own bytes, so `href="./other.bento.html"` does not
404 — it re-serves the space you are already in at a different URL. Silently
wrong is worse than broken. Filed as a tray-zone request: 404 anything but
`/index.html`.

**Fragment routing is legal exactly where path routing is illegal.** Measured
from an origin-null document: `history.pushState(s,'','#p/<id>')` succeeds,
while `history.pushState(s,'','other.bento.html')` throws `SecurityError`. The
grammar the one-file shape needs is the one the platform permits.

**The folder shape buys no free OS search here.** `mdimport` on a shipped shell
returns `kMDItemTextContent = "<<< Text content of 75 characters >>>"` —
document text lives inside a `<script>` block and Spotlight cannot see it. True
of slides today too. Cross-file discovery needs an index either way.

**Prose is not the scale ceiling.** 2,000 pages / 26,000 blocks is a 5.2 MB
file that parses in 3.4 ms. Images are the ceiling, which is a product-shaped
limit, not a format one.

What the file boundary also becomes, and this is the design rather than a side
effect: the id scope, the link scope, the sharing boundary, the `docId` scope
(hence autosave and version history), the undo scope, the encryption scope, and
the save scope — every save rewrites the whole file.

Accepted costs, unchanged: sharing is per-file so there is no per-page
permission, and two people editing offline get two files and no merge until the
CRDT is generic. The pressure valves are first-class — export a page as its own
space, export a space as a markdown folder, import either.

The library tier — many spaces, searched together — attaches at a named seam
and is `bento/vault`'s job, which is optional by its own invariants 2 and 3.
One space needs nothing installed, ever; a library is software you run, on a
laptop or a 24/7 box or a cluster, the same artifact either way.

## 2026-08-03 — tray/webext ships through the stores; unpacked stays available

Settled with the maintainer. The **app stores are the main distribution
channel** for `tray/webext` — Chrome Web Store, Edge Add-ons, and the others as
they come — with the unpacked folder in this repo remaining a supported option
for people who want it.

Two corrections to earlier reasoning in this thread, both of which had made the
extension look less viable than it is:

**Developer mode is not required.** It is needed only for "Load unpacked". A
store-installed extension needs no Developer mode, no unpacked folder and no
warning banner. An earlier note in this session treated that as an inherent
cost of the whole approach; it is a cost of one distribution method.

**Store distribution does not conflict with the signed-release model.**
`docs/RELEASING.md`'s "signed locally, the signed bytes are the served bytes"
governs the DOCUMENT SHELL and its self-update channel. The extension is not a
document, carries none, and never touches that path, so a store-distributed
extension and a locally-signed shell coexist. What a store actually costs is
review latency and a second release cadence — ordinary, not philosophical.

**What does survive a store listing** is `Allow access to file URLs`: a
per-extension user toggle, off by default, required for content scripts on
`file://`. No manifest permission grants it. It is, however, DETECTABLE via
`chrome.extension.isAllowedFileSchemeAccess()`, so the extension can turn silent
failure into a guided one-time setup step rather than a mystery. That API's MV3
behaviour is unverified — measure before building on it.

Consequences already implemented: `permissions` trimmed to `storage` (an unused
`offscreen` would draw review questions it cannot answer), and content scripts
narrowed from every `file:///*.html` to `file:///*.bento.html`, which is both
correct and far easier to justify to a reviewer.
## 2026-08-02 — No extension system: compact per-app runtimes instead

The recurring proposal is an extension mechanism — sealed, separately signed
units that bake into a file like language packs do, so a heavy optional feature
ships on its own clock instead of riding the shell release. The immediate case
was a PowerPoint exporter carrying a large vendored dependency. The wider case
was that a mechanism built once would serve `bento/spaces` and `bento/dash` too.

**Declined, for every app.** Bento ships small, self-contained runtimes per app.
A feature is either core or it is a separate artifact — not a plug-in tier in
between.

This CONFIRMS rather than supersedes *"The pack carrier is generic; pack POLICY
is not. This is not a plugin system."* (2026-07-26). That entry stands exactly
as written: the carrier stays generic and reusable, and the reason to keep it
that way is engineering hygiene, not a plugin system waiting to be finished.

**The multi-app argument is the strongest evidence against, not for.** Bytes do
not amortize across apps, they multiply: every app pays the host, the container
and the per-app i18n for the machinery. Measured against real builds, the
cheapest extension host costs more than the entire `bento/spaces` shell as it
stands (10,052 B). Only review effort and one browser matrix amortize, and that
was never the expensive half. Worse, neither unbuilt app wants it: their designs
contain no extension-shaped feature, one of them independently ruled out
shell-block work and forbids carried user code outright, and both solved their
heaviest import/export payloads with browser primitives (`CompressionStream`,
`DOMParser`) and no dependency at all. An abstraction with zero confirmed
consumers, designed against two apps that do not exist yet, is the textbook case
for not building it.

**The economics invert once you follow the bytes.** An extension bakes into the
FILE, so the user who exports pays the dependency *and* the machinery, while the
user who never exports still pays the host. For the exporter that is worse than
merging the dependency into core unchanged. The break-even against a first-party
in-shell writer needs fewer than ~13% of users to ever use the feature — and for
a PowerPoint replacement, PowerPoint interop is the adoption path, not a fringe.
The same money buys far more as core: a first-party writer prototype targeting
the same format came in roughly 35x smaller than the vendored library it would
replace, using the same `CompressionStream` technique.

**Three extension mechanisms already exist, and they are better.** The Claude
Code plugin/skill channel extends Bento by RECIPE (`plugins/bento-slides/`) at
zero shell bytes and on its own clock. The native host bridge
(`tray/ios/Resources/bridge.js`) extends capability at the host, and reaches
every file ever saved — including ones that predate it. The kernel facade
pattern (`slides/src/charts.ts`, six lines over `kernel/src/charts.ts`) shares
implementation by structural typing with no frozen surface at all. Each costs
zero platform invariants. Reach for these before inventing a fourth.

**What this does NOT decide.** Kernelizing the language-pack channel
(`packs.ts` parameterised per app) is still wanted — both future apps list it as
blocking, and it is unrelated to extensions. So are the defects found while
looking: the offline switch does not gate pack fetches although `docs/security.md`
says it does; the shell-block registry is single-slot, so a second registrant
clobbers the first; and a block that fails to parse is skipped on read and then
removed by the clear pass, which deletes it permanently on the next save. Fix
those on their own merits.

**What would reopen this.** A confirmed second consumer in a shipped app, a
feature that genuinely cannot be core (a licence that forbids bundling, or bytes
that dwarf the shell even after a first-party rewrite), or a demonstrated need
for third-party authorship. Absent those, the answer to "should this be an
extension?" is "should this be core, a separate artifact, or a skill?"

## 2026-08-03 — Callout tones are GitHub's five, and the tone is never hue alone

**Decision.** `bento/spaces` gains a `callout` block whose `tone` is one of
`note` `tip` `important` `warning` `caution` — GitHub's alert vocabulary,
spelled the way GitHub spells it. That makes markdown export the identity
function (`tone` ⇄ `> [!TONE]`) instead of a mapping table, and a mapping table
is exactly the kind of thing that can be got wrong once and then never
corrected, because the wrong tone is already in files on disks.

**Five, and no `success`.** Docusaurus's set (note/tip/info/warning/danger) and
MkDocs' thirteen were the alternatives. The format is additive, so a sixth tone
can be added later — this build renders an unknown one neutrally, labels it with
its own word and preserves the string — while removing or renaming one is
impossible. When the decision is one-way, ship the smaller set.

**The icon is DERIVED from the tone, with an optional stored override.** Storing
it always would freeze today's glyphs into every document written today and let
the tone and the mark disagree (a "warning" wearing 🎉). The override exists
because a celebration is a callout too, and it never changes what the tone
means, in the styling or in the export.

**Meaning is carried by shape and by a word, never by hue.** Each tone's mark is
a different silhouette (circle, bulb, square, triangle, octagon) and its name is
rendered beside it as real text, translated. The tints are decoration: amber,
red and green are precisely the hues most colour-blind readers cannot separate,
and print drops backgrounds by default anyway. Body text stays `--ink`, not the
tone colour — a box exists to make a sentence more readable, not less.

**Nesting is a registry fact now.** `BlockSpec.container` is `'fold'` (toggle) or
`'always'` (callout); `render.ts` opens a body element from that rather than
testing for the type name, and `mdQuoteChildren` drives the `> ` marker every
descendant line needs (a GitHub alert ends at the first line without one, and
a blank line between two blocks of one alert closes the box). ⏎ inside a callout
puts the next line INSIDE it and ⌫ on an empty line takes you out — deliberately
not extended to `toggle`, because a fold can be shut and a caret inside a shut
fold is a lost line.

Details: `spaces/src/blocks.ts` (the registry entry, `CALLOUT_TONES`,
`mdLayout`), `spaces/src/render.ts` (`toneLabel`), and the callout section of
`scripts/test-spaces-model.ts`.
## 2026-08-03 — Code highlighting is in-house, offsets-only, and render-time

**Decision.** `bento/spaces` highlights code with its own ~350-line lexer
(`spaces/src/highlight.ts`), not a library, in eight languages: JavaScript,
TypeScript, Python, Shell, JSON, YAML, SQL, HTML/XML, CSS. Everything else
renders plain, deliberately.

**Why no library.** highlight.js is ~120KB and the useful subset of Prism is
~30KB+; the whole spaces shell was 72KB compressed. Either is the largest thing
in a product whose premise is that you can mail the file. Measured after
shipping ours: the lexer + painter + chip + palette cost **4.0KB compressed**,
and all eight vocabularies together a further **1.4KB** — ~180 bytes per
language, because keyword lists are lowercase ASCII and deflate eats them. So
the machinery is the cost and languages are nearly free, which inverts the
instinct to "support fewer languages to save space". It also means the honest
reason to stop at eight is testing, not bytes.

**Which eight.** What a working notebook accumulates — shell one-liners, a
config file, a snippet from the codebase — not a survey of languages. Adding a
curly-brace language is one keyword list; resist it anyway, because a language
nobody tested renders *nearly* right, which is worse than the plain fallback.
An unknown tag is kept verbatim in `lang`, so a `rust` block round-trips,
exports as ```` ```rust ````, and lights up by itself if the lexer learns it.

**THE TOKENIZER RETURNS OFFSETS, NEVER STRINGS.** A token is `{kind, a, b}` into
the caller's text and the tokens partition `[0, len)` exactly. That is the
security property, not tidiness: code in a space is text someone mailed you, and
a highlighter that cannot produce a character cannot produce markup, whatever
the input does. The painter walks the ranges and builds nodes with
`createTextNode`; there is no constructed markup string anywhere in the path and
therefore no escaper to get wrong — which is how every other highlighter on the
web does it, and why they all need one. `scripts/test-spaces-model.ts` asserts
the partition across every language over a corpus that includes `</script>`,
`<img onerror>`, unterminated strings and lone backslashes.

**Colour never enters the document.** `Block.html` stays the html-escaped plain
text it always was, so the same block is the same bytes whether or not the
reading build can highlight it, and reading view and print get their colour from
the same `renderBlock` call the editor uses. The editor's code host is therefore
read as `textContent` (not `innerHTML`, which now contains the colour spans) and
written through `sanitize.ts escText`, which escapes `&`, `<`, `>` and *not* `"`
— matching the html serializer exactly, so an untouched block never serializes
differently from the save before it.

**Highlighting a live contenteditable: reconcile, do not replace.** The painter
diffs the token stream against the existing child nodes and mutates only what
differs. The point is that on `input` the browser has ALREADY applied the
keystroke, so re-tokenising usually yields byte-identical nodes: measured in
Chrome on the built shell, typing in the middle of a line produced **one
`characterData` mutation (the browser's own) and zero `childList` mutations**,
and the caret moved 76 → 77 — untouched rather than restored. Only a keystroke
that moves a token boundary restructures anything; typing `"` produced
`childList` records and the caret went 79 → 80, restored by character offset.
An explicit save/restore on every keystroke would have been simpler and wrong:
assigning `Text.data` is specified to collapse a live range inside it to offset
0, so the restore has to exist — it just must not be the common path. IME
composition is skipped until `compositionend`; the model keeps up regardless.

**Found while building this: every markdown trigger was dead.** A space typed at
the end of a contenteditable line is inserted as U+00A0 so it cannot collapse.
Measured: after typing `## `, `host.textContent` is `['#','#',160]`, so
`/^## $/` never matched — `# `, `- `, `1. `, `> `, `[] ` and `--- ` had never
fired since 0.1.0. `autoformat` now normalises the NBSP before testing (never in
the model). This surfaced because the ```` ```lang ```` fence needs the same
trailing space; the bare ```` ``` ```` trigger was changed to be
space-completed, both for consistency with every other rule in that table and
because there is no keystroke left to type the language into otherwise.

**A trailing newline in an edited code block is Chrome, and it is bounded.**
Measured on a bare `pre-wrap` contenteditable with no Bento code involved:
inserting multi-line text yields one trailing `\n` (the caret placeholder), and
it does not accumulate — seeded with `abc\n` and typed into, the result is
`abcy\n`, still one. Left alone; the previous `innerHTML` read produced the same
byte.
## 2026-08-03 — Imported frontmatter is kept verbatim, not turned into properties

**Decision.** `spaces/src/markdown.ts` puts a note's leading `---` YAML into a
`code` block with `lang: 'yaml'` and `frontmatter: true`, nested inside a
collapsed `toggle` at the top of the page. Nothing in it is parsed, and no key
becomes a document field. The page title comes from a leading `# Heading` or
else from the FILE NAME — never from a `title:` key.

**Why not properties.** Spaces has no properties model, and this is the first
feature that meets one. A schema invented inside an importer would be derived
from whichever keys one person's vault happens to use (`tags`, `aliases`,
`cssclass`, `publish`), and once files carry it there is no server to migrate
them: the format is permanent. That would settle a design by accident, in the
one place with the least information about it.

**Why verbatim beats dropping or hiding it.** The yaml is the author's text and
some of it is load-bearing (`aliases`, `permalink`). Kept as a code block it is
visible, searchable by ⌘K and ⌘F, printable (toggles always print open), and it
exports back out as a fenced yaml block. `frontmatter: true` is an additive
marker, which is what makes the eventual adoption a mechanical sweep — find the
marked blocks, parse them then, delete the toggle — rather than an archaeology
exercise over prose.

**Why the title ignores `title:`.** `[[wikilinks]]` resolve by FILE NAME, which
is what Obsidian, Foam and Logseq all do. A title taken from frontmatter that
disagrees with the file name produces a page nobody can link to by the name
their other 300 notes use.

**What would reopen this.** A properties model shipping. At that point these
blocks are the migration input, and the marker is what makes them findable.
## 2026-08-03 — The spaces agent surface: plans, tagged results, and a validator that stays quiet

**Decision.** `window.bento` in bento/spaces gains `validate()`, `outline()`,
`stats()` and the patch verbs `updateBlock`, `removeBlocks`, `moveBlock`,
`updatePage`, `removePage` (`spaces/src/agent.ts`). Five rules were settled
along the way, and each is the kind another agent could reasonably reverse.

**A validator earns its severities by being silent.** The bar is not "few false
positives", it is ZERO findings on the space every new file opens with —
asserted in `scripts/test-spaces-model.ts`, which is the only baseline of
"idiomatic" available. The corollary is what is NOT checked: unknown property
names. Slides warns about them because its element schema is closed; here
unknown fields are the mechanism by which a future build's data survives an
older one, so warning about them would fire on documents working exactly as
designed. An agent that gets warnings for good documents stops reading them.

**Plan, then apply.** Every write verb returns `{ok, apply}` and the wrapper in
`main.ts` runs `store.commit(apply)`. `commit` checkpoints undo BEFORE it
mutates, so validating inside the commit would leave a refused patch with an
undo entry that undoes nothing. Verified in the browser: three refusals of three
kinds, then one undo, reaches the state before the last real edit. The split
also makes the whole write path testable in node — no store, no DOM.

**Tagged results for the new verbs; the old two keep their shapes.**
`insertBlocks` (ids | null) and `newPage` (id | null) shipped in 0.1.0 and are
in a published guide, so they stay. Everything added returns
`{ok:false, err, detail}`, because "it did nothing and told you nothing" is the
failure mode this whole surface exists to remove. For the same reason a patch
naming `id` (or `blocks` on a page) is REFUSED rather than ignored.

**An agent cannot write what the app could not have written.** `html` is
sanitized on the way IN, not only on the way to the screen; a `code` block's
html is escaped text instead (the renderer shows its textContent, so sanitizing
would delete the sample being shown), and only when it carries live tags, which
keeps a replayed patch from double-escaping. Values JSON cannot carry — a
function, a Date, a Map, a cycle — are refused rather than vanishing at save.

**A page is never left with zero blocks.** MEASURED in the built shell: a page
with `blocks: []` renders 0 editable hosts, 0 gutters and 0 block nodes — the
caret, the gutter and the `/` menu all hang off a block, so nobody can ever type
in it, and the editor cannot produce one (`mergeBack` refuses at the first
block). So `newPage` mints a paragraph as `model.newPage` always did,
`removeBlocks` refills a page it empties, and `validate()` calls a zero-block
page an ERROR. The old `bento.newPage()` created exactly this page.

*Amended 2026-08-04.* That was measured against the EDITOR, which still
cannot produce one. The markdown importer landed in the same tree and produced
them freely — one per folder without a folder note, one per empty file, plus
the invented root — and then navigated to one, so the first thing a vault
import showed you was a page you could not put a caret in. An invariant proved
for one writer is not proved for the next one; `planImport` now guarantees it
too, at the single point where it returns.

**Cost.** +8,040 bytes on the shipped shell (73,787 → 81,827; compressed
payload 72KB → 79KB). Most of it is the finding messages, which are the
product: a code with no explanation is not actionable. Anyone tempted to shrink
this should shorten prose, not drop checks.

## dash: a workbook holds two kinds of sheet — spreadsheets and datasets

2026-08-11. Settles a tension that was shipping as a visual lie.

An 8-row dash sheet has no row 9. ArrowDown from the last row does not move,
pressing `=` there opens the editor on the last DATA cell, and the ruled lines
under the totals row — which look exactly like empty spreadsheet rows — are
background paint on `.dg-table`. So the most common gesture in spreadsheets,
"click below the numbers and type `=SUM(`", silently targets a cell holding
real data. The footer total is not a formula and cannot be one: it is
`sheet.totals`, a property of the column.

THE DECISION: two sheet kinds, and the difference is where the type lives.
A SPREADSHEET is typed by CELL — unbounded, sparse, `=SUM()` anywhere, a canvas
that happens to hold numbers. A DATASET is typed by COLUMN — exactly the rows
there are, columnar and dictionary-encoded, and the kind that earns column
formulas, type refusal on import, conditional formats, chart binding, pivots
and (when it lands) SQL.

Neither is a lesser version of the other, and collapsing them either way loses
something real: one type per cell destroys the column type that the columnar
kernel and every derived feature depend on; one type per column destroys the
scratchpad. The conversion BETWEEN them is the actual product — promote a range
to a dataset, or open a dataset as a flat copy for the one awkward number the
pipeline cannot express. That round trip is why people abandon BI tools for
Excel, and dash can hold both ends of it.

WIRE WORDS: `kind: 'table'` remains the dataset. Renaming it would break every
file that exists, and "Dataset" is a display label — the rule `select()`
already follows. The new kind is `kind: 'grid'`.

This is safe to add because `parseDoc` preserves an unrecognised `kind`
VERBATIM rather than coercing it to a table (PLATFORM §3 additivity, fixed
earlier and commented in model.ts). Old builds round-trip a spreadsheet sheet
without damaging it.

Consequences recorded now rather than discovered later: the CRDT keys dataset
rows by `rid` and a spreadsheet has none, so its cells are keyed by POSITION
(`g␟<sheet>␟<col>,<row>`) and a row insert MOVES cells rather than renumbering
identities — a different convergence problem needing its own rig, not a reused
one. `a1.ts` already lexes `Sheet1!A1` but nothing resolves it, and a
spreadsheet without cross-sheet refs is half a spreadsheet, so that is in scope
for the kind. `.xlsx` import should land as a SPREADSHEET rather than guessing
a column model — which is what `CellOverride.xlsxF` (the formula kept verbatim
because dash cannot place it in a column model) has been evidence of all along.

Full design: `docs/dash-sheet-kinds.md`. Not built.

## dash: one view vector, read by everything that describes the view

2026-08-11. Filtering and sorting write `store.order[sheetId]` — an index
vector, view state, no checkpoint and no op, so they never dirty the file.
Three surfaces described that view and only one read the vector.

Measured on the starter workbook, filtered to deals over £10,000: the grid drew
four rows worth £69,050, the footer said £97,050 in bold underneath them, the
chart drew a third bar for two of the removed rows, and the status bar said
"4 of 8 rows" — right, until anything else changed, because `showView()` had a
single caller inside the filter menu.

THE RULE: anything that describes the view reads the same vector. `aggregate`
(grid.ts) takes it, `optionFor` (chart.ts) takes it as a row index list, Find
walks it, and `viewStatusText` is derived from it in grid.ts because the grid
owns the view. `applyView()` is the funnel every path already goes through —
sort, filter, clear, sheet switch, structural edit — so it announces.

A SORT MUST NOT MOVE A TOTAL and a FILTER MUST. A sort permutes the vector, so
summing through it is unchanged; a filter shortens it. Both are guarded, and
the sort case is the one worth having a test for, because getting it wrong is
invisible.

Excel agrees, which was discovered afterwards and is reassuring rather than
load-bearing: a table's totals row is `SUBTOTAL(109, …)`, and `SUBTOTAL` ignores
rows a filter has hidden.

## dash: the chart is pinned to the sheet it was made from

2026-08-11. A chart is an argument about one table — `StoryStep` already
carried `sheet` beside `chart` for that reason. It does not follow the tab bar.
Reading `grid.sheet` instead left the previous sheet's chart painted beside the
new grid, and the next edit redrew it as an empty axis against columns that had
never existed on the sheet in front of the reader.

It names its sheet in the heading when that differs from the one on screen, and
offers to re-bind rather than re-binding itself: a silent re-bind changes what
the chart asserts without anyone asking, which is the same failure as
staleness. If its sheet is deleted the panel closes rather than holding numbers
about nothing.

The cause of the filter half is worth recording separately: filtering emits
`view`, never `doc`, and only `doc` was listened for. That is not a chart bug,
it is what happens when view state is invented later than the listener.

## dash: sheet tabs at the bottom, and reorder is a patch

2026-08-11. Sheets moved from a list in the left properties panel to a tab
strip along the bottom edge. The panel existed only for that list, so it is
gone and the grid is ~200px wider at every size.

Sheet order is TAB ORDER and it lives in the document, so a reorder is an
undoable patch whose inverse carries the ORIGINAL index — one undo returns a
dragged tab to where it was, not to the end. Reorder is implemented on mouse
events rather than HTML5 drag-and-drop, which is untestable without a real
mouse and dead on touch; `Move left` / `Move right` in the context menu give
touch and keyboard the same operation.

The active tab carries ONE mark: a 2px rule in the ink colour. It first shipped
with four — rounded corners, a border, a 3px amber bar and a heavier weight —
because each had been added to satisfy a contrast measurement and none was
removed afterwards. The brand amber is 2.02:1 on white and cannot carry a
non-text indicator alone, which is what forced the props. Ink is 14.51:1 light
and 13.75:1 dark, so one mark suffices. Amber stays on things about the
DOCUMENT: the unsaved dot, a filtered column header. A tab is navigation.

## dash: Find searches the file, because the grid is a window onto it

2026-08-11. About forty rows of a 5,000-row sheet exist in the DOM. Measured:
`document.body.innerText` holds 1,528 characters for 20,000 cells, and Chrome's
own `window.find('Customer 5000')` returns FALSE for a value plainly in the
file. So the browser's find is not merely unhelpful here, it is WRONG with the
browser's authority behind it, and that is what earns dash the right to take
⌘F. Where the grid is not painted — the dashboard — the key is given back,
because there the browser can see everything and taking it would be a downgrade.

Matching runs over BOTH the displayed text and the stored value, and the hit
records which matched. That is not cosmetic: `12,400` and `£` exist only in the
rendering, `12400` only in the file, and which one matched decides whether
Replace may touch the cell. A match found only in the formatted text is refused
and counted, because there is no defensible way to push a substring of a
rendering back into a number.

Hits walk the VIEW VECTOR, so a find never jumps to a row the filter is hiding,
and Replace patches are keyed by RID so a filter cannot re-target a write.


### Correction, same day: the spreadsheet kind already existed

The entry above proposed `kind: 'grid'`. Wrong — `CanvasSheet` is the
spreadsheet kind and has been in the format since commit one, deliberately:
"the classic sparse A1 map… in the format from commit one, because an escape
hatch added later is permanently second-class (PLATFORM §3)". It carries the
sparse cell map, per-cell value and formula, column widths and row heights, and
per-cell colour/background/bold/alignment — which also answers the "no cell
formatting at all" gap for that kind.

So the decision stands and the model change is nil: `table` is the dataset,
`canvas` is the spreadsheet, and the work is implementation, not format. Adding
a third kind would have left two half-built spreadsheet kinds. "Canvas" stays
the wire word; the label a reader sees is "Spreadsheet".
## 2026-08-15 — The sync engine's shape gains a text property, and children become optional

**Context.** `DocShape` described a document as two levels — `parents` holding
`children` — and hard-coded `'html'` as the property carrying collaboratively
edited text. Both shipped apps fit: a slide holds elements, a page holds
blocks, and in each the text is on the child. bento/type fits neither. Its
`body` is a flat list of blocks, a block IS the paragraph, so its text sits one
level up and there is nothing beneath it to point `children` at.

**Decision.** Two additive changes to the shape, both proven byte-identical for
existing files by `scripts/test-sync-equiv.ts`:

1. `DocShape.text` names the property that gets the token RGA. It defaults to
   `'html'` in `shape()`, so slides and spaces are untouched.
2. `DocShape.children` may be `null`, meaning a FLAT document with no element
   layer. `C()` then reads as a frozen empty array and the differ never mints
   an element op; `applyEffect` drops an element-scoped op that arrives anyway,
   because it has nowhere to land.

`shape('body', null, 'text')` is type's binding.

**Why the text property had to be named rather than inferred.** It is the one
property whose merge behaviour decides whether two people can type in the same
paragraph at once. Everything else is a last-writer-wins register, which for
prose means one author's work disappears — and disappears SILENTLY: the
document stays valid, the replicas converge, and the result simply contains one
of the two edits. There is no error to notice.

**That failure mode is why two new rigs exist.** The four existing sync rigs
stayed green through every step of this change, including through a real bug —
none of them declares text anywhere but on a child, so none of them exercised
the new path at all. Green there means "nothing broke", never "the new thing
works".

- `scripts/test-sync-parent-text.ts` isolates ONE variable: text on a parent,
  children still present. It carries a **negative control** — the same scenario
  with the RGA off must lose an edit — because a rig that has never been seen
  failing is not a gate.
- `scripts/test-sync-flat.ts` binds type's real shape. Besides convergence it
  asserts the document keeps its SHAPE: an engine that quietly wrote
  `elements: []` onto every block would converge perfectly and still corrupt
  the format, so that is checked directly rather than inferred from
  convergence.

**Two bugs found this way, both invisible to the existing suite.**

- Making `text` configurable, the CONDITIONS were rewired to `S.text` while the
  OPERANDS stayed hard-coded — `diffText(id, bp.html, ap.html)`, the
  materialize write-backs, and four register keys built as `` `${el} html` ``.
  Every one is correct while `S.text === 'html'` and wrong for any other app.
  Grepping for `.html` does not find the register keys; they are template
  strings.
- The flat-shape guard read `op.el` as "this op is element-scoped". On a `txt`
  op `el` is the NODE key, which for a flat document is the block's own id — so
  the guard dropped every collaborative keystroke type would ever send, while
  structure ops kept converging. One author's edits landed and the other's
  vanished.

**A trap for whoever tests this next.** Two fixtures here read correct
behaviour as a bug: both minted an op, never delivered it, then delivered a
later one and found it had no effect. That is the per-actor sequence guarantee
holding the second op in the gap buffer, exactly as designed. Deliver the whole
sequence.

**Not done here.** type's session/transport layer is still slides-shaped
(PLATFORM §9), so this makes type's collaboration possible, not present.

## 2026-08-15 — bento/type's sync binding, and doc-level maps become a shape field

**The binding.** `type/src/sync/crdt.ts`, a facade like the other two apps':
`shape('body', null, 'text', ['footnotes'])`. It is the first FLAT binding and
the first whose text is not on a child; both were kernel changes made earlier
the same day, not things this file works around.

**Doc-level maps are now declared by the shape.** `assets` and `blobs` were
hard-coded as per-KEY registers, with the right reason attached: two people
adding different assets concurrently must both keep theirs. Any id-keyed map
wants that, and an app could not ask for it while the names were baked in.
`DocShape.maps` now names them; `shape()` unions the caller's list with
`assets`/`blobs` so an app declaring its own cannot accidentally drop those.

type's `footnotes` (note id → note text) is such a map. As one whole-value
register, two authors each adding a footnote kept both REFERENCES — those live
on different blocks and merge independently — while one of the two BODIES was
overwritten, leaving a marker in the text pointing at nothing.

**Measured, not argued.** Over 120 seeds × 60 steps × 3 actors:

| | before | after |
|---|---|---|
| seeds with a dangling note | 34 | 5 |
| seeds with any format violation | 30.8% | 7.5% |

**What the rig reports rather than asserts.** A block's `text` merges token by
token through the RGA, while its `marks` and `notes` are CHARACTER OFFSETS into
that text and merge as ordinary registers. Two independent merge domains
describing one paragraph — the same shape of problem `parent`-versus-position is
for bento/spaces, and like that one it is a format-level decision rather than a
bug to patch inside a rig. At 400 seeds × 80 steps × 4 actors (19,016 ops),
11.8% of seeds converge on a document with at least one violation.

The rig carries a worked example, because a percentage is not an account of
what goes wrong. Both authors insert text BEFORE a bold phrase and both shift
their own marks correctly with the app's `spliceText`:

```
merged text: "Notwithstanding the above, Under clause 4, Payment is due within 30 days."
bold covers: "t is du"   (it should cover "30 days")
```

Neither replica ever held the correct offset — it is shifted by BOTH insertions
— so no register winner could have been right. `STRICT=1` turns the report into
a gate the day the decision is taken.

**Two smaller findings, named so they are not rediscovered as bugs.**

- Concurrent deletion can empty `body` entirely (4 of 400 seeds). A document
  with no blocks is not one the editor should ever present.
- The residual dangling notes are the same cross-domain split one level up: the
  REFERENCE is a block property and the BODY is a map entry, so deleting a
  footnote concurrently with editing its paragraph can keep one and not the
  other.

**Convergence itself is compared by VALUE, not by `JSON.stringify`.** A property
deleted and re-added moves to the end of its object, so replicas that applied
the same removals in a different order hold equal documents with different key
order — 288 of 400 seeds, every one spurious. Checked rather than assumed
before relying on it: canon.ts sorts keys (RFC 8785 §3.2.3), so two blocks
differing only in key order produce the same signing digest, and the redline
aligns on block id.

**Not done here.** The session and transport layer is still slides-shaped
(PLATFORM §9). type has a converging engine, not live collaboration.

## 2026-08-15 — The sync session and transport move to the kernel, behind a five-method host

**Context.** `crdt.ts` was kernelized and parameterized by document shape, but
the layer above it — the session (differ hook, shadow, presence, catch-up, gap
recovery, blobs, the fork snapshot exchange) and the online relay transport —
still lived in `slides/` and was slides-shaped. bento/dash had already responded
by PORTING `online.ts` wholesale (`dash/src/sync/online.ts` still says so in its
header). A second copy of the transport is a second thing to fix when the relay
protocol changes, and the relay is the part that must not fork.

**What actually coupled the session to slides.** Of 727 lines, FIVE places knew
what a slide was: repairing an emptied document, clamping the view, pruning a
selection, saying where a person is for presence, and recognising embedded media
in a refused batch. `online.ts` had exactly ONE: the hard no-network switch.
`blobs.ts` had none and moved untouched.

**Decision.** `kernel/src/sync/{session,online,blobs}.ts`, with apps supplying a
`SyncHost`: `heal`, `clampView`, `presence`, the store event names, a
`carriesMedia` probe, and the shape-bound engine class. `slides/src/sync/*.ts`
are facades, so `new SyncSession(store)` still works everywhere it already did.
bento/type gets one too, and needed no kernel changes to do it.

**Test first, and this time literally.** The session had NO tests. Moving
untested code across a seam is how behaviour changes silently, so
`scripts/test-sync-session.ts` was written against the implementation AS IT
SHIPPED, run to 13/13, and then run UNCHANGED after the move — same 13/13,
including the same merged string from a concurrent text edit. It drives the real
session over the real store through a real BroadcastChannel; two sessions in one
process are two tabs of one document, which is the transport that ships.

**Running app source in node needed a hook, and that was the right trade.**
`scripts/lib/ts-resolve-hooks.mjs` resolves Vite-style extensionless imports and
transpiles with esbuild — Node's built-in TypeScript is strip-only and rejects
`constructor(private store: Store)`. The alternative was editing session.ts to
drop the parameter property, which was rejected on principle: a rig that exists
to prove behaviour is unchanged cannot start by changing its subject.

**Two decisions inside the move worth keeping.**

- The offline switch is INJECTED (`setOfflineCheck`) and the kernel default is
  OFFLINE. Defaulting the other way means an app that forgot to wire it starts
  phoning home silently, which is the one failure this project should never
  ship.
- `PresenceInfo.slide` keeps its name on the wire. It now means "where this
  person is" — a block id for type — but deployed clients and the relay read
  that field, so renaming it would fork presence.

**bento/type now has live collaboration end to end**, proven through the store,
the differ, the debounce, a real channel and back:

```
two people typing in one paragraph:
  "Payment is due within sixty (60) days of invoice."   ← both edits survived
```

Its host also pins a word-processor-specific rule the kernel could not know: a
remote edit arrives through `Store.touch`, never `commit`, so it never lands on
this person's undo stack. ⌘Z means "undo what I did" — a remote paragraph
arriving as a commit would make it revert a colleague's work and redo would
bring it back as if it were yours. The rig proves a local edit DOES push a step
before claiming the remote one does not.

**Not done here, and one correction.** bento/spaces has no session binding yet;
that one IS small, a host adapter over a store that already has on/emit/commit.

bento/dash is NOT. An earlier draft of this entry said dash needed "just a host
adapter"; that was wrong, and `dash/src/sync/crdt.ts` is why. Its 2,313 lines are
not a fork of the kernel engine but a DIFFERENT one, built for spreadsheet scale
— sparse per-row state so an untouched row costs zero bytes in `collab.sync`,
run-length order lists, O(inserts) rather than O(rows), sheet-scoped column ids.
The kernel engine would put O(rows) of state in the file. Merging those is a real
design question, not a refactor, and nothing here should be read as having
settled it. `scripts/test-dash-sync.ts` (23,100 checks) exercises dash's engine,
not the kernel's.

What is plausibly shared is dash's `online.ts`, whose own header calls it "A PORT
of slides/src/sync/online.ts". That is the RELAY protocol, which is the one part
that should not fork — the deployed worker verifies signatures and the
invite/member chain against it. It already imports kernel storage and update.
Left alone pending the dash session's answer on whether it is deliberately
diverged.

## 2026-08-15 — `changeEvents`: the kernel session stops assuming one app's event names

**What was wrong.** The kernelized session fired `store.emit('doc')` after every
remote change. In bento/slides `'doc'` means "something changed, repaint", so
that read as universal. It is not. In bento/spaces the store emits four events
and `'doc'` is the DIRTY/STATUS signal — repainting goes through `'tree'` and
`'page'` — so a remote op would have labelled a colleague's edit "Edited" in this
user's chrome and moved their dirty flag. The kernel had shipped one app's habit
as a default, in the very seam built to stop that.

**Decision.** `SyncHost` names both sets:

```ts
readonly changeEvents: readonly string[]     // after EVERY remote change
readonly structureEvents: readonly string[]  // extra, on a structural one
```

slides and type declare `changeEvents: ['doc']`, so neither changed. An app that
wants no always-on event declares `[]`.

**How it was found, which is the part worth keeping.** Not by a test — by the
bento/spaces session reviewing the interface before building against it. It also
caught three things in a spaces adapter this session had drafted: a `heal()` that
minted the repair page with a random id (two replicas healing concurrently would
create two pages and the CRDT would faithfully keep both — the fix is to derive
the id from `docId`), a view clamp that fell back to the home page rather than to
the deleted page's PARENT, and a `carriesMedia()` that re-decided a question
already settled by "Large assets travel out-of-band; the relay stays blind"
(2026-07-25).

The draft was deleted and `spaces/src/sync/session.ts` left to that session,
which holds context this one did not have — including a user decision taken this
week and not yet written down: a space does not auto-connect on open. The
"obvious" call there is auto-connect, and it is the wrong one; it would reproduce
the v0.9.1 regression where every anonymous visitor to the demo phoned home.

**The general lesson.** A seam is not proven by the app that shaped it. Both
defects here were invisible from bento/slides and bento/type, because both put
their text on a child, both call their repaint event `'doc'`, and both were
written by the same session. The third app is where the assumptions show, and it
is cheaper to ask its owner than to discover it after the room exists.

**Two changes left in the spaces zone**, both offered for revert: `Store.reindex()`
is now public (a remote apply writes straight to `doc`, bypassing commit, so
nothing else rebuilds the derived index), and `SpacesDoc.collab` is typed
`CollabCreds` instead of `unknown` — it was marked RESERVED "unused until collab
ships", and it ships. That type moved to `kernel/src/sync/crdt.ts` beside
`SyncStateJSON`, so a document-format type is not reachable only through the
session: the deployed relay verifies against that shape, and a second local
description of it is how a client and the worker drift apart.

## 2026-08-15 — Known gap: the moved sync modules still hold raw network primitives

**Recorded because it is security-relevant and easy to lose.** The session/
transport lift relocated four raw network calls into `kernel/src/sync/`:

```
kernel/src/sync/online.ts   new WebSocket(...)      the relay socket
kernel/src/sync/blobs.ts    fetch() × 3            blob HEAD, upload, download
```

They are not new — `git show HEAD:slides/src/sync/blobs.ts | diff -
kernel/src/sync/blobs.ts` is IDENTICAL, and online.ts differs only in imports and
type names. The lift created none of them. What it did do is move them out from
under the paths that PR #305 targets — the fix for a privately reported advisory
(GHSA-5c3x-xqp6-g94r) where offline mode leaked from five places — so they are
now just as reachable and no longer in the diff that was under review. The bypass
is unchanged; the move made it easier to miss. That is the reason this entry
exists rather than a chat message.

**The fix, not applied here because `kernel/src/net.ts` does not exist in this
tree yet:** once #305 lands, `import { netFetch, netWebSocket } from '../net.ts'`,
swap the four call sites, and add the retry guard so a refused connection does
not spin against the switch:

```ts
} catch { if (!offlineEnabled()) this.retry(); return }
```

Writing that against an interface not yet present would have been guessing.

**A second call site that is invisible from `slides/`.** `kernel/src/sync/
online.ts` now imports `offlineEnabled` from `../update.ts` directly. (An
injection point was built for it and removed once `offlineEnabled` turned out to
already be in `kernel/src/update.ts`.) If #305's re-export from `update.ts` is
ever dropped, this breaks as a typecheck failure rather than a silent bypass —
but `scripts/test-offline.ts` would not catch it either way: that rig enforces
who may touch the PRIMITIVES, not who reads the SWITCH.

**The four above are NOT the whole defect.** #305 is broader: a single chokepoint
at `kernel/src/net.ts`, plus `render.ts` remote images (`remoteSrcBlocked`), and
dash. And the same hole was found independently from the opposite direction while
auditing the pack channel for an extensions question — `slides/src/packs.ts`
never consults `offlineEnabled` at all. Verified here rather than taken on
report: `grep -c offlineEnabled slides/src/packs.ts` → 0, against THREE reachable
network paths — `fetchPinned` (:133), a bare `fetch` HEAD probe (:141), and the
listing fetch in `fetchIndex` (:228). Meanwhile `docs/security.md:140` publishes
the claim that with offline on "you can watch the network tab stay silent". For
the pack channel that is currently false.

Scoped precisely, because an earlier draft of this entry overstated it as firing
"from the moment the listing loads": `fetchIndex` has two callers and NEITHER is
at boot — `availablePacks()` (editor.ts:1342, the Manage languages dialog) and
`refreshPacksForVersion()` (i18n.ts:76, via registerUpdatePrepare). So opening a
deck offline does not hit the network from this path. The honest statement is
"from the moment the pack UI is opened". Whether the second caller is reachable
in offline mode depends on gating in the update path that nobody has traced, and
is left as an open question rather than a claim — it is moot if everything routes
through `net.ts`, which is the argument for the chokepoint.

Two people finding the same hole from unrelated directions is some corroboration
that the advisory is real and aimed at the right place. It also means the
DECISIONS entry merged as 5eaccf8 UNDERSTATES it: that entry describes the
packs.ts symptom, not the missing chokepoint. Cite it with that in mind.

**A separate defect in the switch itself, verified while checking the above.**
`offlineEnabled()` (kernel/src/update.ts:43) reads `lsGet('bento-offline') ===
'on'`, and `lsGet` swallows its own failure and returns null. Note where the bug
actually is: `offlineEnabled` HAS a `try/catch` returning false, and it is DEAD
CODE — `lsGet` never throws, so the catch never runs and the gate fails through
`null === 'on'` instead. The defence looks present and is unreachable, which is
why reading the function alone does not reveal it. So where storage is
unavailable — Safari private browsing, a blocked file:// context, an opaque
origin — the gate answers ONLINE. The UI diverges rather than agreeing with it:
editor.ts:2871 seeds the checkbox from `offlineEnabled()` once, then :2873 calls
`setOffline(offCb.checked)`, whose write also swallows failure. Tick the box in
that context and the checkbox stays visibly ticked while the gate keeps answering
online, until something rebuilds the dialog. A security control that reads ON and
behaves OFF is worse than one that refuses to turn on. (Found by the bento/dash
session auditing against #305; confirmed here by reading both call sites.)

**FIXED by #305, merged as 759fb93 — verified rather than assumed after this
entry claimed otherwise.** The gate is now `sessionOffline ?? lsGet(...)` with the
in-memory value winning, `setOffline` RETURNS whether the write persisted, and the
dialog surfaces the failure. It still cannot persist across a reload where storage
is unavailable — `sessionOffline` is module state — but it no longer claims to,
which is the right shape for the constraint. `offlineEnabled`/`setOffline` moved
from `update.ts` into `net.ts`, with `update.ts` re-exporting them, so the
kernel's sync import keeps working.

**Why that fix is immune rather than lucky**, which is the transferable part: it
replaced the gate's SOURCE OF TRUTH, not its error handling. Hardening the
`catch` would have changed nothing, because the catch was never the path taken.
A defence that sits on the error path cannot protect a function that fails
without erroring.

This entry originally said the chokepoint would not fix it ("net.ts will
faithfully consult a gate that is lying"). That was true of the chokepoint IDEA
and false of the actual diff, which fixes both halves. The observation is still
the useful one — centralising call sites is not sufficient when the thing they
consult can lie — but it was already addressed, and recording a fixed defect as
outstanding is its own kind of error.

**Ordering, as it actually resolved.** #305 landed first (759fb93), which was the
right sequence: a security fix should not wait on a refactor. The kernel lift
takes second and applies the four swaps to the moved copies.

That integration is NOT a small apply, contrary to an early estimate from both
sides. Measured from this tree — and these numbers DRIFT, because origin/main
moves while the work sits uncommitted: they went from 13 commits and 69 upstream
files to 14 and 79 during a single conversation. Base 89b4462, 14 commits behind
origin/main, 28 uncommitted files here against 79 upstream, with six overlapping —
`.github/workflows/ci.yml` and `docs/DECISIONS.md` (append vs append),
`kernel/src/theme.ts` (another session's file, now also upstream), and the three
`slides/src/sync/*` rename-vs-modify pairs.

A shortcut was considered and rejected: writing `git show 759fb93:kernel/src/net.ts`
into the tree to unblock the swaps would produce a tree that is post-#305 in one
file and pre-#305 in sixty-eight, where the first failure is unattributable.

**The lift WILL fail CI on contact, by design.** `scripts/test-offline.ts` scans
`['kernel/src', 'slides/src', 'dash/src', 'spaces/src']`, so the four relocated
primitives are in scope the moment the integration lands — 3 in
`kernel/src/sync/blobs.ts`, 1 in `kernel/src/sync/online.ts`. That is the rig
working: the swaps are not optional cleanup, they are what makes the build green.
`netWebSocket(url)` returns a genuine `WebSocket` (not a proxy), so `binaryType`,
the four handlers and `.close(code)` are unchanged; the only behavioural
difference is that it THROWS `OfflineError` when the switch is on, which is why
the call site needs `if (!offlineEnabled()) this.retry()`.

**`type/src` was not in that scan list**, so bento/type — a fourth app with a
model, store, editor, pagination, signing and now a sync binding — was silently
exempt from the policy. It has no network path today (verified: zero matches for
all five primitives), which is precisely why it was worth raising while the fix
could not fail.

The fix taken was better than the one proposed, and the argument for it was in
the complaint. Adding `'type/src'` to the array fixes type and leaves the NEXT
app — and the next app is by definition the one nobody is thinking about. So the
list became DISCOVERY: any top-level directory containing `src/` is in scope, and
an app joins the policy by existing (slides #307). Discovery has its own failure
mode, and it is this rig's own lesson one level up — a green run over an empty
list is indistinguishable from a green run over the whole repo — so it asserts
that discovery still finds the known apps and does not sweep in non-app
directories.

The general form is worth keeping: **an exemption list is a latent violation with
a date on it.** When the answer is "add ourselves to the list", check whether the
list should exist.

**`kernel/src/theme.ts` is a shadow, not a member of this change set.** It sits
untracked in the shared checkout and shows up in every overlap measurement, which
made it look like an orphan needing an owner. It is not: it is byte-identical to
`origin/main:kernel/src/theme.ts`, shipped in #285, and imported upstream by
`slides/src/editor/editor.ts` and `slides/src/main.ts`. Nobody needs to adopt it.

It cannot simply be deleted from this tree today, because this tree's base
(89b4462) PREDATES #285 — so the untracked copy is the only copy here, and
`type/src/main.ts` imports it. Delete it now and bento/type stops building;
delete it after the rebase and nothing happens, because the tracked file takes
over. So: keep it until the rebase, drop it as part of the rebase, and do NOT
commit it — committing would add a file that already exists upstream and
manufacture a conflict out of nothing.

The general trap: an untracked file that is byte-identical to a tracked one
upstream is invisible to every tool you would reach for. It does not appear in
`git diff`, it survives `git checkout`, and it makes a file look present at a
commit where it is absent. Two separate sessions reasoned about this one wrongly
in opposite directions — one concluded it was an unowned orphan safe to remove
(it is neither), the other that a downstream app depended on it and therefore
owned it (it depends on it, but does not own it).

The actionable rule, which is narrower than the trap and is what either of us
needed: **search the REF, not the working tree.** Every observation behind the
wrong conclusions was TRUE of a checkout based at 89b4462 and FALSE of main — at
that base slides genuinely does not import the file and the file genuinely is
untracked, because the base predates #285. `git grep kernel/src/theme origin/main`
is one command and shows the two slides importers immediately. A working tree
held at an old base is not a view of the project; it is a view of the past, and
"I checked" means nothing without saying checked against WHAT.

(A matching blob is also weaker evidence than it looks: it says two commits
contain the same content, not that one came from the other. The `slides-theme`
branch shares this file's bytes and never merged; the content reached main by a
different PR.)

One trap worth recording for anyone verifying this: local `main` was 802804b and
STALE — #305 is on `origin/main`. Checking against `main` reports `kernel/src/
net.ts` as absent and the slides sync files as unchanged, i.e. that #305 never
landed. Compare against `origin/main`.

---

## 2026-08-14 — a self-update must not be the one save that interrupts

**Reported against 1.0.16**, with tray/webext installed and a folder granted:
⌘S saved with no dialog, and then "Update this file" put up a macOS save panel
for `Tray_Test.v1.0.16-backup.bento.html` into ~/Downloads.

The update itself was fine — it had rewritten the file in place, silently,
through the extension. The dialog was the ROLLBACK COPY, which `applyUpdateInPlace`
handed to `downloadFile`, and downloads prompt for anyone with Chrome's *"ask
where to save each file"* enabled. So the flow's only interruption was for a
file the author never asked for, in the middle of the one operation whose whole
selling point is that it does not interrupt.

Two things were wrong, and only the first was visible.

**A backup belongs beside what it backs up.** Even silent, ~/Downloads is the
wrong place: detached from the document, one per update, and a rollback you have
to go hunting for is a poor rollback. With a host, it now goes in the folder
already granted, next to the original. Without one it is still a download —
the alternative there is a picker, which is strictly worse than the status quo
for the majority case, and the majority case is no extension at all.

**The no-handle path was declaring the wrong intent.** `writeUpdatedFileAs`
hard-coded `share`, so a document opened by double-clicking — no handle, the
ordinary case — told every host "a new file the author will choose" about a save
that is overwriting the document on screen. The host correctly declined and the
author got a picker. Same class as the 2026-08-02 finding that produced
`pickerIdFor`: intent has to be explicit in the call, because it cannot be
recovered from anything else in it. `applyUpdateInPlace` now sends `in-place`,
and `canUpdateInPlace` stops meaning "we hold a handle" — a host needs none.

**Hosts announce capabilities, not presence** (`window.__bentoHost.ops`,
`save.ts hostCan`). Presence is not a useful question: `showSaveFilePicker`
exists in Chrome regardless, and a host that declines looks exactly like one
that is absent. A host that announced itself but did not know `bento-backup`
would have passed the request to the native picker — producing the very dialog
this removes, and only for the people who installed the thing meant to remove
it. Decks and hosts version independently in both directions.

**The new op is the only one that creates a file**, so it is the only place the
page contributes to a name. Held down from both ends: the name must be visibly
derived from the sender's own (`backupNameFor` — no separator survives, and it
may not equal the original), and an existing file is never overwritten. The
directory comes from the sender's resolved path, never the payload. Worst case
for a hostile document is one predictably-named copy of ITSELF inside a granted
folder.

**Guards.** `scripts/test-savepurpose.ts` pins the update path's purpose (both
new assertions verified to FAIL against the previous commit — a gate never seen
failing is not a gate). `scripts/test-webext-background.ts` covers the name
rules, create-only, the nested-directory case, and that every refusal applying
to a write applies to a backup. `scripts/test-webext-bridge.ts` covers the
announcement, that a page cannot forge it, and that a backup never reaches the
native picker.

*Found while fixing this:* the bridge rig stubbed `Blob` as `class {}`, which
satisfied the `instanceof` branch but has no `.text()` — so every `close()`
rejected and the half of the bridge that actually sends bytes had never been
exercised, across 24 green checks. Mocks shaped to make a test pass test the
mock.

---

## 2026-08-14 — resolve by route, not by search (and the grant lapses every restart)

**MEASURED, on the reporter's machine:** a `showDirectoryPicker` grant survives
service-worker eviction, but Chrome drops it to `prompt` when the browser
restarts. The HANDLE survives in IndexedDB — the options page still knows the
folder's name — so only the permission is gone, and `requestPermission()` on the
held handle takes it back with one confirmation. That must run on an extension
PAGE (it needs a user gesture; the worker has none), which is what the
per-folder **Renew** button is.

**That "one click per browser session is the ceiling" — WRONG, corrected the
same day.** The claim was that Chrome's persistent File System Access
permissions are scoped to installed web apps, so a pure extension could never do
better. Then the reporter screenshotted the actual dialog, on
`chrome-extension://…/src/options.html`, and it offers three buttons: *Allow
this time*, **Allow on every visit**, *Don't allow*. Persistent permission IS
offered to an extension origin.

The lesson is the one this log keeps relearning: I reasoned about a permission
UI from documentation instead of looking at it, and stated the conclusion firmly
enough that it nearly settled a distribution decision — native messaging, a
signed binary per platform — that may not be needed at all.

**MEASURED 2026-08-14, and it holds: "Allow on every visit" SURVIVES a full
browser restart** for an extension origin — quit Chrome, reopen, the folder
still saves in place with no renewing. So the grant is once and for all, and
native messaging is moot. The distribution model stands: install from the Web
Store, grant a folder, done.

What is left is not a permission problem but a DISCOVERY one, and the two failure
directions are unequal. Choosing "Allow this time" costs a re-grant every
session and never says so; choosing "Allow on every visit" costs nothing. So the
extension names the button, and the first grant is the only moment anyone should
have to think about it.

The dialog can only be raised from an extension PAGE with a user gesture —
`requestPermission` needs the gesture, and the service worker has none. A deck
is a `file://` page in another origin that cannot hold the handle at all. So
"raise it from where the user is" is not available; the best reachable is to put
the button where the user already is when it matters (the toolbar popup), and to
make a lapsed grant VISIBLE before a save fails rather than after.

**Resolution no longer searches.** A `FileSystemDirectoryHandle` knows its name
but not its path, so the host walked the granted tree matching filenames —
depth-capped at 4, declining whenever two files shared a name. But a directory's
NAME must appear in the path of every file inside it. So the name locates the
split point in the sender's path and the rest is a route: `getDirectoryHandle`
per segment, then `getFileHandle`. Measured: a file inside a 500-entry grant
resolves with ZERO directory scans.

That one change is what makes the rest possible:

- **any grant size.** A home directory costs what a decks folder costs, so
  "grant everything" stops being a performance question.
- **several grants**, since each attempt is a few lookups. The store holds a
  list (`dirs`); the old `dir` key is still read so an upgrade does not silently
  drop the folder someone already granted.
- **two documents sharing a filename stop being ambiguous** — a BEHAVIOUR
  CHANGE, and the old decline was a limitation rather than a safety property.
  Only one route leads to one file. Anyone with per-client folders hit the old
  decline on every save.

The route is checked, not guessed: a wrong split point fails at the first
missing segment, and `resolve()` re-verifies what it landed on against the
sender's path regardless. A grant covering a home directory raises the cost of a
resolution bug, so that check matters MORE now, not less.

**A file reachable through two nested grants is one file, not an ambiguity** —
`isSameEntry` decides, since it is the only thing that can tell "same file, two
routes" from "two files, same name". Two genuinely different files reachable by
the same route still decline.

**A lapsed grant is reported distinctly from a missing one**, and only when NO
grant could serve the file — with several folders, one lapsing must not mask the
others, and the two need opposite things from the user: one click, or a folder.

**Guards.** `scripts/test-webext-background.ts` (57 checks): per-grant
resolution, the lapsed-among-healthy case, nested grants, two-different-files,
and a 500-entry grant asserting `enumerations === 0` — the last is the one that
would catch a silent return to searching. Plus a source-level gate that
`background.js` and `status.js` agree on the database, store and keys: they open
IndexedDB independently and cannot be loaded into one realm, so drift would mean
the options page writes grants the worker never sees — UI green, every save
prompting, nothing reporting a fault.

*Found in passing:* the rig carried a LITERAL NUL byte in a test case, which
made `grep` treat the whole file as binary and hid it from ordinary tooling. It
is now written as a `\x00` escape.

*Amended 2026-08-16:* and then **this file caught it** — the sentence above
shipped with a literal NUL where it says `` `\x00` ``, so `grep` treated
DECISIONS.md as binary and returned nothing, silently, for every query. That is
the worst possible file to lose to this: `CLAUDE.md` tells every agent to read it
before non-trivial work, so a silent no-match reads as "no prior decision" and
invites the contradiction the log exists to prevent. Found by a `grep` for a
heading that was demonstrably present. If you are describing a control character,
escape it.

*Amended 2026-08-14, later.* Two corrections to the entry above, both from
looking rather than reasoning.

**`chrome://settings/content/filesystemwrite` does not exist.** I put it in the
options page and in STORE.md without visiting it. Chrome's documented ways to
withdraw File System Access are the address-bar icon's *Remove access* and a
per-site *File editing* list reached from it — both part of the site-settings
surface for a website origin. That surface is NOT offered for
`chrome-extension://` pages: the chip there reports only "You're viewing an
extension page". Chrome's own write-up demonstrates the feature on vscode.dev
and does not mention extension origins at all.

So there appears to be **no user-facing control to revoke File System Access
granted to an extension origin**, and reinstalling does not clear it either —
an unpacked extension's id comes from its directory path, so re-loading from the
same path returns to the same origin, still granted. A different path is a
different id and a clean slate.

**And "Remove only forgets the folder, it does not revoke" was wrong** — the
pessimistic direction, but wrong. The permission is not the capability; the
HANDLE is. With no handle stored there is no object to write through, and
another can only come from the user picking a folder. Deleting it takes the
access away for real. Chrome's remembered permission means only that re-picking
that same folder may not ask again.

Which settles where this leaves the product: **the extension's own folder list
is the only place access can be withdrawn**, so it is not a convenience — it is
the control, and it says so on the page. A reviewer will ask; STORE.md answers
it in those terms.

Three wrong claims about browser behaviour in one day (persistent permissions
scoped to installed apps; a settings URL; Remove not being a revoke), each
stated confidently from documentation or memory, each disproved by one
screenshot. The rule that keeps being relearned: a claim about a browser UI is
worth nothing until someone has looked at that UI.

---

## 2026-08-14 — "Don't allow" is a one-way door, and the prompt can be embargoed

Reported: after choosing **Don't allow** on the reconnect prompt, the folder
grant lapsed on every browser restart AND the dialog stopped appearing at all.
Read out of the Chrome profile (`Profile 1/Preferences`), two independent things
had happened, neither of them a recorded "block":

**1. The granted folders were DELETED.** `file_system_access_chooser_data` for
the extension went from two directories with paths to `"chosen-objects": []`.
The extension's stored handles survive in IndexedDB, but they now refer to a
grant Chrome no longer has, so there is nothing for `requestPermission` to
restore.

**2. The restore prompt is EMBARGOED.**

    permission_autoblocking_data → FileSystemAccessRestorePermission
      { "dismiss_count": 3, "dismissal_embargo_days": … }

Chrome's permission auto-blocker suppresses a prompt after three dismissals.
`permission_actions_history` is empty and `file_system_write_guard` holds no
BLOCK — the silence is purely the embargo. `requestPermission` returns without
showing anything, so the button appears to do nothing, permanently.

**Neither is reachable from Chrome's UI**, for the same reason the persistent
grant was not: these live in their own stores, not in the content-setting
exceptions the settings page renders.

### What this changes in the product

**A Renew button is a loaded gun.** Every prompt the user dismisses counts
toward the embargo, so a UI that encourages clicking it — a notification, say —
makes the dead end easier to reach. Three impatient dismissals and saving
silently stops working.

**Re-picking is the escape, and it is a DIFFERENT permission.**
`showDirectoryPicker` is a user-initiated chooser, not a restore prompt, so it
still works under embargo and re-creates the chosen-object. So a failed renew is
not an error to report — it is the signal to ask for the folder again. Both the
options page and the popup now detect a renew that restored nothing and say so,
rather than reloading into an unchanged list, which reads as a broken button and
invites exactly the extra dismissals that cause the embargo.

**This is the strongest argument yet against raising prompts on our own
initiative.** Nothing may open the restore prompt except an explicit user click,
and the copy has to be clear enough that the click is deliberate — because the
cost of a careless dismissal is not a retry, it is the feature.

### Still unknown

Whether the embargo expires on its own (`dismissal_embargo_days` holds what
looks like a timestamp, not a count of days) and whether re-picking clears it.
Worth knowing before the store listing claims anything about recovery.

*Amended 2026-08-14, from the Chromium source.* The embargo has numbers, and
they change how the UI must behave.

`components/permissions/permission_decision_auto_blocker.cc`:

- `kDefaultDismissalsBeforeBlock = 3`
- `kDefaultEmbargoDays = 7`
- `FILE_SYSTEM_ACCESS_RESTORE_PERMISSION` is in the auto-blocked content types

`IsUnderEmbargo` is a timestamp comparison —
`current_time < base::Time::FromInternalValue(*found) + offset` — so the stored
value is the embargo's START (microseconds since the Windows epoch) and the
duration is applied at comparison time. **It expires on its own after seven
days.** The field name `dismissal_embargo_days` describes what the number is
for, not what it holds; reading it as a duration was wrong.

**Nothing an extension can call lifts it.** `RemoveEmbargoAndResetCounts` is
C++-internal, reached from browser UI paths, and `chrome.browsingData` has no
`siteSettings` type at all — its `origins` filter covers cookies, cache and
storage only. The user-facing escapes are: wait it out, *Clear browsing data →
Site settings* (profile-wide, so it resets every site's permissions), edit
Preferences directly, or move to a different extension id.

### The cost is persistence, not delay

The restore prompt is ALSO the only place **Allow on every visit** is offered.
Picking a folder afresh grants access without offering it. So an embargo does
not merely postpone a reconnect — for seven days it removes the user's ability
to make the grant permanent at all, and the extension will lapse on every
restart with nothing on screen explaining why.

### Which makes three dismissals a budget to spend carefully

The popup's Reconnect looped over every lapsed folder calling
`requestPermission` on each, so one impatient click on a two-folder setup spent
two of the three. That is an embargo accelerator, and it is the likely reason
the reporter reached the limit within minutes of the button existing.

Now: **one prompt per click, stopping at the first refusal.** Whatever made
someone refuse the first prompt applies to the second, so continuing buys
nothing but embargo.

The same reasoning condemns anything that raises the prompt on our own
initiative. A notification that nudges toward the button is a nudge toward the
dead end, and that trade — a rare lapse made visible, against a permanent
downgrade made likelier — is not obviously worth taking. Left in for now with
the loop fixed, but it should be decided deliberately before this ships.

*Amended 2026-08-14, measured cleanly.* The entry above ran two effects
together. Reset to a clean grant, restarted, pressed **Don't allow** exactly
once:

    permission_autoblocking_data → FileSystemAccessRestorePermission
      { "dismiss_count": 1 }          ← no dismissal_embargo_days key
    file_system_access_chooser_data
      { "chosen-objects": [] }        ← already empty
    file_system_last_picked_directory   ← gone entirely

They are separate, and the ORDER matters:

**One "Don't allow" destroys the grant.** Immediately, on the first refusal —
not after three. `chosen-objects` is emptied and the last-picked directory
cleared, so every stored handle is orphaned and the folder has to be picked
again. This is the damage that actually bites people.

**The embargo is secondary.** `dismissal_embargo_days` only appears at
`dismiss_count = 3`, so three refusals are needed for the seven-day block. An
explicit "Don't allow" counts toward the DISMISSAL budget, the same as closing
the bubble with the X.

So the earlier telling — that "Don't allow" left the user embargoed — was two
findings collapsed into one. The first refusal costs the folders; the third also
costs persistence for a week.

### The dialog does not say any of this

Chrome asks *"View and edit files from the last time you visited this site"* with
*Allow this time* / *Allow on every visit* / *Don't allow*. Nothing there
suggests that refusing DELETES a grant the user already made rather than
declining for now, and the wording invites a cautious person to refuse. It
cannot be changed from an extension.

So the warning goes where we do control it — on the button that raises the
prompt, and in the status line above it. Both branches are spelled out, because
Chrome's wording gives no clue about either: *Allow this time* costs a repeat
next session, *Don't allow* costs the folder.

### And a failed renew must not offer Renew again

Retrying is the losing move: it has already failed once, and each attempt spends
one of the three dismissals, while re-picking costs nothing and always works. So
a row whose renew failed hides its Renew button and offers only **Choose
again…**. The budget is small enough that the UI must not invite people to spend
it on a repeat.

*Amended 2026-08-14, and this is the one that matters for shipping.* Several
rounds of renew-and-restart later, with successful grants in between:

    permission_autoblocking_data  [17:35:52]  { "dismiss_count": 1 }
    file_system_access_chooser_data [17:41:37]  both folders back, writable

**`dismiss_count` did not move.** Six minutes and several successful grants
after it was set, it is still 1. A grant does not refill the budget.

Confirmed in `permission_decision_auto_blocker.cc`: `RecordDismissAndEmbargo`
only increments, no path resets counts on a grant, and nothing decays them over
time. They are cleared only by `RemoveEmbargo` — which no extension can call.

### So the three-strike budget is per-origin and LIFETIME

Not per session, not self-healing. A user who refuses the dialog three times
across months of ordinary use arrives at the same seven-day embargo as one who
does it three times in a minute.

And by the shape of the code — inference, not yet watched — once the count
reaches 3 it stays ≥ 3, and the embargo is re-applied whenever the threshold is
met. After three lifetime refusals, **every** later refusal would cost another
week.

That changes how much the mitigations are worth. One prompt per click, no retry
after a failure, and a warning on the button are not polish; they are the only
things standing between an ordinary user and a permanent-feeling breakage,
because the budget never comes back.

### Also observed: allowing does not imply persisting

After all the re-granting, `file_system_access_extended_permission` is still
empty — access works, but session-scoped, so the restore prompt returns on every
restart. Persistence comes ONLY from choosing "Allow on every visit" on that
prompt. A user who keeps choosing "Allow this time" gets a working extension
that asks forever, and nothing tells them the other button exists. Which is why
the copy names it in both surfaces.

*Corrected 2026-08-14. The entry above overstated the damage, and it was
recorded as measured fact — so read this one instead.*

**"Don't allow" does not destroy the grant.** It empties `chosen-objects`
immediately, which is what the earlier reading saw. But the extension's stored
handles survive, and the restore prompt eventually returns and re-acquires
EVERY folder at once through `requestPermission`. No re-picking is required.

Confirmed by the reporter: after refusing, they clicked **Renew** and only
Renew, across at least three browser sessions, and both folders came back
together. The evidence in the profile agrees —
`file_system_last_picked_directory` is absent (picking a folder sets it) while
`chosen-objects` was rewritten with both entries in one go, which is a restore,
not two picks.

**The prompt returns on a delay of more than one restart.** Those earlier Renew
clicks displayed NOTHING — `dismiss_count` stayed at 1 throughout, and a shown
prompt that is refused increments it. So `requestPermission` was returning
silently for two or more sessions before Chrome chose to ask again. What governs
that interval is not known; it is not the embargo, which never engaged.

### What this changes

**A silent Renew is "not yet", not "never".** The UI had been rewritten to treat
it as terminal and steer to re-picking — which trades a permanent grant for a
session-scoped one, since **Allow on every visit** appears only on the very
prompt being waited for. Both surfaces now say the honest thing: it usually comes
back after a restart, sometimes a later one; re-pick only if you would rather not
wait, and know what that costs.

**Hiding Renew after a failure stays**, but only for that visit — the row is
rebuilt on reload, so nothing is permanently withheld.

### On being wrong twice about the same click

The first reading ("Don't allow empties chooser_data") was correct but partial;
the conclusion drawn from it ("re-picking is the only way back") was invented to
join it to the embargo finding, and shipped as fact in copy and in this log. The
reporter's own sequence — Renew, restart, repeat — is what disproved it. A
measurement explains what it measured, and nothing about what would have happened
next.

*2026-08-14, from the source, and the resulting strategy.*

`chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc`
gates the restore prompt on the grant being DORMANT:

    context_->GetPersistentGrantType(origin_) != PermissionDatabaseType::kDormant
    context_->IsEligibleToUpgradePermissionRequestToRestorePrompt()

So there is a state machine — no grant / active / dormant — and
`requestPermission` produces the restore dialog only when there is a dormant
grant to restore. That, not a cooldown, is why Renew returned silently for two
sessions after a refusal and then worked: the docs show no backoff or
rate limit on this prompt. The exact transition rules into dormancy are NOT
established here; the gate is quoted, the rest is not guessed at.

### The strategy: prime before the prompt

Two facts settle what can be done, and neither depends on the unresolved part:

1. **"Allow on every visit" exists only on the restore prompt.** Picking a
   folder afresh grants access without offering persistence. So that dialog is
   the single opportunity, it cannot be summoned on demand, and a wasted one
   costs at least a restart.
2. **The state is detectable.** At browser startup, before any user action,
   `queryPermission` returns `granted` when extended permission is live and
   `prompt` when the grant is session-scoped. `onStartup` already runs that
   check, so the extension knows — silently and reliably — that someone is stuck
   on "Allow this time".

Chrome's dialog is three near-identical pills, and its wording ("View and edit
files from the last time you visited this site") says nothing about what any of
them costs. "Allow this time" is the cautious-looking choice and the one that
guarantees being asked forever. Prose cannot point at a button, so both surfaces
now DRAW the dialog with the middle option marked, and only then offer to raise
it.

That is the whole lever. There is no API that grants persistence, no way to
influence which options Chrome shows, and no way to re-ask sooner. What is left
is making sure that when the one prompt appears, the user already knows which
button they came for.

**Corollary for the notification.** Its job changes: not "a folder lapsed" but
"the one prompt that can fix this permanently is available now". That is a
better reason to interrupt than the original one, and it argues for keeping it —
provided it always lands on the primed popup rather than raising the prompt
directly.

---

## 2026-08-14 — the extension is a document browser, not a permissions panel

The popup's entire content was plumbing: *local file access is on, folder:
documents*. True, and nobody wants it. `tray/ios` is a
`UIDocumentBrowserViewController` — you see your documents and tap one — and
that is the right shape here too. So the tray now lists documents with real
titles and page-one thumbnails, and permission state is one line at the bottom
that stays quiet while things work.

Four pieces, three of which reuse something that already existed.

**Clickable rows come from `locateIn` run backwards.** A directory handle knows
its name and never its path, so the extension can WRITE a document it cannot
URL. But `resolve()` holds both halves at one instant: `sender.url` is absolute
and browser-stamped, and `dir.resolve()` gives the same file's route from the
grant root. Subtract, and the grant's absolute prefix falls out; store it and
every document in that folder becomes openable. Bootstrapping costs one document
opened the ordinary way, which is the premise of the product. A folder that has
never taught us its prefix still lists — the rows just say they cannot be
opened, rather than doing nothing when clicked.

**Titles come out of the document block**, which starts ~6KB in, so a fixed
300KB head reaches it. Matching the field directly matters: an earlier metadata
reader looked for the block's CLOSING tag and therefore found nothing in any
document carrying an image, since those blocks run to megabytes. The rig pins
that case explicitly.

**Thumbnails were already written.** `preview.ts` puts a still render of page one
into every saved document so file managers can thumbnail it, and this IS a file
manager. The block is self-contained and scales itself to whatever viewport it
lands in, so it drops into a 56×32 sandboxed iframe with no work — exactly what
it was built for. Encrypted documents deliberately carry none, so those show a
lock, and a document never saved shows a page glyph rather than broken-looking
white.

**`+ New document` fetches the signed release** rather than bundling a seed.
Bundling would put a copy of Bento inside the extension, to drift from the real
release and be re-reviewed on every update — the same trap `tray/ios` avoided by
letting documents carry their own runtime. De-duplication counts on the BASE
name (`Untitled 2.bento.html`), because UIKit's own counter produces
`Untitled.bento 2.html` from a double extension and `tray/ios` had to write its
own for the same reason.

### Enumeration is allowed here, and that is not a contradiction

`background.js` went to some trouble to STOP enumerating: resolving a save must
not walk a folder, because the user is mid-⌘S and a granted home directory would
hang it. Listing is user-initiated, bounded (depth 4, 300 documents) and cached.
Same folder, different job, different rules — worth stating because the two
sit next to each other and the next reader will wonder.

### One store, one owner

`background.js` and `status.js` each opened IndexedDB with their own copies of
the database name, store name and keys, guarded by a rig comparing the two. That
gate is gone because the duplication is: `db.js` owns the store and both import
it. The rig now asserts the stronger thing — that nothing else calls
`indexedDB.open` — since a second opener is how the split-brain returns, and its
symptom is the options page writing grants the worker never reads.

### Verified by looking

The layout was rendered with a real preview extracted from a real saved deck and
screenshotted, not asserted. The library rig reads the real built shell, and a
copy of it with a document spliced in at the real offset — hand-written fixtures
would have passed the metadata bug that shipped.

Found while writing it: a PRISTINE shell has an EMPTY `#bento-doc` block
(`id="bento-doc"></script>`) because the starter document is built at runtime and
only written on first save. So a newly created document legitimately has no title
and no preview until it is saved once. The rig asserted a title and failed —
correctly, at the assertion rather than in the parse.

*2026-08-14, continued: the home page, and the bug that made the tray useless.*

**The tray listed documents and could open none.** A chicken-and-egg: a
directory handle has no path, so an absolute one is needed to open anything, and
it was learned only by subtracting during a SAVE. A fresh install had never
saved, so every row was disabled. Opening a document is the natural moment to
learn where its folder is, so `relay.js` now announces itself once on load and
the worker resolves that like a claim — no write, prefix recorded. One document
opened makes its whole folder openable. The announcement sends an op and
nothing else; the path still comes from `sender.url`.

**A full page, because a popup cannot browse.** 340px that dies on blur answers
"open the thing I just had" and nothing else. `src/home.html` adds folders,
search, sort, and thumbnails big enough to recognise a deck by. The popup stays
a launcher with a door to it, rather than a second implementation — both read
`library.js`, so they cannot disagree about what a document is.

**Thumbnails need a real viewport, not a small one.** The preview block sizes
page one to whatever viewport it lands in. Give the iframe a 56px box and it
lays the slide out for a phone; give it 1280×720 and scale the whole frame down,
and it composes exactly as it does on screen. Measured while looking at it: the
first screenshot showed blank cards because the iframes had not painted yet, not
because anything was wrong — a reminder that "I looked and it was broken" needs
a second look before it becomes a finding.

**Rename is write-then-remove, in that order, always.** The File System Access
API has no rename. If the write fails the original is untouched; if the remove
fails the worst case is two copies. Removing first would put the only copy of
somebody's document in a variable, and the rig proves the ordering by failing
the write and checking nothing was removed.

**The rename box is a filename input, so it is sanitised as one**: separators
stripped so nothing escapes the folder, the extension stripped so typing it does
not double it, and leading dots stripped — a document renamed to `.something`
would vanish from every file manager including this one.

**Duplicate copies bytes, deliberately.** A Bento document carries its own
runtime, its collaboration keys and its identity. Whether a copy should get a
fresh `docId` is the DOCUMENT's business — Bento has "Duplicate as new deck" for
exactly that — and a file manager has no standing to decide it.

**There is no Delete**, and that is a decision rather than an omission.
Destroying documents needs an undo, a trash, and a confirmation people actually
read; Finder has all three and is one keystroke away. Duplicate and rename are
recoverable, delete is not.

**Multi-app support was deferred, deliberately.** Supporting other single-file
HTML apps means widening the manifest match from `file:///*.bento.html` to all
local HTML, which injects the bridge into every local page a user opens — a much
larger thing to justify in a store listing — and replacing the `window.bento`
version gate with a generic app declaration. That gate is what stops a pre-#213
document from having its "Save a copy" treated as an overwrite, so it cannot be
dropped casually. Doing it first would have settled the home page's data model;
doing it later means the home page will need revisiting. That is the cheaper
order, because Bento's own shape is known and another app's is not.

*2026-08-14, continued: does the tray handle Spaces and Dash?*

Mostly yes, already — and the exception was a real bug nobody had noticed.

**Listing, opening, thumbnails and in-place saving were never app-specific.**
The whole family writes `.bento.html`, shares the kernel's `title` field, and
slides/spaces/dash all register a preview. So the tray shows them all, with
titles and page-one thumbnails, without knowing which app it is looking at.
(`type` does not exist on main yet.)

**But bento/dash could not save in place at all.** `page-bridge.js` refuses to
write unless the runtime is at least 1.0.15, because before `pickerIdFor` (#213)
every save sent `bento-doc` — including "Save a copy…" — and acting on that id
overwrites the open document. It read the version from
`window.bento.updates.version`, which each app assembles BY HAND: slides has it,
spaces has it, **dash never included `updates`**. So every ⌘S in Dash fell
through to a destination prompt, with a folder granted and nothing on screen
saying why. It would have looked like the extension being broken.

The bug is not that Dash forgot. It is that a contract with a host was being
satisfied by each app remembering to. So the signal moved to where it cannot be
forgotten: `configureApp` is the one call every app makes, and it now announces
`window.__bentoRuntime`. The next app inherits the fix without knowing it
exists.

The bridge reads BOTH — the announcement first, the hand-made object as a
fallback — because every already-shipped Slides and Spaces document has only the
latter, and dropping it would break in-place saving for every file already on
disk. Both are still gated at 1.0.15; an announcement is not a reason to trust a
runtime that predates the id.

Non-writable, for the same reason `__bentoHost` is: the document shares that
realm, and a document that could overstate its own version could talk a host
into overwriting it.

**Creating a document is the one operation that must ask which app**, because
there is no document yet to say. `library.js APPS` lists the three with their
own signed release channels, and `+ New document` offers them. Adding an app is
that one entry; nothing else in the extension asks.

Fetched rather than bundled, for the reason `tray/ios` does not bundle a shell:
a bundled seed drifts from the real release and drags the extension into a
review queue on every Bento update. A document created here is the build
everyone else has that day.

*2026-08-14, and this one was a design failure, not a bug.*

The tray shipped with a first run that read: every document greyed out, and a
paragraph explaining that you must go to Finder and double-click something
before the extension works. Reported, correctly, as *"this doesn't make sense
for normal users"*.

The constraint behind it is real. A `FileSystemDirectoryHandle` never exposes a
path, so the extension can read and write a folder while having no idea where it
is — and a tab needs an absolute path to open a document. The only source was a
document loading out of the folder and its content script reporting
`sender.url`. Everything followed from treating that as the only source.

**Chrome already knows.** If a document has ever been opened, its `file://` URL
is in history. One `chrome.history.search({ text: '.bento.html' })` yields the
absolute path of every Bento document the user has, which places every granted
folder at once, with no trip to Finder.

**The permission is optional, requested by a button, and handed straight back.**
"Read your browsing history" is a heavy ask and a fair thing to balk at on a
store listing, so it is not in `permissions`. It is in `optional_permissions`,
requested at the moment it is needed with the reason on screen, and
`permissions.remove`d in a `finally` — held for the length of one query.
Declining is a legitimate answer and gets the manual route, said plainly,
without asking again.

**Nothing from history is trusted.** A URL is a hint. `route.js prefixFor`
accepts a path only when the route resolves inside the grant AND `dir.resolve()`
on what it lands on agrees with the path's own tail — the same check that stops
a same-named file elsewhere from being written. The failure mode of getting this
wrong is not a broken link: it is a folder recorded at the wrong location, with
every document in it silently opening something else. Its rig is mostly refusals
for that reason.

`locateIn`/`pathFromSender` moved into `route.js` so the worker and the pages
can both place a path. Importing `background.js` into a page instead would have
registered a second `onMessage` listener there.

### What this says about the process

The chicken-and-egg was noticed and "fixed" twice — first by learning on save,
then by learning on open — and both times the fix was inside the frame that
opening a document is the only way to learn a path. Neither attempt asked
whether the frame was true. The user did not report a bug; they reported that
the result made no sense, which is the question that broke the frame.

The rigs were green throughout. They test what the code does, and the code did
what it was written to do.

*2026-08-15.* "Can't the extension just inspect files to see if they're Bento?"
Yes — and the better question was "why are there any misnamed ones?"

**The listing now decides by CONTENT.** `id="bento-doc"` is the splice contract
every Bento app honours (PLATFORM.md §2), frozen because old updaters depend on
it, and it sits ~6KB into a real shell. So an unrecognised `.html` is settled by
one 64KB read; a properly named document costs no read at all; the verdict is
cached by size and mtime, so a second listing opens no bytes; and sniffing is
capped per listing, because a granted home directory can hold thousands of
unrelated pages.

Marked in the UI rather than silently half-supported. A found-by-content
document lists and opens, but the bridge that saves in place is a content script
matching `file:///*.bento.html`, so it will still ask where to put itself. A
tray that looked like it fully supported a document it half supports is a trap.

**But the real fix was upstream, and Bento was the culprit.** `suggestedFileName`
has always produced `.bento.html` — while the PICKER accepted `.html`. So an
author who edited the name to "Q3" got `Q3.html`, and that document is a
second-class citizen everywhere the convention is what identifies us: the webext
bridge matches on the compound extension, and tray/ios matches the same way.
Bento was manufacturing the exception and then being asked to cope with it.

Both pickers now accept only `.bento.html`, so the browser appends it to a bare
name. Compound suffixes are explicitly legal (`.tar.gz` is the spec's own
example) and the limit is 16 characters against this one's 11 — checked in the
spec rather than assumed, after a day of assuming browser behaviour and being
wrong.

The cost is that typing `deck.html` yields `deck.html.bento.html`. Accepting
both extensions would remove that and also remove the whole benefit, since
`.html` would again be a valid terminal suffix and nothing would be appended.
The common case — typing a plain name — now produces the right thing, and the
odd case produces a clumsy name rather than a broken one.

**Widening the content-script match was considered and NOT done.** Making
renamed documents save in place needs `file:///*.html`, which injects the bridge
into every local page a user opens — a much heavier ask on a store listing than
the narrow match, for a case that should now be rare because the source of it is
fixed. If it is ever wanted, the pattern is the one the history search
established: an optional permission, requested with the reason on screen,
registering the broader script only when granted.

*Found while writing the rig:* its `deps` lacked a cache, so `sniff` threw
straight into a `catch { continue }` — the check reported green while proving
nothing. Then the cache assertion counted `getFile()` calls, which a cache hit
still makes (it needs size and mtime for the key); it now counts content reads.
Two rounds of a test that passed for reasons unrelated to the thing under test.

*2026-08-15.* A UX and UI pass before merging, and the diagnosis was structural
rather than cosmetic.

**Three surfaces, three design languages.** The home page had tokens and dark
mode. The popup had 21 hardcoded colours and no dark mode. The options page had
16 and no dark mode. So the surface people actually open — the popup — was the
one that turned white at midnight, and the settings page looked like a different
product reached by leaving the one you were in.

`ui.css` now owns the palette and the shared primitives; each page keeps only
its own layout. `pack-webext` fails on a literal colour anywhere but there
(`setBadgeBackgroundColor` exempt: a browser API taking a string, which CSS
variables cannot reach). Verified as a real gate by planting one.

**Settings became a VIEW, and options.html is gone.** Same shell, same sidebar,
same navigation. What was prose is now rows, because a folder is a thing with a
state and an action and a paragraph about it is neither. `options_page` points
at `home.html`, so `openOptionsPage()` still works from the popup.

**The first run is steps, not an apology.** Both things that must happen are
outside the extension's power — a folder you choose, and a Chrome switch no
extension may touch — so it shows a short list with what is already done ticked,
rather than an empty page explaining why nothing works.

**Documents say which Bento they are.** Three apps write `.bento.html`, and the
UI never said which one a document was, so a folder of decks, notes and sheets
read as one undifferentiated pile. `describe` now reports the format field and
the card carries a badge — alongside the `.html` badge for a document found by
content rather than by name. Both sit on the picture, never in the body, so they
cannot push a title around.

**The notices were essays.** Each is now a sentence and, where there is
something to do, a button. The reason a thing cannot be automated is interesting
to us and not to someone trying to save a document.

*Found by looking:* `.step b { display: block }` was unscoped, so a bolded phrase
in the middle of a note became its own line and broke the sentence around it.
Only visible in a screenshot — no rig would ever have caught it, and I had
written the markup that triggered it.

*2026-08-15.* Where the popup belongs, once the toolbar icon opens the library.

**`default_popup` and `action.onClicked` are mutually exclusive.** Declaring a
popup means the click opens it and the listener never fires. So wanting the icon
to open the full page means having no popup at all — and the question becomes
what the tray's compact form is FOR.

**Its job was always switching documents while working in one**, and a popup is
the wrong container for that: it dies the moment it loses focus, which is the
moment you click into the thing you switched to. A **side panel** does not. Same
markup, same code, better container — `sidePanel.open()` arrived in Chrome 116,
which is this extension's floor exactly.

Two surfaces, two jobs, and neither is a lesser copy of the other:

- **toolbar click → the library.** Browsing and managing: folders, search,
  rename, settings. Wants room and a tab that stays. An existing tab is FOCUSED
  rather than duplicated.
- **`Alt+B`, or right-click inside a document → the panel.** Switching while
  working. Sits beside the document instead of vanishing.

**`sidePanel.open()` must be called SYNCHRONOUSLY inside the gesture.** An
`await` before it — even a trivial one — loses the gesture and Chrome refuses,
silently. So the command handler reads nothing first; the panel decides what to
show once it is up. The rig pins this by slicing the handler and asserting no
`await` appears in it.

For the same reason the lapsed-grant notification leads to the LIBRARY rather
than the panel: it is handled after an await, so `sidePanel.open()` there would
be refused without saying so. It used to try `chrome.action.openPopup()`, which
no longer exists to try.

`window.close()` is gone from the panel. A popup closing itself after an action
is correct; a side panel doing it takes away the thing the user just used.

*Two rig lessons, both mine.* The first gate for "nothing calls openPopup"
matched the comment explaining why the call was removed — a gate that trips on
its own documentation gets deleted rather than fixed, so it now strips comments
and reads code. And it was verified by re-adding a real call and watching it
fail, which is the only way to know a source gate is a gate.

*2026-08-15.* Keeping unpacked installs current, when the browser will not.

**Store installs update themselves; an unpacked one never does.** Chrome ignores
`update_url` for a development install — it runs from a directory on disk and
nothing is going to rewrite that directory. Self-hosting a `.crx` is not a way
round it either: Chrome refuses off-store installs on Windows and macOS. So the
only move available is to TELL those users.

**Ask only the people it applies to.** `chrome.management.getSelf()` reports
`installType`, and — checked in the API docs rather than assumed — it needs **no
permission at all**, so this costs nothing on a listing. Anything but `normal`
is told: `development` is the GitHub route this exists for, and
`sideload`/`admin`/`other` also arrive outside the store's update mechanism. A
store install is never asked and never makes the request; a notice about a
version the browser has already installed is how an extension gets uninstalled.

**A GET for a static JSON file, and nothing else.** No identifiers, no query
string, no version reported upward — the comparison happens locally. The app's
own update check promises "no ids, no telemetry", and the extension must not be
quietly weaker. It can report and link; there is no mechanism for an unpacked
extension to update itself, and inventing one would mean downloading code and
asking for trust, which is precisely what a reviewer would ask about.

**Not on the badge.** The badge means "a folder lapsed, saving will prompt". A
version behind is neither urgent nor broken, so it is a notice in the library and
a row in Settings, with a manual "Check now".

**The digest is emitted, not typed.** `pack-webext` now writes
`dist/tray-release.json` beside the zip, carrying the sha256 of the bytes it just
built. A hand-copied hash goes stale in silence. Publishing it is worth
something only because the package is byte-reproducible: anyone can rebuild from
source and confirm the zip they downloaded is the one that was reviewed — the
only verification available when the browser is not the thing doing the updating.

**Startup only, plus a manual check.** A daily poll would cost the `alarms`
permission for a courtesy. A browser session is the natural granularity for
something whose remedy is "download and reload".

*Rig note:* the comparison is numeric, not textual — `1.0.10` against `1.0.9` is
the case string comparison gets backwards, and it is pinned. So is the direction
that matters most: a store install is never told, and never even asks.

*Amended, same day.* Should the check be automatic by default?

Yes, but only with a switch and a disclosure — and the argument runs both ways
inside this repo, which is why it is worth writing down.

FOR: `kernel/src/update.ts` checks a release manifest at launch by default, with
an off switch in the About dialog. The extension behaving differently would be
an inconsistency with no reasoning behind it. And an unpacked install has no
other way to find out it is behind: the browser will never tell it.

AGAINST: the v0.9.1 fix exists precisely so an anonymous visitor never phones
home without opting in, and the audience that loads an extension unpacked from
GitHub is the audience most likely to object to a silent outbound request.

The distinction that settles it: that fix was about connecting to a relay with
document data. This is a static GET with no identifiers, no query string and no
version reported upward. Different in kind — but "different in kind" is a
judgement the user is entitled to make instead of us, so the preference sits in
Settings next to what it does.

OFF means NO REQUEST, not a request whose result is hidden. The rig pins that
distinction, because the lazy implementation of a privacy switch is the one that
keeps the traffic and quietens the UI.

**Check now** works regardless: pressing a button is the consent the preference
otherwise stands in for. And an unreadable preference is treated as ON, matching
"absent means on" — a storage hiccup should not silently disable something the
user never turned off.

*Amended, same day.* What actually happens when an unpacked user acts on the
notice — and the footgun the first version of the copy walked them into.

**An unpacked extension is identified by its DIRECTORY PATH.** So the obvious
upgrade — extract the new zip somewhere convenient, "Load unpacked" from there —
produces a different extension: different id, different origin, empty
IndexedDB. No granted folders, no learned prefixes, no preferences, and the old
copy still installed beside it. The user has done the natural thing and lands on
the first-run screen wondering where everything went.

The original notice said "get it on GitHub and reload it in chrome://extensions",
which is close enough to sound complete and does not contain the one word that
matters: SAME folder. It is now three numbered steps, and step 2 says why.

**The first-run screen also carries the warning**, because "an unpacked install
with no folders" is precisely what a botched upgrade looks like from inside the
new copy — and nothing there can detect it. The data is intact under the old id,
which is still installed; the fix is to replace the files in the original folder
and reload. Saying so on the screen the mistake produces is the only place it
can be said.

Not fixable any other way: handles cannot leave their origin, so there is no
export/import that would carry grants across ids. The instruction is
load-bearing, which is why it is in the notice, the first-run screen, the README
and the store listing rather than in one of them.

*2026-08-15.* Search reached the title, the file name and the folder — which
finds a document you can already name. What people actually remember is a phrase
ON a slide, and the bytes to answer that were already being read for the
thumbnail and thrown away.

`describe` now extracts the text in the same pass. Deliberately NOT a JSON
parse: the block runs to megabytes with images inline, each app shapes it
differently (slides put prose in `element.html`, spaces in blocks, dash in
cells), and a reader that must know the format breaks when the format moves.
Pulling string VALUES — `:"…"`, never keys — is format-agnostic and degrades to
"finds less" rather than throwing. Data URIs are dropped first: one embedded
image outweighs every word in a document. Capped at 40KB, so a folder of large
documents does not quietly become a search index. Encrypted documents are never
indexed — a searchable copy of a password-protected file is the leak the
password prevents.

Measured on a real deck: 36KB of prose out of a 900KB file, finding words from
slide bodies and speaker notes.

**Onboarding, help and about are one view, not three.** They are the same three
questions — what is this, how do I use it, who made it — asked at different
moments, and three surfaces would repeat each other and drift. It shows LIVE
state rather than a leaflet: the two prerequisites tick themselves off, so the
page that explains the product is also the page to return to when something
stopped working, which is when people look for help. A fresh install is sent
here by `onInstalled` with `reason === "install"` only — an update must not
steal a tab, and reloading an unpacked extension fires that event every time.

*Found by looking, twice:* `.tour b { display: block }` turned a bolded phrase
mid-sentence into its own line — the identical mistake `.step b` had made and
which I had already fixed. An unscoped element selector inside a component is
the shape of the bug; both are now `> b`.

---

## 2026-08-10 — The spaces topbar has TWO fold tiers, and the touch gutter lives in a margin

Two mobile defects, both measured on the shipped shell at a 390×844 viewport
with a coarse pointer, neither of them a regression — they had been there since
the surfaces shipped.

**The bar folds twice, and it starts at the drawer breakpoint.** `.sp-bar` laid
out 467px wide inside 390 and Save's right edge landed at x = 426: the primary
action, 36px off the screen. The existing fold (six secondary actions → the ⋯
menu) was not enough, because what survives it is still eleven controls' worth
of 40px touch targets. So there are two tiers now:

- **≤820px** — the DRAWER breakpoint, not 720. The secondary row folds into ⋯
  and labelled controls drop their words. It was 720, and at 768 (an iPad in
  portrait) the save caret still ended 27px off the screen; 721–820 is exactly
  the band where the page list is already an overlay competing for width, so
  one number now means one thing.
- **≤600px** — a phone. It also gives up the wordmark (About is the first item
  in ⋯), the undo/redo pair (added to ⋯ with their shortcuts and their disabled
  state) and the save caret (each of its four items is in ⋯ or in About). Save
  itself never moves, at any width.

The status span leaves the flow on a phone. It is `white-space: nowrap`, so a
long message ("Reading view — press Esc or the eye to edit" measures ~250px)
would have pushed Save back off the screen for as long as it was up — and
`status()` never cleared its text, only faded it, so the width it claimed was
permanent for the session. It is cleared after the fade now, and overlaid on the
title strip below 600px.

`isPhone()` in editor.ts duplicates the 600px number, because the ⋯ menu must
not offer Undo while Undo is also sitting in the bar. The model rig pins both
numbers and the agreement between them.

**The touch gutter is absolute, in a reserved margin — never in the flow.** The
earlier fix for "there is no hover on touch" made `.sp-gutter` `position:
static`, which bought reachability with 36px of height on EVERY block: a
one-line paragraph measured 68.4px, half of it affordances. It is absolutely
positioned again, the way it is on a desktop, inside a start margin reserved
for it (26px on `.sp-page-inner`, 44px from the edge of the screen once
`.sp-main`'s own 18px is counted), visible at rest, and carrying ONE control —
the grip, whose sheet
already offers "Add below", so the ＋ was a second button for something a thumb
could already reach. Measured after: one-line paragraph 68.4 → 32.4px; the
reading column pays 26px of width for it (354 → 328 at 390px). Both directions
of that trade are deliberate: a phone has ~800px of height and 390 of width, and
the chrome was eating the scarce one.

**Cost.** +312 bytes on the shipped shell (132,102 → 132,414 B), inside the
existing 135,168 B ceiling; no budget change.

*Amended, same day.* The margin was reserved on `.sp-main` first, which is
wrong for a reason worth writing down: `.sp-main` is chrome and follows the
INTERFACE direction, while the gutter is anchored to a block and blocks follow
the DOCUMENT's (`renderPage` puts `theme.dir` on `.sp-page-inner`). On a
document carrying `theme.dir: 'rtl'` the padding therefore went left while the
gutter went right — measured at 390px, the gutter landed at x = 378…412 and the
column scrolled to 412. It is reserved on `.sp-page-inner` now, so the two flip
together; the ltr metrics are byte-identical.

## 2026-08-22 — spaces plays video and audio, and nothing in it ever autoplays

`bento/spaces` gains a `media` block: ONE type carrying `kind: 'video' |
'audio'`, mirroring `image` down to the hybrid `src` (`asset:` · `data:` ·
`https:`), the remote-consent gate and the percentage width. Two types would
have meant two registry entries, two renderer cases and two exporters kept
saying the same thing, and everything that actually differs between a clip and
a soundtrack is one branch wide.

**Autoplay is recorded and never obeyed, and that lives in a FUNCTION.** Slides
learned the shape of this the expensive way: autoplay set at render time fires
on the editing canvas and in every thumbnail, so it belongs to present mode —
the one surface that owns playback. A space has no such surface. It has an
editor, a reading view, a printout and a file-manager still, and a clip that
starts itself is wrong in all four: the reading view because a page you scrolled
past should not start talking, the still because it is a picture.

So the rule is not "the renderer happens not to set it", which is a property of
one function that the next surface would have to rediscover. `blocks.ts
mediaPlayback(b)` returns the flags a surface may apply and its `autoplay` is
typed `false` — it cannot return anything else. `Block.autoplay` still
round-trips untouched (PLATFORM §3), because a build that DOES have a
playback-owning surface may legitimately write it. Pinned three ways in
`scripts/test-spaces-model.ts`, including against a block that asks for it, plus
a source assertion that `render.ts` never sets the attribute by any spelling.

**Paper and thumbnails get a still, gated on `printing`.** That flag already
means "this output cannot be interacted with", and both surfaces pass it —
print, and `preview.ts`'s file-manager render. The still is the author's poster
frame if there is one and a labelled box if not; never nothing, because a
printed handbook that silently omits the paragraph where the demo video was is
the same class of bug as a toggle that prints shut. `preview.ts` also bans
`video,audio` outright, which is now defence in depth rather than the mechanism:
by the time it runs there is nothing to ban.

**A linked clip needs the reader's consent more than a linked image does.** A
remote `<video>` asks its host for byte ranges the moment the element is parsed,
so no autoplay is needed to make it a beacon — opening the space is the ping.
Same gate, same host named, different words ("Video from {host}" / "Load this
video"). The preview passes no `allowRemote` at all, so a still built for a file
manager can never make a request: verified, the emitted preview carries zero
`src` attributes.

**The URL box is its own gate.** `src` is not inline html, so it never passes
through `sanitize.ts` — a `javascript:` typed into "Use a link…" would be
written straight onto the element. It is an `^https?://` ALLOWLIST, never a
`javascript:` blocklist, matching the reasoning behind `HREF_OK`.

**A clip exports as a markdown LINK.** Markdown has no video. `![](clip.mp4)` is
image syntax and draws a broken-image glyph in every renderer that has ever
existed; a bare URL becomes a player on github.com and on nothing else. A link
is correct everywhere: it says what the thing is and where it is. The target is
`src` verbatim, `asset:` and `data:` included, exactly as the image exporter
already writes it — a link that does not resolve outside the space is the truth
about an embedded clip, and a truthful dead link beats a dropped block.

**Nothing is re-encoded.** `prepareImage` exists because a phone photo is 4000px
wide in a 720px column; there is no equivalent cheap win for video, and
transcoding in a browser tab means shipping an encoder and taking minutes over
it. So `MEDIA_EMBED_BUDGET` (8MB, twice the image budget, matching slides) is
the point at which the question is worth asking rather than a size we can
rescue. A browser file picker hands over bytes and never a path, so "keep it on
disk and point at it" cannot be offered — the URL field is the whole escape
hatch, and it is where a "no" lands you.

**Cost.** 166,482 → 172,722 B on the shipped shell (+6,240 B, +3.7%), and the
`scripts/size-budgets.json` ceiling moves 172 → 176 KiB. That is the zopfli
headroom being spent on a feature, which is what it was left for.
## 2026-08-22 — A link card is what the author typed; nothing is fetched, ever

**Decision.** bento/spaces gets a `link` block: a card for an address on the
web, carrying `url`, `title`, `desc`, `site`, `icon` and an optional `image`.
**Every field is stored in the file.** There is no fetch at render time, and
there is no fetch at authoring time either — not even an explicit, opt-in one.
The author fills the card in, and the dialog says so in the first line the eye
lands on: "Nothing is fetched. A card shows what you type here — opening this
space never contacts the site."

**Why not at render.** Settled already: PLATFORM §1 (no network to open, edit,
read or save) and "A space does not phone home when it is opened"
(2026-08-03). A card that fetched on open would be the tracking pixel that
decision was written about, wearing a card for a hat.

**Why not an opt-in fetch in the EDITOR either** — the interesting half, since
about.ts's update check is precedent that an explicit, documented, opt-out
network touch can be on-platform. Three reasons, in order of weight.

1. **It cannot work.** Reading a url's OpenGraph tags means reading a
   cross-origin HTML body. `fetch` gets an opaque response under `no-cors` and
   a CORS failure otherwise; from `file://` — the origin this format exists for
   — it fails outright. Notion and Slack do this on a SERVER, which is exactly
   the component Bento does not have. The only way to ship it is a proxy we
   run, i.e. a backend, i.e. off-platform. A feature that needs a server is not
   a feature this app can have a debate about.
2. **The update check is a different shape.** It contacts ONE origin we
   control, on a schedule the reader can turn off, to verify a signature
   against a key already in the file. A metadata fetch contacts an ARBITRARY
   third party named by the document — the author's choice, made with the
   editor's user's IP address. That is a category the update channel is not in.
3. **The honest v1 is the one that stays honest.** A stored card is legible in
   the JSON, diffable, works offline, and cannot rot into a request when
   someone later "just adds a refresh button".

**The url is untrusted input.** It is a block FIELD, so it never passes through
`sanitizeInline` — `sanitize.ts` exports `externalHref()` for it, the outward
half of `HREF_OK` (`https:`, `http:`, `mailto:`), tested against the RAW string
for the documented `.href` reason. An allowlist, not a blocklist: the URL
parser strips tabs, newlines and leading whitespace from a scheme, so
`ja\tvascript:` and ` javascript:` are both `javascript:` when followed and
neither starts with `https:`. A url outside the list renders as a DEAD card
that keeps its title — it degrades, it does not vanish, and it is never an `<a>`
that goes nowhere. Pinned with eleven hostile forms in the model rig.

**No remote images, and no placeholder either.** `image` is `asset:` or `data:`
and nothing else; a remote one is DROPPED by `linkCard()` rather than deferred
behind a "load this image" button. The image block's placeholder stands in for
the block's entire content, so a reader has something to consent TO; a card's
thumbnail is decoration beside a link that already works. The editor's picker
runs the same `prepareImage` → `internAsset` path an image block does, so a
picked thumbnail is embedded bytes.

**`html` is written beside the fields**, exactly as a `prop` block does it, by
ONE writer (`editor.applyLinkCard`). Format additivity is a promise about what
OLD builds do, and it is only kept if the readable fallback is written at the
same moment as the fields.

**In Markdown a link card is a link** — `[title](url) — description`, with
brackets escaped and the angle form for a url holding a space. Not a table, not
an html `<div>`: every card-shaped export stops being a link the moment it
leaves this app, and where it points is the one fact that cannot be
reconstructed. A card with no valid url exports as its plain text, so a reader
is never handed something to click that goes nowhere.

**Deliberately NOT in this change:** pasting a bare url as a card. That belongs
to the paste pipeline, which is another agent's zone right now, and a second
document-level `paste` listener would race the first. The insert paths are the
`/` menu and the Insert dropdown.

**Verified.** 514/514 in `scripts/test-spaces-model.ts` (up from 460), which
now includes the negative: `linkCard()` drops six shapes of remote image, and
`render.ts` contains no `fetch`/XHR/`new Image()` and reads its only `img.src`
from the filtered value. In Chrome, on a served copy carrying four cards —
including one whose `image` is `https://tracker.invalid/pixel.png` and one
whose url is `javascript:alert(1)` — `performance.getEntriesByType('resource')`
was EMPTY and the network panel showed one `blob:` (the shell's own inflated
module) and nothing else. Shell 166,482 → 171,074 B, inside the 176,128 ceiling;
no budget change.

## 2026-08-22 — The two portability exits for bento/spaces, and what each one refuses to carry

**Decision.** `spaces/src/portable.ts` owns both directions of "a space is never
a dead end": `extractSpace()` cuts one page (optionally its subtree) out as a
complete `bento/spaces` file, and `planGraft()` nests another space's pages
under a page of this one. Pure and DOM-free like `markdown.ts`; the browser
halves are `editor.openExportSpace` / `editor.importSpace` and one hook in
`main.ts`. Five things were settled, all of them the kind that fail silently.

**A fresh `docId`, and no `collab` whatsoever.** An extract that kept the parent
document's id is a FORK of it: `SyncSession` keys BroadcastChannel on `docId`
and the saved file IS the capability, so a three-page extract would join the
two-hundred-page space's room and sync into it. Keeping `collab` is worse than
that — `room`, `key`, `writerPriv`, `ownerPriv` and the invite chain are the
capability to read and write the WHOLE space, and handing them to someone you
sent three pages to is the leak the reader-copy paths already strip for. So the
extract mints a new id and carries no credential at all. `template` goes too (it
re-mints `docId` on every open, which would undo the identity just given);
`readonly` STAYS, because upgrading a reading copy is not the exporter's call.

**A link out of the extracted set becomes the literal `[[Page title]]`** — the
same thing an unresolvable wikilink becomes on the way IN (`resolveWikilinks`).
Text that names the page is honest, searchable, exports as correct Markdown, and
re-resolves if the halves are reunited. The alternatives are worse in both
directions: a silently unlinked label lies about what the file said, and a live
`#p/<id>` that resolves to nothing looks fine until it is clicked — and after an
import it can land on a STRANGER page that happens to hold that id.

**Only referenced assets travel.** Images are the only thing in a space with
real weight; an export carrying the whole document's assets is a copy with pages
hidden. Fonts are the exception and not really one: `doc.fonts` is named by the
theme, so every page references them.

**Ids on the way in: keep, and rename only a collision** — via model.ts's
`repairId`, now exported. Ids are unique across a document and never reused, so
pages and blocks are claimed from one namespace; keeping the ones that do not
collide means links, backlinks and future CRDT node keys survive an import that
did not have to touch them, and the derivation is FROM THE BYTES for exactly the
reason written beside `repairId` (never `Math.random`, never `docId`, which
`template: true` moves). Links inside the import follow the rename in the same
pass, so nothing arrives pre-broken. Assets merge on content addressing, with
the byte-compare and `~n` variant `internAsset` already uses — trusting a key
alone would replace the host's image with the visitor's, silently, in a file the
author then mails.

**The imported file is untrusted and gets no side door.** Its document block is
read from an inert `DOMParser` document (no browsing context: nothing runs, no
resource loads), `parseDoc` decides whether it is a space and REFUSES rather
than degrading (the load contract), an encrypted envelope is reported instead of
guessed at, and `sanitizeInline` runs over every arriving block before any of it
reaches the document. The graft is one `store.commit`, so it is one ⌘Z, like the
Markdown import.

**Guarded.** `scripts/test-spaces-model.ts` runs the whole round trip — extract a
subtree, import it into a space that collides on every id and on an asset key —
and asserts no id collision, no dangling link, no credential in the bytes, the
asset merge in both directions, and additivity through both legs. The one-undo-
step half is in `scripts/test-spaces-undo.ts`, which is bundled and has the real
Store.

**Cost.** Shell 166,482 → 175,690 B (+9,208, 5.5%); `scripts/size-budgets.json`
raised 176,128 → 184,320 in the same commit, because 438 B of headroom is inside
the packer's own cross-node-version spread and would fail CI for no reason.

## 2026-08-22 — bento/spaces: a properties panel that defaults to closed

**Decision.** bento/spaces gets a right-hand properties panel (`spaces/src/props.ts`),
structurally the page tree's mirror image — same `.sp-resizer` strip, same
chevron, same drag-to-resize and double-click-to-reset, same
`localStorage`-only state. It shows BLOCK properties for the block the caret or
the last click was in, and PAGE properties underneath, in accordion sections
whose open state is remembered per title exactly as slides' `.ed-section`
retrofit does.

**Why a panel at all.** The settings existed; the place to look for them did
not. A table's shape came from a bar above the table, a code block's language
from a hover chip, an image's width from a floating tool row, a link card's
fields from a per-block menu, and the page's own width from the PAGE menu. Each
is discoverable only by someone who already knows it is there, and none of them
answers the question in the general case. **The old surfaces stay** — the chip
on a callout is still the fastest way to change a tone, and deleting it to
justify a panel would be a worse editor with a tidier diagram.

**CLOSED BY DEFAULT, and this is the load-bearing part.** `spaces: a wide screen
gets a wide page` (aacf7e2) had just given the reading column the window's
slack, after the complaint that a 720px column on a 2560px screen used 31% of
the area. A panel holding 280px of that open on every screen forever, for
settings most people change once a month, takes the fix straight back. So:
`inspClosed = true`, and only an explicit `'0'` in `bento-sp-insp-closed`
(written when somebody opens it) makes it open — an absent key, a new browser
or a storage exception all mean closed. While closed the panel is
`flex-basis: 0` with no inline padding and no border, so `.sp-main`'s
`flex: 1 1 auto` takes the width straight back.

MEASURED, closed, against the same shell without this change: at 1280px the
reading column is 720px either way; at 2560px it is 900px either way. The whole
cost is the 5px chevron strip (main 1031 → 1026 and 2311 → 2306), which is what
buys a control on the panel's own edge instead of one in a toolbar across the
room.

**Below 820px it is an overlay, not a column** — the bargain the page list
already makes at the same breakpoint, with the same `.sp-scrim` to tap away.

**Its topbar button exists only where the chevron cannot.** Above 820px the
strip carries the control, so a second one in the bar would be the duplication
`.sp-panel-toggle` already documents avoiding. Below 820px the button leads —
until `fitTopbar` folds the bar, when it moves into ⋯ with undo/redo and the
export actions. MEASURED at 375px: leaving the 40px button in a folded bar took
the document title from 70px to 26px, which is a title nobody can read in
exchange for a control that is one row of an already-open menu.

**One control, one commit, one ⌘Z.** Every block edit goes through a single
helper wrapping one `store.commit`, and every text field commits on `change`
rather than `input` — `input` would buy an undo entry per keystroke, which is
the exact thing `store.ts`'s typing run exists to avoid.

**Which block the panel means** is tracked on `focusin` AND `mousedown`, capture
phase, on `.sp-main`. `focusin` alone answers for text and stays silent for
tables, images, clips and cards — exactly the types with settings worth a panel.
`mousedown` rather than `pointerdown` because a real click fires both while a
driven one may not, the same wall CLAUDE.md records for Gesto in slides.

**Guarded.** `scripts/test-spaces-model.ts` pins the default-closed preference,
the three properties of the closed geometry, that nothing about the panel
reaches the document, the overlay below the breakpoint, the accordion's
persistence, the one-commit rule, and that the block chips survived.

**Cost.** Shell 196,950 → 203,654 B (+6,704, 3.4%); `scripts/size-budgets.json`
raised 204,800 → 212,992 in the same commit, because 1,146 B of headroom is
inside the packer's own cross-node-version spread and would fail CI for no
reason.

## 2026-08-22 — bento/spaces goes dark, and its reading column goes with it

**The theme is a VIEWER preference and never document data.** localStorage
`bento-theme`, through `kernel/src/theme.ts`, which slides already shipped
(#285) — the same rule the interface locale and reduced motion follow, and
PLATFORM §8's. Two people opening one space are two readers in two rooms; a
theme in the file would travel to the recipient and override theirs, and it
would make a file's bytes depend on who last looked at it. `startTheme()` runs
AFTER `capturePristine()` in main.ts for exactly that reason, and the saved
`<html>` tag was measured bare: no `data-theme`, no `color-scheme`.

**WHERE THIS DIVERGES FROM SLIDES, AND WHY.** slides themes only the chrome
AROUND the deck: a slide is a bounded page on a canvas, its background is data
the author chose, and someone proofing at midnight still needs to see what will
be projected. Spaces has no such page. `--bg` is THE ONE GROUND — bar, both
panels and the reading column all sit on it with hairlines and nothing else
between them, which is what the chrome-reads-as-one-document work settled one
commit earlier. A dark interface with a white reading column would be a white
rectangle filling most of the window: not a dark interface, and a
re-introduction of the floating-card look that was deliberately removed. So in
spaces the reading surface IS chrome and it follows the reader.

`doc.theme.background/color/accent` still exist in the format and are still the
DOCUMENT's colours — but nothing in the live app paints them; the only consumer
is `preview.ts`, the static file-manager still. That surface stays the author's
in both themes, unconditionally: it renders with scripting off, so there is no
localStorage, no reader and no preference to honour — only a file manager
drawing a thumbnail. A `prefers-color-scheme` block there would be a guess made
on someone's behalf. If it ever changes it changes with the FORMAT.

**The document's own colour VOCABULARY does follow the reader**, and that is
the same ruling read from the other side. The nine `sp-fg-*`/`sp-bg-*` marks
and the five callout tones are a closed vocabulary of NAMES — the author picked
"red", not `#c0392b` — which is precisely why the value under each name can be
tuned per surface, as the palette comment has said since the marks shipped. An
ink measured to clear 4.5:1 on white is a smudge on a near-black ground, so
each `--c-*` carries a light value and a dark one. The BANDS need only one set:
they mix into `transparent` and land correctly on either.

**Callout tones are ONE HUE each, and the box derives from it.** The fill is
that hue mixed into `--bg`, the label is it mixed into `--ink` — a pale tint
with a dark label on white, a deep tint with a lifted label on near-black, from
five numbers instead of thirty. Measured both ways: labels 4.98–6.49:1 light,
6.5–8.4:1 dark.

**THREE STATES, so the dark values appear TWICE.** A reader chose light, chose
dark, or chose nothing. The choice stamps `data-theme`; the default follows the
OS. So dark is stated under `@media (prefers-color-scheme: dark)` guarded
`:not([data-theme="light"])` AND under `[data-theme="dark"]`, or the picker
only works in one direction. Verified with the attribute removed: dark OS →
dark, light OS → white, `data-theme="light"` under a dark OS → white.

**BOTH ARE @media screen, AND THAT IS HOW PAPER STAYS LIGHT.** Print matches
neither, so on paper the unconditional light block is simply what applies and
the print sheet needs no third copy of the palette. It carries one line the
media query cannot: `color-scheme: light only !important`, because theme.ts
writes `color-scheme` INLINE on `<html>` and an author `!important` is the only
thing that beats an inline style.

**An image gets a white ground in both themes.** Document content is never
inverted, dimmed or filtered — but a diagram or logo exported against a
transparent background is a shape floating in nothing on a dark page, and
black-on-transparent artwork vanishes outright. So `.sp-b-image img` paints
white behind itself and takes a hairline, in light as well, so the two themes
frame a picture the same way.

**Where the control lives.** About → Appearance, directly above Language: they
are the same kind of thing, preferences belonging to whoever opened the file.
It is built in its own `spaces/src/appearance.ts` and costs about.ts one import
and one `card.append(...)` — about.ts is a 355-line function that several
branches edit at once, and this is the smallest seam that still puts the
control in the right place.

**Guarded.** `scripts/test-spaces-model.ts` gained twelve checks: both dark
blocks exist and are byte-identical, they define every role light does and
invent none, every themed role is actually referenced by a rule, the light
palette has not forked from slides and type, no literal colour survives outside
the token blocks and the print sheet (three named exceptions), `startTheme()`
runs after `capturePristine()`, the Appearance control never touches the store,
and the still preview has no theme of its own.

**Cost.** Shell 213,434 → 215,002 B (+1,568, 0.7%). No budget raise: the
ceiling stays 221,184.

## 2026-08-22 — bento/spaces checks for updates at launch, and the About dialog says so

**Decision.** bento/spaces asks its release server for a signed manifest once at
launch, gated on the kernel's `bento-auto-check` preference, and the About
dialog carries the switch that turns it off. It was manual-only before, which
left the switch nothing to switch.

**Why this is not "phoning home."** The 2026-08-03 rule ("A space does not phone
home when it is opened") is about the DOCUMENT: an author who mails you a file
must not learn your address and the moment you opened it, which is what a remote
`<img>` in a page delivers. This is the APP asking its own release origin
whether it is current, on the reader's behalf and under the reader's switch. It
sends no id and carries nothing from the document; a remote `src` in a document
still renders as a placeholder naming the host, unchanged. The two rules answer
different questions and both still hold.

**Same preference as slides,** which has checked at launch since v0.9. One key,
`bento-auto-check`, so turning it off in one app turns it off in both — a suite
where the same switch means different things in two apps is worse than a suite
with no switch.

**The result only changes a sentence.** The check is `void`ed and its failure
swallowed: a launch with no network reads "Launch check couldn't reach the
release server (…). Check manually below." and nothing else about the app
differs. There is no badge, no banner and no automatic download; updating is
still a button somebody presses.

**Where it is stated.** In the dialog, beside the switch, in the reader's own
language: "An update check is the only network this app makes on its own. It
asks the release server for a signed manifest and sends nothing about you or
this document — no ids, no telemetry." Live collaboration is network too, but
it is network the reader started.

## 2026-08-25 — the square root: Chromium's radical join, accepted unfixed

**The symptom.** In a formula, the radical's hook does not meet its overbar —
a visible step where the two should be one stroke.

**Status: accepted, unfixed.** Formulas keep the generic `math` family. There
is a mitigation that helps on macOS and it is written down below, deliberately
not shipped. This waits for an upstream fix.

**Every font tested breaks.** Measured on the affected engine, not inferred:

| platform | what generic `math` picks | radical join |
|---|---|---|
| macOS | STIX Two Math | broken |
| Windows | Cambria Math | broken, same way |
| Windows, forced `serif` | Times New Roman | smaller break, still broken |

Three fonts, three breaks. That is what rules the font out as the cause: a
defect belonging to STIX would not follow us to Cambria Math and Times New
Roman, on another operating system, in another font family.

**It is not a version regression.** An earlier version of this entry claimed
Chromium 148 was clean and 151 broken. That table was wrong and is the reason
this entry was rewritten. The "clean" engine was an embedded browser that ships
almost no fonts, so it silently fell back to a plain serif and never rendered
STIX at all. It was not a newer engine breaking a radical; it was two engines
drawing two different fonts. STIX breaks in 148 too.

**What the mechanism appears to be.** Chromium paints the arm of the radical
from the font's glyph and then draws the overbar itself as a rule, and the
break is those two disagreeing by a fraction of a pixel. Two measurements
support this. Sweeping the radicand height from 10px to 200px, the glyph's
advance width never moves off 109.1px, so the radical stretches by a glyph
assembly rather than by wider size variants — the engine is compositing, not
picking one drawn glyph. And the size of the break tracks the font's arm
thickness rather than anything about the formula. It follows that the mismatch
is resolution-dependent, which is why Windows breaks *differently* rather than
not at all, and why zoom level can change the verdict on a given row.

**The radicand's height is not the cause, so do not try to fix this by making
formulas shorter.** Tested directly, because it is the intuitive suspect. In
the starter deck's own quadratic formula the `b²` raises the radicand from
64.4px to 84.3px, but the msqrt box stays at 113.8px — the *minimum*,
single-glyph size — exactly as it is for a flat `b − 4ac` and for four other
radicands. Same glyph, same size, same position, same bar. Only a fraction
inside the root (radicand 159.7px, box 220.3px) actually stretches it. The
radical in `√(b²−4ac)` is pixel-identical to the one in `√(b−4ac)`, so the
exponent cannot be raising the bar.

**The mitigation, documented and not shipped.** Scoping a non-maths font to the
radical only, and putting the contents back:

```css
.bento-el math msqrt { font-family: serif; }
.bento-el math msqrt * { font-family: math; }
```

The second rule is what makes it viable: it keeps the whole formula in the
maths font and swaps only the glyph that is drawn wrong. A blanket `serif` on
the formula is not an option — it collapses stretchy delimiters (a tall `(`
measured 315px in the maths font and 94px in serif) and shrinks large
operators.

Verified clean on macOS/Chrome, where it swaps STIX's radical for the serif
one. **It is not shipped because it does not hold on Windows**, where `serif`
is Times New Roman and the break is smaller but still there. It trades one
rounding mismatch for another, and a fix that only works on the author's own
machine is worse than a known defect. If a font is ever found that joins
cleanly on both platforms, this rule is the shape the fix should take — scoped
to `msqrt`, contents restored to `math`. Note also that the stack matters: on
Windows `'Cambria Math', serif` selects what generic `math` already selects, so
that variant is a no-op there.

`slides/probe/radical-join.html` is the cross-platform test rig:
one row per candidate font applying exactly the rule above, each row reporting
whether the font actually resolved, and a paste-back block carrying platform,
UA and DPR.

**If it ever becomes worth fixing on our side**, the only route that bypasses
the engine's radical painting is drawing the hook and bar ourselves — an
`<mo>√</mo>` plus a CSS rule for the bar, overlapped so the join cannot
separate at any DPI. That costs the semantic `msqrt` (accessibility, and the
morph would need the bar tagged as its own symbol), and an earlier hand-built
approximation still showed problems, so it needs verifying in the affected
engine before anyone commits to it.

**How this went wrong, which is the part worth keeping.** Six or more confident
wrong answers were reported before the right one, every one from an instrument
that lied:

- `document.fonts.check()` returns true for fonts that are NOT installed, so a
  four-font comparison was three fallbacks wearing different labels. Control: a
  nonsense font name — every fallback returns identical metrics.
- A "step size" metric compared the bar against the ink just left of it, which
  is the diagonal, not the flag. It scored a perfect radical as broken and
  returned an identical 21px for every variant.
- An SVG foreignObject rasteriser ignores `font-family` entirely, proven when
  `NoSuchFontXYZ` produced byte-identical output to STIX.
- And the one that cost the most: **every test page was judged in a browser
  that resolved the fonts differently from the one showing the bug.** Nine test
  matrices came back "all fine" for that reason alone, each one clearing a
  suspect that had never actually been rendered.

**The lesson: pin the environment before trusting any comparison, and prove the
thing under test is really on screen.** Record engine, version and *resolved*
font in the test artefact itself — a named font that silently fell back is not
a test of that font. "It looks fine here" is not evidence until "here" is
named.

## 2026-08-28 — OPEN QUESTION: the agent-facing copy of a document is not stripped

**Not a decision. A question recorded so it is not rediscovered a fourth time.**

**Where it came from.** Three apps have now shipped the same clipboard bug.
Slides put the owner private key on the clipboard; bento/spaces reintroduced it
verbatim when it grew its own "Copy document JSON"; bento/type did it again in
#384, where CI caught it (`scripts/test-export-secrets.ts`, the rig widened
from slides-only to all four apps for exactly this reason). Every UI copy path
is fixed and goes through a stripper now.

**What is still unstripped is the path we ask AI agents to use.** CLAUDE.md
tells tooling that the document is the interchange unit and points it at
`#bento-doc` and the `window.bento` API. An agent doing precisely what we
invited it to do — read the document, paste it into a chat model — hands over
`collab.ownerPriv` and the room read key. Same exposure as the button, reached
through the path we wrote the instructions for.

**The facts, measured across the four apps:**

| app | `window.bento.serialize()` | `window.bento.doc` |
|---|---|---|
| slides | `stampInto` + `serializeFile(doc)` — the whole .bento.html | raw `store.doc` |
| spaces | `serializeFile(store.doc)` | raw `store.doc` |
| dash | `serializeFile(store.doc)` | raw `store.doc` |
| type | `JSON.stringify(store.doc)` | raw `store.doc` |

**Two things that are NOT the bug, so nobody spends a day on them:**

1. **`serializeFile` carrying credentials is correct.** It produces the saved
   working file, and the file IS the capability — opening a copy auto-joins the
   room. Stripping it would break saving. The rig already records `serialize()`
   as its one legitimate caller.
2. **`window.bento.doc` is not an escalation.** Any script running in the page
   already has the document. The API grants nothing new.

**And one reason a narrow fix will not close it:** stripping `serialize()`
alone changes nothing, because the `#bento-doc` block inside the file carries
the whole document anyway. An agent reading the file gets the credentials
without touching the API.

**So the question is about defaults and documentation, not a code defect.**
Options, none chosen:

- Leave it. The file is the capability; anyone handling the file handles the
  keys, and that is already true of emailing a deck.
- Say so in the agent-facing guidance: paste a stripped document, never the raw
  one, and name the function.
- Give the platform a stripped accessor — `window.bento.docForExport()` — and
  point the tooling note at THAT, so the convenient path is the safe one. This
  is the shape that has worked everywhere else: the leak keeps recurring
  because the obvious call is the unsafe one.
- Widen the rig again. It currently inspects `about.ts`, `main.ts` and
  `editor.ts` only, so a leak in any other file of an app is invisible to it.

**Whoever settles this: it is a platform decision across four apps.** It was
raised from the bento/type branch during #384 and deliberately NOT decided
there, which was the right call — a single app's feature branch is the wrong
place to set a cross-app default.

## 2026-08-28 — bento/spaces: the `canvas` block, and where a card's position lives

**The type.** `canvas` is a bounded surface holding cards you place by hand —
a storyboard, a roadmap, a mind map. The format shape below is permanent from
the moment the type ships, because there is no server to migrate a file
somebody already has (PLATFORM §3).

### The shape

```jsonc
{ "id": "b1", "type": "canvas",
  "html": "Launch storyboard",   // the surface's NAME, and its fallback
  "ratio": 1.6                    // width ÷ height; ABSENT = 1.6
}
```

**A card is a BLOCK, not an entry in an array on the canvas.** The canvas is
`container: 'always'` in the registry, so it owns the blocks whose `parent` is
its id — exactly as a callout and a toggle do. A card adds two flat fields and
nothing else:

```jsonc
{ "id": "b2", "type": "p", "parent": "b1", "x": 29, "y": 8, "html": "Review with the team" }
```

`x` and `y` are PERCENTAGES of the surface, one decimal place, clamped to
0–100 at read time. A card with no coordinates is not an error: it takes a
deterministic slot from its index among its siblings, so two readers of one
file lay it out identically and `{"type":"canvas"}` with three bare paragraphs
under it is a hand-writable canvas.

A card's TYPE is any block type. `p` is a text card; `pagelink` is a card that
opens a page in the space, which is what lets a canvas be a map OF the space
rather than only a sketchpad. Nothing new was needed for either.

### Why cards are blocks and not an array

Three reasons, in ascending order of how permanent the mistake would have been.

1. **An array is a second place text lives.** Every word in a space is some
   block's `html` — canonicalised by one sanitizer, found by ⌘F, back-linked by
   `buildIndex` because it reads `html`, exported by one markdown pass. Text
   inside `canvas.cards[]` is none of those things, and each one would have to
   be taught about the array separately.
2. **An array degrades badly.** `renderBlocks` resolves a child against the
   OPEN CONTAINER STACK, and an unknown type opens no container — so on a build
   that has never heard of `canvas`, every card falls out to the top level and
   renders as the paragraph or page card it already is, under the canvas's own
   name. Measured against the pre-change shell: the page reads "Launch
   storyboard" followed by each card as an ordinary paragraph, and the `x`/`y`
   it cannot use round-trip untouched. Cards in an array would show as the
   canvas's `html` and nothing more — unless the html duplicated all of it,
   which is the price `table` pays and did not need to be paid again.
3. **An array loses edits under collaboration.** model.ts already states the
   rule: properties are flat because each (node, key) pair is one LWW register.
   `cards` as one array is ONE register, so two people dragging two different
   cards keep one of the two moves, silently. As blocks, each card is its own
   CRDT node and `x`/`y` are its own registers, and both drags land.
   `table.rows` has exactly this limitation and documents it; there was no
   reason to take it on again where the alternative is strictly simpler.

Because the cards are separate blocks that an old build renders on its own, the
canvas's `html` is its NAME and must never repeat them — the opposite of
`tableFallbackHtml`, which has to hold the cells' text because a table's cells
are not blocks. The markdown export follows: a canvas exports as `**name**`
and its cards arrive as their own lines.

### Why percentages, and why `ratio` is document data

Percentages, not pixels: the same file is read at 320px and at 2560px and
printed on A4, and a layout in px is a layout that is right at exactly one
width. Not an abstract 1000-unit grid either — that is a percentage with a
scale factor bolted on, and the renderer would have to know the factor forever.
A percentage needs nothing: `left: calc(var(--sp-x) * 1%)`.

`ratio` has to be in the document rather than a reader-side default, because
the cards' `y` is relative to it: a canvas laid out on a 1.6 surface and read on
a 1.0 one is a different picture. It is stored as an ABSENT key when it is the
default (the `editView` discipline), so a canvas cycled Wide→Square→Tall→Wide
is byte-identical to one nobody touched.

Below 560px the surface renders as a stacked list of its cards, positions
ignored. That is a RENDERING choice made in the stylesheet, not a change to the
file — four cards on a 360px board are four unreadable stamps, and the same
document lays out spatially again on the next screen up.

### Names reserved, so a follow-up does not have to guess

- Card SIZE is `cw`/`ch`, in the same percentage units. **Not `w`/`h`** — an
  image block already carries its intrinsic pixels in those, and an image is a
  perfectly good card.
- CONNECTORS belong on the canvas block as `links: [{ from, to }]` of card ids.
  A relation is not a property of either end.
- NESTING needs nothing: a canvas inside a canvas is a card whose type is
  `canvas`, and the container stack already supports it.

None of the three is built. All three are additive.

---

## 2026-08-28 — a graph view is a DRAWING, and derived state is never stored

Settled while building `spaces/src/graph.ts` (bento/spaces graph view). Written
down because the next app to want a picture of its own data will face the same
three forks, and because two of these are platform-shaped rather than
spaces-shaped.

**1. Derive at open; store nothing.** The graph is built from
`buildIndex().backlinks` and `Page.parent` when the overlay opens, and dropped
when it closes. There is deliberately no `doc.graph`, no saved node positions
and no second link scanner. A stored layout is meaningless to the next reader's
window size, and a second scanner is a second answer to "what links to this
page" — the one question the backlink index exists to answer. The precedent
cuts the same way as `SpaceIndex` itself: *derived, NEVER stored*.

**2. A viewer preference is read the same way in every app.** Reduced motion
here reads localStorage `bento-reduce-motion` first and the OS
`prefers-reduced-motion` second — character for character the rule
`slides/src/present.ts` set, and the rule the theme and the locale already
follow (PLATFORM §8). An app that invents its own motion preference makes the
suite two products.

**3. An animation needs a wall-clock settle guarantee, not just a rAF loop.**
`requestAnimationFrame` is throttled to ZERO in a hidden or occluded tab. The
graph's reveal interpolates from a spiral toward a settled layout while the
camera is framed against the FINAL positions, so a starved rAF does not merely
fail to animate — it leaves the picture frozen halfway and off-centre, which
reads as a broken feature. Measured in exactly that state, then fixed with a
`setTimeout` that lands the final frame regardless. slides carries the same
guarantee for entrance tweens, for the same reason, and any future app that
animates on open needs one too.

**A note on measuring this class of feature.** Nothing above was found by
looking at the screen. The overlay carries a small debug object (`__graph`:
node/edge counts, layout ms, `reduced`, `reveal`, `frames`) and the frozen-
reveal bug was identified by reading `frames: 0` beside a mid-flight `reveal` —
an instrument on the DECISION, not a sample of the result. The rig's graph
assertions were each made to fail on purpose before being trusted (twelve
deliberate mutations; two assertions were too weak and were tightened, one of
them a threshold that passed both with and without the behaviour it claimed to
test).

## 2026-08-28 — bento/spaces: a table column sorts, a title column does not

The Bases table became editable and sortable in place: a column header cycles
ascending → descending → none, and a cell opens the same picker the page's own
header strip opens.

Two things settled that another agent could otherwise contradict.

**Unsorted DELETES the key.** The header writes the view's existing `sort`
through the existing `editView`, and the third click passes `undefined` so the
key is removed rather than stored as `[]`. A view sorted and unsorted from its
header is byte-identical to one nobody ever touched. `cycleSort` in fields.ts is
where that third state lives, so it is one function rather than a rule the two
sort controls each have to remember.

**The page-title column is NOT sortable, deliberately.** A view's `sort` names a
FIELD: `sortRows` looks each key up in `doc.fields` and skips what it cannot
find, and `unknownSortKeys` reports the miss as "newer than this build". A
pseudo-key like `{key:'title'}` would therefore be a key EVERY shipped build
reports as unreadable and does not apply — and teaching `sortRows` about a
non-field key means a second ordering mechanism living beside the first, in a
format where both are permanent. One order stored in two shapes is the thing
that later disagrees with itself. The column is a plain `<th>` and does not
pretend otherwise. If title order is wanted later, the honest shape is a real
field, not a special case in the sorter.

**A cell edit can CREATE the prop block**, the way a board drop already could:
`editor.putField` is the one place a page gains a field, and it goes through
`propBlock`, so the readable `html` is written with the value. A table column
exists because SOME row carries that field; the rows that do not get an empty
cell, and editing it is how the field arrives on that page.

The picker was split from `openFieldPicker` into `fieldPicker(f, cur, anchor,
write)` — a picker over a WRITER rather than a block id, because a cell can
stand for a value that has no block yet. The header strip, the board's card chip
and a cell are now one control with three writers, not three controls.

## 2026-08-28 — two size mechanisms, and why deleting either loses a regression

**Both stay.** #279 added an advisory PR build-size comment while
`scripts/test-spaces-size.mjs` already measured shell size in CI. That looks
like duplicated measurement and it is not, so this entry exists to stop the
next person tidying one away.

**They answer different questions.**

| | the CI rig (size-budgets.json) | the PR comment (#279) |
|---|---|---|
| measured against | a committed `reference`, or a `max` ceiling | the PR's own base commit |
| horizon | absolute, persistent, across all history | relative, one PR |
| can fail a build | yes, when `enforce:true` | never, advisory only |
| catches | SLOW drift — forty merges at 300 B each | a single change's jump |
| blind to | which change caused it | accumulated drift; every PR looks fine |

The second row is the whole point. Forty merged commits costing 300 bytes each
is 12KB nobody chose, and **every one of those PRs shows a harmless +300 in its
comment**. Only a number compared against a fixed point sees it. Equally, the
rig can say a shell grew 12KB since the reference but not which PR to blame;
the comment can. Neither is redundant.

**Two real defects were found while reconciling them, both silent.**

1. **Only bento/spaces was ever registered.** `size-budgets.json` listed one
   shell, so slides and dash had NO persistent size record at all. The rig has
   always been generic — it walks every entry — it just had nothing to walk.
   Both are now registered as `enforce:false` watermarks.
2. **dash was structurally unmeasurable.** The CI step sat in the spaces
   section, *ahead of the dash build*, and the rig SKIPS a shell that is not
   built — so it printed `skip dash — not built` and moved on. A guard that
   reports "nothing to do" in a passing build is invisible. The step now runs
   after all three builds.

**Why watermarks and not ceilings for the two new entries.** Same reason spaces
gave up its own: at 98.6% of its limit it had started declining worthwhile
fixes, which is the ceiling costing more than it saves. And a ceiling picked
with no history behind it is a guess that fails somebody else's PR. Growth
still has to pass a human, because the number is printed every run.

**References come from CI, never a local build.** Most of a shell is one
deflated block and zlib's output differs across node versions — one commit
measured 130,095 B on node 26 locally against 131,246 B on CI's node 24. When
the two disagree, believe CI.

**Naming, left alone deliberately.** `test-spaces-size.mjs` now covers three
shells and the name undersells it, but it is invoked by name from
`scripts/test-spaces.mjs` and referenced in this log, and renaming it was more
churn than the overlap warranted. The file's own header says it is generic.

## 2026-08-29 — five rigs reported passes for work they were not doing

**A green rig is an instrument, and these lied.** The same family as the
"instruments that lie" list in `CLAUDE.md` — a transform read back from an
inline element, rAF in a hidden tab, a DOM sampler polling mid-animation — with
one difference that makes it worse: those instruments were consulted
deliberately by someone who suspected a problem. A rig is consulted by CI, on
every push, by people who have stopped suspecting anything.

**The findings, verified against the tree and PR #399's diff on 2026-08-29.**
Five rigs across four zones, found within one day of each other:

| rig | what it reported | what was true |
|---|---|---|
| `test-tray-bridge.ts` | **52/52 pass** | the #277 arbitrary-write fix was DELETED; its shape checks pinned the `<a download>` call site, the NEIGHBOUR of the fix, while `exportCopy`'s `safeFileName` gate and path-containment guard were read by nothing |
| `test-tray-index.mjs` | "absent, skipped", in green, **for weeks** | the tray→home rename moved the corpus and the path did not; **eleven cases** went untested |
| `test-doc-index.mjs` | never ran | unregistered in CI, and the same rename left it importing `../tray/doc-index.mjs` |
| `test-spaces.mjs` | never ran | unregistered **from the day it was written** |
| `test-slide-store.ts` | never ran | never registered |

**Two distinct failure modes, and the second is quieter.** A rig can assert the
wrong thing — pinning code adjacent to the fix rather than the fix. Or it can
assert nothing at all while still printing a pass, because its input moved or it
was never wired to CI. The second is harder to notice precisely because there is
no wrong assertion left to be wrong. #399's own comment on `test-doc-index.mjs`
puts it best: **a rig nobody runs cannot report its own import failure.**

**Presence is not the property; ordering is.** The load-bearing check added to
`exportCopy` is not that `safeFileName` and the containment guard exist — both
can exist and still run AFTER the write. It asserts
`indexOf('write(to: tmp)') > indexOf('hasPrefix(')`. This is the part that
transfers to any rig: a guard's presence is cheap to assert and frequently
means nothing.

**The check adopted, which costs two minutes:** delete the guard the rig exists
to protect, run the rig, and watch. If it still passes, the rig is reading
something adjacent to the fix. **Do it when you write the rig, not after someone
reverts it.** Measured, not assumed: `exportCopy` gained FOUR checks and THREE
of them fire on the revert that was actually run (53/56). That gap is the point
rather than an embarrassment — four independent assertions, not one assertion
spelled four ways, and the one that stayed silent did so because of how those
particular guards were stripped.

**A skip that protects nothing costs the whole check.** `test-tray-index.mjs`
skipped a missing corpus for a good reason — it arrived with the Android work,
and a rig that fails until an unrelated branch lands is a rig people learn to
ignore. The reason expired when the corpus landed and the skip did not. A path
that is SUPPOSED to exist is a failure when it does not, and a rig must
distinguish ABSENT from MOVED.

**And the practice is now enforced, not just recommended.** A two-minute habit
decays; the same PR adds the mechanical half. `scripts/test-spaces.mjs
--manifest` runs in CI and asserts the list both ways — every `test-spaces-*`
file on disk is listed in `RIGS`, and every rig in `RIGS` has a step in the
workflow — failing with **"A rig nobody runs is not a rig. Add a step for each,
or remove it from RIGS."** Read that beside the diagnosis above and the pair is
the whole entry: one line names the failure, the other refuses to let it recur.
Both halves are the point. A rig that catches this class of defect is worth more
than a paragraph asking people to remember it, and any app growing a rig suite
should copy the manifest check rather than the habit.

**Status.** PR #399 (branch `ops-rig-repairs`) is in flight as this is written;
it registers the unrun rigs, closes the two mis-asserting ones, and adds the
manifest check. The findings above are properties of the tree at `220f7e7` and
stay true whatever shape that PR lands in.

**Attribution, corrected once in the writing of this entry.** The two
`test-tray-*` findings are bento-team-home-ios's, with bento-team-home-android
hitting the same class from the other side. The three unrun rigs and both quoted
lines came through #399 and are **bento-team-ops'** — an earlier draft of this
paragraph credited the whole finding to home-ios, which was wrong. Worth
recording how it was settled, because it will come up again: `git log` cannot
answer it. Every session on this repo commits as the maintainer, so authorship
metadata resolves to one person for all of us; the zone and the branch are the
only evidence that distinguishes anybody. Cite the PR, which is checkable, over
the session, which is not.

**The `CLAUDE.md` counterpart is not discharged by this entry.** The two-minute
check belongs in the file people read BEFORE writing a rig; this log is what
they read after wondering why a standard exists. That text is queued for the
maintainer.
## 2026-08-29 — the locale list leaves the prose; docs point at LOCALES

**The rule that named the languages was wrong for a month and cost a shipped
app a language.** `AGENTS.md` rule 6 listed seven catalogues (ja, zh-Hans,
zh-Hant, es, fr, de, it) and `CLAUDE.md` said "7 locales"; Portuguese was added
2026-07-25 and the docs did not follow. PR #394 added `type/src/i18n/` with
seven catalogues and no `pt.ts`, and hard-coded the seven-locale list into its
new build script. That session followed the written rule exactly. The rule was
the defect.

**So no document states the list any more.** Rule 6 and the `CLAUDE.md` i18n
entry now name where the list lives — `LOCALES` in the app's
`scripts/build-*-i18n.mjs`, with `ls <app>/src/i18n/` as the check — and carry
the failure story, because a rule without one gets deleted by whoever finds it
inconvenient. A count in prose is verified by nothing and is the only copy that
can rot unnoticed; every other copy is load-bearing and fails visibly.

**Three copies, not one, and the number is growing.** Adding a locale touches
the catalogue file, the app's `LOCALES`, and any rig holding its own list.
Saying "point at the build script" is true and incomplete: it leaves a rig's
copy stale, which is what goes red. Measured on 2026-08-29:

| | slides | spaces | type (#394) |
|---|---|---|---|
| `LOCALES` in build script | 8 | 8 | 7 |
| catalogue files | 8 | 8 | 7 |
| extra-file guard | **yes** | no | no |
| rig with its own list | no | no | **yes** |

**Only `build-i18n.mjs` errors on a catalogue missing from `LOCALES`.** On
spaces and type, adding a catalogue without touching `LOCALES` exits 0, prints
its locale count, and silently never packs the file — a translation that ships
to nobody, announced by nothing. That is worse than a red build. Porting the
guard to the sibling scripts is queued with ops and is not done here.

**A rig must derive the list, never restate it.**
`scripts/test-i18n-coverage.mjs` already does the right thing: it parses
`PACKED_LOCALES` out of the generated `packed.ts`, so it cannot disagree with
the build. #394's `test-type-i18n.ts` hard-codes a second list instead. The
existing rig is the pattern to copy; a derived list is a copy that cannot rot.

**Not fixed, deliberately:** this log's 2026-07-24 entry says "App UI i18n
(7 locales)". It was true when written — one day before the entry that added
Portuguese — and this log is append-only. It stays. Anyone grepping for stale
counts will hit it; that is the cost of an honest record, not a defect.

**The general rule, because this is not really about locales.** A count in
prose is verified by nothing. Three files stated one today — `AGENTS.md`,
`CLAUDE.md`, `docs/PARALLEL-WORK.md` — all three were true when written, all
three went stale in silence, and one of them cost a shipped app a language.
**Name the mechanism, never its current output:** the mechanism survives edits,
the output has a half-life. That extends to this log — an append-only entry
cannot be corrected, so a number belongs in one only when it is FROZEN. The test
before writing one down: *could this change without the entry becoming wrong?*

**A number is frozen by its framing, not by its value.** "Eleven cases went
untested" is safe: it reports something that already happened and stays true
forever. The same figure asserted as a standing fact — "there are eight
catalogues" — is not, because the next locale makes it a lie nobody can edit.
The table above says 8 twice and is safe for exactly this reason: it is stamped
`Measured on 2026-08-29` and says the number is growing, so it reads as a
reading taken at a moment rather than a claim about the present. Date a
measurement and it becomes evidence; leave it undated and it becomes a fact with
an expiry nobody sees. **The rule is not "avoid numbers" — that is unusable
advice — it is "never write one that is still claiming to be current."**

This is the same failure recorded elsewhere today from the rig side — a
statement that was true when written, went stale without a sound, and had
nothing checking it. Documentation and a green test suite fail identically here,
and for the same reason: both are instruments, and an instrument nobody
calibrates is believed longest.

## 2026-08-29 — OPEN QUESTION: `pt` is two different languages in the suite

**Not a decision. A question recorded because no rig can ask it.**

**The facts, counted on 2026-08-29.** Both files are named `pt.ts` and both are
correctly named, so every mechanical check passes:

| | `arquivo` | `ficheiro` | `tela` | `guardar` | header declares |
|---|---|---|---|---|---|
| `slides/src/i18n/pt.ts` | 47 | 10 | 33 | 4 | Portuguese (**Brazilian**), explicit pt-BR terminology policy |
| `spaces/src/i18n/pt.ts` | 9 | 58 | 3 | 7 | "Portuguese", no policy |

So slides is Brazilian by declaration and spaces drifted European, under one
locale code. A user running the suite in Portuguese meets two vocabularies.
`type` followed slides while adding its catalogue and normalised the strings it
reused.

**The intent was Brazilian, but it was never written as a rule.** The
2026-07-25 bundling entry adds Portuguese "because Brazil has a real
English-proficiency gap"; `slides/src/i18n/pt.ts` states a pt-BR policy in its
header and notes that European Portuguese "deserves its own catalog later".
Neither is a suite-wide policy, and `spaces/` shows what happens without one.

**Why this cannot be a rig.** The drift is vocabulary under an identical locale
code. There is no signal to assert on short of a term blocklist per variant,
and even that is not sufficient: bento/type reports that one reused string
passed a `ficheiro`/`guardar`/`ecrã` sweep while remaining European in
construction ("cada vez que guarda", "num computador") and had to be rewritten
by hand. **A term-level sweep is not a conversion.**

**Not clean anywhere, which is why this is a question and not a cleanup.**
Slides violates its own stated policy 10 times (`ficheiro`) plus `guardar` and
`ecrã`. Settling the question means retranslating a catalogue, which is
translation work and a maintainer's call, not a documentation change.

**What is actually being asked**, so it is not rediscovered:

1. Is bundled `pt` pt-BR for the whole suite? The recorded reasoning says
   Brazil, and two of three catalogues follow it.
2. If yes, `spaces/src/i18n/pt.ts` needs converting by hand and every catalogue
   should declare its variant in its header the way slides does.
3. Does European Portuguese become a downloadable pack (`pt-PT`), which is what
   the slides header anticipates and what the pack tier exists for?

Until it is answered, **a new catalogue for a language with regional variants
should state its variant in its header** and follow the sibling app that
already declares one.

## 2026-09-02 — slides: agent context & structural actions in the desktop terminal integration

**What shipped.** The desktop Electron shell's `claude`-in-terminal panel
(`terminalPanel.ts`/`slides-mcp-server.mjs`) gains ten new MCP tools alongside
the existing `get_slide`/`write_slide`:

- Five cheap read verbs — `doc_info`, `outline`, `measure`, `validate`,
  `comments` — round-tripping through ONE new file-pair channel,
  `agent-query`/`agent-query-result`, multiplexed by a `verb` field (mirrors
  `get_slide`'s request/response shape, generalized to many read operations
  instead of duplicating a watcher per verb).
- Five write verbs — `insert_elements`, `set_frame`, `duplicate_element`,
  `delete_element`, `reorder_element` — round-tripping through a second new
  channel, `agent-action`/`agent-action-result`, same multiplexing, dispatched
  by `editor.ts`'s `applyAgentAction` (a SIBLING to `applyExternalEdit`/
  `applyExternalSlideWrite`, which are unchanged). Every write verb is one
  undo step, refuses on encryption or read-only, and a success carries
  `warnings` — a `validateDoc()` pass filtered to the touched slide — so an
  agent sees an off-canvas or overflowing result without a second round trip.
- `insert_elements` reuses the clipboard trust boundary exactly:
  `clipboard.ts`'s `parseClip(text)` is now `parseClipPayload(raw)` (the
  rebuild logic) plus a thin string-parsing wrapper that keeps `parseClip`'s
  signature unchanged for the OS-clipboard caller. An agent's element specs
  go through the identical untrusted-fragment sanitizer a paste does — no new
  trust boundary. `insertElements` gained `opts.nudge` (default `true`,
  unchanged for the paste caller) so an agent that already measured an exact
  frame can skip the paste-only +20,+20 offset.
- `Comment.forAgent?: boolean` (model.ts, additive) — set via an `@ai `/`/ai `
  prefix in `comments.ts`'s new-comment prompt (stripped from the saved
  text), or toggled later from the thread footer. `window.bento.comments()`
  and the new `comments` MCP verb both call one shared implementation,
  `model.ts`'s `commentEntries(doc, filter?)`, so the two surfaces cannot
  disagree about shape or filtering (`{resolved?, forAgent?, slideId?}`).

**The 2026-08-28 "agent-facing copy is not stripped" open question is now
settled for slides** (still open for spaces/dash/type — this was a
single-app task, not the cross-app decision that entry asked for): the
platform gained the accessor that entry proposed. `editor.ts`'s private
`stripCollabSecrets` is now exported, and a new `docForAgent(doc)` (deep-clone
+ strip) is wired onto `window.bento.docForAgent()`. `.doc`/`.serialize()`
are UNCHANGED (still raw/session-carrying — correct, per that entry's "not
the bug" list) — `docForAgent()` is the additional safe path, documented as
the preferred one for handing the document to a chat model. Whoever settles
the cross-app question can point spaces/dash/type at the same pattern.

**Why one new channel per direction, not one per verb.** `terminalPanel.ts`
already had the pattern twice (`slide-request`/`slide-response`,
`slide-write`/`slide-write-result`) — a `fs.watch` per channel, filename
regex to detect a fresh request (with a negative-lookahead to not mistake the
app's own response file for one), debounce per filename, IPC to the
renderer, IPC back from the renderer, delete the request file. Ten new verbs
as ten new channels would be ten copies of that plumbing; one channel per
DIRECTION with a `verb` field inside the payload is the same shape
`write_slide` already established (a `cmd` object the handler switches on)
and keeps `PanelState` from growing a field pair per tool forever. A future
verb is a new `case` in `respondAgentQuery`/`applyAgentAction` plus a new
`TOOLS` entry — no new watcher.

**Verification.** `tsc -b` clean in both apps; `npm run build:single`
(slides) and `npm run build` (desktop, electron-vite) both clean;
`node scripts/test-export-secrets.ts` and `node scripts/shell-gate.mjs`
both pass against the built shell; the desktop Electron binary launches
(macOS GUI) with no crash. The MCP server was driven directly over stdio
JSON-RPC (spawned as a child process, contextDir simulated) to prove
`tools/list` carries exactly the 12 expected tools and that a query and an
action verb both round-trip through the real file-pair mechanics, including
the timeout path. NOT verified: an actual `claude` CLI session driving these
tools inside a live Electron window (no interactive display-driving tool was
used this session) — the wiring was proven at the layer below that (build +
direct MCP-protocol exercise), not inside a running end-to-end session.

## 2026-09-02 — session-scoped exception to "no AI co-author trailers"

`AGENTS.md` rule 8 and this doc's own §8 ("What agents never do") say commits
must never carry an AI co-author trailer or bot identity — added 2026-07-24
specifically to keep git history free of that. The five-worktree feature wave
merged into `main` on this date (agent-actions MCP verbs, the standalone
element-library document, alignment/distribute improvements, the menu-
positioning fix + color-picker redesign, and safe-zone margin guides) was
built under a Claude Code session whose own system-level instructions mandated
a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` + session-link
trailer on every commit. The repo owner was asked directly which rule should
win for this body of work and chose the session directive: every commit in
this wave, and in the five branches it merged, carries that trailer.

**This is a one-time, explicitly authorized exception, not a change to the
rule.** `AGENTS.md` rule 8 and `PARALLEL-WORK.md` §8 stand as written for all
other work — an agent hitting the same conflict later should ask, not assume
this entry extends to it.

## 2026-09-02 — per-worktree dev port convention

`.claude/launch.json` and `scripts/dev-all.mjs` hardcode `slides-dev` at
`:5199` and `serve-built` at `:5198`, both `--strictPort` — fine for one
checkout, but the five-worktree feature wave above needed several `npm run
dev` instances live at once and nothing in the repo assigned them distinct
ports. Ports used for that wave, recorded so the next multi-worktree session
doesn't have to reinvent this: `feature/agent-actions` 5200/5201,
`feature/element-library` 5202/5203, `feature/alignment-tools` 5204/5205,
`feature/menu-and-panel-ux` 5206/5207, `feature/safe-zone-guides` 5208/5209
(`dev`/`serve-built` pairs respectively, via `npm run dev -- --port <N>
--strictPort`). Not a standing rule — just the scheme this wave used, offered
as a default for the next one rather than a fresh guess each time.

## 2026-09-02 — known gap: new arrange/safe-zone/menu UI strings are not yet catalogued

The merge above wraps several previously-plain-English UI strings in `t()`
for the first time (`panels.ts`'s arrange row — Align/Distribute/Order labels
and the new mode controls; `editor.ts`'s View menu — "Safe zone guides",
"Check deck", and their hint text) but does not add matching entries to any
of the 8 core catalogs or 22 packs, and `packed.ts` was not regenerated to
include them. `scripts/test-i18n-coverage.mjs` still reports 100%/OK because
it reads the key universe from `packed.ts`, not from a source-code scan — an
unregistered key is invisible to it, not merely "missing." At runtime this is
harmless (`t()`'s documented fallback: an unknown key renders as its own
English text, exactly like a missing key would), but it is a real, tracked
violation of `AGENTS.md` rule 6 ("new UI strings must be added to ALL
catalogs") that three of the five implementing sessions flagged independently
rather than hand-writing unverified translations into 8+ languages. Follow-up:
run `node scripts/build-i18n.mjs` to fold these strings into `packed.ts` (this
will flip the core-catalog gate from silently-passing to correctly-failing
until real translations are added — expected and desired), then translate.

## 2026-09-02 — the same i18n gap recurred in wave 2; this time closed by hand

The pattern above repeated: two of three wave-2 implementing sessions
(`feature/master-fixes`, `feature/sections`) wrapped new UI strings in `t()`
— the master-link badge/banner text, the section create/rename/collapse/
delete/drag UI — without adding catalog entries, the identical omission
flagged 2026-09-02 above. Only `feature/slide-variants` followed the
convention unprompted. Since each implementing session was told about the
convention directly in its task brief and still missed it, this is not a
one-off — plan for it: either budget a dedicated translation pass after
every merge wave (what happened here — 15 strings hand-translated into all
8 core catalogs, `packed.ts` regenerated, core coverage back to 100%), or
stop relying on per-agent diligence and add a CI-visible check that flags
any `t('...')` call site whose exact string is absent from every catalog
(the coverage gate today can't see this — it reads `packed.ts`, which is
only as complete as whoever remembered to run `build-i18n.mjs`).

## 2026-09-02 — `Section`: boundary marker, not a per-slide tag

Sections (`slides/src/model.ts`) needed a shape for "these N contiguous
slides are named group X." Chose `Section { id, name, startSlideId }` — a
marker naming where a section *begins*, with membership derived by walking
`doc.slides` in order until the next section's start (or the end) — over the
seemingly simpler `Slide.sectionId?` per-slide tag. Reason: a per-slide tag
requires an invariant ("all slides sharing a `sectionId` form one contiguous
run") the type system can't enforce, and every insert/duplicate/paste/
drag-reorder call site would have to actively maintain it — the exact bug
shape already found once in this codebase (`layoutId` cleanup handled on one
delete path, not the other; see the 2026-09-02 entry above this one's
sibling, "Fix dangling layoutId"). With a boundary marker, ordinary
insert/duplicate/paste/reorder need **zero** `doc.sections` writes — a
slide simply inherits whichever section already covers its array position.
Explicit updates are needed only where a boundary itself changes: deleting a
`startSlideId` slide (reassign to the next survivor, or drop the section),
and deliberately moving a slide across a boundary. Read via
`sectionsInOrder`/`sectionOf`/`sectionRange` in `model.ts`, never by indexing
`doc.sections` directly — a `startSlideId` can dangle (a slide deleted by a
path older than this field, or a hand-edited file) and is treated as "no
section," never an error.

## 2026-09-02 — `role: 'media'`: a layout placeholder that isn't type-locked

Every layout placeholder role before this (`title`/`subtitle`/`body`/
`kicker`) requires the donor element to share the placeholder's exact type —
fine for text, useless for "there's a picture here," since a slide might
carry an `image`, a `chart`, or a `table` in that spot depending on what the
author actually made. `role:'media'` (`slides/src/model.ts`, `applyLayout`)
is deliberately type-agnostic: it matches ANY unconsumed donor whose type is
in `{image, media, chart, table}`, document order, and — when the donor's
concrete type differs from the placeholder's own (the common case, since
`mediaPh()` placeholders are always a plain bordered `shape`) — the output
element ADOPTS the donor's full type and content but keeps the placeholder's
id/frame/rotation/role, so morph lineage tracks the SLOT across slides born
from the same layout, not whichever concrete element happened to fill it.
Purely additive: no shipped layout or slide used this role before, so
nothing about existing decks changes.

## 2026-09-02 — decouple from bento.page: self-update, live collaboration, and language packs deleted outright

This is PR 1 of a two-PR decoupling (PR 2 is the bento→slidomingo rebrand,
tracked separately). The user's own words: *"remove bento.page we want to
decouple and even re[m]ove that part fully"* / *"Rip the features out
entirely."* Confirmed twice, including after this document's own §5/§6
"FROZEN" framing (in the pre-2026-09 revision of `docs/PLATFORM.md`) was read
back to them — the answer was still delete, not deprecate.

**What was removed, not renamed, not feature-flagged:**

- **Self-update checking** — `kernel/src/update.ts`, `slides/src/update.ts`,
  the release-signing tooling (`scripts/sign-release.mjs`,
  `scripts/keygen.mjs`, `scripts/sign-payload.mjs`,
  `scripts/lib/release-sign.ts`), `scripts/test-release-channel.mjs`, the
  topbar update chip, the Settings → Updates category (auto-check toggle,
  manual "Check for updates", the "Updated to vX" post-reload banner). The
  Offline mode checkbox — it also gates remote media, not just updates — was
  relocated into the Settings → General category, since Updates no longer
  exists as a home for it. `AppConfig.manifestUrl` is gone from
  `kernel/src/app.ts`; `APP_VERSION` moved there (it still backs the plain
  About-panel version string). `offlineEnabled`/`setOffline`/`OfflineError`/
  `startNetGuard` — previously re-exported through `update.ts` — are now
  imported directly from `kernel/src/net.ts` everywhere.
- **Live E2EE collaboration/sync ("bento-sync")** — the whole CRDT engine
  (`kernel/src/sync/{crdt,session,online,blobs}.ts`, 3,678 lines) and its app
  facades (`slides/src/sync/*`), the Cloudflare Worker relay (`server/` —
  deleted in full, it held nothing else), the Share popover (invite/People
  list/rotate keys/stop-go-live), the canvas's collaborator-presence overlay
  (colored cursors/name tags), and `doc.collab`/`doc.blobs` from the document
  format itself (`slides/src/model.ts`). "Save read-only copy…" (the live
  viewer tier) and "Invite to edit…" are gone with it — they had no meaning
  without a live session to follow. "Present-only file…" and "Template…",
  which used to live in the Share popover alongside the collab-only actions,
  were relocated into the plain Save-as list (`buildSaveAsItems` in
  `editor.ts`) since neither one is actually a collaboration feature.
  `editor.ts`'s `stripCollabSecrets()`/`docForAgent()` and
  `window.bento.docForAgent()` (main.ts) — added to strip live-session
  credentials before handing a document to an AI agent — were simplified:
  `stripCollabSecrets` is gone (nothing to strip once `doc.collab` doesn't
  exist), and `docForAgent()` is now a plain deep clone, kept only for API
  stability so existing agent tooling that calls it doesn't break.
- **Downloadable language packs** — `slides/src/packs.ts`, the 22 pack-only
  catalogues under `slides/src/i18n/packs/` (ar, bn, da, fa, fi, he, hi, id,
  ko, ms, nb, nl, pl, ru, sv, th, tk, tl, tr, uk, ur, vi — preserved in git
  history), and the Settings → Languages category (which was entirely pack
  management — "In this file"/"Available to add" browsing, install/remove).
  `kernel/src/i18n.ts` kept its core `t()`/`select()`/locale runtime and the
  bundled key-once `PACKED` catalog machinery — only the runtime pack-loading
  API (`LanguagePack`, `addPack`/`removePack`/`loadedPacks`, the `PACKS` map)
  came out. The topbar globe dropdown (`languageDropdown()`) stays as the one
  remaining language-switching UI, minus its "Manage languages…" entry point.
  The 9 bundled locales (en + ja, zh-Hans, zh-Hant, es, fr, it, de, pt) are
  what a file offers now; there is no on-demand tier.

**Breaking, deliberately.** Every already-shipped `.bento.html` file that
relied on any of these three features degrades on next open: an old file's
embedded self-update code simply has nothing to talk to (it was always a bare
GET the user triggered; nothing calls out on its own), a file carrying
`doc.collab` opens as an ordinary standalone document (the field is unknown
to the new parser and is preserved-but-inert per the additive-fields
invariant, never acted on), and a file carrying a spliced-in language pack
block loses that language on next save (the block type is no longer in
`registerShellBlocks`'s managed set, so a save simply stops re-declaring it —
same mechanism the kernel already uses for "this file should carry no
language pack").

**`registerShellBlocks`/`readShellBlocks` (kernel `save.ts`) were kept**, not
deleted, even though `packs.ts` was their only caller. They are genuinely
generic (id/type/body, no pack-specific logic) and small — reopening the
splice-contract internals to remove them mid-PR was judged not worth it. If a
future block type never materializes, that's a later, separate cleanup.

**`writeBackupBeside`/`SavePurpose:'backup'`/`pickerIdFor('backup')`
(kernel `save.ts`) are now unused** — they existed solely for self-update's
rollback-copy step. Left in place rather than deleted: `save.ts`'s splice
contract is deliberately PR 2's most sensitive hand-edit
(`docs/PARALLEL-WORK.md`'s kernel-zone rule), not something to reopen twice.

**Docs**: `docs/collab-design.md`, `docs/relay-design.md`,
`docs/blob-offload.md`, `docs/i18n-packs.md` deleted (git history keeps
them for anyone auditing this decision). `docs/PLATFORM.md` lost its old §5
(Collaboration) and §6 (Signed self-update) outright and renumbered the
sections that followed; the i18n section dropped the "two tiers"/pack-rules
framing and kept only the bundled-core-catalog paragraph. `docs/security.md`
was rewritten from a live-collaboration threat model down to the password-
encryption + offline-mode content that is still true. `docs/architecture.md`,
`docs/format.md`, `README.md`, `AGENTS.md`, `docs/PARALLEL-WORK.md`, and
`docs/README.md` had their collab/relay/self-update/pack sections trimmed or
replaced with a short pointer back to this entry. **The bulk of `CLAUDE.md`
and the directory-scoped `slides/src/CLAUDE.md`/`slides/src/editor/CLAUDE.md`
were deliberately left untouched** — they are extensive, actively-referenced
architecture guides far beyond this PR's scope to rewrite by hand; they still
document `src/update.ts`, `src/sync/`, and the three file-mode tiers as they
were. Only the root `CLAUDE.md`'s now-dead pointer to the deleted
`slides/src/sync/CLAUDE.md` was removed, since a broken file link is a direct
mechanical consequence of deleting that directory, not a judgment call.
Whoever does PR 2's rebrand pass, or a dedicated follow-up, should reconcile
the rest.

**Confirmed pre-existing and explicitly out of scope**: `scripts/release.mjs`,
`scripts/test-publish-gate.mjs`, `scripts/test-relay-protocol.ts` (deleted
here anyway, being sync-specific), and `scripts/test-release-apps.mjs`
already referenced siblings that don't exist in this decoupled repo
(`spaces/`, `dash/`, `site-src/`, a guestbook deck generator) before this PR,
and there is no `.github/workflows/ci.yml` in this repo running any
`scripts/test-*` rig at all — `scripts/test-ci-registered.ts` fails on that
basis alone, unrelated to anything touched here. This PR did not attempt to
fix that; it removed only the parts of it specific to the three deleted
features (the sign-release/sign-packs invocation blocks in `release.mjs`, the
`app.packs` field and its test assertion).

**Also deleted as a direct, unambiguous consequence of the above** (not a
scope expansion — each had no remaining caller once its subject was gone):
`scripts/sign-packs.mjs` (its only dependency, `sign-payload.mjs`, was
deleted with self-update), `scripts/test-export-secrets.ts` (tested
`stripCollabSecrets`, which no longer exists), the `collab-secrets-present`
validate.ts finding and its test-validate.ts coverage, and the self-update
test fixtures `scripts/lib/tray-release-manifest.json` /
`scripts/fixtures/release-manifest-slides.json`.

Next: PR 2 renames every remaining `bento`/`Bento` identifier to
`slidomingo`/`Slidomingo` — format string, splice-contract id (deliberately
breaking the §2 "FROZEN" invariant, on purpose, confirmed with the user), MIME
types, file extension, `window.bento` → `window.slidomingo`, IPC channels,
localStorage keys, copyright headers. See the plan handed to the agent that
did this PR for the full mapping; it is not re-derived here.

## 2026-09-02 — Layout Manager: `doc.master`, and reparenting instead of a second SlideCanvas

Added a standalone full-screen Layout Manager (`slides/src/editor/layoutmanager.ts`)
covering building blocks (shared elements composited into every slide type),
slide types (today's `doc.layouts`, now with a default-type marker), and
document properties — replacing the old mode-bar "Layouts" toggle, which is
now fully removed (`buildModeBar`/`enterLayoutMode`/`exitLayoutMode`/
`selectLayout`/`newLayout`/`deleteLayout`/`renderLayoutSidebar`/
`disableInLayoutMode`/`updateModeChrome` all deleted from editor.ts; `doc.layouts`
and `instantiateLayout`/`applyLayout`/`removeLayout` are unchanged and reused).

**New model field is `doc.master`** (`{ buildingBlocks: Slide; defaultLayoutId?: string }`),
not two flat sibling fields — it reuses the "Slide Master mode" vocabulary
`store.ts` already had for `doc.layouts` editing, rather than inventing a
colliding name. `doc.layouts` itself never moves or changes shape.

**The overlay REPARENTS the main editor's existing `canvasWrap`/`propsHost` DOM
nodes (and their one live `SlideCanvas`/`PropsPanel` instance) into itself,
rather than constructing a second `SlideCanvas`/`PropsPanel` pair as an
earlier draft of the plan proposed.** `canvas.ts` registers several
document-level keydown handlers (Delete, space-pan, …) in its constructor;
two live instances reading the same `Store` would both react to the same
key event against whatever `store.slide` currently resolves to, double-
firing those handlers. Reparenting keeps exactly one instance of each,
exactly as Slide Master mode already worked — `store.editingSurface`
(generalized from the old `editingLayoutId`) redirects `store.slide`, and
`SlideCanvas`/`PropsPanel` already redraw themselves generically off
`store.on('current'|'doc', …)`, so no new plumbing was needed for either
the building-blocks canvas or a slide-type's sub-editor. The present/zoom
corner cluster that lives inside `canvasWrap` is hidden with an inline
`style.display = 'none'` while reparented — `.hidden`/the `hidden` IDL
property does NOT work here, because `.ed-corner-br` sets `display: flex`
unconditionally in the stylesheet, which (equal specificity, later in the
cascade) beats the UA `[hidden]{display:none}` rule; only an inline style
wins over it.

**Building blocks propagate through the existing bake-and-resync idiom**
(`effectiveLayout(doc, layout)` composites `doc.master.buildingBlocks.elements`
underneath a layout's own before it reaches `instantiateLayout`/`applyLayout`/
`renderThumbnail`), not a new render-time inheritance layer — see
`slides/src/CLAUDE.md`'s Layouts section for why (the "locally-tweaked font
can silently revert" tradeoff already exists and is documented there; this
doesn't add a new one). `layoutElementIds(doc)` was extended to also union in
building-block element ids, so deleting a building-block element is retired
by `applyLayout`'s existing stale-leftover rule on the next resync — no new
cleanup path. `removeLayout(doc, id)` was extended to retarget/clear
`doc.master.defaultLayoutId` when the deleted layout was the default — the
one shared delete path, per the dangling-`layoutId` bug this repo already
hit once (see the Layouts section of `slides/src/CLAUDE.md`).

`kernel/src/convert/pptx.ts`'s `coreTitle()` gained a sibling `coreMeta()`
that also pulls `dc:creator`/`cp:keywords`/`dc:subject` from `docProps/core.xml`
and `Company` from the SEPARATE `docProps/app.xml` part (extended-properties
namespace, not core-properties) — `OutDoc.meta` is a new optional field,
additive, carried through unchanged by both `applyPptxImport` and the
"use as template" pptx-import flow's existing `{ ...result.doc, … }` spreads.

## 2026-09-18 — Fix: insert toolbar dead on every fresh load (`this.canvas` captured undefined)

`editor.ts`'s `build()` called `buildWebTopbar()`/`buildDesktopChrome()`
BEFORE assigning `this.canvas = new SlideCanvas(...)`. Both wire the shared
insert toolbar via `insertgroup.ts`'s `buildInsertGroup(store, canvas)`,
which captures `canvas` BY VALUE into each button's click closure —
`this.canvas` was still `undefined` (`private canvas!: SlideCanvas`, a
type-only declaration) at that point, so every insert button (Text, Shape,
Image, Media, Table, Chart, Code, Embed, Icons, Library, on both the web
topbar and the desktop ribbon) threw `Cannot read properties of undefined
(reading 'insert')` on first click, on every fresh session, until
something else happened to re-run `build()` (e.g. a language switch heals
it, since `this.canvas` is real by then). Introduced by
`dbcffc454` ("Layout Manager: full element insertion in Building Blocks &
Slide types," 2026-09-18), which extracted `insertgroup.ts` and wired it
into the main toolbar for the first time — `tsc` can't catch this (that's
what the `!` assertion suppresses), and it's the kind of thing only an
actual click surfaces.

**Fix**: `build()` now constructs `canvasWrap` and
`this.canvas = new SlideCanvas(canvasWrap, this.store)` FIRST, before
calling `buildWebTopbar()`/`buildDesktopChrome()`. `canvasWrap` is still a
detached DOM node at that point — it's appended to the live document later
in the same synchronous `build()` call (`this.root.append(bar, main)`),
before anything (an event, a render) can run against it, so nothing about
DOM-attachment timing changed, only JS construction order. Verified live
(headless Chromium, fresh page load, zero prior interaction): Text/Shape/
Code inserts all work on first click with no console errors.

## 2026-09-18 — Element hierarchy: container + flat derived children, not a nested tree

Added the first element-level hierarchy: a **container** (`ShapeElement`
with `shape:'rect'` and a new `container?: boolean` flag — reusing the
existing shape rather than a dedicated element type, for free fill/stroke/
corner-radius/gradient UI and to avoid duplicating near-identical branches
across render.ts's type switch, `untrusted.ts`'s sanitizer, and panels.ts's
type-specific sections). Two rounds of exploration confirmed there is no
existing hierarchy precedent at the element level, and that the closest
working analogue — connector `from`/`to` refs, resynced by
`editor.syncConnectors()` on every `'doc'` event — is a genuine template:
one element's geometry derived from another's, on a flat array, recomputed
idempotently, never a stored tree. **Children stay ordinary flat
`slide.elements` entries, never nested inside the container's own data** —
a true nested tree would have touched render.ts, canvas.ts's Moveable
geometry math, morph pairing, `applyLayout`'s donor-matching, and clipboard
remapping, all of which currently assume one flat per-slide array.

**Model** (`model.ts`): `ElementBase` gains `parentId?: string` (the
container's id) and `parentOffset?: {relX,relY,relW,relH}` (fractions of the
parent's box at grouping time). `x/y/w/h` stay the single source of truth
read by render/morph/`applyLayout`/clipboard; `parentOffset` is only ever
read by the new derive pass.

**`editor.syncContainers()`** (`editor.ts`, modeled directly on
`syncConnectors()`): for every element with `parentId`, drops `parentId`/
`parentOffset` if the parent no longer exists (the element keeps its last
absolute position — this is how deleting a container "orphans" children for
free, no cascade-delete code needed), else recomputes `x/y/w/h` from
`parent box × parentOffset`, writing back only past a 0.5px float-churn
guard (same threshold `syncConnectors` uses). Registered on `store.on('doc',
…)` BEFORE `syncConnectors` so a connector anchored to a container child
sees the child's just-resynced box, not a stale one. Same accepted
limitation as `syncConnectors`/`syncLayoutInstances`: only the currently
open slide is resynced, not every slide doc-wide.

**Live-drag/resize cascade** (`canvas.ts`): derive-on-commit alone only
fires at gesture END, which would read as broken for a container's
headline interaction (drag/resize the frame, watch children follow) even
though it's an accepted cosmetic gap for a thin connector line. Fix: reuse
the existing multi-target group-drag machinery
(`dragGroup`/`resizeGroup`/`rotateGroup`, `commitDomFrames`). When
selection is exactly one container, `syncTargets` feeds
`[containerNode, ...its children]` into `moveable.target`
(`containerCascadeChildren()`) — Moveable's own group math gives real-time
visual cascade for free, and `commitDomFrames` (extended with an optional
`cascadeContainerId`) writes every node's final box back per-element at
gesture end, re-deriving `parentOffset` from the newly-committed boxes.
**Rotate deliberately does NOT cascade in v1** (rotating a container's
frame does not rotate children around it — v2 territory): since Moveable
ties drag/resize/rotate to the same `target` array, a lone
container-with-children selection makes ALL three gestures fire as "Group"
variants, so `rotateGroupStart` snapshots which target ids are cascade
children (`rotateCascadeChildIds`) and the `rotateGroup` handler skips
transform updates for exactly those ids — live and at commit (commit for a
rotate end reads only `this.selectedNodes()`, i.e. just the container,
since children were never added to `store.selection`).

**`applyLayout` donor-exclusion guard** (`model.ts`, ~1259): a container's
children are excluded from the donor pool outright
(`slide.elements.filter((e) => !e.parentId)`) — if a child carries `role`
(plausible: a "content" container holding a title+body is exactly the
placeholder-role use case), re-applying a layout would otherwise silently
scatter them into fresh top-level placeholder frames and drop `parentId`,
while the container survives as an empty leftover. The leftover pass was
widened from iterating the (now-filtered) donor pool to iterating
`slide.elements` directly, so excluded children still ride along unchanged
via the ordinary "user extras stay" rule.

**Clipboard/duplicate id-remap** (`clipboard.ts` `insertElements`,
`panels.ts` `duplicate()`): both now build an id map (old id → new id)
while minting fresh ids, then rewrite `parentId` through it — a parent not
part of the same paste/duplicate batch is dropped rather than left
pointing at the ORIGINAL container still in the doc (which would silently
re-parent the paste/clone onto it). `insertElements` also gained the same
treatment for `groupId` (a real, if smaller, pre-existing gap: system-
clipboard paste never remapped it, unlike in-app `duplicate()`, so pasting
a grouped selection used to silently re-merge into the original group) —
bundled into this commit since the exact same id-map machinery was already
being added for `parentId`.

**Editor UX** (`panels.ts`): "▭ Group into container" (1+ elements, none
already a container — computes a padded bounding box, inserts the
container, splices it directly before its new children so unrelated
siblings keep their z-order), "▭ Ungroup container" (dissolves — clears
every child's `parentId`/`parentOffset`, leaves the container shape in
place), "▭ Add to container" (gated to exactly one container + one
non-child element selected together), "▭ Remove from container" (detaches
without dissolving — mirrors the "Unlink from layout" precedent, not
connectors' implicit drag-to-detach, since a container's `parentId` is a
durable pointer). Deleting a container that would orphan children (not
also being deleted with it) confirms first via the same
`window.confirm`/impact-text idiom `slidesDeleteImpact` established for
slide deletion. **v1 hard-blocks nesting**: "Group into container" refuses
a selection that already includes a container; "Add to container" refuses
a target that is itself a container or already a child.

**Visual affordance**: an unselected container gets a dashed outline + a
small "▭" corner glyph (decorative, not translated text — deliberately
avoids adding an i18n dependency to the shared `render.ts`), scoped to
`.ed-stage-scale [data-container="1"]` in styles.css so it shows only in
the editing canvas, never in thumbnails/present/print.

**Explicitly deferred to v2** (not silently dropped): multi-level nesting;
clipping children to the container's bounds; container rotation cascading
to children; presentation-mode `fx`/`group`/hover-focus inheritance from
parent to children; contiguous z-order enforcement across arbitrary
`reorder`/`step` operations; morph-across-slides-with-different-container-
membership edge cases; any element type other than `shape:'rect'` becoming
a container.

**Known, accepted risk**: like `syncConnectors`, `syncContainers` only
resyncs the currently open slide — a remote collab op moving a container on
a slide nobody has open locally leaves that slide's children un-derived
until someone visits it or presents. Inherited debt, not new.

## 2026-09-19 — Layout Manager master management (duplicate/reorder/relocate-delete)

Slice C of the "Layout Manager, second improvement pass" plan
(`slides/src/editor/layoutmanager.ts`). Three additions to the Building
Blocks pane's master bar:

**`moveLayout` generalized to `moveItem<T>`** (was `Slide[]`-only, backing
the Slide Types grid's drag/`‹›` reorder) — now also backs the master pill
strip's drag-to-reorder (`doc.masters` reordering). Any other agent needing
to reorder a flat array in this file (e.g. `doc.reusableObjects`, which has
no grouping) should reuse this rather than reintroducing a duplicate
splice-helper.

**Duplicate master is a hard fork, never id-preserving** — unlike
`newSlideType()`'s clone-a-layout path (kept ids so morph/apply-by-lineage
still works across an internally-cloned slide type; verified by reading
that it does NOT in fact remint element ids, contrary to an earlier
assumption in the plan this was built from), `duplicateMaster(sourceId,
includeLayouts)` mints a fresh master id, fresh building-block element ids
(`mergeLayoutFamily`'s existing reminting approach, reused verbatim), and —
when `includeLayouts` — a fresh id and freshly-reminted element ids for
every cloned slide type, each explicitly set to the NEW master's id. A
duplicate is deliberately an independent copy, not a variant/fork
relationship that should ever resync with its source.

**Delete relocated from a buried button in the per-master settings form to
a "×" directly on each pill** (only rendered with 2+ masters, which already
satisfies `deleteMaster`'s own last-master guard — no new gating logic
needed). Its `window.confirm` copy now explicitly calls out when the
target is the current implicit default (`doc.masters[0]` — see `masterOf`/
`ensureMaster`/render.ts's font cascade, all of which fall back to position
0), since deleting it silently promotes whatever's next into that role.

**Each pill also badges its live `linkedSlides(doc, {masterId})` count**
(hover lists the actual slide names) and position 0 carries a "Default"
badge — both purely additive UI, no `model.ts` changes. Deliberately NOT
wired to jump to Slide Sorter (mutually-exclusive overlays today; flagged
as a follow-up, not built).

## 2026-09-23 — Claude understands the Layout Manager; MCP transport without the 200ms debounce

**selection.json gains a `surface` block** (`{kind: slide|layout|reusableObject,
id, name, parentId, layoutManagerOpen, layoutManagerTab}`) and, while the
Layout Manager is open, a `slideTypes` list (`{id, name, parentId}`).
`slideId` is kept (still equals the open surface's id) so old readers work.
The file is also rewritten on Layout Manager open/close and tab change, not
only on `selection` events. The launch prompt (pty.ts `claudeInstruction`)
now says an empty selection on a `layout` surface means "the whole slide
type", and that a request naming a slide type targets it by id. This closes
the "incomplete wording" nit flagged in the 2026-09-20 part-4 entry: every
slideId-taking tool description now names slide-type ids.

**Agent writes to a slide type that is NOT the open surface resync its
linked deck slides themselves** (editor.ts `commitAgentWrite`, same undo
step). `syncLayoutInstances` only watches the open surface, so before this
an MCP edit to a slide type with the Layout Manager closed silently never
reached the deck. `edit.json` now resolves elements across slides, reusable
objects and slide types (same order as `resolveAgentSlide`), and
`warningsForSlide` adds the text-overflow check for non-deck ids
(validate.ts `overflowFindings`).

**uuid-named MCP request files are forwarded immediately, not debounced.**
Each is written once, atomically (MCP server: tmp + rename; main writes
responses the same way, `writeFileAtomic`), so the 200ms debounce bought
nothing. Duplicate fs.watch events are suppressed by `handledRequestFiles`
(forward-once), a torn read retries once after 20ms. `edit.json` and
`generate-result.json` keep their debounce (rewritten in place). The MCP
server waits on `fs.watch` with a 25ms poll fallback instead of a 150ms
poll, and logs `[slides-mcp] <verb> <ms>ms` to stderr. Measured ~50ms per
call (was ~350ms). Do NOT reintroduce a debounce on the request files
without also keeping forward-once — a double-dispatched write verb applies
twice.

## 2026-09-24 — Agent token diet: update_element, pushed context, 23 short tools

Measured on real `claude -p` runs against the real editor (headless) with the
real launch flags. "Make this title red" went from 5 tool calls / 6 turns /
22s (Read selection.json, grep format.md, get_slide, write_slide) to 1 MCP
call (`update_element`) / 3 turns / 9s. "For content slides add a footer"
went from 8 turns to 4, with a single `insert_elements` onto the slide type.

- **`update_element({slideId, elementId, props})`** is the default edit: a
  shallow patch, each key through `checkElementProp` (one bad key refuses the
  call), `null` removes an optional key, `id`/`type` fixed, html sanitized,
  committed via `commitAgentWrite` (slide-type resync + one undo step), lock
  gated. It supersedes `edit.json`, which is no longer advertised to Claude;
  its watcher stays for anything that still writes it.
- **Context is pushed, not pulled.** Each session launches with `--settings
  ./<sessionDir>/settings.json` (merges with the user's settings) holding a
  `UserPromptSubmit` hook, `node ./<sharedDir>/selection-digest.mjs`, whose
  stdout — one `[slidomingo editing context]` line: surface, selected
  elements (id/type/role/frame/text), sorter selection, slide types — is
  attached to every prompt. The hook prints nothing (exit 0) on any failure,
  so it can never block a prompt. selection.json now lists `slideTypes`
  ALWAYS (was: only while the Layout Manager is open), since "for content
  slides …" is asked from the deck view just as often.
- **Tool list 18.9k → ~8k chars** (25 → 23 tools): the four slide-type
  management verbs are ONE tool, `slide_type({op: rename|reorder|move|detach})`,
  mapped back to the unchanged app verbs inside the MCP server; descriptions
  keep only what a caller needs, rationale moved to agents.md's new "MCP verb
  notes". agents.md gained a top "Quick reference" the prompt tells Claude to
  read instead of format.md.
- **Compact JSON** from get_slide and every query/action verb (38% fewer
  chars over the 19 showcase slides). Default-stripping was skipped: there is
  no shared default table in model.ts.
- `insert_elements` accepts specs without an `id` (placeholder, reminted by
  the paste path anyway) — an id-less spec used to be dropped whole and cost
  a retry turn. The `validate` verb now honours the tool's top-level
  `measure`/`margin` (it read `args.opts`, so `measure:false` was ignored).

Not done, measured: `ENABLE_TOOL_SEARCH=false` removes Claude Code's
ToolSearch turn (red: 2 turns, 6s) but loads EVERY deferred tool, ~37k
tokens of context, not just ours — a global trade-off, left at the default.

## 2026-09-10 — No Quarto integration: a one-way `.qmd` importer instead

The question raised was whether slidomingo/slides should "use Quarto slides" or
grow an extension for Quarto's elements. Both framings are answered NO, and
this entry exists because another agent could plausibly reach for either.

**There is no extension tier to reach for.** `docs/DECISIONS.md`'s "No
extension system: compact per-app runtimes instead" already settles that the
only question about new capability is *core, separate artifact, or skill?* —
never a plugin. So "an extension for Quarto elements" is not an option that
was weighed and lost; it does not exist.

**The feature gap was never real.** slides already ships what scientific
authors go to Quarto for: `$…$`/`$$…$$` → MathML via Temml at RENDER time
(`slides/src/render.ts` `resolveMath`), and with symbol-level morphing that
reveal.js + MathJax cannot do; `code` as a first-class element with
75-language tokenizing (`kernel/src/tokenize.ts`) and line-level Heckel-diff
morphing (`slides/src/code.ts`); tables, speaker notes, layouts and masters.
Critically, **`.qmd` math syntax IS slides math syntax** — it passes through
verbatim and renders. So the gap was a one-way DOOR IN, not an engine.

**The requirement rules out every non-importer option.** The stated need was
"we still want to be able to manually modify stuff and use AI", which
disqualifies anything opaque. Specifically rejected:

- **A Quarto custom format / Lua writer.** That is the integration the question
  was unsure about, and it lives in another repo — it makes Quarto emit
  Slidomingo, which means the pipeline, not the document, is the product.
- **The `embed` element shortcut** (drop reveal.js into a sandboxed iframe).
  Inert on the canvas, in thumbnails and — decisively — in PDF export, capped
  at 64 KB, and it cannot morph. A screenshot with a heartbeat.
- **A block-level `richtext` element.** Would widen `sanitizeHtml`'s allowlist
  to block tags and reopen `format.md` invariant 3. The format has no
  block-level rich text on purpose.

**Running code is out, permanently, and costs nothing.** Quarto's engine
(knitr/Jupyter) runs BEFORE Pandoc for every output format, so
`quarto render --to markdown` already yields executed markdown with figures in
a sibling `_files/` folder. The importer consumes that (`opts.assets`), so
computation arrives with zero dependencies added and the "no toolchain, no
backend" invariant intact. An un-rendered `.qmd` still imports; its cells come
in as highlighted source and the report says, once, what to run.

### What landed

`kernel/src/convert/` gained three modules, following the .pptx precedent
exactly (pure `source → { doc, report }`, no DOM, no app imports, browser
primitives only): `md.ts` (block-level markdown + Pandoc fenced divs → a small
AST, plus inline → the b/i/s/code/br subset), `qmd.ts` (the orchestrator:
front matter, slide splitting, block→element mapping, the fidelity report) and
`mdlayout.ts` (coordinate synthesis). `types.ts` gained `OutCode`,
`OutSlide.layoutId`, `OutDoc.defaultLayoutId` and an `fx` subset on
`OutElementBase`; `media.ts` gained `imageSize()` and an `avif` mime. Nothing
in the .pptx path changed behaviour.

**THE ONE HARD PROBLEM was coordinates, and the answer is NOT a layout
engine.** Quarto is document flow; slides is absolute coordinates, and a `.qmd`
carries no `x/y/w/h` anywhere — inventing them *is* the job. A bespoke flow
engine would produce slides that look placed but cannot be re-themed or
re-laid-out afterwards, which fails the requirement above. Instead the six
`builtinLayouts()` designs are MATERIALIZED into `doc.layouts` (only the ones
actually used — the engine-wide PRUNE rule), content is filled in BY ROLE, and
a body placeholder is treated as a REGION that several blocks stack inside.

**This is where the markdown importer deliberately DIVERGES from the .pptx
one: it sets `slide.layoutId`.** pptx.ts leaves it unset for a documented
reason — real decks deviate per-slide from their nominal layout, and the native
Slide-Master resync would silently revert those deviations on the first master
edit. A `.qmd` has no such deviations to lose, because every coordinate on the
slide was invented by `mdlayout.ts` in the first place. So linking is pure
upside, and it is what makes an imported deck re-appliable and re-themeable.

Two consequences worth knowing before touching this:

- **`layoutId` resolves ONLY against `doc.layouts`, never against the
  built-ins.** Every reader (`render.ts` governing-layout lookup, `canvas.ts`,
  `panels.ts`'s master-link badge) does `doc.layouts?.find(...)`. Setting
  `layoutId: 'layout-title-content'` would be a silently dangling link — which
  is exactly why the designs are materialized rather than referenced. Their
  ids are `qmd-*`, NOT `layout-*`, because the layout picker lists built-ins
  and document layouts side by side and two entries sharing one id there is
  ambiguous for every by-id lookup after it.
- **Only a TEXT box may adopt a text placeholder's id/role.** `applyLayout`
  copies `html` only between two `text` elements; a `code` or `table` donor
  matched BY ID to a text placeholder is consumed and its content dropped. So
  code/table/quote/callout elements mint their own ids and take no role, and
  exactly one element per body slot carries `role:'body'`. A figure is the
  exception — it adopts the `role:'media'` slot, which `applyLayout` matches by
  TYPE and handles correctly.

**Element ids are slot-shaped (`ltc-c1`), not slide-shaped.** Unique per slide
(all `validateDoc` requires) and deliberately repeating across slides of the
same design with the same mix of kinds, counted PER KIND so a code element can
never pair with a text one. This is the codebase's own morph idiom
(`instantiateLayout` keeps a layout's element ids for exactly this reason), and
the payoff is the thing reveal.js cannot do: the same listing shown twice, one
line apart, travels line by line under a morph transition.

**`mdlayout.ts` RESTATES `builtinLayouts()`'s geometry, and the restatement is
gated.** The kernel must not import an app (`types.ts`'s header; the same
inversion `charts.ts` uses), so `slides/src/model.ts` is unreachable from
`convert/`. `scripts/test-convert/qmd.ts` can import both, and compares the
light-palette output of `buildLayout()` against the real `builtinLayouts()`
element for element — ids, frames, typography, roles, over the union of both
key sets. Same discipline `scripts/shell-gate.mjs` applies to its restated
splice rule: if model.ts's designs move and mdlayout.ts does not, that rig
fails. **Do not "fix" the duplication by importing model.ts.**

`transition` is `'none'` on every emitted slide — the same call pptx.ts makes.
Deck size is 1600x900 by default (LAYOUT_BASE itself, so the designs land
unscaled); `opts.size` scales them with the same arithmetic `scaleLayout` uses.

### App wiring

Thin, and it mirrors the .pptx path: `editor.ts` `importMarkdown()` beside
`importPowerPoint()` (reusing `applyPptxImport`'s shape and
`showImportReport`, which gained one optional extra action button),
`startuppicker.ts` a fourth "Create a template" sub-path — which hands off
REAL SLIDES and therefore raises no Layout-Manager `intent`, unlike the pptx
sub-path — `main.ts` an `import-markdown` file action, and one more item in
desktop's native File menu. The pick is MULTIPLE so a `.md` and its figures
arrive together; unresolved figures put an "Add figure folder…" button on the
report, because a macOS file dialog cannot reach into a subfolder in one pass.

### Not built (and why it is fine)

The plan's optional phase 3 — a desktop-only "run `quarto render` first"
button, using `pty.ts`'s `loginShellEnv()` and `terminalPanel.ts`'s
`contextDir` + `fs.watch` — is NOT here. It is convenience, not capability: a
user runs one CLI command and picks the output. If it is ever added, use
`execFile` argv, never the single-quoted string interpolation `pty.ts` warns
about.

### Verification

`npx tsx scripts/test-convert.ts` — 10 rigs, including the new `qmd.ts` (162
checks) and `load.ts`, which now pushes the markdown fixtures through the REAL
`parseDoc`/`validateDoc` as well and additionally asserts ZERO `unknown-key`
findings for both importers (a converter emitting a key the format does not
define is never legitimate). `slides` and `desktop` typecheck; `shell-gate.mjs`
passes on the built artifact and the importer is present in the inflated
runtime. Size: +20,024 B in the compressed shell, measured by building the same
tree at `40e14dac` with the same node and deps (753,722 B → 773,746 B).
`scripts/size-budgets.json`'s `reference` is deliberately NOT moved — that file
requires it be set from a CI run, never a local one, and slides is tracked
rather than capped.

## 2026-09-24 — Desktop: every window boots the CURRENT app shell (reverses windows.ts's "load the real file")

`desktop/src/main/windows.ts` used to `loadFile(path)` the deck itself — the
file IS the app, which is the whole format. But on the desktop that meant a
deck ran whatever editor build it was last saved with, and every save
re-spliced that same old shell (`capturePristine()` clones the live page). With
self-update deleted in the 2026-09 decoupling, NO renderer-side fix — save
path included — could ever reach an existing deck opened in the desktop app.

**Now every window loads this build's shell** (`APPS.slides.prodShellPath`, or
the dev server under `electron-vite dev`/`SLIDOMINGO_DEV_URL`) and asks main for
the deck's `#slidomingo-doc` text (`slidomingo:read-launch-document`). The first
autosave therefore re-saves the deck into the current shell — an old file
silently gains the current app, a fresh preview and static layer.

- Encrypted envelopes still go through `parseEnvelope → passwordGate`.
- A `<base href="file:///<deck folder>/">` is inserted AFTER the pristine
  capture (never saved), so relative media keeps resolving.
- A file whose block is another app's format, or unparseable, falls back to
  the old `loadFile(path)` with NO binding and so no disk writes (spaces files
  keep working in their own embedded app).
- Dev mode: the live page is Vite's index.html, which must never reach a
  deck, so the renderer adopts the built `dist-single` shell via kernel
  `adoptPristineHtml`; with no build, disk writes are disabled and it says so.
- Boot text is re-read from disk on EVERY load of a bound window, so View ▸
  Reload shows the file — never a blank deck autosave would write over it.

**Risk, stated plainly:** a serialization bug now lands in real decks on their
first edit. Mitigations: a session backup copy of the old bytes before the
first write of each session (`userData/Backups`, 5 per file, 30 days, works for
encrypted decks too), `looksLikeShell` before every write, and the old-build
fixture in `desktop/scripts/e2e-autosave.mjs` (`E2E_BIG_DECK`).

## 2026-09-24 — Desktop: main writes document bytes; every deck is always saved (reverses "main never touches bytes")

The desktop app autosaved only to IndexedDB unless a File System Access handle
existed — and windows opened from Finder/Recent/the CLI never have one, so
nothing reached disk before the first ⌘S (which then showed a picker).
Untitled windows used an in-memory partition, so their backup died with the
window, and there was no close/quit protection. Settled with the user:
always-on disk autosave (no toggle), untitled decks are auto-kept **drafts**.

- Each window is BOUND (`windows.ts` `Binding`) to one path: a file, or
  `userData/Drafts/<uuid>.slidomingo.html`. `documents.ts`
  `slidomingo:write-document` writes ONLY to the sender's bound path; a
  renderer can name another destination only through a native Save dialog.
  The binding is separate from `launchPathFor` (the terminal cwd), so a draft
  never makes the Drafts folder the folder `claude` can write to.
- Main tracks the file's mtime: a change it didn't make is a CONFLICT (banner:
  Reload / Keep mine / Save a copy…; a deck with nothing unsaved just follows
  the file), a vanished file is MISSING and is never silently recreated. An
  `fs.watch` on the folder (atomic renames replace the inode) reports both
  without waiting for the next write.
- Drafts get a `persist:` partition keyed by their path (version history
  survives reopening a draft); a draft never written has its partition
  deleted at close, with a launch sweep (`draft-partitions.json`) as the
  backstop — an untouched blank window leaves nothing behind.
- A window never swaps decks in place over a bound file (autosave would write
  deck B into deck A's file): New/Open/drop/Recent/imports/"Duplicate as new
  deck" open another window, closing the current one only if it's an untouched
  blank. Replace-from-JSON and version restore stay in place after a kept
  `before-replace` checkpoint.
- Close/quit: main prevents the close, asks the renderer to flush, waits (3s
  for an ack, then up to 15s), and only on failure/unsaveable/no answer shows a
  native Save as… / Don't save / Cancel box with renderer-localized strings.
- The renderer side is a desktop branch in the editor (`editor/desktopdoc.ts`),
  NOT a kernel writer hook: the web's FSA path is untouched, and exports keep
  using it. A deck is rewritten only when its content changed (the
  last-written-body guard: the whole doc minus `modified`), so merely opening
  a file never touches it.
- Measured on the 24MB/103-slide corporate-template deck: ~1s from the debounce firing to
  bytes on disk (`serializeFile` 438ms). No extra throttle was needed.
## 2026-09-24 — Template = slide types + theme + assets; instances record `basedOn`; templates are updatable

**Problem.** "Save as Template" cloned the whole deck. The one real template
(a corporate template, a 24MB PPTX import) carried 103 slides and
showed its first slide's placeholder text as its name, and the start picker's
`list-templates` shipped every template's FULL JSON (media included) over IPC
on every open. A deck kept no link to the template it came from, so a design
fix could only ever reach one of them.

**Decision.**
- A template is its **design layer**: `layouts` (+ `defaultLayoutId`,
  `rootFontLayoutId`), `theme`, `fonts`, `reusableObjects`, and the assets
  those reference. Slides are optional samples (`templateSamples`; `false` =
  one placeholder starter slide, because `parseDoc` rejects zero slides).
  Starting from a template gives ONE starter slide (`model.starterSlide`, the
  same slide "Start from scratch" makes) with an opt-in "Include N sample
  slides"; unreferenced assets are pruned (`referencedAssetKeys`, deliberately
  conservative — a false positive costs bytes, a false negative deletes a
  picture).
- Identity: a template carries `templateId` (uuid, minted once by
  `stampAsTemplate`, kept across updates and renames). A deck records
  `basedOn: {templateId, name}`; `parseDoc` converts a template's
  `templateId` into `basedOn` when the file is opened directly. `name` is the
  template's FILENAME-derived name — never the doc title — and is the fallback
  key for legacy templates that have no id yet (the id is minted on their
  first update). `model.resolveBasedOn` does the lookup; an id that matches
  nothing does not fall back to a same-named template that has its own id.
- Templates are **updatable**, reversing format.md's "the template file itself
  never changes": `model.mergeTemplateDesign(template, deck)` replaces the
  design layer from a deck based on it, keeps the template's own samples
  (re-applying those still linked to a surviving slide type) and
  `templateId`, renames colliding asset keys on the template side, and
  refuses a slide-size mismatch. Layout Manager edits stay scoped to the deck;
  pushing them into the template is an explicit action (wired in a later
  phase).
- The desktop registry is metadata-first: `listTemplateMeta` (cached per
  path+mtime in main, name from the filename), `loadTemplate(path)` for ONE
  template's JSON on demand, plus update/rename/reveal and a native-confirmed
  delete that moves to the Trash. Every path is refused outside the templates
  folder. The old `list-templates` channel stays until the start page moves
  to the new API.

## 2026-09-24 — Desktop start page: Start new · Recent & drafts, templates separate from the example deck

The startup picker mixed three different things in one grid — Blank, the
Showcase demo and whole-deck "templates" — with Recent as a thumbnail-less
row list below. It is now a start page (`slides/src/startuppicker.ts`), shown
only in fresh windows (so never over unsaved work):

- **Start new**: Blank, one tile per template (thumbnail, filename-derived
  name, "{n} slide types" — metadata only, `listTemplateMeta`, never the full
  JSON), and **Create template…** (the existing design / describe / PPTX /
  Markdown sub-flows). A template opens a side panel: its slide types, an
  opt-in "Include {n} sample slides" (only when it has samples), Create, and
  ⋯ Rename / Reveal in Finder / Delete…. Create = `instantiateTemplate`: one
  starter slide by default, `basedOn` recorded.
- **Recent & drafts**: files from Recent plus auto-kept drafts, each with the
  first-page thumbnail `thumbs.ts` renders from the preview every save
  embeds; right-click Reveal / Remove from list / Delete draft; a search field
  past six entries. A returning user sees this FIRST, with the latest deck as
  a larger "Continue" tile; a first launch leads with Start new.
- **Footer**: "Open example deck" (the showcase moved here — it's a demo, not
  a template), "Add a template file…", "Templates folder".

The CSS is on the theme tokens (`--chrome`, `--ink`, `--line`, `--muted`,
`--accent`, …), so it follows light and dark like the rest of the chrome; the
create-flow sub-views were converted with it. Known debt, untouched here: the
create-flow sub-views' strings were never translated into any catalog (the
coverage rig compares catalogs with each other, not with the source).

## 2026-09-24 — Opening a deck replaces the window's deck (it is always saved); the chat follows the deck

Amends the Phase 1 disk-autosave entry's "a window never swaps decks in place
over a bound file". That rule existed so autosave could never write deck B
into deck A's file; it made every Open/Recent/drop/import add a window, and
with it a Claude Code panel still pointed at the old deck's folder, so
windows and chats piled up. Every deck is always saved now, so leaving one
costs nothing:

- File ▸ Open… (⌘O), Open Recent, the start page's tiles, a dropped deck, an
  import and "Duplicate as new deck" REPLACE the window's deck. Main runs the
  same flush protocol as closing (`runLeaveFlow`, `desktop/src/main/windows.ts`);
  Cancel in its failure box keeps the current deck. The safety property is
  kept by never swapping a deck under a live page: the swap is a NEW doc view
  (`WebContentsView`) in the same `BrowserWindow` — `unmountDocument` +
  `mountDocument` — which a per-path session partition requires anyway.
  Window-level listeners are registered once and look the current deck up at
  event time.
- Side-by-side stays one step away: File ▸ Open in New Window… (⇧⌘O), ⌘/⌥-click
  on a Recent item or while dropping, `{ newWindow: true }` on the
  `open-document` / `open-dialog` / `open-as-draft` IPC, and File ▸ New Window
  (⌘N, unchanged). A path already open in another window focuses that
  window; nothing is swapped. Another app's file (the legacy `loadFile`
  path) always gets its own window.
- Finder / second-instance opens still get a new window, like any document
  app — unless the focused window is an untouched blank, which becomes the
  deck. Backups from Version History still open as a copy in a new window.
- The chat follows the deck: a terminal panel open at the swap (docked or
  popped out) is disposed — releasing the old page's slide locks — and
  reopened docked once the new deck has loaded, with the new deck's folder as
  cwd (a fresh `claude` session; its cwd can't change). A draft gets its
  scratch dir. A closed panel stays closed.
- The new deck says "Opened {name}" (the `opened` flag on
  `read-launch-document`, read once); an import shows its fidelity report
  instead.

## 2026-09-24 — A default template, kept in main's app settings; thumbnails come from the static layer

Start page v2, phase 3 (`slides/src/startuppicker.ts`,
`desktop/src/main/{settings,templates,thumbs,thumbscan}.ts`).

- **The default template lives in main**, in `userData/app-settings.json`
  (`settings.ts`, the `recent.ts` pattern), never in renderer storage: a
  renderer's `localStorage` is per DECK (one session partition per path), so
  a setting kept there would differ from window to window. It is stored as
  `{ templateId, path }` and resolved by `templateId` first (a rename keeps
  it), then by path (a legacy template has no id); a rename also rewrites the
  stored path. IPC `get-default-template` / `set-default-template`.
- **The default tile starts a deck in one click** (the template's default
  slide type, no samples) and leads Start new, ahead of Blank, badged
  "Default". Every other template tile still opens its panel. Right-click on
  a template tile offers the other action (Options… / Start a deck) and
  "Use as default" / "Stop using as default", as does the panel's ⋯ menu.
  Enter on the page with no tile focused also creates from it.
  *(Amended 2026-09-30, "Templates behave like PowerPoint": EVERY template
  tile now starts a deck in one click; the panel is right-click ▸ Options…
  or the tile's ⋯.)*
- **File ▸ New from Default Template (⌥⌘N)** opens a new window that skips
  the start page: `createDocumentWindow(null, { startIntent })`, read once by
  the renderer through `read-launch-document` (a reload shows the page).
  With no default set, it shows the start page with a note. ⌘N keeps the
  start page, where Recent lives.
- **The template panel's slide types are selectable**: the first slide is
  the picked type (`instantiateTemplate`'s `firstLayoutId`, via
  `starterSlide(doc, layoutId)`), the template's default pre-selected.
- **Thumbnails show the static layer's first slide when a file has one.**
  The 64 KB preview (`PREVIEW_BUDGET`) swaps an image-heavy first page's
  pictures for tinted boxes; the same file carries every slide at full
  fidelity in `#slidomingo-static`. `scanThumbSource` reads on past the
  preview host to the layer's `data-slidomingo-static="1"` (or the runtime)
  and reports `hasStatic`; the JS-off render then injects CSS hiding the
  splash, the preview and every static slide after the first, and settles
  400 ms for image decode. Files without a layer render the preview exactly
  as before. Cache files carry a version tag (`-v2.png`) so the old
  washed-out PNGs regenerate. Measured on the 13.7 MB corporate template:
  656 ms cold.

## 2026-09-24 — Start page: pinned decks, one search, keyboard-first

Start page v2, phase 4 (`slides/src/startuppicker.ts`, `desktop/src/main/recent.ts`).

- **Pinned decks** are a flag on the Recent entry (`pinned: true` in
  `recent-files.json`), not a second list: `MAX_RECENT` (20) counts unpinned
  entries only, so a pinned deck never ages out; re-opening it keeps the flag.
  Pin / Unpin is in a Recent tile's right-click menu (IPC `pin-recent`); the
  page shows a "Pinned" row above Continue, and pinned decks are NOT repeated
  in Recent & drafts (Continue = the latest unpinned deck or draft). Drafts
  can't be pinned (they aren't Recent entries).
- **One search** in the header, shown whenever there is anything to search,
  over recents, drafts and templates by name and folder (`data-search`).
  Tiles with nothing to match (Blank, the import tiles) hide while searching.
  Replaces the old Recent-only box that appeared after six items.
- **Keyboard**: focus starts on Continue (returning user) or the default /
  first Start tile; ←/→ step through tiles in on-screen order, ↑/↓ jump to the
  nearest tile in the row above/below (by `getBoundingClientRect`); typing a
  letter or ⌘F goes to the search; Escape closes, innermost first, the context
  menu, the template panel, the create flow (its Back), then clears the search.
  One capture-phase `keydown` on the document while the page is up, so it
  works whatever has focus; the overlay itself is `tabindex=-1`.
- **Layout**: Start new is a wrapping grid, not a sideways-scrolling row; a
  first launch gets a centred welcome with bigger tiles; the page is centred
  vertically while it fits. Recent is grouped Today / Yesterday / This week /
  Older, by calendar day.

## 2026-09-24 — Brand: the Flamingo S mark, flamingo palette, one wordmark

The mark was still the inherited Bento box (three compartments), only
recoloured in the rebrand. It is now the **Flamingo S**: the letter S drawn
as a flamingo (thin neck swelling into a body + wing + raised tail, head with
a downturned black-tipped beak) on a night-aubergine tile. Chosen from three
concept rounds (stroke S / S with head / S on one leg, then flamingo-pink
variants incl. a standing bird and a pink "sunset" tile) — the plain Flamingo
S won because it still reads as a bold S at 16px.

- **Palette** (brand only): night `#1D1119`, aubergine `#4A2242`, blush
  `#FFB3C4`, flamingo `#FF7098`, deep `#EC4679`, wing `#D8336A`. Replaces
  plum/mauve/rose/cream *for the mark, splash and wordmark*. The editor's UI
  accent token (`--accent: #c98a82`) is deliberately NOT changed here — that
  is a theme decision for all chrome and was left open.
- **Wordmark**: "Slidomingo", one casing everywhere, accent on **"mingo"**
  (`.sm-mingo`: `#E23D72` on light, `#FF7098` on dark). Never accent "Slido"
  — that is an existing product (Cisco Slido).
- **Single source**: `slides/src/brand.ts` (`logoSvg()`, `WORDMARK_HTML`).
  Static copies (index.html favicon + splash SVG, `docs/assets/slidomingo-logo.svg`)
  are generated by `node scripts/build-brand-assets.mjs`; never hand-edit
  them. `desktop/build/icon.png` (1024px, 824px tile + shadow per macOS icon
  grid) is picked up by electron-builder from buildResources.
- **Splash**: CSS-only intro keyed to classes `logoSvg({animated:true})` emits
  (`.sm-r1..3` reveal masks drawn tail → head, `.sm-head`, `.sm-eye`). It must
  finish inside main.ts's ~1.25s hold — lengthen the hold, not the intro, if
  that ever needs to change, and weigh it against boot time.
- Saved decks carry their shell, so existing files keep the old favicon and
  splash until re-saved by a newer build. Expected and harmless (the splice
  contract is untouched; the splash keeps its id and single-`</div></div>` end
  that postbuild-compress.mjs matches).

## 2026-09-24 — Settings is ⌘, (Ctrl+, elsewhere); a stale dev main hides templates

- **⌘, opens Settings**: from the native menu (macOS: app menu under About;
  elsewhere: end of File, both `menu.ts` → `file-menu-action` `'settings'`)
  and from the editor's own keydown handler (web build, and inside fields).
  Both call `Editor.openSettings()`, which replaces any open overlay, so a
  double-fire is harmless. Inline text edit (`canvas.ts` startTextEdit)
  stops every key from propagating; ⌘, is the one exception it lets
  through, and the editor commits the edit before opening. Not ⌘; — that is macOS Check Spelling in text
  fields, and ⌘, is where Mac users look first. The start page has no
  Settings yet (the editor isn't built while it shows); that is still open.
- **"Only Blank" on the start page in dev** was a stale main process, not a
  code bug: `electron-vite dev` doesn't reload main, so a main started before
  `slidomingo:list-template-meta` / `get-default-template` existed rejected
  those calls, and `startuppicker.ts` swallowed the error. It now logs
  `[start page] template list failed` and shows a muted "restart the app"
  hint under Start new. Fix: restart the whole `npm run dev`.

## 2026-09-24 — Deck title and file name: independent, in sync by default

- **Two things, like Keynote/Word's document Title vs. the file name.** When
  they differ the editor shows the file chip beside the title
  (`syncWindowTitle`). They should only differ when the user made them differ.
- **The suggested file name keeps the title's characters.**
  `suggestedFileName` (kernel `save.ts`) strips only what filesystems can't
  hold (`/ \ : * ? " < > |` and control characters), collapses whitespace,
  trims leading/trailing spaces and dots, and falls back to `Untitled`.
  Spaces, accents, CJK and `&`/`'` survive. It used to underscore everything
  outside `\w`, so "My Talk" became `My_Talk` and the chip appeared even
  after accepting the default.
- **Desktop Save As (move) of a deck still titled `Untitled` takes its title
  from the name the user typed.** Any other title (set by the user or a
  template, even on a draft) is never overwritten. The title change is
  committed after the save's clean state, so it is an ordinary pending edit
  that autosave writes to the newly bound file. Save a copy… never touches the
  title: the open deck keeps its identity.
- **Not yet on the web path** (`Editor.save` via the file picker): adopting
  the title there needs a second write through the handle. Follow-up.

## 2026-09-24 — Properties panel: tiered disclosure, keyed by English section key

- **Tiered, not flat.** A selected element's panel is: a fixed header (type
  name, Duplicate/Delete, the basics), then the type's own "more" section,
  then Position & size, Effects, Arrange, Presenting, Advanced, History — all
  collapsed by default. The basics per type are listed in
  `slides/src/editor/panels.ts` (`buildXProps`, above the first
  `this.section(...)` call). A plain rectangle went from ~36 visible controls
  to 12.
- **A closed section shows a dot when it holds non-default values; it never
  auto-opens.** Auto-opening would bring back exactly the clutter the tiers
  remove. The dot rules live next to each `section(key, {modified})` call.
  Text outline (`textStroke`) counts toward **Typography**, where its control
  lives, not Effects.
- **Open state is keyed by the ENGLISH section key** (`data-key`), in
  localStorage `slidomingo-panel-open-v2`. v1 keyed it by the translated
  title, so every section fell back to its default in any non-English
  locale. Each key migrates once from v1 (`v1[t(K)] ?? v1[K]`) the first time
  it's looked up; v1 is left in place so a rollback still has its state.
  Section keys reach `t()` as variables — they ARE catalog keys; an
  extraction sweep must not prune them.
- **Moves:** Opacity → Effects; Role, Blend, Backdrop → new Advanced; the
  chart's raw JSON → Advanced; Morph → end of Presenting (key `Presenting`
  kept, so saved state and translations carry over). Space needs 2+
  elements and Distribute 3+; the rows are omitted, not disabled, below
  that. A multi-selection's whole arrange kit is its fixed header.
- **Justify is not in the text Align buttons yet.** It needs `align:
  'justify'` in the model, which is the rich-text branch's format change.
- **One edit layer for every surface** (`editor/elementactions.ts`,
  `ElementEdits`): bursts, action-log recording, palette references and the
  named setters the mini toolbar will share. The burst resets on
  selection/slide change (and undo/redo), NOT on every panel rebuild — a
  toolbar colour drag rebuilds the panel on each step and must stay one undo
  step. `closeActiveColorPopover(within)` is scoped for the same reason.
- **A hand-picked colour is one undo step.** The colour control fires
  `onChange(v, final)` and then `onManualCommit` (clear the palette
  reference); `setRef(ref, v, null)` now amends the step that just closed
  instead of opening a second checkpoint.
- **Space activates a focused button.** canvas.ts's space-to-pan used to
  swallow Space whenever focus wasn't in a text field, making every button
  mouse-only for Space. It now also stands down on buttons/links.

## 2026-09-24 — Mini toolbar: below the selection, mounted in the canvas wrap, one edit layer

- **Below, not above.** Moveable's rotate handle owns the space above the
  box; the bar sits 14px below (clear of the resize handles) and flips above
  only when there is no room (`positionAtRect`, `floatingposition.ts` — the
  trigger-anchored `positionFloating` is now a thin wrapper over it).
- **Mounted in `.ed-canvas-wrap`, positioned `absolute` against it,** not in
  `document.body`: the Layout Manager reparents that wrap, and the bar must
  ride along. Clamped to the scroller's box; hidden (not pinned to an edge)
  when the selection is scrolled out of view.
- **Same `ElementEdits` as the panel; colour wells from
  `panel.colorControl()`.** A toolbar edit is one undo step and the panel
  shows it on its next rebuild. The panel's `closeActiveColorPopover(host)`
  is scoped so a toolbar popover survives the panel rebuild that each live
  colour step triggers; the bar itself never rebuilds while one of its fields
  is focused or its popover is open (it marks itself stale and catches up).
- **Buttons act on mousedown + preventDefault** (the Insert-field trick), so
  B/I/U/S during a text edit never blur the contentEditable. Keyboard
  activation arrives as a click with `detail === 0`. Strikethrough rewrites
  execCommand's `<strike>` to `<s>` — the sanitizer keeps `S`, not `STRIKE`.
  Rich-text (branch 3) is expected to route these through `richtext.ts`; the
  bar already carries `data-rt-keep` for its blur-commit exemption.
- **Hidden while:** a mouse button is down on the canvas, a Moveable gesture
  runs, a path or table cell is being edited, a draw tool / comment tool /
  Format Painter / Reapply is armed, the store is read-only, presenting, or
  the setting (`slidomingo-minitoolbar`, a viewer preference) is off.
  Tables, SVG diagrams and embeds get no bar — the panel's basics cover them.
- **Canvas hooks are listener sets:** `onViewportChange` (relayout, scroll,
  every `syncTargets`, and click-tool arm/disarm), `onGesture`,
  `onTextEditChange` (was an unused single callback field), plus
  `selectionRect()` / `viewportRect()` / `isEditingCell`.
- **Keyboard:** Alt+F10 focuses the bar (roving tabindex, ←/→/Home/End, Esc
  returns to the canvas with the selection kept). The global keydown handler
  ignores plain keys from inside the bar, so ← never nudges the element while
  you move between buttons; modifier shortcuts (⌘Z…) still pass.
- **End-tip labels use their own keys** ('Arrow tip', 'Bar tip'…): a bare
  `bar` key would also translate the chart type "bar".

## 2026-09-24 — The chrome palette follows the brand (Flamingo palette everywhere)

Supersedes the previous brand entry's "the editor's UI accent token is
deliberately NOT changed" line. The chrome, presenter, new-deck defaults and
the Showcase deck now all use the Flamingo palette (`BRAND` in
`slides/src/brand.ts`); the old rose `#C98A82` and the upstream Bento amber
`#F7A600` are gone from the app.

- **Chrome tokens** (`slides/src/styles.css`, mirrored by the desktop
  terminal panel's `terminal.css` and the window's pre-paint
  `backgroundColor`): greys tinted toward the logo's night/aubergine
  (light `--chrome #FAF6F7`, `--ink #1D1119`, `--muted #76606C`; dark
  `--chrome #1C1419`, `--ink #F3E8EC`, `--muted #A8929E`). `--accent` is
  `#FF7098` in BOTH themes — it is brand, it does not invert. `--blue`
  stays: it is the functional canvas-selection colour, not brand; semantic
  reds/greens/warning yellows stay too. `scripts/test-slides-theme.mjs` §5
  pins the light values (it used to pin the upstream suite's amber).
- **Three accent roles, not one.** `--accent` = fills, rings, markers.
  `--accent-ink` (`#1D1119`) = text ON the accent. NEW `--accent-text` =
  the accent used AS text (kickers, links, the toast action, ★): flamingo
  itself is ~2.4:1 on light chrome, so light uses `#C43163` (4.5:1 on
  chrome, chrome-2 and surface) and dark `#FF8AAB`. Any new "accent-coloured
  text" rule uses `--accent-text`, never `--accent`.
- **The wordmark is not `--accent-text`.** `.sm-mingo` keeps the brand's own
  `#E23D72` / `#FF7098` (`BRAND.mingoOnLight` / `flamingo`): a logotype is
  large display text and must match brand.ts, not drift with a UI token.
- **Presenter window** (`.sv-*`, always dark) and present mode (Reveal link/
  selection/progress, the `--slidomingo-accent` fallback): amber → flamingo,
  blue-greys → aubergine greys.
- **New-deck defaults** (model.ts `newDoc`/`defaultShape`/`defaultText`/
  built-in layouts, `kernel/src/convert/mdlayout.ts`'s `LIGHT`, the
  starter library): ink `#1D1119`, greys `#5A4452`/`#76606C`, accent the
  DEEP flamingo `#E23D72` — a deck accent must read as text on white slides
  (kickers, comparison labels), where `#FF7098` does not. These values are
  copied into each deck at creation, so existing decks never change.
  `startuppicker.ts`'s `DEFAULT_LAYOUT_ACCENT` must equal the default (its
  recolour matches the literal); amber stays available as an accent preset.
- **Showcase deck**: recoloured onto the palette, and its slide 1 / closing
  slide now show the Flamingo S instead of the old box logo built from the
  four tiles. T_D is the night tile, a tile-less flamingo
  (`logoSvg(size, {tile:false})`, asset `logo-flamingo`, svg id prefix
  `sdfl`) sits on it, and T_A/T_B/T_C fan out behind it as three slides —
  the same four ids, so the morph into slide 2 is untouched.

## 2026-09-27 — PowerPoint import: master → layout tree, template mode, linked slides

Reverses the 2026-09 "pptx never links" call (see the markdown-importer entry
above: "pptx.ts leaves it unset for a documented reason"). Before this,
`convertPptx` flattened every slide, merged each master's decoration into
every extracted layout, and linked nothing, so slide types did not drive the
deck. Every type showed "0 slides" and editing one changed nothing. The
template path ran the same deck conversion, so a `.potx`, which usually has no
slides, lost nearly all of its layouts. Kernel zone: `kernel/src/convert/`.

- **The tree.** Each slideMaster → a ROOT `doc.layouts` entry
  `pptx-master-<m>`: its background, its decoration, its theme's minor/major
  faces as `fontFamily`/`headingFamily`. Each slideLayout → `pptx-layout-<k>`
  with `parentId` → its master, holding ONLY its own shapes. Element prefixes
  are `pm<m>-`/`pl<k>-`, and they are new on purpose: a flattened slide keeps
  its old `mst<n>-`/`ly<n>-` chrome ids byte for byte. m and k come from
  `p:sldMasterIdLst`/`p:sldLayoutIdLst` BEFORE any slide is read
  (`collectTemplate`), so numbering is identical in deck and template mode.
  Layouts reached only via slide rels are appended in discovery order.
  `doc.layouts` order: per master, the master, its children in list order,
  then its detached roots.
- **No placeholder prompts on the master entry.** A master's own title/body
  prompts would show under every child's prompts. The master's text styling
  still reaches every layout prompt through `textDefaults`, so nothing is lost.
- **Detach rule.** `effectiveLayout` always composites the whole chain, and
  an inherited element cannot be hidden. So a layout the master must NOT show
  through becomes a DETACHED root, with the master's decoration folded in
  (under the same `pm<m>-` ids) unless hidden. That covers three cases:
  `showMasterSp="0"`; its own picture background over a master that has
  decoration (the picture would cover it); its own `p:bg` under a
  picture-background master (the inherited picture would cover it).
  Detached layouts get no live master updates, and PowerPoint hides the
  master there anyway.
- **Layout entry z-order:** background image, decoration, furniture, then
  content placeholders. That is the order a flattened slide paints its chrome
  in, with content on top, and it is what makes linking provable. Furniture
  follows `p:hf` visibility. A filled or outlined placeholder keeps its box
  (the shape half, split and welded like slide text).
- **Linking policy: link only what does not deviate.** Resync keeps only
  `html`/`link` from a slide. Everything else (frame, fontSize/family/weight,
  colour, align, valign, lineHeight) comes from the layout, so linking a
  deviating slide would revert the deviation on the first master edit.
  `tryLink` builds what the resync would produce: a copy of the composite
  under the LAYOUT ENTRIES' OWN ids (so the first resync is a no-op), with
  each placeholder poured into its slot (media slots adopt an image exactly
  as `applyLayout` does) and everything else on top. Pre-checks name the
  obvious deviations: master visibility differing from the layout's, an own
  `p:bg`, or a `p:clrMapOvr`.
- **The safety net.** `renderEquivalent` compares the candidate with the
  flattened slide. It translates ids, drops empty prompts (hidden when
  presenting), and requires the same id set, equal per-element signatures
  (identity fields ignored, numbers to 1/100), the same relative order for
  every OVERLAPPING pair, and the same background. The first mismatch becomes
  the reason: `placeholder-moved`, `placeholder-restyled`,
  `empty-media-placeholder`, `z-order` or `render-mismatch`. The slide then
  stays exactly as flattened before, and the report lists it as
  `slide-unlinked` with that reason. A slide with no layout is not reported,
  since it has nothing to deviate from.
- **Accepted:** linked slides show dimmed "Click to add…" prompts for unused
  slots, in the editor only; that is the model's normal behaviour. Autofit
  scaling, explicit run fonts and dominant sub-bullets correctly unlink a
  slide, so the link rate on dense real decks may be modest. There is no
  "relink slide" action yet.
- **Template mode** (`convertPptx(bytes, {mode:'template'})`, used by the
  start page's "Import a PowerPoint" template flow): every layout under every
  master, no slide walk, and one starter slide linked to the default layout.
  The start page re-mints it with `starterSlide`. Deck mode, the default for
  File → Import and the start page's deck import, still PRUNEs to used
  layouts and drops a master left with no child. Template mode registers
  every layout's images, so template-heavy files can be large.
- **`doc.defaultLayoutId`** is set in both modes, picked in this order: the
  first master's `type="obj"` layout (lowest k); in deck mode, the most-used
  layout; the first child; the first entry.
- **`{link:false}`** flattens everything, giving exactly the pre-tree slide
  output. `scripts/test-convert/linking.ts` uses it as its oracle, alongside a
  no-op-resync check that runs the real `applyLayout`/`effectiveLayout` from
  `slides/src/model.ts`.

## 2026-09-27 — Morph: exits fade, changed content crossfades, imported chrome shares morph keys

Screenshots of the imported Bietervortrag deck (fake clock, frames at
0/120/250/400/650 ms) showed Morph was never smooth on it. Fade was fine.
Two causes, one in the runtime (affecting every deck) and one in the importer.

- **Unpaired outgoing elements fade out** (`present.ts runMorph`). A morph
  and the slide before it use Reveal `transition:'none'`, so the old section
  disappears at 0 ms, and runMorph only animated the incoming side. Every
  element with no partner now gets a **ghost**: a still clone parked in the
  incoming section at its old frame, fading out over half the morph, then
  removed. The clone has no `data-flip-id` or `data-el-id` (`querySelector`
  returns the first match, and a ghost sits before its partner). It also
  drops its hover/link/group/autoplay markers, so no other system adopts it.
  An svg ghost keeps its id when nothing on the new slide shares it, because
  its scoped CSS keys off that id. Embeds get no ghost, since an iframe clone
  reloads. Stacking: each ghost goes right above the incoming partner of the
  nearest shared element below it on the old slide, or beneath everything
  when nothing shared is below it. So an old picture never fades out under a
  shared full-slide background. Ghosts are cleared on slide exit, on the
  reduced-motion re-settle, and by a 2.8 s wall-clock net.
- **Entrances wait only when something travels.** The 40%-of-morph delay
  (and the default document-order stagger) now apply only when at least one
  matched pair changes frame. When nothing moves there is no morph to wait
  for, and the wait was a blank slide (0 to about 520 ms on the imported
  deck). Arrivals then start at once and overlap the exit fades: a
  crossfade. Authored `fx.order` staggers are unchanged. The Showcase's
  moving morphs still hold entrances to 260 ms.
- **Paired elements whose CONTENT changes crossfade.** Same frame plus new
  text (a title in a shared layout slot) used to hard-cut, because the box
  morph had nothing to do. `morphContentChanged` compares what the morph
  cannot tween: text html, rendered text (`{{page}}` has the same html
  everywhere), and typography; image src/fit; shape kind/path; media, svg and
  table content. Frame, opacity, text colour and shape fill are tweened and
  never count. Charts and code carry their own morphs and never crossfade,
  and neither does a formula or code block whose symbols were captured. The
  ghost goes directly under its partner and uses the same beat as an exit
  and entrance. A slow symmetric swap over the whole morph was tried first
  and read as two overlapping paragraphs until about 400 ms. When the frame
  changes too, the ghost rides the same tween (`morphFrameTransform`, with
  the ghost resting at the OLD frame).
- **Importer: flattened chrome carries its linked twin's key as `morphId`**
  (`kernel/src/convert/pptx.ts chromeTwinId` / `setChromeMorphKeys`). An
  unlinked or `{link:false}` slide's baked chrome had per-slide ids
  (`mst<n>-3`), so its logo paired with nothing and faded out and in on every
  morph. It now sets `morphId` to the id the chain uses (`pm<m>-X`,
  `pl<k>-X`, the chain's background image for an inherited picture
  background, never for the slide's own), through the same function tryLink
  translates with. `id` is untouched. Unlinked slides still equal their
  flattened twins byte for byte, both having `morphId`. `signature()` and
  the linking oracle ignore `morphId`. On the Bietervortrag deck the logo now
  holds op 1.00 at y20 in every morph frame of every pair, linked or
  flattened.

## 2026-09-28 — Templates are edited in their own window, bound to the file

Refines 2026-09-24's "opening a template never writes back". An ordinary open
of a template (Open, Recent, a start-page tile, a drop) still starts a new
draft based on it. Only an explicit **Edit Template** binds the template FILE
to a window. Before this, the only way to change a template was to push a
deck's design into it ("Save to template ▾ → Update 'X'"). Creating a template
and storing its slide types went through a deck first.

- **A template window** (`desktop windows.ts`, `Binding.role: 'template'`) is
  bound to a file in the templates folder. It boots straight into the Layout
  Manager and autosaves, and ⌘S saves, back into that file. The renderer is in
  `templateMode` (`editor.ts`): every write is `model.templateFileDoc(doc)`
  (`stampAsTemplate`: `template: true`, the same `templateId`, no
  `docId`/`basedOn`). Main refuses a non-template write to a template binding
  (`not-a-template`), so a renderer bug can't turn a template into a deck.
- **Identity lives at the write boundary.** The live doc carries an in-memory
  `docId` equal to the `templateId` (autosave recovery, versions and per-doc UI
  state key on it; stable across opens), which never reaches the file. The
  editor fixes the `templateId` at boot and re-asserts it after whole-document
  replaces (Replace from JSON, restored versions, `loadDoc`), because `parseDoc`
  strips it.
- **Entry points:** File ▸ New Template… (`startIntent: 'new-template'`: name,
  then an empty template made of the built-in slide types, `newTemplateDoc`;
  the window becomes its template window). Start page: a template's ⋯ and its
  right-click menu → Edit template, "＋ New template…" in the footer, and
  "Empty template" in Create template…. From the start page, Edit template
  replaces the page like every other pick there (⌘/⌥: a new window). In a
  deck's Layout Manager, "Edit 'X' in its own window" opens a NEW window, so the
  deck stays beside it. Save as new template offers "Edit it".
  `slidomingo:edit-template` accepts only paths inside the templates folder.
  A template already open for editing focuses its window.
- **In the window:** the LM head reads "Template: name", has Rename… instead of
  "Save to template ▾", and its Done button becomes "Sample slides". The normal
  editor then shows a banner with a way back and a "Save these slides as
  samples" switch (`templateSamples`). Rename… renames the file, and main
  re-points the binding (`rebindPath`, `slidomingo:binding-moved`). A template
  is never added to Recent and can't be encrypted or saved as a present-only
  file. "Duplicate as new deck" becomes "New deck from this template"
  (`instantiateTemplate`, in a new window). "Save as template" becomes "Copy as
  new template", which gets a fresh `templateId`.
- **Decks are not updated automatically.** Pulling a template's changes into a
  deck stays the explicit "Update this deck from 'X'". It reads from disk, so it
  sees what the template window saved. A "template changed" nudge can come
  later. The in-deck LM overlay stays for changes that belong to one deck only.
- Desktop only (it needs a bound file). The web build is unchanged. No kernel
  or splice-contract change.
## 2026-09-28 — Slide types get slide leaves; "Apply layout…" becomes "Change layout…" (relink with a fit check)

Answers 2026-09-27's "no 'relink slide' action yet".

- **One verb, not two.** The one-shot "Apply layout…" is gone. It
  re-arranged a slide but never touched `slide.layoutId`, so a slide linked
  to A with B applied snapped back to A on A's next edit. **"Change
  layout…"** (panel, ribbon, the linked chip's "Change…", an unlinked slide's
  "Link…") replaces it. Onto a doc slide type, `model.relinkSlide` sets
  `layoutId` and re-applies the type in the same commit (the first resync
  afterwards is a no-op). Onto a built-in, the layout is applied and
  `layoutId` deleted: a built-in has no identity to follow, which is the
  same state inserting from one gives. "Take the look but stay free" =
  Change layout, then Unlink. The internal event name
  `slidomingo:apply-layout` is kept, now with an optional `detail.slideId`.
- **Compatibility is a dry run, not a rule set.** `model.relinkPreview` runs
  the real `applyLayout` matching (factored into `matchLayout`, so the
  preview cannot disagree with the apply). It returns `filled` slots,
  `floating` (content that sat in a slot — it has a role or a layout-owned
  id — and finds none in the target), `extras` (free user content, which
  floats identically under ANY type and so never counts), and `emptySlots`.
  `verdict` is `fit` or `partial`; there is no "lossy" level because nothing
  is ever deleted. The picker badges every entry (✓ / "N items float" /
  "current") and groups doc types by family (one group per root with
  descendants, childless roots gathered as "Other slide types").
- **Fix riding along: a filled media slot no longer vanishes.** A picture
  that filled a `role:'media'` slot carries the slot's layout-owned id, so
  `applyLayout`'s leftover pass dropped it as stale chrome whenever the
  target (or the same type after its media slot was deleted) had no media
  slot. It now survives like written text (`isFilledMediaSlot`). This is the
  only change in `applyLayout`'s output; a 294-case fuzz against the old
  implementation was otherwise identical.
- **Leaves are derived, not stored.** `model.directlyLinked` (slides with
  `layoutId === id`, no `stateOf` variants) and `model.unlinkedSlides`
  (no link or a dangling one) drive the tree's leaves. There is no format
  change. Each type row gets "▸ N slides" (direct) plus "N slides incl.
  subtypes" when the subtree total differs. Open state is per-doc
  localStorage (`slidomingo-typetree-open-<docId>`, view state like section
  collapse). A "Not linked" group sits below the root drop area. The leaf
  label is the title-role text, else the largest non-chrome text: flattened
  .pptx slides have no roles and bake their footers in under slide-local ids.
- **Grouping ≠ deck order.** Dragging a leaf (`text/slidomingo-slide-leaf`)
  onto a type row relinks it, with a green/amber outline and badge from
  `relinkPreview` during dragover. The whole row is the target, because a
  leaf has no before/after. Dropping on "Not linked" unlinks (keeps the
  look). Both commit once and toast with Undo. The deck order never changes.
  The leaf menu has Change slide type… (the same picker), Go to slide
  (exits the overlay) and Unlink.
- **Agents:** `slide_type({op:'relink', slideId, layoutId|null})` → app verb
  `relink_slide_type`; it returns `verdict`/`filled`/`floating`/`emptySlots`.
  `outline` rows now carry `slideType`.
- Not in v1: multi-select / bulk relink, a "group by slide type" Slide
  Sorter mode, auto-suggesting a best-fit type for a flattened slide.
- Verified by `scripts/test-slide-relink.mjs` (34 checks) plus a driven
  browser pass on a real 2-master .pptx.

## 2026-09-28 — Slide-type storage stays materialized; "Clean up document…" is explicit; paste dedups assets

**Context.** We checked what a shared deck carries and whether slide types
duplicate data. The whole doc travels: every slide type (used or not),
reusable objects, theme, fonts and assets. The template itself does not
travel; `basedOn` is inert for a recipient. Each linked slide stores a
materialized copy of its type chain's elements, and child types do not copy
their parents. Measured on a real 2-master / 9-slide .pptx import, the file
was 6142 KB: 6106 KB assets, 6.5 KB types and 27 KB slide elements.

- **Materialized chrome copies are intentional and stay.** `renderSlide`
  only reads `slide.elements`, and old players, previews and agents rely on
  that. The copies cost under 0.5% of the file. Pictures are stored once in
  `doc.assets` and referenced as `asset:key`.
- **The real waste was never pruned.** Unused slide types and unused assets
  survive every save, and paste stored byte-identical pictures under a
  second key.
- **"Clean up" is explicit, undoable, and never automatic on save.** Pruning
  is the one failure direction that loses data. The block lives in Document
  properties (Layout Manager tab and Settings ▸ Document).
  - `model.unusedContent(doc)` is a pure read and returns
    `{layouts, assetKeys, bytes}`.
  - The kept types are the ancestor chains of every type a slide follows
    (state variants included), plus the chains of the effective default
    (`defaultSlideType`, so the layouts[0] fallback counts) and of
    `rootFontLayoutId`. That set is closed under `parentId`, so the removal
    is a plain filter and needs no `removeLayout` baking.
  - Assets go through the existing conservative `referencedAssetKeys` /
    `pruneAssets`.
  - `bytes` is the exact drop in the JSON's length.
  - `removeUnusedContent` runs it in one `store.commit` and shows an Undo
    toast.
- **Templates keep all their types.** When `template` or `templateId` is set,
  no type is removable, because a template's unlinked types are the point of
  it. Orphan assets still go.
- **Paste dedups by bytes.** `clipboard.ts mergeAssets` reuses whatever key
  already holds identical bytes, the `internAsset` rule. It adds a key only
  for new bytes, and a fresh key when theirs is taken by different content.
  `rewriteRefs` now applies the remap in one pass over every string (plus
  bare `asset` keys), so a→b and b→c never chain.
- **A dangling `layoutId` shows no link badge.** Sidebar thumbnails show
  `.ed-thumb-link` only when `doc.layouts` holds the id. This matches
  `unlinkedSlides` and the Layout Manager's "Not linked" group.
- Verified by `scripts/test-doc-cleanup.ts` (27 checks) and a driven browser
  pass on the same import. The estimate of ≈394 KB matched the
  `serialize()` shrink, and Undo restored it byte for byte.

## 2026-09-28 — Brand: BeeSlides, the Needle Bee (supersedes the Flamingo S)

The Slides app is renamed **BeeSlides** and gets a new mark. **Slidomingo
stays the umbrella name** for the platform, the format, Spaces and Dash.
Supersedes "Brand: the Flamingo S mark" (2026-09-24). The rule from the
same day that the chrome palette follows the brand still holds, so the
palette moved with the mark. The Flamingo S is archived in
`docs/assets/archive/flamingo-s/` (mark, icon, `brand.ts`, a replayable
splash, restore steps) and tagged `brand/flamingo-s` locally.

- **Why this name.** "BSlides" clashes with github.com/jonalmeida/bslides,
  which is also an HTML slide framework, and bslides.com is taken.
  BeeSlides was free on npm and GitHub, and beeslides.com, .app and .io had
  no DNS when checked. The nearest existing brand is Beekast, a
  presentation tool that also uses a bee. That is why our bee is a round
  chibi character on a record, nothing like a geometric insect badge.
- **The mark** (`slides/src/brand.ts`, same `logoSvg(size, {id, className,
  animated, tile})` API). A chibi bee (round head, dot eyes, cheeks, two
  curved bands) whose stinger is the stylus: the bee reaches in from the top
  right like a tonearm pivot, and the needle sits on the groove next to a
  honeycomb-hex label. The record fills the tile, black vinyl with a
  **rainbow shine** (wedges on both sides of the centre, the colours light
  splits into on real grooves). Chosen over five rounds on a concept sheet:
  three layouts, coloured records, a redrawn bee, five bee styles, then six
  chibi placements. The pick was "full plate, bigger bee".
- **16px.** At `size ≤ 24` the mark drops the grooves, face detail and
  antennae, and thickens the rim, arm and stripes. The rainbow wedges get
  wider and more opaque. At 16px it reads as a rainbow record with a honey
  centre, and the bee is only a detail. That was accepted for this layout.
  The bigger-bee layouts from the concept rounds (not kept in the repo) read
  better at 16px, if the favicon ever needs one.
- **Palette (`BRAND`).** night `#17120A`, glow `#3A2A0C`, honey `#FFC233`,
  amber `#F5A300`, deep `#D97F00`, stripe `#1A1408`, wing/cream `#FFF6E0`,
  vinyl `#0D0B08`, honeyOnLight `#9A5F00` (5.2:1 on white), and the `RAINBOW`
  bands.
  - Chrome (light): `--ink #17120A`, `--chrome #FAF7F1`, `--muted #726651`,
    `--accent #FFC233` (both themes), `--accent-text #8F5700` light and
    `#FFCF5C` dark. All are ≥ 4.5:1 on their surfaces.
  - `--warn`/`--warn-text` move from amber to orange (`#E0702E` / `#A34A12`,
    dark text `#F29A63`), and so does the connecting dot. Amber would read
    as the accent.
  - The wordmark class `.sm-mingo` is now `.sm-wm`: "**Bee**Slides", with
    the accent on "Bee".
- **New-deck defaults.** Only the ACCENT follows: `BRAND.honeyOnLight` in
  model.ts, `DEFAULT_LAYOUT_ACCENT`, kernel `mdlayout.ts` LIGHT (DARK:
  honey) and the starter-library generator. The start page's accent presets
  swap amber for the old flamingo `#E23D72`. The ink and grey literals
  (`#1D1119`, `#5A4452`, `#76606C`) are deliberately unchanged:
  `recolorLayoutAccent` and saved decks rely on them. Follow-up: the
  section-divider kicker (accent on `#1D1119`) is 3.5:1 now, down from 4.5.
- **Wording rule.** Where a string means the APPLICATION it says BeeSlides
  (window-title suffix via `appName`, `<title>`, splash, About, "Welcome to
  BeeSlides", "New to BeeSlides?", "…BeeSlides' drafts", "an empty copy of
  BeeSlides", "BeeSlides will not save over it"). Where it means the FILE,
  FORMAT or PLATFORM it stays Slidomingo: "isn't a Slidomingo document",
  "another Slidomingo deck", "Slidomingo on GitHub", the "Slidomingo deck"
  file filters, the "Slidomingo Deck" file association, "Slidomingo
  Templates", kernel import messages. Ten i18n keys were renamed in all 8
  catalogs.
- **Internal names are untouched:** the `slidomingo/slides` format,
  `#slidomingo-doc`, `.slidomingo.html`, `window.slidomingo`, IPC, CSS and
  localStorage prefixes, `appId`. Renaming them would break saved files
  (docs/PLATFORM.md).
- **Desktop userData pin.** `productName` is "BeeSlides (dev)", and
  unpackaged runs call `app.setName` to match. Electron derives userData
  from the name, so `index.ts` pins it (unless `SLIDOMINGO_USER_DATA` is
  set) to the pre-rename folder: `Slidomingo (dev)` when packaged,
  `slidomingo-desktop` unpackaged. Recent files, drafts, backups, thumbnails
  and draft partitions survive. The path is set before `setName`, which
  would otherwise move it too.
- **Splash** (hand-written CSS in `slides/index.html`, keyed to the classes
  `logoSvg({animated:true})` emits: `.sm-disc`, `.sm-bee` > `.sm-arm`,
  `.sm-wings`, `.sm-pulse`; transform origins are inline in the SVG).
  - Timeline: tile pops in 0–0.45s, the record spins from 0.2s, the bee
    flies in 0.35–0.8s, the arm drops with a bounce 0.8–1.0s, sound rings
    from 1.0s. All inside main.ts's 1.25s hold.
  - The reduced-motion rule and the no-`</div></div>`-inside-the-splash
    constraint are kept.
- **Spinner.** `spinnerSvg(size)` is the record alone, and `.sm-spinner`
  spins it; with reduced motion it pulses. `showLoading(el, text)` puts it
  in front of the Loading…/Importing… states.
- **Generated copies.** `node scripts/build-brand-assets.mjs` (favicon,
  splash SVG, README asset) and the new `scripts/export-app-icon.mjs`
  (`desktop/build/icon.png`: 824px tile on a 1024 canvas, drop shadow). The
  icon export needs playwright-core, which is not a repo dependency:
  `import('playwright-core')`, else `$PLAYWRIGHT_CORE`.
- Saved decks carry their shell, so existing files keep the Flamingo
  favicon and splash until a newer build saves them. The desktop boots the
  current shell, so there that is the first autosave. Verified by putting a
  Flamingo-era deck in the new shell: it opens, and `serialize()` writes the
  BeeSlides splash and favicon.
- **Follow-up, not done:** the build file name
  `Slidomingo_Slides.slidomingo.html` is referenced in more than 20 places
  (release.mjs, kernel save.ts, the update manifest, size budgets) and names
  the platform/app pair, so it stays for now.


---

## 2026-09-28 — Scope split: Layout Manager = this file; Library = global registry in the editor

"Reusable objects" and the "Shape library" were one feature shown twice:
both save elements and insert independent copies through the same clipboard
pipeline, and both were sibling tabs in the Layout Manager. The rule now is
**one place per scope**.

| | Deck objects (per file) | Global library (registry) |
|---|---|---|
| Stored in | `doc.reusableObjects`, inside the file | a library `.slidomingo.html` file the app remembers — format unchanged |
| Managed in | Layout Manager → **Objects** tab | the slide editor → **Library** panel (`editor/librarypanel.ts`) |
| Travels with the deck | yes | no — it belongs to the user or team |

- **The Layout Manager shows only this file's content.** Its tabs are Slide
  types, Objects (renamed from "Reusable objects") and Document properties.
  The "Shape library" tab (`'library'` in `layoutmanager.ts`'s `Tab`) is gone:
  the library is not part of any document.
- **The Library panel** is a popover from the editor toolbar/ribbon
  ("Library"). It chooses the file, searches, inserts on click, and renames,
  deletes or copies an item into this deck's objects. It is NOT in the shared
  insert group (`insertgroup.ts`), so it never appears inside the Layout
  Manager's sub-editors.
- **One insert entry, two sections.** "Objects" (`openReusableObjectPicker`)
  is the only insert entry: **In this deck** and **Library**, one search over
  both. It replaced the separate "Insert from library…" button, in the Layout
  Manager's sub-editors too.
- **Moving across scopes.** A deck object → "Save to library"
  (`saveElementsToLibrary`). A library item → "Add to this deck's objects"
  (`promoteToReusableObject` with the library doc as `sourceDoc`, i.e. a
  cross-deck paste: assets/fonts merge in). "Save selection…" (toolbar,
  ribbon, context menu, Library panel) asks **This deck's objects** or
  **Library**; the last choice is a per-viewer localStorage convenience.
- **Where the library lives.** Browser: the picked file's File System Access
  handle in IndexedDB, as before. **Desktop: main owns it**
  (`desktop/src/main/library.ts`) — a default `Slidomingo Library.slidomingo.html`
  next to the templates folder, created on first run, or a file the user chose
  (stored in app settings). The renderer cannot remember an app-wide file:
  each deck window has its own storage partition, so an IndexedDB handle would
  be a different "remembered library" per deck. Renderer access is
  `readLibrary`/`writeLibrary`/`chooseLibrary`/`useDefaultLibrary` over IPC;
  writes go only to `libraryPath()` and must be a complete slides shell
  (`libraryfs.ts`, rig `scripts/test-desktop-library.ts`, E2E
  `desktop/scripts/e2e-library.mjs`).
- **No format change.** `doc.reusableObjects` and the library file are as
  before (additivity, docs/PLATFORM.md). One convention is made explicit: a
  slide with no elements is not an item. A document needs a slide
  (`parseDoc`), so an empty library holds one empty placeholder slide; saving
  the first item replaces it, deleting the last item leaves one. This retires
  the old "Can't delete the last item" refusal.

## 2026-09-28 — Static layer stores each repeated picture once (lossless, never downscaled)

**Context.** The full-deck static layer (`slides/src/staticlayer.ts`) renders
every slide through `renderSlide`, and every `<img>` carries its full `data:`
URI, so a layout background or a logo used on N slides is written N times.
A 6.5 MB doc saved as 18.2 MB.

**Decision.**
- **Only exact duplicates are removed.** The user's rule is that size is fine
  and quality is sacred, so there is no downscaling, no re-encoding and no
  budget-driven image degradation, now or as a later tier. Every picture
  keeps its original bytes.
- **A src must be used 2+ times to be rewritten.** A single-use image stays
  the same `<img>`, so a deck with no repeats serializes exactly as before.
  Only render.ts's box-filling image shape is touched (width/height 100%
  with object-fit contain/cover/fill), which covers image elements and
  media-still posters. Media srcs, `poster` attributes and slide
  backgrounds are left alone.
- **Mechanism: CSS content replacement, not `background-image`.** Each
  repeated src becomes one rule, `.slidomingo-simg-<n>{content:url("…")}`.
  The images become `<div role="img">` elements that carry that class and
  the img's own inline style, verbatim. `content:url()` makes the div a
  replaced element, so object-fit and border-radius draw through the same
  image path. background-image was the first plan and was measured and
  rejected. In Chromium, `background-size:cover` resamples differently from
  `object-fit:cover` (24–38k pixels off on a 300×500 box) and the subpixel
  `contain` offset snaps differently. Content replacement is pixel-identical
  to main at 1× and 2× for all three fits, with radius, for PNG and raw SVG.
  Replaced content also prints, where backgrounds are dropped by default.
  Support: Chrome 28, Firefox 63, Safari/iOS 9.
- **The CSS string is escaped** (`\`→`\5c `, `"`→`\22 `, `<`→`\3c `,
  CR/LF→`\d `/`\a `). `staticLayerIsSafe` (kernel/src/save.ts) refuses a
  `<style>` whose text holds `<`, which a raw `data:image/svg+xml,<svg…`
  would. The escapes decode back to the identical URI (asserted on the
  computed `content`).
- **The shared rules are a `<style>`, never a `<div>`, placed before the
  first slide.** desktop thumbs.ts hides
  `[data-slidomingo-static-slide]:not(:first-of-type)`, so a div ahead of the
  slides would hide slide one. A reader that stops after slide one already
  has the rules.
- The pass runs inside `build()`, so `STATIC_LAYER_BUDGET` measures the
  deduplicated size. The media-still tier is unchanged and never touches
  images.

**Measured.** The current corporate template has only single-use images, and
its static layer is byte-identical to main. The older 24 MB copy of it has
192 image uses of 39 distinct pictures, 11 of them repeated, and its layer
drops from 12.9 MB to 11.5 MB.

## 2026-09-28 — The reader gate (`doc.requires`) and blob: URLs on the live page

**Context.** The format v-next plan (store-once assets, readable JSON, real
thumbnails) changes what a file can hold. `parseDoc` only ever checked
`format`, and `FORMAT_VERSION = 1` was never read. An older Slidomingo would
therefore open a newer file and save it back without whatever it did not
understand, silently. The gate had to ship first, so that every build from
now on refuses instead.

**Decision.**
- **`doc.requires?: string[]` names the features a reader must understand to
  WRITE the file.** Names, not a number: a writer lists only what this file
  actually uses, so a newer app's file that uses nothing new still opens and
  saves everywhere, and a feature can be backported on its own. `model.ts`
  has `KNOWN_FEATURES` (empty today) and `unsupportedFeatures(doc)`. A
  malformed `requires` (not an array) counts as unknown.
- **Unknown feature → read-only, never lost.** Boot (`main.ts bootWith`) puts
  the window behind the gate (`src/formatgate.ts`): a persistent banner,
  `store.readOnly`, desktop writes disabled, and every write path refuses with
  "Read-only — this document was made with a newer version of BeeSlides": ⌘S
  and Save a copy (web and desktop), Duplicate as new deck, Save as template,
  the presentation package, the player's Save a copy, "Update template",
  Save to library. Autosave does nothing at all, not even the IndexedDB
  recovery snapshot, and recovery/version restore is skipped: both would
  replace the document by another route. Closing a gated desktop window
  flushes nothing and asks nothing.
- **Nothing from a newer file is merged either.** Every foreign-document
  path refuses one: `library.ts extractForeignDoc` (library browse, slide
  type import), `openFileLike` (drop / ⌘O), Replace from JSON, `loadDoc`,
  a template (`instantiateTemplate` → new deck; `templatemenu` update in both
  directions; the start page's "Add a template file…"), and a disk reload
  of a bound file that became newer (it reboots, which gates it). The merged
  pieces would lose the same things one step removed.
- **The kernel refuses to serialize a gated document** (`serializeBody` throws
  `UnsupportedFeaturesError`), whichever path asked. The app registers what
  it knows with `registerKnownFeatures(KNOWN_FEATURES)`; until it does, only
  the kernel's own features count, so a forgotten registration refuses too
  much, never too little. `KernelDoc` gains the optional `requires` field.
- **Embedded pictures and media are `blob:` URLs on the live page**
  (`src/bloburls.ts`). `render.ts assetSrc` hands out one cached blob URL per
  `data:` string of 2 KB or more, decoded the way the browser's own `data:`
  URL processor does (fragment dropped, percent-decoded, then base64); a URI
  it cannot decode is passed through unchanged. The Store sweeps URLs whose
  bytes the document no longer holds, 10 s after a replace or edit (undo
  within that window keeps the URL). **The model and serialization never see
  a blob URL.** `RenderOpts.inlineData` keeps the `data:` output for every
  render that leaves the page: the static layer and the preview (both written
  into the file), the speaker view (its own window) and print.

**Verified.** A driven browser run on a picture/font/video/audio fixture: all
12 large srcs in the editor are `blob:` and all decode, `serialize()` holds
no `blob:`, and its doc block, static layer and preview are byte-equal to
the base build. A `requires:['x-unknown']` deck opens with the banner, ⌘S
refuses, `serialize()` throws, `loadDoc` refuses in both directions, and the
file is byte-identical afterwards. The desktop e2e (`e2e-autosave.mjs`,
new `gated` step) does the same through the real app: ⌘S, Save a copy,
Duplicate, Save as template, loadDoc and close write nothing and show no
dialog, and the file's bytes are unchanged.

## 2026-09-28 — Store every embedded byte once (`asset-store`, hash ids) — invariant change, signed off

**Context.** The corporate template was 13.7 MB: a 6.5 MB doc block of which
22.8 KB was structure, and the no-JS static layer holding the same pictures a
second time. Deduplicating inside the layer (the entry above) helped decks
that repeat a picture, not the doc/layer double.

**Signed-off invariant change** (the user approved it for format v-next;
PLATFORM.md §1/§5, format.md, agents.md): **in a plaintext file,
`#slidomingo-doc` may reference bytes stored elsewhere in the same file.** The
file stays self-contained, the splice contract is unchanged, and every file
without refs (all older files, every encrypted one) opens byte for byte as
before.

**Decision.**
- **Where the bytes live.** `<style id="slidomingo-assets"
  data-slidomingo-assets>`, directly after `#slidomingo-doc`: one rule per
  picture, `/*sha256-<16hex>*/.sa-<16hex>{content:url("…")}`, and one
  `@font-face` per embedded font (`src` first, so the parser never reads the
  author's family name), which replaces the layer's own font `<style>`. A
  video or audio clip cannot draw from CSS, so the static layer's FIRST
  `<video|audio>` for an id carries it (`data-slidomingo-store`, and
  `data-slidomingo-poster` for a poster). A <style> costs a no-JS reader
  nothing and the layer draws straight from it.
- **Ids are content hashes**: `sha256-` + 16 hex of the URI's UTF-8 text
  (synchronous SHA-256 in `kernel/src/assetstore.ts`, memoized per save).
  Content-addressed ids make a light JSON copy resolvable against any
  document that holds the picture (PR 3).
- **Refs are `"slidomingo-store:<id>"`**, replacing any JSON string equal to a
  stored URI (`doc.assets` values, inline `src`/`poster`, anywhere). A file
  with refs declares `requires: ['asset-store']` (the reader gate); every
  save recomputes it.
- **Only bytes this very save wrote elsewhere become refs.** The store holds
  what the static layer draws (every storable picture, now even when used
  once — `staticlayer.ts` marks them, the kernel turns them into
  `div.sa-…[role=img]` carrying the img's own inline style), the clips it
  carries, and what the app declares (`registerAssetStore`): every
  `data:image/*` in `doc.assets`, even for an unused slide type or a hidden
  slide (a rule nothing draws costs nothing), and every embedded font. The
  media-still tier, a failed layer, or an inline picture outside the linear
  flow simply keep their bytes in the JSON.
- **Replace, never append**: the old store is always removed. A ref the
  in-memory doc cannot resolve (stripped store, a ref-bearing `loadDoc`)
  keeps the previous save's bytes for it: a dangling ref never loses bytes
  that still exist.
- **Encrypted docs get no store** (the preview/layer veto): the bytes are part
  of what the password protects. The store's text must hold no `<` (the
  URIs are CSS-escaped; `writeAssetStore` refuses otherwise, and
  `shell-gate.mjs` checks both a store-carrying shell and the rules' shape).
- **Load resolves everywhere, and memory is always resolved.**
  `readEmbeddedDoc` resolves against the live DOM before main.ts removes the
  layer; `desktop/src/main/docfile.ts extractDocBlockText` resolves from the
  file (windows.ts launch/resolveOpen, documents.ts reload/backup, templatefs,
  templates.ts), with a `rawDocBlockText` for the format/title/flag checks;
  `library.ts extractForeignDoc`, `editor.ts openFileLike` and
  `startuppicker.ts importTemplate` use the kernel's `resolveDocText`. The
  editor, clipboard, validate and Copy JSON never see a ref for bytes the
  file holds. A file with no refs costs one substring search.
- The layer's size budget counts each distinct picture once
  (`layerBytes`), matching what the store writes.

**Measured.** The fixture deck (JPEG, PNG, raw SVG, a background shared by
three slides, a woff2, an mp4 with poster, a wav, a hidden slide) goes from
3.14 MB to 1.89 MB with each asset's bytes exactly once, the JSON at 3.4 KB,
reopen byte-equal and re-save idempotent. Its no-JS layer is pixel-identical
to the base build at 1× and 2× on every slide. The corporate template (a
scratch copy, opened as a deck) goes from 13.8 MB to 7.37 MB: doc block
6.45 MB → 23 KB, store 6.43 MB, layer 6.44 MB → 11.6 KB; reopening gives the
identical document and the static slide is pixel-identical. Verified also:
encrypted save has no store and decrypts to the full inline doc; library
import and template instantiation from a store file; a stripped store keeps
its dangling refs; the desktop e2e opens, autosaves and reopens a store file
with every byte once; `scripts/test-asset-store.ts` (29 checks) covers the
DOM-free half.

## 2026-09-28 — Readable doc block, light JSON copies, refs resolved by hash

**Context.** With the bytes in the asset store, a plaintext doc block is the
document's STRUCTURE alone (23 KB for the corporate template), so it can be
something people and agents read and edit in place. On one line it was not.

**Decision.**
- **A plaintext doc block is written with `canonicalJson`** (kernel
  `doc.ts`): two-space indent, and a key order that depends only on content —
  `format`, `version`, `requires`, `docId`, `title` lead, then on any object
  `id`, `type`, `name`, then the rest alphabetically. The same document
  always writes the same text, so a diff shows what changed. Arrays keep
  their order. An encryption envelope is not reformatted. The splice
  contract is untouched: the `<` escape is unchanged and every reader
  (`DOC_BLOCK_RE`, thumbscan, shell-gate) was already multi-line safe
  (verified: text splice and DOMParser round-trip of a pretty file, and a
  pretty block + store case in `test-desktop-thumbs.ts`). Side effect by
  design: after a save and reopen, in-memory key order is canonical too.
- **Copy document JSON** is readable as well, and gains **"Copy document
  JSON without pictures"** (web Save ▾ menu and the desktop File menu):
  every embedded `data:` string becomes its content-hash ref
  (`assetstore.lightDoc`), declaring `asset-store`. The full copy stays the
  default. The fixture deck's light copy is 6 KB.
- **Replace from JSON and `loadDoc` resolve refs by hash** against the open
  document (`model.resolveStoreRefs`: a map lookup, ids are content hashes).
  A ref the open document does not hold is kept and reported ("…kept as
  references"), never dropped; the next save keeps whatever bytes the file
  still has for it.
- The shell's tooling comment and `docs/agents.md` tell agents to leave refs,
  `requires` and `#slidomingo-assets` alone and to add new pictures inline as
  `data:` URIs.

**Verified.** Through the real UI: light copy → Replace → `serialize()` is
byte-equal to before; an unknown ref is reported and kept. Pretty files pass
shell-gate; the desktop e2e, template-window and thumbnail runs pass on them.

## 2026-09-28 — File-manager thumbnails show the real pictures

**Context.** The first-page preview (`preview.ts`, 64 KB `PREVIEW_BUDGET`)
carried its pictures' bytes itself, so any photo-heavy first page fell to
tier 2: tinted boxes where the photos were. The corporate template and the
picture fixture both thumbnailed as pink rectangles.

**Decision.**
- **The preview draws its pictures from the asset store**, like the static
  layer: `preview.ts` marks box-filling imgs storable (shared
  `staticrender.markStorable`), leaves them out of `imagesToBackgrounds`,
  and the kernel turns them into `div.sa-<id>` (keeping the classes
  `hoistRepeats` gave them) and adds their bytes to the store. svg-as-image
  pictures in the preview are stored the same way (preview-only bytes, so
  they move rather than repeat).
- **The budget counts only the preview's own markup** (`previewBytes`), so a
  photo-heavy page stays in tier 1. Tiers 2 and 3 are unchanged for markup
  that is itself too big.
- **The store sits in `<head>`**, before the preview, so a thumbnailer that
  reads only a prefix has it (desktop thumbscan already reads past the doc
  block to the preview).
- **No store, no store-drawn host**: if a save ends without a store (it
  cannot be written, or nothing is left to store), a preview or layer whose
  pictures point at it is dropped rather than shipped blank. Encrypted files
  are unchanged: no preview, no store.

**Verified with the real thumbnailer**, since Chromium alone proves nothing
here (QuickLook's WebKit mangled `<foreignObject>` before): `qlmanage -t` on
the picture fixture shows the photos, radius and embedded font where the base
showed tinted boxes; the corporate template shows its real title slide
(matching its static layer); the starter deck's QuickLook thumbnail is
pixel-identical to the base while its preview markup shrank 19.6 KB → 12 KB;
an encrypted deck still gets only the splash. **iOS Files was not
verified** (no device in this session) — it is the one renderer left to
check; `content:url()` on elements is supported since Safari/iOS 9.

## 2026-09-28 — "Optimize pictures (lossless)…" (desktop only, never automatic)

**Context.** With every byte stored once, the pictures themselves are what is
left of a file's size. The product rule stands: quality is sacred, nothing is
lossy — so the only acceptable optimization re-packs the same pixels.

**Decision.**
- **Where:** Document properties ▸ Clean up, beside "Remove unused…", in the
  desktop app only. It runs only when clicked, is ONE undoable
  `store.commit` (every occurrence of each picture's `data:` string is
  replaced in place, `model.replaceDocStrings`), and reports the bytes saved.
- **How:** the work runs in desktop main, in a worker thread
  (`desktop/src/main/optimize/worker.ts`, bundled with electron-vite's
  `?nodeWorker`), so the ~880 KB shell does not grow and no window freezes.
  - **JPEG** (`optimize/jpeg.ts`): what `jpegtran -optimize -copy all` does —
    optimal Huffman tables (T.81 Annex K.2, as libjpeg builds them) per scan,
    the SAME symbols and extra bits re-emitted, so the DCT coefficients are
    untouched; every other segment (EXIF, ICC, DQT, trailing data) copied.
    Baseline/extended-sequential only: progressive, lossless, hierarchical and
    arithmetic files are declined. No shippable jpegtran exists for Electron
    (the npm wrapper downloads binaries at install), hence our own ~350 lines.
  - **PNG** (`optimize/png.ts`): the file's own filtering plus re-filterings
    (per-row minimum-sum, None/Sub/Up/Paeth; None + adaptive for palette and
    sub-byte images), packed with zopfli (`@gfx/zopfli`, Apache-2.0, now a
    desktop dependency; 3 iterations under 1 MB of pixel data, 1 above,
    zlib 9 past 32 MB — measured: nearly all of zopfli's gain is in its first
    iteration). Every non-IDAT chunk kept byte for byte; interlaced images
    are re-packed only; APNG declined.
- **Two independent checks before anything is accepted:** the optimizer
  itself re-inflates and un-filters (PNG) or re-reads its symbol stream, and
  MAIN accepts a result only if it is smaller AND Electron's `nativeImage`
  (the same Skia the page draws with) decodes it to byte-identical pixels at
  the same size. Anything else keeps its original bytes.

**Measured.** Gallery JPEGs: 12 baseline files 0.8–4.3 % smaller (within
~0.3 % of real jpegtran), 7 progressive ones declined (jpegtran made those
larger too); libjpeg `djpeg` output identical for every one, also for
restart-interval, 4:4:4, 4:2:2 and grayscale variants. PNGs 6–77 % smaller
(the organisation's logos 25–30 %), macOS `sips` decode identical for RGB, RGBA,
palette, grayscale, 1-bit, 16-bit and interlaced. The corporate template's
4.7 MB photo is progressive, so that template gains only ~28 KB.
`scripts/test-lossless-pictures.ts` (64 checks) pins both optimizers; the
desktop e2e clicks the real button: 3 pictures, 109 KB smaller, reported,
one undo restores every byte.

## 2026-09-29 — New Template… offers every creation option, and each one writes a template

Updates the **Entry points** of 2026-09-28 "Templates are edited in their
own window". File ▸ New Template…, the footer's "＋ New template…" and the
Create template… tile no longer diverge. The first two used to ask for a name
and write an empty template. The tile offered five options, but only Empty
made a template file. The other four opened an ordinary deck.

- **One chooser.** All three open the Create template chooser
  (`startuppicker.ts openCreateFlow`). File ▸ New Template… (`startIntent:
  'new-template'`) shows the start page with the chooser already open over
  it, so ← Back lands on the page.
- **Every option ends in a template file on desktop.**
  `templatewindow.ts createTemplateFrom(doc, {name, samples})` asks for the
  name, runs `stampAsTemplate`, saves into the templates folder, and then
  turns this window into the template's window. Empty is
  `createTemplateFrom(newTemplateDoc(''))`.
  - PowerPoint: the extracted master → layout tree, no samples, and the name
    pre-filled from the file.
  - Pick a layout: every built-in slide type recolored to the accent, with
    the picked one as `defaultLayoutId` and no samples.
  - Describe it and Markdown: the slides are kept as samples. The template
    window's "Save these slides as samples" switch turns them off.
- **The browser (no template files) is unchanged.** The options hand off a
  deck as before, and there is no Empty option.

## 2026-09-30 — Templates behave like PowerPoint: one-click start, masters as groups, footer driven by settings

Raised by an imported real-world corporate template (2022 edition). Four things read as
wrong next to PowerPoint, and each now matches it.

- **One click on any template tile starts a deck** (its default slide type,
  no samples). The panel (first slide type, samples, ⋯ menu) is right-click
  ▸ Options… or the tile's ⋯ button. Amends 2026-09-29's start-page entry.
- **Masters are group headers, not slide types.** New optional
  `Slide.parentOnly: true` on a `doc.layouts` entry. The New slide and
  Change slide type… pickers group types under their master and never offer
  the master itself; the template panel, its "{n} slide types" count (also
  main's `layoutCount`), `defaultSlideType` and the agent's
  `relink_slide_type` skip it, and a type-tree leaf cannot be dropped on it.
  The Layout Manager still lists and edits it, badged "Master", and its
  right-click menu toggles "Use only as a parent". The PowerPoint import
  marks every type that has children `parentOnly` (app side; see the kernel
  follow-up below). Additive: an older reader keeps the key and just offers
  the master again.
- **Inherited chrome follows its master.** A slide's copy of an element its
  type INHERITS (`ancestorElementIds`) is locked on the slide already, so it
  can only be stale. `applyLayout(…, locked)` now gives such a slot the
  layout's content, not the donor's, unless it is a content slot (`role` or
  `placeholder`), and drops a locked leftover even when it holds text.
  `applyLinkedLayout` passes the locked set on every resync and relink.
  `resyncLinkedSlides(…, retiredIds)` gets the ids the edit just deleted from
  the open surface (`syncLayoutInstances`), applied only where that surface
  is a strict ancestor, so a deleted master text leaves every slide while a
  type's own text (the Comparison's "Option A") keeps what a slide wrote.
- **Header & footer.** `TextElement.footerRole: 'date' | 'slideNumber' |
  'footer'` (PowerPoint's dt/sldNum/ftr) marks the pieces; they stay on the
  master for position and style. `doc.headerFooter` = `{ date: {show, fixed},
  slideNumber: {show}, footer: {show, text}, hideOnTitle }` switches them
  deck-wide (absent = shown, so old files are unchanged); `slide.footer`
  (`{date|slideNumber|footer: false}`) hides one on one slide and is never
  touched by a resync. `model.footerHidden` is the one rule; `renderSlide`
  skips a switched-off piece on slides (present, print, static layer,
  thumbnails all follow) and dims it on a slide-type surface. "Title slide"
  for `hideOnTitle` = a type with a title and a subtitle and no body/media
  (`isTitleSlideType`, PowerPoint's Title Slide signature) — a heuristic
  until the converter can mark layout type="title".
- **New tokens**: `{{footer}}` (`headerFooter.footer.text`) and
  `{{prop:Name}}` (new `doc.meta.custom`, PowerPoint's custom properties —
  the classification line). `{{date}}` shows `headerFooter.date.fixed` when
  set. Edited in Document properties ("Custom properties", "Header &
  footer"), shared with the Settings modal.
- **Live fields are visible while editing.** `RenderOpts.fieldMarkers`
  (editor canvas + type-tree thumbnails only, never output): on a slide the
  value is wrapped in `.sl-field` (tint + dotted underline); on a slide type
  the field's NAME shows — ‹Page›, ‹Date›, ‹Footer›, ‹Classification› —
  because "1" or today's date there looks like typed text. Marker spans are
  our markup, so they go in after sanitizing.
- **Import a PowerPoint shows what is in the file.** It converts in
  template AND deck mode (same `pptx-*` ids, content-hashed asset keys, so
  no remap), then offers: "2 masters · 22 slide types · 27 example slides
  (they use 11 types)", All / Only the used types, and "Keep the example
  slides as samples", with each master heading its types.
- **Validator** key tables regenerated (they had lagged: `basedOn`,
  `templateId`, `templateSamples`, slide `parentId`/fonts were reported as
  unknown); the untrusted-paste sanitizer learned the new keys.

**Kernel follow-up (requested, serialized, not done here):**
`kernel/src/convert/pptx.ts` should read `showMasterSp` from
`p:sldLayout`/`p:sld` (and fix the fixtures), keep literal runs around
dt/sldNum fields ("Page ‹#›" → "Page {{page}}"), emit `footerRole` from the
dt/sldNum/ftr placeholders, mark masters `parentOnly`, take the template
theme from the master with the most layouts, and carry a layout's
`type="title"` so `hideOnTitle` can key on it: that template's title layouts come in
with `body` placeholders only, so the title+subtitle rule does not see them
as title slides (moot there — their master carries no footer).
## 2026-09-30 — New shapes are white with a grey border; ⇧⌘V is "paste without design"

**Context.** New shapes came out as solid `BRAND.honeyOnLight` blocks with no
border (the 2026-09-28 BeeSlides entry above moved only the ACCENT, but
`defaultShape` used the accent-coloured literal as its fill). Users read that
as the shape's colour, not a placeholder. Separately, ⌘C wrote the clipboard
through `navigator.clipboard`, which the desktop shell's permission handler
refused, and the failure was swallowed.

**Decision.**
- **Shape default** (`model.ts` `SHAPE_DEFAULT`): fill `#FFFFFF`, stroke
  `#9E9E9E`, `strokeWidth: 2`, for every inserted and drawn closed shape
  (the polygon tool no longer paints the accent). Lines, curves, freeforms
  and connectors keep `readableInk`. `starterdeck.ts` keeps its explicit
  borderless look. Copied into each shape at creation, so saved decks never
  change. This supersedes, for `defaultShape` only, the "New-deck defaults"
  notes in the 2026-09-24 chrome-palette entry and the 2026-09-28 BeeSlides
  entry. The deck accent is unchanged.
- **A border is colour AND width.** `setShapeStroke` / `setShapeStrokeWidth`
  (model.ts): a visible stroke colour on a width-0 shape brings width 2, and a
  width on a transparent/`none` stroke brings the default grey. Colour
  pickers lift 0% opacity to 100% when a hue is picked
  (`colorpicker.ts alphaAfterHuePick`).
- **Copy/cut ride the native `copy`/`cut` events** (`editor.ts wireCopy`),
  which need no permission in any host. The context menu keeps the async
  API, and the desktop shell now grants `clipboard-read` and
  `clipboard-sanitized-write` (`windows.ts`), the only two requests besides
  `local-fonts`.
- **⇧⌘V / Ctrl+Shift+V = paste without design** (`clipboard.ts
  restyleToDefaults`): geometry, rotation, words, links and animations stay;
  shapes and text take the defaults above, formatting is reduced to plain
  text, and pictures/charts/tables pass unchanged. Slides paste as they are.
  A `paste` event carries no modifiers, so the keydown arms a one-shot flag
  (`armPlainPaste`/`takePlainPaste`). macOS browsers bind Paste and Match Style to ⌥⇧⌘V
  and fire nothing for ⇧⌘V, so outside the desktop app a flag still armed
  50 ms later falls back to `navigator.clipboard.readText()`. The desktop
  app gets its event from Edit ▸ Paste without Design (`pasteAndMatchStyle`
  role, `menu.ts`) and never uses the fallback, which would double-paste.


## 2026-09-30 — Default styles per slide type

**Context.** Every new shape, line and text box got the same hard-coded look
(`SHAPE_DEFAULT`, `readableInk`, `defaultText()`), so a branded deck, and
especially a slide type that looks different such as a dark section slide,
needed every new object restyled by hand.

**Decision.**
- **Format** (additive, no `requires`): `Slide.styleDefaults` (meaningful on
  `doc.layouts` entries) and `doc.theme.styleDefaults` (deck fallback), both
  `StyleDefaults = { shape?, shapes?: {rect|ellipse|triangle|arrow|path},
  line?, text? }`. Every record is **partial**: a level stores only the
  fields it sets. An older reader keeps the field and ignores it (verified
  against the pre-change build), so new objects there get the built-in look.
- **Read only at creation.** Insert menu, draw tools (polygon = `shape:path`;
  line, curve, connector and freeform = `line`), pasted plain text, and ⇧⌘V
  (`restyleToDefaults` now takes the target slide AND the doc). Editing a
  default never touches objects already on slides. The same rule as the
  palette entry: no render-time inheritance.
- **Resolution** (`model.ts resolveStyleDefaults(doc, surface, kind)`),
  per FIELD, nearest first: the surface's slide type (itself when it is a
  type open in the Layout Manager, else its `layoutId`) and each ancestor,
  with `shapes[kind]` before `shape` at every level (so a nearer generic
  style beats a farther per-kind one), then `doc.theme.styleDefaults`, then
  the built-in look. `sourceOf(field)` feeds the form's "From: …" hints.
- **Colours** are literals with `themeRefs` keyed by field, as on elements.
  A ref is taken from the record whose value won. `resolveThemeRefs` walks
  the stored defaults too, so a palette edit re-derives them. In the form, a
  hand-picked colour that EXACTLY matches a palette slot is linked to it
  (`palette.ts slotForLiteral`, first slot wins). This deliberately differs
  from element colours, where a manual pick clears the ref: a default
  that happens to be a brand colour is almost always meant as one.
- **"No shadow" over an inherited shadow** is stored as an invisible shadow
  (`{blur:0,color:'transparent'}`), because absence already means "inherit".
- **⇧⌘V keeps layout-ish fields**: text alignment, corner radius and line
  tips stay as pasted, as before. An open path (no closing `Z`) is a line.
- **Form**: `editor/styledefaults.ts`, in the slide-type panel ("Default
  styles", collapsed by default) and in Document properties for the deck
  level. It writes on commit only, never live, because both hosts re-render
  on every doc change.

**Not changed (follow-ups).** Agent `insert_elements` stays explicit (its
specs are like a paste). The PPTX import does not read `a:objectDefaults`
yet, though that maps naturally onto `doc.theme.styleDefaults`. Tables,
code and charts keep their own defaults (`theme.table`, chart palette).

## 2026-09-30 — Start page: a template click starts the deck; New deck | Continue side by side

Amends the 2026-09-24 start-page entries ("Start new · Recent & drafts",
"pinned decks, one search, keyboard-first"). `slides/src/startuppicker.ts`.

- **A template tile starts the deck in one click**, the default or not:
  `instantiateTemplate` with no samples, so one slide of the template's
  default slide type (`starterSlide`), placeholders dimmed. A deck needs at
  least one slide (`parseDoc`), so "empty" means that one slide. The side
  panel stays, as **Options…**: another first slide type, "Include N sample
  slides", and ⋯ Edit / Rename / Default / Reveal / Delete. It opens from a
  ⋯ on the tile (shown on hover/focus) or right-click › Options…; the
  right-click menu is the same for every template (Options…, Edit template,
  Use as default / Stop using as default). The ⋯ is a SIBLING button
  (`div.ed-sp-tmpl` wraps tile + `.ed-sp-tile-opts`), because a button can't
  hold a button; it is not in the arrow-key tile list, and a key pressed on
  it steps as its tile does.
- **Only decks are tiles.** The New deck grid is Blank + templates. The
  imports are an **Import** line of buttons (PowerPoint…, Markdown /
  Quarto…; the button shows "Importing…" while a pick or a drop converts).
  **Create template…**, "Add a template file…" and "Templates folder" are a
  **Templates** line under it. The footer's "＋ New template…" is gone: it
  was Create template… › Empty template again. The footer keeps only "Open
  example deck".
- **Two columns, each its own card**: **New deck** left, **Continue** right
  (the latest deck as a big tile, then Pinned, then Recent & drafts). A first
  launch has nothing to continue, so that column hides and New deck takes the
  width under the welcome. Below 820px they stack, Continue first. A search
  hides a column left empty; "No matches" when both are. ↑/↓ stay in the
  column while there is a row to go to; ←/→ still walk the DOM order, so they
  cross from the last New deck tile to Continue.
- Enter with nothing focused still makes a deck from the default template,
  but only with NOTHING focused (the overlay or body): before, a focused
  footer link also counted as "nothing" and Enter started a deck.

## 2026-09-30 — Templates are called layouts; per-slide layouts are slide types; no example deck

Supersedes the wording (not the model) of 2026-09-24 and the start-page
entries above.

- **"Layout" in the UI = a template file** (slide types + theme + assets, the
  thing the start page lists and File ▸ New from Default Layout uses). Every
  user-visible "template" became "layout": the start page, Save as layout…,
  the template window's "{name} — Layout", the Layout Manager's "Layout:
  name", the desktop menu. **The per-slide strings that would clash** ("Change
  layout…", "Save as layout…", "Linked to layout", the "Layout" panel section…)
  became **"slide type"**, the word the Layout Manager already used. "Layout
  Manager" keeps its name.
- **Only English keys changed.** Each locale keeps its own word for the
  deck-level thing (Vorlage, plantilla, modèle, テンプレート…); the renamed
  per-slide keys took the locale's slide-type word (Folientyp…).
- **The format, IPC and paths keep "template"**: `template`, `templateId`,
  `basedOn`, `slidomingo:*-template*`, the "Slidomingo Templates" folder.
  docs/agents.md and the terminal panel's context README tell Claude Code
  that users say "layout".
- **No example deck.** `starterdeck.ts` is gone; the browser build and every
  empty shell boot one blank slide (`newDoc()`), still `docIsFresh` for the
  return gate. The shell loses the showcase's embedded fonts (size budget
  re-based). The validate rig's "real content stays quiet" deck is now an
  editor-built one: newDoc + every built-in slide type + a chart preset.
- **Start page cards are always the same size.** New deck and Continue are
  both always shown, equal width and height, filling the window under the
  header; Continue scrolls inside its card. A first launch shows the welcome
  (and Open…) inside the empty Continue card instead of hiding the column. A
  search never hides a card; each says "No matches" for itself. Below 820px
  they stack at natural height, Continue first.
- **Imports come two ways, for decks and for layouts alike**: *PowerPoint with
  AI…* (Claude Code rebuilds the .pptx natively in the terminal panel, from
  the file plus our converter's draft) and *From a file…* (our converters —
  pptx/md/qmd for a deck; pptx/potx/Slidomingo .html for a layout). A
  `kind: 'pptx'` generate request is validated in main (absolute existing
  .pptx/.potx) and COPIED into the context dir as `source.pptx`; the draft goes
  beside it as `pptx-converted.json`, not inline; the user's file name never
  enters the shell-interpolated task line. Create layout… keeps Empty layout,
  Start from a built-in slide type and Describe it; its PowerPoint/Markdown
  choices moved to the buttons. A drop is still a deck import.

## 2026-09-30 — Merging feature/template-fields-footer into start page v3

The branch forked before the two start-page merges; where the two designs
met, this is what the merge keeps (decided with the user):

- **Every Create layout… option ends in a layout file on desktop** (the
  branch's `CreateEnd` / `createTemplateFrom`), including "Start from a
  built-in slide type" (every built-in type, the picked one the default) and
  Describe it (its slides as samples). v3 had those two open a deck. File ▸
  New Layout… opens the chooser over the start page (`startIntent:
  'new-template'`).
- **A PowerPoint layout import is Layouts › From a file…**, not a chooser
  option, and it goes through the branch's structure step (`buildPptxView`:
  masters heading their types, all or only the used types, slides as
  samples) before it saves — silently, named after the file, like the other
  From a file… paths. Masters are marked `parentOnly` (`markMasters`), also
  in the AI layout rebuild's draft.
- **The chooser's Markdown / Quarto option is gone** (v3): a Markdown deck is
  Import › From a file…. The `pptx-layouts` boot intent stays removed.


## 2026-10-05 — PowerPoint import: hidden things stay hidden (kernel follow-up, part)

Rebuilding the corporate template from its source PowerPoint master (a
2022 `.pptx`) with no hand fixes. The old version of that template showed the
logo twice on its title slide: the master's logo was baked in, with a second
institute logo stacked under the main one. Its content types also had no green accent bar, because
they came from an older import. A fresh import has the bar on every content
type and on slides made from them, so there was no app-side cause.
`kernel/src/convert/` changes:

- **`showMasterSp` is read from the part root** (`p:sldLayout` / `p:sld`, per
  ECMA-376), with `p:cSld` as a fallback for producers that write it there.
  The fixtures had it on `p:cSld` too; they now use the spec position, and
  `fxTemplateChrome` keeps the fallback covered. All nine of its hide-master
  layouts now detach. A detached type is a root, so the New slide picker
  lists it under "Other slide types", not under its master.
- **`cNvPr hidden="1"` shapes are skipped**: top-level shapes, whole groups
  and group members (`hidden-shape-skipped`, verdict `carried`, since
  PowerPoint draws none of them). This removes the OLE stand-ins every layout
  of that template carries.
- **Covered chrome pictures are dropped.** On a master or layout, a picture
  that lies wholly inside a LATER, unrotated, fully opaque picture is not
  imported (`covered-picture-dropped`). "Opaque" is checked from the bytes:
  a JPEG, or a PNG of colour type 0/2/3 with no tRNS chunk
  (`media.ts isOpaqueRaster`). A PNG with an alpha channel never counts, even
  when every pixel is opaque. So the second institute logo under the full-bleed
  background on "Titelfolie (Verlauf)" / "Verlauf" stays, but stays
  invisible. Slide content is never pruned: a covered picture there may be a
  step of a build. Flattened slides drop the same pictures from their baked
  chrome, so they still link.
- **Furniture keeps its literal text**: "Page ‹#›" → `Page {{page}}`. A
  dt/sldNum with no field is still the bare token.
- **Default slide type with no `obj` layout** (template mode): the first
  master's first layout in list order, child or detached, which is
  PowerPoint's own pick. Before, it was the first CHILD, which the detach
  above would have moved from the template's title slide to a picture layout.
- **Template-mode theme = the master with the most layouts** (the first on a
  tie). The corporate template's first master is Office's stock Calibri theme; the brand theme
  sits on the second master, with 15 of the 22 layouts. Deck mode keeps its
  first slide's theme.

Still open from the 2026-09-30 follow-up: emitting `footerRole` from
dt/sldNum/ftr, marking masters `parentOnly` in the converter, and carrying
`type="title"`. For the rebuilt corporate template, footerRole, `{{footer}}` +
`headerFooter`, and `{{prop:Classification}}` + `meta.custom` were set after
import, carried over from the 2022 template.

## 2026-10-06 — Layout guard: agent writes reflow around themselves by default

An edit to one element used to change exactly that element: grown text
spilled over the box below, arrows kept pointing where a box had been, an
evenly spaced row lost its rhythm. `slides/src/layoutguard.ts` is now the one
engine that keeps what is AROUND an edit intact, and two callers share it:

- **Every agent write** (`editor.ts commitAgentWrite`: write_slide and the
  write verbs) runs it inside the same `store.commit`, so ⌘Z reverts the edit
  and its fix-ups together. Default on. `reflow:false` on set_frame,
  update_element, insert_elements and write_slide opts out: nothing is moved,
  the issues are still reported. Relinking a slide to its type skips it (that
  moves every box on purpose).
- **Tidy around selection** (Arrange panel, ⌥⇧T) runs it on the user's own
  edits, against the newest undo snapshot where the selection looked
  different (`Store.baselineFor`); without one, or straight after a Tidy, a
  static mode (grow-to-fit, push overlapped neighbours off, attach arrows).

What it does by itself is limited to the PREDICTABLE: a changed text box
that fitted before grows to fit; a RESIZE (edges moving apart or together)
pushes or pulls what is stacked after it so each element keeps its gap to
whatever ends last before it; a widened member of an evenly spaced row is
re-spaced inside the row's span (a column only falls back to that when the
push runs out of canvas); a shape card that held the edited content grows
with it, keeping its inner padding; a translated container carries its
children; connectors re-route on any slide (not only the open one); a free
line touching a box that moved follows it and is bound when its end sat on a
side midpoint. A MOVE (both edges shifting the same way) is deliberate and
reflows nothing. Lines, page chrome and full-bleed backdrops are never moved;
a push past the canvas is not made (`layout-no-room`). Everything else —
new partial overlaps, uneven gaps — is REPORTED with a suggested frame and
left to the agent (`⚠ LAYOUT` banner, `check_layout` until clean, ≤3 rounds)
or the user. Judging whether the slide looks GOOD stays with Claude:
`review_slide` (screenshot cropped to the slide + frames + findings) and at
most 2 polish rounds, never redesigning what the user did not ask about.

Rejected: auto-moving a box that a move landed on (that is the agent's
intent to resolve, not ours); shifting by Δ for every element below
regardless of neighbours (a shrink could then never close a gap where a
shorter column sits beside the edited one).

## 2026-10-06 — Slide moves: token model; emptied section is removed

Moving slides in the slide panel was unpredictable: a drop spliced at the raw
target index (down = after the target, up = before it), there was no
insertion line, a section's first slide could not be dragged, only one slide
moved, states were left behind, a section could not move down by one or to the
end, and ⌘↑/⌘↓ never crossed a section boundary. All of it, sectioned deck or
not, now goes through one model in `slides/src/editor/slideorder.ts` (pure,
rig: `scripts/test-slide-order.ts`):

- The panel is a list of TOKENS: section headers and slide blocks (a slide
  plus its trailing states, `slideBlocks`). Every move — a sidebar / Slide
  Sorter / Outline drop, ⌘↑/⌘↓/⌘⇧↑/⌘⇧↓ — is a permutation of tokens written
  back in ONE `store.commit` by `applyTokens`: `doc.slides` = the blocks in
  order; each `section.startSlideId` = the first block after its header.
- **A section a move leaves empty is removed** (user decision); ⌘Z brings it
  back. The boundary-marker format (2026-09-02) is unchanged and no field is
  added; dangling sections are not tokens and are left untouched.
- A drop is "in front of token N". `dropSlots` lists the valid N per mode:
  for slides, before every visible block, after every header (first slide of
  that section, collapsed too), before every header (end of the section
  above, except above a first header with nothing above it), and the end; for
  a section, only header boundaries that change something. A section is never
  offered a slot above a leading unsectioned run, since derived membership
  would absorb those slides.
- The view is one controller per surface (`editor.ts wireSlideDrop`): it maps
  slots onto the rendered rows, picks the nearest to the pointer (a snap
  limit, so a far-away drop is no drop) and draws a single insertion line —
  the line IS where the drop lands. Selected slides drag together; the whole
  header row drags its section, so rename moved to double-click.

Rejected: keeping "a section's start slide only moves with its header" (it
made the most common reorder impossible and needed a toast to explain); a
per-slide section tag (same reasons as 2026-09-02).

## 2026-10-06 — Chat history: the app keeps pointers, Claude Code keeps transcripts

The terminal panel's `claude` sessions used to be anonymous: each launch was a
fresh conversation, nothing recorded which deck it was about, and an unsaved
deck's sessions ran in a temp scratch folder, so they could not be found from
the deck once it was saved. Now (`desktop/src/main/chathistory.ts`, rig
`scripts/test-desktop-chathistory.ts`, E2E `desktop/scripts/e2e-chat-history.mjs`):

- Main picks every conversation id (`claude --session-id <uuid>`) and records
  `{id, docId, path, startedAt}` in `userData/chat-history.json`. The history
  button in the panel header lists the deck's conversations (title = the
  user's /rename, else Claude Code's `ai-title`, else the first prompt) and
  continues one in a new tab with `claude --resume <id>`. The tab's own
  session id (slide locks, context dir) is minted fresh either way.
- **A deck is its docId**, reported by the editor with its doc-state; the
  bound path is the fallback until then. Running conversations follow the
  deck when either changes (`retarget`: a generated deck loaded, Save As, a
  rename), so a draft's chats survive being saved.
- **Transcripts stay in Claude Code's own folder** (`$CLAUDE_CONFIG_DIR` or
  `~/.claude`, `projects/<cwd>/<id>.jsonl`). Verified with claude 2.1.289:
  `--resume <id>` finds a session from any folder and keeps appending to its
  original file. Retention is Claude Code's `cleanupPeriodDays` (default 30
  days); an expired transcript just drops out of the list.
- Resume is refused for an id that is not this deck's, not a uuid, or already
  running in some tab (two processes must never append to one transcript).

Rejected: copying transcripts next to the deck, or into the
`.slidomingo.html` itself. They carry raw tool output (file contents, env,
possibly secrets) and would travel with every file people share; the second
would also change the format (PLATFORM.md) and bloat the file.

## 2026-10-06 — Area comments, `resolve_comment`, `layout-tight-inset`

The user could not point Claude at "this region looks weird" — comments only
anchored to an element, a point or the slide, and spacing that is merely
*wrong* (nothing overlaps) was invisible to the guard.

- **Area anchor, additive.** `Comment` gains optional `w`/`h`; `x`,`y`,`w`,`h`
  together = a dragged rectangle (comment tool: press-drag, a plain click is
  unchanged). Old viewers ignore `w`/`h` and show a point pin at x,y, so
  PLATFORM.md format additivity holds. `commentEntries` reports
  `{type:'area', x,y,w,h, elementIds}` where `elementIds` = elements whose
  frames intersect the rectangle, so Claude gets targets without a lookup.
  Area comments default to `forAgent`.
- **`resolve_comment {commentId, reply?}` is the agent's only comment write.**
  Goes through `store.commit` (⌘Z undoes it), reply author is "Claude". Claude
  cannot create, edit or delete comments. `review_slide` lists the slide's open
  `forAgent` comments and keeps open area outlines visible in its screenshot.
- **`layout-tight-inset`** (layoutguard.ts, `tightInsetFindings`): a non-text
  box fully inside another with 0 < inset < 12px (scaled) on some side;
  `warning` when a connector ends on it, else `info`. Report-only, with a
  `suggest` frame inset to the minimum — code fixes what is predictable,
  Claude judges the rest. Flush edges (inset 0) and container children are
  deliberate and never flagged.

## 2026-10-06 — Comment author is never prompted
`Comment.author` stays a required string (format additivity), but the editor no
longer asks for it: `slidomingo-author` (set via the thread ⋯ menu) → desktop OS
username → `''`. An empty author is valid and hidden; names/avatars appear only
when a thread has more than one distinct non-empty author (e.g. you + Claude).
New comments are written in an inline composer card, not a modal dialog.

## 2026-10-06 — `agentDone`: Claude-fixed, awaiting user check
`Comment.agentDone?: string` (ISO, additive; registered in untrusted.ts +
modelkeys). Set by `resolve_comment` TOGETHER with `resolved:true`, so old
viewers show a plain resolved thread and Claude's `comments {resolved:false}`
queries skip it unchanged. The user then Accepts (drop `agentDone`) or Reopens
(drop both `agentDone` and `resolved`, `forAgent` kept; a reply on such a thread
reopens it automatically). "Send comments to Claude" auto-flags every open
comment (`forAgent`) in one commit, then sends the `fix-comments` prompt.

## 2026-10-06 — Chat history: backfill by docId, capture `/clear` via SessionStart
Still per deck (see "Chat history"). Two gaps made the menu look empty: chats
from before the feature, and sessions `claude` starts itself (`/clear`, in-pty
`/resume`). (1) `terminal:list-chats` first runs `backfillChats`: any unrecorded
`<uuid>.jsonl` in the window cwd's project folder (realpath, non-alphanumerics
→ `-`) whose text contains the deck's docId (or bound path) is claimed with
`addRecord`. The docId filter is mandatory — untitled drafts share
`slidomingo-desktop-untitled/<n>`. Rejected files are cached by id+size.
(2) A `SessionStart` hook (`session-note.mjs`) writes `session-note.json` in
the session dir; the existing watcher records the new id and updates
`session.chatId`. UI: the history button is labelled "Chats" and View ▸
Claude Chats… opens it.


## 2026-10-06 — Parallel Claude sessions may share a slide; Ctrl/Alt multi-select; ⌘A
Slide locks no longer exclude: `store.acquireLock` always succeeds and only
records the most recent writing session (badge colour). Refusing the second
session's writes (and a stale lock blocking even the first) was worse than the
rare clobber. Canvas: Ctrl/Cmd/Shift-click|marquee toggles selection, Alt-click
on an unselected element adds it (re-alt-click on the same spot still digs
deeper) and ⌘/Ctrl+A selects every unlocked element.

## 2026-10-06 — Desktop: no "Unsaved changes … were found" banner; editor animation preview
Desktop docs autosave straight to their file, so the IndexedDB recovery
snapshot is only ever an older copy (Claude edits files on disk too, which made
the banner reappear on every open). `checkRecovery` returns early when
`desktopBound()`; the browser build keeps it. Separately, Presenting ▸
"▶ Preview animation" (`slidomingo:preview-fx` → `Canvas.previewAnimations`)
plays the slide's enter/ambient/loop fx on the editor canvas via
`present.ts`'s `previewSlideFx`; any click/key/slide-change stops it and the
canvas repaints from the model.

## 2026-10-06 — Figure mode: paper figures as a Slides doc kind, exported as vector PDF/SVG
A figure is an ordinary one-slide Slides doc with two optional fields:
`doc.kind: 'figure'` and `doc.figure: { unit: 'mm'|'pt'|'in', width, height }`
(the physical size). `doc.size` stays the same size in px at 96 dpi, so a
reader that knows neither field opens it as a one-slide deck (additive, PLATFORM
§3); no `requires` entry — the worst an older build does on resave is turn it
into a plain deck. NOT a separate app: it needs the whole editor (shapes,
connectors, paths, charts, TeX, alignment, groups) and nothing else.
Gated on `doc.kind === 'figure'`: no slide list, present, notes or transitions;
a Figure panel (preset journal widths, mm/pt/in, background, grid + snap,
"Fit canvas to content"); the ribbon's PDF button becomes Export Figure ▸ PDF /
SVG / SVG with text outlined. Entry: start-page "Figure" tile, desktop File ▸
New Figure… (`StartIntent 'new-figure'`), web `#new-figure`.
- **PDF**: Chromium's own print of the 1:1 render, so text stays embedded fonts
  and SVG stays paths. Desktop: `slidomingo:export-figure` prints a self-contained
  page in a hidden window (`printToPDF`, page size = figure size, zero margins).
  Browser: the existing `exportPdf()` print path, but at the figure's size
  instead of normalised to 1600px.
- **SVG** (`slides/src/svgexport.ts`): the rendered DOM is walked element by
  element. Shapes/charts/raw svg are cloned in (ids prefixed), images are
  `<image>`, text becomes `<text>` at positions measured with per-character
  Range rects (the browser's exact wrapping), tables become rects/lines plus
  text. "Text as outlines" turns glyphs into paths with opentype.js from
  embedded fonts (or installed ones via `queryLocalFonts`); a font it cannot
  read stays `<text>` with a warning.
- **Math** is re-typeset to SVG paths with MathJax tex-svg from the `data-tex`
  attribute `render.ts` now stamps on every `<math>` (render-time only; Temml's
  `annotate` would change every deck's MathML). MathJax and opentype.js are
  loaded from jsDelivr only at export time — bundling them would bloat the
  single-file build for everyone. Offline, math falls back to MathML in a
  `<foreignObject>` with a warning.
- Not exported: gradient text (solid first stop), backgrounds that are images,
  media/embed elements; each raises a warning in the export toast.

## 2026-10-06 — Motion-path trail in static output
Static output never animates, so a motion-path element froze as a lone dot.
`renderSlide` opt `stillTrails` (set by PDF export, static layer, preview —
never canvas/present/thumbnails) draws a faint dotted `<svg>` of the route
under the element, translated to the element centre. Opt-out: additive
`fx.loop.trail?: false`. No per-element "still frame" setting.

## 2026-10-06 — Selecting overlapping elements: lock/hide, click-through, Select menu
No layers panel; instead four additive pieces.
- **`locked?` / `hidden?` on `ElementBase`** (format-additive, no `requires`;
  `untrusted.ts` has `bool` checks so they survive load and `update_element`).
  `locked` = editor-only: click-through, excluded from marquee / select-all /
  drag / nudge / line editors, but still in `hitStack`, so right-click ▸ Select
  and Alt-click reach it. Renders normally everywhere. `hidden` = omitted by
  `renderSlide` in every output (present, thumbnails, print, static layer,
  preview); the editor renders it `.slidomingo-el-hidden` (collapsed unless
  selected, then ghosted). Known cost: an OLDER viewer still shows a hidden
  element. The converter's linked-vs-flattened comparison ignores `locked`.
- **Editor-only paint hit-testing** (`RenderOpts.paintHit`, set only by
  canvas.ts → `data-hit`): unfilled shapes/lines (+ a fat transparent hit
  stroke) and text boxes (only the text block) let clicks fall through; present,
  links and static output are untouched. Selecto's CLICK hit-test is geometric,
  so `selectEnd` re-resolves a plain click from `elementsFromPoint`.
- **Backdrops** (≥80% of the page, shape/image/svg) and locked elements are
  `data-hit="none"` while unselected: a drag from them rubber-bands; a plain
  click on an unlocked backdrop still selects it (hitStack fallback in
  `selectEnd`) without dragging it. Not covered: per-pixel alpha hit-testing.
- **pptx import** sets `locked:true` on the full-bleed `-bg` image and on baked
  `mst<n>-`/`ly<n>-` non-text decoration (kernel zone, own commit).
## 2026-10-06 — One command registry; the native menu owns the catalog
On desktop the same commands lived in three drifting places (native File menu,
in-app File ▾, Save ▾): different items, different labels, an English-only
native menu, native items that silently did nothing on the start page / in
player mode, ⌘, firing twice (native accelerator + page keydown), and Check
deck / Safe zone guides unreachable. Decided:
- **Catalog + registry.** `slides/src/editor/menumodel.ts` (pure data, shared
  with desktop main) lists every command id, its English label, accelerator and
  menu position; `commands.ts` binds ids to Editor methods. No command logic is
  duplicated: inline closures were extracted into named methods.
- **Native menu = complete, grouped list** (File / Edit / Insert / Slide /
  Arrange / View / Play / Window / Help; macOS app menu holds Settings). The
  in-app chrome keeps frequent actions only: in-app **File ▾ is removed**;
  **Save ▾ lists save variants only** (copy / new deck / layout / present-only /
  password); Home ▸ History is dropped from the ribbon (Undo/Redo live in the
  title bar); Safe zone guides + Check deck join the ribbon's View tab. Web
  topbar and phone ⋯ are unchanged.
- **Renderer → main model** (`slidomingo:menu-model`), translated by the
  renderer's `t()` (main-owned labels too), with enabled/checked state. Commands
  return as ids (`slidomingo:menu-command`). `onRequestOpen` and the
  `file-menu-action` switch are gone.
- **Each shortcut has one owner.** Renderer commands: display-only accelerators
  (`registerAccelerator:false`); main-owned items keep real ones.
- **No editor → same menus, disabled** (never silent no-ops).
- **Windows/Linux**: in-window menu bar hidden, ☰ in the title bar pops up the
  same application menu.
Not decided/changed: the web topbar may adopt the registry later. Verified by
`scripts/test-menu-model.ts` and `desktop/scripts/e2e-menu.mjs`.


## 2026-10-06 — Figure SVG export: Inkscape/Illustrator-safe output
`svgexport.ts` now emits SVG 1.1 that vector tools resolve the same way
Chromium does (regression harness: `desktop/scripts/e2e-figure-export.mjs`,
which diffs PDF, Chromium, rsvg and Inkscape rasters and queries Inkscape):
- **Fonts**: each run's stack is resolved to one concrete family (generic /
  system names → `Helvetica, Arial, sans-serif`; others only if they actually
  render, probed on a canvas). New figures default to that stack too.
- **Alignment**: centred / right-aligned runs use `text-anchor` at the run's
  centre / right edge, so a substituted font does not overlap.
- **SVG 1.1 only**: shadows are blur+offset+flood+composite+merge (no
  `feDropShadow`); `<image>` has `xlink:href`; stroked text is two elements
  (no `paint-order`); blend modes stay CSS with a warning.
- **Shapes/raw svg** whose viewBox equals their box become a plain `<g>`
  (clip via `<clipPath>` when overflow is hidden) instead of a nested `<svg>`;
  charts and scaled svgs keep the viewport. Raw svg has computed paint/font
  inlined as attributes and its `<style>` dropped.
- **Structure**: each element group has a readable unique `id` and
  `inkscape:label` ("Text: Two disks damaged", "Ellipse", "SVG").
Out of scope: re-importing an edited SVG as editable elements.

## 2026-10-07 — Grid for slides + figures; G = group, ⌘G = grid

- The drawing grid is a **viewer preference** (`slidomingo-grid` in localStorage:
  `{on, slideStepPx, figureStepMm}`, `editor/gridpref.ts`), like the safe-zone
  guides — never in the document, never in exports. Slides default 20 px, figures 2 mm.
- It snaps Moveable moves/resizes, the line/curve/connector/polygon draw tools
  (element anchors still win; freehand is not snapped) and line/bezier anchor
  drags (bezier control handles and motion paths stay free).
- Shortcuts: **⌘G toggles the grid** (View ▸ Grid); plain **G** groups the
  selection (ungroups when it is exactly one group), **⇧G** ungroups. ⇧⌘G is
  unbound. Plain letters never fire in text fields; menu accelerators are
  display-only on desktop (`registerAccelerator:false`).

## 2026-10-07 — Claude workspace per deck (not the deck's folder)

- The Claude panel no longer runs `claude` in `dirname(deckPath)`. Each deck gets
  `userData/claude-workspaces/<docId>/` (`untitled-<winId>` when no docId yet);
  `.slidomingo-context-<winId>/` lives inside it. Why: the deck's folder and its
  ancestors used to become the Claude Code *project* — their CLAUDE.md, `.claude/`
  settings, hooks and git state drove the slide agent, our context dir littered
  `git status`/Dropbox, and `~/.claude.json` trusted the user's Documents folder.
- The deck's folder is still reachable: `--add-dir "$SLIDOMINGO_DECK_DIR"` (env,
  never interpolated; saved decks only, not userData/Drafts).
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is stripped from the pty env so
  that folder's CLAUDE.md stays unloaded.
- Trust is pre-accepted per workspace (only ever our own folders); the root is not
  trusted wholesale since parent-trust inheritance is unverified. `workspaces.ts`
  sweeps at app ready: `untitled-*` and docId workspaces untouched > 30 days (Claude
  Code's `cleanupPeriodDays` default), plus their `~/.claude.json` entries.
- A panel keeps its workspace for its lifetime (`PanelState.workspace`): a draft
  saved while open stays in `untitled-<n>`; the next open uses the docId one.
- History: `--resume` works from any folder, so old chats resume; `backfillChats`
  scans the workspace's AND the legacy deck folder's project folder. Old
  `.slidomingo-context-*` dirs next to decks are not cleaned up (old deck folders
  can't be found reliably) — no new ones are created.


## 2026-10-07 — Desktop present: one click, main places displays; deck PDF via printToPDF

- Desktop **Present** is one click. Renderer calls `presentBegin()` (main, `desktop/src/main/present.ts`): with 2+ displays main moves the deck window to the largest non-editor display and returns `{ speaker: true }`; the renderer then `window.open`s the speaker view, which main's window-open handler (only frame name `slidomingo-speaker`, everything else denied) places on the editor's display. `presentEnd()` restores bounds/state. 1 display: fullscreen only, `S` opens notes. "Present without Speaker View" skips all of it. The Speaker View menu/ribbon item is desktop-removed; the browser build keeps "open notes first" (macOS popup-after-fullscreen Space trap).
- The speaker window is closed when the show ends (desktop) and with the deck (`WinState.speakerWin`, closed in `unmountDocument`). Speaker-document listeners use a per-session `AbortController`, so an adopted window never drives a previous show.
- **Export PDF** (⌘P on desktop) prints the deck through the existing `slidomingo:export-figure` pdf path (`deckPrintHtml`): native save dialog, no print dialog. Browser build still uses `window.print()`.
- Status: second-display behaviour was only exercised with a faked `screen.getAllDisplays` (`desktop/scripts/e2e-present.mjs`); real two-display and the PDF path still need a manual check.

## 2026-10-07 — AI chat profiles + a native API chat mode (desktop zone)

- The chat panel no longer hardcodes `claude`. Settings ▸ AI holds **profiles** (`desktop/src/main/aiprofiles.ts`, stored in `app-settings.json` as `aiProfiles` + `defaultAiProfileId`; first run seeds one "Claude Code" profile, so nothing changes by default). Two kinds: `claude-code` (a command — `claude`, one of the user's shell functions like `claude-work`, or an absolute path — plus optional `configDir` and `env`) and `api` (a native chat, below). The panel opens with the default; "+" is a split button (click = default, caret / View ▸ New Chat With… = pick); tab labels carry the profile name; chat-history records carry `profileId` + `kind` so a resume reopens under the same profile.
- **Claude Code profiles.** The command is whitelisted (`/^[A-Za-z0-9._\/-]+$/`, no leading `-`) because it is spliced into the pty command line; it works for shell functions because the pty already runs `$SHELL -lic`. `env` values travel only in the pty env; `$NAME` values are read from the login shell — via `shellVars()`, which also asks the shell directly for variables rc files set without `export` — never into the command string. `configDir` is exported as `CLAUDE_CONFIG_DIR`, and folder trust is written to `<configDir>/.claude.json`.
- **`claude` honours only the LAST `--settings`** (verified 2026-10-07 with two SessionStart hooks: only the second ran). We always pass one for our hooks, which would silently replace what a function like `claude-gateway` (wrapping a self-hosted model gateway) passes (model, env, permissions). So "Import shell functions" records the function's `--settings` file as `settingsFile`, and `createSession` merges it into the per-session `settings.json` (`mergeSettings`: its keys kept, hook lists concatenated, ours after theirs).
- **API chat mode** (`desktop/src/main/apichat/`): no Claude Code, no pty. The agent loop lives in main; it spawns the existing `slides-mcp-server.mjs` as a stdio MCP child (via `process.execPath` + `ELECTRON_RUN_AS_NODE`) and speaks MCP JSON-RPC to it, so the tool set and the whole file-based write-back path are the SAME as Claude Code's — nothing duplicated. Providers: Anthropic Messages (also a self-hosted model gateway and any Anthropic-compatible URL; Bearer token except on api.anthropic.com) and OpenAI Chat Completions, via `@anthropic-ai/sdk` / `openai`. The transcript is stored wire-neutral (`userData/api-chats/<id>.json`, screenshots stripped); only the latest tool message's screenshots are re-sent to the model. The selection digest comes from the same function as the hook (`selection-digest.mjs` now exports `digest`). One extra tool, `read_reference`, serves `format.md`/`agents.md` (two names only). 40-turn cap; Stop aborts.
- **Keys:** an API profile names a login-shell variable (`apiKeyEnv`) and/or has a key typed into Settings, kept encrypted with `safeStorage` in `userData/ai-keys.bin`. Write-only: no IPC returns a key; the renderer only sees `hasStoredKey`. `saveAiProfiles` sanitises every field (unknown fields, unsafe commands and smuggled keys are dropped).
- Out of scope for v1: the start page's "Describe it / PowerPoint with AI…" flows depend on Claude Code reading files, so they always run a `claude-code` profile (the default if it is one, else the first).
- Tests: `scripts/test-ai-profiles.ts` (validation, env, launch line, settings merge, wire mapping, the whole loop against a mock server speaking both wires with the REAL MCP server), `desktop/scripts/e2e-api-chat.mjs` (Electron: deck edited through an API chat on both wires, profile menu, resume, Claude Code profile launch). Not exercised: a real self-hosted gateway/OpenAI endpoint and the macOS keychain prompt for `safeStorage`.

## 2026-10-07 — API chat harness: skills, subagents, compaction, caching (desktop zone)

- **Skills** (`apichat/skills.ts`): Claude Code's layout — `<name>/SKILL.md` with flat `name`/`description` frontmatter (hand-parsed, no dependency) and a markdown body. Built-ins ship as `apichat/skills/*.md` (bundled via `?raw` in `skills/index.ts`, kept apart so `skills.ts` stays plain Node for tests); the user's live in `userData/api-skills/<name>/SKILL.md` and win by name; they are re-scanned on every `send`. The model gets a "Skills" list in the system prompt and a `use_skill {name, file?}` tool; `file` may name another `.md`/`.txt` in a USER skill's folder (realpath-checked, so a symlink out is refused). The user types `/name rest…` (expanded to the skill body + the rest; the panel keeps showing what was typed); `/compact` is reserved. Settings ▸ AI has "Open skills folder" (IPC `slidomingo:ai-open-skills-folder`).
- **The MCP server has no verb to add or delete a slide** (`write_slide` answers `no-such-slide` for an unknown id). `build-deck` therefore fills the slides that exist and tells the user how many blank slides to add; do not write a skill that assumes otherwise until such a verb exists.
- **Subagents** (`apichat/subagent.ts`): local `task {description, prompt}` tool. A child is `runAgent` on a fresh message list with the parent's system prompt + a preamble, every tool except `task` (no nesting; a call anyway is refused) plus `use_skill`, 25 turns, the parent's abort signal. Only its final text comes back; its messages are not stored. Within one assistant turn ordinary tool calls run in order first, then all `task` calls run concurrently (max 4) and results keep the call order. `tool-start/end` carry `parent` (the task call id) for the panel; child text deltas are not forwarded.
- **One editor canvas → a session-wide mutex** around `review_slide` and `render_preview` (they navigate the editor; parent and children share it). Every other verb interleaves safely: requests are keyed by UUID and all writes go through the one Store (agents.md "Parallel sessions"). The system prompt tells the model to give each subagent disjoint slides.
- **Compaction** (`apichat/compact.ts`): before each provider call, if the context (last reported `input + cacheRead + cacheWrite`, else chars/4) exceeds 75 % of the profile's `contextWindow` (default 200k anthropic / 128k openai), everything before a cut is summarized by one tool-less call and replaced by a `{role:'summary'}` message. The tail keeps ≥ 4 messages and never starts on a `tool` message; images are dropped and tool results cut to ~2 KB in the summarizer input. On the wire a summary is a user message ("[Summary of the earlier conversation] …"), merged into the next user message so roles alternate. `/compact [focus]` does it on demand with no model turn. A failed summary emits an `error` and the request continues uncompacted (once per request, no retry storm). Transcript `version: 2` adds `archive` (the compacted-away messages, images stripped) so the panel still shows the whole history; v1 files still load.
- **Prompt caching + usage**: the Anthropic provider sets `cache_control` on the system prompt, the last tool and the last block of the last message; a 400 mentioning `cache_control` is retried once without it and remembered per base URL. OpenAI asks for `stream_options.include_usage` (same retry-and-remember on a 400 mentioning it). The panel footer shows `42k / 200k context · 31k cached` (plus a session total once subagents ran), restored through `sync()`. Child usage counts toward the total, not the context figure.
- Tests: `scripts/test-ai-profiles.ts` (both wires: cache_control placement and retry, usage and the estimate fallback, compaction incl. role alternation and v1/v2 transcripts, `/compact`, skills incl. path escape and override, parallel `task` calls with ordering, `parent` tags, no nesting, canvas mutex) and `desktop/scripts/e2e-api-chat.mjs` (task rows with nested child rows, usage footer, `/compact` divider). Not exercised against a real endpoint: real cache hits and real subagent parallelism on a 6-slide deck.

## 2026-10-07 — Reflection effect via `-webkit-box-reflect`; effects stay per-element fields

Added `ElementBase.reflection?: { opacity?, size?, gap? }` (additive, PLATFORM.md §3).
Rendered in `applyElementFrame` with CSS `-webkit-box-reflect` (gradient mask), so
it follows the alpha shape and includes filter effects. Chromium/Electron and Safari
draw it; Firefox ignores it (degrades to no reflection). SVG export warns
("A reflection is not exported to SVG") rather than emulating — revisit if figures
need it. Out-of-range numbers are dropped by the validator, clamped by the renderer.
No custom-effect plugin mechanism: users/AI compose effects from the existing
fields (`shadow[]`, `blur`, `blend`, `backdropFilter`, `reflection`). Details: model.ts
`ReflectionSpec`, render.ts `reflectionCss`, panels.ts `buildReflectionProps`.

## 2026-10-07 — Flip H/V mirrors the content layer, not the frame; shape/image/svg only

`flipH?/flipV?` live on `ShapeElement`/`ImageElement`/`SvgElement` (model.ts
`Flippable`), not `ElementBase`. The renderer sets `scale(±1, ±1)` on the element
node's CHILD (`applyFlip`), so the frame's `rotate()` and every consumer that
parses or composes `style.transform` — Moveable (canvas.ts), kernel `anim.ts`
`baseRotate`, present morph — are untouched (no kernel-zone change). Result:
mirror happens inside the box, before rotation (PowerPoint order); shadows stay in
screen space. **Text, table, chart, code, embed, media are not flippable** —
mirrored glyphs/controls/data are never wanted; the validator drops the keys on
those types. Multi-selection flips each element in place (no group mirroring of
positions). A flip change between two morphing slides snaps rather than tweens.
PPTX import `flipH` mapping is a separate kernel-zone follow-up (`kernel/src/convert`).


## 2026-10-07 — Click builds: `fx.step` / `exitStep` / `byParagraph`

- Until now every element effect was **timed, not clicked**: `goNext` always jumped a
  whole slide and `fx.order` only added a delay. Click builds add real multi-step
  slides. New optional `ElementBase.fx` fields: `step` (the click an element enters on;
  absent/0 = with the slide), `exitStep`, `exit` + `exitDur` (mirror of `enter`),
  `byParagraph` (text: paragraph k enters on click `(step ?? 1) + k`). Additive per
  PLATFORM.md §3 — an old viewer ignores them and shows everything at once, so **no
  `requires` gate**.
- **`fx.order` keeps its meaning** — a stagger inside ONE click, equal values together.
  It never creates a click. Within a click with no `order`, everything arrives together.
- **Clicks are compressed.** Steps 1, 3, 4 are three clicks; the authored number is
  kept (`plan.steps[i].at`) but a gap never costs the presenter a click that does
  nothing. The editor's "Appears" select offers existing clicks + "a new click".
- **`slides/src/builds.ts` is the single source of truth** (pure, model-only):
  `buildPlan`, `visibleAt`, `slideAtStep`, `stepCount`. Present, the speaker view,
  editor badges, validate and tests all read it — never re-derive visibility.
- **Paragraphs**: a top-level `<div>`/`<p>`, or a run of inline content between blocks /
  `<br>`s; blank lines (whitespace, `&nbsp;`, `<div><br></div>`) are not paragraphs.
  Splitting on a top-level `<br>` deliberately goes beyond "inline html is one
  paragraph" — agents write `a<br>b<br>c`, and one-line-per-click is what the author means.
  `builds.splitParagraphs` (string) and `present.tagParagraphs` (DOM) must agree.
  A paragraph that would arrive after the box has exited costs no click.
  `step: 0` + `byParagraph` = first paragraph with the slide.
- **An exit at or before the entrance is ignored** (and validate warns), as is anything on
  a `showOnHover` or `hidden` element.
- **Runtime** (present.ts): nodes not yet visible carry `.slidomingo-build-hidden`
  (`visibility`, so layout never shifts). `goNext` plays the next click, else jumps;
  `goPrev` un-steps instantly (never a reverse tween), else goes to the previous slide
  **arriving at its last click**. Every other arrival (link, rail, grid, End) starts at
  click 0. The incoming section's state is applied lazily at arrival, not at exit, so the
  outgoing slide doesn't blink while Reveal fades it. Morph pairs only what is on screen
  (`slideAtStep` on both sides; build-hidden nodes are skipped by `elementsById`).
  Reduced motion still gates content — clicks reveal instantly, no tween. Loops start
  when their element arrives. Print/PDF, thumbnails and the editor canvas show everything.
- Speaker view: counter "3 / 12 · click 2/4"; "Next" previews `slideAtStep(cur, step+1)`
  while clicks remain, then the next slide (PowerPoint behaviour); the rail stays per-slide.
- `slides/src/untrusted.ts` allow-lists `fx` keys — new fx keys MUST be added there too or
  an untrusted/loaded deck silently loses them.


## 2026-10-07 — Looping effects, "GIF" slides and kiosk decks

- **Generic element loops** under `fx.loop`: `pulse | spin | float | blink | wiggle` with
  `duration` (ONE FULL CYCLE, s), `amount` (pulse: +scale, float: px up, blink: opacity dip,
  wiggle: ° each side, spin: ° per turn, negative = reverse) and `delay`. Defaults in
  `model.LOOP_DEFAULTS`, shared by runtime and panel. Additive, no `requires`.
- **Kernel**: `anim.ts` got a `rotate` channel that composes with (never replaces) the
  model's `rotate()`, and `Tween.infinite`. Landed first as its own kernel-zone commits
  (branch `anim-rotate-channel`, `scripts/test-anim-rotate.ts`).
- **A loop waits for the entrance to finish.** The engine lets a newer tween on a channel
  kill an older one wholesale, so a float (y) or blink (opacity) started beside a fade-up
  would take the entrance with it and strand the element at opacity 0. `startGenericLoop`
  waits (on the engine clock) until no finite tween is running on the node, then starts.
  `settleBuildNode`/`stopLoops` cancel a start still pending. Anything that kills a node's
  tweens must also `stopLoops` it.
- **One `fx.loop` per element**, so the only same-channel clash is pulse + Ken Burns (both
  `scale`); validate warns (`loop-scale-clash`).
- **`Slide.autoBuild {every, hold?, loop?}`** ("GIF" slide): the builds play on a timer; after
  the last one it holds, then resets (kill tweens, model frames, re-hide, replay step 0) and,
  with `loop`, repeats. A slide with no builds just replays its entrance. On such a slide
  → / ← LEAVE the slide (they don't step it); entering it backwards starts it over rather than
  landing at its last click.
- **Kiosk**: `doc.present.autoAdvance` (s) + `Slide.advanceAfter` per slide; the timer calls
  `goNext`, so a click build counts as an advance. `doc.present.loop` makes Next on the last
  slide wrap (also for manual Next). Any key or pointerdown restarts the countdown; the speaker
  view shows it. Auto-play steps do NOT restart it (only input does).
- **Timers run on the animation engine's clock** (`wait()` in present.ts: a plain-object tween),
  not `setTimeout` — so `anim.setManual/tick` drives them exactly like tweens, which is what
  makes them testable. The speaker countdown is wall-clock display only.


## 2026-10-07 — .pptx import: click builds (`p:timing`) become `fx.step` / `exitStep` / `byParagraph`

- The importer no longer "imports no motion at all": it reads the **main sequence** of `p:timing`
  (`kernel/src/convert/builds.ts`). Each top-level `p:par` that waits for a click is one click;
  a first effect that starts by itself (`evt="onBegin"`) is click 0 = an entrance with the slide, no step.
  Transitions stay `'none'` (still out of scope).
- **Mapped**: `entr`/`exit` effects → `fx.step`/`fx.exitStep` on the element(s) the `spid` became
  (`s<n>-<spid>`, its `-t` text half, or every member of a group). `withEffect` shares the click and
  the stagger slot; an `afterEffect` opens a later time group in the same click → `fx.order` (only
  set when a click has more than one group). `p:txEl > p:pRg` → `byParagraph` on the text element;
  `bldP animBg="1"` makes the attached box arrive with the first paragraph.
- **Preset table** (`presetID` → kind): 10 fade; 1 Appear/Disappear → fade, 0.1 s; 2 Fly In/Out by
  `presetSubtype` (a bitmask of the side it comes FROM / goes TO: 1 top, 2 right, 4 bottom, 8 left —
  our `slide-<dir>` is named for the way it TRAVELS, so Fly In from the left is `slide-right`);
  42 (Ascend) → fade-up, 47 (Descend) → fade-down; anything else → fade, reported
  `build-effect-approximated`. Duration = the longest finite behaviour `dur` under the effect.
- **Dropped, each with a report entry**: emphasis (`build-emphasis-dropped`), motion paths
  (`build-motion-path-dropped`), interactive trigger sequences (`build-trigger-dropped`), other
  classes (`build-effect-dropped`). A click that held only dropped effects is **renumbered away**
  — the file never carries a click that does nothing.
- **Approximated**: paragraphs that are not on consecutive clicks (several at once, gaps, the first
  left static) import one-per-click (`build-paragraph-approximated`); paragraph exits take the whole
  box out. PowerPoint's soft line breaks (`a:br`) become `<br>` and so split paragraphs in slidomingo.
- **Builds pin a slide to its flattened form when they touch a layout slot** (`slide-unlinked`,
  reason `builds-on-placeholder`): a linked slide's slot elements are fresh copies of the layout's on
  every resync and only html/link ride along, so an `fx.step` there would be wiped by the next layout
  edit. Builds on free shapes keep the slide linkable.
- Depends on the slides model knowing the fx keys (DECISIONS 2026-10-07 "Click builds"); the convert
  load gate (`scripts/test-convert/load.ts`) asserts the imported fx survive `parseDoc` and read as
  7 clicks through slides' own `builds.ts`.

## 2026-10-07 — Viewer-only files: the desktop app saves a viewer, not the editor

- **Why**: a saved deck was the full editor (~965 KB); opening one in a browser dropped you into
  an editor and presenting was a mode to find. The file should be a *viewer*; the editor belongs to
  the tool. Desktop already never runs a file's own JS (every window loads its own built shell and
  gets the deck over IPC), so a file carrying only a viewer is still fully editable there.
- **Mechanism (no kernel change)**: desktop saves splice into the renderer's *pristine* copy of its
  own shell. `main.ts` now asks main for the viewer shell (`slidomingo:get-viewer-shell`,
  `getViewerShell()`) and swaps the pristine copy with the existing `adoptPristineHtml` — so every
  desktop save, Save As and template/library write emits a viewer file. Order matters only in that
  the swap happens after `capturePristine` and the `<base>` for relative media is added after (it
  never reached a file either way).
- **Build**: `npm run build:viewer` (also run by `build:single`) = `VIEWER=1 SINGLEFILE=1 vite build`
  → `slides/dist-viewer/Slidomingo_Viewer.slidomingo.html`. A `transformIndexHtml` plugin (order
  `pre`) points the same `index.html` at `src/viewer.ts` instead of `src/main.ts`, so the splash /
  doc-block markup has one source. `viewer.ts` + `player.ts` (password gate + player card, shared
  with `main.ts`) import nothing from `editor/` or `startuppicker`; `scripts/check-viewer.mjs` runs
  the conformance gate and fails the build if editor markers appear in the inflated runtime.
- **Sizes measured**: editor shell 965 KB → viewer shell 530 KB (js 959→453 KB deflated, css
  171→41 KB — styles.css is still shared whole; splitting editor CSS out is a follow-up).
- **Fallback rule**: no viewer build (or it fails `adoptPristineHtml`) → `console.warn` and the old
  behaviour (the built editor shell / dev `getAppShell`), so a missing build never blocks saving.
- **Unchanged**: the browser editor build still writes editor files (follow-up: make it and
  "Present-only file…" write viewer shells too); `doc.readonly`, the format and the splice contract
  are untouched. An old editor-shell file keeps opening in desktop and its next save turns it into a
  viewer file (the same "re-saved into the current shell" rule as before). Figure and template files
  are viewer files as well; opened in a browser they present like a deck.
- **Viewer behaviour**: opens into the show, Esc → card with Present / Save a copy (a viewer file
  with preview + static layer; encrypted decks stay encrypted); encrypted files show the password
  gate; a shell with no doc shows "This file contains no deck."; a doc from a newer format is shown
  read-only (reader gate, copies refused).
- **Verified**: playwright (deck, arrows, Esc card, copy reopens, wrong/right password, encrypted copy
  stays encrypted, empty shell); desktop e2e-autosave (an editor-shell fixture re-saved as a viewer
  file, reopened and edited in desktop, still a viewer); `qlmanage -t` renders the viewer file's
  preview.

## 2026-10-07 — Extra slides: positional, X opens/closes them while presenting

Backup / deep-dive slides under a main slide. **No format change, no new field**:
the contiguous run of `hidden` slides directly after a normal slide N are N's
*extras* (derived from slide order, like sections — `model.ts extraParent`/`extrasOf`).
While presenting, **X** on N enters the first extra, → walks the run, → past the
last extra (or X on an extra) returns to N, and the show then continues normally;
← walks back and from the first extra returns to N. A state of an extra follows
the state rules relative to that extra; a hidden run at the end of the deck is the
last slide's appendix; hidden slides before the first normal slide have no parent
(links only). This also fixes ← being a no-op on a hidden slide. **No presenting
UI** (no buttons/badges/speaker chrome) — keyboard only, in both the audience and
speaker keydown handlers; X is listed in the help overlay. In the editor the slide
panel nests extras under their parent (smaller, indented, solid border; states
stay dashed), and Slide ▸ Hide slide / the panel toggle hide the whole slide-panel
selection in one undo step (`Editor.setSlidesHidden`) — that is how a set is marked,
in any deck, with no deck-level switch. `unreachable-hidden-slide` now fires only
for a hidden slide with no parent AND no inbound link. All navigation lives in the
pure `presentNext`/`presentPrev`/`presentToggleExtras` (rig `scripts/test-present-nav.ts`).
**Known limitation:** moving a parent does not carry its extras (`slideBlocks`
groups only states); they re-nest under the slide that now precedes them. A follow-up
can extend `slideBlocks`/`slideorder.ts`.

Addendum (same day): in the slide panel, dragging slides and dropping them in the
right part of the list makes them extras (move + hide, one undo step); a drop on
the left is the unchanged plain reorder and never touches `hidden`.

Addendum 2 (same day): **leaving extras goes forward.** X on an extra, and → past
the last one, now go to the next normal slide N+1 instead of back to N (so the
presenter doesn't press → twice, and N+1's transition/morph plays because it is a
forward `deck.slide`). An appendix run at the end of the deck has no N+1 and falls
back to its parent. ← from the first extra still returns to N. In the panel, a
drop in the right part of the list targets the slide BESIDE the pointer (row
hit-test, honey ring on the target): beside a normal slide the dropped slides are
appended to the end of its extras run, beside an extra they join its run right
after it (`slideorder.ts extraDropAt`).

## 2026-10-07 — Session restore is silent: no "Reopen…?" prompt at launch

A cold launch with no file (no argv path, no macOS open-file) now reopens the
documents that were open at the last quit **without asking**, Keynote/macOS style
(`restoreSession()` in `desktop/src/main/index.ts`). Missing files are dropped
silently; nothing to restore → the usual blank/start-page window. The record in
`settings.session` stays single-use (cleared as soon as it's read). This replaces
the native [Reopen] / [Start fresh] message box from c044812d, which the user
found jarring to look at and to use. Don't reintroduce a launch prompt.

## 2026-10-07 — API chat: default output budget 32000, capped by what the server says

A profile without "Max tokens" now asks for 32000 output tokens (was 8192).
Reasoning models (GLM via an Anthropic-compatible endpoint was the report)
spend their thinking from the same budget, so 8192 regularly ended turns with
"The answer was cut off at the output limit". Models that allow less reject
the request with a 400 naming the limit; `providers/outputcap.ts`
(`withOutputCap`, applied in `providerFor`) reads that limit (Anthropic
`max_tokens: X > N`, OpenAI `at most N completion tokens`, vLLM context
length minus the prompt), retries once with it and remembers it per
baseUrl + model (not for context-length caps, which depend on the prompt).
An explicit "Max tokens" in the profile is still honoured as the ceiling.

## 2026-10-07 — "Margin guides" + "Check slides": user wording, one honest guide

The View ▸ Guides & Checks pair ("Safe zone guides" / "Check deck") was written
for agents and read that way: developer tooltips, English-only dialog, a guide
that drew a four-sided inset while the check only tested left/right. Now:
**Margin guides** draws only the two SIDE margins (full height, outside bands
tinted) — exactly what `past-margin` tests, same `marginFor`/`DEFAULT_MARGIN`
source, same `slidomingo-safe-zone` key. **Check slides** groups findings by
slide in plain, translated words (`editor/checkmessages.ts`: code → group
problem/warning/tip/technical + text). Findings a person can't act on from the
canvas, and every code the table doesn't know, sit behind a collapsed
"Show technical details" disclosure with the validator's original message.
`validate.ts` codes/messages are the agent API (`window.slidomingo.validate()`,
MCP, test-validate) and are NOT reworded — a new check there stays technical
until someone adds it to `checkmessages.ts`. Don't draw top/bottom margin
guides unless the check starts testing them.

## 2026-10-08 — Extras travel with their parent; inserts never split an extras run

Lifts the "Known limitation" of the 2026-10-07 extras entry. Still no format
change — extras stay positional. In `slideorder.ts` a picked NORMAL slide's
block brings its extras run (the hidden, non-state blocks right after it, up
to the next normal block or header: `extrasRun`), so drags, ⌘⇧↑/⌘⇧↓ and
drop-as-extras carry it. ⌘↑/⌘↓ step over UNITS (`stepUnits`: a block plus its
extras run), so a normal slide never lands between another slide and its
extras; a selected EXTRA still moves alone and steps one token, which is how
extras are reordered within a run. Inserts "after" a slide (Enter/Ctrl+M, the
New slide picker's default, paste, duplicate) go past the rest of the extras
run when they carry a normal slide (`Editor.afterSlideBlock(i, normal)`); a
paste of only hidden slides still lands right after the anchor (joining the
run). **Duplicate does not copy extras** — the copy of B is B alone, placed
after B's run. `slideBlocks` itself is unchanged (slide + states).

## 2026-10-08 — Untrusted CSS/markup: render-time rules from the core security pass

From a reviewer's sweep (all reproduced in Chromium before fixing; rigs in
`scripts/test-sanitize.ts` and `scripts/test-recovery-key.ts`):

- **svg CSS refuses escaped function names and string-fetching functions.**
  `u\72l(…)`/`u\rl(…)` are url() to the browser, and `image-set("…")`,
  `-webkit-image-set`, `image()`, `src()` take a bare string. Any function
  token whose name contains a backslash, or is one of those four, is renamed
  `slidomingo-refused(` in a sheet and fails `svgUrlRefsAllowed` in an
  attribute. Same rule as escaped at-keywords: never decode, refuse.
- **No raw `<` leaves `sanitizeSvgCss`** (becomes `\3c `). An html-namespace
  `<style>` (markup with the `<style>` outside its `<svg>`) is KEPT, because
  that is a working pattern; the escape is what keeps its text stable under
  re-serialization. Don't "fix" this by dropping non-svg-namespace elements
  without a plan for those decks.
- **Never re-parse rendered author content** (`x.innerHTML = x.innerHTML`).
  present.ts replays svg animations by cloning.
- **Render-time validation for model values that reach CSS**, as
  `renderTableHtml` already did: `slide.background` through `cssColor` at the
  shorthand length (200, same as untrusted.ts), image/media `fit` through
  {contain, cover, fill}, `radius` through `cssNum`. untrusted.ts only sees
  pastes and agent writes; a deck opened from a file never goes through it.
- **Crash-recovery key = whole doc minus `modified`/`collab`, canonical key
  order.** A field missing from `docContentKey` is an edit recovery silently
  drops.

## 2026-10-08 — Desktop: only this build's shell gets the preload bridge

Any `.html` can reach a document view (Finder association, the Open dialog), and
every view used to get the full `slidomingoDesktop` preload, whose IPC hands out
AI profile keys, writes settings and opens files. Now: (1) a file that is not a
slides deck (`openAsFor` → legacy) loads with NO preload, sandboxed; (2) every
view carrying a preload (doc view, its speaker window, the terminal panel)
refuses page-started main-frame navigation (`navguard.ts`, `will-navigate`) —
http(s) goes to the browser via `shell.openExternal`, anything else is dropped.
None of these views navigates by design (loads, reloads and `#hash` changes
don't emit `will-navigate`), so a future feature that NEEDS an in-view
navigation must allow that one URL explicitly, not remove the guard. (3) The AI
profile handlers answer only `isAppShellSender` (main frame of a doc view whose
URL is the shell / dev server). (4) Test sends a STORED key only to the baseUrl
its profile was saved with; a changed address must be saved first. Applying the
sender check to every other handler is a follow-up, not done here.

## 2026-10-08 — readZip: bounded inflate + 1 GiB declared-size ceiling

`kernel/src/convert/zip.ts` `readZip` used to inflate a DEFLATE part
completely and only then compare it with the central directory's size, so a
~1 MB .pptx could make the import allocate 1 GB+ before refusing (zip bomb;
measured 3.4 GB peak RSS). Now each part is inflated chunk by chunk
(`inflateRawBounded`) and cancelled the moment it passes its DECLARED size,
with the compressed input fed in 8 KB slices on demand (Chrome inflates a
whole input chunk before backpressure applies, so one big chunk still queued
the full bomb — +1 GB renderer RSS measured), and the sum of declared sizes is capped at `MAX_UNPACKED` (1 GiB) before any
part is inflated. Every converter that reads ZIPs (pptx today) inherits
both. Do not reintroduce a buffer-everything inflate in the reader path; raise `MAX_UNPACKED` only together with a reason
the rest of the pipeline (base64 into one HTML file) can hold the result.
Rig: `scripts/test-convert/zip.ts` (counts decompressor output).

## 2026-10-08 — Preset shapes are generators for plain `path` shapes, not a shape kind

The Shape menu's gallery (`slides/src/editor/shapepresets.ts`, ~40 presets)
makes ordinary `shape:'path'` elements: `d` + `pathBox [0,0,w,h]`, styled by
`shapeDefaultsFor(…, 'path')` like the Polygon tool. No `preset` field, no
new `ShapeKind`, no `requires`: an older reader opening or re-saving the file
loses nothing, because nothing new is saved. The cost is that a preset is
forgotten once inserted. A resized star scales as a path, and there are no
PowerPoint-style adjust handles (arrow-head length, corner radius). That
would need a stored preset id plus parameters, which is a format change and
gets its own decision. Generator rules that keep inserted presets editable:
**one subpath** (LineEditor and BezierEditor both read a path as one chain,
so a second `M` would be welded on at the first edit). Interior lines (cube
edges, can rim, predefined-process bars) are drawn by retracing, which adds
stroke but no area. The frame's hole is a keyhole joined along its corner
mitre. Output is in the editors' own forms: `M…L…Z` for straight outlines
(setPathAnchors) and `serializeBezier` for curves. With
`bezier.foldClosingNode` reading a closed curve's explicit closing segment
back as that segment, both round-trip byte-stable. Before that fix, every
edit of a closed curve added one zero-length node. Since the fold can leave
a closed curve with only 2 nodes (a lens), `serializeBezier` now writes the
closing segment + Z for any closed path of 2+ nodes (before, below 3 it
silently opened the path), and BezierEditor/LineEditor refuse to delete a
closed outline below 3 anchors. Retraced edges and the keyhole seam stack
2–3 anchors on one spot; both editors drag (and delete) such a stack as ONE
anchor (`bezier.stackedIndices`, tolerance 0.05 px), so the outline can't
tear. A line's two endpoints are never grouped. Pinned by
`scripts/test-shape-presets.ts` and its snapshot file (`--update` after an
intended shape change).

## 2026-10-08 — Find & replace: ⌘F / ⌥⌘F, inside text runs only

Edit ▸ Find… / Find and replace… (`editor/findbar.ts` UI, `editor/findreplace.ts`
pure logic, rig `scripts/test-find-replace.ts`). No format change.
- **Keys.** ⌘F = find, **⌥⌘F** = find and replace on the Mac; Ctrl+F and
  **Ctrl+H** (plus Ctrl+Alt+F) elsewhere. NOT ⌘H: macOS hides the app with it
  (browser and Electron's app-menu `hide` role both take it first), and ⇧⌘H is
  the desktop Start Page. `findChord()` is the one definition.
- **Where ⌘F is ours.** The canvas, the notes, the bar itself, and an inline
  text/cell edit — there the edit commits (the bar takes focus) and the
  selected words seed the query, PowerPoint-style; the inline editors let the
  chord through like ⌘,. Every other field (panel inputs, dialogs, terminal)
  keeps native ⌘F. Off while presenting and while the Layout Manager is open.
- **What is searched.** `doc.slides` only, in deck → reading (y, then x) →
  field order: text, table cells, code, chart labels (title, axis names,
  string categories, series / pie-slice names, legend data) and notes. Not
  slide types or deck objects, and not a linked slide's inherited chrome
  (`ancestorElementIds`, same as canvas `lockedIds`) — the next resync would
  undo it. A table-linked chart skips its derived categories/slice names.
- **Rich text.** A match lives inside ONE text run (between two tags), never
  across markup — so "foo <b>bar</b>" does not match "foo bar". We never find
  what we could not replace cleanly; a cross-run replace would have to choose
  whose formatting wins. Entities count as their character (`&nbsp;` = space),
  untouched ones stay verbatim, the replacement is escaped, and `{{field}}`
  tokens are opaque. Replacement is literal (no regex).
- **Undo.** Replace all = ONE `store.commit` (one ⌘Z); Replace = one commit per
  match, re-verified against the current text first (a stale match is refused).
- **Highlight** = CSS Custom Highlight API ranges over the canvas text nodes
  (k-th DOM occurrence = k-th model match in that field); no canvas DOM is
  modified, browsers without the API just get the selection. Chart and code
  matches select the element only; a notes match opens the notes pane.

## 2026-10-08 — .pptx tables/charts import natively; no format change

`kernel/src/convert/table.ts` and `chart.ts` turn graphicFrame `a:tbl` and
`c:chart` into the EXISTING `table` / `chart` elements — no new fields, no
`requires` entry. Choices other agents could contradict:

- **Merged cells are flattened, not modelled.** The table model has no
  colspan/rowspan; the origin cell keeps the text, covered cells come out
  empty, and the report says `table-merge-flattened`. Adding spans is a
  format change (renderer, validator, table editing ops, an older reader
  would mis-lay the row) and is a separate decision.
- **Table looks are resolved, then compressed.** PowerPoint's table style is
  applied layer by layer per cell (tableStyles.xml first, the built-in
  Medium Style 2 – Accent 1 for its GUID, plain + `table-style-unknown`
  otherwise); `TableStyle` gets the most common value per region and cells
  carry `bg`/`color`/`bold` only where they differ. Row heights and per-edge
  borders are reported, not faked.
- **Chart data comes from the caches** (`c:strCache`/`c:numCache`/literals),
  never the embedded workbook. No cache → placeholder + `chart-no-data`.
- **The chart title is a separate text element** welded to the chart by
  groupId (`<id>-t`, group `<id>-g`), because charts-lite draws no title.
- **charts-lite now honours ECharts `stack` on bars** (kernel/src/charts.ts).
  It is renderer-only: the option was already free-form JSON, and an older
  reader draws the same data clustered. Stacked lines/areas still draw
  unstacked (`chart-stack-dropped`); 100%-stacked values are frozen to
  percentages (`chart-percent-frozen`); horizontal bars draw as columns
  (`chart-bars-vertical`).
- The old `table-not-yet` / `chart-not-yet` report codes are gone; an
  unreadable table/chart part reports `table-unreadable` / `chart-unreadable`,
  an unsupported chart type `chart-type-unsupported`.

## 2026-10-08 — .pptx graphics import: review fixes (addendum to the entry above)

- **A broken graphic part never fails the import.** `convertPptx` still
  throws only for a package that is no presentation. A malformed chart part
  (or one chartFrom/tableFrom chokes on) → placeholder + `chart-unreadable` /
  `table-unreadable`; a malformed `ppt/tableStyles.xml` → no custom styles
  (built-in / plain fallback) + `table-styles-unreadable`. New importers
  reading new parts must keep this shape.
- **Table styles honour both CT_* forms:** `a:fillRef` beside/instead of
  `a:fill`, `a:lnRef` beside/instead of `a:ln`, and `a:tblBg` as the base
  fill (translucent layers are composited over it into one opaque colour —
  the table model has no layering). Theme gradients flatten to the mean of
  their stops (`table-fill-flattened`). PowerPoint for Mac embeds its
  preset table-style XML in its binary; fixtures transcribe from there.
- **Chart features charts-lite cannot draw are reported, not silent:**
  `chart-data-labels-dropped`, `chart-number-format-dropped`,
  `chart-axis-title-dropped` (x axis — the value-axis title IS carried as
  `yAxis[i].name`), `chart-axis-hidden-shown`.
- **Stacked bars are clamped to the plot** (an axis min above zero would
  push the bottom segment under the x axis); unstacked bars keep their old,
  unclamped geometry byte for byte. `validate.ts` allows `stack` on bar
  series only.

## 2026-10-08 — Alt text (`alt`) is additive with NO `requires`; three accessibility checks

`image`, `svg`, `chart` and `media` elements take an optional `alt` string
(model.ts `Describable`, untrusted.ts `str(LIMITS.alt)` = 1000 chars).
`alt: ""` is meaningful, HTML-style: decorative — `<img alt="">` /
`aria-hidden`, and the check stays quiet. Absent = not described yet.
render.ts writes it as the img `alt` (the kernel's asset store already turns
a non-empty one into `aria-label` on the `div.sa-…` in the saved no-JS layer;
it drops an EMPTY one, so a decorative image is also `aria-hidden` on its
element wrapper, which that swap leaves alone), and as
`role="img"` + `aria-label` on the svg/chart wrapper and on media stills; a
LIVE `<video>`/`<audio>` gets only `aria-label` (it is a control — role=img
or aria-hidden would hide its buttons).

**No `requires` entry, deliberately.** PLATFORM §3 gates a feature only when
an older reader would lose it on save. An older reader keeps unknown element
keys through load → edit → save (parseDoc keeps the JSON; mutations are in
place), so `alt` survives the ordinary round-trip. It is lost only where an
old reader REBUILDS an element from its key table — pasting through its
untrusted.ts — and losing a description there degrades nothing that renders.
Gating would instead open every described deck read-only in every older
build, a far worse trade for an optional annotation. Old validators report
`alt` as `unknown-key`; harmless.

**Checks** (validate.ts, friendly text in editor/checkmessages.ts):
`missing-alt` (info → tip), `low-contrast` (warning; WCAG AA 4.5:1, 3:1 for
≥ 24px or ≥ 18.66px bold, slide px), `missing-title` (info → tip). Contrast is
judged only when the backdrop is CERTAIN — a flat slide background plus solid,
unrotated rectangles covering the whole text box (translucent ones composited);
a gradient/picture background, anything else overlapping, gradient/outlined
text, inline colour runs or a blend mode = skip, never a guess. **A title is a
`role: "title"` text with written text** — the role, not size/position, because
slide types, the outline and a title placeholder key on it and the author can
set it (Advanced ▸ Role). To avoid false positives, a slide with no title slot
is flagged only with ≥ 2 pieces of written non-furniture body text (blank,
picture-only, one-statement and section-divider slides stay quiet); an EMPTY
title slot is flagged once the slide has any written text; states (`stateOf`)
and figure documents are skipped. Slide-type chrome is reported once per
deck, not once per linked slide — but only UNCHANGED, role-less chrome (same
content as the `doc.layouts` element with that id, no `role`, not a text
placeholder). A slot keeps the layout's id while holding the slide's own
content (a filled `role:'media'` slot adopts the slide's picture under the
slot id; title/body placeholders keep theirs), so keying on the id alone
collapsed ten picture slides into one tip. Such a chrome `missing-alt` finding
carries `Finding.layout` (the slide type's id), and its Check slides row opens
that slide type in the Layout Manager: alt typed on a slide's copy of chrome
does not last (applyLayout rebuilds the copy from the slide type; only text
html and link ride along), so the fix must happen in the slide type.
Contrast chrome is deduped per id AND colour pair. Don't loosen the "quiet
when unsure" rule — a check that cries wolf gets ignored wholesale.

**Known gap — importers drop alt they already have.** kernel/src/convert's
Quarto/Markdown converter reads `![alt](…)` (used as a caption) and the pptx
importer ignores `p:cNvPr@descr`; neither sets `alt` on the image it emits, so
imported pictures start as "not described". That is a kernel-zone change
(serialized), deferred: map markdown alt / `descr` to `alt`, decorative-flagged
pptx pictures to `alt: ""`, and add `alt` to convert/types.ts OutImage.

## 2026-10-08 — Image crop: fractions of the natural picture, no `requires`

`ImageElement.crop = {x, y, w, h}` (model.ts `ImageCrop`), fractions 0..1 of the
natural, UNflipped picture — not pixels (render never needs the natural size;
"Replace image…" with another resolution keeps the framing) and not l/t/r/b
insets (one shape for render, validator and editor). The region always fills
the frame (fit is ignored while cropped); the editor keeps the frame's aspect
equal to the region's, PowerPoint style: cropping moves the frame's edges in
while the picture stays put on the slide (`editor/cropmode.ts`, rotation- and
flip-aware). `model.normalizeCrop` is the one reading of a stored value
(clamp into the picture, min side `MIN_CROP` 0.01, whole picture → no crop);
`untrusted.ts` requires all four numbers in 0..1, then clamps through it.

Render: a `div.slidomingo-crop` (overflow hidden, radius) holding the WHOLE
picture absolutely placed with percentages (`left:-x/w`, `width:1/w`, …,
`object-fit:fill`). Not `object-view-box` — Chrome-only, and the saved
static layer/preview must draw it in Safari/QuickLook too. `staticrender.
markStorable` accepts this img shape, so the kernel's asset store draws it
as a `div.sa-…` with the same inline style (verified pixel-placed with JS
off); svgexport clips an offset `<image>`; a morph pair whose crop changes
crossfades.

**No `requires`.** An older reader opening a cropped picture keeps `crop` on
save (unknown fields are preserved, PLATFORM §3) — nothing is LOST, it just
draws the whole picture with `fit`. To make that fallback sensible the editor
writes `fit:'cover'` with every crop: the old reader then shows a centred crop
of the same aspect instead of a squeezed or letterboxed whole. Gating the file
read-only in older versions for a display difference was judged worse than the
degraded picture. Only paste through an older editor's validator drops it
(unknown key), the same as every other additive field.

Follow-up (kernel lane): the .pptx importer still reports
`image-crop-dropped` for `<a:srcRect>`; it maps directly onto `crop`
(`x=l, y=t, w=1-l-r, h=1-t-b`, in 1/100000).

## 2026-10-08 — Push/wipe/cover/split transitions, presenter ink, number + Enter

**Format.** `TransitionKind` gains `push`, `wipe`, `cover`, `split`, plus an
optional `Slide.transitionDir` (`right|left|bottom|top` = the side a
push/wipe/cover comes FROM; `vertical|horizontal` = the seam a split opens
along; absent = the first of `model.TRANSITION_DIRS[kind]`). **No `requires`
entry**, decided after checking what an older reader does: nothing on the
load path validates `transition` (the value round-trips through its re-save
untouched, `transitionDir` too — unknown fields are preserved), and its
present mode writes the unknown value into `data-transition`, which matches
no Reveal rule, so Reveal's base section rule plays it as a 0.8 s
crossfade. Losses are cosmetic and bounded: an old slide panel's select
shows the first option for an unknown kind, and an old build's paste
validator (`oneOf`) drops the key from a PASTED slide (the slide is kept and
crossfades). `setSlideTransition` drops a `transitionDir` the new kind can't
use.

**Player.** Reveal has no such section transitions, so present.ts draws
them (`src/transitions.ts`: pure frames + `playDrawnTransition`). Every
slide change of ours goes through `slideTo`; when the change is owned by a
drawn kind (incoming slide going forward, outgoing going back — the morph
rule) `prepTransition` switches BOTH sections to Reveal's `none` and
slidechanged plays a snapshot "ghost" of the other slide (ids stripped,
iframes/media replaced by empty boxes) under/over the real surface on the
engine clock; backward plays the frames in reverse. "Forward" is the
presenter's intent, not the index order: a looping deck wrapping from the
last slide to the first plays slide 1's transition forward
(`slideTo(i, forward)`). Reveal's own keys
(Home/End/G) bypass `slideTo` and see the static fallback `fade`. Reduced
motion cuts. Unlike morph, a drawn kind does NOT force its neighbours to
`none` statically, so a fade slide next to a push slide still crossfades.

**Ink** (`src/presentink.ts`) is presenter-session state like the laser: an
`<svg class="slidomingo-ink">` inside each slide's `.slidomingo-slide`, in
slide coordinates, `pointer-events:none` until a tool is picked — so with
ink off clicks, links, hover sets and builds are untouched. Strokes stay
with their slide for the whole show and die with the overlay; never in the
doc. Keys (audience window): P pen, H highlighter, E eraser (whole strokes),
C clear this slide, Esc puts the pen down before it ends the show; ink and
laser are mutually exclusive. P/H were Reveal's previous/left keys in the
audience window — arrows, PageUp and the speaker window's `p` still go
back. In real fullscreen the browser owns Esc (it leaves fullscreen, which
ends the show as before) — use P or the toolbar ✕ there.

**Number + Enter** jumps to the slide with that displayed number
(`model.presentJumpTarget`, the same count as `paginates`); digits were
unbound. Keys typed into a field (Reveal's G box) are left alone. The
buffer is the pure `model.presentNumberKey` (rig: test-present-nav.ts):
digits are read from the physical key (`ev.code` Digit/Numpad, `key` as
fallback) so AZERTY's unshifted top row counts, and a modifier pressed on
its own (Shift for AZERTY digits) keeps the number instead of dropping it.
Drawing with a tool in hand restarts the kiosk countdown like a click.

## 2026-10-08 — Rich text phase 1: strict sanitizer allowlist, real lists, `requires: ['rich-text']`

Text and table-cell `html` grows from b/i/u/s/code to **coloured and sized
runs, links and lists** (lane 5, branch `feature/rich-text-1`).

- **The sanitizer is the security boundary, and it is an allowlist at three
  levels** (`render.ts sanitizeHtml`): tags (`b i u s strong em code br div p
  span a ul ol li`), attributes per tag (`a`: href; `span`: style; nothing
  else anywhere), and values — an href is PARSED with `URL` and re-serialised
  (`sanitizeLinkHref`: http/https/mailto only, no credentials, C0/whitespace
  handled as the URL parser handles it, and `$ { } " ' < > \` backtick and
  space percent-encoded because resolveMath and the field markers splice the
  html as a STRING after sanitizing); a style is parsed into `color` (#hex,
  rgb()/rgba() numeric, or `var(--sl-<palette slot>)`) and `font-size` (px
  1–1000, em 0.05–20, % 5–2000) and written back from the parsed numbers
  (`sanitizeRunStyle`). Never pass-through. Links always get
  `target="_blank" rel="noopener noreferrer"` from the sanitizer, whatever the
  file said. Script/style/template/iframe… are removed whole; any other
  unknown tag is unwrapped. Nesting is bounded (any element 40 deep, lists 6
  deep → flattened to text).
- **Found and fixed on main**: the old walk iterated a SNAPSHOT of
  childNodes, so an unwrapped element's children were never visited —
  `<x-foo><img src=x onerror=…></x-foo>` in any text html rendered a live
  handler (measured in Chrome). The new walk is a sibling cursor that
  revisits unwrapped children. Pinned in scripts/test-sanitize.ts.
- **List model**: real `ul/ol/li`; a nested list lives INSIDE the item it
  indents under (browsers' indent writes it as a sibling — normalised), a
  list holds only items, and a list is never inside a line `div`/`p`
  (contentEditable builds it there — hoisted out). Click builds: each
  top-level item is one paragraph, its sub-list rides along
  (`builds.splitParagraphs` + `present.tagParagraphs`). Typed "• " bullets are
  gone from the editor (markdown autoformat/paste now make lists).
- **Format gate**: an older reader's sanitizer strips every attribute and
  unwraps a/ul/ol/li, so it would show and then SAVE the text flattened.
  Therefore a document whose text uses links, lists or styled runs carries
  `requires: ['rich-text']`, kept in step with the content by
  `model.syncRichTextRequires` on every `Store.touch`, `replaceDoc` and load
  (dropped again when the last such run goes, so the file opens everywhere
  again). Older builds open such a file read-only. Detection is typed (text
  html, table cells; never an embed's page html).
- **untrusted.ts** holds rich html to a shape: ≤ 64 KB and lists nested ≤ 16
  (counted on the string). Content stays the sanitizer's call.
- **Palette colours** in runs are stored as `var(--sl-<slot>)`; `renderSlide`
  defines `--sl-<slot>` on every surface from `paletteOf(doc)`, so a re-brand
  recolours runs with no rewrite of any text. Links are coloured
  `var(--sl-hlink, inherit)` and underlined.
- **Clicking**: the editor never follows a text link (document-level capture
  on slide surfaces); present mode/viewer open it with
  `window.open(…, 'noopener,noreferrer')` after re-checking the href; the
  desktop doc view hands http/https/mailto to `shell.openExternal` and denies
  the window. Known limitation: in fullscreen presenting, the new browser
  window can take the screen and end fullscreen (which ends the show) —
  same as any external link; a "stay in the show" mode is a follow-up.
- **Editing** (`editor/richtext.ts`) goes through the browser's commands
  (native undo keeps working) and post-processes only what a command cannot
  say (fontSize 1–7, palette slots); a commit-time tidy drops run styles equal
  to what the run inherits (Chrome copies computed styles into spans when it
  merges lines — kept, they would pin a fragment to an old colour). Popovers
  carry `data-rt-keep`; `canvas.armBlurCommit` keeps the edit alive while
  focus is in one. Copy inside an edit adds `text/x-slidomingo-rich`
  (sanitized html) so formatting survives a copy between boxes.
- Deferred: theme-token colour picking in table cells (cells have no mini
  toolbar yet — keyboard shortcuts only), hsl()/named colours, link titles,
  internal slide links from text, list start numbers/styles.


## 2026-10-08 — Rich text phase 1, review follow-ups

- **The rich-text gate is declared at write time too, not only by the
  Store.** Library files (`spliceForeignDoc`) and template updates/stamps
  (`mergeTemplateDesign`/`stampAsTemplate` → `serializeFile`) serialize docs
  the Store never saw. `slides/src/save.ts` (the slides facade over the
  kernel's save) now wraps `serializeFile`/`serializeWith`/`serializeDocInto`/
  `serializeAuto` with `withRichTextRequires` (a shallow copy, never mutating
  the caller's doc), and the library splice calls the same helper. Chosen
  over a kernel hook so the kernel zone stays untouched; a writer that builds
  file text WITHOUT save.ts must call it itself.
- **Speaker-view links are pictures, never live.** svSlide strips hrefs from
  the slides it paints into the speaker window (it has none of the main
  window's link routing). Desktop backstop: the speaker child window's
  webContents denies `window.open` and blocks navigation (Electron's default
  would open a followed link as an app window). The doc view's
  `shell.openExternal` hand-off is rate-limited to one per second, since on
  the legacy loadFile route the page is untrusted and the handler cannot
  prove a click caused the open (a true user-gesture check is a follow-up).
- **A list inside a line div counts item by item for click builds**, matching
  the renderer's `hoistLists`; `tagParagraphs` moved into builds.ts beside
  `splitParagraphs`. `hoistLists` now drops only the empty runs its own split
  creates — an author's `<div>&nbsp;</div>` blank line is content.

## 2026-10-08 — Slide titles are headings; alt on a slide type's copy warns

- **`role:'title'` text renders `role="heading" aria-level="2"`** on its
  `.slidomingo-text-inner` (render.ts), so the canvas, Reveal sections,
  thumbnails, the saved no-JS layer and the preview all carry it (staticize
  keeps `role`/`aria-*`). Level 2 because the page's own title is level 1.
  No format change: it is derived from the existing `role`. Morph ghosts and
  builds only clone/tag the node, so they keep it. Checked in
  scripts/test-sanitize.ts (live + still render).
- **Alt typed on a linked slide's copy of a slide-type element is lost on
  the next resync** (`applyLayout` carries over only text html and `link`).
  Rather than change resync semantics, the Alt text section says so and
  names the type to set it on: `model.resyncOwner` (nearest owner in the
  chain; none for a filled `role:'media'` slot, which keeps its own content,
  or a free element). scripts/test-alt-resync.ts checks the predicate
  against the real `resyncLinkedSlides`.

## 2026-10-08 — Find & replace polish: model-mapped highlights, deck undo, AltGr, context keys

Follow-ups to "Find & replace: ⌘F / ⌥⌘F" above (`editor/findbar.ts`,
`editor/findreplace.ts`). No format change. Supersedes that entry's
**Highlight** and **Keys** details where they differ:
- **Highlights are the model's matches, mapped — never a DOM re-search.**
  `findreplace.renderedSpans(source, html, renderedText, [g0,g1]…)` aligns a
  field's units with its rendered text (DOM text nodes concatenated, `.sl-field`
  chips left out) and the bar builds Ranges from that. The old per-text-node
  search disagreed with the model on whole words across tags (`cat<b>s</b>`)
  and so with the counter. Where the renderer rewrote text (an undecoded
  entity, an unresolved field token in a cell, math) the alignment re-syncs on
  the next few characters; a match it cannot place contiguously gets NO mark
  rather than a guessed one.
- **⌘Z / ⇧⌘Z / Ctrl+Y inside the bar undo/redo the deck**, not the input
  (the editor's keydown ignores text fields, and after "Replace all" focus
  stays in the replace field). The bar handles them itself, then re-searches.
- **Off the Mac, Ctrl+Alt+F is not the replace chord when it is AltGr**
  (`getModifierState('AltGraph')`, or the key types a character other than f:
  AltGr+F is "[" on CZ/SK/HU layouts). Ctrl+H is the reliable chord there.
- **Replace (one) commits only a real change.** `planReplaceMatch` verifies
  and builds the new text first; a stale match (refused) or a no-op
  replacement never opens an undo step (`store.commit` always records one).
- **Context-specific translations: `tc(en, context)`** (slides/src/i18n.ts)
  looks up the key `"{en} ({context})"` and falls back to plain `t(en)` — so
  English and any catalog without the key show the bare word. First use:
  `tc('Replace', 'find bar')` (ja 置換, while the replace-file dialog's
  `t('Replace')` stays 置き換える). Prefer this over inventing odd English to
  dodge a homonym. A first-class context argument in kernel `t()` is a
  kernel follow-up; keep the key format if that lands.
- E2E for the native menu + real keys: `desktop/scripts/e2e-find-menu.mjs`
  (it calls `app.focus({steal:true})`: the menu follows
  `BrowserWindow.getFocusedWindow()`, which a background-launched run lacks).

## 2026-10-08 — Crop and present polish (round 2)

- **A cropped picture resizes with its aspect locked; Shift frees it** — the
  inverse of every other element (Shift locks). A cropped frame always shows
  exactly the crop region, so a free resize stretches the picture, which is
  almost never wanted (PowerPoint's default for pictures, too). Uncropped
  pictures keep the free default.
- **"Reset crop" un-stretches**: with the natural size known (crop bar, panel
  via the canvas img), the whole picture comes back at its natural aspect,
  keeping its current width and centre. Without it (no DOM, e.g. a rig) the
  old frame-from-crop behaviour stays.
- **A cropped donor adopted by a `role:'media'` slot is re-cut, not cleared**:
  `model.refitCrop` gives the crop the slot's aspect at the SAME picture
  area, keeping its place as a share of the cut-away margin per axis (like
  CSS object-position): one axis narrows, the other widens into what the
  author had cut away (shrinking uniformly only when the picture has no
  room). Trade-off chosen over "never show more than the author kept"
  (narrow-only): narrowing compounds, so clicking through a few layouts in
  the picker silently zoomed the picture further on every switch, while the
  area-preserving fit is exactly reversible (A → B → A restores the crop)
  whenever the picture has room, and settles after one round trip
  otherwise. Never stretched.
- **update_element `crop: {x:0,y:0,w:1,h:1}` removes the crop** (like
  `null`); the element check itself still DROPs a whole-picture crop, so CRDT
  intake and paste are unchanged. No format change anywhere in this entry.

## 2026-10-08 — Desktop hardening: IPC sender checks, deny-by-default windows, click-only external links

- **Every ipcMain handler names its one caller** (`desktop/src/main/ipcguard.ts`
  `handleFrom`/`onFrom`). `slidomingo:*` channels answer only the main frame
  of a doc view running this build's own slides shell (`windows.ts
  isAppShellSender`), `terminal:*`/`chat:*` channels only the main frame of
  a terminal view running the terminal renderer (`terminalPanel.ts
  isTerminalSender`). Anything else — another app's page, the speaker
  window, a subframe, a view that ended up somewhere else — is refused
  before the handler runs. A refusal never throws (a rejected handle is
  logged by Electron's own console call — the EIO/EPIPE landmine): an invoke
  resolves to `{ ok: false, refused: true, error }`, a sendSync gets the
  same as its returnValue so the preload never hangs, plus one guarded log
  line per channel and sender. `scripts/test-desktop-ipc-guard.mjs` fails on
  any `ipcMain.handle/.on` outside ipcguard.ts and on a preload talking on
  the other caller's channels. The per-handler `isAppShellSender` checks on
  the AI-profile channels became this uniform guard.
- **Deny by default for every webContents** (`navguard.ts
  installDefaultGuards`, `app.on('web-contents-created')`, registered before
  any window): `window.open` is denied unless a view sets its own handler
  (only the doc view does, for the speaker frame), navigation to anything
  but the app's own pages (shell, terminal renderer, devtools) is blocked,
  `<webview>` never attaches. Main-process loads and reloads (dev-server
  reloads included) never ask.
- **External links leave only from a user's click.** Replaces the 1/s
  rate-limited `openExternal` on any doc-view `window.open` (2026-10-08,
  rich text follow-ups): window.open of a link is now always denied. Two
  ways remain, both http(s)/mailto only, at most one hand-off per second
  per view, and both read in an isolated world (id 1077) the page can't
  reach: (1) `slidomingo:open-external` (the doc preload's trusted-click
  handler for any `<a>` the page didn't already handle, and present mode's
  rich-text links via `slidomingoDesktop.openExternal`) requires a live
  transient user activation; (2) a followed link — or a `target=_blank` link's window-open request —
  in a guarded view (another app's page has no preload) is handed over only
  when it goes exactly where the last trusted click on a link pointed,
  within 1.5 s — a navigation
  consumes the activation, so it can't be asked afterwards. A script's own
  `location = …` or `window.open` never reaches the browser.
- **The speaker window gets no preload** (explicit `webPreferences` in the
  doc view's window-open handler): it is an about:blank page the deck
  paints into and drives from the opener; it never used the bridge.
- **`allDocumentWindows()` returns document windows only** (not terminal
  pop-outs, speaker windows or hidden thumbnail renderers): a second launch
  focuses a deck, Dock ▸ activate counts decks, the new-window cascade too.

## 2026-10-08 — Kernel `t()` takes a translation context (gettext msgctxt)

Kernel catch-all lane K4 (branch `fix/kernel-catchall`), the kernel follow-up
named in "Find & replace polish" above.

- **`t(en, vars?, context?)`** in `kernel/src/i18n.ts`: with a context it
  looks up the catalog key `"{en} ({context})"` first, then the plain `en`
  translation, then `en` itself — never the key. `contextKey(en, context)`
  exports the key shape. The key format is exactly the one `fix/find-polish`'s
  slides-side `tc()` uses (`"Replace (find bar)"`), so those catalog entries
  keep working unchanged and `tc(en, ctx)` reduces to `t(en, null, ctx)`.
  Pseudo locale accents the English word, not the key. `vars` accepts `null`
  so a context call without placeholders reads `t('Replace', null, 'find bar')`.
- Chosen over a separate kernel `tc()`: one entry point, one lookup path for
  plain and packed catalogs; the extra optional parameter is invisible to
  every existing call site (no caller passes `t` as a callback).
- No format change; catalogs are app data. Rig:
  `scripts/test-i18n-context.ts` (plain + packed catalogs, fallback chain,
  placeholders, pseudo).

## 2026-10-08 — Importer follow-ups: alt text, crop, transitions, real lists (kernel lane K1)

The .pptx and Markdown/Quarto importers now emit the fields the overnight
run added to the model. No new format field: `alt`, `crop`, `transitionDir`
and `requires: ['rich-text']` already exist and are already validated
(untrusted.ts) — this only fills them on import.

- **Alt text.** `p:cNvPr@descr`, else `@title`, becomes `alt` on pictures
  (svg icons included) and charts; a picture with PowerPoint's "Mark as
  decorative" (`adec:decorative val="1"` in the cNvPr extLst, matched by
  local name) gets `alt: ""` even when a stale descr is left over. No
  description at all leaves `alt` ABSENT — never `""`, which would claim
  "decorative" and silence the accessibility check. Alt is capped at 1000
  chars (untrusted.ts LIMITS.alt). Markdown: Quarto's `fig-alt` wins, else
  the bracket text (as plain text) — which also stays the visible caption.
- **Crop.** `a:srcRect` → `crop` {x:l, y:t, w:1−l−r, h:1−t−b}, clamped exactly
  as model.ts normalizeCrop does, written with `fit:'cover'` like the
  editor. A NEGATIVE side is padding (the box shows space around the
  picture); the model has no padding, so the frame is shrunk to the painted
  part — exact, rotation centre included. `image-crop-dropped` is gone; a
  srcRect that leaves nothing is `image-crop-invalid` and shows the whole
  picture. Background picture fills still ignore srcRect (unchanged).
- **Transitions.** `p:transition` → fade/push/wipe/cover/split (+ zoom),
  `transitionDir` flipped from OOXML's "the slide moves l/u/r/d" to the
  model's "comes from" (push dir="u" = from the bottom), and omitted when it
  equals the kind's default. Candidates in order: bare p:transition, each
  mc:Choice, the mc:Fallback — first effect we can draw wins, so an unknown
  p14 effect falls back to the producer's own downlevel choice, reported as
  `transition-approximated` naming the replaced effect (the report owes the
  reader every approximation, Fallback or not). Near
  relatives (Uncover, p14 pan/doors/window, dissolve, wheel…) map to the
  closest kind and report `transition-approximated`; an effect unknown in
  every branch becomes a reported fade. **Morph stays a cut**
  (`transition-morph-dropped`) instead of taking its Fallback fade: the
  spike showed an unwanted whole-slide fade is worse than a cut, and
  PowerPoint pairs morph shapes by name/content, not by our minted ids.
  Absence is still written as 'none'. Speed (`spd`, `p14:dur`) and
  auto-advance (`advTm`) are not imported.
- **Real lists (approved by the user).** Both importers write bullets as
  `<ul>/<ol>/<li>` in the exact shape sanitizeHtml keeps byte for byte (no
  attributes, nested list inside its item, no `<br>` touching a list, ≤ 6
  deep; convert/lists.ts `paragraphsHtml`) — verified in the editor: the
  rendered DOM equals the stored html. A converted document with at least
  one list carries `requires: ['rich-text']` (deduped); one without carries
  no `requires`. Two shapes stay literal text on purpose, because a real list
  would say something different:
  - **A numbered list not starting at 1** (pptx `startAt` ≠ 1 anywhere in the
    box, markdown first number ≠ 1, and EVERY step of an `.incremental`
    numbered list with more than one step — the first step too, so that its
    number lines up with the literal "2." of the next step instead of
    hanging in a real `<ol>`'s padding): the sanitizer strips `<ol start>`,
    so a real list would renumber "3." as "1.". Reports `auto-number-frozen` /
    `list-start-frozen`. Allowing `start` on `<ol>` in sanitizeHtml would
    let these become real lists — a slides-zone follow-up.
  - **A distinctive bullet glyph** (✓, ➢, ★, ♦, ❖ …): kept as glyph + `&nbsp;`
    baked into the line (`bullet-flattened`), since the list marker is the
    renderer's disc and a checkmark list read as dots loses meaning. Plain
    glyphs (• ● ◦ ○ ▪ ■ ▫ □ · – — - * ‣ ⁃) become real lists; when the
    renderer's marker differs from the deck's (a dash list drawn as dots,
    alpha numbering at depth 0) it reports `list-marker-approximated` /
    `list-numbering-approximated`. Symbol-font bullets are mapped first
    (Wingdings l → ●, ü → ✓, Ø → ➢; Courier New o → ◦; Symbol · → •) —
    previously the raw letter was baked in.
  - An `.incremental` list now steps per TOP-LEVEL item with its sub-items
    riding along (a nested item alone in its own list would lose its indent).
  - **Mixed kinds nest** (markdown): a deeper item of the other kind
    (`1. Step` / `   - detail` / `2. Step`) stays in the list as a nested
    `<ul>` inside its step; only a kind change at the list's own level
    starts a new list (md.ts MdItem carries its own `ordered`).
  - **An empty paragraph between two items is a blank line INSIDE the list**
    (pptx "1. / blank / 2."): it joins the previous item as trailing `<br>`s
    (`<li>one<br><br></li>` — one more than the blanks, the last draws no
    line), so the `<ol>` is not closed and "2." is not restarted at 1.
    PowerPoint shows no number on an empty paragraph and keeps counting.
    Exception: a blank right before a DEEPER item stays a line between two
    lists, since a `<br>` may not touch the nested list (canonical shape).
  - Imported text writes NBSP as `&nbsp;` (what a template's innerHTML
    serializes it as), so the first edit does not "change" an untouched box.
- **storePictures** (kernel save.ts): an `<img alt="">` in the static layer
  becomes `div.sa-<id>[aria-hidden=true]`, not an unlabelled `role=img`, so
  apps no longer need a wrapper `aria-hidden` to survive the no-JS swap (the
  slides renderer's wrapper attribute is now redundant but harmless).

## 2026-10-08 — Charts 2: horizontal bars, stacked lines/areas, axis names along the axis; no `requires`

charts-lite (kernel/src/charts.ts) now draws three more parts of the ECharts
option shape, the .pptx importer emits them, and the chart panel edits them.
Choices other agents could contradict:

- **Horizontal bars are ECharts' own shape**, not a new flag: `yAxis`
  `{type:'category', data, inverse?}` against ONE `xAxis` `{type:'value'}`
  (digest test: first yAxis is category and xAxis is not). First category at
  the bottom (ECharts and PowerPoint agree), `inverse` flips it. One value
  axis only (a second is ignored; the importer merges a secondary axis and
  reports `chart-secondary-axis-merged`), no `dataZoom`. The panel's "Bar
  direction" swaps the two axis objects (`slides/src/chartaxes.ts`), keeping
  their look, range and name.
- **`stack` on line series piles them** (`stackLines`), with the bars'
  'samesign' rule. Bars and lines do NOT share a pile even with the same key
  (ECharts would) — mixing them in one stack is not something the panel or
  importer produces. A stacked area fills down to the curve below it. 100%
  stacking is still frozen to shares at import (`chart-percent-frozen`), and
  `chart-stack-dropped` / `chart-bars-vertical` are gone.
- **Axis names run along their axis** (rotated −90°, outside the tick labels)
  and the plot gives up exactly the room it needs; the old end-anchored
  name above the labels clipped "Revenue" to "…evenue". A vertical chart's
  category-axis name is still not drawn. Every chart without an axis name
  renders byte-identically to before (38-option snapshot corpus compared
  against main).
- **No `requires` entry.** PLATFORM §3 gates what an older reader would LOSE
  on save; the option is free-form JSON that every reader keeps verbatim, so
  nothing is lost. An older reader does MISDRAW: a horizontal chart as a single
  category of columns (it finds no categories on xAxis), stacked lines
  unstacked, axis names in the old spot. A `requires` gate would not fix that
  (a gated deck still renders, read-only) and would lock every deck holding
  an imported horizontal bar chart in older builds — the same call as the
  bar-stack entry above. The one real risk, an older panel writing categories
  onto a horizontal chart's value axis, needs a user to edit that chart in the
  older build; accepted.
- **mountChart owns one AbortController per mount** — every host, svg and
  window listener takes its signal and dispose aborts it (the window pan
  listeners used to outlive the chart).

## 2026-10-08 — Merged table cells: spans on the anchor, covered cells kept, `requires: ['table-merge']`

Approved by the user as a format change (lane S4 of the overnight run).

- **Representation.** `TableCell.colspan`/`rowspan` (optional, whole numbers
  ≥ 2, `1` never written) on the top-left cell of a merged block. The covered
  cells STAY in the grid: every row keeps one cell per column. Chosen over
  HTML's "omit the covered cells" because every existing piece of table code
  (column steppers, column-resize handles, table→chart, find, layout guard,
  the PPTX importer's own grid, rich-text/requires scans) indexes
  `rows[r].cells[c]` as grid position (r, c) — omitting cells would have made
  each of them span-aware or wrong. An older reader also keeps a rectangular
  table with all its text.
- **Covered is derived, never stored** (no `covered`/`hMerge` flag): a flag
  next to the spans is a second source of truth that can disagree with them.
  `slides/src/tablespans.ts tableLayout` is the ONE reading — spans in reading
  order, each clamped to the grid and shrunk until it covers nothing an
  earlier anchor took; a span on a covered cell is ignored. render.ts,
  untrusted.ts, validate.ts, find and the editor all go through it, so any
  file renders as a partition of the grid into rectangles.
  `normalizeTableSpans` writes that layout back (untrusted.ts runs it on every
  pasted table; every editor op ends with it).
- **Merge empties the covered cells** and joins every non-empty text into the
  anchor, one `<br>` line each (PowerPoint/Word behaviour), so a split gives
  blank cells and nothing invisible is left behind. Text found in a covered
  cell of a file is kept but never drawn; validate reports it
  (`table-hidden-text`), and a span the grid clamps (`table-span-clamped`).
  Find skips covered cells.
- **Gate.** An older reader draws every grid cell — the merged text in its
  top-left cell beside empty cells — and would save that look as the
  author's. So a doc with a stored span above 1 declares
  `requires: ['table-merge']`, kept in step exactly like `rich-text`:
  `model.syncContentRequires` (= rich-text + table-merge) in Store
  constructor/`touch`/`replaceDoc`, save.ts's four serialize wrappers
  (`withContentRequires`; `withRichTextRequires` stays as an alias) and
  library.ts `spliceForeignDoc`. A stored span counts even when the grid
  clamps it away (a false positive costs an older reader write access to one
  file; a false negative costs the layout).
- **Structural edits with spans** (pure, `tablespans.ts`): inserting a row or
  column strictly inside a merged block grows it; deleting rows/columns
  shrinks blocks that lose them, and a block whose top row / left column is
  deleted moves (content and all) to the first row/column that stays.
  Deleting with a merged cell selected deletes every row/column it spans
  (the selection is always closed over merged cells — PowerPoint does the
  same). Pasting a block splits whatever merged cells it lands on first.
- **Editor model** (`editor/tablerange.ts`): selected cells are editor state
  on ONE table that is the whole element selection — never in the doc, a
  class on the canvas's own `<td>`s. A click on an unselected table still
  selects the TABLE (⌘C copies the element); a click on the selected table
  picks a cell (then ⌘C copies cells); Esc drops the cells. Copy carries
  `application/x-slidomingo-cells` (sanitized through
  `untrusted.sanitizeCellBlock` on paste) + TSV + an html table. "Already
  selected" means selected when the PRESS began (`canvas.selAtPress`):
  Selecto selects on mousedown and Moveable's `click` follows on the same
  gesture, so testing the selection inside `click` picked a cell on the very
  first click. The context menu's Cut/Copy/Paste act on the cells too (async
  clipboard: TSV + html; tablerange remembers the last copied block, so its
  own text pasted back keeps the spans). A cell paste never grows a table
  past `tablespans.TABLE_MAX` (= untrusted `LIMITS.rows/cols`, 2000×200);
  the rest of the block is dropped, as a re-open would drop it.
- **PPTX import is the kernel lane's** (kernel/src/convert/table.ts still
  flattens merges and reports `table-merge-flattened`): emit `colspan =
  gridSpan`, `rowspan = rowSpan` on the origin `a:tc`, keep every
  `hMerge`/`vMerge` continuation as an empty cell in its grid position, drop
  the report; the Store/save sync adds the `requires` name.


## 2026-10-08 — PPTX import: merged cells carried, all 74 built-in table styles, tblBg effects reported

Kernel lane K3 (branch `kernel/pptx-merged-cells`, on `feature/table-merge`).

- **Merged cells** (closes the last bullet of the entry above):
  `kernel/src/convert/table.ts` emits `colspan = gridSpan`,
  `rowspan = rowSpan` on the origin `a:tc` and keeps every `hMerge`/`vMerge`
  continuation as `{ html: '' }` in its grid position. Spans are read in
  reading order and clamped/shrunk exactly like `tablespans.tableLayout`, so
  the output is already in normal form (the rig checks
  `normalizeTableSpans` is a no-op on it). Covered cells take no part in the
  table-wide style choice (header/zebra/ink/border modes) and carry no
  overrides — the origin's look covers the block, PowerPoint's way. A row
  that omits its continuation cells (non-PowerPoint writers) is placed by
  gridSpan, so later cells land in their own columns. `table-merge-flattened`
  is gone; new codes `table-span-clamped` (a span cut back by the grid) and
  `table-merge-hidden-text` (text in a covered cell, which PowerPoint does
  not show either, is dropped rather than kept invisible).
- **`requires` from the converter**: `convertPptx` sets
  `requires: ['table-merge']` itself when it emitted a span (`OutDoc.requires`
  added to the structural type), so converter JSON written without slides'
  Store/save (AI-rebuild baselines, tooling) is gated too. The Store's
  `syncContentRequires` derives the same value; no new format field.
- **Built-in table styles**: every GUID PowerPoint ships (74: No Style ×2,
  Themed 1/2 × 6 accents, Light 1–3, Medium 1–4, Dark 1 × plain + 6 accents,
  Dark 2 × plain + 3 accent pairs) is generated per family as the
  `a:tblStyle` XML PowerPoint would write, replacing the single transcribed
  Medium Style 2 – Accent 1. Provenance: the GUID table and gallery order and
  each family's base definition come from Microsoft PowerPoint for Mac 16's
  binary (a GUID array plus an embedded tblStyleLst of base styles). That
  list carries the accent form only for Themed 1/2, Medium 3 and Dark 1, so
  for the others the accent variants substitute accentN for the base's
  role colour in rules and fills (text colours unchanged) — from memory of
  PowerPoint-written tableStyles.xml, not verified. Least certain: Dark
  Style 2's accent pairs (body accent A, header accent B, total-row rule kept
  dk1). Corner-cell layers (nwCell…) are not generated; styleLook ignores
  them. A deck PowerPoint saved still uses its own tableStyles.xml first.
- **tblBg effects**: an `a:effectRef` (or `a:effect`) on a table style's
  background is reported as `table-effect-dropped` (verdict dropped) only
  when it would draw something — the theme's effect style (new optional
  `ThemeCtx.effectStyles`) has a non-empty effect list or 3-D. Office 2013+
  themes leave effect styles 1–2 empty, so Themed Style 1 (idx 1) stays
  quiet and Themed Style 2 (idx 3, an outer shadow) is reported. Carrying it
  as the element's `shadow` was left out (tables never had one).
- Rig: `scripts/test-convert/tables.ts` (fixture `fxTables`: merges across
  rows and columns, a short row, seven built-ins by GUID, one table per
  built-in GUID); `graphics.ts` updated for the carried merge.

## 2026-10-08 — Rich text phase 2: cells, outline, links in the show, list numbers, SVG

- **Table cells get the text-edit mini toolbar** (B/I/U/S, colour, run size,
  lists, link) — the same `buildTextEdit` bar, placed under the edited cell
  and re-placed on input (a row grows while its cell is typed into). Only
  `minitoolbar.ts` changed; canvas.ts cell editing is untouched (the
  table-merge lane works there).
- **Outline edits keep what markdown cannot spell.** No markdown extension
  (no raw `<span>` in the field): `markdown.keptLines(html)` hands the
  field's old lines to `markdownToHtml(text, keep)`, which aligns new lines to
  old ones (LCS on the line markdown). An unchanged line takes its old html;
  a changed line paired with an old one (same gap between anchors, in order)
  gets its plain-text edit patched into the old html — common prefix/suffix
  of the text stay in their runs, new words join the run before them — and
  the patch is KEPT ONLY IF it reads back as exactly the markdown typed.
  A markup change (new bold, a link) or a line that was not a clean fragment
  (a break inside a run) converts afresh, so a word can never change; only
  formatting can be lost, and only on the line that changed shape.
  htmlToMarkdown now escapes plain lines that would read back as list items
  (`\- x`, `1\. x`, `\+ x`), and markdownToHtml unescapes `\.`/`\)`/`\+`
  only at a line start.
- **A numbered list starts only at `1.`** (per level). `2019. was a good
  year`, `3.` on its own, `01.` stay text. Chosen over an `<ol start>`:
  that is a format change (an older rich-text reader would drop `start` and
  renumber — a silent change of the text) needing a new `requires` name, a
  sanitizer extension and support in every list consumer (outline, builds,
  SVG, PPTX). Not converting never alters what was typed. Once a list is
  OPEN, any numbered line at its level continues it, as in markdown
  (`1. 1. 1.` is one list): the outline is where lists are edited as text,
  and nobody renumbers the lines after a deleted or inserted item by hand
  (a first cut that demanded the exact number there turned every later item
  into plain text). With the outline's `keep`, a numbered run may also start
  at another number when one of its items is an old numbered item (the
  first item deleted). So that this can never turn a plain line into a list,
  htmlToMarkdown escapes every plain `n. x` in a field that holds a
  numbered list.
- **Outline line pairing is by likeness, not position.** Inside a gap
  between unchanged lines, a changed line pairs with an old one only where
  the common start + end keep at least half of the old line (best-total
  alignment); otherwise it converts fresh — an inserted line never takes a
  neighbour's runs. The patch compares the old text with NBSPs read as
  spaces (the markdown has spaces), keeping the old NBSPs in place.
- **A text link clicked in a fullscreen show does not end it.** The window
  it opens takes the browser out of fullscreen; present.ts arms a guard on
  the click and treats a fullscreen exit as "keep presenting in the tab"
  while the page is away (hidden or unfocused — Chrome may deliver
  fullscreenchange only once the tab is visible again) or within 1.5 s of the
  click / of coming back; a toast says F returns to full screen (re-entering
  needs a user gesture, so it cannot be automatic). Outside that window,
  leaving fullscreen still ends the show (Esc/F unchanged). Resolves the
  phase-1 "known limitation".
- **SVG/figure export draws list markers and keeps links.** `::marker` has
  no text node, so markers are re-drawn from `list-style-type` + item index
  (disc/circle/square as shapes, like Chrome paints them; numbers/letters/
  roman as end-anchored text), on the item's first-line baseline. Text inside
  a rich-text link is wrapped in SVG `<a href xlink:href>` with the href
  judged again by `sanitizeLinkHref` (only http/https/mailto ever reach the
  file). Text decoration is collected from ancestors (a link's underline).

## 2026-10-09 — Equations: a `math` element, a palette, math in table cells; no `requires`

Inline `$…$` math has shipped since the Quarto work (Temml → MathML at render
time, symbol-level morph). What was missing was everything around it: a box
that IS a formula, a way to write TeX without knowing it by heart, math in
table cells, and the docs. Owner: feature/equations.

- **A dedicated `math` element** (`model.ts MathElement`: `tex`, `fontSize`,
  `color`, `align`, `valign`, `inline?`) rather than "a text box holding
  `$$…$$`". A text box has fonts, weights, line height, lists, links and
  markdown autoformat that all mean nothing to a formula, and its html is
  sanitized and entity-escaped — so `<` had to be typed as `&lt;` in the JSON.
  `tex` is RAW LaTeX: no delimiters, no escaping, the string an author would
  paste from a paper. `$…$` in text stays the way to put a formula inside a
  sentence; both go through the same `math.ts` (one cache, one tagger, one
  morph).
- **Same engine, no font.** Temml (MIT, +64KB) stays; KaTeX was rejected for
  size (2026-08-25), and the generic `math` family stays (2026-08-25: naming a
  maths font fixes nothing). Trust stays off: `\href`, `\url`, `\html…`,
  `\includegraphics` are refused — scripts/test-math-palette.ts pins it.
- **No `requires` name.** An older reader keeps an unknown element type on
  load and save (formats are additive, `parseDoc` does not drop it) and draws
  an empty box — nothing is lost, the formula reappears in a newer build. The
  ONE caveat: an older build's clipboard intake (`untrusted.ts
  sanitizeElement`) drops an element type its `MODEL_KEYS` does not list, so
  copying an equation into an older editor pastes nothing. Accepted: a paste
  is a copy, the source is untouched. Reopen this if a future change makes
  older readers LOSE an equation on save.
- **Display alignment is set inline, not in styles.css.** Temml writes
  `style="display:block math"` on a display formula, which stretches it and
  ignores `text-align`. render.ts sets `display: inline math` on the element's
  own `<math>` node (only for the `math` element — `$$…$$` in text keeps its
  block). Inline so the static layer and the no-JS preview, which never load
  the runtime stylesheet, align it the same way. The display STYLE (big
  operators, full fractions) is `math-style`, which the `display="block"`
  attribute keeps.
- **Insert opens the popover first.** The element is created by the commit, so
  Esc/Cancel/⌘Z leave no empty box behind. One commit = one undo step; an
  unchanged commit is no step. While open, `Editor.undo/redo` cancel the
  session (as for crop mode) — the popover is not a store step yet.
- **The box fits on commit: height to the formula, width only grows.**
  Shrinking the width moved a centred formula's anchor on every deleted term;
  growing keeps it from spilling. Growth is about the `align`/`valign` anchor,
  so a centred formula stays where it was put. The same fit runs on a size
  change from the panel/mini toolbar and on an agent's edit.json write.
- **Table cells typeset `$…$`** (renderTableHtml runs resolveMath after
  sanitizing, like text). The cell editor shows the SOURCE while editing and
  re-renders on an unchanged commit — mandatory, not cosmetic: committing the
  rendered MathML would sanitize it down to bare glyphs and lose the TeX.
- **The palette is data, tested.** `editor/mathpalette.ts` (pure): nine
  groups, 201 snippets with `{}` slots; every snippet, preview and icon must
  typeset (rig). A pick into prose (text box/cell edit) is typed as `$…$`
  unless the caret is already in math (`mathContextAt`, the resolveMath
  rules). The open group is a localStorage convenience
  (`slidomingo-math-palette-group`), never document state. Markdown
  autoformat stays out of `$…$` (`a*b*c` is TeX there).
- **Out of scope (kernel lane, serialized):** PowerPoint OMML equations →
  LaTeX on import, and Quarto `$$…$$` blocks → `math` elements.
## 2026-10-09 — Slide / Section / Summary Zoom: a `zoom` element, a zoom stack, no `requires`

**Format.** A new element `type: "zoom"` (model.ts `ZoomElement`):
`target: {slide: id} | {section: id}`, `range?: 'slide' | 'section'` (slide
targets only: just that slide, or on to the end of its section),
`returnToZoom?` (absent = true), `duration?` (s), frame `stroke`/`strokeWidth`/
`radius`. Everything else is DERIVED from slide order, like sections and
extras: `zoomRange`, `zoomCover`, `ZoomFrame` walkers (`zoomNext`/`zoomPrev`/
`inZoomFrame`/`zoomStackAt`). Rigs: `scripts/test-zoom.ts`,
`scripts/test-present-nav.ts`, `scripts/test-zoom-e2e.mjs`.

**No `requires` entry**, by the same test as alt text / drawn transitions:
an older reader keeps the element through load → edit → save (parseDoc keeps
the JSON, mutations are in place), its renderer's switch matches nothing and
draws an empty box, and its present mode never zooms. It is lost only where
an old build REBUILDS an element from its key table (an old paste validator
drops an unknown type) — losing a tile from a paste degrades nothing that
renders. Gating would open every deck with a tile read-only in every older
build. `target` is deliberately NOT a required key: a tile whose target is
gone stays (an empty "Zoom target missing" box in the editor, nothing in the
show) and `validate()` says `zoom-missing-target`; `zoom-target-state` and
`zoom-self-target` cover tiles that would play nothing.

**Playback rules** (present.ts, so the editor tab, the player and the viewer
build all share them):
- A tile click (or Enter/Space on the focused tile — tiles are `role=button`,
  `tabindex=0` in the show) pushes a frame and dives into the range. A tile
  click wins over the element's `data-link` and never plays a build step.
- **Hidden slides are walked inside a range** (a section zoom plays the whole
  section, its hidden slides included); interactive states are skipped by →
  but stay inside the frame through their parent; the overview is never part
  of its own range.
- → past the last slide and ← on the first slide zoom back out, to the
  overview **at the click it was left on** (`arriveStep`), without
  replaying its entrances.
- **Leaving the range by any other route closes the zoom**: slidechanged pops
  frames whose range no longer holds the slide on screen, from the top only
  (an outer zoom waits while an inner one plays a range outside it). One rule
  covers links, typed numbers, the speaker grid, Reveal's own keys, a loop
  wrap and the kiosk timer — no route needs zoom-specific code.
- `returnToZoom: false` dives in and opens no frame; the show carries on.
- The speaker view's next preview says "Back to zoom" and shows the overview
  at its saved click.

**The camera** (src/zoom.ts) is a uniform scale about the ONE point of the
overview that stays put, with scale interpolated in log space (`s = S^p`), so
it reads as a straight dive and equal times look like equal zoom speed. It
plays instead of morph or a drawn transition (both sections are cut, the
same override/restore as drawn transitions; the ghost is transitions.ts
`makeGhost`). **Tile rotation is ignored by the motion**; a tile as big as the
slide or hanging off it crossfades instead; reduced motion cuts.

**Editor.** Insert ▸ Zoom ▸ "Slide or section zoom…" (one tile on the current
slide) and "Summary zoom…" (one overview slide with one SECTION tile per pick,
in a "Summary" section of its own, before the first picked section — a picked
slide that does not start a section yet starts one, as in PowerPoint), one
commit each. A tile's nested picture is a still render with every `data-*`
attribute and link href stripped, `inert`, and `pointer-events: none`; the
canvas queries elements as `.slidomingo-el[data-el-id]`, so a marquee or a
click can never reach into it. Tiles keep their aspect when resized.
Integrity: duplicating slides remaps tiles that point inside the copied set
(as links are), pasting slides remaps tiles inside the pasted set, deleting a
slide/section removes the tiles that zoomed into it (counted in the confirm),
ungrouping a section turns its zooms into slide zooms of its first slide. A
section that disappears through a slide MOVE (an emptied section is removed,
2026-10-06) leaves its tiles dangling — shown and reported, not repaired.

**Deferred:** pptx import of zooms (`p14:sectionLst` sections, then
`pslz`/`psez` zoom elements) is a kernel-zone follow-up.
## 2026-10-09 — Customizing the editor: a per-install profile of recipes, not code

**Decision.** A person (or an AI on their behalf) can change how THEIR editor
looks and works — custom ribbon tabs and buttons, hidden or reordered built-in
ribbon groups, keyboard shortcuts, "My styles" (property patches applied to the
selection), presets (elements to insert), chrome colours and density, personal
default styles — through ONE versioned JSON document, the **UI profile**
(`format: 'slidomingo/ui-profile'`, `version: 1`,
`slides/src/editor/customize/`). It belongs to the install, never to a deck:
localStorage in a browser, `userData/ui-customization.json` on the desktop
(main owns it, the preload seeds it before boot, every window is told of
every change). No save path writes it; the viewer build never contains it
(`scripts/check-viewer.mjs` checks).

**Data only, and validated.** Every string in a profile is an id from a closed
catalog (`catalog.ts`: commands DERIVED from `menumodel.ts`, ribbon group ids,
CSS tokens, icons, patchable element keys, reserved chords), literal text a
person typed (rendered with `textContent`, never `t()`, never markup), or an
element value held to `untrusted.ts`'s own checks (`checkElementProp`,
`sanitizeElement`, its colour rule, `sanitizeStyleDefaults`). Token values are
hex only; the token stylesheet is generated from catalog names and validated
values (`<style data-slidomingo-transient>`). `validate.ts` is strict for
writes (any error refuses the write and lists every path to fix — what lets a
model repair its own patch) and lenient for loads (invalid parts dropped, the
rest applies). Updates are RFC 7386 merge patches.

**Why this is consistent with 2026-07-26 ("not a plugin system") and
2026-08-02 ("No extension system").** Those decline code that ships on its
own clock and bakes into FILES. A UI profile carries no code, is never in a
file, and can only name things the shell already does — each button, shortcut
and step resolves to an existing command handler or one of three fixed
operations (apply a validated patch, insert sanitized elements through the
clipboard pipeline, run a command). It is exactly the channel 2026-08-02 says
to reach for first: extension by RECIPE (a skill, `customize-ui`) at zero
shell bytes of new capability. No `eval`, no `new Function`, no raw CSS or
HTML, no URLs (2026-08-10's rule for the same reason).

**Safety.** You cannot lock yourself out: ⌘, can't be bound (`,` is not a
bindable key), menu items can't be hidden (a profile hides ribbon GROUPS
only), the Home tab keeps at least one group, the native menu still lists
every command, and built-in shortcuts always win (a secondary keydown
listener after the editor's own, plus a reserved-chord list pinned against
`wireKeyboard` by `scripts/test-ui-profile.ts`). Kill switches: the enable
toggle, Reset, `SLIDOMINGO_NO_UI_PROFILE=1` (desktop) and `?no-ui-profile`
(browser). Every write — Settings, Import, the chat, an agent — is a
revision (30 kept), so History and the "Your editor was changed — Undo"
toast can always go back.

**AI.** One tool, `ui_profile {op: get|catalog|patch|set|history|revert|reset,
dryRun?}`, with a required one-line `summary` per write. The API chat gets a
Settings ▸ Customize chat (`purpose: 'customize'`: the skill as system prompt,
`ui_profile` as its only tool, no MCP child); Claude Code gets the same tool
through the slides MCP server (main answers the verb itself — the profile is
the app's, not the deck's) and the same skill text as a project skill in each
workspace (`/customize-ui`).

**What would reopen this.** A need that a closed catalog can't express
(behaviour that is not a command, a style or an insert), third-party
distribution of profiles beyond Import/Export (that would need provenance),
or a request to carry a profile inside a document (it must not: a deck that
re-skins its reader's editor is the extension system 2026-08-02 declined).
Owner: slides + desktop zones (no kernel change).

## 2026-10-09 — Presenting modes: a start card, F / S / K in the show; Save writes the editor again, Export writes the viewer

**Why.** A deck saved from the desktop app was a viewer-only file (2026-10-07). Opened in a
browser it started the show with no click, so fullscreen was refused and it played in the tab; its
card offered only Present and Save a copy, and the speaker view was a key (S) you had to know. The
author's expectation was one file that opens for editing anywhere, plus real choices for how to
present it.

**Decided.**
- **Save is editable again.** `main.ts` no longer swaps the pristine copy for the viewer shell, so
  every desktop save / Save As splices into the built *editor* shell (the dev-window fallback to the
  built app shell stays). This supersedes "Saved files are viewer-only" (2026-10-07).
- **Export ▸ Present-only file…** (`file.presentOnly`, now in the File ▸ Export menu; still in the
  web Save ▾ list) writes the sealed hand-out. On desktop it splices into the viewer shell
  (`getViewerShell()`, `serializeDocInto`); without that bridge it is this page's own shell with
  `readonly: true`. Both boot into `playerMode`.
- **Start card** (`player.ts playerMode`) — no autostart (full screen and the speaker window both
  need a click; `#present` still starts at once). Four modes: **Full screen** (one window),
  **Presenter view** (speaker window + audience window), **In a window**, **Kiosk** (seconds +
  loop, prefilled from `doc.present.autoAdvance`/`loop`, else 10 s + loop). The last mode and the
  kiosk timing are viewer preferences in localStorage (`slidomingo-present-mode`,
  `slidomingo-present-kiosk`), never in the document. Presenter view stays the two-click flow of
  `screens.ts` (open the speaker window idle, drag it to the presenter's screen, then Start —
  opening it after fullscreen traps it in the slides' Space on macOS); the other modes close a
  speaker window left over from an earlier show.
- **In the show** (`present.ts`, editor and viewer alike): **F** swaps fullscreen and a window
  *without ending the show* (`fsToggledOut` tells `onFsChange` the exit was asked for; Esc and the
  browser's own UI still end it). **S** toggles the speaker view (open ↔ close; it also closes
  from the speaker window). **K** toggles kiosk (the deck's own timing, else 10 s, looping). Each
  flashes a one-line toast. Esc ends the show: the card in a viewer file, the editor otherwise.
  Kiosk state is session-only: `opts.kiosk` / K win over `doc.present.autoAdvance`/`loop`; a slide's
  own `advanceAfter` still wins over both. Editor: Play ▸ Kiosk (`play.kiosk`).
- Strings are in all 8 core catalogs. No format change, no new `requires`.

**Verified.** `scripts/test-present-modes-e2e.mjs` (headless Chromium from file://, viewer shell,
editor shell with a readonly doc, and both Export paths) and `scripts/test-zoom-e2e.mjs` (its
viewer part now clicks Start). Desktop e2e (`e2e-autosave.mjs`, which now expects editor files) and
a real two-display run are NOT run yet.

**What would reopen this.** Wanting desktop saves to be small again (then a per-file or app-wide
"save as viewer" switch; Export covers the hand-out case today), or a proper display picker /
"swap displays" in presenter view (the Window Management API was removed in v1.0.2).
Owner: slides + desktop zones (no kernel change).

**Follow-up, same day — the File menu.** `file.presentOnly` is now plainly **File ▸ Export**, directly
below Save: the default export is the sealed, read-only presentation file. **Export to… ▸** sits right
under it and holds the other exports (PDF, figure PDF/SVG, JSON). The web Save ▾ list shows the same
item as "Export". The command id is unchanged.

## 2026-10-09 — Customizing the editor, part 2: menus, toolbar buttons, built-in keys, sharing by parts

Extends "Customizing the editor: a per-install profile of recipes, not code" (same day). Same
rules: data only, closed catalogs, strict writes / lenient loads, never in a document.

**Decided.**
- **Menus.** `menus.context` (the right-click menu) and `menus.minibar` (the quick-format bar)
  take `add: { <scope>: [target] }` and `hide: [item id]`. Scopes are what is selected
  (`catalog.ts CONTEXT_SCOPES / MINIBAR_SCOPES`: an element type, `multi`, `canvas`, `line`,
  `text-edit`, `*`); built-in items are tagged `data-ui-item` where they are built
  (`contextmenu.ts`, `minitoolbar.ts`) and listed in `CONTEXT_ITEMS / MINIBAR_ITEMS` — the rig
  fails on an id that is no longer tagged. Pins come first in the right-click menu and last in
  the bar; a hidden item takes its now-dangling separators with it. Both menus ask the profile
  through `apply.ts MenuCustomization` (pins + hidden), nothing else.
- **Toolbar buttons.** `toolbar: { hide, order }` over ONE id space for the web top bar and the
  desktop ribbon (`TOOLBAR_ITEMS`, `data-ui-tool` in editor.ts/insertgroup.ts). Applied as CSS
  in the profile's transient `<style>` (`logic.ts toolbarCss`: `display:none`, flex `order`, a
  ribbon group whose every control is hidden goes too) — not DOM surgery, so it also covers
  buttons built later (Layout Manager insert bar, rebuild after a language switch) and the phone
  fold. Save and Settings are not in the catalog, so they can't be hidden.
- **Built-in keys.** The reserved list is split: `LOCKED_CHORDS` can never be bound (clipboard,
  undo/redo, save, select-all, the text editor's own keys, desktop-main accelerators, OS keys);
  `OVERRIDABLE_CHORDS` (open, PDF, grid, duplicate, zoom, sorter/outline, slideshow, find) can be
  rebound — a write warns `replaces-builtin` with what the key did — or switched off with the
  target `"none"`. The profile's listener for these runs in the CAPTURE phase on window (ahead of
  `wireKeyboard`) and still leaves form fields, a live text edit, presenting and the Layout
  Manager alone. The native menu shows the profile's keys (`CommandRegistry.accelFor` →
  `SerializeEnv.accel`): a taken-over built-in loses its accelerator, a command bound by the
  profile gains one.
- **Sharing by parts.** Export picks parts (`PROFILE_PARTS`: buttons, menus, toolbar, shortcuts,
  styles, presets, look, defaults); `logic.pickParts` brings along what they need (actions →
  styles/presets). Import validates strictly, then offers the file's parts and **Add to mine**
  (`mergeProfiles`: nothing of mine is lost — a clashing id with different content is renamed on
  the incoming side and every reference follows; identical content is reused, so importing twice
  adds nothing twice; a shortcut or colour both set keeps MINE and says so) or **Replace mine**.
- **Settings parity.** Everything the profile can hold can now be seen and undone in Settings ▸
  Customize without the AI: a key recorder (a read-only field, so no shortcut handler sees the
  keys) + target picker for shortcuts, pin rows and built-in checkboxes per menu, toolbar
  checkboxes, resets for button/ribbon order, Delete for command actions.
- **The skill stays ONE skill; the detail moved into the tool (progressive disclosure).**
  `ui_profile {op:"catalog"}` without a section now returns a short index; each section
  (`ribbon`, `menus`, `toolbar`, `shortcuts`, `styles`, `tokens`, `defaults`, `schema`) carries
  its ids AND a `howto` for writing that part. SKILL.md is a five-step workflow plus a
  request → section map. Why not sub-skills: one user request routinely spans areas ("put my
  callout style on ⌘⇧B and in the right-click menu"), and several skills with overlapping
  descriptions compete at trigger time; the API Customize chat has no file access, so reference
  files beside SKILL.md would not reach it, while the tool's catalog reaches both runtimes.

**Not done (would be next).** Theme-aware styles (palette refs in a patch), presets → the global
Library (2026-09-28's "one place per scope" — presets are still a third store), rebinding the
locked text-editing keys, a right-click "Hide this button / Pin here" affordance on the chrome
itself. The desktop Electron e2e (`desktop/scripts/e2e-ui-profile.mjs`) is still unverified.

## 2026-10-10 — Closing the terminal panel hides it; it no longer kills the chat
The toggle (⌘`, ribbon button, View menu) and the panel header's ✕ used to
`disposePanel`: every pty killed, the context dir deleted, and the next open
spawned a brand-new `claude` and a new chat-history entry — so open/close/open
piled up empty conversations. Now they slide the docked panel away
(`hidePanel`, `PanelState.hidden`) and back (`showPanel`); sessions, scrollback
and the view stay alive. Only a tab's own ✕, closing the window, or swapping
the deck (`replaceDocument` → `hasTerminalPanel` → dispose; the chat follows
the deck only if the panel was visible, `isTerminalPanelOpen`) end a session. A
panel with no tab left is disposed on hide. Anything that wants Claude's
attention while hidden (`slidomingo:agent-prompt`, Claude Chats…, New Chat
With…, a queued generate request) reveals it first.
The slide is animated in main (`animateReveal`, 180 ms ease-out, `layoutWindow`
per 16 ms tick). The terminal view keeps its FULL size and is only moved right
(clipped by the window): resizing it would send a pty resize per frame, and a
hidden panel parked at zero width would reflow `claude`'s TUI to ~2 columns.

## 2026-10-10 — API chat: text-only models (no screenshots)

**Problem.** `review_slide` and `render_preview` return a PNG; a text-only model behind vLLM
(e.g. GLM via LiteLLM) rejects the WHOLE request with `400 … is not a multimodal model`, so a
text-only profile failed on its first review.

**Decision.**
- **Profile flag `textOnly`** (Settings ▸ AI ▸ "Text-only model"). The provider strips every
  screenshot from the wire (`apichat/providers/images.ts withoutImages`) and appends a note to
  that tool result, so the model knows why there is no picture. The stored transcript is
  unchanged, and the panel still shows the screenshots to the user.
- **Auto-detect.** `withImageFallback` wraps both wires (outside `withOutputCap`): a 400 that
  says the model cannot take images (`isImageReject`) on a request that HAS images is retried
  once without them, and the server+model is remembered as text-only for this run of the app.
  An unflagged profile therefore works too; from its next message on it gets the full
  text-only setup.
- **Text-only setup** (session.ts): `render_preview` is hidden (its whole answer is an image),
  and the system prompt's review rule says to judge layout from `review_slide`'s element
  list/findings: margins, shared edges, equal gaps, consistent font sizes, overflow. It also
  tells the model to apply this wherever a skill says "look at the screenshot", so the skills
  themselves stay unchanged.

**Trade-off.** Editing/building/translating is unaffected (all text tools). The visual polish
pass is weaker: geometry and `check_layout` catch overlaps, overflow and misalignment, but not
taste (colour balance, an image that looks wrong).

Tests: `scripts/test-ai-profiles.ts` (reject wordings incl. the LiteLLM/vLLM one, both wires
without images, retry + memory per model, flag sanitising, session tools/prompt for flagged and
detected models). Not exercised: the Electron e2e and a real vLLM endpoint.

## 2026-10-10 — Agents read less: find_text, get_slide summary, elided old results; other models per role

**Problem.** A text-only GLM looking for "the MCP slide" called get_slide on six slides in turn
(~5k tokens each: full JSON) and reached 50k context in one request. Fixed overhead (system
prompt + 29 tools) is only ~6k; the rest was tool results. `outline` shows only 120 characters
of each slide's first text box, so there was no cheap way to search.

**Decision — reading.**
- **`find_text({query, limit?})`** (MCP + editor `findtext.ts`): case- and accent-insensitive
  plain substring over element text, table cells, chart strings, alt text, slide names and
  notes; `a|b` alternatives; no regex (a query can never be slow). One line per hit:
  slideId, index, name, elementId, snippet.
- **`get_slide({view:"summary"})`** (in the MCP server, so Claude Code benefits too): one line per
  element (id, type, role, frame, font size, full text up to 400 chars), table rows, chart
  title/series/labels, alt, notes. Default stays `"full"` (unchanged for every existing caller).
- **Elision** (`apichat/elide.ts`, API chat only): before each completion, once ≥36k characters of
  results (excluding `use_skill` and `task`) older than the last 3 tool rounds have piled up, all
  of them become a one-line stub ("call X again if you still need it"), written into the
  transcript. One batch, not a sliding window, so the prompt prefix stays byte-stable between
  batches and caching keeps working.
- Prompts (API chat, Claude Code launch line, agents.md quick reference) say: locate with
  find_text, read with the summary view, full JSON only before write_slide.

**Decision — other models (Settings ▸ AI ▸ profile ▸ Advanced, collapsed).** An API profile may
name other profiles: `subagentProfileId` (the `task` subagents run there, each with ITS model's
setup — a text-only subagent gets the text-only prompt/tools), `summaryProfileId` (compaction
summaries), `visionProfileId` + `visionModel`.
- **`look_at_slide({slideId, question?})`** is offered only to a text-only model with a vision
  profile: review_slide's screenshot + element list + the question go to the vision model,
  its text answer comes back. The vision profile is an API profile that is not text-only (e.g.
  a local VLM) or a **Claude Code profile**: `<command> -p --output-format json [--model 'm']
  --allowedTools Read` in the session folder, the prompt on stdin, the PNG as a file it reads
  (smoke-tested with claude-work + sonnet: ~3 s). The UI warns that screenshots leave for that
  model — choosing Claude for an on-prem deck is a confidentiality decision.
- Why not subagents for exploration: a subagent re-reads the same slides plus ~6k overhead,
  so total tokens go UP; it only hides the cost from the main context. Cheap reads fix the cause.

Tests: `scripts/test-ai-profiles.ts` (find_text + summary through the real MCP server with
the real search code, elision policy and loop hook, user-message images on both wires, vision
helper (API + CLI command/parse), role routing for subagents/summaries/look_at_slide, role
sanitising). Not exercised: the Electron e2e, a real vLLM/GLM endpoint, find_text inside the
running editor (its search function is the tested one; the verb case is three lines).

## 2026-10-10 — Agent op areas: the `deck` tool, declared once and generated everywhere

**Problem.** Agents could edit everything inside a slide but nothing about the deck: no tool to
add, duplicate, delete, move or hide a slide (build-deck had to ask the user for N blank
slides), none for transitions, backgrounds, notes (only via full get_slide → write_slide),
sections or document properties. One tool per verb would add ~12 tools (every request pays
for them; small local models choose worse from long lists).

**Decision.**
- **One tool per area, `{op, …}`** (the slide_type / ui_profile pattern). First area: `deck`
  with add (count, names, slideType; returns ids), duplicate, delete, move (before/after/to),
  hide, rename, transition, background, notes, section_add/rename/remove, properties, help.
  ~370 tokens for the whole tool.
- **Declared once, generated everywhere.** `slides/src/agentops/spec.ts` (import-free) holds
  each op's summary, typed params and details. From it: the MCP tool definition and per-op help
  (`desktop/src/main/agenttools.ts` fills the server's `/*@AGENT_AREAS@*/[]` placeholder when
  the app writes the server out; the server answers `help` itself), and argument checking
  before any handler (unknown params refused, like update_element). Handlers
  (`editor/agentops.ts`) are typed from the spec: a missing one does not compile. Adding an op
  touches only those two files.
- **Same code as the UI.** Slide mutations moved from editor.ts into `editor/slideops.ts`
  (insert from layout, duplicate, delete with its state/link/section/zoom cleanup, sections);
  the sidebar and the ops both call them. Moves use slideorder.ts. One op = one undo step.
- **Progressive disclosure, not dynamic tool lists.** Tool definitions sit at the head of every
  request; enabling tools mid-chat would break prompt caching and cost a turn. Instead: a short
  stable list, details behind `op:"help"`, guides behind read_reference / use_skill.
- **Guard:** `delete` refuses slides no agent added this session unless `userAsked:true`; at
  most 30 slides per add/delete/duplicate; a deck keeps one slide. Toasts tell the user.
- **Coverage stays visible:** each area's `notYet` (theme & size, presenting settings, header &
  footer, creating states/hover groups) is listed by help so a model tells the user.
- Also: `maxParallelTasks` per API profile (Advanced, 1-16, default 4); build-deck now creates
  all slides first and hands subagents their ids; doc_info lists `sections`.

Supersedes the 2026-09 note that "the MCP server has no verb to add or delete a slide".

Tests: `scripts/test-agent-ops.ts` (bundled; spec consistency, arg checks, every op on a real
Store incl. undo and refusals, end to end through the filled-in MCP server with a fake app
running the real handlers), `scripts/test-ai-profiles.ts` (the written server carries `deck`;
parallel limit), the existing slide-order/store tests, and a headless run of the UI's new /
duplicate / delete / undo paths after the move to slideops.ts. Not exercised: the Electron
e2e and a real model building a deck with it.

### Addendum (same day): every former "not yet" is an op now

- `deck` gained `state_add` (a morphing copy, optionally linked from an element), `state_sync`
  and `hover` (focus-group / reveal); a second area, **`deck_settings`**, covers theme colours
  and fonts (palette-picked colours follow via resolveThemeRefs in the same undo step; a
  stored chart palette is re-derived — the UI's accent edit left it stale), slide size (presets
  shared with the Slide panel; nothing rescaled, as in the app; the result lists slides with
  elements past the edge), slideshow settings, per-slide timing/auto-play, header & footer,
  footer text boxes on a slide type (linked slides follow), per-slide footer and numbering.
- The UI's own versions were lifted into `editor/decksettings.ts` (page presets, present
  normalising, header-footer commit, footer boxes, add/sync state, slide footer toggle) and
  panels.ts / layoutmanager.ts call them, so both surfaces write identically.
- The spec gained a `number` param type (fractions: hover dim, timings). A second area needed
  no server or desktop change — the point of the design.
- Remaining `notYet`: custom document properties, deck default text styles, embedding fonts.

## 2026-10-11 — Icon server: optional bearer token

The icon-server contract (`GET /api/search?q=`, `GET /files/{relative_path}`) gains one
OPTIONAL extra: an API token, set in Settings ▸ Icon library next to the URL and sent as
`Authorization: Bearer <token>` on every request. It lives in localStorage
(`slidomingo-icon-server-token`) like the URL: a viewer preference, never in the document.
Servers without auth are unaffected (no token = no header = the old behaviour, plain
`<img src>` thumbnails included).

With a token, thumbnails can't be `<img src>` (no header), so they are fetched and shown as
blob: URLs. If a result carries `png_url` (server-relative, with a `size` param), that is used
at size 128 for the thumbnail instead of the original. A 401/403, or a non-JSON answer (a
login page reached by redirect), now says "wants an API token" / "rejected the API token"
instead of a parse error.

Server side, for anyone pointing this at their own server: the Authorization header makes
every request preflighted, so `OPTIONS` must succeed WITHOUT auth and answer
`Access-Control-Allow-Headers: Authorization` (the `*` wildcard does not cover it), plus
`Access-Control-Allow-Origin` on the real responses. `*` is fine because the token is a
header, not a cookie.

Tested headless against a live token-protected server (a self-hosted example icon server, which has no CORS headers
yet, so the test added them in a Playwright route): no token, bad token, good token with 60
blob thumbnails, PNG and SVG insert. Not exercised: the Electron shell, and the real
preflight (Playwright's routing answers it itself).

## 2026-10-11 — API chat: Reasoning setting, live thinking, empty-turn recovery

Report: GLM-5.3 on an internal model gateway (LiteLLM) sometimes ended a turn with nothing — no text,
no tool call. Measured against the gateway: with `max_tokens: 300` it returns only a
thinking block; the real turn had spent all 50,000 tokens reasoning (a loop). Raising
"Max tokens" only lets it loop longer. What did and did not change anything on that
gateway: `reasoning_effort: "low"` cuts thinking about 5× (10–25 s instead of 54–110 s);
`thinking.budget_tokens` is at best translated into an effort level, NOT a cap;
`thinking: {type: "disabled"}` makes the model write the same reasoning as visible text;
`output_config.effort` is ignored there. So:

- **Profile field `reasoning`** (`low`|`medium`|`high`, absent = the server's default),
  Settings ▸ AI ▸ API profile ▸ Reasoning. Sent as top-level `reasoning_effort` on the
  OpenAI wire and on the Anthropic wire to any gateway; on `api.anthropic.com` it is
  `output_config.effort` (the current Claude control — `budget_tokens` is rejected on
  new models, and we send no `thinking` parameter, so no signed thinking blocks have to
  be round-tripped). A server that does not know the field answers 400; the provider
  wrapper `providers/reasoning.ts` (`withReasoningFallback`) retries once without it
  and remembers that per baseUrl + model. Like the cache_control / stream_options /
  image / output-cap fallbacks: detect the 400, remember, retry — never a per-vendor
  allow-list.
- **Thinking is shown, not stored.** Providers call `onThinking` (Anthropic
  `thinking_delta`, OpenAI-wire `reasoning_content` / `reasoning`); the loop emits
  `ChatEvent {type:'thinking'}`; the panel shows a collapsed "Thinking… ~N tokens"
  row (N = chars/4, the same estimate as `tokens.ts`; no count when the server hides
  the text, e.g. Anthropic's default `display: "omitted"`). It never enters the
  transcript. `ApiChatSession.display` keeps one `thinking` item per thought with the
  exact size and only the last 4000 characters (`THINKING_KEEP`) — enough to recognise a
  loop, not 50k tokens of it over IPC on every `chat:sync`.
- **An empty truncated turn is no longer "raise Max tokens".** `settle()` in loop.ts
  says the model used its whole output budget thinking and offers
  `ChatEvent error {retry:{effort:'low'}}` → a button → IPC `chat:retry` →
  `ApiChatSession.retry(effort)`, which re-runs the unanswered end of the transcript
  with that effort for this run only (the profile is not changed). No button when the
  profile already reasons at low. A truncated answer WITH text keeps the old
  "raise Max tokens" advice.
- **A completion with neither text nor tool calls is not stored** (loop.ts). The
  empty assistant message used to stay in the transcript and is invalid on the next
  request; it is also what makes the retry possible (the transcript ends at the
  unanswered user/tool message).
- Keep "Max tokens" as the safety cap: effort only nudges, it does not enforce a limit.

Not done: other wires' native knobs (Gemini `thinking_budget`, etc.), a reasoning
setting for the summarizer / vision helper (they use the server default), auto-retry
(it is a button on purpose — the user may prefer another model), and the thinking text
is not persisted across a restart (a resumed chat shows no thinking rows).


## 2026-10-11 — Settings is one full-screen view

- Settings was two windows: a centered 720px modal for General / Icon library /
  Document / AI, and a side dock (no scrim, editor live beside it) for
  Customize. It now has ONE layout for every category: a full-screen overlay
  (`.ed-settings-overlay`) with the category nav on the left and the pane
  beside it. Room for more categories and wider panes; nothing to relearn per
  category. Exit = the header's Close button, Esc, or ⌘, ; there is no
  click-outside (nothing outside).
- Cost, accepted: Customize no longer shows its effect on the live editor
  while it is open (changes still apply immediately and show on Close), and
  "Save style as…" / "Save as preset…" can no longer be done by clicking an
  element with Settings open — they use the selection at the time Settings
  was opened, and the pane's hint says so. If that proves awkward, give those
  two buttons their own entry point (selection context menu) rather than
  bringing the dock back.
- Esc is not taken from the shortcut recorder (`.ed-cz-chord`) or a `<dialog>`
  opened from a pane (name a style…); before, it closed Settings under them.
- Desktop: the overlay covers the titlebar, so its header is the drag region
  and keeps the 78px traffic-light gutter (none in native fullscreen).


## 2026-10-11 — Attached folders: a deck's AI chats can read folders the user picks

- A deck can have up to 8 **attached folders** (panel header ▸ folder button ▸
  "Attach a folder…"). Claude Code tabs get each as an extra `--add-dir`; API
  chat tabs get read-only `list_dir` / `read_file` / `grep_files` confined to
  them (`apichat/filetools.ts`) — an API chat has no shell, so this is its only
  way in. Both are on only while a folder is attached.
- **Never in the deck.** The list is local metadata in
  `userData/attached-folders.json` (`attachedfolders.ts`), keyed like chat
  history: docId, else bound path; it follows Save As / rename via
  `noteDeckIdentityChanged`. Absolute paths of the user's disk must not travel
  with a shared file; nothing here is serialized, spliced or sent to the doc view.
  E2E asserts the deck file and `serialize()` contain no attached path.
- **Paths come from main's native dialog only** (`terminal:add-folder`), then
  `validateFolder`: an existing directory, realpath'd, never the filesystem
  root. `terminal:remove-folder` accepts only a path already in the deck's list.
  On the launch line they travel as `SLIDOMINGO_ADD_DIR_<n>` env vars expanded
  inside double quotes, exactly like `SLIDOMINGO_DECK_DIR` — never spliced into
  the command. The folder's `CLAUDE.md` stays unloaded
  (`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is still stripped), per the
  2026-10-07 workspace decision.
- **A running `claude` cannot gain `--add-dir`s**, so each terminal tab records
  the folders it was launched with (`SessionState.extraDirs`). A change leaves
  those tabs "stale" and the Folders menu offers **Restart them**:
  `terminal:restart-stale` kills the old pty first (one transcript never has two
  writers), then relaunches under the same conversation — `--resume` if a
  transcript exists, else `--session-id` with the same id. It is explicit, never
  automatic, because it interrupts a turn in progress. API chats read the list
  live on every send; no restart.
- **File tools are read-only by construction** (no write/shell tool exists).
  Every path goes through `realpath` and must land inside a realpath'd root, so a
  symlink or `..` cannot leave a folder; files named like secrets (`.env*`, keys,
  `.netrc`…) and binaries are refused, because the text goes to a third-party
  model. Output is capped (400 lines per read, 80 grep matches, 20k files).
  The system prompt gains a short note naming the folders and telling the model
  to treat file contents as material, not instructions, and not to paste local
  paths into slides.
- Rejected: one global "always grant these folders" list (too broad: every deck
  would see every folder); auto-typing `/add-dir` into a running pty (collides
  with whatever the user is typing, session-only).
- Tests: `scripts/test-desktop-attachedfolders.ts`, `desktop/scripts/e2e-attached-folders.mjs`,
  and a file-tools scenario in `e2e-api-chat.mjs`.

## 2026-10-11 — Icon library: any number of sources; UI zoom; bigger Settings

- **Sources.** The icon library was one server OR one folder. It is now a list
  (`IconSource`: a server with URL + optional token, or a folder), each with a
  name, an on/off switch, its own Test and a remove button, in Settings ▸ Icon
  library (cards, `editor/iconsettings.ts`). The Icons popover searches every
  switched-on source at once and merges the results (source order); with more
  than one it shows a picker to narrow to a single source, and each icon's
  tooltip names its source. A source that fails is listed by name above the
  grid and never hides the others. A server without a URL is not searched.
  Stored in localStorage `slidomingo-icon-sources` (tokens too, like before:
  per-browser, never in a document); folder handles in IndexedDB keyed by
  source id. The old `slidomingo-icon-source|-server-url|-server-token` keys are
  read once and migrated (server stays server, a folder keeps its remembered
  handle as id `dir`, the other kind is kept switched off).
- **UI zoom.** ⌘/Ctrl + − 0 now zoom the WHOLE UI, not the slide canvas. The
  editor no longer handles them: a browser zooms natively, the desktop app has
  its own View ▸ Zoom items (remembered, all windows; `desktop/src/main/uizoom.ts`).
  The canvas keeps ⌘/Ctrl+wheel, pinch and the zoom bar (its tooltips no longer
  advertise ⌘±). Chosen over "Settings only" and over moving the canvas to Alt±:
  people expect the app chrome to scale like any other app, and the canvas has
  three other inputs.
- **Settings default size.** The Settings view is scaled 1.25× (`--sz`, CSS
  `zoom`; 1× on windows under 700px) on top of the UI zoom.
- Not verified: the Electron app (menu accelerators, persisted level, `dom-ready`
  re-apply) — typechecked, rigs run in headless Chromium only.

## 2026-10-11 — Agents get the icon library (`icons` tool)

AI-built decks never used the icon library: no agent tool could reach it (it
lived only in the Insert ▸ Icons popover), and `insert_elements` even said
"icons are svg elements", which invited hand-written SVG.

- One new op area, `icons` (`agentops/spec.ts`): `search {query, limit?}`
  returns refs (`i1`, `i2`, …), `insert {slideId, ref, x?, y?, size?, alt?}`
  places one. Refs live in the editor (`Editor.agentIcons`) for the session,
  so the model never handles SVG markup or URLs, and a search costs a few
  lines of context.
- The search is the popover's own code (`iconlibrary.searchIconLibrary` →
  `searchSources` over every switched-on source, same tokens, CORS/offline
  messages); a failing source becomes a note beside the others' results, an
  error only when every source failed. An insert goes through the
  `insert_elements` path (`Editor.agentInsertElements`): untrusted-fragment
  sanitizing as for a paste, layout guard, one undo step.
- A folder source is never asked for permission from an agent call (there is
  no user gesture to hang the prompt on): a forgotten grant is an error that
  tells the model to send the user to Insert ▸ Icons.
- Area handlers may now be async (`runAreaOp` returns the outcome or a
  promise of it; sync ops stay sync). The MCP server gives `icons` a 20 s
  round trip instead of 5 s (network, first folder walk).
- Guidance: the system prompt, the Claude Code launch prompt, agents.md
  ("Make a GREAT deck" row + self-audit line + verb notes) and the
  build-deck / polish-deck skills say: icons come from `icons`, never
  hand-drawn SVG; fall back to simple shapes when the library is not set up.

Not done: recolouring an inserted icon (no UI for it either); several icons
per insert call; narrowing a search to one source.
Rigs: `scripts/test-agent-ops.ts` (handlers, mocked library),
`scripts/test-agent-icons-e2e.mjs` (real editor + mock icon server).

## 2026-10-11 — Settings: a Keyboard shortcuts table, Customize in tabs, the AI chat as a sidebar

Customize "felt weird": one long scroll mixing shortcuts, menus, styles,
history and an AI chat squeezed into a box, every target picked from a
<select> of ~150 commands. Shortcuts were the hardest to find.

- **Keyboard shortcuts is its own Settings category** (`customize/keymap.ts`
  model, `customize/keymappane.ts` table), in the manner of an IDE's keymap:
  one row per menu command, per profile action and per editor key no command
  owns (`key:<chord>` rows, e.g. ⌘D Duplicate); built-in keys shown with a
  lock when they can't change (LOCKED_CHORDS, and raw keys like G a profile
  can't name). Search matches names, menu paths, ids AND keys as shown
  ("⌘G", "ctrl+g"); "Find by key" records a chord and filters to who has it;
  a filter shows only what you changed. Double-click / Enter records; a taken
  key names its owner and asks before it moves ("Assign anyway"). Removing a
  built-in key writes `"none"`; giving a command its own built-in key back
  stores nothing. It is still the same `shortcuts` map in the UI profile — no
  format change. Help ▸ Keyboard Shortcuts… (`help.keymap`) and a button in
  Shortcuts & tips open it.
- **Settings has a search** above the categories: categories, Customize's
  tabs (by keywords) and commands with their keys; a command hit opens the
  table filtered to it.
- **Customize is five tabs** (Buttons & toolbar, Menus, Styles & presets,
  Look, Backup & history), remembered per browser. Your own ribbon tabs are
  edited directly (rename, add/remove buttons, new tab) — before, only the AI
  or "Save style as…" could make one. Targets are picked in a searchable
  dialog (`customize/ui.ts pickTarget`), never a giant <select>. Built-in
  ribbon groups get show/hide checkboxes like toolbar buttons.
- **The Customize chat is a sidebar** beside Customize and Keyboard
  shortcuts (desktop), shown/hidden from the Settings header and remembered:
  bubbles, streamed markdown, a working indicator (tool calls say "Changing
  your editor…"), a card per turn listing the changes with Undo, starter
  suggestions. The chat panel's markdown renderer moved to
  `slides/src/chatmarkdown.ts` so both use the same escaping code.

Not done: editing chords for keys outside CHORD_KEY (punctuation, arrows),
reordering buttons inside your own tab by drag, a sticky table header.
Rigs: `scripts/test-ui-profile.ts` (keymap section), `scripts/test-menu-model.ts`.
## 2026-10-11 — Agents do not author SVG

An `svg` element is opaque (nobody can edit it in the editor) and markup a model
writes or recalls from the internet has no source or license. The prompts already
said "never hand-draw icon SVG", which a model can ignore; the three writes that
take element data from a model now refuse it (`editor/agentsvg.ts`, pure):

- `insert_elements` (elements and the `assets` map), `write_slide` and
  `update_element` are refused when they would put NEW svg artwork in the deck:
  an `svg` with its own `markup`, an `svg` whose `asset` key is not already in
  `doc.assets`, svg markup in the insert asset map, or an `image` whose `src`
  is a `data:image/svg+xml` URI (the same artwork in another wrapper).
- Allowed: anything native (rect/ellipse/line, `path` shapes with `d`+`pathBox`,
  text, groups), the `icons` tool (it inserts through `agentInsertElements`,
  never through these checks), pointing an svg at artwork the deck already holds,
  everything else on an existing svg (frame, alt, opacity, css), and a
  get_slide → write_slide round trip that returns existing svgs unchanged
  (same id, same markup/asset/src).
- The refusal is a tool error that ends with the way out: icons tool for icons,
  native shapes and `path` for diagrams, ask the user for pictures. Prompts,
  agents.md and the MCP tool descriptions say the same so a model rarely hits it.
- No setting: the point is a deck the user can edit. A user can still paste or
  insert SVG themselves.

Not covered: a Claude Code session that edits the deck FILE directly with its own
file tools (it is granted the deck folder) bypasses the app entirely; and
`css` on an existing svg stays writable (restyling, not new artwork).
Rigs: `scripts/test-agent-ops.ts` ("no agent svg", pure), `scripts/test-agent-icons-e2e.mjs`
(real editor: each verb refused/accepted, round trip, native path).

## 2026-10-11 — Asset provenance: record where artwork came from, and its license

An inserted icon was an anonymous `svg`/`image` element: nothing said where it
came from or what it may be used under, and the agent could pull in whatever
the enabled icon sources returned. Chosen over a licence check on the sources
alone: a deck is passed around, so the answer has to travel WITH the artwork.

- **Format**: optional `provenance {origin?, url?, author?, license?}` on
  `image` and `svg` elements (`model.ts Provenance`, via `Sourced`). Free text,
  additive, no `requires` (an older reader keeps it on save, PLATFORM
  additivity). NOT called `source`: a chart's `source` is its live table link.
  `untrusted.ts` bounds each field (300 chars, URL 2000) and drops a record with
  nothing usable; the `url` is a label, never fetched or linked. `license` is an
  SPDX id or a plain phrase ("Company-owned").
- **Who fills it**: the icon library on insert (popover and agent `icons`
  alike, one `IconResult.provenance`): the source's name, the file URL (servers
  only), and the license. A server MAY send `license`/`author` per result (the
  generic contract's optional extras); otherwise the license is what the person
  typed on the source's card (Settings ▸ Icon library ▸ "License of these
  icons", `IconSource.license`), else unknown. The panel's "Source & license"
  section edits all four fields on any picture/diagram; emptying them removes
  the record.
- **Validator**: `unlicensed-artwork` (info; a tip in the checks list) fires
  ONLY for an image/svg that has a `provenance` without a `license`. No
  provenance = nothing known = quiet (a pasted or drawn picture is the person's
  business), the same "stay quiet when unsure" rule as `missing-alt`. Slide-type
  chrome repeated across slides is one finding.
- **Agents**: `icons.search` lines end with `license: X` / `license unknown`;
  the system prompt, the Claude Code launch prompt and agents.md say never to
  download artwork from the internet themselves (licensing) — only the library.
  Nothing yet BLOCKS an unlicensed source from the agent; it can see the license
  and the user can read the tip.

Not done: a credits/attribution listing or export; restricting `icons` to
sources with a declared license; provenance on pictures that arrive by paste or
file pick (no origin to record); an editable source for generated diagrams (the
separate "store the diagram's own source, like `math.tex`" idea).
Rigs: `test-validate.ts`, `test-clipboard.ts` (paste keeps/bounds it),
`test-agent-ops.ts`, `test-icons-e2e.mjs` (server license vs source license).

## 2026-10-11 — Dragging an extra slide out of its parent un-nests it

Supersedes "a plain drop never changes `hidden`; un-nesting is the Hide
toggle" (2026-10-07 extras). A nested extra could not be dragged out: it stayed
hidden, so it re-nested under whatever slide preceded its new spot. In the
SIDEBAR the two drop zones are now symmetric: right part = make extras (hide),
left part = plain move + show again every dragged slide that was an extra
(`slideorder.ts moveSlidesOutOfExtras`, one commit; dropping in place works).
Extras carried by a dragged parent stay its extras; a hidden orphan (no slide
before it) stays hidden. Slide Sorter/Outline have no nest zone and keep the
old rule. Rig: `scripts/test-slide-order.ts`.

## 2026-10-11 — Agents edit several elements in one call and lay out by intent (`elements` tool)

A real session spent 12 calls deleting nine elements (one `delete_element`
each, after a first call failed on `elementIds`) and 25 more re-aligning the
cards that were left — and the result still "looked weird". Every element
verb took ONE element, so call count grew with the number of boxes, and the
model had to compute coordinates itself, which is what it does worst. The
layout guard ran after every single move, reacting to a half-moved grid.

- One new op area, `elements` (`agentops/spec.ts`), ops: `edit` (a batch of
  `{id, …props}` / `{id, delete:true}`, all checked before any applies),
  `delete`, `arrange` (`as` row|column|grid, `within` bounds|space|an
  element id|x,y,w,h, `cols`, `gap`, `size` fill|equal|keep), `align`,
  `distribute`, `match_size`. One call = one undo step; the guard runs ONCE.
  Decided against a code-executing tool (most flexible, but undo, splice
  safety and the guard would all depend on model-written code) and against
  just batching `set_frame` (fewer calls, same bad arithmetic).
- The geometry is `slides/src/arrange.ts` (pure, no DOM). It works on UNITS:
  a picked element plus everything inside its box, its container children
  and its groupId members, so passing a card's box (or all its parts) moves
  the whole card. Resizing keeps a card's padding (spanning members stretch,
  lower members stay bottom-anchored, the rest top-anchored), never scales
  fonts; text grows to fit through the guard. `fill` never stretches an item
  past 1.35× its own aspect. `within:"space"` = the largest empty rectangle
  inside the content margins once the items (and arrows bound to them) are
  lifted out. Small captions hugging the group (a legend under the cards:
  `companionsOf`) travel with it to the same side.
- Placing writes call the guard with the new `placed` option: every changed
  element is pinned, so nothing is reflowed around a deliberate layout; text
  still grows, arrows still follow, overlaps are still reported.
- Every `elements` result ends with a layout verdict (`✓ clean` or the
  issues with suggested frames), so the model needs no review call just to
  check. A delete that empties a big area says so ("Freed …") and names the
  one call that rebalances the rest; the launch prompt, the API system
  prompt, agents.md and the fix-comments prompt say to rebalance after
  removing content unless the space is wanted.
- Op areas forgive the usual list near-miss before checking (`normalizeArgs`:
  `elementId:"x"` for `elementIds`, `slideIds:["x"]` for `slideId`), for
  every area, `deck` included.
- The single-element verbs stay (descriptions now point at `elements` for
  several); creation (`write_slide`, `insert_elements`) is unchanged.

Not done: remembering a layout so it holds when an item is added later (a
format change); grouping (G) and containers from agents.
Rigs: `scripts/test-agent-ops.ts` (elements section: the user's slide as a
fixture), `desktop/scripts/bench-agent-tools.mjs` (real `claude -p` sessions,
call counts before/after).

## 2026-10-11 — Comments: one status, one way to Claude, the sent list is visible

The comment UI had three overlapping flags in view (`resolved`, `forAgent`,
`agentDone`), three ways to reopen, and five ways to involve Claude (`@ai`
prefix, Ask Claude chip, Flag menu item, Fix now strip, Send). Done threads
stayed on the canvas as faint dots. And Send typed a generic instruction into
the chat, so the user could not see what had been sent.

- A thread shows ONE status: open → to check (`agentDone`) → done
  (`resolved`). Done threads are hidden on the canvas; the comments pill's
  "N resolved" toggle shows them (per window, not saved). The header ✓ only
  resolves an open thread; banners do Accept / Reopen; a reply still reopens.
- Claude is reached only through `sendCommentsToClaude` (pill, ribbon, menu,
  and a thread's own "Send to Claude"). `forAgent` now means "sent, not
  finished" and is set only there. The chip, the `@ai`/`/ai` prefix, the
  Flag/Unflag item, "Fix now" and the hidden right-click Send menu on the 💬
  tool are gone. The format is unchanged (all three fields still read and
  written; old files with `forAgent` from the prefix behave as "sent").
- Send passes the comments themselves (`SentComment[]`: id, slide number,
  anchor label, text, feedback after Claude's last reply) to main.
  `desktop/src/main/agentprompts.ts fixCommentsPrompt` builds a numbered
  list plus instructions: fix a few / one-or-two-slide batches alone; spread,
  independent batches with one subagent per slide (or group) in parallel,
  deck-wide changes first by the main session. Claude decides from the list.
- That message is built from document text, so main sanitizes every field
  (control bytes and line separators → space, ' ` → ’, \ → /, $ → ＄, bounded
  lengths, ≤ 40 listed, ids/slide numbers validated): it cannot end a
  bracketed paste or break the single-quoted `initialTask`. A live Claude Code
  pty gets it as ONE bracketed paste, then Enter 150 ms later — checked
  against claude 2.1.296: the input shows "[Pasted text #1 +N lines]" until
  submit, the transcript then shows the full list.

Rigs: `node scripts/test-desktop-agentprompts.ts`; the comments steps in
`desktop/scripts/e2e-agent-prompt.mjs` (which now also sends its review_slide
probe to every session dir — it picked a dead session dir by readdir order
whenever the pre-panel polish call had started a second session).

## 2026-10-11 — Convert an svg to objects

An `svg` element is opaque; the project's philosophy is native objects. Rather
than an SVG editor, a one-way conversion (`svgconvert.ts`, `editor/svgtoobjects.ts`):
right-click ▸ Convert to objects, or the button at the top of a diagram's panel.
One undo step, in place in the stacking order, the pieces selected and sharing a
`groupId`. Deterministic code, not AI: geometry is exactly what the browser draws.

- **No second SVG interpreter.** The diagram is rendered through `renderElement`
  (same sanitizer, scoped CSS and flips as the canvas) into an invisible host at
  1:1, and each node is read off the live DOM: `getScreenCTM()` gives node →
  pixels in the element's box (nested transforms, viewBox letterboxing and the
  element's own flip included), `getComputedStyle` resolves fill/stroke/opacity
  through classes, `<style>`, inheritance and currentColor. The element's own
  position and rotation are composed on afterwards.
- **Mapping**: axis-aligned `rect`/`circle`/`ellipse` → `rect`/`ellipse` shapes
  (stroke inset and corner radius adjusted to the shape renderer's convention);
  every other geometry (path, line, polyline, polygon, rotated/skewed or
  unequal-radius primitives) → one `path` shape per SVG element, as absolute
  M/L/C/Z (`svgpath.ts` resolves Q T S A H V and relative forms, so the path
  editors understand it). Text → one text element per `<text>` (tspans that
  restart at x/y/dy are lines; one style). Linear gradients → `fillGradient`.
  A compound path stays ONE element so holes stay holes; node-editing it mangles
  the subpaths (the editors' documented single-subpath limit).
- **Format additions** (additive, no `requires`; an older reader keeps them and
  draws the unconverted look): `fillRule: 'evenodd'` and `strokeJoin` on path
  shapes, `strokeCap` now also honoured on paths, `provenance` (the 2026-10-11
  asset-provenance field) allowed on shapes. Outline icons are all round caps and
  joins, and evenodd is how holes are commonly drawn, so without these the
  commonest icons would convert wrongly.
- **Provenance**: the diagram's `provenance` moves to the first converted shape
  (the validator now judges `unlicensed-artwork` on shapes too), so a license
  does not vanish by converting.
- **Said, not dropped**: filters, masks, clip paths, markers, patterns, `<image>`,
  `<use>`, radial gradients and gradient strokes (flattened to one colour),
  the svg's own css animations/hover, shadow/blur/fx, mixed text styles, and
  custom dash patterns (the model has dashed/dotted presets only), parts that stuck out past the svg's frame (an `<svg>` clips to its box, objects
  cannot) are listed in the toast ("Not carried over: …", English). Stroke under
  a NON-uniform scale becomes uniform (√|det|). A diagram over `MAX_PIECES`
  (300) or with nothing drawable is refused with the reason.
- The svg asset is left in `doc.assets`; Clean up removes it once unused.

Not done: an agent op (so the model can convert a user's diagram on request),
several selected diagrams at once, per-`<g>` sub-groups, `<use>`/symbol
expansion, text on a path, radial gradients (the model has linear only).
Rigs: `scripts/test-svg-path.ts` (pure geometry), `scripts/test-svg-convert-e2e.mjs`
(real editor: before/after screenshots compared pixel by pixel for primitives,
paths with arcs and an even-odd donut, classes/currentColor/opacity/gradients,
a letterboxed rotated flipped frame, nested/skewed transforms, an outline icon,
text; plus the model, the toast, undo, provenance, the right-click item).

## 2026-10-11 — Icon-server tokens are stored like the AI keys (desktop)

An icon server's API token sat in plain text in renderer localStorage
(`slidomingo-icon-sources`). In the desktop app that storage is per deck (one
partition per path), so a token typed in one deck was missing in every other
deck and in every new draft: it looked lost. Chosen over "main owns the list
and seeds it into each window": seeding would copy the token back into every
deck's partition in clear, so encrypting it in main would protect nothing.

- **The list** (`slidomingo-icon-sources`) is an app-wide viewer preference
  (`viewerprefs.ts VIEWER_PREF_KEYS`), like the theme. It is in
  `ADOPT_IF_MISSING`: on an install whose shared prefs predate it, the
  preload hands the window's own value to main instead of wiping it.
- **The token** never enters a desktop page. Main keeps it in
  `userData/icon-tokens.bin`, encrypted with safeStorage
  (`desktop/src/main/icontokens.ts`, the same scheme as `ai-keys.bin`),
  write-only: the renderer only ever learns "stored for this URL: yes/no"
  (`iconTokenStatus`). Settings ▸ Icon library shows "A token is stored —
  type to replace it" and "Remove stored token", as the AI-key field does.
- **Main makes every icon-server request** (`slidomingo:icon-fetch`,
  `iconlibrary.ts serverFetch`). It adds `Authorization` only to URLs under the
  root the token was STORED FOR (origin + path; `icontokenscore.ts`), refuses
  URLs outside the source's root, follows redirects by hand without the header
  when they leave the root, honours offline mode, and caps responses at 25 MB.
  A changed URL means typing the token again — whatever can write the list
  cannot redirect the token. Side effect: no CORS needed for the desktop app.
- **Never a token in the stored list**: `viewerprefs.ts` passes the value
  through `sanitizeIconSourcesPref` (moves an inline token into the store
  unless one is there already, drops tokens of removed sources) and echoes the
  cleaned value to the sender. An older build's inline token migrates that way,
  and through `iconSources()` → `setIconSources` → `adoptIconTokens`.
- **Browser**: unchanged — the token stays a localStorage viewer preference
  (there is nowhere safer to keep it in a page), sent by the page's own fetch.
- `thumbUrl` now ignores a `png_url` outside the server's own root, so a
  server can't point the token at another host (browser and desktop).

Rigs: `node scripts/test-icon-tokens.ts` (pure),
`node --experimental-test-module-mocks scripts/test-icon-tokens-main.ts` (main's
IPC for real, Electron mocked, live mock servers),
`scripts/test-icon-tokens-renderer-e2e.mjs` (the editor's desktop path, stub
bridge), `desktop/scripts/e2e-icon-tokens.mjs` (real Electron; not yet run —
hidden test windows do not boot while someone uses the machine).

---

## 2026-10-12 — A document has a language; templates carry translated terms

A template should serve more than one language without a copy per language:
its chrome says "Page 3 of 12" in one deck and "Seite 3 von 12" in the next.

- **`doc.meta.language`** (BCP-47) is the language the DOCUMENT is written
  in. It is not the UI language, which stays the viewer's (PLATFORM §8) —
  same split as the Spaces starter (2026-08-22): the interface follows the
  reader, a document is written in a language. Because it is the document's,
  `{{date}}`/`{{time}}` format in it for every reader. Absent = the first
  language of the terms table, and with no table dates follow the viewer
  (the behaviour before this). A code `Intl` rejects falls back to the
  viewer's locale, never throws.
- **`doc.terms = {languages, entries: [{name, text: {lang: string}}]}`**, a
  table rather than per-text-box variants. Chosen over storing one `html` per
  language on each text element: slides COPY layout elements, so every copy
  would carry every variant, and an edit on a slide vs. in the slide type
  would have to pick a variant to land in. A term is a field like
  `{{prop:Name}}`; it resolves at render time in `resolveFields`, so nothing
  in the slides changes when the language does.
- **`{{term:Name}}`** shows the entry in the document language, else the
  table's first language, else the name — a missing translation reads as the
  word it stands for, never as a blank. Unlike a custom property (where a
  rename orphans text), renaming a term rewrites every `{{term:old}}` in
  slides, slide types and objects (`model.renameTermRefs`) in the same commit.
- **Templates**: `terms` is part of the DESIGN layer (`DESIGN_FIELDS`), so
  "Update template" takes the deck's table; "Update deck from template"
  merges (template entries win by name, the deck's own extras stay,
  `mergeTerms`). `meta.language` is NOT design: a deck keeps its language.
- **No `requires`**: an older reader shows the raw `{{term:Page}}` and keeps
  the field on save (unknown fields are preserved). Ugly, not lossy — the
  same trade `{{prop:…}}` made.

- **The table belongs to the TEMPLATE** (revised the same day, user's call:
  "it should translate in the template only"). It is edited only where
  `doc.template` is set (the desktop template window); a deck shows it
  read-only and picks a language — offered: exactly the table's languages,
  or any language when there is no table (then it only formats dates).
  Terms are offered by Insert field only on a slide type, and "Make
  translatable" (a slide type's text, template only: the selected words,
  or the whole plain text, become a term via `model.ensureTerm`) is the way
  in, so translation stays template chrome and never reaches content typed
  on slides. A deck cannot override a word; revisit if someone asks.
- **Preview**: the Layout Manager head has an EN | DE switch
  (`store.termPreview`, editor-only, cleared on exit) passed as
  `RenderOpts.language` to its canvas and type thumbnails. On a slide type a
  term shows its WORD, not ‹name› like other fields: the point of the
  preview is seeing that "Seite 12 von 140" still fits.

Editor: `editor/doclanguage.ts` (Document properties + the preview
switch), panels.ts `buildMakeTranslatable`, agent `deck properties` takes
`language`. Rig: `scripts/test-doc-language.ts`.

## 2026-10-12 — Align to slide: a visible switch, block semantics, ⌥⇧ keys

PowerPoint's Align to Slide / Align Selected Objects is a hidden mode at the
bottom of a submenu; ours is a visible *Align to: Selection | Slide* switch in
the Arrange panel (same state as Arrange ▸ Relative to slide, the ribbon's
To slide button and ⌥⇧S; editor-session state on `PropsPanel.alignRef`, never
in the doc). One object always uses the slide. Deliberate differences from
PowerPoint, both because the PowerPoint result is almost never wanted:
- **Against the slide the selection moves as a BLOCK** (layout kept).
  PowerPoint aligns each object to the slide, stacking them; align to each
  other first, then to the slide, gives that result.
- **Distribute across the slide = equal space before, between and after**
  (PowerPoint puts the outer two flush on the slide edges).
Groups (`groupId`) are one unit in align/distribute; a container's selected
child is left to its container. Geometry: `slides/src/alignment.ts` (rig
`scripts/test-alignment.ts`) — separate from `arrange.ts`, the agents'
planners. Keys: ⌥⇧ + letter by `ev.code`, the same family as ⌥⇧T Tidy:
L/C/R, U(p)/M/B, H/V distribute, E center, S toggle. `Mod+Alt+Shift+C` was
out (every Mod+…+C is a locked clipboard chord), and `chordFromEvent` only
knows letters/digits/F-keys, so no arrows. The accelerators live in
`menumodel.ts`; `ALIGN_KEYS` is derived from them for `wireKeyboard`, and
the chords are `OVERRIDABLE_CHORDS` so a profile can rebind them.
Stream Deck: Hotkey buttons sending these chords — no plugin (yet).

## 2026-10-12 — Top = everyday format bar, side = detail; group formatting; panel order

The split, settled with the user: the TOP carries a short, one-row bar of
the most-used, compact formatting for the selection; the SIDE panel carries
everything detailed, numeric or rare. Every setting keeps its full home on
the side; the top bar is a shortcut, never the only place.
- **The top bar is the quick-format bar, docked** — one `MiniToolbar` class,
  two instances (`docked: true` for the top). Same controls, same ids, same
  Customize pins/hidden items, so "customize once" holds wherever it shows.
  Docked = pinned top-centre over the canvas's dotted surround (not in the
  ribbon: works in the browser too, rides the Layout Manager reparent, and
  stays visible whatever ribbon tab is open). The scroller starts below it
  (`--quickbar-h`, measured by a ResizeObserver), so it never covers the
  slide. It shows a chip naming what it acts on and, with nothing it can
  format, a calm hint — it never jumps around.
- **Placement** (`top` | `floating` | `both` | `off`) is `toolbar.quickbar` in
  the UI profile — exported with the Toolbar part, reset with the rest. No
  profile value = the old `slidomingo-minitoolbar` preference: `off` stays
  off, an explicit `on` = floating, unset = **top** (the new default).
- **Group formatting**: `ElementEdits` setters take one id or many (`Ids`),
  several = ONE edit/undo step; `setRef` takes several palette refs. The
  multi-selection panel (`buildMultiStyle`) shows what the selected objects
  share: Fill & stroke (shapes), Text (text/code/math), Effects (all). A
  value that differs shows "Mixed" INSIDE the control (striped swatch,
  placeholder, first option) — a separate tag pushed controls onto a second
  line. A solid fill/colour pick replaces a gradient (that is what "make them
  all blue" means). A+/A− step each object's own size (`setFontSizesBy`).
  A group is just a multi-selection of its members, so it gets the same.
- **Side-panel order**: `panel.order` (new profile part `panel`), ids from
  `catalog.PANEL_SECTIONS` per scope (one object / several / slide); an
  object's own sections (Typography, Data…) move together as `type`. The
  fixed header always stays first. `panels.orderSections` re-sorts after
  `applyAccordion`. Customize ▸ Menus has the placement cards and one
  sortable list per scope (`logic.movePanelSection` writes the full order).
Not done: hiding panel sections (a hidden section hides settings with no
other home — revisit with care), and a contextual ribbon tab.
Same day, round 2 (UX review): the multi bar's align/distribute moved into
one Arrange ▾ popover (items keep their catalog ids — `item('<id>')`, which
the rig accepts — so a profile hiding `distribute` still hides it there);
the idle docked bar shows slide actions via menu commands (`runCommand`);
the panel's Arrange section folds Distribute mode/gap, Size to, Tidy, Flip
and containers under "More arrange options" (open state per session); the
web top bar's insert group got cluster dividers (`.ed-tb-sep`, hidden in
phone menus). Swatches paint their colour as the TOP background layer
(`--swatch`) — as background-color it sat UNDER the checkerboard image.

## 2026-10-12 — Relicensed from MIT to AGPL-3.0-or-later, with a document exception

Supersedes the "Licence: the runtime stays MIT … Never relicense slides" line
in the 2026-07-27 vault entry. The maintainer wants Slidomingo free for
everyone, companies included, but not available as the base of a closed
commercial product. A non-commercial licence (PolyForm NC, CC BY-NC) was
rejected: "commercial" would forbid an employee from making a deck at work,
and with the notice in every saved file it would cloud whether a company may
even open a deck it was sent.

- **Licence**: `AGPL-3.0-or-later` (`LICENSE` is the verbatim GNU text). Every
  `SPDX-License-Identifier` header and `package.json` `license` field says so.
  The maintainers also offer commercial licences (dual licensing), which is
  why `CONTRIBUTING.md` asks contributors for a licence grant to the
  maintainers plus a DCO sign-off. Do not merge an outside contribution
  without one.
- **The old objection, and its fix.** The vault entry kept MIT because the
  runtime is embedded in every saved document, so copyleft on the runtime
  would follow every deck a user emails. `LICENSING.md` adds an AGPL §7
  additional permission instead: (1) the user's content is not covered by
  the AGPL just because it sits in the same file as the runtime; (2) a
  document with an unmodified official runtime may be shared without §6
  obligations, as long as the embedded `NOTICE` (which points to the source)
  is kept. The `NOTICE` comment in `slides/index.html` states both in short.
  Any new app shell (spaces, dash) must carry the same NOTICE wording.
- **Bento.** About a third of the code still traces back to the initial
  import from `nyblnet/bento` (MIT, "The Bento authors"). The 2026-09-02
  rebrand had replaced that copyright line with "The Slidomingo authors",
  which MIT does not allow for code we didn't write; the Bento notice is
  restored in `LICENSING.md`, `THIRD_PARTY_NOTICES.md` and the embedded
  `NOTICE`. Keep it there as long as any Bento-derived code ships.
- **Earlier releases** stay MIT; that cannot be revoked and `LICENSING.md`
  says so.
- **Vault** still chooses its own licence at its first commit.

## 2026-10-13 — Grid & Snap: one panel, you snap to what you see, columns in the document

The old grid was a px-only dropdown (10/20/40/80) that hard-snapped an
element's TOP-LEFT corner and overrode every other snap; nothing else about
snapping could be chosen. Replaced by:

- **One panel** (`editor/gridsnap.ts`; View ▸ Grid & Snap…, the ribbon's
  Grid & Snap button, the web View menu): a Show × Snap matrix over every
  target — grid, layout columns, guides, margins (the safe zone), other
  objects (edges, centers, equal gaps), the slide's edges/center — then the
  details of what you define. ⌘G still toggles the grid; View also has
  Columns and Guides check items.
- **Rule: you snap to what you see — except the template's borders.** Grid,
  column lines and guides snap only while shown AND ticked (a hidden
  target's Snap box is disabled): the grid snaps firmly, and guides are
  hidden to get them out of the way. The BORDERS — the safe-zone sides and
  the column grid's outer margins (the Margins row) — snap whenever ticked,
  shown or not: they are the layout's rule, and Moveable draws the line it
  caught, so a snap to a hidden border still explains itself (the user's
  call). Objects and the slide are always available. Snap distance is 6 SCREEN px
  at any zoom (Moveable measures in slide px, so `relayout` sets
  `snapThreshold = 6 / scale`).
- **Priority: magnetic beats the grid.** Moveable does the magnetic snapping
  (guides/columns/margins go in as `vertical/horizontalGuidelines`, objects
  and the slide as `elementGuidelines`). The drag handler compares Moveable's
  position with where the pointer alone would put the frame
  (`snapping.axisCaught`); only on an axis nothing caught does the grid
  apply, FIRMLY, to whichever of the box's start/center/end is nearest
  (`gridSnapSpan`). Groups snap their union box. ⌥ pressed during a drag =
  free placement (⌥ before the press stays deep-select). Points (drawing,
  line/curve handles) use `snapPoint`: nearest line in reach, else the grid.
- **Units and steps.** The grid is any value in px/pt/mm/cm/in (model stays
  px, 96 dpi; figures use their own unit). Presets are the steps that divide
  the page exactly (`fittingSteps` = divisors of gcd(w, h); 1280×720 →
  5…80), so no sliver at the edge.
- **Where it lives.** The grid, the Show/Snap ticks and the unit are a VIEWER
  preference (`slidomingo-grid`, gridpref.ts, extended compatibly). The
  column grid (`doc.layoutGrid {columns, rows?, gutter, marginX, marginY}`)
  and guides (`doc.guides {x?, y?}`) are DOCUMENT data, deck-wide, px in the
  `size` space: a layout grid is a design decision that must travel with the
  deck or layout, and agents need it. Additive, no `requires` (an older
  reader keeps unknown fields; losing them would only drop helpers, not
  content). Read them ONLY through `layoutgrid.normalizeLayoutGrid` /
  `normalizeGuides`. Every edit is one undo step.
- **Guides without rulers.** Drag one out of the thin strip just outside the
  slide's top/left edge; drag to move (it snaps like an edge, and to the
  slide center); drag off the slide to remove. Panel: + Vertical,
  + Horizontal, Around selection, Clear.
- **Agents place by columns.** `deck_settings {op:"layout_grid"}` sets it
  (unset values kept, `columns:0` removes); `doc_info.layoutGrid` lists every
  column's x/w; `elements arrange` takes `within: "columns 7-12"` (optionally
  `rows 2-3`) = `layoutgrid.spanRect`.
- Not done: the safe-zone margin (`validate.marginFor`, the "past-margin"
  check) is still its own 96 px rule, not the layout grid's margins — a deck
  can now have two margin notions. Unifying them changes Check slides and
  the layout guard, so it was left for a decision of its own. Per-slide-type
  grids/guides are not supported (deck-wide only).

Verified: `scripts/test-grid-snap.ts` (pure), `scripts/test-agent-ops.ts`
(layout_grid, arrange within columns), and real-mouse playwright runs
against a dev server (grid edge/center snap, guide beats grid, columns,
⌥ free, zoom-constant reach, group union box, guide move/remove/create,
panel controls, ⌘G sync). The Electron ribbon and native View menu items
were not exercised.

## 2026-10-13 — No Bento branding; Bento credited as the code it is

Owner's call before going public: Slidomingo does not present itself as Bento
anywhere, but says plainly that it uses Bento's code. Measured against
`nyblnet/bento` at the fork (2026-09-01), 27.5% of substantive source lines
are still identical — model, renderer, present mode, editor, save, charts —
so the MIT notice stays (LICENSING.md, THIRD_PARTY_NOTICES.md, the embedded
NOTICE), and a rewrite was rejected: reworked code stays derived, and only a
clean-room rewrite would lift the obligation.

This resolves the items the 2026-09-02 rename "left alone, deliberately":
- The orphaned "Visit bento.page" / "Full guide at bento.page/help" strings
  are deleted from all catalogs (no source referenced them).
- `docs/RELEASING.md` is rewritten for what exists: tag, build, attach the
  shell to a GitHub release. `scripts/release.mjs` (Bento's site pipeline)
  is documented as not usable — it calls four generators that are not in
  this repo — and writes a `CNAME` only from `SLIDOMINGO_SITE_DOMAIN`, never
  `bento.page`.
- `docs/pr-build-size-design.md` is deleted: it described Bento's CI
  workflows, which this repo does not have.
- `CHANGELOG.md` keeps Slidomingo's own history; everything before the fork
  is replaced by one `[1.0.18]` section pointing to Bento's changelog
  (version numbers continue from 1.0.18).
- README has an Acknowledgements section naming Bento and the parts used.

Comments that named `bento.page` as "the hosted site" now say that. Entries
in this log that mention Bento are history and stay as written.

## 2026-10-13 — Bento's release and sharing leftovers removed

Owner's call: everything inherited from Bento for releasing and sharing that
this repo no longer uses goes, rather than waiting for a decision on a web
site. What was removed:
- `scripts/release.mjs`, `scripts/apps.mjs`, `scripts/test-release-apps.mjs`,
  `scripts/test-publish-gate.mjs` — Bento's static-site + signed-manifest
  pipeline. It called generators that were never in this repo, so it could
  not run. Releasing is now just tag + build + GitHub release
  (`docs/RELEASING.md`). If Slidomingo gets a web site, build its pipeline
  fresh.
- `.gitignore` rules for that infrastructure (site/, wrangler, guestbook and
  release keys, iOS/Android host apps).
- `kernel/src/save.ts` `writeBackupBeside` and the `backup` save purpose —
  the rollback copy the deleted self-update left behind. `hostCan` stays
  (`hostCan('write')` is live).
- ~300 lines of CSS for UI whose code was already gone: the live-collaboration
  Share popover, presence avatars, remote cursors, read-only live viewer,
  the update button/About update block, and the language-pack manager.
- 129 translation keys per locale for the same features (self-update, live
  collaboration and invites, language-pack downloads). Other unreferenced
  keys (≈110, mostly old master/layout and customize wording) were left for a
  separate pass.

Kept on purpose: the old-updater splice contract and `scripts/shell-gate.mjs`
(they protect files already in the world, and the viewer build runs the
gate), `returngate` (any web origin), and the `collab` field handling in
autosave (old documents may carry it). Comments elsewhere that mention live
collaboration as design history were not rewritten.

## 2026-10-13 — AI-assisted contributions allowed; Bento's leftover rules and checks go

- `AGENTS.md` rules 7 and 9 and the matching `CONTRIBUTING.md` line came with
  the Bento import ("no AI co-author trailers", "AI contributions are not
  merged") and contradicted how this repo is built. Now: a person authors
  every commit and may name the AI tool in a `Co-Authored-By:` trailer; PRs
  may be AI-assisted if a person reviewed and takes responsibility for every
  line; autonomous bot PRs are still not merged.
- `scripts/test-ci-registered.ts` is deleted. It checked that every rig is
  listed in `.github/workflows/ci.yml`, a file this repo has never had, so it
  could only fail. If CI is added, write the workflow first and bring the
  check back with it.
- 100 more unreferenced translation keys per locale are deleted — strings
  whose source wording changed or whose UI is gone. Eleven near-matches
  whose source wording only partly matched were kept rather than guessed.
- Rigs that import extensionless modules (`test-sanitize.ts` and others) must
  be bundled with esbuild as their headers say; run directly, they fail with
  ERR_MODULE_NOT_FOUND, which is not a bug.

## 2026-10-13 — Decision log scrubbed for publication

Before publishing the repository, employer, internal-service, personal and
local-path specifics were replaced by neutral wording across this log and
`CHANGELOG.md` (e.g. "a corporate template", "a self-hosted model gateway",
"a self-hosted icon server"). Technical content, measurements and dates are
unchanged. Future entries should describe test material and infrastructure
generically rather than naming organisations, internal services or people.

## 2026-10-13 — Publication fixes; the public repo starts without history

- **Fresh history.** Slidomingo is published as a NEW repository whose first
  commit is the then-current tree, not by pushing this repo's history. This
  repo's history (work email, internal details, large superseded assets) stays
  private. So rewriting old commits is not needed; only the tree must be clean.
- **README link targets are real.** `SECURITY.md` asks for reports through
  GitHub's private vulnerability reporting (a setting that can only be turned
  on once the repo is public). Discussions are on, with the default Q&A /
  Ideas / Show and tell categories the README links. The "pinned What's in
  flight issue" was dropped from README and CONTRIBUTING.
- **README claims corrected.** The shell is ~1.3 MB, not ~560 KB. The app
  reaches the network for a document's own remote media AND for icon servers
  the user adds; the desktop AI chat calls only the configured provider.
- **No employer specifics in the tree.** Code comments and tests use neutral
  examples ("Acme Corporate", "a self-hosted gateway"). The real-template
  case in `test-templates.ts` runs only when `SLIDOMINGO_REAL_TEMPLATE` points
  at a file.
- **`test-offline.ts` exempts main-process proxies by name.**
  `desktop/src/main/icontokens.ts` fetches on the page's behalf so the token
  never enters the page; the page checks offline mode first and main checks
  it again. The rig asserts both still hold for every exempt file.
- `THIRD_PARTY_NOTICES.md` lists the desktop app's runtime libraries;
  `desktop/spike/` and the unused `qrcode` dev dependency are removed; the MCP
  server's `ui_profile` tool now advertises the `panel` section like
  `uiprofiletool.ts` does.

## 2026-10-13 — BeeSlides is the only visible name (supersedes the 2026-09-28 wording rule)

Owner's call: everything a person reads says **BeeSlides** — UI strings in all
locales (keys and translations renamed together), docs, the copyright line
("The BeeSlides authors"), the built files (`BeeSlides.slidomingo.html`,
`BeeSlides_Viewer.slidomingo.html`, `BeeSlides-Starter-Library.slidomingo.html`),
the logo file and the GitHub repo (`miqsoft/beeslides`). "Slidomingo" as a
suite/platform name is retired from prose.

Internal identifiers keep `slidomingo`, because saved files and existing
installs depend on them: the `slidomingo/slides` format string,
`#slidomingo-doc`, the `.slidomingo.html` extension, `window.slidomingo`,
storage/IPC/CSS prefixes, appId, TypeScript names such as `SlidomingoDoc`,
package names, and on-disk locations — `~/Documents/Slidomingo Templates`,
`Slidomingo Library.slidomingo.html` and the pinned desktop userData folder.
Renaming any of those needs a migration, not a find-and-replace. History
entries in this log were not rewritten.

## 2026-10-13 — One Grid control; the slide type is a row, not a section

Owner asked for simpler controls after Grid & Snap shipped.

- **Ribbon (View ▸ Guides & Checks): `[ Grid |▾]`** (`editor.gridSplitButton`).
  The left half toggles the grid (⌘G) and stays armed while it is on; the
  caret opens the Grid & Snap panel. The separate "Grid & Snap" and "Margin
  guides" ribbon buttons are gone — margins are the panel's Margins row.
  Menus keep both items (View ▸ Grid ✓ / Grid & Snap… / Margin guides ✓):
  a checkable item plus a panel entry is the normal menu shape.
- **Slide panel: "Slide type" is the FIRST row of the Slide section**
  (`panels.buildSlideTypeRow`), no longer a section of five stacked buttons
  at the bottom. The control shows the type's name (or None) and opens the
  picker; ⋯ holds Edit this slide type (Layout Manager opened on that type —
  `OpenLayoutManagerDetail.layoutId`), Save as slide type…, Unlink (keep
  look), Layout Manager…. The format bar's button names the type too. The
  `'Slide type'` panel-section id is retired: saved UI profiles that list it
  still load and validate (`RETIRED_PANEL_SECTIONS`).
- **Picker**: the current type is outlined, and a clean fit reads "fits"
  instead of a ✓ that looked like "current".
- **Save as slide type… asks in an in-page dialog** (`askText` with
  `singleLine`), from every entry point (`panel.promptSaveSlideAsLayout`).
  It used `window.prompt`, which does nothing in Electron.

## 2026-10-13 — PowerPoint import: static first, then "Fix with Claude"

Owner's call: a .pptx import is fixed by code first, and AI only gets what
code cannot settle — never the whole deck.

- **Static pass on every .pptx import** (`slides/src/importrepair.ts
  settleImportedText`, run by `editor/importfix.ts settleImport` after File ▸
  Import, the start page and a seeded import draft). Every imported text box
  is re-measured through the real renderer. Overflow is fixed the way
  PowerPoint would: grow the box along its valign anchor (its welded
  box-with-text shape too) when that covers nothing new and stays on the
  slide, else shrink the type to the largest size that fits, never below
  `MIN_SHRINK` (0.8; run sizes in the html scale along). A slot the slide
  type owns (linked slide) or a box neither fix suits is left untouched and
  reported. One undo step, none when nothing changed (dry run on a copy);
  ⌘Z undoes the fit, a second ⌘Z the import. This is what the converter's
  `text-needs-refit` hint ("the host must re-measure") always asked for.
- **"✦ Fix N with Claude"** on the import report, desktop only (no bridge =
  no button; the report then lists the leftovers for the user). It sends
  `repairItems`: only report codes in `REPAIRABLE` — placeholders the source
  can rebuild (SmartArt, unsupported charts, unreadable tables), visible
  chart/table/shape/background losses, flattened run formatting — plus the
  static leftovers, each with deck position and slide id (`s<n>` = source
  slide n). Codes for what the FORMAT cannot express (paragraph spacing,
  custom bullet glyphs, numbering styles, text columns, per-cell table
  borders) and what nothing can restore (missing picture parts, substituted
  fonts, transitions) are never sent: they would only produce "cannot fix".
- **Main** (`terminalPanel.ts`, `slidomingo:fix-import`) copies the picked
  file to `<contextDir>/import/source.pptx`, renders it to `source.pdf` when
  LibreOffice is installed (`sourcerender.ts`: throwaway profile, hidden
  slides exported so page N = slide sN, 90 s cap, null on any failure — no
  PowerPoint scripting: macOS permission prompt + sandboxed output), and
  types `agentprompts.ts fixImportPrompt` into the window's session
  (`deliverPrompt`, shared with Send comments). The prompt: faithful copy not
  a redesign, change only the listed items, no new motion, native elements
  over pictures, subagents per slide when the items spread, verify with
  review_slide against the PDF page.
- **Converter**: text findings now carry their slide (`TextDeps.where`), so
  `run-formatting-flattened` & co. can be routed to a slide like every other
  finding. Additive to the report only; every convert rig unchanged.
- **Measured on 25 real decks**: the static pass fitted 3–29 text boxes per
  deck with no leftovers on the ones tried in the browser; the AI list is
  0–50 items, dominated by `run-formatting-flattened`. The format CAN carry
  per-run size/colour (rich-text spans) and flips (`flipH`/`flipV`), so the
  next static step is the converter emitting those itself, which would empty
  most of the AI list.

## 2026-10-13 — Import onto an existing layout: automatic when provably the same design, restyle only on request

Owner's call, asked to decide: "should the user decide, or do we reuse an
existing layout — and what if it isn't compatible?"

- **No question by default.** After a .pptx import (desktop), the deck is
  compared with every layout in the layouts folder (`slides/src/importlayout.ts
  matchDesign`, ≤ 40 files). When one is the same design, the deck moves onto
  it at once (`rebaseOnLayout`, ONE undo step, before the text fit) and the
  report says so with **Keep the file's own design** as the way back. Asking
  on every import is noise; the answer is almost always yes, and ten imports
  of the company template carried ten copies of it.
- **Same design = by content, never by id.** The converter numbers masters
  and layouts per file (a deck's `pptx-master-1` is the template's
  `pptx-master-2`), so types are paired level by level (roots, then children
  of a pair): equal background and the visible elements pairing up one by
  one — pictures by bytes (hashed), not asset key. Tolerated, because they
  never decide a look: ids, names, roles, prompts, `footerRole`; an EMPTY
  slot by its box only (prompt styling differs between files); footer
  furniture (`footerRole` in the layout) by box + style, its wording free
  ("Page" vs "Seite"). Equal size is required. Measured on a real company
  layout: three decks made from it match master + content layout; a deck whose title
  slide carries a different logo does not; a foreign design does not.
- **Fields are filled from the file.** Where the layout says `{{footer}}` or
  `- {{prop:Classification}} -` and the file says "© Example Corp" /
  "- Internal -", the values are read (`bindHtml`) into `headerFooter.footer.text`
  / `meta.custom` (author/company/subject/event only when empty), so the
  slides keep reading the same through the layout's fields.
- **Each slide must render exactly as before, or it stays as in the file.**
  A slide linked to a matched type is moved over (ids translated through the
  pairing) and proven with the real resync (`relinkPreview`, fields
  resolved); any difference (e.g. the file's title in Calibri where the
  layout's slot names the corporate font) restores it exactly as in the file, unlinked,
  with its design ids suffixed `-file` out of the layout's id space, and the
  reason is kept (`RebaseResult.why`). Nothing in a reuse changes a look.
- **A type the layout lacks** (a trimmed layout) is kept from the file as an
  extra slide type, under the layout's matching master, ids suffixed `-file`;
  unused extras are dropped. A master matching nothing keeps its slides on
  the file's design. The deck gets the layout's whole design
  (`adoptTemplateDesign`) and `basedOn`, so "Update this deck from layout"
  works for imported decks.
- **"Use a different layout…"** (report, when nothing matched) is the
  explicit design change (`restyleOnLayout`): every slide drops the file's
  chrome (its type chain's copies, baked `mst<n>-`/`ly<n>-`, footers) and
  keeps its content, then goes onto the layout's type with the best score:
  slots filled ×3, content without a slot ×−4, empty slots ×−1, px its
  content moves /200, +6 for the same NAME as the slide's old type (the
  converter's `slide-unlinked` finding names an unlinked slide's layout), and
  −3 × the share of the slide the type's own artwork covers (free content
  lands on a quiet content type, not a closing slide). Footer values are read
  into the new layout's fields; a bare `{{footer}}` only from the file's own
  footer. Content left without a slot goes to "Fix with Claude"
  (`layout-floating`). Measured: decks from the company template map 1:1 by name; free-form
  decks land on its title-only content layout; a foreign design onto it is a
  judgement call (6 of 31 slides flagged).
- **Converter (kernel, additive):** a SLIDE's own placeholders now carry
  `role` (title/subtitle/body) and its date/number/footer placeholders
  `footerRole`, linked or not; layout furniture carries `footerRole` too.
  This is also what lets "Change layout…" pour an unlinked imported slide
  into slots instead of leaving its title floating. The link proof
  (`renderEquivalent`) and the linking rig ignore `footerRole`, which only
  matters once `doc.headerFooter` switches a footer off — an import never
  sets that. Every convert rig passes unchanged otherwise.
- `model.matchLayout` is exported (the restyle scores slot displacement).

## 2026-10-13 — The document extension is `.beeslides.html`; `.slidomingo.html` stays readable

Owner's call, extending the BeeSlides rename to the file ending. New files are
named `.beeslides.html` (`DOC_EXT` in `kernel/src/docext.ts`, the only place
the string is defined). Files saved before are `.slidomingo.html`
(`LEGACY_DOC_EXT`) and are the same format, so every place that RECOGNISES a
document (open, drop, template scan, library pickers, desktop argv, backups,
`fileBase`) uses `DOC_EXT_RE`/`hasDocExt`, which accept both. Only code that
NAMES a new file uses `DOC_EXT`; the save picker accepts only `DOC_EXT`, so a
bare name gets the new ending. A legacy file saved in place keeps its name.

Desktop data locations follow the same rule: `templatesDir()` and
`defaultLibraryPath()` keep using an existing `Slidomingo Templates` folder /
`Slidomingo Library.slidomingo.html`, and only a new install gets the
`BeeSlides …` names — so no one's templates or library vanish.

Still `slidomingo` (unchanged, saved files depend on them): the format string,
`#slidomingo-doc`, `window.slidomingo`, storage/IPC/CSS prefixes. Hosts outside
this repo that match `*.slidomingo.html` by name would need the new pattern
added; none ship from here.

## 2026-10-13 — One command installs the desktop app from source: `npm run setup`

Owner's call for the first public version: users clone the repo and run
`npm run setup` (`scripts/setup.mjs`), which checks prerequisites, runs
`npm ci` in slides/ and desktop/, builds the shell and the desktop app, and
installs it where the OS lists applications — `/Applications` (else
`~/Applications`) on macOS, the one-click per-user NSIS installer on Windows,
`~/.local/share/beeslides` + a `.desktop` entry + `~/.local/bin/beeslides` on
Linux. `--uninstall` removes the app and keeps userData. No binaries are
published or signed: a locally built app carries no quarantine flag, so it
opens without Gatekeeper/SmartScreen warnings; the macOS bundle is ad-hoc
signed because Apple silicon will not run it otherwise.

- **Packaged userData is `BeeSlides`** (was pinned to `Slidomingo (dev)`,
  which no installed copy ever used). Dev runs keep `slidomingo-desktop`, so
  an installed app and `npm run dev` never share a profile or the
  single-instance lock.
- **No compiler on macOS/Windows.** node-pty 1.x is a Node-API addon with
  prebuilds for darwin/win32, and Node-API is ABI-stable, so desktop's
  postinstall (`desktop/scripts/rebuild-pty.mjs`) only runs electron-rebuild
  where no prebuild exists (Linux). electron-builder's own rebuild is off
  (`npmRebuild: false`). node-pty 1.1.0 ships the macOS prebuilds'
  `spawn-helper` without its executable bit; the postinstall restores it —
  without that every terminal fails with "posix_spawnp failed" (verified in
  the packaged app).
- **Node 22.12+** everywhere: @electron/rebuild requires it, and one minimum
  is simpler than a per-OS one. The README's install table states it.
- electron-builder packages `node_modules/electron/dist` (`electronDist`)
  instead of downloading Electron a second time.

## 2026-10-13 — First public version is 1.0.0; Bento is credited, not a lineage

The slides app and the desktop app both start public life at 1.0.0. Version
numbers do not continue from Bento's: BeeSlides is a different app that
reuses parts of Bento's code under the MIT License, so prose says "reuses
parts of Bento's code", never "fork". The MIT notice stays in LICENSING.md,
THIRD_PARTY_NOTICES.md and every shell's NOTICE (license requirement). The
pre-release development log was condensed into one CHANGELOG entry; the
fresh public repo carries no history.

## 2026-10-13 — User docs are a Starlight site with scripted walkthrough clips

User-facing docs live in `site/` (Astro Starlight), not a GitHub wiki: they
are reviewed in PRs like code, searchable (Pagefind, offline-built), and
i18n-ready for the same locales as the app. Starlight over VitePress/Docusaurus
because it is Vite-based like the app, content-first, and ships search,
dark/light and a11y without a framework commitment. The site also hosts the
built editor (`/app/`), so "Try it" opens the real thing.

- **Clips are scripts, not recordings.** `site/clips/<id>.clip.mjs` drives the
  built editor in Chromium; `site/scripts/record-clips.mjs` cuts one MP4 per
  step from the CDP screencast (exact timestamps, sharper than recordVideo).
  `<Walkthrough clip>` plays them as click-through steps. A UI change means
  re-running the script, never re-shooting by hand.
- **Clips are tests.** `npm run clips -- --check` runs every scenario fast with
  no recording, and each scenario's `expect` asserts the deck ended in the state
  the captions promise. The docs workflow runs it on every PR touching the app.
- MP4 per step, not GIF: ~100 KB per step versus megabytes. `--gif` exists
  only for places that can't play video (the README).
- Elements are moved with ⇧+arrow nudges, not drags (synthetic drags don't drive
  Moveable). Clips present with "Present in this tab" because headless
  fullscreen ignores the window size.
- Publishing to Pages is manual (`workflow_dispatch` with `deploy`), per rule 8.

## 2026-10-13 — Issues only, no Discussions; a short README

GitHub Discussions stay off: questions, ideas and bugs all go to issues, one
place to watch for a small project. This supersedes the earlier note that
Discussions are on with Q&A / Ideas / Show and tell categories. The README
keeps only the pitch, the `claude-slide` clip, install, contributing and
license; everything else lives on the docs site.

## 2026-10-13 — One drawing, many states: svg `vars`, a show-wide clock for svg loops, loop pivots

Asked for: a tree that sways in the wind and changes season with each slide,
done generically. Three gaps stood in the way, each closed separately.
Particles (snow, rain, leaves as a native element) and Lottie/Rive were
weighed and deferred: particles are a later, separate element; a third-party
runtime would ride in every saved file, and doc data may never carry code
outside the `embed` sandbox.

- **`SvgElement.vars`** (`Record<string, string | number>`): written as CSS
  custom properties (`--name`) on the element frame, so the artwork and its
  scoped `css` read them through `var()`. On a morph between paired svgs whose
  content (markup/asset/css) is unchanged, numbers with the same unit and
  solid colours blend over the morph (`present.ts morphSvgVars`); a keyword,
  a unit change or a one-sided var switches. A content change still
  crossfades as before (`morphContentChanged` ignores `vars` on purpose).
- **One value rule, applied twice.** `model.svgVarValue` + `SVG_VAR_NAME` is a
  TOKEN GRAMMAR (number, number+unit, `#hex`, `rgb/hsl(…)`, a keyword), not a
  blacklist: no `url(`, quotes, `;`, braces or second token, so a value can
  neither fetch nor end its declaration. untrusted.ts uses it for paste and
  agent writes; render.ts (`svgVarDecls`) uses it again on output, because an
  opened FILE is not run through untrusted.ts. ≤ 64 per element. Thumbnails
  (`svgAsImage`, an `<img>` where nothing inherits) get the vars as the svg's
  own `:root` rule. Additive, no `requires`: an older reader keeps the field
  and draws the `var()` fallbacks.
- **Endless svg CSS animations run on the document timeline**
  (`alignEndlessAnimations`: `startTime = 0` for every animation with
  `iterations === Infinity`, after `restartSvgAnimations` clones). The same
  drawing on the next slide is in the same pose, so the wind does not jump at
  a slide change. Finite animations (a draw-on) still replay on entry — that
  split is why it keys off the iteration count rather than all animations.
  The engine's manual test clock does not drive CSS animations; the rig
  measures `startTime` instead.
- **`fx.loop.origin`** (`center` default | `top` | `bottom` | `left` |
  `right`) for spin / wiggle / pulse. Moving `transform-origin` would also
  move the pivot of the model's own `rotate()` — a rotated element would jump
  — so `pivotAt` cancels that with the engine's x/y channel:
  translation = (R − I)(P − C). No kernel change. `stopLoops` clears the
  origin, since a frame restore only resets `transform`.
- **Agents** may set `vars` on artwork already in the deck (restyling, like
  `css`); the "agents do not author SVG" rule (2026-10-11) is unchanged.
- **Only the slide on screen animates its svgs** (styles.css): sections Reveal
  keeps mounted next to it, and the editor canvas under the show overlay
  (`body:has(> .slidomingo-present-overlay) > :not(…)`), get
  `animation-play-state: paused`; thumbnails (`svgAsImage`) carry
  `*{animation-play-state:paused!important}` and hold a still pose. Measured
  on the seasons deck (headless Chromium, software GPU): 1035–1380 running
  animations with 345 on screen → 345; show steady state 26–33 → 80+ fps,
  main thread ~30% busy. A var morph still restyles and repaints the whole
  drawing every frame (~35 fps there); a drawing's node count is its budget.
- **Known limit: vars do not reach paint servers of a repeated drawing.**
  Inline svgs keep their own ids, so the same artwork on four slides puts four
  copies of every id in the document and `url(#g)` paints from the FIRST one
  — a gradient, mask or filter whose stops read a var shows slide 1's values
  everywhere. Seasonal colours therefore go on shapes (`fill: var(--x)`);
  paint servers stay constant. The fix is per-instance id rewriting at render
  (refs in attributes and in the scoped css alike) — its own change.
- Not done yet: a panel to edit vars (colour/number rows) — today they are
  set via JSON or an agent; per-click var changes; the particle element.
- Demo: `scripts/lib/seasons-scene.mjs` generates the drawing (seeded, ~200 KB:
  a branching tree with hierarchical sway, ~1200 reused leaves, mountains,
  cabin, sun that travels between seasons, clouds, birds, stars, petals,
  falling leaves, snow) and the four-slide deck.

Rigs: `scripts/test-svg-vars-e2e.mjs` (the seasons deck: blend mid-morph, no
ghost, shared clock on every slide, a rotated wiggle's foot fixed on its
model frame, hostile vars never rendered; `--save` writes the demo deck),
`scripts/test-sanitize.ts` ("svg vars").

## 2026-10-13 — A living scene from ordinary elements; loops wait for a morph's frame tween

The svg-vars demo (entry above) is one opaque drawing: nothing in it can be
selected. Asked for "complex but fewer parts, editable, with colour
transitions", the same idea was rebuilt from ordinary elements only
(`scripts/lib/lake-scene.mjs`, "Ein Tag am See": 54 shapes and texts, four
slides sharing every id). Morph already blends solid and gradient fills,
opacity and text colour, and moves frames; the generic loops carry the life
(wiggle with `origin: 'bottom'`, spin, float, blink, pulse, dash-march,
motion paths). No new format for it.

- **Fix: a loop no longer fights a morph that moves the same element.** The
  morph's frame tween runs on a state object and writes `transform` itself,
  invisible to the engine's per-node registry, so a float started on arrival
  wrote the same property every frame and the travelling balloon flickered
  between the two. `present.ts frameMorphing` marks the node for the length of
  that tween; `startGenericLoop`'s `busy()` waits on it like on an entrance;
  `stopLoops` clears it so an interrupted morph cannot strand a later loop.
- **Measured** (same rig as the svg demo, headless Chromium, software GPU):
  120 fps (the cap) in the show and during morphs, main thread 7–11% busy,
  ≤ 27% at 4× CPU throttle — against ~35 fps during a var morph of the
  ~2900-node drawing. Ordinary elements animate their own boxes, which the
  compositor can move without repainting the slide.
- Choosing between them: ordinary elements when people will edit the parts
  and the motion is per-object; an svg with `vars` when the artwork is dense
  (hundreds of parts, nested motion) and only its parameters change.

Rig: `scripts/test-native-scene-e2e.mjs` (all shapes/text, gradient blend
mid-morph, the balloon's float waits during its move and resumes from the new
position, origin/spin/blink/dash-march running; `--save` writes the deck).

