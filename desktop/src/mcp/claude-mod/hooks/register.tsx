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
// Prev / Next swap through the deck (pictures kept per slide, a missing one
// made with render_preview); Live follows the agent again. Under the slide
// the user comments on it (DECISIONS 2026-10-25): the comment is a real deck
// comment flagged for the agent (pane_comment, a verb the server takes but
// never lists), and the model hears of it at once: after its next beeslides
// call while it works (the call's `context`), else as a prompt. A thread
// Claude resolved shows its reply with Accept / Reopen, as in the app.
//
// Source: desktop/src/mcp/claude-mod/, copied into claude-plugin/ by
// scripts/build-claude-plugin.mjs.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Choice, Deck, Pending, Thread } from '../types'

const PANE = 'beeslides'
const TITLE = 'BeeSlides'
/** The plugin's own server, as /mcp lists it, and its tools' prefix. */
const SERVER = 'plugin:beeslides:beeslides'
const TOOLS = /^mcp__plugin_beeslides_beeslides__/

// Change a tag when that value's fields change: a reload keeps what the
// earlier version stored, and the tag declines it.
const deck = atom({ plugin: 'beeslides', key: 'deck' } as const, null, { shape: 'deck-1' })
const shots = atom({ plugin: 'beeslides', key: 'shots' } as const, {}, { shape: 'shots-1' })
const latest = atom({ plugin: 'beeslides', key: 'latest' } as const, null, { shape: 'latest-1' })
const view = atom({ plugin: 'beeslides', key: 'view' } as const, null, { shape: 'view-1' })
const order = atom({ plugin: 'beeslides', key: 'order' } as const, [], { shape: 'order-1' })
const threads = atom({ plugin: 'beeslides', key: 'threads' } as const, null, { shape: 'threads-1' })
const reopening = atom({ plugin: 'beeslides', key: 'reopening' } as const, null, { shape: 'reopening-1' })
const pending = atom({ plugin: 'beeslides', key: 'pending' } as const, [], { shape: 'pending-1' })
const choice = atom({ plugin: 'beeslides', key: 'choice' } as const, null, { shape: 'choice-1' })
const note = atom({ plugin: 'beeslides', key: 'note' } as const, '', { shape: 'note-1' })
const log = atom({ plugin: 'beeslides', key: 'log' } as const, [], { shape: 'log-1' })

/** How many progress lines the pane keeps. */
const LOG_MAX = 40
/** How many slide pictures the pane keeps. */
const SHOTS_MAX = 80
/** How many threads the pane lists under the slide. */
const THREADS_MAX = 3
/** Tools that change one slide: its picture is stale afterwards, and in
 *  background mode the pane shows the slide. */
const SLIDE_WRITES = new Set(['slide_html', 'write_slide', 'update_element', 'insert_elements', 'set_frame', 'delete_element', 'duplicate_element', 'reorder_element', 'elements', 'icons'])
/** Tools after which the slide order may have changed. */
const ORDER_CHANGES = new Set(['deck', 'slide_html', 'write_slide', 'open_deck', 'apply_change_pattern'])

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

/** The labels variants previews puts before each picture ("Design 2: Timeline"). */
function labelsOf(text: string, count: number): string[] {
  const labels = Array.from({ length: count }, (_, i) => `Design ${i + 1}`)
  for (const m of text.matchAll(/^Design (\d+)(?:: (.+))?$/gm)) {
    const i = Number(m[1]) - 1
    if (i >= 0 && i < count && m[2]) labels[i] = m[2].trim()
  }
  return labels
}

/** doc_info's JSON → the deck line, or null when it is not that. */
function deckOf(text: string): Deck | null {
  try {
    const d = JSON.parse(text) as { title?: unknown; file?: unknown; background?: unknown; size?: { width?: unknown; height?: unknown } }
    if (!d || typeof d !== 'object' || !d.size) return null
    const n = (v: unknown, dflt: number) => (typeof v === 'number' && v > 0 ? v : dflt)
    return {
      title: typeof d.title === 'string' ? d.title : '',
      file: typeof d.file === 'string' ? d.file : '',
      background: d.background === true,
      width: n(d.size.width, 1280),
      height: n(d.size.height, 720),
    }
  } catch {
    return null
  }
}

