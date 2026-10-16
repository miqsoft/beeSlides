// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// "My styles" (docs/DECISIONS.md, "Icon styles"): icon styles a person saved
// to reuse in any icon set. They live in this browser's storage — on desktop
// an app-wide viewer pref (viewerprefs.ts), since localStorage is per deck
// there — never in a document; a set that uses one keeps its own copy (doc.iconset.variants),
// so a file never depends on someone's library. Shared between people as a
// pasted style (JSON with `format: slidomingo-icon-style`).

import type { IconLook } from '../model'
import { lookRecipe, readLook } from '../iconstyles'
import { lsJson, lsSetJson } from '../../../kernel/src/storage.ts'

const KEY = 'slidomingo-icon-styles-v1'
const MAX = 60

/** The saved styles, newest first; anything unreadable is dropped. */
export function loadMyLooks(): IconLook[] {
  const raw = lsJson<unknown>(KEY, [])
  if (!Array.isArray(raw)) return []
  return raw.map((r) => readLook(r)).filter((l): l is IconLook => typeof l !== 'string').slice(0, MAX)
}

const store = (looks: IconLook[]): boolean => lsSetJson(KEY, looks.slice(0, MAX))

/** Save (or replace, by name) a style in My styles — the recipe only: its
 *  tweaks name one set's icons. */
export function saveMyLook(look: IconLook): boolean {
  const key = look.name.toLowerCase()
  const rest = loadMyLooks().filter((l) => l.name.toLowerCase() !== key)
  return store([lookRecipe(look), ...rest])
}

export function removeMyLook(id: string): void {
  store(loadMyLooks().filter((l) => l.id !== id))
}

export const STYLE_CLIP_FORMAT = 'slidomingo-icon-style'

/** A style as text to paste somewhere else (the recipe, without this set's tweaks). */
export function lookToClipText(look: IconLook): string {
  const { id: _id, ...rest } = lookRecipe(look)
  return JSON.stringify({ format: STYLE_CLIP_FORMAT, version: 1, style: rest }, null, 2)
}

/** Pasted text → a style, or a message. Takes the wrapped form or a bare style. */
export function lookFromClipText(text: string): IconLook | string {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return 'not a style' }
  if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).format === STYLE_CLIP_FORMAT) raw = (raw as Record<string, unknown>).style
  return readLook(raw)
}
