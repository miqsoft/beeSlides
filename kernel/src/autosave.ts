// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Local auto-save + lightweight version history, backed by IndexedDB.
//
// Two concerns, one store:
//   · recovery  — a single latest snapshot per docId, overwritten each cycle.
//     On reopen, if it differs from the file we loaded, we offer to restore
//     (the safety net for a crash / tab-close before a save, and the ONLY net
//     on browsers without the File System Access API).
//   · versions  — a capped, throttled timeline of snapshots per docId, for the
//     "Version history" restore UI.
//
// Snapshots hold the plain document JSON (a few KB–tens of KB), NOT the ~430KB
// HTML shell — restore re-injects via store.replaceDoc. Encrypted decks are
// never snapshotted here (that would write plaintext to disk); their file
// write-back stays encrypted.

import type { KernelDoc } from './doc.ts'
import { appConfig } from './app.ts'

/**
 * One database PER APP.
 *
 * Every app used to share `slidomingo-autosave`, which is two problems, not one.
 * The visible one is that two apps' snapshots pile into one store wherever
 * they share an origin — the hosted web site, or any local server. The dangerous one
 * is `DB_VERSION`: it was shared too, so a new app bumping it to 2 would make
 * every ALREADY-SHIPPED shell of every other app throw `VersionError` on open
 * and lose autosave entirely. Files in the world are frozen code; they would
 * go on opening version 1 forever and there is no way to reach them.
 *
 * `appId` is already `slidomingo-slides` / `slidomingo-spaces`, so this reads
 * `slidomingo-slides-autosave` — no doubled prefix, and no special case for the
 * app that happened to be first. Each app now owns its own version line.
 *
 * Called lazily rather than at module scope: `appConfig()` throws before
 * `configureApp()` runs, and a kernel module that explodes at import time
 * depending on evaluation order is the import-order trap app.ts exists to
 * avoid.
 */
const dbName = () => `${appConfig().appId}-autosave`

/** The shared name every app wrote to before scoping. Read once, then left alone. */
const LEGACY_DB_NAME = 'slidomingo-autosave'
const DB_VERSION = 1
const RECOVERY = 'recovery'
const VERSIONS = 'versions'
const MAX_VERSIONS = 20 // per doc, unkept (throttled timeline) entries
const MAX_KEPT = 10 // per doc, `keep` checkpoints — their own cap, see addVersion
const PRUNE_DAYS = 30

export interface Snapshot {
  id?: number
  docId: string
  at: number
  title: string
  json: string
  /** Why this version exists — a short CODE (`'opened'`, `'saved'`,
   *  `'before-replace'`, …), never a display string: the app translates it at
   *  render time, so a snapshot written in one UI language reads right in
   *  another. Absent = an ordinary timeline entry. Additive: rows written by
   *  older shells simply lack it. */
  label?: string
  /** A checkpoint that the timeline pruning must not evict. Kept entries are
   *  capped separately (MAX_KEPT), so a long session's autosave churn can
   *  never push "the file as opened" out of history. */
  keep?: boolean
}

export interface AddVersionOpts {
  label?: string
  keep?: boolean
}

let dbPromise: Promise<IDBDatabase | null> | null = null

