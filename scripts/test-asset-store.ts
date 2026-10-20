#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Asset-store rig.
//
//   node scripts/test-asset-store.ts
//
// WHAT THIS PROVES. A plaintext file stores every embedded byte once, in
// `#beeslides-assets` (kernel/src/assetstore.ts), and its JSON refers to it
// as `beeslides-store:<id>`. Everything that reads a file WITHOUT a DOM —
// the desktop main process, templates, node tooling — resolves those refs
// with the pure-string half checked here. A bug in it does not crash
// anything: it silently opens a deck without its pictures, and the next save
// writes that loss to disk. So each check is one way bytes could go missing:
// a hash that disagrees with the one the renderer computed, a CSS escape that
// does not decode back to the same URI, an attribute entity left encoded, a
// dangling ref dropped instead of kept, or an old file no longer passed
// through byte for byte.
//
// The DOM half (writing the store while saving) is verified in a browser and
// by the desktop e2e; see docs/DECISIONS.md 2026-09-28.

import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assetId, cssString, cssUnstring, decodeEntities, externalizeAssets, fontRule, imageRule, parseStoreCss,
  parseStoreHtml, resolveAssets, resolveDocText, sha256Hex, storeClass, storeRefsIn, ASSET_STORE_FEATURE,
} from '../kernel/src/assetstore.ts'
import { lightDoc, storeOf } from '../kernel/src/assetstore.ts'
import { canonicalJson } from '../kernel/src/doc.ts'
import { extractDocBlock, extractDocBlockText, detectFormat, isTemplateHtml, readTitle } from '../desktop/src/main/docfile.ts'
import { loadTemplateIn } from '../desktop/src/main/templatefs.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

console.log('\nids')
{
  let same = true
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 1000, 70_000]) {
    const b = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255)
    if (sha256Hex(b) !== createHash('sha256').update(b).digest('hex')) same = false
  }
  ok(same, 'sha256Hex matches node:crypto at every padding boundary')
  const uri = 'data:image/png;base64,iVBORw0KGgo='
  const want = 'sha256-' + createHash('sha256').update(uri, 'utf8').digest('hex').slice(0, 16)
  ok(assetId(uri) === want, `assetId = sha256 of the URI's UTF-8 text, 16 hex (${assetId(uri)})`)
  ok(assetId(uri) === assetId(uri.slice()), 'content-addressed: equal strings, equal ids')
  ok(storeClass(want) === 'sa-' + want.slice(7), 'the class is sa-<16 hex>')
}

console.log('\nCSS strings')
{
  const nasty = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><style>a{b:"c\\d"}</style>\r\n</svg>'
  ok(!cssString(nasty).includes('<') && !cssString(nasty).includes('"'), 'cssString leaves no < and no bare "')
  ok(cssUnstring(cssString(nasty)) === nasty, 'cssUnstring(cssString(x)) === x, with <, quotes, backslash, CR/LF')
  ok(cssUnstring('a\\3c b\\22 c\\5c d') === 'a<b"c\\d', 'standard CSS hex escapes decode (one trailing space eaten)')
  const id = assetId(nasty)
  const fid = assetId('data:font/woff2;base64,d09GMgAB')
  const css = imageRule(id, nasty) + '\n' + fontRule(fid, 'data:font/woff2;base64,d09GMgAB', { family: 'Brace {"x"} </style>', weight: '700', style: 'italic' })
  ok(!css.includes('<'), 'store rules never contain <, even for an author family name with </style>')
  const m = parseStoreCss(css)
  ok(m.get(id) === nasty && m.get(fid) === 'data:font/woff2;base64,d09GMgAB', 'parseStoreCss reads both rule kinds back exactly')
  ok(fontRule(fid, 'data:x', { family: 'F', weight: '700;}body{display:none' }).includes('font-weight:normal'), 'a weight that is not a plain token never reaches the sheet')
}

