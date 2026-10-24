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
// Without the window (background) nobody would see a slide until the agent
// reviews it, so after each slide write the pane asks for a picture of that
// slide itself (render_preview through $.mcp.call): the user watches the deck
// grow, and the picture never enters the model's context. A button picks a
// design through the same tool (variants {op:"pick"}), then tells the model
// in a prompt. Pictures draw on the terminal only; other surfaces get the
// words.
//
// Source: desktop/src/mcp/claude-mod/, copied into claude-plugin/ by
// scripts/build-claude-plugin.mjs.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Choice, Deck, Shot } from '../types'

const PANE = 'beeslides'
const TITLE = 'BeeSlides'
/** The plugin's own server, as /mcp lists it, and its tools' prefix. */
const SERVER = 'plugin:beeslides:beeslides'
const TOOLS = /^mcp__plugin_beeslides_beeslides__/

// Change a tag when that value's fields change: a reload keeps what the
// earlier version stored, and the tag declines it.
const deck = atom({ plugin: 'beeslides', key: 'deck' } as const, null, { shape: 'deck-1' })
const shot = atom({ plugin: 'beeslides', key: 'shot' } as const, null, { shape: 'shot-1' })
const choice = atom({ plugin: 'beeslides', key: 'choice' } as const, null, { shape: 'choice-1' })
const note = atom({ plugin: 'beeslides', key: 'note' } as const, '', { shape: 'note-1' })
const log = atom({ plugin: 'beeslides', key: 'log' } as const, [], { shape: 'log-1' })

/** How many progress lines the pane keeps. */
const LOG_MAX = 40
/** Tools that change one slide: in background mode the pane shows the slide
 *  afterwards. */
const SLIDE_WRITES = new Set(['slide_html', 'write_slide', 'update_element', 'insert_elements', 'set_frame', 'delete_element', 'duplicate_element', 'reorder_element', 'elements', 'icons'])

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
    case 'validate': return 'Checked the whole deck'
    case 'execute': return 'Ran a program on the deck'
    default: return SLIDE_WRITES.has(name) ? `${name}${op ? ` ${op}` : ''}${slide}` : null
  }
}

/** Slides waiting for a picture, and whether one is being made: one at a
 *  time, the latest write of each slide only. */
const toRender = new Set<string>()
let rendering = false
async function renderNext($: EngineInterface): Promise<void> {
  if (rendering) return
  rendering = true
  try {
    for (let id = toRender.values().next().value; id !== undefined; id = toRender.values().next().value) {
      toRender.delete(id)
      const r = await $.mcp.call(SERVER, 'render_preview', { slideId: id }).catch(() => null)
      const png = r && !r.isError ? pngsOf(r.content as Block[])[0] : undefined
      if (png) await update($, shot, () => ({ png, slideId: id }))
    }
  } finally {
    rendering = false
  }
}

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
    await $.command.register({ name: 'beeslides', description: 'Show the BeeSlides pane: the slides Claude looks at and the designs to pick from' })
    return next(e)
  })

  on('command.run', { command: 'beeslides' }, async ($) => {
    await $.ui.open({ id: PANE, title: TITLE })
    $.ui.status(undefined)
    return { text: 'BeeSlides pane opened.' }
  })

  // Every beeslides tool call: the result passes on untouched; the pane
  // keeps what it shows.
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
    if (name === 'open_deck') {
      // the deck line before any doc_info: the file, and whether it is hidden
      const file = /(?:opened|open) (\S+\.(?:beeslides|slidomingo)\.html)/i.exec(text)?.[1] ?? ''
      await update($, deck, (d) => ({ title: d?.file === file ? d.title : '', file, background: /in the background/.test(text), width: d?.width ?? 1280, height: d?.height ?? 720 }))
      await update($, shot, () => null)
    }
    // nobody sees a hidden deck: show each slide as it is written
    const d = await read($, deck)
    if (d?.background && SLIDE_WRITES.has(name) && typeof args.slideId === 'string' && !pngs.length) {
      toRender.add(args.slideId)
      $.clock.after(0, () => { void renderNext($) })
    }
    if ((name === 'review_slide' || name === 'render_preview') && pngs[0]) {
      const slideId = typeof args.slideId === 'string' ? args.slideId : (/^Slide "([^"]+)"/.exec(text)?.[1] ?? '')
      await update($, shot, () => ({ png: pngs[0], slideId }))
      show($)
    } else if (name === 'variants' && args.op === 'previews' && pngs.length && typeof args.slideId === 'string') {
      await update($, choice, () => ({ slideId: args.slideId as string, labels: labelsOf(text, pngs.length), pngs }))
      await update($, note, () => '')
      show($)
    } else if (name === 'variants' && args.op === 'pick' && typeof args.slideId === 'string') {
      await update($, choice, (c) => (c && c.slideId === args.slideId ? null : c))
    } else if (name === 'variants' && args.op === 'status') {
      // picked or kept in the app's compare view meanwhile: no buttons left to press
      await update($, choice, (c) => (c && new RegExp(`^${c.slideId.replace(/[^\w-]/g, '')} \\(slide \\d+\\): (picked|kept)`, 'm').test(text) ? null : c))
    } else if (name === 'propose_variants') {
      await update($, choice, () => null) // replaced: the previews of the new set follow
    } else if (name === 'doc_info') {
      const d = deckOf(text)
      if (d) await update($, deck, () => d)
    }
    return ran
  }).catch(($, e, next) => next(e)) // a pane bug never costs a tool call: the call's own answer stands

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const d = await read($, deck)
    const s = await read($, shot)
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
    // the latest slide on top, as large as leaves room for a few progress lines
    const room = Math.min(lines.length, Math.max(3, Math.floor(rows / 3)))
    const picRows = Math.max(4, rows - room - 4)
    return (
      <Box flexDirection="column">
        {head}
        {s
          ? picture(s.png, Math.min(cols, picRows / ratio), `Slide ${s.slideId}`, 'shot')
          : <Text dimColor>{d?.background ? 'Each slide shows here as it is written.' : 'The slides Claude reviews show here.'}</Text>}
        {s ? <Text dimColor>{s.slideId}</Text> : null}
        {said ? <Text dimColor>{said}</Text> : null}
        {lines.slice(-room).map((l, i) => <Text dimColor={i < room - 1}>{i === room - 1 ? '▸ ' : '  '}{l}</Text>)}
      </Box>
    )
  })
}
