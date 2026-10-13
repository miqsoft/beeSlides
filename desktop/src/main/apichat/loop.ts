// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The agent loop: (compact if the context is nearly full →) stream a
// completion → run its tool calls → append the results → repeat until the
// model stops calling tools (or the cap / a Stop). `runAgent` is the reusable
// core: the chat's request and every subagent run through it.
import { COMPACT_AT, compactConversation, type SummarizerModel } from './compact.ts'
import { elideOldResults } from './elide.ts'
import { estimateTokens, contextTokens } from './tokens.ts'
import type { ChatEvent, ChatMsg, Provider, ReasoningEffort, ToolCall, ToolDef, ToolResult, Usage } from './types.ts'

export const MAX_TURNS = 40
/** How many `task` calls of one turn run at the same time. */
export const MAX_PARALLEL_TASKS = 4
export const TASK_TOOL_NAME = 'task'

/** What a loop runs ON: model, its capabilities and what it is offered. */
export type ModelDeps = Pick<LoopDeps, 'provider' | 'baseUrl' | 'model' | 'maxTokens' | 'reasoning' | 'apiKey' | 'images' | 'system' | 'tools' | 'contextWindow'>

export interface LoopDeps {
  provider: Provider
  baseUrl: string
  model: string
  maxTokens: number
  /** Reasoning effort to ask the model for (undefined: the server's default). */
  reasoning?: ReasoningEffort
  apiKey?: string
  /** false: a text-only model (no screenshots are sent). */
  images?: boolean
  system: string
  tools: ToolDef[]
  /** Model context window; compaction starts at 75 % of it. */
  contextWindow: number
  /** Runs one tool; throws on transport failure. */
  runTool: (call: ToolCall, signal: AbortSignal) => Promise<Omit<ToolResult, 'id' | 'name'>>
  /** The line describing the current selection (null: none to attach). */
  digest: () => string | null
  messages: ChatMsg[]
  /** Receives the messages compaction removes. */
  archive?: ChatMsg[]
  emit: (ev: ChatEvent) => void
  /** Called whenever `messages` changed, to persist the transcript. */
  changed: () => void
  maxTurns?: number
  /** `task` calls of one turn that run at the same time (default MAX_PARALLEL_TASKS). */
  maxParallelTasks?: number
  /** Last known context size; owned by the caller so it survives across requests. */
  ctx?: { tokens?: number }
  /** `task` subagents run on this instead (Settings ▸ AI ▸ Advanced). */
  subagentModel?: ModelDeps
  /** Compaction summaries are written by this instead. */
  summarizer?: SummarizerModel
  /** After each completion: what the provider reported (if anything) and the context size now. */
  onUsage?: (usage: Usage | undefined, contextTokens: number, fromChild?: boolean) => void
}

export type AgentOutcome =
  /** `thinkingTokens`: a guess at how much the model reasoned (0 if it streamed none);
   *  `outputTokens`: what the provider billed for the reply, when it says. */
  | { kind: 'done'; text: string; truncated: boolean; thinkingTokens: number; outputTokens?: number }
  | { kind: 'capped'; text: string; cap: number }
  | { kind: 'stopped' }
  | { kind: 'error'; message: string }

/** Chars/4, like tokens.ts. */
const thoughtTokens = (chars: number): number => Math.ceil(chars / 4)

export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Runs `fns` with at most `limit` in flight; results keep the input order. */
async function pool<T>(fns: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out = new Array<T>(fns.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < fns.length) { const i = next++; out[i] = await fns[i]() }
  }
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker))
  return out
}

/** Runs the model/tool loop on `deps.messages` until the model answers
 *  without tool calls. Never throws. */
