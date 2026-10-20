#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Desktop global-library E2E (docs/DECISIONS.md 2026-09-28, "Scope split"):
// the app keeps ONE element library for the user, next to the templates
// folder, created on first run.
//
//   cd desktop && npx electron-vite build && node scripts/e2e-library.mjs
//   (needs slides/dist-single built; E2E_SHOW=1 shows the windows)
//
// Same two-mode shape as e2e-template-window.mjs: run with node it
// ORCHESTRATES — a throwaway profile, templates folder and library path, one
// Electron launch per step, disk checks after each — and run by Electron it
// DRIVES the real built main process from inside, with native dialogs stubbed.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const repo = resolve(desktopDir, '..')
const SHELL_PATH = join(repo, 'slides/dist-single/BeeSlides.beeslides.html')
const BLOCK_RE = /(<script[^>]*\bid=["']beeslides-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readDoc = (p) => JSON.parse(readFileSync(p, 'utf8').match(BLOCK_RE)[2].trim())
const items = (p) => readDoc(p).slides.filter((s) => s.elements.length).map((s) => s.name)

let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) failures++
  try { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`) } catch { /* pipe gone */ }
}

// No top-level await in Electron mode (an ESM entry that awaits holds `ready`).
if (process.versions.electron) {
  driver().catch(async (err) => {
    ok(false, `driver error: ${err?.stack ?? err}`)
    try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ }
    const { app } = await import('electron')
    app.exit(4)
  })
}
else await orchestrator()

// =================================================================================
// DRIVER (inside Electron)
// =================================================================================
async function driver() {
  const { app, dialog, BrowserWindow, webContents } = await import('electron')
  const step = process.env.E2E_STEP
  const arg = JSON.parse(process.env.E2E_ARG || '{}')
  dialog.showMessageBox = async () => ({ response: 1 })
  dialog.showOpenDialog = async () => (arg.pick ? { canceled: false, filePaths: [arg.pick] } : { canceled: true, filePaths: [] })
  if (!process.env.E2E_SHOW) {
    BrowserWindow.prototype.show = function () {}
    BrowserWindow.prototype.focus = function () {}
    app.dock?.hide()
  }
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  const hardStop = setTimeout(() => { ok(false, `step ${step} timed out`); report(); app.exit(3) }, 90000)

  const docWcs = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && /BeeSlides\.beeslides\.html/.test(w.getURL()))
  async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn().catch(() => null)
      if (v) return v
      if (Date.now() > end) return null
      await sleep(150)
    }
  }
  const js = (wc, fn, a) => wc.executeJavaScript(`(${fn})(${JSON.stringify(a ?? null)})`)
  async function page(pred, ms) {
    return waitFor(async () => {
      for (const wc of docWcs()) {
        if (wc.isLoading()) continue
        if (await wc.executeJavaScript(`!!(${pred})`).catch(() => false)) return wc
      }
      return null
    }, ms)
  }
  const EDITOR = 'window.beeslides && window.beeslides.doc && document.querySelector("button[title^=\\"Your library\\"]")'
  function report() { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ } }
  const quit = () => { report(); clearTimeout(hardStop); app.quit() }
  const panelNames = (wc) => js(wc, () => [...document.querySelectorAll('.ed-library-panel .ed-library-item-name')].map((e) => e.textContent))

  if (step === 'first-run') {
    ok(existsSync(arg.lib), 'the default library exists as soon as the app is ready')
    const wc = await page(EDITOR)
    ok(!!wc, 'the editor opened the deck')
    const info = await js(wc, () => window.slidomingoDesktop.readLibrary().then((r) => ({ ok: r.ok, isDefault: r.isDefault, name: r.name })))
    ok(info.ok && info.isDefault && info.name === 'BeeSlides Library.beeslides.html', `the renderer reads it through main (${JSON.stringify(info)})`)
    // Library panel: no "Choose file…" step on desktop — it opens the default library.
    await js(wc, () => document.querySelector('button[title^="Your library"]').click())
    const empty = await waitFor(() => js(wc, () => document.querySelector('.ed-library-panel .ed-library-status')?.textContent.includes('Your library is empty')))
    ok(!!empty, 'the panel opens the default library straight away (empty)')
    ok(await js(wc, () => document.querySelector('.ed-library-panel .ed-library-file')?.textContent) === 'BeeSlides Library.beeslides.html', 'and names it')
    ok(await js(wc, () => [...document.querySelectorAll('.ed-library-panel .ed-btn')].find((b) => b.textContent === 'Use default library')?.hidden === true), '"Use default library" hidden while it is in use')
    await js(wc, () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    // Insert a text box (it becomes the selection), then Save selection… → Library.
    await js(wc, () => document.querySelector('button[title^="Add a text box"]').click())
    ok(!!await waitFor(() => js(wc, () => !document.querySelector('button[title^="Save the selected elements"]').disabled)), 'a selection enables "Save selection…"')
    await js(wc, () => document.querySelector('button[title^="Save the selected elements"]').click())
    await waitFor(() => js(wc, () => !!document.querySelector('.ed-saveselection')))
    await js(wc, () => {
      const box = document.querySelector('.ed-saveselection')
      box.querySelector('input').value = 'Desktop text'
      ;[...box.querySelectorAll('.ed-newtype-modebtn')].find((b) => b.textContent === 'Library').click()
      ;[...box.querySelectorAll('.ed-btn')].find((b) => b.textContent === 'Save').click()
    })
    ok(!!await waitFor(async () => items(arg.lib).includes('Desktop text'), 8000), 'Save selection… → Library writes the default library file')
    ok(readDoc(arg.lib).slides.length === 1, 'the empty placeholder slide gave way to the first item')
    quit()
  }

  if (step === 'restart') {
    ok(existsSync(arg.lib), 'the library is still there after a restart')
    const wc = await page(EDITOR)
    await js(wc, () => document.querySelector('button[title^="Your library"]').click())
    const names = await waitFor(async () => { const n = await panelNames(wc); return n.length ? n : null })
    ok(JSON.stringify(names) === '["Desktop text"]', `and it opens with its item (${JSON.stringify(names)})`)
    // Choose another file (native dialog stubbed) — remembered in app settings.
    const chosen = await js(wc, () => window.slidomingoDesktop.chooseLibrary())
    ok(chosen?.path === arg.pick, 'Choose file… switches to the picked file')
    quit()
  }

  if (step === 'chosen-remembered') {
    const wc = await page(EDITOR)
    const info = await js(wc, () => window.slidomingoDesktop.readLibrary().then((r) => ({ ok: r.ok, isDefault: r.isDefault, path: r.path })))
    ok(info.ok && !info.isDefault && info.path === arg.pick, `a chosen library is remembered across restarts (${JSON.stringify(info)})`)
    await js(wc, () => document.querySelector('button[title^="Your library"]').click())
    const names = await waitFor(async () => { const n = await panelNames(wc); return n.length ? n : null })
    ok(JSON.stringify(names) === '["Team logo"]', `the panel shows the chosen file's items (${JSON.stringify(names)})`)
    ok(await js(wc, () => [...document.querySelectorAll('.ed-library-panel .ed-btn')].find((b) => b.textContent === 'Use default library')?.hidden === false), '"Use default library" offered')
    await js(wc, () => [...document.querySelectorAll('.ed-library-panel .ed-btn')].find((b) => b.textContent === 'Use default library').click())
    const back = await waitFor(async () => { const n = await panelNames(wc); return JSON.stringify(n) === '["Desktop text"]' ? n : null })
    ok(!!back, 'and switches back to the default library')
    quit()
  }
}

