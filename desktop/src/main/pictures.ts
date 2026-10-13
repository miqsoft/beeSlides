// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// "Optimize pictures (lossless)…" — Document properties ▸ Clean up, desktop
// only (docs/DECISIONS.md 2026-09-28). The renderer hands over the document's
// JPEG and PNG `data:` URIs; a worker thread (optimize/worker.ts) proposes a
// smaller encoding of each — JPEG: optimal Huffman tables with the
// coefficients untouched (optimize/jpeg.ts); PNG: re-filtering + zopfli
// (optimize/png.ts) — and MAIN accepts one only if it is smaller AND
// Electron's own decoder (nativeImage, the same Skia the renderer draws
// with) produces byte-identical pixels for it. Metadata and ICC profiles are
// copied untouched by both optimizers. Nothing here writes a file: the
// renderer applies the accepted URIs as one undoable edit.
//
// Quality is sacred (the product rule): there is no lossy path here and no
// "close enough" — anything that fails a check keeps its original bytes.
import { nativeImage, type IpcMainInvokeEvent } from 'electron'
import { handleFrom } from './ipcguard.ts'
import createOptimizer from './optimize/worker.ts?nodeWorker'
import type { OptimizeJob, OptimizeReply } from './optimize/worker.ts'

export interface OptimizedPicture { uri: string; next: string; saved: number }

const DATA_RE = /^(data:image\/(png|jpe?g)(?:;[^,;]*)*;base64,)([A-Za-z0-9+/=\s]+)$/i

/** Same size, same pixels, as decoded by Electron itself. */
function samePixels(a: Uint8Array, b: Uint8Array): boolean {
  const ia = nativeImage.createFromBuffer(Buffer.from(a))
  const ib = nativeImage.createFromBuffer(Buffer.from(b))
  if (ia.isEmpty() || ib.isEmpty()) return false
  const sa = ia.getSize(), sb = ib.getSize()
  if (sa.width !== sb.width || sa.height !== sb.height) return false
  return ia.toBitmap().equals(ib.toBitmap())
}

async function optimizeAll(ev: IpcMainInvokeEvent, uris: unknown): Promise<OptimizedPicture[]> {
  if (!Array.isArray(uris)) return []
  const jobs: Array<{ uri: string; head: string; kind: 'png' | 'jpeg'; bytes: Uint8Array }> = []
  for (const uri of new Set(uris)) {
    if (typeof uri !== 'string') continue
    const m = DATA_RE.exec(uri)
    if (!m) continue
    jobs.push({ uri, head: m[1], kind: m[2].toLowerCase() === 'png' ? 'png' : 'jpeg', bytes: new Uint8Array(Buffer.from(m[3], 'base64')) })
  }
  const out: OptimizedPicture[] = []
  if (!jobs.length) return out
  const worker = createOptimizer({})
  const progress = (done: number) => {
    try { if (!ev.sender.isDestroyed()) ev.sender.send('slidomingo:optimize-progress', { done, total: jobs.length }) } catch { /* window gone */ }
  }
  try {
    for (let i = 0; i < jobs.length; i++) {
      progress(i)
      const job = jobs[i]
      const reply = await new Promise<OptimizeReply>((resolve, reject) => {
        const onMsg = (r: OptimizeReply) => { if (r.index === i) { cleanup(); resolve(r) } }
        const onErr = (err: Error) => { cleanup(); reject(err) }
        const cleanup = () => { worker.off('message', onMsg); worker.off('error', onErr) }
        worker.on('message', onMsg)
        worker.on('error', onErr)
        const msg: OptimizeJob = { index: i, kind: job.kind, bytes: job.bytes }
        worker.postMessage(msg)
      })
      const next = reply.bytes ? new Uint8Array(reply.bytes) : null
      if (!next || next.length >= job.bytes.length) continue
      if (!samePixels(job.bytes, next)) continue
      out.push({ uri: job.uri, next: job.head + Buffer.from(next).toString('base64'), saved: job.bytes.length - next.length })
    }
    progress(jobs.length)
  } finally {
    void worker.terminate()
  }
  return out
}

export function registerPictureIpc(): void {
  handleFrom('app-shell', 'slidomingo:optimize-pictures', async (ev, uris: unknown) => {
    try { return await optimizeAll(ev, uris) } catch { return null }
  })
}
