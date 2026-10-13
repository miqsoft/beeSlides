// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Pictures and package relationships — the .rels graph, the asset store, and
// p:pic → OutImage (675 pictures across the six census decks).
//
// THE SVG RULE is the one decision in this file that protects the whole deck.
// The census corpus is overwhelmingly vector — 386 .svg media parts against 18
// raster parts in the template alone, referenced through asvg:svgBlip in the
// blip's extLst — and the tempting destination, an inline slidomingo `svg` element,
// silently corrupts every icon: render.ts deliberately never strips `id`, svg
// `url(#…)` resolves DOCUMENT-globally, and icon libraries all name their
// clipPath/gradient `a` — so 386 icons each defining `#a` all paint with the
// first one's clip. The safe destination is an `image` element holding a
// `data:image/svg+xml` asset (its own document, ids scoped) — the same route
// render.ts already takes on the svgAsImage thumbnail path. The raster blip
// beside an svgBlip is only PowerPoint's compatibility preview; we use it only
// when the vector part is actually missing, and say so.
//
// The store dedups by CONTENT, not by part name, because the template reuses
// the same image across dozens of slides and layouts — and because the emitted
// document is one self-contained HTML file (6.9MB of media → ~9.2MB of base64
// if embedded once; catastrophic if embedded per reference). Keys are a pure
// function of the bytes so a re-import emits identical assets and a diff means
// a real change.

import { NS, attr, intAttr, kid, kids, descendants, type XElem } from './xml.ts'
import { EMU_PER_PX, type InheritCtx, type OutImage } from './types.ts'
import type { ZipParts } from './zip.ts'

// --- relationships -----------------------------------------------------------

export interface Rel {
  /** resolved part name ('ppt/media/image1.png'), or the verbatim URI when
   *  mode is 'External' — an external target is never a package part and must
   *  never be fetched */
  target: string
  type: string
  mode?: string
}

/**
 * Parse one .rels part into id → relationship.
 *
 * `baseDir` is the directory of the SOURCE part the .rels belongs to (e.g.
 * 'ppt/slides/' for slide1.xml.rels), because targets are relative to the
 * part, not to the _rels folder that physically holds the file:
 * 'ppt/slides/' + '../media/x.png' → 'ppt/media/x.png'.
 */
export function parseRels(relsXml: XElem, baseDir: string): Map<string, Rel> {
  const out = new Map<string, Rel>()
  for (const r of kids(relsXml, NS.rel, 'Relationship')) {
    const id = attr(r, 'Id')
    const target = attr(r, 'Target')
    if (!id || target === undefined) continue
    const type = attr(r, 'Type') ?? ''
    const mode = attr(r, 'TargetMode')
    // An External target is a URI into the outside world (a linked picture, a
    // hyperlink). It stays verbatim — resolving it against baseDir would
    // mangle it, and fetching it is the caller's line never to cross.
    if (mode === 'External') out.set(id, { target, type, mode })
    else out.set(id, { target: resolveTarget(baseDir, target), type })
  }
  return out
}

/** Join + normalize an OPC target against a base directory. Targets are URIs:
 *  '%20' in the XML is a literal space in the ZIP part name. */
function resolveTarget(baseDir: string, target: string): string {
  let t = target
  try { t = decodeURIComponent(target) } catch { /* malformed escape: use as written */ }
  const segs = t.startsWith('/')
    ? t.split('/') // pack-absolute: '/ppt/media/x.png' ignores the base
    : [...baseDir.split('/'), ...t.split('/')]
  const out: string[] = []
  for (const s of segs) {
    if (s === '' || s === '.') continue
    if (s === '..') out.pop() // clamped at the package root
    else out.push(s)
  }
  return out.join('/')
}

// --- content types -----------------------------------------------------------

export interface ContentTypes {
  /** extension (lowercased, no dot) → mime, from ct:Default */
  defaults: Map<string, string>
  /** part name (no leading slash) → mime, from ct:Override */
  overrides: Map<string, string>
}

