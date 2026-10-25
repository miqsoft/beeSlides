// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Slide components for slide_html: an agent writes DATA instead of markup,
//   <div id="hs" data-component="sequence" data-actors='["Client","Server"]'
//        data-messages='[{"from":"Client","to":"Server","label":"ClientHello"}]'></div>
// and this expands it into ordinary HTML + CSS before the slide is laid out
// (htmlslide.ts inertSource), so what comes out goes through the same
// sanitizing and compile as hand-written HTML: no new trust boundary. All text
// is escaped. Child ids derive from the component's id (`hs-m1`, `hs-a2`, …),
// so the same component on the next slide morphs, and `data-active` /
// `data-show` step through it slide by slide.
//
// WHY. Writing a diagram as hand-made HTML costs a model thousands of output
// tokens per slide, and output tokens are most of the time a deck takes to
// build (DECISIONS 2026-10-22). A component is a few hundred, and looks the
// same on every slide.

export interface ComponentTheme { accent: string; background: string; color: string }

/** Kinds, with the data attributes each reads (for help texts and notes). */
export const COMPONENTS = {
  steps: 'data-items (["title", …] or [{title, text}]), data-active (1-based: done before it, upcoming after)',
  sequence: 'data-actors (["Client","Server"], 2-5), data-messages ([{from, to, label, note}], from/to = actor name or 1-based index), data-show (first n messages), data-active (1-based message highlighted)',
  cards: 'data-items ([{title, text, badge}]), data-columns (default: up to 4), data-active (1-based card highlighted)',
  compare: 'data-columns ([{title, items: ["…"]}], 2-4), data-active (1-based column highlighted)',
  flow: 'data-nodes (["title", …] or [{title, text}], 2-6), data-labels (one per arrow), data-active (1-based node highlighted)',
} as const
export type ComponentKind = keyof typeof COMPONENTS

const MAX_ITEMS = 14
const MAX_TEXT = 300

const esc = (s: unknown): string => String(s ?? '').slice(0, MAX_TEXT)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
// ids reach attributes and CSS selectors: keep them to a safe alphabet
const safeId = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)

// ---- colours ----------------------------------------------------------------

function rgbOf(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}
const hex = (rgb: number[]): string => `#${rgb.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase()}`
/** `a` over `b` at `t` (0..1); null when either is not a hex colour. */
function mix(a: string, b: string, t: number): string | null {
  const x = rgbOf(a), y = rgbOf(b)
  return x && y ? hex(x.map((v, i) => v * t + y[i] * (1 - t))) : null
}
const luminance = (c: string): number => {
  const v = rgbOf(c)
  return v ? (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255 : 0.5
}

export interface Palette { accent: string; onAccent: string; tint: string; line: string; muted: string; text: string; bg: string }
/** The colours components draw with, derived from the theme; slide HTML
 *  gets the same ones as --bs-muted, --bs-line and --bs-tint (htmlslide.ts
 *  baseCss), so hand-written parts match the diagrams. */
export function palette(t: ComponentTheme): Palette {
  const bg = rgbOf(t.background) ? t.background : '#FFFFFF'
  const text = rgbOf(t.color) ? t.color : '#1F2328'
  const accent = rgbOf(t.accent) ? t.accent : '#2563EB'
  return {
    accent, bg, text,
    onAccent: luminance(accent) > 0.6 ? text : '#FFFFFF',
    tint: mix(accent, bg, 0.1) ?? '#EEF2F7',
    line: mix(text, bg, 0.22) ?? '#C9CED6',
    // 0.7: at least 4.5:1 on the background and on the tint (WCAG 1.4.3)
    muted: mix(text, bg, 0.7) ?? '#6B7280',
  }
}

// ---- data -------------------------------------------------------------------

function parseList(el: Element, attr: string, notes: Set<string>, id: string): unknown[] | null {
  const raw = el.getAttribute(attr)
  if (raw === null) return null
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) {
      if (v.length > MAX_ITEMS) notes.add(`#${id}: ${attr} has more than ${MAX_ITEMS} entries; the rest were left out.`)
      return v.slice(0, MAX_ITEMS)
    }
  } catch { /* noted below */ }
  notes.add(`#${id}: ${attr} must be a JSON array.`)
  return null
}
const titled = (v: unknown): { title: string; text: string; badge: string } => {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return { title: esc(o.title ?? o.label ?? ''), text: esc(o.text ?? ''), badge: esc(o.badge ?? '') }
  }
  return { title: esc(v), text: '', badge: '' }
}
/** 1-based index attribute → 0-based, or -1. */
const indexAttr = (el: Element, attr: string, n: number): number => {
  const k = Number(el.getAttribute(attr))
  return Number.isInteger(k) && k >= 1 && k <= n ? k - 1 : -1
}
const pct = (n: number) => `${Math.round(n * 10000) / 100}%`
/** Centred vertically in the container's height, when it has one. */
const vcenter = (inner: string): string => `<div style="height:100%;display:flex;flex-direction:column;justify-content:center">${inner}</div>`

