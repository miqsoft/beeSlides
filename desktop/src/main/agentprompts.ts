// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The prompts the editor may type into a Claude session (slidomingo:agent-
// prompt). Electron-free so scripts/test-desktop-agentprompts.ts can import it.
//
// They can also become a fresh session's `initialTask`, which pty.ts wraps in
// single quotes WITHOUT escaping — so the result must stay free of ' $ ` and \ .
// `fix-comments` is the one prompt built from document text (the comments the
// user chose to send): every field is sanitized here, so a deck can only put
// plain, bounded lines into it — never control/escape bytes or shell quoting.

export const AGENT_PROMPTS: Record<string, string> = {
  polish: 'Review the current slide with review_slide and polish its layout; keep content unchanged.',
}

/** How the session should work through a batch: alone, or one subagent per
 *  slide. Claude decides from the list it just got. */
const FIX_COMMENTS_HOW =
  'How to work: details (anchors, the elementIds an area covers, replies) come from comments {forAgent:true, resolved:false}. ' +
  'If there are only a few (about 4 or fewer) or they sit on one or two slides, fix them yourself, slide by slide. ' +
  'If they spread over several slides and do not depend on each other, start one subagent per slide (or small group of slides) and run them in parallel: ' +
  'give each its slide ids, its comment ids and texts and these instructions, and tell it to change nothing outside its slides. ' +
  'Deck-wide changes (theme, slide types, a style that must match across slides) you do yourself first, before any subagent starts. ' +
  'When a fix removes content, rebalance what is left (elements arrange within space) unless the space is wanted. ' +
  'Verify every fix with review_slide, then close it with resolve_comment and a one-line reply: the user checks each one afterwards.'

/** At most this many comments are written out; the rest are named by count. */
export const MAX_LISTED_COMMENTS = 40

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

/** One line of plain text: no control bytes (ESC would end a bracketed
 *  paste), no shell-quoting characters, bounded length. */
export function cleanLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const s = v
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/['`]/g, '’')
    .replace(/\\/g, '/')
    .replace(/\$/g, '＄')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

/** The `fix-comments` message: a readable numbered list of what was sent,
 *  then how to work through it. `null` when nothing valid was given. */
export function fixCommentsPrompt(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null
  const items: string[] = []
  let total = 0
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const { id, slide, on, text, feedback } = c as Record<string, unknown>
    if (typeof id !== 'string' || !ID_RE.test(id)) continue
    if (typeof slide !== 'number' || !Number.isInteger(slide) || slide < 1 || slide > 100000) continue
    const body = cleanLine(text, 300)
    if (!body) continue
    total++
    if (items.length >= MAX_LISTED_COMMENTS) continue
    const where = cleanLine(on, 40)
    const anchor = where === 'area' ? ' · area' : where === 'point' ? ' · point' : where ? ` · on “${where}”` : ''
    let line = `${items.length + 1}. Slide ${slide}${anchor}: ${body}  [${id}]`
    const fb = cleanLine(feedback, 200)
    if (fb) line += `\n   Feedback on your last attempt: ${fb}`
    items.push(line)
  }
  if (!total) return null
  const head = total === 1 ? 'Please fix this review comment:' : `Please fix these ${total} review comments:`
  const more = total > items.length ? `\n…and ${total - items.length} more (same query).` : ''
  return `${head}\n\n${items.join('\n')}${more}\n\n${FIX_COMMENTS_HOW}`
}

/** Text for a Claude Code pty: a multi-line message goes in as ONE bracketed
 *  paste so its newlines do not submit it line by line; the caller sends the
 *  Enter separately. */
export function asPaste(text: string): string {
  return text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text
}

// --- "Fix with Claude" after a PowerPoint import -----------------------------

/** What main put beside the session for an import fix: `dir` is the
 *  contextDir's name (relative to the session cwd), `source` whether
 *  import/source.pptx is there, `pdf` whether import/source.pdf is. */
export interface ImportFixFiles { dir: string; source: boolean; pdf: boolean }

