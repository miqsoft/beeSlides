// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The four request kinds an agent's tool call travels as — named by the file
// prefix slides-mcp-server.mjs's roundTrip writes, which is also what an
// endpoint client (agentendpoint.ts) and a program (programrun.ts) send.
// Import-free, so node rigs can load it.

export type AgentChannel = 'slide-request' | 'slide-write' | 'agent-query' | 'agent-action'

export const AGENT_CHANNELS: readonly AgentChannel[] = ['slide-request', 'slide-write', 'agent-query', 'agent-action']

export type AgentResult = { requestId: string; ok: boolean; [key: string]: unknown }

export function isAgentChannel(c: unknown): c is AgentChannel {
  return typeof c === 'string' && (AGENT_CHANNELS as readonly string[]).includes(c)
}
