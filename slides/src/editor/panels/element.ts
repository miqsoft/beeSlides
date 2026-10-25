// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The sections every element panel shares (Effects, Presenting with Morph,
// Advanced, History, Alt text, Source & license) and a multi-selection's
// common formatting.

import { addLinkedState } from '../decksettings'
import { LOOP_DEFAULTS, SHADOW_PRESETS, REFLECTION_PRESETS, resyncOwner, morphKey, type ReflectionSpec, type ChartElement, type ImageElement, type MediaElement, type ShapeElement, type SvgElement, type LoopOrigin, type SlideElement, type TextElement, type CodeElement, type FooterRole } from '../../model'
import { summarizeChange } from '../../actionlog'
import { relTime } from '../comments'
import { buildPlan, enterStepOf } from '../../builds'
import { populateFontSelect } from '../../fonts'
import { requestSystemFonts } from '../../localfonts'
import { ICONS } from '../../icons'
import { t, tc } from '../../i18n'
import { LIMITS } from '../../untrusted'
import { ElementEdits } from '../elementactions'
import type { MathElement } from '../../model'
import type { PanelContext } from './context'
import { buildChartJson } from './charts'

/**
 * Sentinel <option> value for "clear the morph override". Safe against
 * collision with a real morph key by construction: setMorphId strips anything
 * outside [A-Za-z0-9._-], so no stored morphId can ever contain '#'.
 */
const UNPAIR = '#unpair'

/** Panel cap on stacked shadow layers (the validator allows 16; six is already a lot of blur). */
const SHADOW_LAYERS_UI_MAX = 6

/**
 * Group formatting for a multi-selection (a group is one too): the
 * properties the selected objects have in common, each edit applied to all
 * of them at once (ElementEdits takes several ids = one undo step). A value
 * that differs between them shows as "Mixed" until it is set.
 */
