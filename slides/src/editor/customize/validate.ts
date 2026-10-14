// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The only door into a UI profile (schema.ts). Two modes:
//
//   strict  — for WRITES (Settings, Import, the AI's ui_profile tool): any
//             error refuses the whole profile, and the errors say exactly
//             what to fix, so a model can repair its patch and retry.
//   lenient — for LOADS (localStorage, the desktop store, a profile written
//             by a newer build): whatever is invalid is DROPPED and the rest
//             still applies, so one bad entry can never take the editor's
//             chrome down with it.
//
// Same rule as untrusted.ts: an invalid value is dropped or refused, never
// repaired. Ids come from the closed catalogs in catalog.ts; element values go
// through untrusted.ts's own checks; labels are plain text.

import { checkElementProp, isSafeColor, sanitizeElement, sanitizeStyleDefaults } from '../../untrusted.ts'
import {
  CONTEXT_ITEMS, CONTEXT_SCOPES, CONTRAST_PAIRS, ICON_NAMES, MINIBAR_ITEMS, MINIBAR_SCOPES, OVERRIDABLE_CHORDS, PATCH_KEYS,
  PRESET_TYPES, RIBBON_LAYOUT, RIBBON_TABS, TOKENS, TOOLBAR_ITEMS, isBuiltinChord, isCatalogCommand, isLockedChord,
  PANEL_SECTIONS, RETIRED_PANEL_SECTIONS, RETIRED_TOOLBAR_ITEMS, ribbonGroupIds, typesWithKey, type CatalogItem,
} from './catalog.ts'
import { HEX_COLOR, cleanText, contrastRatio, mergePatch, normalizeChord, stableJson, tokenValue } from './logic.ts'
import {
  QUICKBAR_PLACES, SHORTCUT_NONE, UI_PROFILE_FORMAT, UI_PROFILE_VERSION,
  type UiAction, type UiButton, type UiChrome, type UiGroup, type UiIssue, type UiMenu, type UiMenus, type UiPreset,
  type UiProfile, type UiRibbon, type UiStep, type UiStyle, type UiTab, type UiToolbar, type UiPanel, type UiValidation,
} from './schema.ts'

/** Ceilings — none is a security boundary; they keep a profile small enough
 *  that applying it is instant and a runaway agent can't bloat it. */
export const UI_LIMITS = {
  bytes: 512 * 1024,
  name: 60,
  label: 40,
  actions: 64,
  styles: 64,
  presets: 32,
  presetElements: 24,
  sequence: 16,
  tabs: 6,
  groups: 8,
  buttons: 12,
  shortcuts: 64,
  /** pinned items per menu scope */
  menuItems: 8,
  radius: 20,
} as const

export const ID_RE = /^[a-z][a-z0-9-]{0,39}$/

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const TOP_KEYS = ['format', 'version', 'name', 'enabled', 'actions', 'styles', 'presets', 'ribbon', 'shortcuts', 'menus', 'toolbar', 'panel', 'chrome', 'defaults']

class Ctx {
  errors: UiIssue[] = []
  warnings: UiIssue[] = []
  err(path: string, code: string, message: string) { this.errors.push({ path, code, message }) }
  warn(path: string, code: string, message: string) { this.warnings.push({ path, code, message }) }
  /** Unknown keys of an object: each one is an error (dropped when lenient). */
  only(path: string, v: Record<string, unknown>, keys: readonly string[]) {
    for (const k of Object.keys(v)) if (!keys.includes(k)) this.err(`${path}.${k}`, 'unknown-key', `"${k}" is not a field of ${path || 'a profile'} (allowed: ${keys.join(', ')})`)
  }
  text(path: string, v: unknown, max: number, required: boolean): string | undefined {
    if (v === undefined && !required) return undefined
    if (typeof v !== 'string') { this.err(path, 'not-text', `${path} must be text`); return undefined }
    const s = cleanText(v)
    if (s !== v.trim()) this.err(path, 'bad-chars', `${path} contains control or text-direction characters`)
    if (!s) { if (required) this.err(path, 'empty', `${path} must not be empty`); return undefined }
    if (s.length > max) { this.err(path, 'too-long', `${path} is longer than ${max} characters`); return s.slice(0, max) }
    return s
  }
  icon(path: string, v: unknown): string | undefined {
    if (v === undefined) return undefined
    if (typeof v === 'string' && ICON_NAMES.includes(v)) return v
    this.err(path, 'unknown-icon', `${path}: "${String(v)}" is not an icon (see the catalog's icons)`)
    return undefined
  }
  capped<T>(path: string, entries: T[], max: number, what: string): T[] {
    if (entries.length > max) this.err(path, 'too-many', `at most ${max} ${what} (got ${entries.length})`)
    return entries.slice(0, max)
  }
}

