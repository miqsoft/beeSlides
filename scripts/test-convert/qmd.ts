#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// slidomingo/convert markdown-import rig — the Quarto/`.qmd` path.
//
//   node scripts/test-convert/qmd.ts       (Node ≥ 23.6 strips types natively)
//
// THE FIRST BLOCK IS THE ONE THAT MATTERS. convert/mdlayout.ts restates
// builtinLayouts()'s geometry because the kernel must not import an app (see
// its header), and a restatement that nobody checks is a copy waiting to
// drift. This rig can import BOTH, so it compares them element for element:
// same ids, same frames, same typography, same roles. If model.ts's designs
// move and mdlayout.ts does not, this fails — which is the whole reason the
// restatement is allowed to exist.
//
// The rest pins the mapping decisions a reader would otherwise have to infer
// from the output: which layout each slide shape picks, that a `code` element
// really carries raw source and a grammar, that math is VERBATIM, that a
// table's alignment survives, that `.notes` leaves the canvas, that figures
// resolve by basename, and that every judgement call is in the report.

import { convertMarkdown, parseYaml, splitFrontMatter } from '../../kernel/src/convert/qmd.ts'
import { inlineToHtml, parseBlocks, parseFenceInfo } from '../../kernel/src/convert/md.ts'
import { imageSize } from '../../kernel/src/convert/media.ts'
import { LIGHT, buildLayout, type LayoutKind } from '../../kernel/src/convert/mdlayout.ts'
import { builtinLayouts } from '../../slides/src/model.ts'
import type { OutCode, OutImage, OutTable, OutText } from '../../kernel/src/convert/types.ts'
import { MD_EDGES, MD_EMPTY, MD_FULL, MD_PLAIN, MD_RENDERED, fakePng } from './_mdfixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// ============================================================ the drift gate
//
// mdlayout.ts's `qmd-*` layouts must be builtinLayouts()'s `layout-*` designs
// with nothing changed but the id and the name. Compared at LAYOUT_BASE
// (1600x900), where model.ts applies no scaling either, so any difference is
// a real one.
{
  const PAIRS: Array<[LayoutKind, string]> = [
    ['title', 'layout-title'],
    ['title-content', 'layout-title-content'],
    ['two-col', 'layout-two-col'],
    ['picture-caption', 'layout-picture-caption'],
    ['section', 'layout-section'],
    ['blank', 'layout-blank'],
  ]
  const base = { width: 1600, height: 900 }
  const builtins = builtinLayouts(base)
  for (const [kind, builtinId] of PAIRS) {
    const mine = buildLayout(kind, base, LIGHT)
    const theirs = builtins.find((l) => l.id === builtinId)!
    ok(theirs !== undefined, `${builtinId} still exists in builtinLayouts()`)
    ok(mine.name === theirs.name, `${kind}: name matches the built-in ("${mine.name}")`)
    ok(mine.background === theirs.background, `${kind}: background matches (${mine.background})`)
    ok(mine.elements.length === theirs.elements.length,
      `${kind}: same element count (${mine.elements.length} vs ${theirs.elements.length})`)
    // Element for element. The built-in's `letterSpacing`/`role`/`placeholder`
    // are optional, so the comparison is over the union of both key sets —
    // an added or dropped property is a difference, not something to skip.
    let same = mine.elements.length === theirs.elements.length
    let firstDiff = ''
    mine.elements.forEach((a, i) => {
      const b = theirs.elements[i] as unknown as Record<string, unknown>
      const ar = a as unknown as Record<string, unknown>
      // The built-ins are drawn against the LIGHT palette's own literals, and
      // model.ts's `ph()` supplies a `fontFamily`/`fontWeight` mdlayout's does
      // too — so every key is expected to agree.
      for (const k of new Set([...Object.keys(ar), ...Object.keys(b)])) {
        if (JSON.stringify(ar[k]) === JSON.stringify(b[k])) continue
        same = false
        if (!firstDiff) firstDiff = `${(a as { id: string }).id}.${k}: ${JSON.stringify(ar[k])} vs ${JSON.stringify(b[k])}`
      }
    })
    ok(same, `${kind}: every element matches builtinLayouts() exactly${firstDiff ? ` — first difference ${firstDiff}` : ''}`)
  }
  // Ids must NOT collide with the built-ins: the layout picker lists both
  // ("Built-in" and "This document"), and two entries with one id there is
  // ambiguous for every by-id lookup that follows.
  const builtinIds = new Set(builtins.map((l) => l.id))
  ok(PAIRS.every(([kind]) => !builtinIds.has(buildLayout(kind, base, LIGHT).id)),
    'materialized layout ids are qmd-*, never colliding with a built-in layout-* id')
}

