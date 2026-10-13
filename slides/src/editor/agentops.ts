// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Handlers of the agent op areas declared in ../agentops/spec.ts (the `deck`
// tool, …). editor.ts applyAgentAction hands every area verb to runAreaOp:
// the args are checked against the spec first, so a handler only sees
// well-typed params. Every write goes through the same slideops.ts /
// slideorder.ts functions the UI uses, in ONE store.commit (one undo step).
//
// AREA_HANDLERS is typed from the spec: an op declared there without a
// handler here, or an area without a handler map, does not compile.
import { AGENT_AREAS, BUILTIN_SLIDE_TYPES, MAX_ELEMENT_CHANGES, MAX_ICON_RESULTS, MAX_SLIDES_PER_CALL, PAGE_SIZE_PRESETS, checkArgs, normalizeArgs } from '../agentops/spec'
import { t } from '../i18n'
import {
  builtinLayouts, deriveChartPalette, inLinearFlow, layoutElementIds, resolveAgentSlide, resyncLinkedSlides, sectionsInOrder, setSlideTransition, TRANSITION_DIRS,
  type FooterRole, type ShapeElement, type Slide, type SlideElement, type SlidomingoDoc, type TableElement, type TransitionDir, type TransitionKind,
} from '../model'
import {
  applyUnitFrames, buildUnits, companionRoom, companionsOf, contentMargin, currentGap, fmt, freedRegion, largestEmptyRect, placeCompanions,
  planAlign, planArrange, planDistribute, planMatchSize, unionFrame, type Companion, type Edge, type Frame, type Unit,
} from '../arrange'
import { checkLayout, guardLayout, snapshotSlide, type GuardResult, type LayoutFinding } from '../layoutguard'
import { checkElementProp, isWholePictureCrop, REQUIRED_KEYS } from '../untrusted'
import { agentSvgPatchViolation } from './agentsvg'
import { defaultLayoutGrid, layoutTracks, normalizeLayoutGrid, parseSpan, spanRect } from '../layoutgrid'
import { paletteOf, resolveThemeRefs } from '../palette'
import { cssColor, sanitizeHtml } from '../render'
import type { Store } from '../store'
import { afterSlideBlock, deleteSection, deleteSlidesByIds, duplicateSlidesInStore, insertSectionBefore, insertSlidesFromLayout, renameSection, slidesDeleteImpact, survivesDeletion } from './slideops'
import { applyTokens, moveSlidesTo, stepSlides, tokensOf } from './slideorder'
import { addLinkedState, clampPageEdge, commitHeaderFooter, footerElement, footerRolesInUse, patchPresent, setSlideFooterVisible, syncStateWithParent } from './decksettings'

export interface OpContext {
  store: Store
  /** Slides an agent added or duplicated in this editor session: the ones
   *  `delete` may remove without the user having asked. */
  created: Set<string>
  /** The user's icon library (`icons` tool); absent where there is none. */
  icons?: IconLibraryAccess
  /** How element writes reach the slide (`elements` tool). The editor passes
   *  its agent-write path (text measured by the real renderer, linked slides
   *  resynced); without one, a plain store commit + layout guard. */
  writes?: SlideWrites
}

/** One agent write on one slide, as the `elements` handlers need it. */
export interface SlideWrites {
  /** `mutate` the slide as ONE undo step; then the layout guard keeps text
   *  fitting, neighbours spaced and arrows attached (`reflow:false` = report
   *  only; `placed` = the changed elements were placed on purpose, nothing
   *  is reflowed around them). Returns the guard's report. */
  commit(slideId: string, mutate: (slide: Slide) => void, opts: { reflow: boolean; placed?: boolean }): GuardResult | null
  /** check_layout on the slide as it is now (optionally only around `elementIds`). */
  check(slideId: string, elementIds?: string[]): LayoutFinding[]
}

/** SlideWrites without an editor: the guard runs without text measurement. */
function plainWrites(store: Store): SlideWrites {
  return {
    commit(slideId, mutate, opts) {
      const slide = resolveAgentSlide(store.doc, slideId)!.slide
      const before = snapshotSlide(slide)
      let result: GuardResult | null = null
      store.commit(() => {
        mutate(slide)
        result = guardLayout(store.doc, slide, before, { apply: opts.reflow, placed: opts.placed })
      })
      return result
    },
    check(slideId, elementIds) {
      const slide = resolveAgentSlide(store.doc, slideId)?.slide
      return slide ? checkLayout(store.doc, slide, { elementIds }) : []
    },
  }
}

/** An icon a search found: what the model is shown, and how to fetch it. */
export interface AgentIcon {
  name: string
  description?: string
  category?: string
  ext: string
  /** The label of the source that found it. */
  source?: string
  /** What is known of its origin and terms (model.ts Provenance). */
  provenance?: { license?: string }
}

/** The editor's icon library, as the `icons` handlers see it. The editor
 *  keeps ONE per session, so refs from a search stay valid for later calls. */
export interface IconLibraryAccess<I extends AgentIcon = AgentIcon> {
  /** Searches every switched-on source. `notes` name sources that failed
   *  while others answered; throws (message for the model) when none did. */
  search(query: string): Promise<{ icons: I[]; notes: string[] }>
  /** Fetches `icon` and inserts it on `slideId` as ONE agent write (the
   *  insert_elements path: sanitized like a paste, one undo step). */
  insert(slideId: string, icon: I, frame: { x: number; y: number; w: number; h: number }, alt: string): Promise<{ elementId: string } | { error: string }>
  /** ref ("i3") → icon, filled by search. */
  refs: Map<string, I>
}

export type OpOutcome =
  | { ok: true; summary: string; toast: string; [key: string]: unknown }
  | { ok: false; error: string }

type Args = Record<string, unknown>
type Handler = (ctx: OpContext, a: Args) => OpOutcome | Promise<OpOutcome>
type Area = (typeof AGENT_AREAS)[number]
type AreaHandlers = { [A in Area as A['tool']]: { [K in keyof A['ops']]: Handler } }

