#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Lossless picture optimization rig.
//
//   node scripts/test-lossless-pictures.ts
//
// WHAT THIS PROVES. "Optimize pictures (lossless)…" (desktop/src/main/
// pictures.ts) rewrites the bytes of an author's pictures. The product rule
// is that quality is sacred, so the only acceptable result is one that
// decodes to exactly the same pixels. Main checks that with Electron's own
// decoder before accepting anything; this rig pins the two optimizers
// underneath, without Electron:
//   · JPEG (optimize/jpeg.ts) re-emits the SAME entropy-coded symbols and
//     extra bits with optimal Huffman tables — same coefficients, so same
//     pixels in every decoder — keeps every other segment byte for byte, and
//     declines (null) whatever it does not handle, e.g. progressive files;
//   · PNG (optimize/png.ts) keeps every non-IDAT chunk byte for byte and its
//     pixel rows identical, for truecolour, palette, 1-bit, 16-bit and
//     interlaced images.
// Pixel identity through an independent decoder (libjpeg's djpeg, macOS
// sips) was checked by hand when this landed; see docs/DECISIONS.md.

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { optimizeJpeg, jpegSymbolDigest, optimalTable } from '../desktop/src/main/optimize/jpeg.ts'
import { optimizePng, pngPixels } from '../desktop/src/main/optimize/png.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

console.log('\noptimal Huffman tables')
{
  const freq = new Array(256).fill(0)
  for (let i = 0; i < 256; i++) freq[i] = i % 7 === 0 ? 1 : Math.floor(1e6 / (i + 1) ** 2) // steep: forces length limiting
  const { counts, symbols } = optimalTable(freq)
  const kraft = counts.reduce((s, c, i) => s + c / 2 ** (i + 1), 0)
  ok(counts.length === 16 && symbols.length === counts.reduce((a, b) => a + b, 0), 'DHT-shaped: 16 counts, one symbol per code')
  ok(kraft < 1, `the all-ones code point stays reserved (Kraft sum ${kraft.toFixed(6)} < 1)`)
  ok(new Set(symbols).size === symbols.length && symbols.length === freq.filter((f) => f > 0).length, 'every used symbol gets exactly one code')
  const one = optimalTable(Object.assign(new Array(256).fill(0), { 0: 5 }))
  ok(one.symbols.length === 1 && one.counts[0] === 1, 'a single-symbol table still decodes (one 1-bit code)')
}

console.log('\nJPEG')
{
  const dirs = [join(root, 'scripts/gallery-photos'), join(root, 'scripts/gallery-photos/thumbs'), join(root, 'scripts/gallery-media')]
  const files = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.jpe?g$/i.test(f)).map((f) => join(d, f)))
  let optimized = 0, declined = 0
  for (const f of files) {
    const buf = new Uint8Array(readFileSync(f))
    const out = optimizeJpeg(buf)
    const name = f.slice(root.length + 1)
    const progressive = (() => { for (let p = 2; p < buf.length - 3;) { const m = buf[p + 1]; if (m === 0xc2) return true; if (m === 0xda) return false; p += 2 + ((buf[p + 2] << 8) | buf[p + 3]) } return false })()
    if (!out) {
      declined++
      if (!progressive) ok(false, `${name}: a baseline file was declined`)
      continue
    }
    optimized++
    ok(out.length < buf.length, `${name}: ${buf.length} → ${out.length} B`)
    ok(jpegSymbolDigest(out) === jpegSymbolDigest(buf), `${name}: identical symbols and extra bits (same coefficients)`)
    // every non-DHT segment before the first scan survives byte for byte
    const segs = (b: Uint8Array) => {
      const out: string[] = []
      for (let p = 2; p < b.length - 3;) {
        const m = b[p + 1]; if (m === 0xda) break
        const len = (b[p + 2] << 8) | b[p + 3]
        if (m !== 0xc4) out.push(Buffer.from(b.subarray(p, p + 2 + len)).toString('base64'))
        p += 2 + len
      }
      return out.join('|')
    }
    ok(segs(out) === segs(buf), `${name}: EXIF/ICC/quantization and every other segment unchanged`)
  }
  ok(optimized >= 5, `baseline files optimized (${optimized}), progressive ones declined (${declined})`)
  ok(optimizeJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])) === null && optimizeJpeg(new Uint8Array([1, 2, 3])) === null, 'nothing to do / not a JPEG → null')
  const f = new Uint8Array(readFileSync(join(root, 'scripts/gallery-photos/thumbs/fair.jpg')))
  ok(optimizeJpeg(f.subarray(0, Math.floor(f.length * 0.7))) === null, 'a truncated file → null, never a guess')
}

