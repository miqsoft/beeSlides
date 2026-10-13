# Releasing a BeeSlides app

BeeSlides has not cut a public release yet. This is the process for the
first ones: a release is a tagged commit plus the built single-file shell
attached to a GitHub release. There is no update server, no signed manifest
and no download channel — shipped files never check for updates (removed in
the 2026-09 decoupling, see `docs/DECISIONS.md`).

## Cutting a release

1. **Get the CHANGELOG right.** Move the `[Unreleased]` entries into a new
   `## [X.Y.Z] — YYYY-MM-DD` section. Lead with what the release *is*
   (features), not the last thing merged, and drop entries for bugs that were
   introduced and fixed inside the same unreleased cycle.
2. **Bump the app's `package.json` version** (`slides/package.json`). It
   becomes `APP_VERSION`, shown in the About dialog. Apps version
   independently.
3. **Tag, then build from a clean checkout of the tag**, not from a working
   tree that may hold other branches' work:

   ```sh
   git tag vX.Y.Z <commit>
   git worktree add /tmp/rel vX.Y.Z --detach
   cd /tmp/rel/slides && npm ci && npm run build:single
   ```

   Slides uses bare `vX.Y.Z` tags; other apps are prefixed (`spaces-vX.Y.Z`,
   `dash-vX.Y.Z`) so their tags never sort into slides' history.
4. **Push only that tag** — never `--tags`, which also pushes scratch tags:

   ```sh
   git push origin vX.Y.Z
   ```

5. **Create the GitHub release** with the shell and the viewer attached and
   the CHANGELOG section as the notes:

   ```sh
   gh release create vX.Y.Z \
     slides/dist-single/BeeSlides.beeslides.html \
     slides/dist-viewer/BeeSlides_Viewer.beeslides.html \
     --title "BeeSlides vX.Y.Z" --notes-file <notes.md>
   ```

6. **Smoke-test the downloaded asset**, not the local build: open it in a
   browser, edit, save, reopen.

## Rules

- Versions only go up; a rollback is a new, higher version that reverts the
  code.
- The format is additive (`docs/PLATFORM.md`): every release must open files
  saved by every earlier one. `scripts/shell-gate.mjs` checks the splice
  contract on a built shell.

## Adding a UI string

New strings go in ALL core catalogs (`slides/src/i18n/*.ts`), and
`slides/src/i18n/packed.ts` is GENERATED — regenerate it after editing:

```sh
node scripts/build-i18n.mjs
node scripts/test-i18n-coverage.mjs
```
