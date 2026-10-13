// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The agent's find_text verb (editor.ts respondAgentQuery). DOM-free: the
// caller passes its html → text function, so scripts/test-find-text.ts runs
// it in plain node.
import type { SlidomingoDoc } from '../model'

/** find_text: every place in the deck slides whose text matches one of the
 *  `|`-separated alternatives (case- and accent-insensitive, plain substring —
 *  no regex, so a query can never be slow). The cheap way for an agent to
 *  find "the slide about X" instead of reading slides one by one. */
export function agentFindText(doc: SlidomingoDoc, query: string, limit: number, stripHtml: (html: string) => string): { total: number; slideCount: number; hits: Array<Record<string, unknown>> } {
  const fold = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const needles = query.split('|').map((q) => fold(q.trim())).filter(Boolean)
  const hits: Array<Record<string, unknown>> = []
  let total = 0
  doc.slides.forEach((slide, index) => {
    const look = (text: string, field: string, elementId?: string) => {
      const flat = text.replace(/\s+/g, ' ').trim()
      if (!flat) return
      const folded = fold(flat)
      for (const n of needles) {
        const at = folded.indexOf(n)
        if (at < 0) continue
        total++
        if (hits.length < limit) {
          const from = Math.max(0, at - 50)
          const to = Math.min(flat.length, at + n.length + 70)
          hits.push({
            slideId: slide.id, index, ...(slide.name ? { slideName: slide.name } : {}),
            ...(elementId ? { elementId } : {}), field,
            snippet: `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`,
          })
        }
        return // one hit per text, whichever alternative matched first
      }
    }
    if (slide.name) look(slide.name, 'slide name')
    for (const e of slide.elements) {
      if (e.type === 'text') look(stripHtml(e.html), 'text', e.id)
      else if (e.type === 'code') look(e.content, 'text', e.id)
      else if (e.type === 'math') look(e.tex, 'text', e.id)
      else if (e.type === 'table') look(e.rows.map((r) => r.cells.map((c) => stripHtml(c.html)).join(' | ')).join(' / '), 'table', e.id)
      else if (e.type === 'chart') look(chartStrings(e.option).join(' · '), 'chart', e.id)
      else {
        const html = (e as { html?: unknown }).html
        if (typeof html === 'string') look(stripHtml(html), 'text', e.id)
      }
      const alt = (e as { alt?: unknown }).alt
      if (typeof alt === 'string') look(alt, 'alt', e.id)
    }
    if (slide.notes) look(stripHtml(slide.notes), 'notes')
  })
  return { total, slideCount: doc.slides.length, hits }
}

/** The human-readable strings of a chart option (titles, series names, axis
 *  labels) — the keys a reader would search for, not colours or numbers. */
function chartStrings(option: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length > 200 || !option || typeof option !== 'object') return out
  for (const [k, v] of Object.entries(option as Record<string, unknown>)) {
    if (typeof v === 'string' && (k === 'text' || k === 'subtext' || k === 'name')) out.push(v)
    else if (k === 'data' && Array.isArray(v)) { for (const d of v) if (typeof d === 'string') out.push(d); else chartStrings(d, out, depth + 1) }
    else if (typeof v === 'object') chartStrings(v, out, depth + 1)
  }
  return out
}