export function buildMultiStyle(ctx: PanelContext, els: SlideElement[]) {
  const ids = (xs: SlideElement[]) => xs.map((e) => e.id)
  const same = <T>(vals: T[]): T | undefined => (vals.length && vals.every((v) => v === vals[0]) ? vals[0] : undefined)
  // "Mixed" lives IN the control (a striped swatch, a placeholder, a first
  // option) — a separate tag pushed the control onto its own line
  const mixed = (row: HTMLElement, on: boolean) => {
    if (!on) return
    row.classList.add('ed-row-mixed')
    row.title = t('The selected objects differ here — a new value sets it on all of them')
    const label = row.querySelector<HTMLElement>('.ed-color-trigger-label')
    if (label) label.textContent = t('Mixed')
    const opt = row.querySelector<HTMLOptionElement>('option[value="mixed"]')
    if (opt) opt.textContent = t('Mixed')
  }
  const subset = (n: number) => {
    if (n === els.length) return
    const hint = document.createElement('div')
    hint.className = 'ed-subset-hint'
    hint.textContent = t('Applies to {n} of the {total} selected', { n, total: els.length })
    ctx.host.appendChild(hint)
  }
  const numberMixed = (value: number | undefined, step: number, onEdit: (v: number) => void) => {
    const input = ctx.number(value ?? 0, step, (v) => onEdit(v)) as HTMLInputElement
    if (value === undefined) { input.value = ''; input.placeholder = t('Mixed') }
    return input
  }

  // --- fill & border -------------------------------------------------------
  const shapes = els.filter((e): e is ShapeElement => e.type === 'shape')
  const boxes = shapes.filter((e) => e.shape !== 'line')
  if (shapes.length) {
    ctx.section('multi:Fill & stroke', { label: t('Fill & stroke') })
    subset(shapes.length)
    if (boxes.length) {
      const fill = same(boxes.map((e) => (e.fillGradient ? 'gradient' : e.fill)))
      const row = ctx.row('Fill', ctx.colorAlpha(fill && fill !== 'gradient' ? fill : boxes[0].fill, (v, fin) =>
        // a solid pick replaces a gradient — that is what "make them all blue" means
        ctx.edits.mutate(ids(boxes), (e) => { if (e.type === 'shape') { delete e.fillGradient; e.fill = v } }, fin),
      boxes.map((e) => ({ id: e.id, path: 'fill' }))))
      mixed(row, fill === undefined || fill === 'gradient')
    }
    const stroke = same(shapes.map((e) => ctx.edits.strokeOf(e)))
    mixed(ctx.row('Stroke', ctx.colorAlpha(stroke ?? ctx.edits.strokeOf(shapes[0]), (v, fin) =>
      ctx.edits.setStroke(ids(shapes), v, fin), shapes.map((e) => ({ id: e.id, path: ElementEdits.strokePath(e) })))), stroke === undefined)
    const width = same(shapes.map((e) => e.strokeWidth))
    mixed(ctx.row('Stroke width', numberMixed(width, 0.5, (v) => ctx.edits.setStrokeWidth(ids(shapes), v))), width === undefined)
    const style = same(shapes.map((e) => e.strokeStyle ?? (e.strokeDash ? 'dashed' : 'solid')))
    const styleSel = ctx.select([...(style ? [] : ['mixed']), 'solid', 'dashed', 'dotted'], style ?? 'mixed', (v) => {
      if (v !== 'mixed') ctx.edits.setStrokeStyle(ids(shapes), v as 'solid' | 'dashed' | 'dotted')
    })
    mixed(ctx.row('Line style', styleSel), style === undefined)
  }

  // --- text ----------------------------------------------------------------
  const texts = els.filter((e): e is TextElement => e.type === 'text')
  const sized = els.filter((e) => e.type === 'text' || e.type === 'code' || e.type === 'math') as Array<TextElement | CodeElement | MathElement>
  if (sized.length) {
    ctx.section('multi:Text', { label: t('Text') })
    subset(sized.length)
    if (texts.length) {
      requestSystemFonts()
      const fam = same(texts.map((e) => e.fontFamily ?? ''))
      const sel = document.createElement('select')
      populateFontSelect(sel, ctx.store.doc, fam ?? '', 'theme default')
      if (fam === undefined) {
        const o = document.createElement('option')
        o.value = '\u0000mixed'
        o.textContent = t('Mixed')
        o.selected = true
        sel.prepend(o)
      }
      sel.addEventListener('change', () => { if (sel.value !== '\u0000mixed') ctx.edits.setFontFamily(ids(texts), sel.value) })
      mixed(ctx.row('Font', sel), fam === undefined)
    }
    const pt = same(sized.map((e) => ElementEdits.fontSizePt(e)))
    mixed(ctx.row('Size (pt)', numberMixed(pt, 1, (v) => ctx.edits.setFontSizePt(ids(sized), v))), pt === undefined)
    const inked = sized.filter((e): e is TextElement | MathElement => e.type === 'text' || e.type === 'math')
    if (inked.length) {
      const color = same(inked.map((e) => (e.type === 'text' && e.colorGradient ? 'gradient' : e.color)))
      mixed(ctx.row('Color', ctx.color(color && color !== 'gradient' ? color : inked[0].color, (v, fin) =>
        ctx.edits.mutate(ids(inked), (e) => {
          if (e.type === 'text') { delete e.colorGradient; e.color = v } else if (e.type === 'math') e.color = v
        }, fin),
      inked.map((e) => ({ id: e.id, path: 'color' })))), color === undefined || color === 'gradient')
    }
    const align = same(sized.map((e) => e.align))
    const seg = ctx.segButtons(
      [['left', t('Align left'), ICONS.textLeft], ['center', t('Center'), ICONS.textCenter], ['right', t('Align right'), ICONS.textRight]],
      align ?? '',
      (v) => ctx.edits.setTextAlign(ids(sized), v as 'left' | 'center' | 'right'),
    )
    if (texts.length) {
      const bold = document.createElement('button')
      bold.type = 'button'
      const allBold = texts.every((e) => ElementEdits.isBold(e))
      bold.className = 'ed-btn ed-seg-btn' + (allBold ? ' ed-btn-armed' : '')
      bold.innerHTML = ICONS.bold
      bold.title = t('Bold')
      bold.setAttribute('aria-label', t('Bold'))
      bold.setAttribute('aria-pressed', String(allBold))
      bold.addEventListener('click', () => ctx.edits.toggleBold(ids(texts)))
      seg.prepend(bold)
    }
    mixed(ctx.row('Alignment', seg), align === undefined)
  }

  // --- effects -------------------------------------------------------------
  ctx.section('multi:Effects', { label: t('Effects') })
  const shadowKey = (e: SlideElement) => Object.entries(SHADOW_PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(e.shadow))?.[0]
    ?? (e.shadow ? 'custom' : 'none')
  const shadow = same(els.map(shadowKey))
  const shadowSel = ctx.select(
    [...(shadow === undefined ? ['mixed'] : shadow === 'custom' ? ['custom'] : []), 'none', ...Object.keys(SHADOW_PRESETS)],
    shadow ?? 'mixed',
    (v) => {
      if (v === 'mixed' || v === 'custom') return
      ctx.edits.mutate(ids(els), (e) => { if (v === 'none') delete e.shadow; else e.shadow = { ...SHADOW_PRESETS[v] } }, true)
    })
  mixed(ctx.row('Shadow', shadowSel), shadow === undefined)
  const opacity = same(els.map((e) => Math.round((e.opacity ?? 1) * 100)))
  mixed(ctx.row('Opacity (%)', numberMixed(opacity, 5, (v) => ctx.edits.setOpacity(ids(els), v / 100))), opacity === undefined)
}

