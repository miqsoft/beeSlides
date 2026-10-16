// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Icon styles (docs/DECISIONS.md, "Icon styles"): an icon set's drawings,
// painted in more looks — bold, solid, colour, comic, sticker, sketch, badge —
// with nothing redrawn. A look (`IconLook`, model.ts) is a recipe: outline
// weight and colour, a fill per part of the icon (body / detail / accent),
// details cut out of a solid body, a hard shadow, a sticker border, a
// hand-drawn wobble, a badge behind. Because every look renders the SAME
// geometry, the looks of a set stay consistent and one fix reaches all of them.
//
//   - `iconParts`        which part each shape is (its `iconPart`, else guessed)
//   - `iconLookSvg`      one icon in one look → a standalone SVG (grid units)
//   - `LOOK_PRESETS`     the built-in looks
//   - `readLook`         untrusted input (AI op, pasted style, My styles) → a look
//   - `setTweak`         one shape of one icon painted its own way in a look
//   - `learnLookFromIcon`  a look read off an icon someone painted by hand
//   - `learnLookFromSvgStats`  a look read off other people's SVG icons
//
// Pure — no DOM, no i18n — so scripts/test-iconstyles.ts runs it in node.
// Opened files skip untrusted.ts, so everything that reaches markup passes
// `safeColor` / clamps here, at render time.

import type { IconLook, IconPaint, IconShapeTweak, IconsetStyle, Slide, SlidomingoDoc } from './model.ts'
import { ICONSET_STYLE_DEFAULTS, uid } from './model.ts'
import { escXml, iconShapes, iconsetInfo, isNoPaint, n3, normColor, type IconShape, type IconSvg } from './iconset.ts'
import { segsBBox, segsToD, type Seg } from './svgpath.ts'

export type IconPart = 'body' | 'detail' | 'accent'
export const ICON_PARTS: readonly IconPart[] = ['body', 'detail', 'accent']

// ---- which part is which ---------------------------------------------------------------

/** A closed shape at least this share of the biggest one counts as body. */
const BODY_SHARE = 0.3

/** Each shape's part: its own `iconPart`, else open lines and small shapes are
 *  detail and the big closed shapes are the body. */
export function iconParts(shapes: readonly IconShape[]): IconPart[] {
  const area = shapes.map((s) => {
    if (s.open) return 0
    const b = segsBBox(s.segs)
    return b ? b.w * b.h : 0
  })
  const max = Math.max(0, ...area)
  return shapes.map((s, i) => s.el.iconPart ?? (max > 0 && area[i] >= max * BODY_SHARE ? 'body' : 'detail'))
}

// ---- reading a look -------------------------------------------------------------------

const COLOR_RE = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s/+-]{1,60}\)|[a-z]{3,20})$/i

/** A colour safe to write into an attribute, or `fallback`. */
export function safeColor(c: unknown, fallback = '#000000'): string {
  return typeof c === 'string' && COLOR_RE.test(c.trim()) ? c.trim() : fallback
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt

const oneOf = <T extends string>(v: unknown, opts: readonly T[]): T | undefined =>
  typeof v === 'string' && (opts as readonly string[]).includes(v) ? (v as T) : undefined

/** `"#f00"` or `{color, opacity}` → a paint; anything else → undefined. */
function readPaint(v: unknown): IconPaint | undefined {
  if (typeof v === 'string') return COLOR_RE.test(v.trim()) && !isNoPaint(v) ? { color: v.trim() } : undefined
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  if (typeof r.color !== 'string' || !COLOR_RE.test(r.color.trim()) || isNoPaint(r.color)) return undefined
  const p: IconPaint = { color: r.color.trim() }
  if (typeof r.opacity === 'number' && r.opacity < 1) p.opacity = clamp(r.opacity, 0.05, 1, 1)
  return p
}

const LOOK_ID_RE = /^[a-z][a-z0-9-]{0,40}$/

/** Slide and element ids as `uid()` makes them (and agents may write). */
const TWEAK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/
/** Bounds on a look's tweaks: icons per look, shapes per icon. */
export const MAX_TWEAK_ICONS = 500
export const MAX_TWEAK_SHAPES = 200

/** Untrusted → one shape's tweak, or undefined when it changes nothing. */
export function readTweak(v: unknown): IconShapeTweak | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  const out: IconShapeTweak = {}
  if (r.fill === 'none') out.fill = 'none'
  else {
    const p = readPaint(r.fill)
    if (p) out.fill = p
  }
  if (typeof r.stroke === 'string' && COLOR_RE.test(r.stroke.trim()) && !isNoPaint(r.stroke)) out.stroke = r.stroke.trim()
  if (r.hide === true) out.hide = true
  return Object.keys(out).length ? out : undefined
}

