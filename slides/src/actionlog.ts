// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Per-element change ledger: an append-only log of what changed on each
// element (before → after), recorded alongside — never instead of — the
// whole-document undo/redo stack in store.ts. It answers a question the undo
// stack can't: "what did the last edit TO THIS ELEMENT actually change?"
// which is what backs per-object revert (Store.revertChange), the panel's
// History section, and the "reapply this change to similar elements" tools
// (editor/reapplychange.ts, the apply_change_pattern agent verb).
//
// Deliberately decoupled from the undo stack: only Store.checkpoint() +
// recordAction() pairs add entries here (see store.ts) — undo()/redo()/
// replaceDoc() never do. A revert is always a NEW commit, so global ⌘Z stays
// completely unaffected and can itself undo a revert like any other edit.

import { uid } from './model'
import type { SlideElement, SlidomingoDoc } from './model'
import { appConfig } from '../../kernel/src/app.ts'
import { assetId } from '../../kernel/src/assetstore.ts'
import { isEncryptionActive } from './save'
import { t } from './i18n'

export interface ElementChange {
  elementId: string
  elementType: SlideElement['type']
  /** owning slide id, OR the `doc.layouts` entry id when `isLayout` */
  slideId: string
  isLayout: boolean
  /** null = this action CREATED the element */
  before: SlideElement | null
  /** null = this action DELETED the element */
  after: SlideElement | null
}

export interface ActionRecord {
  id: string
  docId: string
  at: number
  /** usually 1 change; can be >1 (align/distribute/group move, agent batch verbs) */
  changes: ElementChange[]
}

/** In-memory ring buffer size — mirrors store.ts's MAX_UNDO idea. */
const MAX_RECORDS = 500

// --- diffing ----------------------------------------------------------------

type Located = { el: SlideElement; slideId: string; isLayout: boolean }

/**
 * Element ids are NOT globally unique across a document — the SAME id
 * intentionally repeats across slides for morph pairing (`morphKey`'s
 * "duplicate-a-slide idiom"; the starter deck's whole "id-continuity"
 * showcase). So the diff/lookup index below is keyed by (slideId, elementId)
 * together, never by a bare element id — indexing by id alone would let one
 * slide's edit silently overwrite another same-id slide's entry in the map,
 * and later let a revert/reapply on THIS slide's element act on some OTHER
 * slide's edit to an element that just happens to share its id.
 */
function locKey(slideId: string, elementId: string): string {
  return `${slideId}\u0000${elementId}`
}

function indexElements(doc: Pick<SlidomingoDoc, 'slides' | 'layouts'>): Map<string, Located> {
  const map = new Map<string, Located>()
  for (const slide of doc.slides) {
    for (const el of slide.elements) map.set(locKey(slide.id, el.id), { el, slideId: slide.id, isLayout: false })
  }
  for (const layout of doc.layouts ?? []) {
    for (const el of layout.elements) map.set(locKey(layout.id, el.id), { el, slideId: layout.id, isLayout: true })
  }
  return map
}

function diffDoc(before: SlidomingoDoc, after: SlidomingoDoc): ElementChange[] {
  const beforeIndex = indexElements(before)
  // `after` is `this.doc` itself — still LIVE and mutable (the next edit
  // keeps writing through it). `before`'s elements are already safe (they
  // came out of a fresh parse in Store.recordAction(), never touched again), but
  // every `after` snapshot stored on a change MUST be cloned here — storing
  // the live reference would make an OLDER change's `after` silently drift
  // to match whatever the element becomes on the NEXT edit, and two changes
  // to the same element would end up pointing at the identical object.
  const afterIndex = indexElements(after)
  const keys = new Set([...beforeIndex.keys(), ...afterIndex.keys()])
  const changes: ElementChange[] = []
  for (const key of keys) {
    const b = beforeIndex.get(key)
    const a = afterIndex.get(key)
    if (b && a) {
      if (jsonEqual(b.el, a.el)) continue
      changes.push({ elementId: a.el.id, elementType: a.el.type, slideId: a.slideId, isLayout: a.isLayout, before: b.el, after: clone(a.el) })
    } else if (b && !a) {
      changes.push({ elementId: b.el.id, elementType: b.el.type, slideId: b.slideId, isLayout: b.isLayout, before: b.el, after: null })
    } else if (a && !b) {
      changes.push({ elementId: a.el.id, elementType: a.el.type, slideId: a.slideId, isLayout: a.isLayout, before: null, after: clone(a.el) })
    }
  }
  return changes
}

