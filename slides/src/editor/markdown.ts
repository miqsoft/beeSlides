// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Lightweight markdown affordances for text editing. Three entry points:
// - autoformatAtCaret: called on every input; when the text just before the
//   caret completes an inline pattern (**bold**, *italic*, `code`, ~~strike~~)
//   the markers collapse into the real element, Notion-style. "- " / "* " at
//   the start of a line starts a bulleted list, "1. " a numbered one.
// - markdownToHtml: converts pasted plain text (inline patterns, [links](…),
//   bulleted/numbered lists nested by indentation, line breaks) into the
//   rich-text subset text elements store (render.ts sanitizeHtml — which
//   every caller still runs over the result; this file produces, it never
//   vouches).
// - htmlToMarkdown: the way back, for the same subset. Colour and size have
//   no markdown spelling and come back as their plain words; keptLines lets
//   an outline edit put them back on every line it did not change.
//
// Lists are REAL lists since rich text phase 1 (DECISIONS 2026-10-08) — the
// old typed "• " glyph is gone from both directions.

import { mathContextAt } from './mathpalette'

const INLINE: Array<{ re: RegExp; tag: string }> = [
  { re: /\*\*([^*\n]+)\*\*$/, tag: 'b' },
  { re: /__([^_\n]+)__$/, tag: 'b' },
  { re: /(?<![*\w])\*([^*\n]+)\*$/, tag: 'i' },
  { re: /(?<![_\w])_([^_\n]+)_$/, tag: 'i' },
  { re: /~~([^~\n]+)~~$/, tag: 's' },
  { re: /`([^`\n]+)`$/, tag: 'code' },
]

/** The most recent conversion, revertible with ⌘Z until the next input. */
type LastFormat =
  | { kind: 'inline'; el: HTMLElement; source: string; tail: Text }
  | { kind: 'list'; ordered: boolean; source: string }
let lastFormat: LastFormat | null = null

/** Forget the revertible conversion (any input that isn't a fresh conversion). */
export function clearAutoformat() {
  lastFormat = null
}

/** ⌘Z immediately after a conversion: restore the literal typed markers.
 *  Returns true when it reverted (caller should preventDefault). */
export function undoAutoformat(): boolean {
  const last = lastFormat
  lastFormat = null
  if (!last) return false
  if (last.kind === 'list') {
    // the same command toggles the list off again; then the typed marker
    document.execCommand(last.ordered ? 'insertOrderedList' : 'insertUnorderedList')
    document.execCommand('insertText', false, last.source)
    return true
  }
  if (!last.el.isConnected) return false
  const literal = document.createTextNode(last.source)
  last.el.replaceWith(literal)
  last.tail.remove()
  placeCaret(literal, literal.data.length)
  return true
}

/** Collapse a just-completed markdown marker before the caret. Returns true if it fired. */
let literalInsert = false

/** Insert `text` at the caret exactly as written — "paste without design"
 *  (⌘⇧V). execCommand fires the element's `input` synchronously, and the
 *  autoformat listener on it would otherwise turn a pasted `**x**` into
 *  bold after all. */
export function insertLiteralText(text: string): void {
  literalInsert = true
  try { document.execCommand('insertText', false, text) } finally { literalInsert = false }
}

export function autoformatAtCaret(): boolean {
  if (literalInsert) return false
  const sel = document.getSelection()
  if (!sel?.isCollapsed || !(sel.anchorNode instanceof Text)) return false
  const node = sel.anchorNode
  const off = sel.anchorOffset // capture — DOM mutation below resets the live selection
  const upto = node.data.slice(0, off)

  // "- " / "* " at line start → a bulleted list, "1. " / "1) " → a numbered
  // one (contentEditable renders the trailing space as NBSP, so match both).
  // Not inside a list already: there the marker is just text.
  const lm = /(?:^|\n)(-|\*|1[.)])[ \u00A0]$/.exec(upto)
  if (lm && isLineStart(node, off - lm[1].length - 1) && !node.parentElement?.closest('li')) {
    const len = lm[1].length + 1
    const source = node.data.slice(off - len, off)
    const ordered = lm[1] !== '-' && lm[1] !== '*'
    // List FIRST, while the line still has the marker in it: deleting the
    // marker first leaves an empty line whose caret Chrome resolves into the
    // line above, and that line is what became the list. Then the marker goes
    // with the editor's own delete — native undo sees both steps.
    document.execCommand(ordered ? 'insertOrderedList' : 'insertUnorderedList')
    // The command does not keep the caret where it was (measured: it lands
    // at the item's start, where a backspace would undo the list), so the
    // marker is found again at the start of the new item and deleted as a
    // selection.
    const after = document.getSelection()
    const at = after?.anchorNode
    const li = (at instanceof Element ? at : at?.parentElement)?.closest('li')
    const first = li ? document.createTreeWalker(li, NodeFilter.SHOW_TEXT).nextNode() as Text | null : null
    if (after && first && first.data.startsWith(source)) {
      const r = document.createRange()
      r.setStart(first, 0)
      r.setEnd(first, len)
      after.removeAllRanges()
      after.addRange(r)
      document.execCommand('delete')
    }
    lastFormat = { kind: 'list', ordered, source }
    return true
  }

  for (const { re, tag } of INLINE) {
    const m = upto.match(re)
    if (!m || !m[1]) continue
    const start = off - m[0].length
    // backslash escape: \*literal\* stays literal (stripped on commit)
    if (start > 0 && node.data[start - 1] === '\\') continue
    // inside $…$ math the markers are TeX (`a*b`, `x_i`), never markdown
    if (mathContextAt(upto, start)) continue
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, off)
    range.deleteContents()
    const el = document.createElement(tag)
    el.textContent = m[1]
    range.insertNode(el)
    // caret into a fresh text node AFTER the element so typing continues plain
    const tail = document.createTextNode('​')
    el.after(tail)
    placeCaret(tail, 1)
    lastFormat = { kind: 'inline', el, source: m[0], tail }
    return true
  }
  return false
}

/** True when offset sits at the start of a rendered line (node start or after
 *  a <br>). Zero-width caret spacers left by autoformat are see-through. */
function isLineStart(node: Text, offset: number): boolean {
  const before = node.data.slice(0, offset).replace(/​/g, '')
  if (before) return before.endsWith('\n')
  let prev = node.previousSibling
  while (prev && prev.nodeType === Node.TEXT_NODE && /^[​\s]*$/.test((prev as Text).data)) {
    prev = prev.previousSibling
  }
  return !prev || (prev instanceof Element && prev.tagName === 'BR')
}

function placeCaret(node: Node, offset: number) {
  const r = document.createRange()
  r.setStart(node, offset)
  r.collapse(true)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

const escapeHtml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const escapeAttr = (s: string) => escapeHtml(s).replaceAll('"', '&quot;')

/** A markdown list line: indentation, marker, text. */
const LIST_LINE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
/** Deepest list markdownToHtml writes — the same ceiling the editor's Tab
 *  stops at (render.ts MAX_LIST_DEPTH); deeper lines join the deepest level. */
const MD_MAX_LIST_DEPTH = 6

/**
 * What an outline edit hands back to markdownToHtml (rich text phase 2,
 * DECISIONS 2026-10-08): the field's lines before the edit, in order — each
 * line's markdown (`key`, what markdownToHtml's inline converter sees for
 * it), the html it came from (null where that is no clean fragment) and
 * whether it was an item of a numbered list (`ordered`).
 * markdownToHtml lines the new text up against them: a line whose markdown
 * came back unchanged takes its old html again, and a changed line paired
 * with an old one gets its plain-text edit patched INTO the old html — kept
 * only when that reads back as exactly the markdown typed. So the colour,
 * size and underline markdown cannot spell survive the edit wherever the
 * words around them did. See `keptLines`.
 */
export type KeptLines = Array<{ key: string; html: string | null; ordered?: boolean }>

type ListItem = { indent: number; ordered: boolean; num: string; text: string }

/** Pasted plain text → the rich-text subset (bold/italic/strike/code, links,
 *  nested lists, <br>). Backslash escapes markers: \*x\* pastes as literal *x*.
 *  `keep` (the outline view): the field's old lines, reused where the edit
 *  left them (see KeptLines).
 *
 *  A numbered list starts only at "1." (the format has no list start, so a
 *  list starting anywhere else would renumber what was typed — DECISIONS
 *  2026-10-08): "2019. was a good year", "3." on its own, "01." stay the
 *  plain lines they were typed as. Once a list is open, any numbered line at
 *  its level continues it, as in markdown ("1. 1. 1." is one list; a deleted
 *  or inserted item renumbers the rest). With `keep`, a numbered run may
 *  also start elsewhere when one of its items is an old numbered item — the
 *  outline after deleting the first item ("2. beta / 3. gamma"). */
export function markdownToHtml(text: string, keep?: KeptLines): string {
  // park escaped markers in the private-use area so patterns can't see them
  const PARK = ''
  const parked: string[] = []
  const park = (c: string) => {
    parked.push(c)
    return PARK + (parked.length - 1) + PARK
  }
  const withParked = text
    // a list marker escaped at the start of a line ("1\. ", "\+ ") — only
    // there, so a "\." or "\+" anywhere else keeps its backslash
    .replace(/^([ \t]*\d{1,9})\\([.)])(?=[ \t])/gm, (_, lead: string, c: string) => lead + park(c))
    .replace(/^([ \t]*)\\(\+)(?=[ \t])/gm, (_, lead: string, c: string) => lead + park(c))
    .replace(/\\([\\*_~`\-[\]])/g, (_, c: string) => park(c))
  // the line as it was typed, for the `keep` lookup
  const typed = (s: string) => s.replace(/(\d+)/g, (_, i) => '\\' + parked[+i])
  const unpark = (s: string) => s.replace(/(\d+)/g, (_, i) => parked[+i])
  // with `keep`, every line's inline html is decided at the end, once all
  // lines are known (the alignment needs them all): a placeholder until then
  const FRAG = ''
  const recorded: Array<{ line: string; item: boolean }> = []
  const inline = (line: string, item = false): string => {
    if (!keep) return inlineMarkdown(line)
    recorded.push({ line, item })
    return FRAG + (recorded.length - 1) + FRAG
  }

  // the outline: a numbered run may start at another number than 1 when it
  // was written from a real numbered list — one of its items (same level,
  // the run's own) is an old numbered item, words as they were
  const orderedKeys = new Set(keep?.filter((e) => e.ordered).map((e) => e.key))
  const oldNumbered = orderedKeys.size
    ? (items: ListItem[], k: number) => {
        const indent = items[k].indent
        for (let j = k; j < items.length && items[j].ordered && items[j].indent >= indent; j++) {
          if (items[j].indent === indent && orderedKeys.has(typed(items[j].text))) return true
        }
        return false
      }
    : null

  const segments: Array<{ list: boolean; html: string }> = []
  const lines = withParked.split('\n')
  for (let i = 0; i < lines.length;) {
    const items: ListItem[] = []
    for (let j = i; j < lines.length; j++) {
      const m = LIST_LINE.exec(lines[j])
      if (!m) break
      const ordered = /\d/.test(m[2])
      items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered, num: ordered ? m[2].slice(0, -1) : '', text: m[3] })
    }
    const list = items.length ? listHtml(items, (t) => inline(t, true), oldNumbered ? (k) => oldNumbered(items, k) : undefined) : null
    if (!list) {
      segments.push({ list: false, html: inline(lines[i]) })
      i++
      continue
    }
    segments.push({ list: true, html: list.html })
    i += list.used
  }
  // a list is a block: no <br> on either side of one
  let out = ''
  segments.forEach((seg, k) => {
    if (k > 0 && !seg.list && !segments[k - 1].list) out += '<br>'
    out += seg.html
  })
  out = unpark(out)
  if (!keep) return out
  const frags = keptHtml(recorded.map((r) => ({ key: typed(r.line), item: r.item, fresh: () => unpark(inlineMarkdown(r.line)) })), keep)
  return out.replace(/(\d+)/g, (_, i) => frags[+i])
}