export function parseContentTypes(root: XElem): ContentTypes {
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  for (const c of kids(root, NS.ct)) {
    const t = attr(c, 'ContentType')
    if (!t) continue
    if (c.local === 'Default') {
      const ext = attr(c, 'Extension')
      if (ext) defaults.set(ext.toLowerCase(), t)
    } else if (c.local === 'Override') {
      const p = attr(c, 'PartName')
      if (p) overrides.set(p.replace(/^\//, ''), t)
    }
  }
  return { defaults, overrides }
}

/** Extension fallbacks for a package with no (or an incomplete)
 *  [Content_Types].xml — the package's own declarations win when present. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
  emf: 'image/x-emf', wmf: 'image/x-wmf', wdp: 'image/vnd.ms-photo',
}

export function mimeFor(partName: string, types?: ContentTypes): string {
  const clean = partName.replace(/^\//, '')
  const override = types?.overrides.get(clean)
  if (override) return override
  const dot = clean.lastIndexOf('.')
  const ext = dot < 0 ? '' : clean.slice(dot + 1).toLowerCase()
  return types?.defaults.get(ext) ?? MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

// --- base64 ------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** No Buffer (browser), no btoa assumption (bare JS runtimes): btoa where the
 *  platform has it, the manual encoder elsewhere. One function, both worlds. */
export function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    // btoa wants a binary string; apply() in bounded chunks — one call over a
    // multi-MB image blows the argument-count limit.
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[])
    }
    return btoa(bin)
  }
  return b64Manual(bytes)
}

function b64Manual(bytes: Uint8Array): string {
  let out = ''
  const n = bytes.length
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63]
  }
  if (i + 1 === n) {
    const v = bytes[i] << 16
    out += B64[v >> 18] + B64[(v >> 12) & 63] + '=='
  } else if (i + 2 === n) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + '='
  }
  return out
}

// --- the asset store ---------------------------------------------------------

/** Two independent FNV-1a passes over the bytes, base36-joined. The key must
 *  be a pure function of the CONTENT (stable across re-imports, dedups across
 *  parts); 64 bits keeps accidental collisions out of reach for a few hundred
 *  assets, and `register` byte-compares on a hash hit anyway, so a collision
 *  costs a suffix, never a wrong image. */
function fnvKey(b: Uint8Array): string {
  let h1 = 0x811c9dc5 | 0
  let h2 = 0x7ee36211 | 0 // a second, unrelated basis
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 0x01000193)
    h2 = Math.imul(h2 ^ b[i], 0x01000193)
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Whether a raster paints every pixel of its box: a JPEG always; a PNG
 *  whose colour type has no alpha channel (grey 0 / RGB 2 / palette 3) and no
 *  tRNS chunk before its image data. Anything else — an alpha PNG (even one
 *  whose alpha happens to be all 255), GIF, SVG, EMF, … — answers false: the
 *  caller uses this to drop what lies UNDER the picture, so "maybe" is no. */
export function isOpaqueRaster(b: Uint8Array): boolean {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 33 || PNG.some((v, i) => b[i] !== v)) return false
  const colorType = b[25] // IHDR: 8 signature + 8 chunk head + w4 h4 depth1
  if (colorType !== 0 && colorType !== 2 && colorType !== 3) return false
  for (let at = 8; at + 8 <= b.length;) {
    const len = ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7])
    if (type === 'tRNS') return false
    if (type === 'IDAT' || type === 'IEND') return true
    at += 12 + len
  }
  return false
}

/**
 * Content-addressed media for the emitted document.
 *
 * `register` takes a resolved part name, returns the stable asset key (or
 * undefined for a missing part — the CALLER decides what that means and
 * reports it, because "svg part missing" and "raster missing" are different
 * findings). Elements reference `asset:<key>`; `assets()` is the
 * `doc.assets` record of data: URIs.
 */
export class AssetStore {
  /** hash → every distinct content seen under it (in practice one) */
  private byHash = new Map<string, Array<{ bytes: Uint8Array; key: string }>>()
  private uris = new Map<string, string>()
  private opaqueKeys = new Set<string>()
  // plain declarations, not parameter properties — node's strip-only TS
  // refuses non-erasable syntax, and every rig runs under it
  private parts: ZipParts
  private types?: ContentTypes

  constructor(parts: ZipParts, types?: ContentTypes) {
    this.parts = parts
    this.types = types
  }

