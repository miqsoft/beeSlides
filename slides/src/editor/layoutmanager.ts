// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The Layout Manager: a standalone, full-screen editing surface for layout
// concerns — separate from ordinary slide editing, entered from a topbar
// button and exited back into it. It shows ONLY what is saved in this file
// (docs/DECISIONS.md 2026-09-28, "Scope split: Layout Manager = this file;
// Library = global registry in the editor"). Tabs:
//   1. Slide types — `doc.layouts`, with a default-type marker.
//   2. Objects — `doc.reusableObjects`, the deck's own reusable objects.
//   3. Document properties — doc.meta, shared with the Settings modal via
//      `renderDocumentMetaForm`.
//
// The cross-deck element library is NOT here: it is a global registry, not
// part of any document, so it is managed from the slide editor's Library
// panel (librarypanel.ts). This file had a "Shape library" tab for it until
// that split; "Insert object…" (reusableobjects.ts) lists both scopes.
//
// 2026-09-20 (see docs/DECISIONS.md): this file previously had a fourth,
// FIRST tab, "Building blocks," backed by a separate `Master`/`doc.masters[]`
// entity. That entity is gone — a former "master" is now just an ordinary
// `doc.layouts` entry other entries point at via `Slide.parentId` (see
// model.ts's `ancestorChain`/`effectiveLayout`) — so the tab, its master
// pill-strip, and every master-specific action (`renderMasterBar`,
// `renderMasterSettingsForm`, `addMaster`/`duplicateMaster`/`deleteMaster`,
// `renderMasterGroupHead`, the Slide Types grid's group-by-master view, the
// per-card master-reassignment picker) were deleted outright rather than
// ported — there is no data left for them to show.
//
// 2026-09-23 (docs/DECISIONS.md): the Slide types tab is a PowerPoint Slide
// Master–style view — an always-visible slide-type sidebar (typetree.ts:
// depth-first rows with tree guides, drag-and-drop that reorders AND
// reparents, a per-row "+" for a new child) beside the selected type open on
// the canvas. There is no separate list page any more (the old
// `renderTypesGrid`/`renderTypeTree`/`renderTypeCards` and "‹ Back to slide
// types" are gone); "+ New slide type" opens a dedicated Blank / Child of… /
// Independent copy of… dialog (`openNewSlideTypeDialog`).
//
// Modeled on present.ts's takeover PATTERN (its own DOM tree appended over
// the editor, entered from a button, exited via a callback) but, unlike
// Present mode, this is a genuine editing surface — so instead of building a
// second render pipeline, it REPARENTS the same canvasWrap/propsHost DOM
// nodes the main editor already mounted its one SlideCanvas/PropsPanel
// instance into. Those two classes already redraw themselves generically off
// `store.on('current'|'doc', …)`, so redirecting `store.slide` (via
// store.enterLayoutEdit()) is enough to make them show/edit the right
// surface with no plumbing changes — exactly how Slide Master mode already
// worked. A second, separately-constructed SlideCanvas would double up
// canvas.ts's document-level keydown handlers (Delete, space-pan, …), which
// all read the same store — reparenting avoids that entirely.

import { commitHeaderFooter, footerElement } from './decksettings'
import type { Store } from '../store'
import { SlideCanvas } from './canvas'
import {
  ancestorChain, createReusableObject, createSlideTypeAsBasis, createSlideTypeAsParentChild, createSlideTypeBlank,
  embeddedRasterPictures, fontsInUse, linkedSlides, moveSlideTypeInTree, removeUnusedContent,
  replaceDocStrings, uid, unusedContent,
  type Slide, type SlideElement, type SlidomingoDoc,
} from '../model'
import { renderObjectThumbnail } from '../render'
import { ICONS } from '../icons'
import { t } from '../i18n'
import { isDesktopShell } from './ribbon'
import { buildCardGrid } from './cardgrid'
import { buildTypeTree, toastWithUndo, type TypeTree } from './typetree'
import { mergeClipResources } from './clipboard'
import { extractForeignDoc } from './library'
import { buildInsertGroup, insertGroupList } from './insertgroup'
import { renderThemeSwatches } from './panels'
import { renderStyleDefaultsForm } from './styledefaults'
import { buildTermPreview, renderDocLanguage } from './doclanguage'
import { openApplyTo } from './applyto'
import { buildSaveIndicator, type SaveIndicator } from './saveindicator'
import { desktopStatusSource } from './desktopdoc'
import { buildSaveToTemplateMenu } from './templatemenu'
import { formatGate } from '../formatgate'
import { jsonClone } from '../jsonclone.ts'

export interface LayoutManagerSession {
  exit(): void
  /** Re-render the overlay in place after its `LayoutManagerNavState` was
   *  mutated from outside (Editor.openLayoutManager()'s force-navigation
   *  path, when the overlay is already open — see that method's doc
   *  comment). Calling the module-level `openLayoutManager()` a SECOND time
   *  instead would reparent canvasWrap/propsHost into a brand-new stacked
   *  overlay and strand the first one's `exit()` bookkeeping; this is the
   *  safe way to make an already-open session pick up a nav change. */
  refresh(): void
  /** The overlay head bar's own Save button/dirty dot/flash tag — reached by
   *  Editor.flashSaved() (via activeSaveIndicator()) while this overlay owns
   *  the screen, since the main topbar underneath is hidden and unreachable. */
  saveIndicator: SaveIndicator
}

export type Tab = 'types' | 'objects' | 'meta'

/** A template window (desktop Edit Template, editor.ts `templateMode`): the
 *  document IS the template file, so the head bar names it instead of
 *  saying "Changes apply to this deck", offers Rename… instead of "Save to
 *  template ▾", and Done becomes "Sample slides" (the normal editor, where
 *  the template's sample slides live). */
export interface LayoutManagerTemplateMode {
  /** The template's name (its filename) — read on every render, so a
   *  rename shows up once the session is refreshed. */
  name(): string
  rename(): void
}

/** Payload for the `slidomingo:open-layout-manager` DOM event — the loose-
 *  coupling seam any part of the editor can use to jump into a specific
 *  Layout Manager tab (see panels.ts's "🖼 Layout Manager…" button and
 *  reusableobjects.ts's empty-state jump link). `force` overrides the
 *  overlay's normal "resume where you left off" nav-reuse (see
 *  `Editor.openLayoutManager`'s doc comment) — omit it for an ordinary entry
 *  point that should land wherever the user left the overlay last. `newObject`
 *  is Objects-tab-specific: skip the grid and open a fresh blank reusable-
 *  object sub-editor immediately (only meaningful together with
 *  `tab:'objects'` and `force:true`). */
export interface OpenLayoutManagerDetail {
  tab?: Tab
  force?: boolean
  newObject?: boolean
  /** open the Slide types tab with this type's sub-editor */
  layoutId?: string
}

/** Nav cursor for the overlay — which tab, which sub-editor (if any) within
 *  it, and which master's building blocks are showing. Owned by the caller
 *  (Editor.layoutManagerNav — see that field's doc comment), constructed
 *  once and mutated in place across repeat open/close within a session, so
 *  the overlay resumes where you left it instead of amnesia-resetting to
 *  the grid every time. */
export interface LayoutManagerNavState {
  tab: Tab
  editingLayoutId: string | null
  /** which `doc.reusableObjects` entry the Objects tab's
   *  sub-editor is open on — mirrors `editingLayoutId` exactly. */
  editingObjectId: string | null
  /** One-shot flag: when true and `tab === 'objects'`, `render()` creates a
   *  fresh blank reusable object (same logic as the "+ New reusable object"
   *  button) and points `editingObjectId` at it BEFORE building the pane,
   *  then clears the flag immediately — so it fires exactly once, never on
   *  a later unrelated re-render (e.g. a remote collab 'doc' event). Set by
   *  Editor.openLayoutManager() for the empty-state jump link's
   *  `force + newObject` case; see that method's doc comment. */
  newObjectPending?: boolean
}

