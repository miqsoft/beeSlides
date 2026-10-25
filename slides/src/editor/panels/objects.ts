// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Per-type element panels: text, shape and line, image, diagram, media, code,
// embed, equation and zoom tile (charts and tables: charts.ts).

import type { EmbedElement, ImageElement, LineEnding, MediaElement, ShapeElement, SvgElement, TextElement, CodeElement } from '../../model'
import { LANGS } from '../../../../kernel/src/tokenize.ts'
import { resolveAsset } from '../../render'
import { fitMathFrame, measureElement } from '../../measure'
import { injectFonts, populateFontSelect } from '../../fonts'
import { requestSystemFonts } from '../../localfonts'
import { ICONS } from '../../icons'
import { locale, t } from '../../i18n'
import { combineColor, parseColor } from '../colorpicker'
import { positionFloating } from '../floatingposition'
import { ElementEdits, pickMediaFile, readImageFile } from '../elementactions'
import { canvasNaturalSize } from '../cropmode'
import type { MathElement } from '../../model'
import { texError } from '../../math'
import { buildMathPalette, insertIntoTextarea, openProsePalette, tabToSlot } from '../mathpalettebar'
import { ZOOM_SECONDS, ensureTerm, termText, zoomCover, type ZoomElement } from '../../model'
import { openZoomPicker, zoomTargetLabel } from '../zoompicker'
import { type PanelContext, toast } from './context'
import { buildIconShapeStyle } from './iconset'

/**
 * Fill-style options: the stored model words are 'solid'/'gradient', only the
 * LABEL is localised. 'solid' here is a solid COLOUR, which in many languages
 * is a different word from the 'solid' LINE style further down (Swedish:
 * enfärgad vs heldragen) — so it gets its own catalog key rather than sharing
 * one that must be wrong in one of the two places.
 *
 * A function, not a const: t() in a module-level const freezes the English at
 * import time.
 */
const fillStyles = (): Array<[string, string]> =>
  [['solid', t('solid colour')], ['gradient', t('gradient')]]

/** A diagram is opaque artwork; this is the way into editing it. */
export function buildSvgProps(ctx: PanelContext, el: SvgElement) {
  const convert = document.createElement('button')
  convert.className = 'ed-btn ed-btn-block'
  convert.textContent = t('Convert to objects')
  convert.title = t('Turn this diagram into shapes, curves and text you can select and edit one by one (one undo step)')
  convert.addEventListener('click', () => ctx.panel.convertSvg(el.id))
  ctx.host.appendChild(convert)
}

/**
 * "Fit height to text" — set `h` to exactly what the content needs.
 *
 * A box that is too short lets its text spill over whatever sits below, and
 * one that is too tall throws off vertical alignment against its neighbours;
 * neither is visible in the numbers. The button reports the delta so it is
 * obvious whether anything was wrong before you press it.
 */
function buildFitHeight(ctx: PanelContext, el: TextElement) {
  if (!el.html?.trim()) return // nothing to measure yet
  const m = measureElement(el, ctx.store.doc)
  const delta = m.height - el.h
  const fit = document.createElement('button')
  fit.className = 'ed-btn ed-btn-block'
  fit.textContent = t('Fit height to text')
  fit.title = t('The text needs {need}px and the box is {have}px',
    { need: String(m.height), have: String(el.h) })
  if (delta === 0) fit.setAttribute('disabled', '')
  fit.addEventListener('click', () => {
    // measure again at click time — the text may have been edited since the
    // panel was built, and a stale height is worse than no button
    const fresh = measureElement(ctx.store.element(el.id) as TextElement, ctx.store.doc)
    ctx.mutate(el.id, (e) => { e.h = fresh.height }, true)
  })
  ctx.host.appendChild(fit)
}

/** The dynamic-field tokens render.ts's `resolveFields` understands — see
 *  render.ts's doc comment for the full list. Kept local: this is the one
 *  UI surface that needs the human labels, everywhere else reads/writes
 *  the raw token. */
const FIELD_TOKENS: Array<[string, string]> = [
  ['Page number', '{{page}}'],
  ['Total pages', '{{pages}}'],
  ['Date', '{{date}}'],
  ['Time', '{{time}}'],
  ['Title', '{{title}}'],
  ['Author', '{{author}}'],
  ['Company', '{{company}}'],
  ['Subject', '{{subject}}'],
  ['Event', '{{event}}'],
  ['Footer text', '{{footer}}'],
]

/**
 * "Insert field" — the discoverability fix for tokens that already fully
 * work (render.ts resolveFields/fieldContext) but previously had no UI:
 * you had to know to hand-type `{{page}}`. A floating menu, not a native
 * `<select>`, specifically so opening it and picking a token can keep
 * focus OFF the menu the whole time (`mousedown` + `preventDefault()` on
 * every option, same trick colorpicker.ts's native-picker button uses) —
 * a native select steals focus on open, which would end an in-progress
 * canvas text edit (canvas.ts commits on `blur`) before the token could
 * ever reach it.
 */
