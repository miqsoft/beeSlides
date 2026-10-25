# Changelog

All notable changes to BeeSlides. The app version is baked into every shell
as `APP_VERSION` (from `slides/package.json`) and shown in the About dialog.

The format (`beeslides/slides`, version `1`; files saved before 1.2.0 say
`slidomingo/slides`) is additive and stable: every version opens files from
every earlier version, and unknown fields are preserved.

## [Unreleased]

- **Claude Code and other AI apps outside BeeSlides (desktop app):** turn on
  Settings ▸ AI chat ▸ Advanced ▸ **Allow AI apps outside BeeSlides**, then
  install the BeeSlides plugin in Claude Code
  (`/plugin marketplace add miqsoft/beeslides`,
  `/plugin install beeslides@beeslides`). Claude Code in your own terminal
  then works on the decks open in BeeSlides with the same tools and skills
  as the built-in panel. Each app asks once before it connects; **Forget
  allowed apps** makes them ask again, and turning the setting off
  disconnects them all.
- **Claude Code without the BeeSlides window:** with BeeSlides closed (or
  the setting above off), the plugin starts a hidden BeeSlides for the chat.
  No window, no Dock icon: Claude opens the deck file you name (or makes a
  new one), every change is saved to it, and the hidden BeeSlides quits with
  the chat. It never opens the BeeSlides window from the terminal any more.
  Works over SSH and in scripts.
- **BeeSlides pane in Claude Code:** a pane beside the chat (`/beeslides`)
  opens as soon as Claude starts on a deck and shows what it is doing; without
  the BeeSlides window, each slide appears there as it is written. When
  Claude offers designs, the pane shows a picture of each with **Use 1 / 2 /
  3** and **Keep current**. Claude now
  learns which design you picked, in the pane or in the app, without asking.
- **Fixed:** the design compare view showed the wrong page number in a
  design's footer.
- **Looks come with their colours:** when Claude offers 2–3 looks for a
  deck, each one brings its own theme. Diagrams in the previews show in that
  look's colours (they used to keep the deck's old ones, unreadable on a
  dark look), and using a look sets the deck's colours and fonts in the same
  undo step. The compare view says so under each such look.
- **Better-looking decks from Claude:** Claude designs one look for the
  whole deck (a type pairing, a header strip and section numbers, colours
  that keep their meaning on every slide), writes all slides in it as one
  document, and draws diagrams for the content itself (packets in flight, a
  handshake over time, every state and arrow named) instead of reaching
  for the same stock boxes, starting with a bold cover. Claude's layout
  check now also catches an empty band under a title or an empty lower half
  of a slide. Looks start from five tested ones: Paper and ink, Editorial,
  Swiss, Soft panel and Lecture dark. A new deck Claude makes starts in
  calm near-black and teal.
- **Slides written as HTML look like the HTML:** a word in another typeface
  inside a text (a serif italic word in a bold title), lighter or heavier
  words, letter spacing and capitals set by CSS now stay as written;
  arrowheads on diagram lines come along as shapes; a hatched fill becomes a
  light tint instead of black; quotation marks added by CSS appear; a grid
  pattern over a dark background keeps the dark colour (the slide used to
  turn white); a heading beside a small bar no longer breaks onto two
  lines.
- **Fixed:** Claude Code did not get the line telling it whether BeeSlides
  runs with or without its window (the instruction was cut off).
- **Fixed:** the second to sixth theme accents were not available to slides
  written as HTML.
- **Questions as questions:** in Claude Code, Claude asks its questions about
  a new deck (purpose, length, how full a slide may be, the look) as choices
  to pick from, with its suggestion first. Say "no questions" or "just do
  it" and it asks nothing, states its assumptions and builds.
- **Claude builds calmer, more readable decks:** it asks one question about
  the deck (purpose, length, how full a slide may be) together with an
  outline. You pick the look from 2–3 designs, and it checks a first slide
  with you before writing the rest (slide types when you want a template).
  Talks get claims backed by charts and tables instead of big count-up
  numbers, and nothing the audience must read smaller than 16px. **Glow-up:** ask Claude to give a deck a new look; it keeps
  every word and number.
