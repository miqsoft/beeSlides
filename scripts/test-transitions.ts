#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Drawn slide transitions rig — push / wipe / cover / split (src/transitions.ts
// frames, model.ts transitionDir / setSlideTransition, the untrusted.ts paste
// validator) and playDrawnTransition's `onDone` contract on a tiny stand-in
// DOM with the engine's manual clock: present.ts puts the sections' static
// transitions back from it, so it must run exactly once — played out,
// cancelled, or not drawable at all. Pixels are checked in a real browser.
//
//   slides/node_modules/.bin/esbuild scripts/test-transitions.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-transitions.mjs" \
//     && node "$TMPDIR/test-transitions.mjs"
//
// (Bundled, not run directly: the sources import './model' extensionless.)

import { emptySlide, setSlideTransition, transitionDir, TRANSITION_DIRS } from '../slides/src/model.ts'
import { DRAWN_TRANSITION_SECONDS, isDrawnTransition, playDrawnTransition, transitionFrame } from '../slides/src/transitions.ts'
import { anim } from '../slides/src/anim.ts'
import { sanitizeSlide } from '../slides/src/untrusted.ts'
import { TRANSITION_KINDS } from '../slides/src/editor/menumodel.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}

console.log('— kinds')
ok(['push', 'wipe', 'cover', 'split'].every((k) => isDrawnTransition(k as never)), 'the four new kinds are drawn')
ok(['none', 'fade', 'slide', 'zoom', 'morph', undefined].every((k) => !isDrawnTransition(k as never)), 'Reveal kinds and morph are not')
ok(['push', 'wipe', 'cover', 'split'].every((k) => (TRANSITION_KINDS as readonly string[]).includes(k)), 'every new kind is in the menu/ribbon list')

console.log('— frames: the ends are clean')
for (const kind of ['push', 'wipe', 'cover', 'split'] as const) {
  for (const dir of TRANSITION_DIRS[kind]!) {
    // p=1 is where a forward run ends (the owner on screen), p=0 where a
    // backward one ends (the slide before it on screen): that slide must be
    // left with no transform/clip of its own
    const end = transitionFrame(kind, dir, 1)
    const start = transitionFrame(kind, dir, 0)
    ok(!end.top.transform && !end.top.clipPath && !start.bottom.transform && !start.bottom.clipPath,
      `${kind} ${dir}: the slide left on screen is clean at either end`)
  }
}

console.log('— frames: where things are')
{
  const push0 = transitionFrame('push', 'right', 0)
  ok(push0.top.transform === 'translate(100%, 0%)' && !push0.bottom.transform, 'push from right starts one slide to the right')
  const pushMid = transitionFrame('push', 'right', 0.5)
  ok(pushMid.top.transform === 'translate(50%, 0%)' && pushMid.bottom.transform === 'translate(-50%, 0%)',
    'push: both slides move together, the old one out the far side')
  ok(transitionFrame('push', 'top', 0.25).top.transform === 'translate(0%, -75%)', 'push from top comes down from above')
  ok(transitionFrame('push', 'bottom', 0.25).bottom.transform === 'translate(0%, -25%)', 'push from bottom sends the old slide up')
  const cover = transitionFrame('cover', 'left', 0.5)
  ok(cover.top.transform === 'translate(-50%, 0%)' && !cover.bottom.transform, 'cover: the old slide stays put')
  ok(transitionFrame('wipe', 'right', 0.25).top.clipPath === 'inset(0 0 0 75%)', 'wipe from right uncovers from the right edge')
  ok(transitionFrame('wipe', 'left', 0.25).top.clipPath === 'inset(0 75% 0 0)', 'wipe from left uncovers from the left edge')
  ok(transitionFrame('wipe', 'top', 0.25).top.clipPath === 'inset(0 0 75% 0)', 'wipe from top uncovers from the top edge')
  ok(transitionFrame('wipe', 'bottom', 0.25).top.clipPath === 'inset(75% 0 0 0)', 'wipe from bottom uncovers from the bottom edge')
  ok(transitionFrame('split', 'vertical', 0.5).top.clipPath === 'inset(0 25% 0 25%)', 'split vertical opens from the centre sideways')
  ok(transitionFrame('split', 'horizontal', 0).top.clipPath === 'inset(50% 0 50% 0)', 'split horizontal starts closed')
  ok(transitionFrame('push', 'vertical', 0).top.transform === 'translate(100%, 0%)', 'a direction the kind cannot use falls back to its default')
  ok(transitionFrame('split', undefined, 2).top.clipPath === '' && transitionFrame('split', undefined, -1).top.clipPath === 'inset(0 50% 0 50%)',
    'progress is clamped')
}

console.log('— model: direction')
{
  const s = emptySlide({ id: 'a' })
  s.transition = 'push'
  ok(transitionDir(s) === 'right', 'absent transitionDir = the kind default')
  s.transitionDir = 'top'
  ok(transitionDir(s) === 'top', 'a valid direction is used')
  s.transition = 'split'
  ok(transitionDir(s) === 'vertical', 'a direction the kind cannot use reads as the default')
  s.transition = 'fade'
  ok(transitionDir(s) === undefined, 'kinds without a direction have none')

  const t = emptySlide({ id: 'b' })
  setSlideTransition(t, 'push'); t.transitionDir = 'left'
  setSlideTransition(t, 'wipe')
  ok(t.transitionDir === 'left', 'push → wipe keeps "from left"')
  setSlideTransition(t, 'split')
  ok(!('transitionDir' in t), 'wipe → split drops a side direction')
  t.transitionDir = 'horizontal'
  setSlideTransition(t, 'fade')
  ok(!('transitionDir' in t) && t.transition === 'fade', '→ fade forgets the direction')
}

