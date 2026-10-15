// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Pure helpers for reading and sanity-checking `.beeslides.html` bytes in the
// main process, which has no DOM. No electron import, so they are
// node-testable (scripts/test-desktop-docfile.ts).
//
// Everything here leans on the splice contract (docs/PLATFORM.md): the
// `#slidomingo-doc` block is a plain
// `<script type="application/slidomingo+json" id="slidomingo-doc">…</script>`
// whose JSON has `<` escaped as `<` (kernel/src/save.ts), so a regex +
// JSON.parse reads it exactly as the renderer's `textContent` would.
import { relative, resolve, isAbsolute, sep } from 'node:path'
import { resolveDocText } from '../../../kernel/src/assetstore.ts'

const DOC_BLOCK_RE = /<script[^>]*\bid=["']slidomingo-doc["'][^>]*>([\s\S]*?)<\/script>/i

/** The doc block's text exactly as the file holds it, trimmed. May hold
 *  asset-store refs; fine for reading format/title/flags, never hand it to
 *  a renderer as the document (use extractDocBlockText). */
export function rawDocBlockText(html: string): string | null {
  const m = html.match(DOC_BLOCK_RE)
  if (!m) return null
  return (m[1] ?? '').trim()
}

/** The doc block's `kind` (a figure or an icon set), or null for a deck.
 *  Text-level check, so it works on raw blocks (refs, partial reads) without
 *  parsing. */
export function docKindOfText(blockText: string): 'figure' | 'iconset' | null {
  const m = /"kind"\s*:\s*"(figure|iconset)"/.exec(blockText)
  return m ? (m[1] as 'figure' | 'iconset') : null
}

/** The document the file holds, as text a renderer can load: the doc block
 *  with every asset-store ref resolved against the file's own store
 *  (kernel/src/assetstore.ts; byte-identical for a file without refs).
 *  `''` for a pristine shell (its block ships empty — the blank deck is
 *  generated at runtime), `null` when the file has no block at all (not a
 *  BeeSlides file). */
export function extractDocBlockText(html: string): string | null {
  const text = rawDocBlockText(html)
  return text ? resolveDocText(text, html) : text
}

/** The doc block, parsed and resolved. `null` when absent, empty, or not JSON. */
export function extractDocBlock(html: string): unknown | null {
  const text = extractDocBlockText(html)
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

/** The doc block parsed WITHOUT resolving refs — for the flags and title
 *  checks below, which run on every write and every listing. */
function rawDocBlock(html: string): unknown | null {
  const text = rawDocBlockText(html)
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

/**
 * What a file holds, as far as the desktop shell needs to know:
 * - `slides` — a slidomingo/slides deck (the current shell can host it)
 * - `enc` — a password envelope; the renderer's password gate unwraps it
 * - `empty` — a pristine app shell with no document yet
 * - `other` — a BeeSlides block of another app (spaces, …) or an unknown format
 * - `none` — no doc block, or it doesn't parse: not a BeeSlides file
 */
export type DocFormat = 'slides' | 'enc' | 'empty' | 'other' | 'none'

export function detectFormat(html: string): DocFormat {
  const text = rawDocBlockText(html)
  if (text === null) return 'none'
  if (text === '') return 'empty'
  let json: unknown
  try { json = JSON.parse(text) } catch { return 'none' }
  const format = (json as { format?: unknown } | null)?.format
  if (format === 'slidomingo/slides') return 'slides'
  if (format === 'slidomingo/enc') return 'enc'
  return 'other'
}

/** A template file (`template: true`) is never bound for write-back by an
 *  ordinary open: that starts a NEW deck (model.parseDoc mints a fresh
 *  docId), and autosaving that into the template file would silently turn
 *  the template into someone's deck. Only an explicit Edit Template binds
 *  one (`openAsFor`), and then every write must still be a template. */
export function isTemplateHtml(html: string): boolean {
  const json = rawDocBlock(html) as { template?: unknown } | null
  return json?.template === true
}

/**
 * How windows.ts's resolveOpen treats a file's bytes:
 * - `deck` — a slides deck or an encrypted deck, bound for write-back
 * - `template` — a slides file opened with Edit Template: bound, in template mode
 * - `from-template` — a template opened any other way: a NEW draft based on it
 * - `blank` — a pristine empty shell: just a new deck
 * - `legacy` — another app's file or a pre-format file: loaded as-is, unbound
 */
export type OpenAs = 'deck' | 'template' | 'from-template' | 'blank' | 'legacy'

export function openAsFor(html: string, opts: { editTemplate?: boolean } = {}): OpenAs {
  const format = detectFormat(html)
  if (format === 'enc') return 'deck'
  if (format === 'slides') {
    // Edit Template binds any slides file it is pointed at as a template,
    // flag or not: the gallery treats every file in the templates folder as
    // one (a manually dropped file cannot be trusted to set it), and the
    // first save stamps it.
    if (opts.editTemplate) return 'template'
    return isTemplateHtml(html) ? 'from-template' : 'deck'
  }
  if (format === 'empty') return 'blank'
  return 'legacy'
}

/** The document's title: the JSON's own `title` when readable, else the
 *  `<title>` element minus the " — AppName" suffix save.ts appends. */
export function readTitle(html: string): string | null {
  const json = rawDocBlock(html) as { title?: unknown } | null
  if (typeof json?.title === 'string' && json.title.trim()) return json.title.trim()
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const raw = m?.[1]?.trim()
  if (!raw) return null
  return raw.replace(/\s+—\s+[^—]*$/, '').trim() || null
}

/** Whether `child` is `parent` itself or somewhere beneath it. Resolves both,
 *  so `..` segments can't escape. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

/** Smallest size a real built shell can plausibly be: the compressed runtime
 *  alone is several hundred KB. Anything much smaller is truncated or not a
 *  shell at all. */
const MIN_SHELL_BYTES = 100_000

/**
 * Last line of defence before the main process overwrites a user's file with
 * bytes a renderer handed it: is this a complete BeeSlides shell carrying a
 * readable document? Checks the doctype, the closing `</html>`, the runtime
 * payload, a plausible size, and a doc block that parses as a slides deck or
 * an encryption envelope. It does not validate the deck — the renderer did
 * that — it catches truncation, a dev page, or an empty shell.
 */
export function looksLikeShell(html: string): boolean {
  if (typeof html !== 'string' || html.length < MIN_SHELL_BYTES) return false
  if (!/^﻿?\s*<!doctype html/i.test(html)) return false
  if (!/<\/html>\s*$/i.test(html)) return false
  if (!/\bid=["']slidomingo-rt["']/.test(html)) return false
  const f = detectFormat(html)
  return f === 'slides' || f === 'enc'
}

/** Outcome of comparing what's on disk now with what this session last saw. */
export type WriteDecision = 'ok' | 'conflict' | 'missing'

/**
 * Decide whether a write-back may proceed. `knownMtime` is the mtime main
 * recorded when it last read or wrote the file (null = never seen, e.g. a
 * brand-new draft); `current` is a fresh stat (null = the file is gone).
 *
 * A file that vanished is `missing` and is never silently recreated — a user
 * who deleted or moved a deck while it was open must not find it reappear.
 * A file whose mtime moved without us is a `conflict`: someone else (another
 * app, a sync client, git) wrote it. A draft with no file yet may be created.
 */
export function decideWrite(knownMtime: number | null, current: { mtimeMs: number } | null): WriteDecision {
  if (!current) return knownMtime == null ? 'ok' : 'missing'
  if (knownMtime == null) return 'ok'
  // mtime resolution differs across filesystems; 1ms slack avoids a false
  // conflict from float rounding of our own write's stat.
  return Math.abs(current.mtimeMs - knownMtime) <= 1 ? 'ok' : 'conflict'
}

/**
 * Which session-backup copies to delete: keep the newest `keep` per file and
 * drop anything older than `maxAgeDays` regardless. `entries` are the backup
 * files of ONE document.
 */
export function backupsToPrune(
  entries: Array<{ name: string; mtimeMs: number }>,
  now: number,
  keep = 5,
  maxAgeDays = 30,
): string[] {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000
  const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)
  return sorted.filter((e, i) => i >= keep || e.mtimeMs < cutoff).map((e) => e.name)
}