/** At most this many import items are written out; the rest are counted. */
export const MAX_LISTED_IMPORT_ITEMS = 60

const CODE_RE = /^[a-z0-9-]{1,60}$/

const FIX_IMPORT_HOW =
  'How to work: keep it a faithful copy of the original, not a redesign. Change only what the items name; leave every other element, the theme, the slide types and the slide order as they are, and add no animation, transition or decoration the original does not have. ' +
  'Prefer native, editable elements (text, shapes, tables, charts) over pictures. A placeholder box marks content the converter could not read: rebuild that content from the source, then delete the box. ' +
  'An item you cannot fix faithfully (the source lacks the data, or the format has no way to show it): leave it and say why. ' +
  'If the items spread over several slides and do not depend on each other, start one subagent per slide (or small group of slides) and run them in parallel: give each its slide ids, its items and these instructions, and tell it to change nothing outside its slides. ' +
  'Check every slide you changed with review_slide, and against its page of the original when there is one. End with a short list: what you fixed, and what you left as it is and why.'

/** The `fix-import` message: the import's REPAIRABLE items (slides/src/
 *  importrepair.ts repairItems) as a numbered list, where the original is,
 *  then how to work. `null` when nothing valid was given. Every field is
 *  document or file-name text, so each is cleaned like a comment. */
export function fixImportPrompt(raw: unknown, files: ImportFixFiles): string | null {
  if (!raw || typeof raw !== 'object') return null
  const { name, items } = raw as Record<string, unknown>
  if (!Array.isArray(items)) return null
  const lines: string[] = []
  let total = 0
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const { slide, slideId, code, shape, elementId, detail, count } = it as Record<string, unknown>
    if (typeof slide !== 'number' || !Number.isInteger(slide) || slide < 1 || slide > 100000) continue
    if (typeof slideId !== 'string' || !ID_RE.test(slideId)) continue
    if (typeof code !== 'string' || !CODE_RE.test(code)) continue
    const body = cleanLine(detail, 240)
    if (!body) continue
    total++
    if (lines.length >= MAX_LISTED_IMPORT_ITEMS) continue
    const el = typeof elementId === 'string' && ID_RE.test(elementId) ? ` · element ${elementId}` : ''
    const sp = cleanLine(shape, 60)
    const where = el || (sp ? ` · ${sp.replace(/"([^"]*)"/g, '“$1”')}` : '')
    const times = typeof count === 'number' && Number.isInteger(count) && count > 1 && count <= 10000 ? ` (×${count})` : ''
    lines.push(`${lines.length + 1}. Slide ${slide}${where}: ${body}${times}  [${code}, slide id ${slideId}]`)
  }
  if (!total) return null
  const file = cleanLine(name, 80)
  const head = `Please finish this PowerPoint import${file ? ` (${file})` : ''}. The converter carried the deck over; ` +
    (total === 1 ? 'this item needs judgement:' : `these ${total} items need judgement:`)
  const more = total > lines.length ? `\n…and ${total - lines.length} more of the same kinds.` : ''
  const dir = `./${files.dir}/import`
  const source = files.source
    ? `The original: ${dir}/source.pptx (a zip: unzip -o it into ${dir}/source, then find the part of slide sN as the Nth entry of p:sldIdLst in ppt/presentation.xml (resolved through ppt/_rels/presentation.xml.rels) and read it, its _rels file, ppt/charts/, ppt/diagrams/ (SmartArt: drawingN.xml holds the laid-out shapes) and ppt/embeddings/).`
    : 'The original file is not available here; work from the item details and the slides as they are.'
  const look = files.source
    ? files.pdf
      ? ` How it looks in PowerPoint: ${dir}/source.pdf, page N = the slide with id sN.`
      : ' There is no picture of the original, so judge its look from the XML.'
    : ''
  return `${head}\n\n${lines.join('\n')}${more}\n\n${source}${look}\n\n${FIX_IMPORT_HOW}`
}
