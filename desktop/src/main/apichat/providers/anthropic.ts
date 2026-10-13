// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Anthropic Messages API (and any Anthropic-compatible URL).
import Anthropic from '@anthropic-ai/sdk'
import { Stream } from '@anthropic-ai/sdk/streaming'
import { resolveSummaries } from '../compact.ts'
import { withoutImages } from './images.ts'
import { jsonValues, toolCallsFrom } from './lenientjson.ts'
import type { ChatMsg, CompleteOptions, Completion, Provider, ReasoningEffort, ToolCall, ToolDef, Usage } from '../types.ts'

export function toAnthropicTools(tools: ToolDef[]): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
}

type Block = Record<string, unknown>

/** Neutral transcript → Messages API `messages`. Only the images of the most
 *  recent tool message are sent (older screenshots would be paid for on
 *  every later turn). */
export function toAnthropicMessages(messages: ChatMsg[]): Array<{ role: 'user' | 'assistant'; content: string | Block[] }> {
  messages = resolveSummaries(messages)
  let lastTool = -1
  messages.forEach((m, i) => { if (m.role === 'tool') lastTool = i })
  return messages.map((m, i) => {
    if (m.role === 'user') {
      if (!m.images?.length) return { role: 'user' as const, content: m.text }
      return { role: 'user' as const, content: [...m.images.map((img): Block => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } })), { type: 'text', text: m.text }] }
    }
    if (m.role === 'assistant') {
      const content: Block[] = []
      if (m.text) content.push({ type: 'text', text: m.text })
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args })
      return { role: 'assistant' as const, content }
    }
    if (m.role !== 'tool') throw new Error('unreachable')
    return {
      role: 'user' as const,
      content: m.results.map((r): Block => {
        const parts: Block[] = [{ type: 'text', text: r.text || (r.isError ? 'Error' : 'OK') }]
        if (i === lastTool) {
          for (const img of r.images) parts.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } })
        }
        return { type: 'tool_result', tool_use_id: r.id, content: parts, ...(r.isError ? { is_error: true } : {}) }
      }),
    }
  })
}

/** api.anthropic.com takes `x-api-key`; every compatible endpoint (gateways,
 *  proxies) is sent a Bearer token, like Claude Code's ANTHROPIC_AUTH_TOKEN. */
export function anthropicAuth(baseUrl: string, key: string | undefined): { apiKey?: string; authToken?: string } {
  // The SDK refuses to send without credentials; a gateway that needs none ignores this.
  if (!key) return { apiKey: 'none' }
  return isAnthropicHost(baseUrl) ? { apiKey: key } : { authToken: key }
}

const isAnthropicHost = (baseUrl: string): boolean => {
  try { return new URL(baseUrl).hostname === 'api.anthropic.com' } catch { return false }
}

/** The request field that sets the reasoning effort. Anthropic's own API takes
 *  `output_config.effort`; gateways in front of other models (LiteLLM → GLM,
 *  DeepSeek …) take the OpenAI-style top-level `reasoning_effort`. Either may be
 *  rejected by a server that knows neither (providers/reasoning.ts retries without). */
export function anthropicReasoningBody(baseUrl: string, effort: ReasoningEffort | undefined): Record<string, unknown> {
  if (!effort) return {}
  return isAnthropicHost(baseUrl) ? { output_config: { effort } } : { reasoning_effort: effort }
}

/** Gateways that rejected `cache_control` (remembered per base URL). */
const noCaching = new Set<string>()

type Wire = { role: 'user' | 'assistant'; content: string | Block[] }

/** Marks the last tool and the last content block of the last message as
 *  cache breakpoints (the system prompt gets its own in `complete`). */
export function withCacheControl(tools: Array<Record<string, unknown>>, messages: Wire[]): { tools: Array<Record<string, unknown>>; messages: Wire[] } {
  const cc = { type: 'ephemeral' }
  const t = tools.map((x, i) => (i === tools.length - 1 ? { ...x, cache_control: cc } : x))
  const msgs = messages.slice()
  const last = msgs[msgs.length - 1]
  if (last) {
    const blocks: Block[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.slice()
    if (blocks.length) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: cc }
    msgs[msgs.length - 1] = { role: last.role, content: blocks }
  }
  return { tools: t, messages: msgs }
}

