// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Background mode (DECISIONS 2026-10-24, "BeeSlides without its window"): the
// Claude Code plugin starts a hidden instance of this app when the visible
// one is not reachable (desktop/src/mcp/plugin-launch.mjs), as
// `<app> --background` with a userData of its own (SLIDOMINGO_USER_DATA).
// That instance has no window anyone sees and no Dock icon; an agent opens
// decks in it through the endpoint (open_deck), edits them with the usual
// tools, and every change autosaves to the file as in the visible app.
//
// What differs in it (index.ts, windows.ts, agentendpoint.ts):
//   - document windows are hidden (hideWindow); no blank start window, no
//     restored session, no Recent entries, no session written at quit
//   - the endpoint is always on, asks nobody (whoever started the instance
//     owns the token in its folder) and writes no `launch`
//   - closing the last deck keeps it running; SIGTERM/SIGINT quit through the
//     flush, an idle instance quits by itself
// The user's own app and its settings are never touched: viewerPrefs (icon
// sources, language) are COPIED from them at start (seedViewerPrefs).

import { app, type BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSettings, updateSettings, type AppSettings } from './settings.ts'

/** This run is a hidden instance for an agent. Read from argv each time: it
 *  is fixed for the life of the process. */
export const isBackground = (): boolean => process.argv.includes('--background')

/** A document window that nobody sees: it is simply never shown. Created
 *  with show:false (windows.ts), it still lays out, runs timers and rAF,
 *  captures and autosaves like a visible one — measured, not assumed:
 *  desktop/scripts/e2e-background.mjs (DECISIONS 2026-10-24). Its doc view
 *  is not throttled (windows.ts mountDocument) and the renderer-backgrounding
 *  switches are set at start (applyBackgroundSwitches). */
export function hideWindow(win: BrowserWindow): void {
  try { win.setSkipTaskbar(true) } catch { /* not on this platform */ }
  try { win.setIgnoreMouseEvents(true) } catch { /* best effort */ }
}

/** Chromium switches for a renderer nobody looks at: no timer throttling,
 *  no occlusion backgrounding. Must run before `ready`. */
export function applyBackgroundSwitches(): void {
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
}

/** No Dock icon, no app-switcher entry (macOS). */
export function hideFromDock(): void {
  if (process.platform !== 'darwin') return
  try { app.setActivationPolicy('accessory') } catch { /* older Electron */ }
  try { app.dock?.hide() } catch { /* best effort */ }
}

/** The settings file of the user's own (visible) app: BEESLIDES_USER_SETTINGS,
 *  else the folder index.ts would pin for a normal run of this build. */
export function userSettingsPath(): string {
  if (process.env.BEESLIDES_USER_SETTINGS) return process.env.BEESLIDES_USER_SETTINGS
  return join(app.getPath('appData'), app.isPackaged ? 'BeeSlides' : 'slidomingo-desktop', 'app-settings.json')
}

/** The settings a hidden instance borrows from the user's app, read-only:
 *  icon sources and language (viewerPrefs), the library file and the default
 *  template. Icon-server tokens (safeStorage) and AI profiles stay behind. */
const SEEDED: ReadonlyArray<keyof AppSettings> = ['viewerPrefs', 'libraryPath', 'defaultTemplate']

export function seedViewerPrefs(): void {
  let theirs: AppSettings
  try { theirs = JSON.parse(readFileSync(userSettingsPath(), 'utf8')) as AppSettings } catch { return }
  if (!theirs || typeof theirs !== 'object') return
  const patch: Partial<AppSettings> = {}
  const mine = readSettings()
  for (const k of SEEDED) {
    if (theirs[k] !== undefined && mine[k] === undefined) (patch as Record<string, unknown>)[k] = theirs[k]
  }
  if (Object.keys(patch).length) updateSettings(patch)
}

/** How long a hidden instance waits with no deck open and no agent connected
 *  before it quits by itself (a safety net: the plugin normally ends it). */
export const IDLE_EXIT_MS = 30 * 60_000
