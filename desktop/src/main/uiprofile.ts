// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The editor's per-install UI profile, main side (the renderer half is
// slides/src/editor/customize/). Main owns the file — renderer localStorage
// is per deck (one partition per path), the same reason viewerprefs.ts
// exists — and tells every editor window when it changes, whoever changed it:
// a window's Settings, the Customize chat (apichat/customizechat.ts) or an
// agent's ui_profile tool call (terminalPanel.ts).
//
// The preload reads the profile synchronously before the page's first script
// (no flash of the default chrome) and seeds localStorage with it.
// SLIDOMINGO_NO_UI_PROFILE=1 switches all of it off for one run.
import { app, BrowserWindow } from 'electron'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { handleFrom, onFrom } from './ipcguard.ts'
import { docWebContentsFor } from './windows.ts'
import { apiKeyFor, getProfiles } from './aiprofilesStore.ts'
import type { ApiProfile } from './aiprofiles.ts'
import { CUSTOMIZE_CHAT_ID, CustomizeChat } from './apichat/customizechat.ts'
import { transcriptPath } from './apichat/transcript.ts'
import { runUiProfileTool } from './uiprofiletool.ts'
import { CUSTOMIZE_UI_SKILL_MD } from './apichat/skills/index.ts'
import {
  currentProfile, resetProfile, revertProfile, uiHistory, writeProfile, type UiChange, type UiProfileService, type UiSource,
} from './uiprofilefs.ts'

let service: UiProfileService | null = null

function toEveryEditor(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    const wc = docWebContentsFor(win)
    if (!wc) continue
    try { wc.send(channel, payload) } catch { /* closing */ }
  }
}

/** The one service every writer in main goes through. */
export function uiProfileService(): UiProfileService {
  service ??= {
    path: process.env.SLIDOMINGO_UI_PROFILE_PATH || join(app.getPath('userData'), 'ui-customization.json'),
    disabled: process.env.SLIDOMINGO_NO_UI_PROFILE === '1',
    broadcast: (change: UiChange) => toEveryEditor('slidomingo:ui-profile-changed', change),
  }
  return service
}

/** An agent's `ui_profile` call through the slides MCP server: it arrives
 *  like any agent-action, but the profile is the app's, not the deck's — so
 *  main answers it here instead of forwarding it to the editor
 *  (agentbridge.ts forwardAgentRequest). */
export function uiProfileToolResult(args: unknown): Record<string, unknown> {
  return { ok: true, ...runUiProfileTool(uiProfileService(), args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}, 'agent') }
}

/** What a renderer may say it is: its own Settings or an Import. Chat and
 *  agent writes only ever start in main. */
const RENDERER_SOURCES: readonly UiSource[] = ['settings', 'import']

export function registerUiProfileIpc(): void {
  // Sync: the preload seeds localStorage before the page's first script.
  onFrom('app-shell', 'slidomingo:ui-profile-seed', (ev) => {
    const svc = uiProfileService()
    ev.returnValue = { disabled: svc.disabled, ...currentProfile(svc) }
  })
  handleFrom('app-shell', 'slidomingo:ui-profile-write', (_ev, profile: unknown, meta: unknown) => {
    const m = (meta && typeof meta === 'object' ? meta : {}) as { source?: unknown; summary?: unknown }
    const source = RENDERER_SOURCES.includes(m.source as UiSource) ? m.source as UiSource : 'settings'
    return writeProfile(uiProfileService(), profile, source, typeof m.summary === 'string' ? m.summary : '')
  })
  handleFrom('app-shell', 'slidomingo:ui-profile-history', () => uiHistory(uiProfileService()))
  handleFrom('app-shell', 'slidomingo:ui-profile-revert', (_ev, rev: unknown) =>
    revertProfile(uiProfileService(), typeof rev === 'number' ? rev : -1))
  handleFrom('app-shell', 'slidomingo:ui-profile-reset', () => resetProfile(uiProfileService()))
}

// ---- Settings ▸ Customize's chat (apichat/customizechat.ts) -------------------

let chat: CustomizeChat | null = null
const chatDir = (): string => join(app.getPath('userData'), 'customize-chats')

/** The API profile the chat runs on: the default when it is one, else the
 *  first. A Claude Code default means the terminal's /customize-ui instead. */
function chatProfile(): { profile: ApiProfile | null; kind: 'api' | 'claude-code' | 'none' } {
  const { profiles, defaultId } = getProfiles()
  const def = profiles.find((p) => p.id === defaultId)
  const api = def?.kind === 'api' ? def : profiles.find((p): p is ApiProfile => p.kind === 'api')
  if (api) return { profile: api as ApiProfile, kind: 'api' }
  return { profile: null, kind: def?.kind === 'claude-code' ? 'claude-code' : 'none' }
}

async function ensureChat(): Promise<CustomizeChat | null> {
  const { profile } = chatProfile()
  if (!profile || uiProfileService().disabled) return null
  if (chat && chat.profileId === profile.id) return chat
  chat?.dispose()
  const next = new CustomizeChat({
    svc: uiProfileService(), profile, apiKey: await apiKeyFor(profile),
    transcriptDir: chatDir(), skillMd: CUSTOMIZE_UI_SKILL_MD, resume: true,
  })
  next.onEvent((ev) => toEveryEditor('slidomingo:customize-chat-event', ev))
  chat = next
  return next
}

export function registerCustomizeChatIpc(): void {
  handleFrom('app-shell', 'slidomingo:customize-chat-info', async () => {
    const { profile, kind } = chatProfile()
    const c = await ensureChat()
    return {
      available: !!c, kind, profileName: profile?.name ?? null, disabled: uiProfileService().disabled,
      items: c?.display() ?? [], turns: c?.turns ?? [], busy: c?.busy ?? false,
    }
  })
  handleFrom('app-shell', 'slidomingo:customize-chat-send', async (_ev, text: unknown, digest: unknown) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) return { ok: false, error: 'empty' }
    const c = await ensureChat()
    if (!c) return { ok: false, error: 'unavailable' }
    if (c.busy) return { ok: false, error: 'busy' }
    void c.send(text, typeof digest === 'string' ? digest : null)
    return { ok: true }
  })
  handleFrom('app-shell', 'slidomingo:customize-chat-stop', () => { chat?.stop(); return { ok: true } })
  handleFrom('app-shell', 'slidomingo:customize-chat-clear', () => {
    chat?.dispose()
    chat = null
    try { rmSync(transcriptPath(chatDir(), CUSTOMIZE_CHAT_ID), { force: true }) } catch { /* best effort */ }
    return { ok: true }
  })
}
