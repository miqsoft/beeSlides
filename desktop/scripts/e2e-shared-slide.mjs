#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Shared-slide E2E: two terminal tabs (two sessions) write the SAME slide via
// main's real request path (agent-action / slide-write files in each session's
// context dir → sessionId-tagged IPC → the editor) and neither is refused; the
// slide's lock badge follows the latest writer. Also: a stale IndexedDB
// recovery snapshot must NOT raise the recovery banner on desktop.
//
//   cd desktop && npx electron-vite build && node scripts/e2e-shared-slide.mjs
//   (needs slides/dist-single built)
//
// No real claude runs: $SHELL is a stub that records what the pty delivers
// to it, and HOME is a throwaway (claudeTrust.ts would otherwise write
// ~/.claude.json). Same two-mode shape as e2e-autosave.mjs — node runs the
// ORCHESTRATOR, Electron runs the DRIVER, which imports the built main.

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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
  const findWc = (re, probe) => waitFor(async () => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.isLoading() || !re.test(wc.getURL())) continue
      if (await wc.executeJavaScript(probe)) return wc
    }
    return null
  })
  const wc = await findWc(/BeeSlides\.beeslides\.html/, '!!(window.beeslides && window.beeslides.doc && document.querySelector(".ed-root"))')
  ok(!!wc, 'the deck opened')
  if (!wc) { report(); app.exit(1); return }
  const slideId = await wc.executeJavaScript('window.beeslides.doc.slides[0].id')
  const count = () => wc.executeJavaScript('window.beeslides.doc.slides[0].elements.length')
  const badge = () => wc.executeJavaScript(`(() => { const b = document.querySelector('.ed-thumb-lock'); return b ? b.style.getPropertyValue('--ed-lock-color') : null })()`)

  await wc.executeJavaScript('window.slidomingoDesktop.toggleTerminal()')
  const term = await findWc(/terminal/, '!!(window.slidomingoTerminal && document.querySelector(".term-tab"))')
  ok(!!term, 'the terminal panel rendered its first tab')
  if (!term) { report(); app.exit(1); return }
  await sleep(1500)
  await term.executeJavaScript('document.getElementById("term-new-tab").click()')
  const dirs = await waitFor(async () => {
    // The context dir lives in the deck's managed workspace (userData/claude-workspaces/<docId>), not next to the deck.
    const wsRoot = join(process.env.SLIDOMINGO_USER_DATA, 'claude-workspaces')
    const wsName = readdirSync(wsRoot).find((w) => readdirSync(join(wsRoot, w)).some((n) => n.startsWith('.slidomingo-context')))
    const root = wsName ? join(wsRoot, wsName) : null
    if (!root) return null
    const ctx = readdirSync(root).find((n) => n.startsWith('.slidomingo-context'))
    const sess = ctx ? readdirSync(join(root, ctx), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('session-')).map((d) => d.name) : []
    return sess.length >= 2 ? sess.map((n) => join(root, ctx, n)) : null
  })
  ok(!!dirs && dirs.length === 2, `two sessions have their own context dirs (${dirs?.length ?? 0})`)
  if (!dirs) { report(); app.exit(1); return }
  await sleep(1500) // watchers armed

  const send = async (dir, prefix, resultPrefix, payload) => {
    const requestId = randomUUID()
    writeFileSync(join(dir, `.${prefix}-${requestId}.json.tmp`), JSON.stringify({ requestId, ...payload }))
    renameSync(join(dir, `.${prefix}-${requestId}.json.tmp`), join(dir, `${prefix}-${requestId}.json`))
    return waitFor(async () => JSON.parse(readFileSync(join(dir, `${resultPrefix}-${requestId}.json`), 'utf8')), 15000)
  }
  const insert = (dir, id) => send(dir, 'agent-action', 'agent-action-result', {
    verb: 'insert_elements',
    args: { slideId, elements: [{ id, type: 'text', x: 100, y: 100, w: 300, h: 80, html: id }] },
  })

  const n0 = await count()
  const a = await insert(dirs[0], 'from-a')
  ok(a?.ok === true, `session A inserts into the slide (${a?.error ?? 'ok'})`)
  await sleep(300)
  const lockA = await badge()
  const b = await insert(dirs[1], 'from-b')
  ok(b?.ok === true, `session B inserts into the SAME slide (${b?.error ?? 'ok'})`)
  await sleep(300)
  const lockB = await badge()
  const a2 = await insert(dirs[0], 'from-a-again')
  ok(a2?.ok === true, `session A again, after B (${a2?.error ?? 'ok'})`)
  ok(await count() === n0 + 3, `all three inserts landed (${await count()} elements, was ${n0})`)
  // (colour is a hash of the session id from a small palette, so two sessions can collide: only assert presence)
  ok(!!lockA && !!lockB, `the sidebar shows a writer badge after each session's write (${lockA}, ${lockB})`)

  // write_slide for the same slide, from each session, via the slide-write channel
  for (const [i, dir] of dirs.entries()) {
    const slide = await wc.executeJavaScript('JSON.parse(JSON.stringify(window.beeslides.doc.slides[0]))')
    slide.elements.push({ id: `w${i}`, type: 'text', x: 50, y: 400 + i * 90, w: 300, h: 60, html: `w${i}` })
    const r = await send(dir, 'slide-write', 'slide-write-result', { slideId, slide })
    ok(r?.ok === true, `session ${'AB'[i]} write_slide on the shared slide (${r?.error ?? 'ok'})`)
  }
  ok(await count() === n0 + 5, `and both writes landed (${await count()} elements)`)

  // ---- recovery banner: desktop must not offer an older IndexedDB copy ----
  const stale = await wc.executeJavaScript('JSON.stringify(Object.assign(JSON.parse(JSON.stringify(window.beeslides.doc)), { title: "STALE COPY" }))')
  const seeded = await wc.executeJavaScript(`(async () => {
    const snap = { docId: window.beeslides.doc.docId, at: Date.now() + 1e6, title: 'STALE COPY', json: '' }
    snap.json = ${JSON.stringify(stale)}
    let n = 0
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      if (db.objectStoreNames.contains('recovery')) {
        await new Promise((res, rej) => { const t = db.transaction('recovery', 'readwrite'); t.objectStore('recovery').put(snap); t.oncomplete = res; t.onerror = () => rej(t.error) })
        n++
      }
      db.close()
    }
    return n
  })()`)
  ok(seeded >= 1, `seeded a differing recovery snapshot (${seeded} db)`)
  wc.reload()
  await sleep(500)
  const again = await findWc(/BeeSlides\.beeslides\.html/, '!!(window.beeslides && window.beeslides.doc && document.querySelector(".ed-root"))')
  ok(!!again, 'the deck reopened')
  await sleep(2500) // checkRecovery is async
  const banner = await again?.executeJavaScript('!!document.querySelector(".ed-recover")')
  ok(banner === false, 'no recovery banner on desktop')

  clearTimeout(hardStop)
  report()
  app.exit(0)
}

