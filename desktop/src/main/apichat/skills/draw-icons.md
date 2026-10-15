---
name: draw-icons
description: Draw or redraw icons of an icon set (doc kind "iconset") from native path shapes, all in the set's one style — many icons are split across parallel subagents.
---

The open document is an **icon set**: one icon per slide, the slide name is the icon's name, `slide.icon.prompt` says what it should show. Draw the icons the user asked for (or every empty slide); keep icons that are already drawn unless they are on the list.

1. Call `doc_info`. Its `iconset` entry has the `grid` (24 units), the `style` (stroke width in units, caps, joins, padding, outline/solid/duotone, ink), the set `brief`, the `paddingBox` and `pathElement`: a complete path element in the set style, drawn on the whole canvas with `pathBox` = the grid, so its `d` is written in **grid units**. Call `outline` for the names and prompts.
2. **Draw each icon only from elements like `pathElement`**: copy it, change `id` and `d`. Never use text, pictures or svg elements (svg is refused). Rules:
   - every point inside the `paddingBox`; the important shape fills it, centred;
   - whole or half units for points, radii and lengths where you can, so strokes sit on pixels at 24 px;
   - as few, simple shapes as say the idea: a recognisable silhouette first, one or two details, nothing that disappears at 24 px;
   - outline sets: `fill: "transparent"`; a small solid detail (a dot) is its own path with `fill` = the ink and `stroke: "transparent"`; solid sets fill the main shape; duotone: strokes plus a second path with the ink at `opacity` 0.3;
   - one icon per slide: write it with `write_slide` (or `insert_elements` on an empty slide); leave the slide's name and `icon` fields as they are.
3. Look at every icon with `review_slide` and correct it until it reads clearly and matches the others in weight, size and corner style (at most 3 rounds per icon).
4. **Split the work.** With 6 or fewer icons draw them yourself. With more, give batches of about 4 icons to subagents with `task`, issuing the calls together so they run in parallel (at most 4 at once). Each prompt must be self-contained: the slide ids and names, each icon's prompt, the set brief, the `pathElement` JSON and the rules above, and "change nothing outside these slides".
5. When all are back, compare them yourself with `review_slide` on a few: same stroke weight, same visual size, same corner and end style. Fix outliers.
6. Answer with a short list: each icon and what it shows. If the user left comments (`comments`), close each with `resolve_comment` and a one-line reply.