// --- reapply -----------------------------------------------------------------

/**
 * Fields a "reapply this change to similar elements" tool should NEVER copy:
 * identity/relationship fields (id/morphId/groupId — cloning these would
 * merge or mis-pair unrelated elements), position (x/y — copying identical
 * coordinates onto multiple elements stacks them, almost never the intent),
 * and `type` (the caller already restricts targets to the same type, so
 * copying it is meaningless at best).
 */
const NEVER_REAPPLY = new Set(['id', 'morphId', 'groupId', 'x', 'y', 'type'])

/**
 * The fields a change actually touched — union of `before`/`after` keys
 * where the value differs. Shared by computeReapplicablePatch (below) and
 * the recent_changes agent verb's compact reporting (editor.ts).
 */
export function changedFieldKeys(change: ElementChange): string[] {
  const before = (change.before ?? {}) as Record<string, unknown>
  const after = (change.after ?? {}) as Record<string, unknown>
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
}

/**
 * The changed fields of `change`, trimmed to just those keys' before/after
 * values — NOT the full element snapshots. Backs recent_changes so an agent
 * sees what actually happened without re-deriving it from two full elements.
 */
export function compactChange(change: ElementChange): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const beforeFull = (change.before ?? {}) as Record<string, unknown>
  const afterFull = (change.after ?? {}) as Record<string, unknown>
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const key of changedFieldKeys(change)) {
    before[key] = beforeFull[key]
    after[key] = afterFull[key]
  }
  return { before, after }
}

/**
 * What a "reapply this change" tool would write onto a target element: the
 * changed fields of `change.after`, minus NEVER_REAPPLY. Returns null when
 * there is no `after` (the change was a deletion — nothing to reapply) or
 * nothing survives the exclusions. Shared by editor/reapplychange.ts (the
 * manual armed tool) and the apply_change_pattern agent verb, so both apply
 * identical patches for identical source changes.
 */
export function computeReapplicablePatch(change: ElementChange): Partial<SlideElement> | null {
  if (!change.after) return null
  const patch: Record<string, unknown> = {}
  for (const key of changedFieldKeys(change)) {
    if (NEVER_REAPPLY.has(key)) continue
    patch[key] = (change.after as unknown as Record<string, unknown>)[key]
  }
  return Object.keys(patch).length ? (patch as Partial<SlideElement>) : null
}

/** JSON's value for a member: what JSON.stringify writes (undefined = the key
 *  is left out). Only plain JSON data is expected here. */
const jsonValue = (v: unknown): unknown =>
  typeof v === 'number' ? (Number.isFinite(v) ? v : null)
    : typeof v === 'function' || typeof v === 'symbol' ? undefined
      : v

/**
 * Whether two JSON-shaped values serialize to the same JSON, up to key order
 * — without serializing them. An element holding a picture carries its whole
 * `data:` string; stringifying both sides of every image element on every
 * edit copied all the deck's pictures twice per edit. Strings compare with
 * `===`, which is instant for the same instance (Store hands the snapshot
 * side the live doc's own picture strings).
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  a = jsonValue(a)
  b = jsonValue(b)
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      // in an array a dropped value is written as null
      if (!jsonEqual(jsonValue(a[i]) ?? null, jsonValue(b[i]) ?? null)) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  let n = 0
  for (const k of Object.keys(ao)) {
    const av = jsonValue(ao[k])
    if (av === undefined) continue
    n++
    if (!Object.prototype.hasOwnProperty.call(bo, k) || !jsonEqual(av, bo[k])) return false
  }
  for (const k of Object.keys(bo)) if (jsonValue(bo[k]) !== undefined) n--
  return n === 0
}

/** A JSON round trip's copy of `v` (undefined members dropped, non-finite
 *  numbers null) — but the strings are shared, not copied: a picture's
 *  `data:` string stays one string however many log entries hold it. */
function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => { const c = clone(jsonValue(x)); return c === undefined ? null : c }) as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const c = clone(jsonValue(x))
      if (c !== undefined) out[k] = c
    }
    return out as T
  }
  return jsonValue(v) as T
}

/** Apply a computeReapplicablePatch() result onto a live target element in
 *  place. A patch entry with value `undefined` (a field present in `before`
 *  but absent from `after`, i.e. the source change CLEARED it) deletes the
 *  key on the target rather than writing a literal `undefined`. */
