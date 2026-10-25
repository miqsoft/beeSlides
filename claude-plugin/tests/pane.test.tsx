// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The BeeSlides pane (hooks/register.tsx), against the engine's own test kit:
//   claude plugin test claude-plugin
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const TOOL = 'mcp__plugin_beeslides_beeslides__'
/** A 1×1 PNG, base64. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const PANE = {
  plugin: 'beeslides',
  component: 'Pane',
  requestId: 'beeslides',
  props: {
    title: 'BeeSlides',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('a review screenshot and the deck line show in the pane', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // the beeslides server's answers, as the engine relays them
  on('tool.call', { tool: `${TOOL}doc_info` }, () => ({
    result: [{ type: 'text', text: JSON.stringify({ title: 'Talk', file: 'talk.beeslides.html', background: true, size: { width: 1280, height: 720 } }) }],
  }))
  on('tool.call', { tool: `${TOOL}review_slide` }, () => ({
    result: { content: [{ type: 'text', text: 'Slide "s1" (1280x720) — elements' }, { type: 'image', data: PNG, mimeType: 'image/png' }], isError: false },
  }))
  await $.tool.call({ tool: `${TOOL}doc_info` })
  await $.tool.call({ tool: `${TOOL}review_slide`, slideId: 's1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Talk/ }))?.text).toContain('no window')
  expect(await ui.find({ type: 'Image', key: 'shot' })).toBeDefined()
  await ui.unmount()

  // a surface that draws no pictures says what there is instead
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ type: 'Text', text: /Slide s1/ })).toBeDefined()
  await desk.unmount()
})

test('previews become buttons; a press picks through the tool and tells Claude', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const prompts: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: `${TOOL}variants` }, () => ({
    result: [
      { type: 'text', text: '2 designs for s2: 1 "Cards", 2 "Timeline".' },
      { type: 'text', text: 'Design 1: Cards' }, { type: 'image', data: PNG, mimeType: 'image/png' },
      { type: 'text', text: 'Design 2: Timeline' }, { type: 'image', data: PNG, mimeType: 'image/png' },
    ],
  }))
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    return { value: { content: [{ type: 'text', text: 'Used design 2' }], isError: false } }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.tool.call({ tool: `${TOOL}variants`, op: 'previews', slideId: 's2' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
    expect((await ui.find({ type: 'Text', text: /Timeline/ }))?.text).toContain('Timeline')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'use-1' })
  expect(calls).toEqual([{ tool: 'variants', args: { op: 'pick', slideId: 's2', index: 2 } }])
  expect(prompts[0]).toContain('I picked design 2 (Timeline) for slide s2')
  // the choice is gone once picked: the slide view is back
  expect(await ui.find({ type: 'Button', key: 'use-0' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'next' })).toBeDefined()
  await ui.unmount()
})

test('Keep current keeps the slide', async ($, on) => {
  const calls: Array<Record<string, unknown>> = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: `${TOOL}variants` }, () => ({ result: [{ type: 'text', text: 'Design 1: Only' }, { type: 'image', data: PNG }] }))
  on('mcp.call', (_, e) => { calls.push(e.args); return { value: { content: [], isError: false } } })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.tool.call({ tool: `${TOOL}variants`, op: 'previews', slideId: 's3' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'keep' })
  expect(calls).toEqual([{ op: 'pick', slideId: 's3', keep: true }])
  await ui.unmount()
})

test('a failed pick leaves the designs and says why', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: `${TOOL}variants` }, () => ({ result: [{ type: 'image', data: PNG }] }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'No designs are waiting' }], isError: true } }))
  await $.tool.call({ tool: `${TOOL}variants`, op: 'previews', slideId: 's4' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'use-0' })
  expect((await ui.find({ type: 'Text', text: /Could not pick/ }))?.text).toContain('No designs are waiting')
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
  await ui.unmount()
})

test('without the window, the pane opens at once and shows each slide as it is written', async ($, on) => {
  const clock = mock.clock(on)
  const opens: string[] = []
  const renders: unknown[] = []
  on('ui.open', (_, e) => { opens.push(e.id); return { value: { isPlaced: true } } })
  on('tool.call', { tool: `${TOOL}open_deck` }, () => ({
    result: [{ type: 'text', text: 'Created and opened TCP.beeslides.html (in the background: no window; every change is saved to the file). Every tool call from here on works on it.' }],
  }))
  on('tool.call', { tool: `${TOOL}slide_html` }, () => ({ result: [{ type: 'text', text: 'Wrote s1 from HTML as one undo step' }] }))
  on('mcp.call', (_, e) => {
    if (e.tool !== 'render_preview') return { value: { content: [{ type: 'text', text: '[]' }], isError: false } }
    renders.push(e.args)
    return { value: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }], isError: false } }
  })

  await $.tool.call({ tool: `${TOOL}open_deck`, path: '/x/TCP.beeslides.html', create: true })
  expect(opens).toEqual(['beeslides'])
  const empty = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await empty.find({ type: 'Text', text: /TCP\.beeslides\.html/ }))?.text).toContain('no window')
  expect(await empty.find({ type: 'Text', text: /as it is written/ })).toBeDefined()
  await empty.unmount()

  await $.tool.call({ tool: `${TOOL}slide_html`, op: 'write', slideId: 's1', html: '<h1>x</h1>' })
  await clock.settle()
  expect(renders).toEqual([{ slideId: 's1' }])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image', key: 'shot' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Created and opened TCP\.beeslides\.html/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Wrote s1/ }))?.text).toContain('▸')
  await ui.unmount()
})

test('with the app open, the pane draws no pictures of its own', async ($, on) => {
  const clock = mock.clock(on)
  let calls = 0
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: `${TOOL}open_deck` }, () => ({ result: [{ type: 'text', text: 'Opened talk.beeslides.html. Every tool call from here on works on it.' }] }))
  on('tool.call', { tool: `${TOOL}slide_html` }, () => ({ result: [{ type: 'text', text: 'Wrote s1' }] }))
  on('mcp.call', () => { calls++; return { value: { content: [], isError: false } } })
  await $.tool.call({ tool: `${TOOL}open_deck`, path: '/x/talk.beeslides.html' })
  await $.tool.call({ tool: `${TOOL}slide_html`, op: 'write', slideId: 's1', html: '<h1>x</h1>' })
  await clock.settle()
  expect(calls).toBe(0)
})

test('on a narrow terminal the pane waits and the status line says how to see it', async ($, on) => {
  const statuses: unknown[] = []
  let wide = false
  on('ui.open', () => ({ value: wide ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  on('ui.status', (_, e) => { statuses.push(e.text); return { value: undefined } })
  on('command.register', () => ({ value: { command: 'beeslides' } }))
  on('tool.call', { tool: `${TOOL}doc_info` }, () => ({ result: [{ type: 'text', text: '{}' }] }))
  await $.tool.call({ tool: `${TOOL}doc_info` })
  expect(statuses.at(-1)).toContain('/beeslides')
  wide = true
  await $.command.run({ command: 'beeslides', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(statuses.at(-1)).toBeUndefined()
})

/** The beeslides server as $.mcp.call reaches it: a slide order, pictures,
 *  comment threads, and pane_comment's answer; every call kept. */