console.log('— paste validator (untrusted.ts)')
{
  const base = { id: 's1', background: '#fff', notes: '', elements: [] }
  const pasted = sanitizeSlide({ ...base, transition: 'cover', transitionDir: 'bottom' })
  ok(pasted?.transition === 'cover' && pasted.transitionDir === 'bottom', 'a new kind and its direction survive a paste')
  const bad = sanitizeSlide({ ...base, transition: 'explode', transitionDir: 'diagonal' })
  ok(!!bad && !('transition' in bad) && !('transitionDir' in bad), 'unknown values are dropped, the slide is kept')
}

console.log('— playDrawnTransition: onDone runs exactly once')
{
  // just enough DOM for playDrawnTransition: child lookup, clone, classes,
  // attributes, style, append/remove
  class FakeEl {
    children: FakeEl[] = []
    parent: FakeEl | null = null
    classes = new Set<string>()
    attrs = new Map<string, string>()
    style: Record<string, string> = {}
    tagName = 'DIV'
    classList = {
      add: (c: string) => { this.classes.add(c) },
      remove: (c: string) => { this.classes.delete(c) },
      contains: (c: string) => this.classes.has(c),
    }
    constructor(cls = '') { if (cls) this.classes.add(cls) }
    querySelector(sel: string) {
      const m = /^:scope > \.(.+)$/.exec(sel)
      return m ? this.children.find((c) => c.classes.has(m[1])) ?? null : null
    }
    querySelectorAll(sel: string): FakeEl[] {
      const all: FakeEl[] = []
      const walk = (n: FakeEl) => { for (const c of n.children) { all.push(c); walk(c) } }
      walk(this)
      return sel === '*' ? all : all.filter((n) => sel.split(',').map((x) => x.trim().toUpperCase()).includes(n.tagName))
    }
    appendChild(c: FakeEl) { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.push(c); return c }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null } }
    setAttribute(k: string, v: string) { this.attrs.set(k, v) }
    getAttribute(k: string) { return this.attrs.get(k) ?? null }
    removeAttribute(k: string) { this.attrs.delete(k) }
    replaceWith(n: FakeEl) { const p = this.parent; if (p) { p.children[p.children.indexOf(this)] = n; n.parent = p; this.parent = null } }
    cloneNode(): FakeEl {
      const c = new FakeEl()
      c.tagName = this.tagName
      c.classes = new Set(this.classes)
      c.attrs = new Map(this.attrs)
      c.style = { ...this.style }
      for (const k of this.children) c.appendChild(k.cloneNode())
      return c
    }
  }
  const g = globalThis as Record<string, unknown>
  g.Element ??= class {}
  g.NodeList ??= class {}
  g.requestAnimationFrame ??= () => 0
  anim.setManual(true)
  const section = () => { const s = new FakeEl('section'); s.appendChild(new FakeEl('beeslides-slide')); return s }
  const pair = () => ({ from: section(), to: section() })
  const play = (p: { from: FakeEl; to: FakeEl }, done: () => void, forward = true) =>
    playDrawnTransition(p.from as unknown as HTMLElement, p.to as unknown as HTMLElement, 'push', 'right', forward, done)

  {
    let n = 0
    const p = pair()
    play(p, () => n++)
    ok(n === 0 && p.to.classes.has('beeslides-tx-running') && p.to.children.length === 2, 'while it plays: not done yet, the ghost is in')
    anim.tick(DRAWN_TRANSITION_SECONDS / 2)
    ok(n === 0, 'halfway: still not done')
    anim.tick(DRAWN_TRANSITION_SECONDS)
    ok(n === 1, 'played out: onDone ran once')
    ok(!p.to.classes.has('beeslides-tx-running') && p.to.children.length === 1 && !p.to.children[0].style.transform,
      '…and the incoming slide is left clean (ghost gone, no transform)')
    anim.tick(1)
    ok(n === 1, '…and never again')
  }
  {
    let n = 0
    const p = pair()
    const cancel = play(p, () => n++, false)
    anim.tick(0.1)
    cancel()
    ok(n === 1 && p.to.children.length === 1, 'cancelled (a newer slide change): onDone ran once, snapped to the end')
    cancel()
    anim.tick(DRAWN_TRANSITION_SECONDS * 2)
    ok(n === 1, '…a second cancel or the old tween finishing does not run it again')
  }
  {
    let n = 0
    const bare = { from: new FakeEl('section'), to: section() }
    const cancel = play(bare, () => n++)
    ok(n === 1, 'not drawable (a section without its slide surface): onDone ran at once')
    cancel()
    ok(n === 1, '…and its no-op cancel does not run it again')
  }
  {
    // two overlapping transitions (a fast double press): each one's own
    // onDone, once each — present.ts relies on that plus its own identity
    // guard so the OLDER end never restores the newer override
    const order: string[] = []
    const a = pair()
    const b = pair()
    const cancelA = play(a, () => order.push('a'))
    anim.tick(0.2)
    cancelA() // what present.ts does at the next slideTo
    play(b, () => order.push('b'))
    anim.tick(DRAWN_TRANSITION_SECONDS + 0.1)
    ok(order.join(',') === 'a,b', 'back-to-back: the first ends at the cancel, the second when it plays out')
  }
  anim.setManual(false)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
