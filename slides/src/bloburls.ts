// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Embedded pictures and media as `blob:` URLs for the LIVE page.
//
// The document stores bytes as `data:` URIs, and render.ts used to put that
// string straight into every `src`. Each render then handed the browser a
// fresh multi-megabyte string to parse and decode: the canvas, every sidebar
// thumbnail, the Layout Manager tree, the present overlay — a layout
// background on 30 slides was 30+ copies of the same megabytes in the DOM.
// A `blob:` URL is a few dozen characters, and the browser decodes the bytes
// behind it once.
//
// It is a RENDERING detail and never more: the model keeps its `data:`
// strings, serialization never sees a blob URL, and any output that leaves
// this page (the no-JS static layer, the thumbnail preview written into the
// file, the speaker view's separate window, print) asks render.ts for
// `inlineData` and gets the `data:` string exactly as before.
//
// The bytes are decoded the way the browser's own `data:` URL processor does
// (fetch spec): the fragment is dropped, the body is percent-decoded to bytes,
// then base64-decoded when the header says so. A URI this cannot decode is
// returned unchanged, so the browser meets the same string it always did.

/** Below this, a `data:` string is cheaper than a Blob and a map entry. */
const MIN_LENGTH = 2048

const urls = new Map<string, string>()

/** The live-page URL for `uri`: a cached `blob:` URL for a large enough
 *  `data:` URI, else `uri` itself. */
export function blobUrlFor(uri: string): string {
  if (uri.length < MIN_LENGTH || !uri.startsWith('data:')) return uri
  const hit = urls.get(uri)
  if (hit) return hit
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return uri
  const blob = dataUriToBlob(uri)
  if (!blob) return uri
  const url = URL.createObjectURL(blob)
  urls.set(uri, url)
  return url
}

/** A `data:` URI's bytes and type as a Blob, or null when it does not decode. */
export function dataUriToBlob(uri: string): Blob | null {
  const hash = uri.indexOf('#')
  const whole = hash < 0 ? uri : uri.slice(0, hash)
  const comma = whole.indexOf(',')
  if (comma < 0) return null
  let meta = whole.slice(5, comma).trim()
  const base64 = /;\s*base64$/i.test(meta)
  if (base64) meta = meta.replace(/;\s*base64$/i, '').trim()
  let bytes = percentDecode(whole.slice(comma + 1))
  if (base64) {
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    try { bin = atob(bin) } catch { return null }
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  }
  return new Blob([bytes as BlobPart], { type: meta.startsWith(';') || !meta ? 'text/plain' : meta })
}

/** The URL spec's percent-decode, over the UTF-8 bytes of `s`. */
function percentDecode(s: string): Uint8Array {
  const input = new TextEncoder().encode(s)
  if (!s.includes('%')) return input
  const out = new Uint8Array(input.length)
  let n = 0
  const hex = (b: number) => (b >= 48 && b <= 57 ? b - 48 : b >= 65 && b <= 70 ? b - 55 : b >= 97 && b <= 102 ? b - 87 : -1)
  for (let i = 0; i < input.length; i++) {
    const b = input[i]
    if (b === 37 && i + 2 < input.length) {
      const hi = hex(input[i + 1]), lo = hex(input[i + 2])
      if (hi >= 0 && lo >= 0) { out[n++] = hi * 16 + lo; i += 2; continue }
    }
    out[n++] = b
  }
  return out.subarray(0, n)
}

/** Every `data:` string anywhere in `root` (the document being shown). */
function dataStrings(root: unknown, into: Set<string>): Set<string> {
  const stack: unknown[] = [root]
  while (stack.length) {
    const v = stack.pop()
    if (typeof v === 'string') { if (v.startsWith('data:')) into.add(v) }
    else if (Array.isArray(v)) { for (const x of v) stack.push(x) }
    else if (v && typeof v === 'object') { for (const k in v) stack.push((v as Record<string, unknown>)[k]) }
  }
  return into
}

/** Revoke every cached URL whose bytes `doc` no longer carries. */
export function releaseBlobUrls(doc: unknown): void {
  if (!urls.size) return
  const live = dataStrings(doc, new Set())
  for (const [uri, url] of urls) {
    if (live.has(uri)) continue
    URL.revokeObjectURL(url)
    urls.delete(uri)
  }
}

let sweep: ReturnType<typeof setTimeout> | null = null

/**
 * Release unused URLs soon, against whatever `current()` is by then — called
 * by the Store whenever the document is replaced or edited. Deferred, so a
 * picture removed and brought straight back (undo) keeps its URL, and so
 * nothing still being painted from the previous document loses its bytes
 * mid-frame.
 */
export function scheduleBlobSweep(current: () => unknown): void {
  if (!urls.size || sweep) return
  sweep = setTimeout(() => { sweep = null; releaseBlobUrls(current()) }, 10_000)
  ;(sweep as { unref?: () => void }).unref?.()
}
