# BeeSlides — generation brief

Condensed brief for designing ONE fresh deck as
`beeslides/slides` JSON. This is not the full reference — see `format.md`
(complete field spec) and `agents.md` (full authoring guide) in this same
directory if you need more than what's here.

## What the request asks for

`generate-request.json` says what to build. Users call a template file a
**layout** and a `doc.layouts` entry a **slide type**; the JSON keeps the
format's own words (`template`, `layouts`).

- **`"kind": "describe"`** — `description` is the user's own words. Design a
  fresh deck to match it.
- **`"kind": "pptx"`** — rebuild an existing PowerPoint natively. Beside the
  request: `source.pptx` (the file itself — a zip; read
  `ppt/presentation.xml`, `ppt/slides/slideN.xml`, `ppt/slideLayouts/`,
  `ppt/slideMasters/`, `ppt/theme/` and the pictures under `ppt/media/`,
  e.g. `unzip -o source.pptx -d source`) and, when present,
  `pptx-converted.json` — `{ "doc": …, "report": … }`: `doc` is our own
  converter's draft of the same file, already valid `beeslides/slides` JSON
  with its pictures embedded, and `report` lists what it approximated or
  dropped (`entries[]`, each with a `code`, a `verdict` and where). Start from the draft — it
  has the geometry and the assets right — and fix what the report and the
  XML say it got wrong. `name` is the file's name, for the title only.
  - **`"target": "deck"`** — a faithful, native, fully editable deck: every
    source slide, in order, with its text, pictures and notes. Real slide
    types in `doc.layouts` (the source's masters/layouts, children via
    `parentId`) with each slide linked by `layoutId`; text in real text
    elements with `role`s, never pictures of text; charts as `chart`
    elements and tables as `table` elements wherever the source had them
    (read the chart XML for the numbers). Keep the source's theme colours
    and fonts.
  - **`"target": "layout"`** — only the design: the theme (colours, fonts),
    the slide types in `doc.layouts` (every layout the source defines,
    placeholders as `role`d text and `role:"media"` slots, shared chrome on
    a parent type), `defaultLayoutId`, and exactly ONE slide — a starter of
    the default slide type, linked to it. No content slides. The app saves
    the result as a layout file itself; don't set `template`.

## Minimal valid document

```json
{
  "format": "beeslides/slides", "version": 1, "title": "My deck",
  "size": { "width": 1280, "height": 720 },
  "theme": { "background": "#101418", "color": "#F2F0EA",
             "accent": "#FF9E8A", "fontFamily": "system-ui, sans-serif" },
  "slides": [
    { "id": "s1", "background": "#101418", "transition": "none",
      "notes": "speaker notes here",
      "elements": [
        { "id": "t1", "type": "text", "x": 96, "y": 260, "w": 1088, "h": 160,
          "rotation": 0, "opacity": 1,
          "html": "Hello from an agent.",
          "fontSize": 88, "fontFamily": "system-ui, sans-serif",
          "fontWeight": 800, "color": "#F2F0EA",
          "align": "left", "valign": "top", "lineHeight": 1.1 }
      ] }
  ]
}
```

Escape every `<` as `<` if you ever write this into an HTML file block
directly; writing plain `generate-result.json` needs no such escaping.
`size`/`theme` (incl. `fontFamily`) are required. Elements always carry the
full shared field set: `id, x, y, w, h, rotation, opacity`.

## Element quick reference

- **text**: `html` (inline `<b> <i> <br>` ok), `fontSize`, `fontFamily`,
  `fontWeight`, `color`, `align` (`left|center|right`), `valign`
  (`top|middle|bottom`), `lineHeight`, optional `letterSpacing`.
- **shape**: `shape` = `rect|ellipse|triangle|arrow|line|path`, `fill`,
  `stroke`, `strokeWidth`, `radius` (rect corner). Optional `fillGradient`
  `{angle, stops:[{at:0..1, color}]}`. **Lines take their color from
  `fill`** and draw horizontally across the box (rotate for vertical);
  `strokeStyle: solid|dashed|dotted`; tips `lineStart`/`lineEnd` =
  `arrow|dot|bar`. A `path` is `d` (SVG path data) + `pathBox` `[x,y,w,h]`
  authoring viewBox.
