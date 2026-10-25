#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// File ▸ Export to ▸ PowerPoint, in the real editor (slides/src/editor/
// pptxexport.ts): a deck with a two-level slide-type tree goes out as a .pptx
// and the package is checked — the root type is a master, the types are its
// layouts, a slide keeps only its own content (inherited chrome stays on the
// master/layout) and fills the layout's slots, a moved slot keeps its own
// frame, $math$ becomes a picture, notes, hidden slides, sections, a slide
// jump, morph names — and it comes back through convertPptx as a linked tree.
//
//   node scripts/test-pptx-export-e2e.mjs [editor-url] [--out deck.pptx]
//
// editor-url defaults to slides/dist-single/BeeSlides.beeslides.html. That
// PowerPoint itself opens the result without repair was checked by hand
// (DECISIONS "PowerPoint export"); --out keeps the file for that.

import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined }
const out = opt('--out')
const { readZip } = await import(pathToFileURL(join(root, 'kernel/src/convert/zip.ts')).href)
const { convertPptx } = await import(pathToFileURL(join(root, 'kernel/src/convert/pptx.ts')).href)

async function loadChromium() {
  const tries = []
  if (process.env.PLAYWRIGHT_CORE) tries.push(pathToFileURL(process.env.PLAYWRIGHT_CORE).href)
  tries.push('playwright-core')
  const npx = join(homedir(), '.npm/_npx')
  if (existsSync(npx)) {
    for (const d of readdirSync(npx)) {
      const p = join(npx, d, 'node_modules/playwright-core/index.mjs')
      if (existsSync(p)) tries.push(pathToFileURL(p).href)
    }
  }
  for (const spec of tries) {
    try { return (await import(spec)).chromium } catch { /* next */ }
  }
  return null
}

const skip = (why) => { console.log(`test-pptx-export-e2e: SKIP — ${why}`); process.exit(0) }
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : null)
if (!url) skip('no build (npm run build:single in slides/) and no url given')
const chromium = await loadChromium()
if (!chromium) skip('playwright-core not found (set PLAYWRIGHT_CORE)')
let browser
try { browser = await chromium.launch() } catch (e) { skip(`no browser: ${String(e.message).split('\n')[0]}`) }

