// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Starts the app a clip is recorded in and hands back a raw CDP session to
// the editor page. Both apps are driven through the same small CDP surface
// (lib/driver.mjs), so a scenario runs unchanged in either.
//
//   desktop  the Electron app (desktop/out, `npx electron-vite build`), with a
//            throwaway profile, opened on a scratch copy of the editor shell.
//            playwright-core's _electron.launch and connectOverCDP both hang
//            on this app (desktop/CLAUDE.md), so we speak CDP ourselves over
//            --remote-debugging-port.
//   web      the single-file editor in headless Chromium (playwright-core).

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A CDP session over a page target's WebSocket: { send, on, close }. */
export async function wsSession(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`CDP: cannot connect ${wsUrl}`)) })
  let seq = 0
  const pending = new Map(), handlers = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? rej(new Error(`${msg.error.message} (${msg.error.data ?? ''})`)) : res(msg.result)
    } else if (msg.method) for (const h of handlers.get(msg.method) ?? []) h(msg.params)
  }
  return {
    send: (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }))
    }),
    on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    close: () => ws.close(),
  }
}

export async function launchDesktop({ repo, viewport, doc, fixedViewport = true }) {
  const desktop = join(repo, 'desktop')
  const pathTxt = join(desktop, 'node_modules/electron/path.txt')
  const main = join(desktop, 'out/main/index.js')
  const shell = join(repo, 'slides/dist-single/BeeSlides.beeslides.html')
  if (!existsSync(pathTxt)) throw new Error('no Electron — npm install in desktop/')
  if (!existsSync(main)) throw new Error('no desktop build — cd desktop && npx electron-vite build')
  if (!existsSync(shell)) throw new Error('no editor build — cd slides && npm run build:single')
  const { readFileSync, writeFileSync } = await import('node:fs')
  const bin = join(desktop, 'node_modules/electron/dist', readFileSync(pathTxt, 'utf8').trim())

  // Throwaway everything: profile, layouts, library, UI profile, and the deck.
  const tmp = mkdtempSync(join(tmpdir(), 'bee-clip-app-'))
  const deck = join(tmp, 'Demo.beeslides.html')
  copyFileSync(shell, deck)
  // An empty doc block makes the app show its start page; put the scenario's
  // deck in the block (splice contract: plaintext JSON, `<` escaped).
  if (doc) {
    const json = JSON.stringify({ ...doc, docId: crypto.randomUUID() }).replace(/</g, '\\u003c')
    const html = readFileSync(deck, 'utf8')
    const re = /(<script[^>]*\bid=["']beeslides-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i
    if (!re.test(html)) throw new Error('no #beeslides-doc block in the editor shell')
    writeFileSync(deck, html.replace(re, (_, open, _old, close) => open + json + close))
  }
  const port = 9300 + Math.floor(Math.random() * 500)
  const proc = spawn(bin, [desktop, `--remote-debugging-port=${port}`, '--open', deck], {
    stdio: 'ignore',
    env: {
      ...process.env,
      SLIDOMINGO_USER_DATA: join(tmp, 'userdata'),
      SLIDOMINGO_TEMPLATES_DIR: join(tmp, 'templates'),
      SLIDOMINGO_LIBRARY_PATH: join(tmp, 'library.beeslides.html'),
      SLIDOMINGO_UI_PROFILE_PATH: join(tmp, 'ui-profile.json'),
      SLIDOMINGO_NO_UI_PROFILE: '1',
    },
  })
  const close = async () => {
    // The app answers SIGTERM with its save-on-quit flow; the profile is a
    // throwaway, so don't wait for it.
    proc.kill('SIGKILL')
    await sleep(300)
    rmSync(tmp, { recursive: true, force: true })
  }
  try {
    // Find the deck's page: the editor shell with the desktop bridge (start-page
    // thumbnails and the terminal are page targets too).
    for (let i = 0; i < 80; i++) {
      await sleep(250)
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => [])
      for (const t of list.filter((t) => t.type === 'page' && t.url.includes('dist-single'))) {
        const cdp = await wsSession(t.webSocketDebuggerUrl)
        const { result } = await cdp.send('Runtime.evaluate', {
          expression: '!!(window.slidomingoDesktop && window.beeslides?.doc && document.querySelector(".ed-sidebar") && !document.getElementById("beeslides-splash"))',
          returnByValue: true,
        })
        if (result.value) {
          if (fixedViewport) await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale,
            mobile: false, screenWidth: viewport.width, screenHeight: viewport.height,
          })
          // Clips look the same on every machine: dark, whatever the OS says.
          await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: viewport.colorScheme ?? 'dark' }] })
          return { cdp, close, app: 'desktop', port }
        }
        cdp.close()
      }
    }
    throw new Error('the desktop app did not open an editor window')
  } catch (e) { await close(); throw e }
}

export async function launchWeb({ url, viewport, headed }) {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ headless: !headed })
  const ctx = await browser.newContext({
    viewport, screen: viewport, deviceScaleFactor: viewport.scale, locale: 'en-US', colorScheme: viewport.colorScheme ?? 'dark',
  })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await page.goto(url)
  await page.waitForFunction(() => window.beeslides?.doc && document.querySelector('.ed-sidebar') && !document.getElementById('beeslides-splash'))
  return { cdp, close: () => browser.close(), app: 'web' }
}

export const webUrl = (repo) => {
  const built = join(repo, 'slides/dist-single/BeeSlides.beeslides.html')
  return existsSync(built) ? pathToFileURL(built).href : null
}
