// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// "Apply to…" — scoped retargeting for a slide-type edit, opened from the
// Slide types sub-editor's breadcrumb (layoutmanager.ts).
//
// KEY FRAMING: by the time this dialog is reachable, every currently-linked
// slide has ALREADY live-received the edit — editor.ts's syncLayoutInstances
// resyncs every linked slide on every 'doc' event while the sub-editor is
// open, unconditionally, before this is ever opened. So this is not
// "preview before applying," it's retroactive scoping: "of the slides that
// already got this for free, which should keep tracking it going forward,
// and should the shared template itself be overwritten (no-op) or forked
// into a new named slide type?"
//
// v1 deliberately never reverts a deselected slide's visual content or
// touches its layoutId — it already has the live edit. Deselecting only
// matters when "Save as new" is chosen: unselected slides are left exactly
// as they are, silently remaining linked to the original (now
// unedited-going-forward) template. See docs/DECISIONS.md (2026-09-18,
// "Layout Manager: scoped 'Apply to…' workflow for slide-type edits") for
// the full design writeup and the deferred v2 (pre-edit snapshot + real
// revert).
//
// 2026-09-20 (see docs/DECISIONS.md): `Master`/`doc.masters` are gone, and
// with them `openApplyToMaster` — its whole reason to exist was to scope a
// building-blocks edit across a master's WHOLE governed family, a scope
// `openApplyTo` couldn't reach on its own. Now that a former "master" is
// just a root `doc.layouts` entry, `linkedSlides(doc, layoutId)` already
// walks the FULL descendant subtree (see model.ts) — so opening THIS same
// dialog on a root layout already returns every slide anywhere under it,
// direct or several tiers down. `openApplyToMaster` had no remaining job
// distinct from `openApplyTo` and was deleted rather than kept as a
// duplicate code path with no behavior of its own.

import type { Store } from '../store'
import { linkedSlides, uid, type Slide } from '../model'
import { renderThumbnail } from '../render'
import { t } from '../i18n'
import { jsonClone } from '../jsonclone.ts'

/** One selectable row in an Apply-to dialog: a thumbnail + label + optional
 *  blast-radius annotation (e.g. "(3 slides)"), keyed by the id that gets
 *  retargeted onto the fork on commit. */
interface ApplyToRow {
  id: string
  thumbnail: HTMLElement
  label: string
  annotation?: string
}

interface ApplyToConfig {
  /** Unique per dialog instance — scopes the destination radio group's
   *  `name` so two dialogs' radios (were one ever built while another's DOM
   *  lingers) can never cross-toggle. */
  groupKey: string
  rows: ApplyToRow[]
  intro: string
  overwriteLabel: string
  overwriteHint: string
  newLabel: string
  newPlaceholder: string
  /** Shown only once every row is deselected while "Save as new" is chosen —
   *  i.e. the fork would be created but nothing would ever reference it. */
  emptyHint: string
  /** Called once, only when "Save as new" was chosen and Apply is clicked —
   *  "Overwrite" is a pure no-op, so this never runs for it. The callee owns
   *  its own single `store.commit()` (clone + retarget together, one undo
   *  step) since what gets cloned differs per scope. */
  onApply: (selectedIds: Set<string>, newName: string) => void
  onDone: () => void
}

/**
 * Shared builder behind `openApplyTo` (slide-type scope) and
 * `openApplyToMaster` (master scope) — the ~100 lines of dialog boilerplate
 * that would otherwise duplicate line-for-line between the two. Owns the
 * DOM, the checked-by-default row state, the overwrite/fork radio pair, and
 * the single commit/close path.
 *
 * While "Overwrite" is selected (the default), the row list goes INERT —
 * every checkbox disabled, `.ed-applyto-list-inert` on the list — since
 * deselecting a row only ever matters once a fork exists to retarget it
 * onto; `updateDestUI()` runs once at build time (not just on `change`) so
 * the list starts correctly greyed out rather than only graduating to that
 * state after the first radio click. This inert behavior is deliberately a
 * property of the SHARED builder (not slide-type- or master-specific) so it
 * applies identically to both dialogs.
 *
 * Scope-specific copy and the actual clone-and-retarget logic live in the
 * two callers below.
 */
