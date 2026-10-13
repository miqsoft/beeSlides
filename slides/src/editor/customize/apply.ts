// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Puts a (validated) UI profile onto the running editor, and takes it off
// again: the chrome tokens and density, `custom.*` commands, custom ribbon
// tabs and the built-in groups' layout, the web topbar's "My tools" menu, a
// secondary shortcut listener, and personal style defaults. Every apply
// starts from nothing (clear, then build), so a change, a revert or the
// enable toggle can never leave a stale piece behind.
//
// Nothing here evaluates anything: a profile names catalog ids, and each id
// maps to code this file (or the command registry) already has. Labels are
// set with textContent and never translated (they are the person's words).

import type { Store } from '../../store'
import { setPersonalStyleDefaults, type SlideElement } from '../../model'
import { ICONS } from '../../icons'
import { t } from '../../i18n'
import { isMacOS } from '../../screens'
import { parseClip, insertElements, serializeElements } from '../clipboard'
import { COMMANDS } from '../menumodel'
import type { CommandRegistry } from '../commands'
import type { RibbonHandle, RibbonTabDef } from '../ribbon'
import { ribbonGroup, ribbonRow } from '../ribbon'
import { isBuiltinChord } from './catalog'
import { applyStylePatch, chordFromEvent, clone, displayChord, normalizeChord, resolveTarget, tokenCss, toolbarCss } from './logic'
import { SHORTCUT_NONE, type QuickBarPlace, type UiAction, type UiButton, type UiProfile, type UiStep } from './schema'
import type { UiChange, UiProfileStore } from './store'

export interface CustomizerHost {
  store: Store
  commands: CommandRegistry
  /** The desktop ribbon (null in a browser). */
  ribbon(): RibbonHandle | null
  /** The web topbar's slot for the "My tools" menu (null on desktop). */
  webSlot(): HTMLElement | null
  commitTextEdit(): void
  /** Presenting, the Layout Manager… — custom shortcuts stay quiet. */
  blocked(): boolean
  /** The native menu (View ▸ My commands) needs a refresh. */
  menuChanged(): void
  /** The quick-format bar must rebuild (its pins or hidden items changed). */
  minibarChanged(): void
  /** The side panel's section order changed (panels.ts re-sorts). */
  panelChanged?(): void
  toast(message: string): void
  openCustomize(): void
}

const STYLE_ID = 'slidomingo-ui-profile-tokens'

/** One pinned item of a menu, ready to show: the menus build it themselves
 *  (contextmenu.ts, minitoolbar.ts) and call `run`. */
export interface MenuPin { target: string; label: string; icon?: string; chord: string | null; run(): void }

/** What contextmenu.ts and minitoolbar.ts ask of the profile. */
export interface MenuCustomization {
  /** Pinned items for the scopes that apply right now, deduplicated. */
  pins(menu: 'context' | 'minibar', scopes: readonly string[]): MenuPin[]
  /** Built-in item ids this profile hides in that menu. */
  hidden(menu: 'context' | 'minibar'): ReadonlySet<string>
  /** Where the profile puts the quick-format bar (undefined = not set). */
  quickbar?(): QuickBarPlace | undefined
}

/** Electron accelerator text for a normalized chord ("Mod+Shift+B" → "CmdOrCtrl+Shift+B"). */
const electronAccel = (chord: string) => chord.replace(/^Mod\b/, 'CmdOrCtrl')

/** The words for a target: the button's own label, else the action's, else
 *  the command's (translated — it is ours), else the id. */
export function targetLabel(profile: UiProfile, target: string, own?: string): string {
  if (own) return own
  const r = resolveTarget(profile, target)
  if (r?.kind === 'action') return actionLabel(profile, r.id, r.action)
  if (r?.kind === 'command') return COMMANDS[r.id] ? t(COMMANDS[r.id].label) : r.id
  return target
}

export function actionLabel(profile: UiProfile, id: string, a: UiAction): string {
  if (a.label) return a.label
  if (a.kind === 'command') return COMMANDS[a.command] ? t(COMMANDS[a.command].label) : a.command
  if (a.kind === 'style') return profile.styles?.[a.style]?.label ?? id
  if (a.kind === 'insert') return profile.presets?.[a.preset]?.label ?? id
  return id
}

