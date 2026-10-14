#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// UI profile rig (slides/src/editor/customize/) — runs without a DOM.
//
//   node scripts/test-ui-profile.ts
//
// WHAT THIS PROVES
//  1. A profile round-trips through strict validation unchanged, and the
//     RFC 7386 merge patch behaves as the RFC's own examples say.
//  2. Every hostile input is REFUSED in strict mode and DROPPED (the rest
//     kept) in lenient mode: unknown commands/icons/tokens/keys, CSS and URL
//     smuggling in colours and style values, non-hex tokens, reserved chords,
//     prototype keys, picture/embed presets, oversized profiles, a newer
//     version, a profile that would hide every Home group.
//  3. The catalogs are consistent with the source they mirror: the command
//     catalog is the menu catalog (so another branch's new commands appear by
//     themselves), every ribbon caption is a real `ribbonGroup(t('…'))` in
//     editor.ts, the token defaults are styles.css's, and every Mod chord
//     editor.ts's wireKeyboard handles is reserved.
//  4. The pure apply helpers: style patch, token stylesheet, chords, contrast.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS, menuCommandIds } from '../slides/src/editor/menumodel.ts'
import {
  CONTEXT_ITEMS, ICON_NAMES, LOCKED_CHORDS, MINIBAR_ITEMS, OVERRIDABLE_CHORDS, PATCH_KEYS, RESERVED_CHORDS, RIBBON_LAYOUT, TOKENS,
  TOOLBAR_ITEMS, commandCatalog, isCatalogCommand, ribbonGroupIds,
} from '../slides/src/editor/customize/catalog.ts'
import {
  applyStylePatch, chordFromEvent, contrastRatio, displayChord, isEmptyProfile, mergePatch, mergeProfiles, normalizeChord,
  pickParts, profileParts, pruneDangling, resolveTarget, stableJson, styleFromElement, summarizeProfile, tokenCss, toolbarCss,
} from '../slides/src/editor/customize/logic.ts'
import { UI_LIMITS, validatePatch, validateProfile } from '../slides/src/editor/customize/validate.ts'
import { assignKey, buildKeymap, checkAssign, filterRows, keyOwner, keyText, removeKey, resetRow, rowsWithKey } from '../slides/src/editor/customize/keymap.ts'
import { PROFILE_PARTS as PROFILE_PARTS_ALL, emptyProfile, type UiProfile } from '../slides/src/editor/customize/schema.ts'
import { defaultShape, defaultText, type SlideElement } from '../slides/src/model.ts'
import {
  UI_HISTORY_MAX, commitUiProfile, currentProfile, listUiHistory, readUiStore, resetProfile, revertProfile, writeProfile,
  type UiChange, type UiProfileService,
} from '../desktop/src/main/uiprofilefs.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0, failures = 0
function ok(cond: boolean, msg: string) { checks++; if (!cond) failures++; console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`) }

// ---- 1. round trip + merge patch ------------------------------------------------
const full: UiProfile = {
  format: 'slidomingo/ui-profile', version: 1, name: 'Brand kit', enabled: true,
  styles: {
    heading: { label: 'My heading', patch: { fontSize: 44, fontWeight: 700, color: '#0f766e', fontFamily: 'Georgia, serif' } },
    callout: { label: 'Callout', patch: { fill: '#ccfbf1', stroke: '#0f766e', strokeWidth: 2, radius: 14, shadow: { y: 4, blur: 12, color: 'rgba(0,0,0,0.2)' } } },
  },
  presets: {
    'callout-box': { label: 'Callout box', elements: [defaultShape('rect', { id: 'p1', x: 100, y: 100, w: 400, h: 160, fill: '#ccfbf1' }) as SlideElement] },
  },
  actions: {
    'apply-heading': { kind: 'style', style: 'heading', label: 'Heading look', icon: 'text' },
    'apply-callout': { kind: 'style', style: 'callout', label: 'Callout' },
    'insert-callout': { kind: 'insert', preset: 'callout-box', label: 'Callout box', icon: 'shapes' },
    'center-both': { kind: 'sequence', steps: [{ command: 'arrange.centerX' }, { command: 'arrange.middleY' }], label: 'Center' },
    present: { kind: 'command', command: 'play.slideshow' },
  },
  ribbon: {
    tabs: [{ id: 'brand', label: 'Brand', groups: [{ id: 'looks', label: 'Looks', buttons: [{ target: 'apply-heading' }, { target: 'apply-callout' }, { target: 'insert.chart', label: 'Chart' }] }] }],
    hide: ['home:reapply-change'],
    order: { insert: ['insert:tables-charts', 'insert:basic'] },
  },
  shortcuts: { 'Mod+Shift+B': 'apply-heading', 'Mod+Alt+K': 'insert-callout' },
  chrome: { density: 'compact', light: { accent: '#0f766e', 'accent-ink': '#ffffff', 'accent-text': '#0f766e' }, radius: 6 },
  defaults: { text: { fontFamily: 'Georgia, serif', fontSize: 28 }, shape: { fill: '#ccfbf1' } },
}
{
  const v = validateProfile(full, 'strict')
  ok(!!v.profile && v.errors.length === 0, `a full profile validates strictly (${v.errors.map((e) => e.path + ':' + e.code).join(', ') || 'no errors'})`)
  ok(!!v.profile && stableJson(v.profile) === stableJson(full), 'and round-trips unchanged')
  ok(v.warnings.length === 0, `no warnings on a sound profile (${v.warnings.map((w) => w.message).join('; ')})`)
  const again = validateProfile(JSON.parse(JSON.stringify(v.profile)), 'strict')
  ok(stableJson(again.profile) === stableJson(v.profile), 'validation is idempotent')
}
// RFC 7386 appendix A
const rfc: Array<[unknown, unknown, unknown]> = [
  [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
  [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
  [{ a: 'b' }, { a: null }, {}],
  [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
  [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
  [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
  [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
  [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
  [['a', 'b'], ['c', 'd'], ['c', 'd']],
  [{ a: 'b' }, ['c'], ['c']],
  [{ a: 'foo' }, null, null],
  [{ a: 'foo' }, 'bar', 'bar'],
  [{ e: null }, { a: 1 }, { e: null, a: 1 }],
  [[1, 2], { a: 'b', c: null }, { a: 'b' }],
  [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
]
ok(rfc.every(([t, p, r]) => stableJson(mergePatch(t, p)) === stableJson(r)), 'merge patch matches every RFC 7386 appendix example')
{
  const before = JSON.stringify(full)
  mergePatch(full, { styles: { heading: null } })
  ok(JSON.stringify(full) === before, 'merge patch never mutates its input')
  const p = validatePatch(full, { ribbon: { tabs: [] }, shortcuts: { 'Mod+Shift+B': null } })
  ok(!!p.profile && !p.profile.ribbon?.tabs && !p.profile.shortcuts?.['Mod+Shift+B'] && !!p.profile.shortcuts?.['Mod+Alt+K'], 'validatePatch: null removes, the rest stays')
  const q = validatePatch(null, { chrome: { density: 'compact' } })
  ok(q.profile?.format === 'slidomingo/ui-profile' && q.profile.chrome?.density === 'compact', 'a patch onto nothing starts a fresh profile')
  const bad = validatePatch(full, { actions: { 'apply-heading': { kind: 'style', style: 'nope' } } })
  ok(bad.profile === null && bad.errors.some((e) => e.code === 'unknown-style'), 'a patch that breaks a reference is refused with the reason')
  ok(validatePatch(full, [1]).profile === null, 'a non-object patch is refused')
}

// ---- 2. hostile inputs --------------------------------------------------------
const base = (): UiProfile => JSON.parse(JSON.stringify(full))
const hostile: Array<[string, (p: any) => void, (lenient: UiProfile) => boolean]> = [
  ['unknown command as button target', (p) => { p.ribbon.tabs[0].groups[0].buttons.push({ target: 'evil.run' }) }, (l) => l.ribbon!.tabs![0].groups[0].buttons.length === 3],
  ['unknown command in an action', (p) => { p.actions.x = { kind: 'command', command: 'app.quitEverything' } }, (l) => !l.actions!.x],
  ['javascript: as an action kind', (p) => { p.actions.x = { kind: 'javascript:alert(1)' } }, (l) => !l.actions!.x],
  ['a code field on an action', (p) => { p.actions.present.run = 'fetch("https://x")' }, (l) => !('run' in l.actions!.present)],
  ['unknown icon', (p) => { p.actions.present.icon = '<svg onload=alert(1)>' }, (l) => !l.actions!.present.icon],
  ['style key that is content, not a look', (p) => { p.styles.heading.patch.html = '<img src=x onerror=alert(1)>' }, (l) => !('html' in l.styles!.heading.patch)],
  ['style key that is geometry/link', (p) => { p.styles.heading.patch.link = 'https://evil.example' }, (l) => !('link' in l.styles!.heading.patch)],
  ['CSS breakout in a style colour', (p) => { p.styles.callout.patch.fill = 'red;background:url(https://evil/x.png)' }, (l) => !('fill' in l.styles!.callout.patch)],
  ['url() in a style colour', (p) => { p.styles.heading.patch.color = 'url(https://evil/track.svg#a)' }, (l) => !('color' in l.styles!.heading.patch)],
  ['a smuggled shadow colour', (p) => { p.styles.callout.patch.shadow = { y: 1, blur: 2, color: 'red) url(https://evil/f.svg#f' } }, (l) => !('shadow' in l.styles!.callout.patch)],
  ['a font stack that ends the declaration', (p) => { p.styles.heading.patch.fontFamily = 'x; } body { display:none' }, (l) => !('fontFamily' in l.styles!.heading.patch)],
  ['a non-hex token value', (p) => { p.chrome.light.accent = 'red' }, (l) => !l.chrome!.light!.accent],
  ['CSS in a token value', (p) => { p.chrome.light.accent = '#fff; } * { display:none' }, (l) => !l.chrome!.light!.accent],
  ['an unknown token', (p) => { p.chrome.dark = { 'font-family': '#000000' } }, (l) => !l.chrome!.dark],
  ['a token name that breaks out', (p) => { p.chrome.light['accent;}body{x'] = '#000000' }, (l) => !Object.keys(l.chrome!.light!).some((k) => k.includes(';'))],
  ['raw css field', (p) => { p.chrome.css = 'body{display:none}' }, (l) => !('css' in l.chrome!)],
  ['a reserved chord (⌘S)', (p) => { p.shortcuts['Mod+S'] = 'present' }, (l) => !l.shortcuts!['Mod+S']],
  ['⌘, cannot be rebound', (p) => { p.shortcuts['Mod+,'] = 'present' }, (l) => !Object.keys(l.shortcuts!).some((k) => k.includes(','))],
  ['a plain letter chord', (p) => { p.shortcuts.B = 'present' }, (l) => !l.shortcuts!.B],
  ['a shortcut to a missing action', (p) => { p.shortcuts['Mod+Shift+J'] = 'nope' }, (l) => !l.shortcuts!['Mod+Shift+J']],
  ['__proto__ as an action id', (p) => { Object.defineProperty(p.actions, '__proto__', { value: { kind: 'command', command: 'file.save' }, enumerable: true }) }, (l) => !Object.prototype.hasOwnProperty.call(l.actions, '__proto__')],
  ['an image preset (bytes do not belong in a preference)', (p) => { p.presets.pic = { label: 'Pic', elements: [{ type: 'image', id: 'i', src: 'https://evil/x.png', x: 0, y: 0, w: 1, h: 1 }] } }, (l) => !l.presets!.pic],
  ['an embed preset', (p) => { p.presets.e = { label: 'E', elements: [{ type: 'embed', id: 'e', html: '<iframe src=//evil>', x: 0, y: 0, w: 1, h: 1 }] } }, (l) => !l.presets!.e],
  ['a preset element with an unknown key', (p) => { p.presets['callout-box'].elements[0].onclick = 'alert(1)' }, (l) => !('onclick' in (l.presets!['callout-box'].elements[0] as object))],
  ['a sequence longer than the cap', (p) => { p.actions.long = { kind: 'sequence', steps: Array.from({ length: UI_LIMITS.sequence + 1 }, () => ({ command: 'arrange.left' })) } }, (l) => l.actions!.long.kind === 'sequence' && (l.actions!.long as any).steps.length === UI_LIMITS.sequence],
  ['a nested sequence step', (p) => { p.actions.nest = { kind: 'sequence', steps: [{ sequence: 'center-both' }] } }, (l) => !l.actions!.nest],
  ['a custom tab named like a built-in one', (p) => { p.ribbon.tabs.push({ id: 'home', label: 'Home 2', groups: [] }) }, (l) => l.ribbon!.tabs!.length === 1],
  ['hiding an unknown group', (p) => { p.ribbon.hide.push('home:everything') }, (l) => !l.ribbon!.hide!.includes('home:everything')],
  ['hiding every Home group (lock-out)', (p) => { p.ribbon.hide = RIBBON_LAYOUT.home.map((g) => g.id) }, (l) => l.ribbon!.hide!.length === RIBBON_LAYOUT.home.length - 1],
  ['ordering an unknown tab', (p) => { p.ribbon.order.secret = ['home:slides'] }, (l) => !l.ribbon!.order!.secret],
  ['defaults with a url() fill', (p) => { p.defaults.shape.fill = 'url(https://evil/x.svg#a)' }, (l) => !l.defaults?.shape?.fill],
  ['a label with control and bidi characters', (p) => { p.ribbon.tabs[0].label = '‮Brand\u0007' }, (l) => l.ribbon!.tabs![0].label === 'Brand'],
  ['an unknown top-level field', (p) => { p.script = 'alert(1)' }, (l) => !('script' in l)],
  ['an over-long label', (p) => { p.actions.present.label = 'x'.repeat(UI_LIMITS.label + 1) }, (l) => (l.actions!.present.label?.length ?? 0) <= UI_LIMITS.label],
  ['too many custom tabs', (p) => { for (let i = 0; i < UI_LIMITS.tabs; i++) p.ribbon.tabs.push({ id: `t${i}`, label: `T${i}`, groups: [] }) }, (l) => l.ribbon!.tabs!.length === UI_LIMITS.tabs],
]
for (const [what, mutate, dropped] of hostile) {
  const p = base()
  mutate(p)
  const strict = validateProfile(p, 'strict')
  const lenient = validateProfile(p, 'lenient')
  ok(strict.profile === null && strict.errors.length > 0, `strict refuses: ${what} (${strict.errors[0]?.code})`)
  ok(!!lenient.profile && dropped(lenient.profile) && !!lenient.profile.styles?.heading, `lenient drops only it: ${what}`)
}
{
  const html = validateProfile(base(), 'strict').profile!
  html.ribbon!.tabs![0].label = '<img src=x onerror=alert(1)>'
  const v = validateProfile(html, 'strict')
  ok(v.profile?.ribbon?.tabs?.[0].label === '<img src=x onerror=alert(1)>', 'a label is literal text — kept as typed (it is rendered with textContent, never as markup)')
}
for (const [what, input] of [
  ['not an object', 'x'],
  ['wrong format', { ...full, format: 'other' }],
  ['a newer version', { ...full, version: 2 }],
  ['an oversized profile', { ...full, name: 'x', styles: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`s${i}`, { label: 'S', patch: { fontFamily: 'a'.repeat(9000) } }])) }],
] as Array<[string, unknown]>) {
  ok(validateProfile(input, 'strict').profile === null && validateProfile(input, 'lenient').profile === null, `refused in both modes: ${what}`)
}
{
  const low = base()
  low.chrome!.light = { accent: '#ffff00', 'accent-ink': '#ffffff' }
  const v = validateProfile(low, 'strict')
  ok(!!v.profile && v.warnings.some((w) => w.code === 'low-contrast'), 'unreadable token pairs are a warning, not a refusal')
  const unused = base()
  delete unused.actions!['apply-callout']
  ok(validateProfile(unused, 'strict').warnings.some((w) => w.code === 'unused' && w.path === 'styles.callout'), 'a style nothing applies is a warning')
}

// ---- 3. catalog consistency ---------------------------------------------------
const cat = commandCatalog()
const ids = new Set(cat.map((c) => c.id))
ok(menuCommandIds().every((id) => ids.has(id)), `the command catalog covers every menu command (${menuCommandIds().length})`)
ok(Object.keys(COMMANDS).every((id) => ids.has(id)), 'and every COMMANDS entry')
ok(ids.has('slide.transition.morph') && isCatalogCommand('slide.transition.fade'), 'generated transition ids are commands too')
ok(cat.every((c) => c.label && c.menu), 'each catalog command has a label and a menu path')
ok(!isCatalogCommand('evil.run') && !isCatalogCommand('custom.x'), 'nothing else is')
ok(ids.has('view.customize'), 'View ▸ Customize… is in the catalog')
const editorSrc = readFileSync(join(root, 'slides/src/editor/editor.ts'), 'utf8')
for (const [tab, groups] of Object.entries(RIBBON_LAYOUT)) {
  for (const g of groups) ok(editorSrc.includes(`ribbonGroup(t('${g.caption}')`), `ribbon ${tab}: "${g.caption}" is a real ribbon group in editor.ts`)
}
{
  // and the other way round: a ribbon group added later must get an id here,
  // or a profile can never hide or reorder it
  const known = new Set(Object.values(RIBBON_LAYOUT).flat().map((g) => g.caption))
  const untagged = [...editorSrc.matchAll(/ribbonGroup\(t\('([^']+)'\)/g)].map((m) => m[1]).filter((c) => !known.has(c))
  ok(untagged.length === 0, `every ribbonGroup in editor.ts has a RIBBON_LAYOUT id${untagged.length ? ' — missing: ' + untagged.join(', ') : ''}`)
}
ok(new Set(ribbonGroupIds()).size === ribbonGroupIds().length, 'ribbon group ids are unique')
const css = readFileSync(join(root, 'slides/src/styles.css'), 'utf8')
const block = (sel: string) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)))
const lightCss = block(':root, :root[data-theme="light"] {'), darkCss = block(':root[data-theme="dark"] {\n')
for (const [name, t] of Object.entries(TOKENS)) {
  const read = (b: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})`).exec(b)?.[1]?.toLowerCase()
  ok(read(lightCss) === t.light.toLowerCase() && read(darkCss) === t.dark.toLowerCase(), `token --${name} defaults match styles.css`)
}
ok(ICON_NAMES.includes('text') && ICON_NAMES.includes('sparkle') && ICON_NAMES.length > 40, `icons come from icons.ts (${ICON_NAMES.length})`)
ok(PATCH_KEYS.every((k) => !['html', 'id', 'x', 'y', 'w', 'h', 'link', 'src', 'markup', 'css', 'fx', 'content', 'option'].includes(k)), 'no content, geometry, link or behaviour key is patchable')
// every Mod chord wireKeyboard handles is reserved
{
  const start = editorSrc.indexOf('private wireKeyboard()')
  const body = editorSrc.slice(start, editorSrc.indexOf('\n  }\n', editorSrc.indexOf("document.addEventListener('keydown'", start)))
  const found: string[] = []
  for (const line of body.split('\n')) {
    if (!/\bmod\b/.test(line) || /!mod\b/.test(line)) continue
    for (const m of line.matchAll(/ev\.key(?:\.toLowerCase\(\))? === '([a-z0-9])'/g)) {
      const k = m[1].toUpperCase()
      const variants = [`Mod+${k}`]
      if (!line.includes('!ev.shiftKey')) variants.push(`Mod+Shift+${k}`)
      if (!line.includes('!ev.altKey')) variants.push(`Mod+Alt+${k}`)
      found.push(...variants)
    }
    for (const m of line.matchAll(/\[((?:'[a-z]',?\s*)+)\]\.includes\(ev\.key\.toLowerCase\(\)\)/g)) {
      for (const k of m[1].match(/[a-z]/g)!) found.push(`Mod+${k.toUpperCase()}`, `Mod+Shift+${k.toUpperCase()}`, `Mod+Alt+${k.toUpperCase()}`)
    }
  }
  const missing = [...new Set(found)].filter((c) => !RESERVED_CHORDS.includes(c))
  ok(found.length > 15 && missing.length === 0, `every Mod chord in wireKeyboard is reserved (${found.length} found; missing: ${missing.join(', ') || 'none'})`)
  ok(RESERVED_CHORDS.every((c) => normalizeChord(c) === c), 'reserved chords are in normalized form')
}

