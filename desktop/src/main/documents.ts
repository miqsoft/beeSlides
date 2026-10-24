// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Document IPC: the main process reads and writes deck bytes on the
// renderer's behalf (docs/DECISIONS.md, 2026-09-24). Every write goes ONLY to
// the sender's bound path (windows.ts `Binding`) — a renderer can never name
// an arbitrary destination except through a native Save dialog the user
// answered.
//
// Handlers never reject (see index.ts's safeHandle and desktop/CLAUDE.md on
// the console EIO/EPIPE landmine): failures come back as values.
import { isBackground } from './background.ts'
import { DOC_EXT, hasDocExt } from '../../../kernel/src/docext.ts'
import { BrowserWindow, app, dialog, shell, type IpcMainInvokeEvent } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  bindingFor, createDocumentWindow, draftsDir, dropPartition, goHome, hashPath, noteDocState, openBoundPaths, openPathsFrom,
  openSeededInWindow, readAppShell, readExampleDeck, readViewerShell, rebind, setWriting, launchTextFor, dropSeed, takeAnnounce, takeStartIntent, windowForDocWebContents,
} from './windows.ts'
import { backupsToPrune, decideWrite, extractDocBlockText, docKindOfText, isInside, isTemplateHtml, looksLikeShell, rawDocBlockText, readTitle } from './docfile.ts'
import { writeFileAtomic } from './fsutil.ts'
import { addRecent } from './recent.ts'
import { handleFrom, onFrom } from './ipcguard.ts'

const backupsRoot = (): string => join(app.getPath('userData'), 'Backups')

export type WriteResult =
  | { ok: true; mtimeMs: number }
  | { conflict: true; mtimeMs: number }
  | { missing: true }
  | { error: string }

function log(...args: unknown[]): void {
  try { console.error('[documents]', ...args) } catch { /* pipe gone */ }
}

function handle<T>(channel: string, fn: (ev: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>, fallback: T): void {
  handleFrom('app-shell', channel, async (ev, ...args) => {
    try { return await fn(ev, ...args) } catch (err) { log(channel, err); return fallback }
  })
}

/**
 * Before the FIRST write of a session over an existing file, keep a copy of
 * the bytes as they were — the safety net for A0 (every open now re-saves
 * into the current shell, so a serialization bug would otherwise land in the
 * user's only copy). Works for encrypted decks too: the copy is the file's
 * bytes, never plaintext. Five per file, none older than 30 days.
 */
function backupBeforeFirstWrite(path: string): void {
  if (!existsSync(path)) return
  const dir = join(backupsRoot(), hashPath(path))
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(path, join(dir, `${stamp}${DOC_EXT}`))
  try { writeFileSync(join(dir, 'source.json'), JSON.stringify({ path }), 'utf8') } catch { /* label only */ }
  const entries = readdirSync(dir).filter((n) => hasDocExt(n))
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
  for (const name of backupsToPrune(entries, Date.now())) {
    try { rmSync(join(dir, name), { force: true }) } catch { /* next time */ }
  }
}

/** Age out every document's backups (launch housekeeping). */
export function pruneAllBackups(): void {
  let dirs: string[] = []
  try { dirs = readdirSync(backupsRoot()) } catch { return }
  for (const d of dirs) {
    const dir = join(backupsRoot(), d)
    try {
      const entries = readdirSync(dir).filter((n) => hasDocExt(n))
        .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
      for (const name of backupsToPrune(entries, Date.now())) rmSync(join(dir, name), { force: true })
      if (!readdirSync(dir).some((n) => hasDocExt(n))) rmSync(dir, { recursive: true, force: true })
    } catch { /* best effort */ }
  }
}

/** Write `html` to the sender's bound file. */
function writeDocument(ev: IpcMainInvokeEvent, html: string, opts?: { force?: boolean }): WriteResult {
  const b = bindingFor(ev.sender.id)
  if (!b) return { error: 'unbound' }
  if (!looksLikeShell(html)) return { error: 'not-a-shell' }
  // A template window writes templates only (docfile.ts isTemplateHtml) — a
  // renderer bug must never turn a template file into a deck.
  if (b.role === 'template' && !isTemplateHtml(html)) return { error: 'not-a-template' }
  let current: { mtimeMs: number } | null = null
  try { current = statSync(b.path) } catch { /* missing */ }
  const decision = opts?.force && current ? 'ok' : decideWrite(b.knownMtime, current)
  if (decision === 'conflict') return { conflict: true, mtimeMs: current!.mtimeMs }
  if (decision === 'missing') return { missing: true }
  setWriting(ev.sender.id, true)
  try {
    if (!b.wroteThisSession && b.kind === 'file') {
      try { backupBeforeFirstWrite(b.path) } catch (err) { log('backup failed', err) }
    }
    mkdirSync(dirname(b.path), { recursive: true })
    writeFileAtomic(b.path, html)
    const mtimeMs = statSync(b.path).mtimeMs
    b.knownMtime = mtimeMs
    b.wroteThisSession = true
    dropSeed(ev.sender.id)
    return { ok: true, mtimeMs }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    setWriting(ev.sender.id, false)
  }
}

/** `Foo.html`, `Foo.beeslides` or `Foo` → `Foo.beeslides.html`; a name that
 *  already ends in either document extension is kept as it is. */
function withDeckSuffix(path: string): string {
  if (hasDocExt(path)) return path
  return path.replace(/\.(?:beeslides|slidomingo)$/i, '').replace(/\.html?$/i, '') + DOC_EXT
}

type SaveAsResult = { ok: true; path: string; name: string } | { cancelled: true } | { error: string }

/** The renderer's translations for the replace box (main has no catalog);
 *  English when missing. `{name}` in `replaceMessage` is the file name. */
type SaveAsStrings = Partial<Record<'replaceMessage' | 'replaceDetail' | 'replace' | 'cancel', string>>

function saveAsStrings(raw: unknown): SaveAsStrings {
  const out: SaveAsStrings = {}
  if (!raw || typeof raw !== 'object') return out
  for (const k of ['replaceMessage', 'replaceDetail', 'replace', 'cancel'] as const) {
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v === 'string' && v.length > 0 && v.length <= 400) out[k] = v
  }
  return out
}

