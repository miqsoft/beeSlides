// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The pure half of asking the user before an AI app outside BeeSlides works
// on the open decks (agentendpoint.ts shows the box). No electron import, so
// scripts/test-agent-consent.ts can run it.

/** At most this many allowed apps are remembered; the oldest drops out. */
export const MAX_ALLOWED_CLIENTS = 20

/** The renderer's translations for the box (main has no catalog); English
 *  when missing. `{client}` in `message` is the app's name. */
export type ConsentStrings = Partial<Record<'message' | 'detail' | 'allow' | 'deny', string>>

const KEYS = ['message', 'detail', 'allow', 'deny'] as const

export function consentStrings(raw: unknown): ConsentStrings {
  const out: ConsentStrings = {}
  if (!raw || typeof raw !== 'object') return out
  for (const k of KEYS) {
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v === 'string' && v.length > 0 && v.length <= 400) out[k] = v
  }
  return out
}

/** Names MCP clients report for themselves (initialize clientInfo.name),
 *  as people know the apps. Anything else is shown as it came. */
const KNOWN: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude Desktop',
  cursor: 'Cursor',
  'cursor-vscode': 'Cursor',
  'visual-studio-code': 'VS Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
}

/** The app's name as the box shows and the settings remember it: what the
 *  client sent, without control characters, at most 60 characters. The name
 *  is the client's own claim — the token is the real gate; this question
 *  only makes sure the user knows something connected. */
export function clientLabel(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim() : ''
  if (!s || s === 'mcp') return 'An AI app'
  return KNOWN[s.toLowerCase()] ?? s.slice(0, 60)
}

export function consentBox(strings: ConsentStrings, client: string): { message: string; detail: string; buttons: [string, string] } {
  return {
    message: (strings.message ?? '“{client}” wants to work on your open decks').replaceAll('{client}', client),
    detail: strings.detail ?? 'It can read and change the decks open in BeeSlides, the same way the Claude panel can. Allow it only if you started it yourself. You can take this back in Settings ▸ AI chat ▸ Advanced.',
    buttons: [strings.allow ?? 'Allow', strings.deny ?? 'Don’t Allow'],
  }
}

/** The remembered list after allowing `client`: no duplicates, newest last. */
export function rememberClient(list: unknown, client: string): string[] {
  const prev = Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string' && c !== client) : []
  return [...prev, client].slice(-MAX_ALLOWED_CLIENTS)
}

export function isAllowedClient(list: unknown, client: string): boolean {
  return Array.isArray(list) && list.includes(client)
}
