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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

export function registerFigureIpc(): void {
  handleFrom('app-shell', 'slidomingo:export-figure', async (ev, req: FigureExportReq) => {
    try { return await exportFigure(ev, req) } catch (err) { return { error: err instanceof Error ? err.message : String(err) } }
  })
}
