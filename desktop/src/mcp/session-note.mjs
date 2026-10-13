// SessionStart hook for the terminal panel's `claude` sessions: tells the app
// which conversation id this tab is running NOW. `claude` starts new ones
// itself (/clear, an in-pty /resume), and without this the app only knows the
// id it launched with, so those chats never reach the deck's history menu.
//
// Bundled via a `?raw` import (terminalPanel.ts) next to selection-digest.mjs;
// settings.json runs it as `node ./<shared>/session-note.mjs ./<sessionDir>`.
// The app's watcher on that folder picks up session-note.json. Node built-ins
// only; any failure is silent and exits 0 — a hook must never block startup.
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

try {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const { session_id: sessionId, source } = JSON.parse(raw)
  const dir = process.argv[2]
  if (typeof sessionId === 'string' && dir) {
    const tmp = join(dir, `.session-note.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify({ session_id: sessionId, source: typeof source === 'string' ? source : null }))
    renameSync(tmp, join(dir, 'session-note.json'))
  }
} catch { /* best effort */ }
