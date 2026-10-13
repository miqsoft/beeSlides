// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The Library panel — where the GLOBAL element library is managed, opened
// from the slide editor's toolbar/ribbon (docs/DECISIONS.md 2026-09-28,
// "Scope split: Layout Manager = this file; Library = global registry in the
// editor"). It used to be the Layout Manager's "Shape library" tab; it moved
// out because the library is not part of any document, and the Layout
// Manager only shows what is saved in this file.
//
// One popover: which file (Choose file…, or on desktop back to the default
// library), search, and a grid where a click inserts and each item can be
// renamed, added to this deck's objects, or deleted. Everything goes through
// library.ts's source/load/write helpers, so the permission and splice rules
// live in one place. The file is loaded 'readwrite' from the start: this
// panel exists to change it, and a browser asks for write access separately.

import type { Slide } from '../model'
import type { Store } from '../store'
import { ICONS } from '../icons'
import { t } from '../i18n'
import {
  buildItemCell, canChooseLibraryFile, chooseLibrarySource, currentLibrarySource, deleteLibraryItem, insertLibraryItem,
  isDesktopLibrary, libraryItems, loadLibraryFile, mountPopover, renameLibraryItem, renderLibraryItemThumb,
  useDefaultLibrarySource, type LibraryFile, type LibrarySource,
} from './library'
import { promoteToReusableObject } from './reusableobjects'
import { openSaveSelectionDialog } from './saveselection'

