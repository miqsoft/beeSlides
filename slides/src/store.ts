// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
import { inLinearFlow, resolveAgentSlide, REUSABLE_OBJECT_CANVAS, syncContentRequires } from './model'
import type { IconLook, SlidomingoDoc, Slide, SlideElement } from './model'
import { ActionLog, jsonEqual, type ElementChange } from './actionlog'
import { scheduleBlobSweep } from './bloburls'
import { jsonClone } from './jsonclone.ts'

export type StoreEvent =
  | 'doc'        // any document mutation
  | 'slides'     // slide list changed (add/remove/reorder) — sidebar rebuild
  | 'current'    // current slide switched
  | 'selection'  // selected element ids changed
  | 'dirty'      // dirty flag changed
  | 'locks'      // MCP session lock table changed — sidebar/sorter badge refresh
  | 'look'       // icon sets: the style the icons are shown in changed (iconLook)

type Listener = () => void

/** How long a slide stays locked with no write from its owning session before
 *  the lock is auto-released — see the SlideLock docblock below. */
const LOCK_IDLE_MS = 8 * 60 * 1000
/** How often the idle sweep runs — needn't be fine-grained; a lock outliving
 *  its owner's last write by up to this much longer than LOCK_IDLE_MS is
 *  harmless. */
const LOCK_SWEEP_MS = 30 * 1000

/** One slide's mutual-exclusion lock, held by exactly one MCP session (a
 *  terminal tab's `claude` process) at a time — see docs/DECISIONS.md's
 *  parallel-claude-sessions entry. `at` is refreshed on every write from the
 *  owning session and drives the idle sweep. Never part of `doc` — this is
 *  in-memory, per-window coordination, not document content. */
export type SlideLock = { sessionId: string; at: number }

export type ViewSnapshot = {
  slideIds: string[]
  currentIndex: number
  currentId?: string
}

type HistoryEntry = {
  /** a LIGHT serialized doc: see SnapshotAssets */
  doc: string
  view: ViewSnapshot
  /** the SnapshotAssets ids `doc` refers to */
  refs: string[]
}

const MAX_UNDO = 100

/** `data:` strings at least this long go into the snapshot table; shorter
 *  ones (tiny inline icons) cost less to copy than to look up. */
const SNAPSHOT_REF_MIN = 1024
/** What a snapshot string holding a table ref starts with. Private to the
 *  in-memory undo/redo stack — never written to a file, never a
 *  `beeslides-store:` ref (a doc may hold one of those, dangling or not, and
 *  it must come back exactly as it was). A doc string that itself starts
 *  with NUL is escaped by doubling that NUL, so the mapping is exact. */
const SNAP_NUL = '\u0000'
const SNAP_REF = SNAP_NUL + 'ref:'

/**
 * The bytes the undo/redo stack would otherwise copy on every edit.
 *
 * Pictures, video and fonts live in the live document as `data:` strings.
 * Every edit snapshots the whole doc; with 20 MB of pictures that was ~35 ms
 * per edit and up to 100 × 20 MB of strings on the undo stack. A snapshot now
 * holds a short ref per `data:` string and this table holds each distinct
 * string ONCE — the same string instance the live doc holds, so the table
 * costs nothing extra while the picture is in the doc, and keeps a deleted
 * picture only while some undo/redo entry still refers to it (`prune`).
 * Parsing a snapshot hands the doc that same instance back, which also makes
 * an unchanged picture compare equal by identity in the action-log diff.
 */
class SnapshotAssets {
  private idOf = new Map<string, string>()
  private uriOf = new Map<string, string>()
  private next = 0

  /** JSON.stringify(doc) with each big `data:` string swapped for a ref;
   *  `refs` collects the ids it used. */
  stringify(doc: unknown, refs: Set<string>): string {
    return JSON.stringify(doc, (_key, v: unknown) => {
      if (typeof v !== 'string') return v
      if (v.length >= SNAPSHOT_REF_MIN && v.startsWith('data:')) {
        let id = this.idOf.get(v)
        if (id === undefined) {
          id = (this.next++).toString(36)
          this.idOf.set(v, id)
          this.uriOf.set(id, v)
        }
        refs.add(id)
        return SNAP_REF + id
      }
      return v.startsWith(SNAP_NUL) ? SNAP_NUL + v : v
    })
  }

