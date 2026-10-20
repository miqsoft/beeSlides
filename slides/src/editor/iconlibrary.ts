// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon library search & insert (#8). A found icon becomes an ordinary `svg`
// or `image` element — no new element type, no new trust boundary.
//
// ANY NUMBER OF SOURCES, managed in Settings ▸ Icon library (iconsettings.ts)
// and searched TOGETHER by the Icons popover — each one is either a server or
// a folder (see IconSource). One that fails does not hide the others'
// results; its problem is listed beside them. Two kinds:
//   (a) a remote icon SERVER — any server implementing this generic contract
//       (a small Flask icon server is one such server, not a dependency; we
//       do not ship a reference implementation — see docs/DECISIONS.md 2026-09-02):
//         GET {base}/api/search?q=...&limit=60
//           -> { results: [{ relative_path, display_name, description?,
//                             category?, score?, ... }] }
//           (`limit` may be ignored — only the first 60 are used — but a
//           large library answering an empty query in full can pass the
//           desktop app's 25 MB response cap)
//         GET {base}/files/{relative_path}
//           -> raw bytes (svg or a raster image)
//       Unknown/extra fields in a result are ignored, so any compatible
//       server works. Two optional extras are honoured when present:
//         - an API TOKEN (Settings, in the source's card), sent on every request
//           as `Authorization: Bearer <token>` — for servers that sit behind
//           a login. Never part of the document. In a browser it is a viewer
//           preference in localStorage; in the DESKTOP app it never enters
//           the page at all: main keeps it encrypted (safeStorage, like the
//           AI keys) and makes every icon-server request itself
//           (desktop/src/main/icontokens.ts, `serverFetch` below) — which
//           also means no CORS is needed there. Because a header can't ride
//           on an <img src>, authed thumbnails are fetched and shown as
//           blob: URLs.
//         - `png_url` in a result (a server-relative PNG rendering with a
//           `size` param): used, shrunk, for those authed thumbnails, so the
//           grid doesn't download every original at full size.
//       A server that wants the token cross-origin must also answer the
//       preflight: the Authorization header makes every request
//       non-simple, so `OPTIONS` has to succeed WITHOUT auth and send
//       `Access-Control-Allow-Headers: Authorization` (the `*` wildcard does
//       not cover it).
//
//       Multi-root addressing (optional, for anyone implementing their own
//       server): the original server's contract has a single hardcoded icon root,
//       but nothing here requires that — a compatible server can support
//       several icon directories under the same two endpoints by namespacing
//       `relative_path` as `"<dirId>/<path-within-that-directory>"`, then
//       splitting off the leading id in its `/files` handler to resolve
//       against the right root (with an explicit containment check, since
//       e.g. Node has no built-in equivalent of Werkzeug's `safe_join`).
//       This client only ever treats `relative_path` as an opaque token to
//       round-trip into the `/files/` URL, so it needs no changes either way.
//
//       Trust boundary a compatible server is expected to hold: bind to
//       loopback (127.0.0.1), not 0.0.0.0 — there is no reason to expose an
//       arbitrary-local-filesystem browser to the LAN by default — and don't
//       bother sanitizing served SVGs (the original server only sanitizes at
//       upload time, never at serve time). BeeSlides never relies on the
//       server for that anyway; see SECURITY below.
//
//       CORS: the editor's origin (a dev server, a saved file://, or a
//       shell-served page) is essentially never the icon server's origin, so
//       every request here is a cross-origin `fetch`. A bare Flask app
//       (verified live 2026-09-01) sends no
//       Access-Control-Allow-Origin header and the browser blocks the fetch
//       outright — server mode is NOT usable against an unmodified
//       Flask server until the server adds CORS headers (or is
//       reverse-proxied onto the editor's own origin). This is a real gap in
//       the "no changes needed" assumption, not a bug in this file; the
//       catch blocks below at least turn the browser's opaque "Failed to
//       fetch" into an actionable message.
//   (b) a local FOLDER via showDirectoryPicker() — same File System Access
//       API family already used for save/open (see ../save.ts). No server
//       needed at all, so it has no CORS problem; filtering is a plain
//       filename substring match. An `icons.json` in the folder (or any
//       subfolder) — what an exported icon set carries (../iconset.ts
//       iconManifest: `{ license?, author?, icons: [{ file, name, keywords? }] }`,
//       `file` relative to the manifest) — adds its names and keywords to that
//       match and its licence/author to each icon's provenance; a malformed one
//       is ignored. Without one, nothing changes.
//
// SECURITY. A remote, user-configurable server cannot be trusted to have
// sanitized what it serves (a server may sanitize SVGs on upload, but
// that is THEIR guarantee, not ours, and a local folder is arbitrary files on
// disk). So a fetched SVG's raw markup is interned into doc.assets exactly
// like a pasted external SVG would be, and is sanitized the same way pasted
// SVGs already are: render.ts's sanitizeSvg runs AT RENDER, EVERY RENDER
// (see render.ts's doc comment on that function) — the editor canvas,
// thumbnails and present mode all funnel through the same renderer, so raw
// markup sitting in doc.assets is never trusted anywhere it would matter.
// This mirrors the existing paste-external-svg path exactly; it is not a new
// mechanism. The one place raw markup IS used directly is grid-thumbnail
// previews, via `<img src="data:image/svg+xml,...">` — an <img> is an IMAGE
// context, so embedded <script>/on* handlers never execute there either
// (verified live, see the fork report for this workstream).

