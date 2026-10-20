#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// API chat E2E: a chat tab with an API profile (no Claude Code, no pty) edits
// the open deck through the same MCP tools Claude Code uses.
//
//   cd desktop && npx electron-vite build && node scripts/e2e-api-chat.mjs
//   (needs slides/dist-single built)
//
// A local mock server speaks the Anthropic AND the OpenAI streaming wire; its
// scripted "model" calls get_slide, then update_element, then answers. Two
// profiles (one per wire) each recolour a different slide's text; the script
// asserts the deck changed (window.beeslides.doc), the chat shows the tool
// rows, tab labels carry the profile names, and a chat resumed from the
// history menu rebuilds its transcript. Same two-mode shape as
// e2e-chat-history.mjs — node runs the ORCHESTRATOR, Electron the DRIVER.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const repo = resolve(desktopDir, '..')
const SHELL_PATH = join(repo, 'slides/dist-single/BeeSlides.beeslides.html')
const BLOCK_RE = /(<script[^>]*\bid=["']beeslides-doc["'][^>]*>)([\s\S]*?)(<\/script>)/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DOC_ID = '0a0a0a0a-0000-4000-8000-00000000a1c1'

let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) failures++
  try { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`) } catch { /* pipe gone */ }
}

if (process.versions.electron) {
  driver().catch(async (err) => {
    ok(false, `driver error: ${err?.stack ?? err}`)
    try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ }
    const { app } = await import('electron')
    app.exit(4)
  })
}
else await orchestrator()

/** The scripted model, shared by both wires: what to do after N tool results. */
function step(target, results, mode = {}) {
  const [slideId, elementId] = target.split(':')
  if (mode.summary) return { text: 'Summary of the work so far.' }
  // FILES=1 FILE=<inside an attached folder> OUT=<outside every attached folder>: read both, then finish.
  if (mode.files) {
    return results === 0 ? { text: '', tools: [{ id: 'file_a', name: 'read_file', args: { path: mode.files.file } }] }
      : results === 1 ? { text: '', tools: [{ id: 'file_b', name: 'read_file', args: { path: mode.files.out } }] }
        : { text: 'FILES DONE' }
  }
  if (mode.slow) return { text: 'Slow answer.' }
  if (mode.child) return results === 0 ? { text: '', tools: [{ id: 'child_a', name: 'get_slide', args: { slideId } }] } : { text: 'child report' }
  if (mode.tasks) {
    return !mode.afterTool
      ? { text: 'Delegating.', tools: [1, 2].map((n) => ({ id: `task_${n}`, name: 'task', args: { description: `Check slide ${n}`, prompt: `child ${n} TARGET=slideA:a1` } })) }
      : { text: 'Done: delegated.' }
  }
  if (results === 0) return { text: 'Looking at the slide.', tools: [{ id: 'call_a', name: 'get_slide', args: { slideId } }] }
  if (results === 1) return { text: '', tools: [{ id: 'call_b', name: 'update_element', args: { slideId, elementId, props: { color: '#ff0000' } } }] }
  return { text: 'Done: the title is red.' }
}

async function startMock(port) {
  const { default: http } = { default: { createServer } }
  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const [name, data] of events) res.write(`${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    res.end()
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    res.on('error', () => {}) // a stopped request hangs up before a SLOW answer is written
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}')
      const textOf = (m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => b.text ?? '').join('') : '')
      const userTexts = body.messages.filter((m) => m.role === 'user').map(textOf)
      const target = userTexts.map((t) => /TARGET=(\S+)/.exec(t)?.[1]).find(Boolean) ?? 'x:y'
      const sysText = JSON.stringify(body.system ?? body.messages[0]?.content ?? '')
      const mode = {
        summary: !(body.tools && body.tools.length),
        child: sysText.includes('subagent working for another agent'),
        tasks: userTexts.some((t) => t.includes('TASKS=1')),
        afterTool: (() => { const l = body.messages.at(-1); return l.role === 'tool' || (Array.isArray(l.content) && l.content.some((b) => b.type === 'tool_result')) })(),
        slow: (userTexts.at(-1) ?? '').includes('SLOW=1'),
        files: userTexts.some((t) => t.includes('FILES=1')) ? { file: /FILE=(\S+)/.exec(userTexts.join(' '))?.[1], out: /OUT=(\S+)/.exec(userTexts.join(' '))?.[1] } : null,
      }
      server.seen.push({ tools: (body.tools ?? []).map((t) => t.name ?? t.function?.name), system: sysText, first: userTexts[0] ?? '' })
      // SLOW=1: answer after a pause, so the test can act while the chat is busy.
      if (mode.slow && !mode.summary) await sleep(2000)
      if (res.destroyed) return
      if (req.url === '/v1/messages') {
        const results = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : [])).length
        const s = step(target, results, mode)
        const ev = [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 } } }]]
        let i = 0
        if (s.text) {
          ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }])
          ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: s.text } }])
          ev.push(['content_block_stop', { type: 'content_block_stop', index: i++ }])
        }
        for (const tool of s.tools ?? []) {
          ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } }])
          ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } }])
          ev.push(['content_block_stop', { type: 'content_block_stop', index: i++ }])
        }
        ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: s.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }])
        ev.push(['message_stop', { type: 'message_stop' }])
        sse(res, ev)
      } else if (req.url === '/v1/chat/completions') {
        const results = body.messages.filter((m) => m.role === 'tool').length
        const s = step(target, results, mode)
        const chunk = (delta, finish = null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })
        const ev = []
        if (s.text) ev.push([null, chunk({ role: 'assistant', content: s.text })])
        ;(s.tools ?? []).forEach((tool, index) => ev.push([null, chunk({ tool_calls: [{ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] })]))
        ev.push([null, chunk({}, s.tools?.length ? 'tool_calls' : 'stop')], [null, '[DONE]'])
        sse(res, ev)
      } else res.writeHead(404).end()
    })
  })
  server.seen = []
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return server
}

