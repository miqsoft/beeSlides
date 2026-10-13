// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// slidomingo/desktop ONLY: the Layout Manager's "Save to template ▾" menu —
// the one explicit, separate way a deck's slide types leave the deck.
//
// Edits made in the Layout Manager apply to THIS deck and autosave with it
// (the header says so). Reuse is a deliberate second step, and it moves the
// DESIGN layer only (slide types, theme, fonts, reusable objects and the
// assets those use — docs/DECISIONS.md 2026-09-24):
//   - Update "X"               deck → the template it was started from
//                               (model.mergeTemplateDesign; the template's
//                               sample slides are kept, existing decks made
//                               from it are NOT changed)
//   - Save as new template…    the editor's Save-as-template dialog
//   - Update this deck from "X" template → deck (model.adoptTemplateDesign +
//                               resyncLinkedSlides, one undoable commit)
//   - Edit "X" in its own window  the template FILE in a template window
//                               (editor/templatewindow.ts) — for changes that
//                               belong to the template, not to this deck
//
// "X" is `doc.basedOn` resolved against the templates folder's metadata
// (model.resolveBasedOn: by templateId, else by filename for legacy
// templates). A deck not based on any template only gets "Save as new".

import type { Store } from '../store'
import {
  adoptTemplateDesign, layoutElementIds, mergeTemplateDesign, parseTemplateDoc, resolveBasedOn, resyncLinkedSlides,
  type SlidomingoDoc,
} from '../model'
import { isEncryptionActive, serializeFile } from '../save'
import { ICONS } from '../icons'
import { t } from '../i18n'
import { showLoading } from '../brand'
import { flipMenuIfNeeded } from './floatingposition'
import { refuseGatedWrite, refuseNewerDoc } from '../formatgate'

type TemplateMeta = { path: string; templateId: string | null; name: string }

/** Ask the editor to run its Save-as-template dialog (editor.ts listens). */
export const SAVE_AS_TEMPLATE_EVENT = 'slidomingo:save-as-template'

export function buildSaveToTemplateMenu(store: Store): HTMLElement {
  const wrap = div('ed-dropdown ed-tmplmenu')
  const menu = div('ed-menu')
  const trigger = btn(ICONS.template, t('Save to layout'), () => {
    wrap.classList.toggle('open')
    if (wrap.classList.contains('open')) void rebuild()
  }, t('Reuse these slide types in other decks — update the layout this deck came from, or save a new one'))
  trigger.insertAdjacentHTML('beforeend', '<span class="ed-caret">▾</span>')
  wrap.append(trigger, menu)
  document.addEventListener('pointerdown', (ev) => {
    if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
  })

  const close = () => wrap.classList.remove('open')
  const item = (label: string, title: string, run: () => void) => {
    const b = btn('', label, () => { close(); run() }, title)
    menu.appendChild(b)
    return b
  }

  async function rebuild() {
    menu.textContent = ''
    const loading = div('ed-menu-empty')
    showLoading(loading, t('Loading…'))
    menu.appendChild(loading)
    flipMenuIfNeeded(wrap, menu)
    let metas: TemplateMeta[] = []
    try { metas = (await window.slidomingoDesktop?.listTemplateMeta?.()) ?? [] } catch { /* none */ }
    menu.textContent = ''
    const match = resolveBasedOn(store.doc.basedOn, metas)
    if (match) {
      item(t('Update “{name}”', { name: match.name }),
        t('Write this deck’s slide types and theme into the layout. Decks already made from it don’t change.'),
        () => void updateTemplate(store, match))
    }
    item(t('Save as new layout…'),
      t('A new layout with this deck’s slide types and theme — optionally with its slides as samples'),
      () => document.dispatchEvent(new CustomEvent(SAVE_AS_TEMPLATE_EVENT)))
    if (match) {
      menu.appendChild(div('ed-menu-sep'))
      item(t('Update this deck from “{name}”', { name: match.name }),
        t('Bring the layout’s current slide types and theme into this deck. Linked slides follow; ⌘Z undoes.'),
        () => void updateDeckFromTemplate(store, match))
      if (window.slidomingoDesktop?.editTemplate) {
        item(t('Edit “{name}” in its own window', { name: match.name }),
          t('Open the layout itself in a new window — its changes save into the layout file. This deck stays open; bring them in later with “Update this deck from…”.'),
          () => void window.slidomingoDesktop?.editTemplate?.(match.path))
      }
    }
    flipMenuIfNeeded(wrap, menu)
  }

  return wrap
}

