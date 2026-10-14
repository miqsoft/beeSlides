# Changelog

All notable changes to BeeSlides. The app version is baked into every shell
as `APP_VERSION` (from `slides/package.json`) and shown in the About dialog.

The format (`slidomingo/slides`, version `1`) is additive and stable: every
version opens files from every earlier version, and unknown fields are
preserved.

## [Unreleased]

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
