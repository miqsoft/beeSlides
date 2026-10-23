// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Slide elements → DrawingML, the other direction of shapes.ts / text.ts /
// table.ts / media.ts. One builder, two spellings of the same shapes:
//
//   'canvas'  the clipboard's GVML drawing (gvml.ts): every node in the a:
//             namespace inside an lc:lockedCanvas group, text in a:txSp —
//             what PowerPoint itself puts on the clipboard, and pastes back
//             as native shapes
//   'slide'   a slide's p:spTree (p:sp, p:pic, p:graphicFrame, p:grpSp) —
//             the .pptx spelling, which the importer reads back (the rig's
//             round trip) and a .pptx export can build on
//
// What becomes native: rect/ellipse/triangle/arrow/line/path shapes (fill,
// gradient, outline, dash, line tips, rotation, flips, the first shadow,
// opacity), text (paragraphs, lists, bold/italic/underline/strike, colour and
// size runs, links, line spacing, tracking), pictures (crop, cover/contain)
// and tables (fills, borders, padding, merged cells). Elements sharing a
// `groupId` become a group. Anything else (charts, svg artwork, equations,
// code, media) arrives as a `picture` the caller has already drawn.
//
// No DOM: rich text is the sanitizer's small, well-formed allowlist
// (render.ts sanitizeHtml), read by a tokenizer here, so the rig runs in
// Node. Fields ({{page}}) and $math$ must be resolved by the caller.
// Units: slide px × `emuPerPx` (9525 = 96 dpi, the importer's EMU_PER_PX;
// the editor passes 6858000 / slide height so a slide is 7.5 in tall).

export type Flavor = 'canvas' | 'slide'

export interface WShadow { x?: number; y?: number; blur: number; color: string }
export interface WGradient { angle: number; stops: Array<{ at: number; color: string }> }

export interface WBase {
  id: string
  x: number; y: number; w: number; h: number
  rotation?: number
  opacity?: number
  groupId?: string
  hidden?: boolean
  flipH?: boolean
  flipV?: boolean
  shadow?: WShadow | WShadow[]
}
export interface WText extends WBase {
  type: 'text'
  html: string
  fontSize: number
  fontFamily: string
  fontWeight?: number
  color: string
  colorGradient?: WGradient
  align?: 'left' | 'center' | 'right'
  valign?: 'top' | 'middle' | 'bottom'
  lineHeight?: number
  letterSpacing?: number
  textStroke?: { width: number; color: string; fill?: string }
}
export interface WShape extends WBase {
  type: 'shape'
  shape: 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'line' | 'path'
  fill: string
  fillGradient?: WGradient
  stroke?: string
  strokeWidth?: number
  radius?: number
  strokeDash?: number
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  strokeCap?: 'round' | 'square' | 'butt'
  strokeJoin?: 'round' | 'bevel' | 'miter'
  lineStart?: 'none' | 'arrow' | 'dot' | 'bar'
  lineEnd?: 'none' | 'arrow' | 'dot' | 'bar'
  d?: string
  pathBox?: [number, number, number, number]
}
export interface WImage extends WBase {
  type: 'image'
  /** a data: URI (png, jpeg, gif); resolve `asset:` refs before calling */
  src: string
  fit?: 'contain' | 'cover' | 'fill'
  radius?: number
  crop?: { x: number; y: number; w: number; h: number }
  alt?: string
}
export interface WTableCell {
  html: string
  align?: 'left' | 'center' | 'right'
  color?: string
  bg?: string
  bold?: boolean
  colspan?: number
  rowspan?: number
}
export interface WTable extends WBase {
  type: 'table'
  columns: Array<{ w: number }>
  rows: Array<{ cells: WTableCell[] }>
  header: boolean
  style: {
    headerBg: string; headerColor: string; zebra?: string
    borderColor: string; borderWidth: number
    cellPadX: number; cellPadY: number
    fontSize: number; fontFamily?: string; color: string
  }
}
/** An element the caller drew itself: a PNG placed at this frame. */
export interface WPicture extends WBase {
  type: 'picture'
  png: Uint8Array
  alt?: string
}
export type WElement = WText | WShape | WImage | WTable | WPicture

export interface WriteOpts {
  flavor: Flavor
  /** EMU per slide px */
  emuPerPx: number
  /** the deck's body face, for text that names only a generic family */
  fontFamily?: string
}

export interface WRel { id: string; type: 'image' | 'hyperlink'; target: string }
export interface WMedia { name: string; data: Uint8Array; contentType: string }

export interface Written {
  /** the shapes, in z-order, ready to sit inside a group / spTree */
  xml: string
  /** EMU bounding box of everything written (for the canvas group) */
  box: { x: number; y: number; w: number; h: number }
  rels: WRel[]
  media: WMedia[]
  warnings: string[]
}

export const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
export const REL_HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'

/** Relationship ids start here: rId1 is the theme (clipboard) or the layout (slide). */
const FIRST_REL = 2

