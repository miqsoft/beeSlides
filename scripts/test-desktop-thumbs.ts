#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Desktop thumbnail-source rig.
//
//   node scripts/test-desktop-thumbs.ts
//
// WHAT THIS PROVES. desktop/src/main/thumbscan.ts decides, from bytes alone,
// whether the start page renders a deck's embedded first-page preview, draws
// a lock, or draws a plain document tile. Getting it wrong either leaks page
// one of a password-protected deck (AGENTS.md rule 4) or shows the boot
// splash as every deck's face. The render itself is covered by
// desktop/scripts/e2e-thumbnail.mjs.

import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanThumbSource, previewPageSize, thumbCacheName, THUMB_CACHE_VERSION } from '../desktop/src/main/thumbscan.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const dir = mkdtempSync(join(tmpdir(), 'slidomingo-thumbs-'))
let n = 0
function file(html: string): string {
  const p = join(dir, `f${n++}.beeslides.html`)
  writeFileSync(p, html)
  return p
}

const HEAD_COMMENT = '<!-- The document is the ONE script block, id "slidomingo-doc", below -->'
const docBlock = (json: string) => `<script type="application/slidomingo+json" id="slidomingo-doc">\n${json}\n</script>`
const fit = (w: number, h: number) =>
  `<div style="position:fixed"><style>._0{position:absolute}</style><div style="position:absolute;width:${w}px;height:${h}px;` +
  `transform:translate(-50%,-50%);transform:translate(-50%,-50%) scale(calc(min(100vw, ${((w / h) * 100).toFixed(2)}vh) / ${w}px))"></div></div>`
const preview = (w = 1280, h = 720) =>
  `<div data-slidomingo-preview="1">${fit(w, h)}</div><script data-slidomingo-preview="1">(function(){var a=document.querySelectorAll('[data-slidomingo-preview]')})()</script>`
const shell = (json: string, body: string) =>
  `<!doctype html><html><head>${HEAD_COMMENT}${docBlock(json)}</head><body><div id="slidomingo-splash"></div>${body}` +
  `<script id="slidomingo-rt-css" type="slidomingo/deflate-b64">AAAA</script><script id="slidomingo-rt">BBBB</script></body></html>`
const SLIDES = '{"format":"slidomingo/slides","version":1,"title":"T","size":{"width":1280,"height":720}}'

console.log('classification')
{
  const r = await scanThumbSource(file(shell(SLIDES, preview())))
  ok(r.kind === 'preview' && r.width === 1280 && r.height === 720, `saved deck → preview 1280×720 (${JSON.stringify(r)})`)
}
{
  const r = await scanThumbSource(file(shell('{"format":"slidomingo/enc","v":1,"data":"xx"}', preview())))
  ok(r.kind === 'enc', 'encrypted envelope → enc, even if a stale preview host were present')
}
ok((await scanThumbSource(file(shell('', '')))).kind === 'none', 'pristine shell (empty block) → none')
ok((await scanThumbSource(file(shell(SLIDES, '')))).kind === 'none', 'deck saved by an older build, no preview → none')
ok((await scanThumbSource(file('<!doctype html><html><body><div data-slidomingo-preview="1">x</div></body></html>'))).kind === 'none',
  'not a BeeSlides file (no doc block), even with a host-shaped div → none')
