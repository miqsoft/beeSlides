#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// "Polish with Claude" E2E: the editor's button types its FIXED prompt into
// the window's Claude Code session (slidomingo:agent-prompt → pty.write).
//
//   cd desktop && npx electron-vite build && node scripts/e2e-agent-prompt.mjs
//   (needs slides/dist-single built)
//
// Also: "Send comments to Claude" — the comments pill's Send types the open
// comments into the session as ONE pasted list (and done threads stay hidden
// until the pill's "N resolved" toggle shows them) — and review_slide through
// main's real capturePage, cropped to the slide.
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
const PROMPT = 'Review the current slide with review_slide and polish its layout; keep content unchanged.'

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
  const { app, BrowserWindow, webContents, screen } = await import('electron')
  // shown, but fully transparent and inactive: a never-shown window gets no
  // input events, and selecting an element needs one
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
  const docWc = () => waitFor(async () => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.isLoading() || !/BeeSlides\.beeslides\.html/.test(wc.getURL())) continue
      if (await wc.executeJavaScript('!!(window.beeslides && window.beeslides.doc && document.querySelector(".ed-root"))')) return wc
    }
    return null
  })
  const wc = await docWc()
  ok(!!wc, 'the deck opened')
  if (!wc) { report(); app.exit(1); return }
  const log = process.env.E2E_PTY_LOG

  // no session yet: the prompt has nowhere to go and must not throw
  await wc.executeJavaScript(`window.slidomingoDesktop.sendAgentPrompt('polish')`)
  await wc.executeJavaScript(`window.slidomingoDesktop.toggleTerminal()`)
  const started = await waitFor(async () => existsSync(log) || null, 15000)
  ok(!!started, 'the terminal panel started a session (stub shell running)')
  // the button is offered once the panel is open (an element is selected —
  // by trusted input: Selecto ignores synthetic DOM clicks here)
  const at = await wc.executeJavaScript(`(() => { const r = document.querySelector('.ed-stage [data-el-id]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const shown = await waitFor(async () => {
    if (!(await wc.executeJavaScript('window.beeslides.selection.length'))) {
      wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
      await sleep(80)
      wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
      await sleep(200)
    }
    return wc.executeJavaScript(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Polish with Claude'))`)
  }, 10000)
  ok(!!shown, '"Polish with Claude" is offered while a session runs')
  if (!shown) console.log('        debug ' + await wc.executeJavaScript(`JSON.stringify({ sel: window.beeslides.selection, els: document.querySelectorAll('.ed-stage [data-el-id]').length, tidy: [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('Tidy')).length, panel: document.querySelector('.ed-props, .ed-panel')?.textContent?.slice(0, 120) })`))
  await wc.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Polish with Claude')); if (b) b.click(); else window.slidomingoDesktop.sendAgentPrompt('polish') })()`)
  // a prompt name main does not know is dropped
  await wc.executeJavaScript(`window.slidomingoDesktop.sendAgentPrompt('rm -rf ~')`)
  const got = await waitFor(async () => {
    const text = readFileSync(log, 'utf8')
    return text.includes(PROMPT) ? text : null
  }, 10000)
  ok(!!got, 'the fixed polish prompt reached the session pty')
  await sleep(500)
  const text = readFileSync(log, 'utf8')
  ok(text.split(PROMPT).length === 2, 'exactly once (the call before the panel opened went nowhere)')
  ok(!text.includes('rm -rf'), 'an unknown prompt name types nothing')

  // comments: the done thread is hidden until the pill shows it
  const markers = () => wc.executeJavaScript(`[...document.querySelectorAll('.ed-comment-marker')].map((m) => m.dataset.cid).sort().join(',')`)
  ok(await waitFor(async () => (await markers()) === 'cmt_open'), 'a resolved thread has no marker by default')
  await wc.executeJavaScript(`document.querySelector('.ed-cmtpill-btn.done').click()`, true)
  ok(await waitFor(async () => (await markers()) === 'cmt_done,cmt_open'), '"1 resolved" in the pill shows it')
  await wc.executeJavaScript(`document.querySelector('.ed-cmtpill-btn.done').click()`, true)
  ok(await waitFor(async () => (await markers()) === 'cmt_open'), 'and hides it again')
  // Send: the open comment goes to the session as one bracketed paste + Enter
  await wc.executeJavaScript(`document.querySelector('.ed-cmtpill-btn.send').click()`, true)
  const sent = await waitFor(async () => {
    const t = readFileSync(log, 'utf8')
    return t.includes('\x1b[201~') ? t : null
  }, 10000)
  ok(!!sent, 'Send typed a pasted message into the session')
  const msg = sent ? sent.slice(sent.indexOf('\x1b[200~')) : ''
  ok(msg.startsWith('\x1b[200~Please fix this review comment:'), 'it starts as a pasted list')
  ok(msg.includes('1. Slide 1 · on “Hello”: Make it bigger  [cmt_open]'), 'listing the open comment with slide, element and id')
  ok(!msg.includes('cmt_done') && !msg.includes('Old note'), 'not the resolved one')
  ok(/subagent/.test(msg), 'with the alone-or-subagents instructions')
  ok(await waitFor(async () => /\x1b\[201~\n/.test(readFileSync(log, 'utf8'))), 'and submitted with Enter after the paste')
  ok(await wc.executeJavaScript(`window.beeslides.doc.slides[0].comments.find((c) => c.id === 'cmt_open').forAgent === true`), 'the sent comment is marked as sent')

  // review_slide through main's real capture: the agent-query file the MCP
  // server would write → the editor → capturePage cropped to the slide
  // Every session dir of the deck's context: the polish call before the panel
  // existed may have started a session of its own, and a dir can outlive its
  // tab — so the query goes to each and whichever live session answers wins.
  const sessionDirs = await waitFor(async () => {
    // The context dir lives in the deck's managed workspace (userData/claude-workspaces/<docId>), not next to the deck.
    const wsRoot = join(process.env.SLIDOMINGO_USER_DATA, 'claude-workspaces')
    const wsName = readdirSync(wsRoot).find((w) => readdirSync(join(wsRoot, w)).some((n) => n.startsWith('.slidomingo-context')))
    const root = wsName ? join(wsRoot, wsName) : null
    if (!root) return null
    const ctx = readdirSync(root).find((n) => n.startsWith('.slidomingo-context'))
    const dirs = ctx ? readdirSync(join(root, ctx)).filter((n) => /^session-[0-9a-f-]{36}$/.test(n)).map((n) => join(root, ctx, n)) : []
    return dirs.length ? dirs : null
  })
  ok(!!sessionDirs, 'the session has its context dir')
  const requestId = randomUUID()
  for (const dir of sessionDirs ?? []) {
    writeFileSync(join(dir, `.agent-query-${requestId}.json.tmp`), JSON.stringify({ requestId, verb: 'review_slide', args: {} }))
    renameSync(join(dir, `.agent-query-${requestId}.json.tmp`), join(dir, `agent-query-${requestId}.json`))
  }
  const answer = await waitFor(async () => {
    for (const dir of sessionDirs ?? []) {
      const f = join(dir, `agent-query-result-${requestId}.json`)
      if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
    }
    return null
  }, 15000)
  ok(answer?.ok === true, `review_slide answered (${answer?.error ?? 'ok'})`)
  if (!answer) console.log('        debug ' + JSON.stringify(readdirSync(sessionDir)) + ' ' + await wc.executeJavaScript(`JSON.stringify({ pop: !!document.querySelector('.ed-comment-pop'), dlg: [...document.querySelectorAll('dialog[open]')].map((d) => d.className), toast: document.querySelector('.ed-toast')?.textContent })`))
  const r = answer?.result
  ok(Array.isArray(r?.elements) && r.elements.some((l) => l.startsWith('hello text')), 'with the element frame list')
  ok(typeof r?.clean === 'boolean' && Array.isArray(r?.issues), 'and the check_layout findings')
  const png = r?.image?.data ? Buffer.from(r.image.data, 'base64') : null
  const pw = png?.readUInt32BE(16)
  const ph = png?.readUInt32BE(20)
  const sf = screen.getPrimaryDisplay().scaleFactor
  ok(!!png && !!r.rect && Math.abs(pw / sf - r.rect.width) <= 2 && Math.abs(ph / sf - r.rect.height) <= 2,
    `the screenshot is cropped to the slide (${pw}x${ph} px for a ${r?.rect?.width}x${r?.rect?.height} rect)`)
  ok(!!r?.rect && Math.abs(r.rect.width / r.rect.height - 16 / 9) < 0.02, 'which has the slide\'s aspect ratio')

  clearTimeout(hardStop)
  report()
  app.exit(0)
}

