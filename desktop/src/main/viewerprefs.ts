// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// App-wide viewer preferences. The renderer's localStorage is per deck (one
// session partition per path, windows.ts), so theme, language, panel sizes …
// were forgotten the moment another deck opened. The preload seeds each
// window from this store and mirrors writes back (preload/index.ts,
// kernel/src/storage.ts). Only allowlisted keys are accepted.
import { BrowserWindow } from 'electron'
import { onFrom } from './ipcguard.ts'
import { ICON_SOURCES_KEY, sanitizeIconSourcesPref } from './icontokens.ts'
import { readSettings, updateSettings } from './settings.ts'
import { docWebContentsFor } from './windows.ts'

export const VIEWER_PREF_KEYS: readonly string[] = [
  'slidomingo-theme',
  'slidomingo-lang',
  'slidomingo-reduce-motion',
  'slidomingo-offline',
  'slidomingo-safe-zone',
  'slidomingo-minitoolbar',
  'slidomingo-save-notice',
  'slidomingo-save-selection-scope',
  'slidomingo-ribbon-collapsed',
  'slidomingo-icon-source',
  'slidomingo-icon-server-url',
  ICON_SOURCES_KEY,
  'slidomingo-recent-colors',
  'slidomingo-ed-panels',
  'slidomingo-ed-notes',
  'slidomingo-settings-cat',
  'slidomingo-panel-open-v2',
]

/** Keys added after viewerPrefs first existed: a window that has a value
 *  main lacks hands it over instead of having it wiped (preload). */
const ADOPT_IF_MISSING: readonly string[] = [ICON_SOURCES_KEY]

/** What may be stored for a key — the icon-source list never keeps a token
 *  (icontokens.ts moves it into the encrypted store). */
const clean = (key: string, value: string): string => (key === ICON_SOURCES_KEY ? sanitizeIconSourcesPref(value) : value)

export function registerViewerPrefIpc(): void {
  // Sync: the preload needs the values before the page's first script. A
  // refused sender gets an IpcRefusal back (no `keys`: the preload skips it).
  onFrom('app-shell', 'slidomingo:viewer-prefs', (ev) => {
    ev.returnValue = { keys: VIEWER_PREF_KEYS, values: readSettings().viewerPrefs ?? null, adoptIfMissing: ADOPT_IF_MISSING }
  })
  onFrom('app-shell', 'slidomingo:viewer-prefs-adopt', (_ev, have: unknown) => {
    if (readSettings().viewerPrefs) return // another window got there first
    const out: Record<string, string> = {}
    if (have && typeof have === 'object') {
      for (const k of VIEWER_PREF_KEYS) {
        const v = (have as Record<string, unknown>)[k]
        if (typeof v === 'string') out[k] = clean(k, v)
      }
    }
    updateSettings({ viewerPrefs: out })
  })
  onFrom('app-shell', 'slidomingo:set-viewer-pref', (ev, key: unknown, value: unknown) => {
    if (typeof key !== 'string' || !VIEWER_PREF_KEYS.includes(key)) return
    const prefs = { ...(readSettings().viewerPrefs ?? {}) }
    const stored = typeof value === 'string' ? clean(key, value) : null
    if (stored !== null) prefs[key] = stored
    else delete prefs[key]
    updateSettings({ viewerPrefs: prefs })
    // the sender's own copy too, when cleaning changed it (a token left the list)
    if (stored !== null && stored !== value) {
      try { ev.sender.send('slidomingo:viewer-pref-changed', key, stored) } catch { /* closing */ }
    }
    // Every OTHER open deck too, now: one partition per deck means no
    // `storage` event ever crosses windows, and kernel/src/net.ts relies on
    // that event to cut a second window off when offline mode goes on. The
    // preload writes the value and dispatches the event itself.
    const next = stored
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = docWebContentsFor(win)
      if (!wc || wc.id === ev.sender.id) continue
      try { wc.send('slidomingo:viewer-pref-changed', key, next) } catch { /* closing */ }
    }
  })
}