// ---- the components ---------------------------------------------------------

interface Built { html: string }

function steps(el: Element, id: string, p: Palette, notes: Set<string>): Built | null {
  const items = parseList(el, 'data-items', notes, id)?.map(titled)
  if (!items?.length) { notes.add(`#${id}: steps needs data-items.`); return null }
  const n = items.length
  const active = indexAttr(el, 'data-active', n)
  const state = (i: number) => (active < 0 || i < active ? 'done' : i === active ? 'now' : 'next')
  const D = 48, top = 0
  const bars = items.slice(1).map((_, i) => {
    const on = active < 0 || i + 1 <= active
    return `<div id="${id}-bar${i + 1}" style="position:absolute;top:${top + D / 2 - 2}px;height:4px;left:calc(${pct((i + 0.5) / n)} + ${D / 2 + 6}px);width:calc(${pct(1 / n)} - ${D + 12}px);background:${on ? p.accent : p.line};border-radius:2px"></div>`
  }).join('')
  const cols = items.map((it, i) => {
    const s = state(i)
    // done: tinted, now: solid accent, next: grey ring (no data-active: all solid)
    const dot = s === 'next' ? `background:${p.bg};border:3px solid ${p.line};color:${p.muted}`
      : s === 'done' && active >= 0 ? `background:${p.tint};border:3px solid ${p.accent};color:${p.accent}`
        : `background:${p.accent};border:3px solid ${p.accent};color:${p.onAccent}`
    return `<div class="bsc-col" style="flex:1 1 0;display:flex;flex-direction:column;align-items:center;gap:10px;padding:0 8px">`
      + `<div id="${id}-dot${i + 1}" style="width:${D}px;height:${D}px;border-radius:50%;${dot};display:flex;align-items:center;justify-content:center;text-align:center;font-weight:700;font-size:20px">${i + 1}</div>`
      + (it.title ? `<div id="${id}-title${i + 1}" style="text-align:center;font-weight:700;font-size:calc(21px*var(--bsc-k));color:${s === 'next' ? p.muted : p.text}">${it.title}</div>` : '')
      + (it.text ? `<div id="${id}-text${i + 1}" style="text-align:center;font-size:calc(16px*var(--bsc-k));line-height:1.3;color:${p.muted}">${it.text}</div>` : '')
      + '</div>'
  }).join('')
  return { html: vcenter(`<div style="position:relative;display:flex;align-items:flex-start">${bars}${cols}</div>`) }
}