/** Move `list[from]` to final index `to` (0..list.length-1, evaluated
 *  against the ORIGINAL array — i.e. call this with `to` computed before any
 *  removal has happened). Backs the flat Objects grid's
 *  drag-to-reorder and `‹`/`›` buttons (`doc.reusableObjects` is a plain
 *  `Slide[]` with no grouping concept). */
function moveItem<T>(list: T[], from: number, to: number): void {
  const [moved] = list.splice(from, 1)
  list.splice(Math.max(0, Math.min(list.length, to)), 0, moved)
}

/** Remint every element's id (and groupId/parentId, preserving intra-
 *  batch relationships) — the pure id-remap half of clipboard.ts's
 *  `insertElements`, WITHOUT its clipboard trust-boundary sanitization or
 *  size limits (`LIMITS.elements`/`sanitizeElement` exist for content
 *  arriving off the system clipboard or an agent; a Basis clone's source
 *  is already-trusted same-document content, so routing it through that
 *  pipeline would risk silently truncating/rewriting a large slide type
 *  for no reason). Used by `createSlideTypeAsBasis` — from both the "+ New
 *  slide type" dialog and the `create_slide_type` MCP verb (editor.ts) — so
 *  a Basis clone never shares an element id with its source. Exported (not
 *  a closure inside `openLayoutManager`) so both callers share the one
 *  implementation. */
export function remintElements(elements: SlideElement[]): SlideElement[] {
  const idMap = new Map<string, string>()
  const gidMap = new Map<string, string>()
  const cloned = elements.map((e) => {
    const id = uid(e.type[0])
    idMap.set(e.id, id)
    return { ...jsonClone(e), id }
  })
  for (const el of cloned) {
    if (el.groupId) el.groupId = gidMap.get(el.groupId) ?? gidMap.set(el.groupId, `grp-${uid()}`).get(el.groupId)!
    if (el.parentId) {
      const newParent = idMap.get(el.parentId)
      if (newParent) el.parentId = newParent
      else { delete el.parentId; delete el.parentOffset }
    }
  }
  return cloned
}

/** Reorder a slide type AMONG ITS SIBLINGS (the entries sharing
 *  `parentId`, or the top-level roots when `undefined`) — `from`/`to` are
 *  indices into that sibling list, which is what the `reorder_slide_type`
 *  MCP verb takes. A thin wrapper over `model.ts`'s `moveSlideTypeInTree`
 *  (the general reorder-and-reparent move the sidebar's drag-and-drop
 *  uses), so both paths share one implementation. An out-of-range `to` is
 *  clamped. */
export function moveLayoutWithinParent(doc: SlidomingoDoc, parentId: string | undefined, from: number, to: number): void {
  const siblings = (doc.layouts ?? []).filter((l) => (l.parentId ?? undefined) === parentId)
  const moved = siblings[from]
  if (!moved) return
  const rest = siblings.filter((l) => l !== moved)
  const before = rest[Math.max(0, Math.min(rest.length, to))]
  moveSlideTypeInTree(doc, moved.id, parentId, before?.id)
}

/**
 * Open the Layout Manager overlay. `canvasWrap`/`propsHost` are the SAME DOM
 * nodes the main editor's SlideCanvas/PropsPanel are mounted into (Editor
 * keeps a reference so they can be reparented back on exit); `canvas` is the
 * matching SlideCanvas instance, needed so the building-blocks insert
 * toolbar can call its public `insert()`. The underlying Editor/Store stay
 * mounted underneath — autosave, undo and dirty-tracking `store.on('doc', …)`
 * listeners keep firing untouched while the overlay is open.
 */
