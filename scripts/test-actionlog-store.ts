#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// The action log's IndexedDB (slides/src/actionlog.ts, "PICTURES BY
// REFERENCE"): a persisted record holds a short ref per big `data:` picture,
// the `assets` store holds each picture once per doc, and reading the log
// back after a reload gives records that behave exactly like the ones the
// session recorded — History, canRevert/revertChange, recent_changes,
// apply_change_pattern — even when the picture has left the document.
//
//   esbuild scripts/test-actionlog-store.ts --bundle --platform=node --format=esm --outfile=…
//   node <bundle>          (scripts/run-tests.mjs does both)
//
// Bundled so `fake-indexeddb` resolves from slides/node_modules.

import 'fake-indexeddb/auto'
import { isDeepStrictEqual } from 'node:util'
import { configureApp } from '../kernel/src/app.ts'
import { assetId } from '../kernel/src/assetstore.ts'
import { setEncryptionPassword } from '../kernel/src/save.ts'
import { emptySlide, newDoc } from '../slides/src/model.ts'
import type { SlideElement, SlidomingoDoc } from '../slides/src/model.ts'
import { Store } from '../slides/src/store.ts'
import { clearActionLog, computeReapplicablePatch, type ActionRecord } from '../slides/src/actionlog.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}

const APP = 'slidomingo-slides'
configureApp({ appId: APP, appName: APP })
const DB = `${APP}-actionlog`

const picture = (marker: string, kb = 512) => `data:image/jpeg;base64,${marker}${'Q'.repeat(kb * 1024)}`
const PICS = Array.from({ length: 6 }, (_, i) => picture(`PIC${i}XX`))
const SWAP = picture('SWAPPED')
const GONE = picture('GONEGONE')
const DANGLING = 'beeslides-store:sha256-0123456789abcdef'
const NUL_TEXT = '\u0000pic:sha256-0000000000000000' // looks like a ref; must come back as written

function image(id: string, src: string, x = 0): SlideElement {
  return { id, type: 'image', x, y: 0, w: 200, h: 100, rotation: 0, opacity: 1, src, fit: 'contain', radius: 0 } as SlideElement
}
function text(id: string, html: string): SlideElement {
  return { id, type: 'text', x: 10, y: 10, w: 300, h: 60, rotation: 0, opacity: 1, html, fontSize: 24 } as unknown as SlideElement
}
function deck(docId: string): SlidomingoDoc {
  const doc = newDoc()
  doc.docId = docId
  doc.slides = PICS.map((src, i) => emptySlide({ id: `s${i}`, elements: [image('img', src), text('t', i ? 'Caption' : NUL_TEXT)] }))
  doc.slides[0].elements.push(image('lost', DANGLING, 300))
  return doc
}

// ---- raw database access ----------------------------------------------------
function openRaw(version?: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(DB, version) : indexedDB.open(DB)
    req.onupgradeneeded = () => upgrade?.(req.result)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function rows(store: string): Promise<Array<Record<string, unknown>>> {
  const db = await openRaw()
  const out = await new Promise<Array<Record<string, unknown>>>((resolve) => {
    if (!db.objectStoreNames.contains(store)) { resolve([]); return }
    const q = db.transaction(store).objectStore(store).getAll()
    q.onsuccess = () => resolve(q.result)
  })
  db.close()
  return out
}
const docRows = async (store: string, docId: string) => (await rows(store)).filter((r) => r.docId === docId)
async function deleteRow(store: string, key: string) {
  const db = await openRaw()
  await new Promise<void>((resolve) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(key); t.oncomplete = () => resolve() })
  db.close()
}
/** Until `n` records of `docId` are stored and nothing more moves. */
async function settle(docId: string, n?: number) {
  let last = -1
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 5))
    const now = (await docRows('changes', docId)).length
    if (now === last && (n === undefined || now === n)) return
    last = now
  }
  throw new Error(`settle: ${docId} has ${last} records${n === undefined ? '' : `, not ${n}`}`)
}
async function reopen(doc: SlidomingoDoc): Promise<Store> {
  const s = new Store(structuredClone(doc))
  await s.actionLog.hydrate(doc.docId, () => s.doc)
  return s
}
const el = (s: Store, slide: string, id: string) =>
  s.doc.slides.find((x) => x.id === slide)!.elements.find((e) => e.id === id) as (SlideElement & { src?: string; html?: string }) | undefined