/** outline's JSON → the slide ids in order, or null when it is not that. */
function orderOf(text: string): string[] | null {
  try {
    const rows = JSON.parse(text) as unknown
    if (!Array.isArray(rows)) return null
    return rows.flatMap((r) => (r && typeof (r as { id?: unknown }).id === 'string' ? [(r as { id: string }).id] : []))
  } catch {
    return null
  }
}

/** comments' JSON → the threads not done, oldest first. */
function threadsOf(text: string): Thread[] {
  try {
    const rows = JSON.parse(text) as unknown
    if (!Array.isArray(rows)) return []
    return rows.flatMap((r) => {
      const c = r as { id?: unknown; text?: unknown; resolved?: unknown; awaitingCheck?: unknown; replies?: Array<{ author?: unknown; text?: unknown }> }
      if (typeof c?.id !== 'string' || typeof c.text !== 'string') return []
      if (c.resolved && !c.awaitingCheck) return []
      const claude = (Array.isArray(c.replies) ? c.replies : []).filter((x) => x?.author === 'Claude' && typeof x.text === 'string').at(-1)
      return [{ id: c.id, text: c.text, check: c.awaitingCheck === true, reply: typeof claude?.text === 'string' ? claude.text : '' }]
    })
  } catch {
    return []
  }
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
    const all = Object.entries({ ...rest, [id]: png })
    return Object.fromEntries(all.slice(-SHOTS_MAX))
  })

/** Slides waiting for a picture, and whether one is being made: one at a
 *  time, the latest write of each slide only. A picture the agent's writes
 *  made becomes the latest; one the user swapped to (`quiet`) does not. */
