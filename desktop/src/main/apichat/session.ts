// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// One API chat tab: an MCP client on the chat's session folder, the neutral
// message list, the display list the panel replays, and the loop.
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ApiProfile } from '../aiprofiles.ts'
import { digest } from '../../mcp/selection-digest.mjs'
import { compactConversation } from './compact.ts'
import { FILE_TOOL_NAMES, FILE_TOOLS, foldersNote, runFileTool } from './filetools.ts'
import { errMessage, retryRequest, runRequest, TASK_TOOL_NAME, type LoopDeps, type ModelDeps } from './loop.ts'
import { McpClient } from './mcp.ts'
import { apiSystemPrompt, READ_REFERENCE_TOOL, REFERENCE_NAMES } from './prompt.ts'
import { knownTextOnly } from './providers/images.ts'
import { providerFor } from './providers/index.ts'
import { DEFAULT_MAX_TOKENS } from './providers/outputcap.ts'
import { expandSlash, loadUserSkills, mergeSkills, readSkill, USE_SKILL_TOOL, type Skill } from './skills.ts'
import { runSubagent, TASK_TOOL } from './subagent.ts'
import { DEFAULT_CONTEXT_WINDOW, estimateTokens } from './tokens.ts'
import { loadTranscript, saveTranscript } from './transcript.ts'
import type { ChatEvent, ChatMsg, Provider, ReasoningEffort, ToolDef, ToolImage, ToolResult } from './types.ts'
import { LOOK_TOOL, LOOK_TOOL_NAME, visionPrompt, type VisionHelper } from './vision.ts'

/** Tools that drive the one shared editor canvas (they navigate it), so they
 *  never run at the same time — a subagent's screenshot must not catch the
 *  slide another one just switched to. */
const CANVAS_TOOLS = new Set(['review_slide', 'render_preview'])

/** Tools whose whole answer is an image: useless to a text-only model. */
const IMAGE_ONLY_TOOLS = new Set(['render_preview'])

class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.catch(() => {})
    return result
  }
}

export type UsageReadout = Extract<ChatEvent, { type: 'usage' }>

/** What the panel renders — rebuilt from `messages` on resume, kept live from events. */
export type DisplayItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  /** Reasoning the model streamed: the exact size, only the TAIL of the text is kept (THINKING_KEEP). */
  | ThinkingItem
  | ToolItem
  /** A divider, e.g. where the conversation was compacted. */
  | { kind: 'note'; text: string }

export interface ThinkingItem {
  kind: 'thinking'; text: string; chars: number; startedAt: number
  /** Last delta − first; the panel shows "Thought for Ns". */
  ms: number
  /** Still taking deltas (nothing else has happened since). */
  open: boolean
}

/** Characters of a thought kept for the panel: enough to recognise a loop, not 50k tokens of it. */
export const THINKING_KEEP = 4000

export interface ToolItem {
  kind: 'tool'; id: string; name: string; args: Record<string, unknown>; done: boolean; text?: string; images?: ToolImage[]; isError?: boolean
  /** A `task` row: the tool calls its subagent made. */
  children?: ToolItem[]
}

/** Another API profile doing part of the work (Settings ▸ AI ▸ Advanced). */
export interface RoleModel { profile: ApiProfile; apiKey?: string; /** Test seam. */ provider?: Provider }

export interface SessionRoles {
  subagent?: RoleModel
  summary?: RoleModel
  /** look_at_slide's eyes, offered to a text-only model. */
  vision?: VisionHelper
}