/**
 * Native Save dialog, then write. `move` rebinds this window to the new file
 * (and deletes its draft); `copy` leaves the window on its current file.
 */
async function saveDocumentAs(
  ev: IpcMainInvokeEvent,
  req: { html: string; suggestedName: string; mode: 'move' | 'copy'; strings?: unknown },
): Promise<SaveAsResult> {
  const win = windowForDocWebContents(ev.sender.id)
  if (!win) return { error: 'no-window' }
  if (!looksLikeShell(req.html)) return { error: 'not-a-shell' }
  const b = bindingFor(ev.sender.id)
  const defaultDir = b?.kind === 'file' ? dirname(b.path) : app.getPath('documents')
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: join(defaultDir, withDeckSuffix(basename(req.suggestedName || 'Untitled'))),
    filters: [{ name: 'BeeSlides deck', extensions: ['html'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  })
  if (canceled || !filePath) return { cancelled: true }
  const target = resolve(withDeckSuffix(filePath))
  if (isInside(target, draftsDir())) return { error: 'drafts-folder' }
  if (openBoundPaths().has(target) && resolve(b?.path ?? '') !== target) return { error: 'open-elsewhere' }
  // The panel's overwrite check covered the name it returned, not the one we
  // write: typing `Report` comes back as `Report.html` (no such file, no
  // prompt) and is written as `Report.beeslides.html` — which may be an
  // existing deck. Ask here instead of overwriting it silently.
  if (target !== resolve(filePath) && existsSync(target)) {
    const s = saveAsStrings(req.strings)
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: (s.replaceMessage ?? '“{name}” already exists. Replace it?').replaceAll('{name}', basename(target)),
      detail: s.replaceDetail ?? 'A deck with this name is already in that folder. Replacing it overwrites its contents.',
      buttons: [s.replace ?? 'Replace', s.cancel ?? 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    })
    if (response !== 0) return { cancelled: true }
  }
  try {
    // Overwriting an existing deck via Save As: the user confirmed it (the
    // panel, or the box above), but keep its old bytes like any first write.
    if (existsSync(target)) { try { backupBeforeFirstWrite(target) } catch { /* best effort */ } }
    setWriting(ev.sender.id, true)
    writeFileAtomic(target, req.html)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    setWriting(ev.sender.id, false)
  }
  const mtimeMs = statSync(target).mtimeMs
  if (req.mode === 'move') rebind(ev.sender.id, target, mtimeMs)
  else addRecent(target)
  return { ok: true, path: target, name: basename(target) }
}

