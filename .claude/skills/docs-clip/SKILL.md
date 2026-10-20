---
name: docs-clip
description: Create or update a docs walkthrough clip (short click-through videos on the BeeSlides docs site) for a feature — write site/clips/<id>.clip.mjs, record it, review the frames, embed it with <Walkthrough>. Use when asked to "make a clip/gif/video/walkthrough for <feature>", to document a feature visually, or when a clip broke after a UI change (npm run clips -- --check fails).
---

# Make a docs walkthrough clip

A clip is a SCRIPT, not a recording: `site/clips/<id>.clip.mjs` drives the
real desktop app (default; `--app web` = the single-file editor in Chromium); `site/scripts/record-clips.mjs` turns each step
into a short MP4 + poster in `site/public/clips/<id>/`. Read
`site/src/content/docs/contribute/docs.mdx` (the format) and
`site/clips/first-deck.clip.mjs` (a working example) first.

## 1. Learn the real UI — never guess labels or selectors

- English UI text is the i18n key itself: `t('Present in this tab')` in
  `slides/src/editor/*.ts`. Captions must quote labels exactly.
- Toolbar buttons: `[data-ui-tool="<id>"]` (ids in
  `slides/src/editor/customize/catalog.ts`). Panel rows:
  `page.locator('.ed-props label', { hasText: '<Label>' })`. Canvas elements:
  `.ed-canvas-wrap [data-el-id="<id>"]` (`el()` in `clips/lib/doc.mjs`).
  Thumbnails: `.ed-sidebar .ed-thumb`. Present pill: `.ed-present-pill`.
- `window.beeslides.menu.run('<command id>')` runs any menu command
  (`slides/src/editor/menumodel.ts`), useful in `setup`, never instead of
  the click the viewer is supposed to learn.
- Model JSON for `doc:` is specified in `docs/format.md`.

## 2. Write the scenario

- 3–6 steps, one idea each, 2–8 s. `caption` = the action in the user's words;
  `hint` = the shortcut or menu path.
- Start from a prepared `doc:` that shows only what the clip teaches.
- Scenarios use ONLY `ui` (raw CDP, same in both apps): `click / select /
  press('Mod+…') / type / nudge / hover / deselect / rest / command(id, path) /
  evaluate / waitFor`. Targets are CSS or `{ css, text }`. Move ELEMENTS with
  `ui.nudge`: synthetic drags do not drive Moveable
  (`slides/src/editor/CLAUDE.md`). Present with
  `ui.command('play.inTab', 'Play ▸ Present in tab')`, never fullscreen.
- Claude in the clip: `live: true`, `fixedViewport: false`, open the panel
  (`[data-ui-tool="terminal"]`), `const term = await ui.terminal()`,
  `term.type(prompt)`, `term.press('Enter')`, `term.waitForClaude()` in a
  step with `speedup`. Live clips record only when named.
- Always add `expect({ doc })` returning a reason string when the deck isn't
  in the state the captions promise.

## 3. Run, then LOOK

```sh
(cd slides && npm run build:single)          # if the build is stale or missing
(cd desktop && npx electron-vite build)      # desktop app (recording opens a window)
cd site
npm run clips -- --check <id>               # fast dry run; fix until "ok"
npm run clips -- --sheet <id>               # record + contact sheets
```

On FAIL, read `site/.clips-review/<id>-FAILED.png`. After recording, Read
EVERY `site/.clips-review/<id>-NN.jpg` (12 frames per step) and check each
step really shows its caption: right element highlighted, menu actually
open, result visible at the end, nothing cropped. Re-record until it does.
Do not claim a clip is done without having looked at its sheets.

## 4. Embed and verify

- Add `<Walkthrough clip="<id>" />` to the feature's page in
  `site/src/content/docs/` (import from `src/components/Walkthrough.astro`).
- `cd site && npm run build` must pass.
- Commit the scenario AND `site/public/clips/<id>/`; never `.clips-review/`.

## Many features at once

Each clip is independent: one subagent per feature can run steps 1–3 in
parallel (one Chromium each). Merge the page edits yourself afterwards.