function server(on: Parameters<TestBody>[1], o: { threads?: unknown[]; comment?: { text: string; isError?: boolean } } = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const text = (t: string, isError = false) => ({ value: { content: [{ type: 'text', text: t }], isError } })
    if (e.tool === 'outline') return text(JSON.stringify([{ id: 's1', index: 0 }, { id: 's2', index: 1 }, { id: 's3', index: 2 }]))
    if (e.tool === 'render_preview') return { value: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }], isError: false } }
    if (e.tool === 'comments') return text(JSON.stringify(o.threads ?? []))
    if (e.tool === 'pane_comment') return text(o.comment?.text ?? JSON.stringify({ commentId: 'cmt_1' }), o.comment?.isError)
    return text('{}')
  })
  return calls
}

const reviewed = (slideId: string) => ({
  result: { content: [{ type: 'text', text: `Slide "${slideId}" (1280x720) — elements` }, { type: 'image', data: PNG, mimeType: 'image/png' }], isError: false },
})

test('prev / next swap through the deck; live follows the agent again', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: `${TOOL}review_slide` }, (_, e) => reviewed(String((e as unknown as { slideId: string }).slideId)))
  const calls = server(on)
  await $.tool.call({ tool: `${TOOL}review_slide`, slideId: 's2' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'live' })).toBeUndefined()
  await ui.press({ key: 'next' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /s3 · 3\/3/ })).toBeDefined()
  // no picture of s3 yet: the pane made one, without taking it for the latest
  expect(calls.filter((c) => c.tool === 'render_preview')).toEqual([{ tool: 'render_preview', args: { slideId: 's3' } }])
  expect((await ui.find({ type: 'Button', key: 'live' }))?.text).toContain('s2')
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: /s1 · 1\/3/ })).toBeDefined()
  await ui.press({ key: 'live' })
  expect(await ui.find({ type: 'Text', text: /s2 · 2\/3/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'live' })).toBeUndefined()
  await ui.unmount()
})

