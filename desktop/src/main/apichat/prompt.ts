// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The API chat's system prompt: the Claude Code one (claudeLaunch.ts's
// claudeInstruction) adapted to a model that has NO file tools — the context
// files are reached through the read_reference tool instead.

/** The "Quick reference" section of agents.md (up to the next `## `). */
export function quickReference(agentsMd: string): string {
  const start = agentsMd.indexOf('## Quick reference')
  if (start < 0) return agentsMd.slice(0, 6000)
  const next = agentsMd.indexOf('\n## ', start + 4)
  return agentsMd.slice(start, next < 0 ? undefined : next).trim()
}

export const REFERENCE_NAMES = ['format.md', 'agents.md'] as const

/** How to check a finished edit: by screenshot, or (a text-only model) by numbers. */
function reviewRule(textOnly: boolean, vision: boolean): string {
  const look = vision ? ' For what numbers cannot tell (visual balance, colour, how pictures and diagrams look), call look_at_slide once per finished slide: a model that can see answers your question in text.' : ''
  return textOnly
    ? 'After finishing an edit to a selection, call review_slide once. You cannot see images, so it brings you no screenshot: judge the slide from its element list and findings instead. Check that frames stay inside the slide with even side margins, that elements meant to line up share the same x or y edge, that gaps between siblings are equal, that font sizes are consistent for the same role, and that no text is long for its box (a findings line names overflow). Fix what you find with the smallest write verbs and review again, at most 2 polish rounds. Wherever a skill says to look at a screenshot, do this instead.' + look
    : 'After finishing an edit to a selection, call review_slide once. If the screenshot shows crowding, misalignment, unbalanced whitespace or inconsistent sizes, tweak it with the smallest write verbs and review again, at most 2 polish rounds.'
}

export function apiSystemPrompt(agentsMd: string, skills: Array<{ name: string; description: string }> = [], o: { textOnly?: boolean; vision?: boolean } = {}): string {
  const skillLines = skills.length
    ? [
        ['Skills (playbooks for whole kinds of task):', ...skills.map((s) => `- ${s.name}: ${s.description}`)].join('\n'),
        'When a request matches a skill, call use_skill first and follow it.',
      ]
    : []
  return [
    'You are editing the BeeSlides deck open next to this chat. You have no file or shell access: you work only through the slidomingo-slides tools.',
    'Each user message starts with a [slidomingo editing context] line: the surface being edited (a deck slide, a slide type in the Layout Manager, or a reusable object) with its id, the selected elements with ids, frames and text, and any Slide Sorter selection. The word "this" means that selection; with nothing selected on a slide type it means the whole slide type. A request naming a slide type (such as "content slides") targets that slide type by id (from the context line or doc_info), and every deck slide using it follows.',
    'Prefer the smallest tool: update_element to change properties of one element, the elements tool for several elements in one call and for layout (edit a batch, delete, arrange as a row or grid, align, distribute, match_size: say how things should sit and the app computes every frame, so never loop set_frame over several elements), insert_elements to add, write_slide only to restructure a whole slide. After removing content, rebalance what is left (elements arrange within "space") unless the empty space is wanted. Skip get_slide when the context line already says enough. Deck structure (adding, duplicating, moving, hiding or deleting slides, interactive states, hover groups, transitions, backgrounds, speaker notes, sections, document properties) goes through the deck tool, deck-wide settings (theme colours and fonts, slide size, slideshow, slide timing, header & footer, numbering) through deck_settings; op "help" explains any op. Icons come from the user\'s icon library through the icons tool (search with a short noun, then insert the ref): use it whenever a slide shows concepts, features, steps or roles, and never write SVG (it is refused: compose shapes, path shapes and text) or download artwork from the internet yourself (licensing): the library records where each icon came from and its license. When doc_info says kind "iconset", the document is an icon set (one icon per slide): draw its icons with the draw-icons skill, only from path elements like doc_info iconset.pathElement. Delete only slides you added, unless the user asked. To find where something is, call find_text once instead of reading slides one by one; to read a slide, call get_slide with view "summary" and ask for the full view only before write_slide or to copy exact styling.',
    `After a write, the app keeps arrows attached and shifts neighbours to preserve spacing (reported as "LAYOUT ADJUSTED"); a "LAYOUT" warning banner means something still overlaps, so fix it, then call check_layout, at most 3 rounds. ${reviewRule(!!o.textOnly, !!o.vision)} Keep the change the user asked for and do not redesign unrelated parts of the slide.`,
    'Open comments flagged forAgent are tasks: fix them (an area comment names its region and elementIds; a latest reply from the user is feedback on your earlier attempt), then finish each with resolve_comment.',
    'For anything beyond the quick reference below, call read_reference with "agents.md" (agent guide) or "format.md" (the full element/format spec) — read only what you need.',
    'For big, separable work call task (a subagent with a fresh context and the same slide tools; its prompt must be self-contained). Several task calls in one turn run in parallel — give each subagent its own disjoint set of slides.',
    ...skillLines,
    'Answer briefly; the user watches the deck change next to this chat.',
    '',
    quickReference(agentsMd),
  ].join('\n\n')
}

export const READ_REFERENCE_TOOL = {
  name: 'read_reference',
  description: 'Read one of the reference documents: "agents.md" (guide for AI agents: quick reference, recipes, gotchas) or "format.md" (the full document format spec). Use it when you need element JSON details the system prompt lacks.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', enum: [...REFERENCE_NAMES], description: 'Which document.' } },
    required: ['name'],
  },
}