/** Shadow, blur, opacity — how the element is drawn, beyond its own fill. */
export function buildEffectsProps(ctx: PanelContext, el: SlideElement) {
  ctx.section('Effects', { modified: !!(el.shadow || el.reflection || el.blur || el.opacity < 1) })
  const current = Object.entries(SHADOW_PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(el.shadow))?.[0]
    ?? (el.shadow ? 'custom' : 'none')
  ctx.row('Shadow', ctx.select(
    [...(current === 'custom' ? ['custom'] : []), 'none', ...Object.keys(SHADOW_PRESETS)],
    current,
    (v) => ctx.mutate(el.id, (e) => {
      if (v === 'none') delete e.shadow
      else if (v !== 'custom') e.shadow = { ...SHADOW_PRESETS[v] }
    }, true)))
  // Always show the concrete values (per layer when stacked) — editing any
  // of them turns a preset into 'custom' on the next rebuild, which is fine.
  const shadows = Array.isArray(el.shadow) ? el.shadow : el.shadow ? [el.shadow] : []
  const setShadow = (i: number, patch: Record<string, unknown>, fin = true) =>
    ctx.mutate(el.id, (e) => {
      const arr = Array.isArray(e.shadow) ? [...e.shadow] : e.shadow ? [e.shadow] : []
      arr[i] = { ...arr[i], ...patch }
      e.shadow = Array.isArray(e.shadow) ? arr : arr[0]
    }, fin)
  const removeShadow = (i: number) =>
    ctx.mutate(el.id, (e) => {
      const arr = (Array.isArray(e.shadow) ? [...e.shadow] : e.shadow ? [e.shadow] : []).filter((_, j) => j !== i)
      if (!arr.length) delete e.shadow
      else e.shadow = arr.length === 1 ? arr[0] : arr
    }, true)
  shadows.forEach((sh, i) => {
    if (shadows.length > 1) {
      const cap = document.createElement('div')
      cap.className = 'ed-shadow-cap'
      const name = document.createElement('span')
      name.textContent = t('Layer {n}', { n: i + 1 })
      const del = document.createElement('button')
      del.className = 'ed-btn ed-btn-icon'
      del.textContent = '✕'
      del.title = t('Remove shadow layer')
      del.addEventListener('click', () => removeShadow(i))
      cap.append(name, del)
      ctx.host.appendChild(cap)
    }
    const grid = document.createElement('div')
    grid.className = 'ed-grid2'
    grid.append(
      ctx.mini(t('X'), sh.x ?? 0, (v) => setShadow(i, { x: v })),
      ctx.mini(t('Y'), sh.y ?? 0, (v) => setShadow(i, { y: v })),
      ctx.mini(t('Blur'), sh.blur, (v) => setShadow(i, { blur: Math.max(v, 0) })),
    )
    ctx.host.appendChild(grid)
    ctx.row('Color', ctx.colorAlpha(sh.color, (v, fin) => setShadow(i, { color: v }, fin)))
  })
  if (shadows.length && shadows.length < SHADOW_LAYERS_UI_MAX) {
    // Stacking (e.g. a glow over a drop shadow) used to be JSON/AI-only.
    const addLayer = document.createElement('button')
    addLayer.className = 'ed-btn ed-btn-block'
    addLayer.textContent = t('＋ Add shadow layer')
    addLayer.title = t('Stack another shadow on top — e.g. a glow over a drop shadow')
    addLayer.addEventListener('click', () =>
      ctx.mutate(el.id, (e) => {
        const arr = Array.isArray(e.shadow) ? [...e.shadow] : e.shadow ? [e.shadow] : []
        e.shadow = [...arr, { ...SHADOW_PRESETS.glow }]
      }, true))
    ctx.host.appendChild(addLayer)
  }

  buildReflectionProps(ctx, el)

  // Blur ON the element (0 clears) and opacity. The backdrop blur BEHIND
  // it and the blend mode are rarer — they live in Advanced.
  const fxGrid = document.createElement('div')
  fxGrid.className = 'ed-grid2'
  fxGrid.append(
    ctx.mini(t('Blur'), el.blur ?? 0, (v) => ctx.mutate(el.id, (e) => {
      if (v > 0) e.blur = v
      else delete e.blur
    }, true)),
    ctx.mini(t('Opacity'), Math.round(el.opacity * 100), (v) =>
      ctx.setNum(el.id, 'opacity', Math.min(Math.max(v / 100, 0), 1))),
  )
  ctx.host.appendChild(fxGrid)
}

/** Mirror reflection below the element: a preset, then the concrete values
 *  (editing any of them turns the preset into 'custom' on the next rebuild). */
function buildReflectionProps(ctx: PanelContext, el: SlideElement) {
  const r = el.reflection
  const current = !r ? 'none'
    : Object.entries(REFLECTION_PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(r))?.[0] ?? 'custom'
  ctx.row('Reflection', ctx.select(
    [...(current === 'custom' ? ['custom'] : []), 'none', ...Object.keys(REFLECTION_PRESETS)],
    current,
    (v) => ctx.mutate(el.id, (e) => {
      if (v === 'none') delete e.reflection
      else if (v !== 'custom') e.reflection = { ...REFLECTION_PRESETS[v] }
    }, true)))
  if (!r) return
  const setReflection = (patch: Partial<ReflectionSpec>) =>
    ctx.mutate(el.id, (e) => { e.reflection = { ...e.reflection, ...patch } }, true)
  const clamp01 = (v: number) => Math.min(Math.max(Number.isNaN(v) ? 0 : v, 0), 100) / 100
  const grid = document.createElement('div')
  grid.className = 'ed-grid2'
  grid.append(
    ctx.mini(t('Opacity'), Math.round((r.opacity ?? 0.35) * 100), (v) => setReflection({ opacity: clamp01(v) })),
    ctx.mini(t('Length'), Math.round((r.size ?? 0.5) * 100), (v) => setReflection({ size: clamp01(v) })),
    ctx.mini(t('Gap'), r.gap ?? 0, (v) => setReflection({ gap: Number.isNaN(v) ? 0 : v })),
  )
  ctx.host.appendChild(grid)
}

