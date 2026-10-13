// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Wire-neutral shapes of an API chat. The transcript is stored in THIS form
// (transcript.ts), so a conversation is independent of which provider wire
// produced it; providers/anthropic.ts and providers/openai.ts map to/from it.

import type { ReasoningEffort } from '../aiprofiles.ts'
export type { ReasoningEffort }

export interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ToolImage { data: string; mimeType: string }
export interface ToolResult { id: string; name: string; text: string; images: ToolImage[]; isError: boolean }

export type ChatMsg =
  /** `text` is what the model sees (selection digest + request); `shown` is
   *  what the user typed, for the panel. */
  | { role: 'user'; text: string; shown?: string; images?: ToolImage[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] }
  /** Replaces a compacted prefix of the conversation (compact.ts). */
  | { role: 'summary'; text: string }

/** What the loop tells the panel while it works. */
export type ChatEvent =
  | { type: 'user'; text: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'text-delta'; text: string }
  /** The model is reasoning. `text` is what it streamed (empty when the server
   *  hides it, or just to mark the start); the panel shows a collapsed line. */
  | { type: 'thinking'; text: string }
  /** `parent`: the id of the `task` call whose subagent made this call. */
  | { type: 'tool-start'; id: string; name: string; args: Record<string, unknown>; parent?: string }
  | { type: 'tool-end'; id: string; text: string; images: ToolImage[]; isError: boolean; parent?: string }
  | { type: 'usage'; contextTokens: number; contextWindow: number; cacheRead: number; totalTokens?: number }
  | { type: 'compacted'; summary: string }
  | { type: 'done'; stopped?: boolean }
  /** `retry`: the panel offers to run the turn again at this reasoning effort. */
  | { type: 'error'; message: string; retry?: { effort: ReasoningEffort } }

export interface CompleteOptions {
  baseUrl: string
  model: string
  maxTokens: number
  apiKey?: string
  system: string
  tools: ToolDef[]
  messages: ChatMsg[]
  signal: AbortSignal
  onText: (delta: string) => void
  /** Reasoning the model streams (not part of the answer, never stored). */
  onThinking?: (delta: string) => void
  /** Reasoning effort to request; undefined = the server's default. */
  reasoning?: ReasoningEffort
  /** false: a text-only model; screenshots are left out (providers/images.ts). */
  images?: boolean
}

export interface Completion {
  text: string
  toolCalls: ToolCall[]
  /** The model hit the output limit mid-answer. */
  truncated: boolean
  /** Absent when the provider reports none (tokens.ts then estimates). */
  usage?: Usage
}

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface Provider { complete(opts: CompleteOptions): Promise<Completion> }
