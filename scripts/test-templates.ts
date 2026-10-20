#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Template model + registry rig.
//
//   node scripts/test-templates.ts
//
// WHAT THIS PROVES. A template is slide types + theme + assets
// (docs/DECISIONS.md 2026-09-24). Each check is one way that could go wrong
// on a real disk: a new deck inheriting the template's docId or template
// flag, losing the link back to its template (`basedOn`), a pruning pass
// deleting a picture something still points at (the ONE failure direction
// that loses data — svg elements and fonts reference assets by BARE key, not
// `asset:`), a template update overwriting the template's own sample
// pictures or its identity, and the desktop registry shipping or touching
// files outside the templates folder. The optional last block runs the
// metadata path against a COPY of the real 24MB template, if present.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FORMAT, parseDoc, stampAsTemplate, instantiateTemplate, mergeTemplateDesign, referencedAssetKeys,
  starterSlide, resolveBasedOn, templateNameFromPath, adoptTemplateDesign, parseTemplateDoc, resyncLinkedSlides, layoutElementIds,
  parseTemplateForEditing, templateFileDoc, newTemplateDoc,
  type SlidomingoDoc, type Slide,
} from '../slides/src/model.ts'
import {
  listTemplateMetaIn, loadTemplateIn, updateTemplateIn, renameTemplateIn, readTemplateMeta, resolveDefaultTemplate,
  templateNameFromPath as mainNameFromPath,
} from '../desktop/src/main/templatefs.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ---- fixtures ----------------------------------------------------------------
const base = { rotation: 0, opacity: 1 }
const text = (id: string, html: string, extra: Record<string, unknown> = {}) => ({
  ...base, id, type: 'text', x: 0, y: 0, w: 400, h: 80, html, fontSize: 32, fontFamily: '', fontWeight: 400,
  color: '#000', align: 'left', valign: 'top', lineHeight: 1.2, ...extra,
})
const image = (id: string, src: string, x = 0) => ({ ...base, id, type: 'image', x, y: 0, w: 100, h: 100, src, fit: 'contain', radius: 0 })
const svg = (id: string, asset: string) => ({ ...base, id, type: 'svg', x: 0, y: 0, w: 100, h: 100, asset })

const layoutTitle: Slide = {
  id: 'ly-title', name: 'Title', background: '#fff', transition: 'none', notes: '',
  elements: [image('ly-logo', 'asset:logo', 1200), svg('ly-map', 'map'), text('ly-t', '', { role: 'title', placeholder: 'Click to add title' })],
} as unknown as Slide
const layoutContent: Slide = {
  id: 'ly-content', name: 'Content', background: '#fff', transition: 'none', notes: '',
  elements: [text('lc-t', '', { role: 'title' }), text('lc-b', '', { role: 'body' })],
} as unknown as Slide

function makeDeck(): SlidomingoDoc {
  return {
    format: FORMAT, version: 1, docId: '11111111-1111-4111-8111-111111111111',
    title: 'Click to add title', size: { width: 1600, height: 900 },
    theme: { background: '#fff', color: '#111', accent: '#f00', fontFamily: 'Brand' },
    fonts: [{ family: 'Brand', asset: 'font1' }],
    layouts: [clone(layoutTitle), clone(layoutContent)],
    defaultLayoutId: 'ly-title',
    reusableObjects: [{ id: 'ro1', background: '#fff', transition: 'none', notes: '', elements: [image('ro-img', 'asset:roimg')] } as unknown as Slide],
    assets: {
      logo: 'data:image/png;base64,TEMPLATELOGO',
      map: '<svg><image href="asset:nested"/></svg>',
      nested: 'data:image/png;base64,NESTED',
      font1: 'data:font/woff2;base64,FONT',
      roimg: 'data:image/png;base64,RO',
      photo: 'data:image/png;base64,PHOTO',
      diagram: '<svg>diagram</svg>',
      inline: 'data:image/png;base64,INLINE',
      orphan: 'data:image/png;base64,ORPHAN',
    },
    sections: [{ id: 'sec1', name: 'Intro', startSlideId: 's1' }],
    slides: [
      { id: 's1', layoutId: 'ly-title', background: '#fff', transition: 'none', notes: '',
        elements: [image('ly-logo', 'asset:logo', 1200), svg('ly-map', 'map'), text('ly-t', 'Welcome'), image('u-photo', 'asset:photo')] },
      { id: 's2', background: '#fff', transition: 'none', notes: '',
        elements: [svg('u-diag', 'diagram'), text('u-inl', '<img src="asset:inline">')] },
    ] as unknown as Slide[],
    modified: '2026-09-01T00:00:00.000Z',
  } as SlidomingoDoc
}

