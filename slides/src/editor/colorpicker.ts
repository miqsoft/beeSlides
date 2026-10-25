// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Compact color control shared by every color row in the app (shape fill/
// stroke, gradient stops, table styling, shadow, chart series/pie colors,
// theme editor). Replaces a bare native <input type=color> + manual % alpha
// field + a cramped stacked palette strip with one small trigger chip that
// opens a popover: the real native inputs (unchanged parseColor/combineColor
// round-trip), a hex/rgba text field, an eyedropper (feature-detected), a
// small shared recent-colors row, and the caller's theme-palette swatches.
//
// panels.ts's color()/colorAlpha() delegate to buildColorControl() below and
// keep their existing public signatures — every call site is unaffected.
//
// MOUNTING: the popover is appended as a DOM child of the trigger's own
// wrapper (which panels.ts places inside `.ed-row`, itself inside the panel's
// `this.host`) — NOT document.body. position:fixed places it relative to the
// viewport regardless of DOM ancestry (no ancestor here sets transform/
// filter/contain/will-change:transform), so nothing is lost visually, but it
// means a focused hex field is a real <input> inside `this.host`, so panels.ts's
// isActiveEditFocus() recognizes an in-progress edit as "active" without any
// change to that method — a live/remote store event can no longer silently
// wipe an open popover out from under a mid-edit hex field.
//
// A popover that outlives its row (torn down by panels.ts's rebuild() wiping
// `this.host.innerHTML`) would leak its document-level pointerdown/keydown
// listeners. closeActiveColorPopover() is the explicit teardown panels.ts
// calls at the top of rebuild(), before the wipe, for exactly that case
// (a FORCED rebuild bypasses the "active edit" guard that would otherwise
// have deferred the rebuild).

import { t } from '../i18n'
import { lsJson, lsSet } from '../../../kernel/src/storage.ts'
import { positionFloating } from './floatingposition'
import { PALETTE_SLOTS, paletteOf, type PaletteSlot } from '../palette'
import type { SlidomingoDoc } from '../model'

/** Any CSS color → {hex, a}. Handles #rgb/#rrggbb/#rrggbbaa/rgb()/rgba()/transparent. */
export function parseColor(v: string): { hex: string; a: number } {
  if (!v || v === 'transparent' || v === 'none') return { hex: '#000000', a: 0 }
  const m = v.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const parts = m[1].split(/[\s,/]+/).map((s) => parseFloat(s))
    const [r, g, b] = parts
    const a = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
    if ([r, g, b].every((n) => Number.isFinite(n))) {
      const hex = '#' + [r, g, b].map((n) => Math.round(Math.min(Math.max(n, 0), 255)).toString(16).padStart(2, '0')).join('')
      return { hex, a: Math.min(Math.max(a, 0), 1) }
    }
  }
  let hex = v.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) hex = '#' + [...hex.slice(1)].map((c) => c + c).join('')
  if (/^#[0-9a-fA-F]{8}$/.test(hex)) return { hex: hex.slice(0, 7), a: parseInt(hex.slice(7), 16) / 255 }
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return { hex, a: 1 }
  return { hex: '#1D1119', a: 1 }
}

/** The opacity field's value once the user picks a HUE. A control that
 *  opened on a transparent colour ('transparent', 'none', alpha 0) reads 0%,
 *  and picking a colour there used to save it at 0% — an invisible choice.
 *  Choosing a colour means wanting to see it, so 0 becomes 100; any other
 *  opacity the user set is kept. */
export function alphaAfterHuePick(alphaField: string): string {
  const a = parseFloat(alphaField)
  return Number.isFinite(a) && a <= 0 ? '100' : alphaField
}