import type { Store } from '../store'
import { t } from '../i18n'
import { lsGet, lsSet } from '../../../kernel/src/storage.ts'
import { netFetch, OfflineError, offlineEnabled, remoteSrcBlocked } from '../../../kernel/src/net.ts'
import { defaultImage, uid, type SlidomingoDoc, type ImageElement, type Provenance, type SlideElement, type SvgElement } from '../model'
import { positionFloating } from './floatingposition'
import { ICON_MANIFEST_FILE, manifestMatches, parseIconManifest, type ManifestEntry } from '../iconset'

// --- sources: settings persistence -------------------------------------------

/** The desktop shell's icon-token bridge (desktop/src/preload/index.ts). */
interface IconDesktop {
  setIconToken(id: string, url: string, token: string | null): Promise<{ ok: boolean; error?: string }>
  iconTokenStatus(list: Array<{ id: string; url: string }>): Promise<Record<string, boolean>>
  adoptIconTokens(list: Array<{ id: string; url: string; token: string }>): Promise<boolean>
  iconFetch(id: string, url: string): Promise<
    | { ok: true; status: number; contentType: string; body: Uint8Array; authed: boolean }
    | { ok: false; error: string; offline?: boolean }
  >
}

/** Non-null in the desktop app: tokens live in main, requests go through it. */
export function iconDesktop(): IconDesktop | null {
  const d = (globalThis as { slidomingoDesktop?: Partial<IconDesktop> }).slidomingoDesktop
  return d?.iconFetch && d.setIconToken ? (d as IconDesktop) : null
}

/** `token` is only ever filled in a browser — in the desktop app it is ''
 *  and the token sits encrypted in main (see `iconDesktop`).
 *  `license` is what the person says about EVERYTHING this source serves
 *  ("CC0-1.0", "Company-owned"); a server that sends a license per icon wins
 *  over it. Blank = unknown, and icons inserted from it are flagged by the
 *  validator's `unlicensed-artwork`. */
export type IconSource =
  | { id: string; kind: 'server'; name: string; enabled: boolean; url: string; token: string; license?: string }
  | { id: string; kind: 'folder'; name: string; enabled: boolean; license?: string }

const SOURCES_KEY = 'slidomingo-icon-sources'
// the single-source keys this replaced — read once to migrate, never written
const LEGACY_MODE_KEY = 'slidomingo-icon-source'
const LEGACY_URL_KEY = 'slidomingo-icon-server-url'
const LEGACY_TOKEN_KEY = 'slidomingo-icon-server-token'
/** The legacy folder handle lived under this IndexedDB key; the migrated folder source keeps it as its id. */
const LEGACY_FOLDER_ID = 'dir'
export const DEFAULT_ICON_SERVER = 'http://localhost:5050'
const MAX_SOURCES = 20
/** Matches untrusted.ts LIMITS.provField, so a stored license is never cut on insert. */
export const MAX_LICENSE = 300

export const newIconSourceId = (): string => uid('src')

