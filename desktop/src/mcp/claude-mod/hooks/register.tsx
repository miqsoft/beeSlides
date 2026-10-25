// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The BeeSlides pane of the Claude Code plugin (DECISIONS 2026-10-24): the
// slides the agent looks at, beside the chat, and the designs it proposed
// with a button for each. Without the BeeSlides window (background mode,
// plugin-launch.mjs) it is all the user sees of the deck; with it, it saves
// a trip to the app.
//
// It opens with the agent's first beeslides call and shows the work as it
// goes, from what the tools return:
//   every call                     → a line in the progress list
//   review_slide / render_preview  → the latest screenshot
//   variants {op:"previews"}       → the designs to pick from
//   doc_info / open_deck           → the deck line
//   outline                        → the slide order
// Without the window (background) nobody would see a slide until the agent
// reviews it, so after each slide write the pane asks for a picture of that
// slide itself (render_preview through $.mcp.call): the user watches the deck
// grow, and the picture never enters the model's context. A button picks a
// design through the same tool (variants {op:"pick"}), then tells the model
// in a prompt. Pictures draw on the terminal only; other surfaces get the
// words.
//
// The user steers from here too (DECISIONS 2026-10-25):
//   prev / next / jump / live  swap through the deck (pictures kept per
//                              slide, a missing one made with render_preview)
//   the comment field          a real deck comment flagged for the agent, on
//                              the slide or one element of it (pane_comment,
//                              a verb the server takes but never lists)
//   more visual / less text    the same, worded for the user
//   designs                    asks for the slide-designs skill on the slide
//   hold / go on               Claude stops after its current step, then goes on
//   Accept / Reopen, b         on a thread Claude resolved, with the slide as
//                              it was when the comment was written
//   open                       a copy of the deck in the browser
// Claude hears each at once: after its next beeslides call while it works
// (the call's `context`), else as a prompt.
//
// Source: desktop/src/mcp/claude-mod/, copied into claude-plugin/ by
// scripts/build-claude-plugin.mjs.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Choice, Deck, Pending, SlideInfo, SlideRow, Thread } from '../types'

const PANE = 'beeslides'
const TITLE = 'BeeSlides'
/** The plugin's own server, as /mcp lists it, and its tools' prefix. */
const SERVER = 'plugin:beeslides:beeslides'
const TOOLS = /^mcp__plugin_beeslides_beeslides__/

// Change a tag when that value's fields change: a reload keeps what the
// earlier version stored, and the tag declines it.
const deck = atom({ plugin: 'beeslides', key: 'deck' } as const, null, { shape: 'deck-2' })
const shots = atom({ plugin: 'beeslides', key: 'shots' } as const, {}, { shape: 'shots-1' })
const latest = atom({ plugin: 'beeslides', key: 'latest' } as const, null, { shape: 'latest-1' })
const view = atom({ plugin: 'beeslides', key: 'view' } as const, null, { shape: 'view-1' })
const order = atom({ plugin: 'beeslides', key: 'order' } as const, [], { shape: 'order-2' })
const counts = atom({ plugin: 'beeslides', key: 'counts' } as const, {}, { shape: 'counts-1' })
const threads = atom({ plugin: 'beeslides', key: 'threads' } as const, null, { shape: 'threads-1' })
const info = atom({ plugin: 'beeslides', key: 'info' } as const, null, { shape: 'info-1' })
const target = atom({ plugin: 'beeslides', key: 'target' } as const, null, { shape: 'target-1' })
const picker = atom({ plugin: 'beeslides', key: 'picker' } as const, null, { shape: 'picker-1' })
const befores = atom({ plugin: 'beeslides', key: 'befores' } as const, {}, { shape: 'befores-1' })
const flip = atom({ plugin: 'beeslides', key: 'flip' } as const, false, { shape: 'flip-1' })
const held = atom({ plugin: 'beeslides', key: 'held' } as const, false, { shape: 'held-1' })
const reopening = atom({ plugin: 'beeslides', key: 'reopening' } as const, null, { shape: 'reopening-1' })
const pending = atom({ plugin: 'beeslides', key: 'pending' } as const, [], { shape: 'pending-2' })
const choice = atom({ plugin: 'beeslides', key: 'choice' } as const, null, { shape: 'choice-1' })
const note = atom({ plugin: 'beeslides', key: 'note' } as const, '', { shape: 'note-1' })
const log = atom({ plugin: 'beeslides', key: 'log' } as const, [], { shape: 'log-1' })

/** How many progress lines the pane keeps. */
const LOG_MAX = 40
/** How many slide pictures the pane keeps, and before pictures. */
const SHOTS_MAX = 80
const BEFORES_MAX = 20
/** How many threads the pane lists under the slide. */
const THREADS_MAX = 3
/** How many elements the comment target list offers. */
const ELEMENTS_MAX = 40
/** Tools that change one slide: its picture is stale afterwards, and in
 *  background mode the pane shows the slide. */
const SLIDE_WRITES = new Set(['slide_html', 'write_slide', 'update_element', 'insert_elements', 'set_frame', 'delete_element', 'duplicate_element', 'reorder_element', 'elements', 'icons'])
/** Tools after which the slide order may have changed. */
const ORDER_CHANGES = new Set(['deck', 'slide_html', 'write_slide', 'open_deck', 'apply_change_pattern'])
/** The quick reactions: a comment worded for the user. */
const REACTIONS = {
  visual: 'More visual: show it with a diagram, a chart or a picture, and fewer words.',
  text: 'Less text: cut it to the few points that matter.',
} as const

