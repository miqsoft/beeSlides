# BeeSlides — for AI agents

**Guide version `__APP_VERSION__`** · document format `beeslides/slides` (v1). This
guide matches the BeeSlides shell of the same version. A deck's `#beeslides-doc`
JSON is always the source of truth — if it was written by a newer shell it may
carry features beyond this guide; unknown keys are ignored, never fatal.

## Quick reference (desktop terminal sessions: read only this section first)

**Create or restructure a slide by writing HTML**: `slide_html({op:"write",
slideId, html, css})`. The slide is the page body (1280×720): lay it out with
ordinary CSS — flexbox, grid, padding, gap — and the app lays it out in the
browser and turns every box into a slide element, so no frame is computed by
hand. `slide_html({op:"read", slideId})` gives a slide back as HTML to edit and
write again. See "Slides as HTML" below.

Edit through the `beeslides` MCP tools. The smallest verb wins:
`update_element({slideId, elementId, props})` for any property change,
`set_frame` to move/resize one element, `insert_elements`/`delete_element` for
structure, `write_slide` only to restructure a whole slide. Several elements at
once, and layout, are ONE call of `elements({op, slideId, …})`: `edit` (a batch
of `{id, …props}` / `{id, delete:true}` changes), `delete`, `arrange` (`as`
row|column|grid, `within` "bounds"|"space"|an element id — the app computes
every frame; a card's box brings its texts along), `align`, `distribute`,
`match_size`. Never loop `set_frame` over several elements. After removing
content, rebalance the rest with `arrange` `within:"space"` unless the space is
wanted. To find where
something is, `find_text({query})` searches the whole deck ("a|b" for
alternatives); to read a slide, `get_slide({slideId, view:"summary"})` gives
one line per element with its text at a tenth of the full JSON — ask for the
full view only before `write_slide` or to copy exact styling. Deck structure
— add/duplicate/move/hide/delete slides, transitions, backgrounds, speaker
notes, sections, interactive states, hover groups, title and properties — is
ONE tool, `deck({op, …})`; deck-wide settings — theme colours and fonts,
slide size, slideshow, slide timing, header & footer, numbering — are
`deck_settings({op, …})`. Icons come from the user's icon library:
`icons({op:"search", query})` lists refs, `icons({op:"insert", slideId, ref, x, y, size})`
places one — never write SVG (it is refused), and never download artwork from the
internet yourself (licensing): the icon records where it came from and its
license (`provenance`). `op:"help"` explains every op. `add` returns the new ids, so create
all slides first, then fill them. Delete only slides you added unless the
user asked (`userAsked:true`). Every `slideId`
also takes a slide type (layout) id — writing there reaches every deck slide
using it — or a reusable object id. Canvas is `doc.size`, usually 1280×720;
keep content inside 96px side margins.

The app guards the layout around every write (one undo step with it): text
that no longer fits grows, neighbours shift to keep their gaps, arrows stay
attached — reported as `↻ LAYOUT ADJUSTED`. `⚠ LAYOUT` means something still
overlaps: fix it, then `check_layout` until clean (at most 3 rounds).
`reflow:false` on a write places things exactly and only reports. After an
edit to a selection, `review_slide` once (screenshot + frames + findings);
polish crowding/misalignment with small writes, at most 2 rounds, without
redesigning what the user did not ask about.

Every element: `id`, `type`, `x`, `y`, `w`, `h` (slide px, top-left
origin), `rotation` (deg), `opacity` (0..1); optional `role`
(`title|subtitle|body|kicker|media`), `shadow` `{x?,y?,blur,color}` (or an
array of them to stack, e.g. elevation + glow), `reflection`
`{opacity?,size?,gap?}` (mirror below the element; opacity/size 0..1, gap px;
defaults .35/.5/0; not drawn in Firefox, not exported to SVG), `link`
(slide id). `shape`/`image`/`svg` also take `flipH`/`flipV` (booleans; mirror
the content inside the frame — use them instead of negative sizes; text
cannot be flipped). `image`/`svg`/`chart`/`media` take `alt` — a short
description of what it shows for screen readers (`""` = decorative); give
every picture and chart one.

| type | key props |
|---|---|
| `text` | `html` (inline `b i u s code br span`), `fontSize`, `fontFamily`, `fontWeight`, `color`, `align` `left\|center\|right`, `valign` `top\|middle\|bottom`, `lineHeight`, `letterSpacing` |
| `shape` | `shape` `rect\|ellipse\|triangle\|arrow\|line\|path`, `fill`, `stroke`, `strokeWidth`, `radius`, `fillGradient` `{angle, stops:[{at,color}]}`, `strokeStyle`; a `line` is coloured by `fill` |
| `image` | `src` (data URI or `asset:<key>`), `fit` `cover\|contain\|fill`, `radius`, `crop` `{x,y,w,h}` (fractions 0..1 of the natural picture, stretched to the frame — keep the frame's aspect; set `fit:"cover"` with it; remove it with `update_element` `crop: null` or the whole picture `{x:0,y:0,w:1,h:1}` — the frame keeps its size, so set `w`/`h` to the picture's own aspect to show all of it) |
| `table` | `columns` `[{w}]`, `rows` `[{cells:[{html}]}]`, `header`, `style` |
| `chart` | `preset` `bar\|line\|pie\|scatter`, `option` (ECharts-shaped, plain-number data) |
| `code` | `content` (plain text), same typography as `text` |

Colours are CSS strings (`#RRGGBB`, `rgba()`). Unknown keys are refused by
`update_element` and ignored elsewhere, so a typo never applies silently via
the MCP tools. Measure multi-line text first (`measure`), and treat a
`TEXT OVERFLOW` banner in a write response as a failed write. Locks,
variants, change patterns and the slide-type tree are covered in the
sections below. Only read further if the task needs it.

---

> **This guide covers BeeSlides decks only** (`"format": "beeslides/slides"`).
> Other apps built on the same file idea may use other formats. Before you
> edit a file, check its `"format"` field and use the matching guide; if the
> format is one you have no guide for, don't guess at its shape.

*Drop this file into your context (or point your harness at it) and you can
author and edit BeeSlides presentations directly. For **Claude Code**,
install the packaged **slidomingo-slides** skill once and it triggers automatically
(or via `/slidomingo-slides`) so a deck can be authored straight from an
empty folder — see this repo's own skill/plugin setup for how to install it
locally.*

**Working without the skill, from an empty folder?** Start from a copy of the
app itself — this is the file you write your document into. Any already-built
`*.beeslides.html` shell (e.g. from a local `npm run build:single`) works;
opened in a browser with no document written into it yet, it opens one
blank slide, but on disk there is nothing to discard and nothing to copy
from. Write your document into the empty block.

A BeeSlides deck (`*.beeslides.html`) is a self-contained HTML file. The document
lives in ONE plaintext block near the top:

```html
<script type="application/beeslides+json" id="beeslides-doc">
{ "format": "beeslides/slides", ... }
</script>
```

A file saved before 2026-10-20 (often `*.slidomingo.html`) uses the old names
throughout: `id="slidomingo-doc"`, `"format": "slidomingo/slides"`,
`<style id="slidomingo-assets">` and `"slidomingo-store:…"` refs. Edit such a
file under ITS names — never rename them by hand, since its own runtime reads
only those. BeeSlides converts it on its next save.

Two ways to work with it:

1. **File harness** (Claude Code, agent sandboxes): edit the JSON inside the
   `#beeslides-doc` block in place. Escape every `<` in the JSON as `\u003c`
   so the block can never contain a literal `</script>`. Leave everything else in the
   file untouched — in particular `<style id="beeslides-assets">`, which holds
   the file's pictures and fonts. Strings like
   `"beeslides-store:sha256-0123456789abcdef"` are references to those bytes:
   keep them (and `"requires": ["asset-store"]`) exactly as they are, move or
   copy them freely, and never invent one. New pictures may always be written
   inline as `data:` URIs; the app stores them on its next save.
2. **Chat round-trip** (any chatbot): the user copies the JSON out via
   *Save → Copy document JSON* — or *Copy document JSON without pictures*,
   which is small enough for any chat: pictures become
   `"beeslides-store:sha256-…"` refs. You return a full replacement document
   (keep every ref you were given; add new pictures as `data:` URIs), and they
   paste it back via *Save → Replace from JSON…* (undoable), which puts the
   pictures back.
   In the browser console: `window.beeslides.doc` (read) /
   `window.beeslides.loadDoc(json)` (write, undoable).

---

## Slides as HTML (`slide_html`)

The fastest way to a well-laid-out slide is the one you already know: HTML and
CSS. `slide_html` `write` lays your HTML out in the browser, at the slide's
size, with the deck's theme, and turns what the browser drew into ordinary
elements — the deck stays a normal BeeSlides deck, nothing is "an HTML slide".

```json
{ "op": "write", "slideId": "s3",
  "css": ".slide{width:100%;height:100%;padding:72px var(--bs-margin);display:flex;flex-direction:column;gap:20px} .cards{display:flex;gap:28px;margin-top:32px} .card{flex:1;background:#fff;border-radius:18px;padding:28px;box-shadow:0 8px 24px rgba(0,0,0,.12)} h3{margin:0 0 12px;font-size:30px} p{margin:0;font-size:22px;line-height:1.4}",
  "html": "<main class=\"slide\"><h1 id=\"title\">Three reasons</h1><div class=\"cards\"><div class=\"card\" id=\"c1\"><h3 id=\"c1h\">Flow</h3><p id=\"c1p\">…</p></div><div class=\"card\" id=\"c2\">…</div><div class=\"card\" id=\"c3\">…</div></div></main>" }
```

- **The page is the slide.** `body` is `doc.size` (usually 1280×720). Theme
  variables: `--bs-bg`, `--bs-text`, `--bs-accent` … `--bs-accent6`,
  `--bs-font`, `--bs-heading-font`, `--bs-margin` (96px). Defaults:
  `box-sizing: border-box`, body text `var(--bs-font)` 24px/1.2.
- **What becomes what.** A box with a background, border or shadow → a rect
  (`border-radius: 50%` → ellipse; a one-sided border → its own bar, curved
  under rounded corners). A block holding only text (inline `b i u s code a
  span br`, or a `ul`/`ol`) → one text element on its content box; bold,
  italics, colour and size of inline runs — even from CSS classes — are kept.
  `<img>` → picture (`src`: a `data:` URI, `asset:<key>` or `element:<id>` of a
  picture already in the deck; nothing is downloaded). `<table>` → table
  (`thead`/`th` header, padding, borders, colours, zebra, `colspan`/`rowspan`
  read from the CSS; its rows share the height evenly). `<pre>` → code. `<hr>`
  → line. `<div data-chart='{"preset":"bar","option":{…}}'>` → chart. An
  inline `<svg>` drawing → native shapes, paths and text, one group (as
  Convert to objects does — never an opaque svg). A self-contained
  `<iframe srcdoc>` → an `embed` (sandboxed widget). A root box covering the
  slide (or `body`'s background) → the slide background. `transform:
  rotate()` → rotation.
- **Left out** (the result says so): scripts, video, forms, frames with an
  outside `src`, and every `url()` that is not a `data:` URI. Nothing in the
  HTML runs or loads while it is converted. Icons from the user's library go
  in with `icons` afterwards.
- **Ids are identity.** Give every element an `id`: it becomes the element id.
  Writing the slide again with the same ids updates those elements in place —
  animations (`fx`), links, locks and comments stay — and removes the ones
  whose id is gone. The same id on the next slide + `transition:"morph"`
  morphs. A box with text in it becomes two elements, `<id>` (the box) and
  `<id>-text`. `data-role="title|subtitle|body"` sets a role (the first `<h1>`
  is the title); `data-valign="middle"` centres text vertically.
- **`<div id="x" data-keep>`** keeps the existing element `x` (an icon, a
  line, a video …) at the place this box takes in the new layout.
- **Each write is one undo step**, followed by the layout guard like every
  agent write. Then look at it: `review_slide`.

**Reading a slide back.** `read` returns the HTML the slide was last written
from, as long as the slide has not changed since. Otherwise it generates HTML
from the slide: boxes that hold other elements become nested `<div>`s, items
side by side become flex rows, stacks flex columns, rows of rows a grid; the
rest keeps its exact position. Generated HTML is verified before you get it —
laid out again it gives every element its current frame (within 1px) — so
"read, change one thing, write" changes only that thing. Elements HTML cannot
show appear as `data-keep` placeholders; pictures as `src="element:<id>"`.

Use `slide_html` to create and restructure; use `update_element` /
`elements` for small changes (a colour, one nudge, an animation).

---

## Make a GREAT deck, not just a correct one

**Read this section first — it is the difference between a wall of text and a
BeeSlides deck.** The format's whole value is motion, morph, charts and
interactivity. A correct-but-static result (bullets on slides) wastes it and
is the #1 failure mode. The move is to look at the *source material* and map
each kind of content to the feature built for it:

| When the material is… | Reach for | Why |
|---|---|---|
| numbers to **compare visually** (trend, magnitude, share) | a **chart** element | bars/lines read instantly |
| a **comparison / spec / pricing / feature grid** (rows × columns of labels + values) | a **table** element | structured cells beat 20 hand-placed text boxes; it styles cohesively |
| consecutive slides about the **same thing changing** (before/after, process steps, a metric across stages) | **morph**: same element `id` on both slides + `transition:"morph"` on the later one | the shared elements glide; this is the signature move you'll almost always miss |
| a point to **drill into** (a definition, "click to see how", a sub-topic) | a **state slide** (`stateOf` + element `link`) | keeps the linear story clean; the detail is one click away |
| a **hero / full-slide image** | full-bleed image + scrim rect + text, with **ken-burns** | static photos feel dead; a slow drift feels intentional |
| a **sequence / flow / timeline / connection** | a line or `path` with a **`dash-march` loop**, or morph a highlight through the steps | motion carries the eye along the sequence |
| a **headline number** | big text + `fx:{countUp:true}` | the count-up earns attention |
| **every cover / section divider** | at least **one ambient motion** (ken-burns, an orbiting accent) | a still cover is a missed first impression |
| **repeated chrome / a logo** | keep its `id` stable across slides | it morphs in place instead of popping on every slide |
| a **demo clip / recording / soundbite** | a **media** element (embed short, link long) | a live video/audio beats a screenshot of one |
| **concepts / features / steps / roles** side by side (an agenda, a 3-up, a process) | an **icon per item** from the user's library: `icons` search (one short noun per concept) → insert, same size for all | icons make a list scannable; the user's own library keeps the house style — never hand-draw icon SVG |

### Copy-paste recipes

**Morph a title + accent bar between two slides** — identical ids, `transition:"morph"`:
```json
// slide 1
{ "id":"s1","transition":"none","elements":[
  { "id":"headline","type":"text","x":96,"y":140,"w":900,"h":200,"html":"Big claim.","fontSize":120,"fontWeight":900,"color":"#111","align":"left","valign":"top","lineHeight":1,"rotation":0,"opacity":1 },
  { "id":"bar","type":"shape","shape":"rect","x":96,"y":380,"w":320,"h":16,"fill":"#E8442E","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1 } ] }
// slide 2 — same ids, new frames → they animate
{ "id":"s2","transition":"morph","elements":[
  { "id":"headline","type":"text","x":96,"y":84,"w":500,"h":80,"html":"Big claim.","fontSize":40,"fontWeight":900,"color":"#888","align":"left","valign":"top","lineHeight":1,"rotation":0,"opacity":1 },
  { "id":"bar","type":"shape","shape":"rect","x":96,"y":170,"w":16,"h":450,"fill":"#E8442E","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1 } ] }
```

**A bar chart from a table** — bar/line data is PLAIN NUMBERS (see chart rules below):
```json
{ "id":"c1","type":"chart","x":96,"y":260,"w":1088,"h":380,"rotation":0,"opacity":1,"preset":"bar","option":{
  "xAxis":{"type":"category","data":["2022","2023","2024","2025"]},
  "yAxis":{"type":"value"},
  "series":[{"type":"bar","data":[420,780,1300,2450],"itemStyle":{"color":"#141310"},"barWidth":90}],
  "tooltip":{"trigger":"item","formatter":"{b}: {c}"} },
  "fx":{"enter":"fade-up"} }
```

**A comparison table** — a real HTML table; cells are the same inline-html subset as text:
```json
{ "id":"tbl1","type":"table","x":240,"y":220,"w":800,"h":260,"rotation":0,"opacity":1,
  "header":true,
  "columns":[{"w":1.4},{"w":1},{"w":1}],
  "rows":[
    { "cells":[{"html":"Plan"},{"html":"Price","align":"right"},{"html":"Seats","align":"right"}] },
    { "cells":[{"html":"Team"},{"html":"$29"},{"html":"5"}] },
    { "cells":[{"html":"Business"},{"html":"$79"},{"html":"25"}] } ],
  "style":{"headerBg":"#1E2A3A","headerColor":"#fff","zebra":"rgba(30,42,58,0.05)",
    "borderColor":"rgba(30,42,58,0.14)","borderWidth":1,"cellPadX":16,"cellPadY":11,
    "fontSize":18,"color":"#1E2A3A","radius":10} }
```

**A state slide reached by clicking a node** — parent slide has the clickable element, the state lives adjacent:
```json
// on the parent slide, an element the viewer clicks:
{ "id":"node-ingest","type":"shape","shape":"ellipse","x":330,"y":180,"w":74,"h":74,"fill":"#0B0E1E","stroke":"#7A5CFF","strokeWidth":2,"radius":0,"rotation":0,"opacity":1,"link":"state-ingest" }
// a hidden state slide (arrow keys skip it; ← returns to parent):
{ "id":"state-ingest","stateOf":"parent-slide-id","transition":"morph","name":"INGEST","elements":[ /* … */
  { "id":"dismiss","type":"shape","shape":"rect","x":0,"y":0,"w":1280,"h":720,"fill":"rgba(0,0,0,0)","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1,"link":"parent-slide-id" } ] }
```

**Full-bleed hero image with ken-burns + scrim + text:**
```json
{ "id":"photo","type":"image","x":0,"y":0,"w":1280,"h":720,"src":"asset:hero","fit":"cover","radius":0,"rotation":0,"opacity":1,"fx":{"ambient":"kenburns","ken":{"dir":"drift","scale":1.09,"duration":22}} },
{ "id":"scrim","type":"shape","shape":"rect","x":0,"y":0,"w":1280,"h":720,"fill":"rgba(10,14,26,0.55)","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1 },
{ "id":"htitle","type":"text","x":96,"y":460,"w":1000,"h":180,"html":"On top of the photo.","fontSize":76,"fontWeight":800,"color":"#fff","align":"left","valign":"top","lineHeight":1.05,"rotation":0,"opacity":1,"fx":{"enter":"fade-up"} }
```
(Embed the image as a data URI in `doc.assets` under key `hero`, then reference `"asset:hero"` — the file must stay self-contained.)

**Video — embed a short clip, or link a big one** (autoplay is present-only; `muted` required to autoplay):
```json
// embedded — self-contained, keep it small (a few MB at most):
{ "id":"clip","type":"media","kind":"video","src":"data:video/mp4;base64,AAAA…","x":220,"y":120,"w":840,"h":472,"rotation":0,"opacity":1,"controls":true,"muted":true,"autoplay":true,"loop":true,"fit":"cover","radius":8 }
// linked — deck stays tiny; needs the URL at play time (give it a poster):
{ "id":"clip","type":"media","kind":"video","src":"https://cdn.example.com/demo.mp4","poster":"asset:demo-poster","x":220,"y":120,"w":840,"h":472,"rotation":0,"opacity":1,"controls":true }
```

**Summary Zoom — an agenda slide whose tiles zoom into each section** (needs `doc.sections`; tiles keep the deck's 16:9 aspect):
```json
// doc.sections — one per part, plus one for the summary slide itself:
[ { "id":"sec-sum","name":"Summary","startSlideId":"summary" },
  { "id":"sec-why","name":"Why","startSlideId":"why-1" },
  { "id":"sec-how","name":"How","startSlideId":"how-1" } ]
// the summary slide, placed right before "why-1":
{ "id":"summary","transition":"fade","notes":"","background":"#FFFFFF","elements":[
  { "id":"sum-title","type":"text","role":"title","x":77,"y":43,"w":1126,"h":94,"html":"Summary","fontSize":48,"fontWeight":700,"color":"#1D1119","align":"left","valign":"middle","lineHeight":1.25,"fontFamily":"system-ui, sans-serif","rotation":0,"opacity":1 },
  { "id":"z-why","type":"zoom","target":{"section":"sec-why"},"x":110,"y":250,"w":512,"h":288,"stroke":"#D9D9D9","strokeWidth":3,"radius":6,"rotation":0,"opacity":1 },
  { "id":"z-how","type":"zoom","target":{"section":"sec-how"},"x":658,"y":250,"w":512,"h":288,"stroke":"#D9D9D9","strokeWidth":3,"radius":6,"rotation":0,"opacity":1 } ] }
```
Clicking a tile plays its section (→ walks it, hidden slides included) and zooms back to the summary; ← on the section's first slide zooms back too. In the editor: Insert ▸ Zoom ▸ Summary zoom… builds exactly this in one step (picked slides start new sections).

### Before you finish — self-audit

- [ ] Any numbers rendered as text that should be a **chart**?
- [ ] Do consecutive slides on one subject share element **ids + `transition:"morph"`**?
- [ ] At least one **motion moment** (ken-burns / loop / count-up), especially the cover?
- [ ] A drill-down that would work better as a **state slide**?
- [ ] Lists of concepts/features/steps: does each item carry an **icon** from the library (`icons`)?
- [ ] One accent colour, at most two typefaces, **96px** side margins (right-most x ≤ 1184)?
- [ ] **Speaker notes** written on each slide (they travel in the file and double as the talk track)?
- [ ] **Have you actually looked at it?** Open the deck and page through every
      slide. Text overflowing its box, two elements crowding each other, a
      heading that wrapped to three lines, a chart key that was silently
      dropped — none of these are visible in the JSON, and all of them are
      obvious on screen. This is the only check that catches what the others
      cannot; a deck nobody rendered is not finished. In the desktop app that
      is `review_slide` (a screenshot of just the slide, every element's
      frame, and the `check_layout` findings in one call).
- [ ] **Layout banners handled?** Every `⚠ LAYOUT` from a write is fixed and
      `check_layout` reports clean. The `↻ LAYOUT ADJUSTED` lines are what the
      app already fixed for you (kept gaps, grown text, attached arrows) —
      don't undo them by hand.

### `window.beeslides.measure()` — size text before you place it (this is a precondition, not a suggestion)

The format is absolute pixels, which is what lets morph, the drag handles and
the renderer work from one representation. The cost falls on you: the height of
a string at a given width and font is not knowable from the JSON.

**Any multi-line text write is expected to call `measure()` first.** This is
not advisory — skip it and the write path (`window.beeslides.validate()`, and
the MCP `write_slide`/`insert_elements`/etc. tools) WILL flag the resulting
overflow back at you afterward anyway, as a prominent "TEXT OVERFLOW" finding.
Calling `measure()` up front is strictly cheaper than writing, getting flagged,
and fixing it in a second round trip — treat the after-the-fact check as a
safety net for what you missed, not as the normal way to size text.

```js
window.beeslides.measure({ html: 'Long paragraph…', w: 600, fontSize: 28, lineHeight: 1.4 })
// → { height: 236, width: 600, lines: 6 }
```

Pass a spec to size text **before** the element exists — which is the point, as
it lets you lay a slide out correctly the first time. Pass an element id to
measure one already in the deck, and include `h` in a spec to get `fits` and
`overflow` back too. It renders through the real renderer, so the answer is
what the slide will actually do, not an estimate.

Use it for the arithmetic that used to be guesswork: stacking cards in a
column, deciding whether a heading needs two lines or three, sizing a caption
under a photo. In the editor, the same thing is a **Fit height to text** button
in the Typography panel.

### `window.beeslides.validate()`

Open the deck and run it in the browser console. It reports, in one pass, the
things the runtime otherwise swallows in silence:

```js
const { ok, counts, findings } = window.beeslides.validate()
findings.filter(f => f.severity !== 'info')
```

Each finding is `{code, severity, message, slide?, element?, path?}`. It checks
unknown property names (a typo is ignored, so the styling just never applies),
text that overflows its box (measured against the real renderer), equations
whose TeX does not typeset (`math-parse-error`) or is empty (`math-empty`), elements off
the canvas, entrances that can never run, `dash-march` without a dashed stroke,
broken `link` and `asset:` references, duplicate ids and morph-key collisions,
chart options charts-lite does not implement, and accessibility: pictures/
charts/media with no `alt` (`missing-alt`), text below WCAG AA contrast against
a backdrop it can resolve (`low-contrast`), and slides with no `role: "title"`
text (`missing-title`).

It only reads — it never changes the document, and a finding is advice, not a
refusal. `severity: "info"` is deliberately quiet (a photo bleeding off the
canvas is a design move, not a defect); `error` means something is broken, like
a link to a slide that does not exist.

This does not replace looking at the deck. It catches what is checkable; the
rest — whether a slide is any good — still needs eyes.

## Minimal valid document

Start from this skeleton when creating a deck from scratch. `size` and
`theme` (including `fontFamily`) are **required** — the app will not boot
without them — and elements should carry the full field set shown.

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

## Element types (all share `id,x,y,w,h,rotation,opacity`)

- **text**: `html` (inline `<b> <i> <br>` ok), `fontSize`, `fontFamily`,
  `fontWeight`, `color`, `align` (`left|center|right`), `valign`,
  `lineHeight`, optional `letterSpacing`.
- **shape**: `shape` = `rect|ellipse|triangle|arrow|line|path`, `fill`, `stroke`,
  `strokeWidth`, `radius` (rect corner). Optional `fillGradient`
  `{angle, stops:[{at:0..1, color}]}` (CSS-convention angle). Lines take
  their color from `fill` and draw horizontally across the box (rotate for
  vertical); `strokeStyle: solid|dashed|dotted`; tips `lineStart`/`lineEnd`
  = `arrow|dot|bar`. A `path` is a free vector: `d` (SVG path data) +
  `pathBox` `[x,y,w,h]` authoring viewBox, stretched into the element box;
  for a **curved line** set `fill:"transparent"` + a `stroke` + `strokeWidth`.
  A path also takes `strokeCap` / `strokeJoin` (`round|bevel|miter`) and
  `fillRule:"evenodd"` (a donut or a letter with a counter whose inner contour
  winds the same way as the outer).
  A **connector** is a `line` (or `path`) with `from`/`to: {el, side}` — its ends
  follow those elements and re-route when they move (side `"auto"` picks the
  nearest border). Make sure a shape's colour contrasts with its slide background.
- **image**: `src` = data URI or `"asset:<key>"` into `doc.assets`,
  `fit: cover|contain|fill`, `radius`. Embed images as data URIs in
  `doc.assets` and reference them — the file must stay self-contained.
- **chart**: `preset: bar|line|pie|scatter`, `option` = ECharts-SHAPED pure
  JSON. **Bar/line series data must be plain numbers** (`{value,itemStyle}`
  objects coerce to 0 — only pie takes `{name,value}`); per-item bar colors
  are unsupported, color by series; template formatters only (`{b}`, `{c}`,
  `{d}`), never functions. **Dual axis**: for two series on very different
  scales (e.g. volume + a %), make `yAxis` an ARRAY of two `{type:"value"}`
  axes (give the 2nd `axisLabel:{formatter:"{value}%"}`) and point the odd
  series at it with `"yAxisIndex":1` — render it as a `line` over the bars.
  **The engine is charts-lite, not ECharts** — it reads the option SHAPE and
  ignores every key it does not implement, silently. What it honours:
  - top level — `color`, `series`, `xAxis`, `yAxis`, `legend`, `grid`,
    `tooltip`, `textStyle`, `dataZoom`
  - any series — `type`, `name`, `data`, `yAxisIndex`, `itemStyle.color`
  - bar — `itemStyle.borderRadius`
  - line — `smooth`, `symbol`, `symbolSize`, `lineStyle.color`,
    `lineStyle.width`, `areaStyle.color`
  - pie — `radius`, `label.formatter` (or `label:false`),
    `itemStyle.borderColor`, `itemStyle.borderWidth`
  - axes — `type`, `data`, `min`, `max`, `axisLabel` (`fontSize`,
    `fontWeight`, `color`, `formatter`), `axisLine`, `splitLine`
  - legend — `show`, `top`, `bottom`, `textStyle.fontSize`,
    `textStyle.fontWeight`

  **`label` on a bar or line series does nothing** — value labels above bars
  are pie-only. If you need the numbers visible on a cartesian chart, put them
  in a table beside it, or use text elements.
- **table**: `columns` (array of `{w}` fractional weights), `rows` (array of
  `{cells:[{html, align?, color?, bg?, bold?}]}`), `header` (bool — row 0 is
  the header), and a `style` object (`headerBg`, `headerColor`, `zebra?`,
  `borderColor`, `borderWidth`, `cellPadX`, `cellPadY`, `fontSize`, `color`,
  `radius`). Renders as a real HTML table. Use for comparison/spec/pricing
  grids — NOT for numeric trends (use a chart).
- **svg**: static artwork the deck already holds (`asset` key). You cannot
  author one: `markup` of your own, a new svg asset, or a picture holding SVG
  is refused. Icons come from the `icons` tool; shapes and diagrams are rects/
  ellipses/lines/`path` shapes and text — those stay editable and can morph.
- **media**: `kind: video|audio`, `src` = data URI (embedded — travels in the
  file), an external URL / relative path (referenced — keeps the file small,
  needs the network at play time), or `"asset:<key>"`. Video also takes
  `poster`, `fit: cover|contain|fill`, `radius`. Playback flags: `controls`,
  `autoplay`, `loop`, `muted`. **Autoplay fires only in present mode**, and
  browsers require `muted:true` for a video to autoplay. **Embed only SHORT
  clips** — a big data URI bloats the file and makes it slow to open/save;
  host large media and reference its URL instead.
- **code**: `content` (plain text, NOT html), `fontSize`, `fontFamily`,
  `color`, `align`, `valign`, `lineHeight` (same typography subset as
  `text`). Optional `grammarName`/`themeName` (reserved for a future
  highlighting tier — the renderer's built-in tokenizer is used regardless).
  Renders as a `<pre>` with a 7-colour built-in syntax palette. Lines morph
  individually when the element's `morphId || id` is shared across slides
  (a diff-and-travel effect for "highlight this changed line" sequences) —
  same idiom as any other morph pairing.
- **math**: an equation. `tex` = raw LaTeX **without** `$` and **without**
  entity escaping (in JSON a backslash doubles: `"tex": "\\frac{a}{b}"`),
  `fontSize`, `color`, `align`, `valign`; `inline: true` for compact text
  style (default: display style — big operators with limits above/below).
  Typeset by Temml as MathML. The formula is NOT clipped to the box, so size
  the box to it: roughly `h ≈ 2 × fontSize` for a one-level fraction, more for
  stacked ones — then check the slide. Invalid TeX shows its raw source;
  `validate()` flags it as `math-parse-error`. Formulas on two slides that
  share the element's `morphId || id` morph symbol by symbol (a term crossing
  the `=` visibly travels). Example:
  ```json
  { "id": "eq1", "type": "math", "x": 240, "y": 280, "w": 800, "h": 160,
    "rotation": 0, "opacity": 1, "tex": "x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}",
    "fontSize": 56, "color": "#1D1119", "align": "center", "valign": "middle" }
  ```
  For a formula INSIDE a sentence or a table cell, don't use a math element —
  write `$…$` in the text/cell `html` (see "Inline math" below).
- **embed**: `html` — a full HTML document or fragment, run inside a
  **sandboxed** (`allow-scripts` only, no `allow-same-origin`) iframe. This
  is the one escape hatch from the closed element set: use it for a live
  canvas sketch, a small game, or a third-party embed snippet a typed shape
  can't express — never for anything a `text`/`shape`/`chart`/`table`
  element could do instead. Capped at 64KB and **NOT sanitized** the way
  `text`/`table` html is (no tag whitelist) — safety is entirely the
  sandbox, so never rely on this element to hold trusted-looking content
  from an untrusted source. It only runs live while presenting; the editor
  canvas, thumbnails, and print all show a static placeholder instead.
  Example:
  ```json
  { "id": "e1", "type": "embed", "x": 340, "y": 160, "w": 600, "h": 400,
    "rotation": 0, "opacity": 1,
    "html": "<!doctype html><meta charset=\"utf-8\"><style>html,body{margin:0;height:100%;background:#0b0f14}</style><canvas id=\"c\"></canvas><script>const c=document.getElementById('c'),ctx=c.getContext('2d');function r(){c.width=innerWidth;c.height=innerHeight}addEventListener('resize',r);r();ctx.fillStyle='#F7A600';ctx.fillRect(40,40,80,80)</script>" }
  ```

- **zoom**: a live tile of another slide or section that the show zooms
  into and back out of (PowerPoint's Slide / Section / Summary Zoom).
  `target: {"slide": id}` or `{"section": id}`; `range: "section"` (slide
  targets) plays on to the end of that slide's section; `returnToZoom:false`
  carries on instead of coming back; `duration` (s); frame `stroke`,
  `strokeWidth`, `radius`. Give tiles the slide's aspect (w/h = deck w/h) —
  the cover is contained, so other shapes letterbox. Don't put a `link` on a
  tile (the click is the zoom). See the Summary Zoom recipe.

## The rules that make decks feel designed

- **Morph = shared ids.** Slides with `"transition": "morph"` tween any
  elements whose `id` matches the previous slide — position, size, color,
  gradients. This is THE signature move: carry 2–4 ids through the deck and
  rearrange them per slide. Generators must emit deterministic ids.
- **`morphId` decouples morph identity from `id`.** The real pairing key is
  `morphId || id`, so an element can keep whatever `id` it likes and set
  `"morphId": "running-head"` to morph against a differently-named element on
  the next slide. For a generator this beats threading one id by hand through
  every slide, and it lets two independently-created elements pair up. The key
  must be unique **within** a slide. Plain shared `id` still works and is still
  the simplest thing when you control both slides.
- **Entrances**: `fx: { enter: "fade-up", order: 0 }` — equal `order` =
  simultaneous. On a **morph arrival** the rule is per element, and it turns on
  whether that element has a morph partner on the previous slide:
  - **has a partner** → it morphs, and `fx.enter` and `fx.countUp` are both
    skipped. It is already in motion and already showing its number; an
    entrance would fight the tween and a count-up would restart from zero.
  - **no partner** → it is new to the slide, so both run normally. Without an
    `fx.enter` it gets an automatic fade-and-rise so nothing ever just pops in.

  So a headline number, or a panel that sweeps in from the right, is fine on a
  morph slide — just make sure it is new to that slide.
- **Click builds** (multi-step slides, PowerPoint-style): `fx: { step: 1 }`
  brings an element in on the first **click** (→ / space / swipe) instead of with
  the slide; `step: 2` on the second, and so on. Equal steps arrive together;
  gaps are compressed (steps 1 and 3 are two clicks). `exitStep: 3` takes it out
  again on that click (`exit: "fade|fade-up|slide-left|…"`, `exitDur`) — it must
  be after `step`. For a bulleted text box, `byParagraph: true` reveals one
  paragraph per click starting at click `(step ?? 1)` (`step: 0` shows the first
  paragraph with the slide); paragraphs are the top-level `<div>`/`<p>`s or
  `<br>`-separated lines — blank lines don't count. The `enter` effect (default
  a fade) and `enterDur` style the arrival. `order` is **not** a click order:
  inside one click it only staggers (equal = together).
  - ← steps back through the clicks instantly; ← from the next slide lands on
    the finished state. The speaker view shows "click 2/4" and previews the next
    *click* before it previews the next slide.
  - Print/PDF, thumbnails, the editor canvas and `review_slide` stills show
    **every** element — builds only gate content while presenting.
  - Don't put a `step` on an element that **morphs in** (validate warns): it is
    already on screen when the slide arrives. Elements not yet clicked in never
    pair for a morph, and ones already clicked out don't morph away.
  - Hover-revealed (`showOnHover`) and `hidden` elements take no part.
  - Old viewers ignore these keys and show everything at once, so no `requires`
    entry is needed.
- **Ken-burns**: `fx: { ambient: "kenburns", ken: { dir: "drift|out|in",
  scale: 1.08, duration: 20 } }` — `drift` loops, `out`/`in` settle once on
  slide entry. For full-bleed photos: image at 0,0,1280,720 + a scrim rect
  + text on top. Never combine entrance tweens with motion-path loops.
  Motion-path routes are drawn as a faint dotted trail in PDF/print/static
  output; set `loop.trail: false` to hide it.
- **Loops**: two shapes, both under `fx.loop`.
  - `{ type: "dash-march", distance: 18, duration: 1.4 }` — marches the stroke
    dashes along a shape. It animates `strokeDashoffset`, so it needs a
    `stroke` **and** a dash pattern: set `strokeStyle: "dashed"` or `"dotted"`.
    On a solid stroke the tween still runs and there is nothing to see. A
    **negative** `distance` reverses the march (put it on arrows pointing the
    other way). Animations never show in `review_slide` stills, so don't claim
    you watched them play — say they will animate in present mode.
  - `{ type: "motion-path", path: "M0,0 C60,-40 140,40 200,0", duration: 6,
    delay: 0, ease: "none", speeds: [1, 1] }` — drifts the element along a
    path given RELATIVE to its resting position (the first anchor is where it
    sits). `speeds` is optional, one multiplier per on-curve point, and lets
    the element dwell in places and rush others; omit it for constant pace.
    Never put an entrance tween on a motion-path element — they fight over the
    same transform.
- **Generic loops**: `fx.loop: { type: "pulse" | "spin" | "float" | "blink" | "wiggle",
  duration, amount, delay }` — `duration` is ONE FULL CYCLE in seconds; `amount`:
  pulse = extra scale (0.08 = +8%), float = px up, blink = how far opacity dips
  (0..1), wiggle = degrees each side, spin = degrees per revolution (negative =
  counter-clockwise). Defaults: pulse 1.6 s/0.08, spin 8 s/360, float 3 s/10,
  blink 1.2 s/0.7, wiggle 0.9 s/4. They wait for the element's entrance to finish,
  spin/wiggle ADD to the element's own `rotation`, and a loop on a click-built
  element starts when it arrives. One `fx.loop` per element; pulse + Ken Burns
  both drive scale (validate warns). Reduced motion turns loops off.
  `origin: "bottom"` (or `top`/`left`/`right`, default `center`) moves the point
  spin/wiggle/pulse turn or grow around: a wiggle with `origin: "bottom"` sways
  like a plant in the wind.
- **States of one drawing**: an existing `svg` may carry `vars` (`{"leaf":
  "#c8641e", "snow": 0}`) that its artwork reads as `var(--leaf)`. To show the
  same drawing in another state on the next slide, keep its `id` and `asset`,
  change only `vars`, and use the `morph` transition — numbers and colours
  blend. You may set `vars` on artwork already in the deck; you still never
  author svg markup.
- **"GIF" slides**: `slide.autoBuild: { every: 1.5, hold: 2, loop: true }` plays the
  slide's click builds by themselves (one every `every` s, `hold` on the last, then
  start over if `loop`); a slide with no builds just replays its entrance. → / ←
  leave such a slide instead of stepping it.
- **Kiosk decks**: `doc.present.autoAdvance: 8` (seconds) moves the show on by
  itself — a click build counts as an advance — and `slide.advanceAfter` overrides
  it per slide. `doc.present.loop: true` makes Next on the last slide wrap to the
  first. Any key or click restarts the countdown; the speaker view shows it.
- **Interactivity**: element `link: "<slide-id>"` jumps on click; a slide
  with `stateOf: "<parent-id>"` is a hidden variant reached only by links
  (arrow keys skip it, ← returns to parent). Give clickable things a padded
  transparent rect as the hit target, not the text itself.
- **Hidden slides**: `"hidden": true` keeps a slide in the deck and out of the
  show — arrow keys skip it, PDF export leaves it out, and it is never the
  file's thumbnail — but an element `link` still reaches it. That is what it is
  for: backup and appendix material you jump to only if asked. By default a
  hidden slide does not consume a page number either, so `{{page}}`/`{{pages}}`
  stay contiguous for the audience; set `present.numberHidden: true` for the
  office-suite behaviour where it keeps its number.

  Not the same as `stateOf`. A state is a variant OF another slide (← returns
  to its parent, and it morphs with it); hidden carries no such relationship.
  Use a state for "click to drill into this", hidden for "only if they ask".
- **Numbers count up** with `fx: { countUp: true }`.
- **Speaker notes** (`notes`) are part of the document — write them; they
  make a layout (a template file) teach itself.

## Layout guardrails

- Canonical canvas 1280×720 (`doc.size` can differ — read it first).
- Keep 96 px side margins (right-most content x ≤ 1184).
- **Column arithmetic, already done.** On 1280×720 inside 96 px margins the
  content band is 1088 px wide. Use these rather than computing your own:

  | Split | Width | `x` positions | Gutter |
  |---|---|---|---|
  | 2 columns | 528 | 96, 656 | 32 |
  | 3 columns | 340 | 96, 470, 844 | 34 |
  | 4 columns | 254 | 96, 374, 652, 930 | 24 |
  | 60 / 40 (text + image) | 624 / 432 | 96, 752 | 32 |

  Every row ends flush at x = 1184. Vertically, a title band of `y:72 h:84`
  over content starting at `y:208` leaves 416 px of content height above a
  96 px bottom margin.
- One accent color; 2 typefaces max. `theme` sets deck defaults.
- Fonts: `doc.fonts` (`{family, asset, weight}`) + woff2 data URIs in
  `doc.assets` if you need embedded faces; otherwise stick to system stacks.
  **A `fontFamily` naming a face the document does not carry falls back
  silently** to the next entry in the stack — there is no warning, and worse,
  it will usually look right to *you*, because you are the one with the
  typeface installed. Everyone else gets the fallback. `validate()` reports
  this (`font-not-embedded`) precisely because you cannot see it locally.
  Fonts belong to the DOCUMENT, not the app:
  Instrument Sans and Fraunces appear in the example decks and in several
  layouts because those files embed them in their own `doc.assets`, not
  because the app provides them. So either embed the woff2 yourself, start from
  a template that already carries the face, or name a system stack and mean it.
  Always write a full stack (`"'Fraunces', Georgia, serif"`), never a bare
  family name.

## Layouts and `role`

**Words.** The app's UI calls a whole reusable template file (`template: true`)
a **layout**, and one `doc.layouts` entry a **slide type**. The format keeps
its own field names (`template`, `templateId`, `layouts`, `layoutId`) — when a
user says "layout" they usually mean the file; read "slide type" as a
`doc.layouts` entry.

`doc.layouts` is a supported top-level key: an array of Slide-shaped slide
types the editor offers under *Change slide type…*. Every deck also gets five built-ins
(`layout-title`, `layout-title-content`, `layout-two-col`, `layout-section`,
`layout-blank`), which are scaled to the deck's `doc.size` when applied.

The part that matters when you are generating a deck is **`role`**. Any text
element can carry `"role": "title" | "subtitle" | "body" | "kicker"`. Applying a
layout matches donor to target by `id` first and then by `role` + `type`, so
roles are what let someone restyle your deck later without re-typing it —
content rides across, the layout supplies frame and typography. Setting them
costs one key per element and makes a generated deck feel native to the editor.

Two smaller things: a layout's text elements use `placeholder` (a dimmed prompt
shown in the editor, hidden in present and print) rather than `html`, and
slides instantiated from the same layout keep their element ids — which is
exactly why their furniture morphs across a transition.

## Dynamic fields (tokens in text `html`)

Put these tokens in any text element's `html`; they resolve at render time (the
model keeps the raw token, so numbering/props update automatically):
`{{page}}`, `{{pages}}` (position among non-state slides; zero-pad with
`{{page:2}}`→"06"), `{{title}}`, `{{date}}`, `{{time}}`, and the document
properties `{{author}}`, `{{company}}`, `{{subject}}`, `{{event}}`. Set the
props in an optional top-level `"meta": {author, company, subject, event,
keywords}` object — great for title slides and footers that fill from one place.

## Inline math (`$…$` in text and table cells)

Text `html` and table cell `html` typeset LaTeX between dollar signs at render
time: `$…$` inline, `$$…$$` display. The model keeps the source, so write it
as you would in LaTeX — e.g. `"html": "The roots are $x_{1,2}$ of $ax^2+bx+c=0$."`.
Rules: no space just inside the `$` delimiters (`$ x $` stays prose), no digit
right after the closing `$` ("costs $5 and $10" stays prose), `\\$` (in JSON)
for a literal dollar. `<` inside math is written `&lt;` in html (it is html)
and reaches TeX as `<`. Invalid TeX is left as typed. Use a **math** element
for a standalone display formula; use `$…$` when the formula is part of text.

## MCP verb notes (desktop app)

The tool descriptions are kept short because they stay in Claude's context
for the whole session. The details behind them:

- **`icons`** — the icon library the user configured in Settings ▸ Icon
  library (an icon server or a local folder). `search` with one or two short
  nouns per concept ("cloud", "shield", "team"; a folder matches file names
  only, so try synonyms) returns refs like `i3`, valid for the editor
  session; `insert` fetches one and adds it as an ordinary `svg` (or `image`)
  element, square at `size`, through the same sanitizer as a paste. Icons keep
  their own colours (no recolouring yet) — check they read on the background.
  When the library is not set up or unreachable, the error says so: tell the
  user, and fall back to simple shapes rather than hand-written SVG. A folder
  with an `icons.json` (an exported icon set) also matches its names and
  keywords.
- **Icon sets** — when `doc_info` says `kind: "iconset"`, the document IS an
  icon set: one icon per slide, the slide `name` is the icon's name and
  `slide.icon.prompt` what it shows (`outline` lists both). `doc_info.iconset`
  gives the grid (`grid` × `gridH` units, 24 × 24 unless the set picked
  another aspect ratio), the one style every icon shares and
  `pathElement`, a complete path element in that style drawn on the whole
  canvas with the grid as its `pathBox` — so `d` is written in grid units.
  `doc_info.iconset.examples` (when there) are icons the user likes, as SVG
  text from other libraries: draw LIKE them (line weight, corner rounding,
  amount of detail, proportions) with your own paths, never copies.
  Asked for icons in the user's own words, PLAN first: one `icons` call, op
  `plan`, with `[{name, prompt, keywords}]` — it creates empty, named icons
  and draws nothing; the user reviews them and presses Draw with AI.
  Draw icons only from copies of it (new `id` and `d`): every point inside
  `paddingBox`, whole or half units, few simple shapes; a solid detail is a
  path with the ink as `fill` and a transparent stroke. No text, pictures or
  svg. Check each with `review_slide`. The user exports the set as SVGs with
  the ink as `currentColor`; "Apply set style" corrects stroke drift, so keep
  to the style rather than fighting it. Give every path an `iconPart`
  (`body` = the main closed silhouette, `detail` = inner lines and dots,
  `accent` = at most one small closed highlight): the set's extra styles
  (`doc_info.iconset.variants` — solid, colour, comic, sticker, badge …)
  repaint the same drawings part by part. When the user describes a look,
  add it with ONE `icons` call, op `style` (name, weight, colour, part fills,
  only the extras asked for); never redraw icons for a style. A style only
  repaints: a look that needs other shapes (hand-drawn, more detail) is a
  change of the drawing style (brief, examples) and a redraw. A comment
  carrying `style` (in `comments`) is about the icon as painted in that style:
  change only that icon there with op `tweak` (its shapes' own fill, line
  colour, or hidden in that style), every icon with op `style`.
- **`update_element`** — shallow-merges `props` into one element. Each key is
  checked against that element type's known keys and value rules (the same
  checks a paste goes through); one bad key refuses the whole call. `null`
  removes an optional key; a required one (e.g. a text's `html`) cannot be
  removed. An image's `crop` of the whole picture (`{x:0,y:0,w:1,h:1}`)
  cuts nothing and is read as removing the crop, like `null`. `id` and `type` are fixed. `html` and table cell html are
  sanitized. One undo step. Nested objects (`style`, `option`, `fx`) are
  replaced whole, not merged.
- **`propose_variants`** — up to 6 full replacement slides (same shape as
  `write_slide`, `slide.id` must equal `slideId`), each checked on its own;
  an invalid one is dropped, not the whole call. Nothing is applied until
  the human picks one in the picker; the call returns `{ok, count}` at once
  and you never learn which, if any, they chose — do not wait or poll.
  There is ONE pending slot: a new call before they pick discards the
  earlier set (they are told).
- **`apply_change_pattern`** — looks up `sourceElementId`'s most recent
  change (the log `recent_changes` reads) and copies its changed fields onto
  each listed target of the same type (and shape kind). `id`, `morphId`,
  `groupId`, position and `type` are never copied; a target of another type
  lands in `skipped`, not an error. There is no "find similar": decide the
  targets yourself from `outline`/`get_slide`. One undo step for the batch.
- **`create_slide_type`** — `sourceId` must be an existing slide type (never
  a built-in layout). `parent` starts EMPTY and always shows `sourceId`'s
  design; `basis` is a one-time copy with fresh element ids.
- **`slide_type`** — `reorder` moves among siblings (same parent) only; `to`
  is a 0-based sibling index, clamped. `move` reparents: with `parentId` the
  type INHERITS the new parent (its look changes); `null` makes it top level
  and drops what it inherited (an empty child becomes blank — `detach` first
  to keep the look). `beforeId` places it before that sibling, else last.
  Its children move with it, linked slides resync at once, and moving a
  type into its own subtree is refused. `detach` copies the inherited
  content in, then removes the parent link. `relink {slideId}` makes that
  DECK slide follow `layoutId` from now on (re-applied at once: content
  moves by id, then role; nothing is deleted); `layoutId: null` unlinks it
  and keeps its look. It returns `verdict` (`fit`, or `partial` when
  `floating` lists content that found no placeholder and now sits on top of
  the layout) — check `floating` before calling it done. `outline` shows
  each slide's current `slideType`.
- **`render_preview`** — captures only the slide already on the editing
  canvas; there is no offscreen renderer. `slideId` asserts, it does not
  navigate. The image is cropped to the slide (no editor chrome).
- **Layout guard (every write verb and `write_slide`)** — after your change,
  in the same undo step, the app runs `slides/src/layoutguard.ts` on that
  slide: (1) a changed text box that fitted before and no longer does grows to
  its measured height (its `valign` edge stays put); (2) a RESIZE pushes or
  pulls what is stacked after it in the same column/row so the old gaps stay
  — an evenly spaced row is instead re-spaced inside its original span, and a
  card that held the edited text grows with it. A pure MOVE is taken as
  deliberate and reflows nothing; (3) connectors re-route, and a free line
  that touched a box that moved follows it (and is attached with `from`/`to`
  when its end sat on a side midpoint); (4) new partial overlaps involving
  what changed are reported with a suggested frame. Lines, page chrome
  (footers, page numbers) and full-bleed backdrops are never moved. A push
  that would leave the canvas is not made (`layout-no-room`). The response
  carries `layout: {adjusted, issues}`, shown as the `↻`/`⚠ LAYOUT` banners.
  Pass `reflow:false` to place exactly what you wrote; issues are still
  reported.
- **`check_layout({slideId, elementIds?})`** — the same checks on the slide
  as it is, without a "before": any partial overlap (containment, such as
  text on a card, is fine), overflowing text, text off the canvas. Returns
  `clean` or one line per issue.
- **`review_slide({slideId})`** — for the design pass after an edit: the
  slide's screenshot (cropped to the slide), one line per element
  (`id type @x,y wxh "text"`, connectors as `from→to`) and the
  `check_layout` result. A deck slide that is not showing is navigated to
  first; a slide type or object must be the open surface.
- **`write_slide` warnings** on a reusable object or slide type carry only
  the text-overflow check; `validate()` otherwise scans deck slides.

## Parallel sessions (desktop app)

The desktop app's terminal panel can host **several parallel Claude Code
sessions at once** (a tab strip, one `claude` process per tab) against the
**same open document**. Every write funnels through the one document Store,
so sessions may even work on the **same slide**: each write is its own undo
step and nothing is refused. The sidebar badge simply shows which session
wrote a slide last. There is no merge engine — if another session may be
editing the slide, `get_slide` again before a larger edit, and if a human
divided the work ("you take slides 1-5"), stick to your share.

## Gotchas

- Escape `<` as `\u003c` anywhere in the JSON when writing the file block.
- Don't invent property names — unknown keys are ignored, so a typo means
  your styling silently doesn't apply.
- `docId` is the document's identity — never regenerate it when editing.
- `readonly: true` makes a PLAYER file — it boots straight into the
  presentation with no editor. Set it only on hand-out copies.
- If `template: true` is set, every open mints a fresh document (that's for
  distributable templates — what the app calls a *layout*; remove it for a
  personal deck).
- Charts degrade gracefully but anything outside the list in the **chart**
  element type above is ignored, with no warning — keep options minimal and
  check the rendered slide rather than trusting the JSON.
- **Media size**: embedding a large video as a data URI can push the file into
  the tens of MB and make it slow to open and save. Embed only short clips;
  otherwise host the file and put its URL in `media.src`.

Working examples of everything above: this repo's starter library
(`scripts/build-starter-library.mjs`) — open the built `.beeslides.html`
and read its JSON block. For decks that move, read the generators behind
[docs/examples](examples/README.md): `scripts/lib/bee-deck.mjs` (an
explainer using morph, a state, builds, count-up, loops, motion paths, an
equation, a chart, a table and zoom tiles) and `scripts/lib/lake-scene.mjs`
(a living scene: loops on elements that also morph between slides).