// ============================================================ block parsing
{
  const bs = parseBlocks('# H\n\ntext\n\n- a\n- b\n\n```js\nlet x = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
  ok(bs.map((b) => b.kind).join(',') === 'heading,para,list,code,table',
    `block kinds in document order (got ${bs.map((b) => b.kind).join(',')})`)

  // Setext: `Foo` + `-----` is a heading, NOT a paragraph plus a slide break.
  const se = parseBlocks('Foo\n---\n\nbar\n')
  ok(se[0].kind === 'heading' && se[0].level === 2 && se[0].text === 'Foo',
    'a setext underline reads as a heading, never as a thematic break')

  // A fence's info string is the "did you run it?" signal.
  ok(parseFenceInfo('{r}').cell === true && parseFenceInfo('{r}').lang === 'r',
    '```{r} is an EXECUTABLE cell')
  ok(parseFenceInfo('{python, echo=FALSE}').cell === true,
    '```{python, echo=FALSE} is an executable cell too')
  ok(parseFenceInfo('{.r .cell-code}').cell === false && parseFenceInfo('{.r .cell-code}').lang === 'r',
    '```{.r .cell-code} is a LISTING — Pandoc attribute form, already executed')
  ok(parseFenceInfo('python').cell === false && parseFenceInfo('python').lang === 'python',
    '```python is a plain listing')

  // Nesting: .columns holds .columns
  const nested = parseBlocks('::: {.columns}\n::: {.column width="40%"}\nL\n:::\n::: {.column}\nR\n:::\n:::\n')
  ok(nested.length === 1 && nested[0].kind === 'div' && nested[0].blocks.length === 2,
    'fenced divs nest — one .columns holding two .column children')

  // A cell's `#| echo: false` header is not source anybody wants on a slide.
  const opts = parseBlocks('```{r}\n#| echo: false\n#| fig-cap: x\nplot(1)\n```\n')
  ok(opts[0].kind === 'code' && opts[0].content === 'plot(1)',
    'a cell\'s #| option lines are stripped from the emitted source')
}

// ============================================================ inline mapping
{
  ok(inlineToHtml('**b** *i* ~~s~~ `c`') === '<b>b</b> <i>i</i> <s>s</s> <code>c</code>',
    'emphasis maps to the b/i/s/code subset sanitizeHtml keeps')
  // The masking rule: no emphasis pass may see inside math.
  ok(inlineToHtml('$a_1 * b$') === '$a_1 * b$',
    'inline math is VERBATIM — its _ and * survive the emphasis pass')
  ok(inlineToHtml('$$x < y$$') === '$$x &lt; y$$',
    'display math is entity-escaped (render.ts decodes before Temml) but otherwise untouched')
  ok(inlineToHtml('`a_b_c`') === '<code>a_b_c</code>',
    'a code span is masked before the emphasis pass too')
  ok(inlineToHtml('\\*not em\\*') === '*not em*', 'backslash escapes stay literal')
  ok(inlineToHtml('some_variable_name') === 'some_variable_name',
    'an underscore inside a word is not emphasis')
  ok(inlineToHtml('a < b & c') === 'a &lt; b &amp; c', 'plain text is entity-escaped')
}

// ============================================================ image headers
{
  const png = fakePng(800, 600)
  ok(JSON.stringify(imageSize(png, 'image/png')) === '{"w":800,"h":600}',
    'imageSize reads a PNG IHDR')
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xF0, 0x00, 0, 0, 0])
  ok(JSON.stringify(imageSize(gif, 'image/gif')) === '{"w":320,"h":240}',
    'imageSize reads a GIF logical screen descriptor (little-endian)')
  const svg = new TextEncoder().encode('<svg xmlns="x" viewBox="0 0 400 300"><rect/></svg>')
  ok(JSON.stringify(imageSize(svg, 'image/svg+xml')) === '{"w":400,"h":300}',
    'imageSize falls back to an SVG viewBox when there is no width/height')
  ok(imageSize(new Uint8Array([1, 2, 3]), 'application/octet-stream') === undefined,
    'an unreadable header returns undefined rather than guessing')
}

