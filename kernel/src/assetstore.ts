// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The asset store: every embedded byte in a saved file, written ONCE.
//
// A plaintext file used to carry each picture twice or more: base64 inside
// `#slidomingo-doc`, and again (once per use) in the no-JS static layer. A
// 22.8 KB document structure travelled with 13.7 MB of repeated bytes. Now the
// bytes live in one place in the file, and the JSON refers to them:
//
//   #slidomingo-doc         "src": "slidomingo-store:sha256-0123456789abcdef"
//   #slidomingo-assets      /*sha256-0123…*/.sa-0123…{content:url("data:…")}
//                           /*sha256-…*/@font-face{…src:url("data:font/…")…}
//   #slidomingo-static      <div class="sa-0123…" role="img" …>   (uses)
//                           <video data-slidomingo-store="sha256-…" src="data:…">
//
// The store is a <style>, so the static layer draws straight from it with no
// script at all, and the file stays self-contained: nothing is fetched, the
// splice contract is unchanged, and a file that has no store (every file
// written before this, and every encrypted one) opens exactly as it did.
// A file that uses refs says so in `requires: ['asset-store']` (the reader
// gate, doc.ts), so a build that cannot resolve them opens it read-only
// rather than saving the refs away.
//
// PURE STRINGS, no DOM: the desktop main process and node scripts resolve a
// file with the same code the renderer uses.

/** The `requires` name a file with store refs declares. */
export const ASSET_STORE_FEATURE = 'asset-store'
/** What a doc string holding a ref starts with. */
export const STORE_REF_PREFIX = 'slidomingo-store:'
/** The store element's id (a <style> directly after #slidomingo-doc). */
export const STORE_ID = 'slidomingo-assets'
export const STORE_ATTR = 'data-slidomingo-assets'
/** On a static-layer <video>/<audio> whose `src` carries the bytes of an id. */
export const MEDIA_SRC_ATTR = 'data-slidomingo-store'
/** On a static-layer <video> whose `poster` carries the bytes of an id. */
export const MEDIA_POSTER_ATTR = 'data-slidomingo-poster'

// --- SHA-256 (synchronous: save is synchronous) -----------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** SHA-256 of `bytes`, as lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  const len = bytes.length
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[len] = 0x80
  const bits = len * 8
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
  view.setUint32(padded.length - 4, bits >>> 0)
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const W = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2]
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h
  }
  let out = ''
  for (const v of H) out += v.toString(16).padStart(8, '0')
  return out
}

// Memoized by the string itself: autosave re-saves the same megabytes every
// few seconds. `pruneIdMemo` keeps it to what the last save still used.
const idMemo = new Map<string, string>()

/**
 * The store id of a `data:` URI: `sha256-` + the first 16 hex digits of the
 * SHA-256 of its UTF-8 text. Content-addressed, so the same bytes get the
 * same id in every file and every session — which is what lets a light JSON
 * copy be resolved against any document that holds the picture.
 */
export function assetId(uri: string): string {
  const hit = idMemo.get(uri)
  if (hit) return hit
  const id = 'sha256-' + sha256Hex(new TextEncoder().encode(uri)).slice(0, 16)
  idMemo.set(uri, id)
  return id
}

/** Forget memoized ids for every URI not in `keep`. */
export function pruneIdMemo(keep: Set<string>): void {
  for (const uri of idMemo.keys()) if (!keep.has(uri)) idMemo.delete(uri)
}

export const refFor = (id: string): string => STORE_REF_PREFIX + id
export const isStoreRef = (v: unknown): boolean => typeof v === 'string' && v.startsWith(STORE_REF_PREFIX)
const ID_RE = /^sha256-[0-9a-f]{16}$/
export const isStoreId = (v: string): boolean => ID_RE.test(v)
/** The CSS class that draws an id's picture: `.sa-<16 hex>`. */
export const storeClass = (id: string): string => 'sa-' + id.slice(7)

// --- CSS strings ------------------------------------------------------------

/**
 * A `data:` URI as the body of a double-quoted CSS string. The store's text
 * may hold no `<` (kernel/src/save.ts refuses a store that does), which a raw
 * `data:image/svg+xml,<svg…` would; CSS hex escapes decode back to the
 * identical URI, so the picture's bytes are unchanged.
 */