function buildInsertFieldControl(ctx: PanelContext, el: TextElement): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'ed-insertfield'
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'ed-btn ed-btn-block'
  trigger.textContent = t('Insert field…')
  trigger.title = t('Insert a token that resolves live — page numbers renumber as slides change, the rest follow Document properties')
  trigger.addEventListener('mousedown', (ev) => ev.preventDefault())
  wrap.appendChild(trigger)

  let pop: HTMLElement | null = null
  let close = () => {}
  trigger.addEventListener('click', () => {
    if (pop) { close(); return }
    pop = document.createElement('div')
    pop.className = 'ed-insertfield-menu'
    // plus one entry per custom document property ({{prop:Name}})
    const props = Object.keys(ctx.store.doc.meta?.custom ?? {}).map((n): [string, string, boolean] => [n, `{{prop:${n}}}`, true])
    // and, on a slide type, one per translated term ({{term:Name}}), shown
    // in the document language — terms are template chrome, not content
    const terms = ctx.store.editingSurface?.kind !== 'layout' ? [] : (ctx.store.doc.terms?.entries ?? []).map((e): [string, string, boolean] => [`${e.name} — ${termText(ctx.store.doc, e.name)}`, `{{term:${e.name}}}`, true])
    for (const [label, token, raw] of [...FIELD_TOKENS.map(([l, tk]): [string, string, boolean] => [l, tk, false]), ...props, ...terms]) {
      const opt = document.createElement('button')
      opt.type = 'button'
      opt.textContent = raw ? label : t(label)
      opt.addEventListener('mousedown', (ev) => ev.preventDefault())
      opt.addEventListener('click', () => {
        insertFieldToken(ctx, el.id, token)
        close()
      })
      pop.appendChild(opt)
    }
    wrap.appendChild(pop)
    positionFloating(trigger, pop, { placement: 'bottom-start' })
    close = () => {
      pop?.remove()
      pop = null
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('keydown', onKey, true)
    }
    const onOutside = (ev: PointerEvent) => {
      if (pop && !pop.contains(ev.target as Node) && ev.target !== trigger) close()
    }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true))
    document.addEventListener('keydown', onKey, true)
  })
  return wrap
}

/**
 * "Make translatable" (template window, a slide type's text): the words
 * selected in a live edit — or, with no edit open, the whole text when it
 * is plain — become a `doc.terms` entry (`model.ensureTerm`) and a
 * `{{term:…}}` token in their place. Same focus trick as Insert field: the
 * button never takes focus, so the edit's Selection is still there.
 */
function buildMakeTranslatable(ctx: PanelContext, el: TextElement): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-btn ed-btn-block'
  b.textContent = t('Make translatable')
  b.title = t('Turn the selected words into a term of this layout, so each deck shows them in its own language (Document properties ▸ Language & terms)')
  b.addEventListener('mousedown', (ev) => ev.preventDefault())
  b.addEventListener('click', () => {
    const editingNode = document.querySelector<HTMLElement>('.beeslides-editing')
    const inner = editingNode?.dataset.elId === el.id ? editingNode.querySelector<HTMLElement>('.beeslides-text-inner') : null
    const lang = ctx.store.doc.meta?.language || locale().split('-')[0] || 'en'
    if (inner && document.activeElement === inner) {
      const sel = window.getSelection()
      const text = sel && !sel.isCollapsed && inner.contains(sel.anchorNode) ? sel.toString() : ''
      if (!text.trim() || text.includes('{{')) { toast(t('Select the words to translate first')); return }
      let name = ''
      ctx.store.commit(() => { name = ensureTerm(ctx.store.doc, text, lang) })
      document.execCommand('insertText', false, `{{term:${name}}}`)
      return
    }
    const cur = ctx.store.slide?.elements.find((e) => e.id === el.id) as TextElement | undefined
    if (!cur || /[<{]/.test(cur.html) || !cur.html.trim()) { toast(t('Select the words to translate first')); return }
    ctx.store.commit(() => {
      const plain = new DOMParser().parseFromString(cur.html, 'text/html').body.textContent ?? ''
      const name = ensureTerm(ctx.store.doc, plain, lang)
      cur.html = `{{term:${name}}}`
    })
  })
  return b
}

/**
 * Insert one field token into a text element two different ways, per the
 * design's deliberate split:
 *
 * - Mid live-edit (the canvas contentEditable session for THIS element is
 *   still open — checked via the DOM, not store state, since that is the
 *   only place edit-in-progress lives): insert at the cursor with
 *   `execCommand('insertText', …)`. This only works because the trigger/
 *   option buttons above never took focus (mousedown preventDefault), so
 *   `document.activeElement` is still the live contentEditable and its
 *   Selection/Range is exactly where the author left it.
 * - Otherwise (element merely selected): append to the end of `el.html`
 *   through the normal panel `mutate()` path. Panels don't track cursor
 *   position outside an active edit session, so this is a deliberate,
 *   documented simplification, not a bug.
 */
function insertFieldToken(ctx: PanelContext, elId: string, token: string) {
  const editingNode = document.querySelector<HTMLElement>('.beeslides-editing')
  const inner = editingNode?.dataset.elId === elId
    ? editingNode.querySelector<HTMLElement>('.beeslides-text-inner')
    : null
  if (inner && document.activeElement === inner) {
    document.execCommand('insertText', false, token)
    return
  }
  ctx.mutate(elId, (e) => { (e as TextElement).html = (e as TextElement).html + token }, true)
}