export function openLayoutManager(
  store: Store,
  canvas: SlideCanvas,
  canvasWrap: HTMLElement,
  propsHost: HTMLElement,
  onExit: () => void,
  onSave: () => void,
  nav: LayoutManagerNavState,
  onNavChange?: () => void,
  template?: LayoutManagerTemplateMode,
): LayoutManagerSession {
  // `let`, refreshed on every 'doc' event and render(): undo/redo REPLACE
  // `store.doc` wholesale (store.ts `restore`), so a copy captured once at
  // open would keep showing — and editing — the pre-undo document.
  let doc = store.doc

  // Remember exactly where these came from so exit() can put them back.
  const canvasHome = { parent: canvasWrap.parentElement!, next: canvasWrap.nextSibling }
  const propsHome = { parent: propsHost.parentElement!, next: propsHost.nextSibling }

  // The present/zoom corner cluster (editor.ts's build()) lives INSIDE
  // canvasWrap — hide it while this overlay owns canvasWrap, or Present
  // would still be one click away and could stack a second fullscreen
  // takeover on top of this one.
  const corner = canvasWrap.querySelector<HTMLElement>('.ed-corner-br')
  // .style.display, not .hidden — .ed-corner-br sets `display: flex`
  // unconditionally, which (equal specificity, later in the cascade)
  // beats the UA [hidden]{display:none} rule; only an inline style wins.
  if (corner) corner.style.display = 'none'

  const overlay = div('ed-layoutmgr-overlay')
  const head = div('ed-layoutmgr-head')
  const title = document.createElement('div')
  title.className = 'ed-about-h'
  title.textContent = t('Layout Manager')
  const saveIndicator = buildSaveIndicator(store, onSave, desktopStatusSource())
  const doneB = document.createElement('button')
  doneB.className = 'ed-btn ed-btn-primary'
  doneB.textContent = template ? t('Sample slides') : t('Done')
  if (template) doneB.title = t('The layout’s sample slides, in the normal editor — the Layout Manager is one click away')
  doneB.addEventListener('click', () => exit())
  // Two clustered groups (head's own `justify-content: space-between` puts
  // exactly these two flex items at opposite ends) — mirrors the main
  // topbar's layout: flash tag right after the title, Save button (with its
  // dirty dot) alongside Done.
  const headLeft = div('ed-group')
  // Slide-type edits live in THIS deck (and autosave with it); reuse in
  // other decks is the separate, explicit "Save to template" step below.
  // A template window edits the template file itself: the pill names it.
  const scope = div('ed-layoutmgr-scope')
  const syncScope = () => {
    scope.textContent = template ? t('Layout: {name}', { name: template.name() }) : t('Changes apply to this deck')
    if (template) scope.title = t('Changes are saved into the layout file. Decks already made from it don’t change.')
  }
  syncScope()
  const termPreview = buildTermPreview(store, () => typesView?.tree.scheduleThumbs())
  headLeft.append(title, scope, termPreview, saveIndicator.flashTag)
  const headRight = div('ed-group')
  // Terminal toggle — mirrors editor.ts's title-bar button exactly (same
  // icon/tooltip/armed-state wiring) so the Claude Code terminal panel stays
  // reachable while this full-screen overlay hides the normal topbar it
  // otherwise lives in. Unlike that title bar (built once per Editor
  // instance), openLayoutManager() runs on every open, so the state-change
  // subscription below is unsubscribed again in exit() — otherwise repeat
  // opens would stack one more ipcRenderer listener each time.
  let offTerminalState: (() => void) | undefined
  if (isDesktopShell()) {
    const terminalB = btn(ICONS.terminal, '', () => void window.slidomingoDesktop?.toggleTerminal(),
      t('Toggle Claude Code terminal (⌘`)'))
    offTerminalState = window.slidomingoDesktop?.onTerminalStateChange?.((state) => terminalB.classList.toggle('ed-btn-armed', state.open))
    headRight.appendChild(terminalB)
  }
  if (template) {
    headRight.appendChild(btn('', t('Rename…'), () => template.rename(), t('Rename the layout file')))
  } else if (isDesktopShell() && window.slidomingoDesktop?.listTemplateMeta) {
    headRight.appendChild(buildSaveToTemplateMenu(store))
  }
  headRight.append(saveIndicator.root, doneB)
  head.append(headLeft, headRight)

  const body = div('ed-layoutmgr-body')
  const navRail = div('ed-layoutmgr-nav')
  const content = div('ed-layoutmgr-content')
  body.append(navRail, content)
  overlay.append(head, body)

  // canvasWrap + propsHost side by side — shared between the Building
  // Blocks tab and a slide-type sub-editor, MOVED between panes (never
  // rebuilt) so the live SlideCanvas/PropsPanel instances are never torn
  // down. `canvasArea.appendChild` auto-detaches from wherever it was.
  const canvasArea = div('ed-layoutmgr-canvasarea')
  canvasArea.append(canvasWrap, propsHost)

  type TabEntry = {
    id: Tab
    icon: string
    label: () => string
    /** One-line breadcrumb shown under the main label when a nested
     *  sub-editor is open within this tab — null when there's nothing to
     *  show (grid level, or a tab with no nested level at all). */
    subLabel?: (nav: LayoutManagerNavState) => string | null
    /** Step back one nested level within this tab (e.g. sub-editor → grid).
     *  Returns whether it consumed the step (Escape falls through to
     *  exit() only when this is absent or returns false). Tab-switching
     *  itself is never affected — that's a lateral nav-rail click, not a
     *  "level" Escape should undo. */
    stepBack?: (nav: LayoutManagerNavState) => boolean
  }
  const TABS: TabEntry[] = [
    // No subLabel/stepBack: the Slide types tab has no nested level any
    // more — its sidebar and the selected type's canvas are one screen, so
    // Escape exits the overlay straight away.
    { id: 'types', icon: ICONS.grid, label: () => t('Slide types') },
    {
      id: 'objects', icon: ICONS.objects, label: () => t('Objects'),
      subLabel: (nv) => nv.editingObjectId
        ? t('Editing “{name}”', { name: doc.reusableObjects?.find((o) => o.id === nv.editingObjectId)?.name ?? t('Untitled object') })
        : null,
      stepBack: (nv) => {
        if (nv.editingObjectId == null) return false
        nv.editingObjectId = null
        return true
      },
    },
    { id: 'meta', icon: ICONS.notes, label: () => t('Document properties') },
  ]
  const navButtons = new Map<Tab, HTMLElement>()
  /** Rebuild each nav button's markup — called on every render() (not just
   *  once at construction) since a tab's subLabel can change as nav state
   *  changes (e.g. drilling into/out of a slide type). */
  function updateNavButtons() {
    for (const tab of TABS) {
      const b = navButtons.get(tab.id)!
      const sub = tab.subLabel?.(nav)
      b.innerHTML = `${tab.icon}<span class="ed-layoutmgr-navlabel"><span>${tab.label()}</span>` +
        (sub ? `<span class="ed-layoutmgr-navsub">${sub}</span>` : '') + `</span>`
      // The rail shrinks to icons only while the Slide types tab is open
      // (`.ed-layoutmgr-compactnav`), so the label must stay reachable.
      b.title = tab.label()
    }
  }
  for (const tab of TABS) {
    const b = document.createElement('button')
    b.className = 'ed-layoutmgr-navitem'
    b.addEventListener('click', () => {
      if (nav.tab === tab.id) return
      nav.tab = tab.id
      render()
      onNavChange?.()
    })
    navRail.appendChild(b)
    navButtons.set(tab.id, b)
  }

  /** Keep `store.editingSurface` matching (nav.tab, nav.editingLayoutId,
   *  nav.activeMasterId, nav.editingObjectId) — the thing that makes the
   *  reparented SlideCanvas/PropsPanel show the right content. Mirrors the
   *  old enterLayoutMode/exitLayoutMode discipline. Also toggles the
   *  reusable-object canvas's visual content-space grid (canvas.ts
   *  setObjectGrid) so it's on exactly while that surface is open. */
  function syncSurface() {
    if (nav.tab === 'types' && nav.editingLayoutId) {
      store.enterLayoutEdit(nav.editingLayoutId)
    } else if (nav.tab === 'objects' && nav.editingObjectId) {
      store.enterReusableObjectEdit(nav.editingObjectId)
    } else if (store.editingSurface) {
      if (store.editingSurface.kind === 'layout') store.exitLayoutEdit()
      else store.exitReusableObjectEdit()
    }
    canvas.setObjectGrid(store.editingSurface?.kind === 'reusableObject')
  }

  /** Ready-made page-number footer, bottom-right — the one-click shortcut
   *  for the actual footer/page-number use case, alongside the general
   *  Insert-field control in panels.ts. `{{page}} / {{pages}}` auto-
   *  renumbers as slides are added/removed/hidden (render.ts resolveFields). */
  function pageFooterElement(bg: string): SlideElement {
    return footerElement(doc, 'slideNumber', bg)
  }

  /** Shared insert toolbar for a slide-type sub-editor — the general insert
   *  group plus the one-click page-number-footer shortcut, which used to
   *  live only in the (now-deleted) Building Blocks toolbar. A footer is
   *  exactly the kind of element that belongs on a slide type OTHER slide
   *  types descend from, and every slide type is now an equally valid place
   *  to add one — there is no separate building-blocks surface to special-
   *  case it into anymore. */
  function insertToolbarWithFooter(bg: string): HTMLElement {
    const toolbar = div('ed-layoutmgr-toolbar')
    toolbar.append(...insertGroupList(buildInsertGroup(store, canvas)))
    toolbar.appendChild(btn(ICONS.text, t('Add page-number footer'), () => canvas.insert(pageFooterElement(bg)),
      t('Insert a ready-made page-number field, bottom-right — it renumbers itself as slides are added, removed or hidden')))
    return toolbar
  }

  /** "Live on N slide(s)" / "Not used by any slide yet" — the answer to
   *  "what does editing this actually touch, live, right now." Computed via
   *  `linkedSlides` (model.ts), the SAME function that drives the actual
   *  resync in editor.ts's syncLayoutInstances, so this can never claim
   *  something the resync doesn't also do. Covers the FULL descendant
   *  subtree, not just direct links — see model.ts's `linkedSlides` doc
   *  comment. Not clickable in this pass — a clean seam for a future "jump
   *  to Slide Sorter filtered to these slides," not wired up yet. */
  function renderLiveScopePill(layoutId: string): HTMLElement {
    const slides = linkedSlides(doc, layoutId)
    const pill = div('ed-layoutmgr-pill')
    pill.textContent = slides.length
      ? t('Live on {n} slide(s)', { n: slides.length })
      : t('Not used by any slide yet')
    if (slides.length) pill.title = slides.map((s) => s.name ?? t('Untitled')).join(', ')
    return pill
  }

  // ---- Slide types tab: [sidebar | editor column] ---------------------------

  /** The Slide types pane's persistent structure — built ONCE per entry
   *  into the tab (see render()), then updated in place: a 'doc' event
   *  refreshes the sidebar (full rebuild only when the tree's STRUCTURE
   *  changed, otherwise just its debounced thumbnails) and swaps the small
   *  header, but never re-appends `canvasArea` — so an edit on the canvas
   *  keeps its selection and the live SlideCanvas is never re-mounted. */
  interface TypesView {
    pane: HTMLElement
    tree: TypeTree
    editorCol: HTMLElement
    header: HTMLElement | null
    toolbar: HTMLElement | null
    /** Which slide type `toolbar` was built for (its page-footer ink reads
     *  that type's background). */
    toolbarFor: string | null
    structSig: string
  }
  let typesView: TypesView | null = null

  /** What the sidebar's rows are built from — ids, parents, names, the
   *  default marker, and the slide leaves: which slides link where (the
   *  counts, and a relink moving a leaf), their order/state/hidden flags and
   *  title text (the leaf label). A change here needs a full sidebar
   *  rebuild; anything else (an element edited on the canvas, a resync
   *  restyling a linked slide) only needs thumbnails. */
  function typesStructureSig(): string {
    return JSON.stringify([
      (doc.layouts ?? []).map((l) => [l.id, l.parentId ?? '', l.name ?? '', !!l.parentOnly]),
      doc.defaultLayoutId ?? '',
      doc.slides.map((s) => [
        s.id, s.layoutId ?? '', s.stateOf ?? '', !!s.hidden,
        s.elements.filter((e) => e.type === 'text' && e.role === 'title').map((e) => (e as { html: string }).html),
      ]),
    ])
  }

  /** Point `nav.editingLayoutId` at a real slide type: kept when it still
   *  exists, else the default slide type, else the first root (null only
   *  for a document with no slide types at all). */
  function resolveTypeSelection() {
    const layouts = doc.layouts ?? []
    if (nav.editingLayoutId && layouts.some((l) => l.id === nav.editingLayoutId)) return
    const pick = layouts.find((l) => l.id === doc.defaultLayoutId) ?? layouts.find((l) => !l.parentId) ?? layouts[0]
    nav.editingLayoutId = pick?.id ?? null
  }

  function buildTypesView(): TypesView {
    const pane = div('ed-layoutmgr-pane ed-layoutmgr-types')
    const tree = buildTypeTree({
      store,
      selectedId: () => nav.editingLayoutId,
      onSelect: (id) => { nav.editingLayoutId = id; render() },
      onNew: () => openNewSlideTypeDialog(),
      onImport: () => importLayoutFamily(),
      remint: remintElements,
      onGoToSlide: (slideId) => {
        exit()
        const i = store.doc.slides.findIndex((s) => s.id === slideId)
        if (i >= 0) store.goTo(i)
      },
    })
    const editorCol = div('ed-layoutmgr-typeeditor')
    pane.append(tree.root, editorCol)
    return { pane, tree, editorCol, header: null, toolbar: null, toolbarFor: null, structSig: typesStructureSig() }
  }

  /** Header above the canvas: a clickable ancestor breadcrumb
   *  (`Corporate › Content › Two columns`, from `ancestorChain`), the
   *  "greyed elements come from…" hint for a child, the live-scope pill and
   *  "Apply to…". Cheap — rebuilt on every 'doc' event so the pill stays
   *  current. */
  function renderTypeHeader(layout: Slide): HTMLElement {
    const head = div('ed-layoutmgr-breadcrumb ed-layoutmgr-typehead')
    const crumbs = div('ed-layoutmgr-crumbs')
    const chain = ancestorChain(doc, layout)
    chain.forEach((ly, i) => {
      if (i) {
        const sep = document.createElement('span')
        sep.className = 'ed-layoutmgr-crumbsep'
        sep.textContent = '›'
        crumbs.appendChild(sep)
      }
      const name = ly.name || t('Untitled')
      if (ly === layout) {
        const cur = document.createElement('span')
        cur.className = 'ed-layoutmgr-crumbcur'
        cur.textContent = name
        crumbs.appendChild(cur)
      } else {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'ed-layoutmgr-crumb'
        b.textContent = name
        b.title = t('Open “{name}”', { name })
        b.addEventListener('click', () => { nav.editingLayoutId = ly.id; render() })
        crumbs.appendChild(b)
      }
    })
    head.appendChild(crumbs)
    if (chain.length > 1) {
      const parent = chain[chain.length - 2]
      const hint = document.createElement('span')
      hint.className = 'ed-layoutmgr-inherithint'
      hint.textContent = t('Inherited elements come from “{name}” and are locked here — select it to edit them', { name: parent.name || t('Untitled') })
      head.appendChild(hint)
    }
    const tail = div('ed-layoutmgr-typehead-end')
    tail.appendChild(renderLiveScopePill(layout.id))
    // "Apply to…" — scoped retargeting for slides already live-resynced by
    // this edit (see applyto.ts's doc comment for the framing). Hidden when
    // there's nothing to scope: no linked slides means every edit here is
    // already fully expressed by the template alone. Covers the full
    // descendant subtree via model.ts's `linkedSlides`.
    if (linkedSlides(doc, layout.id).length > 0) {
      const applyToB = document.createElement('button')
      applyToB.className = 'ed-btn'
      applyToB.textContent = t('Apply to…')
      applyToB.addEventListener('click', () => openApplyTo(store, layout.id, () => render()))
      tail.appendChild(applyToB)
    }
    head.appendChild(tail)
    return head
  }

  /** Bring the editor column in line with `nav.editingLayoutId` — header
   *  always, insert toolbar only when the selected type changed, and
   *  `canvasArea` appended only when it isn't already there. */
  function updateTypesEditor() {
    const v = typesView
    if (!v) return
    const layout = nav.editingLayoutId ? doc.layouts?.find((l) => l.id === nav.editingLayoutId) : undefined
    if (!layout) {
      const empty = div('ed-layoutmgr-empty')
      empty.textContent = t('No slide types yet — add one to start building a reusable set of slide designs.')
      v.editorCol.replaceChildren(empty)
      v.header = v.toolbar = v.toolbarFor = null
      return
    }
    const header = renderTypeHeader(layout)
    if (!v.header || !v.toolbar || !v.editorCol.contains(canvasArea)) {
      v.toolbar = insertToolbarWithFooter(layout.background ?? '#FFFFFF')
      v.toolbarFor = layout.id
      v.editorCol.replaceChildren(header, v.toolbar, canvasArea)
    } else {
      v.header.replaceWith(header)
      if (v.toolbarFor !== layout.id) {
        const toolbar = insertToolbarWithFooter(layout.background ?? '#FFFFFF')
        v.toolbar.replaceWith(toolbar)
        v.toolbar = toolbar
        v.toolbarFor = layout.id
      }
    }
    v.header = header
  }

  /** 'doc' handler while the Slide types tab is showing — see TypesView. */
  function onTypesDocChange(v: TypesView) {
    resolveTypeSelection()
    if (store.editingSurface?.id !== nav.editingLayoutId) syncSurface()
    const sig = typesStructureSig()
    if (sig !== v.structSig) {
      v.structSig = sig
      v.tree.refresh()
    } else {
      v.tree.scheduleThumbs()
    }
    updateTypesEditor()
  }

  /**
   * "+ New slide type" — a small, dedicated dialog (deliberately NOT the
   * built-in-layout gallery `openLayoutPicker` uses, which is for adding a
   * real content slide): a required Name, then **Blank**, **Child of…**
   * (inherits everything from the chosen type and appears indented under
   * it — the same `createSlideTypeAsParentChild` the sidebar's per-row "+"
   * uses) or **Independent copy of…** (a one-time Basis clone). The two
   * "of…" modes reveal a plain list of this document's OWN slide types
   * (never built-ins). Create stays disabled while Name is empty — the
   * native disabled-button affordance, no error toast needed.
   */
  function openNewSlideTypeDialog(): void {
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about ed-newtype-box')
    const h = document.createElement('h2')
    h.textContent = t('New slide type')
    box.appendChild(h)

    const nameRow = document.createElement('label')
    nameRow.className = 'ed-row'
    const nameSpan = document.createElement('span')
    nameSpan.textContent = t('Name')
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.required = true
    nameInput.placeholder = t('e.g. “Section header”')
    nameRow.append(nameSpan, nameInput)
    box.appendChild(nameRow)

    const existing = doc.layouts ?? []
    type Mode = 'blank' | 'child' | 'copy'
    const modeRow = div('ed-newtype-mode')
    const modeBtn = (label: string, needsSource: boolean) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-btn ed-newtype-modebtn'
      b.textContent = label
      if (needsSource && !existing.length) {
        b.disabled = true
        b.title = t('No existing slide types to base one on yet')
      }
      modeRow.appendChild(b)
      return b
    }
    const buttons: Record<Mode, HTMLButtonElement> = {
      blank: modeBtn(t('Blank'), false) as HTMLButtonElement,
      child: modeBtn(t('Child of…'), true) as HTMLButtonElement,
      copy: modeBtn(t('Independent copy of…'), true) as HTMLButtonElement,
    }
    box.appendChild(modeRow)

    const explain = document.createElement('p')
    explain.className = 'ed-hint ed-newtype-explain'
    box.appendChild(explain)

    const basedPane = div('ed-newtype-based')
    const sourceRow = document.createElement('label')
    sourceRow.className = 'ed-row'
    const sourceSpan = document.createElement('span')
    const sourceSel = document.createElement('select')
    for (const ly of existing) {
      const o = document.createElement('option')
      o.value = ly.id
      o.textContent = ly.name ?? t('Untitled')
      sourceSel.appendChild(o)
    }
    if (nav.editingLayoutId && existing.some((l) => l.id === nav.editingLayoutId)) sourceSel.value = nav.editingLayoutId
    sourceRow.append(sourceSpan, sourceSel)
    basedPane.appendChild(sourceRow)
    box.appendChild(basedPane)

    let mode: Mode = 'blank'
    const setMode = (m: Mode) => {
      mode = m
      for (const [k, b] of Object.entries(buttons)) b.classList.toggle('active', k === m)
      basedPane.classList.toggle('open', m !== 'blank')
      sourceSpan.textContent = m === 'child' ? t('Parent') : t('Copy of')
      explain.textContent = m === 'blank'
        ? t('Starts empty and independent.')
        : m === 'child'
          ? t('Inherits everything from it and appears indented under it — edit the parent to change what they share.')
          : t('A one-time independent copy you can edit freely from here on.')
    }
    for (const [k, b] of Object.entries(buttons)) b.addEventListener('click', () => { if (!b.disabled) setMode(k as Mode) })
    setMode('blank')

    const actions = div('ed-dialog-actions')
    const cancel = document.createElement('button')
    cancel.className = 'ed-btn'
    cancel.textContent = t('Cancel')
    cancel.addEventListener('click', () => close())
    const create = document.createElement('button')
    create.className = 'ed-btn ed-btn-primary'
    create.textContent = t('Create')
    create.disabled = true
    nameInput.addEventListener('input', () => { create.disabled = !nameInput.value.trim() })
    const submit = () => {
      const name = nameInput.value.trim()
      if (!name) return
      store.commit(() => {
        if (mode === 'blank') {
          nav.editingLayoutId = createSlideTypeBlank(store.doc, name).id
        } else {
          const source = store.doc.layouts?.find((l) => l.id === sourceSel.value)
          if (!source) return
          nav.editingLayoutId = mode === 'copy'
            ? createSlideTypeAsBasis(store.doc, source, name, remintElements).id
            : createSlideTypeAsParentChild(store.doc, source, name).id
        }
      })
      close()
      render()
    }
    create.addEventListener('click', submit)
    nameInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit() } })
    actions.append(cancel, create)
    box.appendChild(actions)

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
    document.addEventListener('keydown', onKey, true)

    overlay.appendChild(box)
    document.body.appendChild(overlay)
    nameInput.focus()
  }

  /**
   * "Import layouts from library…" — the one genuinely new capability the
   * per-family design needs to matter in practice: without a way to bring a
   * SECOND family (a root slide type + its descendants) into an
   * already-open document, a fresh deck's `doc.layouts` would never hold
   * more than the one family it started with.
   *
   * Picks any BeeSlides file via a plain `<input type="file">` — a
   * ONE-SHOT read, unlike `editor/library.ts`'s own picker which persists a
   * File System Access handle for repeat access, so no handle-persistence
   * machinery is needed here; this works on every browser, not just ones
   * with `showOpenFilePicker`. Parses it with `extractForeignDoc` (the same
   * foreign-file trust posture as the element library: browsing/thumbnailing
   * is safe, actual merging goes through the same sanitize+merge pipeline a
   * paste already does), then merges its ENTIRE layout family (masters +
   * layouts) into the open document.
   */
  function importLayoutFamily(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.beeslides.html,.beeslides.html,.html,text/html'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) void handleImportPick(file)
    })
    input.click()
  }

  async function handleImportPick(file: File): Promise<void> {
    const html = await file.text()
    const result = extractForeignDoc(html)
    if ('error' in result) { window.alert(result.error); return }
    if (!result.doc.layouts?.length) { window.alert(t('That file has no slide types to import.')); return }
    store.commit(() => mergeLayoutFamily(doc, result.doc))
    render()
  }

  /**
   * Merge a foreign document's WHOLE layout family (every `doc.layouts`
   * entry — `foreign` has already been through `parseDoc`, via
   * `extractForeignDoc`, so a pre-2026-09-20 file's `doc.masters` has
   * already migrated into ordinary root entries by the time this runs) into
   * `doc`. Every layout's id — and every element within it — is reminted
   * through ONE remap table before merging (down from the old two, one per
   * former master/layout split), so two independently-authored families can
   * never collide (same discipline clipboard.ts's cross-doc paste already
   * applies to asset-key collisions; this is exactly a family-sized paste).
   * Each clone's `parentId` is remapped through that same table — dropped
   * (never left dangling) if it pointed outside this import, the same
   * "orphaning is free" fallback used elsewhere in this format. Shared
   * assets/embedded fonts are merged via the SAME `mergeClipResources`
   * pipeline a paste uses, and referencing elements' `asset:`/`src` refs are
   * rewritten to match. Mutates `doc` in place — caller wraps in
   * `store.commit` for undo grouping.
   */
  function mergeLayoutFamily(doc: SlidomingoDoc, foreign: SlidomingoDoc): void {
    const idMap = new Map<string, string>()
    for (const ly of foreign.layouts ?? []) idMap.set(ly.id, uid('layout'))
    const clonedLayouts: Slide[] = (foreign.layouts ?? []).map((ly) => {
      const clone = jsonClone(ly)
      clone.id = idMap.get(ly.id)!
      clone.elements = remintElements(clone.elements)
      if (clone.parentId) {
        const mapped = idMap.get(clone.parentId)
        if (mapped) clone.parentId = mapped
        else delete clone.parentId
      }
      return clone
    })
    mergeClipResources(foreign, doc, clonedLayouts.flatMap((l) => l.elements))
    doc.layouts = [...(doc.layouts ?? []), ...clonedLayouts]
  }

  /** Create a fresh, blank reusable object and point the nav cursor at its
   *  sub-editor — always starts blank, unlike a slide type there is nothing
   *  sensible to clone from, so no picker step. Split out from
   *  `newReusableObject()` (below) so `render()`'s one-shot
   *  `newObjectPending` consumption — the empty-state jump link from
   *  reusableobjects.ts — can reuse this exact logic without duplicating
   *  the object-creation code in editor.ts. Caller is responsible for
   *  calling `render()` afterward. */
  function createNewReusableObject(): void {
    store.commit(() => { nav.editingObjectId = createReusableObject(doc).id })
  }

  /** "+ New reusable object" toolbar button. */
  function newReusableObject() {
    createNewReusableObject()
    render()
  }

  /** Grid of saved reusable objects — no star/default-marker, no master badge/picker, no
   *  live-scope pill (there is no live-link concept for a reusable object —
   *  see model.ts's `reusableObjects` doc comment and the delete handler
   *  below, which is a plain array filter with no `removeLayout`-style
   *  cross-doc cleanup scan). Order IS real data here (both this grid and
   *  the insert picker's `renderGrid` in reusableobjects.ts preserve array
   *  order), so it gets the same manual reorder affordances as the Slide
   *  Types grid — drag-and-drop AND `‹`/`›` buttons — just without the
   *  master-group scoping that grid needs: a flat splice against
   *  `doc.reusableObjects!` via the SAME `moveLayout` helper (it already
   *  operates on any `Slide[]`, no generalization needed). */
  function renderObjectsGrid(): HTMLElement {
    const pane = div('ed-layoutmgr-pane')
    const toolbar = div('ed-layoutmgr-toolbar')
    toolbar.appendChild(btn(ICONS.plus, t('New reusable object'), () => newReusableObject()))
    pane.appendChild(toolbar)

    const objects = doc.reusableObjects ?? []
    if (!objects.length) {
      const empty = div('ed-layoutmgr-empty')
      empty.textContent = t('No reusable objects yet — build a figure, icon set, or labeled diagram once and reuse it anywhere in the deck.')
      pane.appendChild(empty)
      return pane
    }

    const grid = buildCardGrid({
      store,
      items: objects,
      renderThumb: (obj) => renderObjectThumbnail(obj, doc, 168),
      getName: (obj) => obj.name,
      defaultName: t('Untitled object'),
      onRename: (obj, name) => { obj.name = name },
      deleteTitle: t('Delete this reusable object'),
      deleteConfirm: () => t('Delete this reusable object? Copies already inserted elsewhere are unaffected.'),
      onDelete: (obj) => { doc.reusableObjects = (doc.reusableObjects ?? []).filter((o) => o.id !== obj.id) },
      onOpen: (obj) => { nav.editingObjectId = obj.id; render() },
      onMove: (from, to) => moveItem(doc.reusableObjects!, from, to),
      dragGroup: null,
      onChange: render,
    })
    pane.appendChild(grid)
    return pane
  }

  /** Sub-editor for one reusable object — a simplified structural mirror of
   *  the Slide types editor column: no ancestor breadcrumb (a reusable object has no
   *  master), no live-scope pill. Same shared insert toolbar as the other
   *  two panes, so an object can be composed from other saved objects too. */
  function renderObjectsSubEditor(): HTMLElement {
    const pane = div('ed-layoutmgr-pane')
    const obj = doc.reusableObjects?.find((o) => o.id === nav.editingObjectId)
    const crumb = div('ed-layoutmgr-breadcrumb')
    const back = document.createElement('button')
    back.className = 'ed-btn'
    back.textContent = t('‹ Back to reusable objects')
    back.addEventListener('click', () => { nav.editingObjectId = null; render() })
    const name = document.createElement('span')
    name.textContent = t('Editing “{name}”', { name: obj?.name ?? t('Untitled object') })
    crumb.append(back, name)
    const toolbar = div('ed-layoutmgr-toolbar')
    toolbar.append(...insertGroupList(buildInsertGroup(store, canvas)))
    pane.append(crumb, toolbar, canvasArea)
    return pane
  }

  function renderMetaPane(): HTMLElement {
    const pane = div('ed-layoutmgr-pane ed-layoutmgr-meta')
    renderDocumentMetaForm(pane, store)
    return pane
  }

  function render() {
    doc = store.doc
    syncScope()
    // One-shot: consumed and cleared immediately so a later unrelated
    // re-render (e.g. a remote collab 'doc' event, or a manual nav-rail
    // click away and back) never creates a second blank object. Must run
    // BEFORE syncSurface() below, which reads `nav.editingObjectId` to
    // decide whether to enter the reusable-object editing surface.
    if (nav.tab === 'objects' && nav.newObjectPending) {
      nav.newObjectPending = false
      createNewReusableObject()
    }
    for (const [id, b] of navButtons) b.classList.toggle('active', id === nav.tab)
    updateNavButtons()
    if (nav.tab === 'types') resolveTypeSelection()
    syncSurface()
    // Three columns (rail | sidebar | canvas) only fit with an icon-only rail.
    overlay.classList.toggle('ed-layoutmgr-compactnav', nav.tab === 'types')
    if (nav.tab === 'types') {
      if (!typesView || !content.contains(typesView.pane)) {
        typesView = buildTypesView()
        content.replaceChildren(typesView.pane)
      } else {
        typesView.structSig = typesStructureSig()
        typesView.tree.refresh()
      }
      updateTypesEditor()
      return
    }
    typesView = null
    const pane = nav.tab === 'objects' ? (nav.editingObjectId ? renderObjectsSubEditor() : renderObjectsGrid())
      : renderMetaPane()
    content.replaceChildren(pane)
  }

  // Esc closes the manager — but a text/color edit in progress inside the
  // reparented canvas or panel gets its own Escape first (mirrors
  // PropsPanel's isActiveEditFocus): otherwise a capture-phase listener like
  // this one would close the whole overlay out from under an in-progress
  // text edit, since it fires before the edited node's own bubble-phase
  // handler ever runs.
  const isActiveEditFocus = (): boolean => {
    const a = document.activeElement as HTMLElement | null
    if (!a) return false
    if (a.isContentEditable) return true
    if (a.tagName === 'TEXTAREA') return true
    if (a.tagName === 'INPUT') {
      const ty = (a as HTMLInputElement).type
      return ty !== 'checkbox' && ty !== 'radio' && ty !== 'button'
    }
    return false
  }
  // Escape steps back one nested level (e.g. a reusable-object sub-editor
  // back to its grid) before it closes the whole overlay — the Slide types
  // tab has no nested level, so there it exits straight away — mirrors a native app's
  // "one Escape, one step" expectation. Tab-switching itself is a lateral
  // nav-rail action and is never touched by this.
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || isActiveEditFocus()) return
    ev.stopPropagation()
    const activeEntry = TABS.find((tb) => tb.id === nav.tab)
    if (activeEntry?.stepBack?.(nav)) { render(); return }
    exit()
  }
  document.addEventListener('keydown', onKey, true)

  // Keep everything current on every doc change — local edits, undo/redo
  // (which swap `store.doc` for a new object) and remote ops alike. The
  // Slide types tab updates in place (onTypesDocChange — no canvas
  // re-mount on every keystroke); the other tabs re-render as before.
  const offDoc = store.on('doc', () => {
    doc = store.doc
    if (nav.tab === 'types' && typesView && content.contains(typesView.pane)) onTypesDocChange(typesView)
    else render()
  })

  let exited = false
  function exit() {
    if (exited) return
    exited = true
    document.removeEventListener('keydown', onKey, true)
    offDoc()
    offTerminalState?.()
    if (store.termPreview) { store.termPreview = null; store.emit('current') }
    saveIndicator.destroy()
    if (store.editingSurface) {
      if (store.editingSurface.kind === 'layout') store.exitLayoutEdit()
      else store.exitReusableObjectEdit()
    }
    canvas.setObjectGrid(false)
    if (corner) corner.style.display = ''
    canvasHome.parent.insertBefore(canvasWrap, canvasHome.next)
    propsHome.parent.insertBefore(propsHost, propsHome.next)
    overlay.remove()
    onExit()
  }

  render()
  document.body.appendChild(overlay)
  return { exit, refresh: render, saveIndicator }
}

