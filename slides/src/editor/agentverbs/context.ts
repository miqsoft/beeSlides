// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// What an agent-action verb handler (./index.ts AGENT_VERBS) gets to work
// with: the one call it answers, and the few editor internals it needs. The
// editor builds the context (editor.ts agentVerbContext); nothing else of
// the Editor is reachable from a handler.
import { resolveAgentSlide, type Slide, type SlideElement, type SlidomingoDoc } from '../../model'
import type { GuardResult } from '../../layoutguard'
import type { Finding } from '../../validate'
import type { Store } from '../../store'
import type { SlideCanvas } from '../canvas'

/** Answers the call (desktop sendAgentActionResult); exactly once per call. */
export type AgentRespond = (result: Record<string, unknown> & { requestId: string; ok: boolean }) => void

/** One agent-action call, as editor.ts applyAgentAction read it. */
export interface AgentCall {
  requestId: string
  verb?: string
  args: Record<string, unknown>
  /** `args.slideId` / `args.elementId` when they are strings. */
  slideId?: string
  elementId?: string
  respond: AgentRespond
  /** Records this session as the slide's latest writer for the sidebar badge;
   *  never refuses (several sessions may share a slide). Always returns null. */
  lockError(sid: string): string | null
}

/** The editor, as the verb handlers see it. */
export interface AgentVerbContext {
  store: Store
  /** Comment pins and threads on the canvas (the comment verbs). */
  canvas: Pick<SlideCanvas, 'refreshComments' | 'openCommentThread'>
  toast(message: string): void
  /** Editor.commitAgentWrite: one undo step with the layout guard; its
   *  result waits in layoutReport() for the response. */
  commitAgentWrite(slideId: string, mutate: () => void, event?: Parameters<Store['commit']>[1], opts?: { reflow?: boolean; guard?: boolean; placed?: boolean }): void
  /** `{ layout }` for a write response (Editor.layoutReport). */
  layoutReport(): { layout?: GuardResult }
  /** Editor.warningsForSlide: the touched slide's validateDoc findings. */
  warningsForSlide(sid: string): Finding[]
  /** Editor.agentInsertElements: element specs through the paste pipeline, as one agent write. */
  insertElements(slideId: string, specs: unknown, assets: unknown, opts: { nudge: boolean; reflow?: boolean; fonts?: unknown }): { added: SlideElement[] } | { error: string }
  /** Editor.proposeVariants: builds the candidates, stores them as the pending set. */
  proposeVariants(slideId: string, args: Record<string, unknown>): Promise<{ ok: boolean; [k: string]: unknown }>
}

export type AgentVerbHandler = (ctx: AgentVerbContext, cmd: AgentCall) => void

/** Find one element addressed by an EXPLICIT slideId — unlike
 *  applyExternalEdit's cross-slide-by-id search, every agent-action verb
 *  always carries the slide it means, so there is no ambiguity to resolve. */
export function findAgentTarget(doc: SlidomingoDoc, slideId: string, elementId: string): { slide: Slide; el: SlideElement; idx: number } | null {
  const resolved = resolveAgentSlide(doc, slideId)
  if (!resolved) return null
  const idx = resolved.slide.elements.findIndex((e) => e.id === elementId)
  if (idx < 0) return null
  return { slide: resolved.slide, el: resolved.slide.elements[idx], idx }
}