/**
 * Role, blend, backdrop — real features, but ones you reach for on purpose,
 * so they stop costing the space Fill gets. A chart's raw-JSON escape hatch
 * lives here too.
 */
export function buildAdvancedProps(ctx: PanelContext, el: SlideElement) {
  const footerRole = el.type === 'text' ? el.footerRole : undefined
  ctx.section('Advanced', { modified: !!(el.role || footerRole || el.blend || el.backdropFilter) })
  ctx.row('Role', ctx.select(
    ['none', 'title', 'subtitle', 'body', 'kicker', 'media'],
    el.role ?? 'none',
    (v) => ctx.mutate(el.id, (e) => {
      if (v === 'none') delete e.role
      else e.role = v
    }, true)))
  if (el.type === 'text') {
    ctx.row('Footer item', ctx.labeledSelect(
      [['', t('No')], ['date', t('Date')], ['slideNumber', t('Slide number')], ['footer', t('Footer')]],
      footerRole ?? '',
      (v) => ctx.mutate(el.id, (e) => {
        const tx = e as TextElement
        if (v) tx.footerRole = v as FooterRole
        else delete tx.footerRole
      }, true)))
  }
  ctx.row('Blend', ctx.select(
    ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion'],
    el.blend || 'normal',
    (v) => ctx.mutate(el.id, (e) => {
      if (v === 'normal') delete e.blend
      else e.blend = v
    }, true)))
  const grid = document.createElement('div')
  grid.className = 'ed-grid2'
  grid.append(
    ctx.mini(t('Backdrop'), el.backdropFilter ?? 0, (v) => ctx.mutate(el.id, (e) => {
      if (v > 0) e.backdropFilter = v
      else delete e.backdropFilter
    }, true)),
  )
  ctx.host.appendChild(grid)
  if (el.type === 'chart') buildChartJson(ctx, el)
}

/**
 * Per-element change history: the last ~10 recorded ElementChanges for
 * this element (actionlog.ts), newest first — a short summarizeChange()
 * label + relative time, and a ↺ button that reverts just that change
 * (store.revertChange). A row's button greys out once store.canRevert()
 * says the entry is stale — either something newer superseded it, or an
 * earlier row in this same list was already reverted (which itself is a
 * new commit, so the panel rebuilds and re-checks every row fresh).
 */
export function buildHistoryProps(ctx: PanelContext, el: SlideElement) {
  const entries = ctx.store.actionLog.changesFor(ctx.store.slide.id, el.id)
  if (!entries.length) return
  ctx.section('History')
  for (const { change, at } of entries) {
    const row = document.createElement('div')
    row.className = 'ed-history-row'
    const label = document.createElement('span')
    label.className = 'ed-history-label'
    label.textContent = summarizeChange(change)
    const time = document.createElement('span')
    time.className = 'ed-history-time'
    time.textContent = relTime(at)
    const revertBtn = ctx.opBtn(ICONS.undo, t('Revert this change'), () => ctx.panel.revertChange(change))
    if (!ctx.store.canRevert(change)) (revertBtn as HTMLButtonElement).disabled = true
    row.append(label, time, revertBtn)
    ctx.host.appendChild(row)
  }
}

/**
 * Morph rows, at the end of the Presenting section (they used to be their
 * own always-open section). The morph key is `morphId ?? id`: by default an element
 * morphs with same-id elements on adjacent slides (the duplicate-a-slide
 * idiom), but setting a `morphId` re-targets the pairing WITHOUT mutating
 * `id` (which stays the stable identity used by selection, connectors,
 * comments and the CRDT). The text field edits the key directly; the picker
 * adopts another slide element's key. Writing the element's own id clears
 * the override.
 */
function buildMorphProps(ctx: PanelContext, el: SlideElement) {
  ctx.subhead(t('Morph'))
  const effective = morphKey(el)

  const warn = document.createElement('p')
  warn.className = 'ed-hint ed-morph-warn'
  warn.style.display = 'none'

  const input = document.createElement('input')
  input.type = 'text'
  input.value = effective
  input.spellcheck = false
  input.addEventListener('change', () => {
    const err = setMorphId(ctx, el, input.value)
    if (err) { warn.textContent = err; warn.style.display = ''; input.value = effective }
  })
  ctx.row('Morph id', input)

  const targets = morphTargets(ctx, el)
  // `|| el.morphId`: a paired element with no OTHER slide to pair with still
  // needs the picker — otherwise there is nowhere to unpair from.
  if (targets.length || el.morphId) {
    const sel = document.createElement('select')
    const none = document.createElement('option')
    none.value = ''
    none.textContent = t('(pick an element)')
    sel.appendChild(none)
    // Clearing an override had no affordance: the documented way is to retype
    // the element's own id into the field above, which means knowing what it
    // was (issue #54). Offer it as a choice instead.
    if (el.morphId) {
      const un = document.createElement('option')
      un.value = UNPAIR
      un.textContent = t('Don’t pair — use its own id')
      sel.appendChild(un)
    }
    for (const tgt of targets) {
      const o = document.createElement('option')
      o.value = tgt.key
      o.textContent = tgt.label
      if (tgt.key === effective) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => {
      if (!sel.value) return
      // writing the element's OWN id is what clears the override
      const err = setMorphId(ctx, el, sel.value === UNPAIR ? el.id : sel.value)
      if (err) { warn.textContent = err; warn.style.display = '' }
    })
    ctx.row('Pair with', sel)
  }

  ctx.host.appendChild(warn)

  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  // ids come from the document, which an opened file does not sanitize —
  // escape them before they meet innerHTML (t() interpolates verbatim)
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  hint.innerHTML = el.morphId
    ? t('Morphs as <code>{id}</code>, overriding its own id. Set it back to <code>{own}</code> to clear.', { id: esc(effective), own: esc(el.id) })
    : t('Elements sharing a morph id morph into each other across slides. Change this (or pick below) to pair with an element on another slide.')
  ctx.host.appendChild(hint)
}

