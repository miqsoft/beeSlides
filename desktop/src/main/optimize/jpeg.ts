// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Lossless JPEG optimization: what `jpegtran -optimize -copy all` does, in
// TypeScript. A baseline JPEG stores its DCT coefficients as Huffman-coded
// symbols plus raw extra bits, usually with the example tables from the
// standard. This rewrites ONLY the Huffman tables — optimal ones, built from
// the image's own symbol frequencies (ITU T.81 Annex K.2, as libjpeg does) —
// and re-emits the very same symbols and extra bits with them. The
// coefficients are untouched, so every decoder produces the same pixels.
// Every other segment (EXIF, ICC profiles, comments, quantization tables,
// anything after EOI) is copied byte for byte.
//
// Deliberately narrow: baseline and extended-sequential Huffman JPEGs only
// (SOF0/SOF1). Progressive, lossless, hierarchical and arithmetic-coded files
// are returned as null — "no improvement" — never guessed at. Anything that
// does not parse exactly is also null. The caller keeps a result only if it
// is smaller AND decodes to identical pixels (desktop/src/main/pictures.ts).
//
// No DOM, no electron: node-testable (scripts/test-lossless-pictures.ts).

interface Huff {
  /** 16 code-length counts + the symbols, exactly as a DHT stores them */
  counts: number[]
  symbols: number[]
  // decoding
  maxcode: Int32Array // [17], -1 = no codes of this length
  valptr: Int32Array
  mincode: Int32Array
  /** 9-bit lookahead: (length << 8) | symbol, 0 = longer than 9 bits */
  fast: Uint16Array
}

function buildHuff(counts: number[], symbols: number[]): Huff {
  const maxcode = new Int32Array(18).fill(-1)
  const valptr = new Int32Array(17)
  const mincode = new Int32Array(17)
  const fast = new Uint16Array(512)
  let code = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    valptr[len] = k
    mincode[len] = code
    for (let i = 0; i < counts[len - 1]; i++) {
      if (len <= 9) {
        const shift = 9 - len
        const base = code << shift
        for (let f = 0; f < 1 << shift; f++) fast[base + f] = (len << 8) | symbols[k]
      }
      code++
      k++
    }
    if (counts[len - 1]) maxcode[len] = code - 1
    code <<= 1
  }
  maxcode[17] = 0x7fffffff
  return { counts, symbols, maxcode, valptr, mincode, fast }
}

/** Reads bits from one entropy-coded interval (already un-stuffed). */
class BitReader {
  private pos = 0
  private acc = 0
  private n = 0
  private readonly data: Uint8Array
  constructor(data: Uint8Array) { this.data = data }
  private fill() {
    while (this.n <= 24) {
      // past the end: 1-bits, which is what the encoder pads with
      const b = this.pos < this.data.length ? this.data[this.pos] : 0xff
      this.pos++
      this.acc = ((this.acc << 8) | b) >>> 0
      this.n += 8
    }
  }
  peek(bits: number): number { if (this.n < bits) this.fill(); return (this.acc >>> (this.n - bits)) & ((1 << bits) - 1) }
  skip(bits: number) { this.n -= bits; this.acc &= this.n ? (2 ** this.n - 1) : 0 }
  read(bits: number): number { if (!bits) return 0; const v = this.peek(bits); this.skip(bits); return v }
  /** Bytes consumed so far that held real data (for the overrun check). */
  get overran(): boolean { return this.pos - Math.floor(this.n / 8) > this.data.length }
  decode(h: Huff): number {
    const look = h.fast[this.peek(9)]
    if (look) { this.skip(look >> 8); return look & 0xff }
    let code = this.read(1)
    let len = 1
    while (code > h.maxcode[len]) {
      code = (code << 1) | this.read(1)
      if (++len > 16) throw new Error('bad huffman code')
    }
    return h.symbols[h.valptr[len] + code - h.mincode[len]]
  }
}

