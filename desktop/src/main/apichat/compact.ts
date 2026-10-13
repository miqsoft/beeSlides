// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Compaction: the old part of a long conversation is replaced by one
// model-written `summary` message so the chat keeps fitting the context
// window. The cut never splits a tool_use/tool_result pair.
import type { ChatEvent, ChatMsg, Provider } from './types.ts'

/** Compact when the context passes this share of the window. */
export const COMPACT_AT = 0.75
/** The tail always keeps at least this many messages. */
const KEEP_TAIL = 4
const TOOL_RESULT_CAP = 2000

export const SUMMARY_PREFIX = '[Summary of the earlier conversation]'

export const SUMMARIZER_SYSTEM = [
  'You compress the earlier part of a conversation between a user and an AI assistant that edits a slide deck through tools. Your summary replaces that part, so the assistant must be able to continue from it without the original messages.',
  'Write a compact, factual summary in plain markdown covering: the user\'s goals and requests; the decisions taken (style, wording, structure, constraints the user stated); the slides, slide types and element ids touched, with what was changed; open tasks and unresolved problems; the current state of the deck as far as it is known.',
  'Keep exact ids, names and numbers. Leave out pleasantries and tool chatter. Do not invent anything. Output only the summary.',
].join('\n\n')

/** Wire view: each `summary` becomes a user message, merged into the next
 *  user message when there is one so the roles still alternate. */
export function resolveSummaries(messages: ChatMsg[]): ChatMsg[] {
  const out: ChatMsg[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'summary') { out.push(m); continue }
    const text = `${SUMMARY_PREFIX}\n${m.text}`
    const next = messages[i + 1]
    if (next?.role === 'user') {
      out.push({ role: 'user', text: `${text}\n\n${next.text}`, shown: next.shown, ...(next.images ? { images: next.images } : {}) })
      i++
    } else out.push({ role: 'user', text })
  }
  return out
}

/** Index where the kept tail starts, or -1 when nothing can be cut. */
export function chooseCut(messages: ChatMsg[]): number {
  let cut = messages.length - KEEP_TAIL
  while (cut > 0 && (messages[cut].role === 'tool' || messages[cut].role === 'summary')) cut--
  return cut >= 1 ? cut : -1
}

function transcriptOf(messages: ChatMsg[]): string {
  const cap = (s: string): string => (s.length > TOOL_RESULT_CAP ? `${s.slice(0, TOOL_RESULT_CAP)}… [${s.length - TOOL_RESULT_CAP} more characters cut]` : s)
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'user') lines.push(`USER: ${m.shown ?? m.text}`)
    else if (m.role === 'summary') lines.push(`EARLIER SUMMARY: ${m.text}`)
    else if (m.role === 'assistant') {
      if (m.text) lines.push(`ASSISTANT: ${m.text}`)
      for (const c of m.toolCalls) lines.push(`ASSISTANT CALLED ${c.name} ${cap(JSON.stringify(c.args))}`)
    } else for (const r of m.results) lines.push(`RESULT of ${r.name}${r.isError ? ' (error)' : ''}: ${cap(r.text)}`)
  }
  return lines.join('\n')
}

/** The model a summary is written with (Settings ▸ AI ▸ Advanced). */
export interface SummarizerModel { provider: Provider; baseUrl: string; model: string; maxTokens: number; apiKey?: string }

export interface CompactDeps {
  /** Writes the summary instead of the chat's own model. */
  summarizer?: SummarizerModel
  provider: Provider
  baseUrl: string
  model: string
  maxTokens: number
  apiKey?: string
  messages: ChatMsg[]
  /** Receives the compacted-away messages (the panel can still show them). */
  archive?: ChatMsg[]
  emit: (ev: ChatEvent) => void
  changed: () => void
}

/** Summarizes the old prefix in place. Returns false when there was nothing
 *  to cut; throws when the summary call fails (messages stay untouched). */
export async function compactConversation(deps: CompactDeps, focus: string | undefined, signal: AbortSignal): Promise<boolean> {
  const cut = chooseCut(deps.messages)
  if (cut < 0) return false
  const prefix = deps.messages.slice(0, cut)
  const ask = `Summarize this conversation so far.${focus ? ` Pay particular attention to: ${focus}` : ''}\n\n<conversation>\n${transcriptOf(prefix)}\n</conversation>`
  const m = deps.summarizer ?? deps
  const c = await m.provider.complete({
    baseUrl: m.baseUrl, model: m.model, maxTokens: Math.min(m.maxTokens, 4096), apiKey: m.apiKey,
    system: SUMMARIZER_SYSTEM, tools: [], messages: [{ role: 'user', text: ask }], signal, onText: () => {},
  })
  const summary = c.text.trim()
  if (!summary) throw new Error('the summary came back empty')
  deps.messages.splice(0, cut, { role: 'summary', text: summary })
  deps.archive?.push(...prefix)
  deps.changed()
  deps.emit({ type: 'compacted', summary })
  return true
}
