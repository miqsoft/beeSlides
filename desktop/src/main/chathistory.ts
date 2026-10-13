// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Which `claude` conversations belong to which deck — parameterised by path so
// it runs without electron (scripts/test-desktop-chathistory.ts).
// terminalPanel.ts binds it to userData/chat-history.json and the user's
// Claude Code config folder.
//
// The transcripts themselves stay where Claude Code writes them
// (`<config>/projects/<cwd>/<id>.jsonl`); this file only keeps POINTERS: the
// session id the panel launched `claude` with (`--session-id`), plus the deck
// it ran against. A deck is matched by its docId (survives Finder renames,
// moves and Save As) and, until the renderer has reported one, by the path
// the window was bound to. Nothing is ever written next to or into the deck:
// transcripts carry raw tool output (file contents, env), which must not
// travel with a file people share (docs/DECISIONS.md, "Chat history").
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './fsutil.ts'

export interface ChatRecord {
  /** The `claude` session id (a uuid) — `--session-id` / `--resume`. */
  id: string
  /** The deck's docId when known at record time (backfilled later). */
  docId: string | null
  /** The window's bound path (a file, or a draft under userData/Drafts). */
  path: string | null
  startedAt: number
  /** The AI profile the conversation ran under (aiprofiles.ts), so a resume
   *  reopens it the same way; absent on records from before profiles. */
  profileId?: string
  /** `api` = a native API chat (apichat/), whose transcript is our own JSON
   *  under userData/api-chats instead of a Claude Code .jsonl. */
  kind?: 'claude' | 'api'
}

/** One row of the panel's history list. */
export interface ChatSummary {
  id: string
  title: string
  startedAt: number
  /** Transcript mtime — the last time anything was said. */
  updatedAt: number
  profileId?: string
  kind?: 'claude' | 'api'
}

/** Where a record's transcript lives, when it is not under the default
 *  Claude config folder. */
export interface ListExtras {
  /** Folder of API-chat transcripts (`<id>.json`). */
  apiDir?: string
  /** The Claude config folder a record's profile uses. */
  configDirOf?: (r: ChatRecord) => string
}

export interface DeckKey { docId: string | null; path: string | null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Only a real uuid ever reaches the `claude` command line (pty.ts). */
export function isChatId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id)
}

/** A session that never got a first message has no transcript; its record
 *  is dropped once it is this old (it can no longer be the live one). */
const EMPTY_RECORD_TTL_MS = 2 * 24 * 60 * 60 * 1000

export function loadRecords(storePath: string): ChatRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'))
    const list = Array.isArray(parsed?.records) ? parsed.records : []
    return list.filter((r: unknown): r is ChatRecord => {
      const rec = r as ChatRecord
      return !!rec && isChatId(rec.id) && typeof rec.startedAt === 'number'
    })
  } catch {
    return []
  }
}

function saveRecords(storePath: string, records: ChatRecord[]): void {
  try { writeFileAtomic(storePath, JSON.stringify({ version: 1, records }, null, 2)) } catch { /* best effort */ }
}

export function addRecord(storePath: string, record: ChatRecord): void {
  const records = loadRecords(storePath).filter((r) => r.id !== record.id)
  records.push(record)
  saveRecords(storePath, records)
}

function matches(r: ChatRecord, key: DeckKey): boolean {
  if (key.docId && r.docId) return r.docId === key.docId
  return !!key.path && r.path === key.path
}

/** The deck in a window changed identity under running conversations (a
 *  generated deck loaded with its own docId, Save As, a rename): they follow
 *  it, so they stay listed under the deck they were actually about. */
export function retarget(storePath: string, ids: string[], key: DeckKey): void {
  if (ids.length === 0 || (!key.docId && !key.path)) return
  const records = loadRecords(storePath)
  let changed = false
  for (const r of records) {
    if (!ids.includes(r.id)) continue
    if (key.docId && r.docId !== key.docId) { r.docId = key.docId; changed = true }
    if (key.path && r.path !== key.path) { r.path = key.path; changed = true }
  }
  if (changed) saveRecords(storePath, records)
}

/** The transcript file for a session id, wherever its project folder is (a
 *  session keeps its file when it is resumed from another folder, e.g. a
 *  draft's scratch dir before the deck was saved). */
export function findTranscript(configDir: string, id: string): string | null {
  if (!isChatId(id)) return null
  const projects = join(configDir, 'projects')
  let dirs: string[]
  try { dirs = readdirSync(projects) } catch { return null }
  for (const dir of dirs) {
    const file = join(projects, dir, `${id}.jsonl`)
    if (existsSync(file)) return file
  }
  return null
}