/** The host of a server URL, for a source that has no name of its own. */
export function hostOf(url: string): string {
  try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`).host || url } catch { return url }
}

/** What a source is called in lists and tooltips. */
export function iconSourceLabel(src: IconSource): string {
  if (src.name.trim()) return src.name.trim()
  return src.kind === 'server' ? (src.url ? hostOf(src.url) : t('Icon server')) : t('Local folder')
}

/** Strict read of stored JSON: unknown fields dropped, junk rows skipped. */
export function sanitizeIconSources(raw: unknown): IconSource[] {
  if (!Array.isArray(raw)) return []
  const out: IconSource[] = []
  const seen = new Set<string>()
  for (const r of raw as Array<Record<string, unknown>>) {
    if (out.length >= MAX_SOURCES || !r || typeof r !== 'object') continue
    const id = typeof r.id === 'string' && r.id && r.id.length <= 64 ? r.id : ''
    if (!id || seen.has(id)) continue
    const name = typeof r.name === 'string' ? r.name.slice(0, 60) : ''
    const enabled = r.enabled !== false
    const license = typeof r.license === 'string' ? r.license.trim().slice(0, MAX_LICENSE) : ''
    if (r.kind === 'server') {
      seen.add(id)
      out.push({ id, kind: 'server', name, enabled, url: typeof r.url === 'string' ? r.url.trim().slice(0, 500) : '', token: typeof r.token === 'string' ? r.token.trim() : '', ...(license ? { license } : {}) })
    } else if (r.kind === 'folder') {
      seen.add(id)
      out.push({ id, kind: 'folder', name, enabled, ...(license ? { license } : {}) })
    }
  }
  return out
}

/** Carries the one-server-or-one-folder settings over: same server, same
 *  token, same remembered folder; the other kind stays, switched off. */
function migratedSources(): IconSource[] {
  const folderMode = lsGet(LEGACY_MODE_KEY) === 'folder'
  const url = lsGet(LEGACY_URL_KEY) || ''
  const token = lsGet(LEGACY_TOKEN_KEY) || ''
  const out: IconSource[] = []
  if (!folderMode || url || token) out.push({ id: 'server', kind: 'server', name: '', enabled: !folderMode, url: url || DEFAULT_ICON_SERVER, token })
  if (folderMode) out.push({ id: LEGACY_FOLDER_ID, kind: 'folder', name: '', enabled: true })
  return out
}

export function iconSources(): IconSource[] {
  const stored = lsGet(SOURCES_KEY)
  if (stored !== null && stored !== undefined) {
    let list: IconSource[]
    try { list = sanitizeIconSources(JSON.parse(stored)) } catch { return [] }
    // written by a build that kept desktop tokens here: hand them to main
    if (iconDesktop() && list.some((s) => s.kind === 'server' && s.token)) {
      setIconSources(list)
      list = list.map((s) => (s.kind === 'server' ? { ...s, token: '' } : s))
    }
    return list
  }
  const list = migratedSources()
  setIconSources(list) // so a later edit of the old keys can never resurface
  return list
}

/** Returns whether it PERSISTED (false where site data is blocked). In the
 *  desktop app a token found in the list goes to main's encrypted store
 *  (unless one is stored there already) and is left out of what is saved. */
export function setIconSources(list: IconSource[]): boolean {
  const clean = sanitizeIconSources(list)
  const desktop = iconDesktop()
  if (!desktop) return lsSet(SOURCES_KEY, JSON.stringify(clean))
  const carried = clean.flatMap((s) => (s.kind === 'server' && s.token ? [{ id: s.id, url: s.url, token: s.token }] : []))
  if (carried.length) void desktop.adoptIconTokens(carried).catch(() => { /* stays where it was */ })
  // no `token` key at all: main stores the list as given (viewerprefs.ts)
  return lsSet(SOURCES_KEY, JSON.stringify(clean.map((s) => {
    if (s.kind !== 'server') return s
    const { token: _token, ...rest } = s
    return rest
  })))
}

/** Desktop: which server sources have a token stored for their current URL. */
export async function iconTokenStatus(list: IconSource[]): Promise<Record<string, boolean>> {
  const desktop = iconDesktop()
  if (!desktop) return {}
  try {
    return await desktop.iconTokenStatus(list.flatMap((s) => (s.kind === 'server' ? [{ id: s.id, url: s.url }] : [])))
  } catch { return {} }
}

/** A source a search can use right now: on, and a server needs its URL. */
export const iconSourceUsable = (src: IconSource): boolean => src.enabled && (src.kind === 'folder' || !!src.url)

// --- local-folder handle persistence (IndexedDB — FSA handles structured-clone) --
// one handle per folder SOURCE, keyed by the source's id

const HANDLE_DB = 'slidomingo-icon-folder'
const HANDLE_STORE = 'handle'

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return }
    const req = indexedDB.open(HANDLE_DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function saveIconFolderHandle(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openHandleDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite')
      tx.objectStore(HANDLE_STORE).put(handle, id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch { /* no IndexedDB (opaque origin, blocked site data) — re-pick next time */ }
}

export async function loadIconFolderHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly')
      const req = tx.objectStore(HANDLE_STORE).get(id)
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

export async function clearIconFolderHandle(id: string): Promise<void> {
  try {
    const db = await openHandleDb()
    const tx = db.transaction(HANDLE_STORE, 'readwrite')
    tx.objectStore(HANDLE_STORE).delete(id)
  } catch { /* nothing to clear */ }
}

/** User gesture required — call only from a click handler. Null = this
 *  browser can't pick a folder, or the person cancelled. */
export async function pickIconFolder(id: string): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as any).showDirectoryPicker
  if (typeof picker !== 'function') return null
  let handle: FileSystemDirectoryHandle
  try { handle = await picker.call(window) } catch (err) {
    if ((err as Error)?.name === 'AbortError') return null
    throw err
  }
  await saveIconFolderHandle(id, handle)
  return handle
}

/** Whether this browser can pick a folder at all. */
export const canPickIconFolder = (): boolean => typeof (window as any).showDirectoryPicker === 'function'

/** Also needs a user gesture on first grant / after the browser forgets it —
 *  call from the click handler that triggered the search, never eagerly. */
async function ensureFolderPermission(handle: FileSystemDirectoryHandle, ask = true): Promise<boolean> {
  const h = handle as any
  const opts = { mode: 'read' }
  if (typeof h.queryPermission !== 'function') return true // older FSA typings, assume granted
  if ((await h.queryPermission(opts)) === 'granted') return true
  if (!ask || typeof h.requestPermission !== 'function') return false
  return (await h.requestPermission(opts)) === 'granted'
}

// --- search result shape (shared between both sources) -----------------------

/** A Provenance from loosely-typed parts: non-strings and blanks dropped,
 *  each field cut to what untrusted.ts would keep. */
function makeProvenance(parts: Partial<Record<keyof Provenance, unknown>>): Provenance {
  const out: Provenance = {}
  for (const key of ['origin', 'url', 'author', 'license'] as const) {
    const v = parts[key]
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, key === 'url' ? 2000 : MAX_LICENSE)
  }
  return out
}

export interface IconResult {
  name: string
  /** The label of the source that found it (iconSourceLabel). */
  source: string
  description?: string
  category?: string
  ext: string
  /** Where it came from and the terms it comes with, stamped onto the
   *  element on insert (model.ts Provenance). */
  provenance: Provenance
  /** URL usable directly as an <img src> for the results grid. */
  preview(): Promise<string>
  /** Fetches the real content, ready to embed. */
  load(): Promise<{ kind: 'svg'; markup: string } | { kind: 'raster'; dataUrl: string }>
}

const ICON_EXTS = new Set(['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif'])

function extOf(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase()
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** blob: URLs handed to the results grid (folder files, authed server
 *  thumbnails) — revoked when the grid is rebuilt or the popover closes. */
const objectUrls: string[] = []

// --- source (a): icon server ---------------------------------------------------

/** Thrown when the desktop app's request (made by main) never got an answer. */
class UnreachableError extends Error {}

/** What to show for main's refusal: "can't reach" only when the network
 *  failed — a refusal (too large, too many redirects, …) says what it was. */
function unreachableMessage(err: UnreachableError, root: string): string {
  return err.message === 'unreachable' || err.message === 'timed out'
    ? t("can't reach {base} — is the server running and the URL right?", { base: root })
    : `${root}: ${err.message}`
}

/** One GET to a server source. In a browser: `netFetch` with the token in
 *  the header. In the desktop app: main makes the request and adds the
 *  token it keeps (the page never holds it); `authed` says whether it did. */
async function serverFetch(src: Extract<IconSource, { kind: 'server' }>, url: string): Promise<{ res: Response; authed: boolean }> {
  const desktop = iconDesktop()
  if (!desktop) {
    // through the offline chokepoint like every other request: an icon
    // server is the network, and offline mode promises none of it
    const res = await netFetch(url, src.token ? { headers: { Authorization: `Bearer ${src.token}` } } : {})
    return { res, authed: !!src.token }
  }
  if (offlineEnabled()) throw new OfflineError(url)
  const r = await desktop.iconFetch(src.id, url)
  if (!r.ok) {
    if (r.offline) throw new OfflineError(url)
    throw new UnreachableError(r.error)
  }
  const empty = r.status === 204 || r.status === 205 || r.status === 304
  const res = new Response(empty ? null : r.body, { status: r.status, headers: r.contentType ? { 'content-type': r.contentType } : {} })
  return { res, authed: r.authed }
}

async function searchServer(src: Extract<IconSource, { kind: 'server' }>, source: string, q: string): Promise<IconResult[]> {
  const root = src.url.replace(/\/+$/, '')
  const license = src.license
  let res: Response
  let authed: boolean
  try {
    ({ res, authed } = await serverFetch(src, `${root}/api/search?q=${encodeURIComponent(q)}&limit=60`))
  } catch (err) {
    if (err instanceof OfflineError) throw new Error(t('Offline mode is on — nothing leaves this computer.'))
    // desktop: main made the request, so CORS is not the reason
    if (err instanceof UnreachableError) throw new Error(unreachableMessage(err, root))
    // A browser `fetch` failure here is indistinguishable between "server is
    // down" and "server is up but sends no Access-Control-Allow-Origin
    // header" (CORS) — both throw the same generic TypeError. The latter is
    // the common case: the editor and an icon server normally run on
    // different origins/ports (e.g. localhost:5199 vs localhost:5050, or a
    // saved file:// deck vs a server on http://), and a plain Flask app sends
    // no CORS headers at all, so this WILL fail
    // cross-origin until the server adds `Access-Control-Allow-Origin` (or
    // is reverse-proxied onto the editor's own origin). Say so — a bare
    // "Failed to fetch" sends the user nowhere useful.
    throw new Error(t("can't reach {base} — if the server is running, it likely needs to send an Access-Control-Allow-Origin header (CORS) for a cross-origin browser fetch to succeed", { base: root }))
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(authed
      ? t('{base} rejected the API token (HTTP {status})', { base: root, status: String(res.status) })
      : t('{base} wants an API token — add one in Settings ▸ Icon library', { base: root }))
  }
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`)
  // A server behind a login answers a token-less request by redirecting to
  // its login PAGE — a 200 of HTML that fetch followed silently.
  if (!/json/i.test(res.headers.get('content-type') ?? '')) {
    throw new Error(t('{base} wants an API token — add one in Settings ▸ Icon library', { base: root }))
  }
  const data = await res.json()
  const results: any[] = Array.isArray(data?.results) ? data.results : []
  return results.slice(0, 60).map((r): IconResult => {
    const relPath = String(r.relative_path ?? '')
    const ext = extOf(relPath)
    const fileUrl = `${root}/files/${relPath.split('/').map(encodeURIComponent).join('/')}`
    return {
      source,
      name: String(r.display_name ?? (relPath || 'icon')),
      description: typeof r.description === 'string' ? r.description : undefined,
      category: typeof r.category === 'string' ? r.category : undefined,
      ext,
      // a server MAY say who made an icon and under what terms; its word for
      // one icon beats what the person declared for the whole source
      provenance: makeProvenance({ origin: source, url: fileUrl, author: r.author, license: r.license || license }),
      preview: async () => {
        if (!authed) {
          // an <img src> load isn't subject to CORS, unlike fetch() below —
          // but it is still the network, so offline mode (flipped since the
          // search) refuses it like netFetch would
          if (remoteSrcBlocked(fileUrl)) throw new OfflineError(fileUrl)
          return fileUrl
        }
        // An <img> can't carry the Authorization header: fetch the bytes
        // and hand the grid a blob: URL instead (revoked with the rest).
        const { res: thumb } = await serverFetch(src, thumbUrl(root, r.png_url) ?? fileUrl)
        if (!thumb.ok) throw new Error(`preview failed: HTTP ${thumb.status}`)
        const url = URL.createObjectURL(await thumb.blob())
        objectUrls.push(url)
        return url
      },
      load: async () => {
        let bytes: Response
        try {
          ;({ res: bytes } = await serverFetch(src, fileUrl))
        } catch (err) {
          if (err instanceof OfflineError) throw new Error(t('Offline mode is on — nothing leaves this computer.'))
          if (err instanceof UnreachableError) throw new Error(unreachableMessage(err, root))
          throw new Error(t("can't fetch that icon's bytes — likely the same cross-origin/CORS issue as search (see the server's Access-Control-Allow-Origin header)"))
        }
        if (!bytes.ok) throw new Error(`fetch failed: HTTP ${bytes.status}`)
        if (ext === 'svg') return { kind: 'svg', markup: await bytes.text() }
        return { kind: 'raster', dataUrl: await blobToDataUrl(await bytes.blob()) }
      },
    }
  })
}