function readTweaks(v: unknown): IconLook['tweaks'] | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: NonNullable<IconLook['tweaks']> = {}
  let icons = 0
  for (const [sid, shapes] of Object.entries(v as Record<string, unknown>)) {
    if (icons >= MAX_TWEAK_ICONS) break
    if (!TWEAK_ID_RE.test(sid) || !shapes || typeof shapes !== 'object' || Array.isArray(shapes)) continue
    const one: Record<string, IconShapeTweak> = {}
    let n = 0
    for (const [eid, tw] of Object.entries(shapes as Record<string, unknown>)) {
      if (n >= MAX_TWEAK_SHAPES) break
      const t = TWEAK_ID_RE.test(eid) ? readTweak(tw) : undefined
      if (t) { one[eid] = t; n++ }
    }
    if (n) { out[sid] = one; icons++ }
  }
  return icons ? out : undefined
}

/** The tweaks of one icon in a look ({} when none). */
export function iconTweaks(look: IconLook, slideId: string): Readonly<Record<string, IconShapeTweak>> {
  return look.tweaks?.[slideId] ?? {}
}

/** How many icons a look paints their own way. */
export function tweakedIconCount(look: IconLook): number {
  return Object.keys(look.tweaks ?? {}).length
}

/**
 * Set (or with `undefined`, clear) one shape's tweak in a look; empty maps
 * are removed, so a look without tweaks has no `tweaks` key. Mutates `look`.
 */
export function setTweak(look: IconLook, slideId: string, elementId: string, tweak: IconShapeTweak | undefined): void {
  const all = { ...look.tweaks }
  const one = { ...all[slideId] }
  const clean = readTweak(tweak)
  if (clean) one[elementId] = clean
  else delete one[elementId]
  if (Object.keys(one).length) all[slideId] = one
  else delete all[slideId]
  if (Object.keys(all).length) look.tweaks = all
  else delete look.tweaks
}

/** Clear every tweak of one icon in a look (`slideId`), or of all icons. Mutates `look`. */
export function clearTweaks(look: IconLook, slideId?: string): void {
  if (slideId === undefined) { delete look.tweaks; return }
  if (!look.tweaks?.[slideId]) return
  const all = { ...look.tweaks }
  delete all[slideId]
  if (Object.keys(all).length) look.tweaks = all
  else delete look.tweaks
}

/** The look without what belongs to one set (its tweaks name that set's
 *  icons): what My styles and Copy style keep. */
export function lookRecipe(look: IconLook): IconLook {
  const { tweaks: _tweaks, ...rest } = look
  return structuredClone(rest)
}

/**
 * Untrusted input → a clean look, or a message saying what is wrong. The one
 * gate for the agent's `style` op, a pasted style and "My styles". Only `name`
 * and `stroke.color` are required; everything else falls back or drops.
 */
