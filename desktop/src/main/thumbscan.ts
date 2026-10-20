// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Decides, from a file's bytes alone, whether it is worth thumbnailing and at
// what page size — the DOM-free half of thumbs.ts. No electron import, so it
// is node-testable (scripts/test-desktop-thumbs.ts).
//
// A saved deck's layout, in file order (kernel/src/save.ts):
//   <head> … #beeslides-doc (the whole document, often most of the file) …
//   <body> splash, then the static first-page preview host
//   `<div data-beeslides-preview="1">` and its remover script, then the
//   optional static layer, then the compressed runtime (#beeslides-rt).
// Older builds parked the preview in a `<noscript data-beeslides-preview>`.
//
// So we read forward in chunks and stop as soon as we know: after the doc
// block for an encrypted deck, after the static layer's opening tag (or the
// runtime, when there is none) otherwise. The layer comes straight after the
// preview's remover, so a 24 MB template with its preview at 10.7 MB is read
// to 10.8 MB, not to the end. Nothing read here is kept once the call returns.
//
// WHY THE STATIC LAYER. The preview is capped at 64 KB (PREVIEW_BUDGET), so an
// image-heavy first page comes out with its pictures swapped for tinted
// boxes. The same file carries every slide at full fidelity in
// `#beeslides-static` (kernel/src/save.ts writeStaticLayer); thumbs.ts shows
// that layer's first slide instead whenever it is there.
import { open } from 'node:fs/promises'
import { detectFormat } from './docfile.ts'

export type ThumbSource =
  /** A password envelope: never rendered (AGENTS.md rule 4). */
  | { kind: 'enc' }
  /** No preview host (old file, pristine shell, not a BeeSlides file): a
   *  JavaScript-off render would only show the boot splash. */
  | { kind: 'none' }
  /** Carries a static first-page preview of a `width`×`height` page;
   *  `hasStatic` = also a full-fidelity static layer of every slide. */
  | { kind: 'preview'; width: number; height: number; hasStatic: boolean }

const CHUNK = 1 << 20
/** Beyond this we don't even look — no real deck is this big. */
export const MAX_SCAN_BYTES = 512 * 1024 * 1024
/** Bytes carried back across a chunk boundary so a marker split by it is found. */
const OVERLAP = 256
/** The preview is capped at PREVIEW_BUDGET (64 KB, slides/src/model.ts); its
 *  size-bearing transform sits near the top, after the hoisted <style>. */
const PREVIEW_SCAN = 96 * 1024

const SCRIPT_CLOSE = Buffer.from('</script')

/** The markers a file is scanned for. A file saved before 2026-10-20 spells
 *  every one `slidomingo` (kernel/src/legacynames.ts), and one file never
 *  mixes the two, so the doc block's spelling picks the set. */
interface Markers {
  // Attribute-shaped, not bare names: the shell's own head comment mentions
  // `id "beeslides-doc"` in prose. A DOM serializer always writes double quotes.
  docId: Buffer
  preview: Buffer
  /** Start of the compressed runtime (`beeslides-rt-css`, then `beeslides-rt`):
   *  past every place a preview is ever written. */
  runtime: Buffer
  /** The static layer's host (writeStaticLayer): never inside the preview, and
   *  distinct from its per-slide `data-beeslides-static-slide`. */
  staticMark: Buffer
}
const markersFor = (prefix: string): Markers => ({
  docId: Buffer.from(`id="${prefix}-doc"`),
  preview: Buffer.from(`data-${prefix}-preview`),
  runtime: Buffer.from(`id="${prefix}-rt`),
  staticMark: Buffer.from(`data-${prefix}-static="1"`),
})
const MARKER_SETS = [markersFor('beeslides'), markersFor('slidomingo')]

/** Bump when a thumbnail's look changes, so cached PNGs from an older
 *  renderer regenerate (v2: the static layer's first slide, not the preview). */
export const THUMB_CACHE_VERSION = 2

/** `<path hash>-<mtime ms>-v<version>.png` — the cache file for one version of
 *  one file. thumbs.ts drops every other `<path hash>-*.png` once it writes. */
export function thumbCacheName(hash: string, mtimeMs: number): string {
  return `${hash}-${Math.trunc(mtimeMs)}-v${THUMB_CACHE_VERSION}.png`
}

/** preview.ts overlay(): `scale(calc(min(100vw, <w/h*100>vh) / <w>px))`. */
const FIT_RE = /scale\(calc\(min\(100vw,\s*([\d.]+)vh\)\s*\/\s*([\d.]+)px\)\)/

/** The default page size, for a preview whose fit transform we can't read. */
const DEFAULT_SIZE = { width: 1280, height: 720 }