type Block = { type?: unknown; text?: unknown; data?: unknown; source?: { data?: unknown } }

/** A tool result's content blocks, whichever way the engine hands them on:
 *  the blocks themselves, or an MCP result holding them. */
function blocksOf(result: unknown): Block[] {
  if (Array.isArray(result)) return result as Block[]
  const content = (result as { content?: unknown } | null)?.content
  return Array.isArray(content) ? (content as Block[]) : []
}

/** The PNGs among `blocks`, base64: MCP's `data`, or a base64 `source`. */
function pngsOf(blocks: Block[]): string[] {
  return blocks.flatMap((b) => {
    if (b?.type !== 'image') return []
    const data = typeof b.data === 'string' ? b.data : typeof b.source?.data === 'string' ? b.source.data : ''
    return data ? [data] : []
  })
}

const textOf = (blocks: Block[]): string => blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n')

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s)

/** The labels variants previews puts before each picture ("Design 2: Timeline"). */
function labelsOf(text: string, count: number): string[] {
  const labels = Array.from({ length: count }, (_, i) => `Design ${i + 1}`)
  for (const m of text.matchAll(/^Design (\d+)(?:: (.+))?$/gm)) {
    const i = Number(m[1]) - 1
    if (i >= 0 && i < count && m[2]) labels[i] = m[2].trim()
  }
  return labels
}

/** doc_info's JSON → the deck line (the path kept from open_deck), or null
 *  when it is not that. */
function deckOf(text: string, path: string): Deck | null {
  try {
    const d = JSON.parse(text) as { title?: unknown; file?: unknown; background?: unknown; size?: { width?: unknown; height?: unknown } }
    if (!d || typeof d !== 'object' || !d.size) return null
    const n = (v: unknown, dflt: number) => (typeof v === 'number' && v > 0 ? v : dflt)
    return {
      title: typeof d.title === 'string' ? d.title : '',
      file: typeof d.file === 'string' ? d.file : '',
      path,
      background: d.background === true,
      width: n(d.size.width, 1280),
      height: n(d.size.height, 720),
    }
  } catch {
    return null
  }
}

/** outline's JSON → the slides in order, or null when it is not that. */
function orderOf(text: string): SlideRow[] | null {
  try {
    const rows = JSON.parse(text) as unknown
    if (!Array.isArray(rows)) return null
    return rows.flatMap((r) => {
      const s = r as { id?: unknown; name?: unknown; preview?: unknown }
      if (typeof s?.id !== 'string') return []
      const title = typeof s.name === 'string' && s.name ? s.name : typeof s.preview === 'string' ? s.preview : ''
      return [{ id: s.id, title: clip(title.replace(/\s+/g, ' ').trim(), 60) }]
    })
  } catch {
    return null
  }
}

type CommentRow = { id?: unknown; slideId?: unknown; text?: unknown; resolved?: unknown; awaitingCheck?: unknown; replies?: Array<{ author?: unknown; text?: unknown }> }

const commentRows = (text: string): CommentRow[] => {
  try {
    const rows = JSON.parse(text) as unknown
    return Array.isArray(rows) ? (rows as CommentRow[]) : []
  } catch {
    return []
  }
}

/** comments' JSON → the threads not done, oldest first. */
function threadsOf(text: string): Thread[] {
  return commentRows(text).flatMap((c) => {
    if (typeof c?.id !== 'string' || typeof c.text !== 'string') return []
    if (c.resolved && !c.awaitingCheck) return []
    const claude = (Array.isArray(c.replies) ? c.replies : []).filter((x) => x?.author === 'Claude' && typeof x.text === 'string').at(-1)
    return [{ id: c.id, text: c.text, check: c.awaitingCheck === true, reply: typeof claude?.text === 'string' ? claude.text : '' }]
  })
}

/** get_slide's summary → the elements to comment on and the notes. Element
 *  lines are `  <id> <type> [role=…] @x,y wxh … "text"`; table rows (deeper)
 *  and the rest are skipped. */
function infoOf(slideId: string, text: string): SlideInfo {
  const elements: SlideInfo['elements'] = []
  let notes = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('Notes: ')) { notes = line.slice(7).trim(); continue }
    const m = /^ {2}(\S+) (\S+)(.*)$/.exec(line)
    if (!m || elements.length >= ELEMENTS_MAX) continue
    const [, id, type, rest] = m as unknown as [string, string, string, string]
    const role = /\brole=(\S+)/.exec(rest)?.[1]
    const words = /"(.*?)"(?: [\dx]+)?$/.exec(rest)?.[1]?.replace(/\s+/g, ' ').trim()
    const kind = role ?? type.replace(/^shape:/, '')
    elements.push({ id, label: words ? `${kind}: ${clip(words, 48)}` : `${kind} ${id}` })
  }
  return { slideId, elements, notes }
}

/** Opens the pane unasked, once per load. Claude Code seats an unasked pane
 *  only on a wide terminal (144 columns, 110 once asked) and keeps it waiting
 *  otherwise: then the status line says how to see it. Never fails. */
