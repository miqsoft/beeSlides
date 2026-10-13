// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// One-click Present (docs/DECISIONS.md, "Desktop present"). The renderer asks
// main to lay out the displays; main moves the deck window to the audience
// display (the largest one that isn't the editor's) so the slides go
// fullscreen there, and hands back the editor display's bounds for the speaker
// window. The renderer then opens the speaker window itself (window.open) and
// the open handler below places it. Esc restores the window exactly.

import { screen } from 'electron'
import type { BrowserWindow, Rectangle, WebContents, WebPreferences } from 'electron'
import { windowForDocWebContents } from './windows.ts'
import { handleFrom } from './ipcguard.ts'
import { openIfClickedLink } from './navguard.ts'

export const SPEAKER_FRAME_NAME = 'slidomingo-speaker'

interface Saved { bounds: Rectangle; maximized: boolean; fullscreen: boolean }

/** Keyed by window id: what present-end puts back. */
const saved = new Map<number, Saved>()
/** Keyed by doc webContents id: where the next speaker window opens. */
const pendingSpeaker = new Map<number, Rectangle>()

const INSET = 40

function inset(r: Rectangle): Rectangle {
  return { x: r.x + INSET, y: r.y + INSET, width: Math.max(600, r.width - 2 * INSET), height: Math.max(400, r.height - 2 * INSET) }
}

function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const tick = () => (cond() || Date.now() - t0 > ms ? resolve() : setTimeout(tick, 30))
    tick()
  })
}

export type PresentBeginResult = { speaker: boolean }

async function begin(win: BrowserWindow, docWcId: number): Promise<PresentBeginResult> {
  const displays = screen.getAllDisplays()
  if (displays.length < 2) return { speaker: false }
  const editor = screen.getDisplayMatching(win.getBounds())
  const audience = displays
    .filter((d) => d.id !== editor.id)
    .sort((a, b) => b.size.width * b.size.height - a.size.width * a.size.height)[0]
  if (!audience) return { speaker: false }
  pendingSpeaker.set(docWcId, inset(editor.workArea))
  if (!saved.has(win.id)) {
    const fullscreen = win.isFullScreen()
    if (fullscreen) { win.setFullScreen(false); await waitFor(() => win.isDestroyed() || !win.isFullScreen(), 2000) }
    if (win.isDestroyed()) return { speaker: false }
    saved.set(win.id, { bounds: win.getBounds(), maximized: win.isMaximized(), fullscreen })
  }
  if (win.isMaximized()) win.unmaximize()
  win.setBounds(audience.workArea)
  return { speaker: true }
}

async function end(win: BrowserWindow, docWcId: number): Promise<void> {
  pendingSpeaker.delete(docWcId)
  const s = saved.get(win.id)
  if (!s) return
  saved.delete(win.id)
  // the renderer leaves HTML fullscreen first; setBounds during that
  // transition is ignored on macOS
  await waitFor(() => win.isDestroyed() || !win.isFullScreen(), 2000)
  if (win.isDestroyed()) return
  win.setBounds(s.bounds)
  if (s.maximized) win.maximize()
  if (s.fullscreen) win.setFullScreen(true)
}

/** The speaker window's own preferences: NO preload. It is an about:blank
 *  page the doc view paints into and drives (present.ts, screens.ts) — its
 *  keys fire in the opener's listeners and it never calls the desktop bridge,
 *  so it gets none (ipcguard.ts would refuse it anyway). */
export const SPEAKER_WEB_PREFERENCES: WebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  navigateOnDragDrop: false,
}

/** Window-open handler for the doc view: only the speaker window may open, and
 *  it lands on the editor's display (its about:blank page keeps the doc's
 *  origin — the renderer paints into it). Everything else is denied: a web or
 *  mail link reaches the user's browser only from a click, through
 *  `slidomingo:open-external` (index.ts), a guarded navigation or a clicked
 *  target=_blank link (navguard.ts), never from a script's window.open. */
export function attachSpeakerOpenHandler(wc: WebContents, onCreated: (child: BrowserWindow) => void): void {
  wc.setWindowOpenHandler(({ frameName, url }) => {
    if (frameName !== SPEAKER_FRAME_NAME) {
      // another app's page has no preload to send the click: its clicked
      // target=_blank link is matched against the last trusted link click
      void openIfClickedLink(wc, url)
      return { action: 'deny' }
    }
    const b = pendingSpeaker.get(wc.id)
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        ...(b ?? { width: 1200, height: 800 }), autoHideMenuBar: true, webPreferences: { ...SPEAKER_WEB_PREFERENCES },
      },
    }
  })
  wc.on('did-create-window', (child) => {
    // The speaker window is an about:blank page the doc view paints into: it
    // never opens a window or navigates by itself. Without these a link
    // followed inside it would open as an APP window (Electron's default is
    // allow, with the doc view's preferences) or replace the speaker view.
    // The renderer also strips hrefs there (present.ts svSlide); this is the
    // backstop.
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    child.webContents.on('will-navigate', (ev) => ev.preventDefault())
    onCreated(child)
  })
}

export function registerPresentIpc(): void {
  handleFrom('app-shell', 'slidomingo:present-begin', async (ev): Promise<PresentBeginResult> => {
    const win = windowForDocWebContents(ev.sender.id)
    if (!win) return { speaker: false }
    try { return await begin(win, ev.sender.id) } catch { return { speaker: false } }
  })
  handleFrom('app-shell', 'slidomingo:present-end', async (ev): Promise<void> => {
    const win = windowForDocWebContents(ev.sender.id)
    if (win) try { await end(win, ev.sender.id) } catch { /* best effort */ }
  })
}
