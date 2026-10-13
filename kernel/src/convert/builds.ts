// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// PowerPoint click builds → slidomingo `fx.step` / `exitStep` / `byParagraph`.
//
// A slide's `p:timing` holds its animations as a tree of time nodes. The part
// that matters here is the MAIN SEQUENCE:
//
//   p:timing > p:tnLst > p:par (tmRoot) > p:cTn > p:childTnLst
//     > p:seq > p:cTn nodeType="mainSeq" > p:childTnLst
//       > p:par                     ← ONE CLICK  (cond delay="indefinite")
//         > p:cTn > p:childTnLst
//           > p:par                 ← a time group inside the click
//             > p:cTn > p:childTnLst
//               > p:par > p:cTn presetID presetClass presetSubtype nodeType
//                                   ← an EFFECT (clickEffect / withEffect /
//                                     afterEffect), whose target is
//                                     p:spTgt spid, optionally p:txEl > p:pRg
//
// Mapping, in the order a reader should check it:
//
//   - top-level par #k that waits for a click   → click k (1-based). One that
//     starts by itself (evt="onBegin" — a first effect set to "With/After
//     previous") is click 0: it plays with the slide, which is just no step.
//   - entr / exit + p:spTgt                      → fx.step / fx.exitStep on the
//     element(s) that shape became.
//   - a withEffect shares its click AND its stagger slot; an afterEffect opens
//     a LATER time group inside the same click, which is exactly what
//     slidomingo's `fx.order` expresses ("equal = together, higher = after").
//   - p:txEl > p:pRg (paragraph ranges)          → fx.byParagraph on the text.
//   - emphasis, motion paths, interactive (trigger) sequences, media cues
//     → DROPPED, each with a report entry. Nothing is silently lost.
//
// Element ids are the ones shapes.ts/pptx.ts minted (`s<n>-<spid>`, with `-t`
// for the text half of a box-with-text split); a group target fans out to its
// members. What we cannot say in the model is reported 'approximated'.

import { NS, attr, descendants, intAttr, kid, kids, type XElem } from './xml.ts'
import type { OutElement } from './types.ts'
import type { Report } from './report.ts'

type Kind = 'fade' | 'fade-up' | 'fade-down' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down'

/** What one slide's timing contributes to one element. */
export interface BuildFx {
  step?: number
  exitStep?: number
  enter?: Kind
  enterDur?: number
  exit?: Kind
  exitDur?: number
  order?: number
  byParagraph?: true
}

/**
 * presetID → our entrance kind. Fly In (2) takes its direction from
 * presetSubtype, a bitmask of the side it comes FROM (1 top, 2 right, 4 bottom,
 * 8 left); slidomingo's slide-<dir> is named for the way it TRAVELS, so "from
 * the right" is slide-left. 42 (Ascend / float up) and 47 (Descend / float down)
 * are the two float presets; everything else stays a fade and is reported.
 */
function entranceKind(presetID: number, subtype: number): { kind: Kind; dur?: number; exact: boolean } {
  switch (presetID) {
    case 1: return { kind: 'fade', dur: 0.1, exact: true } // Appear: a cut, softened to a blink
    case 10: return { kind: 'fade', exact: true }
    case 42: return { kind: 'fade-up', exact: true }
    case 47: return { kind: 'fade-down', exact: true }
    case 2: {
      const kind: Kind = subtype & 2 ? 'slide-left' : subtype & 8 ? 'slide-right' : subtype & 4 ? 'slide-up' : 'slide-down'
      return { kind, exact: true }
    }
    default: return { kind: 'fade', exact: false }
  }
}

/** The same table for exits; Fly Out's subtype names the side it leaves TOWARD. */
function exitKind(presetID: number, subtype: number): { kind: Kind; dur?: number; exact: boolean } {
  switch (presetID) {
    case 1: return { kind: 'fade', dur: 0.1, exact: true } // Disappear
    case 10: return { kind: 'fade', exact: true }
    case 42: return { kind: 'fade-up', exact: true }
    case 47: return { kind: 'fade-down', exact: true }
    case 2: {
      const kind: Kind = subtype & 8 ? 'slide-left' : subtype & 2 ? 'slide-right' : subtype & 1 ? 'slide-up' : 'slide-down'
      return { kind, exact: true }
    }
    default: return { kind: 'fade', exact: false }
  }
}

