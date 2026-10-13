// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// The kernel document envelope — the ONLY doc fields kernel modules may read.
// Every app's document model (slidomingo/slides, slidomingo/spaces, …) satisfies this
// structurally; the kernel never sees an app's content shape (slides, blocks,
// cells). Keep this interface minimal on purpose: adding a field here is a
// platform decision (docs/PLATFORM.md §9), not a convenience.

/** The envelope every BeeSlides document carries (see docs/PLATFORM.md §3). */
export interface KernelDoc {
  /** Stable uuid minted at creation/load — never regenerated. */
  docId: string
  /** Document title (shown in window titles, save filenames). */
  title: string
  /**
   * Format features a reader MUST understand to write this document back
   * (docs/PLATFORM.md §3, the reader gate). Absent on every file written
   * before the gate existed, and on any file that needs nothing new. A
   * reader that finds a name it does not know opens the document read-only
   * and never saves it: silently dropping what it doesn't understand is how
   * an older app would otherwise destroy a newer file.
   */
  requires?: string[]
}

// --- the reader gate ---------------------------------------------------------
//
// `format` + `version` never protected anything: parseDoc only ever checked
// `format`, and nothing read `version`, so an older app happily opened a newer
// file and re-saved it without whatever it did not understand. `requires` is
// the fix, and it is deliberately a list of NAMES rather than a number — a
// reader can know some features and not others (a feature can be backported),
// and a writer declares only what this particular file actually uses, so a
// newer app's file that uses nothing new still opens everywhere.

/** Features the kernel itself implements (the save/load machinery):
 *  `asset-store` — embedded bytes stored once, referenced from the JSON
 *  (kernel/src/assetstore.ts). */
const KERNEL_FEATURES: readonly string[] = ['asset-store']

let appFeatures = new Set<string>()

/** Declare the features this APP understands. Call once, at boot, before the
 *  first save. Until it is called only the kernel's own features count, so a
 *  forgotten registration refuses too much, never too little. */
export function registerKnownFeatures(features: Iterable<string>): void {
  appFeatures = new Set(features)
}

/**
 * The names in `requires` a reader that knows `known` does not understand.
 * Empty = this document may be edited and saved. A malformed `requires`
 * (not an array, or non-string entries) counts as not understood: it can only
 * come from a writer this build does not know.
 */
export function missingFeatures(doc: { requires?: unknown } | null | undefined, known: ReadonlySet<string>): string[] {
  const req = doc?.requires
  if (req === undefined || req === null) return []
  if (!Array.isArray(req)) return [String(req)]
  return req.map(String).filter((f) => !known.has(f))
}

/** The kernel's view: its own features plus the app's registered ones. */
export function unsupportedFeatures(doc: { requires?: unknown } | null | undefined): string[] {
  return missingFeatures(doc, new Set([...KERNEL_FEATURES, ...appFeatures]))
}

/** Thrown by every serializer for a document this build must not write. */
export class UnsupportedFeaturesError extends Error {
  readonly features: string[]
  constructor(features: string[]) {
    super(`This document needs features this version of the app does not have (${features.join(', ')}); refusing to save it.`)
    this.features = features
    this.name = 'UnsupportedFeaturesError'
  }
}

// --- the document as readable text -------------------------------------------
//
// A plaintext file's doc block is written for PEOPLE and agents to read and
// edit, not just for the parser: two-space indent, and a key order that
// depends only on the content, never on edit history. Identity keys lead
// (format and version, then requires, docId, title; on anything else id,
// type, name), the rest follow alphabetically. So the same document always
// serializes to the same text, and a diff shows what changed, not which
// field happened to be written first. Arrays keep their order — it means
// something (slides, z-order).

const LEADING_KEYS = ['format', 'version', 'requires', 'docId', 'title', 'id', 'type', 'name']
const rank = (k: string) => { const i = LEADING_KEYS.indexOf(k); return i < 0 ? LEADING_KEYS.length : i }

/** `value` as canonical, indented JSON (see above). Parses back to an equal value. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v
    const keys = Object.keys(v).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    const out: Record<string, unknown> = {}
    for (const k of keys) out[k] = (v as Record<string, unknown>)[k]
    return out
  }, 2)
}
