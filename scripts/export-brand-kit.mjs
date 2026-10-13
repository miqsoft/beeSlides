#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Renders the shareable BeeSlides brand kit into docs/assets/brand/: the logo
// as SVG and PNGs, the logo + wordmark lockups, and the start-up animation
// (the boot splash of slides/index.html) as MP4 and GIF. Everything comes from
// the single sources — logoSvg()/BRAND in slides/src/brand.ts and the splash
// markup + CSS in slides/index.html — so rerun this after changing the mark
// or the splash (after build-brand-assets.mjs, which regenerates the splash).
//
//   node scripts/export-brand-kit.mjs
//
// Node ≥ 22.18 / 23.6 (native TypeScript type-stripping imports brand.ts).
// Needs ffmpeg on PATH, plus playwright-core and a Chromium it can launch,
// found the same way as export-app-icon.mjs: `import('playwright-core')`, then
// the path in $PLAYWRIGHT_CORE (…/node_modules/playwright-core/index.mjs).
// The wordmark is set in the system UI font (as in the app), so render on a
// Mac to match the shipped look.
//
// The video frames are not screen-recorded: every CSS animation on the page is
// paused and stepped to each frame's time, so the output is deterministic and
// never drops a frame.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BRAND, logoSvg } from '../slides/src/brand.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'docs/assets/brand')
const rel = (f) => `docs/assets/brand/${f}`

async function loadPlaywright() {
  try {
    return await import('playwright-core')
  } catch {
    const p = process.env.PLAYWRIGHT_CORE
    if (!p) {
      console.error('playwright-core not found. Install it, or set PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.mjs')
      process.exit(1)
    }
    return import(pathToFileURL(p).href)
  }
}

try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
} catch {
  console.error('ffmpeg not found on PATH (brew install ffmpeg)')
  process.exit(1)
}

// ── The splash, lifted from slides/index.html ─────────────────────────────
// Same extraction as postbuild-compress.mjs: the splash div ends at its
// loading bar's `</div></div>`, and its CSS is the next <style>.
const indexHtml = readFileSync(join(root, 'slides/index.html'), 'utf8')
const splashMatch = indexHtml.match(/<div id="slidomingo-splash"[\s\S]*?<\/div>\s*<\/div>/)
if (!splashMatch) throw new Error('slides/index.html: splash div not found')
const splashDiv = splashMatch[0]
const splashCss = indexHtml.slice(splashMatch.index + splashDiv.length).match(/<style>([\s\S]*?)<\/style>/)?.[1]
if (!splashCss || !splashCss.includes('#slidomingo-splash')) throw new Error('slides/index.html: splash <style> not found')

const DURATION = 5, FADE = 0.5 // seconds: the intro, then a fade back to the
// splash background so the GIF (and a looped MP4) restarts seamlessly
const splashBg = splashCss.match(/#slidomingo-splash\{[^}]*?background:([^;}]+)/)?.[1]
if (!splashBg) throw new Error('slides/index.html: splash background not found')

// For sharing, the loading bar goes (nothing is loading) and so does the
// splash's 9s self-dismiss; the rest plays exactly as at start-up.
const splashPage = `<!doctype html><html><head><meta charset="utf-8"><style>${splashCss}
.bs-bar{display:none}
#slidomingo-splash{animation:none}
#fade{position:fixed;inset:0;z-index:10000;background:${splashBg};opacity:0;animation:fade ${FADE}s linear ${DURATION - FADE}s both}
@keyframes fade{to{opacity:1}}
</style></head><body style="margin:0">${splashDiv}<div id="fade"></div></body></html>`

// ── Stills ───────────────────────────────────────────────────────────────
const stillPage = (inner, bg = 'transparent') =>
  `<!doctype html><html><head><meta charset="utf-8"><style>svg{display:block}body{margin:0;background:${bg}}
.lockup{display:inline-flex;align-items:center;gap:40px;padding:48px 64px 48px 48px}
.word{font:600 108px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;letter-spacing:-.01em;white-space:nowrap}
</style></head><body><div id="x" style="display:inline-block">${inner}</div></body></html>`

const lockup = (bee, slides) =>
  `<div class="lockup">${logoSvg(176, { id: 'lk' })}<div class="word"><span style="color:${bee}">Bee</span><span style="color:${slides}">Slides</span></div></div>`

const { chromium } = await loadPlaywright()
const browser = await chromium.launch()
const written = []
const save = (name, data) => { writeFileSync(join(outDir, name), data); written.push(rel(name)) }

async function still(name, inner, { scale = 1 } = {}) {
  const page = await browser.newPage({ viewport: { width: 2000, height: 1200 }, deviceScaleFactor: scale })
  try {
    await page.setContent(stillPage(inner))
    save(name, await page.locator('#x').screenshot({ omitBackground: true }))
  } finally {
    await page.close()
  }
}

async function video(name, { width, height, scale, fps }) {
  const frames = mkdtempSync(join(tmpdir(), 'beeslides-'))
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale })
  try {
    await page.setContent(splashPage)
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()))
    const n = Math.round(DURATION * fps)
    for (let i = 0; i < n; i++) {
      await page.evaluate((ms) => document.getAnimations().forEach((a) => { a.currentTime = ms }), (i * 1000) / fps)
      await page.screenshot({ path: join(frames, `f${String(i).padStart(4, '0')}.png`) })
    }
    const seq = join(frames, 'f%04d.png')
    const out = join(outDir, name)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', seq,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out])
    written.push(rel(name))
    return frames
  } catch (e) {
    rmSync(frames, { recursive: true, force: true })
    throw e
  } finally {
    await page.close()
  }
}

try {
  mkdirSync(outDir, { recursive: true })

  save('beeslides-logo.svg', logoSvg(512, { id: 'bl' }) + '\n')
  for (const size of [1024, 512, 256]) await still(`beeslides-logo-${size}.png`, logoSvg(size, { id: 'bl' }))
  await still('beeslides-mark-1024.png', logoSvg(1024, { id: 'bm', tile: false }))
  await still('beeslides-lockup-on-dark.png', lockup(BRAND.honey, BRAND.cream), { scale: 2 })
  await still('beeslides-lockup-on-light.png', lockup(BRAND.honeyOnLight, BRAND.night), { scale: 2 })

  // 16:9 and square at 5×: the 104px splash mark fills half the frame height,
  // rendered as crisp vectors rather than upscaled.
  const wide = await video('beeslides-intro-1920x1080.mp4', { width: 384, height: 216, scale: 5, fps: 60 })
  // the settled frame (the intro is done by ~2s) as a poster / link preview
  execFileSync('cp', [join(wide, `f${String(Math.round(2.6 * 60)).padStart(4, '0')}.png`), join(outDir, 'beeslides-poster-1920x1080.png')])
  written.push(rel('beeslides-poster-1920x1080.png'))
  rmSync(wide, { recursive: true, force: true })

  const square = await video('beeslides-intro-1080x1080.mp4', { width: 216, height: 216, scale: 5, fps: 50 })
  // GIF: every other frame (25 fps = 4cs per frame, which GIF stores exactly), 480px
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '50', '-i', join(square, 'f%04d.png'),
    '-vf', 'fps=25,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a',
    '-loop', '0', join(outDir, 'beeslides-intro.gif')])
  written.push(rel('beeslides-intro.gif'))
  rmSync(square, { recursive: true, force: true })
} finally {
  await browser.close()
}

console.log(`brand kit written:\n  ${written.join('\n  ')}`)
