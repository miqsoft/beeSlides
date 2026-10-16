// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The CLOSED catalogs a UI profile may name (schema.ts). Nothing outside these
// lists can appear in a profile that validate.ts accepts — that is what keeps
// a profile data rather than code.
//
// Wherever a list already exists elsewhere it is DERIVED, never restated:
// the commands come from menumodel.ts (so a command another branch adds to
// the menu is a valid button target the moment it lands), the icons from
// icons.ts, the element keys from modelkeys.generated.ts. The lists that are
// written out here (ribbon groups, tokens, reserved chords) are pinned
// against the source by scripts/test-ui-profile.ts.
//
// Pure: no DOM, `.ts` import specifiers, so the desktop main process and the
// node rigs can import it.

import { COMMANDS, MENU_MODEL, TRANSITION_KINDS, TRANSITION_LABELS, type MenuNode } from '../menumodel.ts'
import { ICONS } from '../../icons.ts'
import { MODEL_KEYS } from '../../modelkeys.generated.ts'

export interface CatalogCommand {
  id: string
  /** English label (the i18n key — the renderer translates it). */
  label: string
  /** Where it sits in the native menu, English: "Insert ▸ Media". */
  menu: string
}

/** Every command a button, shortcut or sequence may run: the menu catalog's
 *  static ids plus the generated transition ids. Ordered as the menu bar. */
export function commandCatalog(): CatalogCommand[] {
  const out: CatalogCommand[] = []
  const walk = (nodes: MenuNode[], path: string[]) => {
    for (const n of nodes) {
      if (typeof n === 'string') {
        if (n !== '-' && COMMANDS[n]) out.push({ id: n, label: COMMANDS[n].label, menu: path.join(' ▸ ') })
      } else if ('items' in n) walk(n.items, [...path, n.label])
      else if ('dynamic' in n && n.dynamic === 'transitions') {
        for (const k of TRANSITION_KINDS) out.push({ id: `slide.transition.${k}`, label: TRANSITION_LABELS[k], menu: [...path, n.label].join(' ▸ ') })
      }
    }
  }
  for (const s of MENU_MODEL) walk(s.items, [s.label === 'Settings…' ? 'App' : s.label])
  return out
}

let commandIds: Set<string> | null = null
/** Whether `id` is a command a profile may name. */
export function isCatalogCommand(id: string): boolean {
  commandIds ??= new Set(commandCatalog().map((c) => c.id))
  return commandIds.has(id)
}

/** The built-in ribbon groups (desktop), per tab, with the English caption
 *  editor.ts gives each (`ribbonGroup(t('<caption>'), …)`). ribbon.ts tags a
 *  rendered group with its id by matching the translated caption, so
 *  editor.ts needs no per-group change; the rig checks every caption is
 *  still in editor.ts. A group another change adds stays untagged (and so
 *  can't be hidden or reordered) until it is listed here. */
export const RIBBON_LAYOUT: Record<string, Array<{ id: string; caption: string }>> = {
  home: [
    { id: 'home:slides', caption: 'Slides' },
    // an icon set's Home tab shows this in place of Slides
    { id: 'home:icons', caption: 'Icons' },
    { id: 'home:icon-set', caption: 'Icon set' },
    { id: 'home:format-painter', caption: 'Format Painter' },
    { id: 'home:reapply-change', caption: 'Reapply Change' },
    { id: 'home:arrange', caption: 'Arrange' },
    { id: 'home:comment', caption: 'Comment' },
  ],
  insert: [
    { id: 'insert:basic', caption: 'Basic' },
    { id: 'insert:illustrations', caption: 'Illustrations' },
    { id: 'insert:media', caption: 'Media' },
    { id: 'insert:zoom', caption: 'Zoom' },
    { id: 'insert:objects', caption: 'Objects' },
    { id: 'insert:tables-charts', caption: 'Tables & Charts' },
    { id: 'insert:text', caption: 'Text' },
    { id: 'insert:symbols', caption: 'Symbols' },
    // an icon set's Insert tab: its drawing tools
    { id: 'insert:shapes', caption: 'Shapes' },
  ],
  design: [
    { id: 'design:slide-type', caption: 'Slide Type' },
    { id: 'design:background', caption: 'Background & Theme' },
  ],
  transitions: [
    { id: 'transitions:transition', caption: 'Transition to This Slide' },
  ],
  view: [
    { id: 'view:presentation-views', caption: 'Presentation Views' },
    // an icon set's View tab shows this (All icons) in place of Presentation Views
    { id: 'view:icons', caption: 'Icons' },
    { id: 'view:show', caption: 'Show' },
    { id: 'view:panels', caption: 'Panels' },
    { id: 'view:guides', caption: 'Guides & Checks' },
    { id: 'view:export', caption: 'Export' },
  ],
}
/** English labels of the built-in tabs (the ribbon's own `t()` keys). */
export const RIBBON_TABS: Record<string, string> = {
  home: 'Home', insert: 'Insert', design: 'Design', transitions: 'Transitions', view: 'View',
}
export const ribbonGroupIds = (): string[] => Object.values(RIBBON_LAYOUT).flat().map((g) => g.id)