async function orchestrator() {
  if (!existsSync(SHELL_PATH)) { console.log(`missing ${SHELL_PATH} — run npm run build:single in slides/`); process.exit(2) }
  if (!existsSync(join(desktopDir, 'out/main/index.js'))) { console.log('missing out/main — run npx electron-vite build'); process.exit(2) }
  const electronPath = createRequire(import.meta.url)('electron')
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-e2e-prompt-'))
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
  const doc = Object.assign(newDoc(), { title: 'Prompt' })
  doc.slides[0].elements = [defaultText({ id: 'hello', html: 'Hello' })]
  const at = new Date().toISOString()
  doc.slides[0].comments = [
    { id: 'cmt_open', elementId: 'hello', author: 'Ann', text: 'Make it bigger', at },
    { id: 'cmt_done', author: 'Ann', text: 'Old note', at, resolved: true },
  ]
  const deck = join(work, 'Prompt.beeslides.html')
  writeFileSync(deck, shellHtml.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`))
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', deck], {
    cwd: desktopDir,
    env: {
      ...process.env, SHELL: shell, HOME: home, E2E_PTY_LOG: log, E2E_DECK: deck,
      SLIDOMINGO_USER_DATA: join(root, 'userdata'), SLIDOMINGO_TEMPLATES_DIR: join(root, 'templates'),
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
