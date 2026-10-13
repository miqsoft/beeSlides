// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The convert engine's shared contract.
//
// STRUCTURAL OUTPUT TYPES, NOT AN IMPORT FROM slides/. The kernel is shared
// code and must not depend on an app; the same inversion the charts engine
// uses (kernel/src/charts.ts declares its own option shape, slides satisfies
// it structurally). These types describe the SUBSET of slidomingo/slides the
// importer emits — slides' parseDoc validates the real thing on load, and the
// e2e rig asserts the emitted JSON loads there. Field names and semantics must
// match slides/src/model.ts exactly; when in doubt, that file wins.

import type { Report } from './report.ts'
import type { XElem } from './xml.ts'

// --- the emitted document (slidomingo/slides subset) ------------------------------

export interface OutShadow { x?: number; y?: number; blur: number; color: string }

export interface OutElementBase {
  id: string
  x: number; y: number; w: number; h: number
  rotation: number
  opacity: number
  link?: string
  groupId?: string
  role?: string
  /** Morph pairing key when it must differ from `id` (slides/src/model.ts
   *  `ElementBase.morphId`). The .pptx path sets it on a FLATTENED slide's
   *  baked chrome, to the id that chrome carries on linked slides. */
  morphId?: string
  /** Editor click-through (slides/src/model.ts `ElementBase.locked`): set on
   *  imported full-bleed backgrounds and baked master/layout decoration. */
  locked?: boolean
  shadow?: OutShadow | OutShadow[]
  /**
   * Entrance staggering, the subset the markdown importer needs for Quarto's
   * `::: {.incremental}` and `. . .`. Mirrors slides/src/model.ts
   * `ElementBase.fx` exactly (a wider union there; this is what convert emits).
   * The .pptx path emits the click-build subset (`step`/`exitStep`/`exit`/
   * `exitDur`/`byParagraph`, plus every enter kind) from p:timing — see
   * convert/builds.ts; it imports no emphasis or motion paths (slide
   * transitions are `OutSlide.transition`).
   */
  fx?: {
    enter?: 'fade-up' | 'fade' | 'fade-down' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down'
    enterDur?: number
    order?: number
    step?: number
    exitStep?: number
    exit?: 'fade-up' | 'fade' | 'fade-down' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down'
    exitDur?: number
    byParagraph?: boolean
  }
}

export interface OutText extends OutElementBase {
  type: 'text'
  html: string
  fontSize: number
  fontFamily: string
  fontWeight: number
  color: string
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  lineHeight: number
  letterSpacing?: number
  /** Layout placeholder prompt ("Click to add title") — layout entries, and
   *  the slot copies a LINKED slide carries (model.ts's normal shape: shown
   *  dimmed while empty in the editor, hidden when presenting). Flattened
   *  slide text never carries this. */
  placeholder?: string
  /** A slide's own date / slide-number / footer placeholder (p:ph dt,
   *  sldNum, ftr) — slides/src/model.ts `TextElement.footerRole`. */
  footerRole?: 'date' | 'slideNumber' | 'footer'
}

export interface OutGradient { angle: number; stops: Array<{ at: number; color: string }> }

export interface OutShape extends OutElementBase {
  type: 'shape'
  shape: 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'line' | 'path'
  fill: string
  stroke: string
  strokeWidth: number
  radius: number
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  lineStart?: 'none' | 'arrow' | 'dot' | 'bar'
  lineEnd?: 'none' | 'arrow' | 'dot' | 'bar'
  fillGradient?: OutGradient
  d?: string
  pathBox?: [number, number, number, number]
  from?: { el: string; side: string }
  to?: { el: string; side: string }
}

export interface OutImage extends OutElementBase {
  type: 'image'
  src: string
  fit: 'cover' | 'contain' | 'fill'
  radius?: number
  /** Text alternative (slides/src/model.ts `Describable.alt`): '' = decorative,
   *  absent = not described. .pptx: cNvPr@descr (else @title), '' for a
   *  picture flagged decorative; markdown: the figure's alt / fig-alt. */
  alt?: string
  /** Visible region in fractions of the natural picture (model.ts
   *  `ImageCrop`, already through normalizeCrop's clamp) — .pptx a:srcRect.
   *  Emitted together with fit:'cover', as the editor does, so a reader that
   *  ignores `crop` still shows a centred crop of the right shape. */
  crop?: { x: number; y: number; w: number; h: number }
}

