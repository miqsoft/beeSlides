// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// p:txBody → OutText — the census's biggest domain (10,268 a:latin, 4,495
// a:buChar) and its biggest loss surface, because the two formats disagree
// about where formatting lives. PowerPoint styles per RUN; slidomingo holds ONE
// fontSize/color/family per element, and render.ts's sanitizeHtml strips every
// attribute off every surviving tag, so of per-run formatting only
// b/i/u/strike can be carried as markup. Everything else flattens to the
// DOMINANT run — dominant by character count, because the big stat number
// next to its small unit label should style the element after the number,
// not after whichever run came first — and the report says so once per
// element ('run-formatting-flattened'), which is the honest half of the deal.
//
// Bullets become REAL LISTS (rich text phase 1 holds ul/ol/li — the document
// then requires 'rich-text', convert/lists.ts): a plain bullet glyph (a dot,
// a square, a dash — PLAIN_BULLETS) makes the paragraph a `<ul>` item and
// buAutoNum an `<ol>` item, nested by a:pPr@lvl. Two shapes stay frozen text,
// because a real list would SAY something different:
//   - a distinctive glyph (✓, ➢, ★, ♦ …) keeps its glyph + NBSP baked into the
//     line ('bullet-flattened'): the list marker is the editor's disc, and a
//     checkmark list read as dots loses meaning, not just looks;
//   - an auto-numbered list with startAt ≠ 1 anywhere in the box keeps its
//     literal numbers ('auto-number-frozen'): the sanitizer strips <ol start>,
//     so a real list would renumber "3., 4." as "1., 2.".
// buNone stays a silence, not an absence: the bullet unit resolved by
// inherit.textDefaults is overlaid by the paragraph's own pPr AS A UNIT,
// never property-merged, or the master's bullet would resurrect under a
// paragraph that turned bullets off (the trap inherit.ts documents).
//
// The one EXACT match in this domain: a:fld type="slidenum" → {{page}} (330
// census occurrences) and datetime → {{date}} — slidomingo's dynamic fields have
// the same re-resolve-on-render semantics, so these are carried, not
// approximated.
//
// Sizes: a:rPr sz is CENTIPOINTS; slidomingo fontSize is PX. pt = sz/100, px =
// pt * 4/3 (the panel shows pt = px * 0.75 — same ratio, inverted). A
// converter that skips either hop emits text at 3/4 size or 100x size, both
// of which have been "seen working" in other importers.

import { NS, kid, kids, attr, intAttr, textOf, type XElem } from './xml.ts'
import {
  EMU_PER_PX, METRIC_SUBSTITUTES,
  type InheritCtx, type OutText, type ThemeCtx,
} from './types.ts'
import type { TextDefaults, ResolvedFrame, ChainLink } from './inherit.ts'
import type { ColorResult } from './theme.ts'
import type { Verdict } from './report.ts'
import { paragraphsHtml, MAX_LIST_DEPTH, type HtmlPara } from './lists.ts'

/**
 * The resolver functions textFrom leans on, injected so this module has no
 * runtime coupling to inherit.ts/theme.ts and the rig wires in the real ones.
 */
export interface TextDeps {
  effectivePhType(sp: XElem, ctx: InheritCtx): string
  textDefaults(sp: XElem, ctx: InheritCtx, level: number, phType: string): TextDefaults
  resolveFrame(sp: XElem, ctx: InheritCtx): ResolvedFrame
  labeledChain(sp: XElem, ctx: InheritCtx): ChainLink[]
  resolveColor(el: XElem | undefined, theme: ThemeCtx, phClr?: string): ColorResult | undefined
  /**
   * Called with the element id when the HOST must re-measure the box: the box
   * declared a:spAutoFit (grow-to-fit) or no autofit at all, and with 0/6
   * census decks embedding fonts every glyph is a substitution with different
   * metrics — the engine cannot know where the text now wraps. normAutofit is
   * NOT hinted (its fontScale is applied here); noAutofit is NOT hinted (an
   * explicitly fixed box is the author's stated intent).
   */
  needsRefit?(id: string): void
  /** The report `where` for this shape (e.g. `slide 4 / sp "Title 1"`), so
   *  text findings name their slide like every other finding; without it,
   *  the shape name alone. */
  where?: string
}

/** EMU → px, rounded to 1/100 px so emitted JSON stays diffable. */
const px = (emu: number): number => Math.round((emu / EMU_PER_PX) * 100) / 100