/** The chrome's CSS custom properties a profile may override (without `--`),
 *  with the built-in light/dark values from styles.css (the rig pins them).
 *  Colours only — given as hex, so they are trivially safe and the
 *  contrast warnings can be computed. */
export const TOKENS: Record<string, { light: string; dark: string; label: string }> = {
  'accent': { light: '#FFC233', dark: '#FFC233', label: 'Accent (fills, rings, markers)' },
  'accent-ink': { light: '#17120A', dark: '#17120A', label: 'Text on the accent' },
  'accent-text': { light: '#8F5700', dark: '#FFCF5C', label: 'Accent as text' },
  'ink': { light: '#17120A', dark: '#F5EEDF', label: 'Text' },
  'ink-2': { light: '#3D3222', dark: '#D2C6AE', label: 'Secondary text' },
  'muted': { light: '#726651', dark: '#A89A80', label: 'Muted text' },
  'chrome': { light: '#FAF7F1', dark: '#1A150D', label: 'Window background' },
  'chrome-2': { light: '#F3EEE4', dark: '#241D12', label: 'Raised background' },
  'surface': { light: '#FFFFFF', dark: '#221B10', label: 'Panels and menus' },
  'line': { light: '#EAE3D6', dark: '#3A301F', label: 'Lines and borders' },
  'field': { light: '#FFFFFF', dark: '#130F08', label: 'Form fields' },
  'blue': { light: '#5b8def', dark: '#7aa5f5', label: 'Canvas selection' },
}

/** Pairs that must stay readable: [text token, background token, minimum
 *  WCAG contrast]. A profile that breaks one gets a WARNING, not an error. */
export const CONTRAST_PAIRS: Array<[string, string, number]> = [
  ['accent-ink', 'accent', 4.5],
  ['ink', 'chrome', 4.5],
  ['ink', 'surface', 4.5],
  ['accent-text', 'surface', 4.5],
  ['accent-text', 'chrome', 4.5],
  ['muted', 'surface', 3],
  ['ink-2', 'surface', 4.5],
]

/** Icon ids a button may show (icons.ts; markup we ship, never the profile's). */
export const ICON_NAMES: readonly string[] = Object.keys(ICONS)

/** Element keys a "My style" may patch: looks only — never content, identity,
 *  geometry, links or behaviour. Each value is still checked by untrusted.ts
 *  (checkElementProp) for the element types that have the key. */
export const PATCH_KEYS: readonly string[] = [
  'fill', 'fillGradient', 'stroke', 'strokeWidth', 'strokeStyle', 'strokeDash', 'strokeCap',
  'lineStart', 'lineEnd', 'radius', 'opacity', 'shadow', 'reflection', 'blur', 'backdropFilter', 'blend',
  'color', 'colorGradient', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'align', 'valign', 'textStroke', 'style',
]

/** The element types a key exists on (from the format's own key table). */
export function typesWithKey(key: string): string[] {
  const el = MODEL_KEYS.element as Record<string, readonly string[]>
  return Object.keys(el).filter((type) => el[type].includes(key))
}

/** Element types a preset may hold. Pictures and media are left out: their
 *  bytes belong in a deck's asset store, not in a preference. */
export const PRESET_TYPES: readonly string[] = ['text', 'shape', 'table', 'chart', 'code']