interface DraftInfo { path: string; title: string | null; mtimeMs: number; open: boolean; figure: boolean; iconset: boolean }

const draftTitleCache = new Map<string, { mtimeMs: number; title: string | null; kind: 'figure' | 'iconset' | null }>()

export function listDrafts(): DraftInfo[] {
  let names: string[] = []
  try { names = readdirSync(draftsDir()) } catch { return [] }
  const open = openBoundPaths()
  const out: DraftInfo[] = []
  for (const name of names) {
    if (!hasDocExt(name)) continue
    const path = join(draftsDir(), name)
    try {
      const { mtimeMs } = statSync(path)
      let cached = draftTitleCache.get(path)
      if (!cached || cached.mtimeMs !== mtimeMs) {
        const html = readFileSync(path, 'utf8')
        cached = { mtimeMs, title: readTitle(html), kind: docKindOfText(rawDocBlockText(html) ?? '') }
        draftTitleCache.set(path, cached)
      }
      out.push({ path, title: cached.title, mtimeMs, open: open.has(resolve(path)), figure: cached.kind === 'figure', iconset: cached.kind === 'iconset' })
    } catch { /* vanished mid-scan */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function registerDocumentIpc(): void {
  /** Boot: the deck this window should show. `text` is the doc-block text
   *  (a deck, an encryption envelope, or a seed) or null for a blank draft;
   *  null overall means "not bound — read your own embedded block". */
  handle('slidomingo:read-launch-document', (ev) => {
    const b = bindingFor(ev.sender.id)
    if (!b) return null
    return {
      text: launchTextFor(ev.sender.id),
      kind: b.kind,
      /** `template`: a template window (Edit Template) — boot in template mode. */
      role: b.role,
      path: b.path,
      name: b.kind === 'file' ? basename(b.path) : null,
      dir: b.kind === 'file' ? dirname(b.path) : null,
      mtimeMs: b.knownMtime,
      /** It replaced another deck in this window: say "Opened …" (once). */
      opened: takeAnnounce(ev.sender.id),
      /** A blank draft that skips the start page (once): `default-template`,
       *  `new-template`. */
      startIntent: takeStartIntent(ev.sender.id),
      /** A hidden instance for an agent (background.ts): doc_info says so. */
      background: isBackground(),
    }
  }, null)

  /** Dev mode: the built shell to splice saves into (null = not built). */
  handle('slidomingo:get-app-shell', () => readAppShell(), null)

  /** The viewer-only shell every saved deck is spliced into (null = not built:
   *  the renderer falls back to the app shell). */
  handle('slidomingo:get-viewer-shell', () => readViewerShell(), null)

  /** Start page ▸ Example deck: the bundled example's doc text as a fresh,
   *  editable copy — no docId (the renderer's parseDoc mints one, so every
   *  open is a new deck with its own drafts) and not read-only (the file is a
   *  present-only export). null = not bundled or unreadable. */
  handle('slidomingo:get-example-deck', () => {
    const html = readExampleDeck()
    const text = html ? extractDocBlockText(html) : null
    if (!text) return null
    const doc = JSON.parse(text) as Record<string, unknown>
    delete doc.docId
    delete doc.readonly
    return JSON.stringify(doc)
  }, null)

  handle('slidomingo:write-document', (ev, html: string, opts?: { force?: boolean }) => writeDocument(ev, html, opts),
    { error: 'internal' } as WriteResult)

  handle('slidomingo:save-document-as', (ev, req) => saveDocumentAs(ev, req), { error: 'internal' } as SaveAsResult)

  /** Conflict banner → Reload: the file's current doc text, and main now
   *  treats that version as the known one. */
  handle('slidomingo:reload-from-disk', (ev) => {
    const b = bindingFor(ev.sender.id)
    if (!b || !existsSync(b.path)) return null
    const html = readFileSync(b.path, 'utf8')
    b.knownMtime = statSync(b.path).mtimeMs
    return { text: extractDocBlockText(html), mtimeMs: b.knownMtime }
  }, null)

  // The open handlers below answer before the open is done: replacing the
  // caller's deck closes the caller's renderer, which could never get the
  // reply. `true` = accepted.

  /** Native Open dialog. The first pick replaces the caller's deck (it is
   *  flushed first — windows.ts replaceDocument), the rest open in new
   *  windows; `newWindow` puts every pick in a new window. */
  handle('slidomingo:open-dialog', async (ev, opts?: { newWindow?: boolean }) => {
    const win = windowForDocWebContents(ev.sender.id)
    const paths = await showOpenDialogFor(win)
    if (!paths.length) return false
    void openPathsFrom(win, paths, { newWindow: !!opts?.newWindow })
    return true
  }, false)

  /** Open a known path (Recent, a dropped file, a start-page tile) in place
   *  of the caller's deck, or in a new window with `newWindow`. A path open
   *  elsewhere focuses that window. */
  handle('slidomingo:open-document', (ev, path: string, opts?: { newWindow?: boolean }) => {
    if (typeof path !== 'string' || !existsSync(path)) return false
    void openPathsFrom(windowForDocWebContents(ev.sender.id), [path], { newWindow: !!opts?.newWindow })
    return true
  }, false)

  handle('slidomingo:new-window', () => { createDocumentWindow(null); return true }, false)

  /** File ▸ Start page: this window's deck (flushed first) gives way to the
   *  start page, in the same window. */
  handle('slidomingo:go-home', (ev) => {
    const win = windowForDocWebContents(ev.sender.id)
    if (!win) return false
    goHome(win).catch((err) => log('go-home', err))
    return true
  }, false)

  /** An import (PowerPoint, Markdown): a NEW draft seeded with this doc
   *  text, in place of the caller's deck (or in a new window). */
  handle('slidomingo:open-as-draft', (ev, text: string, opts?: { newWindow?: boolean }) => {
    if (typeof text !== 'string' || !text) return false
    openSeededInWindow(windowForDocWebContents(ev.sender.id), text, { newWindow: !!opts?.newWindow })
      .catch((err) => log('open-as-draft', err))
    return true
  }, false)

  onFrom('app-shell', 'slidomingo:doc-state', (ev, s: { dirty: boolean; title?: string; untouched?: boolean; docId?: string }) => {
    try { noteDocState(ev.sender.id, s ?? { dirty: false }) } catch { /* window gone */ }
  })

  handle('slidomingo:list-drafts', () => listDrafts(), [] as DraftInfo[])

  handle('slidomingo:delete-draft', async (_ev, path: string) => {
    if (typeof path !== 'string' || !isInside(path, draftsDir()) || resolve(path) === resolve(draftsDir())) return false
    if (openBoundPaths().has(resolve(path))) return false
    rmSync(path, { force: true })
    await dropPartition(`persist:doc-${hashPath(path)}`)
    return true
  }, false)

  /** Session backups of the sender's bound file, newest first. */
  handle('slidomingo:list-backups', (ev) => {
    const b = bindingFor(ev.sender.id)
    if (!b || b.kind !== 'file') return []
    const dir = join(backupsRoot(), hashPath(b.path))
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return [] }
    return names.filter((n) => hasDocExt(n))
      .map((n) => ({ path: join(dir, n), at: statSync(join(dir, n)).mtimeMs }))
      .sort((a, c) => c.at - a.at)
  }, [] as Array<{ path: string; at: number }>)

  /** Open a backup as a NEW draft (never in place — it's a different version
   *  of the file this window is bound to). */
  handle('slidomingo:open-backup', (_ev, path: string) => {
    if (typeof path !== 'string' || !isInside(path, backupsRoot())) return false
    const text = extractDocBlockText(readFileSync(path, 'utf8'))
    if (!text) return false
    createDocumentWindow(null, { seedText: text })
    return true
  }, false)

  onFrom('app-shell', 'slidomingo:reveal-path', (_ev, path: string) => {
    if (typeof path === 'string' && existsSync(path)) shell.showItemInFolder(path)
  })
}

/** Main-side File ▸ Open… (menu.ts and the renderer's ⌘O). */
export async function showOpenDialogFor(win: BrowserWindow | null): Promise<string[]> {
  const opts: Electron.OpenDialogOptions = {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'BeeSlides deck', extensions: ['html'] }],
  }
  const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return canceled ? [] : filePaths
}