/** A growable byte buffer (photos run to megabytes; number[] would not). */
class Bytes {
  private buf = new Uint8Array(1 << 16)
  length = 0
  private room(n: number) {
    if (this.length + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.length + n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
  }
  byte(b: number) { this.room(1); this.buf[this.length++] = b }
  push(a: ArrayLike<number>) {
    this.room(a.length)
    if (a instanceof Uint8Array) this.buf.set(a, this.length)
    else for (let i = 0; i < a.length; i++) this.buf[this.length + i] = a[i]
    this.length += a.length
  }
  result(): Uint8Array { return this.buf.slice(0, this.length) }
}

/** Writes bits with 0xFF stuffing. */
class BitWriter {
  private readonly out: Bytes
  constructor(out: Bytes) { this.out = out }
  private acc = 0
  private n = 0
  write(value: number, bits: number) {
    if (!bits) return
    this.acc = ((this.acc << bits) | (value & ((1 << bits) - 1))) >>> 0
    this.n += bits
    while (this.n >= 8) {
      const b = (this.acc >>> (this.n - 8)) & 0xff
      this.out.byte(b)
      if (b === 0xff) this.out.byte(0)
      this.n -= 8
      this.acc &= this.n ? (2 ** this.n - 1) : 0
    }
  }
  /** Pad to a byte boundary with 1-bits (T.81 F.1.2.3). */
  flush() { if (this.n) this.write((1 << (8 - this.n)) - 1, 8 - this.n) }
}

/** Optimal code lengths for `freq` (256 symbols), limited to 16 bits. T.81
 *  Annex K.2 / libjpeg jpeg_gen_optimal_table, including the reserved
 *  all-ones code point. Returns DHT-shaped counts and symbols. */
export function optimalTable(freqIn: ArrayLike<number>): { counts: number[]; symbols: number[] } {
  const freq = new Float64Array(257)
  for (let i = 0; i < 256; i++) freq[i] = freqIn[i]
  freq[256] = 1
  const codesize = new Int32Array(257)
  const others = new Int32Array(257).fill(-1)
  for (;;) {
    let c1 = -1, c2 = -1, v = Infinity
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) { v = freq[i]; c1 = i }
    v = Infinity
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) { v = freq[i]; c2 = i }
    if (c2 < 0) break
    freq[c1] += freq[c2]
    freq[c2] = 0
    codesize[c1]++
    while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++ }
    others[c1] = c2
    codesize[c2]++
    while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++ }
  }
  const bits = new Int32Array(33)
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++
  for (let i = 32; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2
      while (bits[j] === 0) j--
      bits[i] -= 2
      bits[i - 1]++
      bits[j + 1] += 2
      bits[j]--
    }
  }
  let i = 16
  while (bits[i] === 0) i--
  bits[i]-- // drop the reserved code point
  const symbols: number[] = []
  for (let len = 1; len <= 32; len++) for (let s = 0; s < 256; s++) if (codesize[s] === len) symbols.push(s)
  return { counts: Array.from(bits.subarray(1, 17)), symbols }
}

interface Component { id: number; h: number; v: number }
interface Segment { marker: number; start: number; end: number } // [start,end) incl. marker bytes
interface Scan {
  header: Segment
  comps: Array<{ comp: Component; dc: number; ac: number }>
  intervals: Uint8Array[] // un-stuffed entropy data between RST markers
  restart: number
  dc: Map<number, Huff>
  ac: Map<number, Huff>
}

