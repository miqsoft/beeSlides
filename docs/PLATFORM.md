# The BeeSlides platform — invariants every app must honor

BeeSlides is growing from one app (Slides) into a suite (Spaces, Dash, …). This
document is the contract that makes them all *BeeSlides*: the properties a file
must keep so that shipped documents — including ones saved years ago —
continue to open and save. **Breaking an invariant here doesn't break the
build; it bricks files that are already on users' disks.**

`slides/` is the reference implementation for everything below. When this doc
and the code disagree, the code that *shipped* wins — fix the doc.

> **Decoupling note (2026-09):** this app no longer phones home to any
> external service. Self-update checking, live E2EE collaboration/sync, and
> downloadable language packs were deleted outright — not renamed, not
> feature-flagged — to make the app fully self-contained and offline by
> construction. What used to be §5 (Collaboration) and §6 (Signed self-update)
> in this document are gone; see `docs/DECISIONS.md` for the dated entry. Any
> reference below to a relay, a manifest, or a language pack describes
> history, not a live capability.

## 1. One file is the product

A BeeSlides document is a single self-contained HTML file carrying the document
data and the viewer. The editor is the desktop app: a file the desktop app writes
carries a viewer-only runtime (`slides/dist-viewer`, ~530 KB vs the ~965 KB editor
shell), and the desktop opens any such file in its own editor. A browser-hosted
editor shell (`dist-single`) still exists and still writes editor files; both
satisfy every rule below (DECISIONS 2026-10-07). It must work from `file://`, from a static
host, and from an email attachment — no backend, no CDN, no network required
to open, edit, present, or save. Anything that adds a runtime network
dependency to the core document lifecycle is off-platform.

Byte order of a shipped shell (postbuild-compress):
`chrome → NOTICE → tooling comment → plaintext #beeslides-doc → splash → compressed payloads`.
A saved plaintext file adds `#beeslides-assets` right after the doc block, and
the preview and static layer after the splash.

**Self-contained does not mean "all in the JSON".** In a plaintext file,
`#beeslides-doc` may refer to embedded bytes stored ONCE elsewhere in the
same file — the asset store (`kernel/src/assetstore.ts`): a
`<style id="beeslides-assets">` of CSS rules, plus the static layer's own
media elements — as `"beeslides-store:sha256-<16hex>"` strings, and says so in
`requires: ["asset-store"]`. Nothing is fetched; the file is still one file.
Every reader resolves the refs from the file it read (the kernel's
`resolveDocText`/`readEmbeddedDoc`), so the in-memory document always holds
the bytes. An encrypted file never has a store.
Runtime JS/CSS ship deflated in `beeslides/deflate-b64` script blocks with a ~1KB
loader (DecompressionStream → blob import).

## 2. The splice contract (FROZEN)

Self-save works by re-splicing the document block into the shell. Files
already on users' disks depend on this shape staying exactly as it is, so
every future build of every app must keep:

- a `<script type="application/beeslides+json" id="beeslides-doc">` block that is
  **plaintext** (never inside the compressed payloads), same id from now on.
  Files saved before 2026-10-20 carry `<script type="application/slidomingo+json"
  id="slidomingo-doc">`; every reader accepts that block too, and a file takes
  the new names on its next save — except a file whose OWN shell is old (a
  library file written back in place), which keeps the names its runtime
  reads (`kernel/src/legacynames.ts`, DECISIONS 2026-10-20);
- block content that is JSON with `<` escaped as `<` — it can never
  contain `</script>`;
- the SAME escaping on every other plaintext data block the shell carries
  (`application/beeslides+*`, written by `registerShellBlocks` in kernel
  `save.ts` — generic machinery kept for any future block type, unused by
  any app today): their bodies are not authored by us, so an unescaped one
  could close its own block or forge a second `#beeslides-doc` opening tag;
- a file that survives `DOMParser → splice → outerHTML` round-trips, with
  balanced script tags and a v0.1.0-style *text* splice still producing a
  well-formed document.

`scripts/shell-gate.mjs` is the conformance gate for all of this (the viewer
build runs it). New apps must run the same gate (or an app-specific
equivalent with identical checks) before any release.

## 3. Document identity & format

