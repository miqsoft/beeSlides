// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// The slidomingo/slides document model. This JSON is what lives inside the
// <script type="application/slidomingo+json"> block of a .beeslides.html file.

import { stripDocExt } from '../../kernel/src/docext.ts'
import { BRAND } from './brand.ts'
import { catAxisKey } from './chartaxes.ts'
import { missingFeatures } from '../../kernel/src/doc.ts'
import { resolveAssets, storeOf } from '../../kernel/src/assetstore.ts'
import type { Guides, LayoutGrid } from './layoutgrid.ts'

export const FORMAT = 'slidomingo/slides'
export const FORMAT_VERSION = 1

/**
 * Every `doc.requires` name this build understands (the reader gate —
 * kernel/src/doc.ts, docs/format.md). A writer adds a name to `requires`
 * only when the file actually USES the feature, and only for a feature an
 * older reader would silently lose on save; a reader that meets a name
 * missing from this set opens the document read-only. Add the name here in
 * the same change that teaches the app to read AND write the feature.
 */
export const KNOWN_FEATURES: ReadonlySet<string> = new Set<string>([
  // embedded bytes stored once in the file, referenced from the JSON as
  // `slidomingo-store:<id>` (kernel/src/assetstore.ts)
  'asset-store',
  // text/table html carries links, lists or coloured/sized runs
  // (render.ts sanitizeHtml, DECISIONS 2026-10-08) — see RICH_TEXT_FEATURE
  'rich-text',
  // a table cell spans several grid cells (`TableCell.colspan`/`rowspan`,
  // DECISIONS 2026-10-08) — see TABLE_MERGE_FEATURE
  'table-merge',
])

/**
 * The `requires` name for rich text phase 1. An older reader's sanitizer
 * keeps b/i/u/s/code and strips EVERY attribute and every other tag, so it
 * would show a link as plain words, a list as run-on lines and a coloured
 * run in the element colour — and write exactly that back on its next save.
 * A file whose text uses any of it therefore says so, and an older build
 * opens it read-only instead of flattening it.
 */
export const RICH_TEXT_FEATURE = 'rich-text'

/** Markup only rich text can hold: a link, a list, or a styled run. Judged
 *  on the stored html, case-insensitively — a false positive costs an older
 *  reader write access to one file, a false negative costs the formatting. */
const RICH_MARKUP = /<(?:a|ul|ol|li)[\s/>]|\sstyle\s*=/i

/** True when any text element or table cell in `doc` — its slides, slide
 *  types or deck objects — uses rich-text-only markup. Typed and targeted on
 *  purpose: an `embed` element's `html` is a whole page and says nothing
 *  about this, and this runs on every document change (Store.touch), so it
 *  must not wander into chart options or asset bytes. */
export function usesRichText(doc: unknown): boolean {
  const d = doc as { slides?: unknown; layouts?: unknown; reusableObjects?: unknown } | null
  if (!d) return false
  const rich = (html: unknown) => typeof html === 'string' && RICH_MARKUP.test(html)
  for (const list of [d.slides, d.layouts, d.reusableObjects]) {
    if (!Array.isArray(list)) continue
    for (const slide of list as Array<{ elements?: unknown }>) {
      if (!Array.isArray(slide?.elements)) continue
      for (const el of slide.elements as Array<Record<string, unknown>>) {
        if (el?.type === 'text' && rich(el.html)) return true
        if (el?.type === 'table' && Array.isArray(el.rows)) {
          for (const row of el.rows as Array<{ cells?: Array<{ html?: unknown }> }>) {
            if (Array.isArray(row?.cells) && row.cells.some((c) => rich(c?.html))) return true
          }
        }
      }
    }
  }
  return false
}

/**
 * Keep `doc.requires` honest about rich text, in place: the name is present
 * exactly while the document uses it (a writer declares only what the file
 * uses — PLATFORM.md §3), so deleting the last link lets the file open in an
 * older build again. Every other name is left exactly as found, and a
 * malformed `requires` is never "fixed" — that is the reader gate's call.
 * Returns true when it changed anything.
 */
export function syncRichTextRequires(doc: { requires?: unknown }): boolean {
  return syncFeature(doc, RICH_TEXT_FEATURE, usesRichText(doc))
}

/**
 * The `requires` name for merged table cells. An older reader renders every
 * cell of the grid, so a merged cell would show as its top-left cell beside
 * the (empty) cells it covers — the text survives, the layout does not —
 * and its next save would keep that broken look as the author's. A file
 * with a real span therefore says so, and an older build opens it read-only.
 */
export const TABLE_MERGE_FEATURE = 'table-merge'

/** True when any table — on a slide, slide type or deck object — has a cell
 *  whose stored `colspan` or `rowspan` is above 1. Judged on the stored
 *  values, not the normalised layout: a span the grid clamps away still
 *  declares the gate (a false positive only costs an older reader write
 *  access to one file). */
export function usesTableMerge(doc: unknown): boolean {
  const d = doc as { slides?: unknown; layouts?: unknown; reusableObjects?: unknown } | null
  if (!d) return false
  const spans = (c: { colspan?: unknown; rowspan?: unknown } | null | undefined) =>
    !!c && ((typeof c.colspan === 'number' && c.colspan > 1) || (typeof c.rowspan === 'number' && c.rowspan > 1))
  for (const list of [d.slides, d.layouts, d.reusableObjects]) {
    if (!Array.isArray(list)) continue
    for (const slide of list as Array<{ elements?: unknown }>) {
      if (!Array.isArray(slide?.elements)) continue
      for (const el of slide.elements as Array<Record<string, unknown>>) {
        if (el?.type !== 'table' || !Array.isArray(el.rows)) continue
        for (const row of el.rows as Array<{ cells?: unknown }>) {
          if (Array.isArray(row?.cells) && (row.cells as Array<{ colspan?: unknown; rowspan?: unknown }>).some(spans)) return true
        }
      }
    }
  }
  return false
}

/** Put `name` into `doc.requires` exactly while `on` — every other name left
 *  as found, an emptied list removed, a malformed one never "fixed". */
function syncFeature(doc: { requires?: unknown }, name: string, on: boolean): boolean {
  const cur = doc.requires
  if (cur !== undefined && !Array.isArray(cur)) return false
  const list = (cur ?? []) as unknown[]
  if (list.includes(name) === on) return false
  const next = on ? [...list, name] : list.filter((f) => f !== name)
  if (next.length) doc.requires = next
  else delete doc.requires
  return true
}

/** `syncRichTextRequires`'s twin for merged table cells. */
export function syncTableMergeRequires(doc: { requires?: unknown }): boolean {
  return syncFeature(doc, TABLE_MERGE_FEATURE, usesTableMerge(doc))
}

/**
 * Every content-derived `requires` name in step with the document, in place
 * (rich text, merged table cells). THE call for a writer: the Store runs it
 * on every change and load, save.ts on every serialize. Returns true when it
 * changed anything.
 */
export function syncContentRequires(doc: { requires?: unknown }): boolean {
  const a = syncRichTextRequires(doc)
  const b = syncTableMergeRequires(doc)
  return a || b
}

/**
 * Put the bytes back into a document that arrived as JSON with asset-store
 * refs (a light copy, an agent's edit of a file's block) from the document
 * already open: ids are content hashes, so every picture `current` holds is
 * found by lookup. A ref neither holds is KEPT (and listed in `missing`) —
 * the next save keeps whatever bytes the file still has for it.
 */
export function resolveStoreRefs(next: SlidomingoDoc, current: SlidomingoDoc): { doc: SlidomingoDoc; missing: string[] } {
  if (!JSON.stringify(next).includes('slidomingo-store:')) return { doc: next, missing: [] }
  const { doc, dangling } = resolveAssets(next, storeOf(current))
  return { doc, missing: dangling }
}

/** Every distinct JPEG/PNG `data:` URI anywhere in `doc` — what
 *  "Optimize pictures (lossless)…" can work on. */
export function embeddedRasterPictures(doc: SlidomingoDoc): string[] {
  const out = new Set<string>()
  const walk = (v: unknown) => {
    if (typeof v === 'string') { if (/^data:image\/(png|jpe?g)[;,]/i.test(v)) out.add(v) }
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(doc)
  return [...out]
}

/** Replace, in place, every string in `doc` that `map` has a replacement
 *  for (the whole string, never a substring). Returns how many changed. */
export function replaceDocStrings(doc: SlidomingoDoc, map: Map<string, string>): number {
  let n = 0
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const next = typeof v[i] === 'string' ? map.get(v[i]) : undefined
        if (next !== undefined) { v[i] = next; n++ } else walk(v[i])
      }
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      for (const k of Object.keys(o)) {
        const next = typeof o[k] === 'string' ? map.get(o[k] as string) : undefined
        if (next !== undefined) { o[k] = next; n++ } else walk(o[k])
      }
    }
  }
  walk(doc)
  return n
}

/** The `requires` names this build does not understand. Non-empty = the
 *  document must be opened read-only and never written or merged. */
export function unsupportedFeatures(doc: { requires?: unknown } | null | undefined): string[] {
  return missingFeatures(doc, KNOWN_FEATURES)
}

export type TransitionKind = 'none' | 'fade' | 'slide' | 'zoom' | 'morph' | 'push' | 'wipe' | 'cover' | 'split'

/**
 * Where a push/wipe/cover comes FROM (`left`…`bottom`), or which way a split
 * opens (`vertical` = a vertical seam parting sideways, `horizontal` = a
 * horizontal seam parting up/down). Only meaningful with those four kinds;
 * absent = the kind's first entry in `TRANSITION_DIRS`.
 */
export type TransitionDir = 'left' | 'right' | 'top' | 'bottom' | 'horizontal' | 'vertical'

/**
 * The transitions present.ts draws itself (Reveal has no such section
 * transition). An OLDER reader meets these as an unknown `data-transition`
 * value, which Reveal's base rule plays as a plain crossfade — the value
 * survives its re-save untouched, so no `requires` entry (DECISIONS
 * 2026-10-08).
 */
export const TRANSITION_DIRS: Partial<Record<TransitionKind, readonly TransitionDir[]>> = {
  push: ['right', 'left', 'bottom', 'top'],
  wipe: ['right', 'left', 'bottom', 'top'],
  cover: ['right', 'left', 'bottom', 'top'],
  split: ['vertical', 'horizontal'],
}

/** Set a slide's transition kind, dropping a `transitionDir` the new kind
 *  cannot use (push → wipe keeps "from left"; push → fade forgets it). */
export function setSlideTransition(slide: Slide, kind: TransitionKind): void {
  slide.transition = kind
  if (slide.transitionDir && !TRANSITION_DIRS[kind]?.includes(slide.transitionDir)) delete slide.transitionDir
}

/** The direction a slide's transition plays in: its own `transitionDir` when
 *  that kind accepts it, else the kind's default. Undefined for kinds without
 *  a direction. */
export function transitionDir(slide: Pick<Slide, 'transition' | 'transitionDir'>): TransitionDir | undefined {
  const dirs = TRANSITION_DIRS[slide.transition]
  if (!dirs) return undefined
  return slide.transitionDir && dirs.includes(slide.transitionDir) ? slide.transitionDir : dirs[0]
}

export interface ElementBase {
  /** Stable per-slide identity: `data-el-id`, selection, connector/comment
   *  anchors, and the CRDT node key. Also the DEFAULT morph key — elements
   *  sharing an id across adjacent slides morph into each other (the
   *  duplicate-a-slide idiom). Never mutate it to re-pair a morph; set
   *  `morphId` instead so identity stays stable. */
  id: string
  /** Optional morph-key override. When set, this element morphs with elements
   *  whose effective morph key (`morphId ?? id`) matches — letting two
   *  independently-created elements on different slides be paired without
   *  touching either's `id`. Omitted = fall back to `id` (the common case).
   *  Must not collide with another element's effective key on the SAME slide. */
  morphId?: string
  x: number
  y: number
  w: number
  h: number
  /** degrees, clockwise */
  rotation: number
  opacity: number
  /** Editor-only "don't touch": the element ignores canvas clicks, marquee,
   *  select-all, drags and nudges, but stays reachable through the right-click
   *  "Select" menu and Alt-click. Renders normally everywhere. Additive —
   *  older readers preserve it (PLATFORM.md §3). */
  locked?: boolean
  /** Hidden from every output (present, thumbnails, print/PDF, static layer).
   *  The editor canvas keeps it invisible too; it is reachable through the
   *  right-click "Select" menu. Additive — an OLDER viewer still shows it. */
  hidden?: boolean
  /**
   * Drop shadow(s), rendered with CSS drop-shadow so they follow the
   * element's alpha shape (rounded corners, ellipses, glyphs, image
   * cutouts). An array stacks: e.g. a dark elevation shadow plus a soft
   * white glow.
   */
  shadow?: ShadowSpec | ShadowSpec[]
  /** Mirror reflection below the element (the "wet floor" look), rendered with
   *  CSS `-webkit-box-reflect` so it follows the real alpha shape and includes
   *  the filter effects. Chromium/Electron and Safari draw it; Firefox ignores
   *  it, so the element simply shows without one. Not exported to SVG.
   *  Additive — older readers preserve it (PLATFORM.md §3). */
  reflection?: ReflectionSpec
  /** Gaussian blur ON this element, in px. Composed into the SAME CSS `filter`
   *  as `shadow` (both apply). Survives PDF/print, unlike backdrop blur. */
  blur?: number
  /** CSS mix-blend-mode for this element ('screen' for neon light glows,
   *  'multiply'/'overlay' for editorial duotones). Omitted/'' = normal. */
  blend?: string
  /** Frosted-glass backdrop blur behind this element, in px (0/undefined = off).
   *  Screen-only: browser print/PDF drops backdrop-filter (pair with a
   *  translucent `fill` so PDFs show a graceful flat panel). */
  backdropFilter?: number
  /** presentation effects, run in present mode only */
  fx?: {
    /** entrance animation when the slide is shown. fade-* nudge ~16px; slide-*
     *  sweep ~120px in from an edge (slide-left starts to the right, etc.) */
    enter?: 'fade-up' | 'fade' | 'fade-down' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down'
    /** entrance duration in seconds; omitted = the per-kind default
     *  (slide-* 0.75s, fade-* 0.55s). Lower = snappier, higher = more languid. */
    enterDur?: number
    /** stagger step within the entrance sequence; equal values enter together.
     *  NOT a click order — within one click `order` only staggers (see `step`). */
    order?: number
    /**
     * Click build: the click that brings this element in (1 = first click);
     * absent/0 = with the slide. Gaps are compressed at read time, so a deck
     * using steps 1, 3 and 4 has three clicks (see `builds.ts`). An older viewer
     * ignores it and shows everything at once (PLATFORM.md §3: no `requires`).
     */
    step?: number
    /** the click that takes this element out again (must come after `step`) */
    exitStep?: number
    /** exit animation (the mirror of `enter`); default 'fade' */
    exit?: 'fade' | 'fade-up' | 'fade-down' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down'
    /** exit duration in seconds; omitted = the per-kind default */
    exitDur?: number
    /** text only: paragraph k enters on click `(step ?? 1) + k` ("bullets one by one") */
    byParagraph?: boolean
    /** animate numeric parts of the text from 0 to their final value */
    countUp?: boolean
    /** continuous ambient motion (slow zoom, for full-bleed photos) */
    ambient?: 'kenburns'
    /**
     * Ken-burns tuning. dir 'drift' (default) is the endless slow yoyo zoom;
     * 'out' and 'in' play ONCE per slide entry — 'out' starts zoomed by
     * `scale` and settles to rest (the classic title-photo effect).
     * `scale` is the far end of the zoom (e.g. 1.06), `duration` in seconds.
     */
    ken?: { dir?: 'drift' | 'out' | 'in'; scale?: number; duration?: number }
    /** continuous looping animation */
    loop?:
      | { type: 'dash-march'; distance?: number; duration?: number }
      | {
          /**
           * Generic looping effects. `duration` is ONE FULL CYCLE in seconds
           * (a spin: one revolution); `amount` sizes it — pulse: extra scale
           * (0.08 = +8%), float: px travelled up, blink: how far opacity dips
           * (0..1), wiggle: degrees either side, spin: degrees per revolution
           * (negative = counter-clockwise). `delay` postpones the first cycle.
           * Starts once the entrance (if any) has finished; spin and wiggle ADD
           * to the element's own rotation.
           */
          type: 'pulse' | 'spin' | 'float' | 'blink' | 'wiggle'
          duration?: number
          amount?: number
          delay?: number
          /** the point a spin / wiggle / pulse turns or grows around, on the
           *  element's own (unrotated) box. Default centre; `bottom` makes a
           *  wiggle sway like a stem in the wind. float/blink ignore it. */
          origin?: LoopOrigin
        }
      | {
          type: 'motion-path'
          path: string
          duration: number
          delay?: number
          /** easing over each lap (default 'none' = constant tempo) */
          ease?: string
          /** per-anchor speed multipliers (1 = normal, <1 dwells, >1 rushes);
           *  length matches the path's anchor count. Warps the arc-length map
           *  so the element can linger at some points and rush between others. */
          speeds?: number[]
          /** static output (PDF/print/static layer/preview) draws the route as a
           *  faint dotted line; default on, `false` opts out */
          trail?: boolean
        }
  }
  /** while presenting, clicking this element jumps to the slide with this id */
  link?: string
  /** semantic group tag — hover focus and multi-element behaviours target it */
  group?: string
  /**
   * Editor grouping: elements sharing a groupId select and move as one
   * (click any member → whole group; Alt-click digs to the individual).
   * Distinct from `group`, which carries presentation semantics.
   */
  groupId?: string
  /**
   * In-slide hover reveal: this element is only visible while an element
   * whose `group` equals this value is hovered (slide.hover type 'reveal').
   * The slide's hover.default set is shown when nothing is hovered.
   */
  showOnHover?: string
  /**
   * Layout role — what this element IS on the slide ('title', 'subtitle',
   * 'body', 'kicker', 'media'). Applying a different layout moves content
   * between same-role elements, PowerPoint-placeholder style. 'media' is
   * special-cased in `applyLayout`: it matches ANY unconsumed image/media/
   * chart/table donor (not just a same-type one) — a media placeholder means
   * "a picture/video/chart/table goes here," not "this exact element type" —
   * and the output adopts the donor's full type/content while keeping the
   * placeholder's id/frame/rotation/role (so morph lineage tracks the SLOT,
   * not whichever concrete element happened to fill it). Free-form string;
   * these five are the conventions the built-in layouts use.
   */
  role?: string
  /**
   * Where this element's colours came from, keyed by property path within the
   * element — `fill`, `shadow.color`, `fillGradient.stops.0.color`.
   *
   * The literal ALWAYS stays in place; this records the palette slot it was
   * derived from, so editing the palette can rewrite it. A reader that knows
   * nothing about this field sees an ordinary deck of ordinary colours, which
   * is exactly the point: it is additive, and property absence gains no new
   * meaning. See `palette.ts`.
   */
  themeRefs?: Record<string, string>
  /**
   * Container membership: this element is a child of the element whose id
   * is `parentId` (a container — see `ShapeElement.container`). Stays an
   * ordinary flat `slide.elements` entry, never nested inside the parent's
   * own data. `x/y/w/h` remain the single source of truth read by
   * render/morph/applyLayout/clipboard; `parentOffset` is only read by
   * `editor.syncContainers()` to re-derive them when the parent moves/
   * resizes. A dangling ref (parent deleted) is dropped and the child keeps
   * its last absolute position — see `slides/src/editor/CLAUDE.md`.
   */
  parentId?: string
  /** Position/size relative to the parent's box at the time of grouping,
   *  as fractions (0..1) of the parent's w/h. Only meaningful alongside
   *  `parentId`. */
  parentOffset?: { relX: number; relY: number; relW: number; relH: number }
}

export interface ShadowSpec {
  x?: number
  y?: number
  blur: number
  color: string
}

/** Defaults: `opacity` 0.35, `size` 0.5, `gap` 0. */
export interface ReflectionSpec {
  /** how strong the reflection is at its top edge, 0..1 */
  opacity?: number
  /** how much of the element is mirrored, as a fraction of its height, 0..1 */
  size?: number
  /** space between the element and its reflection, px */
  gap?: number
}

export interface TextElement extends ElementBase {
  type: 'text'
  /** Rich text as sanitized HTML — render.ts sanitizeHtml's allowlist:
   *  b/i/u/s/code/br/div/p, a colour/size span, http(s)/mailto links, lists. */
  html: string
  fontSize: number
  fontFamily: string
  fontWeight: number
  color: string
  /** When set (and stops non-empty), painted into the glyphs; wins over `color`. */
  colorGradient?: GradientFill
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  lineHeight: number
  /** px; optional tracking for letter-spaced caps labels */
  letterSpacing?: number
  /** Outline / hollow glyphs via -webkit-text-stroke. `fill:'none'` makes the
   *  interior transparent (the classic hollow section-break word); default keeps
   *  the solid `color` fill and just adds an outline. */
  textStroke?: { width: number; color: string; fill?: string }
  /**
   * Layout placeholder prompt ("Click to add title"). While the element's
   * html is empty: the editor shows this dimmed; present and print hide the
   * element entirely. Cleared content brings the prompt back.
   */
  placeholder?: string
  /**
   * This text is a piece of the deck's footer — PowerPoint's dt / sldNum /
   * ftr placeholders. Where it sits and how it looks stay with the element
   * (normally on a master); WHETHER it shows is decided by
   * `doc.headerFooter` and the slide's own `footer` switches (see
   * `footerHidden`). Absent = an ordinary text box, always shown.
   */
  footerRole?: FooterRole
}

/** The three footer pieces `doc.headerFooter` switches (PowerPoint's
 *  Header & Footer dialog). */
export type FooterRole = 'date' | 'slideNumber' | 'footer'
export const FOOTER_ROLES: readonly FooterRole[] = ['date', 'slideNumber', 'footer']

export interface CodeElement extends ElementBase {
  type: 'code'
  /** Subset of properties of TextElement. */
  fontSize: number
  fontFamily: string
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  lineHeight: number
  /** Determines the color of the code snippet prior to a themeId getting picked. */
  color: string
  /** The raw code snippets. */
  content: string
  /** The asset id of the grammar to use. */
  grammarAssetId?: string
  /** The name of the grammar */
  grammarName?: string
  /** The asset id of the theme to use. */
  themeAssetId?: string
  /** The name of the theme. */
  themeName?: string
}

export type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'line' | 'path'

/** Linear gradient fill. Colors are any CSS color, including rgba(). */
export interface GradientFill {
  /** degrees, CSS convention: 0 = bottom→top, 90 = left→right */
  angle: number
  /** ordered stops; `at` is 0..1 along the gradient line */
  stops: Array<{ at: number; color: string }>
}

/** Decoration at a line's tip. Sized relative to the stroke width. */
export type LineEnding = 'none' | 'arrow' | 'dot' | 'bar'

/**
 * Mirroring, for the element types whose content is a picture (shape, image,
 * svg). The FRAME stays put — selection, resize handles, rotation, morph and
 * animation all keep working on the unflipped box — and only the content is
 * mirrored about the frame's centre, before the frame's `rotation` applies
 * (the PowerPoint order). Shadows and reflections are not mirrored. Text,
 * tables, charts, code, embeds and media have no flip: glyphs, controls and
 * data must stay readable. Additive — older readers ignore both fields.
 */
export interface Flippable {
  flipH?: boolean
  flipV?: boolean
}

/**
 * A text alternative, for the element types whose content is a picture of
 * something (image, svg, chart, media). Rendered as `alt` on an <img> and as
 * `aria-label` (+ `role="img"` where the element is not itself a control)
 * on the others — in the editor, while presenting and in the saved no-JS
 * layer alike. The EMPTY string is meaningful, HTML-style: the picture is
 * decorative and says nothing (`alt=""` / `aria-hidden`), so the
 * accessibility check stays quiet about it. Absent = not described yet.
 * Additive and optional; no `requires` — an older reader keeps the key on
 * save (unknown keys ride along), see DECISIONS 2026-10-08.
 */
export interface Describable {
  alt?: string
}

/**
 * Where a piece of artwork came from and under what terms it may be used.
 * Stamped by the icon library when it inserts an icon (the source's name,
 * the file's URL, and whatever license the source declares) and editable in
 * the panel's "Source & license" section. Free text throughout, bounded by
 * `untrusted.ts`: `license` is an SPDX id ("CC0-1.0") or a plain phrase
 * ("Company-owned"). Absent = nothing known, which the validator never
 * reports on its own; PRESENT without a `license` is what `unlicensed-artwork`
 * flags. Called `provenance`, not `source`: a chart's `source` is its live
 * table link. Additive, no `requires`: an older reader keeps the field on save
 * (DECISIONS 2026-10-11 "asset provenance").
 */