export class UiCustomizer implements MenuCustomization {
  private profile: UiProfile | null = null
  private shortcuts: Record<string, string> = {}
  private host: CustomizerHost
  readonly profiles: UiProfileStore

  constructor(host: CustomizerHost, profiles: UiProfileStore) {
    this.host = host
    this.profiles = profiles
    document.addEventListener('keydown', (ev) => this.onKey(ev))
    // a built-in key the profile took over: ahead of the editor's own handler
    window.addEventListener('keydown', (ev) => this.onBuiltinKey(ev), true)
    host.commands.accelFor = (id, builtin) => this.accelFor(id, builtin)
  }

  pins(menu: 'context' | 'minibar', scopes: readonly string[]): MenuPin[] {
    const p = this.profile
    const add = p?.menus?.[menu]?.add
    if (!p || !add) return []
    const seen = new Set<string>()
    const out: MenuPin[] = []
    for (const scope of scopes) {
      for (const target of add[scope] ?? []) {
        if (seen.has(target)) continue
        seen.add(target)
        const r = resolveTarget(p, target)
        const icon = r?.kind === 'action' ? r.action.icon : undefined
        out.push({ target, label: targetLabel(p, target), ...(icon ? { icon } : {}), chord: this.chordFor(target), run: () => this.runTarget(target) })
      }
    }
    return out
  }

  hidden(menu: 'context' | 'minibar'): ReadonlySet<string> {
    return new Set(this.profile?.menus?.[menu]?.hide ?? [])
  }

  quickbar(): QuickBarPlace | undefined {
    return this.profile?.toolbar?.quickbar
  }

  /** The profile's side-panel section order (catalog.ts PANEL_SECTIONS ids). */
  panelOrder(): readonly string[] {
    return this.profile?.panel?.order ?? []
  }

  /** The native menu's accelerator for a command, after the profile: a
   *  built-in key that now does something else (or nothing) is dropped, and a
   *  key the profile gives the command is shown. */
  private accelFor(id: string, builtin: string | undefined): string | undefined {
    const own = Object.entries(this.shortcuts).find(([, t]) => t === id)?.[0]
    if (own) return electronAccel(own)
    const b = builtin ? normalizeChord(builtin) : null
    return b && this.shortcuts[b] ? undefined : builtin
  }

  /** The profile in force (null = none, disabled, or switched off). */
  get active(): UiProfile | null { return this.profile }

  /** Shortcut chords the profile binds, for display. */
  chordFor(target: string): string | null {
    const c = Object.entries(this.shortcuts).find(([, t]) => t === target)?.[0]
    return c ? displayChord(c, isMacOS()) : null
  }

  /** Re-applies whatever the store holds now. */
  refresh(): void { this.apply(this.profiles.current().profile) }

  /** A change from the store: apply it; an AI-made one also says so, with Undo. */
  onChange(c: UiChange): void {
    this.apply(c.profile)
    if ((c.source === 'chat' || c.source === 'agent') && c.prevRev >= 0) {
      this.changedToast(c)
    }
  }

  private changedToast(c: UiChange): void {
    document.querySelector('.ed-toast, .ed-actiontoast')?.remove()
    const bar = document.createElement('div')
    bar.className = 'ed-recover ed-actiontoast ed-ui-changed'
    bar.setAttribute('role', 'status')
    const msg = document.createElement('span')
    msg.textContent = c.summary
      ? t('Your editor was changed: {what}', { what: c.summary })
      : t('Your editor was changed')
    const undo = document.createElement('button')
    undo.className = 'ed-btn ed-btn-primary'
    undo.textContent = t('Undo')
    undo.addEventListener('click', () => { bar.remove(); void this.profiles.revert(c.prevRev) })
    const x = document.createElement('button')
    x.className = 'ed-btn'
    x.textContent = '✕'
    x.title = t('Close')
    x.addEventListener('click', () => bar.remove())
    bar.append(msg, undo, x)
    document.body.appendChild(bar)
    setTimeout(() => bar.remove(), 10000)
  }

