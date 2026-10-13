// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The "Default styles" form: what NEW shapes, lines and text look like on
// slides of one slide type (Layout Manager ▸ slide-type panel), or on slides
// with no type (Layout Manager ▸ Document properties, `doc.theme`).
//
// Every control shows the EFFECTIVE value — model.ts resolveStyleDefaults,
// the same function the insert tools use — with a quiet "From: …" hint that
// says which level it came from. Editing a control writes only that field at
// this level; there is no "customize" step. A card's Reset clears the level's
// overrides so the card inherits again (and removes a per-kind sub-card).
//
// Colours keep their palette link: a swatch records the ref, and a hand-picked
// colour that exactly matches a palette slot is linked to it
// (palette.ts slotForLiteral), so re-branding the deck carries through.
//
// Writes happen on COMMIT only (a colour's final pick, a number's change):
// both hosts re-render on every doc change, and a live write would tear the
// open colour popover down mid-drag.

import type { Store } from '../store'
import {
  defaultShape, defaultText, lineDefaultsFor, resolveStyleDefaults, SHADOW_PRESETS, shapeDefaultsFor, STYLE_SHAPE_KINDS,
  textDefaultsFor, isVisibleColor,
  type LineEnding, type ShadowSpec, type ShapeStyle, type Slide, type SlidomingoDoc, type StyleDefaults, type StyleKind,
  type StyleShapeKind, type StyleSource,
} from '../model'
import { cssColor, renderElement, resolveSlideFonts } from '../render'
import { slotForLiteral } from '../palette'
import { populateFontSelect } from '../fonts'
import { t } from '../i18n'
import { buildColorControl, buildPaletteSwatchRow } from './colorpicker'

/** Whose defaults the form edits: one slide type, or the deck fallback. */
export type StyleTarget = { kind: 'layout'; id: string } | { kind: 'deck' }

/** A style record inside `StyleDefaults`: a group, or one shape kind's own. */
type Group = 'shape' | 'line' | 'text' | `shapes.${StyleShapeKind}`
type Rec = Record<string, unknown> & { themeRefs?: Record<string, string> }

const KIND_LABEL: Record<StyleShapeKind, string> = {
  rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', arrow: 'Arrow', path: 'Polygon',
}

/** The object holding `styleDefaults` for `target`, fresh from `doc`. */
function ownerOf(doc: SlidomingoDoc, target: StyleTarget): { styleDefaults?: StyleDefaults } | undefined {
  return target.kind === 'deck' ? doc.theme : doc.layouts?.find((l) => l.id === target.id)
}

/** The surface resolution runs against. The deck target is a slide with no
 *  slide type on the theme background — exactly "a slide without a type". */
function surfaceOf(doc: SlidomingoDoc, target: StyleTarget): Slide | undefined {
  if (target.kind === 'layout') return doc.layouts?.find((l) => l.id === target.id)
  return { id: '', background: doc.theme.background, transition: 'none', elements: [], notes: '' }
}

function recordOf(sd: StyleDefaults | undefined, group: Group): Rec | undefined {
  if (!sd) return undefined
  if (group.startsWith('shapes.')) return sd.shapes?.[group.slice(7) as StyleShapeKind] as Rec | undefined
  return sd[group as 'shape' | 'line' | 'text'] as Rec | undefined
}

function ensureRecord(owner: { styleDefaults?: StyleDefaults }, group: Group): Rec {
  const sd = (owner.styleDefaults ??= {})
  if (group.startsWith('shapes.')) return ((sd.shapes ??= {})[group.slice(7) as StyleShapeKind] ??= {}) as Rec
  return (sd[group as 'shape' | 'line' | 'text'] ??= {}) as Rec
}

/** Drop what no longer says anything, so a cleared level leaves no trace in
 *  the file. A per-kind record is kept even when empty: it IS the sub-card,
 *  and only its own Reset removes it. */