export function buildTextProps(ctx: PanelContext, el: TextElement) {
  // --- basics ---------------------------------------------------------------
  ctx.row('Font', fontSelect(ctx, el))
  // Shown in POINTS (the unit office users know); the model stores slide-space
  // px. 1pt = 4/3 px at the slide's 96dpi space, so 32px = 24pt exactly.
  ctx.row('Size (pt)', ctx.number(ElementEdits.fontSizePt(el), 1, (v, fin) =>
    ctx.edits.setFontSizePt(el.id, v, fin)))
  const tgrad = el.colorGradient
  ctx.row('Color', tgrad
    ? ctx.gradientJump('Typography')
    : ctx.color(el.color, (v, fin) => ctx.edits.setFill(el.id, v, fin), { id: el.id, path: 'color' }))
  ctx.row('Weight', weightSelect(ctx, el))
  ctx.row('Align', ctx.segButtons([
    ['left', t('left'), ICONS.textLeft],
    ['center', t('center'), ICONS.textCenter],
    ['right', t('right'), ICONS.textRight],
  ], el.align, (v) => ctx.edits.setTextAlign(el.id, v as TextElement['align'])))

  // --- more -----------------------------------------------------------------
  ctx.section('Typography', {
    modified: !!(tgrad || el.textStroke?.width || el.valign !== 'middle' || el.lineHeight !== 1.25),
  })
  // Text fill: a solid colour, or a multi-stop gradient painted into the glyphs.
  ctx.row('Fill style', ctx.labeledSelect(fillStyles(), tgrad ? 'gradient' : 'solid', (v) =>
    ctx.mutate(el.id, (e) => {
      const tx = e as TextElement
      if (v === 'gradient') {
        const base = parseColor(tx.color)
        tx.colorGradient ??= {
          angle: 90,
          stops: [
            { at: 0, color: combineColor(base.hex, Math.max(base.a, 1)) },
            { at: 1, color: '#5B8DEF' },
          ],
        }
      } else {
        delete tx.colorGradient
      }
    }, true)))
  if (tgrad) {
    ctx.row('Grad. angle', ctx.number(tgrad.angle, 1, (v, fin) =>
      ctx.mutate(el.id, (e) => {
        const g = (e as TextElement).colorGradient
        if (g) g.angle = v
      }, fin)))
    ctx.host.appendChild(ctx.gradientBar(el.id, (e) => (e as TextElement).colorGradient?.stops))
    tgrad.stops.forEach((stop, i) => {
      const wrap = document.createElement('div')
      wrap.className = 'ed-gradstop'
      const at = ctx.number(Math.round(stop.at * 100), 1, (v, fin) =>
        ctx.mutate(el.id, (e) => {
          const g = (e as TextElement).colorGradient
          if (g?.stops[i]) g.stops[i].at = Math.min(Math.max(v / 100, 0), 1)
        }, fin))
      at.title = t('Position %')
      const color = ctx.colorAlpha(stop.color, (v, fin) =>
        ctx.mutate(el.id, (e) => {
          const g = (e as TextElement).colorGradient
          if (g?.stops[i]) g.stops[i].color = v
        }, fin))
      wrap.append(at, color)
      if (tgrad.stops.length > 2) {
        const del = document.createElement('button')
        del.className = 'ed-btn ed-btn-icon'
        del.textContent = '✕'
        del.title = t('Remove stop')
        del.addEventListener('click', () =>
          ctx.mutate(el.id, (e) => {
            const g = (e as TextElement).colorGradient
            if (g && g.stops.length > 2) g.stops.splice(i, 1)
          }, true))
        wrap.appendChild(del)
      }
      ctx.row(`Stop ${i + 1}`, wrap)
    })
    const addStop = document.createElement('button')
    addStop.className = 'ed-btn ed-btn-block'
    addStop.textContent = t('＋ Add stop')
    addStop.title = t('Add gradient stop')
    addStop.addEventListener('click', () =>
      ctx.mutate(el.id, (e) => {
        const g = (e as TextElement).colorGradient
        if (!g) return
        const mid = g.stops[Math.floor(g.stops.length / 2)]
        g.stops.push({ at: 0.5, color: mid?.color ?? '#808080' })
        g.stops.sort((a, b) => a.at - b.at)
      }, true))
    ctx.host.appendChild(addStop)
  }
  ctx.row('V-align', ctx.select(['top', 'middle', 'bottom'], el.valign, (v) =>
    ctx.mutate(el.id, (e) => { (e as TextElement).valign = v as TextElement['valign'] }, true)))
  ctx.row('Line height', ctx.number(el.lineHeight, 0.05, (v, fin) =>
    ctx.mutate(el.id, (e) => { (e as TextElement).lineHeight = Math.max(v, 0.5) }, fin)))

  // Outline / hollow glyphs via -webkit-text-stroke. Width 0 = off; 'hollow'
  // makes the glyph interior transparent (the classic outlined section word).
  const ts = el.textStroke
  ctx.row('Outline', ctx.number(ts?.width ?? 0, 0.5, (v, fin) =>
    ctx.mutate(el.id, (e) => {
      const tx = e as TextElement
      if (v > 0) tx.textStroke = { color: '#1D1119', ...(tx.textStroke ?? {}), width: v }
      else delete tx.textStroke
    }, fin)))
  if (ts && ts.width) {
    ctx.row('Outline color', ctx.colorAlpha(ts.color, (v, fin) =>
      ctx.mutate(el.id, (e) => {
        const g = (e as TextElement).textStroke
        if (g) g.color = v
      }, fin)))
    ctx.row('Interior', ctx.select(['filled', 'hollow'], ts.fill === 'none' ? 'hollow' : 'filled', (v) =>
      ctx.mutate(el.id, (e) => {
        const g = (e as TextElement).textStroke
        if (g) { if (v === 'hollow') g.fill = 'none'; else delete g.fill }
      }, true)))
  }

  buildFitHeight(ctx, el)
  ctx.host.appendChild(buildInsertFieldControl(ctx, el))
  if (ctx.store.editingSurface?.kind === 'layout' && ctx.store.doc.template) ctx.host.appendChild(buildMakeTranslatable(ctx, el))
  ctx.host.appendChild(buildInsertMathControl(ctx, el))
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.innerHTML = t('While editing: <b>⌘B</b>/<b>⌘I</b>/<b>⌘U</b> · markdown auto-converts — **bold*&#8203;* *italic*&#8203; `code` ~~strike~~ and "- " bullets; pasting markdown converts too. Escape with \\ or press ⌘Z right after to keep the literal characters.')
  ctx.host.appendChild(hint)

  const embed = document.createElement('button')
  embed.className = 'ed-btn ed-btn-block'
  embed.textContent = t('＋ Embed font file…')
  embed.title = t('Bundle a .woff2/.woff/.ttf/.otf into this file and use it here')
  embed.addEventListener('click', () => embedFont(ctx, el))
  ctx.host.appendChild(embed)
}

