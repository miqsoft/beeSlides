// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Pure helpers shared by the validator (validate.ts), the renderer side
// (apply.ts, settingspane.ts) and the desktop main process: chords, merge
// patch, colour contrast, the token stylesheet, applying a style patch to
// elements, and a short summary of a profile. No DOM, `.ts` specifiers.

import type { SlideElement } from '../../model.ts'
import { MODEL_KEYS } from '../../modelkeys.generated.ts'
import { CHORD_KEY, PANEL_SECTIONS, TOKENS, TOOLBAR_ITEMS, type PanelSection } from './catalog.ts'
import { PROFILE_PARTS, SHORTCUT_NONE, type UiToolbar, UI_PROFILE_FORMAT, UI_PROFILE_VERSION, type UiAction, type UiChrome, type UiMenu, type UiPart, type UiProfile } from './schema.ts'

// ---- chords ------------------------------------------------------------------

const MOD_ALIASES = new Set(['mod', 'cmd', 'command', 'meta', 'ctrl', 'control', 'cmdorctrl', 'commandorcontrol', 'super'])
const ALT_ALIASES = new Set(['alt', 'option', 'opt'])

/** "cmd+shift+b" / "CmdOrCtrl+Shift+B" / "Mod+Shift+B" → "Mod+Shift+B";
 *  null when it is not a chord this editor can bind (see CHORD_KEY). */
export function normalizeChord(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return null
  let mod = false, alt = false, shift = false
  for (const p of parts.slice(0, -1)) {
    const l = p.toLowerCase()
    if (MOD_ALIASES.has(l)) { if (mod) return null; mod = true }
    else if (ALT_ALIASES.has(l)) { if (alt) return null; alt = true }
    else if (l === 'shift') { if (shift) return null; shift = true }
    else return null
  }
  const key = parts[parts.length - 1].toUpperCase()
  if (!CHORD_KEY.test(key)) return null
  const fkey = /^F\d/.test(key)
  // a plain letter, or ⇧ + a letter, types text: it can never be a shortcut
  if (!mod && !alt && !fkey) return null
  return [mod && 'Mod', alt && 'Alt', shift && 'Shift', key].filter(Boolean).join('+')
}

export interface KeyLike { code: string; key?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/** The normalized chord a keydown is, or null. Mod is ⌘ on a Mac, Ctrl
 *  elsewhere; the key comes from `code`, so ⌥ (which changes `key` on a Mac)
 *  and the keyboard layout don't matter. A Mac's Ctrl is not a modifier here. */
export function chordFromEvent(ev: KeyLike, mac: boolean): string | null {
  if (mac && ev.ctrlKey) return null
  if (!mac && ev.metaKey) return null
  const mod = mac ? ev.metaKey : ev.ctrlKey
  let key: string | null = null
  const m = /^(?:Key([A-Z])|Digit([0-9])|(F(?:[1-9]|1[0-2])))$/.exec(ev.code)
  if (m) key = m[1] ?? m[2] ?? m[3]
  if (!key) return null
  return normalizeChord([mod && 'Mod', ev.altKey && 'Alt', ev.shiftKey && 'Shift', key].filter(Boolean).join('+'))
}

/** How a chord is shown: ⌘⌥⇧B on a Mac, Ctrl+Alt+Shift+B elsewhere. */
export function displayChord(chord: string, mac: boolean): string {
  const parts = chord.split('+')
  const key = parts.pop()!
  if (mac) return parts.map((p) => ({ Mod: '⌘', Alt: '⌥', Shift: '⇧' } as Record<string, string>)[p] ?? p).join('') + key
  return [...parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)), key].join('+')
}

// ---- JSON merge patch (RFC 7386) ----------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** RFC 7386: objects merge key by key, `null` deletes, anything else
 *  (arrays included) replaces. Never mutates its inputs. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObj(patch)) return clone(patch)
  const out: Record<string, unknown> = isObj(target) ? { ...target } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__') continue
    if (v === null) delete out[k]
    else out[k] = mergePatch(out[k], v)
  }
  return out
}

