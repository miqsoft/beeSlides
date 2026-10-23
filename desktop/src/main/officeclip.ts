// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Copy special ▸ PowerPoint: ONE clipboard write carrying PowerPoint's own
// drawing package (kernel/src/convert/gvml.ts, built in the renderer) plus a
// PNG for every other app. PowerPoint takes the package even with the PNG
// beside it and pastes native, editable shapes (checked by hand 2026-10-23).
//
// Electron's clipboard replaces everything on each write and cannot put a
// custom type next to an image, so on macOS the write goes through
// NSPasteboard from osascript (JXA), the bytes passed as temp files. Windows
// gets the package alone through clipboard.writeBuffer under its registered
// name ("Art::GVML ClipFormat"; not yet tried against PowerPoint for
// Windows). Linux has no PowerPoint: refused.

import { clipboard } from 'electron'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleFrom } from './ipcguard.ts'

export interface OfficeClipReq { gvml: Uint8Array; png?: Uint8Array }
export type OfficeClipResult = { ok: true } | { refused: true; error: string }

const MAX_BYTES = 64 * 1024 * 1024
const MAC_TYPE = 'com.microsoft.Art--GVML-ClipFormat'
const WIN_TYPE = 'Art::GVML ClipFormat'

const JXA = `ObjC.import('AppKit')
function run(argv) {
  var gvml = $.NSData.dataWithContentsOfFile(argv[0])
  if (gvml.isNil()) return 'no-data'
  var pb = $.NSPasteboard.generalPasteboard
  pb.clearContents
  pb.setDataForType(gvml, '${MAC_TYPE}')
  if (argv.length > 1) {
    var png = $.NSData.dataWithContentsOfFile(argv[1])
    if (!png.isNil()) pb.setDataForType(png, 'public.png')
  }
  return 'ok'
}`

/** The request when both payloads are what they claim to be (a zip, a PNG), else null. */
export function checkOfficeClip(req: unknown): OfficeClipReq | null {
  if (!req || typeof req !== 'object') return null
  const { gvml, png } = req as { gvml?: unknown; png?: unknown }
  if (!(gvml instanceof Uint8Array) || gvml.length < 30 || gvml.length > MAX_BYTES) return null
  if (gvml[0] !== 0x50 || gvml[1] !== 0x4b || gvml[2] !== 0x03 || gvml[3] !== 0x04) return null
  if (png === undefined) return { gvml }
  if (!(png instanceof Uint8Array) || png.length < 8 || png.length > MAX_BYTES) return null
  if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return null
  return { gvml, png }
}

async function writeMac(req: OfficeClipReq): Promise<OfficeClipResult> {
  const dir = mkdtempSync(join(tmpdir(), 'slidomingo-clip-'))
  try {
    const gvmlPath = join(dir, 'drawing.zip')
    writeFileSync(gvmlPath, req.gvml)
    const args = ['-l', 'JavaScript', '-e', JXA, gvmlPath]
    if (req.png) {
      const pngPath = join(dir, 'picture.png')
      writeFileSync(pngPath, req.png)
      args.push(pngPath)
    }
    const out = await new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/osascript', args, { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())))
    })
    return out === 'ok' ? { ok: true } : { refused: true, error: out || 'clipboard write failed' }
  } catch (err) {
    return { refused: true, error: err instanceof Error ? err.message : String(err) }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir */ }
  }
}

export async function writeOfficeClipboard(req: OfficeClipReq): Promise<OfficeClipResult> {
  if (process.platform === 'darwin') return writeMac(req)
  if (process.platform === 'win32') {
    try {
      clipboard.writeBuffer(WIN_TYPE, Buffer.from(req.gvml))
      return { ok: true }
    } catch (err) {
      return { refused: true, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { refused: true, error: 'unsupported-platform' }
}

export function registerOfficeClipIpc(): void {
  handleFrom('app-shell', 'slidomingo:copy-office', async (_ev, req: unknown): Promise<OfficeClipResult> => {
    const ok = checkOfficeClip(req)
    if (!ok) return { refused: true, error: 'bad-request' }
    return writeOfficeClipboard(ok)
  })
}