const fail = (error: string): OpOutcome => ({ ok: false, error })
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** The deck slides `ids` name, or an error naming the unknown ones. */
function deckSlides(ctx: OpContext, ids: string[]): Slide[] | string {
  const byId = new Map(ctx.store.doc.slides.map((s) => [s.id, s]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) return `No deck slide ${missing.map((m) => `"${m}"`).join(', ')} (outline lists the slide ids).`
  return [...new Set(ids)].map((id) => byId.get(id)!)
}

const DECK: AreaHandlers['deck'] = {
  add(ctx, a) {
    const doc = ctx.store.doc
    const count = (a.count as number | undefined) ?? 1
    const names = (a.names as string[] | undefined) ?? []
    if (names.length > count) return fail(`names has ${names.length} entries for ${count} new slide(s).`)
    let at = doc.slides.length
    let front: Slide | undefined = doc.slides[doc.slides.length - 1]
    if (typeof a.after === 'string') {
      const i = doc.slides.findIndex((s) => s.id === a.after)
      if (i < 0) return fail(`No deck slide "${a.after}" (outline lists the slide ids).`)
      at = afterSlideBlock(doc.slides, i)
      front = doc.slides[i]
    }
    const parent = front?.stateOf ? doc.slides.find((s) => s.id === front!.stateOf) : front
    let layout: Slide | undefined
    let fromDoc = false
    if (typeof a.slideType === 'string') {
      layout = doc.layouts?.find((l) => l.id === a.slideType)
      fromDoc = !!layout
      layout ??= builtinLayouts(doc.size).find((l) => l.id === a.slideType)
      if (!layout) return fail(`Unknown slideType "${a.slideType}": use an id from doc_info.slideTypes or a built-in layout (${BUILTIN_SLIDE_TYPES.join(', ')}).`)
      if (layout.parentOnly) return fail(`Slide type "${a.slideType}" is a parent-only type: pick one of its children.`)
    } else {
      const linked = parent?.layoutId ? doc.layouts?.find((l) => l.id === parent.layoutId && !l.parentOnly) : undefined
      layout = linked ?? builtinLayouts(doc.size).find((l) => l.id === 'layout-title-content')!
      fromDoc = !!linked
    }
    const made = insertSlidesFromLayout(ctx.store, layout, at, count, fromDoc, (s, k) => { if (names[k]) s.name = names[k] })
    for (const s of made) ctx.created.add(s.id)
    const ids = made.map((s) => s.id)
    return {
      ok: true, slideIds: ids,
      summary: `Added ${plural(ids.length, 'slide')} (${layout.name ?? layout.id}) at position ${at}: ${ids.join(', ')}`,
      toast: t('AI added {n} slide(s)', { n: String(ids.length) }),
    }
  },

  duplicate(ctx, a) {
    const slides = deckSlides(ctx, a.slideIds as string[])
    if (typeof slides === 'string') return fail(slides)
    if (slides.length > MAX_SLIDES_PER_CALL) return fail(`At most ${MAX_SLIDES_PER_CALL} slides per call.`)
    const ids = duplicateSlidesInStore(ctx.store, slides.map((s) => s.id))
    for (const id of ids) ctx.created.add(id)
    return {
      ok: true, slideIds: ids,
      summary: `Duplicated ${plural(ids.length, 'slide')}: ${slides.map((s, k) => `${s.id} → ${ids[k]}`).join(', ')}`,
      toast: t('AI duplicated {n} slide(s)', { n: String(ids.length) }),
    }
  },

  delete(ctx, a) {
    const slides = deckSlides(ctx, a.slideIds as string[])
    if (typeof slides === 'string') return fail(slides)
    if (slides.length > MAX_SLIDES_PER_CALL) return fail(`At most ${MAX_SLIDES_PER_CALL} slides per call.`)
    const ids = slides.map((s) => s.id)
    if (a.userAsked !== true) {
      const foreign = ids.filter((id) => !ctx.created.has(id))
      if (foreign.length) return fail(`Refused: ${foreign.join(', ')} ${foreign.length === 1 ? 'was' : 'were'} not added by an agent in this session. Delete them only when the user asked for it (userAsked: true).`)
    }
    const impact = slidesDeleteImpact(ctx.store.doc, ids)
    if (!survivesDeletion(ctx.store.doc, impact.doomedIds)) return fail('Refused: a deck needs at least one slide.')
    if (!deleteSlidesByIds(ctx.store, ids)) return fail('Nothing was deleted.')
    for (const id of impact.doomedIds) ctx.created.delete(id)
    const them = ids.length === 1 ? 'it' : 'them'
    const states = impact.states.filter((s) => !ids.includes(s.id)).length
    const extra = [
      states ? `${plural(states, 'interactive state')} with ${them}` : '',
      impact.linkCount ? `${plural(impact.linkCount, 'link')} to ${them} cleared` : '',
      impact.zoomCount ? `${plural(impact.zoomCount, 'zoom tile')} removed` : '',
    ].filter(Boolean)
    return {
      ok: true,
      summary: `Deleted ${plural(ids.length, 'slide')}${extra.length ? ` (${extra.join('; ')})` : ''}. The user can undo it.`,
      toast: t('AI deleted {n} slide(s). Undo restores them.', { n: String(ids.length) }),
    }
  },

  move(ctx, a) {
    const doc = ctx.store.doc
    const slides = deckSlides(ctx, a.slideIds as string[])
    if (typeof slides === 'string') return fail(slides)
    const targets = ['before', 'after', 'to'].filter((k) => a[k] !== undefined)
    if (targets.length !== 1) return fail('Give exactly one of before, after, to.')
    const ids = slides.map((s) => s.id)
    let next
    if (a.to === 'start' || a.to === 'end') next = stepSlides(doc, ids, a.to)
    else {
      const ref = (a.before ?? a.after) as string
      if (ids.includes(ref)) return fail(`"${ref}" is one of the slides being moved.`)
      const tokens = tokensOf(doc)
      let k = tokens.findIndex((tk) => tk.kind === 'block' && tk.slides.some((s) => s.id === ref))
      if (k < 0) return fail(`No deck slide "${ref}" (outline lists the slide ids).`)
      if (a.after !== undefined) {
        k++
        // Past the extras run there: hidden slides after a normal one are ITS
        // extras, and a normal slide moved in front of them would take them over.
        if (slides.some(inLinearFlow)) while (tokens[k]?.kind === 'block' && !inLinearFlow((tokens[k] as { slides: Slide[] }).slides[0])) k++
      }
      next = moveSlidesTo(doc, ids, k)
    }
    if (!next) return { ok: true, summary: 'The slides are already there; nothing changed.', toast: '' }
    ctx.store.commit(() => { applyTokens(doc, next) }, 'slides')
    const order = doc.slides.map((s) => s.id)
    return {
      ok: true,
      summary: `Moved ${plural(ids.length, 'slide')}; they are now at position ${ids.map((id) => order.indexOf(id)).join(', ')}.`,
      toast: t('AI moved {n} slide(s)', { n: String(ids.length) }),
    }
  },

  hide(ctx, a) {
    const slides = deckSlides(ctx, a.slideIds as string[])
    if (typeof slides === 'string') return fail(slides)
    const hidden = a.hidden !== false
    ctx.store.commit(() => { for (const s of slides) { if (hidden) s.hidden = true; else delete s.hidden } }, 'slides')
    return {
      ok: true,
      summary: `${hidden ? 'Hid' : 'Showed'} ${plural(slides.length, 'slide')}.`,
      toast: hidden ? t('AI hid {n} slide(s)', { n: String(slides.length) }) : t('AI showed {n} slide(s)', { n: String(slides.length) }),
    }
  },

  rename(ctx, a) {
    const slides = deckSlides(ctx, [a.slideId as string])
    if (typeof slides === 'string') return fail(slides)
    const name = (a.name as string).trim()
    ctx.store.commit(() => { if (name) slides[0].name = name; else delete slides[0].name }, 'slides')
    return { ok: true, summary: name ? `Slide ${slides[0].id} is now named "${name}".` : `Slide ${slides[0].id} has no name now.`, toast: t('AI renamed a slide') }
  },

  transition(ctx, a) {
    const slides = deckSlides(ctx, a.slideIds as string[])
    if (typeof slides === 'string') return fail(slides)
    const kind = a.kind as TransitionKind
    const dirs = TRANSITION_DIRS[kind]
    if (a.dir !== undefined && !dirs?.includes(a.dir as TransitionDir)) {
      return fail(dirs ? `dir for ${kind} must be one of ${dirs.join('|')}.` : `${kind} has no direction; leave dir out.`)
    }
    ctx.store.commit(() => {
      for (const s of slides) {
        setSlideTransition(s, kind)
        if (a.dir !== undefined) s.transitionDir = a.dir as TransitionDir
      }
    })
    return {
      ok: true,
      summary: `Transition of ${plural(slides.length, 'slide')} set to ${kind}${a.dir ? ` (${a.dir})` : ''}.`,
      toast: t('AI set the transition of {n} slide(s)', { n: String(slides.length) }),
    }
  },

  background(ctx, a) {
    const slides = deckSlides(ctx, a.slideIds as string[])
    if (typeof slides === 'string') return fail(slides)
    const bg = cssColor(a.background, '', 200)
    if (!bg) return fail('background must be a CSS colour or gradient (no url(); pictures go in an image element).')
    ctx.store.commit(() => { for (const s of slides) s.background = bg })
    return {
      ok: true,
      summary: `Background of ${plural(slides.length, 'slide')} set to ${bg}.`,
      toast: t('AI set the background of {n} slide(s)', { n: String(slides.length) }),
    }
  },

  notes(ctx, a) {
    const slides = deckSlides(ctx, [a.slideId as string])
    if (typeof slides === 'string') return fail(slides)
    const s = slides[0]
    const text = (a.text as string).replace(/\r\n?/g, '\n')
    ctx.store.commit(() => { s.notes = a.append === true && s.notes.trim() ? `${s.notes.replace(/\s+$/, '')}\n${text}` : text })
    return { ok: true, summary: `Speaker notes of ${s.id} ${a.append === true ? 'extended' : 'set'} (${s.notes.length} characters).`, toast: t('AI edited the speaker notes') }
  },

  section_add(ctx, a) {
    const slides = deckSlides(ctx, [a.slideId as string])
    if (typeof slides === 'string') return fail(slides)
    const doc = ctx.store.doc
    if (doc.sections?.some((s) => s.startSlideId === slides[0].id)) return fail(`Slide ${slides[0].id} already starts a section.`)
    if (slides[0].stateOf) return fail('A section cannot start at an interactive state.')
    const section = insertSectionBefore(ctx.store, slides[0].id, (a.name as string).trim() || 'Section')
    return { ok: true, sectionId: section.id, summary: `Section "${section.name}" (${section.id}) starts at ${slides[0].id}.`, toast: t('AI changed the sections') }
  },

  section_rename(ctx, a) {
    const section = ctx.store.doc.sections?.find((s) => s.id === a.sectionId)
    if (!section) return fail(`No section "${a.sectionId}" (doc_info lists them).`)
    const name = (a.name as string).trim()
    if (!name) return fail('name must not be empty.')
    renameSection(ctx.store, section.id, name)
    return { ok: true, summary: `Section ${section.id} is now "${name}".`, toast: t('AI changed the sections') }
  },

  section_remove(ctx, a) {
    const section = ctx.store.doc.sections?.find((s) => s.id === a.sectionId)
    if (!section) return fail(`No section "${a.sectionId}" (doc_info lists them).`)
    deleteSection(ctx.store, section.id, { deleteSlides: false })
    return { ok: true, summary: `Section "${section.name}" removed; its slides stay.`, toast: t('AI changed the sections') }
  },

  state_add(ctx, a) {
    const slides = deckSlides(ctx, [a.slideId as string])
    if (typeof slides === 'string') return fail(slides)
    const src = slides[0]
    if (typeof a.linkFrom === 'string' && !src.elements.some((e) => e.id === a.linkFrom)) return fail(`No element "${a.linkFrom}" on ${src.id}.`)
    const state = addLinkedState(ctx.store, src.id, a.linkFrom as string | undefined, (a.name as string | undefined)?.trim())
    if (!state) return fail('The state could not be created.')
    ctx.created.add(state.id)
    return {
      ok: true, slideId: state.id,
      summary: `State ${state.id} ("${state.name}") of ${state.stateOf} added${a.linkFrom ? `; clicking ${a.linkFrom} opens it` : ''}. Change what differs on it with update_element (same element ids).`,
      toast: t('AI added an interactive state'),
    }
  },

  state_sync(ctx, a) {
    const r = syncStateWithParent(ctx.store, a.slideId as string)
    if (typeof r === 'string') return fail(r)
    return { ok: true, summary: `Synced: ${r.added} element(s) pulled in from the parent, ${r.kept} state-only element(s) kept.`, toast: t('AI synced an interactive state') }
  },

  hover(ctx, a) {
    const slides = deckSlides(ctx, [a.slideId as string])
    if (typeof slides === 'string') return fail(slides)
    const s = slides[0]
    const type = a.type as 'none' | 'focus-group' | 'reveal'
    if (type !== 'focus-group' && a.dim !== undefined) return fail('dim is for focus-group only.')
    if (type !== 'reveal' && a.revealDefault !== undefined) return fail('revealDefault is for reveal only.')
    ctx.store.commit(() => {
      if (type === 'none') { delete s.hover; return }
      const next: NonNullable<Slide['hover']> = { ...(s.hover ?? {}), type }
      if (type === 'focus-group') delete next.default
      else delete next.dim
      if (typeof a.dim === 'number') next.dim = a.dim
      if (typeof a.revealDefault === 'string') { if (a.revealDefault.trim()) next.default = a.revealDefault.trim(); else delete next.default }
      s.hover = next
    })
    const members = type === 'focus-group' ? s.elements.filter((e) => e.group).length : s.elements.filter((e) => e.showOnHover).length
    return {
      ok: true,
      summary: type === 'none' ? `Hover group switched off on ${s.id}.` : `${s.id} is a ${type} slide; ${members} element(s) take part (${type === 'focus-group' ? 'group' : 'showOnHover'} set with update_element).`,
      toast: t('AI changed a hover group'),
    }
  },

  properties(ctx, a) {
    const keys = ['title', 'author', 'company', 'subject', 'event', 'keywords', 'language'] as const
    const given = keys.filter((k) => typeof a[k] === 'string')
    if (!given.length) return fail(`Give at least one of ${keys.join(', ')}.`)
    if (a.title !== undefined && !(a.title as string).trim()) return fail('title must not be empty.')
    if (typeof a.language === 'string' && a.language.trim()) {
      try { a.language = Intl.getCanonicalLocales(a.language.trim())[0] } catch { return fail(`"${a.language}" is not a BCP-47 language code.`) }
    }
    const doc = ctx.store.doc
    ctx.store.commit(() => {
      for (const k of given) {
        const v = (a[k] as string).trim()
        if (k === 'title') { doc.title = v; continue }
        const meta = (doc.meta ??= {})
        if (v) meta[k] = v
        else delete meta[k]
      }
      if (doc.meta && !Object.keys(doc.meta).length) delete doc.meta
    })
    const langs = doc.terms?.languages ?? []
    const lang = doc.meta?.language
    const note = given.includes('language') && lang && langs.length && !langs.includes(lang)
      ? ` The terms table has no ${lang} column (it has ${langs.join(', ')}), so {{term:…}} falls back to ${langs[0]}.`
      : ''
    return { ok: true, summary: `Set ${given.join(', ')}.${note}`, toast: t('AI changed the document properties') }
  },
}

/** A font family an agent may set: a name list, nothing that could end the declaration. */
const FONT_RE = /^[^;{}<>\\]{1,100}$/

const SETTINGS: AreaHandlers['deck_settings'] = {
  theme(ctx, a) {
    const colourKeys = ['background', 'color', 'accent', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'] as const
    const given = colourKeys.filter((k) => a[k] !== undefined)
    if (!given.length && a.fontFamily === undefined && a.headingFamily === undefined) return fail('Give at least one colour or font.')
    const bad = given.filter((k) => !cssColor(a[k], '', 48))
    if (bad.length) return fail(`${bad.join(', ')}: not a CSS colour.`)
    if (a.fontFamily !== undefined && !FONT_RE.test((a.fontFamily as string).trim())) return fail('fontFamily must be a font name.')
    if (a.headingFamily !== undefined && a.headingFamily !== '' && !FONT_RE.test((a.headingFamily as string).trim())) return fail('headingFamily must be a font name, or "" for the body font.')
    const doc = ctx.store.doc
    const accentBefore = doc.theme.accent
    let moved = false
    ctx.store.commit(() => {
      const th = doc.theme
      for (const k of given) {
        const v = cssColor(a[k], '', 48)
        if (k === 'background' || k === 'color' || k === 'accent') th[k] = v
        else (th.palette ??= {})[k] = v
      }
      if (typeof a.fontFamily === 'string') th.fontFamily = a.fontFamily.trim()
      if (typeof a.headingFamily === 'string') { if (a.headingFamily.trim()) th.headingFamily = a.headingFamily.trim(); else delete th.headingFamily }
      // A stored chart palette was derived from the old accent: keep it in step.
      if (th.chartPalette?.length && th.accent !== accentBefore) th.chartPalette = deriveChartPalette(th.accent)
      // Colours picked from the palette follow, in the same undo step.
      moved = resolveThemeRefs(doc)
    })
    const p = paletteOf(doc)
    return {
      ok: true,
      summary: `Theme set: ${[...given, ...(a.fontFamily !== undefined ? ['fontFamily'] : []), ...(a.headingFamily !== undefined ? ['headingFamily'] : [])].join(', ')}. Palette now: ${Object.entries(p).map(([k, v]) => `${k} ${v}`).join(', ')}.${moved ? ' Elements using theme colours were updated.' : ''}`,
      toast: t('AI changed the theme'),
    }
  },

  size(ctx, a) {
    const doc = ctx.store.doc
    if (doc.kind === 'figure') return fail('This is a figure: its size is set in figure units in the app.')
    const preset = typeof a.preset === 'string' ? PAGE_SIZE_PRESETS[a.preset as keyof typeof PAGE_SIZE_PRESETS] : undefined
    if (preset && (a.width !== undefined || a.height !== undefined)) return fail('Give a preset or width/height, not both.')
    const width = preset ? preset.w : clampPageEdge((a.width as number | undefined) ?? doc.size.width)
    const height = preset ? preset.h : clampPageEdge((a.height as number | undefined) ?? doc.size.height)
    if (!preset && a.width === undefined && a.height === undefined) return fail('Give a preset or width and/or height.')
    const before = { ...doc.size }
    ctx.store.commit(() => { doc.size = { width, height } })
    const outside = doc.slides.filter((s) => s.elements.some((e) => e.x + e.w > width + 1 || e.y + e.h > height + 1)).map((s) => s.id)
    return {
      ok: true,
      summary: `Slide size ${before.width}x${before.height} → ${width}x${height}. Nothing was rescaled.${outside.length ? ` Elements now reach past the edge on ${outside.length} slide(s): ${outside.slice(0, 12).join(', ')}${outside.length > 12 ? ', …' : ''}.` : ''}`,
      toast: t('AI changed the slide size'),
    }
  },

  present(ctx, a) {
    const keys = ['counter', 'progress', 'arrows', 'numberHidden', 'loop', 'autoAdvance', 'morphSeconds']
    if (!keys.some((k) => a[k] !== undefined)) return fail(`Give at least one of ${keys.join(', ')}.`)
    ctx.store.commit(() => patchPresent(ctx.store.doc, {
      slideNumber: a.counter as boolean | undefined, progress: a.progress as boolean | undefined, controls: a.arrows as boolean | undefined,
      numberHidden: a.numberHidden as boolean | undefined, loop: a.loop as boolean | undefined,
      autoAdvance: a.autoAdvance as number | undefined, morphSeconds: a.morphSeconds as number | undefined,
    }))
    return { ok: true, summary: `Slideshow settings now: ${JSON.stringify(ctx.store.doc.present ?? {})} (absent = default).`, toast: t('AI changed the slideshow settings') }
  },

  slide_timing(ctx, a) {
    const slides = deckSlides(ctx, a.slideIds as string[])
    if (typeof slides === 'string') return fail(slides)
    const buildKeys = ['every', 'hold', 'buildLoop'].filter((k) => a[k] !== undefined)
    if (a.advanceAfter === undefined && a.autoBuild === undefined && !buildKeys.length) return fail('Give advanceAfter, autoBuild or its every/hold/buildLoop.')
    if (a.autoBuild === false && buildKeys.length) return fail('every/hold/buildLoop need autoBuild on.')
    const noAuto = slides.filter((s) => !s.autoBuild && a.autoBuild !== true)
    if (buildKeys.length && noAuto.length) return fail(`${noAuto.map((s) => s.id).join(', ')} ha${noAuto.length === 1 ? 's' : 've'} no auto-play: set autoBuild true too.`)
    ctx.store.commit(() => {
      for (const s of slides) {
        if (typeof a.advanceAfter === 'number') { if (a.advanceAfter > 0) s.advanceAfter = Math.min(a.advanceAfter, 86400); else delete s.advanceAfter }
        if (a.autoBuild === false) { delete s.autoBuild; continue }
        if (a.autoBuild === true || buildKeys.length) {
          const next = { ...(s.autoBuild ?? { every: 2, hold: 2, loop: true }) }
          if (typeof a.every === 'number') next.every = a.every
          if (typeof a.hold === 'number') next.hold = a.hold
          if (typeof a.buildLoop === 'boolean') next.loop = a.buildLoop
          if (!next.loop) delete next.loop
          if (!next.hold) delete next.hold
          s.autoBuild = next
        }
      }
    })
    return { ok: true, summary: `Timing set on ${plural(slides.length, 'slide')}.`, toast: t('AI changed the slide timing') }
  },

  header_footer(ctx, a) {
    const keys = ['date', 'dateText', 'showSlideNumber', 'showFooter', 'footerText', 'hideOnTitle']
    if (!keys.some((k) => a[k] !== undefined)) return fail(`Give at least one of ${keys.join(', ')}.`)
    if (a.dateText !== undefined && a.date !== 'fixed') return fail('dateText needs date "fixed".')
    commitHeaderFooter(ctx.store, (hf) => {
      if (a.date === 'off') hf.date = { ...(hf.date ?? {}), show: false }
      else if (a.date === 'live') { hf.date = { ...(hf.date ?? {}), show: true }; delete hf.date.fixed }
      else if (a.date === 'fixed') hf.date = { ...(hf.date ?? {}), show: true, fixed: (a.dateText as string | undefined)?.trim() || new Date().toLocaleDateString() }
      if (typeof a.showSlideNumber === 'boolean') hf.slideNumber = { ...(hf.slideNumber ?? {}), show: a.showSlideNumber }
      if (typeof a.showFooter === 'boolean') hf.footer = { ...(hf.footer ?? {}), show: a.showFooter }
      if (typeof a.footerText === 'string') hf.footer = { ...(hf.footer ?? {}), text: a.footerText.trim() }
      if (typeof a.hideOnTitle === 'boolean') hf.hideOnTitle = a.hideOnTitle
    })
    const inUse = footerRolesInUse(ctx.store.doc)
    const hf = ctx.store.doc.headerFooter ?? {}
    const wanted: FooterRole[] = (['date', 'slideNumber', 'footer'] as const).filter((r) => hf[r]?.show !== false)
    const missing = wanted.filter((r) => !inUse.has(r))
    return {
      ok: true,
      summary: `Header & footer now: ${JSON.stringify(hf)}.${missing.length ? ` No text box shows ${missing.join(', ')} yet: add them to a slide type with footer_elements.` : ''}`,
      toast: t('AI changed the header & footer'),
    }
  },

  footer_elements(ctx, a) {
    const doc = ctx.store.doc
    const layout = doc.layouts?.find((l) => l.id === a.slideType)
    if (!layout) return fail(`No slide type "${a.slideType}" (doc_info.slideTypes).`)
    const roles = [...new Set(a.roles as string[])]
    const badRole = roles.filter((r) => r !== 'date' && r !== 'slideNumber' && r !== 'footer')
    if (badRole.length) return fail(`roles must be date, slideNumber or footer (got ${badRole.join(', ')}).`)
    const has = new Set(layout.elements.flatMap((e) => (e.type === 'text' && e.footerRole ? [e.footerRole] : [])))
    const add = (roles as FooterRole[]).filter((r) => !has.has(r))
    if (!add.length) return { ok: true, summary: `${layout.name ?? layout.id} already has ${roles.join(', ')}.`, toast: '' }
    const known = layoutElementIds(doc) // before the insert: what linked slides already know
    const made = add.map((r) => footerElement(doc, r, layout.background))
    ctx.store.commit(() => {
      layout.elements.push(...made)
      resyncLinkedSlides(doc, layout.id, known)
    })
    return {
      ok: true, elementIds: made.map((e) => e.id),
      summary: `Added ${add.join(', ')} to slide type ${layout.name ?? layout.id} (${made.map((e) => e.id).join(', ')}); its slides show them.`,
      toast: t('AI added footer boxes to a slide type'),
    }
  },

  slide_footer(ctx, a) {
    const slides = deckSlides(ctx, a.slideIds as string[])
    if (typeof slides === 'string') return fail(slides)
    ctx.store.commit(() => { for (const s of slides) setSlideFooterVisible(s, a.role as FooterRole, a.visible as boolean) })
    const deckOff = ctx.store.doc.headerFooter?.[a.role as FooterRole]?.show === false
    return {
      ok: true,
      summary: `${a.role} ${a.visible ? 'shown' : 'hidden'} on ${plural(slides.length, 'slide')}.${deckOff && a.visible ? ' It is still switched off deck-wide (header_footer).' : ''}`,
      toast: t('AI changed the footer of {n} slide(s)', { n: String(slides.length) }),
    }
  },

  layout_grid(ctx, a) {
    const doc = ctx.store.doc
    const keys = ['columns', 'rows', 'gutter', 'marginX', 'marginY'] as const
    if (!keys.some((k) => a[k] !== undefined)) return fail(`Give at least one of ${keys.join(', ')}.`)
    if (a.columns === 0) {
      if (!doc.layoutGrid) return { ok: true, summary: 'The deck has no layout grid; nothing to remove.', toast: '' }
      ctx.store.commit(() => { delete doc.layoutGrid })
      return { ok: true, summary: 'Layout grid removed.', toast: t('AI changed the layout grid') }
    }
    const base = normalizeLayoutGrid(doc.layoutGrid, doc.size) ?? defaultLayoutGrid(doc.size)
    const next = normalizeLayoutGrid({ ...base, ...Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) }, doc.size)
    if (!next) return fail('That grid has no columns.')
    ctx.store.commit(() => { doc.layoutGrid = next })
    const cols = layoutTracks(next, doc.size).columns
    return {
      ok: true,
      summary: `Layout grid: ${plural(next.columns, 'column')}${next.rows ? ` × ${plural(next.rows, 'row')}` : ''}, gutter ${next.gutter}, margins ${next.marginX}/${next.marginY}. Columns (x, w): ${cols.map((c) => `${c.start},${c.size}`).join(' ')}.`,
      toast: t('AI changed the layout grid'),
    }
  },

  numbering(ctx, a) {
    const slides = deckSlides(ctx, a.slideIds as string[])
    if (typeof slides === 'string') return fail(slides)
    const states = slides.filter((s) => s.stateOf)
    if (states.length) return fail(`${states.map((s) => s.id).join(', ')} ${states.length === 1 ? 'is an interactive state' : 'are interactive states'}: states are never numbered.`)
    ctx.store.commit(() => { for (const s of slides) { if (a.exclude) s.excludeFromNumbering = true; else delete s.excludeFromNumbering } }, 'slides')
    return { ok: true, summary: `${plural(slides.length, 'slide')} ${a.exclude ? 'left out of the numbering' : 'counted in the numbering again'}.`, toast: t('AI changed the slide numbering') }
  },
}

/** Refs handed out per session before the oldest are forgotten. */
const MAX_ICON_REFS = 2000

const ICONS: AreaHandlers['icons'] = {
  async search(ctx, a) {
    const lib = ctx.icons
    if (!lib) return fail('No icon library here (it needs the editor). Draw simple shapes instead.')
    const query = (a.query as string).trim()
    const limit = (a.limit as number | undefined) ?? 12
    let found: AgentIcon[]
    let notes: string[]
    try { ({ icons: found, notes } = await lib.search(query)) } catch (e) {
      return fail(`The icon library could not be searched: ${e instanceof Error ? e.message : String(e)} Tell the user (Settings ▸ Icon library has a Test button); meanwhile use simple shapes, not hand-drawn SVG.`)
    }
    const shown = found.slice(0, Math.min(limit, MAX_ICON_RESULTS))
    const unreachable = notes.length ? `\nNot searched: ${notes.join(' / ')}` : ''
    if (!shown.length) return { ok: true, refs: [], summary: `No icons for "${query}". Try a shorter or more general word (or a synonym).${unreachable}`, toast: '' }
    const manySources = new Set(shown.map((i) => i.source)).size > 1
    if (lib.refs.size + shown.length > MAX_ICON_REFS) lib.refs.clear()
    const refs: string[] = []
    const lines = shown.map((icon) => {
      const ref = `i${lib.refs.size + 1}`
      lib.refs.set(ref, icon)
      refs.push(ref)
      const name = icon.name.replace(/\.(svg|png|jpe?g|webp|gif)$/i, '')
      const more = [icon.category, icon.description].filter(Boolean).join(' — ')
      const license = icon.provenance?.license
      return `${ref} "${name}"${more ? ` (${more})` : ''} [${icon.ext || '?'}${manySources && icon.source ? `, ${icon.source}` : ''}, ${license ? `license: ${license}` : 'license unknown'}]`
    })
    return {
      ok: true, refs,
      summary: `${shown.length}${found.length > shown.length ? ` of ${found.length}+` : ''} icon(s) for "${query}":\n${lines.join('\n')}\nInsert one with op "insert" {slideId, ref, x, y, size}.${unreachable}`,
      toast: '',
    }
  },

  async insert(ctx, a) {
    const lib = ctx.icons
    if (!lib) return fail('No icon library here (it needs the editor).')
    const icon = lib.refs.get(a.ref as string)
    if (!icon) return fail(`No icon "${a.ref}": use a ref from a search in this session.`)
    const size = (a.size as number | undefined) ?? 96
    const { width, height } = ctx.store.doc.size
    const x = (a.x as number | undefined) ?? Math.round(width / 2 - size / 2)
    const y = (a.y as number | undefined) ?? Math.round(height / 2 - size / 2)
    const r = await lib.insert(a.slideId as string, icon, { x, y, w: size, h: size }, typeof a.alt === 'string' ? a.alt : '')
    if ('error' in r) return fail(r.error)
    return {
      ok: true, elementId: r.elementId,
      summary: `Inserted icon "${icon.name}" as ${r.elementId} on ${a.slideId} at ${x},${y} (${size}x${size}).`,
      toast: t('AI inserted an icon'),
    }
  },
}

// ---- elements ------------------------------------------------------------------

/** The slide `slideId` names (deck slide, slide type or reusable object). */
function targetSlide(ctx: OpContext, slideId: string): Slide | string {
  return resolveAgentSlide(ctx.store.doc, slideId)?.slide ?? `No slide "${slideId}" (outline lists deck slides, doc_info the slide types).`
}

const writes = (ctx: OpContext) => ctx.writes ?? plainWrites(ctx.store)
const FRAME_KEYS = new Set(['x', 'y', 'w', 'h', 'rotation'])
const MAX_LINES = 10

/** What every element write answers with: what it did, what the app fixed
 *  around it, and whether the slide is clean now — so the model does not
 *  need a review call just to find out. */
function writeReport(ctx: OpContext, slideId: string, did: string[], guard: GuardResult | null, around: string[]): string {
  const lines = [...did]
  const adjusted = guard?.adjusted ?? []
  if (adjusted.length) {
    lines.push(`↻ The app also (same undo step): ${adjusted.slice(0, MAX_LINES).map((a) => a.message).join('; ')}${adjusted.length > MAX_LINES ? `; … ${adjusted.length - MAX_LINES} more` : ''}.`)
  }
  const touched = [...new Set([...around, ...adjusted.map((a) => a.element)])]
  const issues = writes(ctx).check(slideId, touched.length ? touched : undefined)
  const seen = new Set(issues.map((i) => i.message))
  for (const i of guard?.issues ?? []) if (i.code !== 'text-overflow' && !seen.has(i.message)) { issues.push(i); seen.add(i.message) }
  if (!issues.length) lines.push('✓ Layout clean around these elements (no overlaps, overflowing or off-canvas text).')
  else {
    lines.push(`⚠ ${plural(issues.length, 'layout issue')}:`)
    for (const i of issues.slice(0, MAX_LINES)) lines.push(`  - ${i.message}${i.suggest ? ` (suggested frame ${fmt(i.suggest)})` : ''}`)
    if (issues.length > MAX_LINES) lines.push(`  … ${issues.length - MAX_LINES} more (check_layout lists all)`)
  }
  return lines.join('\n')
}

/** One validated `edit` change, ready to apply. */
type Change = { el: SlideElement; set: Record<string, unknown>; unset: string[]; remove: boolean }

/** Checks one `changes` entry against its element. A message on failure. */
function parseChange(doc: SlidomingoDoc, slide: Slide, raw: Record<string, unknown>, k: number): Change | string {
  const at = `changes[${k}]`
  const id = raw.id
  if (typeof id !== 'string' || !id) return `${at}: needs the element id ("id").`
  const el = slide.elements.find((e) => e.id === id)
  if (!el) return `${at}: no element "${id}" on ${slide.id}.`
  if (raw.delete === true) {
    const others = Object.keys(raw).filter((key) => key !== 'id' && key !== 'delete')
    return others.length ? `${at}: a delete takes nothing else (got ${others.join(', ')}).` : { el, set: {}, unset: [], remove: true }
  }
  // flat props, or nested under set/frame — both read the same
  const props: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(raw)) {
    if (key === 'id' || key === 'delete') continue
    if ((key === 'set' || key === 'frame' || key === 'props') && v && typeof v === 'object' && !Array.isArray(v)) Object.assign(props, v)
    else props[key] = v
  }
  if (!Object.keys(props).length) return `${at}: nothing to change on "${id}" (give props, or delete:true).`
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'type') return `${at}: an element's type cannot change.`
    if (value === null || (key === 'crop' && el.type === 'image' && isWholePictureCrop(value))) {
      if ((REQUIRED_KEYS[el.type] ?? []).includes(key)) return `${at}: ${key} is required on a ${el.type} element.`
      unset.push(key)
      continue
    }
    const check = checkElementProp(el.type, key, value)
    if (!check.ok) return `${at}: ${FRAME_KEYS.has(key) ? `invalid ${key}` : `invalid or unknown prop "${key}" for a ${el.type} element`}.`
    let val = check.value
    if (key === 'html') val = sanitizeHtml(val as string)
    if (key === 'rows' && Array.isArray(val)) for (const row of val as TableElement['rows']) for (const cell of row.cells ?? []) cell.html = sanitizeHtml(cell.html ?? '')
    set[key] = val
  }
  const svg = agentSvgPatchViolation(doc, el, set)
  if (svg) return `${at}: ${svg}`
  return { el, set, unset, remove: false }
}

