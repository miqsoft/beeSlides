// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// A minimal MCP client over stdio for the slides MCP server
// (desktop/src/mcp/slides-mcp-server.mjs). The server is the SAME one Claude
// Code talks to, pointed at the chat's own session folder, so every tool and
// the whole file-based write-back path (terminalPanel.ts's watchers → the
// editor) is reused unchanged. Framing is newline-delimited JSON-RPC.
import { spawn, type ChildProcess } from 'node:child_process'
import type { ToolDef, ToolImage } from './types.ts'

export interface McpToolResult { text: string; images: ToolImage[]; isError: boolean }

export class McpClient {
  private child: ChildProcess | null = null
  private nextId = 1
  private buffer = ''
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private serverPath: string
  private sessionDir: string

  constructor(serverPath: string, sessionDir: string) {
    this.serverPath = serverPath
    this.sessionDir = sessionDir
  }

  async start(): Promise<ToolDef[]> {
    // Electron's own binary runs the script as plain node — no `node` on PATH
    // needed (a GUI-launched app has a minimal PATH).
    const child = spawn(process.execPath, [this.serverPath, this.sessionDir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    this.child = child
    // A decoding stream, not chunk.toString(): a multi-byte character split
    // across two pipe chunks would otherwise become two U+FFFD, silently, in
    // a tool result the model may write back into the deck.
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.onData(chunk))
    child.on('exit', () => this.failAll(new Error('slides MCP server exited')))
    child.on('error', (e) => this.failAll(e))
    child.stdin!.on('error', () => { /* server gone: surfaced by failAll */ })
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'slidomingo-chat', version: '1.0.0' } })
    this.notify('notifications/initialized')
    const list = (await this.request('tools/list', {})) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }
    return (list.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object', properties: {} } }))
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    const raw = (await this.request('tools/call', { name, arguments: args }, signal)) as { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }
    let text = ''
    const images: ToolImage[] = []
    for (const c of raw.content ?? []) {
      if (c.type === 'text' && c.text) text += (text ? '\n' : '') + c.text
      else if (c.type === 'image' && c.data) images.push({ data: c.data, mimeType: c.mimeType ?? 'image/png' })
    }
    return { text, images, isError: !!raw.isError }
  }

  dispose(): void {
    this.failAll(new Error('closed'))
    try { this.child?.stdin?.end() } catch { /* already closed */ }
    try { this.child?.kill() } catch { /* already gone */ }
    this.child = null
  }

  private notify(method: string): void {
    this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(new Error('slides MCP server is not running')); return }
      if (signal?.aborted) { reject(new Error('aborted')); return }
      const id = this.nextId++
      const onAbort = (): void => { this.pending.delete(id); reject(new Error('aborted')) }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v) },
        reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e) },
      })
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  private onData(text: string): void {
    this.buffer += text
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(line) } catch { continue }
      if (typeof msg.id !== 'number') continue
      const p = this.pending.get(msg.id)
      if (!p) continue
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'))
      else p.resolve(msg.result)
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}
