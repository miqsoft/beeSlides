// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Props panels for the slide surface (nothing selected): an ordinary slide,
// a figure page, a Layout Manager slide type, a reusable object — plus the
// slide's Builds and Auto-play sections and the deck-wide theme swatches.

import { PAGE_PRESETS, clampPageEdge, patchPresent, setSlideFooterVisible, syncStateWithParent, type PresentFlag } from '../decksettings'
import type { Store } from '../../store'
import { FIGURE_PRESETS, figureSizePx, pxToUnit, FOOTER_ROLES, type Slide, type SlideElement, type TransitionKind, type TransitionDir, TRANSITION_DIRS, transitionDir, setSlideTransition, type FooterRole, type FigureUnit } from '../../model'
import { TRANSITION_KINDS, TRANSITION_LABELS, TRANSITION_DIR_LABELS } from '../menumodel'
import { buildPlan, clickHasParagraphs, mergeClickIntoPrevious, setEnterClick, setExitClick, stepsOf, swapClicks } from '../../builds'
import { paletteOf } from '../../palette'
import { populateFontSelect } from '../../fonts'
import { ICONS } from '../../icons'
import { t } from '../../i18n'
import { loadGridPref, saveGridPref, FIGURE_GRID_STEPS_MM } from '../gridpref'
import { buildColorControl } from '../colorpicker'
import { positionAtRect } from '../floatingposition'
import { renderStyleDefaultsForm } from '../styledefaults'
import { liveStep } from '../livestep'
import { ROW_TIPS, type PanelContext, toast } from './context'
import { morphElDesc } from './element'
import { buildIconsetPanel } from './iconset'

/**
 * Minimal panel for the reusable-object editing surface — Name + optional
 * Background only. Deliberately NOT `buildSlidePanel()`: that panel's
 * "Page size" control writes `doc.size` — showing it here would let an
 * edit meant for a small figure accidentally resize the WHOLE DECK.
 */
export function buildReusableObjectPanel(ctx: PanelContext) {
  const obj = ctx.store.slide
  ctx.section('Reusable object')
  const name = document.createElement('input')
  name.type = 'text'
  name.placeholder = t('Untitled object')
  name.value = obj.name ?? ''
  name.addEventListener('change', () =>
    ctx.edit(() => { ctx.store.slide.name = name.value.trim() || undefined }, true))
  ctx.row('Name', name)
  ctx.row('Background', ctx.color(obj.background, (v, fin) =>
    ctx.edit(() => { ctx.store.slide.background = v }, fin),
    { id: null, path: 'background' }))
}

/**
 * Minimal panel for a Slide Types sub-editor when nothing on that surface
 * is selected — Name + Background. Deliberately NOT `buildSlidePanel()`,
 * for the same reason `buildReusableObjectPanel()` isn't used for
 * reusable objects: a `doc.layouts` entry is not actually in `doc.slides`,
 * so `buildSlidePanel()`'s "Page size" (mutates the WHOLE DECK's
 * `doc.size`), "Hide slide" / "Exclude from page numbering" (neither is
 * ever reached by linear navigation or PDF export to begin with) and
 * deck-wide "Slideshow" section are all semantically nonsensical here.
 * `store.slide.name` here IS the slide type's real, displayed name (the
 * Slide Types grid card title, the "Editing "{name}"" header).
 */
export function buildLayoutSurfacePanel(ctx: PanelContext) {
  const slide = ctx.store.slide
  ctx.section('Slide types')
  const name = document.createElement('input')
  name.type = 'text'
  name.placeholder = t('Untitled')
  name.value = slide.name ?? ''
  name.addEventListener('change', () =>
    ctx.edit(() => { ctx.store.slide.name = name.value.trim() || undefined }, true))
  ctx.row('Name', name)
  ctx.row('Background', ctx.color(slide.background, (v, fin) =>
    ctx.edit(() => { ctx.store.slide.background = v }, fin),
    { id: null, path: 'background' }))

  // This slide type's OWN font choices (model.ts's `Slide.fontFamily`/
  // `headingFamily`) — nearest-wins up the parent chain, then doc.theme
  // (render.ts's resolveSlideFonts). Collapsed by default (CLOSED_BY_DEFAULT)
  // like the other rarely-touched sections, and NOT gated on "has
  // children" — a leaf slide type may want its own override before ever
  // becoming a parent.
  ctx.section('Fonts')
  const bodySel = document.createElement('select')
  populateFontSelect(bodySel, ctx.store.doc, slide.fontFamily ?? '', t('Inherit'))
  bodySel.addEventListener('change', () =>
    ctx.edit(() => {
      if (bodySel.value) ctx.store.slide.fontFamily = bodySel.value
      else delete ctx.store.slide.fontFamily
    }, true))
  ctx.row('Body font', bodySel)
  const headSel = document.createElement('select')
  populateFontSelect(headSel, ctx.store.doc, slide.headingFamily ?? '', t('Inherit'))
  headSel.addEventListener('change', () =>
    ctx.edit(() => {
      if (headSel.value) ctx.store.slide.headingFamily = headSel.value
      else delete ctx.store.slide.headingFamily
    }, true))
  ctx.row('Heading font', headSel)

  // What NEW shapes/lines/text look like on slides of this type — the form
  // lives in styledefaults.ts; collapsed by default like Fonts.
  ctx.section('Default styles')
  renderStyleDefaultsForm(ctx.host, ctx.store, { kind: 'layout', id: slide.id })
}