/**
 * Document properties → fillable {{author}} {{company}} {{subject}} {{event}}
 * fields (plus doc.title). Extracted out of the Settings modal's old private
 * "Document" category method so BOTH the Settings modal and the Layout
 * Manager's "Document properties" tab get a working editor from one
 * implementation, rather than two copies that can drift apart.
 */
export function renderDocumentMetaForm(host: HTMLElement, store: Store): void {
  const metaWrap = div('ed-about-row ed-about-meta-wrap')
  const metaTitle = document.createElement('div')
  metaTitle.className = 'ed-about-h'
  metaTitle.textContent = t('Document properties')
  metaWrap.appendChild(metaTitle)
  const metaHint = document.createElement('p')
  metaHint.className = 'ed-hint'
  metaHint.innerHTML = t('Type <b>{{author}}</b>, <b>{{company}}</b>, <b>{{subject}}</b> or <b>{{event}}</b> in any text box and it fills in from here — everywhere at once. Handy for title slides and footers.')
  metaWrap.appendChild(metaHint)
  const ensureMeta = () => (store.doc.meta ??= {})
  const metaField = (label: string, get: () => string, set: (v: string) => void) => {
    const row = div('ed-about-meta')
    const l = document.createElement('label')
    l.textContent = label
    const inp = document.createElement('input')
    inp.type = 'text'
    inp.value = get()
    inp.addEventListener('change', () => store.commit(() => set(inp.value.trim())))
    row.append(l, inp)
    metaWrap.appendChild(row)
  }
  metaField(t('Title'), () => store.doc.title, (v) => { store.doc.title = v || 'Untitled' })
  metaField(t('Author'), () => store.doc.meta?.author ?? '', (v) => { ensureMeta().author = v })
  metaField(t('Company'), () => store.doc.meta?.company ?? '', (v) => { ensureMeta().company = v })
  metaField(t('Subject'), () => store.doc.meta?.subject ?? '', (v) => { ensureMeta().subject = v })
  metaField(t('Event'), () => store.doc.meta?.event ?? '', (v) => { ensureMeta().event = v })
  metaField(t('Keywords'), () => store.doc.meta?.keywords ?? '', (v) => { ensureMeta().keywords = v })
  renderCustomProps(metaWrap, store)
  renderDocLanguage(metaWrap, store)
  renderHeaderFooter(metaWrap, store)
  renderThemeSwatches(metaWrap, store)

  // the deck-level fallback of the slide-type "Default styles" form
  const styleTitle = document.createElement('div')
  styleTitle.className = 'ed-about-h'
  styleTitle.textContent = t('Default styles for slides without a slide type')
  metaWrap.appendChild(styleTitle)
  renderStyleDefaultsForm(metaWrap, store, { kind: 'deck' })

  // "Fonts in use" — a pure DERIVED read (model.ts's `fontsInUse`), never a
  // stored field: the theme, every slide type's own font at every tier, and
  // every element's own override, collected fresh on each render. Nothing to
  // keep in sync — introducing a font anywhere makes it show up here on the
  // next render, with no separate "register" step. Read-only/informational;
  // `embedded` (has an `@font-face` asset in `doc.fonts[]`) gets a small
  // badge so a system/theme font and an embedded one are never confused for
  // one another.
  const fontsTitle = document.createElement('div')
  fontsTitle.className = 'ed-about-h'
  fontsTitle.textContent = t('Fonts in use')
  metaWrap.appendChild(fontsTitle)
  const fonts = fontsInUse(store.doc)
  if (!fonts.length) {
    const fontsEmpty = document.createElement('p')
    fontsEmpty.className = 'ed-hint'
    fontsEmpty.textContent = t('No fonts referenced yet.')
    metaWrap.appendChild(fontsEmpty)
  } else {
    const list = div('ed-fontsinuse-list')
    for (const f of fonts) {
      const row = div('ed-fontsinuse-row')
      const name = document.createElement('span')
      name.className = 'ed-fontsinuse-name'
      name.style.fontFamily = f.family || 'inherit'
      name.textContent = f.family
      row.appendChild(name)
      if (f.embedded) {
        const badge = document.createElement('span')
        badge.className = 'ed-fontsinuse-badge'
        badge.textContent = t('Embedded')
        row.appendChild(badge)
      }
      list.appendChild(row)
    }
    metaWrap.appendChild(list)
  }

  renderCleanup(metaWrap, store)
  host.appendChild(metaWrap)
}