  /** The inverse of stringify. A plain parse plus an in-place walk: a
   *  JSON.parse reviver costs ~7× the parse itself. */
  parse<T>(json: string): T {
    const out = JSON.parse(json) as unknown
    // the escape is written as the 6-character JSON escape: no NUL, nothing to do
    if (json.includes('\\u0000')) this.unref(out)
    return out as T
  }

  private unstring(v: string): string {
    if (!v.startsWith(SNAP_REF)) return v.slice(SNAP_NUL.length)
    const uri = this.uriOf.get(v.slice(SNAP_REF.length))
    if (uri === undefined) throw new Error('undo snapshot refers to a dropped asset')
    return uri
  }

  private unref(node: unknown) {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v: unknown = node[i]
        if (typeof v === 'string') { if (v.charCodeAt(0) === 0) node[i] = this.unstring(v) }
        else if (v && typeof v === 'object') this.unref(v)
      }
      return
    }
    const obj = node as Record<string, unknown>
    for (const k of Object.keys(obj)) {
      // an own "__proto__" key (JSON.parse makes one) is not reachable as obj[k]
      const proto = k === '__proto__'
      const v = proto ? Object.getOwnPropertyDescriptor(obj, k)?.value : obj[k]
      if (typeof v === 'string') {
        if (v.charCodeAt(0) !== 0) continue
        const next = this.unstring(v)
        if (proto) Object.defineProperty(obj, k, { value: next, writable: true, enumerable: true, configurable: true })
        else obj[k] = next
      } else if (v && typeof v === 'object') this.unref(v)
    }
  }

  /** Forget every id not in `keep`. */
  prune(keep: Set<string>) {
    for (const [id, uri] of this.uriOf) {
      if (keep.has(id)) continue
      this.uriOf.delete(id)
      this.idOf.delete(uri)
    }
  }
}

/** Central state: document, current slide, selection, undo/redo, dirty flag. */
export class Store {
  doc: SlidomingoDoc
  currentIndex = 0
  selection: string[] = []
  dirty = false
  /** editor-only: which showOnHover set the canvas previews (never saved) */
  hoverPreview: string | null = null
  /** editor-only, icon sets: the style (`IconLook.id`) the canvas, the slide
   *  list and the panel show the icons in; null = the drawing itself. Kept
   *  across slides (never saved) — read it through `shownLook`. */
  iconLook: string | null = null
  /** editor-only: the language the Layout Manager previews {{term:…}} and
   *  dates in (its EN | DE switch); null = the document's (never saved) */
  termPreview: string | null = null

  /**
   * Editor-only: which non-ordinary surface `store.slide` is redirected to
   * — a `doc.layouts` entry (Slide Master mode; since the 2026-09-20
   * redesign this is the ONLY slide-type editing surface — a former
   * "master" is just another `doc.layouts` entry, so there is no separate
   * building-blocks surface anymore). While set, the `slide` getter returns
   * that surface instead of `doc.slides[currentIndex]` — every call site
   * that already reads `store.slide` (canvas, panels, most of editor.ts)
   * edits it transparently, with no changes needed. Never saved.
   *
   * `kind: 'reusableObject'` redirects to a `doc.reusableObjects` entry —
   * its own unbounded authoring canvas in the Layout Manager's Reusable
   * objects tab, with no live-link concept (unlike layout, nothing ever
   * resyncs from it — see editor.ts's syncLayoutInstances early return).
   */
  editingSurface: null | { kind: 'layout'; id: string } | { kind: 'reusableObject'; id: string } = null

  /**
   * Editor-only live-resync baseline for the open `editingSurface` — see
   * editor.ts's `syncLayoutInstances`. Seeded by `enterSurface`/`exitSurface`
   * from the surface's content AT ENTRY (before any edit), so a resync
   * triggered by the very first edit after entering can still recognise an
   * element that edit just deleted as surface-owned (the zombie-element
   * fix). Never saved.
   */
  surfaceSyncSig = ''
  surfaceSyncIds = new Set<string>()