/**
 * The inline html of each new line, given the field's old lines: LCS over
 * the line keys pairs every unchanged line with its old self (its old html
 * comes back); between two such anchors, the changed lines pair up in order
 * with the old lines left there, and each tries `patchLine`. Everything
 * else converts fresh.
 */
function keptHtml(lines: Array<{ key: string; item: boolean; fresh: () => string }>, keep: KeptLines): string[] {
  const n = lines.length
  const m = keep.length
  const match: Array<number | null> = new Array(n).fill(null)
  if (n * m <= 4_000_000) {
    // classic LCS table, then walk it back for the pairs
    const w = m + 1
    const L = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = lines[i].key === keep[j].key ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
      }
    }
    for (let i = 0, j = 0; i < n && j < m;) {
      if (lines[i].key === keep[j].key) { match[i++] = j++ }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) i++
      else j++
    }
  } else {
    // a huge field: in-order greedy, still never pairs a line twice
    for (let i = 0, j = 0; i < n && j < m; i++) {
      const k = keep.findIndex((e, x) => x >= j && e.key === lines[i].key)
      if (k >= 0) { match[i] = k; j = k + 1 }
    }
  }
  const out: string[] = []
  let lastOld = -1
  for (let i = 0; i < n;) {
    if (match[i] !== null) {
      const j = match[i]!
      out.push(keep[j].html ?? lines[i].fresh())
      lastOld = j
      i++
      continue
    }
    // a run of changed lines, and the old lines between the same anchors:
    // each changed line pairs with an old one only where they still read
    // alike (gapPairs), so a line inserted among edited ones never takes
    // its neighbour's runs
    let end = i
    while (end < n && match[end] === null) end++
    const nextOld = end < n ? match[end]! : m
    const pairs = gapPairs(lines.slice(i, end).map((l) => l.key), keep.slice(lastOld + 1, nextOld).map((e) => e.key))
    for (let k = i; k < end; k++) {
      const o = pairs[k - i]
      const old = o === null ? undefined : keep[lastOld + 1 + o]
      const fresh = lines[k].fresh()
      out.push((old?.html != null ? patchLine(old.html, fresh, lines[k].key, lines[k].item) : null) ?? fresh)
    }
    i = end
  }
  return out
}

