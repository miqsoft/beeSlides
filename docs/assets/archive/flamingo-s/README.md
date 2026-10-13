# Archive: the Flamingo S (retired)

<p><img src="beeslides-logo.svg" alt="The Flamingo S" width="96" height="96"></p>

The letter S drawn as a flamingo on a night-aubergine tile. It was the
BeeSlides mark from **2026-09-24** (commit `ea4fad5d`, "New logo: the
Flamingo S, flamingo palette, one wordmark") until **2026-09-28**, when the
Slides app became **BeeSlides** and took the Needle Bee mark. Why it was
chosen, and how its splash worked:
[DECISIONS.md, 2026-09-24 — Brand: the Flamingo S mark](../../../DECISIONS.md#2026-09-24--brand-the-flamingo-s-mark-flamingo-palette-one-wordmark).

The git tag `brand/flamingo-s` marks the last `main` commit that shipped it.

## Files

| File | What it is |
|---|---|
| `beeslides-logo.svg` | The README asset, 112px, as generated from `brand.ts`. |
| `icon-1024.png` | The desktop app icon (`desktop/build/icon.png`): 824px tile on the 1024 macOS grid, transparent corners. |
| `brand.flamingo-s.ts` | `slides/src/brand.ts` verbatim, plus one archival header line. It sits outside every tsconfig `include`, and nothing imports it. |
| `splash.flamingo-s.html` | The boot splash (markup + CSS from `slides/index.html`) as a standalone page. Open it in a browser; click or press R to replay the intro. |

## Palette

| Key | Colour | Use |
|---|---|---|
| `night` | `#1D1119` | tile, ink on light |
| `aubergine` | `#4A2242` | tile glow |
| `TILE_EDGE` | `#190F17` | tile outer stop |
| `blush` | `#FFB3C4` | neck highlight |
| `flamingo` | `#FF7098` | primary; "mingo" on dark |
| `deep` | `#EC4679` | body shade |
| `wing` | `#D8336A` | wing |
| `mingoOnLight` | `#E23D72` | "mingo" on light; the new-deck default accent |
| `cream` | `#FFF0EA` | "Slido" on dark |

Chrome tokens of that era (light): `--accent #FF7098`, `--accent-text
#C43163`, `--chrome #FAF6F7`, `--ink #1D1119`, `--muted #76606C`; the
2026-09-24 "chrome palette follows the brand" entry in DECISIONS.md has the
full set.

## Restoring it

1. Copy `brand.flamingo-s.ts` over `slides/src/brand.ts` and delete its first
   (archival) line.
2. Put the splash CSS back: the `<style>` block in `splash.flamingo-s.html`
   replaces the one after `#slidomingo-splash` in `slides/index.html` (it is
   hand-written and targets `.sm-r1..3`, `.sm-head`, `.sm-eye`), and restore
   the 9s `bsAuto` auto-hide on `#slidomingo-splash` that the archive copy
   drops. The word becomes `Slido<b>mingo</b>` again.
3. Run `node scripts/build-brand-assets.mjs` to regenerate the favicon, the
   splash SVG and `docs/assets/beeslides-logo.svg`.
4. Copy `icon-1024.png` to `desktop/build/icon.png`.
5. The wordmark class was `.sm-mingo` in `slides/src/styles.css`; the chrome
   tokens and the Starter/Showcase palette are in the commits after
   `ea4fad5d` (`git show brand/flamingo-s:slides/src/styles.css`).