/** "Show on this slide" for each footer piece the slide carries
 *  (`slide.footer`) — PowerPoint's Header & Footer "Apply", one slide at a
 *  time. A piece switched off deck-wide shows here as off and disabled:
 *  the deck-wide switch is in Document properties. */
function buildSlideFooterToggles(ctx: PanelContext, slide: Slide) {
  const present = new Set(slide.elements.flatMap((e) => (e.type === 'text' && e.footerRole ? [e.footerRole] : [])))
  if (!present.size) return
  const hf = ctx.store.doc.headerFooter
  const labels: Record<FooterRole, string> = { date: 'Show date', slideNumber: 'Show slide number', footer: 'Show footer' }
  for (const role of FOOTER_ROLES) {
    if (!present.has(role)) continue
    const deckOff = hf?.[role]?.show === false
    const input = ctx.toggle(!deckOff && slide.footer?.[role] !== false, (v) =>
      ctx.edit(() => setSlideFooterVisible(ctx.store.slide, role, v), true))
    if (deckOff) {
      input.setAttribute('disabled', '')
      input.title = t('Switched off for the whole deck — Document properties ▸ Header & footer')
    }
    ctx.row(labels[role], input)
  }
}

export function buildSlidePanel(ctx: PanelContext) {
  const slide = ctx.store.slide
  if (ctx.store.doc.kind === 'figure') { buildFigurePanel(ctx); return }
  if (ctx.store.doc.kind === 'iconset') { buildIconsetPanel(ctx); return }
  ctx.section('Slide')
  buildSlideTypeRow(ctx, slide)
  // deck-wide page size: presets + custom. Elements keep their absolute
  // positions — a size change reframes the canvas, it never rescales art.
  const { width: dw, height: dh } = ctx.store.doc.size
  const presetKey =
    Object.entries(PAGE_PRESETS).find(([, s]) => s.w === dw && s.h === dh)?.[0] ?? 'Custom…'
  let widthRow: HTMLLabelElement
  let heightRow: HTMLLabelElement
  const showCustomSize = (show: boolean) => {
    widthRow.style.display = show ? '' : 'none'
    heightRow.style.display = show ? '' : 'none'
  }
  ctx.row('Page size', ctx.select(
    [...Object.keys(PAGE_PRESETS), 'Custom…'],
    presetKey,
    (v) => {
      const s = PAGE_PRESETS[v]
      if (s) {
        showCustomSize(false)
        ctx.edit(() => { ctx.store.doc.size = { width: s.w, height: s.h } }, true)
      } else {
        showCustomSize(true)
      }
    },
  ))
  widthRow = ctx.row('Width', ctx.number(dw, 10, (v, fin) =>
    ctx.edit(() => { ctx.store.doc.size.width = clampPageEdge(v) }, fin)))
  heightRow = ctx.row('Height', ctx.number(dh, 10, (v, fin) =>
    ctx.edit(() => { ctx.store.doc.size.height = clampPageEdge(v) }, fin)))
  showCustomSize(presetKey === 'Custom…')
  ctx.row('Background', ctx.color(slide.background, (v, fin) =>
    ctx.edit(() => { ctx.store.slide.background = v }, fin),
    { id: null, path: 'background' }))
  ctx.row('Transition', ctx.labeledSelect(
    TRANSITION_KINDS.map((k) => [k, t(TRANSITION_LABELS[k])]),
    slide.transition,
    (v) => ctx.edit(() => { setSlideTransition(ctx.store.slide, v as TransitionKind) }, true),
  ))
  // push/wipe/cover/split only; picking the default writes no field
  const dirs = TRANSITION_DIRS[slide.transition]
  if (dirs) {
    ctx.row('Direction', ctx.labeledSelect(
      dirs.map((d) => [d, t(TRANSITION_DIR_LABELS[d])]),
      transitionDir(slide) ?? dirs[0],
      (v) => ctx.edit(() => {
        if (v === dirs[0]) delete ctx.store.slide.transitionDir
        else ctx.store.slide.transitionDir = v as TransitionDir
      }, true),
    ))
  }
  // Hidden slides stay in the deck and stay editable; they drop out of the
  // walk, the PDF and the file thumbnail. Hidden slides directly after a
  // normal one are its "extras" (X while presenting). The toggle acts on the
  // whole slide-panel selection. Offered only on ordinary slides —
  // a state is already unreachable linearly, so hiding one means nothing.
  if (!slide.stateOf) {
    ctx.row('Hide slide', ctx.toggle(!!slide.hidden, (v) => {
      if (ctx.panel.setSlidesHidden) ctx.panel.setSlidesHidden(v)
      else ctx.edit(() => {
        if (v) ctx.store.slide.hidden = true
        else delete ctx.store.slide.hidden
      }, true)
    }))
    ctx.row('Exclude from page numbering', ctx.toggle(!!slide.excludeFromNumbering, (v) =>
      ctx.edit(() => {
        if (v) ctx.store.slide.excludeFromNumbering = true
        else delete ctx.store.slide.excludeFromNumbering
      }, true)))
    const numberingHint = document.createElement('p')
    numberingHint.className = 'ed-hint'
    numberingHint.textContent = t('Stays visible and reachable — only its own page number is skipped, and later slides still count normally')
    ctx.host.appendChild(numberingHint)
    buildSlideFooterToggles(ctx, slide)
  }
  if (slide.transition === 'morph') {
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.innerHTML = t('<b>Morph</b> animates elements that appear on both this slide and the previous one (copy a slide, then move things around).')
    ctx.host.appendChild(hint)
  }

  buildBuildsProps(ctx, slide)
  buildAutoPlayProps(ctx, slide)

  // Deck-wide slideshow chrome, in its own section: these are not properties
  // of THIS slide (the section above) but of how the whole deck presents, and
  // mixing them in beside Background and Transition read as per-slide.
  //
  // "Slideshow" is what the UI already calls present mode on the button, and
  // it avoids colliding with the element panel's own "Presenting" section.
  ctx.section('Slideshow')
  // These live in doc.present because they are AUDIENCE-facing: what the
  // author designs is what a recipient's audience sees. Contrast reduce-motion
  // and locale, which are viewer preferences and deliberately never enter the
  // document.
  //
  // Each writes `undefined` at its default rather than the default value, so a
  // deck that never touches these carries no `present` block at all.
  const pres = ctx.store.doc.present ?? {}
  const setPresent = (k: PresentFlag, v: boolean, _dflt: boolean) =>
    ctx.edit(() => patchPresent(ctx.store.doc, { [k]: v }), true)
  ctx.row('Slide number', ctx.toggle(pres.slideNumber ?? true,
    (v) => setPresent('slideNumber', v, true)))
  ctx.row('Progress bar', ctx.toggle(pres.progress ?? true,
    (v) => setPresent('progress', v, true)))
  ctx.row('Corner arrows', ctx.toggle(pres.controls ?? false,
    (v) => setPresent('controls', v, false)))
  // Off by default: skipped means uncounted, the same rule interactive states
  // already follow, which is what keeps the audience's numbering contiguous.
  // On matches PowerPoint and Keynote, where a hidden slide keeps its number
  // so the visible ones do not renumber as you toggle slides during rehearsal.
  ctx.row('Number hidden slides', ctx.toggle(pres.numberHidden ?? false,
    (v) => setPresent('numberHidden', v, false)))
  // Kiosk: the show moves on by itself and wraps. Absent = manual, so a deck
  // that never touches these carries no extra keys.
  ctx.row('Auto-advance (secs)', ctx.number(pres.autoAdvance ?? 0, 1, (v, fin) =>
    ctx.edit(() => patchPresent(ctx.store.doc, { autoAdvance: v }), fin)))
  ctx.row('Loop the show', ctx.toggle(pres.loop ?? false, (v) => setPresent('loop', v, false)))


  // interactivity: naming, state-of, hover focus
  buildThemeProps(ctx)
  ctx.section('Interactivity')
  const name = document.createElement('input')
  name.type = 'text'
  name.placeholder = t('unnamed')
  name.value = slide.name ?? ''
  name.addEventListener('change', () =>
    ctx.edit(() => { ctx.store.slide.name = name.value || undefined }, true))
  ctx.row('Name', name)

  const stateSel = document.createElement('select')
  const optNone = document.createElement('option')
  optNone.value = ''
  optNone.textContent = t('no — normal slide')
  stateSel.appendChild(optNone)
  ctx.store.doc.slides.forEach((s, i) => {
    if (s.stateOf || s.id === slide.id) return
    const o = document.createElement('option')
    o.value = s.id
    o.textContent = ctx.slideLabel(s, i)
    if (slide.stateOf === s.id) o.selected = true
    stateSel.appendChild(o)
  })
  stateSel.addEventListener('change', () =>
    ctx.edit(() => {
      ctx.store.slide.stateOf = stateSel.value || undefined
      ctx.store.emit('slides')
    }, true))
  stateSel.title = t('A state is hidden from arrow-key flow — viewers reach it by clicking a linked element. Shared element ids morph between states.')
  ctx.row('State of', stateSel)

  if (slide.stateOf) {
    const sync = document.createElement('button')
    sync.className = 'ed-btn ed-btn-block'
    sync.innerHTML = `${ICONS.sync}<span>${t('Sync from parent slide')}</span>`
    sync.title = t('Pull elements added to the parent into this state and adopt its ordering — your changes to shared elements are kept')
    sync.addEventListener('click', () => syncStateFromParent(ctx))
    ctx.host.appendChild(sync)
  }

  ctx.row('Hover', ctx.select(
    ['none', 'focus-group', 'reveal'],
    slide.hover?.type ?? 'none',
    (v) => ctx.edit(() => {
      ctx.store.slide.hover = v === 'none'
        ? undefined
        : { ...(ctx.store.slide.hover ?? {}), type: v as 'focus-group' | 'reveal' }
    }, true)))
  if (slide.hover?.type === 'focus-group') {
    ctx.row('Hover dim', ctx.number(slide.hover.dim ?? 0.15, 0.01, (v, fin) =>
      ctx.edit(() => { if (ctx.store.slide.hover) ctx.store.slide.hover.dim = Math.min(Math.max(v, 0), 1) }, fin)))
  }
  if (slide.hover?.type === 'reveal') {
    const sets = [...new Set(slide.elements.map((e) => e.showOnHover).filter(Boolean))] as string[]
    const defIn = document.createElement('input')
    defIn.type = 'text'
    defIn.placeholder = sets[0] ?? 'set name'
    defIn.value = slide.hover.default ?? ''
    defIn.addEventListener('change', () =>
      ctx.edit(() => { if (ctx.store.slide.hover) ctx.store.slide.hover.default = defIn.value || undefined }, true))
    ctx.row('Default set', defIn)
    if (sets.length) {
      ctx.row('Preview set', ctx.select(sets, ctx.store.hoverPreview ?? slide.hover.default ?? sets[0], (v) => {
        ctx.store.hoverPreview = v
        ctx.store.emit('current') // re-render canvas without touching the doc
      }))
      const revealHint = document.createElement('p')
      revealHint.className = 'ed-hint'
      revealHint.innerHTML = t('While presenting, hovering an element whose <b>group</b> matches a set name shows that set. Use Preview to edit each set.')
      ctx.host.appendChild(revealHint)
    }
  }
}