/** One style-patch value, checked for the element types that have the key. */
function checkPatchValue(key: string, value: unknown): { ok: boolean; value?: unknown } {
  for (const type of typesWithKey(key)) {
    const r = checkElementProp(type, key, value)
    if (r.ok) return r
  }
  return { ok: false }
}

function validStyles(c: Ctx, raw: unknown): Record<string, UiStyle> | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) { c.err('styles', 'not-object', 'styles must be an object of id → style'); return undefined }
  const out: Record<string, UiStyle> = {}
  for (const [id, v] of c.capped('styles', Object.entries(raw), UI_LIMITS.styles, 'styles')) {
    const p = `styles.${id}`
    if (!ID_RE.test(id)) { c.err(p, 'bad-id', `style id "${id}" must be lowercase letters, digits and dashes`); continue }
    if (!isObj(v)) { c.err(p, 'not-object', `${p} must be { label, patch }`); continue }
    c.only(p, v, ['label', 'patch'])
    const label = c.text(`${p}.label`, v.label, UI_LIMITS.label, true)
    if (!isObj(v.patch)) { c.err(`${p}.patch`, 'not-object', `${p}.patch must be an object of element properties`); continue }
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(v.patch)) {
      if (!PATCH_KEYS.includes(key)) { c.err(`${p}.patch.${key}`, 'not-patchable', `"${key}" can't be part of a style (allowed: ${PATCH_KEYS.join(', ')})`); continue }
      const r = checkPatchValue(key, value)
      if (!r.ok) { c.err(`${p}.patch.${key}`, 'bad-value', `${JSON.stringify(value)?.slice(0, 80)} is not a valid ${key}`); continue }
      if (stableJson(r.value) !== stableJson(value)) c.err(`${p}.patch.${key}`, 'bad-value', `${key} has parts that are not valid`)
      patch[key] = r.value
    }
    if (!label || !Object.keys(patch).length) {
      if (label && !Object.keys(patch).length) c.err(`${p}.patch`, 'empty', `${p}.patch has no valid property`)
      continue
    }
    out[id] = { label, patch }
  }
  return out
}

function validPresets(c: Ctx, raw: unknown): Record<string, UiPreset> | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) { c.err('presets', 'not-object', 'presets must be an object of id → preset'); return undefined }
  const out: Record<string, UiPreset> = {}
  for (const [id, v] of c.capped('presets', Object.entries(raw), UI_LIMITS.presets, 'presets')) {
    const p = `presets.${id}`
    if (!ID_RE.test(id)) { c.err(p, 'bad-id', `preset id "${id}" must be lowercase letters, digits and dashes`); continue }
    if (!isObj(v)) { c.err(p, 'not-object', `${p} must be { label, elements }`); continue }
    c.only(p, v, ['label', 'elements'])
    const label = c.text(`${p}.label`, v.label, UI_LIMITS.label, true)
    if (!Array.isArray(v.elements) || !v.elements.length) { c.err(`${p}.elements`, 'empty', `${p}.elements must be a non-empty array of elements`); continue }
    const els = []
    for (const [i, el] of c.capped(`${p}.elements`, v.elements, UI_LIMITS.presetElements, 'elements per preset').entries()) {
      const ep = `${p}.elements.${i}`
      const type = isObj(el) ? el.type : undefined
      if (typeof type !== 'string' || !PRESET_TYPES.includes(type)) { c.err(ep, 'bad-type', `a preset may hold ${PRESET_TYPES.join(', ')} elements (got ${String(type)})`); continue }
      const clean = sanitizeElement(el)
      if (!clean) { c.err(ep, 'bad-element', `${ep} is not a valid ${type} element (an id and the type's required fields are needed)`); continue }
      const kept = clean as unknown as Record<string, unknown>
      for (const k of Object.keys(el as Record<string, unknown>)) {
        if (!(k in kept)) c.err(`${ep}.${k}`, 'bad-value', `${ep}.${k} is not valid for a ${type}`)
        else if (k !== 'rows' && stableJson(kept[k]) !== stableJson((el as Record<string, unknown>)[k])) c.err(`${ep}.${k}`, 'bad-value', `${ep}.${k} has parts that are not valid`)
      }
      els.push(clean)
    }
    if (label && els.length) out[id] = { label, elements: els }
  }
  return out
}

