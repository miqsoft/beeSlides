#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// AI chat profiles + API chat rig.
//
//   node scripts/test-ai-profiles.ts
//
// WHAT THIS PROVES (desktop/src/main/aiprofiles.ts, claudeLaunch.ts, apichat/):
//  1. A profile's command is whitelisted before it can reach the pty command
//     line (no `;`, spaces, quotes, `$`), env `$VAR`s resolve from the login
//     shell and never into the command string, and a function's own
//     --settings file is merged (claude keeps only the LAST --settings).
//  2. The neutral transcript maps to the Anthropic and OpenAI wires and back,
//     incl. screenshots (image blocks / follow-up image_url user message).
//  3. The full agent loop — real SDK streaming against a local mock server
//     speaking both wires, the REAL slides MCP server over stdio, a fake app
//     answering its request files — calls get_slide then update_element and
//     the "deck" changes, with tool rows reported.

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isValidCommand, sanitizeProfile, sanitizeProfiles, resolveEnv, referencedVars, parseFunctionList, settingsFileFromFunction,
  configDirFromFunction, invokesClaude, mergeSettings, nameForFunction, tabLabel, type ApiProfile,
} from '../desktop/src/main/aiprofiles.ts'
import { claudeInstruction, claudeLaunchCommand } from '../desktop/src/main/claudeLaunch.ts'
import { toAnthropicMessages, toAnthropicTools, anthropicAuth, anthropicReasoningBody } from '../desktop/src/main/apichat/providers/anthropic.ts'
import { toOpenAIMessages, toOpenAITools } from '../desktop/src/main/apichat/providers/openai.ts'
import { ApiChatSession, displayFromMessages } from '../desktop/src/main/apichat/session.ts'
import { loadTranscript, saveTranscript, transcriptPath } from '../desktop/src/main/apichat/transcript.ts'
import { anthropicProvider } from '../desktop/src/main/apichat/providers/anthropic.ts'
import { openaiProvider } from '../desktop/src/main/apichat/providers/openai.ts'
import { jsonValues, toolCallsFrom } from '../desktop/src/main/apichat/providers/lenientjson.ts'
import { chooseCut, resolveSummaries, SUMMARY_PREFIX, SUMMARIZER_SYSTEM } from '../desktop/src/main/apichat/compact.ts'
import { estimateTokens } from '../desktop/src/main/apichat/tokens.ts'
import { parseSkill, mergeSkills, readSkill, expandSlash, type Skill } from '../desktop/src/main/apichat/skills.ts'
import { SUBAGENT_PREAMBLE } from '../desktop/src/main/apichat/subagent.ts'
import { chmodSync, symlinkSync } from 'node:fs'
import { quickReference } from '../desktop/src/main/apichat/prompt.ts'
import type { ChatEvent, ChatMsg } from '../desktop/src/main/apichat/types.ts'
import { providerFor } from '../desktop/src/main/apichat/providers/index.ts'
import { isReasoningReject } from '../desktop/src/main/apichat/providers/reasoning.ts'
import { outputCapFromError, withOutputCap, DEFAULT_MAX_TOKENS } from '../desktop/src/main/apichat/providers/outputcap.ts'
import { IMAGE_OMITTED_NOTE, isImageReject, knownTextOnly, withImageFallback, withoutImages } from '../desktop/src/main/apichat/providers/images.ts'
import { elidableChars, elideOldResults, ELIDE_TRIGGER_CHARS, KEEP_RECENT_ROUNDS } from '../desktop/src/main/apichat/elide.ts'
import { apiVisionHelper, claudeVisionCommand, parseClaudeResult, LOOK_TOOL_NAME, type VisionHelper } from '../desktop/src/main/apichat/vision.ts'
import { compactConversation } from '../desktop/src/main/apichat/compact.ts'
import { runAgent } from '../desktop/src/main/apichat/loop.ts'
import { serverWithAgentAreas } from '../desktop/src/main/agenttools.ts'
import { McpClient } from '../desktop/src/main/apichat/mcp.ts'
import { agentFindText } from '../slides/src/editor/findtext.ts'
import { CustomizeChat, customizeSystemPrompt } from '../desktop/src/main/apichat/customizechat.ts'
import { UI_PROFILE_TOOL, catalogFor, runUiProfileTool } from '../desktop/src/main/uiprofiletool.ts'
import { currentProfile, revertProfile, type UiChange, type UiProfileService } from '../desktop/src/main/uiprofilefs.ts'
import { spawn } from 'node:child_process'

let failures = 0
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

// ---- 1. profiles -----------------------------------------------------------
for (const good of ['claude', 'claude-work', 'claude_gateway2', '/opt/homebrew/bin/claude', './claude']) ok(isValidCommand(good), `command accepted: ${good}`)
for (const bad of ['claude; rm -rf ~', 'claude work', "claude'", 'claude"', 'claude$(x)', 'claude`x`', '', '-rf', 'a|b', 'a&b', 'a\nb', 5, null]) ok(!isValidCommand(bad as string), `command rejected: ${JSON.stringify(bad)}`)

ok(sanitizeProfile({ id: 'a', name: 'A', kind: 'claude-code', command: 'claude;x' }) === null, 'profile with a bad command is dropped')
ok(sanitizeProfile({ id: 'a b', name: 'A', kind: 'claude-code', command: 'claude' }) === null, 'profile with a bad id is dropped')
ok(sanitizeProfile({ id: 'a', name: 'A', kind: 'api', wire: 'openai', baseUrl: 'file:///x', model: 'm' }) === null, 'api profile with a non-http url is dropped')
const cc = sanitizeProfile({ id: 'w', name: 'W', kind: 'claude-code', command: 'claude-work', configDir: '/Users/x/.claude-work', env: { OK_VAR: '$KEY', 'bad name': 'x', GOOD: 'v' }, evil: 1 })
ok(cc?.kind === 'claude-code' && cc.env?.OK_VAR === '$KEY' && cc.env?.GOOD === 'v' && !('bad name' in (cc.env ?? {})) && !('evil' in cc), 'claude-code profile keeps valid env, drops invalid names and unknown fields')
const api = sanitizeProfile({ id: 'f', name: 'Gateway', kind: 'api', wire: 'anthropic', baseUrl: 'https://x.example///', model: 'm', apiKeyEnv: 'GATEWAY_API_KEY', maxTokens: 4096, hasStoredKey: true }) as ApiProfile
ok(api?.baseUrl === 'https://x.example' && api.maxTokens === 4096 && !('hasStoredKey' in api), 'api profile: trailing slashes trimmed, hasStoredKey never persisted')
ok(sanitizeProfile({ id: 'f', name: 'F', kind: 'api', wire: 'anthropic', baseUrl: 'https://x', model: 'm', apiKeyEnv: 'a b' }) === null, 'api key env name is validated')
ok(sanitizeProfiles([cc, cc, api, 'junk']).length === 2, 'sanitizeProfiles drops duplicates and junk')
ok(tabLabel(api) === 'Gateway · API' && tabLabel({ ...api, name: 'My API' }) === 'My API', 'tab label marks API profiles')

const lookup = (n: string) => ({ KEY: 'secret', EMPTY: '' } as Record<string, string | undefined>)[n]
const resolved = resolveEnv({ A: '$KEY', B: '${KEY}', C: 'literal', D: '$MISSING', E: '$EMPTY', 'bad-name': 'x' }, lookup)
ok(resolved.A === 'secret' && resolved.B === 'secret' && resolved.C === 'literal', '$VAR / ${VAR} resolve from the lookup, literals pass through')
ok(!('D' in resolved) && !('E' in resolved) && !('bad-name' in resolved), 'unresolved/empty refs and bad names are omitted, never passed as literal "$VAR"')
ok(referencedVars({ A: '$X', B: 'lit', C: '${Y}' }).join() === 'X,Y', 'referencedVars lists the shell variables to fetch')

