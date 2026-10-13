// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// API-chat transcripts (v2; v1 files still load): userData/api-chats/<id>.json, our own JSON (a Claude
// Code chat's transcript stays in Claude Code's folder). Screenshots are not
// stored — they would bloat the file and are only useful on the turn they
// were taken.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../fsutil.ts'
import type { ChatMsg } from './types.ts'

export interface Transcript {
  version: 2
  profileId: string
  /** What the model sees. */
  messages: ChatMsg[]
  /** Compacted-away messages (images stripped) — only for the panel's history. */
  archive: ChatMsg[]
}

export function transcriptPath(dir: string, id: string): string { return join(dir, `${id}.json`) }

function stripImages(messages: ChatMsg[]): ChatMsg[] {
  return messages.map((m) => (m.role === 'tool'
    ? { ...m, results: m.results.map((r) => ({ ...r, text: r.images.length ? `${r.text}\n[screenshot omitted]`.trim() : r.text, images: [] })) }
    : m))
}

export function saveTranscript(dir: string, id: string, t: Transcript): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileAtomic(transcriptPath(dir, id), JSON.stringify({ ...t, messages: stripImages(t.messages), archive: stripImages(t.archive) }))
  } catch { /* best effort */ }
}

export function loadTranscript(dir: string, id: string): Transcript | null {
  const p = transcriptPath(dir, id)
  if (!existsSync(p)) return null
  try {
    const t = JSON.parse(readFileSync(p, 'utf8'))
    if ((t?.version !== 1 && t?.version !== 2) || !Array.isArray(t.messages) || typeof t.profileId !== 'string') return null
    return { version: 2, profileId: t.profileId, messages: t.messages, archive: Array.isArray(t.archive) ? t.archive : [] }
  } catch { return null }
}