/** How much of `old` an edit into `now` left standing: the common start
 *  plus the common end (not overlapping), as a share of the old line. */
function kept(old: string, now: string): number {
  if (!old) return 0
  let p = 0
  while (p < old.length && p < now.length && old[p] === now[p]) p++
  let q = 0
  while (q < old.length - p && q < now.length - p && old[old.length - 1 - q] === now[now.length - 1 - q]) q++
  return (p + q) / old.length
}

/** Pair the changed lines of one gap with the old lines there, in order:
 *  only pairs that kept at least half of the old line count, and of those
 *  the alignment that keeps the most (an LCS weighted by `kept`). Returns,
 *  per new line, the index of its old line, or null (convert fresh). */
function gapPairs(now: string[], old: string[]): Array<number | null> {
  const a = now.length
  const b = old.length
  const pairs: Array<number | null> = new Array(a).fill(null)
  if (!a || !b || a * b > 250_000) return pairs
  const MIN = 0.5
  const s = (i: number, j: number) => { const v = kept(old[j], now[i]); return v >= MIN ? v : -1 }
  const w = b + 1
  const S = new Float64Array((a + 1) * w)
  const score: number[] = new Array(a * b)
  for (let i = a - 1; i >= 0; i--) {
    for (let j = b - 1; j >= 0; j--) {
      const v = score[i * b + j] = s(i, j)
      S[i * w + j] = Math.max(S[(i + 1) * w + j], S[i * w + j + 1], v >= 0 ? v + S[(i + 1) * w + j + 1] : 0)
    }
  }
  for (let i = 0, j = 0; i < a && j < b;) {
    const v = score[i * b + j]
    if (v >= 0 && S[i * w + j] === v + S[(i + 1) * w + j + 1]) { pairs[i++] = j++ }
    else if (S[(i + 1) * w + j] >= S[i * w + j + 1]) i++
    else j++
  }
  return pairs
}