export const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

/** Key-order-independent JSON, for "did this change" checks. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

// ---- colour -------------------------------------------------------------------

export const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function rgbOf(hex: string): [number, number, number] | null {
  if (!HEX_COLOR.test(hex)) return null
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1)
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio of two hex colours (1..21), or null when either is not hex. */
export function contrastRatio(a: string, b: string): number | null {
  const x = rgbOf(a), y = rgbOf(b)
  if (!x || !y) return null
  const [l1, l2] = [luminance(x), luminance(y)].sort((p, q) => q - p)
  return (l1 + 0.05) / (l2 + 0.05)
}

/** The token value in force for a theme: the override, else the built-in. */
export function tokenValue(chrome: UiChrome | undefined, theme: 'light' | 'dark', token: string): string {
  return chrome?.[theme]?.[token] ?? TOKENS[token]?.[theme]
}

/**
 * The stylesheet a profile's chrome adds (or '' for none). Built ONLY from
 * validated values — catalog token names and hex colours, an integer radius —
 * so no text from a profile is ever CSS. `html:root` outranks styles.css's
 * `:root[data-theme=…]` at equal attribute count, whatever the order.
 */
export function tokenCss(chrome: UiChrome | undefined): string {
  if (!chrome) return ''
  const decls = (theme: 'light' | 'dark') => Object.entries(chrome[theme] ?? {})
    .filter(([k, v]) => k in TOKENS && HEX_COLOR.test(v))
    .map(([k, v]) => `--${k}: ${v};`).join(' ')
  const rules: string[] = []
  const light = decls('light'), dark = decls('dark')
  if (light) rules.push(`html:root:not([data-theme="dark"]) { ${light} }`)
  if (dark) rules.push(`html:root[data-theme="dark"] { ${dark} }`)
  if (typeof chrome.radius === 'number' && Number.isInteger(chrome.radius)) rules.push(`html:root { --radius: ${chrome.radius}px; }`)
  return rules.join('\n')
}

/**
 * The stylesheet a profile's toolbar adds: hidden buttons (and a ribbon
 * group left with nothing to show), and `order` as CSS flex order — listed
 * buttons first in their group, in that order. CSS rather than DOM surgery,
 * so it holds for buttons built later (the Layout Manager's insert bar, a
 * rebuild after a language switch) and survives the phone fold. Only
 * catalog ids reach the selectors.
 */
export function toolbarCss(tb: UiToolbar | undefined): string {
  if (!tb) return ''
  const known = new Set(TOOLBAR_ITEMS.map((i) => i.id))
  const sel = (id: string) => `[data-ui-tool="${id}"]`
  const hide = (tb.hide ?? []).filter((id) => known.has(id))
  const rules: string[] = []
  if (hide.length) {
    rules.push(`${hide.map(sel).join(', ')} { display: none !important; }`)
    // a ribbon group whose every control is hidden goes too (caption and all)
    rules.push(`.ed-ribbon-group:has(> .ed-ribbon-group-body > [data-ui-tool]):not(:has(> .ed-ribbon-group-body > :not(${hide.map(sel).join(', ')}))) { display: none !important; }`)
  }
  ;(tb.order ?? []).filter((id) => known.has(id)).forEach((id, i, all) => rules.push(`${sel(id)} { order: ${i - all.length}; }`))
  return rules.join('\n')
}

// ---- styles -------------------------------------------------------------------

/** Element types that have `key` (the format's own key table). */
export function hasKey(type: string, key: string): boolean {
  return ((MODEL_KEYS.element as Record<string, readonly string[]>)[type] ?? []).includes(key)
}

/**
 * Applies a validated style patch to `els` IN PLACE: every key the element's
 * type has is set (a fresh copy of the value), and that key's palette ref is
 * dropped — the literal now wins, as a hand-picked colour does. Returns how
 * many elements changed; the caller wraps this in ONE store.commit.
 */
