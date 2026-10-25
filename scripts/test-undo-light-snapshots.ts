#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Light undo snapshots (store.ts SnapshotAssets): the undo/redo stack and the
// string the action log diffs hold a short ref per `data:` picture, not its
// bytes — and undo, redo, revert and undo-group rollback behave exactly as
// with full copies. Runs without a DOM.

import { isDeepStrictEqual } from 'node:util'
import { emptySlide, newDoc } from '../slides/src/model.ts'
import type { SlideElement, SlidomingoDoc } from '../slides/src/model.ts'
import { Store } from '../slides/src/store.ts'

let checks = 0
let failures = 0

function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else {
    failures++
    console.error(`  FAIL  ${message}`)
  }
}

// big, distinct pictures; each carries a marker that only its bytes contain
const picture = (marker: string, kb = 256) => `data:image/png;base64,${marker}${'Q'.repeat(kb * 1024)}`
const PIC_A = picture('PICAAAA')
const PIC_B = picture('PICBBBB')
const PIC_C = picture('PICCCCC')
const DANGLING = 'beeslides-store:sha256-0123456789abcdef'
const NUL_TEXT = '\u0000ref:0' // looks like a snapshot ref; must come back as written

type Internals = {
  undoStack: Array<{ doc: string }>
  redoStack: Array<{ doc: string }>
  snapAssets: { uriOf: Map<string, string> }
}
const inner = (s: Store) => s as unknown as Internals
const stackText = (s: Store) => [...inner(s).undoStack, ...inner(s).redoStack].map((e) => e.doc).join('\n')
const snap = (s: Store): SlidomingoDoc => structuredClone(s.doc)

function image(id: string, src: string, x = 0): SlideElement {
  return { id, type: 'image', x, y: 0, w: 200, h: 100, rotation: 0, opacity: 1, src, fit: 'contain', radius: 0 } as SlideElement
}
function text(id: string, html: string): SlideElement {
  return { id, type: 'text', x: 10, y: 10, w: 300, h: 60, rotation: 0, opacity: 1, html, fontSize: 24 } as unknown as SlideElement
}

function makeStore(): Store {
  const doc = newDoc()
  doc.assets = { hero: PIC_A, small: 'data:image/gif;base64,R0lGOD' }
  doc.slides = [
    emptySlide({ id: 's1', elements: [image('img', PIC_A), image('img2', 'asset:hero', 300), text('t', 'Hello'), image('lost', DANGLING, 600)] }),
    emptySlide({ id: 's2', elements: [image('img', PIC_A), text('n', NUL_TEXT)] }),
  ]
  return new Store(doc)
}
const el = (s: Store, slide: string, id: string) =>
  s.doc.slides.find((x) => x.id === slide)!.elements.find((e) => e.id === id) as (SlideElement & { src?: string }) | undefined

console.log('\nsnapshots hold refs, not bytes')
const s = makeStore()
const states: SlidomingoDoc[] = [snap(s)]
const edit = (fn: () => void) => { s.commit(fn); states.push(snap(s)) }
edit(() => { el(s, 's1', 't')!.x += 5 })
edit(() => { el(s, 's1', 'img')!.x += 7 })
edit(() => { el(s, 's1', 'img')!.src = PIC_B })
edit(() => { s.doc.slides[1].elements.push(image('third', PIC_C)) })
edit(() => { s.doc.slides[1].elements = s.doc.slides[1].elements.filter((e) => e.id !== 'img') })
edit(() => { s.doc.assets!.extra = PIC_C })
const stack = stackText(s)
ok(inner(s).undoStack.length === 6, 'every edit is one undo step')
ok(!/PIC[ABC]/.test(stack), 'no undo snapshot carries picture bytes')
ok(stack.length < 6 * 20_000, `the stack is small (${stack.length} chars for 6 snapshots of a ${Math.round(JSON.stringify(s.doc).length / 1024)} KB doc)`)
ok(stack.includes(DANGLING), 'a beeslides-store ref in the doc is kept as written')
ok(stack.includes('data:image/gif;base64,R0lGOD'), 'a tiny data: string is simply copied')

console.log('\nundo/redo restore identical documents')
{
  let same = true
  for (let i = states.length - 2; i >= 0; i--) {
    s.undo()
    if (!isDeepStrictEqual(s.doc, states[i])) { same = false; console.error(`    undo to state ${i} differs`) }
  }
  ok(same, 'undo walks back through every state, deep-equal')
  ok(el(s, 's1', 'img')!.src === PIC_A, 'the first picture is back on its element')
  ok(el(s, 's1', 'lost')!.src === DANGLING, 'the dangling ref is untouched')
  ok(s.doc.slides[1].elements.find((e) => e.id === 'n')!.html === NUL_TEXT, 'a string that looks like a snapshot ref survives')
  ok(!/PIC[ABC]/.test(stackText(s)), 'the redo stack carries no bytes either')
  same = true
  for (let i = 1; i < states.length; i++) {
    s.redo()
    if (!isDeepStrictEqual(s.doc, states[i])) { same = false; console.error(`    redo to state ${i} differs`) }
  }
  ok(same, 'redo walks forward through every state, deep-equal')
}