- **image**: `src` = data URI or `"asset:<key>"` into `doc.assets`,
  `fit: cover|contain|fill`, `radius`. Embed as data URIs and reference —
  keep the file self-contained.
- **chart**: `preset: bar|line|pie|scatter`, `option` = ECharts-SHAPED pure
  JSON (own renderer, not ECharts — unknown keys degrade silently). Rules
  that bite:
  - Bar/line series `data` must be **plain numbers** — only pie takes
    `{name,value}`.
  - Color **by series**, not per bar.
  - Formatters are template strings only (`{b}`,`{c}`,`{d}`), never
    functions.
  - `label` on a bar/line series does nothing (pie-only) — put numbers in a
    table or text element instead.
- **table**: `columns` (`{w}` fractional weights), `rows`
  (`{cells:[{html, align?, color?, bg?, bold?}]}`), `header` (bool), `style`
  (`headerBg, headerColor, zebra?, borderColor, borderWidth, cellPadX,
  cellPadY, fontSize, color, radius`). Use for comparison/spec/pricing
  grids, not numeric trends (use a chart).
- **svg**: `asset` or `markup` for static artwork only — prefer composing
  rects/texts/paths, which stay editable and can morph.
- **media**: `kind: video|audio`, `src` = data URI (embedded, keep SHORT
  clips only) / URL / `asset:<key>`. Video: `poster`, `fit`, `radius`.
  Flags: `controls, autoplay, loop, muted`. Autoplay is present-mode only
  and needs `muted:true`.
- **code**: `content` (plain text, not html) + text's typography subset.
- **embed**: sandboxed-iframe escape hatch for a live canvas sketch or
  third-party snippet a typed shape can't express — never for anything a
  normal element could do. Capped at 64KB, not sanitized.

## Make it look designed, not just correct

How it should look (one look carried through as one stylesheet, colours
with fixed meanings, diagrams drawn for the content, starter looks) is in
`design.md` in this same directory. Match
the material to the feature:

| Material | Reach for | Why |
|---|---|---|
| numbers to compare visually | a **chart** | bars/lines read instantly |
| consecutive slides, same thing changing | **morph**: same element `id` + `transition:"morph"` on the later slide | the change is visible |
| a point to drill into | a **state slide** (`stateOf` + element `link`) | keeps the linear story clean |
| a full-slide photo | full-bleed image + scrim + text; a slow **ken-burns** for an expressive deck | the picture carries the slide |
| a headline number in a pitch or keynote | big text + `fx:{countUp:true}` | in a talk or lecture, show it beside its comparison (chart or table) instead |

### Copy-paste recipes

**Morph a title + accent bar between two slides** — identical ids,
`transition:"morph"` on slide 2:
```json
// slide 1
{ "id":"s1","transition":"none","elements":[
  { "id":"headline","type":"text","x":96,"y":140,"w":900,"h":200,"html":"Big claim.","fontSize":120,"fontWeight":900,"color":"#111","align":"left","valign":"top","lineHeight":1,"rotation":0,"opacity":1 },
  { "id":"bar","type":"shape","shape":"rect","x":96,"y":380,"w":320,"h":16,"fill":"#E8442E","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1 } ] }
// slide 2 — same ids, new frames -> they animate
{ "id":"s2","transition":"morph","elements":[
  { "id":"headline","type":"text","x":96,"y":84,"w":500,"h":80,"html":"Big claim.","fontSize":40,"fontWeight":900,"color":"#888","align":"left","valign":"top","lineHeight":1,"rotation":0,"opacity":1 },
  { "id":"bar","type":"shape","shape":"rect","x":96,"y":170,"w":16,"h":450,"fill":"#E8442E","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1 } ] }
```

