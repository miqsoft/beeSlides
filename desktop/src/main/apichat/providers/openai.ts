// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// OpenAI Chat Completions wire (OpenAI and OpenAI-compatible servers).
import OpenAI from 'openai'
import { resolveSummaries } from '../compact.ts'
import { withoutImages } from './images.ts'
import { toolCallsFrom } from './lenientjson.ts'
import type { ChatMsg, CompleteOptions, Completion, Provider, ToolCall, ToolDef, Usage } from '../types.ts'

export function toOpenAITools(tools: ToolDef[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
}

type Msg = Record<string, unknown>

/** Neutral transcript → chat `messages`. A tool message can only carry text,
 *  so a screenshot follows as a user message with an `image_url` part —
 *  after ALL the tool messages of that turn (the API wants them contiguous). */
export function toOpenAIMessages(system: string, messages: ChatMsg[]): Msg[] {
  const out: Msg[] = [{ role: 'system', content: system }]
  let lastTool = -1
  messages = resolveSummaries(messages)
  messages.forEach((m, i) => { if (m.role === 'tool') lastTool = i })
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      out.push(m.images?.length
        ? { role: 'user', content: [{ type: 'text', text: m.text }, ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } }))] }
        : { role: 'user', content: m.text })
    }
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
      })
    } else if (m.role === 'tool') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.text || (r.isError ? 'Error' : 'OK') })
      if (i === lastTool) {
        const parts: Msg[] = []
        for (const r of m.results) {
          for (const img of r.images) parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } })
        }
        if (parts.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot(s) from the tool call(s) above:' }, ...parts] })
      }
    }
  })
  return out
}

/** Servers that rejected `stream_options` (remembered per base URL). */
const noStreamOptions = new Set<string>()

const isStreamOptionsReject = (e: unknown): boolean => {
  const err = e as { status?: number; message?: string }
  return err?.status === 400 && /stream_options/i.test(err.message ?? '')
}

export const openaiProvider: Provider = {
  async complete(o: CompleteOptions): Promise<Completion> {
    const client = new OpenAI({ baseURL: o.baseUrl, apiKey: o.apiKey ?? 'none', maxRetries: 1 })
    let host = ''
    try { host = new URL(o.baseUrl).hostname } catch { /* leave empty */ }
    // OpenAI's newer models reject max_tokens; compatible servers only know it.
    const limit = host === 'api.openai.com' ? { max_completion_tokens: o.maxTokens } : { max_tokens: o.maxTokens }
    const run = async (withUsage: boolean): Promise<Completion> => {
      const stream = await client.chat.completions.create({
        model: o.model,
        messages: toOpenAIMessages(o.system, o.images === false ? withoutImages(o.messages) : o.messages) as never,
        ...(o.tools.length ? { tools: toOpenAITools(o.tools) as never } : {}),
        stream: true,
        ...(withUsage ? { stream_options: { include_usage: true } } : {}),
        ...(o.reasoning ? { reasoning_effort: o.reasoning } : {}),
        ...limit,
      }, { signal: o.signal })
      let text = ''
      let finish: string | null = null
      let usage: Usage | undefined
      const calls = new Map<number, { id: string; name: string; args: string }>()
      for await (const chunk of stream) {
        const u = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null }).usage
        if (u && typeof u.prompt_tokens === 'number') {
          const cached = u.prompt_tokens_details?.cached_tokens ?? 0
          usage = { input: Math.max(0, u.prompt_tokens - cached), output: u.completion_tokens ?? 0, cacheRead: cached, cacheWrite: 0 }
        }
        const choice = chunk.choices?.[0]
        if (!choice) continue
        const delta = choice.delta as { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
        // Reasoning has no standard field: vLLM/LiteLLM/DeepSeek send `reasoning_content`, some servers `reasoning`.
        const thought = delta.reasoning_content || delta.reasoning
        if (thought) o.onThinking?.(thought)
        if (delta.content) { text += delta.content; o.onText(delta.content) }
        for (const tc of delta.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          calls.set(tc.index, cur)
        }
        if (choice.finish_reason) finish = choice.finish_reason
      }
      const toolCalls: ToolCall[] = []
      for (const [index, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        toolCalls.push(...toolCallsFrom(c.id || `call_${index}_${Date.now()}`, c.name, c.args))
      }
      return { text, toolCalls, truncated: finish === 'length', ...(usage ? { usage } : {}) }
    }
    if (noStreamOptions.has(o.baseUrl)) return run(false)
    try { return await run(true) } catch (e) {
      if (!isStreamOptionsReject(e)) throw e
      noStreamOptions.add(o.baseUrl)
      return run(false)
    }
  },
}
