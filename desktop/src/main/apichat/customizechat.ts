// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// Settings ▸ Customize's chat: an API chat whose only tool is `ui_profile`
// (no MCP child, no deck, no files) and whose system prompt is the
// customize-ui skill. The user says "add a Brand tab with my callout style"
// and the model patches the profile; every write is a revision, and each
// turn reports what it changed with the revision to go back to ("Undo this
// turn" = revert to the revision before the turn).
//
// Electron-free, so scripts/test-ai-profiles.ts runs it against a mock
// provider; the IPC around it is registerCustomizeChatIpc in ../uiprofile.ts.
import type { ApiProfile } from '../aiprofiles.ts'
import { currentProfile, listUiHistory, type UiProfileService } from '../uiprofilefs.ts'
import { runUiProfileTool, UI_PROFILE_TOOL, UI_PROFILE_TOOL_NAME } from '../uiprofiletool.ts'
import { parseSkill } from './skills.ts'
import { ApiChatSession, type DisplayItem } from './session.ts'
import type { ChatEvent, Provider } from './types.ts'

/** One stable transcript per install: the customize chat is about the app,
 *  not about any deck. */
export const CUSTOMIZE_CHAT_ID = 'customize-ui'

export function customizeSystemPrompt(skillMd: string): string {
  const skill = parseSkill(skillMd, 'customize-ui')
  return [
    'You customize the BeeSlides editor for this user — their per-install UI profile — through the ui_profile tool only. You cannot see or change their deck, and you have no file or shell access.',
    'A user message may start with an [editor selection] line: what is selected on the slide right now, with its look (font, colours, fill…). When the user says "this look" or "my selection", start from those values.',
    skill?.body ?? '',
    'Answer briefly, in the language the user writes in.',
  ].join('\n\n')
}

/** What a turn changed: revisions written during it, and where Undo goes. */
export interface CustomizeTurn { revBefore: number; changes: Array<{ rev: number; summary: string }> }

export type CustomizeEvent = ChatEvent | ({ type: 'turn' } & CustomizeTurn)

export interface CustomizeChatOptions {
  svc: UiProfileService
  profile: ApiProfile
  apiKey?: string
  transcriptDir: string
  skillMd: string
  /** Test seam; defaults to the profile's wire. */
  provider?: Provider
  resume?: boolean
}

export class CustomizeChat {
  readonly session: ApiChatSession
  readonly profileId: string
  /** Turns of this run (not stored: revisions age out anyway). */
  readonly turns: Array<CustomizeTurn & { afterItem: number }> = []
  private digestLine: string | null = null
  private svc: UiProfileService
  private listeners = new Set<(ev: CustomizeEvent) => void>()

  constructor(o: CustomizeChatOptions) {
    this.svc = o.svc
    this.profileId = o.profile.id
    this.session = new ApiChatSession({
      chatId: CUSTOMIZE_CHAT_ID, profile: o.profile, apiKey: o.apiKey,
      // no deck, no MCP server: these folders are never read for a customize chat
      sessionDir: o.transcriptDir, sharedDir: o.transcriptDir, transcriptDir: o.transcriptDir,
      provider: o.provider,
      purpose: 'customize',
      system: customizeSystemPrompt(o.skillMd),
      digest: () => this.digestLine,
      tools: {
        defs: [UI_PROFILE_TOOL],
        call: async (name, args) => {
          if (name !== UI_PROFILE_TOOL_NAME) return { text: `Unknown tool: ${name}`, images: [], isError: true }
          return { ...runUiProfileTool(this.svc, args ?? {}, 'chat'), images: [] }
        },
      },
    }, !!o.resume)
    this.session.onEvent((ev) => this.emit(ev))
  }

  onEvent(cb: (ev: CustomizeEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(ev: CustomizeEvent): void { for (const cb of this.listeners) cb(ev) }

  get busy(): boolean { return this.session.busy }

  /** The transcript as the pane shows it: what was said, no tool rows. */
  display(): DisplayItem[] {
    return this.session.display.filter((d) => d.kind === 'user' || d.kind === 'assistant')
  }

  /** One request. `digest` is the renderer's line about the selection. */
  async send(text: string, digest: string | null): Promise<CustomizeTurn | null> {
    if (this.session.busy || !text.trim()) return null
    this.digestLine = digest && digest.length <= 4000 ? digest : null
    const revBefore = currentProfile(this.svc).rev
    await this.session.send(text)
    const changes = listUiHistory(this.svc.path)
      .filter((h) => h.rev > revBefore && h.source === 'chat')
      .map((h) => ({ rev: h.rev, summary: h.summary }))
      .reverse()
    const turn = { revBefore, changes }
    this.turns.push({ ...turn, afterItem: this.display().length })
    this.emit({ type: 'turn', ...turn })
    return turn
  }

  stop(): void { this.session.stop() }
  dispose(): void { this.session.dispose() }
}