// ============================================================ front matter
{
  const { yaml, body } = splitFrontMatter(MD_FULL)
  ok(yaml.includes('title:') && body.startsWith('\n# Motivation'),
    'front matter splits off the top, body starts at the first block')
  const m = parseYaml(yaml)
  ok(m.title === 'Bayesian Workflow', 'a quoted scalar loses its quotes')
  ok(Array.isArray(m.author) && (m.author as string[]).length === 2,
    'a `- ` sequence parses as a list (two authors)')
  ok(typeof m.format === 'object' && (m.format as Record<string, Record<string, string>>).revealjs.theme === 'dark',
    'nested mappings parse (format.revealjs.theme)')
  ok(parseYaml('a: [x, y]').a instanceof Array, 'an inline flow sequence parses')
}

// ============================================================ the full deck
const full = convertMarkdown(MD_FULL, { assets: { 'figs/slope.png': fakePng(800, 600) }, name: 'workflow.qmd' })
{
  const d = full.doc
  ok(d.format === 'slidomingo/slides' && d.version === '1.0.0', 'emits the format header')
  ok(d.title === 'Bayesian Workflow', 'doc.title comes from the front matter')
  ok(d.meta?.author === 'Ada Lovelace, Grace Hopper', 'both authors land in doc.meta.author')
  ok(d.meta?.company === 'Institute for Advanced Study', 'institute lands in doc.meta.company')
  ok(d.size.width === 1600 && d.size.height === 900,
    'the default canvas is 1600x900 — LAYOUT_BASE itself, so the designs land unscaled')
  ok(d.theme.background === '#14181D',
    'a dark reveal theme name swaps the whole palette (theme: dark → dark ground)')

  // Ten slides: the front-matter title slide, one section, eight content.
  ok(d.slides.length === 10, `10 slides (title + section + 8 content) — got ${d.slides.length}`)
  ok(d.slides.map((s) => s.id).join(',') === 'q1,q2,q3,q4,q5,q6,q7,q8,q9,q10',
    'slide ids are deterministic q<n>')
  ok(d.slides.every((s) => s.transition === 'none'),
    'transition is ALWAYS none — the same call the .pptx path makes, and for the same reason')

  // EVERY slide is layout-linked, and every link resolves. This is the whole
  // difference from the .pptx importer.
  const layoutIds = new Set((d.layouts ?? []).map((l) => l.id))
  ok(d.slides.every((s) => !!s.layoutId), 'every slide carries a layoutId')
  ok(d.slides.every((s) => layoutIds.has(s.layoutId!)),
    'every layoutId resolves against doc.layouts — a dangling one renders as "linked to Untitled"')
  ok(!!d.defaultLayoutId && layoutIds.has(d.defaultLayoutId),
    'doc.defaultLayoutId points at a layout that is actually present')

  // Only the designs USED are materialized (the engine-wide PRUNE rule).
  ok((d.layouts ?? []).length === 5,
    `5 designs materialized, not all 6 — 'blank' is unused here (got ${(d.layouts ?? []).length})`)

  const byId = (id: string) => d.slides.find((s) => s.id === id)!
  ok(byId('q1').layoutId === 'qmd-title', 'the front-matter slide picks the Title design')
  ok(byId('q2').layoutId === 'qmd-section',
    'a `#` heading (above slide-level 2) picks the Section divider')
  ok(byId('q3').layoutId === 'qmd-title-content', 'a `##` with prose picks Title + content')
  ok(byId('q7').layoutId === 'qmd-two-col', '::: {.columns} with two columns picks Two columns')
  ok(byId('q8').layoutId === 'qmd-picture-caption',
    'a slide whose body is one figure picks Picture with caption')

  // ---- title slide
  const t1 = byId('q1').elements as OutText[]
  ok(t1[0].id === 'lt-title' && t1[0].role === 'title',
    'the title adopts the design\'s own title placeholder (id + role), so a re-apply moves it')
  ok(t1.every((e) => (e as { placeholder?: string }).placeholder === undefined),
    'a filled placeholder drops its prompt — "Click to add title" must never show under real words')
  ok(t1[1].html.includes('A practical tour') && t1[1].html.includes('Ada Lovelace'),
    'subtitle + byline share the subtitle slot, separated by <br>')

  // ---- section slide
  const t2 = byId('q2').elements as OutText[]
  ok(t2.some((e) => e.role === 'kicker' && e.html === 'PART 1'),
    'the section divider gets a numbered kicker')

  // ---- prose, bullets, and the pause
  const q3 = byId('q3').elements as OutText[]
  const body3 = q3.find((e) => e.role === 'body')!
  ok(body3.id === 'ltc-body' && body3.html.includes('$p(\\theta \\mid y)$'),
    'the first TEXT block adopts the body placeholder and keeps its math verbatim')
  ok(q3.some((e) => e.html.startsWith('<ul><li>Priors are explicit')),
    'bullets render as a REAL list — the shape editor/markdown.ts writes')
  ok(JSON.stringify(d.requires) === '["rich-text"]', 'and the deck declares requires: [rich-text]')
  ok(q3.filter((e) => e.role === 'body').length === 1,
    'exactly ONE element takes role:body — extras ride along unroled, so a re-apply cannot fight over the slot')
  // The pause is BEFORE "And it composes." and after the prose/bullets.
  ok(body3.fx === undefined, 'content before a `. . .` has no entrance — it is there when the slide arrives')
  const after = q3.find((e) => e.html === 'And it composes.')!
  ok(after.fx?.enter === 'fade-up' && after.fx?.order === 1,
    'content after a `. . .` enters on step 1')

  // ---- math
  const q4 = byId('q4').elements as OutText[]
  ok(q4.some((e) => e.html.startsWith('$$') && e.html.includes('\\frac')),
    'display math is emitted as `$$…$$` source — the model stores TeX, render.ts makes MathML')
  ok(q4.some((e) => e.align === 'center'), 'display math is centred')
  ok(byId('q4').notes === 'Mention the normalising constant.',
    '::: {.notes} becomes slide.notes and leaves the canvas entirely')
  ok(!q4.some((e) => e.html.includes('normalising')), 'the notes text is NOT also an element')

  // ---- code
  const code5 = byId('q5').elements.find((e): e is OutCode => e.type === 'code')!
  ok(code5 !== undefined, 'an executable cell still becomes a real `code` element')
  ok(code5.content === 'fit <- brm(y ~ x, data = d)\nsummary(fit)',
    'code content is the RAW source — never html, never escaped')
  ok(code5.grammarName === 'r', 'the fence language becomes grammarName (tokenize.ts\'s own id)')
  ok(code5.role === undefined,
    'a code element takes NO role and mints its own id — applyLayout would consume a code donor matched to a text placeholder and drop its content')
  const code10 = byId('q10').elements.find((e): e is OutCode => e.type === 'code')!
  ok(code10.grammarName === 'py', '"python" aliases to tokenize.ts\'s `py` grammar')
  ok(byId('q10').background === '#101010', '{background-color=…} sets slide.background')

  // ---- table
  const tbl = byId('q6').elements.find((e): e is OutTable => e.type === 'table')!
  ok(tbl.header === true && tbl.rows.length === 3, 'a pipe table keeps its header row plus two body rows')
  ok(tbl.columns.length === 3, 'three columns')
  ok(tbl.rows[0].cells[1].align === 'right' && tbl.rows[0].cells[0].align === undefined,
    'per-column alignment carries (`|---:|` is right, `|:---|` is the left default and stays absent)')
  ok(tbl.rows[1].cells[0].html === 'intercept', 'cell content is the inline-html subset')
  ok(typeof tbl.style === 'object' && (tbl.style as { fontSize?: number }).fontSize !== undefined,
    'a table always carries a full style — TableElement.style is required, an omitted one is not an option')

  // ---- callout
  const q6 = byId('q6').elements
  const panel = q6.find((e) => e.type === 'shape' && (e as { fill: string }).fill.startsWith('rgba'))!
  const head = q6.find((e) => e.type === 'text' && (e as OutText).html.includes('Convergence'))!
  ok(panel !== undefined && head !== undefined, 'a callout emits a tinted panel and its title')
  ok(!!panel.groupId && panel.groupId === head.groupId,
    'the callout\'s parts share a groupId, so they move as one but stay individually editable')

  // ---- columns
  const q7 = byId('q7').elements as OutText[]
  ok(q7.filter((e) => e.role === 'body').length === 2,
    'two columns fill the design\'s own two body slots')
  const [left, right] = q7.filter((e) => e.role === 'body')
  ok(left.id === 'l2c-left' && right.id === 'l2c-right' && right.x > left.x,
    'left and right adopt their own placeholders and stay side by side')

  // ---- figure
  const img = byId('q8').elements.find((e): e is OutImage => e.type === 'image')!
  ok(img !== undefined, 'a figure resolves against the provided files')
  ok(img.src.startsWith('asset:') && !!d.assets[img.src.slice(6)],
    'the figure is embedded in doc.assets as a data URI, so the deck stays one file')
  ok(d.assets[img.src.slice(6)].startsWith('data:image/png;base64,'), 'with the right mime')
  ok(img.role === 'media' && img.id === 'lpc-media',
    'the picture adopts the media slot — applyLayout\'s media role matches by TYPE, so it survives a re-layout')
  ok(Math.abs(img.w / img.h - 800 / 600) < 0.02,
    `the frame keeps the PNG's own 4:3 ratio (got ${(img.w / img.h).toFixed(3)})`)
  ok((byId('q8').elements as OutText[]).some((e) => e.role === 'body' && e.html.includes('Posterior draws')),
    'the figure\'s alt text fills the caption slot')

  // ---- incremental
  const q9 = (byId('q9').elements as OutText[]).filter((e) => e.html.startsWith('<ul><li>'))
  ok(q9.length === 2 && q9[0].fx?.order === 1 && q9[1].fx?.order === 2,
    'an .incremental list becomes one element per item, on consecutive steps')

  // ---- everything stays on the canvas
  ok(d.slides.every((s) => s.elements.every((e) =>
    e.x >= 0 && e.y >= 0 && e.x + e.w <= d.size.width && e.y + e.h <= d.size.height)),
    'no emitted element falls off the canvas — validate.ts reports that, and a synthesized frame has no excuse')

  ok(d.slides.every((s) => new Set(s.elements.map((e) => e.id)).size === s.elements.length),
    'ids are unique WITHIN each slide (validate.ts errors on a duplicate)')
}

