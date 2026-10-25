# What makes a slide look good

The design rules every deck skill builds on (shipped to agents as
`design.md`). Sizes are for a 1280×720 slide; scale them with `doc.size`.
A look the user asked for, or the deck's own look, comes first; these rules
fill in what nobody decided. Sources: DECISIONS 2026-10-25.

## Type

1. **One type scale for the whole deck:** label 20, body 28, title 40,
   statement 56 px (a step of about 1.4, so the levels read apart at a
   glance). Every slide uses only these sizes, and the same body size even
   when a slide has one line.
2. **Titles are a claim in sentence case**, flush left, at most two lines,
   weight 600–700, line-height 1.15. The audience reads the title first; a
   claim tells them what to see.
3. **Body text** weight 400, line-height 1.35, left-aligned. Centre only a
   statement or a title slide.
4. **At most two typefaces with different jobs:** a serif for titles and a
   sans for text, or one sans with 700 against 400. Monospace is for code.
5. **Short lines:** a text column stays under about 60 characters (about
   800 px at 28 px). Wider content goes into two columns.
6. **Emphasis by the smallest difference that works:** weight or the text
   colour against `--bs-muted` first, the accent second, size last. Bold
   sparingly, never bold and italic together, no underlines, no all caps.

## Space and grid

7. **Margins:** every text starts on the left margin (`var(--bs-margin)`,
   96 px) or on a grid line; nothing crosses the right margin.
8. **One spacing scale:** 16 / 32 / 48 / 64 px. 48 between title and
   content, 32 between blocks, 16 inside a group. Equal things get equal
   gaps.
9. **Text beside evidence splits the width unevenly** (about 5:7 or 4:8);
   halves only for a real comparison of two equals.
10. **The title sits at the same place on every content slide**, and the
    content fills the content area below it: grow the figure or centre the
    block rather than leaving the lower half empty.
11. **Group with space first, a hairline second (`1px solid var(--bs-line)`),
    a tint panel third (`background: var(--bs-tint)`, radius 8 px, no border,
    no shadow).** A box around a single text adds nothing.

## Colour

12. **Neutrals carry the slide:** background, `--bs-text` and `--bs-muted`
    make up about 90% of it. The accent is the rest.
13. **The accent has one job:** it marks what the title talks about (the
    bar that matters, the current step, the term being defined). Labels,
    rules and decoration stay neutral.
14. **Contrast:** text at least 4.5:1 on its background; arrows, chart marks
    and icons at least 3:1. The theme's text, muted and accent colours of
    the starter looks below already pass.
15. **Dark text near black, not black** (e.g. `#1D2433` on white), and
    off-white on dark backgrounds: softer and easier to read in a lit room.

## Evidence

16. **One message per slide, readable in three seconds:** a title claim and
    one piece of evidence (a figure, a table, a diagram, a short list) that
    fills the content area.
17. **Charts:** label lines and bars directly instead of a legend; few or no
    gridlines; the series the title talks about in the accent, the others in
    `--bs-muted`.
18. **Diagrams:** use a component (`data-component`) where one fits: it
    takes the theme's colours. Hand-drawn parts: nodes of one size on a grid,
    2 px strokes in the text colour, a short label on every arrow, at most
    one node in the accent.
19. **Pictures** run to the slide edge, or fill whole grid columns; give them
    no frame or shadow.
20. **Slides of the same kind share one layout**, so the deck reads as a
    series (and morphs). Vary the layout with the content, never for
    variety's sake.

## Character

21. **One quiet motif repeats on every slide**, for example the section
    name and page number in a 20 px muted footer on the margin. Section and
    title slides may be bold (a full background in the dark or accent
    colour, a statement-size line); content slides stay quiet.
22. **What makes a deck look machine-made, and what to do instead:**
    whitespace, not an underline or a coloured bar, sets a title off; a
    small label above a title is sentence case, not spaced capitals; numbers
    (01, 02, i, ii) only on things that are a sequence; monospace only for
    code; one card style is fine, but not every slide a row of identical
    rounded cards with shadows.
23. **Before you finish a slide, take one thing away:** a box, a label, a
    rule, an icon. If the slide still says the same, it is better.

## Starter looks

Four tested looks. When the user has no look, offer the ones that fit the
profile as `propose_variants` designs, each with its `theme`, adapted to the
slide's content, instead of inventing looks from scratch. Each `theme` is the
`deck_settings` theme; the CSS uses only the theme variables, so it works
with any slide. `body{background:var(--bs-bg)}` makes the slide's background
the theme's.

**Editorial** — calm and literary: serif claims, sans text, hairlines, a
deep teal accent.

```json
{"background":"#FFFFFF","color":"#1D2433","accent":"#1F5C78","headingFamily":"Georgia, 'Times New Roman', serif","fontFamily":"'Helvetica Neue', Helvetica, Arial, sans-serif"}
```
```css
body{background:var(--bs-bg)}
h1{font-size:40px;font-weight:600;line-height:1.15;margin:0}
.rule{border-top:1px solid var(--bs-line)} .muted{color:var(--bs-muted)}
```

**Swiss** — strict grid, one grotesk in two weights, signal red for the one
thing that matters.

```json
{"background":"#FFFFFF","color":"#16181D","accent":"#C8102E","fontFamily":"'Helvetica Neue', Helvetica, Arial, sans-serif","headingFamily":""}
```
```css
body{background:var(--bs-bg)}
h1{font-size:40px;font-weight:700;letter-spacing:-0.01em;line-height:1.1;margin:0}
.col{border-left:1px solid var(--bs-line);padding-left:24px}
```

**Soft panel** — friendly and clear: the evidence on one flat tinted panel,
the words on the bare background.

```json
{"background":"#F6F7F9","color":"#1E2A3A","accent":"#3D5A99","fontFamily":"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif","headingFamily":""}
```
```css
body{background:var(--bs-bg)}
h1{font-size:40px;font-weight:600;line-height:1.15;margin:0}
.panel{background:var(--bs-tint);border-radius:12px;padding:32px}
```

**Lecture dark** — for dim rooms: slate background, off-white text, one
pale amber accent that lights up the active element.

```json
{"background":"#17202B","color":"#E9EDF2","accent":"#E8B85C","headingFamily":"Georgia, 'Times New Roman', serif","fontFamily":"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"}
```
```css
body{background:var(--bs-bg)}
h1{font-size:40px;font-weight:600;line-height:1.15;margin:0}
.rule{border-top:1px solid var(--bs-line)} .muted{color:var(--bs-muted)}
```
