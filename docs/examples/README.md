# Example decks

Three decks that show what a BeeSlides file can do. Each one is a single,
self-contained `.beeslides.html` in **present-only** form (the viewer, no
editor): download it, open it in any browser, press **Start**. Nothing is
fetched; it works offline. The BeeSlides desktop app opens the same files for
editing.

> GitHub shows an `.html` file as source. Use the file page's **Download raw
> file** button, then open the downloaded file.

| Deck | What it is | What it shows |
|---|---|---|
| [**Wie fliegt eine Biene?**](wie-fliegt-eine-biene.beeslides.html) (12 slides, German) | An explainer on how honeybees fly, researched from the sources below. Motion only where it explains something. | Morph (the cover bee becomes the anatomy bee), hover focus (point at a body part), an interactive state (click the thorax), an extra slide (press **X** on the myth slide), click builds (one paragraph per click, things that appear and leave again), count-up numbers, loops (wings about their root, alternating muscles, a slowed-down wingbeat), motion paths (a vortex, the waggle dance), an equation with inline maths, a table with a **chart linked to it**, a second table, sections, page-number fields, push/wipe/cover/zoom transitions, zoom tiles, linked sources and a code block showing the deck as data. |
| [**Ein Tag am See**](ein-tag-am-see.beeslides.html) (4 slides, German) | Morning to night at a lake, from 54 ordinary shapes and texts. | Morph blending gradient and solid fills and text colours while the sun and a balloon travel; loops on the same elements (a crown swaying about its foot, a windmill, clouds, stars, ripples, birds, fireflies). Every part can be selected and edited. |
| [**Jahreszeiten**](jahreszeiten.beeslides.html) (4 slides, German) | A tree through the seasons: one SVG drawing whose state is set per slide. | svg `vars`: the same artwork on every slide, only its named values change, and Morph blends them; its wind runs on one clock for the whole show. One drawing, not editable part by part — see [format.md](../format.md) on when to use which. |

## How they are made

They are generated, not hand-edited:

- the decks: [`scripts/lib/bee-deck.mjs`](../../scripts/lib/bee-deck.mjs),
  [`lake-scene.mjs`](../../scripts/lib/lake-scene.mjs),
  [`seasons-scene.mjs`](../../scripts/lib/seasons-scene.mjs) — plain JSON in
  the [document format](../format.md), the same thing an agent writes;
- the files: `node scripts/build-docs-examples.mjs` loads each deck into the
  built editor and saves it with the app's own **File ▸ Export**, so a file
  carries exactly what a person exporting it would get. The build fails if
  the app's validator reports a warning or an error.

Rebuild after changing a deck (`npm run build:single` in `slides/` first).

## Sources for the bee deck

- Altshuler, Dickson, Vance, Roberts, Dickinson: *Short-amplitude
  high-frequency wing strokes determine the aerodynamics of honeybee flight*,
  PNAS 102 (2005) — [Caltech](https://resolver.caltech.edu/CaltechAUTHORS:ALTpnas05)
- Bomphrey, Nakata, Phillips, Walker: *Smart wing rotation and trailing-edge
  vortices enable high frequency mosquito flight*, Nature 544 (2017) —
  [Oxford repository](https://ora.ox.ac.uk/objects/uuid:48b29550-fb5f-486d-a366-dcb981c19be7)
- *Supra-resonant wingbeats in insects*, bioRxiv 2025.05.07.652680 (bumblebee
  and hawkmoth frequencies) — [bioRxiv](https://www.biorxiv.org/content/10.1101/2025.05.07.652680.full.pdf)
- NC State Extension: *Honey Bee Dance Language* —
  [content.ces.ncsu.edu](https://content.ces.ncsu.edu/honey-bee-dance-language)
- Visscher & Seeley: *Foraging strategy of honeybee colonies in a temperate
  deciduous forest*, Ecology (1982) — [Springer summary](https://link.springer.com/article/10.1007/BF00165845);
  maximum range: [Frontiers in Ecology and Evolution (2015)](https://www.frontiersin.org/journals/ecology-and-evolution/articles/10.3389/fevo.2015.00031/full)
- UC ANR Bug Squad: *How fast can a honey bee fly?* (speed, Altshuler's
  fruit-fly comparison) — [ucanr.edu](https://ucanr.edu/blog/bug-squad/article/how-fast-can-honey-bee-fly)
- Antoine Magnan and the 1934 calculation — [Wikipedia](https://en.wikipedia.org/wiki/Antoine_Magnan)