export function applyStylePatch(els: SlideElement[], patch: Record<string, unknown>): number {
  let changed = 0
  for (const el of els) {
    const rec = el as unknown as Record<string, unknown>
    let did = false
    for (const [key, value] of Object.entries(patch)) {
      if (!hasKey(el.type, key)) continue
      if (stableJson(rec[key]) === stableJson(value)) continue
      rec[key] = clone(value)
      const refs = rec.themeRefs as Record<string, string> | undefined
      if (refs) {
        for (const path of Object.keys(refs)) if (path === key || path.startsWith(key + '.')) delete refs[path]
        if (!Object.keys(refs).length) delete rec.themeRefs
      }
      did = true
    }
    if (did) changed++
  }
  return changed
}

/** A style patch captured from an element: its PATCH_KEYS values. */
export function styleFromElement(el: SlideElement, keys: readonly string[]): Record<string, unknown> {
  const rec = el as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of keys) if (rec[k] !== undefined && hasKey(el.type, k)) out[k] = clone(rec[k])
  return out
}

// ---- targets + summary ---------------------------------------------------------

/** A button/shortcut target: an action id has no dot, a command id has one. */
export function resolveTarget(profile: UiProfile, target: string):
  | { kind: 'action'; id: string; action: UiAction }
  | { kind: 'command'; id: string }
  | null {
  if (!target.includes('.')) {
    const action = profile.actions?.[target]
    return action ? { kind: 'action', id: target, action } : null
  }
  return { kind: 'command', id: target }
}

export interface ProfileSummary {
  tabs: number; groups: number; buttons: number; hidden: number; shortcuts: number
  styles: number; presets: number; actions: number; tokens: number; density: string | null; defaults: boolean
  /** items pinned to the right-click menu / the quick-format bar */
  pinned: number
  /** built-in menu items and toolbar buttons hidden (ribbon groups are `hidden`) */
  hiddenItems: number
}

const menuPins = (m: UiMenu | undefined): number => Object.values(m?.add ?? {}).reduce((n, l) => n + l.length, 0)

export function summarizeProfile(p: UiProfile | null): ProfileSummary {
  const tabs = p?.ribbon?.tabs ?? []
  const groups = tabs.flatMap((t) => t.groups)
  return {
    tabs: tabs.length,
    groups: groups.length,
    buttons: groups.reduce((n, g) => n + g.buttons.length, 0),
    hidden: p?.ribbon?.hide?.length ?? 0,
    shortcuts: Object.keys(p?.shortcuts ?? {}).length,
    styles: Object.keys(p?.styles ?? {}).length,
    presets: Object.keys(p?.presets ?? {}).length,
    actions: Object.keys(p?.actions ?? {}).length,
    tokens: Object.keys(p?.chrome?.light ?? {}).length + Object.keys(p?.chrome?.dark ?? {}).length,
    density: p?.chrome?.density ?? null,
    defaults: !!p?.defaults && Object.keys(p.defaults).length > 0,
    pinned: menuPins(p?.menus?.context) + menuPins(p?.menus?.minibar),
    hiddenItems: (p?.menus?.context?.hide?.length ?? 0) + (p?.menus?.minibar?.hide?.length ?? 0) + (p?.toolbar?.hide?.length ?? 0),
  }
}

/** Whether a profile changes anything at all. */
export function isEmptyProfile(p: UiProfile | null): boolean {
  if (!p) return true
  const s = summarizeProfile(p)
  return !s.tabs && !s.hidden && !s.shortcuts && !s.styles && !s.presets && !s.actions && !s.tokens && !s.density &&
    !s.defaults && !s.pinned && !s.hiddenItems && !p.toolbar?.order?.length && !p.toolbar?.quickbar && !p.panel?.order?.length &&
    p.chrome?.radius === undefined && !Object.keys(p.ribbon?.order ?? {}).length
}

