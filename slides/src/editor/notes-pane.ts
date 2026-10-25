// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// PowerPoint-style speaker notes pane, docked below the canvas. Plain text
// only (Slide.notes: string) — no rich text, no format changes.

import type { Store } from '../store'
import { t } from '../i18n'
import { isMacOS } from '../screens'
import { liveStep } from './livestep'

export class NotesPane {
  readonly el: HTMLElement
  private textarea: HTMLTextAreaElement

  constructor(private store: Store, host: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'ed-notes-pane'
    const head = document.createElement('div')
    head.className = 'ed-notes-pane-head'
    head.textContent = t('Speaker notes')
    this.textarea = document.createElement('textarea')
    this.textarea.className = 'ed-notes-pane-text'
    this.textarea.placeholder = t('Notes for presenter view (press S while presenting)…')
    this.textarea.title = t('Shown in the speaker view (Slideshow menu, or S while presenting).') +
      (isMacOS() ? ' ' + t('On macOS, open the speaker view before going fullscreen.') : '')
    this.el.append(head, this.textarea)
    host.appendChild(this.el)

    const sync = () => { this.textarea.value = this.store.slide.notes }
    sync()
    this.store.on('current', sync)
    this.store.on('doc', () => { if (document.activeElement !== this.textarea) sync() })
    this.textarea.addEventListener('input', () => this.edit(false))
    this.textarea.addEventListener('change', () => this.edit(true))
  }

  private burst = false
  /** checkpoint once per burst of continuous input, commit on change — same
   *  shape as panels.ts's private `edit()`, reimplemented here since NotesPane
   *  isn't a panel subclass. */
  private edit(final: boolean) {
    if (!this.burst) { this.store.checkpoint(); this.burst = true }
    this.store.slide.notes = this.textarea.value
    if (final) { this.burst = false; this.store.recordAction() }
    // Notes show on neither the canvas nor the props panel: a keystroke's
    // redraws wait for the next frame (livestep.ts); the final step (change,
    // on blur) is the ordinary synchronous commit.
    liveStep(final, () => this.store.touch())
  }
}
