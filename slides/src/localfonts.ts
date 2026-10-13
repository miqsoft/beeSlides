// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Real system-font enumeration via Chromium's Local Font Access API
// (window.queryLocalFonts). Separate from fonts.ts, which is about curated
// cross-platform stacks + @font-face embedding — a different concern.
//
// queryLocalFonts() requires transient user activation (a live click/keydown
// on the call stack) — it must only ever be called from inside a genuine
// user-gesture path, not eagerly at boot.

/** TS lib.dom doesn't have these yet. */
declare global {
  interface Window {
    queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<FontData[]>
  }
  interface FontData {
    readonly family: string
    readonly fullName: string
    readonly postscriptName: string
    readonly style: string
  }
}

/** null = not yet settled (first genuine call still pending/not made). */
let cache: string[] | null = null
let inFlight = false
const readyListeners: Array<() => void> = []

/**
 * Idempotent entry point — call from inside a real user-gesture path (e.g.
 * a panel rebuild triggered by a click/keypress). No-ops once cached or
 * while a request is already in flight.
 */
export function requestSystemFonts(): void {
  if (cache !== null || inFlight) return
  if (typeof window.queryLocalFonts !== 'function') {
    settle([])
    return
  }
  inFlight = true
  window.queryLocalFonts()
    .then((fonts) => {
      const families = Array.from(new Set(fonts.map((f) => f.family))).sort()
      settle(families)
    })
    .catch((err) => {
      inFlight = false
      // No activation yet on THIS call — leave cache null so the next
      // genuine click/keypress retries, instead of poisoning it forever.
      if (err instanceof Error && err.name === 'SecurityError') return
      // Denied (NotAllowedError) or any other failure — settle for the
      // rest of the session, matching today's (no system fonts) behavior.
      settle([])
    })
}

function settle(families: string[]): void {
  cache = families
  inFlight = false
  const cbs = readyListeners.splice(0)
  for (const cb of cbs) cb()
}

/** Synchronous cache read — safe to call on every render. */
export function systemFonts(): string[] {
  return cache ?? []
}

/** Registers a callback fired once the async fetch settles. */
export function onSystemFontsReady(cb: () => void): void {
  if (cache !== null) cb()
  else readyListeners.push(cb)
}
