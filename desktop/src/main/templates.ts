// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The template gallery's folder IS its registry — no JSON index to keep in
// sync. That is deliberate: it is what makes both "drop a file in manually"
// and "have Claude Code write one" work with zero new plumbing. Lives under
// Documents (Finder/Explorer-visible), not the hidden userData dir
// recent.ts uses — a hidden app-data folder would defeat the manual path.
//
// Renderer access goes through `registerTemplateIpc()` (bottom of this file):
// metadata listing, on-demand load of ONE template, update/rename/reveal,
// a confirmed delete, and Edit Template (a template window bound to the file). The folder logic itself is electron-free in
// templatefs.ts so scripts/test-templates.ts can exercise it.
import { DOC_EXT, hasDocExt } from '../../../kernel/src/docext.ts'
import { app, dialog, shell, type IpcMainInvokeEvent } from 'electron'
import { handleFrom, onFrom } from './ipcguard.ts'
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { extractDocBlock } from './docfile.ts'
import { writeFileAtomic } from './fsutil.ts'
import {
  isTemplatePath, listTemplateMetaIn, loadTemplateIn, renameTemplateIn, resolveDefaultTemplate, sanitizeBaseName,
  templateNameFromPath, updateTemplateIn, type TemplateMeta,
} from './templatefs.ts'
import { readSettings, updateSettings } from './settings.ts'
import { createDocumentWindow, rebindPath, replaceDocument, windowForDocWebContents } from './windows.ts'

export interface TemplateFile {
  path: string
  json: unknown
}

// SLIDOMINGO_TEMPLATES_DIR: E2E runs point this at a temp folder so they never
// touch the user's real gallery.
// A templates folder created before the BeeSlides rename keeps being used where
// it is (its templates must not vanish); a new install gets the new name.
export const templatesDir = (): string => {
  if (process.env.SLIDOMINGO_TEMPLATES_DIR) return process.env.SLIDOMINGO_TEMPLATES_DIR
  const legacy = join(app.getPath('documents'), 'Slidomingo Templates')
  return existsSync(legacy) ? legacy : join(app.getPath('documents'), 'BeeSlides Templates')
}

export function ensureTemplatesDir(): void {
  mkdirSync(templatesDir(), { recursive: true })
}

/** Scans the templates folder for `*.beeslides.html` (and legacy `*.slidomingo.html`) files, parsing and
 *  validating each. One bad/corrupt file is skipped, never breaks the
 *  gallery. LEGACY: ships every template's full JSON (media included) —
 *  kept for the current start picker until its rewrite moves to
 *  `listTemplateMeta` + `loadTemplate`. */
export function listTemplateFiles(): TemplateFile[] {
  ensureTemplatesDir()
  const dir = templatesDir()
  const out: TemplateFile[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    if (!hasDocExt(name)) continue
    try {
      const html = readFileSync(join(dir, name), 'utf8')
      const json = extractDocBlock(html)
      if (json) out.push({ path: join(dir, name), json })
    } catch {
      /* skip unreadable/corrupt file */
    }
  }
  return out
}

/** Writes `html` into the templates folder, de-duping the filename against
 *  whatever is already there (`Foo.beeslides.html`, `Foo 2.beeslides.html`, …) —
 *  never silently overwrites. Returns the path actually written, or `null`
 *  if the write failed (disk full, permissions, …). Never throws: this runs
 *  inside an `ipcMain.handle` callback, and letting a disk-write error
 *  reject that promise hits the same landmine as terminalPanel.ts's
 *  `openPanel` — Electron's own internal error-reporting path logs the
 *  rejection via `console.warn`, and that write itself can die with EIO in
 *  some environments, crashing the whole main process over what should be a
 *  recoverable, best-effort failure. */
export function saveTemplateFile(html: string, suggestedBaseName: string): string | null {
  try {
    ensureTemplatesDir()
    const dir = templatesDir()
    const base = sanitizeBaseName(suggestedBaseName) || 'Untitled'
    let name = `${base}${DOC_EXT}`
    let n = 2
    while (existsSync(join(dir, name))) {
      name = `${base} ${n}${DOC_EXT}`
      n++
    }
    const path = join(dir, name)
    writeFileAtomic(path, html)
    return path
  } catch (err) {
    logError('[templates] saveTemplateFile failed:', err)
    return null
  }
}

/** Metadata of every template — no document JSON crosses IPC. Cached per
 *  (path, mtime), see templatefs.ts. */
export function listTemplateMeta(): TemplateMeta[] {
  ensureTemplatesDir()
  return listTemplateMetaIn(templatesDir())
}

/** One template's raw doc-block JSON text; `null` outside the folder. */
export function loadTemplate(path: string): string | null {
  return loadTemplateIn(templatesDir(), path)
}

/** Overwrites an existing template (atomic, shell- and template-checked). */
export function updateTemplate(path: string, html: string): boolean {
  return updateTemplateIn(templatesDir(), path, html)
}

/** Renames a template file; never overwrites. New path, or `null`. The
 *  default template follows the rename (it resolves by id anyway; this keeps
 *  a legacy, id-less default too). */
export function renameTemplate(path: string, newBase: string): string | null {
  const next = renameTemplateIn(templatesDir(), path, newBase)
  const stored = readSettings().defaultTemplate
  if (next && stored && stored.path === path) updateSettings({ defaultTemplate: { ...stored, path: next } })
  // A template window bound to it (Edit Template) follows the file, so its
  // next save lands under the new name instead of recreating the old one.
  if (next && next !== path) rebindPath(path, next)
  return next
}

/** Edit Template: bind the template file itself in a template window
 *  (windows.ts `editTemplate`) — in a new window by default, so the deck the
 *  user came from stays open beside it; `replace` shows it in the caller's
 *  window instead (the start page, File ▸ New Layout…). A template already
 *  open for editing just focuses its window. `false` outside the folder. */