export interface ApiSessionOptions {
  chatId: string
  profile: ApiProfile
  apiKey?: string
  /** The session folder (`<contextDir>/session-<id>`) the MCP server works in. */
  sessionDir: string
  /** The window's shared context dir: selection.json, format.md, agents.md, the server script. */
  sharedDir: string
  transcriptDir: string
  /** userData/api-skills: the user's own skills (re-scanned on every send). */
  skillsDir?: string
  /** The skills that ship with the app (skills/index.ts). */
  builtinSkills?: Skill[]
  /** Test seam; defaults to the profile's wire. */
  provider?: Provider
  /** Test seam: skip spawning the MCP server. Also how a `purpose` session
   *  gets its own, smaller tool set (customizechat.ts). */
  tools?: { defs: ToolDef[]; call: McpClient['callTool'] }
  /** `customize`: Settings ▸ Customize's chat — the given `system` prompt, only
   *  the `tools` given (no reference/skill/subagent tools), no deck. */
  purpose?: 'customize'
  /** Replaces the deck-editing system prompt. */
  system?: string
  /** Replaces the selection.json digest (the renderer sends its own). */
  digest?: () => string | null
  /** Other models for subagents, summaries and image checks. */
  roles?: SessionRoles
  /** The folders the user attached to this deck (attachedfolders.ts), read live
   *  on every send: while any exist the chat gets read-only file tools. */
  folders?: () => string[]
}

export function displayFromMessages(messages: ChatMsg[]): DisplayItem[] {
  const out: DisplayItem[] = []
  const byId = new Map<string, ToolItem>()
  for (const m of messages) {
    if (m.role === 'summary') out.push({ kind: 'note', text: 'Conversation compacted' })
    else if (m.role === 'user') out.push({ kind: 'user', text: m.shown ?? m.text })
    else if (m.role === 'assistant') {
      if (m.text) out.push({ kind: 'assistant', text: m.text })
      for (const c of m.toolCalls) {
        const item: ToolItem = { kind: 'tool' as const, id: c.id, name: c.name, args: c.args, done: false }
        byId.set(c.id, item)
        out.push(item)
      }
    } else {
      for (const r of m.results) {
        const item = byId.get(r.id)
        if (item) Object.assign(item, { done: true, text: r.text, isError: r.isError })
      }
    }
  }
  return out
}

export class ApiChatSession {
  readonly chatId: string
  readonly profile: ApiProfile
  display: DisplayItem[]
  busy = false
  /** The last readout the panel was sent (restored by sync()). */
  lastUsage: UsageReadout | null = null
  private messages: ChatMsg[]
  private archive: ChatMsg[]
  private ctx: { tokens?: number } = {}
  private totalTokens = 0
  /** Whether a subagent has run — only then is a session total worth showing. */
  private hadChildren = false
  private canvas = new Mutex()
  private mcp: McpClient | null = null
  private tools: ToolDef[] = []
  private callTool: McpClient['callTool'] | null = null
  private abort: AbortController | null = null
  private listeners = new Set<(ev: ChatEvent) => void>()
  private ready: Promise<void>

  private o: ApiSessionOptions

  constructor(o: ApiSessionOptions, resume: boolean) {
    this.o = o
    this.chatId = o.chatId
    this.profile = o.profile
    const t = resume ? loadTranscript(o.transcriptDir, o.chatId) : null
    this.messages = t?.messages ?? []
    this.archive = t?.archive ?? []
    this.display = displayFromMessages([...this.archive, ...this.messages])
    this.ready = this.init()
    this.ready.catch(() => { /* surfaced on the first send */ })
  }

  private async init(): Promise<void> {
    if (this.o.tools) {
      this.tools = this.o.tools.defs
      this.callTool = this.o.tools.call
    } else {
      this.mcp = new McpClient(join(this.o.sharedDir, 'slides-mcp-server.mjs'), this.o.sessionDir)
      this.tools = await this.mcp.start()
      this.callTool = this.mcp.callTool.bind(this.mcp)
    }
    if (this.o.purpose !== 'customize') this.tools = [...this.tools, READ_REFERENCE_TOOL, USE_SKILL_TOOL, TASK_TOOL]
  }

