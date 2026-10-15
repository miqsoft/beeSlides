// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Figure mode's file export (docs/DECISIONS.md, "Figure mode"). The renderer
// builds the finished artifact (an SVG string) or a self-contained HTML page
// of the figure at 1:1; main shows the native Save dialog and writes it. For
// PDF, main prints that page in a hidden window at the figure's exact size —
// Chromium keeps text as embedded fonts and SVG as vector paths.

import { BrowserWindow, app, dialog } from 'electron'
import { handleFrom } from './ipcguard.ts'
import type { IpcMainInvokeEvent } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { writeFileAtomic } from './fsutil.ts'
import { windowForDocWebContents } from './windows.ts'

export type FigureExportReq =
  | { kind: 'svg'; svg: string; suggestedName: string }
  | { kind: 'pdf'; html: string; widthPx: number; heightPx: number; suggestedName: string }
export type FigureExportResult = { ok: true; path: string } | { cancelled: true } | { error: string }

async function printPdf(html: string, widthPx: number, heightPx: number): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'slidomingo-figure-'))
  const file = join(dir, 'figure.html')
  writeFileSync(file, html)
  const win = new BrowserWindow({
    show: false, width: Math.ceil(widthPx), height: Math.ceil(heightPx),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: false },
  })
  try {
    await win.loadFile(file)
    // images and embedded fonts must be ready before the page is printed
    await win.webContents.executeJavaScript(
      `Promise.all([document.fonts.ready, ...Array.from(document.images).map(i => i.decode().catch(() => {}))]).then(() => true)`,
    )
    return await win.webContents.printToPDF({
      pageSize: { width: widthPx / 96, height: heightPx / 96 },
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      printBackground: true,
      preferCSSPageSize: true,
    })
  } finally {
    win.destroy()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir */ }
  }
}

async function exportFigure(ev: IpcMainInvokeEvent, req: FigureExportReq): Promise<FigureExportResult> {
  const win = windowForDocWebContents(ev.sender.id)
  if (!win) return { error: 'no-window' }
  const ext = req.kind
  const stem = basename(req.suggestedName || 'figure').replace(/\.(svg|pdf)$/i, '')
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: join(app.getPath('documents'), `${stem}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  })
  if (canceled || !filePath) return { cancelled: true }
  const target = new RegExp(`\\.${ext}$`, 'i').test(filePath) ? filePath : `${filePath}.${ext}`
  try {
    writeFileAtomic(target, req.kind === 'svg' ? req.svg : await printPdf(req.html, req.widthPx, req.heightPx))
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, path: target }
}

// ---- icon sets ----------------------------------------------------------------
//
// "Export set…" (slides/src/editor/iconsetexport.ts): the renderer builds every
// file (one SVG per icon, icons.json, LICENSE.txt); main asks for a folder and
// writes them into a subfolder named after the set. Names are checked here, so
// a page can only ever write those three kinds of file, inside that subfolder.

export interface IconsetExportReq { folderName: string; files: Array<{ name: string; text: string }> }

const ICONSET_FILE_RE = /^(?:[a-z0-9][a-z0-9-]{0,80}\.svg|icons\.json|LICENSE\.txt)$/
const MAX_ICONSET_FILES = 5000
const MAX_ICONSET_BYTES = 64 * 1024 * 1024

/** The request's files when every name and size is acceptable, else null. */
export function checkIconsetFiles(req: unknown): Array<{ name: string; text: string }> | null {
  if (!req || typeof req !== 'object') return null
  const files = (req as { files?: unknown }).files
  if (!Array.isArray(files) || !files.length || files.length > MAX_ICONSET_FILES) return null
  const seen = new Set<string>()
  let total = 0
  for (const f of files) {
    if (!f || typeof f !== 'object') return null
    const { name, text } = f as { name?: unknown; text?: unknown }
    if (typeof name !== 'string' || !ICONSET_FILE_RE.test(name) || seen.has(name)) return null
    if (typeof text !== 'string') return null
    total += text.length
    if (total > MAX_ICONSET_BYTES) return null
    seen.add(name)
  }
  return files as Array<{ name: string; text: string }>
}

/** A folder name made from a set's title: no separators, dots or control bytes. */
export function iconsetFolderName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : ''
  const clean = s.replace(/[\p{Cc}\\/:*?"<>|]+/gu, '-').replace(/^[.\s-]+|[.\s]+$/g, '').slice(0, 80)
  return clean || 'icons'
}

async function exportIconset(ev: IpcMainInvokeEvent, req: IconsetExportReq): Promise<FigureExportResult> {
  const win = windowForDocWebContents(ev.sender.id)
  if (!win) return { error: 'no-window' }
  const files = checkIconsetFiles(req)
  if (!files) return { error: 'bad request' }
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (canceled || !filePaths[0]) return { cancelled: true }
  const target = join(filePaths[0], iconsetFolderName(req.folderName))
  try {
    mkdirSync(target, { recursive: true })
    for (const f of files) writeFileAtomic(join(target, f.name), f.text)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, path: target }
}

export function registerFigureIpc(): void {
  handleFrom('app-shell', 'slidomingo:export-iconset', async (ev, req: IconsetExportReq) => {
    try { return await exportIconset(ev, req) } catch (err) { return { error: err instanceof Error ? err.message : String(err) } }
  })
  handleFrom('app-shell', 'slidomingo:export-figure', async (ev, req: FigureExportReq) => {
    try { return await exportFigure(ev, req) } catch (err) { return { error: err instanceof Error ? err.message : String(err) } }
  })
}
