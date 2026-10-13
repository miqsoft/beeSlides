#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert zip rig — readZip's refusals, above all the zip bomb.
//
//   node scripts/test-convert/zip.ts        (Node ≥ 23.6 strips types natively)
//
// The archives here are hand-assembled byte by byte and their DEFLATE bodies
// come from node:zlib, an implementation that is not ours, so a reader bug and
// a writer bug cannot cancel out. DecompressionStream is wrapped to COUNT every
// byte it hands the reader and the size of every chunk it is fed: "refused" is not enough
// for a zip bomb, the refusal has to come before the bytes exist. Against the
// old reader (inflate everything, compare lengths afterwards) the bomb checks
// below see the full 256 MB produced and fail. The input chunk size is the
// half node cannot show by itself: Chrome inflates a whole input chunk before
// backpressure applies, so a reader that hands the decompressor the part in
// one big chunk still queues the whole bomb there, however carefully it reads
// the output (node's adapter pauses mid-chunk, so its output count can't tell).

import { deflateRawSync } from 'node:zlib'
import { readZip, writeZip, ZipError, MAX_UNPACKED } from '../../kernel/src/convert/zip.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --- count what the decompressor actually produces ---------------------------

let produced = 0
let biggestFed = 0
const Orig = globalThis.DecompressionStream
class CountingDecompressionStream {
  readonly writable: WritableStream<BufferSource>
  readonly readable: ReadableStream<Uint8Array>
  constructor(format: CompressionFormat) {
    const d = new Orig(format)
    const input = new TransformStream<Uint8Array, Uint8Array>({
      transform(c, ctl) { biggestFed = Math.max(biggestFed, c.length); ctl.enqueue(c) },
    })
    void input.readable.pipeTo(d.writable).catch(() => {})
    this.writable = input.writable as WritableStream<BufferSource>
    this.readable = d.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(c, ctl) { produced += c.length; ctl.enqueue(c) },
    }))
  }
}
globalThis.DecompressionStream = CountingDecompressionStream as unknown as typeof DecompressionStream

// --- a one-entry archive, every size field under our control ------------------

/** One DEFLATE entry whose central directory says `usize`/`crc`, whatever the
 *  body really unpacks to. */
function oneEntry(name: string, body: Uint8Array, usize: number, crc = 0): Uint8Array {
  const nm = new TextEncoder().encode(name)
  const lh = Buffer.alloc(30 + nm.length)
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize >>> 0, 22)
  lh.writeUInt16LE(nm.length, 26); lh.set(nm, 30)
  const ch = Buffer.alloc(46 + nm.length)
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10)
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(usize >>> 0, 24)
  ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(0, 42); ch.set(nm, 46)
  const eo = Buffer.alloc(22)
  eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10)
  eo.writeUInt32LE(ch.length, 12); eo.writeUInt32LE(lh.length + body.length, 16)
  return new Uint8Array(Buffer.concat([lh, body, ch, eo]))
}

async function refusal(zip: Uint8Array): Promise<string | undefined> {
  try { await readZip(zip); return undefined } catch (e) { return e instanceof ZipError ? e.message : `not a ZipError: ${e}` }
}

const MB = 1024 * 1024
const BOMB = 256 * MB
const bombBody = deflateRawSync(Buffer.alloc(BOMB), { level: 9 })
ok(bombBody.length < BOMB / 500, `the fixture is a real bomb (${bombBody.length} bytes → ${BOMB / MB} MB)`)

// positive control: a real multi-chunk part still reads back exactly
{
  const big = new TextEncoder().encode('<a:t>hello slidomingo</a:t>'.repeat(40000)) // ~1 MB, many stream chunks
  const zip = await writeZip([{ name: '[Content_Types].xml', data: new TextEncoder().encode('<Types/>') }, { name: 'ppt/x.xml', data: big }])
  produced = 0
  const parts = await readZip(zip)
  const got = parts.get('ppt/x.xml')
  ok(!!got && got.length === big.length && got.every((b, i) => b === big[i]), 'a ~1 MB deflated part round-trips byte for byte')
  ok(produced === big.length, 'and the decompressor produced exactly its size')
}

// the reported bug: a part that unpacks far past its declared size
{
  produced = 0
  biggestFed = 0
  const msg = await refusal(oneEntry('ppt/slides/slide1.xml', bombBody, 100))
  ok(!!msg && msg.includes('slide1.xml') && msg.includes('more than the 100 bytes'), `a bomb declaring 100 bytes is refused by name (${msg})`)
  ok(produced < 4 * MB, `…after at most a few chunks of output, not ${BOMB / MB} MB (produced ${produced})`)
  ok(biggestFed > 0 && biggestFed <= 16 * 1024, `…and the decompressor is fed small slices, so no engine can inflate the bomb in one go (largest ${biggestFed} bytes)`)
}

// an honest declaration of an absurd size is refused before inflating at all
{
  produced = 0
  const msg = await refusal(oneEntry('ppt/media/huge.bin', bombBody, MAX_UNPACKED + 1))
  ok(!!msg && msg.includes('too large'), `an entry declaring more than MAX_UNPACKED is refused (${msg})`)
  ok(produced === 0, 'without inflating a single byte')
}

// the existing refusals keep their meaning
{
  const body = deflateRawSync(Buffer.from('short'))
  const msg = await refusal(oneEntry('a.xml', body, 50))
  ok(!!msg && msg.includes('unpacked to 5 bytes but the directory says 50'), `a part shorter than declared is still refused (${msg})`)
}
{
  const body = deflateRawSync(Buffer.from('x'.repeat(5000))).subarray(0, 3)
  const msg = await refusal(oneEntry('b.xml', body, 5000))
  ok(!!msg && msg.includes('could not be decompressed'), `truncated DEFLATE is still a named ZipError (${msg})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