export interface Provenance {
  /** the source it was found in, e.g. an icon server's name or a folder */
  origin?: string
  /** the file it was fetched from, when it has an address */
  url?: string
  author?: string
  license?: string
}

export interface Sourced {
  provenance?: Provenance
}

export interface ShapeElement extends ElementBase, Flippable, Sourced {
  type: 'shape'
  shape: ShapeKind
  fill: string
  /** when set, wins over `fill` (which is kept as the solid fallback) */
  fillGradient?: GradientFill
  stroke: string
  strokeWidth: number
  /** corner radius, rect only */
  radius: number
  /** dash length in px; 0/undefined = solid stroke (legacy — see strokeStyle) */
  strokeDash?: number
  /** stroke pattern; wins over strokeDash when set */
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  /** line and path shapes: stroke-linecap; undefined = implicit default (a
   *  line: round, or butt when dashed — see render.ts; a path: butt) */
  strokeCap?: 'round' | 'square' | 'butt'
  /** path shape only: stroke-linejoin; undefined = the SVG default (miter).
   *  Outline icons are drawn with round joins, and "Convert to objects"
   *  (svgconvert.ts) carries them over. Additive, no `requires`. */
  strokeJoin?: 'round' | 'bevel' | 'miter'
  /** path shape only: how overlapping or nested subpaths fill. Absent =
   *  nonzero (the SVG default). `evenodd` is what a donut or a glyph with a
   *  counter needs when its inner contour is wound the same way as the outer.
   *  Additive, no `requires`: an older reader keeps the field and fills the
   *  hole in. */
  fillRule?: 'evenodd'
  /** line shape only: tip decorations */
  lineStart?: LineEnding
  lineEnd?: LineEnding
  /** path only: SVG path data in the coordinate space given by pathBox */
  d?: string
  /** path only: [x, y, w, h] viewBox the path was authored in */
  pathBox?: [number, number, number, number]
  /**
   * Connector anchoring (line/path only): the start (`from`) and/or end (`to`)
   * of the shape follow another element. The geometry is DERIVED — the editor's
   * syncConnectors() recomputes the endpoint on that element's border toward the
   * other end whenever anything moves. A dangling ref (element deleted) is
   * dropped and the endpoint becomes free.
   */
  from?: ConnectorEnd
  to?: ConnectorEnd
  /** rect only: this shape is a container — a visible frame whose children
   *  are ordinary flat `slide.elements` with `parentId` pointing at it. See
   *  `ElementBase.parentId`. */
  container?: boolean
}

/** One anchored end of a connector. `side:'auto'` picks the nearest border. */
export interface ConnectorEnd {
  el: string
  side?: 'auto' | 'top' | 'right' | 'bottom' | 'left'
}

export interface ImageElement extends ElementBase, Flippable, Describable, Sourced {
  type: 'image'
  /** data: URI, or "asset:<key>" referencing doc.assets */
  src: string
  /** Ignored while `crop` is set: the cropped region always fills the frame. */
  fit: 'contain' | 'cover' | 'fill'
  radius: number
  /** Show only this region of the picture, stretched to fill the frame. */
  crop?: ImageCrop
}

/**
 * A crop rectangle in FRACTIONS of the natural (unflipped) picture: `x`/`y`
 * the top-left corner, `w`/`h` the size, all 0..1 with x+w ≤ 1 and y+h ≤ 1.
 * Fractions, not pixels, so it never needs the picture's natural size to
 * render and survives a "Replace image…" with a different resolution. The
 * editor keeps the frame's aspect equal to the region's, so nothing is
 * distorted unless the frame is later resized freely. Additive and optional
 * (no `requires`): an older reader keeps the field on save and only shows
 * the whole picture — the editor sets `fit:'cover'` when it crops, so that
 * fallback is a centred crop of the right shape. DECISIONS 2026-10-08.
 */
export interface ImageCrop {
  x: number
  y: number
  w: number
  h: number
}

/** Smallest crop side, as a fraction — keeps the inverse scale finite. */
export const MIN_CROP = 0.01

/**
 * Clamp a crop into the picture (0..1, at least MIN_CROP on each side) or
 * null when it is not a crop at all: missing, non-numeric, or the whole
 * picture (nothing would be cut). The renderer, the validator and the editor
 * all go through this, so they agree on what a stored crop means.
 */
export function normalizeCrop(c: Partial<ImageCrop> | null | undefined): ImageCrop | null {
  if (!c || typeof c !== 'object') return null
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const w = Math.min(Math.max(n(c.w, 1), MIN_CROP), 1)
  const h = Math.min(Math.max(n(c.h, 1), MIN_CROP), 1)
  const x = Math.min(Math.max(n(c.x, 0), 0), 1 - w)
  const y = Math.min(Math.max(n(c.y, 0), 0), 1 - h)
  const eps = 1e-4
  if (x < eps && y < eps && w > 1 - eps && h > 1 - eps) return null
  return { x, y, w, h }
}

/**
 * The crop that shows a picture cropped by `c` in a frame of aspect `toAspect`
 * (w/h) instead of `fromAspect` without stretching it. The region takes the
 * new shape at the SAME area of the picture (so the picture keeps its scale
 * relative to the frame): one axis narrows, the other widens into what the
 * author had cut away. Only when the picture has no room for that does the
 * region shrink (uniformly) to fit inside it. It stays where it sat in the
 * picture as a share of the cut-away margin on each axis (CSS
 * object-position: a centred region stays centred, one flush with an edge
 * stays flush). Without the shrink the re-fit is exactly reversible:
 * switching a slide A → B → A gives back the crop it started with, and
 * repeated layout switches never zoom in further (narrowing alone compounded
 * on every switch). `c` itself (normalized) when the aspects already match;
 * null when the region becomes the whole picture.
 */
export function refitCrop(c: ImageCrop, fromAspect: number, toAspect: number): ImageCrop | null {
  const crop = normalizeCrop(c)
  if (!crop || !(fromAspect > 0) || !(toAspect > 0) || Math.abs(toAspect / fromAspect - 1) < 1e-3) return crop
  const k = Math.sqrt(toAspect / fromAspect)
  let w = crop.w * k
  let h = crop.h / k
  const fit = Math.min(1, 1 / w, 1 / h) // no room: shrink to fit, shape kept
  w *= fit
  h *= fit
  // where in the cut-away margin the region sits, 0..1 (no margin: centred)
  const at = (pos: number, size: number) => (size < 1 - 1e-9 ? pos / (1 - size) : 0.5)
  const x = at(crop.x, crop.w) * (1 - w)
  const y = at(crop.y, crop.h) * (1 - h)
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6 // saved JSON stays short
  return normalizeCrop({ x: r6(x), y: r6(y), w: r6(w), h: r6(h) })
}

export interface SvgElement extends ElementBase, Flippable, Describable, Sourced {
  type: 'svg'
  /** key into doc.assets holding raw SVG markup (preferred: dedupes) */
  asset?: string
  /** raw inline SVG markup, used when asset is unset */
  markup?: string
  /**
   * CSS injected inside the svg — hover states, focus dims, and animations
   * live here and stay self-contained (svg <style> scopes to its svg).
   */
  css?: string
  /**
   * Named values the artwork reads as CSS custom properties (`vars.leaf` →
   * `var(--leaf)`): one drawing, a different state per slide. Paired svgs on a
   * morph blend numbers and colours between the two slides' values.
   * Validated by `svgVarValue` — a number or one plain token, never a url().
   */
  vars?: Record<string, string | number>
}

/** svg `vars` key: a bare CSS ident, written as `--<name>`. */
export const SVG_VAR_NAME = /^[a-zA-Z][a-zA-Z0-9-]{0,39}$/
/** one value token: a colour, a number with an optional unit, or a keyword */
const SVG_VAR_TOKEN =
  /^(?:#[0-9a-fA-F]{3,8}|-?(?:\d+\.?\d*|\.\d+)(?:px|%|deg|turn|s|ms|em|rem)?|(?:rgba?|hsla?)\([\d.,%\s/-]+\)|[a-zA-Z-]{1,32})$/
/**
 * The one gate for an svg var value — untrusted.ts (load/paste) and render.ts
 * (output) both use it. A token grammar, not a blacklist: no url(), no
 * quotes, no `;` or braces, so a value can neither fetch nor end its
 * declaration wherever the style is later serialized. undefined = drop.
 */
export function svgVarValue(v: unknown): string | number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s.length <= 64 && SVG_VAR_TOKEN.test(s) ? s : undefined
}

/**
 * Data chart rendered by ECharts. `option` is a PURE-JSON ECharts option
 * (template-string formatters only — never functions): static SVG snapshots
 * on the editor canvas/thumbnails/print, a live interactive instance
 * (tooltips, dataZoom) while presenting.
 */
export interface ChartElement extends ElementBase, Describable {
  type: 'chart'
  /** preset key the panel offers to re-seed from (bar/line/pie/scatter) */
  preset?: string
  option: Record<string, unknown>
  /** live data binding: xAxis labels + series values track this table element */
  source?: { tableId: string }
}

/**
 * One cell of a table. `html` is the same sanitized rich-text subset as text.
 *
 * Merged cells (2026-10-08, `requires: ['table-merge']`): the top-left cell of
 * a merged block carries `colspan`/`rowspan` (integers ≥ 2; absent = 1). The
 * cells it COVERS stay in the grid — every row keeps one cell per column, so
 * counting, indexing and an older reader's grid stay rectangular — but they
 * are ignored: not rendered, not edited, normally `{ html: '' }`. Covered is
 * DERIVED from the spans (`tablespans.ts tableLayout`), never stored, so the
 * two can never disagree. Overlapping or out-of-grid spans are clamped by
 * the same layout (first anchor in reading order wins).
 */
export interface TableCell {
  html: string
  align?: 'left' | 'center' | 'right'
  /** per-cell overrides (default from the table's style) */
  color?: string
  bg?: string
  bold?: boolean
  /** columns this cell spans (≥ 2; absent = 1) */
  colspan?: number
  /** rows this cell spans (≥ 2; absent = 1) */
  rowspan?: number
}

export interface TableRow {
  cells: TableCell[]
}

/** Table-wide look. Cohesion lives here; cells carry only overrides. */
export interface TableStyle {
  headerBg: string
  headerColor: string
  /** stripe colour for alternate body rows; absent = no zebra */
  zebra?: string
  borderColor: string
  borderWidth: number
  cellPadX: number
  cellPadY: number
  fontSize: number
  fontFamily?: string
  /** default body-cell text colour */
  color: string
  /** outer corner radius (px) */
  radius: number
}

/**
 * A data table rendered as a real HTML <table> (table-layout: fixed) by the
 * shared renderer — identical on the editor canvas, thumbnails, present and
 * print. Column widths are fractional weights, normalised at render. Morphs
 * as a box (position/size + style colours); cell CONTENT does not morph.
 */
export interface TableElement extends ElementBase {
  type: 'table'
  /** fractional column weights; length = column count */
  columns: Array<{ w: number }>
  rows: TableRow[]
  /** treat row 0 as a styled header row */
  header: boolean
  style: TableStyle
}

/**
 * Audio or video. Hybrid storage: `src` is a data: URI (embedded — travels
 * inside the .beeslides.html), an external URL / relative path (referenced — keeps
 * the file small but needs the network / a sibling file), or "asset:<key>".
 * The editor embeds small clips and warns above MEDIA_EMBED_BUDGET, offering a
 * URL instead. Autoplay only fires in PRESENT mode (never on the canvas or in
 * thumbnails).
 */
export interface MediaElement extends ElementBase, Describable {
  type: 'media'
  kind: 'video' | 'audio'
  src: string
  /** video only: a still shown before playback (data:/asset:/URL) */
  poster?: string
  /** video only: fit within the element box */
  fit?: 'contain' | 'cover' | 'fill'
  radius?: number
  autoplay?: boolean
  loop?: boolean
  muted?: boolean
  controls?: boolean
}

/**
 * Arbitrary author HTML/JS/canvas, run inside a SANDBOXED iframe — the one
 * escape hatch from the closed element set, for widgets a typed shape can't
 * express (a live canvas sketch, a small game, a third-party embed snippet).
 *
 * The sandbox is `allow-scripts` ONLY — no allow-same-origin, allow-forms,
 * allow-popups or allow-top-navigation — which gives the content a null/opaque
 * origin: it can run script and draw, but it cannot read this document's
 * cookies/localStorage/DOM, submit a form, navigate the parent, or open a
 * popup. Same isolation CodePen/Notion/Google Sites rely on for arbitrary
 * user HTML. Deliberately NOT a model field: a per-element `sandboxFlags`
 * would let a pasted/synced element ask for `allow-same-origin` alongside
 * `allow-scripts`, which hands sandboxed script read/write access to the
 * embedding document — see render.ts's `case 'embed'`, which hardcodes the
 * one safe value instead.
 */
export interface EmbedElement extends ElementBase {
  type: 'embed'
  /** a full HTML document (or a fragment) run inside the sandboxed iframe */
  html: string
}

/**
 * A typeset equation: raw LaTeX, rendered to MathML by Temml at render time
 * (math.ts) — the same engine `$…$` in a text box uses, as a box of its own
 * that sizes, aligns and morphs like any element.
 *
 * No `requires` name (DECISIONS 2026-10-09): an older reader keeps the
 * element when it saves (formats are additive) and draws an empty box, so
 * nothing is lost. The one caveat is pasting: an older build's clipboard
 * intake drops an element type it does not know.
 */
export interface MathElement extends ElementBase {
  type: 'math'
  /** raw LaTeX, without `$` delimiters and without any entity escaping */
  tex: string
  fontSize: number
  color: string
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  /** text style (`\textstyle`: smaller limits and fractions); absent = display style */
  inline?: boolean
}

/** What a zoom tile zooms into: one slide, or a whole section (by id). */
export type ZoomTarget = { slide: string } | { section: string }

/**
 * PowerPoint's Slide / Section / Summary Zoom: a live thumbnail tile of
 * another slide (or of a section's first slide). While presenting, clicking
 * the tile zooms the camera into it, plays the target range, and — unless
 * `returnToZoom` is false — zooms back out to this slide at the click it was
 * on. Pure positional data, like sections: `target` names a slide or section
 * id and everything else is derived (`zoomRange`, `zoomCover`).
 *
 * No `requires` entry (DECISIONS 2026-10-09): an older reader keeps the
 * element through load → edit → save and simply renders an empty box.
 */
export interface ZoomElement extends ElementBase {
  type: 'zoom'
  target: ZoomTarget
  /** slide targets only: 'slide' (default) plays just that slide; 'section'
   *  plays from it to the end of its section. A section target always plays
   *  its whole section. */
  range?: 'slide' | 'section'
  /** absent = true: after the range, zoom back out to this slide */
  returnToZoom?: boolean
  /** seconds the camera move takes (default `ZOOM_SECONDS`) */
  duration?: number
  /** frame around the tile; absent/0 width = no frame */
  stroke?: string
  strokeWidth?: number
  radius?: number
}

export type SlideElement =
  | TextElement | ShapeElement | ImageElement | SvgElement | ChartElement | TableElement | MediaElement | CodeElement
  | EmbedElement
  | MathElement
  | ZoomElement

/**
 * A review comment thread. Editor-only metadata: never rendered while
 * presenting or printing, but saved in the file so it travels with the
 * document when people pass it around.
 */
export interface Comment {
  id: string
  /** element the thread is anchored to; absent (or dangling) = the slide */
  elementId?: string
  /** point anchor in slide coordinates — used when no elementId is set */
  x?: number
  y?: number
  /**
   * With `x`,`y` AND `w`,`h` the comment is an **area** anchor (a dragged
   * rectangle, slide coordinates). Additive: old viewers ignore `w`/`h` and
   * show a point pin at x,y.
   */
  w?: number
  h?: number
  author: string
  text: string
  /** ISO datetime */
  at: string
  resolved?: boolean
  /**
   * Flagged for an AI agent to act on — set via an `@ai `/`/ai ` prefix when
   * writing the comment (the prefix is stripped from `text`), or toggled
   * later from the thread's footer. Additive: absent = not flagged, and old
   * files simply lack it. See `commentEntries`/`window.slidomingo.comments()`.
   */
  forAgent?: boolean
  /**
   * ISO time Claude marked this thread fixed — the change now waits for the
   * user's check (Accept / Reopen). Always set TOGETHER with `resolved: true`,
   * so old viewers show a plain resolved thread and agent queries for
   * `{resolved:false}` skip it. Additive.
   */
  agentDone?: string
  replies?: Array<{ id: string; author: string; text: string; at: string }>
}

/**
 * A named, collapsible group of contiguous slides (PowerPoint-style
 * "Sections"). Membership is DERIVED, never stored per slide: a section
 * "owns" every slide in `doc.slides` from `startSlideId` up to (but not
 * including) the next section's `startSlideId`, or the end of the deck. This
 * is deliberate — a per-slide `sectionId` tag would need every insert/
 * duplicate/paste/drag-reorder call site to actively maintain a contiguity
 * invariant the type system can't enforce (the same bug class as a
 * `layoutId`-cleanup gap once found in this codebase, where one delete path
 * scrubbed a cross-reference and a sibling path didn't). With a boundary
 * marker, ordinary insert/duplicate/paste/reorder need zero `doc.sections`
 * writes; only an actual boundary change (deleting a `startSlideId` slide,
 * deliberately moving a slide across a boundary) needs one.
 */
export interface Section {
  id: string
  name: string
  /** Id of the first slide in this section. See the interface doc above for
   *  how the rest of its membership is derived. */
  startSlideId: string
}

export interface Slide {
  id: string
  background: string
  transition: TransitionKind
  /** push/wipe/cover/split only: see `TransitionDir`. Additive. */
  transitionDir?: TransitionDir
  elements: SlideElement[]
  notes: string
  /** palette references for the slide's own colours — `background`. See palette.ts. */
  themeRefs?: Record<string, string>

  /** optional friendly name (link pickers, state badges); in an icon set,
   *  the icon's name and its exported file name */
  name?: string
  /** Icon sets only: what to search the icon by, and what it should show
   *  (the brief an agent draws it from). Additive. */
  icon?: { keywords?: string[]; prompt?: string }
  /**
   * "GIF" slide: instead of waiting for clicks, play the slide's click builds
   * by themselves — one every `every` seconds, hold `hold` seconds on the last,
   * then (with `loop`) start over from click 0. A slide with no builds just
   * replays its entrance. On such a slide → / ← leave the slide. Additive.
   */
  autoBuild?: { every: number; hold?: number; loop?: boolean }
  /** Kiosk: seconds this slide stays up before the show advances, overriding
   *  `doc.present.autoAdvance`. Additive. */
  advanceAfter?: number
  /**
   * Interactive state: this slide is a variant of the slide with the given
   * id. It is hidden from linear navigation — reachable only via element
   * links (and morphs smoothly when element ids are shared with its parent).
   * While on a state: ArrowLeft returns to the parent, ArrowRight continues
   * after the parent.
   */
  stateOf?: string
  /**
   * Live provenance: this slide was instantiated from `doc.layouts` entry
   * `layoutId` and stays linked to it — editing that layout (Slide Master
   * mode) re-applies it to every slide sharing this id in the same undo
   * step. Set only when the layout is a real `doc.layouts` entry, never for
   * a synthesized built-in (those have no persistent identity to link to).
   * Set by fresh instantiation from the layout picker and by "Change
   * layout…" onto a doc slide type (`relinkSlide`); "Change layout…" onto
   * a built-in clears it. Cleared by "Unlink from layout".
   */
  layoutId?: string
  /**
   * Meaningful only on entries living in `doc.layouts`: the `doc.layouts`
   * entry this one descends from in Parent mode. Forms a tree (at most one
   * parent; chains are allowed — a parent can itself have a parent). The
   * child's own `elements` are composited ON TOP of the full ancestor chain
   * at render time (see `effectiveLayout`) and are locked against direct
   * editing in the UI — editing only ever happens by opening the ancestor
   * itself. Absent = a root slide type (or an ordinary slide, where this
   * field is never set).
   */
  parentId?: string
  /**
   * Meaningful only on `doc.layouts` entries: this slide type exists to be
   * INHERITED from — a PowerPoint slide master — and is never offered as a
   * type for a slide of its own. The pickers (New slide, Change slide
   * type…, a template's panel), `defaultSlideType` and the agent's relink
   * skip it; the Layout Manager still lists and edits it, as the head of
   * its family. Absent = an ordinary, pickable slide type.
   */
  parentOnly?: true
  /**
   * Per-slide opt-out of footer pieces that `doc.headerFooter` shows deck-
   * wide ("don't show the date on this slide"). Only `false` means
   * anything; absent = follow the deck. Never touched by a resync, so it
   * survives every edit of the slide's type.
   */
  footer?: { date?: false; slideNumber?: false; footer?: false }
  /**
   * This slide type's own font choices — meaningful only on `doc.layouts`
   * entries. Nearest-wins down the `parentId` chain: unset falls up to the
   * nearest ancestor that sets one, then to `doc.theme`. See
   * `render.ts:resolveSlideFonts`. Body text stays on `fontFamily`;
   * `headingFamily` applies only to `role:'title'` elements (mirrors OOXML's
   * major/minor pair, same convention as `doc.theme.headingFamily`).
   */
  fontFamily?: string
  headingFamily?: string
  /**
   * What NEW objects look like on slides of this type — meaningful only on
   * `doc.layouts` entries. Partial at every level and nearest-wins per FIELD
   * down the `parentId` chain, then `doc.theme.styleDefaults`, then the
   * built-in look. Read only when an object is created (insert, draw, paste
   * without design); nothing already on a slide changes when it is edited.
   * See `resolveStyleDefaults`.
   */
  styleDefaults?: StyleDefaults
  /**
   * Hidden from the show: skipped by linear navigation, left out of PDF
   * export, and never chosen as the file's thumbnail — but still an ordinary
   * slide you can edit, and still reachable by an element `link`, which is
   * what makes it useful for backup and appendix material you jump to only
   * if asked.
   *
   * Distinct from `stateOf`: a state is a VARIANT OF another slide (← returns
   * to its parent, and it morphs with it). Hidden carries no such
   * relationship — it is simply out of the linear flow.
   *
   * EXTRAS: the contiguous run of hidden slides directly after a normal
   * slide N are N's extras (purely positional, no field — see `extrasOf`).
   * While presenting, X on N enters the run, → walks it, and stepping past
   * the last extra (or pressing X on one) moves on to N+1, so the show
   * continues forward (with N+1's transition). ← from the first extra returns
   * to N. The slide panel nests them under N.
   *
   * By default a hidden slide does not consume a page number either, so the
   * audience sees 1..N with no gaps; `doc.present.numberHidden` restores the
   * office-suite behaviour of counting it.
   */
  hidden?: boolean
  /**
   * Skip this slide's own page number while leaving it otherwise untouched —
   * still visible, navigable, and included in the PDF. Distinct from
   * `hidden`, which also pulls a slide out of linear flow/PDF/thumbnail;
   * this only affects `paginates`.
   */
  excludeFromNumbering?: boolean
  /**
   * present-mode hover behaviour:
   * - focus-group: dim every element outside the hovered element's group
   * - reveal: show the showOnHover set matching the hovered group
   *   (`default` names the set visible when nothing is hovered)
   */
  hover?: { type: 'focus-group' | 'reveal'; dim?: number; default?: string }
  /** review comment threads (editor-only; see Comment) */
  comments?: Comment[]
}