  register(partName: string): string | undefined {
    const bytes = this.parts.get(partName.replace(/^\//, ''))
    if (!bytes) return undefined
    return this.registerBytes(bytes, mimeFor(partName, this.types))
  }

  /** Dedup is by bytes alone: the first registration's mime sticks, which is
   *  right — identical bytes under two names are the same file. */
  registerBytes(bytes: Uint8Array, mime: string): string {
    const h = fnvKey(bytes)
    let bucket = this.byHash.get(h)
    if (!bucket) { bucket = []; this.byHash.set(h, bucket) }
    for (const e of bucket) if (bytesEq(e.bytes, bytes)) return e.key
    const key = bucket.length === 0 ? `m${h}` : `m${h}x${bucket.length}`
    bucket.push({ bytes, key })
    this.uris.set(key, `data:${mime};base64,${toBase64(bytes)}`)
    if (isOpaqueRaster(bytes)) this.opaqueKeys.add(key)
    return key
  }

  /** Whether the asset under `key` paints every pixel (isOpaqueRaster). */
  opaque(key: string): boolean {
    return this.opaqueKeys.has(key)
  }

  /** The doc.assets record: key → data: URI. */
  assets(): Record<string, string> {
    return Object.fromEntries(this.uris)
  }
}

// --- blip resolution ----------------------------------------------------------

/**
 * Resolve an a:blipFill (or p:blipFill — the blip child is always NS.a either
 * way) down to a registered asset key. Shared by imageFrom (p:pic) and the
 * background-image path (a bare p:bgPr/a:blipFill, which carries no wrapping
 * p:pic) — every failure is reported here, once, regardless of which caller
 * is asking, so the fidelity report reads the same whether the picture sits
 * on a shape or paints a slide/layout/master background.
 */
export function resolveBlip(
  blipFill: XElem,
  ctx: InheritCtx,
  rels: Map<string, Rel>,
  assets: AssetStore,
  where = 'slide',
): string | undefined {
  const report = ctx.report
  const blip = kid(blipFill, NS.a, 'blip')
  if (!blip) {
    report.add('dropped', 'image-no-blip', where, 'no image reference (a:blip) inside the fill')
    return undefined
  }

  // The SVG rule (see header): a blip whose extLst carries asvg:svgBlip is a
  // vector icon; the r:embed raster beside it is only a compatibility preview.
  let key: string | undefined
  const svgBlip = descendants(blip, NS.asvg, 'svgBlip')[0]
  if (svgBlip) {
    const svgId = attr(svgBlip, 'embed')
    const svgRel = svgId ? rels.get(svgId) : undefined
    if (svgRel && !svgRel.mode) key = assets.register(svgRel.target)
    if (key === undefined) {
      report.add('approximated', 'svg-raster-fallback', where,
        'a vector icon\'s SVG part is missing — its raster preview is used instead')
    }
  }

  if (key === undefined) {
    const relId = attr(blip, 'embed') ?? attr(blip, 'link')
    const rel = relId ? rels.get(relId) : undefined
    if (!rel) {
      report.add('dropped', 'image-missing-rel', where,
        'the image references a relationship the .rels part does not define')
      return undefined
    }
    if (rel.mode === 'External') {
      // A linked (not embedded) image. The bytes live on someone's
      // filesystem or a URL; fetching is out of the question for a converter,
      // so the image is lost and the report says where it pointed.
      report.add('dropped', 'image-external-dropped', where,
        `a linked (not embedded) image points outside the file: ${rel.target}`)
      return undefined
    }
    if (rel.target.toLowerCase().endsWith('.wdp')) {
      // JPEG XR — no browser decodes it. PowerPoint pairs these with an
      // mc:Fallback pic carrying a real raster; the caller resolves that pair
      // (resolveAlternate) and calls us with the fallback pic instead.
      report.add('dropped', 'wdp-fallback', where,
        'a JPEG XR (.wdp) image no browser can decode — use the mc:Fallback picture if the file carries one')
      return undefined
    }
    key = assets.register(rel.target)
    if (key === undefined) {
      report.add('dropped', 'image-missing-part', where,
        `the image's media part is missing from the package: ${rel.target}`)
      return undefined
    }
  }
  return key
}

// --- p:pic → OutImage --------------------------------------------------------

/**
 * Convert one p:pic. Returns undefined when there is nothing displayable —
 * every undefined is reported, never silent.
 *
 * The frame is read from the pic's OWN a:xfrm (pictures nearly always carry
 * one); a pic without it — a picture placeholder — comes back at 0,0,0,0 and
 * the caller's inheritance walk must supply the frame, exactly as for shapes.
 * Group transforms (p:grpSp chOff/chExt) are likewise the geometry pass's job.
 */
export function imageFrom(
  pic: XElem,
  ctx: InheritCtx,
  rels: Map<string, Rel>,
  assets: AssetStore,
  where = 'slide',
): OutImage | undefined {
  const report = ctx.report
  const blipFill = kid(pic, NS.p, 'blipFill')
  if (!blipFill) {
    report.add('dropped', 'image-no-blip', where, 'a picture carries no image reference at all')
    return undefined
  }
  const key = resolveBlip(blipFill, ctx, rels, assets, where)
  if (key === undefined) return undefined

  // Framing. a:srcRect (335 census crops, ~half of all pictures) maps onto
  // the model's `crop` exactly — fractions of the natural picture — written
  // with fit:'cover' as the editor writes it, so a reader that ignores
  // `crop` still shows a centred crop of the right shape. Negative sides are
  // PADDING (the picture sits inset in its box): the caller trims the frame
  // to the picture with insetFrame(pictureInset(pic)).
  const cropping = srcRectCrop(blipFill)
  let fit: OutImage['fit'] = 'fill' // a:stretch (the norm, and the default)
  if (cropping.invalid) {
    report.add('approximated', 'image-crop-invalid', where,
      'a source-rectangle crop that leaves nothing of the picture — the whole picture is shown instead')
  } else if (cropping.crop) {
    fit = 'cover'
  } else if (kid(blipFill, NS.a, 'tile')) {
    report.add('approximated', 'image-tile-dropped', where,
      'a tiled picture fill renders as a single stretched copy')
  }

  const spPr = kid(pic, NS.p, 'spPr')
  const xfrm = spPr && kid(spPr, NS.a, 'xfrm')
  let x = 0, y = 0, w = 0, h = 0, rotation = 0
  if (xfrm) {
    const off = kid(xfrm, NS.a, 'off')
    const ext = kid(xfrm, NS.a, 'ext')
    if (off) { x = px(intAttr(off, 'x')); y = px(intAttr(off, 'y')) }
    if (ext) { w = px(intAttr(ext, 'cx')); h = px(intAttr(ext, 'cy')) }
    rotation = intAttr(xfrm, 'rot') / 60000 // 60,000ths of a degree
  }

  const nv = kid(pic, NS.p, 'nvPicPr')
  const cNvPr = nv && kid(nv, NS.p, 'cNvPr')
  const out: OutImage = {
    id: `pic${cNvPr ? intAttr(cNvPr, 'id') : 0}`,
    type: 'image',
    x, y, w, h, rotation,
    opacity: 1,
    src: `asset:${key}`,
    fit,
  }
  if (cropping.crop) out.crop = cropping.crop
  const alt = altOf(cNvPr)
  if (alt !== undefined) out.alt = alt
  return out
}

// --- text alternative ----------------------------------------------------------

/** model.ts's limit for `alt` (untrusted.ts LIMITS.alt): a longer one is
 *  not a description anyone reads aloud, and the validator would refuse it. */
const MAX_ALT = 1000

/**
 * A drawing's text alternative from its p:cNvPr, in model.ts `Describable`
 * terms: '' when PowerPoint's "Mark as decorative" is on (an
 * `adec:decorative val="1"` in the cNvPr's extLst — matched by local name,
 * so a producer's other prefix/namespace for the same flag still counts),
 * else the Alt Text description (@descr), else the older Alt Text title
 * (@title), else undefined — "not described", which is what lets the
 * editor's accessibility check ask for one. Shared by pictures, svg icons
 * and charts (pptx.ts reads the graphicFrame's own cNvPr).
 */
export function altOf(cNvPr: XElem | undefined): string | undefined {
  if (!cNvPr) return undefined
  if (isDecorative(cNvPr)) return ''
  for (const name of ['descr', 'title']) {
    const v = attr(cNvPr, name)?.trim()
    if (v) return v.length > MAX_ALT ? v.slice(0, MAX_ALT).trimEnd() : v
  }
  return undefined
}

function isDecorative(cNvPr: XElem): boolean {
  const ext = kid(cNvPr, NS.a, 'extLst')
  if (!ext) return false
  const walk = (e: XElem): boolean => {
    for (const c of e.children) {
      if (typeof c === 'string') continue
      if (c.local === 'decorative') {
        const v = attr(c, 'val')
        if (v === '1' || v === 'true') return true
      }
      if (walk(c)) return true
    }
    return false
  }
  return walk(ext)
}

// --- crop (a:srcRect) ----------------------------------------------------------

/** model.ts MIN_CROP — the smallest crop side normalizeCrop keeps. */
const MIN_CROP = 0.01

/** Fractions at the source's own resolution (1/100000) — diffable JSON. */
const frac = (v: number): number => Math.round(v * 100000) / 100000

/** The four srcRect sides as fractions of the picture (positive = cut away,
 *  negative = padding around it). Undefined without a srcRect. */
function srcRectSides(blipFill: XElem): { l: number; t: number; r: number; b: number } | undefined {
  const sr = kid(blipFill, NS.a, 'srcRect')
  if (!sr) return undefined
  return {
    l: intAttr(sr, 'l') / 100000, t: intAttr(sr, 't') / 100000,
    r: intAttr(sr, 'r') / 100000, b: intAttr(sr, 'b') / 100000,
  }
}

/**
 * a:srcRect → model.ts `ImageCrop`: x = l, y = t, w = 1 − l − r, h = 1 − t − b,
 * with the PADDED parts (negative sides) left out — the crop covers only the
 * part of the picture the box actually shows — then clamped exactly as
 * model.ts normalizeCrop clamps (each side ≥ MIN_CROP, inside 0..1, no crop
 * at all when nothing is cut). `invalid` = the rectangle leaves nothing of
 * the picture (r ≥ 1 − l, a corrupt or hand-made file).
 */
export function srcRectCrop(blipFill: XElem): { crop?: OutImage['crop']; invalid?: boolean } {
  const s = srcRectSides(blipFill)
  if (!s) return {}
  const x0 = Math.max(s.l, 0), x1 = Math.min(1 - s.r, 1)
  const y0 = Math.max(s.t, 0), y1 = Math.min(1 - s.b, 1)
  if (!(x1 - x0 > 0) || !(y1 - y0 > 0)) return { invalid: true }
  const w = Math.min(Math.max(x1 - x0, MIN_CROP), 1)
  const h = Math.min(Math.max(y1 - y0, MIN_CROP), 1)
  const x = Math.min(Math.max(x0, 0), 1 - w)
  const y = Math.min(Math.max(y0, 0), 1 - h)
  const eps = 1e-4
  if (x < eps && y < eps && w > 1 - eps && h > 1 - eps) return {}
  return { crop: { x: frac(x), y: frac(y), w: frac(w), h: frac(h) } }
}

/** How much of the picture's BOX is padding, per side, as fractions of the
 *  box — what a negative srcRect side means. Undefined when there is none. */
export interface PictureInset { l: number; t: number; r: number; b: number }

/**
 * The padding a p:pic's srcRect puts around its picture. The box spans the
 * picture coordinates l … 1 − r; where that runs past the picture (a
 * negative side) PowerPoint paints nothing, and the model has no padding — so
 * the caller shrinks the frame to the painted part (insetFrame), which is
 * exact. Undefined for no srcRect, no negative side, or an invalid one.
 */
export function pictureInset(pic: XElem): PictureInset | undefined {
  const blipFill = kid(pic, NS.p, 'blipFill')
  const s = blipFill && srcRectSides(blipFill)
  if (!s || (s.l >= 0 && s.t >= 0 && s.r >= 0 && s.b >= 0)) return undefined
  const spanX = 1 - s.l - s.r
  const spanY = 1 - s.t - s.b
  if (!(spanX > 0) || !(spanY > 0)) return undefined
  const x0 = Math.max(s.l, 0), x1 = Math.min(1 - s.r, 1)
  const y0 = Math.max(s.t, 0), y1 = Math.min(1 - s.b, 1)
  if (!(x1 - x0 > 0) || !(y1 - y0 > 0)) return undefined
  return {
    l: (x0 - s.l) / spanX, r: (1 - s.r - x1) / spanX,
    t: (y0 - s.t) / spanY, b: (1 - s.b - y1) / spanY,
  }
}

/** Shrink an image's frame by `inset` (fractions of the frame), keeping the
 *  rotation centre where PowerPoint rotates it: the painted part's centre
 *  moves within the rotated box, so the offset is rotated too. In place. */
export function insetFrame(img: OutImage, inset: PictureInset | undefined): void {
  if (!inset) return
  const { w, h } = img
  const nw = w * (1 - inset.l - inset.r)
  const nh = h * (1 - inset.t - inset.b)
  const dx = (w * (inset.l - inset.r)) / 2
  const dy = (h * (inset.t - inset.b)) / 2
  const rad = (img.rotation * Math.PI) / 180
  const cx = img.x + w / 2 + dx * Math.cos(rad) - dy * Math.sin(rad)
  const cy = img.y + h / 2 + dx * Math.sin(rad) + dy * Math.cos(rad)
  const r = (v: number): number => Math.round(v * 100) / 100
  img.x = r(cx - nw / 2); img.y = r(cy - nh / 2)
  img.w = r(nw); img.h = r(nh)
}

/** EMU → px, rounded to 1/100 px so emitted JSON stays diffable. */
const px = (emu: number): number => Math.round((emu / EMU_PER_PX) * 100) / 100

// --- intrinsic size ----------------------------------------------------------

/**
 * A raster/vector image's own pixel size, read from its header bytes.
 *
 * .pptx never needs this — a `p:pic` carries its own `a:ext` — but a markdown
 * figure carries NOTHING, and its aspect ratio is the difference between a
 * figure that fills its frame and one squashed into a 16:9 box. Four formats
 * cover every figure a Quarto engine emits (knitr and matplotlib default to
 * PNG; ggplot/plotly can emit SVG); anything else returns undefined and the
 * caller falls back to the frame's own ratio.
 *
 * Returns CSS pixels, so an SVG with only a viewBox reports the viewBox's
 * user units — which is what an `<img>` would use for its intrinsic ratio too.
 */
export function imageSize(bytes: Uint8Array, mime: string): { w: number; h: number } | undefined {
  const be32 = (o: number) => (bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0
  const be16 = (o: number) => (bytes[o] << 8) | bytes[o + 1]
  const le16 = (o: number) => bytes[o] | (bytes[o + 1] << 8)
  // PNG: an 8-byte signature, then the IHDR chunk's width/height
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { w: be32(16), h: be32(20) }
  }
  // GIF: logical screen descriptor, little-endian, right after "GIF89a"
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { w: le16(6), h: le16(8) }
  }
  // JPEG: walk the marker chain to the first SOFn (0xC0..0xCF, minus the
  // non-frame markers C4/C8/CC) and read its height then width.
  if (bytes.length > 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xFF) { i++; continue }
      const m = bytes[i + 1]
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD9)) { i += 2; continue }
      const len = be16(i + 2)
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { w: be16(i + 7), h: be16(i + 5) }
      }
      i += 2 + (len > 0 ? len : 2)
    }
    return undefined
  }
  // SVG: width/height attributes, else the viewBox's own extent
  if (mime.includes('svg')) {
    const head = new TextDecoder().decode(bytes.subarray(0, 2048))
    const num = (s: string | undefined) => (s ? parseFloat(s) : NaN)
    const w = num(/\bwidth\s*=\s*["']([\d.]+)/.exec(head)?.[1])
    const h = num(/\bheight\s*=\s*["']([\d.]+)/.exec(head)?.[1])
    if (w > 0 && h > 0) return { w, h }
    const vb = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(head)
    if (vb) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) }
  }
  return undefined
}

export const _internals = { b64Manual, resolveTarget, fnvKey, bytesEq }
