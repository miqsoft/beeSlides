// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The pure half of launching Claude Code in the panel: the system-prompt
// addendum and the one launch line (pty.ts spawns it). No electron / node-pty
// import, so scripts/test-ai-profiles.ts can run it.
import { isValidCommand } from './aiprofiles.ts'

/** Env var carrying the deck's folder to `--add-dir` (see claudeLaunchCommand). */
export const DECK_DIR_ENV = 'SLIDOMINGO_DECK_DIR'
/** Prefix of the env vars carrying the user's attached folders
 *  (`SLIDOMINGO_ADD_DIR_1`, `_2`, …), each to its own `--add-dir`. */
export const ADD_DIR_ENV_PREFIX = 'SLIDOMINGO_ADD_DIR_'

/** What a running Claude Code session sets for the processes it starts. The
 *  app inherits them when that session opened it (`open deck.beeslides.html`)
 *  and the panel's `claude` must not: with CLAUDE_CODE_CHILD_SESSION it runs
 *  as that session's child and writes no transcript, so no tab can be
 *  resumed. Anything the user's rc files set comes back in the `-lic` shell. */
export const INHERITED_SESSION_ENV = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
] as const

/** Removes another Claude Code session's variables (INHERITED_SESSION_ENV) from a pty env. */
export function dropInheritedSessionEnv(env: Record<string, string>): void {
  for (const k of INHERITED_SESSION_ENV) delete env[k]
}

/** Which `claude` conversation a pty runs: a new one under the given id, or
 *  an earlier one of this deck, continued (`--resume`). */
export interface ClaudeChat { id: string; resume: boolean }

/** The instruction appended to `claude`'s system prompt — checked by hand
 *  for zero shell-special characters (no `'`, `` ` ``, `$`, `\`, no
 *  possessives) since it is interpolated into a single-quoted pty command.
 *  Every word here stays in context for the whole session, so it only says
 *  what Claude cannot learn from the tool list: where the context comes
 *  from, how to read "this", and which verb to reach for first.
 *
 *  `sharedDir` is relative to `cwd` (never the absolute path, which is
 *  wherever the user saved their file and can contain shell-special
 *  characters): this WINDOW's context directory, identical for every
 *  parallel session against the document. Each session's own subfolder
 *  below it (mcp-config.json, settings.json, per-request files) never needs
 *  mentioning — the MCP server and the hook already point at it. */
export const claudeInstruction = (sharedDir: string): string =>
  `You are editing the BeeSlides deck open next to this terminal. ` +
  `Each user message carries a [slidomingo editing context] line: the surface ` +
  `being edited (a deck slide, a slide type in the Layout Manager, or a ` +
  `reusable object) with its id, the selected elements with ids, frames and ` +
  `text, and any Slide Sorter selection. The word this means that selection; ` +
  `with nothing selected on a slide type it means the whole slide type. A ` +
  `request naming a slide type, such as content slides, targets that slide ` +
  `type by id (from the context line or doc_info), and every deck slide using ` +
  `it follows. The full snapshot is ./${sharedDir}/selection.json if you ever ` +
  `need more. ` + toolGuidance(`./${sharedDir}`)

/** The instruction for an AI app outside BeeSlides (the Claude Code plugin,
 *  scripts/build-claude-plugin.mjs). Claude Code cuts server instructions at
 *  4096 characters and the launcher puts its mode line in front
 *  (mcp/plugin-launch.mjs MODE_LINES), so this stays short and says only
 *  what the tool descriptions do not: where to start, which tool for which
 *  job, the skills, where the rules are (DECISIONS 2026-10-25). `refDir` is
 *  where design.md and agents.md are; the plugin fills in its own folder.
 *  Kept to the same characters as claudeInstruction. */
export const outsideInstruction = (refDir: string): string =>
  `The beeslides tools edit BeeSlides decks; the BeeSlides app does layout, ` +
  `screenshots and saving. Start with open_deck on the deck file the user ` +
  `names (create:true makes a new one), then doc_info. Nothing is selected in ` +
  `this chat: find what the user means by this slide with outline and ` +
  `find_text, or ask. Write a new or restructured slide as HTML with ` +
  `slide_html; change a few things with update_element or elements; slides, ` +
  `notes and transitions with deck; theme and size with deck_settings; icons ` +
  `only from the icons tool. Look at what you made with review_slide. To ` +
  `build a deck use the build-deck skill, for a new look restyle-deck, to ` +
  `clean one up polish-deck, for options on one slide slide-designs; a small ` +
  `edit needs none of them. Before designing slides, read ${refDir}/design.md ` +
  `once. Element details: the quick reference at the top of ${refDir}/agents.md.`

/** The panel's guidance: which verb to reach for, the skills, the review
 *  loop, comments. */