/** {hex, a} → the shortest CSS color that keeps the alpha. */
export function combineColor(hex: string, a: number): string {
  if (a >= 1) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`
}

// --- recent colors: global, localStorage-backed, capped + deduped ----------

const RECENT_KEY = 'slidomingo-recent-colors'
const RECENT_MAX = 12

function recentColors(): string[] {
  return lsJson<string[]>(RECENT_KEY, [])
}

function pushRecentColor(value: string) {
  const cur = recentColors().filter((c) => c !== value)
  cur.unshift(value)
  lsSet(RECENT_KEY, JSON.stringify(cur.slice(0, RECENT_MAX)))
}

// --- popover lifecycle: only one open at a time, explicitly closable -------

let activeClose: (() => void) | null = null
/** The control wrapper that owns the open popover — lets a caller close only
 *  a popover that lives inside the DOM it is about to wipe. */
let activeOwner: HTMLElement | null = null

/** Close whatever color popover is currently open, if any. Safe to call when
 *  none is open. panels.ts calls this at the top of rebuild(), before the
 *  panel wipes its DOM, so a stale popover never leaks its document-level
 *  listeners.
 *
 *  With `within`, only a popover whose control sits inside that element is
 *  closed. The panel passes its own host: a popover opened from the mini
 *  toolbar must survive the panel rebuilds a colour drag there triggers (its
 *  final step, or a pause mid-drag — panels.ts onLiveStep), or the popover
 *  would vanish under the user's pointer. */
export function closeActiveColorPopover(within?: Element): void {
  if (within && activeOwner && !within.contains(activeOwner)) return
  activeClose?.()
}

export interface ColorControlOpts {
  value: string
  /** show the % opacity field and round-trip via combineColor/parseColor. */
  alpha: boolean
  /** fires on every edit; final=false while dragging/typing live, true on commit. */
  onChange: (value: string, final: boolean) => void
  /** fires alongside onChange(v, true) for a MANUAL pick (swatch aside) —
   *  hand-picking a color must clear any palette reference on this path. */
  onManualCommit?: (value: string) => void
  /** the caller's existing theme-palette swatches, unchanged behavior — given
   *  the native <input type=color> so a swatch click can reflect there too. */
  buildPaletteSwatches?: (input: HTMLInputElement) => HTMLElement
}

/** Each built control's in-place value setter — see syncColorControl. */
const valueSetters = new WeakMap<HTMLElement, (value: string) => void>()

/** Show `value` on a built control without rebuilding it: a live step of a
 *  burst changed the colour under it (props panel, editor/livestep.ts). A
 *  no-op while the control's own popover is open — the user is picking
 *  there, and the popover owns the value. */
export function syncColorControl(control: HTMLElement, value: string): void {
  valueSetters.get(control)?.(value)
}

/** Builds the compact trigger chip; the popover itself is created on demand
 *  (openPopover) and appended as a child of this same wrapper. */
export function buildColorControl(opts: ColorControlOpts): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'ed-color-control'

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'ed-color-trigger'
  trigger.title = t('Choose color')
  const swatch = document.createElement('span')
  swatch.className = 'ed-color-trigger-swatch'
  const label = document.createElement('span')
  label.className = 'ed-color-trigger-label'

  let current = opts.value
  const refreshTrigger = () => {
    const p = parseColor(current)
    // The colour is the TOP background layer (styles.css: a flat gradient of
    // --swatch over the checkerboard). As background-color it painted UNDER
    // the checkerboard image, so every swatch — even opaque black — looked
    // transparent; now the board only shows through a low-alpha colour.
    swatch.style.setProperty('--swatch', current)
    label.textContent = p.hex.toUpperCase()
  }
  refreshTrigger()
  trigger.append(swatch, label)
  wrap.appendChild(trigger)

  let pop: HTMLElement | null = null
  let close = () => {}
  valueSetters.set(wrap, (value) => {
    if (pop || value === current) return
    current = value
    refreshTrigger()
  })

  trigger.addEventListener('click', () => {
    if (pop) { close(); return }
    closeActiveColorPopover()
    openPopover()
  })

  function openPopover() {
    const p0 = parseColor(current)
    pop = document.createElement('div')
    pop.className = 'ed-color-pop'

    // --- native inputs: the exact parseColor/combineColor round-trip -------
    const nativeRow = document.createElement('div')
    nativeRow.className = 'ed-coloralpha'
    const col = document.createElement('input')
    col.type = 'color'
    col.value = p0.hex
    let alpha: HTMLInputElement | null = null
    if (opts.alpha) {
      alpha = document.createElement('input')
      alpha.type = 'number'
      alpha.min = '0'; alpha.max = '100'; alpha.step = '1'
      alpha.value = String(Math.round(p0.a * 100))
      alpha.title = t('Opacity %')
    }
    nativeRow.append(col)
    if (alpha) nativeRow.append(alpha)
    pop.appendChild(nativeRow)

    // --- hex/rgba text field -------------------------------------------------
    const hexField = document.createElement('input')
    hexField.type = 'text'
    hexField.className = 'ed-color-hex'
    hexField.spellcheck = false
    hexField.value = opts.alpha ? current : p0.hex
    pop.appendChild(hexField)

    const resolved = (): string => {
      const a = alpha ? (Number.isFinite(parseFloat(alpha.value)) ? Math.min(Math.max(parseFloat(alpha.value) / 100, 0), 1) : 1) : 1
      return opts.alpha ? combineColor(col.value, a) : col.value
    }

    const applyFromNative = (final: boolean, manual: boolean) => {
      current = resolved()
      hexField.value = current
      refreshTrigger()
      opts.onChange(current, final)
      if (final && manual) {
        opts.onManualCommit?.(current)
        pushRecentColor(current)
      }
    }

    const huePicked = () => { if (alpha) alpha.value = alphaAfterHuePick(alpha.value) }
    col.addEventListener('input', () => { huePicked(); applyFromNative(false, false) })
    col.addEventListener('change', () => { huePicked(); applyFromNative(true, true) })
    alpha?.addEventListener('change', () => applyFromNative(true, false))

    const applyFromHex = (final: boolean) => {
      const parsed = parseColor(hexField.value)
      col.value = parsed.hex
      if (alpha) alpha.value = String(Math.round(parsed.a * 100))
      current = opts.alpha ? combineColor(parsed.hex, parsed.a) : parsed.hex
      refreshTrigger()
      opts.onChange(current, final)
      if (final) {
        opts.onManualCommit?.(current)
        pushRecentColor(current)
      }
    }
    hexField.addEventListener('input', () => applyFromHex(false))
    hexField.addEventListener('change', () => applyFromHex(true))

    // --- eyedropper: feature-detected, hidden entirely (not just disabled) --
    if ('EyeDropper' in window) {
      const drop = document.createElement('button')
      drop.type = 'button'
      drop.className = 'ed-btn ed-btn-icon ed-color-eyedrop'
      drop.title = t('Pick a color from the screen')
      drop.textContent = '💧'
      drop.addEventListener('click', async () => {
        try {
          const ed = new (window as any).EyeDropper()
          const result = await ed.open()
          if (result?.sRGBHex) {
            hexField.value = result.sRGBHex
            applyFromHex(true)
          }
        } catch { /* user cancelled the pick */ }
      })
      nativeRow.appendChild(drop)
    }

    // --- recent colors: global, capped, deduped, most-recent-first ---------
    const recents = recentColors()
    if (recents.length) {
      const row = document.createElement('div')
      row.className = 'ed-color-recent'
      for (const c of recents) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'ed-swatch'
        b.style.background = c
        b.title = c
        b.addEventListener('click', () => {
          hexField.value = c
          applyFromHex(true)
        })
        row.appendChild(b)
      }
      pop.appendChild(row)
    }

    // --- theme palette (caller's existing swatches, unchanged behavior) ----
    if (opts.buildPaletteSwatches) pop.appendChild(opts.buildPaletteSwatches(col))

    wrap.appendChild(pop) // DOM child of the row/host, never document.body
    positionFloating(trigger, pop, { placement: 'bottom-start' })

    close = () => {
      pop?.remove()
      pop = null
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('keydown', onKey, true)
      if (activeClose === close) { activeClose = null; activeOwner = null }
    }
    activeClose = close
    activeOwner = wrap
    const onOutside = (ev: PointerEvent) => {
      if (pop && !pop.contains(ev.target as Node) && ev.target !== trigger) close()
    }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true))
    document.addEventListener('keydown', onKey, true)
  }

  return wrap
}

/**
 * The deck's brand colours as clickable swatches, for a colour control's
 * `buildPaletteSwatches`. `current` is the path's palette ref (its swatch is
 * marked); `onPick` must record that ref beside the literal — that is the
 * whole difference between a re-brandable deck and 400 hex literals.
 */
export function buildPaletteSwatchRow(
  doc: SlidomingoDoc,
  current: string | undefined,
  input: HTMLInputElement,
  onPick: (base: string, slot: PaletteSlot) => void,
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'ed-swatches'
  const palette = paletteOf(doc)
  const slotLabel: Record<PaletteSlot, string> = {
    bg1: t('Background 1 (theme background color)'),
    tx1: t('Text 1 (theme text color)'),
    bg2: t('Background 2 (theme secondary background color)'),
    tx2: t('Text 2 (theme secondary text color)'),
    accent1: t('Accent 1 (theme accent color)'),
    accent2: t('Accent 2 (theme accent color)'),
    accent3: t('Accent 3 (theme accent color)'),
    accent4: t('Accent 4 (theme accent color)'),
    accent5: t('Accent 5 (theme accent color)'),
    accent6: t('Accent 6 (theme accent color)'),
    hlink: t('Hyperlink (theme link color)'),
    folHlink: t('Followed hyperlink (theme link color)'),
  }
  for (const slot of PALETTE_SLOTS) {
    const base = palette[slot]
    if (!base) continue // hlink/folHlink are usually unset — don't show empties
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-swatch'
    b.style.background = base
    b.title = slotLabel[slot]
    if (current && current.split(' ')[0] === slot) b.classList.add('is-on')
    b.addEventListener('click', () => {
      input.value = /^#[0-9a-fA-F]{6}$/.test(base) ? base : parseColor(base).hex
      onPick(base, slot)
    })
    row.appendChild(b)
  }
  return row
}
