#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Records the docs walkthrough clips. Each site/clips/<id>.clip.mjs scenario
// drives the real editor step by step; every step becomes one short MP4 (plus
// a poster) under public/clips/<id>/, listed in public/clips/<id>/clip.json
// for <Walkthrough clip="<id>">.
//
//   npm run clips                     record every scenario in the desktop app
//   npm run clips -- first-deck     record some
//   npm run clips -- --check          run every scenario fast, record nothing
//                                     (a UI change that breaks a clip fails here)
//   npm run clips -- --app web        use the single-file editor in headless
//                                     Chromium instead of the desktop app
//   npm run clips -- --gif …          also write public/clips/<id>/clip.gif, all
//                                     steps in one loop (READMEs, chat, issues)
//   npm run clips -- --sheet …        also write a contact sheet per step to
//                                     .clips-review/ — frames to eyeball (or to
//                                     hand to an AI reviewer) before committing
//   Scenarios marked `live: true` drive the real Claude Code in the desktop
//   app (costs usage, takes minutes, never identical twice): they run only
//   when named, and --check skips them.
//   --repo <checkout>                 take the built apps from another checkout
//                                     (a worktree without node_modules)
//
// Needs: slides/dist-single (cd slides && npm run build:single), ffmpeg on
// PATH, and for the desktop app desktop/out (cd desktop && npx electron-vite
// build) — the desktop app opens a real window while it records; for --app web
// a Chromium playwright-core can launch (npx playwright-core install chromium).
//
// Frames come from the CDP screencast: sharp, with exact timestamps, so they
// cut cleanly at step boundaries.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchDesktop, launchWeb, webUrl, wsSession } from '../clips/lib/apps.mjs'
import { makeUi } from '../clips/lib/ui.mjs'

const site = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true }
const opt = (f) => { const i = args.indexOf(f); if (i < 0) return null; return args.splice(i, 2)[1] }
const check = flag('--check'), sheet = flag('--sheet'), gif = flag('--gif'), headed = flag('--headed')
const app = opt('--app') ?? 'desktop'
const repo = resolve(opt('--repo') ?? join(site, '..'))
const url = opt('--url') ?? webUrl(repo)
if (!['desktop', 'web'].includes(app)) { console.error(`record-clips: --app desktop|web, not ${app}`); process.exit(1) }
if (app === 'web' && !url) { console.error('record-clips: no build — run `npm run build:single` in slides/ or pass --url'); process.exit(1) }

const all = readdirSync(join(site, 'clips')).filter((f) => f.endsWith('.clip.mjs')).map((f) => f.slice(0, -9)).sort()
const ids = args.length ? args : all
for (const id of ids) if (!all.includes(id)) { console.error(`record-clips: no scenario clips/${id}.clip.mjs`); process.exit(1) }

// Page errors fail a clip, except these: Moveable throws on the synthetic
// pointer moves that follow a click (its drag state is never started, see
// slides/src/editor/CLAUDE.md "Testing the editor DOM"). Reported, not fatal.
const KNOWN_NOISE = [/setting 'dist'/]
const HOLD_MS = 900        // the result of a step stays on screen this long
const MAX_WIDTH = 2560     // encode at the 2× capture's own width, up to this
const fit = ({ width: w, height: h }) =>
  `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0D0B08,setsar=1`
// The "N× faster" badge burned into a time-lapsed step, so the video itself
// says it was sped up (the GIF has no player around it). Drawn by Chromium:
// this ffmpeg may have no drawtext.
async function speedBadge(label, file, scale) {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch()
  const page = await browser.newPage({ deviceScaleFactor: scale })
  await page.setContent(`<body style="margin:0;background:transparent"><div id="b" style="display:inline-flex;align-items:center;gap:10px;
    padding:10px 18px;border-radius:999px;background:rgba(23,18,10,.88);border:2px solid #FFC233;color:#FFC233;
    font:700 24px/1 -apple-system,system-ui,sans-serif;letter-spacing:.02em">
    <svg width="26" height="20" viewBox="0 0 26 20"><path d="M1 1l11 9-11 9zM13 1l11 9-11 9z" fill="#FFC233"/></svg>${label}</div></body>`)
  await page.locator('#b').screenshot({ path: file, omitBackground: true })
  await browser.close()
}
const ffmpeg = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a])

