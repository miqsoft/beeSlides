#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Agent-tools benchmark: how many tool calls, turns, tokens and dollars does a
// REAL Claude Code session spend on a fixed set of slide-editing tasks, and how
// does the result look? Measures one checkout at a time, so the same command
// run against main and against a branch gives before/after numbers on
// identical input.
//
//   node desktop/scripts/bench-agent-tools.mjs --repo <checkout> --out <dir>
//        [--tasks a,b] [--runs N] [--model X] [--timeout 360] [--viewport 1100x800] [--dpr 2]
//   node desktop/scripts/bench-agent-tools.mjs --compare <dirA> <dirB>
//   node desktop/scripts/bench-agent-tools.mjs --list
//
// What runs, per task and run (nothing Electron, nothing visible):
// - the checkout's slides editor from its vite dev server in headless Chrome,
//   booted straight into the task's fixture deck (bench/fixtures/*.json)
//   through a fake window.slidomingoDesktop (bench/harness.mjs);
// - a relay standing in for main (terminalPanel.ts): it forwards the MCP
//   server's per-request files to the page's callbacks and writes the answers
//   back; for render_preview/review_slide it crops a page screenshot to the
//   slide, like main's capturePage(rect);
// - the checkout's own MCP server (agent areas filled exactly like
//   agenttools.ts serverWithAgentAreas), selection-digest/session-note hooks,
//   workspace CLAUDE.md + customize-ui skill, context README/format.md/
//   agents.md, and claudeInstruction as --append-system-prompt;
// - `claude -p --output-format stream-json --verbose` in a fresh temp
//   workspace (outside any repo) with the panel's flags. The selection is
//   made by clicking the task's elements on the canvas, so selection.json and
//   the UserPromptSubmit digest are the app's own.
// Afterwards: the final deck, check_layout + a PNG of every touched slide,
// and the task's verify() numbers. Writes <out>/results.json, report.md, the
// stream-json transcripts and PNGs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { loadPlaywright, openEditor, sleep, startVite } from './bench/harness.mjs'
import { TASKS } from './bench/tasks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(here, 'bench/fixtures')
const MCP_PREFIX = 'mcp__slidomingo-slides__'

// ---------------------------------------------------------------------------
// args

function parseArgs(argv) {
  const a = { runs: 1, timeout: 360, viewport: '1100x800', dpr: 2, tasks: null, model: null, repo: null, out: null, compare: null, list: false, keepTmp: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = () => argv[++i]
    if (k === '--repo') a.repo = resolve(v())
    else if (k === '--out') a.out = resolve(v())
    else if (k === '--tasks') a.tasks = v().split(',').map((s) => s.trim()).filter(Boolean)
    else if (k === '--runs') a.runs = Math.max(1, parseInt(v(), 10) || 1)
    else if (k === '--model') a.model = v()
    else if (k === '--timeout') a.timeout = Math.max(10, parseInt(v(), 10) || 360)
    else if (k === '--viewport') a.viewport = v()
    else if (k === '--dpr') a.dpr = Number(v()) || 2
    else if (k === '--keep-tmp') a.keepTmp = true
    else if (k === '--smoke') a.smoke = true
    else if (k === '--compare') a.compare = [resolve(v()), resolve(v())]
    else if (k === '--list') a.list = true
    else if (k === '-h' || k === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(3, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0) }
    else throw new Error(`unknown argument ${k}`)
  }
  return a
}

const log = (...m) => { try { console.log(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...m) } catch { /* */ } }

// ---------------------------------------------------------------------------
// the checkout's own pieces

/** Bundles the checkout's claudeLaunch.ts + agenttools.ts (TypeScript, `?raw`
 *  imports) with its own esbuild, so the bench uses exactly what that
 *  checkout's app would write. */