export function writeDrawingML(elements: WElement[], opts: WriteOpts): Written {
  const w = new Writer(opts)
  const visible = elements.filter((e) => !e.hidden)
  // groups stay together at the z-position of their first member
  const done = new Set<string>()
  for (const el of visible) {
    if (done.has(el.id)) continue
    if (el.groupId) {
      const members = visible.filter((m) => m.groupId === el.groupId)
      for (const m of members) done.add(m.id)
      if (members.length > 1) { w.out.push(w.group(members)); continue }
    }
    done.add(el.id)
    w.out.push(w.element(el))
  }
  return { xml: w.out.join(''), box: w.box(visible), rels: w.rels, media: w.media, warnings: [...w.warnings] }
}

// ---- the writer -------------------------------------------------------------------

class Writer {
  out: string[] = []
  rels: WRel[] = []
  media: WMedia[] = []
  warnings = new Set<string>()
  private nextId = 2
  private readonly c: boolean
  /** p: in a slide, a: on the clipboard canvas */
  private readonly p: string

  private readonly opts: WriteOpts

  constructor(opts: WriteOpts) {
    this.opts = opts
    this.c = opts.flavor === 'canvas'
    this.p = this.c ? 'a' : 'p'
  }

  private emu(px: number): number { return Math.round(px * this.opts.emuPerPx) }
  /** slide px → hundredths of a point */
  private hpt(px: number): number { return Math.round(px * this.opts.emuPerPx / 127) }

  box(els: WElement[]): { x: number; y: number; w: number; h: number } {
    if (!els.length) return { x: 0, y: 0, w: 0, h: 0 }
    const x0 = Math.min(...els.map((e) => e.x)), y0 = Math.min(...els.map((e) => e.y))
    const x1 = Math.max(...els.map((e) => e.x + e.w)), y1 = Math.max(...els.map((e) => e.y + e.h))
    return { x: this.emu(x0), y: this.emu(y0), w: Math.max(1, this.emu(x1 - x0)), h: Math.max(1, this.emu(y1 - y0)) }
  }

  element(el: WElement): string {
    switch (el.type) {
      case 'text': return this.text(el)
      case 'shape': return this.shape(el)
      case 'image': return this.image(el)
      case 'table': return this.table(el)
      case 'picture': return this.picture(el)
    }
  }

  // ---- non-visual properties, transforms -----------------------------------------

  private cNvPr(name: string, descr?: string): string {
    const id = this.nextId++
    return `<${this.p}:cNvPr id="${id}" name="${esc(`${name} ${id}`)}"${descr ? ` descr="${esc(descr)}"` : ''}/>`
  }
  /** a: or p: nv block: cNvPr + the kind's own cNv*Pr (+ p:nvPr in a slide) */
  private nv(kind: 'Sp' | 'Pic' | 'GraphicFrame' | 'GrpSp', name: string, o: { attrs?: string; inner?: string; descr?: string } = {}): string {
    const p = this.p
    const own = `<${p}:cNv${kind}Pr${o.attrs ?? ''}${o.inner ? `>${o.inner}</${p}:cNv${kind}Pr>` : '/>'}`
    return `<${p}:nv${kind}Pr>${this.cNvPr(name, o.descr)}${own}${this.c ? '' : '<p:nvPr/>'}</${p}:nv${kind}Pr>`
  }
  private xfrm(el: WBase, frame = el, tag = 'a:xfrm', flips = true): string {
    const rot = Math.round(((((el.rotation ?? 0) % 360) + 360) % 360) * 60000)
    const attrs = (rot ? ` rot="${rot}"` : '') + (flips && el.flipH ? ' flipH="1"' : '') + (flips && el.flipV ? ' flipV="1"' : '')
    return `<${tag}${attrs}><a:off x="${this.emu(frame.x)}" y="${this.emu(frame.y)}"/><a:ext cx="${this.emu(Math.max(frame.w, 0))}" cy="${this.emu(Math.max(frame.h, 0))}"/></${tag}>`
  }

  // ---- paint ---------------------------------------------------------------------

