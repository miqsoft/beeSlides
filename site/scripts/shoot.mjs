#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Annotated screenshots for the docs, taken in the real desktop app (dark,
// 2×) the same way clips are recorded (clips/lib/apps.mjs). Each region gets
// a numbered marker; the page explains the numbers.
//
//   npm run shots [-- --repo <checkout>]   → public/shots/<name>.png
//
// Needs slides/dist-single and desktop/out (see record-clips.mjs).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchDesktop } from '../clips/lib/apps.mjs'
import { makeUi } from '../clips/lib/ui.mjs'
import { deck, shape, text } from '../clips/lib/doc.mjs'

const site = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const ri = args.indexOf('--repo')
const repo = resolve(ri >= 0 ? args[ri + 1] : join(site, '..'))

const HEX = 'M50 0 L100 28.87 L100 86.6 L50 115.47 L0 86.6 L0 28.87 Z'
const hex = (id, x, y, s, fill) => shape(id, 'path', x, y, s, s * 1.1547, fill, { d: HEX, pathBox: [0, 0, 100, 115.47] })
const demo = deck([
  [
    text('title', 'Honeybee navigation', 96, 250, 640, 200, { fontSize: 88, lineHeight: 1.05 }),
    text('sub', 'How bees find their way home', 96, 470, 640, 50, { fontSize: 30, fontWeight: 500, color: '#FFC233' }),
    hex('h1', 820, 150, 150, '#FFC233'), hex('h2', 980, 150, 150, '#F5A300'), hex('h3', 900, 290, 150, '#D97F00'),
    hex('h4', 1060, 290, 150, '#FFC233'), hex('h5', 820, 430, 150, '#F5A300'),
  ],
  [text('t2', 'The waggle dance', 96, 72, 900, 90),
    text('b2', 'A figure-eight run that points the way<br>Its length tells the distance', 96, 220, 900, 200, { fontSize: 30, fontWeight: 400, lineHeight: 1.5 })],
  [text('t3', 'Landmarks and the sun', 96, 72, 900, 90),
    text('b3', 'The sun is the compass<br>Landmarks fix the last few metres', 96, 220, 900, 200, { fontSize: 30, fontWeight: 400, lineHeight: 1.5 })],
  [text('t4', 'Questions', 96, 300, 900, 90)],
], 'Honeybee navigation')
demo.slides[0].notes = 'Open with the question: how does a bee find its way back over kilometres?'

const SHOTS = [
  {
    name: 'editor',
    viewport: { width: 1440, height: 900 },
    // [number, region selector, x, y]: marker centre from the region's
    // top-left corner (a negative value counts from the right / bottom).
    // Markers sit in empty space, never on a label.
    marks: [
      [1, '.ed-titlebar', 40, 23],
      [2, '.ed-ribbon-tabs', 380, 18],
      [3, '.ed-ribbon-rows', 1340, 32],
      [4, '.ed-sidebar', 94, -60],
      [5, '.ed-canvas-wrap', 70, 60],
      [6, '.ed-quickbar', -1, 0, 'after'],
      [7, '.ed-props', -34, 22],
      [8, '.ed-notes-pane', -40, 30],
    ],
  },
  // The other two views (View menu), unannotated: a menu command opens each.
  // `crop`: keep only the top this many px (the views leave the rest empty).
  { name: 'view-sorter', viewport: { width: 1280, height: 800 }, command: 'view.sorter', marks: [], crop: 260 },
  { name: 'view-outline', viewport: { width: 1280, height: 800 }, command: 'view.outline', marks: [], crop: 360 },
]

const MARK = (marks) => {
  for (const [n, sel, dx, dy, after] of marks) {
    const r = document.querySelector(sel)?.getBoundingClientRect()
    if (!r) throw new Error('no region ' + sel)
    const x = after ? r.right + 24 : dx >= 0 ? r.left + dx : r.right + dx
    const y = after ? r.top + r.height / 2 : dy >= 0 ? r.top + dy : r.bottom + dy
    const m = document.createElement('div')
    m.setAttribute('data-beeslides-transient', '')
    m.textContent = n
    m.style.cssText = `position:fixed;z-index:2147483647;left:${x - 17}px;top:${y - 17}px;width:34px;height:34px;
      border-radius:50%;background:#FFC233;color:#17120A;font:800 18px/34px -apple-system,system-ui,sans-serif;
      text-align:center;box-shadow:0 0 0 3px #17120A,0 4px 14px rgb(0 0 0/.5);pointer-events:none`
    document.body.append(m)
  }
}

mkdirSync(join(site, 'public/shots'), { recursive: true })
for (const shot of SHOTS) {
  const session = await launchDesktop({ repo, viewport: { ...shot.viewport, scale: 2 }, doc: demo })
  try {
    const ui = makeUi(session.cdp, { app: 'desktop' })
    await ui.wait(800)
    if (shot.command) { await ui.command(shot.command, '', { hold: 800 }) }
    await ui.evaluate(MARK, shot.marks)
    await ui.wait(200)
    const { data } = await session.cdp.send('Page.captureScreenshot', {
      format: 'png', ...(shot.crop && { clip: { x: 0, y: 0, width: shot.viewport.width, height: shot.crop, scale: 1 } }),
    })
    writeFileSync(join(site, 'public/shots', `${shot.name}.png`), Buffer.from(data, 'base64'))
    console.log(`  shot  ${shot.name} → public/shots/${shot.name}.png`)
  } finally {
    await session.close()
  }
}
