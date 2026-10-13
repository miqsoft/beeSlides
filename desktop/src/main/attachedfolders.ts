// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Folders the user attached to a deck's AI chats (beyond the deck's own
// folder), so `claude` (`--add-dir`) and the API chat's read-only file tools
// can reach them. Parameterised by path so it runs without electron
// (scripts/test-desktop-attachedfolders.ts); terminalPanel.ts binds it to
// userData/attached-folders.json.
//
// This is LOCAL METADATA, like chat history: a deck is matched by its docId
// (survives rename/move/Save As) and, until one is known, by its bound path.
// Nothing here is ever written next to or into a deck — absolute paths of the
// user's disk must not travel with a file people share (docs/DECISIONS.md,
// "Attached folders"). Paths only ever come from a native folder dialog in
// main, never from a renderer string, and are re-validated here.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { writeFileAtomic } from './fsutil.ts'
import type { DeckKey } from './chathistory.ts'

/** Attached folders per deck. A handful is plenty; each one is one more
 *  `--add-dir` and one more root for the file tools to walk. */
export const MAX_FOLDERS = 8

interface DeckFolders { docId: string | null; path: string | null; folders: string[] }

function load(storePath: string): DeckFolders[] {
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'))
    const list: unknown[] = Array.isArray(parsed?.decks) ? parsed.decks : []
    return list.filter((d): d is DeckFolders => {
      const r = d as DeckFolders
      return !!r && Array.isArray(r.folders) && r.folders.every((f) => typeof f === 'string')
    })
  } catch {
    return []
  }
}

function save(storePath: string, decks: DeckFolders[]): void {
  try { writeFileAtomic(storePath, JSON.stringify({ version: 1, decks: decks.filter((d) => d.folders.length > 0) }, null, 2)) } catch { /* best effort */ }
}

/** Same identity rule as chathistory.ts: the docId when both sides have one,
 *  else the bound path. */
function matches(r: DeckFolders, key: DeckKey): boolean {
  if (key.docId && r.docId) return r.docId === key.docId
  return !!key.path && r.path === key.path
}

/** True when `inner` is `outer` or inside it. */
function covers(outer: string, inner: string): boolean {
  const rel = relative(outer, inner)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** A path from a folder dialog, made safe to hand to `claude`: an existing
 *  directory, symlinks resolved (so the stored path is the real one), never
 *  the filesystem root. */
export function validateFolder(raw: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || !isAbsolute(raw)) return { ok: false, error: 'That is not a folder path.' }
  let real: string
  try {
    real = realpathSync(resolve(raw))
    if (!statSync(real).isDirectory()) return { ok: false, error: 'That is not a folder.' }
  } catch {
    return { ok: false, error: 'That folder does not exist.' }
  }
  if (dirname(real) === real) return { ok: false, error: 'The whole disk cannot be attached; pick a folder.' }
  return { ok: true, path: real }
}

/** The deck's attached folders, in the order they were added. */
export function listFolders(storePath: string, key: DeckKey): string[] {
  return load(storePath).find((d) => matches(d, key))?.folders ?? []
}

/** Attaches `folder` (already through validateFolder). One already inside an
 *  attached folder is a no-op; attaching a parent absorbs its children.
 *  Returns the new list, or an error when the limit is reached. */
export function addFolder(storePath: string, key: DeckKey, folder: string): { ok: true; folders: string[] } | { ok: false; error: string } {
  if (!key.docId && !key.path) return { ok: false, error: 'Save the deck first.' }
  const decks = load(storePath)
  let rec = decks.find((d) => matches(d, key))
  if (!rec) { rec = { docId: key.docId, path: key.path, folders: [] }; decks.push(rec) }
  if (rec.folders.some((f) => covers(f, folder))) return { ok: true, folders: rec.folders }
  const kept = rec.folders.filter((f) => !covers(folder, f))
  if (kept.length >= MAX_FOLDERS) return { ok: false, error: `At most ${MAX_FOLDERS} folders can be attached.` }
  rec.folders = [...kept, folder]
  if (key.docId) rec.docId = key.docId
  if (key.path) rec.path = key.path
  save(storePath, decks)
  return { ok: true, folders: rec.folders }
}

export function removeFolder(storePath: string, key: DeckKey, folder: string): string[] {
  const decks = load(storePath)
  const rec = decks.find((d) => matches(d, key))
  if (!rec) return []
  rec.folders = rec.folders.filter((f) => f !== folder)
  save(storePath, decks)
  return rec.folders
}

/** The deck in a window got a docId or a new path (Save As, a rename, a
 *  generated deck loaded): its folders follow it. */
export function retargetFolders(storePath: string, key: DeckKey): void {
  if (!key.docId && !key.path) return
  const decks = load(storePath)
  const rec = decks.find((d) => matches(d, key))
  if (!rec) return
  if ((key.docId && rec.docId !== key.docId) || (key.path && rec.path !== key.path)) {
    if (key.docId) rec.docId = key.docId
    if (key.path) rec.path = key.path
    save(storePath, decks)
  }
}

/** The ones that still exist: what a session is launched with. A folder that
 *  was moved or unmounted stays in the list (the panel shows it as missing)
 *  but is never passed on. */
export function existingFolders(folders: string[]): string[] {
  return folders.filter((f) => { try { return statSync(f).isDirectory() } catch { return false } })
}