**Full-bleed hero image with ken-burns + scrim + text:**
```json
{ "id":"photo","type":"image","x":0,"y":0,"w":1280,"h":720,"src":"asset:hero","fit":"cover","radius":0,"rotation":0,"opacity":1,"fx":{"ambient":"kenburns","ken":{"dir":"drift","scale":1.09,"duration":22}} },
{ "id":"scrim","type":"shape","shape":"rect","x":0,"y":0,"w":1280,"h":720,"fill":"rgba(10,14,26,0.55)","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1 },
{ "id":"htitle","type":"text","x":96,"y":460,"w":1000,"h":180,"html":"On top of the photo.","fontSize":76,"fontWeight":800,"color":"#fff","align":"left","valign":"top","lineHeight":1.05,"rotation":0,"opacity":1,"fx":{"enter":"fade-up"} }
```
(Embed the image as a data URI in `doc.assets` under key `hero`, reference `"asset:hero"`.)

**A bar chart** — data is plain numbers:
```json
{ "id":"c1","type":"chart","x":96,"y":260,"w":1088,"h":380,"rotation":0,"opacity":1,"preset":"bar","option":{
  "xAxis":{"type":"category","data":["2022","2023","2024","2025"]},
  "yAxis":{"type":"value"},
  "series":[{"type":"bar","data":[420,780,1300,2450],"itemStyle":{"color":"#141310"},"barWidth":90}],
  "tooltip":{"trigger":"item","formatter":"{b}: {c}"} },
  "fx":{"enter":"fade-up"} }
```

## Layout guardrails

- Canonical canvas 1280×720 (`doc.size` can differ — read it first).
- Keep 96px side margins (right-most content x ≤ 1184).
- Column arithmetic, already done, on 1280×720 inside 96px margins (content
  band 1088px wide):

  | Split | Width | `x` positions | Gutter |
  |---|---|---|---|
  | 2 columns | 528 | 96, 656 | 32 |
  | 3 columns | 340 | 96, 470, 844 | 34 |
  | 4 columns | 254 | 96, 374, 652, 930 | 24 |
  | 60/40 (text + image) | 624 / 432 | 96, 752 | 32 |

  A title band `y:72 h:84` over content starting at `y:208` leaves 416px of
  content height above a 96px bottom margin.
- One accent color, 2 typefaces max. `theme` sets deck defaults.

## Text budgets — stay inside these (there is no autofit)

The renderer never shrinks text to fit its box — an element that overflows
just collides with whatever is below it, silently. `window.beeslides.measure()`
is how every OTHER flow checks this before writing, but it needs a live
app/JS context to render into, and **this flow writes `generate-result.json`
blind, before any such context exists** — there is nothing to measure
against yet. So get it right the first time: treat every row below as a
hard ceiling for that role/box combination. **If your copy is longer than
its budget, shorten it, split the point across more slides, or move to a
smaller-role/narrower box (e.g. break one long body into two columns) —
never let a box hold more text than it was budgeted for and hope it fits.**

