// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Screenshots of slides that are not on the editing canvas (review_slide /
// render_preview with another slide's id). The renderer builds a standalone
// page of the slide (slides/src/editor/figureexport.ts slideSnapshotHtml) and
// this renders it in a hidden window and captures it, the way figureexport.ts
// prints a deck: the agent gets its picture and the user's view never moves.
//
// The page carries its own CSP (no script, no network: data: images and fonts
// only). The window adds an in-memory session, no navigation and no popups.

import { BrowserWindow, session, type NativeImage, type Session } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The capture's long side, in CSS px: the slide (or the asked part of it) is
 *  zoomed to fit, about what the canvas shows; capturePage adds the display's
 *  pixel ratio on top, as it does for an on-canvas shot. */
const SHOT_MAX_W = 1280
const SHOT_MAX_H = 800
/** A small area (one icon) is zoomed in at most this much. */
const SHOT_MAX_ZOOM = 4
const RENDER_TIMEOUT_MS = 8000
/** Time for the decoded pictures to reach a frame after fonts and images are ready. */
const SETTLE_MS = 80

let snapSession: Session | null = null
function getSession(): Session {
  if (snapSession) return snapSession
  snapSession = session.fromPartition('slidomingo-slide-snapshot') // no persist: = in memory
  snapSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  snapSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  return snapSession
}

export function isSnapshotRequest(v: unknown): v is { html: string; width: number; height: number } {
  const o = v as { html?: unknown; width?: unknown; height?: unknown } | null
  return !!o && typeof o.html === 'string' && o.html.startsWith('<!doctype html>')
    && [o.width, o.height].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 20_000)
}

async function render(html: string, width: number, height: number): Promise<NativeImage> {
  const zoom = Math.min(SHOT_MAX_ZOOM, SHOT_MAX_W / width, SHOT_MAX_H / height)
  const dir = mkdtempSync(join(tmpdir(), 'slidomingo-snapshot-'))
  const file = join(dir, 'slide.html')
  writeFileSync(file, html)
  const win = new BrowserWindow({
    show: false,
    width: Math.max(1, Math.round(width * zoom)),
    height: Math.max(1, Math.round(height * zoom)),
    useContentSize: true,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: getSession(),
      zoomFactor: zoom,
      backgroundThrottling: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      disableDialogs: true,
      autoplayPolicy: 'document-user-activation-required',
    },
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const wc = win.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.setAudioMuted(true)
    wc.on('will-navigate', (ev) => ev.preventDefault())
    const work = (async () => {
      await wc.loadFile(file)
      // embedded fonts and pictures must be ready before the capture
      await wc.executeJavaScript(
        `Promise.all([document.fonts.ready, ...Array.from(document.images).map(i => i.decode().catch(() => {}))]).then(() => true)`,
      )
      await new Promise((r) => setTimeout(r, SETTLE_MS))
      const img = await wc.capturePage()
      if (img.isEmpty()) throw new Error('empty capture')
      return img
    })()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`render timed out after ${RENDER_TIMEOUT_MS} ms`)), RENDER_TIMEOUT_MS)
    })
    work.catch(() => { /* settled after a timeout: nobody is listening */ })
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir */ }
  }
}

/** One render at a time: each is a whole Chromium renderer process. */
let queue: Promise<unknown> = Promise.resolve()

/** A PNG-ready image of the snapshot page, `width`×`height` CSS px zoomed to fit SHOT_MAX_*. */
export function captureSlideSnapshot(req: { html: string; width: number; height: number }): Promise<NativeImage> {
  const run = queue.then(() => render(req.html, req.width, req.height), () => render(req.html, req.width, req.height))
  queue = run.catch(() => undefined)
  return run
}
