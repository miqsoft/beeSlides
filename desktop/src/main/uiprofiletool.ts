// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Writing the editor's UI profile, for every writer main serves: the doc
// windows' Settings (IPC, uiprofile.ts), the Customize chat (customizechat.ts)
// and any agent through the slides MCP server's `ui_profile` tool (intercepted
// in terminalPanel.ts). One tool, `ui_profile {op}`, so a model learns one
// verb: get → catalog → patch (with a summary) → fix what the validator
// reports → done. Every write is strictly validated
// (slides/src/editor/customize/validate.ts) and becomes a revision
// (uiprofilefs.ts) that History — and the toast's Undo — can go back from.
//
// Electron-free (uiprofilefs.ts's service is injected), so the node rig
// (scripts/test-ai-profiles.ts) runs the real thing.
import {
  CONTEXT_ITEMS, CONTEXT_SCOPES, ICON_NAMES, LOCKED_CHORDS, MINIBAR_ITEMS, MINIBAR_SCOPES, OVERRIDABLE_CHORDS, PATCH_KEYS,
  PANEL_SECTIONS, PRESET_TYPES, RIBBON_LAYOUT, RIBBON_TABS, TOKENS, TOOLBAR_ITEMS, commandCatalog, typesWithKey,
} from '../../../slides/src/editor/customize/catalog.ts'
import { summarizeProfile } from '../../../slides/src/editor/customize/logic.ts'
import { UI_LIMITS, validatePatch, validateProfile } from '../../../slides/src/editor/customize/validate.ts'
import type { UiIssue, UiProfile } from '../../../slides/src/editor/customize/schema.ts'
import {
  DISABLED, currentProfile, resetProfile, revertProfile, uiHistory, writeProfile, type UiProfileService, type UiSource,
} from './uiprofilefs.ts'

// ---- the tool -------------------------------------------------------------------

export const UI_PROFILE_TOOL_NAME = 'ui_profile'

/** Kept identical to the copy in ../mcp/slides-mcp-server.mjs (that file is
 *  written out on its own and can't import this one) — the rig compares them. */
export const UI_PROFILE_TOOL = {
  name: UI_PROFILE_TOOL_NAME,
  description:
    'Customize THIS install of the editor, not the deck: ribbon tabs and buttons, the right-click menu and the quick-format ' +
    'bar, toolbar buttons, shortcuts (incl. taking over built-in keys), saved styles and presets, chrome colours and density. ' +
    'ops: get, catalog (no section = an index; then ask for the sections you need — each says how to write that part), ' +
    'patch (RFC 7386 merge patch; needs summary), set, history, revert {rev}, reset. Writes are validated: on errors nothing ' +
    'changes. See the customize-ui skill.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['get', 'catalog', 'patch', 'set', 'history', 'revert', 'reset'] },
      patch: { type: 'object', description: 'patch: merge patch onto the current profile (null removes a key).' },
      profile: { type: 'object', description: 'set: a whole profile.' },
      summary: { type: 'string', description: 'One short line for the user: what changed.' },
      dryRun: { type: 'boolean', description: 'Validate only.' },
      rev: { type: 'number', description: 'revert: revision to go back to (0 = none).' },
      section: { type: 'string', enum: ['index', 'all', 'schema', 'commands', 'ribbon', 'menus', 'toolbar', 'panel', 'shortcuts', 'styles', 'tokens', 'icons', 'defaults'] },
    },
    required: ['op'],
  },
}

/** What each catalog section is for — the index a model starts from. */
const SECTIONS: Record<string, string> = {
  schema: 'the shape of a whole profile, targets, actions, limits',
  commands: 'every command id a button, shortcut or pin may run (has a dot), with its menu path',
  ribbon: 'custom ribbon tabs/groups/buttons; built-in group ids to hide or reorder (desktop)',
  menus: 'pin items to the right-click menu or the quick-format bar per scope; hide their built-in items',
  toolbar: 'hide or reorder single toolbar buttons (web top bar and desktop ribbon); where the quick-format bar shows',
  panel: 'the order of the side panel\'s sections (one object / several objects / the slide)',
  shortcuts: 'bind keys; which built-in keys can be taken over or switched off, which never',
  styles: '"My styles" (looks applied to the selection) and presets (elements to insert); which keys a style may set',
  tokens: 'chrome colours (hex per theme), density, corner radius',
  icons: 'icon ids a button or action may show',
  defaults: 'personal default styles for NEW objects',
}

/** The ids a profile may use, for the model — per section, each with the
 *  how-to for writing that part (progressive disclosure: the skill stays a
 *  short workflow; the details come with the ids they are about). */
