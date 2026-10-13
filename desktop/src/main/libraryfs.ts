// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The global element library's file operations, parameterised by path so they
// run without electron (scripts/test-desktop-library.ts). library.ts binds
// them to the real location and registers the IPC.
//
// A library file is an ORDINARY slidomingo/slides document: each slide is one
// item (docs/DECISIONS.md, "Scope split: Layout Manager = this file; Library =
// global registry in the editor"). Nothing here adds a format. The default
// library starts with one EMPTY slide because a document needs at least one
// (model.ts `parseDoc`); the editor hides empty slides, so to the user it is
// just an empty library.
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { detectFormat, looksLikeShell } from './docfile.ts'
import { writeFileAtomic } from './fsutil.ts'

const DOC_BLOCK_RE = /(<script[^>]*\bid=["']slidomingo-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i

/** The new-deck defaults of model.ts's `newDoc()`, restated: main cannot
 *  import the renderer's model (same reason as templatefs.ts). */
export function seedLibraryDoc(): Record<string, unknown> {
  return {
    format: 'slidomingo/slides',
    version: 1,
    docId: randomUUID(),
    title: 'BeeSlides Library',
    size: { width: 1280, height: 720 },
    theme: {
      background: '#FFFFFF',
      color: '#1D1119',
      accent: '#9A5F00',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    },
    slides: [{ id: 'slide-library-empty', background: '#FFFFFF', transition: 'fade', elements: [], notes: '' }],
    modified: new Date().toISOString(),
  }
}

/** `shell` with its `#slidomingo-doc` block replaced by `doc`, `<`-escaped as
 *  the splice contract requires (docs/PLATFORM.md §2). `null` when the shell
 *  has no doc block. */
export function spliceDocBlock(shell: string, doc: unknown): string | null {
  if (!DOC_BLOCK_RE.test(shell)) return null
  const json = JSON.stringify(doc).replace(/</g, '\\u003c')
  // A replacer function, so a `$` in the JSON is never read as a pattern.
  return shell.replace(DOC_BLOCK_RE, (_m, open: string, _body: string, close: string) => `${open}\n${json}\n${close}`)
}

/** Creates an empty library at `path` from the app `shell`, unless a file is
 *  already there. Never overwrites. `true` when the file exists afterwards. */
export function ensureLibraryAt(path: string, shell: string | null): boolean {
  if (existsSync(path)) return true
  if (!shell) return false
  const html = spliceDocBlock(shell, seedLibraryDoc())
  if (!html) return false
  writeFileAtomic(path, html)
  return true
}

export type LibraryRead =
  | { ok: true; path: string; name: string; html: string }
  | { ok: false; path: string; name: string; reason: 'missing' | 'unreadable' | 'not-a-library' }

/** Reads the library file's full HTML (the renderer splices its doc back into
 *  it on write, so it needs the whole shell, not just the doc block). */
export function readLibraryAt(path: string): LibraryRead {
  const name = basename(path)
  if (!existsSync(path)) return { ok: false, path, name, reason: 'missing' }
  let html: string
  try { html = readFileSync(path, 'utf8') } catch { return { ok: false, path, name, reason: 'unreadable' } }
  if (detectFormat(html) !== 'slides') return { ok: false, path, name, reason: 'not-a-library' }
  return { ok: true, path, name, html }
}

/** Overwrites the library at `path` (atomic). Refused unless the file is
 *  still there and `html` is a complete shell carrying a plain slides deck —
 *  never an encrypted or truncated one. */
export function writeLibraryAt(path: string, html: unknown): boolean {
  if (typeof html !== 'string' || !existsSync(path)) return false
  if (!looksLikeShell(html) || detectFormat(html) !== 'slides') return false
  writeFileAtomic(path, html)
  return true
}

/** Whether a file the user picked can serve as a library: a plain slides
 *  deck (not encrypted, not another app's file). */
export function isLibraryCandidate(path: string): boolean {
  try { return detectFormat(readFileSync(path, 'utf8')) === 'slides' } catch { return false }
}
