// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The comment verbs of the agent-action channel (editor.ts applyAgentAction
// → ./index.ts AGENT_VERBS): the agent's one comment write (resolve_comment)
// and the user's own writes from the Claude Code plugin pane (pane_comment).
// Comments are slide metadata, not layout: plain store.commit, no guard.
import { t } from '../../i18n'
import { uid } from '../../model'
import { commentAuthor } from '../comments'
import { actionToast } from '../templatewindow'
import type { AgentVerbHandler } from './context'

export const COMMENT_VERBS = {
  resolve_comment: (ctx, cmd) => {
    const { args, respond } = cmd
    // The agent's ONLY comment write: closes a thread (+ optional reply).
    // Plain store.commit — comments are slide metadata, not layout, so no
    // guard/lock; one undo step.
    const commentId = typeof args.commentId === 'string' ? args.commentId : ''
    const owner = ctx.store.doc.slides.find((s) => s.comments?.some((c) => c.id === commentId))
    if (!owner) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-comment' }); return }
    const reply = typeof args.reply === 'string' ? args.reply.trim().slice(0, 2000) : ''
    ctx.store.commit(() => {
      const live = owner.comments!.find((c) => c.id === commentId)!
      if (reply) live.replies = [...(live.replies ?? []), { id: uid('cmt'), author: 'Claude', text: reply, at: new Date().toISOString() }]
      // resolved + agentDone together: old viewers / `comments {resolved:false}`
      // see a plain resolved thread, the user gets a "check" state
      live.resolved = true
      live.agentDone = new Date().toISOString()
    })
    ctx.canvas.refreshComments()
    actionToast(t('Claude finished a comment'), t('Check'), () => {
      const i = ctx.store.doc.slides.indexOf(owner)
      if (i < 0) return
      ctx.store.goTo(i)
      ctx.canvas.openCommentThread(commentId)
    })
    respond({ requestId: cmd.requestId, ok: true, commentId })
    return
  },
  pane_comment: (ctx, cmd) => {
    const { args, slideId, elementId, respond } = cmd
    // The USER's comment writes from the BeeSlides pane of the Claude Code
    // plugin (desktop/src/mcp/claude-mod): the MCP server takes the verb
    // but never lists it, so the model cannot call it and the agent's own
    // comment verb stays resolve_comment alone. add = a new thread on the
    // slide (or one of its elements) flagged for the agent; accept /
    // reopen = the thread footer's two buttons on a thread Claude
    // finished (reopen with the user's reply).
    const op = args.op
    const text = typeof args.text === 'string' ? args.text.trim().slice(0, 2000) : ''
    const at = new Date().toISOString()
    if (op === 'add') {
      const slide = slideId ? ctx.store.doc.slides.find((s) => s.id === slideId) : undefined
      if (!slide) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide' }); return }
      if (!text) { respond({ requestId: cmd.requestId, ok: false, error: 'empty' }); return }
      if (elementId && !slide.elements.some((el) => el.id === elementId)) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-element' }); return }
      const id = uid('cmt')
      ctx.store.commit(() => {
        slide.comments = [...(slide.comments ?? []), { id, ...(elementId ? { elementId } : {}), author: commentAuthor(), text, at, forAgent: true }]
      })
      ctx.canvas.refreshComments()
      respond({ requestId: cmd.requestId, ok: true, commentId: id })
      return
    }
    if (op !== 'accept' && op !== 'reopen') { respond({ requestId: cmd.requestId, ok: false, error: 'op must be add, accept or reopen.' }); return }
    const commentId = typeof args.commentId === 'string' ? args.commentId : ''
    const owner = ctx.store.doc.slides.find((s) => s.comments?.some((c) => c.id === commentId))
    if (!owner) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-comment' }); return }
    ctx.store.commit(() => {
      const live = owner.comments!.find((c) => c.id === commentId)!
      delete live.agentDone
      if (op === 'reopen') {
        delete live.resolved
        if (text) live.replies = [...(live.replies ?? []), { id: uid('cmt'), author: commentAuthor(), text, at }]
      }
    })
    ctx.canvas.refreshComments()
    respond({ requestId: cmd.requestId, ok: true, commentId })
    return
  },
} satisfies Record<string, AgentVerbHandler>