export function editTemplate(path: unknown, opts: { replace?: boolean } = {}, webContentsId?: number): boolean {
  if (!isTemplatePath(templatesDir(), path) || !existsSync(path)) return false
  const win = opts.replace && webContentsId != null ? windowForDocWebContents(webContentsId) : null
  if (win) replaceDocument(win, path, { editTemplate: true }).catch((err) => logError('[templates] edit-template failed:', err))
  else createDocumentWindow(path, { editTemplate: true })
  return true
}

/** The start page's default template (settings.ts), resolved against the
 *  folder as it is now — `null` when none is set or it is gone. */
export function getDefaultTemplate(): TemplateMeta | null {
  const stored = readSettings().defaultTemplate
  const meta = resolveDefaultTemplate(listTemplateMeta(), stored)
  if (meta && stored && meta.path !== stored.path) updateSettings({ defaultTemplate: { templateId: meta.templateId, path: meta.path } })
  return meta
}

/** Make the template at `path` the default (`null` = none). `false` when
 *  `path` is not a readable template in the folder. */
export function setDefaultTemplate(path: string | null): boolean {
  if (path === null) { updateSettings({ defaultTemplate: undefined }); return true }
  if (!isTemplatePath(templatesDir(), path)) return false
  const meta = listTemplateMeta().find((m) => m.path === path)
  if (!meta) return false
  updateSettings({ defaultTemplate: { templateId: meta.templateId, path: meta.path } })
  return true
}

/** Shows one template file in Finder/Explorer. */
export function revealTemplate(path: string): boolean {
  if (!isTemplatePath(templatesDir(), path) || !existsSync(path)) return false
  shell.showItemInFolder(path)
  return true
}

/** Moves one template to the Trash — refuses anything outside the templates
 *  folder. No confirmation: `confirmDeleteTemplate` is the user-facing path. */
export async function deleteTemplateFile(path: string): Promise<boolean> {
  if (!isTemplatePath(templatesDir(), path) || !existsSync(path)) return false
  await shell.trashItem(path)
  return true
}

/** Asks first (native dialog, attached to the calling window), then moves
 *  the template to the Trash. `false` when cancelled or refused. */
export async function confirmDeleteTemplate(path: string, webContentsId?: number): Promise<boolean> {
  if (!isTemplatePath(templatesDir(), path) || !existsSync(path)) return false
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Move to Trash', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Delete the layout “${templateNameFromPath(path)}”?`,
    detail: 'The file is moved to the Trash. Decks already started from it are not affected.',
  }
  const win = webContentsId != null ? windowForDocWebContents(webContentsId) : null
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  if (response !== 0) return false
  return deleteTemplateFile(path)
}

export function openTemplatesFolder(): void {
  ensureTemplatesDir()
  void shell.openPath(templatesDir())
}

/** Guarded log — a bare console write can crash main (desktop/CLAUDE.md). */
function logError(msg: string, err: unknown): void {
  try { console.error(msg, err) } catch { /* pipe gone */ }
}

/** `ipcMain.handle` whose promise can never reject (a rejection is logged by
 *  Electron via console.warn, which can itself die with EIO/EPIPE and take
 *  the process down — desktop/CLAUDE.md). A failure resolves to `fallback`,
 *  typed like a real answer so renderer callers never see `undefined`. */
function safeHandle<T>(
  channel: string,
  fallback: T,
  fn: (ev: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>,
): void {
  handleFrom('app-shell', channel, async (ev, ...args) => {
    try {
      return await fn(ev, ...args)
    } catch (err) {
      logError(`[ipc] ${channel} failed:`, err)
      return fallback
    }
  })
}

/** Every template IPC channel. Called once from index.ts at app ready. */
export function registerTemplateIpc(): void {
  // Legacy: full JSON of every template (the current start picker).
  safeHandle<Array<{ path: string; json: unknown }>>('slidomingo:list-templates', [], () => listTemplateFiles())
  safeHandle<string | null>('slidomingo:save-template', null,
    (_ev, { html, suggestedBaseName }: { html: string; suggestedBaseName: string }) => saveTemplateFile(html, suggestedBaseName))
  safeHandle('slidomingo:delete-template', false, (ev, path: string) => confirmDeleteTemplate(path, ev.sender.id))
  onFrom('app-shell', 'slidomingo:open-templates-folder', () => {
    try { openTemplatesFolder() } catch (err) { logError('[templates] open folder failed:', err) }
  })

  // Metadata-first registry (docs/DECISIONS.md 2026-09-24).
  safeHandle<TemplateMeta[]>('slidomingo:list-template-meta', [], () => listTemplateMeta())
  safeHandle<string | null>('slidomingo:load-template', null, (_ev, path: string) => loadTemplate(path))
  safeHandle('slidomingo:update-template', false, (_ev, { path, html }: { path: string; html: string }) => updateTemplate(path, html))
  safeHandle<string | null>('slidomingo:rename-template', null,
    (_ev, { path, newBase }: { path: string; newBase: string }) => renameTemplate(path, newBase))
  safeHandle('slidomingo:reveal-template', false, (_ev, path: string) => revealTemplate(path))
  // Answers before the open is done: `replace` closes the caller's renderer.
  safeHandle('slidomingo:edit-template', false, (ev, path: unknown, opts?: { replace?: boolean }) =>
    editTemplate(path, { replace: !!opts?.replace }, ev.sender.id))
  safeHandle<TemplateMeta | null>('slidomingo:get-default-template', null, () => getDefaultTemplate())
  safeHandle('slidomingo:set-default-template', false, (_ev, path: unknown) =>
    setDefaultTemplate(typeof path === 'string' ? path : null))
}