  private solid(css: string, opacity = 1): string {
    const c = parseColor(css)
    if (!c || c.a * opacity <= 0) return '<a:noFill/>'
    return `<a:solidFill>${clr(c.hex, c.a * opacity)}</a:solidFill>`
  }
  private gradient(g: WGradient, opacity = 1): string {
    const stops = g.stops.map((s) => {
      const c = parseColor(s.color) ?? { hex: '000000', a: 1 }
      return `<a:gs pos="${Math.round(clamp01(s.at) * 100000)}">${clr(c.hex, c.a * opacity)}</a:gs>`
    }).join('')
    // CSS 0deg = bottom→top, clockwise; DrawingML 0 = left→right, clockwise
    const ang = Math.round(((((g.angle - 90) % 360) + 360) % 360) * 60000)
    return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="${ang}" scaled="0"/></a:gradFill>`
  }
  private effects(el: WBase): string {
    const s = Array.isArray(el.shadow) ? el.shadow[0] : el.shadow
    if (!s) return ''
    const c = parseColor(s.color)
    if (!c) return ''
    const x = s.x ?? 0, y = s.y ?? 0
    const dir = Math.round(((((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360) * 60000)
    return `<a:effectLst><a:outerShdw blurRad="${this.emu(s.blur)}" dist="${this.emu(Math.hypot(x, y))}" dir="${dir}" algn="ctr" rotWithShape="0">${clr(c.hex, c.a)}</a:outerShdw></a:effectLst>`
  }
  private line(el: WShape, isLine: boolean): string {
    const op = el.opacity ?? 1
    const color = isLine ? el.fill : el.stroke ?? ''
    const sw = isLine ? Math.max(el.strokeWidth ?? 0, 2) : el.strokeWidth ?? 0
    if (!color || sw <= 0 || !parseColor(color)) return '<a:ln><a:noFill/></a:ln>'
    const style = el.strokeStyle ?? (el.strokeDash ? 'dashed' : 'solid')
    const cap = el.strokeCap ?? (isLine ? (style === 'dashed' ? 'butt' : 'round') : undefined)
    const capAttr = cap === 'round' ? ' cap="rnd"' : cap === 'square' ? ' cap="sq"' : cap === 'butt' ? ' cap="flat"' : ''
    const dash = style === 'dashed' ? '<a:prstDash val="dash"/>' : style === 'dotted' ? '<a:prstDash val="sysDot"/>' : ''
    const join = el.strokeJoin === 'round' ? '<a:round/>' : el.strokeJoin === 'bevel' ? '<a:bevel/>' : ''
    const tip = (k: string | undefined, tag: string) => {
      const t = k === 'arrow' ? 'triangle' : k === 'dot' ? 'oval' : ''
      if (k === 'bar') this.warnings.add('A bar line end has no PowerPoint equivalent and was left off')
      return t ? `<a:${tag} type="${t}"/>` : ''
    }
    const ends = isLine ? tip(el.lineStart, 'headEnd') + tip(el.lineEnd, 'tailEnd') : ''
    return `<a:ln w="${this.emu(sw)}"${capAttr}>${this.solid(color, op)}${dash}${join}${ends}</a:ln>`
  }

  // ---- shapes --------------------------------------------------------------------

  shape(el: WShape): string {
    const op = el.opacity ?? 1
    const isLine = el.shape === 'line'
    let geom: string
    let frame: WBase = el
    switch (el.shape) {
      case 'rect': {
        const r = Math.min(el.radius ?? 0, Math.min(el.w, el.h) / 2)
        geom = r > 0
          ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.round((r / Math.max(1, Math.min(el.w, el.h))) * 100000)}"/></a:avLst></a:prstGeom>`
          : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
        break
      }
      case 'ellipse': geom = '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>'; break
      case 'triangle': geom = '<a:prstGeom prst="triangle"><a:avLst/></a:prstGeom>'; break
      case 'arrow': {
        // render.ts: the shaft is 44% of the height, the head min(38% w, h) long
        const head = Math.min(el.w * 0.38, el.h) / Math.max(1, Math.min(el.w, el.h))
        geom = `<a:prstGeom prst="rightArrow"><a:avLst><a:gd name="adj1" fmla="val 44000"/><a:gd name="adj2" fmla="val ${Math.round(head * 100000)}"/></a:avLst></a:prstGeom>`
        break
      }
      case 'line':
        // render.ts draws it through the middle of the box; rotation does the rest
        frame = { ...el, y: el.y + el.h / 2, h: 0 }
        geom = '<a:prstGeom prst="line"><a:avLst/></a:prstGeom>'
        break
      case 'path': {
        const g = this.custGeom(el)
        if (!g) { this.warnings.add('A drawing with an unreadable outline was left out'); return '' }
        geom = g
        break
      }
    }
    const fill = isLine ? '<a:noFill/>' : el.fillGradient?.stops.length ? this.gradient(el.fillGradient, op) : this.solid(el.fill, op)
    const spPr = `<${this.p}:spPr>${this.xfrm(el, frame)}${geom}${fill}${this.line(el, isLine)}${this.effects(el)}</${this.p}:spPr>`
    const name = isLine ? 'Line' : el.shape === 'path' ? 'Freeform' : el.shape === 'ellipse' ? 'Oval' : el.shape === 'triangle' ? 'Triangle' : el.shape === 'arrow' ? 'Arrow' : 'Rectangle'
    return `<${this.p}:sp>${this.nv('Sp', name)}${spPr}</${this.p}:sp>`
  }

  /** An SVG path, stretched from `pathBox` to the frame (render.ts
   *  preserveAspectRatio="none"), as one custom geometry. */
  private custGeom(el: WShape): string | null {
    if (!el.d) return null
    const segs = normalizePath(el.d)
    if (!segs || !segs.length) return null
    const [bx, by, bw, bh] = el.pathBox ?? [0, 0, el.w, el.h]
    // path units: the path's own coordinates × 1000, as whole numbers
    const k = 1000
    const W = Math.max(1, Math.round(bw * k)), H = Math.max(1, Math.round(bh * k))
    const pt = (x: number, y: number) => `<a:pt x="${Math.round((x - bx) * k)}" y="${Math.round((y - by) * k)}"/>`
    let body = ''
    for (const s of segs) {
      if (s.c === 'M') body += `<a:moveTo>${pt(s.p[0], s.p[1])}</a:moveTo>`
      else if (s.c === 'L') body += `<a:lnTo>${pt(s.p[0], s.p[1])}</a:lnTo>`
      else if (s.c === 'C') body += `<a:cubicBezTo>${pt(s.p[0], s.p[1])}${pt(s.p[2], s.p[3])}${pt(s.p[4], s.p[5])}</a:cubicBezTo>`
      else body += '<a:close/>'
    }
    const filled = !!parseColor(el.fill) || !!el.fillGradient?.stops.length
    return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${W}" h="${H}"${filled ? '' : ' fill="none"'}>${body}</a:path></a:pathLst></a:custGeom>`
  }

  // ---- text ----------------------------------------------------------------------

  text(el: WText): string {
    const body = this.txBody(el.html, {
      size: el.fontSize,
      face: this.face(el.fontFamily),
      color: el.colorGradient?.stops.length ? el.colorGradient.stops[0].color : el.color,
      bold: (el.fontWeight ?? 400) >= 600,
      align: el.align ?? 'left',
      lineHeight: el.lineHeight,
      spacing: el.letterSpacing,
      stroke: el.textStroke,
      opacity: el.opacity ?? 1,
    }, `<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${el.valign === 'middle' ? 'ctr' : el.valign === 'bottom' ? 'b' : 't'}" rtlCol="0"><a:noAutofit/></a:bodyPr>`)
    const spPr = `<${this.p}:spPr>${this.xfrm(el, el, 'a:xfrm', false)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>${this.effects(el)}</${this.p}:spPr>`
    const tx = this.c ? `<a:txSp>${body}<a:useSpRect/></a:txSp>` : body.replace(/^<a:txBody>/, '<p:txBody>').replace(/<\/a:txBody>$/, '</p:txBody>')
    return `<${this.p}:sp>${this.nv('Sp', 'TextBox', { attrs: ' txBox="1"' })}${spPr}${tx}</${this.p}:sp>`
  }

  /** The face for a CSS stack; a generic one falls back to the deck's face. */
  private face(stack: string | undefined): string {
    const own = concreteFace(stack, '')
    return own || concreteFace(this.opts.fontFamily, 'Arial') || 'Arial'
  }

  /** a:txBody (always spelled a:, the caller renames for p:) from rich html. */
  private txBody(html: string, base: RunBase, bodyPr: string): string {
    const paras = parseRich(html)
    const ps = paras.map((para) => {
      const ppr = this.pPr(para, base)
      const runs = para.runs.map((r) => this.run(r, base)).join('')
      return `<a:p>${ppr}${runs}<a:endParaRPr lang="en-US" sz="${this.hpt(base.size)}" dirty="0"/></a:p>`
    })
    return `<a:txBody>${bodyPr}<a:lstStyle/>${ps.join('') || '<a:p><a:endParaRPr lang="en-US"/></a:p>'}</a:txBody>`
  }

  private pPr(para: Para, base: RunBase): string {
    const algn = base.align === 'center' ? 'ctr' : base.align === 'right' ? 'r' : 'l'
    let attrs = ` algn="${algn}"`
    let bullet = '<a:buNone/>'
    if (para.list) {
      const step = this.emu(base.size * 1.25)
      attrs += ` marL="${step * (para.list.level + 1)}" indent="${-step}"${para.list.level ? ` lvl="${Math.min(para.list.level, 8)}"` : ''}`
      bullet = para.list.ordered
        ? `<a:buFont typeface="+mj-lt"/><a:buAutoNum type="${['arabicPeriod', 'alphaLcPeriod', 'romanLcPeriod'][para.list.level % 3]}"/>`
        : `<a:buFont typeface="Arial"/><a:buChar char="${['•', '◦', '▪'][para.list.level % 3]}"/>`
    }
    const ln = base.lineHeight ? `<a:lnSpc><a:spcPct val="${Math.round(base.lineHeight * 100000)}"/></a:lnSpc>` : ''
    return `<a:pPr${attrs}>${ln}${bullet}</a:pPr>`
  }

  private run(r: Run, base: RunBase): string {
    if (r.br) return `<a:br><a:rPr lang="en-US" sz="${this.hpt(base.size)}" dirty="0"/></a:br>`
    if (!r.text) return ''
    const size = r.size ? r.size(base.size) : base.size
    const attrs = [
      'lang="en-US"',
      `sz="${Math.max(100, Math.min(400000, this.hpt(size)))}"`,
      (r.bold || base.bold) ? 'b="1"' : '',
      r.italic ? 'i="1"' : '',
      r.underline || r.href ? 'u="sng"' : '',
      r.strike ? 'strike="sngStrike"' : '',
      base.spacing ? `spc="${this.hpt(base.spacing)}"` : '',
      'dirty="0"',
    ].filter(Boolean).join(' ')
    const stroke = base.stroke && base.stroke.width > 0 ? `<a:ln w="${this.emu(base.stroke.width)}">${this.solid(base.stroke.color, base.opacity)}</a:ln>` : ''
    const fill = base.stroke?.fill === 'none' ? '<a:noFill/>' : this.solid(r.color ?? base.color, base.opacity)
    const face = r.code ? 'Courier New' : base.face
    let link = ''
    if (r.href) {
      const id = `rId${FIRST_REL + this.rels.length}`
      this.rels.push({ id, type: 'hyperlink', target: r.href })
      link = `<a:hlinkClick r:id="${id}"/>`
    }
    return `<a:r><a:rPr ${attrs}>${stroke}${fill}<a:latin typeface="${esc(face)}"/><a:cs typeface="${esc(face)}"/>${link}</a:rPr><a:t>${esc(r.text)}</a:t></a:r>`
  }

  // ---- pictures ------------------------------------------------------------------

  private embed(data: Uint8Array, contentType: string): string {
    const ext = contentType === 'image/jpeg' ? 'jpeg' : contentType === 'image/gif' ? 'gif' : 'png'
    const name = `image${this.media.length + 1}.${ext}`
    this.media.push({ name, data, contentType })
    const id = `rId${FIRST_REL + this.rels.length}`
    this.rels.push({ id, type: 'image', target: name })
    return id
  }

  private pic(el: WBase, frame: WBase, relId: string, srcRect: string, geom: string, descr?: string): string {
    const op = el.opacity ?? 1
    const alpha = op < 1 ? `<a:alphaModFix amt="${Math.round(op * 100000)}"/>` : ''
    const blip = `<${this.p}:blipFill><a:blip r:embed="${relId}">${alpha}</a:blip>${srcRect}<a:stretch><a:fillRect/></a:stretch></${this.p}:blipFill>`
    const spPr = `<${this.p}:spPr>${this.xfrm(el, frame)}${geom}${this.effects(el)}</${this.p}:spPr>`
    return `<${this.p}:pic>${this.nv('Pic', 'Picture', { inner: '<a:picLocks noChangeAspect="1"/>', descr })}${blip}${spPr}</${this.p}:pic>`
  }

  image(el: WImage): string {
    const data = decodeDataUri(el.src)
    if (!data || !/^image\/(png|jpeg|gif)$/.test(data.type)) {
      this.warnings.add('A picture in a format PowerPoint cannot take here was left out')
      return ''
    }
    const relId = this.embed(data.bytes, data.type)
    let frame: WBase = el
    let crop = el.crop ?? null
    const nat = imageSize(data.bytes)
    if (!crop && nat && el.fit !== 'fill') {
      const ia = nat.w / nat.h, fa = el.w / Math.max(el.h, 1e-6)
      if (el.fit === 'contain') {
        // the frame shrinks to the picture, centred, as the renderer letterboxes it
        if (ia > fa) { const h = el.w / ia; frame = { ...el, y: el.y + (el.h - h) / 2, h } }
        else { const w = el.h * ia; frame = { ...el, x: el.x + (el.w - w) / 2, w } }
      } else if (Math.abs(ia - fa) > 1e-3) {
        crop = ia > fa ? { x: (1 - fa / ia) / 2, y: 0, w: fa / ia, h: 1 } : { x: 0, y: (1 - ia / fa) / 2, w: 1, h: ia / fa }
      }
    }
    const srcRect = crop
      ? `<a:srcRect l="${pct(crop.x)}" t="${pct(crop.y)}" r="${pct(1 - crop.x - crop.w)}" b="${pct(1 - crop.y - crop.h)}"/>`
      : ''
    const r = Math.min(el.radius ?? 0, Math.min(frame.w, frame.h) / 2)
    const geom = r > 0
      ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.round((r / Math.max(1, Math.min(frame.w, frame.h))) * 100000)}"/></a:avLst></a:prstGeom>`
      : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
    return this.pic(el, frame, relId, srcRect, geom, el.alt)
  }

  picture(el: WPicture): string {
    const relId = this.embed(el.png, 'image/png')
    return this.pic({ ...el, opacity: 1, flipH: false, flipV: false, shadow: undefined }, el, relId, '', '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', el.alt)
  }

  // ---- tables --------------------------------------------------------------------

  table(el: WTable): string {
    const st = el.style
    const ncol = el.columns.length
    const nrow = el.rows.length
    if (!ncol || !nrow) return ''
    const total = el.columns.reduce((a, c) => a + (c.w > 0 ? c.w : 0), 0) || ncol
    const colW = el.columns.map((c) => this.emu(((c.w > 0 ? c.w : 0) / total) * el.w))
    const rowH = this.emu(el.h / nrow)
    // which cells a merged block covers: [row][col] → 'h' (same row), 'v' (below), 'hv'
    const cover: string[][] = el.rows.map(() => new Array(ncol).fill(''))
    el.rows.forEach((row, r) => row.cells.slice(0, ncol).forEach((cell, c) => {
      const cs = Math.max(1, Math.min(cell.colspan ?? 1, ncol - c)), rs = Math.max(1, Math.min(cell.rowspan ?? 1, nrow - r))
      if (cover[r][c]) return
      for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) {
        if (i === r && j === c) continue
        cover[i][j] = (j > c ? 'h' : '') + (i > r ? 'v' : '')
      }
    }))
    const border = (side: string) => st.borderWidth > 0 && parseColor(st.borderColor)
      ? `<a:${side} w="${this.emu(st.borderWidth)}">${this.solid(st.borderColor)}</a:${side}>`
      : `<a:${side} w="0"><a:noFill/></a:${side}>`
    const rows = el.rows.map((row, r) => {
      const head = el.header && r === 0
      const cells = Array.from({ length: ncol }, (_, c) => {
        const cell = row.cells[c] ?? { html: '' }
        const cov = cover[r][c]
        const spanAttrs = cov
          ? (cov.includes('h') ? ' hMerge="1"' : '') + (cov.includes('v') ? ' vMerge="1"' : '')
          : ((cell.colspan ?? 1) > 1 ? ` gridSpan="${Math.min(cell.colspan!, ncol - c)}"` : '') + ((cell.rowspan ?? 1) > 1 ? ` rowSpan="${Math.min(cell.rowspan!, nrow - r)}"` : '')
        const color = cell.color ?? (head ? st.headerColor : st.color)
        const bg = cell.bg ?? (head ? st.headerBg : st.zebra && !head && (r - (el.header ? 1 : 0)) % 2 === 1 ? st.zebra : '')
        const body = this.txBody(cov ? '' : cell.html, {
          size: st.fontSize, face: this.face(st.fontFamily ?? this.opts.fontFamily), color,
          bold: !!cell.bold || head, align: cell.align ?? 'left', opacity: el.opacity ?? 1,
        }, '<a:bodyPr/>')
        const fill = bg ? this.solid(bg, el.opacity ?? 1) : '<a:noFill/>'
        const tcPr = `<a:tcPr marL="${this.emu(st.cellPadX)}" marR="${this.emu(st.cellPadX)}" marT="${this.emu(st.cellPadY)}" marB="${this.emu(st.cellPadY)}" anchor="ctr">${border('lnL')}${border('lnR')}${border('lnT')}${border('lnB')}${fill}</a:tcPr>`
        return `<a:tc${spanAttrs}>${body}${tcPr}</a:tc>`
      }).join('')
      return `<a:tr h="${rowH}">${cells}</a:tr>`
    }).join('')
    const tbl = `<a:tbl><a:tblPr${el.header ? ' firstRow="1"' : ''}/><a:tblGrid>${colW.map((w) => `<a:gridCol w="${w}"/>`).join('')}</a:tblGrid>${rows}</a:tbl>`
    const graphic = `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">${tbl}</a:graphicData></a:graphic>`
    const xfrm = this.xfrm({ ...el, rotation: 0 }, el, this.c ? 'a:xfrm' : 'p:xfrm', false)
    if (el.rotation) this.warnings.add('A rotated table was pasted upright')
    // the clipboard's GVML frame lists its graphic BEFORE its transform (a
    // slide's p:graphicFrame the other way round); in slide order PowerPoint
    // refuses the whole clipboard package
    const nv = this.nv('GraphicFrame', 'Table', { inner: '<a:graphicFrameLocks noGrp="1"/>' })
    return `<${this.p}:graphicFrame>${nv}${this.c ? graphic + xfrm : xfrm + graphic}</${this.p}:graphicFrame>`
  }

  // ---- groups --------------------------------------------------------------------

  group(members: WElement[]): string {
    const b = this.box(members)
    const xfrm = `<a:xfrm><a:off x="${b.x}" y="${b.y}"/><a:ext cx="${b.w}" cy="${b.h}"/><a:chOff x="${b.x}" y="${b.y}"/><a:chExt cx="${b.w}" cy="${b.h}"/></a:xfrm>`
    const inner = members.map((m) => this.element(m)).join('')
    return `<${this.p}:grpSp>${this.nv('GrpSp', 'Group')}<${this.p}:grpSpPr>${xfrm}</${this.p}:grpSpPr>${inner}</${this.p}:grpSp>`
  }
}