export interface OutTableCell {
  html: string; align?: string; color?: string; bg?: string; bold?: boolean
  /** Merged cells (slides/src/model.ts TableCell, `requires: ['table-merge']`):
   *  on the top-left cell of a block only, whole numbers ≥ 2, never 1. The
   *  cells a block covers stay in the grid as `{ html: '' }`. */
  colspan?: number; rowspan?: number
}

export interface OutTable extends OutElementBase {
  type: 'table'
  columns: Array<{ w: number }>
  rows: Array<{ cells: OutTableCell[] }>
  header: boolean
  style?: Record<string, unknown>
}

export interface OutChart extends OutElementBase {
  type: 'chart'
  preset: 'bar' | 'line' | 'pie' | 'scatter'
  option: Record<string, unknown>
  /** Text alternative (model.ts `Describable.alt`) — the graphicFrame's
   *  cNvPr@descr/@title, '' when flagged decorative. */
  alt?: string
}

/**
 * A source listing. Emitted by the markdown/Quarto importer only — the .pptx
 * path has no equivalent (a pasted listing arrives there as a text box), which
 * is why this type did not exist until convert/qmd.ts.
 *
 * `grammarName` doubles as the language id for kernel/src/tokenize.ts's
 * built-in table; `content` is the RAW source, never html and never escaped.
 */
export interface OutCode extends OutElementBase {
  type: 'code'
  content: string
  grammarName?: string
  fontSize: number
  fontFamily: string
  color: string
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  lineHeight: number
}

export type OutElement = OutText | OutShape | OutImage | OutTable | OutChart | OutCode

export interface OutSlide {
  id: string
  name: string
  background: string
  /** ALWAYS set explicitly — slides' own constructors default to 'fade', and
   *  71 of 79 census slides carry no transition at all. The .pptx path maps
   *  p:transition (pptx.ts transitionOf); 'none' when the slide has none. */
  transition: 'none' | 'fade' | 'slide' | 'zoom' | 'morph' | 'push' | 'wipe' | 'cover' | 'split'
  /** push/wipe/cover: where the new slide comes FROM; split: the seam
   *  (model.ts `TransitionDir`). Absent = the kind's default (the first entry
   *  of model.ts TRANSITION_DIRS). */
  transitionDir?: 'left' | 'right' | 'top' | 'bottom' | 'horizontal' | 'vertical'
  notes: string
  elements: OutElement[]
  hidden?: boolean
  /**
   * A LIVE link to a `doc.layouts` entry. Both importers set it, each on its
   * own terms:
   *
   *   - .pptx links ONLY the slides that do not deviate from their layout —
   *     proven by rendering both ways and comparing (pptx.ts's `tryLink` /
   *     `renderEquivalent`). A deviating slide stays flattened and unlinked,
   *     and the report lists it ('slide-unlinked') with the reason, because
   *     the model's resync (the layout's frame + typography always win on
   *     re-apply) would silently revert the deviation on the first master
   *     edit.
   *   - .qmd/.md links every slide: a `.qmd` has no per-slide deviations to
   *     lose — every coordinate on the slide was invented by
   *     convert/mdlayout.ts from one of six designs.
   */
  layoutId?: string
  /** `doc.layouts` entries only: the entry this one descends from (model.ts
   *  `Slide.parentId`) — the .pptx path hangs every layout under its master. */
  parentId?: string
  /** `doc.layouts` entries only: the slide type's own body/heading faces
   *  (model.ts `Slide.fontFamily`/`headingFamily`) — the .pptx path sets them
   *  on master entries from the master's theme. */
  fontFamily?: string
  headingFamily?: string
}