async function driver() {
  const { app, BrowserWindow, webContents } = await import('electron')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  BrowserWindow.prototype.show = function () { this.setOpacity(0); this.showInactive() }
  BrowserWindow.prototype.focus = function () {}
  app.dock?.hide()
  const { E2E_PORT: port, E2E_USERDATA: userData, E2E_LAUNCH_LOG: launchLog } = process.env
  const mock = await startMock(Number(port))
  await import(pathToFileURL(join(desktopDir, 'out/main/index.js')).href)
  await app.whenReady()
  const report = () => { try { console.log(`E2E_RESULT ${checks} ${failures}`) } catch { /* */ } }
  const hardStop = setTimeout(() => { ok(false, 'timed out'); report(); app.exit(3) }, 90000)
  async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn().catch(() => null)
      if (v) return v
      if (Date.now() > end) return null
      await sleep(150)
    }
  }
  const findWc = (re, ready) => waitFor(async () => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.isLoading() || !re.test(wc.getURL())) continue
      if (await wc.executeJavaScript(ready)) return wc
    }
    return null
  })
  const wc = await findWc(/BeeSlides\.beeslides\.html/, '!!(window.beeslides && window.beeslides.doc && document.querySelector(".ed-root"))')
  ok(!!wc, 'the deck opened')
  if (!wc) { report(); app.exit(1); return }
  const colorOf = (slide, el) => wc.executeJavaScript(`window.beeslides.doc.slides[${slide}].elements.find((e) => e.id === ${JSON.stringify(el)}).color`)

  // ---- the default profile is the Anthropic-wire API profile: the panel opens a chat tab
  await wc.executeJavaScript('window.slidomingoDesktop.toggleTerminal()')
  const term = await findWc(/terminal/, '!!(window.slidomingoTerminal && document.querySelector(".chat"))')
  ok(!!term, 'the panel opened a chat tab (no pty, no claude launch)')
  if (!term) { report(); app.exit(1); return }
  ok(!existsSync(launchLog) || !readFileSync(launchLog, 'utf8').includes('claude'), 'no `claude` was launched for an API profile')
  const label = () => term.executeJavaScript(`[...document.querySelectorAll('.term-tab-label')].map((n) => n.textContent)`)
  ok((await label()).join() === 'Mock Anthropic · API', `tab label shows the profile name (${(await label()).join()})`)
  ok((await term.executeJavaScript(`document.querySelector('.chat-head').textContent`)).includes('mock-claude'), 'the header shows the model')
  const profiles = await term.executeJavaScript('window.slidomingoTerminal.listProfiles()')
  ok(profiles.profiles.length === 3 && profiles.defaultId === 'api-anthropic', 'listProfiles: all profiles, the default marked')

  const paneId = (n) => term.executeJavaScript(`document.querySelectorAll('.term-pane')[${n}]?.dataset.sessionId`)
  const sendIn = async (id, text) => term.executeJavaScript(`window.slidomingoTerminal.chatSend(${JSON.stringify(id)}, ${JSON.stringify(text)})`)
  const rows = (n) => term.executeJavaScript(`[...document.querySelectorAll('.term-pane')[${n}].querySelectorAll('.chat-tool-name')].map((x) => x.textContent)`)
  const lastAssistant = (n) => term.executeJavaScript(`[...document.querySelectorAll('.term-pane')[${n}].querySelectorAll('.chat-msg.assistant')].pop()?.textContent ?? ''`)

  // ---- chat 1: Anthropic wire edits slide 1
  const id1 = await paneId(0)
  const p0 = `document.querySelectorAll('.term-pane')[0]`
  ok(await term.executeJavaScript(`!!${p0}.querySelector('.chat-empty .chat-empty-mark svg') && ${p0}.querySelector('.chat-send').disabled`), 'an empty chat shows the empty state (logo + title), and Send is disabled')
  await term.executeJavaScript(`window.__sawActivity = false; new MutationObserver(() => { if (${p0}.querySelector('.chat-list > .chat-activity')) window.__sawActivity = true }).observe(${p0}, { childList: true, subtree: true }); true`)
  ok((await colorOf(0, 'a1')) === '#000000', 'before: slide 1 title is black')
  await sendIn(id1, 'make slide 1 title red TARGET=slideA:a1')
  const done1 = await waitFor(async () => ((await lastAssistant(0)).includes('Done') ? true : null), 30000)
  ok(!!done1, 'the model answered after its tool calls')
  ok((await rows(0)).join() === 'get_slide,update_element', `the chat shows both tool rows (${(await rows(0)).join()})`)
  ok((await colorOf(0, 'a1')) === '#ff0000', 'the deck changed: slide 1 title is red')
  ok((await colorOf(1, 'b1')) === '#000000', '…and only that slide')
  ok(await term.executeJavaScript(`document.querySelectorAll('.term-pane')[0].querySelectorAll('.chat-tool:not(.error)').length === 2`), 'no tool row errored')
  ok(await term.executeJavaScript(`document.querySelector('.chat-send').textContent === 'Send'`), 'the button is back to Send when done')
  const footer = await term.executeJavaScript(`document.querySelectorAll('.term-pane')[0].querySelector('.chat-usage')?.textContent ?? ''`)
  ok(/^4\.2k \/ 200k context · 3\.0k cached$/.test(footer), `the usage footer shows context and cache (${footer})`)

  // ---- busy → done feedback, Enter / Esc while busy
  ok(await term.executeJavaScript('window.__sawActivity'), 'an activity row showed while the request ran')
  ok(await term.executeJavaScript(`!${p0}.querySelector('.chat-activity') && !${p0}.querySelector('.chat-empty') && ${p0}.querySelectorAll('.chat-done').length === 1`), '…and is gone after it, replaced by one "Done" marker')
  const isBusy = () => term.executeJavaScript(`!!${p0}.querySelector('.chat-send.stop') && ${p0}.querySelector('.chat-list').getAttribute('aria-busy') === 'true'`)
  const key = (k) => term.executeJavaScript(`${p0}.querySelector('.chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`)
  await sendIn(id1, 'take your time SLOW=1')
  ok(!!(await waitFor(isBusy, 5000)), 'a slow request shows Stop and aria-busy')
  ok(await term.executeJavaScript(`!!${p0}.querySelector('.chat-list > .chat-activity:last-child .chat-phase')?.textContent.endsWith('…')`), 'the activity row is the last thing in the list, with a phase label')
  await term.executeJavaScript(`${p0}.querySelector('.chat-input').value = 'queued text'; true`)
  await key('Enter')
  await sleep(300)
  ok(await isBusy(), 'Enter while busy does not stop the request')
  ok(await term.executeJavaScript(`${p0}.querySelector('.chat-input').value === 'queued text' && ${p0}.querySelector('.chat-hint').textContent.startsWith('Still working')`), '…keeps the text and says how to stop')
  ok(!!(await waitFor(async () => ((await lastAssistant(0)).includes('Slow answer') ? true : null), 10000)), 'the slow request finished normally')
  ok(await term.executeJavaScript(`${p0}.querySelectorAll('.chat-done').length === 2 && !${p0}.querySelector('.chat-stopped')`), '…with a second "Done" marker, not "Stopped"')
  await sendIn(id1, 'and again SLOW=1')
  await waitFor(isBusy, 5000)
  await key('Escape')
  ok(!!(await waitFor(async () => (await term.executeJavaScript(`!!${p0}.querySelector('.chat-stopped') && !${p0}.querySelector('.chat-activity')`)) || null, 5000)), 'Esc while busy stops the request (a "Stopped" marker)')
  ok(await term.executeJavaScript(`${p0}.querySelector('.chat-send').textContent === 'Send' && ${p0}.querySelector('.chat-input').value === 'queued text'`), '…the button is back to Send and the typed text survived')
  await term.executeJavaScript(`${p0}.querySelector('.chat-input').value = ''; true`)

  // ---- chat 2: the "+" caret menu opens the OpenAI-wire profile
  await term.executeJavaScript(`document.getElementById('term-new-menu').click()`)
  const items = await waitFor(async () => (await term.executeJavaScript(`[...document.querySelectorAll('#term-profile-menu:not([hidden]) .term-history-title')].map((n) => n.textContent)`)).join('|') || null, 5000)
  ok(items === 'Mock Anthropic · API|Claude · work|Mock OpenAI · API', `the caret lists every profile (${items})`)
  await term.executeJavaScript(`document.querySelectorAll('#term-profile-menu .term-history-item')[2].click()`)
  const id2 = await waitFor(async () => { const v = await paneId(1); return v || null }, 8000)
  ok(!!id2 && (await label()).join() === 'Mock Anthropic · API,Mock OpenAI · API', 'a second tab opened with the picked profile')
  await sendIn(id2, 'make slide 2 title red TARGET=slideB:b1')
  ok(!!(await waitFor(async () => ((await lastAssistant(1)).includes('Done') ? true : null), 30000)), 'the OpenAI-wire chat finished too')
  ok((await colorOf(1, 'b1')) === '#ff0000', 'the deck changed: slide 2 title is red (via the OpenAI wire)')

  // ---- history: both chats are listed as API chats; one resumes with its transcript
  const chats = await term.executeJavaScript('window.slidomingoTerminal.listChats()')
  ok(chats.length === 2 && chats.every((c) => c.kind === 'api' && c.openIn), `both API chats are in the history, open (${chats.map((c) => c.title).join(' | ')})`)
  ok(chats.some((c) => c.title === 'make slide 1 title red TARGET=slideA:a1'), 'titled by the first message the user typed (without the selection digest)')
  const chat1 = chats.find((c) => c.profileName === 'Mock Anthropic')
  await term.executeJavaScript(`window.slidomingoTerminal.closeTab(${JSON.stringify(id1)})`)
  await waitFor(async () => (await term.executeJavaScript(`document.querySelectorAll('.term-pane').length`)) === 1 || null, 5000)
  ok((await term.executeJavaScript('window.slidomingoTerminal.listChats()')).find((c) => c.id === chat1?.id)?.openIn === null, 'a closed chat stays listed, no longer open')
  await term.executeJavaScript(`document.getElementById('term-history').click()`)
  await waitFor(async () => (await term.executeJavaScript(`document.querySelectorAll('#term-history-menu:not([hidden]) .term-history-item').length`)) === 2 || null, 5000)
  await term.executeJavaScript(`[...document.querySelectorAll('.term-history-item')].find((b) => b.textContent.includes('slide 1'))?.click()`)
  ok(!!(await waitFor(async () => (await term.executeJavaScript(`document.querySelectorAll('.term-pane').length`)) === 2 || null, 8000)), 'picking it in the history menu resumes it in a new tab')
  ok((await rows(1)).join() === 'get_slide,update_element', `the resumed chat rebuilds its tool rows (${(await rows(1)).join()})`)
  ok((await term.executeJavaScript(`document.querySelectorAll('.term-pane')[1].querySelector('.chat-msg.user')?.textContent`)).startsWith('make slide 1 title red'), '…and the user message, without the selection digest')
  ok((await label()).join() === 'Mock OpenAI · API,Mock Anthropic · API', 'it reopens under the profile it ran with')

  // ---- subagents: two `task` calls in one turn → task rows with nested child rows
  const pane = `document.querySelectorAll('.term-pane')[1]`
  const idR = await paneId(1)
  await sendIn(idR, 'check both slides TASKS=1')
  ok(!!(await waitFor(async () => ((await lastAssistant(1)).includes('delegated') ? true : null), 30000)), 'the parent answered after its subagents returned')
  ok(await term.executeJavaScript(`${pane}.querySelectorAll('.chat-task').length === 2`), 'two Subagent rows were rendered')
  const taskNames = await term.executeJavaScript(`[...${pane}.querySelectorAll('.chat-task > summary')].map((n) => n.textContent)`)
  ok(taskNames.every((t) => /^[✓…]Subagent: Check slide \d1 step$/.test(t)), `each reads "Subagent: <description>" with its step count (${taskNames.join(' | ')})`)
  ok(await term.executeJavaScript(`[...${pane}.querySelectorAll('.chat-task')].every((t) => t.querySelectorAll('.chat-children > .chat-tool').length === 1)`), 'the child tool row is nested inside its task row')
  ok(await term.executeJavaScript(`${pane}.querySelectorAll('.chat-list > .chat-tool').length === 4`), 'child rows are not top-level (2 earlier tools + 2 tasks)')
  ok(await term.executeJavaScript(`[...${pane}.querySelectorAll('.chat-task')].every((t) => !t.classList.contains('error'))`), 'no task errored')
  const nestedAfterSync = await term.executeJavaScript(`window.slidomingoTerminal.listChats().then(() => true)`)
  ok(nestedAfterSync === true && /context/.test(await term.executeJavaScript(`${pane}.querySelector('.chat-usage').textContent`)), 'the usage footer updated through the subagent run')
  // /compact: no model turn, a divider in the chat
  await sendIn(idR, '/compact')
  ok(!!(await waitFor(async () => (await term.executeJavaScript(`[...${pane}.querySelectorAll('.chat-msg.divider')].some((d) => d.textContent === 'Conversation compacted')`)) || null, 15000)), '/compact adds a "Conversation compacted" divider')

  // ---- a Claude Code profile: its command, config dir and env reach the pty
  await term.executeJavaScript(`window.slidomingoTerminal.newTab('cc-work').then((s) => s && window.dispatchEvent(new Event('noop')))`)
  const line = await waitFor(async () => (existsSync(launchLog) ? readFileSync(launchLog, 'utf8').split('\n').find((l) => l.includes('claude-work')) : null) || null, 8000)
  ok(!!line && line.startsWith('claude-work --append-system-prompt'), 'the Claude Code profile launches its own command (a shell function)')
  ok(!!line && line.includes(`CONFIG=${resolve(userData, '..', 'work-config')} `), 'CLAUDE_CONFIG_DIR is exported for it')
  ok(!!line && line.includes('TOKEN=k-e2e') && line.includes('LIT=lit'), 'env: $VAR resolved from the login shell, literals passed')
  ok(!!line && !line.split(' CONFIG=')[0].includes('k-e2e'), 'the secret travels in the env only, never in the command string')
  const trust = JSON.parse(readFileSync(join(userData, '..', 'work-config', '.claude.json'), 'utf8'))
  ok(Object.values(trust.projects).some((p) => p.hasTrustDialogAccepted === true), "folder trust is written to the profile's own .claude.json")
  const sessionSettings = (await waitFor(async () => {
    const ws = join(userData, 'claude-workspaces', DOC_ID)
    const { readdirSync } = await import('node:fs')
    for (const d of readdirSync(ws)) for (const s of readdirSync(join(ws, d)).filter((n) => n.startsWith('session-'))) {
      const j = JSON.parse(readFileSync(join(ws, d, s, 'settings.json'), 'utf8'))
      if (j.model === 'fn-model') return j
    }
    return null
  }, 5000))
  ok(!!sessionSettings && sessionSettings.env?.FN_ENV === '1', "the function's own --settings file is merged into the session settings (claude keeps only the last --settings)")
  ok(!!sessionSettings && sessionSettings.hooks.UserPromptSubmit.length === 2 && sessionSettings.hooks.UserPromptSubmit[0].hooks[0].command === 'echo theirs', '…with our hooks added after theirs, not replacing them')

  // ---- attached folders: read-only file tools, confined to the folders, only while one is attached
  const { E2E_ATTACHED: attached, E2E_OUTSIDE: outside } = process.env
  const fchat = await term.executeJavaScript(`window.slidomingoTerminal.newTab('api-anthropic')`)
  ok(!!fchat?.id, 'a new API chat opened for the file tools')
  await term.executeJavaScript('window.slidomingoTerminal.ready()')
  mock.seen.length = 0
  await sendIn(fchat.id, `read my notes FILES=1 FILE=${join(attached, 'notes.md')} OUT=${outside}`)
  ok(!!(await waitFor(async () => (mock.seen.length >= 3 ? true : null), 30000)), 'the model took its three turns')
  const first = mock.seen[0]
  ok(['list_dir', 'read_file', 'grep_files'].every((t) => first.tools.includes(t)), 'with a folder attached the chat is offered list_dir, read_file and grep_files')
  ok(first.system.includes(realpathSync(attached)) && first.system.includes('never write'), '…and the system prompt names the folder and says read-only')
  const fsaved = await waitFor(async () => {
    try { const t = JSON.parse(readFileSync(join(userData, 'api-chats', `${fchat.chatId}.json`), 'utf8')); return t.messages.filter((m) => m.role === 'tool').length >= 2 ? t : null } catch { return null }
  }, 10000)
  const results = (fsaved?.messages ?? []).filter((m) => m.role === 'tool').flatMap((m) => m.results)
  ok(results[0]?.text.includes('quarterly numbers are in data.csv') && !results[0].isError, 'read_file returned the file inside the attached folder')
  ok(results[1]?.isError && /not inside an attached folder/.test(results[1].text) && !results[1].text.includes('TOP SECRET'), 'a file outside the folders is refused, its content never returned')
  await term.executeJavaScript(`window.slidomingoTerminal.removeFolder(${JSON.stringify(realpathSync(attached))})`)
  mock.seen.length = 0
  await sendIn(fchat.id, 'hello again')
  ok(!!(await waitFor(async () => (mock.seen.length >= 1 ? true : null), 20000)), 'a request after detaching the folder')
  ok(!mock.seen[0].tools.some((t) => ['list_dir', 'read_file', 'grep_files'].includes(t)) && !mock.seen[0].system.includes('never write'), '…carries no file tools and no folder note any more')

  // ---- settings IPC: invalid commands never persist, no secret leaves main
  const saved = await wc.executeJavaScript(`window.slidomingoDesktop.saveAiProfiles([
    { id: 'ok', name: 'Work', kind: 'claude-code', command: 'claude-work' },
    { id: 'bad', name: 'Bad', kind: 'claude-code', command: 'claude; rm -rf ~' },
    { id: 'api', name: 'A', kind: 'api', wire: 'openai', baseUrl: 'https://x.example/v1', model: 'm', apiKey: 'sk-should-not-persist' },
  ], 'ok')`)
  ok(saved.profiles.map((p) => p.id).join() === 'ok,api' && saved.defaultId === 'ok', 'saveAiProfiles drops a profile with an unsafe command')
  ok(!JSON.stringify(saved).includes('sk-should-not-persist') && !readFileSync(join(userData, 'app-settings.json'), 'utf8').includes('sk-should-not-persist'), 'a key smuggled into a profile is never stored or returned')
  const imp = await wc.executeJavaScript('window.slidomingoDesktop.importAiShellFunctions()')
  ok(Array.isArray(imp.profiles), 'importAiShellFunctions answers with a list')

  clearTimeout(hardStop)
  mock.close()
  report()
  app.exit(0)
}