/** The result's server-relative `png_url`, absolutized against `root` and
 *  shrunk to thumbnail size; undefined when the server sends none — or
 *  points somewhere outside itself, where the token must not go. */
function thumbUrl(root: string, pngUrl: unknown): string | undefined {
  if (typeof pngUrl !== 'string' || !pngUrl) return undefined
  try {
    // root-relative like /files/ above, so a base with a path prefix keeps it
    const url = new URL(/^https?:/i.test(pngUrl) ? pngUrl : root + (pngUrl.startsWith('/') ? '' : '/') + pngUrl)
    const base = new URL(root)
    const path = base.pathname.replace(/\/+$/, '')
    if (url.origin !== base.origin || (path && url.pathname !== path && !url.pathname.startsWith(path + '/'))) return undefined
    if (url.searchParams.has('size')) url.searchParams.set('size', '128')
    return url.href
  } catch { return undefined }
}

// --- source (b): local folder ---------------------------------------------------

interface FolderEntry { name: string; path: string; handle: FileSystemFileHandle; meta?: ManifestEntry }

/** An icons.json bigger than this is not a manifest anyone wrote by hand or export. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

const folderEntryCache = new WeakMap<FileSystemDirectoryHandle, FolderEntry[]>()

async function walkFolder(
  dir: FileSystemDirectoryHandle, manifests: Array<{ prefix: string; handle: FileSystemFileHandle }>, prefix = '', depth = 0,
): Promise<FolderEntry[]> {
  if (depth > 4) return [] // arbitrary depth cap — a runaway symlink loop must not hang the search
  const out: FolderEntry[] = []
  for await (const entry of (dir as any).values()) {
    if (out.length >= 4000) break // cap so a huge tree still returns promptly
    if (entry.kind === 'file') {
      if (ICON_EXTS.has(extOf(entry.name))) out.push({ name: entry.name, path: prefix + entry.name, handle: entry })
      else if (entry.name.toLowerCase() === ICON_MANIFEST_FILE) manifests.push({ prefix, handle: entry })
    } else if (entry.kind === 'directory') {
      out.push(...await walkFolder(entry, manifests, `${prefix}${entry.name}/`, depth + 1))
    }
  }
  return out
}

async function folderEntries(dir: FileSystemDirectoryHandle): Promise<FolderEntry[]> {
  const cached = folderEntryCache.get(dir)
  if (cached) return cached
  const manifests: Array<{ prefix: string; handle: FileSystemFileHandle }> = []
  const entries = await walkFolder(dir, manifests)
  for (const m of manifests) {
    try {
      const file = await m.handle.getFile()
      if (file.size > MAX_MANIFEST_BYTES) continue
      const meta = parseIconManifest(await file.text())
      for (const e of entries) {
        if (!e.path.startsWith(m.prefix)) continue
        const hit = meta.get(e.path.slice(m.prefix.length).toLowerCase())
        if (hit) e.meta = hit
      }
    } catch { /* an unreadable manifest is no manifest */ }
  }
  folderEntryCache.set(dir, entries)
  return entries
}