/**
 * The slide's type as ONE control at the top of the slide panel: the name
 * opens the picker ("Change slide type…", editor.ts changeSlideLayout —
 * onto a doc type the slide FOLLOWS it, onto a built-in it is re-arranged
 * once and unlinked); the rare actions sit behind ⋯. A dangling layoutId
 * (its type deleted by a path that predates removeLayout's cleanup) reads
 * as not linked.
 */
function buildSlideTypeRow(ctx: PanelContext, slide: Slide) {
  const type = slide.layoutId ? ctx.store.doc.layouts?.find((l) => l.id === slide.layoutId) : undefined
  const wrap = document.createElement('div')
  wrap.className = 'ed-slidetype'
  const pickB = document.createElement('button')
  pickB.type = 'button'
  pickB.className = 'ed-slidetype-pick'
  const name = document.createElement('span')
  name.className = 'ed-slidetype-name'
  name.textContent = type ? type.name ?? t('Untitled') : t('None')
  if (type) name.title = name.textContent // the full name when it is cut short
  const caret = document.createElement('span')
  caret.className = 'ed-slidetype-chev'
  caret.innerHTML = ICONS.chevronDown
  pickB.append(name, caret)
  pickB.title = t('Pick the slide type this slide follows — its content moves into the new placeholders; nothing is deleted')
  pickB.addEventListener('click', () =>
    document.dispatchEvent(new CustomEvent('slidomingo:apply-layout', { detail: { anchor: pickB } })))
  const moreB = document.createElement('button')
  moreB.type = 'button'
  moreB.className = 'ed-slidetype-more'
  moreB.innerHTML = ICONS.more
  moreB.title = t('More options')
  moreB.setAttribute('aria-label', t('More options'))
  moreB.setAttribute('aria-haspopup', 'menu')
  moreB.addEventListener('click', (ev) => {
    ev.preventDefault() // the row is a <label>: never forward the click to the picker button
    openSlideTypeMenu(ctx, moreB, type)
  })
  if (!type) name.classList.add('is-none')
  wrap.append(pickB, moreB)
  ctx.row('Slide type', wrap)
  const hint = document.createElement('p')
  hint.className = 'ed-hint ed-slidetype-hint'
  hint.textContent = type
    ? t('Follows this slide type — edits to it update this slide')
    : t('Edits in the Layout Manager don’t reach this slide')
  if (type) hint.title = t('Edits to that slide type re-apply here automatically — including its frame and fonts, which can override a local tweak.')
  ctx.host.appendChild(hint)
}