/**
 * Font picker: theme default, fonts embedded in the document, fonts actually
 * installed on the machine (Local Font Access API — see localfonts.ts),
 * curated cross-platform stacks, and (if unmatched) the element's current
 * custom stack. Options render in their own face so the menu previews itself.
 */
function fontSelect(ctx: PanelContext, el: TextElement): HTMLElement {
  // Only ever reached from a genuine user-gesture-triggered rebuild (panel
  // rebuilds are downstream of clicks/keypresses), which is what satisfies
  // queryLocalFonts()'s transient-activation requirement.
  requestSystemFonts()
  const sel = document.createElement('select')
  populateFontSelect(sel, ctx.store.doc, el.fontFamily ?? '', 'theme default')
  sel.addEventListener('change', () =>
    ctx.mutate(el.id, (e) => { (e as TextElement).fontFamily = sel.value }, true))
  return sel
}

/** Bundle a font file into the document and apply it to this element. */
function embedFont(ctx: PanelContext, el: TextElement) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.woff2,.woff,.ttf,.otf'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const family = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'Embedded font'
      const asset = `font_${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
      ctx.store.commit(() => {
        const doc = ctx.store.doc
        doc.assets = { ...(doc.assets ?? {}), [asset]: String(reader.result) }
        doc.fonts = [...(doc.fonts ?? []).filter((f) => f.family !== family), { family, asset }]
        const live = ctx.store.element(el.id)
        if (live && live.type === 'text') live.fontFamily = family
      })
      injectFonts(ctx.store.doc)
      toast(`"${family}" embedded into this file`)
    }
    reader.readAsDataURL(file)
  })
  input.click()
}

export function buildShapeProps(ctx: PanelContext, el: ShapeElement) {
  const line = el.shape === 'line'
  const path = el.shape === 'path'
  const grad = el.fillGradient
  // a line's one colour row says what it paints; a borderless shape's
  // Stroke opens on the default grey at 0% (picking a colour lifts that to
  // 100% — colorpicker.ts alphaAfterHuePick), see ElementEdits.strokeOf
  const strokeRow = () => ctx.row(line ? 'Line color' : 'Stroke', ctx.colorAlpha(ctx.edits.strokeOf(el), (v, fin) =>
    ctx.edits.setStroke(el.id, v, fin), { id: el.id, path: ElementEdits.strokePath(el) }))
  const widthRow = () => ctx.row('Stroke width', ctx.number(el.strokeWidth, 0.5, (v, fin) =>
    ctx.edits.setStrokeWidth(el.id, v, fin)))
  const fillRow = () => ctx.row('Fill', grad
    ? ctx.gradientJump('Fill & stroke')
    : ctx.colorAlpha(el.fill, (v, fin) => ctx.edits.setFill(el.id, v, fin), { id: el.id, path: 'fill' }))
  const lineStyleRow = () => ctx.row('Line style', ctx.select(
    ['solid', 'dashed', 'dotted'],
    el.strokeStyle ?? (el.strokeDash ? 'dashed' : 'solid'),
    (v) => ctx.mutate(el.id, (e) => {
      const s = e as ShapeElement
      s.strokeStyle = v === 'solid' ? undefined : (v as 'dashed' | 'dotted')
      if (v === 'solid') delete s.strokeDash // clear the legacy dash too
    }, true)))
  const dashed = !!(el.strokeStyle && el.strokeStyle !== 'solid') || !!el.strokeDash

  if (line) {
    // A line is all stroke: its colour (stored in `fill` — see
    // ElementEdits.setStroke), its width and its tips are the basics.
    const ENDINGS = ['none', 'arrow', 'dot', 'bar']
    strokeRow()
    widthRow()
    ctx.row('Start tip', ctx.select(ENDINGS, el.lineStart ?? 'none', (v) =>
      ctx.mutate(el.id, (e) => { (e as ShapeElement).lineStart = v === 'none' ? undefined : (v as LineEnding) }, true)))
    ctx.row('End tip', ctx.select(ENDINGS, el.lineEnd ?? 'none', (v) =>
      ctx.mutate(el.id, (e) => { (e as ShapeElement).lineEnd = v === 'none' ? undefined : (v as LineEnding) }, true)))
    buildIconShapeStyle(ctx, [el]) // after the basics: they belong to the fixed header
    ctx.section('Stroke', { modified: dashed || !!el.strokeCap })
    lineStyleRow()
    ctx.row('Cap style', ctx.select(['round', 'square', 'butt'], el.strokeCap ?? 'round', (v) =>
      ctx.mutate(el.id, (e) => { (e as ShapeElement).strokeCap = v === 'round' ? undefined : (v as 'round' | 'square' | 'butt') }, true)))
    return
  }

  // A curve is usually an open stroke, so its stroke leads; every other
  // shape leads with its fill.
  if (path) { strokeRow(); widthRow(); fillRow() }
  else { fillRow(); strokeRow(); widthRow() }
  if (el.shape === 'rect') {
    ctx.row('Corner radius', ctx.number(el.radius, 1, (v, fin) =>
      ctx.mutate(el.id, (e) => { (e as ShapeElement).radius = Math.max(v, 0) }, fin)))
  }

  buildIconShapeStyle(ctx, [el]) // after the basics: they belong to the fixed header
  ctx.section('Fill & stroke', { modified: !!grad || dashed })
  ctx.row('Fill style', ctx.labeledSelect(fillStyles(), grad ? 'gradient' : 'solid', (v) =>
    ctx.mutate(el.id, (e) => {
      const s = e as ShapeElement
      if (v === 'gradient') {
        const base = parseColor(s.fill)
        s.fillGradient ??= {
          angle: 180,
          stops: [
            { at: 0, color: combineColor(base.hex, Math.max(base.a, 0.85)) },
            { at: 1, color: combineColor(base.hex, 0) },
          ],
        }
      } else {
        delete s.fillGradient
      }
    }, true)))

  if (grad) {
    ctx.row('Grad. angle', ctx.number(grad.angle, 1, (v, fin) =>
      ctx.mutate(el.id, (e) => {
        const g = (e as ShapeElement).fillGradient
        if (g) g.angle = v
      }, fin)))
    ctx.host.appendChild(ctx.gradientBar(el.id, (e) => (e as ShapeElement).fillGradient?.stops))
    grad.stops.forEach((stop, i) => {
      const wrap = document.createElement('div')
      wrap.className = 'ed-gradstop'
      const at = ctx.number(Math.round(stop.at * 100), 1, (v, fin) =>
        ctx.mutate(el.id, (e) => {
          const g = (e as ShapeElement).fillGradient
          if (g?.stops[i]) g.stops[i].at = Math.min(Math.max(v / 100, 0), 1)
        }, fin))
      at.title = t('Position %')
      const color = ctx.colorAlpha(stop.color, (v, fin) =>
        ctx.mutate(el.id, (e) => {
          const g = (e as ShapeElement).fillGradient
          if (g?.stops[i]) g.stops[i].color = v
        }, fin))
      wrap.append(at, color)
      if (grad.stops.length > 2) {
        const del = document.createElement('button')
        del.className = 'ed-btn ed-btn-icon'
        del.textContent = '✕'
        del.title = t('Remove stop')
        del.addEventListener('click', () =>
          ctx.mutate(el.id, (e) => {
            const g = (e as ShapeElement).fillGradient
            if (g && g.stops.length > 2) g.stops.splice(i, 1)
          }, true))
        wrap.appendChild(del)
      }
      ctx.row(`Stop ${i + 1}`, wrap)
    })
    const add = document.createElement('button')
    add.className = 'ed-btn ed-btn-block'
    add.textContent = t('＋ Add stop')
    add.title = t('Add gradient stop')
    add.addEventListener('click', () =>
      ctx.mutate(el.id, (e) => {
        const g = (e as ShapeElement).fillGradient
        if (!g) return
        const mid = g.stops[Math.floor(g.stops.length / 2)]
        g.stops.push({ at: 0.5, color: mid?.color ?? '#808080' })
        g.stops.sort((a, b) => a.at - b.at)
      }, true))
    ctx.host.appendChild(add)
  }

  lineStyleRow()
}

export function buildImageProps(ctx: PanelContext, el: ImageElement) {
  const replace = document.createElement('button')
  replace.className = 'ed-btn ed-btn-block'
  replace.textContent = t('Replace image…')
  replace.title = t('Pick a new picture — position, size and effects stay')
  replace.addEventListener('click', () => {
    void readImageFile().then((picked) => { if (picked) ctx.edits.replaceImageSrc(el.id, picked.src) })
  })
  ctx.host.appendChild(replace)
  // crop mode lives on the canvas (editor/cropmode.ts); double-click works too
  const crop = document.createElement('button')
  crop.className = 'ed-btn ed-btn-block'
  crop.textContent = t('Crop')
  crop.title = t('Cut the picture down by dragging its edges on the canvas (or double-click it)')
  crop.addEventListener('click', () =>
    document.dispatchEvent(new CustomEvent('slidomingo:crop-image', { detail: { id: el.id } })))
  ctx.host.appendChild(crop)
  if (el.crop) {
    const reset = document.createElement('button')
    reset.className = 'ed-btn ed-btn-block'
    reset.textContent = t('Reset crop')
    reset.title = t('Show the whole picture again')
    reset.addEventListener('click', () => ctx.edits.resetImageCrop(el.id, ...canvasNaturalSize(el.id)))
    ctx.host.appendChild(reset)
  } else {
    // a cropped picture always fills its frame, so Fit has nothing to say
    ctx.row('Fit', ctx.select(['contain', 'cover', 'fill'], el.fit, (v) =>
      ctx.edits.setImageFit(el.id, v as ImageElement['fit'])))
  }
  ctx.row('Corner radius', ctx.number(el.radius, 1, (v, fin) =>
    ctx.mutate(el.id, (e) => { (e as ImageElement).radius = Math.max(v, 0) }, fin)))
}

/** Zoom tile (model.ts ZoomElement): what it zooms into, how much it plays,
 *  whether it comes back; the camera speed and the frame in "Zoom tile". */
export function buildZoomProps(ctx: PanelContext, el: ZoomElement) {
  const doc = ctx.store.doc
  const target = el.target
  const what = document.createElement('p')
  what.className = 'ed-hint ed-zoom-target'
  what.textContent = zoomTargetLabel(doc, target)
  ctx.host.appendChild(what)
  const btns = document.createElement('div')
  btns.className = 'ed-grid2'
  const change = document.createElement('button')
  change.className = 'ed-btn ed-btn-block'
  change.textContent = t('Change…')
  change.title = t('Pick another slide or section for this tile')
  change.addEventListener('click', () => openZoomPicker(ctx.store, {
    multi: false,
    title: t('Change zoom target'),
    overviewId: ctx.store.slide.id,
    current: target,
    onPick: ([next]) => {
      if (next) ctx.mutate(el.id, (e) => {
        const z = e as ZoomElement
        z.target = next
        if ('section' in next) delete z.range
      }, true)
    },
  }))
  const go = document.createElement('button')
  go.className = 'ed-btn ed-btn-block'
  go.textContent = t('Go to target')
  go.title = t('Show the slide this tile zooms into')
  const cover = zoomCover(doc, el, ctx.store.slide.id)
  go.disabled = !cover
  go.addEventListener('click', () => {
    const i = cover ? ctx.store.doc.slides.indexOf(cover) : -1
    if (i >= 0) ctx.store.goTo(i)
  })
  btns.append(change, go)
  ctx.host.appendChild(btns)
  if (target && 'slide' in target) {
    const PLAYS = ['This slide only', 'To the end of its section']
    ctx.row('Plays', ctx.select(PLAYS, el.range === 'section' ? PLAYS[1] : PLAYS[0], (v) =>
      ctx.mutate(el.id, (e) => {
        const z = e as ZoomElement
        if (v === PLAYS[1]) z.range = 'section'
        else delete z.range
      }, true)))
  }
  ctx.row('Return to zoom', ctx.select(['on', 'off'], el.returnToZoom === false ? 'off' : 'on', (v) =>
    ctx.mutate(el.id, (e) => {
      const z = e as ZoomElement
      if (v === 'off') z.returnToZoom = false
      else delete z.returnToZoom
    }, true)))

  // --- more -------------------------------------------------------------------
  ctx.section('Zoom tile')
  ctx.row('Duration (s)', ctx.number(el.duration ?? ZOOM_SECONDS, 0.1, (v, fin) =>
    ctx.mutate(el.id, (e) => { (e as ZoomElement).duration = Math.min(60, Math.max(0.1, v)) }, fin)))
  ctx.row('Frame color', ctx.color(el.stroke ?? '#FFFFFF', (v, fin) =>
    ctx.mutate(el.id, (e) => { (e as ZoomElement).stroke = v }, fin)))
  ctx.row('Frame width', ctx.number(el.strokeWidth ?? 0, 1, (v, fin) =>
    ctx.mutate(el.id, (e) => { (e as ZoomElement).strokeWidth = Math.min(200, Math.max(0, v)) }, fin)))
  ctx.row('Corner radius', ctx.number(el.radius ?? 0, 1, (v, fin) =>
    ctx.mutate(el.id, (e) => { (e as ZoomElement).radius = Math.max(0, v) }, fin)))
}

export function buildMediaProps(ctx: PanelContext, el: MediaElement) {
  // source status: embedded (with size) / linked / none
  const status = document.createElement('p')
  status.className = 'ed-hint'
  // Resolve first: an embed is stored as an `asset:` ref, so testing el.src
  // directly would report an embedded clip as "linked".
  const resolved = el.src ? resolveAsset(ctx.store.doc, el.src) : ''
  if (!el.src) status.textContent = t('No source yet — choose a file or paste a URL.')
  else if (resolved.startsWith('data:')) {
    const kb = Math.round((resolved.length * 3) / 4 / 1024)
    status.innerHTML = t('Embedded in the file') + ` · <b>${kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'}</b>`
  } else status.textContent = t('Linked — the deck stays small but needs this URL to play.')
  ctx.host.appendChild(status)

  // replace / choose file (embeds; warns over budget)
  const replace = document.createElement('button')
  replace.className = 'ed-btn ed-btn-block'
  replace.textContent = el.src ? t('Replace file…') : t('Choose file…')
  replace.addEventListener('click', () => {
    void pickMediaFile(el.kind).then((src) => { if (src) ctx.edits.replaceMediaSrc(el.id, src) })
  })
  ctx.host.appendChild(replace)

  // playback
  // Labels stay RAW English — row() translates them, and looks its tooltip up
  // by the English label. Passing t(…) here would translate twice and miss
  // ROW_TIPS in every locale but English.
  const toggle = (label: string, on: boolean, set: (v: boolean) => void) =>
    ctx.row(label, ctx.select(['off', 'on'], on ? 'on' : 'off', (v) => set(v === 'on')))
  toggle('Autoplay', !!el.autoplay, (v) => ctx.edits.setMediaAutoplay(el.id, v))
  toggle('Loop', !!el.loop, (v) => ctx.mutate(el.id, (e) => { (e as MediaElement).loop = v || undefined }, true))

  // --- more -------------------------------------------------------------------
  ctx.section('Source & playback')
  // URL (reference) — clears an embed when set
  const url = document.createElement('input')
  url.type = 'text'
  url.placeholder = t('…or paste a media URL')
  url.value = el.src && !el.src.startsWith('data:') && !el.src.startsWith('asset:') ? el.src : ''
  url.addEventListener('change', () =>
    ctx.mutate(el.id, (e) => { (e as MediaElement).src = url.value.trim() }, true))
  ctx.row('URL', url)

  toggle('Controls', el.controls !== false, (v) => ctx.mutate(el.id, (e) => { (e as MediaElement).controls = v ? undefined : false }, true))
  toggle('Muted', !!el.muted, (v) => ctx.mutate(el.id, (e) => { (e as MediaElement).muted = v || undefined }, true))
  const note = document.createElement('p')
  note.className = 'ed-hint'
  note.textContent = t('Autoplay runs only while presenting; browsers require “muted” for video to autoplay.')
  ctx.host.appendChild(note)

  if (el.kind === 'video') {
    ctx.row('Fit', ctx.select(['contain', 'cover', 'fill'], el.fit ?? 'contain', (v) =>
      ctx.mutate(el.id, (e) => { (e as MediaElement).fit = v as MediaElement['fit'] }, true)))
    ctx.row('Corner radius', ctx.number(el.radius ?? 0, 1, (v, fin) =>
      ctx.mutate(el.id, (e) => { (e as MediaElement).radius = Math.max(v, 0) }, fin)))
    const poster = document.createElement('input')
    poster.type = 'text'
    poster.placeholder = t('Poster image URL (optional)')
    poster.value = el.poster && !el.poster.startsWith('data:') ? el.poster : ''
    poster.addEventListener('change', () =>
      ctx.mutate(el.id, (e) => {
        const m = e as MediaElement
        const v = poster.value.trim()
        if (v) m.poster = v; else delete m.poster
      }, true))
    ctx.row('Poster', poster)
  }
}