export interface SlidomingoDoc {
  format: typeof FORMAT
  version: number
  /**
   * Format features a reader must understand to write this document back
   * (see KNOWN_FEATURES / `unsupportedFeatures`). Absent on almost every
   * file: it lists only what this particular file uses. An older reader that
   * meets an unknown name opens the file read-only instead of saving it
   * without what it did not understand.
   */
  requires?: string[]
  /**
   * Stable per-document identity (uuid), minted at creation and preserved
   * for the document's whole life — the rendezvous key for future
   * sync / share / merge features. Never derived from content.
   */
  docId: string
  title: string
  /**
   * Optional document properties for template fields ({{author}}, {{company}},
   * {{subject}}, {{event}}) and general provenance. All optional → old files
   * simply lack it and every token resolves to empty. `title` stays top-level
   * (load-bearing) and remains the source of {{title}}.
   */
  meta?: {
    author?: string
    company?: string
    subject?: string
    event?: string
    keywords?: string
    /**
     * Custom document properties (PowerPoint's File ▸ Properties ▸ Custom),
     * each available in text as `{{prop:Name}}` — a classification line, a
     * project number. Names are matched exactly.
     */
    custom?: Record<string, string>
    /**
     * The language the document is written in (BCP-47: `de`, `en-GB`). Picks
     * the column of `doc.terms` that `{{term:Name}}` shows, and formats
     * `{{date}}`/`{{time}}` for everyone who opens the file. Absent = the
     * first of `terms.languages`, and dates follow the viewer. Not the UI
     * language: that stays the viewer's own (PLATFORM §8).
     */
    language?: string
  }
  /**
   * Translated terms, usually carried by a template: the small words its
   * chrome needs in each language it supports ("Page"/"Seite"). Text shows
   * one with `{{term:Name}}`, in `meta.language`. Additive: a reader without
   * it shows the raw token, nothing else changes.
   */
  terms?: {
    /** BCP-47 codes, in table order; the first is the fallback */
    languages: string[]
    entries: Array<{ name: string; text: Record<string, string> }>
  }
  /**
   * Header & footer, deck-wide (PowerPoint's Insert ▸ Header & Footer):
   * whether the text elements tagged with a `footerRole` show, what the
   * footer text says (`{{footer}}`), and whether the date is live or fixed.
   * Absent, or any piece absent = shown, so every existing file renders as
   * before. `hideOnTitle` leaves them off title slides (`isTitleSlideType`).
   */
  headerFooter?: {
    date?: { show?: boolean; fixed?: string }
    slideNumber?: { show?: boolean }
    footer?: { show?: boolean; text?: string }
    hideOnTitle?: boolean
  }
  /**
   * `'figure'` = a single-canvas paper figure (Figure mode): one slide, no
   * present mode, exported as vector PDF/SVG. `'iconset'` = an icon set: one
   * icon per slide on a square grid, exported as a folder of SVGs. Absent =
   * an ordinary deck. Additive: older readers open either as a plain deck.
   */
  kind?: 'figure' | 'iconset'
  /** An icon set's grid and the one style every icon in it is drawn in
   *  (`kind: 'iconset'`, one icon per slide). See `iconset.ts`. */
  iconset?: IconsetInfo
  /** A figure's physical page size (what `size` is at 96 dpi): shown in this
   *  unit and written into the PDF/SVG. `size` stays authoritative in px. */
  figure?: { unit: 'mm' | 'pt' | 'in'; width: number; height: number }
  /** slide coordinate space, px */
  size: { width: number; height: number }
  /**
   * The deck's layout grid (columns/rows inside outer margins), px in the
   * `size` space — a design property that travels with the deck or layout, so
   * agents and people place content by the same columns. Read it ONLY through
   * `layoutgrid.normalizeLayoutGrid`. Absent = none. Additive: older readers
   * keep it untouched. Whether it is SHOWN is a viewer preference.
   */
  layoutGrid?: LayoutGrid
  /** Guides at fixed slide px, deck-wide (`layoutgrid.normalizeGuides`). Additive. */
  guides?: Guides
  theme: {
    background: string
    color: string
    accent: string
    fontFamily: string
    /**
     * Heading face. Body text stays on `fontFamily`; this is the display face,
     * mirroring OOXML's major/minor pair. Absent = headings use `fontFamily`.
     */
    headingFamily?: string
    /**
     * The document's named brand slots, mirroring OOXML's colour scheme so an
     * importer maps 1:1. Elements point at these through `themeRefs`, and
     * editing a slot re-derives every literal that references it.
     *
     * `background`, `color` and `accent` above REMAIN the canonical values for
     * `bg1`, `tx1` and `accent1` — they are not superseded, so every existing
     * reader keeps working and a document with no palette still resolves those
     * three. `paletteOf()` is the only thing that should assemble this.
     */
    palette?: {
      bg2?: string; tx2?: string
      accent2?: string; accent3?: string; accent4?: string
      accent5?: string; accent6?: string
      hlink?: string; folHlink?: string
    }
    /** ordered series colours for new charts; derived from accent when absent */
    chartPalette?: string[]
    /** defaults for newly inserted tables; omitted decks keep the standard look */
    table?: Partial<TableStyle>
    /** deck-wide fallback for `Slide.styleDefaults`: what new shapes, lines
     *  and text look like on slides with no slide type, and on types that
     *  leave a field unset. See `resolveStyleDefaults`. */
    styleDefaults?: StyleDefaults
  }
  /** present-mode chrome; decks with built-in chrome can turn Reveal's off */
  present?: {
    /**
     * Count hidden slides in {{page}}/{{pages}} and the presenter's counter.
     *
     * Default (absent/false): they are skipped, matching interactive states —
     * one rule, "skipped means uncounted", and contiguous numbering falls out
     * of it. True restores what PowerPoint and Keynote do, where a hidden
     * slide keeps its number so the visible ones do not renumber as you toggle
     * slides in and out during rehearsal.
     */
    numberHidden?: boolean
    slideNumber?: boolean
    controls?: boolean
    progress?: boolean
    /**
     * Seconds a morph transition takes. Absent = 0.65, which is tuned for the
     * usual case: a title sliding, a shape growing, distances of hundreds of
     * pixels. Code token morphs move a single line-height — about 40px — and at
     * the default that reads as a blink rather than as travel, so a deck built
     * around them wants a slower beat. Clamped on read.
     */
    morphSeconds?: number
    /** Kiosk deck: seconds each slide stays up before the show moves on by
     *  itself (a click build counts as an advance). Absent/0 = manual.
     *  Any key or click restarts the countdown. `Slide.advanceAfter` overrides. */
    autoAdvance?: number
    /** Next on the last slide wraps to the first (a kiosk / loop-forever deck). */
    loop?: boolean
  }
  /** shared assets (raw SVG markup or data URIs), referenced by key */
  assets?: Record<string, string>
  /**
   * embedded fonts: each entry becomes an @font-face at boot, with the font
   * data living in assets (data: URI). Elements then use `family` normally.
   */
  fonts?: Array<{ family: string; asset: string; weight?: string; style?: string }>
  /**
   * Slide layouts: slide-shaped templates that live outside slides[] — this
   * is also where former "masters" live now. A slide type with no
   * `parentId` is a root (what used to be a separate `Master` entity); one
   * with a `parentId` descends from another `doc.layouts` entry, forming a
   * tree (see `Slide.parentId`, `ancestorChain`, `effectiveLayout`).
   * Instantiating a layout deep-copies its EFFECTIVE (chain-composited)
   * elements KEEPING their ids — slides born from the same layout share
   * ids, so their common chrome morphs across transitions and stays
   * traceable for a future re-apply merge. When absent, the editor offers
   * its built-in starter layouts.
   */
  layouts?: Slide[]
  /**
   * Migration-only: preserves a pre-hierarchy file's implicit "an orphan
   * slide with no `layoutId` falls back to `doc.masters[0]`'s font" behavior
   * byte-for-byte. Set once by `parseDoc`'s masters migration to the id of
   * what was `doc.masters[0]` (now a `doc.layouts` root entry with the same
   * id); read only by `render.ts:resolveSlideFonts`'s no-`layoutId` branch.
   * Never written by anything else — a fresh document has no reason to set
   * it, since it has no orphan-slide font-fallback expectation to preserve.
   */
  rootFontLayoutId?: string
  /**
   * Small reusable compound objects (icon+label figures, etc.) authored on
   * their own dedicated canvas in the Layout Manager's "Objects"
   * tab and inserted anywhere in the deck as an ordinary, independent copy
   * — there is no live link back here once inserted (see
   * `editor/reusableobjects.ts`). Slide-shaped for the same reason a
   * `doc.layouts` root entry is: every function that already writes through
   * `store.slide` (panel edits, insert tools) needs a real object to write
   * into. Only `elements` (and optionally `name`/`background`) are
   * meaningful here — `transition`/`notes`/`stateOf`/`layoutId` etc. are
   * inert leftovers from the shared `Slide` shape. Absent until the tab is
   * first used, same additive discipline as `layouts`.
   */
  reusableObjects?: Slide[]
  /**
   * Id into `doc.layouts` — the slide type offered when no explicit choice
   * is made. Doc-wide, not tree-scoped (nothing about "which slide type is
   * created by default" is inherently per-tree). Never read directly:
   * always through `defaultSlideType(doc)`, which validates and falls back,
   * the same discipline `doc.sections` already applies to `startSlideId`.
   */
  defaultLayoutId?: string
  /**
   * Named, collapsible slide groups (see `Section`). Absent = no sections =
   * every existing file. A `startSlideId` can dangle after a foreign edit
   * (an id that no longer names a live slide) — never index this array
   * directly; always read it through `sectionsInOrder`/`sectionOf`/
   * `sectionRange`, the ONE place staleness is handled.
   */
  sections?: Section[]
  /**
   * Template file (.dotx-style): every OPEN instantiates a fresh document —
   * parseDoc strips this flag and mints a new docId, so each person who opens
   * the template gets an independent deck with its own identity. An ordinary
   * open never writes back to it; a template changes only through an
   * explicit update (`mergeTemplateDesign`, the Layout Manager's "Update
   * template" in the desktop app) or in a desktop TEMPLATE WINDOW (Edit
   * Template: the file itself is bound, `parseTemplateForEditing` /
   * `templateFileDoc`, docs/DECISIONS.md 2026-09-28).
   */
  template?: boolean
  /**
   * Template identity (uuid), carried by TEMPLATE files only. Minted once by
   * `stampAsTemplate`, kept across updates and renames — decks created from
   * the template record it in `basedOn.templateId`. A legacy template has
   * none; its instances resolve it by filename (`basedOn.name`) until the
   * first update mints one.
   */
  templateId?: string
  /**
   * Template files only: whether `slides` are sample slides worth offering
   * ("Include N sample slides"). `false` = `slides` is a single placeholder
   * starter slide, kept only because a doc must have one. Absent = true.
   */
  templateSamples?: boolean
  /**
   * Decks only: the template this deck was started from. `templateId` when
   * the template had one, `name` = the template's filename-derived name at
   * creation time (the fallback key for legacy templates without an id).
   * Provenance only — nothing renders from it.
   */
  basedOn?: { templateId?: string; name?: string }
  /**
   * A read-only PLAYER file: boots straight into the presentation and never
   * shows the editor. Honor-system (the JSON is right there), but it makes a
   * hand-out copy present-only for everyone who doesn't go digging.
   */
  readonly?: boolean
  slides: Slide[]
  modified: string
}

let counter = 0
export const uid = (prefix = 'el') =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

export const MONOSPACE_FONT_STACK =
  "ui-monospace, 'SFMono-Regular', 'Berkeley Mono', 'Menlo', 'Consolas', monospace"

/**
 * An element's effective morph key: the `morphId` override when set, else its
 * own `id`. THE single definition — render.ts stamps it into `data-flip-id`,
 * present.ts pairs and looks up model frames by it, and the panel uses it for
 * collision checks. Computing it inline in more than one place is exactly how
 * issue #54 happened: present.ts's model map keyed by `id` while every lookup
 * passed a flip id, so any element carrying a `morphId` silently missed and
 * never morphed. Route every morph-key read through here.
 */
export function morphKey(el: Pick<ElementBase, 'id' | 'morphId'>): string {
  return el.morphId || el.id
}

/** True when a background reads as light (so it wants dark text on top). Accepts
 *  a #rrggbb hex; for a gradient/CSS string it samples the first hex it finds and
 *  falls back to "light" (the safe assumption for the model's dark default ink). */