- `doc.format` names the format (`beeslides/slides`, `beeslides/spaces`; `beeslides/dash`
  to come) with an integer format version in `doc.version`. The field is
  `format` — `slides/src/model.ts` exports `FORMAT = 'beeslides/slides'` and writes
  it as `format`, and every reader keys off that. A file saved before
  2026-10-20 says `slidomingo/slides` (and `slidomingo/enc`); `parseDoc`
  renames it on read (`currentFormat`, `kernel/src/legacynames.ts`).
- **Formats are additive.** Every version opens files from every earlier
  version; unknown fields are preserved, not stripped. A change that an older
  reader would silently lose on save (the asset store's refs are the first)
  ships behind a `requires` name (below), never as a quiet reshape. Breaking reads of old
  files is not an option — there is no server to migrate them.
- **The reader gate: `requires`.** A document may list, in `requires`, the
  format features a reader must understand to write it back. A reader that
  meets a name it does not know opens the document **read-only**: it never
  saves it, never snapshots it, and never merges any part of it into another
  document. The kernel enforces the write half (`serializeBody` throws
  `UnsupportedFeaturesError`; apps declare what they know with
  `registerKnownFeatures`). A writer lists a feature only when the file uses
  it, and only for one an older reader would lose on save. This is what lets
  the format change shape without an older app destroying a newer file.
- `docId` (uuid) is minted once at creation/load and never regenerated. It
  keys autosave recovery. "Duplicate as new deck"-style flows mint a fresh
  `docId` — that is the *only* sanctioned way an id changes.
- Locale/language never enters the document format; i18n follows the viewer.

## 4. Save, autosave, encryption

- Self-save: capture the pristine shell at boot, swap the `#beeslides-doc` block,
  re-serialize. File System Access API first, download fallback.
- **Runtime-injected DOM must be marked `data-beeslides-transient`.** The pristine
  capture clones the LIVE document, so anything the runtime adds before it —
  the compressed shell's inflated stylesheet, first of all — would otherwise be
  written into the saved file, then re-injected on the next boot and saved
  again: unbounded growth, one copy per save (~100KB each for the CSS, which
  ships deflated for a reason). `serializeBody` strips the marked nodes from
  every serialized shell. Inject before the capture only if you mark it —
  `scripts/shell-gate.mjs` proves both halves on every CI build (the loader
  marks what it injects; the runtime still strips it) and rejects a shell that
  carries any payload's content as plaintext.
- Autosave (IndexedDB) keeps a latest-recovery snapshot + a capped version
  timeline, keyed by `docId`. Read-only players skip autosave. A version may
  carry a `label` (a short code such as `'opened'`/`'saved'`, translated at
  render time, never a display string) and `keep: true`, which exempts it from
  the timeline cap (kept checkpoints have their own, smaller cap). A version
  identical to the newest is not stored twice. Both fields are additive: no
  `DB_VERSION` bump, and older shells ignore them.
- A host whose live page is not a shippable shell (the desktop app's Vite dev
  page) must hand the kernel a real built shell via `adoptPristineHtml(html)`
  before any save — splicing a dev page into a user's deck would brick it.
- Password-protected docs use the `beeslides/enc` envelope (PBKDF2-SHA-256 300k →
  AES-GCM-256 over the doc JSON) *inside* the plaintext block — the splice
  contract still holds. **Encrypted docs are never snapshotted to IndexedDB in
  plaintext**, and every write-back path stays encrypted while the password is
  held in memory.

## 5. AI round-trip

The **document JSON** is the interchange unit for AI tooling — chat models
can't emit multi-MB files. In a saved file the JSON may hold asset-store refs
(`beeslides-store:…`) instead of picture bytes; a tool editing the file in
place leaves refs and `#beeslides-assets` alone, and may always write new
pictures inline as `data:` URIs (the next save stores them). The block is
written readable (`canonicalJson`: indented, content-ordered keys). "Copy
document JSON" has a light variant with every embedded byte as a ref;
Replace from JSON / `loadDoc` resolve refs by content hash against the open
document and keep (and report) any they cannot. Every app exposes: copy document JSON / replace
document from JSON (undoable), plus a scripting surface on `window.beeslides`
(`doc`, `serialize()`, `loadDoc(json)`, …). The shell carries a tooling
comment pointing agents at `#beeslides-doc` and this API. Keep model JSON pure
data — template strings over functions (see charts: formatters are `{b}/{c}`
templates, never code).

## 6. i18n

~1KB `t()` with English-string-as-key (missing key = English). Never call
`t()` at module scope (frozen at import). `select()` localizes display labels
only — model values stay English words. Audit with `setLocale('x-pseudo')`.

All catalogs are **bundled core** — compiled in. The per-locale files under
`slides/src/i18n/` are the authored source, packed key-once into `packed.ts`
by `scripts/build-i18n.mjs` (CI gates that it is current). New UI strings
must land in **all** core catalogs in the same PR, and the catalog falls back
per string to the English key, which is what lets a partial translation
degrade instead of break. There is no runtime-downloaded language pack tier —
every language a file offers ships inside it.

### Direction (RTL) — two halves, never confuse them

**Content direction belongs to the DOCUMENT and is per element.** Text
resolves its own base direction from what the author typed (`dir="auto"` in
the renderer), so an Arabic paragraph reads RTL beside an English one in the
same file. This is data: it renders identically for every viewer, and it is
the half that fixes real bugs (misplaced sentence-final punctuation).

**Chrome direction belongs to the VIEWER and never enters the format.** The
editor flips to RTL when the viewer's locale is RTL — the same viewer-scoped
pattern as `slidomingo-lang` and reduce-motion. `applyDirection()` runs AFTER
`capturePristine()`, so a saved file can never carry a `dir` attribute. Lay
chrome out with logical properties (`inset-inline-start`, `margin-inline-end`,
`text-align: start`) and it mirrors itself; only glyphs that encode a
direction in their SHAPE need flipping by hand.

> **INVARIANT — the document never mirrors.** Elements carry absolute x/y
> model coordinates, so a document MUST render identically regardless of who
> opens it. A document whose appearance depends on the viewer's locale is a
> format-level bug, and a worse outcome than an unmirrored UI. Every surface
> that renders document content is therefore pinned `direction: ltr`: the
> document root, thumbnails, the scroller, the present overlay, print, and any
> body-mounted overlay that reads coordinates (e.g. Moveable's control box,
> which mounts outside the document subtree and needs its own pin).
>
> An app adding a new document-rendering surface MUST pin it. The pin is also
> what keeps direction away from `scrollLeft` — the one layout API whose
> meaning genuinely changes under RTL — so coordinate math stays untouched.

## 7. What is kernel vs what is app

Shared — **`kernel/src/`**, extracted and in use (evolve carefully, serialize
changes — see `docs/PARALLEL-WORK.md`): `save.ts` (splice + beeslides/enc
encryption), `autosave.ts`, `net.ts` (the one network chokepoint + the
offline switch), `anim.ts`, `charts.ts`, the `i18n.ts` engine, `app.ts`
(per-app identity via `configureApp`), `doc.ts` (the `KernelDoc` envelope).
Apps import these through facades at their own paths.

Shared build tooling: `scripts/postbuild-compress.mjs` (parameterised per app
via `--generator` / `--title`) and `scripts/shell-gate.mjs`.

Per-app (own it, don't prematurely abstract):
the document model, the renderer, the editor UX, starter documents, panels.

## 8. New-app checklist

A new BeeSlides app is on-platform when it:

- [ ] builds to ONE self-contained HTML file passing the §2 conformance gate
- [ ] declares `doc.format` + `doc.version`; opens its own older files
- [ ] mints and preserves `docId` per §3
- [ ] self-saves (FSA + download) and autosaves per §4
- [ ] supports the `beeslides/enc` envelope per §4 (or explicitly documents why not yet)
- [ ] exposes the AI round-trip surface per §5
- [ ] uses the shared i18n runtime per §6
- [ ] has a starter document that demos the app honestly
- [ ] documents its model in its own CLAUDE/README section
- [ ] touches the network only through `kernel/src/net.ts`, if at all — see
      `scripts/test-offline.ts`, which fails the build on a direct
      `fetch`/`WebSocket` call anywhere else