export function cssString(uri: string): string {
  return uri
    .replace(/\\/g, '\\5c ')
    .replace(/"/g, '\\22 ')
    .replace(/</g, '\\3c ')
    .replace(/\r/g, '\\d ')
    .replace(/\n/g, '\\a ')
}

/** The inverse of cssString — and of any CSS escape: `\` + 1–6 hex digits +
 *  one optional whitespace, or `\` + any other character. */
export function cssUnstring(s: string): string {
  if (!s.includes('\\')) return s
  return s.replace(/\\([0-9a-fA-F]{1,6})(\r\n|[ \t\n\r\f])?|\\([\s\S])/g, (_m, hex: string | undefined, _ws, ch: string | undefined) => {
    if (hex !== undefined) {
      const cp = parseInt(hex, 16)
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp)
    }
    return ch === '\n' ? '' : ch!
  })
}

/** An image's store rule. */
export const imageRule = (id: string, uri: string): string =>
  `/*${id}*/.${storeClass(id)}{content:url("${cssString(uri)}")}`

/** A font's store rule: the @font-face the static layer and every no-JS
 *  reader use, and the store entry for its bytes. */
export function fontRule(id: string, uri: string, f: { family: string; weight?: string; style?: string }): string {
  // src FIRST: parseStoreCss finds the bytes without reading past the
  // family name, which is author data
  return `/*${id}*/@font-face{src:url("${cssString(uri)}");` +
    `font-family:"${cssString(f.family).replace(/\{/g, '\\7b ').replace(/\}/g, '\\7d ')}";font-weight:${cssIdent(f.weight ?? 'normal')};` +
    `font-style:${cssIdent(f.style ?? 'normal')};font-display:swap}`
}
// weight/style are author data; nothing but a plain token reaches the sheet
const cssIdent = (v: string): string => (/^[\w .-]{1,40}$/.test(v) ? v : 'normal')

// --- reading a store --------------------------------------------------------

const RULE_RE = /\/\*(sha256-[0-9a-f]{16})\*\/(?:\.sa-[0-9a-f]{16}\{content:url\("((?:[^"\\]|\\[\s\S])*)"\)\}|@font-face\{src:url\("((?:[^"\\]|\\[\s\S])*)"\))/g

/** id → data: URI, from the store <style>'s text. First entry for an id wins. */
export function parseStoreCss(css: string, into = new Map<string, string>()): Map<string, string> {
  for (const m of css.matchAll(RULE_RE)) {
    if (!into.has(m[1])) into.set(m[1], cssUnstring(m[2] ?? m[3] ?? ''))
  }
  return into
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
/** Decode the character references an HTML serializer writes into an
 *  attribute value (DOM `outerHTML` uses &amp; &quot; &nbsp; &lt; &gt;). */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return ENTITIES[e] ?? m
  })
}

const attrOf = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, 'i'))
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : null
}

/**
 * id → data: URI for everything a saved FILE's text stores: the store
 * <style>, plus the static layer's media elements that carry their own
 * bytes. Regex over the serialized HTML (the desktop main process and node
 * have no DOM) — the kernel is the only writer, and a DOM serializer always
 * writes these exact shapes.
 */
export function parseStoreHtml(html: string): Map<string, string> {
  const store = new Map<string, string>()
  const style = html.match(/<style\b[^>]*\bid="slidomingo-assets"[^>]*>([\s\S]*?)<\/style>/i)
  if (style) parseStoreCss(style[1], store)
  for (const m of html.matchAll(/<(?:video|audio)\b[^>]*\sdata-slidomingo-(?:store|poster)="sha256-[0-9a-f]{16}"[^>]*>/gi)) {
    const tag = m[0]
    const srcId = attrOf(tag, MEDIA_SRC_ATTR)
    const posterId = attrOf(tag, MEDIA_POSTER_ATTR)
    const src = attrOf(tag, 'src')
    const poster = attrOf(tag, 'poster')
    if (srcId && src && !store.has(srcId)) store.set(srcId, src)
    if (posterId && poster && !store.has(posterId)) store.set(posterId, poster)
  }
  return store
}

// --- resolving and externalizing a document ---------------------------------

type Json = unknown

/** Map every string in `v` through `fn`, returning a new tree (untouched
 *  subtrees are shared, not copied). */
function mapStrings(v: Json, fn: (s: string) => string): Json {
  if (typeof v === 'string') return fn(v)
  if (Array.isArray(v)) {
    let out: Json[] | null = null
    for (let i = 0; i < v.length; i++) {
      const next = mapStrings(v[i], fn)
      if (next !== v[i]) { out ??= v.slice(); out[i] = next }
    }
    return out ?? v
  }
  if (v && typeof v === 'object') {
    let out: Record<string, Json> | null = null
    for (const k of Object.keys(v)) {
      const cur = (v as Record<string, Json>)[k]
      const next = mapStrings(cur, fn)
      if (next !== cur) { out ??= { ...(v as Record<string, Json>) }; out[k] = next }
    }
    return out ?? v
  }
  return v
}