const launch = claudeLaunchCommand('ctx', 'ctx/session-1', { id: '11111111-1111-1111-1111-111111111111', resume: false }, undefined, true, 'claude-gateway')
ok(launch.startsWith("claude-gateway --append-system-prompt '") && launch.includes('--session-id 11111111-1111-1111-1111-111111111111') && launch.includes('--settings ./ctx/session-1/settings.json'), 'launch line uses the profile command')
ok(claudeLaunchCommand('c', 'c/s', { id: '11111111-1111-1111-1111-111111111111', resume: true }).startsWith('claude --append'), 'default command stays `claude`')
// The system prompt sits inside single quotes on the zsh -lic line: one stray ' (a possessive) ends the quote and zsh dies with "parse error near `)'".
ok(!claudeInstruction('ctx').match(/['`$\\]/), 'system-prompt addendum has no shell-special characters (quote, backtick, $, backslash)')
let threw = false
try { claudeLaunchCommand('c', 'c/s', { id: '11111111-1111-1111-1111-111111111111', resume: false }, undefined, false, 'claude; touch /tmp/x') } catch { threw = true }
ok(threw, 'launch line builder refuses an unsafe command')
ok(!launch.includes('secret'), 'no env values in the command string')

ok(parseFunctionList('claude-work\nclaude-gateway\nclaude-work\nclaude evil\nnotclaude\n\nclaude-x;y').join() === 'claude-gateway,claude-work', 'shell function list: de-duplicated, unsafe/foreign names dropped')
const gwBody = 'claude-gateway () {\n\tANTHROPIC_AUTH_TOKEN="$GATEWAY_API_KEY" command claude --settings "$HOME/.claude/claude.gateway.local.json" "$@"\n}'
ok(settingsFileFromFunction(gwBody, '/Users/x') === '/Users/x/.claude/claude.gateway.local.json', "a function's --settings file is found, $HOME expanded")
ok(settingsFileFromFunction('f () { command claude "$@" }', '/h') === null, 'no --settings → null')
ok(settingsFileFromFunction('f () { command claude --settings "$(evil)/x.json" }', '/h') === null, 'a computed settings path is not followed')
ok(configDirFromFunction('claude-work () {\n CLAUDE_CONFIG_DIR="$HOME/.claude-work" command claude "$@"\n}', '/Users/x') === '/Users/x/.claude-work', 'CLAUDE_CONFIG_DIR lifted from a function')
ok(invokesClaude(gwBody) && invokesClaude('claude-work () {\n CLAUDE_CONFIG_DIR=x command claude "$@"\n}') && !invokesClaude('claude-gateway-proxy-stop () {\n pkill -f "gateway_proxy.py" && echo "proxy stopped"\n}'), 'functions that do not run claude (…-proxy-stop) are not offered as profiles')
ok(nameForFunction('claude-work') === 'Claude · work' && nameForFunction('claude') === 'Claude', 'function → readable profile name')

const merged = mergeSettings(
  { model: 'm1', env: { A: '1' }, hooks: { UserPromptSubmit: [{ id: 'theirs' }], Stop: [{ id: 's' }] } },
  { hooks: { UserPromptSubmit: [{ id: 'ours' }], SessionStart: [{ id: 'note' }] } },
) as { model: string; env: Record<string, string>; hooks: Record<string, Array<{ id: string }>> }
ok(merged.model === 'm1' && merged.env.A === '1', 'merged settings keep the function\'s model/env')
ok(merged.hooks.UserPromptSubmit.map((h) => h.id).join() === 'theirs,ours' && merged.hooks.Stop.length === 1 && merged.hooks.SessionStart.length === 1, 'hooks concatenated per event')
ok(mergeSettings(null, { hooks: {} }) !== null, 'merge tolerates a missing base')

// API chats in the shared history (chathistory.ts)
{
  const { addRecord, listChats } = await import('../desktop/src/main/chathistory.ts')
  const dir = mkdtempSync(join(tmpdir(), 'ai-hist-'))
  const store = join(dir, 'chat-history.json')
  const apiDir = join(dir, 'api-chats')
  mkdirSync(apiDir)
  const id = '77777777-7777-7777-7777-777777777777'
  addRecord(store, { id, docId: 'd1', path: null, startedAt: 1000, profileId: 'p1', kind: 'api' })
  ok(listChats(store, join(dir, 'none'), { docId: 'd1', path: null }, 2000, { apiDir }).length === 0, 'an API chat without a transcript is not listed yet')
  writeFileSync(join(apiDir, `${id}.json`), JSON.stringify({ version: 1, profileId: 'p1', messages: [{ role: 'user', text: 'digest\n\nfix the title', shown: 'fix the title' }] }))
  const [row] = listChats(store, join(dir, 'none'), { docId: 'd1', path: null }, 2000, { apiDir })
  ok(row?.title === 'fix the title' && row.kind === 'api' && row.profileId === 'p1', 'an API chat is listed by what the user typed, with its profile')
}

// ---- 2. wire mapping ---------------------------------------------------------
const img = { data: 'AAAA', mimeType: 'image/png' }
const convo: ChatMsg[] = [
  { role: 'user', text: 'ctx\n\nmake it red', shown: 'make it red' },
  { role: 'assistant', text: 'Looking.', toolCalls: [{ id: 't1', name: 'review_slide', args: { slideId: 's1' } }] },
  { role: 'tool', results: [{ id: 't1', name: 'review_slide', text: 'ok', images: [img], isError: false }] },
  { role: 'assistant', text: '', toolCalls: [{ id: 't2', name: 'get_slide', args: { slideId: 's1' } }] },
  { role: 'tool', results: [{ id: 't2', name: 'get_slide', text: 'boom', images: [], isError: true }] },
]
const am = toAnthropicMessages(convo) as Array<{ role: string; content: any }>
ok(am[0].content === 'ctx\n\nmake it red', 'anthropic: user text is the model-visible text (with digest)')
ok(am[1].content[0].type === 'text' && am[1].content[1].type === 'tool_use' && am[1].content[1].input.slideId === 's1', 'anthropic: assistant text + tool_use')
ok(am[2].content[0].type === 'tool_result' && am[2].content[0].content.every((b: any) => b.type !== 'image'), 'anthropic: an OLD screenshot is not re-sent')
ok(am[3].content.length === 1 && am[3].content[0].type === 'tool_use', 'anthropic: empty assistant text omitted')
ok(am[4].content[0].is_error === true, 'anthropic: error result flagged')
const amLast = toAnthropicMessages(convo.slice(0, 3)) as Array<{ content: any }>
ok(amLast[2].content[0].content.some((b: any) => b.type === 'image' && b.source.data === 'AAAA' && b.source.media_type === 'image/png'), 'anthropic: the latest screenshot is an image block inside tool_result')
const at = toAnthropicTools([{ name: 'n', description: 'd', inputSchema: { type: 'object' } }])
ok(at[0].input_schema.type === 'object', 'anthropic: tool schema → input_schema')
ok(JSON.stringify(anthropicAuth('https://api.anthropic.com', 'k')) === '{"apiKey":"k"}' && JSON.stringify(anthropicAuth('https://gateway.example', 'k')) === '{"authToken":"k"}', 'anthropic: x-api-key for api.anthropic.com, Bearer for compatible endpoints')

const om = toOpenAIMessages('SYS', convo.slice(0, 3)) as Array<Record<string, any>>
ok(om[0].role === 'system' && om[0].content === 'SYS', 'openai: system message first')
ok(om[2].role === 'assistant' && om[2].tool_calls[0].function.arguments === '{"slideId":"s1"}', 'openai: tool_calls with JSON-string arguments')
ok(om[3].role === 'tool' && om[3].tool_call_id === 't1', 'openai: tool result as tool message')
ok(om[4].role === 'user' && om[4].content.some((p: any) => p.type === 'image_url' && p.image_url.url === 'data:image/png;base64,AAAA'), 'openai: screenshot follows as a user message with image_url')
ok(toOpenAITools([{ name: 'n', description: 'd', inputSchema: { type: 'object' } }])[0].function.parameters.type === 'object', 'openai: tool schema → function.parameters')
ok(quickReference('# T\n\n## Quick reference (x)\nA\nB\n\n## Next\nC').includes('B') && !quickReference('# T\n\n## Quick reference (x)\nA\n\n## Next\nC').includes('C'), 'quickReference stops at the next section')

// ---- 3. the whole loop against a mock server + the real MCP server -----------
const here = dirname(fileURLToPath(import.meta.url))
const serverScript = join(here, '../desktop/src/mcp/slides-mcp-server.mjs')
const work = mkdtempSync(join(tmpdir(), 'ai-profiles-'))
const shared = join(work, 'shared')
const sessionDir = join(shared, 'session-x')
mkdirSync(sessionDir, { recursive: true })
// Written the way the app writes it: with the grouped `deck` tool filled in.
writeFileSync(join(shared, 'slides-mcp-server.mjs'), serverWithAgentAreas(readFileSync(serverScript, 'utf8')))
writeFileSync(join(shared, 'agents.md'), '# g\n\n## Quick reference (x)\nuse update_element\n\n## More\nz')
writeFileSync(join(shared, 'format.md'), '# format spec')
writeFileSync(join(shared, 'selection.json'), JSON.stringify({ slideId: 's2', selection: [{ id: 'title', type: 'text', text: 'Hello' }] }))

// A fake "app": answers the MCP server's request files like the editor would.
const deck: Record<string, { id: string; elements: Array<{ id: string; color: string }> }> = { s2: { id: 's2', elements: [{ id: 'title', color: 'black' }] } }
// A fuller slide for get_slide view "summary" and find_text.
const mcpSlide = {
  id: 's9', name: 'MCP auth', layoutId: 'content', notes: '<p>Mention the <b>OAuth</b> step.</p>',
  elements: [
    { id: 'h', type: 'text', role: 'title', x: 96, y: 40, w: 1088, h: 80, fontSize: 44, html: 'How authentication works in <b>MCP</b>' },
    { id: 'tbl', type: 'table', x: 96, y: 200, w: 600, h: 200, columns: [{ w: 300 }, { w: 300 }], rows: [{ cells: [{ html: 'Step' }, { html: 'Who' }] }, { cells: [{ html: 'Token refresh &amp; scopes' }, { html: 'Client' }] }] },
    { id: 'ch', type: 'chart', x: 700, y: 200, w: 400, h: 300, preset: 'bar', alt: 'Latency per step', option: { title: { text: 'Handshake latency' }, xAxis: { data: ['Discover', 'Authorize'] }, series: [{ name: 'ms', data: [12, 40] }] } },
    { id: 'pic', type: 'image', x: 0, y: 0, w: 10, h: 10, alt: 'Señal diagram', src: 'data:x' },
  ],
}
const findDoc = { slides: [{ id: 's2', elements: [{ id: 'title', type: 'text', html: 'Hello' }], notes: '' }, mcpSlide] }
const plain = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&')
const written = new Set<string>()
const watcher = watch(sessionDir, (_ev, name) => {
  if (!name || written.has(name)) return
  try {
    if (/^slide-request-.*\.json$/.test(name)) {
      const req = JSON.parse(readFileSync(join(sessionDir, name), 'utf8'))
      written.add(name)
      writeFileSync(join(sessionDir, name.replace('slide-request', 'slide-response')), JSON.stringify({ requestId: req.requestId, ok: true, slide: req.slideId === 's9' ? mcpSlide : deck[req.slideId] }))
    } else if (/^agent-query-.*\.json$/.test(name) && !name.includes('result')) {
      const req = JSON.parse(readFileSync(join(sessionDir, name), 'utf8'))
      written.add(name)
      const result = req.verb === 'find_text' ? agentFindText(findDoc as never, String(req.args.query ?? ''), typeof req.args.limit === 'number' ? req.args.limit : 40, plain) : null
      writeFileSync(join(sessionDir, name.replace('agent-query', 'agent-query-result')), JSON.stringify({ requestId: req.requestId, ok: !!result, result, error: result ? undefined : 'unknown verb' }))
    } else if (/^agent-action-.*\.json$/.test(name) && !name.includes('result')) {
      const req = JSON.parse(readFileSync(join(sessionDir, name), 'utf8'))
      written.add(name)
      if (req.verb === 'update_element') for (const e of deck[req.args.slideId].elements) if (e.id === req.args.elementId) Object.assign(e, req.args.props ?? {})
      writeFileSync(join(sessionDir, name.replace('agent-action', 'agent-action-result')), JSON.stringify({ requestId: req.requestId, ok: true, summary: 'updated' }))
    }
  } catch { /* file not fully written yet — the next event retries */ }
})

/** One scripted model, served on both wires: step by the number of tool results seen. */
function scriptedStep(toolResultCount: number): { text: string; tool?: { id: string; name: string; args: object } } {
  if (toolResultCount === 0) return { text: 'Let me look.', tool: { id: 'call_1', name: 'get_slide', args: { slideId: 's2' } } }
  if (toolResultCount === 1) return { text: '', tool: { id: 'call_2', name: 'update_element', args: { slideId: 's2', elementId: 'title', props: { color: 'red' } } } }
  return { text: 'Done: the title is red.' }
}
const requests: Array<{ path: string; headers: IncomingMessage['headers']; body: any }> = []
let mockUsage: { input: number; cacheRead: number; cacheWrite: number; output: number } | null = { input: 1000, cacheRead: 5000, cacheWrite: 200, output: 50 }
let rejectMode: 'cache' | 'stream_options' | null = null
const SUMMARY_TEXT = 'SUMMARY: the user wants the title red; slide s2 element title touched.'
function sse(res: ServerResponse, events: Array<[string | null, unknown]>) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [name, data] of events) res.write(`${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
  res.end()
}
const mock = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    requests.push({ path: req.url ?? '', headers: req.headers, body })
    const reject = (message: string) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } })) }
    if (rejectMode === 'cache' && JSON.stringify(body).includes('cache_control')) { reject('cache_control: Extra inputs are not permitted'); return }
    if (rejectMode === 'stream_options' && body.stream_options) { reject("Unknown parameter: 'stream_options'"); return }
    const isSummary = !(body.tools && body.tools.length)
    if (req.url === '/v1/messages') {
      const results = body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result') : [])).length
      const step = isSummary ? { text: SUMMARY_TEXT } : scriptedStep(results)
      const ev: Array<[string, unknown]> = [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: mockUsage ? { input_tokens: mockUsage.input, output_tokens: mockUsage.output, cache_read_input_tokens: mockUsage.cacheRead, cache_creation_input_tokens: mockUsage.cacheWrite } : { input_tokens: 0, output_tokens: 0 } } }]]
      let idx = 0
      if (step.text) {
        ev.push(['content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }])
        ev.push(['content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: step.text } }])
        ev.push(['content_block_stop', { type: 'content_block_stop', index: idx++ }])
      }
      if (step.tool) {
        ev.push(['content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: step.tool.id, name: step.tool.name, input: {} } }])
        const json = JSON.stringify(step.tool.args)
        ev.push(['content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: json.slice(0, 10) } }])
        ev.push(['content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: json.slice(10) } }])
        ev.push(['content_block_stop', { type: 'content_block_stop', index: idx++ }])
      }
      ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }])
      ev.push(['message_stop', { type: 'message_stop' }])
      sse(res, ev)
    } else if (req.url === '/v1/chat/completions') {
      const results = body.messages.filter((m: any) => m.role === 'tool').length
      const step = isSummary ? { text: SUMMARY_TEXT } : scriptedStep(results)
      const chunk = (delta: object, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })
      const ev: Array<[null, unknown]> = []
      if (step.text) ev.push([null, chunk({ role: 'assistant', content: step.text })])
      if (step.tool) {
        const json = JSON.stringify(step.tool.args)
        ev.push([null, chunk({ tool_calls: [{ index: 0, id: step.tool.id, type: 'function', function: { name: step.tool.name, arguments: json.slice(0, 7) } }] })])
        ev.push([null, chunk({ tool_calls: [{ index: 0, function: { arguments: json.slice(7) } }] })])
      }
      ev.push([null, chunk({}, step.tool ? 'tool_calls' : 'stop')])
      if (mockUsage && body.stream_options?.include_usage) {
        ev.push([null, { id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: mockUsage.input + mockUsage.cacheRead + mockUsage.cacheWrite, completion_tokens: mockUsage.output, prompt_tokens_details: { cached_tokens: mockUsage.cacheRead } } }])
      }
      ev.push([null, '[DONE]'])
      sse(res, ev)
    } else { res.writeHead(404).end() }
  })
})
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`

for (const wire of ['anthropic', 'openai'] as const) {
  console.log(`\n-- ${wire} wire --`)
  deck.s2.elements[0].color = 'black'
  requests.length = 0
  const profile: ApiProfile = { id: `p-${wire}`, name: wire, kind: 'api', wire, baseUrl: wire === 'openai' ? `${base}/v1` : base, model: 'mock-model', maxTokens: 512 }
  const chatId = wire === 'openai' ? '22222222-2222-2222-2222-222222222222' : '11111111-1111-1111-1111-111111111111'
  const tdir = join(work, 'api-chats')
  const session = new ApiChatSession({ chatId, profile, apiKey: 'k-123', sessionDir, sharedDir: shared, transcriptDir: tdir }, false)
  const events: ChatEvent[] = []
  session.onEvent((e) => events.push(e))
  await session.send('make the title red')
  const names = events.filter((e) => e.type === 'tool-start').map((e) => (e as { name: string }).name)
  ok(names.join() === 'get_slide,update_element', 'the model called get_slide, then update_element')
  ok(deck.s2.elements[0].color === 'red', 'the deck changed through the real MCP server')
  const ends = events.filter((e) => e.type === 'tool-end') as Array<Extract<ChatEvent, { type: 'tool-end' }>>
  ok(ends.length === 2 && ends.every((e) => !e.isError), 'both tool calls ended without error')
  ok(ends[0].text.includes('"title"'), 'get_slide result reached the model-side result')
  ok(events.some((e) => e.type === 'text-delta' && e.text.includes('Done')) && events.at(-2)?.type === 'done', 'final text streamed, then done')
  ok(events.filter((e) => e.type === 'busy').map((e) => (e as { busy: boolean }).busy).join() === 'true,false', 'busy toggled once')
  ok(requests.length === 3, `three completions (got ${requests.length})`)
  const first = requests[0]
  ok(wire === 'anthropic' ? first.headers.authorization === 'Bearer k-123' && !first.headers['x-api-key'] : first.headers.authorization === 'Bearer k-123', 'key sent as Bearer to a compatible endpoint')
  const sysText = wire === 'anthropic' ? JSON.stringify(first.body.system) : first.body.messages[0].content
  ok(sysText.includes('use update_element') && !sysText.includes('## More'), 'system prompt carries the agents.md quick reference only')
  const toolNames = (first.body.tools as any[]).map((t) => t.name ?? t.function.name)
  ok(toolNames.includes('get_slide') && toolNames.includes('update_element') && toolNames.includes('read_reference'), 'tool set = MCP tools + read_reference')
  const rawFirst = wire === 'anthropic' ? first.body.messages[0].content : first.body.messages[1].content
  const firstUser: string = typeof rawFirst === 'string' ? rawFirst : rawFirst.map((b: any) => b.text).join('')
  ok(firstUser.startsWith('[slidomingo editing context]') && firstUser.includes('selected: title text') && firstUser.endsWith('make the title red'), 'first user message carries the selection digest')
  // caching + usage on the wire
  if (wire === 'anthropic') {
    const last = requests[2].body
    const lastMsg = last.messages.at(-1)
    ok(Array.isArray(first.body.system) && first.body.system[0].cache_control?.type === 'ephemeral', 'anthropic: system prompt carries cache_control')
    ok(first.body.tools.at(-1).cache_control?.type === 'ephemeral' && first.body.tools.slice(0, -1).every((t: any) => !t.cache_control), 'anthropic: only the last tool is a cache breakpoint')
    ok(Array.isArray(first.body.messages[0].content) && first.body.messages[0].content.at(-1).cache_control?.type === 'ephemeral', 'anthropic: a string user message becomes a text block with cache_control')
    ok(Array.isArray(lastMsg.content) && lastMsg.content.at(-1).cache_control?.type === 'ephemeral', 'anthropic: the last block of the last message is a cache breakpoint')
    ok(last.messages.slice(0, -1).every((m: any) => !Array.isArray(m.content) || m.content.every((b: any) => !b.cache_control)), 'anthropic: no other message carries cache_control')
  } else {
    ok(first.body.stream_options?.include_usage === true, 'openai: stream_options.include_usage requested')
  }
  const usageEvs = events.filter((e) => e.type === 'usage') as Array<Extract<ChatEvent, { type: 'usage' }>>
  ok(usageEvs.length === 3 && usageEvs.every((u) => u.contextTokens === 6200 && u.cacheRead === 5000 && u.contextWindow === (wire === 'openai' ? 128000 : 200000)), `usage events report the mocked numbers (${usageEvs.map((u) => u.contextTokens).join(',')}; default window per wire)`)
  ok(session.lastUsage?.contextTokens === 6200, 'the session keeps lastUsage for sync()')
  const t = loadTranscript(tdir, chatId)
  ok(!!t && t.profileId === profile.id && t.version === 2 && t.archive.length === 0 && t.messages.length === 6, `transcript persisted (${t?.messages.length} messages)`)
  ok(session.display.map((d) => d.kind).join() === 'user,assistant,tool,tool,assistant', `display list: ${session.display.map((d) => d.kind).join()}`)
  const resumed = new ApiChatSession({ chatId, profile, apiKey: 'k', sessionDir, sharedDir: shared, transcriptDir: tdir, tools: { defs: [], call: async () => ({ text: '', images: [], isError: false }) } }, true)
  ok(resumed.display.length === 5 && resumed.display[0].kind === 'user' && (resumed.display[0] as { text: string }).text === 'make the title red', 'a resumed chat rebuilds its display (user text without the digest)')
  resumed.dispose()
  session.dispose()
}

// ---- reading cheaply: find_text and get_slide view "summary" through the real MCP server
{
  console.log('\n-- find_text, get_slide summary --')
  const mcp = new McpClient(join(shared, 'slides-mcp-server.mjs'), sessionDir)
  const defs = await mcp.start()
  ok(defs.some((d) => d.name === 'deck'), 'the written server carries the grouped deck tool')
  ok(defs.some((d) => d.name === 'find_text') && JSON.stringify(defs.find((d) => d.name === 'get_slide')?.inputSchema).includes('summary'), 'the MCP server offers find_text and get_slide view "summary"')
  const full = await mcp.callTool('get_slide', { slideId: 's9' })
  const sum = await mcp.callTool('get_slide', { slideId: 's9', view: 'summary' })
  console.log(sum.text.split('\n').map((l) => `        ${l}`).join('\n'))
  ok(!sum.isError && sum.text.includes('h text role=title @96,40 1088x80 44px "How authentication works in MCP"'), 'summary: one line per element with role, frame, size and plain text')
  ok(sum.text.includes('| Token refresh & scopes | Client |') && sum.text.includes('tbl table @96,200 600x200 2x2'), 'summary: table cells as rows, entities decoded')
  ok(sum.text.includes('title="Handshake latency"') && sum.text.includes('x=Discover, Authorize') && sum.text.includes('alt="Latency per step"'), 'summary: chart title, labels and alt')
  ok(sum.text.includes('Notes: Mention the OAuth step.'), 'summary: speaker notes as plain text')
  ok(sum.text.length < full.text.length, `summary is smaller than the full JSON (${sum.text.length} vs ${full.text.length} chars)`)
  const hits = await mcp.callTool('find_text', { query: 'oauth|refresh' })
  ok(!hits.isError && hits.text.startsWith('2 hit(s)') && hits.text.includes('s9 #1 "MCP auth" tbl table: "Step | Who / Token refresh & scopes | Client"') && hits.text.includes('s9 #1 "MCP auth" (notes)'), `find_text: alternatives, table and notes hits with slide index and name\n${hits.text}`)
  const accents = await mcp.callTool('find_text', { query: 'senal' })
  ok(accents.text.includes('pic alt'), 'find_text: accent-insensitive, alt text searched')
  const chart = await mcp.callTool('find_text', { query: 'authorize' })
  ok(chart.text.includes('ch chart'), 'find_text: chart axis labels searched')
  const none = await mcp.callTool('find_text', { query: 'kubernetes' })
  ok(none.text === 'No match for "kubernetes" in 2 slides.', 'find_text: a miss says so, with the slide count')
  const r = agentFindText(findDoc as never, 'a', 2, plain)
  ok(r.hits.length === 2 && r.total > 2, `find_text: limit caps the hits, total counts all (${r.total})`)
  mcp.dispose()
}

// read_reference + stop
{
  console.log('\n-- read_reference, stop, errors --')
  const profile: ApiProfile = { id: 'p', name: 'p', kind: 'api', wire: 'anthropic', baseUrl: base, model: 'm' }
  const tools = { defs: [], call: async () => ({ text: '', images: [], isError: false }) }
  const scripted: Array<{ text: string; toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> }> = [
    { text: '', toolCalls: [{ id: 'r', name: 'read_reference', args: { name: 'format.md' } }] },
    { text: '', toolCalls: [{ id: 'r2', name: 'read_reference', args: { name: '../../etc/passwd' } }] },
    { text: 'bye', toolCalls: [] },
  ]
  const seen: ChatMsg[][] = []
  const provider = { complete: async (o: { messages: ChatMsg[]; onText: (t: string) => void }) => { seen.push(JSON.parse(JSON.stringify(o.messages))); const s = scripted.shift()!; if (s.text) o.onText(s.text); return { ...s, truncated: false } } }
  const s = new ApiChatSession({ chatId: '33333333-3333-3333-3333-333333333333', profile, sessionDir, sharedDir: shared, transcriptDir: join(work, 'api-chats'), provider, tools }, false)
  await s.send('hi')
  const last = seen.at(-1)!
  const toolMsgs = last.filter((m) => m.role === 'tool') as Array<Extract<ChatMsg, { role: 'tool' }>>
  ok(toolMsgs[0].results[0].text === '# format spec', 'read_reference returns the context file')
  ok(toolMsgs[1].results[0].isError === false && toolMsgs[1].results[0].text.startsWith('Error: name must be one of'), 'read_reference refuses a path outside the two documents')
  s.dispose()

  // Stop mid-turn: aborting while a provider call is pending ends cleanly.
  const evs: ChatEvent[] = []
  const slow = { complete: (o: { signal: AbortSignal; onText: (t: string) => void }) => new Promise<never>((_, rej) => { o.onText('partial'); o.signal.addEventListener('abort', () => rej(new Error('aborted'))) }) }
  const s2 = new ApiChatSession({ chatId: '44444444-4444-4444-4444-444444444444', profile, sessionDir, sharedDir: shared, transcriptDir: join(work, 'api-chats'), provider: slow, tools }, false)
  s2.onEvent((e) => evs.push(e))
  const run = s2.send('go')
  setTimeout(() => s2.stop(), 50)
  await run
  ok(evs.some((e) => e.type === 'done' && e.stopped) && s2.busy === false, 'Stop aborts the call and reports done{stopped}')
  s2.dispose()

  // A provider failure becomes an error event, not a throw.
  const evs2: ChatEvent[] = []
  const bad = { complete: async () => { throw new Error('401 unauthorized') } }
  const s3 = new ApiChatSession({ chatId: '55555555-5555-5555-5555-555555555555', profile, sessionDir, sharedDir: shared, transcriptDir: join(work, 'api-chats'), provider: bad, tools }, false)
  s3.onEvent((e) => evs2.push(e))
  await s3.send('x')
  ok(evs2.some((e) => e.type === 'error' && e.message.includes('401')) && s3.busy === false, 'provider failure → error event, session usable again')
  s3.dispose()

  // The turn cap.
  const evs3: ChatEvent[] = []
  const loopy = { complete: async () => ({ text: '', toolCalls: [{ id: `c${Math.random()}`, name: 'read_reference', args: { name: 'agents.md' } }], truncated: false }) }
  const s4 = new ApiChatSession({ chatId: '66666666-6666-6666-6666-666666666666', profile, sessionDir, sharedDir: shared, transcriptDir: join(work, 'api-chats'), provider: loopy, tools }, false)
  s4.onEvent((e) => evs3.push(e))
  await s4.send('x')
  ok(evs3.filter((e) => e.type === 'tool-start').length === 40 && evs3.some((e) => e.type === 'error' && e.message.includes('40 steps')), 'a runaway loop stops after 40 steps')
  s4.dispose()
}

// ---- 4. harness: usage fallback, retries, compaction, skills, subagents ------
{
  const stubTools = {
    defs: [
      { name: 'get_slide', description: 'g', inputSchema: { type: 'object' } },
      { name: 'update_element', description: 'u', inputSchema: { type: 'object' } },
    ],
    call: async () => ({ text: '{"id":"s2"}', images: [], isError: false }),
  }
  const tdir = join(work, 'api-chats')
  const msgText = (c: any): string => (typeof c === 'string' ? c : c.map((b: any) => b.text ?? '').join(''))

  console.log('\n-- profile contextWindow --')
  ok((sanitizeProfile({ id: 'c', name: 'C', kind: 'api', wire: 'openai', baseUrl: 'https://x', model: 'm', contextWindow: 100000 }) as ApiProfile).contextWindow === 100000, 'contextWindow is kept')
  ok(!('contextWindow' in (sanitizeProfile({ id: 'c', name: 'C', kind: 'api', wire: 'openai', baseUrl: 'https://x', model: 'm', contextWindow: 5 }) as object)), 'an absurd contextWindow is dropped')

  console.log('\n-- retries without cache_control / stream_options --')
  {
    const alt = `http://localhost:${(mock.address() as AddressInfo).port}`
    const base0 = { maxTokens: 64, apiKey: 'k', system: 'S', tools: [{ name: 'get_slide', description: 'g', inputSchema: { type: 'object' } }], messages: [{ role: 'user', text: 'hi' }] as ChatMsg[], signal: new AbortController().signal, onText: () => {} }
    requests.length = 0
    rejectMode = 'cache'
    const c = await anthropicProvider.complete({ ...base0, baseUrl: alt, model: 'm' })
    ok(requests.length === 2 && JSON.stringify(requests[0].body).includes('cache_control') && !JSON.stringify(requests[1].body).includes('cache_control') && c.text !== undefined, 'a 400 mentioning cache_control is retried once without caching')
    await anthropicProvider.complete({ ...base0, baseUrl: alt, model: 'm' })
    ok(requests.length === 3 && !JSON.stringify(requests[2].body).includes('cache_control'), 'the gateway is remembered: no cache_control from then on')
    requests.length = 0
    rejectMode = 'stream_options'
    await openaiProvider.complete({ ...base0, baseUrl: `${alt}/v1`, model: 'm' })
    ok(requests.length === 2 && requests[0].body.stream_options && !requests[1].body.stream_options, 'a 400 mentioning stream_options is retried once without it')
    await openaiProvider.complete({ ...base0, baseUrl: `${alt}/v1`, model: 'm' })
    ok(requests.length === 3 && !requests[2].body.stream_options, 'stream_options stays off for that server')
    rejectMode = null
  }

  console.log('\n-- no usage → estimate; compaction on both wires --')
  for (const wire of ['anthropic', 'openai'] as const) {
    const url = wire === 'openai' ? `${base}/v1` : base
    const id = wire === 'openai' ? 'aaaaaaaa-0000-0000-0000-000000000002' : 'aaaaaaaa-0000-0000-0000-000000000001'
    // (a) a provider that reports no usage
    mockUsage = null
    {
      const profile: ApiProfile = { id: `n-${wire}`, name: 'n', kind: 'api', wire, baseUrl: url, model: 'm', maxTokens: 256 }
      const s = new ApiChatSession({ chatId: id.replace('aaaa', 'bbbb'), profile, sessionDir, sharedDir: shared, transcriptDir: tdir, tools: stubTools }, false)
      const evs: ChatEvent[] = []
      s.onEvent((e) => evs.push(e))
      await s.send('make the title red')
      const u = evs.filter((e) => e.type === 'usage') as Array<Extract<ChatEvent, { type: 'usage' }>>
      ok(u.length === 3 && u.every((x) => x.contextTokens > 100 && x.cacheRead === 0), `${wire}: without provider usage the chars/4 estimate is reported (${u.map((x) => x.contextTokens).join(',')})`)
      s.dispose()
    }
    // (b) a tiny window forces compaction
    mockUsage = { input: 1000, cacheRead: 5000, cacheWrite: 200, output: 50 }
    requests.length = 0
    const profile: ApiProfile = { id: `c-${wire}`, name: 'c', kind: 'api', wire, baseUrl: url, model: 'm', maxTokens: 256, contextWindow: 4000 }
    const s = new ApiChatSession({ chatId: id, profile, sessionDir, sharedDir: shared, transcriptDir: tdir, tools: stubTools }, false)
    const evs: ChatEvent[] = []
    s.onEvent((e) => evs.push(e))
    await s.send('make the title red')
    const summaryReq = requests.find((r) => !(r.body.tools && r.body.tools.length))
    ok(!!summaryReq, `${wire}: a summary request without tools was made`)
    const sysOf = (r: typeof requests[number]): string => (wire === 'anthropic' ? msgText(r.body.system) : r.body.messages[0].content)
    ok(!!summaryReq && sysOf(summaryReq) === SUMMARIZER_SYSTEM, `${wire}: the summarizer has its own fixed system prompt`)
    const sumUser = summaryReq ? msgText(wire === 'anthropic' ? summaryReq.body.messages[0].content : summaryReq.body.messages[1].content) : ''
    ok(sumUser.includes('make the title red') && !sumUser.includes('"images"'), `${wire}: the summary input is the old conversation as text`)
    ok(evs.some((e) => e.type === 'compacted' && e.summary === SUMMARY_TEXT) && evs.at(-2)?.type === 'done', `${wire}: a compacted event, then the request finishes`)
    const after = requests.filter((r) => r.body.tools && r.body.tools.length).at(-1)!
    const wireMsgs: any[] = wire === 'anthropic' ? after.body.messages : after.body.messages.slice(1)
    ok(msgText(wireMsgs[0].content).startsWith(SUMMARY_PREFIX) && msgText(wireMsgs[0].content).includes(SUMMARY_TEXT) && wireMsgs[0].role === 'user', `${wire}: the next request starts with the summary as a user message`)
    if (wire === 'anthropic') ok(wireMsgs.every((m, i) => i === 0 || m.role !== wireMsgs[i - 1].role), 'anthropic: roles alternate after compaction')
    else ok(wireMsgs[1].role === 'assistant', 'openai: the summary is followed by the assistant message')
    const t = loadTranscript(tdir, id)!
    ok(t.version === 2 && t.messages[0].role === 'summary' && t.archive.length >= 1 && t.archive[0].role === 'user', `${wire}: transcript v2 keeps messages (summary first) + archive`)
    const items = displayFromMessages([...t.archive, ...t.messages])
    ok(items.some((d) => d.kind === 'note' && d.text === 'Conversation compacted') && items[0].kind === 'user', `${wire}: the full history is still shown, with a divider`)
    const resumed = new ApiChatSession({ chatId: id, profile, sessionDir, sharedDir: shared, transcriptDir: tdir, tools: stubTools }, true)
    ok(JSON.stringify(resumed.display) === JSON.stringify(items), `${wire}: a resumed chat rebuilds archive + summary divider + tail`)
    resumed.dispose()
    s.dispose()
  }

  console.log('\n-- compaction policy, /compact, v1 transcripts --')
  {
    const m = (role: 'user' | 'assistant', text = 'x'): ChatMsg => (role === 'user' ? { role, text } : { role, text, toolCalls: [] })
    const tool = (id: string): ChatMsg => ({ role: 'tool', results: [{ id, name: 'n', text: 't', images: [], isError: false }] })
    const call = (id: string): ChatMsg => ({ role: 'assistant', text: '', toolCalls: [{ id, name: 'n', args: {} }] })
    ok(chooseCut([m('user'), m('assistant'), m('user')]) === -1, 'too short: nothing to cut')
    const conv = [m('user'), call('a'), tool('a'), call('b'), tool('b'), m('assistant')]
    ok(chooseCut(conv) === 2 - 1, 'the cut never starts on a tool message (moves back to its assistant)')
    ok(conv.length - chooseCut(conv) >= 4, 'the tail keeps at least 4 messages')
    const merged = resolveSummaries([{ role: 'summary', text: 'S' }, { role: 'user', text: 'next', shown: 'n' }, m('assistant')])
    ok(merged.length === 2 && merged[0].role === 'user' && (merged[0] as any).text === `${SUMMARY_PREFIX}\nS\n\nnext`, 'a summary merges into the following user message')
    ok(resolveSummaries([{ role: 'summary', text: 'S' }, m('assistant')])[0].role === 'user', 'a summary before an assistant message stands alone as a user message')
    ok(estimateTokens('abcd', [{ role: 'user', text: 'abcdefgh' }]) === 3, 'estimateTokens is chars/4')

    // /compact through the session (no model turn)
    const calls: Array<{ tools: number; ask: string }> = []
    let n = 0
    const provider = {
      complete: async (o: { tools: unknown[]; messages: ChatMsg[]; onText: (t: string) => void }) => {
        if (o.tools.length === 0) { calls.push({ tools: 0, ask: (o.messages[0] as any).text }); return { text: 'SUMMED', toolCalls: [], truncated: false } }
        n++
        return n % 2 ? { text: '', toolCalls: [{ id: `k${n}`, name: 'get_slide', args: {} }], truncated: false } : { text: `answer ${n}`, toolCalls: [], truncated: false }
      },
    }
    const profile: ApiProfile = { id: 'p', name: 'p', kind: 'api', wire: 'anthropic', baseUrl: base, model: 'm' }
    const s = new ApiChatSession({ chatId: 'cccccccc-0000-0000-0000-000000000001', profile, sessionDir, sharedDir: shared, transcriptDir: tdir, provider, tools: stubTools }, false)
    const evs: ChatEvent[] = []
    s.onEvent((e) => evs.push(e))
    await s.send('/compact')
    ok(calls.length === 0 && evs.some((e) => e.type === 'text-delta' && e.text.includes('Nothing to compact')), '/compact on a short chat: nothing to do, no summary call')
    await s.send('one')
    await s.send('two')
    const before = n
    evs.length = 0
    await s.send('/compact the slide ids')
    ok(calls.length === 1 && calls[0].ask.includes('the slide ids') && n === before, '/compact [focus] makes one summary call (focus included) and no model turn')
    ok(evs.some((e) => e.type === 'compacted') && s.display.some((d) => d.kind === 'note'), '/compact reports compacted and adds a divider')
    const t = loadTranscript(tdir, 'cccccccc-0000-0000-0000-000000000001')!
    ok(t.messages[0].role === 'summary' && t.messages.length >= 4, 'the transcript starts with the summary and keeps a tail')
    s.dispose()

    // a failing summary: error, nothing lost
    let failCalls = 0
    const bad = { complete: async (o: { tools: unknown[] }) => { if (o.tools.length === 0) { failCalls++; throw new Error('summary down') } return { text: 'ok', toolCalls: [{ id: `z${Math.random()}`, name: 'get_slide', args: {} }], truncated: false } } }
    const tiny: ApiProfile = { ...profile, contextWindow: 400 }
    const s2 = new ApiChatSession({ chatId: 'cccccccc-0000-0000-0000-000000000002', profile: tiny, sessionDir, sharedDir: shared, transcriptDir: tdir, provider: bad, tools: stubTools }, false)
    const evs2: ChatEvent[] = []
    s2.onEvent((e) => evs2.push(e))
    await s2.send('x')
    ok(failCalls === 1 && evs2.some((e) => e.type === 'error' && e.message.includes('Could not compact')) && evs2.filter((e) => e.type === 'tool-start').length === 40, 'a failing summary → one error, no retry storm, the request carries on')
    ok(loadTranscript(tdir, 'cccccccc-0000-0000-0000-000000000002')!.messages.every((x) => x.role !== 'summary'), 'nothing was removed when the summary failed')
    s2.dispose()

    // v1 transcripts still load
    mkdirSync(tdir, { recursive: true })
    writeFileSync(transcriptPath(tdir, 'dddddddd-0000-0000-0000-000000000001'), JSON.stringify({ version: 1, profileId: 'p', messages: [{ role: 'user', text: 'old' }] }))
    const v1 = loadTranscript(tdir, 'dddddddd-0000-0000-0000-000000000001')
    ok(v1?.version === 2 && v1.messages.length === 1 && v1.archive.length === 0, 'a v1 transcript loads (archive empty)')
    saveTranscript(tdir, 'dddddddd-0000-0000-0000-000000000002', { version: 2, profileId: 'p', messages: [{ role: 'summary', text: 'S' }], archive: [{ role: 'tool', results: [{ id: 'i', name: 'review_slide', text: 'r', images: [img], isError: false }] }] })
    const rt = loadTranscript(tdir, 'dddddddd-0000-0000-0000-000000000002')!
    ok(rt.messages[0].role === 'summary' && (rt.archive[0] as any).results[0].images.length === 0 && (rt.archive[0] as any).results[0].text.includes('[screenshot omitted]'), 'a v2 transcript round-trips; archived screenshots are stripped')
  }

  console.log('\n-- skills --')
  {
    const read = (f: string) => readFileSync(join(here, '../desktop/src/main/apichat/skills', f), 'utf8')
    const builtin = ['build-deck', 'polish-deck', 'translate-deck'].map((n) => parseSkill(read(`${n}.md`), n)!)
    ok(builtin.every((b) => b && b.description.length > 10 && b.body.length > 200), 'the three built-in skills parse (name, description, body)')
    const parsed = parseSkill('---\nname: "x-y"\ndescription: Does a thing: well\nother: 1\n---\n\nBody here\n', 'fallback')
    ok(parsed?.name === 'x-y' && parsed.description === 'Does a thing: well' && parsed.body === 'Body here', 'frontmatter: key: value lines, quotes stripped, body after')
    ok(parseSkill('no frontmatter body', 'dirname')?.name === 'dirname' && parseSkill('---\nname: ../evil\n---\nb', 'q') === null, 'name falls back to the folder; unsafe names are refused')
    const skillsDir = join(work, 'api-skills')
    mkdirSync(join(skillsDir, 'polish-deck'), { recursive: true })
    mkdirSync(join(skillsDir, 'mine'), { recursive: true })
    writeFileSync(join(skillsDir, 'polish-deck', 'SKILL.md'), '---\nname: polish-deck\ndescription: User polish\n---\nUSER POLISH BODY')
    writeFileSync(join(skillsDir, 'polish-deck', 'extra.md'), 'EXTRA FILE')
    writeFileSync(join(skillsDir, 'polish-deck', 'run.sh'), 'echo')
    writeFileSync(join(skillsDir, 'outside.md'), 'SECRET')
    writeFileSync(join(skillsDir, 'mine', 'SKILL.md'), '---\ndescription: Mine\n---\nMINE BODY')
    symlinkSync(join(skillsDir, 'outside.md'), join(skillsDir, 'polish-deck', 'link.md'))
    const profile: ApiProfile = { id: 'p', name: 'p', kind: 'api', wire: 'anthropic', baseUrl: base, model: 'm' }
    const seenSystems: string[] = []
    const script: Array<{ name: string; args: Record<string, unknown> } | null> = [
      { name: 'use_skill', args: { name: 'build-deck' } },
      { name: 'use_skill', args: { name: 'polish-deck' } },
      { name: 'use_skill', args: { name: 'polish-deck', file: 'extra.md' } },
      { name: 'use_skill', args: { name: 'polish-deck', file: '../outside.md' } },
      { name: 'use_skill', args: { name: 'polish-deck', file: 'link.md' } },
      { name: 'use_skill', args: { name: 'polish-deck', file: 'run.sh' } },
      { name: 'use_skill', args: { name: 'build-deck', file: 'x.md' } },
      { name: 'use_skill', args: { name: 'nope' } },
      null,
    ]
    let last: ChatMsg[] = []
    const provider = { complete: async (o: { system: string; messages: ChatMsg[] }) => { seenSystems.push(o.system); last = JSON.parse(JSON.stringify(o.messages)); const st = script.shift(); return st ? { text: '', toolCalls: [{ id: `u${script.length}`, ...st }], truncated: false } : { text: 'ok', toolCalls: [], truncated: false } } }
    const s = new ApiChatSession({ chatId: 'eeeeeeee-0000-0000-0000-000000000001', profile, sessionDir, sharedDir: shared, transcriptDir: tdir, provider, tools: stubTools, skillsDir, builtinSkills: builtin }, false)
    await s.send('hello')
    const res = (last.filter((x) => x.role === 'tool') as Array<Extract<ChatMsg, { role: 'tool' }>>).map((x) => x.results[0])
    ok(res[0].text === builtin[0].body && !res[0].isError, 'use_skill returns a built-in skill body')
    ok(res[1].text === 'USER POLISH BODY', 'a user skill of the same name overrides the built-in')
    ok(res[2].text === 'EXTRA FILE', 'use_skill reads another .md file of the skill folder')
    ok(res[3].isError && res[3].text.includes('inside the skill folder'), 'a file path escaping the folder is refused')
    ok(res[4].isError && res[4].text.includes('inside the skill folder'), 'a symlink pointing out of the folder is refused')
    ok(res[5].isError && res[5].text.includes('.md and .txt'), 'only .md/.txt files are readable')
    ok(res[6].isError && res[7].isError && res[7].text.includes('Available:') && res[7].text.includes('mine'), 'built-ins have no extra files; an unknown skill lists the available ones')
    ok(seenSystems[0].includes('- build-deck:') && seenSystems[0].includes('- mine: Mine') && seenSystems[0].includes('- polish-deck: User polish') && seenSystems[0].includes('call use_skill first'), 'the system prompt lists the merged skills and the rule')
    ok(seenSystems[0].includes('disjoint set of slides'), 'the system prompt tells the model to give subagents disjoint slides')
    // user skills are re-scanned on each send
    writeFileSync(join(skillsDir, 'mine', 'SKILL.md'), '---\ndescription: Mine v2\n---\nMINE BODY 2')
    seenSystems.length = 0
    await s.send('again')
    ok(seenSystems[0].includes('- mine: Mine v2'), 'an edited user skill applies on the next send, without a restart')
    // slash expansion
    seenSystems.length = 0
    await s.send('/polish-deck foo bar')
    const um = last.filter((x) => x.role === 'user').at(-1) as Extract<ChatMsg, { role: 'user' }>
    ok(um.text.includes('USER POLISH BODY') && um.text.includes('foo bar') && um.shown === '/polish-deck foo bar', '/polish-deck foo expands to the skill body + the rest; the panel shows what was typed')
    ok((s.display.filter((d) => d.kind === 'user').at(-1) as { text: string }).text === '/polish-deck foo bar', 'display shows the typed command')
    ok(expandSlash('/compact x', [{ name: 'compact', description: '', body: 'B' }]) === null && expandSlash('/unknown a', builtin) === null && expandSlash('not a slash', builtin) === null, '/compact is reserved; unknown slashes are sent as text')
    ok(mergeSkills(builtin, [{ name: 'build-deck', description: 'u', body: 'U' }]).find((x) => x.name === 'build-deck')?.body === 'U', 'mergeSkills: user wins')
    s.dispose()
  }

  console.log('\n-- subagents --')
  {
    const profile: ApiProfile = { id: 'p', name: 'p', kind: 'api', wire: 'anthropic', baseUrl: base, model: 'm' }
    const t0 = Date.now()
    const log: Array<{ name: string; who: string; start: number; end: number }> = []
    let activeReview = 0, maxReview = 0, activeKids = 0, maxKids = 0
    const tools = {
      defs: [
        { name: 'get_slide', description: 'g', inputSchema: { type: 'object' } },
        { name: 'review_slide', description: 'r', inputSchema: { type: 'object' } },
      ],
      call: async (name: string, args: Record<string, unknown>) => {
        const start = Date.now() - t0
        if (name === 'review_slide') { activeReview++; maxReview = Math.max(maxReview, activeReview) }
        await new Promise((r) => setTimeout(r, name === 'review_slide' ? 60 : 40))
        if (name === 'review_slide') activeReview--
        log.push({ name, who: String(args.who ?? ''), start, end: Date.now() - t0 })
        return { text: `${name} ok`, images: [], isError: false }
      },
    }
    const childTools: string[][] = []
    const childPrompts: string[] = []
    const jobs = ['job-A', 'job-B', 'job-C', 'job-D', 'job-E']
    const provider = {
      complete: async (o: { system: string; tools: Array<{ name: string }>; messages: ChatMsg[]; onText: (t: string) => void }) => {
        const isChild = o.system.includes(SUBAGENT_PREAMBLE)
        const toolMsgs = o.messages.filter((m) => m.role === 'tool').length
        const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }
        if (!isChild) {
          if (toolMsgs === 0) {
            return { text: 'Delegating.', truncated: false, usage, toolCalls: [
              { id: 'ord1', name: 'get_slide', args: { who: 'parent' } },
              ...jobs.map((j, i) => ({ id: `task${i}`, name: 'task', args: { description: `Do ${j}`, prompt: j } })),
              { id: 'taskloop', name: 'task', args: { description: 'Endless', prompt: 'endless' } },
            ] }
          }
          return { text: 'All done.', toolCalls: [], truncated: false, usage }
        }
        const prompt = (o.messages[0] as { text: string }).text
        if (toolMsgs === 0) { childTools.push(o.tools.map((t) => t.name)); childPrompts.push(prompt) }
        o.onText('child chatter')
        if (prompt === 'endless') return { text: '', toolCalls: [{ id: `e${toolMsgs}`, name: 'get_slide', args: { who: 'endless' } }], truncated: false, usage }
        if (toolMsgs === 0) {
          activeKids++; maxKids = Math.max(maxKids, activeKids)
          return { text: '', truncated: false, usage, toolCalls: [
            { id: `g-${prompt}`, name: 'get_slide', args: { who: prompt } },
            { id: `r-${prompt}`, name: 'review_slide', args: { who: prompt } },
            ...(prompt === 'job-A' ? [{ id: 'nest', name: 'task', args: { description: 'nested', prompt: 'x' } }] : []),
          ] }
        }
        activeKids--
        // A is slower to answer than B, so results must still come back in call order.
        if (prompt === 'job-A') await new Promise((r) => setTimeout(r, 120))
        return { text: `report ${prompt}`, toolCalls: [], truncated: false, usage }
      },
    }
    const s = new ApiChatSession({ chatId: 'ffffffff-0000-0000-0000-000000000001', profile, sessionDir, sharedDir: shared, transcriptDir: tdir, provider, tools }, false)
    const evs: Array<ChatEvent & { at?: number }> = []
    s.onEvent((e) => evs.push({ ...e, at: Date.now() - t0 }))
    await s.send('polish everything')
    const startOf = (id: string) => evs.find((e) => e.type === 'tool-start' && e.id === id)
    const endOf = (id: string) => evs.find((e) => e.type === 'tool-end' && e.id === id) as Extract<ChatEvent, { type: 'tool-end' }> | undefined
    ok((startOf('ord1')?.at ?? 1e9) <= (startOf('task0')?.at ?? 0), 'ordinary tool calls of the turn run before its tasks')
    ok(startOf('task0')!.at! <= endOf('task1')!.at! && startOf('task1')!.at! <= endOf('task0')!.at!, 'two task calls ran at the same time (overlapping)')
    ok(maxKids <= 4 && maxKids >= 2, `at most 4 subagents at once (peak ${maxKids})`)
    const childStarts = evs.filter((e) => e.type === 'tool-start' && e.parent) as Array<Extract<ChatEvent, { type: 'tool-start' }>>
    ok(childStarts.length > 5 && childStarts.every((e) => /^task/.test(e.parent!)), `child tool events carry the task call id as parent (${childStarts.length} events)`)
    ok(!evs.some((e) => e.type === 'text-delta' && e.text === 'child chatter'), "child text deltas are not forwarded")
    ok(childTools.length === 6 && childTools.every((t) => !t.includes('task') && t.includes('use_skill') && t.includes('get_slide')), 'children get every tool except task, plus use_skill')
    const nest = endOf('nest')
    ok(!!nest && nest.isError && nest.text.includes('cannot start subagents'), 'a child that calls task anyway is refused')
    const parentMsgs = (JSON.parse(readFileSync(transcriptPath(tdir, 'ffffffff-0000-0000-0000-000000000001'), 'utf8')).messages as ChatMsg[])
    const toolMsg = parentMsgs.find((m) => m.role === 'tool') as Extract<ChatMsg, { role: 'tool' }>
    ok(toolMsg.results.map((r) => r.id).join() === 'ord1,task0,task1,task2,task3,task4,taskloop', 'results are returned in the original call order')
    ok(toolMsg.results[1].text === 'report job-A' && toolMsg.results[2].text === 'report job-B' && endOf('task1')!.at! < endOf('task0')!.at!, 'the faster child finished first but its result keeps its slot')
    ok(toolMsg.results[6].text.includes('25-step limit'), 'a child that never finishes stops at its step cap and says so')
    ok(!parentMsgs.some((m) => JSON.stringify(m).includes('child chatter')) && parentMsgs.filter((m) => m.role === 'assistant').length === 2, "the child's own messages are not kept in the transcript")
    ok(maxReview === 1, `review_slide calls never overlap (mutex; peak ${maxReview})`)
    const gets = log.filter((l) => l.name === 'get_slide' && l.who.startsWith('job-'))
    ok(gets.some((a) => gets.some((b) => a !== b && a.start < b.end && b.start < a.end)), 'other verbs do interleave across subagents')
    const task0 = s.display.find((d) => d.kind === 'tool' && d.id === 'task0') as Extract<(typeof s.display)[number], { kind: 'tool' }>
    ok(!!task0 && (task0.children?.length ?? 0) === 3 && task0.done && task0.children!.every((c) => c.done), 'display nests the child tool rows inside the task row')
    ok(s.display.filter((d) => d.kind === 'tool').every((d) => (d as any).id.startsWith('task') || (d as any).id === 'ord1'), 'child rows are not top-level display items')
    const usageEvs = evs.filter((e) => e.type === 'usage') as Array<Extract<ChatEvent, { type: 'usage' }>>
    ok(usageEvs.length > 2 && usageEvs.at(-1)!.totalTokens! > 2 * 110 + 6 * 110, `child usage is added to the session total (${usageEvs.at(-1)?.totalTokens})`)
    ok(usageEvs.filter((e) => e.contextTokens === 100).length === usageEvs.length, "the readout's context stays the parent's, not a child's")
    s.dispose()
  }
}

// ---- output cap: a model that allows less than we ask for gets a retry with its limit
{
  const bad = (message: string, status = 400) => Object.assign(new Error(message), { status })
  ok(outputCapFromError(bad('max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-3-5-sonnet')) === 8192, 'cap read from an Anthropic 400')
  ok(outputCapFromError(bad('max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.')) === 16384, 'cap read from an OpenAI 400')
  ok(outputCapFromError(bad("This model's maximum context length is 32768 tokens. However, you requested 40000 tokens (8000 in the messages, 32000 in the completion).")) === 32768 - 8000 - 64, 'cap read from a vLLM context-length 400')
  ok(outputCapFromError(bad('max_tokens: 32000 > 8192', 500)) === null && outputCapFromError(bad('invalid model')) === null, 'other errors are not caps')
  const asked: number[] = []
  const inner = { complete: async (o: { maxTokens: number }) => { asked.push(o.maxTokens); if (o.maxTokens > 8192) throw bad(`max_tokens: ${o.maxTokens} > 8192, which is the maximum`); return { text: 'ok', toolCalls: [], truncated: false } } }
  const capped = withOutputCap(inner as never)
  const opts = { baseUrl: 'http://cap.test', model: 'small', maxTokens: DEFAULT_MAX_TOKENS, system: '', tools: [], messages: [], signal: new AbortController().signal, onText: () => {} }
  const r1 = await capped.complete(opts)
  await capped.complete(opts)
  ok(r1.text === 'ok' && asked.join() === `${DEFAULT_MAX_TOKENS},8192,8192`, `a rejected budget is retried with the stated cap, then remembered (${asked.join()})`)
}

// ---- text-only models: screenshots left out, by setting or after the server says so
{
  const bad = (message: string, status = 400) => Object.assign(new Error(message), { status })
  ok(isImageReject(bad('litellm.BadRequestError: Hosted_vllmException - {"error":{"message":"nvidia/GLM-5.3-NVFP4 is not a multimodal model","type":"BadRequestError"}}')), 'image reject recognised: vLLM through LiteLLM')
  ok(isImageReject(bad('Invalid content type. image_url is only supported by certain models.')) && isImageReject(bad('This model does not support image input')) && isImageReject(bad('Image input is not supported for this model')), 'image reject recognised: OpenAI-style and generic wordings')
  ok(!isImageReject(bad('not a multimodal model', 500)) && !isImageReject(bad('max_tokens: 32000 > 8192')) && !isImageReject(bad('invalid model id')), 'other errors are not image rejects')

  const stripped = withoutImages(convo)
  const r = (stripped[2] as Extract<ChatMsg, { role: 'tool' }>).results[0]
  ok(r.images.length === 0 && r.text === `ok\n${IMAGE_OMITTED_NOTE}` && (convo[2] as Extract<ChatMsg, { role: 'tool' }>).results[0].images.length === 1, 'withoutImages: screenshot replaced by a note, the stored transcript untouched')
  ok(stripped[4] === convo[4], 'withoutImages: results without images pass through as is')
  const omStripped = toOpenAIMessages('SYS', withoutImages(convo.slice(0, 3))) as Array<Record<string, any>>
  ok(!JSON.stringify(omStripped).includes('image_url') && omStripped[3].content.includes('screenshot omitted'), 'openai wire without images: no image_url part, the tool message says why')
  const amStripped = toAnthropicMessages(withoutImages(convo.slice(0, 3))) as Array<{ content: any }>
  ok(!JSON.stringify(amStripped).includes('"image"'), 'anthropic wire without images: no image block')

  const calls: Array<boolean | undefined> = []
  const sent: string[] = []
  const inner = { complete: async (o: { images?: boolean; messages: ChatMsg[] }) => {
    calls.push(o.images)
    const wire = JSON.stringify(toOpenAIMessages('', o.images === false ? withoutImages(o.messages) : o.messages))
    sent.push(wire)
    if (wire.includes('image_url')) throw bad('nvidia/GLM-5.3-NVFP4 is not a multimodal model')
    return { text: 'ok', toolCalls: [], truncated: false }
  } }
  const fb = withImageFallback(inner as never)
  const base = { baseUrl: 'http://vllm.test/v1', model: 'glm', maxTokens: 100, system: '', tools: [], signal: new AbortController().signal, onText: () => {} }
  const plain = await fb.complete({ ...base, messages: convo.slice(0, 1) })
  ok(plain.text === 'ok' && calls.length === 1 && calls[0] === undefined && !knownTextOnly(base.baseUrl, base.model), 'no screenshot in the request: nothing to detect, sent as is')
  calls.length = 0
  const withShot = await fb.complete({ ...base, messages: convo.slice(0, 3) })
  ok(withShot.text === 'ok' && calls.join() === ',false' && knownTextOnly(base.baseUrl, base.model), `a rejected screenshot is retried without images and the model remembered as text-only (${calls.join()})`)
  calls.length = 0
  await fb.complete({ ...base, messages: convo.slice(0, 3) })
  ok(calls.join() === 'false', 'the next request goes text-only straight away (no second failure)')
  ok(!knownTextOnly(base.baseUrl, 'other-model'), 'remembered per model, not per server')
  calls.length = 0
  await fb.complete({ ...base, model: 'marked', images: false, messages: convo.slice(0, 3) })
  ok(calls.join() === 'false', 'a profile marked text-only never sends images')
  let rethrown = false
  const failing = withImageFallback({ complete: async () => { throw bad('invalid api key', 401) } } as never)
  try { await failing.complete({ ...base, model: 'm2', messages: convo.slice(0, 3) }) } catch { rethrown = true }
  ok(rethrown && !knownTextOnly(base.baseUrl, 'm2'), 'unrelated errors are passed on, nothing remembered')

  ok(sanitizeProfile({ id: 't', name: 'T', kind: 'api', wire: 'openai', baseUrl: 'http://x/v1', model: 'm', textOnly: true })?.kind === 'api'
    && (sanitizeProfile({ id: 't', name: 'T', kind: 'api', wire: 'openai', baseUrl: 'http://x/v1', model: 'm', textOnly: true }) as ApiProfile).textOnly === true
    && !('textOnly' in (sanitizeProfile({ id: 't', name: 'T', kind: 'api', wire: 'openai', baseUrl: 'http://x/v1', model: 'm', textOnly: 'yes' }) as ApiProfile)), 'textOnly kept only when exactly true')

  // A text-only profile's session: no render_preview, the numbers-based review rule, images off.
  const seen: Array<{ images?: boolean; system: string; tools: string[] }> = []
  const provider = { complete: async (o: { images?: boolean; system: string; tools: Array<{ name: string }> }) => { seen.push({ images: o.images, system: o.system, tools: o.tools.map((t) => t.name) }); return { text: 'done', toolCalls: [], truncated: false } } }
  const defs = ['review_slide', 'render_preview', 'check_layout'].map((name) => ({ name, description: '', inputSchema: { type: 'object' } }))
  const tools = { defs, call: async () => ({ text: '', images: [], isError: false }) }
  const mk = (p: ApiProfile, id: string) => new ApiChatSession({ chatId: id, profile: p, sessionDir, sharedDir: shared, transcriptDir: join(work, 'api-chats'), provider: provider as never, tools }, false)
  const textProfile: ApiProfile = { id: 'glm', name: 'GLM', kind: 'api', wire: 'openai', baseUrl: 'http://glm.test/v1', model: 'glm', textOnly: true }
  const t1 = mk(textProfile, '66666666-6666-6666-6666-666666666666')
  await t1.send('tidy this slide')
  ok(seen[0].images === false && !seen[0].tools.includes('render_preview') && seen[0].tools.includes('review_slide'), 'text-only session: images off, render_preview hidden, review_slide kept')
  ok(seen[0].system.includes('You cannot see images') && !seen[0].system.includes('If the screenshot shows'), 'text-only session: the review rule works from the element list')
  t1.dispose()
  const t2 = mk({ ...textProfile, id: 'vis', model: 'vision', textOnly: undefined }, '67676767-6767-6767-6767-676767676767')
  await t2.send('tidy this slide')
  ok(seen[1].images === true && seen[1].tools.includes('render_preview') && seen[1].system.includes('If the screenshot shows'), 'a normal session keeps screenshots and the screenshot review rule')
  t2.dispose()
  const t3 = mk({ ...textProfile, id: 'auto', baseUrl: base.baseUrl, model: base.model, textOnly: undefined }, '68686868-6868-6868-6868-686868686868')
  await t3.send('tidy this slide')
  ok(seen[2].images === false && !seen[2].tools.includes('render_preview') && seen[2].system.includes('You cannot see images'), 'a model detected as text-only gets the text-only setup from the next message on')
  t3.dispose()
}

// ---- old tool results shrink to stubs, in one batch, once enough piles up
{
  console.log('\n-- elision, vision helper, role models --')
  const big = 'x'.repeat(6000)
  const build = (rounds: number): ChatMsg[] => {
    const msgs: ChatMsg[] = [{ role: 'user', text: 'go' }]
    for (let i = 0; i < rounds; i++) {
      const name = i === 0 ? 'use_skill' : 'get_slide'
      msgs.push({ role: 'assistant', text: '', toolCalls: [{ id: `c${i}`, name, args: {} }] })
      msgs.push({ role: 'tool', results: [{ id: `c${i}`, name, text: big, images: [], isError: false }, ...(i === 1 ? [{ id: 'w', name: 'update_element', text: 'ok', images: [], isError: false }] : [])] })
    }
    return msgs
  }
  const few = build(8)
  ok(elidableChars(few) === 4 * 6000 && elideOldResults(few) === 0 && JSON.stringify(few) === JSON.stringify(build(8)), `below ${ELIDE_TRIGGER_CHARS} elidable characters nothing changes (keeps the cache prefix stable)`)
  const many = build(10)
  const saved = elideOldResults(many)
  const texts = many.filter((m): m is Extract<ChatMsg, { role: 'tool' }> => m.role === 'tool').map((m) => m.results[0].text)
  ok(saved === 6 * 6000, `one batch elides every big result before the last ${KEEP_RECENT_ROUNDS} rounds (${saved} chars)`)
  ok(texts[0] === big, 'a use_skill playbook is never elided')
  ok(texts.slice(1, 7).every((t) => t.startsWith('[older get_slide result (6000 characters) removed') && t.includes('call get_slide again')), 'elided results become a stub that says how to get them back')
  ok(texts.slice(7).every((t) => t === big), 'the most recent rounds stay whole')
  ok((many[4] as Extract<ChatMsg, { role: 'tool' }>).results[1].text === 'ok', 'small results (writes) are left alone')
  ok(elideOldResults(many, 0) === 0, 'stubs are not elided again')
  // In the loop: elided before the request, and persisted.
  const inLoop = build(10)
  const sentMsgs: string[] = []
  let changes = 0
  await runAgent({
    provider: { complete: async (o) => { sentMsgs.push(JSON.stringify(o.messages)); return { text: 'done', toolCalls: [], truncated: false } } },
    baseUrl: 'x', model: 'm', maxTokens: 100, system: 's', tools: [], contextWindow: 1_000_000,
    runTool: async () => ({ text: '', images: [], isError: false }), digest: () => null,
    messages: inLoop, emit: () => {}, changed: () => { changes++ },
  }, new AbortController().signal)
  ok(sentMsgs.length === 1 && sentMsgs[0].includes('removed to save context') && changes >= 1, 'the loop elides before calling the model and saves the transcript')

  // A user message can carry an image (the vision helper's request).
  const shot = { data: 'QUJD', mimeType: 'image/png' }
  const au = toAnthropicMessages([{ role: 'user', text: 'look', images: [shot] }]) as Array<{ content: any }>
  ok(Array.isArray(au[0].content) && au[0].content[0].type === 'image' && au[0].content[1].text === 'look', 'anthropic: user images become image blocks before the text')
  const ou = toOpenAIMessages('S', [{ role: 'user', text: 'look', images: [shot] }]) as Array<Record<string, any>>
  ok(ou[1].content[0].text === 'look' && ou[1].content[1].image_url.url === 'data:image/png;base64,QUJD', 'openai: user images become image_url parts')
  const wu = withoutImages([{ role: 'user', text: 'look', images: [shot] }])[0] as Extract<ChatMsg, { role: 'user' }>
  ok(!wu.images && wu.text.includes('screenshot omitted'), 'withoutImages also strips a user message\'s images')

  // apiVisionHelper
  const asked: Array<{ system: string; images: number; model: string }> = []
  const visionProvider = { complete: async (o: { system: string; model: string; messages: ChatMsg[] }) => { asked.push({ system: o.system, model: o.model, images: (o.messages[0] as Extract<ChatMsg, { role: 'user' }>).images?.length ?? 0 }); return { text: ' The diagram is crowded at the right. ', toolCalls: [], truncated: false } } }
  const vp: ApiProfile = { id: 'vis', name: 'Qwen-VL', kind: 'api', wire: 'openai', baseUrl: 'http://vl.test/v1', model: 'qwen-vl' }
  const helper = apiVisionHelper(vp, 'k', visionProvider as never)
  const said = await helper.describe(shot, 'Is it balanced?', new AbortController().signal)
  ok(said === 'The diagram is crowded at the right.' && asked[0].images === 1 && asked[0].model === 'qwen-vl' && asked[0].system.includes('cannot see images'), 'apiVisionHelper sends the screenshot to the vision profile and returns its text')

  // Claude Code as the helper: the command line and the result parsing.
  ok(claudeVisionCommand('claude-work', 'opus[1m]') === "claude-work -p --output-format json --model 'opus[1m]' --allowedTools Read" && claudeVisionCommand('claude', undefined) === 'claude -p --output-format json --allowedTools Read', 'claude CLI helper: fixed flags, quoted model, prompt on stdin')
  ok(parseClaudeResult('rc noise\n{"type":"result","subtype":"success","is_error":false,"result":"Looks fine."}\n') === 'Looks fine.', 'claude CLI helper: the result line is found among shell noise')
  let cliErr = ''
  try { parseClaudeResult('{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}') } catch (e) { cliErr = (e as Error).message }
  ok(cliErr.includes('error_max_turns'), 'claude CLI helper: an error result throws')
  let noJson = false
  try { parseClaudeResult('zsh: command not found: claude-x') } catch (e) { noJson = (e as Error).message.includes('command not found') }
  ok(noJson, 'claude CLI helper: no result line → the error carries the output')

  // Role fields on a profile.
  const rp = sanitizeProfile({ id: 'main', name: 'M', kind: 'api', wire: 'openai', baseUrl: 'http://x/v1', model: 'm', subagentProfileId: 'fast', summaryProfileId: 'main', visionProfileId: 'bad id', visionModel: "sonnet'; rm -rf ~" }) as ApiProfile
  ok(rp.subagentProfileId === 'fast' && !rp.summaryProfileId && !rp.visionProfileId && !rp.visionModel, 'role ids: valid kept, self-reference and bad ids dropped; an unsafe --model is dropped')
  ok((sanitizeProfile({ id: 'main', name: 'M', kind: 'api', wire: 'openai', baseUrl: 'http://x/v1', model: 'm', visionModel: 'claude-sonnet-5-5' }) as ApiProfile).visionModel === 'claude-sonnet-5-5', 'a plain model id is kept')

  // look_at_slide in a text-only session.
  const describeCalls: Array<{ prompt: string; image: string }> = []
  const fakeVision: VisionHelper = { label: 'Vision', describe: async (image, prompt) => { describeCalls.push({ prompt, image: image.data }); return 'Step 4 overlaps the arrow.' } }
  const reviewText = 'Slide "s1" (1280x720) — elements in paint order:\n  h text @96,40 1088x80 "Steps"'
  const vtools = {
    defs: ['review_slide', 'render_preview', 'get_slide'].map((name) => ({ name, description: '', inputSchema: { type: 'object' } })),
    call: async (name: string) => (name === 'review_slide' ? { text: reviewText, images: [shot], isError: false } : { text: 'x', images: [], isError: false }),
  }
  const script = (steps: Array<{ text: string; toolCalls: any[] }>, log: Array<{ model: string; tools: string[]; images?: boolean; system: string }>) => {
    let n = 0
    return { complete: async (o: any) => { log.push({ model: o.model, tools: o.tools.map((t: { name: string }) => t.name), images: o.images, system: o.system }); const s = steps[Math.min(n++, steps.length - 1)]; return { ...s, truncated: false } } }
  }
  const vlog: Array<{ model: string; tools: string[]; images?: boolean; system: string }> = []
  const vsession = new ApiChatSession({
    chatId: '69696969-6969-6969-6969-696969696969', profile: { id: 'glm2', name: 'GLM', kind: 'api', wire: 'openai', baseUrl: 'http://glm2.test/v1', model: 'glm', textOnly: true },
    sessionDir, sharedDir: shared, transcriptDir: join(work, 'api-chats'), tools: vtools, roles: { vision: fakeVision },
    provider: script([{ text: '', toolCalls: [{ id: 'l1', name: LOOK_TOOL_NAME, args: { slideId: 's1', question: 'Are the six steps easy to follow?' } }] }, { text: 'Fixed.', toolCalls: [] }], vlog) as never,
  }, false)
  const vevents: ChatEvent[] = []
  vsession.onEvent((e) => vevents.push(e))
  await vsession.send('check the MCP slide')
  const lookEnd = vevents.find((e) => e.type === 'tool-end') as Extract<ChatEvent, { type: 'tool-end' }> | undefined
  ok(vlog[0].tools.includes(LOOK_TOOL_NAME) && !vlog[0].tools.includes('render_preview') && vlog[0].system.includes('call look_at_slide once per finished slide'), 'text-only + image-check model: look_at_slide offered and explained')
  ok(describeCalls.length === 1 && describeCalls[0].image === 'QUJD' && describeCalls[0].prompt.includes('Are the six steps easy to follow?') && describeCalls[0].prompt.includes('h text @96,40'), 'look_at_slide: review_slide\'s screenshot + element list + the question go to the helper')
  ok(!!lookEnd && !lookEnd.isError && lookEnd.text === 'Vision looked at slide "s1":\nStep 4 overlaps the arrow.' && lookEnd.images.length === 1, 'look_at_slide: the helper\'s answer comes back as text (the panel still gets the picture)')
  ok(vlog[1].images === false, 'the text-only model itself still never gets the image')
  vsession.dispose()
  const plainLog: Array<{ model: string; tools: string[]; images?: boolean; system: string }> = []
  const seeing = new ApiChatSession({
    chatId: '70707070-7070-7070-7070-707070707070', profile: { id: 'see', name: 'See', kind: 'api', wire: 'openai', baseUrl: 'http://see.test/v1', model: 'see' },
    sessionDir, sharedDir: shared, transcriptDir: join(work, 'api-chats'), tools: vtools, roles: { vision: fakeVision }, provider: script([{ text: 'ok', toolCalls: [] }], plainLog) as never,
  }, false)
  await seeing.send('hi')
  ok(!plainLog[0].tools.includes(LOOK_TOOL_NAME) && plainLog[0].tools.includes('render_preview'), 'a model that can see is not offered look_at_slide')
  seeing.dispose()

  // Subagents on another model.
  const mainLog: Array<{ model: string; tools: string[]; images?: boolean; system: string }> = []
  const subLog: Array<{ model: string; tools: string[]; images?: boolean; system: string }> = []
  const subProfile: ApiProfile = { id: 'fast', name: 'Fast', kind: 'api', wire: 'openai', baseUrl: 'http://fast.test/v1', model: 'fast-model', textOnly: true, contextWindow: 32000 }
  const rsession = new ApiChatSession({
    chatId: '71717171-7171-7171-7171-717171717171', profile: { id: 'big', name: 'Big', kind: 'api', wire: 'anthropic', baseUrl: 'http://big.test', model: 'big-model' },
    sessionDir, sharedDir: shared, transcriptDir: join(work, 'api-chats'), tools: vtools,
    provider: script([{ text: '', toolCalls: [{ id: 't1', name: 'task', args: { description: 'translate', prompt: 'Translate slide s1.' } }] }, { text: 'All done.', toolCalls: [] }], mainLog) as never,
    roles: { subagent: { profile: subProfile, provider: script([{ text: 'Translated s1.', toolCalls: [] }], subLog) as never }, vision: fakeVision },
  }, false)
  const revents: ChatEvent[] = []
  rsession.onEvent((e) => revents.push(e))
  await rsession.send('translate everything')
  const taskEnd = revents.find((e) => e.type === 'tool-end' && e.id === 't1') as Extract<ChatEvent, { type: 'tool-end' }> | undefined
  ok(mainLog.length === 2 && mainLog.every((l) => l.model === 'big-model') && subLog.length === 1 && subLog[0].model === 'fast-model', 'subagents run on the subagent model, the chat on its own')
  ok(subLog[0].system.includes(SUBAGENT_PREAMBLE) && !subLog[0].tools.includes('task') && subLog[0].images === false && subLog[0].tools.includes(LOOK_TOOL_NAME) && !subLog[0].tools.includes('render_preview'), 'the subagent gets the setup of ITS model (text-only here: look_at_slide, no render_preview)')
  ok(!mainLog[0].tools.includes(LOOK_TOOL_NAME) && mainLog[0].tools.includes('render_preview'), 'while the seeing main model keeps its own')
  ok(taskEnd?.text === 'Translated s1.', 'the subagent report reaches the chat')
  rsession.dispose()

  // How many subagents run at once.
  ok((sanitizeProfile({ id: 'p', name: 'P', kind: 'api', wire: 'openai', baseUrl: 'http://x/v1', model: 'm', maxParallelTasks: 8 }) as ApiProfile).maxParallelTasks === 8
    && !('maxParallelTasks' in (sanitizeProfile({ id: 'p', name: 'P', kind: 'api', wire: 'openai', baseUrl: 'http://x/v1', model: 'm', maxParallelTasks: 99 }) as ApiProfile)), 'maxParallelTasks: 1-16 kept, anything else dropped')
  for (const limit of [1, 3]) {
    let running = 0
    let peak = 0
    const calls = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: 'task', args: { description: 'x', prompt: 'y' } }))
    let n = 0
    await runAgent({
      provider: { complete: async () => (n++ === 0 ? { text: '', toolCalls: calls, truncated: false } : { text: 'done', toolCalls: [], truncated: false }) },
      baseUrl: 'x', model: 'm', maxTokens: 100, system: 's', tools: [], contextWindow: 1_000_000, maxParallelTasks: limit,
      runTool: async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); running--; return { text: 'ok', images: [], isError: false } },
      digest: () => null, messages: [{ role: 'user', text: 'go' }], emit: () => {}, changed: () => {},
    }, new AbortController().signal)
    ok(peak === limit, `maxParallelTasks ${limit}: at most ${limit} subagents at once (peak ${peak})`)
  }

  // Summaries on another model.
  const sumCalls: string[] = []
  const mainCalls: string[] = []
  const longChat: ChatMsg[] = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b', toolCalls: [] }, { role: 'user', text: 'c' }, { role: 'assistant', text: 'd', toolCalls: [] }, { role: 'user', text: 'e' }, { role: 'assistant', text: 'f', toolCalls: [] }]
  await compactConversation({
    provider: { complete: async (o) => { mainCalls.push(o.model); return { text: 'main summary', toolCalls: [], truncated: false } } },
    baseUrl: 'x', model: 'big', maxTokens: 32000, messages: longChat, emit: () => {}, changed: () => {},
    summarizer: { provider: { complete: async (o) => { sumCalls.push(`${o.model}/${o.maxTokens}/${o.system === SUMMARIZER_SYSTEM}`); return { text: 'small summary', toolCalls: [], truncated: false } } }, baseUrl: 'y', model: 'small', maxTokens: 2000 },
  }, undefined, new AbortController().signal)
  ok(mainCalls.length === 0 && sumCalls.join() === 'small/2000/true' && longChat[0].role === 'summary' && (longChat[0] as { text: string }).text === 'small summary', 'compaction summaries are written by the summary model')
}