// ====================================== columns that are NOT the whole slide
//
// A `.columns` div may only claim the design's own two body slots when it is
// the slide's ONLY content. Sharing the slide with anything else, filling the
// two slots would have silently dropped whatever else was there.
{
  const r = convertMarkdown(`## Mixed

An intro paragraph nobody should lose.

::: {.columns}
::: {.column width="60%"}
Left side.
:::
::: {.column width="40%"}
Right side.
:::
:::

A closing line either.

## Three of them

::: {.columns}
::: {.column}
one
:::
::: {.column}
two
:::
::: {.column}
three
:::
:::
`)
  const [mixed, three] = r.doc.slides
  const html = (s: typeof mixed) => (s.elements.filter((e) => e.type === 'text') as OutText[]).map((e) => e.html)
  ok(mixed.layoutId === 'qmd-title-content',
    'columns sharing a slide do NOT take over the two-column design')
  for (const want of ['An intro paragraph nobody should lose.', 'Left side.', 'Right side.', 'A closing line either.']) {
    ok(html(mixed).some((h) => h.includes(want)), `every block survives: "${want}"`)
  }
  const left = (mixed.elements as OutText[]).find((e) => e.html?.includes('Left side'))!
  const right = (mixed.elements as OutText[]).find((e) => e.html?.includes('Right side'))!
  ok(right.x > left.x && Math.abs(right.y - left.y) < 4,
    'and the two columns still sit side by side, at the same height')
  ok(left.w > right.w, 'honouring width="60%" / width="40%"')

  ok(three.layoutId === 'qmd-title-content',
    'three columns pick Title + content — the built-in designs offer two, not three')
  const xs = (three.elements as OutText[]).filter((e) => /^(one|two|three)$/.test(e.html ?? '')).map((e) => e.x)
  ok(xs.length === 3 && xs[0] < xs[1] && xs[1] < xs[2],
    'and are laid out as three frames across one body region')
  ok(r.report.entries.some((e) => e.code === 'columns-approximated'),
    'both cases are reported as approximated, not carried')
}