interface Effect {
  cls: 'entr' | 'exit'
  presetID: number
  subtype: number
  click: number
  /** which time group inside its click (0 = the click itself) */
  group: number
  spid: string
  /** paragraph range, when the effect targets part of a text body */
  para?: { st: number; end: number }
  dur?: number
}

const SP_LOCALS = new Set(['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp'])

/** The cNvPr of a drawing element (p:sp/p:pic/… ➜ its nv*Pr ➜ cNvPr). */
function cNvPr(el: XElem): XElem | undefined {
  for (const c of kids(el)) {
    const cnv = kid(c, NS.p, 'cNvPr')
    if (cnv) return cnv
  }
  return undefined
}

/** spid → its drawing element in the slide's spTree (any depth). */
function findShape(spTree: XElem, spid: string): XElem | undefined {
  let found: XElem | undefined
  const walk = (e: XElem) => {
    if (found) return
    for (const c of kids(e)) {
      if (c.ns === NS.p && SP_LOCALS.has(c.local) && attr(cNvPr(c) ?? c, 'id') === spid && cNvPr(c)) { found = c; return }
      if (c.ns === NS.p && c.local === 'grpSp') walk(c)
      else if (c.ns === NS.mc) walk(c)
      else if (c.local === 'Choice' || c.local === 'Fallback') walk(c)
    }
  }
  walk(spTree)
  return found
}

/** Every cNvPr id inside a group (any depth), the group's own excluded. */
function memberIds(grp: XElem): string[] {
  const out: string[] = []
  const walk = (e: XElem) => {
    for (const c of kids(e)) {
      if (c.ns !== NS.p || !SP_LOCALS.has(c.local)) continue
      const id = cNvPr(c) && attr(cNvPr(c)!, 'id')
      if (c.local === 'grpSp') walk(c)
      else if (id) out.push(id)
    }
  }
  walk(grp)
  return out
}

/**
 * Read a slide's click builds and return, per ELEMENT id, the fx to set. Pure
 * apart from report entries; the caller applies the patches (and decides
 * whether linking to a layout is still safe — see pptx.ts).
 */