export async function runAgent(deps: LoopDeps, signal: AbortSignal): Promise<AgentOutcome> {
  const cap = deps.maxTurns ?? MAX_TURNS
  const ctx = deps.ctx ?? {}
  let compactFailed = false
  let lastText = ''
  for (let turn = 0; turn < cap; turn++) {
    if (signal.aborted) return { kind: 'stopped' }
    // Old reads first: cheaper than a summary, and often enough on its own.
    if (elideOldResults(deps.messages) > 0) {
      deps.changed()
      ctx.tokens = undefined
    }
    const size = ctx.tokens ?? estimateTokens(deps.system, deps.messages)
    if (!compactFailed && size > COMPACT_AT * deps.contextWindow) {
      try {
        if (await compactConversation(deps, undefined, signal)) {
          ctx.tokens = undefined
          deps.onUsage?.(undefined, estimateTokens(deps.system, deps.messages))
        }
      } catch (e) {
        if (signal.aborted) return { kind: 'stopped' }
        compactFailed = true
        deps.emit({ type: 'error', message: `Could not compact the conversation: ${errMessage(e)}` })
      }
    }
    let partial = ''
    let thoughtChars = 0
    let completion
    try {
      completion = await deps.provider.complete({
        baseUrl: deps.baseUrl, model: deps.model, maxTokens: deps.maxTokens, apiKey: deps.apiKey,
        system: deps.system, tools: deps.tools, messages: deps.messages, signal, images: deps.images,
        reasoning: deps.reasoning,
        onText: (t) => { partial += t; deps.emit({ type: 'text-delta', text: t }) },
        onThinking: (t) => { thoughtChars += t.length; deps.emit({ type: 'thinking', text: t }) },
      })
    } catch (e) {
      if (signal.aborted) {
        if (partial) { deps.messages.push({ role: 'assistant', text: partial, toolCalls: [] }); deps.changed() }
        return { kind: 'stopped' }
      }
      return { kind: 'error', message: errMessage(e) }
    }
    // A reply with neither text nor tool calls (a model that spent its budget
    // thinking) is not stored: an empty assistant message is invalid on the next request.
    const empty = !completion.text && completion.toolCalls.length === 0
    if (!empty) {
      deps.messages.push({ role: 'assistant', text: completion.text, toolCalls: completion.toolCalls })
      deps.changed()
    }
    // What this call read; the next one reads at least that much.
    ctx.tokens = completion.usage ? contextTokens(completion.usage) : undefined
    deps.onUsage?.(completion.usage, ctx.tokens ?? estimateTokens(deps.system, deps.messages))
    if (completion.text) lastText = completion.text
    if (completion.toolCalls.length === 0) {
      return { kind: 'done', text: completion.text, truncated: completion.truncated, thinkingTokens: thoughtTokens(thoughtChars), ...(completion.usage ? { outputTokens: completion.usage.output } : {}) }
    }

    const calls = completion.toolCalls
    const results = new Array<ToolResult>(calls.length)
    const exec = async (i: number): Promise<void> => {
      const call = calls[i]
      if (signal.aborted) { results[i] = { id: call.id, name: call.name, text: 'Cancelled by the user.', images: [], isError: true }; return }
      deps.emit({ type: 'tool-start', id: call.id, name: call.name, args: call.args })
      let r: Omit<ToolResult, 'id' | 'name'>
      try { r = await deps.runTool(call, signal) } catch (e) {
        r = { text: signal.aborted ? 'Cancelled by the user.' : `Error: ${errMessage(e)}`, images: [], isError: true }
      }
      results[i] = { id: call.id, name: call.name, ...r }
      deps.emit({ type: 'tool-end', id: call.id, text: r.text, images: r.images, isError: r.isError })
    }
    // Ordinary tools run in order; the subagent tasks of the turn then run side by side.
    for (let i = 0; i < calls.length; i++) if (calls[i].name !== TASK_TOOL_NAME) await exec(i)
    const taskIdx = calls.map((c, i) => (c.name === TASK_TOOL_NAME ? i : -1)).filter((i) => i >= 0)
    await pool(taskIdx.map((i) => () => exec(i)), deps.maxParallelTasks ?? MAX_PARALLEL_TASKS)
    deps.messages.push({ role: 'tool', results })
    deps.changed()
  }
  return signal.aborted ? { kind: 'stopped' } : { kind: 'capped', text: lastText, cap }
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))

/** Runs the loop and tells the panel how it ended. */
async function settle(deps: LoopDeps, signal: AbortSignal): Promise<void> {
  deps.emit({ type: 'busy', busy: true })
  try {
    const o = await runAgent(deps, signal)
    if (o.kind === 'error') deps.emit({ type: 'error', message: o.message })
    else if (o.kind === 'stopped') deps.emit({ type: 'done', stopped: true })
    else if (o.kind === 'capped') deps.emit({ type: 'error', message: `Stopped after ${o.cap} steps; ask me to continue if there is more to do.` })
    else {
      if (!o.text.trim() && o.truncated) {
        // Reasoning models spend their thinking from the output budget; more budget only lets a loop run longer.
        const used = o.outputTokens ?? o.thinkingTokens
        const spent = used > 0 ? `its whole output budget (about ${fmtTokens(used)} tokens)` : 'its whole output budget'
        const lower = deps.reasoning !== 'low'
        deps.emit({
          type: 'error',
          message: `The model used ${spent} thinking and never answered. Raising "Max tokens" only lets it think longer; ${lower ? 'try again at lower reasoning, or set Reasoning to Low in the profile.' : 'rephrase the request or pick a model that reasons less.'}`,
          ...(lower ? { retry: { effort: 'low' as const } } : {}),
        })
      } else if (o.truncated) deps.emit({ type: 'error', message: 'The answer was cut off at the output limit (raise "Max tokens" in the profile).' })
      deps.emit({ type: 'done' })
    }
  } finally {
    deps.emit({ type: 'busy', busy: false })
  }
}

/** One user request, run to completion. Never throws: failures become an
 *  `error` event, a Stop becomes `done {stopped}`. `shown` is what the user
 *  typed when `userText` is an expansion of it (a skill). */
export async function runRequest(deps: LoopDeps, userText: string, signal: AbortSignal, shown: string = userText): Promise<void> {
  const digest = deps.digest()
  deps.messages.push({ role: 'user', text: digest ? `${digest}\n\n${userText}` : userText, shown })
  deps.emit({ type: 'user', text: shown })
  deps.changed()
  await settle(deps, signal)
}

/** Runs the unanswered end of the transcript again (after an empty turn),
 *  typically with another `deps.reasoning`. */
export const retryRequest = settle
