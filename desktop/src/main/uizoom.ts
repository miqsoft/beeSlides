// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// UI zoom (⌘/Ctrl + − 0, View ▸ Zoom): Chromium page zoom of every document
// window's editor view, remembered across launches in app settings. The
// renderer does not handle these keys (the slide canvas zooms with wheel,
// pinch and its zoom bar) — docs/DECISIONS.md 2026-10-11.
import type { WebContents } from 'electron'
import { readSettings, updateSettings } from './settings.ts'

/** Chromium zoom LEVELS: factor = 1.2 ** level, so 0.5 ≈ 9.5 % a step. */
const MIN_LEVEL = -3
const MAX_LEVEL = 5
const STEP = 0.5

const clamp = (n: number): number => Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(n * 2) / 2))

let level = (() => {
  const saved = readSettings().uiZoomLevel
  return typeof saved === 'number' && Number.isFinite(saved) ? clamp(saved) : 0
})()

export const uiZoomLevel = (): number => level

/** Puts the remembered level on a (new or reloaded) editor view. */
export function applyUiZoom(wc: WebContents): void {
  if (!wc.isDestroyed() && wc.getZoomLevel() !== level) wc.setZoomLevel(level)
}

/** dir: 1 in, -1 out, 0 back to 100 %. Applies to every given view and remembers it. */
export function stepUiZoom(dir: 1 | -1 | 0, views: Array<WebContents | null>): void {
  level = dir === 0 ? 0 : clamp(level + dir * STEP)
  updateSettings({ uiZoomLevel: level === 0 ? undefined : level })
  for (const wc of views) if (wc) applyUiZoom(wc)
}