const records = (s: Store) => (s.actionLog as unknown as { records: ActionRecord[] }).records

// ---- a version-1 database (pictures inline) is upgraded and still read ------
console.log('\na version-1 database')
{
  const v1 = await openRaw(1, (db) => {
    const st = db.createObjectStore('changes', { keyPath: 'id' })
    st.createIndex('docId', 'docId', { unique: false })
  })
  const old: ActionRecord = { id: 'act-old', docId: 'legacy', at: 1, changes: [
    { elementId: 'img', elementType: 'image', slideId: 's0', isLayout: false, before: image('img', PICS[0]), after: image('img', PICS[0], 50) },
    { elementId: 't', elementType: 'text', slideId: 's0', isLayout: false, before: text('t', NUL_TEXT), after: text('t', 'Moved') },
  ] }
  await new Promise<void>((resolve) => { const t = v1.transaction('changes', 'readwrite'); t.objectStore('changes').put(old); t.oncomplete = () => resolve() })
  v1.close()
  const doc = deck('legacy')
  doc.slides[0].elements[0] = image('img', PICS[0], 50)
  const s = await reopen(doc)
  const got = s.actionLog.lastChangeFor('s0', 'img')
  ok(isDeepStrictEqual(records(s), [old]), 'its inline record reads back unchanged (a NUL-led text too)')
  ok(!!got && s.canRevert(got), 'and can be reverted')
  const db = await openRaw()
  ok(db.version === 2 && db.objectStoreNames.contains('assets'), `upgraded to version ${db.version} with an assets store`)
  db.close()
}

// ---- pictures are stored once ------------------------------------------------
console.log('\npictures by reference')
const MOVES = 30
const s = new Store(deck('photos'))
for (let i = 0; i < MOVES; i++) s.commit(() => { el(s, `s${i % PICS.length}`, 'img')!.x += 10 })
await settle('photos', MOVES)
const stored = await docRows('changes', 'photos')
const assets = await docRows('assets', 'photos')
const recordChars = stored.reduce((n, r) => n + JSON.stringify(r).length, 0)
const assetChars = assets.reduce((n, r) => n + String(r.uri).length, 0)
const pictureChars = PICS.reduce((n, p) => n + p.length, 0)
console.log(`    ${MOVES} picture moves on a ${(pictureChars / 1048576).toFixed(1)} MB deck: records ${(recordChars / 1024).toFixed(1)} KB, pictures ${(assetChars / 1048576).toFixed(1)} MB (inline: ${(2 * MOVES * PICS[0].length / 1048576).toFixed(1)} MB)`)
ok(stored.every((r) => !/PIC\dXX/.test(JSON.stringify(r))), 'no stored record carries picture bytes')
ok(recordChars < MOVES * 2048, `the records are small (${recordChars} chars for ${MOVES})`)
ok(assets.length === PICS.length && new Set(assets.map((a) => a.uri)).size === PICS.length, `each picture is stored once (${assets.length} rows for ${PICS.length} pictures)`)
ok(assets.every((a) => a.id === assetId(String(a.uri))), 'keyed by its content hash (assetstore assetId)')
ok(stored.every((r) => Array.isArray(r.assets) && (r.assets as string[]).length === 1), 'each record lists the picture it refers to')

