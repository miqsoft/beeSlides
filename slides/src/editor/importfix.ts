// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The editor's half of "static first, then AI" after a PowerPoint import
// (the pure logic is src/importrepair.ts):
//
//   settleImport   — runs on every .pptx import, AI or not: re-measures the
//                    imported text through the real renderer and fixes the
//                    overflow it can fix faithfully, as ONE undo step.
//   fixWithClaude  — desktop only: sends what is left that needs judgement
//                    (repairItems) plus the source file to the window's
//                    Claude session (main: terminalPanel.ts fix-import).
//
// Without the desktop bridge (the web build) there is no AI path: the report
// lists the leftovers for the user to fix by hand.

import type { Store } from '../store'
import type { TextElement } from '../model'
import { fontsInUse } from '../model'
import { measureElement } from '../measure'
import { repairItems, settleImportedText, type RepairItem, type SettleResult, type TextLeftover } from '../importrepair'
import { matchDesign, rebaseOnLayout, restyleOnLayout, type DesignMatch, type RebaseResult } from '../importlayout'
import { parseTemplateDoc, unsupportedFeatures, type SlidomingoDoc } from '../model'
import type { FidelityReport } from '../../../kernel/src/convert/report.ts'
import { t } from '../i18n'

/** An import's report as it travels to the editor (seeded draft, start page
 *  or File ▸ Import). `kind`/`sourcePath` are set for a PowerPoint. */
export interface ImportContext {
  name: string
  report: FidelityReport
  kind?: 'pptx'
  /** absolute path of the picked file (desktop only) */
  sourcePath?: string
}

/** Fonts the deck names, loaded before anything is measured — a measurement
 *  in the fallback face is a different height. Bounded: a face that never
 *  arrives must not hold the import report back. */