export function catalogFor(section = 'all'): Record<string, unknown> {
  const all: Record<string, unknown> = {
    schema: {
      top: '{ format: "slidomingo/ui-profile", version: 1, name?, enabled?, actions?, styles?, presets?, ribbon?, menus?, toolbar?, panel?, shortcuts?, chrome?, defaults? }',
      target: 'what a button, shortcut or pin runs: an action id (no dot) or a catalog command id (has a dot)',
      actions: 'id (lowercase, digits, dashes; NO dots; not "none") → { kind: "command", command } | { kind: "style", style } | { kind: "insert", preset } | { kind: "sequence", steps: [{ command } | { style } | { insert }] } — each may add label, icon',
      howto: 'Write the smallest merge patch. Records (actions, styles, presets, shortcuts, menus.*.add) merge key by key; ARRAYS replace whole (ribbon.tabs, ribbon.hide, menus.*.hide, menus.*.add.<scope>, toolbar.hide/order, panel.order) — send the full list including what is already there. null deletes a key.',
      limits: UI_LIMITS,
    },
    commands: commandCatalog(),
    ribbon: {
      tabs: Object.fromEntries(Object.entries(RIBBON_LAYOUT).map(([k, groups]) => [k, { label: RIBBON_TABS[k], groups }])),
      shape: '{ tabs?: [{ id, label, groups: [{ id, label, buttons: [{ target, label?, icon? }] }] }], hide?: [group id], order?: { <tab>: [group id] } }',
      howto: 'A custom tab comes after the built-in ones ("A Brand tab with…"). Group ids above are for hide/order; the Home tab always keeps one group. On the web there is no ribbon: custom tabs show in the "My tools" menu, hide/order of groups does nothing — use toolbar for single buttons there.',
    },
    menus: {
      shape: '{ context?: { add?: { <scope>: [target] }, hide?: [item id] }, minibar?: { add?: { <scope>: [target] }, hide?: [item id] } }',
      context: { what: 'the right-click menu on the canvas; pins show at the top', scopes: CONTEXT_SCOPES, items: CONTEXT_ITEMS },
      minibar: { what: 'the quick-format bar (docked at the top of the slide area and/or floating under a selection — toolbar.quickbar); pins show at its end', scopes: MINIBAR_SCOPES, items: MINIBAR_ITEMS },
      howto: 'Scope = what is selected: an element type, "multi" (several), "canvas" (right-click on empty slide), "line", "text-edit" (inside a text edit), or "*" (every scope). "Put my Callout style in the right-click menu for text" → menus.context.add.text: ["<action id>"]. Hiding is per menu, not per scope. Up to 8 pins per scope.',
    },
    toolbar: {
      items: TOOLBAR_ITEMS,
      shape: '{ hide?: [item id], order?: [item id], quickbar?: "top" | "floating" | "both" | "off" }',
      howto: 'quickbar = where the quick-format bar shows: "top" (docked above the slide, the default), "floating" (under the selection), "both" or "off". One id space for the web top bar and the desktop ribbon (a button that only exists in one place is simply absent in the other). order = these buttons first in their group, in this order. Save and Settings can\'t be hidden.',
    },
    panel: {
      sections: PANEL_SECTIONS,
      shape: '{ order?: [section id] }',
      howto: 'The side panel\'s sections in this order, per panel (scope): listed ids first, the rest after them in their usual order; the fixed top part (type, Duplicate/Delete and the basics) always stays first. "type" = an object\'s own sections (Typography, Fill & stroke, Data…), which move together. Send the full list.',
    },
    shortcuts: {
      shape: '{ "Mod+Shift+B": target | "none" }',
      overridable: OVERRIDABLE_CHORDS,
      locked: LOCKED_CHORDS,
      howto: 'Mod = ⌘ on a Mac, Ctrl elsewhere; Mod or Alt is required except for F1–F12; keys A–Z, 0–9, F1–F12. A free chord just works. An "overridable" chord is the editor\'s own key (value = what it does today): binding it replaces that, and "none" switches it off — say so to the user. "locked" chords are refused (clipboard, undo, save, text editing, system keys). Inside a text edit and in form fields the editor keeps its keys.',
    },
    styles: {
      patchKeys: Object.fromEntries(PATCH_KEYS.map((k) => [k, typesWithKey(k)])),
      shape: 'styles: id → { label, patch: { <patchKey>: value } }; presets: id → { label, elements: [element JSON] }',
      howto: `A style is looks only, applied to every selected element that has the key (one undo step) — give it a "style" action, then a button, shortcut or pin. If the request mentions the selection, start from its values. Presets hold ${PRESET_TYPES.join(', ')} elements (each needs an id and its type's required fields); give them an "insert" action.`,
    },
    tokens: {
      tokens: TOKENS,
      shape: 'chrome: { density?: "comfortable" | "compact", light?: { <token>: "#rrggbb" }, dark?: { <token>: "#rrggbb" }, radius?: 0–20 }',
      howto: 'Hex only. Set both themes unless asked for one. Low contrast is a warning, not an error — fix or mention it.',
    },
    icons: ICON_NAMES,
    defaults: {
      shape: '{ shape?: {fill, stroke, strokeWidth, radius, opacity, shadow…}, shapes?: { rect|ellipse|triangle|arrow|path: … }, line?: {color, width, strokeStyle…}, text?: {fontFamily, fontSize, fontWeight, color, lineHeight, align} }',
      howto: 'Used only when a NEW object is created, and only where the deck and its slide types set nothing themselves (a deck\'s own defaults always win) — tell the user that.',
    },
  }
  if (section === 'index') {
    return { sections: SECTIONS, next: 'Ask for the sections the request needs: op catalog with section <name> (several calls are fine). "all" returns everything.' }
  }
  return section === 'all' || !(section in all) ? all : { [section]: all[section] }
}

