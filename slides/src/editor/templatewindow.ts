// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// slidomingo/desktop ONLY: template windows (docs/DECISIONS.md 2026-09-28).
//
// A template window is bound to a TEMPLATE FILE in the templates folder
// (desktop windows.ts `role: 'template'`, opened by Edit Template). It boots
// straight into the Layout Manager and autosaves back into that file — the
// editor's `templateMode` (editor.ts) writes `templateFileDoc(doc)`, so the
// file stays a template. An ordinary open of a template still starts a new
// draft based on it; only an explicit Edit Template binds the file.
//
// This module holds the pieces that run outside an Editor too: the template
// name dialog (shared with the editor's Save as template), the hand-off
// that ends every Create template option on desktop (createTemplateFrom —
// it runs on the start page, before any editor exists), and a toast with
// one action ("Edit it").

import { newTemplateDoc, stampAsTemplate, type SlidomingoDoc } from '../model'
import { serializeFile } from '../save'
import { t } from '../i18n'

export interface TemplateOptionsPrompt {
  heading: string
  intro: string
  name: string
  okLabel: string
  /** Offer "Include slides" (None / Current slides as samples) for this
   *  many slides; omitted = name only. */
  slideCount?: number
}

/** Name (+ optionally "Include slides") for a template. Null = cancelled. */
export function promptTemplateOptions(o: TemplateOptionsPrompt): Promise<{ name: string; samples: boolean } | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog')
    dlg.className = 'ed-dialog ed-pwdialog ed-tmpldialog'
    const h = document.createElement('h2')
    h.textContent = o.heading
    const p = document.createElement('p')
    p.textContent = o.intro
    const nameLabel = document.createElement('label')
    nameLabel.textContent = t('Layout name')
    const nameIn = document.createElement('input')
    nameIn.type = 'text'
    nameIn.value = o.name
    nameLabel.appendChild(nameIn)
    dlg.append(h, p, nameLabel)
    if (o.slideCount != null) {
      const fs = document.createElement('fieldset')
      const legend = document.createElement('legend')
      legend.textContent = t('Include slides')
      fs.appendChild(legend)
      const radio = (value: string, label: string, checked: boolean) => {
        const l = document.createElement('label')
        l.className = 'ed-radio'
        const r = document.createElement('input')
        r.type = 'radio'; r.name = 'tmpl-samples'; r.value = value; r.checked = checked
        l.append(r, document.createTextNode(' ' + label))
        fs.appendChild(l)
      }
      radio('none', t('None — slide types & theme only'), true)
      radio('samples', t('Current slides as samples ({n})', { n: String(o.slideCount) }), false)
      dlg.appendChild(fs)
    }
    const actions = document.createElement('div')
    actions.className = 'ed-dialog-actions'
    const cancel = document.createElement('button')
    cancel.textContent = t('Cancel')
    const ok = document.createElement('button')
    ok.className = 'ed-primary'
    ok.textContent = o.okLabel
    actions.append(cancel, ok)
    dlg.appendChild(actions)
    document.body.appendChild(dlg)
    const done = (v: { name: string; samples: boolean } | null) => { dlg.close(); dlg.remove(); resolve(v) }
    const submit = () => {
      const name = nameIn.value.trim()
      if (!name) { nameIn.focus(); return }
      const samples = (dlg.querySelector('input[name="tmpl-samples"]:checked') as HTMLInputElement | null)?.value === 'samples'
      done({ name, samples })
    }
    cancel.addEventListener('click', () => done(null))
    ok.addEventListener('click', submit)
    nameIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit() })
    dlg.addEventListener('cancel', () => done(null))
    dlg.showModal()
    nameIn.focus()
    nameIn.select()
  })
}

/** Whether this window can write template files and become a template's
 *  window (desktop only) — what the Create template flow's options need to
 *  end in a real template rather than a deck. */
export function canCreateTemplateFiles(): boolean {
  const api = window.slidomingoDesktop
  return !!(api?.saveTemplate && api.editTemplate)
}

/**
 * The template hand-off every "new template" path ends in: ask for a name
 * (pre-filled with `opts.name`), stamp `source` as a template
 * (model.stampAsTemplate — `samples: false` keeps only its slide types and
 * theme), write it into the templates folder, then turn THIS window into
 * its template window (main replaces the document in place). Resolves true
 * once main took the hand-off — the page is about to be replaced — false
 * when cancelled or when it failed (`onError` says why).
 */
export async function createTemplateFrom(
  source: SlidomingoDoc,
  opts: { name?: string; samples: boolean; onError?: (message: string) => void },
): Promise<boolean> {
  const api = window.slidomingoDesktop
  if (!api?.saveTemplate || !api.editTemplate) return false
  const choice = await promptTemplateOptions({
    heading: t('New layout'),
    intro: t('A layout holds slide types, a theme and the pictures and fonts they use. You design it in the Layout Manager; every deck started from it is independent.'),
    name: opts.name ?? '',
    okLabel: t('Create layout'),
  })
  if (!choice) return false
  const fail = () => { opts.onError?.(t('Couldn’t create the layout')); return false }
  let path: string | null = null
  try {
    const tmpl = stampAsTemplate({ ...source, title: choice.name }, { samples: opts.samples })
    path = await api.saveTemplate(serializeFile(tmpl), choice.name)
  } catch { /* below */ }
  if (!path) return fail()
  let handedOff = false
  try { handedOff = await api.editTemplate(path, { replace: true }) } catch { /* below */ }
  return handedOff || fail()
}

/** The Create template flow's "Empty template": the built-in slide types,
 *  no samples (model.newTemplateDoc). */
export function createNewTemplate(opts: { onError?: (message: string) => void } = {}): Promise<boolean> {
  return createTemplateFrom(newTemplateDoc(''), { samples: false, onError: opts.onError })
}

/** A toast with one action button (e.g. "Saved as template X · Edit it").
 *  Stays a little longer than a plain toast, so the button can be reached. */
export function actionToast(message: string, label: string, run: () => void): void {
  document.querySelector('.ed-toast, .ed-actiontoast')?.remove()
  const bar = document.createElement('div')
  bar.className = 'ed-recover ed-actiontoast'
  bar.setAttribute('role', 'status')
  const msg = document.createElement('span')
  msg.textContent = message
  const b = document.createElement('button')
  b.className = 'ed-btn ed-btn-primary'
  b.textContent = label
  b.addEventListener('click', () => { bar.remove(); run() })
  const x = document.createElement('button')
  x.className = 'ed-btn'
  x.textContent = '✕'
  x.title = t('Close')
  x.addEventListener('click', () => bar.remove())
  bar.append(msg, b, x)
  document.body.appendChild(bar)
  setTimeout(() => bar.remove(), 8000)
}
