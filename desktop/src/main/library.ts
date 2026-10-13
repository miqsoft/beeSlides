// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The global element library (docs/DECISIONS.md 2026-09-28, "Scope split:
// Layout Manager = this file; Library = global registry in the editor"). It
// belongs to the USER, not to a deck, so main owns where it lives: the
// renderer cannot remember anything app-wide, because every deck window gets
// its own session partition (windows.ts), and the browser build's
// IndexedDB-stored file handle would be a different "remembered library" in
// every deck.
//
// The default library sits next to the templates folder (Finder-visible, like
// the templates) and is created on first run, so a user has a library without
// picking a file. Choosing another file stores its path in app settings.
// Every read/write targets `libraryPath()` only — a renderer never names a
// destination. The file logic itself is electron-free in libraryfs.ts.
import { existsSync } from 'node:fs'
import { DOC_EXT, LEGACY_DOC_EXT } from '../../../kernel/src/docext.ts'
import { dialog, type IpcMainInvokeEvent } from 'electron'
import { handleFrom } from './ipcguard.ts'
import { basename, dirname, join, resolve } from 'node:path'
import { ensureLibraryAt, isLibraryCandidate, readLibraryAt, writeLibraryAt, type LibraryRead } from './libraryfs.ts'
import { readSettings, updateSettings } from './settings.ts'
import { templatesDir } from './templates.ts'
import { readAppShell, windowForDocWebContents } from './windows.ts'

// SLIDOMINGO_LIBRARY_PATH: E2E runs point this at a temp file so they never
// touch the user's real library. A library created before the BeeSlides
// rename keeps being used where it is; a new install gets the new name.
const LEGACY_LIBRARY = `Slidomingo Library${LEGACY_DOC_EXT}`
export const defaultLibraryPath = (): string => {
  if (process.env.SLIDOMINGO_LIBRARY_PATH) return process.env.SLIDOMINGO_LIBRARY_PATH
  const legacy = join(dirname(templatesDir()), LEGACY_LIBRARY)
  return existsSync(legacy) ? legacy : join(dirname(templatesDir()), `BeeSlides Library${DOC_EXT}`)
}

export function libraryPath(): string {
  return readSettings().libraryPath || defaultLibraryPath()
}

const isDefault = (path: string): boolean => resolve(path) === resolve(defaultLibraryPath())

/** Creates the default library when it is the one in use and missing. A
 *  chosen file that has gone is never recreated behind the user's back. */
export function ensureDefaultLibrary(): void {
  const path = libraryPath()
  if (!isDefault(path)) return
  try { ensureLibraryAt(path, readAppShell()) } catch (err) { logError('[library] create default failed:', err) }
}

export type LibraryInfo = LibraryRead & { isDefault: boolean }

export function readLibrary(): LibraryInfo {
  ensureDefaultLibrary()
  const path = libraryPath()
  return { ...readLibraryAt(path), isDefault: isDefault(path) }
}

/** Native Open dialog; the picked slides file becomes the library. */
export async function chooseLibrary(webContentsId?: number): Promise<{ path: string; name: string } | null> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Choose a library file',
    properties: ['openFile'],
    filters: [{ name: 'BeeSlides deck', extensions: ['html'] }],
  }
  const win = webContentsId != null ? windowForDocWebContents(webContentsId) : null
  const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  const path = canceled ? null : filePaths[0]
  if (!path || !isLibraryCandidate(path)) return null
  updateSettings({ libraryPath: isDefault(path) ? undefined : path })
  return { path, name: basename(path) }
}

/** Back to the default library (created if missing). */
export function useDefaultLibrary(): boolean {
  updateSettings({ libraryPath: undefined })
  ensureDefaultLibrary()
  return true
}

/** Guarded log — a bare console write can crash main (desktop/CLAUDE.md). */
function logError(msg: string, err: unknown): void {
  try { console.error(msg, err) } catch { /* pipe gone */ }
}

/** `ipcMain.handle` whose promise never rejects (desktop/CLAUDE.md). */
function safeHandle<T>(channel: string, fallback: T, fn: (ev: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>): void {
  handleFrom('app-shell', channel, async (ev, ...args) => {
    try { return await fn(ev, ...args) } catch (err) { logError(`[ipc] ${channel} failed:`, err); return fallback }
  })
}

/** Every library IPC channel, plus the first-run default. Called once from
 *  index.ts at app ready. */
export function registerLibraryIpc(): void {
  ensureDefaultLibrary()
  const failed: LibraryInfo = { ok: false, path: '', name: '', reason: 'unreadable', isDefault: false }
  safeHandle<LibraryInfo>('slidomingo:library-read', failed, () => readLibrary())
  safeHandle('slidomingo:library-write', false, (_ev, html: unknown) => writeLibraryAt(libraryPath(), html))
  safeHandle<{ path: string; name: string } | null>('slidomingo:library-choose', null, (ev) => chooseLibrary(ev.sender.id))
  safeHandle('slidomingo:library-use-default', false, () => useDefaultLibrary())
}
