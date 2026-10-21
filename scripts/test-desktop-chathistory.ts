#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Desktop chat-history rig.
//
//   node scripts/test-desktop-chathistory.ts
//
// WHAT THIS PROVES. The terminal panel launches every `claude` under an id it
// picks and remembers which deck that conversation belonged to
// (desktop/src/main/chathistory.ts), so a deck's history menu can list and
// resume them. Each check is one way that could go wrong for the user: a
// conversation listed under the wrong deck, lost after a rename or after an
// unsaved draft was saved, a never-used tab cluttering the list forever, or a
// renderer-supplied id reaching the shell command line.

import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addRecord, backfillChats, belongsTo, projectDirName, findTranscript, isChatId, listChats, loadRecords, retarget, tailTranscriptTitle, transcriptTitle,
} from '../desktop/src/main/chathistory.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const root = mkdtempSync(join(tmpdir(), 'chathistory-'))
const store = join(root, 'chat-history.json')
const config = join(root, 'claude-config')

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const D = '44444444-4444-4444-8444-444444444444'

const line = (o: unknown) => JSON.stringify(o)
function transcript(project: string, id: string, lines: unknown[], mtimeSec?: number): void {
  const dir = join(config, 'projects', project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, lines.map(line).join('\n') + '\n')
  if (mtimeSec) utimesSync(file, mtimeSec, mtimeSec)
}

// ---- ids -----------------------------------------------------------------------
ok(isChatId(A), 'a uuid is a chat id')
ok(!isChatId(`${A}; rm -rf ~`) && !isChatId('../x') && !isChatId(42), 'nothing else is — it is the only renderer value that reaches the command line')

// ---- titles --------------------------------------------------------------------
ok(transcriptTitle([
  line({ type: 'user', message: { role: 'user', content: 'Make slide 3 punchier' } }),
  line({ type: 'ai-title', aiTitle: 'punchier-slide-three' }),
].join('\n')) === 'punchier-slide-three', "Claude Code's generated title wins over the first prompt")
ok(transcriptTitle([
  line({ type: 'ai-title', aiTitle: 'generated' }),
  line({ type: 'custom-title', customTitle: 'Q3 review polish' }),
].join('\n')) === 'Q3 review polish', 'a /rename wins over everything')
ok(transcriptTitle([
  line({ type: 'user', isMeta: true, message: { content: 'caveat text' } }),
  line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
  line({ type: 'user', message: { content: [{ type: 'text', text: 'Fix   the\ntitle slide' }] } }),
].join('\n')) === 'Fix the title slide', 'without titles, the first REAL prompt — meta lines, slash commands and tool results skipped, whitespace folded')
ok(transcriptTitle('x'.repeat(10) + '\n{broken') === null, 'garbage yields no title instead of throwing')
ok((transcriptTitle(line({ type: 'user', message: { content: 'w '.repeat(200) } })) ?? '').length <= 80, 'long prompts are clipped')

// ---- records and listing ---------------------------------------------------------
const now = Date.now()
const deckPath = '/Users/x/Decks/Review.beeslides.html'
const draftPath = '/Users/x/Library/Application Support/slidomingo-desktop/Drafts/draft-1.beeslides.html'

addRecord(store, { id: A, docId: 'doc-1', path: deckPath, startedAt: now - 5000 })
addRecord(store, { id: B, docId: null, path: draftPath, startedAt: now - 4000 }) // a draft, before its docId was reported
addRecord(store, { id: C, docId: 'doc-2', path: '/Users/x/Other.beeslides.html', startedAt: now - 3000 })
addRecord(store, { id: D, docId: 'doc-1', path: deckPath, startedAt: now - 1000 }) // opened, never used: no transcript
ok(loadRecords(store).length === 4, 'records persist')

transcript('-Users-x-Decks', A, [{ type: 'ai-title', aiTitle: 'older chat' }], Math.floor(now / 1000) - 3600)
// The draft's session ran in a scratch dir — its transcript lives under THAT project folder.
transcript('-private-var-folders-T-slidomingo-desktop-untitled-3', B, [{ type: 'user', message: { content: 'draft chat' } }], Math.floor(now / 1000) - 60)
transcript('-Users-x', C, [{ type: 'ai-title', aiTitle: 'other deck' }])