export function isLightBg(bg: string): boolean {
  const hex = /#([0-9a-fA-F]{6})/.exec(bg || '')
  if (!hex) return true
  const n = parseInt(hex[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 // sRGB relative luminance
}

/** A text colour that stays legible on the given background — new text/tables use
 *  this so a fresh element is never invisible on a dark deck. */
export function readableInk(bg: string): string {
  return isLightBg(bg) ? '#1D1119' : '#FAF6F7'
}

export function defaultText(partial: Partial<TextElement> = {}): TextElement {
  return {
    id: uid('t'),
    type: 'text',
    x: 340, y: 300, w: 600, h: 120,
    rotation: 0, opacity: 1,
    html: 'Double-click to edit',
    fontSize: 32,
    fontFamily: FONT_STACK,
    fontWeight: 400,
    color: '#1D1119',
    align: 'center',
    valign: 'middle',
    lineHeight: 1.25,
    ...partial,
  }
}

// --- chart palette -----------------------------------------------------------
// New charts should wear the deck's colours, not a stock palette. A deck can
// declare theme.chartPalette; otherwise we synthesise a harmonious set from the
// single accent (accent + a cool structural counterpart, each with a light and
// deep tint) so any deck gets on-brand charts out of the box.

function hexToHsl(hex: string): [number, number, number] {
  const m = hex.replace('#', '')
  const r = parseInt(m.slice(0, 2), 16) / 255
  const g = parseInt(m.slice(2, 4), 16) / 255
  const b = parseInt(m.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0; const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return [h, s * 100, l * 100]
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const mm = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c } else { r = c; b = x }
  const to = (v: number) => Math.round((v + mm) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

export function deriveChartPalette(accent: string): string[] {
  let h: number, s: number, l: number
  try { [h, s, l] = hexToHsl(accent) } catch { return ['#5470c6', '#91cc75', '#fac858', '#ee6666'] }
  const coolH = h + 190
  return [
    accent,
    hslToHex(coolH, Math.max(20, s * 0.5), Math.min(56, Math.max(44, l))),        // cool counterpart
    hslToHex(h, s * 0.92, Math.min(84, l + 14)),                                  // accent light
    hslToHex(coolH, Math.max(16, s * 0.38), Math.min(74, l + 20)),               // cool light
    hslToHex(h, s, Math.max(28, l - 16)),                                         // accent deep
    hslToHex(coolH, Math.max(24, s * 0.55), Math.max(26, l - 6)),                // cool deep
  ]
}

// --- table → chart data extraction (shared by creation + live binding) -------

const stripCell = (html: string) =>
  html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, '').replace(/,/g, '').trim()

/** First column = x labels; each mostly-numeric column after = a data series. */
export function tableChartColumns(table: TableElement): { labels: string[]; cols: Array<{ name: string; data: number[]; isPct: boolean }> } {
  const bodyRows = table.header ? table.rows.slice(1) : table.rows
  const headerRow = table.header ? table.rows[0] : null
  const labels = bodyRows.map((r) => stripCell(r.cells[0]?.html ?? ''))
  const cols: Array<{ name: string; data: number[]; isPct: boolean }> = []
  for (let c = 1; c < table.columns.length; c++) {
    const raw = bodyRows.map((r) => r.cells[c]?.html ?? '')
    const parsed = raw.map((h) => parseFloat(stripCell(h)))
    if (parsed.filter((n) => !Number.isNaN(n)).length < Math.ceil(bodyRows.length / 2)) continue
    cols.push({
      name: headerRow ? stripCell(headerRow.cells[c]?.html ?? '') : '',
      data: parsed.map((n) => (Number.isNaN(n) ? 0 : n)),
      isPct: /%/.test(headerRow ? stripCell(headerRow.cells[c]?.html ?? '') : '') ||
        raw.filter((h) => /%/.test(h)).length >= Math.ceil(bodyRows.length / 2),
    })
  }
  return { labels, cols }
}

/**
 * Push a linked table's current values into a chart's option IN PLACE,
 * preserving the chart's styling/axis config (only xAxis labels + each series'
 * data change). Returns true if anything changed. Series map to numeric columns
 * by position; extra series/columns are left untouched.
 */
export function syncLinkedChart(chart: ChartElement, table: TableElement): boolean {
  const before = JSON.stringify(chart.option)
  const { labels, cols } = tableChartColumns(table)
  const opt = chart.option as { xAxis?: any; yAxis?: any; series?: any }
  // the categories live on yAxis when the bars are horizontal
  const catAxis = opt[catAxisKey(opt)]
  if (catAxis && !Array.isArray(catAxis) && typeof catAxis === 'object') catAxis.data = labels
  const series: any[] = Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : []
  series.forEach((s, i) => {
    if (!s || !cols[i]) return
    if (s.type === 'pie') s.data = labels.map((name, j) => ({ name, value: cols[i].data[j] ?? 0 }))
    else s.data = cols[i].data
  })
  return JSON.stringify(chart.option) !== before
}

export function chartColorsFor(theme: SlidomingoDoc['theme']): string[] {
  return theme.chartPalette?.length ? theme.chartPalette.slice() : deriveChartPalette(theme.accent)
}

/** Give a chart option the deck's palette unless it already sets explicit colours. */
export function applyChartPalette<T extends Record<string, unknown>>(option: T, theme: SlidomingoDoc['theme']): T {
  const cur = (option as { color?: unknown }).color
  if (!Array.isArray(cur) || cur.length === 0) (option as { color?: string[] }).color = chartColorsFor(theme)
  return option
}

export function defaultChart(option: Record<string, unknown>, partial: Partial<ChartElement> = {}): ChartElement {
  return {
    id: uid('c'),
    type: 'chart',
    x: 400, y: 190, w: 800, h: 520,
    rotation: 0, opacity: 1,
    preset: 'bar',
    option,
    ...partial,
  }
}

export function defaultCode(partial: Partial<CodeElement> = {}): CodeElement {
  return {
    id: uid('code'),
    type: 'code',
    x: 235, y: 95, w: 800, h: 520,
    rotation: 0, opacity: 1,
    fontSize: 32,
    fontFamily: MONOSPACE_FONT_STACK,
    color: '#1D1119',
    align: 'left',
    valign: 'middle',
    lineHeight: 1.25,
    content: 'Double-click to edit',
    ...partial,
  }
}

/** Starter content for a freshly inserted embed — proves script + canvas + a
 *  render loop all run, rather than opening on a blank box. */
const DEFAULT_EMBED_HTML = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0b0f14}</style>
<canvas id="c"></canvas>
<script>
const c = document.getElementById('c')
const ctx = c.getContext('2d')
function resize() { c.width = innerWidth; c.height = innerHeight }
function draw() {
  const t = performance.now() / 1000
  ctx.clearRect(0, 0, c.width, c.height)
  const r = Math.min(c.width, c.height) * 0.32
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 + t
    ctx.beginPath()
    ctx.arc(c.width / 2 + Math.cos(a) * r, c.height / 2 + Math.sin(a) * r, 6, 0, Math.PI * 2)
    ctx.fillStyle = '${BRAND.honeyOnLight}'
    ctx.fill()
  }
  requestAnimationFrame(draw)
}
addEventListener('resize', resize)
resize()
draw()
</script>
`

export function defaultEmbed(partial: Partial<EmbedElement> = {}): EmbedElement {
  return {
    id: uid('embed'),
    type: 'embed',
    x: 340, y: 160, w: 600, h: 400,
    rotation: 0, opacity: 1,
    html: DEFAULT_EMBED_HTML,
    ...partial,
  }
}

export function defaultMath(partial: Partial<MathElement> = {}): MathElement {
  return {
    id: uid('math'),
    type: 'math',
    x: 340, y: 270, w: 600, h: 180,
    rotation: 0, opacity: 1,
    tex: '',
    fontSize: 48,
    color: '#1D1119',
    align: 'center',
    valign: 'middle',
    ...partial,
  }
}

const DEFAULT_TABLE_STYLE: TableStyle = {
  headerBg: '#1D1119',
  headerColor: '#FFFFFF',
  zebra: 'rgba(29,17,25,0.05)',
  borderColor: 'rgba(29,17,25,0.14)',
  borderWidth: 1,
  cellPadX: 16,
  cellPadY: 11,
  fontSize: 18,
  color: '#1D1119',
  radius: 10,
}

/** Resolve a new table's style from built-in defaults and optional deck overrides. */
export function tableStyleFor(theme?: SlidomingoDoc['theme']): TableStyle {
  return { ...DEFAULT_TABLE_STYLE, ...(theme?.table ?? {}) }
}

export function defaultTable(
  partial: Partial<TableElement> = {},
  theme?: SlidomingoDoc['theme'],
): TableElement {
  const cell = (html: string): TableCell => ({ html })
  return {
    id: uid('tbl'),
    type: 'table',
    x: 240, y: 220, w: 800, h: 260,
    rotation: 0, opacity: 1,
    header: true,
    columns: [{ w: 1 }, { w: 1 }, { w: 1 }],
    rows: [
      { cells: [cell('Column A'), cell('Column B'), cell('Column C')] },
      { cells: [cell('Row 1'), cell('—'), cell('—')] },
      { cells: [cell('Row 2'), cell('—'), cell('—')] },
    ],
    style: tableStyleFor(theme),
    ...partial,
  }
}

/** The built-in look of a freshly inserted closed shape — what
 *  `resolveStyleDefaults` falls back to when no slide type and no deck
 *  default says otherwise. */
export const SHAPE_DEFAULT = { fill: '#FFFFFF', stroke: '#9E9E9E', strokeWidth: 2 } as const
/** Width of a freshly drawn line/curve/freeform when nothing sets one. */
export const LINE_DEFAULT_WIDTH = 3

// --- default styles per slide type ---------------------------------------------
// A slide type (and the deck) can say what NEW objects look like on its
// slides. Every level stores only the fields it sets; resolution fills the
// rest in from farther levels, one field at a time. Colours are literals with
// `themeRefs` beside them (keyed by field, same convention as elements — see
// palette.ts), so a default picked from the palette follows a re-brand.

/** The closed shape kinds a type can style individually. */
export type StyleShapeKind = 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'path'
export const STYLE_SHAPE_KINDS: readonly StyleShapeKind[] = ['rect', 'ellipse', 'triangle', 'arrow', 'path']

export interface ShapeStyle {
  fill?: string
  fillGradient?: GradientFill
  stroke?: string
  strokeWidth?: number
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  strokeDash?: number
  radius?: number
  opacity?: number
  shadow?: ShadowSpec
  themeRefs?: Record<string, string>
}

/** Lines, curves, connectors and freeform strokes. */
export interface LineStyle {
  color?: string
  width?: number
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  strokeCap?: 'round' | 'square' | 'butt'
  lineStart?: LineEnding
  lineEnd?: LineEnding
  themeRefs?: Record<string, string>
}

export interface TextStyle {
  /** '' = the slide type's own font (render.ts resolveFontFamily) */
  fontFamily?: string
  fontSize?: number
  fontWeight?: number
  color?: string
  lineHeight?: number
  align?: 'left' | 'center' | 'right'
  themeRefs?: Record<string, string>
}

export interface StyleDefaults {
  /** every closed shape */
  shape?: ShapeStyle
  /** one shape kind's own look; beats `shape` at the same level */
  shapes?: Partial<Record<StyleShapeKind, ShapeStyle>>
  /** line, curve, connector, freeform */
  line?: LineStyle
  text?: TextStyle
}

/** `'shape'` alone is the generic shape style (no per-kind override) — what
 *  the form's Shapes card shows. */
export type StyleKind = 'shape' | `shape:${StyleShapeKind}` | 'line' | 'text'

/** Where a resolved field came from — the form's "From: …" hint. */
export type StyleSource =
  | { kind: 'here'; generic?: boolean }
  | { kind: 'type'; layout: Slide; generic?: boolean }
  | { kind: 'deck'; generic?: boolean }
  /** the person's own default (a per-install UI profile, never the file) */
  | { kind: 'personal'; generic?: boolean }
  | { kind: 'builtin' }

export interface ResolvedStyle<T> {
  /** every field that resolved to something (built-ins included) */
  values: T
  /** palette refs of the colour fields that won, keyed by field */
  refs: Record<string, string>
  sourceOf(field: string): StyleSource
}

/** The chain of slide types governing new objects on `surface`, NEAREST
 *  first: the surface itself when it is a slide type (Layout Manager), else
 *  its `layoutId`'s chain. Empty for a slide with no type. */
export function styleChain(doc: SlidomingoDoc, surface: Slide): Slide[] {
  const governing = doc.layouts?.find((l) => l.id === surface.id)
    ?? (surface.layoutId ? doc.layouts?.find((l) => l.id === surface.layoutId) : undefined)
  return governing ? ancestorChain(doc, governing).reverse() : []
}

/** The style records `kind` reads at one level, most specific first. */
function levelRecords(sd: StyleDefaults | undefined, kind: StyleKind): Array<{ rec: Record<string, unknown>; generic: boolean }> {
  if (!sd) return []
  const out: Array<{ rec: Record<string, unknown>; generic: boolean }> = []
  if (kind === 'line') { if (sd.line) out.push({ rec: sd.line as Record<string, unknown>, generic: false }) }
  else if (kind === 'text') { if (sd.text) out.push({ rec: sd.text as Record<string, unknown>, generic: false }) }
  else {
    const own = kind === 'shape' ? undefined : sd.shapes?.[kind.slice(6) as StyleShapeKind]
    if (own) out.push({ rec: own as Record<string, unknown>, generic: false })
    if (sd.shape) out.push({ rec: sd.shape as Record<string, unknown>, generic: kind !== 'shape' })
  }
  return out
}

function builtinStyle(kind: StyleKind, background: string): Record<string, unknown> {
  if (kind === 'line') return { color: readableInk(background), width: LINE_DEFAULT_WIDTH }
  if (kind === 'text') {
    const t = defaultText()
    return { fontFamily: t.fontFamily, fontSize: t.fontSize, fontWeight: t.fontWeight, color: readableInk(background), lineHeight: t.lineHeight, align: t.align }
  }
  return { ...SHAPE_DEFAULT, radius: kind === 'shape:rect' || kind === 'shape' ? 12 : 0, opacity: 1 }
}

/**
 * What a NEW object of `kind` looks like on `surface` (a slide, or a slide
 * type open in the Layout Manager). Per field, nearest wins: each slide type
 * up the chain (a per-kind style before the generic shape style at the same
 * level), then `doc.theme.styleDefaults`, then the built-in look. A colour's
 * palette ref comes from the same record its value did, so it stays linked.
 */
export function resolveStyleDefaults<K extends StyleKind>(
  doc: SlidomingoDoc, surface: Slide, kind: K,
): ResolvedStyle<K extends 'line' ? LineStyle : K extends 'text' ? TextStyle : ShapeStyle> {
  const chain = styleChain(doc, surface)
  const levels: Array<{ src: StyleSource; records: ReturnType<typeof levelRecords> }> = []
  chain.forEach((layout, i) => {
    const records = levelRecords(layout.styleDefaults, kind)
    levels.push({ src: i === 0 && layout.id === surface.id ? { kind: 'here' } : { kind: 'type', layout }, records })
  })
  levels.push({ src: { kind: 'deck' }, records: levelRecords(doc.theme.styleDefaults, kind) })
  if (personalDefaults) levels.push({ src: { kind: 'personal' }, records: levelRecords(personalDefaults, kind) })

  const values: Record<string, unknown> = {}
  const refs: Record<string, string> = {}
  const sources: Record<string, StyleSource> = {}
  for (const { src, records } of levels) {
    for (const { rec, generic } of records) {
      const recRefs = (rec.themeRefs ?? {}) as Record<string, string>
      for (const [field, v] of Object.entries(rec)) {
        if (field === 'themeRefs' || v === undefined || field in values) continue
        values[field] = v
        sources[field] = { ...src, generic } as StyleSource
        // a field's refs are its own path and anything nested under it
        // (fillGradient.stops.0.color, shadow.color)
        for (const [path, token] of Object.entries(recRefs)) {
          if (path === field || path.startsWith(field + '.')) refs[path] = token
        }
      }
    }
  }
  for (const [field, v] of Object.entries(builtinStyle(kind, surface.background))) {
    if (field in values) continue
    values[field] = v
    sources[field] = { kind: 'builtin' }
  }
  return {
    values: values as never,
    refs,
    sourceOf: (field) => sources[field] ?? { kind: 'builtin' },
  }
}

/** Personal style defaults from the editor's per-install UI profile
 *  (editor/customize/apply.ts). Resolved BELOW the deck and every slide type —
 *  a document's own defaults always win — and read only when an object is
 *  created, like every other level; the profile itself never enters a file. */
let personalDefaults: StyleDefaults | null = null
export function setPersonalStyleDefaults(sd: StyleDefaults | null | undefined): void {
  personalDefaults = sd && Object.keys(sd).length ? sd : null
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
/** Whether `path` (a themeRefs key) points at a string on `obj`. */
const readRefTarget = (obj: unknown, path: string): boolean =>
  typeof path.split('.').reduce<any>((cur, seg) => (cur == null ? cur : cur[seg]), obj) === 'string'

/** Shadow presets offered by the panel and the default-styles form. */
export const SHADOW_PRESETS: Record<string, ShadowSpec> = {
  subtle: { y: 2, blur: 10, color: 'rgba(10,16,28,0.25)' },
  soft: { y: 10, blur: 28, color: 'rgba(10,16,28,0.32)' },
  elevated: { y: 24, blur: 56, color: 'rgba(8,12,22,0.45)' },
  glow: { blur: 40, color: 'rgba(255,238,214,0.55)' },
}

/** Reflection presets offered by the panel. */
export const REFLECTION_PRESETS: Record<string, ReflectionSpec> = {
  subtle: { opacity: 0.25, size: 0.3 },
  half: { opacity: 0.35, size: 0.5 },
  full: { opacity: 0.4, size: 1 },
}

/** Element fields for a new closed shape of `kind` on `surface`. */
export function shapeDefaultsFor(doc: SlidomingoDoc, surface: Slide, kind: StyleShapeKind): Partial<ShapeElement> {
  const r = resolveStyleDefaults(doc, surface, `shape:${kind}`)
  const v = r.values
  const out: Partial<ShapeElement> = {
    fill: v.fill, stroke: v.stroke, strokeWidth: v.strokeWidth, radius: v.radius, opacity: v.opacity,
  }
  if (v.fillGradient) out.fillGradient = clone(v.fillGradient)
  if (v.strokeStyle && v.strokeStyle !== 'solid') out.strokeStyle = v.strokeStyle
  if (v.strokeDash) out.strokeDash = v.strokeDash
  // an invisible shadow is how a type says "no shadow" over an inherited one
  if (v.shadow && isVisibleColor(v.shadow.color)) out.shadow = clone(v.shadow)
  const refs = Object.fromEntries(Object.entries(r.refs).filter(([path]) => readRefTarget(out, path)))
  if (Object.keys(refs).length) out.themeRefs = refs
  return out
}

/** Element fields for a new stroke: a `line` (painted with its fill) or an
 *  open `path` (curve/freeform, painted with its stroke). */
export function lineDefaultsFor(doc: SlidomingoDoc, surface: Slide, shape: 'line' | 'path'): Partial<ShapeElement> {
  const r = resolveStyleDefaults(doc, surface, 'line')
  const v = r.values
  const colorKey = shape === 'line' ? 'fill' : 'stroke'
  const out: Partial<ShapeElement> = shape === 'line'
    ? { fill: v.color, strokeWidth: v.width }
    : { fill: 'transparent', stroke: v.color, strokeWidth: v.width }
  if (v.strokeStyle && v.strokeStyle !== 'solid') out.strokeStyle = v.strokeStyle
  if (shape === 'line') {
    if (v.strokeCap && v.strokeCap !== 'round') out.strokeCap = v.strokeCap
    if (v.lineStart && v.lineStart !== 'none') out.lineStart = v.lineStart
    if (v.lineEnd && v.lineEnd !== 'none') out.lineEnd = v.lineEnd
  }
  if (r.refs.color) out.themeRefs = { [colorKey]: r.refs.color }
  return out
}

/** Element fields for a new text box on `surface`. */
export function textDefaultsFor(doc: SlidomingoDoc, surface: Slide): Partial<TextElement> {
  const r = resolveStyleDefaults(doc, surface, 'text')
  const v = r.values
  const out: Partial<TextElement> = {
    fontFamily: v.fontFamily, fontSize: v.fontSize, fontWeight: v.fontWeight,
    color: v.color, lineHeight: v.lineHeight, align: v.align,
  }
  if (r.refs.color) out.themeRefs = { color: r.refs.color }
  return out
}

/** The stroke a borderless shape gets when it is given a border colour or
 *  width — the governing style's, unless that one is itself invisible. */
export function strokeFallbackFor(doc: SlidomingoDoc, surface: Slide, s: ShapeElement): { stroke: string; strokeWidth: number } {
  const kind: StyleShapeKind = (STYLE_SHAPE_KINDS as readonly string[]).includes(s.shape) ? s.shape as StyleShapeKind : 'rect'
  const v = resolveStyleDefaults(doc, surface, `shape:${kind}`).values
  return {
    stroke: isVisibleColor(v.stroke) ? v.stroke! : SHAPE_DEFAULT.stroke,
    strokeWidth: (v.strokeWidth ?? 0) > 0 ? v.strokeWidth! : SHAPE_DEFAULT.strokeWidth,
  }
}

/** Whether a stroke colour paints anything: not empty/'transparent'/'none',
 *  and not an rgba()/#rrggbbaa at alpha 0. */
export function isVisibleColor(c: string | undefined): boolean {
  const v = (c ?? '').trim().toLowerCase()
  if (!v || v === 'transparent' || v === 'none') return false
  const rgba = /^rgba?\(([^)]+)\)$/.exec(v)
  if (rgba) {
    const parts = rgba[1].split(/[\s,/]+/).filter(Boolean)
    return parts.length < 4 || parseFloat(parts[3]) > 0
  }
  return !/^#[0-9a-f]{6}00$/.test(v) && !/^#[0-9a-f]{3}0$/.test(v)
}

/** Border colour and width only make a border TOGETHER, and a shape without
 *  one has neither — so picking a stroke colour on a width-0 shape used to
 *  change nothing on screen. Setting a visible colour brings the default
 *  width along; setting a width brings the default grey along. */
export function setShapeStroke(s: ShapeElement, color: string, fallback: { strokeWidth: number } = SHAPE_DEFAULT): void {
  s.stroke = color
  if (!(s.strokeWidth > 0) && isVisibleColor(color)) s.strokeWidth = fallback.strokeWidth
}

export function setShapeStrokeWidth(s: ShapeElement, width: number, fallback: { stroke: string } = SHAPE_DEFAULT): void {
  s.strokeWidth = Math.max(width, 0)
  if (s.strokeWidth > 0 && !isVisibleColor(s.stroke)) {
    s.stroke = fallback.stroke
    if (s.themeRefs) {
      delete s.themeRefs.stroke
      if (!Object.keys(s.themeRefs).length) delete s.themeRefs
    }
  }
}

export function defaultShape(shape: ShapeKind, partial: Partial<ShapeElement> = {}): ShapeElement {
  return {
    id: uid('s'),
    type: 'shape',
    shape,
    x: 490, y: 260, w: 300, h: 200,
    rotation: 0, opacity: 1,
    // white with a neutral grey border: a new shape is a plain box you
    // restyle, not a slab of accent colour (docs/DECISIONS.md, 2026-09-30)
    fill: SHAPE_DEFAULT.fill,
    stroke: SHAPE_DEFAULT.stroke,
    strokeWidth: SHAPE_DEFAULT.strokeWidth,
    radius: shape === 'rect' ? 12 : 0,
    ...partial,
  }
}

export function defaultImage(src: string, partial: Partial<ImageElement> = {}): ImageElement {
  return {
    id: uid('i'),
    type: 'image',
    x: 440, y: 210, w: 400, h: 300,
    rotation: 0, opacity: 1,
    src,
    fit: 'contain',
    radius: 0,
    ...partial,
  }
}

/** Park an embedded data URI in `doc.assets` and return an `asset:` ref.
 *
 *  Every embed goes through here so there is exactly ONE place binary content
 *  lives.
 *
 *  Identical bytes reuse the same key, so duplicating an image (or pasting the
 *  same photo twice) costs one copy in the file and one upload on the wire.
 *  A URL or an existing `asset:` ref passes straight through — only `data:`
 *  is interned. Callers MUST run this inside a `store.commit` so the assets
 *  write is part of the same undo step. */
export function internAsset(doc: SlidomingoDoc, src: string): string {
  if (!src.startsWith('data:')) return src
  const assets = (doc.assets ??= {})
  for (const k in assets) if (assets[k] === src) return `asset:${k}`
  const key = uid('a')
  assets[key] = src
  return `asset:${key}`
}

/** Soft ceiling for embedding media as a data URI (bytes). Above this the
 *  editor warns — a big embed makes the .beeslides.html slow to open and save. */
export const MEDIA_EMBED_BUDGET = 8 * 1024 * 1024 // 8 MB

/**
 * Hard ceiling for the static first-page preview every save writes into the
 * shell (src/preview.ts), in bytes of serialized markup.
 *
 * Unlike MEDIA_EMBED_BUDGET this is not a warning the author can wave through
 * — there is no author in the loop, it is spent silently on every ⌘S, and it
 * is spent on a THUMBNAIL. A text page costs 2–5 KB. The thing that can blow
 * up is a full-bleed photo, whose data URI would be duplicated: once in the
 * document, once in the preview.
 *
 * 64 KB is ~10% of the shipped shell (~640 KB compressed): invisible against a
 * file that size, and enough for a real page plus a logo or an icon-sized
 * image. Measured: the starter deck's page one costs 25 KB (2.6% of it). Over
 * it, preview.ts degrades — first dropping raster payloads, then falling back
 * to a title card — rather than growing the file.
 */
export const PREVIEW_BUDGET = 64 * 1024 // 64 KB

export function defaultMedia(
  kind: 'video' | 'audio',
  src: string,
  partial: Partial<MediaElement> = {},
): MediaElement {
  const audio = kind === 'audio'
  return {
    id: uid('m'),
    type: 'media',
    kind,
    x: 440, y: 210,
    w: audio ? 460 : 560, h: audio ? 56 : 315,
    rotation: 0, opacity: 1,
    src,
    fit: 'contain',
    radius: audio ? 12 : 8,
    controls: true,
    // video defaults muted so present-mode autoplay is permitted by browsers
    muted: !audio,
    loop: false,
    autoplay: false,
    ...partial,
  }
}

export function emptySlide(partial: Partial<Slide> = {}): Slide {
  return {
    id: uid('slide'),
    background: '#FFFFFF',
    transition: 'fade',
    elements: [],
    notes: '',
    ...partial,
  }
}

/** A fresh, empty `doc.reusableObjects` entry — background starts
 *  transparent (not white) since a reusable object is a figure meant to sit
 *  on top of whatever slide it's inserted into, not a slide of its own.
 *  `name` stays unset; callers display `obj.name ?? t('Untitled object')`,
 *  the same fallback idiom `doc.layouts` entries already use — model.ts
 *  itself never calls t() (see its module-level-const gotcha in CLAUDE.md). */
export function emptyReusableObject(): Slide {
  return {
    id: uid('object'),
    background: 'transparent',
    transition: 'fade',
    elements: [],
    notes: '',
  }
}

/** Generous fixed canvas for authoring a reusable object — big enough that
 *  panning past it rarely matters, deliberately not a truly unbounded/auto-
 *  growing stage (kept simple; see docs/DECISIONS.md). */
export const REUSABLE_OBJECT_CANVAS = { width: 3200, height: 2000 }

// ---------------------------------------------------------------------------
// Layouts. A layout is a Slide that lives in doc.layouts (or the built-in
// set below). Element ids are deterministic per layout and are KEPT when a
// layout is instantiated: slides born from the same layout share ids, so
// their common chrome morphs across transitions.

const ph = (
  id: string,
  placeholder: string,
  frame: { x: number; y: number; w: number; h: number },
  type: Partial<TextElement> = {},
): TextElement => ({
  id,
  type: 'text',
  ...frame,
  rotation: 0, opacity: 1,
  html: '',
  placeholder,
  fontSize: 32,
  fontFamily: FONT_STACK,
  fontWeight: 400,
  color: '#1D1119',
  align: 'left',
  valign: 'top',
  lineHeight: 1.25,
  ...type,
})

const bar = (id: string, frame: { x: number; y: number; w: number; h: number }): ShapeElement => ({
  id, type: 'shape', shape: 'rect', ...frame,
  rotation: 0, opacity: 1, fill: BRAND.honeyOnLight, stroke: 'transparent', strokeWidth: 0, radius: 2,
})

/** A `role:'media'` placeholder — a plain bordered box standing in for
 *  whatever image/video/chart/table the author drops in (see `applyLayout`'s
 *  media-role matching below). Dashed border reads as "this is a slot", not
 *  content. */
const mediaPh = (id: string, frame: { x: number; y: number; w: number; h: number }): ShapeElement => ({
  id, type: 'shape', shape: 'rect', ...frame,
  rotation: 0, opacity: 1, fill: '#F5EEF1', stroke: '#DCCCD3', strokeWidth: 1.5, strokeStyle: 'dashed',
  radius: 8, role: 'media',
})

/**
 * The canvas the built-in layout geometry below is authored against.
 *
 * It is NOT the model default (1280x720) — these layouts were drawn for a
 * 1600x900 stage, so on a default deck every one of them used to hang off the
 * right edge (`lt-title` ran to x=1440 on a 1280-wide slide) and the
 * title+content body overflowed the bottom by 88px. `builtinLayouts(size)`
 * scales them to the deck instead, which also makes them correct for the
 * custom page sizes the slide panel offers.
 */
const LAYOUT_BASE = { width: 1600, height: 900 }

/** Rescale a built-in layout from LAYOUT_BASE onto an arbitrary canvas. */
function scaleLayout(ly: Slide, sx: number, sy: number): Slide {
  // Type scales with the SMALLER axis: on a squarer canvas the limiting
  // dimension is what decides whether a heading still fits its box.
  const st = Math.min(sx, sy)
  return {
    ...ly,
    elements: ly.elements.map((el) => {
      const next = {
        ...el,
        x: Math.round(el.x * sx), y: Math.round(el.y * sy),
        w: Math.round(el.w * sx), h: Math.round(el.h * sy),
      } as SlideElement
      if (next.type === 'text') {
        const txt = next as TextElement
        if (txt.fontSize) txt.fontSize = Math.max(8, Math.round(txt.fontSize * st))
        if (txt.letterSpacing) txt.letterSpacing = Math.round(txt.letterSpacing * st * 10) / 10
      }
      return next
    }),
  }
}

/**
 * The layouts every document offers out of the box (not persisted until edited).
 * Pass the deck's page size to get geometry that fits it; omit it only when the
 * caller just wants the element ids.
 */
export function builtinLayouts(size?: { width: number; height: number }): Slide[] {
  const base: Slide[] = [
    {
      id: 'layout-title', name: 'Title', background: '#FFFFFF', transition: 'fade', notes: '', elements: [
        bar('lt-bar', { x: 160, y: 380, w: 72, h: 8 }),
        ph('lt-title', 'Click to add title', { x: 160, y: 404, w: 1280, h: 140 },
          { fontSize: 76, fontWeight: 700, valign: 'middle', role: 'title' }),
        ph('lt-sub', 'Click to add subtitle', { x: 160, y: 556, w: 1100, h: 60 },
          { fontSize: 28, color: '#5A4452', valign: 'middle', role: 'subtitle' }),
      ],
    },
    {
      id: 'layout-title-content', name: 'Title + content', background: '#FFFFFF', transition: 'fade', notes: '', elements: [
        ph('ltc-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 },
          { fontSize: 44, fontWeight: 700, valign: 'middle', role: 'title' }),
        bar('ltc-rule', { x: 120, y: 168, w: 1360, h: 3 }),
        ph('ltc-body', 'Click to add content', { x: 120, y: 208, w: 1360, h: 600 },
          { fontSize: 26, color: '#76606C', valign: 'top', lineHeight: 1.5, role: 'body' }),
      ],
    },
    {
      id: 'layout-two-col', name: 'Two columns', background: '#FFFFFF', transition: 'fade', notes: '', elements: [
        ph('l2c-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 },
          { fontSize: 44, fontWeight: 700, valign: 'middle', role: 'title' }),
        bar('l2c-rule', { x: 120, y: 168, w: 1360, h: 3 }),
        ph('l2c-left', 'Left column', { x: 120, y: 208, w: 660, h: 600 },
          { fontSize: 24, valign: 'top', lineHeight: 1.5, role: 'body' }),
        ph('l2c-right', 'Right column', { x: 820, y: 208, w: 660, h: 600 },
          { fontSize: 24, valign: 'top', lineHeight: 1.5, role: 'body' }),
      ],
    },
    {
      id: 'layout-comparison', name: 'Comparison', background: '#FFFFFF', transition: 'fade', notes: '', elements: [
        ph('lcmp-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 },
          { fontSize: 44, fontWeight: 700, valign: 'middle', role: 'title' }),
        bar('lcmp-rule', { x: 120, y: 168, w: 1360, h: 3 }),
        // Static, layout-owned labels — real content, not content
        // placeholders, so NO role: applying a different layout should never
        // move "Option A"/"Option B" into some other slide's title.
        {
          id: 'lcmp-label-a', type: 'text', x: 120, y: 208, w: 660, h: 44, rotation: 0, opacity: 1,
          html: 'Option A', fontSize: 20, fontFamily: FONT_STACK, fontWeight: 700, color: BRAND.honeyOnLight,
          align: 'left', valign: 'middle', lineHeight: 1.25,
        },
        {
          id: 'lcmp-label-b', type: 'text', x: 820, y: 208, w: 660, h: 44, rotation: 0, opacity: 1,
          html: 'Option B', fontSize: 20, fontFamily: FONT_STACK, fontWeight: 700, color: BRAND.honeyOnLight,
          align: 'left', valign: 'middle', lineHeight: 1.25,
        },
        ph('lcmp-left', 'Left column', { x: 120, y: 260, w: 660, h: 548 },
          { fontSize: 24, valign: 'top', lineHeight: 1.5, role: 'body' }),
        ph('lcmp-right', 'Right column', { x: 820, y: 260, w: 660, h: 548 },
          { fontSize: 24, valign: 'top', lineHeight: 1.5, role: 'body' }),
      ],
    },
    {
      id: 'layout-picture-caption', name: 'Picture with caption', background: '#FFFFFF', transition: 'fade', notes: '', elements: [
        ph('lpc-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 },
          { fontSize: 40, fontWeight: 700, valign: 'middle', role: 'title' }),
        mediaPh('lpc-media', { x: 120, y: 176, w: 1360, h: 560 }),
        ph('lpc-caption', 'Click to add a caption', { x: 120, y: 752, w: 1360, h: 60 },
          { fontSize: 20, color: '#76606C', align: 'center', valign: 'middle', role: 'body' }),
      ],
    },
    {
      id: 'layout-section', name: 'Section divider', background: '#1D1119', transition: 'fade', notes: '', elements: [
        bar('lsec-bar', { x: 160, y: 396, w: 72, h: 8 }),
        ph('lsec-title', 'Section title', { x: 160, y: 420, w: 1280, h: 120 },
          { fontSize: 64, fontWeight: 700, color: '#FFFFFF', valign: 'middle', role: 'title' }),
        ph('lsec-kicker', 'PART 1', { x: 160, y: 350, w: 800, h: 40 },
          { fontSize: 18, fontWeight: 600, color: BRAND.honeyOnLight, letterSpacing: 3, valign: 'middle', role: 'kicker' }),
      ],
    },
    { id: 'layout-blank', name: 'Blank', background: '#FFFFFF', transition: 'fade', notes: '', elements: [] },
  ]
  if (!size || (size.width === LAYOUT_BASE.width && size.height === LAYOUT_BASE.height)) return base
  const sx = size.width / LAYOUT_BASE.width
  const sy = size.height / LAYOUT_BASE.height
  return base.map((ly) => scaleLayout(ly, sx, sy))
}

/** A fresh slide from a layout — new slide id, element ids KEPT (lineage). */
export function instantiateLayout(layout: Slide): Slide {
  const copy: Slide = JSON.parse(JSON.stringify(layout))
  return { ...copy, id: uid('slide'), name: undefined, stateOf: undefined, notes: '' }
}

const textHasContent = (e: SlideElement) =>
  e.type !== 'text' || !!e.html.replace(/<br\s*\/?>/gi, '').replace(/\u200B/g, '').trim()

/** Concrete element types that satisfy a `role:'media'` placeholder — "a
 *  picture/video/chart/table goes here," not "this exact element type." */
const MEDIA_ROLE_TYPES = new Set<SlideElement['type']>(['image', 'media', 'chart', 'table'])

/** Real content sitting in a `role:'media'` slot (an empty placeholder is a
 *  'shape'), as `applyLayout` leaves it after a donor filled the slot. */
const isFilledMediaSlot = (e: SlideElement) => e.role === 'media' && MEDIA_ROLE_TYPES.has(e.type)

/**
 * Apply a layout to an existing slide's elements. The matching ladder:
 *   1. by id     — re-applying the slide's own layout resets frames/typography
 *                  while keeping content
 *   2. by role   — cross-layout: the slide's 'title' moves into the new
 *                  layout's 'title' frame (same element type + role required
 *                  on the donor; donors consumed in document order,
 *                  nearest-x wins when 2+ candidates tie)
 * Content (text html, link) rides along; the layout provides frame and
 * typography. `role:'media'` is special-cased: it matches ANY unconsumed
 * donor whose TYPE is image/media/chart/table, regardless of the donor's own
 * role (or lack of one) — a plain image someone dropped on the slide, never
 * having opened the Role select, still counts. When the donor's concrete
 * type differs from the placeholder's, the output ADOPTS the donor's full
 * type/content and keeps only the placeholder's id/frame/rotation/role (the
 * SLOT carries morph lineage across slides born from the same layout, not
 * whichever concrete element happened to fill it). Leftover slide elements
 * that belong to some KNOWN layout (old chrome, unfilled placeholders) are
 * dropped — except written text and a filled media slot, which are content
 * that merely carries a layout-owned id; everything else is user content.
 * Survivors are painted on top of the new layout's elements.
 *
 * `locked` = ids of chrome the slide INHERITS from an ancestor of its type
 * (`ancestorElementIds`) — never editable on a slide (canvas.ts locks it),
 * so the slide's copy can only ever be stale. Such a slot takes the
 * layout's content, not the donor's, unless it is a slot for content (a
 * `role` or a `placeholder`); a leftover with a locked id is dropped even
 * when it holds text. That is what makes a master's text edit, or its
 * deletion, reach every slide. Omitted = nothing locked (a one-shot apply).
 */
export function applyLayout(
  slide: Slide,
  layout: Slide,
  knownLayoutElementIds: Set<string>,
  locked?: ReadonlySet<string>,
): SlideElement[] {
  const { slots, leftovers } = matchLayout(slide, layout, knownLayoutElementIds, locked)
  const out: SlideElement[] = slots.map(({ slot: lel, donor: d }) => {
    const copy = JSON.parse(JSON.stringify(lel)) as SlideElement
    if (d && !isLockedChrome(lel, locked)) {
      if (lel.role === 'media' && d.type !== copy.type) {
        // Donor is a different concrete type than the placeholder (the
        // common case — mediaPh() placeholders are always 'shape'): adopt
        // the donor's full type/content, but keep the placeholder's
        // id/frame/rotation/role so the SLOT's identity (and morph lineage)
        // stays with the layout, not the donor.
        const { id, x, y, w, h, rotation, role } = copy
        const donorCopy = JSON.parse(JSON.stringify(d)) as SlideElement
        // a cropped picture always fills its frame: re-cut it to the slot's
        // shape, or the slot's aspect would stretch it
        if (donorCopy.type === 'image' && donorCopy.crop) {
          const crop = refitCrop(donorCopy.crop, d.w / d.h, w / h)
          if (crop) donorCopy.crop = crop
          else delete donorCopy.crop
        }
        return Object.assign(donorCopy, { id, x, y, w, h, rotation, role })
      }
      if (copy.type === 'text' && d.type === 'text' && textHasContent(d)) copy.html = d.html
      if (d.link) copy.link = d.link
    }
    return copy
  })
  out.push(...leftovers) // survive, painted above the layout (container children included)
  return out
}

/** `applyLayout`'s donor matching, without building any output: one entry
 *  per layout element (its `donor`, when a slide element fills it) plus the
 *  slide elements that survive unconsumed. Shared by `applyLayout` and
 *  `relinkPreview`, so the preview can never disagree with the real apply. */
export function matchLayout(
  slide: Slide,
  layout: Slide,
  knownLayoutElementIds: Set<string>,
  locked?: ReadonlySet<string>,
): { slots: Array<{ slot: SlideElement; donor?: SlideElement }>; leftovers: SlideElement[] } {
  // Container children (parentId set) are never independent role donors —
  // they move only as part of their container, never scattered into fresh
  // placeholder slots — so they're excluded from the donor pool outright.
  // They still ride along unchanged via the leftover pass below.
  const donors = slide.elements.filter((e) => !e.parentId)
  const consumed = new Set<SlideElement>()
  const findDonor = (lel: SlideElement): SlideElement | undefined => {
    const byId = donors.find((e) => !consumed.has(e) && e.id === lel.id)
    if (byId) return byId
    if (!lel.role) return undefined
    // 'media' matches by TYPE alone, regardless of the donor's own role (or
    // lack of one) — a media placeholder means "a picture/video/chart/table
    // goes here," and a plain image/chart/table someone dropped on the slide
    // is exactly that, whether or not they ever opened the Role select.
    // Every other role still requires the donor to carry the SAME role.
    const candidates = lel.role === 'media'
      ? donors.filter((e) => !consumed.has(e) && MEDIA_ROLE_TYPES.has(e.type))
      : donors.filter((e) => !consumed.has(e) && e.role === lel.role && e.type === lel.type && textHasContent(e))
    if (candidates.length <= 1) return candidates[0]
    // 2+ tied candidates (e.g. built-in "Two columns," both role:'body'):
    // pick by horizontal position, not array order — z-order edits
    // ("Bring to front"/"Send to back" mutate this same array) must never
    // silently swap which donor lands in which slot on a re-apply.
    return candidates.reduce((best, e) => (Math.abs(e.x - lel.x) < Math.abs(best.x - lel.x) ? e : best))
  }
  const slots = layout.elements.map((slot) => {
    const donor = findDonor(slot)
    if (donor) consumed.add(donor)
    return { slot, donor }
  })
  const leftovers: SlideElement[] = []
  for (const e of slide.elements) {
    if (consumed.has(e)) continue
    // inherited chrome that its ancestor no longer has: gone, text or not
    if (isLockedChrome(e, locked)) continue
    // layout-owned leftovers: drop chrome and EMPTY placeholders, but
    // content someone actually put there is never silently lost — it rides
    // along as-is. That is written text, and a FILLED media slot: the
    // picture/chart/table adopted the slot's (layout-owned) id when it
    // filled it, so without this it would read as stale chrome and vanish
    // on a move to a type with no media slot.
    if (knownLayoutElementIds.has(e.id) && !(e.type === 'text' && textHasContent(e)) && !isFilledMediaSlot(e)) continue
    leftovers.push(e)
  }
  return { slots, leftovers }
}

/**
 * The slide type `slide` follows, when `el` is the slide's copy of one of
 * that type's elements (same id somewhere in its effective chain) AND the
 * next resync rebuilds `el` from the type's copy — `applyLayout` takes the
 * slot from the layout and carries over only text html and `link`, so
 * anything else typed on the slide (alt text, …) is reset. Returns the
 * type in the chain that OWNS the element (an ancestor for inherited
 * chrome). A filled `role:'media'` slot is the exception: the picture
 * adopted the slot's id but keeps its own content. Undefined for a free
 * element, an unlinked slide or a dangling `layoutId`. Pure; the panel
 * uses it for a hint.
 */
export function resyncOwner(doc: SlidomingoDoc, slide: Slide, el: SlideElement): Slide | undefined {
  const layout = slide.layoutId ? doc.layouts?.find((l) => l.id === slide.layoutId) : undefined
  if (!layout) return undefined
  // nearest-first: the type in the chain that owns the element is where
  // its alt text has to be set (an inherited one lives on an ancestor)
  for (const owner of ancestorChain(doc, layout).reverse()) {
    const slot = owner.elements.find((e) => e.id === el.id)
    if (!slot) continue
    return slot.role === 'media' && slot.type !== el.type ? undefined : owner
  }
  return undefined
}

/** Inherited, never-on-the-slide-editable chrome: a locked id on an element
 *  that is not a slot for content (no `role`, no `placeholder` prompt). */
function isLockedChrome(e: SlideElement, locked?: ReadonlySet<string>): boolean {
  return !!locked?.has(e.id) && !e.role && !(e.type === 'text' && e.placeholder)
}

/** How well a slide fits another slide type — see `relinkPreview`. */
export interface RelinkPreview {
  /** the slide's elements after the relink (exactly what `relinkSlide` writes) */
  elements: SlideElement[]
  /** ids of the target's slots that receive the slide's content */
  filled: string[]
  /** slide content that was sitting in a slot (it has a role, or a
   *  layout-owned id) but finds none in the target — kept, painted on top
   *  of the new layout: the visual-collision case */
  floating: SlideElement[]
  /** free extras the user added (no role, not layout-owned) — they ride
   *  along on top under ANY slide type, so they never count against a fit */
  extras: SlideElement[]
  /** ids of the target's placeholders (role set) left unfilled — harmless */
  emptySlots: string[]
  /** 'fit' when nothing floats. There is no "lossy" level: `applyLayout`
   *  never drops written text or user content, the risk is purely visual. */
  verdict: 'fit' | 'partial'
}

/** Dry run of moving `slide` onto slide type `target` (a `doc.layouts`
 *  entry): the same `applyLayout` pass `relinkSlide` and every later resync
 *  run, through `target`'s `effectiveLayout`, with the donor↔slot pairs
 *  kept so the result can say what landed where. Mutates nothing. */
export function relinkPreview(doc: SlidomingoDoc, slide: Slide, target: Slide, known = layoutElementIds(doc)): RelinkPreview {
  const effective = effectiveLayout(doc, target)
  const locked = ancestorElementIds(doc, target)
  const { slots, leftovers } = matchLayout(slide, effective, known, locked)
  const floating: SlideElement[] = []
  const extras: SlideElement[] = []
  // Container children move with their container — count the container only.
  for (const e of leftovers) {
    if (e.parentId) continue
    if (e.role || known.has(e.id)) floating.push(e)
    else extras.push(e)
  }
  return {
    elements: applyLayout(slide, effective, known, locked),
    filled: slots.filter((s) => s.donor).map((s) => s.slot.id),
    floating,
    extras,
    emptySlots: slots.filter((s) => !s.donor && s.slot.role).map((s) => s.slot.id),
    verdict: floating.length ? 'partial' : 'fit',
  }
}

/** Re-apply `layout` (a `doc.layouts` entry) to `slide` through its
 *  effective chain, taking over everything a linked slide inherits —
 *  elements, background, the numbering opt-out. The one place both a
 *  resync and a relink do this, so the two can never drift. Inherited
 *  chrome follows its ancestor exactly (`applyLayout`'s `locked`);
 *  `retired` adds ids an ancestor has just deleted, so their copies go too.
 *  `slide.footer` is the slide's own and is never touched. */
function applyLinkedLayout(
  doc: SlidomingoDoc, slide: Slide, layout: Slide, known: Set<string>, retired?: ReadonlySet<string>,
): void {
  const effective = effectiveLayout(doc, layout)
  const locked = ancestorElementIds(doc, layout)
  if (retired) for (const id of retired) locked.add(id)
  slide.elements = applyLayout(slide, effective, known, locked)
  slide.background = effective.background
  if (effective.excludeFromNumbering) slide.excludeFromNumbering = true
  else delete slide.excludeFromNumbering
}

/** "Change slide type": make `slideId` FOLLOW `targetId` (a `doc.layouts`
 *  entry) from now on — sets `slide.layoutId` and re-applies the target in
 *  the same step, so the next edit of the OLD type no longer reaches it and
 *  the next resync of the new one is a no-op. Returns the preview it
 *  applied, or null when either id is unknown. Caller wraps in
 *  `store.commit`. */
export function relinkSlide(doc: SlidomingoDoc, slideId: string, targetId: string): RelinkPreview | null {
  const slide = doc.slides.find((s) => s.id === slideId)
  const target = doc.layouts?.find((l) => l.id === targetId)
  if (!slide || !target) return null
  const known = layoutElementIds(doc)
  const preview = relinkPreview(doc, slide, target, known)
  slide.layoutId = target.id
  applyLinkedLayout(doc, slide, target, known)
  return preview
}

/** Slides that follow `layoutId` ITSELF (`slide.layoutId === layoutId`) —
 *  the slide-type tree's leaves. Unlike `linkedSlides` this excludes
 *  slides of descendant types, and it skips `stateOf` variants (a state
 *  belongs with its parent slide, not in a list of its own). Deck order. */
export function directlyLinked(doc: SlidomingoDoc, layoutId: string): Slide[] {
  return doc.slides.filter((s) => !s.stateOf && s.layoutId === layoutId)
}

/** Slides following no slide type — never linked, unlinked, flattened on
 *  import, or pointing at a slide type that no longer exists. Skips
 *  `stateOf` variants, like `directlyLinked`. Deck order. */
export function unlinkedSlides(doc: SlidomingoDoc): Slide[] {
  const ids = new Set((doc.layouts ?? []).map((l) => l.id))
  return doc.slides.filter((s) => !s.stateOf && !(s.layoutId && ids.has(s.layoutId)))
}

/**
 * `layout`'s ancestor chain, ROOT-FIRST, `layout` itself LAST — walking
 * `parentId` up from `layout`. Cycle-safe: a `parentId` loop (only reachable
 * via a hand-edited or foreign file — the UI never lets you pick a
 * descendant as a parent) stops at the repeat instead of looping forever.
 */
export function ancestorChain(doc: SlidomingoDoc, layout: Slide): Slide[] {
  const chain: Slide[] = []
  const seen = new Set<string>()
  let cur: Slide | undefined = layout
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift(cur)
    cur = cur.parentId ? doc.layouts?.find((l) => l.id === cur!.parentId) : undefined
  }
  return chain
}

/** Direct children of `id` among `doc.layouts` (`layout.parentId === id`). */
export function childrenOf(doc: SlidomingoDoc, id: string): Slide[] {
  return (doc.layouts ?? []).filter((ly) => ly.parentId === id)
}

/**
 * `layout` with its FULL ancestor chain composited underneath (root's
 * elements first/behind, ending with `layout`'s own on top) — pure
 * read-time merge, does not duplicate `applyLayout`'s matching/z-order
 * logic, it just changes what gets passed in as the `layout` argument to
 * `instantiateLayout`/`applyLayout`/`renderThumbnail`. Same signature/
 * contract as before, so every existing call site needs zero changes — they
 * already treat this as an opaque flattened `Slide`. A chain of length 1
 * (no parent) returns `layout` unchanged, so a plain single-tier document
 * sees no behavior change.
 */
export function effectiveLayout(doc: SlidomingoDoc, layout: Slide): Slide {
  const chain = ancestorChain(doc, layout)
  if (chain.length <= 1) return layout
  return { ...layout, elements: chain.flatMap((l) => l.elements) }
}

/** ids of elements `layout` inherits from its ancestors (not its own) —
 *  used by canvas.ts's lockedIds() to keep inherited chrome non-selectable
 *  while editing a descendant (these get silently overwritten on the next
 *  resync anyway). Empty when `layout` has no parent. */
export function ancestorElementIds(doc: SlidomingoDoc, layout: Slide): Set<string> {
  const chain = ancestorChain(doc, layout)
  const ids = new Set<string>()
  for (const l of chain.slice(0, -1)) for (const e of l.elements) ids.add(e.id)
  return ids
}

/** Delete a doc layout AND clear every slide's live link to it — the shared
 *  cleanup both delete paths (a sub-editor's trash icon, the layout
 *  picker's ✕) must use, so a dangling `layoutId` never survives a deleted
 *  slide type. Also retargets `doc.defaultLayoutId` when it pointed at the
 *  deleted layout — the ONE place that marker is cleaned up, so it can
 *  never dangle regardless of which delete path fired.
 *
 *  Orphaning is free everywhere else in this format (element containers,
 *  connectors) — no cascade-delete. But a Parent-mode child starts EMPTY
 *  (see `createSlideTypeAsParentChild`), so a bare `delete child.parentId`
 *  would leave it visibly blank. Instead, bake the deleted node's effective
 *  content into each direct child before detaching it — this also
 *  correctly absorbs a deleted MIDDLE-of-chain node's contribution for
 *  every deeper descendant for free, since their own `ancestorChain` walk
 *  is just one tier shorter afterward and finds the same total elements one
 *  tier higher. Two sibling children of the same deleted parent end up
 *  sharing the same baked-in element ids — not a new hazard, the exact
 *  status quo today: every slide under one former master already shares
 *  that master's building-block ids across the whole family, deliberately,
 *  for cross-family morph continuity. */
export function removeLayout(doc: SlidomingoDoc, id: string): void {
  const removed = doc.layouts?.find((l) => l.id === id)
  if (removed) {
    for (const child of childrenOf(doc, id)) bakeInheritedInto(doc, child, removed)
  }
  doc.layouts = (doc.layouts ?? []).filter((l) => l.id !== id)
  if (!doc.layouts.length) delete doc.layouts
  for (const s of doc.slides) if (s.layoutId === id) delete s.layoutId
  if (doc.defaultLayoutId === id) {
    const fallback = doc.layouts?.[0]?.id
    if (fallback) doc.defaultLayoutId = fallback
    else delete doc.defaultLayoutId
  }
}

/** Copy `from`'s EFFECTIVE (chain-composited) elements underneath `child`'s
 *  own, then drop `child.parentId` — `child` keeps its exact look but no
 *  longer follows anything. The shared half of `removeLayout` (bake the
 *  deleted node into each direct child, `from` = the deleted node) and
 *  `detachSlideType` (`from` = the child's own parent). */
export function bakeInheritedInto(doc: SlidomingoDoc, child: Slide, from: Slide): void {
  const baked = effectiveLayout(doc, from).elements
  child.elements = [...(JSON.parse(JSON.stringify(baked)) as SlideElement[]), ...child.elements]
  delete child.parentId
}

/** "Detach from parent (keep look)" — `id` stops inheriting but renders
 *  exactly as before (its inherited chain is baked in as its own content),
 *  and becomes a root placed right after its former family's root; its own
 *  children stay with it. No-op for a root or an unknown id. Linked slides need no resync: their
 *  effective layout is unchanged by construction. Caller wraps in
 *  `store.commit`. */
export function detachSlideType(doc: SlidomingoDoc, id: string): void {
  const layout = doc.layouts?.find((l) => l.id === id)
  const parent = layout?.parentId ? doc.layouts?.find((l) => l.id === layout.parentId) : undefined
  if (!layout) return
  if (!parent) { delete layout.parentId; return }
  // Now a root: keep it next to the family it came from — just before the
  // root that follows its former top-level ancestor — rather than letting
  // it drift to wherever its array slot happens to sort among the roots.
  const family = ancestorChain(doc, parent)[0]
  const roots = (doc.layouts ?? []).filter((l) => !l.parentId || l.id === id)
  const nextRoot = roots.slice(roots.indexOf(family) + 1).find((l) => l.id !== id)
  bakeInheritedInto(doc, layout, parent)
  moveSlideTypeInTree(doc, id, undefined, nextRoot?.id)
}

/** True when `ancestorId` is `id` itself or anywhere up `id`'s `parentId`
 *  chain — the "would this move create a cycle?" test (dropping a type onto
 *  its own subtree). Cycle-safe via `ancestorChain`. */
export function isDescendantOf(doc: SlidomingoDoc, id: string, ancestorId: string): boolean {
  const layout = doc.layouts?.find((l) => l.id === id)
  if (!layout) return false
  return ancestorChain(doc, layout).some((l) => l.id === ancestorId)
}

/**
 * Move slide type `id` in the tree: make it a child of `newParentId` (or a
 * root when `undefined`) and place it just before sibling `beforeId` — or,
 * without one, right after the new parent's last existing child (after the
 * last root for a root move). Its own descendants follow automatically:
 * they link by `parentId`, not by array position. REPARENTING means
 * "inherit from the new parent" — the moved type's look changes at once;
 * `detachSlideType` is the keep-the-look alternative. Refused (returns
 * false, doc untouched) when `newParentId` is `id` or one of its
 * descendants (a cycle), or either id is unknown. Callers must resync the
 * moved subtree's linked slides (`resyncLinkedSlides`) — the editor's
 * `syncLayoutInstances` only watches the open surface. Caller wraps in
 * `store.commit`.
 */
export function moveSlideTypeInTree(
  doc: SlidomingoDoc, id: string, newParentId: string | undefined, beforeId?: string,
): boolean {
  const layouts = doc.layouts
  const moved = layouts?.find((l) => l.id === id)
  if (!layouts || !moved) return false
  if (newParentId !== undefined) {
    if (!layouts.some((l) => l.id === newParentId)) return false
    if (isDescendantOf(doc, newParentId, id)) return false
  }
  if (beforeId === id) beforeId = undefined
  const rest = layouts.filter((l) => l !== moved)
  if (newParentId === undefined) delete moved.parentId
  else moved.parentId = newParentId
  let at = beforeId ? rest.findIndex((l) => l.id === beforeId) : -1
  if (at < 0) {
    // after the last existing sibling under the new parent (or after the
    // parent itself when it has none yet), else at the very end
    let last = -1
    rest.forEach((l, i) => { if ((l.parentId ?? undefined) === newParentId) last = i })
    if (last < 0 && newParentId !== undefined) last = rest.findIndex((l) => l.id === newParentId)
    at = last < 0 ? rest.length : last + 1
  }
  rest.splice(at, 0, moved)
  doc.layouts = rest
  return true
}

/**
 * Re-apply every slide linked to `layoutId` or any of its descendants
 * (`linkedSlides`) through its OWN slide type's `effectiveLayout` — the
 * model half of editor.ts's `syncLayoutInstances`, which calls this for the
 * open surface; a tree move calls it explicitly for the moved subtree,
 * which is usually NOT the open surface. `known` is the "layout-owned
 * element ids" set `applyLayout` uses to retire stale chrome — normally
 * `layoutElementIds(doc)`; a reparent needs nothing extra, since the old
 * parent's elements still live in `doc.layouts`, so chrome inherited from
 * it is still recognised and dropped. `retiredIds` = element ids the edit
 * just deleted from `layoutId` — dropped from the slides that inherit them
 * (see `applyLinkedLayout`). Returns whether
 * any slide changed. Caller wraps in `store.commit`.
 */
export function resyncLinkedSlides(
  doc: SlidomingoDoc, layoutId: string, known: Set<string>, retiredIds?: ReadonlySet<string>,
): boolean {
  let changed = false
  for (const slide of linkedSlides(doc, layoutId)) {
    // Retired ids are inherited chrome only where `layoutId` is a STRICT
    // ancestor: on slides of `layoutId` itself they were the type's own
    // elements, and written text there is kept like any other.
    const retired = slide.layoutId !== layoutId ? retiredIds : undefined
    applyLinkedLayout(doc, slide, doc.layouts!.find((l) => l.id === slide.layoutId)!, known, retired)
    changed = true
  }
  return changed
}

/** `doc.layouts` in true depth-first display order — each parent directly
 *  followed by its whole subtree, siblings in array order — plus any
 *  entries unreachable from a root (a `parentId` cycle or a dangling
 *  parent) appended at depth 0 so they never silently vanish. Drives the
 *  Layout Manager's slide-type sidebar (editor/typetree.ts). */
export function slideTypeRows(doc: SlidomingoDoc): Array<{ layout: Slide; depth: number }> {
  const layouts = doc.layouts ?? []
  const ids = new Set(layouts.map((l) => l.id))
  const rows: Array<{ layout: Slide; depth: number }> = []
  const seen = new Set<string>()
  const walk = (parentId: string | undefined, depth: number) => {
    for (const l of layouts) {
      if ((l.parentId ?? undefined) !== parentId || seen.has(l.id)) continue
      seen.add(l.id)
      rows.push({ layout: l, depth })
      walk(l.id, depth + 1)
    }
  }
  walk(undefined, 0)
  // A dangling parentId (points at nothing) renders as a root in
  // effectiveLayout too, so give its subtree the same indentation.
  for (const l of layouts) {
    if (seen.has(l.id) || !l.parentId || ids.has(l.parentId)) continue
    seen.add(l.id)
    rows.push({ layout: l, depth: 0 })
    walk(l.id, 1)
  }
  for (const l of layouts) if (!seen.has(l.id)) { seen.add(l.id); rows.push({ layout: l, depth: 0 }) }
  return rows
}

/** Mint a brand-new, empty, independent slide type — no parent, no baked
 *  content. The pure mint-and-append half of "+ New slide type" → Blank.
 *  Caller wraps in `store.commit` for undo grouping and passes an
 *  already-localized, non-empty `name` (slide types require a real name,
 *  enforced by the creation dialog). */
export function createSlideTypeBlank(doc: SlidomingoDoc, name: string): Slide {
  const slide = emptySlide({ id: uid('layout'), name })
  doc.layouts = [...(doc.layouts ?? []), slide]
  return slide
}

/** Mint a new slide type that follows `parent` in Parent mode: it starts
 *  EMPTY with `parentId: parent.id` — its content IS the inherited chain
 *  (see `effectiveLayout`) until the author adds elements of its own on
 *  top. Starting non-empty would duplicate the parent's geometry into the
 *  child and defeat "editable only by opening the parent." Caller wraps in
 *  `store.commit` and passes an already-localized, non-empty `name`. */
export function createSlideTypeAsParentChild(doc: SlidomingoDoc, parent: Slide, name: string): Slide {
  const slide = emptySlide({ id: uid('layout'), name, parentId: parent.id })
  doc.layouts = [...(doc.layouts ?? []), slide]
  return slide
}

/**
 * Mint a new slide type that starts as a fully independent copy of
 * `source`'s EFFECTIVE (chain-composited) content — a Basis clone renders
 * identically to `source` at the moment of cloning, even though it has no
 * chain of its own (no `parentId` is set: "based on" here means "start
 * from," not "stay linked to"). Every element gets a fresh id via `remint`
 * — pass it the same serialize/parseClip/insertElements pipeline
 * `clipboard.ts` already uses for paste/library-import id remapping
 * (groupId/parentId/parentOffset included), rather than hand-rolling a
 * second remap implementation. This also fixes a latent bug in the old
 * clone path: today's clone silently shared element ids with its source.
 * Caller wraps in `store.commit` and passes an already-localized,
 * non-empty `name`.
 */
export function createSlideTypeAsBasis(
  doc: SlidomingoDoc,
  source: Slide,
  name: string,
  remint: (elements: SlideElement[]) => SlideElement[],
): Slide {
  const clone = { ...(JSON.parse(JSON.stringify(effectiveLayout(doc, source))) as Slide), id: uid('layout'), name }
  delete clone.stateOf
  delete clone.parentId
  clone.notes = ''
  clone.elements = remint(clone.elements)
  doc.layouts = [...(doc.layouts ?? []), clone]
  return clone
}

/** Mint a fresh, blank reusable object and append it to
 *  `doc.reusableObjects` — the pure mint-and-append half of "+ New
 *  reusable object." Caller wraps in `store.commit` for undo grouping. */
export function createReusableObject(doc: SlidomingoDoc): Slide {
  const obj = emptyReusableObject()
  doc.reusableObjects = [...(doc.reusableObjects ?? []), obj]
  return obj
}

/** Resolve an agent-supplied id (desktop/src/mcp/slides-mcp-server.mjs's
 *  `slideId` argument) to whichever `Slide[]` actually owns it — `doc.slides`
 *  first, then `doc.reusableObjects`, then `doc.layouts` — so every agent
 *  verb that edits "the slide with this id" works unmodified against a
 *  reusable object OR a slide type too, without a fallback duplicated at
 *  each call site. `doc.layouts` was added alongside the `create_slide_type`/
 *  `promote_to_reusable_object` MCP verbs (2026-09-20 redesign, part 4): a
 *  slide type's sub-editor is just another editing surface with the full
 *  insert toolbar (see `slides/src/CLAUDE.md`), so an agent addressing one
 *  by id should work the same way addressing a reusable object already did
 *  — this is a pure addition, every id that already resolved via
 *  `doc.slides`/`doc.reusableObjects` resolves exactly as before. Returns
 *  the owning array + index alongside the slide so a caller can
 *  splice/replace in place (`array[idx] = …`) generically. */
export function resolveAgentSlide(doc: SlidomingoDoc, id: string):
  { slide: Slide; array: Slide[]; idx: number } | null {
  let idx = doc.slides.findIndex((s) => s.id === id)
  if (idx >= 0) return { slide: doc.slides[idx], array: doc.slides, idx }
  const objects = doc.reusableObjects
  if (objects) {
    idx = objects.findIndex((s) => s.id === id)
    if (idx >= 0) return { slide: objects[idx], array: objects, idx }
  }
  const layouts = doc.layouts
  if (layouts) {
    idx = layouts.findIndex((l) => l.id === id)
    if (idx >= 0) return { slide: layouts[idx], array: layouts, idx }
  }
  return null
}

/** Every element id owned by any known layout (built-ins + the document's)
 *  — so deleting a layout element is safe for free: `applyLayout`'s
 *  existing "drop stale layout-owned leftovers" rule (below) retires stale
 *  baked copies on the next resync, the same zombie-element idiom already
 *  used for layout edits. */
export function layoutElementIds(doc: SlidomingoDoc): Set<string> {
  const ids = new Set<string>()
  for (const ly of [...builtinLayouts(), ...(doc.layouts ?? [])]) {
    for (const e of ly.elements) ids.add(e.id)
  }
  return ids
}

/** Slides that will live-resync when the given slide type (`layoutId`)
 *  next changes — the single source of truth for BOTH the actual resync in
 *  editor.ts's syncLayoutInstances AND any UI that claims to show "what
 *  this affects," so the two can never drift apart. A slide only ever
 *  resyncs via a live `slide.layoutId` link. Editing an ancestor resyncs every
 *  descendant's linked slides too — walking each candidate slide's own
 *  layout's `ancestorChain` covers arbitrary depth for free, so N-level
 *  resync needed no new logic beyond that walk. */
export function linkedSlides(doc: SlidomingoDoc, layoutId: string): Slide[] {
  return doc.slides.filter((slide) => {
    if (!slide.layoutId) return false
    const layout = doc.layouts?.find((l) => l.id === slide.layoutId)
    if (!layout) return false
    return ancestorChain(doc, layout).some((l) => l.id === layoutId)
  })
}

/**
 * The slide type used when a slide is created with no explicit choice — the
 * single source of truth for "always define one default slide type."
 * Resolves `doc.defaultLayoutId` against `doc.layouts`, falls back to
 * the first pickable `doc.layouts` entry (a `parentOnly` master is never a
 * slide's type), then to the first entry at all, then to the built-in
 * blank layout. Never read `doc.defaultLayoutId` directly — always
 * through here, so a dangling id (cleaned up by `removeLayout`, but
 * defensive here too) can never surface as a missing slide type.
 */
export function defaultSlideType(doc: SlidomingoDoc): Slide {
  const id = doc.defaultLayoutId
  const named = id ? doc.layouts?.find((l) => l.id === id && !l.parentOnly) : undefined
  return named ?? pickableSlideTypes(doc)[0] ?? doc.layouts?.[0] ?? builtinLayouts(doc.size).find((l) => l.id === 'layout-blank')!
}

/** `doc.layouts` minus the `parentOnly` masters — what a slide can be given
 *  as its type. Array order. */
export function pickableSlideTypes(doc: SlidomingoDoc): Slide[] {
  return (doc.layouts ?? []).filter((l) => !l.parentOnly)
}

/** A title slide, for `headerFooter.hideOnTitle` — PowerPoint's "Don't show
 *  on title slide" keys on a layout of type Title Slide, whose signature is
 *  a title and a subtitle with nothing to hold content. `slide` is a deck
 *  slide (judged by its type when it follows one) or a slide type itself. */
export function isTitleSlideType(doc: SlidomingoDoc, slide: Slide): boolean {
  const own = doc.layouts?.find((l) => l.id === slide.id)
    ?? (slide.layoutId ? doc.layouts?.find((l) => l.id === slide.layoutId) : undefined)
  const els = own ? effectiveLayout(doc, own).elements : slide.elements
  const roles = new Set(els.map((e) => e.role))
  return roles.has('title') && roles.has('subtitle') && !roles.has('body') && !roles.has('media')
}

/** The footer pieces that do NOT show on `slide`: switched off deck-wide
 *  (`doc.headerFooter`), on this slide (`slide.footer`), or — with
 *  `hideOnTitle` — because it is a title slide. `slide` may be a slide type
 *  surface: then only the deck-wide switches apply. Empty for every file
 *  without `headerFooter`/`footer`, which is every file before them. */
export function footerHidden(doc: SlidomingoDoc, slide: Slide): Set<FooterRole> {
  const off = new Set<FooterRole>()
  const hf = doc.headerFooter
  if (!hf && !slide.footer) return off
  for (const r of FOOTER_ROLES) if (hf?.[r]?.show === false || slide.footer?.[r] === false) off.add(r)
  if (hf?.hideOnTitle && off.size < FOOTER_ROLES.length && isTitleSlideType(doc, slide)) for (const r of FOOTER_ROLES) off.add(r)
  return off
}

/** An element's own font override, if it has one — text/code elements
 *  always carry a `fontFamily` (empty string = unset), tables carry an
 *  optional one on their `style`. `undefined` for element types with no
 *  font of their own. */
function elementFontFamily(el: SlideElement): string | undefined {
  if (el.type === 'text' || el.type === 'code') return el.fontFamily || undefined
  if (el.type === 'table') return el.style.fontFamily
  return undefined
}

// ---- Document language + translated terms --------------------------------

/** The language the document is written in: `meta.language`, else the first
 *  language its terms table offers, else none (dates follow the viewer). */
export function docLanguage(doc: SlidomingoDoc): string | undefined {
  return doc.meta?.language || doc.terms?.languages[0] || undefined
}

/** What `{{term:name}}` shows: the entry's text in the document language,
 *  else in the table's first language, else the term's name — a missing
 *  translation reads as the word it stands for, never as a blank. */
export function termText(doc: SlidomingoDoc, name: string, lang = docLanguage(doc)): string {
  const entry = doc.terms?.entries.find((e) => e.name === name)
  if (!entry) return name
  return (lang && entry.text[lang]) || entry.text[doc.terms!.languages[0]] || name
}

/** `base` with `incoming`'s terms laid over it: an incoming entry replaces
 *  the one of the same name (its translations merged in), new entries and
 *  languages are appended, `base`'s own extras stay. */
export function mergeTerms(base: SlidomingoDoc['terms'], incoming: NonNullable<SlidomingoDoc['terms']>): NonNullable<SlidomingoDoc['terms']> {
  const out = { languages: [...(base?.languages ?? [])], entries: (base?.entries ?? []).map((e) => ({ name: e.name, text: { ...e.text } })) }
  for (const l of incoming.languages) if (!out.languages.includes(l)) out.languages.push(l)
  for (const e of incoming.entries) {
    const mine = out.entries.find((x) => x.name === e.name)
    if (mine) Object.assign(mine.text, e.text)
    else out.entries.push({ name: e.name, text: { ...e.text } })
  }
  return out
}

/** "Make translatable": the term for `text`, created if needed — an entry
 *  whose first-language text already IS `text` is reused (two footers saying
 *  "Page" share one term). A new one is named after the text and starts with
 *  it in the table's first language (`lang` when the table has none yet).
 *  Mutates `doc`; returns the name for `{{term:…}}`. */
export function ensureTerm(doc: SlidomingoDoc, text: string, lang: string): string {
  const word = text.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
  const terms = (doc.terms ??= { languages: [], entries: [] })
  if (!terms.languages.length) terms.languages.push(lang)
  const first = terms.languages[0]
  const same = terms.entries.find((e) => e.text[first] === word)
  if (same) return same.name
  const base = word.length > 40 ? word.slice(0, 40).trim() : word
  let name = base
  for (let i = 2; terms.entries.some((e) => e.name === name); i++) name = `${base} ${i}`
  terms.entries.push({ name, text: { [first]: word } })
  return name
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Rename a term everywhere text names it (`{{term:old}}` → `{{term:next}}`,
 *  in slides, slide types and reusable objects), so renaming it in the table
 *  never orphans a footer. Returns how many strings changed. */
export function renameTermRefs(doc: SlidomingoDoc, old: string, next: string): number {
  const re = new RegExp(`\\{\\{\\s*term:\\s*${escapeRe(old)}\\s*\\}\\}`, 'gi')
  const token = `{{term:${next}}}`
  let n = 0
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      for (const k of Object.keys(o)) {
        const s = o[k]
        if (typeof s === 'string') {
          if (s.indexOf('{{') < 0) continue
          const r = s.replace(re, token)
          if (r !== s) { o[k] = r; n++ }
        } else walk(s)
      }
    }
  }
  walk(doc.slides)
  walk(doc.layouts)
  walk(doc.reusableObjects)
  return n
}

/**
 * Every distinct font family referenced ANYWHERE in the document — the
 * document theme, every slide type's own `fontFamily`/`headingFamily` at
 * every tier, every element's own font override (in layouts and real
 * slides), and every `doc.fonts[]` embedded family — each flagged whether
 * it's backed by an embedded `@font-face` asset. A pure DERIVED read, not a
 * stored field (same precedent as `sectionsInOrder`/`linkedSlides`/
 * `commentEntries`): nothing to keep in sync, nothing that can drift —
 * introducing a font anywhere makes it show up here on the next render,
 * with no separate "register" step. Deliberately NOT folded into
 * `doc.fonts[]` itself, which specifically means "embedded font asset →
 * `@font-face`"; overloading it with plain system/theme font names (no
 * asset) would blur a field whose name already means something specific.
 */
export function fontsInUse(doc: SlidomingoDoc): Array<{ family: string; embedded: boolean }> {
  const embedded = new Set((doc.fonts ?? []).map((f) => f.family))
  const families = new Set<string>(embedded)
  const add = (f?: string) => { if (f) families.add(f) }
  add(doc.theme.fontFamily)
  add(doc.theme.headingFamily)
  for (const ly of doc.layouts ?? []) {
    add(ly.fontFamily)
    add(ly.headingFamily)
    for (const el of ly.elements) add(elementFontFamily(el))
  }
  for (const s of doc.slides) for (const el of s.elements) add(elementFontFamily(el))
  return [...families].sort().map((family) => ({ family, embedded: embedded.has(family) }))
}

/**
 * Does this slide consume a page number?
 *
 * The single answer to that question — page fields, the presenter's counter,
 * the sidebar — so they cannot disagree about which slide is "4". Interactive
 * states never count; hidden slides count only when the deck opts into
 * office-suite numbering.
 */
export const paginates = (s: Slide, doc: SlidomingoDoc): boolean =>
  !s.stateOf && !s.excludeFromNumbering && (!s.hidden || !!doc.present?.numberHidden)

/**
 * Is this slide part of the linear walk?
 *
 * Deliberately NOT the same question as `paginates`. Navigation, PDF export and
 * the file thumbnail all skip states and hidden slides unconditionally; only
 * NUMBERING is configurable. Collapsing the two would make `numberHidden` walk
 * the audience into a slide that was hidden on purpose.
 */
/**
 * Defaults of the generic loops (`fx.loop` pulse/spin/float/blink/wiggle):
 * `cycle` = seconds for one full cycle, `amount` as documented on the type.
 * One table so the runtime and the panel show the same numbers.
 */
export type LoopOrigin = 'center' | 'top' | 'bottom' | 'left' | 'right'
/** `fx.loop.origin` → fractions of the element's box (x, y) */
export const LOOP_ORIGINS: Record<LoopOrigin, [number, number]> = {
  center: [0.5, 0.5], top: [0.5, 0], bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5],
}
export const LOOP_DEFAULTS = {
  pulse: { cycle: 1.6, amount: 0.08 },
  spin: { cycle: 8, amount: 360 },
  float: { cycle: 3, amount: 10 },
  blink: { cycle: 1.2, amount: 0.7 },
  wiggle: { cycle: 0.9, amount: 4 },
} as const
export const inLinearFlow = (s: Slide): boolean => !s.stateOf && !s.hidden

// ---------------------------------------------------------------------------
// Extra slides — hidden slides directly after a normal slide N are N's
// "extras" (backup / deep-dive material). Purely positional: no stored field,
// derived from slide order exactly like sections. While presenting, X on N
// enters them, → walks them and moves on to N+1 after the last one.

/** Index of the slide `i` is an interactive state of, or -1 (not a state, or
 *  its parent is gone). */
const stateParent = (doc: SlidomingoDoc, i: number): number => {
  const pid = doc.slides[i]?.stateOf
  return pid ? doc.slides.findIndex((s) => s.id === pid) : -1
}

/** Is slide `i` an extra candidate (hidden, not a state)? */
const isHiddenNonState = (doc: SlidomingoDoc, i: number): boolean => {
  const s = doc.slides[i]
  return !!s && !!s.hidden && !s.stateOf
}

/**
 * The normal-flow slide a hidden slide is an extra of, or -1 — for slides
 * that are not hidden, are states, or have no normal slide before them
 * (hidden slides at the very start of the deck are reachable only by link).
 */
export function extraParent(doc: SlidomingoDoc, i: number): number {
  if (!isHiddenNonState(doc, i)) return -1
  for (let j = i - 1; j >= 0; j--) if (inLinearFlow(doc.slides[j])) return j
  return -1
}

/** Indices of the extras of slide `i`: the hidden, non-state slides after the
 *  normal slide `i` and before the next normal one (states in between are
 *  skipped). Empty when `i` is not itself a normal-flow slide. */
export function extrasOf(doc: SlidomingoDoc, i: number): number[] {
  const s = doc.slides[i]
  if (!s || !inLinearFlow(s)) return []
  const out: number[] = []
  for (let j = i + 1; j < doc.slides.length; j++) {
    if (inLinearFlow(doc.slides[j])) break
    if (isHiddenNonState(doc, j)) out.push(j)
  }
  return out
}

/** The slide a state belongs to, else the slide itself. */
const navAnchor = (doc: SlidomingoDoc, i: number): number => {
  const p = stateParent(doc, i)
  return p >= 0 ? p : i
}

const scanFlow = (doc: SlidomingoDoc, from: number, step: 1 | -1): number => {
  for (let i = from; i >= 0 && i < doc.slides.length; i += step) if (inLinearFlow(doc.slides[i])) return i
  return -1
}

/** Where leaving the extras of normal slide `p` lands: the next normal slide
 *  (N+1), or `p` itself when the run is an appendix at the end of the deck,
 *  so leaving never strands the presenter. */
const leaveExtras = (doc: SlidomingoDoc, p: number): number => {
  const n = scanFlow(doc, p + 1, 1)
  return n >= 0 ? n : p
}

/**
 * Where → goes while presenting, or -1 when nowhere. On a state it acts from
 * the state's parent; on an extra it walks the run and moves on to the next
 * normal slide after the last one (the parent, for an appendix run at the
 * end); otherwise it continues the normal flow, skipping hidden slides and
 * states.
 */
export function presentNext(doc: SlidomingoDoc, cur: number): number {
  const a = navAnchor(doc, cur)
  const p = extraParent(doc, a)
  if (p >= 0) {
    const run = extrasOf(doc, p)
    const k = run.indexOf(a)
    return k + 1 < run.length ? run[k + 1] : leaveExtras(doc, p)
  }
  return scanFlow(doc, a + 1, 1)
}

/**
 * Where ← goes while presenting, or -1. A state goes to its parent; an extra
 * goes to the previous extra, or to its parent from the first; otherwise the
 * previous normal slide.
 */
export function presentPrev(doc: SlidomingoDoc, cur: number): number {
  const sp = stateParent(doc, cur)
  if (sp >= 0) return sp
  const p = extraParent(doc, cur)
  if (p >= 0) {
    const run = extrasOf(doc, p)
    const k = run.indexOf(cur)
    return k > 0 ? run[k - 1] : p
  }
  return scanFlow(doc, cur - 1, -1)
}

/**
 * Where X goes while presenting, or -1 for "do nothing": from a normal slide
 * to its first extra; from an extra (or a state of one) forward to the next
 * normal slide (the parent, for an appendix run at the end).
 */
export function presentToggleExtras(doc: SlidomingoDoc, cur: number): number {
  const a = navAnchor(doc, cur)
  const p = extraParent(doc, a)
  if (p >= 0) return leaveExtras(doc, p)
  if (a === cur && inLinearFlow(doc.slides[cur])) return extrasOf(doc, cur)[0] ?? -1
  return -1
}

/**
 * The slide a presenter means by typing `n` + Enter, or -1. `n` is the number
 * the show displays (the counter, `{{page}}`), so it counts exactly what
 * `paginates` counts: states and excluded slides are never a target, hidden
 * slides only when the deck numbers them.
 */
export function presentJumpTarget(doc: SlidomingoDoc, n: number): number {
  if (!Number.isInteger(n) || n < 1) return -1
  let page = 0
  for (let i = 0; i < doc.slides.length; i++) {
    if (paginates(doc.slides[i], doc) && ++page === n) return i
  }
  return -1
}

/** what one key does to a slide number being typed in present mode (see presentNumberKey) */
export type PresentNumberKey =
  /** not part of a number; nothing was being typed, so the key is the show's */
  | { kind: 'pass' }
  /** a modifier on its own (Shift for the digits on AZERTY): the number is kept */
  | { kind: 'hold' }
  /** a digit or Backspace; `buf` is the number so far ('' = Backspace emptied it) */
  | { kind: 'edit'; buf: string }
  /** Enter: go to the slide the show numbers `n` */
  | { kind: 'go'; n: number }
  /** any other key drops the number; `consumed` = the key was only for that (Esc) */
  | { kind: 'drop'; consumed: boolean }

const MODIFIER_KEYS = new Set(['Shift', 'CapsLock', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Fn', 'FnLock', 'NumLock', 'Hyper', 'Super', 'Dead'])

/**
 * The digit a key event types, or ''. Read from the physical key (`code`) so
 * the layout does not matter — on AZERTY the top row types '&é"…' unshifted —
 * with `key` as the fallback for events without a code. A numpad key counts
 * only while it types a digit (NumLock off turns it into End/arrows).
 */
export function presentDigitOf(key: string, code = ''): string {
  const m = /^(Digit|Numpad)([0-9])$/.exec(code)
  if (m) return m[1] === 'Digit' || /^[0-9]$/.test(key) ? m[2] : ''
  return /^[0-9]$/.test(key) ? key : ''
}

/**
 * The typed slide number + Enter state machine (PowerPoint). `buf` is what has
 * been typed so far; at most 4 digits are kept.
 */
export function presentNumberKey(buf: string, key: string, code = ''): PresentNumberKey {
  const digit = presentDigitOf(key, code)
  if (digit) return { kind: 'edit', buf: buf.length < 4 ? buf + digit : buf }
  if (!buf) return { kind: 'pass' }
  if (MODIFIER_KEYS.has(key)) return { kind: 'hold' }
  if (key === 'Backspace') return { kind: 'edit', buf: buf.slice(0, -1) }
  if (key === 'Enter') return { kind: 'go', n: Number(buf) }
  return { kind: 'drop', consumed: key === 'Escape' }
}

// ---------------------------------------------------------------------------
// Sections — read helpers. See `Section`'s doc comment for why membership is
// derived rather than stored. These three functions are the ONLY place that
// derivation happens; every reader (sidebar, outline, sorter) goes through
// them instead of indexing `doc.sections` directly, so a stale
// `startSlideId` (left behind by a foreign edit) is handled in one place.

/**
 * Every `Section` whose `startSlideId` still names a live slide, sorted by
 * that slide's position in `doc.slides`. Stale entries (a dangling
 * `startSlideId`) are dropped.
 */
export function sectionsInOrder(doc: SlidomingoDoc): Section[] {
  const index = new Map(doc.slides.map((s, i) => [s.id, i]))
  return (doc.sections ?? [])
    .filter((sec) => index.has(sec.startSlideId))
    .sort((a, b) => index.get(a.startSlideId)! - index.get(b.startSlideId)!)
}

/** The section (if any) covering a given slide — the last section, in
 *  order, whose start sits at or before this slide. */
export function sectionOf(doc: SlidomingoDoc, slideId: string): Section | undefined {
  const at = doc.slides.findIndex((s) => s.id === slideId)
  if (at < 0) return undefined
  let hit: Section | undefined
  for (const sec of sectionsInOrder(doc)) {
    const secIdx = doc.slides.findIndex((s) => s.id === sec.startSlideId)
    if (secIdx <= at) hit = sec
    else break
  }
  return hit
}

/**
 * A section's slide-index range in `doc.slides`: `start` is its own
 * `startSlideId`'s index, `end` is the next section's start index (in
 * order) or `doc.slides.length` — exclusive, so the section's members are
 * `doc.slides.slice(start, end)`. `{ start: -1, end: -1 }` for a stale
 * section (its `startSlideId` no longer names a live slide).
 */
export function sectionRange(doc: SlidomingoDoc, section: Section): { start: number; end: number } {
  const start = doc.slides.findIndex((s) => s.id === section.startSlideId)
  if (start < 0) return { start: -1, end: -1 }
  const ordered = sectionsInOrder(doc)
  const pos = ordered.findIndex((s) => s.id === section.id)
  const next = pos >= 0 ? ordered[pos + 1] : undefined
  const end = next ? doc.slides.findIndex((s) => s.id === next.startSlideId) : doc.slides.length
  return { start, end: end < 0 ? doc.slides.length : end }
}

// ---------------------------------------------------------------------------
// Zoom (Slide / Section / Summary Zoom) — pure logic. The renderer draws the
// tile (render.ts `case 'zoom'`), present.ts keeps a stack of `ZoomFrame`s and
// asks these functions where → and ← go while one is open; the camera motion
// is src/zoom.ts. Rig: scripts/test-zoom.ts.

/** Default seconds for the zoom camera move. */
export const ZOOM_SECONDS = 1

export const isZoomElement = (el: SlideElement | undefined): el is ZoomElement => el?.type === 'zoom'

/** A new zoom tile: a quarter-width tile in the slide's aspect, centred. */
export function defaultZoom(target: ZoomTarget, partial: Partial<ZoomElement> = {}): ZoomElement {
  return {
    id: uid('zoom'),
    type: 'zoom',
    x: 480, y: 270, w: 320, h: 180,
    rotation: 0, opacity: 1,
    target,
    stroke: '#FFFFFF',
    strokeWidth: 4,
    ...partial,
  }
}

const zoomSlideId = (t: unknown): string | undefined =>
  t && typeof t === 'object' && typeof (t as { slide?: unknown }).slide === 'string' ? (t as { slide: string }).slide : undefined
const zoomSectionId = (t: unknown): string | undefined =>
  t && typeof t === 'object' && typeof (t as { section?: unknown }).section === 'string' ? (t as { section: string }).section : undefined

/** The section a zoom tile targets, if it targets a live one. */
function zoomSection(doc: SlidomingoDoc, el: ZoomElement): Section | undefined {
  const id = zoomSectionId(el.target)
  return id ? sectionsInOrder(doc).find((s) => s.id === id) : undefined
}

/**
 * The slide-index range a zoom tile plays, `{ start, end }` (end exclusive),
 * or null when its target is gone. It may contain the tile's own slide (the
 * overview); every walker below skips that one.
 */
export function zoomRange(doc: SlidomingoDoc, el: ZoomElement): { start: number; end: number } | null {
  const sid = zoomSlideId(el.target)
  if (sid) {
    const i = doc.slides.findIndex((s) => s.id === sid)
    if (i < 0) return null
    if (el.range !== 'section') return { start: i, end: i + 1 }
    const sec = sectionOf(doc, sid)
    return { start: i, end: sec ? sectionRange(doc, sec).end : doc.slides.length }
  }
  const sec = zoomSection(doc, el)
  if (!sec) return null
  const r = sectionRange(doc, sec)
  return r.start < 0 ? null : r
}

/** The slide a tile shows: the first slide of its range that is not the
 *  overview (`overviewId`) and not an interactive state. */
export function zoomCover(doc: SlidomingoDoc, el: ZoomElement, overviewId?: string): Slide | undefined {
  const r = zoomRange(doc, el)
  if (!r) return undefined
  for (let i = r.start; i < r.end; i++) {
    const s = doc.slides[i]
    if (s.id !== overviewId && !s.stateOf) return s
  }
  return undefined
}

/** One open zoom while presenting: where it came from and what it plays. */
export interface ZoomFrame {
  /** index of the overview slide (the one holding the tile) */
  overview: number
  /** the tile's element id on the overview */
  tile: string
  /** the range played, `doc.slides[start..end)` minus the overview */
  start: number
  end: number
  /** the click the overview stood at when the tile was clicked — restored on the way back */
  step: number
}

/** The frame a click on `el` (on slide `overview`, at click `step`) opens, or
 *  null when the tile has nothing to play. */
export function zoomFrameFor(doc: SlidomingoDoc, overview: number, el: ZoomElement, step = 0): ZoomFrame | null {
  const r = zoomRange(doc, el)
  if (!r) return null
  const f: ZoomFrame = { overview, tile: el.id, start: r.start, end: r.end, step }
  return zoomFirst(doc, f) >= 0 ? f : null
}

/** Is slide `i` played by this frame? A state counts through its parent;
 *  the overview never does. Hidden slides do. */
export function inZoomFrame(doc: SlidomingoDoc, f: ZoomFrame, i: number): boolean {
  if (i === f.overview || i < 0 || i >= doc.slides.length) return false
  const a = navAnchor(doc, i)
  return a !== f.overview && a >= f.start && a < f.end
}

/**
 * The zoom stack once the show lands on slide `i`, by whatever route (a
 * link, a typed number, the grid, a loop wrap, the kiosk): frames whose range
 * no longer holds `i` close — from the TOP only, because frames nest: an
 * outer zoom waits while an inner one plays a range outside it.
 */
export function zoomStackAt(doc: SlidomingoDoc, stack: readonly ZoomFrame[], i: number): ZoomFrame[] {
  let n = stack.length
  while (n && !inZoomFrame(doc, stack[n - 1], i)) n--
  return stack.slice(0, n)
}

const zoomWalkable = (doc: SlidomingoDoc, f: ZoomFrame, i: number): boolean =>
  i !== f.overview && !doc.slides[i]?.stateOf

/** The first slide a frame lands on, or -1 when it plays nothing. */
export function zoomFirst(doc: SlidomingoDoc, f: ZoomFrame): number {
  for (let i = Math.max(0, f.start); i < Math.min(f.end, doc.slides.length); i++) if (zoomWalkable(doc, f, i)) return i
  return -1
}

/** Where → goes inside a frame: the next slide of the range (hidden ones
 *  included, states skipped), or -1 = zoom back out. */
export function zoomNext(doc: SlidomingoDoc, f: ZoomFrame, cur: number): number {
  const end = Math.min(f.end, doc.slides.length)
  for (let i = navAnchor(doc, cur) + 1; i < end; i++) if (zoomWalkable(doc, f, i)) return i
  return -1
}

/** Where ← goes inside a frame: a state returns to its parent, otherwise the
 *  previous slide of the range; on the range's first slide, -1 = zoom out. */
export function zoomPrev(doc: SlidomingoDoc, f: ZoomFrame, cur: number): number {
  const sp = stateParent(doc, cur)
  if (sp >= 0) return sp
  for (let i = cur - 1; i >= Math.max(0, f.start); i--) if (zoomWalkable(doc, f, i)) return i
  return -1
}

/** Every zoom tile on the deck's slides, with the slide holding it. */
export function zoomTiles(doc: SlidomingoDoc): Array<{ slide: Slide; el: ZoomElement }> {
  const out: Array<{ slide: Slide; el: ZoomElement }> = []
  for (const slide of doc.slides) for (const el of slide.elements) if (isZoomElement(el)) out.push({ slide, el })
  return out
}

/** Re-point a tile at copied slides/sections (old id → new id). True when it changed. */
export function remapZoomTarget(el: ZoomElement, slides: Map<string, string>, sections?: Map<string, string>): boolean {
  const sid = zoomSlideId(el.target)
  const nsid = sid ? slides.get(sid) : undefined
  if (nsid) { el.target = { slide: nsid }; return true }
  const sec = zoomSectionId(el.target)
  const nsec = sec ? sections?.get(sec) : undefined
  if (nsec) { el.target = { section: nsec }; return true }
  return false
}

/** Does this tile's target still exist? */
export function zoomTargetLive(doc: SlidomingoDoc, el: ZoomElement): boolean {
  const sid = zoomSlideId(el.target)
  if (sid) return doc.slides.some((s) => s.id === sid)
  const sec = zoomSectionId(el.target)
  return !!sec && sectionsInOrder(doc).some((s) => s.id === sec)
}

/** Remove every tile whose target slide/section is gone. Returns how many. */
export function pruneDanglingZoomTiles(doc: SlidomingoDoc): number {
  let n = 0
  for (const slide of doc.slides) {
    const keep = slide.elements.filter((el) => !isZoomElement(el) || zoomTargetLive(doc, el))
    n += slide.elements.length - keep.length
    if (keep.length !== slide.elements.length) slide.elements = keep
  }
  return n
}

/** A section is going away but its slides stay: tiles that zoomed into it
 *  zoom into its first slide instead (call BEFORE removing the section).
 *  Returns how many tiles changed. */
export function retargetSectionZooms(doc: SlidomingoDoc, sectionId: string): number {
  const sec = (doc.sections ?? []).find((s) => s.id === sectionId)
  let n = 0
  for (const { el } of zoomTiles(doc)) {
    if (zoomSectionId(el.target) !== sectionId) continue
    if (sec && doc.slides.some((s) => s.id === sec.startSlideId)) { el.target = { slide: sec.startSlideId }; delete el.range }
    n++
  }
  return n
}

/** How many tiles point at one of `slideIds` (or at a section starting on one) — a delete's impact. */
export function zoomTilesInto(doc: SlidomingoDoc, slideIds: Set<string>): number {
  const sections = new Set((doc.sections ?? []).filter((s) => slideIds.has(s.startSlideId)).map((s) => s.id))
  let n = 0
  for (const { slide, el } of zoomTiles(doc)) {
    if (slideIds.has(slide.id)) continue
    const sid = zoomSlideId(el.target)
    const sec = zoomSectionId(el.target)
    if ((sid && slideIds.has(sid)) || (sec && sections.has(sec))) n++
  }
  return n
}

export interface ZoomRect { x: number; y: number; w: number; h: number }

/**
 * Tile frames for a Summary Zoom of `n` sections on a slide of `size`: the
 * biggest equal tiles in the slide's aspect that fit the area under the
 * title, rows centred. Never overlapping (rig: test-zoom.ts, n = 1…12).
 */
export function summaryZoomGrid(n: number, size: { width: number; height: number }): ZoomRect[] {
  if (n <= 0) return []
  const W = size.width, H = size.height
  const aspect = W / H
  const mx = W * 0.06, top = H * 0.24, bottom = H * 0.07
  const gap = Math.max(8, W * 0.022)
  const areaW = W - 2 * mx, areaH = H - top - bottom
  let best = { cols: 1, rows: n, w: 0 }
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const w = Math.min((areaW - (cols - 1) * gap) / cols, ((areaH - (rows - 1) * gap) / rows) * aspect)
    if (w > best.w + 1e-6) best = { cols, rows, w }
  }
  const w = Math.floor(best.w)
  const h = Math.floor(w / aspect)
  const gridH = best.rows * h + (best.rows - 1) * gap
  const y0 = top + (areaH - gridH) / 2
  const out: ZoomRect[] = []
  for (let r = 0; r < best.rows; r++) {
    const inRow = Math.min(best.cols, n - r * best.cols)
    const rowW = inRow * w + (inRow - 1) * gap
    const x0 = (W - rowW) / 2
    for (let c = 0; c < inRow; c++) out.push({ x: Math.round(x0 + c * (w + gap)), y: Math.round(y0 + r * (h + gap)), w, h })
  }
  return out
}

/**
 * A Summary Zoom overview slide: a title and one section-zoom tile per
 * section, laid out by `summaryZoomGrid`. Pure — nothing is inserted.
 */
export function summaryZoomSlide(doc: SlidomingoDoc, sectionIds: string[], title: string): Slide {
  const grid = summaryZoomGrid(sectionIds.length, doc.size)
  const bg = doc.slides[0]?.background ?? '#FFFFFF'
  const ink = readableInk(bg)
  const heading = defaultText({
    x: Math.round(doc.size.width * 0.06), y: Math.round(doc.size.height * 0.06),
    w: Math.round(doc.size.width * 0.88), h: Math.round(doc.size.height * 0.13),
    html: title, fontSize: Math.round(doc.size.height * 0.067), fontWeight: 700, align: 'left', color: ink, role: 'title',
  })
  const tiles = sectionIds.map((id, i) => defaultZoom({ section: id }, {
    ...grid[i], stroke: isLightBg(bg) ? '#D9D9D9' : '#FFFFFF', strokeWidth: 3, radius: 6,
  }))
  return emptySlide({ background: bg, elements: [heading, ...tiles] })
}

/**
 * Insert a Summary Zoom, as one mutation (callers wrap it in ONE commit).
 * `picks` are sections, or slides — a picked slide that does not start a
 * section yet starts a new one (named by `nameOf`), as in PowerPoint. The
 * overview slide goes before the first picked section, in a section of its
 * own named `summaryName`. Returns the overview slide, or null for no picks.
 */
export function insertSummaryZoom(
  doc: SlidomingoDoc, picks: ZoomTarget[], title: string, summaryName: string, nameOf: (slide: Slide) => string,
): Slide | null {
  const sectionIds: string[] = []
  for (const p of picks) {
    const sec = zoomSectionId(p)
    if (sec) { if (sectionsInOrder(doc).some((s) => s.id === sec)) sectionIds.push(sec); continue }
    const sid = zoomSlideId(p)
    const slide = sid ? doc.slides.find((s) => s.id === sid) : undefined
    if (!slide) continue
    let start = (doc.sections ?? []).find((s) => s.startSlideId === slide.id)
    if (!start) { start = { id: uid('section'), name: nameOf(slide), startSlideId: slide.id }; (doc.sections ??= []).push(start) }
    sectionIds.push(start.id)
  }
  const unique = [...new Set(sectionIds)]
  if (!unique.length) return null
  // tiles in deck order, so the overview reads like the deck
  const order = new Map(sectionsInOrder(doc).map((s, i) => [s.id, i]))
  unique.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  const overview = summaryZoomSlide(doc, unique, title)
  const firstStart = (doc.sections ?? []).find((s) => s.id === unique[0])!.startSlideId
  const at = Math.max(0, doc.slides.findIndex((s) => s.id === firstStart))
  doc.slides.splice(at, 0, overview)
  ;(doc.sections ??= []).push({ id: uid('section'), name: summaryName, startSlideId: overview.id })
  return overview
}

/** Narrows `commentEntries` — every field optional, omitted = unfiltered. */
export interface CommentFilter {
  resolved?: boolean
  /** the `@ai`/`/ai` flag — see `Comment.forAgent` */
  forAgent?: boolean
  slideId?: string
}

export type CommentAnchor =
  | { type: 'element'; elementId: string }
  | { type: 'point'; x: number; y: number }
  /** dragged rectangle; `elementIds` = top-level elements whose frames intersect it */
  | { type: 'area'; x: number; y: number; w: number; h: number; elementIds: string[] }
  | { type: 'slide' }

export interface CommentEntry {
  slideId: string
  /** position in `doc.slides`, including hidden/state slides */
  slideIndex: number
  id: string
  anchor: CommentAnchor
  author: string
  at: string
  text: string
  forAgent: boolean
  replies: Array<{ id: string; author: string; text: string; at: string }>
  resolved: boolean
  /** Claude marked it done and the user has not yet accepted/reopened it */
  awaitingCheck: boolean
}

/**
 * Flat, typed-anchor list of every review comment thread — the entry point
 * for tooling and AI agents processing a deck ("fix everything people
 * flagged"). THE single implementation: `window.slidomingo.comments()` and the
 * MCP `comments` query verb (desktop terminal integration) both call this,
 * so the two surfaces cannot disagree about shape or filtering.
 */
export function commentEntries(doc: SlidomingoDoc, filter: CommentFilter = {}): CommentEntry[] {
  const out: CommentEntry[] = []
  doc.slides.forEach((s, slideIndex) => {
    if (filter.slideId && s.id !== filter.slideId) return
    for (const c of s.comments ?? []) {
      if (filter.resolved !== undefined && !!c.resolved !== filter.resolved) continue
      if (filter.forAgent !== undefined && !!c.forAgent !== filter.forAgent) continue
      out.push({
        slideId: s.id,
        slideIndex,
        id: c.id,
        anchor: c.elementId
          ? { type: 'element', elementId: c.elementId }
          : typeof c.x === 'number' && typeof c.w === 'number' && typeof c.h === 'number'
            ? {
                type: 'area',
                x: c.x,
                y: c.y!,
                w: c.w,
                h: c.h,
                elementIds: s.elements
                  .filter((e) => e.x < c.x! + c.w! && e.x + e.w > c.x! && e.y < c.y! + c.h! && e.y + e.h > c.y!)
                  .map((e) => e.id),
              }
            : typeof c.x === 'number'
            ? { type: 'point', x: c.x, y: c.y! }
            : { type: 'slide' },
        author: c.author,
        at: c.at,
        text: c.text,
        forAgent: !!c.forAgent,
        replies: c.replies ?? [],
        resolved: !!c.resolved,
        awaitingCheck: !!c.agentDone,
      })
    }
  })
  return out
}

export const newDocId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : uid('doc')

export function newDoc(): SlidomingoDoc {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    docId: newDocId(),
    title: 'Untitled',
    size: { width: 1280, height: 720 },
    theme: {
      background: '#FFFFFF',
      color: '#1D1119',
      accent: BRAND.honeyOnLight,
      fontFamily: FONT_STACK,
    },
    slides: [emptySlide()],
    modified: new Date().toISOString(),
  }
}

// ---- Figure mode -----------------------------------------------------------------------
//
// A figure is an ordinary one-slide doc with `kind: 'figure'`; `figure` holds
// the physical size, `size` stays the same size in px at 96 dpi. See
// docs/DECISIONS.md ("Figure mode").

export type FigureUnit = 'mm' | 'pt' | 'in'
const PX_PER_UNIT: Record<FigureUnit, number> = { mm: 96 / 25.4, pt: 96 / 72, in: 96 }
export const unitToPx = (v: number, unit: FigureUnit): number => v * PX_PER_UNIT[unit]
export const pxToUnit = (px: number, unit: FigureUnit): number => px / PX_PER_UNIT[unit]
/** `size` for a physical figure size, whole px (never below 1). */
export const figureSizePx = (w: number, h: number, unit: FigureUnit): { width: number; height: number } =>
  ({ width: Math.max(1, Math.round(unitToPx(w, unit))), height: Math.max(1, Math.round(unitToPx(h, unit))) })

/** Common journal widths. Labels are translated at the call site (this module never calls t()). */
export const FIGURE_PRESETS: ReadonlyArray<{ key: string; label: string; hint: string; unit: FigureUnit; width: number; height: number }> = [
  { key: 'single', label: 'Single column', hint: '85 mm · 3.35 in (IEEE, Elsevier)', unit: 'mm', width: 85, height: 60 },
  { key: 'onehalf', label: '1.5 columns', hint: '120 mm (Springer, Nature)', unit: 'mm', width: 120, height: 80 },
  { key: 'double', label: 'Double column / text width', hint: '174 mm · 7.16 in (IEEE two-column)', unit: 'mm', width: 174, height: 80 },
  { key: 'a4', label: 'A4 text block', hint: '160 mm (A4 text block width)', unit: 'mm', width: 160, height: 100 },
]

/** The look of a first-drawn object on a figure canvas: paper-scale type and hairline-ish strokes. */
const FIGURE_STYLE_DEFAULTS: StyleDefaults = {
  shape: { fill: '#FFFFFF', stroke: '#000000', strokeWidth: 1 },
  line: { color: '#000000', width: 1 },
  text: { fontFamily: 'Helvetica, Arial, sans-serif', fontSize: 12, color: '#000000', lineHeight: 1.2 },
}

export function newFigureDoc(width: number, height: number, unit: FigureUnit = 'mm'): SlidomingoDoc {
  const doc = newDoc()
  doc.title = 'Untitled figure'
  doc.kind = 'figure'
  doc.figure = { unit, width, height }
  doc.size = figureSizePx(width, height, unit)
  doc.theme.color = '#000000'
  doc.theme.styleDefaults = FIGURE_STYLE_DEFAULTS
  doc.slides[0].transition = 'none'
  return doc
}

// ---- Icon sets -------------------------------------------------------------
//
// An icon set is a doc with `kind: 'iconset'`: one icon per slide, named by the
// slide's `name`, drawn on a square `grid` (24 units) that is `grid * scale` px
// on the canvas. Every icon shares `iconset.style`. Pure helpers (apply the
// style, file names, the manifest) live in iconset.ts. See docs/DECISIONS.md
// ("Icon sets").

export interface IconsetStyle {
  /** stroke width in grid units */
  strokeWidth: number
  cap: 'round' | 'square' | 'butt'
  join: 'round' | 'bevel' | 'miter'
  /** empty margin inside the grid, grid units (the keyline square) */
  padding: number
  /** outline = strokes only; solid = filled shapes; duotone = strokes plus a
   *  faint fill */
  fill: 'outline' | 'solid' | 'duotone'
  /** the ink everything is drawn in; becomes `currentColor` on export */
  color: string
}

export interface IconsetInfo {
  /** grid units per side, 24 */
  grid: number
  /** canvas px per grid unit */
  scale: number
  /** what the whole set is for and how it should look, in words */
  brief?: string
  style: IconsetStyle
  license?: string
  author?: string
}

export const ICONSET_STYLE_DEFAULTS: IconsetStyle = {
  strokeWidth: 2, cap: 'round', join: 'round', padding: 2, fill: 'outline', color: '#000000',
}

/** The look of a first-drawn object on an icon canvas: the set's ink and stroke. */
export function iconsetStyleDefaults(info: IconsetInfo): StyleDefaults {
  const w = info.style.strokeWidth * info.scale
  return {
    shape: { fill: 'transparent', stroke: info.style.color, strokeWidth: w },
    line: { color: info.style.color, width: w, strokeCap: info.style.cap },
    text: { fontFamily: 'Helvetica, Arial, sans-serif', fontSize: 6 * info.scale, color: info.style.color, lineHeight: 1.2 },
  }
}

/** One empty icon slide. */
export function newIconSlide(name: string, prompt?: string): Slide {
  return emptySlide({ name, transition: 'none', ...(prompt ? { icon: { prompt } } : {}) })
}

/** A new icon set with one slide per name (one unnamed icon when none). */
export function newIconsetDoc(opts: { names?: string[]; brief?: string; grid?: number } = {}): SlidomingoDoc {
  const doc = newDoc()
  const grid = opts.grid ?? 24
  const info: IconsetInfo = { grid, scale: Math.max(1, Math.round(384 / grid)), style: { ...ICONSET_STYLE_DEFAULTS } }
  if (opts.brief) info.brief = opts.brief
  doc.title = 'Untitled icon set'
  doc.kind = 'iconset'
  doc.iconset = info
  doc.size = { width: grid * info.scale, height: grid * info.scale }
  doc.theme.color = info.style.color
  doc.theme.styleDefaults = iconsetStyleDefaults(info)
  const names = (opts.names ?? []).map((n) => n.trim()).filter(Boolean)
  doc.slides = (names.length ? names : ['icon']).map((n) => newIconSlide(n))
  return doc
}

// ---- Templates -------------------------------------------------------------
//
// A template is slide types + theme + assets (docs/DECISIONS.md 2026-09-24):
// `doc.layouts` (+ `defaultLayoutId`/`rootFontLayoutId`), `theme`, `fonts`,
// `reusableObjects` and the assets those reference. Its `slides` are either
// optional sample slides (`templateSamples !== false`) or one placeholder
// starter slide, because a doc must have at least one (`parseDoc`).

/** The one slide a fresh deck starts with: an instance of the deck's default
 *  slide type (`defaultSlideType`) — or of `layoutId`, when that names one of
 *  the deck's own slide types — linked to it when that type is a doc layout
 *  rather than the built-in fallback. Shared by the editor's "Start from
 *  scratch" and template instantiation. Pure — mints a fresh slide id, never
 *  touches `doc`. */
export function starterSlide(doc: SlidomingoDoc, layoutId?: string): Slide {
  const chosen = (layoutId ? doc.layouts?.find((l) => l.id === layoutId) : undefined) ?? defaultSlideType(doc)
  const slide = instantiateLayout(effectiveLayout(doc, chosen))
  if (doc.layouts?.some((l) => l.id === chosen.id)) slide.layoutId = chosen.id
  return slide
}

/** The display name of a template file: its filename minus the directory and
 *  the `.beeslides.html` (or legacy `.beeslides.html`) suffix. Never the doc's `title`, which in practice
 *  carries whatever placeholder text the source deck's first slide had. */
export function templateNameFromPath(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return stripDocExt(base) || base
}

/**
 * Every `doc.assets` key the document (minus the asset table itself) might
 * reference. CONSERVATIVE by design — a false positive costs bytes, a false
 * negative silently deletes someone's picture. A key counts as referenced
 * when:
 *   - `asset:<key>` appears anywhere in the doc's JSON (image/media `src`,
 *     `poster`, and any field or embedded string a future feature adds);
 *   - some string value anywhere equals the bare key (svg elements'
 *     `asset`, `fonts[].asset`, and anything else that stores a bare key);
 *   - a referenced NON-data asset (e.g. svg markup) itself mentions it —
 *     followed transitively.
 */
export function referencedAssetKeys(doc: SlidomingoDoc): Set<string> {
  const assets = doc.assets ?? {}
  const keys = Object.keys(assets)
  const out = new Set<string>()
  if (!keys.length) return out
  const rest: Record<string, unknown> = { ...doc }
  delete rest.assets
  const strings = new Set<string>()
  const walk = (v: unknown): void => {
    if (typeof v === 'string') strings.add(v)
    else if (Array.isArray(v)) for (const x of v) walk(x)
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
  }
  walk(rest)
  const haystacks = [JSON.stringify(rest)]
  const mentions = (hay: string, k: string) =>
    hay.includes('asset:' + k) || hay.includes(JSON.stringify('asset:' + k).slice(1, -1))
  const scan = (): boolean => {
    let grew = false
    for (const k of keys) {
      if (out.has(k)) continue
      if (strings.has(k) || haystacks.some((h) => mentions(h, k))) {
        out.add(k)
        grew = true
        const v = assets[k]
        // A referenced asset that is markup rather than binary can mention
        // other assets; keep those too.
        if (typeof v === 'string' && !v.startsWith('data:')) {
          haystacks.push(v)
        }
      }
    }
    return grew
  }
  while (scan()) { /* follow references through markup assets */ }
  return out
}

/** Drops every `doc.assets` entry `referencedAssetKeys` does not vouch for
 *  (in place). Removes the table entirely when nothing is left. */
function pruneAssets(doc: SlidomingoDoc): void {
  if (!doc.assets) return
  const keep = referencedAssetKeys(doc)
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(doc.assets)) if (keep.has(k)) next[k] = v
  if (Object.keys(next).length) doc.assets = next
  else delete doc.assets
}

/** What "Clean up document…" would remove (docs/DECISIONS.md 2026-09-28) —
 *  a pure read, never applied on save.
 *
 *  KEPT slide types = the whole ancestor chain of every type some slide
 *  (state variants included) follows, plus the chains of the effective
 *  default type (`defaultSlideType`) and `rootFontLayoutId`. That set is
 *  closed under `parentId`, so dropping the rest never orphans a kept type
 *  and needs no `removeLayout` baking. A TEMPLATE keeps every type — its
 *  unlinked types are the point of it.
 *
 *  Unused assets = the keys `referencedAssetKeys` stops vouching for once
 *  those types are gone (same conservative rules as every other prune).
 *  `bytes` = how much shorter the doc's JSON gets. */
export function unusedContent(doc: SlidomingoDoc): { layouts: Slide[]; assetKeys: string[]; bytes: number } {
  const layouts = doc.layouts ?? []
  let removable: Slide[] = []
  if (!doc.template && !doc.templateId) {
    const kept = new Set<string>()
    const keepChain = (id: string | undefined) => {
      const ly = id ? layouts.find((l) => l.id === id) : undefined
      if (ly) for (const l of ancestorChain(doc, ly)) kept.add(l.id)
    }
    for (const s of doc.slides) keepChain(s.layoutId)
    keepChain(defaultSlideType(doc).id)
    keepChain(doc.rootFontLayoutId)
    removable = layouts.filter((l) => !kept.has(l.id))
  }
  const after: SlidomingoDoc = { ...doc, layouts: layouts.filter((l) => !removable.includes(l)) }
  const keep = referencedAssetKeys(after)
  const assetKeys = Object.keys(doc.assets ?? {}).filter((k) => !keep.has(k))
  if (!removable.length && !assetKeys.length) return { layouts: [], assetKeys: [], bytes: 0 }
  pruneAssets(after)
  if (!after.layouts!.length) delete after.layouts
  return { layouts: removable, assetKeys, bytes: JSON.stringify(doc).length - JSON.stringify(after).length }
}

/** "Clean up document…": drops what `unusedContent` reports — the unused
 *  slide types, then (via `pruneAssets`) every asset nothing references any
 *  more. In place; the caller wraps it in `store.commit` so one undo brings
 *  it all back. Returns what was removed. */
export function removeUnusedContent(doc: SlidomingoDoc): ReturnType<typeof unusedContent> {
  const found = unusedContent(doc)
  if (found.layouts.length) {
    const gone = new Set(found.layouts.map((l) => l.id))
    doc.layouts = (doc.layouts ?? []).filter((l) => !gone.has(l.id))
    if (!doc.layouts.length) delete doc.layouts
  }
  if (found.assetKeys.length) pruneAssets(doc)
  return found
}

/** Clone a doc and stamp it as a re-usable template: fresh opens must
 *  never inherit this document's identity.
 *  Used when SAVING a template (editor.ts saveAsTemplate) and when the
 *  start picker imports one ("＋ Add a template"). Keeps an existing
 *  `templateId` (re-stamping a template keeps its identity), else takes
 *  `opts.templateId`, else mints one. Drops `docId` and `basedOn` (a
 *  template's identity is its templateId, not the deck it came from).
 *  `samples` (default: the doc's own `templateSamples`, else true) —
 *  `false` keeps only the design: `slides` becomes one starter slide and
 *  assets only the slides referenced are pruned. */
export function stampAsTemplate(
  doc: SlidomingoDoc,
  opts: { templateId?: string; samples?: boolean } = {},
): SlidomingoDoc {
  const clone = JSON.parse(JSON.stringify(doc)) as SlidomingoDoc
  clone.template = true
  delete (clone as { docId?: string }).docId
  delete clone.basedOn
  clone.templateId = clone.templateId || opts.templateId || newDocId()
  const samples = opts.samples ?? clone.templateSamples ?? true
  clone.templateSamples = samples
  if (!samples) {
    clone.slides = [starterSlide(clone)]
    delete clone.sections
    pruneAssets(clone)
  }
  return clone
}

/**
 * A NEW deck from a template file's doc-block JSON (`raw`, exactly as read
 * from the file — `templateId` is read from it before `parseDoc`, which
 * strips template identity). Any file is treated as a template, flag or not
 * (a manually dropped or Claude-authored file cannot be trusted to set it),
 * so the deck ALWAYS gets a fresh docId — the sanctioned "new deck from X"
 * id change (docs/PLATFORM.md §3).
 *
 * The deck is titled "Untitled", records `basedOn: {templateId, name}`
 * (`name` = `opts.name`, the template's filename-derived name, see
 * `templateNameFromPath`), carries no template fields, and — with
 * `includeSamples: false` — starts from a single `starterSlide`, of the slide
 * type `firstLayoutId` when given (the start page's pick; an id that isn't
 * one of the template's slide types falls back to its default). Assets
 * nothing references any more are pruned (`referencedAssetKeys`). `null`
 * when `raw` is not a slides document.
 */
export function instantiateTemplate(
  raw: string,
  opts: { includeSamples: boolean; name?: string; firstLayoutId?: string },
): SlidomingoDoc | null {
  let templateId: string | undefined
  try {
    const j = JSON.parse(raw) as { templateId?: unknown } | null
    if (typeof j?.templateId === 'string' && j.templateId) templateId = j.templateId
  } catch {
    return null
  }
  const doc = parseDoc(raw)
  // the reader gate: a deck started from a newer-format template would lose
  // what this build does not understand on its first save
  if (!doc || unsupportedFeatures(doc).length) return null
  delete doc.template
  delete doc.templateId
  delete doc.templateSamples
  doc.docId = newDocId()
  const basedOn: { templateId?: string; name?: string } = {}
  if (templateId) basedOn.templateId = templateId
  if (opts.name) basedOn.name = opts.name
  if (basedOn.templateId || basedOn.name) doc.basedOn = basedOn
  else delete doc.basedOn
  doc.title = 'Untitled'
  if (!opts.includeSamples) {
    doc.slides = [starterSlide(doc, opts.firstLayoutId)]
    delete doc.sections
  }
  pruneAssets(doc)
  doc.modified = new Date().toISOString()
  return doc
}

/** Which template a deck was started from, among `templates` (e.g. the
 *  desktop's template metadata list): by `basedOn.templateId` first; by
 *  filename-derived `name` when either side has no id — a legacy template
 *  (no `templateId` yet) or a deck created from one. A deck whose id names
 *  no template does NOT fall back to an id-carrying template of the same
 *  name: that is a different template that happens to share a filename. */
export function resolveBasedOn<T extends { templateId?: string | null; name: string }>(
  basedOn: SlidomingoDoc['basedOn'],
  templates: readonly T[],
): T | undefined {
  if (!basedOn) return undefined
  if (basedOn.templateId) {
    const byId = templates.find((t) => t.templateId === basedOn.templateId)
    if (byId) return byId
  }
  if (!basedOn.name) return undefined
  return templates.find((t) => t.name === basedOn.name && (!basedOn.templateId || !t.templateId))
}

/** Design-layer fields a template update copies from a deck. */
const DESIGN_FIELDS = ['layouts', 'defaultLayoutId', 'rootFontLayoutId', 'theme', 'fonts', 'reusableObjects', 'terms'] as const

/** Rewrites asset refs `from` → `to` in place: `asset:<from>` inside any
 *  string (bounded, so `a1` never rewrites `a10`), and a bare `asset`
 *  property equal to `from` (svg elements, font entries). */
function renameAssetRefs(node: unknown, from: string, to: string): void {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`asset:${esc}(?![A-Za-z0-9_-])`, 'g')
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (typeof v[i] === 'string') v[i] = (v[i] as string).replace(re, `asset:${to}`)
        else visit(v[i])
      }
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      for (const [k, x] of Object.entries(o)) {
        if (typeof x === 'string') o[k] = k === 'asset' && x === from ? to : x.replace(re, `asset:${to}`)
        else visit(x)
      }
    }
  }
  visit(node)
}

/**
 * The "Update template from this deck" merge: a NEW template doc = `template`
 * with its design layer — `layouts`, `defaultLayoutId`, `rootFontLayoutId`,
 * `theme`, `fonts`, `reusableObjects` and the assets those reference —
 * replaced from `deck`. Everything else is the template's own: title, meta,
 * sample slides, `templateSamples`, `templateId` (minted here when a legacy
 * template has none yet).
 *
 * Sample slides still linked (`layoutId`) to a slide type that survives are
 * re-applied through it, exactly as the Layout Manager resyncs linked slides
 * live; a link to a slide type the deck no longer has is cleared. A
 * samples-less template gets a fresh `starterSlide` of the new design. Asset
 * keys that collide with a different value are renamed on the template side,
 * so a sample slide's picture never silently becomes the deck's.
 *
 * Refuses (`{error:'size-mismatch'}`) when the two differ in slide size —
 * every coordinate in the design would be wrong for the samples.
 */
export function mergeTemplateDesign(
  template: SlidomingoDoc,
  deck: SlidomingoDoc,
): SlidomingoDoc | { error: 'size-mismatch' } {
  if (template.size?.width !== deck.size?.width || template.size?.height !== deck.size?.height) {
    return { error: 'size-mismatch' }
  }
  const out = JSON.parse(JSON.stringify(template)) as SlidomingoDoc
  const src = JSON.parse(JSON.stringify(deck)) as SlidomingoDoc
  const oldLayoutIds = layoutElementIds(out)

  // Template-side part (everything but the design layer), with colliding
  // asset keys renamed away from the deck's.
  const own = out as unknown as Record<string, unknown>
  for (const f of DESIGN_FIELDS) delete own[f]
  const tAssets = { ...(out.assets ?? {}) }
  delete out.assets
  const dAssets = src.assets ?? {}
  for (const k of Object.keys(tAssets)) {
    if (!(k in dAssets) || dAssets[k] === tAssets[k]) continue
    let nk = `${k}-t`
    for (let n = 2; nk in dAssets || nk in tAssets; n++) nk = `${k}-t${n}`
    renameAssetRefs(out, k, nk)
    tAssets[nk] = tAssets[k]
    delete tAssets[k]
  }

  // Design layer from the deck.
  const from = src as unknown as Record<string, unknown>
  for (const f of DESIGN_FIELDS) if (from[f] !== undefined) own[f] = from[f]
  out.assets = { ...tAssets, ...dAssets }

  if (out.templateSamples === false) {
    out.slides = [starterSlide(out)]
    delete out.sections
  } else {
    const known = new Set([...oldLayoutIds, ...layoutElementIds(out)])
    for (const slide of out.slides) {
      if (!slide.layoutId) continue
      const layout = out.layouts?.find((l) => l.id === slide.layoutId)
      if (!layout) { delete slide.layoutId; continue }
      const effective = effectiveLayout(out, layout)
      slide.elements = applyLayout(slide, effective, known)
      slide.background = effective.background
      if (effective.excludeFromNumbering) slide.excludeFromNumbering = true
      else delete slide.excludeFromNumbering
    }
  }

  out.template = true
  delete (out as { docId?: string }).docId
  delete out.basedOn
  out.templateId = out.templateId || newDocId()
  pruneAssets(out)
  out.modified = new Date().toISOString()
  return out
}

/**
 * "Update this deck from template" — the reverse of `mergeTemplateDesign`,
 * IN PLACE on `deck` (call it inside one `store.commit`, so it is one undo
 * step): the template's slide types replace the deck's BY ID (or are added;
 * the deck's own extra slide types stay), and its theme, fonts, reusable
 * objects and the assets those reference come along. The deck's slides are
 * untouched here — the caller resyncs the linked ones (`resyncLinkedSlides`
 * for each returned id). Asset keys that collide with a different value are
 * renamed on the template side, so the deck's own pictures never change.
 * Refuses on a slide-size mismatch.
 */
export function adoptTemplateDesign(
  deck: SlidomingoDoc,
  template: SlidomingoDoc,
): { layoutIds: string[] } | { error: 'size-mismatch' } {
  if (template.size?.width !== deck.size?.width || template.size?.height !== deck.size?.height) {
    return { error: 'size-mismatch' }
  }
  // design layer only — the template's sample slides don't vouch for assets
  const t = JSON.parse(JSON.stringify({ ...template, slides: [] })) as SlidomingoDoc
  const wanted = referencedAssetKeys(t)
  const deckAssets = deck.assets ?? {}
  const tAssets = t.assets ?? {}
  for (const k of [...wanted]) {
    if (!(k in deckAssets) || deckAssets[k] === tAssets[k]) continue
    let nk = `${k}-t`
    for (let n = 2; nk in deckAssets || nk in tAssets; n++) nk = `${k}-t${n}`
    renameAssetRefs(t, k, nk)
    tAssets[nk] = tAssets[k]
    delete tAssets[k]
    wanted.delete(k)
    wanted.add(nk)
  }
  for (const k of wanted) if (tAssets[k] !== undefined) (deck.assets ??= {})[k] = tAssets[k]

  const ids: string[] = []
  deck.layouts ??= []
  for (const ly of t.layouts ?? []) {
    const i = deck.layouts.findIndex((l) => l.id === ly.id)
    if (i >= 0) deck.layouts[i] = ly
    else deck.layouts.push(ly)
    ids.push(ly.id)
  }
  if (t.defaultLayoutId && !deck.layouts.some((l) => l.id === deck.defaultLayoutId)) deck.defaultLayoutId = t.defaultLayoutId
  if (t.rootFontLayoutId && !deck.rootFontLayoutId) deck.rootFontLayoutId = t.rootFontLayoutId
  if (t.theme) deck.theme = t.theme
  if (t.fonts?.length) {
    const byFamily = new Map((deck.fonts ?? []).map((f) => [`${f.family}|${f.weight ?? ''}|${f.style ?? ''}`, f]))
    for (const f of t.fonts) byFamily.set(`${f.family}|${f.weight ?? ''}|${f.style ?? ''}`, f)
    deck.fonts = [...byFamily.values()]
  }
  if (t.reusableObjects?.length) {
    deck.reusableObjects ??= []
    for (const o of t.reusableObjects) {
      const i = deck.reusableObjects.findIndex((x) => x.id === o.id)
      if (i >= 0) deck.reusableObjects[i] = o
      else deck.reusableObjects.push(o)
    }
  }
  if (t.terms) deck.terms = mergeTerms(deck.terms, t.terms)
  return { layoutIds: ids }
}

/** A template file's doc-block JSON as a TEMPLATE doc (for updating it):
 *  parseDoc's migrations, but with the template identity parseDoc strips
 *  (`template`, `templateId`, `templateSamples`) put back. */
export function parseTemplateDoc(raw: string): SlidomingoDoc | null {
  let j: { templateId?: unknown; templateSamples?: unknown } | null
  try { j = JSON.parse(raw) } catch { return null }
  const doc = parseDoc(raw)
  if (!doc) return null
  doc.template = true
  delete doc.basedOn
  delete (doc as { docId?: string }).docId
  if (typeof j?.templateId === 'string' && j.templateId) doc.templateId = j.templateId
  if (typeof j?.templateSamples === 'boolean') doc.templateSamples = j.templateSamples
  return doc
}

/** A template window's document (desktop Edit Template, docs/DECISIONS.md
 *  2026-09-28): `parseTemplateDoc`, plus two things the editor needs at
 *  runtime, held in memory only. A `templateId` — a legacy template gets one
 *  now, so every save writes the same id. And a `docId`, which autosave
 *  recovery, version history and per-document UI state are keyed on: the
 *  templateId itself, so it is stable across opens. `templateFileDoc` drops
 *  the docId again on every write. */
export function parseTemplateForEditing(raw: string): SlidomingoDoc | null {
  const doc = parseTemplateDoc(raw)
  if (!doc) return null
  doc.templateId ||= newDocId()
  doc.docId = doc.templateId
  return doc
}

/** What a template window writes into its file: the document stamped as a
 *  template (`stampAsTemplate`) — `template: true`, the same `templateId`,
 *  no `docId`/`basedOn`, and with `templateSamples: false` only a starter
 *  slide in place of whatever the editor holds. `templateId` = the window's
 *  own template identity, which always wins: a whole-document replace
 *  (Replace from JSON, a restored version) goes through `parseDoc`, which
 *  strips the id — the file must keep it anyway. */
export function templateFileDoc(doc: SlidomingoDoc, templateId?: string): SlidomingoDoc {
  const out = stampAsTemplate(doc, { templateId })
  if (templateId) out.templateId = templateId
  return out
}

/** The document File ▸ New Layout… starts from: a blank deck carrying a
 *  copy of the built-in slide types (so the Layout Manager has something
 *  to shape from the first second), stamped as a template without samples. */
export function newTemplateDoc(title: string): SlidomingoDoc {
  const doc = newDoc()
  doc.layouts = builtinLayouts(doc.size)
  const tmpl = stampAsTemplate(doc, { samples: false })
  tmpl.title = title
  return tmpl
}

export function parseDoc(json: string): SlidomingoDoc | null {
  try {
    const doc = JSON.parse(json)
    if (doc && doc.format === FORMAT && Array.isArray(doc.slides) && doc.slides.length > 0) {
      // Documents from before docId existed get one minted here; it persists
      // on the next save and stays stable from then on.
      if (typeof doc.docId !== 'string' || !doc.docId) doc.docId = newDocId()
      if (doc.template) {
        // template instantiation: this open IS a new document, based on
        // the template (its identity moves into provenance)
        delete doc.template
        doc.docId = newDocId()
        // (a template's own stray `basedOn` is ITS origin, not this deck's).
        // No filename here — `instantiateTemplate` adds the name when the
        // caller knows it; a legacy template without an id leaves none.
        if (typeof doc.templateId === 'string' && doc.templateId) doc.basedOn = { templateId: doc.templateId }
        else delete doc.basedOn
        delete doc.templateId
        delete doc.templateSamples
      }
      // Pre-multi-master file: `doc.master = {buildingBlocks, defaultLayoutId}`
      // becomes `doc.masters = [{id, buildingBlocks}]` + top-level
      // `defaultLayoutId`, converted in place — same idiom as the docId mint
      // above. Every existing single-master file re-saves in the new shape
      // and renders byte-identically (`doc.masters[0]` is exactly what
      // `doc.master` was; no `layout.masterId` needed to reach it).
      if (doc.master && typeof doc.master === 'object' && !doc.masters) {
        const old = doc.master as { buildingBlocks: Slide; defaultLayoutId?: string }
        doc.masters = [{ id: uid('master'), buildingBlocks: old.buildingBlocks }]
        if (old.defaultLayoutId && doc.defaultLayoutId === undefined) doc.defaultLayoutId = old.defaultLayoutId
        delete doc.master
      }
      // Pre-hierarchy file (2026-09-03's "Hierarchical layout masters," now
      // reversed — see docs/DECISIONS.md): `doc.masters[]` + each layout's
      // `masterId` becomes ordinary `doc.layouts` entries + `parentId`,
      // converted in place, immediately after the migration above (which
      // guarantees `doc.masters` exists by this point for any pre-hierarchy
      // file). Each master is reused VERBATIM — same id, same
      // (never-cloned) `buildingBlocks.elements` array — and appended to
      // `doc.layouts` as a synthetic root slide type, so every existing
      // `masterId` reference already names it correctly with zero remap.
      // Every existing layout's implicit "unset masterId → first master"
      // fallback becomes an explicit `parentId`. `doc.rootFontLayoutId`
      // preserves the old orphan-slide (no `layoutId` at all) font
      // fallback. Byte-identical: `effectiveLayout` on any pre-existing
      // layout now walks a 2-entry chain producing the exact same
      // concatenation `effectiveLayout` produced before, and nothing reads
      // `doc.layouts` positionally except manual-reorder UI and `?.[0]`
      // fallbacks that only fire when otherwise unset (unaffected by
      // appending synthetic roots at the tail).
      //
      // EXCEPT for a "ghost" master: `{id, buildingBlocks: emptySlide()}`
      // with no name, no font, no building-block elements — exactly the
      // shape the old `ensureMaster` minted the moment ANYONE so much as
      // opened the (now-removed) Building Blocks tab, even without adding
      // anything to it. It rendered nothing and showed no chrome in the old
      // UI (a single, never-configured master was explicitly designed to
      // need "zero configuration" and show no new UI — 2026-09-03 in
      // docs/DECISIONS.md). Promoting a ghost to a real, visible
      // `doc.layouts` root would surface an empty, unnamed slide-type card
      // out of nowhere — and worse, since unset `masterId` falls back to
      // `masters[0]`, it would nest EVERY OTHER slide type as its child the
      // moment it happens to be first in the array. So a ghost is dropped
      // outright, never minted as a layout, and anything that pointed at it
      // — explicitly, or via the unset-masterId-→-masters[0] fallback —
      // stays PARENTLESS instead of pointing at a deleted id. Still
      // byte-identical: a ghost contributes zero elements either way.
      if (Array.isArray(doc.masters) && doc.masters.length) {
        const masters = doc.masters as Array<{
          id: string
          name?: string
          buildingBlocks: Slide
          fontFamily?: string
          headingFamily?: string
        }>
        const isGhost = (m: (typeof masters)[number]) =>
          !m.name && !m.fontFamily && !m.headingFamily && m.buildingBlocks.elements.length === 0
        const ghostIds = new Set(masters.filter(isGhost).map((m) => m.id))
        const fallbackParentId = ghostIds.has(masters[0].id) ? undefined : masters[0].id
        doc.layouts = doc.layouts ?? []
        for (const layout of doc.layouts as Array<Slide & { masterId?: string }>) {
          const wanted = layout.masterId ?? fallbackParentId
          if (wanted && !ghostIds.has(wanted)) layout.parentId = wanted
          delete layout.masterId
        }
        for (const master of masters) {
          if (ghostIds.has(master.id)) continue
          doc.layouts.push({
            id: master.id,
            name: master.name,
            background: master.buildingBlocks.background,
            transition: master.buildingBlocks.transition,
            elements: master.buildingBlocks.elements,
            notes: '',
            fontFamily: master.fontFamily,
            headingFamily: master.headingFamily,
          } as Slide)
        }
        if (!doc.layouts.length) delete doc.layouts
        if (!ghostIds.has(masters[0].id)) doc.rootFontLayoutId = masters[0].id
        delete doc.masters
      }
      return doc as SlidomingoDoc
    }
  } catch {
    /* fall through */
  }
  return null
}