/** Set or clear an element's morph-key override. Writing the element's own
 *  id clears it. Returns an inline error message, or null on success. */
function setMorphId(ctx: PanelContext, el: SlideElement, raw: string): string | null {
  const clean = raw.trim().replace(/[^A-Za-z0-9._-]/g, '')
  if (!clean) return t('Morph id can’t be empty.')
  const next = clean === el.id ? undefined : clean
  const effective = next ?? el.id
  const clash = ctx.store.slide.elements.some(
    (e) => e.id !== el.id && morphKey(e) === effective)
  if (clash) return t('Another element on this slide already uses that morph id.')
  ctx.mutate(el.id, (e) => {
    if (next === undefined) delete e.morphId
    else e.morphId = next
  }, true)
  return null
}

/** Distinct morph keys present on OTHER slides, each with a readable label,
 *  for the "Pair with" picker. Skips keys that already sit on this slide
 *  (they'd collide) and our own default key. */
function morphTargets(ctx: PanelContext, el: SlideElement): Array<{ key: string; label: string }> {
  const here = new Set(
    ctx.store.slide.elements.filter((e) => e.id !== el.id).map(morphKey))
  const seen = new Map<string, string>()
  ctx.store.doc.slides.forEach((s, i) => {
    if (s.id === ctx.store.slide.id) return
    for (const e of s.elements) {
      const key = morphKey(e)
      if (key === el.id || here.has(key) || seen.has(key)) continue
      seen.set(key, `${t('Slide')} ${i + 1} · ${morphElDesc(e)}`)
    }
  })
  return [...seen].map(([key, label]) => ({ key, label }))
}

/** Short human label for an element in the morph picker. */
export function morphElDesc(e: SlideElement): string {
  if (e.type === 'text') {
    const txt = (e as TextElement).html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    if (txt) return `"${txt.slice(0, 24)}"`
  }
  // Capitalize to hit the existing insert-menu catalog keys (Text/Image/…).
  return t(e.type.charAt(0).toUpperCase() + e.type.slice(1))
}

/** fx + link + morph pairing — how the element behaves while presenting.
 *  Keeps the 'Presenting' key, so saved open state and translations carry
 *  over from before Morph merged in. */