// ---- 5. customizing the editor: the ui_profile tool, the Customize chat, MCP --
{
  console.log('\n-- ui_profile tool, Customize chat, MCP --')
  const dir = mkdtempSync(join(tmpdir(), 'ui-profile-'))
  const changes: UiChange[] = []
  const svc: UiProfileService = { path: join(dir, 'ui-customization.json'), disabled: false, broadcast: (c) => changes.push(c) }
  const run = (args: Record<string, unknown>) => runUiProfileTool(svc, args, 'agent')
  const got = JSON.parse(run({ op: 'get' }).text)
  ok(got.rev === 0 && got.profile === null, 'ui_profile get on a fresh install: no profile, rev 0')
  const cat = catalogFor()
  ok(Array.isArray(cat.commands) && (cat.commands as Array<{ id: string }>).some((c) => c.id === 'insert.chart') && !!cat.tokens && !!cat.icons && !!cat.ribbon && !!cat.schema, 'ui_profile catalog lists commands, ribbon, tokens, icons, schema')
  ok(Object.keys(JSON.parse(run({ op: 'catalog', section: 'tokens' }).text)).join() === 'tokens', 'a catalog section can be asked for alone')
  const idx = JSON.parse(run({ op: 'catalog' }).text)
  ok(!!idx.sections && !idx.commands && Object.keys(idx.sections).every((k) => k in catalogFor()), 'catalog without a section is a short index of real sections (progressive disclosure)')
  ok(['schema', 'ribbon', 'menus', 'toolbar', 'shortcuts', 'styles', 'tokens', 'defaults'].every((k) => typeof (catalogFor(k)[k] as { howto?: string }).howto === 'string'), 'every writable section carries its own how-to')
  ok(JSON.stringify(catalogFor('index')).length < 2000, 'the index stays small')
  const brand = { ribbon: { tabs: [{ id: 'brand', label: 'Brand', groups: [{ id: 'g', label: 'Make', buttons: [{ target: 'insert.chart' }] }] }] }, chrome: { light: { accent: '#0f766e' } } }
  const noSummary = run({ op: 'patch', patch: brand })
  ok(noSummary.isError && noSummary.text.includes('summary is required') && changes.length === 0, 'a write without a summary is refused')
  const bad = run({ op: 'patch', patch: { shortcuts: { 'Mod+S': 'insert.chart' }, chrome: { light: { accent: 'red;}' } } }, summary: 'x' })
  ok(bad.isError && bad.text.includes('shortcuts.Mod+S') && bad.text.includes('chrome.light.accent') && changes.length === 0, 'an invalid patch is refused with every path to fix, nothing written')
  const dry = run({ op: 'patch', patch: brand, dryRun: true })
  ok(!dry.isError && dry.text.startsWith('Valid (dry run') && changes.length === 0, 'dryRun validates without writing')
  const done = run({ op: 'patch', patch: brand, summary: 'Added a Brand tab' })
  ok(!done.isError && done.text.includes('revision #1') && changes.length === 1 && changes[0].source === 'agent' && changes[0].summary === 'Added a Brand tab', 'a valid patch is revision #1, broadcast as an agent change with its summary')
  ok(JSON.parse(run({ op: 'history' }).text).history[0].summary === 'Added a Brand tab', 'history lists it')
  ok(!run({ op: 'revert', rev: 0, summary: 'Undo' }).isError && currentProfile(svc).profile === null, 'revert to 0 removes it again')
  ok(run({ op: 'revert', rev: 999 }).isError && run({ op: 'frobnicate' }).isError, 'an unknown revision or op is an error')
  ok(runUiProfileTool({ ...svc, disabled: true }, { op: 'get' }, 'agent').isError, 'SLIDOMINGO_NO_UI_PROFILE: the tool refuses')

  // the MCP server advertises the same tool, and a request round-trips through a
  // stand-in for main's intercept (terminalPanel.ts → uiprofile.ts answerUiProfileRequest)
  const mcpDir = mkdtempSync(join(tmpdir(), 'ui-mcp-'))
  const child = spawn(process.execPath, [serverScript, mcpDir], { stdio: ['pipe', 'pipe', 'ignore'] })
  const replies = new Map<number, any>()
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += String(d)
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      try { const m = JSON.parse(line); replies.set(m.id, m) } catch { /* */ }
    }
  })
  const rpc = async (id: number, method: string, params: unknown) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    for (let n = 0; n < 200 && !replies.has(id); n++) await new Promise((r) => setTimeout(r, 25))
    return replies.get(id)
  }
  const intercept = watch(mcpDir, (_e, name) => {
    if (!name || !/^agent-action-(?!result-).+\.json$/.test(name)) return
    try {
      const req = JSON.parse(readFileSync(join(mcpDir, name), 'utf8'))
      if (req.verb !== 'ui_profile') return
      const r = runUiProfileTool(svc, req.args ?? {}, 'agent')
      writeFileSync(join(mcpDir, `agent-action-result-${req.requestId}.json`), JSON.stringify({ requestId: req.requestId, ok: true, ...r }))
    } catch { /* partial write: the next event */ }
  })
  await rpc(1, 'initialize', {})
  const list = await rpc(2, 'tools/list', {})
  const advertised = list?.result?.tools?.find((x: { name: string }) => x.name === 'ui_profile')
  ok(!!advertised && JSON.stringify(advertised) === JSON.stringify(UI_PROFILE_TOOL), 'the MCP server advertises ui_profile exactly as uiprofiletool.ts defines it')
  const viaMcp = await rpc(3, 'tools/call', { name: 'ui_profile', arguments: { op: 'patch', patch: { chrome: { density: 'compact' } }, summary: 'Compact chrome' } })
  ok(viaMcp?.result?.content?.[0]?.text?.startsWith('Applied as revision') && currentProfile(svc).profile?.chrome?.density === 'compact', 'an MCP ui_profile call is answered by the app and applied')
  const refused = await rpc(4, 'tools/call', { name: 'ui_profile', arguments: { op: 'patch', patch: { shortcuts: { 'Mod+S': 'x.y' } }, summary: 's' } })
  ok(refused?.result?.isError === true, 'a refused write comes back to the agent as an MCP error')
  intercept.close()
  child.kill()

  // the Customize chat: one tool, the skill as its system prompt, a turn that
  // reports its revisions (Undo this turn = revert to revBefore)
  const skillMd = readFileSync(join(here, '../desktop/src/main/apichat/skills/customize-ui.md'), 'utf8')
  ok(customizeSystemPrompt(skillMd).includes('ui_profile') && !customizeSystemPrompt(skillMd).startsWith('---'), 'the chat\'s system prompt is the skill body')
  const before = currentProfile(svc).rev
  const seen: Array<{ system: string; tools: Array<{ name: string }>; messages: ChatMsg[] }> = []
  const script = [
    { text: '', toolCalls: [{ id: 'u1', name: 'ui_profile', args: { op: 'get' } }] },
    { text: '', toolCalls: [{ id: 'u2', name: 'ui_profile', args: { op: 'patch', patch: { styles: { heading: { label: 'Heading', patch: { fontSize: 44, color: '#0f766e' } } }, actions: { 'apply-heading': { kind: 'style', style: 'heading' } }, shortcuts: { 'Mod+Shift+B': 'apply-heading' } }, summary: '⌘⇧B applies your heading look' } }] },
    { text: 'Done — ⌘⇧B now applies your heading look.', toolCalls: [] },
  ]
  const provider = {
    complete: async (o: { system: string; tools: Array<{ name: string }>; messages: ChatMsg[]; onText: (t: string) => void }) => {
      seen.push(JSON.parse(JSON.stringify({ system: o.system, tools: o.tools, messages: o.messages })))
      const step = script.shift()!
      if (step.text) o.onText(step.text)
      return { ...step, truncated: false }
    },
  }
  const profile: ApiProfile = { id: 'cz', name: 'Mock', kind: 'api', wire: 'anthropic', baseUrl: 'http://mock.invalid', model: 'm' }
  const chat = new CustomizeChat({ svc, profile, transcriptDir: join(dir, 'chats'), skillMd, provider })
  const evs: Array<{ type: string }> = []
  chat.onEvent((e) => evs.push(e))
  const turn = await chat.send('make ⌘⇧B my heading look', '[editor selection] text "Hello" {"fontSize":44}')
  ok(seen[0].tools.map((x) => x.name).join() === 'ui_profile', 'the chat offers the model exactly one tool: ui_profile (no deck tools, no MCP child)')
  ok(seen[0].system.includes('customize') && !seen[0].system.includes('slidomingo-slides tools'), 'with the customize system prompt, not the deck one')
  ok((seen[0].messages[0] as { text: string }).text.startsWith('[editor selection]'), 'the renderer\'s selection line leads the user message')
  ok(!!turn && turn.revBefore === before && turn.changes.length === 1 && turn.changes[0].summary === '⌘⇧B applies your heading look', 'the turn reports its one change and the revision before it')
  ok(currentProfile(svc).profile?.shortcuts?.['Mod+Shift+B'] === 'apply-heading' && changes.at(-1)?.source === 'chat', 'the profile changed, as a chat change')
  ok(evs.some((e) => e.type === 'turn') && chat.display().every((d) => d.kind === 'user' || d.kind === 'assistant') && chat.display().length === 2, 'the pane gets a turn event and a text-only transcript')
  ok(revertProfile(svc, turn!.revBefore).ok && currentProfile(svc).profile?.chrome?.density === 'compact' && !currentProfile(svc).profile?.shortcuts, 'Undo this turn restores exactly the profile before it')
  chat.dispose()
}