/** Custom document properties (`doc.meta.custom`) — name/value rows, each
 *  usable in text as {{prop:Name}}, the classification line being the
 *  usual one. Renaming a property renames it here only: text still naming
 *  the old one shows empty until it is retyped. Refills itself on 'doc'. */
function renderCustomProps(host: HTMLElement, store: Store): void {
  const title = document.createElement('div')
  title.className = 'ed-about-h'
  title.textContent = t('Custom properties')
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.innerHTML = t('Type <b>{{prop:Name}}</b> in any text box to show a property — a classification, a project number. Change it here and every slide follows.')
  const list = div('ed-customprops')
  host.append(title, hint, list)
  const commitProps = (mut: (c: Record<string, string>) => void) => store.commit(() => {
    const meta = (store.doc.meta ??= {})
    const next = { ...(meta.custom ?? {}) }
    mut(next)
    if (Object.keys(next).length) meta.custom = next
    else delete meta.custom
  })
  const fill = () => {
    list.replaceChildren()
    for (const [name, value] of Object.entries(store.doc.meta?.custom ?? {})) {
      const row = div('ed-about-meta ed-customprop')
      const n = document.createElement('input')
      n.type = 'text'
      n.value = name
      n.className = 'ed-customprop-name'
      n.setAttribute('aria-label', t('Property name'))
      n.addEventListener('change', () => {
        const next = n.value.trim()
        if (!next || next === name) { n.value = name; return }
        commitProps((c) => {
          // keep the row where it was: rebuild in order with the new key
          const entries = Object.entries(c).map(([k, v]) => [k === name ? next : k, v] as const)
          for (const k of Object.keys(c)) delete c[k]
          for (const [k, v] of entries) c[k] = v
        })
      })
      const v = document.createElement('input')
      v.type = 'text'
      v.value = value
      v.setAttribute('aria-label', t('Property value'))
      v.addEventListener('change', () => commitProps((c) => { c[name] = v.value }))
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'ed-btn ed-btn-icon'
      del.textContent = '✕'
      del.title = t('Remove this property')
      del.addEventListener('click', () => commitProps((c) => { delete c[name] }))
      row.append(n, v, del)
      list.appendChild(row)
    }
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'ed-btn'
    add.textContent = t('＋ Add property')
    add.addEventListener('click', () => {
      const existing = store.doc.meta?.custom ?? {}
      let name = t('Property')
      for (let i = 2; name in existing; i++) name = `${t('Property')} ${i}`
      commitProps((c) => { c[name] = '' })
      list.querySelector<HTMLInputElement>('.ed-customprop:last-of-type .ed-customprop-name')?.select()
    })
    list.appendChild(add)
  }
  fill()
  let sig = JSON.stringify(store.doc.meta?.custom ?? {})
  const off = store.on('doc', () => {
    if (!list.isConnected) { off?.(); return }
    const next = JSON.stringify(store.doc.meta?.custom ?? {})
    if (next !== sig) { sig = next; fill() }
  })
}