/** The slide-type row's ⋯ menu: the actions too rare for their own button. */
function openSlideTypeMenu(ctx: PanelContext, anchor: HTMLElement, type: Slide | undefined) {
  document.querySelector('.ed-slidetype-menu')?.remove()
  const menu = document.createElement('div')
  menu.className = 'ed-ctx-menu ed-slidetype-menu'
  menu.setAttribute('role', 'menu')
  const close = () => {
    menu.remove()
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('keydown', onKey, true)
  }
  const item = (label: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-btn'
    b.setAttribute('role', 'menuitem')
    b.textContent = label
    b.addEventListener('click', () => { close(); onClick() })
    menu.appendChild(b)
  }
  const openLM = (layoutId?: string) => document.dispatchEvent(new CustomEvent('slidomingo:open-layout-manager',
    { detail: layoutId ? { tab: 'types', layoutId } : undefined }))
  if (type) item(t('Edit this slide type'), () => openLM(type.id))
  item(t('Save as slide type…'), () => void ctx.panel.promptSaveSlideAsLayout())
  if (type) item(t('Unlink (keep look)'), () => ctx.edit(() => { delete ctx.store.slide.layoutId }, true))
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'ed-menu-sep' }))
  item(t('Layout Manager…'), () => openLM())
  document.body.appendChild(menu)
  positionAtRect(anchor.getBoundingClientRect(), menu, { placement: 'bottom', align: 'end', gap: 4, margin: 8 })
  const onOutside = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) close()
  }
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('keydown', onKey, true)
  ;(menu.querySelector('button') as HTMLButtonElement | null)?.focus()
}

