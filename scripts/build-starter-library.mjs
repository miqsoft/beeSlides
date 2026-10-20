#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The starter ELEMENT LIBRARY — a small showcase for "Insert from library…"
// (slides/src/editor/library.ts). Per the format decision (docs/DECISIONS.md):
// a library file is an ORDINARY beeslides/slides document, no new format — each
// item here is just one Slide in doc.slides, `slide.name` is the item's
// display name, one element for a single-item share (the five code snippets),
// several for a group (the two shape/icon groups). Nothing here is a new
// element type: `code` (kernel/src/tokenize.ts's LANGS table already
// highlights js/py/rust/sql/sh) and `svg`/`shape` already exist — this file
// is pure CONTENT authoring, same technique as build-example-decks.mjs.
//
//   node scripts/build-starter-library.mjs [outDir]   (default: scripts/starter-library/)
//
// Requires slides/dist-single/BeeSlides.beeslides.html to exist (npm run
// build:single in slides/ first) — that shell is spliced with this doc, same
// splice/gate as every other generated deck.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shellPath = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
let shell
try {
  shell = readFileSync(shellPath, 'utf8')
} catch {
  console.error(`Missing ${shellPath} — run "npm run build:single" in slides/ first.`)
  process.exit(1)
}

const INK = '#1D1119'    // = the new-deck defaults in slides/src/model.ts
const PAPER = '#FFFFFF'
const ACCENT = '#9A5F00'  // = BRAND.honeyOnLight, the new-deck default accent
const SANS = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace"

// ——— tiny builders — mirror build-example-decks.mjs's shape (plain JSON
// matching src/model.ts; this script doesn't import the TS model so it can
// run under plain node) ————————————————————————————————————————————
let uidn = 0
const id = (p) => `${p}-${(++uidn).toString(36)}`

const codeEl = (o) => ({
  id: o.id ?? id('code'), type: 'code', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: 0, opacity: 1,
  fontSize: o.fontSize ?? 26, fontFamily: MONO,
  align: 'left', valign: 'top', lineHeight: 1.42,
  color: o.color ?? INK,
  content: o.content,
  grammarName: o.grammarName,
})
const shapeEl = (kind, o) => ({
  id: o.id ?? id('s'), type: 'shape', shape: kind, x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1,
  fill: o.fill ?? '#000', stroke: o.stroke ?? 'none', strokeWidth: o.strokeWidth ?? 0,
  radius: o.radius ?? 0,
  ...(o.groupId ? { groupId: o.groupId } : {}),
})
const textEl = (o) => ({
  id: o.id ?? id('t'), type: 'text', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1,
  html: o.html, fontSize: o.fontSize ?? 20, fontFamily: o.fontFamily ?? SANS,
  fontWeight: o.fontWeight ?? 600, color: o.color ?? INK,
  align: o.align ?? 'left', valign: o.valign ?? 'middle',
  lineHeight: o.lineHeight ?? 1.3,
  ...(o.groupId ? { groupId: o.groupId } : {}),
})
const svgEl = (o) => ({
  id: o.id ?? id('svg'), type: 'svg', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1, asset: o.asset,
  ...(o.groupId ? { groupId: o.groupId } : {}),
})
const slide = (o) => ({
  id: o.id ?? id('sl'), background: o.background ?? PAPER, transition: 'none',
  notes: o.notes ?? '', elements: o.elements, name: o.name,
})
const doc = (o) => ({
  format: 'beeslides/slides', version: 1, title: o.title,
  size: { width: 1280, height: 720 },
  theme: { background: PAPER, color: INK, accent: ACCENT, fontFamily: SANS },
  // Every open of this sample mints its own docId/no collab — it is source
  // material to browse from "Insert from library…", never a deck of its own.
  template: true,
  assets: o.assets,
  slides: o.slides,
  modified: new Date().toISOString(),
})

// ——— five code-listing items, one CodeElement each (the "single-item
// share" case) — languages picked from kernel/src/tokenize.ts's LANGS table
const CODE_BOX = { x: 120, y: 130, w: 1040, h: 480 }

const jsSnippet = `// Debounce: coalesce rapid calls into one
function debounce(fn, wait = 250) {
  let timer = null
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
}

const onResize = debounce(() => {
  console.log('resized:', window.innerWidth)
})
window.addEventListener('resize', onResize)`

const pySnippet = `# Quicksort — divide, conquer, concatenate
def quicksort(items):
    if len(items) <= 1:
        return items
    pivot = items[len(items) // 2]
    left = [x for x in items if x < pivot]
    mid = [x for x in items if x == pivot]
    right = [x for x in items if x > pivot]
    return quicksort(left) + mid + quicksort(right)

print(quicksort([5, 2, 9, 1, 5, 6]))`

