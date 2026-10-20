// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The .pptx orchestrator — package in, ONE beeslides/slides document + fidelity
// report out. All the domain knowledge lives in the sibling modules (theme,
// inherit, media, text, shapes); this file owns the walks that stitch them
// together, and the walks are where a converter quietly loses whole decks:
//
//   - PART ROUTING IS RELS, NEVER NAMES. slide → layout → master → theme is a
//     chain of .rels hops; guessing "slideLayout1.xml" works on the demo file
//     and breaks on every deck with 2–4 masters (all six census decks).
//   - SLIDE ORDER IS p:sldIdLst ORDER, and z-order is spTree document order —
//     both formats agree, so the walk just has to not reorder anything.
//   - mc:AlternateContent is resolved with an EMPTY understood set: every
//     mc:Choice in the census requires an extension namespace (p14 morph
//     transitions and friends) whose semantics we do not implement, and the
//     Fallback is the producer's own hand-built downlevel rendering. Taking
//     it is strictly more honest than half-reading a Choice — and an mc-blind
//     walk would import Choice AND Fallback, i.e. everything twice.
//   - transition is 'none' UNLESS the slide declares one. slides' own
//     constructors default to 'fade' while 71 of 79 census slides specify no
//     transition (a hard cut), so absence must be written as 'none'.
//     p:transition maps onto the kinds present.ts draws (fade/push/wipe/
//     cover/split/zoom + transitionDir) — see transitionOf; the transition's
//     mc:Choice is read when it names one of those, else its Fallback. Morph
//     stays 'none': a failed morph pairing degrades WORSE than a cut (spike:
//     unwanted whole-slide fade), and PowerPoint pairs by name/content, not
//     by the ids this importer mints. Also imported: the click-build subset of
//     p:timing (convert/builds.ts): entrances and exits per click, "with/after
//     previous", by-paragraph text. Emphasis, motion paths and trigger
//     sequences are dropped, each with a report entry.
//   - BUILDS PIN A SLIDE TO ITS FLATTENED FORM when they touch a layout slot:
//     a linked slide's slot elements are fresh copies of the layout's on every
//     resync (only html/link ride along), so an fx.step on one would be wiped
//     by the first layout edit — the same reason any deviation unlinks.
//   - PRUNE (deck mode). 500 layout parts serve 79 slides — ~85% of the
//     package is dead template. Deck mode extracts only the layouts ≥1 slide
//     uses (and their masters); template mode — where the designs ARE the
//     product, e.g. a .potx with no slides — keeps every layout under every
//     master. Either way only media something emitted actually references
//     reaches doc.assets, or the file is megabytes of unreachable base64.
//   - MASTERS ARE ROOTS, LAYOUTS ARE CHILDREN. Each slideMaster becomes a
//     root doc.layouts entry `pptx-master-<m>` (background + decoration, NO
//     placeholder prompts — every child would show them twice; the master's
//     text styling reaches each layout prompt through textDefaults anyway).
//     Each slideLayout becomes `pptx-layout-<k>`, parentId → its master,
//     holding only its own shapes. m and k come from p:sldMasterIdLst /
//     p:sldLayoutIdLst (collectTemplate), so numbering is identical in both
//     modes. The model always composites the whole ancestor chain and cannot
//     hide an inherited element, so a layout the master must NOT show through
//     is DETACHED into a root with the master's decoration folded in — see
//     buildLayoutEntry for the three cases.
//   - LINK ONLY WHAT DOES NOT DEVIATE. A linked slide resyncs from its layout
//     (frame and typography always come from the layout, only html/link from
//     the slide), so linking a slide that deviates would silently revert the
//     deviation on the first master edit. tryLink builds what the resync
//     would produce and renderEquivalent proves it presents exactly like the
//     flattened slide; if not, the slide stays flattened (master + layout
//     chrome baked onto it, layoutId unset) and the report says why
//     ('slide-unlinked'). `{link:false}` flattens everything — that output is
//     the oracle the linking rig compares against. Per-element themeRefs
//     (re-branding an imported shape's colour when the palette changes
//     later) is a separate, larger follow-up — this pass gets
//     doc.theme.palette's VALUES right, not per-shape re-brandability.
//
// Element ids are DETERMINISTIC: `s<slideIndex>-<cNvPr id>` — the scheme
// shapes.ts mints, which is also what makes connector a:stCxn/a:endCxn refs
// resolve without a lookup table. The box-with-text split emits the text half
// as `s<n>-<spId>-t` immediately after its shape (later paints above), welded
// by groupId. Ids are unique per slide only, by design (the morph idiom).
// Master entries use `pm<m>-`, layout entries `pl<k>-`, and a LINKED slide
// carries those same ids for everything it inherits; a flattened slide's
// baked chrome keeps the per-slide `mst<n>-`/`ly<n>-` ids.

import { readZip, type ZipParts } from './zip.ts'
import {
  NS, parseXml, kid, kids, attr, intAttr, textOf, resolveAlternate, type XElem,
} from './xml.ts'
import { Report } from './report.ts'
import { applyBuilds, readBuilds } from './builds.ts'
import { parseTheme, resolveColor, resolveFillRef } from './theme.ts'
import {
  resolveFrame, effectivePhType, textDefaults, labeledChain, layoutLink, phOf, effIdx, type TextDefaults,
} from './inherit.ts'
import {
  parseRels, parseContentTypes, AssetStore, imageFrom, resolveBlip, altOf, pictureInset, insetFrame,
  type Rel, type ContentTypes,
} from './media.ts'
import { withListRequires } from './lists.ts'
import { textFrom, type TextDeps } from './text.ts'
import { tableFrom, parseTableStyles, usesTableSpans, TABLE_MERGE_FEATURE, type TableStyles } from './table.ts'
import { chartFrom } from './chart.ts'
import {
  shapeFrom, groupChildren, isHiddenShape, HIDDEN_SHAPE_DETAIL, type ShapeDeps, type GroupFrame,
} from './shapes.ts'
import {
  EMU_PER_PX, METRIC_SUBSTITUTES,
  type ConvertResult, type OutDoc, type OutSlide, type OutElement, type OutShape,
  type OutText, type OutImage, type OutTable, type InheritCtx, type ThemeCtx, type ConvertPptxOptions,
} from './types.ts'

const DC = 'http://purl.org/dc/elements/1.1/'
/** docProps/core.xml's own namespace (cp:keywords, cp:lastModifiedBy, …) —
 *  distinct from DC, which covers only the Dublin Core elements (title,
 *  creator, subject) core.xml also carries. */
const CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties'
/** docProps/app.xml's namespace — Company lives here, not in core.xml. */
const EP = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'
const dec = new TextDecoder()

/** EMU → px, 1/100px — the engine-wide convention media.ts set. */
const px = (emu: number): number => Math.round((emu / EMU_PER_PX) * 100) / 100
const r2 = (v: number): number => Math.round(v * 100) / 100

// --- package plumbing --------------------------------------------------------