  apply(next: UiProfile | null): void {
    const p = next && next.enabled !== false ? next : null
    this.profile = p
    this.applyChrome(p)
    setPersonalStyleDefaults(p?.defaults)
    // commands: the whole custom set is replaced
    const { commands } = this.host
    commands.unregisterPrefix('custom.')
    for (const [id, action] of Object.entries(p?.actions ?? {})) {
      commands.register(`custom.${id}`, { run: () => this.runAction(id), label: actionLabel(p!, id, action) })
    }
    this.shortcuts = { ...(p?.shortcuts ?? {}) }
    this.host.minibarChanged()
    this.host.panelChanged?.()
    const ribbon = this.host.ribbon()
    if (ribbon) {
      ribbon.setCustomTabs(p ? this.ribbonTabs(p) : [])
      ribbon.applyLayout({ hide: p?.ribbon?.hide, order: p?.ribbon?.order })
    }
    this.fillWebMenu(p)
    this.host.menuChanged()
  }

  // ---- chrome ------------------------------------------------------------------

  private applyChrome(p: UiProfile | null): void {
    const css = [tokenCss(p?.chrome), toolbarCss(p?.toolbar)].filter(Boolean).join('\n')
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
    if (!css) style?.remove()
    else {
      if (!style) {
        style = document.createElement('style')
        style.id = STYLE_ID
        // never written into a saved file (PLATFORM.md §4)
        style.setAttribute('data-slidomingo-transient', '')
        document.head.appendChild(style)
      }
      style.textContent = css
    }
    const root = document.documentElement
    if (p?.chrome?.density === 'compact') root.dataset.uiDensity = 'compact'
    else delete root.dataset.uiDensity
  }

  // ---- buttons -------------------------------------------------------------------

