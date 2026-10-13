// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Font utilities: the curated system-stack choices offered in the editor,
// and @font-face injection for fonts embedded in the document's asset table.

import type { SlidomingoDoc } from './model'
import { systemFonts } from './localfonts'

/** Safe cross-platform stacks offered in the font picker. */
export const FONT_CHOICES: Array<{ label: string; stack: string }> = [
  { label: 'System UI', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  { label: 'Helvetica', stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: 'Verdana', stack: "Verdana, 'DejaVu Sans', Geneva, Tahoma, sans-serif" },
  { label: 'Trebuchet', stack: "'Trebuchet MS', 'Segoe UI', Tahoma, sans-serif" },
  { label: 'Georgia', stack: "Georgia, 'Times New Roman', serif" },
  { label: 'Palatino', stack: "Palatino, 'Palatino Linotype', 'Book Antiqua', Georgia, serif" },
  { label: 'Times', stack: "'Times New Roman', Times, serif" },
  { label: 'Monospace', stack: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Courier New', monospace" },
  { label: 'Impact', stack: "Impact, 'Arial Black', 'Franklin Gothic Bold', sans-serif" },
]

/** First family of a stack, normalised — used to match stacks loosely. */
export function firstFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '').toLowerCase()
}

/**
 * Populate a `<select>` with the shared font picker's option groups: a
 * caller-labeled "default" sentinel (empty string), fonts embedded in the
 * document, fonts actually installed on the machine (Local Font Access API —
 * see localfonts.ts; caller must have already called `requestSystemFonts()`
 * from a genuine user gesture), curated cross-platform stacks, and — if
 * `current` matches none of the above — a synthesized entry so the picker
 * never silently shows the wrong thing selected. Options render in their own
 * face so the menu previews itself.
 *
 * Shared by panels.ts's per-element font picker and layoutmanager.ts's
 * per-master font pickers — extracted so the two never drift apart on what
 * "the font list" means.
 */
export function populateFontSelect(sel: HTMLSelectElement, doc: SlidomingoDoc, current: string, defaultLabel: string): void {
  sel.innerHTML = ''
  const add = (label: string, value: string, selected: boolean, parent: HTMLElement = sel) => {
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    o.style.fontFamily = value || 'inherit'
    o.selected = selected
    parent.appendChild(o)
    return o
  }
  const addGroup = (label: string) => {
    const g = document.createElement('optgroup')
    g.label = label
    sel.appendChild(g)
    return g
  }
  const curFirst = firstFamily(current)
  let matched = false
  const used = new Set<string>()
  add(defaultLabel, '', current === '')

  const embedded = addGroup('Embedded in document')
  for (const f of doc.fonts ?? []) {
    const hit = !matched && (current === f.family || curFirst === firstFamily(f.family))
    if (hit) matched = true
    used.add(f.family.toLowerCase())
    add(`${f.family} (embedded)`, f.family, hit, embedded)
  }

  // Curated FONT_CHOICES stacks are deliberately NOT deduped against
  // installed/embedded fonts below — a curated stack is a fallback that
  // guarantees something renders even where the exact font isn't present
  // (opened on another machine, or exported static HTML), while an
  // installed-font entry pins exactly that real font. Both stay separately
  // selectable.
  const installed = systemFonts()
  if (installed.length) {
    const group = addGroup('Installed fonts')
    for (const family of installed) {
      if (used.has(family.toLowerCase())) continue
      const hit = !matched && (current === family || curFirst === firstFamily(family))
      if (hit) matched = true
      add(family, family, hit, group)
    }
  }

  const common = addGroup('Common fonts')
  for (const c of FONT_CHOICES) {
    const hit = !matched && current !== '' && curFirst === firstFamily(c.stack)
    if (hit) matched = true
    add(c.label, c.stack, hit, common)
  }
  if (current && !matched) add(curFirst || 'custom', current, true)
}

/**
 * @font-face rules for every embedded font whose asset actually resolves —
 * pure string-building, no DOM. Shared by the live editor's boot-time
 * injection below and the full-deck static layer (staticlayer.ts), which
 * needs the identical rules scoped into its own saved <style> rather than
 * injected live: `doc.fonts[]` never renders correctly for a JS-off reader
 * without them, the same way the runtime's compressed stylesheet doesn't.
 */
export function fontFaceCss(doc: SlidomingoDoc): string {
  return (doc.fonts ?? [])
    .map((f) => {
      const src = doc.assets?.[f.asset]
      if (!src) return ''
      return `@font-face{font-family:${JSON.stringify(f.family)};src:url(${JSON.stringify(src)});` +
        `font-weight:${f.weight ?? 'normal'};font-style:${f.style ?? 'normal'};font-display:swap}`
    })
    .join('\n')
}

/**
 * (Re)register @font-face rules for every embedded font in the document.
 * Idempotent — call at boot and again whenever a font is added.
 */
export function injectFonts(doc: SlidomingoDoc) {
  let style = document.getElementById('slidomingo-fonts') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'slidomingo-fonts'
    document.head.appendChild(style)
  }
  style.textContent = fontFaceCss(doc)
}
