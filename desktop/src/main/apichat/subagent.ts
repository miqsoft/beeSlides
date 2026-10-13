// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Subagents: the `task` tool hands a self-contained job to a fresh context
// that has the same slide tools (but no `task`, so no nesting) and returns
// only its final report. Several `task` calls of one turn run in parallel
// (loop.ts); the shared editor canvas is guarded by a mutex (session.ts).
import { runAgent, TASK_TOOL_NAME, type LoopDeps } from './loop.ts'
import type { ToolCall, ToolResult } from './types.ts'

export const SUBAGENT_MAX_TURNS = 25

export const TASK_TOOL = {
  name: TASK_TOOL_NAME,
  description: 'Hand a self-contained piece of work to a subagent: a fresh context with the same slide tools that sees NOTHING of this chat. Its `prompt` must therefore carry everything it needs: the goal, the slide and element ids it owns, the style decisions and constraints, and what to report back. Give each subagent its own disjoint slides. Several task calls in one turn run in parallel; the result is the subagent\'s final report.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Three to six words naming the job (shown in the panel).' },
      prompt: { type: 'string', description: 'The complete, self-contained instructions for the subagent.' },
    },
    required: ['description', 'prompt'],
  },
}

export const SUBAGENT_PREAMBLE = [
  'You are a subagent working for another agent, not talking to the user. Do only the task below; do not redesign anything outside it, and stay inside the slides and ids it names (other subagents are editing the other slides at the same time).',
  'You cannot start subagents yourself. When you are done, end with a concise report of what you changed and anything left open — that report is all the other agent sees.',
].join('\n\n')

type RunTool = LoopDeps['runTool']

/** Runs one `task` call. `parent` supplies the provider, credentials, system
 *  prompt and tools; the child's tool events are forwarded tagged with the
 *  task call's id, its text is not. */
export async function runSubagent(parent: LoopDeps, call: ToolCall, signal: AbortSignal): Promise<Omit<ToolResult, 'id' | 'name'>> {
  const prompt = typeof call.args.prompt === 'string' ? call.args.prompt.trim() : ''
  if (!prompt) return { text: 'Error: task needs a non-empty prompt.', images: [], isError: true }
  const runTool: RunTool = (c, s) => (c.name === TASK_TOOL_NAME
    ? Promise.resolve({ text: 'Error: subagents cannot start subagents.', images: [], isError: true })
    : parent.runTool(c, s))
  const messages: LoopDeps['messages'] = [{ role: 'user', text: prompt, shown: prompt }]
  const model = parent.subagentModel ?? parent
  const child: LoopDeps = {
    ...parent,
    ...(parent.subagentModel ?? {}),
    subagentModel: undefined,
    system: `${model.system}\n\n${SUBAGENT_PREAMBLE}`,
    tools: model.tools.filter((t) => t.name !== TASK_TOOL_NAME),
    messages,
    archive: undefined,
    ctx: {},
    maxTurns: SUBAGENT_MAX_TURNS,
    runTool,
    digest: () => null,
    changed: () => {},
    emit: (ev) => {
      if (ev.type === 'tool-start' || ev.type === 'tool-end') parent.emit({ ...ev, parent: call.id })
    },
    // The parent's usage readout shows ITS context; the child only adds to the totals.
    onUsage: (u, tokens) => parent.onUsage?.(u, tokens, true),
  }
  const o = await runAgent(child, signal)
  if (o.kind === 'stopped') return { text: 'Cancelled by the user.', images: [], isError: true }
  if (o.kind === 'error') return { text: `Error: the subagent failed: ${o.message}`, images: [], isError: true }
  if (o.kind === 'capped') return { text: `The subagent hit its ${o.cap}-step limit before finishing. Its last words:\n${o.text || '(none)'}`, images: [], isError: false }
  return { text: o.text.trim() || '(the subagent finished without a report)', images: [], isError: false }
}