export function readBuilds(
  slideXml: XElem,
  n: number,
  elements: OutElement[],
  report: Report,
): Map<string, BuildFx> {
  const out = new Map<string, BuildFx>()
  const timing = kid(slideXml, NS.p, 'timing')
  if (!timing) return out
  const cSld = kid(slideXml, NS.p, 'cSld')
  const spTree = cSld && kid(cSld, NS.p, 'spTree')
  const where = (spid?: string): string => {
    const shape = spid && spTree ? findShape(spTree, spid) : undefined
    const name = shape && cNvPr(shape) && attr(cNvPr(shape)!, 'name')
    return name ? `slide ${n} / sp "${name}"` : `slide ${n}`
  }

  const cTns = descendants(timing, NS.p, 'cTn')

  // interactive (trigger) sequences — "when this shape is clicked, animate…"
  for (const c of cTns) {
    if (attr(c, 'nodeType') === 'interactiveSeq') {
      const stCond = kid(c, NS.p, 'stCondLst')
      const tgt = stCond && descendants(stCond, NS.p, 'spTgt')[0] // the shape whose click starts it
      report.add('dropped', 'build-trigger-dropped', where(tgt && attr(tgt, 'spid')),
        'a trigger animation (plays when a shape is clicked) — there is no equivalent; the shapes it animates stay as they are')
    }
  }

  const mainSeq = cTns.find((c) => attr(c, 'nodeType') === 'mainSeq')
  if (!mainSeq) return out
  const seqList = kid(mainSeq, NS.p, 'childTnLst')
  if (!seqList) return out

  // ---- the effects, with the click and time group each belongs to
  const effects: Effect[] = []
  let click = 0
  for (const clickPar of kids(seqList, NS.p, 'par')) {
    const clickTn = kid(clickPar, NS.p, 'cTn')
    if (!clickTn) continue
    const st = kid(clickTn, NS.p, 'stCondLst')
    const conds = st ? kids(st, NS.p, 'cond') : []
    const auto = conds.some((c) => attr(c, 'evt') === 'onBegin')
    const waits = conds.some((c) => attr(c, 'delay') === 'indefinite')
    const thisClick = auto || !waits ? 0 : ++click

    const groups = kid(clickTn, NS.p, 'childTnLst')
    kids(groups ?? clickTn, NS.p, 'par').forEach((groupPar, gi) => {
      for (const eTn of descendants(groupPar, NS.p, 'cTn')) {
        const cls = attr(eTn, 'presetClass')
        if (!cls) continue
        const spTgt = descendants(eTn, NS.p, 'spTgt')[0]
        const spid = spTgt && attr(spTgt, 'spid')
        if (cls === 'emph') {
          report.add('dropped', 'build-emphasis-dropped', where(spid),
            'an emphasis animation (spin, grow/shrink, colour pulse…) — only entrances and exits are imported')
          continue
        }
        if (cls === 'path') {
          report.add('dropped', 'build-motion-path-dropped', where(spid),
            'a motion-path animation — draw the route again with a loop motion-path if it matters')
          continue
        }
        if (cls !== 'entr' && cls !== 'exit') {
          report.add('dropped', 'build-effect-dropped', where(spid), `an animation of class "${cls}" has no equivalent`)
          continue
        }
        if (!spid) continue
        const pRg = descendants(spTgt, NS.p, 'pRg')[0]
        // the effect's own length: the longest finite behaviour duration under it
        let dur: number | undefined
        for (const b of [...descendants(eTn, NS.p, 'animEffect'), ...descendants(eTn, NS.p, 'anim')]) {
          const bt = descendants(b, NS.p, 'cTn')[0]
          const ms = bt ? intAttr(bt, 'dur', 0) : 0
          if (ms > 1 && (dur === undefined || ms / 1000 > dur)) dur = ms / 1000
        }
        effects.push({
          cls, presetID: intAttr(eTn, 'presetID', 0), subtype: intAttr(eTn, 'presetSubtype', 0),
          click: thisClick, group: gi, spid,
          ...(pRg ? { para: { st: intAttr(pRg, 'st', 0), end: intAttr(pRg, 'end', intAttr(pRg, 'st', 0)) } } : {}),
          ...(dur !== undefined ? { dur } : {}),
        })
      }
    })
  }
  if (!effects.length) return out

  // Renumber the clicks that actually carry an imported effect 1…N. A click
  // holding only an emphasis or a motion path (dropped above) must not leave a
  // gap in the file — the editor would show a click that does nothing.
  const used = [...new Set(effects.filter((e) => e.click > 0).map((e) => e.click))].sort((a, b) => a - b)
  const renumber = new Map(used.map((c, i) => [c, i + 1]))
  for (const e of effects) e.click = e.click > 0 ? renumber.get(e.click)! : 0

  // does the attached shape animate with its text? (bldP animBg="1")
  const animBg = new Set<string>()
  const bldLst = kid(timing, NS.p, 'bldLst')
  for (const b of bldLst ? kids(bldLst, NS.p, 'bldP') : []) {
    const v = attr(b, 'animBg')
    if (v === '1' || v === 'true') animBg.add(attr(b, 'spid') ?? '')
  }

  /** the slidomingo elements a spid became: itself, its `-t` text half, or a group's members */
  const elementsOf = (spid: string): { all: OutElement[]; text?: OutElement; shape?: OutElement } => {
    const shape = spTree && findShape(spTree, spid)
    const ids = shape && shape.local === 'grpSp' ? memberIds(shape) : [spid]
    const all: OutElement[] = []
    for (const id of ids) {
      for (const e of elements) if (e.id === `s${n}-${id}` || e.id === `s${n}-${id}-t`) all.push(e)
    }
    return { all, text: all.find((e) => e.type === 'text'), shape: all.find((e) => e.type !== 'text') }
  }

  const patch = (id: string): BuildFx => { let p = out.get(id); if (!p) out.set(id, (p = {})); return p }
  // an effect group is a stagger slot only when its click has more than one
  const groupsInClick = new Map<number, number>()
  for (const e of effects) groupsInClick.set(e.click, Math.max(groupsInClick.get(e.click) ?? 0, e.group + 1))

  const paragraphRuns = new Map<string, Effect[]>() // text element id → its paragraph effects
  for (const e of effects) {
    const targets = elementsOf(e.spid)
    if (!targets.all.length) continue
    const k = e.cls === 'entr' ? entranceKind(e.presetID, e.subtype) : exitKind(e.presetID, e.subtype)
    if (!k.exact) {
      report.add('approximated', 'build-effect-approximated', where(e.spid),
        `animation preset ${e.presetID} (${e.cls === 'entr' ? 'entrance' : 'exit'}) has no equivalent — imported as a fade`)
    }
    const dur = e.dur ?? k.dur

    if (e.cls === 'exit') {
      if (e.para) {
        report.add('approximated', 'build-paragraph-approximated', where(e.spid),
          'paragraphs leaving one at a time — slidomingo takes the whole text box out on that click')
      }
      for (const el of targets.all) {
        const p = patch(el.id)
        p.exitStep = e.click
        p.exit = k.kind
        if (dur !== undefined) p.exitDur = dur
      }
      continue
    }
    if (e.para && targets.text) {
      const list = paragraphRuns.get(targets.text.id) ?? []
      list.push(e)
      paragraphRuns.set(targets.text.id, list)
      continue
    }
    for (const el of targets.all) {
      const p = patch(el.id)
      if (e.click > 0) p.step = e.click
      p.enter = k.kind
      if (dur !== undefined) p.enterDur = dur
      if ((groupsInClick.get(e.click) ?? 1) > 1) p.order = e.group
    }
  }

  // ---- by-paragraph text: one entrance per paragraph → fx.byParagraph
  for (const [textId, list] of paragraphRuns) {
    list.sort((a, b) => (a.para!.st - b.para!.st) || (a.click - b.click))
    const first = list[0]
    const k = entranceKind(first.presetID, first.subtype)
    if (!k.exact) {
      report.add('approximated', 'build-effect-approximated', where(first.spid),
        `animation preset ${first.presetID} (entrance) has no equivalent — imported as a fade`)
    }
    const p = patch(textId)
    p.byParagraph = true
    p.enter = k.kind
    const dur = first.dur ?? k.dur
    if (dur !== undefined) p.enterDur = dur
    if (first.click > 0) p.step = first.click
    else p.step = 0 // first paragraph arrives with the slide; the rest on clicks
    // slidomingo reveals paragraph k on click (step + k): say so when the deck did not
    const consecutive = list.every((e, i) => i === 0 || (e.para!.st > list[i - 1].para!.st && e.click === list[i - 1].click + 1))
    if (!consecutive || first.para!.st > 0) {
      report.add('approximated', 'build-paragraph-approximated', where(first.spid),
        'paragraphs arrive on consecutive clicks in slidomingo; this deck times them differently (several at once, gaps, or the first left static) — imported one per click')
    }
    // the box itself comes in with the first paragraph when "animate attached shape" is on
    const shape = elementsOf(first.spid).shape
    if (shape && animBg.has(first.spid)) {
      const sp2 = patch(shape.id)
      if (first.click > 0) sp2.step = first.click
      sp2.enter = k.kind
      if (dur !== undefined) sp2.enterDur = dur
    }
  }
  return out
}

/** Merge build patches into the finished elements (ids as emitted; see pptx.ts for the linked case). */
export function applyBuilds(elements: OutElement[], patches: Map<string, BuildFx>): void {
  for (const el of elements) {
    const p = patches.get(el.id)
    if (!p) continue
    el.fx = { ...(el.fx ?? {}), ...p }
  }
}
