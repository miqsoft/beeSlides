// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Slide → HTML: the way back of htmlslide.ts, so an agent can change a slide
// the way it was made — edit the HTML, write it again.
//
// THREE LEVELS, safest last:
//   1. remembered: the slide still has the fingerprint the last slide_html
//      write left (`Slide.htmlSource.sig`) → the author's own HTML, verbatim.
//   2. inferred: boxes that hold other elements become nested <div>s, runs
//      of equal-height items side by side become flex rows, stacks become
//      flex columns, rows of rows become a grid of rows.
//   3. absolute: whatever is not provably a row or column keeps its exact
//      position (`position:absolute`). CSS mixes both, so every slide can be
//      written.
// Level 2 is never trusted: the generated HTML is compiled again
// (compileSlideHtml) and every element's frame compared with the slide's.
// A group or nesting that moves anything by more than VERIFY_TOL is taken
// apart and the HTML generated again, until it reproduces the slide.
import type { ChartElement, CodeElement, ImageElement, ShapeElement, Slide, SlideElement, SlidomingoDoc, TableElement, TextElement } from './model'
import { tableLayout } from './tablespans'
import { htmlSignature, type CompileResult, type HtmlSlideSource } from './htmlslide'

export interface SlideAsHtml extends HtmlSlideSource {
  source: 'remembered' | 'generated'
  /** flex rows/columns in the generated HTML (0 for remembered) */
  flowGroups: number
  notes: string[]
}

/** px an element may move between the slide and its HTML laid out again. */
export const VERIFY_TOL = 1
const ATTEMPTS = 5

type Compile = (slide: Slide, src: HtmlSlideSource) => Promise<CompileResult>

export async function slideToHtml(doc: SlidomingoDoc, slide: Slide, size: { width: number; height: number }, compile: Compile): Promise<SlideAsHtml> {
  const src = slide.htmlSource
  if (src && src.sig === htmlSignature(slide.elements, slide.background)) {
    return { html: src.html, ...(src.css ? { css: src.css } : {}), source: 'remembered', flowGroups: 0, notes: [] }
  }
  const flatten = new Set<string>()
  let last: { out: Emitted; bad: Mismatch[] } | null = null
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const allAbsolute = attempt === ATTEMPTS - 1
    const tree = planTree(doc, slide, size, flatten, allAbsolute)
    const out = emit(doc, slide, size, tree)
    const compiled = await compile(slide, { html: out.html, css: out.css })
    const bad = verify(slide, compiled.elements)
    last = { out, bad }
    if (!bad.length) return { html: out.html, css: out.css, source: 'generated', flowGroups: out.groups, notes: out.notes }
    let blamed = false
    for (const m of bad) for (const k of tree.blame.get(m.id) ?? []) if (!flatten.has(k)) { flatten.add(k); blamed = true }
    if (!blamed && !allAbsolute) attempt = ATTEMPTS - 2 // nothing left to take apart: go straight to all-absolute
  }
  const { out, bad } = last!
  return {
    html: out.html, css: out.css, source: 'generated', flowGroups: out.groups,
    notes: [...out.notes, `Laid out again, ${bad.length} element(s) land differently: ${bad.slice(0, 6).map((b) => `${b.id} (${b.why})`).join('; ')}. Writing this back moves them that much.`],
  }
}

// ---- what each element can be in HTML ---------------------------------------------

type Kind = 'text' | 'box' | 'img' | 'table' | 'chart' | 'code' | 'keep'

const visible = (c: string | undefined) => !!c && c !== 'transparent' && c !== 'none' && !/^rgba\([^)]*,\s*0\)$/.test(c) && !/^#[0-9a-f]{6}00$/i.test(c)
const plainText = (html: string) => html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')