// ---- 4. pure apply helpers ----------------------------------------------------
ok(normalizeChord('cmd+shift+b') === 'Mod+Shift+B' && normalizeChord('CmdOrCtrl+Alt+7') === 'Mod+Alt+7' && normalizeChord('Shift+Option+Mod+k') === 'Mod+Alt+Shift+K', 'chords normalize (aliases, order, case)')
ok(normalizeChord('F6') === 'F6' && normalizeChord('Shift+B') === null && normalizeChord('Mod+Enter') === null && normalizeChord('Mod+Mod+B') === null, 'and refuse what can never be a shortcut')
const ev = (code: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m })
ok(chordFromEvent(ev('KeyB', { metaKey: true, shiftKey: true }), true) === 'Mod+Shift+B', 'a Mac ⌘⇧B keydown is Mod+Shift+B')
ok(chordFromEvent(ev('KeyB', { ctrlKey: true, shiftKey: true }), false) === 'Mod+Shift+B', 'Ctrl+Shift+B elsewhere')
ok(chordFromEvent(ev('KeyK', { metaKey: true, altKey: true }), true) === 'Mod+Alt+K', '⌥ reads the physical key (code), not the typed symbol')
ok(chordFromEvent(ev('KeyB', { ctrlKey: true }), true) === null && chordFromEvent(ev('KeyB'), true) === null, 'a Mac Ctrl and a bare letter are not chords')
ok(displayChord('Mod+Alt+Shift+K', true) === '⌘⌥⇧K' && displayChord('Mod+Shift+B', false) === 'Ctrl+Shift+B', 'chords display per platform')
ok(Math.round(contrastRatio('#000', '#ffffff')!) === 21 && contrastRatio('#777777', '#777777') === 1 && contrastRatio('red', '#fff') === null, 'contrast ratio')
{
  const cssOut = tokenCss({ light: { accent: '#0f766e' }, dark: { accent: '#5eead4', bogus: '#000000' } as any, radius: 4 })
  ok(cssOut.includes('--accent: #0f766e;') && cssOut.includes('html:root[data-theme="dark"] { --accent: #5eead4; }') && !cssOut.includes('bogus') && cssOut.includes('--radius: 4px'), 'token stylesheet holds only catalog tokens and hex values')
  ok(tokenCss({ light: { accent: 'red;}*{x' } as any }) === '' && tokenCss(undefined) === '', 'and nothing from a value that slipped past validation')
}
{
  const text = defaultText({ id: 't', html: 'Hi', themeRefs: { color: 'accent' } }) as SlideElement
  const shape = defaultShape('rect', { id: 's' }) as SlideElement
  const n = applyStylePatch([text, shape], { color: '#0f766e', fontSize: 44, fill: '#ccfbf1' })
  ok(n === 2, 'a style patch touches every element with a matching key')
  ok((text as any).color === '#0f766e' && (text as any).fontSize === 44 && !('fill' in text), 'a text gets the text keys only')
  ok((shape as any).fill === '#ccfbf1' && !('fontSize' in shape), 'a shape gets the shape keys only')
  ok(!(text as any).themeRefs, 'a patched colour drops its palette ref (the literal wins, as a picked colour does)')
  ok(applyStylePatch([text], { color: '#0f766e' }) === 0, 'an unchanged element is not counted')
  const cap = styleFromElement(shape, PATCH_KEYS)
  ok(cap.fill === '#ccfbf1' && !('x' in cap) && !('id' in cap), 'a style captured from an element holds looks only')
}
{
  const p = validateProfile(full, 'strict').profile!
  ok(resolveTarget(p, 'apply-heading')?.kind === 'action' && resolveTarget(p, 'insert.chart')?.kind === 'command' && resolveTarget(p, 'nope') === null, 'targets resolve: no dot = action, dot = command')
  const s = summarizeProfile(p)
  ok(s.tabs === 1 && s.buttons === 3 && s.shortcuts === 2 && s.styles === 2 && s.presets === 1 && s.hidden === 1 && s.density === 'compact', 'profile summary')
  ok(isEmptyProfile(emptyProfile()) && isEmptyProfile(null) && !isEmptyProfile(p), 'empty profile detection')
}