export function readLook(raw: unknown): IconLook | string {
  if (!raw || typeof raw !== 'object') return 'a style must be an object'
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  if (!name) return 'a style needs a name'
  const st = (r.stroke && typeof r.stroke === 'object' ? r.stroke : {}) as Record<string, unknown>
  const look: IconLook = {
    id: typeof r.id === 'string' && LOOK_ID_RE.test(r.id) ? r.id : uid('look'),
    name,
    stroke: { weight: Math.round(clamp(st.weight, 0.25, 4, 1) * 100) / 100, color: safeColor(st.color, '#000000') },
  }
  const preset = typeof r.preset === 'string' && LOOK_ID_RE.test(r.preset) ? r.preset : undefined
  if (preset) look.preset = preset
  const cap = oneOf(st.cap, ['round', 'square', 'butt'] as const)
  const join = oneOf(st.join, ['round', 'bevel', 'miter'] as const)
  if (cap) look.stroke.cap = cap
  if (join) look.stroke.join = join
  const f = (r.fill && typeof r.fill === 'object' ? r.fill : {}) as Record<string, unknown>
  const fill: NonNullable<IconLook['fill']> = {}
  for (const part of ICON_PARTS) {
    const p = readPaint(f[part])
    if (p) fill[part] = p
  }
  if (Object.keys(fill).length) look.fill = fill
  if (r.knockout === true) look.knockout = true
  if (r.shadow && typeof r.shadow === 'object') {
    const s = r.shadow as Record<string, unknown>
    const shadow: NonNullable<IconLook['shadow']> = { dx: clamp(s.dx, -4, 4, 0.8), dy: clamp(s.dy, -4, 4, 0.8), color: safeColor(s.color, '#000000') }
    if (typeof s.opacity === 'number' && s.opacity < 1) shadow.opacity = clamp(s.opacity, 0.05, 1, 1)
    if (shadow.dx || shadow.dy) look.shadow = shadow
  }
  if (r.halo && typeof r.halo === 'object') {
    const h = r.halo as Record<string, unknown>
    const width = clamp(h.width, 0, 4, 1.5)
    if (width > 0) look.halo = { width, color: safeColor(h.color, '#ffffff') }
  }
  const sketch = clamp(r.sketch, 0, 1, 0)
  if (sketch > 0) look.sketch = Math.round(sketch * 100) / 100
  if (r.tile && typeof r.tile === 'object') {
    const tl = r.tile as Record<string, unknown>
    look.tile = {
      shape: oneOf(tl.shape, ['circle', 'square', 'rounded'] as const) ?? 'circle',
      color: safeColor(tl.color, '#4f46e5'),
      scale: Math.round(clamp(tl.scale, 0.4, 0.9, 0.62) * 100) / 100,
    }
  }
  const tweaks = readTweaks(r.tweaks)
  if (tweaks) look.tweaks = tweaks
  return look
}

/** A look as stored, read for drawing: a broken one draws as a plain outline. */
function usableLook(look: IconLook, ink: string): IconLook {
  const r = readLook(look)
  return typeof r === 'string' ? { id: 'look', name: 'look', stroke: { weight: 1, color: ink } } : r
}

// ---- presets ---------------------------------------------------------------------------

/** A built-in look. `name`/`hint` are English: the UI translates them when shown. */
export interface LookPreset {
  id: string
  name: string
  hint: string
  /** the look for a set whose ink is `ink` */
  make: (ink: string) => Omit<IconLook, 'id' | 'name'>
}

export const LOOK_PRESETS: readonly LookPreset[] = [
  { id: 'outline', name: 'Outline', hint: 'Lines only, in the set ink',
    make: (ink) => ({ stroke: { weight: 1, color: ink } }) },
  { id: 'bold', name: 'Bold', hint: 'Heavier lines for small sizes and dark backgrounds',
    make: (ink) => ({ stroke: { weight: 1.5, color: ink } }) },
  { id: 'light', name: 'Light', hint: 'Thin lines for large sizes',
    make: (ink) => ({ stroke: { weight: 0.6, color: ink } }) },
  { id: 'solid', name: 'Solid', hint: 'Filled silhouettes, details cut out',
    make: (ink) => ({ stroke: { weight: 1, color: ink }, fill: { body: { color: ink } }, knockout: true }) },
  { id: 'duotone', name: 'Duotone', hint: 'Lines over a faint fill',
    make: (ink) => ({ stroke: { weight: 1, color: ink }, fill: { body: { color: ink, opacity: 0.22 }, accent: { color: ink, opacity: 0.55 } } }) },
  { id: 'color', name: 'Color', hint: 'Dark lines, soft color fills and one accent',
    make: () => ({ stroke: { weight: 1, color: '#1e293b' }, fill: { body: { color: '#7dd3fc' }, accent: { color: '#fb923c' } } }) },
  { id: 'comic', name: 'Comic', hint: 'Thick black lines, bright fills and a hard shadow',
    make: () => ({ stroke: { weight: 1.4, color: '#111111', cap: 'round', join: 'round' }, fill: { body: { color: '#ffd23f' }, accent: { color: '#ff4f6d' } }, shadow: { dx: 0.9, dy: 0.9, color: '#111111' } }) },
  { id: 'sticker', name: 'Sticker', hint: 'Color icon with a white die-cut border',
    make: () => ({ stroke: { weight: 1.1, color: '#1f2937', cap: 'round', join: 'round' }, fill: { body: { color: '#a7f3d0' }, accent: { color: '#f472b6' } }, halo: { width: 1.6, color: '#ffffff' }, shadow: { dx: 0, dy: 0.6, color: '#000000', opacity: 0.25 } }) },
  { id: 'sketch', name: 'Sketch', hint: 'Hand-drawn lines with a light wash',
    make: (ink) => ({ stroke: { weight: 0.9, color: ink, cap: 'round', join: 'round' }, fill: { body: { color: ink, opacity: 0.08 } }, sketch: 0.7 }) },
  { id: 'badge', name: 'Badge', hint: 'White icon on a colored circle',
    make: () => ({ stroke: { weight: 1.3, color: '#ffffff' }, fill: { accent: { color: '#fde047' } }, tile: { shape: 'circle', color: '#4f46e5', scale: 0.62 } }) },
]

