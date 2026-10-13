// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert markdown fixtures — `.qmd` sources written IN SOURCE, same
// rule the .pptx fixtures follow (no binary in the repo, every fixture
// readable). Shared by the markdown rig (scripts/test-convert/qmd.ts, which
// asserts content + layout linkage + the exact report set) and the loadability
// gate (scripts/test-convert/load.ts). The underscore prefix keeps the suite
// runner from executing this as a rig of its own.

/**
 * A PNG whose IHDR says `w`x`h`.
 *
 * HEADER-ONLY BY DESIGN. `imageSize` reads bytes 16..24 and nothing else, and
 * these fixtures exist to pin the aspect-ratio math — so a real encoder (and a
 * zlib dependency in a zero-dependency engine's test rig) buys nothing. No rig
 * decodes it; a rig that ever needs to must build a real one.
 */
export function fakePng(w: number, h: number): Uint8Array {
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  return new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
    ...be(13), 0x49, 0x48, 0x44, 0x52, // IHDR length + type
    ...be(w), ...be(h),
    8, 6, 0, 0, 0, // bit depth, colour type, compression, filter, interlace
    0, 0, 0, 0, // (CRC placeholder — nothing here verifies it)
    ...be(0), 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82, // IEND
  ])
}

/** The kitchen-sink deck: front matter, a section, math, a cell, a table, a
 *  callout, columns, a figure, an incremental list and a pause. */
export const MD_FULL = `---
title: "Bayesian Workflow"
subtitle: "A practical tour"
author:
  - Ada Lovelace
  - Grace Hopper
institute: Institute for Advanced Study
date: 2026-09-10
bibliography: refs.bib
format:
  revealjs:
    theme: dark
    slide-level: 2
---

# Motivation

## Why bother? {.smaller}

Posterior inference states $p(\\theta \\mid y)$ directly [@gelman2013].

- Priors are explicit
- Uncertainty is a distribution
  - not an interval afterthought

. . .

And it composes.

## The model

$$
p(\\theta \\mid y) = \\frac{p(y \\mid \\theta)\\, p(\\theta)}{p(y)}
$$

::: {.notes}
Mention the normalising constant.
:::

## Fitting it

\`\`\`{r}
#| echo: true
fit <- brm(y ~ x, data = d)
summary(fit)
\`\`\`

## Results

| Parameter | Estimate |   SE |
|:----------|---------:|-----:|
| intercept |     1.42 | 0.11 |
| slope     |    -0.38 | 0.04 |

::: {.callout-warning title="Convergence"}
Two chains failed to mix.
:::

## Two ways

::: {.columns}
::: {.column width="50%"}
Simulate before seeing data.
:::
::: {.column width="50%"}
Simulate after.
:::
:::

## The plot

![Posterior draws for the slope](figs/slope.png)

## Step by step

::: {.incremental}
- first
- then
:::

## Fin {background-color="#101010"}

\`\`\`python
def elpd(draws):
    return draws.mean()
\`\`\`
`

/** Plain markdown: no front matter, no Quarto anything. The "I just have a
 *  README" case, which must still produce a real deck. */
export const MD_PLAIN = `# Release notes

Shipped this week.

## Fixed

- the thing
- the other thing

## Next

More things.

***

A slide with no heading at all.
`

/** Pandoc's own `--to markdown` shape for an EXECUTED cell: the code is a
 *  `.cell-code` fence (classes, not a bare language, so nothing is "not run")
 *  and the result is a `.cell-output` fence plus a figure. */
export const MD_RENDERED = `---
title: Rendered
---

## Output

::: {.cell}

\`\`\`{.r .cell-code}
summary(cars)
\`\`\`

::: {.cell-output .cell-output-stdout}
\`\`\`
     speed           dist
 Min.   : 4.0   Min.   :  2.00
\`\`\`
:::

::: {.cell-output-display}
![](deck_files/figure-markdown/plot-1.png){width=70%}
:::

:::
`

/** Nothing an importer can use — the empty-source floor. */
export const MD_EMPTY = '   \n\n'

/** Deliberately hostile: an unknown fenced div, a reveal-only attribute, raw
 *  HTML, a footnote, an inline image, a link, a blockquote, an unresolved
 *  figure and a setext heading. Every one of these must land in the report. */
export const MD_EDGES = `---
title: Edges
---

## Odd bits {background-video="clip.mp4" transition="zoom"}

::: {.mystery-wrapper}
Inside something nobody mapped.
:::

Text with a [link](https://example.org), a footnote[^1] and an inline ![pic](inline.png).

[^1]: The note body.

> A quote.

<div class="raw">Untouchable.</div>

![Missing](nope.png)

Setext slide
------------

Under the underline.
`

export function allMarkdownFixtures(): Array<{
  name: string
  source: string
  assets?: Record<string, Uint8Array>
}> {
  return [
    { name: 'md-full', source: MD_FULL, assets: { 'figs/slope.png': fakePng(800, 600) } },
    { name: 'md-full-nofigs', source: MD_FULL },
    { name: 'md-plain', source: MD_PLAIN },
    // basename resolution: the source says deck_files/figure-markdown/plot-1.png,
    // the pick flattened it to plot-1.png, and it must still embed
    { name: 'md-rendered', source: MD_RENDERED, assets: { 'plot-1.png': fakePng(1200, 800) } },
    { name: 'md-empty', source: MD_EMPTY },
    { name: 'md-edges', source: MD_EDGES },
  ]
}
