// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The package parts gvml.ts (the clipboard) and pptx-write.ts (a .pptx)
// share: relationships, content types, the theme.

import { concreteFace, esc, parseColor, REL_HYPERLINK, REL_IMAGE, REL_SLIDE, type WRel, type WMedia } from './drawingml-write.ts'

export interface ThemeIn {
  fontFamily?: string
  headingFamily?: string
  background?: string
  color?: string
  accent?: string
  palette?: Partial<Record<'bg2' | 'tx2' | 'accent2' | 'accent3' | 'accent4' | 'accent5' | 'accent6' | 'hlink' | 'folHlink', string>>
}

export const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
export const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
export const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
export const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** EMU per slide px for a slide `height` px tall, shown 7.5 in tall as PowerPoint's own 16:9 and 4:3 slides are. */
export const emuPerPxFor = (height: number): number => 6858000 / Math.max(1, height)

// ---- parts ---------------------------------------------------------------------------

export interface RelIn { id: string; type: string; target: string; external?: boolean }

export function partRels(rels: WRel[], mediaDir: string): RelIn[] {
  return rels.map((r) => r.type === 'image'
    ? { id: r.id, type: REL_IMAGE, target: mediaDir + r.target }
    : r.type === 'slide'
      ? { id: r.id, type: REL_SLIDE, target: r.target }
      : { id: r.id, type: REL_HYPERLINK, target: r.target, external: true })
}

export function relsXml(rels: RelIn[]): string {
  return XML + `<Relationships xmlns="${NS_REL}">` +
    rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') +
    '</Relationships>'
}

export function contentTypes(media: WMedia[], overrides: Array<[string, string]>): string {
  const exts = new Map<string, string>([['rels', 'application/vnd.openxmlformats-package.relationships+xml'], ['xml', 'application/xml']])
  for (const m of media) exts.set(m.name.split('.').pop()!, m.contentType)
  return XML + `<Types xmlns="${NS_CT}">` +
    [...exts].map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`).join('') +
    overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('') +
    '</Types>'
}

/** A theme from the deck's colours and faces — `a:theme` for a .pptx, `a:clipboardTheme` for the clipboard. */
export function themeXml(root: 'a:theme' | 'a:clipboardTheme', t: ThemeIn): string {
  const hex = (css: string | undefined, d: string) => parseColor(css)?.hex ?? d
  const pal = t.palette ?? {}
  const slot = (name: string, v: string) => `<a:${name}><a:srgbClr val="${v}"/></a:${name}>`
  const clrScheme = '<a:clrScheme name="BeeSlides">' +
    slot('dk1', hex(t.color, '000000')) + slot('lt1', hex(t.background, 'FFFFFF')) +
    slot('dk2', hex(pal.tx2, hex(t.color, '1F2937'))) + slot('lt2', hex(pal.bg2, 'E5E7EB')) +
    slot('accent1', hex(t.accent, '2563EB')) + slot('accent2', hex(pal.accent2, 'F59E0B')) + slot('accent3', hex(pal.accent3, '10B981')) +
    slot('accent4', hex(pal.accent4, 'EF4444')) + slot('accent5', hex(pal.accent5, '8B5CF6')) + slot('accent6', hex(pal.accent6, '14B8A6')) +
    slot('hlink', hex(pal.hlink, '2563EB')) + slot('folHlink', hex(pal.folHlink, '7C3AED')) +
    '</a:clrScheme>'
  const body = concreteFace(t.fontFamily, 'Arial')
  const heading = concreteFace(t.headingFamily, body)
  const font = (tag: string, face: string) => `<a:${tag}><a:latin typeface="${esc(face)}"/><a:ea typeface=""/><a:cs typeface=""/></a:${tag}>`
  const fontScheme = `<a:fontScheme name="BeeSlides">${font('majorFont', heading)}${font('minorFont', body)}</a:fontScheme>`
  const ph = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const fmtScheme = '<a:fmtScheme name="BeeSlides">' +
    `<a:fillStyleLst>${ph}${ph}${ph}</a:fillStyleLst>` +
    `<a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}">${ph}</a:ln>`).join('')}</a:lnStyleLst>` +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    `<a:bgFillStyleLst>${ph}${ph}${ph}</a:bgFillStyleLst>` +
    '</a:fmtScheme>'
  const elements = `<a:themeElements>${clrScheme}${fontScheme}${fmtScheme}</a:themeElements>`
  return root === 'a:theme'
    ? XML + `<a:theme xmlns:a="${NS_A}" name="BeeSlides">${elements}</a:theme>`
    : XML + `<a:clipboardTheme xmlns:a="${NS_A}">${elements}<a:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></a:clipboardTheme>`
}
