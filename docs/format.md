# The `slidomingo/slides` document format

*Normative reference for the JSON document model, current as of BeeSlides
**v1.0.0** (format version `1`). The authoritative source is
[`slides/src/model.ts`](../slides/src/model.ts) — this document tracks it. If
the two disagree, the code wins; please file that as a docs bug.*

A `.beeslides.html` file carries one JSON document inside a single plaintext block:

```html
<script type="application/slidomingo+json" id="slidomingo-doc">
{ "format": "slidomingo/slides", "version": 1, ... }
</script>
```

Everything else in the HTML file is the fixed *shell* (the runtime, styles,
license notices). The document block is the only part that changes between
saves. See [architecture.md](architecture.md) for how the file is built and
saves itself; this document specifies the JSON.

This spec is for people writing tools, generators, or agents against the
format. If you want to *author a good-looking deck*, read
[agents.md](agents.md) — it maps content to the right feature. This one is the
dry reference of every field.

---

## Conventions

- **Coordinates** are pixels in the slide space defined by `doc.size` (default
  `1280 × 720`, a 16:9 canvas). `x,y` is an element's top-left corner.
- **Colors** are any CSS color string, including `rgba(...)` for alpha.
- **Angles** are degrees. Rotation is clockwise. Gradient angles follow the CSS
  convention (`0` = bottom→top, `90` = left→right).
- **Ids are identity.** Elements that share an `id` across adjacent slides
  *morph* into each other; slide `stateOf` and element `link` both reference
  slide ids. Generators must emit deterministic, stable ids.
- **Additive & forward-compatible.** Unknown fields are preserved through
  parse → serialize. Old files must open in newer shells. Never repurpose or
  remove a field; add optional ones.
- **Pure data.** Text HTML is sanitized to an inline whitelist; chart options
  are pure JSON (no functions). A document can never carry executable code —
  except through the [`embed`](#embed) element, the one sandboxed exception
  (see invariant 3).
- **Self-contained.** Everything a view needs is in the file. External
  references (image/media URLs) are allowed but break the offline guarantee;
  embedded `data:`/`asset:` sources keep it intact.

When writing the JSON into the file block, **escape every `<` as `\u003c`** so
the string `</script>` can never appear and terminate the block.

**Asset-store refs.** In a saved plaintext file, any string holding embedded
bytes (`doc.assets` values, an image `src`, a video `poster`, …) may instead be
`"slidomingo-store:sha256-<16 hex>"`: a reference to the same bytes stored once
in the file's `<style id="slidomingo-assets">` (or on the static layer's media
element), and the file then lists `"asset-store"` in `requires`. The id is
`sha256-` + the first 16 hex digits of the SHA-256 of the `data:` URI's UTF-8
text. A reader resolves refs from the file before using the document; a tool
editing the JSON in place must keep refs and the store exactly as they are, and
may add new pictures inline as `data:` URIs — the next save stores them. A ref
the file cannot resolve is kept, never dropped.

**Readable text.** A plaintext doc block is written indented (two spaces) with
a content-only key order: `format`, `version`, `requires`, `docId`, `title`
first, then `id`, `type`, `name` on any object, then the rest alphabetically.
Readers must not depend on key order or whitespace; writers may emit compact
JSON — the next save reformats it. *Copy document JSON without pictures*
produces the same shape with every embedded `data:` string replaced by its
ref; *Replace from JSON* (and `loadDoc`) put the bytes back from the open
document by hash.

---

## Top-level: `SlidomingoDoc`