// ---- can't lock yourself out; containment ------------------------------------
{
  ok(normalizeChord('Mod+,') === null && !Object.keys(validateProfile({ ...full, shortcuts: { 'Mod+,': 'present' } }, 'lenient').profile!.shortcuts ?? {}).length,
    '⌘, (Settings) can never be bound to anything else')
  const viewMenu = commandCatalog().filter((c) => c.id === 'view.customize')
  ok(viewMenu.length === 1 && !('hide' in (validateProfile({ ...full, ribbon: { hide: ['view.customize'] } }, 'lenient').profile!.ribbon ?? {})),
    'View ▸ Customize… is a menu command; a profile can only hide ribbon GROUPS, never menu items')
  ok(!RIBBON_LAYOUT.home.every((g) => (validateProfile({ ...full, ribbon: { hide: RIBBON_LAYOUT.home.map((x) => x.id) } }, 'lenient').profile!.ribbon?.hide ?? []).includes(g.id)),
    'the Home tab always keeps a group')
  for (const entry of ['viewer.ts', 'player.ts']) {
    const src = readFileSync(join(root, 'slides/src', entry), 'utf8')
    ok(!/from ['"][^'"]*customize/.test(src) && !/from ['"]\.\/editor\//.test(src), `${entry} never imports the editor or customize/ (check-viewer.mjs proves it on the build)`)
  }
}

// ---- 5. the desktop store (desktop/src/main/uiprofilefs.ts, Electron-free) ------
{
  const dir = mkdtempSync(join(tmpdir(), 'slidomingo-ui-'))
  const changes: UiChange[] = []
  const svc: UiProfileService = { path: join(dir, 'ui-customization.json'), disabled: false, broadcast: (c) => changes.push(c) }
  ok(currentProfile(svc).profile === null && currentProfile(svc).rev === 0, 'desktop store: a missing file is an empty store')
  const w1 = writeProfile(svc, full, 'settings', 'Brand kit')
  ok(w1.ok && w1.rev === 1 && changes.length === 1 && changes[0].prevRev === 0 && changes[0].source === 'settings', 'a write is revision 1 and is broadcast with the previous rev')
  ok(stableJson(currentProfile(svc).profile) === stableJson(full), 'and reads back unchanged')
  const bad = writeProfile(svc, { ...full, shortcuts: { 'Mod+S': 'present' } }, 'agent', 'x')
  ok(!bad.ok && !!bad.errors?.length && currentProfile(svc).rev === 1 && changes.length === 1, 'an invalid write is refused, nothing stored, nothing broadcast')
  writeProfile(svc, { ...full, name: 'Second' }, 'chat', 'Renamed')
  const back = revertProfile(svc, 1, 'chat', 'Undo')
  ok(back.ok && currentProfile(svc).profile?.name === 'Brand kit' && currentProfile(svc).rev === 3, 'revert restores the profile as it was after that revision, as a new revision')
  ok(revertProfile(svc, 0).ok && currentProfile(svc).profile === null, 'revert to 0 = no customization')
  ok(resetProfile(svc).ok && currentProfile(svc).profile === null, 'reset clears')
  for (let i = 0; i < UI_HISTORY_MAX + 5; i++) commitUiProfile(svc.path, null, 'settings', `n${i}`)
  const hist = listUiHistory(svc.path)
  ok(hist.length === UI_HISTORY_MAX && hist[0].summary === `n${UI_HISTORY_MAX + 4}`, `history keeps the last ${UI_HISTORY_MAX}, newest first`)
  ok(revertProfile(svc, 1).error === 'too-old', 'a revision that aged out cannot be reverted to')
  writeFileSync(svc.path, '{ not json')
  ok(readUiStore(svc.path).rev === 0 && currentProfile(svc).profile === null, 'a corrupt file reads as empty')
  const hostileFile = { format: 'slidomingo/ui-customization', version: 1, rev: 9, current: { ...full, chrome: { light: { accent: 'red;}*{display:none' } } }, history: [] }
  writeFileSync(svc.path, JSON.stringify(hostileFile))
  const loaded = currentProfile(svc).profile
  ok(!!loaded && !loaded.chrome?.light && !!loaded.styles?.heading, 'a hand-edited file is read leniently: the bad token is dropped, the rest applies')
  const off: UiProfileService = { ...svc, disabled: true }
  ok(!writeProfile(off, full, 'settings', 'x').ok && currentProfile(off).profile === null, 'SLIDOMINGO_NO_UI_PROFILE: nothing is read or written')
  ok(stableJson(changes.at(-1)) !== '' && changes.every((c) => typeof c.rev === 'number'), 'every change carries its revision')
}

// ---- 6. menus, toolbar, built-in keys, parts (customize v2) ----------------------
{
  const base = { format: 'slidomingo/ui-profile', version: 1 }
  const strict = (p: unknown) => validateProfile(p, 'strict')
  const styles = { callout: { label: 'Callout', patch: { fill: '#0f766e' } } }
  const actions = { callout: { kind: 'style', style: 'callout' } }
  const menus = {
    context: { add: { '*': ['callout', 'arrange.group'], canvas: ['insert.text'] }, hide: ['lock', 'flip'] },
    minibar: { add: { shape: ['callout'] }, hide: ['more'] },
  }
  const toolbar = { hide: ['embed', 'code'], order: ['chart', 'table'] }
  const v = strict({ ...base, styles, actions, menus, toolbar })
  ok(!!v.profile && stableJson(v.profile.menus) === stableJson(menus) && stableJson(v.profile.toolbar) === stableJson(toolbar), 'menus and toolbar round-trip through strict validation')
  ok(!strict({ ...base, menus: { context: { add: { nowhere: ['insert.text'] } } } }).profile, 'an unknown menu scope is refused')
  ok(!strict({ ...base, menus: { context: { hide: ['self-destruct'] } } }).profile, 'an unknown built-in menu item is refused')
  ok(!strict({ ...base, menus: { minibar: { add: { '*': ['nope'] } } } }).profile, 'a pin to a missing action is refused')
  ok(!strict({ ...base, toolbar: { hide: ['settings'] } }).profile && !strict({ ...base, toolbar: { hide: ['save'] } }).profile, 'Save and Settings can\'t be hidden (not toolbar items)')
  const retired = strict({ ...base, toolbar: { hide: ['language', 'embed'], order: ['language'] } })
  ok(!!retired.profile && stableJson(retired.profile.toolbar) === stableJson({ hide: ['embed'] }), 'a retired toolbar id (the globe, now Settings ▸ Language) is accepted and dropped')
  ok(!strict({ ...base, menus: { context: { add: { '*': Array.from({ length: 9 }, () => 'insert.text') } } } }).profile, 'pins are capped per scope')
  const lenient = validateProfile({ ...base, styles, actions, menus: { context: { add: { '*': ['callout', 'ghost'] }, hide: ['lock', 'nope'] } } }, 'lenient').profile!
  ok(stableJson(lenient.menus?.context) === stableJson({ add: { '*': ['callout'] }, hide: ['lock'] }), 'lenient load drops only the bad pin and hide entries')
  // keys
  ok(LOCKED_CHORDS.every((c) => !strict({ ...base, shortcuts: { [c]: 'insert.text' } }).profile), 'every locked chord is refused')
  const over = strict({ ...base, shortcuts: { 'Mod+D': 'insert.text', 'Mod+G': 'none', 'Mod+Shift+J': 'insert.chart' } })
  ok(!!over.profile && over.warnings.some((w) => w.code === 'replaces-builtin' && w.path === 'shortcuts.Mod+D'), 'an overridable built-in can be rebound (with a warning saying what it was)')
  ok(over.profile?.shortcuts?.['Mod+G'] === 'none', '"none" switches a built-in key off')
  ok(!strict({ ...base, shortcuts: { 'Mod+Shift+J': 'none' } }).profile, '"none" on a key the editor doesn\'t use is refused')
  ok(!strict({ ...base, actions: { none: { kind: 'command', command: 'insert.text' } } }).profile, 'an action can\'t be called "none"')
  ok(Object.keys(OVERRIDABLE_CHORDS).every((c) => RESERVED_CHORDS.includes(c) && !LOCKED_CHORDS.includes(c) && normalizeChord(c) === c), 'overridable chords are reserved, not locked, normalized')
  // ids in the source: every catalog item is tagged where it is built
  const src = (f: string) => readFileSync(join(root, f), 'utf8')
  const ctx = src('slides/src/editor/contextmenu.ts'), mini = src('slides/src/editor/minitoolbar.ts')
  const tools = src('slides/src/editor/editor.ts') + src('slides/src/editor/insertgroup.ts')
  const insertIds = ['text', 'shape', 'image', 'media', 'table', 'chart', 'code', 'embed', 'icons', 'objects', 'math']
  const tagged = (hay: string, needles: string[]) => needles.some((n) => hay.includes(n))
  const ctxMissing = CONTEXT_ITEMS.filter((i) => !tagged(ctx, ["'" + i.id + "')", "uiItem = '" + i.id + "'"])).map((i) => i.id)
  // the Arrange ▾ popover tags its buttons with item('<id>', …)
  const miniMissing = MINIBAR_ITEMS.filter((i) => !tagged(mini, ["this.add('" + i.id + "'", "item('" + i.id + "'"])).map((i) => i.id)
  const toolMissing = TOOLBAR_ITEMS.filter((i) => !insertIds.includes(i.id) && !tagged(tools, ["'" + i.id + "')"])).map((i) => i.id)
  ok(!ctxMissing.length, 'every right-click item id is tagged in contextmenu.ts (missing: ' + (ctxMissing.join(', ') || 'none') + ')')
  ok(!miniMissing.length, 'every quick-format item id is tagged in minitoolbar.ts (missing: ' + (miniMissing.join(', ') || 'none') + ')')
  ok(!toolMissing.length, 'every toolbar id is tagged in editor.ts/insertgroup.ts (missing: ' + (toolMissing.join(', ') || 'none') + ')')
  // toolbar CSS
  const css = toolbarCss({ hide: ['embed'], order: ['chart', 'table'] })
  ok(css.includes('[data-ui-tool="embed"] { display: none !important; }') && css.includes('[data-ui-tool="chart"] { order: -2; }') && css.includes('[data-ui-tool="table"] { order: -1; }'), 'toolbar CSS hides and orders by catalog id')
  ok(!toolbarCss({ hide: ['x"] } body { display:none } [a="'] }).includes('body'), 'toolbar CSS takes catalog ids only')
  // pruning
  const pruned = pruneDangling(JSON.parse(JSON.stringify({ ...base, styles, actions, menus })))
  delete pruned.actions!.callout
  pruneDangling(pruned)
  ok(stableJson(pruned.menus?.context?.add) === stableJson({ '*': ['arrange.group'], canvas: ['insert.text'] }) && !pruned.menus?.minibar?.add, 'deleting an action unpins it everywhere')
  // parts
  const full = strict({
    ...base, styles: { ...styles, plain: { label: 'Plain', patch: { opacity: 0.5 } } },
    actions: { ...actions, plainer: { kind: 'style', style: 'plain' }, seq: { kind: 'sequence', steps: [{ command: 'insert.text' }, { style: 'callout' }] } },
    ribbon: { tabs: [{ id: 'brand', label: 'Brand', groups: [{ id: 'g', label: 'G', buttons: [{ target: 'callout' }] }] }], hide: ['insert:zoom'] },
    shortcuts: { 'Mod+Shift+J': 'seq' }, menus, toolbar, chrome: { density: 'compact' },
  }).profile!
  ok(stableJson(profileParts(full)) === stableJson(['buttons', 'menus', 'toolbar', 'shortcuts', 'styles', 'look']), 'profileParts lists what a profile holds')
  const sc = pickParts(full, ['shortcuts'])
  ok(!!sc.shortcuts && !!sc.actions?.seq && !!sc.styles?.callout && !sc.styles?.plain && !sc.ribbon && !sc.menus && !sc.chrome, 'exporting shortcuts brings the actions and styles they need, nothing else')
  ok(!!strict(sc).profile, 'and the part is a valid profile on its own')
  ok(PROFILE_PARTS_ALL.every((part) => !!strict(pickParts(full, [part])).profile), 'every single part exports as a valid profile')
  // merge
  const mine = strict({ ...base, styles: { callout: { label: 'Mine', patch: { fill: '#ff0000' } } }, actions: { callout: { kind: 'style', style: 'callout' } }, shortcuts: { 'Mod+Shift+J': 'callout' }, chrome: { light: { accent: '#111111' } } }).profile!
  const { profile: merged, notes } = mergeProfiles(mine, full)
  const mv = strict(merged)
  ok(!!mv.profile, `"Add to mine" gives a valid profile (${mv.errors.map((e) => e.path + ' ' + e.message).join('; ')})`)
  ok(merged.styles?.callout?.label === 'Mine' && Object.values(merged.styles ?? {}).some((st) => st.label === 'Callout'), 'a clashing style keeps mine and brings theirs under a new id')
  ok(merged.shortcuts?.['Mod+Shift+J'] === 'callout' && notes.some((n) => n.kind === 'kept-mine' && n.what.includes('Mod+Shift+J')), 'a clashing shortcut keeps mine and says so')
  const theirCallout = Object.entries(merged.styles ?? {}).find(([, st]) => st.label === 'Callout')?.[0]
  const brandTarget = merged.ribbon?.tabs?.[0]?.groups[0]?.buttons[0]?.target
  ok(!!brandTarget && brandTarget !== 'callout' && (merged.actions?.[brandTarget] as { style?: string } | undefined)?.style === theirCallout, 'their button follows the rename to their own style')
  ok(merged.chrome?.light?.accent === '#111111' && merged.chrome?.density === 'compact', 'look: mine stays, theirs fills the gaps')
  const again = mergeProfiles(merged, full).profile
  ok(stableJson(again.menus) === stableJson(merged.menus) && stableJson(again.toolbar) === stableJson(merged.toolbar), 'importing the same thing twice adds nothing twice (menus, toolbar)')
}


// ---- the keymap (Settings ▸ Keyboard shortcuts) -----------------------------------
{
  console.log('\nkeymap')
  const strict = (p: unknown) => validateProfile(p, 'strict')
  const label = (id: string) => id
  const km = (p: UiProfile | null) => buildKeymap(p, { targetLabel: label })
  const base = km(null)
  const row = (rows: ReturnType<typeof km>, target: string) => rows.find((r) => r.target === target)!
  ok(base.filter((r) => r.kind === 'command').length === commandCatalog().length, 'one row per catalog command')
  ok(!base.some((r) => r.modified), 'nothing is modified without a profile')
  ok(row(base, 'file.save').keys[0]?.chord === 'Mod+S' && row(base, 'file.save').keys[0]?.locked === true, 'Save has ⌘S, locked')
  ok(row(base, 'view.grid').keys[0]?.chord === 'Mod+G' && !row(base, 'view.grid').keys[0]?.locked, 'Grid has ⌘G, overridable')
  ok(row(base, 'arrange.group').keys[0]?.chord === 'G' && row(base, 'arrange.group').keys[0]?.locked === true, 'Group keeps its raw built-in key G, locked')
  ok(row(base, 'view.sorter').keys.some((k) => k.chord === 'Mod+1'), 'Slide Sorter shows the editor key ⌘1 its menu entry lacks')
  ok(base.some((r) => r.kind === 'key' && r.target === 'key:Mod+D'), 'an editor key with no command (⌘D Duplicate) is its own row')
  ok(keyText('Shift+CmdOrCtrl+Z', true) === '⌘⇧Z' && keyText('CmdOrCtrl+,', false) === 'Ctrl+,' && keyText('Mod+Alt+F', true) === '⌘⌥F', 'raw accelerators display like chords')
  ok(filterRows(base, 'grid', true).some((r) => r.target === 'view.grid'), 'search by name')
  ok(filterRows(base, '⌘G', true).map((r) => r.target).join() === 'view.grid', 'search by key as shown (⌘G)')
  ok(filterRows(base, 'ctrl+g', true).some((r) => r.target === 'view.grid'), 'search by the other platform’s spelling (ctrl+g)')
  ok(rowsWithKey(base, 'Mod+G').map((r) => r.target).join() === 'view.grid', 'find by key')

  ok(checkAssign(null, base, 'Mod+S', 'view.grid').ok === false, 'a locked key can’t be assigned')
  const free = checkAssign(null, base, 'Mod+Shift+J', 'view.grid')
  ok(free.ok && !free.same && !free.takesFrom, 'a free key just goes')
  const taken = checkAssign(null, base, 'Mod+D', 'slide.hide')
  ok(taken.ok && taken.takesFrom?.kind === 'builtin' && taken.takesFrom.target === 'key:Mod+D', 'a built-in key says whose it is')
  ok(checkAssign(null, base, 'x', 'view.grid').ok === false, 'nonsense is refused')
  ok(checkAssign(null, base, 'Mod+Shift+J', 'key:Mod+D').ok === false, 'nothing can be bound to an editor-key row')

  const p = emptyProfile()
  assignKey(p, 'Mod+D', 'slide.hide')
  ok(strict(p).profile !== null, 'taking over a built-in key is a valid profile')
  let rows = km(p)
  ok(row(rows, 'slide.hide').modified && row(rows, 'slide.hide').keys.some((k) => k.source === 'mine' && k.chord === 'Mod+D'), 'the new key shows on its row')
  ok(row(rows, 'key:Mod+D').keys[0]?.movedTo === 'slide.hide' && row(rows, 'key:Mod+D').modified, 'the old owner shows the key moved away')
  ok(keyOwner(p, rows, 'Mod+D')?.target === 'slide.hide', 'the key’s owner is now mine')
  const moved = checkAssign(p, rows, 'Mod+D', 'view.grid')
  ok(moved.ok && moved.takesFrom?.kind === 'mine' && moved.takesFrom.target === 'slide.hide', 'moving my key again names my command')
  assignKey(p, 'Mod+G', 'view.grid')
  ok(!p.shortcuts?.['Mod+G'], 'giving a command its own built-in key back stores nothing')
  removeKey(p, row(km(p), 'view.grid').keys[0])
  ok(p.shortcuts?.['Mod+G'] === 'none' && strict(p).profile !== null, 'removing a built-in key switches it off (valid)')
  rows = km(p)
  ok(row(rows, 'view.grid').keys[0]?.off === true, 'a switched-off key shows as off')
  ok(!removeKey(p, row(rows, 'file.save').keys[0]), 'a locked key can’t be removed')
  resetRow(p, row(rows, 'view.grid'))
  ok(!p.shortcuts?.['Mod+G'], 'reset turns the built-in key back on')
  resetRow(p, row(km(p), 'slide.hide'))
  ok(!p.shortcuts, 'reset removes my key; an empty shortcuts map goes away')
  const withAction: UiProfile = { ...emptyProfile(), styles: { s: { label: 'S', patch: { fill: '#ff0000' } } }, actions: { 'style-s': { kind: 'style', style: 's' } } }
  ok(km(withAction).some((r) => r.kind === 'action' && r.target === 'style-s'), 'my own commands get rows too')
  assignKey(withAction, 'Mod+Alt+J', 'style-s')
  ok(strict(withAction).profile?.shortcuts?.['Mod+Alt+J'] === 'style-s', 'a key for my style is valid')
}

// ---- quick-format bar place + side-panel order (part 'panel') -----------------
{
  console.log('quick-format bar + side panel order')
  const { PANEL_SECTIONS: SECTIONS, panelSectionId } = await import('../slides/src/editor/customize/catalog.ts')
  const { movePanelSection, panelScopeOrder, pickParts: pick, profileParts: parts, mergeProfiles: merge } = await import('../slides/src/editor/customize/logic.ts')
  const strict = (p: unknown) => validateProfile(p, 'strict')
  const base = { format: 'slidomingo/ui-profile', version: 1 }
  ok(strict({ ...base, toolbar: { quickbar: 'top' } }).profile?.toolbar?.quickbar === 'top', 'toolbar.quickbar "top" is valid')
  ok(strict({ ...base, toolbar: { quickbar: 'sideways' } }).profile === null, 'an unknown quickbar place is refused')
  ok(strict({ ...base, panel: { order: ['Effects', 'multi:Text'] } }).profile?.panel?.order?.length === 2, 'panel.order with known ids is valid')
  ok(strict({ ...base, panel: { order: ['Nope'] } }).profile === null, 'an unknown panel section is refused')
  ok(strict({ ...base, panel: { order: ['Effects', 'Effects'] } }).profile === null, 'a section listed twice is refused')
  ok(validateProfile({ ...base, panel: { order: ['Nope', 'Effects'] } }, 'lenient').profile?.panel?.order?.join() === 'Effects', 'lenient load drops an unknown section')
  ok(panelSectionId('Typography') === 'type' && panelSectionId('Data') === 'type' && panelSectionId('Effects') === 'Effects', 'type-specific sections rank as "type"')
  ok(panelScopeOrder([], 'object').join() === SECTIONS.filter((s) => s.scope === 'object').map((s) => s.id).join(), 'no order = catalog order')
  ok(panelScopeOrder(['History'], 'object')[0] === 'History', 'a listed section comes first')
  const moved = movePanelSection([], 'Effects', 0)
  ok(panelScopeOrder(moved, 'object')[0] === 'Effects' && moved.length === SECTIONS.length, 'moving fills in every scope completely')
  ok(panelScopeOrder(moved, 'slide').join() === panelScopeOrder([], 'slide').join(), 'moving in one scope leaves the others as they were')
  ok(strict({ ...base, panel: { order: moved } }).profile !== null, 'the moved order is a valid profile')
  const p = { ...base, toolbar: { quickbar: 'floating' as const }, panel: { order: ['History'] } } as UiProfile
  ok(parts(p).includes('panel') && parts(p).includes('toolbar'), 'panel and quickbar count as parts to export')
  ok(!pick(p, ['toolbar']).panel && pick(p, ['toolbar']).toolbar?.quickbar === 'floating', 'export by part: toolbar brings quickbar, not the panel')
  ok(pick(p, ['panel']).panel?.order?.[0] === 'History', 'export by part: panel brings the order')
  const mine = { ...base, panel: { order: ['Effects'] } } as UiProfile
  ok(merge(mine, p).profile.panel?.order?.[0] === 'Effects' && merge(mine, p).profile.toolbar?.quickbar === 'floating', 'merge keeps my order, takes their quickbar where I have none')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
