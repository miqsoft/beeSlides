// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// HTML → slide: an agent writes a slide as ordinary HTML and CSS (flexbox,
// grid, padding, gap), the BROWSER lays it out, and the boxes it computed
// become ordinary elements. The document format does not change: the JSON
// stays the source of truth and HTML is only a way of writing into it
// (docs/DECISIONS.md 2026-10-20, "Slides from HTML").
//
// WHY. Models write HTML/CSS layout well and absolute-coordinate arithmetic
// badly; every frame an agent computes by hand comes out almost-but-not-quite
// aligned (arrange.ts exists for the same reason). Here nobody computes a
// frame: the browser does, with the same text engine the slide is drawn with.
//
// HOW. The source renders in an offscreen iframe sandboxed WITHOUT
// allow-scripts (nothing in it runs) under a CSP that loads nothing from the
// network, at the slide's own size, with the deck's theme as CSS variables.
// The walk then reads getBoundingClientRect + getComputedStyle:
//   - a box with paint (background, border, shadow) → a rect/ellipse shape,
//   - a block holding only inline content → a text element (its content
//     box; inline styling becomes the rich-text subset sanitizeHtml keeps),
//   - <img> → image, <table> → table, <pre> → code, <hr> → line (data-arrow → arrowheads),
//     [data-component] → expanded first into plain HTML (htmlcomponents.ts),
//     [data-chart] → chart, [data-keep] → the existing element of that id,
//     <svg> → native shapes/paths/text (svgconvert.ts, as Convert to objects),
//     <iframe srcdoc> → an embed (the format's sandboxed widget; never run here).
// Element ids are the HTML ids, so a rewrite updates elements in place
// (mergeCompiled keeps what HTML cannot say: fx, links, locks, comments) and
// the same id on two slides morphs. Everything leaves through
// untrusted.ts sanitizeElement, as a paste does.
//
// The way back (slide → HTML) is htmlemit.ts.
import type {
  ChartElement, CodeElement, GradientFill, ImageElement, ShadowSpec, ShapeElement, Slide, SlideElement, SlidomingoDoc, SvgElement, TableCell, TableElement, TextElement,
} from './model'
import { convertSvgToObjects } from './svgconvert'
import { expandComponents, type ComponentTheme } from './htmlcomponents'
import { resolveSlideFonts, sanitizeHtml } from './render'
import { sanitizeElement } from './untrusted'

export interface HtmlSlideSource {
  html: string
  css?: string
}

export interface CompileResult {
  /** In paint order (back to front), ids final, every one sanitized. */
  elements: SlideElement[]
  /** The slide background the HTML gave (body / a full-slide root box). */
  background?: string
  /** What was left out or approximated, one line each, for the agent. */
  notes: string[]
  /** The source to remember on the slide: the html with every embedded
   *  picture replaced by `element:<id>` (its bytes live in the element), or
   *  null when it is too long to keep. */
  remember: HtmlSlideSource | null
}

/** The longest source a slide remembers (pictures already referenced by id). */
export const MAX_REMEMBERED_HTML = 200_000

/** The longest document an embed carries (untrusted.ts LIMITS.html). */
const MAX_EMBED_HTML = 64 * 1024

/** Longest source accepted (html + css). A slide is a few KB; pictures as
 *  data: URIs make it larger. */
export const MAX_HTML_SOURCE = 4_000_000

/** The CSS a slide's HTML is laid out under: theme variables, a border-box
 *  reset, and the text rules the slide renderer itself applies (lists, inline
 *  code), so a box measured here wraps as it will on the slide. */
export function baseCss(doc: SlidomingoDoc, slide: Slide, size: { width: number; height: number }): string {
  const fonts = resolveSlideFonts(doc, slide)
  const body = fonts.fontFamily || doc.theme.fontFamily
  const heading = fonts.headingFamily || doc.theme.headingFamily || body
  const th = doc.theme as unknown as Record<string, unknown>
  const vars: string[] = [
    `--bs-w:${size.width}px`, `--bs-h:${size.height}px`, `--bs-margin:96px`,
    `--bs-bg:${cssValue(doc.theme.background)}`, `--bs-text:${cssValue(doc.theme.color)}`, `--bs-accent:${cssValue(doc.theme.accent)}`,
    `--bs-font:${cssValue(body)}`, `--bs-heading-font:${cssValue(heading)}`,
  ]
  for (let k = 2; k <= 6; k++) if (typeof th[`accent${k}`] === 'string') vars.push(`--bs-accent${k}:${cssValue(th[`accent${k}`] as string)}`)
  return [
    `:root{${vars.join(';')}}`,
    '*,*::before,*::after{box-sizing:border-box}',
    `html,body{margin:0;padding:0;width:${size.width}px;height:${size.height}px;overflow:hidden}`,
    'body{position:relative;font-family:var(--bs-font);color:var(--bs-text);font-size:24px;line-height:1.2;-webkit-font-smoothing:antialiased}',
    'h1,h2,h3,h4,h5,h6{font-family:var(--bs-heading-font)}',
    'ul,ol{margin:0;padding-inline-start:1.25em}li{margin:0}',
    'code{font-family:ui-monospace,SFMono-Regular,Berkeley Mono,Menlo,Consolas,monospace;font-size:.9em;padding:0 .28em;border-radius:3px;background:rgb(127 127 127/.16)}',
    'pre code{font-size:inherit;padding:0;background:none}',
    'img{display:block}',
  ].join('\n')
}

/** A theme value as a CSS custom-property value: no way out of the rule. */
const cssValue = (v: string | undefined): string => String(v ?? '').replace(/[;{}<>\\]/g, '')

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

/** Tags that never reach the layout iframe (with their content). */
const DROP_TAGS = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset', 'form', 'input', 'button', 'select', 'textarea', 'video', 'audio', 'canvas', 'math', 'template', 'noscript', 'portal']

/**
 * The source, made inert before it is laid out: no script or plugin tag,
 * no event handler, no url() but data: in a style, no picture that is not
 * a data: URI (asset:/element: refs are resolved by the caller first). The
 * iframe's sandbox and CSP refuse the same things again; this pass is what
 * lets the result say what was dropped.
 */