/** Open a database by name, creating this build's stores. */
function open(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(name, DB_VERSION) } catch { resolve(null); return }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(RECOVERY)) db.createObjectStore(RECOVERY, { keyPath: 'docId' })
      if (!db.objectStoreNames.contains(VERSIONS)) {
        const s = db.createObjectStore(VERSIONS, { keyPath: 'id', autoIncrement: true })
        s.createIndex('docId', 'docId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

/** Everything in one store of a database, or [] on any failure. */
function readAll(db: IDBDatabase, store: string): Promise<Snapshot[]> {
  return new Promise((resolve) => {
    let t: IDBTransaction
    try { t = db.transaction(store, 'readonly') } catch { resolve([]); return }
    const req = t.objectStore(store).getAll()
    req.onsuccess = () => resolve((req.result as Snapshot[]) ?? [])
    req.onerror = () => resolve([])
  })
}

/**
 * Carry snapshots over from the shared database, ONCE, on first open.
 *
 * Renaming without this would silently drop every user's recovery snapshot and
 * their whole version timeline — a visible feature quietly emptying itself,
 * which is a bug report, not a migration.
 *
 * It COPIES rather than moves: shells already shipped go on writing to the old
 * name forever, and deleting the source would break the copy of the app the
 * user might open next. The cost is that the old database lingers; `pruneOld`
 * ages its contents out on its own schedule.
 *
 * Everything is copied, not just this app's rows. Nothing in a snapshot records
 * which app wrote it — and it does not need to: `docId` is a uuid, so another
 * app's rows can never match a lookup here. Filtering would mean guessing.
 */
async function migrateLegacy(target: IDBDatabase, targetName: string): Promise<void> {
  if (targetName === LEGACY_DB_NAME) return
  // Only ever migrate INTO an empty database — a second pass would duplicate
  // the version timeline, and a user who deleted a snapshot would see it return.
  const existing = await readAll(target, RECOVERY)
  if (existing.length) return
  const legacy = await open(LEGACY_DB_NAME)
  if (!legacy) return
  try {
    const [recovery, versions] = await Promise.all([
      readAll(legacy, RECOVERY),
      readAll(legacy, VERSIONS),
    ])
    if (!recovery.length && !versions.length) return
    await new Promise<void>((resolve) => {
      let t: IDBTransaction
      try { t = target.transaction([RECOVERY, VERSIONS], 'readwrite') } catch { resolve(); return }
      const rs = t.objectStore(RECOVERY)
      const vs = t.objectStore(VERSIONS)
      for (const r of recovery) rs.put(r)
      // drop the old autoIncrement key so the target mints its own
      for (const v of versions) { const { id: _id, ...rest } = v; vs.add(rest as Snapshot) }
      t.oncomplete = () => resolve()
      t.onerror = () => resolve()
      t.onabort = () => resolve()
    })
  } finally {
    legacy.close()
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = (async () => {
    let name: string
    try { name = dbName() } catch { return null } // configureApp() never ran
    const db = await open(name)
    if (!db) return null
    try { await migrateLegacy(db, name) } catch { /* best effort, never fatal */ }
    return db
  })()
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then((db) => {
    if (!db) return null
    return new Promise<T | null>((resolve) => {
      let t: IDBTransaction
      try { t = db.transaction(store, mode) } catch { resolve(null); return }
      const req = fn(t.objectStore(store))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => resolve(null)
    })
  })
}

/**
 * Write the single latest recovery snapshot for this doc.
 *
 * Returns whether it ACTUALLY stored. `tx()` resolves null on every failure
 * rather than throwing — no IndexedDB at all, a blocked open, a failed
 * transaction — which is right for a best-effort backstop but means a caller
 * cannot assume success. That distinction is load-bearing now that the editor
 * tells the author their work is "backed up in this browser": Safari in private
 * browsing and some `file://` contexts have no usable IndexedDB, and on iOS
 * that is exactly where a shared deck tends to be opened. Claiming a backstop
 * that isn't there would be worse than saying nothing.
 */
export async function putRecovery(doc: KernelDoc): Promise<boolean> {
  const key = await tx(RECOVERY, 'readwrite', (s) =>
    s.put({ docId: doc.docId, at: Date.now(), title: doc.title, json: JSON.stringify(doc) } as Snapshot))
  return key != null
}

export async function getRecovery(docId: string): Promise<Snapshot | null> {
  return (await tx<Snapshot>(RECOVERY, 'readonly', (s) => s.get(docId))) ?? null
}

export async function clearRecovery(docId: string): Promise<void> {
  await tx(RECOVERY, 'readwrite', (s) => s.delete(docId))
}

/** Delete every version-history snapshot for a docId. Used when a deck is
 *  encrypted: the plaintext snapshots written before encryption was enabled must
 *  not linger in IndexedDB (they'd defeat the encryption the user just turned on). */
export async function clearVersions(docId: string): Promise<void> {
  const all = await listVersions(docId)
  await Promise.all(all.map((v) => tx(VERSIONS, 'readwrite', (s) => s.delete(v.id!))))
}

/**
 * Append a version-history snapshot.
 *
 * A snapshot byte-identical to the newest one is not stored twice — reopening
 * an unchanged deck, or ⌘S straight after an autosave, would otherwise fill the
 * timeline with copies. When the duplicate carries a label/keep the newest
 * lacks, the newest is upgraded in place instead, so a "saved" checkpoint is
 * never lost to dedupe.
 *
 * Pruning keeps the newest MAX_VERSIONS ordinary entries and, separately, the
 * newest MAX_KEPT `keep` entries. Before `keep` existed an "opened" checkpoint
 * was just another row, evicted after ~MAX_VERSIONS throttled autosaves
 * (≈40 minutes at the editor's 120s cadence).
 */
export async function addVersion(doc: KernelDoc, opts: AddVersionOpts = {}): Promise<void> {
  const json = JSON.stringify(doc)
  const existing = await listVersions(doc.docId)
  const latest = existing[0]
  if (latest && latest.json === json) {
    const upgrade = (opts.keep && !latest.keep) || (opts.label && !latest.label)
    if (upgrade) {
      const next: Snapshot = { ...latest }
      if (opts.keep) next.keep = true
      if (opts.label && !latest.label) next.label = opts.label
      await tx(VERSIONS, 'readwrite', (s) => s.put(next))
    }
    return
  }
  const row: Snapshot = { docId: doc.docId, at: Date.now(), title: doc.title, json }
  if (opts.label) row.label = opts.label
  if (opts.keep) row.keep = true
  await tx(VERSIONS, 'readwrite', (s) => s.add(row))
  // prune each class to its own cap (listVersions is newest first)
  const all = await listVersions(doc.docId)
  const doomed = [
    ...all.filter((v) => !v.keep).slice(MAX_VERSIONS),
    ...all.filter((v) => v.keep).slice(MAX_KEPT),
  ]
  await Promise.all(doomed.map((v) => tx(VERSIONS, 'readwrite', (s) => s.delete(v.id!))))
}

export async function listVersions(docId: string): Promise<Snapshot[]> {
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve) => {
    let t: IDBTransaction
    try { t = db.transaction(VERSIONS, 'readonly') } catch { resolve([]); return }
    const idx = t.objectStore(VERSIONS).index('docId')
    const out: Snapshot[] = []
    const req = idx.openCursor(IDBKeyRange.only(docId))
    req.onsuccess = () => {
      const cur = req.result
      if (cur) { out.push(cur.value as Snapshot); cur.continue() }
      else resolve(out.sort((a, b) => b.at - a.at || (b.id ?? 0) - (a.id ?? 0))) // newest first (id breaks same-ms ties)
    }
    req.onerror = () => resolve([])
  })
}

/** Drop snapshots older than PRUNE_DAYS across all docs (housekeeping). */
export async function pruneOld(): Promise<void> {
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000
  const db = await openDb()
  if (!db) return
  for (const store of [VERSIONS, RECOVERY]) {
    try {
      const t = db.transaction(store, 'readwrite')
      const req = t.objectStore(store).openCursor()
      req.onsuccess = () => {
        const cur = req.result
        if (!cur) return
        if ((cur.value as Snapshot).at < cutoff) cur.delete()
        cur.continue()
      }
    } catch { /* best effort */ }
  }
}