ok((await scanThumbSource(file(shell('{not json', preview())))).kind === 'none', 'unparseable doc block → none')
{
  // User text mentioning the attribute lives in the doc block (JSON escapes `<`).
  const json = SLIDES.replace('"T"', '"\\u003cdiv data-slidomingo-preview=\\"1\\"\\u003e"')
  ok((await scanThumbSource(file(shell(json, '')))).kind === 'none', 'attribute text inside the doc block is not a host')
}
{
  const r = await scanThumbSource(file(shell(SLIDES, preview().replace(/<div data-slidomingo-preview="1">/, '<noscript data-slidomingo-preview="1">').replace('</div><script', '</noscript><script'))))
  ok(r.kind === 'preview', 'older build\'s <noscript> host → preview')
}
{
  const r = await scanThumbSource(file(shell(SLIDES, preview(1024, 768))))
  ok(r.kind === 'preview' && r.width === 1024 && r.height === 768, `4:3 page size read from the fit transform (${JSON.stringify(r)})`)
}
{
  // Doc block spanning several 1 MB chunks; the host lands across a boundary.
  for (const pad of [1 << 20, (1 << 20) - 60, (3 << 20) + 7]) {
    const json = SLIDES.replace('"T"', `"${'x'.repeat(pad)}"`)
    const r = await scanThumbSource(file(shell(json, preview())))
    ok(r.kind === 'preview' && r.width === 1280, `large doc block (+${pad} B) → preview`)
  }
}
console.log('static layer')
{
  const layer = '<div id="slidomingo-static" data-slidomingo-static="1"><div id="slidomingo-static-layer"><div data-slidomingo-static-slide="s1"></div></div></div>'
  const r = await scanThumbSource(file(shell(SLIDES, preview() + layer)))
  ok(r.kind === 'preview' && r.hasStatic === true && r.width === 1280, `preview + static layer → hasStatic (${JSON.stringify(r)})`)
  const r2 = await scanThumbSource(file(shell(SLIDES, preview())))
  ok(r2.kind === 'preview' && r2.hasStatic === false, 'preview only → hasStatic false (rendered as before)')
  // Only the per-slide attribute (never written without the host) is not the host.
  const r3 = await scanThumbSource(file(shell(SLIDES, preview() + '<div data-slidomingo-static-slide="s1"></div>')))
  ok(r3.kind === 'preview' && r3.hasStatic === false, 'a per-slide attribute alone is not the layer')
  // The layer's tag lands well past the first chunk (a big preview pads it out).
  const bigPreview = preview().replace('</style>', `</style><!--${'p'.repeat((1 << 20) + 500)}-->`)
  const r4 = await scanThumbSource(file(shell(SLIDES, bigPreview + layer)))
  ok(r4.kind === 'preview' && r4.hasStatic === true, 'found across a chunk boundary')
  // Mentioned in the doc block (user text) but absent from the body.
  const json = SLIDES.replace('"T"', '"data-slidomingo-static=\\"1\\""')
  const r5 = await scanThumbSource(file(shell(json, preview())))
  ok(r5.kind === 'preview' && r5.hasStatic === false, 'marker text inside the doc block does not count')
}
{
  // what a save writes now: an indented, multi-line doc block (canonicalJson)
  // followed by the asset store, then the preview and the layer
  const pretty = JSON.stringify({ ...JSON.parse(SLIDES), requires: ['asset-store'], title: '\u003c/script> x', assets: { p: 'slidomingo-store:sha256-0123456789abcdef' } }, null, 2).replace(/</g, '\\u003c')
  const store = '<style id="slidomingo-assets" data-slidomingo-assets="1">\n/*sha256-0123456789abcdef*/.sa-0123456789abcdef{content:url("data:image/png;base64,AAAA")}\n</style>'
  const layer = '<div id="slidomingo-static" data-slidomingo-static="1"><div data-slidomingo-static-slide="s1"><div class="sa-0123456789abcdef" role="img"></div></div></div>'
  const r = await scanThumbSource(file(shell(pretty, preview() + layer).replace('</script>', '</script>' + store)))
  ok(r.kind === 'preview' && r.width === 1280 && r.hasStatic === true, `pretty-printed doc block + asset store → preview with layer (${JSON.stringify(r)})`)
}
{
  const name = thumbCacheName('abc', 1234.9)
  ok(name === `abc-1234-v${THUMB_CACHE_VERSION}.png` && THUMB_CACHE_VERSION >= 2,
    `cache files carry a version tag, so pre-static-layer PNGs regenerate (${name})`)
  ok(name.startsWith('abc-') && name.endsWith('.png'), 'and still match the stale-entry sweep (<hash>-*.png)')
}
{
  let rejected = false
  try { await scanThumbSource(join(dir, 'missing.html')) } catch { rejected = true }
  ok(rejected, 'missing file rejects (thumbs.ts maps it to a placeholder)')
}
ok(previewPageSize('no transform here').width === 1280, 'unreadable fit transform → default 1280×720')

const built = new URL('../slides/dist-single/BeeSlides.beeslides.html', import.meta.url)
if (existsSync(built)) {
  console.log('built shell')
  ok((await scanThumbSource(built.pathname)).kind === 'none', 'dist-single shell (splash only) → none')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
