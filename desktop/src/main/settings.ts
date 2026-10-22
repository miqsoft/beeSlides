// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// App-wide settings: a small JSON file under userData, in the style of
// recent.ts. They live in main because the renderer has no app-wide storage:
// its localStorage is per deck (one session partition per path, windows.ts).
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface AppSettings {
  /** The start page's default template (docs/DECISIONS.md 2026-09-24):
   *  resolved by `templateId` first, so a rename keeps it, then by `path`
   *  (a legacy template has no id). */
  defaultTemplate?: { templateId: string | null; path: string }
  /** A library file the user chose instead of the default one (library.ts).
   *  Absent = the default library next to the templates folder. */
  libraryPath?: string
  /** Viewer preferences shared by every window (viewerprefs.ts). */
  viewerPrefs?: Record<string, string>
  /** Where the last-used window sat, so new ones open the same way. */
  windowState?: { x?: number; y?: number; width: number; height: number; maximized: boolean; fullscreen: boolean }
  /** Documents open at the last quit — reopened on the next launch. */
  session?: Array<{ path: string; name: string }>
  /** AI chat profiles (aiprofiles.ts) and the one new chats open with. */
  aiProfiles?: unknown[]
  defaultAiProfileId?: string
  /** UI zoom, a Chromium zoom level (uizoom.ts); absent = 100 %. */
  uiZoomLevel?: number
  /** Code Mode (agentexec.ts), Settings ▸ AI ▸ Advanced; absent = off. */
  codeMode?: boolean
}

const storePath = (): string => join(app.getPath('userData'), 'app-settings.json')

export function readSettings(): AppSettings {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Merges `patch` into the stored settings; an `undefined` value removes
 *  that key. Never throws (a failed write just keeps the old settings). */
export function updateSettings(patch: Partial<AppSettings>): void {
  const next: Record<string, unknown> = { ...readSettings(), ...patch }
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  try {
    mkdirSync(dirname(storePath()), { recursive: true })
    writeFileSync(storePath(), JSON.stringify(next, null, 2), 'utf8')
  } catch { /* best effort */ }
}