async function searchFolder(dir: FileSystemDirectoryHandle, source: string, license: string | undefined, q: string): Promise<IconResult[]> {
  const entries = await folderEntries(dir)
  const query = q.trim().toLowerCase()
  const filtered = query ? entries.filter((e) => manifestMatches(query, e.name, e.meta)) : entries
  return filtered.slice(0, 60).map((e): IconResult => {
    const ext = extOf(e.name)
    return {
      source,
      name: e.meta?.name ?? e.name,
      ...(e.meta?.keywords.length ? { description: e.meta.keywords.join(', ') } : {}),
      ext,
      // the manifest's own licence wins: it travels with those files
      provenance: makeProvenance({ origin: source, license: e.meta?.license ?? license, author: e.meta?.author }),
      preview: async () => {
        const file = await e.handle.getFile()
        const url = URL.createObjectURL(file)
        objectUrls.push(url)
        return url
      },
      load: async () => {
        const file = await e.handle.getFile()
        if (ext === 'svg') return { kind: 'svg', markup: await file.text() }
        return { kind: 'raster', dataUrl: await blobToDataUrl(file) }
      },
    }
  })
}

function revokeObjectUrls() {
  for (const u of objectUrls.splice(0)) URL.revokeObjectURL(u)
}

// --- insertion -----------------------------------------------------------------

