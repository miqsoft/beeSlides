---
name: draw-icons
description: Draw or redraw icons of an icon set (doc kind "iconset") from native path shapes, all in the set's one style — many icons are split across parallel subagents. Also adds a style to the set (icons op style) when the user describes a look.
---

_In this plugin: `task` is the Agent tool (subagents), and `read_reference("agents.md")` means reading `reference/agents.md` of the BeeSlides plugin, two folders up from this skill's base directory (`../../reference/agents.md`)._

**Planning first.** When the user asks for icons in their own words ("think about 12 icons for …") and the set has no plan for them yet, plan before drawing: decide the list (names, one line each of what it shows, 2-5 keywords, consistent metaphors) and write it with ONE `icons` call, op `plan`. Then stop and let the user review; draw only when they say so or press Draw with AI.

The open document is an **icon set**: one icon per slide, the slide name is the icon's name, `slide.icon.prompt` says what it should show. Draw the icons the user asked for (or every empty slide); keep icons that are already drawn unless they are on the list.

1. Call `doc_info`. Its `iconset` entry has the canvas size, `grid` units wide and `gridH` units high (24 × 24 unless the set picked another aspect ratio — then use the width, do not squeeze the icon into a square), the `style` (stroke width in units, caps, joins, padding, outline/solid, ink), the set `brief`, the `paddingBox` and `pathElement`: a complete path element in the set style, drawn on the whole canvas with `pathBox` = the grid, so its `d` is written in **grid units**. It may have `examples`: icons the user likes, as SVG text from other libraries — draw like them (line weight, corner rounding, amount of detail, proportions), but draw your own paths, never copy theirs. Call `outline` for the names and prompts.
2. **Draw each icon only from elements like `pathElement`**: copy it, change `id` and `d`. Never use text, pictures or svg elements (svg is refused). Rules:
   - every point inside the `paddingBox`; the important shape fills it, centred;
   - whole or half units for points, radii and lengths where you can, so strokes sit on pixels at 24 px;
   - as few, simple shapes as say the idea: a recognisable silhouette first, one or two details, nothing that disappears at 24 px;
   - give every path an `iconPart`: `body` for the main closed silhouette(s), `detail` for inner lines and dots, `accent` for at most one small closed highlight — the set's other styles (solid, colour, comic …) paint each part their own way;
   - outline sets: `fill: "transparent"`; a small solid detail (a dot) is its own path with `fill` = the ink and `stroke: "transparent"`; solid sets fill the main shape; duotone: strokes plus a second path with the ink at `opacity` 0.3;
   - one icon per slide: write it with `write_slide` (or `insert_elements` on an empty slide); leave the slide's name and `icon` fields as they are.
3. Look at every icon with `review_slide` and correct it until it reads clearly and matches the others in weight, size and corner style (at most 3 rounds per icon).
4. **Split the work.** With 3 or fewer icons draw them yourself. With more, give batches of 3 or 4 icons to subagents with `task`, issuing the calls together in one turn so they run in parallel (at most 4 at once; start the rest when those return). Each prompt must be self-contained: the slide ids and names, each icon's prompt, the set brief, the `pathElement` JSON, the `examples` (if any) and the rules above, and "change nothing outside these slides".
5. When all are back, compare them yourself with `review_slide` on a few: same stroke weight, same visual size, same corner and end style. Fix outliers.
6. Answer with a short list: each icon and what it shows. If the user left comments (`comments`), close each with `resolve_comment` and a one-line reply.

**Drawing style or style?** The set's drawing style (brief, examples, stroke, caps, joins) is how icons are DRAWN; a style (`variants`) only REPAINTS the drawings. When the user describes a look for the set ("comic, yellow with a hard shadow"), do not redraw: write it with ONE `icons` op `style` call (name, weight, colour, part fills, and only the extras asked for). The set's drawings are painted in every style automatically. A look that needs other shapes (hand-drawn, more detail, other proportions) is not a style: say so and suggest changing the drawing style (brief and examples in the panel's Drawing section) and redrawing. A comment "in the style X" is about one icon as painted in that style: change just that icon there with `icons` op `tweak` (its shapes' own fill, line colour, or hidden in that style), a change for every icon with op `style`, and redraw only when the drawing itself is wrong.
