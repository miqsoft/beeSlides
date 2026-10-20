// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Thumbnails for the start page's "Recent & drafts" and template grids.
//
// Every deck saved by a recent build carries a static render of its first
// page right after the boot splash (kernel/src/save.ts writePreview,
// slides/src/preview.ts), removed by a parser-blocking inline script. So a
// JavaScript-OFF render of the file shows exactly that page, and nothing of
// the document ever has to run. Encrypted decks never carry one (AGENTS.md
// rule 4) and get a lock; files without one get a generic document tile
// rather than a picture of the splash (thumbscan.ts decides which).
//
// HOW WE RENDER — measured with a throwaway Electron spike (2026-09-24,
// Electron 33, macOS 26, Retina), on the starter deck saved by the current
// build (1.3 MB) and a 24.5 MB corporate template:
//
//   hidden BrowserWindow, JS off     200 ms / 450 ms, the same every time
//   nativeImage.createThumbnailFromPath (QuickLook)
//                                    ~1.0-1.5 s for a path QuickLook has not
//                                    seen, 2 ms once it has (its own cache)
//
// In the app (desktop/scripts/e2e-thumbnail.mjs) a render takes 300-470 ms,
// the first one ~1.1 s (session + renderer spin-up); a cache hit ~1 ms.
//
// Both showed the real first slide for both decks. We use the window on every
// platform: it is faster where it matters (our own disk cache makes
// QuickLook's irrelevant), identical on macOS/Windows/Linux, and entirely
// under our control — JS off, sandboxed, in-memory session, network refused.
// QuickLook renders with whatever generator the user's system has for
// public.html (a source-code highlighter plugin would thumbnail the markup),
// and createThumbnailFromPath is macOS/Windows-only and, on Windows, has no
// HTML handler at all. It remains a macOS fallback when the window fails.
//
// ONE GOTCHA the spike found. The preview fits itself to the viewport with
// `scale(calc(min(100vw, <aspect>vh) / <width>px))`. Electron 33's Chromium
// predates CSS typed arithmetic, drops that declaration and keeps the 1:1
// fallback before it — in a 640×360 window, a cropped middle of the slide.
// Zooming the page by 640/<page width> makes the viewport exactly the page's
// CSS size, where 1:1 is the whole page (and where the scale() evaluates to 1
// on an engine that does support it, so this stays right after an upgrade).
import { app, BrowserWindow, nativeImage, session, type NativeImage, type Session } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileAtomic } from './fsutil.ts'
import { handleFrom } from './ipcguard.ts'
import { scanThumbSource, thumbCacheName } from './thumbscan.ts'

export type ThumbnailResult = { dataUrl: string } | { placeholder: 'lock' | 'doc' }

export const THUMB_WIDTH = 640
export const THUMB_HEIGHT = 360
const RENDER_TIMEOUT_MS = 8000
/** Time for a loaded page's decoded images to reach a frame (JS-off pages
 *  have no rAF to wait on). */
const SETTLE_MS = 120
/** The static layer's first slide usually carries full-size pictures (a
 *  6 MB background on a corporate template): give them longer to decode. */
const STATIC_SETTLE_MS = 400

/** Shows the static layer's first slide alone, at the top-left of the page
 *  (its natural size, which zoomFactor fits to the window), over neither the
 *  splash nor the 64 KB preview. */
const STATIC_FIRST_SLIDE_CSS =
  // both spellings: files saved before 2026-10-20 say `slidomingo` (kernel/src/legacynames.ts)
  '[data-beeslides-preview],#beeslides-splash,[data-slidomingo-preview],#slidomingo-splash{display:none!important}' +
  ' [data-beeslides-static-slide]:not(:first-of-type),[data-slidomingo-static-slide]:not(:first-of-type){display:none}' +
  ' body{margin:0}'

function warn(...args: unknown[]): void {
  try { console.warn('[thumbs]', ...args) } catch { /* stdout/stderr gone — see desktop/CLAUDE.md */ }
}

// --- disk cache -------------------------------------------------------------
//
// userData/Thumbnails/<sha256(resolved path) first 24 hex>-<mtime ms>-v<N>.png
// (thumbscan.ts thumbCacheName; N changes when thumbnails start to look
// different, so older PNGs regenerate). The
// same hash windows.ts uses for partitions, so the real path never appears in
// a filename. A new mtime replaces every older entry for that path, and so
// does a placeholder: a deck that gained a password must not keep a picture
// of its first page lying around (AGENTS.md rule 4).

function cacheDir(): string {
  return join(app.getPath('userData'), 'Thumbnails')
}

