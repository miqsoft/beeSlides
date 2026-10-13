// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Real lists in imported text — the one block structure both importers emit.
//
// slidomingo/slides rich text (render.ts sanitizeHtml, DECISIONS 2026-10-08)
// holds lists as plain `<ul>`/`<ol>`/`<li>`, a nested list INSIDE the item it
// indents under, never inside a line div, at most MAX_LIST_DEPTH deep, and no
// attribute on any of them (the sanitizer strips `start`, `type`, classes).
// Lines around a list are joined by `<br>` and a list is a block, so no `<br>`
// sits directly before or after one — the same canonical shape the editor's
// own markdown paste writes (slides/src/editor/markdown.ts listHtml). Emitting
// exactly that shape is what makes an imported text survive sanitizeHtml
// byte for byte, so the first edit does not "change" a document nobody
// touched.
//
// A document whose text holds a list declares `requires: ['rich-text']`
// (slides/src/model.ts RICH_TEXT_FEATURE): an older reader would show the
// items as run-on lines and write that back. withListRequires is the
// importers' half of model.ts's syncRichTextRequires — the app re-syncs on
// load anyway, but the converter's output is a file in its own right (the
// desktop and CLI write it without the editor ever holding it).

import type { OutDoc } from './types.ts'

/** The rich-text `requires` name (slides/src/model.ts RICH_TEXT_FEATURE). */
export const RICH_TEXT_FEATURE = 'rich-text'

/** Deepest list the slides sanitizer keeps (render.ts MAX_LIST_DEPTH);
 *  deeper items join the deepest level, the way the editor's paste does. */
export const MAX_LIST_DEPTH = 6

/** One paragraph of an imported text: a plain line, or a list item at a
 *  source indent `level` (any non-negative number — only the ORDER of levels
 *  matters, so pptx lvl and markdown indent both work). `html` is the
 *  paragraph's inline markup, already escaped. */
export type HtmlPara =
  | { kind: 'line'; html: string }
  | { kind: 'item'; level: number; ordered: boolean; html: string }

/**
 * Paragraphs → the sanitizer-stable html described in the header.
 *
 * Blank lines next to a list need care, because a `<br>` at the END of a run
 * of lines draws no line of its own: the run before a list that ends in a
 * blank line gets one extra `<br>` so the blank line stays visible. A run
 * after a list needs nothing — its leading `<br>` already starts a blank line.
 */
export function paragraphsHtml(paras: HtmlPara[]): string {
  paras = foldBlankItems(paras)
  let out = ''
  const stack: Array<{ level: number; tag: 'ul' | 'ol' }> = []
  let lines: string[] = []
  const flushLines = (beforeList: boolean): void => {
    if (!lines.length) return
    out += lines.join('<br>')
    if (beforeList && lines[lines.length - 1] === '') out += '<br>'
    lines = []
  }
  const closeAll = (): void => {
    while (stack.length) out += `</li></${stack.pop()!.tag}>`
  }
  for (const p of paras) {
    if (p.kind === 'line') {
      closeAll()
      lines.push(p.html)
      continue
    }
    flushLines(true)
    const tag = p.ordered ? 'ol' : 'ul'
    while (stack.length && stack[stack.length - 1].level > p.level) out += `</li></${stack.pop()!.tag}>`
    const top = stack[stack.length - 1]
    if (top && (top.level === p.level || stack.length >= MAX_LIST_DEPTH)) {
      if (top.tag === tag || top.level !== p.level) out += '</li><li>'
      else {
        // same level, other kind: a sibling list (still inside the parent item)
        out += `</li></${top.tag}><${tag}><li>`
        top.tag = tag
      }
    } else {
      out += `<${tag}><li>`
      stack.push({ level: p.level, tag })
    }
    out += p.html
  }
  closeAll()
  flushLines(false)
  return out
}

/**
 * An empty paragraph BETWEEN two list items is a blank line inside the list,
 * not the end of it: PowerPoint numbers "1. / blank / 2.", and closing the
 * <ol> there would restart the count at 1. The run of blanks joins the
 * previous item as trailing `<br>`s — one more than the blanks, since the
 * last `<br>` of an item draws no line (`<li>one<br><br></li>` = "one" and
 * one blank line). Only when the next item is not DEEPER: a deeper one opens
 * its list inside that same item, and a `<br>` touching a list is not the
 * canonical shape — that rare case keeps the blank as a line.
 */
function foldBlankItems(paras: HtmlPara[]): HtmlPara[] {
  const out: HtmlPara[] = []
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]
    const prev = out[out.length - 1]
    if (p.kind === 'line' && p.html === '' && prev?.kind === 'item') {
      let j = i
      while (j < paras.length && paras[j].kind === 'line' && paras[j].html === '') j++
      const next = paras[j]
      if (next?.kind === 'item' && next.level <= prev.level) {
        out[out.length - 1] = { ...prev, html: prev.html + '<br>'.repeat(j - i + 1) }
        i = j - 1
        continue
      }
    }
    out.push(p)
  }
  return out
}

/** Markup only a list can hold — the list half of model.ts's RICH_MARKUP. */
const LIST_MARKUP = /<(?:ul|ol|li)[\s/>]/i

/** True when any text element or table cell of the document (slides or
 *  slide types) carries a list. */
export function usesLists(doc: Pick<OutDoc, 'slides' | 'layouts'>): boolean {
  for (const list of [doc.slides, doc.layouts ?? []]) {
    for (const s of list) {
      for (const el of s.elements) {
        if (el.type === 'text' && LIST_MARKUP.test(el.html)) return true
        if (el.type === 'table' && el.rows.some((r) => r.cells.some((c) => LIST_MARKUP.test(c.html)))) return true
      }
    }
  }
  return false
}

/** Declare `rich-text` in `doc.requires` when the converted text holds a
 *  list (deduped against what is already there); leave `requires` absent
 *  otherwise. In place; returns the doc for chaining. */
export function withListRequires<T extends OutDoc>(doc: T): T {
  if (!usesLists(doc)) return doc
  const cur = doc.requires ?? []
  if (!cur.includes(RICH_TEXT_FEATURE)) doc.requires = [...cur, RICH_TEXT_FEATURE]
  return doc
}