/** Keys a shortcut may use. */
export const CHORD_KEY = /^(?:[A-Z]|[0-9]|F(?:[1-9]|1[0-2]))$/

/**
 * Chords a profile can NEVER take: the clipboard/undo/save keys, select-all,
 * the inline text editor's own keys, keys the desktop app's main process owns
 * (native menu accelerators fire before the page sees the key) and keys with
 * an OS meaning. Normalized form (logic.ts normalizeChord).
 */
export const LOCKED_CHORDS: readonly string[] = (() => {
  const all = (k: string) => [`Mod+${k}`, `Mod+Shift+${k}`, `Mod+Alt+${k}`, `Mod+Alt+Shift+${k}`]
  return [
    ...['S', 'Z', 'Y', 'C', 'X', 'V'].flatMap(all),
    'Mod+A',
    // inline text editing (canvas.ts, richtext.ts): a text edit keeps them
    'Mod+B', 'Mod+I', 'Mod+Shift+I', 'Mod+U', 'Mod+K', 'Mod+Shift+7', 'Mod+Shift+8',
    // desktop main (menu.ts accelerators, Electron roles, the OS)
    'Mod+N', 'Mod+Alt+N', 'Mod+Shift+H', 'Mod+Alt+H', 'Mod+Q', 'Mod+W', 'Mod+Shift+W', 'Mod+M',
    'Mod+R', 'Mod+Shift+R', 'Mod+Alt+I', 'Mod+E', 'Mod+L', 'Mod+T', 'Mod+Shift+T',
    // ⌘H hides the app on a Mac (Ctrl+H is find-and-replace elsewhere)
    'Mod+H',
    'F1', 'F2', 'F10', 'F11', 'F12', 'Alt+F10',
  ]
})()

/**
 * Chords the editor uses (editor.ts wireKeyboard) that a profile MAY take
 * over — bound to something else, or switched off with "none". English
 * label of what the key does today (the i18n key). The profile's listener
 * runs in the capture phase for these, so it wins over the built-in; it
 * still leaves form fields and a live text edit alone.
 */
export const OVERRIDABLE_CHORDS: Record<string, string> = {
  'Mod+O': 'Open…', 'Mod+Shift+O': 'Open in New Window…',
  'Mod+P': 'Export PDF…',
  'Mod+G': 'Grid', 'Mod+D': 'Duplicate',
  'Mod+0': 'Reset zoom to fit (⌘0)', 'Mod+1': 'Slide Sorter', 'Mod+2': 'Outline',
  'F5': 'Slideshow', 'Shift+F5': 'Slideshow',
  'Mod+F': 'Find…', 'Mod+Alt+F': 'Find and replace…',
  // Arrange (menumodel.ts accelerators, editor.ts ALIGN_KEYS)
  'Alt+Shift+L': 'Align left', 'Alt+Shift+C': 'Align horizontal centers', 'Alt+Shift+R': 'Align right',
  'Alt+Shift+U': 'Align top', 'Alt+Shift+M': 'Align vertical middles', 'Alt+Shift+B': 'Align bottom',
  'Alt+Shift+E': 'Center on slide', 'Alt+Shift+S': 'Relative to slide',
  'Alt+Shift+H': 'Distribute horizontally', 'Alt+Shift+V': 'Distribute vertically',
}

/** Every chord the app already owns, overridable or not (what the rig pins
 *  against wireKeyboard). */
export const RESERVED_CHORDS: readonly string[] = (() => {
  const all = (k: string) => [`Mod+${k}`, `Mod+Shift+${k}`, `Mod+Alt+${k}`, `Mod+Alt+Shift+${k}`]
  return [...new Set([
    ...LOCKED_CHORDS, ...Object.keys(OVERRIDABLE_CHORDS),
    // wireKeyboard reads these keys with any modifier mix
    ...['O', 'G', 'D', '0', '1', '2'].flatMap(all), 'Mod+Alt+A',
  ])]
})()

/** Whether a profile may bind `chord` (normalized): free, or overridable. */
export const isLockedChord = (chord: string): boolean => LOCKED_CHORDS.includes(chord)
/** Whether binding `chord` takes it away from the editor's own handler. */
export const isBuiltinChord = (chord: string): boolean => RESERVED_CHORDS.includes(chord) && !isLockedChord(chord)

