// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The slide-type and reusable-object verbs of the agent-action channel
// (editor.ts applyAgentAction → ./index.ts AGENT_VERBS): the agent-facing
// counterparts to the Layout Manager's and context menu's own actions, each
// through the same model functions, in one store.commit.
import { t } from '../../i18n'
import {
  createReusableObject, createSlideTypeAsBasis, createSlideTypeAsParentChild, createSlideTypeBlank, detachSlideType,
  isDescendantOf, layoutElementIds, moveSlideTypeInTree, relinkSlide, resolveAgentSlide, resyncLinkedSlides,
  type RelinkPreview, type Slide, type SlideElement,
} from '../../model'
import { moveLayoutWithinParent, remintElements } from '../layoutmanager'
import { promoteToReusableObject } from '../reusableobjects'
import type { AgentVerbHandler } from './context'

export const SLIDE_TYPE_VERBS = {
  create_reusable_object: (ctx, cmd) => {
    const { args, respond } = cmd
    // Same mint-and-append code the "+ New reusable object" button calls
    // (layoutmanager.ts's newReusableObject) — see model.ts's
    // createReusableObject doc comment.
    const name = typeof args.name === 'string' ? args.name.trim() : undefined
    let obj: Slide | undefined
    ctx.store.commit(() => {
      obj = createReusableObject(ctx.store.doc)
      if (name) obj.name = name
    })
    ctx.toast(t('Claude Code created a new reusable object'))
    respond({ requestId: cmd.requestId, ok: true, objectId: obj!.id })
    return
  },
  create_slide_type: (ctx, cmd) => {
    const { args, respond } = cmd
    // Agent-facing counterpart to the "+ New slide type" dialog
    // (layoutmanager.ts's openNewSlideTypeDialog) — same three mint
    // functions, same rule that a slide type always needs a real name
    // and is based on another slide type or blank, never a built-in.
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing or empty name — slide types require a real name.' }); return }
    const mode = args.mode
    if (mode !== 'blank' && mode !== 'parent' && mode !== 'basis') {
      respond({ requestId: cmd.requestId, ok: false, error: 'mode must be one of "blank", "parent", "basis".' })
      return
    }
    let source: Slide | undefined
    if (mode !== 'blank') {
      const sourceId = typeof args.sourceId === 'string' ? args.sourceId : undefined
      source = sourceId ? ctx.store.doc.layouts?.find((l) => l.id === sourceId) : undefined
      if (!source) { respond({ requestId: cmd.requestId, ok: false, error: `No slide type with id "${sourceId}" to base this on.` }); return }
    }
    let layout!: Slide
    ctx.store.commit(() => {
      if (mode === 'parent') layout = createSlideTypeAsParentChild(ctx.store.doc, source!, name)
      else if (mode === 'basis') layout = createSlideTypeAsBasis(ctx.store.doc, source!, name, remintElements)
      else layout = createSlideTypeBlank(ctx.store.doc, name)
    })
    ctx.toast(t('Claude Code created a new slide type “{name}”', { name }))
    respond({ requestId: cmd.requestId, ok: true, layoutId: layout.id })
    return
  },
  rename_slide_type: (ctx, cmd) => {
    const { args, respond } = cmd
    const layoutId = typeof args.layoutId === 'string' ? args.layoutId : undefined
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!layoutId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing layoutId.' }); return }
    if (!name) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing or empty name — slide types require a real name.' }); return }
    const layout = ctx.store.doc.layouts?.find((l) => l.id === layoutId)
    if (!layout) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide-type' }); return }
    ctx.store.commit(() => { layout.name = name })
    ctx.toast(t('Claude Code renamed a slide type to “{name}”', { name }))
    respond({ requestId: cmd.requestId, ok: true })
    return
  },
  reorder_slide_type: (ctx, cmd) => {
    const { args, respond } = cmd
    // `to` is an index among SIBLINGS (children of the same parent, or
    // the top-level roots) — the same list moveLayoutWithinParent's UI
    // caller (the tree's own card grid) operates on, not the flat
    // doc.layouts array. Out-of-range `to` is clamped by moveItem
    // (layoutmanager.ts), matching the UI's own drag/reorder behavior.
    const layoutId = typeof args.layoutId === 'string' ? args.layoutId : undefined
    const to = typeof args.to === 'number' ? args.to : undefined
    if (!layoutId || to === undefined) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing layoutId or to.' }); return }
    const doc = ctx.store.doc
    const layout = doc.layouts?.find((l) => l.id === layoutId)
    if (!layout) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide-type' }); return }
    const parentId = layout.parentId
    const siblings = (doc.layouts ?? []).filter((l) => (l.parentId ?? undefined) === (parentId ?? undefined))
    const from = siblings.findIndex((l) => l.id === layoutId)
    ctx.store.commit(() => { moveLayoutWithinParent(doc, parentId, from, to) })
    ctx.toast(t('Claude Code reordered a slide type'))
    respond({ requestId: cmd.requestId, ok: true })
    return
  },
  move_slide_type: (ctx, cmd) => {
    const { args, respond } = cmd
    // Agent-facing counterpart to the Layout Manager sidebar's drag-and-
    // drop (typetree.ts): reorder AND/OR reparent. `parentId: null`
    // makes it a root. Reparenting means "inherit from the new parent"
    // (the look changes); the moved subtree's linked slides resync in
    // the same commit, exactly like the UI drop.
    const layoutId = typeof args.layoutId === 'string' ? args.layoutId : undefined
    if (!layoutId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing layoutId.' }); return }
    if (args.parentId !== null && typeof args.parentId !== 'string') {
      respond({ requestId: cmd.requestId, ok: false, error: 'parentId must be a slide type id, or null for a top-level slide type.' })
      return
    }
    const parentId = typeof args.parentId === 'string' ? args.parentId : undefined
    const beforeId = typeof args.beforeId === 'string' ? args.beforeId : undefined
    const doc = ctx.store.doc
    if (!doc.layouts?.some((l) => l.id === layoutId)) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide-type' }); return }
    if (parentId && !doc.layouts.some((l) => l.id === parentId)) { respond({ requestId: cmd.requestId, ok: false, error: `No slide type with id "${parentId}" to move under.` }); return }
    // the same cycle check moveSlideTypeInTree makes, before the commit, so
    // a refusal leaves no empty undo step behind
    const cycle = 'Refused: a slide type cannot be moved under itself or one of its own descendants.'
    if (parentId !== undefined && isDescendantOf(doc, parentId, layoutId)) { respond({ requestId: cmd.requestId, ok: false, error: cycle }); return }
    let moved = false
    ctx.store.commit(() => {
      moved = moveSlideTypeInTree(doc, layoutId, parentId, beforeId)
      if (moved) resyncLinkedSlides(doc, layoutId, layoutElementIds(doc))
    })
    if (!moved) { respond({ requestId: cmd.requestId, ok: false, error: cycle }); return }
    ctx.toast(t('Claude Code moved a slide type'))
    respond({ requestId: cmd.requestId, ok: true })
    return
  },
  detach_slide_type: (ctx, cmd) => {
    const { args, respond } = cmd
    // "Detach from parent (keep look)" — bakes the inherited content in,
    // then drops parentId; linked slides look identical afterwards.
    const layoutId = typeof args.layoutId === 'string' ? args.layoutId : undefined
    if (!layoutId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing layoutId.' }); return }
    const layout = ctx.store.doc.layouts?.find((l) => l.id === layoutId)
    if (!layout) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide-type' }); return }
    if (!layout.parentId) { respond({ requestId: cmd.requestId, ok: false, error: 'That slide type has no parent to detach from.' }); return }
    ctx.store.commit(() => detachSlideType(ctx.store.doc, layoutId))
    ctx.toast(t('Claude Code detached a slide type from its parent'))
    respond({ requestId: cmd.requestId, ok: true })
    return
  },
  relink_slide_type: (ctx, cmd) => {
    const { args, slideId, respond, lockError } = cmd
    // "Change layout…" / a Layout Manager leaf drop, for agents: the deck
    // slide `slideId` follows slide type `layoutId` from now on
    // (`relinkSlide` — re-applied in the same step), or, with
    // `layoutId: null`, follows nothing and keeps its look. The verdict
    // says what found no placeholder (kept, floating on top).
    if (!slideId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId.' }); return }
    const doc = ctx.store.doc
    const slide = doc.slides.find((s) => s.id === slideId)
    if (!slide) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide (relink takes a deck slide id)' }); return }
    if (args.layoutId !== null && typeof args.layoutId !== 'string') {
      respond({ requestId: cmd.requestId, ok: false, error: 'layoutId must be a slide type id, or null to unlink.' })
      return
    }
    const layoutId = args.layoutId
    if (layoutId !== null && !doc.layouts?.some((l) => l.id === layoutId)) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide-type' }); return }
    if (layoutId !== null && doc.layouts?.find((l) => l.id === layoutId)?.parentOnly) {
      respond({ requestId: cmd.requestId, ok: false, error: 'parent-only (that slide type is a master: pick one of its children)' })
      return
    }
    { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
    if (layoutId === null) {
      ctx.commitAgentWrite(slideId, () => { delete slide.layoutId }, undefined, { guard: false })
      ctx.toast(t('Claude Code unlinked slide “{id}” from its slide type', { id: slideId }))
      respond({ requestId: cmd.requestId, ok: true, layoutId: null })
      return
    }
    let applied = null as RelinkPreview | null
    ctx.commitAgentWrite(slideId, () => { applied = relinkSlide(doc, slideId, layoutId) }, undefined, { guard: false })
    const p = applied!
    ctx.toast(t('Claude Code changed the slide type of slide “{id}”', { id: slideId }))
    respond({
      requestId: cmd.requestId, ok: true, layoutId,
      verdict: p.verdict,
      filled: p.filled,
      floating: p.floating.map((e) => e.id),
      emptySlots: p.emptySlots,
      warnings: ctx.warningsForSlide(slideId),
    })
    return
  },
  promote_to_reusable_object: (ctx, cmd) => {
    const { args, respond } = cmd
    // Agent-facing counterpart to contextmenu.ts's "Save as reusable
    // object…" item (reusableobjects.ts's promoteToReusableObject,
    // which already handles its own store.commit — do not wrap it in
    // another). slideId resolves against slides, reusable objects AND
    // slide types (resolveAgentSlide, model.ts) since a slide type's
    // sub-editor is just another editing surface.
    const slideId = typeof args.slideId === 'string' ? args.slideId : undefined
    const elementIds = Array.isArray(args.elementIds)
      ? args.elementIds.filter((x): x is string => typeof x === 'string') : []
    if (!slideId || !elementIds.length) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId or elementIds.' }); return }
    const resolved = resolveAgentSlide(ctx.store.doc, slideId)
    if (!resolved) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide' }); return }
    const matched = elementIds
      .map((id) => resolved.slide.elements.find((e) => e.id === id))
      .filter((e): e is SlideElement => !!e)
    if (matched.length !== elementIds.length) {
      respond({ requestId: cmd.requestId, ok: false, error: 'One or more elementIds do not exist on that slide.' })
      return
    }
    const name = typeof args.name === 'string' ? args.name.trim() || undefined : undefined
    const obj = promoteToReusableObject(ctx.store, matched, name)
    if (!obj) { respond({ requestId: cmd.requestId, ok: false, error: 'Could not promote the selected elements.' }); return }
    ctx.toast(t('Claude Code saved a new reusable object from slide “{id}”', { id: slideId }))
    respond({ requestId: cmd.requestId, ok: true, objectId: obj.id })
    return
  },
} satisfies Record<string, AgentVerbHandler>