interface RunBase {
  size: number
  face: string
  color: string
  bold: boolean
  align: 'left' | 'center' | 'right'
  lineHeight?: number
  spacing?: number
  stroke?: { width: number; color: string; fill?: string }
  opacity: number
}

/** The face PowerPoint should use for a CSS font stack: its first family
 *  when that is a real face, the concrete stand-in for a generic one
 *  (serif → Times New Roman…), or `fallback` for a system-UI stack, whose
 *  faces (-apple-system, BlinkMacSystemFont) are browser aliases. */
export function concreteFace(stack: string | undefined, fallback: string): string {
  const first = (stack ?? '').split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).find(Boolean)
  if (!first) return fallback
  const g = GENERIC[first.toLowerCase()]
  return g === undefined ? first : g || fallback
}

/** Generic CSS families: '' = a system-UI stack (no face of its own), else this concrete one. */
const GENERIC: Record<string, string> = {
  'sans-serif': '', 'system-ui': '', '-apple-system': '', 'blinkmacsystemfont': '', 'ui-sans-serif': '',
  serif: 'Times New Roman', 'ui-serif': 'Times New Roman',
  monospace: 'Courier New', 'ui-monospace': 'Courier New', cursive: 'Comic Sans MS', fantasy: 'Impact',
}

// ---- rich html → paragraphs -------------------------------------------------------

