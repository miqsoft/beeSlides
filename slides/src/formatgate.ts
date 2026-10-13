// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The reader gate, app side (kernel/src/doc.ts has the kernel half, and
// docs/DECISIONS.md the reasoning). A document whose `requires` names a
// feature this build does not know was written by a NEWER BeeSlides. Opening
// it is fine; writing it back is not — this build would save it without
// whatever it did not understand, and the author would never see what was
// lost. So such a document opens read-only, every write path refuses, and no
// part of it may be merged into another document either (a foreign file,
// a template, a library, pasted JSON): the merged pieces would lose the same
// things, just one step removed.
//
// The kernel refuses to serialize such a document regardless. This module is
// what turns that into a sentence the author can act on, at the moment they
// try, instead of a "Save failed".
//
// State lives at module scope — one document per window — like
// editor/desktopdoc.ts, so main.ts can engage it before the editor exists.

import { t } from './i18n'
import { unsupportedFeatures } from './model'

let gated: string[] | null = null

/** Put this window's document behind the gate (main.ts, at boot). */
export function engageFormatGate(features: string[]): void {
  gated = features.slice()
}

/** The features this window's document needs and this build lacks, or null. */
export const formatGate = (): string[] | null => gated

/** The banner text, also used as the desktop "writes disabled" reason. */
export const formatGateNotice = (): string =>
  t('This document was made with a newer version of BeeSlides. It is open read-only: nothing you change here can be saved.')

/**
 * Call at the top of every write path. True = refuse (the author has been
 * told); false = carry on.
 */
export function refuseGatedWrite(tell: (message: string) => void): boolean {
  if (!gated) return false
  tell(t('Read-only — this document was made with a newer version of BeeSlides.'))
  return true
}

/**
 * Call on every document arriving from OUTSIDE this window before any of it
 * is adopted or merged — a dropped/picked file, a template, a library file,
 * pasted JSON, `loadDoc`. True = refuse (the author has been told). Also
 * refuses anything while this window is itself gated: replacing a newer
 * document in place is a write in all but name.
 */
export function refuseNewerDoc(doc: { requires?: unknown } | null | undefined, name: string | null, tell: (message: string) => void): boolean {
  if (refuseGatedWrite(tell)) return true
  if (!unsupportedFeatures(doc).length) return false
  tell(name
    ? t('“{name}” was made with a newer version of BeeSlides. Update BeeSlides to use it here.', { name })
    : t('That document was made with a newer version of BeeSlides. Update BeeSlides to use it here.'))
  return true
}

/** The persistent read-only banner (the editor's disk-banner shape). */
export function showFormatGateBanner(): void {
  if (!gated || document.querySelector('.ed-gatebanner')) return
  const bar = document.createElement('div')
  bar.className = 'ed-recover ed-gatebanner'
  bar.setAttribute('role', 'status')
  const msg = document.createElement('span')
  msg.textContent = formatGateNotice()
  bar.appendChild(msg)
  document.body.appendChild(bar)
}