function xmlOf(parts: ZipParts, name: string): XElem | undefined {
  const bytes = parts.get(name.replace(/^\//, ''))
  return bytes ? parseXml(dec.decode(bytes)) : undefined
}

/** The .rels for one part ('' = the package root → _rels/.rels). Missing or
 *  absent .rels reads as no relationships, never as an error — plenty of
 *  valid parts have none. */
function relsOf(parts: ZipParts, partName: string): Map<string, Rel> {
  const slash = partName.lastIndexOf('/')
  const dir = slash < 0 ? '' : partName.slice(0, slash + 1)
  const base = slash < 0 ? partName : partName.slice(slash + 1)
  const xml = xmlOf(parts, `${dir}_rels/${base}.rels`)
  return xml ? parseRels(xml, dir) : new Map()
}

/** First internal relationship whose type ends with `suffix` (the OPC type
 *  URIs all share long prefixes; the tail is the discriminator). */
function relOfType(rels: Map<string, Rel>, suffix: string): Rel | undefined {
  for (const r of rels.values()) if (!r.mode && r.type.endsWith(suffix)) return r
  return undefined
}

/** The r:id of a reference element. NOT attr(el, 'id'): p:sldId carries BOTH
 *  @id (the slide's number) and @r:id, and attr's exact-name-first match
 *  returns the wrong one. */
function rIdOf(el: XElem): string | undefined {
  for (const [k, v] of el.attrs) if (k !== 'id' && k.endsWith(':id')) return v
  return undefined
}

// --- shape bookkeeping -------------------------------------------------------

function cNvPrOf(el: XElem): XElem | undefined {
  for (const c of kids(el)) {
    const cnv = kid(c, NS.p, 'cNvPr')
    if (cnv) return cnv
  }
  return undefined
}

const cNvPrIdOf = (el: XElem): string => {
  const c = cNvPrOf(el)
  return c ? attr(c, 'id') ?? '0' : '0'
}

function whereOf(el: XElem, n: number, label = 'slide'): string {
  const c = cNvPrOf(el)
  const name = c && attr(c, 'name')
  return `${label} ${n} / sp ${name ? `"${name}"` : c ? attr(c, 'id') ?? '?' : '?'}`
}

/** Every cNvPr id in a tree (slide, layout or master spTree) — connector refs
 *  outside this set are dangling. Shared by the slide walk and layout/master
 *  extraction; the two trees' ids are unioned when a layout also pulls in its
 *  master's decoration, which is harmless (it only widens what counts as
 *  "known", never narrows it). */
function collectSpIds(list: Array<XElem | string>, spIds: Set<string>): void {
  for (const e of flattenMc(list)) {
    if (e.ns !== NS.p) continue
    if (e.local === 'grpSp') collectSpIds(e.children, spIds)
    else if (e.local === 'sp' || e.local === 'pic' || e.local === 'cxnSp' || e.local === 'graphicFrame') {
      spIds.add(cNvPrIdOf(e))
    }
  }
}

/** See the header: Choices all require extensions we do not implement, so the
 *  resolution set stays empty and every mc lands on its Fallback. */
const MC_NOTHING = new Set<string>()

function flattenMc(children: Array<XElem | string>): XElem[] {
  const out: XElem[] = []
  for (const c of children) {
    if (typeof c === 'string') continue
    if (c.ns === NS.mc && c.local === 'AlternateContent') {
      out.push(...flattenMc(resolveAlternate(c, MC_NOTHING)))
    } else out.push(c)
  }
  return out
}

// --- transitions ---------------------------------------------------------------

type Transition = OutSlide['transition']
type TransitionDir = NonNullable<OutSlide['transitionDir']>

/** ST_TransitionSideDirectionType names the way the slide MOVES; the model
 *  names where it comes FROM (model.ts TransitionDir) — so they flip. */
const FROM_SIDE: Record<string, TransitionDir> = { l: 'right', r: 'left', u: 'bottom', d: 'top' }

/** model.ts TRANSITION_DIRS' first entries — a dir equal to these is left
 *  absent, as the model does. */
const DEFAULT_DIR: Partial<Record<Transition, TransitionDir>> = {
  push: 'right', wipe: 'right', cover: 'right', split: 'vertical',
}

/** One p:transition's effect → a model transition, or undefined for an
 *  effect this table does not know (the caller then tries the next
 *  candidate). `exact: false` = the nearest kind, reported. */
function mapTransitionEffect(fx: XElem | undefined): { transition: Transition; dir?: TransitionDir; exact: boolean; morph?: boolean } | undefined {
  // an effect-less p:transition (only timing, sound or advance settings) is a cut
  if (!fx) return { transition: 'none', exact: true }
  const side = (dflt: string): TransitionDir => {
    const d = attr(fx, 'dir') ?? dflt
    return FROM_SIDE[d[0]] ?? FROM_SIDE[dflt]
  }
  switch (fx.local) {
    case 'fade': return { transition: 'fade', exact: attr(fx, 'thruBlk') !== '1' && attr(fx, 'thruBlk') !== 'true' }
    case 'push': return { transition: 'push', dir: side('l'), exact: true }
    case 'wipe': return { transition: 'wipe', dir: side('l'), exact: true }
    case 'cover': {
      // eight directions; a diagonal keeps its horizontal half
      const d = attr(fx, 'dir') ?? 'l'
      return { transition: 'cover', dir: FROM_SIDE[d[0]] ?? 'right', exact: d.length === 1 }
    }
    case 'split': {
      // orient: the seam's direction (default horz); dir in = closing, which
      // present.ts does not draw — the opening split stands in for it
      const orient = attr(fx, 'orient') ?? 'horz'
      return { transition: 'split', dir: orient === 'vert' ? 'vertical' : 'horizontal', exact: attr(fx, 'dir') !== 'in' }
    }
    case 'cut': return { transition: 'none', exact: attr(fx, 'thruBlk') !== '1' && attr(fx, 'thruBlk') !== 'true' }
    case 'zoom': return { transition: 'zoom', exact: false }
    // the nearest drawn kind for the common relatives
    case 'pull': return { transition: 'push', dir: side('l'), exact: false } // Uncover
    case 'pan': return { transition: 'push', dir: side('u'), exact: false } // p14:pan
    case 'doors': return { transition: 'split', dir: attr(fx, 'dir') === 'horz' ? 'horizontal' : 'vertical', exact: false } // p14:doors
    case 'window': return { transition: 'split', dir: attr(fx, 'dir') === 'horz' ? 'horizontal' : 'vertical', exact: false } // p14:window
    case 'dissolve': case 'reveal': case 'flash': case 'randomBar': case 'blinds': case 'checker':
    case 'circle': case 'diamond': case 'plus': case 'wedge': case 'wheel': case 'strips': case 'newsflash':
    case 'random': case 'comb':
      return { transition: 'fade', exact: false }
    case 'morph': return { transition: 'none', exact: false, morph: true }
    default: return undefined
  }
}

/**
 * A slide's p:transition → `transition` + `transitionDir`. Candidates in
 * order: a bare p:transition, then each mc:Choice's (PowerPoint 2010+ wraps
 * its p14/p15/p159 effects in one) and finally the mc:Fallback's — the first
 * one whose effect the table knows wins, so a p14 Pan we can approximate
 * beats its Fallback fade, and an unknown p15 effect falls back to the
 * producer's own downlevel choice (reported: the deck's effect is gone).
 * Morph is caught explicitly and stays a cut (see the header) instead of
 * falling back to its whole-slide fade.
 * Nothing at all: 'none'. Something unknown everywhere: a fade, reported.
 */
function transitionOf(sld: XElem, report: Report, where: string): { transition: Transition; dir?: TransitionDir } {
  const candidates: XElem[] = []
  for (const c of kids(sld)) {
    if (c.ns === NS.p && c.local === 'transition') candidates.push(c)
    else if (c.ns === NS.mc && c.local === 'AlternateContent') {
      for (const branch of [...kids(c, NS.mc, 'Choice'), ...kids(c, NS.mc, 'Fallback')]) {
        const t = kid(branch, NS.p, 'transition')
        if (t) candidates.push(t)
      }
    }
  }
  if (!candidates.length) return { transition: 'none' }
  // the first effect passed over as unknown: when a later candidate (the
  // producer's Fallback) wins, the deck's real effect was still replaced
  let skipped: string | undefined
  for (const t of candidates) {
    const fx = kids(t).find((k) => k.local !== 'sndAc' && k.local !== 'extLst')
    const m = mapTransitionEffect(fx)
    if (!m) { skipped ??= fx?.local ?? '?'; continue }
    if (m.morph) {
      report.add('dropped', 'transition-morph-dropped', where,
        'a Morph transition is imported as a cut — PowerPoint pairs shapes by name and content, which this import does not reproduce')
      return { transition: 'none' }
    }
    const as = m.transition === 'none' ? 'a cut' : `"${m.transition}"`
    if (skipped !== undefined) {
      report.add('approximated', 'transition-approximated', where,
        `the "${skipped}" transition has no counterpart — imported as the deck's fallback ${as}`)
    } else if (!m.exact) {
      report.add('approximated', 'transition-approximated', where,
        `the "${fx!.local}" transition has no exact counterpart — imported as ${as}`)
    }
    return m.dir && m.dir !== DEFAULT_DIR[m.transition]
      ? { transition: m.transition, dir: m.dir }
      : { transition: m.transition }
  }
  const unknown = kids(candidates[0]).find((k) => k.local !== 'sndAc' && k.local !== 'extLst')
  report.add('approximated', 'transition-approximated', where,
    `the "${unknown?.local ?? '?'}" transition has no counterpart — imported as a fade`)
  return { transition: 'fade' }
}

// --- background --------------------------------------------------------------

const BG_FILLS = new Set(['solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'noFill'])

/** Cheapest honest read of a gradient when the target is one colour: the
 *  lowest-position stop (the gradient's visual anchor). */
function lowestStop(grad: XElem, theme: ThemeCtx, phClr: string | undefined): string | undefined {
  const lst = kid(grad, NS.a, 'gsLst')
  if (!lst) return undefined
  let best: string | undefined
  let bestPos = Infinity
  for (const gs of kids(lst, NS.a, 'gs')) {
    const pos = intAttr(gs, 'pos')
    const c = resolveColor(gs, theme, phClr)
    if (c && pos < bestPos) { best = c.css; bestPos = pos }
  }
  return best
}

export interface BackgroundResult { color: string; image?: OutImage }

/**
 * background from p:bg, walked own → layout → master; the FIRST level
 * declaring a p:bg settles the question (a nearer bg overrides, never
 * merges). Used for both slides (ctx = {slide,layout,master}) and layout
 * extraction (ctx = {slide: layoutXml, master: masterXml} — the layout plays
 * the "own" role, matching how resolveFrame/textDefaults already work with a
 * 2-level ctx). slidomingo's `background` field is one colour, so a gradient
 * flattens to its first stop with a report; a picture background resolves
 * through resolveBlip and comes back as a full-bleed image ALONGSIDE a solid
 * fallback colour, for any reader that only looks at `background`. Default
 * white — the one colour a missing background actually paints.
 *
 * `relsFor` picks the .rels map matching whichever level's p:bg actually won
 * — an own-level background needs the caller's own rels, a master-level one
 * needs the master's, and blip r:embed ids are meaningless outside their part.
 */
function backgroundOf(
  ctx: InheritCtx,
  size: { width: number; height: number },
  where: string,
  idPrefix: string,
  relsFor: (from: 'own' | 'layout' | 'master') => Map<string, Rel>,
  assets: AssetStore,
): BackgroundResult {
  const report = ctx.report
  const levels: Array<{ root: XElem | undefined; from: 'own' | 'layout' | 'master' }> = [
    { root: ctx.slide, from: 'own' },
    { root: ctx.layout, from: 'layout' },
    { root: ctx.master, from: 'master' },
  ]
  for (const { root, from } of levels) {
    const cSld = root && kid(root, NS.p, 'cSld')
    const bg = cSld && kid(cSld, NS.p, 'bg')
    if (!bg) continue

    const bgPr = kid(bg, NS.p, 'bgPr')
    if (bgPr) {
      const fill = kids(bgPr, NS.a).find((k) => BG_FILLS.has(k.local))
      if (!fill || fill.local === 'noFill') {
        report.trace('background', from)
        return { color: '#FFFFFF' }
      }
      if (fill.local === 'solidFill') {
        const c = resolveColor(fill, ctx.theme)
        if (c) { report.trace('background', from); return { color: c.css } }
        report.add('dropped', 'background-unresolved', where,
          'background colour did not resolve — painted white')
        return { color: '#FFFFFF' }
      }
      if (fill.local === 'gradFill') {
        const c = lowestStop(fill, ctx.theme, undefined)
        if (c) {
          report.add('approximated', 'background-approximated', where,
            'gradient background flattened to its first stop — the background is one colour')
          report.trace('background', from)
          return { color: c }
        }
        report.add('dropped', 'background-unresolved', where,
          'gradient background had no resolvable stop — painted white')
        return { color: '#FFFFFF' }
      }
      if (fill.local === 'blipFill') {
        const key = resolveBlip(fill, ctx, relsFor(from), assets, where)
        if (key !== undefined) {
          report.add('approximated', 'background-image-imported', where,
            'a picture background is approximated as a full-bleed image — crop/tile are not modelled')
          report.trace('background', from)
          return {
            color: '#FFFFFF',
            image: {
              id: `${idPrefix}-bg`, type: 'image',
              x: 0, y: 0, w: size.width, h: size.height, rotation: 0, opacity: 1,
              // full-bleed scenery: click-through in the editor (still reachable
              // via right-click ▸ Select) so it can't be grabbed by accident
              locked: true,
              src: `asset:${key}`, fit: 'cover',
            },
          }
        }
        // resolveBlip already reported the specific reason (missing rel/part,
        // external, wdp) — no second, generic report here.
        return { color: '#FFFFFF' }
      }
      report.add('dropped', 'background-image-dropped', where,
        `a:${fill.local} background has no slidomingo counterpart — painted white`)
      return { color: '#FFFFFF' }
    }

    const bgRef = kid(bg, NS.p, 'bgRef')
    if (bgRef) {
      const idx = intAttr(bgRef, 'idx')
      if (idx === 0) { report.trace('background', from); return { color: '#FFFFFF' } }
      // bgRef's colour child is the phClr; resolveFillRef wants bare hex
      const ph = resolveColor(bgRef, ctx.theme)
      const phClr = ph && ph.css.startsWith('#') ? ph.css : '#FFFFFF'
      const got = resolveFillRef(idx, phClr, ctx.theme)
      if (got) {
        if (got.kind === 'none') { report.trace('background', from); return { color: '#FFFFFF' } }
        if (got.kind === 'solid') { report.trace('background', 'theme'); return { color: got.color.css } }
        if (got.el.local === 'gradFill') {
          const c = lowestStop(got.el, ctx.theme, got.phClr)
          if (c) {
            report.add('approximated', 'background-approximated', where,
              'theme gradient background flattened to its first stop — the background is one colour')
            report.trace('background', 'theme')
            return { color: c }
          }
        }
      }
      report.add('dropped', 'background-unresolved', where,
        `a:bgRef idx="${idx}" did not resolve — painted white`)
      return { color: '#FFFFFF' }
    }
  }
  report.trace('background', 'default')
  return { color: '#FFFFFF' }
}

// --- notes -------------------------------------------------------------------

/** Plain text from a notesSlide part: the body placeholder(s) only. sldImg is
 *  the slide's own thumbnail (census: 14) and sldNum/hdr/ftr/dt are page
 *  furniture — none of them are the speaker's words. */
function notesTextOf(notesXml: XElem): string {
  const cSld = kid(notesXml, NS.p, 'cSld')
  const tree = cSld && kid(cSld, NS.p, 'spTree')
  if (!tree) return ''
  const out: string[] = []
  for (const sp of kids(tree, NS.p, 'sp')) {
    let phType = ''
    for (const c of kids(sp)) {
      const nv = kid(c, NS.p, 'nvPr')
      const ph = nv && kid(nv, NS.p, 'ph')
      if (ph) { phType = attr(ph, 'type') ?? ''; break }
    }
    if (phType !== 'body') continue
    const tb = kid(sp, NS.p, 'txBody')
    if (!tb) continue
    const text = kids(tb, NS.a, 'p').map((p) => textOf(p)).join('\n').trim()
    if (text) out.push(text)
  }
  return out.join('\n')
}

// --- misc --------------------------------------------------------------------

const cssFace = (name: string): string => (/[^A-Za-z0-9-]/.test(name) ? `'${name}'` : name)

/** The theme face as a CSS stack: the original first (a machine that has the
 *  real font uses it), its metric-compatible substitute second. */
function fontStack(face: string): string {
  const sub = METRIC_SUBSTITUTES[face]
  return sub ? `${cssFace(face)}, ${cssFace(sub)}, sans-serif` : `${cssFace(face)}, sans-serif`
}

function picFlipped(pic: XElem): boolean {
  const spPr = kid(pic, NS.p, 'spPr')
  const xf = spPr && kid(spPr, NS.a, 'xfrm')
  const f = (v: string | undefined): boolean => v === '1' || v === 'true'
  return xf !== undefined && (f(attr(xf, 'flipH')) || f(attr(xf, 'flipV')))
}

function coreTitle(parts: ZipParts, rootRels: Map<string, Rel>): string | undefined {
  const rel = relOfType(rootRels, '/core-properties')
  const core = xmlOf(parts, rel ? rel.target : 'docProps/core.xml')
  if (!core) return undefined
  const t = kid(core, DC, 'title')
  const s = t ? textOf(t).trim() : ''
  return s || undefined
}

/** doc.meta fields recoverable from the package's own metadata parts —
 *  docProps/core.xml (author/subject/keywords) and docProps/app.xml
 *  (company, a different part and namespace entirely). Absent/empty
 *  fields are omitted so an empty object never displaces a value a later
 *  merge step might otherwise have set. */
function coreMeta(parts: ZipParts, rootRels: Map<string, Rel>): OutDoc['meta'] {
  const text = (el: XElem | undefined) => { const s = el ? textOf(el).trim() : ''; return s || undefined }

  const coreRel = relOfType(rootRels, '/core-properties')
  const core = xmlOf(parts, coreRel ? coreRel.target : 'docProps/core.xml')
  const author = core ? text(kid(core, DC, 'creator')) : undefined
  const subject = core ? text(kid(core, DC, 'subject')) : undefined
  const keywords = core ? text(kid(core, CP, 'keywords')) : undefined

  const appRel = relOfType(rootRels, '/extended-properties')
  const app = xmlOf(parts, appRel ? appRel.target : 'docProps/app.xml')
  const company = app ? text(kid(app, EP, 'Company')) : undefined

  if (!author && !company && !subject && !keywords) return undefined
  return { author, company, subject, keywords }
}

/** A theme for packages whose chain is broken: empty scheme, Calibri faces.
 *  Lazily built so the module costs nothing to import. */
let emptyThemeCache: ThemeCtx | undefined
const emptyTheme = (): ThemeCtx =>
  (emptyThemeCache ??= parseTheme(parseXml(`<a:theme xmlns:a="${NS.a}"/>`), undefined))

interface MasterBundle { theme: ThemeCtx; themeXml?: XElem }

// --- tree walking (shared by slides and layout/master extraction) -----------

/** Everything the shared walker needs beyond ctx: where output lands, the
 *  id/report-label scheme for this tree, and (slides only) a title-text
 *  sniffer. One `elements` array is threaded through so a caller can seed it
 *  (a background image) or layer multiple trees into it (master decoration
 *  under a layout's own shapes) before/after walking. */
/**
 * What the graphicFrame importers need from the PACKAGE rather than from the
 * part being walked: the raw parts (a chart is its own part, reached through
 * the walked part's rels) and the deck's table styles. Keyed by the
 * conversion's AssetStore — the one package handle every tree walk already
 * carries — so the walk signatures stay as they are. One entry per
 * convertPptx call; the WeakMap lets it go with the store.
 */
interface GraphicPkg { parts: ZipParts; tableStyles: TableStyles }
const graphicPkgs = new WeakMap<AssetStore, GraphicPkg>()

interface TreeOpts {
  rels: Map<string, Rel>
  assets: AssetStore
  /** 's' (slides, the default elsewhere); 'pm'/'pl' (master/layout entries,
   *  and what a linked slide inherits); 'mst'/'ly' (chrome baked onto a
   *  flattened slide) — see shapes.ts's ID SCHEME note. */
  idPrefix: string
  /** slide position, or the master's m / the layout's k */
  n: number
  spIds: Set<string>
  elements: OutElement[]
  /** 'slide' / 'layout' / 'master' — feeds shapes.ts/pptx.ts `where` labels */
  whereLabel: string
  /** slides only: called with a title placeholder's text the first time one
   *  is seen (the caller decides whether it's the FIRST title doc-wide) */
  onTitle?: (text: string) => void
}

/**
 * Convert one non-placeholder sp/cxnSp/pic/grpSp/graphicFrame into `opts.elements`.
 * This is the generalized form of what used to be convertPptx's per-slide
 * `emit` closure: identical shape/text/image/group/graphicFrame handling,
 * parameterized so slides, extracted layouts, and master decoration all run
 * through ONE implementation rather than three copies that drift.
 */
function emitShapeOrText(
  el: XElem, ctx: InheritCtx, opts: TreeOpts, frame?: GroupFrame, groupId?: string,
): void {
  if (el.ns !== NS.p) return
  const local = el.local
  const { idPrefix, n, spIds, elements, rels, assets, whereLabel } = opts
  if (isHiddenShape(el)) {
    ctx.report.add('carried', 'hidden-shape-skipped', whereOf(el, n, whereLabel), HIDDEN_SHAPE_DETAIL)
    return
  }

  if (local === 'sp' || local === 'cxnSp') {
    const spId = cNvPrIdOf(el)
    const deps: ShapeDeps = { slideIndex: n, spIds, idPrefix, whereLabel }
    if (frame) deps.frame = frame
    if (groupId) deps.groupId = groupId
    const res = shapeFrom(el, ctx, deps)
    if (res) elements.push(res.shape)
    if (local === 'cxnSp') return // connectors carry no txBody

    if (opts.onTitle) {
      const t = effectivePhType(el, ctx)
      if (t === 'title' || t === 'ctrTitle') {
        const tb = kid(el, NS.p, 'txBody')
        const s = tb ? textOf(tb).replace(/\s+/g, ' ').trim() : ''
        if (s) opts.onTitle(s)
      }
    }

    let refitPending = false
    const baseTextDeps: TextDeps = {
      effectivePhType, textDefaults, resolveFrame, labeledChain, resolveColor,
      needsRefit: () => { refitPending = true },
      where: whereOf(el, n, whereLabel),
    }
    // group members carry their COMPOSED frame; textFrom must see it, not
    // the leaf's own local-coordinate xfrm
    const tdeps: TextDeps = frame
      ? { ...baseTextDeps, resolveFrame: () => ({ ...frame, from: 'own' as const }) }
      : baseTextDeps
    const text = textFrom(el, ctx, tdeps)
    // a slide's own placeholder says what it is, linked or not, so "Change
    // layout…" (and a later restyle onto another layout) can pour it into
    // the right slot instead of leaving it floating
    if (text && whereLabel === 'slide' && phOf(el)) {
      const phType = effectivePhType(el, ctx)
      const footer = SLIDE_FOOTER_ROLES[phType]
      if (footer) text.footerRole = footer
      else if (!MEDIA_PH_TYPES.has(phType)) text.role = (TITLE_ROLE_PROMPT[phType] ?? { role: 'body' }).role
    }
    if (text) {
      if (res) {
        // the box-with-text split: text right after its shape (later paints
        // above), welded by groupId so they move as one object
        const gid = res.textGroupId ?? res.shape.groupId ?? `${idPrefix}${n}-${spId}-g`
        res.shape.groupId = gid
        text.groupId = gid
        text.id = `${idPrefix}${n}-${spId}-t`
      } else {
        text.id = `${idPrefix}${n}-${spId}`
        if (groupId) text.groupId = groupId
      }
      elements.push(text)
      if (refitPending) {
        ctx.report.add('approximated', 'text-needs-refit', `${whereLabel} ${n}`,
          'text box relies on autofit (or substituted font metrics) — the host must re-measure through the shell')
      }
    }
    return
  }

  if (local === 'pic') {
    const where = whereOf(el, n, whereLabel)
    const img = imageFrom(el, ctx, rels, assets, where)
    if (!img) return
    img.id = `${idPrefix}${n}-${cNvPrIdOf(el)}`
    if (frame) {
      img.x = px(frame.x); img.y = px(frame.y)
      img.w = px(frame.w); img.h = px(frame.h)
      img.rotation = r2(frame.rotation)
    } else if (img.w === 0 && img.h === 0) {
      // picture placeholder (census: 122 p:ph type=pic) — the frame lives
      // up the chain, exactly as for shapes
      const fr = resolveFrame(el, ctx)
      img.x = px(fr.x); img.y = px(fr.y)
      img.w = px(fr.w); img.h = px(fr.h)
      img.rotation = r2(fr.rotation)
    }
    // a negative srcRect side is padding around the picture: trim the box
    // to the painted part (media.ts pictureInset), after the frame is final
    insetFrame(img, pictureInset(el))
    if (groupId) img.groupId = groupId
    if (frame ? frame.flipH || frame.flipV : picFlipped(el)) {
      ctx.report.add('approximated', 'flip-dropped', where,
        'flipH/flipV on a picture has no slidomingo field — rendered unflipped')
    }
    elements.push(img)
    return
  }

  if (local === 'grpSp') {
    const deps: ShapeDeps = { slideIndex: n, spIds, idPrefix, whereLabel }
    if (groupId) deps.groupId = groupId
    for (const leaf of groupChildren(el, ctx, deps)) emitShapeOrText(leaf.el, ctx, opts, leaf.frame, leaf.groupId)
    return
  }

  if (local === 'graphicFrame') {
    // tables (convert/table.ts) and charts (convert/chart.ts) become native
    // elements; anything they cannot represent — and every other graphic
    // (SmartArt, OLE, …) — leaves a placeholder box and an honest report
    const where = whereOf(el, n, whereLabel)
    const graphic = kid(el, NS.a, 'graphic')
    const gd = graphic && kid(graphic, NS.a, 'graphicData')
    const fr: GroupFrame = frame ?? resolveFrame(el, ctx)
    const id = `${idPrefix}${n}-${cNvPrIdOf(el)}`
    const pkg = graphicPkgs.get(assets)
    const tbl = gd && kid(gd, NS.a, 'tbl')
    const chartRef = gd && kids(gd).find((c) => c.ns === NS.c && c.local === 'chart')
    if (tbl) {
      // the importers are new and the parts they read are third-party XML:
      // anything they choke on costs this one frame its native element, never
      // the deck (convertPptx throws only for a package that is no
      // presentation at all)
      let table: OutTable | undefined
      let failed = false
      try {
        table = tableFrom(tbl, fr, ctx, pkg?.tableStyles ?? { byId: new Map() }, where)
      } catch {
        failed = true
      }
      if (table) {
        table.id = id
        if (groupId) table.groupId = groupId
        elements.push(table)
        return
      }
      ctx.report.add('dropped', 'table-unreadable', where, failed
        ? 'the table could not be read — a placeholder box marks the spot'
        : 'the table has no grid or no rows — a placeholder box marks the spot')
    } else if (chartRef) {
      const relId = rIdOf(chartRef)
      const rel = relId ? rels.get(relId) : undefined
      let space: XElem | undefined
      let res: ReturnType<typeof chartFrom>
      let broken = false
      try {
        space = rel && !rel.mode && pkg ? xmlOf(pkg.parts, rel.target) : undefined
        res = space ? chartFrom(space, fr, ctx, where) : undefined
      } catch {
        broken = true
        res = undefined
      }
      if (broken) {
        ctx.report.add('dropped', 'chart-unreadable', where,
          'the chart part is not readable XML (or not a chart we can read) — a placeholder box marks the spot')
      } else if (!space) {
        ctx.report.add('dropped', 'chart-unreadable', where,
          'the chart part is missing from the package — a placeholder box marks the spot')
      }
      if (res) {
        res.chart.id = id
        const alt = altOf(cNvPrOf(el))
        if (alt !== undefined) res.chart.alt = alt
        if (res.title) {
          // the title strip rides with its chart: welded by groupId, painted
          // after it (the box-with-text split's id/groupId convention)
          const gid = groupId ?? `${id}-g`
          res.chart.groupId = gid
          res.title.id = `${id}-t`
          res.title.groupId = gid
          elements.push(res.chart, res.title)
        } else {
          if (groupId) res.chart.groupId = groupId
          elements.push(res.chart)
        }
        return
      }
    } else {
      ctx.report.add('dropped', 'graphic-dropped', where,
        `graphicFrame content (${gd ? attr(gd, 'uri') ?? 'unknown' : 'empty'}) has no importer — a placeholder box marks the spot`)
    }
    const box: OutShape = {
      id, type: 'shape', shape: 'rect',
      x: px(fr.x), y: px(fr.y), w: px(fr.w), h: px(fr.h),
      rotation: r2(fr.rotation), opacity: 1,
      fill: 'transparent', stroke: '#9AA3AD', strokeWidth: 1, radius: 0,
      strokeStyle: 'dashed',
    }
    if (groupId) box.groupId = groupId
    elements.push(box)
  }
}

// --- layout extraction --------------------------------------------------------

/** role + placeholder prompt for a title/subtitle placeholder type — the
 *  slidomingo model.ts `ph()` convention, not the layout XML's own
 *  instructional text ("Click to edit Master title style" etc, ignored). */
const TITLE_ROLE_PROMPT: Record<string, { role: string; prompt: string }> = {
  title: { role: 'title', prompt: 'Click to add title' },
  ctrTitle: { role: 'title', prompt: 'Click to add title' },
  subTitle: { role: 'subtitle', prompt: 'Click to add subtitle' },
}

/** ph@type values that mean "a picture/video/chart/table goes here" — mapped
 *  to the same dashed-border box model.ts's mediaPh() produces. */
const MEDIA_PH_TYPES = new Set(['pic', 'clipArt', 'media', 'chart', 'tbl', 'dgm'])

/** ph@type values that are page furniture, not content slots. */
const FURNITURE_PH_TYPES = new Set(['ftr', 'dt', 'sldNum', 'hdr'])

/** Furniture placeholder type → slides/src/model.ts `FooterRole`. */
const SLIDE_FOOTER_ROLES: Record<string, 'date' | 'slideNumber' | 'footer'> = { dt: 'date', sldNum: 'slideNumber', ftr: 'footer' }

const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** text.ts's rounding for lineHeight — layout prompts must round the same way
 *  as slide text, or a linked slot and its flattened twin differ by 0.005. */
const round3 = (v: number): number => Math.round(v * 1000) / 1000

/** A furniture placeholder's text as one line: runs verbatim, a:fld
 *  slidenum/datetime* as {{page}}/{{date}} (exact dynamic-field matches, same
 *  as text.ts's a:fld handling), any other field as its cached text — so
 *  "Page ‹Nr.›" keeps its "Page ". A dt/sldNum whose text holds no field (an
 *  empty placeholder, or one typed over) is still that field: the bare token.
 *  ftr/hdr with nothing typed into them are dropped SILENTLY — page furniture
 *  with no content is not a slot worth showing. */
function furnitureHtml(phType: string, el: XElem): string | undefined {
  const tb = kid(el, NS.p, 'txBody')
  const lines: string[] = []
  for (const p of tb ? kids(tb, NS.a, 'p') : []) {
    let line = ''
    for (const c of kids(p, NS.a)) {
      if (c.local === 'br') { line += ' '; continue }
      if (c.local !== 'r' && c.local !== 'fld') continue
      const type = c.local === 'fld' ? attr(c, 'type') ?? '' : ''
      if (type === 'slidenum') line += '{{page}}'
      else if (type.startsWith('datetime')) line += '{{date}}'
      else {
        const t = kid(c, NS.a, 't')
        line += escHtml(t ? textOf(t) : '')
      }
    }
    lines.push(line)
  }
  const s = lines.join(' ').replace(/\s+/g, ' ').trim()
  const token = phType === 'dt' ? '{{date}}' : phType === 'sldNum' ? '{{page}}' : undefined
  if (token) return s.includes(token) ? s : token
  return s || undefined
}

/** Effective ink for a layout placeholder prompt: its resolved defRPr colour,
 *  else theme tx1, else black — the same cascade textFrom's inkFor uses,
 *  minus the run-level sources a promptless placeholder never has. */
function promptColor(d: TextDefaults, ctx: InheritCtx): string {
  if (d.color) {
    const c = resolveColor(d.color, ctx.theme)
    if (c) return c.css
  }
  return ctx.theme.scheme['tx1'] ?? '#000000'
}

/** bodyPr anchor, walked own → layout → master (per-attribute, like
 *  bodyInsets) — text.ts's anchor logic, minimal since a fresh placeholder
 *  prompt never has autofit/multi-level nuance to carry. */
function anchorOf(el: XElem, ctx: InheritCtx): 'top' | 'middle' | 'bottom' {
  for (const link of labeledChain(el, ctx)) {
    const tb = kid(link.el, NS.p, 'txBody')
    const bp = tb ? kid(tb, NS.a, 'bodyPr') : undefined
    const a = bp ? attr(bp, 'anchor') : undefined
    if (a !== undefined) return a === 'ctr' ? 'middle' : a === 'b' ? 'bottom' : 'top'
  }
  return 'top'
}

/** ftr/dt/sldNum/hdr visibility: the nearest explicit p:hf@<phType> along
 *  layout → master wins — p:hf lives only on sldLayout/sldMaster in the
 *  OOXML schema (CT_Slide carries none), so the slide itself is never a
 *  source. Absent anywhere (no p:hf, or the attribute unset) defaults to
 *  shown, the spec's own default. */
function furnitureVisible(
  phType: string, layoutXml: XElem | undefined, masterXml: XElem | undefined,
): boolean {
  for (const root of [layoutXml, masterXml]) {
    if (!root) continue
    const hf = kid(root, NS.p, 'hf')
    if (!hf) continue
    const v = attr(hf, phType)
    if (v !== undefined) return v !== '0' && v !== 'false'
  }
  return true
}

/**
 * One layout placeholder's slot — what a linked slide's content fills. Keyed
 * (in LayoutEntry.slots) by the LAYOUT placeholder's cNvPr id, which is what
 * inherit.ts's layoutLink hands back for a slide placeholder. `id` is the
 * text element (title/body/furniture) or the dashed box (media); `shapeId` is
 * the box-with-text split's shape half, when the placeholder has a fill/line.
 */
interface Slot { kind: 'text' | 'media'; id: string; shapeId?: string }

/**
 * A layout's own p:ph shape → a slidomingo placeholder element: title/subtitle
 * prompts, a media dashed-box, furniture text, or (default) a body prompt —
 * see the header's phType → role table. Never reads the layout XML's own
 * instructional text. `ctx.slide` is the LAYOUT (the 2-level layout ctx), so
 * p:hf furniture visibility is read from ctx.slide → ctx.master. A filled or
 * outlined placeholder keeps its box: the shape half is emitted through the
 * same shapeFrom as slides, split and welded exactly as emitShapeOrText does
 * it (`-t` text id, shared `-g` groupId) — a slide placeholder inheriting
 * that fill paints the same box, so the slot must too.
 */
function emitLayoutPlaceholder(el: XElem, phType: string, ctx: InheritCtx, opts: TreeOpts): Slot | undefined {
  const { idPrefix, n, elements } = opts
  const id = `${idPrefix}${n}-${cNvPrIdOf(el)}`
  const fr = resolveFrame(el, ctx)
  const x = px(fr.x), y = px(fr.y), w = px(fr.w), h = px(fr.h)
  const rotation = r2(fr.rotation)

  if (MEDIA_PH_TYPES.has(phType)) {
    const box: OutShape = {
      id, type: 'shape', shape: 'rect', x, y, w, h, rotation, opacity: 1,
      fill: '#EEF1F5', stroke: '#C9D2DE', strokeWidth: 1.5, strokeStyle: 'dashed', radius: 8,
      role: 'media',
    }
    elements.push(box)
    return { kind: 'media', id }
  }

  let text: OutText
  if (FURNITURE_PH_TYPES.has(phType)) {
    if (!furnitureVisible(phType, ctx.slide, ctx.master)) return undefined
    const html = furnitureHtml(phType, el)
    if (html === undefined) return undefined
    const d = textDefaults(el, ctx, 0, phType)
    text = {
      id, type: 'text', x, y, w, h, rotation, opacity: 1,
      html, fontSize: r2(d.fontSize * (4 / 3)), fontFamily: fontStack(d.font),
      fontWeight: d.bold ? 700 : 400, color: promptColor(d, ctx), align: d.align,
      valign: anchorOf(el, ctx), lineHeight: round3(d.lineHeight),
    }
    // the deck's Header & Footer switches (doc.headerFooter) reach it
    const footerRole = SLIDE_FOOTER_ROLES[phType]
    if (footerRole) text.footerRole = footerRole
  } else {
    const spec = TITLE_ROLE_PROMPT[phType] ?? { role: 'body', prompt: 'Click to add text' }
    const d = textDefaults(el, ctx, 0, phType || 'body')
    text = {
      id, type: 'text', x, y, w, h, rotation, opacity: 1,
      html: '', placeholder: spec.prompt,
      fontSize: r2(d.fontSize * (4 / 3)), fontFamily: fontStack(d.font),
      fontWeight: d.bold ? 700 : 400, color: promptColor(d, ctx), align: d.align,
      valign: anchorOf(el, ctx), lineHeight: round3(d.lineHeight),
      role: spec.role,
    }
  }

  const res = el.local === 'sp'
    ? shapeFrom(el, ctx, { slideIndex: n, spIds: opts.spIds, idPrefix, whereLabel: opts.whereLabel })
    : undefined
  if (res) {
    const gid = res.textGroupId ?? res.shape.groupId ?? `${id}-g`
    res.shape.groupId = gid
    text.groupId = gid
    text.id = `${id}-t`
    elements.push(res.shape, text)
    return { kind: 'text', id: text.id, shapeId: res.shape.id }
  }
  elements.push(text)
  return { kind: 'text', id }
}

/** ST_SlideLayoutType → a friendly name, for layouts with no cSld/@name (the
 *  common case — authored layouts are usually named, but PowerPoint's own
 *  built-ins often aren't). Falls back to the raw type, then `Layout N`. */
const LAYOUT_TYPE_LABELS: Record<string, string> = {
  title: 'Title Slide',
  obj: 'Title and Content',
  secHead: 'Section Header',
  twoObj: 'Two Content',
  twoTxTwoObj: 'Two Content and Text',
  titleOnly: 'Title Only',
  tx: 'Title and Text',
  txOnly: 'Text Only',
  picTx: 'Picture with Caption',
  vertTx: 'Vertical Text',
  clipArtAndTx: 'Clip Art and Text',
  blank: 'Blank',
}

function layoutTypeLabel(layoutXml: XElem, n: number): string {
  const t = attr(layoutXml, 'type')
  if (!t) return `Layout ${n}`
  return LAYOUT_TYPE_LABELS[t] ?? t
}

/** Fraction-of-a-pixel slack for "the same box" — xfrm EMU round to 1/100px. */
const COVER_EPS = 0.5

/** `top` paints every pixel of `low`'s box: an unrotated, fully opaque
 *  picture that fills its own box (not `contain`, no rounded corners) whose
 *  box holds `low`'s. */
function covers(top: OutElement, low: OutElement, assets: AssetStore): boolean {
  if (top.type !== 'image' || top.rotation !== 0 || low.rotation !== 0) return false
  if (top.opacity !== 1 || top.fit === 'contain' || top.radius) return false
  if (!top.src.startsWith('asset:') || !assets.opaque(top.src.slice('asset:'.length))) return false
  return top.x - COVER_EPS <= low.x && top.y - COVER_EPS <= low.y &&
    low.x + low.w <= top.x + top.w + COVER_EPS && low.y + low.h <= top.y + top.h + COVER_EPS
}

/**
 * Drop the pictures in `elements[from…]` that a LATER opaque picture of the
 * same run covers completely (z-order is document order). PowerPoint never
 * shows them; we would, the moment anyone moved or deleted the top one —
 * templates keep superseded artwork that way (one corporate template's title
 * layouts stack an old logo exactly under the current one). Chrome only: on a slide a
 * covered picture may be one step of a build, and slide content is the
 * author's. Each drop is reported.
 */
function dropCoveredPictures(
  elements: OutElement[], from: number, assets: AssetStore, report: Report, where: string,
): void {
  const drop = new Set<OutElement>()
  for (let i = from; i < elements.length; i++) {
    const low = elements[i]
    if (low.type !== 'image') continue
    for (let j = i + 1; j < elements.length; j++) {
      if (!covers(elements[j], low, assets)) continue
      drop.add(low)
      report.add('carried', 'covered-picture-dropped', `${where} / ${low.id}`,
        `a picture entirely under an opaque picture (${elements[j].id}) is never visible — not imported`)
      break
    }
  }
  if (!drop.size) return
  const kept = elements.filter((e, i) => i < from || !drop.has(e))
  elements.length = 0
  elements.push(...kept)
}

/**
 * A master's non-placeholder shapes (logos, rules, footer bars — template
 * chrome) into `elements`. A master's OWN title/body placeholders are
 * skipped — they are not chrome and have no place painted onto every layout
 * or slide that uses it. Shared by the master entry (idPrefix 'pm'), a
 * detached layout folding its master in (also 'pm' — the same elements, so
 * the same ids), and bakeChromeOntoSlide (a flattened slide, 'mst').
 */
function paintMasterDecoration(
  masterXml: XElem,
  theme: ThemeCtx,
  report: Report,
  masterRels: Map<string, Rel>,
  assets: AssetStore,
  idPrefix: string,
  n: number,
  spIds: Set<string>,
  elements: OutElement[],
  whereLabel: string,
): void {
  const mCSld = kid(masterXml, NS.p, 'cSld')
  const mTree = mCSld && kid(mCSld, NS.p, 'spTree')
  if (!mTree) return
  const masterCtx: InheritCtx = { slide: masterXml, theme, report }
  const masterOpts: TreeOpts = {
    rels: masterRels, assets, idPrefix, n, spIds, elements, whereLabel,
  }
  const start = elements.length
  for (const el of flattenMc(mTree.children)) {
    if (el.ns !== NS.p) continue
    // decoration only — a master's own title/body placeholders are not
    // template chrome and have no place painted onto every layout
    if ((el.local === 'sp' || el.local === 'pic' || el.local === 'graphicFrame')
      && effectivePhType(el, masterCtx) !== '') continue
    emitShapeOrText(el, masterCtx, masterOpts)
  }
  dropCoveredPictures(elements, start, assets, report, `${whereLabel} ${n}`)
}

/**
 * A layout's own non-placeholder shapes ONLY — no title/subtitle/body/media
 * PROMPTS. Those exist for Slide-Master editing and for linked slides (which
 * carry them as slots); a FLATTENED slide must never show them as stray
 * "Click to add text" scaffolding under its own content.
 */
function paintLayoutDecorationOnly(
  layoutXml: XElem,
  layoutCtx: InheritCtx,
  layoutRels: Map<string, Rel>,
  assets: AssetStore,
  idPrefix: string,
  n: number,
  spIds: Set<string>,
  elements: OutElement[],
  whereLabel: string,
): void {
  const lCSld = kid(layoutXml, NS.p, 'cSld')
  const lTree = lCSld && kid(lCSld, NS.p, 'spTree')
  if (!lTree) return
  const layoutOpts: TreeOpts = {
    rels: layoutRels, assets, idPrefix, n, spIds, elements, whereLabel,
  }
  const start = elements.length
  for (const el of flattenMc(lTree.children)) {
    if (el.ns !== NS.p) continue
    if ((el.local === 'sp' || el.local === 'pic' || el.local === 'graphicFrame')
      && effectivePhType(el, layoutCtx) !== '') continue
    emitShapeOrText(el, layoutCtx, layoutOpts)
  }
  // the same drops buildLayoutEntry makes, so a flattened slide's chrome
  // still matches its layout's
  dropCoveredPictures(elements, start, assets, layoutCtx.report, `${whereLabel} ${n}`)
}

/** Whether the slide's OWN spTree already carries a placeholder matching
 *  `want` (a layout furniture placeholder) — idx first, type fallback, the
 *  same two-tier rule inherit.ts's matchPh uses for style inheritance. A hit
 *  means the slide already shows this furniture itself, so the layout's copy
 *  must not be doubled underneath it. */
function slideHasPlaceholder(spTree: XElem | undefined, want: XElem): boolean {
  if (!spTree) return false
  const idx = effIdx(want)
  const wantType = attr(want, 'type')
  let typeMatch = false
  for (const el of flattenMc(spTree.children)) {
    if (el.ns !== NS.p) continue
    if (el.local !== 'sp' && el.local !== 'pic' && el.local !== 'graphicFrame') continue
    const ph = phOf(el)
    if (!ph) continue
    if (effIdx(ph) === idx) return true
    if (wantType && attr(ph, 'type') === wantType) typeMatch = true
  }
  return typeMatch
}

/** Underlay the layout's furniture placeholders (footer/date/slide-number/
 *  header) the slide doesn't already carry itself — emitLayoutPlaceholder
 *  honors p:hf visibility. Title/subtitle/body/media PROMPTS never reach
 *  here — FURNITURE_PH_TYPES filters them out first. */
function paintFurniture(
  layoutXml: XElem,
  layoutCtx: InheritCtx,
  slideSpTree: XElem | undefined,
  layoutRels: Map<string, Rel>,
  assets: AssetStore,
  idPrefix: string,
  n: number,
  elements: OutElement[],
): void {
  const lCSld = kid(layoutXml, NS.p, 'cSld')
  const lTree = lCSld && kid(lCSld, NS.p, 'spTree')
  if (!lTree) return
  const opts: TreeOpts = {
    rels: layoutRels, assets, idPrefix, n, spIds: new Set(), elements, whereLabel: 'slide',
  }
  for (const el of flattenMc(lTree.children)) {
    if (el.ns !== NS.p) continue
    if (el.local !== 'sp' && el.local !== 'pic' && el.local !== 'graphicFrame') continue
    if (isHiddenShape(el)) continue // the layout entry reports it
    const t = effectivePhType(el, layoutCtx)
    if (!FURNITURE_PH_TYPES.has(t)) continue
    const want = phOf(el)
    if (want && slideHasPlaceholder(slideSpTree, want)) continue
    emitLayoutPlaceholder(el, t, layoutCtx, opts)
  }
}

/**
 * Bake master + layout decoration and un-duplicated furniture placeholders
 * directly onto a FLATTENED slide's own `elements` — the same "resolve once,
 * bake onto the slide" treatment backgroundOf() gives backgrounds. The
 * renderer only ever reads slide.elements, so an unlinked slide must carry
 * its chrome itself. Master decoration paints first (bottom of z-order), then
 * the layout's own decoration, then any furniture the slide doesn't already
 * carry — all UNDER the slide's real content, which the caller emits after.
 * Element order here is the same order a layout entry's composite has
 * (buildLayoutEntry), which is what lets tryLink prove a slide equivalent.
 */
function bakeChromeOntoSlide(
  slideXml: XElem,
  layoutXml: XElem | undefined,
  masterXml: XElem | undefined,
  theme: ThemeCtx,
  report: Report,
  layoutRels: Map<string, Rel>,
  masterRels: Map<string, Rel>,
  assets: AssetStore,
  n: number,
  elements: OutElement[],
): void {
  if (!layoutXml) return
  const layoutCtx: InheritCtx = { slide: layoutXml, theme, report }
  if (masterXml) layoutCtx.master = masterXml

  const lCSld = kid(layoutXml, NS.p, 'cSld')
  const mCSld = masterXml && kid(masterXml, NS.p, 'cSld')
  const mTree = mCSld && kid(mCSld, NS.p, 'spTree')

  const chromeIds = new Set<string>()
  const lTreeForIds = lCSld && kid(lCSld, NS.p, 'spTree')
  if (lTreeForIds) collectSpIds(lTreeForIds.children, chromeIds)
  if (mTree) collectSpIds(mTree.children, chromeIds)

  if (masterXml && mTree && slideShowsMaster(slideXml, layoutXml)) {
    paintMasterDecoration(masterXml, theme, report, masterRels, assets, 'mst', n, chromeIds, elements, 'slide')
  }
  paintLayoutDecorationOnly(layoutXml, layoutCtx, layoutRels, assets, 'ly', n, chromeIds, elements, 'slide')

  const sCSld = kid(slideXml, NS.p, 'cSld')
  const slideSpTree = sCSld && kid(sCSld, NS.p, 'spTree')
  paintFurniture(layoutXml, layoutCtx, slideSpTree, layoutRels, assets, 'ly', n, elements)

  // The baked master/layout decoration is scenery too (not text, which stays
  // editable) — lock it so a click on empty slide area doesn't drag it.
  const chromePrefix = [`mst${n}-`, `ly${n}-`]
  for (const el of elements) {
    if (el.type !== 'text' && chromePrefix.some((p) => String(el.id).startsWith(p))) el.locked = true
  }
}

/** A part's own @showMasterSp. ECMA-376 puts it on the ROOT (p:sld /
 *  p:sldLayout — CT_Slide/CT_SlideLayout); p:cSld is read as a fallback for
 *  producers that write it there. Undefined when neither says anything. */
function showMasterSpOf(root: XElem): string | undefined {
  const own = attr(root, 'showMasterSp')
  if (own !== undefined) return own
  const cSld = kid(root, NS.p, 'cSld')
  return cSld ? attr(cSld, 'showMasterSp') : undefined
}

const hidesMasterSp = (v: string | undefined): boolean => v === '0' || v === 'false'

/** OOXML lets either the slide or its layout suppress the master's shapes —
 *  the slide's own @showMasterSp wins when it says anything. */
function slideShowsMaster(slideXml: XElem, layoutXml: XElem | undefined): boolean {
  const v = showMasterSpOf(slideXml) ?? (layoutXml ? showMasterSpOf(layoutXml) : undefined)
  return !hidesMasterSp(v)
}

// --- the master → layout tree -------------------------------------------------

interface MasterInfo {
  /** 1-based, p:sldMasterIdLst order (then discovery order) */
  m: number
  part: string
  xml?: XElem
  rels: Map<string, Rel>
  bundle: MasterBundle
  /** p:sldLayoutIdLst order (then discovery order) */
  layouts: LayoutInfo[]
}

interface LayoutInfo {
  /** 1-based, numbered globally across masters in list order */
  k: number
  part: string
  xml?: XElem
  rels: Map<string, Rel>
  master?: MasterInfo
}

interface Template {
  masters: MasterInfo[]
  /** layouts whose master is not reachable at all — emitted as roots */
  orphans: LayoutInfo[]
  /** the LayoutInfo for a layout part, appending (next k) one the lists
   *  never named */
  layoutFor(part: string): LayoutInfo
}

/**
 * Enumerate the package's masters and layouts from RELS ALONE, before any
 * slide is looked at — the numbering (pptx-master-<m>, pptx-layout-<k>, and
 * the pm<m>-/pl<k>- element prefixes) is then identical in deck and template
 * mode, and independent of which slides happen to use what. Each master's
 * theme is parsed once, here.
 */
function collectTemplate(
  parts: ZipParts, pres: XElem, presRels: Map<string, Rel>, report: Report,
): Template {
  const masters: MasterInfo[] = []
  const orphans: LayoutInfo[] = []
  const byMaster = new Map<string, MasterInfo>()
  const byLayout = new Map<string, LayoutInfo>()
  let k = 0

  const masterFor = (part: string): MasterInfo => {
    const hit = byMaster.get(part)
    if (hit) return hit
    const m = masters.length + 1
    const xml = xmlOf(parts, part)
    if (!xml) report.add('dropped', 'part-missing', `master ${m}`, `master part missing: ${part}`)
    const rels = xml ? relsOf(parts, part) : new Map<string, Rel>()
    let bundle: MasterBundle = { theme: emptyTheme() }
    if (xml) {
      const themeRel = relOfType(rels, '/theme')
      const themeXml = themeRel ? xmlOf(parts, themeRel.target) : undefined
      if (themeRel && !themeXml) {
        report.add('dropped', 'part-missing', `master ${m}`, `theme part missing: ${themeRel.target}`)
      }
      if (themeXml) bundle = { theme: parseTheme(themeXml, kid(xml, NS.p, 'clrMap')), themeXml }
    }
    const mi: MasterInfo = { m, part, xml, rels, bundle, layouts: [] }
    masters.push(mi)
    byMaster.set(part, mi)
    return mi
  }

  const addLayout = (part: string, owner?: MasterInfo): LayoutInfo => {
    const hit = byLayout.get(part)
    if (hit) return hit
    const xml = xmlOf(parts, part)
    const rels = xml ? relsOf(parts, part) : new Map<string, Rel>()
    const li: LayoutInfo = { k: ++k, part, xml, rels }
    byLayout.set(part, li)
    const masterRel = xml ? relOfType(rels, '/slideMaster') : undefined
    const master = owner ?? (masterRel ? masterFor(masterRel.target) : undefined)
    if (master) { li.master = master; master.layouts.push(li) } else orphans.push(li)
    return li
  }

  const lst = kid(pres, NS.p, 'sldMasterIdLst')
  for (const ref of lst ? kids(lst, NS.p, 'sldMasterId') : []) {
    const id = rIdOf(ref)
    const rel = id ? presRels.get(id) : undefined
    if (!rel || rel.mode) continue
    const mi = masterFor(rel.target)
    const ll = mi.xml && kid(mi.xml, NS.p, 'sldLayoutIdLst')
    for (const lref of ll ? kids(ll, NS.p, 'sldLayoutId') : []) {
      const lid = rIdOf(lref)
      const lrel = lid ? mi.rels.get(lid) : undefined
      if (lrel && !lrel.mode) addLayout(lrel.target, mi)
    }
  }
  return { masters, orphans, layoutFor: (part) => addLayout(part) }
}

interface MasterEntry {
  entry: OutSlide
  /** how many decoration elements the master paints (background excluded) */
  decoration: number
  /** the master background image's element id, when it is a picture */
  bgId?: string
}

/**
 * A slideMaster → a ROOT doc.layouts entry: its background, then its
 * decoration, and NO placeholder prompts — every child would otherwise show
 * the master's title/body prompts under its own. The master's text styling
 * still reaches each layout prompt, through textDefaults. Its theme's
 * minor/major faces become the slide type's fontFamily/headingFamily.
 */
function buildMasterEntry(
  mi: MasterInfo, assets: AssetStore, report: Report, size: { width: number; height: number },
): MasterEntry {
  const xml = mi.xml!
  const theme = mi.bundle.theme
  const ctx: InheritCtx = { slide: xml, theme, report }
  const bg = backgroundOf(ctx, size, `master ${mi.m}`, `pm${mi.m}`, () => mi.rels, assets)
  const elements: OutElement[] = []
  if (bg.image) elements.push(bg.image)
  const cSld = kid(xml, NS.p, 'cSld')
  const tree = cSld && kid(cSld, NS.p, 'spTree')
  const spIds = new Set<string>()
  if (tree) collectSpIds(tree.children, spIds)
  const before = elements.length
  paintMasterDecoration(xml, theme, report, mi.rels, assets, 'pm', mi.m, spIds, elements, 'master')

  const themeName = mi.bundle.themeXml ? attr(mi.bundle.themeXml, 'name') : undefined
  const name = (cSld && attr(cSld, 'name')?.trim()) || themeName?.trim() || `Slide Master ${mi.m}`
  const entry: OutSlide = {
    id: `pptx-master-${mi.m}`,
    name,
    background: bg.color,
    transition: 'none',
    notes: '',
    elements,
    fontFamily: fontStack(theme.minorFont),
    headingFamily: fontStack(theme.majorFont),
  }
  const out: MasterEntry = { entry, decoration: elements.length - before }
  if (bg.image) out.bgId = bg.image.id
  return out
}

interface LayoutEntry {
  info: LayoutInfo
  entry: OutSlide
  /** a root carrying its master's decoration folded in, instead of a child */
  detached: boolean
  /** the layout's own @showMasterSp="0" (root, or p:cSld — showMasterSpOf) */
  hidesMaster: boolean
  slots: Map<string, Slot>
  /** id of the background image painting under this layout's composite
   *  (its own, or the master's for a child) */
  bgId?: string
  /** what model.ts's effectiveLayout composites: master entry + own
   *  elements for a child, own elements for a root */
  composite: OutElement[]
}

/**
 * A slideLayout → a doc.layouts entry. Normally a CHILD (`parentId` → its
 * master entry) holding only its own shapes: background image (own picture
 * only — a master picture is painted by the master entry), decoration, then
 * furniture, then content placeholders. That z-order is deliberate: it is
 * the order a flattened slide paints its chrome in, with the slide's content
 * on top, so a linked slide can match it.
 *
 * DETACHED instead — a root with the master's decoration folded in, built
 * the way layouts were before the tree — whenever the model's always-
 * composite-the-whole-chain rule would render something PowerPoint does not:
 *   - showMasterSp="0" (the master's shapes must not show through at all);
 *   - its own picture background, over a master that has decoration (the
 *     picture would paint over the inherited decoration);
 *   - its own p:bg, under a master whose background is a picture (the
 *     inherited picture would cover the layout's own background).
 */
function buildLayoutEntry(
  li: LayoutInfo, me: MasterEntry | undefined, assets: AssetStore, report: Report,
  size: { width: number; height: number },
): LayoutEntry {
  const layoutXml = li.xml!
  const mi = li.master
  const masterXml = mi?.xml
  const theme = mi ? mi.bundle.theme : emptyTheme()
  const masterRels = mi ? mi.rels : new Map<string, Rel>()
  const k = li.k
  const ctx: InheritCtx = { slide: layoutXml, theme, report }
  if (masterXml) ctx.master = masterXml

  const lCSld = kid(layoutXml, NS.p, 'cSld')
  const lTree = lCSld && kid(lCSld, NS.p, 'spTree')
  const hidesMaster = hidesMasterSp(showMasterSpOf(layoutXml))
  const ownBg = !!(lCSld && kid(lCSld, NS.p, 'bg'))

  let detached = !me
  let bg: BackgroundResult
  if (me && !ownBg && !hidesMaster) {
    bg = { color: me.entry.background } // the master entry paints it
  } else {
    bg = backgroundOf(ctx, size, `layout ${k}`, `pl${k}`,
      (from) => (from === 'master' ? masterRels : li.rels), assets)
    if (me && (hidesMaster || (ownBg && ((bg.image && me.decoration > 0) || me.bgId)))) detached = true
  }

  const elements: OutElement[] = []
  if (bg.image) elements.push(bg.image)
  const spIds = new Set<string>()
  if (lTree) collectSpIds(lTree.children, spIds)
  if (detached && !hidesMaster && masterXml && mi) {
    const mCSld = kid(masterXml, NS.p, 'cSld')
    const mTree = mCSld && kid(mCSld, NS.p, 'spTree')
    if (mTree) collectSpIds(mTree.children, spIds)
    paintMasterDecoration(masterXml, theme, report, masterRels, assets, 'pm', mi.m, spIds, elements, 'master')
  }

  const opts: TreeOpts = {
    rels: li.rels, assets, idPrefix: 'pl', n: k, spIds, elements, whereLabel: 'layout',
  }
  const furniture: Array<[XElem, string]> = []
  const content: Array<[XElem, string]> = []
  const ownStart = elements.length
  if (lTree) {
    for (const el of flattenMc(lTree.children)) {
      if (el.ns !== NS.p) continue
      // a hidden placeholder is no slot either — emitShapeOrText reports it
      if ((el.local === 'sp' || el.local === 'pic' || el.local === 'graphicFrame') && !isHiddenShape(el)) {
        const t = effectivePhType(el, ctx)
        if (t !== '') { (FURNITURE_PH_TYPES.has(t) ? furniture : content).push([el, t]); continue }
      }
      emitShapeOrText(el, ctx, opts)
    }
  }
  dropCoveredPictures(elements, ownStart, assets, report, `layout ${k}`)
  const slots = new Map<string, Slot>()
  for (const [el, t] of [...furniture, ...content]) {
    const slot = emitLayoutPlaceholder(el, t, ctx, opts)
    if (slot) slots.set(cNvPrIdOf(el), slot)
  }

  const cSldName = lCSld ? attr(lCSld, 'name') : undefined
  const entry: OutSlide = {
    id: `pptx-layout-${k}`,
    name: (cSldName && cSldName.trim()) || layoutTypeLabel(layoutXml, k),
    background: bg.color,
    transition: 'none',
    notes: '',
    elements,
  }
  const child = !detached && me !== undefined
  if (child) entry.parentId = me.entry.id
  const out: LayoutEntry = {
    info: li, entry, detached, hidesMaster, slots,
    composite: child ? [...me.entry.elements, ...elements] : elements,
  }
  const bgId = bg.image ? bg.image.id : child ? me.bgId : undefined
  if (bgId) out.bgId = bgId
  return out
}

// --- one slide -----------------------------------------------------------------

/** One spTree child's contribution to a flattened slide, plus — when it is a
 *  placeholder with a layout match — the layout slot it would fill. */
interface Piece {
  el: XElem
  elements: OutElement[]
  slotKey?: string
}

/**
 * One slide, FLATTENED: background image, baked master/layout chrome, then
 * the slide's own spTree in document order — exactly the pre-tree output,
 * and what `{link:false}` emits. The per-child pieces ride along so tryLink
 * can pour them into a layout's slots.
 */
function emitSlide(
  n: number,
  slideXml: XElem,
  slideRels: Map<string, Rel>,
  li: LayoutInfo | undefined,
  ctx: InheritCtx,
  assets: AssetStore,
  size: { width: number; height: number },
  onTitle: (s: string) => void,
): { slide: OutSlide; pieces: Piece[] } {
  const layoutXml = li?.xml
  const layoutRels = li && layoutXml ? li.rels : new Map<string, Rel>()
  const mi = layoutXml ? li?.master : undefined
  const masterXml = mi?.xml
  const masterRels = mi ? mi.rels : new Map<string, Rel>()

  // a picture background becomes the FIRST element, so it resolves first
  const bg = backgroundOf(ctx, size, `slide ${n}`, `s${n}`,
    (from) => (from === 'own' ? slideRels : from === 'layout' ? layoutRels : masterRels), assets)

  // ---- elements, in spTree document order (z-order in both formats)
  const cSldEl = kid(slideXml, NS.p, 'cSld')
  const spTree = cSldEl && kid(cSldEl, NS.p, 'spTree')
  const elements: OutElement[] = []
  if (bg.image) elements.push(bg.image)
  bakeChromeOntoSlide(slideXml, layoutXml, masterXml, ctx.theme, ctx.report, layoutRels, masterRels, assets, n, elements)

  // every cNvPr id on the slide — connector refs outside this set are dangling
  const spIds = new Set<string>()
  if (spTree) collectSpIds(spTree.children, spIds)

  const opts: TreeOpts = {
    rels: slideRels, assets, idPrefix: 's', n, spIds, elements, whereLabel: 'slide', onTitle,
  }
  const pieces: Piece[] = []
  if (spTree) {
    for (const el of flattenMc(spTree.children)) {
      const start = elements.length
      emitShapeOrText(el, ctx, opts)
      const piece: Piece = { el, elements: elements.slice(start) }
      if (el.ns === NS.p && (el.local === 'sp' || el.local === 'pic' || el.local === 'graphicFrame') && phOf(el)) {
        const lk = layoutLink(el, ctx)
        if (lk) piece.slotKey = cNvPrIdOf(lk.el)
      }
      pieces.push(piece)
    }
  }

  const tr = transitionOf(slideXml, ctx.report, `slide ${n}`)
  const slide: OutSlide = {
    id: `s${n}`,
    name: (cSldEl && attr(cSldEl, 'name')) || `Slide ${n}`,
    background: bg.color,
    transition: tr.transition,
    notes: '',
    elements,
  }
  if (tr.dir) slide.transitionDir = tr.dir
  if (attr(slideXml, 'show') === '0') slide.hidden = true
  return { slide, pieces }
}

// --- linking -------------------------------------------------------------------

/** model.ts's textHasContent — what applyLayout counts as "someone wrote
 *  something" (and so carries into a slot). */
const hasContent = (html: string): boolean =>
  !!html.replace(/<br\s*\/?>/gi, '').replace(/​/g, '').trim()

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Why a slide stays flattened — the 'slide-unlinked' report's reasons. */
const UNLINK_REASONS: Record<string, string> = {
  'hides-master': "the slide hides its master's shapes (showMasterSp=\"0\") but its layout shows them",
  'shows-master': "the slide shows its master's shapes but its layout hides them",
  'own-background': 'the slide has its own background',
  'color-map-override': 'the slide re-maps the theme colours (p:clrMapOvr)',
  'duplicate-placeholder': "two of the slide's placeholders fill the same layout slot",
  'placeholder-moved': 'a placeholder was moved or resized away from its layout slot',
  'placeholder-restyled': "a placeholder's text styling or fill differs from its layout slot",
  'empty-media-placeholder': 'the layout has a picture/media slot this slide leaves empty',
  'z-order': 'slide content is layered under a placeholder it overlaps',
  'builds-on-placeholder': 'a click build animates a placeholder, and a linked slide would lose its animation on the next resync of the layout',
  'render-mismatch': 'the linked slide would not render identically',
}

type LinkOutcome = { elements: OutElement[]; background: string } | { reason: string }

/**
 * Link one slide to its layout — or say why not. The candidate is what
 * model.ts's resync would produce: a copy of the layout's composite (master
 * elements, then the layout's), under the LAYOUT ENTRIES' OWN ids, with each
 * placeholder piece poured into its slot (text/furniture: html + link; media:
 * an image adopted into the slot exactly as applyLayout adopts it), followed
 * by every other piece unchanged. Holding the chain's own ids is what makes
 * the first resync a no-op.
 *
 * Pre-checks catch the deviations a slide declares outright; everything else
 * is caught by renderEquivalent, which compares the candidate against the
 * flattened slide. Anything either misses falls back to the flattened slide.
 */
function tryLink(
  n: number, slideXml: XElem, flat: OutSlide, pieces: Piece[], le: LayoutEntry,
  /** flattened ids carrying click builds — they must keep their own ids */
  pinned: ReadonlySet<string> = new Set(),
): LinkOutcome {
  const mi = le.info.master
  const masterXml = mi?.xml
  const sCSld = kid(slideXml, NS.p, 'cSld')
  if (masterXml) {
    const flatShows = slideShowsMaster(slideXml, le.info.xml)
    const linkedShows = !le.hidesMaster
    if (flatShows !== linkedShows) return { reason: flatShows ? 'shows-master' : 'hides-master' }
  }
  if (sCSld && kid(sCSld, NS.p, 'bg')) return { reason: 'own-background' }
  const ovr = kid(slideXml, NS.p, 'clrMapOvr')
  if (ovr && kid(ovr, NS.a, 'overrideClrMapping')) return { reason: 'color-map-override' }

  const composite = clone(le.composite)
  const byId = new Map(composite.map((e) => [e.id, e]))
  /** flattened id → linked id, for piece elements that landed in a slot */
  const moved = new Map<string, string>()
  const filled = new Set<Slot>()
  const leftovers: OutElement[] = []
  for (const piece of pieces) {
    const slot = piece.slotKey !== undefined ? le.slots.get(piece.slotKey) : undefined
    if (!slot) { leftovers.push(...clone(piece.elements)); continue }
    if (filled.has(slot)) return { reason: 'duplicate-placeholder' }

    if (slot.kind === 'media') {
      const img = piece.elements.length === 1 && piece.elements[0].type === 'image' ? piece.elements[0] : undefined
      if (!img) { leftovers.push(...clone(piece.elements)); continue }
      filled.add(slot)
      const box = byId.get(slot.id)!
      const adopted = Object.assign(clone(img), {
        id: box.id, x: box.x, y: box.y, w: box.w, h: box.h, rotation: box.rotation, role: box.role,
      })
      composite[composite.indexOf(box)] = adopted
      byId.set(slot.id, adopted)
      moved.set(img.id, slot.id)
      continue
    }

    // a text slot takes a p:sp's text (and its shape half, which the slot
    // must carry too); a picture/table in a content placeholder stays itself
    if (piece.el.local !== 'sp' || piece.elements.some((e) => e.type !== 'text' && e.type !== 'shape')) {
      leftovers.push(...clone(piece.elements))
      continue
    }
    filled.add(slot)
    for (const e of piece.elements) {
      if (e.type === 'text') {
        const target = byId.get(slot.id) as OutText
        if (hasContent(e.html)) target.html = e.html
        if (e.link) target.link = e.link
        moved.set(e.id, slot.id)
      } else {
        if (!slot.shapeId) return { reason: 'placeholder-restyled' }
        moved.set(e.id, slot.shapeId)
      }
    }
  }

  if ([...moved.keys()].some((id) => pinned.has(id))) return { reason: 'builds-on-placeholder' }

  // own-background returned above, so a picture background here is inherited
  const translate = (id: string): string => moved.get(id) ?? chromeTwinId(id, n, le, false) ?? id
  // connectors between slide shapes follow a shape that moved into a slot
  for (const e of leftovers) {
    if (e.type !== 'shape') continue
    if (e.from && moved.has(e.from.el)) e.from = { ...e.from, el: moved.get(e.from.el)! }
    if (e.to && moved.has(e.to.el)) e.to = { ...e.to, el: moved.get(e.to.el)! }
  }

  const slotIds = new Set<string>()
  for (const s of le.slots.values()) { slotIds.add(s.id); if (s.shapeId) slotIds.add(s.shapeId) }
  const linked = { elements: [...composite, ...leftovers], background: le.entry.background }
  const reason = renderEquivalent(flat, linked, translate, slotIds)
  return reason ? { reason } : linked
}

/**
 * Where a flattened slide's baked chrome lives in the LINKED id space: the
 * master's `mst<n>-X` is the master entry's `pm<m>-X`, the layout's `ly<n>-X`
 * is the layout entry's `pl<k>-X`, and an inherited picture background
 * `s<n>-bg` is the chain's own background image. Undefined for the slide's
 * own shapes (and for its own background, which the chain does not have).
 *
 * One mapping, two users: tryLink compares a candidate against its flattened
 * twin through it, and a slide that STAYS flattened carries it as `morphId`
 * (setChromeMorphKeys) — otherwise its logo pairs with the same logo on no
 * other slide, and Morph fades it out and back in on every transition.
 */
function chromeTwinId(id: string, n: number, le: LayoutEntry, ownBg: boolean): string | undefined {
  const m = le.info.master?.m
  if (id === `s${n}-bg`) return ownBg ? undefined : le.bgId
  if (m !== undefined && id.startsWith(`mst${n}-`)) return `pm${m}-${id.slice(`mst${n}-`.length)}`
  if (id.startsWith(`ly${n}-`)) return `pl${le.info.k}-${id.slice(`ly${n}-`.length)}`
  return undefined
}

/** Give a flattened slide's baked chrome the morph keys of its linked twin
 *  (`id` stays per-slide — selection, anchors and the resync key off it). */
function setChromeMorphKeys(n: number, slideXml: XElem, slide: OutSlide, le: LayoutEntry): void {
  const cSld = kid(slideXml, NS.p, 'cSld')
  const ownBg = !!(cSld && kid(cSld, NS.p, 'bg'))
  for (const e of slide.elements) {
    const key = chromeTwinId(e.id, n, le, ownBg)
    if (key) e.morphId = key
  }
}

const FRAME_KEYS = ['x', 'y', 'w', 'h', 'rotation'] as const
const DEG = Math.PI / 180

/** An element's render signature: everything but its identity (id, groupId,
 *  role, placeholder prompt, morphId), numbers rounded to 1/100, keys sorted,
 *  connector ends translated into the linked id space. */
function signature(e: OutElement, translate: (id: string) => string): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'number') return Math.round(v * 100) / 100
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {}
      for (const key of Object.keys(v).sort()) o[key] = norm((v as Record<string, unknown>)[key])
      return o
    }
    return v
  }
  const rest: Record<string, unknown> = { ...e }
  delete rest.id; delete rest.groupId; delete rest.role; delete rest.footerRole; delete rest.placeholder; delete rest.morphId; delete rest.locked
  if (e.type === 'shape') {
    if (e.from) rest.from = { ...e.from, el: translate(e.from.el) }
    if (e.to) rest.to = { ...e.to, el: translate(e.to.el) }
  }
  return JSON.stringify(norm(rest))
}

