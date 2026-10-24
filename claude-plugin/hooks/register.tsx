// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The BeeSlides pane of the Claude Code plugin (DECISIONS 2026-10-24): the
// slides the agent looks at, beside the chat, and the designs it proposed
// with a button for each. Without the BeeSlides window (background mode,
// plugin-launch.mjs) it is all the user sees of the deck; with it, it saves
// a trip to the app.
//
// It reads what the beeslides tools already return — no extra calls:
//   review_slide / render_preview  → the latest screenshot
//   variants {op:"previews"}       → the designs to pick from
//   doc_info / open_deck           → the deck line
// and a button picks through the same tool (variants {op:"pick"}), then tells
// the model in a prompt. Pictures draw on the terminal only; other surfaces
// get the words.
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

/** Opens the pane unasked; the surface seats it where there is room (a wide
 *  terminal) and keeps it waiting otherwise. Never fails a hook. */
const show = ($: EngineInterface): void => {
  void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
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
    return (
      <Box flexDirection="column">
        {head}
        {s ? picture(s.png, Math.min(cols, (rows - 3) / ratio), `Slide ${s.slideId}`, 'shot') : <Text dimColor>The slides Claude reviews show here.</Text>}
        {s ? <Text dimColor>{s.slideId}</Text> : null}
        {said ? <Text dimColor>{said}</Text> : null}
      </Box>
    )
  })
}