/** Figure mode's page panel: physical size, background, drawing grid, crop to content. */
function buildFigurePanel(ctx: PanelContext) {
  const doc = ctx.store.doc
  const unit: FigureUnit = doc.figure?.unit ?? 'mm'
  const round = (v: number) => Math.round(v * 100) / 100
  const w = round(doc.figure?.width ?? pxToUnit(doc.size.width, unit))
  const h = round(doc.figure?.height ?? pxToUnit(doc.size.height, unit))
  ctx.section('Figure')
  const setSize = (nw: number, nh: number, nu: FigureUnit) => ctx.edit(() => {
    doc.figure = { unit: nu, width: nw, height: nh }
    doc.size = figureSizePx(nw, nh, nu)
  }, true)
  const presetLabels = FIGURE_PRESETS.map((p) => p.label)
  const current = FIGURE_PRESETS.findIndex((p) => unit === 'mm' && p.width === w)
  ctx.row('Width preset', ctx.select([...presetLabels, 'Custom'], current >= 0 ? presetLabels[current] : 'Custom', (v) => {
    const p = FIGURE_PRESETS[presetLabels.indexOf(v)]
    if (p) setSize(p.width, h, 'mm')
  }))
  ctx.row('Unit', ctx.select(['mm', 'pt', 'in'], unit, (v) => {
    const nu = v as FigureUnit
    setSize(round(pxToUnit(doc.size.width, nu)), round(pxToUnit(doc.size.height, nu)), nu)
  }))
  ctx.row(`Width (${unit})`, ctx.number(w, unit === 'in' ? 0.1 : 1, (v) => v > 0 && setSize(round(v), h, unit)))
  ctx.row(`Height (${unit})`, ctx.number(h, unit === 'in' ? 0.1 : 1, (v) => v > 0 && setSize(w, round(v), unit)))
  ctx.row('Background', ctx.color(ctx.store.slide.background, (v, fin) =>
    ctx.edit(() => { ctx.store.slide.background = v }, fin),
    { id: null, path: 'background' }))
  // The grid is a viewer preference (gridpref.ts); the Editor re-applies it on this event.
  const gp = loadGridPref()
  // a custom spacing set in Grid & Snap shows as its own entry
  const steps = FIGURE_GRID_STEPS_MM.includes(gp.figureStepMm) ? FIGURE_GRID_STEPS_MM : [...FIGURE_GRID_STEPS_MM, gp.figureStepMm].sort((a, b) => a - b)
  const grids = ['Off', ...steps.map((mm) => `${mm} mm`)]
  ctx.row('Grid', ctx.select(grids, gp.on ? `${gp.figureStepMm} mm` : 'Off', (v) => {
    const mm = parseFloat(v)
    const p = loadGridPref()
    saveGridPref(Number.isFinite(mm) ? { ...p, on: true, figureStepMm: mm } : { ...p, on: false })
    document.dispatchEvent(new CustomEvent('slidomingo:grid-changed'))
  }))
  const fit = document.createElement('button')
  fit.className = 'ed-btn ed-btn-block'
  fit.textContent = t('Fit canvas to content')
  fit.title = t('Crop the canvas to the drawing plus a 2 mm margin')
  fit.addEventListener('click', () => document.dispatchEvent(new CustomEvent('slidomingo:figure-fit')))
  ctx.host.appendChild(fit)
}

