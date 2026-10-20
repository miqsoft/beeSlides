#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Legacy-names rig.
//
//   node scripts/test-legacy-names.ts
//
// WHAT THIS PROVES. Files saved before 2026-10-20 say `slidomingo` wherever a
// file says `beeslides` now: `#slidomingo-doc`, `slidomingo/slides`,
// `slidomingo/enc`, `slidomingo-store:` refs, `#slidomingo-assets`,
// `data-slidomingo-*` (kernel/src/legacynames.ts, docs/DECISIONS.md
// 2026-10-20). Every reader must still open them — the page's model, the
// kernel's asset store, the desktop main process's file readers and its
// thumbnail scanner — and what they hand on must carry only the new names,
// so the next save converts the file.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assetId, externalizeAssets, imageRule, isStoreRef, parseStoreHtml, refFor, resolveDocText, storeRefsIn,
} from '../kernel/src/assetstore.ts'
import { currentFormat, isEncFormat } from '../kernel/src/legacynames.ts'
import { detectFormat, extractDocBlock, rawDocBlockText } from '../desktop/src/main/docfile.ts'
import { scanThumbSource } from '../desktop/src/main/thumbscan.ts'
import { readTemplateMeta } from '../desktop/src/main/templatefs.ts'
import { parseDoc } from '../slides/src/model'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const ID = assetId(PNG)
const MP4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29t'
const VID = assetId(MP4)

// A deck as a pre-rename build wrote it: old block, old format, old refs,
// old store, old media attribute, old preview and static-layer markers.
const oldDeck = {
  format: 'slidomingo/slides',
  version: 1,
  docId: '0f1e2d3c-4b5a-4968-8776-655443322110',
  title: 'Pre-rename deck',
  size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#111111', accent: '#9a5f00', fontFamily: 'sans-serif' },
  requires: ['asset-store'],
  slides: [{
    id: 's1', background: '#ffffff', transition: 'fade', notes: '',
    elements: [
      { id: 'e1', type: 'image', x: 0, y: 0, w: 100, h: 100, src: 'slidomingo-store:' + ID },
      { id: 'e2', type: 'video', x: 0, y: 0, w: 100, h: 100, src: 'slidomingo-store:' + VID },
    ],
  }],
}
const legacyFile = (json: unknown, pad = 120_000) =>
  '<!DOCTYPE html>\n<html><head><title>Deck — BeeSlides</title>' +
  `<script type="application/slidomingo+json" id="slidomingo-doc">\n${JSON.stringify(json).replace(/</g, '\\u003c')}\n</script>` +
  `<style id="slidomingo-assets" data-slidomingo-assets="1">${imageRule(ID, PNG)}</style>` +
  '</head><body>' +
  '<div data-slidomingo-preview="1"><div style="transform:scale(calc(min(100vw, 177.77778vh) / 1280px))"></div></div>' +
  '<script data-slidomingo-preview="1">/* remover */</script>' +
  `<div id="slidomingo-static" data-slidomingo-static="1"><video data-slidomingo-store="${VID}" src="${MP4}"></video></div>` +
  `<script id="slidomingo-rt" type="slidomingo/deflate-b64">${'x'.repeat(pad)}</script></body>\n</html>\n`

const html = legacyFile(oldDeck)

console.log('kernel: names')
ok(currentFormat('slidomingo/slides') === 'beeslides/slides', 'slidomingo/slides takes its new name')
ok(currentFormat('beeslides/slides') === 'beeslides/slides', 'a current format is left as it is')
ok(currentFormat(undefined) === undefined, 'a missing format stays missing')
ok(isEncFormat('slidomingo/enc') && isEncFormat('beeslides/enc'), 'an envelope is recognised under either name')

console.log('kernel: asset store')
ok(isStoreRef('slidomingo-store:' + ID) && isStoreRef(refFor(ID)), 'a ref is recognised under either prefix')
ok(refFor(ID).startsWith('beeslides-store:'), 'new refs use the new prefix')
const store = parseStoreHtml(html)
ok(store.get(ID) === PNG, 'the old #slidomingo-assets style is read')
ok(store.get(VID) === MP4, 'an old data-slidomingo-store video is read')
ok(storeRefsIn(oldDeck).has(ID) && storeRefsIn(oldDeck).has(VID), 'old refs are listed by their ids')
const resolved = JSON.parse(resolveDocText(JSON.stringify(oldDeck), html))
ok(resolved.slides[0].elements[0].src === PNG && resolved.slides[0].elements[1].src === MP4, 'old refs resolve against the old store')
ok(!('requires' in resolved), 'nothing dangles, so asset-store leaves requires')
const dangling = JSON.parse(resolveDocText(JSON.stringify(oldDeck), '<html></html>'))
ok(dangling.slides[0].elements[0].src === refFor(ID), 'a dangling old ref is kept, under the new prefix')
const { doc: ext } = externalizeAssets({ src: 'slidomingo-store:' + ID }, new Map())
ok((ext as { src: string }).src === refFor(ID), 'externalize rewrites an old ref to the new prefix')

console.log('slides: model')
const parsed = parseDoc(resolveDocText(JSON.stringify(oldDeck), html))
ok(parsed !== null, 'parseDoc opens a slidomingo/slides deck')
ok(parsed?.format === 'beeslides/slides', 'and hands it on as beeslides/slides')
ok(parsed?.docId === oldDeck.docId, 'with its docId unchanged')
ok(!JSON.stringify(parsed).includes('slidomingo'), 'and no old name left anywhere in it')

console.log('desktop: file readers')
ok(rawDocBlockText(html)?.includes('"Pre-rename deck"') === true, 'the #slidomingo-doc block is found')
ok(detectFormat(html) === 'slides', 'detectFormat: an old deck is a slides deck')
const extracted = extractDocBlock(html) as typeof oldDeck | null
ok(extracted?.slides[0].elements[0].src === PNG, 'extractDocBlock resolves old refs')
const encHtml = legacyFile({ format: 'slidomingo/enc', v: 1, it: 300000, salt: 'AA', iv: 'AA', data: 'AA' })
ok(detectFormat(encHtml) === 'enc', 'detectFormat: an old envelope is encrypted')

const dir = mkdtempSync(join(tmpdir(), 'slidomingo-legacy-'))
const deckPath = join(dir, 'Old.slidomingo.html')
writeFileSync(deckPath, html)
const thumb = await scanThumbSource(deckPath)
ok(thumb.kind === 'preview', `the thumbnail scanner finds an old file's preview (${thumb.kind})`)
ok(thumb.kind === 'preview' && thumb.hasStatic === true, 'and its old static layer')
const encPath = join(dir, 'Locked.slidomingo.html')
writeFileSync(encPath, encHtml)
ok((await scanThumbSource(encPath)).kind === 'enc', 'an old envelope is never thumbnailed')

const tplPath = join(dir, 'Old layout.slidomingo.html')
writeFileSync(tplPath, legacyFile({ ...oldDeck, template: true, templateId: 'tpl-1' }))
const meta = readTemplateMeta(tplPath)
ok(meta?.slideCount === 1 && meta.templateId === 'tpl-1', 'an old template is listed with its slides and id')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
