<p align="center">
  <a href="https://github.com/miqsoft/beeslides" title="BeeSlides on GitHub">
    <img src="docs/assets/beeslides-logo.svg" alt="BeeSlides: a bee whose stinger is the needle on a rainbow record" width="96" height="96">
  </a>
</p>

# BeeSlides — slides that fit in a file

**This PowerPoint alternative is a single HTML file.** A BeeSlides deck carries
its own viewer, presenter, and editor inside the document — open it in any
browser, edit it, present it, send it. The person you send it to needs
nothing: the file *is* the software.

**Get it:** clone this repo and run `npm run setup` — one command builds
BeeSlides and installs the desktop app with your other applications (see
[Install](#install)). The same run leaves the single
`BeeSlides.beeslides.html` (~1.3 MB) in `slides/dist-single/`: open it in any
modern browser and it *is* the editor, opening on a blank deck. Save, and it
rewrites itself with your deck inside.

## Why this exists

Office documents used to be things you *had*. Now they're things you rent —
locked in someone's cloud, behind someone's login, readable only while a
company keeps its servers on. BeeSlides takes the other path:

- **One file, forever.** Deck, fonts, images, charts, animations, and the
  full editor travel together. A copy from 2026 will open in 2036.
- **View-source honest.** Your data sits in a plain, readable JSON block at
  the top of the file. No binary formats, no lock-in, no archaeology.
- **It saves itself.** The file rewrites its own data block on save (File
  System Access API, with a download fallback). No app to install, ever.
- **Local-first, provably.** The app touches the network only for a
  document's own remote media references and for icon servers you add
  yourself; the desktop app's AI chat talks only to the provider you set up.
  Offline mode switches all of it off — then nothing leaves your machine.

## What's inside

| Feature | Description |
|---|---|
| **Morph presenting** | Elements that share an id animate between slides — position, size, color, even gradients. Duplicate a slide, rearrange, and the motion designs itself. |
| **Charts, built in** | Bar / line / pie / scatter drawn by our own dependency-free engine, live during presentations: tooltips, zoom, and data that morphs when a bar chart becomes a pie. |
| **Designed for AI** | The document is plain JSON in the file, so agents edit `.beeslides.html` files in place and chatbots round-trip the JSON (`window.slidomingo.loadDoc`). See [docs/agents.md](docs/agents.md). |
| **Everything else** | Speaker view, comments, layouts, hidden interactive states, hover reveals, motion paths, PDF export, page sizes, 9 UI languages — in a self-contained shell with no network dependency. |

## Use it with AI

Because the document is plain JSON living in one plaintext block near the top
of the file, any assistant that can read and write a file can edit your deck —
no plugin, no API. Two ways in:

- **File harnesses** edit the `#slidomingo-doc` JSON in place:
  [Claude Code](https://claude.com/claude-code), Cursor, Aider, or any agent
  with filesystem access. See this repo's own skill/plugin setup for
  installing the packaged `slidomingo-slides` skill for Claude Code.
- **Chat round-trip** for any chatbot: copy the document JSON out (*Save →
  Copy document JSON*), let the assistant rewrite it, paste it back.

**It works fully offline with local open-weight models** — point
[Ollama](https://ollama.com), llama.cpp, or LM Studio at the deck and nothing
leaves your machine. The agent guide is a single page you can drop into any
model's context: [docs/agents.md](docs/agents.md).

## Architecture in one paragraph

`slides/src/model.ts` defines the JSON document model; one renderer
(`render.ts`) draws it for the editor canvas, thumbnails, and present mode
(Reveal.js drives navigation; morphs are computed from the model, not the
DOM). Animation is an in-house engine (`anim.ts`), charts are in-house
(`charts.ts`). The shell compresses to well under a megabyte with the
document block left as plaintext so old files and outside tools can always
splice it. The deep dive: [docs/architecture.md](docs/architecture.md).

## Security model, honestly

- No server, ever. The app touches the network only through one chokepoint
  (`kernel/src/net.ts`): a document's own remote media references, and icon
  servers you configure. A test rig (`scripts/test-offline.ts`) fails if any
  other file calls `fetch`/`WebSocket` directly. The desktop app's optional
  AI chat calls only the AI provider you configure.
- Password encryption (AES-GCM-256, PBKDF2-SHA-256) protects a file at rest;
  the password lives only in memory. See [docs/security.md](docs/security.md).
- Editing is desktop-first (phones view and present well).

## Install

One command builds BeeSlides from source and installs the desktop app, so it
shows up with your other applications:

```bash
git clone https://github.com/miqsoft/beeslides.git
cd beeslides
npm run setup
```

| | Installs to | You need |
|---|---|---|
| **macOS** | `/Applications/BeeSlides.app` (Launchpad, Spotlight) | [Node.js](https://nodejs.org) 22.12+ |
| **Windows** | your user's Programs folder, with a Start menu entry | Node.js 22.12+ |
| **Linux** | `~/.local/share/beeslides`, an applications-menu entry and `~/.local/bin/beeslides` | Node.js 22.12+, `build-essential` (or `gcc-c++` + `make`) and `python3` |

Nothing is downloaded pre-built and nothing is signed: an app built on your
own machine opens without a security warning. To update, `git pull` and run
`npm run setup` again; `npm run setup -- --uninstall` removes the app and
keeps your settings. The same run also leaves the single-file editor at
`slides/dist-single/BeeSlides.beeslides.html`, which needs no install at all.

### Developing

```bash
cd slides
npm install
npm run dev            # dev server (http://localhost:5173)
npm run build:single   # → dist-single/BeeSlides.beeslides.html (the product)
```

See [docs/RELEASING.md](docs/RELEASING.md) for the release process.

## Where to read more

- [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md) — how to work in this repo,
  for people and AI coding tools; subsystem details live in
  `slides/src/CLAUDE.md`, `slides/src/editor/CLAUDE.md` and `desktop/CLAUDE.md`.
- [docs/architecture.md](docs/architecture.md) — how a `.beeslides.html` file is
  built, the on-disk format, and the runtime layout.
- [docs/format.md](docs/format.md) — the normative `slidomingo/slides` document-model
  spec (every element type, slide/state/layout shape).
- [docs/agents.md](docs/agents.md) — the document format, for AI agents.
- [CHANGELOG.md](CHANGELOG.md) — the version history.
- **Layout:** `slides/` is the app (source in `slides/src/`); `docs/` and
  `scripts/` are the guides and build tooling.

Contributions welcome — start with [CONTRIBUTING.md](CONTRIBUTING.md). Found a
security issue? See [SECURITY.md](SECURITY.md).

## Community

- **Questions and help** — [Discussions →
  Q&A](https://github.com/miqsoft/beeslides/discussions/categories/q-a)
- **Ideas and feature requests** — [Discussions →
  Ideas](https://github.com/miqsoft/beeslides/discussions/categories/ideas)
- **Built something with BeeSlides?** — [Show and
  tell](https://github.com/miqsoft/beeslides/discussions/categories/show-and-tell)
- **Bugs** — [open an issue](https://github.com/miqsoft/beeslides/issues).
  Security issues go through [SECURITY.md](SECURITY.md) instead, never a
  public issue.

Planning a substantial contribution? Check the open issues and PRs first, and
say what you're planning before you build it — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

BeeSlides is a PowerPoint alternative, shipping now. Notes and spreadsheet
apps built the same way — one self-contained HTML file each — may follow.

## Acknowledgements

BeeSlides reuses parts of the code of [Bento](https://github.com/nyblnet/bento)
by nyblnet and its contributors, under the MIT License; its copyright notice
is kept in [LICENSING.md](LICENSING.md) and in every built file.

## License

BeeSlides is free software under the [GNU Affero General Public License
v3.0 or later](LICENSE), © 2026 The BeeSlides authors. It is free to use for
everyone, companies included; if you distribute a modified version or run one
as a service, you have to publish your source under the AGPL too. Commercial
licenses are available.

**Your documents are yours.** An additional permission lets you share
BeeSlides files freely, and keeps their content out of the AGPL. See
[LICENSING.md](LICENSING.md) for the details and the MIT-licensed code
inherited from Bento.

Bundled runtime components (reveal.js, Moveable, Selecto, Temml) are MIT; the
embedded typefaces (Fraunces, Instrument Sans) are OFL; gallery imagery is
public-domain (see `scripts/gallery-photos/SOURCES.md`). Each component keeps
its own license.
