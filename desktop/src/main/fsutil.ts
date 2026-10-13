// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Small filesystem helpers shared by every main-process writer. No electron
// import, so node-side rigs (scripts/test-desktop-docfile.ts) can load it.
import { closeSync, fsyncSync, openSync, realpathSync, renameSync, rmSync, statSync, writeSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/**
 * Write-then-rename, so a reader can never see a half-written file — the MCP
 * server's fs.watch wake-ups (terminalPanel.ts), and, since the desktop
 * started writing decks itself (documents.ts), a crash or power loss mid-save
 * that would otherwise leave a user's only copy truncated.
 *
 * The tmp name is dot-prefixed (matches none of terminalPanel.ts's
 * request/response patterns, and Finder hides it) and unique per call, so two
 * writers racing on one path can't clobber each other's tmp file. The data is
 * fsync'ed before the rename, and an existing file's permission bits are
 * carried over. Known cost: a rename is a new inode, so extended attributes
 * and Finder tags on the old file do not survive (docs/DECISIONS.md).
 *
 * A symlinked path is written THROUGH: the tmp file goes beside the real
 * target and is renamed onto it. Renaming onto the link itself replaced the
 * link with a regular file, so a deck reached through one (a synced folder
 * linked into ~/Documents) silently stopped updating its real copy.
 */
export function writeFileAtomic(linkOrPath: string, data: string | Uint8Array): void {
  let path = linkOrPath
  try { path = realpathSync(linkOrPath) } catch { /* new file (or a dangling link): write the path as given */ }
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
  let mode: number | null = null
  try { mode = statSync(path).mode & 0o7777 } catch { /* new file */ }
  const fd = openSync(tmp, 'w')
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
    fsyncSync(fd)
  } catch (err) {
    closeSync(fd)
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw err
  }
  closeSync(fd)
  try {
    if (mode != null) chmodSync(tmp, mode)
    renameSync(tmp, path)
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw err
  }
}