interface Run {
  text: string
  /** a line break inside the paragraph (a <br> in a list item) */
  br?: boolean
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean
  color?: string
  size?: (base: number) => number
  href?: string
}
interface Para { runs: Run[]; list?: { level: number; ordered: boolean } }

/** The sanitizer's allowlist (b/i/u/s/strong/em/code/br/div/p, span with
 *  colour/size, a, ul/ol/li) as paragraphs of runs, read the way
 *  convert/lists.ts paragraphsHtml writes it: lines are separated by <br>
 *  (a <br> right before a list or block draws no line of its own), a list
 *  item is a paragraph at its nesting level, and a <br> inside an item is a
 *  line break within it. */
export function parseRich(html: string): Para[] {
  const paras: Para[] = []
  let cur: Para = { runs: [] }
  const stack: Array<{ tag: string } & Omit<Run, 'text'>> = []
  const lists: Array<'ul' | 'ol'> = []
  const fmt = (): Omit<Run, 'text'> => {
    const f: Omit<Run, 'text'> = {}
    for (const s of stack) {
      if (s.bold) f.bold = true
      if (s.italic) f.italic = true
      if (s.underline) f.underline = true
      if (s.strike) f.strike = true
      if (s.code) f.code = true
      if (s.color) f.color = s.color
      if (s.href) f.href = s.href
      if (s.size) { const outer = f.size, inner = s.size; f.size = outer ? (b) => inner(outer(b)) : inner }
    }
    return f
  }
  const push = () => { paras.push(cur); cur = { runs: [] } }
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)|(<)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[4] !== undefined || m[5] !== undefined) {
      const text = decodeEntities(m[4] ?? '<')
      if (text) cur.runs.push({ text, ...fmt() })
      continue
    }
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    if (tag === 'br') {
      if (cur.list) cur.runs.push({ text: '', br: true })
      else push()
      continue
    }
    if (tag === 'ul' || tag === 'ol') {
      if (closing) lists.pop()
      else lists.push(tag)
      continue
    }
    if (tag === 'li') {
      if (cur.runs.length || cur.list) push()
      if (!closing) cur = { runs: [], list: { level: Math.max(0, lists.length - 1), ordered: lists[lists.length - 1] === 'ol' } }
      continue
    }
    if (tag === 'div' || tag === 'p') {
      if (cur.runs.length) push()
      continue
    }
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { stack.splice(i, 1); break }
      continue
    }
    const a = m[3] ?? ''
    const f: { tag: string } & Omit<Run, 'text'> = { tag }
    if (tag === 'b' || tag === 'strong') f.bold = true
    else if (tag === 'i' || tag === 'em') f.italic = true
    else if (tag === 'u') f.underline = true
    else if (tag === 's') f.strike = true
    else if (tag === 'code') f.code = true
    else if (tag === 'a') { const h = attrOf(a, 'href'); if (h && /^(https?:|mailto:)/i.test(h)) f.href = h }
    else if (tag === 'span') {
      const style = attrOf(a, 'style') ?? ''
      const color = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim()
      const size = /(?:^|;)\s*font-size\s*:\s*([\d.]+)(px|em|%)/i.exec(style)
      if (color) f.color = color
      if (size) {
        const n = Number(size[1]), unit = size[2].toLowerCase()
        f.size = unit === 'px' ? () => n : unit === 'em' ? (b) => b * n : (b) => (b * n) / 100
      }
    } else continue
    stack.push(f)
  }
  if (cur.runs.length || cur.list) paras.push(cur)
  return paras
}

