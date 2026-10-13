#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Media autoplay rig.
//
//   node scripts/test-media-autoplay.ts
//
// WHAT THIS PROVES. An author sets a clip's Autoplay to Off and it played
// anyway, every time its slide came up in a show (reported 2026-08-22, present
// since media shipped in v0.9.16).
//
// Two innocent halves. render.ts wrote the flag as
//
//     dataset.autoplay = el.autoplay ? '1' : ''
//
// which emits data-autoplay="" — the attribute PRESENT but empty. Our own
// present.ts reads the VALUE and was never wrong:
//
//     querySelectorAll('video[data-autoplay="1"], audio[data-autoplay="1"]')
//
// but Reveal decides first, and it decides on PRESENCE:
//
//     hasAttribute('data-autoplay') || closest('.slide-background')
//
// So the property worth pinning is NOT "our selector ignores an empty value" —
// that was always true and the bug happened anyway. It is that **an
// autoplay-off element carries no such attribute at all**, because the
// attribute's presence is read by code we do not own and cannot change.
//
// It therefore has to be measured on rendered DOM rather than read off the
// source: the difference between assigning '' and not assigning is invisible
// in a grep and decisive in a browser. The probe is bundled against the repo's
// own render.ts, so this is the shipping path, not a re-implementation.
//
// Self-skips where there is no Chrome, so it never blocks a machine that
// cannot run it — the same bargain scripts/test-sanitize.ts makes.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoFile = (p: string) => path.join(root, p)

let failures = 0
let checks = 0
const ok = (cond: boolean, msg: string) => {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const CHROME = [
  process.env.SLIDOMINGO_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p): p is string => !!p && fs.existsSync(p))
  ?? (spawnSync('which', ['google-chrome']).status === 0 ? 'google-chrome' : undefined)

// The probe. No backticks or ${ so it survives the template literal below.
const probeSource = (renderPath: string, modelPath: string) => `
import { renderElement } from ${JSON.stringify(renderPath)}
import { newDoc, defaultMedia } from ${JSON.stringify(modelPath)}

const doc = newDoc()
const out: string[] = []

function attrOf(kind: 'audio' | 'video', autoplay: boolean): string {
  const el = defaultMedia(kind, 'data:audio/mpeg;base64,AAAA', { autoplay })
  const node = renderElement(el as any, doc, { liveMedia: true } as any)
  document.body.appendChild(node)
  const media = node.querySelector(kind)
  if (!media) return 'NO-ELEMENT'
  // hasAttribute is EXACTLY what Reveal asks. Anything else would test a
  // different question than the one that broke.
  return media.hasAttribute('data-autoplay')
    ? 'present:' + JSON.stringify(media.getAttribute('data-autoplay'))
    : 'absent'
}

out.push('audio-off=' + attrOf('audio', false))
out.push('audio-on=' + attrOf('audio', true))
out.push('video-off=' + attrOf('video', false))
out.push('video-on=' + attrOf('video', true))

const marker = document.createElement('div')
marker.id = 'slidomingo-results'
marker.textContent = out.join(' | ')
document.body.appendChild(marker)
`

if (!CHROME) {
  console.log('  skip  no Chrome found — set SLIDOMINGO_CHROME to run the rendered-DOM checks')
  console.log('\n0/0 checks passed (skipped)')
  process.exit(0)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slidomingo-autoplay-'))
const entry = path.join(tmp, 'probe.ts')
fs.writeFileSync(entry, probeSource(repoFile('slides/src/render.ts'), repoFile('slides/src/model.ts')))
execFileSync(repoFile('slides/node_modules/.bin/esbuild'), [
  entry, '--bundle', '--format=iife', '--outfile=' + path.join(tmp, 'probe.js'),
], { stdio: 'pipe' })
// A CLASSIC script loaded from file://: a module script would be blocked by
// the file:// origin rules, and a classic src needs no server at all (this
// rig, unlike the sanitizer's, never navigates). NOT inlined: --dump-dom
// prints every inline script back, and the bundle alone (render.ts pulls in
// charts-lite and the rest, ~1.1 MB) overran execFileSync's 1 MB stdout
// buffer — the rig died with ENOBUFS before it checked anything. Referenced
// by src, the dump is a few hundred bytes plus the results.
// Built by concatenation — never a literal script-close in a source file.
const page = '<!doctype html><meta charset="utf-8"><title>slidomingo autoplay probe</title><body>'
  + '<scr' + 'ipt src="probe.js"></scr' + 'ipt></body>'
const pagePath = path.join(tmp, 'probe.html')
fs.writeFileSync(pagePath, page)

const dom = execFileSync(CHROME, [
  '--headless', '--disable-gpu', '--no-sandbox', '--dump-dom',
  '--allow-file-access-from-files', 'file://' + pagePath,
  // headroom only: the dump no longer carries the bundle
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })

const m = dom.match(/<div id="slidomingo-results">([^<]*)<\/div>/)
ok(!!m, 'the probe ran and reported (if this fails, nothing below means anything)')
const results = Object.fromEntries((m?.[1] ?? '').split(' | ').map((p) => p.split('=') as [string, string]))

ok(results['audio-off'] === 'absent',
  `audio with Autoplay OFF carries NO data-autoplay at all (got ${results['audio-off']})`)
ok(results['video-off'] === 'absent',
  `video with Autoplay OFF carries NO data-autoplay at all (got ${results['video-off']})`)
ok(results['audio-on'] === 'present:"1"',
  `audio with Autoplay ON still carries data-autoplay="1" (got ${results['audio-on']})`)
ok(results['video-on'] === 'present:"1"',
  `video with Autoplay ON still carries data-autoplay="1" (got ${results['video-on']})`)

// The regression, stated as Reveal would see it. An empty string is present,
// which is the whole bug: a check written as "is it not '1'" would have passed
// on the broken build.
ok(results['audio-off'] !== 'present:""' && results['video-off'] !== 'present:""',
  'and specifically not the empty attribute Reveal treats as "yes"')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
