// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileAtomic } from './fsutil.ts'

const DEFAULT_CONFIG_PATH = join(homedir(), '.claude.json')

/** The global config file of a Claude Code config folder: `claude` keeps it
 *  next to the rest when CLAUDE_CONFIG_DIR is set (`~/.claude.json` otherwise). */
export function claudeJsonPath(configDir?: string): string {
  return configDir ? join(configDir, '.claude.json') : DEFAULT_CONFIG_PATH
}

/** Pre-accepts Claude Code's one-time per-directory "trust this folder"
 *  prompt for the cwd the pty is about to launch `claude` into — never any
 *  other project entry, and never destroys existing fields on that entry.
 *  Best-effort: any unexpected shape/failure is swallowed — worst case the
 *  dialog shows once, same as today. Note: this is the SAME effect as the
 *  user answering the dialog themselves, so it also affects a later manual
 *  `claude` run in that same folder outside slidomingo — expected, not a bug.
 *
 *  Writes BOTH `cwd` as given AND its realpath: on macOS `/tmp` and `/var`
 *  are symlinks into `/private/...`, so a scratch dir built from
 *  a temp-dir scratch folder is `/var/folders/...` while
 *  `claude` itself checks the REALPATH-resolved `/private/var/folders/...`
 *  — pre-accepting only the unresolved form left the dialog showing anyway
 *  for every fresh scratch dir (caught by hand while testing
 *  the "Create a template" AI paths: the trust prompt intercepted the very
 *  first launch, before the seeded task command could run). */
export function ensureClaudeTrust(cwd: string, configPath = DEFAULT_CONFIG_PATH): void {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    if (typeof config !== 'object' || config === null) return
    config.projects ??= {}
    let real: string
    try { real = realpathSync(cwd) } catch { real = cwd }
    let changed = false
    for (const path of new Set([cwd, real])) {
      const entry = config.projects[path] ?? {}
      if (entry.hasTrustDialogAccepted !== true) {
        config.projects[path] = { ...entry, hasTrustDialogAccepted: true }
        changed = true
      }
    }
    if (changed) writeConfig(configPath, config)
  } catch { /* best effort */ }
}

/** `claude` processes (other panel tabs, the user's own terminal) read this
 *  file while we write it: an in-place writeFileSync truncates first, and a
 *  half-written file read as corrupt makes Claude Code reset its config —
 *  login and per-project settings gone. Tmp + rename means a reader sees the
 *  old file or the new one, never a torn one (and a symlinked config stays a
 *  link, fsutil.ts). */
function writeConfig(configPath: string, config: unknown): void {
  writeFileAtomic(configPath, JSON.stringify(config, null, 2))
}

/** Drops the `projects` entries for exactly these paths (workspaces we just
 *  deleted) so ~/.claude.json does not grow forever. Callers pass only paths
 *  under our own workspaces root; nothing else is ever touched. */
export function removeClaudeTrust(paths: string[], configPath = DEFAULT_CONFIG_PATH): void {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    if (typeof config !== 'object' || config === null || typeof config.projects !== 'object' || config.projects === null) return
    let changed = false
    for (const p of paths) {
      if (Object.prototype.hasOwnProperty.call(config.projects, p)) { delete config.projects[p]; changed = true }
    }
    if (changed) writeConfig(configPath, config)
  } catch { /* best effort */ }
}