ok(findTranscript(config, B)?.includes('untitled-3') === true, 'a transcript is found whatever project folder it landed in')
ok(findTranscript(config, D) === null, 'a never-used session has no transcript')

let list = listChats(store, config, { docId: 'doc-1', path: deckPath }, now)
ok(list.map((c) => c.id).join() === A, 'a deck lists only its own conversations, and none without a transcript')
ok(list[0]?.title === 'older chat', 'listed with its title')

list = listChats(store, config, { docId: 'doc-3', path: draftPath }, now)
ok(list.map((c) => c.id).join() === B, 'a record without a docId still matches by its bound path')
ok(loadRecords(store).find((r) => r.id === B)?.docId === 'doc-3', '…and learns the deck docId from it')

// Save As moved the draft to a real file: new path, same docId.
list = listChats(store, config, { docId: 'doc-3', path: '/Users/x/Decks/Saved.beeslides.html' }, now)
ok(list.map((c) => c.id).join() === B, 'after Save As (new path, same docId) the conversation is still listed')

// Renamed in Finder: new path, docId unchanged.
list = listChats(store, config, { docId: 'doc-1', path: '/Users/x/Decks/Renamed.beeslides.html' }, now)
ok(list.map((c) => c.id).join() === A, 'after a rename the conversation is still listed')

ok(listChats(store, config, { docId: 'doc-2', path: deckPath }, now).map((c) => c.id).join() === C,
  'a DIFFERENT docId at the same path is another deck — its own chats only')
ok(listChats(store, config, { docId: null, path: null }, now).length === 0, 'a window with no deck key lists nothing')

// Ordering: most recently active first.
addRecord(store, { id: '55555555-5555-4555-8555-555555555555', docId: 'doc-1', path: deckPath, startedAt: now - 9000 })
transcript('-Users-x-Decks', '55555555-5555-4555-8555-555555555555', [{ type: 'ai-title', aiTitle: 'newest activity' }])
list = listChats(store, config, { docId: 'doc-1', path: deckPath }, now)
ok(list[0]?.title === 'newest activity' && list[1]?.title === 'older chat', 'sorted by last activity, not by start')

// ---- retarget: the deck changed identity under a running conversation --------
// The start page's AI flow: the chat starts on a blank draft (docId doc-blank),
// then the generated deck is loaded (its own docId) and saved As a real file.
const G = '66666666-6666-4666-8666-666666666666'
addRecord(store, { id: G, docId: 'doc-blank', path: draftPath, startedAt: now })
transcript('-private-var-folders-T-slidomingo-desktop-untitled-9', G, [{ type: 'ai-title', aiTitle: 'generated deck' }])
retarget(store, [G], { docId: 'doc-generated', path: draftPath })
retarget(store, [G], { docId: 'doc-generated', path: '/Users/x/Decks/Generated.beeslides.html' })
ok(listChats(store, config, { docId: 'doc-generated', path: '/Users/x/Decks/Generated.beeslides.html' }, now).some((c) => c.id === G),
  'a running conversation follows its deck through a docId change and Save As')
ok(!listChats(store, config, { docId: 'doc-blank', path: null }, now).some((c) => c.id === G), '…and no longer shows under the blank it started on')
retarget(store, [G], { docId: null, path: null })
ok(loadRecords(store).find((r) => r.id === G)?.docId === 'doc-generated', 'an empty key (window already gone) changes nothing')

// ---- pruning -------------------------------------------------------------------
ok(loadRecords(store).some((r) => r.id === D), 'a fresh never-used record is kept (it may be a live tab not yet spoken to)')
listChats(store, config, { docId: 'doc-1', path: deckPath }, now + 3 * 24 * 3600 * 1000)
ok(!loadRecords(store).some((r) => r.id === D), 'a stale one without a transcript is pruned')
ok(loadRecords(store).some((r) => r.id === A), 'records with transcripts are never pruned')

