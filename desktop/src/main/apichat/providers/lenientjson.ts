// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Tolerant JSON for what gateways stream. OpenAI→Anthropic translators (seen
// with GLM behind a self-hosted gateway) sometimes put two JSON values where one belongs: a
// tool call's arguments twice (`{…}{…}`), an empty object before the real one
// (`{}{…}`), or two SSE events on adjacent `data:` lines (which SSE joins with
// a newline). Strict JSON.parse rejects all of them — "Unexpected
// non-whitespace character after JSON at position N" — and the SDKs fail the
// whole turn over it.
import type { ToolCall } from '../types.ts'

/** The top-level JSON values in `s`, in order. Beyond a single value only
 *  concatenated objects/arrays are split (adjacent scalars are ambiguous);
 *  null when any part is not JSON. */
export function jsonValues(s: string): unknown[] | null {
  try { return [JSON.parse(s)] } catch { /* maybe several values */ }
  const out: unknown[] = []
  const n = s.length
  let i = 0
  for (;;) {
    while (i < n && /\s/.test(s[i])) i++
    if (i >= n) return out.length ? out : null
    if (s[i] !== '{' && s[i] !== '[') return null
    const start = i
    let depth = 0
    let inStr = false
    for (; i < n; i++) {
      const ch = s[i]
      if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false }
      else if (ch === '"') inStr = true
      else if (ch === '{' || ch === '[') depth++
      else if ((ch === '}' || ch === ']') && --depth === 0) { i++; break }
    }
    try { out.push(JSON.parse(s.slice(start, i))) } catch { return null }
  }
}

const isArgs = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** One streamed tool call → the calls it really holds. Repeats and empty
 *  objects are dropped; distinct objects are separate calls a gateway merged
 *  into one slot (they get `<id>_2`, `<id>_3`, …). Unparseable arguments
 *  become `{}` and the tool reports what is missing. */
export function toolCallsFrom(id: string, name: string, rawArgs: string): ToolCall[] {
  const seen = new Set<string>()
  const args = (rawArgs.trim() ? jsonValues(rawArgs) ?? [] : []).filter(isArgs).filter((v) => {
    const key = JSON.stringify(v)
    if (key === '{}' || seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (!args.length) args.push({})
  return args.map((a, k) => ({ id: k ? `${id}_${k + 1}` : id, name, args: a }))
}
