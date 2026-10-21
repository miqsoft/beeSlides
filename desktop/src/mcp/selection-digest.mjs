// UserPromptSubmit hook for the terminal panel's `claude` sessions: prints a
// one-line digest of selection.json, which Claude Code attaches to the user's
// message as context. That replaces the "Read selection.json" tool call
// Claude used to spend a whole model turn on before every request.
//
// Bundled into desktop's main.js via a `?raw` import (terminalPanel.ts) and
// written into each window's shared contextDir next to selection.json; the
// session's settings.json runs it with a relative path. Node built-ins only.
// Any failure prints nothing and exits 0: a missing digest must never block
// the user's prompt (a UserPromptSubmit hook that fails or times out can).
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_ELEMENTS = 8
const MAX_TEXT = 80
const MAX_TYPES = 20
const MAX_NEARBY = 6

const q = (s) => JSON.stringify(String(s))
const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s)

/** "12s", "3m". */
const ago = (ms) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`)

/** One line describing selection.json; also imported by main's API chat loop
 *  (apichat/loop.ts), which has no hook to run it. `self` = this chat's
 *  session id: its own slides are left out of the "other chats" part. */
export function digest(ctx, self) {
  const s = ctx.surface ?? { kind: 'slide', id: ctx.slideId }
  const kind = s.kind === 'layout' ? 'slide type' : s.kind === 'reusableObject' ? 'reusable object' : 'slide'
  const parts = [`editing ${kind}${s.name ? ` ${q(s.name)}` : ''} id=${s.id}`]
  if (s.kind === 'layout' && s.parentId) parts[0] += ` parent=${s.parentId}`

  const sel = Array.isArray(ctx.selection) ? ctx.selection : []
  if (!sel.length) {
    parts.push(s.kind === 'layout' ? 'nothing selected (this = the whole slide type)' : 'nothing selected')
  } else {
    const items = sel.slice(0, MAX_ELEMENTS).map((e) => {
      const f = e.frame
      const frame = f ? ` @${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.w)}x${Math.round(f.h)}` : ''
      const role = e.role ? ` role=${e.role}` : ''
      const text = e.text ? ` ${q(clip(e.text))}` : ''
      return `${e.id} ${e.type}${role}${frame}${text}`
    })
    if (sel.length > MAX_ELEMENTS) items.push(`+${sel.length - MAX_ELEMENTS} more`)
    parts.push(`selected: ${items.join('; ')}`)
  }

  // What sits around the selection and the arrows ending on it, so an edit
  // to "this" can account for what it would bump into.
  const around = Array.isArray(ctx.neighbours) ? ctx.neighbours : []
  const arrows = around.filter((n) => n.type === 'connector')
  const nearby = around.filter((n) => n.type !== 'connector' && n.frame)
  if (nearby.length) {
    const items = nearby.slice(0, MAX_NEARBY).map((n) => {
      const f = n.frame
      return `${n.id} ${n.type} @${f.x},${f.y} ${f.w}x${f.h}`
    })
    if (nearby.length > MAX_NEARBY) items.push(`+${nearby.length - MAX_NEARBY} more`)
    parts.push(`nearby: ${items.join('; ')}`)
  }
  if (arrows.length) {
    parts.push(`arrows: ${arrows.map((a) => `${a.id} ${a.from ?? '·'}→${a.to ?? '·'}`).join('; ')}`)
  }

  if (Array.isArray(ctx.selectedSlideIds) && ctx.selectedSlideIds.length) {
    parts.push(`sorter-selected slides: ${ctx.selectedSlideIds.join(',')}`)
  }
  if (ctx.openAgentComments > 0) {
    parts.push(`${ctx.openAgentComments} open comment${ctx.openAgentComments > 1 ? 's' : ''} for Claude on this slide (comments tool)`)
  }
  if (Array.isArray(ctx.slideTypes) && ctx.slideTypes.length) {
    const types = ctx.slideTypes.slice(0, MAX_TYPES).map((t) => `${t.name ?? '(unnamed)'}=${t.id}`)
    if (ctx.slideTypes.length > MAX_TYPES) types.push(`+${ctx.slideTypes.length - MAX_TYPES} more (doc_info)`)
    parts.push(`slide types: ${types.join(', ')}`)
  }
  // Slides other chat tabs are writing in their current turn (the editor's
  // slide locks), so this one leaves them alone unless the user asks.
  const others = (Array.isArray(ctx.agentWork) ? ctx.agentWork : []).filter((w) => w && w.sessionId !== self)
  if (others.length) {
    const now = Date.now()
    const items = others.map((w) => {
      const at = Date.parse(w.at)
      return `${w.slideId}${w.number ? ` (slide ${w.number})` : ''}${w.name ? ` ${q(w.name)}` : ''}${Number.isFinite(at) ? ` last write ${ago(now - at)} ago` : ''}`
    })
    parts.push(`another chat is working on: ${items.join('; ')} (leave these alone unless the user asks)`)
  }
  return `[slidomingo editing context] ${parts.join(' | ')}`
}

// Run as the hook (not when imported by the app): print the digest.
// (argv[1] is as typed, import.meta.url is the realpath: compare resolved.)
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) {
  try {
    const dir = dirname(fileURLToPath(import.meta.url))
    const ctx = JSON.parse(readFileSync(join(dir, 'selection.json'), 'utf8'))
    // argv[2]: this tab's session dir, session-<id> (createSession)
    const self = process.argv[2] ? basename(process.argv[2]).replace(/^session-/, '') : undefined
    process.stdout.write(digest(ctx, self) + '\n')
  } catch { /* no selection.json yet (or an encrypted deck): attach nothing */ }
}