// ---- the side panel ----------------------------------------------------------------

/** Side-panel sections a profile may order (panels.ts section keys). `type`
 *  stands for an object's own sections — Typography, Fill & stroke, Data,
 *  Alt text… — which move together. `scope` = which panel shows it. */
export interface PanelSection { id: string; label: string; scope: 'object' | 'selection' | 'slide' }
export const PANEL_SECTIONS: readonly PanelSection[] = [
  { id: 'type', label: 'Its own settings (text, fill, data…)', scope: 'object' },
  { id: 'Position & size', label: 'Position & size', scope: 'object' },
  { id: 'Effects', label: 'Effects', scope: 'object' },
  { id: 'Arrange', label: 'Arrange', scope: 'object' },
  { id: 'Presenting', label: 'Presenting', scope: 'object' },
  { id: 'Advanced', label: 'Advanced', scope: 'object' },
  { id: 'History', label: 'History', scope: 'object' },
  { id: 'multi:Fill & stroke', label: 'Fill & stroke', scope: 'selection' },
  { id: 'multi:Text', label: 'Text', scope: 'selection' },
  { id: 'multi:Effects', label: 'Effects', scope: 'selection' },
  { id: 'multi:Arrange', label: 'Arrange', scope: 'selection' },
  { id: 'Slide', label: 'Slide', scope: 'slide' },
  { id: 'Builds', label: 'Builds', scope: 'slide' },
  { id: 'Auto-play', label: 'Auto-play', scope: 'slide' },
  { id: 'Slideshow', label: 'Slideshow', scope: 'slide' },
  { id: 'Theme', label: 'Theme', scope: 'slide' },
  { id: 'Interactivity', label: 'Interactivity', scope: 'slide' },
]
/** Section ids that no longer exist, still accepted (and dropped) in a
 *  saved order: "Slide type" became a row of the Slide section (2026-10-13). */
export const RETIRED_PANEL_SECTIONS: readonly string[] = ['Slide type']
const PANEL_IDS = new Set(PANEL_SECTIONS.map((p) => p.id))
/** The PANEL_SECTIONS id a panel section key ranks by. */
export const panelSectionId = (key: string): string => (PANEL_IDS.has(key) ? key : 'type')

// ---- menus and toolbars ----------------------------------------------------------

/** A built-in item of one of the editor's menus/toolbars: id + English label. */
export interface CatalogItem { id: string; label: string }

/** Element types a menu scope may name (model.ts SlideElement['type']). */
export const ELEMENT_TYPES: readonly string[] = ['text', 'shape', 'image', 'svg', 'chart', 'table', 'code', 'embed', 'media', 'math', 'zoom']

/** Right-click menu scopes: what was right-clicked. `canvas` = empty slide,
 *  `multi` = more than one element, `*` = any element selection. */
export const CONTEXT_SCOPES: readonly string[] = ['*', 'canvas', 'multi', ...ELEMENT_TYPES]
/** Quick-format bar scopes: what it is showing for. `line` = a line or curve,
 *  `text-edit` = inside a text edit. `*` = every one of them. */
export const MINIBAR_SCOPES: readonly string[] = ['*', 'shape', 'line', 'text', 'text-edit', 'image', 'chart', 'code', 'media', 'math', 'multi']

/** contextmenu.ts items (tagged `data-ui-item` there; the rig checks every
 *  id is still in the source). The "Select" block for overlapping elements
 *  is not listed: it can't be hidden. */
export const CONTEXT_ITEMS: readonly CatalogItem[] = [
  { id: 'cut', label: 'Cut' }, { id: 'copy', label: 'Copy' }, { id: 'paste', label: 'Paste' },
  { id: 'show-hidden', label: 'Show hidden elements' }, { id: 'comment-here', label: 'Add comment here' },
  { id: 'table', label: 'Table' }, { id: 'edit-equation', label: 'Edit equation…' }, { id: 'convert-svg', label: 'Convert to objects' }, { id: 'go-to-target', label: 'Go to target' },
  { id: 'duplicate', label: 'Duplicate' }, { id: 'delete', label: 'Delete' },
  { id: 'lock', label: 'Lock' }, { id: 'hide', label: 'Hide' },
  { id: 'save-selection', label: 'Save selection…' },
  { id: 'order', label: 'Layer order' }, { id: 'flip', label: 'Flip' },
  { id: 'group', label: 'Group' }, { id: 'align', label: 'Align' },
  { id: 'comment', label: 'Add Comment' }, { id: 'revert', label: 'Revert last change' },
]

