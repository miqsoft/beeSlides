// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Viewer-only entry (`VIEWER=1` build → BeeSlides_Viewer.beeslides.html). The
// shell the desktop app splices every saved deck into: the FILE is the
// document plus a viewer, the editor is the desktop app (DECISIONS
// 2026-10-07). Mirrors the head of main.ts minus the editor.
//
// HARD RULE: import nothing from ./editor/ or ./startuppicker — the viewer is
// small only because the editor tree-shakes out. `npm run build:viewer`
// checks the output for editor markers.

import './styles.css'
import { configureApp } from '../../kernel/src/app.ts'
import { startTheme } from '../../kernel/src/theme.ts'
import { startNetGuard } from '../../kernel/src/net.ts'
import {
  capturePristine, readEmbeddedDoc, parseEnvelope,
  registerPreview, registerStaticLayer, registerAssetStore, registerKnownFeatures,
} from './save'
import { buildSlidePreview } from './preview'
import { assetStoreSpec, buildStaticLayer } from './staticlayer'
import { t, applyDirection } from './i18n'
import { KNOWN_FEATURES, parseDoc, unsupportedFeatures, type SlidomingoDoc } from './model'
import { engageFormatGate } from './formatgate'
import { resolveThemeRefs } from './palette'
import { passwordGate, playerMode } from './player'

configureApp({
  appId: 'slidomingo-slides',
  appName: 'BeeSlides',
})

// "Save a copy" from the viewer writes a full file, so the same write-side
// registrations as the editor entry (main.ts) — preview, static layer, asset
// store, reader gate — must be in place before the first serialize.
registerPreview((doc) => buildSlidePreview(doc as SlidomingoDoc))
registerStaticLayer((doc) => buildStaticLayer(doc as SlidomingoDoc))
registerAssetStore((doc) => assetStoreSpec(doc as SlidomingoDoc))
registerKnownFeatures(KNOWN_FEATURES)

// Same ordering rules as main.ts: pristine capture BEFORE any DOM mutation;
// theme and direction AFTER it (viewer-scoped attributes must never travel
// into a saved copy) and before the first paint.
capturePristine()
startTheme()
startNetGuard()
applyDirection()

const embedded = readEmbeddedDoc()
const envelope = embedded ? parseEnvelope(embedded) : null
if (envelope) {
  passwordGate(envelope, show)
} else {
  const doc = embedded ? parseDoc(embedded) : null
  if (doc) show(doc)
  else empty()
}

function show(doc: SlidomingoDoc) {
  // The reader gate (src/formatgate.ts): a deck from a NEWER BeeSlides is shown
  // as far as we can, never re-written (kernel serializeBody refuses too).
  const missing = unsupportedFeatures(doc)
  if (missing.length) {
    engageFormatGate(missing)
    console.warn('slidomingo: opened read-only, this build does not know', missing)
  }
  // The JS-off static layer has done its job once script runs (as in main.ts).
  document.getElementById('beeslides-static')?.remove()
  resolveThemeRefs(doc)
  playerMode(doc)
}

/** A viewer shell with no (or an unreadable) document block. */
function empty() {
  document.getElementById('beeslides-splash')?.remove()
  const card = document.createElement('div')
  card.className = 'ed-player'
  card.innerHTML = `<div class="ed-playercard"><p>${t('This file contains no deck.')}</p></div>`
  document.body.appendChild(card)
}
