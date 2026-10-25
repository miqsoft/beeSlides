// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon-server tokens, the Electron-free half (icontokens.ts is the rest):
// what a token is bound to, and how the stored icon-source list is kept
// free of them — and of folder paths, which main keeps apart
// (iconfolders.ts). Pure, so scripts/test-icon-tokens.ts can import it.
//
// A token is BOUND TO THE SERVER URL it was typed for (its "root": origin +
// path, no trailing slash). Main attaches it only to requests under that
// root, so changing a source's URL — in Settings or by anything else that
// can write the list — can never send the token somewhere new; the person
// types it again for the new server.

/** The root a server URL's requests live under, or null when it is not an
 *  http(s) URL. Matches how the renderer builds request URLs
 *  (`base.replace(/\/+$/, '') + '/api/search'`). */
export function serverRoot(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null
  let u: URL
  try { u = new URL(url.trim()) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  return u.origin + u.pathname.replace(/\/+$/, '')
}

/** Whether `url` is the root itself or a path below it — same origin, and
 *  the path continues at a segment boundary (`/icons` never matches
 *  `/icons-evil`). Dot segments are resolved by the URL parser first. */
export function underRoot(url: string, root: string): boolean {
  let u: URL, r: URL
  try { u = new URL(url); r = new URL(root) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  if (u.origin !== r.origin) return false
  const base = r.pathname.replace(/\/+$/, '')
  return !base || u.pathname === base || u.pathname.startsWith(base + '/')
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const isSourceId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id)

export interface CarriedToken { id: string; url: string; token: string }

/** Splits a stored `slidomingo-icon-sources` value into the list without any
 *  token and the tokens it carried (an older build kept them inline). A
 *  `path` is dropped as well: a folder's location on disk is main's alone
 *  (iconfolders.ts) and never sits in a list a page can read.
 *  Anything that is not a JSON array passes through unchanged. */
export function stripSourceTokens(value: string): { value: string; tokens: CarriedToken[]; ids: string[] | null } {
  let list: unknown
  try { list = JSON.parse(value) } catch { return { value, tokens: [], ids: null } }
  if (!Array.isArray(list)) return { value, tokens: [], ids: null }
  const tokens: CarriedToken[] = []
  const ids: string[] = []
  let changed = false
  const out = list.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row
    const r = row as Record<string, unknown>
    if (typeof r.id === 'string') ids.push(r.id)
    if (!('token' in r) && !('path' in r)) return r
    changed = true
    const { token, path: _path, ...rest } = r
    if (typeof token === 'string' && token.trim() && isSourceId(r.id) && typeof r.url === 'string') {
      tokens.push({ id: r.id, url: r.url, token: token.trim() })
    }
    return rest
  })
  return { value: changed ? JSON.stringify(out) : value, tokens, ids }
}

/** The server URL of source `id` in a stored list, or null. */
export function sourceUrl(value: string | undefined, id: string): string | null {
  if (!value) return null
  try {
    const list = JSON.parse(value)
    if (!Array.isArray(list)) return null
    const row = list.find((r) => r && typeof r === 'object' && r.id === id && r.kind === 'server')
    return row && typeof row.url === 'string' ? row.url : null
  } catch { return null }
}
