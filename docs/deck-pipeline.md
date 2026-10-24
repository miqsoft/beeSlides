# Deck pipeline — new decks, glow-ups, polish, edits

Status: **proposal** (2026-10-24). The skills in
`desktop/src/main/apichat/skills/` are drafted to it; nothing else is built.
It builds on `design-rules.md` (the profile and the rule layers). Once tested,
the decisions go into `DECISIONS.md`.

## The goal

A deck an agent makes should look designed as **one system**: one look, a
small family of slide types, and a layout per slide that its content chooses.
Today every slide is improvised, because three things are missing:

- **What the person wants.** One text box or one chat line, no profile
  (`design-rules.md`, "Start interview").
- **A system before the slides.** `build-deck` sets a theme and then writes
  slides. Slide types appear only when a slide "has no fitting type".
- **Variety from content, not from chance.** Every writer copies ONE reference
  slide, so slides either all look alike or each writer improvises.

The same pipeline must also cover changing an existing deck, which today has
`polish-deck` (fix, never redesign) and no way to give a whole deck a new look.

## Routing: five kinds of request

| Request | Examples | Path | Asks the person |
|---|---|---|---|
| **Edit** | "shorter title", "make the chart blue" | no skill: the smallest verb | never |
| **One slide** | "this slide is boring", "show me options" | `slide-designs` | never (they pick a design) |
| **Polish** | "clean it up", "fix the alignment" | `polish-deck`: the look stays | never |
| **Glow-up** | "make it look nicer", "more modern", "our new style" | `restyle-deck`: the look changes, the content stays | once: what should change |
| **New** | a topic, a paper, an empty deck | `build-deck` | once: the profile; for long decks two OKs |

The boundaries:

- polish never changes the palette, fonts or slide types;
- a glow-up never changes wording, order or numbers;
- a new build never rewrites slides the person wrote unless asked;
- an edit keeps the slide on its slide type.

## Shared vocabulary

Every skill uses the same few words. That's what lets a glow-up, a polish and
a single-slide redesign agree with how the deck was built.

- **Profile.** Purpose, length, balance (typical slide), decoration, needs and
  motion (`design-rules.md`, `DeckProfile`). It comes from `doc_info`
  (`designRules.profile`) once that exists. Until then, `build-deck` asks for
  it, and the other skills infer it from the deck and state it in one line.
- **Tone,** from the purpose. A talk, lecture, meeting or deck for reading
  states and shows; it does not sell:
  - titles are claims the evidence supports, in plain words;
  - a number stands beside what it is compared with, plus its source;
  - at most one large number per deck, and no count-up.

  Hero numbers, count-ups and one-word panels are pitch devices. The first
  test run showed why this is needed: with the guidance as it was, the new
  pipeline put 168px numbers with count-up on three slides of a
  conference talk.
- **Evidence kind.** What a slide has to *show*:

  | Kind | Typical treatment |
  |---|---|
  | `title`, `section`, `closing` | the deck's frame slides |
  | `statement` | one sentence, big |
  | `one-result` | one figure across the content area + takeaway |
  | `comparison` | two figures or columns side by side, aligned |
  | `detail` | a figure with a zoomed inset or callouts |
  | `overview` | 3–4 small multiples in a grid |
  | `number` | one key figure beside what it is compared with and its source; a hero-size number with count-up only in a pitch |
  | `process` | a `steps`/`flow`/`sequence` component |
  | `table` | exact values |
  | `list` | 3–5 points (text-heavy profiles) |
  | `equation`, `code`, `quote` | only when the profile `needs` them |

- **Family.** The deck's slide types: one parent that carries the shared
  chrome, and one child per evidence kind the deck uses. These stay fixed:
  grid and margins, type scale, palette, title position, takeaway position and
  style, caption style, footer. What a child type varies is only how its
  content area is arranged. This is what looks harmonious.
- **Reference slide.** The first deck slide of each type, written and reviewed
  by the lead, and copied by every writer for that type.
- **Rhythm.** Repetition has to come from content. A series of results on one
  type is right. More than 3 *unrelated* slides in a row on one type is not.

## New deck (`build-deck`)

