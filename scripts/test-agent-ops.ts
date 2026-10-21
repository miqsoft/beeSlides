#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Grouped agent op tools (`deck`, …): slides/src/agentops/spec.ts → handlers
// (slides/src/editor/agentops.ts) → MCP server (desktop/src/main/agenttools.ts).
//
//   slides/node_modules/.bin/esbuild scripts/test-agent-ops.ts --bundle \
//     --platform=node --format=esm --outfile=$TMPDIR/test-agent-ops.mjs \
//     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
//   node $TMPDIR/test-agent-ops.mjs
//
// (bundled because model.ts uses extensionless imports)
//
// WHAT THIS PROVES
//  1. The spec is consistent (a param name means one type across ops, `about`
//     is free for help) and generates a sane tool: op enum = ops + help, the
//     description stays short, help covers every op and the not-yet list.
//  2. Arguments are checked before any handler runs.
//  3. Every deck op does what the UI does, on a real Store, as ONE undo step,
//     and refuses what it must (unknown ids, deleting slides nobody asked to
//     delete, the last slide, url() backgrounds, bad transition directions).
//  4. End to end: the app's filled-in MCP server lists `deck`, answers help
//     itself, and round-trips an op to a (fake) app that runs the real handlers.

import { mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_AREAS, DECK_AREA, areaHelp, areaToolDef, checkArgs, type AreaSpec } from '../slides/src/agentops/spec.ts'
import { runAreaOp, type AgentIcon, type HtmlLayout, type IconLibraryAccess, type OpContext } from '../slides/src/editor/agentops.ts'
import { htmlSignature, mergeCompiled } from '../slides/src/htmlslide.ts'
import { defaultShape, defaultText, deriveChartPalette, emptySlide, newDoc, newIconsetDoc, sectionsInOrder, type SlideElement, type SlidomingoDoc } from '../slides/src/model.ts'
import { Store } from '../slides/src/store.ts'
import { agentSvgPatchViolation, agentSvgViolation } from '../slides/src/editor/agentsvg.ts'
import { agentAreaTools, serverWithAgentAreas } from '../desktop/src/main/agenttools.ts'
import { McpClient } from '../desktop/src/main/apichat/mcp.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}

// ---- 1. the spec ---------------------------------------------------------------
console.log('-- spec --')
for (const area of AGENT_AREAS as readonly AreaSpec[]) {
  const types = new Map<string, string>()
  let clash = ''
  for (const [opName, op] of Object.entries(area.ops)) {
    for (const [name, p] of Object.entries(op.params)) {
      if (name === 'op' || name === 'about') clash ||= `${opName}.${name} is reserved`
      const seen = types.get(name)
      if (seen && seen !== p.type) clash ||= `${name}: ${seen} vs ${p.type} (${opName})`
      types.set(name, p.type)
    }
  }
  ok(!clash, `${area.tool}: a param name has one type across ops, op/about stay reserved ${clash}`)
  const def = areaToolDef(area)
  const schema = def.inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[] }
  ok(JSON.stringify(schema.properties.op.enum) === JSON.stringify([...Object.keys(area.ops), 'help']) && schema.required.join() === 'op', `${area.tool}: op enum = every op + help, op required`)
  ok(def.description.length < 1600, `${area.tool}: tool description stays short (${def.description.length} chars)`)
  const help = areaHelp(area)
  ok(Object.keys(area.ops).every((op) => help.includes(`op "${op}"`)) && area.notYet.every((n) => help.includes(n)), `${area.tool}: help covers every op and the not-yet list`)
}

// ---- 2. argument checks --------------------------------------------------------
console.log('-- argument checks --')
ok(checkArgs(DECK_AREA, 'nope', {})!.includes('Ops: add, duplicate'), 'an unknown op lists the ops')
ok(checkArgs(DECK_AREA, 'add', { count: 2.5 })!.includes('count must be integer'), 'type checked (integer)')
ok(checkArgs(DECK_AREA, 'add', { count: 99 })!.includes('count must be 1..30'), 'range checked')
ok(checkArgs(DECK_AREA, 'add', { colour: 'x' })!.includes('"colour" is not a parameter of add'), 'unknown params refused (a typo never applies silently)')
ok(checkArgs(DECK_AREA, 'transition', { slideIds: ['a'], kind: 'spin' })!.includes('kind must be one of none|fade'), 'enum checked')
ok(checkArgs(DECK_AREA, 'delete', { slideIds: [] })!.includes('slideIds must not be empty'), 'a required list must not be empty')
ok(checkArgs(DECK_AREA, 'rename', { slideId: 'a' })!.includes('name is required'), 'required checked')
ok(checkArgs(DECK_AREA, 'add', { op: 'add', count: 3, after: 'a' }) === null, 'a good call passes')

