#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Code Mode's program loop (desktop/src/main/programrun.ts) in headless
// Chromium against a stand-in deck — the same page, runtime, CSP, call checks
// and driver the app runs in its hidden window (agentexec.ts), minus Electron:
//   - a program edits a slide through the DOM and writes it back
//   - its return value and console output come back; its calls are counted
//   - a throw, a denied verb, a network request and an endless loop all fail
//     cleanly within the time budget
//   - a call fired without await still lands before the run ends
//
//   node scripts/test-agent-exec-e2e.ts      (skips without playwright-core)
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PAGE, checkCall, driveProgram, type ProgramOutcome } from '../desktop/src/main/programrun.ts'
import type { AgentChannel, AgentResult } from '../desktop/src/main/agentchannels.ts'

async function loadChromium(): Promise<any> {
  const tries: string[] = []
  if (process.env.PLAYWRIGHT_CORE) tries.push(pathToFileURL(process.env.PLAYWRIGHT_CORE).href)
  tries.push('playwright-core')
  const npx = join(homedir(), '.npm/_npx')
  if (existsSync(npx)) {
    for (const d of readdirSync(npx)) {
      const p = join(npx, d, 'node_modules/playwright-core/index.mjs')
      if (existsSync(p)) tries.push(pathToFileURL(p).href)
    }
  }
  for (const spec of tries) {
    try { return (await import(spec)).chromium } catch { /* next */ }
  }
  return null
}

const skip = (why: string) => { console.log(`test-agent-exec-e2e: SKIP — ${why}`); process.exit(0) }
const chromium = await loadChromium()
if (!chromium) skip('playwright-core not found (set PLAYWRIGHT_CORE)')
let browser: any
try { browser = await chromium.launch() } catch (e) { skip(`no browser: ${String((e as Error).message).split('\n')[0]}`) }

let checks = 0
let failures = 0
function ok(condition: boolean, message: string) {
  checks++
  if (condition) console.log(`  ok    ${message}`)
  else { failures++; console.error(`  FAIL  ${message}`) }
}

/** A two-slide stand-in for the editor: answers what the runtime asks, records writes. */
function fakeDeck() {
  const written: Array<{ channel: AgentChannel; payload: Record<string, unknown> }> = []
  const slides: Record<string, { html: string; css: string }> = {
    s1: { html: '<main class="slide"><h1 id="title">Hello</h1><div class="cards"><div id="c1">A</div><div id="c2">B</div><div id="c3">C</div></div></main>', css: '.cards{display:flex;gap:10px}' },
    s2: { html: '<h1 id="title">Two</h1>', css: '' },
  }
  const call = async (channel: AgentChannel, payload: Record<string, unknown>): Promise<AgentResult> => {
    const requestId = 'r'
    const verb = payload.verb
    const args = (payload.args ?? {}) as Record<string, unknown>
    await new Promise((r) => setTimeout(r, 5)) // answers are never synchronous
    if (channel === 'agent-query' && verb === 'outline') return { requestId, ok: true, result: Object.keys(slides).map((id, index) => ({ id, index })) }
    if (channel === 'agent-query' && verb === 'validate') return { requestId, ok: true, result: { ok: true, findings: [{ code: 'text-overflow', slide: 's2', element: 'title', message: 'too long' }] } }
    if (channel === 'slide-request') return { requestId, ok: true, slide: { id: payload.slideId, elements: [{ id: 'title', role: 'title', type: 'text' }] } }
    if (channel === 'agent-action' && verb === 'slide_html' && args.op === 'read') {
      const s = slides[args.slideId as string]
      return s ? { requestId, ok: true, summary: '…', toast: '', ...s } : { requestId, ok: false, error: 'no-such-slide' }
    }
    written.push({ channel, payload })
    if (channel === 'agent-action' && verb === 'slide_html' && args.op === 'write') return { requestId, ok: true, summary: `Wrote ${args.slideId}`, toast: 't' }
    if (channel === 'agent-action' && verb === 'update_element') return { requestId, ok: true, warnings: [] }
    return { requestId, ok: false, error: `stand-in does not know ${channel} ${String(verb)}` }
  }
  return { call, written }
}

async function run(code: string, budgetMs = 5000): Promise<{ out: ProgramOutcome; written: ReturnType<typeof fakeDeck>['written'] }> {
  const page = await browser.newPage()
  const deck = fakeDeck()
  let alive = true
  try {
    const out = await driveProgram({
      load: () => page.setContent(PAGE),
      inPage: (js) => page.evaluate(js),
      call: deck.call,
      alive: () => alive,
    }, code, budgetMs)
    return { out, written: deck.written }
  } finally {
    alive = false
    await page.close().catch(() => {}) // also what stops an endless loop
  }
}