async function loadCheckout(repo) {
  const req = createRequire(join(repo, 'slides/package.json'))
  const esbuild = await import(pathToFileURL(req.resolve('esbuild')).href)
  const main = join(repo, 'desktop/src/main')
  const raw = {
    name: 'raw',
    setup(b) {
      b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }))
      b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }))
    },
  }
  const built = await esbuild.build({
    stdin: {
      contents: `export { claudeInstruction } from './claudeLaunch.ts'\nexport { serverWithAgentAreas } from './agenttools.ts'\n`,
      resolveDir: main, loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', write: false, plugins: [raw], logLevel: 'silent',
    define: { __APP_VERSION__: '"bench"' },
  })
  const tmp = mkdtempSync(join(tmpdir(), 'slidomingo-bench-mod-'))
  const modPath = join(tmp, 'checkout.mjs')
  writeFileSync(modPath, built.outputFiles[0].text)
  const mod = await import(pathToFileURL(modPath).href)
  rmSync(tmp, { recursive: true, force: true })

  const panelSrc = readFileSync(join(main, 'terminalPanel.ts'), 'utf8')
  const evalConst = (name) => {
    const m = panelSrc.match(new RegExp(`const ${name}(?::[^=]+)? =\\s*([\\s\\S]*?)\\n\\n`))
    if (!m) throw new Error(`${name} not found in terminalPanel.ts`)
    return new Function(`return (${m[1]})`)()
  }
  const serverSrc = readFileSync(join(repo, 'desktop/src/mcp/slides-mcp-server.mjs'), 'utf8')
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).stdout.trim()
  return {
    repo,
    rev: git('rev-parse', '--short', 'HEAD'),
    branch: ((b) => (b === 'HEAD' ? `${git('name-rev', '--name-only', 'HEAD')} (detached)` : b))(git('rev-parse', '--abbrev-ref', 'HEAD')),
    dirty: git('status', '--porcelain', '--', 'slides/src', 'desktop/src', 'docs').length > 0,
    claudeInstruction: mod.claudeInstruction,
    server: mod.serverWithAgentAreas(serverSrc),
    agentPrompts: evalConst('AGENT_PROMPTS'),
    contextReadme: evalConst('CONTEXT_README'),
    formatMd: readFileSync(join(repo, 'docs/format.md'), 'utf8'),
    agentsMd: readFileSync(join(repo, 'docs/agents.md'), 'utf8'),
    digestSrc: readFileSync(join(repo, 'desktop/src/mcp/selection-digest.mjs'), 'utf8'),
    sessionNoteSrc: readFileSync(join(repo, 'desktop/src/mcp/session-note.mjs'), 'utf8'),
    customizeSkill: (() => { try { return readFileSync(join(main, 'apichat/skills/customize-ui.md'), 'utf8') } catch { return null } })(),
  }
}

/** The workspace + context dir + session dir as terminalPanel.ts/openPanel/
 *  createSession and workspaces.ts/ensureWorkspace lay them out. */
function makeWorkspace(co) {
  const root = mkdtempSync(join(tmpdir(), 'slidomingo-bench-'))
  const ws = join(root, 'workspace')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'CLAUDE.md'),
    `# BeeSlides workspace\n\n` +
    `This folder is managed by the BeeSlides app; do not put files here.\n` +
    `You are editing an unsaved deck through the slidomingo-slides MCP tools.\n`, 'utf8')
  if (co.customizeSkill) {
    mkdirSync(join(ws, '.claude/skills/customize-ui'), { recursive: true })
    writeFileSync(join(ws, '.claude/skills/customize-ui/SKILL.md'), co.customizeSkill, 'utf8')
  }
  const sharedName = '.slidomingo-context-1'
  const shared = join(ws, sharedName)
  mkdirSync(shared, { recursive: true })
  writeFileSync(join(shared, 'README.md'), co.contextReadme, 'utf8')
  writeFileSync(join(shared, 'format.md'), co.formatMd, 'utf8')
  writeFileSync(join(shared, 'agents.md'), co.agentsMd, 'utf8')
  writeFileSync(join(shared, 'slides-mcp-server.mjs'), co.server, 'utf8')
  writeFileSync(join(shared, 'selection-digest.mjs'), co.digestSrc, 'utf8')
  writeFileSync(join(shared, 'session-note.mjs'), co.sessionNoteSrc, 'utf8')
  const id = randomUUID()
  const sessionName = `${sharedName}/session-${id}`
  const sessionDir = join(shared, `session-${id}`)
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'mcp-config.json'), JSON.stringify({
    mcpServers: { 'slidomingo-slides': { command: 'node', args: [join(shared, 'slides-mcp-server.mjs'), sessionDir] } },
  }, null, 2), 'utf8')
  const hook = (script, arg) => {
    const file = join(shared, script)
    const parts = arg ? [file, arg] : [file]
    if (!parts.every((x) => /^[\w\s./@+=,:~-]+$/.test(x))) throw new Error(`unsafe hook path ${file}`)
    return `[ -f "${file}" ] && node ${parts.map((x) => `"${x}"`).join(' ')}; exit 0`
  }
  writeFileSync(join(sessionDir, 'settings.json'), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook('selection-digest.mjs'), timeout: 5 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: hook('session-note.mjs', sessionDir), timeout: 5 }] }],
    },
  }, null, 2), 'utf8')
  return { root, ws, shared, sharedName, sessionDir, sessionName }
}