console.log('\nresolve / externalize')
{
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(4000)
  const clip = 'data:video/mp4;base64,' + 'B'.repeat(3000)
  const doc = { format: 'beeslides/slides', assets: { photo }, slides: [{ elements: [{ src: photo }, { src: clip }, { src: 'asset:photo' }] }] }
  const stored = new Map([[photo, assetId(photo)], [clip, assetId(clip)]])
  const { doc: ext, refs } = externalizeAssets(doc, stored)
  const text = JSON.stringify(ext)
  ok(refs === 3 && !text.includes('AAAA') && !text.includes('BBBB'), 'every stored URI becomes a ref; asset: keys untouched')
  ok((ext as { requires?: string[] }).requires?.[0] === ASSET_STORE_FEATURE, 'the result declares requires: [asset-store]')
  ok(!('requires' in doc), 'the input document is not mutated')
  const store = new Map([[assetId(photo), photo], [assetId(clip), clip]])
  const back = resolveAssets(ext, store)
  ok(JSON.stringify(back.doc) === JSON.stringify(doc) && back.dangling.length === 0, 'resolveAssets restores the exact document and drops asset-store from requires')
  const partial = resolveAssets(ext, new Map([[assetId(photo), photo]]))
  ok(partial.dangling.length === 1 && JSON.stringify(partial.doc).includes('beeslides-store:' + assetId(clip)), 'a ref the store lacks is kept verbatim and reported')
  ok((partial.doc as { requires?: string[] }).requires?.includes(ASSET_STORE_FEATURE) === true, '…and asset-store stays declared while any ref remains')
  ok(storeRefsIn(ext).size === 2, 'storeRefsIn counts distinct refs')
  const other = { requires: ['x-other'], a: photo }
  const e2 = externalizeAssets(other, stored).doc as { requires: string[] }
  ok(JSON.stringify(e2.requires) === '["x-other","asset-store"]', 'other requires names are kept, asset-store appended')
  const bad = { requires: 'nonsense', a: photo }
  ok((externalizeAssets(bad, stored).doc as { requires: unknown }).requires === 'nonsense', 'a malformed requires is left for the gate, never rewritten')
}

