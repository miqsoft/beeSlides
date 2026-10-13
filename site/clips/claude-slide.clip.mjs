// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// LIVE: the real Claude Code, in the desktop app's terminal panel, designs a
// slide. Every recording differs, costs usage, and takes minutes; record it
// by name (`npm run clips -- --sheet claude-slide`) and LOOK at the result
// before committing it.
import { deck, text } from './lib/doc.mjs'

const PROMPT = 'Build a two-slide opener for a talk called Honeybee navigation. ' +
  'Slide 1: a striking title slide, subtitle How bees find their way home, warm honey colours ' +
  'on a dark background and a honeycomb motif made of hexagon shapes. ' +
  'Slide 2: a content slide titled The waggle dance with three short points that appear one by one. ' +
  'Give slide 2 a Morph transition so the honeycomb glides into a smaller accent. Keep it clean.'

let term

export default {
  title: 'Ask Claude for slides',
  live: true,
  fixedViewport: false, // the real window: deck and terminal panel side by side
  doc: deck([[text('title', 'Honeybee navigation', 96, 280, 1088, 120)]], 'Honeybee navigation'),
  expect({ doc }) {
    const [one, two] = doc.slides
    if (!two) return `Claude made ${doc.slides.length} slide(s), not 2`
    if ((one.elements ?? []).length < 3) return 'slide 1 is still bare'
    if (!JSON.stringify(doc.slides).includes('Honeybee')) return 'the title is gone'
    if (two.transition !== 'morph' && !two.elements.some((e) => e.fx)) return 'slide 2 has no animation'
  },
  steps: [
    {
      caption: 'Open the Claude Code terminal',
      hint: '⌘` or the terminal button in the title bar',
      async run({ ui }) {
        await ui.click('[data-ui-tool="terminal"]', { hold: 300 })
        term = await ui.terminal()
        await term.waitFor(() => /❯/.test(document.body.innerText), null, { timeout: 60000, what: 'Claude Code to start' })
        await ui.wait(800)
      },
    },
    {
      caption: 'Ask for the slides you want',
      hint: 'Plain words — Claude edits the open deck',
      async run() {
        await term.click('.xterm-screen, .xterm', { hold: 200 })
        await term.type(PROMPT, { delay: 22 })
        await term.press('Enter', { hold: 400 })
      },
    },
    {
      caption: 'Claude builds them in your deck',
      hint: 'Live in the editor — you can keep working meanwhile',
      speedup: 14,
      async run({ ui }) {
        await term.waitForClaude({ timeout: 480000 })
        await ui.wait(1500)
      },
    },
    {
      caption: 'Present it',
      hint: 'Play ▸ Present, then → for each slide and point',
      async run({ ui }) {
        await ui.click('.ed-sidebar .ed-thumb', { hold: 300 }) // from slide 1
        await ui.command('play.inTab', 'Play ▸ Present in tab', { hold: 2500 })
        // Into slide 2, then its points one by one.
        for (let i = 0; i < 4; i++) await ui.press('ArrowRight', { hold: 1800 })
        await ui.wait(1200)
        await ui.press('Escape', { hold: 600 })
      },
    },
  ],
}