function attrOf(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(' ' + attrs)
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : undefined
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''
    }
    return NAMED[e.toLowerCase()] ?? all
  })
}

// ---- svg path → absolute M / L / C / Z ---------------------------------------------

export interface PathSeg { c: 'M' | 'L' | 'C' | 'Z'; p: number[] }

/** Any SVG path (relative, H/V, S, Q/T, A) as absolute moveTo / lineTo /
 *  cubic / close; null when it does not parse. */
export function normalizePath(d: string): PathSeg[] | null {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)
  if (!tokens) return null
  const out: PathSeg[] = []
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0
  let lastC: [number, number] | null = null, lastQ: [number, number] | null = null
  const num = (): number => {
    const t = tokens[i++]
    const n = Number(t)
    if (t === undefined || !Number.isFinite(n)) throw new Error('path')
    return n
  }
  const isNum = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])
  try {
    while (i < tokens.length) {
      if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++]
      else if (!cmd) return null
      const rel = cmd === cmd.toLowerCase()
      const C = cmd.toUpperCase()
      const ax = (v: number) => (rel ? x + v : v), ay = (v: number) => (rel ? y + v : v)
      let cubic: [number, number] | null = null, quad: [number, number] | null = null
      switch (C) {
        case 'M': {
          x = ax(num()); y = ay(num()); sx = x; sy = y
          out.push({ c: 'M', p: [x, y] })
          cmd = rel ? 'l' : 'L' // further pairs are lineTos
          break
        }
        case 'L': x = ax(num()); y = ay(num()); out.push({ c: 'L', p: [x, y] }); break
        case 'H': x = rel ? x + num() : num(); out.push({ c: 'L', p: [x, y] }); break
        case 'V': y = rel ? y + num() : num(); out.push({ c: 'L', p: [x, y] }); break
        case 'C': {
          const x1 = ax(num()), y1 = ay(num()), x2 = ax(num()), y2 = ay(num()), ex = ax(num()), ey = ay(num())
          out.push({ c: 'C', p: [x1, y1, x2, y2, ex, ey] }); cubic = [x2, y2]; x = ex; y = ey
          break
        }
        case 'S': {
          const x1 = lastC ? 2 * x - lastC[0] : x, y1 = lastC ? 2 * y - lastC[1] : y
          const x2 = ax(num()), y2 = ay(num()), ex = ax(num()), ey = ay(num())
          out.push({ c: 'C', p: [x1, y1, x2, y2, ex, ey] }); cubic = [x2, y2]; x = ex; y = ey
          break
        }
        case 'Q': case 'T': {
          let qx: number, qy: number
          if (C === 'Q') { qx = ax(num()); qy = ay(num()) } else { qx = lastQ ? 2 * x - lastQ[0] : x; qy = lastQ ? 2 * y - lastQ[1] : y }
          const ex = ax(num()), ey = ay(num())
          out.push({ c: 'C', p: [x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey] })
          quad = [qx, qy]; x = ex; y = ey
          break
        }
        case 'A': {
          const rx = num(), ry = num(), rotDeg = num(), large = num(), sweep = num(), ex = ax(num()), ey = ay(num())
          for (const c of arcToCubics(x, y, rx, ry, rotDeg, !!large, !!sweep, ex, ey)) out.push({ c: 'C', p: c })
          x = ex; y = ey
          break
        }
        case 'Z': out.push({ c: 'Z', p: [] }); x = sx; y = sy; break
        default: return null
      }
      lastC = cubic; lastQ = quad
      if (C === 'Z' && isNum()) continue
    }
  } catch {
    return null
  }
  return out
}

