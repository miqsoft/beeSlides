// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Block-level markdown + Pandoc fenced divs → a small AST. The only genuinely
// new parsing in the Quarto importer; everything else in convert/ maps an
// already-structured tree onto elements.
//
// SCOPE IS DELIBERATELY BLOCK-LEVEL. What a `.qmd` slide needs is "which box
// is this" — a heading, a paragraph, a list, a fence, a table, a figure, a
// fenced div — because that is what has to become an element with a frame.
// Inline formatting is a separate, much smaller job (`inlineToHtml` below),
// and it targets the SAME inline-html subset slides already store: b/i/s/
// code/br, inside the allowlist of slides/src/render.ts `RICH_TAGS`. The one
// block structure the format holds — real lists — is built from this AST by
// qmd.ts through convert/lists.ts; this parser invents no other.
//
// THREE THINGS ARE HELD VERBATIM, and each is a correctness requirement:
//
//   - `$…$` / `$$…$$`. slides renders TeX at render time (render.ts
//     `resolveMath`), so `.qmd` math IS slides math and the right move is to
//     not touch it. But it must be masked BEFORE the emphasis rules run, or
//     `$a_1 * b$` loses its subscript to <i> and its star to nothing.
//     `resolveMath` runs after `sanitizeHtml` and decodes entities itself, so
//     the masked body is entity-escaped like everything else.
//   - Fenced code bodies. A ``` fence becomes a `code` element whose
//     `content` is the raw source — never html, never escaped.
//   - Backslash escapes. `\*` is a literal star, and it has to survive both
//     the emphasis pass and the escaping pass.
//
// Pandoc's fenced divs (`::: {.notes}`) are parsed here rather than in qmd.ts
// because they NEST (`.columns` holds `.column`s) and nesting is a parser's
// job; deciding what a class MEANS is the orchestrator's.

/** A Pandoc attribute block: `{.cls #id key="value"}`. */
export interface Attrs {
  classes: string[]
  id?: string
  keys: Record<string, string>
}

export type Align = 'left' | 'center' | 'right'

/** One list item. `depth` is the source indent in units of 2 spaces; qmd.ts
 *  nests the emitted <ul>/<ol> by it (convert/lists.ts — the shape
 *  slides/src/editor/markdown.ts writes for a pasted list). `ordered` is the
 *  item's OWN marker kind: a nested level may differ from the list's (bullet
 *  details under numbered steps); `ordinal` is set exactly when it is. */
export interface MdItem { depth: number; text: string; ordered: boolean; ordinal?: number }

export type MdBlock =
  | { kind: 'heading'; level: number; text: string; at: Attrs }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; items: MdItem[] }
  /** `cell` = an EXECUTABLE Quarto cell (```{r}), not a highlighted fence
   *  (```r / ```{.r}). The distinction is the whole "did you run it?" report. */
  | { kind: 'code'; lang: string; content: string; at: Attrs; cell: boolean }
  | { kind: 'table'; head: string[]; rows: string[][]; aligns: Align[] }
  | { kind: 'image'; src: string; alt: string; at: Attrs }
  | { kind: 'math'; tex: string }
  | { kind: 'quote'; blocks: MdBlock[] }
  | { kind: 'div'; at: Attrs; blocks: MdBlock[] }
  | { kind: 'rule' }
  /** Quarto's `. . .` — "everything after this enters on the next click". */
  | { kind: 'pause' }
  | { kind: 'raw'; text: string }

const EMPTY_ATTRS = (): Attrs => ({ classes: [], keys: {} })

// --- attribute blocks --------------------------------------------------------

/**
 * `{.cls .cls2 #id key=value key="v v"}` → Attrs. Braces optional.
 *
 * A BARE word reads as a class, which is Pandoc's own shorthand for fenced
 * divs (`::: notes` ≡ `::: {.notes}`) and is also what makes a knitr cell
 * header's language token (`{r, echo=FALSE}`) land somewhere useful.
 */