/** Axis-aligned bounds of a (possibly rotated) element. */
function bounds(e: OutElement): [number, number, number, number] {
  const r = (e.rotation || 0) * DEG
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r))
  const hw = (e.w * c + e.h * s) / 2, hh = (e.w * s + e.h * c) / 2
  const cx = e.x + e.w / 2, cy = e.y + e.h / 2
  return [cx - hw, cy - hh, cx + hw, cy + hh]
}

const overlaps = (a: OutElement, b: OutElement): boolean => {
  const p = bounds(a), q = bounds(b)
  return p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3]
}

/**
 * The safety net: would the linked candidate PRESENT exactly like the
 * flattened slide? Flattened ids are translated into the linked space, empty
 * prompts dropped (hidden when presenting), and then the two must agree on
 * the id set, on every element's signature, on the relative order of every
 * overlapping pair, and on the background. Returns the first mismatch's
 * reason, or undefined when the two are equivalent.
 */
function renderEquivalent(
  flat: { elements: OutElement[]; background: string },
  linked: { elements: OutElement[]; background: string },
  translate: (id: string) => string,
  slotIds: Set<string>,
): string | undefined {
  if (flat.background !== linked.background) return 'render-mismatch'
  const visible = linked.elements.filter((e) => !(e.type === 'text' && e.placeholder !== undefined && !hasContent(e.html)))
  const flatById = new Map<string, { el: OutElement; at: number }>()
  flat.elements.forEach((el, at) => flatById.set(translate(el.id), { el, at }))
  const linkedById = new Map(visible.map((el) => [el.id, el]))
  if (flatById.size !== flat.elements.length || linkedById.size !== visible.length) return 'render-mismatch'

  for (const el of visible) {
    if (flatById.has(el.id)) continue
    if (el.type === 'shape' && el.role === 'media') return 'empty-media-placeholder'
    return slotIds.has(el.id) ? 'placeholder-restyled' : 'render-mismatch'
  }
  for (const id of flatById.keys()) if (!linkedById.has(id)) return 'render-mismatch'

  for (const el of visible) {
    const twin = flatById.get(el.id)!.el
    if (signature(el, (id) => id) === signature(twin, translate)) continue
    if (!slotIds.has(el.id)) return 'render-mismatch'
    const moved = FRAME_KEYS.some((key) => r2(el[key]) !== r2(twin[key]))
    return moved ? 'placeholder-moved' : 'placeholder-restyled'
  }

  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      if (!overlaps(visible[i], visible[j])) continue
      if (flatById.get(visible[i].id)!.at > flatById.get(visible[j].id)!.at) return 'z-order'
    }
  }
  return undefined
}

