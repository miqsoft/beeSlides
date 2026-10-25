// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon-library folders in the desktop app, the Electron-free half
// (iconfolders.ts binds it to userData and IPC). Pure node, so
// scripts/test-icon-folders.ts runs it as is.
//
// A browser keeps a folder source as a File System Access handle in
// IndexedDB. In the desktop app that storage is per deck (one partition per
// path), so a folder granted in one deck was missing in every other one and
// always missing in a hidden instance, where nobody can grant it again. So
// here MAIN keeps the folder's path, keyed by source id, in
// userData/icon-folders.json, and walks and serves it itself. The path
// never enters a page, a document or the `slidomingo-icon-sources` pref.
//
// What leaves this module is what the renderer's own folder walk produces
// (iconlibrary.ts): icon files by relative path, and the text of every
// `icons.json` with the folder it sits in. Matching and manifests stay in the
// renderer, one code path for both.
//
// Confinement: every path is realpath'd and must stay inside the realpath'd
// root, so a symlink or `..` can never leave the folder. Only icon files (and
// icons.json, read during the walk) are touched, each under a size cap.
import { readFileSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from './fsutil.ts'
import { isSourceId } from './icontokenscore.ts'

/** The extensions the renderer's folder walk takes (iconlibrary.ts ICON_EXTS). */
export const ICON_FILE_EXTS: ReadonlySet<string> = new Set(['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif'])
const MANIFEST = 'icons.json'
/** Same limits as the browser walk: depth 4 below the root, 4000 icons. */
const MAX_DEPTH = 4
const MAX_FILES = 4000
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_MANIFESTS = 64
/** One icon file; far more than any icon, small enough for one IPC reply. */
export const MAX_ICON_BYTES = 10 * 1024 * 1024
/** Directory entries looked at in one walk, so a huge tree with no icons in
 *  it still answers promptly. */
const MAX_ENTRIES = 50_000

// --- the store: source id → absolute folder path -------------------------------

export function readFolderMap(file: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [id, p] of Object.entries(parsed as Record<string, unknown>)) {
      if (isSourceId(id) && typeof p === 'string' && isAbsolute(p) && !p.includes('\0')) out[id] = p
    }
    return out
  } catch { return {} }
}

function writeFolderMap(file: string, map: Record<string, string>): void {
  try { writeFileAtomic(file, JSON.stringify(map, null, 2)) } catch { /* best effort */ }
}

/** Remembers `path` (already through validateFolder) for source `id`. */
export function setFolderPath(file: string, id: string, path: string): void {
  writeFolderMap(file, { ...readFolderMap(file), [id]: path })
}

/** Drops the folders of sources that are no longer in the list. */
export function pruneFolderPaths(file: string, keep: readonly string[]): void {
  const map = readFolderMap(file)
  let changed = false
  for (const id of Object.keys(map)) if (!keep.includes(id)) { delete map[id]; changed = true }
  if (changed) writeFolderMap(file, map)
}

// --- walking and serving ----------------------------------------------------------

/** True when `inner` is `outer` itself or below it (both realpath'd). */
export function inside(outer: string, inner: string): boolean {
  const rel = relative(outer, inner)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const extOf = (name: string): string => (name.split('.').pop() ?? '').toLowerCase()

export interface FolderListing {
  /** Icon files, relative to the root, `/`-separated. */
  files: string[]
  /** Every icons.json: the folder it sits in (relative, ending in `/`, or ''), and its text. */
  manifests: Array<{ prefix: string; text: string }>
}

/** Walks `root` (realpath'd) the way the renderer walks a folder handle. */
export async function listIconFolder(root: string): Promise<FolderListing> {
  const files: string[] = []
  const manifestPaths: Array<{ prefix: string; path: string }> = []
  let seen = 0
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (files.length >= MAX_FILES || ++seen > MAX_ENTRIES) return
      let full = join(dir, entry.name)
      let isFile = entry.isFile()
      let isDir = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        // followed only while it stays inside the folder
        try {
          full = await realpath(full)
          if (!inside(root, full)) continue
          const st = await stat(full)
          isFile = st.isFile()
          isDir = st.isDirectory()
        } catch { continue }
      }
      if (isFile) {
        if (ICON_FILE_EXTS.has(extOf(entry.name))) files.push(prefix + entry.name)
        else if (entry.name.toLowerCase() === MANIFEST && manifestPaths.length < MAX_MANIFESTS) manifestPaths.push({ prefix, path: full })
      } else if (isDir) {
        await walk(full, `${prefix}${entry.name}/`, depth + 1)
      }
    }
  }
  await walk(root, '', 0)
  const manifests: FolderListing['manifests'] = []
  for (const m of manifestPaths) {
    try {
      if ((await stat(m.path)).size > MAX_MANIFEST_BYTES) continue
      manifests.push({ prefix: m.prefix, text: await readFile(m.path, 'utf8') })
    } catch { /* an unreadable manifest is no manifest */ }
  }
  return { files, manifests }
}

/** One icon file of the folder, by the relative path a listing gave. */
export async function readIconFile(root: string, rel: unknown): Promise<{ ok: true; body: Uint8Array } | { ok: false; error: string }> {
  if (typeof rel !== 'string' || !rel || rel.length > 2000 || rel.includes('\0') || isAbsolute(rel)) return { ok: false, error: 'not a file of this folder' }
  if (!ICON_FILE_EXTS.has(extOf(rel))) return { ok: false, error: 'not an icon file' }
  const segs = rel.split('/')
  if (segs.some((s) => !s || s === '.' || s === '..' || s.includes('\\') || s.includes(sep))) return { ok: false, error: 'not a file of this folder' }
  let real: string
  try { real = await realpath(resolve(root, ...segs)) } catch { return { ok: false, error: 'that icon is gone' } }
  if (!inside(root, real) || real === root) return { ok: false, error: 'not a file of this folder' }
  // the target too (a link named .svg must not serve something else)
  if (!ICON_FILE_EXTS.has(extOf(real))) return { ok: false, error: 'not an icon file' }
  try {
    const st = await stat(real)
    if (!st.isFile()) return { ok: false, error: 'not a file' }
    if (st.size > MAX_ICON_BYTES) return { ok: false, error: 'that file is too large for an icon' }
    return { ok: true, body: new Uint8Array(await readFile(real)) }
  } catch { return { ok: false, error: 'that icon could not be read' } }
}