export function parseAttrs(src: string): Attrs {
  const at = EMPTY_ATTRS()
  const s = src.trim().replace(/^\{/, '').replace(/\}$/, '')
  const re = /([.#]?[A-Za-z_][\w.:-]*)[ \t]*=[ \t]*("[^"]*"|'[^']*'|[^\s,}]+)|([.#][\w.:-]+)|([A-Za-z_][\w.:-]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m[1]) at.keys[m[1].replace(/^[.#]/, '')] = m[2].replace(/^["']|["']$/g, '')
    else if (m[3]) {
      if (m[3][0] === '.') at.classes.push(m[3].slice(1))
      else at.id = m[3].slice(1)
    } else if (m[4]) at.classes.push(m[4])
  }
  return at
}

/** Split a trailing `{…}` attribute block off a heading/figure line. */
function splitTrailingAttrs(text: string): { text: string; at: Attrs } {
  const m = /^([\s\S]*?)[ \t]*(\{[^{}]*\})[ \t]*$/.exec(text)
  if (!m) return { text: text.trim(), at: EMPTY_ATTRS() }
  return { text: m[1].trim(), at: parseAttrs(m[2]) }
}

/**
 * A fence's info string. Quarto has two forms and they mean different things:
 *
 *     ```{r}            an executable cell — knitr/Jupyter RUNS this
 *     ```{python, echo=FALSE}
 *     ```r              a highlighted listing
 *     ```{.r}           the same, in Pandoc's attribute spelling
 *
 * A BARE language token inside the braces is the executable form. Reporting
 * that honestly is the importer's single most useful piece of advice ("run
 * `quarto render --to markdown` first"), so the parser records it rather than
 * flattening both into "a code block".
 */
export function parseFenceInfo(info: string): { lang: string; cell: boolean; at: Attrs } {
  const s = info.trim()
  if (s.startsWith('{')) {
    const close = s.lastIndexOf('}')
    const inner = s.slice(1, close < 0 ? undefined : close)
    const at = parseAttrs(inner)
    const bare = /^[ \t]*([A-Za-z][\w+#.-]*)[ \t]*(?:,|$)/.exec(inner)
    if (bare) return { lang: bare[1].toLowerCase(), cell: true, at }
    return { lang: (at.classes[0] ?? '').toLowerCase(), cell: false, at }
  }
  const sp = s.split(/[\s,]+/).filter(Boolean)
  return { lang: (sp[0] ?? '').toLowerCase(), cell: false, at: parseAttrs(sp.slice(1).join(' ')) }
}

// --- block scanner -----------------------------------------------------------

const HEAD = /^[ \t]{0,3}(#{1,6})[ \t]+(.*)$/
const FENCE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*(.*)$/
const DIVFENCE = /^[ \t]{0,3}(:{3,})[ \t]*(.*)$/
const RULE = /^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const PAUSE = /^[ \t]*\.[ \t]+\.[ \t]+\.[ \t]*$/
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const SETEXT = /^[ \t]{0,3}(=+|-+)[ \t]*$/
const QUOTE = /^[ \t]{0,3}>[ \t]?(.*)$/
const MATH_OPEN = /^[ \t]*\$\$[ \t]*(.*)$/
const IMG_ONLY = /^[ \t]*!\[([^\]]*)\]\([ \t]*<?([^)>\s]*)>?(?:[ \t]+["'][^"']*["'])?[ \t]*\)[ \t]*(\{[^{}]*\})?[ \t]*$/
/** A pipe-table delimiter row: `|---|:--:|`, `--- | ---`. */
const TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/

/** Parse a markdown document body (front matter already removed). */
export function parseBlocks(src: string): MdBlock[] {
  return parse(src.replace(/\r\n?/g, '\n').split('\n'))
}

function parse(lines: string[]): MdBlock[] {
  const out: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    // ---- fenced div (`::: {.notes}` … `:::`), nesting-aware
    const dm = DIVFENCE.exec(line)
    if (dm) {
      if (!dm[2].trim()) { i++; continue } // an unmatched close — skip it
      const at = parseAttrs(dm[2])
      const body: string[] = []
      let depth = 1
      i++
      for (; i < lines.length; i++) {
        const d = DIVFENCE.exec(lines[i])
        if (d) {
          if (d[2].trim()) depth++
          else if (--depth === 0) { i++; break }
        }
        body.push(lines[i])
      }
      out.push({ kind: 'div', at, blocks: parse(body) })
      continue
    }

    // ---- fenced code
    const fm = FENCE.exec(line)
    if (fm) {
      const [, indent, bars, info] = fm
      const body: string[] = []
      const closer = new RegExp(`^[ \\t]{0,3}${bars[0] === '`' ? '`' : '~'}{${bars.length},}[ \\t]*$`)
      i++
      for (; i < lines.length; i++) {
        if (closer.test(lines[i])) { i++; break }
        // Fences may be indented with their container; strip only that much.
        body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i])
      }
      const { lang, cell, at } = parseFenceInfo(info)
      out.push({ kind: 'code', lang, cell, at, content: stripCellOptions(body).join('\n') })
      continue
    }

    // ---- display math on its own line(s)
    const mm = MATH_OPEN.exec(line)
    if (mm) {
      if (/\$\$[ \t]*$/.test(mm[1])) {
        out.push({ kind: 'math', tex: mm[1].replace(/\$\$[ \t]*$/, '').trim() })
        i++
        continue
      }
      const body = [mm[1]]
      i++
      for (; i < lines.length; i++) {
        const end = lines[i].indexOf('$$')
        if (end >= 0) { body.push(lines[i].slice(0, end)); i++; break }
        body.push(lines[i])
      }
      out.push({ kind: 'math', tex: body.join('\n').trim() })
      continue
    }

    // ---- ATX heading
    const hm = HEAD.exec(line)
    if (hm) {
      const { text, at } = splitTrailingAttrs(hm[2].replace(/[ \t]+#+[ \t]*$/, ''))
      out.push({ kind: 'heading', level: hm[1].length, text, at })
      i++
      continue
    }

    if (PAUSE.test(line)) { out.push({ kind: 'pause' }); i++; continue }

    // ---- pipe table: a row with a pipe, then a delimiter row
    if (line.includes('|') && i + 1 < lines.length
      && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line)
      const aligns = splitRow(lines[i + 1]).map<Align>((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':')
        return l && r ? 'center' : r ? 'right' : 'left'
      })
      i += 2
      const rows: string[][] = []
      for (; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(splitRow(lines[i]))
      out.push({ kind: 'table', head, rows, aligns })
      continue
    }

    // ---- thematic break (also Quarto's explicit slide break)
    if (RULE.test(line)) { out.push({ kind: 'rule' }); i++; continue }

    // ---- blockquote
    if (QUOTE.test(line)) {
      const body: string[] = []
      for (; i < lines.length; i++) {
        const q = QUOTE.exec(lines[i])
        if (!q) { if (!lines[i].trim()) break; body.push(lines[i]); continue }
        body.push(q[1])
      }
      out.push({ kind: 'quote', blocks: parse(body) })
      continue
    }

    // ---- list
    if (ITEM.test(line)) {
      const ordered = /\d/.test(ITEM.exec(line)![2])
      const items: MdItem[] = []
      let n = 0
      while (i < lines.length) {
        const it = ITEM.exec(lines[i])
        if (it) {
          const depth = Math.floor(it[1].replace(/\t/g, '  ').length / 2)
          const kind = /\d/.test(it[2])
          // a different kind at the list's own level starts a new list; a
          // DEEPER item of another kind (bullet details under numbered
          // steps) is a nested list inside this one
          if (kind !== ordered && (!items.length || depth <= items[0].depth)) break
          n++
          items.push({
            depth,
            text: it[3],
            ordered: kind,
            ...(kind ? { ordinal: parseInt(it[2], 10) || n } : {}),
          })
          i++
          continue
        }
        // lazy continuation of the previous item
        if (lines[i].trim() && /^[ \t]/.test(lines[i]) && items.length) {
          items[items.length - 1].text += '\n' + lines[i].trim()
          i++
          continue
        }
        // one blank line inside a loose list keeps the list open
        if (!lines[i].trim() && i + 1 < lines.length && ITEM.test(lines[i + 1])) { i++; continue }
        break
      }
      out.push({ kind: 'list', ordered, items })
      continue
    }

    // ---- lone figure
    const gm = IMG_ONLY.exec(line)
    if (gm) {
      out.push({ kind: 'image', alt: gm[1], src: decodePath(gm[2]), at: gm[3] ? parseAttrs(gm[3]) : EMPTY_ATTRS() })
      i++
      continue
    }

    // ---- raw html block
    if (/^[ \t]{0,3}</.test(line)) {
      const body: string[] = []
      for (; i < lines.length && lines[i].trim(); i++) body.push(lines[i])
      out.push({ kind: 'raw', text: body.join('\n') })
      continue
    }

    // ---- paragraph, up to a blank line or the start of another block
    const para: string[] = [line]
    i++
    let consumed = false
    for (; i < lines.length; i++) {
      const l = lines[i]
      if (!l.trim()) break
      // `Title` + `=====` / `-----` is a setext heading, NOT a paragraph
      // followed by a slide break — getting this backwards silently splits
      // a slide in two at every underlined heading.
      const sm = SETEXT.exec(l)
      if (sm && para.length === 1) {
        const { text, at } = splitTrailingAttrs(para[0])
        out.push({ kind: 'heading', level: sm[1][0] === '=' ? 1 : 2, text, at })
        i++
        consumed = true
        break
      }
      if (HEAD.test(l) || FENCE.test(l) || DIVFENCE.test(l) || RULE.test(l) || ITEM.test(l)
        || PAUSE.test(l) || QUOTE.test(l) || MATH_OPEN.test(l)) break
      para.push(l)
    }
    if (!consumed) out.push({ kind: 'para', text: para.join('\n') })
  }
  return out
}