/** Text-asset dedup, mirroring model.ts's internAsset — but for raw SVG
 *  markup (SvgElement.asset is a bare key into doc.assets, not `asset:key`
 *  like image/media src). Kept local: only this feature interns bare-key
 *  text assets today. */
function internSvgMarkup(doc: SlidomingoDoc, markup: string): string {
  const assets = (doc.assets ??= {})
  for (const k in assets) if (assets[k] === markup) return k
  const key = uid('a')
  assets[key] = markup
  return key
}

/** Inserts a picked icon at the slide's center, one undo step. `insertRaster`
 *  is the caller's `canvas.insert` (it already handles image asset interning
 *  and selection) — svg goes through its own commit since canvas.insert has
 *  no svg-asset-interning branch. */
export async function insertIconResult(
  store: Store,
  insertRaster: (el: SlideElement) => void,
  icon: IconResult,
): Promise<void> {
  const picked = await icon.load()
  const size = store.doc.size
  const w = 120, h = 120
  const x = Math.round(size.width / 2 - w / 2)
  const y = Math.round(size.height / 2 - h / 2)
  if (picked.kind === 'svg') {
    const el: SvgElement = { id: uid('svg'), type: 'svg', x, y, w, h, rotation: 0, opacity: 1 }
    if (Object.keys(icon.provenance).length) el.provenance = { ...icon.provenance }
    store.commit(() => {
      el.asset = internSvgMarkup(store.doc, picked.markup)
      store.slide.elements.push(el)
    })
    store.select([el.id])
  } else {
    const el: ImageElement = defaultImage(picked.dataUrl, { x, y, w, h })
    if (Object.keys(icon.provenance).length) el.provenance = { ...icon.provenance }
    insertRaster(el)
  }
}