/** Header & footer (`doc.headerFooter`) — PowerPoint's dialog of the same
 *  name: which footer pieces show, the footer's text, a fixed date. It
 *  drives the text boxes tagged with a footer role, which stay where the
 *  slide types put them. Writes nothing for a default, so a deck that
 *  never touches this carries no `headerFooter` at all. */
function renderHeaderFooter(host: HTMLElement, store: Store): void {
  const title = document.createElement('div')
  title.className = 'ed-about-h'
  title.textContent = t('Header & footer')
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.textContent = t('For the text boxes marked as Date, Slide number or Footer (Footer item, in the text’s properties) — usually on a slide type. One switch here shows or hides them on every slide.')
  const box = div('ed-headerfooter')
  host.append(title, hint, box)
  type HF = NonNullable<SlidomingoDoc['headerFooter']>
  const commitHF = (mut: (hf: HF) => void) => commitHeaderFooter(store, mut)
  const check = (label: string, on: boolean, set: (v: boolean) => void): HTMLLabelElement => {
    const l = document.createElement('label')
    l.className = 'ed-headerfooter-check'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = on
    cb.addEventListener('change', () => set(cb.checked))
    l.append(cb, document.createTextNode(' ' + label))
    return l
  }
  const fill = () => {
    box.replaceChildren()
    const hf = store.doc.headerFooter ?? {}
    // Date: show, live or fixed
    const dateRow = div('ed-about-meta ed-headerfooter-row')
    dateRow.appendChild(check(t('Date'), hf.date?.show !== false, (v) => commitHF((h) => { (h.date ??= {}).show = v })))
    const mode = document.createElement('select')
    for (const [v, label] of [['live', t('Updates automatically')], ['fixed', t('Fixed')]] as const) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = label
      mode.appendChild(o)
    }
    mode.value = hf.date?.fixed ? 'fixed' : 'live'
    const fixed = document.createElement('input')
    fixed.type = 'text'
    fixed.value = hf.date?.fixed ?? ''
    fixed.placeholder = new Date().toLocaleDateString()
    fixed.hidden = mode.value !== 'fixed'
    fixed.setAttribute('aria-label', t('Fixed date'))
    mode.addEventListener('change', () => {
      if (mode.value === 'live') commitHF((h) => { if (h.date) delete h.date.fixed })
      else { fixed.hidden = false; fixed.value ||= new Date().toLocaleDateString(); commitHF((h) => { (h.date ??= {}).fixed = fixed.value }) }
    })
    fixed.addEventListener('change', () => commitHF((h) => { (h.date ??= {}).fixed = fixed.value.trim() || new Date().toLocaleDateString() }))
    dateRow.append(mode, fixed)
    box.appendChild(dateRow)
    // Slide number
    const numRow = div('ed-about-meta ed-headerfooter-row')
    numRow.appendChild(check(t('Slide number'), hf.slideNumber?.show !== false, (v) => commitHF((h) => { (h.slideNumber ??= {}).show = v })))
    box.appendChild(numRow)
    // Footer: show + text
    const footRow = div('ed-about-meta ed-headerfooter-row')
    footRow.appendChild(check(t('Footer'), hf.footer?.show !== false, (v) => commitHF((h) => { (h.footer ??= {}).show = v })))
    const text = document.createElement('input')
    text.type = 'text'
    text.value = hf.footer?.text ?? ''
    text.placeholder = t('Footer text — {{footer}}')
    text.setAttribute('aria-label', t('Footer text'))
    text.addEventListener('change', () => commitHF((h) => { (h.footer ??= {}).text = text.value }))
    footRow.appendChild(text)
    box.appendChild(footRow)
    box.appendChild(check(t('Don’t show on title slides'), !!hf.hideOnTitle, (v) => commitHF((h) => { h.hideOnTitle = v })))
  }
  fill()
  let sig = JSON.stringify(store.doc.headerFooter ?? {})
  const off = store.on('doc', () => {
    if (!box.isConnected) { off?.(); return }
    const next = JSON.stringify(store.doc.headerFooter ?? {})
    if (next !== sig) { sig = next; fill() }
  })
}

