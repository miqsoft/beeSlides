#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// API-chat MCP client: tool results survive pipe chunking byte-exactly.
//
//   node scripts/test-desktop-mcp-utf8.ts
//
// WHAT THIS PROVES (desktop/src/main/apichat/mcp.ts): a tool result far larger
// than one pipe chunk (64 KiB on macOS/Linux), full of 2-, 3- and 4-byte UTF-8
// characters, comes back from McpClient.callTool exactly as the server sent
// it. Decoding each 'data' chunk on its own turned every character that
// straddled a chunk boundary into U+FFFD — JSON.parse still succeeded, so the
// corrupted text reached the model, which wrote it back into the deck.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpClient } from '../desktop/src/main/apichat/mcp.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) failures++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`)
}

// A stand-in for slides-mcp-server.mjs: newline-delimited JSON-RPC on stdio.
// Its get_slide answers with ~1 MB of text whose characters are 1–4 bytes, so
// many land across chunk boundaries whatever the pipe's chunk size is.
const SERVER = String.raw`
const UNIT = 'Größe 日本語 ↻ 😀 a'
const BIG = UNIT.repeat(40000)
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (typeof msg.id !== 'number') continue
    let result = {}
    if (msg.method === 'tools/list') result = { tools: [{ name: 'get_slide', description: 'd', inputSchema: { type: 'object', properties: {} } }] }
    if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: BIG }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  }
})
`
const UNIT = 'Größe 日本語 ↻ 😀 a'
const EXPECTED = UNIT.repeat(40000)

const dir = mkdtempSync(join(tmpdir(), 'slidomingo-mcp-utf8-'))
const serverPath = join(dir, 'server.mjs')
writeFileSync(serverPath, SERVER)

const client = new McpClient(serverPath, dir)
try {
  const tools = await client.start()
  ok(tools.length === 1 && tools[0].name === 'get_slide', 'the client lists the stub server\'s tool')
  for (let i = 0; i < 3; i++) {
    const r = await client.callTool('get_slide', {})
    const bad = (r.text.match(/�/g) ?? []).length
    ok(bad === 0, `call ${i + 1}: no U+FFFD in a ${Buffer.byteLength(r.text)}-byte result (found ${bad})`)
    ok(r.text === EXPECTED, `call ${i + 1}: the text is byte-identical to what the server sent`)
  }
} catch (e) {
  ok(false, `client error: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  client.dispose()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
