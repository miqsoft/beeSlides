// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Puts the single-file editor into the site so "Try it in your browser"
// opens the real thing: slides/dist-single → public/app/ (gitignored).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
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
