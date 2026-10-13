// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Where the UI profile lives, behind one interface:
//
//   browser  — localStorage `slidomingo-ui-profile` (+ a 30-entry history),
//              other tabs follow through the `storage` event;
//   desktop  — main owns it (desktop/src/main/uiprofile.ts, a file in
//              userData with its own history): the preload seeds the same
//              localStorage key BEFORE the page boots (no flash of the default
//              chrome), writes go over the bridge, and main tells every
//              window when it changed (the viewerprefs.ts pattern).
//
// Either way, what comes OUT of here has been through the lenient validator,
// and what goes IN is validated strictly first. Never part of a document.

import { lsDel, lsGet, lsSet } from '../../../../kernel/src/storage.ts'
import { validateProfile } from './validate.ts'
import type { UiIssue, UiProfile } from './schema.ts'

export const PROFILE_KEY = 'slidomingo-ui-profile'
const HISTORY_KEY = 'slidomingo-ui-profile-history'
export const HISTORY_MAX = 30

/** Who changed the profile — shown in the history, and `chat`/`agent`
 *  changes raise the "Your editor was changed" toast. */
export type UiSource = 'settings' | 'import' | 'chat' | 'agent' | 'revert' | 'reset'

export interface UiRevision { rev: number; at: number; source: UiSource; summary: string }
export interface UiChange { profile: UiProfile | null; rev: number; source: UiSource; summary: string; prevRev: number }
export interface UiWriteResult { ok: boolean; rev?: number; errors?: UiIssue[]; warnings?: UiIssue[]; error?: string }

/** The desktop preload's side (desktop/src/preload/index.ts). */
export interface DesktopUiBridge {
  uiProfileDisabled?: boolean
  uiProfileWrite(profile: unknown, meta: { source: UiSource; summary: string }): Promise<UiWriteResult>
  uiProfileHistory(): Promise<UiRevision[]>
  uiProfileRevert(rev: number): Promise<UiWriteResult>
  uiProfileReset(): Promise<UiWriteResult>
  onUiProfileChanged(cb: (c: UiChange) => void): () => void
}

const desktopBridge = (): DesktopUiBridge | null => {
  const d = (window as unknown as { slidomingoDesktop?: Partial<DesktopUiBridge> }).slidomingoDesktop
  return d?.uiProfileWrite ? (d as DesktopUiBridge) : null
}

interface Stored { profile: unknown; rev: number; source?: UiSource; summary?: string }
interface StoredRevision extends UiRevision { profile: UiProfile | null }

function readStored(): Stored | null {
  try {
    const raw = lsGet(PROFILE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Stored
    return v && typeof v === 'object' && typeof v.rev === 'number' ? v : null
  } catch { return null }
}

const loadProfile = (s: Stored | null): UiProfile | null =>
  s?.profile ? validateProfile(s.profile, 'lenient').profile : null

export class UiProfileStore {
  private listeners = new Set<(c: UiChange) => void>()
  private bridge = desktopBridge()

  constructor() {
    if (this.bridge) {
      this.bridge.onUiProfileChanged((c) => this.emit({ ...c, profile: c.profile ? validateProfile(c.profile, 'lenient').profile : null }))
    } else {
      // another tab of this browser changed it
      window.addEventListener('storage', (ev) => {
        if (ev.key !== PROFILE_KEY) return
        let prev: Stored | null = null
        try { prev = ev.oldValue ? JSON.parse(ev.oldValue) : null } catch { /* */ }
        const s = readStored()
        this.emit({ profile: loadProfile(s), rev: s?.rev ?? 0, source: s?.source ?? 'settings', summary: s?.summary ?? '', prevRev: prev?.rev ?? 0 })
      })
    }
  }

  /** Off for this run — desktop `SLIDOMINGO_NO_UI_PROFILE=1`, or a browser
   *  page opened with `?no-ui-profile`: nothing applies and nothing can be
   *  written, so a broken customization can always be got out of. */
  disabled(): boolean {
    if (this.bridge?.uiProfileDisabled) return true
    try { return new URLSearchParams(location.search).has('no-ui-profile') } catch { return false }
  }
  /** Desktop: main keeps the store (and the AI chat lives there). */
  isDesktop(): boolean { return !!this.bridge }

  current(): { profile: UiProfile | null; rev: number } {
    if (this.disabled()) return { profile: null, rev: 0 }
    const s = readStored()
    return { profile: loadProfile(s), rev: s?.rev ?? 0 }
  }

  onChange(cb: (c: UiChange) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(c: UiChange) { for (const cb of this.listeners) cb(c) }

  /** Strictly validated write; `null` clears the profile. */
  async write(next: UiProfile | null, source: UiSource, summary: string): Promise<UiWriteResult> {
    if (this.disabled()) return { ok: false, error: 'disabled' }
    let profile: UiProfile | null = null
    let warnings: UiIssue[] = []
    if (next) {
      const v = validateProfile(next, 'strict')
      if (!v.profile) return { ok: false, errors: v.errors, warnings: v.warnings }
      profile = v.profile
      warnings = v.warnings
    }
    if (this.bridge) {
      const r = await this.bridge.uiProfileWrite(profile, { source, summary })
      return { ...r, warnings: r.warnings ?? warnings }
    }
    return { ...this.commitLocal(profile, source, summary), warnings }
  }

  private commitLocal(profile: UiProfile | null, source: UiSource, summary: string): UiWriteResult {
    const prevRev = readStored()?.rev ?? 0
    const rev = Math.max(prevRev, ...this.localHistory().map((h) => h.rev)) + 1
    const stuck = lsSet(PROFILE_KEY, JSON.stringify({ profile, rev, source, summary } satisfies Stored))
    if (!stuck) return { ok: false, error: 'storage' }
    const history = [...this.localHistory(), { rev, at: Date.now(), source, summary, profile }].slice(-HISTORY_MAX)
    lsSet(HISTORY_KEY, JSON.stringify(history))
    this.emit({ profile, rev, source, summary, prevRev })
    return { ok: true, rev }
  }

  private localHistory(): StoredRevision[] {
    try {
      const v = JSON.parse(lsGet(HISTORY_KEY) ?? '[]')
      return Array.isArray(v) ? v.filter((h) => h && typeof h.rev === 'number') : []
    } catch { return [] }
  }

  /** Newest first. */
  async history(): Promise<UiRevision[]> {
    if (this.disabled()) return []
    if (this.bridge) return this.bridge.uiProfileHistory()
    return this.localHistory().map(({ rev, at, source, summary }) => ({ rev, at, source, summary })).reverse()
  }

  /** Back to how the profile was right after revision `rev` (0 = before any). */
  async revert(rev: number): Promise<UiWriteResult> {
    if (this.disabled()) return { ok: false, error: 'disabled' }
    if (this.bridge) return this.bridge.uiProfileRevert(rev)
    const target = rev === 0 ? { profile: null } : this.localHistory().find((h) => h.rev === rev)
    if (!target) return { ok: false, error: 'too-old' }
    const profile = target.profile ? validateProfile(target.profile, 'lenient').profile : null
    return this.commitLocal(profile, 'revert', `#${rev}`)
  }

  async reset(): Promise<UiWriteResult> {
    if (this.disabled()) return { ok: false, error: 'disabled' }
    if (this.bridge) return this.bridge.uiProfileReset()
    return this.commitLocal(null, 'reset', '')
  }

  /** Browser only: forget everything, history included (tests, "start over"). */
  clearLocal(): void { lsDel(PROFILE_KEY); lsDel(HISTORY_KEY) }
}
