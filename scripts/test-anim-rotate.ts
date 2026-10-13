#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// The `rotate` transform channel.
//
//   node scripts/test-anim-rotate.ts
//
// WHAT THIS PROVES. Looping effects (spin, wiggle) need to rotate an element
// that may ALREADY be rotated by the model: applyElementFrame writes
// `rotate(30deg)` into style.transform, and a tween that overwrote it would
// snap every rotated element upright. So the channel is ADDITIVE — it composes
// with the model's rotate() — and sits alongside x/y/scale in the same
// transform registry. Headless: the stand-in style bag is read back as a STRING
// here, which is fine for composition (no layout is being asserted).

import { anim, resetXform } from '../kernel/src/anim.ts'

const FAILS: string[] = []
const check = (name: string, cond: boolean) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`)
}

class FakeElement { style: Record<string, string> = {}; tagName = 'DIV' }
class FakeHTML extends FakeElement {}
const g: any = globalThis
g.Element = FakeElement
g.HTMLElement = FakeHTML
g.SVGElement = class extends FakeElement {}
g.MathMLElement = class extends FakeElement {}
g.NodeList = class {}
g.getComputedStyle = () => ({ opacity: '1', transform: 'none', display: 'block' })
g.requestAnimationFrame = () => 0
g.cancelAnimationFrame = () => {}
anim.setManual(true)

const angleOf = (t: string, nth: number): number | null => {
  const all = [...t.matchAll(/rotate\((-?[\d.]+)deg\)/g)]
  return all[nth] ? Number(all[nth][1]) : null
}

// 1. a plain element spins 0 → 360
{
  const el = new FakeHTML()
  anim.fromTo(el, { rotate: 0 }, { rotate: 360, duration: 2, ease: 'none' })
  anim.tick(1)
  check('halfway is 180deg', angleOf(el.style.transform, 0) === 180)
  anim.tick(1.5)
  check('lands on 360deg', angleOf(el.style.transform, 0) === 360)
}

// 2. the model's rotate() survives, and the channel adds on top
{
  const el = new FakeHTML()
  el.style.transform = 'rotate(30deg)' // what applyElementFrame wrote
  anim.fromTo(el, { rotate: 0 }, { rotate: 90, duration: 1, ease: 'none' })
  anim.tick(0.5)
  check('the model rotation is kept first', angleOf(el.style.transform, 0) === 30)
  check('the tween rotation is added after it', angleOf(el.style.transform, 1) === 45)
}

// 3. composes with the other channels (translate, scale) instead of replacing them
{
  const el = new FakeHTML()
  el.style.transform = 'rotate(10deg)'
  anim.fromTo(el, { y: 0 }, { y: 20, duration: 1, ease: 'none', repeat: -1, yoyo: true })
  anim.fromTo(el, { scale: 1 }, { scale: 2, duration: 1, ease: 'none', repeat: -1, yoyo: true })
  anim.fromTo(el, { rotate: -8 }, { rotate: 8, duration: 1, ease: 'none', repeat: -1, yoyo: true })
  anim.tick(0.5)
  const t = el.style.transform
  check('translate, model rotate, tween rotate and scale all present',
    /translate\(0px, 10px\)/.test(t) && angleOf(t, 0) === 10 && angleOf(t, 1) === null /* 0 deg is omitted */ && /scale\(1\.5, 1\.5\)/.test(t))
  anim.tick(1) // yoyo: back at the midpoint heading home
  check('a yoyo wiggle swings back through the middle', angleOf(el.style.transform, 1) === null)
  anim.tick(0.25)
  check('…and out the other side', (angleOf(el.style.transform, 1) ?? 0) < 0)
}

// 4. resetXform forgets the channel (applyElementFrame → resetXform on slide exit)
{
  const el = new FakeHTML()
  anim.fromTo(el, { rotate: 0 }, { rotate: 100, duration: 1, ease: 'none' })
  anim.tick(0.5)
  anim.killTweensOf(el)
  el.style.transform = '' // applyElementFrame
  resetXform(el)
  anim.fromTo(el, { y: 0 }, { y: 10, duration: 1, ease: 'none' })
  anim.tick(0.5)
  check('no stale rotation re-emerges after reset', angleOf(el.style.transform, 0) === null)
}

// 5. per-channel overwrite: a new rotate tween replaces the old, other channels live on
{
  const el = new FakeHTML()
  anim.fromTo(el, { y: 0 }, { y: 10, duration: 10, ease: 'none' })
  anim.fromTo(el, { rotate: 0 }, { rotate: 10, duration: 10, ease: 'none' })
  anim.fromTo(el, { rotate: 0 }, { rotate: 50, duration: 10, ease: 'none' })
  anim.tick(1)
  check('only the newer rotate tween runs', angleOf(el.style.transform, 0) === 5)
  check('the y tween was not killed', /translate\(0px, 1px\)/.test(el.style.transform))
}

// 6. `infinite` tells a loop from an entrance
{
  const el = new FakeHTML()
  const loop = anim.to(el, { rotate: 5, duration: 1, repeat: -1, yoyo: true })
  const once = anim.to(el, { opacity: 0, duration: 1 })
  check('a repeat:-1 tween is infinite', loop.infinite === true)
  check('a one-shot tween is not', once.infinite === false)
}

if (FAILS.length) { console.log(`\n${FAILS.length} FAILED`); process.exit(1) }
console.log('\nall passed')