async function orchestrator() {
  if (!existsSync(SHELL_PATH)) { console.log(`missing ${SHELL_PATH} — run npm run build:single in slides/`); process.exit(2) }
  if (!existsSync(join(desktopDir, 'out/main/index.js'))) { console.log('missing out/main — run npx electron-vite build'); process.exit(2) }
  const electronPath = createRequire(import.meta.url)('electron')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'slidomingo-e2e-apichat-')))
  const work = join(root, 'work')
  const home = join(root, 'home')
  const userData = join(root, 'userdata')
  for (const d of [work, home, userData]) mkdirSync(d, { recursive: true })
  const { createServer: net } = await import('node:net')
  const port = await new Promise((r) => { const s = net(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  writeFileSync(join(userData, 'app-settings.json'), JSON.stringify({
    aiProfiles: [
      { id: 'api-anthropic', name: 'Mock Anthropic', kind: 'api', wire: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, model: 'mock-claude', apiKeyEnv: 'E2E_KEY' },
      { id: 'cc-work', name: 'Claude · work', kind: 'claude-code', command: 'claude-work', configDir: join(root, 'work-config'), env: { X_TOKEN: '$E2E_KEY', X_LIT: 'lit' }, settingsFile: join(root, 'fn-settings.json') },
      { id: 'api-openai', name: 'Mock OpenAI', kind: 'api', wire: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-gpt', apiKeyEnv: 'E2E_KEY' },
    ],
    defaultAiProfileId: 'api-anthropic',
  }))
  writeFileSync(join(root, 'fn-settings.json'), JSON.stringify({ model: 'fn-model', env: { FN_ENV: '1' }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] } }))
  mkdirSync(join(root, 'work-config'), { recursive: true })
  writeFileSync(join(root, 'work-config', '.claude.json'), JSON.stringify({ projects: {} }))
  // A folder attached to this deck, with a file in it; and a file outside it.
  const attached = join(root, 'notes-folder')
  const outside = join(root, 'elsewhere.txt')
  mkdirSync(attached, { recursive: true })
  writeFileSync(join(attached, 'notes.md'), 'The quarterly numbers are in data.csv\n')
  writeFileSync(outside, 'TOP SECRET\n')
  writeFileSync(join(userData, 'attached-folders.json'), JSON.stringify({ version: 1, decks: [{ docId: DOC_ID, path: null, folders: [attached] }] }))
  const launchLog = join(root, 'launches.log')
  const shell = join(root, 'fake-shell')
  writeFileSync(shell, `#!/bin/sh\n[ "$2" = env ] && exec /usr/bin/env\nprintf '%s CONFIG=%s TOKEN=%s LIT=%s\\n' "$2" "$CLAUDE_CONFIG_DIR" "$X_TOKEN" "$X_LIT" >> '${launchLog}'\nexec cat > /dev/null\n`, { mode: 0o755 })
  const shellHtml = readFileSync(SHELL_PATH, 'utf8')
  const { newDoc } = await import(join(repo, 'slides/src/model.ts'))
  const doc = Object.assign(newDoc(), { title: 'ApiChat', docId: DOC_ID })
  const text = (id) => ({ id, type: 'text', x: 80, y: 60, w: 800, h: 100, rotation: 0, opacity: 1, html: 'Title', fontSize: 48, fontFamily: 'system-ui, sans-serif', fontWeight: 700, color: '#000000', align: 'left', valign: 'top', lineHeight: 1.1 })
  doc.slides[0].id = 'slideA'
  doc.slides[0].elements = [text('a1')]
  doc.slides.push({ ...doc.slides[0], id: 'slideB', elements: [text('b1')] })
  const deck = join(work, 'ApiChat.beeslides.html')
  writeFileSync(deck, shellHtml.replace(BLOCK_RE, (_m, a, _b, c) => `${a}\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n${c}`))
  const res = spawnSync(electronPath, [fileURLToPath(import.meta.url), '--open', deck], {
    cwd: desktopDir,
    env: {
      ...process.env, SHELL: shell, HOME: home, E2E_KEY: 'k-e2e', E2E_PORT: String(port), E2E_LAUNCH_LOG: launchLog, E2E_USERDATA: userData, E2E_ATTACHED: attached, E2E_OUTSIDE: outside,
      SLIDOMINGO_USER_DATA: userData, SLIDOMINGO_TEMPLATES_DIR: join(root, 'templates'),
      ELECTRON_RENDERER_URL: '', SLIDOMINGO_DEV_URL: '',
    },
    encoding: 'utf8', timeout: 120000,
  })
  const out = res.stdout ?? ''
  for (const line of out.split('\n')) if (/^\s+(ok|FAIL|debug)\s/.test(line)) console.log(line)
  const m = out.match(/E2E_RESULT (\d+) (\d+)/)
  if (!m) { console.log(`FAIL  no result (exit ${res.status})\n${(res.stderr ?? '').split('\n').slice(-15).join('\n')}`); process.exit(1) }
  checks += Number(m[1]); failures += Number(m[2])
  console.log(`\n${checks - failures}/${checks} checks passed   (profile: ${root})`)
  if (failures) process.exit(1)
}
