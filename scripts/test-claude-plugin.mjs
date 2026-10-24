#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The BeeSlides plugin for Claude Code (claude-plugin/, built by
// scripts/build-claude-plugin.mjs):
//   - claude-plugin/ matches its sources (it is generated and committed)
//   - the marketplace lists it, manifest and .mcp.json are what Claude Code reads
//   - every skill carries the line that says where the reference docs are
//   - the launcher with no app set up: one tool that explains the setup
//   - the launcher with the app's folder: the app's own server and tools, plus
//     the plugin's instruction in initialize, pointing at real files
//
//   node scripts/test-claude-plugin.mjs
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const plugin = join(root, 'claude-plugin')
let failed = 0
const ok = (cond, msg) => { if (cond) console.log(`  ok  ${msg}`); else { failed++; console.log(`FAIL  ${msg}`) } }
const json = (p) => JSON.parse(readFileSync(p, 'utf8'))

/** Runs the launcher with `env`; `talk(rpc)` makes the calls. */
async function withLauncher(env, talk) {
  const child = spawn(process.execPath, [join(plugin, 'mcp/launch.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } })
  const replies = new Map()
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += String(d)
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1)
      replies.get(msg.id)?.(msg)
    }
  })
  let next = 1
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = next++
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15000)
    replies.set(id, (m) => { clearTimeout(timer); resolve(m) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try { return await talk(rpc) } finally { child.kill() }
}

const work = mkdtempSync(join(tmpdir(), 'bs-plugin-'))
try {
  console.log('generated and listed')
  {
    const r = spawnSync(process.execPath, [join(root, 'scripts/build-claude-plugin.mjs'), '--check'], { encoding: 'utf8' })
    ok(r.status === 0, `claude-plugin/ matches its sources${r.status ? `\n${r.stdout}` : ''}`)
    const market = json(join(root, '.claude-plugin/marketplace.json'))
    const entry = market.plugins?.find((p) => p.name === 'beeslides')
    ok(entry?.source === './claude-plugin' && json(join(plugin, '.claude-plugin/plugin.json')).name === 'beeslides', 'the marketplace lists ./claude-plugin as beeslides')
    const mcp = json(join(plugin, '.mcp.json')).mcpServers?.beeslides
    ok(mcp?.command === 'node' && mcp.args?.[0] === '${CLAUDE_PLUGIN_ROOT}/mcp/launch.mjs', '.mcp.json starts the launcher from the plugin folder')
    const version = json(join(root, 'slides/package.json')).version
    ok(json(join(plugin, '.claude-plugin/plugin.json')).version === version, `the plugin carries the app's version (${version})`)
    for (const name of ['build-deck', 'restyle-deck', 'polish-deck', 'slide-designs']) {
      const md = readFileSync(join(plugin, 'skills', name, 'SKILL.md'), 'utf8')
      ok(md.startsWith(`---\nname: ${name}\n`) && md.includes('`../../reference/agents.md`'), `skill ${name}: frontmatter first, then where the reference docs are`)
    }
  }

  console.log('no app set up')
  await withLauncher({ BEESLIDES_AGENT_DIR: join(work, 'nothing-here') }, async (rpc) => {
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } })).result
    ok(init?.protocolVersion === '2025-06-18' && /BeeSlides deck/.test(init.instructions) && /Allow AI apps outside BeeSlides/.test(init.instructions), 'initialize: the plugin instruction and the setup steps')
    const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name)
    ok(tools.length === 1 && tools[0] === 'setup_status', 'one tool: setup_status')
    const r = (await rpc('tools/call', { name: 'setup_status', arguments: {} })).result
    ok(!r.isError && /Settings ▸ AI chat ▸ Advanced/.test(r.content[0].text) && /\/mcp/.test(r.content[0].text), 'it says where to switch it on and how to reconnect')
    const other = (await rpc('tools/call', { name: 'doc_info', arguments: {} })).result
    ok(other.isError && /not set up/.test(other.content[0].text), 'any other tool answers with the same steps, as an error')
  })

  console.log('the app\'s folder')
  {
    // what the app writes into <userData>/agent (agentendpoint.ts), switched off: no endpoint.json
    const agent = join(work, 'agent')
    mkdirSync(agent, { recursive: true })
    copyFileSync(join(root, 'desktop/src/mcp/slides-mcp-server.mjs'), join(agent, 'beeslides-mcp.mjs'))
    await withLauncher({ BEESLIDES_AGENT_DIR: agent }, async (rpc) => {
      const init = (await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code' } })).result
      ok(init?.serverInfo?.name === 'beeslides' && init.serverInfo.version !== 'setup', 'initialize comes from the app\'s own server')
      const ref = /top of (\S+)\/agents\.md/.exec(init.instructions ?? '')?.[1]
      ok(!!ref && existsSync(join(ref, 'agents.md')) && existsSync(join(ref, 'format.md')), `the instruction points at the plugin's reference docs (${ref})`)
      ok(/no editing context line/.test(init.instructions) && !/selection\.json/.test(init.instructions), 'it is the outside instruction, not the panel\'s')
      const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name)
      // the raw server source; the app adds its grouped tools (slide_html, …) when it writes it out
      ok(tools.includes('review_slide') && tools.includes('doc_info') && tools.includes('propose_variants'), `the app's tools pass through (${tools.length})`)
      const r = (await rpc('tools/call', { name: 'doc_info', arguments: {} })).result
      ok(r.isError && /Allow AI apps outside BeeSlides/.test(r.content[0].text), 'switched off: a call says how to turn it on')
    })
  }
} catch (err) {
  failed++
  console.log(`FAIL  ${err?.message ?? err}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall Claude plugin checks passed')
