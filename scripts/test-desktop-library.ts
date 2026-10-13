#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Desktop global-library rig.
//
//   node scripts/test-desktop-library.ts
//
// WHAT THIS PROVES. The desktop app creates the user's element library on
// first run and writes it on the renderer's behalf (desktop/src/main/
// library.ts, libraryfs.ts). Each check is one way that could lose or corrupt
// it: a first run that makes a file the editor can't open (parseDoc needs a
// slide and a theme), a second run that overwrites a library someone has
// filled, a `$` in the JSON read as a replace pattern, a truncated or
// encrypted write accepted, a deleted library silently recreated by a write.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLibraryAt, isLibraryCandidate, readLibraryAt, seedLibraryDoc, spliceDocBlock, writeLibraryAt } from '../desktop/src/main/libraryfs.ts'
import { extractDocBlock, looksLikeShell } from '../desktop/src/main/docfile.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const emptyBlock = '<script type="application/slidomingo+json" id="slidomingo-doc"></script>'
const shell = (block = emptyBlock, pad = 120_000) =>
  `<!DOCTYPE html>\n<html><head><title>BeeSlides</title>${block}</head><body>` +
  `<script id="slidomingo-rt" type="application/octet-stream">${'x'.repeat(pad)}</script></body>\n</html>\n`

const dir = mkdtempSync(join(tmpdir(), 'slidomingo-library-'))
const path = join(dir, 'BeeSlides Library.beeslides.html')

try {
  console.log('seed document')
  const seed = seedLibraryDoc() as { format: string; slides: Array<{ elements: unknown[] }>; theme?: unknown; size?: unknown; docId?: unknown }
  ok(seed.format === 'slidomingo/slides', 'is a slides document')
  ok(Array.isArray(seed.slides) && seed.slides.length === 1, 'has exactly one slide (parseDoc refuses zero)')
  ok(seed.slides[0].elements.length === 0, 'that slide is empty — the editor treats it as "no items"')
  ok(!!seed.theme && !!seed.size, 'carries theme and size (parseDoc fills no defaults for them)')
  ok(typeof seed.docId === 'string' && seed.docId !== (seedLibraryDoc() as { docId: string }).docId, 'mints a fresh docId each time')

  console.log('splice')
  const spliced = spliceDocBlock(shell(), { format: 'slidomingo/slides', title: 'a $& b </script> c', slides: [{ id: 's', elements: [] }] })
  ok(!!spliced, 'splices into a shell with a doc block')
  const back = extractDocBlock(spliced!) as { title?: string } | null
  ok(back?.title === 'a $& b </script> c', 'round-trips `$&` and `</script>` exactly')
  ok(!/<\/script> c/.test(spliced!), 'no literal script-close inside the block')
  ok(spliceDocBlock('<html></html>', {}) === null, 'refuses a file with no doc block')

  console.log('first run')
  ok(ensureLibraryAt(path, null) === false && !existsSync(path), 'no shell (unbuilt dev run) → no file, no crash')
  ok(ensureLibraryAt(path, shell()) === true && existsSync(path), 'creates the default library')
  const first = readLibraryAt(path)
  ok(first.ok && looksLikeShell(first.html), 'what it wrote reads back as a complete shell')
  ok(first.ok && first.name === 'BeeSlides Library.beeslides.html', 'reports the file name')
  ok(isLibraryCandidate(path), 'counts as a library file')

  console.log('second run keeps what is there')
  const filled = spliceDocBlock(shell(), { format: 'slidomingo/slides', title: 'Mine', slides: [{ id: 'item', name: 'Logo', elements: [{ id: 'e', type: 'shape' }] }] })!
  writeFileSync(path, filled)
  ok(ensureLibraryAt(path, shell()) === true, 'reports the existing file')
  ok(readFileSync(path, 'utf8') === filled, 'never overwrites a library someone filled')

  console.log('writes')
  const next = spliceDocBlock(filled, { format: 'slidomingo/slides', title: 'Renamed', slides: [{ id: 'item', name: 'Logo 2', elements: [] }] })!
  ok(writeLibraryAt(path, next) === true, 'accepts a complete shell carrying a slides deck')
  ok((extractDocBlock(readFileSync(path, 'utf8')) as { title?: string }).title === 'Renamed', 'and it lands on disk')
  ok(writeLibraryAt(path, next.slice(0, 5000)) === false, 'refuses a truncated write')
  ok(writeLibraryAt(path, spliceDocBlock(shell(), { format: 'slidomingo/enc', ct: 'x' })) === false, 'refuses an encrypted document')
  ok(writeLibraryAt(path, 42) === false, 'refuses a non-string')
  ok((extractDocBlock(readFileSync(path, 'utf8')) as { title?: string }).title === 'Renamed', 'a refused write leaves the file alone')
  rmSync(path)
  ok(writeLibraryAt(path, next) === false && !existsSync(path), 'a write never recreates a deleted library')

  console.log('reads')
  ok(!readLibraryAt(path).ok && (readLibraryAt(path) as { reason: string }).reason === 'missing', 'missing file → reason "missing"')
  const other = join(dir, 'other.beeslides.html')
  writeFileSync(other, spliceDocBlock(shell(), { format: 'slidomingo/spaces', pages: [] })!)
  ok((readLibraryAt(other) as { reason?: string }).reason === 'not-a-library', "another app's file is not a library")
  ok(!isLibraryCandidate(other), 'and cannot be chosen as one')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
