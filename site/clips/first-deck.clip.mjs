// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The "Your first deck" tour, and the CI smoke test (`npm run clips -- --check
// --app web`): add a slide, type its title, present it.
import { deck } from './lib/doc.mjs'

const TITLE = 'Hello, honeybees'
// Like New deck ▸ Blank: one empty white slide.
const blank = deck([[]], 'My first deck')
blank.theme = { ...blank.theme, background: '#FFFFFF', color: '#1D1119' }
blank.slides[0].background = '#FFFFFF'

export default {
  title: 'Your first slide',
  doc: blank,
  // The scenario must leave the deck in the state its captions promise.
  expect({ doc }) {
    if (doc.slides.length !== 2) return `expected 2 slides, got ${doc.slides.length}`
    if (!doc.slides[1].elements.some((e) => e.type === 'text' && e.html?.includes(TITLE))) return 'slide 2 has no title'
  },
  steps: [
    {
      caption: 'Add a slide',
      hint: 'New slide, then pick a slide type',
      async run({ ui }) {
        await ui.click('.ed-sidebar .ed-add-slide')
        await ui.click({ css: '.ed-layoutpick-item', text: 'Title' }, { hold: 500 })
      },
    },
    {
      caption: 'Type a title',
      hint: 'Click the placeholder and type',
      async run({ ui }) {
        await ui.dblclick({ css: '.ed-canvas-wrap [data-el-id]', text: 'Click to add title' })
        await ui.type(TITLE)
        await ui.deselect()
        await ui.rest(200)
      },
    },
    {
      caption: 'Present it',
      hint: 'Present or F5 — Esc ends the show',
      async run({ ui }) {
        await ui.click('.ed-sidebar .ed-thumb')
        // Presents in the window: fullscreen moves the show to another display
        // on desktop, and headless Chromium ignores the window size.
        await ui.command('play.inTab', 'Play ▸ Present in tab', { hold: 1200 })
        await ui.press('ArrowRight', { hold: 1500 })
        await ui.press('Escape', { hold: 600 })
      },
    },
  ],
}