/**
 * A changed line's words patched into its old html: the text both have in
 * common at the start and the end stays in the old runs, the middle is
 * replaced — and the new words join the run before them, the way typing
 * does. Kept only when the result reads back as exactly the markdown typed
 * (so a change of markup — a new **bold**, a link — never passes, and
 * neither does anything that would alter a word); null = convert fresh.
 */
function patchLine(oldHtml: string, freshHtml: string, key: string, item: boolean): string | null {
  if (typeof document === 'undefined') return null
  const box = document.createElement('div')
  box.innerHTML = oldHtml
  const probe = document.createElement('div')
  probe.innerHTML = freshHtml
  // the old text still has contentEditable's NBSPs, the markdown (and so the
  // new text) plain spaces: compare as spaces — the offsets stay 1:1 with the
  // old text nodes, and the kept parts keep their NBSPs
  const a = (box.textContent ?? '').replace(/ /g, ' ')
  const b = probe.textContent ?? ''
  if (!a || a === b) return null // no words to keep, or a markup-only change
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let q = 0
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++
  const from = textPoint(box, p, true)
  const to = textPoint(box, a.length - q, false)
  if (!from || !to) return null
  const r = document.createRange()
  r.setStart(from.node, from.offset)
  r.setEnd(to.node, to.offset)
  r.deleteContents()
  // into the start's own text node (deleteContents only truncated it; the
  // collapsed range itself may have moved up out of the run)
  const middle = b.slice(p, b.length - q)
  if (middle) from.node.insertData(from.offset, middle)
  // runs the deletion emptied
  for (const el of Array.from(box.querySelectorAll('*')).reverse()) {
    if (!el.textContent && !el.querySelector('br, img')) el.remove()
  }
  const html = box.innerHTML
  const back = markdownLines(html)
  if (back.length !== 1 || back[0].html === null) return null
  return (item ? back[0].words : back[0].md) === key ? html : null
}