// ---- resume guard --------------------------------------------------------------
ok(belongsTo(store, A, { docId: 'doc-1', path: null }), 'resuming your own deck conversation is allowed')
ok(!belongsTo(store, C, { docId: 'doc-1', path: deckPath }), "another deck's conversation is refused")
ok(!belongsTo(store, '99999999-9999-4999-8999-999999999999', { docId: 'doc-1', path: deckPath }), 'an unknown id is refused')

// ---- robustness ------------------------------------------------------------------
writeFileSync(store, '{not json')
ok(loadRecords(store).length === 0, 'a corrupt store reads as empty instead of throwing')
ok(listChats(store, join(root, 'missing-config'), { docId: 'doc-1', path: deckPath }, now).length === 0, 'a missing Claude config folder lists nothing')
// ---- backfill ------------------------------------------------------------------
{
  const bstore = join(root, 'backfill.json')
  const cwd = join(root, 'Drafts', 'untitled 1')
  mkdirSync(cwd, { recursive: true })
  ok(projectDirName(cwd).replace(/[^a-zA-Z0-9-]/g, '') === projectDirName(cwd), 'project dir name has only alphanumerics and dashes')
  const proj = projectDirName(cwd)
  const E1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const E2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const E3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  transcript(proj, E1, [{ type: 'user', timestamp: '2026-10-01T10:00:00.000Z', message: { content: 'deck doc-bf here' } }])
  transcript(proj, E2, [{ type: 'user', timestamp: '2026-10-02T10:00:00.000Z', message: { content: 'other draft doc-other' } }])
  const cache = new Map<string, number>()
  const key = { docId: 'doc-bf', path: null }
  ok(backfillChats(bstore, config, cwd, key, cache) === 1, 'the transcript mentioning the docId is claimed')
  const rec = loadRecords(bstore).find((r) => r.id === E1)
  ok(rec?.docId === 'doc-bf' && rec.startedAt === Date.parse('2026-10-01T10:00:00.000Z'), '…with the docId and its first timestamp')
  ok(!loadRecords(bstore).some((r) => r.id === E2), "a different draft's transcript in the same folder is ignored")
  ok(backfillChats(bstore, config, cwd, key, cache) === 0, 'claiming happens once')
  ok(cache.has(E2), 'a rejected transcript is remembered, keyed by size')
  transcript(proj, E3, [{ type: 'user', message: { content: 'doc-bf again' } }])
  ok(backfillChats(bstore, config, cwd, key, cache) === 1, 'a later transcript is picked up')
  ok(backfillChats(bstore, config, cwd, { docId: null, path: null }, cache) === 0, 'no docId and no path claims nothing')
  ok(listChats(bstore, config, key).length === 2, 'claimed chats show in the deck history')
}

// ---- open-tab titles: a live transcript is read in steps -------------------------
{
  const file = join(root, 'live.jsonl')
  const first = line({ type: 'user', message: { content: 'Tighten the agenda slide' } })
  writeFileSync(file, first + '\n' + '{"type":"ai-ti')
  let r = tailTranscriptTitle(file, null)
  ok(r.title === 'Tighten the agenda slide', 'a new tab is titled by its first prompt')
  ok(r.tail.offset === first.length + 1, '…and a half-written last line is left for later')
  appendFileSync(file, 'tle","aiTitle":"agenda-tightening"}\n')
  r = tailTranscriptTitle(file, r.tail)
  ok(r.title === 'agenda-tightening', 'the line finished later is read, with the generated title winning')
  appendFileSync(file, line({ type: 'custom-title', customTitle: 'Agenda ✂' }) + '\n')
  r = tailTranscriptTitle(file, r.tail)
  ok(r.title === 'Agenda ✂', 'a /rename appended later wins, multibyte text intact')
  writeFileSync(file, line({ type: 'user', message: { content: 'fresh start' } }) + '\n')
  ok(tailTranscriptTitle(file, r.tail).title === 'fresh start', 'a file that shrank is read again from the start')
  ok(tailTranscriptTitle(join(root, 'missing.jsonl'), null).title === null, 'a missing transcript has no title and does not throw')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
