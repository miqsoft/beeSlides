# Working in this repo

BeeSlides: presentations as single self-contained HTML files (document +
viewer + editor). `slides/` = the app, `desktop/` = Electron shell,
`kernel/` = shared runtime, `scripts/` = build + test rigs, `docs/` = specs.

Read before non-trivial work: `docs/PLATFORM.md` (invariants),
`docs/PARALLEL-WORK.md` (branch discipline), `docs/DECISIONS.md` (settled —
append, don't relitigate). Subsystem notes: `slides/src/CLAUDE.md`,
`slides/src/editor/CLAUDE.md`, `desktop/CLAUDE.md` (plain Markdown, any tool).

**Naming:** prose and UI say BeeSlides; internal identifiers stay `slidomingo`
(format string, `#slidomingo-doc`, `window.slidomingo`, storage/IPC/CSS
prefixes) — saved files depend on them. Recognise both `.beeslides.html` and
`.slidomingo.html` (`kernel/src/docext.ts`).

## Hard rules

1. No literal `</script>` in a bundle or doc block (JSON escapes `<`).
2. `#slidomingo-doc` stays plaintext, same id, regex-extractable (splice contract).
3. Never regenerate a document's `docId`.
4. Encrypted decks never carry a plaintext preview; run
   `node scripts/test-preview.ts` after touching save/preview.
5. New UI strings go into ALL i18n catalogs; never `t()` in module-level
   consts. The locale list is `LOCALES` in `<app>/scripts/build-*-i18n.mjs` —
   never trust a count in prose.
6. Never edit `dist-single/` (generated).
7. A person authors every commit; AI only as `Co-Authored-By:`.
8. No release/publish/deploy unless the maintainer asks (`docs/RELEASING.md`).
9. External PRs: check provenance (`gh api users/<login>`); no autonomous bot PRs.
10. Verify before claiming done: typecheck, build, exercise user-visible changes.

## Commands

```sh
cd slides && npm install
npm run dev                  # dev server (ports in .claude/launch.json)
npm run build:single         # → dist-single/BeeSlides.beeslides.html
node_modules/.bin/tsc -b     # typecheck
cd .. && npm test            # all rigs via scripts/run-tests.mjs
```

In-page API: `window.slidomingo` → `{ doc, serialize() }`.