/** The text node + offset `pos` characters into `box`'s text. At a boundary
 *  between two text nodes, `early` picks the end of the first one. */
function textPoint(box: HTMLElement, pos: number, early: boolean): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
  let seen = 0
  let last: Text | null = null
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length
    if (pos < seen + len || (early && pos === seen + len)) return { node: n, offset: pos - seen }
    seen += len
    last = n
  }
  return last && pos === seen ? { node: last, offset: last.data.length } : null
}

/** One line's inline markdown → html. Links are cut out first and parked, so
 *  emphasis never reaches into a URL (`a_b_c` in a path is not italic). */
function inlineMarkdown(line: string): string {
  const LINK = ''
  const links: string[] = []
  let s = escapeHtml(line).replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_m, label: string, href: string) => {
    // href arrives html-escaped (&amp; for &); un-escape before re-escaping
    // it as an attribute. Whether it is a link we keep is sanitizeHtml's call.
    const raw = href.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
    links.push(`<a href="${escapeAttr(raw)}">${label}</a>`)
    return LINK + (links.length - 1) + LINK
  })
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  s = s.replace(/__([^_]+)__/g, '<b>$1</b>')
  s = s.replace(/(?<![*\w])\*([^*]+)\*/g, '<i>$1</i>')
  s = s.replace(/(?<![_\w])_([^_]+)_(?![\w])/g, '<i>$1</i>')
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  return s.replace(/(\d+)/g, (_, i) => links[+i])
}