// ---- referencedAssetKeys -----------------------------------------------------
console.log('referencedAssetKeys')
{
  const keys = referencedAssetKeys(makeDeck())
  for (const k of ['logo', 'map', 'font1', 'roimg', 'photo', 'inline'])
    ok(keys.has(k), `keeps "${k}"`)
  ok(keys.has('diagram'), 'keeps a BARE svg asset key ("diagram", svg element `asset`)')
  ok(keys.has('font1'), 'keeps fonts[].asset (bare key)')
  ok(keys.has('nested'), 'keeps an asset mentioned only inside a referenced svg-markup asset (transitive)')
  ok(!keys.has('orphan'), 'drops an asset nothing references')
  const d = makeDeck(); d.meta = { company: 'orphan' }
  ok(referencedAssetKeys(d).has('orphan'), 'conservative: any string equal to a key keeps it')
}

// ---- starterSlide ------------------------------------------------------------
console.log('starterSlide')
{
  const d = makeDeck()
  const s = starterSlide(d)
  ok(s.layoutId === 'ly-title', 'links the default slide type')
  ok(s.id !== 's1' && s.elements.some((e) => e.id === 'ly-t'), 'fresh slide id, layout element ids kept')
  ok(starterSlide(d, 'ly-content').layoutId === 'ly-content', 'or the slide type it is asked for')
  const bare = makeDeck(); delete bare.layouts; delete bare.defaultLayoutId
  ok(starterSlide(bare).layoutId === undefined, 'no doc layouts → built-in blank, no dangling layoutId')
}

// ---- stampAsTemplate ---------------------------------------------------------
console.log('stampAsTemplate')
{
  const d = makeDeck(); d.basedOn = { templateId: 'old', name: 'Old' }
  const t = stampAsTemplate(d)
  ok(t.template === true && !('docId' in t), 'template flag set, docId dropped')
  ok(!('basedOn' in t), 'basedOn dropped (a template is not "based on" its source deck)')
  ok(typeof t.templateId === 'string' && UUID.test(t.templateId), 'mints a templateId')
  ok(t.templateSamples === true && t.slides.length === 2, 'default keeps the slides as samples')
  ok(d.docId === '11111111-1111-4111-8111-111111111111' && d.template === undefined, 'input doc untouched')
  ok(stampAsTemplate(t).templateId === t.templateId, 're-stamping a template keeps its id')
  ok(stampAsTemplate(makeDeck(), { templateId: 'given' }).templateId === 'given', 'opts.templateId used when none')

  const lean = stampAsTemplate(makeDeck(), { samples: false })
  ok(lean.templateSamples === false, 'samples:false recorded')
  ok(lean.slides.length === 1 && lean.slides[0].layoutId === 'ly-title', 'samples:false → one starter slide of the default type')
  ok(!lean.sections, 'sections (pointing at dropped slides) removed')
  const la = Object.keys(lean.assets ?? {}).sort().join(',')
  ok(la === 'font1,logo,map,nested,roimg', `samples:false prunes slide-only assets (${la})`)
  ok(parseDoc(JSON.stringify(lean)) !== null, 'samples:false template still parses (never zero slides)')
}

