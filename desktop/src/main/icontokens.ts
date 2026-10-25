// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon-server API tokens, stored like the AI keys (aiprofilesStore.ts):
// encrypted with safeStorage in userData/icon-tokens.bin, write-only — a
// token never travels back to a renderer. Requests to an icon server are
// made HERE (`slidomingo:icon-fetch`), so main adds the Authorization
// header itself; as a side effect a server needs no CORS headers for the
// desktop app. The source LIST is an app-wide viewer preference
// (viewerprefs.ts, `slidomingo-icon-sources`) and is kept token-free by
// `sanitizeIconSourcesPref`. Pure helpers: icontokenscore.ts.
//
// A hidden instance (background.ts) has a userData of its own, so it reads
// the tokens from the USER's icon-tokens.bin instead, read-only, at every
// request (a token typed in the visible app later still applies). It never
// writes that file. safeStorage decrypts there because its key is not tied to
// userData on macOS: it is the Keychain item named after the app ("BeeSlides
// Safe Storage", "BeeSlides (dev) Safe Storage" for an unpackaged run), and
// the hidden instance is the same binary and entry as the visible app. The
// item is chosen early in startup, so the name must be set at the top of the
// entry, as index.ts does: a later app.setName picks another item
// (desktop/scripts/e2e-background.mjs). Where the key does live in userData (Windows keeps it in
// "Local State"), decryption fails and the request goes out without a token:
// the server's 401 becomes the old "wants an API token".
import { app, safeStorage } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './fsutil.ts'
import { isBackground, userDataFile } from './background.ts'
import { pruneIconFolders } from './iconfolders.ts'
import { handleFrom } from './ipcguard.ts'
import { readSettings } from './settings.ts'
import { isSourceId, serverRoot, sourceUrl, stripSourceTokens, underRoot, type CarriedToken } from './icontokenscore.ts'

export const ICON_SOURCES_KEY = 'slidomingo-icon-sources'

interface StoredToken { root: string; enc: string }

const TOKENS_FILE = 'icon-tokens.bin'
/** Where this instance writes its tokens (and reads them back). */
const tokensPath = (): string => join(app.getPath('userData'), TOKENS_FILE)
/** Where a request looks its token up: in a hidden instance, the user's own
 *  file (read-only); everywhere else, this instance's. */
const lookupPath = (): string => (isBackground() ? userDataFile(TOKENS_FILE) : tokensPath())

function readTokenFile(path = tokensPath()): Record<string, StoredToken> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, StoredToken> = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const t = v as Partial<StoredToken> | null
      if (isSourceId(id) && t && typeof t.root === 'string' && typeof t.enc === 'string') out[id] = { root: t.root, enc: t.enc }
    }
    return out
  } catch { return {} }
}

function writeTokenFile(map: Record<string, StoredToken>): void {
  try { writeFileAtomic(tokensPath(), JSON.stringify(map)) } catch { /* best effort */ }
}

/** The token for source `id`, only when it was stored for `root`. */
function tokenFor(id: string, root: string): string | null {
  const t = readTokenFile(lookupPath())[id]
  if (!t || t.root !== root || !safeStorage.isEncryptionAvailable()) return null
  try { return safeStorage.decryptString(Buffer.from(t.enc, 'base64')) } catch { return null }
}

function setToken(id: unknown, url: unknown, token: unknown): { ok: boolean; error?: string } {
  if (!isSourceId(id)) return { ok: false, error: 'bad source id' }
  const map = readTokenFile()
  if (token === null || token === '') { delete map[id]; writeTokenFile(map); return { ok: true } }
  if (typeof token !== 'string' || token.length > 4000) return { ok: false, error: 'bad token' }
  const root = serverRoot(url)
  if (!root) return { ok: false, error: 'Enter the server URL first.' }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Encrypted storage is not available on this system.' }
  map[id] = { root, enc: safeStorage.encryptString(token.trim()).toString('base64') }
  writeTokenFile(map)
  return { ok: true }
}

/** Tokens an older build kept in the list: stored unless that source
 *  already has one here (the encrypted copy is the newer word). */
function adoptTokens(tokens: CarriedToken[]): void {
  if (!tokens.length || !safeStorage.isEncryptionAvailable()) return
  const map = readTokenFile()
  let changed = false
  for (const t of tokens) {
    const root = serverRoot(t.url)
    if (!root || map[t.id] || t.token.length > 4000) continue
    map[t.id] = { root, enc: safeStorage.encryptString(t.token).toString('base64') }
    changed = true
  }
  if (changed) writeTokenFile(map)
}

