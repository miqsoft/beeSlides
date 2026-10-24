// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// open_deck / close_deck: an outside AI app names the deck file it works on
// (DECISIONS 2026-10-24). Main answers both itself, before any deck is
// involved (agentbridge.ts registerWindowlessVerb), so they work in a hidden
// instance that has no window yet (background.ts) as well as in the visible
// app, where open_deck opens an ordinary window.
//
// open_deck binds the calling client to the deck's window: its later calls
// go there, whatever the user focuses (agentendpoint.ts serveClient).
// create:true writes a new deck first — the built editor shell with a minimal
// document spliced in, exactly as a library file is made (libraryfs.ts).

import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { hasDocExt, stripDocExt } from '../../../kernel/src/docext.ts'
import { registerWindowlessVerb, type DeckBinding } from './agentbridge.ts'
import { isBackground } from './background.ts'
import { looksLikeShell, openAsFor } from './docfile.ts'
import { spliceDocBlock } from './libraryfs.ts'
import { createDocumentWindow, readAppShell, requestWindowClose, whenDeckReady, windowForPath } from './windows.ts'

const fail = (error: string): Record<string, unknown> => ({ ok: false, error })

/** The new-deck defaults of model.ts's `newDoc()`, restated (main cannot
 *  import the renderer's model; libraryfs.ts seedLibraryDoc does the same):
 *  a fresh docId, the default theme, 16:9, one empty slide. */
export function newDeckDoc(title: string): Record<string, unknown> {
  return {
    format: 'beeslides/slides',
    version: 1,
    docId: randomUUID(),
    title: title || 'Untitled',
    size: { width: 1280, height: 720 },
    theme: {
      background: '#FFFFFF',
      color: '#1D1119',
      accent: '#9A5F00',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    },
    slides: [{ id: `slide-${randomUUID().slice(0, 8)}`, background: '#FFFFFF', transition: 'fade', elements: [], notes: '' }],
    modified: new Date().toISOString(),
  }
}

/** Windows open_deck opened, by the client that asked: in the visible app a
 *  client may close only those (the user's own windows are theirs). */
const openedBy = new Map<number, string>()

async function openDeck(sessionId: string, args: unknown, deck: DeckBinding): Promise<Record<string, unknown>> {
  const a = (args && typeof args === 'object' ? args : {}) as { path?: unknown; create?: unknown }
  if (typeof a.path !== 'string' || !a.path.trim()) return fail('path is required: the deck file, ending in .beeslides.html.')
  if (!isAbsolute(a.path)) return fail('path must be absolute.')
  const path = resolve(a.path)
  if (!hasDocExt(path)) return fail(`A BeeSlides deck file ends in .beeslides.html; "${basename(path)}" does not.`)
  let created = false
  if (!existsSync(path)) {
    if (a.create !== true) return fail(`There is no file at ${path}. Pass create:true to make a new deck there.`)
    if (!existsSync(dirname(path)) || !statSync(dirname(path)).isDirectory()) return fail(`The folder ${dirname(path)} does not exist.`)
    const shell = readAppShell()
    const html = shell ? spliceDocBlock(shell, newDeckDoc(stripDocExt(basename(path)))) : null
    if (!html) return fail('This BeeSlides build has no editor shell to make a deck from.')
    // 'wx': never over a file that appeared meanwhile
    try { writeFileSync(path, html, { encoding: 'utf8', flag: 'wx' }) } catch (err) {
      return fail(`Could not create ${path}: ${(err as Error).message}`)
    }
    created = true
  } else {
    let html: string
    try { html = readFileSync(path, 'utf8') } catch (err) { return fail(`Could not read ${path}: ${(err as Error).message}`) }
    if (!looksLikeShell(html) || openAsFor(html) !== 'deck') {
      return fail(`${basename(path)} is not a BeeSlides deck (or it is a layout file, which opens as a new deck in the app).`)
    }
  }
  const already = windowForPath(path)
  let win: BrowserWindow
  try { win = already ?? createDocumentWindow(path) } catch (err) { return fail(`Could not open ${path}: ${(err as Error).message}`) }
  if (!already) {
    openedBy.set(win.id, sessionId)
    const id = win.id
    win.once('closed', () => openedBy.delete(id))
  }
  if (!(await whenDeckReady(win))) return fail(`${basename(path)} did not finish opening.`)
  deck.bind(win)
  return {
    ok: true,
    file: basename(path),
    created,
    background: isBackground(),
    summary: `${created ? 'Created and opened' : already ? 'Working on the already open' : 'Opened'} ${basename(path)}${isBackground() ? ' (in the background: no window; every change is saved to the file)' : ''}. Every tool call from here on works on it. Start with doc_info.`,
  }
}

async function closeDeck(sessionId: string, args: unknown, deck: DeckBinding): Promise<Record<string, unknown>> {
  const a = (args && typeof args === 'object' ? args : {}) as { path?: unknown }
  let win: BrowserWindow | null
  if (typeof a.path === 'string' && a.path.trim()) {
    if (!isAbsolute(a.path)) return fail('path must be absolute.')
    win = windowForPath(resolve(a.path))
    if (!win) return fail(`${basename(a.path)} is not open.`)
  } else {
    win = deck.bound && !deck.bound.isDestroyed() ? deck.bound : null
    if (!win) return fail('No deck to close: give path, or open one with open_deck first.')
  }
  if (!isBackground() && openedBy.get(win.id) !== sessionId) {
    return fail('The user opened this deck in BeeSlides; leave closing it to them.')
  }
  const name = win.getTitle()
  if (!(await requestWindowClose(win))) return fail('The deck could not be saved, so it stays open. Try again, or tell the user.')
  return { ok: true, summary: `Saved and closed${name ? ` "${name}"` : ''}.` }
}

export function registerDeckVerbs(): void {
  registerWindowlessVerb('open_deck', openDeck)
  registerWindowlessVerb('close_deck', closeDeck)
}