const TITLE_MAX = 80

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1)}…` : one
}

/** A human title for a transcript: the user's /rename, else Claude Code's own
 *  generated title, else the first thing the user typed. */
export function transcriptTitle(text: string): string | null {
  let custom: string | null = null
  let ai: string | null = null
  let firstPrompt: string | null = null
  for (const line of text.split('\n')) {
    const cheap = line.includes('"custom-title"') || line.includes('"ai-title"') || (!firstPrompt && line.includes('"type":"user"'))
    if (!cheap) continue
    let entry: { type?: string; customTitle?: unknown; aiTitle?: unknown; isMeta?: unknown; message?: { content?: unknown } }
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') custom = entry.customTitle
    else if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') ai = entry.aiTitle
    else if (entry.type === 'user' && !firstPrompt && !entry.isMeta) {
      const content = entry.message?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.find((c) => c?.type === 'text' && typeof c.text === 'string')?.text : undefined
      // Slash commands and local-command echoes arrive as <command-…> markup.
      if (typeof text === 'string' && text.trim() && !text.trimStart().startsWith('<')) firstPrompt = text
    }
  }
  const title = custom ?? ai ?? firstPrompt
  return title ? clip(title) : null
}

/** An API chat's title: its first user message (the transcript is our own
 *  JSON, see apichat/transcript.ts). */
export function apiTranscriptTitle(text: string): string | null {
  try {
    const t = JSON.parse(text)
    if (typeof t?.title === 'string' && t.title.trim()) return clip(t.title)
    const all = [...(Array.isArray(t?.archive) ? t.archive : []), ...(Array.isArray(t?.messages) ? t.messages : [])]
    const first = all.find((m: { role?: string }) => m?.role === 'user')
    const shown = first?.shown ?? first?.text
    return typeof shown === 'string' && shown.trim() ? clip(shown) : null
  } catch { return null }
}

/** The stored record for a conversation id. */
export function getRecord(storePath: string, id: string): ChatRecord | null {
  return loadRecords(storePath).find((r) => r.id === id) ?? null
}

/** The deck's conversations, newest activity first. Records without a
 *  transcript are skipped (opened, never used) and pruned once stale; a
 *  record matched by path learns the deck's docId, so it keeps matching
 *  after the file is renamed or moved. */
export function listChats(storePath: string, configDir: string, key: DeckKey, now = Date.now(), extras: ListExtras = {}): ChatSummary[] {
  const records = loadRecords(storePath)
  let changed = false
  const kept: ChatRecord[] = []
  const out: ChatSummary[] = []
  for (const r of records) {
    const mine = matches(r, key)
    const isApi = r.kind === 'api'
    let file: string | null
    if (isApi) {
      const p = extras.apiDir ? join(extras.apiDir, `${r.id}.json`) : null
      file = p && existsSync(p) ? p : null
    } else {
      file = findTranscript(extras.configDirOf?.(r) ?? configDir, r.id)
    }
    if (!file) {
      if (now - r.startedAt > EMPTY_RECORD_TTL_MS) { changed = true; continue }
      kept.push(r)
      continue
    }
    kept.push(r)
    if (!mine) continue
    if (key.docId && !r.docId) { r.docId = key.docId; changed = true }
    let updatedAt = r.startedAt
    let title: string | null = null
    try {
      updatedAt = statSync(file).mtimeMs
      const text = readFileSync(file, 'utf8')
      title = isApi ? apiTranscriptTitle(text) : transcriptTitle(text)
    } catch { /* unreadable — list it untitled */ }
    out.push({ id: r.id, title: title ?? 'Untitled conversation', startedAt: r.startedAt, updatedAt, profileId: r.profileId, kind: r.kind })
  }
  if (changed) saveRecords(storePath, kept)
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Whether `id` is one of this deck's recorded conversations — the check
 *  before a renderer-requested resume reaches the command line. */
export function belongsTo(storePath: string, id: string, key: DeckKey): boolean {
  return loadRecords(storePath).some((r) => r.id === id && matches(r, key))
}

/** Claude Code's project-folder name for a cwd: the realpath with every
 *  non-alphanumeric character turned into `-`. */
export function projectDirName(cwd: string): string {
  let real = cwd
  try { real = realpathSync(cwd) } catch { /* not created yet — encode as given */ }
  return real.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Transcripts already read and found not to be this deck's, keyed by id →
 *  size at read time (an appended-to transcript is looked at again). */
const rejected = new Map<string, number>()

function firstTimestamp(text: string): number | null {
  for (const line of text.split('\n', 40)) {
    const m = /"timestamp":"([^"]+)"/.exec(line)
    const t = m ? Date.parse(m[1]) : NaN
    if (!Number.isNaN(t)) return t
  }
  return null
}

/** Conversations that predate the history feature, or that Claude Code started
 *  itself (/clear, in-pty /resume), have a transcript but no record. Claim any
 *  unrecorded `<uuid>.jsonl` in the project folder of each given cwd (the deck's
 *  workspace, and for legacy chats the deck's own folder) that mentions the
 *  deck's docId (or bound path) — the filter matters because untitled drafts
 *  all share `slidomingo-desktop-untitled/<n>`. Claiming writes a record, so
 *  each transcript is claimed once. Returns how many were claimed. */
export function backfillChats(
  storePath: string, configDir: string, cwds: string | string[], key: DeckKey,
  cache: Map<string, number> = rejected,
): number {
  const needles = [key.docId, key.path].filter((n): n is string => !!n)
  if (needles.length === 0) return 0
  const known = new Set(loadRecords(storePath).map((r) => r.id))
  let claimed = 0
  for (const cwd of new Set(Array.isArray(cwds) ? cwds : [cwds])) claimed += backfillDir(storePath, join(configDir, 'projects', projectDirName(cwd)), key, needles, known, cache)
  return claimed
}

function backfillDir(
  storePath: string, dir: string, key: DeckKey, needles: string[], known: Set<string>, cache: Map<string, number>,
): number {
  let files: string[]
  try { files = readdirSync(dir) } catch { return 0 }
  let claimed = 0
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue
    const id = f.slice(0, -'.jsonl'.length)
    if (!isChatId(id) || known.has(id)) continue
    const file = join(dir, f)
    try {
      const size = statSync(file).size
      if (cache.get(id) === size) continue
      const text = readFileSync(file, 'utf8')
      if (!needles.some((n) => text.includes(n))) { cache.set(id, size); continue }
      addRecord(storePath, { id, docId: key.docId, path: key.path, startedAt: firstTimestamp(text) ?? statSync(file).mtimeMs })
      claimed++
    } catch { /* unreadable — skip */ }
  }
  return claimed
}