/** A new look from a preset, for a set inked in `ink`. */
export function lookFromPreset(preset: LookPreset, ink: string, name: string): IconLook {
  return { id: uid('look'), name, preset: preset.id, ...structuredClone(preset.make(ink)) }
}

// ---- hand-drawn wobble -------------------------------------------------------------------

/** mulberry32: a tiny seeded generator, so the same icon wobbles the same way every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** The outline as if drawn by hand: points nudged, straight runs bowed a little. */
export function sketchSegs(segs: readonly Seg[], amount: number, seed: number): Seg[] {
  const r = rng(seed)
  const j = (k = 1) => (r() * 2 - 1) * amount * 0.32 * k
  const out: Seg[] = []
  let cx = 0, cy = 0, sx = 0, sy = 0
  for (const s of segs) {
    if (s[0] === 'M') {
      cx = sx = s[1] + j(); cy = sy = s[2] + j()
      out.push(['M', cx, cy])
    } else if (s[0] === 'L') {
      const tx = s[1] + j(), ty = s[2] + j()
      const dx = tx - cx, dy = ty - cy
      const len = Math.hypot(dx, dy) || 1
      const nx = -dy / len, ny = dx / len
      const bow = Math.min(len * 0.07, 0.7) * amount
      const b1 = (r() * 2 - 1) * bow, b2 = (r() * 2 - 1) * bow
      out.push(['C', cx + dx / 3 + nx * b1, cy + dy / 3 + ny * b1, cx + (2 * dx) / 3 + nx * b2, cy + (2 * dy) / 3 + ny * b2, tx, ty])
      cx = tx; cy = ty
    } else if (s[0] === 'C') {
      const x = s[5] + j(), y = s[6] + j()
      out.push(['C', s[1] + j(0.6), s[2] + j(0.6), s[3] + j(0.6), s[4] + j(0.6), x, y])
      cx = x; cy = y
    } else {
      out.push(['Z'])
      cx = sx; cy = sy
    }
  }
  return out
}

// ---- one icon in one look ----------------------------------------------------------------

/** Is box `a` (grown by `pad`) inside box `b`? */
function inside(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, pad: number): boolean {
  return a.x - pad >= b.x - 1e-6 && a.y - pad >= b.y - 1e-6 && a.x + a.w + pad <= b.x + b.w + 1e-6 && a.y + a.h + pad <= b.y + b.h + 1e-6
}

/**
 * One icon slide in one look → a standalone SVG, `grid` units square. A look
 * that paints in one colour only writes it as `currentColor` (the icon takes
 * the text colour, like the plain export); a colourful one keeps its colours.
 */