function pathHash(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex').slice(0, 24)
}

function cacheFile(hash: string, mtimeMs: number): string {
  return join(cacheDir(), thumbCacheName(hash, mtimeMs))
}

function dropStale(hash: string, keep: string | null): void {
  let names: string[]
  try { names = readdirSync(cacheDir()) } catch { return }
  for (const n of names) {
    if (!n.startsWith(hash + '-') || !n.endsWith('.png')) continue
    const full = join(cacheDir(), n)
    if (full === keep) continue
    try { rmSync(full, { force: true }) } catch { /* best effort */ }
  }
}

/** Placeholder verdicts for files we've already read, keyed like the disk
 *  cache — saves re-scanning a 24 MB file with no preview on every visit to
 *  the start page. Bounded; it only ever holds tiny strings. */
const placeholderMemo = new Map<string, 'lock' | 'doc'>()
const MEMO_MAX = 1000
function memoPlaceholder(key: string, value: 'lock' | 'doc'): void {
  if (placeholderMemo.size >= MEMO_MAX) placeholderMemo.delete(placeholderMemo.keys().next().value as string)
  placeholderMemo.set(key, value)
}

// --- rendering --------------------------------------------------------------

let thumbSession: Session | null = null
/** The one file the render window may load as its main frame (one render
 *  at a time, so one slot is enough). */
let allowedMainPath: string | null = null

function isAllowedMainFrame(url: string): boolean {
  if (!allowedMainPath || !/^file:/i.test(url)) return false
  try { return resolve(fileURLToPath(url)) === allowedMainPath } catch { return false }
}

function getSession(): Session {
  if (thumbSession) return thumbSession
  // No `persist:` prefix → in memory only, and never shared with a document.
  const ses = session.fromPartition('slidomingo-thumbnails')
  ses.webRequest.onBeforeRequest((details, cb) => {
    const url = details.url
    let ok: boolean
    if (details.resourceType === 'mainFrame') ok = isAllowedMainFrame(url)
    else if (details.resourceType === 'subFrame') ok = false
    else ok = /^(file|data|blob):/i.test(url)
    cb({ cancel: !ok })
  })
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  thumbSession = ses
  return ses
}

function toThumb(img: NativeImage): NativeImage {
  const { width, height } = img.getSize()
  if (width === THUMB_WIDTH && height === THUMB_HEIGHT) return img
  return img.resize({ width: THUMB_WIDTH, height: THUMB_HEIGHT, quality: 'best' })
}

/** JS-off render of `path` in a hidden, sandboxed window. While it exists it
 *  counts in BrowserWindow.getAllWindows() (not in windows.ts
 *  allDocumentWindows) — for well under a second, never visible. Always
 *  destroys the window; rejects on load failure, an empty capture, or the
 *  timeout. */
async function renderInWindow(path: string, page: { width: number; height: number; hasStatic?: boolean }): Promise<NativeImage> {
  const zoomFactor = Math.min(THUMB_WIDTH / page.width, THUMB_HEIGHT / page.height)
  const win = new BrowserWindow({
    show: false,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    useContentSize: true,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: getSession(),
      zoomFactor,
      backgroundThrottling: false,
      spellcheck: false,
      webgl: false,
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
    allowedMainPath = resolve(path)
    // A <meta refresh> still works with scripting off; the request filter
    // refuses the navigation, this stops it before it starts.
    wc.on('will-navigate', (ev) => ev.preventDefault())
    const work = (async () => {
      await wc.loadFile(path)
      // Full fidelity when the file has it: the static layer's first slide
      // instead of the budget-capped preview (thumbscan.ts). Without one, the
      // preview exactly as before.
      if (page.hasStatic) await wc.insertCSS(STATIC_FIRST_SLIDE_CSS)
      await new Promise((r) => setTimeout(r, page.hasStatic ? STATIC_SETTLE_MS : SETTLE_MS))
      const img = await wc.capturePage()
      if (img.isEmpty()) throw new Error('empty capture')
      return img
    })()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`render timed out after ${RENDER_TIMEOUT_MS} ms`)), RENDER_TIMEOUT_MS)
    })
    work.catch(() => { /* settled after a timeout: nobody is listening */ })
    return toThumb(await Promise.race([work, timeout]))
  } finally {
    if (timer) clearTimeout(timer)
    allowedMainPath = null
    if (!win.isDestroyed()) win.destroy()
  }
}