function validStep(c: Ctx, path: string, v: unknown, styles: Record<string, UiStyle>, presets: Record<string, UiPreset>): UiStep | null {
  if (!isObj(v) || Object.keys(v).length !== 1) { c.err(path, 'bad-step', `${path} must be exactly one of { command }, { style }, { insert }`); return null }
  if (typeof v.command === 'string') {
    if (isCatalogCommand(v.command)) return { command: v.command }
    c.err(path, 'unknown-command', `"${v.command}" is not a command (see the catalog's commands)`); return null
  }
  if (typeof v.style === 'string') {
    if (styles[v.style]) return { style: v.style }
    c.err(path, 'unknown-style', `there is no style "${v.style}"`); return null
  }
  if (typeof v.insert === 'string') {
    if (presets[v.insert]) return { insert: v.insert }
    c.err(path, 'unknown-preset', `there is no preset "${v.insert}"`); return null
  }
  c.err(path, 'bad-step', `${path} must be exactly one of { command }, { style }, { insert }`)
  return null
}

function validActions(c: Ctx, raw: unknown, styles: Record<string, UiStyle>, presets: Record<string, UiPreset>): Record<string, UiAction> | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) { c.err('actions', 'not-object', 'actions must be an object of id → action'); return undefined }
  const out: Record<string, UiAction> = {}
  for (const [id, v] of c.capped('actions', Object.entries(raw), UI_LIMITS.actions, 'actions')) {
    const p = `actions.${id}`
    if (!ID_RE.test(id)) { c.err(p, 'bad-id', `action id "${id}" must be lowercase letters, digits and dashes (no dots — dotted ids are commands)`); continue }
    if (id === SHORTCUT_NONE) { c.err(p, 'bad-id', `"${SHORTCUT_NONE}" is reserved (a shortcut set to "none" switches a built-in key off)`); continue }
    if (!isObj(v)) { c.err(p, 'not-object', `${p} must be an object with a kind`); continue }
    const label = c.text(`${p}.label`, v.label, UI_LIMITS.label, false)
    const icon = c.icon(`${p}.icon`, v.icon)
    const extra = { ...(label ? { label } : {}), ...(icon ? { icon } : {}) }
    if (v.kind === 'command') {
      c.only(p, v, ['kind', 'command', 'label', 'icon'])
      if (typeof v.command === 'string' && isCatalogCommand(v.command)) out[id] = { kind: 'command', command: v.command, ...extra }
      else c.err(`${p}.command`, 'unknown-command', `"${String(v.command)}" is not a command (see the catalog's commands)`)
    } else if (v.kind === 'style') {
      c.only(p, v, ['kind', 'style', 'label', 'icon'])
      if (typeof v.style === 'string' && styles[v.style]) out[id] = { kind: 'style', style: v.style, ...extra }
      else c.err(`${p}.style`, 'unknown-style', `there is no style "${String(v.style)}"`)
    } else if (v.kind === 'insert') {
      c.only(p, v, ['kind', 'preset', 'label', 'icon'])
      if (typeof v.preset === 'string' && presets[v.preset]) out[id] = { kind: 'insert', preset: v.preset, ...extra }
      else c.err(`${p}.preset`, 'unknown-preset', `there is no preset "${String(v.preset)}"`)
    } else if (v.kind === 'sequence') {
      c.only(p, v, ['kind', 'steps', 'label', 'icon'])
      if (!Array.isArray(v.steps) || !v.steps.length) { c.err(`${p}.steps`, 'empty', `${p}.steps must be a non-empty array`); continue }
      const steps = c.capped(`${p}.steps`, v.steps, UI_LIMITS.sequence, 'steps')
        .map((s, i) => validStep(c, `${p}.steps.${i}`, s, styles, presets)).filter((s): s is UiStep => !!s)
      if (steps.length) out[id] = { kind: 'sequence', steps, ...extra }
    } else c.err(`${p}.kind`, 'bad-kind', `${p}.kind must be command, style, insert or sequence`)
  }
  return out
}