  /**
   * Editor-only mutual-exclusion locks for the desktop shell's parallel
   * `claude` terminal sessions (see desktop/src/main/terminalPanel.ts and
   * docs/DECISIONS.md's parallel-claude-sessions entry): slideId -> the
   * session currently allowed to write it. This is deliberately NOT a CRDT
   * or a merge engine — every write still funnels through this one Store, so
   * a lock table plus a gate at the write chokepoint (editor.ts's
   * applyAgentAction/applyExternalSlideWrite) is enough to stop two parallel
   * sessions from clobbering each other's edits to the same slide. Never
   * saved, never touches `doc`, never enters undo/redo. Web/single-session
   * builds simply never call acquireLock, so this stays permanently empty
   * there — no behavior change outside the desktop shell.
   */
  locks = new Map<string, SlideLock>()
  private lockSweepTimer: ReturnType<typeof setInterval> | null = null

  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  /** the bytes the two stacks refer to — see SnapshotAssets */
  private snapAssets = new SnapshotAssets()
  private listeners = new Map<StoreEvent, Set<Listener>>()

  /** read-only viewer: block user edits (commit) while remote ops — which
   *  apply via the session's direct state.apply + emit, NOT commit — still
   *  flow, so a live viewer sees updates but can never author them. */
  readOnly = false

  /**
   * Per-element change ledger, recorded alongside (not instead of) the
   * undo/redo stacks above — see actionlog.ts. Deliberately decoupled:
   * undo()/redo()/replaceDoc() never add entries here (only checkpoint() +
   * recordAction() pairs do), so a per-object revert is always a NEW commit,
   * never a history rewrite, and global ⌘Z stays completely unaffected by it.
   */
  actionLog = new ActionLog()

  constructor(doc: SlidomingoDoc) {
    this.doc = doc
    // `requires: ['rich-text' | 'table-merge']` follows the content (model.ts) — on load too,
    // so a file written by a tool that forgot it is declared before any save.
    syncContentRequires(doc)
    void this.actionLog.hydrate(doc.docId, () => this.doc)
  }

  /** The icon style being shown, while it still exists (undo can remove it). */
  get shownLook(): IconLook | undefined {
    if (!this.iconLook || this.doc.kind !== 'iconset') return undefined
    return this.doc.iconset?.variants?.find((l) => l.id === this.iconLook)
  }

  /** Show the icons in a style (null = the drawing itself). */
  showLook(id: string | null) {
    if (id === this.iconLook) return
    this.iconLook = id
    this.emit('look')
  }