test('a comment while Claude works is saved on the slide and rides on its next beeslides call', async ($, on) => {
  const prompts: string[] = []
  let threads: unknown[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('tool.call', { tool: `${TOOL}review_slide` }, () => reviewed('s1'))
  on('tool.call', { tool: `${TOOL}doc_info` }, () => ({ result: [{ type: 'text', text: '{}' }] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    if (e.tool === 'pane_comment') threads = [{ id: 'cmt_1', text: 'Shorter title', resolved: false, awaitingCheck: false, replies: [] }]
    const text = e.tool === 'pane_comment' ? JSON.stringify({ commentId: 'cmt_1' }) : JSON.stringify(threads)
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  await $.tool.call({ tool: `${TOOL}review_slide`, slideId: 's1' })
  await $.turn.start({ text: 'build the deck', turnId: 't1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const field = await ui.find({ type: 'Input' })
  await ui.input({ key: field!.key!, text: 'Shorter title' })
  expect(calls.find((c) => c.tool === 'pane_comment')?.args).toEqual({ op: 'add', slideId: 's1', text: 'Shorter title' })
  expect(prompts).toEqual([])
  expect(await ui.find({ type: 'Text', text: /○ Shorter title/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 comment\(s\) wait/ })).toBeDefined()

  const r = await $.tool.call({ tool: `${TOOL}doc_info` })
  expect(r.context?.join('\n')).toContain('(comment cmt_1, flagged for you): "Shorter title"')
  // told once: the next call and the turn's end carry nothing more
  const again = await $.tool.call({ tool: `${TOOL}doc_info` })
  expect(again.context ?? []).toEqual([])
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as Parameters<typeof $.turn.complete>[0])
  expect(prompts).toEqual([])
  await ui.unmount()
})

test('an idle comment goes as a prompt; an app without pane_comment gets it as words', async ($, on) => {
  const prompts: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('tool.call', { tool: `${TOOL}review_slide` }, () => reviewed('s2'))
  server(on, { comment: { text: 'Error: Unknown verb: pane_comment', isError: true } })
  await $.tool.call({ tool: `${TOOL}review_slide`, slideId: 's2' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const field = await ui.find({ type: 'Input' })
  await ui.input({ key: field!.key!, text: 'Use the logo' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('slide s2 in the BeeSlides pane: "Use the logo"')
  expect(prompts[0]).not.toContain('resolve_comment')
  expect(await ui.find({ type: 'Text', text: /cannot save pane comments yet/ })).toBeDefined()
  await ui.unmount()
})

test('a thread Claude finished shows its reply with Accept and Reopen', async ($, on) => {
  const prompts: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('tool.call', { tool: `${TOOL}review_slide` }, () => reviewed('s1'))
  const calls = server(on, { threads: [
    { id: 'cmt_1', text: 'Shorter title', resolved: true, awaitingCheck: true, replies: [{ author: 'Claude', text: 'Cut it to four words', at: '' }] },
    { id: 'cmt_2', text: 'Done long ago', resolved: true, awaitingCheck: false, replies: [] },
  ] })
  await $.tool.call({ tool: `${TOOL}review_slide`, slideId: 's1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Claude: Cut it to four words/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Done long ago/ })).toBeUndefined()

  await ui.press({ key: 'reopen-cmt_1' })
  expect(await ui.find({ type: 'Button', key: 'cancel' })).toBeDefined()
  const field = await ui.find({ type: 'Input' })
  await ui.input({ key: field!.key!, text: 'Still too long' })
  expect(calls.find((c) => c.tool === 'pane_comment')?.args).toEqual({ op: 'reopen', commentId: 'cmt_1', text: 'Still too long' })
  expect(prompts[0]).toContain('reopened comment cmt_1 on slide s1')

  await ui.press({ key: 'accept-cmt_1' })
  expect(calls.filter((c) => c.tool === 'pane_comment').at(-1)?.args).toEqual({ op: 'accept', commentId: 'cmt_1' })
  await ui.unmount()
})