function validTarget(c: Ctx, path: string, t: unknown, actions: Record<string, UiAction>): string | null {
  if (typeof t !== 'string') { c.err(path, 'bad-target', `${path} must be an action id or a command id`); return null }
  if (!t.includes('.')) {
    if (actions[t]) return t
    c.err(path, 'unknown-action', `there is no action "${t}"`); return null
  }
  if (isCatalogCommand(t)) return t
  c.err(path, 'unknown-command', `"${t}" is not a command (see the catalog's commands)`)
  return null
}

function validRibbon(c: Ctx, raw: unknown, actions: Record<string, UiAction>): UiRibbon | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) { c.err('ribbon', 'not-object', 'ribbon must be { tabs?, hide?, order? }'); return undefined }
  c.only('ribbon', raw, ['tabs', 'hide', 'order'])
  const out: UiRibbon = {}
  if (raw.tabs !== undefined) {
    if (!Array.isArray(raw.tabs)) c.err('ribbon.tabs', 'not-array', 'ribbon.tabs must be an array')
    else {
      const tabIds = new Set<string>()
      const tabs: UiTab[] = []
      for (const [ti, tab] of c.capped('ribbon.tabs', raw.tabs, UI_LIMITS.tabs, 'custom tabs').entries()) {
        const tp = `ribbon.tabs.${ti}`
        if (!isObj(tab)) { c.err(tp, 'not-object', `${tp} must be { id, label, groups }`); continue }
        c.only(tp, tab, ['id', 'label', 'groups'])
        const id = typeof tab.id === 'string' && ID_RE.test(tab.id) ? tab.id : null
        if (!id) { c.err(`${tp}.id`, 'bad-id', `${tp}.id must be lowercase letters, digits and dashes`); continue }
        if (tabIds.has(id) || id in RIBBON_TABS) { c.err(`${tp}.id`, 'duplicate', `tab id "${id}" is already taken`); continue }
        tabIds.add(id)
        const label = c.text(`${tp}.label`, tab.label, UI_LIMITS.label, true)
        if (!label) continue
        const groups: UiGroup[] = []
        const groupIds = new Set<string>()
        const rawGroups = Array.isArray(tab.groups) ? tab.groups : (c.err(`${tp}.groups`, 'not-array', `${tp}.groups must be an array`), [])
        for (const [gi, g] of c.capped(`${tp}.groups`, rawGroups, UI_LIMITS.groups, 'groups per tab').entries()) {
          const gp = `${tp}.groups.${gi}`
          if (!isObj(g)) { c.err(gp, 'not-object', `${gp} must be { id, label, buttons }`); continue }
          c.only(gp, g, ['id', 'label', 'buttons'])
          const gid = typeof g.id === 'string' && ID_RE.test(g.id) && !groupIds.has(g.id) ? g.id : null
          if (!gid) { c.err(`${gp}.id`, 'bad-id', `${gp}.id must be a unique id (lowercase letters, digits, dashes)`); continue }
          groupIds.add(gid)
          const glabel = c.text(`${gp}.label`, g.label, UI_LIMITS.label, true)
          if (!glabel) continue
          const buttons: UiButton[] = []
          const rawButtons = Array.isArray(g.buttons) ? g.buttons : (c.err(`${gp}.buttons`, 'not-array', `${gp}.buttons must be an array`), [])
          for (const [bi, b] of c.capped(`${gp}.buttons`, rawButtons, UI_LIMITS.buttons, 'buttons per group').entries()) {
            const bp = `${gp}.buttons.${bi}`
            if (!isObj(b)) { c.err(bp, 'not-object', `${bp} must be { target, label?, icon? }`); continue }
            c.only(bp, b, ['target', 'label', 'icon'])
            const target = validTarget(c, `${bp}.target`, b.target, actions)
            const blabel = c.text(`${bp}.label`, b.label, UI_LIMITS.label, false)
            const icon = c.icon(`${bp}.icon`, b.icon)
            if (target) buttons.push({ target, ...(blabel ? { label: blabel } : {}), ...(icon ? { icon } : {}) })
          }
          if (!buttons.length) c.warn(gp, 'empty-group', `group "${glabel}" has no buttons`)
          groups.push({ id: gid, label: glabel, buttons })
        }
        tabs.push({ id, label, groups })
      }
      if (tabs.length) out.tabs = tabs
    }
  }
  const known = ribbonGroupIds()
  if (raw.hide !== undefined) {
    if (!Array.isArray(raw.hide)) c.err('ribbon.hide', 'not-array', 'ribbon.hide must be an array of built-in group ids')
    else {
      const hide = [...new Set(raw.hide.filter((h, i): h is string => {
        if (typeof h === 'string' && known.includes(h)) return true
        c.err(`ribbon.hide.${i}`, 'unknown-group', `"${String(h)}" is not a built-in ribbon group (see the catalog's ribbon)`)
        return false
      }))]
      // can't lock yourself out: Home always keeps at least one group
      if (RIBBON_LAYOUT.home.every((g) => hide.includes(g.id))) {
        c.err('ribbon.hide', 'lockout', 'the Home tab must keep at least one group')
        hide.splice(hide.indexOf(RIBBON_LAYOUT.home[0].id), 1)
      }
      out.hide = hide
    }
  }
  if (raw.order !== undefined) {
    if (!isObj(raw.order)) c.err('ribbon.order', 'not-object', 'ribbon.order must be { <tab>: [group ids] }')
    else {
      const order: Record<string, string[]> = {}
      for (const [tab, ids] of Object.entries(raw.order)) {
        const op = `ribbon.order.${tab}`
        const own = RIBBON_LAYOUT[tab]?.map((g) => g.id)
        if (!own) { c.err(op, 'unknown-tab', `"${tab}" is not a built-in tab (${Object.keys(RIBBON_TABS).join(', ')})`); continue }
        if (!Array.isArray(ids)) { c.err(op, 'not-array', `${op} must be an array of that tab's group ids`); continue }
        const list: string[] = []
        for (const [i, gid] of ids.entries()) {
          if (typeof gid === 'string' && own.includes(gid) && !list.includes(gid)) list.push(gid)
          else c.err(`${op}.${i}`, 'unknown-group', `"${String(gid)}" is not a group of the ${tab} tab (or is listed twice)`)
        }
        if (list.length) order[tab] = list
      }
      out.order = order
    }
  }
  return out
}