export function buildPresentingProps(ctx: PanelContext, el: SlideElement) {
  ctx.section('Presenting', {
    modified: !!(el.fx || el.showOnHover || el.group || el.link || el.morphId),
  })
  const setFx = (patch: Partial<NonNullable<SlideElement['fx']>>) =>
    ctx.mutate(el.id, (e) => {
      const fx: Record<string, unknown> = { ...(e.fx ?? {}), ...patch }
      for (const k of Object.keys(fx)) if (fx[k] === undefined || fx[k] === false) delete fx[k]
      if (Object.keys(fx).length) e.fx = fx as NonNullable<SlideElement['fx']>
      else delete e.fx
    }, true)

  // Click builds: WHEN this element arrives. The choices are the clicks the
  // slide already has plus "a new click", so authoring never has to know the
  // step numbers (builds.ts compresses gaps; the Builds list reorders).
  {
    const plan = buildPlan(ctx.store.slide)
    const ats = plan.steps.map((s) => s.at)
    const byPara = el.type === 'text' && !!el.fx?.byParagraph
    const cur = enterStepOf(el)
    const pairs: Array<[string, string]> = [['0', t('With slide')]]
    ats.forEach((at, i) => pairs.push([String(at), t('On click {n}', { n: i + 1 })]))
    if (cur > 0 && !ats.includes(cur)) pairs.push([String(cur), t('On click {n}', { n: ats.length + 1 })])
    pairs.push(['new', t('On a new click')])
    ctx.row('Appears', ctx.labeledSelect(pairs, String(cur), (v) => {
      const next = v === 'new' ? Math.max(0, ...ats, cur) + 1 : Number(v)
      // paragraph-built text reads "step 0" as "first paragraph with the slide",
      // so there it is stored; for everything else "with the slide" = no step
      setFx({ step: next > 0 || byPara ? next : undefined })
    }))

    // text: one paragraph per click ("bullets one by one")
    if (el.type === 'text') {
      ctx.row('Bullets one by one', ctx.toggle(byPara, (on) =>
        // an explicit "step 0" only means something to paragraph-built text
        setFx({ byParagraph: on ? true : undefined, step: !on && el.fx?.step === 0 ? undefined : el.fx?.step })))
    }

    // Disappears: the click that takes it out again (always after it arrived)
    const x = el.fx?.exitStep ?? 0
    const later = ats.filter((at) => at > cur)
    const outs: Array<[string, string]> = [['0', t('Never')]]
    later.forEach((at) => outs.push([String(at), t('On click {n}', { n: ats.indexOf(at) + 1 })]))
    if (x > 0 && !later.includes(x)) outs.push([String(x), t('On click {n}', { n: ats.length + 1 })])
    outs.push(['new', t('On a new click')])
    ctx.row('Disappears', ctx.labeledSelect(outs, String(x), (v) => {
      if (v === '0') setFx({ exitStep: undefined, exit: undefined, exitDur: undefined })
      else setFx({ exitStep: v === 'new' ? Math.max(0, ...ats, cur) + 1 : Number(v) })
    }))
    if (x > 0) {
      ctx.row('Exit', ctx.select(
        ['fade', 'fade-up', 'fade-down', 'slide-left', 'slide-right', 'slide-up', 'slide-down'],
        el.fx?.exit ?? 'fade',
        (v) => setFx({ exit: v === 'fade' ? undefined : v as NonNullable<typeof el.fx>['exit'] })))
      const exitKind = el.fx?.exit ?? 'fade'
      ctx.row('Exit secs', ctx.number(
        el.fx?.exitDur ?? (exitKind.startsWith('slide-') ? 0.5 : 0.35), 0.05,
        (v, fin) => { if (fin) setFx({ exitDur: Math.max(v, 0.05) }) }))
    }
  }

  ctx.row('Enter', ctx.select(
    ['none', 'fade', 'fade-up', 'fade-down', 'slide-left', 'slide-right', 'slide-up', 'slide-down'],
    el.fx?.enter ?? 'none',
    (v) => setFx(v === 'none'
      ? { enter: undefined, enterDur: undefined }
      : { enter: v as NonNullable<typeof el.fx>['enter'] })))
  if (el.fx?.enter) {
    // per-kind default (slide-* 0.75s, fade-* 0.55s); lower = snappier
    ctx.row('Enter secs', ctx.number(
      el.fx.enterDur ?? (el.fx.enter.startsWith('slide-') ? 0.75 : 0.55), 0.05,
      (v, fin) => { if (fin) setFx({ enterDur: Math.max(v, 0.05) }) }))
  }
  ctx.row('Count up', ctx.select(
    ['off', 'on'], el.fx?.countUp ? 'on' : 'off',
    (v) => setFx({ countUp: v === 'on' ? true : undefined })))
  ctx.row('Ambient', ctx.select(
    ['none', 'kenburns'], el.fx?.ambient ?? 'none',
    (v) => setFx(v === 'none' ? { ambient: undefined, ken: undefined } : { ambient: 'kenburns' })))
  if (el.fx?.ambient === 'kenburns') {
    const ken = el.fx.ken ?? {}
    const dir = ken.dir ?? 'drift'
    const setKen = (patch: Partial<NonNullable<NonNullable<SlideElement['fx']>['ken']>>) =>
      setFx({ ken: { ...ken, ...patch } })
    ctx.row('Zoom', ctx.select(
      ['drift', 'zoom-out', 'zoom-in'],
      dir === 'out' ? 'zoom-out' : dir === 'in' ? 'zoom-in' : 'drift',
      (v) => {
        const d = v === 'zoom-out' ? 'out' : v === 'zoom-in' ? 'in' : 'drift'
        // give each style its natural pace when switching
        setFx({ ken: d === 'drift' ? undefined : { dir: d, scale: 1.06, duration: 2.5 } })
      }))
    ctx.row('Zoom %', ctx.number(
      Math.round(((ken.scale ?? (dir === 'drift' ? 1.1 : 1.06)) - 1) * 100), 1,
      (v, fin) => { if (fin) setKen({ scale: 1 + Math.min(Math.max(v, 0), 100) / 100 }) }))
    ctx.row('Zoom secs', ctx.number(
      ken.duration ?? (dir === 'drift' ? 26 : 2.5), 0.1,
      (v, fin) => { if (fin) setKen({ duration: Math.max(v, 0.1) }) }))
  }

  // continuous loop animation
  const loop = el.fx?.loop
  ctx.row('Loop animation', ctx.select(
    ['none', 'dash-march', 'motion-path', 'pulse', 'spin', 'float', 'blink', 'wiggle'],
    loop?.type ?? 'none',
    (v) => setFx({
      loop: v === 'none' ? undefined
        : v === 'dash-march' ? { type: 'dash-march', distance: 18, duration: (loop as any)?.duration ?? 1.4 }
        : v === 'motion-path' ? { type: 'motion-path', path: (loop as any)?.path ?? 'M 0 0 L 100 0', duration: (loop as any)?.duration ?? 3 }
        // each generic loop has its own natural pace and size, so none carries over
        : { type: v as keyof typeof LOOP_DEFAULTS },
    })))
  if (loop) {
    const generic = loop.type !== 'dash-march' && loop.type !== 'motion-path' ? loop : null
    ctx.row('Loop secs', ctx.number(loop.duration ?? (generic ? LOOP_DEFAULTS[generic.type].cycle : 2), 0.1, (v, fin) =>
      ctx.mutate(el.id, (e) => { if (e.fx?.loop) e.fx.loop.duration = Math.max(v, 0.1) }, fin)))
    if (generic) {
      const dflt = LOOP_DEFAULTS[generic.type].amount
      const asPct = generic.type === 'pulse' || generic.type === 'blink'
      const amountRow = ctx.row('Amount', ctx.number(
        asPct ? Math.round((generic.amount ?? dflt) * 100) : (generic.amount ?? dflt), 1,
        (v, fin) => ctx.mutate(el.id, (e) => {
          const lp = e.fx?.loop
          if (lp && lp.type !== 'dash-march' && lp.type !== 'motion-path') lp.amount = asPct ? Math.max(v, 0) / 100 : v
        }, fin)))
      amountRow.title = {
        pulse: t('How much it grows, in % (8 = up to 8% bigger)'),
        blink: t('How far it dims, in % (70 = down to 30% opacity)'),
        float: t('How far it rises, in pixels'),
        wiggle: t('Degrees it swings to each side'),
        spin: t('Degrees per turn — negative spins the other way'),
      }[generic.type]
      if (generic.type === 'spin' || generic.type === 'wiggle' || generic.type === 'pulse') {
        ctx.row('Pivot', ctx.labeledSelect(
          [['center', tc('Center', 'pivot')], ['bottom', t('Bottom')], ['top', t('Top')], ['left', t('Left')], ['right', t('Right')]],
          generic.origin ?? 'center',
          (v) => ctx.mutate(el.id, (e) => {
            const lp = e.fx?.loop
            if (!lp || lp.type === 'dash-march' || lp.type === 'motion-path') return
            if (v === 'center') delete lp.origin; else lp.origin = v as LoopOrigin
          }, true)))
      }
      ctx.row('Loop delay', ctx.number(generic.delay ?? 0, 0.1, (v, fin) =>
        ctx.mutate(el.id, (e) => {
          const lp = e.fx?.loop
          if (lp && lp.type !== 'dash-march' && lp.type !== 'motion-path') { if (v > 0) lp.delay = v; else delete lp.delay }
        }, fin)))
    }
    if (loop.type === 'motion-path') {
      const path = document.createElement('input')
      path.type = 'text'
      path.value = loop.path
      path.title = t('SVG path the element travels along, relative to its position')
      path.addEventListener('change', () =>
        ctx.mutate(el.id, (e) => { if (e.fx?.loop?.type === 'motion-path') e.fx.loop.path = path.value }, true))
      ctx.row('Path', path)

      // lap easing — the tempo of a whole lap (per-anchor speed is edited on canvas)
      ctx.row('Lap easing', ctx.labeledSelect(
        [['none', t('Constant')], ['sine.inOut', t('Ease in-out')], ['power2.in', t('Ease in')], ['power2.out', t('Ease out')]],
        (loop as { ease?: string }).ease ?? 'none',
        (v) => ctx.mutate(el.id, (e) => {
          const lp = e.fx?.loop
          if (lp?.type !== 'motion-path') return
          if (v === 'none') delete lp.ease; else lp.ease = v
        }, true)))

      const editPath = document.createElement('button')
      editPath.className = 'ed-btn ed-btn-block'
      editPath.textContent = t('✎ Edit path on canvas')
      editPath.title = t('Drag points to reshape · double-click to add/remove · scroll a point to change its speed')
      editPath.addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('slidomingo:edit-path', { detail: { id: el.id } })))
      ctx.host.appendChild(editPath)
      const speedHint = document.createElement('p')
      speedHint.className = 'ed-hint'
      speedHint.textContent = t('Tip: on the canvas, scroll a point to make the element dwell there or rush past it.')
      ctx.host.appendChild(speedHint)
    }
  }

  if (el.fx) {
    const play = document.createElement('button')
    play.className = 'ed-btn ed-btn-block'
    play.textContent = t('▶ Preview animation')
    play.title = t('Play this slide\'s animations on the canvas (click or any key stops)')
    play.addEventListener('click', () => document.dispatchEvent(new CustomEvent('slidomingo:preview-fx')))
    ctx.host.appendChild(play)
  }

  // hover-reveal set membership
  const soh = document.createElement('input')
  soh.type = 'text'
  soh.placeholder = t('always visible')
  soh.value = el.showOnHover ?? ''
  soh.title = "Only visible while an element with this group is hovered (slide hover: 'reveal')"
  soh.addEventListener('change', () => {
    ctx.mutate(el.id, (e) => {
      if (soh.value) e.showOnHover = soh.value
      else delete e.showOnHover
    }, true)
    // follow the element into its new set so it stays visible/editable
    ctx.store.hoverPreview = soh.value || null
    ctx.store.emit('current')
  })
  ctx.row('Show on hover', soh)

  // group tag (hover focus & interaction targeting)
  const group = document.createElement('input')
  group.type = 'text'
  group.placeholder = t('none')
  group.value = el.group ?? ''
  group.addEventListener('change', () =>
    ctx.mutate(el.id, (e) => {
      if (group.value) e.group = group.value
      else delete e.group
    }, true))
  ctx.row('Group', group)

  // link → slide picker
  const sel = document.createElement('select')
  const none = document.createElement('option')
  none.value = ''
  none.textContent = t('none')
  sel.appendChild(none)
  ctx.store.doc.slides.forEach((s, i) => {
    const o = document.createElement('option')
    o.value = s.id
    o.textContent = ctx.slideLabel(s, i)
    if (el.link === s.id) o.selected = true
    sel.appendChild(o)
  })
  sel.addEventListener('change', () =>
    ctx.mutate(el.id, (e) => {
      if (sel.value) e.link = sel.value
      else delete e.link
    }, true))
  if (el.type !== 'zoom') ctx.row('Link to', sel) // a zoom tile's click is the zoom

  // one-click interactivity: duplicate this slide as a hidden state
  // (element ids preserved ⇒ it morphs) and link this element to it
  const makeState = document.createElement('button')
  makeState.className = 'ed-btn ed-btn-block'
  makeState.textContent = t('＋ New state linked from this element')
  makeState.title = t('Duplicates this slide as a hidden interactive state and links the selected element to it')
  makeState.addEventListener('click', () => createLinkedState(ctx, el))
  if (el.type !== 'zoom') ctx.host.appendChild(makeState)

  buildMorphProps(ctx, el)
}

