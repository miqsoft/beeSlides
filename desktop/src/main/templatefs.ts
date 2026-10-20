// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The template folder's file operations, parameterised by the folder so they
// run without electron (scripts/test-templates.ts). templates.ts binds them
// to the real templates folder (templates.ts templatesDir) and registers the IPC.
//
// A template is slide types + theme + assets (docs/DECISIONS.md 2026-09-24).
// The renderer never gets the whole folder's JSON any more: it lists
// metadata (`listTemplateMetaIn`), then loads ONE template's doc block on
// demand (`loadTemplateIn`) — the one real template in use is a 24MB PPTX
// import, and shipping it over IPC on every picker open was the old cost.
import { DOC_EXT, DOC_EXT_RE } from '../../../kernel/src/docext.ts'
import { currentFormat } from '../../../kernel/src/legacynames.ts'
import { readFileSync, readdirSync, statSync, existsSync, renameSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { extractDocBlockText, isInside, isTemplateHtml, looksLikeShell, rawDocBlockText } from './docfile.ts'
import { writeFileAtomic } from './fsutil.ts'

const TEMPLATE_RE = DOC_EXT_RE

export interface TemplateMeta {
  path: string
  /** `null` for a legacy template that has not been updated since ids
   *  existed — decks created from it resolve it by `name`. */
  templateId: string | null
  /** From the FILENAME ("Acme Corporate"), never the doc title. */
  name: string
  slideCount: number
  layoutCount: number
  /** Whether the stored slides are sample slides (`templateSamples !== false`). */
  samples: boolean
  mtime: number
}

/** Same rule as model.ts's `templateNameFromPath` (restated: main cannot
 *  import the renderer's model). */
export function templateNameFromPath(path: string): string {
  const base = basename(path)
  return base.replace(TEMPLATE_RE, '').replace(/\.html$/i, '') || base
}

/** Filename-safe base, same substitution saveTemplateFile always used. */
export function sanitizeBaseName(name: string): string {
  return (name || '').replace(/[\\/:*?"<>|]/g, '_').replace(DOC_EXT_RE, '').trim()
}

/** A path main may touch on the renderer's behalf: a `*.beeslides.html`
 *  directly inside `dir` (no subfolders, no `..` escapes). */
export function isTemplatePath(dir: string, path: unknown): path is string {
  if (typeof path !== 'string' || !TEMPLATE_RE.test(path)) return false
  return isInside(path, dir) && resolve(dirname(path)) === resolve(dir)
}

// Parsed metadata per file, reused while (mtime, size) is unchanged — so the
// 24MB template is read and parsed once per change, not per picker open.
const metaCache = new Map<string, { mtime: number; size: number; meta: TemplateMeta | null }>()

/** Metadata of one template file, or `null` when it is not a readable
 *  slides document. Uses the cache. */
export function readTemplateMeta(path: string): TemplateMeta | null {
  let st: { mtimeMs: number; size: number }
  try { st = statSync(path) } catch { metaCache.delete(path); return null }
  const hit = metaCache.get(path)
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.meta
  let meta: TemplateMeta | null = null
  try {
    // counts and flags only: no need to resolve the asset store
    const text = rawDocBlockText(readFileSync(path, 'utf8'))
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : null
    if (json && currentFormat(json.format) === 'beeslides/slides' && Array.isArray(json.slides) && json.slides.length) {
      meta = {
        path,
        templateId: typeof json.templateId === 'string' && json.templateId ? json.templateId : null,
        name: templateNameFromPath(path),
        slideCount: json.slides.length,
        // what the template offers as slide types: a master is not one
        layoutCount: Array.isArray(json.layouts) ? json.layouts.filter((l: { parentOnly?: unknown }) => !l?.parentOnly).length : 0,
        samples: json.templateSamples !== false,
        mtime: st.mtimeMs,
      }
    }
  } catch {
    meta = null // unreadable/corrupt: skipped, never breaks the list
  }
  metaCache.set(path, { mtime: st.mtimeMs, size: st.size, meta })
  return meta
}

/** Every readable template in `dir`, sorted by name. */
export function listTemplateMetaIn(dir: string): TemplateMeta[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const paths = names.filter((n) => TEMPLATE_RE.test(n) && !n.startsWith('.')).map((n) => join(dir, n))
  const live = new Set(paths)
  for (const p of metaCache.keys()) if (dirname(p) === dir && !live.has(p)) metaCache.delete(p)
  const out: TemplateMeta[] = []
  for (const p of paths) {
    const m = readTemplateMeta(p)
    if (m) out.push(m)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** One template's raw doc-block JSON text (what model.ts's
 *  `instantiateTemplate` takes). `null` outside `dir`, missing, or empty. */
export function loadTemplateIn(dir: string, path: unknown): string | null {
  if (!isTemplatePath(dir, path)) return null
  try {
    return extractDocBlockText(readFileSync(path, 'utf8')) || null
  } catch {
    return null
  }
}

/** Replaces an EXISTING template's file with `html` (atomic). Refused unless
 *  the path is a template in `dir` and `html` is a complete shell whose doc
 *  is still a template — so a truncated write, a dev page, or a plain deck
 *  can never land over a template. */
export function updateTemplateIn(dir: string, path: unknown, html: unknown): boolean {
  if (!isTemplatePath(dir, path) || typeof html !== 'string') return false
  if (!existsSync(path)) return false
  if (!looksLikeShell(html) || !isTemplateHtml(html)) return false
  writeFileAtomic(path, html)
  metaCache.delete(path)
  return true
}

/** Renames a template file to `<newBase>.beeslides.html` in the same
 *  folder. Never overwrites another file (a case-only rename of the same
 *  file is allowed). Returns the new path, or `null` when refused. */
export function renameTemplateIn(dir: string, path: unknown, newBase: unknown): string | null {
  if (!isTemplatePath(dir, path) || typeof newBase !== 'string') return null
  const base = sanitizeBaseName(newBase)
  if (!base || base.startsWith('.')) return null
  if (!existsSync(path)) return null
  const next = join(dir, `${base}${DOC_EXT}`)
  if (next === path) return path
  // On a case-insensitive disk `next` "exists" when it is only a case change
  // of `path` itself — allowed iff it is literally the same inode.
  if (existsSync(next)) {
    const sameFile = next.toLowerCase() === path.toLowerCase() && statSync(next).ino === statSync(path).ino
    if (!sameFile) return null
  }
  renameSync(path, next)
  metaCache.delete(path)
  metaCache.delete(next)
  return next
}

/** The stored default template, resolved against the current folder: by
 *  `templateId` first (a rename keeps it), then by path (a legacy template
 *  without an id). `null` when it is gone. */
export function resolveDefaultTemplate(
  metas: TemplateMeta[],
  stored: { templateId: string | null; path: string } | undefined,
): TemplateMeta | null {
  if (!stored) return null
  const byId = stored.templateId ? metas.find((m) => m.templateId === stored.templateId) : undefined
  return byId ?? metas.find((m) => resolve(m.path) === resolve(stored.path)) ?? null
}