/** Strips characters that would let a label pretend to be something else:
 *  control characters and bidi overrides. */
export function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim()
}

/**
 * Drops everything that points at something no longer there — an action
 * whose style/preset was deleted, a sequence step, a button or shortcut whose
 * action went — so deleting one thing in Settings never leaves the profile
 * invalid. Mutates `p`; returns it.
 */
export function pruneDangling(p: UiProfile): UiProfile {
  const styles = p.styles ?? {}, presets = p.presets ?? {}
  for (const [id, a] of Object.entries(p.actions ?? {})) {
    if (a.kind === 'style' && !styles[a.style]) delete p.actions![id]
    else if (a.kind === 'insert' && !presets[a.preset]) delete p.actions![id]
    else if (a.kind === 'sequence') {
      a.steps = a.steps.filter((s) => ('style' in s ? !!styles[s.style] : 'insert' in s ? !!presets[s.insert] : true))
      if (!a.steps.length) delete p.actions![id]
    }
  }
  const live = (target: string) => target.includes('.') || !!p.actions?.[target]
  for (const tab of p.ribbon?.tabs ?? []) for (const g of tab.groups) g.buttons = g.buttons.filter((b) => live(b.target))
  for (const [chord, target] of Object.entries(p.shortcuts ?? {})) if (target !== SHORTCUT_NONE && !live(target)) delete p.shortcuts![chord]
  for (const key of ['context', 'minibar'] as const) {
    const m = p.menus?.[key]
    if (!m) continue
    for (const [scope, list] of Object.entries(m.add ?? {})) {
      const kept = list.filter(live)
      if (kept.length) m.add![scope] = kept
      else delete m.add![scope]
    }
    if (m.add && !Object.keys(m.add).length) delete m.add
    if (!m.add && !m.hide?.length) delete p.menus![key]
  }
  if (p.menus && !p.menus.context && !p.menus.minibar) delete p.menus
  return p
}

// ---- parts: partial export, merge import --------------------------------------

/** Every target a profile's buttons, shortcuts and pins point at. */
function targetsOf(p: UiProfile, parts: readonly UiPart[]): string[] {
  const out: string[] = []
  if (parts.includes('buttons')) for (const tab of p.ribbon?.tabs ?? []) for (const g of tab.groups) for (const b of g.buttons) out.push(b.target)
  if (parts.includes('shortcuts')) out.push(...Object.values(p.shortcuts ?? {}).filter((t) => t !== SHORTCUT_NONE))
  if (parts.includes('menus')) for (const m of [p.menus?.context, p.menus?.minibar]) for (const l of Object.values(m?.add ?? {})) out.push(...l)
  return out
}

/** Which parts of `p` hold anything (what Export/Import offer to pick from). */
export function profileParts(p: UiProfile | null): UiPart[] {
  if (!p) return []
  const has: Record<UiPart, boolean> = {
    buttons: !!p.ribbon?.tabs?.length,
    menus: !!(p.menus?.context || p.menus?.minibar),
    toolbar: !!(p.ribbon?.hide?.length || Object.keys(p.ribbon?.order ?? {}).length || p.toolbar?.hide?.length || p.toolbar?.order?.length || p.toolbar?.quickbar),
    panel: !!p.panel?.order?.length,
    shortcuts: !!Object.keys(p.shortcuts ?? {}).length,
    styles: !!Object.keys(p.styles ?? {}).length,
    presets: !!Object.keys(p.presets ?? {}).length,
    look: !!p.chrome && Object.keys(p.chrome).length > 0,
    defaults: !!p.defaults && Object.keys(p.defaults).length > 0,
  }
  return PROFILE_PARTS.filter((k) => has[k])
}

/**
 * Only `parts` of `p` — plus whatever they need to work: the actions their
 * buttons, shortcuts and pins run, and the styles and presets those actions
 * use. `styles`/`presets` bring the actions that apply/insert them, so they
 * stay one click away (View ▸ My commands) after an import.
 */