// ---- 3. handlers on a real Store -----------------------------------------------
console.log('-- deck ops --')
function deck(): SlidomingoDoc {
  const doc = newDoc()
  doc.slides = ['a', 'b', 'c', 'd'].map((id) => emptySlide({ id }))
  doc.slides[2].stateOf = 'b' // c is an interactive state of b
  return doc
}
const fresh = (): { store: Store; ctx: OpContext; run: (a: Record<string, unknown>) => any } => {
  const store = new Store(deck())
  const ctx: OpContext = { store, created: new Set() }
  return { store, ctx, run: (a) => runAreaOp('deck', a, ctx) }
}
const order = (s: Store) => s.doc.slides.map((x) => x.id).join(',')
{
  const { store, run } = fresh()
  const r = run({ op: 'add', after: 'a', count: 3, names: ['Intro', 'Body'] })
  const ids = r.slideIds as string[]
  ok(r.ok && ids.length === 3 && order(store) === ['a', ...ids, 'b', 'c', 'd'].join(','), `add: 3 slides right after a (${r.summary})`)
  ok(store.doc.slides[1].name === 'Intro' && store.doc.slides[2].name === 'Body' && !store.doc.slides[3].name, 'add: names applied in order')
  store.undo()
  ok(order(store) === 'a,b,c,d', 'add: one undo step removes all of them')
  const afterParent = run({ op: 'add', after: 'b' })
  ok(order(store) === `a,b,c,${afterParent.slideIds[0]},d`, 'add after a slide with a state: lands past its state')
  ok(!run({ op: 'add', slideType: 'layout-nope' }).ok && run({ op: 'add', slideType: 'layout-nope' }).error.includes('layout-section'), 'add: unknown slideType refused, the built-ins named')
  const sec = run({ op: 'add', slideType: 'layout-section' })
  ok(sec.ok && store.doc.slides.at(-1)!.id === sec.slideIds[0] && !store.doc.slides.at(-1)!.layoutId, 'add: a built-in layout at the end, not linked')
}
{
  const { store, run } = fresh()
  const layout = emptySlide({ id: 'L1', name: 'Content' })
  store.doc.layouts = [layout]
  store.doc.slides[0].layoutId = 'L1'
  const r = run({ op: 'add', after: 'a' })
  ok(r.ok && store.doc.slides[1].layoutId === 'L1', 'add: without slideType the new slide follows the type of the slide in front')
}
{
  const { store, ctx, run } = fresh()
  const r = run({ op: 'duplicate', slideIds: ['b'] })
  const copy = r.slideIds[0]
  ok(r.ok && store.doc.slides.length === 6 && store.doc.slides.some((s) => s.stateOf === copy), 'duplicate: the copy brings its interactive state along')
  ok(ctx.created.has(copy), 'duplicate: copies count as agent-created')
  ok(!run({ op: 'duplicate', slideIds: ['zz'] }).ok, 'duplicate: unknown id refused')
}
{
  const { store, run } = fresh()
  const refused = run({ op: 'delete', slideIds: ['a'] })
  ok(!refused.ok && refused.error.includes('userAsked') && order(store) === 'a,b,c,d', 'delete: a slide the user has did not ask about is refused')
  const added = run({ op: 'add', count: 2 })
  const del = run({ op: 'delete', slideIds: added.slideIds })
  ok(del.ok && order(store) === 'a,b,c,d', 'delete: agent-added slides can go without userAsked')
  const asked = run({ op: 'delete', slideIds: ['b'], userAsked: true })
  ok(asked.ok && order(store) === 'a,d' && asked.summary.includes('1 interactive state'), `delete: userAsked deletes, the state goes with it (${asked.summary})`)
  ok(!run({ op: 'delete', slideIds: ['a', 'd'], userAsked: true }).ok && order(store) === 'a,d', 'delete: the last slides are never all deleted')
  store.undo()
  ok(order(store) === 'a,b,c,d', 'delete: one undo step restores slide and state')
}
{
  const { store, run } = fresh()
  ok(run({ op: 'move', slideIds: ['d'], to: 'start' }).ok && order(store) === 'd,a,b,c', 'move to start')
  ok(run({ op: 'move', slideIds: ['d'], after: 'b' }).ok && order(store) === 'a,b,c,d', 'move after a slide: past its state')
  ok(run({ op: 'move', slideIds: ['b'], before: 'a' }).ok && order(store) === 'b,c,a,d', 'move before: the state moves with its slide')
  ok(!run({ op: 'move', slideIds: ['a'], before: 'a' }).ok, 'move: the target cannot be one of the moved slides')
  ok(!run({ op: 'move', slideIds: ['a'], before: 'b', to: 'end' }).ok, 'move: exactly one of before/after/to')
  ok(run({ op: 'move', slideIds: ['d'], to: 'end' }).summary.includes('nothing changed'), 'move: a no-op says so (no empty undo step)')
}
{
  const { store, run } = fresh()
  ok(run({ op: 'hide', slideIds: ['d'] }).ok && store.doc.slides[3].hidden === true, 'hide')
  ok(run({ op: 'hide', slideIds: ['d'], hidden: false }).ok && store.doc.slides[3].hidden === undefined, 'hide false shows again')
  ok(run({ op: 'rename', slideId: 'a', name: ' Agenda ' }).ok && store.doc.slides[0].name === 'Agenda', 'rename (trimmed)')
  ok(run({ op: 'rename', slideId: 'a', name: '' }).ok && store.doc.slides[0].name === undefined, 'rename "" removes the name')
  ok(run({ op: 'transition', slideIds: ['a', 'b'], kind: 'push', dir: 'left' }).ok && store.doc.slides[1].transition === 'push' && store.doc.slides[1].transitionDir === 'left', 'transition with a direction')
  const badDir = run({ op: 'transition', slideIds: ['a'], kind: 'push', dir: 'sideways' })
  ok(!badDir.ok && badDir.error.includes('right|left|bottom|top'), 'transition: a direction the kind lacks is refused with the valid ones')
  ok(run({ op: 'transition', slideIds: ['a'], kind: 'fade' }).ok && store.doc.slides[0].transitionDir === undefined, 'transition: switching kind drops a direction it cannot use')
  ok(run({ op: 'background', slideIds: ['a'], background: 'linear-gradient(90deg, #112233, #445566)' }).ok && store.doc.slides[0].background.startsWith('linear-gradient'), 'background: a gradient')
  ok(!run({ op: 'background', slideIds: ['a'], background: 'url(https://evil.example/x.png)' }).ok, 'background: url() refused')
  ok(run({ op: 'notes', slideId: 'a', text: 'First point' }).ok && run({ op: 'notes', slideId: 'a', text: 'Second', append: true }).ok && store.doc.slides[0].notes === 'First point\nSecond', 'notes: set, then append on a new line')
  const sec = run({ op: 'section_add', slideId: 'b', name: 'Main part' })
  ok(sec.ok && sectionsInOrder(store.doc).some((s) => s.id === sec.sectionId && s.startSlideId === 'b'), 'section_add returns the section id')
  ok(!run({ op: 'section_add', slideId: 'b', name: 'Again' }).ok, 'section_add: a slide starts at most one section')
  ok(!run({ op: 'section_add', slideId: 'c', name: 'State' }).ok, 'section_add: not at an interactive state')
  ok(run({ op: 'section_rename', sectionId: sec.sectionId, name: 'Core' }).ok && store.doc.sections![0].name === 'Core', 'section_rename')
  ok(run({ op: 'section_remove', sectionId: sec.sectionId }).ok && !store.doc.sections && order(store) === 'a,b,c,d', 'section_remove keeps the slides')
  ok(run({ op: 'properties', title: 'Q3 review', author: 'Ana' }).ok && store.doc.title === 'Q3 review' && store.doc.meta?.author === 'Ana', 'properties: title and author')
  ok(run({ op: 'properties', author: '' }).ok && store.doc.meta === undefined, 'properties: "" clears, an empty meta is dropped')
  ok(!run({ op: 'properties' }).ok, 'properties: nothing given is refused')
  ok(run({ op: 'properties', language: 'DE' }).ok && store.doc.meta?.language === 'de', 'properties: language is stored canonical')
  ok(!run({ op: 'properties', language: 'not a code!' }).ok && store.doc.meta?.language === 'de', 'properties: a bad language code is refused')
  ok(run({ op: 'properties', language: '' }).ok && store.doc.meta === undefined, 'properties: "" clears the language')
}

// ---- 3b. states and hover groups -------------------------------------------------
console.log('-- states, hover --')
{
  const { store, ctx, run } = fresh()
  store.doc.slides[0].elements.push(defaultText({ id: 'btn', html: 'Details' }))
  const st = run({ op: 'state_add', slideId: 'a', linkFrom: 'btn', name: 'Details open' })
  const state = store.doc.slides.find((s) => s.id === st.slideId)!
  ok(st.ok && state.stateOf === 'a' && store.doc.slides[1] === state && state.transition === 'morph' && state.name === 'Details open', 'state_add: a morphing state right after its parent')
  ok(store.doc.slides[0].elements[0].link === state.id && state.elements[0].id === 'btn', 'state_add: linkFrom links the element to it; element ids kept')
  ok(ctx.created.has(state.id), 'state_add: the state counts as agent-created')
  const st2 = run({ op: 'state_add', slideId: state.id })
  ok(store.doc.slides.find((s) => s.id === st2.slideId)?.stateOf === 'a' && store.doc.slides[2].id === st2.slideId, 'state_add on a state: same parent, after the existing states')
  ok(!run({ op: 'state_add', slideId: 'a', linkFrom: 'nope' }).ok, 'state_add: unknown linkFrom refused')
  store.doc.slides[0].elements.push(defaultText({ id: 'new', html: 'Added later' }))
  const sync = run({ op: 'state_sync', slideId: state.id })
  ok(sync.ok && sync.summary.includes('1 element(s) pulled in') && state.elements.some((e) => e.id === 'new'), 'state_sync pulls in what the parent gained')
  ok(!run({ op: 'state_sync', slideId: 'a' }).ok, 'state_sync on a normal slide is refused')
  ok(run({ op: 'hover', slideId: 'd', type: 'focus-group', dim: 0.3 }).ok && JSON.stringify(store.doc.slides.at(-1)!.hover) === '{"type":"focus-group","dim":0.3}', 'hover focus-group with dim')
  ok(run({ op: 'hover', slideId: 'd', type: 'reveal', revealDefault: 'intro' }).ok && JSON.stringify(store.doc.slides.at(-1)!.hover) === '{"type":"reveal","default":"intro"}', 'hover reveal: dim dropped, default set')
  ok(!run({ op: 'hover', slideId: 'd', type: 'reveal', dim: 0.5 }).ok, 'hover: dim only for focus-group')
  ok(!run({ op: 'hover', slideId: 'd', type: 'focus-group', dim: 2 }).ok, 'hover: dim range checked (number type)')
  ok(run({ op: 'hover', slideId: 'd', type: 'none' }).ok && store.doc.slides.at(-1)!.hover === undefined, 'hover none switches it off')
}