const round2 = (v: number): number => Math.round(v * 100) / 100
const round3 = (v: number): number => Math.round(v * 1000) / 1000

const flag = (v: string | undefined): boolean => v === '1' || v === 'true'

/** &, <, > and NBSP — the emitted html is markup we build, quotes never
 *  matter. NBSP is written as the entity because that is how the slides
 *  sanitizer (a template's innerHTML) serializes it: the html then survives
 *  sanitizeHtml byte for byte. */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;')

/** Report `where` for one shape: its cNvPr name when it has one. */
function whereOf(shape: XElem): string {
  for (const c of kids(shape)) {
    const cnv = kid(c, NS.p, 'cNvPr')
    if (cnv) {
      const name = attr(cnv, 'name')
      return name ? `sp "${name}"` : `sp ${attr(cnv, 'id') ?? '?'}`
    }
  }
  return 'sp'
}

function cnvIdOf(shape: XElem): string {
  for (const c of kids(shape)) {
    const cnv = kid(c, NS.p, 'cNvPr')
    if (cnv) return attr(cnv, 'id') ?? '?'
  }
  return '?'
}

/** CSS font-family token: quote anything a bare identifier cannot say. */
const cssFace = (name: string): string => (/[^A-Za-z0-9-]/.test(name) ? `'${name}'` : name)

/** ST_TextAutonumberScheme → the literal a frozen list shows. Census carries
 *  only arabicPeriod (46), but alpha/roman are cheap enough to number right —
 *  the FREEZING is the loss, not the numeral system. */
function formatAutoNum(scheme: string, n: number): string {
  const alpha = (v: number): string => {
    let s = ''
    while (v > 0) { v--; s = String.fromCharCode(65 + (v % 26)) + s; v = Math.floor(v / 26) }
    return s
  }
  const ROMAN: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ]
  const roman = (v: number): string => {
    let s = ''
    for (const [val, sym] of ROMAN) while (v >= val) { s += sym; v -= val }
    return s
  }
  const body = scheme.startsWith('alphaLc') ? alpha(n).toLowerCase()
    : scheme.startsWith('alphaUc') ? alpha(n)
    : scheme.startsWith('romanLc') ? roman(n).toLowerCase()
    : scheme.startsWith('romanUc') ? roman(n)
    : String(n)
  return scheme.includes('ParenBoth') ? `(${body})`
    : scheme.endsWith('ParenR') ? `${body})`
    : scheme.endsWith('Period') ? `${body}.`
    : body
}

/**
 * Symbol-font bullets: PowerPoint's own bullet presets store a LETTER and a
 * buFont (Wingdings 'l' is ●, Courier New 'o' is its hollow circle); the
 * glyph only exists in that font, so it is mapped to the Unicode character
 * it draws before anything looks at it. Only the presets PowerPoint and
 * Office templates actually write — an unknown letter stays as written.
 */
const SYMBOL_BULLETS: Record<string, Record<string, string>> = {
  Wingdings: { l: '●', n: '■', q: '❑', u: '◆', v: '❖', 'Ø': '➢', 'ü': '✓', '§': '▪', w: '⬥', 'Ü': '☑' },
  Symbol: { '·': '•', '\uF0B7': '•' },
  'Courier New': { o: '◦' },
}

/** Bullet glyphs a plain list marker (the renderer's disc/circle/square)
 *  stands in for without changing what the list says. */
const PLAIN_BULLETS = new Set(['•', '●', '◦', '○', '▪', '■', '▫', '□', '·', '∙', '‧', '⦁', '–', '—', '-', '‣', '⁃', '*'])

/** The glyph a buChar draws, Unicode, with its symbol font resolved. */
export function bulletGlyph(char: string, font: string | undefined): string {
  const map = font ? SYMBOL_BULLETS[font] : undefined
  return map?.[char] ?? char
}

/** The marker the renderer draws for an unordered item at nesting depth d
 *  (browser default: disc, circle, then square). */
const markerAt = (depth: number): string => (depth === 0 ? '•' : depth === 1 ? '◦' : '▪')
const SAME_MARKER: Record<string, string> = { '●': '•', '○': '◦', '■': '▪' }

/** The list-style the renderer gives an <ol> at nesting depth d
 *  (slides/src/styles.css: decimal → lower-alpha → lower-roman). */
const olSchemeAt = (depth: number): string => (depth === 0 ? 'arabic' : depth === 1 ? 'alphaLc' : 'romanLc')

