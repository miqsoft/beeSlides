// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The built-in skills, bundled as text (vite `?raw`, like format.md in
// terminalPanel.ts). Kept apart from skills.ts so that stays plain Node.
import { parseSkill, type Skill } from '../skills.ts'
import buildDeck from './build-deck.md?raw'
import customizeUi from './customize-ui.md?raw'
import drawIcons from './draw-icons.md?raw'
import polishDeck from './polish-deck.md?raw'
import restyleDeck from './restyle-deck.md?raw'
import slideDesigns from './slide-designs.md?raw'
import translateDeck from './translate-deck.md?raw'

export const BUILTIN_SKILLS: Skill[] = [
  parseSkill(buildDeck, 'build-deck'),
  parseSkill(polishDeck, 'polish-deck'),
  parseSkill(restyleDeck, 'restyle-deck'),
  parseSkill(slideDesigns, 'slide-designs'),
  parseSkill(translateDeck, 'translate-deck'),
  parseSkill(customizeUi, 'customize-ui'),
  parseSkill(drawIcons, 'draw-icons'),
].filter((s): s is Skill => s !== null)

/** The customize-ui skill's SKILL.md text — also written into every Claude
 *  Code workspace (workspaces.ts) so `/customize-ui` works in the terminal. */
export const CUSTOMIZE_UI_SKILL_MD: string = customizeUi

/** Two names in the skills belong to the built-in chat; in Claude Code they
 *  are something else. Said once, right under the frontmatter. */
const CLAUDE_CODE_NOTE = '_In Claude Code: `task` is the Agent tool (subagents), and `read_reference("agents.md")` means reading agents.md in the context directory named in your instructions._\n\n'
const forClaudeCode = (md: string): string => md.replace(/^(---\n[\s\S]*?\n---\n\n?)/, (head) => head + CLAUDE_CODE_NOTE)

/** Every built-in skill as Claude Code project skills (name → SKILL.md),
 *  written into each workspace (workspaces.ts): without them a Claude Code
 *  chat had only customize-ui, and built decks without build-deck. */
export const CLAUDE_CODE_SKILLS: Record<string, string> = {
  'build-deck': forClaudeCode(buildDeck),
  'polish-deck': forClaudeCode(polishDeck),
  'restyle-deck': forClaudeCode(restyleDeck),
  'slide-designs': forClaudeCode(slideDesigns),
  'translate-deck': forClaudeCode(translateDeck),
  'draw-icons': forClaudeCode(drawIcons),
  'customize-ui': customizeUi,
}