async function fontsLoaded(families: string[]): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
  if (!fonts) return
  const loads = families.flatMap((f) => [`16px ${JSON.stringify(f)}`, `bold 16px ${JSON.stringify(f)}`])
    .map((spec) => fonts.load(spec).catch(() => []))
  await Promise.race([
    Promise.all(loads).then(() => fonts.ready),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
}

/**
 * Fit the imported text (src/importrepair.ts settleImportedText) in ONE
 * store.commit — or none, when nothing needed fixing. A dry run on a copy
 * decides that, so a clean import leaves no empty undo step.
 */
export async function settleImport(store: Store): Promise<SettleResult> {
  await fontsLoaded(fontsInUse(store.doc).map((f) => f.family.split(',')[0].trim().replace(/^["']|["']$/g, '')))
  const measure = (el: TextElement) => measureElement(el, store.doc).height
  const dry = settleImportedText(structuredClone(store.doc), measure)
  if (!dry.grown && !dry.shrunk) return dry
  let result = dry
  store.commit(() => { result = settleImportedText(store.doc, measure) })
  return result
}

/** One line for the report about what the static pass did, or ''. */
export function settleSummary(s: SettleResult): string {
  const parts: string[] = []
  if (s.grown) parts.push(t('{n} text boxes grown to fit', { n: String(s.grown) }))
  if (s.shrunk) parts.push(t('{n} shrunk slightly to fit', { n: String(s.shrunk) }))
  if (s.leftovers.length) parts.push(t('{n} still overflow', { n: String(s.leftovers.length) }))
  return parts.length ? t('Text re-measured: {list}', { list: parts.join(', ') }) : ''
}

/** Report lines for the text the static pass left, in the dialog's style. */
export function leftoverLines(leftovers: TextLeftover[]): string[] {
  return leftovers.map((l) => `• ≈ ${t('slide {n}', { n: String(l.slide) })} / ${l.elementId}: ` +
    t('text needs {px}px more than its box', { px: String(l.overflow) }))
}

/** Whether this window can hand an import to Claude. */
export function canFixWithClaude(): boolean {
  return typeof window.slidomingoDesktop?.fixImportWithAi === 'function'
}

/** How many items "Fix with Claude" would send right now. */
export function repairCount(store: Store, ctx: ImportContext, leftovers: TextLeftover[], extra: RepairItem[] = []): number {
  return repairItems(store.doc, ctx.report, leftovers, extra).length
}

/** Send the work list (against the deck as it is NOW — a slide deleted
 *  since the import drops out) to the window's Claude session. */
export async function fixWithClaude(store: Store, ctx: ImportContext, leftovers: TextLeftover[], toast: (m: string) => void, extra: RepairItem[] = []): Promise<void> {
  const send = window.slidomingoDesktop?.fixImportWithAi
  if (!send) return
  const items = repairItems(store.doc, ctx.report, leftovers, extra)
  if (!items.length) { toast(t('Nothing left that needs Claude')); return }
  toast(ctx.sourcePath ? t('Preparing the original for Claude…') : t('Sending to Claude…'))
  try {
    const res = await send({ name: ctx.name, sourcePath: ctx.sourcePath, items })
    if (!res.ok) { toast(t('Couldn’t send to Claude: {m}', { m: res.error ?? '' })); return }
    toast(res.pdf
      ? t('Claude is fixing {n} items, with a picture of the original', { n: String(items.length) })
      : t('Claude is fixing {n} items', { n: String(items.length) }))
  } catch (err) {
    toast(t('Couldn’t send to Claude: {m}', { m: err instanceof Error ? err.message : String(err) }))
  }
}

// --- the user's own layouts ---------------------------------------------------

/** At most this many layout files are compared per import. */
const MAX_LAYOUTS = 40

export interface LayoutReuse {
  name: string
  result: RebaseResult
  /** the deck as imported, before it moved onto the layout — what "Keep the
   *  file's own design" puts back */
  fileDesign: SlidomingoDoc
}

/**
 * Desktop only: compare the freshly imported deck with every layout in the
 * user's layouts folder (src/importlayout.ts) and, when one is the same
 * design, move the deck onto it in ONE store.commit. The best match is the
 * one that pairs the most slide types. null = no layout matched (or no
 * desktop), and the deck keeps the file's own design.
 */
export async function reuseLayout(store: Store): Promise<LayoutReuse | null> {
  let best: { name: string; layout: SlidomingoDoc; match: DesignMatch } | null = null
  for (const meta of (await listLayouts()).slice(0, MAX_LAYOUTS)) {
    const layout = await loadLayout(meta.path)
    if (!layout) continue
    const match = matchDesign(store.doc, layout)
    if (match && (!best || match.types.size > best.match.types.size)) best = { name: meta.name, layout, match }
  }
  if (!best) return null
  const fileDesign = structuredClone(store.doc)
  let result: RebaseResult | null = null
  const { name, layout, match } = best
  store.commit(() => { result = rebaseOnLayout(store.doc, layout, match, name) }, 'slides')
  return result ? { name, result, fileDesign } : null
}

/** The user's layouts (desktop), [] elsewhere or on failure. */
export async function listLayouts(): Promise<Array<{ path: string; name: string }>> {
  const api = window.slidomingoDesktop
  if (!api?.listTemplateMeta || !api.loadTemplate) return []
  try { return (await api.listTemplateMeta()).map((m) => ({ path: m.path, name: m.name })) } catch { return [] }
}

async function loadLayout(path: string): Promise<SlidomingoDoc | null> {
  let raw: string | null = null
  try { raw = await window.slidomingoDesktop?.loadTemplate?.(path) ?? null } catch { return null }
  const layout = raw ? parseTemplateDoc(raw) : null
  return layout && !unsupportedFeatures(layout).length ? layout : null
}

export interface LayoutRestyle {
  name: string
  fit: number
  partial: number
  /** content that found no slot — sent along with "Fix with Claude" */
  floating: RepairItem[]
  fileDesign: SlidomingoDoc
}

/** "Use a different layout…": restyle the imported deck onto `meta`'s
 *  layout (src/importlayout.ts restyleOnLayout) in ONE store.commit. null
 *  when the layout can't be read or its slide size differs. */
export async function restyleOntoLayout(store: Store, meta: { path: string; name: string }, report?: FidelityReport): Promise<LayoutRestyle | { error: string }> {
  const layout = await loadLayout(meta.path)
  if (!layout) return { error: t('Couldn’t read the layout “{name}”', { name: meta.name }) }
  if (layout.size.width !== store.doc.size.width || layout.size.height !== store.doc.size.height) {
    return { error: t('The layout has a different slide size — its slide types can’t be used here') }
  }
  const fileDesign = structuredClone(store.doc)
  let r: ReturnType<typeof restyleOnLayout> | null = null
  store.commit(() => { r = restyleOnLayout(store.doc, layout, meta.name, unlinkedLayoutNames(report)) }, 'slides')
  const res = r as ReturnType<typeof restyleOnLayout> | null
  if (!res) return { error: t('Couldn’t read the layout “{name}”', { name: meta.name }) }
  return {
    name: meta.name, fit: res.fit, partial: res.partial, fileDesign,
    floating: res.floating.map((f) => ({
      slide: f.slide, slideId: f.slideId, elementId: f.elementId, code: 'layout-floating', count: 1,
      detail: 'this content found no slot on its new slide type — place it the way the layout intends, or move the slide to a better-fitting slide type',
    })),
  }
}

/** The converter names the layout an unlinked slide came from in its
 *  `slide-unlinked` finding (kernel/src/convert/pptx.ts) — slide id `s<n>`
 *  → that name, the restyle's best hint for which slide type it wants. */
function unlinkedLayoutNames(report?: FidelityReport): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of report?.entries ?? []) {
    if (e.code !== 'slide-unlinked') continue
    const slide = /^slide (\d+)$/.exec(e.where)
    const name = /not linked to its layout "(.*)"$/.exec(e.detail)
    if (slide && name) out.set(`s${slide[1]}`, name[1])
  }
  return out
}

/** The report line for a restyle. */
export function restyleSummary(r: LayoutRestyle): string {
  const line = t('Moved onto your layout “{name}” — slides that fit: {n} of {total}', { name: r.name, n: String(r.fit), total: String(r.fit + r.partial) })
  return r.partial ? `${line} · ${t('content without a slot: {k} slides', { k: String(r.partial) })}` : line
}

/** The report line for a reuse. */
export function reuseSummary(r: LayoutReuse, total: number): string {
  const { linked, keptFromFile } = r.result
  const line = t('Used your layout “{name}” — slides on its slide types: {n} of {total}', { name: r.name, n: String(linked), total: String(total) })
  return keptFromFile ? `${line} · ${t('{k} kept as in the file, because they would look different', { k: String(keptFromFile) })}` : line
}