let opened = false
const HINT = 'BeeSlides: type /beeslides to watch the slides'
const show = ($: EngineInterface): void => {
  if (opened) return
  opened = true
  void $.ui.open({ id: PANE, title: TITLE }).then(
    (r) => { if (!r.isPlaced) $.ui.status(HINT) },
    () => { opened = false },
  )
}

/** One progress line for a call, or null for one not worth a line (reads,
 *  help). */
function lineFor(name: string, a: Record<string, unknown>, text: string): string | null {
  const slide = typeof a.slideId === 'string' ? ` ${a.slideId}` : ''
  const op = typeof a.op === 'string' ? a.op : ''
  if (op === 'help') return null
  switch (name) {
    case 'open_deck': {
      const m = /^(.*?) (\S+\.(?:beeslides|slidomingo)\.html)/i.exec(text)
      return m ? `${m[1]} ${m[2]}` : 'Opened a deck'
    }
    case 'close_deck': return 'Saved and closed the deck'
    case 'slide_html': return op === 'write' ? `Wrote${slide}` : null
    case 'write_slide': return `Rewrote${slide}`
    case 'deck': return op === 'add' ? `Added ${typeof a.count === 'number' ? a.count : 1} slide(s)` : `Deck: ${op}${slide}`
    case 'deck_settings': return `Deck settings: ${op}`
    case 'create_slide_type': return 'Made a slide type'
    case 'review_slide': return `Reviewed${slide}`
    case 'propose_variants': return `Proposed designs for${slide}`
    case 'variants': return op === 'pick' ? `Picked a design for${slide}` : null
    case 'resolve_comment': return 'Finished a comment'
    case 'validate': return 'Checked the whole deck'
    case 'execute': return 'Ran a program on the deck'
    default: return SLIDE_WRITES.has(name) ? `${name}${op ? ` ${op}` : ''}${slide}` : null
  }
}

/** The slide the pane shows: the one the user swapped to, else the latest. */
async function shown($: EngineInterface): Promise<string | null> {
  return (await read($, view)) ?? (await read($, latest))
}

/** Keeps a slide's picture; the oldest go past SHOTS_MAX. */
const keepShot = ($: EngineInterface, id: string, png: string) =>
  update($, shots, (m) => {
    const { [id]: _old, ...rest } = m ?? {}
    return Object.fromEntries(Object.entries({ ...rest, [id]: png }).slice(-SHOTS_MAX))
  })

/** A slide's picture now: the one kept, else one made (and kept). */
async function pictureOf($: EngineInterface, id: string): Promise<string | undefined> {
  const kept = (await read($, shots))[id]
  if (kept) return kept
  const r = await $.mcp.call(SERVER, 'render_preview', { slideId: id }).catch(() => null)
  const png = r && !r.isError ? pngsOf(r.content as Block[])[0] : undefined
  if (png) await keepShot($, id, png)
  return png
}

/** Slides waiting for a picture, and whether one is being made: one at a
 *  time, the latest write of each slide only. A picture the agent's writes
 *  made becomes the latest; one the user swapped to (`quiet`) does not. */
const toRender = new Map<string, boolean>()
let rendering = false
async function renderNext($: EngineInterface): Promise<void> {
  if (rendering) return
  rendering = true
  try {
    for (let job = toRender.entries().next().value; job !== undefined; job = toRender.entries().next().value) {
      const [id, quiet] = job
      toRender.delete(id)
      const r = await $.mcp.call(SERVER, 'render_preview', { slideId: id }).catch(() => null)
      const png = r && !r.isError ? pngsOf(r.content as Block[])[0] : undefined
      if (!png) continue
      await keepShot($, id, png)
      if (!quiet) await setLatest($, id)
    }
  } finally {
    rendering = false
  }
}
const queueRender = ($: EngineInterface, id: string, quiet: boolean) => {
  toRender.set(id, (toRender.get(id) ?? true) && quiet)
  $.clock.after(0, () => { void renderNext($) })
}

/** The agent's newest slide; when the pane follows it, that slide's threads. */
async function setLatest($: EngineInterface, id: string): Promise<void> {
  const before = await shown($)
  await update($, latest, () => id)
  if ((await read($, view)) === null && before !== id) await loadSlide($, id)
}

/** The open threads of `slideId`, fresh from the deck. */
async function loadThreads($: EngineInterface, slideId: string): Promise<void> {
  const r = await $.mcp.call(SERVER, 'comments', { slideId }).catch(() => null)
  const items = r && !r.isError ? threadsOf(textOf(r.content as Block[])) : []
  await update($, threads, () => ({ slideId, items }))
  await update($, counts, (m) => ({ ...(m ?? {}), [slideId]: items.length }))
}

/** What the pane shows under a slide it comes to: its threads, elements and
 *  notes. Whatever was picked for another slide is dropped. */
async function loadSlide($: EngineInterface, slideId: string): Promise<void> {
  await update($, flip, () => false)
  await update($, target, (t) => (t && t.slideId === slideId ? t : null))
  await loadThreads($, slideId)
  const r = await $.mcp.call(SERVER, 'get_slide', { slideId, view: 'summary' }).catch(() => null)
  await update($, info, () => (r && !r.isError ? infoOf(slideId, textOf(r.content as Block[])) : null))
}