// ---- instantiateTemplate + parseDoc -------------------------------------------
console.log('instantiateTemplate / parseDoc')
{
  const t = stampAsTemplate(makeDeck())
  const raw = JSON.stringify(t)
  const full = instantiateTemplate(raw, { includeSamples: true, name: 'Acme Corporate' })!
  ok(!!full, 'instantiates')
  ok(UUID.test(full.docId) && full.docId !== '11111111-1111-4111-8111-111111111111', 'fresh docId')
  ok(full.basedOn?.templateId === t.templateId && full.basedOn?.name === 'Acme Corporate', 'basedOn = {templateId, name}')
  ok(full.title === 'Untitled', 'deck titled "Untitled" (never the template\'s leaked title)')
  ok(!('template' in full) && !('templateId' in full) && !('templateSamples' in full), 'no template fields on the instance')
  ok(full.slides.length === 2, 'includeSamples:true keeps the sample slides')
  ok(!full.assets?.orphan && !!full.assets?.photo, 'prunes the orphan, keeps the sample photo')
  const again = instantiateTemplate(raw, { includeSamples: true })!
  ok(again.docId !== full.docId, 'every instance gets its own docId')

  const lean = instantiateTemplate(raw, { includeSamples: false, name: 'X' })!
  ok(lean.slides.length === 1 && lean.slides[0].layoutId === 'ly-title', 'includeSamples:false → one starter slide')
  ok(!lean.assets?.photo && !lean.assets?.diagram && !lean.assets?.inline, 'includeSamples:false prunes slide-only assets')
  ok(!!lean.assets?.logo && !!lean.assets?.map && !!lean.assets?.nested && !!lean.assets?.font1 && !!lean.assets?.roimg,
    'design assets survive (layout image, bare svg key, nested, font, reusable object)')
  ok(!lean.sections, 'no dangling sections')

  const picked = instantiateTemplate(raw, { includeSamples: false, name: 'X', firstLayoutId: 'ly-content' })!
  ok(picked.slides.length === 1 && picked.slides[0].layoutId === 'ly-content', 'firstLayoutId → the starter slide is that slide type')
  const ghost = instantiateTemplate(raw, { includeSamples: false, name: 'X', firstLayoutId: 'nope' })!
  ok(ghost.slides[0].layoutId === 'ly-title', 'an unknown firstLayoutId falls back to the default slide type')
  const withSamples = instantiateTemplate(raw, { includeSamples: true, firstLayoutId: 'ly-content' })!
  ok(withSamples.slides.length === 2, 'with samples, firstLayoutId changes nothing')

  const opened = parseDoc(raw)!
  ok(opened.basedOn?.templateId === t.templateId && !('templateId' in opened) && !opened.template,
    'parseDoc of a template file → deck with basedOn.templateId, template fields gone')
  ok(opened.docId && opened.docId !== '11111111-1111-4111-8111-111111111111', 'parseDoc mints a fresh docId for a template')
  const deck = parseDoc(JSON.stringify(makeDeck()))!
  ok(!('basedOn' in deck) && deck.docId === '11111111-1111-4111-8111-111111111111', 'plain deck: untouched by the template branch')

  const notFlagged = makeDeck() // a deck dropped into the folder by hand, no template flag
  const inst = instantiateTemplate(JSON.stringify(notFlagged), { includeSamples: true, name: 'Hand' })!
  ok(inst.docId !== notFlagged.docId, 'an unflagged file still yields a NEW docId (never the source deck\'s)')
  ok(instantiateTemplate('{nope', { includeSamples: true }) === null, 'garbage → null')
  ok(instantiateTemplate(JSON.stringify({ format: FORMAT, slides: [] }), { includeSamples: true }) === null, 'zero slides → null')
}

// ---- legacy templates (no templateId) -----------------------------------------
console.log('legacy templates')
{
  const legacy = makeDeck() as SlidomingoDoc; legacy.template = true; delete (legacy as { docId?: string }).docId
  const inst = instantiateTemplate(JSON.stringify(legacy), { includeSamples: false, name: 'Acme Corporate' })!
  ok(inst.basedOn?.templateId === undefined && inst.basedOn?.name === 'Acme Corporate', 'legacy → basedOn {name} only')
  ok(parseDoc(JSON.stringify(legacy))!.basedOn === undefined, 'parseDoc of a legacy template: no id, no basedOn')
  const metas = [
    { name: 'Acme Corporate', templateId: null as string | null, path: '/t/Acme Corporate.beeslides.html' },
    { name: 'Other', templateId: 'id-other', path: '/t/Other.beeslides.html' },
  ]
  ok(resolveBasedOn(inst.basedOn, metas)?.name === 'Acme Corporate', 'legacy deck resolves its template by filename')
  ok(resolveBasedOn({ templateId: 'id-other', name: 'Renamed' }, metas)?.name === 'Other', 'id wins over name (template renamed)')
  const minted = [{ ...metas[0], templateId: 'id-new' }, metas[1]]
  ok(resolveBasedOn({ name: 'Acme Corporate' }, minted)?.templateId === 'id-new', 'name-only deck still finds the template after its id was minted')
  ok(resolveBasedOn({ templateId: 'id-gone', name: 'Other' }, metas) === undefined, 'unknown id does NOT fall back to a same-named template with its own id')
  ok(resolveBasedOn({ templateId: 'id-x', name: 'Acme Corporate' }, metas)?.name === 'Acme Corporate', 'unknown id may fall back to a same-named LEGACY template')
  ok(resolveBasedOn(undefined, metas) === undefined, 'no basedOn → nothing')
  ok(templateNameFromPath('/a/b/Acme Corporate.beeslides.html') === 'Acme Corporate'
    && templateNameFromPath('C:\\T\\X y.beeslides.html') === 'X y', 'filename-derived name (/ and \\)')
  ok(mainNameFromPath('/a/b/Acme Corporate.beeslides.html') === 'Acme Corporate', 'main restatement agrees')
}