let fails = 0
let passes = 0
const check = (ok, label, detail) => {
  if (ok) { passes++; console.log(`  ok    ${label}`) }
  else { fails++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`) }
}

// ---- the deck -------------------------------------------------------------------
// Brand (root): a bar, a logo, the title slot, the slide number
//   └ Content: a stripe, a body slot, a media slot
// s1 Content (filled, picture in the media slot, $math$, notes)
// s2 Content (title moved, slots empty, a jump to s1, morph from s1)
// s3 no type · s4 hidden
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVQI12P4z8DAwPAfAAcAAf921adgAAAAAElFTkSuQmCC'
const base = { rotation: 0, opacity: 1 }
const text = (id, html, frame, extra = {}) => ({
  ...base, id, type: 'text', x: frame[0], y: frame[1], w: frame[2], h: frame[3], html, fontSize: 32, fontFamily: '',
  fontWeight: 400, color: '#1D1119', align: 'left', valign: 'top', lineHeight: 1.2, ...extra,
})
const rect = (id, frame, fill, extra = {}) => ({ ...base, id, type: 'shape', shape: 'rect', x: frame[0], y: frame[1], w: frame[2], h: frame[3], fill, stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
const TITLE = [80, 40, 1000, 90]
const brand = [
  rect('b-bar', [0, 690, 1280, 30], '#2563EB'),
  { ...rect('b-logo', [1180, 40, 50, 50], '#F59E0B'), shape: 'ellipse' },
  text('b-title', '', TITLE, { role: 'title', placeholder: 'Click to add title', fontSize: 44, fontWeight: 700 }),
  text('b-num', '{{page}}', [1100, 650, 100, 30], { fontSize: 14, align: 'right', footerRole: 'slideNumber' }),
]
const content = [
  rect('c-stripe', [0, 0, 12, 720], '#1E3A8A'),
  text('c-body', '', [80, 160, 560, 460], { role: 'body', placeholder: 'Click to add text' }),
  rect('c-media', [680, 160, 520, 460], '#F5EEF1', { stroke: '#DCCCD3', strokeWidth: 1.5, strokeStyle: 'dashed', radius: 8, role: 'media' }),
]
const types = [
  { id: 'brand', name: 'Brand', background: '#FFFFFF', transition: 'fade', notes: '', elements: brand, fontFamily: 'Georgia, serif' },
  { id: 'content', name: 'Content', parentId: 'brand', background: '#F8FAFC', transition: 'fade', notes: '', elements: content },
]
const copy = (els, patch = {}) => els.map((e) => ({ ...JSON.parse(JSON.stringify(e)), ...(patch[e.id] ?? {}) }))
const slides = [
  { id: 's1', layoutId: 'content', background: '#F8FAFC', transition: 'fade', notes: 'Say hello first\nthen the agenda', elements: [
    ...copy(brand, { 'b-title': { html: 'Agenda' } }),
    ...copy(content.filter((e) => e.id !== 'c-media'), { 'c-body': { html: '<ul><li>One</li><li>Two</li></ul>' } }),
    { ...base, id: 'c-media', type: 'image', x: 680, y: 160, w: 520, h: 460, src: PNG, fit: 'fill', role: 'media', alt: 'red and blue' },
    text('math', 'Area $a^2$', [80, 560, 400, 60]),
  ] },
  { id: 's2', layoutId: 'content', background: '#F8FAFC', transition: 'morph', notes: '', elements: [
    ...copy(brand, { 'b-title': { html: 'Details', x: 200 } }),
    ...copy(content),
    rect('back', [80, 600, 140, 40], '#111827', { link: 's1' }),
  ] },
  { id: 's3', background: '#0F172A', transition: 'push', transitionDir: 'bottom', notes: '', elements: [text('free', 'No slide type', [100, 100, 600, 80], { color: '#FFFFFF' })] },
  { id: 's4', background: '#FFFFFF', transition: 'fade', notes: '', hidden: true, elements: [text('h', 'Backup', [100, 100, 600, 80])] },
]

const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })
page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
let bytes
try {
  await page.goto(url)
  await page.waitForFunction(() => !!window.beeslides?.loadDoc, null, { timeout: 30_000 })
  await page.evaluate(() => document.getElementById('beeslides-splash')?.remove())
  const start = await page.evaluate(() => JSON.parse(JSON.stringify(window.beeslides.doc)))
  const doc = {
    ...start, title: 'Export rig', size: { width: 1280, height: 720 }, layouts: types, slides,
    sections: [{ id: 'sec1', name: 'Intro', startSlideId: 's1' }, { id: 'sec2', name: 'Appendix', startSlideId: 's3' }],
  }
  await page.evaluate((json) => window.beeslides.loadDoc(json), JSON.stringify(doc))
  await page.waitForTimeout(300)
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.evaluate(() => window.beeslides.menu.run('file.exportPptx')),
  ])
  check(download.suggestedFilename() === 'Export rig.pptx', 'the download is named after the deck', download.suggestedFilename())
  const chunks = []
  for await (const c of await download.createReadStream()) chunks.push(c)
  bytes = new Uint8Array(Buffer.concat(chunks))
} finally {
  await browser.close()
}
if (out) writeFileSync(out, bytes)

const z = await readZip(bytes)
const txt = (n) => new TextDecoder().decode(z.get(n) ?? new Uint8Array())
const names = [...z.keys()]
const count = (re) => names.filter((n) => re.test(n)).length
check(count(/^ppt\/slideMasters\/slideMaster\d+\.xml$/) === 2, 'two masters: Brand, and a plain one for the slides with no type', names.filter((n) => n.includes('slideMaster')))
check(count(/^ppt\/slideLayouts\/slideLayout\d+\.xml$/) === 3, 'three layouts: Brand, Content, Blank')
const m1 = txt('ppt/slideMasters/slideMaster1.xml')
check(/<p:cSld name="Brand">/.test(m1) && /prst="ellipse"/.test(m1) && /2563EB/.test(m1), 'master: named, with the bar and the logo')
check(/<p:ph type="title" hasCustomPrompt="1"\/>/.test(m1) && /Click to add title/.test(m1), 'master: the title slot with its prompt')
check(/<p:ph type="sldNum" idx="12"\/>/.test(m1) && /type="slidenum"/.test(m1), 'master: the slide number as PowerPoint’s field')
check(/typeface="Georgia"/.test(txt('ppt/theme/theme1.xml')), 'master theme: the type’s own face')
const layoutXml = names.filter((n) => /slideLayouts\/slideLayout\d+\.xml$/.test(n)).map(txt)
const lc = layoutXml.find((x) => /<p:cSld name="Content">/.test(x)) ?? ''
check(/1E3A8A/.test(lc) && !/2563EB/.test(lc), 'layout Content: its own stripe, not the master’s bar')
check(/<p:ph type="title"\/>|<p:ph type="title" hasCustomPrompt="1"\/>/.test(lc) && /<p:ph type="body" idx="\d+" hasCustomPrompt="1"\/>/.test(lc) &&
  /<p:ph type="pic" idx="\d+"\/>/.test(lc) && /<p:ph type="sldNum" idx="12"\/>/.test(lc), 'layout Content: title, body, picture and slide-number slots')
check(/<p:bg><p:bgPr><a:solidFill><a:srgbClr val="F8FAFC"/.test(lc), 'layout Content: its own background')
const s1 = txt('ppt/slides/slide1.xml')
check(!/2563EB/.test(s1) && !/1E3A8A/.test(s1) && !/prst="ellipse"/.test(s1), 'slide 1: no inherited chrome on the slide itself')
check(/<p:ph type="title"\/><\/p:nvPr><\/p:nvSpPr><p:spPr><a:prstGeom/.test(s1) && /<a:t>Agenda<\/a:t>/.test(s1), 'slide 1: the title fills the slot in its frame')
check(/<p:pic>(?:(?!<\/p:pic>).)*<p:ph type="pic" idx="\d+"\/>/.test(s1), 'slide 1: the picture fills the picture slot')
check(/type="slidenum"><a:rPr[^>]*>(?:(?!<\/a:rPr>).)*<\/a:rPr><a:t>1<\/a:t>/.test(s1), 'slide 1: its number, as a field')
check((s1.match(/<p:pic>/g) ?? []).length === 2, 'slide 1: the $math$ text is a picture', (s1.match(/<p:pic>/g) ?? []).length)
check(/typeface="Georgia"/.test(s1), 'slide 1: the type’s face on text with no face of its own')
check(/Say hello first/.test(txt('ppt/notesSlides/notesSlide1.xml')), 'slide 1: speaker notes')
const s2 = txt('ppt/slides/slide2.xml')
check(/<p:ph type="title"\/><\/p:nvPr><\/p:nvSpPr><p:spPr><a:xfrm><a:off x="1905000"/.test(s2), 'slide 2: a moved title keeps its own frame')
check(/<p:sp><p:nvSpPr><p:cNvPr [^>]*\/><p:cNvSpPr><a:spLocks noGrp="1"\/><\/p:cNvSpPr><p:nvPr><p:ph type="pic" idx="\d+"\/>/.test(s2), 'slide 2: the empty media slot stays a picture slot')
check(/<a:hlinkClick r:id="rId\d+" action="ppaction:\/\/hlinksldjump"\/>/.test(s2) && /Target="slide1.xml"/.test(txt('ppt/slides/_rels/slide2.xml.rels')), 'slide 2: the link jumps to slide 1')
check(/<p159:morph/.test(s2) && /name="!!b-title"/.test(s2) && /name="!!b-title"/.test(s1), 'slide 2: morph, the shared title named !! on both slides')
const s3 = txt('ppt/slides/slide3.xml')
check(/0F172A/.test(s3) && /<p:push dir="u"\/>/.test(s3), 'slide 3: own background, push from the bottom')
check(/Target="\.\.\/slideLayouts\/slideLayout3\.xml"/.test(txt('ppt/slides/_rels/slide3.xml.rels')), 'slide 3: on the blank layout')
check(/<p:sld [^>]*show="0"/.test(txt('ppt/slides/slide4.xml')), 'slide 4: hidden')
const pres = txt('ppt/presentation.xml')
check(/p14:section name="Intro"/.test(pres) && /p14:section name="Appendix"/.test(pres), 'sections')

const back = await convertPptx(bytes)
const lay = back.doc.layouts ?? []
const m = lay.find((l) => l.name === 'Brand' && !l.parentId)
check(!!m && lay.some((l) => l.name === 'Content' && l.parentId === m.id), 'import: Brand is a root type with Content under it', lay.map((l) => [l.name, l.parentId]))
// slide 2 stays flattened on the way back: the importer links no slide that
// leaves a media slot empty (DECISIONS 2026-09-27, empty-media-placeholder)
check(!!back.doc.slides[0].layoutId, 'import: slide 1 comes back linked to Content', back.doc.slides.map((s) => s.layoutId))
check(back.doc.slides[0].elements.some((e) => e.role === 'title' && e.html === 'Agenda'), 'import: the filled title')

console.log(`\n${passes}/${passes + fails} checks passed`)
process.exit(fails ? 1 : 0)