export function applyReapplicablePatch(patch: Partial<SlideElement>, target: SlideElement) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (target as unknown as Record<string, unknown>)[key]
    else (target as unknown as Record<string, unknown>)[key] = clone(value)
  }
}

// --- human-readable summaries -------------------------------------------------

const FIELD_GROUPS: Array<{ keys: string[]; label: () => string }> = [
  { keys: ['x', 'y'], label: () => t('moved') },
  { keys: ['w', 'h'], label: () => t('resized') },
  { keys: ['rotation'], label: () => t('rotated') },
  { keys: ['html'], label: () => t('text edited') },
  { keys: ['fill', 'fillGradient', 'stroke', 'strokeWidth', 'radius'], label: () => t('style changed') },
]

/** Short label for one History-row entry: "created" / "deleted" / a handful
 *  of field-group words ("moved, resized") / up to 3 raw field names when
 *  nothing maps to a named group. */
export function summarizeChange(change: ElementChange): string {
  if (!change.before) return t('created')
  if (!change.after) return t('deleted')
  const changedKeys = changedFieldKeys(change)
  const consumed = new Set<string>()
  const labels: string[] = []
  for (const group of FIELD_GROUPS) {
    if (group.keys.some((k) => changedKeys.includes(k))) {
      labels.push(group.label())
      group.keys.forEach((k) => consumed.add(k))
    }
  }
  const rest = changedKeys.filter((k) => !consumed.has(k))
  if (labels.length) return rest.length ? `${labels.join(', ')}, ${rest.slice(0, 3).join(', ')}` : labels.join(', ')
  return rest.slice(0, 3).join(', ') || t('changed')
}

// --- persistence (own IndexedDB, slides-only — see docs/PARALLEL-WORK.md) ----
//
// A fresh, own-named database (`${appId}-actionlog`), NOT folded into the
// shared kernel/src/autosave.ts store: that one is kernel-zone code shared by
// every app, and per docs/PARALLEL-WORK.md kernel-zone changes are serialized,
// never something to piggyback on incidentally. Records are append-only,
// pruned to the newest MAX_PERSISTED rows per docId — same idiom as
// autosave.ts's MAX_VERSIONS prune. Same rule as autosave: an encrypted deck
// is NEVER written here (before/after element snapshots are exactly the same
// plaintext-to-disk leak class as autosave's doc snapshots) — encrypted decks
// get in-memory-only history for the session.
//
// PICTURES BY REFERENCE (version 2). A record holds whole elements, and an
// image element holds its whole `data:` picture: moving a 2 MB photo wrote
// 4 MB (before + after) per edit, 120 MB for 30 moves on a 20 MB deck, and a
// reload read every copy back into memory. A persisted record now holds a
// short ref per big `data:` string (`PIC_REF` + its content hash, kernel
// assetstore.ts `assetId`), and the `assets` store holds each picture ONCE
// per doc, written in the same transaction as the first record that needs
// it and deleted when the last record that refers to it is pruned. Reading
// back resolves the refs (the live doc's own string instance when it still
// holds the picture, else one shared copy); a record whose picture is gone
// is dropped, never handed out half-resolved. Version-1 rows (pictures
// inline, no `v`) still read as they are.

const dbName = () => `${appConfig().appId}-actionlog`
const DB_VERSION = 2
const STORE = 'changes'
/** picture bytes by (docId, assetId) — see PICTURES BY REFERENCE above */
const ASSETS = 'assets'
const MAX_PERSISTED = 500 // per docId

/** `data:` strings at least this long are stored by reference (store.ts SNAPSHOT_REF_MIN). */
const PIC_REF_MIN = 1024
/** A persisted string standing for a picture: NUL + 'pic:' + assetId. A
 *  string that itself starts with NUL is written with one more NUL in front. */
const NUL = '\u0000'
const PIC_REF = NUL + 'pic:'

/** A record as stored: `v: 2` = big pictures are refs, listed in `assets`;
 *  `seq` orders records of the same millisecond as they were recorded. */