/** "Clean up" — what model.ts's `unusedContent` finds, and a "Remove
 *  unused…" button. Explicit and undoable, never automatic on save: pruning
 *  is the one direction that loses data (docs/DECISIONS.md 2026-09-28).
 *  Refreshes itself on 'doc' (a keyboard undo, a type deleted elsewhere)
 *  while it is on screen. */
function renderCleanup(host: HTMLElement, store: Store): void {
  const title = document.createElement('div')
  title.className = 'ed-about-h'
  title.textContent = t('Clean up')
  const row = div('ed-cleanup-row')
  host.append(title, row)
  if (isDesktopShell() && window.slidomingoDesktop?.optimizePictures) host.appendChild(optimizePicturesRow(store))

  const fill = () => {
    row.replaceChildren()
    const found = unusedContent(store.doc)
    const note = document.createElement('p')
    note.className = 'ed-hint'
    row.appendChild(note)
    const templ = !!(store.doc.template || store.doc.templateId)
    if (!found.layouts.length && !found.assetKeys.length) {
      note.textContent = templ
        ? t('Nothing unused. A layout keeps all its slide types, even ones no slide uses.')
        : t('Nothing unused.')
      return
    }
    const parts: string[] = []
    if (found.layouts.length) parts.push(t('{n} unused slide type(s)', { n: found.layouts.length }))
    if (found.assetKeys.length) parts.push(t('{n} unused picture(s) or file(s)', { n: found.assetKeys.length }))
    const kb = Math.max(1, Math.round(found.bytes / 1024))
    const size = kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'
    const summary = `${parts.join(' · ')} (≈${size})`
    note.textContent = summary
    row.appendChild(btn(ICONS.trash, t('Remove unused…'), () => {
      const now = unusedContent(store.doc)
      const names = now.layouts.map((l) => '• ' + (l.name || t('Untitled'))).join('\n')
      const message = t('Remove content nothing in this document uses? Slides and what they show are not touched. You can undo this.')
        + '\n\n' + summary + (names ? '\n\n' + names : '')
      if (!window.confirm(message)) return
      store.commit(() => { removeUnusedContent(store.doc) })
      toastWithUndo(store, t('Removed unused content (≈{size})', { size }))
    }))
  }
  fill()

  let pending = 0
  const off = store.on('doc', () => {
    if (!row.isConnected) { off(); return }
    clearTimeout(pending)
    pending = window.setTimeout(() => { if (row.isConnected) fill() }, 150)
  })
}

