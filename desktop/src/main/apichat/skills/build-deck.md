---
name: build-deck
description: Plan and build a deck from a topic or source material — outline first, then a slide type per slide, then the slides.
---

Build the deck the user asked for. Work in this order and keep the user informed in one short line per phase.

1. **Look at what exists.** Call `doc_info` (title, size, theme, slideTypes) and `outline` (one row per slide). Read the "Make a GREAT deck" section of the guide once: `read_reference("agents.md")` — skip it if you already know it.
2. **Outline before slides.** Write a numbered outline in chat: one line per slide with its message and the content kind (numbers → chart, comparison grid → table, same subject changing → morph pair, drill-down → state slide, hero image → ken-burns, headline number → count-up, concepts/features/steps side by side → an icon per item). Keep it to what the material supports; no filler slides. If the request is ambiguous about audience or length, state the assumption you made instead of asking.
3. **Set the look once, deck-wide** if the user asked for one: `deck_settings` `{op:"theme"}` (colours, fonts) and `{op:"size"}`, before building slides.
   **Pick a slide type per slide.** Use the deck's own slide types from `doc_info` (`slideTypes`) and `list_reusable_objects`; do not invent a look. A slide whose purpose has no fitting type may use a new one: `create_slide_type` (mode `parent` or `basis` from an existing type), then `slide_type` `relink` to make a deck slide follow it. Slides that follow a slide type get its placeholders by `role`.
4. **Create, then fill the slides.** Add every slide the outline needs in ONE call before filling any: `deck` `{op:"add", after, slideType, count, names}` returns the new ids in order (reuse empty placeholder slides that `outline` already lists first). Delete leftover empty slides you added with `deck` `{op:"delete"}`; never delete the user's slides unless they asked.
   - Size multi-line text with `measure` before placing it; keep side margins at 96px (right-most x ≤ 1184); one accent colour, at most two typefaces.
   - Prefer `update_element` / `insert_elements` / `set_frame` for slides that already have the right structure; use `write_slide` when you restructure a slide. A new element needs a unique `id`; reuse the same `id` on consecutive slides plus `transition:"morph"` to morph.
   - Icons: `icons` `{op:"search", query}` with one short noun per concept, then `{op:"insert", slideId, ref, x, y, size}`; one size for every icon on a slide. Never draw icon SVG yourself; if the library is not set up, say so in the report and use simple shapes.
   - Put speaker notes on each slide with `deck` `{op:"notes", slideId, text}`; set transitions and sections with `deck` too (`op:"help"` lists the ops).
5. **Audit.** For every slide call `review_slide` once, fix what the screenshot or the layout findings show with the smallest verb (at most 2 polish rounds per slide), then `validate` once for the whole deck. Walk the self-audit checklist at the end of the "Make a GREAT deck" section.
6. **Report** in two or three lines: what was built, what was left for the user (missing images, anything `deck` help lists as not available yet), nothing else.

When the deck has more than about 6 slides to fill, create all slides first, then hand disjoint batches of them to subagents with `task` (one slide each when the user asks for that; otherwise 2-3, which keeps the style more consistent). Each prompt is self-contained: the outline rows, the slide ids it owns, the style decisions, the rules above. Subagents fill slides; only you add, move or delete them. Do the audit yourself afterwards.
