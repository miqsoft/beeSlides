// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The .qmd / .md orchestrator — markdown in, ONE slidomingo/slides document +
// fidelity report out. Same contract as pptx.ts: pure `source → { doc, report }`,
// no DOM, no app imports, zero dependencies.
//
// WHY AN IMPORTER AND NOT AN INTEGRATION. slides already ships the things
// scientific authors reach for Quarto to get: `$…$`/`$$…$$` renders to MathML
// at render time (render.ts, WITH symbol-level morphing reveal.js cannot do),
// code is a first-class element with 75-language tokenizing and line-level
// Heckel-diff morphing (code.ts + kernel/tokenize.ts), and tables, notes and
// layouts/masters all exist. The gap was never features or an engine — it was
// a one-way door IN, producing an ordinary, fully editable deck. Anything
// opaque (an iframe `embed`, a re-hosted reveal.js) fails the actual
// requirement, which is that the result stays hand- and agent-editable.
//
// EXECUTABLE CELLS ARE NEVER RUN HERE, and that is not a limitation.
// Quarto's engine (knitr/Jupyter) runs BEFORE Pandoc for every output format,
// so `quarto render --to markdown` yields executed markdown with figures
// written to a sibling `_files/` folder. This importer consumes THAT: pass the
// figures in `opts.assets` and computation arrives for free, with no toolchain
// and no backend inside the document. A `.qmd` handed over un-rendered still
// imports — the cells come in as highlighted source and the report says, once,
// what to run.
//
// Every judgement call is a FidelityReport line. That is the engine-wide rule
// (see report.ts) and it matters more here than in the .pptx path, because a
// `.qmd` carries no coordinates at all: EVERY frame on the emitted slide was
// invented by convert/mdlayout.ts, and the reader is owed that fact.

import { Report } from './report.ts'
import { LANGS } from '../tokenize.ts'
import { mimeFor, toBase64, imageSize } from './media.ts'
import {
  parseBlocks, inlineToHtml, inlineToText, blocksToText, newFinding,
  type MdBlock, type MdItem, type Attrs, type Align, type InlineFinding,
} from './md.ts'
import { paragraphsHtml, withListRequires } from './lists.ts'
import {
  DEFAULT_SIZE, LAYOUT_IDS, LIGHT, DARK, buildLayout, chooseLayout, slot, mediaSlot,
  place, columns, textHeight, fitFont, ADV_MONO, MONO_STACK,
  type Box, type Frame, type LayoutKind, type LayoutOut, type Palette,
} from './mdlayout.ts'
import type {
  ConvertResult, OutDoc, OutSlide, OutElement, OutText, OutShape, OutImage,
  OutTable, OutCode, OutTableCell,
} from './types.ts'

export interface ConvertMarkdownOpts {
  /**
   * Files that travelled with the deck — a `quarto render` `_files/` folder,
   * or whatever the user multi-selected. Keys are paths; a figure reference
   * resolves against them exactly, then by normalized path, then by basename,
   * so `![](deck_files/figure-markdown/plot-1.png)` finds the file whether the
   * pick preserved the folder or flattened it.
   */
  assets?: Record<string, Uint8Array>
  size?: { width: number; height: number }
  /** Force a palette; otherwise the front matter's reveal theme name decides. */
  theme?: 'light' | 'dark'
  /** The source file's name — the report's fallback `where` and deck title. */
  name?: string
}

/** Reveal themes that are dark grounds. Anything else reads as light. */
const DARK_THEMES = new Set([
  'dark', 'black', 'blood', 'moon', 'night', 'league', 'dracula',
  'solarized-dark', 'slate', 'superhero', 'cyborg', 'darkly', 'vapor',
])

/** Callout tones Quarto defines, and the accent each one earns. */
const CALLOUT_TONES: Record<string, { color: string; label: string }> = {
  'callout-note': { color: '#4C8DF6', label: 'Note' },
  'callout-tip': { color: '#3FA95F', label: 'Tip' },
  'callout-important': { color: '#D9534F', label: 'Important' },
  'callout-warning': { color: '#E8A33D', label: 'Warning' },
  'callout-caution': { color: '#E8743D', label: 'Caution' },
}

/** Fenced-div classes this importer understands. Anything else is reported
 *  once as unknown rather than silently flattened. */
const KNOWN_DIVS = new Set([
  'notes', 'columns', 'column', 'incremental', 'nonincremental', 'fragment',
  'center', 'smaller', 'r-fit-text', 'r-stretch', 'aside', 'footer', 'cell',
  'cell-output', 'cell-output-display', 'cell-output-stdout', 'cell-code',
  ...Object.keys(CALLOUT_TONES),
])

/** reveal-only slide attributes with no model equivalent. */
const REVEAL_ONLY = new Set([
  'background-video', 'background-iframe', 'background-interactive',
  'auto-animate', 'data-auto-animate', 'transition', 'transition-speed',
  'background-size', 'background-position', 'background-repeat', 'background-opacity',
])

const r2 = (v: number): number => Math.round(v * 100) / 100

/**
 * Id prefix per design — the built-ins' own placeholder prefixes, so an
 * element this importer minted reads as belonging to the same slot family as
 * the placeholders beside it (`ltc-title`, `ltc-body`, then `ltc-e1`…).
 * `blank` gets `qmd` because it has no placeholders to borrow a prefix from.
 */
const PREFIX: Record<LayoutKind, string> = {
  title: 'lt',
  'title-content': 'ltc',
  'two-col': 'l2c',
  'picture-caption': 'lpc',
  section: 'lsec',
  blank: 'qmd',
}

// --- YAML front matter -------------------------------------------------------

type Yaml = string | Yaml[] | { [k: string]: Yaml }

/** Split `---` … `---` front matter off the top of the source. */
export function splitFrontMatter(src: string): { yaml: string; body: string } {
  const s = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(s)
  if (!m) return { yaml: '', body: s }
  return { yaml: m[1], body: s.slice(m[0].length) }
}

/**
 * Enough YAML for Quarto front matter: scalars, `- ` sequences, nested
 * mappings, and inline `[a, b]` flow sequences.
 *
 * NOT a YAML implementation, and deliberately not: front matter is read for a
 * title, a byline and a theme name, and the alternative is a dependency in a
 * zero-dependency engine. Anything it cannot represent (anchors, multi-line
 * block scalars, nested flow mappings) collapses to its raw text, which is
 * still a usable string for every key this importer reads.
 */