export interface OutDoc {
  format: 'slidomingo/slides'
  version: '1.0.0'
  /** Reader-gate feature names a reader must understand to write the file
   *  back (docs/format.md; kernel/src/doc.ts, model.ts KNOWN_FEATURES). The
   *  importers declare only content-derived names, and only when the content
   *  needs them: 'table-merge' exactly when some table cell carries a span
   *  (pptx.ts), 'rich-text' exactly when converted text holds a real list
   *  (convert/lists.ts withListRequires, which appends to what is there);
   *  absent otherwise. slides' Store/save re-derive both anyway
   *  (model.syncContentRequires); this keeps converter output written
   *  straight to a file honest too. */
  requires?: string[]
  title: string
  /** Document properties pulled from docProps/core.xml + docProps/app.xml —
   *  mirrors slides/src/model.ts's optional SlidomingoDoc.meta exactly, so it
   *  loads unchanged and feeds the Layout Manager's Document properties tab. */
  meta?: { author?: string; company?: string; subject?: string; keywords?: string }
  size: { width: number; height: number }
  theme: {
    background: string; color: string; accent: string; fontFamily: string
    /** Heading (major) face — mirrors slides/src/model.ts theme.headingFamily. */
    headingFamily?: string
    /** The deck's brand slots beyond bg1/tx1/accent1, mirroring
     *  slides/src/model.ts theme.palette exactly so it loads unchanged. */
    palette?: {
      bg2?: string; tx2?: string
      accent2?: string; accent3?: string; accent4?: string
      accent5?: string; accent6?: string
      hlink?: string; folHlink?: string
    }
  }
  assets: Record<string, string>
  fonts: Array<{ family: string; asset: string; weight?: number }> | null
  slides: OutSlide[]
  /**
   * The document's slide designs. The two importers fill this from opposite
   * directions, and both are right:
   *
   *   - .pptx EXTRACTS the source deck's real masters and layouts as a tree:
   *     each slideMaster becomes a root entry (background + decoration, no
   *     placeholder prompts) and its slideLayouts hang under it via
   *     `parentId`. Deck mode keeps only what ≥1 slide uses (the PRUNE
   *     philosophy media.ts applies to assets); template mode keeps every
   *     layout. Non-deviating slides link to their layout (see
   *     `OutSlide.layoutId`).
   *   - .qmd/.md MATERIALIZES the built-in designs it laid the deck out with
   *     and links every slide — a `.qmd` has no source geometry to lose.
   */
  layouts?: OutSlide[]
  /** Which `layouts` entry a newly inserted slide starts from. Only meaningful
   *  alongside a populated `layouts`; read through model.ts's
   *  `defaultSlideType`, never directly. */
  defaultLayoutId?: string
}

/** convertPptx's knobs. */
export interface ConvertPptxOptions {
  /**
   * 'deck' (default): slides are the product; doc.layouts keeps only the
   * masters/layouts ≥1 slide uses. 'template': the package's slide designs
   * are the product — every layout under every master is extracted, the
   * package's own slides are ignored, and one starter slide linked to the
   * default layout is emitted so the document loads.
   */
  mode?: 'deck' | 'template'
  /** Link non-deviating slides to their layout (default true). `false`
   *  flattens every slide — the pre-tree output, and the oracle the linking
   *  rig compares against. */
  link?: boolean
}

// --- resolution context ------------------------------------------------------

/** A parsed theme part (theme1.xml) plus the master's colour map. */
export interface ThemeCtx {
  /** scheme slot → resolved hex, AFTER clrMap application: keys are the
   *  logical names colour references use (bg1, tx1, bg2, tx2, accent1..6,
   *  hlink, folHlink) */
  scheme: Record<string, string>
  /** major (heading) and minor (body) latin typefaces, as named in the file */
  majorFont: string
  minorFont: string
  /** raw fmtScheme lists for fillRef/lnRef resolution (fill styles, line
   *  styles, background fill styles) — resolved lazily with phClr substituted */
  fillStyles: XElem[]
  lineStyles: XElem[]
  bgFillStyles: XElem[]
  /** fmtScheme's effectStyleLst (a:effectStyle entries), for a:effectRef —
   *  read only to say what a dropped effect was. Optional: hand-built
   *  contexts in the rigs leave it out. */
  effectStyles?: XElem[]
}

/** One resolved colour. */
export interface ResolvedColor {
  /** css color, '#rrggbb' or rgba(...) when alpha < 1 */
  css: string
  from: 'own' | 'theme'
}

/**
 * The inheritance chain for one slide: everything a shape may need to look up
 * when its own XML is silent. ~513 census shapes carry no geometry and 100+
 * no transform at all — their values live only up this chain.
 */
export interface InheritCtx {
  slide: XElem
  layout?: XElem
  master?: XElem
  theme: ThemeCtx
  report: Report
}

// --- conversion result -------------------------------------------------------

export interface ConvertResult {
  doc: OutDoc
  report: import('./report.ts').FidelityReport
}

/** EMU per pixel at 96dpi — OOXML's unit; 12192000 EMU = 1280px exactly. */
export const EMU_PER_PX = 9525

/**
 * Metric-compatible substitutes: same advance widths, so line breaks land
 * where PowerPoint put them. The engine maps NAMES (byte embedding is a host
 * concern); the emitted stack keeps the original first so a machine that has
 * the real face uses it.
 */
export const METRIC_SUBSTITUTES: Record<string, string> = {
  Calibri: 'Carlito',
  Cambria: 'Caladea',
  Arial: 'Liberation Sans',
  'Times New Roman': 'Liberation Serif',
  'Courier New': 'Liberation Mono',
}