// --- theme palette -------------------------------------------------------------

/** doc.theme.palette from the resolved scheme — only keys actually present,
 *  never `undefined` fields (slides/src/model.ts's palette is all-optional
 *  beyond bg1/tx1/accent1, which stay canonical on theme.background/color/
 *  accent and are never duplicated here). */
function paletteFrom(scheme: Record<string, string>): NonNullable<OutDoc['theme']['palette']> | undefined {
  const p: NonNullable<OutDoc['theme']['palette']> = {}
  if (scheme['bg2']) p.bg2 = scheme['bg2']
  if (scheme['tx2']) p.tx2 = scheme['tx2']
  if (scheme['accent2']) p.accent2 = scheme['accent2']
  if (scheme['accent3']) p.accent3 = scheme['accent3']
  if (scheme['accent4']) p.accent4 = scheme['accent4']
  if (scheme['accent5']) p.accent5 = scheme['accent5']
  if (scheme['accent6']) p.accent6 = scheme['accent6']
  if (scheme['hlink']) p.hlink = scheme['hlink']
  if (scheme['folHlink']) p.folHlink = scheme['folHlink']
  return Object.keys(p).length ? p : undefined
}

// --- the conversion ----------------------------------------------------------

/**
 * Convert one .pptx/.potx to a beeslides/slides document. Throws (ZipError /
 * XmlError / Error) only for a package that is not a presentation at all;
 * everything recoverable lands in the report instead. See ConvertPptxOptions
 * for deck vs template mode and `link`.
 */