/** pty.ts/claudeLaunch.ts's flags, minus the pty: -p + stream-json, the
 *  prompt on stdin. --allowedTools first (it is variadic). */
function claudeArgs(co, w, chatId, model) {
  return [
    '--allowedTools', 'mcp__slidomingo-slides', 'Read', 'Glob', 'Grep',
    '-p', '--output-format', 'stream-json', '--verbose',
    '--append-system-prompt', co.claudeInstruction(w.sharedName),
    '--session-id', chatId,
    '--mcp-config', `./${w.sessionName}/mcp-config.json`, '--strict-mcp-config',
    '--settings', `./${w.sessionName}/settings.json`,
    ...(model ? ['--model', model] : []),
  ]
}

function claudeEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    // never inherit the calling Claude Code session (effort, session ids, sockets)
    if (/^(CLAUDE|AI_AGENT)/.test(k) && k !== 'CLAUDE_CONFIG_DIR') continue
    env[k] = v
  }
  delete env.SLIDOMINGO_DECK_DIR
  return env
}

// ---------------------------------------------------------------------------
// transcript → metrics

function parseTranscript(text) {
  const calls = []
  const results = new Map()
  const turnIds = new Set()
  let init = null
  let result = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'system' && ev.subtype === 'init') init = ev
    else if (ev.type === 'assistant' && ev.message) {
      if (ev.parent_tool_use_id) continue // a subagent's turn
      turnIds.add(ev.message.id)
      for (const c of ev.message.content ?? []) {
        if (c.type === 'tool_use') calls.push({ id: c.id, name: c.name, input: c.input })
      }
    } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c.type !== 'tool_result') continue
        const parts = Array.isArray(c.content) ? c.content : [{ type: 'text', text: String(c.content ?? '') }]
        const txt = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
        results.set(c.tool_use_id, { isError: !!c.is_error, text: txt, images: parts.filter((p) => p.type === 'image').length })
      }
    } else if (ev.type === 'result') result = ev
  }
  const perTool = {}
  let mcp = 0, builtin = 0, errors = 0, layoutBanners = 0, layoutAdjusted = 0, images = 0
  const timeline = calls.map((c) => {
    const short = c.name.startsWith(MCP_PREFIX) ? c.name.slice(MCP_PREFIX.length) : c.name
    perTool[short] = (perTool[short] ?? 0) + 1
    if (c.name.startsWith(MCP_PREFIX)) mcp++; else builtin++
    const r = results.get(c.id)
    const err = !!r && (r.isError || /^Error:/.test(r.text) || /"ok"\s*:\s*false/.test(r.text))
    if (err) errors++
    if (r && /⚠ LAYOUT/.test(r.text)) layoutBanners++
    if (r && /↻ LAYOUT ADJUSTED/.test(r.text)) layoutAdjusted++
    images += r?.images ?? 0
    return { tool: short, input: summarizeInput(c.input), error: err, result: r ? r.text.slice(0, 300) : null }
  })
  const u = result?.usage ?? {}
  return {
    model: init?.model ?? null,
    mcpStatus: init?.mcp_servers ?? null,
    toolCalls: calls.length, mcpCalls: mcp, builtinCalls: builtin, perTool,
    toolErrors: errors, layoutBanners, layoutAdjusted, screenshots: images,
    assistantTurns: turnIds.size,
    numTurns: result?.num_turns ?? null,
    tokens: {
      input: u.input_tokens ?? null, output: u.output_tokens ?? null,
      cacheRead: u.cache_read_input_tokens ?? null, cacheWrite: u.cache_creation_input_tokens ?? null,
    },
    costUsd: result?.total_cost_usd ?? null,
    modelUsage: result?.modelUsage ?? null,
    durationMs: result?.duration_ms ?? null,
    resultSubtype: result?.subtype ?? null,
    isError: result?.is_error ?? null,
    permissionDenials: result?.permission_denials?.length ?? 0,
    finalText: typeof result?.result === 'string' ? result.result.slice(0, 1500) : null,
    timeline,
  }
}

