---
name: polish-deck
description: Design-review every slide of the deck and fix layout, hierarchy, consistency and missing motion — big decks are split across parallel subagents.
---

Run a polish pass over the whole deck. Keep the content and message of every slide; fix presentation only.

1. Call `doc_info` and `outline`. List the deck slides (skip hidden ones only if the user said so). If the user's request names slides or a range, restrict the pass to those.
2. **Split the work.** With 4 or fewer slides do them yourself, one after another. With more, split the slides into batches of about 3 and give each batch to a subagent with `task`, issuing the `task` calls together in one turn so they run in parallel (at most 4 run at once; start the rest once those return). Every batch is a disjoint set of slide ids. Each prompt must be self-contained, for example:

   > You are polishing slides <ids> of the open slide deck (deck title: <title>, slide size <w>x<h>, slide types <…>). For each slide, in order: call `review_slide` once; look at the screenshot and the element list; fix crowding, misalignment, unbalanced whitespace, inconsistent sizes/colours, text that wraps badly or overflows, with the smallest tool (`update_element`, `set_frame`, `insert_elements`; `write_slide` only to restructure). After a write, handle any `LAYOUT` banner and call `check_layout` until clean (at most 3 rounds). Review again after your fixes (at most 2 polish rounds per slide). Do not change the wording or the message, do not touch other slides, do not call `review_slide` on any slide not listed. Keep side margins at 96px and the deck's palette and typefaces. Icons come only from the `icons` tool (the user's icon library); never draw icon SVG. Finish with a short report: per slide, what you changed and anything still open.

   Screenshots go through the one shared editor canvas, so they are taken one at a time automatically; that is expected.
3. When the subagents are back (or after your own slides), check **consistency across the deck** yourself with `outline` and a few `get_slide` calls: same title position and size on similar slides, same accent colour, footers and page numbers alike. Fix differences with `update_element` / `set_frame`.
4. Check the self-audit list from the guide (`read_reference("agents.md")`, "Before you finish"): numbers that should be a chart, consecutive slides that should share ids and `morph`, a motion moment on the cover, speaker notes, lists of concepts or steps that would read faster with an icon per item (`icons`). Offer these as suggestions instead of redesigning unless the user asked for them.
5. Run `validate` once. Then answer in a few lines: slides changed, remaining issues, suggestions.