export function buildCodeProps(ctx: PanelContext, el: CodeElement) {
  // Language — selects the built-in tokenizer table. grammarName doubles as
  // the language id; grammarAssetId/themeAssetId stay in the format as the
  // seam for a future signed-extension tier carrying real TextMate grammars
  // as deck assets, at which point pickers for them return here.
  const langs = Object.keys(LANGS).sort().concat(['diff', 'md'])
  ctx.row('Language', ctx.select(langs, el.grammarName ?? 'js', (v) =>
    ctx.mutate(el.id, (e) => { (e as CodeElement).grammarName = v }, true)))
  // Shown in POINTS (the unit office users know); the model stores slide-space
  // px. 1pt = 4/3 px at the slide's 96dpi space, so 32px = 24pt exactly.
  ctx.row('Size (pt)', ctx.number(ElementEdits.fontSizePt(el), 1, (v, fin) =>
    ctx.edits.setFontSizePt(el.id, v, fin)))

  // --- more -------------------------------------------------------------------
  ctx.section('Source Code')
  // Alignment
  ctx.row('Align', ctx.select(['left', 'center', 'right'], el.align, (v) =>
    ctx.mutate(el.id, (e) => { (e as CodeElement).align = v as CodeElement['align'] }, true)))
  // V-Alignment
  ctx.row('V-align', ctx.select(['top', 'middle', 'bottom'], el.valign, (v) =>
    ctx.mutate(el.id, (e) => { (e as CodeElement).valign = v as CodeElement['valign'] }, true)))
  // Line height
  ctx.row('Line height', ctx.number(el.lineHeight, 0.05, (v, fin) =>
    ctx.mutate(el.id, (e) => { (e as CodeElement).lineHeight = Math.max(v, 0.5) }, fin)))
  const status = document.createElement('p')
  status.className = 'ed-hint'
  status.textContent = t('{n} languages built in', { n: String(langs.length) })
  ctx.host.appendChild(status)
}