const toRender = new Map<string, boolean>()
let rendering = false
async function renderNext($: EngineInterface): Promise<void> {
  if (rendering) return
  rendering = true
  try {
    for (let next = toRender.entries().next().value; next !== undefined; next = toRender.entries().next().value) {
      const [id, quiet] = next
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
  if ((await read($, view)) === null && before !== id) await loadThreads($, id)
}

/** The open threads of `slideId`, fresh from the deck. */
async function loadThreads($: EngineInterface, slideId: string): Promise<void> {
  const r = await $.mcp.call(SERVER, 'comments', { slideId }).catch(() => null)
  const items = r && !r.isError ? threadsOf(textOf(r.content as Block[])) : []
  await update($, threads, () => ({ slideId, items }))
}

/** The slide order, asked for when the agent may have changed it. */
let orderStale = true
async function loadOrder($: EngineInterface): Promise<string[]> {
  if (!orderStale) return read($, order)
  const r = await $.mcp.call(SERVER, 'outline', {}).catch(() => null)
  const ids = r && !r.isError ? orderOf(textOf(r.content as Block[])) : null
  if (!ids) return read($, order)
  orderStale = false
  await update($, order, () => ids)
  return ids
}

/** Prev / Next / Live: shows that slide, its picture made if the pane has none. */
async function go($: EngineInterface, step: -1 | 1 | 'live'): Promise<void> {
  await update($, reopening, () => null)
  if (step === 'live') {
    await update($, view, () => null)
    const id = await read($, latest)
    if (id) await loadThreads($, id)
    return
  }
  const ids = await loadOrder($)
  if (!ids.length) return
  const now = await shown($)
  const at = now ? ids.indexOf(now) : -1
  const id = ids[at < 0 ? (step > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, at + step))]
  if (!id) return
  await update($, view, () => id)
  if (!(await read($, shots))[id]) queueRender($, id, true)
  await loadThreads($, id)
}

/** Whether the main loop is working: then a comment waits for its next
 *  beeslides call, else it goes as a prompt. */
let busy = false

/** What the model reads of the user's comments. */
function told(list: Pending[]): string {
  return list.map((p) => {
    if (p.kind === 'reopen') return `The user reopened comment ${p.id} on slide ${p.slideId} in the BeeSlides pane: "${p.text}". Fix it again, check with review_slide, then resolve_comment with a one-line reply.`
    if (!p.id) return `The user commented on slide ${p.slideId} in the BeeSlides pane: "${p.text}". Work it into the slide.`
    return `The user commented on slide ${p.slideId} in the BeeSlides pane (comment ${p.id}, flagged for you): "${p.text}". Work it in once the step you are on is done: fix the slide, check it with review_slide, then resolve_comment with a one-line reply.`
  }).join('\n')
}

/** Tells the model now when it is idle; while it works, the next beeslides
 *  call carries it (tool.call below), or the turn's end does. */
async function deliver($: EngineInterface): Promise<void> {
  if (busy) return
  const list = await read($, pending)
  if (!list.length) return
  await update($, pending, () => [])
  await $.prompt.submit({ text: told(list) })
}

/** The comment field's Enter: a new comment on the slide in view, or the
 *  user's feedback on the thread being reopened. */
async function comment($: EngineInterface, value: string): Promise<void> {
  const text = value.trim()
  const slideId = await shown($)
  if (!text || !slideId) return
  const reopen = await read($, reopening)
  const args = reopen ? { op: 'reopen', commentId: reopen, text } : { op: 'add', slideId, text }
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
  const p: Pending = { kind: reopen ? 'reopen' : 'add', slideId, text, ...(id ? { id } : {}) }
  await update($, pending, (l) => [...(l ?? []), p])
  await update($, note, () => older
    ? 'This BeeSlides app cannot save pane comments yet: sent to Claude as a message.'
    : busy ? 'Saved on the slide; Claude reads it after its current step.' : 'Saved on the slide and sent to Claude.')
  await loadThreads($, slideId)
  await deliver($)
}

/** Accept on a thread Claude finished: done for good. */
async function accept($: EngineInterface, t: Thread, slideId: string): Promise<void> {
  const r = await $.mcp.call(SERVER, 'pane_comment', { op: 'accept', commentId: t.id }).catch(() => null)
  if (!r || r.isError) await update($, note, () => `Could not accept: ${r ? textOf(r.content as Block[]) : 'no answer'}`)
  await loadThreads($, slideId)
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

  // the turn ended before a beeslides call carried the comments: a prompt
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      busy = false
      await deliver($)
    }
    return r
  }).catch(($, e, next) => next(e))

  // Every beeslides tool call: the result passes on untouched, with the
  // user's new comments after it when some wait; the pane keeps what it shows.
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
      const same = (await read($, deck))?.file === file
      await update($, deck, (d) => ({ title: d?.file === file ? d.title : '', file, background: /in the background/.test(text), width: d?.width ?? 1280, height: d?.height ?? 720 }))
      if (!same) {
        await update($, shots, () => ({}))
        await update($, latest, () => null)
        await update($, view, () => null)
        await update($, order, () => [])
        await update($, threads, () => null)
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
      const info = deckOf(text)
      if (info) await update($, deck, () => info)
    } else if (name === 'outline') {
      const ids = orderOf(text)
      if (ids) { orderStale = false; await update($, order, () => ids) }
    } else if (name === 'resolve_comment') {
      const t = await read($, threads)
      if (t) await loadThreads($, t.slideId)
    }

    // the user's comments: the main loop hears all, a subagent those on its slide
    const waiting = await read($, pending)
    const mine = waiting.filter((p) => e.agentId === undefined || p.slideId === slideId)
    if (!mine.length) return ran
    // $.state hands out copies: told ones are known by their contents
    const toldNow = new Set(mine.map((p) => JSON.stringify(p)))
    await update($, pending, (l) => (l ?? []).filter((p) => !toldNow.has(JSON.stringify(p))))
    return { ...ran, context: [...(ran.context ?? []), told(mine)] }
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
    const png = id ? (await read($, shots))[id] : undefined
    const ids = await read($, order)
    const at = id ? ids.indexOf(id) : -1
    const t = await read($, threads)
    const list = t && t.slideId === id ? t.items : []
    const reopen = await read($, reopening)
    const waiting = (await read($, pending)).length
    const { Input } = e.surface === 'mobile' ? { Input: undefined } : $.ui.resolve(e)

    // the threads not done, Claude's finished ones first: they wait on the user
    const listed = [...list.filter((x) => x.check), ...list.filter((x) => !x.check)].slice(0, THREADS_MAX)
    const firstCheck = listed.find((x) => x.check)
    const threadRows = listed.reduce((n, x) => n + (x.check ? 2 : 1), 0) + (list.length > listed.length ? 1 : 0)
    // the slide as large as leaves room for the rest and a few progress lines
    const room = Math.min(lines.length, Math.max(2, Math.floor(rows / 4)))
    const fixed = 1 + 1 + threadRows + (id ? 1 : 0) + (said ? 1 : 0) + (waiting ? 1 : 0)
    const picRows = Math.max(4, rows - room - fixed - 2)
    const where = id ? `${id}${at >= 0 ? ` · ${at + 1}/${ids.length}` : ''}` : ''
    return (
      <Box flexDirection="column">
        {head}
        {png
          ? picture(png, Math.min(cols, picRows / ratio), `Slide ${id}`, 'shot')
          : <Text dimColor>{id ? `Making a picture of ${id}…` : d?.background ? 'Each slide shows here as it is written.' : 'The slides Claude reviews show here; ‹ › swaps through the deck.'}</Text>}
        <Box flexDirection="row">
          <Button key="prev" hotkey="p" plain label="‹ prev" onPress={() => { void go($, -1) }} />
          <Text> </Text>
          <Button key="next" hotkey="n" plain label="next ›" onPress={() => { void go($, 1) }} />
          <Text dimColor>  {where}</Text>
          {pinned
            ? <Box flexDirection="row"><Text dimColor>  </Text><Button key="live" hotkey="l" plain label={live && live !== pinned ? `live (${live})` : 'live'} onPress={() => { void go($, 'live') }} /></Box>
            : id ? <Text dimColor> · live</Text> : null}
        </Box>
        {listed.map((x) => x.check
          ? (
            <Box flexDirection="column" key={`thread-${x.id}`}>
              <Text><Text color="green">✓ </Text>{x.text}{x.reply ? <Text dimColor> — Claude: {x.reply}</Text> : null}</Text>
              <Box flexDirection="row">
                <Text>  </Text>
                <Button key={`accept-${x.id}`} hotkey={x === firstCheck ? 'a' : undefined} plain label="Accept" onPress={() => { void accept($, x, t!.slideId) }} />
                <Text>  </Text>
                <Button key={`reopen-${x.id}`} hotkey={x === firstCheck ? 'r' : undefined} plain label="Reopen" onPress={() => { void update($, reopening, () => x.id) }} />
              </Box>
            </Box>
          )
          : <Text key={`thread-${x.id}`}><Text dimColor>○ </Text>{x.text}</Text>)}
        {list.length > listed.length ? <Text dimColor>  +{list.length - listed.length} more comment(s) on this slide</Text> : null}
        {id && Input
          ? (
            <Box flexDirection="row">
              <Input
                key={`comment-${reopen ?? 'new'}-${sent}`}
                label={reopen ? 'Still wrong: ' : 'Comment: '}
                placeholder={reopen ? 'what Claude should change' : `on ${id}, for Claude`}
                submitLabel="send"
                onSubmit={(value) => { void comment($, value) }}
              />
              {reopen ? <Button key="cancel" plain label="cancel" onPress={() => { void update($, reopening, () => null) }} /> : null}
            </Box>
          )
          : null}
        {waiting ? <Text dimColor>{waiting} comment(s) wait for Claude's next step</Text> : null}
        {said ? <Text dimColor>{said}</Text> : null}
        {lines.slice(-room).map((l, i) => <Text dimColor={i < room - 1}>{i === room - 1 ? '▸ ' : '  '}{l}</Text>)}
      </Box>
    )
  })
}