function validShortcuts(c: Ctx, raw: unknown, actions: Record<string, UiAction>): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) { c.err('shortcuts', 'not-object', 'shortcuts must be an object of chord → target'); return undefined }
  const out: Record<string, string> = {}
  for (const [chord, target] of c.capped('shortcuts', Object.entries(raw), UI_LIMITS.shortcuts, 'shortcuts')) {
    const p = `shortcuts.${chord}`
    const norm = normalizeChord(chord)
    if (!norm) { c.err(p, 'bad-chord', `"${chord}" is not a chord this editor can bind: Mod/Alt/Shift + a letter, digit or F1–F12, with Mod or Alt unless it is an F-key (e.g. "Mod+Shift+B")`); continue }
    if (isLockedChord(norm)) { c.err(p, 'reserved', `${norm} can't be changed (clipboard, undo, save, text editing and system keys stay as they are); pick another`); continue }
    if (out[norm]) { c.err(p, 'duplicate', `${norm} is bound twice`); continue }
    const builtin = isBuiltinChord(norm)
    if (target === SHORTCUT_NONE) {
      if (!builtin) { c.err(p, 'nothing-to-switch-off', `${norm} is not one of the editor's shortcuts, so "none" has nothing to switch off`); continue }
      out[norm] = SHORTCUT_NONE
      continue
    }
    const t = validTarget(c, p, target, actions)
    if (!t) continue
    if (builtin) c.warn(p, 'replaces-builtin', `${norm} was the editor's shortcut for ${OVERRIDABLE_CHORDS[norm] ?? 'something else'}; it now runs "${t}" instead`)
    out[norm] = t
  }
  return out
}

