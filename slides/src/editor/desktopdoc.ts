// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// slidomingo/desktop ONLY: this window's binding to a file on disk, and the
// writes that keep it saved. "Every deck is always saved" (docs/DECISIONS.md,
// 2026-09-24): the desktop shell boots every window in the CURRENT app shell
// and hands the deck over IPC, so there is no File System Access handle —
// main writes the file (desktop/src/main/documents.ts), to the path this
// window is bound to: a real file, or a draft under userData/Drafts.
//
// Deliberately NOT a kernel writer hook: the kernel's FSA path (save.ts) stays
// exactly what the web runs; this is a desktop branch in the editor, and
// exports (present-only, template, copies to elsewhere via the browser) keep
// using that FSA path.
//
// State lives at module scope — one binding per window — so main.ts can
// register the flush handler before the editor (or the start page, or the
// password gate) exists, and the save indicators in the main bar and the
// Layout Manager bar read ONE status and cannot disagree.

import type { DesktopFlushStatus, DesktopLaunchDocument, DesktopWriteResult } from './ribbon'

/** What the save indicator shows on desktop. */
export type DesktopDocStatus = 'saved' | 'saving' | 'draft' | 'error' | 'conflict' | 'missing'

interface Binding {
  kind: 'file' | 'draft'
  /** `template` = a template window (the file is a template, Edit Template) */
  role: 'deck' | 'template'
  path: string
  /** file name for a real file, null for a draft */
  name: string | null
}

let binding: Binding | null = null
let launch: DesktopLaunchDocument | null = null
let status: DesktopDocStatus = 'saved'
let lastError: string | null = null
let writesDisabled: string | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const cb of listeners) { try { cb() } catch { /* a listener's bug is not ours */ } }
}

function setStatus(next: DesktopDocStatus, error: string | null = null) {
  if (status === next && lastError === error) return
  status = next
  lastError = error
  emit()
}

/**
 * Ask main which deck this window is bound to. Call once at boot, before
 * reading the embedded block. Null = not bound (a web tab, or a legacy file
 * the desktop loaded directly) — the caller falls back to readEmbeddedDoc().
 */
export async function initDesktopDoc(): Promise<DesktopLaunchDocument | null> {
  const api = window.slidomingoDesktop
  if (!api?.readLaunchDocument) return null
  try { launch = await api.readLaunchDocument() } catch { launch = null }
  if (!launch) return null
  binding = { kind: launch.kind, role: launch.role ?? 'deck', path: launch.path, name: launch.name }
  status = launch.kind === 'draft' ? 'draft' : 'saved'
  // main renamed the bound file (a template rename, templates.ts): follow it
  api.onBindingMoved?.(({ path, name }) => {
    if (!binding) return
    binding = { ...binding, path, name }
    emit()
  })
  return launch
}

/** True once this window writes through main instead of the FSA path. */
export const desktopBound = (): boolean => binding !== null
export const desktopKind = (): 'file' | 'draft' | null => binding?.kind ?? null
/** The bound file's name ("Q3.beeslides.html"), null for a draft. */
export const desktopFileName = (): string | null => binding?.name ?? null
export const desktopFilePath = (): string | null => (binding?.kind === 'file' ? binding.path : null)

/** This window is a hidden instance's, worked on by an agent (desktop
 *  background.ts): nobody sees it. */
export const desktopBackground = (): boolean => launch?.background === true
/** A template window: this window is bound to a template file (Edit
 *  Template) and every write must stay a template (editor.ts templateMode). */
export const desktopIsTemplate = (): boolean => binding?.role === 'template'
/** The boot-time launch info (kind, and whether a draft existed on disk). */
export const desktopLaunch = (): DesktopLaunchDocument | null => launch
export const desktopStatus = (): DesktopDocStatus => status
export const desktopError = (): string | null => lastError

