#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Document language + translated terms (`doc.meta.language`, `doc.terms`,
// `{{term:Name}}`; docs/DECISIONS.md 2026-10-12). Bundled, not run directly —
// render.ts imports './model' extensionless:
//
//   slides/node_modules/.bin/esbuild scripts/test-doc-language.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-doc-language.mjs" \
//     && node "$TMPDIR/test-doc-language.mjs"
//
// WHAT THIS PROVES.
// - {{term:Name}} shows the entry in the document language, falls back to
//   the table's first language, then to the name; without `meta.language`
//   the first language is the document's.
// - {{date}}/{{time}} format in the document language; a bad code in a file
//   falls back to the viewer's instead of throwing.
// - Marker mode names a term like a custom property, and escapes it.
// - Renaming a term rewrites every {{term:old}} in slides, slide types and
//   objects, and nothing else.
// - Templates: a deck made from one carries its terms; "Update template"
//   takes the deck's terms (design layer), "Update deck from template"
//   merges them in without dropping the deck's own.
// - The validator knows the new keys.

import {
  adoptTemplateDesign, docLanguage, ensureTerm, instantiateTemplate, mergeTemplateDesign, mergeTerms, renameTermRefs, stampAsTemplate, termText,
  type SlidomingoDoc, type Slide, type TextElement,
} from '../slides/src/model.ts'
import { fieldContext, resolveFields } from '../slides/src/render.ts'
import { validateDoc } from '../slides/src/validate.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const text = (id: string, html: string): TextElement => ({
  rotation: 0, opacity: 1, id, type: 'text', x: 0, y: 0, w: 400, h: 40, html, fontSize: 14, fontFamily: '', fontWeight: 400,
  color: '#000', align: 'left', valign: 'top', lineHeight: 1.2,
})
const slide = (id: string, elements: TextElement[], extra: Partial<Slide> = {}): Slide =>
  ({ id, background: '#fff', transition: 'none', notes: '', elements, ...extra })

function fixture(): SlidomingoDoc {
  return {
    version: 1, format: 'slidomingo/slides', docId: 'd1', title: 'Deck',
    size: { width: 1280, height: 720 },
    theme: { background: '#fff', color: '#000', accent: '#c00', fontFamily: 'Inter' },
    terms: {
      languages: ['en', 'de'],
      entries: [
        { name: 'Page', text: { en: 'Page', de: 'Seite' } },
        { name: 'of', text: { en: 'of', de: 'von' } },
        { name: 'Confidential', text: { en: 'Confidential' } },
      ],
    },
    layouts: [slide('L', [text('l-foot', '{{term:Page}} {{page}} {{term:of}} {{pages}}')])],
    reusableObjects: [{ id: 'o1', name: 'Stamp', elements: [text('o-stamp', '{{ term: Confidential }}')] }],
    slides: [
      slide('s1', [text('l-foot', '{{term:Page}} {{page}} {{term:of}} {{pages}}'), text('t', 'Pages {{term:Pages}}')], { layoutId: 'L' }),
      slide('s2', [text('l-foot', '{{term:Page}} {{page}} {{term:of}} {{pages}}')], { layoutId: 'L' }),
    ],
  } as unknown as SlidomingoDoc
}
const footer = (doc: SlidomingoDoc, i = 0) => resolveFields((doc.slides[i].elements[0] as TextElement).html, fieldContext(doc, doc.slides[i]))

console.log('-- resolving terms --')
{
  const doc = fixture()
  ok(docLanguage(doc) === 'en', 'no meta.language: the first table language')
  ok(footer(doc) === 'Page 1 of 2', `default language: "${footer(doc)}"`)
  doc.meta = { language: 'de' }
  ok(footer(doc, 1) === 'Seite 2 von 2', `German: "${footer(doc, 1)}"`)
  ok(termText(doc, 'Confidential') === 'Confidential', 'a missing translation falls back to the first language')
  ok(termText(doc, 'Nope') === 'Nope', 'an unknown term shows its name')
  doc.meta.language = 'fr'
  ok(footer(doc) === 'Page 1 of 2', 'a language with no column falls back to the first')
  doc.terms!.languages = ['de', 'en']
  delete doc.meta
  ok(footer(doc) === 'Seite 1 von 2', 'the fallback is the table\'s FIRST language, whichever that is')
  const named = resolveFields('{{term:Page}}', fieldContext(fixture(), fixture().slides[0]), 'name')
  ok(named.includes('data-field="term:Page"') && named.includes('>Page<') && !named.includes('‹'), 'on a slide type a term shows its WORD, not ‹name›')
  const deDoc = fixture()
  ok(resolveFields('{{term:Page}}', fieldContext(deDoc, deDoc.slides[0], 'de')) === 'Seite', 'fieldContext takes a preview language over the document\'s')
  ok(termText(deDoc, 'Page', 'de') === 'Seite' && docLanguage(deDoc) === 'en', '…without touching the document')
  const evil = fixture()
  evil.terms!.entries[0].text.en = '<b onclick=x>'
  ok(!footer(evil).includes('<b'), 'term text is escaped')
  const bare = fixture()
  delete bare.terms
  ok(footer(bare) === 'Page 1 of 2', 'no table at all: names show, nothing throws')
}