export function buildEmbedProps(ctx: PanelContext, el: EmbedElement) {
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.textContent = t('Runs sandboxed — scripts and canvas work, but the embed can’t read this page’s data, navigate it, or open popups.')
  ctx.host.appendChild(hint)
  const ta = document.createElement('textarea')
  ta.className = 'ed-chart-json' // same monospace/rows-friendly styling as the JSON escape hatches
  ta.rows = 14
  ta.spellcheck = false
  ta.value = el.html
  ta.addEventListener('change', () => ctx.mutate(el.id, (e) => { (e as EmbedElement).html = ta.value }, true))
  ctx.host.appendChild(ta)
}

export function buildMathProps(ctx: PanelContext, el: MathElement) {
  // --- basics ---------------------------------------------------------------
  // The TeX itself, editable in place. Committed on blur / ⌘↵ as ONE step
  // that also fits the box; the popover (Edit…) is the roomier way in.
  const ta = document.createElement('textarea')
  ta.className = 'ed-math-tex ed-math-tex-panel'
  ta.rows = 3
  ta.spellcheck = false
  ta.value = el.tex
  ta.setAttribute('aria-label', t('TeX source'))
  const err = document.createElement('p')
  err.className = 'ed-math-err'
  err.setAttribute('role', 'status')
  const status = () => {
    const msg = texError(ta.value)
    err.textContent = msg ? t('TeX error: {msg}', { msg }) : ''
    err.hidden = !msg
  }
  let dirty = false
  const commit = () => {
    if (!dirty) return
    dirty = false
    const tex = ta.value
    ctx.mutate(el.id, (e) => {
      if (e.type !== 'math') return
      e.tex = tex
      Object.assign(e, fitMathFrame(e, ctx.store.doc))
    }, true)
  }
  ta.addEventListener('input', () => { dirty = true; status() })
  ta.addEventListener('blur', commit)
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && tabToSlot(ta, ev.shiftKey)) { ev.preventDefault(); return }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); commit() }
  })
  ctx.host.appendChild(ta)
  status()
  ctx.host.appendChild(err)

  const tools = document.createElement('div')
  tools.className = 'ed-math-tools'
  const pal = document.createElement('div')
  pal.className = 'ed-math-panel-palette'
  pal.hidden = true
  const palBtn = document.createElement('button')
  palBtn.type = 'button'
  palBtn.className = 'ed-btn'
  palBtn.textContent = t('∑ Palette')
  palBtn.title = t('Structures, symbols and common formulas — inserted at the caret')
  palBtn.setAttribute('aria-expanded', 'false')
  // mousedown: keep the caret where it is in the TeX field
  palBtn.addEventListener('mousedown', (ev) => ev.preventDefault())
  palBtn.addEventListener('click', () => {
    if (!pal.firstChild) pal.appendChild(buildMathPalette((s) => insertIntoTextarea(ta, s, () => { dirty = true; status() })))
    pal.hidden = !pal.hidden
    palBtn.setAttribute('aria-expanded', String(!pal.hidden))
  })
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'ed-btn'
  edit.textContent = t('Edit…')
  edit.title = t('Open the equation editor with a live preview (or double-click the equation)')
  edit.addEventListener('click', () => {
    commit()
    document.dispatchEvent(new CustomEvent('slidomingo:edit-math', { detail: { id: el.id } }))
  })
  tools.append(palBtn, edit)
  ctx.host.append(tools, pal)

  ctx.row('Size (pt)', ctx.number(ElementEdits.fontSizePt(el), 1, (v, fin) =>
    ctx.edits.setFontSizePt(el.id, v, fin)))
  ctx.row('Color', ctx.color(el.color, (v, fin) => ctx.edits.setFill(el.id, v, fin), { id: el.id, path: 'color' }))
  ctx.row('Align', ctx.segButtons([
    ['left', t('left'), ICONS.textLeft],
    ['center', t('center'), ICONS.textCenter],
    ['right', t('right'), ICONS.textRight],
  ], el.align, (v) => ctx.edits.setTextAlign(el.id, v as MathElement['align'])))

  // --- more -----------------------------------------------------------------
  ctx.section('Typesetting', { modified: !!el.inline || el.valign !== 'middle' })
  ctx.row('Style', ctx.labeledSelect([['display', t('Display')], ['inline', t('Inline')]], el.inline ? 'inline' : 'display', (v) =>
    ctx.mutate(el.id, (e) => {
      if (e.type !== 'math') return
      if (v === 'inline') e.inline = true
      else delete e.inline
      Object.assign(e, fitMathFrame(e, ctx.store.doc))
    }, true)))
  ctx.row('V-align', ctx.select(['top', 'middle', 'bottom'], el.valign, (v) =>
    ctx.mutate(el.id, (e) => { (e as MathElement).valign = v as MathElement['valign'] }, true)))
  const fit = document.createElement('button')
  fit.className = 'ed-btn ed-btn-block'
  fit.textContent = t('Fit box to equation')
  fit.title = t('Height to the formula; the width only grows')
  fit.addEventListener('click', () => ctx.mutate(el.id, (e) => {
    if (e.type === 'math') Object.assign(e, fitMathFrame(e, ctx.store.doc))
  }, true))
  ctx.host.appendChild(fit)
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.textContent = t('LaTeX, typeset by Temml. Inline math also works in any text box or table cell: type $…$.')
  ctx.host.appendChild(hint)
}