export function pickParts(p: UiProfile, parts: readonly UiPart[]): UiProfile {
  const out: UiProfile = { format: UI_PROFILE_FORMAT, version: UI_PROFILE_VERSION, ...(p.name ? { name: p.name } : {}) }
  const actionIds = new Set(targetsOf(p, parts).filter((t) => !t.includes('.')))
  for (const [id, a] of Object.entries(p.actions ?? {})) {
    if ((parts.includes('styles') && a.kind === 'style') || (parts.includes('presets') && a.kind === 'insert')) actionIds.add(id)
  }
  const styleIds = new Set(parts.includes('styles') ? Object.keys(p.styles ?? {}) : [])
  const presetIds = new Set(parts.includes('presets') ? Object.keys(p.presets ?? {}) : [])
  const actions: Record<string, UiAction> = {}
  for (const id of actionIds) {
    const a = p.actions?.[id]
    if (!a) continue
    actions[id] = clone(a)
    if (a.kind === 'style') styleIds.add(a.style)
    if (a.kind === 'insert') presetIds.add(a.preset)
    if (a.kind === 'sequence') for (const s of a.steps) { if ('style' in s) styleIds.add(s.style); if ('insert' in s) presetIds.add(s.insert) }
  }
  if (Object.keys(actions).length) out.actions = actions
  const pick = <T>(src: Record<string, T> | undefined, ids: Set<string>) => {
    const o: Record<string, T> = {}
    for (const id of ids) if (src?.[id]) o[id] = clone(src[id])
    return Object.keys(o).length ? o : undefined
  }
  const styles = pick(p.styles, styleIds), presets = pick(p.presets, presetIds)
  if (styles) out.styles = styles
  if (presets) out.presets = presets
  const ribbon: NonNullable<UiProfile['ribbon']> = {}
  if (parts.includes('buttons') && p.ribbon?.tabs?.length) ribbon.tabs = clone(p.ribbon.tabs)
  if (parts.includes('toolbar')) {
    if (p.ribbon?.hide?.length) ribbon.hide = [...p.ribbon.hide]
    if (Object.keys(p.ribbon?.order ?? {}).length) ribbon.order = clone(p.ribbon!.order)
    if (p.toolbar) out.toolbar = clone(p.toolbar)
  }
  if (Object.keys(ribbon).length) out.ribbon = ribbon
  if (parts.includes('shortcuts') && p.shortcuts) out.shortcuts = { ...p.shortcuts }
  if (parts.includes('menus') && p.menus) out.menus = clone(p.menus)
  if (parts.includes('panel') && p.panel) out.panel = clone(p.panel)
  if (parts.includes('look') && p.chrome) out.chrome = clone(p.chrome)
  if (parts.includes('defaults') && p.defaults) out.defaults = clone(p.defaults)
  return out
}

/** What "Add to mine" left out or renamed — told to the person afterwards. */
export interface MergeNote { kind: 'renamed' | 'kept-mine'; what: string }

/**
 * "Add to mine": `incoming` merged into `base`, and nothing of `base` lost.
 * An action, style, preset, tab or group id both have — with different
 * content — is renamed on the incoming side (and every reference to it with
 * it); a shortcut chord both bind, or a colour both set, keeps MINE. Lists
 * (hidden items, pins) are unions. The result still has to pass strict
 * validation (the caps can refuse it).
 */