/** One run's contribution: pre-escaped html + the style facts that decide
 *  dominance. `<br>` pieces carry zero chars and no flags. */
interface Piece {
  html: string
  chars: number
  sizePt: number
  color: string
  family: string
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
}

interface Para {
  pieces: Piece[]
  chars: number
  align: OutText['align']
  lineHeight: number
  /** already-escaped bullet/number prefix, '' when none */
  prefix: string
  /** a real list item: a:pPr@lvl, kind, and (for the marker checks) the
   *  source glyph or numbering scheme */
  item?: { level: number; ordered: boolean; glyph?: string; scheme?: string }
}

/**
 * One p:sp's txBody as a slidomingo text element, or undefined when there is no
 * visible text at all (empty placeholder prompts, decoration-only shapes) —
 * the caller simply emits no text half.
 *
 * The frame comes from deps.resolveFrame (own → layout ph → master ph), in px.
 * A shape that pairs with a fill (the rect-with-text split) shares that frame;
 * the id is 'txt' + cNvPr@id — unique per slide only, the identity pass may
 * rewrite it, and it is what needsRefit reports.
 */
export function textFrom(sp: XElem, ctx: InheritCtx, deps: TextDeps): OutText | undefined {
  const txBody = kid(sp, NS.p, 'txBody')
  if (!txBody) return undefined
  const where = deps.where ?? whereOf(sp)
  const phType = deps.effectivePhType(sp, ctx)

  const defCache = new Map<number, TextDefaults>()
  const defsFor = (lvl: number): TextDefaults => {
    let d = defCache.get(lvl)
    if (!d) { d = deps.textDefaults(sp, ctx, lvl, phType); defCache.set(lvl, d) }
    return d
  }

  // bodyPr facts up the chain: anchor per-attribute, autofit AS A UNIT (a
  // nearer bodyPr declaring any autofit settles the question for all three).
  const bodyPrs: XElem[] = []
  for (const link of deps.labeledChain(sp, ctx)) {
    const tb = kid(link.el, NS.p, 'txBody')
    const bp = tb ? kid(tb, NS.a, 'bodyPr') : undefined
    if (bp) bodyPrs.push(bp)
  }
  let anchor: string | undefined
  for (const bp of bodyPrs) {
    const a = attr(bp, 'anchor')
    if (a !== undefined) { anchor = a; break }
  }
  let fontScale = 1
  let lnScale = 1
  let autofit: 'norm' | 'sp' | 'no' | 'absent' = 'absent'
  for (const bp of bodyPrs) {
    const norm = kid(bp, NS.a, 'normAutofit')
    if (norm) {
      autofit = 'norm'
      fontScale = intAttr(norm, 'fontScale', 100000) / 100000
      lnScale = 1 - intAttr(norm, 'lnSpcReduction', 0) / 100000
      break
    }
    if (kid(bp, NS.a, 'spAutoFit')) { autofit = 'sp'; break }
    if (kid(bp, NS.a, 'noAutofit')) { autofit = 'no'; break }
  }

  // Findings are queued until we know the element is real — an all-empty
  // txBody must not leave reports about an element that was never emitted.
  const pending: Array<{ v: Verdict; code: string; detail: string }> = []
  const note = (v: Verdict, code: string, detail: string): void => { pending.push({ v, code, detail }) }

  /** Effective ink for one run: rPr solidFill → level defaults → p:style
   *  a:fontRef (1,775 census — the base ink of style-referenced shapes) →
   *  theme tx1 → black. A colour that EXISTS but fails to resolve is reported
   *  and falls through; absence falls through silently. */
  const inkFor = (rPr: XElem | undefined, d: TextDefaults): string => {
    const own = rPr ? kid(rPr, NS.a, 'solidFill') : undefined
    if (own) {
      const c = deps.resolveColor(own, ctx.theme)
      if (c) return c.css
      note('dropped', 'text-color-unresolved', 'a run colour reference did not resolve; the next source in the cascade was used')
    }
    if (d.color) {
      const c = deps.resolveColor(d.color, ctx.theme)
      if (c) return c.css
      note('dropped', 'text-color-unresolved', 'a run colour reference did not resolve; the next source in the cascade was used')
    }
    const style = kid(sp, NS.p, 'style')
    const fontRef = style ? kid(style, NS.a, 'fontRef') : undefined
    if (fontRef) {
      const c = deps.resolveColor(fontRef, ctx.theme)
      if (c) return c.css
    }
    return ctx.theme.scheme['tx1'] ?? '#000000'
  }

  const runPiece = (rPr: XElem | undefined, text: string, d: TextDefaults, preEscaped: boolean): Piece => {
    const szRaw = rPr ? attr(rPr, 'sz') : undefined
    const szNum = szRaw !== undefined ? parseInt(szRaw, 10) : NaN
    const sizePt = Number.isFinite(szNum) ? szNum / 100 : d.fontSize
    const bAttr = rPr ? attr(rPr, 'b') : undefined
    const bold = bAttr !== undefined ? flag(bAttr) : d.bold
    const u = rPr ? attr(rPr, 'u') : undefined
    const st = rPr ? attr(rPr, 'strike') : undefined
    const latin = rPr ? kid(rPr, NS.a, 'latin') : undefined
    const face = (latin ? attr(latin, 'typeface') : undefined) ?? d.font
    const family = face === '+mj-lt' ? ctx.theme.majorFont : face === '+mn-lt' ? ctx.theme.minorFont : face
    return {
      html: preEscaped ? text : esc(text),
      chars: text.length,
      sizePt,
      color: inkFor(rPr, d),
      family,
      bold,
      italic: rPr !== undefined && flag(attr(rPr, 'i')),
      underline: u !== undefined && u !== 'none',
      strike: st !== undefined && st !== 'noStrike',
    }
  }

  // ------------------------------------------------------------- paragraphs
  const paras: Para[] = []
  const counters = new Map<number, number>() // frozen autoNum, keyed by level
  let spacingSeen = false
  // A numbered list that does not start at 1 anywhere in this box freezes
  // ALL its numbers (PowerPoint may write startAt on the first paragraph
  // only, and a half-real list would number "3., 1., 2.").
  const freezeNumbers = kids(txBody, NS.a, 'p').some((p) => {
    const pPr = kid(p, NS.a, 'pPr')
    const auto = pPr && kid(pPr, NS.a, 'buAutoNum')
    return auto !== undefined && intAttr(auto, 'startAt', 1) !== 1
  })

  for (const p of kids(txBody, NS.a, 'p')) {
    const pPr = kid(p, NS.a, 'pPr')
    const lvl = pPr ? intAttr(pPr, 'lvl', 0) : 0
    const d = defsFor(lvl)

    let align: OutText['align'] = d.align
    let alignRaw = d.alignRaw
    const ownAlgn = pPr ? attr(pPr, 'algn') : undefined
    if (ownAlgn !== undefined) {
      align = ownAlgn === 'ctr' ? 'center' : ownAlgn === 'r' ? 'right' : 'left'
      alignRaw = ownAlgn !== 'l' && ownAlgn !== 'ctr' && ownAlgn !== 'r' ? ownAlgn : undefined
    }
    if (alignRaw !== undefined) {
      note('approximated', 'align-approximated', `algn="${alignRaw}" has no slidomingo equivalent; emitted left-aligned`)
    }

    let lineHeight = d.lineHeight
    const lnSpc = pPr ? kid(pPr, NS.a, 'lnSpc') : undefined
    if (lnSpc) {
      const spcPct = kid(lnSpc, NS.a, 'spcPct')
      const spcPts = kid(lnSpc, NS.a, 'spcPts')
      if (spcPct) lineHeight = intAttr(spcPct, 'val', 100000) / 100000
      else if (spcPts && d.fontSize > 0) lineHeight = intAttr(spcPts, 'val', d.fontSize * 100) / 100 / d.fontSize
    }

    if (d.hasSpcBef || d.hasSpcAft || (pPr && (kid(pPr, NS.a, 'spcBef') || kid(pPr, NS.a, 'spcAft')))) {
      spacingSeen = true
    }

    // bullet: the paragraph's own declaration overlays the resolved default
    // AS A UNIT — a pPr buNone silences an inherited buChar, never merges.
    let bullet: { kind: 'none' | 'char' | 'autoNum'; char?: string; font?: string; scheme?: string; startAt?: number } = d.bullet
    if (pPr) {
      if (kid(pPr, NS.a, 'buNone')) bullet = { kind: 'none' }
      else {
        const auto = kid(pPr, NS.a, 'buAutoNum')
        const ch = kid(pPr, NS.a, 'buChar')
        if (auto) bullet = { kind: 'autoNum', scheme: attr(auto, 'type') ?? 'arabicPeriod', startAt: intAttr(auto, 'startAt', 1) }
        else if (ch) {
          // buFont is read beside its OWN buChar only (inherit.ts's rule)
          const bf = kid(pPr, NS.a, 'buFont')
          bullet = { kind: 'char', char: attr(ch, 'char') ?? '•', font: bf ? attr(bf, 'typeface') : undefined }
        }
      }
    }

    const pieces: Piece[] = []
    let chars = 0
    for (const c of kids(p, NS.a)) {
      if (c.local === 'r') {
        const t = kid(c, NS.a, 't')
        const text = t ? textOf(t) : ''
        if (!text) continue
        const piece = runPiece(kid(c, NS.a, 'rPr'), text, d, false)
        pieces.push(piece)
        chars += piece.chars
      } else if (c.local === 'br') {
        pieces.push({ html: '<br>', chars: 0, sizePt: d.fontSize, color: '', family: '', bold: false, italic: false, underline: false, strike: false })
      } else if (c.local === 'fld') {
        // {{page}}/{{date}} re-resolve at render time exactly like the source
        // field — an EXACT semantic match, carried without a report. Unknown
        // field types freeze to their cached text.
        const type = attr(c, 'type') ?? ''
        let token: string
        if (type === 'slidenum') token = '{{page}}'
        else if (type.startsWith('datetime')) token = '{{date}}'
        else {
          const t = kid(c, NS.a, 't')
          token = esc(t ? textOf(t) : '')
          if (!token) continue
          note('approximated', 'field-frozen', `a:fld type="${type}" has no slidomingo field; frozen to its cached text`)
        }
        const piece = runPiece(kid(c, NS.a, 'rPr'), token, d, true)
        pieces.push(piece)
        chars += piece.chars
      }
    }

    // PowerPoint paints no bullet on an empty paragraph; neither do we.
    // Both prefixes below end in &nbsp; — a plain space would collapse
    // against the glyph in html (and the entity, not the raw U+00A0, is what
    // sanitizeHtml writes back; see esc).
    let prefix = ''
    let item: Para['item']
    if (chars > 0 && bullet.kind === 'char') {
      const glyph = bulletGlyph(bullet.char ?? '•', bullet.font)
      if (PLAIN_BULLETS.has(glyph)) item = { level: lvl, ordered: false, glyph }
      else {
        prefix = `${esc(glyph)}&nbsp;`
        note('approximated', 'bullet-flattened', `the "${glyph}" bullet is kept as a glyph baked into the text (a list would draw a plain dot instead) — no list structure, so bullet colour/size and hanging indent are lost`)
      }
    } else if (chars > 0 && bullet.kind === 'autoNum') {
      if (!freezeNumbers) item = { level: lvl, ordered: true, scheme: bullet.scheme ?? 'arabicPeriod' }
      else {
        const n = counters.get(lvl) ?? bullet.startAt ?? 1
        counters.set(lvl, n + 1)
        prefix = `${esc(formatAutoNum(bullet.scheme ?? 'arabicPeriod', n))}&nbsp;`
        note('approximated', 'auto-number-frozen', 'a numbered list that does not start at 1 is frozen to literal numbers at convert time; renumbering will not follow edits')
      }
    }

    const para: Para = { pieces, chars, align, lineHeight, prefix }
    if (item) para.item = item
    paras.push(para)
  }

  // Trailing empty paragraphs are producer noise (a bare endParaRPr closes
  // most txBodies); interior empties are deliberate blank lines and stay.
  while (paras.length && paras[paras.length - 1].chars === 0 && paras[paras.length - 1].pieces.length === 0) {
    paras.pop()
  }

  const total = paras.reduce((s, p) => s + p.chars, 0)
  if (total === 0) return undefined
  for (const f of pending) ctx.report.add(f.v, f.code, where, f.detail)

  // ------------------------------------------------- dominance + flattening
  let dom: Piece | undefined
  for (const p of paras) for (const piece of p.pieces) {
    if (piece.chars > 0 && (!dom || piece.chars > dom.chars)) dom = piece
  }
  if (!dom) return undefined // unreachable given total > 0; satisfies narrowing

  let flattened = false
  for (const p of paras) for (const piece of p.pieces) {
    if (piece.chars === 0) continue
    // bold/italic/underline/strike survive as tags — only the properties the
    // sanitizer cannot carry count as loss, plus the one inexpressible bold
    // case (a lighter run inside a bold-dominant element).
    if (piece.sizePt !== dom.sizePt || piece.color !== dom.color || piece.family !== dom.family
      || (dom.bold && !piece.bold)) flattened = true
  }
  if (flattened) {
    ctx.report.add('approximated', 'run-formatting-flattened', where,
      'runs disagree on size/colour/family; the element carries the dominant run (by character count) and the rest adopt its styling')
  }

  let domPara = paras[0]
  for (const p of paras) if (p.chars > domPara.chars) domPara = p
  if (paras.some((p) => p.chars > 0 && p.align !== domPara.align)) {
    ctx.report.add('approximated', 'align-flattened', where,
      'paragraphs disagree on alignment; the element carries the dominant paragraph’s')
  }
  if (spacingSeen) {
    ctx.report.add('approximated', 'paragraph-spacing-dropped', where,
      'spcBef/spcAft have no slidomingo equivalent; paragraphs are joined at uniform line height')
  }

  // Real list markers are the renderer's, not the deck's: say so when they
  // differ — a dash list drawn as dots, "1." where the deck counted "a)".
  // Depth here is the nesting paragraphsHtml will build (levels in order).
  {
    let glyphDiffers = false
    let schemeDiffers = false
    const open: number[] = [] // source levels of the lists open at this paragraph
    for (const p of paras) {
      // an empty paragraph between items stays inside the list (lists.ts
      // foldBlankItems), so it closes nothing here either
      if (!p.item) { if (p.chars > 0 || p.pieces.length > 0) open.length = 0; continue }
      while (open.length && open[open.length - 1] > p.item.level) open.pop()
      if (!open.length || open[open.length - 1] < p.item.level) open.push(p.item.level)
      const depth = Math.min(open.length, MAX_LIST_DEPTH) - 1
      if (p.item.glyph !== undefined) {
        const g = SAME_MARKER[p.item.glyph] ?? p.item.glyph
        if (g !== markerAt(depth)) glyphDiffers = true
      }
      if (p.item.scheme !== undefined) {
        const sc = p.item.scheme
        const want = olSchemeAt(depth)
        if (!sc.startsWith(want) || !sc.endsWith('Period')) schemeDiffers = true
      }
    }
    if (glyphDiffers) {
      ctx.report.add('approximated', 'list-marker-approximated', where,
        'bullets became a real list, drawn with the standard dot/circle/square markers rather than the deck’s own glyphs')
    }
    if (schemeDiffers) {
      ctx.report.add('approximated', 'list-numbering-approximated', where,
        'numbering became a real list, counted 1. → a. → i. by nesting level rather than in the deck’s own style')
    }
  }

  // ------------------------------------------------------------- assembly
  const elementBold = dom.bold
  const inline = (p: Para): string => {
    let out = p.prefix
    for (const piece of p.pieces) {
      let h = piece.html
      if (piece.strike) h = `<s>${h}</s>`
      if (piece.underline) h = `<u>${h}</u>`
      if (piece.italic) h = `<i>${h}</i>`
      if (piece.bold && !elementBold && piece.chars > 0) h = `<b>${h}</b>`
      out += h
    }
    return out
  }
  const html = paragraphsHtml(paras.map((p): HtmlPara => p.item
    ? { kind: 'item', level: p.item.level, ordered: p.item.ordered, html: inline(p) }
    : { kind: 'line', html: inline(p) }))

  const sub = METRIC_SUBSTITUTES[dom.family]
  if (sub) {
    ctx.report.add('approximated', 'font-substituted', `font "${dom.family}"`,
      `'${dom.family}' is not embedded; emitted as a metric-compatible stack with '${sub}'`)
  }
  const fontFamily = sub ? `${cssFace(dom.family)}, ${cssFace(sub)}, sans-serif` : `${cssFace(dom.family)}, sans-serif`

  const frame = deps.resolveFrame(sp, ctx)
  const id = `txt${cnvIdOf(sp)}`
  if (autofit === 'sp' || autofit === 'absent') deps.needsRefit?.(id)

  return {
    type: 'text',
    id,
    x: px(frame.x), y: px(frame.y), w: px(frame.w), h: px(frame.h),
    rotation: frame.rotation,
    opacity: 1,
    html,
    fontSize: round2(dom.sizePt * (4 / 3) * fontScale),
    fontFamily,
    fontWeight: elementBold ? 700 : 400,
    color: dom.color,
    align: domPara.align,
    valign: anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top',
    lineHeight: round3(domPara.lineHeight * lnScale),
  }
}