// ---- mergeTemplateDesign -------------------------------------------------------
console.log('mergeTemplateDesign')
{
  const template = stampAsTemplate(makeDeck())
  // Template's own sample slide 2 gets a picture under key "pic"; the deck
  // uses the SAME key for a different picture in its layout.
  template.assets!.pic = 'data:image/png;base64,TEMPLATEPIC'
  ;(template.slides[1].elements as unknown[]).push(image('u-pic', 'asset:pic'))
  template.slides.push({ id: 's3', layoutId: 'ly-content', background: '#fff', transition: 'none', notes: '',
    elements: [text('lc-t', 'Sample content title'), text('lc-b', 'Body text')] } as unknown as Slide)

  const deck = instantiateTemplate(JSON.stringify(template), { includeSamples: false, name: 'T' })!
  deck.theme.accent = '#0a0'
  deck.fonts = [{ family: 'Brand2', asset: 'font2' }]
  deck.assets = { ...deck.assets, font2: 'data:font/woff2;base64,FONT2', logo: 'data:image/png;base64,NEWLOGO',
    pic: 'data:image/png;base64,DECKPIC', deckphoto: 'data:image/png;base64,DECKSLIDE' }
  const lyT = deck.layouts!.find((l) => l.id === 'ly-title')!
  ;(lyT.elements as unknown[]).push(image('ly-pic', 'asset:pic', 50), text('ly-foot', '{{page}}'))
  deck.layouts = deck.layouts!.filter((l) => l.id !== 'ly-content')
  deck.layouts.push({ id: 'ly-new', name: 'New', background: '#eee', transition: 'none', notes: '', elements: [] } as unknown as Slide)
  deck.defaultLayoutId = 'ly-title'
  ;(deck.slides[0].elements as unknown[]).push(image('d-photo', 'asset:deckphoto'))

  const merged = mergeTemplateDesign(template, deck)
  ok(!('error' in merged), 'merges')
  const m = merged as SlidomingoDoc
  ok(m.templateId === template.templateId && m.template === true && !('docId' in m) && !('basedOn' in m),
    'keeps templateId, stays a template (no docId/basedOn)')
  ok(m.title === template.title, 'keeps the template\'s own title')
  ok(m.slides.length === 3 && m.slides.map((s) => s.id).join() === 's1,s2,s3', 'keeps the template\'s own sample slides')
  ok(m.theme.accent === '#0a0' && m.fonts?.[0].family === 'Brand2', 'theme + fonts from the deck')
  ok(m.layouts!.map((l) => l.id).join() === 'ly-title,ly-new', 'layouts from the deck')
  ok(m.slides[0].elements.some((e) => e.id === 'ly-foot'), 'a linked sample slide is re-applied through the updated slide type')
  ok(m.slides[0].elements.some((e) => e.id === 'ly-t' && (e as { html?: string }).html === 'Welcome'), 'its written content survives the re-apply')
  ok(m.slides[2].layoutId === undefined && m.slides[2].elements.length === 2, 'a link to a slide type the deck removed is cleared, content kept')
  ok(m.assets?.logo === 'data:image/png;base64,NEWLOGO', 'design asset replaced from the deck')
  ok(m.assets?.pic === 'data:image/png;base64,DECKPIC', 'deck layout keeps its colliding key')
  const upic = m.slides[1].elements.find((e) => e.id === 'u-pic') as { src: string }
  ok(upic.src !== 'asset:pic' && m.assets?.[upic.src.slice(6)] === 'data:image/png;base64,TEMPLATEPIC',
    `sample slide's own picture renamed away from the collision (${upic.src}), not replaced`)
  ok(!m.assets?.deckphoto, 'the deck\'s own slide media never enters the template')
  ok(!!m.assets?.font2 && !m.assets?.font1, 'new font asset in, stale font asset pruned')
  ok(!!m.assets?.photo && !!m.assets?.diagram, 'sample-slide assets kept')
  ok(template.theme.accent === '#f00' && deck.slides.length === 1, 'inputs untouched')

  const bad = clone(deck); bad.size = { width: 1280, height: 720 }
  const refused = mergeTemplateDesign(template, bad)
  ok('error' in refused && refused.error === 'size-mismatch', 'size mismatch refused')

  const leanT = stampAsTemplate(makeDeck(), { samples: false })
  const leanM = mergeTemplateDesign(leanT, deck) as SlidomingoDoc
  ok(leanM.templateSamples === false && leanM.slides.length === 1 && leanM.slides[0].elements.some((e) => e.id === 'ly-foot'),
    'samples-less template: starter slide regenerated from the new design')

  const legacy = clone(template); delete legacy.templateId
  const lm = mergeTemplateDesign(legacy, deck) as SlidomingoDoc
  ok(typeof lm.templateId === 'string' && UUID.test(lm.templateId), 'legacy template gets its id minted on the first update')
  ok(parseDoc(JSON.stringify(m)) !== null, 'merged template parses')
}

