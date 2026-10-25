---
name: build-deck
description: Plan and build a new deck (or a run of new slides) from a topic or source material — profile, outline, a look the user picks, a family of slide types, one reference slide per type, then the slides (big decks in parallel), a check, and alternatives for the slides where a choice matters.
---

Build the deck the user asked for, step by step, telling the user in one short line what each step is doing. For a new look on an existing deck use restyle-deck, to clean one up polish-deck, for one slide slide-designs.

**Questions.** By default, ask where a step says so: with your question tool if you have one (AskUserQuestion in Claude Code: up to 4 questions per call, 2–4 options each, your proposal first and marked "(Recommended)"; the user can always type their own answer), else in one message with a proposal for each point. When the user wants no questions ("just do it", "no questions") or nobody can answer, ask nothing and wait for nothing: take your proposals, say them in one line at the start and again in the report.

1. **Start.** Outside the app, when the user names a deck file or none is open, `open_deck` it (`create:true` makes a new one). Then `doc_info`, `outline`, and the design rules once: `read_reference("design.md")`.

2. **Profile.** Use `doc_info` `designRules.profile` when it is there; for slides added to a deck with content, read it off the deck. For a new deck, ask once, proposing an answer to each point from the request (with a question tool: the four that matter most, usually purpose, length, typical slide, and decoration with motion; the rest as assumptions beside them):
   - purpose: conference talk · lecture · meeting · pitch · for reading;
   - length: minutes → slides (about 1 per minute for a talk, 0.5 for a lecture or meeting), plus backup slides; for reading, a slide count;
   - typical slide: mostly text · text + small visual · balanced · visual + one-line takeaway · visual only;
   - visuals the user has (figures, photos to attach); decoration: plain · icons · imagery;
   - content that needs its own slide type: equations, code, tables, timeline, quotes, references;
   - motion: none · subtle (fades, morph) · expressive;
   - simplicity: minimal · clean · rich;
   - a look to follow: a template or .pptx, or none.

   The profile sets tone and budgets as design.md's "Tone and density" says.

3. **Outline.** A numbered outline in chat, grouped by section, one row per slide: its message (the one sentence the audience takes away; it becomes the title or takeaway), its evidence kind and its material (which figure, which numbers). Evidence kinds: title · section · closing · statement (one sentence, big) · one-result (one figure + takeaway) · comparison (two side by side) · detail (a figure with callouts) · overview (3–4 small multiples) · number (one figure beside what it is compared with) · process (steps / flow / sequence) · table · list (3–5 points) · equation · code · quote. Choose the kind from what the slide must show. Slides showing the same kind of thing share one kind on purpose (they read as a series and morph); unrelated slides of one kind stay at 3 in a row. Keep to what the material supports. Where the form is open (a table or a chart, one figure or small multiples, a diagram or a list), write both in the row, your pick first, in at most 3 rows. Over 10 slides, wait for the user's OK ("Outline OK?").

4. **The look.** It comes from what the user asked for, else the deck's own look (a template, its slide types, a theme someone set): keep it, reuse its slide types and add only the kinds it lacks, as children of its parent type. A deck without a look of its own (over 5 slides) gets one the user picks:
   - Write the outline's most typical content slide in 2–3 looks with ONE `propose_variants` call on it (add the slide, or reuse the deck's empty first slide; it stays and becomes that outline row).
   - Start from the starter looks in design.md that fit the profile, adapted to this content. Give each design its `theme`, so its diagrams show in its colours and picking it sets the deck theme, and keep its CSS on the theme variables.
   - Then do what the result says (outside the app: `variants` `{op:"previews"}` for the BeeSlides pane), and with a question tool also ask "Which look?", one option per design. Learn the pick from `variants` `{op:"status"}`; an answer that status does not show yet, apply with `variants` `{op:"pick", slideId, index}`.

   Without questions, build the starter look closest to the profile.

5. **The family of slide types.**
   - The type scale from design.md (label, body, title, and a statement size where the profile allows): say it in chat and give it to every writer.
   - The theme with `deck_settings` `{op:"theme"}`, unless a picked look already set it; `{op:"size"}` if asked.
   - A parent type "Base" (`create_slide_type` mode blank), written with `slide_html` on the type: the title (`data-role="title"`), the takeaway line if the profile has one, the footer or page number (`{{page}}`), and `body{background:var(--bs-bg)}`. These positions are the same on every type; that is what makes the deck one system. Then turn each slot into a placeholder in ONE call, `elements` `{op:"edit", slideId:<type id>, changes:[{id:"title", placeholder:"Title", html:""}, …]}`, so slides do not show the sample text.
   - One child per evidence kind the outline uses (`create_slide_type` mode parent from Base, then `slide_html` on the child for what it adds, its slots made placeholders the same way). Title, section and closing get top-level types. `doc_info` then lists every type's `placeholders` and `contentArea`.

6. **Reference slides.** Add every slide the outline needs in ONE call before filling any: `deck` `{op:"add", after, slideType, count, names}` (one call per run of slides sharing a type), reusing the empty slides `outline` already lists. Write the first slide of each type yourself and `review_slide` it: these are the references the other slides copy. Over 10 slides, point the user to them (in the app, or in the BeeSlides pane outside it) and wait for their OK.