export function iconLookSvg(doc: SlidomingoDoc, slide: Slide, lookIn: IconLook, opts: { title?: boolean } = {}): IconSvg {
  const info = iconsetInfo(doc) ?? { grid: 24, scale: doc.size.width / 24, style: ICONSET_STYLE_DEFAULTS }
  const look = usableLook(lookIn, info.style.color)
  const g = info.grid
  const all = iconShapes(doc, slide)
  const skipped = all.skipped
  // parts are guessed on the whole drawing, so hiding a shape in this look
  // does not turn another one into the body
  const allParts = iconParts(all.shapes)
  const tweaks = iconTweaks(look, slide.id)
  const keep = all.shapes.map((s) => !tweaks[s.el.id]?.hide)
  const shapes = all.shapes.filter((_, i) => keep[i])
  const parts = allParts.filter((_, i) => keep[i])
  /** shape i's place in the whole drawing: its wobble stays the same when another is hidden */
  const at = all.shapes.map((_, i) => i).filter((i) => keep[i])
  const tweakOf = (i: number): IconShapeTweak | undefined => tweaks[shapes[i].el.id]
  const ink = look.stroke.color
  const cap = look.stroke.cap ?? info.style.cap
  const join = look.stroke.join ?? info.style.join
  const seed = hashSeed(slide.id)
  for (const s of shapes) {
    if (s.el.shape === 'line' && ((s.el.lineStart && s.el.lineStart !== 'none') || (s.el.lineEnd && s.el.lineEnd !== 'none'))) skipped.add('line-ending')
    if (s.el.type === 'shape' && s.el.fillGradient?.stops.length) skipped.add('gradient')
  }

  // colours are tokens until the end: one colour in the whole icon → currentColor
  const used: string[] = []
  const col = (c: string): string => {
    const v = normColor(safeColor(c))
    let k = used.indexOf(v)
    if (k < 0) { k = used.length; used.push(v) }
    return `\u0000${k}\u0000`
  }

  const sw = (s: IconShape) => s.strokeW * look.stroke.weight
  const dOf = (s: IconShape, i: number, pass: number) =>
    look.sketch ? segsToD(sketchSegs(s.segs, look.sketch, seed + at[i] * 7919 + pass * 104729)) : s.d
  /** What fills shape i: its own tweak, else its part's paint, or, for a
   *  shape drawn filled (a dot), the ink. */
  const paintOf = (i: number): IconPaint | undefined => {
    const s = shapes[i]
    if (s.open) return undefined
    const tw = tweakOf(i)?.fill
    if (tw) return tw === 'none' ? undefined : tw
    return look.fill?.[parts[i]] ?? (s.filled ? { color: ink } : undefined)
  }
  /** The outline colour of shape i: its own tweak, else the look's. */
  const inkOf = (i: number): string => tweakOf(i)?.stroke ?? ink
  const fillRule = (s: IconShape) => (s.el.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '')
  const alpha = (s: IconShape, extra = 1) => {
    const o = s.el.opacity * extra
    return o < 1 ? ` opacity="${n3(Math.max(0, o))}"` : ''
  }

  // knockout: details sitting inside a filled body are cut out of it
  const boxes = shapes.map((s) => segsBBox(s.segs))
  const filledBodies = shapes.map((_, i) => i).filter((i) => parts[i] === 'body' && !!paintOf(i) && boxes[i])
  const cut = new Set<number>()
  if (look.knockout && filledBodies.length) {
    shapes.forEach((_, i) => {
      if (parts[i] === 'body' || !boxes[i]) return
      // inside the body's outer edge (a fold line on the outline counts)
      if (filledBodies.some((b) => inside(boxes[i]!, boxes[b]!, -sw(shapes[b]) / 2))) cut.add(i)
    })
  }

  /** Fills, then strokes, every colour replaced by `over` when given (shadow). */
  const draw = (over?: string): string[] => {
    const out: string[] = []
    const fillsFirst = [...shapes.keys()].sort((a, b) => Number(parts[a] !== 'body') - Number(parts[b] !== 'body'))
    for (const i of fillsFirst) {
      if (cut.has(i) && !over) continue
      const p = paintOf(i)
      if (!p) continue
      const s = shapes[i]
      const op = over ? '' : p.opacity !== undefined && p.opacity < 1 ? ` fill-opacity="${n3(p.opacity)}"` : ''
      out.push(`<path d="${escXml(dOf(s, i, 0))}" fill="${col(over ?? p.color)}"${op}${fillRule(s)}${alpha(s)}/>`)
    }
    shapes.forEach((s, i) => {
      if (!s.strokeW || (cut.has(i) && !over)) return
      const w = sw(s)
      out.push(`<path d="${escXml(dOf(s, i, 0))}" stroke="${col(over ?? inkOf(i))}" stroke-width="${n3(w)}"${alpha(s)}/>`)
      if (look.sketch && !over) out.push(`<path d="${escXml(dOf(s, i, 1))}" stroke="${col(inkOf(i))}" stroke-width="${n3(w * 0.55)}"${alpha(s, 0.7)}/>`)
    })
    return out
  }

  const layers: string[] = []
  if (look.halo) {
    const hw = look.halo.width
    const c = col(look.halo.color)
    shapes.forEach((s, i) => {
      const w = (s.strokeW ? sw(s) : 0) + hw * 2
      layers.push(`<path d="${escXml(dOf(s, i, 0))}" stroke="${c}" stroke-width="${n3(w)}"${s.open ? '' : ` fill="${c}"`}${fillRule(s)}/>`)
    })
  }
  if (look.shadow) {
    const o = look.shadow.opacity !== undefined && look.shadow.opacity < 1 ? ` opacity="${n3(look.shadow.opacity)}"` : ''
    layers.push(`<g transform="translate(${n3(look.shadow.dx)} ${n3(look.shadow.dy)})"${o}>${draw(look.shadow.color).join('')}</g>`)
  }
  if (cut.size) {
    const holes = [...cut].map((i) => {
      const s = shapes[i]
      const fill = paintOf(i) ? ' fill="#000"' : ''
      const stroke = s.strokeW ? ` stroke="#000" stroke-width="${n3(sw(s))}"` : ''
      return `<path d="${escXml(dOf(s, i, 0))}"${fill}${stroke}${fillRule(s)}/>`
    }).join('')
    // unique per icon and look: two of these inlined in one page must not share a mask
    const mid = `ko-${(hashSeed(`${slide.id}|${look.id}`) % 0xffffff).toString(36)}`
    layers.push(`<mask id="${mid}" maskUnits="userSpaceOnUse" x="${-g}" y="${-g}" width="${3 * g}" height="${3 * g}">` +
      `<rect x="${-g}" y="${-g}" width="${3 * g}" height="${3 * g}" fill="#fff"/>${holes}</mask>`)
    layers.push(`<g mask="url(#${mid})">${draw().join('')}</g>`)
  } else {
    layers.push(...draw())
  }

  let body = `<g fill="none" stroke-linecap="${escXml(cap)}" stroke-linejoin="${escXml(join)}">${layers.join('')}</g>`
  if (look.tile) {
    const t = look.tile
    const c = g / 2
    const k = t.scale ?? 0.62
    const bg = t.shape === 'circle' ? `<circle cx="${n3(c)}" cy="${n3(c)}" r="${n3(c)}" fill="${col(t.color)}"/>`
      : `<rect width="${n3(g)}" height="${n3(g)}" rx="${t.shape === 'rounded' ? n3(g * 0.22) : '0'}" fill="${col(t.color)}"/>`
    body = `${bg}<g transform="translate(${n3(c)} ${n3(c)}) scale(${n3(k)}) translate(${n3(-c)} ${n3(-c)})">${body}</g>`
  }
  const mono = used.length === 1
  const finalBody = body.replace(/\u0000(\d+)\u0000/g, (_, k) => (mono ? 'currentColor' : escXml(used[Number(k)])))
  const gs = n3(g)
  const title = opts.title && slide.name ? `<title>${escXml(slide.name)}</title>` : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${gs}" height="${gs}" viewBox="0 0 ${gs} ${gs}">${title}${finalBody}</svg>\n`
  return { svg, skipped: [...skipped] }
}