/** Duplicate the current slide as a hidden state and link `el` to it. */
function createLinkedState(ctx: PanelContext, el: SlideElement) {
  const state = addLinkedState(ctx.store, ctx.store.slide.id, el.id)
  if (state) ctx.store.goTo(ctx.store.doc.slides.indexOf(state))
}

/**
 * The text alternative (model.ts `Describable`): what a screen reader says
 * instead of the picture, chart or clip. Open by default — unlike the other
 * "more" sections it is not a tweak, it is the one thing the picture cannot
 * say for itself, and Check slides points people here. "Decorative" stores
 * `alt: ''` (HTML's own convention); clearing the field drops the key, back
 * to "not described yet". Each change is one undo step.
 */
export function buildAltProps(ctx: PanelContext, el: ImageElement | SvgElement | ChartElement | MediaElement) {
  ctx.section('Alt text')
  const decorative = el.alt === ''
  const ta = document.createElement('textarea')
  ta.className = 'ed-alt-text'
  ta.rows = 3
  ta.maxLength = LIMITS.alt
  ta.value = el.alt ?? ''
  ta.disabled = decorative
  ta.placeholder = decorative
    ? t('Decorative — screen readers skip it')
    : t('Describe what this shows for someone who can’t see it')
  ta.setAttribute('aria-label', t('Alt text'))
  ta.addEventListener('change', () => ctx.mutate(el.id, (e) => {
    const v = ta.value.trim()
    const d = e as ImageElement
    if (v) d.alt = v
    else delete d.alt
  }, true))
  ctx.host.appendChild(ta)
  ctx.row('Decorative', ctx.toggle(decorative, (on) => ctx.mutate(el.id, (e) => {
    const d = e as ImageElement
    if (on) d.alt = ''
    else delete d.alt
  }, true)))
  // A slide's copy of a slide-type element is rebuilt from the type on the
  // next resync (applyLayout keeps only text and link), so alt typed here
  // would quietly vanish — say where it has to go instead.
  const owner = ctx.store.editingSurface ? undefined : resyncOwner(ctx.store.doc, ctx.store.slide, el)
  if (owner) {
    const hint = document.createElement('p')
    hint.className = 'ed-hint ed-alt-resync'
    hint.textContent = t('This comes from the slide type “{name}”: alt text typed here is reset when the slide type next re-applies. Set it on the slide type in the Layout Manager.', { name: owner.name ?? t('Untitled') })
    ctx.host.appendChild(hint)
  }
}