// ---- desktop registry (templatefs.ts) ----------------------------------------
// ---- adoptTemplateDesign ("Update this deck from template") -------------------
console.log('adoptTemplateDesign')
{
  const template = stampAsTemplate(makeDeck(), { samples: false })
  template.layouts![1].background = '#123456' // the template's Content type changed
  template.layouts!.push({ id: 'ly-new', name: 'New', background: '#fff', transition: 'none', notes: '', elements: [image('ln-img', 'asset:logo')] } as unknown as Slide)
  template.theme = { ...template.theme, accent: '#00f' }

  const deck = makeDeck()
  deck.assets!.logo = 'data:image/png;base64,DECKLOGO' // same key, different picture
  deck.layouts!.push({ id: 'ly-mine', name: 'Mine', background: '#fff', transition: 'none', notes: '', elements: [] } as unknown as Slide)
  deck.slides.push({ id: 's3', layoutId: 'ly-content', background: '#fff', transition: 'none', notes: '', elements: [text('lc-t', 'Hi'), text('lc-b', 'Body')] } as unknown as Slide)
  const before = layoutElementIds(deck)
  const r = adoptTemplateDesign(deck, template)
  ok(!('error' in r) && r.layoutIds.includes('ly-content') && r.layoutIds.includes('ly-new'), 'returns every replaced/added slide type')
  ok(deck.layouts!.find((l) => l.id === 'ly-content')!.background === '#123456', 'a slide type is replaced by id')
  ok(deck.layouts!.some((l) => l.id === 'ly-mine'), "the deck's own extra slide types stay")
  ok(deck.theme.accent === '#00f', 'the theme comes from the template')
  ok(deck.assets!.logo === 'data:image/png;base64,DECKLOGO', "the deck's own picture under a colliding key is untouched")
  const renamed = Object.keys(deck.assets!).find((k) => k.startsWith('logo-t'))
  ok(!!renamed && deck.assets![renamed] === 'data:image/png;base64,TEMPLATELOGO', `the template's picture arrives under a new key (${renamed})`)
  const newLy = deck.layouts!.find((l) => l.id === 'ly-new')!
  ok((newLy.elements[0] as unknown as { src: string }).src === `asset:${renamed}`, 'and the adopted slide type points at it')
  ok(deck.slides.find((x) => x.id === 's3')!.background === '#fff', 'slides are not touched by the merge itself…')
  if (!('error' in r)) {
    const known = new Set([...before, ...layoutElementIds(deck)])
    for (const id of r.layoutIds) resyncLinkedSlides(deck, id, known)
  }
  ok(deck.slides.find((x) => x.id === 's3')!.background === '#123456', '…and the caller’s resync brings linked slides along')
  const s3 = deck.slides.find((x) => x.id === 's3')!
  ok((s3.elements.find((e) => e.id === 'lc-t') as unknown as { html: string }).html === 'Hi', 'linked slides keep their content')
  const small = makeDeck(); small.size = { width: 1280, height: 720 }
  ok('error' in adoptTemplateDesign(small, template), 'refuses a template with a different slide size')
}