async function orchestrator() {
  if (!existsSync(SHELL_PATH)) { console.log(`missing ${SHELL_PATH} — run npm run build:single in slides/`); process.exit(2) }
  if (!existsSync(join(desktopDir, 'out/main/index.js'))) { console.log('missing out/main — run npx electron-vite build'); process.exit(2) }
  const electronPath = createRequire(import.meta.url)('electron')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-shared-'))
  const work = join(root, 'work')
  const home = join(root, 'home')
  mkdirSync(work, { recursive: true })
  mkdirSync(home, { recursive: true })
  const log = join(root, 'pty-input.log')
  // the env probe gets env; the pty session records its input, line by line
  const shell = join(root, 'fake-shell')
  writeFileSync(shell, `#!/bin/sh\n[ "$2" = env ] && exec /usr/bin/env\nexec cat >> '${log}'\n`, { mode: 0o755 })
  const shellHtml = readFileSync(SHELL_PATH, 'utf8')
  const { newDoc, defaultText } = await import(join(repo, 'slides/src/model.ts'))
  const doc = Object.assign(newDoc(), { title: 'Shared' })
  doc.slides[0].elements = [defaultText({ id: 'hello', html: 'Hello' })]
  const deck = join(work, 'Shared.beeslides.html')
  writeFileSync(deck, shellHtml.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`))
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', deck], {
    cwd: desktopDir,
    env: {
      ...process.env, SHELL: shell, HOME: home, E2E_PTY_LOG: log, E2E_DECK: deck,
      SLIDOMINGO_USER_DATA: join(root, 'userdata'), SLIDOMINGO_TEMPLATES_DIR: join(root, 'templates'),
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