/** Consecutive list lines → nested <ul>/<ol>, a sub-list inside its item.
 *  Deeper indentation opens a level, shallower closes back to the level it
 *  matches; a marker of the other kind at the same level starts a new list.
 *  Stops before a numbered line that would START a list at another number
 *  than 1, unless `mayStart(k)` allows item k to (`used` = lines taken;
 *  null = not even the first). */
function listHtml(items: ListItem[], inline: (line: string) => string, mayStart?: (k: number) => boolean): { html: string; used: number } | null {
  let html = ''
  const stack: Array<{ indent: number; tag: 'ul' | 'ol' }> = []
  let used = 0
  for (const [k, it] of items.entries()) {
    const tag = it.ordered ? 'ol' : 'ul'
    // where this item would land, without writing anything yet
    let depth = stack.length
    while (depth > 1 && it.indent < stack[depth - 1].indent) depth--
    const top = depth ? stack[depth - 1] : undefined
    const opens = !top || (it.indent > top.indent && depth < MD_MAX_LIST_DEPTH)
    const starts = opens || top!.tag !== tag
    if (it.ordered && starts && it.num !== '1' && !mayStart?.(k)) break
    while (stack.length > depth) html += `</li></${stack.pop()!.tag}>`
    if (opens) {
      html += `<${tag}><li>`
      stack.push({ indent: it.indent, tag })
    } else if (top!.tag !== tag) {
      html += `</li></${top!.tag}><${tag}><li>`
      stack[stack.length - 1] = { indent: top!.indent, tag }
    } else {
      html += '</li><li>'
    }
    html += inline(it.text)
    used++
  }
  if (!used) return null
  while (stack.length) html += `</li></${stack.pop()!.tag}>`
  return { html, used }
}

/** An href as markdownToHtml's link pattern reads it back: one level of
 *  balanced parentheses stays as written (…/wiki/Foo_(bar)); anything else
 *  — an unbalanced or nested paren, whitespace — is percent-encoded, which
 *  names the same URL. */
