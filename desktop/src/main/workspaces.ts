// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Per-deck Claude workspaces. The Claude panel runs `claude` in
// `userData/claude-workspaces/<key>/` — an app-owned folder — instead of the
// deck's own folder, so the deck's folder (and its ancestors' CLAUDE.md,
// .claude/ settings, hooks, git state) never becomes the Claude Code project.
// The deck's folder stays reachable through `--add-dir` (pty.ts). Electron-
// free (the root is passed in) so scripts/test-desktop-workspaces.ts can run it.
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { removeClaudeTrust } from './claudeTrust.ts'

const UNTITLED = 'untitled-'
/** Mirrors Claude Code's `cleanupPeriodDays` default. */
export const WORKSPACE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Folder name for a window's workspace: the deck's docId (stable across
 *  rename/move/Save As) when it is a plain token, else a per-window untitled
 *  key. The docId never reaches a shell line, but is still kept path-safe. */
export function workspaceKey(docId: string | null, windowId: number): string {
  return docId && /^[A-Za-z0-9_-]{1,80}$/.test(docId) ? docId : `${UNTITLED}${windowId}`
}

export const isUntitledKey = (key: string): boolean => key.startsWith(UNTITLED)

export const workspacePath = (root: string, key: string): string => join(root, key)

/** Creates the workspace (if needed), marks it as used now, and writes the
 *  orientation CLAUDE.md, plus `skills` (name → SKILL.md text) as Claude Code
 *  project skills in `.claude/skills/<name>/SKILL.md` — `/customize-ui` comes
 *  from the same text the API chat uses. Returns its path. */
export function ensureWorkspace(root: string, key: string, deckName: string | null, hasDeckDir: boolean, skills: Record<string, string> = {}): string {
  const dir = workspacePath(root, key)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(join(dir, 'CLAUDE.md'),
      `# BeeSlides workspace\n\n` +
      `This folder is managed by the BeeSlides app; do not put files here.\n` +
      `You are editing ${deckName ? `the deck "${deckName}"` : 'an unsaved deck'} through the slidomingo-slides MCP tools.\n` +
      (hasDeckDir ? `The deck's own folder is available as an additional working directory.\n` : ''), 'utf8')
  } catch { /* best effort */ }
  for (const [name, text] of Object.entries(skills)) {
    if (!/^[a-z0-9-]{1,64}$/.test(name)) continue
    try {
      mkdirSync(join(dir, '.claude', 'skills', name), { recursive: true })
      writeFileSync(join(dir, '.claude', 'skills', name, 'SKILL.md'), text, 'utf8')
    } catch { /* best effort */ }
  }
  try { const now = new Date(); utimesSync(dir, now, now) } catch { /* best effort */ }
  return dir
}

/** Removes stale workspaces under `root` and their `~/.claude.json` trust
 *  entries. Stale = an `untitled-*` workspace (window ids restart each run) or
 *  anything untouched for `maxAgeMs`, never one in `inUse`. Returns the removed
 *  paths. Only direct children of `root` are ever touched. */
export function sweepWorkspaces(
  root: string,
  opts: { inUse?: ReadonlySet<string>; now?: number; maxAgeMs?: number; configPath?: string } = {},
): string[] {
  const { inUse = new Set<string>(), now = Date.now(), maxAgeMs = WORKSPACE_MAX_AGE_MS, configPath } = opts
  let names: string[]
  try { names = readdirSync(root) } catch { return [] }
  const removed: string[] = []
  const trustPaths: string[] = []
  for (const name of names) {
    const dir = join(root, name)
    try {
      const st = statSync(dir)
      if (!st.isDirectory() || inUse.has(name)) continue
      if (!isUntitledKey(name) && now - st.mtimeMs <= maxAgeMs) continue
      trustPaths.push(dir)
      try { trustPaths.push(realpathSync(dir)) } catch { /* same as dir */ }
      rmSync(dir, { recursive: true, force: true })
      if (!existsSync(dir)) removed.push(dir)
    } catch { /* best effort */ }
  }
  const prefix = resolve(root) + sep
  const safe = trustPaths.filter((p) => resolve(p).startsWith(prefix) || realUnder(root, p))
  if (safe.length) removeClaudeTrust(safe, configPath)
  return removed
}

function realUnder(root: string, p: string): boolean {
  try { return resolve(p).startsWith(realpathSync(root) + sep) } catch { return false }
}
