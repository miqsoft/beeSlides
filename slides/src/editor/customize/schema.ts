// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The UI profile: how ONE install of the editor is customized. It is a
// preference of the person using the app, never part of a document — it lives
// in localStorage (browser) or in the desktop app's userData
// (desktop/src/main/uiprofilefs.ts), and no save path ever writes it into a
// file.
//
// It is DATA, not code (docs/DECISIONS.md, "Customizing the editor: a
// per-install profile of recipes, not code"). Every string in a profile is one
// of three things:
//   • an id from a CLOSED catalog (catalog.ts: commands, ribbon groups, CSS
//     tokens, icons, patchable element keys);
//   • literal text a person typed (labels, names) — always rendered through
//     `textContent`, never `innerHTML`, never passed through t();
//   • an element value, held to the same checks a pasted element is
//     (untrusted.ts).
// There is no field that holds script, raw CSS, HTML or a URL. validate.ts is
// the only door in; this file only names the shapes.

import type { SlideElement, StyleDefaults } from '../../model.ts'

export const UI_PROFILE_FORMAT = 'slidomingo/ui-profile'
export const UI_PROFILE_VERSION = 1
/** The file extension Import/Export use. */
export const UI_PROFILE_EXT = '.slidomingo-ui.json'

/** One step something can do: run a menu command, apply a style, insert a
 *  preset. A `sequence` is a flat list of these. */
export type UiStep =
  | { command: string }
  | { style: string }
  | { insert: string }

export type UiAction =
  | { kind: 'command'; command: string; label?: string; icon?: string }
  | { kind: 'style'; style: string; label?: string; icon?: string }
  | { kind: 'insert'; preset: string; label?: string; icon?: string }
  | { kind: 'sequence'; steps: UiStep[]; label?: string; icon?: string }

/** "My styles": a patch of visual properties, applied to every selected
 *  element that has the key. Keys are limited to catalog.ts PATCH_KEYS. */
export interface UiStyle {
  label: string
  patch: Record<string, unknown>
}

/** A saved group of elements to insert (text, shape, table, chart, code). */
export interface UiPreset {
  label: string
  elements: SlideElement[]
}

/** A ribbon button: an action id (no dot) or a catalog command id (dotted). */
export interface UiButton {
  target: string
  label?: string
  icon?: string
}
export interface UiGroup { id: string; label: string; buttons: UiButton[] }
export interface UiTab { id: string; label: string; groups: UiGroup[] }

export interface UiRibbon {
  /** Custom tabs, after the built-in ones. */
  tabs?: UiTab[]
  /** Built-in ribbon group ids (catalog.ts RIBBON_LAYOUT) to hide. */
  hide?: string[]
  /** Per built-in tab: the order its groups appear in (ids; any group not
   *  listed keeps its place after the listed ones). */
  order?: Record<string, string[]>
}

/** One of the editor's own menus a profile can add to or trim: the
 *  right-click menu on the canvas, and the floating quick-format bar under a
 *  selection. `add` pins targets per SCOPE (catalog.ts CONTEXT_SCOPES /
 *  MINIBAR_SCOPES: an element type, `multi`, `canvas`, `text-edit`, or `*`
 *  for every scope); `hide` names built-in items (catalog.ts CONTEXT_ITEMS /
 *  MINIBAR_ITEMS). */
export interface UiMenu {
  add?: Record<string, string[]>
  hide?: string[]
}

export interface UiMenus {
  context?: UiMenu
  minibar?: UiMenu
}

/** The editor's own toolbar buttons — the web top bar and the desktop
 *  ribbon share one id space (catalog.ts TOOLBAR_ITEMS). `order` ranks the
 *  listed buttons among their siblings; buttons not listed keep their place
 *  after them. */
export interface UiToolbar {
  hide?: string[]
  order?: string[]
  /** Where the quick-format bar shows (minitoolbar.ts QuickBarPlace):
   *  docked at the top of the slide area, floating by the selection, both,
   *  or off. Absent = the old per-install preference, default the top. */
  quickbar?: QuickBarPlace
}

export type QuickBarPlace = 'top' | 'floating' | 'both' | 'off'
export const QUICKBAR_PLACES: readonly QuickBarPlace[] = ['top', 'floating', 'both', 'off']

/** The side (properties) panel: the order its sections appear in, by
 *  catalog.ts PANEL_SECTIONS id. Sections not listed keep their place after
 *  the listed ones; the fixed header always stays first. */
export interface UiPanel {
  order?: string[]
}

export type UiDensity = 'comfortable' | 'compact'

export interface UiChrome {
  density?: UiDensity
  /** Token overrides (catalog.ts TOKENS, without the leading `--`), as hex
   *  colours, per theme. */
  light?: Record<string, string>
  dark?: Record<string, string>
  /** Corner radius of the chrome's controls, px. */
  radius?: number
}

export interface UiProfile {
  format: typeof UI_PROFILE_FORMAT
  version: typeof UI_PROFILE_VERSION
  name?: string
  /** Absent = on. The kill switch in Settings ▸ Customize. */
  enabled?: boolean
  actions?: Record<string, UiAction>
  styles?: Record<string, UiStyle>
  presets?: Record<string, UiPreset>
  ribbon?: UiRibbon
  /** Chord ("Mod+Shift+B") → target (action id or catalog command id), or
   *  `"none"` to switch a built-in shortcut off. A chord the editor already
   *  uses is taken over only if catalog.ts lists it as overridable. */
  shortcuts?: Record<string, string>
  menus?: UiMenus
  toolbar?: UiToolbar
  chrome?: UiChrome
  panel?: UiPanel
  /** Personal style defaults for NEW objects — below the deck's and the slide
   *  types' own defaults (model.ts setPersonalStyleDefaults). */
  defaults?: StyleDefaults
}

/** A shortcut target that switches a built-in chord off. */
export const SHORTCUT_NONE = 'none'

/** The parts a profile is exported/imported by (logic.ts pickParts/mergeProfiles). */
export const PROFILE_PARTS = ['buttons', 'menus', 'toolbar', 'panel', 'shortcuts', 'styles', 'presets', 'look', 'defaults'] as const
export type UiPart = typeof PROFILE_PARTS[number]

/** A profile with nothing in it. */
export function emptyProfile(): UiProfile {
  return { format: UI_PROFILE_FORMAT, version: UI_PROFILE_VERSION }
}

/** One finding of the validator. `path` is a JSON-pointer-ish dotted path. */
export interface UiIssue { path: string; code: string; message: string }

export interface UiValidation {
  /** The profile to use (lenient: what survived; strict: null on any error). */
  profile: UiProfile | null
  errors: UiIssue[]
  warnings: UiIssue[]
}