/** The slide order, asked for when the agent may have changed it. */
let orderStale = true
async function loadOrder($: EngineInterface): Promise<SlideRow[]> {
  if (!orderStale) return read($, order)
  const r = await $.mcp.call(SERVER, 'outline', {}).catch(() => null)
  const rows = r && !r.isError ? orderOf(textOf(r.content as Block[])) : null
  if (!rows) return read($, order)
  orderStale = false
  await update($, order, () => rows)
  return rows
}

/** Shows slide `id` as the user's choice, its picture made if the pane has none. */
async function goTo($: EngineInterface, id: string): Promise<void> {
  await update($, reopening, () => null)
  await update($, picker, () => null)
  await update($, view, () => id)
  if (!(await read($, shots))[id]) queueRender($, id, true)
  await loadSlide($, id)
}

/** Prev / Next / Live. */
async function go($: EngineInterface, step: -1 | 1 | 'live'): Promise<void> {
  if (step === 'live') {
    await update($, reopening, () => null)
    await update($, picker, () => null)
    await update($, view, () => null)
    const id = await read($, latest)
    if (id) await loadSlide($, id)
    return
  }
  const ids = (await loadOrder($)).map((r) => r.id)
  if (!ids.length) return
  const now = await shown($)
  const at = now ? ids.indexOf(now) : -1
  const id = ids[at < 0 ? (step > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, at + step))]
  if (id) await goTo($, id)
}

/** The jump list: the slides in order with their open thread counts. */
async function openJump($: EngineInterface): Promise<void> {
  if ((await read($, picker)) === 'jump') { await update($, picker, () => null); return }
  orderStale = true
  await loadOrder($)
  const r = await $.mcp.call(SERVER, 'comments', {}).catch(() => null)
  if (r && !r.isError) {
    const n: Record<string, number> = {}
    for (const c of commentRows(textOf(r.content as Block[]))) {
      if (typeof c?.slideId === 'string' && (!c.resolved || c.awaitingCheck)) n[c.slideId] = (n[c.slideId] ?? 0) + 1
    }
    await update($, counts, () => n)
  }
  await update($, picker, () => 'jump')
}

/** Whether the main loop is working: then a message waits for its next
 *  beeslides call, else it goes as a prompt. */
let busy = false
/** The loops told of the hold ('' = the main loop), each once. */
const heldTold = new Set<string>()

/** What the model reads of the user's comments and requests. */
function told(list: Pending[]): string {
  return list.map((p) => {
    if (p.kind === 'ask') return p.text
    const on = p.elementId ? `slide ${p.slideId}, element ${p.elementId}${p.element ? ` (${p.element})` : ''},` : `slide ${p.slideId}`
    if (p.kind === 'reopen') return `The user reopened comment ${p.id} on ${on} in the BeeSlides pane: "${p.text}". Fix it again, check with review_slide, then resolve_comment with a one-line reply.`
    if (!p.id) return `The user commented on ${on} in the BeeSlides pane: "${p.text}". Work it into the slide.`
    return `The user commented on ${on} in the BeeSlides pane (comment ${p.id}, flagged for you): "${p.text}". Work it in once the step you are on is done: fix the slide, check it with review_slide, then resolve_comment with a one-line reply.`
  }).join('\n')
}

const HOLD_MAIN = 'The user pressed Hold in the BeeSlides pane: finish the step you are on, start no new slides or subagents, end your turn with a one-line status, and wait until the user says to go on.'
const HOLD_SUB = 'The user pressed Hold in the BeeSlides pane: finish the slide you are on, then stop and say in your answer that you stopped for the user, and where.'
const GO_ON = 'The user pressed Go on in the BeeSlides pane: carry on where you stopped.'

/** Tells the model now when it is idle; while it works, the next beeslides
 *  call carries it (tool.call below), or the turn's end does. */
async function deliver($: EngineInterface): Promise<void> {
  if (busy) return
  const list = await read($, pending)
  if (!list.length) return
  await update($, pending, () => [])
  await $.prompt.submit({ text: told(list) })
}

/** Queues a message for Claude and sends it if it is idle. */
async function tell($: EngineInterface, p: Pending): Promise<void> {
  await update($, pending, (l) => [...(l ?? []), p])
  await deliver($)
}

/** Keeps the slide's picture as it is now, for comparing once Claude says
 *  the comment is done. */
async function keepBefore($: EngineInterface, id: string, slideId: string): Promise<void> {
  const png = await pictureOf($, slideId)
  if (!png) return
  await update($, befores, (m) => Object.fromEntries(Object.entries({ ...(m ?? {}), [id]: { slideId, png } }).slice(-BEFORES_MAX)))
}

/** A comment on the slide in view: new (on the target element, if one is
 *  picked) or the user's feedback on the thread being reopened. */