let failed = 0
for (const id of ids) {
  const scenario = (await import(pathToFileURL(join(site, 'clips', `${id}.clip.mjs`)).href)).default
  if (scenario.live && (check || !args.includes(id))) { console.log(`  skip  ${id} (live: name it to record)`); continue }
  if (scenario.live && app !== 'desktop') { console.log(`  skip  ${id} (live clips need the desktop app)`); continue }
  const fixedViewport = scenario.fixedViewport ?? true
  const viewport = { width: 1280, height: 720, ...scenario.viewport, scale: check ? 1 : 2 }
  let session
  try {
    session = app === 'desktop'
      ? await launchDesktop({ repo, viewport, doc: scenario.doc, fixedViewport })
      : await launchWeb({ url, viewport, headed })
  } catch (e) { failed++; console.log(`  FAIL  ${id}: ${e.message}`); continue }
  const { cdp } = session

  // Every view being recorded: the deck, plus any the scenario attaches
  // (the desktop terminal panel), each with its own screencast.
  const views = [{ name: 'doc', cdp, frames: [] }]
  let recording = false
  const startCast = async (v) => {
    v.cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      v.frames.push({ t: metadata.timestamp * 1000, data, w: metadata.deviceWidth, h: metadata.deviceHeight })
      v.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    })
    await v.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 })
  }
  const attachView = session.port && (async (name, match) => {
    for (let i = 0; i < 40; i++) {
      const list = await fetch(`http://127.0.0.1:${session.port}/json/list`).then((r) => r.json()).catch(() => [])
      const t = list.find((t) => t.type === 'page' && match(t))
      if (t) {
        const v = { name, cdp: await wsSession(t.webSocketDebuggerUrl), frames: [] }
        await v.cdp.send('Page.enable')
        views.push(v)
        if (recording) await startCast(v)
        return v.cdp
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`no ${name} view appeared`)
  })
  const ui = makeUi(cdp, { pace: check ? 0.2 : 1, app, attachView })
  const errors = []
  let stepNo = 'setup'
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) =>
    errors.push(`[step ${stepNo}] ${d.exception?.description?.split('\n')[0] ?? d.text}`))

  try {
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    if (scenario.doc && app === 'web') await ui.loadDoc(scenario.doc)
    await scenario.setup?.({ ui })
    if (!check) await ui.overlay()
    await ui.wait(400)

    if (!check) { recording = true; for (const v of views) await startCast(v); await ui.wait(300) }
    const marks = []
    for (const [i, step] of scenario.steps.entries()) {
      stepNo = i + 1
      const start = Date.now()
      try { await step.run({ ui }) } catch (e) { throw new Error(`step ${i + 1} "${step.caption}": ${e.message.split('\n')[0]}`) }
      if (!check) await ui.wait(HOLD_MS)
      marks.push([start, Date.now()])
    }
    const noise = errors.filter((m) => KNOWN_NOISE.some((r) => r.test(m)))
    const real = errors.filter((m) => !noise.includes(m))
    if (real.length) throw new Error(`page error: ${real[0]}`)
    if (noise.length) console.log(`  note  ${id}: ${noise.length} known Moveable page error(s) ignored`)
    if (scenario.expect) {
      const why = await scenario.expect({ doc: await ui.evaluate(() => window.slidomingo.doc), app })
      if (why) throw new Error(`expect: ${why}`)
    }
    if (check) { console.log(`  ok    ${id} (${marks.length} steps, ${app})`); continue }

    for (const v of views) await v.cdp.send('Page.stopScreencast').catch(() => {})
    const out = join(site, 'public/clips', id)
    rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true })
    // The output box takes the window's shape (the first deck frame, before
    // any panel opened); fixed-viewport clips are 16:9 by construction.
    const first = views[0].frames[0]
    const even = (n) => Math.round(n / 2) * 2
    const outW = even(Math.min(MAX_WIDTH, first.w * 2))
    const manifest = { id, app, width: outW, height: even(outW * first.h / first.w), steps: [] }
    for (const [i, [start, end]] of marks.entries()) {
      const tmp = mkdtempSync(join(tmpdir(), 'bee-clip-'))
      // One concat list per view: the frame on screen when the step began,
      // then every frame during it. A view with nothing on screen yet at the
      // step's start (the terminal before it opened) sits this step out.
      const lists = []
      for (const v of views) {
        const before = v.frames.filter((f) => f.t <= start).at(-1)
        if (!before && v !== views[0]) continue
        const seg = [...(before ? [{ ...before, t: start }] : []), ...v.frames.filter((f) => f.t > start && f.t <= end)]
        if (!seg.length) throw new Error(`step ${i + 1}: no frames captured`)
        let list = ''
        seg.forEach((f, j) => {
          const file = join(tmp, `${v.name}-${j}.jpg`)
          writeFileSync(file, Buffer.from(f.data, 'base64'))
          list += `file '${file}'\nduration ${Math.max(0.001, ((seg[j + 1]?.t ?? end) - f.t) / 1000).toFixed(3)}\n`
        })
        list += `file '${join(tmp, `${v.name}-${seg.length - 1}.jpg`)}'\n` // concat needs the last frame twice
        writeFileSync(join(tmp, `${v.name}.txt`), list)
        lists.push({ file: join(tmp, `${v.name}.txt`), last: seg.at(-1) })
      }
      const name = `${String(i + 1).padStart(2, '0')}`
      // Long waits (Claude working) play time-lapsed: at most `speedup` s.
      const cap = scenario.steps[i].speedup
      const factor = cap && (end - start) > cap * 1000 ? (end - start) / (cap * 1000) : 1
      const speed = factor > 1 ? `setpts=PTS/${factor.toFixed(3)},` : ''
      const inputs = lists.flatMap((l) => ['-f', 'concat', '-safe', '0', '-i', l.file])
      // Several views: side by side at their real widths (the panels of one
      // window), then fitted into the output box like a single view.
      const H = even(Math.max(...lists.map((l) => l.last.h)) * 2)
      let graph = lists.length === 1
        ? `[0:v]${fit(manifest)},${speed}fps=30[base]`
        : lists.map((l, j) => `[${j}:v]${fit({ width: even(l.last.w * 2), height: H })}[p${j}]`).join(';') +
          `;${lists.map((_, j) => `[p${j}]`).join('')}hstack=inputs=${lists.length},${fit(manifest)},${speed}fps=30[base]`
      if (factor > 1) {
        const png = join(tmp, 'badge.png')
        await speedBadge(`${Math.round(factor)}× faster`, png, manifest.width / 1280)
        inputs.push('-loop', '1', '-i', png)
        graph += `;[base][${lists.length}:v]overlay=main_w-overlay_w-main_w/40:main_h/30:shortest=1,format=yuv420p[v]`
      } else graph += ';[base]format=yuv420p[v]'
      ffmpeg(...inputs, '-filter_complex', graph, '-map', '[v]',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-tune', 'stillimage', '-movflags', '+faststart', '-an', join(out, `${name}.mp4`))
      ffmpeg('-sseof', '-0.1', '-i', join(out, `${name}.mp4`), '-frames:v', '1', '-q:v', '4', join(out, `${name}.jpg`))
      if (sheet) {
        mkdirSync(join(site, '.clips-review'), { recursive: true })
        ffmpeg('-i', join(out, `${name}.mp4`), '-vf', 'fps=2,scale=480:-2,tile=4x3:padding=4', '-frames:v', '1',
          join(site, '.clips-review', `${id}-${name}.jpg`))
      }
      rmSync(tmp, { recursive: true, force: true })
      manifest.steps.push({ file: `${name}.mp4`, poster: `${name}.jpg`, ms: end - start, ...(factor > 1 && { speedup: Math.round(factor) }) })
    }
    if (gif) {
      const list = join(out, 'steps.txt')
      writeFileSync(list, manifest.steps.map((st) => `file '${join(out, st.file)}'`).join('\n') + '\n')
      ffmpeg('-f', 'concat', '-safe', '0', '-i', list, '-vf',
        'fps=12,scale=1200:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
        '-loop', '0', join(out, 'clip.gif'))
      rmSync(list)
    }
    writeFileSync(join(out, 'clip.json'), JSON.stringify(manifest, null, 2) + '\n')
    const secs = manifest.steps.reduce((s, x) => s + x.ms, 0) / 1000
    console.log(`  rec   ${id}: ${manifest.steps.length} steps, ${secs.toFixed(1)} s (${app}) → public/clips/${id}/`)
  } catch (e) {
    failed++
    console.log(`  FAIL  ${id}: ${e.message}`)
    mkdirSync(join(site, '.clips-review'), { recursive: true })
    try {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(site, '.clips-review', `${id}-FAILED.png`), Buffer.from(data, 'base64'))
    } catch { /* the app is gone */ }
  } finally {
    await session.close()
  }
}
process.exit(failed ? 1 : 0)
