// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Worker thread for "Optimize pictures (lossless)…" (desktop/src/main/
// pictures.ts): zopfli and a full JPEG re-encode take seconds on a large
// picture, and main must keep answering every window meanwhile. One job at a
// time; the worker proposes, main decides (smaller AND identical pixels).
import { parentPort } from 'node:worker_threads'
import { zlibAsync } from '@gfx/zopfli'
import { optimizeJpeg } from './jpeg.ts'
import { optimizePng } from './png.ts'

export interface OptimizeJob { index: number; kind: 'png' | 'jpeg'; bytes: Uint8Array }
export interface OptimizeReply { index: number; bytes: Uint8Array | null }

/** zopfli effort by pixel-data size: nearly all of its gain comes from the
 *  first iteration (measured), and past ~32 MB it is too slow to offer. */
const zopfli = async (data: Uint8Array): Promise<Uint8Array> => {
  if (data.length > 32 << 20) throw new Error('too large for zopfli')
  return zlibAsync(data, { numiterations: data.length < 1 << 20 ? 3 : 1 })
}

parentPort!.on('message', async (job: OptimizeJob) => {
  let bytes: Uint8Array | null = null
  try {
    bytes = job.kind === 'png' ? await optimizePng(job.bytes, zopfli) : optimizeJpeg(job.bytes)
  } catch {
    bytes = null
  }
  const reply: OptimizeReply = { index: job.index, bytes }
  parentPort!.postMessage(reply)
})
