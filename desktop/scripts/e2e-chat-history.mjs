#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Chat history E2E: every terminal session is launched under an id main
// picks (`claude --session-id`), recorded against the deck, listed in the
// panel's history menu and continued from it (`claude --resume`).
//
//   cd desktop && npx electron-vite build && node scripts/e2e-chat-history.mjs
//   (needs slides/dist-single built)
//
// No real claude runs: $SHELL is a stub that logs the launch command line it
// is handed, and CLAUDE_CONFIG_DIR is a throwaway where this script plants
// the transcripts `claude` would have written. Same two-mode shape as
// e2e-agent-prompt.mjs — node runs the ORCHESTRATOR, Electron the DRIVER.

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
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
const DOC_ID = '0a0a0a0a-0000-4000-8000-00000000d0c1'
const FOREIGN = '0f0f0f0f-0000-4000-8000-0000000f0e19'

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
  const { app, BrowserWindow, webContents } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  BrowserWindow.prototype.show = function () { this.setOpacity(0); this.showInactive() }
  BrowserWindow.prototype.focus = function () {}
  app.dock?.hide()
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  const report = () => { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ } }
  const hardStop = setTimeout(() => { ok(false, 'timed out'); report(); app.exit(3) }, 60000)
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
  const { E2E_LAUNCH_LOG: launchLog, E2E_CONFIG: config, E2E_USERDATA: userData, E2E_DECK: deck } = process.env
  const launches = () => existsSync(launchLog) ? readFileSync(launchLog, 'utf8').split('\n').filter((l) => l.includes('claude ')) : []
  const records = () => { try { return JSON.parse(readFileSync(join(userData, 'chat-history.json'), 'utf8')).records } catch { return [] } }
  const transcript = (id, title) => {
    mkdirSync(join(config, 'projects', '-e2e-work'), { recursive: true })
    writeFileSync(join(config, 'projects', '-e2e-work', `${id}.jsonl`),
      [{ type: 'user', message: { content: 'hello' } }, { type: 'ai-title', aiTitle: title }].map((o) => JSON.stringify(o)).join('\n') + '\n')
  }

  const wc = await findWc(/BeeSlides\.beeslides\.html/, '!!(window.beeslides && window.beeslides.doc && document.querySelector(".ed-root"))')
  ok(!!wc, 'the deck opened')
  if (!wc) { report(); app.exit(1); return }

  // ---- a new session is launched under an id main picked, and recorded
  await wc.executeJavaScript(`window.slidomingoDesktop.toggleTerminal()`)
  const first = await waitFor(async () => launches()[0] ?? null)
  const idA = first?.match(/--session-id ([0-9a-f-]{36})/)?.[1]
  ok(!!idA, 'the first session launches `claude --session-id <uuid>`')
  ok(!!first && !first.includes('--resume'), '…as a new conversation')
  ok(!!first && first.includes('--add-dir "$SLIDOMINGO_DECK_DIR"') && !first.includes(dirname(deck)), "the deck's folder is granted via --add-dir from the env, never spliced into the command")
  const recA = await waitFor(async () => records().find((r) => r.id === idA) ?? null)
  ok(recA?.path === deck, 'it is recorded against the deck file')
  ok(recA?.docId === DOC_ID, '…and its docId (reported by the editor at boot)')

  const term = await findWc(/renderer\/terminal\/index\.html|terminal/, '!!(window.slidomingoTerminal && document.querySelector(".term-tab"))')
  ok(!!term, 'the terminal panel rendered its tab')
  if (!term) { report(); app.exit(1); return }
  const list = () => term.executeJavaScript('window.slidomingoTerminal.listChats()')

  ok((await list()).length === 0, 'a session nobody spoke to yet is not listed')
  transcript(idA, 'first chat')
  let chats = await list()
  ok(chats.length === 1 && chats[0].id === idA && chats[0].title === 'first chat', 'once it has a transcript, it is listed with its title')
  ok(!!chats[0]?.openIn, '…marked as open in this panel')

  // ---- close its tab, then continue it from the history menu
  await term.executeJavaScript(`document.querySelector('.term-tab-close').click()`)
  await waitFor(async () => (await term.executeJavaScript('document.querySelectorAll(".term-tab").length')) === 0 || null, 5000)
  chats = await list()
  ok(chats.length === 1 && chats[0].openIn === null, 'after closing the tab it is still listed, no longer open')

  await term.executeJavaScript(`document.getElementById('term-history').click()`)
  const items = await waitFor(async () => {
    const n = await term.executeJavaScript(`document.querySelectorAll('#term-history-menu:not([hidden]) .term-history-item').length`)
    return n || null
  }, 5000)
  ok(items === 1, 'the history menu shows it')
  ok((await term.executeJavaScript(`document.querySelector('.term-history-title').textContent`)) === 'first chat', '…by title')
  await term.executeJavaScript(`document.querySelector('.term-history-item').click()`)
  const resumed = await waitFor(async () => launches()[1] ?? null)
  ok(!!resumed && resumed.includes(`--resume ${idA}`) && !resumed.includes('--session-id'), 'picking it launches `claude --resume <its id>`')
  ok(await waitFor(async () => (await term.executeJavaScript('document.querySelectorAll(".term-tab").length')) === 1 || null, 5000),
    'in a new tab')
  ok((await term.executeJavaScript(`document.getElementById('term-history-menu').hidden`)) === true, 'and the menu closes')
  ok(records().filter((r) => r.id === idA).length === 1, 'resuming does not add a second record')

  // ---- guards: no second process on one transcript, nothing outside this deck
  ok((await term.executeJavaScript(`window.slidomingoTerminal.resumeChat(${JSON.stringify(idA)})`)) === null,
    'a conversation already running in a tab cannot be resumed twice')
  ok((await term.executeJavaScript(`window.slidomingoTerminal.resumeChat(${JSON.stringify(FOREIGN)})`)) === null,
    "another deck's conversation cannot be resumed here")
  ok((await term.executeJavaScript(`window.slidomingoTerminal.resumeChat("x; rm -rf ~")`)) === null, 'a non-uuid never reaches the shell')
  await sleep(300)
  ok(launches().length === 2, 'none of those launched anything')
  ok(!readFileSync(launchLog, 'utf8').includes('rm -rf'), 'nothing of the bogus id was typed or launched')

  // ---- "+" starts a fresh conversation, listed separately
  await term.executeJavaScript(`document.getElementById('term-new-tab').click()`)
  const third = await waitFor(async () => launches()[2] ?? null)
  const idB = third?.match(/--session-id ([0-9a-f-]{36})/)?.[1]
  ok(!!idB && idB !== idA, '"+" starts a NEW conversation id')
  transcript(idB, 'second chat')
  chats = await list()
  ok(chats.length === 2 && chats.every((c) => c.openIn), 'both are listed, both open')
  ok(!chats.some((c) => c.id === FOREIGN), "the other deck's record is not listed here")

  // ---- /clear (or an in-pty /resume) makes claude start a conversation of its own:
  // the SessionStart hook reports it, and main records it on this deck.
  const sessionRel = third?.match(/--settings \.\/(\S+)\/settings\.json/)?.[1]
  // claude runs in the deck's managed workspace (userData/claude-workspaces/<docId>), not the deck's folder.
  const workspace = join(userData, 'claude-workspaces', DOC_ID)
  ok(existsSync(join(workspace, sessionRel?.split('/')[0] ?? '?')) && !readdirSync(dirname(deck)).some((n) => n.startsWith('.slidomingo-context')), 'the context dir is in the workspace, nothing next to the deck')
  const sessionDir = sessionRel ? join(workspace, sessionRel) : null
  const hookCmd = sessionDir ? JSON.parse(readFileSync(join(sessionDir, 'settings.json'), 'utf8')).hooks?.SessionStart?.[0]?.hooks?.[0]?.command : ''
  ok(/session-note\.mjs/.test(hookCmd ?? ''), 'the session settings carry a SessionStart hook')
  const CLEARED = '0c0c0c0c-0000-4000-8000-0000000c1ea4'
  if (sessionDir) writeFileSync(join(sessionDir, 'session-note.json'), JSON.stringify({ session_id: CLEARED, source: 'clear' }))
  const recC = await waitFor(async () => records().find((r) => r.id === CLEARED) ?? null)
  ok(recC?.docId === DOC_ID && recC?.path === deck, 'the conversation claude started itself is recorded on the deck')
  transcript(CLEARED, 'after clear')
  ok((await list()).some((c) => c.id === CLEARED && c.openIn), '…listed, and marked open in the tab that runs it')

  // ---- a legacy transcript, in the deck folder's project folder, is claimed by docId
  const OLD = '0d0d0d0d-0000-4000-8000-0000000001d0'
  const OTHER_DRAFT = '0e0e0e0e-0000-4000-8000-0000000000e0'
  const projDir = join(config, 'projects', realpathSync(dirname(deck)).replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, `${OLD}.jsonl`), [{ type: 'user', timestamp: '2026-10-01T09:00:00.000Z', message: { content: `deck ${DOC_ID}` } }, { type: 'ai-title', aiTitle: 'old chat' }].map((o) => JSON.stringify(o)).join('\n') + '\n')
  writeFileSync(join(projDir, `${OTHER_DRAFT}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'some-other-doc-id' } }) + '\n')
  // …and one from the workspace's own project folder (where new chats now live)
  const WS_OLD = '0f0f0f0f-0000-4000-8000-0000000001d1'
  const wsProj = join(config, 'projects', realpathSync(workspace).replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(wsProj, { recursive: true })
  writeFileSync(join(wsProj, `${WS_OLD}.jsonl`), [{ type: 'user', timestamp: '2026-10-02T09:00:00.000Z', message: { content: `deck ${DOC_ID}` } }, { type: 'ai-title', aiTitle: 'workspace chat' }].map((o) => JSON.stringify(o)).join('\n') + '\n')
  chats = await list()
  ok(chats.some((c) => c.id === WS_OLD && c.title === 'workspace chat'), 'an unrecorded transcript in the workspace project folder is backfilled too')
  ok(chats.some((c) => c.id === OLD && c.title === 'old chat'), 'an unrecorded transcript mentioning the docId is backfilled into the list')
  ok(!chats.some((c) => c.id === OTHER_DRAFT), '…and one for another deck in the same folder is not')

  // ---- the header × (terminal:close) hands the doc view its full width back
  const win = BrowserWindow.getAllWindows().find((w) => w.contentView.children.length > 1) ?? BrowserWindow.getAllWindows()[0]
  const docW = () => wc.executeJavaScript('window.innerWidth')
  ok((await docW()) < win.getContentBounds().width, 'while the panel is docked the doc view is narrowed')
  await term.executeJavaScript('window.slidomingoTerminal.close()')
  ok(await waitFor(async () => (await docW()) === win.getContentBounds().width || null, 5000),
    'closing the panel with the header × restores the doc view to the full window width')

  clearTimeout(hardStop)
  report()
  app.exit(0)
}

async function orchestrator() {
  if (!existsSync(SHELL_PATH)) { console.log(`missing ${SHELL_PATH} — run npm run build:single in slides/`); process.exit(2) }
  if (!existsSync(join(desktopDir, 'out/main/index.js'))) { console.log('missing out/main — run npx electron-vite build'); process.exit(2) }
  const electronPath = createRequire(import.meta.url)('electron')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-chats-'))
  const work = join(root, 'work')
  const home = join(root, 'home')
  const config = join(root, 'claude-config')
  const userData = join(root, 'userdata')
  for (const d of [work, home, config, userData]) mkdirSync(d, { recursive: true })
  // Another deck's conversation, with a transcript: must never show up here.
  writeFileSync(join(userData, 'chat-history.json'), JSON.stringify({
    version: 1, records: [{ id: FOREIGN, docId: 'some-other-deck', path: join(work, 'Other.beeslides.html'), startedAt: Date.now() }],
  }))
  mkdirSync(join(config, 'projects', '-e2e-other'), { recursive: true })
  writeFileSync(join(config, 'projects', '-e2e-other', `${FOREIGN}.jsonl`), JSON.stringify({ type: 'ai-title', aiTitle: 'other deck' }) + '\n')

  const launchLog = join(root, 'launches.log')
  // `$SHELL -ilc env` (the env probe) prints env; a session (`-lic <cmd>`)
  // logs the command line it was handed, then idles like a quiet shell.
  const shell = join(root, 'fake-shell')
  writeFileSync(shell, `#!/bin/sh\n[ "$2" = env ] && exec /usr/bin/env\nprintf '%s\\n' "$2" >> '${launchLog}'\nexec cat > /dev/null\n`, { mode: 0o755 })
  const shellHtml = readFileSync(SHELL_PATH, 'utf8')
  const { newDoc } = await import(join(repo, 'slides/src/model.ts'))
  const doc = Object.assign(newDoc(), { title: 'Chats', docId: DOC_ID })
  const deck = join(work, 'Chats.beeslides.html')
  writeFileSync(deck, shellHtml.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`))
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', deck], {
    cwd: desktopDir,
    env: {
      ...process.env, SHELL: shell, HOME: home, CLAUDE_CONFIG_DIR: config,
      E2E_LAUNCH_LOG: launchLog, E2E_CONFIG: config, E2E_USERDATA: userData, E2E_DECK: deck,
      SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: join(root, 'templates'),
      ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '',
    },
    encoding: 'utf8', timeout: 90000,
  })
  const out = res.stdout ?? ''
  for (const line of out.split('\n')) if (/^\s+(ok|FAIL|debug)\s/.test(line)) console.log(line)
  const m = out.match(/E2E_RESULT (\d+) (\d+)/)
  if (!m) { console.log(`FAIL  no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-15).join('\n')}`); process.exit(1) }
  checks += Number(m[1]); failures += Number(m[2])
  console.log(`\n${checks - failures}/${checks} checks passed   (profile: ${root})`)
  if (failures) process.exit(1)
}