function summarizeInput(input) {
  const s = JSON.stringify(input ?? {})
  return s.length > 240 ? `${s.slice(0, 240)}…` : s
}

// ---------------------------------------------------------------------------
// one run

async function runOne({ co, task, run, browser, url, args, outDir }) {
  const tag = `${task.name}-r${run}`
  const fixtureText = readFileSync(join(FIXTURES, `${task.fixture}.json`), 'utf8')
  const before = JSON.parse(fixtureText)
  const w = makeWorkspace(co)
  const relayLog = []
  const t0 = Date.now()
  const rlog = (m) => relayLog.push(`${((Date.now() - t0) / 1000).toFixed(2)} ${m}`)
  const [vw, vh] = args.viewport.split('x').map(Number)
  let selectionJson = null
  const editor = await openEditor(browser, {
    url, launchText: fixtureText, viewport: { width: vw, height: vh }, dpr: args.dpr, sessionDir: w.sessionDir, log: rlog,
    onSelection: (json) => { selectionJson = json; writeFileSync(join(w.shared, 'selection.json'), json, 'utf8') },
  })
  const record = { task: task.name, run, startedAt: new Date().toISOString(), files: {} }
  try {
    const { page, relay } = editor
    relay.start()
    // the slide the user is looking at (review_slide navigates), and its "before" picture
    const pre = await relay.query('review_slide', { slideId: task.slideId }, { capture: true })
    if (pre.ok && pre.result?.image?.data) {
      const f = `${tag}-before-${task.slideId}.png`
      writeFileSync(join(outDir, f), Buffer.from(pre.result.image.data, 'base64'))
      record.files.before = f
    }
    record.before = { clean: pre.result?.clean ?? null, issues: pre.result?.issues?.length ?? null }
    await sleep(1600) // review_slide's capture chrome comes back after 1.5s
    // select like the user: click, shift-click the rest; nothing selected =
    // select + Escape, so the app writes a (empty) selection.json
    if (task.marquee) {
      // a rubber-band drag over empty canvas, in slide coordinates (shift-clicks
      // land inside a multi-selection's Moveable box once it spans a 2D area)
      const rect = pre.result?.rect
      if (!rect) throw new Error('no slide rect for the marquee')
      const k = rect.width / (before.size?.width ?? 1280)
      const [x0, y0, x1, y1] = task.marquee.map((v) => v * k)
      await page.mouse.move(rect.x + x0, rect.y + y0)
      await page.mouse.down()
      await page.mouse.move(rect.x + x1, rect.y + y1, { steps: 12 })
      await page.mouse.up()
    } else if (task.select.length) {
      for (const [i, id] of task.select.entries()) {
        await page.locator(`.ed-stage [data-el-id="${id}"]`).first().click({ delay: 80, modifiers: i ? ['Shift'] : [], force: true })
      }
    } else {
      const any = before.slides.find((s) => s.id === task.slideId)?.elements?.[0]?.id
      if (any) {
        await page.locator(`.ed-stage [data-el-id="${any}"]`).first().click({ delay: 80, force: true })
        await sleep(200)
      }
      await page.keyboard.press('Escape')
    }
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await sleep(250)
      const sel = selectionJson ? JSON.parse(selectionJson) : null
      if (sel && sel.slideId === task.slideId && ((task.select.length || task.marquee) ? sel.selection.length > 0 : sel.selection.length === 0)) break
    }
    await sleep(600) // the 400ms debounce, settled
    const sel = selectionJson ? JSON.parse(selectionJson) : null
    record.selection = sel ? { slideId: sel.slideId, ids: sel.selection.map((e) => e.id) } : null
    // never spend a model run on the wrong starting state
    if (!sel || sel.slideId !== task.slideId) throw new Error(`selection.json not on ${task.slideId}: ${sel?.slideId}`)
    const want = task.expectSelected ?? task.select.length
    if (sel.selection.length !== want) throw new Error(`expected ${want} selected elements, got ${sel.selection.length}: ${record.selection.ids.join(',')}`)
    try {
      const { digest } = await import(`${pathToFileURL(join(w.shared, 'selection-digest.mjs')).href}?t=${Date.now()}`)
      record.digest = sel ? digest(sel) : null
    } catch (e) { record.digest = `(digest failed: ${e})` }

    const prompt = typeof task.prompt === 'function' ? task.prompt(co.agentPrompts) : task.prompt
    record.prompt = prompt
    if (args.smoke) {
      // the plumbing without a model: talk to the MCP server directly
      record.smoke = await smokeMcp(w, task)
      return record
    }
    const chatId = randomUUID()
    const transcriptFile = `${tag}.stream.jsonl`
    const out = createWriteStream(join(outDir, transcriptFile))
    let transcript = ''
    let stderr = ''
    log(`${tag}: claude running…`)
    const tc = Date.now()
    const child = spawn('claude', claudeArgs(co, w, chatId, args.model), { cwd: w.ws, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.on('data', (c) => { transcript += c; out.write(c) })
    child.stderr.on('data', (c) => { stderr += c })
    child.stdin.end(prompt)
    let timedOut = false
    const killer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000) }, args.timeout * 1000)
    const exitCode = await new Promise((r) => child.on('close', (code) => r(code)))
    clearTimeout(killer)
    out.end()
    record.wallMs = Date.now() - tc
    record.exitCode = exitCode
    record.timedOut = timedOut
    if (stderr.trim()) record.stderr = stderr.slice(-2000)
    record.files.transcript = transcriptFile
    Object.assign(record, parseTranscript(transcript))
    log(`${tag}: ${record.toolCalls} tool calls, ${record.toolErrors} errors, ${record.assistantTurns} turns, $${record.costUsd?.toFixed?.(3) ?? '?'}, ${(record.wallMs / 1000).toFixed(0)}s${timedOut ? ' (TIMED OUT)' : ''}`)

    // final state
    await sleep(800)
    const after = await page.evaluate(() => JSON.parse(JSON.stringify(window.slidomingo.doc)))
    const deckFile = `${tag}.final-deck.json`
    writeFileSync(join(outDir, deckFile), JSON.stringify(after, null, 1))
    record.files.finalDeck = deckFile
    const touched = new Set([task.slideId])
    for (const s of after.slides) {
      const b = before.slides.find((x) => x.id === s.id)
      if (!b || JSON.stringify(b) !== JSON.stringify(s)) touched.add(s.id)
    }
    for (const c of record.timeline ?? []) {
      try { const sid = JSON.parse(c.input.replace(/…$/, '')).slideId; if (typeof sid === 'string') touched.add(sid) } catch { /* clipped input */ }
    }
    record.slides = []
    await page.keyboard.press('Escape').catch(() => {})
    for (const sid of touched) {
      if (!after.slides.some((s) => s.id === sid)) { record.slides.push({ slideId: sid, deleted: true }); continue }
      const chk = await relay.query('check_layout', { slideId: sid })
      const shot = await relay.query('review_slide', { slideId: sid }, { capture: true })
      let png = null
      if (shot.ok && shot.result?.image?.data) {
        png = `${tag}-after-${sid}.png`
        writeFileSync(join(outDir, png), Buffer.from(shot.result.image.data, 'base64'))
      }
      record.slides.push({
        slideId: sid,
        clean: chk.ok ? chk.result.clean : null,
        issues: chk.ok ? chk.result.issues.length : null,
        issueList: chk.ok ? chk.result.issues.map((i) => `[${i.code}] ${i.message}`) : [chk.error],
        png,
      })
      await sleep(300)
    }
    record.layoutIssues = record.slides.reduce((n, s) => n + (s.issues ?? 0), 0)
    record.layoutClean = record.slides.every((s) => s.deleted || s.clean === true)
    try { record.verify = task.verify(before, after) } catch (e) { record.verify = { error: String(e) } }
    record.relay = relay.stats
    record.pageErrors = editor.pageErrors.slice(0, 20)
    writeFileSync(join(outDir, `${tag}.relay.log`), relayLog.join('\n') + '\n')
    record.files.relayLog = `${tag}.relay.log`
  } catch (err) {
    record.error = String(err?.stack ?? err)
    log(`${tag}: FAILED ${err}`)
  } finally {
    await editor.close().catch(() => {})
    if (args.keepTmp) record.tmp = w.root
    else rmSync(w.root, { recursive: true, force: true })
  }
  return record
}