console.log('-- dates follow the document language --')
{
  const doc = fixture()
  doc.meta = { language: 'de' }
  const ctx = fieldContext(doc, doc.slides[0])
  ctx.date = new Date(2026, 9, 12, 14, 5)
  ok(resolveFields('{{date}}', ctx) === '12.10.2026', `German date: "${resolveFields('{{date}}', ctx)}"`)
  ok(resolveFields('{{time}}', ctx) === '14:05', `German time: "${resolveFields('{{time}}', ctx)}"`)
  ctx.language = 'en-US'
  ok(resolveFields('{{date}}', ctx) === '10/12/2026', `US date: "${resolveFields('{{date}}', ctx)}"`)
  ctx.language = '!!bad!!'
  let threw = false
  try { resolveFields('{{date}} {{time}}', ctx) } catch { threw = true }
  ok(!threw, 'a bad language code in a file does not throw')
  ctx.dateFixed = 'Q3 2026'
  ok(resolveFields('{{date}}', ctx) === 'Q3 2026', 'a fixed date stays as typed')
}

console.log('-- renaming a term --')
{
  const doc = fixture()
  const n = renameTermRefs(doc, 'Page', 'Slide')
  const htmls = JSON.stringify([doc.slides, doc.layouts])
  ok(n === 3 && !htmls.includes('{{term:Page}}') && htmls.includes('{{term:Slide}} {{page}}'), `rewrites slides + types (${n} strings)`)
  ok(htmls.includes('{{term:Pages}}'), 'a term whose name merely starts the same is left alone')
  ok(renameTermRefs(doc, 'Confidential', 'Secret') === 1 && JSON.stringify(doc.reusableObjects).includes('{{term:Secret}}'), 'reaches reusable objects, spaces inside the token too')
}

console.log('-- templates carry the table --')
{
  const tmpl = stampAsTemplate(fixture())
  const deck = instantiateTemplate(JSON.stringify(tmpl), { includeSamples: false })!
  ok(!!deck && deck.terms?.entries.length === 3 && deck.terms.languages.join() === 'en,de', 'a deck made from a template has its terms')
  deck.meta = { language: 'de' }
  deck.terms!.entries.push({ name: 'Agenda', text: { en: 'Agenda', de: 'Tagesordnung' } })
  const updated = mergeTemplateDesign(tmpl, deck)
  ok(!('error' in updated) && (updated as SlidomingoDoc).terms?.entries.some((e) => e.name === 'Agenda') === true, 'Update template takes the deck\'s terms')
  ok(!('error' in updated) && (updated as SlidomingoDoc).meta?.language === undefined, '…but not the deck\'s language (meta stays the template\'s)')

  const old = clone(fixture())
  old.terms = { languages: ['en'], entries: [{ name: 'Page', text: { en: 'Pg.' } }, { name: 'Mine', text: { en: 'Mine' } }] }
  adoptTemplateDesign(old, tmpl)
  ok(old.terms!.languages.join() === 'en,de', 'Update deck from template adds the template\'s languages')
  ok(termText({ ...old, meta: { language: 'en' } }, 'Page') === 'Page' && old.terms!.entries.some((e) => e.name === 'Mine'), '…its entries win by name, the deck\'s own stay')

  const merged = mergeTerms(undefined, { languages: ['de'], entries: [{ name: 'x', text: { de: 'y' } }] })
  ok(merged.languages.join() === 'de' && merged.entries[0].text.de === 'y', 'mergeTerms onto nothing')
}

console.log('-- make translatable --')
{
  const doc = fixture()
  ok(ensureTerm(doc, 'Page', 'de') === 'Page' && doc.terms!.entries.length === 3, 'a word the first column already has reuses that term')
  const n = ensureTerm(doc, '  Thank   {you} ', 'de')
  ok(n === 'Thank you' && doc.terms!.entries.at(-1)!.text.en === 'Thank you', 'a new term is named after the text, in the first language, braces and spaces cleaned')
  doc.terms!.entries.push({ name: 'Agenda', text: { en: 'Programme' } })
  ok(ensureTerm(doc, 'Agenda', 'de') === 'Agenda 2', 'a name already taken by another word gets a number')
  const blank = fixture()
  delete blank.terms
  ok(ensureTerm(blank, 'Seite', 'de') === 'Seite' && blank.terms!.languages.join() === 'de', 'no table yet: it starts in the given language')
}

console.log('-- validator --')
{
  const doc = fixture()
  doc.meta = { language: 'de' }
  const unknown = validateDoc(doc, { measure: false }).findings.filter((f) => /unknown/i.test(f.code))
  ok(!unknown.some((f) => /terms|language/.test(JSON.stringify(f))), `terms and meta.language are known keys (${unknown.map((f) => f.code).join('; ') || 'none'})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