/** Where a picture or diagram came from and what it may be used under
 *  (model.ts Provenance). The icon library fills it in on insert; anything
 *  else is declared here. Blank fields are removed, and an emptied record
 *  is dropped from the file entirely. */
export function buildProvenanceProps(ctx: PanelContext, el: ImageElement | SvgElement) {
  const p = el.provenance
  ctx.section('Source & license', { modified: !!p && Object.keys(p).length > 0 })
  const field = (key: 'origin' | 'url' | 'author' | 'license', label: string, placeholder: string) => {
    const input = document.createElement('input')
    input.type = 'text'
    input.maxLength = key === 'url' ? LIMITS.provUrl : LIMITS.provField
    input.value = p?.[key] ?? ''
    input.placeholder = t(placeholder)
    input.spellcheck = false
    input.addEventListener('change', () => ctx.mutate(el.id, (e) => {
      const d = e as ImageElement
      const v = input.value.trim()
      const next = { ...(d.provenance ?? {}) }
      if (v) next[key] = v
      else delete next[key]
      if (Object.keys(next).length) d.provenance = next
      else delete d.provenance
    }, true))
    ctx.row(label, input)
  }
  field('origin', 'Found in', 'Where it came from')
  field('url', 'Address', 'Link to the file')
  field('author', 'Author', 'Who made it')
  field('license', 'License', 'e.g. CC0-1.0, Company-owned')
  if (p && !p.license?.trim()) {
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.textContent = t('No license recorded — if you’re not sure it may be used here, replace it.')
    ctx.host.appendChild(hint)
  }
}