function validMenu(c: Ctx, path: string, raw: unknown, scopes: readonly string[], items: readonly CatalogItem[], actions: Record<string, UiAction>): UiMenu | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) { c.err(path, 'not-object', `${path} must be { add?, hide? }`); return undefined }
  c.only(path, raw, ['add', 'hide'])
  const out: UiMenu = {}
  if (raw.add !== undefined) {
    if (!isObj(raw.add)) c.err(`${path}.add`, 'not-object', `${path}.add must be { <scope>: [targets] } (scopes: ${scopes.join(', ')})`)
    else {
      const add: Record<string, string[]> = {}
      for (const [scope, list] of Object.entries(raw.add)) {
        const sp = `${path}.add.${scope}`
        if (!scopes.includes(scope)) { c.err(sp, 'unknown-scope', `"${scope}" is not a scope of this menu (${scopes.join(', ')})`); continue }
        if (!Array.isArray(list)) { c.err(sp, 'not-array', `${sp} must be an array of targets`); continue }
        const targets: string[] = []
        for (const [i, t] of c.capped(sp, list, UI_LIMITS.menuItems, 'pinned items per scope').entries()) {
          const ok = validTarget(c, `${sp}.${i}`, t, actions)
          if (ok && !targets.includes(ok)) targets.push(ok)
        }
        if (targets.length) add[scope] = targets
      }
      if (Object.keys(add).length) out.add = add
    }
  }
  if (raw.hide !== undefined) {
    const known = items.map((i) => i.id)
    if (!Array.isArray(raw.hide)) c.err(`${path}.hide`, 'not-array', `${path}.hide must be an array of built-in item ids`)
    else {
      const hide = [...new Set(raw.hide.filter((h, i): h is string => {
        if (typeof h === 'string' && known.includes(h)) return true
        c.err(`${path}.hide.${i}`, 'unknown-item', `"${String(h)}" is not a built-in item of this menu (${known.join(', ')})`)
        return false
      }))]
      if (hide.length) out.hide = hide
    }
  }
  return out.add || out.hide ? out : undefined
}

function validMenus(c: Ctx, raw: unknown, actions: Record<string, UiAction>): UiMenus | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) { c.err('menus', 'not-object', 'menus must be { context?, minibar? }'); return undefined }
  c.only('menus', raw, ['context', 'minibar'])
  const out: UiMenus = {}
  const context = validMenu(c, 'menus.context', raw.context, CONTEXT_SCOPES, CONTEXT_ITEMS, actions)
  const minibar = validMenu(c, 'menus.minibar', raw.minibar, MINIBAR_SCOPES, MINIBAR_ITEMS, actions)
  if (context) out.context = context
  if (minibar) out.minibar = minibar
  return out
}

function validToolbar(c: Ctx, raw: unknown): UiToolbar | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) { c.err('toolbar', 'not-object', 'toolbar must be { hide?, order?, quickbar? }'); return undefined }
  c.only('toolbar', raw, ['hide', 'order', 'quickbar'])
  const known = TOOLBAR_ITEMS.map((i) => i.id)
  const out: UiToolbar = {}
  for (const key of ['hide', 'order'] as const) {
    const v = raw[key]
    if (v === undefined) continue
    if (!Array.isArray(v)) { c.err(`toolbar.${key}`, 'not-array', `toolbar.${key} must be an array of toolbar button ids`); continue }
    const list: string[] = []
    for (const [i, id] of v.entries()) {
      if (typeof id === 'string' && known.includes(id) && !list.includes(id)) list.push(id)
      else if (typeof id === 'string' && RETIRED_TOOLBAR_ITEMS.includes(id)) continue
      else c.err(`toolbar.${key}.${i}`, 'unknown-item', `"${String(id)}" is not a toolbar button (or is listed twice; see the catalog's toolbar)`)
    }
    if (list.length) out[key] = list
  }
  if (raw.quickbar !== undefined) {
    if (typeof raw.quickbar === 'string' && (QUICKBAR_PLACES as readonly string[]).includes(raw.quickbar)) out.quickbar = raw.quickbar as UiToolbar['quickbar']
    else c.err('toolbar.quickbar', 'bad-value', `toolbar.quickbar must be one of ${QUICKBAR_PLACES.join(', ')}`)
  }
  return out
}