**How these numbers were derived** (so you can extend the table for a size
not listed here). BeeSlides's default font stack (`FONT_STACK` in
`model.ts`: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
Helvetica, Arial, sans-serif` — the same stack this brief's own theme
default uses) is a proportional UI sans-serif. For that family, average
glyph width in running mixed-case English text is commonly cited at about
0.50× the font size for regular (400) weight, rising with stroke weight to
~0.55× at bold (700) and ~0.60× at black (800–900) — heavier weights carry
wider glyphs and thicker stems. Word-wrapped text also never fills a line to
the exact last pixel (whole words, not characters, decide the wrap point),
so the width side of the math below reserves an 8% slack budget for that.
Putting it together, per row:

```
avgCharWidth ≈ fontSize × k     (k ≈ 0.50 regular / 0.55 bold / 0.60 black)
charsPerLine ≈ floor(boxWidth × 0.92 / avgCharWidth)
maxLines     ≈ floor(boxHeight / (fontSize × lineHeight))
```

Box widths below are the ones this brief already fixes (1088px full-width
content band; 528/340/254 for 2/3/4 columns, from the column table above);
box heights are the title band and content-height numbers from the same
guardrails section. Font size/weight/lineHeight per role are the values
`slides/src/model.ts`'s built-in layouts actually use for that role
(`layout-title-content`, `layout-two-col`, `layout-section`, …), plus the
cover-title convention this brief's own minimal-document example uses:

| Role | fontSize | weight | lineHeight | Box (w × h, px) | Max chars/line | Max lines | Rough capacity |
|---|---|---|---|---|---|---|---|
| Title (content slide) | 44 | 700 | 1.25 | 1088 × 84 | ~41 | 1 | one short headline |
| Section-divider title | 64 | 700 | 1.25 | 1088 × 120 | ~28 | 1 | one short headline |
| Cover / hero title | 88 | 800 | 1.1 | 1088 × 160 | ~19 | 1 | one very short headline |
| Subtitle | 28 | 400 | 1.25 | 1088 × 60 | ~71 | 1 | one line |
| Body, full width | 26 | 400 | 1.5 | 1088 × 416 | ~77 | 10 | ~700–770 characters |
| Body, 2 columns | 24 | 400 | 1.5 | 528 × 416 | ~40 | 11 | ~400–440 characters |
| Body, 3 columns | 24 | 400 | 1.5 | 340 × 416 | ~26 | 11 | ~260–290 characters |
| Body, 4 columns | 24 | 400 | 1.5 | 254 × 416 | ~19 | 11 | ~190–210 characters |
| Kicker / eyebrow label | 18 | 600 | 1.25 | ≤ 640 × 40 | ~62 (ceiling, not a target) | 1 | 2–4 words, not a sentence |

What this table does **not** cover, so don't over-read it:
- It assumes plain wrapped paragraph text. A **bulleted list** costs at
  least one line per bullet regardless of wrapping, and the bullet
  marker + indent narrow the effective width by roughly another 24px —
  count bullets, not just total characters, against `maxLines`.
- These are ceilings for text that still fits cleanly, not stylistic
  targets — a title using 5 of its 41 characters is fine; one using 40 of
  41 "fits" but leaves zero margin for a wider font render on someone
  else's machine.
- **CJK and other dense scripts run much closer to 1.0× the font size per
  glyph**, not 0.5–0.6× — halve every `charsPerLine`/capacity number above
  for non-Latin, non-alphabetic scripts.
- Resizing a role's box away from the dimensions above invalidates that
  row — recompute from the formula, don't reuse the row by role name alone.

## `role`, layouts, and dynamic fields

Any text element can carry `"role": "title"|"subtitle"|"body"|"kicker"` —
this is what lets someone restyle the deck later via `doc.layouts`, so set
it on generated decks; costs one key per element. Text `html` can use
`{{page}}`, `{{pages}}`, `{{title}}`, `{{date}}`, `{{time}}` tokens (resolve
at render time, zero-pad with `{{page:2}}`), plus `{{author}}`,
`{{company}}`, `{{subject}}`, `{{event}}` from an optional top-level
`"meta"` object.

## Gotchas

- Don't invent property names — unknown keys are silently ignored.
- `id` is identity: morph, states, and links key off it. Emit deterministic
  ids.
- Text/table `html` is a sanitized rich-text subset (`b/i/u/s/code/br/div`,
  `<span style="color:#hex;font-size:24px">`, `<a href="https://…">` (http,
  https, mailto only), `<ul>/<ol>/<li>` with a sub-list inside its item) —
  no other tags, attributes or style properties. A file that uses links,
  lists or styled spans must list `"rich-text"` in `requires`.

### Before you finish — self-audit

- [ ] Any numbers rendered as text that should be a **chart**?
- [ ] Do consecutive slides on one subject share element **ids +
      `transition:"morph"`**?
- [ ] At least one motion moment (ken-burns / loop / count-up), especially
      the cover?
- [ ] One accent colour, at most two typefaces, 96px side margins?
- [ ] Speaker notes written on each slide?
- [ ] If redesigning: did the original `theme` colors and `assets`
      (icons/logos) actually carry over, not just get replaced?
- [ ] Does every title/subtitle/body/kicker text stay within the **char/line
      budgets** above for its actual fontSize and box? There is no autofit —
      text over budget WILL overflow into whatever is below it. Shorten it or
      resize/restructure deliberately; don't just leave it and hope.