console.log('\nthe action log records only what changed')
{
  const t = makeStore()
  t.commit(() => { el(t, 's1', 't')!.x += 5 })
  let rec = t.actionLog.recent({ limit: 10 })
  ok(rec.length === 1 && rec[0].change.elementId === 't' && rec[0].change.slideId === 's1', 'moving a text box logs that text box alone (no image looks changed)')
  t.commit(() => { el(t, 's1', 'img')!.x += 9 })
  rec = t.actionLog.recent({ limit: 1 })
  const moved = rec[0]?.change
  ok(rec.length === 1 && moved.elementId === 'img' && moved.slideId === 's1', 'moving a picture logs that picture')
  ok((moved?.before as { src?: string } | null)?.src === PIC_A, 'its before holds the real picture, not a ref')
  t.commit(() => { el(t, 's1', 'img')!.src = PIC_B })
  const change = t.actionLog.lastChangeFor('s1', 'img')!
  ok((change.before as { src?: string }).src === PIC_A && (change.after as { src?: string }).src === PIC_B, 'a picture swap logs before = old picture, after = new')
  ok(t.canRevert(change), 'the swap can be reverted')
  ok(t.revertChange(change), 'revert applies')
  ok(el(t, 's1', 'img')!.src === PIC_A, 'revert restores the picture')
  ok(el(t, 's2', 'img')!.src === PIC_A, 'the same-id picture on another slide is untouched')
  t.undo()
  ok(el(t, 's1', 'img')!.src === PIC_B, 'a global undo takes just the revert back')
  // the burst-editor pairing: checkpoint, edits, recordAction once
  const before = t.actionLog.recent({ limit: 100 }).length
  t.checkpoint()
  el(t, 's1', 't')!.html = 'Hel'
  t.touch()
  el(t, 's1', 't')!.html = 'Hello there'
  t.touch()
  t.recordAction()
  const after = t.actionLog.recent({ limit: 100 })
  ok(after.length === before + 1 && after[0].change.elementId === 't', 'a settled burst logs one change')
}

console.log('\nundo group rollback')
{
  const g = makeStore()
  g.commit(() => { el(g, 's1', 't')!.x = 99 })
  const kept = snap(g)
  g.beginUndoGroup()
  g.commit(() => { el(g, 's1', 'img')!.src = PIC_C })
  g.commit(() => { g.doc.slides[1].elements = [] })
  g.commit(() => { g.doc.assets!.hero = PIC_B })
  ok(g.rollbackUndoGroup(), 'rollback succeeds')
  ok(isDeepStrictEqual(g.doc, kept), 'the document is exactly as before the group')
  g.undo()
  ok(el(g, 's1', 't')!.x === 10 && el(g, 's1', 'img')!.src === PIC_A, 'the step before the group is next')
}

console.log('\nbaselineFor (Tidy) reads real documents')
{
  const b = makeStore()
  b.commit(() => { el(b, 's1', 'img')!.w = 400 })
  const base = b.baselineFor(['img'])
  const img = base?.slides[0].elements.find((e) => e.id === 'img') as { src?: string; w?: number } | undefined
  ok(img?.w === 200 && img?.src === PIC_A, 'the baseline holds the old frame and the picture')
}

console.log('\nthe snapshot table forgets pictures nothing refers to')
{
  const p = makeStore()
  const table = () => [...inner(p).snapAssets.uriOf.values()]
  p.commit(() => { p.doc.slides[0].elements.push(image('tmp', PIC_C)) })
  p.commit(() => { p.doc.slides[0].elements = p.doc.slides[0].elements.filter((e) => e.id !== 'tmp') })
  ok(table().includes(PIC_C), 'a deleted picture stays while undo can bring it back')
  p.undo()
  ok(el(p, 's1', 'tmp')?.src === PIC_C, 'and undo does')
  p.commit(() => { p.doc.slides[0].elements = p.doc.slides[0].elements.filter((e) => e.id !== 'tmp') })
  for (let i = 0; i < 101; i++) p.commit(() => { el(p, 's1', 't')!.x++ })
  ok(!table().includes(PIC_C), 'once its last undo step is gone, so are its bytes')
  ok(table().includes(PIC_A), 'a picture still in the document stays')
  for (let i = 0; i < 100; i++) p.undo()
  ok(el(p, 's1', 'img')!.src === PIC_A && el(p, 's1', 't')!.x === 11, 'the oldest kept step still restores')
  // redo entries are dropped by a new edit: their pictures go with them
  const q = makeStore()
  q.commit(() => { el(q, 's1', 'img')!.src = PIC_B })
  q.undo()
  ok([...inner(q).snapAssets.uriOf.values()].includes(PIC_B), 'a redo step keeps its picture')
  q.commit(() => { el(q, 's1', 't')!.x++ })
  ok(![...inner(q).snapAssets.uriOf.values()].includes(PIC_B), 'a new edit drops the redo step and its picture')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