export function openLibraryPanel(store: Store, anchor: HTMLElement): void {
  const pop = div('ed-library-pop ed-library-panel')

  const head = div('ed-library-pop-head')
  const fileLabel = div('ed-library-file')
  const chooseBtn = btn(t('Choose file…'), () => void choose(), t('Pick a BeeSlides file to use as your library'))
  const defaultBtn = btn(t('Use default library'), () => void useDefault(), t('Go back to the library the app keeps next to your layouts'))
  defaultBtn.hidden = true
  head.append(fileLabel, defaultBtn, chooseBtn)
  pop.appendChild(head)

  const toolRow = div('ed-library-pop-head')
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'ed-library-search'
  input.placeholder = t('Search library items…')
  const saveBtn = btn(t('Save selection…'), () => void saveSelection(), t('Save the selected elements to the library or to this deck’s objects')) as HTMLButtonElement
  toolRow.append(input, saveBtn)
  pop.appendChild(toolRow)

  const status = div('ed-library-status')
  const grid = div('ed-library-grid')
  pop.append(status, grid)

  let source: LibrarySource | null = null
  let file: LibraryFile | null = null

  function setFileLabel() {
    fileLabel.textContent = file ? file.fileName : t('No library file chosen')
    fileLabel.title = file ? file.fileName : ''
    defaultBtn.hidden = !(isDesktopLibrary() && source && !source.isDefault)
  }

  function renderGrid() {
    grid.innerHTML = ''
    if (!file) return
    const lib = file
    const q = input.value.trim().toLowerCase()
    const all = libraryItems(lib.doc)
    const items = all.filter((s) => !q || (s.name ?? '').toLowerCase().includes(q))
    status.textContent = !all.length
      ? t('Your library is empty — save a selection to it to reuse it in any deck.')
      : items.length ? '' : t('No matching items.')
    for (const item of items) {
      const thumb = renderLibraryItemThumb(item, lib.doc, 120)
      if (!thumb) continue // one corrupt item skips, never breaks the panel
      const cell = buildItemCell({
        thumb,
        name: item.name ?? t('Untitled'),
        onInsert: (b) => {
          b.disabled = true
          const added = insertLibraryItem(store, item, lib.doc)
          b.disabled = false
          if (!added.length) { status.textContent = t("Couldn't insert that item."); return }
          store.select(added.map((e) => e.id))
          status.textContent = added.length === 1 ? t('Inserted 1 item') : t('Inserted {n} elements', { n: added.length })
        },
        actions: [
          { label: '✎', title: t('Rename'), onClick: () => startRename(cell, item) },
          { label: ICONS.objects, title: t('Add to this deck’s objects'), onClick: () => addToDeck(item) },
          { label: ICONS.trash, title: t('Delete this item'), onClick: () => void remove(item) },
        ],
      })
      grid.appendChild(cell)
    }
  }

  /** Swap the item's label for an input; Enter/blur saves, Esc cancels. */
  function startRename(cell: HTMLElement, item: Slide) {
    const label = cell.querySelector<HTMLElement>('.ed-library-item-name')
    if (!label || !file) return
    const lib = file
    const nameIn = document.createElement('input')
    nameIn.type = 'text'
    nameIn.className = 'ed-library-rename'
    nameIn.value = item.name ?? t('Untitled')
    let done = false
    const finish = async (commit: boolean) => {
      if (done) return
      done = true
      const name = nameIn.value.trim() || t('Untitled')
      if (commit && name !== (item.name ?? t('Untitled'))) {
        if (!(await renameLibraryItem(lib, item, name))) {
          window.alert(t('Couldn’t save that change — the library file may have lost permission, or moved.'))
        }
      }
      renderGrid()
    }
    nameIn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); void finish(true) }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); void finish(false) }
    })
    nameIn.addEventListener('blur', () => void finish(true))
    nameIn.addEventListener('click', (ev) => ev.stopPropagation())
    // The label sits inside the insert button: put the input beside it.
    cell.querySelector('.ed-library-item')?.after(nameIn)
    label.hidden = true
    nameIn.focus()
    nameIn.select()
  }

  async function remove(item: Slide) {
    if (!file) return
    if (!window.confirm(t('Delete “{name}” from the library? This can’t be undone.', { name: item.name ?? t('Untitled') }))) return
    if (!(await deleteLibraryItem(file, item))) {
      window.alert(t('Couldn’t save that change — the library file may have lost permission, or moved.'))
    }
    renderGrid()
  }

  function addToDeck(item: Slide) {
    if (!file) return
    const obj = promoteToReusableObject(store, item.elements, item.name, file.doc)
    status.textContent = obj ? t('Added to this deck’s objects') : t("Couldn't insert that item.")
  }

  async function saveSelection() {
    const els = store.selectedElements
    if (!els.length) return
    const where = await openSaveSelectionDialog(store, els, { initial: 'library' })
    if (where === 'library') await load(source ?? await currentLibrarySource())
  }

  async function load(src: LibrarySource | null) {
    source = src
    file = null
    grid.innerHTML = ''
    if (!src) {
      setFileLabel()
      status.textContent = canChooseLibraryFile()
        ? t('Choose a library file to browse its items.')
        : t('This browser can’t keep a library file — use Chrome, Edge or the desktop app.')
      return
    }
    status.textContent = t('Loading…')
    const loaded = await loadLibraryFile(src, 'readwrite')
    if (!loaded.ok) {
      setFileLabel()
      status.innerHTML = ''
      if (loaded.needsPermission) {
        const msg = document.createElement('span')
        msg.textContent = t('This file needs permission again — ')
        const grant = btn(t('Grant access'), () => void load(src))
        status.append(msg, grant)
      } else {
        status.textContent = loaded.error
      }
      return
    }
    file = loaded.file
    setFileLabel()
    renderGrid()
  }

  async function choose() {
    const src = await chooseLibrarySource()
    if (src) await load(src)
  }

  async function useDefault() {
    const src = await useDefaultLibrarySource()
    if (src) await load(src)
  }

  const syncSave = () => { saveBtn.disabled = !store.selectedElements.length }
  syncSave()
  const offSel = store.on('selection', syncSave)

  let debounce: ReturnType<typeof setTimeout> | undefined
  input.addEventListener('input', () => {
    clearTimeout(debounce)
    debounce = setTimeout(renderGrid, 200)
  })

  chooseBtn.hidden = !canChooseLibraryFile()
  setFileLabel()
  mountPopover(pop, anchor)
  new MutationObserver((_m, obs) => { if (!pop.isConnected) { offSel(); obs.disconnect() } })
    .observe(document.body, { childList: true })
  input.focus()
  void (async () => load(await currentLibrarySource()))()
}

// tiny DOM helpers (each editor/*.ts file keeps its own copy — see editor.ts)
function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}
function btn(label: string, onClick: () => void, title?: string): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-btn'
  b.textContent = label
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}