function validPanel(c: Ctx, raw: unknown): UiPanel | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) { c.err('panel', 'not-object', 'panel must be { order? }'); return undefined }
  c.only('panel', raw, ['order'])
  const out: UiPanel = {}
  if (raw.order !== undefined) {
    if (!Array.isArray(raw.order)) { c.err('panel.order', 'not-array', 'panel.order must be an array of side-panel section ids'); return out }
    const known = PANEL_SECTIONS.map((p) => p.id)
    const list: string[] = []
    for (const [i, id] of raw.order.entries()) {
      if (typeof id === 'string' && known.includes(id) && !list.includes(id)) list.push(id)
      else if (typeof id === 'string' && RETIRED_PANEL_SECTIONS.includes(id)) continue
      else c.err(`panel.order.${i}`, 'unknown-item', `"${String(id)}" is not a side-panel section (or is listed twice; see the catalog's panel)`)
    }
    if (list.length) out.order = list
  }
  return out
}

function validChrome(c: Ctx, raw: unknown): UiChrome | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) { c.err('chrome', 'not-object', 'chrome must be { density?, light?, dark?, radius? }'); return undefined }
  c.only('chrome', raw, ['density', 'light', 'dark', 'radius'])
  const out: UiChrome = {}
  if (raw.density !== undefined) {
    if (raw.density === 'comfortable' || raw.density === 'compact') out.density = raw.density
    else c.err('chrome.density', 'bad-value', 'chrome.density must be "comfortable" or "compact"')
  }
  for (const theme of ['light', 'dark'] as const) {
    const v = raw[theme]
    if (v === undefined) continue
    if (!isObj(v)) { c.err(`chrome.${theme}`, 'not-object', `chrome.${theme} must be { <token>: "#rrggbb" }`); continue }
    const tokens: Record<string, string> = {}
    for (const [k, col] of Object.entries(v)) {
      const name = k.replace(/^--/, '')
      if (!(name in TOKENS)) { c.err(`chrome.${theme}.${k}`, 'unknown-token', `"${k}" is not a customizable token (${Object.keys(TOKENS).join(', ')})`); continue }
      if (typeof col !== 'string' || !HEX_COLOR.test(col) || !isSafeColor(col)) { c.err(`chrome.${theme}.${k}`, 'bad-color', `${theme} ${name} must be a hex colour like #0f766e`); continue }
      tokens[name] = col
    }
    if (Object.keys(tokens).length) out[theme] = tokens
  }
  if (raw.radius !== undefined) {
    if (typeof raw.radius === 'number' && Number.isInteger(raw.radius) && raw.radius >= 0 && raw.radius <= UI_LIMITS.radius) out.radius = raw.radius
    else c.err('chrome.radius', 'bad-value', `chrome.radius must be a whole number of px, 0–${UI_LIMITS.radius}`)
  }
  // readable chrome is a warning, not a refusal: the person may know better
  for (const theme of ['light', 'dark'] as const) {
    const touched = Object.keys(out[theme] ?? {})
    if (!touched.length) continue
    for (const [fg, bg, min] of CONTRAST_PAIRS) {
      if (!touched.includes(fg) && !touched.includes(bg)) continue
      const r = contrastRatio(tokenValue(out, theme, fg), tokenValue(out, theme, bg))
      if (r !== null && r < min) c.warn(`chrome.${theme}`, 'low-contrast', `${theme}: ${fg} on ${bg} is ${r.toFixed(2)}:1 (needs ${min}:1) — text there will be hard to read`)
    }
  }
  return out
}

/**
 * Validate a profile. `strict` refuses on any error (`profile: null`);
 * `lenient` returns what survived. Errors and warnings are reported either
 * way, each with a path and a message written for the person (or model)
 * who has to fix it.
 */
