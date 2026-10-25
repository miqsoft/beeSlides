# What makes a slide look good

The design rules every deck skill builds on (shipped to agents as
`design.md`). Sizes are for a 1280×720 slide; scale them with `doc.size`.
A look the user asked for, or the deck's own look, comes first; these rules
fill in what nobody decided. Sources: DECISIONS 2026-10-25.

The aim is a deck with character that reads from the back of the room: one
recognisable look carried through every slide, and pictures drawn for the
content. Safe and generic is not the goal; readable and consistent is the
floor.

## Tone and density, by profile

The deck's profile (purpose, typical slide, simplicity, decoration, motion;
`doc_info` `designRules.profile`, or what the user said) sets these.

- **Tone.** A conference talk, lecture, meeting or deck for reading states
  and shows. Titles are claims the evidence supports, in plain words. A
  number sits next to what it is compared with (the baseline, last year)
  and says where it comes from; one large number in the whole deck at most,
  for the main result. A pitch may sell: hero numbers and one-word panels
  belong there.
- **How much a slide holds** (simplicity minimal / clean / rich): at most
  4 / 7 / 10 blocks of running text (a title, a paragraph, a list, a
  caption) and 3 / 4 / 6 items in one row, grid or list. Labels inside a
  diagram do not count: a diagram may carry as many short labels as it needs
  to explain itself. The typical slide says how much text: visual +
  takeaway is a title and one sentence; balanced up to 3 short points;
  mostly text up to 5.
- **The slide carries the point, the notes carry the detail.** Over budget,
  split the slide, use a table or move detail to the notes, and keep the
  type size.
- **Sizes a room can read** (a slide that is presented): running text 22 px
  or more, anything the audience must read 16 px or more, diagram labels
  included. A deck for reading may go down to 13 px.
- **Motion:** none means a plain fade at most; subtle adds fades and morph;
  expressive allows any effect. **Decoration:** plain means no icons or
  imagery (the default for a talk); icons come from the user's icon library,
  or are drawn for the deck as its own icon set, in its look (build-deck,
  "Icons drawn for this deck").

## The look: one system, carried through

1. **Decide the look once, as one stylesheet**, before the first slide:
   colours, type, the motif. Every slide uses only that stylesheet's
   classes and variables. This is what makes a deck look designed.
