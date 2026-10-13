// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// A parallel Claude Code terminal session's tab (desktop/src/renderer/
// terminal/main.ts) and this editor's own lock badges (editor.ts's
// makeThumb/Slide Sorter) both need to show the SAME color for the same
// session id — but they are two fully separate renderers sharing no bundle
// (same reason the terminal renderer duplicates its own icon set rather than
// importing icons.ts). Rather than have the main process broker a
// session-id -> color assignment and push it to both sides (one more
// cross-process round trip, one more thing that can go stale if a tab
// closes/reopens mid-flight), both sides independently derive the SAME color
// from the session id itself via this pure, dependency-free hash — a session
// id (crypto.randomUUID()) never changes for the life of a tab, so the color
// it maps to never needs to be communicated at all. Keep this file's
// constants byte-identical to the copy in
// desktop/src/renderer/terminal/main.ts if either ever changes.
const SESSION_COLORS = ['#7A5CFF', '#2FB6B2', '#E8442E', '#F4B400', '#3D8BFD', '#22A559', '#D6558C', '#8A6D3B']

export function colorForSession(sessionId: string): string {
  let hash = 0
  for (let i = 0; i < sessionId.length; i++) hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0
  return SESSION_COLORS[hash % SESSION_COLORS.length]
}