function kindOf(el: SlideElement): Kind {
  if (el.hidden) return 'keep'
  switch (el.type) {
    case 'text': {
      const t = el as TextElement
      if (!plainText(t.html ?? '').trim()) return 'keep'
      return 'text'
    }
    case 'shape': {
      const s = el as ShapeElement
      if (s.shape !== 'rect' && s.shape !== 'ellipse') return 'keep'
      if (s.strokeDash && !s.strokeStyle) return 'keep'
      const paints = visible(s.fill) || !!s.fillGradient?.stops?.length || (visible(s.stroke) && s.strokeWidth > 0) || !!s.shadow
      return paints ? 'box' : 'keep'
    }
    case 'image': return (el as ImageElement).src ? 'img' : 'keep'
    case 'table': return 'table'
    case 'chart': return 'chart'
    case 'code': return 'code'
    default: return 'keep'
  }
}

interface F { x: number; y: number; w: number; h: number }

interface Node {
  el: SlideElement
  kind: Kind
  /** a box's own text (`<id>-text` inside it): one div with padding */
  text?: TextElement
  children: Item[]
}
interface Group { group: 'row' | 'column'; items: Item[]; key: string }
type Item = Node | Group
const isGroup = (i: Item): i is Group => 'group' in i

interface Tree {
  root: Item[]
  /** element id → the parent/group keys to take apart when it lands wrong */
  blame: Map<string, string[]>
}

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol
const frameOf = (e: SlideElement): F => ({ x: e.x, y: e.y, w: e.w, h: e.h })
const inside = (c: F, p: F) => c.x >= p.x - 0.5 && c.y >= p.y - 0.5 && c.x + c.w <= p.x + p.w + 0.5 && c.y + c.h <= p.y + p.h + 0.5

function itemFrame(i: Item): F {
  if (!isGroup(i)) return frameOf(i.el)
  const fs = i.items.map(itemFrame)
  const x = Math.min(...fs.map((f) => f.x)), y = Math.min(...fs.map((f) => f.y))
  return { x, y, w: Math.max(...fs.map((f) => f.x + f.w)) - x, h: Math.max(...fs.map((f) => f.y + f.h)) - y }
}
const firstId = (i: Item): string => (isGroup(i) ? firstId(i.items[0]) : i.el.id)

function planTree(_doc: SlidomingoDoc, slide: Slide, size: { width: number; height: number }, flatten: ReadonlySet<string>, allAbsolute: boolean): Tree {
  const els = slide.elements
  const nodes: Node[] = []
  const paired = new Set<string>()
  // a box and its own text (the shape + `<id>-text` a box with text compiles to)
  for (let i = 0; i < els.length; i++) {
    const e = els[i]
    if (paired.has(e.id)) continue
    const node: Node = { el: e, kind: kindOf(e), children: [] }
    const t = els[i + 1]
    if (!allAbsolute && node.kind === 'box' && t && t.id === `${e.id}-text` && kindOf(t) === 'text' && t.rotation === e.rotation && !(t as TextElement).colorGradient
      && inside(frameOf(t), frameOf(e)) && padding(e as ShapeElement, t).every((p) => p >= -0.01) && !flatten.has(`pair:${e.id}`)) {
      node.text = t as TextElement
      paired.add(t.id)
    }
    nodes.push(node)
  }
  const blame = new Map<string, string[]>()
  const addBlame = (id: string, key: string) => blame.set(id, [...(blame.get(id) ?? []), key])
  for (const n of nodes) if (n.text) { addBlame(n.el.id, `pair:${n.el.id}`); addBlame(n.text.id, `pair:${n.el.id}`) }
  // nesting: each node goes into the smallest earlier box that holds it
  const slideArea = size.width * size.height
  const canParent = (n: Node) => !allAbsolute && n.kind === 'box' && !n.text && !n.el.rotation && (n.el.opacity ?? 1) >= 1
    && n.el.w * n.el.h < slideArea * 0.9 && !flatten.has(`p:${n.el.id}`)
  const parentOf = new Map<Node, Node>()
  nodes.forEach((n, i) => {
    let best: Node | null = null
    for (let j = 0; j < i; j++) {
      const p = nodes[j]
      if (!canParent(p) || !inside(frameOf(n.el), frameOf(p.el))) continue
      if (!best || p.el.w * p.el.h <= best.el.w * best.el.h) best = p
    }
    if (best) parentOf.set(n, best)
  })
  const top: Node[] = []
  for (const n of nodes) {
    const p = parentOf.get(n)
    if (p) p.children.push(n)
    else top.push(n)
  }
  // every element answers for the boxes around it
  const chain = (n: Node): string[] => { const out: string[] = []; for (let p = parentOf.get(n); p; p = parentOf.get(p)) out.push(`p:${p.el.id}`); return out }
  for (const n of nodes) for (const k of chain(n)) { addBlame(n.el.id, k); if (n.text) addBlame(n.text.id, k) }

  const group = (items: Item[]): Item[] => (allAbsolute ? items : gridOf(flows(items, flatten), flatten))
  const finish = (items: Item[]): Item[] => {
    for (const i of items) if (!isGroup(i)) i.children = finish(i.children)
    const out = group(items)
    const note = (i: Item, keys: string[]) => {
      if (isGroup(i)) { for (const c of i.items) note(c, [...keys, i.key]); return }
      for (const k of keys) { addBlame(i.el.id, k); if (i.text) addBlame(i.text.id, k) }
      const all = (m: Node): Node[] => [m, ...m.children.flatMap((c) => (isGroup(c) ? flatItems(c) : all(c)))]
      for (const m of all(i).slice(1)) for (const k of keys) { addBlame(m.el.id, k); if (m.text) addBlame(m.text.id, k) }
    }
    for (const i of out) note(i, [])
    return out
  }
  return { root: finish(top), blame }
}

