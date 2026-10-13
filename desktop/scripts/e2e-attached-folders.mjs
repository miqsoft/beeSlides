#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Attached-folders E2E: folders the user attaches to a deck's AI chats reach
// `claude` as extra `--add-dir`s (from env vars, never spliced into the
// command), show in the panel's Folders menu, survive a restart of the stale
// Claude tabs, and are never written into the deck.
//
//   cd desktop && npx electron-vite build && node scripts/e2e-attached-folders.mjs
//   (needs slides/dist-single built)
//
// No real claude runs: $SHELL is a stub that logs the launch command line it
// is handed and the SLIDOMINGO_ADD_DIR_* env it was given. The native folder
// dialog is stubbed in main. Windows are shown at opacity 0, unfocused. Same
// two-mode shape as e2e-chat-history.mjs.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const repo = resolve(desktopDir, '..')
const SHELL_PATH = join(repo, 'slides/dist-single/BeeSlides.beeslides.html')
const BLOCK_RE = /(<script[^>]*\bid=["']slidomingo-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DOC_ID = '0a0a0a0a-0000-4000-8000-00000000f01d'

let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) failures++
  try { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`) } catch { /* pipe gone */ }
}

// No top-level await in Electron mode (an ESM entry that awaits blocks `ready`).
if (process.versions.electron) {
  driver().catch(async (err) => {
    ok(false, `driver error: ${err?.message ?? err}`)
    try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ }
    const { app } = await import('electron')
    app.exit(4)
  })
}
else await orchestrator()

async function driver() {
  const { app, BrowserWindow, webContents, dialog } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  BrowserWindow.prototype.show = function () { this.setOpacity(0); this.showInactive() }
  BrowserWindow.prototype.focus = function () {}
  app.dock?.hide()
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  const report = () => { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ } }
  const hardStop = setTimeout(() => { ok(false, 'timed out'); report(); app.exit(3) }, 80000)
  async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn().catch(() => null)
      if (v) return v
      if (Date.now() > end) return null
      await sleep(150)
    }
  }
  const findWc = (re, ready) => waitFor(async () => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.isLoading() || !re.test(wc.getURL())) continue
      if (await wc.executeJavaScript(ready)) return wc
    }
    return null
  })
  const env = process.env
  const launches = () => existsSync(env.E2E_LAUNCH_LOG) ? readFileSync(env.E2E_LAUNCH_LOG, 'utf8').split('\n').filter((l) => l.includes('claude ')) : []
  const envLog = () => existsSync(env.E2E_ENV_LOG) ? readFileSync(env.E2E_ENV_LOG, 'utf8').split('\n').filter(Boolean) : []
  const store = () => { try { return JSON.parse(readFileSync(join(env.E2E_USERDATA, 'attached-folders.json'), 'utf8')).decks } catch { return [] } }
  const [extraA, extraB, extraC] = [env.E2E_EXTRA_A, env.E2E_EXTRA_B, env.E2E_EXTRA_C]
  let pick = extraB
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pick] })

  const wc = await findWc(/BeeSlides\.beeslides\.html/, '!!(window.slidomingo && window.slidomingo.doc && document.querySelector(".ed-root"))')
  ok(!!wc, 'the deck opened')
  if (!wc) { report(); app.exit(1); return }

  // ---- a folder attached earlier reaches the first session as --add-dir
  await wc.executeJavaScript(`window.slidomingoDesktop.toggleTerminal()`)
  const first = await waitFor(async () => launches()[0] ?? null)
  const idA = first?.match(/--session-id ([0-9a-f-]{36})/)?.[1]
  ok(!!idA, 'the first session launched')
  ok(!!first && first.includes('--add-dir "$SLIDOMINGO_DECK_DIR"') && first.includes('--add-dir "$SLIDOMINGO_ADD_DIR_1"') && !first.includes('SLIDOMINGO_ADD_DIR_2'), 'an attached folder is its own --add-dir, after the deck folder\'s')
  ok(!!first && !first.includes(extraA), 'its path is not spliced into the command')
  ok(await waitFor(async () => envLog().find((l) => l.startsWith('1=')) ?? null) === `1=${extraA}`, 'the path travels in the pty env')

  const term = await findWc(/renderer\/terminal\/index\.html|terminal/, '!!(window.slidomingoTerminal && document.querySelector(".term-tab"))')
  ok(!!term, 'the panel rendered its tab')
  if (!term) { report(); app.exit(1); return }
  const state = () => term.executeJavaScript('window.slidomingoTerminal.listFolders()')
  const tabs = () => term.executeJavaScript('document.querySelectorAll(".term-tab").length')

  let st = await state()
  ok(st.folders.length === 1 && st.folders[0].path === extraA && st.folders[0].exists && st.canAttach && st.stale === 0, 'the panel lists it, nothing stale')
  ok(st.deckFolder === realpathSync(dirname(env.E2E_DECK)) || st.deckFolder === dirname(env.E2E_DECK), "…and shows the deck's own folder")
  ok(await waitFor(async () => (await term.executeJavaScript('document.getElementById("term-folders-count").textContent')) === '1' || null, 5000), 'the button carries the count')

  // ---- attach another through the (stubbed) native dialog
  await term.executeJavaScript(`document.getElementById('term-folders').click()`)
  await waitFor(async () => (await term.executeJavaScript(`document.querySelectorAll('#term-folders-menu:not([hidden]) .term-history-item').length`)) || null, 5000)
  ok((await term.executeJavaScript(`document.querySelectorAll('#term-folders-menu .term-folder-remove').length`)) === 1, 'the menu shows the attached folder with a detach button')
  await term.executeJavaScript(`[...document.querySelectorAll('#term-folders-menu .term-history-item')].find((b) => /Attach folders/.test(b.textContent)).click()`)
  st = await waitFor(async () => { const s = await state(); return s.folders.length === 2 ? s : null })
  ok(!!st && st.folders[1].path === extraB, 'a folder picked in the dialog is attached')
  ok(st?.stale === 1, 'the running Claude tab predates the change: one stale tab')
  ok(!!(await waitFor(async () => (await term.executeJavaScript(`!!document.querySelector('#term-folders-menu .term-folder-restart')`)) || null, 5000)), 'the menu offers a restart')

  // ---- it never reaches the deck
  const deckFile = readFileSync(env.E2E_DECK, 'utf8')
  const live = await wc.executeJavaScript('window.slidomingo.serialize()')
  ok(!deckFile.includes(extraA) && !deckFile.includes(extraB) && !String(live).includes(extraA) && !String(live).includes(extraB), 'no attached path is in the deck file or its serialized form')
  ok(store().length === 1 && store()[0].docId === DOC_ID && store()[0].folders.length === 2, 'it is kept in userData, keyed by the deck\'s docId')

  // ---- restart: the stale tab is relaunched under the same conversation, with both folders
  await term.executeJavaScript(`document.querySelector('#term-folders-menu .term-folder-restart').click()`)
  const second = await waitFor(async () => launches()[1] ?? null)
  ok(!!second && second.includes(`--session-id ${idA}`) && !second.includes('--resume'), 'a tab nobody spoke to restarts as a new conversation under the same id')
  ok(!!second && second.includes('SLIDOMINGO_ADD_DIR_1') && second.includes('SLIDOMINGO_ADD_DIR_2'), '…now with both folders')
  ok(await waitFor(async () => envLog().find((l) => l.startsWith('2=')) ?? null) === `2=${extraB}`, 'the second path is in its env')
  ok(await waitFor(async () => (await tabs()) === 1 || null, 8000), 'there is still exactly one tab (the old one was replaced)')
  st = await state()
  ok(st.stale === 0, 'nothing is stale after the restart')

  // ---- a conversation with a transcript resumes
  mkdirSync(join(env.E2E_CONFIG, 'projects', '-e2e-work'), { recursive: true })
  const idNow = launches()[1].match(/--session-id ([0-9a-f-]{36})/)[1]
  writeFileSync(join(env.E2E_CONFIG, 'projects', '-e2e-work', `${idNow}.jsonl`), [{ type: 'user', message: { content: 'hello' } }].map((o) => JSON.stringify(o)).join('\n') + '\n')
  pick = extraC
  await term.executeJavaScript(`window.slidomingoTerminal.addFolder()`)
  // Reopen the menu so it re-reads the state (the API call above bypassed it).
  await term.executeJavaScript(`(() => { if (!document.getElementById('term-folders-menu').hidden) document.getElementById('term-folders').click() })()`)
  await term.executeJavaScript(`document.getElementById('term-folders').click()`)
  await waitFor(async () => (await term.executeJavaScript(`!!document.querySelector('#term-folders-menu:not([hidden]) .term-folder-restart')`)) || null, 5000)
  await term.executeJavaScript(`document.querySelector('#term-folders-menu .term-folder-restart')?.click()`)
  const third = await waitFor(async () => launches()[2] ?? null)
  ok(!!third && third.includes(`--resume ${idNow}`) && !third.includes('--session-id'), 'a tab that has a transcript is restarted with --resume')
  ok(!!third && third.includes('SLIDOMINGO_ADD_DIR_3'), '…with all three folders')

  // ---- guards
  await term.executeJavaScript(`window.slidomingoTerminal.removeFolder('/etc')`)
  ok((await state()).folders.length === 3, 'detaching a path that is not attached does nothing')
  pick = join(env.E2E_ROOT, 'work', 'Folders.beeslides.html')
  st = await term.executeJavaScript(`window.slidomingoTerminal.addFolder()`)
  ok(!!st.error && st.folders.length === 3, 'a file picked in the dialog is refused with a message')
  pick = '/'
  st = await term.executeJavaScript(`window.slidomingoTerminal.addFolder()`)
  ok(!!st.error && st.folders.length === 3, 'the filesystem root is refused')
  st = await term.executeJavaScript(`window.slidomingoTerminal.removeFolder(${JSON.stringify(extraC)})`)
  ok(st.folders.length === 2 && st.stale === 1, 'detaching a folder drops it, and the tab that has it is stale again')
  ok(JSON.stringify(store()[0].folders) === JSON.stringify([extraA, extraB]), 'the store follows')

  clearTimeout(hardStop)
  report()
  app.exit(0)
}

async function orchestrator() {
  if (!existsSync(SHELL_PATH)) { console.log(`missing ${SHELL_PATH} — run npm run build:single in slides/`); process.exit(2) }
  if (!existsSync(join(desktopDir, 'out/main/index.js'))) { console.log('missing out/main — run npx electron-vite build'); process.exit(2) }
  const electronPath = createRequire(import.meta.url)('electron')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'slidomingo-e2e-folders-')))
  const work = join(root, 'work')
  const home = join(root, 'home')
  const config = join(root, 'claude-config')
  const userData = join(root, 'userdata')
  const extraA = join(root, 'research')
  const extraB = join(root, 'data')
  const extraC = join(root, 'images')
  for (const d of [work, home, config, userData, extraA, extraB, extraC]) mkdirSync(d, { recursive: true })
  // A folder attached to this deck in an earlier run.
  writeFileSync(join(userData, 'attached-folders.json'), JSON.stringify({ version: 1, decks: [{ docId: DOC_ID, path: null, folders: [extraA] }] }))

  const launchLog = join(root, 'launches.log')
  const envLog = join(root, 'env.log')
  // `$SHELL -ilc env` (the env probe) prints env; a session (`-lic <cmd>`)
  // logs the command line and the attached-folder env it was handed, then idles.
  const shell = join(root, 'fake-shell')
  writeFileSync(shell, `#!/bin/sh\n[ "$2" = env ] && exec /usr/bin/env\nprintf '%s\\n' "$2" >> '${launchLog}'\n` +
    `[ -n "$SLIDOMINGO_ADD_DIR_1" ] && printf '1=%s\\n' "$SLIDOMINGO_ADD_DIR_1" >> '${envLog}'\n` +
    `[ -n "$SLIDOMINGO_ADD_DIR_2" ] && printf '2=%s\\n' "$SLIDOMINGO_ADD_DIR_2" >> '${envLog}'\nexec cat > /dev/null\n`, { mode: 0o755 })
  const shellHtml = readFileSync(SHELL_PATH, 'utf8')
  const { newDoc } = await import(join(repo, 'slides/src/model.ts'))
  const doc = Object.assign(newDoc(), { title: 'Folders', docId: DOC_ID })
  const deck = join(work, 'Folders.beeslides.html')
  writeFileSync(deck, shellHtml.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`))
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', deck], {
    cwd: desktopDir,
    env: {
      ...process.env, SHELL: shell, HOME: home, CLAUDE_CONFIG_DIR: config,
      E2E_LAUNCH_LOG: launchLog, E2E_ENV_LOG: envLog, E2E_CONFIG: config, E2E_USERDATA: userData, E2E_DECK: deck, E2E_ROOT: root,
      E2E_EXTRA_A: extraA, E2E_EXTRA_B: extraB, E2E_EXTRA_C: extraC,
      SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: join(root, 'templates'),
      ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '',
    },
    encoding: 'utf8', timeout: 100000,
  })
  const out = res.stdout ?? ''
  for (const line of out.split('\n')) if (/^\s+(ok|FAIL|debug)\s/.test(line)) console.log(line)
  const m = out.match(/E2E_RESULT (\d+) (\d+)/)
  if (!m) { console.log(`FAIL  no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-15).join('\n')}`); process.exit(1) }
  checks += Number(m[1]); failures += Number(m[2])
  console.log(`\n${checks - failures}/${checks} checks passed   (profile: ${root})`)
  if (failures) process.exit(1)
}
