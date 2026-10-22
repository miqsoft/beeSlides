#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// A stalled render loop.
//
//   node scripts/test-anim-stall.ts
//
// WHAT THIS PROVES. When the browser stops drawing for a while (a hidden tab,
// a window the OS stopped painting, a long freeze), a fade caught mid-way used
// to resume where it froze and crawl on at the 0.25 s clamp, so an element
// that should be fully in read as greyed out. Now a frame gap over the stall
// threshold lands every tween that was already moving at its end — while a
// tween that never had a frame still plays from the start, loops go on, and
// engine-clock timers (kiosk, auto-builds) keep their own time. `anim.drawing`
// says whether the loop is alive (present.ts's nets snap only when it is not).
// Driven through the real rAF loop: requestAnimationFrame and performance.now
// are stubbed so the test hands out each frame's timestamp itself.

import { anim } from '../kernel/src/anim.ts'

const FAILS: string[] = []
const check = (name: string, cond: boolean) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`)
}

class FakeElement { style: Record<string, string> = {}; tagName = 'DIV' }
const g: any = globalThis
g.Element = FakeElement
g.HTMLElement = class extends FakeElement {}
g.SVGElement = class extends FakeElement {}
g.MathMLElement = class extends FakeElement {}
g.NodeList = class {}
g.getComputedStyle = () => ({ opacity: '1', transform: 'none', display: 'block' })

let now = 1000
Object.defineProperty(performance, 'now', { value: () => now, configurable: true })
let pending: ((t: number) => void) | null = null
g.requestAnimationFrame = (fn: (t: number) => void) => { pending = fn; return 1 }
g.cancelAnimationFrame = () => {}
/** advance the clock by `ms` and deliver one frame */
const frame = (ms: number) => {
  now += ms
  const fn = pending
  pending = null
  fn?.(now)
}
const op = (el: FakeElement) => Number(el.style.opacity)

// 1. a fade already under way lands at its end after a stall
{
  const el = new FakeElement()
  anim.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 1, ease: 'none' })
  frame(16); frame(200)
  const mid = op(el)
  check('the fade is part-way before the stall', mid > 0.1 && mid < 0.5)
  now += 1500 // no frames: the stall
  check('anim.drawing is false while no frame comes', !anim.drawing)
  frame(0)
  check('first frame after the stall lands it at 1', op(el) === 1)
  check('and it is gone from the engine', anim.getTweensOf(el).length === 0)
  check('anim.drawing is true again', anim.drawing)
}

// 2. a slow frame below the threshold is NOT a stall
{
  const el = new FakeElement()
  anim.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 2, ease: 'none' })
  frame(16); frame(300)
  check('a 300 ms frame only advances it', op(el) > 0 && op(el) < 1)
  anim.killTweensOf(el)
}

// 3. a tween created during the stall (no frame yet) still plays from the start
{
  const moving = new FakeElement()
  anim.fromTo(moving, { opacity: 0 }, { opacity: 1, duration: 1, ease: 'none' })
  frame(16)
  now += 1000 // stall begins…
  const fresh = new FakeElement()
  anim.fromTo(fresh, { opacity: 0 }, { opacity: 1, duration: 1, ease: 'none' }) // …a slide change during it
  frame(0)
  check('the tween already moving finished', op(moving) === 1)
  check('the fresh one starts from its beginning', op(fresh) < 0.1)
  anim.killTweensOf(fresh)
}

// 4. loops go on and timers keep their own time
{
  const looping = new FakeElement()
  anim.to(looping, { opacity: 0.5, duration: 1, repeat: -1, yoyo: true, ease: 'none' })
  let fired = 0
  const clock = { p: 0 }
  anim.to(clock, { p: 1, duration: 5, ease: 'none', timer: true, onComplete: () => { fired++ } })
  frame(16); frame(16)
  now += 2000
  frame(0)
  check('a loop survives a stall', anim.getTweensOf(looping).length === 1)
  check('a timer does not fire early', fired === 0 && anim.getTweensOf(clock).length === 1)
  check('a timer has seconds left', anim.getTweensOf(clock)[0]?.remaining() > 4)
  for (let i = 0; i < 40; i++) frame(200)
  check('the timer fires on its own clock', fired === 1)
  anim.killTweensOf(looping)
}

// 5. remaining() counts the delay, and finish() runs onComplete
{
  const el = new FakeElement()
  let done = false
  const tw = anim.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.5, delay: 0.25, ease: 'none', onComplete: () => { done = true } })
  check('remaining = delay + duration', Math.abs(tw.remaining() - 0.75) < 1e-9)
  tw.finish()
  check('finish lands the end value', op(el) === 1)
  check('finish runs onComplete', done)
  check('remaining is 0 once over', tw.remaining() === 0)
}

if (FAILS.length) {
  console.log(`\n${FAILS.length} failed`)
  process.exit(1)
}
console.log('\nall passed')