function flatItems(g: Group): Node[] {
  return g.items.flatMap((i) => (isGroup(i) ? flatItems(i) : [i, ...i.children.flatMap((c) => (isGroup(c) ? flatItems(c) : [c]))]))
}

/** Runs of consecutive items (paint order kept) that sit in a row — same top,
 *  same height, left to right — or a column — same left, same width, top to
 *  bottom. At least two items each. */
function flows(items: Item[], flatten: ReadonlySet<string>): Item[] {
  const out: Item[] = []
  let i = 0
  const flowable = (it: Item) => !isGroup(it) && !it.el.rotation
  while (i < items.length) {
    let best: Group | null = null
    for (const dir of ['row', 'column'] as const) {
      let j = i + 1
      while (j < items.length && flowable(items[j - 1]) && flowable(items[j])) {
        const a = frameOf((items[j - 1] as Node).el), b = frameOf((items[j] as Node).el)
        const ok = dir === 'row'
          ? near(a.y, b.y) && near(a.h, b.h) && b.x >= a.x + a.w - 0.01
          : near(a.x, b.x) && near(a.w, b.w) && b.y >= a.y + a.h - 0.01
        if (!ok) break
        j++
      }
      if (j - i >= 2 && (!best || j - i > best.items.length)) {
        const key = `${dir}:${firstId(items[i])}`
        if (!flatten.has(key)) best = { group: dir, items: items.slice(i, j), key }
      }
    }
    if (best) { out.push(best); i += best.items.length }
    else { out.push(items[i]); i++ }
  }
  return out
}

/** Consecutive rows with the same left edge, width and item count, one under
 *  the other: a grid, written as a column of rows. */
function gridOf(items: Item[], flatten: ReadonlySet<string>): Item[] {
  const out: Item[] = []
  let i = 0
  while (i < items.length) {
    let j = i + 1
    const a0 = items[i]
    if (isGroup(a0) && a0.group === 'row') {
      while (j < items.length) {
        const prev = items[j - 1], cur = items[j]
        if (!isGroup(cur) || cur.group !== 'row' || !isGroup(prev) || cur.items.length !== a0.items.length) break
        const pf = itemFrame(prev), cf = itemFrame(cur)
        if (!near(pf.x, cf.x) || !near(pf.w, cf.w) || cf.y < pf.y + pf.h - 0.01) break
        j++
      }
    }
    const key = `grid:${firstId(a0)}`
    if (j - i >= 2 && !flatten.has(key)) { out.push({ group: 'column', items: items.slice(i, j), key }); i = j }
    else { out.push(a0); i++ }
  }
  return out
}

