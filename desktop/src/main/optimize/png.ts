// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Lossless PNG optimization, in the spirit of oxipng: the pixels stay exactly
// the same, only how they are packed changes. A PNG stores each row
// "filtered" (predicted from its neighbours) and then deflated; the filters
// are reversible by definition, so any choice of them decodes to the same
// pixels. This tries the file's own filtering plus a few re-filterings,
// packs the most compressible with zopfli, and keeps it only if the whole
// file got smaller. Every chunk except IDAT (colour profile, gamma, text,
// physical size, …) is copied byte for byte, in order.
//
// The result is checked here before it is returned: the new IDAT is inflated
// and un-filtered and must reproduce the original's pixel bytes exactly. The
// caller additionally compares decoded RGBA in main
// (desktop/src/main/pictures.ts).
//
// No DOM, no electron: node-testable (scripts/test-lossless-pictures.ts).

import { deflateSync, inflateSync, constants } from 'node:zlib'

const SIG = [137, 80, 78, 71, 13, 10, 26, 10]

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(type: Uint8Array, data: Uint8Array): number {
  let c = 0xffffffff
  for (const b of type) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface Chunk { type: string; data: Uint8Array; raw: Uint8Array }

function chunks(buf: Uint8Array): Chunk[] | null {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) return null
  const out: Chunk[] = []
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let p = 8
  while (p + 12 <= buf.length) {
    const len = view.getUint32(p)
    if (p + 12 + len > buf.length) return null
    const type = String.fromCharCode(...buf.subarray(p + 4, p + 8))
    const data = buf.subarray(p + 8, p + 8 + len)
    if (view.getUint32(p + 8 + len) !== crc32(buf.subarray(p + 4, p + 8), data)) return null
    out.push({ type, data, raw: buf.subarray(p, p + 12 + len) })
    p += 12 + len
    if (type === 'IEND') break
  }
  return out.at(-1)?.type === 'IEND' ? out : null
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Filtered scanlines → the raw pixel rows (without filter bytes). */
function unfilter(filtered: Uint8Array, rows: number, stride: number, bpp: number): Uint8Array | null {
  if (filtered.length !== rows * (stride + 1)) return null
  const out = new Uint8Array(rows * stride)
  for (let y = 0; y < rows; y++) {
    const f = filtered[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    const prev = row - stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0
      const b = y ? out[prev + x] : 0
      const c = y && x >= bpp ? out[prev + x - bpp] : 0
      const v = filtered[src + x]
      switch (f) {
        case 0: out[row + x] = v; break
        case 1: out[row + x] = (v + a) & 255; break
        case 2: out[row + x] = (v + b) & 255; break
        case 3: out[row + x] = (v + ((a + b) >> 1)) & 255; break
        case 4: out[row + x] = (v + paeth(a, b, c)) & 255; break
        default: return null
      }
    }
  }
  return out
}

/** Raw rows → filtered scanlines, with filter `f` (0–4) or `-1` = per row,
 *  the one with the smallest sum of absolute values (the libpng heuristic). */
function refilter(raw: Uint8Array, rows: number, stride: number, bpp: number, mode: number): Uint8Array {
  const out = new Uint8Array(rows * (stride + 1))
  const cand = mode < 0 ? [0, 1, 2, 3, 4] : [mode]
  const line = new Uint8Array(stride)
  for (let y = 0; y < rows; y++) {
    const row = y * stride, prev = row - stride
    let bestSum = Infinity
    for (const f of cand) {
      let sum = 0
      for (let x = 0; x < stride; x++) {
        const v = raw[row + x]
        const a = x >= bpp ? raw[row + x - bpp] : 0
        const b = y ? raw[prev + x] : 0
        const c = y && x >= bpp ? raw[prev + x - bpp] : 0
        const r = f === 0 ? v : f === 1 ? v - a : f === 2 ? v - b : f === 3 ? v - ((a + b) >> 1) : v - paeth(a, b, c)
        const byte = r & 255
        line[x] = byte
        sum += byte < 128 ? byte : 256 - byte
      }
      if (sum < bestSum || cand.length === 1) {
        bestSum = sum
        out[y * (stride + 1)] = f
        out.set(line, y * (stride + 1) + 1)
      }
    }
  }
  return out
}

export type Deflater = (data: Uint8Array) => Promise<Uint8Array>

const zlib9 = (data: Uint8Array, strategy: number) =>
  deflateSync(data, { level: 9, memLevel: 9, strategy })

/**
 * The optimized file, or null when nothing smaller was found (or the file is
 * not one this handles: APNG, a broken chunk, an unknown filter). `strong`
 * packs the winner with zopfli (slow; the caller runs this in a worker);
 * without it, zlib level 9 is the packer.
 */
export async function optimizePng(buf: Uint8Array, strong?: Deflater): Promise<Uint8Array | null> {
  const list = chunks(buf)
  if (!list) return null
  const ihdr = list[0]
  if (ihdr?.type !== 'IHDR' || ihdr.data.length !== 13) return null
  if (list.some((c) => c.type === 'acTL')) return null // animated: frames live in fdAT too
  const v = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, 13)
  const width = v.getUint32(0), height = v.getUint32(4)
  const depth = ihdr.data[8], color = ihdr.data[9], interlace = ihdr.data[12]
  const channels = CHANNELS[color]
  if (!channels || !width || !height || ihdr.data[10] !== 0 || ihdr.data[11] !== 0) return null
  const idats = list.filter((c) => c.type === 'IDAT')
  if (!idats.length) return null
  const total = idats.reduce((n, c) => n + c.data.length, 0)
  const joined = new Uint8Array(total)
  let o = 0
  for (const c of idats) { joined.set(c.data, o); o += c.data.length }
  let filtered: Uint8Array
  try { filtered = new Uint8Array(inflateSync(joined)) } catch { return null }

  const bitsPerPixel = depth * channels
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const stride = Math.ceil((width * bitsPerPixel) / 8)

  // Candidates for the filtered stream. Interlaced (Adam7) images keep their
  // own filtering — re-filtering seven sub-images is not worth the risk here —
  // and are only re-packed.
  const candidates: Uint8Array[] = [filtered]
  let raw: Uint8Array | null = null
  if (!interlace) {
    raw = unfilter(filtered, height, stride, bpp)
    if (!raw) return null
    // palette and sub-byte images compress best unfiltered (PNG spec 12.8)
    const modes = color === 3 || depth < 8 ? [0, -1] : [-1, 0, 1, 2, 4]
    for (const m of modes) candidates.push(refilter(raw, height, stride, bpp, m))
  }

  // pick the most compressible by a fast zlib pass, then pack it hard
  let best: Uint8Array | null = null
  let bestStream: Uint8Array | null = null
  for (const c of candidates) {
    for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
      const z = new Uint8Array(zlib9(c, strategy))
      if (!best || z.length < best.length) { best = z; bestStream = c }
    }
  }
  if (!best || !bestStream) return null
  if (strong) {
    try {
      const z = await strong(bestStream)
      if (z.length < best.length) best = z
    } catch { /* keep the zlib result */ }
  }

  // The check that matters: the new data must decode to the same pixels.
  try {
    const back = new Uint8Array(inflateSync(best))
    if (interlace) { if (!equal(back, filtered)) return null }
    else {
      const px = unfilter(back, height, stride, bpp)
      if (!px || !equal(px, raw!)) return null
    }
  } catch { return null }

  // reassemble: every chunk as it was, one IDAT where the first one stood
  const parts: Uint8Array[] = [Uint8Array.from(SIG)]
  let wrote = false
  for (const c of list) {
    if (c.type !== 'IDAT') { parts.push(c.raw); continue }
    if (wrote) continue
    wrote = true
    parts.push(chunk('IDAT', best))
  }
  const size = parts.reduce((n, p) => n + p.length, 0)
  if (size >= buf.length) return null
  const out = new Uint8Array(size)
  o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  const t = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)))
  out.set(t, 4)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(t, data))
  return out
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** The decoded pixel rows (filters undone), for tests: equal = same pixels. */
export function pngPixels(buf: Uint8Array): Uint8Array | null {
  const list = chunks(buf)
  if (!list) return null
  const d = list[0].data
  const v = new DataView(d.buffer, d.byteOffset, 13)
  const bits = d[8] * (CHANNELS[d[9]] ?? 0)
  const joined = Buffer.concat(list.filter((c) => c.type === 'IDAT').map((c) => c.data))
  const filtered = new Uint8Array(inflateSync(joined))
  if (d[12]) return filtered
  return unfilter(filtered, v.getUint32(4), Math.ceil((v.getUint32(0) * bits) / 8), Math.max(1, Math.ceil(bits / 8)))
}