  private button(p: UiProfile, b: UiButton): HTMLElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'ed-btn ed-btn-custom'
    el.dataset.target = b.target
    const action = resolveTarget(p, b.target)
    const icon = b.icon ?? (action?.kind === 'action' ? action.action.icon : undefined)
    // the icon is OUR markup, chosen by a catalog id — never the profile's
    if (icon && icon in ICONS) el.innerHTML = ICONS[icon as keyof typeof ICONS]
    const label = document.createElement('span')
    label.textContent = targetLabel(p, b.target, b.label)
    el.appendChild(label)
    const chord = this.chordFor(b.target)
    el.title = chord ? `${label.textContent} (${chord})` : label.textContent ?? ''
    // keep a live text edit (and its selection) when clicked
    el.addEventListener('mousedown', (ev) => ev.preventDefault())
    el.addEventListener('click', () => this.runTarget(b.target))
    return el
  }

  private ribbonTabs(p: UiProfile): RibbonTabDef[] {
    return (p.ribbon?.tabs ?? []).map((tab) => ({
      key: `custom:${tab.id}`,
      label: tab.label,
      row: ribbonRow(tab.groups.map((g) => {
        const group = ribbonGroup(g.label, g.buttons.map((b) => this.button(p, b)))
        group.dataset.customGroup = g.id
        return group
      })),
    }))
  }

  private fillWebMenu(p: UiProfile | null): void {
    const slot = this.host.webSlot()
    if (!slot) return
    slot.replaceChildren()
    const tabs = p?.ribbon?.tabs ?? []
    slot.hidden = !tabs.length
    if (!tabs.length) return
    const menu = document.createElement('div')
    menu.className = 'ed-menu ed-mytools-menu'
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'ed-btn'
    trigger.innerHTML = ICONS.sparkle
    const tl = document.createElement('span')
    tl.textContent = t('My tools')
    trigger.appendChild(tl)
    trigger.title = t('Your own buttons (Settings ▸ Customize)')
    trigger.addEventListener('click', () => slot.classList.toggle('open'))
    for (const tab of tabs) {
      const head = document.createElement('div')
      head.className = 'ed-menu-head'
      head.textContent = tab.label
      menu.appendChild(head)
      for (const g of tab.groups) {
        for (const b of g.buttons) {
          const el = this.button(p!, b)
          el.addEventListener('click', () => slot.classList.remove('open'))
          menu.appendChild(el)
        }
      }
    }
    const sep = document.createElement('div')
    sep.className = 'ed-menu-sep'
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'ed-btn'
    more.textContent = t('Customize…')
    more.addEventListener('click', () => { slot.classList.remove('open'); this.host.openCustomize() })
    menu.append(sep, more)
    slot.append(trigger, menu)
  }

  // ---- running things --------------------------------------------------------------

  private onKey(ev: KeyboardEvent): void {
    if (ev.defaultPrevented || ev.repeat || !this.profile) return
    const chord = chordFromEvent(ev, isMacOS())
    const target = chord ? this.shortcuts[chord] : undefined
    if (!target || target === SHORTCUT_NONE || isBuiltinChord(chord!) || this.host.blocked()) return
    // a form field keeps its keys (an inline text edit never lets them out)
    if (ev.target instanceof Element && ev.target.closest('input, textarea, select')) return
    ev.preventDefault()
    this.runTarget(target)
  }

  /** Capture phase, before editor.ts wireKeyboard: a built-in chord the
   *  profile rebound (or switched off with "none"). Form fields and a live
   *  text edit keep their keys; presenting and the Layout Manager keep the
   *  built-in behaviour. */
  private onBuiltinKey(ev: KeyboardEvent): void {
    if (!this.profile) return
    const chord = chordFromEvent(ev, isMacOS())
    if (!chord || !isBuiltinChord(chord)) return
    const target = this.shortcuts[chord]
    if (!target || this.host.blocked()) return
    if (ev.target instanceof Element && ev.target.closest('input, textarea, select, [contenteditable="true"]')) return
    ev.preventDefault()
    ev.stopImmediatePropagation()
    if (!ev.repeat && target !== SHORTCUT_NONE) this.runTarget(target)
  }

  runTarget(target: string): void {
    const p = this.profile
    const r = p ? resolveTarget(p, target) : null
    if (r?.kind === 'action') this.runAction(r.id)
    else if (r?.kind === 'command' && !this.host.commands.run(r.id)) this.host.toast(t('That isn’t available right now'))
  }

  runAction(id: string): void {
    const a = this.profile?.actions?.[id]
    if (!a) return
    if (a.kind === 'command') { if (!this.host.commands.run(a.command)) this.host.toast(t('That isn’t available right now')); return }
    if (a.kind === 'style') { this.runSteps([{ style: a.style }]); return }
    if (a.kind === 'insert') { this.runSteps([{ insert: a.preset }]); return }
    this.runSteps(a.steps)
  }

  /** Model steps (styles, inserts) that follow each other are ONE commit —
   *  one undo step; a command runs on its own between them. An insert makes
   *  what it inserted the target of the styles after it. */
  runSteps(steps: UiStep[]): void {
    const { store } = this.host
    const p = this.profile
    if (!p) return
    this.host.commitTextEdit()
    let batch: UiStep[] = []
    const flush = () => {
      if (!batch.length) return
      const run = batch
      batch = []
      // dry run first: no change, no undo step (and a hint instead)
      if (run.every((s) => 'style' in s)) {
        const probe = clone(store.selectedElements)
        if (!probe.length) { this.host.toast(t('Select something first')); return }
        let n = 0
        for (const s of run) if ('style' in s) n += applyStylePatch(probe, p.styles?.[s.style]?.patch ?? {})
        if (!n) { this.host.toast(t('Already looks like that')); return }
      }
      let inserted: SlideElement[] = []
      store.commit(() => {
        let targets: SlideElement[] = store.selectedElements
        for (const s of run) {
          if ('insert' in s) {
            const preset = p.presets?.[s.insert]
            const clip = preset ? parseClip(serializeElements(preset.elements, store.doc)) : null
            if (!clip) continue
            inserted = insertElements(clip, store.doc, store.slide)
            targets = inserted
          } else if ('style' in s) {
            applyStylePatch(targets, p.styles?.[s.style]?.patch ?? {})
          }
        }
      })
      if (inserted.length) store.select(inserted.map((e) => e.id))
    }
    for (const s of steps) {
      if ('command' in s) {
        flush()
        if (!this.host.commands.run(s.command)) this.host.toast(t('That isn’t available right now'))
      } else batch.push(s)
    }
    flush()
  }
}