/** macOS only: QuickLook's thumbnail, for when the window path failed. */
async function renderWithQuickLook(path: string): Promise<NativeImage> {
  let timer: NodeJS.Timeout | undefined
  try {
    const img = await Promise.race([
      nativeImage.createThumbnailFromPath(path, { width: THUMB_WIDTH, height: THUMB_HEIGHT }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('QuickLook timed out')), RENDER_TIMEOUT_MS) }),
    ])
    if (img.isEmpty()) throw new Error('empty QuickLook thumbnail')
    return toThumb(img)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// --- queue --------------------------------------------------------------------

/** One render at a time: each is a whole Chromium renderer process. */
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.catch(() => undefined)
  return run
}

interface InFlight {
  promise: Promise<ThumbnailResult>
  /** Every caller waiting on this render; it is skipped when none still is. */
  wanted: Array<() => boolean>
}
const inFlight = new Map<string, InFlight>()

export interface ThumbnailOptions {
  /** Checked just before rendering: false (e.g. the asking window closed)
   *  skips the render. A skipped render answers `doc` and caches nothing. */
  isWanted?: () => boolean
}

async function produce(path: string, hash: string, mtimeMs: number, key: string, entry: InFlight): Promise<ThumbnailResult> {
  const source = await scanThumbSource(path)
  if (source.kind !== 'preview') {
    const placeholder = source.kind === 'enc' ? 'lock' : 'doc'
    dropStale(hash, null)
    memoPlaceholder(key, placeholder)
    return { placeholder }
  }
  if (!entry.wanted.some((f) => f())) return { placeholder: 'doc' }

  let img: NativeImage
  try {
    img = await renderInWindow(path, source)
  } catch (err) {
    warn('render failed:', err instanceof Error ? err.message : err)
    if (process.platform !== 'darwin') { memoPlaceholder(key, 'doc'); return { placeholder: 'doc' } }
    try {
      img = await renderWithQuickLook(path)
    } catch (err2) {
      warn('QuickLook fallback failed:', err2 instanceof Error ? err2.message : err2)
      memoPlaceholder(key, 'doc')
      return { placeholder: 'doc' }
    }
  }

  const png = img.toPNG()
  const file = cacheFile(hash, mtimeMs)
  try {
    mkdirSync(cacheDir(), { recursive: true })
    writeFileAtomic(file, png)
    dropStale(hash, file)
  } catch (err) {
    warn('cache write failed:', err instanceof Error ? err.message : err)
  }
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}` }
}

/**
 * The start-page tile for `path`: a 640×360 PNG of the deck's first page, or
 * which placeholder to draw. Never rejects — anything unexpected (missing
 * file, unreadable, render failure) is `{ placeholder: 'doc' }`.
 */
export async function getThumbnail(path: string, opts: ThumbnailOptions = {}): Promise<ThumbnailResult> {
  try {
    if (typeof path !== 'string' || !isAbsolute(path) || !/\.html?$/i.test(path)) return { placeholder: 'doc' }
    const st = statSync(path)
    if (!st.isFile()) return { placeholder: 'doc' }
    const hash = pathHash(path)
    const key = `${hash}-${Math.trunc(st.mtimeMs)}`

    const memo = placeholderMemo.get(key)
    if (memo) return { placeholder: memo }
    try {
      const png = readFileSync(cacheFile(hash, st.mtimeMs))
      return { dataUrl: `data:image/png;base64,${png.toString('base64')}` }
    } catch { /* not cached yet */ }

    const wanted = opts.isWanted ?? (() => true)
    const existing = inFlight.get(key)
    if (existing) {
      existing.wanted.push(wanted)
      return await existing.promise
    }
    const entry: InFlight = { promise: Promise.resolve({ placeholder: 'doc' }), wanted: [wanted] }
    entry.promise = enqueue(() => produce(path, hash, st.mtimeMs, key, entry))
      .catch((err): ThumbnailResult => {
        warn('failed:', err instanceof Error ? err.message : err)
        return { placeholder: 'doc' }
      })
      .finally(() => { inFlight.delete(key) })
    inFlight.set(key, entry)
    return await entry.promise
  } catch {
    return { placeholder: 'doc' }
  }
}

/** `slidomingo:get-thumbnail` — never rejects (see index.ts safeHandle for why
 *  a rejected ipcMain.handle is a crash risk here). A render queued for a
 *  window that has since closed is skipped. */
export function registerThumbnailIpc(): void {
  handleFrom('app-shell', 'slidomingo:get-thumbnail', async (ev, path: unknown): Promise<ThumbnailResult> => {
    try {
      const sender = ev.sender
      return await getThumbnail(typeof path === 'string' ? path : '', { isWanted: () => !sender.isDestroyed() })
    } catch {
      return { placeholder: 'doc' }
    }
  })
}
