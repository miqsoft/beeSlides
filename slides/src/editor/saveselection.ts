// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// "Save selection…" — the one save entry point for both scopes
// (docs/DECISIONS.md 2026-09-28, "Scope split"): a name, then WHERE —
// **This deck's objects** (`doc.reusableObjects`, saved in the file,
// reusableobjects.ts's `promoteToReusableObject`) or **Library** (the global
// library file, library.ts's `saveElementsToLibrary`). Opened from the editor
// toolbar/ribbon, the element context menu and the Library panel. The last
// choice is remembered per viewer (localStorage), never in the document.

import type { SlideElement } from '../model'
import type { Store } from '../store'
import { lsGet, lsSet } from '../../../kernel/src/storage.ts'
import { t } from '../i18n'
import { promoteToReusableObject } from './reusableobjects'
import { chooseLibrarySource, currentLibrarySource, loadLibraryFile, saveElementsToLibrary } from './library'

export type SaveScope = 'deck' | 'library'

const SCOPE_KEY = 'slidomingo-save-selection-scope'

/** Resolves to where it was saved, or `null` when cancelled or it failed
 *  (a toast says which). `initial` overrides the remembered choice. */
export function openSaveSelectionDialog(store: Store, els: SlideElement[], opts: { initial?: SaveScope } = {}): Promise<SaveScope | null> {
  return new Promise((resolve) => {
    if (!els.length) { resolve(null); return }
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about ed-newtype-box ed-saveselection')
    const h = document.createElement('h2')
    h.textContent = t('Save selection')
    box.appendChild(h)

    const nameRow = document.createElement('label')
    nameRow.className = 'ed-row'
    const nameSpan = document.createElement('span')
    nameSpan.textContent = t('Name')
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.placeholder = t('e.g. “Logo with tagline”')
    nameRow.append(nameSpan, nameInput)
    box.appendChild(nameRow)

    const modeRow = div('ed-newtype-mode')
    const modeBtn = (label: string) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-btn ed-newtype-modebtn'
      b.textContent = label
      modeRow.appendChild(b)
      return b
    }
    const buttons: Record<SaveScope, HTMLButtonElement> = {
      deck: modeBtn(t('This deck’s objects')),
      library: modeBtn(t('Library')),
    }
    box.appendChild(modeRow)
    const explain = document.createElement('p')
    explain.className = 'ed-hint ed-newtype-explain'
    box.appendChild(explain)

    const remembered = lsGet(SCOPE_KEY)
    let scope: SaveScope = opts.initial ?? (remembered === 'library' ? 'library' : 'deck')
    const setScope = (s: SaveScope) => {
      scope = s
      for (const [k, b] of Object.entries(buttons)) b.classList.toggle('active', k === s)
      explain.textContent = s === 'deck'
        ? t('Saved inside this file — it travels with the deck. Manage it in the Layout Manager’s Objects tab.')
        : t('Saved to your library file — reuse it in any deck. Manage it from the Library button.')
    }
    for (const [k, b] of Object.entries(buttons)) b.addEventListener('click', () => setScope(k as SaveScope))
    setScope(scope)

    const actions = div('ed-dialog-actions')
    const cancel = document.createElement('button')
    cancel.className = 'ed-btn'
    cancel.textContent = t('Cancel')
    cancel.addEventListener('click', () => { close(); resolve(null) })
    const save = document.createElement('button')
    save.className = 'ed-btn ed-btn-primary'
    save.textContent = t('Save')
    const submit = () => {
      const name = nameInput.value.trim()
      lsSet(SCOPE_KEY, scope)
      close()
      // Straight off the click: a library write may need a file picker or a
      // permission prompt, and both require this user gesture.
      void saveTo(store, els, scope, name).then(resolve)
    }
    save.addEventListener('click', submit)
    nameInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit() } })
    actions.append(cancel, save)
    box.appendChild(actions)

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); resolve(null) } }
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) { close(); resolve(null) } })
    document.addEventListener('keydown', onKey, true)

    overlay.appendChild(box)
    document.body.appendChild(overlay)
    nameInput.focus()
  })
}

async function saveTo(store: Store, els: SlideElement[], scope: SaveScope, name: string): Promise<SaveScope | null> {
  if (scope === 'deck') {
    const obj = promoteToReusableObject(store, els, name || undefined)
    toast(obj ? t('Saved to this deck’s objects') : t("Couldn't save that selection"))
    return obj ? 'deck' : null
  }
  const src = (await currentLibrarySource()) ?? (await chooseLibrarySource())
  if (!src) return null
  const loaded = await loadLibraryFile(src, 'readwrite')
  if (!loaded.ok) { toast(loaded.error); return null }
  const ok = await saveElementsToLibrary(loaded.file, els, store.doc, name || t('Untitled'), store.slide.background)
  toast(ok ? t('Saved to library') : t("Couldn't save to that library file"))
  return ok ? 'library' : null
}

// tiny DOM helpers (each editor/*.ts file keeps its own copy — see editor.ts)
function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}
function toast(message: string) {
  document.querySelector('.ed-toast')?.remove()
  const el = document.createElement('div')
  el.className = 'ed-toast'
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.classList.add('show'))
  setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => el.remove(), 300)
  }, 2600)
}
