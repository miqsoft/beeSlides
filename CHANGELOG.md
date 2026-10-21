# Changelog

All notable changes to BeeSlides. The app version is baked into every shell
as `APP_VERSION` (from `slides/package.json`) and shown in the About dialog.

The format (`slidomingo/slides`, version `1`) is additive and stable: every
version opens files from every earlier version, and unknown fields are
preserved.

## [Unreleased]

- **Claude can write a slide as plain HTML:** the new `slide_html` agent tool
  takes ordinary HTML and CSS (flexbox, grid, padding), lays it out in the
  browser and turns every box into normal, editable slide elements — text,
  boxes, pictures, tables, charts, code, SVG diagrams (as editable shapes)
  and embedded figures — so slides Claude builds line up exactly. An HTML
  slide deck can be converted slide by slide this way. It can also read any slide back as HTML, change it and write it
  again; animations, links and comments stay. Nothing in the HTML runs or
  loads from the network.
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