2. **A type pairing with jobs.** Up to three typefaces, each with one job:
   a display face for titles, a text face, and a utility face for labels,
   data and code (a monospace or a narrow sans). A word set in a
   contrasting face inside a title (a serif italic in a bold sans: "IP
   makes *no* promises") is a strong motif; use it on every title or none.
3. **A clear type scale** with real contrast between levels, e.g. title
   56–64, statement 40–48, text 22–26, label 16–18 px. Titles tight
   (line-height about 1.05, slightly negative letter-spacing at large
   sizes), text open (line-height 1.35–1.45).
4. **Small labels may be spaced capitals** (a few words, letter-spacing
   0.08–0.16em, the utility face): section names, axis names, the header
   strip. Sentences never are.
5. **A motif on every slide:** a header strip (deck or section name left,
   page `{{page}}` right) in the label style, section numbers ("02 · Where it
   lives") when the deck has sections, a hairline.
6. **The title slide is the cover, and it is bold:** one big idea set huge
   (the key word or acronym at 160–300 px, tight letter-spacing), the full
   title and a one-line promise in the display and text faces, and a small
   motif drawn from the content (the packets in flight, the curve the talk
   is about, the object in question) in the deck's colours, often on a dark
   full background. A headline alone on a colour is not a cover. Section
   slides may break the pattern the same way.
7. **Colours with meanings.** A background with some warmth or tint (paper,
   slate, off-white) or a deliberate white; an ink near black, not black; a
   muted ink for secondary text. Then one or two accents, and each accent
   means one thing across the whole deck (data vs acknowledgements, ours vs
   theirs, the current step). Labels, rules and decoration stay neutral
   unless they carry that meaning.
8. **Contrast:** text at least 4.5:1 on its background; arrows, chart marks
   and icons at least 3:1.
9. **Set the deck theme to the look** (`deck_settings` theme or a
   propose_variants design's `theme`: background, text colour, accent,
   accent2, fonts) and write the stylesheet on the theme variables
   (`--bs-bg`, `--bs-text`, `--bs-accent`, `--bs-accent2`, `--bs-muted`,
   `--bs-line`, `--bs-tint`, `--bs-font`, `--bs-heading-font`), so
   components, new elements and later theme changes match.

## Space and grid

10. **Margins:** every text starts on the left margin (`var(--bs-margin)`,
   96 px, or the look's own) or on a grid line; nothing crosses the right
   margin.
11. **One spacing scale** (e.g. 8 / 16 / 24 / 32 / 48 / 64 px). Equal things
    get equal gaps; more space between groups than inside them.
12. **Text beside evidence splits the width unevenly** (about 5:7 or 4:8);
    halves only for a real comparison of two equals.
13. **The title sits at the same place on every content slide**, and the
    evidence fills the area below it: it starts about 48 px under the title
    and reaches down towards the footer. Grow the figure rather than leaving
    a band under the title or an empty lower half (`review_slide` reports
    both as `layout-empty-band`).
14. **Group with space first, a hairline second, a tint panel third.** A box
    around a single text adds nothing.

## Evidence: draw what the content does

15. **One message per slide, readable in three seconds:** a title claim and
    one piece of evidence (a figure, a table, a diagram, a short list) that
    fills the area below it.
16. **A diagram drawn for this content beats a generic one.** When the point
    is a mechanism (packets reordered and lost, a handshake over time, a
    window sliding, a queue filling), draw it as inline `<svg>` in the
    slide: the real states, the real labels, arrows with arrowheads
    (`marker-end`), time running down the page. It becomes editable shapes.
    Use a component (`data-component`) where a standard form fits or the
    parts reveal step by step.
17. **A drawn diagram explains, it does not just show:** every state and
    part has its name (CLOSED, SYN-SENT, ESTABLISHED; buffer, window), every
    arrow says what it carries (SYN seq=x), and one or two short
    annotations say why at the point where it happens (the timeout bracket,
    "has 3000, still needs 2000", "4 overtook 3"). Show all the cases the
    title promises (lost, reordered, duplicated and corrupted, not two of
    them). Fewer, bigger parts at 16 px or more, but every part named.
18. **Diagrams speak the deck's colour meanings:** the same accent for the
    same thing on every slide; everything else in the ink and muted colours,
    strokes 1.5–2 px, labels in the label style.
19. **Charts:** label lines and bars directly instead of a legend; few or no
    gridlines; the series the title talks about in an accent, the others in
    `--bs-muted`.
20. **Pictures** run to the slide edge, or fill whole grid columns; no frame
    or shadow.
21. **Slides of the same kind share one layout**, so the deck reads as a
    series (and morphs). Vary the layout with the content, never for
    variety's sake.
22. **The last slide shows evidence too.** A summary puts the mechanisms
    side by side as small diagrams, maps each problem to its fix in a table
    with a tiny picture per row, or combines them into one diagram; a
    closing slide may echo the cover's motif. Headings with a sentence each
    are the last resort.

## What makes a deck look machine-made, and what to do instead

23. A row of identical rounded cards with shadows on every slide → vary the
    evidence with the content; one card style at most.
24. A coloured bar or underline under every title → whitespace and the
    motif set the title off.
25. Emoji, stock icons for every bullet, gradient blobs and glows in a talk
    → a drawn diagram, or nothing.
26. Everything centred → left-aligned text on a grid; centre only a
    statement or a title slide.
27. **Before you finish a slide, take one decoration away:** a box, a
    rule, a repeated label. If the slide still says the same, it is better.
    Names and annotations that explain the evidence stay.

## Starter looks

Five tested looks. When the user has no look, offer the ones that fit the
profile as `propose_variants` designs, each with its `theme`, adapted to the
content, or build your own in the same spirit. Each `theme` is the
`deck_settings` theme; the CSS is the start of the deck stylesheet and uses
the theme variables. `body{background:var(--bs-bg)}` makes the slide's
background the theme's.

**Paper and ink** — warm paper, near-black ink, a bold grotesk with serif
italic words, monospace labels, two accents with fixed meanings (vermilion
for data, blue for answers). Explains mechanisms well.

```json
{"background":"#F3F0E8","color":"#17191D","accent":"#E2491D","accent2":"#2F55D4","headingFamily":"Inter, -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif","fontFamily":"Inter, -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif"}
```
```css
body{background:var(--bs-bg);color:var(--bs-text)}
.strip{position:absolute;left:var(--bs-margin);right:var(--bs-margin);top:36px;display:flex;justify-content:space-between;font:500 16px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--bs-muted)}
.kicker{font:600 16px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--bs-accent)}
h1{margin:0;font-size:60px;font-weight:700;line-height:1.04;letter-spacing:-0.03em}
h1 em{font-family:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;font-style:italic;font-weight:400;letter-spacing:-0.01em}
.lead{font-size:24px;line-height:1.45}
.label{font:600 16px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--bs-muted)}
```

**Editorial** — calm and literary: serif claims, sans text, hairlines, a
deep teal accent.

```json
{"background":"#FFFFFF","color":"#1D2433","accent":"#1F5C78","headingFamily":"Georgia, 'Times New Roman', serif","fontFamily":"'Helvetica Neue', Helvetica, Arial, sans-serif"}
```
```css
body{background:var(--bs-bg)}
h1{font-size:48px;font-weight:600;line-height:1.1;margin:0}
.rule{border-top:1px solid var(--bs-line)} .muted{color:var(--bs-muted)}
.label{font-size:18px;color:var(--bs-muted)}
```

**Swiss** — strict grid, one grotesk in two weights, signal red for the one
thing that matters.

```json
{"background":"#FFFFFF","color":"#16181D","accent":"#C8102E","fontFamily":"'Helvetica Neue', Helvetica, Arial, sans-serif","headingFamily":""}
```
```css
body{background:var(--bs-bg)}
h1{font-size:56px;font-weight:700;letter-spacing:-0.02em;line-height:1.05;margin:0}
.col{border-left:1px solid var(--bs-line);padding-left:24px}
.label{font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
```

**Soft panel** — friendly and clear: the evidence on one flat tinted panel,
the words on the bare background.

```json
{"background":"#F6F7F9","color":"#1E2A3A","accent":"#3D5A99","fontFamily":"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif","headingFamily":""}
```
```css
body{background:var(--bs-bg)}
h1{font-size:48px;font-weight:650;line-height:1.1;margin:0}
.panel{background:var(--bs-tint);border-radius:12px;padding:32px}
```

**Lecture dark** — for dim rooms: slate background, off-white text, one
pale amber accent that lights up the active element.

```json
{"background":"#17202B","color":"#E9EDF2","accent":"#E8B85C","headingFamily":"Georgia, 'Times New Roman', serif","fontFamily":"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"}
```
```css
body{background:var(--bs-bg)}
h1{font-size:52px;font-weight:600;line-height:1.08;margin:0}
.rule{border-top:1px solid var(--bs-line)} .muted{color:var(--bs-muted)}
.label{font:600 16px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--bs-muted)}
```