| Stage | Who | Output | Gate |
|---|---|---|---|
| 0 Profile | lead | the profile, stated in one line | **G1**: one message with proposed defaults (skipped when the request answers it, or with "just do it") |
| 1 Outline | lead | per slide: section, message (the takeaway sentence), evidence kind, material, slide type; open forms as "A · or: B" | **G2**: decks over 10 slides wait for an OK (in practice G1 and G2 come as one message) |
| 2 Look | lead | 2–3 looks on the most typical slide (`propose_variants`) | **Look**: decks over 5 slides; the person picks |
| 3 Family | lead | theme, parent type with chrome, one child per kind used | — |
| 4 References | lead | one deck slide per type, reviewed | **G3**: decks over 10 slides: "look at slides 2, 5, 7; OK?" |
| 5 Slides | lead (≤ 5 slides) or writers | every slide | — |
| 6 Check | lead + critic | consistency, rhythm, profile limits, `validate`; the critic's 3 weakest slides fixed | — |
| 7 Alternatives | lead | offered for at most 4 slides; on a yes, 2–3 designs each | **Pick**: one slide at a time |

The gates are each one message, and only where a wrong turn is expensive.
The look pick and G3 matter most: a family that looks wrong, caught after 4
slides, costs 4 slides. Caught after 30 slides, it costs 30. "Just do it"
skips every gate after G1; the assumptions are stated, and the slides that
might deserve alternatives are named in the report.

## Variants: choosing between options

This is how a person designs a slide. They decide what to say, decide what
it needs (a table, a figure, a diagram), build it, try variations, and pick.
The pipeline follows that, with variants only where a choice is worth its
cost.

**Where the cost is.** Understanding the material, the message and the
profile is the expensive part, and it is paid once. One more arrangement of
a slide that is already understood is a short HTML write. So:

- one agent writes all variants of a slide in ONE `propose_variants` call;
- never a subagent per variant, since each would re-read the deck, the tools
  and the reference, and know less than the agent that understood the slide;
- subagents only per slide, when several slides get variants at once.

| Level | When | How | Cost |
|---|---|---|---|
| **Form of the evidence** | in the outline, where it is genuinely open | "table · or: scatter", at most 3 rows; the answer to the outline settles it | a few words |
| **Look** | once per deck, before the family | 2–3 looks on the most typical slide | one slide's writing, ×3 |
| **Arrangement** | at most 4 slides: the main result and the critic's weakest, offered after the check | current form rearranged, the other form, the simplest version | ≈ $0.20 per slide (measured once, deck 5) |
| **Slide type** | any time | relink the slide to another type of the family; the app re-places the content | no model call (app feature, see below) |

Variants on every slide would cost about as much again as the whole deck,
and would ask the person to judge 45 designs. The targeted set costs a few
dollars and asks for 5–6 decisions.

**Every set holds a "simplest" design.** One alternative is always the
fewest elements that still carry the point. That makes "less" a visible
option instead of something the person has to ask for.