const fmtIssues = (list: UiIssue[]): string => list.map((i) => `- ${i.path || '(profile)'}: ${i.message}`).join('\n')

function describe(p: UiProfile | null): string {
  const s = summarizeProfile(p)
  return `${s.tabs} custom tab(s), ${s.buttons} button(s), ${s.hidden} hidden group(s), ${s.shortcuts} shortcut(s), ${s.styles} style(s), ` +
    `${s.presets} preset(s), ${s.actions} action(s), ${s.pinned} pinned menu item(s), ${s.hiddenItems} hidden menu/toolbar item(s), ` +
    `${s.tokens} colour override(s), density ${s.density ?? 'comfortable'}${s.defaults ? ', personal default styles' : ''}`
}

/** Runs one `ui_profile` call. `source` says who asked (chat / agent). */
export function runUiProfileTool(svc: UiProfileService, args: Record<string, unknown>, source: UiSource): { text: string; isError: boolean } {
  const err = (text: string) => ({ text: `Error: ${text}`, isError: true })
  if (svc.disabled) return err(DISABLED)
  const op = args.op
  const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
  const { profile, rev } = currentProfile(svc)
  if (op === 'get') return { text: JSON.stringify({ rev, summary: describe(profile), profile }, null, 1), isError: false }
  if (op === 'catalog') return { text: JSON.stringify(catalogFor(typeof args.section === 'string' ? args.section : 'index')), isError: false }
  if (op === 'history') return { text: JSON.stringify({ current: rev, history: uiHistory(svc) }), isError: false }
  if (op === 'patch' || op === 'set') {
    const v = op === 'patch' ? validatePatch(profile, args.patch) : validateProfile(args.profile, 'strict')
    if (!v.profile) return err(`refused — nothing changed. Fix these and try again:\n${fmtIssues(v.errors)}`)
    const warn = v.warnings.length ? `\nWarnings (it works, but check):\n${fmtIssues(v.warnings)}` : ''
    if (args.dryRun === true) return { text: `Valid (dry run, nothing written). Would give: ${describe(v.profile)}.${warn}`, isError: false }
    if (!summary) return err('summary is required: one short line telling the user what changed (it is shown with an Undo button).')
    const r = writeProfile(svc, v.profile, source, summary)
    if (!r.ok) return err(r.error ?? fmtIssues(r.errors ?? []))
    return { text: `Applied as revision #${r.rev} (undo: revert to #${rev}). Now: ${describe(v.profile)}.${warn}`, isError: false }
  }
  if (op === 'revert') {
    const to = typeof args.rev === 'number' ? args.rev : NaN
    const r = revertProfile(svc, to, source, summary || `Back to #${to}`)
    if (!r.ok) return err(r.error === 'too-old' ? `revision ${to} is no longer in the history (see op history)` : (r.error ?? 'revert failed'))
    return { text: `Reverted to how it was after #${to}, as revision #${r.rev}.`, isError: false }
  }
  if (op === 'reset') {
    const r = resetProfile(svc, source, summary || 'Removed all customizations')
    return r.ok ? { text: `All customizations removed (revision #${r.rev}; revert to #${rev} to undo).`, isError: false } : err(r.error ?? 'reset failed')
  }
  return err('op must be get, catalog, patch, set, history, revert or reset')
}