// ================================================== ids that make morph pair
//
// The "one line later" idiom — the same listing, evolved, on the next slide —
// is the teaching pattern this importer can serve better than reveal.js can,
// because code.ts diffs the two listings LINE BY LINE. That only happens if
// the two elements share a morph key, and `morphKey` is `morphId ?? id`. So
// the id scheme is load-bearing, not cosmetic.
{
  const r = convertMarkdown(`## Step one

\`\`\`py
a = 1
\`\`\`

## Step two

\`\`\`py
a = 1
b = 2
\`\`\`

## Then prose

Just words here.
`)
  const [s1, s2, s3] = r.doc.slides
  ok(s1.elements.some((e) => e.id === 'ltc-c1') && s2.elements.some((e) => e.id === 'ltc-c1'),
    'two consecutive listings on the same design share one id, so a morph transition makes the code travel')
  ok(s1.elements.find((e) => e.id === 'ltc-c1')!.type === 'code'
    && s2.elements.find((e) => e.id === 'ltc-c1')!.type === 'code',
    'ids are counted PER KIND, so a code element can never pair with a text one')
  ok(!s3.elements.some((e) => e.id === 'ltc-c1'),
    'a slide with no listing has no c1 at all — nothing pairs by accident')
  ok(s1.elements.some((e) => e.id === 'ltc-title') && s2.elements.some((e) => e.id === 'ltc-title'),
    'titles share their placeholder id across slides of one design (the built-ins\' own lineage rule)')
  ok(r.doc.slides.every((s) => new Set(s.elements.map((e) => e.id)).size === s.elements.length),
    'and every slide is still internally unique')
}