type PersistedRecord = ActionRecord & { v?: 2; assets?: string[]; seq?: number }
/** Records stored by this page so far (`seq`). */
let persistSeq = 0
/** Oldest first: by time, then by recording order. */
const byAge = (a: PersistedRecord, b: PersistedRecord) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0)
type AssetRow = { key: string; docId: string; id: string; uri: string }
const assetKey = (docId: string, id: string) => `${docId}${NUL}${id}`

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let name: string
    try { name = dbName() } catch { resolve(null); return } // configureApp() never ran
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(name, DB_VERSION) } catch { resolve(null); return }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' })
        s.createIndex('docId', 'docId', { unique: false })
      }
      if (!db.objectStoreNames.contains(ASSETS)) {
        const s = db.createObjectStore(ASSETS, { keyPath: 'key' })
        s.createIndex('docId', 'docId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

/** Run `fn` in one transaction over both stores; resolves when it is done
 *  (true = committed). */
async function inTx(mode: IDBTransactionMode, fn: (records: IDBObjectStore, assets: IDBObjectStore) => void): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  return new Promise<boolean>((resolve) => {
    let t: IDBTransaction
    try { t = db.transaction([STORE, ASSETS], mode) } catch { resolve(false); return }
    t.oncomplete = () => resolve(true)
    t.onerror = () => resolve(false)
    t.onabort = () => resolve(false)
    try { fn(t.objectStore(STORE), t.objectStore(ASSETS)) } catch { try { t.abort() } catch { /* already done */ } resolve(false) }
  })
}

/** What a string mapper returns to give up on the whole value. */
const GAVE_UP = Symbol('gave up')

/** Copy of JSON-shaped `v` with every string passed through `fn`; GAVE_UP as
 *  soon as `fn` gives up anywhere inside. */
function mapJsonStrings(v: unknown, fn: (s: string) => string | typeof GAVE_UP): unknown {
  if (typeof v === 'string') return fn(v)
  if (Array.isArray(v)) {
    const out: unknown[] = []
    for (const x of v) { const c = mapJsonStrings(x, fn); if (c === GAVE_UP) return GAVE_UP; out.push(c) }
    return out
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const c = mapJsonStrings(x, fn)
      if (c === GAVE_UP) return GAVE_UP
      // an own "__proto__" member stays a member, never the prototype
      if (k === '__proto__') Object.defineProperty(out, k, { value: c, writable: true, enumerable: true, configurable: true })
      else out[k] = c
    }
    return out
  }
  return v
}

/** The stored form of `rec`: big pictures swapped for refs, collected in `assets`. */
function toPersisted(rec: ActionRecord): { row: PersistedRecord; assets: Map<string, string> } {
  const assets = new Map<string, string>()
  const ref = (s: string): string => {
    if (s.length >= PIC_REF_MIN && s.startsWith('data:')) {
      const id = assetId(s)
      assets.set(id, s)
      return PIC_REF + id
    }
    return s.startsWith(NUL) ? NUL + s : s
  }
  const changes = rec.changes.map((c) => ({
    ...c,
    before: c.before && (mapJsonStrings(c.before, ref) as SlideElement),
    after: c.after && (mapJsonStrings(c.after, ref) as SlideElement),
  }))
  return { row: { ...rec, changes, v: 2, assets: [...assets.keys()] }, assets }
}

/** The in-memory record a stored row stands for, or null when a picture it
 *  refers to is missing. `uris`: assetId → picture; `intern`: picture →
 *  the live doc's own instance of it. */
function fromPersisted(row: PersistedRecord, uris: Map<string, string>, intern: Map<string, string>): ActionRecord | null {
  const v2 = row.v === 2
  const deref = (s: string): string | typeof GAVE_UP => {
    if (v2 && s.startsWith(NUL)) {
      if (!s.startsWith(PIC_REF)) return s.slice(NUL.length)
      return uris.get(s.slice(PIC_REF.length)) ?? GAVE_UP
    }
    // a version-1 row's inline picture: the live doc's copy when it has one
    return s.length >= PIC_REF_MIN && s.startsWith('data:') ? intern.get(s) ?? s : s
  }
  const map = (el: SlideElement | null): SlideElement | null | typeof GAVE_UP =>
    el ? mapJsonStrings(el, deref) as SlideElement | typeof GAVE_UP : null
  const changes: ElementChange[] = []
  for (const c of row.changes) {
    const before = map(c.before)
    const after = map(c.after)
    if (before === GAVE_UP || after === GAVE_UP) return null
    changes.push({ ...c, before, after })
  }
  return { id: row.id, docId: row.docId, at: row.at, changes }
}

