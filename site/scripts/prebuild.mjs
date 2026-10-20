// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Puts the single-file editor into the site so "Try it in your browser"
// opens the real thing: slides/dist-single → public/app/ (gitignored).
// The example decks go along the same way: docs/examples → public/examples/
// (gitignored), so the site and the README open them in the viewer.
// The bee deck also goes into a copy of the editor (public/app/), so
// "Edit the example" opens a real deck to change, not an empty one.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

// The splice contract (docs/PLATFORM.md): swap the editor's doc block for the
// example's, minus `readonly` (that flag is what makes it present-only). The
// docId stays the example's own.
const DOC_BLOCK_RE = /(<script[^>]*\bid=["']beeslides-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i
const EDITABLE = 'how-bees-fly.beeslides.html'
if (existsSync(built)) {
  const shell = readFileSync(built, 'utf8')
  const m = readFileSync(join(examples, EDITABLE), 'utf8').match(DOC_BLOCK_RE)
  if (!m || !DOC_BLOCK_RE.test(shell)) throw new Error(`prebuild: no doc block to splice for ${EDITABLE}`)
  const { readonly: _, ...doc } = JSON.parse(m[2])
  const json = JSON.stringify(doc).replace(/</g, '\\u003c')
  // a replacer function, so a `$` in the JSON is never read as a pattern
  const html = shell.replace(DOC_BLOCK_RE, (_m, open, _body, close) => `${open}\n${json}\n${close}`)
  writeFileSync(join(site, 'public/app', EDITABLE), html)
  console.log(`prebuild: ${EDITABLE} spliced into the editor at public/app/`)
}
