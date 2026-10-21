---
name: slide-designs
description: Propose 3 clearly different designs for a slide; the user compares them with the current slide and picks one.
---

Offer the user design options for one slide. They see your designs side by side with the slide as it is and pick one, keep the slide, or decide later. Nothing changes until they pick.

1. **Which slide.** The one the user names, else the slide they have open (the selection digest says which). Only one set of designs can wait for a pick at a time, so do ONE slide per call; for several slides, do the first and tell the user to say when they want the next.
2. **Understand it.** `slide_html` `{op:"read", slideId}` gives the slide as HTML; `review_slide` shows how it looks. Keep its content and message: the same title, points, numbers and pictures (reuse `<img src="element:<id>">` and the ids from the read).
3. **Design three real alternatives** (2–6 if the user asked for a number). They must differ in layout and emphasis, not only in colour, for example: cards in a row · one big number or statement with the rest small · picture or chart on one side, text on the other · a timeline or steps · a table. Use the deck's theme variables (`--bs-accent`, `--bs-font`, `--bs-margin` …), keep content inside the side margins, at most two typefaces. Write each as HTML + CSS exactly as for `slide_html` write; keep the ids of elements that stay, so animations, links and comments survive.
4. **Propose them** in ONE call: `propose_variants` `{slideId, variants:[{label, note, html, css}, …]}`. `label` is a few words ("Three cards"); `note` one line on what the design does differently ("Leads with the 40% figure"). If the result lists a dropped design or notes, fix and propose again only if something important was lost.
5. **Tell the user** in one line that the designs are ready to compare. You do not learn which one they pick; do not wait, poll or re-check the slide.
