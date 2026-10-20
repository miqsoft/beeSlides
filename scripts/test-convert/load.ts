#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert loadability gate — the most important check in the suite.
//
//   node scripts/test-convert/load.ts
//
// Every fixture package is converted and the emitted JSON is pushed through
// the REAL slides loader: parseDoc must return a document and validateDoc
// (measure:false) must report ZERO errors. The convert engine's own rigs
// prove the engine agrees with itself; only this gate proves the output loads
// in the actual app — and if it does not, nothing else matters.
//
// Mechanics: slides' validate.ts pulls render.ts, whose imports are
// extensionless and include the temml package, so plain node type-stripping
// cannot run it. Same answer as scripts/test-validate.ts: bundle with esbuild
// first. This rig does that itself — when run directly it bundles ITSELF and
// re-executes the bundle, so the runner (and a bare `node`) need no wrapper.

import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.env.SLIDOMINGO_CONVERT_LOAD_BUNDLED) {
  const self = fileURLToPath(import.meta.url)
  const root = join(dirname(self), '..', '..')
  const esbuild = join(root, 'slides', 'node_modules', '.bin', 'esbuild')
  const out = join(mkdtempSync(join(tmpdir(), 'convert-load-')), 'load.mjs')
  const b = spawnSync(esbuild, [self, '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`],
    { stdio: 'inherit' })
  if (b.status !== 0) {
    console.log('  FAIL  esbuild bundle step failed')
    process.exit(1)
  }
  const r = spawnSync(process.execPath, [out], {
    stdio: 'inherit',
    env: { ...process.env, SLIDOMINGO_CONVERT_LOAD_BUNDLED: '1' },
  })
  process.exit(r.status ?? 1)
}

const { convertPptx } = await import('../../kernel/src/convert/pptx.ts')
const { convertMarkdown } = await import('../../kernel/src/convert/qmd.ts')
const { allFixtures, fxBuilds, fxImportFollowups } = await import('./_fixtures.ts')
const { allMarkdownFixtures } = await import('./_mdfixtures.ts')
const { parseDoc } = await import('../../slides/src/model.ts')
const { validateDoc } = await import('../../slides/src/validate.ts')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** The gate itself: emitted document → text → the REAL loader. */
function gate(name: string, doc: unknown) {
  // through JSON — the emitted document must survive as TEXT, the way it
  // actually travels (Replace from JSON…, window.beeslides.loadDoc)
  const parsed = parseDoc(JSON.stringify(doc))
  ok(parsed !== null, `${name}: parseDoc accepts the emitted document`)
  if (!parsed) return
  const v = validateDoc(parsed, { measure: false })
  const errors = v.findings.filter((f) => f.severity === 'error')
  ok(errors.length === 0,
    `${name}: validateDoc reports zero errors (got ${errors.length}${errors.length ? `: ${errors.map((f) => f.code).join(', ')}` : ''})`)
  // Unknown keys are only WARNINGS, but for a converter they are never
  // legitimate: every one is a property this engine emitted that the format
  // does not define, so it is ignored at render time and whatever it was
  // meant to do silently does not happen.
  const unknown = v.findings.filter((f) => f.code === 'unknown-key')
  ok(unknown.length === 0,
    `${name}: emits no keys outside the format (got ${unknown.length}${unknown.length ? `: ${unknown.map((f) => f.path).join(', ')}` : ''})`)
}

/** Every slide-type reference the tree and the links introduce must resolve —
 *  a dangling layoutId/parentId loads fine and then silently does nothing. */
function refsResolve(name: string, doc: { slides: Array<{ layoutId?: string }>; layouts?: Array<{ id: string; parentId?: string }>; defaultLayoutId?: string }) {
  const ids = new Set((doc.layouts ?? []).map((l) => l.id))
  const bad = [
    ...doc.slides.filter((s) => s.layoutId !== undefined && !ids.has(s.layoutId)).map((s) => `layoutId ${s.layoutId}`),
    ...(doc.layouts ?? []).filter((l) => l.parentId !== undefined && !ids.has(l.parentId)).map((l) => `parentId ${l.parentId}`),
    ...(doc.defaultLayoutId !== undefined && !ids.has(doc.defaultLayoutId) ? [`defaultLayoutId ${doc.defaultLayoutId}`] : []),
    ...(ids.size !== (doc.layouts ?? []).length ? ['duplicate layout id'] : []),
  ]
  ok(bad.length === 0, `${name}: every layoutId / parentId / defaultLayoutId resolves (${bad.length ? bad.join(', ') : 'all'})`)
}

// deck mode (the default) and template mode — the latter keeps every layout
// and invents a starter slide, so it has its own ways to emit a bad document
for (const { name, build } of allFixtures()) {
  for (const mode of ['deck', 'template'] as const) {
    const doc = (await convertPptx(await build(), { mode })).doc
    gate(`${name} (${mode})`, doc)
    refsResolve(`${name} (${mode})`, doc)
  }
  // flattened: every slide's baked chrome carries a morphId (its linked
  // twin's id), which the format must accept as its own key
  const flat = (await convertPptx(await build(), { link: false })).doc
  gate(`${name} (flattened)`, flat)
}

// Click builds: the importer's fx must SURVIVE the loader's untrusted-input
// filter and mean what it says to slides' own builds.ts (the single source of
// truth for what is on screen after click N) — 7 clicks, with the by-paragraph
// text splitting into its three <br>-joined paragraphs.
{
  const { buildPlan } = await import('../../slides/src/builds.ts')
  const doc = (await convertPptx(await fxBuilds(), { link: false })).doc
  const parsed = parseDoc(JSON.stringify(doc))
  const slide = parsed?.slides[0]
  const fly = slide?.elements.find((e) => e.id === 's1-2')
  ok(fly?.fx?.step === 1 && fly.fx.enter === 'slide-right', 'builds: fx.step / enter survive the loader')
  const plan = slide ? buildPlan(slide) : undefined
  ok(plan?.steps.length === 7, `builds: slidomingo reads 7 clicks from the imported slide (got ${plan?.steps.length})`)
  ok(plan?.paragraphs.get('s1-5-t') === 3, 'builds: the by-paragraph text splits into its 3 paragraphs')
  const paraAt = (i: number) => plan?.steps[i].enter.find((t) => t.para !== undefined)?.para
  ok(paraAt(1) === 0 && paraAt(2) === 1 && paraAt(3) === 2, 'builds: paragraphs arrive on clicks 2, 3 and 4 (the attached box with the first)')
  ok(plan?.steps[4].exit[0]?.elId === 's1-6' && plan?.steps[6].exit.length === 2, 'builds: the exits land on clicks 5 and 7 (the group takes both leaves)')
}

// The markdown path emits two element types the .pptx path never does (`code`,
// `table`) and — unlike it — LINKS every slide to a layout, so it has its own
// ways to produce a document the app rejects. Same gate, same fixtures the
// markdown rig asserts content against.
for (const { name, source, assets } of allMarkdownFixtures()) {
  gate(name, convertMarkdown(source, { assets, name }).doc)
}

// Importer follow-ups: alt, crop, transitionDir and requires must SURVIVE
// the loader's untrusted-input filter — a key it strips loads "fine" and the
// mapping silently did nothing.
{
  const doc = (await convertPptx(await fxImportFollowups(), { link: false })).doc
  const parsed = parseDoc(JSON.stringify(doc))
  const s1 = parsed?.slides[0]
  const img = s1?.elements.find((e) => e.id === 's1-2') as { alt?: string; crop?: unknown } | undefined
  ok(img?.alt === 'A red bicycle' && JSON.stringify(img?.crop) === '{"x":0.1,"y":0.2,"w":0.6,"h":0.8}',
    'follow-ups: image alt + crop survive the loader')
  const deco = s1?.elements.find((e) => e.id === 's1-3') as { alt?: string } | undefined
  ok(deco?.alt === '', 'follow-ups: a decorative alt "" survives (not dropped as empty)')
  const chart = s1?.elements.find((e) => e.id === 's1-7') as { alt?: string } | undefined
  ok(chart?.alt === 'Sales by region', 'follow-ups: chart alt survives')
  ok(parsed?.slides[1].transition === 'push' && parsed?.slides[1].transitionDir === 'bottom',
    'follow-ups: transition + transitionDir survive')
  ok(JSON.stringify((parsed as { requires?: unknown } | null)?.requires) === '["rich-text"]',
    'follow-ups: requires ["rich-text"] survives and the build reads it (not refused)')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
