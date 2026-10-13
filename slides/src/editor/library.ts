// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The GLOBAL element library — sharing slide elements/groups between decks
// via a standalone LIBRARY FILE, not IndexedDB-only (see docs/DECISIONS.md).
//
// SCOPE (docs/DECISIONS.md 2026-09-28, "Scope split: Layout Manager = this
// file; Library = global registry in the editor"): the library belongs to the
// user or team, not to a deck, so it is managed from the slide editor
// (librarypanel.ts), never from the Layout Manager, which only shows what is
// saved IN the file (`doc.reusableObjects` is its Objects tab). "Insert
// object…" (reusableobjects.ts) lists both scopes side by side.
//
// FORMAT DECISION (already made — see docs/DECISIONS.md): a library file is
// an ORDINARY slidomingo/slides document. Each library item is just one `Slide`
// in `doc.slides` — `slide.name` is the item's display name, one element for
// a single-item share, several (sharing a `groupId`) for a group. That is the
// whole format story: save/splice/self-update/preview/docId-minting/collab
// dormancy are ALL already implemented for it for free, because it is just a
// deck whose slides are reusable things. An EMPTY slide is not an item: a
// document needs at least one slide (`parseDoc`), so an empty library holds
// one empty placeholder slide, and every view here skips empty slides.
//
// WHERE THE FILE LIVES (`LibrarySource`). In a browser, the user picks a file
// and its File System Access handle is remembered in IndexedDB. In the desktop
// app, main owns the location (desktop/src/main/library.ts): a default file
// next to the templates folder, created on first run, or one the user chose —
// a per-deck IndexedDB handle could not be a GLOBAL registry there, because
// every deck window has its own storage partition.
//
// TRUST POSTURE. A picked library file is a FOREIGN file exactly like a
// dropped .beeslides.html or a clipboard payload — it may have been shared by
// someone else, edited by hand, or point at a stale format. Browsing it
// (thumbnails) is safe at the same level template-gallery browsing already
// is: render.ts sanitizes svg/table/etc at RENDER, every render (see
// render.ts's header and slides/src/editor/iconlibrary.ts's comment on the
// same subject) — a bad thumbnail render is caught per-item, never fatal to
// the picker. But ACTUALLY MERGING a picked item's elements into the document
// you are editing is the sensitive step, so that step reuses the exact
// clipboard.ts pipeline (serializeElements -> parseClip -> insertElements) —
// the same untrusted.ts sanitize+merge+insert a paste already goes through.
// No new sanitizer, no new trust boundary.
//
// LAYOUT/BUILDING-BLOCKS PROPAGATION. Inserting while `store.editingSurface`
// is set needs NO special-casing here: `store.slide` (store.ts) already
// redirects to the open `doc.layouts` entry or reusable object while one is
// being edited (the Layout Manager, editor/layoutmanager.ts), and
// insertElements only ever mutates `store.slide.elements` — so an insert
// from "Insert object…" lands on the right surface automatically, and
// editor.ts's live syncLayoutInstances re-applies it to every slide tracking
// that surface in the same undo step.

import type { SlidomingoDoc, Slide, SlideElement } from '../model'
import type { Store } from '../store'
import { emptySlide, parseDoc, uid, unsupportedFeatures } from '../model'
import { formatGate } from '../formatgate'
import { resolveDocText, withContentRequires } from '../save'
import { insertElements, mergeClipResources, parseClip, serializeElements } from './clipboard'
import { injectFonts } from '../fonts'
import { renderObjectThumbnail } from '../render'
import { t } from '../i18n'

// --- foreign-file parsing ----------------------------------------------------

export type ForeignDocResult = { doc: SlidomingoDoc } | { error: string }

/**
 * Extract and validate a foreign .beeslides.html file's `#slidomingo-doc` block.
 *
 * Same technique editor.ts's openFileLike already uses for "open a dropped
 * deck" (DOMParser -> #slidomingo-doc -> JSON.parse -> parseDoc) — not duplicated
 * from there because that method is private and folded into a bigger
 * open-and-replace-the-whole-window flow; this needs just the parse half, to
 * BROWSE a file without replacing the current document. desktop/src/main/
 * templates.ts has an analogous `extractSlidomingoDoc`, but that copy is Electron
 * main-process code (regex-based, because the main process has no DOM) and
 * cannot be imported here — a browser build and an Electron main-process
 * build are different apps for module-resolution purposes, so the two small
 * parsers are intentionally separate copies of the same idea rather than one
 * shared function crossing that boundary.
 */