/**
 * The slide's click builds as an ordered list: one group per click, each row
 * an element that arrives (＋) or leaves (－) on it. ↑/↓ or a drag moves a row
 * between clicks; a click header folds into / swaps with its neighbour. All
 * edits go through builds.ts, which renumbers to compressed clicks, so the
 * list can never hold a gap.
 */
function buildBuildsProps(ctx: PanelContext, slide: Slide) {
  const plan = buildPlan(slide)
  const n = plan.steps.length
  ctx.section('Builds', { modified: n > 0 })
  const apply = (fn: (s: Slide) => void) => ctx.edit(() => fn(ctx.store.slide), true)

  if (!n) {
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.textContent = t('No click builds yet. Select an element and set when it Appears (Presenting) — the order shows up here.')
    ctx.host.appendChild(hint)
    return
  }

  const actions = document.createElement('div')
  actions.className = 'ed-builds-actions'
  const step = document.createElement('button')
  step.className = 'ed-btn ed-btn-block'
  step.textContent = t('▶ Step through')
  step.title = t('Play the slide’s clicks one at a time on the canvas (→ next, ← back, Esc ends)')
  step.addEventListener('click', () => document.dispatchEvent(new CustomEvent('slidomingo:step-through')))
  const play = document.createElement('button')
  play.className = 'ed-btn ed-btn-block'
  play.textContent = t('▶ Preview animation')
  play.title = t('Play this slide\'s animations on the canvas (click or any key stops)')
  play.addEventListener('click', () => document.dispatchEvent(new CustomEvent('slidomingo:preview-fx')))
  actions.append(step, play)
  ctx.host.appendChild(actions)

  type Row = { kind: 'enter' | 'exit'; el: SlideElement; para?: number }
  const rowsBy: Row[][] = Array.from({ length: n + 1 }, () => [])
  const withSlide: Row[] = []
  for (const el of slide.elements) {
    if (el.hidden || el.showOnHover || !el.fx) continue
    const { enter } = stepsOf(plan, el.id)
    const paraBuilt = el.type === 'text' && !!el.fx.byParagraph
    if (!enter && (paraBuilt || el.fx.exitStep)) withSlide.push({ kind: 'enter', el })
  }
  plan.steps.forEach((st, i) => {
    for (const tg of st.enter) {
      const el = slide.elements.find((e) => e.id === tg.elId)
      if (el) rowsBy[i + 1].push({ kind: 'enter', el, para: tg.para })
    }
    for (const tg of st.exit) {
      const el = slide.elements.find((e) => e.id === tg.elId)
      if (el) rowsBy[i + 1].push({ kind: 'exit', el })
    }
  })

  const list = document.createElement('div')
  list.className = 'ed-builds'
  const drop = (group: HTMLElement, click: number) => {
    group.addEventListener('dragover', (ev) => { ev.preventDefault(); group.classList.add('over') })
    group.addEventListener('dragleave', () => group.classList.remove('over'))
    group.addEventListener('drop', (ev) => {
      ev.preventDefault()
      group.classList.remove('over')
      const [kind, id] = (ev.dataTransfer?.getData('text/plain') ?? '').split('|')
      if (!id) return
      if (kind === 'exit') { if (click > 0) apply((s) => setExitClick(s, id, click)) }
      else if (kind === 'enter') apply((s) => setEnterClick(s, id, click))
    })
  }
  const mkRow = (r: Row, click: number): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'ed-build-row ' + r.kind
    row.draggable = r.para === undefined || r.para === 0
    row.addEventListener('dragstart', (ev) => ev.dataTransfer?.setData('text/plain', `${r.kind}|${r.el.id}`))
    const icon = document.createElement('span')
    icon.className = 'ed-build-kind'
    icon.textContent = r.kind === 'enter' ? '＋' : '－'
    icon.title = r.kind === 'enter' ? t('Appears') : t('Disappears')
    const label = document.createElement('button')
    label.type = 'button'
    label.className = 'ed-build-label'
    // shapes carry no words, so tell same-typed rows apart by where they sit
    label.textContent = morphElDesc(r.el)
      + (r.el.type === 'text' ? '' : ` (${Math.round(r.el.x)}, ${Math.round(r.el.y)})`)
      + (r.para !== undefined ? `  ¶${r.para + 1}` : '')
    label.title = t('Select this element')
    label.addEventListener('click', () => ctx.store.select([r.el.id]))
    row.append(icon, label)
    // paragraphs after the first follow their box's run — only the first moves it
    if (r.para === undefined || r.para === 0) {
      const mv = (glyph: string, title: string, to: number, disabled: boolean) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'ed-build-mv'
        b.textContent = glyph
        b.title = title
        b.disabled = disabled
        b.addEventListener('click', () =>
          apply((s) => (r.kind === 'enter' ? setEnterClick(s, r.el.id, to) : setExitClick(s, r.el.id, to))))
        row.appendChild(b)
      }
      const entered = stepsOf(plan, r.el.id).enter
      mv('↑', t('Move to the previous click'), click - 1, r.kind === 'enter' ? click <= 0 : click - 1 <= entered)
      mv('↓', t('Move to the next click'), click + 1, false)
    }
    row.addEventListener('click', (ev) => { if (ev.target === row) ctx.store.select([r.el.id]) })
    return row
  }

  if (withSlide.length) {
    const g = document.createElement('div')
    g.className = 'ed-build-group'
    const h = document.createElement('div')
    h.className = 'ed-build-head'
    h.textContent = t('With slide')
    g.appendChild(h)
    for (const r of withSlide) g.appendChild(mkRow(r, 0))
    drop(g, 0)
    list.appendChild(g)
  }
  for (let i = 1; i <= n; i++) {
    const g = document.createElement('div')
    g.className = 'ed-build-group'
    const h = document.createElement('div')
    h.className = 'ed-build-head'
    const name = document.createElement('span')
    name.textContent = t('Click {n}', { n: i })
    h.appendChild(name)
    const hb = (glyph: string, title: string, disabled: boolean, fn: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-build-mv'
      b.textContent = glyph
      b.title = title
      b.disabled = disabled
      b.addEventListener('click', fn)
      h.appendChild(b)
    }
    const locked = (c: number) => c < 1 || c > n || clickHasParagraphs(plan, c)
    const keep = t('Bullets keep their one-per-click order')
    hb('⇤', clickHasParagraphs(plan, i) ? keep : t('Fold this click into the one before it (with previous)'),
      clickHasParagraphs(plan, i), () => apply((s) => mergeClickIntoPrevious(s, i)))
    hb('↑', locked(i) || locked(i - 1) ? keep : t('Play this click earlier'), locked(i) || locked(i - 1), () => apply((s) => swapClicks(s, i, i - 1)))
    hb('↓', locked(i) || locked(i + 1) ? keep : t('Play this click later'), locked(i) || locked(i + 1), () => apply((s) => swapClicks(s, i, i + 1)))
    g.appendChild(h)
    for (const r of rowsBy[i]) g.appendChild(mkRow(r, i))
    drop(g, i)
    list.appendChild(g)
  }
  const fresh = document.createElement('div')
  fresh.className = 'ed-build-group ed-build-new'
  fresh.textContent = t('Drop here for a new click')
  drop(fresh, n + 1)
  list.appendChild(fresh)
  ctx.host.appendChild(list)
}