  onEvent(cb: (ev: ChatEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(ev: ChatEvent): void {
    this.track(ev)
    for (const cb of this.listeners) cb(ev)
  }

  /** Keeps `display` equal to what the panel shows, for a rebuilt view. */
  private track(ev: ChatEvent): void {
    const last = this.display[this.display.length - 1]
    if (last?.kind === 'thinking' && last.open && ev.type !== 'thinking' && ev.type !== 'usage') { last.open = false; last.ms = Date.now() - last.startedAt }
    if (ev.type === 'thinking') {
      const now = Date.now()
      const t = last?.kind === 'thinking' && last.open ? last : null
      if (t) {
        t.chars += ev.text.length
        t.text = (t.text + ev.text).slice(-THINKING_KEEP)
        t.ms = now - t.startedAt
      } else this.display.push({ kind: 'thinking', text: ev.text.slice(-THINKING_KEEP), chars: ev.text.length, startedAt: now, ms: 0, open: true })
    } else if (ev.type === 'user') this.display.push({ kind: 'user', text: ev.text })
    else if (ev.type === 'text-delta') {
      if (last?.kind === 'assistant') last.text += ev.text
      else this.display.push({ kind: 'assistant', text: ev.text })
    } else if (ev.type === 'tool-start') {
      const item: ToolItem = { kind: 'tool', id: ev.id, name: ev.name, args: ev.args, done: false }
      if (ev.parent) {
        const task = this.display.find((d): d is ToolItem => d.kind === 'tool' && d.id === ev.parent)
        if (task) (task.children ??= []).push(item)
      } else this.display.push(item)
    } else if (ev.type === 'tool-end') {
      const owner = ev.parent ? this.display.find((d): d is ToolItem => d.kind === 'tool' && d.id === ev.parent)?.children : this.display
      const item = owner?.find((d) => d.kind === 'tool' && d.id === ev.id)
      if (item?.kind === 'tool') Object.assign(item, { done: true, text: ev.text, images: ev.images, isError: ev.isError })
    } else if (ev.type === 'compacted') this.display.push({ kind: 'note', text: 'Conversation compacted' })
    else if (ev.type === 'usage') this.lastUsage = ev
    else if (ev.type === 'busy') this.busy = ev.busy
  }

  private readReference(name: unknown): string {
    if (typeof name !== 'string' || !(REFERENCE_NAMES as readonly string[]).includes(name)) return `Error: name must be one of ${REFERENCE_NAMES.join(', ')}.`
    try { return readFileSync(join(this.o.sharedDir, name), 'utf8') } catch { return `Error: ${name} is not available.` }
  }

  private selectionDigest(): string | null {
    try { return digest(JSON.parse(readFileSync(join(this.o.sharedDir, 'selection.json'), 'utf8')), basename(this.o.sessionDir).replace(/^session-/, '')) } catch { return null }
  }

  private skills(): Skill[] {
    return mergeSkills(this.o.builtinSkills ?? [], this.o.skillsDir ? loadUserSkills(this.o.skillsDir) : [])
  }

  private attachedFolders(): string[] {
    return this.o.purpose ? [] : (this.o.folders?.() ?? [])
  }

  private contextWindow(): number {
    return this.o.profile.contextWindow ?? DEFAULT_CONTEXT_WINDOW[this.o.profile.wire]
  }

  private save(): void {
    saveTranscript(this.o.transcriptDir, this.chatId, { version: 2, profileId: this.o.profile.id, messages: this.messages, archive: this.archive })
  }

  /** Tools the app handles itself; everything else goes to the MCP server. */
  private async runLocalTool(call: { id: string; name: string; args: Record<string, unknown> }, signal: AbortSignal, deps: LoopDeps, skills: Skill[]): Promise<Omit<ToolResult, 'id' | 'name'>> {
    if (call.name === READ_REFERENCE_TOOL.name) return { text: this.readReference(call.args.name), images: [], isError: false }
    if (call.name === USE_SKILL_TOOL.name) return { ...readSkill(skills, call.args.name, call.args.file), images: [] }
    if (call.name === TASK_TOOL_NAME) return runSubagent(deps, call, signal)
    if (call.name === LOOK_TOOL_NAME) return this.lookAtSlide(call.args, signal)
    if (FILE_TOOL_NAMES.has(call.name)) return { ...runFileTool(this.attachedFolders(), call.name, call.args), images: [] }
    const run = (): ReturnType<McpClient['callTool']> => this.callTool!(call.name, call.args, signal)
    return CANVAS_TOOLS.has(call.name) ? this.canvas.run(run) : run()
  }

  /** look_at_slide: review_slide's screenshot + element list, answered by the vision helper. */
  private async lookAtSlide(args: Record<string, unknown>, signal: AbortSignal): Promise<Omit<ToolResult, 'id' | 'name'>> {
    const vision = this.o.roles?.vision
    if (!vision) return { text: 'Error: no image-check model is set up for this profile.', images: [], isError: true }
    const slideId = typeof args.slideId === 'string' ? args.slideId : ''
    if (!slideId) return { text: 'Error: look_at_slide needs a slideId.', images: [], isError: true }
    const elementIds = Array.isArray(args.elementIds) ? args.elementIds.filter((v): v is string => typeof v === 'string') : []
    const shot = await this.canvas.run(() => this.callTool!('review_slide', elementIds.length ? { slideId, elementIds } : { slideId }, signal))
    if (shot.isError) return { ...shot, images: [] }
    const image = shot.images[0]
    if (!image) return { text: `Error: no screenshot of "${slideId}" (a slide type or reusable object must be open in the editor).`, images: [], isError: true }
    try {
      const answer = await vision.describe(image, visionPrompt(shot.text, typeof args.question === 'string' ? args.question : undefined), signal)
      // The picture stays in the result for the panel; the text-only wire drops it.
      return { text: `${vision.label} looked at slide "${slideId}":\n${answer}`, images: [image], isError: false }
    } catch (e) {
      return { text: signal.aborted ? 'Cancelled by the user.' : `Error: the image check failed: ${errMessage(e)}`, images: [], isError: true }
    }
  }

  /** Everything that depends on WHICH model a loop runs on: a text-only one
   *  gets no image-only tools, the numbers-based review rule and, with a
   *  vision helper, look_at_slide. */
  private modelDeps(p: ApiProfile, apiKey: string | undefined, provider: Provider, skills: Skill[], agents: string): ModelDeps {
    // Marked text-only, or found to be on an earlier request (providers/images.ts).
    const textOnly = !!p.textOnly || knownTextOnly(p.baseUrl, p.model)
    const vision = textOnly && !this.o.purpose && !!this.o.roles?.vision
    let tools = textOnly ? this.tools.filter((t) => !IMAGE_ONLY_TOOLS.has(t.name)) : this.tools
    if (vision) tools = [...tools, LOOK_TOOL]
    const folders = this.attachedFolders()
    if (folders.length) tools = [...tools, ...FILE_TOOLS]
    return {
      provider, baseUrl: p.baseUrl, model: p.model, maxTokens: p.maxTokens ?? DEFAULT_MAX_TOKENS, apiKey,
      ...(p.reasoning ? { reasoning: p.reasoning } : {}),
      images: !textOnly,
      system: this.o.system ?? apiSystemPrompt(agents, skills, { textOnly, vision }) + (folders.length ? `\n\n${foldersNote(folders)}` : ''),
      tools,
      contextWindow: p.contextWindow ?? DEFAULT_CONTEXT_WINDOW[p.wire],
    }
  }

  private makeDeps(skills: Skill[], agents: string): LoopDeps {
    const p = this.o.profile
    const roles = this.o.roles ?? {}
    const sub = roles.subagent
    const sum = roles.summary
    const deps: LoopDeps = {
      ...this.modelDeps(p, this.o.apiKey, this.o.provider ?? providerFor(p), skills, agents),
      contextWindow: this.contextWindow(),
      ...(p.maxParallelTasks ? { maxParallelTasks: p.maxParallelTasks } : {}),
      ...(sub ? { subagentModel: this.modelDeps(sub.profile, sub.apiKey, sub.provider ?? providerFor(sub.profile), skills, agents) } : {}),
      ...(sum ? { summarizer: { provider: sum.provider ?? providerFor(sum.profile), baseUrl: sum.profile.baseUrl, model: sum.profile.model, maxTokens: sum.profile.maxTokens ?? DEFAULT_MAX_TOKENS, apiKey: sum.apiKey } } : {}),
      runTool: (call, s) => this.runLocalTool(call, s, deps, skills),
      digest: () => (this.o.digest ? this.o.digest() : this.selectionDigest()),
      messages: this.messages,
      archive: this.archive,
      ctx: this.ctx,
      emit: (ev) => this.emit(ev),
      changed: () => this.save(),
      onUsage: (u, tokens, fromChild) => {
        if (u) this.totalTokens += u.input + u.output + u.cacheRead + u.cacheWrite
        if (fromChild) this.hadChildren = true
        const prev = this.lastUsage
        this.emit({
          type: 'usage',
          contextTokens: fromChild ? (prev?.contextTokens ?? 0) : tokens,
          contextWindow: this.contextWindow(),
          cacheRead: fromChild ? (prev?.cacheRead ?? 0) : (u?.cacheRead ?? 0),
          ...(this.hadChildren ? { totalTokens: this.totalTokens } : {}),
        })
      },
    }
    return deps
  }

  /** `/compact [focus]`: summarizes now, without a model turn. */
  private async compactNow(text: string, focus: string | undefined, deps: LoopDeps, signal: AbortSignal): Promise<void> {
    this.emit({ type: 'user', text })
    this.emit({ type: 'busy', busy: true })
    try {
      if (await compactConversation(deps, focus, signal)) {
        this.ctx.tokens = undefined
        deps.onUsage?.(undefined, estimateTokens(deps.system, this.messages))
        this.emit({ type: 'done' })
      } else {
        this.emit({ type: 'text-delta', text: 'Nothing to compact yet: the conversation is still short.' })
        this.emit({ type: 'done' })
      }
    } catch (e) {
      this.emit(signal.aborted ? { type: 'done', stopped: true } : { type: 'error', message: `Could not compact the conversation: ${errMessage(e)}` })
    } finally {
      this.emit({ type: 'busy', busy: false })
    }
  }

  /** Runs one user request; resolves when it is finished (events stream meanwhile). */
  async send(text: string): Promise<void> {
    if (this.busy || !text.trim()) return
    this.busy = true
    try { await this.ready } catch (e) {
      this.busy = false
      this.emit({ type: 'error', message: `Could not start the slides tools: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    const abort = new AbortController()
    this.abort = abort
    const agents = (() => { try { return readFileSync(join(this.o.sharedDir, 'agents.md'), 'utf8') } catch { return '' } })()
    const skills = this.skills()
    const deps = this.makeDeps(skills, agents)
    const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (compact) await this.compactNow(text.trim(), compact[1]?.trim() || undefined, deps, abort.signal)
    else await runRequest(deps, expandSlash(text, skills) ?? text, abort.signal, text)
    this.abort = null
  }

  /** After an empty turn (the model spent its budget thinking): runs the
   *  unanswered end of the conversation again, this time at `effort`. Only for
   *  this run; the profile keeps its own setting. */
  async retry(effort: ReasoningEffort): Promise<void> {
    const last = this.messages[this.messages.length - 1]
    if (this.busy || !last || (last.role !== 'user' && last.role !== 'tool')) return
    this.busy = true
    try { await this.ready } catch (e) {
      this.busy = false
      this.emit({ type: 'error', message: `Could not start the slides tools: ${errMessage(e)}` })
      return
    }
    const abort = new AbortController()
    this.abort = abort
    const agents = (() => { try { return readFileSync(join(this.o.sharedDir, 'agents.md'), 'utf8') } catch { return '' } })()
    await retryRequest({ ...this.makeDeps(this.skills(), agents), reasoning: effort }, abort.signal)
    this.abort = null
  }

  stop(): void { this.abort?.abort() }

  dispose(): void {
    this.abort?.abort()
    this.mcp?.dispose()
  }
}