// ---- parseTemplateDoc ---------------------------------------------------------
console.log('parseTemplateDoc')
{
  const template = stampAsTemplate(makeDeck(), { samples: false })
  const back = parseTemplateDoc(JSON.stringify(template))!
  ok(back.template === true && back.templateId === template.templateId && back.templateSamples === false, 'keeps the identity parseDoc strips (template, templateId, templateSamples)')
  ok(!back.docId && !back.basedOn, 'and has no deck identity')
  const merged = mergeTemplateDesign(back, makeDeck())
  ok(!('error' in merged) && merged.templateId === template.templateId, 'so an update round-trips the same templateId')
}

// ---- template window (Edit Template) ----------------------------------------------
console.log('template window')
{
  const template = stampAsTemplate(makeDeck())
  const raw = JSON.stringify(template)
  const editing = parseTemplateForEditing(raw)!
  ok(editing.template === true && editing.templateId === template.templateId, 'boots as the template, same templateId')
  ok(editing.docId === template.templateId, 'with an in-memory docId (recovery/versions key on it), stable across opens')
  ok(parseTemplateForEditing(raw)!.docId === editing.docId, 'the same docId on the next open')
  editing.layouts![0].name = 'Renamed type'
  const written = templateFileDoc(editing)
  ok(written.template === true && written.templateId === template.templateId, 'a save writes a template with the SAME templateId')
  ok(!('docId' in written) && !('basedOn' in written), 'and no docId/basedOn — the in-memory id never reaches the file')
  ok(written.layouts![0].name === 'Renamed type' && written.slides.length === 2, 'with the edits and its sample slides')
  ok(editing.docId === template.templateId, 'writing leaves the live doc alone')
  const again = parseTemplateForEditing(JSON.stringify(written))!
  ok(again.templateId === template.templateId && again.layouts![0].name === 'Renamed type', 'round-trips through the file')
  const deck = instantiateTemplate(JSON.stringify(written), { includeSamples: false, name: 'Brand' })!
  ok(deck.basedOn?.templateId === template.templateId && !deck.template && deck.docId !== editing.docId,
    '"New deck from this template": a fresh deck based on it')

  // no samples: whatever the editor holds, the file keeps one starter slide
  const lean = parseTemplateForEditing(JSON.stringify(stampAsTemplate(makeDeck(), { samples: false })))!
  lean.slides.push(clone(lean.slides[0]))
  const leanOut = templateFileDoc(lean)
  ok(leanOut.templateSamples === false && leanOut.slides.length === 1, 'templateSamples:false → the file keeps only a starter slide')
  lean.templateSamples = true
  ok(templateFileDoc(lean).slides.length === 2, '"Save these slides as samples" → they are written')

  // a legacy template without an id gets ONE for the whole session
  const legacy = makeDeck() as SlidomingoDoc; legacy.template = true
  delete (legacy as { docId?: string }).docId
  const leg = parseTemplateForEditing(JSON.stringify(legacy))!
  ok(!!leg.templateId && templateFileDoc(leg).templateId === leg.templateId && templateFileDoc(leg).templateId === leg.templateId,
    'a legacy template gets an id at open, and every save writes that same id')

  // Replace from JSON / a restored version run parseDoc, which strips the
  // id: the window's own identity still lands in the file
  const replaced = parseDoc(JSON.stringify(written))!
  ok(!replaced.templateId && templateFileDoc(replaced, template.templateId).templateId === template.templateId,
    'a whole-document replace cannot change the template’s identity on disk')

  const fresh = newTemplateDoc('Brand 2027')
  ok(fresh.template === true && !!fresh.templateId && fresh.templateSamples === false && !('docId' in fresh), 'New Template: a template, no samples, no docId')
  ok((fresh.layouts?.length ?? 0) > 0 && fresh.slides.length === 1 && fresh.slides[0].layoutId === fresh.layouts![0].id,
    'with the built-in slide types to start from, and one starter slide of the first')
  ok(fresh.title === 'Brand 2027', 'titled by the name typed')
}