function inertSource(src: HtmlSlideSource, resolveImg: (raw: string) => string | null, notes: Set<string>, theme: ComponentTheme): { body: string; css: string; embeds: string[] } {
  const tpl = document.createElement('template')
  tpl.innerHTML = src.html
  const root = tpl.content
  // components first: what they expand into is cleaned like everything else
  expandComponents(root, theme, notes)
  numberImages(root)
  // a self-contained frame (srcdoc, no src) is a widget the deck can carry as
  // an `embed` (allow-scripts only, null origin); it is laid out as an empty
  // box of the same size here, and nothing in it runs now
  const embeds: string[] = []
  for (const fr of Array.from(root.querySelectorAll('iframe'))) {
    const doc = fr.getAttribute('srcdoc')
    if (doc === null || fr.getAttribute('src')) continue
    const box = document.createElement('div')
    for (const a of ['id', 'class', 'style', 'width', 'height']) { const v = fr.getAttribute(a); if (v !== null) box.setAttribute(a, v) }
    if (!box.style.width && fr.getAttribute('width')) box.style.width = `${fr.getAttribute('width')}px`
    if (!box.style.height && fr.getAttribute('height')) box.style.height = `${fr.getAttribute('height')}px`
    if (!box.style.width) box.style.width = '300px'
    if (!box.style.height) box.style.height = '150px'
    box.setAttribute('data-bs-embed', String(embeds.length))
    embeds.push(doc)
    fr.replaceWith(box)
  }
  for (const tag of DROP_TAGS) {
    for (const el of Array.from(root.querySelectorAll(tag))) {
      notes.add(`<${tag}> is not part of a slide and was left out.`)
      el.remove()
    }
  }
  // svg drawings become native shapes (visit → svgconvert.ts); what could
  // smuggle HTML or a request into one goes first
  for (const el of Array.from(root.querySelectorAll('svg *'))) {
    const name = el.localName.toLowerCase()
    if (name === 'foreignobject' || name === 'script' || name === 'animate' || name === 'set' || name === 'animatemotion' || name === 'animatetransform') { el.remove(); continue }
    for (const a of ['href', 'xlink:href', 'src']) {
      const v = el.getAttribute(a)
      if (v !== null && !v.startsWith('#') && !v.startsWith('data:')) { el.removeAttribute(a); notes.add('A link inside an <svg> to something outside it was left out.') }
    }
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase()
      if (n.startsWith('on') || n === 'srcset' || n === 'formaction' || n === 'http-equiv' || n === 'srcdoc') el.removeAttribute(attr.name)
      else if (n === 'style' && /url\s*\(\s*(?!['"]?data:)/i.test(attr.value)) {
        el.setAttribute('style', attr.value.replace(/url\s*\(\s*(?!['"]?data:)[^)]*\)/gi, 'none'))
        notes.add('A url() in a style was left out (only data: URIs load).')
      }
    }
    if (el.tagName === 'IMG') {
      const raw = el.getAttribute('src') ?? ''
      const loadable = resolveImg(raw)
      el.setAttribute('data-bs-src', raw)
      if (loadable) el.setAttribute('src', loadable)
      else el.removeAttribute('src')
    }
  }
  let css = src.css ?? ''
  if (/@import|url\s*\(\s*(?!['"]?data:)/i.test(css)) {
    notes.add('@import and url() other than data: were left out of the CSS.')
    css = css.replace(/@import[^;]*;?/gi, '').replace(/url\s*\(\s*(?!['"]?data:)[^)]*\)/gi, 'none')
  }
  // inline <style> blocks are kept (CSS is how layout is said) but cleaned the same way
  for (const st of Array.from(root.querySelectorAll('style'))) {
    st.textContent = (st.textContent ?? '').replace(/@import[^;]*;?/gi, '').replace(/url\s*\(\s*(?!['"]?data:)[^)]*\)/gi, 'none')
  }
  const holder = document.createElement('div')
  holder.appendChild(root.cloneNode(true))
  return { body: holder.innerHTML, css: css.replace(/<\/style/gi, ''), embeds }
}

/** Every <img> gets its document position, so the picture element it becomes
 *  can be found again in the source (`remember`). */
function numberImages(root: DocumentFragment) {
  Array.from(root.querySelectorAll('img')).forEach((img, i) => img.setAttribute('data-bs-img', String(i)))
}

/** The source as the slide keeps it: embedded pictures by element id. */
function rememberable(src: HtmlSlideSource, imageIds: Map<string, string>): HtmlSlideSource | null {
  let html = src.html
  if (/\bsrc\s*=\s*["']?\s*data:/i.test(html)) {
    const tpl = document.createElement('template')
    tpl.innerHTML = html
    numberImages(tpl.content)
    for (const img of Array.from(tpl.content.querySelectorAll('img'))) {
      const id = imageIds.get(img.getAttribute('data-bs-img') ?? '')
      if (id && (img.getAttribute('src') ?? '').trim().startsWith('data:')) img.setAttribute('src', `element:${id}`)
      img.removeAttribute('data-bs-img')
    }
    html = tpl.innerHTML
  }
  const css = src.css
  if (html.length + (css?.length ?? 0) > MAX_REMEMBERED_HTML) return null
  return css ? { html, css } : { html }
}

/** The fonts embedded in the deck, as @font-face rules (data: URIs only). */
function fontFaces(doc: SlidomingoDoc): string {
  const out: string[] = []
  for (const f of doc.fonts ?? []) {
    const src = doc.assets?.[f.asset]
    if (typeof src !== 'string' || !src.startsWith('data:')) continue
    out.push(`@font-face{font-family:${JSON.stringify(f.family)};src:url(${JSON.stringify(src)});font-weight:${f.weight ?? 'normal'};font-style:${f.style ?? 'normal'}}`)
  }
  return out.join('\n')
}

/** Lays `src` out in an offscreen, script-less iframe and hands its document
 *  to `read`; the iframe is gone afterwards whatever happens. */
async function withLaidOut<T>(doc: SlidomingoDoc, slide: Slide, size: { width: number; height: number }, src: HtmlSlideSource,
  resolveImg: (raw: string) => string | null, notes: Set<string>, read: (d: Document, embeds: string[]) => T): Promise<T> {
  const { body, css, embeds } = inertSource(src, resolveImg, notes, doc.theme)
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-same-origin')
  frame.setAttribute('data-beeslides-transient', '')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.style.cssText = `position:fixed;left:-${size.width + 4000}px;top:0;width:${size.width}px;height:${size.height}px;border:0;opacity:0;pointer-events:none`
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + `<style>${fontFaces(doc)}</style><style>${baseCss(doc, slide, size)}</style><style>${css}</style></head><body>${body}</body></html>`
  const loaded = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }))
  document.body.appendChild(frame)
  try {
    await withTimeout(loaded, 5000)
    const d = frame.contentDocument
    if (!d) throw new Error('The HTML could not be laid out.')
    await withTimeout(d.fonts?.ready ?? Promise.resolve(), 3000)
    await withTimeout(Promise.all(Array.from(d.images).map((img) => img.decode().catch(() => undefined))), 3000)
    return read(d, embeds)
  } finally {
    frame.remove()
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))])

// ---- the walk -------------------------------------------------------------------

interface Frame { x: number; y: number; w: number; h: number; rotation: number }

const INLINE_TAGS = new Set(['SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'INS', 'CODE', 'A', 'BR', 'SMALL', 'MARK', 'SUB', 'SUP', 'Q', 'ABBR', 'TIME', 'LABEL', 'CITE', 'KBD', 'VAR', 'DFN', 'BDI', 'BDO', 'WBR', 'DATA', 'FONT'])

const round = (n: number, p = 100) => Math.round(n * p) / p

/** rgb()/rgba() as the model writes colours: #rrggbb when opaque. */
export function cssToModelColor(v: string): string | null {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v.trim())
  if (!m) return v.trim().startsWith('#') ? v.trim() : null
  const [r, g, b] = [m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))))
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4])
  if (a <= 0) return 'transparent'
  if (a >= 1) return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`
  return `rgba(${r}, ${g}, ${b}, ${round(a, 1000)})`
}

const visibleColor = (c: string | null): c is string => !!c && c !== 'transparent'

/** Splits at commas outside parentheses. */
function topLevelSplit(s: string): string[] {
  const out: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1 }
  }
  out.push(s.slice(start).trim())
  return out.filter(Boolean)
}

const SIDE_ANGLES: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270, 'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135, 'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315 }

/** A computed `linear-gradient(…)` as the model's GradientFill. */
export function parseLinearGradient(v: string): GradientFill | null {
  const m = /^linear-gradient\((.*)\)$/.exec(v.trim())
  if (!m) return null
  const parts = topLevelSplit(m[1])
  let angle = 180
  if (/^-?[\d.]+(deg|turn|rad)$/.test(parts[0])) {
    const a = parts.shift()!
    angle = a.endsWith('turn') ? Number(a.slice(0, -4)) * 360 : a.endsWith('rad') ? Number(a.slice(0, -3)) * 180 / Math.PI : Number(a.slice(0, -3))
  } else if (parts[0]?.startsWith('to ')) {
    const side = parts.shift()!.slice(3).trim()
    if (!(side in SIDE_ANGLES)) return null
    angle = SIDE_ANGLES[side]
  }
  const stops: Array<{ at?: number; color: string }> = []
  for (const p of parts) {
    const sm = /^(.*?)\s+(-?[\d.]+)%$/.exec(p)
    const color = cssToModelColor(sm ? sm[1] : p)
    if (!color) return null
    stops.push({ color, at: sm ? Number(sm[2]) / 100 : undefined })
  }
  if (stops.length < 2) return null
  stops.forEach((s, i) => { if (s.at === undefined) s.at = i / (stops.length - 1) })
  return { angle: round(((angle % 360) + 360) % 360), stops: stops.map((s) => ({ at: round(Math.max(0, Math.min(1, s.at!)), 1000), color: s.color })) }
}

/** A computed box-shadow list as ShadowSpec[] (inset and spread dropped). */
function parseShadows(v: string): ShadowSpec[] {
  if (!v || v === 'none') return []
  const out: ShadowSpec[] = []
  for (const part of topLevelSplit(v)) {
    if (/\binset\b/.test(part)) continue
    const colorM = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(part)
    const color = colorM ? cssToModelColor(colorM[1]) : '#000000'
    const nums = part.replace(colorM?.[1] ?? '', '').trim().split(/\s+/).map((n) => parseFloat(n)).filter((n) => Number.isFinite(n))
    if (!visibleColor(color) || nums.length < 2) continue
    out.push({ x: round(nums[0]), y: round(nums[1]), blur: round(nums[2] ?? 0), color })
  }
  return out
}

function rotationOf(cs: CSSStyleDeclaration): number {
  let deg = 0
  const t = cs.transform
  if (t && t !== 'none') {
    const m = /^matrix\(([^)]*)\)$/.exec(t)
    if (m) {
      const [a, b] = m[1].split(',').map(Number)
      deg += Math.atan2(b, a) * 180 / Math.PI
    }
  }
  const r = cs.rotate
  if (r && r !== 'none') {
    const m = /(-?[\d.]+)deg$/.exec(r)
    if (m) deg += Number(m[1])
  }
  return deg
}

const px = (v: string) => parseFloat(v) || 0

interface Ctx {
  doc: SlidomingoDoc
  slide: Slide
  size: { width: number; height: number }
  win: Window
  notes: Set<string>
  out: SlideElement[]
  ids: Set<string>
  /** ids the HTML asks for somewhere: a generated id never takes one */
  reserved: Set<string>
  autoPrefix: string
  auto: number
  bodyFont: string
  headingFont: string
  titled: boolean
  background?: string
  /** the full-slide root box was read as the slide background */
  rootTaken: boolean
  /** existing elements by id (data-keep, element: pictures) */
  existing: Map<string, SlideElement>
  /** data-bs-img number → the picture element's id */
  imageIds: Map<string, string>
  /** srcdoc of each self-contained iframe, by data-bs-embed number */
  embeds: string[]
}

/** The id an HTML element gives its slide element (unique on the slide). */
function claimId(ctx: Ctx, wanted: string | null, suffix = ''): string {
  const clean = wanted ? wanted.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 80) : ''
  if (clean) {
    const id = clean + suffix
    if (!ctx.ids.has(id)) { ctx.ids.add(id); return id }
    ctx.notes.add(`The id "${id}" is used twice; the second one got a new id.`)
  }
  let id: string
  do id = `${ctx.autoPrefix}${++ctx.auto}`; while (ctx.ids.has(id) || ctx.reserved.has(id))
  ctx.ids.add(id)
  return id
}

function frameOf(el: Element, rotation: number): Frame {
  const r = el.getBoundingClientRect()
  if (Math.abs(rotation) < 0.01) return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height), rotation: 0 }
  // rotated: the bounding rect is the rotated box's hull; its centre is the
  // box's centre, the box's own size is the untransformed layout size
  const h = el as HTMLElement
  const w = h.offsetWidth, hh = h.offsetHeight
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2
  return { x: round(cx - w / 2), y: round(cy - hh / 2), w, h: hh, rotation: round(((rotation % 360) + 540) % 360 - 180) }
}

/** `f` shrunk by insets given in the box's own (unrotated) axes. */
function inset(f: Frame, l: number, t: number, r: number, b: number): Frame {
  const w = Math.max(0, f.w - l - r), h = Math.max(0, f.h - t - b)
  const dx = (l - r) / 2, dy = (t - b) / 2
  const a = f.rotation * Math.PI / 180
  const cx = f.x + f.w / 2 + dx * Math.cos(a) - dy * Math.sin(a)
  const cy = f.y + f.h / 2 + dx * Math.sin(a) + dy * Math.cos(a)
  return { x: round(cx - w / 2), y: round(cy - h / 2), w: round(w), h: round(h), rotation: f.rotation }
}

function contentBox(f: Frame, cs: CSSStyleDeclaration): Frame {
  return inset(f,
    px(cs.paddingLeft) + px(cs.borderLeftWidth), px(cs.paddingTop) + px(cs.borderTopWidth),
    px(cs.paddingRight) + px(cs.borderRightWidth), px(cs.paddingBottom) + px(cs.borderBottomWidth))
}

const isEl = (n: Node): n is Element => n.nodeType === Node.ELEMENT_NODE

const hasText = (n: Node): boolean => /\S/.test(n.textContent ?? '') || (n instanceof Element && !!n.querySelector('br'))

/** Only inline content (text and inline tags, recursively). */
function inlineOnly(ctx: Ctx, el: Element): boolean {
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE || c.nodeType === Node.COMMENT_NODE) continue
    if (!isEl(c)) return false
    if (!INLINE_TAGS.has(c.tagName)) return false
    const d = ctx.win.getComputedStyle(c).display
    if (d === 'none') continue
    if (!d.startsWith('inline') && d !== 'contents') return false
    if (!inlineOnly(ctx, c)) return false
  }
  return true
}

/** A list whose items hold only inline content or nested lists. */
function textList(ctx: Ctx, el: Element): boolean {
  if (el.tagName !== 'UL' && el.tagName !== 'OL') return false
  return Array.from(el.children).every((li) => li.tagName === 'LI' && Array.from(li.childNodes).every((c) =>
    c.nodeType !== Node.ELEMENT_NODE || (INLINE_TAGS.has((c as Element).tagName) && inlineOnly(ctx, c as Element)) || textList(ctx, c as Element)))
}

const isFlexOrGrid = (d: string) => /flex|grid/.test(d)

/** A line of a multi-line text: a plain div/p in the flow, no box of its own
 *  (no margin, padding, border or paint) and the text style of its block —
 *  how the editor stores lines, so a text element comes back as ONE element. */
function lineBlock(ctx: Ctx, c: Element, parent: CSSStyleDeclaration): boolean {
  if (c.tagName !== 'DIV' && c.tagName !== 'P') return false
  const cs = ctx.win.getComputedStyle(c)
  if (cs.display !== 'block' || cs.position !== 'static' || cs.float !== 'none') return false
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    if (px(cs.getPropertyValue(`margin-${side.toLowerCase()}`)) || px(cs.getPropertyValue(`padding-${side.toLowerCase()}`)) || px(cs.getPropertyValue(`border-${side.toLowerCase()}-width`))) return false
  }
  if (visibleColor(cssToModelColor(cs.backgroundColor)) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none') return false
  if (cs.fontSize !== parent.fontSize || cs.color !== parent.color || cs.fontWeight !== parent.fontWeight || cs.textAlign !== parent.textAlign || cs.lineHeight !== parent.lineHeight || cs.fontFamily !== parent.fontFamily) return false
  return textContentOnly(ctx, c, cs)
}

/** Only text: inline runs, lines (lineBlock) and lists. */
function textContentOnly(ctx: Ctx, el: Element, cs: CSSStyleDeclaration): boolean {
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE || c.nodeType === Node.COMMENT_NODE) continue
    if (!isEl(c)) return false
    const d = ctx.win.getComputedStyle(c).display
    if (d === 'none') continue
    if (INLINE_TAGS.has(c.tagName) && (d.startsWith('inline') || d === 'contents') && inlineOnly(ctx, c)) continue
    if (textList(ctx, c) || lineBlock(ctx, c, cs)) continue
    return false
  }
  return true
}

/** A text block: one text element (content box), not a box of boxes. */
function isTextBlock(ctx: Ctx, el: Element, cs: CSSStyleDeclaration): boolean {
  if (!hasText(el)) return false
  if (textList(ctx, el)) return true
  if (!textContentOnly(ctx, el, cs)) return false
  // a flex/grid box lays out each inline child as its own box: one run only
  if (isFlexOrGrid(cs.display)) {
    const runs = Array.from(el.childNodes).filter((c) => c.nodeType === Node.ELEMENT_NODE || /\S/.test(c.textContent ?? ''))
    return runs.length <= 1
  }
  return true
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function transformText(s: string, tt: string): string {
  if (tt === 'uppercase') return s.toUpperCase()
  if (tt === 'lowercase') return s.toLowerCase()
  if (tt === 'capitalize') return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase())
  return s
}

const isBold = (w: string) => Number(w) >= 600 || w === 'bold'
const decorations = (cs: CSSStyleDeclaration) => cs.textDecorationLine || cs.textDecoration || ''

/**
 * The rich-text html of `el`'s content, relative to `base` (the style the
 * text element itself gets): weight, italics, underline, strike, colour and
 * size that differ become b/i/u/s and a colour/size span — the subset
 * sanitizeHtml keeps — so styling done with CSS classes survives.
 */
function richHtml(ctx: Ctx, el: Element, base: CSSStyleDeclaration): string {
  const pre = /^pre/.test(base.whiteSpace)
  let out = ''
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE) {
      let text = transformText(c.textContent ?? '', base.textTransform)
      text = escapeText(text)
      if (pre) text = text.replace(/\n/g, '<br>')
      out += text
      continue
    }
    if (!isEl(c)) continue
    const tag = c.tagName
    const cs = ctx.win.getComputedStyle(c)
    if (cs.display === 'none') continue
    if (tag === 'BR') { out += '<br>'; continue }
    if (tag === 'UL' || tag === 'OL' || tag === 'LI') { out += `<${tag.toLowerCase()}>${richHtml(ctx, c, base)}</${tag.toLowerCase()}>`; continue }
    if (tag === 'DIV' || tag === 'P' || /^H[1-6]$/.test(tag)) { out += `<div>${richHtml(ctx, c, cs)}</div>`; continue }
    let open = '', close = ''
    const wrap = (t: string) => { open += `<${t}>`; close = `</${t}>` + close }
    if (tag === 'A' && c.getAttribute('href')) { open += `<a href="${escapeText(c.getAttribute('href')!).replace(/"/g, '&quot;')}">`; close = '</a>' + close }
    if (tag === 'CODE') wrap('code')
    if (isBold(cs.fontWeight) && !isBold(base.fontWeight)) wrap('b')
    if (cs.fontStyle === 'italic' && base.fontStyle !== 'italic') wrap('i')
    const dec = decorations(cs), baseDec = decorations(base)
    if (dec.includes('underline') && !baseDec.includes('underline') && tag !== 'A') wrap('u')
    if (dec.includes('line-through') && !baseDec.includes('line-through')) wrap('s')
    const styles: string[] = []
    const color = cssToModelColor(cs.color)
    if (color && color !== cssToModelColor(base.color) && tag !== 'A') styles.push(`color:${color}`)
    if (Math.abs(px(cs.fontSize) - px(base.fontSize)) > 0.25 && tag !== 'CODE') styles.push(`font-size:${round(px(cs.fontSize))}px`)
    if (styles.length) { open += `<span style="${styles.join(';')}">`; close = '</span>' + close }
    out += open + richHtml(ctx, c, cs) + close
  }
  return out
}

const ALIGN = (cs: CSSStyleDeclaration): TextElement['align'] => {
  const a = cs.textAlign
  if (a === 'center' || a === '-webkit-center') return 'center'
  if (a === 'right' || a === 'end' || a === '-webkit-right') return cs.direction === 'rtl' && a === 'end' ? 'left' : 'right'
  return 'left'
}

function valignOf(el: Element, cs: CSSStyleDeclaration): TextElement['valign'] {
  const data = el.getAttribute('data-valign')
  if (data === 'middle' || data === 'bottom' || data === 'top') return data
  const pick = (v: string): TextElement['valign'] => (v === 'center' || v === 'safe center' ? 'middle' : v === 'flex-end' || v === 'end' ? 'bottom' : 'top')
  if (/flex/.test(cs.display)) return pick(cs.flexDirection.startsWith('column') ? cs.justifyContent : cs.alignItems)
  if (/grid/.test(cs.display)) return pick(cs.alignContent !== 'normal' ? cs.alignContent : cs.alignItems)
  if (cs.display === 'table-cell') return cs.verticalAlign === 'middle' ? 'middle' : cs.verticalAlign === 'bottom' ? 'bottom' : 'top'
  return 'top'
}

function fontFamilyFor(ctx: Ctx, cs: CSSStyleDeclaration, heading: boolean): string {
  const fam = cs.fontFamily
  const norm = (s: string) => s.replace(/["']/g, '').replace(/\s*,\s*/g, ',').trim().toLowerCase()
  if (norm(fam) === norm(heading ? ctx.headingFont : ctx.bodyFont)) return ''
  if (!heading && norm(fam) === norm(ctx.bodyFont)) return ''
  return fam
}

function lineHeightOf(cs: CSSStyleDeclaration): number {
  if (cs.lineHeight === 'normal') return 1.2
  const fs = px(cs.fontSize) || 16
  return round(px(cs.lineHeight) / fs, 1000)
}

/** Element-level opacity: CSS opacity multiplies down the tree. */
function opacityOf(ctx: Ctx, el: Element): number {
  let o = 1
  for (let n: Element | null = el; n && n !== ctx.win.document.body; n = n.parentElement) o *= Number(ctx.win.getComputedStyle(n).opacity)
  return round(o, 1000)
}

function cumulativeRotation(ctx: Ctx, el: Element): number {
  let r = 0
  for (let n: Element | null = el; n && n !== ctx.win.document.body; n = n.parentElement) r += rotationOf(ctx.win.getComputedStyle(n))
  return r
}

function roleFor(ctx: Ctx, el: Element): string | undefined {
  const r = el.getAttribute('data-role')
  if (r) return r
  if (el.tagName === 'H1' && !ctx.titled) { ctx.titled = true; return 'title' }
  return undefined
}

function base(f: Frame, opacity: number) {
  return { x: f.x, y: f.y, w: f.w, h: f.h, rotation: f.rotation, opacity }
}

/** Whether `el`'s text is ONE line exactly as wide as the box `f` it sits in
 *  (the box shrink-wrapped it: a flex item, inline-block, max-content). */
function shrinkWrappedLine(ctx: Ctx, el: Element, f: Frame): boolean {
  const range = ctx.win.document.createRange()
  range.selectNodeContents(el)
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
  if (!rects.length || new Set(rects.map((r) => Math.round(r.bottom))).size > 1) return false
  const width = Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left))
  return Math.abs(width - f.w) < 0.75
}

/** px of room a one-line text gets, so redrawn at its exact (shrink-wrapped)
 *  width it cannot wrap its last word onto a second line */
const ONE_LINE_SLACK = 2

function emitText(ctx: Ctx, el: Element, cs: CSSStyleDeclaration, f: Frame, id: string, html: string, opacity: number, role?: string) {
  const heading = role === 'title' || /^H[1-6]$/.test(el.tagName)
  // a box with room to spare keeps its width, so writing a slide back adds nothing
  if (f.rotation === 0 && shrinkWrappedLine(ctx, el, f)) {
    const a = ALIGN(cs)
    f = { ...f, w: round(f.w + ONE_LINE_SLACK), x: round(a === 'center' ? f.x - ONE_LINE_SLACK / 2 : a === 'right' ? f.x - ONE_LINE_SLACK : f.x) }
  }
  let content = html.trim()
  if (cs.fontStyle === 'italic') content = `<i>${content}</i>`
  const dec = decorations(cs)
  if (dec.includes('underline')) content = `<u>${content}</u>`
  if (dec.includes('line-through')) content = `<s>${content}</s>`
  const text: TextElement = {
    id, type: 'text', ...base(f, opacity),
    html: content,
    fontSize: round(px(cs.fontSize)),
    fontFamily: fontFamilyFor(ctx, cs, heading && role === 'title'),
    fontWeight: Number(cs.fontWeight) || (isBold(cs.fontWeight) ? 700 : 400),
    color: cssToModelColor(cs.color) ?? '#000000',
    align: ALIGN(cs),
    valign: valignOf(el, cs),
    lineHeight: lineHeightOf(cs),
  }
  if (cs.letterSpacing !== 'normal' && px(cs.letterSpacing)) text.letterSpacing = round(px(cs.letterSpacing))
  if (role) text.role = role
  const shadows = parseShadows(cs.textShadow)
  if (shadows.length) text.shadow = shadows.length === 1 ? shadows[0] : shadows
  ctx.out.push(text)
}

/** A painted box: background, uniform border, radius, shadow. Uneven
 *  borders become thin rects of their own (an accent bar on one side). */
function emitPaint(ctx: Ctx, cs: CSSStyleDeclaration, f: Frame, id: string, opacity: number): boolean {
  const bgColor = cssToModelColor(cs.backgroundColor)
  const img = cs.backgroundImage
  const grad = img && img !== 'none' ? parseLinearGradient(topLevelSplit(img)[0]) : null
  if (img && img !== 'none' && !grad) ctx.notes.add(`A background on #${id} that is not one linear gradient was left out.`)
  const sides = (['Top', 'Right', 'Bottom', 'Left'] as const).map((s) => ({
    s, w: px(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)),
    color: cssToModelColor(cs.getPropertyValue(`border-${s.toLowerCase()}-color`)),
    style: cs.getPropertyValue(`border-${s.toLowerCase()}-style`),
  })).map((b) => ({ ...b, on: b.w > 0 && b.style !== 'none' && b.style !== 'hidden' && visibleColor(b.color) }))
  const shadows = parseShadows(cs.boxShadow)
  const fill = grad ? grad.stops[0].color : bgColor
  const anyBorder = sides.some((b) => b.on)
  if (!visibleColor(fill) && !anyBorder && !shadows.length) return false
  const uniform = sides.every((b) => b.on === sides[0].on && b.w === sides[0].w && b.color === sides[0].color && b.style === sides[0].style)
  const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
  const pct = radii.map((r) => (r.endsWith('%') ? parseFloat(r) : null))
  const ellipse = pct.every((p) => p !== null && p >= 50) || (f.w === f.h && radii.every((r) => !r.endsWith('%') && px(r) >= f.w / 2 - 0.5))
  const r0 = radii[0].endsWith('%') ? (parseFloat(radii[0]) / 100) * Math.min(f.w, f.h) : px(radii[0].split(' ')[0])
  const shape: ShapeElement = {
    id, type: 'shape', shape: ellipse ? 'ellipse' : 'rect', ...base(f, opacity),
    fill: visibleColor(fill) ? fill : 'transparent',
    stroke: uniform && sides[0].on ? sides[0].color! : 'transparent',
    strokeWidth: uniform && sides[0].on ? round(sides[0].w) : 0,
    radius: ellipse ? 0 : round(Math.min(r0, f.w / 2, f.h / 2)),
  }
  if (grad) shape.fillGradient = grad
  if (uniform && sides[0].on && (sides[0].style === 'dashed' || sides[0].style === 'dotted')) shape.strokeStyle = sides[0].style
  if (shadows.length) shape.shadow = shadows.length === 1 ? shadows[0] : shadows
  if (!ellipse && new Set(radii).size > 1) ctx.notes.add(`#${id}: corners with different radii became one radius.`)
  ctx.out.push(shape)
  if (!uniform) {
    const rad = (r: string) => (r.endsWith('%') ? (parseFloat(r) / 100) * Math.min(f.w, f.h) : px(r.split(' ')[0]))
    const [tl, tr, br, bl] = radii.map(rad)
    for (const b of sides) {
      if (!b.on) continue
      const corners = b.s === 'Left' ? [tl, bl] : b.s === 'Right' ? [tr, br] : b.s === 'Top' ? [tl, tr] : [bl, br]
      const bar = sideBorder(b.s, b.w, Math.min(corners[0], f.w / 2, f.h / 2), Math.min(corners[1], f.w / 2, f.h / 2), f.w, f.h)
      const a = f.rotation * Math.PI / 180
      const bcx = bar.x + bar.w / 2 - f.w / 2, bcy = bar.y + bar.h / 2 - f.h / 2
      const cx = f.x + f.w / 2 + bcx * Math.cos(a) - bcy * Math.sin(a), cy = f.y + f.h / 2 + bcx * Math.sin(a) + bcy * Math.cos(a)
      const el: ShapeElement = {
        id: claimId(ctx, id, `-border-${b.s.toLowerCase()}`), type: 'shape', shape: bar.d ? 'path' : 'rect',
        x: round(cx - bar.w / 2), y: round(cy - bar.h / 2), w: round(bar.w), h: round(bar.h), rotation: f.rotation, opacity,
        fill: b.color!, stroke: 'transparent', strokeWidth: 0, radius: 0,
      }
      if (bar.d) { el.d = bar.d; el.pathBox = [0, 0, round(bar.w), round(bar.h)] }
      ctx.out.push(el)
    }
  }
  return true
}

/** Quarter-circle handle length for a cubic Bézier. */
const K = 0.5523

/**
 * One side's border of a box whose other sides have none, in the box's own
 * coordinates: a plain bar, or — under rounded corners — the shape CSS
 * draws, following the corner and thinning to nothing along it (`d`, in a
 * pathBox of the bar's size). `r1`/`r2` are the radii of the side's two
 * corners (top then bottom for left/right, left then right for top/bottom).
 */
function sideBorder(side: 'Top' | 'Right' | 'Bottom' | 'Left', bw: number, r1: number, r2: number, boxW: number, boxH: number): { x: number; y: number; w: number; h: number; d?: string } {
  const vertical = side === 'Left' || side === 'Right'
  const len = vertical ? boxH : boxW
  const depth = Math.max(bw, r1, r2)
  const box = side === 'Left' ? { x: 0, y: 0, w: depth, h: len } : side === 'Right' ? { x: boxW - depth, y: 0, w: depth, h: len }
    : side === 'Top' ? { x: 0, y: 0, w: len, h: depth } : { x: 0, y: boxH - depth, w: len, h: depth }
  if (r1 <= 0.5 && r2 <= 0.5) return side === 'Left' ? { x: 0, y: 0, w: bw, h: len } : side === 'Right' ? { x: boxW - bw, y: 0, w: bw, h: len }
    : side === 'Top' ? { x: 0, y: 0, w: len, h: bw } : { x: 0, y: boxH - bw, w: len, h: bw }
  // drawn as the LEFT border (u across the border, v along it), then mapped
  const i1 = Math.max(r1 - bw, 0), i2 = Math.max(r2 - bw, 0)
  const pts: Array<[string, number[]]> = [
    ['M', [r1, 0]],
    ['C', [r1 - r1 * K, 0, 0, r1 - r1 * K, 0, r1]],
    ['L', [0, len - r2]],
    ['C', [0, len - r2 + r2 * K, r2 - r2 * K, len, r2, len]],
    ['C', [r2 - i2 * K, len, bw, len - r2 + r2 * K, bw, len - r2]],
    ['L', [bw, r1]],
    ['C', [bw, r1 - r1 * K, r1 - i1 * K, 0, r1, 0]],
  ]
  const map = (u: number, v: number): [number, number] => side === 'Left' ? [u, v] : side === 'Right' ? [depth - u, v]
    : side === 'Top' ? [v, u] : [v, depth - u]
  const d = pts.map(([cmd, ns]) => {
    const out: string[] = []
    for (let i = 0; i < ns.length; i += 2) { const [x, y] = map(ns[i], ns[i + 1]); out.push(`${round(x)} ${round(y)}`) }
    return `${cmd}${out.join(' ')}`
  }).join(' ') + ' Z'
  return { ...box, d }
}

function resolveImgSrc(ctx: Pick<Ctx, 'doc' | 'existing'>, raw: string): { src: string; loadable: string } | null {
  const v = raw.trim()
  if (v.startsWith('data:image/')) return { src: v, loadable: v }
  const asLoadable = (src: string): string | null => {
    if (src.startsWith('data:')) return src
    if (src.startsWith('asset:')) {
      const a = ctx.doc.assets?.[src.slice(6)]
      if (typeof a !== 'string') return null
      return a.startsWith('data:') ? a : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(a)}`
    }
    return null
  }
  if (v.startsWith('asset:')) { const l = asLoadable(v); return l ? { src: v, loadable: l } : null }
  if (v.startsWith('element:')) {
    const e = ctx.existing.get(v.slice(8)) ?? findElement(ctx.doc, v.slice(8))
    if (!e || (e.type !== 'image')) return null
    const l = asLoadable(e.src)
    return l ? { src: e.src, loadable: l } : null
  }
  return null
}

function findElement(doc: SlidomingoDoc, id: string): SlideElement | undefined {
  for (const s of [...doc.slides, ...(doc.layouts ?? []), ...(doc.reusableObjects ?? [])]) {
    const e = s.elements.find((x) => x.id === id)
    if (e) return e
  }
  return undefined
}

function emitImage(ctx: Ctx, el: HTMLImageElement, cs: CSSStyleDeclaration, f: Frame, id: string, opacity: number) {
  const raw = el.getAttribute('data-bs-src') ?? ''
  const got = resolveImgSrc(ctx, raw)
  if (!got) {
    ctx.notes.add(`The picture #${id} was left out: src must be a data: URI, asset:<key> or element:<id of a picture> (no downloads).`)
    return
  }
  const fitCss = cs.objectFit
  const image: ImageElement = {
    id, type: 'image', ...base(f, opacity),
    src: got.src,
    fit: fitCss === 'cover' ? 'cover' : fitCss === 'fill' ? 'fill' : 'contain',
    radius: round(Math.min(px(cs.borderTopLeftRadius), f.w / 2, f.h / 2)),
  }
  const alt = el.getAttribute('alt')
  if (alt !== null) image.alt = alt
  const shadows = parseShadows(cs.boxShadow)
  if (shadows.length) image.shadow = shadows.length === 1 ? shadows[0] : shadows
  const n = el.getAttribute('data-bs-img')
  if (n !== null) ctx.imageIds.set(n, id)
  ctx.out.push(image)
}

function emitTable(ctx: Ctx, table: HTMLTableElement, cs: CSSStyleDeclaration, f: Frame, id: string, opacity: number) {
  const trs = Array.from(table.rows)
  if (!trs.length) return
  const header = !!table.tHead?.rows.length || Array.from(trs[0].cells).every((c) => c.tagName === 'TH')
  const nCols = Math.max(...trs.map((tr) => Array.from(tr.cells).reduce((n, c) => n + Math.max(1, c.colSpan), 0)))
  // column widths: from the first row whose cells all span one column
  const plain = trs.find((tr) => tr.cells.length === nCols)
  const columns = plain
    ? Array.from(plain.cells).map((c) => ({ w: round(c.getBoundingClientRect().width / f.w, 10000) }))
    : Array.from({ length: nCols }, () => ({ w: round(1 / nCols, 10000) }))
  const cellStyle = (c: Element) => ctx.win.getComputedStyle(c)
  // what a cell is painted with: its own background, else its row's, else its
  // row group's (thead/tbody) — CSS paints all three, the model has cells only
  const paintOf = (c: Element): string | null => {
    for (let n: Element | null = c; n && n !== table; n = n.parentElement) {
      const v = cssToModelColor(ctx.win.getComputedStyle(n).backgroundColor)
      if (visibleColor(v)) return v
    }
    return null
  }
  const headCell = header ? trs[0].cells[0] : null
  const bodyRows = header ? trs.slice(1) : trs
  const body0 = bodyRows[0]?.cells[0] ?? trs[0].cells[0]
  const bs = cellStyle(body0)
  const hs = headCell ? cellStyle(headCell) : bs
  const rowBg = (tr?: HTMLTableRowElement) => (tr?.cells[0] ? paintOf(tr.cells[0]) : null)
  const bg0 = rowBg(bodyRows[0]), bg1 = rowBg(bodyRows[1])
  const bodyFont = fontFamilyFor(ctx, bs, false)
  const style: TableElement['style'] = {
    headerBg: (header && headCell && paintOf(headCell)) || 'transparent',
    headerColor: cssToModelColor(hs.color) ?? '#000000',
    borderColor: cssToModelColor(bs.borderBottomColor) ?? 'transparent',
    borderWidth: bs.borderBottomStyle === 'none' ? 0 : round(px(bs.borderBottomWidth)),
    cellPadX: round(px(bs.paddingLeft)),
    cellPadY: round(px(bs.paddingTop)),
    fontSize: round(px(bs.fontSize)),
    color: cssToModelColor(bs.color) ?? '#000000',
    radius: round(px(cs.borderTopLeftRadius)),
  }
  if (bodyFont) style.fontFamily = bodyFont
  // stripes only when the body really alternates; one coloured row stays a
  // per-cell colour (a zebra would paint every other row with it)
  const bodyBgs = bodyRows.map((tr) => rowBg(tr))
  const evens = bodyBgs.filter((_, i) => i % 2 === 0), odds = bodyBgs.filter((_, i) => i % 2 === 1)
  if (bg1 && bg1 !== bg0 && odds.length >= 2 && odds.every((b) => b === bg1) && evens.every((b) => b === bg0)) style.zebra = bg1
  const cellOf = (c: HTMLTableCellElement, ri: number): TableCell => {
    const s = cellStyle(c)
    const cell: TableCell = { html: richHtml(ctx, c, s).trim() }
    const align = ALIGN(s)
    if (align !== 'left') cell.align = align
    const isHead = header && ri === 0
    const color = cssToModelColor(s.color)
    if (color && color !== (isHead ? style.headerColor : style.color)) cell.color = color
    const bg = paintOf(c)
    const rowDefault = isHead ? style.headerBg : (style.zebra && (ri - (header ? 1 : 0)) % 2 === 1 ? style.zebra : bg0)
    if (visibleColor(bg) && bg !== rowDefault) cell.bg = bg
    if (!isHead && isBold(s.fontWeight) && !isBold(bs.fontWeight)) cell.bold = true
    if (c.colSpan > 1) cell.colspan = Math.min(c.colSpan, nCols)
    if (c.rowSpan > 1) cell.rowspan = Math.min(c.rowSpan, trs.length - ri)
    return cell
  }
  // the model keeps one cell per grid position: positions a span covers get
  // an empty cell (tablespans.ts), which HTML leaves out
  const grid: Array<Array<TableCell | undefined>> = trs.map(() => new Array(nCols).fill(undefined))
  trs.forEach((tr, ri) => {
    let col = 0
    for (const c of Array.from(tr.cells)) {
      while (col < nCols && grid[ri][col]) col++
      if (col >= nCols) break
      const cell = cellOf(c, ri)
      grid[ri][col] = cell
      for (let dr = 0; dr < (cell.rowspan ?? 1); dr++) {
        for (let dc = 0; dc < (cell.colspan ?? 1); dc++) if ((dr || dc) && grid[ri + dr] && col + dc < nCols) grid[ri + dr][col + dc] = { html: '' }
      }
      col += cell.colspan ?? 1
    }
  })
  const rows = grid.map((r) => ({ cells: r.map((c) => c ?? { html: '' }) }))
  const heights = trs.map((tr) => tr.getBoundingClientRect().height)
  if (Math.max(...heights) - Math.min(...heights) > 2) ctx.notes.add(`#${id}: the rows of a slide table share its height evenly; the HTML gave them different heights (${Math.round(Math.min(...heights))}–${Math.round(Math.max(...heights))}px).`)
  if (rows.some((r) => r.cells.some((c) => c.colspan || c.rowspan))) ctx.notes.add(`#${id}: merged cells kept; check the table with review_slide.`)
  ctx.out.push({ id, type: 'table', ...base(f, opacity), columns, rows, header, style } as TableElement)
}

/** The presentation properties an svg node's look comes from. */
const SVG_PAINT = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'font-size', 'font-family', 'font-weight', 'text-anchor']

/**
 * An inline <svg> drawing → native shapes, paths and text, exactly as the
 * editor's Convert to objects makes them (svgconvert.ts reads the drawing off
 * the live DOM: no second SVG interpreter). The deck never gets an opaque svg
 * element (DECISIONS 2026-10-11): what comes out can be edited piece by piece.
 * Pieces are `<id>-1`, `<id>-2`, … in drawing order, so a rewrite updates them.
 */
function emitSvg(ctx: Ctx, el: Element, f: Frame, id: string, opacity: number) {
  // the page's CSS does not travel with the markup: paint set by a class or an
  // inherited rule is written onto each node of a copy first
  const copy = el.cloneNode(true) as Element
  const from = [el, ...Array.from(el.querySelectorAll('*'))], to = [copy, ...Array.from(copy.querySelectorAll('*'))]
  from.forEach((n, i) => {
    const cs = ctx.win.getComputedStyle(n)
    for (const prop of SVG_PAINT) {
      const v = cs.getPropertyValue(prop)
      if (v && v !== 'normal') to[i].setAttribute(prop, v)
    }
  })
  copy.removeAttribute('style')
  copy.removeAttribute('class')
  const drawing = { id, type: 'svg', x: f.x, y: f.y, w: f.w, h: f.h, rotation: f.rotation, opacity, markup: copy.outerHTML } as SvgElement
  const r = convertSvgToObjects(drawing, ctx.doc)
  if ('error' in r) { ctx.notes.add(`The drawing #${id} was left out: ${r.error}`); return }
  const norm = (v: string) => v.replace(/["']/g, '').replace(/\s*,\s*/g, ',').trim().toLowerCase()
  r.elements.forEach((piece, k) => {
    piece.id = claimId(ctx, id, `-${k + 1}`)
    if (piece.groupId) piece.groupId = `${id}-group`
    // text in the theme font follows the theme, as everywhere else
    if (piece.type === 'text' && piece.fontFamily && norm(piece.fontFamily) === norm(ctx.bodyFont)) piece.fontFamily = ''
    ctx.out.push(piece)
  })
  for (const n of r.notes) ctx.notes.add(`The drawing #${id}: ${n}.`)
}

function emitChart(ctx: Ctx, el: Element, f: Frame, id: string, opacity: number) {
  let spec: unknown
  try { spec = JSON.parse(el.getAttribute('data-chart') ?? '') } catch { ctx.notes.add(`#${id}: data-chart is not JSON; the chart was left out.`); return }
  if (!spec || typeof spec !== 'object') return
  const s = spec as Record<string, unknown>
  const option = (s.option && typeof s.option === 'object' ? s.option : s) as Record<string, unknown>
  const chart: ChartElement = { id, type: 'chart', ...base(f, opacity), option }
  if (typeof s.preset === 'string') chart.preset = s.preset
  else {
    const t = (option.series as Array<{ type?: string }> | undefined)?.[0]?.type
    if (t) chart.preset = t
  }
  const alt = el.getAttribute('aria-label') ?? el.getAttribute('data-alt')
  if (alt !== null) chart.alt = alt
  ctx.out.push(chart)
}

function emitCode(ctx: Ctx, el: Element, cs: CSSStyleDeclaration, f: Frame, id: string, opacity: number) {
  const code: CodeElement = {
    id, type: 'code', ...base(f, opacity),
    content: el.textContent ?? '',
    fontSize: round(px(cs.fontSize)),
    fontFamily: cs.fontFamily,
    align: ALIGN(cs),
    valign: 'top',
    lineHeight: lineHeightOf(cs),
    color: cssToModelColor(cs.color) ?? '#000000',
  }
  ctx.out.push(code)
}

/** Text that sits between boxes (mixed content) becomes one text element
 *  per run; boxes are visited in between, so paint order stays the DOM's. */
function visitChildren(ctx: Ctx, el: Element, cs: CSSStyleDeclaration, box: Frame, idBase: string | null, opacity: number) {
  let run: Node[] = []
  let runs = 0
  const flush = () => {
    const nodesInRun = run
    run = []
    if (!nodesInRun.some((n) => /\S/.test(n.textContent ?? ''))) return
    const range = ctx.win.document.createRange()
    range.setStartBefore(nodesInRun[0])
    range.setEndAfter(nodesInRun[nodesInRun.length - 1])
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
    if (!rects.length) return
    const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom))
    const left = Math.min(...rects.map((r) => r.left)), right = Math.max(...rects.map((r) => r.right))
    const content = contentBox(box, cs)
    const f: Frame = isFlexOrGrid(cs.display)
      ? { x: round(left), y: round(top), w: round(right - left), h: round(bottom - top), rotation: 0 }
      : { x: content.x, y: round(top), w: content.w, h: round(bottom - top), rotation: 0 }
    const holder = ctx.win.document.createElement('span')
    for (const n of nodesInRun) holder.appendChild(n.cloneNode(true))
    el.appendChild(holder)
    const html = richHtml(ctx, holder, cs)
    holder.remove()
    runs++
    emitText(ctx, el, cs, f, claimId(ctx, idBase, idBase ? `-text${runs > 1 ? runs : ''}` : ''), html, opacity)
  }
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) { run.push(n); continue }
    if (!(isEl(n))) continue
    if (INLINE_TAGS.has(n.tagName) && ctx.win.getComputedStyle(n).display.startsWith('inline') && !isFlexOrGrid(cs.display)) { run.push(n); continue }
    flush()
    visit(ctx, n)
  }
  flush()
}

function visit(ctx: Ctx, el: Element) {
  const cs = ctx.win.getComputedStyle(el)
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return
  const tag = el.tagName
  if (tag === 'STYLE' || tag === 'TITLE' || tag === 'HEAD') return
  const rot = cumulativeRotation(ctx, el)
  const f = frameOf(el, rot)
  const opacity = opacityOf(ctx, el)
  const wanted = el.getAttribute('id')
  if (cs.display === 'contents') { visitChildren(ctx, el, cs, f, wanted, opacity); return }

  if (el.hasAttribute('data-keep')) {
    const prev = wanted ? ctx.existing.get(wanted) : undefined
    if (!prev) { ctx.notes.add(`data-keep on "${wanted ?? '?'}": no element of that id on the slide, nothing kept.`); return }
    ctx.ids.add(prev.id)
    ctx.out.push({ ...prev, x: f.x, y: f.y, w: f.w, h: f.h, rotation: f.rotation, __keep: true } as unknown as SlideElement)
    return
  }
  if (f.w <= 0 && f.h <= 0 && tag !== 'HR') { visitChildren(ctx, el, cs, f, wanted, opacity); return }
  // the root WRAPPER covering the whole slide (a box holding the content)
  // paints the slide's background; an empty full-slide box is a backdrop shape
  const isRoot = el.parentElement === ctx.win.document.body && el.children.length > 0 && Math.abs(f.x) < 1 && Math.abs(f.y) < 1
    && Math.abs(f.w - ctx.size.width) < 1 && Math.abs(f.h - ctx.size.height) < 1 && f.rotation === 0
  if (isRoot && !ctx.rootTaken) {
    const bg = slideBackground(cs)
    const plain = !parseShadows(cs.boxShadow).length && px(cs.borderTopWidth) === 0 && px(cs.borderTopLeftRadius) === 0
    if (plain) {
      ctx.rootTaken = true
      if (bg) ctx.background = bg
      if (isTextBlock(ctx, el, cs)) emitText(ctx, el, cs, contentBox(f, cs), claimId(ctx, wanted), richHtml(ctx, el, cs), opacity, roleFor(ctx, el))
      else visitChildren(ctx, el, cs, f, wanted, opacity)
      return
    }
  }

  if (el.localName === 'svg') { emitSvg(ctx, el, f, claimId(ctx, wanted), opacity); return }
  if (tag === 'IMG') { emitImage(ctx, el as HTMLImageElement, cs, f, claimId(ctx, wanted), opacity); return }
  if (tag === 'HR') {
    const w = Math.max(px(cs.borderTopWidth), px(cs.borderBottomWidth), 1)
    const color = cssToModelColor(cs.borderTopColor) ?? '#000000'
    // data-arrow="end|start|both": arrowheads (the line runs left to right)
    const arrow = (el.getAttribute('data-arrow') ?? '').toLowerCase()
    const ends = { ...(arrow === 'start' || arrow === 'both' ? { lineStart: 'arrow' as const } : {}), ...(arrow === 'end' || arrow === 'both' ? { lineEnd: 'arrow' as const } : {}) }
    ctx.out.push({ id: claimId(ctx, wanted), type: 'shape', shape: 'line', ...base({ ...f, h: w }, opacity), fill: color, stroke: 'transparent', strokeWidth: w, radius: 0, ...ends } as ShapeElement)
    return
  }
  const id = claimId(ctx, wanted)
  const embed = el.getAttribute('data-bs-embed')
  if (embed !== null) {
    const html = ctx.embeds[Number(embed)] ?? ''
    if (html.length > MAX_EMBED_HTML) { ctx.notes.add(`The frame #${id} was left out: its document is longer than ${MAX_EMBED_HTML} characters.`); return }
    ctx.out.push({ id, type: 'embed', ...base(f, opacity), html } as SlideElement)
    ctx.notes.add(`#${id}: a self-contained <iframe> became an embed (it runs sandboxed, with no access to the deck).`)
    return
  }
  if (tag === 'TABLE') { emitTable(ctx, el as HTMLTableElement, cs, f, id, opacity); return }
  if (el.hasAttribute('data-chart') || tag === 'PRE') {
    // a styled chart/code box: the box is a shape of its own, behind
    const painted = emitPaint(ctx, cs, f, claimId(ctx, id, '-box'), opacity)
    if (tag === 'PRE') emitCode(ctx, el, cs, painted ? contentBox(f, cs) : f, id, opacity)
    else emitChart(ctx, el, painted ? contentBox(f, cs) : f, id, opacity)
    return
  }
  const painted = emitPaint(ctx, cs, f, id, opacity)
  if (isTextBlock(ctx, el, cs)) {
    // a list is its own text: the ul/ol itself becomes the list in the html
    const list = tag === 'UL' || tag === 'OL' ? tag.toLowerCase() : null
    const html = list ? `<${list}>${richHtml(ctx, el, cs)}</${list}>` : richHtml(ctx, el, cs)
    emitText(ctx, el, cs, contentBox(f, cs), painted ? claimId(ctx, id, '-text') : id, html, opacity, roleFor(ctx, el))
    return
  }
  visitChildren(ctx, el, cs, f, id, opacity)
}

/** A background the slide itself can carry: a colour or one linear gradient. */
function slideBackground(cs: CSSStyleDeclaration): string | null {
  const img = cs.backgroundImage
  if (img && img !== 'none') {
    const first = topLevelSplit(img)[0]
    if (/^(linear|radial)-gradient\(/.test(first) && first.length <= 200 && !/url\s*\(/i.test(first)) return first
  }
  const c = cssToModelColor(cs.backgroundColor)
  return visibleColor(c) ? c : null
}

/** A short, stable tag per slide for generated ids (no accidental morphs
 *  between slides that both got an id "h1"). */
function slideTag(slideId: string): string {
  let h = 2166136261
  for (let i = 0; i < slideId.length; i++) { h ^= slideId.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36).slice(0, 4)
}

/**
 * Lays `src` out at the slide's size and turns what the browser drew into
 * elements. Browser only (needs layout). The caller merges the result into
 * the slide (mergeCompiled) and commits it as one agent write.
 */
export async function compileSlideHtml(doc: SlidomingoDoc, slide: Slide, src: HtmlSlideSource, size: { width: number; height: number } = doc.size): Promise<CompileResult> {
  if ((src.html?.length ?? 0) + (src.css?.length ?? 0) > MAX_HTML_SOURCE) throw new Error(`The HTML is too long (at most ${MAX_HTML_SOURCE} characters, pictures included).`)
  const notes = new Set<string>()
  const existing = new Map(slide.elements.map((e) => [e.id, e]))
  const lookup = { doc, existing }
  const fonts = resolveSlideFonts(doc, slide)
  const result = await withLaidOut(doc, slide, size, src, (raw) => resolveImgSrc(lookup, raw)?.loadable ?? null, notes, (d, embeds) => {
    const win = d.defaultView!
    // the theme fonts as THIS document spells them back in computed styles
    // (Chrome rewrites e.g. BlinkMacSystemFont to "system-ui"): a text in the
    // theme font keeps fontFamily '' and follows later theme changes
    const probe = d.createElement('span')
    d.body.appendChild(probe)
    probe.style.fontFamily = 'var(--bs-font)'
    const bodyFont = win.getComputedStyle(probe).fontFamily || fonts.fontFamily || doc.theme.fontFamily
    probe.style.fontFamily = 'var(--bs-heading-font)'
    const headingFont = win.getComputedStyle(probe).fontFamily || bodyFont
    probe.remove()
    const ctx: Ctx = {
      doc, slide, size, win, notes, out: [], ids: new Set(), reserved: new Set(Array.from(d.body.querySelectorAll('[id]'), (e) => e.id)),
      autoPrefix: `h${slideTag(slide.id)}-`, auto: 0,
      bodyFont, headingFont, titled: false, rootTaken: false, existing, imageIds: new Map(), embeds,
    }
    const bodyCs = win.getComputedStyle(d.body)
    const htmlCs = win.getComputedStyle(d.documentElement)
    ctx.background = slideBackground(bodyCs) ?? slideBackground(htmlCs) ?? undefined
    const bodyBox: Frame = { x: 0, y: 0, w: size.width, h: size.height, rotation: 0 }
    visitChildren(ctx, d.body, bodyCs, bodyBox, null, 1)
    const elements: SlideElement[] = []
    for (const raw of ctx.out) {
      const keep = (raw as { __keep?: boolean }).__keep
      delete (raw as { __keep?: boolean }).__keep
      if (keep) { elements.push(raw); continue }
      if (raw.type === 'text') raw.html = sanitizeHtml(raw.html)
      if (raw.type === 'table') for (const r of raw.rows) for (const c of r.cells) c.html = sanitizeHtml(c.html)
      const clean = sanitizeElement(raw)
      if (clean) elements.push(clean)
      else notes.add(`An element (${raw.type} #${raw.id}) could not be made and was left out.`)
    }
    return { elements, background: ctx.background, notes: [...notes], remember: rememberable(src, ctx.imageIds) }
  })
  await loadFontsFor(doc, fonts, result.elements)
  return result
}

/**
 * The page loads an embedded face only when something first uses it. The
 * HTML was measured in its own document; before the layout guard measures
 * the new elements in THIS one, every face they are drawn in is loaded, or
 * it measures a fallback and "fixes" text that fits.
 */
async function loadFontsFor(doc: SlidomingoDoc, fonts: { fontFamily?: string; headingFamily?: string }, els: readonly SlideElement[]) {
  if (typeof document === 'undefined' || !document.fonts?.load) return
  const specs = new Set<string>()
  for (const e of els) {
    if (e.type !== 'text' && e.type !== 'code') continue
    const heading = e.type === 'text' && e.role === 'title'
    const family = e.fontFamily || (heading ? fonts.headingFamily || doc.theme.headingFamily : undefined) || fonts.fontFamily || doc.theme.fontFamily
    const weight = e.type === 'text' ? e.fontWeight : 400
    // the element's own weight, and bold for <b> runs inside it
    for (const w of new Set([weight, 700])) { specs.add(`${w} 16px ${family}`); specs.add(`italic ${w} 16px ${family}`) }
  }
  await withTimeout(Promise.all([...specs].map((f) => document.fonts.load(f).catch(() => []))), 3000)
}

// ---- merge, signature ------------------------------------------------------------

/** What HTML says about an element, per type: on a rewrite these come from
 *  the HTML (absent = removed); everything else stays as it was. */
export const HTML_OWNED: Readonly<Record<string, readonly string[]>> = {
  text: ['html', 'fontSize', 'fontFamily', 'fontWeight', 'color', 'align', 'valign', 'lineHeight', 'letterSpacing', 'shadow'],
  shape: ['shape', 'fill', 'fillGradient', 'stroke', 'strokeWidth', 'radius', 'strokeStyle', 'strokeDash', 'shadow'],
  image: ['src', 'fit', 'radius', 'shadow'],
  table: ['columns', 'rows', 'header', 'style'],
  chart: ['option', 'preset'],
  code: ['content', 'fontSize', 'fontFamily', 'align', 'valign', 'lineHeight', 'color'],
}
const FRAME_OWNED = ['x', 'y', 'w', 'h', 'rotation', 'opacity']

/**
 * The slide's new element list: the compiled elements in their order, each
 * one that has an existing twin (same id, same type) keeping the twin's
 * properties HTML cannot express — fx, link, locks, groups, comments' anchor,
 * provenance, a crop. `keepIds` (inherited slide-type chrome) survive even
 * when the HTML leaves them out, in their old place in the paint order.
 */
export function mergeCompiled(existing: readonly SlideElement[], compiled: readonly SlideElement[], keepIds: ReadonlySet<string> = new Set()): { elements: SlideElement[]; updated: string[]; added: string[]; removed: string[] } {
  const byId = new Map(existing.map((e) => [e.id, e]))
  const updated: string[] = [], added: string[] = []
  const merged: SlideElement[] = compiled.map((c) => {
    const prev = byId.get(c.id)
    if (!prev || prev.type !== c.type) { added.push(c.id); return c }
    updated.push(c.id)
    if (prev === c || !HTML_OWNED[c.type]) return { ...prev, x: c.x, y: c.y, w: c.w, h: c.h, rotation: c.rotation } as SlideElement
    const out = { ...prev } as Record<string, unknown>
    for (const k of [...HTML_OWNED[c.type], ...FRAME_OWNED]) {
      const v = (c as unknown as Record<string, unknown>)[k]
      if (v === undefined) delete out[k]
      else out[k] = v
    }
    if ((c as { role?: string }).role) out.role = (c as { role?: string }).role
    if ((c as { alt?: string }).alt !== undefined) out.alt = (c as { alt?: string }).alt
    // a theme reference to a colour the HTML just replaced no longer holds
    if (out.themeRefs && typeof out.themeRefs === 'object') {
      const refs = { ...(out.themeRefs as Record<string, string>) }
      for (const k of Object.keys(refs)) if (HTML_OWNED[c.type].includes(k) && (prev as unknown as Record<string, unknown>)[k] !== out[k]) delete refs[k]
      if (Object.keys(refs).length) out.themeRefs = refs
      else delete out.themeRefs
    }
    return out as unknown as SlideElement
  })
  const present = new Set(merged.map((e) => e.id))
  // inherited chrome the HTML did not mention stays, behind what it covered
  existing.forEach((e, i) => {
    if (present.has(e.id) || !keepIds.has(e.id)) return
    const after = existing.slice(0, i).reverse().find((p) => present.has(p.id))
    const at = after ? merged.findIndex((m) => m.id === after.id) + 1 : 0
    merged.splice(at, 0, e)
    present.add(e.id)
  })
  const removed = existing.filter((e) => !present.has(e.id)).map((e) => e.id)
  return { elements: merged, updated, added, removed }
}

/** A fingerprint of what the HTML describes on `elements` (ids, order,
 *  frames to 0.5 px, the owned properties). The remembered source of a slide
 *  is only handed back while the slide still has this fingerprint. */
export function htmlSignature(elements: readonly SlideElement[], background: string): string {
  const parts: unknown[] = [background]
  for (const e of elements) {
    const r = e as unknown as Record<string, unknown>
    parts.push(e.id, e.type, ...['x', 'y', 'w', 'h', 'rotation'].map((k) => Math.round(Number(r[k] ?? 0) * 2) / 2), r.opacity ?? 1,
      ...(HTML_OWNED[e.type] ?? []).map((k) => r[k] ?? null))
  }
  const s = JSON.stringify(parts)
  let h1 = 2166136261, h2 = 5381
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 ^= ch; h1 = Math.imul(h1, 16777619)
    h2 = (Math.imul(h2, 33) + ch) | 0
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`
}