async function comment($: EngineInterface, value: string): Promise<void> {
  const text = value.trim()
  const slideId = await shown($)
  if (!text || !slideId) return
  const reopen = await read($, reopening)
  const tgt = await read($, target)
  const el = !reopen && tgt?.slideId === slideId ? tgt : null
  const args = reopen ? { op: 'reopen', commentId: reopen, text } : { op: 'add', slideId, text, ...(el ? { elementId: el.elementId } : {}) }
  let failed = ''
  let id: string | undefined
  try {
    const r = await $.mcp.call(SERVER, 'pane_comment', args)
    const answer = textOf(r.content as Block[])
    if (r.isError) failed = answer || 'the comment did not go through'
    else id = (/"commentId":"([^"]+)"/.exec(answer)?.[1]) ?? reopen ?? undefined
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err)
  }
  // an app from before pane_comment: the comment still reaches Claude, as words
  const older = /Unknown (?:verb|tool)/.test(failed)
  if (failed && !older) {
    await update($, note, () => `Could not save the comment: ${failed}`)
    return
  }
  sent++
  await update($, reopening, () => null)
  await update($, target, () => null)
  if (id) await keepBefore($, id, slideId)
  await update($, note, () => older
    ? 'This BeeSlides app cannot save pane comments yet: sent to Claude as a message.'
    : busy ? 'Saved on the slide; Claude reads it after its current step.' : 'Saved on the slide and sent to Claude.')
  await loadThreads($, slideId)
  await tell($, { kind: reopen ? 'reopen' : 'add', slideId, text, ...(id ? { id } : {}), ...(el ? { elementId: el.elementId, element: el.label } : {}) })
}

/** Accept on a thread Claude finished: done for good. */
async function accept($: EngineInterface, t: Thread, slideId: string): Promise<void> {
  const r = await $.mcp.call(SERVER, 'pane_comment', { op: 'accept', commentId: t.id }).catch(() => null)
  if (!r || r.isError) await update($, note, () => `Could not accept: ${r ? textOf(r.content as Block[]) : 'no answer'}`)
  else await update($, befores, (m) => { const { [t.id]: _done, ...rest } = m ?? {}; return rest })
  await update($, flip, () => false)
  await loadThreads($, slideId)
}

/** Hold, and Go on: a flag every loop hears once while it is set. */
async function toggleHold($: EngineInterface): Promise<void> {
  const now = await read($, held)
  heldTold.clear()
  await update($, held, () => !now)
  if (!now) {
    await update($, note, () => busy ? 'Hold: Claude stops after the step it is on.' : 'Hold: Claude waits for Go on before it builds more.')
    return
  }
  await update($, note, () => '')
  await tell($, { kind: 'ask', slideId: '', text: GO_ON })
}

/** Other designs for the slide in view: the slide-designs skill. */
async function askDesigns($: EngineInterface): Promise<void> {
  const slideId = await shown($)
  if (!slideId) return
  await update($, note, () => `Asked Claude for other designs for ${slideId}.`)
  await tell($, { kind: 'ask', slideId, text: `The user asks in the BeeSlides pane for other designs for slide ${slideId}: use the slide-designs skill on it once the step you are on is done.` })
}

/** A copy of the deck, as last saved, in the browser: a copy, so nothing
 *  there can write the deck the agent works on. */