// --- searching sources -------------------------------------------------------------

/** A folder whose permission lapsed: only a user gesture can ask again. */
class FolderAccessError extends Error {
  constructor(readonly handle: FileSystemDirectoryHandle) { super('folder access') }
}

export interface SourceProblem {
  source: IconSource
  message: string
  /** For a folder that needs its permission back: run from a click. */
  grant?: () => Promise<boolean>
}

async function searchOne(src: IconSource, q: string, ask = true): Promise<IconResult[]> {
  const label = iconSourceLabel(src)
  if (src.kind === 'server') return searchServer(src, label, q)
  const handle = await loadIconFolderHandle(src.id)
  if (!handle) throw new Error(t('No folder chosen yet — pick one in Settings ▸ Icon library.'))
  if (!(await ensureFolderPermission(handle, ask))) throw new FolderAccessError(handle)
  return searchFolder(handle, label, src.license, q)
}

/** Searches every given source at once; one that fails is reported in
 *  `problems` and never hides what the others found. Results keep the
 *  sources' order. */
export async function searchSources(sources: IconSource[], q: string, opts: { ask?: boolean } = {}): Promise<{ results: IconResult[]; problems: SourceProblem[] }> {
  const settled = await Promise.allSettled(sources.map((s) => searchOne(s, q, opts.ask !== false)))
  const results: IconResult[] = []
  const problems: SourceProblem[] = []
  settled.forEach((r, i) => {
    const source = sources[i]
    if (r.status === 'fulfilled') { results.push(...r.value); return }
    const err = r.reason
    if (err instanceof FolderAccessError) {
      problems.push({ source, message: t('This folder needs permission again — '), grant: () => ensureFolderPermission(err.handle) })
    } else {
      problems.push({ source, message: String((err as Error)?.message ?? err) })
    }
  })
  return { results, problems }
}

/** The popover's search, for an agent (the `icons` tool, editor/agentops.ts):
 *  every switched-on source, same settings — but it never asks for anything.
 *  There is no click to hang a folder permission prompt on, so a folder the
 *  browser has forgotten is a note the model passes on to the user. Throws
 *  (with a message meant for the model) only when nothing could be searched. */
export async function searchIconLibrary(q: string): Promise<{ icons: IconResult[]; notes: string[] }> {
  const sources = iconSources().filter(iconSourceUsable)
  if (!sources.length) throw new Error('No icon source is set up (the user adds one in Settings ▸ Icon library).')
  const { results, problems } = await searchSources(sources, q, { ask: false })
  const notes = problems.map((p) => `${iconSourceLabel(p.source)}: ${p.grant ? 'this folder needs the user\'s permission again (they open Insert ▸ Icons once and grant access)' : p.message}`)
  if (problems.length === sources.length) throw new Error(notes.join(' / '))
  return { icons: results, notes }
}

// --- connection test (Settings ▸ Icon library) -----------------------------------

/** What a source card's "Test" button runs: the SAME search and load code the
 *  popover uses, against that source — so a green result means an icon search
 *  and insert will work, a red one carries the reason. */
export async function testIconSource(src: IconSource): Promise<{ ok: boolean; message: string }> {
  try {
    if (src.kind === 'server' && !src.url) return { ok: false, message: t('Enter the server URL first.') }
    let results: IconResult[]
    try {
      results = await searchOne(src, '')
    } catch (err) {
      if (!(err instanceof FolderAccessError)) throw err
      // the Test click IS the gesture the permission prompt needs
      if (!(await ensureFolderPermission(err.handle))) return { ok: false, message: t('Access to the folder was not granted.') }
      results = await searchOne(src, '')
    }
    if (!results.length) return { ok: false, message: src.kind === 'folder' ? t('No icons found.') : t('Connected, but the server has no icons.') }
    try {
      // the thumbnail path (blob: with a token) and the file itself (what an insert fetches)
      const preview = await results[0].preview()
      if (preview.startsWith('blob:')) URL.revokeObjectURL(preview)
      await results[0].load()
    } catch (err) {
      return { ok: false, message: t('The search worked, but loading the first icon failed: {m}', { m: String((err as Error)?.message ?? err) }) }
    }
    // the search shows at most 60, so a full page means "that many or more"
    return { ok: true, message: t('Works — the search returned {count} icons', { count: results.length >= 60 ? '60+' : String(results.length) }) }
  } catch (err) {
    return { ok: false, message: t("Couldn't search: {m}", { m: String((err as Error)?.message ?? err) }) }
  }
}

// --- popover UI ------------------------------------------------------------------

let searchToken = 0

/** Point-anchored popover, same pattern as editor/comments.ts's thread
 *  popover: position:fixed, viewport-clamped, deferred outside-click
 *  dismiss. Debounced search-as-you-type over every switched-on source,
 *  thumbnail grid, click-to-insert (stays open so several icons can be
 *  dropped in a row — Esc or an outside click closes it). With more than one
 *  source a picker narrows the search to one of them. */