// ---- 5. gateways that stream two JSON values where one belongs -------------
// Seen with GLM behind a self-hosted gateway: "Unexpected non-whitespace character after
// JSON at position N" failed the whole turn.
{
  console.log('\n-- concatenated JSON from gateways --')
  const a = { slideId: 's2', elementId: 'title' }
  const A = JSON.stringify(a)
  ok(JSON.stringify(jsonValues(A + A)) === JSON.stringify([a, a]), 'jsonValues splits {…}{…}')
  ok(JSON.stringify(jsonValues('{"t":"a}{b\\"}"}\n{"x":[1,{"y":2}]}')) === '[{"t":"a}{b\\"}"},{"x":[1,{"y":2}]}]', 'jsonValues ignores braces inside strings')
  ok(jsonValues('{"a":1') === null && jsonValues('{"a":1}x') === null && jsonValues('') === null, 'jsonValues: truncated / trailing junk / empty → null')
  const one = (raw: string) => JSON.stringify(toolCallsFrom('t1', 'get_slide', raw))
  const single = JSON.stringify([{ id: 't1', name: 'get_slide', args: a }])
  ok(one(A) === single, 'tool args: one object')
  ok(one(A + A) === single, 'tool args: the same object twice → one call')
  ok(one('{}' + A) === single && one(A + '{}') === single, 'tool args: an empty object beside the real one is dropped')
  ok(one('') === JSON.stringify([{ id: 't1', name: 'get_slide', args: {} }]) && one('{"a":') === JSON.stringify([{ id: 't1', name: 'get_slide', args: {} }]), 'tool args: empty / unparseable → {}')
  const two = toolCallsFrom('t1', 'get_slide', A + '{"slideId":"s3"}')
  ok(two.length === 2 && two[0].id === 't1' && two[1].id === 't1_2' && two[1].args.slideId === 's3', 'tool args: two distinct objects → two calls, the second id suffixed')

  // Both providers against a gateway that mangles the stream.
  let body = ''
  const gw = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body) }) })
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
  const gwUrl = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`
  const ev = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const anthropicBody = (argDeltas: string[], joined = false) => [
    ev('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }),
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    // Two events on adjacent data: lines — SSE joins them with "\n".
    joined
      ? `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let ' } })}\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'me look.' } })}\n\n`
      : ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me look.' } }),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_slide', input: {} } }),
    ...argDeltas.map((p) => ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: p } })),
    ev('content_block_stop', { type: 'content_block_stop', index: 1 }),
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } }),
    ev('message_stop', { type: 'message_stop' }),
  ].join('')
  const opts = { maxTokens: 64, apiKey: 'k', system: 'S', tools: [{ name: 'get_slide', description: 'g', inputSchema: { type: 'object' } }], messages: [{ role: 'user', text: 'hi' }] as ChatMsg[], signal: new AbortController().signal, model: 'm' }
  const cases: Array<[string, string[], boolean]> = [
    ['well-formed', [A.slice(0, 9), A.slice(9)], false],
    ['args twice', [A.slice(0, 9), A.slice(9), A], false],
    ['{} then args', ['{}', A], false],
    ['two events on adjacent data: lines', [A], true],
  ]
  for (const [label, deltas, joined] of cases) {
    body = anthropicBody(deltas, joined)
    let streamed = ''
    try {
      const c = await anthropicProvider.complete({ ...opts, baseUrl: gwUrl, onText: (t) => { streamed += t } })
      ok(c.text === 'Let me look.' && streamed === c.text && JSON.stringify(c.toolCalls) === JSON.stringify([{ id: 'toolu_1', name: 'get_slide', args: a }]) && c.usage?.input === 10 && c.usage?.output === 7 && !c.truncated,
        `anthropic, ${label}: text, one get_slide call, usage`)
    } catch (e) { ok(false, `anthropic, ${label}: threw ${(e as Error).message}`) }
  }
  body = ev('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
    + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_9', name: 'get_slide', input: a } })
    + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
    + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } })
  {
    const c = await anthropicProvider.complete({ ...opts, baseUrl: gwUrl, onText: () => {} })
    ok(c.toolCalls[0]?.args.elementId === 'title' && c.truncated, 'anthropic: a tool input sent whole in content_block_start (no deltas) is kept; max_tokens → truncated')
  }
  body = ev('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
    + `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`
  {
    let err: unknown = null
    try { await anthropicProvider.complete({ ...opts, baseUrl: gwUrl, onText: () => {} }) } catch (e) { err = e }
    ok(err instanceof Error && /Overloaded/.test(err.message), 'anthropic: an error event still fails the request with its message')
  }
  body = `event: message_start\ndata: {"type":"message_start",oops}\n\n`
  {
    let err: unknown = null
    try { await anthropicProvider.complete({ ...opts, baseUrl: gwUrl, onText: () => {} }) } catch (e) { err = e }
    ok(err instanceof Error && err.message.includes('not JSON') && err.message.includes('oops'), 'anthropic: a really broken event fails with the raw data in the message')
  }

  const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  for (const [label, parts] of [['args twice', [A, A]], ['{} then args', ['{}', A]]] as Array<[string, string[]]>) {
    body = chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_slide', arguments: '' } }] })
      + parts.map((p) => chunk({ tool_calls: [{ index: 0, function: { arguments: p } }] })).join('')
      + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'
    const c = await openaiProvider.complete({ ...opts, baseUrl: `${gwUrl}/v1`, onText: () => {} })
    ok(JSON.stringify(c.toolCalls) === JSON.stringify([{ id: 'call_1', name: 'get_slide', args: a }]), `openai, ${label}: one get_slide call with its arguments`)
  }
  gw.close()
}

