#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Desktop document-file rig.
//
//   node scripts/test-desktop-docfile.ts
//
// WHAT THIS PROVES. Since the desktop shell writes decks itself
// (desktop/src/main/documents.ts), the main process decides — without a DOM —
// what a file is, whether a renderer's bytes are safe to put on disk, and
// whether the file changed under us. Each check here is one way that decision
// could overwrite someone's work: a dev page or truncated shell accepted as a
// deck, a template bound for write-back, a path escaping its folder, a
// deleted file silently recreated, an external edit clobbered.

import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, chmodSync, existsSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  docKindOfText,
  extractDocBlock, extractDocBlockText, detectFormat, isTemplateHtml, openAsFor, readTitle, isInside,
  looksLikeShell, decideWrite, backupsToPrune,
} from '../desktop/src/main/docfile.ts'
import { writeFileAtomic } from '../desktop/src/main/fsutil.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const block = (json: unknown | string) =>
  `<script type="application/slidomingo+json" id="slidomingo-doc">\n${typeof json === 'string' ? json : JSON.stringify(json).replace(/</g, '\\u003c')}\n</script>`
const shell = (body: string, pad = 120_000) =>
  `<!DOCTYPE html>\n<html><head><title>Deck — BeeSlides</title>${body}</head><body>` +
  `<script id="slidomingo-rt" type="application/octet-stream">${'x'.repeat(pad)}</script></body>\n</html>\n`

const deck = { format: 'slidomingo/slides', title: 'Quarterly <review>', slides: [{ id: 's1', elements: [] }] }

// ---- extraction ----------------------------------------------------------------
ok(extractDocBlockText(shell(block(''))) === '', 'a pristine shell has an EMPTY block, not a missing one')
ok(extractDocBlockText('<html></html>') === null, 'no block at all reads as null')
ok((extractDocBlock(shell(block(deck))) as any)?.title === 'Quarterly <review>', 'the \\u003c-escaped JSON round-trips exactly')

// ---- format detection ------------------------------------------------------------
ok(detectFormat(shell(block(deck))) === 'slides', 'a slides deck is "slides"')
ok(detectFormat(shell(block({ format: 'slidomingo/enc', v: 1, data: 'x' }))) === 'enc', 'an envelope is "enc"')
ok(detectFormat(shell(block({ format: 'slidomingo/spaces', pages: [] }))) === 'other', 'another app\'s file is "other" (served by its own old shell, never rewritten)')
ok(detectFormat(shell(block(''))) === 'empty', 'a pristine shell is "empty"')
ok(detectFormat(shell(block('{not json'))) === 'none', 'an unparseable block is "none"')
ok(isTemplateHtml(shell(block({ ...deck, template: true }))), 'a template file is recognized')
ok(!isTemplateHtml(shell(block(deck))), 'an ordinary deck is not a template')

// ---- what an open binds (windows.ts resolveOpen) ------------------------------
{
  const tmpl = shell(block({ ...deck, template: true, templateId: 't-1' }))
  ok(openAsFor(tmpl) === 'from-template', 'a template opened normally starts a NEW draft — the file is never bound')
  ok(openAsFor(tmpl, { editTemplate: true }) === 'template', 'Edit Template binds the template file itself')
  ok(openAsFor(shell(block(deck)), { editTemplate: true }) === 'template',
    'Edit Template on a flag-less file in the folder binds it as a template (the first save stamps it)')
  ok(openAsFor(shell(block(deck))) === 'deck', 'a deck is bound as a deck')
  ok(openAsFor(shell(block({ format: 'slidomingo/enc', v: 1, data: 'x' })), { editTemplate: true }) === 'deck',
    'an encrypted file is never a template window')
  ok(openAsFor(shell(block(''))) === 'blank' && openAsFor(shell(block('')), { editTemplate: true }) === 'blank', 'a pristine shell is a blank draft')
  ok(openAsFor(shell(block({ format: 'slidomingo/spaces', pages: [] })), { editTemplate: true }) === 'legacy',
    'another app\'s file is loaded as-is either way')
}

// ---- title ------------------------------------------------------------------------
ok(readTitle(shell(block(deck))) === 'Quarterly <review>', 'the title comes from the JSON')
ok(readTitle(shell(block({ format: 'slidomingo/enc', v: 1 }))) === 'Deck', 'an encrypted deck falls back to <title> minus the app suffix')

// ---- containment ------------------------------------------------------------------
ok(isInside('/a/b/c.html', '/a/b'), 'a file in the folder is inside')
ok(isInside('/a/b', '/a/b'), 'the folder itself is inside')
ok(!isInside('/a/b/../c.html', '/a/b'), '.. cannot escape')
ok(!isInside('/a/bc/x.html', '/a/b'), 'a sibling folder sharing a prefix is not inside')