console.log('\nread back after a reload')
s.commit(() => { el(s, 's1', 'img')!.src = SWAP }) // a picture swap: before = PIC1, after = SWAP
s.commit(() => { s.doc.slides[2].elements.push(image('extra', GONE, 400)) })
s.commit(() => { s.doc.slides[2].elements = s.doc.slides[2].elements.filter((e) => e.id !== 'extra') }) // GONE leaves the doc
s.commit(() => { el(s, 's0', 't')!.html = 'Edited' }) // before is the NUL-led text
s.commit(() => { el(s, 's0', 'lost')!.x = 333 }) // the dangling store ref rides along
await settle('photos', MOVES + 5)
const r = await reopen(s.doc)
ok(isDeepStrictEqual(records(r), records(s)), `the reloaded log deep-equals the session's (${records(r).length} records)`)
const live = s.actionLog.recent({ limit: 100 }).map((e) => s.canRevert(e.change))
const back = r.actionLog.recent({ limit: 100 }).map((e) => r.canRevert(e.change))
ok(isDeepStrictEqual(live, back), `canRevert answers the same for every entry (${back.filter(Boolean).length} revertable)`)
const swap = r.actionLog.lastChangeFor('s1', 'img')!
ok((swap.before as { src?: string }).src === PICS[1] && (swap.after as { src?: string }).src === SWAP, 'a swap reads back with both pictures')
ok(r.revertChange(swap) && el(r, 's1', 'img')!.src === PICS[1], 'and reverts to the old picture')
const deleted = r.actionLog.lastChangeFor('s2', 'extra')!
ok(deleted.after === null && (deleted.before as { src?: string }).src === GONE, 'a deleted picture that left the document reads back from the store')
ok(r.canRevert(deleted) && r.revertChange(deleted) && el(r, 's2', 'extra')?.src === GONE, 'and revert puts it back, bytes and all')
const textChange = r.actionLog.lastChangeFor('s0', 't')!
ok((textChange.before as { html?: string }).html === NUL_TEXT, 'a text that looks like a ref comes back as written')
ok((r.actionLog.lastChangeFor('s0', 'lost')!.after as { src?: string }).src === DANGLING, 'a beeslides-store ref comes back as written')
ok(isDeepStrictEqual(computeReapplicablePatch(swap), computeReapplicablePatch(s.actionLog.lastChangeFor('s1', 'img')!)), 'apply_change_pattern computes the same patch from it')

console.log('\na picture missing from the store')
{
  // (the reverts above were recorded too: by the reopened store, same docId)
  await settle('photos')
  const lost = (await docRows('assets', 'photos')).find((a) => a.uri === GONE)!
  await deleteRow('assets', String(lost.key))
  const all = await docRows('changes', 'photos')
  const needing = all.filter((row) => (row.assets as string[]).includes(String(lost.id))).length
  const m = await reopen(s.doc)
  ok(needing === 3 && records(m).length === all.length - needing, `the ${needing} records that need it are dropped (${all.length} → ${records(m).length})`)
  ok(!m.actionLog.lastChangeFor('s2', 'extra'), 'nothing half-resolved is handed out')
  ok(!!m.actionLog.lastChangeFor('s1', 'img'), 'the rest still read')
}

console.log('\npruning keeps only pictures still referred to')
{
  const p = new Store(deck('prune'))
  p.commit(() => { el(p, 's0', 'img')!.src = SWAP })
  p.commit(() => { el(p, 's0', 'img')!.src = PICS[0] }) // SWAP now only in the first two records
  await settle('prune', 2)
  ok((await docRows('assets', 'prune')).some((a) => a.uri === SWAP), 'the swapped-in picture is stored while records need it')
  for (let i = 0; i < 500; i++) p.commit(() => { el(p, 's3', 't')!.x = i })
  await settle('prune', 500)
  const left = await docRows('assets', 'prune')
  ok((await docRows('changes', 'prune')).length === 500, 'the newest 500 records are kept')
  ok(!left.some((a) => a.uri === SWAP), 'the picture only the pruned records used is deleted')
  ok(left.length === 0, `no picture row is left without a record (${left.length})`)
  ok((await docRows('assets', 'photos')).length > 0, "another doc's pictures are untouched")
}

console.log('\nclearActionLog and encryption')
{
  await clearActionLog('photos')
  ok((await docRows('changes', 'photos')).length === 0 && (await docRows('assets', 'photos')).length === 0, 'clearActionLog removes records and pictures')
  setEncryptionPassword('secret')
  const e = new Store(deck('secret'))
  e.commit(() => { el(e, 's0', 'img')!.x = 5 })
  await new Promise((r) => setTimeout(r, 100))
  ok(e.actionLog.recent().length === 1, 'an encrypted deck still logs in memory')
  ok((await docRows('changes', 'secret')).length === 0 && (await docRows('assets', 'secret')).length === 0, 'but writes nothing to the database')
  const h = await reopen(deck('prune'))
  ok(records(h).length === 0, 'and hydrates nothing')
  setEncryptionPassword(null)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
