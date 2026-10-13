// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// "Insert object…" — ONE picker over both scopes (docs/DECISIONS.md
// 2026-09-28, "Scope split"): "In this deck" is `doc.reusableObjects` (saved
// in the file, managed in the Layout Manager's Objects tab), "Library" is the
// global library file (library.ts, managed in the editor's Library panel,
// librarypanel.ts). One search box filters both. A saved object
// is inserted via the exact same clipboard pipeline (serializeElements ->
// parseClip -> insertElements) a library item or a system-clipboard paste
// already goes through, so a container+children unit gets its
// groupId/parentId/parentOffset remapped safely with no new sanitizer, no
// new trust boundary — this is same-document content, strictly LESS foreign
// than a library file. The inserted copy is fully independent: there is no
// live link back to `doc.reusableObjects` (see model.ts's field doc
// comment), so deleting the saved object afterward never touches it.

import { createReusableObject, type Slide, type SlideElement, type SlidomingoDoc } from '../model'
import type { Store } from '../store'
import { insertElements, parseClip, serializeElements } from './clipboard'
import { injectFonts } from '../fonts'
import { renderObjectThumbnail } from '../render'
import { ICONS } from '../icons'
import { t } from '../i18n'
import type { OpenLayoutManagerDetail } from './layoutmanager'
import {
  buildItemCell, canChooseLibraryFile, chooseLibrarySource, currentLibrarySource, insertLibraryItem, libraryItems,
  loadLibraryFile, mountPopover, renderLibraryItemThumb, saveElementsToLibrary, type LibraryFile, type LibrarySource,
} from './library'

/**
 * Insert one saved reusable object's elements into the CURRENT target slide
 * — which is the open layout/building-blocks/reusable-object surface, per
 * `store.slide`'s own redirect (store.ts), exactly like `insertLibraryItem`.
 */
export function insertReusableObject(store: Store, obj: Slide): SlideElement[] {
  const text = serializeElements(obj.elements, store.doc)
  const clip = parseClip(text)
  if (!clip) return []
  let added: SlideElement[] = []
  store.commit(() => { added = insertElements(clip, store.doc, store.slide) })
  return added
}

/**
 * The reverse direction: promote an already-built element selection (from
 * an ordinary slide OR a slide-type sub-editor — `els` came from
 * `store.selectedElements`, which is already surface-agnostic) into a new
 * `doc.reusableObjects` entry. Mirrors `panels.ts`'s `saveSlideAsLayout`
 * (same "take a working selection, mint an independent library entry from
 * it" shape) but for a subset of elements rather than a whole slide, and
 * reuses the SAME clip pipeline `insertReusableObject` above already trusts
 * for groupId/parentId/parentOffset remap (`serializeElements` ->
 * `parseClip` -> `insertElements`). `model.ts`'s `createReusableObject` mints
 * the blank target entry; `insertElements(…, {nudge:false})` then fills it
 * WITHOUT the human-paste +20/+20 offset, since a promoted object should keep
 * the exact relative layout it had on its source. Returns `null` when `els`
 * is empty or the round-trip through the clip pipeline yields nothing (e.g.
 * every element failed `untrusted.ts` sanitization).
 *
 * `sourceDoc` is where `els` live — `store.doc` for a selection, the library
 * file's doc for "Add to this deck's objects". A foreign source is exactly a
 * cross-deck paste: its assets/fonts merge in, and embedded fonts load.
 */
export function promoteToReusableObject(store: Store, els: SlideElement[], name?: string, sourceDoc: SlidomingoDoc = store.doc): Slide | null {
  if (!els.length) return null
  const clip = parseClip(serializeElements(els, sourceDoc))
  if (!clip) return null
  let obj: Slide | null = null
  store.commit(() => {
    obj = createReusableObject(store.doc)
    if (name) obj.name = name
    insertElements(clip, store.doc, obj, { nudge: false })
  })
  if (clip.fonts?.length) injectFonts(store.doc)
  return obj
}

// tiny DOM helpers (each editor/*.ts file keeps its own copy — see editor.ts)
function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

/** Ask for a name (prefilled) — `null` when cancelled. */
function promptName(message: string, value: string): string | null {
  const name = window.prompt(message, value)
  return name == null ? null : name.trim() || value
}