// ---- emitting ----------------------------------------------------------------------

interface Emitted { html: string; css: string; groups: number; notes: string[] }

const n2 = (v: number) => `${Math.round(v * 100) / 100}`
const pxv = (v: number) => `${n2(v)}px`
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function padding(s: ShapeElement, t: SlideElement): [number, number, number, number] {
  const b = s.strokeWidth && visible(s.stroke) ? s.strokeWidth : 0
  return [t.y - s.y - b, s.x + s.w - (t.x + t.w) - b, s.y + s.h - (t.y + t.h) - b, t.x - s.x - b]
}

function shadowCss(sh: SlideElement['shadow']): string {
  if (!sh) return ''
  const list = Array.isArray(sh) ? sh : [sh]
  return list.map((s) => `${pxv(s.x ?? 0)} ${pxv(s.y ?? 0)} ${pxv(s.blur ?? 0)} ${s.color}`).join(', ')
}

function gradientCss(g: NonNullable<ShapeElement['fillGradient']>): string {
  return `linear-gradient(${n2(g.angle)}deg, ${g.stops.map((s) => `${s.color} ${n2(s.at * 100)}%`).join(', ')})`
}

function textStyle(t: TextElement | CodeElement): string[] {
  const out = [`font-size:${pxv(t.fontSize)}`]
  if (t.fontFamily) out.push(`font-family:${t.fontFamily}`)
  if (t.type === 'text') out.push(`font-weight:${t.fontWeight}`)
  out.push(`color:${t.color}`, `line-height:${n2(t.lineHeight)}`)
  if (t.align !== 'left') out.push(`text-align:${t.align}`)
  if (t.type === 'text' && t.letterSpacing) out.push(`letter-spacing:${pxv(t.letterSpacing)}`)
  if (t.type === 'text' && t.shadow) out.push(`text-shadow:${shadowCss(t.shadow)}`)
  if (t.type === 'text' && t.textStroke?.width) out.push(`-webkit-text-stroke:${pxv(t.textStroke.width)} ${t.textStroke.color}`, ...(t.textStroke.fill === 'none' ? ['-webkit-text-fill-color:transparent'] : []))
  if (t.type === 'text' && t.colorGradient?.stops?.length) out.push(`background-image:${gradientCss(t.colorGradient)}`, '-webkit-background-clip:text', 'background-clip:text', '-webkit-text-fill-color:transparent')
  return out
}

function boxStyle(s: ShapeElement): string[] {
  const out: string[] = []
  if (visible(s.fill)) out.push(`background-color:${s.fill}`)
  if (s.fillGradient?.stops?.length) out.push(`background-image:${gradientCss(s.fillGradient)}`)
  if (visible(s.stroke) && s.strokeWidth > 0) out.push(`border:${pxv(s.strokeWidth)} ${s.strokeStyle && s.strokeStyle !== 'solid' ? s.strokeStyle : 'solid'} ${s.stroke}`)
  if (s.shape === 'ellipse') out.push('border-radius:50%')
  else if (s.radius) out.push(`border-radius:${pxv(s.radius)}`)
  if (s.shadow) out.push(`box-shadow:${shadowCss(s.shadow)}`)
  return out
}