/**
 * Hands-free playback of ONE slide: its click builds play on a timer ("GIF"
 * slide) and/or the show leaves it by itself after N seconds (kiosk).
 */
function buildAutoPlayProps(ctx: PanelContext, slide: Slide) {
  const ab = slide.autoBuild
  ctx.section('Auto-play', { modified: !!(ab || slide.advanceAfter) })
  const setSlide = (fn: (s: Slide) => void) => ctx.edit(() => fn(ctx.store.slide), true)
  ctx.row('Play builds automatically', ctx.toggle(!!ab, (on) =>
    setSlide((s) => { if (on) s.autoBuild = { every: 2, hold: 2, loop: true }; else delete s.autoBuild })))
  if (ab) {
    const patch = (p: Partial<NonNullable<Slide['autoBuild']>>, fin: boolean) =>
      ctx.edit(() => {
        const cur = ctx.store.slide.autoBuild
        if (!cur) return
        const next = { ...cur, ...p }
        if (next.loop !== true) delete next.loop
        if (!next.hold) delete next.hold
        ctx.store.slide.autoBuild = next
      }, fin)
    ctx.row('Every (secs)', ctx.number(ab.every, 0.1, (v, fin) => patch({ every: Math.max(v, 0.1) }, fin)))
    ctx.row('Hold (secs)', ctx.number(ab.hold ?? 0, 0.1, (v, fin) => patch({ hold: Math.max(v, 0) }, fin)))
    ctx.row('Loop slide', ctx.toggle(!!ab.loop, (v) => patch({ loop: v }, true)))
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.textContent = t('The slide plays its clicks by itself, one every N seconds, holds on the last, then starts over. → and ← leave the slide.')
    ctx.host.appendChild(hint)
  }
  ctx.row('Advance after (secs)', ctx.number(slide.advanceAfter ?? 0, 1, (v, fin) =>
    ctx.edit(() => {
      if (v > 0) ctx.store.slide.advanceAfter = Math.min(v, 86400)
      else delete ctx.store.slide.advanceAfter
    }, fin)))
}