/** `| a | b |` → ['a','b']; escaped `\|` stays inside a cell. */
function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue }
    if (s[i] === '|') { out.push(cur.trim()); cur = ''; continue }
    cur += s[i]
  }
  out.push(cur.trim())
  return out
}

/**
 * Strip a cell's `#| key: value` option lines off the top of a fence body.
 *
 * They are Quarto's YAML-in-a-comment cell header (`#| echo: false`), not
 * source anybody wants on a slide — and left in place they would highlight as
 * comments and push the real first line down.
 */
function stripCellOptions(body: string[]): string[] {
  let k = 0
  while (k < body.length && /^[ \t]*(?:#|\/\/|--|%)\|/.test(body[k])) k++
  const rest = body.slice(k)
  while (rest.length && !rest[0].trim()) rest.shift()
  while (rest.length && !rest[rest.length - 1].trim()) rest.pop()
  return rest
}

/** Percent-decode a figure path, tolerating a malformed escape. */
function decodePath(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

// --- inline → the slides inline-html subset ----------------------------------

/** What an inline pass found that the caller has to report. */
export interface InlineFinding {
  /** `[@key]` citations left as literal text — there is no bibliography. */
  citations: string[]
  /** `[text](url)` flattened to text: `el.link` addresses a SLIDE, not a URL. */
  links: string[]
  /** `[^1]` markers dropped; the note bodies are ordinary blocks. */
  footnotes: number
  /** inline `![](…)` images dropped (a figure has to be its own block) */
  images: string[]
}

export const newFinding = (): InlineFinding => ({ citations: [], links: [], footnotes: 0, images: [] })

/** &, <, > only — the emitted html is markup we build, quotes never matter.
 *  (Same rule, same reason, as convert/text.ts.) */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The mask token for held-verbatim spans. NUL survives `esc()` and cannot
 *  occur in source a text editor produced. */
const NUL = '\u0000'
const UNHOLD = /\u0000(\d+)\u0000/g

/**
 * One paragraph of markdown → the b/i/s/code/br subset `sanitizeHtml` keeps.
 *
 * Math and code spans are MASKED FIRST and restored last, so no emphasis rule
 * can ever see inside them.
 */
export function inlineToHtml(src: string, found: InlineFinding = newFinding()): string {
  const holds: string[] = []
  const hold = (s: string) => `${NUL}${holds.push(s) - 1}${NUL}`
  let s = src

  // 1. backslash escapes — held so the emphasis pass cannot see the marker
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!$~<>|])/g, (_m, c: string) => hold(esc(c)))
  // 2. math, verbatim. render.ts's resolveMath runs on the sanitized html and
  //    decodes entities before handing TeX to Temml, so escaping here is safe
  //    and `$a<b$` survives.
  s = s.replace(/\$\$([^$]+?)\$\$/g, (_m, t: string) => hold(`$$${esc(t)}$$`))
  s = s.replace(/\$(\S(?:[^$\n]*?\S)?)\$(?!\d)/g, (_m, t: string) => hold(`$${esc(t)}$`))
  // 3. code spans
  s = s.replace(/(`+)([^`]+?)\1(?!`)/g, (_m, _b: string, t: string) => hold(`<code>${esc(t)}</code>`))

  s = esc(s)

  // 4. footnote references — the marker means nothing without the note beside it
  s = s.replace(/\[\^[^\]]+\]/g, () => { found.footnotes++; return '' })
  // 5. inline images: a figure needs its own frame, so only a lone-image
  //    PARAGRAPH becomes an image element (see IMG_ONLY). Anything inline
  //    degrades to its alt text.
  s = s.replace(/!\[([^\]]*)\]\([ \t]*<?([^)>\s]*)>?[^)]*\)/g, (_m, alt: string, url: string) => {
    found.images.push(url)
    return alt
  })
  // 6. links → their text. `el.link` jumps to a SLIDE id (validate.ts reports
  //    anything else as a broken link), so a URL has nowhere in the model to go.
  s = s.replace(/\[([^\]]*)\]\([ \t]*<?([^)>\s]*)>?[^)]*\)/g, (_m, text: string, url: string) => {
    if (url && !url.startsWith('#')) found.links.push(url)
    return text
  })
  // 7. citations stay LITERAL — rendering `[@x]` as "(Author 2020)" needs a
  //    bibliography this importer does not have, and inventing one would be
  //    worse than showing the key.
  for (const m of s.matchAll(/\[[^\]]*@[\w:.#$%&+?/-]+[^\]]*\]/g)) found.citations.push(m[0])

  // 8. emphasis. Underscore forms require a non-word boundary so
  //    `some_variable_name` survives.
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
  s = s.replace(/(?<![\w\\])__([^_\n]+?)__(?!\w)/g, '<b>$1</b>')
  s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
  s = s.replace(/(?<![*\w])\*([^*\n]+?)\*(?!\*)/g, '<i>$1</i>')
  s = s.replace(/(?<![\w\\])_([^_\n]+?)_(?!\w)/g, '<i>$1</i>')

  // 9. breaks: two trailing spaces or a trailing backslash is HARD, a bare
  //    newline is a soft wrap and reads as a space (Pandoc's own default).
  s = s.replace(/(?: {2,}|\\)\n/g, '<br>').replace(/\n/g, ' ')

  return s.replace(UNHOLD, (_m, n: string) => holds[+n])
}

/** Inline markdown → plain text (speaker notes, alt text, layout metrics). */
export function inlineToText(src: string): string {
  return inlineToHtml(src)
    .replace(/<br>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** Flatten a parsed subtree back to plain text — what `::: {.notes}` needs. */
export function blocksToText(blocks: MdBlock[]): string {
  const out: string[] = []
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading': case 'para': out.push(inlineToText(b.text)); break
      case 'list': out.push(b.items.map((it) =>
        `${'  '.repeat(it.depth)}${it.ordinal ? `${it.ordinal}.` : '•'} ${inlineToText(it.text)}`).join('\n')); break
      case 'code': out.push(b.content); break
      case 'math': out.push(`$$${b.tex}$$`); break
      case 'quote': case 'div': out.push(blocksToText(b.blocks)); break
      case 'table': out.push([b.head, ...b.rows].map((r) => r.join('\t')).join('\n')); break
      case 'image': out.push(b.alt); break
      case 'raw': out.push(b.text.replace(/<[^>]+>/g, '')); break
      default: break
    }
  }
  return out.filter((s) => s.trim()).join('\n\n')
}