export function mergeProfiles(base: UiProfile | null, incomingRaw: UiProfile): { profile: UiProfile; notes: MergeNote[] } {
  const out: UiProfile = clone(base) ?? { format: UI_PROFILE_FORMAT, version: UI_PROFILE_VERSION }
  const inc = clone(incomingRaw)
  const notes: MergeNote[] = []
  // 1. ids: rename incoming entries that clash with different content
  const renameIn = <T>(mine: Record<string, T> | undefined, theirs: Record<string, T> | undefined, what: string): Map<string, string> => {
    const map = new Map<string, string>()
    for (const [id, v] of Object.entries(theirs ?? {})) {
      if (!mine?.[id] || stableJson(mine[id]) === stableJson(v)) continue
      // the same thing under another id (an earlier import renamed it): reuse that
      const same = Object.entries(mine).find(([, m]) => stableJson(m) === stableJson(v))?.[0]
      if (same) { map.set(id, same); continue }
      const fresh = freshId(id, { ...mine, ...theirs, ...Object.fromEntries([...map.values()].map((k) => [k, 1])) })
      map.set(id, fresh)
      notes.push({ kind: 'renamed', what: `${what} ${id} → ${fresh}` })
    }
    return map
  }
  const styleMap = renameIn(out.styles, inc.styles, 'style')
  const presetMap = renameIn(out.presets, inc.presets, 'preset')
  const ren = <T>(rec: Record<string, T> | undefined, map: Map<string, string>) =>
    rec ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [map.get(k) ?? k, v])) : rec
  inc.styles = ren(inc.styles, styleMap)
  inc.presets = ren(inc.presets, presetMap)
  for (const a of Object.values(inc.actions ?? {})) {
    if (a.kind === 'style') a.style = styleMap.get(a.style) ?? a.style
    if (a.kind === 'insert') a.preset = presetMap.get(a.preset) ?? a.preset
    if (a.kind === 'sequence') a.steps = a.steps.map((s) => ('style' in s ? { style: styleMap.get(s.style) ?? s.style } : 'insert' in s ? { insert: presetMap.get(s.insert) ?? s.insert } : s))
  }
  const actionMap = renameIn(out.actions, inc.actions, 'action')
  inc.actions = ren(inc.actions, actionMap)
  const retarget = (t: string) => actionMap.get(t) ?? t
  for (const tab of inc.ribbon?.tabs ?? []) for (const g of tab.groups) for (const b of g.buttons) b.target = retarget(b.target)
  if (inc.shortcuts) inc.shortcuts = Object.fromEntries(Object.entries(inc.shortcuts).map(([c, t]) => [c, retarget(t)]))
  for (const m of [inc.menus?.context, inc.menus?.minibar]) for (const [s, l] of Object.entries(m?.add ?? {})) m!.add![s] = l.map(retarget)
  // 2. records: union (renamed entries no longer clash)
  if (inc.styles) out.styles = { ...inc.styles, ...out.styles }
  if (inc.presets) out.presets = { ...inc.presets, ...out.presets }
  if (inc.actions) out.actions = { ...inc.actions, ...out.actions }
  // 3. ribbon: tabs by id (a shared tab gets the incoming groups it lacks)
  if (inc.ribbon) {
    out.ribbon ??= {}
    for (const tab of inc.ribbon.tabs ?? []) {
      out.ribbon.tabs ??= []
      const mine = out.ribbon.tabs.find((x) => x.id === tab.id)
      if (!mine) { out.ribbon.tabs.push(tab); continue }
      for (const g of tab.groups) {
        const same = mine.groups.find((x) => x.id === g.id)
        if (same && stableJson(same) === stableJson(g)) continue
        if (same) { const id = freshId(g.id, Object.fromEntries(mine.groups.map((x) => [x.id, 1]))); notes.push({ kind: 'renamed', what: `group ${g.id} → ${id}` }); g.id = id }
        mine.groups.push(g)
      }
    }
    if (inc.ribbon.hide?.length) out.ribbon.hide = [...new Set([...(out.ribbon.hide ?? []), ...inc.ribbon.hide])]
    for (const [tab, order] of Object.entries(inc.ribbon.order ?? {})) {
      out.ribbon.order ??= {}
      if (!out.ribbon.order[tab]) out.ribbon.order[tab] = order
    }
  }
  // 4. shortcuts: mine win
  for (const [chord, t] of Object.entries(inc.shortcuts ?? {})) {
    out.shortcuts ??= {}
    if (out.shortcuts[chord] === undefined) out.shortcuts[chord] = t
    else if (out.shortcuts[chord] !== t) notes.push({ kind: 'kept-mine', what: `shortcut ${chord}` })
  }
  // 5. menus + toolbar: unions
  for (const key of ['context', 'minibar'] as const) {
    const theirs = inc.menus?.[key]
    if (!theirs) continue
    out.menus ??= {}
    const mine = (out.menus[key] ??= {})
    for (const [scope, list] of Object.entries(theirs.add ?? {})) {
      mine.add ??= {}
      mine.add[scope] = [...new Set([...(mine.add[scope] ?? []), ...list])]
    }
    if (theirs.hide?.length) mine.hide = [...new Set([...(mine.hide ?? []), ...theirs.hide])]
  }
  if (inc.toolbar) {
    out.toolbar ??= {}
    if (inc.toolbar.hide?.length) out.toolbar.hide = [...new Set([...(out.toolbar.hide ?? []), ...inc.toolbar.hide])]
    if (inc.toolbar.order?.length && !out.toolbar.order?.length) out.toolbar.order = inc.toolbar.order
    if (inc.toolbar.quickbar && !out.toolbar.quickbar) out.toolbar.quickbar = inc.toolbar.quickbar
  }
  // the side panel's order: theirs only where I have none
  if (inc.panel?.order?.length && !out.panel?.order?.length) out.panel = { order: [...inc.panel.order] }
  // 6. look and defaults: fill in what I haven't set
  if (inc.chrome) {
    out.chrome ??= {}
    if (inc.chrome.density && !out.chrome.density) out.chrome.density = inc.chrome.density
    if (inc.chrome.radius !== undefined && out.chrome.radius === undefined) out.chrome.radius = inc.chrome.radius
    for (const theme of ['light', 'dark'] as const) {
      for (const [tok, v] of Object.entries(inc.chrome[theme] ?? {})) {
        const mine = (out.chrome[theme] ??= {})
        if (mine[tok] === undefined) mine[tok] = v
        else if (mine[tok] !== v) notes.push({ kind: 'kept-mine', what: `${theme} ${tok}` })
      }
    }
  }
  if (inc.defaults) out.defaults = mergePatch(inc.defaults, out.defaults ?? {}) as UiProfile['defaults']
  return { profile: out, notes }
}