export async function convertPptx(bytes: Uint8Array, opts: ConvertPptxOptions = {}): Promise<ConvertResult> {
  const mode = opts.mode ?? 'deck'
  const link = opts.link !== false
  const report = new Report()
  const parts = await readZip(bytes)
  const ctRoot = xmlOf(parts, '[Content_Types].xml')
  const types: ContentTypes | undefined = ctRoot ? parseContentTypes(ctRoot) : undefined
  const assets = new AssetStore(parts, types)

  const rootRels = relsOf(parts, '')
  const presPart = relOfType(rootRels, '/officeDocument')?.target ?? 'ppt/presentation.xml'
  const pres = xmlOf(parts, presPart)
  if (!pres) throw new Error('this file is not a PowerPoint package — it has no presentation part')
  const presRels = relsOf(parts, presPart)
  const tsRel = relOfType(presRels, '/tableStyles')
  const tsPart = tsRel ? tsRel.target : 'ppt/tableStyles.xml'
  let tableStyles: TableStyles
  try {
    tableStyles = parseTableStyles(xmlOf(parts, tsPart))
  } catch {
    // a broken style part costs the tables their custom styles (they fall
    // back to the built-in / a plain table, each reported), never the deck
    tableStyles = { byId: new Map() }
    report.add('approximated', 'table-styles-unreadable', tsPart,
      'the table styles part is not readable XML — tables fall back to the built-in default style or a plain table')
  }
  graphicPkgs.set(assets, { parts, tableStyles })

  // 12192000×6858000 EMU / 9525 = 1280×720 EXACTLY — converted, never assumed
  // (4:3 decks are 9144000×6858000 → 960×720 through the same arithmetic).
  const sldSz = kid(pres, NS.p, 'sldSz')
  const size = {
    width: Math.round((sldSz ? intAttr(sldSz, 'cx', 12192000) : 12192000) / EMU_PER_PX),
    height: Math.round((sldSz ? intAttr(sldSz, 'cy', 6858000) : 6858000) / EMU_PER_PX),
  }

  const tpl = collectTemplate(parts, pres, presRels, report)
  const masterEntries = new Map<MasterInfo, MasterEntry | undefined>()
  const layoutEntries = new Map<LayoutInfo, LayoutEntry>()
  const usage = new Map<LayoutEntry, number>()
  const masterEntryFor = (mi: MasterInfo | undefined): MasterEntry | undefined => {
    if (!mi || !mi.xml) return undefined
    if (!masterEntries.has(mi)) masterEntries.set(mi, buildMasterEntry(mi, assets, report, size))
    return masterEntries.get(mi)
  }
  // Built against the master's own theme, never a slide's clrMapOvr — a
  // template extraction is not any one slide's business.
  const layoutEntryFor = (li: LayoutInfo): LayoutEntry => {
    let le = layoutEntries.get(li)
    if (!le) {
      le = buildLayoutEntry(li, masterEntryFor(li.master), assets, report, size)
      layoutEntries.set(li, le)
    }
    return le
  }

  let deckTheme: ThemeCtx | undefined
  let titleText: string | undefined
  const slides: OutSlide[] = []
  const sldIdLst = kid(pres, NS.p, 'sldIdLst')
  const sldIds = sldIdLst ? kids(sldIdLst, NS.p, 'sldId') : []
  const slideRef = (sldId: XElem): string | undefined => {
    const relId = rIdOf(sldId)
    const rel = relId ? presRels.get(relId) : undefined
    return rel && !rel.mode ? rel.target : undefined
  }

  if (mode === 'template') {
    // The designs are the product: every layout under every master, and the
    // package's own slides are not converted. Their layouts are still
    // touched, so a package whose lists are missing loses nothing.
    for (const sldId of sldIds) {
      const slidePart = slideRef(sldId)
      const layoutRel = slidePart ? relOfType(relsOf(parts, slidePart), '/slideLayout') : undefined
      if (layoutRel) tpl.layoutFor(layoutRel.target)
    }
    for (const mi of tpl.masters) {
      masterEntryFor(mi)
      for (const li of mi.layouts) if (li.xml) layoutEntryFor(li)
    }
    for (const li of tpl.orphans) if (li.xml) layoutEntryFor(li)
    // the document theme is the master that holds the most layouts (the
    // first on a tie): a corporate template's real design, not whatever
    // stock master the list happens to start with (one real template's first
    // master is Office's Calibri theme; its second, with 15 of 22 layouts, is the brand)
    let themeMaster: MasterInfo | undefined
    for (const mi of tpl.masters) {
      if (mi.xml && (!themeMaster || mi.layouts.length > themeMaster.layouts.length)) themeMaster = mi
    }
    deckTheme = themeMaster?.bundle.theme
  } else {
    let n = 0
    for (const sldId of sldIds) {
      n++ // 1-based SOURCE position — ids stay deterministic even past a bad slide
      const slidePart = slideRef(sldId)
      const slideXml = slidePart ? xmlOf(parts, slidePart) : undefined
      if (!slidePart || !slideXml) {
        report.add('dropped', 'slide-missing', `slide ${n}`,
          'a slide named by p:sldIdLst is missing from the package')
        continue
      }
      const slideRels = relsOf(parts, slidePart)

      // ---- the inheritance chain: layout → master → theme, all via rels
      const layoutRel = relOfType(slideRels, '/slideLayout')
      const li = layoutRel ? tpl.layoutFor(layoutRel.target) : undefined
      if (layoutRel && !li?.xml) {
        report.add('dropped', 'part-missing', `slide ${n}`, `layout part missing: ${layoutRel.target}`)
      }
      const layoutXml = li?.xml
      const mi = layoutXml ? li?.master : undefined
      const masterXml = mi?.xml
      const bundle: MasterBundle = mi && masterXml ? mi.bundle : { theme: emptyTheme() }

      // ---- layout extraction: once per layout part actually used — see the
      // header's PRUNE note
      const le = li && layoutXml ? layoutEntryFor(li) : undefined
      if (le) usage.set(le, (usage.get(le) ?? 0) + 1)

      // p:clrMapOvr re-routes the SAME scheme for this slide only
      let theme = bundle.theme
      const ovr = kid(slideXml, NS.p, 'clrMapOvr')
      const mapping = ovr && kid(ovr, NS.a, 'overrideClrMapping')
      if (mapping && bundle.themeXml) theme = parseTheme(bundle.themeXml, mapping)
      // decks with multiple masters/themes keep per-slide content correct (each
      // slide resolves against its own ctx.theme below) but the DOCUMENT-level
      // palette assembled at the end represents only this, the first, theme.
      deckTheme ??= theme

      const ctx: InheritCtx = { slide: slideXml, theme, report }
      if (layoutXml) ctx.layout = layoutXml
      if (masterXml) ctx.master = masterXml

      const { slide, pieces } = emitSlide(n, slideXml, slideRels, li, ctx, assets, size,
        // an untitled package is named by its first title placeholder's text
        (s) => { if (titleText === undefined) titleText = s })

      // click builds (p:timing) — read against the FLATTENED ids, applied once
      // the slide's final shape is known (linking may keep or drop them)
      const builds = readBuilds(slideXml, n, slide.elements, report)

      // a slide with no layout has nothing to deviate from — not reported
      if (link && le) {
        const res = tryLink(n, slideXml, slide, pieces, le, new Set(builds.keys()))
        if ('reason' in res) {
          report.add('approximated', 'slide-unlinked', `slide ${n}`,
            `${res.reason}: ${UNLINK_REASONS[res.reason] ?? res.reason} — kept as flattened shapes, ` +
            `not linked to its layout "${le.entry.name}"`)
        } else {
          slide.elements = res.elements
          slide.background = res.background
          slide.layoutId = le.entry.id
        }
      }
      if (le && !slide.layoutId) setChromeMorphKeys(n, slideXml, slide, le)
      applyBuilds(slide.elements, builds)

      // ---- notes
      const notesRel = relOfType(slideRels, '/notesSlide')
      if (notesRel) {
        const notesXml = xmlOf(parts, notesRel.target)
        if (notesXml) slide.notes = notesTextOf(notesXml)
        else report.add('dropped', 'part-missing', `slide ${n}`, `notes part missing: ${notesRel.target}`)
      }
      slides.push(slide)
    }
  }

  // ---- doc.layouts: per master, the master entry, its child layouts in list
  // order, then its detached roots; a master left with no child is dropped
  // (deck mode — template mode keeps every master)
  const layouts: OutSlide[] = []
  const emitted: LayoutEntry[] = []
  for (const mi of tpl.masters) {
    const les = mi.layouts.map((li) => layoutEntries.get(li)).filter((le): le is LayoutEntry => le !== undefined)
    const me = masterEntries.get(mi)
    if (me && (mode === 'template' || les.some((le) => !le.detached))) layouts.push(me.entry)
    for (const le of [...les.filter((l) => !l.detached), ...les.filter((l) => l.detached)]) {
      layouts.push(le.entry)
      emitted.push(le)
    }
  }
  for (const li of tpl.orphans) {
    const le = layoutEntries.get(li)
    if (le) { layouts.push(le.entry); emitted.push(le) }
  }

  // ---- the default slide type: the first master's "Title and Content",
  // else (deck) the most-used layout, else the first master's FIRST layout
  // in its own list order (PowerPoint's own pick for a new presentation —
  // child or detached alike), else the first child, else the first
  let defaultEntry: LayoutEntry | undefined
  const firstMaster = emitted.find((le) => le.info.master)?.info.master
  defaultEntry = emitted.find((le) => le.info.master === firstMaster && le.info.xml && attr(le.info.xml, 'type') === 'obj')
  if (!defaultEntry && mode === 'deck') {
    for (const le of emitted) {
      if ((usage.get(le) ?? 0) > (defaultEntry ? usage.get(defaultEntry) ?? 0 : 0)) defaultEntry = le
    }
  }
  defaultEntry ??= emitted.filter((le) => le.info.master === firstMaster).sort((a, b) => a.info.k - b.info.k)[0]
  defaultEntry ??= emitted.find((le) => le.entry.parentId !== undefined)
  const defaultLayoutId = defaultEntry?.entry.id ?? layouts[0]?.id

  if (mode === 'template' && defaultEntry) {
    // one starter slide on the default layout, so the document loads — a
    // copy of its composite under the same ids, linked
    slides.push({
      id: 's1', name: 'Slide 1', background: defaultEntry.entry.background,
      transition: 'none', notes: '', elements: clone(defaultEntry.composite),
      layoutId: defaultEntry.entry.id,
    })
  }

  // parseDoc refuses a slideless document; a blank page is the honest minimum
  if (slides.length === 0) {
    if (mode === 'template') {
      report.add('dropped', 'template-empty', 'template',
        'the package has no importable slide designs — one blank slide emitted so the document loads')
    } else {
      report.add('dropped', 'deck-empty', 'deck',
        'the package names no importable slides — one blank slide emitted so the document loads')
    }
    slides.push({
      id: 's1', name: 'Slide 1', background: '#FFFFFF',
      transition: 'none', notes: '', elements: [],
    })
  }

  // only media something emitted actually references (a master built for a
  // detached child's sake, or a layout image a linked slot replaced, may
  // have registered one nothing ends up painting)
  const referenced = JSON.stringify([slides, layouts])
  const docAssets = Object.fromEntries(
    Object.entries(assets.assets()).filter(([key]) => referenced.includes(`"asset:${key}"`)))

  const scheme = deckTheme ? deckTheme.scheme : {}
  const palette = paletteFrom(scheme)
  const doc: OutDoc = {
    format: 'beeslides/slides',
    version: '1.0.0',
    // merged table cells: the gate an older reader needs (DECISIONS
    // 2026-10-08) — set here so converter output written straight to a file
    // carries it; slides' Store/save would derive the same
    ...(usesTableSpans([slides, layouts]) ? { requires: [TABLE_MERGE_FEATURE] } : {}),
    title: coreTitle(parts, rootRels) ?? titleText ?? (mode === 'template' ? 'Imported layout' : 'Imported deck'),
    meta: coreMeta(parts, rootRels),
    size,
    theme: {
      background: scheme['bg1'] ?? '#FFFFFF',
      color: scheme['tx1'] ?? '#000000',
      accent: scheme['accent1'] ?? scheme['tx1'] ?? '#000000',
      fontFamily: fontStack(deckTheme ? deckTheme.minorFont : 'Calibri'),
      headingFamily: fontStack(deckTheme ? deckTheme.majorFont : 'Calibri'),
      ...(palette ? { palette } : {}),
    },
    assets: docAssets,
    fonts: null,
    slides,
    layouts: layouts.length ? layouts : undefined,
  }
  if (layouts.length && defaultLayoutId) doc.defaultLayoutId = defaultLayoutId
  // real lists (text.ts) are rich text: an older reader must open read-only
  withListRequires(doc)
  return { doc, report: report.build() }
}
