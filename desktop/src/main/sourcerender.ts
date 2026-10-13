// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// A picture of the ORIGINAL for "Fix with Claude" after a PowerPoint import:
// LibreOffice, when it is installed, renders the .pptx to a PDF that Claude
// Code reads page by page — so the agent compares "should look like this"
// with review_slide's "looks like this" instead of guessing from XML.
//
// Optional by design: no LibreOffice, a timeout or a failed convert all give
// null and the fix goes ahead without a picture (agentprompts.ts says so).
// PowerPoint itself is not scripted here — automating it raises a macOS
// permission prompt and its sandbox refuses arbitrary output folders.
//
// Electron-free, so scripts/test-desktop-sourcerender.ts can import it.

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Where LibreOffice installs `soffice` on each platform, before PATH. */
const KNOWN = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/soffice',
  '/usr/local/bin/soffice',
  '/opt/homebrew/bin/soffice',
  '/snap/bin/libreoffice',
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
]

/** The first `soffice` found, or null. `env`/`exists` are injectable. */
export function findSoffice(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  for (const p of KNOWN) if (exists(p)) return p
  const exe = process.platform === 'win32' ? 'soffice.exe' : 'soffice'
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, exe)
    if (exists(p)) return p
  }
  return null
}

/** Hidden slides too, so page N stays source slide N (LibreOffice 7.4+
 *  reads the JSON filter options; older ones ignore them and skip hidden
 *  slides). */
const PDF_FILTER = 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'

/** The argv for one headless convert. A throwaway profile dir, because a
 *  running LibreOffice holds the default one and the convert then silently
 *  does nothing. */
export function convertArgs(src: string, outDir: string, profileDir: string): string[] {
  return [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--headless', '--norestore', '--nolockcheck',
    '--convert-to', PDF_FILTER,
    '--outdir', outDir,
    src,
  ]
}

/**
 * Render `src` (a .pptx/.potx) to `<outDir>/<name>.pdf`. Resolves the PDF's
 * path, or null when LibreOffice is missing, fails or takes longer than
 * `timeoutMs`. Never rejects.
 */
export function renderToPdf(src: string, outDir: string, timeoutMs = 90_000, soffice = findSoffice()): Promise<string | null> {
  if (!soffice) return Promise.resolve(null)
  const out = join(outDir, `${basename(src, extname(src))}.pdf`)
  let profile: string
  try { profile = mkdtempSync(join(tmpdir(), 'beeslides-soffice-')) } catch { return Promise.resolve(null) }
  return new Promise((resolve) => {
    execFile(soffice, convertArgs(src, outDir, profile), { timeout: timeoutMs, windowsHide: true }, () => {
      try { rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ }
      try { resolve(statSync(out).size > 0 ? out : null) } catch { resolve(null) }
    })
  })
}