function sequence(el: Element, id: string, p: Palette, notes: Set<string>): Built | null {
  const actors = parseList(el, 'data-actors', notes, id)?.map((a) => esc(typeof a === 'object' && a ? (a as { title?: unknown }).title : a))
  const all = parseList(el, 'data-messages', notes, id) ?? []
  if (!actors || actors.length < 2 || actors.length > 5) { notes.add(`#${id}: sequence needs 2 to 5 data-actors.`); return null }
  const n = actors.length
  const who = (v: unknown): number => {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= n) return v - 1
    const i = actors.indexOf(esc(v))
    return i
  }
  const showAttr = el.getAttribute('data-show')
  const shown = showAttr === null ? all.length : Number(showAttr)
  const msgs = all.slice(0, Number.isInteger(shown) && shown >= 0 ? shown : all.length)
  const active = indexAttr(el, 'data-active', msgs.length)
  // Rows share the height the container gets (at least ROW each); a row is
  // kept for every message, shown or not, so stepping data-show from slide to
  // slide never moves what is already there (morph pairs stay put).
  const HEAD = 56, ROW = 60, GAP = 12
  const center = (i: number) => (i + 0.5) / n
  const heads = actors.map((a, i) =>
    `<div id="${id}-a${i + 1}" style="position:absolute;top:0;height:${HEAD}px;left:calc(${pct(center(i))} - min(110px, ${pct(0.5 / n)} - 12px));width:min(220px, ${pct(1 / n)} - 24px);border-radius:12px;background:${p.tint};border:2px solid ${p.accent};display:flex;align-items:center;justify-content:center;text-align:center;font-weight:700;font-size:calc(21px*var(--bsc-k));color:${p.text}">${a}</div>`).join('')
  const lifelines = actors.map((_, i) =>
    `<div id="${id}-life${i + 1}" style="position:absolute;top:${HEAD}px;bottom:0;left:calc(${pct(center(i))} - 1px);width:2px;background:${p.line}"></div>`).join('')
  const row = (inner: string) => `<div style="position:relative;flex:1 0 ${ROW}px">${inner}</div>`
  const rows = all.map((m, k) => {
    if (k >= msgs.length) return row('')
    const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    const a = who(o.from), b = who(o.to)
    if (a < 0 || b < 0) { notes.add(`#${id}: message ${k + 1} names an actor that is not in data-actors.`); return row('') }
    const on = active < 0 || active === k
    const color = on ? p.accent : p.line
    const tcol = on ? p.text : p.muted
    const label = esc(o.label), note = esc(o.note)
    if (a === b) {
      return row(`<div id="${id}-m${k + 1}" style="position:absolute;top:calc(50% - 18px);height:36px;left:calc(${pct(center(a))} - 110px);width:220px;border-radius:18px;background:${on ? p.tint : p.bg};border:2px solid ${color};display:flex;align-items:center;justify-content:center;text-align:center;font-size:calc(16px*var(--bsc-k));font-weight:600;color:${tcol}">${label}</div>`)
    }
    const lo = Math.min(a, b), hi = Math.max(a, b)
    const span = `left:calc(${pct(center(lo))} + 6px);width:calc(${pct(center(hi) - center(lo))} - 12px)`
    return row(`<div id="${id}-m${k + 1}-label" style="position:absolute;bottom:calc(50% + 6px);${span};text-align:center;font-weight:700;font-size:calc(18px*var(--bsc-k));color:${tcol}">${label}</div>`
      + `<hr id="${id}-m${k + 1}" data-arrow="${b > a ? 'end' : 'start'}" style="position:absolute;top:calc(50% - 1px);${span};margin:0;height:0;border:0;border-top:3px solid ${color}">`
      + (note ? `<div id="${id}-m${k + 1}-note" style="position:absolute;top:calc(50% + 8px);${span};text-align:center;font-size:calc(15px*var(--bsc-k));color:${p.muted}">${note}</div>` : ''))
  }).join('')
  return { html: `<div style="position:relative;height:100%;display:flex;flex-direction:column">${lifelines}<div style="position:relative;flex:0 0 ${HEAD + GAP}px">${heads}</div>${rows}</div>` }
}

function cards(el: Element, id: string, p: Palette, notes: Set<string>): Built | null {
  const items = parseList(el, 'data-items', notes, id)?.map(titled)
  if (!items?.length) { notes.add(`#${id}: cards needs data-items.`); return null }
  const colsAttr = Number(el.getAttribute('data-columns'))
  const cols = Number.isInteger(colsAttr) && colsAttr >= 1 && colsAttr <= 6 ? colsAttr : Math.min(items.length, 4)
  const active = indexAttr(el, 'data-active', items.length)
  const body = items.map((it, i) => {
    const on = active === i
    return `<div id="${id}-c${i + 1}" style="display:flex;flex-direction:column;gap:10px;padding:22px;border-radius:16px;background:${on ? p.accent : p.tint};border:2px solid ${on ? p.accent : p.tint}">`
      + (it.badge ? `<div id="${id}-c${i + 1}-badge" style="width:44px;height:44px;border-radius:50%;background:${on ? p.bg : p.accent};color:${on ? p.accent : p.onAccent};display:flex;align-items:center;justify-content:center;text-align:center;font-weight:700;font-size:19px">${it.badge}</div>` : '')
      + (it.title ? `<div id="${id}-c${i + 1}-title" style="font-weight:700;font-size:calc(22px*var(--bsc-k));color:${on ? p.onAccent : p.text}">${it.title}</div>` : '')
      + (it.text ? `<div id="${id}-c${i + 1}-text" style="font-size:calc(17px*var(--bsc-k));line-height:1.35;color:${on ? p.onAccent : p.muted}">${it.text}</div>` : '')
      + '</div>'
  }).join('')
  return { html: vcenter(`<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:20px">${body}</div>`) }
}