/** Every big `data:` string in `doc`, keyed by itself: lets a picture read
 *  back from the database become the instance the live doc already holds. */
function internTable(doc: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (v: unknown) => {
    if (typeof v === 'string') { if (v.length >= PIC_REF_MIN && v.startsWith('data:')) out.set(v, v) }
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
  }
  walk(doc)
  return out
}

function getAll<T>(source: IDBObjectStore | IDBIndex, docId: string, into: (rows: T[]) => void) {
  const req = source.getAll(IDBKeyRange.only(docId))
  req.onsuccess = () => into(req.result as T[])
}

/** Every stored row for a docId plus the pictures they refer to, in one
 *  read transaction. Rows oldest first, matching in-memory order. */
async function listPersisted(docId: string): Promise<{ rows: PersistedRecord[]; uris: Map<string, string> }> {
  let rows: PersistedRecord[] = []
  const uris = new Map<string, string>()
  const done = await inTx('readonly', (records, assets) => {
    getAll<PersistedRecord>(records.index('docId'), docId, (r) => { rows = r })
    getAll<AssetRow>(assets.index('docId'), docId, (r) => { for (const a of r) uris.set(a.id, a.uri) })
  })
  if (!done) return { rows: [], uris }
  return { rows: rows.sort(byAge), uris }
}

/** Keep the newest MAX_PERSISTED records of a docId and only the pictures
 *  they still refer to. `all`: drop every record (and so every picture). */
async function prunePersisted(docId: string, all = false): Promise<void> {
  await inTx('readwrite', (records, assets) => {
    const countReq = records.index('docId').count(IDBKeyRange.only(docId))
    countReq.onsuccess = () => {
      if (!all && countReq.result <= MAX_PERSISTED) return
      getAll<PersistedRecord>(records.index('docId'), docId, (rows) => {
        rows.sort(byAge)
        const drop = all ? rows : rows.slice(0, rows.length - MAX_PERSISTED)
        for (const r of drop) records.delete(r.id)
        const keep = new Set<string>()
        for (const r of all ? [] : rows.slice(drop.length)) for (const id of r.assets ?? []) keep.add(id)
        const keys = assets.index('docId').getAllKeys(IDBKeyRange.only(docId))
        keys.onsuccess = () => {
          for (const key of keys.result as string[]) {
            if (!keep.has(key.slice(docId.length + NUL.length))) assets.delete(key)
          }
        }
      })
    }
  })
}

/** Store one record: its new pictures and the record in ONE transaction (a
 *  record is never stored without its pictures), then prune. */
async function putPersisted(rec: ActionRecord): Promise<void> {
  const seq = ++persistSeq
  // hashing waits until the commit that recorded this has returned
  if (!await openDb()) return
  const { row, assets } = toPersisted(rec)
  row.seq = seq
  await inTx('readwrite', (records, store) => {
    for (const [id, uri] of assets) {
      const key = assetKey(rec.docId, id)
      // decided inside the transaction: a prune running before it is seen
      const has = store.getKey(key)
      has.onsuccess = () => { if (has.result === undefined) store.put({ key, docId: rec.docId, id, uri } satisfies AssetRow) }
    }
    records.put(row)
  })
  await prunePersisted(rec.docId)
}

/** Purge every persisted record (and picture) for a docId — called when a
 *  deck becomes encrypted, mirroring autosave.ts's clearVersions: plaintext
 *  element snapshots written before the password went up must not linger. */
export async function clearActionLog(docId: string): Promise<void> {
  await prunePersisted(docId, true)
}

// --- the log -------------------------------------------------------------------

export class ActionLog {
  private records: ActionRecord[] = []

  /**
   * Diff `beforeDoc` (a fresh parse of the doc as it stood before the
   * mutation — Store.checkpoint()'s own snapshot, reused rather than paying
   * for a second full clone; nothing else holds it, so its elements are
   * stored as they are) against the live doc, and push one ActionRecord if
   * anything on an element actually changed. A commit that only touched
   * doc.theme/doc.meta/etc. produces zero element changes and is skipped
   * entirely — nothing pushed, nothing persisted.
   */
  record(beforeDoc: SlidomingoDoc, afterDoc: SlidomingoDoc) {
    const changes = diffDoc(beforeDoc, afterDoc)
    if (!changes.length) return
    const rec: ActionRecord = { id: uid('act'), docId: afterDoc.docId, at: Date.now(), changes }
    this.records.push(rec)
    if (this.records.length > MAX_RECORDS) this.records.shift()
    if (!isEncryptionActive()) void putPersisted(rec)
  }

