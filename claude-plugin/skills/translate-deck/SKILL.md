---
name: translate-deck
description: Translate all text of the deck into another language in place, keeping layout, formatting and ids.
---

_In this plugin: `task` is the Agent tool (subagents), and `read_reference("agents.md")` means reading `reference/agents.md` of the BeeSlides plugin, two folders up from this skill's base directory (`../../reference/agents.md`)._

Translate the deck's text into the language the user named (ask only if none was given). Change words, not design.

1. Call `doc_info` (title, meta) and `outline`. Decide a short glossary first: product names, brand terms, abbreviations and code stay as they are; note it in one line in chat.
2. For every slide: `get_slide`, then change each text with `update_element` `{props: {html: "<translated html>"}}`. Keep the inline markup (bold, italics, colours, line breaks, dynamic tokens such as `{{page}}` or `{{title}}`) exactly as in the source; translate only the words. Table cells are part of the `rows` of a table element: send the whole `rows` array back with translated cell `html` (nested objects are replaced whole, so copy the structure). Chart labels live in the chart `option` (category names, series names, axis names): translate those strings and send the whole `option` back. `notes` (speaker notes) can only be changed with `write_slide`: use it once for a slide when its notes need translating and send back the slide you got from `get_slide` with only the texts changed.
3. Also translate: the deck's `meta` is not editable with these tools — leave it and say so in the report. Slide names (`name`) change only through `write_slide`; skip them unless the user wants them.
4. Text length changes with the language. After each slide call `check_layout`; for a slide with a `LAYOUT` banner or overflow, fix it by shortening the wording first, then `set_frame` or a smaller `fontSize` (use `measure` to check). Do not restructure slides.
5. With more than about 6 slides, give disjoint batches of slides to subagents with `task` (issue the calls together so they run in parallel). Each prompt must carry the target language, the glossary, the rules in step 2 and 4 and the slide ids it owns. Review a few slides yourself with `review_slide` afterwards, one at a time.
6. Finish with `validate` and a short report: how many slides, what was left untranslated and why.