/** An SVG arc as cubic Béziers (≤ 90° each), endpoint parameterisation per the SVG spec. */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): number[][] {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]]
  rx = Math.abs(rx); ry = Math.abs(ry)
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam) }
  const sign = large === sweep ? -1 : 1
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const coef = sign * Math.sqrt(Math.max(0, num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)))
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  else if (sweep && dt < 0) dt += 2 * Math.PI
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)))
  const step = dt / n
  const k = (4 / 3) * Math.tan(step / 4)
  const pt = (t: number): [number, number] => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]
  const der = (t: number): [number, number] => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos]
  const out: number[][] = []
  for (let s = 0; s < n; s++) {
    const a = t1 + s * step, b = a + step
    const [p0x, p0y] = pt(a), [p3x, p3y] = pt(b), [d0x, d0y] = der(a), [d3x, d3y] = der(b)
    out.push([p0x + k * d0x, p0y + k * d0y, p3x - k * d3x, p3y - k * d3y, p3x, p3y])
  }
  // land exactly on the endpoint
  out[out.length - 1][4] = x2; out[out.length - 1][5] = y2
  return out
}

// ---- colours, data, helpers --------------------------------------------------------

const NAMED_COLORS: Record<string, string> = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', gray: '808080', grey: '808080',
  yellow: 'ffff00', orange: 'ffa500', purple: '800080', silver: 'c0c0c0', navy: '000080', teal: '008080',
}