// ---- 3c. deck_settings ---------------------------------------------------------
console.log('-- deck_settings --')
{
  const store = new Store(deck())
  const ctx: OpContext = { store, created: new Set() }
  const run = (a: Record<string, unknown>) => runAreaOp('deck_settings', a, ctx) as any
  const doc = store.doc
  const tinted = defaultShape('rect', { id: 'tint', fill: doc.theme.accent, themeRefs: { fill: 'accent1' } })
  const fixed = defaultShape('rect', { id: 'fixed', fill: '#123456' })
  doc.slides[0].elements.push(tinted, fixed)
  doc.theme.chartPalette = deriveChartPalette(doc.theme.accent)
  const th = run({ op: 'theme', accent: '#e11d48', accent2: '#0ea5e9', fontFamily: 'Inter', headingFamily: 'Georgia' })
  ok(th.ok && doc.theme.accent === '#e11d48' && doc.theme.palette?.accent2 === '#0ea5e9' && doc.theme.fontFamily === 'Inter' && doc.theme.headingFamily === 'Georgia', 'theme: colours and fonts set')
  ok((doc.slides[0].elements[0] as { fill: string }).fill === '#e11d48' && (doc.slides[0].elements[1] as { fill: string }).fill === '#123456', 'theme: an element picked from the palette follows, a literal colour stays')
  ok(JSON.stringify(doc.theme.chartPalette) === JSON.stringify(deriveChartPalette('#e11d48')), 'theme: a stored chart palette follows the new accent')
  store.undo()
  ok(store.doc.theme.accent !== '#e11d48' && (store.doc.slides[0].elements[0] as { fill: string }).fill !== '#e11d48', 'theme: one undo step reverts theme AND the followed colours')
  ok(!run({ op: 'theme', accent: 'url(x)' }).ok && !run({ op: 'theme', fontFamily: 'x;} body{' }).ok && !run({ op: 'theme' }).ok, 'theme: bad colour, unsafe font, nothing given → refused')
  ok(run({ op: 'theme', headingFamily: '' }).ok && store.doc.theme.headingFamily === undefined, 'theme: headingFamily "" = the body font')

  store.doc.slides[0].elements.push(defaultShape('rect', { id: 'wide', x: 1100, y: 100, w: 150, h: 50 }))
  const sz = run({ op: 'size', preset: '4:3' })
  ok(sz.ok && store.doc.size.width === 960 && store.doc.size.height === 720 && sz.summary.includes('Nothing was rescaled') && sz.summary.includes('past the edge on 1 slide'), `size: preset, nothing rescaled, overflow reported (${sz.summary})`)
  ok(run({ op: 'size', width: 5000 }).ok === false, 'size: range checked')
  ok(run({ op: 'size', width: 1280 }).ok && store.doc.size.width === 1280 && store.doc.size.height === 720, 'size: width alone keeps the height')
  ok(!run({ op: 'size', preset: '16:9', width: 1000 }).ok && !run({ op: 'size' }).ok, 'size: preset and width together / nothing → refused')

  ok(run({ op: 'present', counter: false, loop: true, autoAdvance: 12 }).ok && JSON.stringify(store.doc.present) === '{"slideNumber":false,"loop":true,"autoAdvance":12}', 'present: non-defaults written')
  ok(run({ op: 'present', counter: true, loop: false, autoAdvance: 0 }).ok && store.doc.present === undefined, 'present: defaults deleted, an empty block dropped')
  ok(!run({ op: 'present', morphSeconds: 9 }).ok, 'present: morphSeconds range checked')

  ok(run({ op: 'slide_timing', slideIds: ['a'], advanceAfter: 5, autoBuild: true }).ok && store.doc.slides[0].advanceAfter === 5 && JSON.stringify(store.doc.slides[0].autoBuild) === '{"every":2,"hold":2,"loop":true}', 'slide_timing: advanceAfter + autoBuild with the app\'s defaults')
  ok(run({ op: 'slide_timing', slideIds: ['a'], every: 1, buildLoop: false }).ok && JSON.stringify(store.doc.slides[0].autoBuild) === '{"every":1,"hold":2}', 'slide_timing: patch; loop false dropped')
  ok(!run({ op: 'slide_timing', slideIds: ['b'], every: 1 }).ok, 'slide_timing: every on a slide without auto-play is refused')
  ok(run({ op: 'slide_timing', slideIds: ['a'], autoBuild: false, advanceAfter: 0 }).ok && !store.doc.slides[0].autoBuild && store.doc.slides[0].advanceAfter === undefined, 'slide_timing: off again')

  const hf = run({ op: 'header_footer', showFooter: true, footerText: 'ACME · internal', date: 'fixed', dateText: '10 Oct 2026' })
  ok(hf.ok && JSON.stringify(store.doc.headerFooter) === '{"date":{"fixed":"10 Oct 2026"},"footer":{"text":"ACME · internal"}}', 'header_footer: normalised like the app (show only when false)')
  ok(hf.summary.includes('No text box shows date, slideNumber, footer yet') && hf.summary.includes('footer_elements'), 'header_footer: says which boxes are missing and how to add them')
  ok(run({ op: 'header_footer', date: 'off', hideOnTitle: true }).ok && store.doc.headerFooter?.date?.show === false && store.doc.headerFooter?.hideOnTitle === true, 'header_footer: date off, hide on title')
  ok(!run({ op: 'header_footer', dateText: 'x' }).ok, 'header_footer: dateText needs date fixed')

  const layout = emptySlide({ id: 'L1', name: 'Content' })
  store.doc.layouts = [layout]
  store.doc.slides[1].layoutId = 'L1'
  const fe = run({ op: 'footer_elements', slideType: 'L1', roles: ['slideNumber', 'footer'] })
  ok(fe.ok && layout.elements.filter((e) => (e as { footerRole?: string }).footerRole).length === 2, 'footer_elements: boxes added to the slide type')
  ok(store.doc.slides[1].elements.some((e) => (e as { footerRole?: string }).footerRole === 'slideNumber'), 'footer_elements: the linked slide shows them')
  ok(run({ op: 'footer_elements', slideType: 'L1', roles: ['footer'] }).summary.includes('already has'), 'footer_elements: an existing role is not added twice')
  ok(!run({ op: 'footer_elements', slideType: 'L1', roles: ['logo'] }).ok && !run({ op: 'footer_elements', slideType: 'nope', roles: ['date'] }).ok, 'footer_elements: bad role / unknown type refused')
  ok(run({ op: 'slide_footer', slideIds: ['b'], role: 'footer', visible: false }).ok && JSON.stringify(store.doc.slides[1].footer) === '{"footer":false}', 'slide_footer: hidden on one slide')
  ok(run({ op: 'slide_footer', slideIds: ['b'], role: 'footer', visible: true }).ok && store.doc.slides[1].footer === undefined, 'slide_footer: shown again = override removed')
  ok(run({ op: 'numbering', slideIds: ['a'], exclude: true }).ok && store.doc.slides[0].excludeFromNumbering === true, 'numbering: excluded')
  ok(!run({ op: 'numbering', slideIds: ['c'], exclude: true }).ok, 'numbering: states are refused (never numbered)')

  const lg = run({ op: 'layout_grid', columns: 12 })
  ok(lg.ok && JSON.stringify(store.doc.layoutGrid) === '{"columns":12,"rows":0,"gutter":24,"marginX":96,"marginY":64}', `layout_grid: a new grid starts from the defaults (${JSON.stringify(store.doc.layoutGrid)})`)
  ok(lg.summary.includes('Columns (x, w): 96,68.7 188.7,68.7'), `layout_grid: the result lists the column boxes (${lg.summary})`)
  ok(run({ op: 'layout_grid', gutter: 16, rows: 3 }).ok && store.doc.layoutGrid?.columns === 12 && store.doc.layoutGrid?.gutter === 16 && store.doc.layoutGrid?.rows === 3, 'layout_grid: unset values are kept')
  ok(!run({ op: 'layout_grid' }).ok && !run({ op: 'layout_grid', columns: 30 }).ok, 'layout_grid: nothing given / out of range → refused')
  store.undo()
  ok(store.doc.layoutGrid?.gutter === 24 && store.doc.layoutGrid?.rows === 0, 'layout_grid: one undo step per call')
  ok(run({ op: 'layout_grid', columns: 0 }).ok && store.doc.layoutGrid === undefined, 'layout_grid: columns 0 removes it')
}