function markdownHref(href: string): string {
  if (/^(?:[^()\s]|\([^()\s]*\))*$/.test(href)) return href
  return href.replace(/[()\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
}

/** One markdown line htmlToMarkdown writes. `key` is what markdownToHtml
 *  hands its inline converter for that line (a list item's words without
 *  indentation and marker); `html` the line's own html, or null where it is
 *  no clean fragment (a line break inside a styled run). */
interface MdLine { md: string; key: string; words: string; html: string | null; list: boolean; ordered: boolean }

/** A plain line that would read back as a list item gets its marker escaped:
 *  "- x" → "\- x", "+ x" → "\+ x", and a number that would start or continue
 *  a list ("1. x", or any "n. x" right after a list) → "1\. x". In a field
 *  that holds a numbered list (`numbered`) every "n. x" is escaped: an
 *  outline edit lets a run of old numbered items start at any number. */
function escapeLineStart(md: string, afterList: boolean, numbered: boolean): string {
  return md
    .replace(/^([ \t]*)([-+])(?=[ \t])/, '$1\\$2')
    .replace(/^([ \t]*)(\d{1,9})([.)])(?=[ \t])/, (m, lead: string, n: string, c: string) =>
      n === '1' || afterList || numbered ? `${lead}${n}\\${c}` : m)
}

function markdownLines(html: string): MdLine[] {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const lines: MdLine[] = []
  const numbered = !!tpl.content.querySelector('ol')
  let cur = '' // the line's markdown so far (a list item: its words)
  let prefix = '' // a list item's indentation + marker
  let frag: string | null = '' // the line's html so far
  let inlineDepth = 0 // > 0 while walking inside a run (b, span, a …)
  const ser = document.createElement('div')
  const textHtml = (s: string) => { ser.textContent = s; return ser.innerHTML }
  const breakLine = () => {
    const list = !!prefix
    const md = list ? prefix + cur : escapeLineStart(cur, !!lines.length && lines[lines.length - 1].list, numbered)
    // a line broken inside a run is no clean fragment
    lines.push({ md, key: list ? cur : md, words: cur, html: inlineDepth ? null : frag, list, ordered: /\d\. $/.test(prefix) })
    cur = ''
    prefix = ''
    frag = ''
  }
  /** After a line or block boundary inside a run, the rest of the run's line
   *  is no clean fragment either. */
  const taint = () => { if (inlineDepth) frag = null }
  /** A block starts: end the line before it (or forget the markup-only
   *  html — an empty run — that a line with no words gathered). */
  const blockStart = () => {
    if (cur) breakLine()
    else if (!inlineDepth && frag !== null) frag = ''
  }
  const text = (s: string) => s.replace(/[\\*_~`[\]]/g, (c) => '\\' + c).replace(/ /g, ' ')
  const walk = (node: Node, depth: number) => {
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        cur += text(n.textContent ?? '')
        if (!inlineDepth && frag !== null) frag += textHtml(n.textContent ?? '')
        continue
      }
      if (!(n instanceof Element)) continue
      const tag = n.tagName
      const run = (fn: () => void) => {
        if (!inlineDepth && frag !== null) frag += n.outerHTML
        inlineDepth++
        try { fn() } finally { inlineDepth-- }
      }
      const wrap = (mark: string) => run(() => { cur += mark; walk(n, depth); cur += mark })
      switch (tag) {
        case 'B': case 'STRONG': wrap('**'); break
        case 'I': case 'EM': wrap('*'); break
        case 'S': wrap('~~'); break
        case 'CODE': run(() => { cur += '`' + (n.textContent ?? '') + '`' }); break
        case 'BR': breakLine(); taint(); break
        case 'A': run(() => { cur += '['; walk(n, depth); cur += `](${markdownHref(n.getAttribute('href') ?? '')})` }); break
        case 'UL': case 'OL': {
          blockStart()
          let k = 0
          for (const li of Array.from(n.children)) {
            if (li.tagName !== 'LI') continue
            k++
            prefix = '  '.repeat(depth) + (tag === 'OL' ? `${k}. ` : '- ')
            cur = ''
            if (frag !== null) frag = ''
            // the item's own words, then its sub-lists on their own lines
            const nested: Element[] = []
            const holder = document.createElement('span')
            for (const c of Array.from(li.childNodes)) {
              if (c instanceof Element && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(c)
              else holder.appendChild(c.cloneNode(true))
            }
            walk(holder, depth)
            // (a block inside the item has already written the item's line)
            if (cur || prefix) breakLine()
            for (const sub of nested) { const box = document.createElement('div'); box.appendChild(sub.cloneNode(true)); walk(box, depth + 1) }
          }
          taint()
          break
        }
        case 'DIV': case 'P':
          blockStart()
          walk(n, depth)
          if (cur) breakLine()
          taint()
          break
        default: run(() => walk(n, depth))
      }
    }
  }
  walk(tpl.content, 0)
  if (cur) breakLine()
  return lines
}

/**
 * The rich-text subset → markdown that markdownToHtml reads back to the same
 * structure: **bold**, *italic*, ~~strike~~, `code`, [links](…), "- " / "1. "
 * lists indented two spaces per level, one line per <br>/block. Underline,
 * colour and size have no markdown and come back as plain text (an outline
 * edit keeps them on the lines it does not change — `keptLines`). Markers
 * that occur in the text itself are backslash-escaped.
 */
export function htmlToMarkdown(html: string): string {
  return markdownLines(html).map((l) => l.md).join('\n')
}

/**
 * For markdownToHtml's `keep`: every line htmlToMarkdown(html) writes, in
 * order, with the html it came from. Feed it the SAME (sanitized) html the
 * field was filled from; whatever markdownToHtml builds from it still goes
 * through sanitizeHtml like any other result.
 */
export function keptLines(html: string): KeptLines {
  return markdownLines(html).map((l) => ({ key: l.key, html: l.html, ...(l.ordered ? { ordered: true } : {}) }))
}