console.log('\nediting a slide through the DOM')
{
  const { out, written } = await run(`
    const d = await deck.slide('s1').dom()
    d.querySelector('#c3').remove()
    d.querySelector('.cards').style.gap = '40px'
    const report = await deck.slide('s1').write(d)
    console.log('wrote', report)
    return { cards: d.querySelectorAll('.cards > div').length }
  `)
  ok(out.ok, `the program ran (${out.error ?? 'ok'})`)
  ok(out.value === '{"cards":2}', `its return value comes back as JSON (${out.value})`)
  ok(out.logs.join('\n') === 'wrote Wrote s1', `console.log output comes back (${JSON.stringify(out.logs)})`)
  const w = written[0]?.payload.args as Record<string, string> | undefined
  ok(written.length === 1 && w?.op === 'write' && w.slideId === 's1', 'one slide_html write went to the deck')
  ok(!!w && !w.html.includes('id="c3"') && w.html.includes('id="c2"'), 'the removed card is gone from the written HTML, the rest is there')
  ok(!!w && /gap:\s*40px/.test(w.html), 'the DOM style change is in the written HTML')
  ok(!!w && w.css.includes('.cards{display:flex;gap:10px}') && !w.html.includes('<style'), 'the slide css travels as css, not inside the html')
  ok(out.calls === 2 && out.writes === 1, `calls counted: 1 read + 1 write (${out.calls}/${out.writes})`)
}

console.log('\nthe deck API')
{
  const { out, written } = await run(`
    const rows = await deck.slides()
    const [a, b] = await Promise.all(rows.map((r) => r.ref.html()))
    const findings = await deck.validate()
    for (const f of findings) await deck.slide(f.slide).update(f.element, { fontSize: 20 })
    return { ids: rows.map((r) => r.id), first: a.html.slice(0, 10), second: b.html, fixed: findings.length, esc: deck.esc('<b>&"') }
  `)
  ok(out.ok, `the program ran (${out.error ?? 'ok'})`)
  const v = out.value ? JSON.parse(out.value) : {}
  ok(v.ids?.join() === 's1,s2' && v.second === '<h1 id="title">Two</h1>', 'slides(), each row\'s ref, html() and Promise.all work')
  ok(v.fixed === 1 && (written[0]?.payload.args as { props?: { fontSize?: number } })?.props?.fontSize === 20, 'validate() findings drive update()')
  ok(v.esc === '&lt;b&gt;&amp;&quot;', 'deck.esc escapes text for HTML')
}

console.log('\nfailures')
{
  const thrown = await run(`await deck.slide('s1').update('title', { color: '#c00' }); throw new Error('boom')`)
  ok(!thrown.out.ok && /boom/.test(thrown.out.error ?? ''), `a throw fails the run with its message (${thrown.out.error?.split('\n')[0]})`)
  ok(thrown.out.writes === 1, 'the edit before it is counted, so the caller knows to roll back')

  const syntax = await run(`return {`)
  ok(!syntax.out.ok && /SyntaxError/.test(syntax.out.error ?? ''), 'a syntax error is reported, not hung on')

  const denied = await run(`return await deck.action('ui_profile', { op: 'get' })`)
  ok(!denied.out.ok && /not available inside a program/.test(denied.out.error ?? ''), 'a denied verb fails the call')
  const nested = await run(`return await deck.action('execute', { code: 'return 1' })`)
  ok(!nested.out.ok && /not available inside a program/.test(nested.out.error ?? ''), 'a program cannot start another program')

  const missing = await run(`return await deck.slide('nope').html()`)
  ok(!missing.out.ok && /no-such-slide/.test(missing.out.error ?? ''), 'a deck error throws in the program with the deck\'s message')

  const net = await run(`try { await fetch('https://example.com/'); return 'fetched' } catch (e) { return 'blocked' }`)
  ok(net.out.ok && net.out.value === '"blocked"', `no network from the page (${net.out.value ?? net.out.error})`)

  const started = Date.now()
  const loop = await run(`while (true) {}`, 1000)
  ok(!loop.out.ok && /ran out of time/.test(loop.out.error ?? ''), 'an endless loop is stopped at the time budget')
  ok(Date.now() - started < 5000, 'and the run comes back promptly')
}

console.log('\nwrites fired without await')
{
  const { out, written } = await run(`deck.slide('s1').update('title', { color: '#c00' }); return 'done'`)
  ok(out.ok && written.length === 1, 'the write still landed before the run ended')
}

console.log('\ncall checks')
ok(checkCall({ id: '1', channel: 'shell', payload: {} }) && 'error' in (checkCall({ id: '1', channel: 'shell', payload: {} }) as object), 'an unknown channel is refused')
ok(checkCall({ id: 1, channel: 'agent-query', payload: {} }) === null, 'a malformed call is dropped')
ok(!('error' in (checkCall({ id: '2', channel: 'agent-query', payload: { verb: 'outline' } }) as object)), 'a normal read passes')

await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
