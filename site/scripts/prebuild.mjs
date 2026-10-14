// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Puts the single-file editor into the site so "Try it in your browser"
// opens the real thing: slides/dist-single → public/app/ (gitignored).
// The example decks go along the same way: docs/examples → public/examples/
// (gitignored), so the site and the README open them in the viewer.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = dirname(dirname(fileURLToPath(import.meta.url)))
const built = join(site, '../slides/dist-single/BeeSlides.beeslides.html')
if (existsSync(built)) {
  mkdirSync(join(site, 'public/app'), { recursive: true })
  copyFileSync(built, join(site, 'public/app/BeeSlides.beeslides.html'))
  console.log('prebuild: editor copied to public/app/')
} else {
  console.warn('prebuild: no slides/dist-single build — the site ships without the in-browser editor')
}

const examples = join(site, '../docs/examples')
const decks = readdirSync(examples).filter((f) => f.endsWith('.beeslides.html'))
mkdirSync(join(site, 'public/examples'), { recursive: true })
for (const f of decks) copyFileSync(join(examples, f), join(site, 'public/examples', f))
console.log(`prebuild: ${decks.length} example deck(s) copied to public/examples/`)