/** "Freed …" for the result of a delete, when it left a big empty area. */
function freedNote(ctx: OpContext, slide: Slide, removed: Frame[]): string[] {
  const freed = freedRegion(ctx.store.doc, slide, removed)
  if (!freed) return []
  return [`Freed ${fmt(freed)}: that area is empty now. Unless the space is wanted, rebalance what is left in one call: elements {op:"arrange", elementIds:[the remaining cards], as:"grid"|"row", within:"space"}.`]
}

/** Units for a layout op, or the message why not. */
function unitsFor(ctx: OpContext, slide: Slide, ids: string[], min: number, what: string): Unit[] | string {
  const { units, missing, skipped } = buildUnits(ctx.store.doc, slide, ids)
  if (missing.length) return `No element ${missing.map((m) => `"${m}"`).join(', ')} on ${slide.id}.`
  if (units.length < min) return `${what} needs at least ${min} separate items; got ${units.length}${skipped.length ? ` (lines ${skipped.join(', ')} are not moved: they follow their boxes)` : ''}${units.length < ids.length - skipped.length ? ' (elements inside another picked box move with it)' : ''}.`
  return units
}

const unitLine = (u: Unit, f: Frame) => `${u.lead.id} → ${fmt(f)}${u.members.length > 1 ? ` (+${u.members.length - 1} inside)` : ''}`