/** The template's document, or null after telling the author why not
 *  (unreadable, or made by a newer BeeSlides — the reader gate: nothing of
 *  it may be merged in either direction). */
async function loadTemplateDoc(meta: TemplateMeta): Promise<SlidomingoDoc | null> {
  const raw = await window.slidomingoDesktop?.loadTemplate?.(meta.path)
  const doc = raw ? parseTemplateDoc(raw) : null
  if (!doc) { toast(t('Couldn’t read the layout “{name}”', { name: meta.name })); return null }
  if (refuseNewerDoc(doc, meta.name, toast)) return null
  return doc
}

/** Deck → template ("Update X"). */
async function updateTemplate(store: Store, meta: TemplateMeta) {
  if (refuseGatedWrite(toast)) return
  if (isEncryptionActive()) { toast(t('A password-protected deck can’t update a layout — its design would be saved unencrypted.')); return }
  if (!confirm(t('Update the layout “{name}” with this deck’s slide types and theme?\n\nDecks already made from it don’t change. Its sample slides are kept.', { name: meta.name }))) return
  const tmpl = await loadTemplateDoc(meta)
  if (!tmpl) return
  const merged = mergeTemplateDesign(tmpl, store.doc)
  if ('error' in merged) { toast(t('The layout has a different slide size — it can’t take this deck’s slide types')); return }
  const ok = await window.slidomingoDesktop?.updateTemplate?.(meta.path, serializeFile(merged))
  if (!ok) { toast(t('Couldn’t update the layout “{name}”', { name: meta.name })); return }
  // A legacy template just got its id: record it, so this deck keeps
  // finding the template even if the file is renamed.
  const b = store.doc.basedOn
  if (merged.templateId && (b?.templateId !== merged.templateId || b?.name !== meta.name)) {
    store.doc.basedOn = { templateId: merged.templateId, name: meta.name }
    store.touch()
  }
  toast(t('Updated the layout “{name}”', { name: meta.name }))
}

/** Template → deck ("Update this deck from X"). */
async function updateDeckFromTemplate(store: Store, meta: TemplateMeta) {
  const tmpl = await loadTemplateDoc(meta)
  if (!tmpl) return
  if (tmpl.size?.width !== store.doc.size?.width || tmpl.size?.height !== store.doc.size?.height) {
    toast(t('The layout has a different slide size — its slide types can’t be used here'))
    return
  }
  let changed = 0
  store.commit(() => {
    const doc = store.doc
    const before = layoutElementIds(doc)
    const r = adoptTemplateDesign(doc, tmpl)
    if ('error' in r) return
    const known = new Set([...before, ...layoutElementIds(doc)])
    for (const id of r.layoutIds) resyncLinkedSlides(doc, id, known)
    changed = r.layoutIds.length
    if (tmpl.templateId) doc.basedOn = { templateId: tmpl.templateId, name: meta.name }
  }, 'slides')
  toast(t('Updated {n} slide types from “{name}” — ⌘Z undoes', { n: String(changed), name: meta.name }))
}

// tiny DOM helpers (each editor/*.ts file keeps its own copy — see editor.ts)
function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}
function btn(icon: string, label: string, onClick: (ev: MouseEvent) => void, title?: string): HTMLElement {
  const b = document.createElement('button')
  b.className = 'ed-btn'
  b.innerHTML = icon
  if (label) b.appendChild(Object.assign(document.createElement('span'), { textContent: label }))
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
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
  }, 3200)
}