// ---- 3d. icons --------------------------------------------------------------------
console.log('-- icons --')
{
  const store = new Store(deck())
  type Icon = AgentIcon & { file: string }
  const inserted: Array<{ slideId: string; file: string; frame: { x: number; y: number; w: number; h: number }; alt: string }> = []
  let down = false
  const icons: IconLibraryAccess<Icon> = {
    refs: new Map(),
    async search(q) {
      if (down) throw new Error("can't reach http://localhost:5050.")
      const all: Icon[] = [
        { name: 'cloud-upload.svg', ext: 'svg', file: 'cloud-upload.svg', category: 'cloud', description: 'Upload to the cloud', provenance: { license: 'CC0-1.0' } },
        { name: 'cloud.svg', ext: 'svg', file: 'cloud.svg' },
        { name: 'user.png', ext: 'png', file: 'user.png' },
      ]
      return { icons: all.filter((i) => i.name.includes(q)), notes: q === 'user' ? ['Team folder: this folder needs the user\'s permission again'] : [] }
    },
    async insert(slideId, icon, frame, alt) {
      if (slideId === 'nope') return { error: 'no-such-slide' }
      inserted.push({ slideId, file: icon.file, frame, alt })
      return { elementId: `svg-${inserted.length}` }
    },
  }
  const ctx: OpContext = { store, created: new Set(), icons: icons as IconLibraryAccess }
  const run = (a: Record<string, unknown>) => Promise.resolve(runAreaOp('icons', a, ctx)) as Promise<any>
  const found = await run({ op: 'search', query: 'cloud' })
  ok(found.ok && found.refs.join() === 'i1,i2' && found.summary.includes('i1 "cloud-upload" (cloud — Upload to the cloud) [svg, license: CC0-1.0]') && found.summary.includes('i2 "cloud" [svg, license unknown]') && found.summary.includes('op "insert"'), `search lists refs with names, categories, license and how to insert (${found.summary.split('\n')[0]})`)
  const more = await run({ op: 'search', query: '', limit: 1 })
  ok(more.refs.join() === 'i3' && more.summary.startsWith('1 of 3+'), 'limit caps the list, refs keep counting (never reused within a session)')
  const partial = await run({ op: 'search', query: 'user' })
  ok(partial.ok && partial.refs.length === 1 && partial.summary.includes('Not searched: Team folder'), 'a source that failed while others answered is named, the results still come')
  const none = await run({ op: 'search', query: 'zebra' })
  ok(none.ok && none.refs.length === 0 && none.summary.includes('Try a shorter'), 'no hit: ok, with a hint to search differently')
  const put = await run({ op: 'insert', slideId: 'a', ref: 'i2', x: 100, y: 200, size: 64, alt: 'Cloud' })
  ok(put.ok && put.elementId === 'svg-1' && JSON.stringify(inserted[0]) === JSON.stringify({ slideId: 'a', file: 'cloud.svg', frame: { x: 100, y: 200, w: 64, h: 64 }, alt: 'Cloud' }), 'insert hands the right icon, frame and alt to the editor')
  await run({ op: 'insert', slideId: 'a', ref: 'i1' })
  const { width, height } = store.doc.size
  ok(JSON.stringify(inserted[1].frame) === JSON.stringify({ x: Math.round(width / 2 - 48), y: Math.round(height / 2 - 48), w: 96, h: 96 }) && inserted[1].alt === '', 'insert defaults: 96px, centred, decorative')
  ok((await run({ op: 'insert', slideId: 'a', ref: 'i99' })).error.includes('No icon "i99"'), 'an unknown ref is refused')
  ok((await run({ op: 'insert', slideId: 'nope', ref: 'i1' })).error === 'no-such-slide', 'the editor\'s refusal comes back')
  ok((await run({ op: 'insert', slideId: 'a' })).error.includes('ref is required'), 'args checked before the handler (async ops too)')
  down = true
  const failed = await run({ op: 'search', query: 'cloud' })
  ok(!failed.ok && failed.error.includes("can't reach") && failed.error.includes('Settings ▸ Icon library') && failed.error.includes('not hand-drawn SVG'), 'an unreachable library: the reason, where the user fixes it, and the fallback')
  const bare = await Promise.resolve(runAreaOp('icons', { op: 'search', query: 'x' }, { store, created: new Set() })) as any
  ok(!bare.ok && bare.error.includes('No icon library'), 'no library (headless): refused, never thrown')

  // plan: icon sets only — the plan becomes empty, named icons, nothing is drawn
  const notSet = runAreaOp('icons', { op: 'plan', icons: [{ name: 'x' }] }, ctx) as any
  ok(!notSet.ok && notSet.error.includes('icon set only'), 'plan in a deck is refused')
  const set = new Store(newIconsetDoc())
  const sctx: OpContext = { store: set, created: new Set() }
  const plan = runAreaOp('icons', { op: 'plan', icons: [
    { name: 'fingerprint', prompt: 'a fingerprint in a magnifier', keywords: ['print', 'finger'] },
    { name: 'evidence bag', prompt: 'a sealed bag with a tag' },
  ] }, sctx) as any
  ok(plan.ok && set.doc.slides.map((s) => s.name).join() === 'fingerprint,evidence bag' && plan.summary.includes('Do not draw'), `the plan fills the blank starter icon, then adds (${set.doc.slides.map((s) => s.name)})`)
  ok(set.doc.slides[0].icon?.prompt === 'a fingerprint in a magnifier' && set.doc.slides.every((s) => !s.elements.length), 'prompts and keywords written, nothing drawn')
  set.doc.slides[0].elements.push({ id: 'drawn', type: 'shape', shape: 'rect', x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, fill: '#000', stroke: '#000', strokeWidth: 0, radius: 0 } as never)
  const again = runAreaOp('icons', { op: 'plan', replace: true, icons: [{ name: 'Hash', prompt: '# on a page' }] }, sctx) as any
  ok(again.ok && set.doc.slides.map((s) => s.name).join() === 'fingerprint,Hash', `replace drops the still-empty icons the plan leaves out, keeps the drawn one (${set.doc.slides.map((s) => s.name)})`)
  ok(!(runAreaOp('icons', { op: 'plan', icons: [{ name: 'a' }, { name: 'A' }] }, sctx) as any).ok, 'a name planned twice is refused')

  // style: icon sets only — a look the set is painted in, nothing redrawn
  ok(!(runAreaOp('icons', { op: 'style', name: 'Comic' }, ctx) as any).ok, 'style in a deck is refused')
  const drawnBefore = JSON.stringify(set.doc.slides.map((s) => s.elements))
  const st = runAreaOp('icons', { op: 'style', name: 'Comic', weight: 1.4, color: '#111111', body: '#ffd23f', accent: '#ff4f6d', shadowX: 0.9, shadowY: 0.9, tile: 'none' }, sctx) as any
  const v = set.doc.iconset?.variants ?? []
  ok(st.ok && v.length === 1 && v[0].name === 'Comic' && v[0].fill?.body?.color === '#ffd23f' && v[0].shadow?.dx === 0.9 && !v[0].tile, `the style is added (${JSON.stringify(v[0])})`)
  ok(JSON.stringify(set.doc.slides.map((s) => s.elements)) === drawnBefore, 'no icon was touched')
  const st2 = runAreaOp('icons', { op: 'style', name: 'comic', weight: 2, color: 'url(evil)' }, sctx) as any
  ok(st2.ok && set.doc.iconset!.variants!.length === 1 && set.doc.iconset!.variants![0].stroke.weight === 2 && set.doc.iconset!.variants![0].id === v[0].id, 'the same name replaces it, keeping its id')
  ok(set.doc.iconset!.variants![0].stroke.color === '#000000', 'a bad colour falls back, never reaches markup')

  // tweak: one icon its own way in one style — the drawing stays
  const icon = set.doc.slides[0]
  const drawnNow = JSON.stringify(set.doc.slides.map((s) => s.elements))
  const tw = runAreaOp('icons', { op: 'tweak', style: 'Comic', slideId: icon.id, elementIds: ['drawn'], fill: '#22c55e', fillOpacity: 0.5, stroke: '#dc2626' }, sctx) as any
  const tweaks = () => set.doc.iconset!.variants![0].tweaks?.[icon.id]?.drawn
  ok(tw.ok && tweaks()?.fill && typeof tweaks()!.fill === 'object' && (tweaks()!.fill as any).color === '#22c55e' && (tweaks()!.fill as any).opacity === 0.5 && tweaks()?.stroke === '#dc2626', `the shape's own paint is written into the style (${JSON.stringify(tweaks())})`)
  ok(JSON.stringify(set.doc.slides.map((s) => s.elements)) === drawnNow, 'the drawing is untouched')
  ok((runAreaOp('icons', { op: 'tweak', style: 'Comic', slideId: icon.id, elementIds: ['drawn'], hide: true, stroke: 'style' }, sctx) as any).ok && tweaks()?.hide === true && !tweaks()?.stroke && !!tweaks()?.fill, 'hide adds, "style" removes one paint, the rest stays')
  ok((runAreaOp('icons', { op: 'tweak', style: 'Comic', slideId: icon.id, elementIds: ['drawn'], reset: true }, sctx) as any).ok && set.doc.iconset!.variants![0].tweaks === undefined, 'reset drops them all')
  ok((runAreaOp('icons', { op: 'tweak', style: 'Nope', slideId: icon.id, elementIds: ['drawn'] }, sctx) as any).error.includes('No style "Nope"'), 'an unknown style is refused')
  ok((runAreaOp('icons', { op: 'tweak', style: 'Comic', slideId: icon.id, elementIds: ['ghost'] }, sctx) as any).error.includes('Not shapes of this icon: ghost'), 'a shape of another icon is refused')
  ok((runAreaOp('icons', { op: 'tweak', style: 'Comic', slideId: icon.id, elementIds: ['drawn'], fill: 'url(#x)' }, sctx) as any).error.includes('not a colour'), 'a bad colour is refused')
  ok(!(runAreaOp('icons', { op: 'tweak', style: 'Comic', slideId: 'a', elementIds: ['x'] }, ctx) as any).ok, 'tweak in a deck is refused')
}