/** Every distinct store ref in `v`. */
export function storeRefsIn(v: Json, into = new Set<string>()): Set<string> {
  mapStrings(v, (s) => { if (isStoreRef(s)) into.add(s.slice(STORE_REF_PREFIX.length)); return s })
  return into
}

function withRequires<T>(doc: T, on: boolean): T {
  const d = doc as { requires?: unknown }
  const cur = Array.isArray(d.requires) ? d.requires.map(String) : d.requires === undefined ? [] : null
  if (cur === null) return doc // malformed: leave it to the gate, never "fix" it
  const has = cur.includes(ASSET_STORE_FEATURE)
  if (has === on) return doc
  const next = on ? [...cur, ASSET_STORE_FEATURE] : cur.filter((f) => f !== ASSET_STORE_FEATURE)
  const out = { ...(doc as object) } as { requires?: string[] }
  if (next.length) out.requires = next
  else delete out.requires
  return out as T
}

/**
 * Put the bytes back: every `slidomingo-store:<id>` string in `doc` that
 * `store` knows becomes its `data:` URI again. The in-memory document is
 * always resolved — the editor, validate, the clipboard and Copy JSON never
 * see a ref for bytes the file holds. A ref the store does NOT know stays
 * exactly as it is (a dangling ref is reported, never dropped, and the next
 * save keeps it). `asset-store` leaves `requires` once nothing is dangling:
 * every save recomputes it.
 */
export function resolveAssets<T>(doc: T, store: Map<string, string>): { doc: T; dangling: string[] } {
  const dangling = new Set<string>()
  const out = mapStrings(doc, (s) => {
    if (!isStoreRef(s)) return s
    const id = s.slice(STORE_REF_PREFIX.length)
    const uri = store.get(id)
    if (uri === undefined) { dangling.add(id); return s }
    return uri
  }) as T
  return { doc: withRequires(out, dangling.size > 0), dangling: [...dangling] }
}

/**
 * The file's side of resolveAssets: `stored` maps each `data:` URI the file
 * now carries in its store or static layer to its id; every doc string equal
 * to one becomes a ref. `requires` gains `asset-store` exactly when the
 * result holds any ref (including ones that were already dangling).
 */
export function externalizeAssets<T>(doc: T, stored: Map<string, string>): { doc: T; refs: number } {
  let refs = 0
  const out = mapStrings(doc, (s) => {
    if (isStoreRef(s)) { refs++; return s }
    if (!s.startsWith('data:')) return s
    const id = stored.get(s)
    if (!id) return s
    refs++
    return refFor(id)
  }) as T
  return { doc: withRequires(out, refs > 0), refs }
}

/**
 * A doc block's text, resolved against the file it came from. Byte-identical
 * passthrough for everything that holds no ref — every file written before
 * the store, every encrypted envelope, anything that does not parse — so old
 * files cost one substring search.
 */
export function resolveDocText(docText: string, html: string): string {
  if (!docText.includes(STORE_REF_PREFIX)) return docText
  let json: Json
  try { json = JSON.parse(docText) } catch { return docText }
  if ((json as { format?: unknown } | null)?.format === 'slidomingo/enc') return docText
  return JSON.stringify(resolveAssets(json, parseStoreHtml(html)).doc)
}

/** id → URI for every `data:` string anywhere in `docs` — the bytes a
 *  document already holds, addressable by the content hash a light JSON copy
 *  refers to them with. */
export function storeOf(...docs: unknown[]): Map<string, string> {
  const store = new Map<string, string>()
  mapStrings(docs, (s) => { if (s.startsWith('data:')) { const id = assetId(s); if (!store.has(id)) store.set(id, s) } return s })
  return store
}

/** The LIGHT copy of a document: every embedded `data:` string becomes its
 *  ref, so what leaves is the structure alone (and declares asset-store).
 *  Pasting it back into any document holding the same bytes restores them. */
export function lightDoc<T>(doc: T): T {
  const stored = new Map<string, string>()
  for (const [id, uri] of storeOf(doc)) stored.set(uri, id)
  return externalizeAssets(doc, stored).doc
}