**Picks teach the deck.** After each pick, the agent offers the same
treatment for the other slides of the same evidence kind ("Slide 7 is a
table too — make it as lean?"). This was a "when it expresses taste" rule
until the plugin run showed the agent skipping it.

### What the app needs for this

Today one `propose_variants` set can wait at a time, so the skills go one
slide at a time. Since 2026-10-24 the agent learns the pick from `variants`
`{op:"status"}` (item 2 below, done). The full version needs:

1. **A variant inbox.** Open sets on several slides at once. A panel lists
   the slides with open sets, so the person decides in one sitting. A new
   set on the same slide replaces the old one, as today.
2. **Picks fed back.** Done (2026-10-24): the `variants` tool's
   `{op:"status"}` returns, per slide, `pending`, `picked <label>` or
   `kept`, so the agent can carry choices over without asking.
   `{op:"previews"}` hands it a picture of each design, and `{op:"pick"}`
   uses one the person named in chat.
3. **Screenshots never show the compare view.** `review_slide` hides it
   while capturing (live-run finding 5). Done for background mode, where the
   compare view never opens and every slide is shot off screen; open in the
   visible app.
4. **"Try other slide types" without a model call.** For the selected
   slide, render it relinked to each sibling type of its family, side by
   side. `relinkPreview` already computes the matching, so the result
   applies with `relinkSlide`.

## Glow-up (`restyle-deck`)

1. **Read the deck.** `doc_info`, `outline`, and `review_slide` on 3–4
   representative slides.
2. **One question.** The profile is inferred from the deck. Ask what should
   change ("calmer", "more visual", "match our template"), with the inferred
   profile shown for correction.
3. **Classify every slide.** Its message (kept) and its evidence kind. This is
   the outline of the existing deck.
4. **Pick a look.** `propose_variants` on the most typical slide with 2–3
   looks. The person picks one in the app and says which in the chat (the
   agent never learns the pick). This is the gate.
5. **Build the family.**
   - If the deck already has slide types, rewrite them in place
     (`slide_html` write on the type). Linked slides follow by themselves,
     which is the cheapest and most consistent path.
   - If not, create the family and `slide_type` `relink` every slide, then
     check `floating`.
6. **Rework what doesn't fit.** Floating content, and slides whose evidence
   kind calls for another arrangement (writers in parallel, the same contract
   as for a new deck).
7. **Polish pass + critic.**

Never in a glow-up: changing wording, numbers or order, deleting content, or
regenerating element ids (morph pairs, comments and links hang on them).

## Polish, one slide, edits

- **`polish-deck`** keeps the look. It knows the profile and the family:
  - its consistency step compares slides of the same type;
  - its suggestions never go against the profile (no "motion moment on the
    cover" when motion is none).
- **`slide-designs`** draws its alternatives from the family's treatments for
  the slide's evidence kind. An alternative that needs a new slide type says
  so in its note.
- **Edits** stay in the system prompt: keep the slide on its type and inside
  the deck's rules, ask nothing.

## Simplicity: how full a slide may be

Nothing limits how much goes on a slide today, and several things push the
other way:

- **The components draw boxes by default.** `cards`, `compare` and `flow`
  paint tinted boxes with 12–18px rounded corners (`htmlcomponents.ts`), and
  `compare` puts a box inside a box. A deck whose profile says square
  corners still gets rounded boxes.
- **The examples teach boxes.** The `slide_html` example in `agents.md`
  (Slides as HTML) is three cards with an 18px radius and a drop shadow.
  Models copy examples.
- **The guidance rewards adding things.** "Make a GREAT deck" asks for
  motion, an icon per item and count-ups. Nothing rewards taking something
  away.
- **No check counts.** `validate.ts` finds overflow and overlap, but not
  "eleven text blocks, six boxes and five font sizes on one slide".

What we can use, from cheapest to strongest:

1. **A simplicity setting in the profile:** minimal · clean · rich. The
   presets pick one (pitch → minimal, conference talk and lecture → clean,
   for reading → rich). It sets budgets per slide:

   | Per slide | minimal | clean | rich |
   |---|---|---|---|
   | text blocks | ≤ 4 | ≤ 7 | ≤ 10 |
   | boxes holding text | ≤ 1 | ≤ 4 | ≤ 8 |
   | items in one row, grid or list | ≤ 3 | ≤ 4 | ≤ 6 |
   | font sizes (levels of hierarchy) | ≤ 3 | ≤ 4 | ≤ 5 |
   | left edges text aligns to | ≤ 3 | ≤ 4 | ≤ 6 |
   | share of the slide covered | ≤ 40% | ≤ 55% | ≤ 70% |

   `scripts/check-deck-harmony.mjs` already measures each of these from the
   model (density and over-density lines).
2. **Box discipline, as rules in the skills and `agents.md`:**
   - group with space and alignment first, a rule or accent bar second, and
     a box last;
   - never a box around a single text, never a box inside a box;
   - cards only for 3–4 parallel items of equal weight;
   - a box has a job: grouping, emphasis or a click target.
3. **Over budget means split, not shrink.** Two slides, a table instead of
   eight boxes, a click build instead of everything at once, or detail moved
   to a backup slide.
4. **Components follow the deck.** Add `data-variant="plain|outline|filled"`
   and take the corner radius from the theme or the `maxRadius` limit
   instead of hard-coded 12–18px. `plain` draws no boxes: the items are laid
   out by space and an accent rule.
5. **Findings, the same way as the design limits.** `validate.ts` gains
   `design-dense-*` codes computed exactly as the checker does, against the
   profile's budgets. They show in agent write results like the layout
   banner, so writers fix them in their own polish rounds, and they show to
   people in Check slides.
6. **A "simplest" option every time.** `slide-designs` always includes one
   design with the fewest elements that still carries the message. "Make it
   simpler" in `polish-deck` removes boxes, merges text and splits slides,
   instead of only aligning.
7. **Teach by example.** Replace the card-with-shadow example in `agents.md`
   with a box-free one, and make "the point visible at a glance" the first
   question the critic asks.

## Subagent structure

| Role | Model | Sees | Does | Returns |
|---|---|---|---|---|
| **Lead** | the session's | everything | profile, outline, family, references, final check | the report |
| **Writer** | a faster one is fine | its slide ids, their outline rows, the reference HTML of each type it uses, the profile line | writes and reviews its own slides | one line per slide |
| **Critic** | the session's | slide ids, the profile and the purpose — not the outline, not the chat | screenshots every slide, ranks the 3 weakest with the reason | the ranking; changes nothing |
| **Polisher** | a faster one is fine | its slide ids, family and profile | `polish-deck`'s per-slide fixes | per slide, what changed |

Rules:

- Slides are disjoint, and subagents never start subagents.
- Writers get **consecutive runs** (a section), so morph pairs stay with one
  writer. Each writer gets the reference of every type in its run.
- The writer prompt is a fixed contract block in `build-deck.md`, copied with
  the blanks filled in, never rewritten from memory.
- The critic exists because a lead that built the deck is anchored on its own
  plan. A fresh context that only sees the result finds what the plan hid.
  It runs only for decks of 8 slides or more, since screenshots go through
  one canvas, one at a time.
- The lead never re-reviews a writer's slides unless the writer's line says
  something is left.

## Where it runs

| Where | Today | For this pipeline |
|---|---|---|
| Built-in AI chat (app) | skills bundled, `task` subagents | works as drafted |
| Claude Code panel (app) | skills written into the workspace, Agent tool subagents | works as drafted |
| Claude Code outside the app | the `beeslides` plugin (`claude-plugin/`): the open app's tools when its Settings ▸ AI chat ▸ Advanced switch is on (one question per app), else a hidden BeeSlides for the chat (background mode); the same skills, the outside instruction, the BeeSlides pane (DECISIONS 2026-10-24, "BeeSlides without its window"); guide: `site/.../create/outside-apps.mdx` | works as drafted (live run 2026-10-24, plugin only) |
| claude.ai web chat | JSON round trip | not for building or restyling: it can't see or measure slides |

The app does the work in every case, because screenshots, measuring and
layout happen in it. Outside the app it may be a hidden instance that opens
the deck file the agent names (`open_deck`), with no window.

**"Describe it" in the start picker** joins the same pipeline. It opens a
fresh deck and hands the form's profile and text to `build-deck` in that
deck's Claude panel, instead of writing a blind `generate-result.json`. The
JSON path stays only for the PowerPoint import (`design-rules.md`,
"Generation").

## Would a Claude Code mod help with reviewing single things?

A mod can show a pane beside the Claude Code chat (images included in the
terminal), add slash commands and hook tool calls. Three ideas, judged:

1. **Review pane: the current slide's screenshot beside the chat, with
   OK / redo buttons.**
   - No, mostly. The deck is open in the app anyway, and the app is the
     better review surface: the live canvas, the compare view of
     `propose_variants`, and **comments → Send to Claude → Accept/Reopen**,
     which already *is* "review single things directly". It works in all
     three chats, and a mod would serve only Claude Code.
   - Improve that flow instead. For example, a "Ask Claude about this"
     action on a selection that writes the comment and sends it in one go.
2. **Enforcing the gates (block slide writes before the outline is OK'd).**
   - Not as a mod. Enforcement belongs in the app (`agentbridge.ts`), so the
     built-in chat gets it too. The skill gates plus the critic should be
     tried first.
3. **The interview as a form pane, plus a stage band (profile, stage,
   connected deck).**
   - Only for Claude Code outside the app, where there is no app form beside
     the chat. Worth it as part of the external plugin, after the plugin
     exists. A `/review-slide 4` command needs no mod: a skill does it.

Verdict: **no mod now.** First the skills, then the plugin for external
Claude Code. A mod is the last step, and only for the external path.

**Update (2026-10-24, DECISIONS "BeeSlides without its window"):** built.
Background mode removed the premise of idea 1: without the app window there
is no canvas and no compare view to review in. The plugin's pane shows the
latest `review_slide` screenshot and the `variants` previews with a button
per design; in the visible app it saves a trip to the window.

## Testing

Two kinds of check, both runnable step by step.

**1. Measured: `scripts/check-deck-harmony.mjs <deck.html> [--profile p.json]`.**
It reads a saved deck and reports what can be counted:

- slide types used and the share of linked slides;
- the longest run of one type;
- title frames per type;
- typefaces and off-palette colours;
- motion per slide;
- text per slide;
- notes coverage.

With a profile it flags what goes against it. It is not a test rig (no
`test-` prefix), but a measuring tool for comparing before and after.

**2. Scenarios in the app** (`cd desktop && npm run dev`; skills are bundled
at build time, so the dev run picks up the drafts). Run each one in the
Claude Code panel, save the deck, run the checker, and look at it:

| # | Scenario | Passes when |
|---|---|---|
| T1 | New 15-minute conference talk from a paper PDF | G1 is one message; the outline names a kind per slide; 4–7 types; a reference per type before G3; no ambient motion; title frame identical within each type; no run of more than 3 unrelated slides on one type |
| T2 | New 6-slide pitch, "just do it" | no gates; motion allowed; still one family |
| T3 | Glow-up of `docs/examples/seasons.beeslides.html` | every slide's text unchanged (diff); every element id kept; every slide linked to a family type; the checker's consistency numbers better than before |
| T4 | Polish a motion-none deck | no motion suggestions; looks unchanged |
| T5 | "Make the title on slide 3 shorter" | no skill, no question, slide type unchanged |
| T6 | `slide-designs` on a `one-result` slide | 3 alternatives, all inside the family |
| T7 | T1 at 25 slides | writers started in one message, each owning one section run; the critic runs; the lead fixes its 3 slides |

Baseline first: run T1 and T3 with the skills as they are on `main`, save,
and run the checker. Then repeat with the drafts.

**Baseline of the example decks** (checker, against a conference-talk
profile):

- None of the three uses a slide type (0% linked).
- `a-day-at-the-lake` has 76 off-palette colours and expressive motion on
  every slide.
- `how-bees-fly` has radius 30 and 10 of 11 slides over the text budget.

They are showcases rather than talks, but they show what the checker sees
when there is no system.

### Live runs (2026-10-24)

Headless Claude Code (Opus, writers on Sonnet) against an isolated app with
the agent endpoint on, same request each time: "a 12-minute conference talk
for security researchers" from a fictional paper. The decks, contact sheets,
transcripts and the harness are in
`../beeslides-pipeline-tests/2026-10-24/` (outside the repo).

| Deck | Slide types | Off-palette colours | Text blocks / slide | Font sizes / slide | Text < 18px | Hero numbers / count-ups | Top-heavy slides | Cost |
|---|---|---|---|---|---|---|---|---|
| 1 Baseline (skills at HEAD) | 1 | 11 | 11.4 | 6.3 | 57 | 4 / 8 | 0 | $3.24 |
| 2 New pipeline | 9 | 0 | 13.7 | 5.6 | 85 | 3 / 2 | 2 | $3.84 |
| 3 Glow-up of 1 (`restyle-deck`) | 2 | 10 | 12.4 | 5.4 | 41 | 4 / 8 | 0 | $4.97 |
| 4 New pipeline v2 (tone + density rules) | 8 | 2 | 7.1 | 3.7 | 0 | 0 / 0 | 5 | $3.95 |
| 5 **Claude Code with the plugin only** (look pick + alternatives) | 7 | 3 | **6.0** | **3.3** | **0** | **0 / 0** | 2 | $4.51 |

Costs are what `claude -p` reports for the whole session; it adds up
across resumed turns. Deck 5 was built by a Claude Code that knew BeeSlides
only through `claude-plugin/` (`--plugin-dir`, no workspace skills, no
appended instruction), against the app with the endpoint switched on in the
settings (not the environment variable) and Claude Code already allowed. It
ran every stage: one question (profile + outline, with an open form "table ·
or: scatter"), three looks to pick from, references, 3 Sonnet writers, the
critic, then alternatives for slide 8 on request (≈ $0.19 for the set of
three; "simplest" was picked).

What the runs showed:

- **Harmony** comes from the family. Runs 2 and 4 have one title frame per
  type and no stray colours or radii. The baseline was coherent too (one
  type), just dark, rounded and dense.
- **The gates work, and cost little.**
  - G1 came as one message with the profile *and* the outline.
  - G3 caught the look after 8–9 reference slides.
  - The glow-up's one question showed three looks via `propose_variants`
    and asked before changing any text.
- **Marketing devices came from our own guidance.** "Headline number →
  count-up" in `agents.md` and the brief produced 168px numbers in a
  conference talk. The tone rule removed them (run 4).
- **Density needed explicit rules.** Run 2 was *denser* than the baseline.
  These rules took it from 85 tiny text blocks to 0, and from 13.7 to 7.1
  text blocks per slide (run 4):
  - a type scale fixed once, nothing under 18px;
  - one text per box or diagram node;
  - the slide carries the point, the notes carry the detail.
- **Over-correction:** run 4 left the lower third of 5 slides empty. The
  balance rule was added after it.
- **The glow-up kept every word.** The only text changes were the section
  labels the person agreed to. It can't fix density, by design.
- **The lead decides when to use writers.** Run 2 wrote 6 remaining slides
  itself; runs 3 and 4 used 3–5 Sonnet writers and the critic.

### Findings for the app (from the runs)

1. **No way to place a picture file.** `<img>` takes only a data URI, an
   `asset:` key or `element:<id>`, so a figure from disk has to be
   base64-encoded and pasted into a tool call. This blocks figure-heavy
   science decks. Needed: an `images` op that imports a file from the
   deck's or an attached folder into the asset store.
2. **No theme variable for a secondary grey** (`slide_html` has `--bs-text`,
   `--bs-bg`, `--bs-accent…6`). Agents typed hex values that won't follow a
   theme change (`design-rules.md`, "Consistent colours").
3. **The components draw rounded, tinted boxes**, and `compare` nests a box
   in a box. Run 4 dropped `compare` for that reason. They need
   `data-variant` and a radius from the theme (see Simplicity).
4. **The chart engine lacks value labels on bars and a log axis.**
   - Run 2 drew a log-scale scatter plot by hand, from shapes and 17 tiny
     labels.
   - Run 4's ablation bars from 0 make 0.94 and 0.83 look alike.
5. **`review_slide` screenshots the window region.** A toast, or an
   unpicked `propose_variants` compare view, ends up in the image (glow-up
   slide 7). In background mode every deck slide is now shot off screen and
   the compare view never opens; the visible app is unchanged.
6. **Only one `propose_variants` set at a time, and the pick never reaches
   the agent.** Both block a "variants for several slides, decide in one
   sitting" step. The pick now reaches it (`variants` `{op:"status"}`,
   2026-10-24); one set at a time remains.
7. **Fonts named in a theme but not installed fall back silently.** The
   agent learned it only from a screenshot.
8. **Tables can only draw a border around every cell.** Scientific tables
   want thin horizontal rules only (header, body, total). The plugin run
   ended with a light grid instead of the row lines of the picked look.
9. **The compare view's number badges cover the start of each design's
   title** in the preview ("PkgGraph" loses its "P").
10. **A pick was not carried over.** After "simplest" was picked on slide 8,
    the agent did not offer the same treatment for the deck's other table
    slide. The skill asks for that only "when a pick says something about
    taste", which is a judgement call. A fed-back pick (variant inbox) and a
    plainer rule ("offer it for the other slides of the same evidence kind")
    would make it reliable.

### Paper test (2026-10-24): each step against the real tool contracts

| Step | Relies on | Holds? |
|---|---|---|
| Family: write a type | `slide_html` write takes a slide type id (`agentops.ts` `targetSlide` → `resolveAgentSlide`) | yes |
| Family: placeholders | `layoutBrief` lists only text elements with a `placeholder` prompt, and HTML can't set one | **gap**: the skill now sets it with `elements` edit on the type. A product fix would be `data-placeholder="Title"` in `slide_html` on slide types (`htmlslide.ts`, plus a case in `test-slide-html-e2e.mjs`) |
| Family: children | `create_slide_type` mode `parent`; `layoutBrief` includes inherited placeholders | yes |
| Slides on a type | `deck` add with `slideType` | yes |
| References | `review_slide` on deck slides; a slide type only while it's the open surface | yes, so references are deck slides, never the types |
| Glow-up: relink | `slide_type` relink returns `verdict` and `floating` | yes |
| Glow-up: pick a look | `propose_variants`; the agent never learns the pick | yes, so the skill asks the person |
| Profile across sessions | `designRules.profile` doesn't exist yet | **gap**: the profile lives in the chat and the subagent prompts; a later polish or glow-up infers it again. Fixed by design-rules rollout step 2 |
| Critic | subagents have the same tools; screenshots go one at a time | yes, kept to decks of 8+ slides |
| Outside the app | no plugin, endpoint behind an environment variable | **gap**: "Where it runs" |