export function parseYaml(src: string): Record<string, Yaml> {
  const lines = src.split('\n')
    .filter((l) => l.trim() && !/^[ \t]*#/.test(l))
    .map((l) => l.replace(/\t/g, '  '))
  const node = block(lines, 0, indentOf(lines[0] ?? ''))
  return typeof node === 'object' && !Array.isArray(node) ? node : {}
}

const indentOf = (l: string) => /^ */.exec(l)![0].length

function scalar(raw: string): Yaml {
  const v = raw.trim()
  if (/^\[.*\]$/.test(v)) {
    return v.slice(1, -1).split(',').map((s) => String(scalar(s))).filter((s) => s !== '')
  }
  return v.replace(/^["']|["']$/g, '')
}

/** One indentation level, from `start`. Returns the node and where it ended. */
function block(lines: string[], start: number, indent: number): Yaml {
  // a sequence
  if (lines[start] !== undefined && /^ *- /.test(lines[start]) && indentOf(lines[start]) === indent) {
    const out: Yaml[] = []
    let i = start
    while (i < lines.length && indentOf(lines[i]) === indent && /^ *- /.test(lines[i])) {
      const rest = lines[i].slice(indent + 2)
      // `- name: X` starts an inline mapping that continues on deeper lines
      if (/^[\w.-]+:/.test(rest)) {
        const sub = [' '.repeat(indent + 2) + rest]
        let j = i + 1
        while (j < lines.length && indentOf(lines[j]) > indent + 1 && !/^ *- /.test(lines[j])) { sub.push(lines[j]); j++ }
        out.push(block(sub, 0, indent + 2))
        i = j
        continue
      }
      out.push(scalar(rest))
      i++
    }
    return out
  }
  // a mapping
  const map: Record<string, Yaml> = {}
  let i = start
  while (i < lines.length) {
    const ind = indentOf(lines[i])
    if (ind < indent) break
    if (ind > indent) { i++; continue } // stray deeper line with no key above
    const m = /^ *([^:#]+?)[ \t]*:[ \t]*(.*)$/.exec(lines[i])
    if (!m) { i++; continue }
    const key = m[1].trim().replace(/^["']|["']$/g, '')
    if (m[2].trim()) { map[key] = scalar(m[2]); i++; continue }
    // value lives on the following, deeper lines
    const kids: string[] = []
    let j = i + 1
    const childIndent = j < lines.length ? indentOf(lines[j]) : indent
    while (j < lines.length && indentOf(lines[j]) >= childIndent && indentOf(lines[j]) > indent) { kids.push(lines[j]); j++ }
    map[key] = kids.length ? block(kids, 0, childIndent) : ''
    i = j
  }
  return map
}

/** A dotted lookup that tolerates missing levels: `at(meta, 'format.revealjs.theme')`. */
function at(meta: Yaml | undefined, path: string): Yaml | undefined {
  let cur: Yaml | undefined = meta
  for (const k of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

/** A YAML node as one line of text: a scalar, a list joined, a mapping's
 *  `name`. Quarto authors write `author:` all three ways. */
function asText(node: Yaml | undefined): string {
  if (node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(asText).filter(Boolean).join(', ')
  return asText(node.name ?? node.value ?? '')
}

// --- figures ------------------------------------------------------------------

/**
 * Resolves a markdown figure path against the files that came with the deck
 * and registers what it finds as a `doc.assets` data URI.
 *
 * Keys are `md<n>` in RESOLUTION order, deduped by resolved path — the same
 * figure referenced twice is one asset, and the ids stay deterministic so a
 * re-import of the same source produces the same document.
 */
class FigureStore {
  private uris: Record<string, string> = {}
  private byPath = new Map<string, { key?: string; box?: { w: number; h: number }; notImage?: string }>()
  /** every provided path, indexed by the ways a source might name it */
  private index = new Map<string, string>()
  private files: Record<string, Uint8Array>

  constructor(files: Record<string, Uint8Array>) {
    this.files = files
    for (const p of Object.keys(files)) {
      const norm = p.replace(/\\/g, '/').replace(/^\.?\//, '')
      for (const k of [p, norm, norm.toLowerCase(), base(norm), base(norm).toLowerCase()]) {
        if (!this.index.has(k)) this.index.set(k, p)
      }
    }
  }

  /**
   * The registered asset key for `src`, plus its intrinsic size if readable.
   *
   * `notImage` distinguishes "no such file" from "that file is not a picture",
   * which are different things to tell the reader: a `quarto render --to pdf`
   * run writes PDF figures, and embedding one as an `image` src would produce
   * an element that renders as nothing at all.
   */
  resolve(src: string): { key?: string; box?: { w: number; h: number }; notImage?: string } | undefined {
    const norm = src.replace(/\\/g, '/').replace(/^\.?\//, '')
    const path = this.index.get(src) ?? this.index.get(norm)
      ?? this.index.get(norm.toLowerCase()) ?? this.index.get(base(norm))
      ?? this.index.get(base(norm).toLowerCase())
    if (path === undefined) return undefined
    // Cached by the RESOLVED path, not by how the source spelled it: two
    // references that reach the same file (`a.png` and `figs/a.png`, both
    // matching one picked file by basename) must be ONE asset, or the deck
    // carries the same bytes twice.
    const hit = this.byPath.get(path)
    if (hit) return hit
    const bytes = this.files[path]
    const mime = mimeFor(path)
    if (!mime.startsWith('image/')) {
      const out = { notImage: mime }
      this.byPath.set(path, out)
      return out
    }
    const key = `md${this.byPath.size + 1}`
    this.uris[key] = `data:${mime};base64,${toBase64(bytes)}`
    const out = { key, box: imageSize(bytes, mime) }
    this.byPath.set(path, out)
    return out
  }

  assets(): Record<string, string> { return this.uris }
}

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)

// --- slide chunking -----------------------------------------------------------

interface Chunk {
  heading?: { level: number; text: string; at: Attrs }
  blocks: MdBlock[]
  /** the front-matter slide, which has no heading of its own */
  titleSlide?: boolean
}

/**
 * Split a block stream into slides.
 *
 * Two boundaries, both Pandoc's/Quarto's own: a heading at or above
 * `slide-level` (default 2, and honoured from the front matter), and a
 * thematic break. A heading STRICTLY above slide-level is a section divider —
 * that is what makes `#` a part title and `##` a content slide in every
 * Quarto reveal deck.
 */
function chunk(blocks: MdBlock[], slideLevel: number): Chunk[] {
  const out: Chunk[] = []
  let cur: Chunk | undefined
  for (const b of blocks) {
    if (b.kind === 'heading' && b.level <= slideLevel) {
      cur = { heading: { level: b.level, text: b.text, at: b.at }, blocks: [] }
      out.push(cur)
      continue
    }
    if (b.kind === 'rule') { cur = { blocks: [] }; out.push(cur); continue }
    if (!cur) { cur = { blocks: [] }; out.push(cur) }
    cur.blocks.push(b)
  }
  return out.filter((c) => c.heading || c.blocks.length)
}

/** Pull every `::: {.notes}` (at any depth) out of a block list. */
function takeNotes(blocks: MdBlock[], into: string[]): MdBlock[] {
  const out: MdBlock[] = []
  for (const b of blocks) {
    if (b.kind === 'div' && b.at.classes.includes('notes')) {
      into.push(blocksToText(b.blocks))
      continue
    }
    if (b.kind === 'div') { out.push({ ...b, blocks: takeNotes(b.blocks, into) }); continue }
    out.push(b)
  }
  return out
}

// --- conversion ----------------------------------------------------------------

/**
 * Convert one markdown / Quarto source to a slidomingo/slides document.
 *
 * Never throws for content reasons: an empty source still yields a loadable
 * one-slide document, and everything questionable lands in the report.
 */
export function convertMarkdown(source: string, opts: ConvertMarkdownOpts = {}): ConvertResult {
  const report = new Report()
  const { yaml, body } = splitFrontMatter(source)
  const meta = yaml ? parseYaml(yaml) : {}
  const size = opts.size ?? DEFAULT_SIZE
  const figures = new FigureStore(opts.assets ?? {})

  // ---- theme
  const themeName = String(asText(at(meta, 'theme'))
    || asText(at(meta, 'format.revealjs.theme'))
    || asText(at(meta, 'format.beamer.theme'))).toLowerCase()
  const dark = opts.theme ? opts.theme === 'dark' : DARK_THEMES.has(themeName)
  const pal: Palette = dark ? DARK : LIGHT
  if (themeName) {
    report.add('approximated', 'theme-approximated', 'front matter',
      `reveal theme "${themeName}" has no port — the deck uses BeeSlides's own ${dark ? 'dark' : 'light'} palette, editable in the Layout Manager`)
  }

  // ---- slide splitting
  const slideLevel = Math.max(1, Math.min(6,
    parseInt(String(asText(at(meta, 'slide-level')) || asText(at(meta, 'format.revealjs.slide-level')) || '2'), 10) || 2))
  const blocks = parseBlocks(body)
  const chunks = chunk(blocks, slideLevel)

  // A front-matter title earns its own slide, exactly as every Quarto format
  // renders one. Without a title the source's first chunk stands on its own.
  const title = asText(at(meta, 'title')).trim()
  if (title) chunks.unshift({ titleSlide: true, blocks: [] })

  // ---- emit
  const usedLayouts = new Map<LayoutKind, LayoutOut>()
  const layoutFor = (kind: LayoutKind): LayoutOut => {
    let ly = usedLayouts.get(kind)
    if (!ly) { ly = buildLayout(kind, size, pal); usedLayouts.set(kind, ly) }
    return ly
  }

  const ctx: Ctx = { report, pal, size, figures, meta, slideLevel, cells: 0, dense: 0 }
  const slides: OutSlide[] = []
  let sectionNo = 0
  chunks.forEach((c, idx) => {
    if (c.heading && c.heading.level < slideLevel) sectionNo++
    slides.push(emitSlide(c, idx + 1, sectionNo, ctx, layoutFor))
  })

  if (ctx.cells) {
    report.add('dropped', 'qmd-cells-not-run', 'deck',
      `${ctx.cells} executable cell(s) came in as source, not results — run \`quarto render --to markdown\` first and import that (its engine writes figures to a sibling _files/ folder; pick them alongside the .md)`)
  }
  if (ctx.dense) {
    report.add('approximated', 'content-dense', 'deck',
      `${ctx.dense} slide(s) hold more than their frame fits — type was reduced to a floor rather than shrunk indefinitely, so some content may overflow; split those slides or trim them`)
  }

  // parseDoc refuses a slideless document; a blank page is the honest minimum.
  if (!slides.length) {
    report.add('dropped', 'deck-empty', 'deck',
      'the source has no headings and no content — one blank slide emitted so the document loads')
    slides.push({
      id: 'q1', name: 'Slide 1', background: pal.bg, transition: 'none', notes: '', elements: [],
      layoutId: layoutFor('blank').id,
    })
  }

  const author = asText(at(meta, 'author'))
  const layouts = [...usedLayouts.values()]
  const doc: OutDoc = {
    format: 'slidomingo/slides',
    version: '1.0.0',
    title: title || firstHeading(chunks) || opts.name?.replace(/\.[^.]+$/, '') || 'Imported deck',
    size,
    theme: {
      background: pal.bg,
      color: pal.ink,
      accent: pal.accent,
      fontFamily: pal.font,
      headingFamily: pal.font,
      palette: { bg2: pal.slotFill, tx2: pal.muted },
    },
    assets: figures.assets(),
    fonts: null,
    slides,
    ...(layouts.length
      ? {
          layouts: layouts.map((l) => ({
            id: l.id, name: l.name, background: l.background,
            transition: 'fade' as const, notes: '', elements: l.elements,
          })),
          defaultLayoutId: LAYOUT_IDS['title-content'],
        }
      : {}),
  }
  const props: NonNullable<OutDoc['meta']> = {}
  if (author) props.author = author
  const subject = asText(at(meta, 'subtitle')) || asText(at(meta, 'description'))
  if (subject) props.subject = subject
  const keywords = asText(at(meta, 'keywords'))
  if (keywords) props.keywords = keywords
  const institute = asText(at(meta, 'institute'))
  if (institute) props.company = institute
  if (Object.keys(props).length) doc.meta = props

  // A default-layout marker only means something if that layout is present.
  if (doc.defaultLayoutId && !layouts.some((l) => l.id === doc.defaultLayoutId)) {
    doc.defaultLayoutId = layouts[0]?.id
  }
  if (!doc.defaultLayoutId) delete doc.defaultLayoutId

  reportFrontMatter(meta, report)
  // real lists are rich text: an older reader must open read-only
  withListRequires(doc)
  return { doc, report: report.build() }
}

const firstHeading = (chunks: Chunk[]): string =>
  chunks.find((c) => c.heading?.text)?.heading?.text ?? ''

/** Front-matter keys that promise machinery this importer has none of. */
function reportFrontMatter(meta: Record<string, Yaml>, report: Report) {
  if (meta.bibliography) {
    report.add('dropped', 'bibliography-dropped', 'front matter',
      `"${asText(meta.bibliography)}" is not read — citations stay as their literal [@key] text, since resolving them needs a bibliography processor`)
  }
  for (const k of ['include-in-header', 'include-before-body', 'include-after-body', 'css', 'filters', 'lua-filter']) {
    if (meta[k]) {
      report.add('dropped', 'front-matter-dropped', 'front matter',
        `"${k}" is a Pandoc/reveal pipeline hook with no BeeSlides equivalent — it is ignored`)
    }
  }
}

// --- one slide ------------------------------------------------------------------

interface Ctx {
  report: Report
  pal: Palette
  size: { width: number; height: number }
  figures: FigureStore
  meta: Record<string, Yaml>
  slideLevel: number
  /** running total of un-executed cells, reported once for the deck */
  cells: number
  /** running total of over-full slides, reported once for the deck */
  dense: number
}

function emitSlide(
  c: Chunk,
  n: number,
  sectionNo: number,
  ctx: Ctx,
  layoutFor: (k: LayoutKind) => LayoutOut,
): OutSlide {
  const where = `slide ${n}`
  const { pal } = ctx
  // ELEMENT IDS ARE SLOT-SHAPED, NOT SLIDE-SHAPED: `<design>-<kind><k>`, e.g.
  // `ltc-c1` for the first code element on a Title+content slide. Counted PER
  // KIND, so an id can only ever pair with an element of the same type.
  // Ids are unique per SLIDE (all validate.ts requires) and deliberately
  // REPEAT across slides built from the same design with the same block
  // sequence — which is the codebase's own morph idiom (`instantiateLayout`
  // keeps a layout's element ids for exactly this reason, and model.ts's
  // `morphKey` is `morphId ?? id`). The payoff is the one thing this importer
  // has that reveal.js cannot do: two consecutive slides showing an evolving
  // listing pair up, so switching them to a morph transition makes the code
  // travel line by line (code.ts's Heckel diff) instead of cross-fading. A
  // slide carrying a different number of that kind gets a different number
  // and simply does not pair, which is the right conservative default.
  // Assigned once `chooseLayout` has run, below; every id is minted after
  // that, so the prefix is always the slide's real design.
  let design: LayoutKind = 'blank'
  const seq: Record<string, number> = {}
  const nextId = (tag: string) => `${PREFIX[design]}-${tag}${seq[tag] = (seq[tag] ?? 0) + 1}`

  // ---- notes, first: they must not reach the layout as content
  const notes: string[] = []
  const blocks = takeNotes(c.blocks, notes)

  // ---- slide attributes off the heading
  const attrs = c.heading?.at ?? { classes: [], keys: {} }
  let background = pal.bg
  let bgImage: OutImage | undefined
  const bgColor = attrs.keys['background-color']
  if (bgColor) background = bgColor
  const bgSrc = attrs.keys['background-image']
  if (bgSrc) {
    const fig = ctx.figures.resolve(bgSrc)
    if (fig?.key) {
      bgImage = {
        id: `${PREFIX.blank}-bg`, type: 'image', x: 0, y: 0, w: ctx.size.width, h: ctx.size.height,
        rotation: 0, opacity: 1, src: `asset:${fig.key}`, fit: 'cover',
      }
      ctx.report.add('carried', 'background-image-imported', where,
        'a slide background image is imported as a full-bleed picture at the bottom of z-order')
    } else {
      ctx.report.add('dropped', 'image-unresolved', where,
        `background image "${bgSrc}" was not among the files provided — pick the figure folder alongside the source to embed it`)
    }
  }
  for (const k of Object.keys(attrs.keys)) {
    if (REVEAL_ONLY.has(k)) {
      ctx.report.add('dropped', 'reveal-attr-ignored', where,
        `"${k}" is a reveal.js-only slide attribute with no model equivalent — it is ignored`)
    }
  }
  const hidden = attrs.keys['visibility'] === 'hidden' || attrs.keys['visibility'] === 'uncounted'
  const smaller = attrs.classes.includes('smaller')
  const centred = attrs.classes.includes('center')

  // ---- the title slide is built from front matter, not from blocks
  const isTitleSlide = !!c.titleSlide
  const isSection = !!c.heading && c.heading.level < ctx.slideLevel

  // ---- columns
  //
  // A `.columns` div is only allowed to claim the DESIGN's own two body slots
  // when it is the slide's ONLY body content. When anything else shares the
  // slide, the div stays an ordinary block in the stack and splits whatever
  // frame it is given (see `columnsOf`/`boxFor`) — the alternative, filling
  // the two slots and ignoring the rest, silently dropped that content.
  const pieces = isTitleSlide ? [] : blocks
  const soloCols = pieces.length === 1 && columnsOf(pieces[0]) !== undefined
    ? columnsOf(pieces[0])
    : undefined
  const shape = {
    hasTitle: !!c.heading?.text || isTitleSlide,
    isSection,
    isTitleSlide,
    columns: soloCols?.length === 2 ? 2 : 0,
    soloFigure: isSoloFigure(pieces),
    hasBody: pieces.length > 0,
  }
  const kind = chooseLayout(shape)
  design = kind
  const ly = layoutFor(kind)
  const elements: OutElement[] = []
  if (bgImage) elements.push(bgImage)

  const fx = new Stagger()

  // ---- title / subtitle / kicker
  const titleSlot = slot(ly, 'title')
  if (titleSlot) {
    const words = isTitleSlide ? asText(at(ctx.meta, 'title')) : (c.heading?.text ?? '')
    if (words) {
      const found = newFinding()
      elements.push(fill(titleSlot, inlineToHtml(words, found), {
        fontSize: fitFont(inlineToText(words), titleSlot.w, titleSlot.h * 1.6, titleSlot.fontSize, 1.15),
      }))
      reportInline(found, where, ctx.report)
    }
  }
  if (isTitleSlide) {
    const subSlot = slot(ly, 'subtitle')
    const byline = [asText(at(ctx.meta, 'subtitle')), bylineOf(ctx.meta)].filter(Boolean)
    if (subSlot && byline.length) {
      elements.push(fill(subSlot, byline.map((s) => inlineToHtml(s)).join('<br>'), {
        h: Math.max(subSlot.h, Math.round(byline.length * subSlot.fontSize * 1.35)),
      }))
    }
    ctx.report.add('carried', 'title-slide-built', where,
      'the front matter (title, subtitle, author, date) becomes a title slide, as every Quarto format renders one')
  } else if (kind === 'section') {
    const kickerSlot = slot(ly, 'kicker')
    if (kickerSlot) elements.push(fill(kickerSlot, `PART ${sectionNo || 1}`))
  }

  // ---- the body region
  const bodySlots = [slot(ly, 'body', 0), slot(ly, 'body', 1)].filter(Boolean) as OutText[]
  const media = mediaSlot(ly)
  const boxCtx: BoxCtx = { ctx, where, nextId, fx, smaller, centred }

  if (kind === 'picture-caption' && media) {
    const fig = pieces.find((b): b is Extract<MdBlock, { kind: 'image' }> => b.kind === 'image')!
    const rest = pieces.filter((b) => b !== fig)
    const box = { x: media.x, y: media.y, w: media.w, h: media.h }
    const img = imageBox(fig, box, boxCtx)
    if (img) {
      // Only the picture: this design has its OWN caption slot below, so the
      // box's built-in caption line would print the words twice.
      const pic = img.emit(box).find((e): e is OutImage => e.type === 'image')
      if (pic) elements.push({ ...pic, id: media.id, role: 'media' })
    }
    const capSlot = bodySlots[0]
    const caption = fig.alt.trim() || (rest[0]?.kind === 'para' ? rest[0].text : '')
    if (capSlot && caption) {
      const found = newFinding()
      elements.push(fill(capSlot, inlineToHtml(caption, found)))
      reportInline(found, where, ctx.report)
    }
  } else if (soloCols && soloCols.length === 2 && bodySlots.length >= 2) {
    // Two real body frames — the design's own left/right, not a synthesized
    // split, so each column gets the layout's typography and its own slot.
    ctx.report.add('carried', 'columns-imported', where,
      'a .columns block becomes two side-by-side body frames')
    soloCols.forEach((col, i) => {
      const s = bodySlots[i]
      emitInto(elements, frameOf(s), col.blocks, s, boxCtx, s)
    })
  } else if (bodySlots.length && pieces.length) {
    emitInto(elements, frameOf(bodySlots[0]), pieces, bodySlots[0], boxCtx, bodySlots[0])
  } else if (pieces.length) {
    // 'blank' (and a 'section' that unexpectedly carries content): the whole
    // page inside the margin the other designs use, so a headless slide still
    // lines up with its neighbours. 'blank' has no placeholders at all, hence
    // the synthesized style rather than a slot.
    const m = Math.round(ctx.size.width * 0.075)
    emitInto(elements, { x: m, y: m, w: ctx.size.width - m * 2, h: ctx.size.height - m * 2 },
      pieces, bodySlots[0] ?? bodyStyle(ctx), boxCtx)
  }

  if (notes.length) {
    ctx.report.add('carried', 'notes-imported', where,
      'a ::: {.notes} block becomes the slide\'s speaker notes')
  }

  const s: OutSlide = {
    id: `q${n}`,
    name: (isTitleSlide ? asText(at(ctx.meta, 'title')) : c.heading?.text) || `Slide ${n}`,
    background,
    transition: 'none',
    notes: notes.join('\n\n'),
    elements,
    layoutId: ly.id,
  }
  if (hidden) s.hidden = true
  return s
}

const frameOf = (t: OutText): Frame => ({ x: t.x, y: t.y, w: t.w, h: t.h })

/** Body typography for a design with no body placeholder ('blank'), scaled to
 *  the deck exactly as `buildLayout` scales the real ones. */
function bodyStyle(ctx: Ctx): OutText {
  const s = Math.min(ctx.size.width / 1600, ctx.size.height / 900)
  return {
    id: 'q-style', type: 'text', x: 0, y: 0, w: ctx.size.width, h: ctx.size.height,
    rotation: 0, opacity: 1, html: '',
    fontSize: Math.max(8, Math.round(26 * s)), fontFamily: ctx.pal.font, fontWeight: 400,
    color: ctx.pal.muted, align: 'left', valign: 'top', lineHeight: 1.5,
  }
}

/** A placeholder, filled: the layout brings frame + typography, the caller
 *  brings content. `placeholder` never rides along — a prompt on a real slide
 *  would show "Click to add title" under the words. */
function fill(ph: OutText, html: string, over: Partial<OutText> = {}): OutText {
  const { placeholder: _drop, ...rest } = ph
  return { ...rest, html, ...over }
}

/** `Author · Institute — Date`, from however the front matter spells them. */
function bylineOf(meta: Record<string, Yaml>): string {
  const who = [asText(at(meta, 'author')), asText(at(meta, 'institute'))].filter(Boolean).join(' · ')
  const when = asText(at(meta, 'date'))
  return [who, when === 'today' ? '' : when].filter(Boolean).join(' — ')
}

/** One `.column` of a `.columns` div: its blocks and its relative width. */
interface Column { blocks: MdBlock[]; weight: number }

/** `blocks` of a `::: {.columns}` div, or undefined when it isn't one (or has
 *  fewer than two `.column` children, which is not a split at all). */
function columnsOf(b: MdBlock | undefined): Column[] | undefined {
  if (!b || b.kind !== 'div' || !b.at.classes.includes('columns')) return undefined
  const cols = b.blocks.filter((c): c is Extract<MdBlock, { kind: 'div' }> =>
    c.kind === 'div' && c.at.classes.includes('column'))
  if (cols.length < 2) return undefined
  return cols.map((c) => ({ blocks: c.blocks, weight: parseFloat(c.at.keys['width'] ?? '') || 1 }))
}

const isSoloFigure = (blocks: MdBlock[]): boolean => {
  const figs = blocks.filter((b) => b.kind === 'image')
  const rest = blocks.filter((b) => b.kind !== 'image')
  return figs.length === 1 && rest.length <= 1 && rest.every((b) => b.kind === 'para')
}

// --- boxes ----------------------------------------------------------------------

interface BoxCtx {
  ctx: Ctx
  where: string
  nextId: (tag: string) => string
  fx: Stagger
  smaller: boolean
  centred: boolean
}

/**
 * Quarto's two staggering idioms, unified.
 *
 * `. . .` bumps the step for everything after it; `::: {.incremental}` gives
 * every item in the list it wraps its own step. Both land as `fx.enter` +
 * `fx.order`, which is exactly how the editor's own entrance stagger works —
 * so the result is editable in the Effects panel rather than a special mode.
 * Step 0 carries NO fx at all: the first thing on a slide should be on screen
 * when the slide arrives.
 */
class Stagger {
  private step = 0
  bump() { this.step++ }
  get order() { return this.step }
  reset(to: number) { this.step = to }
  /** The fx for the current step, or undefined at step 0. */
  now(): OutElement['fx'] | undefined {
    return this.step > 0 ? { enter: 'fade-up', order: this.step } : undefined
  }
  /** The fx for one item of an incremental run, advancing the step. */
  next(): OutElement['fx'] {
    this.step++
    return { enter: 'fade-up', order: this.step }
  }
}

/**
 * One block plus the entrance step it landed on.
 *
 * The step is resolved DURING the flatten walk, not when the box is built:
 * `. . .` and `.incremental` advance the counter as the walk passes them, and
 * a block's step is whatever the counter said when the walk reached IT. Read
 * later, every block on the slide would see the final counter value — which is
 * exactly the bug where a paragraph BEFORE the pause entered with the
 * paragraph after it.
 */
/** `freezeNumbers`: a numbered list that must keep literal numbers even
 *  though it starts at 1 — the first step of an incremental run, so that it
 *  lines up with the later steps (see flattenForStagger). */
interface Staged { block: MdBlock; fx?: OutElement['fx']; freezeNumbers?: boolean }

/** Build boxes for `blocks`, stack them in `region`, and push the result. */
function emitInto(
  out: OutElement[],
  region: Frame,
  blocks: MdBlock[],
  style: OutText,
  bc: BoxCtx,
  /** the placeholder whose id/role the first TEXT box adopts, if any */
  adopt?: OutText,
) {
  const boxes: Box[] = []
  for (const st of flattenForStagger(blocks, bc)) {
    const box = boxFor(st, region, style, bc, boxes.length === 0 ? adopt : undefined)
    if (box) boxes.push(box)
  }
  if (!boxes.length) return
  const gap = Math.round(style.fontSize * 0.6)
  // The page's own bottom margin is the hard limit — mirrors the 72px the
  // built-in designs leave under a 1600x900 body frame.
  const limitY = bc.ctx.size.height - Math.round(bc.ctx.size.height * 0.045)
  const { frames, dense } = place(region, boxes, gap, limitY)
  if (dense) bc.ctx.dense++
  boxes.forEach((b, i) => out.push(...b.emit(frames[i])))
}

/**
 * Flatten the block list into the units that actually become elements,
 * applying `. . .` and `.incremental` as they are met.
 *
 * `.incremental` around a list is the only place one source block becomes
 * several elements — each item needs its own frame to enter on its own step.
 */
function flattenForStagger(blocks: MdBlock[], bc: BoxCtx): Staged[] {
  const out: Staged[] = []
  for (const b of blocks) {
    if (b.kind === 'pause') {
      bc.fx.bump()
      bc.ctx.report.add('approximated', 'pause-approximated', bc.where,
        'a `. . .` pause becomes a staggered fade-up entrance on everything after it — BeeSlides enters a slide\'s steps on a timeline, not on separate clicks')
      continue
    }
    if (b.kind === 'div') {
      const cls = b.at.classes
      if (cls.includes('incremental') || cls.includes('fragment')) {
        bc.ctx.report.add('approximated', 'incremental-approximated', bc.where,
          'a ::: {.incremental} list enters item by item as staggered fade-ups')
        // The steps an incremental run adds are LOCAL to it: in reveal,
        // content after a fragment list that is not itself a fragment shows
        // with the slide, so the counter is restored on the way out.
        const outer = bc.fx.order
        for (const inner of b.blocks) {
          if (inner.kind === 'list') {
            // one step per TOP-LEVEL item, its sub-items riding along (a
            // nested item alone would lose its indent in a list of its own);
            // an ordered item past the first carries its running number, so
            // it keeps it as text (see boxFor's 'list') — and when there IS
            // a later step, the first one does too: a real <ol> hangs its
            // marker outside the text, literal "2." does not, and the steps
            // of one list must line up
            const top = Math.min(...inner.items.map((it) => it.depth))
            const freezeNumbers = inner.ordered && inner.items.filter((it) => it.depth === top).length > 1
            let unit: typeof inner.items = []
            let k = 0
            const flush = () => {
              if (!unit.length) return
              const items = inner.ordered
                ? unit.map((it) => (it === unit[0] ? { ...it, ordinal: (inner.items[0].ordinal ?? 1) + k } : it))
                : unit
              out.push({
                block: { kind: 'list', ordered: inner.ordered, items }, fx: bc.fx.next(),
                ...(freezeNumbers ? { freezeNumbers } : {}),
              })
              k++
              unit = []
            }
            for (const it of inner.items) {
              if (it.depth === top) flush()
              unit.push(it)
            }
            flush()
            continue
          }
          out.push({ block: inner, fx: bc.fx.next() })
        }
        bc.fx.reset(outer)
        continue
      }
      if (cls.includes('nonincremental')) { out.push(...flattenForStagger(b.blocks, bc)); continue }
      if (cls.some((c) => c in CALLOUT_TONES)) { out.push({ block: b, fx: bc.fx.now() }); continue }
      // A .columns div that is NOT the slide's only content stays one block
      // and splits whatever frame the stack gives it (see `columnsBox`).
      if (columnsOf(b)) { out.push({ block: b, fx: bc.fx.now() }); continue }
      if (cls.some((c) => KNOWN_DIVS.has(c))) {
        // A wrapper we recognise but that carries no geometry of its own
        // (.center, .smaller, a knitr .cell) — its children are the content.
        out.push(...flattenForStagger(b.blocks, bc))
        continue
      }
      bc.ctx.report.add('dropped', 'div-unknown', bc.where,
        `fenced div ::: {${cls.map((c) => `.${c}`).join(' ') || '?'}} has no mapping — its contents are imported as ordinary blocks and the wrapper's styling is lost`)
      out.push(...flattenForStagger(b.blocks, bc))
      continue
    }
    out.push({ block: b, fx: bc.fx.now() })
  }
  return out
}

/** One block → one Box (or nothing, when it carries no content). */
function boxFor(st: Staged, region: Frame, style: OutText, bc: BoxCtx, adopt?: OutText): Box | undefined {
  const b = st.block
  const { ctx, where } = bc
  const pal = ctx.pal
  const scale = bc.smaller ? 0.8 : 1
  const size = Math.max(12, Math.round(style.fontSize * scale))
  const lh = style.lineHeight
  const fxOf = () => st.fx

  switch (b.kind) {
    case 'heading': {
      // A heading BELOW slide-level is a sub-head inside the slide, not a break.
      const found = newFinding()
      const html = `<b>${inlineToHtml(b.text, found)}</b>`
      reportInline(found, where, ctx.report)
      const s = Math.round(size * 1.15)
      return textBox(html, inlineToText(b.text), s, lh, pal.ink, style, bc, adopt, fxOf())
    }
    case 'para': {
      const found = newFinding()
      const html = inlineToHtml(b.text, found)
      reportInline(found, where, ctx.report)
      if (!html.trim()) return undefined
      return textBox(html, inlineToText(b.text), size, lh, style.color, style, bc, adopt, fxOf(),
        bc.centred ? 'center' : style.align)
    }
    case 'list': {
      const found = newFinding()
      // A REAL list (rich text: ul/ol/li, nested by indent — the shape the
      // editor's own markdown paste writes, convert/lists.ts), which makes
      // the document require 'rich-text'. One exception: an ordered list that
      // does not start at 1 keeps literal numbers, because the sanitizer
      // strips <ol start> and a real list would renumber it from 1 — and so
      // does every step of an incremental numbered list (st.freezeNumbers).
      // Each item carries its own kind: bullet details nest inside a step.
      const frozen = b.ordered && ((b.items[0]?.ordinal ?? 1) !== 1 || st.freezeNumbers === true)
      const marker = (it: MdItem): string => (it.ordered ? `${it.ordinal ?? 1}.` : '•')
      const html = frozen
        ? b.items.map((it) =>
          `${'&nbsp;'.repeat(it.depth * 4)}${marker(it)} ${inlineToHtml(it.text, found)}`).join('<br>')
        : paragraphsHtml(b.items.map((it) => ({
          kind: 'item' as const, level: it.depth, ordered: it.ordered, html: inlineToHtml(it.text, found),
        })))
      if (frozen) {
        ctx.report.add('approximated', 'list-start-frozen', where,
          'a numbered list that does not start at 1 (or a step of an incremental numbered list) keeps its numbers as text — a real list always counts from 1')
      }
      reportInline(found, where, ctx.report)
      const plain = b.items.map((it) => `${'  '.repeat(it.depth)}${marker(it)} ${inlineToText(it.text)}`).join('\n')
      if (!plain.trim()) return undefined
      return textBox(html, plain, size, lh, style.color, style, bc, adopt, fxOf())
    }
    case 'code':
      return codeBox(b, size, bc, fxOf())
    case 'table':
      return tableBox(b, size, bc, fxOf())
    case 'image':
      return imageBox(b, region, bc, fxOf())
    case 'math': {
      ctx.report.add('carried', 'math-verbatim', where,
        'LaTeX math is carried VERBATIM — slides renders `$…$`/`$$…$$` to MathML at render time, so the source is the model')
      const s = Math.round(size * 1.3)
      const tex = `$$${b.tex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}$$`
      const est = Math.max(1, b.tex.split('\n').length)
      return {
        nat: () => Math.round(s * 1.9 * est),
        min: () => Math.round(s * 1.4 * est),
        emit: (f) => [textEl(bc, tex, f, { fontSize: s, color: pal.ink, align: 'center', valign: 'middle', lineHeight: 1.3 }, fxOf())],
      }
    }
    case 'quote':
      return quoteBox(b, size, bc, fxOf())
    case 'raw':
      ctx.report.add('dropped', 'raw-html-dropped', where,
        'a raw HTML block is imported as its plain text — arbitrary markup has no element to land in (the sanitizer keeps b/i/s/code only)')
      return textBox(inlineToHtml(b.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')),
        b.text.replace(/<[^>]+>/g, ' '), size, lh, style.color, style, bc, adopt, fxOf())
    case 'div': {
      const cols = columnsOf(b)
      if (cols) return columnsBox(cols, region, size, style, bc)
      return calloutBox(b, size, bc, fxOf())
    }
    default:
      return undefined
  }
}

/** The plain text box, and the one place a body placeholder is adopted. */
function textBox(
  html: string, plain: string, size: number, lh: number, color: string,
  style: OutText, bc: BoxCtx, adopt: OutText | undefined, fx: OutElement['fx'] | undefined,
  align: OutText['align'] = 'left',
): Box {
  return {
    nat: (w) => textHeight(plain, w, size, lh),
    min: (w) => textHeight(plain, w, Math.max(13, Math.round(size * 0.62)), lh),
    emit: (f) => {
      const s = fitFont(plain, f.w, f.h, size, lh)
      const el = textEl(bc, html, f, { fontSize: s, color, align, lineHeight: lh }, fx)
      // Adopting the placeholder's id AND role is what makes the slide
      // re-layoutable: `applyLayout` matches by id first, then by role, so the
      // body text follows the reader into whichever design they pick next.
      // Only a TEXT box may adopt a TEXT placeholder — a code/table donor
      // matched by id to a text placeholder is CONSUMED and its content
      // dropped (model.ts `applyLayout` copies html only between two texts),
      // which is why every other box mints its own id and takes no role.
      return [adopt ? { ...el, id: adopt.id, role: adopt.role, fontFamily: style.fontFamily } : el]
    },
  }
}

function textEl(
  bc: BoxCtx, html: string, f: Frame, over: Partial<OutText>, fx?: OutElement['fx'],
): OutText {
  return {
    id: bc.nextId('t'), type: 'text',
    x: r2(f.x), y: r2(f.y), w: r2(f.w), h: r2(f.h),
    rotation: 0, opacity: 1,
    html,
    fontSize: 26, fontFamily: bc.ctx.pal.font, fontWeight: 400,
    color: bc.ctx.pal.ink, align: 'left', valign: 'top', lineHeight: 1.5,
    ...over,
    ...(fx ? { fx } : {}),
  }
}

/** A ``` fence → a `code` element, with the fence's language as the grammar. */
function codeBox(b: Extract<MdBlock, { kind: 'code' }>, size: number, bc: BoxCtx, fx?: OutElement['fx']): Box | undefined {
  const { ctx, where } = bc
  if (!b.content.trim()) {
    if (b.cell) ctx.cells++
    return undefined
  }
  if (b.cell) {
    ctx.cells++
    ctx.report.add('approximated', 'code-cell-as-source', where,
      `an executable \`{${b.lang || 'cell'}}\` cell is imported as its SOURCE — nothing here runs code, by design (see the module header)`)
  } else {
    ctx.report.add('carried', 'code-imported', where,
      'a fenced code block becomes a `code` element — tokenized by the built-in grammar and morphable line by line across slides')
  }
  // `quarto render --to markdown` wraps a cell's RESULTS in a fence classed
  // `.cell-output`/`.cell-output-stdout`, whose first class is not a language
  // at all. Printed output gets no grammar, which is also the right rendering.
  const isOutput = /^cell-output/.test(b.lang) || b.at.classes.some((c) => c.startsWith('cell-output'))
  const grammar = isOutput ? undefined : grammarFor(b.lang)
  if (b.lang && !isOutput && !KNOWN_GRAMMARS.has(grammar!)) {
    ctx.report.add('approximated', 'code-grammar-unknown', where,
      `no built-in grammar for "${b.lang}" — the listing renders with the fallback tokenizer, and the language can be set in the Code panel`)
  }
  const lines = b.content.split('\n')
  const lh = 1.25
  return {
    nat: () => Math.round(lines.length * size * 0.9 * lh) + Math.round(size * 0.6),
    min: () => Math.round(lines.length * Math.max(12, size * 0.55) * lh),
    emit: (f) => {
      // Code wraps badly, so the fit is driven by the LONGEST line as well as
      // the line count — a listing that has to shrink to fit its width is
      // still better than one clipped at the right edge.
      const longest = lines.reduce((a, l) => Math.max(a, l.length), 1)
      const byWidth = Math.floor(f.w / (longest * ADV_MONO))
      const byHeight = Math.floor(f.h / (lines.length * lh))
      const s = Math.max(10, Math.min(Math.round(size * 0.9), byWidth, byHeight))
      const el: OutCode = {
        id: bc.nextId('c'), type: 'code',
        x: r2(f.x), y: r2(f.y), w: r2(f.w), h: r2(f.h),
        rotation: 0, opacity: 1,
        content: b.content,
        fontSize: s,
        fontFamily: MONO_STACK,
        color: ctx.pal.ink,
        align: 'left', valign: 'top', lineHeight: lh,
        ...(grammar ? { grammarName: grammar } : {}),
        ...(fx ? { fx } : {}),
      }
      return [el]
    },
  }
}

/**
 * Fence language → a kernel/src/tokenize.ts grammar id.
 *
 * Only the aliases that differ from the id are listed; everything else is
 * passed through and `tokenize` falls back to js rules for an id it does not
 * know (its documented behaviour), so an unlisted language still highlights
 * plausibly rather than throwing.
 */
const GRAMMAR_ALIAS: Record<string, string> = {
  javascript: 'js', jsx: 'js', mjs: 'js', node: 'js',
  typescript: 'ts', tsx: 'ts',
  python: 'py', python3: 'py', ipython: 'py', jupyter: 'py',
  bash: 'sh', shell: 'sh', console: 'sh', 'shell-session': 'sh',
  'c++': 'cpp', cc: 'cpp', hpp: 'cpp', h: 'c', objective: 'objc', 'objective-c': 'objc',
  'c#': 'csharp', cs: 'csharp', fs: 'fsharp', 'f#': 'fsharp',
  rb: 'ruby', rs: 'rust', kt: 'kotlin', ex: 'elixir', exs: 'elixir', pl: 'perl',
  hs: 'haskell', ml: 'ocaml', tex: 'latex', markdown: 'md', patch: 'diff',
  yml: 'yaml', dockerfile: 'dockerfile', make: 'makefile', terraform: 'hcl', tf: 'hcl',
  ps1: 'powershell', pwsh: 'powershell', m: 'matlab', octave: 'matlab',
  // R and Stan are Quarto's own house languages; `r` is already a grammar id.
  rscript: 'r', stan: 'cpp', sas: 'sql',
}

/**
 * Every grammar id `tokenize` actually has a table for, read OFF that table
 * rather than restated — a hand-copied list would go stale the first time a
 * language is added, and the symptom would be a spurious "no built-in grammar
 * for x" line in an otherwise clean report. The two line-prefix formats are
 * handled by `tokenize` outside LANGS (see its head), so they are added here.
 */
const KNOWN_GRAMMARS = new Set([...Object.keys(LANGS), 'diff', 'patch', 'md', 'markdown'])

function grammarFor(lang: string): string | undefined {
  const l = lang.toLowerCase()
  if (!l) return undefined
  return GRAMMAR_ALIAS[l] ?? l
}

/** A pipe table → a `table` element with the deck's own default styling. */
function tableBox(b: Extract<MdBlock, { kind: 'table' }>, size: number, bc: BoxCtx, fx?: OutElement['fx']): Box | undefined {
  const { ctx, where } = bc
  if (!b.head.length && !b.rows.length) return undefined
  ctx.report.add('carried', 'table-imported', where,
    'a pipe table becomes a real `table` element — per-cell alignment carried, column widths equal (markdown carries none)')
  const found = newFinding()
  const cell = (s: string, align: Align): OutTableCell => {
    const c: OutTableCell = { html: inlineToHtml(s, found) }
    if (align !== 'left') c.align = align
    return c
  }
  const cols = Math.max(b.head.length, ...b.rows.map((r) => r.length), 1)
  const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? '')
  const header = b.head.some((h) => h.trim())
  const rows = [...(header ? [b.head] : []), ...b.rows]
    .map((r) => ({ cells: pad(r).map((v, i) => cell(v, b.aligns[i] ?? 'left')) }))
  reportInline(found, where, ctx.report)
  const fontSize = Math.max(12, Math.round(size * 0.72))
  const padY = Math.round(fontSize * 0.62)
  const rowH = Math.round(fontSize * 1.5) + padY * 2
  return {
    nat: () => rows.length * rowH,
    min: () => Math.round(rows.length * rowH * 0.7),
    emit: (f) => {
      const el: OutTable = {
        id: bc.nextId('b'), type: 'table',
        x: r2(f.x), y: r2(f.y), w: r2(f.w), h: r2(Math.min(f.h, rows.length * rowH)),
        rotation: 0, opacity: 1,
        columns: Array.from({ length: cols }, () => ({ w: 1 })),
        rows,
        header,
        // Mirrors model.ts's DEFAULT_TABLE_STYLE, re-toned for the palette —
        // TableElement.style is required, so an omitted one is not an option.
        style: {
          headerBg: ctx.pal.accent,
          headerColor: '#1E2A3A',
          zebra: ctx.pal === DARK ? 'rgba(255,255,255,0.05)' : 'rgba(30,42,58,0.05)',
          borderColor: ctx.pal === DARK ? 'rgba(255,255,255,0.16)' : 'rgba(30,42,58,0.14)',
          borderWidth: 1,
          cellPadX: Math.round(fontSize * 0.9),
          cellPadY: padY,
          fontSize,
          color: ctx.pal.ink,
          radius: 10,
        },
        ...(fx ? { fx } : {}),
      }
      return [el]
    },
  }
}

/** A figure → an `image` element, sized by its own aspect ratio. */
function imageBox(
  b: Extract<MdBlock, { kind: 'image' }>, region: Frame, bc: BoxCtx, fx?: OutElement['fx'],
): Box | undefined {
  const { ctx, where } = bc
  const src = b.src.trim()
  if (!src) return undefined
  let ref: string | undefined
  let ar = 16 / 9
  if (/^data:/i.test(src)) {
    ref = src
    ctx.report.add('carried', 'image-inline-data', where, 'a data: URI figure is carried as-is')
  } else if (/^https?:/i.test(src)) {
    ref = src
    ctx.report.add('approximated', 'image-remote', where,
      `"${src}" stays a remote reference — the picture needs the network to appear, and a BeeSlides file is supposed to be self-contained. Download it and re-import to embed it.`)
  } else {
    const fig = ctx.figures.resolve(src)
    if (!fig) {
      ctx.report.add('dropped', 'image-unresolved', where,
        `figure "${src}" was not among the files provided — pick its folder alongside the source (a \`quarto render\` writes figures to a sibling _files/ folder) and re-import to embed it`)
      return undefined
    }
    if (!fig.key) {
      ctx.report.add('dropped', 'image-not-a-picture', where,
        `"${src}" is ${fig.notImage}, not an image a browser can paint — a \`quarto render --to pdf\` run writes PDF figures. Render to markdown (or HTML) instead and re-import.`)
      return undefined
    }
    ref = `asset:${fig.key}`
    if (fig.box && fig.box.w > 0 && fig.box.h > 0) ar = fig.box.w / fig.box.h
    else {
      ctx.report.add('approximated', 'image-size-unknown', where,
        `"${src}" has no readable header size — it is framed at 16:9, so an unusually tall or wide figure may need a nudge`)
    }
    ctx.report.add('carried', 'image-embedded', where,
      'a figure is embedded in doc.assets as a data URI, so the deck stays one self-contained file')
  }
  // Pandoc's own `{width=60%}` is a fraction of the text column.
  const pct = parsePercent(b.at.keys['width'] ?? b.at.keys['fig-width'])
  const wantW = pct ? region.w * pct : region.w
  const natH = Math.round(wantW / ar)
  // the bracket text is the CAPTION (shown under the picture below); the
  // text alternative is Quarto's own fig-alt when given, else that caption
  const alt = b.alt.trim()
  const altText = (b.at.keys['fig-alt'] ?? '').trim() || inlineToText(alt).trim()
  return {
    nat: () => Math.min(natH, Math.round(region.h)),
    min: () => Math.round(Math.min(natH, region.h) * 0.5),
    emit: (f) => {
      // Fit inside the frame preserving the ratio, then centre — 'contain'
      // would letterbox inside a wrong-shaped box, which reads as a bug.
      let w = Math.min(f.w, wantW)
      let h = Math.round(w / ar)
      if (h > f.h) { h = f.h; w = Math.round(h * ar) }
      const el: OutImage = {
        id: bc.nextId('i'), type: 'image',
        x: r2(f.x + (f.w - w) / 2), y: r2(f.y + (f.h - h) / 2), w: r2(w), h: r2(h),
        rotation: 0, opacity: 1,
        src: ref!,
        fit: 'contain',
        ...(altText ? { alt: altText } : {}),
        ...(fx ? { fx } : {}),
      }
      // The caption rides as a small line under the picture ONLY when it does
      // not fit the picture-caption design's own caption slot (that path fills
      // the slot instead — see emitSlide).
      if (!alt || h > f.h - 34) return [el]
      const cap = textEl(bc, inlineToHtml(alt), { x: f.x, y: el.y + h + 8, w: f.w, h: 30 },
        { fontSize: Math.max(12, Math.round(f.w / 46)), color: bc.ctx.pal.muted, align: 'center', lineHeight: 1.3 }, fx)
      return [el, cap]
    },
  }
}

const parsePercent = (v: string | undefined): number | undefined => {
  const m = v && /^([\d.]+)%$/.exec(v.trim())
  return m ? Math.min(1, Math.max(0.05, parseFloat(m[1]) / 100)) : undefined
}

/** A blockquote → an accent rule plus its text, welded by `groupId`. */
function quoteBox(b: Extract<MdBlock, { kind: 'quote' }>, size: number, bc: BoxCtx, fx?: OutElement['fx']): Box | undefined {
  const text = blocksToText(b.blocks)
  if (!text.trim()) return undefined
  bc.ctx.report.add('approximated', 'quote-approximated', bc.where,
    'a blockquote becomes an accent rule plus its text, grouped — the format has no quote element')
  const lh = 1.45
  const s = Math.round(size * 1.05)
  const inset = Math.round(s * 1.2)
  return {
    nat: (w) => textHeight(text, w - inset, s, lh) + Math.round(s * 0.5),
    min: (w) => textHeight(text, w - inset, Math.max(13, Math.round(s * 0.7)), lh),
    emit: (f) => {
      const g = bc.nextId('g')
      const rule: OutShape = {
        id: bc.nextId('s'), type: 'shape', shape: 'rect',
        x: r2(f.x), y: r2(f.y), w: 4, h: r2(f.h),
        rotation: 0, opacity: 1,
        fill: bc.ctx.pal.accent, stroke: 'transparent', strokeWidth: 0, radius: 2,
        groupId: g,
        ...(fx ? { fx } : {}),
      }
      const body = textEl(bc, inlineToHtml(text), { x: f.x + inset, y: f.y, w: f.w - inset, h: f.h },
        { fontSize: fitFont(text, f.w - inset, f.h, s, lh), color: bc.ctx.pal.muted, lineHeight: lh }, fx)
      return [rule, { ...body, groupId: g }]
    },
  }
}

/**
 * A `::: {.columns}` inside a stack → its columns side by side in the frame
 * the stack handed over.
 *
 * The design's own two body slots are better (real placeholders, the layout's
 * typography, `role:'body'` on each) and `emitSlide` uses them when the div is
 * the slide's ONLY content. This is the other case: columns sharing a slide
 * with something else, or three or more of them.
 *
 * The child boxes are built ONCE, here, and reused by `nat`/`min`/`emit` —
 * building them has side effects (report lines, stagger steps), so a measuring
 * pass that rebuilt them would double-report and desynchronize the entrances.
 */
function columnsBox(cols: Column[], region: Frame, size: number, style: OutText, bc: BoxCtx): Box | undefined {
  const filled = cols.filter((c) => c.blocks.length)
  if (!filled.length) return undefined
  bc.ctx.report.add('approximated', 'columns-approximated', bc.where,
    `${filled.length} .column(s) are laid out as side-by-side frames inside one body region — a slide whose ONLY content is two columns gets the built-in two-column design instead`)
  const gap = Math.round(size * 1.2)
  const weights = filled.map((c) => c.weight)
  const inner = Math.round(size * 0.6)
  // Approximate per-column regions, for the children that care about the space
  // they are going into (a figure's natural height). The real frames come at
  // emit time, from whatever height the stack actually granted.
  const guides = columns(region, weights, gap)
  const built = filled.map((c, i) =>
    flattenForStagger(c.blocks, bc)
      .map((st) => boxFor(st, guides[i], style, bc))
      .filter((b): b is Box => b !== undefined))
  /** The box is as tall as its TALLEST column. */
  const tallest = (w: number, pick: (b: Box, colW: number) => number) => {
    const frames = columns({ ...region, w }, weights, gap)
    return Math.max(1, ...built.map((boxes, i) =>
      boxes.reduce((a, b) => a + pick(b, frames[i].w), 0) + inner * Math.max(0, boxes.length - 1)))
  }
  return {
    nat: (w) => tallest(w, (b, colW) => b.nat(colW)),
    min: (w) => tallest(w, (b, colW) => b.min(colW)),
    emit: (f) => {
      const frames = columns(f, weights, gap)
      const out: OutElement[] = []
      built.forEach((boxes, i) => {
        const { frames: rows, dense } = place(frames[i], boxes, inner)
        if (dense) bc.ctx.dense++
        boxes.forEach((b, k) => out.push(...b.emit(rows[k])))
      })
      return out
    },
  }
}

/** A `::: {.callout-*}` → a tinted panel, an accent bar and its text, grouped. */
function calloutBox(b: Extract<MdBlock, { kind: 'div' }>, size: number, bc: BoxCtx, fx?: OutElement['fx']): Box | undefined {
  const cls = b.at.classes.find((c) => c in CALLOUT_TONES)
  if (!cls) return undefined
  const tone = CALLOUT_TONES[cls]
  const heading = b.blocks.find((x) => x.kind === 'heading')
  const title = b.at.keys['title'] || (heading && heading.kind === 'heading' ? heading.text : '') || tone.label
  const rest = b.blocks.filter((x) => x !== heading)
  const text = blocksToText(rest)
  bc.ctx.report.add('approximated', 'callout-approximated', bc.where,
    `a ::: {.${cls}} becomes a tinted panel with an accent bar and its text, grouped — the format has no callout element, so the parts stay individually editable`)
  const s = Math.max(12, Math.round(size * 0.85))
  const lh = 1.4
  const padX = Math.round(s * 0.9)
  const padY = Math.round(s * 0.7)
  const titleH = Math.round(s * 1.5)
  return {
    nat: (w) => textHeight(text, w - padX * 2 - 6, s, lh) + titleH + padY * 2,
    min: (w) => textHeight(text, w - padX * 2 - 6, Math.max(12, Math.round(s * 0.75)), lh) + titleH + padY,
    emit: (f) => {
      const g = bc.nextId('g')
      const panel: OutShape = {
        id: bc.nextId('s'), type: 'shape', shape: 'rect',
        x: r2(f.x), y: r2(f.y), w: r2(f.w), h: r2(f.h),
        rotation: 0, opacity: 1,
        fill: tint(tone.color, bc.ctx.pal === DARK ? 0.18 : 0.1),
        stroke: 'transparent', strokeWidth: 0, radius: 10,
        groupId: g,
        ...(fx ? { fx } : {}),
      }
      const bar: OutShape = {
        id: bc.nextId('s'), type: 'shape', shape: 'rect',
        x: r2(f.x), y: r2(f.y), w: 6, h: r2(f.h),
        rotation: 0, opacity: 1,
        fill: tone.color, stroke: 'transparent', strokeWidth: 0, radius: 3,
        groupId: g,
        ...(fx ? { fx } : {}),
      }
      const head = textEl(bc, `<b>${inlineToHtml(title)}</b>`,
        { x: f.x + padX + 6, y: f.y + padY, w: f.w - padX * 2 - 6, h: titleH },
        { fontSize: s, color: tone.color, lineHeight: 1.2 }, fx)
      const out: OutElement[] = [panel, bar, { ...head, groupId: g }]
      if (text.trim()) {
        const bodyH = f.h - titleH - padY * 2
        const body = textEl(bc, inlineToHtml(text),
          { x: f.x + padX + 6, y: f.y + padY + titleH, w: f.w - padX * 2 - 6, h: Math.max(s, bodyH) },
          { fontSize: fitFont(text, f.w - padX * 2 - 6, Math.max(s, bodyH), s, lh), color: bc.ctx.pal.ink, lineHeight: lh }, fx)
        out.push({ ...body, groupId: g })
      }
      return out
    },
  }
}

/** `#rrggbb` at `a` alpha, as an rgba() the model already accepts everywhere. */
function tint(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

/** Fold one inline pass's findings into the report. */
function reportInline(f: InlineFinding, where: string, report: Report) {
  if (f.citations.length) {
    report.add('dropped', 'citation-unresolved', where,
      `${f.citations.length} citation(s) (${f.citations.slice(0, 3).join(' ')}) stay as literal text — resolving them needs a bibliography processor this importer has no business being`)
  }
  if (f.links.length) {
    report.add('approximated', 'link-flattened', where,
      `${f.links.length} link(s) keep their text but lose the URL — an element's \`link\` jumps to a SLIDE in this deck, so an external address has nowhere in the model to go`)
  }
  if (f.footnotes) {
    report.add('dropped', 'footnote-marker-dropped', where,
      `${f.footnotes} footnote marker(s) removed — a slide has no footnote area, so the note bodies import as ordinary content wherever they were written`)
  }
  if (f.images.length) {
    report.add('dropped', 'image-inline-dropped', where,
      `${f.images.length} inline image(s) degrade to their alt text — a figure needs its own frame, so only a figure on its own line becomes a picture`)
  }
}