// ============================================================ the report
{
  const codes = new Set(full.report.entries.map((e) => e.code))
  for (const c of [
    'title-slide-built', 'notes-imported', 'table-imported', 'columns-imported',
    'code-imported', 'image-embedded', 'math-verbatim',
  ]) ok(codes.has(c), `report carries "${c}" (carried)`)
  for (const c of [
    'theme-approximated', 'pause-approximated', 'incremental-approximated',
    'callout-approximated', 'code-cell-as-source',
  ]) ok(codes.has(c), `report carries "${c}" (approximated)`)
  for (const c of ['citation-unresolved', 'qmd-cells-not-run', 'bibliography-dropped']) {
    ok(codes.has(c), `report carries "${c}" (dropped)`)
  }
  const cells = full.report.entries.find((e) => e.code === 'qmd-cells-not-run')!
  ok(cells.detail.includes('quarto render --to markdown'),
    'the un-run-cells line says exactly what to do about it')
  ok(full.report.counts.carried > 0 && full.report.counts.approximated > 0 && full.report.counts.dropped > 0,
    'all three verdicts are represented')

  // A figure that IS provided but is not a picture — `quarto render --to pdf`
  // writes PDF figures, and embedding one would render as nothing at all.
  {
    const r = convertMarkdown('## Fig\n\n![](plot.pdf)\n',
      { assets: { 'plot.pdf': new Uint8Array([0x25, 0x50, 0x44, 0x46]) } })
    const e = r.report.entries.find((x) => x.code === 'image-not-a-picture')
    ok(e !== undefined && e.detail.includes('pdf'),
      'a provided-but-unpaintable figure is reported distinctly from a missing one')
    ok(!r.doc.slides.some((s) => s.elements.some((x) => x.type === 'image')),
      'and no image element is emitted for it')
    ok(Object.keys(r.doc.assets).length === 0, 'nor is it registered as an asset')
  }

  // The same file reached by two spellings is ONE asset, not two copies.
  {
    const r = convertMarkdown('## A\n\n![](figs/p.png)\n\n## B\n\n![](p.png)\n',
      { assets: { 'figs/p.png': fakePng(400, 400) } })
    ok(Object.keys(r.doc.assets).length === 1,
      'two references that resolve to one file share one asset key — the bytes are not carried twice')
  }

  // Without the figure files, the figure is DROPPED and said so — never a
  // broken deck, and never a silent one.
  const nofig = convertMarkdown(MD_FULL)
  ok(!nofig.report.entries.some((e) => e.code === 'image-embedded'),
    'nothing claims to have embedded a figure that was not provided')
  const miss = nofig.report.entries.find((e) => e.code === 'image-unresolved')!
  ok(miss !== undefined && miss.detail.includes('_files/'),
    'an unresolved figure is reported, pointing at where `quarto render` puts them')
  ok(!nofig.doc.slides.some((s) => s.elements.some((e) => e.type === 'image')),
    'and no image element references an asset that does not exist')
}

