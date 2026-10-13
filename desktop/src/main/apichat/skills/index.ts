// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The built-in skills, bundled as text (vite `?raw`, like format.md in
// terminalPanel.ts). Kept apart from skills.ts so that stays plain Node.
import { parseSkill, type Skill } from '../skills.ts'
import buildDeck from './build-deck.md?raw'
import customizeUi from './customize-ui.md?raw'
import polishDeck from './polish-deck.md?raw'
import translateDeck from './translate-deck.md?raw'

export const BUILTIN_SKILLS: Skill[] = [
  parseSkill(buildDeck, 'build-deck'),
  parseSkill(polishDeck, 'polish-deck'),
  parseSkill(translateDeck, 'translate-deck'),
  parseSkill(customizeUi, 'customize-ui'),
].filter((s): s is Skill => s !== null)

/** The customize-ui skill's SKILL.md text — also written into every Claude
 *  Code workspace (workspaces.ts) so `/customize-ui` works in the terminal. */
export const CUSTOMIZE_UI_SKILL_MD: string = customizeUi