// ---- reasoning effort: profile setting, request fields, live thinking, empty-turn recovery
{
  console.log('\n-- reasoning --')
  const mk = (reasoning: unknown) => sanitizeProfile({ id: 'r', name: 'R', kind: 'api', wire: 'anthropic', baseUrl: 'https://x', model: 'm', reasoning }) as ApiProfile
  ok(mk('low').reasoning === 'low' && mk('high').reasoning === 'high', 'profile: reasoning low/medium/high is kept')
  ok(!('reasoning' in mk('max')) && !('reasoning' in mk('')) && !('reasoning' in mk(3)) && !('reasoning' in mk(undefined)), 'profile: anything else means Default (field absent)')
  ok(JSON.stringify(anthropicReasoningBody('https://api.anthropic.com', 'low')) === '{"output_config":{"effort":"low"}}', 'anthropic wire: api.anthropic.com gets output_config.effort')
  ok(JSON.stringify(anthropicReasoningBody('https://gw.example/anthropic', 'low')) === '{"reasoning_effort":"low"}' && Object.keys(anthropicReasoningBody('https://gw.example', undefined)).length === 0, 'anthropic wire: a gateway gets reasoning_effort; nothing without a setting')
  const bad = (message: string, status = 400) => Object.assign(new Error(message), { status })
  ok(isReasoningReject(bad('reasoning_effort: Extra inputs are not permitted')) && isReasoningReject(bad("Unrecognized request argument supplied: reasoning_effort")) && isReasoningReject(bad('output_config.effort: not supported for this model')), 'reasoning reject recognised')
  ok(!isReasoningReject(bad('max_tokens: 32000 > 8192')) && !isReasoningReject(bad('reasoning_effort', 500)) && !isReasoningReject(bad('not a multimodal model')), 'other errors are not reasoning rejects')

  // A tiny server: records bodies, streams reasoning before the answer, can refuse the field.
  const seen: any[] = []
  let refuse = false
  const rs = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      seen.push(body)
      if (refuse && ('reasoning_effort' in body || 'output_config' in body)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'reasoning_effort: Extra inputs are not permitted' } })); return }
      if (req.url === '/v1/messages') {
        sse(res, [
          ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think.' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer.' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 1 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }],
          ['message_stop', { type: 'message_stop' }],
        ])
      } else {
        const chunk = (delta: object, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })
        sse(res, [[null, chunk({ role: 'assistant', reasoning_content: 'Let me ' })], [null, chunk({ reasoning_content: 'think.' })], [null, chunk({ content: 'Answer.' })], [null, chunk({}, 'stop')], [null, '[DONE]']])
      }
    })
  })
  await new Promise<void>((r) => rs.listen(0, '127.0.0.1', r))
  const rurl = `http://127.0.0.1:${(rs.address() as AddressInfo).port}`
  const run = async (wire: 'anthropic' | 'openai', model: string, reasoning?: 'low') => {
    const thoughts: string[] = []
    const p: ApiProfile = { id: 'q', name: 'q', kind: 'api', wire, baseUrl: wire === 'openai' ? `${rurl}/v1` : rurl, model, ...(reasoning ? { reasoning } : {}) }
    const c = await providerFor(p).complete({ baseUrl: p.baseUrl, model, maxTokens: 64, system: 'S', tools: [], messages: [{ role: 'user', text: 'hi' }], signal: new AbortController().signal, onText: () => {}, onThinking: (t) => thoughts.push(t), reasoning })
    return { c, thoughts }
  }
  for (const wire of ['anthropic', 'openai'] as const) {
    seen.length = 0
    const a = await run(wire, `${wire}-low`, 'low')
    ok(seen[0].reasoning_effort === 'low' && !('output_config' in seen[0]), `${wire}: reasoning_effort: "low" is sent to a gateway`)
    ok(a.thoughts.join('') === 'Let me think.' && a.c.text === 'Answer.', `${wire}: the model's reasoning streams to onThinking, apart from the answer`)
    const b = await run(wire, `${wire}-none`)
    ok(!('reasoning_effort' in seen[1]) && !('output_config' in seen[1]) && b.c.text === 'Answer.', `${wire}: without a setting no reasoning field is sent`)
    refuse = true
    seen.length = 0
    const c1 = await run(wire, `${wire}-strict`, 'low')
    ok(seen.length === 2 && 'reasoning_effort' in seen[0] && !('reasoning_effort' in seen[1]) && c1.c.text === 'Answer.', `${wire}: a server that refuses the field gets one retry without it`)
    await run(wire, `${wire}-strict`, 'low')
    ok(seen.length === 3 && !('reasoning_effort' in seen[2]), `${wire}: …and is remembered, so later requests leave the field out`)
    refuse = false
  }
  rs.close()

  // The loop and the session: thinking events, an empty truncated turn, the retry.
  const prof: ApiProfile = { id: 'rp', name: 'rp', kind: 'api', wire: 'anthropic', baseUrl: 'http://x', model: 'm', reasoning: 'high' }
  const stub = { defs: [], call: async () => ({ text: '', images: [], isError: false }) }
  const calls: Array<{ reasoning?: string; messages: ChatMsg[] }> = []
  let mode: 'loop' | 'ok' = 'loop'
  const provider = {
    complete: async (o: { reasoning?: string; messages: ChatMsg[]; onThinking?: (t: string) => void; onText: (t: string) => void }) => {
      calls.push({ reasoning: o.reasoning, messages: JSON.parse(JSON.stringify(o.messages)) })
      if (mode === 'loop') { for (let i = 0; i < 3; i++) o.onThinking?.('hmm '.repeat(100)); return { text: '', toolCalls: [], truncated: true, usage: { input: 10, output: 50000, cacheRead: 0, cacheWrite: 0 } } }
      o.onThinking?.('quick'); o.onText('Done.'); return { text: 'Done.', toolCalls: [], truncated: false }
    },
  }
  const evs: ChatEvent[] = []
  const sess = new ApiChatSession({ chatId: 'bbbbbbbb-0000-0000-0000-00000000000a', profile: prof, sessionDir, sharedDir: shared, transcriptDir: join(work, 'api-chats'), provider, tools: stub }, false)
  sess.onEvent((e) => evs.push(e))
  await sess.send('make it red')
  ok(calls[0].reasoning === 'high', 'the profile\'s reasoning reaches the provider')
  ok(evs.filter((e) => e.type === 'thinking').length === 3, 'thinking events reach the panel')
  const err = evs.find((e) => e.type === 'error') as Extract<ChatEvent, { type: 'error' }> | undefined
  ok(!!err && /whole output budget \(about 50k tokens\) thinking/.test(err.message) && !/cut off at the output limit/.test(err.message) && err.retry?.effort === 'low', `an empty truncated turn says the budget went into thinking and offers a retry at low (${err?.message})`)
  const th = sess.display.find((d) => d.kind === 'thinking') as Extract<(typeof sess.display)[number], { kind: 'thinking' }> | undefined
  ok(!!th && th.chars === 1200 && !th.open, 'display keeps one closed thinking row with its exact size')
  const stored = loadTranscript(join(work, 'api-chats'), 'bbbbbbbb-0000-0000-0000-00000000000a')
  ok(stored?.messages.length === 1 && stored.messages[0].role === 'user', 'the empty reply is not stored (an empty assistant message would break the next request)')
  mode = 'ok'
  evs.length = 0
  await sess.retry('low')
  ok(calls.at(-1)!.reasoning === 'low' && calls.at(-1)!.messages.filter((m) => m.role === 'user').length === 1, 'retry runs the same request again at the chosen effort, without a second user message')
  ok(evs.some((e) => e.type === 'done' && !e.stopped) && !evs.some((e) => e.type === 'error') && sess.busy === false, 'the retry completes')
  await sess.retry('low')
  ok(calls.length === 2, 'retry does nothing once the conversation ends with an answer')
  // At low already: no retry offered.
  const evs2: ChatEvent[] = []
  mode = 'loop'
  const sess2 = new ApiChatSession({ chatId: 'bbbbbbbb-0000-0000-0000-00000000000b', profile: { ...prof, reasoning: 'low' }, sessionDir, sharedDir: shared, transcriptDir: join(work, 'api-chats'), provider, tools: stub }, false)
  sess2.onEvent((e) => evs2.push(e))
  await sess2.send('x')
  const err2 = evs2.find((e) => e.type === 'error') as Extract<ChatEvent, { type: 'error' }> | undefined
  ok(!!err2 && !err2.retry, 'no retry offer when the profile already reasons at low')
  // A truncated answer WITH text keeps the old advice.
  const evs3: ChatEvent[] = []
  const cut = { complete: async (o: { onText: (t: string) => void }) => { o.onText('Half an ans'); return { text: 'Half an ans', toolCalls: [], truncated: true } } }
  const sess3 = new ApiChatSession({ chatId: 'bbbbbbbb-0000-0000-0000-00000000000c', profile: prof, sessionDir, sharedDir: shared, transcriptDir: join(work, 'api-chats'), provider: cut, tools: stub }, false)
  sess3.onEvent((e) => evs3.push(e))
  await sess3.send('x')
  ok(evs3.some((e) => e.type === 'error' && e.message.includes('cut off at the output limit') && !e.retry), 'a truncated answer with text still points at "Max tokens"')
  sess.dispose(); sess2.dispose(); sess3.dispose()
}

watcher.close()
mock.close()
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