/**
 * Point-anchored popover: search-as-you-type over two sections, thumbnail
 * grids, click-to-insert without closing (rapid multi-insert). Same shape and
 * `.ed-library-*` styling as the Library panel. Each cell also offers the
 * cross-scope move: a deck object can be saved to the library, a library item
 * added to this deck's objects.
 */
export function openReusableObjectPicker(store: Store, anchor: HTMLElement): void {
  const pop = div('ed-library-pop ed-objpick')

  const searchRow = div('ed-icon-pop-head')
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'ed-library-search'
  input.placeholder = t('Search objects…')
  searchRow.appendChild(input)
  pop.appendChild(searchRow)

  const status = div('ed-library-status')
  const scroll = div('ed-objpick-scroll')
  pop.append(status, scroll)

  const deckHead = div('ed-objpick-head')
  deckHead.textContent = t('In this deck')
  const deckNote = div('ed-library-status')
  const deckGrid = div('ed-library-grid')
  const libHead = div('ed-objpick-head')
  libHead.textContent = t('Library')
  const libNote = div('ed-library-status')
  const libGrid = div('ed-library-grid')
  scroll.append(deckHead, deckNote, deckGrid, libHead, libNote, libGrid)

  let libSource: LibrarySource | null = null
  let libFile: LibraryFile | null = null
  let libState: 'loading' | 'none' | 'permission' | 'error' | 'ready' = 'loading'
  let libError = ''

  const matches = (name: string | undefined, q: string) => !q || (name ?? '').toLowerCase().includes(q)
  const inserted = (added: SlideElement[]) => {
    if (!added.length) { status.textContent = t("Couldn't insert that item."); return }
    store.select(added.map((e) => e.id))
    status.textContent = added.length === 1 ? t('Inserted 1 item') : t('Inserted {n} elements', { n: added.length })
  }

  function renderDeck(q: string) {
    deckGrid.innerHTML = ''
    deckNote.innerHTML = ''
    const all = (store.doc.reusableObjects ?? []).filter((o) => o.elements.length)
    const items = all.filter((o) => matches(o.name, q))
    if (!all.length) {
      // Genuinely empty (not just an unmatched search) — offer a jump
      // straight into the Layout Manager's Objects tab, landing in a fresh
      // blank sub-editor. Loose-coupling seam already used by panels.ts's
      // "🖼 Layout Manager…" button; see layoutmanager.ts's
      // `OpenLayoutManagerDetail` doc comment for the force/newObject contract.
      deckNote.textContent = t('No reusable objects yet — build a figure, icon set, or labeled diagram once and reuse it anywhere in the deck.')
      const jump = document.createElement('button')
      jump.type = 'button'
      jump.className = 'ed-btn ed-library-status-action'
      jump.textContent = t('Create one in the Layout Manager')
      jump.addEventListener('click', () => {
        const detail: OpenLayoutManagerDetail = { tab: 'objects', force: true, newObject: true }
        document.dispatchEvent(new CustomEvent('slidomingo:open-layout-manager', { detail }))
        close()
      })
      deckNote.appendChild(jump)
      return
    }
    if (!items.length) { deckNote.textContent = t('No matching objects.'); return }
    for (const item of items) {
      let thumb: HTMLElement
      try { thumb = renderObjectThumbnail(item, store.doc, 120) } catch { continue } // one corrupt item skips
      const name = item.name ?? t('Untitled object')
      deckGrid.appendChild(buildItemCell({
        thumb, name,
        onInsert: (cell) => { cell.disabled = true; const added = insertReusableObject(store, item); cell.disabled = false; inserted(added) },
        actions: [{ label: ICONS.library, title: t('Save to library'), onClick: () => void saveToLibrary(item) }],
      }))
    }
  }

  function renderLibrary(q: string) {
    libGrid.innerHTML = ''
    libNote.innerHTML = ''
    if (libState === 'loading') { libNote.textContent = t('Loading…'); return }
    if (libState === 'none') {
      if (!canChooseLibraryFile()) { libNote.textContent = t('This browser can’t keep a library file — use Chrome, Edge or the desktop app.'); return }
      libNote.textContent = t('Choose a library file to browse its items.')
      const choose = document.createElement('button')
      choose.type = 'button'
      choose.className = 'ed-btn ed-library-status-action'
      choose.textContent = t('Choose file…')
      choose.addEventListener('click', () => void (async () => {
        const src = await chooseLibrarySource()
        if (src) await loadLibrary(src)
      })())
      libNote.appendChild(choose)
      return
    }
    if (libState === 'permission') {
      const msg = document.createElement('span')
      msg.textContent = t('This file needs permission again — ')
      const grant = document.createElement('button')
      grant.className = 'ed-btn'
      grant.textContent = t('Grant access')
      grant.addEventListener('click', () => { if (libSource) void loadLibrary(libSource) })
      libNote.append(msg, grant)
      return
    }
    if (libState === 'error' || !libFile) { libNote.textContent = libError; return }
    const file = libFile
    const all = libraryItems(file.doc)
    const items = all.filter((s) => matches(s.name, q))
    if (!all.length) { libNote.textContent = t('Your library is empty — save a selection to it to reuse it in any deck.'); return }
    if (!items.length) { libNote.textContent = t('No matching items.'); return }
    for (const item of items) {
      const thumb = renderLibraryItemThumb(item, file.doc, 120)
      if (!thumb) continue // one corrupt item skips, never breaks the picker
      const name = item.name ?? t('Untitled')
      libGrid.appendChild(buildItemCell({
        thumb, name,
        onInsert: (cell) => { cell.disabled = true; const added = insertLibraryItem(store, item, file.doc); cell.disabled = false; inserted(added) },
        actions: [{ label: ICONS.objects, title: t('Add to this deck’s objects'), onClick: () => addToDeck(item, file) }],
      }))
    }
  }

  function renderAll() {
    const q = input.value.trim().toLowerCase()
    renderDeck(q)
    renderLibrary(q)
  }

  async function loadLibrary(src: LibrarySource, mode: 'read' | 'readwrite' = 'read') {
    libSource = src
    libState = 'loading'
    renderLibrary(input.value.trim().toLowerCase())
    const loaded = await loadLibraryFile(src, mode)
    if (loaded.ok) { libFile = loaded.file; libState = 'ready' }
    else { libFile = null; libState = loaded.needsPermission ? 'permission' : 'error'; libError = loaded.error }
    renderLibrary(input.value.trim().toLowerCase())
  }

  async function saveToLibrary(obj: Slide) {
    const name = promptName(t('Name this library item'), obj.name ?? t('Untitled object'))
    if (name == null) return
    // Re-read with write permission: another deck may have changed the file
    // since this popover loaded it, and the write splices the whole doc.
    const src = libSource ?? await chooseLibrarySource()
    if (!src) return
    const loaded = await loadLibraryFile(src, 'readwrite')
    if (!loaded.ok) { status.textContent = loaded.error; return }
    const ok = await saveElementsToLibrary(loaded.file, obj.elements, store.doc, name, obj.background)
    status.textContent = ok ? t('Saved to library') : t("Couldn't save to that library file")
    if (ok) { libSource = src; libFile = loaded.file; libState = 'ready'; renderLibrary(input.value.trim().toLowerCase()) }
  }

  function addToDeck(item: Slide, file: LibraryFile) {
    const obj = promoteToReusableObject(store, item.elements, item.name, file.doc)
    status.textContent = obj ? t('Added to this deck’s objects') : t("Couldn't insert that item.")
  }

  let debounce: ReturnType<typeof setTimeout> | undefined
  input.addEventListener('input', () => {
    clearTimeout(debounce)
    debounce = setTimeout(renderAll, 200)
  })
  // A deck object added from the library shows up in the first section.
  const offDoc = store.on('doc', () => { if (pop.isConnected) renderDeck(input.value.trim().toLowerCase()) })

  const closePop = mountPopover(pop, anchor)
  const close = () => { offDoc(); closePop() }
  new MutationObserver((_m, obs) => { if (!pop.isConnected) { offDoc(); obs.disconnect() } })
    .observe(document.body, { childList: true })
  input.focus()
  renderAll()
  void (async () => {
    const src = await currentLibrarySource()
    if (src) await loadLibrary(src)
    else { libState = 'none'; renderLibrary(input.value.trim().toLowerCase()) }
  })()
}
