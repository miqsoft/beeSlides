// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Packages for drawingml-write.ts's shapes:
//
//   writeGvml  PowerPoint's clipboard format ("Art::GVML ClipFormat" on
//              Windows, com.microsoft.Art--GVML-ClipFormat on macOS): a small
//              OPC zip — [Content_Types].xml, _rels/.rels → clipboard/drawings/
//              drawing1.xml (one lc:lockedCanvas group), its rels (theme,
//              pictures, links), clipboard/theme/theme1.xml (a:clipboardTheme)
//              and clipboard/media/*. Laid out after what PowerPoint for Mac
//              writes itself; a package built this way pastes as native,
//              editable shapes (checked by hand 2026-10-23, DECISIONS).
//
// The .pptx package is pptx-write.ts; the parts both share are opc.ts.

import { writeZip, type ZipEntry } from './zip.ts'
import { writeDrawingML, type WElement } from './drawingml-write.ts'
import { NS_A, NS_R, REL, XML, contentTypes, partRels, relsXml, themeXml, utf8, type ThemeIn } from './opc.ts'

export { emuPerPxFor, themeXml, type ThemeIn } from './opc.ts'

// ---- clipboard ---------------------------------------------------------------------

export interface GvmlResult { bytes: Uint8Array; warnings: string[] }

export async function writeGvml(elements: WElement[], o: { emuPerPx: number; theme?: ThemeIn }): Promise<GvmlResult> {
  const w = writeDrawingML(elements, { flavor: 'canvas', emuPerPx: o.emuPerPx, fontFamily: o.theme?.fontFamily })
  const b = w.box
  const drawing = XML +
    `<a:graphic xmlns:a="${NS_A}" xmlns:r="${NS_R}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas">` +
    `<lc:lockedCanvas xmlns:lc="http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas">` +
    `<a:nvGrpSpPr><a:cNvPr id="0" name=""/><a:cNvGrpSpPr/></a:nvGrpSpPr>` +
    `<a:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${b.w}" cy="${b.h}"/><a:chOff x="${b.x}" y="${b.y}"/><a:chExt cx="${b.w}" cy="${b.h}"/></a:xfrm></a:grpSpPr>` +
    w.xml + '</lc:lockedCanvas></a:graphicData></a:graphic>'
  const rels = relsXml([{ id: 'rId1', type: `${REL}/theme`, target: '../theme/theme1.xml' }, ...partRels(w.rels, '../media/')])
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: utf8(contentTypes(w.media, [
      ['/clipboard/drawings/drawing1.xml', 'application/vnd.openxmlformats-officedocument.drawing+xml'],
      ['/clipboard/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ])) },
    { name: '_rels/.rels', data: utf8(relsXml([{ id: 'rId1', type: `${REL}/drawing`, target: 'clipboard/drawings/drawing1.xml' }])) },
    { name: 'clipboard/drawings/drawing1.xml', data: utf8(drawing) },
    { name: 'clipboard/drawings/_rels/drawing1.xml.rels', data: utf8(rels) },
    { name: 'clipboard/theme/theme1.xml', data: utf8(themeXml('a:clipboardTheme', o.theme ?? {})) },
    ...w.media.map((m) => ({ name: `clipboard/media/${m.name}`, data: m.data })),
  ]
  return { bytes: await writeZip(entries), warnings: w.warnings }
}