// =================================================================================
// ORCHESTRATOR (plain node)
// =================================================================================
async function orchestrator() {
  const electronPath = createRequire(join(desktopDir, 'package.json'))('electron')
  if (!existsSync(SHELL_PATH)) { console.error('build slides first: cd slides && npm run build:single'); process.exit(2) }
  const shell = readFileSync(SHELL_PATH, 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-lib-'))
  const userData = join(root, 'userData')
  const templatesDir = join(root, 'Documents', 'BeeSlides Templates')
  const work = join(root, 'work')
  for (const d of [userData, templatesDir, work]) mkdirSync(d, { recursive: true })
  const lib = join(root, 'Documents', 'BeeSlides Library.beeslides.html')
  const deckHtml = (doc) => shell.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`)

  const { newDoc } = await import(join(repo, 'slides/src/model.ts'))
  const deckPath = join(work, 'Deck.beeslides.html')
  writeFileSync(deckPath, deckHtml(Object.assign(newDoc(), { title: 'Deck' })))
  const pick = join(work, 'Team library.beeslides.html')
  const team = Object.assign(newDoc(), { title: 'Team library' })
  team.slides = [{ id: 'team-1', name: 'Team logo', background: '#FFFFFF', transition: 'fade', notes: '', elements: [
    { id: 'tl1', type: 'shape', shape: 'rect', x: 10, y: 10, w: 100, h: 60, rotation: 0, opacity: 1, fill: '#123456', stroke: 'transparent', strokeWidth: 0, radius: 0 },
  ] }]
  writeFileSync(pick, deckHtml(team))

  function run(step, arg = {}) {
    console.log(`\n# ${step}`)
    // No SLIDOMINGO_LIBRARY_PATH: the default must follow the templates
    // folder (its sibling), exactly as on a real machine.
    const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', deckPath], {
      cwd: desktopDir,
      env: {
        ...process.env, E2E_STEP: step, E2E_ARG: JSON.stringify(arg),
        SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: templatesDir, SLIDOMINGO_LIBRARY_PATH: '',
        ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '',
      },
      encoding: 'utf8', timeout: 120000,
    })
    const out = res.stdout ?? ''
    for (const line of out.split('\n')) if (/^\s+(ok|FAIL)\s/.test(line)) console.log(line)
    const m = out.match(/E2E_RESULT (\d+) (\d+)/)
    if (!m) { checks++; failures++; console.log(`  FAIL  step ${step} produced no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-15).join('\n')}`); return }
    checks += Number(m[1]); failures += Number(m[2])
  }

  ok(!existsSync(lib), 'no library before the first run')
  run('first-run', { lib })
  run('restart', { lib, pick })
  ok(JSON.stringify(items(lib)) === '["Desktop text"]', 'choosing another file left the default library alone')
  run('chosen-remembered', { lib, pick })

  console.log(`\n${checks - failures}/${checks} checks passed   (profile: ${root})`)
  if (failures) process.exit(1)
}