/** Moves the units to `frames` (and their companions along) as one placed
 *  write and reports. */
function placeUnits(ctx: OpContext, slideId: string, units: Unit[], frames: Frame[], head: string, companions: Companion[] = []): OpOutcome {
  const ids = [...units.flatMap((u) => u.members.map((m) => m.id)), ...companions.map((c) => c.el.id)]
  const oldGroup = unionFrame(units.map((u) => u.box))
  const guard = writes(ctx).commit(slideId, () => {
    applyUnitFrames(units, frames)
    if (companions.length) placeCompanions(companions, oldGroup, unionFrame(frames))
  }, { reflow: true, placed: true })
  const lines = [head, ...units.slice(0, 30).map((u, i) => `  ${unitLine(u, frames[i])}`)]
  if (units.length > 30) lines.push(`  … ${units.length - 30} more`)
  if (companions.length) lines.push(`  kept with them: ${companions.map((c) => `${c.el.id} (${c.side}) → ${fmt(c.el)}`).join(', ')}`)
  return { ok: true, summary: writeReport(ctx, slideId, lines, guard, ids), toast: t('AI arranged {n} element(s)', { n: String(units.length) }) }
}

/** The units' common box, the slide's content margins, or an element. */
function referenceBox(ctx: OpContext, slide: Slide, units: Unit[], to: string | undefined): Frame | string {
  const doc = ctx.store.doc
  if (to === undefined || to === 'selection') {
    if (units.length > 1 || to === 'selection') return unionBox(units)
    to = 'slide'
  }
  if (to === 'slide') {
    const m = contentMargin(doc, slide)
    return { x: m, y: m * 0.75, w: doc.size.width - 2 * m, h: doc.size.height - 1.5 * m }
  }
  const el = slide.elements.find((e) => e.id === to)
  return el ? { x: el.x, y: el.y, w: el.w, h: el.h } : `to must be "selection", "slide" or an element id on ${slide.id} (got "${to}").`
}