| Field | Type | Required | Notes |
|---|---|---|---|
| `format` | `"slidomingo/slides"` | yes | Format discriminant. Check it before editing. |
| `version` | `number` | yes | Format version. Current: `1`. |
| `docId` | `string` (uuid) | yes* | Stable per-document identity, minted at creation. **Never regenerate it.** *Minted on load if a pre-`docId` file lacks one. |
| `title` | `string` | yes | Deck title; also synced to the HTML `<title>`. |
| `size` | `{ width, height }` | yes | Slide coordinate space in px. Default `1280 × 720`. |
| `theme` | `Theme` | yes | Deck-wide defaults (see below). |
| `slides` | `Slide[]` | yes | Linear order; state slides sit right after their parent. Must be non-empty. |
| `modified` | `string` (ISO) | yes | Last-modified timestamp. |
| `present?` | `{ slideNumber?, controls?, progress?, numberHidden?, morphSeconds?, autoAdvance?, loop? }` | no | Present-mode Reveal chrome toggles. `autoAdvance` (seconds) = kiosk: the show moves on by itself (a click build counts as an advance; any key/click restarts the countdown); `loop` = Next on the last slide wraps to the first. |
| `assets?` | `Record<string,string>` | no | Shared blobs (raw SVG markup or `data:` URIs), referenced by key as `"asset:<key>"`. |
| `fonts?` | `Array<{ family, asset, weight?, style? }>` | no | Embedded `@font-face`s injected at boot; `asset` is a key into `assets` (a woff2 data URI). |
| `layouts?` | `Slide[]` | no | Slide-shaped templates (see [Layouts](#layouts)). Absent = the built-in starter layouts are offered. |
| `masters?` | `Master[]` | no | Slide masters — see [Masters](#masters). Absent until the Layout Manager is first used. |
| `defaultLayoutId?` | `string` | no | Id into `doc.layouts` — the slide type offered when a new slide is created with no explicit choice. Doc-wide, not master-scoped. |
| `meta?` | `{ author?, company?, subject?, event?, keywords? }` | no | Document properties for the `{{author}}`/`{{company}}`/`{{subject}}`/`{{event}}` template fields, plus general provenance. Absent = those tokens resolve empty. |
| `template?` | `boolean` | no | Template file: every open mints a fresh `docId` (see [File modes](#file-modes)). |
| `templateId?` | `string` | no | Template files only: the template's identity (uuid), minted by `stampAsTemplate`, kept across updates and renames. Absent on a legacy template until its first update. |
| `templateSamples?` | `boolean` | no | Template files only: `false` = `slides` is one placeholder starter slide (the template is design only); absent/`true` = `slides` are sample slides a new deck may include. |
| `basedOn?` | `{ templateId?, name? }` | no | Decks only: the template this deck was started from — its `templateId`, and `name`, the template's filename-derived name (the fallback key for a legacy template without an id). Provenance only; nothing renders from it. |
| `readonly?` | `boolean` | no | Player file: boots straight into the presentation, no editor. |
| `requires?` | `string[]` | no | Format features a reader must understand to write this file back (see [Format invariants](#format-invariants-do-not-break), 7). `"asset-store"` = the file holds asset-store refs (above). `"rich-text"` = some text or table-cell `html` holds links, lists or styled runs (an older reader would strip them on save). `"table-merge"` = some table cell carries a `colspan`/`rowspan` above 1 (an older reader would draw the grid unmerged and save it that way). Never add or remove a name by hand. |

### `Theme`

| Field | Type | Notes |
|---|---|---|
| `background` | `string` | Default slide/canvas background. |
| `color` | `string` | Default text color. |
| `accent` | `string` | Single accent color; also seeds derived chart palettes. |
| `fontFamily` | `string` | Default body font stack — the ultimate fallback under every master's own font. |
| `headingFamily?` | `string` | Default heading face (`role:'title'` elements only). Absent = headings use `fontFamily`. |
| `chartPalette?` | `string[]` | Ordered series colors for new charts. Absent = derived from `accent`. |
| `table?` | `Partial<TableStyle>` | Defaults for newly inserted tables. Omitted properties use the standard table style; existing tables retain their own `style`. |

### `Master`

One layout *family*'s shared building blocks + cascading fonts — the closest
analogue to PowerPoint's Master → Layouts → Slides tree this format has.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable master id. `Slide.masterId` (on a `doc.layouts` entry) references it. |
| `name?` | `string` | Friendly label (Layout Manager's master switcher). |
| `buildingBlocks` | `Slide` | Shared elements composited underneath every slide type that uses this master (and every slide built from one). Slide-shaped purely for renderer/editor reuse — only `elements` is meaningful. |
| `fontFamily?` | `string` | Body font for every slide under this master. Wins over `theme.fontFamily`, loses to an element's own explicit `fontFamily`. |
| `headingFamily?` | `string` | Heading font (`role:'title'` elements only) for every slide under this master. Wins over `theme.headingFamily`. |

A `doc.layouts` entry's `masterId?: string` says which master governs it;
unset (or pointing at a deleted master) resolves to `doc.masters?.[0]` — so a
single-master document needs zero configuration, and a dangling reference is
tolerated rather than treated as an error. A real slide's font follows its
linked layout's master via `slide.layoutId`; a slide with no linked layout
falls back to `doc.masters?.[0]`. Font resolution order for one text/code
element: its own `fontFamily` → the governing master's matching font →
`doc.theme`'s matching font (heading tier preferred first at each step, for
`role:'title'` elements only).

---

## `Slide`

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | `string` | yes | Stable slide id. Link + morph targets reference it. |
| `background` | `string` | yes | Slide background (CSS color). |
| `transition` | `TransitionKind` | yes | `none \| fade \| slide \| zoom \| morph \| push \| wipe \| cover \| split`. `morph` tweens matched element ids from the previous slide. `push`/`wipe`/`cover`/`split` are drawn by the player; an older reader plays them as a crossfade. |
| `transitionDir?` | `string` | no | Direction of a `push`/`wipe`/`cover` (the side the slide comes from: `right` (default) \| `left` \| `bottom` \| `top`) or a `split` (`vertical` (default) \| `horizontal`). Ignored for other kinds. |
| `elements` | `SlideElement[]` | yes | **Array order = paint order (z).** First element is at the back. |
| `notes` | `string` | yes | Speaker notes (travel in the file; shown in speaker view). |
| `name?` | `string` | no | Friendly label for link pickers / state badges. |
| `stateOf?` | `string` | no | Marks this slide a hidden *state* variant of the slide with this id (see [Interactive states](#interactive-states)). |
| `autoBuild?` | `{ every, hold?, loop? }` | no | "GIF" slide: its click builds (`fx.step`…) play by themselves, one every `every` seconds, `hold` seconds on the last, then start over if `loop`. → / ← leave the slide. |
| `advanceAfter?` | `number` | no | Kiosk: seconds this slide stays up before the show advances (overrides `present.autoAdvance`). |
| `hidden?` | `boolean` | no | Out of the show: skipped by navigation, left out of the PDF and the file thumbnail, still editable and reachable by an element `link`. Hidden slides directly after a normal slide are its *extras* — see [Extra slides](#extra-slides). Absent = visible (never written as `false`). |
| `excludeFromNumbering?` | `boolean` | no | Skip this slide's own page number only; the slide stays visible, navigable and in the PDF. |
| `layoutId?` | `string` | no | Meaningful on a real slide: the `doc.layouts` entry this slide was instantiated from and stays live-linked to (see [Layouts](#layouts)). |
| `masterId?` | `string` | no | Meaningful on a `doc.layouts` entry: which `doc.masters` entry governs it (see [Masters](#masters)). |
| `hover?` | `{ type, dim?, default? }` | no | Present-mode hover behaviour: `type: 'focus-group'` (dim elements outside the hovered group) or `'reveal'` (`showOnHover` set swap; `default` names the resting set). |
| `comments?` | `Comment[]` | no | Review threads. Editor-only — never rendered in present/print, but saved in the file. |

### `Comment`

`{ id, author, text, at (ISO) }` plus an optional anchor and thread:

- Anchor: `elementId?` (thread pinned to an element), or `x?`/`y?` (a point in
  slide coordinates), or neither/dangling (the whole slide).
- `resolved?: boolean`; `replies?: Array<{ id, author, text, at }>`.

`window.slidomingo.comments()` returns the flat, typed-anchor list — the entry point
for tooling that processes flagged issues in a deck.

---

## Elements

Every element carries the common `ElementBase` fields, plus type-specific ones.

### `ElementBase` (shared by all)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Identity. Shared ids across adjacent slides morph. |
| `x, y, w, h` | `number` | Frame in slide px (top-left origin). |
| `rotation` | `number` | Degrees, clockwise. |
| `opacity` | `number` | `0..1`. |
| `shadow?` | `ShadowSpec \| ShadowSpec[]` | Drop shadow(s): `{ x?, y?, blur, color }`. An array stacks (e.g. elevation + glow). Follows the element's alpha shape. |
| `flipH?`, `flipV?` | `boolean` | **`shape`, `image`, `svg` only.** Mirror the content horizontally/vertically about the frame's centre, before `rotation` applies. The frame (selection box, handles, morph, animation) is unchanged; shadows and reflections are not mirrored. |
| `alt?` | `string` | **`image`, `svg`, `chart`, `media` only.** Text alternative for screen readers (≤ 1000 chars): `alt` on an `<img>`, else `role="img"` + `aria-label` (a live video/audio player gets only the label). `""` = decorative (hidden from assistive tech). Absent = not described yet. Additive; no `requires`. |
| `reflection?` | `{ opacity?, size?, gap? }` | Mirror reflection below the element (CSS `-webkit-box-reflect`): `opacity` 0..1 at the top edge (default .35), `size` 0..1 = fraction of the element mirrored (default .5), `gap` px (default 0). Chromium/Safari only — elsewhere it is simply not drawn. Not exported to SVG. |
| `fx?` | `Fx` | Presentation behaviour — runs in present mode only (see [`fx`](#fx-presentation-effects)). |
| `link?` | `string` | While presenting, clicking jumps to this slide id. |
| `group?` | `string` | Semantic group tag — hover focus + multi-element present behaviours target it. |
| `groupId?` | `string` | *Editor* grouping (select/move as one). Distinct from `group`. |
| `showOnHover?` | `string` | In-slide hover reveal: visible only while an element whose `group` equals this value is hovered (with `slide.hover.type='reveal'`). |
| `role?` | `string` | Layout role (`title`/`subtitle`/`body`/`kicker` by convention) — drives cross-layout content moves. Free-form. |

The element `type` discriminant is one of: `text`, `shape`, `image`, `svg`,
`chart`, `table`, `media`, `code`, `embed`, `math`.

### `text`

`type: "text"` — `html` (sanitized rich-text subset: `b/i/u/s/strong/em/code/br/div/p`,
`span style="color:…;font-size:…"` — colour `#hex`, `rgb()/rgba()` or a palette
slot `var(--sl-accent1)`, size in `px`/`em`/`%` —, links `<a href="…">` with
`http:`/`https:`/`mailto:` only, and lists `<ul>/<ol>/<li>` with a nested list
inside the item it indents under; everything else is stripped at render — see
render.ts `sanitizeHtml`; a file using links, lists or styled runs lists
`"rich-text"` in `requires`),
`fontSize`, `fontFamily`, `fontWeight`, `color`, `align` (`left|center|right`),
`valign` (`top|middle|bottom`), `lineHeight`. Optional `letterSpacing` (px) and
`placeholder` (a dimmed prompt shown while `html` is empty; hidden in
present/print).

Text also resolves dynamic-field tokens at render time — `{{page}}`,
`{{pages}}`, `{{title}}`, `{{date}}`, `{{time}}`, plus the document-property
tokens `{{author}}`, `{{company}}`, `{{subject}}`, `{{event}}` (from
`doc.meta`) — with an optional zero-pad width on page/pages (`{{page:2}}` →
`06`). The model stores the raw token; only the rendered output is resolved,
so numbering re-flows when slides move and doc-property edits update every
slide at once. The editor's Typography panel has an "Insert field…" dropdown
for all nine tokens, and the Layout Manager's Building Blocks tab has a
one-click "Add page-number footer" shortcut.

**Inline math.** `$…$` (text style) and `$$…$$` (display style) in text html
— and in table cell html — typeset LaTeX at render time through Temml
(MathML; `slides/src/render.ts resolveMath`, `src/math.ts`). The model stores
the source exactly as typed, so a reader without math support shows the
literal `$E=mc^2$` and nothing is lost. The rules, as the renderer applies
them:

- `$$…$$` is matched first; then `$…$`, which must have **no whitespace just
  inside either delimiter** and **no digit straight after the closer** — so
  "it costs $5 and $10" stays prose.
- `\$` is a literal dollar sign (the backslash is dropped on render).
- The source between the delimiters is entity-decoded before typesetting
  (`x &lt; y` in the html reaches TeX as `x < y`).
- Invalid TeX is left exactly as typed; trust is off, so `\href`, `\url`,
  `\html…` and `\includegraphics` are refused.
- Formulas morph symbol by symbol between slides whose text elements pair
  (same `morphId || id`).

### `shape`

`type: "shape"` — `shape: rect | ellipse | triangle | arrow | line | path`,
plus `fill`, `stroke`, `strokeWidth`, `radius` (rect corner). Options:

- `fillGradient?`: `{ angle, stops: [{ at: 0..1, color }] }` — linear gradient;
  when set it wins over `fill` (kept as the solid fallback).
- `strokeStyle?`: `solid | dashed | dotted` (wins over legacy `strokeDash?`).
- **line** shapes take their color from `fill`, draw horizontally across the
  box (rotate for vertical), and accept tips `lineStart?`/`lineEnd?` =
  `none | arrow | dot | bar`.
- **path** shapes carry `d?` (SVG path data) authored in the `pathBox?`
  viewBox `[x, y, w, h]`.

### `image`

`type: "image"` — `src` (a `data:` URI or `"asset:<key>"`), `fit`
(`contain|cover|fill`), `radius`. Embed images as `data:` URIs in `doc.assets`
and reference them to keep the file self-contained.

`crop?` — `{x, y, w, h}`, the part of the picture to show, as **fractions of
the natural (unflipped) picture**: `x`/`y` the top-left corner, `w`/`h` the
size, all `0..1` with `x+w ≤ 1`, `y+h ≤ 1`, each side at least `0.01`. That
region is stretched to fill the frame, so keep the frame's aspect equal to the
region's (`w·naturalWidth : h·naturalHeight`) to avoid distortion; `fit` is
ignored while a crop is set. Optional and additive, no `requires`: an older
reader keeps the field but draws the whole picture with `fit` — the editor
writes `fit: "cover"` together with a crop so that fallback is a centred crop
of the same shape.

### `svg`

`type: "svg"` — `asset?` (key into `doc.assets` holding raw SVG markup;
preferred, dedupes) or `markup?` (inline SVG). `css?` is injected inside the
svg and scoped to it at render (hover/focus/animation styles stay contained).
Prefer composing native `shape`/`text`/`path` elements when they can morph;
use `svg` for static artwork/geography.

### `chart`

`type: "chart"` — `option` is a **pure-JSON, ECharts-*shaped*** option object
(the format is ECharts-compatible; the renderer is the in-house `charts-lite`
engine, not ECharts). Static SVG snapshots on the editor canvas / thumbnails /
print; a live interactive instance (tooltips, wheel-zoom, drag-pan) while
presenting.

- `preset?`: `bar | line | pie | scatter` — the panel's re-seed key.
- `source?`: `{ tableId }` — live binding; the chart's labels + series values
  track that table element (data only; styling/axes preserved).

**Chart rules that bite:**

- Bar/line series `data` must be **plain numbers**. `{value, itemStyle}` item
  objects coerce to `0`; only **pie** takes `{name, value}`.
- Color **by series**, not per bar — per-item bar colors are unsupported.
- Formatters are **template strings only** (`{b}`, `{c}`, `{d}`) — never
  functions (they can't serialize).
- **Dual y-axis**: `yAxis` may be an array of two `{type:"value"}` axes; a
  series selects one via `yAxisIndex: 0|1`. Give the second axis
  `axisLabel:{formatter:"{value}%"}` for a percentage scale.
- **Stacking**: bar series and line series (an area is a line with
  `areaStyle`) sharing a `stack` name pile up per category — positives up,
  negatives down; bars pile with bars, lines with lines, per value axis.
- **Horizontal bars**: the ECharts shape — `yAxis: {type:"category", data,
  inverse?}` against ONE `xAxis: {type:"value"}`. The first category sits at
  the bottom (`inverse: true` = top). Stacking works; `dataZoom` and a second
  value axis are ignored.
- Axis `name`s are drawn along their axis (a value axis' name rotated beside
  its labels; a horizontal chart's value-axis name under its labels). A
  vertical chart's category-axis name is not drawn.
- Unknown option keys degrade gracefully (ignored, never fatal).

### `table`

`type: "table"` — a real HTML `<table>` (table-layout fixed), rendered
identically on canvas/thumbnails/present/print.

- `columns`: `Array<{ w }>` — fractional column weights, normalised at render.
- `rows`: `Array<{ cells: TableCell[] }>` where `TableCell` = `{ html, align?,
  color?, bg?, bold?, colspan?, rowspan? }` (`html` is the same sanitized
  rich-text subset as text).
- `header`: `boolean` — treat row 0 as a styled header.
- `style`: `TableStyle` = `{ headerBg, headerColor, zebra?, borderColor,
  borderWidth, cellPadX, cellPadY, fontSize, fontFamily?, color, radius }`.

**Merged cells** (`requires: ["table-merge"]`). The top-left cell of a merged
block — its *anchor* — carries `colspan` and/or `rowspan` (whole numbers ≥ 2;
absent means 1, and `1` is never written). The cells it covers **stay in the
grid**: every row keeps one cell per column, so `rows[r].cells[c]` still
addresses grid position (r, c) and an older reader still sees a rectangular
table with all its text. Covered cells are not drawn and not edited; the
editor empties them on merge (`{ "html": "" }`), and their contents are
ignored when a file has any. Which cells are covered is derived from the
spans, never stored. Readers apply the spans in reading order (row by row,
left to right): a span is clamped to the grid, then shrunk until it covers
no cell an earlier anchor already covers, and a span on a covered cell is
ignored — so any file lays out as a partition of the grid into rectangles
(`slides/src/tablespans.ts tableLayout`; writers emit that normalised form).
A file whose cells use a span declares `requires: ["table-merge"]`.

Importers (e.g. PowerPoint `a:tc@gridSpan`/`@rowSpan`) emit the anchor's
spans and keep every continuation cell (`hMerge`/`vMerge`) as an ordinary,
empty cell in its grid position.

Cohesion lives in `style`; cells carry only overrides. Morphs as a box —
cell *content* does not morph.

### `media`

`type: "media"` — `kind: video | audio`, `src` (a `data:` URI = embedded, an
external URL / relative path = referenced, or `"asset:<key>"`). Video also
takes `poster?` (`data:`/`asset:`/URL), `fit?` (`contain|cover|fill`),
`radius?`. Playback flags: `controls?`, `autoplay?`, `loop?`, `muted?`.

- **Autoplay fires only in present mode** (never on the canvas or in
  thumbnails), and browsers require `muted: true` for a video to autoplay — so
  `defaultMedia` mutes video by default.
- Embed only **short** clips. The editor warns above `MEDIA_EMBED_BUDGET`
  (8 MB) and offers a URL instead — a big data URI makes the file slow to open
  and save.

### `code`

`type: "code"` — a syntax-highlighted, morph-aware code block. Shares
`text`'s typography subset (`fontSize`, `fontFamily`, `align`, `valign`,
`lineHeight`, `color`) plus:

- `content`: the raw code, **plain text** (never HTML — rendered into a
  `<pre>`, not sanitized as markup because it never carries markup).
- `grammarAssetId?`/`grammarName?`, `themeAssetId?`/`themeName?`: reserved
  for a future signed-extension syntax-highlighting tier; the current
  renderer always uses its built-in zero-cost 7-colour tokenizer keyed by
  `grammarName` and ignores the asset ids.

Tokens morph line-by-line across slides that share the element's `morphId ||
id` (a Heckel diff over `content`, keyed by that group) — carrying a code
block's identity across an edit/highlight sequence travels individual lines,
not just the box.

### `math`

`type: "math"` — a typeset equation: LaTeX rendered to MathML by Temml at
render time, the same engine as inline `$…$`, as a box of its own.

- `tex`: the raw LaTeX **without** `$` delimiters and **without** entity
  escaping (write `a < b`, not `a &lt; b`). Required. Empty = the editor
  shows a dim placeholder; present/print show nothing. Invalid TeX renders
  as its source (monospace, wavy underline) so it can be found and fixed;
  `validate()` reports it as `math-parse-error` (and an empty one as
  `math-empty`). Capped at 16 KB (`LIMITS.tex`).
- `fontSize`, `color`, `align` (`left|center|right`), `valign`
  (`top|middle|bottom`) — as on `text`.
- `inline?: true` — text style (`\textstyle`: compact fractions, limits beside
  big operators). Absent = display style.

The formula sits in an inline-block box aligned by `align`/`valign`; it is not
clipped, so size the frame to fit (the editor fits the height to the formula
and only ever grows the width). Equations morph symbol by symbol across slides
that share the element's `morphId || id`. **No `requires`**: an older reader
keeps the element when it saves and draws an empty box; an older build's
clipboard intake drops it on paste.

### `embed`

`type: "embed"` — arbitrary author HTML/JS/canvas, run inside a **sandboxed
iframe**. This is the one deliberate escape hatch from the closed element
set, for widgets a typed shape can't express (a live canvas sketch, a small
game, a third-party embed snippet) — see the invariant note below.

- `html`: a full HTML document (or a fragment), capped at 64 KB
  (`LIMITS.html`). Set as the iframe's `srcdoc` **DOM property**, not
  string-built markup, so there is no attribute to break out of — but unlike
  `text`/`table` html, it is **not content-sanitized** (no inline
  tag/attribute whitelist). Safety comes entirely from the sandbox, not from
  filtering at write time.
- The sandbox is fixed at exactly `allow-scripts` — never
  `allow-same-origin`, `allow-forms`, `allow-popups` or
  `allow-top-navigation`, and never taken from the model. The content gets a
  null/opaque origin: it can run script and draw, but cannot read this
  document's cookies/localStorage/DOM, submit a form, navigate the parent, or
  open a popup.
- Inert everywhere except present mode (editor canvas, thumbnails, the
  static first-page preview, and print all substitute a plain placeholder
  glyph — an embed never mounts a live, scripted iframe outside a real
  presentation).

### `zoom`

`type: "zoom"` — PowerPoint's Slide / Section / Summary Zoom: a live
thumbnail tile of another slide or section. While presenting, clicking the
tile (or Enter on it — it is a focusable button) moves the camera into it,
plays its range, and zooms back out to this slide at the click it was left on.

- `target`: `{ "slide": "<slide id>" }` or `{ "section": "<section id>" }` —
  exactly one. The tile shows the target slide, or the section's first slide.
  Not required by the paste validator: a tile whose target is missing stays
  and renders as an empty box (the editor labels it "Zoom target missing";
  `validate()` reports `zoom-missing-target`).
- `range?`: slide targets only — `"slide"` (default) plays just that slide;
  `"section"` plays from it to the end of its section (to the deck's end
  when there are no sections). A section target always plays its section.
- `returnToZoom?`: default `true`. `false` = after zooming in, the show simply
  carries on from the target (no return).
- `duration?`: seconds for the camera move (default 1, 0.1–60).
- `stroke?`, `strokeWidth?`, `radius?`: an optional frame around the tile.

While a zoom is open, `ArrowRight` walks the range — **hidden slides
included**, interactive states skipped, the overview itself never — and past
the last slide zooms back out; `ArrowLeft` on the range's first slide zooms
out too. Leaving the range any other way (a link, a typed slide number, the
grid, a loop wrap) closes the zoom; zooms nest (a tile on a zoomed slide opens
an inner zoom that returns to its own overview first). Reduced motion turns
the camera into a cut. The tile's cover is drawn contained in the box in the
slide's aspect, and the tile's rotation is ignored by the camera. Hidden
slides inside a zoom's range count as reachable for
`unreachable-hidden-slide`. **No `requires` entry**: an older reader keeps
the element through load → edit → save and renders it as an empty box.

---

## `fx` (presentation effects)

All `fx` behaviour runs in **present mode only**.

| Field | Type | Meaning |
|---|---|---|
| `enter?` | `'fade-up' \| 'fade' \| 'fade-down' \| 'slide-left' \| 'slide-right' \| 'slide-up' \| 'slide-down'` | Entrance animation. `fade-*` nudge ~16px; `slide-*` sweep ~120px from an edge. Only runs on non-morph arrivals. |
| `order?` | `number` | Stagger step in the entrance sequence; **equal values enter together**. |
| `step?` | `number` | **Click build**: the click that brings the element in (1 = first click); absent/0 = with the slide. Gaps are compressed (steps 1, 3 → two clicks). Older viewers ignore it and show everything. |
| `exitStep?` | `number` | The click that takes the element out again; must be after `step` (otherwise ignored). |
| `exit?`, `exitDur?` | same kinds as `enter`; `number` | Exit animation (default `fade`) — the mirror of `enter`: `slide-left` leaves to the left. |
| `byParagraph?` | `boolean` | Text only: paragraph *k* enters on click `(step ?? 1) + k` ("bullets one by one"). A paragraph is a top-level `<div>`/`<p>` or a `<br>`-separated run; blank lines don't count. `step: 0` shows the first paragraph with the slide. |
| `countUp?` | `boolean` | Animate numeric parts of the text from 0 to their final value. |
| `ambient?` | `'kenburns'` | Continuous ambient motion for full-bleed photos. |
| `ken?` | `{ dir?, scale?, duration? }` | Ken-burns tuning. `dir: 'drift'` (default) is an endless slow yoyo zoom; `'out'`/`'in'` play once per slide entry (`'out'` starts zoomed by `scale` and settles). `duration` in seconds. |
| `loop?` | dash-march or motion-path | Continuous loop (below). |

`loop` is one of:

- `{ type: 'pulse' | 'spin' | 'float' | 'blink' | 'wiggle', duration?, amount?, delay? }` — generic
  loops (see `agents.md`). `duration` is one full cycle; `amount` sizes the effect; they start
  after the entrance. spin/wiggle add to the element's own rotation.

- `{ type: 'dash-march', distance?, duration? }` — marching dashed strokes.
- `{ type: 'motion-path', path, duration, delay?, ease?, speeds?, trail? }` — the
  element travels an SVG path **relative to its rest position** (the first
  anchor is `0,0`). `ease` sets per-lap tempo; `speeds[]` gives per-anchor speed
  multipliers (`1` = normal, `<1` dwells, `>1` rushes; length matches the
  anchor count). Static output (PDF/print/static layer/preview) never runs the
  animation, so it draws the route as a faint dotted line under the element;
  `trail: false` opts out. Never combine a motion-path loop with an entrance tween.

---

## Interactive states

A slide with `stateOf: "<parent-id>"` is a hidden variant of its parent:

- Skipped by linear navigation. Reached only by element `link`s.
- While on a state, `ArrowLeft` returns to the parent, `ArrowRight` continues
  *past* it.
- If it shares element ids with its parent (or a sibling state) and the
  transition is `morph`, the matched elements glide between the two.

State slides live adjacent to their parent in `slides[]` and render nested in
the editor sidebar. A clickable trigger should be a padded transparent hit
rect, not the label text itself.

## Extra slides

Backup / deep-dive material is marked **by position**, with no field of its own:
the contiguous run of `hidden` slides directly after a normal slide N are N's
*extras* (hidden slides before the first normal slide have no parent and are
reachable only by links). While presenting:

- **X** on N enters its first extra; **X** on an extra leaves the run forward, to
  the next normal slide N+1 (which plays its transition as usual).
- `ArrowRight` / `Space` / `PageDown` walk the extras; past the last one the show
  moves on to N+1. `ArrowLeft` / `PageUp` walk back, from the first extra to N;
  from N+1, ← goes to N (the extras are skipped).
- A state of an extra follows the state rules above, relative to that extra.
- A run of hidden slides at the end of the deck is the last slide's appendix;
  since there is no N+1, leaving it (→ past its end, or X) returns to that slide.

The editor nests extras under their parent in the slide panel. Selecting several
slides and using Slide ▸ Hide slide marks them all in one step.

---

## Layouts

`doc.layouts` holds `Slide`-shaped templates (plus the built-ins in `model.ts`).
Instantiating a layout **keeps element ids** — slides born from the same layout
share ids, so their common chrome morphs across transitions and stays traceable
for a re-apply merge.

Applying a layout to an existing slide matches donors first by id, then by
`role` (same element type required); the layout supplies frame + typography
while content (text `html`, `link`) rides along. Layout-owned leftovers are
dropped unless they are text someone actually wrote; user extras survive on top.

A layout's *effective* content (what actually gets instantiated/applied) is
its own elements with its governing [master](#masters)'s `buildingBlocks`
composited underneath — see `model.effectiveLayout`.

---

## File modes

| Mode | Set by | Behaviour |
|---|---|---|
| **Editable deck** | (default) | Boots the editor; saves rewrite the file in place. |
| **Template** | `template: true` | Every open mints a fresh `docId` (`parseDoc` strips the flag and turns `templateId` into the new deck's `basedOn`) — each opener gets an independent deck. Opening never writes back to the template, but a template CAN change: its design (slide types, theme, fonts, reusable objects, their assets) is updatable from a deck based on it (`model.mergeTemplateDesign`, the Layout Manager's update action). |
| **Player / presentation package** | `readonly: true` | Boots straight into the presentation; never shows the editor. |

A **template** is slide types + theme + assets: `layouts` (with
`defaultLayoutId`/`rootFontLayoutId`), `theme`, `fonts`, `reusableObjects` and
the `assets` they reference. Its `slides` are sample slides, or — with
`templateSamples: false` — one starter slide kept only because a document needs
at least one. Starting a deck from a template (`model.instantiateTemplate`)
gives one starter slide of the default slide type unless the samples are
opted in, titles it "Untitled", mints a fresh `docId`, records `basedOn`, and
drops assets nothing references any more.

Encryption is orthogonal: the `#slidomingo-doc` block may hold a `slidomingo/enc`
envelope (PBKDF2-SHA-256 + AES-GCM over the doc JSON) instead of plaintext
document JSON — boot shows a password gate. The envelope is still plaintext
JSON in the block, so the splice contract holds.

---

## Format invariants (do not break)

1. `format: "slidomingo/slides"` plus **additive, optional** fields — old files open
   in newer shells; unknown fields survive parse → serialize.
2. Element **ids are identity** — morph, states, and links all key off them.
   Generators must emit deterministic ids.
3. The data-block JSON stays `<`-escaped; text HTML and chart options stay pure
   data (no functions, sanitized HTML) — a document can never smuggle code.
   **The one deliberate exception is the [`embed`](#embed) element**: its
   `html` is unsanitized author-supplied markup/script, deliberately, and is
   safe only because it runs inside an `allow-scripts`-only sandboxed iframe
   with no access to this document. No other element type may ever carry
   unsanitized HTML or a function value.
4. Asset references are `asset:` keys into `doc.assets`; a self-contained file
   fetches nothing external at view time.
5. Motion paths are stored **relative** to the element's rest position; the
   first path anchor is that position by definition.
6. Every document carries a stable `docId` — never derive it from content,
   never regenerate it on save.
7. **The reader gate.** If `requires` lists a name a reader does not know, the
   reader opens the file read-only and never writes it or merges any of it
   elsewhere. Tools that rewrite the JSON must do the same: keep `requires`
   exactly as found, and refuse to edit a file whose `requires` names a
   feature they do not implement. The current slides app knows
   `asset-store`, `rich-text` and `table-merge`.

## Minimal valid document

```json
{
  "format": "slidomingo/slides",
  "version": 1,
  "title": "My deck",
  "size": { "width": 1280, "height": 720 },
  "theme": {
    "background": "#101418", "color": "#F2F0EA",
    "accent": "#FF9E8A", "fontFamily": "system-ui, sans-serif"
  },
  "slides": [
    {
      "id": "s1", "background": "#101418", "transition": "none",
      "notes": "speaker notes here",
      "elements": [
        {
          "id": "t1", "type": "text",
          "x": 96, "y": 260, "w": 1088, "h": 160,
          "rotation": 0, "opacity": 1,
          "html": "Hello from a tool.",
          "fontSize": 88, "fontFamily": "system-ui, sans-serif",
          "fontWeight": 800, "color": "#F2F0EA",
          "align": "left", "valign": "top", "lineHeight": 1.1
        }
      ]
    }
  ],
  "modified": "2026-07-19T00:00:00.000Z"
}
```

`docId` is omitted above for brevity — `parseDoc` mints one on load. When a
tool *creates* a document from scratch, generate a fresh uuid for `docId`.