/** What viewerprefs.ts stores for `slidomingo-icon-sources`: the list with
 *  every inline token moved into the encrypted store (and any folder path
 *  dropped: main keeps those, iconfolders.ts), and the tokens and folders of
 *  sources that are gone dropped too. Only this instance's own files are
 *  written — never the user's, from a hidden instance. */
export function sanitizeIconSourcesPref(value: string): string {
  const { value: clean, tokens, ids } = stripSourceTokens(value)
  adoptTokens(tokens)
  if (ids) {
    pruneIconFolders(ids)
    const map = readTokenFile()
    let changed = false
    for (const id of Object.keys(map)) if (!ids.includes(id)) { delete map[id]; changed = true }
    if (changed) writeTokenFile(map)
  }
  return clean
}

const MAX_BYTES = 25 * 1024 * 1024
const TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 5

type FetchReply =
  | { ok: true; status: number; contentType: string; body: Uint8Array; authed: boolean }
  | { ok: false; error: string; offline?: boolean }

async function readCapped(res: Response): Promise<Uint8Array | null> {
  const len = Number(res.headers.get('content-length'))
  if (len > MAX_BYTES) return null
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) { try { await reader.cancel() } catch { /* */ } return null }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

/** One GET to an icon server on behalf of the renderer. Only URLs under the
 *  source's configured root; the token rides only on hops under the root
 *  it was stored for (redirects are followed by hand to keep it that way). */
async function iconFetch(id: unknown, url: unknown): Promise<FetchReply> {
  if (!isSourceId(id) || typeof url !== 'string') return { ok: false, error: 'bad request' }
  const prefs = readSettings().viewerPrefs ?? {}
  if (prefs['slidomingo-offline'] === 'on') return { ok: false, offline: true, error: 'offline' }
  const root = serverRoot(sourceUrl(prefs[ICON_SOURCES_KEY], id))
  if (!root || !underRoot(url, root)) return { ok: false, error: 'not an address of this icon server' }
  const token = tokenFor(id, root)
  let next = url
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = {}
      if (token && underRoot(next, root)) headers.Authorization = `Bearer ${token}`
      const res = await fetch(next, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        try { await res.body?.cancel() } catch { /* */ }
        const to = new URL(location, next)
        if (to.protocol !== 'http:' && to.protocol !== 'https:') return { ok: false, error: 'redirected to a non-web address' }
        next = to.href
        continue
      }
      const body = await readCapped(res)
      if (!body) return { ok: false, error: 'the response is too large' }
      return { ok: true, status: res.status, contentType: res.headers.get('content-type') ?? '', body, authed: !!token }
    }
    return { ok: false, error: 'too many redirects' }
  } catch (err) {
    const e = err as Error
    return { ok: false, error: e?.name === 'TimeoutError' ? 'timed out' : 'unreachable' }
  }
}

/** Which of the given sources have a token stored for their CURRENT URL. */
function tokenStatus(list: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!Array.isArray(list)) return out
  const map = readTokenFile(lookupPath())
  for (const row of list.slice(0, 50)) {
    if (!row || typeof row !== 'object') continue
    const { id, url } = row as { id?: unknown; url?: unknown }
    if (!isSourceId(id)) continue
    const root = serverRoot(url)
    out[id] = !!root && map[id]?.root === root
  }
  return out
}

export function registerIconTokenIpc(): void {
  handleFrom('app-shell', 'slidomingo:icon-token-set', (_ev, id: unknown, url: unknown, token: unknown) => setToken(id, url, token))
  handleFrom('app-shell', 'slidomingo:icon-token-status', (_ev, list: unknown) => tokenStatus(list))
  handleFrom('app-shell', 'slidomingo:icon-tokens-adopt', (_ev, list: unknown) => {
    if (!Array.isArray(list)) return false
    adoptTokens(list.filter((t): t is CarriedToken =>
      !!t && isSourceId(t.id) && typeof t.url === 'string' && typeof t.token === 'string' && !!t.token.trim()).map((t) => ({ ...t, token: t.token.trim() })))
    return true
  })
  handleFrom('app-shell', 'slidomingo:icon-fetch', (_ev, id: unknown, url: unknown) => iconFetch(id, url))
}