function emit(doc: SlidomingoDoc, slide: Slide, size: { width: number; height: number }, tree: Tree): Emitted {
  const css: string[] = [
    `body{background:${slide.background || doc.theme.background}}`,
    'h1,h2,h3,h4,h5,h6,p{margin:0}',
  ]
  const notes: string[] = []
  let groups = 0
  const keeps: string[] = []
  const root: F = { x: 0, y: 0, w: size.width, h: size.height }

  const absolute = (f: F, parent: F, border: number) => [`position:absolute`, `left:${pxv(f.x - parent.x - border)}`, `top:${pxv(f.y - parent.y - border)}`]
  // `omit`: the main-axis size of an item sharing a flex run (flex:1 sets it)
  let omit: 'w' | 'h' | null = null
  const sizeOf = (f: F) => [...(omit === 'w' ? ['flex:1 1 0'] : [`width:${pxv(f.w)}`]), ...(omit === 'h' ? ['flex:1 1 0'] : [`height:${pxv(f.h)}`])]
  const common = (e: SlideElement) => [
    ...((e.opacity ?? 1) < 1 ? [`opacity:${n2(e.opacity)}`] : []),
    ...(e.rotation ? [`transform:rotate(${n2(e.rotation)}deg)`] : []),
    ...(e.blur ? [`filter:blur(${pxv(e.blur)})`] : []),
    ...(e.backdropFilter ? [`backdrop-filter:blur(${pxv(e.backdropFilter)})`] : []),
    ...(e.blend && /^[a-z-]+$/.test(e.blend) ? [`mix-blend-mode:${e.blend}`] : []),
  ]

  const node = (n: Node, pos: string[], indent: string, flexMain: 'w' | 'h' | null = null): string => {
    omit = flexMain
    const e = n.el
    const own = sizeOf(frameOf(e))
    omit = null
    const id = attr(e.id)
    const role = (e as { role?: string }).role
    const roleAttr = role && !(role === 'title' && e.type === 'text') ? ` data-role="${attr(role)}"` : ''
    const st = (parts: string[]) => ` style="${attr(parts.join(';'))}"`
    switch (n.kind) {
      case 'keep': {
        keeps.push(e.id)
        const what = e.type === 'shape' ? `shape ${(e as ShapeElement).shape}` : e.type
        const label = (e as { alt?: string }).alt ?? (e.type === 'text' ? plainText((e as TextElement).html ?? '').trim().slice(0, 40) : '')
        return `${indent}<div id="${id}" data-keep data-type="${attr(what)}"${label ? ` title="${attr(label)}"` : ''}${st([...pos, ...own, ...common(e)])}></div>`
      }
      case 'text': {
        const t = e as TextElement
        const tag = role === 'title' ? 'h1' : 'div'
        const valign = t.valign !== 'top' ? ` data-valign="${t.valign}"` : ''
        return `${indent}<${tag} id="${id}"${roleAttr}${valign}${st([...pos, ...own, ...textStyle(t), ...common(e)])}>${t.html}</${tag}>`
      }
      case 'box': {
        const s = e as ShapeElement
        if (n.text) {
          const t = n.text
          const [pt, pr, pb, pl] = padding(s, t)
          const valign = t.valign !== 'top' ? ` data-valign="${t.valign}"` : ''
          const parts = [...pos, ...own, ...boxStyle(s), `padding:${pxv(pt)} ${pxv(pr)} ${pxv(pb)} ${pxv(pl)}`, ...textStyle(t), ...common(e)]
          const tRole = t.role ? ` data-role="${attr(t.role)}"` : ''
          return `${indent}<div id="${id}"${roleAttr}${tRole}${valign}${st(parts)}>${t.html}</div>`
        }
        const b = visible(s.stroke) && s.strokeWidth > 0 ? s.strokeWidth : 0
        const kids = items(n.children, frameOf(e), b, `${indent}  `)
        const parts = [...pos, ...own, ...boxStyle(s), ...common(e)]
        return kids
          ? `${indent}<div id="${id}"${roleAttr}${st(parts)}>\n${kids}\n${indent}</div>`
          : `${indent}<div id="${id}"${roleAttr}${st(parts)}></div>`
      }
      case 'img': {
        const im = e as ImageElement
        const src = im.src.startsWith('asset:') ? im.src : `element:${e.id}`
        const parts = [...pos, ...own, `object-fit:${im.fit}`, ...(im.radius ? [`border-radius:${pxv(im.radius)}`] : []), ...(im.shadow ? [`box-shadow:${shadowCss(im.shadow)}`] : []), ...common(e)]
        return `${indent}<img id="${id}"${roleAttr} src="${attr(src)}"${im.alt !== undefined ? ` alt="${attr(im.alt)}"` : ''}${st(parts)}>`
      }
      case 'chart': {
        const c = e as ChartElement
        const spec = JSON.stringify({ ...(c.preset ? { preset: c.preset } : {}), option: c.option })
        return `${indent}<div id="${id}"${roleAttr} data-chart="${attr(spec)}"${c.alt !== undefined ? ` aria-label="${attr(c.alt)}"` : ''}${st([...pos, ...own, ...common(e)])}></div>`
      }
      case 'code': {
        const c = e as CodeElement
        const parts = [...pos, ...own, 'margin:0', 'white-space:pre', 'overflow:hidden', ...textStyle(c), ...(c.fontFamily ? [] : ['font-family:ui-monospace,Menlo,monospace']), ...common(e)]
        return `${indent}<pre id="${id}"${roleAttr}${st(parts)}>${esc(c.content)}</pre>`
      }
      case 'table': return table(e as TableElement, [...pos, ...own], indent)
    }
  }

  const table = (t: TableElement, pos: string[], indent: string): string => {
    const id = attr(t.id)
    const sel = `#${cssIdent(t.id)}`
    const s = t.style
    css.push(
      `${sel}{border-collapse:collapse;table-layout:fixed;font-size:${pxv(s.fontSize)};color:${s.color}${s.fontFamily ? `;font-family:${s.fontFamily}` : ''}${s.radius ? `;border-radius:${pxv(s.radius)}` : ''}}`,
      `${sel} th,${sel} td{padding:${pxv(s.cellPadY)} ${pxv(s.cellPadX)};text-align:left;font-weight:400${s.borderWidth ? `;border-bottom:${pxv(s.borderWidth)} solid ${s.borderColor}` : ''}}`,
      ...(t.header ? [`${sel} thead th{background:${s.headerBg};color:${s.headerColor};font-weight:700}`] : []),
      ...(s.zebra ? [`${sel} tbody tr:nth-child(even) td{background:${s.zebra}}`] : []),
    )
    const L = tableLayout(t)
    const total = t.columns.reduce((a, c) => a + (c.w || 0), 0) || 1
    const cols = t.columns.map((c) => `<col style="width:${n2(((c.w || 0) / total) * 100)}%">`).join('')
    const row = (r: number, cellTag: string) => {
      const cells = t.rows[r].cells.map((cell, c) => {
        const span = L.span[r]?.[c]
        if (!span) return ''
        const st: string[] = []
        if (cell.align && cell.align !== 'left') st.push(`text-align:${cell.align}`)
        if (cell.color) st.push(`color:${cell.color}`)
        if (cell.bg) st.push(`background:${cell.bg}`)
        if (cell.bold) st.push('font-weight:700')
        return `<${cellTag}${span.cs > 1 ? ` colspan="${span.cs}"` : ''}${span.rs > 1 ? ` rowspan="${span.rs}"` : ''}${st.length ? ` style="${attr(st.join(';'))}"` : ''}>${cell.html}</${cellTag}>`
      }).join('')
      return `${indent}    <tr>${cells}</tr>`
    }
    const head = t.header && t.rows.length ? `${indent}  <thead>\n${row(0, 'th')}\n${indent}  </thead>\n` : ''
    const body = t.rows.map((_, r) => r).filter((r) => !(t.header && r === 0)).map((r) => row(r, 'td')).join('\n')
    return `${indent}<table id="${id}" style="${attr([...pos, ...common(t)].join(';'))}">\n${indent}  <colgroup>${cols}</colgroup>\n${head}${indent}  <tbody>\n${body}\n${indent}  </tbody>\n${indent}</table>`
  }

  const items = (list: Item[], parent: F, border: number, indent: string): string => list.map((it) => {
    if (!isGroup(it)) return node(it, absolute(frameOf(it.el), parent, border), indent)
    return group(it, absolute(itemFrame(it), parent, border), indent)
  }).join('\n')

  // a flex row/column: items in flow, each spaced from the one before; items
  // of equal size share the run (flex:1) instead of carrying a width
  const group = (g: Group, pos: string[], indent: string, flexMain: 'w' | 'h' | null = null): string => {
    groups++
    const row = g.group === 'row'
    const f = itemFrame(g)
    const fs = g.items.map(itemFrame)
    const gaps = fs.slice(1).map((x, k) => (row ? x.x - (fs[k].x + fs[k].w) : x.y - (fs[k].y + fs[k].h)))
    const even = gaps.every((v) => near(v, gaps[0]))
    const equal = fs.every((x) => near(row ? x.w : x.h, row ? fs[0].w : fs[0].h, 0.25))
    const share = even && equal ? (row ? 'w' : 'h') : null
    omit = flexMain
    const head = [...pos, ...sizeOf(f), 'display:flex', ...(row ? [] : ['flex-direction:column']), 'align-items:flex-start', ...(even && gaps[0] ? [`gap:${pxv(gaps[0])}`] : [])]
    omit = null
    const inner = g.items.map((it, k) => {
      const flow = ['position:relative', ...(share ? [] : ['flex:none']), ...(!even && k > 0 ? [`margin-${row ? 'left' : 'top'}:${pxv(gaps[k - 1])}`] : [])]
      return isGroup(it) ? group(it, flow, `${indent}  `, share) : node(it, flow, `${indent}  `, share)
    }).join('\n')
    return `${indent}<div${st(head)}>\n${inner}\n${indent}</div>`
  }
  const st = (parts: string[]) => ` style="${attr(parts.join(';'))}"`

  const html = items(tree.root, root, 0, '')
  if (keeps.length) notes.push(`${keeps.length} element(s) HTML cannot show stay as <div data-keep> placeholders: ${keeps.slice(0, 12).join(', ')}${keeps.length > 12 ? ', …' : ''}.`)
  return { html, css: css.join('\n'), groups, notes }
}