function tidy(owner: { styleDefaults?: StyleDefaults }): void {
  const sd = owner.styleDefaults
  if (!sd) return
  const prune = (rec: Rec | undefined) => {
    if (rec?.themeRefs && !Object.keys(rec.themeRefs).length) delete rec.themeRefs
  }
  for (const g of ['shape', 'line', 'text'] as const) {
    prune(sd[g] as Rec | undefined)
    if (sd[g] && !Object.keys(sd[g]!).length) delete sd[g]
  }
  for (const k of STYLE_SHAPE_KINDS) prune(sd.shapes?.[k] as Rec | undefined)
  if (sd.shapes && !Object.keys(sd.shapes).length) delete sd.shapes
  if (!Object.keys(sd).length) delete owner.styleDefaults
}

/**
 * Render the form into `host`. The caller supplies the heading (a panel
 * accordion section, or a Document-properties title) and re-renders on doc
 * changes, as both hosts already do.
 */
export function renderStyleDefaultsForm(host: HTMLElement, store: Store, target: StyleTarget): void {
  const doc = store.doc
  const surface = surfaceOf(doc, target)
  if (!surface) return
  const sd = ownerOf(doc, target)?.styleDefaults

  // one undo step per commit — the same checkpoint/touch/recordAction burst
  // every panel edit uses (panels.ts PropsPanel.edit, renderThemeSwatches)
  const edit = (mutate: (owner: { styleDefaults?: StyleDefaults }) => void) => {
    const owner = ownerOf(store.doc, target)
    if (!owner) return
    store.checkpoint()
    mutate(owner)
    tidy(owner)
    store.recordAction()
    store.touch()
  }
  /** Write ONE field at this level. `ref` undefined keeps the field's ref,
   *  null clears it. `undefined` as the value clears the field. */
  const setField = (group: Group, field: string, value: unknown, ref?: string | null) => edit((owner) => {
    const rec = ensureRecord(owner, group)
    if (value === undefined) {
      delete rec[field]
      if (rec.themeRefs) delete rec.themeRefs[field]
      return
    }
    rec[field] = value
    if (ref === null && rec.themeRefs) delete rec.themeRefs[field]
    else if (ref) (rec.themeRefs ??= {})[field] = ref
  })

  const wrap = document.createElement('div')
  wrap.className = 'ed-sd'
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.textContent = target.kind === 'deck'
    ? t('What new shapes, lines and text look like on slides without a slide type. Slide types can override each field.')
    : t('What new shapes, lines and text look like on slides of this type. Every field is inherited until you change it.')
  wrap.appendChild(hint)

  // --- shared bits -----------------------------------------------------------

  const sourceText = (src: StyleSource): { text: string; own: boolean } => {
    const here = src.kind === 'here' || (target.kind === 'deck' && src.kind === 'deck')
    if (here) return src.generic ? { text: t('From: Shapes'), own: false } : { text: t('Set here'), own: true }
    if (src.kind === 'type') return { text: t('From: {name}', { name: src.layout.name || t('Untitled') }), own: false }
    if (src.kind === 'deck') return { text: t('Deck default'), own: false }
    if (src.kind === 'personal') return { text: t('Your default'), own: false }
    return { text: t('Built-in'), own: false }
  }

  const card = (title: string, group: Group, onReset: (() => void) | null, resetTitle: string) => {
    const box = document.createElement('div')
    box.className = 'ed-sd-card'
    box.dataset.group = group
    const head = document.createElement('div')
    head.className = 'ed-sd-head'
    const h = document.createElement('span')
    h.className = 'ed-sd-title'
    h.textContent = title
    head.appendChild(h)
    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'ed-btn ed-sd-reset'
    reset.textContent = t('Reset')
    reset.title = resetTitle
    reset.disabled = !onReset
    if (onReset) reset.addEventListener('click', onReset)
    head.appendChild(reset)
    box.appendChild(head)
    wrap.appendChild(box)
    return box
  }

  const row = (box: HTMLElement, label: string, control: HTMLElement, group: Group, field: string, src: StyleSource) => {
    const r = document.createElement('div')
    r.className = 'ed-row ed-sd-row'
    r.dataset.field = field
    const lab = document.createElement('span')
    lab.className = 'ed-sd-label'
    const name = document.createElement('span')
    name.textContent = t(label)
    lab.appendChild(name)
    const s = sourceText(src)
    const from = document.createElement(s.own ? 'button' : 'small')
    from.className = 'ed-sd-from' + (s.own ? ' is-own' : '')
    from.textContent = s.text
    if (s.own) {
      ;(from as HTMLButtonElement).type = 'button'
      from.title = t('Clear this field — it inherits again')
      from.addEventListener('click', () => setField(group, field, undefined))
    }
    lab.appendChild(from)
    r.append(lab, control)
    box.appendChild(r)
  }

  const colorControl = (group: Group, field: string, value: string, ref: string | undefined) =>
    buildColorControl({
      value,
      alpha: true,
      // commit only (see file header); a hand-picked brand colour links itself
      onChange: (v, final) => { if (final) setField(group, field, v, slotForLiteral(store.doc, v) ?? null) },
      buildPaletteSwatches: (input) => buildPaletteSwatchRow(store.doc, ref, input, (base, slot) => setField(group, field, base, slot)),
    })

  const numberControl = (value: number, step: number, onCommit: (v: number) => void) => {
    const input = document.createElement('input')
    input.type = 'number'
    input.step = String(step)
    input.value = String(value)
    input.addEventListener('change', () => {
      const v = parseFloat(input.value)
      if (!Number.isNaN(v)) onCommit(v)
    })
    return input
  }

  const selectControl = (pairs: Array<[string, string]>, value: string, onChange: (v: string) => void) => {
    const sel = document.createElement('select')
    for (const [v, label] of pairs) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = label
      if (v === value) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => onChange(sel.value))
    return sel
  }
  const words = (...vs: string[]): Array<[string, string]> => vs.map((v) => [v, t(v)])

  /** A scaled-down strip of the slide background with `els` on it. */
  const preview = (box: HTMLElement, els: Parameters<typeof renderElement>[0][]) => {
    const pv = document.createElement('div')
    pv.className = 'ed-sd-preview'
    // the deck's own `background` shorthand: the same colour rule renderSlide
    // applies, so a `url(…)` in an opened file never fetches from here either
    pv.style.background = cssColor(surface.background, '', 200)
    const inner = document.createElement('div')
    inner.className = 'ed-sd-preview-inner'
    const fonts = resolveSlideFonts(store.doc, surface)
    for (const el of els) inner.appendChild(renderElement(el, store.doc, { fonts }))
    pv.appendChild(inner)
    box.appendChild(pv)
    // fit the 500-px-wide model strip to whatever width the card has
    const fit = () => { if (pv.clientWidth) inner.style.transform = `scale(${pv.clientWidth / 500})` }
    new ResizeObserver(fit).observe(pv)
  }

  // --- Shapes (generic) and per-kind sub-cards ---------------------------------

  const shapeRows = (box: HTMLElement, group: Group, kind: StyleKind) => {
    const r = resolveStyleDefaults(store.doc, surface, kind)
    const v = r.values as ShapeStyle
    row(box, 'Fill', colorControl(group, 'fill', v.fill ?? '', r.refs.fill), group, 'fill', r.sourceOf('fill'))
    row(box, 'Stroke', colorControl(group, 'stroke', v.stroke ?? '', r.refs.stroke), group, 'stroke', r.sourceOf('stroke'))
    row(box, 'Stroke width', numberControl(v.strokeWidth ?? 0, 0.5, (n) => setField(group, 'strokeWidth', Math.max(n, 0))),
      group, 'strokeWidth', r.sourceOf('strokeWidth'))
    row(box, 'Line style', selectControl(words('solid', 'dashed', 'dotted'), v.strokeStyle ?? 'solid',
      (s) => setField(group, 'strokeStyle', s)), group, 'strokeStyle', r.sourceOf('strokeStyle'))
    if (kind === 'shape' || kind === 'shape:rect') {
      row(box, 'Corner radius', numberControl(v.radius ?? 0, 1, (n) => setField(group, 'radius', Math.max(n, 0))),
        group, 'radius', r.sourceOf('radius'))
    }
    row(box, 'Opacity %', numberControl(Math.round((v.opacity ?? 1) * 100), 1,
      (n) => setField(group, 'opacity', Math.min(Math.max(n / 100, 0), 1))), group, 'opacity', r.sourceOf('opacity'))
    const shadow = v.shadow && isVisibleColor(v.shadow.color) ? v.shadow : undefined
    const preset = shadow
      ? Object.entries(SHADOW_PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(shadow))?.[0] ?? 'custom'
      : 'none'
    row(box, 'Shadow', selectControl(
      [...(preset === 'custom' ? [['custom', t('custom')] as [string, string]] : []), ...words('none', ...Object.keys(SHADOW_PRESETS))],
      preset,
      (s) => {
        if (s === 'custom') return
        if (s !== 'none') { setField(group, 'shadow', { ...SHADOW_PRESETS[s] }); return }
        // "none" over an inherited shadow needs a value that says so; an
        // invisible shadow is that value (shapeDefaultsFor skips it)
        edit((owner) => {
          const rec = ensureRecord(owner, group)
          delete rec.shadow
          const inherited = resolveStyleDefaults(store.doc, surfaceOf(store.doc, target)!, kind).values as ShapeStyle
          if (inherited.shadow && isVisibleColor(inherited.shadow.color)) rec.shadow = { blur: 0, color: 'transparent' } satisfies ShadowSpec
        })
      }), group, 'shadow', r.sourceOf('shadow'))
  }

  const shapePreviewEls = (kind: StyleShapeKind | null) => {
    const frame = (x: number) => ({ x, y: 22, w: 200, h: 96 })
    const make = (k: StyleShapeKind, x: number) => {
      const look = kind === null
        ? shapeDefaultsForGeneric(store.doc, surface)
        : shapeDefaultsFor(store.doc, surface, k)
      const extra = k === 'path'
        ? { d: 'M 100 0 L 200 38 L 162 96 L 38 96 L 0 38 Z', pathBox: [0, 0, 200, 96] as [number, number, number, number] }
        : {}
      return defaultShape(k, { ...look, ...frame(x), ...extra, ...(k === 'rect' ? {} : { radius: 0 }) })
    }
    return kind === null ? [make('rect', 30), make('ellipse', 270)] : [make(kind, 150)]
  }

  const genericOwn = recordOf(sd, 'shape')
  const shapesBox = card(t('Shapes'), 'shape',
    genericOwn ? () => edit((owner) => { if (owner.styleDefaults) delete owner.styleDefaults.shape }) : null,
    t('Clear this level’s shape defaults — they inherit again'))
  preview(shapesBox, shapePreviewEls(null))
  shapeRows(shapesBox, 'shape', 'shape')

  for (const k of STYLE_SHAPE_KINDS) {
    if (!sd?.shapes?.[k]) continue
    const group: Group = `shapes.${k}`
    const box = card(t(KIND_LABEL[k]), group,
      () => edit((owner) => { if (owner.styleDefaults?.shapes) delete owner.styleDefaults.shapes[k] }),
      t('Remove this shape’s own look — it uses Shapes again'))
    box.classList.add('ed-sd-sub')
    preview(box, shapePreviewEls(k))
    shapeRows(box, group, `shape:${k}`)
  }

  const missing = STYLE_SHAPE_KINDS.filter((k) => !sd?.shapes?.[k])
  if (missing.length) {
    const add = selectControl(
      [['', t('＋ Different look for…')], ...missing.map((k) => [k, t(KIND_LABEL[k])] as [string, string])],
      '',
      (k) => { if (k) edit((owner) => { ensureRecord(owner, `shapes.${k as StyleShapeKind}`) }) },
    )
    add.classList.add('ed-sd-addkind')
    add.title = t('Give one kind of shape its own look on this slide type')
    wrap.appendChild(add)
  }

  // --- Lines ---------------------------------------------------------------------

  {
    const group: Group = 'line'
    const r = resolveStyleDefaults(store.doc, surface, 'line')
    const v = r.values
    const box = card(t('Lines'), group,
      recordOf(sd, group) ? () => edit((owner) => { if (owner.styleDefaults) delete owner.styleDefaults.line }) : null,
      t('Clear this level’s line defaults — they inherit again'))
    preview(box, [defaultShape('line', { ...lineDefaultsFor(store.doc, surface, 'line'), x: 40, y: 60, w: 420, h: 20 })])
    const ends: LineEnding[] = ['none', 'arrow', 'dot', 'bar']
    row(box, 'Line color', colorControl(group, 'color', v.color ?? '', r.refs.color), group, 'color', r.sourceOf('color'))
    row(box, 'Width', numberControl(v.width ?? 0, 0.5, (n) => setField(group, 'width', Math.max(n, 0))), group, 'width', r.sourceOf('width'))
    row(box, 'Line style', selectControl(words('solid', 'dashed', 'dotted'), v.strokeStyle ?? 'solid',
      (s) => setField(group, 'strokeStyle', s)), group, 'strokeStyle', r.sourceOf('strokeStyle'))
    row(box, 'Cap style', selectControl(words('round', 'square', 'butt'), v.strokeCap ?? 'round',
      (s) => setField(group, 'strokeCap', s)), group, 'strokeCap', r.sourceOf('strokeCap'))
    row(box, 'Start tip', selectControl(words(...ends), v.lineStart ?? 'none',
      (s) => setField(group, 'lineStart', s)), group, 'lineStart', r.sourceOf('lineStart'))
    row(box, 'End tip', selectControl(words(...ends), v.lineEnd ?? 'none',
      (s) => setField(group, 'lineEnd', s)), group, 'lineEnd', r.sourceOf('lineEnd'))
  }

  // --- Text ----------------------------------------------------------------------

  {
    const group: Group = 'text'
    const r = resolveStyleDefaults(store.doc, surface, 'text')
    const v = r.values
    const box = card(t('Text'), group,
      recordOf(sd, group) ? () => edit((owner) => { if (owner.styleDefaults) delete owner.styleDefaults.text }) : null,
      t('Clear this level’s text defaults — they inherit again'))
    preview(box, [defaultText({
      ...textDefaultsFor(store.doc, surface), html: t('Sample text'), x: 20, y: 10, w: 460, h: 120, valign: 'middle',
    })])
    const font = document.createElement('select')
    populateFontSelect(font, store.doc, v.fontFamily ?? '', t('Slide type font'))
    font.addEventListener('change', () => setField(group, 'fontFamily', font.value))
    row(box, 'Font', font, group, 'fontFamily', r.sourceOf('fontFamily'))
    // points, like the text panel: the model stores slide px (1pt = 4/3 px)
    row(box, 'Size (pt)', numberControl(Math.round((v.fontSize ?? 32) * 0.75 * 10) / 10, 1,
      (n) => setField(group, 'fontSize', Math.round(Math.max(n, 3) * (4 / 3) * 100) / 100)), group, 'fontSize', r.sourceOf('fontSize'))
    const WEIGHTS: Array<[string, string]> = [
      [100, 'Thin'], [200, 'Extra light'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'],
      [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black'],
    ].map(([n, w]) => [String(n), t(w as string)])
    const weight = String(v.fontWeight ?? 400)
    if (!WEIGHTS.some(([n]) => n === weight)) WEIGHTS.unshift([weight, t('Custom ({n})', { n: weight })])
    row(box, 'Weight', selectControl(WEIGHTS, weight, (s) => setField(group, 'fontWeight', parseInt(s))),
      group, 'fontWeight', r.sourceOf('fontWeight'))
    row(box, 'Color', colorControl(group, 'color', v.color ?? '', r.refs.color), group, 'color', r.sourceOf('color'))
    row(box, 'Line height', numberControl(v.lineHeight ?? 1.25, 0.05, (n) => setField(group, 'lineHeight', Math.max(n, 0.5))),
      group, 'lineHeight', r.sourceOf('lineHeight'))
    row(box, 'Align', selectControl(words('left', 'center', 'right'), v.align ?? 'center',
      (s) => setField(group, 'align', s)), group, 'align', r.sourceOf('align'))
  }

  host.appendChild(wrap)
}

/** The generic Shapes card's preview look: `resolveStyleDefaults(…,'shape')`
 *  as element fields (shapeDefaultsFor always folds a kind's override in). */
function shapeDefaultsForGeneric(doc: SlidomingoDoc, surface: Slide) {
  const r = resolveStyleDefaults(doc, surface, 'shape')
  const v = r.values
  return {
    fill: v.fill, stroke: v.stroke, strokeWidth: v.strokeWidth, radius: v.radius, opacity: v.opacity,
    ...(v.strokeStyle && v.strokeStyle !== 'solid' ? { strokeStyle: v.strokeStyle } : {}),
    ...(v.shadow && isVisibleColor(v.shadow.color) ? { shadow: v.shadow } : {}),
  }
}