/** A fresh id for `base` that `taken` doesn't have yet ("my-heading-2"). */
export function freshId(base: string, taken: Record<string, unknown> | undefined): string {
  const slug = (base.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item').slice(0, 30)
  const id = /^[a-z]/.test(slug) ? slug : `x-${slug}`.slice(0, 30)
  if (!taken?.[id]) return id
  for (let n = 2; ; n++) if (!taken[`${id}-${n}`]) return `${id}-${n}`
}

// ---- side-panel order ----------------------------------------------------------

/** The section ids of one panel scope in the order they show under `order`:
 *  listed ones first (in that order), the rest in catalog order after. */
export function panelScopeOrder(order: readonly string[], scope: PanelSection['scope']): string[] {
  const ids = PANEL_SECTIONS.filter((p) => p.scope === scope).map((p) => p.id)
  const rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length + ids.indexOf(id) : i }
  return [...ids].sort((a, b) => rank(a) - rank(b))
}

/** `order` after moving `id` to position `to` within its scope. Every scope
 *  comes out fully listed, so the result no longer depends on catalog order. */
export function movePanelSection(order: readonly string[], id: string, to: number): string[] {
  const scope = PANEL_SECTIONS.find((p) => p.id === id)?.scope
  const scopes: PanelSection['scope'][] = ['object', 'selection', 'slide']
  return scopes.flatMap((sc) => {
    const list = panelScopeOrder(order, sc)
    if (sc !== scope) return list
    const from = list.indexOf(id)
    list.splice(from, 1)
    list.splice(Math.max(0, Math.min(to, list.length)), 0, id)
    return list
  })
}
