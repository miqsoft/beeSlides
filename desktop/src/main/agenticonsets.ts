// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// An agent's `icons` call naming an icon-set FILE (`set`, DECISIONS
// 2026-10-25): main reads the file and hands its document to the editor with
// the request (`iconSet`), which builds the icons from the set's model
// (agentops.ts searchSet, iconstyles.ts setIconSvg). Only main reads files;
// the renderer never gets a path-reading channel.
//
// - Read only. The file is never written here; only a BeeSlides document of
//   kind "iconset" is accepted (docfile.ts iconSetDocText; legacy
//   `#slidomingo-doc` too, asset-store refs resolved).
// - A set that is open in a window (in this instance, the agent drew it there
//   a moment ago) is flushed to disk first, as an autosave would, so the
//   search sees what the window shows. Reading the window's live document
//   instead would mean a second way out of an editor for a whole document;
//   the file is the one path that already exists and is what the user has.
// - A relative path is resolved against the folder of the deck the request
//   goes to (the plugin's MCP server already makes outside paths absolute).

import type { BrowserWindow } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { hasDocExt } from '../../../kernel/src/docext.ts'
import { iconSetDocText } from './docfile.ts'
import { bindingFor, docWebContentsFor, flushToDisk, windowForPath } from './windows.ts'

/** Bigger than any icon set; a file this size is not one worth reading for icons. */
const MAX_SET_BYTES = 64 * 1024 * 1024

/** The `set` an `icons` request names, or undefined when it names none. */
export function iconSetArg(verb: unknown, args: unknown): string | undefined {
  if (verb !== 'icons' || !args || typeof args !== 'object') return undefined
  const set = (args as { set?: unknown }).set
  return typeof set === 'string' ? set : undefined
}

/** Reads the icon set `raw` names for a request going to `win`'s deck. */
export async function readIconSetForAgent(win: BrowserWindow, raw: string): Promise<{ file: string; text: string } | { error: string }> {
  const given = raw.trim()
  if (!given) return { error: 'set is empty: give the icon-set file (.beeslides.html).' }
  const home = given === '~' || given.startsWith('~/') ? join(homedir(), given.slice(1)) : given
  let path: string
  if (isAbsolute(home)) path = resolve(home)
  else {
    const wc = docWebContentsFor(win)
    const binding = wc ? bindingFor(wc.id) : null
    if (!binding || binding.kind !== 'file') return { error: 'This deck is not saved in a folder yet: give set as an absolute path.' }
    path = resolve(dirname(binding.path), home)
  }
  const file = basename(path)
  if (!hasDocExt(path)) return { error: `An icon set file ends in .beeslides.html; "${file}" does not.` }
  let size: number
  try { size = statSync(path).size } catch { return { error: `There is no file at ${path}.` } }
  if (size > MAX_SET_BYTES) return { error: `${file} is too big to be an icon set.` }
  // open in a window: put what it shows on disk first. A window that cannot
  // save leaves the file as it was — still a set, just older; it is read as is.
  const open = windowForPath(path)
  if (open) await flushToDisk(open)
  let html: string
  try { html = readFileSync(path, 'utf8') } catch (err) { return { error: `Could not read ${path}: ${(err as Error).message}` } }
  const got = iconSetDocText(html)
  if ('error' in got) return { error: `${file} ${got.error}.` }
  return { file, text: got.text }
}