const cssIdent = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `).replace(/^(\d)/, '\\3$1 ')

// ---- verification -----------------------------------------------------------------

interface Mismatch { id: string; why: string }

/** What a text says, entities decoded, white space collapsed. */
function textOf(html: string): string {
  const t = document.createElement('template')
  t.innerHTML = html.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(div|p|li)>/gi, ' ')
  return (t.content.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function verify(slide: Slide, compiled: readonly SlideElement[]): Mismatch[] {
  const out: Mismatch[] = []
  const byId = new Map(compiled.map((e, i) => [e.id, { e, i }]))
  for (const e of slide.elements) {
    const got = byId.get(e.id)
    if (!got) { out.push({ id: e.id, why: 'missing' }); continue }
    const c = got.e
    if (c.type !== e.type) { out.push({ id: e.id, why: `became ${c.type}` }); continue }
    const d = Math.max(Math.abs(c.x - e.x), Math.abs(c.y - e.y), Math.abs(c.w - e.w), Math.abs(c.h - e.h))
    if (d > VERIFY_TOL) { out.push({ id: e.id, why: `${n2(d)}px off` }); continue }
    if (Math.abs((c.rotation ?? 0) - (e.rotation ?? 0)) > 0.1) { out.push({ id: e.id, why: 'rotation' }); continue }
    if (e.type === 'text' && c.type === 'text' && textOf(c.html) !== textOf(e.html)) out.push({ id: e.id, why: 'text differs' })
  }
  // paint order of everything that overlaps
  const order = slide.elements.map((e) => ({ e, i: byId.get(e.id)?.i ?? -1 }))
  for (let a = 0; a < order.length; a++) {
    for (let b = a + 1; b < order.length; b++) {
      const A = order[a], B = order[b]
      if (A.i < 0 || B.i < 0 || A.i < B.i) continue
      const fa = frameOf(A.e), fb = frameOf(B.e)
      const overlap = fa.x < fb.x + fb.w && fb.x < fa.x + fa.w && fa.y < fb.y + fb.h && fb.y < fa.y + fa.h
      if (overlap) out.push({ id: B.e.id, why: `now behind ${A.e.id}` })
    }
  }
  return out
}