export function validateProfile(input: unknown, mode: 'strict' | 'lenient'): UiValidation {
  const c = new Ctx()
  const done = (profile: UiProfile | null): UiValidation =>
    ({ profile: mode === 'strict' && c.errors.length ? null : profile, errors: c.errors, warnings: c.warnings })
  if (!isObj(input)) { c.err('', 'not-object', 'a profile must be a JSON object'); return done(null) }
  let size = 0
  try { size = JSON.stringify(input).length } catch { c.err('', 'not-json', 'a profile must be plain JSON'); return done(null) }
  if (size > UI_LIMITS.bytes) { c.err('', 'too-big', `a profile is limited to ${UI_LIMITS.bytes / 1024} KB (this one is ${Math.ceil(size / 1024)} KB)`); return done(null) }
  if (input.format !== UI_PROFILE_FORMAT) { c.err('format', 'bad-format', `format must be "${UI_PROFILE_FORMAT}"`); return done(null) }
  if (input.version !== UI_PROFILE_VERSION) {
    c.err('version', 'bad-version', typeof input.version === 'number' && input.version > UI_PROFILE_VERSION
      ? `this profile is version ${input.version}, made by a newer build — this one reads version ${UI_PROFILE_VERSION}`
      : `version must be ${UI_PROFILE_VERSION}`)
    return done(null)
  }
  c.only('', input, TOP_KEYS)
  const out: UiProfile = { format: UI_PROFILE_FORMAT, version: UI_PROFILE_VERSION }
  const name = c.text('name', input.name, UI_LIMITS.name, false)
  if (name) out.name = name
  if (input.enabled !== undefined) {
    if (typeof input.enabled === 'boolean') out.enabled = input.enabled
    else c.err('enabled', 'bad-value', 'enabled must be true or false')
  }
  const styles = validStyles(c, input.styles)
  const presets = validPresets(c, input.presets)
  const actions = validActions(c, input.actions, styles ?? {}, presets ?? {})
  if (styles && Object.keys(styles).length) out.styles = styles
  if (presets && Object.keys(presets).length) out.presets = presets
  if (actions && Object.keys(actions).length) out.actions = actions
  const ribbon = validRibbon(c, input.ribbon, actions ?? {})
  if (ribbon && (ribbon.tabs?.length || ribbon.hide?.length || Object.keys(ribbon.order ?? {}).length)) out.ribbon = ribbon
  const shortcuts = validShortcuts(c, input.shortcuts, actions ?? {})
  if (shortcuts && Object.keys(shortcuts).length) out.shortcuts = shortcuts
  const menus = validMenus(c, input.menus, actions ?? {})
  if (menus && (menus.context || menus.minibar)) out.menus = menus
  const toolbar = validToolbar(c, input.toolbar)
  if (toolbar && (toolbar.hide || toolbar.order || toolbar.quickbar)) out.toolbar = toolbar
  const panel = validPanel(c, input.panel)
  if (panel?.order) out.panel = panel
  const chrome = validChrome(c, input.chrome)
  if (chrome && Object.keys(chrome).length) out.chrome = chrome
  if (input.defaults !== undefined) {
    const d = sanitizeStyleDefaults(input.defaults)
    if (!d) c.err('defaults', 'bad-value', 'defaults must be a style-defaults record ({ shape?, shapes?, line?, text? }) with valid values')
    else {
      if (stableJson(d) !== stableJson(input.defaults)) c.err('defaults', 'bad-value', 'defaults has fields or values that are not valid (they were dropped)')
      out.defaults = d
    }
  }
  // things that work but are probably not what was meant
  const used = new Set<string>()
  for (const a of Object.values(out.actions ?? {})) {
    if (a.kind === 'style') used.add(`style:${a.style}`)
    if (a.kind === 'insert') used.add(`preset:${a.preset}`)
    if (a.kind === 'sequence') for (const s of a.steps) { if ('style' in s) used.add(`style:${s.style}`); if ('insert' in s) used.add(`preset:${s.insert}`) }
  }
  for (const id of Object.keys(out.styles ?? {})) if (!used.has(`style:${id}`)) c.warn(`styles.${id}`, 'unused', `style "${id}" is not used by any action, so nothing can apply it yet`)
  for (const id of Object.keys(out.presets ?? {})) if (!used.has(`preset:${id}`)) c.warn(`presets.${id}`, 'unused', `preset "${id}" is not used by any action, so nothing can insert it yet`)
  return done(out)
}

/** `patch` (RFC 7386) merged onto `current`, then strictly validated — what
 *  the ui_profile tool runs before a write. `format`/`version` come from
 *  `current` (or a fresh profile), so a patch never has to repeat them. */
export function validatePatch(current: UiProfile | null, patch: unknown): UiValidation {
  if (!isObj(patch)) return { profile: null, errors: [{ path: '', code: 'not-object', message: 'a patch must be a JSON object (RFC 7386 merge patch)' }], warnings: [] }
  const base = current ?? { format: UI_PROFILE_FORMAT, version: UI_PROFILE_VERSION }
  return validateProfile(mergePatch(base, patch), 'strict')
}
