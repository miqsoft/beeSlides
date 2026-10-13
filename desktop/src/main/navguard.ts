// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Navigation, new windows and external links — deny by default.
//
// Views that carry a privileged preload (the doc view, the terminal panel)
// must never leave the page main loaded into them: whatever they navigate to
// inherits the preload, and with it the whole IPC surface. A deck keeps
// remote `<a href="https://…">` inside svg (render.ts SVG_HREF_REMOTE), and a
// file dropped on a view that doesn't handle drops navigates to that file.
// None of these views ever navigates on its own (loads, reloads and in-page
// `#hash` changes don't emit will-navigate), so every page-started main-frame
// navigation is refused (guardNavigation).
//
// Underneath that, EVERY webContents the app creates (installDefaultGuards,
// app 'web-contents-created') starts out unable to open a window or navigate
// to anything but the app's own pages; the few that may (the doc view's
// speaker window, present.ts) set their own window-open handler afterwards,
// which replaces the default.
//
// A link only ever leaves the app for the user's browser / mail app when the
// user clicked it, http(s)/mailto only, at most once a second per view — a
// page can't fire the browser at will or in a loop. Two ways in, both read
// in an isolated world the page cannot reach:
//   - an explicit request (`slidomingo:open-external`, the doc preload's click
//     handler and present mode): the page must have a user activation right
//     now (openExternalFromUser);
//   - a followed link in a guarded view (another app's page has no preload):
//     the navigation must go exactly where the last TRUSTED click on a link
//     pointed, within the last moment (trackLinkClicks + guardNavigation). A
//     navigation consumes the activation, so that can't be asked afterwards.
import { app, shell, type WebContents } from 'electron'

/** The schemes a link may hand to the OS. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
/** Below the transient-activation window, so one click is one hand-off. */
const EXTERNAL_LINK_GAP_MS = 1000
/** Our own isolated world (999 is Electron's contextIsolation world). */
const GUARD_WORLD_ID = 1077
/** How long a trusted link click vouches for the navigation it starts. */
const LINK_CLICK_MS = 1500

/** `raw` as an href the OS may open, or null. */
export function externalLinkUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null
  try {
    const url = new URL(raw)
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch { return null }
}

/** Does the page have a transient user activation right now? Read in an
 *  isolated world: the main world could redefine `navigator.userActivation`,
 *  but not the frame's real activation state. False on any doubt. */
export async function hasUserActivation(wc: WebContents): Promise<boolean> {
  if (wc.isDestroyed()) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const active = await Promise.race([
      wc.executeJavaScriptInIsolatedWorld(GUARD_WORLD_ID, [{ code: 'navigator.userActivation.isActive === true' }]),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1500) }),
    ])
    return active === true
  } catch { return false } finally { if (timer) clearTimeout(timer) }
}

const lastExternal = new WeakMap<WebContents, number>()

/** The hand-off itself, at most once per EXTERNAL_LINK_GAP_MS per view. */
async function handOff(wc: WebContents, url: string): Promise<boolean> {
  const now = Date.now()
  if (now - (lastExternal.get(wc) ?? 0) < EXTERNAL_LINK_GAP_MS) return false
  lastExternal.set(wc, now)
  try { await shell.openExternal(url) } catch { /* no browser: the link just does nothing */ }
  return true
}

/** Open `raw` in the user's browser / mail app — only for an http(s)/mailto
 *  URL and only during a user activation in `wc`. Resolves whether it was
 *  handed off. */
export async function openExternalFromUser(wc: WebContents, raw: unknown): Promise<boolean> {
  const url = externalLinkUrl(raw)
  if (!url || !(await hasUserActivation(wc))) return false
  return handOff(wc, url)
}

/** Installed in GUARD_WORLD_ID at every load: remembers the target of the
 *  last trusted click on a link (html or svg `<a>`, either href spelling). */
const LINK_CLICK_TRACKER = `(() => {
  if (globalThis.__slidomingoLinkTracker) return
  globalThis.__slidomingoLinkTracker = true
  const note = (ev) => {
    if (!ev.isTrusted) return
    const a = ev.target && ev.target.closest ? ev.target.closest('a') : null
    const raw = a && (a.getAttribute('href') || a.getAttributeNS('http://www.w3.org/1999/xlink', 'href'))
    if (!raw) return
    try { globalThis.__slidomingoLinkClick = { href: new URL(raw, document.baseURI).href, t: performance.now() } } catch {}
  }
  window.addEventListener('click', note, true)
  window.addEventListener('auxclick', note, true)
})()`

/** Read once: the URL the last trusted link click pointed at, if recent. */
const TAKE_LINK_CLICK = `(() => {
  const c = globalThis.__slidomingoLinkClick
  globalThis.__slidomingoLinkClick = null
  return c && performance.now() - c.t < ${LINK_CLICK_MS} ? c.href : null
})()`

function trackLinkClicks(wc: WebContents): void {
  wc.on('dom-ready', () => {
    if (!wc.isDestroyed()) wc.executeJavaScriptInIsolatedWorld(GUARD_WORLD_ID, [{ code: LINK_CLICK_TRACKER }]).catch(() => { /* page gone */ })
  })
}

async function clickedLinkTo(wc: WebContents, url: string): Promise<boolean> {
  if (wc.isDestroyed()) return false
  try {
    return (await wc.executeJavaScriptInIsolatedWorld(GUARD_WORLD_ID, [{ code: TAKE_LINK_CLICK }])) === url
  } catch { return false }
}

/** A `<a target="_blank">` the user clicked in a guarded view arrives as a
 *  window-open request: hand it over when it goes exactly where the last
 *  trusted link click pointed (a script's window.open never does). */
export async function openIfClickedLink(wc: WebContents, raw: unknown): Promise<boolean> {
  const url = externalLinkUrl(raw)
  if (!url || !(await clickedLinkTo(wc, url))) return false
  return handOff(wc, url)
}

/** For views with a privileged preload, or another app's page: no
 *  page-started navigation at all; a web/mail link the user clicked goes to
 *  the user's browser instead. */
export function guardNavigation(wc: WebContents): void {
  trackLinkClicks(wc)
  wc.on('will-navigate', (ev, raw) => {
    ev.preventDefault()
    const url = externalLinkUrl(raw)
    if (url) void clickedLinkTo(wc, url).then((clicked) => (clicked ? handOff(wc, url) : false))
  })
}

/** Deny-by-default for every webContents the app creates, before any code of
 *  ours configures it: no window.open (a view that needs one sets its own
 *  handler, which replaces this), no navigation to a page that isn't the
 *  app's own (`isAppUrl` — reloads and main-process loads don't ask), no
 *  <webview>. Call once, before the first window. */
export function installDefaultGuards(isAppUrl: (url: string) => boolean): void {
  app.on('web-contents-created', (_ev, wc) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (ev, url) => {
      if (!isAppUrl(url)) ev.preventDefault()
    })
    wc.on('will-attach-webview', (ev) => ev.preventDefault())
  })
}
