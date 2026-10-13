// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Old tool results are the bulk of a long chat's context: a get_slide read
// ten steps ago is still re-sent on every turn. Once enough of that has piled
// up, each big result older than the last few tool rounds is replaced by a
// one-line stub (the model can simply call the tool again). It happens in
// one batch and is written into the transcript, so between batches the
// prefix stays byte-stable and prompt caching keeps working.
import type { ChatMsg } from './types.ts'

/** The most recent tool rounds always stay whole. */
export const KEEP_RECENT_ROUNDS = 3
/** A result shorter than this is left alone (writes, short findings). */
export const ELIDE_MIN_CHARS = 1200
/** Elide only once this much could be saved (about 10k tokens). */
export const ELIDE_TRIGGER_CHARS = 36000

/** Results that must survive: a skill's playbook and a subagent's report
 *  have no tool call that would bring them back. */
const KEEP_TOOLS = new Set(['use_skill', 'task'])

export const elidedStub = (name: string, chars: number): string =>
  `[older ${name} result (${chars} characters) removed to save context; call ${name} again if you still need it]`

const isStub = (text: string): boolean => text.startsWith('[older ') && text.includes(' removed to save context')

function candidates(messages: ChatMsg[]): Array<{ m: number; r: number; chars: number }> {
  const toolIdx = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []))
  const cutoff = toolIdx.length > KEEP_RECENT_ROUNDS ? toolIdx[toolIdx.length - KEEP_RECENT_ROUNDS] : -1
  const out: Array<{ m: number; r: number; chars: number }> = []
  for (const i of toolIdx) {
    if (i >= cutoff) break
    const msg = messages[i] as Extract<ChatMsg, { role: 'tool' }>
    msg.results.forEach((res, r) => {
      if (!KEEP_TOOLS.has(res.name) && res.text.length >= ELIDE_MIN_CHARS && !isStub(res.text)) out.push({ m: i, r, chars: res.text.length })
    })
  }
  return out
}

/** Characters that eliding now would save. */
export const elidableChars = (messages: ChatMsg[]): number => candidates(messages).reduce((n, c) => n + c.chars, 0)

/** Elides in place when at least `trigger` characters can be saved; returns
 *  the characters saved (0: nothing done). */
export function elideOldResults(messages: ChatMsg[], trigger = ELIDE_TRIGGER_CHARS): number {
  const list = candidates(messages)
  const saved = list.reduce((n, c) => n + c.chars, 0)
  if (saved < trigger) return 0
  for (const c of list) {
    const msg = messages[c.m] as Extract<ChatMsg, { role: 'tool' }>
    const results = msg.results.slice()
    const res = results[c.r]
    results[c.r] = { ...res, text: elidedStub(res.name, res.text.length), images: [] }
    messages[c.m] = { role: 'tool', results }
  }
  return saved
}