/** minitoolbar.ts items (tagged `data-ui-item` there). */
export const MINIBAR_ITEMS: readonly CatalogItem[] = [
  { id: 'size', label: 'Size (pt)' }, { id: 'color', label: 'Color' },
  { id: 'fill', label: 'Fill' }, { id: 'stroke', label: 'Stroke' }, { id: 'stroke-width', label: 'Stroke width' },
  { id: 'gradient', label: 'Edit the gradient' }, { id: 'bold', label: 'Bold' }, { id: 'text-align', label: 'Text alignment' },
  { id: 'line-tip', label: 'End tip' }, { id: 'more', label: 'More options' },
  { id: 'inline-format', label: 'Bold, italic, underline' }, { id: 'lists', label: 'Lists' },
  { id: 'link', label: 'Link' }, { id: 'equation', label: 'Equation palette' },
  { id: 'replace', label: 'Replace…' }, { id: 'crop', label: 'Crop' }, { id: 'fit', label: 'Fit' },
  { id: 'chart-type', label: 'Chart type' }, { id: 'edit-data', label: 'Edit data' }, { id: 'language', label: 'Language' },
  { id: 'edit-math', label: 'Edit equation…' }, { id: 'autoplay', label: 'Autoplay' },
  { id: 'arrange', label: 'Align objects' }, { id: 'distribute', label: 'Distribute' }, { id: 'group', label: 'Group' },
]

/** Toolbar buttons (web top bar AND desktop ribbon — one id space; tagged
 *  `data-ui-item` in editor.ts and insertgroup.ts). Save and Settings are not
 *  listed: they can't be hidden. */
export const TOOLBAR_ITEMS: readonly CatalogItem[] = [
  { id: 'undo', label: 'Undo' }, { id: 'redo', label: 'Redo' }, { id: 'new-slide', label: 'New slide' },
  { id: 'text', label: 'Text' }, { id: 'shape', label: 'Shape' }, { id: 'image', label: 'Image' },
  { id: 'media', label: 'Media' }, { id: 'zoom', label: 'Zoom' }, { id: 'table', label: 'Table' },
  { id: 'chart', label: 'Chart' }, { id: 'code', label: 'Code' }, { id: 'math', label: 'Equation' },
  { id: 'embed', label: 'Embed' }, { id: 'icons', label: 'Icons' }, { id: 'objects', label: 'Objects' },
  { id: 'save-selection', label: 'Save selection…' }, { id: 'library', label: 'Library' },
  { id: 'format-painter', label: 'Format Painter' }, { id: 'reapply-change', label: 'Reapply Change' },
  { id: 'comment', label: 'Comment' }, { id: 'send-to-claude', label: 'Send to Claude' },
  { id: 'pdf', label: 'Export PDF…' }, { id: 'notes', label: 'Notes' }, { id: 'layout-manager', label: 'Layout Manager…' },
  { id: 'view', label: 'View' }, { id: 'help', label: 'Help' },
  { id: 'present', label: 'Slideshow' }, { id: 'terminal', label: 'Claude Code Terminal' },
  // an icon set's Home ▸ Icons group
  { id: 'icon-plan', label: 'Plan with AI' }, { id: 'icon-add', label: 'Add icons' }, { id: 'icon-draw', label: 'Draw with AI' },
  { id: 'icon-style', label: 'Apply set style' }, { id: 'icon-comment', label: 'Comment on icons' },
  { id: 'icon-look', label: 'Style' }, { id: 'icon-canvas', label: 'Canvas' },
]
/** Toolbar ids that no longer exist, still accepted (and dropped) in a saved
 *  profile: the globe became Settings ▸ General ▸ Language (2026-10-14). */
export const RETIRED_TOOLBAR_ITEMS: readonly string[] = ['language']