// ---- 3e. elements ------------------------------------------------------------------
console.log('-- elements --')
/** The user's "Status and next steps" slide: 7 AP cards (box + title + body)
 *  in the upper part, a legend, and in the lower third two cards joined by an
 *  arrow plus a full-width summary bar. `jitter` hand-misaligns the cards. */
function statusSlide(jitter = false): SlidomingoDoc {
  const doc = newDoc()
  const s = emptySlide({ id: 's1' })
  s.elements.push(defaultText({ id: 'title', role: 'title', x: 64, y: 40, w: 1152, h: 60, html: 'Status and next steps' }))
  const jx = [0, 7, -5, 12, 3, -9, 4], jy = [0, -6, 9, 3, -12, 5, 8], jw = [0, 0, 0, 14, 0, 0, 0]
  for (let i = 0; i < 7; i++) {
    const x = 64 + i * 166 + (jitter ? jx[i] : 0)
    const y = 130 + (jitter ? jy[i] : 0)
    const w = 150 + (jitter ? jw[i] : 0)
    s.elements.push(defaultShape('rect', { id: `card${i + 1}`, x, y, w, h: 150 }))
    s.elements.push(defaultText({ id: `card${i + 1}-t`, x: x + 10, y: y + 10, w: w - 20, h: 30, html: `AP 11.${i + 1}` }))
    s.elements.push(defaultText({ id: `card${i + 1}-b`, x: x + 10, y: y + 50, w: w - 20, h: 80, html: 'Work package' }))
  }
  s.elements.push(defaultText({ id: 'legend', x: 64, y: 300, w: 400, h: 30, html: 'done · in progress · open' }))
  s.elements.push(defaultShape('rect', { id: 'fz', x: 100, y: 400, w: 300, h: 120 }))
  s.elements.push(defaultText({ id: 'fz-t', x: 110, y: 420, w: 280, h: 40, html: 'Finale Zahlen' }))
  s.elements.push(defaultShape('rect', { id: 'ab', x: 700, y: 400, w: 300, h: 120 }))
  s.elements.push(defaultText({ id: 'ab-t', x: 710, y: 420, w: 280, h: 40, html: 'Abschlussbericht' }))
  s.elements.push(defaultShape('line', { id: 'arrow', x: 400, y: 459, w: 300, h: 2, from: { el: 'fz', side: 'right' }, to: { el: 'ab', side: 'left' } } as never))
  s.elements.push(defaultShape('rect', { id: 'bar', x: 64, y: 580, w: 1152, h: 70 }))
  s.elements.push(defaultText({ id: 'bar-t', x: 80, y: 595, w: 1100, h: 40, html: 'Summary' }))
  doc.slides = [s]
  return doc
}
const elementsCtx = (doc: SlidomingoDoc) => {
  const store = new Store(doc)
  const ctx: OpContext = { store, created: new Set() }
  return { store, run: (a: Record<string, unknown>) => runAreaOp('elements', a, ctx) as any, el: (id: string) => store.doc.slides[0].elements.find((e) => e.id === id) }
}
const cards = Array.from({ length: 7 }, (_, i) => `card${i + 1}`)
{
  // the comment case: everything in the lower third goes, in ONE call
  const { store, run, el } = elementsCtx(statusSlide())
  const n = store.doc.slides[0].elements.length
  const r = run({ op: 'delete', slideId: 's1', elementIds: ['fz', 'fz-t', 'ab', 'ab-t', 'arrow', 'bar', 'bar-t'] })
  ok(r.ok && store.doc.slides[0].elements.length === n - 7 && !el('arrow') && !el('bar'), `delete: seven elements in one call (${r.ok ? r.summary.split('\n')[0] : r.error})`)
  ok(r.summary.includes('Freed ') && r.summary.includes('within:"space"'), 'delete: the result names the empty area and how to use it')
  store.undo()
  ok(store.doc.slides[0].elements.length === n, 'delete: one undo step brings all of them back')
  const missing = run({ op: 'delete', slideId: 's1', elementIds: ['fz', 'nope'] })
  ok(!missing.ok && missing.error.includes('"nope"') && store.doc.slides[0].elements.length === n, 'delete: an unknown id refuses the whole call, nothing half-deleted')
  const single = run({ op: 'delete', slideId: 's1', elementId: 'legend' })
  ok(single.ok && !el('legend'), 'delete: a single elementId is accepted for elementIds (no wasted call)')
}
{
  // a span of the deck's layout grid as the region
  const { store, run, el } = elementsCtx(statusSlide())
  const noGrid = run({ op: 'arrange', slideId: 's1', elementIds: cards, as: 'row', within: 'columns 7-12' })
  ok(!noGrid.ok && noGrid.error.includes('layout_grid'), 'arrange within columns: without a layout grid the error says how to make one')
  store.doc.layoutGrid = { columns: 12, rows: 0, gutter: 24, marginX: 96, marginY: 64 }
  const r = run({ op: 'arrange', slideId: 's1', elementIds: cards, as: 'column', within: 'columns 7-12' })
  ok(r.ok, `arrange within columns 7-12 (${r.ok ? r.summary.split('\n')[0] : r.error})`)
  const boxes = cards.map((id) => el(id)!)
  // column 7 starts at 96 + 6 × (68.667 + 24) = 652; column 12 ends at 1184
  ok(boxes.every((b) => b.x >= 651.9 && b.x + b.w <= 1184.1), `arrange within columns 7-12: inside x 652..1184 (${boxes.map((b) => `${Math.round(b.x)}+${Math.round(b.w)}`).join(' ')})`)
}
{
  // ... then use the space: the cards fill the free area, cards stay whole
  const { store, run, el } = elementsCtx(statusSlide())
  run({ op: 'delete', slideId: 's1', elementIds: ['fz', 'fz-t', 'ab', 'ab-t', 'arrow', 'bar', 'bar-t'] })
  const r = run({ op: 'arrange', slideId: 's1', elementIds: cards, as: 'grid', within: 'space' })
  ok(r.ok && r.summary.includes('grid') && r.summary.includes('+2 inside'), `arrange in space: a grid of whole cards (${r.ok ? r.summary.split('\n')[0] : r.error})`)
  const boxes = cards.map((id) => el(id)!)
  ok(boxes.every((b) => b.y >= 100 && b.y + b.h <= 720), 'arrange in space: below the title, on the slide')
  ok(Math.max(...boxes.map((b) => b.y + b.h)) > 560, 'arrange in space: the cards now use the freed lower part')
  ok(boxes.every((b) => Math.abs(b.w - boxes[0].w) < 1 && Math.abs(b.h - boxes[0].h) < 1), 'arrange in space: equal cells')
  const inside = cards.every((id) => { const c = el(id)!, t = el(`${id}-t`)!; return t.x >= c.x && t.x + t.w <= c.x + c.w + 1 && t.y >= c.y && t.y + t.h <= c.y + c.h + 1 })
  ok(inside, 'arrange: each card\'s texts moved and scaled with their box')
  const legend = el('legend')!
  ok(!boxes.some((b) => Math.min(b.x + b.w, legend.x + legend.w) > Math.max(b.x, legend.x) && Math.min(b.y + b.h, legend.y + legend.h) > Math.max(b.y, legend.y)), 'arrange in space: never on top of what stays (the legend)')
  ok(r.summary.includes('✓') || r.summary.includes('⚠'), 'arrange: the result says whether the layout is clean')
  const left = Math.min(...boxes.map((b) => b.x)), right = Math.max(...boxes.map((b) => b.x + b.w)), bottom = Math.max(...boxes.map((b) => b.y + b.h))
  ok(right - left > 1000, `arrange in space: the grid spans the content width, not a strip beside the legend (${Math.round(left)}..${Math.round(right)})`)
  ok(legend.y >= bottom && legend.y - bottom <= 24 && r.summary.includes('kept with them: legend (below)'), `arrange: the legend under the cards stays under them (${Math.round(legend.y)} vs ${Math.round(bottom)})`)
  const rows = new Set(boxes.map((b) => Math.round(b.y)))
  ok(rows.size === 2, `arrange: 7 cards become 2 rows (${[...rows].join(', ')})`)
  store.undo()
  ok(el('card1')!.y === 130, 'arrange: one undo step')
}
{
  // the "alignment looks weird" case: realign in place
  const { run, el } = elementsCtx(statusSlide(true))
  const r = run({ op: 'arrange', slideId: 's1', elementIds: cards, as: 'row' })
  const boxes = cards.map((id) => el(id)!)
  const tops = new Set(boxes.map((b) => Math.round(b.y)))
  const widths = new Set(boxes.map((b) => Math.round(b.w)))
  const gaps = boxes.slice(1).map((b, i) => Math.round(b.x - (boxes[i].x + boxes[i].w)))
  ok(r.ok && tops.size === 1 && widths.size === 1, `arrange row in place: one top, one width (${r.ok ? r.summary.split('\n')[0] : r.error})`)
  ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `arrange row in place: even gaps (${gaps.join(', ')})`)
  ok(Math.abs(boxes[0].x - 64) < 1 && Math.abs(boxes[6].x + boxes[6].w - (64 + 6 * 166 + 4 + 150)) < 1, 'arrange row in place: the row keeps its two ends')
}
{
  const { run, el } = elementsCtx(statusSlide(true))
  ok(run({ op: 'align', slideId: 's1', elementIds: cards, edge: 'top' }).ok && new Set(cards.map((id) => el(id)!.y)).size === 1, 'align top')
  ok(el('card2-t')!.y === el('card2')!.y + 10, 'align: a card\'s text moves with its box')
  const d = run({ op: 'distribute', slideId: 's1', elementIds: cards, axis: 'x' })
  const boxes = cards.map((id) => el(id)!).sort((a, b) => a.x - b.x)
  const gaps = boxes.slice(1).map((b, i) => b.x - (boxes[i].x + boxes[i].w))
  ok(d.ok && Math.max(...gaps) - Math.min(...gaps) < 0.5, 'distribute x: equal gaps')
  const m = run({ op: 'match_size', slideId: 's1', elementIds: cards, dim: 'w', to: 'smallest' })
  ok(m.ok && new Set(cards.map((id) => el(id)!.w)).size === 1, 'match_size: one width')
  ok(!run({ op: 'distribute', slideId: 's1', elementIds: ['card1', 'card2'], axis: 'x' }).ok, 'distribute needs three items (or a gap)')
  ok(run({ op: 'arrange', slideId: 's1', elementIds: [...cards, ...cards.map((c) => `${c}-t`)], as: 'row' }).summary.includes('Arranged 7 items'), 'arrange: texts inside a picked card join it (7 items, not 14)')
}
{
  // edit: a mixed batch, all-or-nothing
  const { store, run, el } = elementsCtx(statusSlide())
  const r = run({ op: 'edit', slideId: 's1', changes: [
    ...cards.map((c) => ({ id: `${c}-t`, color: '#1F3A5F', fontWeight: 700 })),
    { id: 'legend', x: 80, y: 310 },
    { id: 'bar-t', delete: true },
  ] })
  ok(r.ok && el('card3-t')!.color === '#1F3A5F' && (el('card3-t') as any).fontWeight === 700 && el('legend')!.x === 80 && !el('bar-t'), `edit: props, a move and a delete in one call (${r.ok ? r.summary.split('\n')[0] : r.error})`)
  store.undo()
  ok(el('card3-t')!.color !== '#1F3A5F' && !!el('bar-t'), 'edit: one undo step')
  const bad = run({ op: 'edit', slideId: 's1', changes: [{ id: 'card1-t', color: '#000' }, { id: 'card2-t', colour: 'red' }] })
  ok(!bad.ok && bad.error.includes('changes[1]') && bad.error.includes('colour') && el('card1-t')!.color !== '#000', 'edit: one bad change refuses all, naming it')
  ok(!run({ op: 'edit', slideId: 's1', changes: [{ id: 'card1', type: 'text' }] }).ok, 'edit: the type cannot change')
  ok(run({ op: 'edit', slideId: 's1', changes: [{ id: 'card1-t', set: { color: '#222222' } }] }).ok && el('card1-t')!.color === '#222222', 'edit: nested {set:{…}} reads the same as flat props')
  store.doc.slides[0].elements.push({ id: 'pic', type: 'svg', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 } as any)
  const svg = run({ op: 'edit', slideId: 's1', changes: [{ id: 'pic', markup: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h9z"/></svg>' }] })
  ok(!svg.ok && /SVG/.test(svg.error) && !(el('pic') as any).markup, 'edit: AI-written SVG is refused like on update_element')
}

// ---- 3f. AI-written SVG is refused ------------------------------------------------
console.log('-- no agent svg --')
{
  const MARK = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>'
  const doc = deck()
  doc.assets = { known: MARK }
  const box = { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 }
  const own = { id: 'own', type: 'svg', ...box, asset: 'known' } as any
  const v = (els: unknown[], o: Parameters<typeof agentSvgViolation>[2] = {}) => agentSvgViolation(doc, els, o)
  ok(/AI-written SVG is refused/.test(v([{ id: 'a', type: 'svg', ...box, markup: MARK }]) ?? ''), 'an svg with its own markup is refused')
  ok(/icons tool/.test(v([{ type: 'svg', ...box, markup: MARK }]) ?? '') && /#1/.test(v([{ type: 'svg', ...box, markup: MARK }]) ?? ''), 'the refusal names the way out, and an id-less spec by position')
  ok(v([{ id: 'a', type: 'svg', ...box, asset: 'new' }]) !== null, 'an svg pointing at an asset the deck does not hold is refused')
  ok(v([{ id: 'a', type: 'svg', ...box, asset: 'known' }]) === null, 'an svg pointing at artwork already in the deck is fine')
  ok(v([{ id: 'a', type: 'svg', ...box }]) === null, 'an empty svg adds no artwork')
  ok(v([], { assets: { x: MARK } }) !== null && v([], { assets: { x: '<?xml version="1.0"?><svg/>' } }) !== null, 'svg markup smuggled through the asset map is refused')
  ok(v([], { assets: { x: 'data:image/png;base64,AAAA' } }) === null, 'a picture asset is not')
  ok(v([], { assets: { known: MARK } }) === null, 'an asset the deck already holds, unchanged, is not new')
  ok(v([{ id: 'a', type: 'image', ...box, src: 'data:image/svg+xml;utf8,' + encodeURIComponent(MARK), fit: 'cover', radius: 0 }]) !== null, 'a picture whose src is an svg data URI is the same artwork, refused')
  ok(v([{ id: 'a', type: 'image', ...box, src: 'data:image/png;base64,AAAA', fit: 'cover', radius: 0 }]) === null, 'an ordinary picture is fine')
  ok(v([{ id: 'a', type: 'shape', shape: 'path', ...box, d: 'M0 0L10 10', pathBox: [0, 0, 10, 10], fill: '#000', stroke: 'none', strokeWidth: 0, radius: 0 }]) === null, 'native path shapes are what we want')
  const inline = { id: 'in', type: 'svg', ...box, markup: MARK } as any
  ok(v([inline], { existing: [inline] }) === null, 'a write_slide round trip of an inline svg the slide already had is accepted')
  ok(v([{ ...inline, markup: MARK + ' ' }], { existing: [inline] }) !== null, 'changing that markup is not')
  ok(v([{ ...inline, id: 'other' }], { existing: [inline] }) !== null, 'the same markup under a new id is a new svg')
  ok(v('not an array' as unknown) === null && v([null, 3, 'x']) === null, 'garbage specs are not this guard’s business (the sanitizer drops them)')
  ok(agentSvgPatchViolation(doc, own, { markup: MARK }) !== null && agentSvgPatchViolation(doc, own, { asset: 'new' }) !== null, 'update_element cannot swap an svg’s markup or asset')
  ok(agentSvgPatchViolation(doc, own, { asset: 'known' }) === null && agentSvgPatchViolation(doc, own, { alt: 'x', opacity: 0.5, css: 'a{}' }) === null, 'but everything else on it still works')
}

console.log('-- slide_html (merge, keep, fingerprint; layout faked — the browser rig is test-slide-html-e2e.mjs) --')
{
  const doc = newDoc()
  const s = emptySlide({ id: 's1' })
  s.elements.push(defaultText({ id: 't1', x: 10, y: 10, w: 100, h: 40, html: 'Old', fx: { enter: 'fade-up' }, link: 's2' }))
  s.elements.push(defaultShape('rect', { id: 'gone', x: 0, y: 0, w: 10, h: 10 }))
  doc.slides = [s, emptySlide({ id: 's2' })]
  const store = new Store(doc)
  const noLayout = await runAreaOp('slide_html', { op: 'write', slideId: 's1', html: '<p>x</p>' }, { store, created: new Set() })
  ok(!noLayout.ok && /needs the app/.test((noLayout as { error: string }).error), 'without a browser layout: refused with a reason, nothing changed')
  const compiled = [
    defaultText({ id: 't1', x: 96, y: 72, w: 600, h: 60, html: 'New', fontSize: 48 }),
    defaultShape('rect', { id: 'box', x: 96, y: 200, w: 300, h: 100, fill: '#123456' }),
  ]
  const html: HtmlLayout = {
    compile: async () => ({ elements: compiled.map((e) => ({ ...e })), background: '#FBF7EF', notes: ['A note.'], remember: { html: '<h1 id="t1">New</h1>' } }),
    read: async () => ({ html: '<h1 id="t1">New</h1>', source: 'remembered', flowGroups: 0, notes: [] }),
  }
  const ctx: OpContext = { store, created: new Set(), html }
  const before = store.doc.slides[0].elements.length
  const r = await runAreaOp('slide_html', { op: 'write', slideId: 's1', html: '<h1 id="t1">New</h1>' }, ctx) as { ok: boolean; summary: string }
  const sl = store.doc.slides[0]
  const t1 = sl.elements.find((e) => e.id === 't1') as SlideElement & { html: string }
  ok(r.ok && /1 updated in place, 1 new, 1 removed \(gone\)/.test(r.summary) && /Note: A note\./.test(r.summary) && /review_slide/.test(r.summary), 'write reports updated / new / removed, the notes, and points at review_slide')
  ok(t1.html === 'New' && t1.x === 96 && t1.fx?.enter === 'fade-up' && t1.link === 's2', 'same id: HTML-owned props replaced, fx and link kept')
  ok(!sl.elements.some((e) => e.id === 'gone') && sl.background === '#FBF7EF', 'an id the HTML dropped is removed; the background is set')
  ok(sl.htmlSource?.html === '<h1 id="t1">New</h1>' && sl.htmlSource.sig === htmlSignature(sl.elements, sl.background), 'the source is remembered with the slide\'s fingerprint')
  store.undo()
  ok(store.doc.slides[0].elements.length === before && !store.doc.slides[0].htmlSource, 'one undo step takes the whole write back')
  const m = mergeCompiled([defaultText({ id: 'chrome', html: 'Logo' }), defaultText({ id: 'x', html: 'a' })], [defaultText({ id: 'x', html: 'b' })], new Set(['chrome']))
  ok(m.elements.map((e) => e.id).join() === 'chrome,x' && m.removed.length === 0, 'inherited slide-type chrome survives a write that does not mention it, in its paint position')
  const svg = await runAreaOp('slide_html', { op: 'write', slideId: 's1', html: '<p>x</p>' }, { ...ctx, html: { ...html, compile: async () => ({ elements: [{ id: 'v', type: 'svg', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, markup: '<svg/>' } as unknown as SlideElement], notes: [], remember: null }) } })
  ok(!svg.ok, 'a compiled element that is new svg artwork is refused (agentsvg.ts)')
  const read = await runAreaOp('slide_html', { op: 'read', slideId: 's1' }, ctx) as { ok: boolean; summary: string }
  ok(read.ok && /the source it was written from/.test(read.summary) && read.summary.endsWith('<h1 id="t1">New</h1>'), 'read hands back the HTML')
  // a slide following a slide type keeps the type's own placeholders and footer
  const typed = newDoc()
  const ly = emptySlide({ id: 'ly1' })
  ly.elements.push(defaultText({ id: 'ph-title', role: 'title', html: '', placeholder: 'Click to add title' }), defaultText({ id: 'ph-page', html: 'Page {{page}}', footerRole: 'slideNumber' }))
  typed.layouts = [ly]
  const ts = emptySlide({ id: 't1', layoutId: 'ly1' })
  ts.elements.push(...ly.elements.map((e) => ({ ...e })), defaultText({ id: 'old', html: 'old content' }))
  typed.slides = [ts]
  const tstore = new Store(typed)
  const tw = await runAreaOp('slide_html', { op: 'write', slideId: 't1', html: '<p id="t1">New</p>' }, { store: tstore, created: new Set(), html: { ...html, compile: async () => ({ elements: [defaultText({ id: 'new', html: 'New' })], notes: [], remember: null }) } }) as { ok: boolean; summary: string }
  const kept = tstore.doc.slides[0].elements.map((e) => e.id)
  ok(tw.ok && kept.includes('ph-title') && kept.includes('ph-page') && kept.includes('new') && !kept.includes('old'), 'on a slide that follows a slide type, its placeholders and footer stay; old content goes', kept)
  const big = await runAreaOp('slide_html', { op: 'write', slideId: 's1', html: 'x'.repeat(4_000_001) }, ctx)
  ok(!big.ok, 'an over-long source is refused before any layout')
}

// ---- 4. end to end through the filled-in MCP server ----------------------------
console.log('-- MCP server --')
{
  const raw = readFileSync(join(process.cwd(), 'desktop/src/mcp/slides-mcp-server.mjs'), 'utf8')
  const filled = serverWithAgentAreas(raw)
  ok(!filled.includes('/*@AGENT_AREAS@*/') && filled.includes('"name":"deck"'), 'the app fills the placeholder with the generated tools')
  let threw = false
  try { serverWithAgentAreas('const TOOLS = []') } catch { threw = true }
  ok(threw, 'a server without the placeholder fails loudly')
  ok(agentAreaTools()[0].help.add.includes('deck op "add"') && agentAreaTools()[0].help['*'].includes('Not available to agents yet'), 'help texts are generated per op and for the area')

  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-'))
  const server = join(dir, 'slides-mcp-server.mjs')
  writeFileSync(server, filled)
  const session = join(dir, 'session')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(session)
  // A fake app: answers agent-action files with the REAL handlers on a Store.
  const store = new Store(deck())
  const ctx: OpContext = { store, created: new Set() }
  const seen = new Set<string>()
  const watcher = watch(session, (_e, name) => {
    if (!name || seen.has(name) || !/^agent-action-[^r].*\.json$/.test(name)) return
    try {
      const req = JSON.parse(readFileSync(join(session, name), 'utf8'))
      seen.add(name)
      writeFileSync(join(session, name.replace('agent-action', 'agent-action-result')), JSON.stringify({ requestId: req.requestId, ...runAreaOp(req.verb, req.args, ctx) }))
    } catch { /* not fully written yet */ }
  })
  const mcp = new McpClient(server, session)
  const tools = await mcp.start()
  const deckTool = tools.find((t) => t.name === 'deck')
  ok(!!deckTool && (deckTool.inputSchema as { properties: Record<string, unknown> }).properties.slideIds !== undefined, 'tools/list carries deck with its merged schema')
  ok(tools.some((t) => t.name === 'deck_settings'), 'tools/list carries deck_settings too (a new area needs no server change)')
  ok(tools.some((t) => t.name === 'icons'), 'tools/list carries icons')
  const elementsTool = tools.find((t) => t.name === 'elements')
  ok(!!elementsTool && ((elementsTool.inputSchema as { properties: Record<string, { type?: string; items?: { type?: string } }> }).properties.changes?.items?.type === 'object'), 'tools/list carries elements, changes typed as a list of objects')
  const sHelp = await mcp.callTool('deck_settings', { op: 'help' })
  ok(sHelp.text.includes('deck_settings op "theme"') && sHelp.text.includes('Not available to agents yet'), 'deck_settings help, answered by the server')
  const help = await mcp.callTool('deck', { op: 'help', about: 'move' })
  ok(help.text.startsWith('deck op "move"') && help.text.includes('before?'), 'help is answered by the server itself')
  const added = await mcp.callTool('deck', { op: 'add', after: 'a', count: 2 })
  ok(!added.isError && added.text.startsWith('Added 2 slides') && store.doc.slides.length === 6, `an op round-trips to the app and runs (${added.text})`)
  const refused = await mcp.callTool('deck', { op: 'delete', slideIds: ['a'] })
  ok(refused.isError && refused.text.includes('userAsked'), 'a refusal comes back as a tool error the model can read')
  const typo = await mcp.callTool('deck', { op: 'add', cuont: 2 })
  ok(typo.isError && typo.text.includes('"cuont" is not a parameter'), 'bad arguments come back as a tool error')
  mcp.dispose()
  watcher.close()
}

console.log(failures === 0 ? `\nall ${checks} checks passed` : `\n${failures} of ${checks} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