// ============================================================ plain markdown
{
  const r = convertMarkdown(MD_PLAIN, { name: 'NOTES.md' })
  ok(r.doc.title === 'Release notes',
    'with no front matter, the first heading names the deck')
  // `# Release notes` is above slide-level 2 → a section; then two `##`
  // slides; then `***` opens a headless one.
  ok(r.doc.slides.length === 4, `4 slides (section + 2 + a headless one) — got ${r.doc.slides.length}`)
  ok(r.doc.slides[3].layoutId === 'qmd-blank',
    'a `***` break with no heading picks the Blank design')
  ok(r.doc.slides[3].elements.length === 1, 'and still lays its content out')
  ok(r.doc.theme.background === '#FFFFFF', 'no theme name means the light palette')
  ok(!r.report.entries.some((e) => e.verdict === 'dropped'),
    'plain markdown converts with nothing dropped at all')
}

// ============================================================ rendered output
{
  const r = convertMarkdown(MD_RENDERED, { assets: { 'plot-1.png': fakePng(1200, 800) } })
  ok(!r.report.entries.some((e) => e.code === 'qmd-cells-not-run'),
    'ALREADY-RENDERED markdown reports no un-run cells — the `.cell-code` form is a listing, not a cell')
  const els = r.doc.slides[1].elements
  const codes = els.filter((e): e is OutCode => e.type === 'code')
  ok(codes.length === 2, 'the cell\'s source AND its printed output both come in as code elements')
  ok(codes[0].grammarName === 'r', 'the source keeps its language')
  ok(codes[1].grammarName === undefined,
    'printed output gets NO grammar — a .cell-output fence\'s first class is not a language')
  const img = els.find((e): e is OutImage => e.type === 'image')
  ok(img !== undefined && img.src.startsWith('asset:'),
    'a figure written into deck_files/ resolves by BASENAME when the pick flattened the folder')
  ok(!r.report.entries.some((e) => e.code === 'div-unknown'),
    'Pandoc\'s own .cell/.cell-output wrappers are recognised, not reported as unknown')
}

// ============================================================ the floors
{
  const r = convertMarkdown(MD_EMPTY, { name: 'empty.md' })
  ok(r.doc.slides.length === 1,
    'an empty source still emits one slide — parseDoc refuses a slideless document')
  ok(r.report.entries.some((e) => e.code === 'deck-empty'), 'and says so')
  ok(r.doc.title === 'empty', 'falling back to the file name for a title')
}

// ============================================================ the edges
{
  const r = convertMarkdown(MD_EDGES)
  const codes = new Set(r.report.entries.map((e) => e.code))
  for (const c of [
    'div-unknown', 'reveal-attr-ignored', 'raw-html-dropped', 'link-flattened',
    'footnote-marker-dropped', 'image-inline-dropped', 'quote-approximated', 'image-unresolved',
  ]) ok(codes.has(c), `an edge case is reported, not silently swallowed: "${c}"`)
  // An unknown wrapper loses its styling but never its CONTENT.
  ok(r.doc.slides.some((s) => s.elements.some((e) =>
    e.type === 'text' && (e as OutText).html.includes('Inside something nobody mapped'))),
    'an unmapped fenced div still imports its contents')
  ok(r.doc.slides.some((s) => s.elements.some((e) =>
    e.type === 'text' && (e as OutText).html.includes('Untouchable'))),
    'a raw HTML block imports as its plain text rather than vanishing')
  ok(!r.doc.slides.some((s) => s.elements.some((e) => !!e.link)),
    'no element carries a `link` — that field addresses a SLIDE, and validate.ts errors on anything else')
  ok(r.doc.slides.some((s) => s.name === 'Setext slide'),
    'a setext heading opens a slide, same as its ATX spelling')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