export function onDesktopStatus(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Refuse every disk write for this session (dev mode without a built shell:
 *  splicing Vite's index.html into a deck would brick it). */
export function disableDesktopWrites(reason: string): void {
  writesDisabled = reason
  setStatus('error', reason)
}
export const desktopWritesDisabled = (): string | null => writesDisabled

let chain: Promise<unknown> = Promise.resolve()

/**
 * Serialize (lazily, when this write's turn comes) and write the file. Writes
 * are chained one after another, so two autosaves never interleave and the
 * last one to start is the last one on disk.
 */
export function writeDesktop(serialize: () => Promise<string>, opts?: { force?: boolean }): Promise<DesktopWriteResult> {
  const run = async (): Promise<DesktopWriteResult> => {
    const api = window.slidomingoDesktop
    if (!binding || !api?.writeDocument) return { error: 'unbound' }
    if (writesDisabled) return { error: writesDisabled }
    setStatus('saving')
    let result: DesktopWriteResult
    try {
      result = await api.writeDocument(await serialize(), opts)
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) }
    }
    if ('ok' in result) setStatus(binding.kind === 'draft' ? 'draft' : 'saved')
    else if ('conflict' in result) setStatus('conflict')
    else if ('missing' in result) setStatus('missing')
    else setStatus('error', result.error)
    return result
  }
  const p = chain.then(run, run)
  chain = p.catch(() => undefined)
  return p
}

/** Resolves once every queued write has finished. */
export function desktopWritesSettled(): Promise<void> {
  return chain.then(() => undefined, () => undefined)
}

/**
 * Save As through main's native dialog. `move` rebinds this window to the new
 * file (a draft becomes a real deck); `copy` writes elsewhere and stays put.
 */
export async function saveDesktopAs(
  html: string, suggestedName: string, mode: 'move' | 'copy', strings?: Record<string, string>,
): Promise<{ ok: true; path: string; name: string } | { cancelled: true } | { error: string }> {
  const api = window.slidomingoDesktop
  if (!api?.saveDocumentAs) return { error: 'unsupported' }
  if (writesDisabled) return { error: writesDisabled }
  let result: Awaited<ReturnType<typeof saveDesktopAs>>
  try { result = await api.saveDocumentAs({ html, suggestedName, mode, strings }) } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) }
  }
  if ('ok' in result && mode === 'move') {
    binding = { kind: 'file', role: binding?.role ?? 'deck', path: result.path, name: result.name }
    setStatus('saved')
  }
  return result
}

/** The conflict was resolved (reload / keep mine): back to a normal state. */
export function clearDesktopProblem(): void {
  if (status === 'conflict' || status === 'missing' || status === 'error') setStatus(binding?.kind === 'draft' ? 'draft' : 'saved')
}

export interface FlushAnswer {
  status: DesktopFlushStatus
  strings?: Record<string, string>
}
type FlushHandler = (kind: 'flush' | 'save-as') => Promise<FlushAnswer>

// Until the editor exists (start page, password gate) there is nothing to lose.
let flushHandler: FlushHandler = async () => ({ status: 'clean' })

/** The editor installs its real handler once it has a document. */
export function setFlushHandler(fn: FlushHandler): void {
  flushHandler = fn
}

let flushWired = false

/** Answer main's close/quit flush requests (windows.ts). Call once at boot,
 *  BEFORE anything that can take a while (start page, password gate). */
export function wireDesktopFlush(): void {
  const api = window.slidomingoDesktop
  if (flushWired || !api?.onFlushRequest) return
  flushWired = true
  api.onFlushRequest(({ requestId, kind }) => {
    api.flushAck?.(requestId)
    void flushHandler(kind)
      .catch((): FlushAnswer => ({ status: 'failed' }))
      .then((answer) => api.flushResult?.({ requestId, ...answer }))
  })
}

/** Dirty flag + title for the native window (setDocumentEdited, the title
 *  shown in the Window menu / Mission Control). */
export function reportDocState(state: { dirty: boolean; title?: string; untouched?: boolean; docId?: string }): void {
  try { window.slidomingoDesktop?.reportDocState?.(state) } catch { /* best effort */ }
}

/** A problem main reported outside a write (the file watcher). */
export function markDesktopProblem(kind: 'conflict' | 'missing'): void {
  setStatus(kind)
}

/** The status source for editor/saveindicator.ts — undefined off desktop, so
 *  a web tab keeps its classic dirty-dot indicator. */
export function desktopStatusSource(): { status(): DesktopDocStatus; error(): string | null; on(cb: () => void): () => void } | undefined {
  if (!binding) return undefined
  return { status: desktopStatus, error: desktopError, on: onDesktopStatus }
}