function unionBox(units: Unit[]): Frame {
  const x0 = Math.min(...units.map((u) => u.box.x)), y0 = Math.min(...units.map((u) => u.box.y))
  const x1 = Math.max(...units.map((u) => u.box.x + u.box.w)), y1 = Math.max(...units.map((u) => u.box.y + u.box.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const median = (vs: number[]) => [...vs].sort((a, b) => a - b)[Math.floor((vs.length - 1) / 2)]

const ELEMENTS: AreaHandlers['elements'] = {
  edit(ctx, a) {
    const slide = targetSlide(ctx, a.slideId as string)
    if (typeof slide === 'string') return fail(slide)
    const raw = a.changes as Record<string, unknown>[]
    if (!raw.length) return fail('changes must not be empty.')
    if (raw.length > MAX_ELEMENT_CHANGES) return fail(`At most ${MAX_ELEMENT_CHANGES} changes per call.`)
    const changes: Change[] = []
    for (let k = 0; k < raw.length; k++) {
      const c = parseChange(ctx.store.doc, slide, raw[k], k)
      if (typeof c === 'string') return fail(`${c} Nothing was changed.`)
      changes.push(c)
    }
    const removed = changes.filter((c) => c.remove)
    if (new Set(removed.map((c) => c.el.id)).size !== removed.length || changes.some((c) => !c.remove && removed.some((r) => r.el === c.el))) {
      return fail('An element is deleted and also changed (or deleted twice) in the same call. Nothing was changed.')
    }
    const removedFrames = removed.filter((c) => !c.el.hidden).map((c) => ({ x: c.el.x, y: c.el.y, w: c.el.w, h: c.el.h }))
    const gone = new Set(removed.map((c) => c.el))
    const guard = writes(ctx).commit(slide.id, (s) => {
      for (const c of changes) {
        if (c.remove) continue
        const el = c.el as unknown as Record<string, unknown>
        Object.assign(el, c.set)
        for (const key of c.unset) delete el[key]
      }
      if (gone.size) s.elements = s.elements.filter((e) => !gone.has(e))
    }, { reflow: a.reflow !== false })
    const edited = changes.filter((c) => !c.remove)
    const moved = edited.filter((c) => Object.keys(c.set).some((k) => FRAME_KEYS.has(k))).length
    const did = [
      `Applied ${plural(changes.length, 'change')} on ${slide.id} as one undo step: ${[
        edited.length ? `${edited.length} edited${moved ? ` (${moved} moved/resized)` : ''}` : '',
        removed.length ? `${removed.length} deleted (${removed.map((c) => c.el.id).join(', ')})` : '',
      ].filter(Boolean).join(', ')}.`,
      ...freedNote(ctx, slide, removedFrames),
    ]
    return { ok: true, summary: writeReport(ctx, slide.id, did, guard, edited.map((c) => c.el.id)), toast: t('AI edited {n} element(s)', { n: String(changes.length) }) }
  },

  delete(ctx, a) {
    const slide = targetSlide(ctx, a.slideId as string)
    if (typeof slide === 'string') return fail(slide)
    const ids = [...new Set(a.elementIds as string[])]
    const missing = ids.filter((id) => !slide.elements.some((e) => e.id === id))
    if (missing.length) return fail(`No element ${missing.map((m) => `"${m}"`).join(', ')} on ${slide.id}. Nothing was deleted.`)
    const gone = new Set(ids)
    const removedFrames = slide.elements.filter((e) => gone.has(e.id) && !e.hidden).map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }))
    // arrows that pointed at a deleted box keep their spot, unbound
    const guard = writes(ctx).commit(slide.id, (s) => {
      s.elements = s.elements.filter((e) => !gone.has(e.id))
      for (const e of s.elements) {
        if (e.type !== 'shape') continue
        const sh = e as ShapeElement
        if (sh.from && gone.has(sh.from.el)) delete sh.from
        if (sh.to && gone.has(sh.to.el)) delete sh.to
      }
    }, { reflow: true })
    const did = [`Deleted ${plural(ids.length, 'element')} from ${slide.id} (one undo step): ${ids.join(', ')}.`, ...freedNote(ctx, slide, removedFrames)]
    return { ok: true, summary: writeReport(ctx, slide.id, did, guard, []), toast: t('AI deleted {n} element(s)', { n: String(ids.length) }) }
  },

  arrange(ctx, a) {
    const doc = ctx.store.doc
    const slide = targetSlide(ctx, a.slideId as string)
    if (typeof slide === 'string') return fail(slide)
    const units = unitsFor(ctx, slide, a.elementIds as string[], 1, 'arrange')
    if (typeof units === 'string') return fail(units)
    const as = a.as as 'row' | 'column' | 'grid'
    const explicit = ['x', 'y', 'w', 'h'].filter((k) => a[k] !== undefined)
    if (explicit.length && explicit.length < 4) return fail('An explicit region needs all of x, y, w, h.')
    if (explicit.length && a.within !== undefined) return fail('Give within or x/y/w/h, not both.')
    const within = explicit.length ? 'region' : ((a.within as string | undefined) ?? 'bounds')
    const gapGiven = a.gap as number | undefined
    const gap = gapGiven ?? currentGap(doc, units)
    const members = new Set(units.flatMap((u) => u.members.map((m) => m.id)))
    // a legend/caption hugging the group travels with it when it moves elsewhere
    const companions = within === 'bounds' ? [] : companionsOf(doc, slide, units, gap)
    let region: Frame
    if (within === 'region') region = { x: a.x as number, y: a.y as number, w: a.w as number, h: a.h as number }
    else if (within === 'bounds') region = unionBox(units)
    else if (within === 'space') {
      // lift the items out (with the arrows bound to them) and take the biggest hole
      const exclude = new Set([...members, ...companions.map((c) => c.el.id)])
      for (const e of slide.elements) {
        const sh = e as ShapeElement
        if (e.type === 'shape' && ((sh.from && members.has(sh.from.el)) || (sh.to && members.has(sh.to.el)))) exclude.add(e.id)
      }
      const hole = largestEmptyRect(doc, slide, exclude, gap)
      if (!hole) return fail('There is no free space on the slide for them; give an explicit region (x, y, w, h).')
      region = hole
    } else if (parseSpan(within)) {
      const grid = normalizeLayoutGrid(doc.layoutGrid, doc.size)
      if (!grid) return fail('The deck has no layout grid yet: set one with deck_settings {op:"layout_grid"}, or give x, y, w, h.')
      const span = parseSpan(within)!
      region = spanRect(grid, doc.size, span.cols, span.rows)
    } else {
      const box = slide.elements.find((e) => e.id === within)
      if (!box) return fail(`within must be "bounds", "space", "columns A-B", an element id on ${slide.id}, or use x/y/w/h (got "${within}").`)
      if (members.has(box.id)) return fail(`"${box.id}" is one of the items being arranged; it cannot also be the region.`)
      region = { x: box.x + gap, y: box.y + gap, w: box.w - 2 * gap, h: box.h - 2 * gap }
    }
    if (companions.length) {
      const room = companionRoom(companions)
      region = { x: region.x + room.left, y: region.y + room.above, w: region.w - room.left - room.right, h: region.h - room.above - room.below }
      if (region.w < 16 || region.h < 16) return fail(`No room left for them next to ${companions.map((c) => c.el.id).join(', ')}; give an explicit region (x, y, w, h).`)
    }
    // in place, a row/column keeps its two ends: the gap is what spans them
    let useGap = gap
    if (within === 'bounds' && gapGiven === undefined && units.length > 1 && as !== 'grid') {
      const axisLen = as === 'row' ? region.w : region.h
      const sum = units.reduce((s, u) => s + (as === 'row' ? u.box.w : u.box.h), 0)
      if (axisLen - sum >= 0) useGap = (axisLen - sum) / (units.length - 1)
    }
    const mw = median(units.map((u) => u.box.w)), mh = median(units.map((u) => u.box.h))
    const nearlyEqual = units.every((u) => Math.abs(u.box.w - mw) <= mw * 0.15 && Math.abs(u.box.h - mh) <= mh * 0.15)
    const size = (a.size as 'fill' | 'equal' | 'keep' | undefined) ?? (within === 'bounds' ? (nearlyEqual ? 'equal' : 'keep') : 'fill')
    if (size === 'equal' && within === 'bounds' && as !== 'grid' && gapGiven === undefined && units.length > 1) {
      const axisLen = as === 'row' ? region.w : region.h
      useGap = Math.max(0, (axisLen - (as === 'row' ? mw : mh) * units.length) / (units.length - 1))
    }
    const sized = size === 'equal' ? units.map((u) => ({ ...u, box: { ...u.box, w: mw, h: mh } })) : units
    const plan = planArrange(doc, sized, {
      as, cols: a.cols as number | undefined, gap: useGap,
      size: size === 'fill' ? 'fill' : 'keep',
      align: (a.align as 'start' | 'center' | 'end' | undefined) ?? 'start',
      region,
    })
    const shape = as === 'grid' ? `a ${plan.rows}x${plan.cols} grid${plan.rows * plan.cols > units.length ? ` (last row ${units.length - (plan.rows - 1) * plan.cols})` : ''}` : `a ${as}`
    const head = `Arranged ${plural(units.length, 'item')} as ${shape} in ${within === 'space' ? 'the free space ' : ''}${fmt(region)}, gap ${Math.round(plan.gap)}, size ${size}:${plan.notes.length ? `\nNote: ${plan.notes.join('; ')}.` : ''}`
    return placeUnits(ctx, slide.id, units, plan.frames, head, companions)
  },

  align(ctx, a) {
    const slide = targetSlide(ctx, a.slideId as string)
    if (typeof slide === 'string') return fail(slide)
    const units = unitsFor(ctx, slide, a.elementIds as string[], 1, 'align')
    if (typeof units === 'string') return fail(units)
    const ref = referenceBox(ctx, slide, units, a.to as string | undefined)
    if (typeof ref === 'string') return fail(ref)
    const frames = planAlign(units, a.edge as Edge, ref)
    return placeUnits(ctx, slide.id, units, frames, `Aligned ${plural(units.length, 'item')} (${a.edge}) to ${fmt(ref)}:`)
  },

  distribute(ctx, a) {
    const slide = targetSlide(ctx, a.slideId as string)
    if (typeof slide === 'string') return fail(slide)
    const gap = a.gap as number | undefined
    const units = unitsFor(ctx, slide, a.elementIds as string[], gap === undefined ? 3 : 2, 'distribute')
    if (typeof units === 'string') return fail(units)
    const axis = a.axis as 'x' | 'y'
    const frames = planDistribute(units, axis, gap)
    return placeUnits(ctx, slide.id, units, frames, `Distributed ${plural(units.length, 'item')} along ${axis}${gap !== undefined ? ` at ${gap}px` : ' (first and last kept)'}:`)
  },

  match_size(ctx, a) {
    const slide = targetSlide(ctx, a.slideId as string)
    if (typeof slide === 'string') return fail(slide)
    const units = unitsFor(ctx, slide, a.elementIds as string[], 2, 'match_size')
    if (typeof units === 'string') return fail(units)
    const to = (a.to as string | undefined) ?? 'largest'
    const ws = units.map((u) => u.box.w), hs = units.map((u) => u.box.h)
    const avg = (vs: number[]) => vs.reduce((s, v) => s + v, 0) / vs.length
    let ref: { w: number; h: number }
    if (to === 'largest') ref = { w: Math.max(...ws), h: Math.max(...hs) }
    else if (to === 'smallest') ref = { w: Math.min(...ws), h: Math.min(...hs) }
    else if (to === 'average') ref = { w: avg(ws), h: avg(hs) }
    else if (to === 'first') ref = units[0].box
    else {
      const el = slide.elements.find((e) => e.id === to)
      if (!el) return fail(`to must be largest, smallest, average, first or an element id on ${slide.id} (got "${to}").`)
      ref = { w: el.w, h: el.h }
    }
    const frames = planMatchSize(units, a.dim as 'w' | 'h' | 'both', ref)
    return placeUnits(ctx, slide.id, units, frames, `Matched ${a.dim === 'both' ? 'size' : a.dim === 'w' ? 'width' : 'height'} of ${plural(units.length, 'item')} (${to}):`)
  },
}