/**
 * Re-sync an interactive state with its parent: parent elements missing
 * here (added since the state was created) come in, ordering follows the
 * parent, and this state's own versions of shared elements — its whole
 * point — stay untouched. Elements unique to this state stay on top.
 */
function syncStateFromParent(ctx: PanelContext) {
  const r = syncStateWithParent(ctx.store, ctx.store.slide.id)
  if (typeof r === 'string') { toast(r); return }
  ctx.store.select([])
  const bits = [r.added ? `${r.added} new element${r.added > 1 ? 's' : ''} pulled in` : 'nothing new in the parent']
  if (r.kept) bits.push(`${r.kept} state-only element${r.kept > 1 ? 's' : ''} kept`)
  toast(`Synced — ${bits.join('; ')}`)
}

function buildThemeProps(ctx: PanelContext) {
  renderThemeSwatches(ctx.host, ctx.store)
}

/**
 * Deck-wide brand colours (Background/Text/Accent 1-6). Editing one re-derives
 * every colour in the deck that points at it (editor.syncThemeRefs), which is
 * what makes a BeeSlides deck re-brandable rather than a pile of literals.
 *
 * Shared by the element panel's Theme section (nothing selected) and the
 * Layout Manager / Settings "Document properties" form — both call this with
 * the same live Store, so there is no divergence between the two surfaces.
 */
export function renderThemeSwatches(host: HTMLElement, store: Store): void {
  let burst = false
  const edit = (mutate: () => void, final: boolean) => {
    if (!burst) {
      store.checkpoint()
      burst = true
    }
    mutate()
    if (final) {
      burst = false
      store.recordAction()
    }
    liveStep(final, () => store.touch()) // see ElementEdits.edit
  }
  const section = (key: string) => {
    const h = document.createElement('h3')
    h.className = 'ed-section'
    h.dataset.key = key // English key — the panel accordion persists by it
    h.textContent = t(key)
    host.appendChild(h)
  }
  const addRow = (label: string, input: HTMLElement) => {
    const row = document.createElement('label')
    row.className = 'ed-row'
    const span = document.createElement('span')
    span.textContent = t(label)
    const tip = ROW_TIPS[label]
    if (tip && !input.title) row.title = t(tip)
    row.append(span, input)
    host.appendChild(row)
  }
  const color = (value: string, onEdit: (v: string, final: boolean) => void): HTMLElement =>
    buildColorControl({ value, alpha: false, onChange: onEdit })

  section('Theme')
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.textContent = t('Deck-wide brand colours. Anything using a theme colour follows when you change it here.')
  host.appendChild(hint)
  const theme = store.doc.theme
  const slot = (label: string, get: () => string, set: (v: string) => void) =>
    addRow(label, color(get(), (v, fin) => edit(() => set(v), fin)))
  slot('Background', () => theme.background, (v) => { store.doc.theme.background = v })
  slot('Text', () => theme.color, (v) => { store.doc.theme.color = v })
  slot('Accent', () => theme.accent, (v) => { store.doc.theme.accent = v })
  for (const n of [2, 3, 4, 5, 6] as const) {
    const key = `accent${n}` as const
    slot(t('Accent {n}', { n: String(n) }), () => paletteOf(store.doc)[key], (v) => {
      const t2 = store.doc.theme
      ;(t2.palette ??= {})[key] = v
    })
  }
}
