#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Store undo groups — what makes an agent program (Code Mode's `execute`,
// desktop/src/main/agentexec.ts) ONE undo step, and lets a failed one be
// rolled back without leaving an undo or redo step behind. Runs without a DOM.

import { emptySlide, newDoc } from '../slides/src/model.ts'
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

function makeStore(): Store {
  const doc = newDoc()
  doc.slides = ['a', 'b'].map((id) => emptySlide({ id, name: id }))
  return new Store(doc)
}

const names = (s: Store) => s.doc.slides.map((x) => x.name).join(',')
const rename = (s: Store, i: number, name: string) => s.commit(() => { s.doc.slides[i].name = name })

console.log('\na group is one undo step')
{
  const s = makeStore()
  rename(s, 0, 'before')
  s.beginUndoGroup()
  rename(s, 0, 'x')
  rename(s, 1, 'y')
  rename(s, 0, 'z')
  s.endUndoGroup()
  ok(names(s) === 'z,y', 'every edit of the group applied')
  s.undo()
  ok(names(s) === 'before,b', 'one undo takes the whole group back')
  s.undo()
  ok(names(s) === 'a,b', 'the edit before the group is its own step')
  s.redo()
  s.redo()
  ok(names(s) === 'z,y', 'one redo brings the whole group back')
}

console.log('\nrollback')
{
  const s = makeStore()
  rename(s, 0, 'kept')
  s.beginUndoGroup()
  rename(s, 0, 'x')
  rename(s, 1, 'y')
  ok(s.rollbackUndoGroup(), 'rollback succeeds')
  ok(names(s) === 'kept,b', 'the document is as before the group')
  s.undo()
  ok(names(s) === 'a,b', 'no undo step left behind: the next undo is the edit before')
  s.redo()
  ok(names(s) === 'kept,b', 'and no redo step either')
}

console.log('\nedge cases')
{
  const s = makeStore()
  s.beginUndoGroup()
  ok(s.rollbackUndoGroup(), 'rolling back a group with no edits is fine')
  ok(names(s) === 'a,b', 'and changes nothing')

  s.beginUndoGroup()
  s.endUndoGroup()
  rename(s, 0, 'after')
  s.undo()
  ok(names(s) === 'a,b', 'an empty group adds no step')

  const t = makeStore()
  t.beginUndoGroup()
  rename(t, 0, 'x')
  t.undo() // the user's ⌘Z during the run
  rename(t, 1, 'y')
  t.endUndoGroup()
  ok(names(t) === 'a,y', 'an edit after an undo inside the group still applies')
  t.undo()
  ok(names(t) === 'a,b', 'and is still undoable')

  const u = makeStore()
  u.beginUndoGroup()
  rename(u, 0, 'x')
  u.undo()
  u.redo()
  ok(!u.rollbackUndoGroup() || names(u) === 'a,b', 'rollback after the user moved through history never corrupts the doc')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