const rustSnippet = `// A tiny generic stack
struct Stack<T> { items: Vec<T> }

impl<T> Stack<T> {
    fn new() -> Self { Stack { items: Vec::new() } }
    fn push(&mut self, item: T) { self.items.push(item) }
    fn pop(&mut self) -> Option<T> { self.items.pop() }
}

fn main() {
    let mut s: Stack<i32> = Stack::new();
    s.push(42);
    println!("{:?}", s.pop());
}`

const sqlSnippet = `-- Top customers by total spend this quarter
select c.name, sum(o.amount) as total
from customers c
join orders o on o.customer_id = c.id
where o.placed_at >= '2026-07-01'
group by c.name
order by total desc
limit 10;`

const shSnippet = `#!/usr/bin/env bash
# Build, tag and push a release image
set -euo pipefail

VERSION=$(git describe --tags --abbrev=0)
docker build -t app:"$VERSION" .
docker tag app:"$VERSION" "registry.example.com/app:$VERSION"
docker push "registry.example.com/app:$VERSION"
echo "deployed $VERSION"`

const codeSlides = [
  ['JavaScript — debounce', 'js', jsSnippet],
  ['Python — quicksort', 'py', pySnippet],
  ['Rust — generic stack', 'rust', rustSnippet],
  ['SQL — top customers', 'sql', sqlSnippet],
  ['Shell — release script', 'sh', shSnippet],
].map(([name, lang, content]) => slide({
  name,
  notes: `Library item — a single ${lang} code listing (one CodeElement). Drop it onto any slide, or onto a Slide Master layout so every slide built from it carries it.`,
  elements: [codeEl({ ...CODE_BOX, grammarName: lang, content })],
}))

// ——— two shape/icon GROUPS (the "several elements = one group" case) ———

// simple stroke-style icons, same idiom as slides/src/icons.ts (viewBox 0 0
// 24 24, round joins) — safe, self-contained markup with no <script>/on*.
const ICON_CHECK =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#2E9E5B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>`
const ICON_STAR =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#F2A93B" stroke="#B9791C" stroke-width="1" stroke-linejoin="round"><path d="M12 2.5l2.9 6.2 6.6.7-5 4.6 1.4 6.6L12 17.6l-5.9 3 1.4-6.6-5-4.6 6.6-.7z"/></svg>`
const ICON_ARROW =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#3B7DD8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 8l4 4-4 4"/></svg>`

const iconRowGroup = 'grp-icon-row'
const iconRowSlide = slide({
  name: 'Icon row (group)',
  notes: 'Library item — a GROUP of three svg elements sharing one groupId. Inserting this item drops all three together.',
  elements: [
    svgEl({ groupId: iconRowGroup, x: 460, y: 280, w: 96, h: 96, asset: 'lib-icon-check' }),
    svgEl({ groupId: iconRowGroup, x: 592, y: 280, w: 96, h: 96, asset: 'lib-icon-star' }),
    svgEl({ groupId: iconRowGroup, x: 724, y: 280, w: 96, h: 96, asset: 'lib-icon-arrow' }),
  ],
})

const badgeGroup = 'grp-status-badge'
const statusBadgeSlide = slide({
  name: 'Status badge (group)',
  notes: 'Library item — a GROUP of three elements (pill, dot, label) sharing one groupId — a small reusable "Live" badge.',
  elements: [
    shapeEl('rect', { groupId: badgeGroup, x: 480, y: 300, w: 320, h: 96, radius: 48, fill: '#EAF6EE' }),
    shapeEl('ellipse', { groupId: badgeGroup, x: 512, y: 332, w: 32, h: 32, fill: '#2E9E5B' }),
    textEl({ groupId: badgeGroup, x: 568, y: 300, w: 200, h: 96, html: 'Live', fontSize: 30, fontWeight: 700, color: '#1F6B3E', align: 'left', valign: 'middle' }),
  ],
})

const library = doc({
  title: 'BeeSlides Starter Library',
  assets: {
    'lib-icon-check': ICON_CHECK,
    'lib-icon-star': ICON_STAR,
    'lib-icon-arrow': ICON_ARROW,
  },
  slides: [...codeSlides, iconRowSlide, statusBadgeSlide],
})

// ——— splice + write — same technique + gate as build-example-decks.mjs ———
const outDir = process.argv[2] ?? join(root, 'scripts', 'starter-library')
mkdirSync(outDir, { recursive: true })
const blockRe = /<script type="application\/beeslides\+json" id="beeslides-doc">[\s\S]*?<\/script>/
const json = JSON.stringify(library).replace(/</g, '\\u003c')
const out = shell.replace(blockRe, `<script type="application/beeslides+json" id="beeslides-doc">\n${json}\n</scr` + 'ipt>')
if (!out.includes(json)) throw new Error('splice failed for starter library')
const outFile = join(outDir, 'BeeSlides-Starter-Library.beeslides.html')
writeFileSync(outFile, out)
console.log(`${outFile} — ${library.slides.length} items, ${Math.round(out.length / 1024)} KB`)
