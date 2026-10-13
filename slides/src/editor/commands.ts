// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The command registry — the ONE place a menu command's behaviour lives.
//
// menumodel.ts is the catalog (ids, English labels, accelerators, menu
// order); this file binds each id to a handler and turns the catalog into the
// translated, state-aware model the desktop shell draws as the native menu
// bar (see desktop/src/main/menu.ts). The Editor registers its commands once
// (Editor.registerCommands); every `run` is a one-line call to an existing
// Editor method — no command logic is duplicated here or in the menus.
//
// In-app chrome (Save ▾, the ribbon) may take its label from `commandLabel`
// so a command is spelled identically everywhere.

import { t, localeChoices, locale } from '../i18n'
import { SHAPE_MENU } from './insertgroup'
import { PRESET_CATEGORIES, SHAPE_PRESETS } from './shapepresets'
import {
  COMMANDS, TRANSITION_KINDS, TRANSITION_LABELS, menuCommandIds, serializeMenuModel,
  type ExpandItem, type ItemState, type MenuModel,
} from './menumodel'

export interface Command {
  run(): void
  enabled?(): boolean
  checked?(): boolean
  visible?(): boolean
  /** A user-authored label (UI profile `custom.*` commands, View ▸ My
   *  commands): shown as typed, never passed through t(). */
  label?: string
}

export class CommandRegistry {
  private cmds = new Map<string, Command>()
  /** Everything is disabled while this returns true (presenting, modal…). */
  blocked: () => boolean = () => false
  /** The accelerator the native menu shows for a command — the UI profile's
   *  shortcuts (customize/apply.ts) replace the catalog's. */
  accelFor: ((id: string, builtin: string | undefined) => string | undefined) | null = null

  register(id: string, cmd: Command): void { this.cmds.set(id, cmd) }
  /** Drops every command whose id starts with `prefix` (a UI profile's
   *  `custom.` set is replaced as a whole on every change). */
  unregisterPrefix(prefix: string): void { for (const id of [...this.cmds.keys()]) if (id.startsWith(prefix)) this.cmds.delete(id) }
  has(id: string): boolean { return this.cmds.has(id) }
  ids(): string[] { return [...this.cmds.keys()] }

  /** Run a command by id; false when the id is unknown or currently disabled. */
  run(id: string): boolean {
    const c = this.cmds.get(id)
    if (!c || this.state(id).enabled === false || this.state(id).visible === false) return false
    c.run()
    return true
  }

  state(id: string): ItemState {
    const c = this.cmds.get(id)
    if (!c) return { enabled: false }
    const visible = c.visible ? c.visible() : true
    return {
      visible,
      enabled: !this.blocked() && (c.enabled ? c.enabled() : true),
      checked: c.checked ? c.checked() : undefined,
    }
  }

  /** Catalog ids the menu references that nothing registered — must be empty
   *  (guarded by desktop/scripts/e2e-menu.mjs). */
  unresolved(): string[] {
    const gen = (p: string) => this.cmds.has(p)
    return menuCommandIds().filter((id) => !gen(id))
  }

  /** The translated, state-aware model sent to the native menu. */
  serialize(): MenuModel {
    return serializeMenuModel({
      tr: (en) => t(en),
      state: (id) => this.state(id),
      ...(this.accelFor ? { accel: this.accelFor } : {}),
      expand: (kind) => {
        if (kind === 'shapes') {
          const leaf = (id: string, label: string) => ({ id, label: t(label), ...this.state(id) })
          const basic: ExpandItem[] = SHAPE_MENU.map((s, i) => leaf(`insert.shape.${i}`, s.label)).filter((x) => x.visible !== false)
          // the toolbar's preset gallery, one submenu per gallery section
          const presets: ExpandItem[] = PRESET_CATEGORIES.map((cat) => ({
            label: t(cat.label),
            submenu: SHAPE_PRESETS.filter((p) => p.category === cat.id)
              .map((p) => leaf(`insert.preset.${p.id}`, p.label)).filter((x) => x.visible !== false),
          }))
          return [...basic, '-', { label: t('Preset shapes'), submenu: presets }]
        }
        if (kind === 'transitions') {
          return TRANSITION_KINDS.map((k) => {
            const id = `slide.transition.${k}`
            const st = this.state(id)
            return { id, label: t(TRANSITION_LABELS[k]), checked: !!st.checked, radio: true, enabled: st.enabled, visible: st.visible }
          }).filter((x) => x.visible !== false)
        }
        if (kind === 'custom') {
          return [...this.cmds.entries()].filter(([id]) => id.startsWith('custom.'))
            .map(([id, c]) => ({ id, label: c.label ?? id, enabled: this.state(id).enabled }))
        }
        return localeChoices().map((c) => ({ id: `view.lang.${c.code}`, label: c.label, checked: c.code === locale(), radio: true }))
      },
    }, locale())
  }
}

/** The command's translated label — for in-app chrome that wants the same wording. */
export function commandLabel(id: string): string {
  const m = COMMANDS[id]
  return m ? t(m.label) : id
}