export function extractForeignDoc(html: string): ForeignDocResult {
  const el = new DOMParser().parseFromString(html, 'text/html').querySelector('#slidomingo-doc')
  // resolved against the file's own asset store (kernel/src/assetstore.ts)
  const block = resolveDocText(el?.textContent?.trim() ?? '', html)
  if (!block) return { error: t('That file has no content yet.') }
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch {
    return { error: t("That file isn't a BeeSlides document.") }
  }
  if ((parsed as { format?: string })?.format === 'slidomingo/enc') {
    return { error: t('That file is password-protected — open it directly to browse it.') }
  }
  const doc = parseDoc(JSON.stringify(parsed))
  if (!doc) return { error: t("That file isn't a BeeSlides document.") }
  // the reader gate (src/formatgate.ts): nothing from a newer-format file is
  // browsed into, merged into or written back through this build
  if (unsupportedFeatures(doc).length) return { error: t('That document was made with a newer version of BeeSlides. Update BeeSlides to use it here.') }
  return { doc }
}

// --- library-file handle persistence (IndexedDB — FSA handles structured-clone,
// same pattern as editor/iconlibrary.ts's folder-handle store). Browser only:
// the desktop app keeps the library's location in main (see file header). ----

const HANDLE_DB = 'slidomingo-library-file'
const HANDLE_STORE = 'handle'
const HANDLE_KEY = 'file'

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return }
    const req = indexedDB.open(HANDLE_DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function saveLibraryFileHandle(handle: FileSystemFileHandle): Promise<void> {
  try {
    const db = await openHandleDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite')
      tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch { /* no IndexedDB (opaque origin, blocked site data) — re-pick next time */ }
}

export async function loadLibraryFileHandle(): Promise<FileSystemFileHandle | null> {
  try {
    const db = await openHandleDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly')
      const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY)
      req.onsuccess = () => resolve((req.result as FileSystemFileHandle) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

async function clearLibraryFileHandle(): Promise<void> {
  try {
    const db = await openHandleDb()
    const tx = db.transaction(HANDLE_STORE, 'readwrite')
    tx.objectStore(HANDLE_STORE).delete(HANDLE_KEY)
  } catch { /* nothing to clear */ }
}

/** User gesture required — call only from a click handler. */
export async function pickLibraryFile(): Promise<FileSystemFileHandle | null> {
  const picker = (window as any).showOpenFilePicker
  if (typeof picker !== 'function') return null
  let handle: FileSystemFileHandle
  try {
    ;[handle] = await picker({
      types: [{ description: 'BeeSlides deck', accept: { 'text/html': ['.beeslides.html', '.beeslides.html', '.html'] } }],
      excludeAcceptAllOption: false,
      multiple: false,
    })
  } catch {
    return null // cancelled
  }
  await saveLibraryFileHandle(handle)
  return handle
}

/** Also needs a user gesture on first grant / after the browser forgets it —
 *  call from the click handler that triggered the load, never eagerly.
 *  `mode` defaults to 'read' (browsing/inserting); a caller that is about to
 *  WRITE the file back passes 'readwrite' — per the File System Access API
 *  spec a 'readwrite' grant is its OWN permission, requested separately from
 *  'read' and requiring its own fresh user gesture (a handle already granted
 *  'read' is not upgraded for free), so this must still only ever be called
 *  from a click handler, never eagerly/ahead of time. */
async function ensureFilePermission(handle: FileSystemFileHandle, mode: 'read' | 'readwrite' = 'read'): Promise<boolean> {
  const h = handle as any
  const opts = { mode }
  if (typeof h.queryPermission !== 'function') return true // older FSA typings, assume granted
  if ((await h.queryPermission(opts)) === 'granted') return true
  if (typeof h.requestPermission !== 'function') return false
  return (await h.requestPermission(opts)) === 'granted'
}

// --- where the library lives ------------------------------------------------------

export interface LibraryFile {
  source: LibrarySource
  /** raw file text, as last read — spliceForeignDoc needs the whole shell,
   *  not just the parsed doc, so a write-back always passes this straight
   *  through rather than re-deriving it. */
  html: string
  doc: SlidomingoDoc
  fileName: string
}

export type LibraryLoadResult =
  | { ok: true; file: LibraryFile }
  | { ok: false; error: string; needsPermission?: boolean }

/** One library file's read/write, wherever it lives. */
export interface LibrarySource {
  /** Desktop only: this is the app's default library (not a chosen file) —
   *  known once `load` has run. */
  isDefault?: boolean
  /** `mode` 'readwrite' when the caller will write back through this same
   *  source afterwards, so one permission prompt covers both (browser). */
  load(mode: 'read' | 'readwrite'): Promise<LibraryLoadResult>
  write(html: string): Promise<boolean>
}

function fileSource(handle: FileSystemFileHandle): LibrarySource {
  const source: LibrarySource = {
    async load(mode) {
      if (!(await ensureFilePermission(handle, mode))) {
        return { ok: false, error: t('This file needs permission again — '), needsPermission: true }
      }
      let file: File
      try {
        file = await handle.getFile()
      } catch {
        void clearLibraryFileHandle() // moved or deleted: forget it
        return { ok: false, error: t("Couldn't open that file — pick it again.") }
      }
      const html = await file.text()
      const result = extractForeignDoc(html)
      if ('error' in result) return { ok: false, error: result.error }
      return { ok: true, file: { source, html, doc: result.doc, fileName: file.name } }
    },
    async write(html) {
      try {
        const writable = await handle.createWritable()
        await writable.write(html)
        await writable.close()
        return true
      } catch {
        return false
      }
    },
  }
  return source
}

type DesktopLibraryApi = Required<Pick<NonNullable<Window['slidomingoDesktop']>,
  'readLibrary' | 'writeLibrary' | 'chooseLibrary' | 'useDefaultLibrary'>>

function desktopLibraryApi(): DesktopLibraryApi | null {
  const api = window.slidomingoDesktop
  return api?.readLibrary && api.writeLibrary && api.chooseLibrary && api.useDefaultLibrary ? api as DesktopLibraryApi : null
}

/** Whether the library's location is owned by the desktop app. */
export function isDesktopLibrary(): boolean {
  return !!desktopLibraryApi()
}

function desktopSource(api: DesktopLibraryApi, isDefault: boolean): LibrarySource {
  const source: LibrarySource = {
    isDefault,
    async load() {
      const r = await api.readLibrary()
      source.isDefault = r.isDefault
      if (!r.ok) {
        return { ok: false, error: r.reason === 'not-a-library' ? t("That file isn't a BeeSlides document.") : t("Couldn't open that file — pick it again.") }
      }
      const result = extractForeignDoc(r.html)
      if ('error' in result) return { ok: false, error: result.error }
      return { ok: true, file: { source, html: r.html, doc: result.doc, fileName: r.name } }
    },
    write: (html) => api.writeLibrary(html),
  }
  return source
}

/** The library in use, or `null` when none is chosen yet (browser). Never
 *  prompts: permission is asked for by `load`, from a click. */
export async function currentLibrarySource(): Promise<LibrarySource | null> {
  const api = desktopLibraryApi()
  if (api) return desktopSource(api, true) // always has one; `load` says which
  const handle = await loadLibraryFileHandle()
  return handle ? fileSource(handle) : null
}

/** "Choose file…" — user gesture required. `null` when cancelled, or when
 *  the browser has no File System Access API (`canChooseLibraryFile`). */
export async function chooseLibrarySource(): Promise<LibrarySource | null> {
  const api = desktopLibraryApi()
  if (api) return (await api.chooseLibrary()) ? desktopSource(api, false) : null
  const handle = await pickLibraryFile()
  return handle ? fileSource(handle) : null
}

/** Desktop: switch back to the default library file. */
export async function useDefaultLibrarySource(): Promise<LibrarySource | null> {
  const api = desktopLibraryApi()
  if (!api || !(await api.useDefaultLibrary())) return null
  return desktopSource(api, true)
}

/** Browsers without the File System Access API (Firefox, Safari) cannot keep
 *  a library file: they can read a picked file once, but never write it. */
export function canChooseLibraryFile(): boolean {
  return isDesktopLibrary() || typeof (window as any).showOpenFilePicker === 'function'
}

/** Load a library file: permission check, read, parse. */
export function loadLibraryFile(source: LibrarySource, mode: 'read' | 'readwrite' = 'read'): Promise<LibraryLoadResult> {
  return source.load(mode)
}

// --- items ---------------------------------------------------------------------------

/** The library's items — every slide with something on it (an empty slide is
 *  the placeholder a document needs, see file header). */
export function libraryItems(doc: SlidomingoDoc): Slide[] {
  return doc.slides.filter((s) => s.elements.length > 0)
}

/**
 * Insert one library item (a Slide's elements) into the CURRENT target slide
 * — which is the open layout while Slide Master mode is active, per
 * `store.slide`'s own redirect (store.ts). Goes through the exact clipboard
 * pipeline (serializeElements -> parseClip -> insertElements): same
 * sanitize+merge+insert as a paste, same asset/font collision handling.
 */
export function insertLibraryItem(store: Store, item: Slide, sourceDoc: SlidomingoDoc): SlideElement[] {
  const text = serializeElements(item.elements, sourceDoc)
  const clip = parseClip(text)
  if (!clip) return []
  let added: SlideElement[] = []
  store.commit(() => { added = insertElements(clip, store.doc, store.slide) })
  if (clip.fonts?.length) injectFonts(store.doc)
  return added
}

// --- write path -------------------------------------------------------------------

/**
 * Splice `doc` back into a foreign library file's raw HTML text, replacing
 * only its `#slidomingo-doc` data block — the write-side mirror of
 * `extractForeignDoc`. Deliberately does NOT reuse kernel/src/save.ts's
 * `serializeWith`/`serializeBody`: that machinery reads the app's own live
 * globals (registered shell-block providers, the in-memory encryption
 * password, the static-preview provider) to update the CURRENTLY OPEN
 * document, and running it against a picked-off-disk library file would
 * write THIS session's language packs/encryption state into someone else's
 * file — wrong file, wrong data. This is a narrower, self-contained splice
 * that touches nothing else in the shell, following the exact same
 * `<`-escaping the splice contract requires (docs/PLATFORM.md §2). The one
 * side effect this accepts: the file's static first-page preview (used by
 * file-manager thumbnailers) goes stale until it is next saved by a real
 * editor session — a cosmetic cost, not a correctness one.
 */
function spliceForeignDoc(html: string, doc: SlidomingoDoc): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  let block = parsed.getElementById('slidomingo-doc')
  if (!block) {
    block = parsed.createElement('script')
    block.setAttribute('type', 'application/slidomingo+json')
    block.id = 'slidomingo-doc'
    parsed.head.appendChild(block)
  }
  // `doc` came back resolved (extractForeignDoc), so this block carries its
  // bytes inline: correct on its own, whatever store the file still holds —
  // that store simply goes unused until the file's next real save.
  // Items saved into the library may carry lists/links/styled runs or merged
  // table cells; this path never meets the Store, so those gates are declared
  // here (an older build would otherwise insert the items flattened).
  block.textContent = '\n' + JSON.stringify(withContentRequires(doc)).replace(/</g, '\\u003c') + '\n'
  return '<!DOCTYPE html>\n' + parsed.documentElement.outerHTML
}

/** Write `file.doc` back where it came from (`spliceForeignDoc` into the raw
 *  text it was loaded with). `false` on any failure, never throws. */
export async function writeLibraryFile(file: LibraryFile): Promise<boolean> {
  try {
    return await file.source.write(spliceForeignDoc(file.html, file.doc))
  } catch {
    return false
  }
}

/** Apply `edit` to `file.doc` and write it; on a failed write, `revert`
 *  undoes it so the in-memory doc never shows what isn't on disk. */
async function commitLibraryEdit(file: LibraryFile, edit: () => void, revert: () => void): Promise<boolean> {
  edit()
  const ok = await writeLibraryFile(file)
  if (!ok) revert()
  return ok
}

/**
 * Save `els` (from `sourceDoc`) into a library file as one new item — the
 * write counterpart of `insertLibraryItem`, shared by "Save selection…" and
 * a deck object's "Save to library". Symmetric trust posture: the elements
 * are cloned through the exact same untrusted-fragment pipeline a
 * paste/insert already goes through (`serializeElements` -> `parseClip`), so
 * the library file only ever receives content shaped by the same
 * sanitize+merge checks, and any asset/font the elements reference is merged
 * into the library doc's own `doc.assets`/`doc.fonts` (`mergeClipResources`,
 * same as an insert or cross-doc paste) rather than left dangling on a ref
 * the library file cannot resolve.
 *
 * Elements sharing a single `groupId` when there are 2+ mirrors panels.ts's
 * own `group()` — the picker renders it as one item, one click inserts the
 * whole thing. The empty placeholder slide, if that was all the library had,
 * gives way to the new item.
 */
export async function saveElementsToLibrary(
  file: LibraryFile, els: SlideElement[], sourceDoc: SlidomingoDoc, name: string, background?: string,
): Promise<boolean> {
  // a newer-format deck's elements would lose what this build can't read
  if (!els.length || formatGate()) return false
  const clip = parseClip(serializeElements(els, sourceDoc))
  if (!clip?.elements?.length) return false

  const groupId = clip.elements.length > 1 ? `grp-${uid()}` : undefined
  const newEls: SlideElement[] = clip.elements.map((e) => {
    const clone: SlideElement = { ...e, id: uid(e.type[0]) }
    if (groupId) clone.groupId = groupId
    else delete clone.groupId
    return clone
  })
  const libDoc = file.doc
  const prevSlides = libDoc.slides
  const prevAssets = libDoc.assets && { ...libDoc.assets }
  const prevFonts = libDoc.fonts && [...libDoc.fonts]
  return commitLibraryEdit(file, () => {
    mergeClipResources(clip, libDoc, newEls)
    const item = emptySlide({ id: uid('slide'), name, elements: newEls, ...(background ? { background } : {}) })
    libDoc.slides = [...libraryItems(libDoc), item]
  }, () => {
    libDoc.slides = prevSlides
    libDoc.assets = prevAssets
    libDoc.fonts = prevFonts
  })
}

/** Rename one item in place. */
export function renameLibraryItem(file: LibraryFile, item: Slide, name: string): Promise<boolean> {
  const prev = item.name
  return commitLibraryEdit(file, () => { item.name = name }, () => { item.name = prev })
}

/** Remove one item. The last one leaves the empty placeholder slide behind,
 *  so the file still opens as a document (`parseDoc` needs a slide). */
export function deleteLibraryItem(file: LibraryFile, item: Slide): Promise<boolean> {
  const prev = file.doc.slides
  return commitLibraryEdit(file, () => {
    const rest = prev.filter((s) => s !== item)
    file.doc.slides = rest.length ? rest : [emptySlide()]
  }, () => { file.doc.slides = prev })
}

/** One item's thumbnail, with the picker's own per-item robustness — a
 *  corrupt item's render is skipped (returns null) rather than breaking the
 *  whole grid. Shared by the Library panel and "Insert object…" so both
 *  surfaces degrade the same way instead of each carrying its own try/catch.
 *  Fitted to the item's content, like a deck object's thumbnail, so the two
 *  sections of "Insert object…" look alike and a small shape isn't a speck
 *  in a slide-sized frame. */
export function renderLibraryItemThumb(item: Slide, doc: SlidomingoDoc, size = 120): HTMLElement | null {
  try {
    return renderObjectThumbnail(item, doc, size)
  } catch {
    return null
  }
}

// --- shared popover pieces (Library panel, "Insert object…") --------------------------

/** One thumbnail cell: click inserts; `actions` are small buttons shown on
 *  hover (a sibling of the insert button, never nested in it). */
export function buildItemCell(opts: {
  thumb: HTMLElement
  name: string
  onInsert: (cell: HTMLButtonElement) => void
  actions?: Array<{ label: string; title: string; onClick: () => void }>
}): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'ed-library-cell'
  const cell = document.createElement('button')
  cell.type = 'button'
  cell.className = 'ed-library-item'
  cell.title = opts.name
  cell.appendChild(opts.thumb)
  const label = document.createElement('div')
  label.className = 'ed-library-item-name'
  label.textContent = opts.name
  cell.appendChild(label)
  cell.addEventListener('click', () => opts.onInsert(cell))
  wrap.appendChild(cell)
  if (opts.actions?.length) {
    const bar = document.createElement('div')
    bar.className = 'ed-library-actions'
    for (const a of opts.actions) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-library-action'
      b.innerHTML = a.label
      b.title = a.title
      b.setAttribute('aria-label', a.title)
      b.addEventListener('click', (ev) => { ev.stopPropagation(); a.onClick() })
      bar.appendChild(b)
    }
    wrap.appendChild(bar)
  }
  return wrap
}

/** Point-anchored popover lifecycle shared by both pickers: positions `pop`
 *  under `anchor`, closes on Esc or an outside click (stays open for rapid
 *  multi-insert). Returns the close function. An Esc inside a text field
 *  (a rename) is left to that field. */
export function mountPopover(pop: HTMLElement, anchor: HTMLElement): () => void {
  document.querySelector('.ed-library-pop')?.remove()
  const r = anchor.getBoundingClientRect()
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 480))}px`
  pop.style.top = `${Math.max(8, Math.min(r.bottom + 8, window.innerHeight - 560))}px`
  document.body.appendChild(pop)
  const close = () => {
    pop.remove()
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('keydown', onKey, true)
  }
  const onOutside = (ev: PointerEvent) => {
    if (!pop.isConnected) { close(); return }
    const target = ev.target as Node
    // A dialog opened from the popover (Save selection…) is not "outside".
    if (!pop.contains(target) && !anchor.contains(target) && !(target as Element).closest?.('.ed-about-overlay')) close()
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !pop.isConnected) return
    if (document.querySelector('.ed-about-overlay')) return // the dialog's own Esc
    if ((ev.target as HTMLElement)?.classList?.contains('ed-library-rename')) return
    ev.stopPropagation()
    close()
  }
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true))
  document.addEventListener('keydown', onKey, true)
  return close
}