function compare(el: Element, id: string, p: Palette, notes: Set<string>): Built | null {
  const cols = parseList(el, 'data-columns', notes, id)
  if (!cols || cols.length < 2 || cols.length > 4) { notes.add(`#${id}: compare needs 2 to 4 data-columns.`); return null }
  const active = indexAttr(el, 'data-active', cols.length)
  const body = cols.map((c, i) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
    const items = Array.isArray(o.items) ? o.items.slice(0, MAX_ITEMS) : []
    const on = active < 0 || active === i
    return `<div id="${id}-col${i + 1}" style="display:flex;flex-direction:column;border-radius:16px;background:${p.tint};padding:12px 12px 18px">`
      + `<div id="${id}-col${i + 1}-head" style="border-radius:11px;padding:12px 16px;background:${on ? p.accent : p.line};color:${on ? p.onAccent : p.text};font-weight:700;font-size:calc(22px*var(--bsc-k))">${esc(o.title)}</div>`
      + (items.length ? `<ul id="${id}-col${i + 1}-list" style="margin:14px 12px 0;padding-inline-start:1.1em;font-size:calc(18px*var(--bsc-k));line-height:1.45;color:${p.text}">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '')
      + '</div>'
  }).join('')
  return { html: vcenter(`<div style="display:grid;grid-template-columns:repeat(${cols.length},1fr);gap:24px">${body}</div>`) }
}

function flow(el: Element, id: string, p: Palette, notes: Set<string>): Built | null {
  const nodes = parseList(el, 'data-nodes', notes, id)?.map(titled)
  if (!nodes || nodes.length < 2 || nodes.length > 6) { notes.add(`#${id}: flow needs 2 to 6 data-nodes.`); return null }
  const labels = (parseList(el, 'data-labels', notes, id) ?? []).map(esc)
  const active = indexAttr(el, 'data-active', nodes.length)
  const parts: string[] = []
  nodes.forEach((nd, i) => {
    const on = active === i
    parts.push(`<div id="${id}-n${i + 1}" style="flex:1 1 0;min-width:min-content;display:flex;flex-direction:column;justify-content:center;gap:6px;padding:16px 12px;border-radius:14px;text-align:center;background:${on ? p.accent : p.tint};border:2px solid ${p.accent}">`
      + `<div id="${id}-n${i + 1}-title" style="font-weight:700;font-size:calc(21px*var(--bsc-k));color:${on ? p.onAccent : p.text}">${nd.title}</div>`
      + (nd.text ? `<div id="${id}-n${i + 1}-text" style="font-size:calc(15px*var(--bsc-k));line-height:1.3;color:${on ? p.onAccent : p.muted}">${nd.text}</div>` : '')
      + '</div>')
    if (i < nodes.length - 1) {
      parts.push(`<div style="flex:0 0 ${labels.some(Boolean) ? 104 : 64}px;display:flex;flex-direction:column;justify-content:center;gap:6px;padding:0 6px">`
        + (labels[i] ? `<div id="${id}-e${i + 1}-label" style="text-align:center;font-size:calc(14px*var(--bsc-k));font-weight:600;color:${p.muted}">${labels[i]}</div>` : '')
        + `<hr id="${id}-e${i + 1}" data-arrow="end" style="margin:0;height:0;border:0;border-top:3px solid ${p.accent}">`
        + '</div>')
    }
  })
  return { html: vcenter(`<div style="display:flex;align-items:stretch">${parts.join('')}</div>`) }
}

const BUILD: Record<ComponentKind, (el: Element, id: string, p: Palette, notes: Set<string>) => Built | null> = { steps, sequence, cards, compare, flow }

/**
 * Replaces the content of every `[data-component]` element in `root` with
 * its expansion. The element itself stays (its id, class and style place
 * and size the component); its children are replaced. Unknown kinds and bad
 * data leave it empty and say why in `notes`.
 */
export function expandComponents(root: ParentNode, theme: ComponentTheme, notes: Set<string>): void {
  const list = Array.from(root.querySelectorAll('[data-component]'))
  if (!list.length) return
  const p = palette(theme)
  let auto = 0
  for (const el of list) {
    // a component inside one already expanded (or removed) is gone with it
    if (!el.isConnected && !root.contains(el)) continue
    const kind = (el.getAttribute('data-component') ?? '').trim().toLowerCase() as ComponentKind
    let id = safeId(el.getAttribute('id') ?? '')
    if (!id) {
      id = `${kind || 'component'}${++auto}`
      notes.add(`A ${kind || 'component'} without an id got "${id}": give it an id so its parts keep theirs.`)
    }
    el.setAttribute('id', id)
    const build = BUILD[kind]
    if (!build) {
      notes.add(`#${id}: no component "${kind}" (there are ${Object.keys(COMPONENTS).join(', ')}).`)
      el.replaceChildren()
      continue
    }
    const k = ({ s: 0.85, m: 1, l: 1.15 } as Record<string, number>)[el.getAttribute('data-size') ?? 'm'] ?? 1
    const out = build(el, id, p, notes)
    const tpl = el.ownerDocument.createElement('template')
    tpl.innerHTML = out?.html ?? ''
    el.replaceChildren(tpl.content)
    ;(el as HTMLElement).style?.setProperty('--bsc-k', String(k))
    for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-') && a.name !== 'data-role') el.removeAttribute(a.name)
  }
}