// ---- shell sanity check before any write ------------------------------------------
ok(looksLikeShell(shell(block(deck))), 'a complete shell carrying a deck passes')
ok(looksLikeShell(shell(block({ format: 'slidomingo/enc', v: 1, data: 'x' }))), 'a complete shell carrying an envelope passes')
{
  const full = shell(block(deck))
  ok(!looksLikeShell(full.slice(0, full.length - 40)), 'a truncated shell (no </html>) is refused')
}
ok(!looksLikeShell(shell(block(''))), 'an empty shell is refused — writing it would erase the deck')
ok(!looksLikeShell(shell(block(deck), 10)), 'an implausibly small file is refused')
ok(!looksLikeShell(shell(block(deck)).replace('slidomingo-rt', 'vite-dev')), 'a page without the runtime payload (Vite dev index.html) is refused')
ok(!looksLikeShell(shell(block({ format: 'slidomingo/spaces' }))), 'another app\'s document is refused')

// ---- conflict decision --------------------------------------------------------------
ok(decideWrite(1000, { mtimeMs: 1000 }) === 'ok', 'unchanged mtime → write')
ok(decideWrite(1000, { mtimeMs: 1000.4 }) === 'ok', 'sub-millisecond float noise is not a conflict')
ok(decideWrite(1000, { mtimeMs: 5000 }) === 'conflict', 'mtime moved without us → conflict')
ok(decideWrite(1000, null) === 'missing', 'a file deleted while open is "missing" — never silently recreated')
ok(decideWrite(null, null) === 'ok', 'a draft with no file yet may be created')
ok(decideWrite(null, { mtimeMs: 1 }) === 'ok', 'a path never stat-ed before is written (first write of a Save As target)')

// ---- backup pruning ------------------------------------------------------------------
{
  const now = Date.now()
  const day = 86_400_000
  const entries = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ name: `b${i}`, mtimeMs: now - i * 1000 }))
  const doomed = backupsToPrune(entries, now)
  ok(doomed.length === 2 && doomed.includes('b5') && doomed.includes('b6'), `keeps the newest 5 (dropped ${doomed.join(',')})`)
  const old = backupsToPrune([{ name: 'new', mtimeMs: now }, { name: 'old', mtimeMs: now - 31 * day }], now)
  ok(old.length === 1 && old[0] === 'old', 'drops anything older than 30 days even under the count cap')
}

// ---- atomic write ---------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'slidomingo-docfile-'))
  const p = join(dir, 'Deck.beeslides.html')
  writeFileAtomic(p, 'one')
  ok(readFileSync(p, 'utf8') === 'one', 'writeFileAtomic creates a new file')
  chmodSync(p, 0o600)
  writeFileAtomic(p, 'two ✓')
  ok(readFileSync(p, 'utf8') === 'two ✓', 'writeFileAtomic replaces content (utf-8 intact)')
  ok((statSync(p).mode & 0o777) === 0o600, 'the existing file\'s permission bits survive the rename')
  ok(readdirSync(dir).length === 1, 'no tmp file is left behind')
  let threw = false
  try { writeFileAtomic(join(dir, 'missing-dir', 'x.html'), 'x') } catch { threw = true }
  ok(threw && !existsSync(join(dir, 'missing-dir')), 'a failed write throws and creates nothing')
  writeFileSync(p, 'kept') // sanity: plain writes still work on the renamed inode
}

// ---- atomic write through a symlink ---------------------------------------------------
// A deck reached through a link (a synced folder linked into ~/Documents) must
// keep the link and update the real file — renaming onto the link replaced it
// with a regular file, and the real copy never saw another edit.
{
  const dir = mkdtempSync(join(tmpdir(), 'slidomingo-docfile-link-'))
  mkdirSync(join(dir, 'real'))
  mkdirSync(join(dir, 'link'))
  const real = join(dir, 'real', 'Deck.beeslides.html')
  writeFileSync(real, 'old')
  const link = join(dir, 'link', 'Deck.beeslides.html')
  symlinkSync('../real/Deck.beeslides.html', link)
  writeFileAtomic(link, 'new')
  ok(lstatSync(link).isSymbolicLink(), 'a symlinked path is still a symlink after the write')
  ok(readFileSync(real, 'utf8') === 'new', 'the link\'s real target got the new content')
  ok(readdirSync(join(dir, 'link')).length === 1 && readdirSync(join(dir, 'real')).length === 1, 'no tmp file is left beside the link or the target')
  // a directory link on the way works the same
  symlinkSync(join(dir, 'real'), join(dir, 'dirlink'))
  writeFileAtomic(join(dir, 'dirlink', 'Deck.beeslides.html'), 'via dir')
  ok(readFileSync(real, 'utf8') === 'via dir', 'a path through a linked folder writes the real file')
}

// --- doc kind (recent list / drafts: figures and icon sets go to the Figure column)
ok(docKindOfText('{"format":"slidomingo/slides","kind":"figure"}') === 'figure', 'a figure is recognised from the raw block')
ok(docKindOfText('{"kind" : "iconset","iconset":{"grid":24}}') === 'iconset', 'an icon set too')
ok(docKindOfText('{"title":"kind: iconset"}') === null && docKindOfText('{"kind":"deck"}') === null, 'anything else is a deck')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