const formatSize = (bytes: number) => {
  const kb = Math.max(1, Math.round(bytes / 1024))
  return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'
}

/**
 * "Optimize pictures (lossless)…" — desktop only (desktop/src/main/
 * pictures.ts does the work, off the page's thread and outside the shell, so
 * the file's runtime does not grow). Every JPEG/PNG in the document is
 * offered; main returns only the ones it made smaller AND verified
 * pixel-identical, and they land as ONE undoable commit. Never automatic.
 */
function optimizePicturesRow(store: Store): HTMLElement {
  const box = div('ed-cleanup-row')
  const note = document.createElement('p')
  note.className = 'ed-hint'
  const run = btn(ICONS.image, t('Optimize pictures (lossless)…'), () => void go())
  box.append(run, note)
  const go = async () => {
    const api = window.slidomingoDesktop
    if (!api?.optimizePictures || formatGate()) return
    const uris = embeddedRasterPictures(store.doc)
    if (!uris.length) { note.textContent = t('No JPEG or PNG pictures to optimize.'); return }
    if (!window.confirm(t('Make this document’s JPEG and PNG pictures smaller without changing a single pixel? Each result is checked against the original and kept only if it is smaller and identical. Large pictures can take a while. You can undo this.'))) return
    run.setAttribute('disabled', '')
    note.textContent = t('Optimizing pictures… {done}/{total}', { done: 0, total: uris.length })
    const off = api.onOptimizeProgress?.((p) => { note.textContent = t('Optimizing pictures… {done}/{total}', p) })
    let res: Awaited<ReturnType<NonNullable<typeof api.optimizePictures>>> = null
    try { res = await api.optimizePictures(uris) } finally { off?.(); run.removeAttribute('disabled') }
    if (!res) { note.textContent = t('Couldn’t optimize the pictures.'); return }
    if (!res.length) { note.textContent = t('These pictures are already as small as a lossless optimization can make them.'); return }
    const map = new Map(res.map((r) => [r.uri, r.next]))
    const saved = res.reduce((n, r) => n + r.saved, 0)
    store.commit(() => { replaceDocStrings(store.doc, map) })
    const message = t('Optimized {n} picture(s) — {size} smaller', { n: res.length, size: formatSize(saved) })
    note.textContent = message
    toastWithUndo(store, message)
  }
  return box
}

// tiny DOM helpers (each editor/*.ts file keeps its own copy — see editor.ts)
function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}
function btn(icon: string, label: string, onClick: (ev: MouseEvent) => void, title?: string): HTMLElement {
  const b = document.createElement('button')
  b.className = 'ed-btn'
  b.innerHTML = label ? `${icon}<span>${label}</span>` : icon
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}
