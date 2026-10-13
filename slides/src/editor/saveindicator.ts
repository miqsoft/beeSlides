// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The shared Save-button-plus-dirty-dot cluster, and the "Saved"/"Backed up
// in this browser" flash tag beside a title. Used by the main editor's web
// topbar AND desktop ribbon (previously two byte-for-byte hand-duplicated
// copies) and by the Layout Manager overlay's own head bar — every action
// here only ever touches `store.dirty`/the `onSave` callback handed in, so
// the same builder works unmodified against whichever surface mounts it.
//
// Modeled on insertgroup.ts's `buildInsertGroup` idiom: build nodes, hand
// them back for the caller to place.

import type { Store } from '../store'
import { canWriteInPlace } from '../save'
import type { DesktopDocStatus } from './desktopdoc'
import { ICONS } from '../icons'
import { t } from '../i18n'

export interface SaveIndicator {
  /** Save button with the dirty dot appended onto it — place in any topbar/head bar. */
  root: HTMLElement
  /** The "Saved"/"Backed up in this browser" tag — place beside a title element. */
  flashTag: HTMLElement
  /** Exposed so a caller can still update its tooltip dynamically (e.g. the
   *  "kept in this browser at {when}" wording in editor.ts's runAutosave). */
  dirtyDot: HTMLElement
  /** Show the flash tag with the existing fade-in/out timers. */
  flash(message?: string): void
  /** Unsubscribe from the store. */
  destroy(): void
}

/** The desktop's shared save status (editor/desktopdoc.ts). When supplied,
 *  the flash tag becomes a PERSISTENT status label — the file is always
 *  saved there, so "Saved" is a state to show, not an event to flash — and
 *  every indicator built with it (main bar, Layout Manager bar) reads the
 *  same value. */
export interface SaveStatusSource {
  status(): DesktopDocStatus
  error(): string | null
  on(cb: () => void): () => void
}

export function buildSaveIndicator(store: Store, onSave: () => void, source?: SaveStatusSource): SaveIndicator {
  const dirtyDot = div('ed-dirty')
  dirtyDot.title = canWriteInPlace()
    ? t('Unsaved changes — ⌘S saves this file in place')
    : t('Unsaved changes — ⌘S downloads an updated copy (this browser can’t rewrite the file)')

  const root = btn(ICONS.save, t('Save'), () => onSave(), canWriteInPlace()
    ? t('Save — rewrite this file in place (⌘S)')
    : t('Save — download an updated copy (⌘S). This browser can’t rewrite the open file.'))
  // `.ed-dirty` positions itself absolutely against the nearest positioned
  // ancestor — normally supplied by `.ed-split > .ed-btn:first-child` when
  // Save sits beside its dropdown caret (main topbar/ribbon), but a caller
  // without that dropdown (the Layout Manager head bar) needs it set here
  // directly instead.
  root.style.position = 'relative'
  root.appendChild(dirtyDot) // the amber unsaved-changes dot lives ON Save

  const flashTag = div('ed-autosaved')
  flashTag.hidden = true

  const off = store.on('dirty', () => {
    dirtyDot.classList.toggle('on', store.dirty)
  })

  let savedTimer = 0
  let savedHideTimer = 0
  function flash(message = t('Saved')) {
    flashTag.textContent = message
    // hidden while idle: at opacity 0 the tag still held its width, so after
    // the first backup the title permanently lost the space this text needs
    flashTag.hidden = false
    void flashTag.offsetWidth // paint a frame at opacity 0 so the fade-in runs
    flashTag.classList.add('show')
    clearTimeout(savedTimer)
    clearTimeout(savedHideTimer)
    savedTimer = window.setTimeout(() => flashTag.classList.remove('show'), 1400)
    // leave layout only after the 0.25s fade-out has finished
    savedHideTimer = window.setTimeout(() => { flashTag.hidden = true }, 1700)
  }

  function destroy() {
    off()
    offStatus()
    clearTimeout(savedTimer)
    clearTimeout(savedHideTimer)
  }

  let offStatus = () => {}
  if (source) {
    const label = root.querySelector('span')
    const sync = () => {
      const st = source.status()
      // Draft = not a file yet: the button's job is to give it one.
      if (label) label.textContent = st === 'draft' ? t('Save as…') : t('Save')
      root.title = st === 'draft'
        ? t('This deck is a draft, kept automatically — Save as… gives it a name and a place (⌘S)')
        : t('Saved automatically — ⌘S also marks a version you can go back to')
      if (flashTag.dataset.flashing) return
      flashTag.textContent = statusText(st)
      flashTag.title = st === 'error' ? (source.error() ?? '') : ''
      flashTag.hidden = false
      flashTag.classList.add('show', 'ed-savestatus')
      flashTag.dataset.state = st
      // the dot is noise when every edit lands on disk seconds later — keep
      // it for the states that need attention
      dirtyDot.hidden = !(st === 'error' || st === 'conflict' || st === 'missing')
    }
    sync()
    offStatus = source.on(sync)
    const persistentFlash = (message = t('Saved')) => {
      flashTag.dataset.flashing = '1'
      flashTag.textContent = message
      clearTimeout(savedTimer)
      savedTimer = window.setTimeout(() => { delete flashTag.dataset.flashing; sync() }, 1600)
    }
    return { root, flashTag, dirtyDot, flash: persistentFlash, destroy }
  }

  return { root, flashTag, dirtyDot, flash, destroy }
}

function statusText(st: DesktopDocStatus): string {
  switch (st) {
    case 'saving': return t('Saving…')
    case 'draft': return t('Draft')
    case 'error': return t('Couldn’t save')
    case 'conflict': return t('Changed on disk')
    case 'missing': return t('File moved or deleted')
    default: return t('Saved')
  }
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
  b.innerHTML = label ? `${icon}<span>${label}</span>` : icon
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}
