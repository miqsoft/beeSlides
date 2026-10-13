// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// A profile's "Reasoning" setting is sent as `reasoning_effort` (or
// `output_config.effort` on api.anthropic.com). A server that does not know the
// field answers 400 (Anthropic: "Extra inputs are not permitted"; OpenAI on a
// non-reasoning model: "Unrecognized request argument"/"Unsupported parameter"):
// we recognise it, remember it per server and model, and retry without it —
// the setting then simply has no effect there.
import type { Provider } from '../types.ts'

/** Whether a 400 is about the reasoning-effort field. */
export function isReasoningReject(e: unknown): boolean {
  const err = e as { status?: number; message?: string }
  if (err?.status !== 400 || typeof err.message !== 'string') return false
  const m = err.message
  return /reasoning_effort|reasoning effort|output_config|\beffort\b/i.test(m)
    || /extra inputs are not permitted/i.test(m)
}

const rejected = new Set<string>()

export function withReasoningFallback(inner: Provider): Provider {
  return {
    async complete(o) {
      const key = `${o.baseUrl}\n${o.model}`
      if (!o.reasoning || rejected.has(key)) return inner.complete({ ...o, reasoning: undefined })
      try { return await inner.complete(o) } catch (e) {
        if (!isReasoningReject(e) || o.signal.aborted) throw e
        rejected.add(key)
        return inner.complete({ ...o, reasoning: undefined })
      }
    },
  }
}