/** --smoke: a scripted JSON-RPC client against the session's MCP server
 *  (no claude, no cost) — checks the relay end to end. */
async function smokeMcp(w, task) {
  const child = spawn('node', [join(w.shared, 'slides-mcp-server.mjs'), w.sessionDir], { stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  const waiting = new Map()
  child.stdout.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      try { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id) } catch { /* */ }
    }
  })
  let id = 0
  const call = (method, params) => new Promise((r) => { const n = ++id; waiting.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n') })
  const out = []
  await call('initialize', { protocolVersion: '2024-11-05' })
  const list = await call('tools/list', {})
  out.push(`tools/list: ${list.result?.tools?.length} tools (${list.result?.tools?.map((t) => t.name).join(', ')})`)
  for (const [name, a] of [['get_slide', { slideId: task.slideId, view: 'summary' }], ['comments', { resolved: false }], ['check_layout', { slideId: task.slideId }], ['review_slide', { slideId: task.slideId }], ['deck', { op: 'help' }]]) {
    const t = Date.now()
    const r = await call('tools/call', { name, arguments: a })
    const c = r.result?.content ?? []
    out.push(`${name}: ${Date.now() - t}ms isError=${!!r.result?.isError} ${c.map((p) => (p.type === 'image' ? `[image ${p.data.length}b64]` : JSON.stringify(p.text.slice(0, 160)))).join(' ')}`)
  }
  child.stdin.end()
  return out
}

// ---------------------------------------------------------------------------
// report

const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? '–' : Number(n).toFixed(d))
const k = (n) => (n == null ? '–' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function verifyLine(v) {
  if (!v) return ''
  const flat = []
  const walk = (o, p) => {
    for (const [key, val] of Object.entries(o)) {
      if (val && typeof val === 'object') walk(val, `${p}${key}.`)
      else flat.push(`${p}${key}=${val}`)
    }
  }
  walk(v, '')
  return flat.join(' ')
}

function topTools(perTool, n = 6) {
  return Object.entries(perTool ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([t, c]) => `${t}×${c}`).join(', ')
}

function report(meta, records) {
  const lines = [
    `# Agent-tools bench — ${meta.checkout.branch} @ ${meta.checkout.rev}${meta.checkout.dirty ? ' (dirty)' : ''}`,
    '',
    `- checkout: \`${meta.checkout.repo}\``,
    `- model: ${[...new Set(records.map((r) => r.model).filter(Boolean))].join(', ') || '?'} (requested: ${meta.args.model ?? 'CLI default'}), claude ${meta.claudeVersion}`,
    `- runs per task: ${meta.args.runs}, timeout ${meta.args.timeout}s, viewport ${meta.args.viewport} @${meta.args.dpr}x, ${meta.startedAt}`,
    '',
    '| task | run | tools | mcp | built-in | errors | turns | in | out | cache r | cache w | cost $ | wall s | layout | top tools |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const r of records) {
    const layout = r.error ? 'ERROR' : `${r.layoutClean ? 'clean' : 'issues'} (${r.layoutIssues ?? '?'})`
    lines.push(`| ${r.task} | ${r.run} | ${r.toolCalls ?? '–'} | ${r.mcpCalls ?? '–'} | ${r.builtinCalls ?? '–'} | ${r.toolErrors ?? '–'} | ${r.assistantTurns ?? '–'} | ${k(r.tokens?.input)} | ${k(r.tokens?.output)} | ${k(r.tokens?.cacheRead)} | ${k(r.tokens?.cacheWrite)} | ${fmt(r.costUsd, 3)} | ${fmt(r.wallMs / 1000)}${r.timedOut ? ' ⏱' : ''} | ${layout} | ${topTools(r.perTool)} |`)
  }
  lines.push('', '## Task checks', '')
  for (const r of records) lines.push(`- **${r.task}** r${r.run}: ${r.error ? `error: ${r.error.split('\n')[0]}` : verifyLine(r.verify)}`)
  lines.push('', '## Screenshots', '')
  for (const r of records) {
    const pngs = [r.files?.before, ...(r.slides ?? []).map((s) => s.png)].filter(Boolean)
    if (pngs.length) lines.push(`- ${r.task} r${r.run}: ${pngs.map((p) => `[${p}](${p})`).join(' · ')}`)
  }
  return lines.join('\n') + '\n'
}

function compare(dirA, dirB) {
  const load = (d) => JSON.parse(readFileSync(join(d, 'results.json'), 'utf8'))
  const A = load(dirA), B = load(dirB)
  const mean = (rs, f) => {
    const xs = rs.map(f).filter((x) => typeof x === 'number' && !Number.isNaN(x))
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null
  }
  const tasks = [...new Set([...A.records, ...B.records].map((r) => r.task))]
  const metrics = [
    ['tools', (r) => r.toolCalls, 1], ['errors', (r) => r.toolErrors, 1], ['turns', (r) => r.assistantTurns, 1],
    ['cost $', (r) => r.costUsd, 3], ['wall s', (r) => (r.wallMs ?? 0) / 1000, 0], ['layout issues', (r) => r.layoutIssues, 1],
  ]
  const head = `A = ${A.meta.checkout.branch}@${A.meta.checkout.rev} (${dirA})\nB = ${B.meta.checkout.branch}@${B.meta.checkout.rev} (${dirB})\n`
  const lines = [head, `| task | ${metrics.map((m) => m[0]).join(' | ')} |`, `|---|${metrics.map(() => '---').join('|')}|`]
  const tot = metrics.map(() => [0, 0])
  for (const t of tasks) {
    const ra = A.records.filter((r) => r.task === t && !r.error), rb = B.records.filter((r) => r.task === t && !r.error)
    const cells = metrics.map(([, f, d], i) => {
      const a = mean(ra, f), b = mean(rb, f)
      if (a != null) tot[i][0] += a
      if (b != null) tot[i][1] += b
      return `${fmt(a, d)} → ${fmt(b, d)}`
    })
    lines.push(`| ${t} | ${cells.join(' | ')} |`)
  }
  lines.push(`| **total** | ${tot.map(([a, b], i) => `${fmt(a, metrics[i][2])} → ${fmt(b, metrics[i][2])}`).join(' | ')} |`)
  lines.push('', 'Task checks (A | B):')
  for (const t of tasks) {
    const va = A.records.filter((r) => r.task === t).map((r) => verifyLine(r.verify)).join(' / ')
    const vb = B.records.filter((r) => r.task === t).map((r) => verifyLine(r.verify)).join(' / ')
    const ta = A.records.filter((r) => r.task === t).map((r) => topTools(r.perTool, 10)).join(' / ')
    const tb = B.records.filter((r) => r.task === t).map((r) => topTools(r.perTool, 10)).join(' / ')
    lines.push(`- ${t}\n  A: ${va || '–'}\n     tools: ${ta || '–'}\n  B: ${vb || '–'}\n     tools: ${tb || '–'}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.list) { for (const t of TASKS) console.log(t.name); return }
  if (args.compare) { console.log(compare(...args.compare)); return }
  if (!args.repo || !args.out) throw new Error('--repo <checkout> and --out <dir> are required (or --compare A B)')
  const tasks = args.tasks ? args.tasks.map((n) => TASKS.find((t) => t.name === n) ?? (() => { throw new Error(`unknown task ${n}`) })()) : TASKS
  mkdirSync(args.out, { recursive: true })
  const co = await loadCheckout(args.repo)
  const claudeVersion = spawnSync('claude', ['--version'], { encoding: 'utf8', env: claudeEnv() }).stdout.trim()
  const meta = {
    checkout: { repo: co.repo, rev: co.rev, branch: co.branch, dirty: co.dirty },
    args: { tasks: tasks.map((t) => t.name), runs: args.runs, model: args.model, timeout: args.timeout, viewport: args.viewport, dpr: args.dpr },
    claudeVersion, startedAt: new Date().toISOString(),
    claudeInstruction: co.claudeInstruction('.slidomingo-context-1'),
  }
  log(`checkout ${co.branch}@${co.rev}${co.dirty ? ' (dirty)' : ''}, claude ${claudeVersion}`)
  const chromium = await loadPlaywright(args.repo)
  const vite = await startVite(args.repo, log)
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const records = []
  const save = () => {
    writeFileSync(join(args.out, 'results.json'), JSON.stringify({ meta, records }, null, 1))
    writeFileSync(join(args.out, 'report.md'), report(meta, records))
  }
  try {
    for (const task of tasks) {
      for (let run = 1; run <= args.runs; run++) {
        records.push(await runOne({ co, task, run, browser, url: vite.url, args, outDir: args.out }))
        save()
      }
    }
  } finally {
    await browser.close().catch(() => {})
    vite.stop()
  }
  save()
  log(`wrote ${join(args.out, 'report.md')}`)
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1) })