function buildApplyToDialog(cfg: ApplyToConfig): void {
  document.querySelector('.ed-about-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'ed-about-overlay'
  const box = document.createElement('div')
  box.className = 'ed-about ed-applyto-box'

  const h = document.createElement('h2')
  h.textContent = t('Apply changes to…')
  box.appendChild(h)

  const intro = document.createElement('p')
  intro.className = 'ed-about-fine'
  intro.textContent = cfg.intro
  box.appendChild(intro)

  // Checked-by-default — deselecting never reverts anything, it only affects
  // who gets retargeted if "Save as new" is chosen below.
  const selected = new Set(cfg.rows.map((r) => r.id))

  const list = document.createElement('div')
  list.className = 'ed-applyto-list'
  const checkboxes: HTMLInputElement[] = []
  for (const r of cfg.rows) {
    const row = document.createElement('label')
    row.className = 'ed-applyto-row'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = true
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(r.id)
      else selected.delete(r.id)
      updateDestUI()
    })
    checkboxes.push(cb)
    row.appendChild(cb)
    row.appendChild(r.thumbnail)
    const name = document.createElement('span')
    name.className = 'ed-applyto-name'
    name.textContent = r.label
    row.appendChild(name)
    if (r.annotation) {
      const ann = document.createElement('span')
      ann.className = 'ed-applyto-annotation'
      ann.textContent = r.annotation
      row.appendChild(ann)
    }
    list.appendChild(row)
  }
  if (cfg.rows.length) box.appendChild(list)

  const dest = document.createElement('div')
  dest.className = 'ed-applyto-dest'
  const groupName = `applyto-dest-${cfg.groupKey}`

  const overwriteRow = document.createElement('label')
  overwriteRow.className = 'ed-applyto-destrow'
  const overwriteRadio = document.createElement('input')
  overwriteRadio.type = 'radio'
  overwriteRadio.name = groupName
  overwriteRadio.checked = true
  const overwriteSpan = document.createElement('span')
  overwriteSpan.textContent = cfg.overwriteLabel
  overwriteRow.append(overwriteRadio, overwriteSpan)
  const overwriteHint = document.createElement('p')
  overwriteHint.className = 'ed-hint'
  overwriteHint.textContent = cfg.overwriteHint

  const newRow = document.createElement('label')
  newRow.className = 'ed-applyto-destrow'
  const newRadio = document.createElement('input')
  newRadio.type = 'radio'
  newRadio.name = groupName
  const newSpan = document.createElement('span')
  newSpan.textContent = cfg.newLabel
  newRow.append(newRadio, newSpan)
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.className = 'ed-applyto-nameinput'
  nameInput.placeholder = cfg.newPlaceholder
  nameInput.disabled = true

  const emptyHint = document.createElement('p')
  emptyHint.className = 'ed-hint'
  emptyHint.textContent = cfg.emptyHint
  emptyHint.style.display = 'none'

  // The checkbox list only ever matters when "Save as a new slide type" is
  // chosen (see commit() below: "Overwrite" ignores `selected` entirely).
  // Grey the rows out under "Overwrite" so the list doesn't look live when
  // it's actually inert — checked state itself is untouched, so flipping
  // back to "Save as new" restores exactly what was selected before.
  const updateDestUI = () => {
    nameInput.disabled = !newRadio.checked
    const inert = !newRadio.checked
    list.classList.toggle('ed-applyto-list-inert', inert)
    for (const cb of checkboxes) cb.disabled = inert
    const remaining = cfg.rows.filter((r) => !selected.has(r.id))
    emptyHint.style.display = (newRadio.checked && cfg.rows.length > 0 && remaining.length === 0) ? '' : 'none'
  }
  overwriteRadio.addEventListener('change', updateDestUI)
  newRadio.addEventListener('change', () => { updateDestUI(); nameInput.focus() })
  updateDestUI() // greys out the list from the start — "Overwrite" is the default selection

  dest.append(overwriteRow, overwriteHint, newRow, nameInput, emptyHint)
  box.appendChild(dest)

  const actions = document.createElement('div')
  actions.className = 'ed-dialog-actions'
  const cancel = document.createElement('button')
  cancel.className = 'ed-btn'
  cancel.textContent = t('Cancel')
  cancel.addEventListener('click', () => close())
  const apply = document.createElement('button')
  apply.className = 'ed-btn ed-btn-primary'
  apply.textContent = t('Apply')
  apply.addEventListener('click', () => { commit(); close() })
  actions.append(cancel, apply)
  box.appendChild(actions)

  // One commit = one undo step. "Overwrite" is a pure no-op — the template
  // already has the edit, there's no new id to retarget to, so every row
  // stays exactly as it is.
  function commit() {
    if (!newRadio.checked) return
    cfg.onApply(selected, nameInput.value.trim())
  }

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); cfg.onDone() }
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
  document.addEventListener('keydown', onKey, true)

  overlay.appendChild(box)
  document.body.appendChild(overlay)
}

export function openApplyTo(store: Store, layoutId: string, onDone: () => void): void {
  const doc = store.doc
  const layout = doc.layouts?.find((l) => l.id === layoutId)
  if (!layout) return
  const slides = linkedSlides(doc, layoutId)

  buildApplyToDialog({
    groupKey: layoutId,
    rows: slides.map((s) => ({ id: s.id, thumbnail: renderThumbnail(s, doc, 56), label: s.name ?? t('Untitled') })),
    intro: t('Every slide below already shows your latest edit. Choose which ones should keep following this slide type from now on.'),
    overwriteLabel: t('Overwrite this slide type'),
    overwriteHint: t('The slide type already has your edit — nothing else to do.'),
    newLabel: t('Save as a new slide type'),
    newPlaceholder: t('New slide type'),
    emptyHint: t('The slide type you started from stays in your Slide types list, unused by anyone still tracking it.'),
    onApply: (selectedIds, name) => {
      store.commit(() => {
        const cloneId = uid('layout')
        const clone: Slide = { ...jsonClone(layout), id: cloneId, name: name || t('New slide type') }
        delete clone.stateOf
        clone.notes = ''
        doc.layouts = [...(doc.layouts ?? []), clone]
        for (const s of slides) if (selectedIds.has(s.id)) s.layoutId = cloneId
      })
    },
    onDone,
  })
}