7. **The other slides.** With 5 or fewer left, write them yourself from their type's reference; with more, use writers (below). Writing a slide:
   - `slide_html` `{op:"write", slideId, html, css}`: ordinary CSS lays it out and the app turns every box into an element. Fill a placeholder by giving your element its id at the placeholder's frame (`#<id>{position:absolute;left:<x>px;top:<y>px;width:<w>px}`); lay the rest out inside the type's `contentArea`. Colours and fonts come from the theme variables. Give every element an `id`; the same id on the next slide plus `transition:"morph"` morphs it (motion subtle or expressive).
   - Diagrams are components: `<div id data-component="steps|sequence|cards|compare|flow">` with the data as JSON (`slide_html` `op:"help"`). They cost far fewer tokens than drawn boxes and arrows, take the deck's colours, and `data-active` / `data-show` step through them slide by slide. Tables are `<table>`, charts `<div data-chart='{"preset":"bar","option":{…}}'>`, code `<pre>`. The result lists anything it left out.
   - With the `execute` tool (Code Mode), write your slides as one program from shared functions; the same rules apply inside it.
   - Animations, within the profile's motion: one `elements` `{op:"edit"}` per slide carrying every `fx`.
   - Icons, with decoration icons only: `icons` `{op:"search"}` with one short noun per concept, then `{op:"insert"}`; one size per slide. Without an icon library, say so in the report.
   - A figure the user has not supplied: a marked placeholder box ("Figure: <what it shows>") in its slot, never a chart of made-up numbers.
   - Speaker notes on every slide with `deck` `{op:"notes"}`.

8. **Check.** `review_slide` every slide you wrote and fix what it shows with the smallest tool, at most 2 rounds per slide (slides a writer reviewed only if its line says something is left). Slides of one type put title, takeaway and footer at the same frames and sizes. With 8 or more slides, start the critic (below) and fix the slides it names. Run `validate` once and delete empty slides you added (`deck` `{op:"delete"}`; the user's own slides only when they asked).

9. **Alternatives where a choice matters.** Name up to 4 slides where another design is most likely better (the main result, the critic's weakest) and offer them in one line. On a yes, one slide at a time: ONE `propose_variants` call holding the current form arranged differently, the other evidence form (table ↔ chart, diagram ↔ list, one figure ↔ small multiples) and the simplest version that still carries the point; keep the content, the type's title and footer, and the ids of elements that stay. Learn the pick as in step 4, then offer the same treatment to slides of the same kind. Without questions, name the slides in the report instead.

10. **Report** in two or three lines: what you built, the profile in one line, and what is left for the user (figures to drop in, anything `deck` help lists as not available yet).

## Writers: plan once, write in parallel

When more than 5 slides are left after the references and you can start subagents (`task` in the built-in chat, the Agent tool in Claude Code; writers can run on a faster model such as sonnet), split the writing: writers work at the same time.

- **Batches are consecutive runs** of 2–4 slides, ideally one section each, so morph pairs and series stay with one writer. Start every writer in ONE message.
- **Each prompt is self-contained.** Fill in this block, leaving nothing out:

  > You are writing slides <ids> of an open slide deck (title <title>, size <w>x<h>). First read the design rules: <how you read design.md: `read_reference("design.md")`, or its path in the plugin>. Profile: <one line: purpose, typical slide, simplicity, decoration, motion>. Type scale: <label / body / title px>. Your slides, in order: <id — slide type — evidence kind — message — material>. For each slide type, its reference slide; copy its title placement, takeaway, spacing, sizes and colours, and lay your content out inside the type's contentArea <[x,y,w,h]>: <type name: reference HTML and CSS from slide_html read>. Write each slide with `slide_html` write (with the `execute` tool, one program for all of them). Colours from the theme variables; diagrams as `data-component`; ids unique per slide, the same id on consecutive slides for morph<, only if motion allows it>; a missing figure is a marked placeholder box. Keep to the design rules' budgets for <simplicity>, with the detail in the speaker notes (`deck` notes); over budget, tell me instead of shrinking the type. Work only on your slides: adding, moving or deleting slides and starting subagents is for me. Then `review_slide` each slide once and fix with the smallest tool (at most 2 rounds). If a write answers that a program is running on this deck, wait a moment and write again. Answer with one line per slide: id — done, or what is left.

- **Then** read the one-line answers and go on with step 8.

## The critic

One subagent with fresh eyes, started after all slides are written. It sees the result, not your plan, so give it no outline:

> You are reviewing a finished slide deck for <audience/purpose>, <slide count> slides, ids <ids>. The person wants: <profile line>. Read the design rules first: <how to read design.md>. Call `review_slide` on every slide, in order, and change nothing. Then name the 3 weakest slides, worst first, each with one line on what makes it weak (the point not visible at a glance, text too small for the back row, more on it than the point needs, out of line with the other slides, against the profile or the design rules) and one line on the fix, preferring what to remove over what to add. Then one line on the deck as a whole: does it look like one system? Answer with those lines only.