const toolGuidance = (refDir: string): string =>
  `Edit through the beeslides MCP tools and prefer the ` +
  `smallest one: update_element to change properties of one element, ` +
  `elements({op}) for several elements in one call and for layout (edit a ` +
  `batch, delete, arrange as a row or grid, align, distribute, match_size: ` +
  `say how things should sit and the app computes every frame, so never loop ` +
  `set_frame over several elements), insert_elements to add, write_slide ` +
  `only to restructure a whole slide, and deck({op}) for deck structure (add, ` +
  `duplicate, move, hide or delete slides, states, hover groups, transitions, ` +
  `notes, sections) and deck_settings({op}) for theme, slide size, slideshow, ` +
  `timing, header & footer, numbering (op help explains them; delete only ` +
  `slides you added unless asked). Icons come from the icon library the user set up: ` +
  `icons({op:"search"}) then icons({op:"insert"}); never write SVG (it is refused: compose shapes, path shapes and text), ` +
  `and never download or embed artwork from the internet yourself (licensing): the library records where each icon came from and its license. ` +
  `When doc_info says kind "iconset", the document is an icon set (one icon per slide, the slide name is the icon): draw icons only from ` +
  `path elements like doc_info iconset.pathElement (d in grid units, inside the padding, in the set style), each with an iconPart (body, detail or accent); ` +
  `a look the user describes for the whole set is one icons({op:"style"}) call, never a redraw. ` +
  `To create or restructure a slide, write it as HTML with slide_html({op:"write"}): diagrams are one data-component ` +
  `(steps, sequence, cards, compare, flow) with the data as JSON, and doc_info slideTypes gives each slide type its placeholders ` +
  `and contentArea, so no probe slide is needed. To build or extend a deck from a topic, follow the build-deck skill ` +
  `(profile, outline, a family of slide types, one reference slide per type, then parallel subagents write the rest); ` +
  `to give a whole deck a new look, restyle-deck; to fix one up without changing its look, polish-deck. ` +
  `A small edit needs no skill and no questions: keep the slide on its slide type and inside the deck look. ` +
  `Before designing slides, read ${refDir}/design.md once. ` +
  `Skip get_slide when the context line already says enough; find content ` +
  `with find_text (not one get_slide per ` +
  `slide) and read a slide with get_slide view "summary" unless you are about ` +
  `to rewrite it. After a write, the app keeps arrows attached and ` +
  `shifts neighbours to preserve spacing (reported as ↻ LAYOUT ADJUSTED); a ` +
  `⚠ LAYOUT banner means something still overlaps, so fix it, then call ` +
  `check_layout, at most 3 rounds. After removing content, rebalance what is ` +
  `left (elements arrange within space) unless the empty space is wanted. ` +
  `After finishing an edit to a selection, ` +
  `call review_slide once. If the screenshot shows crowding, misalignment, ` +
  `unbalanced whitespace or inconsistent sizes, tweak it with the smallest ` +
  `write verbs and review again, at most 2 polish rounds. Keep the change the ` +
  `user asked for and do not redesign unrelated parts of the slide. Open ` +
  `comments flagged forAgent are tasks: fix them (an area comment names its ` +
  `region and elementIds; a latest reply from the user is feedback on your ` +
  `earlier attempt), then finish each with resolve_comment — it marks the ` +
  `comment done for the user to check. For ` +
  `element JSON read only the quick reference at the ` +
  `top of ${refDir}/agents.md; ${refDir}/format.md is the full spec.`

/** Builds the one command line that launches Claude Code with its
 *  context-aware system-prompt addendum and (optionally) an initial task.
 *  Like `claudeInstruction`, `initialTask` must be free of ' $ ` and \ —
 *  both are interpolated into a single-quoted shell command string. It is a
 *  fixed prompt, or the comments list agentprompts.ts `fixCommentsPrompt`
 *  sanitizes for exactly this (and main re-checks before launching). */
export function claudeLaunchCommand(
  sharedDirName: string, sessionDirName: string, chat: ClaudeChat, initialTask?: string, withDeckDir = false, command = 'claude', extraDirCount = 0,
): string {
  // `command` may be a shell function (the pty runs `$SHELL -lic`); only a
  // whitelisted name ever reaches the line.
  if (!isValidCommand(command)) throw new Error('invalid claude command')
  const task = initialTask ? ` '${initialTask}'` : ''
  // The panel picks the conversation id itself, so the deck's chat history
  // (chathistory.ts) knows which transcript is whose. A uuid by construction
  // (isChatId), so safe on this command line.
  const conversation = chat.resume ? ` --resume ${chat.id}` : ` --session-id ${chat.id}`
  // Relative, provably-safe dir names only — never an absolute path.
  // --strict-mcp-config stops an unrelated .mcp.json elsewhere in the user's
  // project from also being auto-discovered and triggering its own approval
  // prompt. Each session gets its OWN mcp-config.json (in its own subfolder)
  // pointing the shared server script at that session's own directory, so
  // sessions never share a request/response filename.
  const mcp = ` --mcp-config ./${sessionDirName}/mcp-config.json --strict-mcp-config`
  // --settings MERGES with the user's own settings; it only adds the
  // UserPromptSubmit hook that attaches the selection digest to each prompt.
  const settings = ` --settings ./${sessionDirName}/settings.json`
  // The deck's own folder, as an extra working directory only (not the
  // project: its CLAUDE.md/.claude are not loaded). The path travels in the
  // pty env and is expanded by the shell inside double quotes — never spliced
  // into this string.
  const deckDir = withDeckDir ? ` --add-dir "$${DECK_DIR_ENV}"` : ''
  // The folders the user attached to the deck: same rule, one env var each.
  // `extraDirCount` is a number (never text), the names are built here.
  const extra = Array.from({ length: Math.max(0, Math.min(32, Math.floor(extraDirCount))) }, (_, i) => ` --add-dir "$${ADD_DIR_ENV_PREFIX}${i + 1}"`).join('')
  return `${command} --append-system-prompt '${claudeInstruction(sharedDirName)}'${conversation}${mcp}${settings}${deckDir}${extra}${task}`
}