async function openCopy($: EngineInterface, d: Deck): Promise<void> {
  try {
    const dir = (await $.process.run(['mktemp', '-d'])).stdout.trim()
    const name = (d.file || 'deck.beeslides.html').replace(/\.(?:beeslides|slidomingo)\.html$/i, '').replace(/[^\w.-]+/g, '-')
    const copy = `${dir}/${name}.html`
    const cp = await $.process.run(['cp', d.path, copy])
    if (cp.exitCode !== 0) throw new Error(cp.stderr.trim() || 'could not copy the deck')
    // macOS `open`; elsewhere `open` may be missing or another program (openvt)
    let opener = await $.process.run(['open', copy]).catch(() => null)
    if (!opener || opener.exitCode !== 0) opener = await $.process.run(['xdg-open', copy])
    if (opener.exitCode !== 0) throw new Error(opener.stderr.trim() || 'could not open the browser')
    await update($, note, () => 'Opened a copy in the browser (the deck as last saved; changes there stay in the copy).')
  } catch (err) {
    await update($, note, () => `Could not open the deck: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Bumped per comment sent: the field is drawn anew, empty. */
let sent = 0

/** A button's pick: through the tool, then a prompt that tells the model. */
async function pick($: EngineInterface, c: Choice, index: number | 'keep'): Promise<void> {
  const args = index === 'keep' ? { op: 'pick', slideId: c.slideId, keep: true } : { op: 'pick', slideId: c.slideId, index }
  let failed = ''
  try {
    const r = await $.mcp.call(SERVER, 'variants', args)
    if (r.isError) failed = textOf(r.content as Block[]) || 'the pick did not go through'
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err)
  }
  if (failed) {
    await update($, note, () => `Could not pick: ${failed}`)
    return
  }
  await update($, choice, (now) => (now && now.slideId === c.slideId ? null : now))
  const said = index === 'keep'
    ? `I kept the current slide ${c.slideId} in the BeeSlides pane; the designs are gone.`
    : `I picked design ${index} (${c.labels[index - 1] ?? `Design ${index}`}) for slide ${c.slideId} in the BeeSlides pane; it is on the slide now.`
  await update($, note, () => said)
  await $.prompt.submit({ text: said })
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'beeslides', description: 'Show the BeeSlides pane: the slides Claude works on, your comments, the designs to pick from' })
    return next(e)
  })

  on('command.run', { command: 'beeslides' }, async ($) => {
    await $.ui.open({ id: PANE, title: TITLE })
    $.ui.status(undefined)
    return { text: 'BeeSlides pane opened.' }
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) busy = true
    return next(e)
  })

  // the turn ended before a beeslides call carried the messages: a prompt
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      busy = false
      heldTold.delete('')
      await deliver($)
    }
    return r
  }).catch(($, e, next) => next(e))

  // Every beeslides tool call: the result passes on untouched, with the
  // user's new messages after it when some wait; the pane keeps what it shows.
  on('tool.call', { tool: TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const name = String(e.tool).replace(TOOLS, '')
    const args = e as unknown as Record<string, unknown>
    const blocks = blocksOf(ran.result)
    const text = ran.text ?? textOf(blocks)
    const pngs = pngsOf(blocks)
    show($)
    const line = lineFor(name, args, text)
    if (line) await update($, log, (l) => [...(l ?? []), line].slice(-LOG_MAX))
    if (ORDER_CHANGES.has(name)) orderStale = true
    if (name === 'open_deck') {
      // the deck line before any doc_info: the file, and whether it is hidden
      const file = /(?:opened|open) (\S+\.(?:beeslides|slidomingo)\.html)/i.exec(text)?.[1] ?? ''
      const path = typeof args.path === 'string' ? args.path : ''
      const same = (await read($, deck))?.file === file
      await update($, deck, (d) => ({ title: d?.file === file ? d.title : '', file, path, background: /in the background/.test(text), width: d?.width ?? 1280, height: d?.height ?? 720 }))
      if (!same) {
        await update($, shots, () => ({}))
        await update($, latest, () => null)
        await update($, view, () => null)
        await update($, order, () => [])
        await update($, counts, () => ({}))
        await update($, threads, () => null)
        await update($, info, () => null)
        await update($, target, () => null)
        await update($, picker, () => null)
        await update($, befores, () => ({}))
        await update($, reopening, () => null)
      }
    }
    const d = await read($, deck)
    const slideId = typeof args.slideId === 'string' ? args.slideId : ''
    if (slideId && SLIDE_WRITES.has(name) && !pngs.length) {
      // the picture is stale: nobody sees a hidden deck, so show each slide
      // as it is written; with the window, redo only the one the user views
      const viewing = (await read($, view)) === slideId
      await update($, shots, (m) => { const { [slideId]: _stale, ...rest } = m ?? {}; return rest })
      if (d?.background || viewing) queueRender($, slideId, !d?.background)
      if ((await read($, info))?.slideId === slideId) {
        const r = await $.mcp.call(SERVER, 'get_slide', { slideId, view: 'summary' }).catch(() => null)
        if (r && !r.isError) await update($, info, () => infoOf(slideId, textOf(r.content as Block[])))
      }
    }
    if ((name === 'review_slide' || name === 'render_preview') && pngs[0]) {
      const id = slideId || (/^Slide "([^"]+)"/.exec(text)?.[1] ?? '')
      if (id && !args.elementIds && !args.area) {
        await keepShot($, id, pngs[0])
        await setLatest($, id)
      }
      show($)
    } else if (name === 'variants' && args.op === 'previews' && pngs.length && slideId) {
      await update($, choice, () => ({ slideId, labels: labelsOf(text, pngs.length), pngs }))
      await update($, note, () => '')
      show($)
    } else if (name === 'variants' && args.op === 'pick' && slideId) {
      await update($, choice, (c) => (c && c.slideId === slideId ? null : c))
    } else if (name === 'variants' && args.op === 'status') {
      // picked or kept in the app's compare view meanwhile: no buttons left to press
      await update($, choice, (c) => (c && new RegExp(`^${c.slideId.replace(/[^\w-]/g, '')} \\(slide \\d+\\): (picked|kept)`, 'm').test(text) ? null : c))
    } else if (name === 'propose_variants') {
      await update($, choice, () => null) // replaced: the previews of the new set follow
    } else if (name === 'doc_info') {
      const docLine = deckOf(text, d?.path ?? '')
      if (docLine) await update($, deck, () => docLine)
    } else if (name === 'outline') {
      const rows = orderOf(text)
      if (rows) { orderStale = false; await update($, order, () => rows) }
    } else if (name === 'resolve_comment' && typeof args.commentId === 'string') {
      // the slide after the fix, for before / after
      const b = (await read($, befores))[args.commentId]
      if (b && !(await read($, shots))[b.slideId]) queueRender($, b.slideId, true)
      const t = await read($, threads)
      if (t) await loadThreads($, t.slideId)
    }

    // the user's messages: the main loop hears all, a subagent the comments
    // on its slide; the hold, every loop once
    const context: string[] = []
    const loop = e.agentId ?? ''
    if ((await read($, held)) && !heldTold.has(loop)) {
      heldTold.add(loop)
      context.push(loop ? HOLD_SUB : HOLD_MAIN)
    }
    const waiting = await read($, pending)
    const mine = waiting.filter((p) => e.agentId === undefined || (p.kind !== 'ask' && p.slideId === slideId))
    if (mine.length) {
      // $.state hands out copies: told ones are known by their contents
      const toldNow = new Set(mine.map((p) => JSON.stringify(p)))
      await update($, pending, (l) => (l ?? []).filter((p) => !toldNow.has(JSON.stringify(p))))
      context.push(told(mine))
    }
    return context.length ? { ...ran, context: [...(ran.context ?? []), ...context] } : ran
  }).catch(($, e, next) => next(e)) // a pane bug never costs a tool call: the call's own answer stands

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const d = await read($, deck)
    const c = await read($, choice)
    const said = await read($, note)
    const lines = await read($, log)
    const cols = Math.max(16, e.props.bodyColumns)
    const rows = Math.max(10, e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30)
    // a terminal cell is about twice as tall as wide
    const ratio = (d ? d.height / d.width : 9 / 16) / 2
    const picture = (png: string, width: number, alt: string, key: string) => {
      if (e.surface !== 'terminal') return <Text dimColor>[{alt}]</Text>
      const { Image } = $.ui.resolve(e)
      const w = Math.max(8, Math.min(255, Math.floor(width)))
      return <Image key={key} source={{ png }} columns={w} rows={Math.max(2, Math.min(255, Math.round(w * ratio)))} alt={alt} />
    }

    const head = d
      ? <Text bold>{d.title || d.file || 'Deck'}{d.file && d.title ? <Text dimColor> · {d.file}</Text> : null}{d.background ? <Text dimColor> · no window</Text> : null}</Text>
      : <Text dimColor>No deck yet: Claude names one with open_deck, or works on the one open in BeeSlides.</Text>

    if (c) {
      // the designs, one under the other, sized so all of them fit
      const each = Math.max(3, Math.floor((rows - 4) / c.pngs.length) - 2)
      const width = Math.min(cols, each / ratio)
      return (
        <Box flexDirection="column">
          {head}
          <Text>{c.pngs.length} designs for {c.slideId}: pick one, or answer Claude with the number.</Text>
          {c.pngs.map((png, i) => (
            <Box flexDirection="column" key={`design-${i}`}>
              {picture(png, width, `Design ${i + 1}: ${c.labels[i]}`, `design-${i}`)}
              <Box flexDirection="row">
                <Button key={`use-${i}`} hotkey={String(i + 1)} variant="primary" label={`Use ${i + 1}`} onPress={() => { void pick($, c, i + 1) }} />
                <Text> {c.labels[i]}</Text>
              </Box>
            </Box>
          ))}
          <Button key="keep" hotkey="k" label="Keep current" onPress={() => { void pick($, c, 'keep') }} />
          {said ? <Text dimColor>{said}</Text> : null}
        </Box>
      )
    }

    const pinned = await read($, view)
    const live = await read($, latest)
    const id = pinned ?? live
    const all = await read($, shots)
    const slides = await read($, order)
    const at = id ? slides.findIndex((r) => r.id === id) : -1
    const t = await read($, threads)
    const list = t && t.slideId === id ? t.items : []
    const si = await read($, info)
    const here = si && si.slideId === id ? si : null
    const tgt = await read($, target)
    const aim = tgt && tgt.slideId === id ? tgt : null
    const pick_ = await read($, picker)
    const reopen = await read($, reopening)
    const waiting = (await read($, pending)).length
    const hold = await read($, held)
    const before = await read($, befores)
    const flipped = await read($, flip)
    const n = await read($, counts)
    const table = $.ui.resolve(e)
    const Input = 'Input' in table ? table.Input : undefined
    const Select = 'Select' in table ? table.Select : undefined

    // the threads not done, Claude's finished ones first: they wait on the user
    const listed = [...list.filter((x) => x.check), ...list.filter((x) => !x.check)].slice(0, THREADS_MAX)
    const firstCheck = listed.find((x) => x.check)
    const then = firstCheck ? before[firstCheck.id] : undefined
    const threadRows = listed.reduce((k, x) => k + (x.check ? 2 : 1), 0) + (list.length > listed.length ? 1 : 0)
    const notes = here?.notes ? clip(`Notes: ${here.notes}`, cols * 2) : ''
    // the slide as large as leaves room for the rest and a few progress lines
    const room = Math.min(lines.length, Math.max(2, Math.floor(rows / 5)))
    const fixed = 1 + 1 + (notes ? Math.ceil(notes.length / cols) : 0) + threadRows + (id ? 2 : 0) + (said ? 1 : 0) + (waiting ? 1 : 0)
    const picRows = Math.max(4, rows - room - fixed - 2)
    const where = id ? `${id}${at >= 0 ? ` · ${at + 1}/${slides.length}` : ''}${at >= 0 && slides[at]?.title ? ` · ${clip(slides[at]!.title, 24)}` : ''}` : ''
    const png = flipped && then ? then.png : id ? all[id] : undefined

    let main
    if (pick_ === 'jump' && Select && slides.length) {
      main = (
        <Select
          key="jump"
          label="Go to: "
          autoFocus
          value={id ?? undefined}
          options={slides.map((r, i) => ({ value: r.id, label: `${i + 1}. ${r.title || r.id}${n[r.id] ? `  ○${n[r.id]}` : ''}` }))}
          onSelect={(v) => { void goTo($, v) }}
        />
      )
    } else if (pick_ === 'element' && Select && here && id) {
      main = (
        <Select
          key="element"
          label="Comment on: "
          autoFocus
          value={aim?.elementId ?? ''}
          options={[{ value: '', label: 'the whole slide' }, ...here.elements.map((x) => ({ value: x.id, label: x.label }))]}
          onSelect={(v) => {
            const el = here.elements.find((x) => x.id === v)
            void update($, target, () => (el ? { slideId: id, elementId: el.id, label: el.label } : null))
            void update($, picker, () => null)
          }}
        />
      )
    } else if (png) {
      main = picture(png, Math.min(cols, picRows / ratio), flipped && then ? `Slide ${id} before your comment` : `Slide ${id}`, flipped && then ? 'before' : 'shot')
    } else {
      main = <Text dimColor>{id ? `Making a picture of ${id}…` : d?.background ? 'Each slide shows here as it is written.' : 'The slides Claude reviews show here; ‹ › swaps through the deck.'}</Text>
    }

    return (
      <Box flexDirection="column">
        {head}
        {main}
        <Box flexDirection="row">
          <Button key="prev" hotkey="p" plain label="‹ prev" onPress={() => { void go($, -1) }} />
          <Text> </Text>
          <Button key="next" hotkey="n" plain label="next ›" onPress={() => { void go($, 1) }} />
          <Text> </Text>
          <Button key="jump-to" hotkey="j" plain label="jump" onPress={() => { void openJump($) }} />
          <Text dimColor>  {flipped && then ? `${where} · before your comment` : where}</Text>
          {pinned
            ? <Box flexDirection="row"><Text dimColor>  </Text><Button key="live" hotkey="l" plain label={live && live !== pinned ? `live (${live})` : 'live'} onPress={() => { void go($, 'live') }} /></Box>
            : id ? <Text dimColor> · live</Text> : null}
        </Box>
        {notes ? <Text dimColor>{notes}</Text> : null}
        {listed.map((x) => x.check
          ? (
            <Box flexDirection="column" key={`thread-${x.id}`}>
              <Text><Text color="green">✓ </Text>{x.text}{x.reply ? <Text dimColor> — Claude: {x.reply}</Text> : null}</Text>
              <Box flexDirection="row">
                <Text>  </Text>
                <Button key={`accept-${x.id}`} hotkey={x === firstCheck ? 'a' : undefined} plain label="Accept" onPress={() => { void accept($, x, t!.slideId) }} />
                <Text>  </Text>
                <Button key={`reopen-${x.id}`} hotkey={x === firstCheck ? 'r' : undefined} plain label="Reopen" onPress={() => { void update($, reopening, () => x.id) }} />
                {x === firstCheck && then
                  ? <Box flexDirection="row"><Text>  </Text><Button key="flip" hotkey="b" plain label={flipped ? 'after' : 'before'} onPress={() => { void update($, flip, (f) => !f) }} /></Box>
                  : null}
              </Box>
            </Box>
          )
          : <Text key={`thread-${x.id}`}><Text dimColor>○ </Text>{x.text}</Text>)}
        {list.length > listed.length ? <Text dimColor>  +{list.length - listed.length} more comment(s) on this slide</Text> : null}
        {id && Input
          ? (
            <Box flexDirection="row">
              {!reopen && Select && here?.elements.length
                ? <Box flexDirection="row"><Button key="aim" hotkey="e" plain dimColor={!aim} label={aim ? `on ${clip(aim.label, 24)}` : 'on: slide'} onPress={() => { void update($, picker, (p) => (p === 'element' ? null : 'element')) }} /><Text> </Text></Box>
                : null}
              <Input
                key={`comment-${reopen ?? 'new'}-${sent}`}
                label={reopen ? 'Still wrong: ' : 'Comment: '}
                placeholder={reopen ? 'what Claude should change' : 'for Claude'}
                submitLabel="send"
                onSubmit={(value) => { void comment($, value) }}
              />
              {reopen ? <Button key="cancel" plain label="cancel" onPress={() => { void update($, reopening, () => null) }} /> : null}
            </Box>
          )
          : null}
        {id
          ? (
            <Box flexDirection="row">
              <Button key="hold" hotkey="h" plain label={hold ? 'go on' : 'hold'} onPress={() => { void toggleHold($) }} />
              <Text>  </Text>
              <Button key="visual" hotkey="v" plain dimColor label="more visual" onPress={() => { void comment($, REACTIONS.visual) }} />
              <Text>  </Text>
              <Button key="less-text" hotkey="t" plain dimColor label="less text" onPress={() => { void comment($, REACTIONS.text) }} />
              <Text>  </Text>
              <Button key="designs" hotkey="d" plain dimColor label="designs" onPress={() => { void askDesigns($) }} />
              {d?.path
                ? <Box flexDirection="row"><Text>  </Text><Button key="open" hotkey="o" plain dimColor label="open" onPress={() => { void openCopy($, d) }} /></Box>
                : null}
            </Box>
          )
          : null}
        {waiting ? <Text dimColor>{waiting} message(s) wait for Claude's next step</Text> : null}
        {said ? <Text dimColor>{said}</Text> : null}
        {lines.slice(-room).map((l, i) => <Text dimColor={i < room - 1}>{i === room - 1 ? '▸ ' : '  '}{l}</Text>)}
      </Box>
    )
  })
}