const SOF_BASELINE = new Set([0xc0, 0xc1])
const SOF_OTHER = new Set([0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function parse(buf: Uint8Array) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null
  const segs: Array<Segment | Scan> = []
  const dc = new Map<number, Huff>()
  const ac = new Map<number, Huff>()
  let comps: Component[] = []
  let width = 0, height = 0, hmax = 1, vmax = 1
  let restart = 0
  let p = 2
  let eoi = -1
  while (p < buf.length) {
    if (buf[p] !== 0xff) return null
    while (buf[p] === 0xff) p++ // fill bytes
    const marker = buf[p++]
    const start = p - 2
    if (marker === 0xd9) { eoi = p; segs.push({ marker, start, end: p }); break }
    if (marker >= 0xd0 && marker <= 0xd7) return null // RST outside a scan
    if (p + 2 > buf.length) return null
    const len = (buf[p] << 8) | buf[p + 1]
    const body = p + 2
    const end = p + len
    if (end > buf.length) return null
    if (SOF_OTHER.has(marker)) return null // progressive/lossless/arithmetic: not ours
    if (marker === 0xdc) return null // DNL: height defined after the scan, rare; bail
    if (SOF_BASELINE.has(marker)) {
      height = (buf[body + 1] << 8) | buf[body + 2]
      width = (buf[body + 3] << 8) | buf[body + 4]
      const n = buf[body + 5]
      comps = []
      for (let i = 0; i < n; i++) {
        const o = body + 6 + i * 3
        comps.push({ id: buf[o], h: buf[o + 1] >> 4, v: buf[o + 1] & 15 })
      }
      if (!width || !height || !comps.length) return null
      hmax = Math.max(...comps.map((c) => c.h))
      vmax = Math.max(...comps.map((c) => c.v))
    }
    if (marker === 0xc4) {
      let q = body
      while (q < end) {
        const tc = buf[q] >> 4, th = buf[q] & 15
        const counts = Array.from(buf.subarray(q + 1, q + 17))
        const total = counts.reduce((a, b) => a + b, 0)
        const symbols = Array.from(buf.subarray(q + 17, q + 17 + total))
        if (tc > 1 || th > 3 || symbols.length !== total) return null
        ;(tc ? ac : dc).set(th, buildHuff(counts, symbols))
        q += 17 + total
      }
      if (q !== end) return null
    }
    if (marker === 0xdd) restart = (buf[body] << 8) | buf[body + 1]
    if (marker === 0xda) {
      if (!comps.length) return null
      const ns = buf[body]
      const sc: Scan['comps'] = []
      for (let i = 0; i < ns; i++) {
        const cid = buf[body + 1 + i * 2]
        const t = buf[body + 2 + i * 2]
        const comp = comps.find((c) => c.id === cid)
        if (!comp || !dc.has(t >> 4) || !ac.has(t & 15)) return null
        sc.push({ comp, dc: t >> 4, ac: t & 15 })
      }
      const o = body + 1 + ns * 2
      if (buf[o] !== 0 || buf[o + 1] !== 63 || buf[o + 2] !== 0) return null // not a baseline scan
      // entropy-coded data: up to the next marker that is not RST or stuffing
      const intervals: Uint8Array[] = []
      let cur: number[] = []
      let q = end
      for (;;) {
        if (q >= buf.length) return null
        const b = buf[q]
        if (b !== 0xff) { cur.push(b); q++; continue }
        const nx = buf[q + 1]
        if (nx === 0x00) { cur.push(0xff); q += 2; continue }
        if (nx === 0xff) { q++; continue }
        if (nx >= 0xd0 && nx <= 0xd7) { intervals.push(Uint8Array.from(cur)); cur = []; q += 2; continue }
        break
      }
      intervals.push(Uint8Array.from(cur))
      segs.push({
        header: { marker, start, end }, comps: sc, intervals, restart,
        dc: new Map(dc), ac: new Map(ac),
      })
      p = q
      continue
    }
    segs.push({ marker, start, end })
    p = end
  }
  if (eoi < 0 || !comps.length) return null
  return { segs, comps, width, height, hmax, vmax, tail: buf.subarray(eoi) }
}

type Parsed = NonNullable<ReturnType<typeof parse>>

/** The MCU shape of a scan: how many MCUs, and which table pair codes each block. */
function scanLayout(scan: Scan, j: Parsed): { mcus: number; blocks: Array<{ dc: number; ac: number }> } {
  if (scan.comps.length === 1) {
    const { comp, dc, ac } = scan.comps[0]
    const w = Math.ceil(Math.ceil((j.width * comp.h) / j.hmax) / 8)
    const h = Math.ceil(Math.ceil((j.height * comp.v) / j.vmax) / 8)
    return { mcus: w * h, blocks: [{ dc, ac }] }
  }
  const blocks: Array<{ dc: number; ac: number }> = []
  for (const { comp, dc, ac } of scan.comps) for (let i = 0; i < comp.h * comp.v; i++) blocks.push({ dc, ac })
  return { mcus: Math.ceil(j.width / (8 * j.hmax)) * Math.ceil(j.height / (8 * j.vmax)), blocks }
}

/**
 * Walk every symbol of a scan: `onSym(isAc, table, symbol, extraBits, nExtra)`,
 * and `onInterval()` after each restart interval. Throws on any inconsistency
 * (wrong interval count, a code the table does not have, running past the data).
 */
function walkScan(
  scan: Scan, j: Parsed,
  onSym: (ac: boolean, table: number, sym: number, extra: number, n: number) => void,
  onInterval: () => void,
) {
  const { mcus, blocks } = scanLayout(scan, j)
  const per = scan.restart || mcus
  const want = Math.ceil(mcus / per)
  if (scan.intervals.length !== want) throw new Error(`restart intervals: ${scan.intervals.length} vs ${want}`)
  let mcu = 0
  for (const data of scan.intervals) {
    const r = new BitReader(data)
    const n = Math.min(per, mcus - mcu)
    for (let m = 0; m < n; m++) {
      for (const b of blocks) {
        const dh = scan.dc.get(b.dc)!
        const ah = scan.ac.get(b.ac)!
        const s = r.decode(dh)
        if (s > 16) throw new Error('bad dc size')
        onSym(false, b.dc, s, r.read(s), s)
        for (let k = 1; k < 64;) {
          const rs = r.decode(ah)
          const run = rs >> 4, size = rs & 15
          if (size === 0) {
            onSym(true, b.ac, rs, 0, 0)
            if (run !== 15) break // EOB
            k += 16 // ZRL
          } else {
            k += run
            if (k > 63) throw new Error('coefficient index past 63')
            onSym(true, b.ac, rs, r.read(size), size)
            k++
          }
        }
      }
    }
    if (r.overran) throw new Error('ran past the entropy data')
    mcu += n
    onInterval()
  }
}

/** The optimized file, or null when there is nothing this can (safely) do. */
export function optimizeJpeg(buf: Uint8Array): Uint8Array | null {
  let j: Parsed | null
  try { j = parse(buf) } catch { return null }
  if (!j) return null
  const out = new Bytes()
  const push = (a: ArrayLike<number>) => out.push(a)
  push([0xff, 0xd8])
  try {
    for (const seg of j.segs) {
      if ('intervals' in seg) {
        // frequencies of THIS scan, per table it uses
        const freq = new Map<string, Float64Array>()
        const f = (ac: boolean, t: number) => {
          const key = (ac ? 'a' : 'd') + t
          let a = freq.get(key)
          if (!a) freq.set(key, (a = new Float64Array(256)))
          return a
        }
        walkScan(seg, j, (ac, t, sym) => { f(ac, t)[sym]++ }, () => {})
        // one DHT with an optimal table for every table the scan uses
        const tables = new Map<string, Huff>()
        const dht: number[] = []
        for (const [key, fr] of freq) {
          const { counts, symbols } = optimalTable(fr)
          tables.set(key, buildHuff(counts, symbols))
          dht.push(((key[0] === 'a' ? 1 : 0) << 4) | Number(key.slice(1)), ...counts, ...symbols)
        }
        push([0xff, 0xc4, (dht.length + 2) >> 8, (dht.length + 2) & 0xff])
        push(dht)
        push(buf.subarray(seg.header.start, seg.header.end))
        // re-emit the same symbols and extra bits with the new tables
        const codes = new Map<string, { code: Uint32Array; len: Uint8Array }>()
        for (const [key, h] of tables) {
          const code = new Uint32Array(256), len = new Uint8Array(256)
          let c = 0, k = 0
          for (let l = 1; l <= 16; l++) {
            for (let i = 0; i < h.counts[l - 1]; i++) { code[h.symbols[k]] = c++; len[h.symbols[k]] = l; k++ }
            c <<= 1
          }
          codes.set(key, { code, len })
        }
        const w = new BitWriter(out)
        let rst = 0
        let left = seg.intervals.length
        walkScan(seg, j, (ac, t, sym, extra, n) => {
          const c = codes.get((ac ? 'a' : 'd') + t)!
          if (!c.len[sym]) throw new Error('symbol missing from its optimal table')
          w.write(c.code[sym], c.len[sym])
          w.write(extra, n)
        }, () => {
          w.flush()
          if (--left > 0) { out.push([0xff, 0xd0 + (rst & 7)]); rst++ }
        })
      } else if (seg.marker !== 0xc4) {
        push(buf.subarray(seg.start, seg.end))
      }
    }
  } catch {
    return null
  }
  push(j.tail)
  return out.length < buf.length ? out.result() : null
}

/**
 * Every (table, symbol, extra bits) of every scan, as one string — two files
 * whose streams are equal here hold identical coefficients. A structural
 * check the optimizer's rig uses beside the pixel comparison.
 */
export function jpegSymbolDigest(buf: Uint8Array): string | null {
  const j = parse(buf)
  if (!j) return null
  let h = 2166136261
  let count = 0
  const mix = (v: number) => { h = Math.imul(h ^ (v & 0xffff), 16777619) >>> 0; h = Math.imul(h ^ (v >>> 16), 16777619) >>> 0 }
  for (const seg of j.segs) {
    if (!('intervals' in seg)) continue
    walkScan(seg, j, (ac, _t, sym, extra, n) => { count++; mix(ac ? 1 : 0); mix(sym); mix(extra); mix(n) }, () => mix(0xffffffff))
  }
  return `${count}:${h.toString(16)}`
}