  /**
   * Last `limit` changes recorded for one element, newest first, each
   * paired with its ActionRecord's timestamp (ElementChange itself carries
   * none — one record can hold several changes). Takes `slideId` (a
   * doc.slides id, or a doc.layouts id in Slide Master mode) as well as
   * `elementId` — REQUIRED, not just a filter: element ids repeat across
   * slides by design (morph pairing), so an id alone is ambiguous. See
   * diffDoc's locKey comment.
   */
  changesFor(slideId: string, elementId: string, limit = 10): Array<{ change: ElementChange; at: number }> {
    const out: Array<{ change: ElementChange; at: number }> = []
    for (let i = this.records.length - 1; i >= 0 && out.length < limit; i--) {
      const rec = this.records[i]
      for (const change of rec.changes) {
        if (change.elementId === elementId && change.slideId === slideId) {
          out.push({ change, at: rec.at })
          if (out.length >= limit) break
        }
      }
    }
    return out
  }

  /** The single most recent change to one element on one slide/layout, if
   *  any — see changesFor() for why `slideId` is required, not optional. */
  lastChangeFor(slideId: string, elementId: string): ElementChange | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const rec = this.records[i]
      for (let j = rec.changes.length - 1; j >= 0; j--) {
        const c = rec.changes[j]
        if (c.elementId === elementId && c.slideId === slideId) return c
      }
    }
    return undefined
  }

  /** Recent entries across the doc, optionally scoped to one element/slide —
   *  backs the recent_changes agent verb. Newest first. */
  recent(opts: { elementId?: string; slideId?: string; limit?: number } = {}): Array<{ record: ActionRecord; change: ElementChange }> {
    const limit = opts.limit ?? 20
    const out: Array<{ record: ActionRecord; change: ElementChange }> = []
    for (let i = this.records.length - 1; i >= 0 && out.length < limit; i--) {
      const rec = this.records[i]
      for (const change of rec.changes) {
        if (opts.elementId && change.elementId !== opts.elementId) continue
        if (opts.slideId && change.slideId !== opts.slideId) continue
        out.push({ record: rec, change })
        if (out.length >= limit) break
      }
    }
    return out
  }

  /** Monotonic guard against overlapping hydrate() calls (e.g. a fast
   *  double replaceDoc()) — only the LATEST call's result is ever applied. */
  private hydrateToken = 0

  /** Drop everything in memory — called by Store.replaceDoc() before
   *  hydrate() loads whatever the NEW doc's docId has persisted. */
  clear() {
    this.records = []
    this.hydrateToken++ // invalidate any hydrate() already in flight for the old doc
  }

  /**
   * Load persisted history for this doc into memory, MERGED with whatever is
   * already there — never a blind overwrite. hydrate() is async (an
   * IndexedDB round trip); an edit made in the window before it resolves
   * pushes straight onto the live `this.records` array via record(), and a
   * naive `this.records = await …` here would silently discard that edit's
   * action-log entry the instant hydration completed. No-op (stays empty)
   * for an encrypted deck or when IndexedDB is unavailable — same
   * "in-memory only this session" rule record() applies going forward.
   * Called on Store construction and on replaceDoc() (after clear()).
   * `liveDoc` (the store's doc, read once loading is done): a picture it
   * still holds is shared with it rather than kept as a second copy.
   */
  async hydrate(docId: string, liveDoc?: () => unknown) {
    if (isEncryptionActive()) return
    const token = ++this.hydrateToken
    const { rows, uris } = await listPersisted(docId)
    if (token !== this.hydrateToken) return // superseded by a newer clear()/hydrate()
    const intern = rows.length ? internTable(liveDoc?.()) : new Map<string, string>()
    for (const [id, uri] of uris) uris.set(id, intern.get(uri) ?? uri)
    const seen = new Set(this.records.map((r) => r.id))
    const persisted: ActionRecord[] = []
    for (const row of rows) {
      if (seen.has(row.id)) continue
      // a record whose picture is gone is dropped, never half-resolved
      const rec = fromPersisted(row, uris, intern)
      if (rec) persisted.push(rec)
    }
    this.records = [...persisted, ...this.records].sort((a, b) => a.at - b.at)
  }
}
