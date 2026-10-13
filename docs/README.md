# BeeSlides docs

Engineering and format documentation for BeeSlides. Start here.

User-facing how-to docs (with click-through clips) live in the docs site,
[`site/`](../site/) — published at <https://miqsoft.github.io/beeslides/>.

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | How a `.beeslides.html` file is built, the on-disk anatomy, the self-save loop, and the runtime layout. |
| [format.md](format.md) | **Normative reference for the `slidomingo/slides` JSON document model** — every element type, slide/state/layout shape, `fx`. The format IS the product. |
| [agents.md](agents.md) | The AI-agent guide: how to author a *great* deck (mapping content to the right feature), the schema, and copy-paste recipes. |
| [security.md](security.md) | The security posture: the file as the security boundary, password encryption, offline mode. |
| [RELEASING.md](RELEASING.md) | How a release is cut: tag, build, attach the shell to a GitHub release. |

Related, outside `docs/`:

- [../CLAUDE.md](../CLAUDE.md) — the deep, module-by-module development guide
  with the hard-won gotchas (also what AI agents read to work in this repo).
- [../slides/src/CLAUDE.md](../slides/src/CLAUDE.md) — document model,
  renderer, save/autosave/preview, present-mode effects, and other
  `slides/src/` internals.
- [../slides/src/editor/CLAUDE.md](../slides/src/editor/CLAUDE.md) — editor
  UI/interaction internals and the editor-DOM "do not regress" gotchas.
- [../desktop/CLAUDE.md](../desktop/CLAUDE.md) — the Electron shell +
  terminal panel.
- [../CHANGELOG.md](../CHANGELOG.md) — the version history.
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — setup, conventions, the splice
  contract, and how to open a PR.
- [../SECURITY.md](../SECURITY.md) — the security posture and how to report a
  vulnerability.
