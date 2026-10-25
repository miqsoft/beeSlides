// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The element write verbs of the agent-action channel (editor.ts
// applyAgentAction → ./index.ts AGENT_VERBS): structural edits an agent can
// make WITHOUT reconstructing and resending an entire slide for a
// one-element change. One agent write (ctx.commitAgentWrite, one undo step)
// each, toasting so a human watching the editor sees what Claude just did.
import { t } from '../../i18n'
import { resolveAgentSlide, type ShapeElement, type TableElement } from '../../model'
import { checkElementProp, isWholePictureCrop, REQUIRED_KEYS } from '../../untrusted'
import { sanitizeHtml } from '../../render'
import { applyReapplicablePatch, computeReapplicablePatch } from '../../actionlog'
import { agentSvgPatchViolation, agentSvgViolation } from '../agentsvg'
import { cloneElement, remapCopiedRefs } from '../clipboard'
import { findAgentTarget, type AgentVerbHandler } from './context'

export const ELEMENT_VERBS = {
  insert_elements: (ctx, cmd) => {
    const { args, slideId, respond, lockError } = cmd
    if (!slideId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId.' }); return }
    if (!resolveAgentSlide(ctx.store.doc, slideId)) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide' }); return }
    { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
    // new svg artwork is refused (agentsvg.ts); the icons tool is the way in
    { const bad = agentSvgViolation(ctx.store.doc, args.elements, { existing: resolveAgentSlide(ctx.store.doc, slideId)?.slide.elements, assets: args.assets }); if (bad) { respond({ requestId: cmd.requestId, ok: false, error: bad }); return } }
    const r = ctx.insertElements(slideId, args.elements, args.assets, { nudge: args.nudge !== false, reflow: args.reflow !== false, fonts: args.fonts })
    if ('error' in r) { respond({ requestId: cmd.requestId, ok: false, error: r.error }); return }
    const { added } = r
    ctx.toast(t('Claude Code added elements to slide “{id}”', { id: slideId }))
    const layout = ctx.layoutReport()
    respond({ requestId: cmd.requestId, ok: true, elementIds: added.map((e) => e.id), warnings: ctx.warningsForSlide(slideId), ...layout })
    return
  },
  set_frame: (ctx, cmd) => {
    const { args, slideId, elementId, respond, lockError } = cmd
    if (!slideId || !elementId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId or elementId.' }); return }
    const target = findAgentTarget(ctx.store.doc, slideId, elementId)
    if (!target) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-element' }); return }
    { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
    const patch: Partial<Record<'x' | 'y' | 'w' | 'h' | 'rotation', number>> = {}
    for (const key of ['x', 'y', 'w', 'h', 'rotation'] as const) {
      if (args[key] === undefined) continue
      const check = checkElementProp(target.el.type, key, args[key])
      if (!check.ok) { respond({ requestId: cmd.requestId, ok: false, error: `Invalid ${key}.` }); return }
      patch[key] = check.value as number
    }
    // a container child's parentOffset follows inside the guard
    // (layoutguard reanchorChild), so syncContainers keeps the new spot
    ctx.commitAgentWrite(slideId, () => { Object.assign(target.el, patch) }, undefined, { reflow: args.reflow !== false })
    ctx.toast(t('Claude Code moved or resized an element on slide “{id}”', { id: slideId }))
    const layout = ctx.layoutReport()
    respond({
      requestId: cmd.requestId, ok: true,
      frame: { x: target.el.x, y: target.el.y, w: target.el.w, h: target.el.h, rotation: target.el.rotation },
      warnings: ctx.warningsForSlide(slideId),
      ...layout,
    })
    return
  },
  update_element: (ctx, cmd) => {
    const { args, slideId, elementId, respond, lockError } = cmd
    // Shallow property patch on ONE element — the cheap alternative to a
    // get_slide + write_slide round trip for a colour/font/border change,
    // and it cannot clobber a concurrent edit to the rest of the slide.
    // Every key goes through the same per-key check set_frame uses; a
    // null value removes an optional key. id/type are never patchable.
    if (!slideId || !elementId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId or elementId.' }); return }
    const props = args.props
    if (!props || typeof props !== 'object' || Array.isArray(props) || !Object.keys(props).length) {
      respond({ requestId: cmd.requestId, ok: false, error: 'props must be a non-empty object.' })
      return
    }
    const target = findAgentTarget(ctx.store.doc, slideId, elementId)
    if (!target) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-element' }); return }
    const set: Record<string, unknown> = {}
    const unset: string[] = []
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
      if (key === 'id' || key === 'type') { respond({ requestId: cmd.requestId, ok: false, error: `${key} cannot be changed.` }); return }
      // a crop of the whole picture cuts nothing: it removes the crop, like null
      if (value === null || (key === 'crop' && target.el.type === 'image' && isWholePictureCrop(value))) {
        if ((REQUIRED_KEYS[target.el.type] ?? []).includes(key)) {
          respond({ requestId: cmd.requestId, ok: false, error: `${key} is required on a ${target.el.type} element.` })
          return
        }
        unset.push(key)
        continue
      }
      const check = checkElementProp(target.el.type, key, value)
      if (!check.ok) { respond({ requestId: cmd.requestId, ok: false, error: `Invalid or unknown prop "${key}" for a ${target.el.type} element.` }); return }
      let val = check.value
      // Same sanitizer write_slide runs rich text through.
      if (key === 'html') val = sanitizeHtml(val as string)
      if (key === 'rows' && Array.isArray(val)) {
        for (const row of val as TableElement['rows']) {
          for (const cell of row.cells ?? []) cell.html = sanitizeHtml(cell.html ?? '')
        }
      }
      set[key] = val
    }
    { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
    { const bad = agentSvgPatchViolation(ctx.store.doc, target.el, set); if (bad) { respond({ requestId: cmd.requestId, ok: false, error: bad }); return } }
    ctx.commitAgentWrite(slideId, () => {
      const el = target.el as unknown as Record<string, unknown>
      Object.assign(el, set)
      for (const key of unset) delete el[key]
    }, undefined, { reflow: args.reflow !== false })
    ctx.toast(t('Claude Code edited “{id}”', { id: elementId }))
    const layout = ctx.layoutReport()
    respond({ requestId: cmd.requestId, ok: true, changed: [...Object.keys(set), ...unset], warnings: ctx.warningsForSlide(slideId), ...layout })
    return
  },
  duplicate_element: (ctx, cmd) => {
    const { args, slideId, elementId, respond, lockError } = cmd
    if (!slideId || !elementId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId or elementId.' }); return }
    const target = findAgentTarget(ctx.store.doc, slideId, elementId)
    if (!target) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-element' }); return }
    { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
    const clone = cloneElement(target.el)
    // same as ⌘D: the copy gets its own group and is never re-parented
    // onto the original's container (syncContainers would snap it there)
    remapCopiedRefs([clone], new Map([[target.el.id, clone.id]]))
    for (const key of ['x', 'y'] as const) {
      if (args[key] === undefined) continue
      const check = checkElementProp(clone.type, key, args[key])
      if (!check.ok) { respond({ requestId: cmd.requestId, ok: false, error: `Invalid ${key}.` }); return }
      clone[key] = check.value as number
    }
    ctx.commitAgentWrite(slideId, () => { target.slide.elements.push(clone) })
    ctx.toast(t('Claude Code duplicated an element on slide “{id}”', { id: slideId }))
    respond({ requestId: cmd.requestId, ok: true, elementId: clone.id, warnings: ctx.warningsForSlide(slideId), ...ctx.layoutReport() })
    return
  },
  delete_element: (ctx, cmd) => {
    const { slideId, elementId, respond, lockError } = cmd
    if (!slideId || !elementId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId or elementId.' }); return }
    const target = findAgentTarget(ctx.store.doc, slideId, elementId)
    if (!target) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-element' }); return }
    { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
    ctx.commitAgentWrite(slideId, () => { target.slide.elements.splice(target.idx, 1) })
    ctx.toast(t('Claude Code deleted an element from slide “{id}”', { id: slideId }))
    respond({ requestId: cmd.requestId, ok: true, warnings: ctx.warningsForSlide(slideId), ...ctx.layoutReport() })
    return
  },
  reorder_element: (ctx, cmd) => {
    const { args, slideId, elementId, respond, lockError } = cmd
    // array order IS paint/z order (render.ts/canvas.ts iterate
    // slide.elements in order) — reimplemented directly against the
    // ADDRESSED slide's array rather than routed through panels.ts's
    // step()/reorder(), which act on whatever slide is currently VIEWED.
    const to = args.to as 'front' | 'back' | 'forward' | 'backward' | undefined
    if (!slideId || !elementId || !to) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId, elementId or to.' }); return }
    // any other value used to fall through to a backward step and report ok
    if (!['front', 'back', 'forward', 'backward'].includes(to)) { respond({ requestId: cmd.requestId, ok: false, error: 'to must be front, back, forward or backward.' }); return }
    const target = findAgentTarget(ctx.store.doc, slideId, elementId)
    if (!target) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-element' }); return }
    { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
    // already at the top (front/forward) or bottom (back/backward): nothing
    // to move, so no undo step
    const atTop = target.idx === target.slide.elements.length - 1
    if (to === 'front' || to === 'forward' ? atTop : target.idx === 0) {
      respond({ requestId: cmd.requestId, ok: true, unchanged: true, warnings: ctx.warningsForSlide(slideId) })
      return
    }
    ctx.commitAgentWrite(slideId, () => {
      const arr = target.slide.elements
      const i = target.idx
      if (to === 'front' || to === 'back') {
        const [el] = arr.splice(i, 1)
        if (to === 'front') arr.push(el)
        else arr.unshift(el)
      } else {
        const j = i + (to === 'forward' ? 1 : -1)
        if (j >= 0 && j < arr.length) { [arr[i], arr[j]] = [arr[j], arr[i]] }
      }
    })
    ctx.toast(t('Claude Code reordered an element on slide “{id}”', { id: slideId }))
    respond({ requestId: cmd.requestId, ok: true, warnings: ctx.warningsForSlide(slideId), ...ctx.layoutReport() })
    return
  },
  apply_change_pattern: (ctx, cmd) => {
    const { args, slideId, respond, lockError } = cmd
    // Deliberately takes an EXPLICIT target id list — no server-side
    // "find similar" heuristic. Claude already has doc_info/outline to
    // decide "similar" itself; this keeps the mutating verb as small and
    // auditable as the five above. Same patch computeReapplicablePatch
    // produces for the manual armed tool (editor/reapplychange.ts), so a
    // human doing this by hand and Claude calling this verb behave
    // identically for the same source change.
    const sourceElementId = typeof args.sourceElementId === 'string' ? args.sourceElementId : undefined
    const rawTargets = Array.isArray(args.targetElementIds) ? args.targetElementIds : undefined
    if (!slideId || !sourceElementId || !rawTargets?.length) {
      respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId, sourceElementId or targetElementIds.' })
      return
    }
    const source = findAgentTarget(ctx.store.doc, slideId, sourceElementId)
    if (!source) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-source-element' }); return }
    { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
    const change = ctx.store.actionLog.lastChangeFor(slideId, sourceElementId)
    const patch = change ? computeReapplicablePatch(change) : null
    if (!patch) { respond({ requestId: cmd.requestId, ok: false, error: 'no-reapplicable-change' }); return }
    const targetIds = rawTargets.filter((x): x is string => typeof x === 'string')
    const applied: string[] = []
    const skipped: string[] = []
    for (const id of targetIds) {
      const target = findAgentTarget(ctx.store.doc, slideId, id)
      const sameKind = !!target && target.el.type === source.el.type &&
        (source.el.type !== 'shape' || (target.el as ShapeElement).shape === (source.el as ShapeElement).shape)
      if (sameKind) applied.push(id)
      else skipped.push(id)
    }
    if (applied.length) {
      ctx.commitAgentWrite(slideId, () => {
        for (const id of applied) {
          const target = findAgentTarget(ctx.store.doc, slideId!, id)
          if (target) applyReapplicablePatch(patch, target.el)
        }
      })
      ctx.toast(t('Claude Code applied a recent change to {n} element(s) on slide “{id}”', { n: applied.length, id: slideId }))
    }
    respond({ requestId: cmd.requestId, ok: true, applied, skipped, warnings: ctx.warningsForSlide(slideId), ...ctx.layoutReport() })
    return
  },
} satisfies Record<string, AgentVerbHandler>
