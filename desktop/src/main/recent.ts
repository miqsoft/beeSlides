// Recent-files list. Plain absolute paths in a small JSON file under
// userData — Electron has real fs access, so this needs none of the
// FileSystemFileHandle-in-IndexedDB trick slidomingo/home built only to work
// around *browser* sandboxing (see docs/DECISIONS.md, 2026-08-02 entries).
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { docKindOfText } from './docfile.ts'

interface RecentEntry {
  path: string
  openedAt: number
  /** Start page ▸ Pin: kept on top, and never aged out by MAX_RECENT. */
  pinned?: boolean
}

/** Unpinned entries kept; pinned ones come on top of these. */
const MAX_RECENT = 20

const listeners = new Set<() => void>()

/** Notified whenever the recent list changes (addRecent/clearRecent) — lets
 *  menu.ts rebuild its Open Recent submenu without a new cross-import, since
 *  it already imports from this module. */
export function onRecentChanged(cb: () => void): void {
  listeners.add(cb)
}

function notifyChanged(): void {
  for (const cb of listeners) cb()
}

const storePath = (): string => join(app.getPath('userData'), 'recent-files.json')

function readAll(): RecentEntry[] {
  try {
    const raw = readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e?.path === 'string') : []
  } catch {
    return []
  }
}

function writeAll(entries: RecentEntry[]): void {
  const p = storePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(entries, null, 2), 'utf8')
}

const kindCache = new Map<string, { mtimeMs: number; kind: 'figure' | 'iconset' | null }>()

/** Is this file a figure or an icon set (doc.kind)? Reads the #slidomingo-doc
 *  block only — the first thing in a saved file's head — and stops at its
 *  closing tag; an encrypted or unreadable file is simply a deck. */
function fileDocKind(path: string): 'figure' | 'iconset' | null {
  try {
    const mtimeMs = statSync(path).mtimeMs
    const hit = kindCache.get(path)
    if (hit && hit.mtimeMs === mtimeMs) return hit.kind
    const fd = openSync(path, 'r')
    let kind: 'figure' | 'iconset' | null = null
    try {
      const buf = Buffer.alloc(1 << 20)
      let text = ''
      let pos = 0
      for (let n = 0; n < 64; n++) { // 64 MB cap
        const got = readSync(fd, buf, 0, buf.length, pos)
        if (got <= 0) break
        pos += got
        text = (text + buf.toString('utf8', 0, got)).slice(-(buf.length + 64))
        const start = text.indexOf('id="slidomingo-doc"')
        if (start < 0) continue
        const end = text.indexOf('</script', start)
        kind = docKindOfText(text.slice(start, end < 0 ? undefined : end))
        if (end >= 0) break
      }
    } finally { closeSync(fd) }
    kindCache.set(path, { mtimeMs, kind })
    return kind
  } catch {
    return null
  }
}

/** Most-recently-opened first. Drops entries whose file no longer exists. */
export function listRecent(): { path: string; openedAt: number; pinned: boolean; figure: boolean; iconset: boolean }[] {
  return readAll().filter((e) => existsSync(e.path)).sort((a, b) => b.openedAt - a.openedAt)
    .map((e) => {
      const kind = fileDocKind(e.path)
      return { path: e.path, openedAt: e.openedAt, pinned: !!e.pinned, figure: kind === 'figure', iconset: kind === 'iconset' }
    })
}

/** Every pinned entry, plus the MAX_RECENT newest unpinned ones. */
function trim(entries: RecentEntry[]): RecentEntry[] {
  entries.sort((a, b) => b.openedAt - a.openedAt)
  let unpinned = 0
  return entries.filter((e) => e.pinned || ++unpinned <= MAX_RECENT)
}

export function addRecent(path: string): void {
  const all = readAll()
  const pinned = all.some((e) => e.path === path && e.pinned)
  const entries = all.filter((e) => e.path !== path)
  entries.push({ path, openedAt: Date.now(), ...(pinned ? { pinned } : {}) })
  writeAll(trim(entries))
  app.addRecentDocument(path) // OS-level "Recent Documents" (Dock/Jump List)
  notifyChanged()
}

/** Start page ▸ Pin / Unpin. Unpinning may age the entry out at once. */
export function pinRecent(path: string, pinned: boolean): void {
  const entries = readAll()
  const e = entries.find((x) => x.path === path)
  if (!e) return
  if (pinned) e.pinned = true
  else delete e.pinned
  writeAll(trim(entries))
  notifyChanged()
}

/** Start page ▸ "Remove from list" — the file itself is untouched. */
export function removeRecent(path: string): void {
  writeAll(readAll().filter((e) => e.path !== path))
  notifyChanged()
}

export function clearRecent(): void {
  writeAll([])
  app.clearRecentDocuments()
  notifyChanged()
}