console.log('\nPNG')
{
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Uint8Array) => {
    const t = Buffer.from(type)
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, c])
  }
  /** a PNG with filter None rows, split over two IDATs, packed at zlib level 1 */
  const make = (w: number, h: number, depth: number, color: number, interlace: number, rowBytes: (y: number) => Buffer, extra: Buffer[] = []) => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = color; ihdr[12] = interlace
    let raw: Buffer
    if (!interlace) raw = Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), rowBytes(y)])))
    else {
      // Adam7 for 8-bit RGB: pass by pass, filter None
      const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
      const parts: Buffer[] = []
      for (const [x0, y0, dx, dy] of passes) {
        for (let y = y0; y < h; y += dy) {
          const cols: number[] = []
          for (let x = x0; x < w; x += dx) { const r = rowBytes(y); cols.push(r[x * 3], r[x * 3 + 1], r[x * 3 + 2]) }
          if (cols.length) parts.push(Buffer.from([0, ...cols]))
        }
      }
      raw = Buffer.concat(parts)
    }
    const z = deflateSync(raw, { level: 1 })
    const half = Math.floor(z.length / 2)
    return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...extra,
      chunk('IDAT', z.subarray(0, half)), chunk('IDAT', z.subarray(half)), chunk('tEXt', Buffer.from('Comment\0kept verbatim')), chunk('IEND', Buffer.alloc(0))]))
  }
  const W = 120, H = 90
  const rgbRow = (y: number) => { const r = Buffer.alloc(W * 3); for (let x = 0; x < W; x++) { r[x * 3] = x * 2; r[x * 3 + 1] = y * 2; r[x * 3 + 2] = (x ^ y) & 255 } return r }
  const icc = chunk('iCCP', Buffer.concat([Buffer.from('fake\0\0'), deflateSync(Buffer.from('not really a profile'))]))
  const plte = chunk('PLTE', Buffer.from(Array.from({ length: 16 * 3 }, (_, i) => (i * 17) & 255)))
  const cases: Array<[string, Uint8Array]> = [
    ['RGB 8-bit + iCCP', make(W, H, 8, 2, 0, rgbRow, [icc])],
    ['RGBA 8-bit', make(W, H, 8, 6, 0, (y) => { const r = Buffer.alloc(W * 4); for (let x = 0; x < W; x++) r.writeUInt32BE((((x * 2) << 24) | ((y * 2) << 16) | (x << 8) | (255 - y)) >>> 0, x * 4); return r })],
    ['palette 4-bit', make(W, H, 4, 3, 0, (y) => { const r = Buffer.alloc(W / 2); for (let x = 0; x < W / 2; x++) r[x] = (((x + y) & 15) << 4) | ((x * y) & 15); return r }, [plte])],
    ['grayscale 1-bit', make(W, H, 1, 0, 0, (y) => { const r = Buffer.alloc(W / 8); for (let x = 0; x < W / 8; x++) r[x] = (y & 1 ? 0xaa : 0x55) ^ x; return r })],
    ['grayscale 16-bit', make(W, H, 16, 0, 0, (y) => { const r = Buffer.alloc(W * 2); for (let x = 0; x < W; x++) r.writeUInt16BE((x * 500 + y * 7) & 0xffff, x * 2); return r })],
    ['RGB interlaced', make(W, H, 8, 2, 1, rgbRow)],
  ]
  // interlaced images are only re-packed (not re-filtered), so they need the
  // strong packer the app uses (zopfli, a desktop dependency) to get smaller
  const zopfli = createRequire(join(root, 'desktop/package.json'))('@gfx/zopfli')
  const strong = (d: Uint8Array) => zopfli.zlibAsync(d, { numiterations: 1 })
  for (const [name, png] of cases) {
    const out = await optimizePng(png, name.includes('interlaced') ? strong : undefined)
    if (!out) { ok(false, `${name}: not optimized`); continue }
    ok(out.length < png.length, `${name}: ${png.length} → ${out.length} B`)
    ok(Buffer.from(pngPixels(out)!).equals(Buffer.from(pngPixels(png)!)), `${name}: identical pixel rows`)
    const others = (b: Uint8Array) => {
      const list: string[] = []
      for (let p = 8; p < b.length;) {
        const len = new DataView(b.buffer, b.byteOffset).getUint32(p)
        const type = Buffer.from(b.subarray(p + 4, p + 8)).toString()
        if (type !== 'IDAT') list.push(Buffer.from(b.subarray(p, p + 12 + len)).toString('base64'))
        p += 12 + len
      }
      return list.join('|')
    }
    ok(others(out) === others(png), `${name}: every other chunk byte for byte, in order`)
  }
  const again = await optimizePng((await optimizePng(cases[0][1]))!)
  ok(again === null || again.length < cases[0][1].length, 'optimizing an optimized file never grows it')
  ok(await optimizePng(new Uint8Array([137, 80, 78, 71])) === null, 'not a PNG → null')
  const bad = new Uint8Array(cases[0][1]); bad[40] ^= 0xff
  ok(await optimizePng(bad) === null, 'a chunk with a bad CRC → null, never a guess')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