- **Copy for PowerPoint as editable shapes (desktop app):** Copy special ▸
  **1 PowerPoint** (⇧⌘C then 1, or Edit ▸ Copy as ▸ PowerPoint) puts the
  selected objects on the clipboard in PowerPoint's own format. Text boxes
  (with bold, italic, colours, links and bullets), shapes (with outlines,
  gradients, rotation and shadows), pictures (with crop), tables (with merged
  cells) and groups paste into PowerPoint as native objects you can edit;
  charts, diagrams and equations come along as pictures. Other apps get a
  picture. Tested on PowerPoint for Mac; on Windows it is untested so far.
- **Copy special:** ⇧⌘C / Ctrl+Shift+C (or right-click ▸ Copy special…)
  opens a small menu; press 2–6 to copy the selected objects, or the whole
  slide, as **2 Picture** (pastes into PowerPoint at the size it had on the
  slide, transparent around it), **3 PNG**, **4 SVG** (vector, for Figma or
  Illustrator), **5 SVG code** (as text) or **6 HTML** (text and tables stay
  editable text, for Word, mail or Google Docs; other objects come along as
  pictures). Every format is also under Edit ▸ Copy as, and each can get its
  own key in Keyboard shortcuts. Settings ▸ Copy special sets the picture
  resolution (1×, 2×, 4×), whether selected objects keep the slide's
  background, and text as outlines.

## [1.2.0] — 2026-10-23

Claude designs and builds slides as HTML, several chats can build one deck at
once, icon sets are a new kind of document, and a show takes edits while it
runs.

- **Claude can offer you design options for a slide:** ask for a few designs
  and Claude writes them (as HTML, laid out by the browser); you compare them
  side by side with the slide as it is, or one at a time in large, flip with
  the arrow keys, and use one with a click. Nothing changes until you pick,
  using one is a single undo step, and animations, links and comments on the
  slide stay. A ✨ on the slide's thumbnail brings the choice back later.
- **Claude can write a slide as plain HTML:** the new `slide_html` agent tool
  takes ordinary HTML and CSS (flexbox, grid, padding), lays it out in the
  browser and turns every box into normal, editable slide elements — text,
  boxes, pictures, tables, charts, code, SVG diagrams (as editable shapes)
  and embedded figures — so slides Claude builds line up exactly. An HTML
  slide deck can be converted slide by slide this way. It can also read any
  slide back as HTML, change it and write it again; animations, links and
  comments stay. Nothing in the HTML runs or
  loads from the network.
- **Slides from HTML keep their look:** blur and drop shadows, gradient text,
  layered backgrounds, soft radial glows, clipped shapes, `::before` /
  `::after`, outlined and vertical text and more now become slide elements
  instead of being dropped; anything that can't be kept is listed, one line
  each. Diagrams can be written as components (steps, sequence, cards,
  compare, flow) that fill the box they are given in the deck's colours, and
  `<hr data-arrow>` draws an arrow. When you don't say how a deck should
  look, Claude picks a short art direction (palette, type, one motif) first.
- **Several chats build one deck at once:** Claude splits a larger deck
  across parallel writers, each checking its own slides. Every chat sees
  which slides other chats are working on, and screenshots of other slides
  are taken off screen, so the editor no longer jumps around. Screenshots
  are cropped right at any UI zoom and can show just part of a slide.
  Claude Code chats now get all the built-in deck skills.
- **Code Mode (experimental, off by default):** in Settings ▸ AI ▸ Advanced,
  Claude can run a short program against the deck instead of one tool call
  per step. A program runs in a sandbox with no network, counts as one undo
  step and is rolled back if it fails.
- **The browser editor gets the desktop chrome:** in a desktop-width browser
  tab, BeeSlides now shows the same labelled ribbon as the desktop app and a
  menu bar (File, Edit, Insert, Slide, Arrange, View, Play, Help) drawn from
  the same commands, instead of a row of unlabelled icons. Icon sets get
  their Icons ribbon group and Icons menu in the browser too. ⌘P exports a
  PDF. Phones keep the compact top bar.