/** Whether the `data-beeslides-preview` at `at` is an attribute of an opening
 *  `<div` or `<noscript` tag (the host), rather than the remover `<script`, or
 *  stray text. */
function isHostAt(buf: Buffer, at: number): boolean {
  const lt = buf.lastIndexOf(0x3c /* < */, at)
  if (lt < 0 || at - lt > 200) return false
  const tag = buf.subarray(lt, at).toString('latin1')
  return !tag.includes('>') && /^<(div|noscript)\s/i.test(tag)
}

/** Page size from the preview's own fit transform, else the default. */
export function previewPageSize(previewHtml: string): { width: number; height: number } {
  const m = previewHtml.match(FIT_RE)
  const aspect = m ? Number(m[1]) : NaN
  const width = m ? Number(m[2]) : NaN
  if (!(aspect > 0) || !(width > 0)) return { ...DEFAULT_SIZE }
  return { width: Math.round(width), height: Math.round((width * 100) / aspect) }
}

/**
 * Classify `path` for thumbnailing, reading no further than needed. Rejects
 * only on I/O errors (missing file, permissions) — callers map those to a
 * placeholder.
 */
export async function scanThumbSource(path: string): Promise<ThumbSource> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    if (size > MAX_SCAN_BYTES) return { kind: 'none' }
    const buf = Buffer.allocUnsafe(size)
    let filled = 0
    let scanned = 0          // everything before this has been searched
    let docAt = -1           // the doc block's id attribute, once found
    let docEnd = -1          // end of the doc block, once found
    let hostAt = -1          // the preview host's attribute, once found
    let pageSize: { width: number; height: number } | null = null
    let mk = MARKER_SETS[0]   // the set the doc block was found under

    const readMore = async (): Promise<boolean> => {
      if (filled >= size) return false
      const { bytesRead } = await fh.read(buf, filled, Math.min(CHUNK, size - filled), filled)
      if (bytesRead <= 0) return false
      filled += bytesRead
      return true
    }

    for (;;) {
      const more = await readMore()
      const view = buf.subarray(0, filled)
      const from = Math.max(0, scanned - OVERLAP)

      if (docAt < 0) {
        for (const set of MARKER_SETS) {
          const at = view.indexOf(set.docId, from)
          if (at >= 0 && (docAt < 0 || at < docAt)) { docAt = at; mk = set }
        }
        const runtimeSeen = MARKER_SETS.some((set) => view.indexOf(set.runtime, from) >= 0)
        if (docAt < 0 && (runtimeSeen || !more)) return { kind: 'none' } // no doc block
      }
      if (docAt >= 0 && docEnd < 0) {
        const close = view.indexOf(SCRIPT_CLOSE, Math.max(from, docAt))
        if (close >= 0) {
          const start = view.lastIndexOf('<script', docAt)
          docEnd = close + SCRIPT_CLOSE.length
          // Only the block itself is decoded: detectFormat's regex needs no
          // more, and a 10 MB block is still better than a 24 MB file.
          const format = detectFormat(view.subarray(start < 0 ? docAt : start, docEnd + 1).toString('utf8'))
          if (format === 'enc') return { kind: 'enc' }
          if (format === 'none') return { kind: 'none' }
        } else if (!more) {
          return { kind: 'none' }             // truncated doc block
        }
      }

      if (docEnd >= 0 && hostAt < 0) {
        let at = view.indexOf(mk.preview, Math.max(from, docEnd))
        while (at >= 0 && !isHostAt(view, at)) at = view.indexOf(mk.preview, at + mk.preview.length)
        if (at >= 0) hostAt = at
        else if (view.indexOf(mk.runtime, Math.max(from, docEnd)) >= 0 || !more) return { kind: 'none' }
      }

      if (hostAt >= 0 && !pageSize && (filled - hostAt >= PREVIEW_SCAN || !more)) {
        const html = view.subarray(hostAt, Math.min(filled, hostAt + PREVIEW_SCAN)).toString('latin1')
        pageSize = previewPageSize(html)
      }
      if (pageSize) {
        // From the host, not `from`: the page size may have needed a later
        // chunk than the one the layer's tag arrived in. Either marker sits
        // right after the preview, so this stays cheap.
        if (view.indexOf(mk.staticMark, hostAt) >= 0) return { kind: 'preview', ...pageSize, hasStatic: true }
        if (view.indexOf(mk.runtime, hostAt) >= 0 || !more) return { kind: 'preview', ...pageSize, hasStatic: false }
      }

      scanned = filled
      if (!more) return { kind: 'none' }
    }
  } finally {
    await fh.close()
  }
}