// ---- learning a look ---------------------------------------------------------------------

function mode<T>(xs: readonly T[]): T | undefined {
  const n = new Map<T, number>()
  let best: T | undefined, bestN = 0
  for (const x of xs) {
    const c = (n.get(x) ?? 0) + 1
    n.set(x, c)
    if (c > bestN) { best = x; bestN = c }
  }
  return best
}

function median(xs: readonly number[]): number | undefined {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const r2 = (v: number) => Math.round(v * 100) / 100

/** A look read off an icon someone painted by hand: its stroke, and the fill each part has. */
export function learnLookFromIcon(doc: SlidomingoDoc, slide: Slide): Omit<IconLook, 'id' | 'name'> | null {
  const info = iconsetInfo(doc)
  if (!info) return null
  const { shapes } = iconShapes(doc, slide)
  if (!shapes.length) return null
  const parts = iconParts(shapes)
  const stroked = shapes.filter((s) => s.strokeW > 0)
  const color = mode(stroked.map((s) => normColor(s.strokeColor))) ?? info.style.color
  const w = median(stroked.map((s) => s.strokeW)) ?? info.style.strokeWidth
  const look: Omit<IconLook, 'id' | 'name'> = {
    stroke: { weight: r2(Math.min(4, Math.max(0.25, w / (info.style.strokeWidth || 1)))), color },
  }
  const cap = mode(stroked.map((s) => s.el.strokeCap).filter((c): c is NonNullable<typeof c> => !!c))
  const join = mode(stroked.map((s) => s.el.strokeJoin).filter((c): c is NonNullable<typeof c> => !!c))
  if (cap) look.stroke.cap = cap
  if (join) look.stroke.join = join
  const fill: NonNullable<IconLook['fill']> = {}
  for (const part of ICON_PARTS) {
    // a dot in the ink is linework, not a fill choice
    const fills = shapes.filter((s, i) => parts[i] === part && !s.open && s.filled && !(s.strokeW === 0 && normColor(s.el.fill) === color && part !== 'body'))
    const c = mode(fills.map((s) => normColor(s.el.fill)))
    if (!c) continue
    const op = median(fills.filter((s) => normColor(s.el.fill) === c).map((s) => s.el.opacity)) ?? 1
    fill[part] = op < 1 ? { color: c, opacity: r2(op) } : { color: c }
  }
  if (Object.keys(fill).length) look.fill = fill
  // a filled body with the ink and details on top in another colour reads as solid
  if (fill.body && normColor(fill.body.color) === color && (fill.body.opacity ?? 1) === 1) look.knockout = true
  return look
}

/** One painted element of someone else's SVG icon, as the editor read it. */
export interface SvgPaintStat {
  /** null = not stroked */
  stroke: string | null
  /** stroke width in OUR grid units (already scaled from the file's viewBox) */
  strokeWidth: number
  /** null = not filled */
  fill: string | null
  opacity: number
  cap?: string
  join?: string
}

/**
 * A look read off other people's icons (one or several SVG files): the usual
 * stroke weight, colour, caps and joins; fills ranked by how often they occur
 * (most → body, next → accent). `currentColor` stands for `ink`.
 */
export function learnLookFromSvgStats(stats: readonly SvgPaintStat[], base: IconsetStyle, ink: string): Omit<IconLook, 'id' | 'name'> | null {
  if (!stats.length) return null
  const norm = (c: string) => (c.trim().toLowerCase() === 'currentcolor' ? normColor(ink) : normColor(c))
  const stroked = stats.filter((s) => s.stroke && !isNoPaint(s.stroke) && s.strokeWidth > 0)
  const color = mode(stroked.map((s) => norm(s.stroke!))) ?? mode(stats.filter((s) => s.fill).map((s) => norm(s.fill!))) ?? normColor(ink)
  const w = median(stroked.map((s) => s.strokeWidth))
  const look: Omit<IconLook, 'id' | 'name'> = {
    stroke: { weight: r2(Math.min(4, Math.max(0.25, (w ?? base.strokeWidth) / (base.strokeWidth || 1)))), color: safeColor(color) },
  }
  const cap = oneOf(mode(stroked.map((s) => s.cap).filter(Boolean)), ['round', 'square', 'butt'] as const)
  const join = oneOf(mode(stroked.map((s) => s.join).filter(Boolean)), ['round', 'bevel', 'miter'] as const)
  if (cap) look.stroke.cap = cap
  if (join) look.stroke.join = join
  const fills = stats.filter((s) => s.fill && !isNoPaint(s.fill))
  if (!stroked.length && fills.length) {
    // a filled icon family (no strokes at all): solid
    look.fill = { body: { color: safeColor(color) } }
    look.knockout = true
    return look
  }
  const ranked = new Map<string, { n: number; op: number[] }>()
  for (const s of fills) {
    const c = norm(s.fill!)
    if (c === normColor(color) && s.opacity >= 1) continue // ink-coloured dots are linework
    const e = ranked.get(c) ?? { n: 0, op: [] }
    e.n++
    e.op.push(s.opacity)
    ranked.set(c, e)
  }
  const order = [...ranked.entries()].sort((a, b) => b[1].n - a[1].n)
  const paint = (e: [string, { n: number; op: number[] }]): IconPaint => {
    const op = median(e[1].op) ?? 1
    return op < 1 ? { color: safeColor(e[0]), opacity: r2(op) } : { color: safeColor(e[0]) }
  }
  if (order[0]) look.fill = { body: paint(order[0]) }
  if (order[1]) look.fill = { ...look.fill, accent: paint(order[1]) }
  return look
}