/** A CSS colour as hex + alpha; null for none/transparent/unknown. */
export function parseColor(css: string | undefined): { hex: string; a: number } | null {
  if (!css) return null
  const s = css.trim().toLowerCase()
  if (!s || s === 'none' || s === 'transparent') return null
  let m = /^#([0-9a-f]{3,4})$/.exec(s)
  if (m) {
    const h = m[1]
    return { hex: (h[0] + h[0] + h[1] + h[1] + h[2] + h[2]).toUpperCase(), a: h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1 }
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s)
  if (m) return { hex: m[1].toUpperCase(), a: m[2] ? parseInt(m[2], 16) / 255 : 1 }
  m = /^rgba?\(([^)]+)\)$/.exec(s)
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean)
    if (p.length < 3) return null
    const ch = (v: string) => Math.max(0, Math.min(255, Math.round(v.endsWith('%') ? (parseFloat(v) * 255) / 100 : parseFloat(v))))
    const a = p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])
    if (![p[0], p[1], p[2]].every((v) => Number.isFinite(parseFloat(v))) || !Number.isFinite(a)) return null
    return { hex: [ch(p[0]), ch(p[1]), ch(p[2])].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase(), a: clamp01(a) }
  }
  const named = NAMED_COLORS[s]
  return named ? { hex: named.toUpperCase(), a: 1 } : null
}

function clr(hex: string, alpha: number): string {
  const a = clamp01(alpha)
  return `<a:srgbClr val="${hex}">${a < 0.999 ? `<a:alpha val="${Math.round(a * 100000)}"/>` : ''}</a:srgbClr>`.replace('"></a:srgbClr>', '"/>')
}

function decodeDataUri(src: string): { type: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(src)
  if (!m) return null
  try {
    if (m[3]) {
      const bin = atob(m[4])
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return { type: m[1].toLowerCase(), bytes }
    }
    return { type: m[1].toLowerCase(), bytes: new TextEncoder().encode(decodeURIComponent(m[4])) }
  } catch {
    return null
  }
}

/** Natural size of a PNG, GIF or JPEG from its header. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: v.getUint32(16), h: v.getUint32(20) }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { w: v.getUint16(6, true), h: v.getUint16(8, true) }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const marker = b[i + 1]
      const len = v.getUint16(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: v.getUint16(i + 7), h: v.getUint16(i + 5) }
      i += 2 + len
    }
  }
  return null
}

const pct = (f: number): number => Math.round(clamp01(f) * 100000)
const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
