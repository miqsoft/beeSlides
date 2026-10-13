// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Context-size bookkeeping: what a provider reported, or a chars/4 guess.
import type { ChatMsg, Usage } from './types.ts'

/** Rough token count of a conversation (screenshots are not counted). */
export function estimateTokens(system: string, messages: ChatMsg[]): number {
  let chars = system.length
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'summary') chars += m.text.length
    else if (m.role === 'assistant') chars += m.text.length + JSON.stringify(m.toolCalls).length
    else for (const r of m.results) chars += r.text.length
  }
  return Math.ceil(chars / 4)
}

/** Everything the model read on a call = its context size. */
export const contextTokens = (u: Usage): number => u.input + u.cacheRead + u.cacheWrite

export const DEFAULT_CONTEXT_WINDOW = { anthropic: 200_000, openai: 128_000 } as const