- **Icon sets:** a new kind of document for drawing your own icons, all in one
  style — a whole set or a single icon (start page ▸ Icons ▸ Icon set, desktop
  File ▸ New Icon Set… — it opens straight in the editor). Say what you need in your own words ("think about 12 icons for
  …"): Claude plans the icons, you check and edit the plan, then Claude draws
  them from editable shapes, several at once; comment on one icon or several to have them redrawn. Apply
  set style keeps stroke width, ends, corners and colour consistent. Export
  set writes 24 × 24 SVGs (colour follows the text, `currentColor`) with an
  `icons.json`; add that folder as an icon library and the icons are
  searchable by name and keyword, with their licence.
- **Icon sets — Style and Canvas in Home:** pick the style the icons are
  shown in right beside Plan with AI and Add icons (it replaces the "Show in"
  bar under the canvas), and make the icons square or another shape — 4:3,
  3:2, 16:9, 2:1 or portrait 3:4. Changing it keeps every drawing centred
  (one undo step); the export, the styles and Claude's drawing follow the
  new canvas.
- **The ribbon fits smaller windows:** instead of cutting off groups on the
  right, it drops button labels and folds big groups (Arrange) into one
  button that opens them.
- **Icon styles:** show the same icon set in more styles — Bold, Light,
  Solid, Duotone, Color, Comic, Sticker and Badge — without redrawing
  anything: every style paints the same drawings, so fixing an icon fixes it
  in all of them. Make your own: adjust any style (line weight and color,
  fills for the icon's body and accent; under More settings the details'
  fill, cut-out details, a hard shadow, a sticker border, a badge behind),
  learn one from an icon you painted by hand, or describe it and let Claude
  make it. Save styles to My styles to use them in every
  icon set, and share one with Copy style / Paste style. Compare all styles
  shows every icon in every style, on light or dark. Export writes one folder
  per style, listed in `icons.json`.
- **See and fine-tune icon styles on the canvas:** "Show in" (bottom left of
  the canvas) paints the icon you are editing — and the slide list — in any
  of the set's styles, while the shapes stay editable underneath. Select a
  shape to set its part (body, detail, accent — it counts in every style) or
  paint it its own way in just that style: its own fill, no fill, its own line
  color, or leave it out. The drawing and the other styles stay as they are; a
  • marks the icons with their own changes, and Compare all styles opens any
  icon in any style. Comments written while a style is shown remember it, and
  Claude is told which style a comment is about (it can change one icon in a
  style, too). Clicking now picks the line under the pointer in an icon set,
  not always the top shape.
- **Draw like the icons you like:** an icon set's Drawing section holds what
  Claude reads before it draws — the brief, example icons (add SVG files
  from any library: Claude draws new icons like them, and the set's line
  width, ends and corners follow them) and the line settings. Styles only
  repaint the drawings; a look that needs other shapes (hand-drawn, more
  detail) is a change in Drawing and a redraw, and Claude says so when asked
  for one.
- **Icon sets feel like an icon editor, not a deck:** the icon list is a grid
  of tiles with each icon's name underneath, and an icon not drawn yet shows
  what it is meant to show. View ▸ All icons shows the whole set by name, in
  any of its styles. The 24-unit grid is on by default (⌘G hides it; decks keep
  their own setting). Insert is a drawing toolbar — rectangle, ellipse,
  triangle, line, curve, freeform, polygon, shape presets — with nothing the
  export would leave out. An empty set's panel points you to the Claude chat
  (or Home ▸ Plan with AI) instead of a chat box of its own, an empty icon says so instead of showing blank previews, the
  set's own look is called "As drawn", and slide wording ("To slide", "Slide
  Sorter", "slide list", "Check slides") is gone from icon sets, the menu bar
  included (its Slide menu is Icons there).
- **Add icons the quick way:** click the + tile at the end of the icon grid
  and it becomes a new icon tile — type its name and press Enter, and the next
  one is ready. Paste a list to add them all at once; Esc stops. Plan with AI
  asks what the set is for in a small card and Claude plans the list. Empty
  icons show a faint circle instead of "Not drawn yet" on every tile. Text
  prompts (comments, names, Paste style) now look like the rest of the app
  instead of a plain browser box.
- **Edit while you present:** changes made during a show (by you, by
  Claude, undo, or a reload from disk) appear in the show right away. The
  slide on screen stays where it is, without replaying its entrance, and
  if it was deleted the show moves to the nearest slide. The speaker view
  follows.
- **More ways to present from the title bar:** the Present button has a
  dropdown, like Save: Present without Speaker View (desktop), Present in
  tab and Kiosk.
- **No more accidental slide deletes:** Duplicate and Delete on a slide
  thumbnail ask for a second click ("Delete?"). Keyboard, context menu and
  the Slide Sorter still act at once.
- **A calmer chat panel:** each tab is named after its chat, the header
  switches between open and earlier chats, and the terminal takes the app's
  warm colours with larger text. Ctrl+Tab steps through tabs.
- **Files say BeeSlides:** decks are now saved with `beeslides` names
  throughout. Files saved by earlier versions open as before and switch to
  the new names on their next save.
- **The MCP server is called `beeslides`:** Claude Code shows the tools as
  `mcp__beeslides__…`. An "always allow" given under the old name is asked
  once more.

### Fixes

- A fade no longer stays greyed out when the window stopped drawing
  mid-animation.
- Linux: the window lays out again after maximize, restore and full screen.
- Desktop: chats in the panel are saved and can be resumed when the app
  was started from a Claude Code session.
- Icon libraries with tens of thousands of icons no longer look like an
  unreachable server, and a refused request says why.
- `window.beeslides.loadDoc` applies the new deck's embedded fonts.

## [1.1.0] — 2026-10-14

- **Speaker view:** extra slides are marked clearly, the laser pointer has its
  own icon, and the timer has a visible reset button.
- **Outline View** is no longer offered in the interface.
- **Smoother shows:** slide changes no longer stall on animated drawings (an
  all-endless SVG is re-aligned instead of rebuilt), motion paths are measured
  once ahead of time, and an animation always starts from its first frame.
  Drawings on slides that are not on screen hold no animations, so a busy
  drawing such as the seasons demo stays at full frame rate.

## [1.0.0] — first public release

BeeSlides is a presentation app where one HTML file is the deck, the viewer
and the editor. It opens in any browser and runs offline; the desktop app
adds file handling, a Claude terminal and AI chat.

- **Editing:** text with rich formatting, lists, links and equations; shapes,
  a shape gallery, paths and connectors; tables with merged cells; charts;
  pictures with crop, flip, shadow and reflection; containers and groups;
  grid, guides and snapping; a format bar, a quick-format toolbar and Find
  and replace.
- **Layouts:** layouts with slide types (Slide Master style), a Layout
  Manager, one layout in several languages, and a library of reusable
  objects.
- **Presenting:** transitions, builds, morph, Slide/Section/Summary Zoom,
  drawing on slides, jump to slide, and a speaker view.
- **Import:** PowerPoint (tables, charts, layouts; lands on your own layout
  when it is the same design, and asks Claude only for what needs judgement)
  and Markdown/Quarto.
- **Files:** pictures, fonts and clips stored once per file; real
  thumbnails in the file manager; optional password protection; lossless
  picture optimisation; files from a newer BeeSlides open read-only.
- **AI:** the in-app agent edits decks through tools (it never writes SVG
  artwork); attach folders to chats; API chats with a Reasoning setting.
  Icon search across several sources, with license provenance.
- **Customize** menus, toolbar, keys and panels; accessibility checks (alt
  text, contrast).
- **Desktop app** for macOS, Windows and Linux, installed with
  `npm run setup`.
- **File ending:** decks end in `.beeslides.html`; `.slidomingo.html` decks from
  pre-release builds open as before.