export function openIconSearchPopover(store: Store, anchor: HTMLElement, insertRaster: (el: SlideElement) => void): void {
  document.querySelector('.ed-icon-pop')?.remove()
  revokeObjectUrls()

  const sources = iconSources().filter(iconSourceUsable)
  const pop = document.createElement('div')
  pop.className = 'ed-icon-pop'

  const head = document.createElement('div')
  head.className = 'ed-icon-pop-head'
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'ed-icon-search'
  input.placeholder = t('Search icons…')
  head.appendChild(input)
  let only = ''
  if (sources.length > 1) {
    const pick = document.createElement('select')
    pick.className = 'ed-icon-source'
    pick.title = t('Which icon source to search')
    pick.add(new Option(t('All sources'), ''))
    for (const s of sources) pick.add(new Option(iconSourceLabel(s), s.id))
    pick.addEventListener('change', () => { only = pick.value; void runSearch(input.value) })
    head.appendChild(pick)
  }
  pop.appendChild(head)

  const status = document.createElement('div')
  status.className = 'ed-icon-status'
  pop.appendChild(status)

  const grid = document.createElement('div')
  grid.className = 'ed-icon-grid'
  pop.appendChild(grid)

  const hint = document.createElement('div')
  hint.className = 'ed-icon-hint'
  hint.textContent = sources.length
    ? t('Searching {names} — manage the sources in Settings ▸ Icon library', { names: sources.map(iconSourceLabel).join(', ') })
    : ''
  pop.appendChild(hint)

  async function runSearch(q: string) {
    const token = ++searchToken
    grid.innerHTML = ''
    revokeObjectUrls()
    if (!sources.length) { status.textContent = t('No icon source is switched on — turn one on in Settings ▸ Icon library.'); return }
    status.textContent = t('Searching…')
    const { results, problems } = await searchSources(only ? sources.filter((s) => s.id === only) : sources, q)
    if (token !== searchToken) return
    // one line per source that failed, ahead of what the others found
    status.replaceChildren()
    const lines: Array<string | HTMLElement> = []
    for (const p of problems) {
      const line = document.createElement('div')
      line.className = 'ed-icon-problem'
      line.textContent = (sources.length > 1 ? `${iconSourceLabel(p.source)}: ` : '') + p.message
      if (p.grant) {
        const grantBtn = document.createElement('button')
        grantBtn.className = 'ed-btn'
        grantBtn.textContent = t('Grant access')
        grantBtn.addEventListener('click', async () => { if (await p.grant!()) void runSearch(input.value) })
        line.appendChild(grantBtn)
      }
      lines.push(line)
    }
    if (!results.length && !problems.length) status.textContent = t('No icons found.')
    else for (const l of lines) status.append(l)
    const many = sources.length > 1
    for (const icon of results) {
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.className = 'ed-icon-cell'
      const title = icon.description ? `${icon.name} — ${icon.description}` : icon.name
      cell.title = many ? `${title} · ${icon.source}` : title
      const img = document.createElement('img')
      img.alt = icon.name
      icon.preview().then((url) => { img.src = url }).catch(() => { cell.remove() })
      const label = document.createElement('span')
      label.textContent = icon.name.replace(/\.(svg|png|jpe?g|webp|gif)$/i, '')
      cell.append(img, label)
      cell.addEventListener('click', async () => {
        cell.disabled = true
        try {
          await insertIconResult(store, insertRaster, icon)
        } catch (err) {
          status.textContent = t("Couldn't insert that icon: {m}", { m: String((err as Error)?.message ?? err) })
        } finally {
          cell.disabled = false
        }
      })
      grid.appendChild(cell)
    }
  }

  let debounce: ReturnType<typeof setTimeout> | undefined
  input.addEventListener('input', () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => runSearch(input.value), 250)
  })

  // Append BEFORE positioning — positionFloating measures the popover's real
  // rendered box. The old code guessed a constant height (360px) and clamped
  // only the CEILING of the vertical offset — on a short viewport that could
  // compute a `top` above the trigger's own bottom edge, rendering the
  // popover overlapping/above the button that opened it.
  document.body.appendChild(pop)
  positionFloating(anchor, pop, { placement: 'bottom-start' })
  input.focus()
  void runSearch('')

  const close = () => {
    pop.remove()
    revokeObjectUrls()
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('keydown', onKey, true)
  }
  const onOutside = (ev: PointerEvent) => {
    if (!pop.contains(ev.target as Node) && ev.target !== anchor) close()
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); close() }
  }
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true))
  document.addEventListener('keydown', onKey, true)
}
