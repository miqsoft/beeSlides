// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon-library folder sources in the desktop app (the pure half and the
// reasons: iconfolderscore.ts). A folder is picked through main's native
// dialog, its realpath is kept HERE (userData/icon-folders.json, keyed by
// source id, like attachedfolders.ts keeps chat folders) and main walks and
// serves it to every deck's window. The renderer learns the folder's name,
// never its path; nothing of it reaches a document or the
// `slidomingo-icon-sources` pref (sanitizeIconSourcesPref drops a `path`).
//
// A hidden instance (background.ts) reads the USER's icon-folders.json,
// read-only, at every request, so an agent searches the folders the person
// set up in the visible app. It never picks one (no dialog may wait there).
import { app, BrowserWindow, dialog } from 'electron'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { validateFolder } from './attachedfolders.ts'
import { isBackground, userDataFile } from './background.ts'
import { listIconFolder, pruneFolderPaths, readFolderMap, readIconFile, setFolderPath } from './iconfolderscore.ts'
import { isSourceId } from './icontokenscore.ts'
import { handleFrom } from './ipcguard.ts'

const FOLDERS_FILE = 'icon-folders.json'
/** Where this instance writes its folders. */
const foldersPath = (): string => join(app.getPath('userData'), FOLDERS_FILE)
/** Where a request looks a folder up: the user's file in a hidden instance. */
const lookupPath = (): string => (isBackground() ? userDataFile(FOLDERS_FILE) : foldersPath())

type Located = { ok: true; root: string } | { ok: false; reason: 'unset' | 'gone'; error: string }

/** Source `id`'s folder, re-validated now: still there, still a directory. */
function locate(id: unknown): Located {
  if (!isSourceId(id)) return { ok: false, reason: 'unset', error: 'bad source id' }
  const stored = readFolderMap(lookupPath())[id]
  if (!stored) return { ok: false, reason: 'unset', error: 'no folder is stored for this source' }
  const checked = validateFolder(stored)
  return checked.ok ? { ok: true, root: checked.path } : { ok: false, reason: 'gone', error: checked.error }
}

/** Changes when the source points at another folder, so a window can keep
 *  its listing until then. Not the path itself, which never goes to a page. */
const stampOf = (root: string): string => createHash('sha256').update(root).digest('hex').slice(0, 16)

/** Called with the ids still in the source list (sanitizeIconSourcesPref). */
export function pruneIconFolders(keep: readonly string[]): void {
  pruneFolderPaths(foldersPath(), keep)
}

export function registerIconFolderIpc(): void {
  handleFrom('app-shell', 'slidomingo:icon-folder-pick', async (ev, id: unknown) => {
    if (!isSourceId(id)) return { ok: false, error: 'bad source id' }
    if (isBackground()) return { ok: false, error: 'No folder can be picked here.' }
    const parent = BrowserWindow.fromWebContents(ev.sender)
    const opts: Electron.OpenDialogOptions = { title: 'Icon folder', buttonLabel: 'Use folder', properties: ['openDirectory'] }
    const picked = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true }
    const checked = validateFolder(picked.filePaths[0])
    if (!checked.ok) return { ok: false, error: checked.error }
    setFolderPath(foldersPath(), id, checked.path)
    return { ok: true, name: basename(checked.path) }
  })
  /** Per source: its folder's name and whether it is still there; null = none stored. */
  handleFrom('app-shell', 'slidomingo:icon-folder-status', (_ev, ids: unknown) => {
    const out: Record<string, { name: string; missing: boolean } | null> = {}
    if (!Array.isArray(ids)) return out
    const map = readFolderMap(lookupPath())
    for (const id of ids.slice(0, 50)) {
      if (!isSourceId(id)) continue
      out[id] = map[id] ? { name: basename(map[id]), missing: !validateFolder(map[id]).ok } : null
    }
    return out
  })
  /** The folder's icons and manifests; `unchanged` when the caller's stamp is current. */
  handleFrom('app-shell', 'slidomingo:icon-folder-list', async (_ev, id: unknown, stamp: unknown) => {
    const at = locate(id)
    if (!at.ok) return at
    const now = stampOf(at.root)
    if (stamp === now) return { ok: true, stamp: now, unchanged: true }
    return { ok: true, stamp: now, ...await listIconFolder(at.root) }
  })
  handleFrom('app-shell', 'slidomingo:icon-folder-read', async (_ev, id: unknown, rel: unknown) => {
    const at = locate(id)
    if (!at.ok) return at
    return readIconFile(at.root, rel)
  })
}
