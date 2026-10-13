// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// A profile without "Max tokens" asks for DEFAULT_MAX_TOKENS: reasoning models
// (GLM, DeepSeek, o-series…) spend their thinking from the same budget, so the
// old 8192 cut answers off. Servers whose model allows less reject the request
// with a 400 that names the real limit; we read it, remember it per server and
// model, and retry once with it.
import type { Provider } from '../types.ts'

export const DEFAULT_MAX_TOKENS = 32000

/** The output budget a 400 says this model allows, or null if it says nothing usable.
 *  - Anthropic: "max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for …"
 *  - OpenAI: "max_tokens is too large: 32000. This model supports at most 16384 completion tokens …"
 *  - vLLM / OpenAI-compatible: "This model's maximum context length is 32768 tokens. However, you
 *    requested 40000 tokens (8000 in the messages, 32000 in the completion)." */
export function outputCapFromError(e: unknown): number | null {
  const err = e as { status?: number; message?: string }
  if (err?.status !== 400 || typeof err.message !== 'string') return null
  const m = err.message
  let cap: number | null = null
  const anth = /max_tokens:\s*\d+\s*>\s*(\d+)/i.exec(m)
  const most = /at most (\d+) (?:completion|output) tokens/i.exec(m)
  const ctx = /maximum context length is (\d+) tokens[\s\S]*?\((\d+) in the messages/i.exec(m)
  if (anth) cap = Number(anth[1])
  else if (most) cap = Number(most[1])
  else if (ctx) cap = Number(ctx[1]) - Number(ctx[2]) - 64 // a little slack for template tokens
  return cap !== null && Number.isFinite(cap) && cap >= 16 ? cap : null
}

const caps = new Map<string, number>()

export function withOutputCap(inner: Provider): Provider {
  return {
    async complete(o) {
      const key = `${o.baseUrl}\n${o.model}`
      const known = caps.get(key)
      const maxTokens = known ? Math.min(o.maxTokens, known) : o.maxTokens
      try { return await inner.complete({ ...o, maxTokens }) } catch (e) {
        const cap = outputCapFromError(e)
        if (cap === null || cap >= maxTokens || o.signal.aborted) throw e
        // A context-length cap depends on this request's prompt: don't keep it.
        if (!/context length/i.test((e as Error).message)) caps.set(key, cap)
        return inner.complete({ ...o, maxTokens: cap })
      }
    },
  }
}