/** Typography's "Insert equation…": the palette over a live text edit
 *  (typed at the caret as $…$), or — the box merely selected — a new
 *  formula appended to its text. */
function buildInsertMathControl(ctx: PanelContext, el: TextElement): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-btn ed-btn-block'
  b.textContent = t('Insert equation…')
  b.title = t('Pick a structure or symbol — it is typed into the text as $…$ math')
  // never take focus: a live text edit must survive the click
  b.addEventListener('mousedown', (ev) => ev.preventDefault())
  b.addEventListener('click', () => openProsePalette(b, (s) =>
    ctx.mutate(el.id, (e) => { if (e.type === 'text') e.html = `${e.html}$${s.preview ?? s.tex}$` }, true)))
  return b
}

/** Weight picker with the familiar named weights; stores the numeric value. */
function weightSelect(ctx: PanelContext, el: TextElement): HTMLElement {
  const WEIGHTS: Array<[number, string]> = [
    [100, 'Thin'], [200, 'Extra light'], [300, 'Light'], [400, 'Regular'],
    [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black'],
  ]
  const sel = document.createElement('select')
  const current = el.fontWeight ?? 400
  if (!WEIGHTS.some(([n]) => n === current)) {
    const o = document.createElement('option')
    o.value = String(current)
    o.textContent = t('Custom ({n})', { n: current })
    o.selected = true
    sel.appendChild(o)
  }
  for (const [n, name] of WEIGHTS) {
    const o = document.createElement('option')
    o.value = String(n)
    o.textContent = t(name)
    o.style.fontWeight = String(n)
    if (n === current) o.selected = true
    sel.appendChild(o)
  }
  sel.addEventListener('change', () =>
    ctx.mutate(el.id, (e) => { (e as TextElement).fontWeight = parseInt(sel.value) }, true))
  return sel
}
