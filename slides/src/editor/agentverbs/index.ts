// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The agent-action channel's single verbs (desktop slides-mcp-server.mjs's
// agent-action tools, forwarded to editor.ts applyAgentAction) as one table,
// verb → handler. applyAgentAction keeps the gates every verb shares
// (encryption, read-only) and the grouped area tools (agentops.ts); every
// other verb is looked up here. A handler answers through `cmd.respond` and
// reaches the editor only through AgentVerbContext (./context.ts).
import { t } from '../../i18n'
import type { AgentCall, AgentVerbContext, AgentVerbHandler } from './context'
import { ELEMENT_VERBS } from './elements'
import { SLIDE_TYPE_VERBS } from './slidetypes'
import { COMMENT_VERBS } from './comments'

export type { AgentCall, AgentRespond, AgentVerbContext } from './context'

const OTHER_VERBS = {
  program: (ctx, cmd) => {
    const { args, respond } = cmd
    // An agent program (the `execute` tool, desktop agentexec.ts) brackets its
    // calls: every edit between begin and commit is ONE undo step, and a
    // program that fails is rolled back whole.
    const op = args.op
    if (op === 'begin') ctx.store.beginUndoGroup()
    else if (op === 'commit') {
      ctx.store.endUndoGroup()
      if (args.changed) ctx.toast(t('AI ran a program on this deck (one undo step)'))
    } else if (op === 'rollback') {
      if (!ctx.store.rollbackUndoGroup()) { respond({ requestId: cmd.requestId, ok: false, error: 'An undo since the program started: nothing was rolled back.' }); return }
    } else { respond({ requestId: cmd.requestId, ok: false, error: 'op must be begin, commit or rollback.' }); return }
    respond({ requestId: cmd.requestId, ok: true })
    return
  },
  propose_variants: (ctx, cmd) => {
    const { args, slideId, respond, lockError } = cmd
    // NOT a store.commit — nothing here touches store.doc or the undo
    // stack. Candidates preview from Editor.pendingVariants (see
    // getPendingVariants/variantpicker.ts) until the human picks one via
    // applyVariant, which is the ONLY path that commits anything.
    if (!slideId) { respond({ requestId: cmd.requestId, ok: false, error: 'Missing slideId.' }); return }
    const targetSlide = ctx.store.doc.slides.find((s) => s.id === slideId)
    if (!targetSlide) { respond({ requestId: cmd.requestId, ok: false, error: 'no-such-slide' }); return }
    { const err = lockError(slideId); if (err) { respond({ requestId: cmd.requestId, ok: false, error: err }); return } }
    void ctx.proposeVariants(slideId, args).then((r) => respond({ requestId: cmd.requestId, ...r }))
    return
  },
  release_slide: (_ctx, cmd) => {
    const { respond } = cmd
    // Obsolete (locks no longer exclude anyone); kept as a harmless no-op
    // for sessions started before the change.
    respond({ requestId: cmd.requestId, ok: true })
    return
  },
} satisfies Record<string, AgentVerbHandler>

/** Every single verb applyAgentAction answers (the area tools aside). */
export const AGENT_VERBS = { ...ELEMENT_VERBS, ...SLIDE_TYPE_VERBS, ...COMMENT_VERBS, ...OTHER_VERBS }
export type AgentVerb = keyof typeof AGENT_VERBS

/** Run `cmd.verb`'s handler; an unknown verb is answered here. */
export function runAgentVerb(ctx: AgentVerbContext, cmd: AgentCall): void {
  const handler = cmd.verb !== undefined && Object.hasOwn(AGENT_VERBS, cmd.verb) ? AGENT_VERBS[cmd.verb as AgentVerb] : undefined
  if (!handler) { cmd.respond({ requestId: cmd.requestId, ok: false, error: `Unknown verb: ${cmd.verb}` }); return }
  handler(ctx, cmd)
}
