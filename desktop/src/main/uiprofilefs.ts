// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The desktop's store for the editor's per-install UI profile
// (slides/src/editor/customize/): `userData/ui-customization.json`, the
// current profile plus the last 30 revisions. Every write — Settings, Import,
// the Customize chat, an agent's ui_profile call, a revert, a reset — is a
// revision, so any of them can be undone from History.
//
// Electron-free (the path is passed in) so the node rigs can run it. Callers
// hand in a profile that has ALREADY passed strict validation; what is read
// back is validated again, leniently, so a hand-edited or newer file can
// never break the editor.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateProfile } from '../../../slides/src/editor/customize/validate.ts'
import type { UiIssue, UiProfile } from '../../../slides/src/editor/customize/schema.ts'

export const UI_STORE_FORMAT = 'slidomingo/ui-customization'
export const UI_HISTORY_MAX = 30

export type UiSource = 'settings' | 'import' | 'chat' | 'agent' | 'revert' | 'reset'
export const UI_SOURCES: readonly UiSource[] = ['settings', 'import', 'chat', 'agent', 'revert', 'reset']

export interface UiRevisionEntry { rev: number; at: number; source: UiSource; summary: string; profile: UiProfile | null }
export interface UiStoreFile { format: typeof UI_STORE_FORMAT; version: 1; rev: number; current: UiProfile | null; history: UiRevisionEntry[] }
export interface UiChange { profile: UiProfile | null; rev: number; source: UiSource; summary: string; prevRev: number }

const empty = (): UiStoreFile => ({ format: UI_STORE_FORMAT, version: 1, rev: 0, current: null, history: [] })
const lenient = (p: unknown): UiProfile | null => (p ? validateProfile(p, 'lenient').profile : null)
const cleanSummary = (s: unknown): string =>
  // eslint-disable-next-line no-control-regex
  typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim().slice(0, 200) : ''

/** The store; a missing or unreadable file is an empty one. */
export function readUiStore(path: string): UiStoreFile {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return empty() }
  if (!raw || typeof raw !== 'object' || (raw as UiStoreFile).format !== UI_STORE_FORMAT) return empty()
  const r = raw as Partial<UiStoreFile>
  const history = (Array.isArray(r.history) ? r.history : [])
    .filter((h): h is UiRevisionEntry => !!h && typeof h.rev === 'number' && typeof h.at === 'number')
    .map((h) => ({
      rev: h.rev, at: h.at, source: UI_SOURCES.includes(h.source) ? h.source : 'settings',
      summary: cleanSummary(h.summary), profile: lenient(h.profile),
    }))
    .slice(-UI_HISTORY_MAX)
  const rev = typeof r.rev === 'number' && r.rev >= 0 ? r.rev : Math.max(0, ...history.map((h) => h.rev))
  return { format: UI_STORE_FORMAT, version: 1, rev, current: lenient(r.current), history }
}

function writeUiStore(path: string, store: UiStoreFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  renameSync(tmp, path) // a reader never sees half a file
}

/** Records `profile` (already strictly validated, or null to clear) as the
 *  next revision. Throws only if the disk write fails. */
export function commitUiProfile(path: string, profile: UiProfile | null, source: UiSource, summary: string): UiChange {
  const store = readUiStore(path)
  const prevRev = store.rev
  const rev = Math.max(store.rev, ...store.history.map((h) => h.rev)) + 1
  const entry: UiRevisionEntry = { rev, at: Date.now(), source, summary: cleanSummary(summary), profile }
  writeUiStore(path, { ...store, rev, current: profile, history: [...store.history, entry].slice(-UI_HISTORY_MAX) })
  return { profile, rev, source, summary: entry.summary, prevRev }
}

/** The profile as it was right after revision `rev` (0 = before any change),
 *  or undefined when that revision has aged out of the history. */
export function profileAt(path: string, rev: number): UiProfile | null | undefined {
  if (rev === 0) return null
  const hit = readUiStore(path).history.find((h) => h.rev === rev)
  return hit ? hit.profile : undefined
}

/** History, newest first, without the profiles. */
export function listUiHistory(path: string): Array<Omit<UiRevisionEntry, 'profile'>> {
  return readUiStore(path).history.map(({ rev, at, source, summary }) => ({ rev, at, source, summary })).reverse()
}

// ---- the service every writer goes through (IPC, chat, agents) ---------------

export interface UiProfileService {
  /** userData/ui-customization.json */
  path: string
  /** SLIDOMINGO_NO_UI_PROFILE=1: nothing is read or written. */
  disabled: boolean
  /** Tell every editor window (uiprofile.ts); a no-op in the rigs. */
  broadcast(change: UiChange): void
}

export interface UiWriteResult { ok: boolean; rev?: number; errors?: UiIssue[]; warnings?: UiIssue[]; error?: string }

export const DISABLED = 'UI customization is switched off for this run (SLIDOMINGO_NO_UI_PROFILE=1).'

export function currentProfile(svc: UiProfileService): { profile: UiProfile | null; rev: number } {
  if (svc.disabled) return { profile: null, rev: 0 }
  const s = readUiStore(svc.path)
  return { profile: s.current, rev: s.rev }
}

function commit(svc: UiProfileService, profile: UiProfile | null, source: UiSource, summary: string): UiWriteResult {
  try {
    const change = commitUiProfile(svc.path, profile, source, summary)
    svc.broadcast(change)
    return { ok: true, rev: change.rev }
  } catch (e) {
    return { ok: false, error: `could not save: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** A whole profile (or null to clear), strictly validated, as one revision. */
export function writeProfile(svc: UiProfileService, profile: unknown, source: UiSource, summary: string): UiWriteResult {
  if (svc.disabled) return { ok: false, error: DISABLED }
  if (profile === null) return commit(svc, null, source, summary)
  const v = validateProfile(profile, 'strict')
  if (!v.profile) return { ok: false, errors: v.errors, warnings: v.warnings }
  return { ...commit(svc, v.profile, source, summary), warnings: v.warnings }
}

/** Back to the profile as it was right after revision `rev` (0 = before any). */
export function revertProfile(svc: UiProfileService, rev: number, source: UiSource = 'revert', summary?: string): UiWriteResult {
  if (svc.disabled) return { ok: false, error: DISABLED }
  if (!Number.isInteger(rev) || rev < 0) return { ok: false, error: 'rev must be a revision number' }
  const p = profileAt(svc.path, rev)
  if (p === undefined) return { ok: false, error: 'too-old' }
  return commit(svc, p, source, summary ?? `Back to #${rev}`)
}

export function resetProfile(svc: UiProfileService, source: UiSource = 'reset', summary = ''): UiWriteResult {
  if (svc.disabled) return { ok: false, error: DISABLED }
  return commit(svc, null, source, summary)
}

export function uiHistory(svc: UiProfileService) {
  return svc.disabled ? [] : listUiHistory(svc.path)
}