const AREA_HANDLERS: AreaHandlers = { deck: DECK, deck_settings: SETTINGS, icons: ICONS, elements: ELEMENTS }

/** Whether `verb` names an op area (a grouped tool such as `deck`). */
export const isAreaTool = (verb: string | undefined): boolean => AGENT_AREAS.some((a) => a.tool === verb)

/** Runs one `{op, …}` call of an area tool. Never throws (nor rejects).
 *  Synchronous for every op but the ones that wait on the network (icons). */
export function runAreaOp(verb: string, args: Args, ctx: OpContext): OpOutcome | Promise<OpOutcome> {
  const area = AGENT_AREAS.find((a) => a.tool === verb)
  if (!area) return fail(`Unknown tool ${verb}.`)
  const op = typeof args.op === 'string' ? args.op : ''
  args = normalizeArgs(area, op, args)
  const problem = checkArgs(area, op, args)
  if (problem) return fail(problem)
  const { op: _op, ...rest } = args
  const handlers = AREA_HANDLERS[area.tool] as Record<string, Handler>
  const failed = (e: unknown) => fail(`${verb} ${op} failed: ${e instanceof Error ? e.message : String(e)}`)
  try {
    const r = handlers[op](ctx, rest)
    return r instanceof Promise ? r.catch(failed) : r
  } catch (e) { return failed(e) }
}

/** doc_info's `sections`: what section ops address. */
export const sectionRows = (store: Store): Array<{ id: string; name: string; startSlideId: string }> =>
  sectionsInOrder(store.doc).map((s) => ({ id: s.id, name: s.name, startSlideId: s.startSlideId }))