const isCacheReject = (e: unknown): boolean => {
  const err = e as { status?: number; message?: string }
  return err?.status === 400 && /cache_control|cache control/i.test(err.message ?? '')
}

export const anthropicProvider: Provider = {
  async complete(o: CompleteOptions): Promise<Completion> {
    const auth = anthropicAuth(o.baseUrl, o.apiKey)
    const client = new Anthropic({ baseURL: o.baseUrl, apiKey: auth.apiKey ?? null, authToken: auth.authToken ?? null, maxRetries: 1 })
    const run = async (cache: boolean): Promise<Completion> => {
      const tools = toAnthropicTools(o.tools) as Array<Record<string, unknown>>
      const messages = toAnthropicMessages(o.images === false ? withoutImages(o.messages) : o.messages)
      const c = cache ? withCacheControl(tools, messages) : { tools, messages }
      // Raw events, accumulated here: the SDK's own accumulator parses each
      // SSE event and tool input strictly, and one malformed piece from a
      // gateway fails the whole turn (see lenientjson.ts).
      const response = await client.messages.create({
        model: o.model,
        max_tokens: o.maxTokens,
        system: cache ? [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }] : o.system,
        ...(c.tools.length ? { tools: c.tools as never } : {}),
        messages: c.messages as never,
        stream: true,
        ...anthropicReasoningBody(o.baseUrl, o.reasoning),
      } as never, { signal: o.signal }).asResponse()
      let text = ''
      let stop: string | null = null
      const u: Record<string, number> = {}
      const takeUsage = (x: unknown) => {
        for (const [k, v] of Object.entries((x ?? {}) as Record<string, unknown>)) if (typeof v === 'number') u[k] = v
      }
      const blocks = new Map<number, { id: string; name: string; input: unknown; json: string }>()
      for await (const sse of Stream.rawEvents(response)) {
        if (sse.event === 'ping' || !sse.data.trim() || sse.data.trim() === '[DONE]') continue
        if (sse.event === 'error') {
          const body = jsonValues(sse.data)?.[0] as { error?: { type?: string } } | undefined
          throw new Anthropic.APIError(undefined, body ?? sse.data, undefined, response.headers, (body?.error?.type ?? null) as never)
        }
        const events = jsonValues(sse.data)
        if (!events) throw new Error(`The server sent a stream event that is not JSON: ${sse.data.slice(0, 200)}`)
        for (const ev of events as Array<Record<string, any>>) {
          if (ev?.type === 'message_start') takeUsage(ev.message?.usage)
          else if (ev?.type === 'content_block_start') {
            const b = ev.content_block ?? {}
            if (b.type === 'text' && b.text) { text += b.text; o.onText(b.text) }
            else if (b.type === 'thinking' || b.type === 'redacted_thinking') o.onThinking?.(typeof b.thinking === 'string' ? b.thinking : '')
            else if (b.type === 'tool_use') blocks.set(ev.index, { id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input, json: '' })
          } else if (ev?.type === 'content_block_delta') {
            const d = ev.delta ?? {}
            if (d.type === 'text_delta' && d.text) { text += d.text; o.onText(d.text) }
            else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') o.onThinking?.(d.thinking)
            else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
              const b = blocks.get(ev.index)
              if (b) b.json += d.partial_json
            }
          } else if (ev?.type === 'message_delta') {
            if (ev.delta?.stop_reason) stop = ev.delta.stop_reason
            takeUsage(ev.usage)
          }
        }
      }
      const toolCalls: ToolCall[] = []
      for (const [index, b] of [...blocks.entries()].sort((x, y) => x[0] - y[0])) {
        // No deltas: the input came whole in content_block_start.
        const raw = b.json.trim() ? b.json : b.input && typeof b.input === 'object' ? JSON.stringify(b.input) : ''
        toolCalls.push(...toolCallsFrom(b.id || `toolu_${index}_${Date.now()}`, b.name, raw))
      }
      const usage: Usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 }
      const reported = usage.input + usage.cacheRead + usage.cacheWrite > 0
      return { text, toolCalls, truncated: stop === 'max_tokens', ...(reported ? { usage } : {}) }
    }
    if (noCaching.has(o.baseUrl)) return run(false)
    try { return await run(true) } catch (e) {
      if (!isCacheReject(e)) throw e
      noCaching.add(o.baseUrl)
      return run(false)
    }
  },
}