console.log('\nfiles (no DOM)')
{
  const photo = 'data:image/jpeg;base64,' + 'C'.repeat(5000)
  const amp = 'data:image/svg+xml,%3Csvg%3E&amp;%3C/svg%3E'
  const clip = 'data:video/mp4;base64,' + 'D'.repeat(3000)
  const poster = 'data:image/jpeg;base64,' + 'E'.repeat(2500)
  const raw = { format: 'beeslides/slides', title: 'Store <deck>', template: true, requires: ['asset-store'], assets: { photo, amp },
    slides: [{ id: 's1', elements: [{ id: 'v', type: 'media', src: `beeslides-store:${assetId(clip)}`, poster: `beeslides-store:${assetId(poster)}` }, { src: 'beeslides-store:sha256-00000000deadbeef' }] }] }
  const body = JSON.stringify(externalizeAssets(raw, new Map([[photo, assetId(photo)], [amp, assetId(amp)]])).doc).replace(/</g, '\\u003c')
  // how a DOM serializer writes attribute values: & → &amp;, " → &quot;
  const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const html = `<!DOCTYPE html>\n<html><head><title>Store — BeeSlides</title>` +
    `<script type="application/beeslides+json" id="beeslides-doc">\n${body}\n</script>` +
    `<style id="beeslides-assets" data-beeslides-assets="1">\n${imageRule(assetId(photo), photo)}\n${imageRule(assetId(amp), amp)}\n</style></head><body>` +
    `<div id="beeslides-static" data-beeslides-static="1"><video controls="" data-beeslides-store="${assetId(clip)}" data-beeslides-poster="${assetId(poster)}" src="${attr(clip)}" poster="${attr(poster)}"></video></div>` +
    `<script id="beeslides-rt" type="application/octet-stream">x</script></body>\n</html>\n`
  ok(decodeEntities('a&amp;b&quot;c&#39;d&#x3c;&nbsp;') === 'a&b"c\'d<\u00a0', 'decodeEntities undoes what a serializer writes')
  const store = parseStoreHtml(html)
  ok(store.get(assetId(photo)) === photo && store.get(assetId(amp)) === amp, 'parseStoreHtml reads the <style> store')
  ok(store.get(assetId(clip)) === clip && store.get(assetId(poster)) === poster, 'parseStoreHtml reads media that carry their own bytes (src and poster)')
  const text = extractDocBlockText(html)!
  const j = JSON.parse(text)
  ok(j.assets.photo === photo && j.assets.amp === amp && j.slides[0].elements[0].src === clip && j.slides[0].elements[0].poster === poster,
    'docfile.extractDocBlockText hands the renderer a resolved document')
  ok(j.slides[0].elements[1].src === 'beeslides-store:sha256-00000000deadbeef', 'a dangling ref survives resolution')
  ok((extractDocBlock(html) as { title: string }).title === 'Store <deck>', 'extractDocBlock is resolved too, and keeps escaping semantics')
  ok(detectFormat(html) === 'slides' && isTemplateHtml(html) && readTitle(html) === 'Store <deck>', 'format/template/title checks read the raw block unchanged')

  const plain = `<script type="application/beeslides+json" id="beeslides-doc">\n${JSON.stringify({ format: 'beeslides/slides', a: photo }).replace(/</g, '\\u003c')}\n</script>`
  const plainText = plain.match(/>\n([\s\S]*)\n</)![1]
  ok(resolveDocText(plainText, plain) === plainText, 'a file with no refs passes through byte for byte')
  const envText = JSON.stringify({ format: 'beeslides/enc', v: 1, data: 'beeslides-store:x' })
  ok(resolveDocText(envText, html) === envText, 'an encryption envelope is never touched')

  const dir = mkdtempSync(join(tmpdir(), 'beeslides-store-'))
  const tp = join(dir, 'Store.beeslides.html')
  writeFileSync(tp, html)
  const t = loadTemplateIn(dir, tp)
  ok(!!t && JSON.parse(t).assets.photo === photo, 'templatefs.loadTemplateIn resolves a store-format template')
}

console.log('\nreadable JSON + light copies')
{
  const photo = 'data:image/png;base64,' + 'F'.repeat(3000)
  const a = { slides: [{ y: 2, x: 1, type: 'image', id: 'e1', src: photo }], title: 'T', docId: 'd', version: 1, format: 'beeslides/slides', assets: { z: photo, a: 'x' } }
  const b = { format: 'beeslides/slides', assets: { a: 'x', z: photo }, version: 1, docId: 'd', title: 'T', slides: [{ id: 'e1', src: photo, type: 'image', x: 1, y: 2 }] }
  const ca = canonicalJson(a)
  ok(ca === canonicalJson(b), 'canonicalJson depends on content only, never on key insertion order')
  ok(ca.startsWith('{\n  "format": "beeslides/slides",\n  "version": 1,\n  "docId": "d",\n  "title": "T",'), 'identity keys lead, two-space indent')
  ok(/"id": "e1",\n\s+"type": "image",\n\s+"src"/.test(ca), 'elements lead with id, type; the rest alphabetical')
  ok(JSON.stringify(JSON.parse(ca)) === JSON.stringify(JSON.parse(canonicalJson(JSON.parse(ca)))), 'parses back and is a fixed point')
  const light = lightDoc(a)
  const lt = JSON.stringify(light)
  ok(!lt.includes('FFFF') && lt.includes('beeslides-store:' + assetId(photo)) && (light as { requires?: string[] }).requires?.[0] === ASSET_STORE_FEATURE,
    'lightDoc: every data: string becomes its hash ref, declared')
  const back = resolveAssets(light, storeOf(b))
  ok(canonicalJson(back.doc) === ca && back.dangling.length === 0, 'a light copy resolves by hash against any doc holding the bytes')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