  on(event: StoreEvent, fn: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn)
    return () => this.listeners.get(event)!.delete(fn)
  }

  emit(event: StoreEvent) {
    this.listeners.get(event)?.forEach((fn) => fn())
  }

  // --- slide locks (parallel-claude-sessions mutual exclusion) --------------

  lockOwner(slideId: string): string | undefined {
    return this.locks.get(slideId)?.sessionId
  }

  private ensureLockSweep() {
    if (this.lockSweepTimer) return
    // Node timers (this runs in an Electron renderer, but setInterval here is
    // the plain DOM one) don't need unref-style cleanup for a per-window
    // Store that lives as long as the document window itself.
    this.lockSweepTimer = setInterval(() => this.sweepIdleLocks(), LOCK_SWEEP_MS)
  }

  private sweepIdleLocks() {
    const cutoff = Date.now() - LOCK_IDLE_MS
    let changed = false
    for (const [slideId, lock] of this.locks) {
      if (lock.at < cutoff) { this.locks.delete(slideId); changed = true }
    }
    if (changed) this.emit('locks')
  }

  /**
   * Acquire (or refresh) `slideId`'s lock for `sessionId` — the gate every
   * lock-triggering MCP write verb calls before it mutates anything (see
   * editor.ts's applyAgentAction/applyExternalSlideWrite). Returns true if
   * the caller now holds (or already held) the lock, meaning the write may
   * proceed. Since 2026-10-06 (docs/DECISIONS.md) this NEVER refuses: several
   * sessions may work on one slide, and the lock merely records the latest
   * writer for the sidebar badge. (The boolean return is kept so the callers'
   * refusal branches stay valid should exclusivity ever come back.)
   */
  acquireLock(slideId: string, sessionId: string): boolean {
    this.ensureLockSweep()
    this.locks.set(slideId, { sessionId, at: Date.now() })
    this.emit('locks')
    return true
  }

  /**
   * Explicit release (the `release_slide` MCP verb). Returns true if the lock
   * was released (or the slide was not locked at all — a harmless no-op);
   * false if a DIFFERENT session holds it, meaning the caller must refuse —
   * a session can only ever release a lock it owns.
   */
  releaseLock(slideId: string, sessionId: string): boolean {
    const existing = this.locks.get(slideId)
    if (!existing) return true
    if (existing.sessionId !== sessionId) return false
    this.locks.delete(slideId)
    this.emit('locks')
    return true
  }

  /** Releases every lock `sessionId` holds — called the moment that
   *  session's terminal tab closes (desktop's onAgentSessionClosed), so a
   *  slide it was working on is immediately free for another session rather
   *  than waiting out the idle timeout. */
  releaseSessionLocks(sessionId: string) {
    let changed = false
    for (const [slideId, lock] of this.locks) {
      if (lock.sessionId === sessionId) { this.locks.delete(slideId); changed = true }
    }
    if (changed) this.emit('locks')
  }

  get slide(): Slide {
    const surface = this.editingSurface
    if (surface?.kind === 'layout') {
      const layout = this.doc.layouts?.find((l) => l.id === surface.id)
      if (layout) return layout
    }
    if (surface?.kind === 'reusableObject') {
      const obj = this.doc.reusableObjects?.find((o) => o.id === surface.id)
      if (obj) return obj
    }
    return this.doc.slides[this.currentIndex]
  }

  private enterSurface(next: NonNullable<Store['editingSurface']>) {
    this.editingSurface = next
    let content: Slide | undefined
    if (next.kind === 'layout') {
      content = this.doc.layouts?.find((l) => l.id === next.id)
    } else {
      content = this.doc.reusableObjects?.find((o) => o.id === next.id)
    }
    this.surfaceSyncSig = content ? JSON.stringify(content) : ''
    this.surfaceSyncIds = new Set(content?.elements.map((e) => e.id) ?? [])
    this.selection = []
    this.hoverPreview = null
    this.emit('current')
    this.emit('selection')
  }

  private exitSurface() {
    if (this.editingSurface == null) return
    this.editingSurface = null
    this.surfaceSyncSig = ''
    this.surfaceSyncIds = new Set()
    this.selection = []
    this.hoverPreview = null
    this.emit('current')
    this.emit('selection')
  }

  /** Enter Slide Master mode: `store.slide` now returns this layout. */
  enterLayoutEdit(id: string) {
    if (this.editingSurface?.kind === 'layout' && this.editingSurface.id === id) return
    this.enterSurface({ kind: 'layout', id })
  }

  /** Leave Slide Master mode: `store.slide` returns the current slide again. */
  exitLayoutEdit() {
    if (this.editingSurface?.kind !== 'layout') return
    this.exitSurface()
  }

  /** Enter reusable-object editing (Layout Manager's Objects tab): `store.slide`
   *  now returns the given `doc.reusableObjects` entry. */
  enterReusableObjectEdit(id: string) {
    if (this.editingSurface?.kind === 'reusableObject' && this.editingSurface.id === id) return
    this.enterSurface({ kind: 'reusableObject', id })
  }

  /** Leave reusable-object editing: `store.slide` returns the current slide again. */
  exitReusableObjectEdit() {
    if (this.editingSurface?.kind !== 'reusableObject') return
    this.exitSurface()
  }

  element(id: string): SlideElement | undefined {
    return this.slide.elements.find((e) => e.id === id)
  }

  get selectedElements(): SlideElement[] {
    return this.selection
      .map((id) => this.element(id))
      .filter((e): e is SlideElement => !!e)
  }

  /**
   * Replace the whole document (AI/JSON round-trip import). Undoable —
   * ⌘Z restores the previous document wholesale.
   */
  replaceDoc(next: SlidomingoDoc) {
    this.checkpoint()
    this.pendingBeforeJson = null // see checkpoint()/recordAction() — a whole-doc
    // replacement is deliberately NOT action-logged (only commit()/edit-burst
    // pairs are); dropping the pending snapshot avoids it being wrongly
    // attributed to whatever the next real commit turns out to be.
    this.doc = next
    syncContentRequires(next)
    this.currentIndex = 0
    this.selection = []
    this.setDirty(true)
    this.actionLog.clear()
    void this.actionLog.hydrate(next.docId, () => this.doc)
    this.emit('slides')
    this.emit('current')
    this.emit('selection')
    this.emit('doc')
    // the previous document's pictures: release their blob: URLs (render.ts)
    scheduleBlobSweep(() => this.doc)
  }

  // --- history ------------------------------------------------------------

  /** The light snapshot (see SnapshotAssets) taken by the last checkpoint(),
   *  awaiting a matching recordAction() call — see checkpoint()/recordAction(). */
  private pendingBeforeJson: string | null = null
  /** the ids pendingBeforeJson refers to (kept alive until it is consumed) */
  private pendingRefs: string[] = []

  /** An agent program's run (the `execute` tool): while set, only its first
   *  checkpoint reaches the undo stack, so the whole run is ONE undo step —
   *  and rollbackUndoGroup can take it back. */
  private undoGroup: { entry: HistoryEntry | null } | null = null

  beginUndoGroup() {
    this.undoGroup = { entry: null }
  }

  endUndoGroup() {
    this.undoGroup = null
  }

  /** Back to the document as it was at beginUndoGroup, leaving no undo or
   *  redo step behind. False when an undo/redo since then moved past it. */
  rollbackUndoGroup(): boolean {
    const entry = this.undoGroup?.entry
    this.undoGroup = null
    if (!entry) return true
    if (this.undoStack[this.undoStack.length - 1] !== entry) return false
    this.undo()
    this.redoStack.pop()
    this.pruneSnapshotAssets()
    return true
  }

  /** Snapshot current doc state onto the undo stack. Call BEFORE a mutation. */
  checkpoint() {
    const refs = new Set<string>()
    this.pendingBeforeJson = this.snapAssets.stringify(this.doc, refs)
    this.pendingRefs = [...refs]
    // inside a group, its first snapshot covers this edit — unless an undo
    // took that snapshot off the stack meanwhile
    const group = this.undoGroup
    if (group?.entry && this.undoStack[this.undoStack.length - 1] === group.entry) return
    this.undoStack.push({ doc: this.pendingBeforeJson, view: this.captureView(), refs: this.pendingRefs })
    if (group) group.entry = this.undoStack[this.undoStack.length - 1]
    let dropped = this.redoStack.length > 0
    if (this.undoStack.length > MAX_UNDO) { this.undoStack.shift(); dropped = true }
    this.redoStack.length = 0
    if (dropped) this.pruneSnapshotAssets()
  }

  /** Let go of the bytes no undo/redo entry (nor the pending snapshot) refers
   *  to any more. Called whenever entries leave the stacks for good. */
  private pruneSnapshotAssets() {
    const keep = new Set<string>(this.pendingRefs)
    for (const entry of this.undoStack) for (const id of entry.refs) keep.add(id)
    for (const entry of this.redoStack) for (const id of entry.refs) keep.add(id)
    this.snapAssets.prune(keep)
  }

  /**
   * Close out the action-log side of a checkpoint()'d edit: diff the doc as
   * it stood at the last checkpoint() against its live state now, and record
   * one ActionRecord if anything on an element actually changed.
   *
   * commit() calls this itself. The panel/notes-pane burst editors (which
   * checkpoint() once per burst but touch() on every keystroke) call it
   * ONLY when the burst settles (`final`) — recording per-keystroke would
   * flood the log with noise instead of one "text edited" entry per edit.
   * This is the reason the action log hooks the checkpoint()/settle PAIR
   * rather than commit() alone: most panel field edits (color, position,
   * fill…) never go through commit() at all.
   */
  recordAction() {
    const before = this.pendingBeforeJson
    this.pendingBeforeJson = null
    this.pendingRefs = []
    if (before == null) return
    // parsed against the table: the diff and the log see the real pictures
    // (the same string instances the live doc holds), never a ref
    let beforeDoc: SlidomingoDoc
    try { beforeDoc = this.snapAssets.parse<SlidomingoDoc>(before) } catch { return }
    this.actionLog.record(beforeDoc, this.doc)
  }

  /** checkpoint() + mutate + notify, in one call. */
  commit(mutate: () => void, event: StoreEvent = 'doc') {
    if (this.readOnly) return // live viewer — user edits are inert
    const view = this.captureView()
    this.checkpoint()
    mutate()
    this.recordAction()
    const { currentChanged, selectionChanged } = this.reconcileView(view)
    this.touch(event)
    if (currentChanged) this.emit('current')
    if (selectionChanged) this.emit('selection')
  }

  /**
   * A slide-list mutation and the view that points into it are one state
   * transition. Keep the same slide by id when it survives; otherwise choose
   * the next surviving neighbour (or the previous one at the end). This runs
   * before touch(), so no redraw listener can observe an invalid slide index.
   */
  captureView(): ViewSnapshot {
    return {
      slideIds: this.doc.slides.map((slide) => slide.id),
      currentIndex: this.currentIndex,
      currentId: this.doc.slides[this.currentIndex]?.id,
    }
  }

  reconcileView(
    before: ViewSnapshot,
    preferred: ViewSnapshot = before,
  ): { currentChanged: boolean; selectionChanged: boolean } {
    const slides = this.doc.slides
    const byId = new Map(slides.map((slide, index) => [slide.id, index]))

    let nextIndex = preferred.currentId == null ? undefined : byId.get(preferred.currentId)
    if (nextIndex == null) {
      const neighbourId = preferred.slideIds.slice(preferred.currentIndex + 1).find((id) => byId.has(id))
        ?? preferred.slideIds.slice(0, preferred.currentIndex).reverse().find((id) => byId.has(id))
      nextIndex = neighbourId == null
        ? Math.max(0, Math.min(preferred.currentIndex, slides.length - 1))
        : byId.get(neighbourId)!
    }

    this.currentIndex = nextIndex
    const currentChanged = slides[nextIndex]?.id !== before.currentId
    // `this.slide`, not `slides[nextIndex]` — in Slide Master mode the
    // selection lives on the edited layout, not the underlying slide behind
    // the sidebar (which a resync in the same commit did not touch).
    const selection = currentChanged
      ? []
      : this.selection.filter((id) => this.slide.elements.some((element) => element.id === id))
    const selectionChanged = currentChanged
      || selection.length !== this.selection.length
      || selection.some((id, index) => id !== this.selection[index])
    this.selection = selection
    if (currentChanged) this.hoverPreview = null
    return { currentChanged, selectionChanged }
  }

  /** Mark dirty and notify after an in-place mutation (no checkpoint). */
  touch(event: StoreEvent = 'doc') {
    this.doc.modified = new Date().toISOString()
    // Every local mutation lands here (commit and the burst editors alike),
    // so this is where the content reader gates (rich text, merged cells) are kept in step with the
    // text — before any save, autosave or copy can read the document.
    syncContentRequires(this.doc)
    this.setDirty(true)
    this.emit('doc')
    if (event !== 'doc') this.emit(event)
    scheduleBlobSweep(() => this.doc) // a removed picture's blob: URL
  }

  /**
   * The newest undo snapshot in which any of `ids` (on the open surface)
   * looks different from now — frame, text or font size. It is what Tidy
   * compares against to learn what the user just changed about the
   * selection. Each entry is a whole serialized (light) doc, so the walk stops
   * after `limit` parses.
   */
  baselineFor(ids: string[], limit = 20): SlidomingoDoc | null {
    const slideId = this.slide.id
    const now = this.slide.elements.filter((e) => ids.includes(e.id))
    for (let i = this.undoStack.length - 1, n = 0; i >= 0 && n < limit; i--, n++) {
      let doc: SlidomingoDoc
      try { doc = this.snapAssets.parse<SlidomingoDoc>(this.undoStack[i].doc) } catch { continue }
      const slide = resolveAgentSlide(doc, slideId)?.slide
      if (!slide) return null // the surface did not exist yet: nothing older helps
      const differs = now.some((cur) => {
        const was = slide.elements.find((e) => e.id === cur.id)
        if (!was) return false
        if (was.x !== cur.x || was.y !== cur.y || was.w !== cur.w || was.h !== cur.h) return true
        return was.type === 'text' && cur.type === 'text' && (was.html !== cur.html || was.fontSize !== cur.fontSize)
      })
      if (differs) return doc
    }
    return null
  }

  undo() { this.restore(this.undoStack, this.redoStack) }
  redo() { this.restore(this.redoStack, this.undoStack) }

  private restore(from: HistoryEntry[], to: HistoryEntry[]) {
    const entry = from[from.length - 1]
    if (!entry) return
    const next = this.snapAssets.parse<SlidomingoDoc>(entry.doc)
    from.pop()
    const before = this.captureView()
    const refs = new Set<string>()
    to.push({ doc: this.snapAssets.stringify(this.doc, refs), view: before, refs: [...refs] })
    this.doc = next
    this.reconcileView(before, entry.view)
    this.setDirty(true)
    this.emit('doc')
    this.emit('slides')
    this.emit('current')
    this.emit('selection')
  }

  setDirty(dirty: boolean) {
    if (this.dirty === dirty) return
    this.dirty = dirty
    this.emit('dirty')
  }

  // --- navigation & selection ----------------------------------------------

  goTo(index: number) {
    const clamped = Math.max(0, Math.min(index, this.doc.slides.length - 1))
    if (clamped === this.currentIndex) return
    this.currentIndex = clamped
    this.selection = []
    this.hoverPreview = null
    this.emit('current')
    this.emit('selection')
  }

  /** Step forward/back one slide, skipping interactive states (stateOf) the way
   *  linear presentation does. dir = +1 next, -1 prev. */
  goToLinear(dir: 1 | -1) {
    const slides = this.doc.slides
    for (let i = this.currentIndex + dir; i >= 0 && i < slides.length; i += dir) {
      if (inLinearFlow(slides[i])) { this.goTo(i); return }
    }
  }

  select(ids: string[]) {
    this.selection = ids
    this.emit('selection')
  }

  // --- per-object revert ----------------------------------------------------

  private changeContainer(change: ElementChange): Slide | undefined {
    return change.isLayout
      ? this.doc.layouts?.find((l) => l.id === change.slideId)
      : this.doc.slides.find((s) => s.id === change.slideId)
  }

  /**
   * Is `change` still safe to revert? Re-validates that the element's LIVE
   * state still deep-equals what this change recorded as `after` (or, for a
   * change that deleted the element, that it is still gone) — if the user
   * did a global undo, another edit, or an earlier revert in between, the
   * match fails and this entry is simply no longer offered. No cross-
   * invalidation bookkeeping needed: staleness is self-detecting.
   */
  canRevert(change: ElementChange): boolean {
    const container = this.changeContainer(change)
    if (!container) return false
    const live = container.elements.find((e) => e.id === change.elementId)
    if (change.after) return !!live && jsonEqual(live, change.after)
    return !live
  }

  /**
   * Undo the last recorded change to ONE element, without touching anything
   * else edited since — the per-object counterpart to global ⌘Z. Applied as
   * an ordinary new commit() (itself action-logged), never by rewriting
   * history, so a global undo right after this undoes JUST the revert.
   * Returns false (no-op) when `change` fails canRevert().
   */
  revertChange(change: ElementChange): boolean {
    if (this.readOnly) return false
    if (!this.canRevert(change)) return false
    let applied = false
    this.commit(() => {
      const container = this.changeContainer(change)
      if (!container) return
      const idx = container.elements.findIndex((e) => e.id === change.elementId)
      if (change.before == null) {
        // this action CREATED the element — revert deletes it
        if (idx >= 0) { container.elements.splice(idx, 1); applied = true }
      } else if (change.after == null) {
        // this action DELETED the element — revert re-inserts it (appended;
        // its original position in the array isn't part of ElementChange)
        container.elements.push(jsonClone(change.before))
        applied = true
      } else if (idx >= 0) {
        // this action MODIFIED the element — revert restores the prior snapshot
        container.elements[idx] = jsonClone(change.before)
        applied = true
      }
    })
    return applied
  }
}

/** The canvas size to render/fit against right now: the generous fixed
 *  reusable-object stage while that surface is open, else the document's
 *  own page size. Canvas.ts's relayout()/armDraw() and render() read this
 *  instead of `store.doc.size` directly so an object being authored isn't
 *  invisibly clipped at the deck's (usually much smaller) slide box. */
export function effectiveCanvasSize(store: Store): { width: number; height: number } {
  return store.editingSurface?.kind === 'reusableObject' ? REUSABLE_OBJECT_CANVAS : store.doc.size
}