console.log('desktop registry')
function shellFor(doc: unknown): string {
  const json = JSON.stringify(doc).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><title>x</title><script type="application/beeslides+json" id="beeslides-doc">${json}</script></head>`
    + `<body><script id="beeslides-rt" type="beeslides/deflate-b64">${'A'.repeat(120_000)}</script></body></html>\n`
}
{
  const dir = mkdtempSync(join(tmpdir(), 'slidomingo-tpl-'))
  const outside = mkdtempSync(join(tmpdir(), 'slidomingo-out-'))
  const t1 = stampAsTemplate(makeDeck())
  const legacy = makeDeck() as SlidomingoDoc; legacy.template = true
  const lean = stampAsTemplate(makeDeck(), { samples: false })
  writeFileSync(join(dir, 'Brand.beeslides.html'), shellFor(t1))
  writeFileSync(join(dir, 'Legacy One.beeslides.html'), shellFor(legacy))
  writeFileSync(join(dir, 'Lean.beeslides.html'), shellFor(lean))
  writeFileSync(join(dir, 'broken.beeslides.html'), '<html>nope</html>')
  writeFileSync(join(dir, 'notes.txt'), 'x')
  writeFileSync(join(outside, 'Evil.beeslides.html'), shellFor(t1))

  const list = listTemplateMetaIn(dir)
  ok(list.map((m) => m.name).join('|') === 'Brand|Lean|Legacy One', `lists readable templates by FILENAME, sorted (${list.map((m) => m.name).join('|')})`)
  ok(!list.some((m) => m.name.includes('Click to add')), 'the doc title never becomes the name')
  const brand = list.find((m) => m.name === 'Brand')!
  ok(brand.templateId === t1.templateId && brand.slideCount === 2 && brand.layoutCount === 2 && brand.samples, 'meta fields')
  ok(list.find((m) => m.name === 'Legacy One')!.templateId === null, 'legacy → templateId null')
  ok(list.find((m) => m.name === 'Lean')!.samples === false, 'templateSamples:false → samples false')
  ok(!('json' in brand), 'no document JSON in the metadata')
  ok(readTemplateMeta(brand.path) === brand, 'cached: unchanged file is not re-parsed')
  writeFileSync(brand.path, shellFor({ ...t1, slides: [t1.slides[0]] }))
  utimesSync(brand.path, new Date(), new Date(Date.now() + 5000))
  ok(readTemplateMeta(brand.path)?.slideCount === 1, 'mtime change invalidates the cache')

  const raw = loadTemplateIn(dir, brand.path)
  ok(typeof raw === 'string' && instantiateTemplate(raw, { includeSamples: true })?.basedOn?.templateId === t1.templateId,
    'loadTemplate → raw JSON that instantiates with basedOn')
  ok(loadTemplateIn(dir, join(outside, 'Evil.beeslides.html')) === null, 'load refuses a path outside the folder')
  ok(loadTemplateIn(dir, join(dir, '..', 'x.beeslides.html')) === null, 'load refuses a .. escape')
  ok(loadTemplateIn(dir, join(dir, 'notes.txt')) === null, 'load refuses a non-template file')

  const newHtml = shellFor(stampAsTemplate(makeDeck(), { templateId: t1.templateId }))
  ok(updateTemplateIn(dir, brand.path, newHtml) === true, 'update accepts a full template shell')
  ok(readFileSync(brand.path, 'utf8') === newHtml, 'update wrote the bytes')
  ok(updateTemplateIn(dir, brand.path, shellFor(makeDeck())) === false, 'update refuses a plain deck (not a template)')
  ok(updateTemplateIn(dir, brand.path, '<!doctype html><html></html>') === false, 'update refuses a truncated/non-shell')
  ok(updateTemplateIn(dir, join(outside, 'Evil.beeslides.html'), newHtml) === false, 'update refuses outside the folder')
  ok(updateTemplateIn(dir, join(dir, 'Missing.beeslides.html'), newHtml) === false && !existsSync(join(dir, 'Missing.beeslides.html')),
    'update never creates a file')

  ok(renameTemplateIn(dir, brand.path, 'Lean') === null, 'rename refuses to overwrite another template')
  const renamed = renameTemplateIn(dir, brand.path, 'Brand: 2026')
  ok(renamed === join(dir, 'Brand_ 2026.beeslides.html') && existsSync(renamed!) && !existsSync(brand.path), `rename sanitizes + moves (${renamed})`)
  const caseOnly = renameTemplateIn(dir, renamed!, 'brand_ 2026')
  ok(caseOnly === join(dir, 'brand_ 2026.beeslides.html') && existsSync(caseOnly!), 'case-only rename of the same file is allowed')
  ok(renameTemplateIn(dir, join(outside, 'Evil.beeslides.html'), 'X') === null, 'rename refuses outside the folder')
  ok(renameTemplateIn(dir, caseOnly!, '  ') === null, 'rename refuses an empty name')
  ok(listTemplateMetaIn(dir).some((m) => m.name === 'brand_ 2026'), 'list reflects the rename')

  // the default template, as main stores it: {templateId, path}
  const now = listTemplateMetaIn(dir)
  const legacyMeta = now.find((m) => m.name === 'Legacy One')!
  ok(resolveDefaultTemplate(now, { templateId: t1.templateId!, path: brand.path })?.path === caseOnly,
    'default: found by templateId after a rename (its stored path is stale)')
  ok(resolveDefaultTemplate(now, { templateId: null, path: legacyMeta.path })?.name === 'Legacy One', 'default: a legacy template by path')
  ok(resolveDefaultTemplate(now, { templateId: 'gone', path: join(dir, 'Gone.beeslides.html') }) === null, 'default: gone → null')
  ok(resolveDefaultTemplate(now, undefined) === null, 'default: none set → null')
}

// ---- optional: a COPY of a real template (SLIDOMINGO_REAL_TEMPLATE=<path>) ------
{
  const real = process.env.SLIDOMINGO_REAL_TEMPLATE ?? ''
  if (!real || !existsSync(real)) console.log('real template: SLIDOMINGO_REAL_TEMPLATE not set, skipped')
  else {
    console.log('real template (copy)')
    const realName = templateNameFromPath(real)
    const dir = mkdtempSync(join(tmpdir(), 'slidomingo-real-'))
    const copy = join(dir, `${realName}.beeslides.html`)
    copyFileSync(real, copy)
    let t0 = performance.now()
    const [meta] = listTemplateMetaIn(dir)
    const cold = performance.now() - t0
    t0 = performance.now()
    listTemplateMetaIn(dir)
    const warm = performance.now() - t0
    ok(meta?.name === realName, `name from filename ("${meta?.name}")`)
    console.log(`        slides=${meta?.slideCount} layouts=${meta?.layoutCount} templateId=${meta?.templateId} cold=${cold.toFixed(0)}ms warm=${warm.toFixed(1)}ms`)
    ok(warm < cold / 5, 'second listing served from the cache')
    const raw = loadTemplateIn(dir, copy)!
    const lean = instantiateTemplate(raw, { includeSamples: false, name: meta.name })!
    const full = instantiateTemplate(raw, { includeSamples: true, name: meta.name })!
    const sz = (d: unknown) => (JSON.stringify(d).length / 1e6).toFixed(1) + 'MB'
    ok(lean.slides.length === 1 && full.slides.length === meta.slideCount, 'instantiate: 1 starter slide / all samples')
    ok(lean.basedOn?.name === realName && lean.title === 'Untitled', 'basedOn by name; title Untitled')
    console.log(`        raw=${(raw.length / 1e6).toFixed(1)}MB  lean instance=${sz(lean)}  full instance=${sz(full)}  lean assets=${Object.keys(lean.assets ?? {}).length}/${Object.keys(full.assets ?? {}).length}`)
    const stamped = stampAsTemplate(parseDoc(raw)!, { samples: false })
    console.log(`        design-only template=${sz(stamped)}`)
    ok(readFileSync(real).length === readFileSync(copy).length, 'the real template was not touched')
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
