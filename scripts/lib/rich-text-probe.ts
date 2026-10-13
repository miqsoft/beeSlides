// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Rich text phase 1 — the DOM half of the editor/format checks, run inside
// scripts/test-sanitize.ts's browser probe (imported by it, bundled by
// esbuild against the shipping modules). Lives in its own real module, not in
// that rig's template-literal probe, so it can be ordinary TypeScript.
//
// Pins what only a DOM can answer:
//   * the outline view's round trip (sanitizeHtml → htmlToMarkdown →
//     markdownToHtml → sanitizeHtml) is the identity for the subset, incl.
//     backslashes and links with parentheses;
//   * phase 2: an outline edit keeps colour/size/underline on the lines it
//     did not change (keptLines), and never corrupts the words — a plain
//     line that looks like a list item stays a plain line;
//   * hoistLists drops only the empty runs a split leaves, never an author's
//     own blank line;
//   * builds.splitParagraphs (raw html) counts what tagParagraphs (rendered,
//     sanitized DOM) tags — a list inside a line div included;
//   * the link popover's input normalisation;
//   * normalizeRuns' browser-markup cleanup;
//   * the no-JS static layer numbers nested lists like the live render.

import { sanitizeHtml } from '../../slides/src/render'
import { htmlToMarkdown, keptLines, markdownToHtml } from '../../slides/src/editor/markdown'
import { normalizeLinkInput, normalizeRuns } from '../../slides/src/editor/richtext'
import { splitParagraphs, tagParagraphs } from '../../slides/src/builds'
import { inlineRuntimeCss } from '../../slides/src/staticrender'

export function richTextProbe(check: (name: string, pass: boolean) => void): void {
  // --- outline round trip ---------------------------------------------------
  const outline = (html: string) => sanitizeHtml(markdownToHtml(htmlToMarkdown(sanitizeHtml(html))))
  const same = (html: string) => outline(html) === sanitizeHtml(html)
  check('rich/md — a backslash survives an outline edit unchanged: ' + outline('C:\\Users\\x'),
    outline('C:\\Users\\x') === 'C:\\Users\\x' && outline(outline('C:\\Users\\x')) === 'C:\\Users\\x')
  check('rich/md — escaped markers stay literal both ways: ' + outline('a *b* \\*c\\* [d] `e`'),
    same('a *b* \\*c\\* [d] `e`'))
  const wiki = '<a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a> see'
  check('rich/md — a link with balanced parentheses comes back a link, href as written: ' + outline(wiki),
    same(wiki))
  const odd = sanitizeHtml('<a href="https://example.com/a)b(c">x</a>')
  const oddBack = outline(odd)
  check('rich/md — an unbalanced paren in an href comes back a link to the same address: ' + oddBack,
    /^<a href="https:\/\/example\.com\/a(\)|%29)b(\(|%28)c"[^>]*>x<\/a>$/.test(oddBack))
  const rich = '<b>bold</b> <i>it</i> <s>gone</s> <a href="https://example.com/q?a=1&amp;b=2">l</a>' +
    '<ul><li>one<ol><li>sub</li></ol></li><li>two</li></ul>'
  check('rich/md — emphasis, a query-string link and a nested list round-trip: ' + outline(rich), same(rich))

  // --- phase 2: the outline keeps what markdown cannot spell ---------------------
  // what editor.ts commitOutlineBody does with the field's text
  const commit = (stored: string, text: string) => sanitizeHtml(markdownToHtml(text, keptLines(sanitizeHtml(stored))))
  const words = (html: string) => { const d = document.createElement('div'); d.innerHTML = html.replace(/<br>|<\/li>/g, '\n'); return d.textContent }
  {
    const stored = sanitizeHtml('<span style="color:#e03131">red</span> words<br>second <span style="font-size:40px">big</span><br>third')
    const md = htmlToMarkdown(stored)
    const edited = commit(stored, md.replace('third', 'third, edited'))
    check('rich/outline — editing one line keeps the colour and size runs on the others: ' + edited,
      edited.includes('<span style="color:#e03131">red</span> words') && edited.includes('second <span style="font-size:40px">big</span>') &&
      edited.endsWith('third, edited'))
    check('rich/outline — and the field unchanged commits the same html', commit(stored, md) === stored)
    const lineEdited = commit(stored, md.replace('words', 'wordz'))
    check('rich/outline — a plain-text edit inside a line is patched into its old runs: ' + lineEdited,
      lineEdited.startsWith('<span style="color:#e03131">red</span> wordz<br>second <span style="font-size:40px">big</span>'))
    const grown = commit(stored, md.replace('red words', 'redder words'))
    check('rich/outline — words typed at the end of a run join that run, as typing does: ' + grown,
      grown.startsWith('<span style="color:#e03131">redder</span> words<br>'))
    const cut = commit(stored, md.replace('second big', 'second'))
    check('rich/outline — deleting a whole run drops it and keeps the rest: ' + cut,
      cut.includes('<br>second<br>third') && cut.startsWith('<span style="color:#e03131">red</span> words'))
    const marked = commit(stored, md.replace('red words', 'red **words**'))
    check('rich/outline — a markup change converts the line afresh (words right): ' + marked,
      marked.startsWith('red <b>words</b><br>second <span style="font-size:40px">big</span>'))
    const linked = commit(stored, md.replace('third', '[third](https://example.com/)'))
    check('rich/outline — so does a new link: ' + linked, linked.endsWith('<a href="https://example.com/" target="_blank" rel="noopener noreferrer">third</a>'))
    const moved = commit(stored, md.split('\n').reverse().join('\n'))
    check('rich/outline — reordered lines keep the runs that are still theirs: ' + moved,
      moved.includes('<span style="color:#e03131">red</span> words') || moved.includes('second <span style="font-size:40px">big</span>'))
    check('rich/outline — and never change a word: ' + words(moved), words(moved) === 'third\nsecond big\nred words')
  }
  {
    const stored = sanitizeHtml('<ul><li><u>under</u> one</li><li>two<ul><li><span style="color:var(--sl-accent1)">slot</span></li></ul></li></ul>')
    const edited = commit(stored, htmlToMarkdown(stored).replace('two', 'TWO'))
    check('rich/outline — list items keep their runs too, nesting intact: ' + edited,
      edited === '<ul><li><u>under</u> one</li><li>TWO<ul><li><span style="color:var(--sl-accent1)">slot</span></li></ul></li></ul>')
  }
  {
    // a line break INSIDE a run: neither line is a clean fragment — they
    // convert again (flattening), but every word stays where it was
    const stored = sanitizeHtml('<span style="color:#e03131">a<br>b</span><br>c')
    const edited = commit(stored, htmlToMarkdown(stored).replace(/c$/, 'd'))
    check('rich/outline — a run across a line break is never reused half: ' + edited,
      words(edited) === 'a\nb\nd' && !edited.includes('<span'))
  }
  {
    const stored = sanitizeHtml('1. not a list<br>- nor this<br>2019. was a good year<br>+ plus')
    const md = htmlToMarkdown(stored)
    check('rich/outline — a plain line that reads like a list item is escaped: ' + JSON.stringify(md),
      md === '1\\. not a list\n\\- nor this\n2019. was a good year\n\\+ plus')
    const edited = commit(stored, md + '\nmore')
    check('rich/outline — and stays plain text through an edit elsewhere: ' + edited,
      !/<[uo]l>/.test(edited) && words(edited) === '1. not a list\n- nor this\n2019. was a good year\n+ plus\nmore')
    const afterList = sanitizeHtml('<ol><li>a</li></ol>2. b')
    check('rich/outline — a plain "2." right after a numbered list is escaped too: ' + JSON.stringify(htmlToMarkdown(afterList)),
      outline(afterList) === afterList)
  }
  {
    // a numbered list edited in the outline: nobody renumbers the lines
    // after a deleted or inserted item by hand
    const stored = sanitizeHtml('<ol><li>alpha</li><li><span style="color:#e03131">beta</span></li><li>gamma</li></ol>')
    const md = htmlToMarkdown(stored)
    const first = commit(stored, md.split('\n').slice(1).join('\n'))
    check('rich/outline — deleting the first numbered item keeps the rest a list: ' + first,
      first === '<ol><li><span style="color:#e03131">beta</span></li><li>gamma</li></ol>')
    const middle = commit(stored, md.replace(/^2\. .*\n/m, ''))
    check('rich/outline — deleting a middle one too: ' + middle, middle === '<ol><li>alpha</li><li>gamma</li></ol>')
    const inserted = commit(stored, md.replace('1. alpha', '1. alpha\n2. new'))
    check('rich/outline — inserting an item renumbers the rest, all one list: ' + inserted,
      inserted === '<ol><li>alpha</li><li>new</li><li><span style="color:#e03131">beta</span></li><li>gamma</li></ol>')
    const mixed = sanitizeHtml('<ol><li>x</li></ol>foo<br>3. x')
    const mixedMd = htmlToMarkdown(mixed)
    check('rich/outline — beside a numbered list, a plain "3. x" is escaped and stays text: ' + JSON.stringify(mixedMd),
      mixedMd === '1. x\nfoo\n3\\. x' && commit(mixed, mixedMd) === mixed && commit(mixed, mixedMd + '\nmore') === mixed + '<br>more')
  }
  {
    // contentEditable writes NBSPs beside runs; the markdown has spaces
    const stored = sanitizeHtml('<span style="color:#e03131">red</span>&nbsp;<b>x</b> words')
    const edited = commit(stored, htmlToMarkdown(stored).replace('words', 'wordz'))
    check('rich/outline — an NBSP before the edit does not cost the line its runs: ' + edited,
      edited === '<span style="color:#e03131">red</span>&nbsp;<b>x</b> wordz')
    const two = sanitizeHtml('x&nbsp;&nbsp;<span style="color:#e03131">y</span>')
    const grown = commit(two, htmlToMarkdown(two) + 'z')
    check('rich/outline — nor do two of them: ' + grown, grown === 'x&nbsp;&nbsp;<span style="color:#e03131">yz</span>')
  }
  {
    // edited lines and an inserted one in the same gap: pairs by likeness,
    // so the new line never takes a neighbour's runs
    const stored = sanitizeHtml('<span style="color:#e03131">x</span><br><span style="color:#2f9e44">y</span>')
    const edited = commit(stored, 'x2\nnew\ny2')
    check('rich/outline — an inserted line among edited ones converts fresh: ' + edited,
      edited === '<span style="color:#e03131">x2</span><br>new<br><span style="color:#2f9e44">y2</span>')
    const rewritten = commit(stored, 'x2\nsomething else')
    check('rich/outline — a line rewritten through does not inherit the old one\'s colour: ' + rewritten,
      rewritten === '<span style="color:#e03131">x2</span><br>something else')
  }
  {
    const fresh = sanitizeHtml(markdownToHtml('2019. was a good year\n3. reasons'))
    check('rich/paste — typed numbers are kept as text: ' + fresh, fresh === '2019. was a good year<br>3. reasons')
  }

  // --- hoistLists keeps author blank lines ------------------------------------
  check('rich — an author\'s &nbsp; line stays (no list anywhere): ' + sanitizeHtml('a<div>&nbsp;</div>b'),
    sanitizeHtml('a<div>&nbsp;</div>b') === 'a<div>&nbsp;</div>b')
  check('rich — so does a <p>&nbsp;</p> and a whitespace-only div',
    sanitizeHtml('<p>one</p><p>&nbsp;</p><p>two</p>') === '<p>one</p><p>&nbsp;</p><p>two</p>' &&
    sanitizeHtml('<div>a</div><div> </div><div>b</div>') === '<div>a</div><div> </div><div>b</div>')
  check('rich — while the empty run a list split leaves is dropped: ' + sanitizeHtml('<div><ul><li>x</li></ul> </div>'),
    sanitizeHtml('<div><ul><li>x</li></ul> </div>') === '<ul><li>x</li></ul>')

  // --- the build twins agree ------------------------------------------------------
  for (const html of [
    '<div>a</div><div><ul><li>x</li><li>y</li></ul></div>',
    '<div>x<ul><li>a</li><li>b</li></ul>y</div>',
    '<div><div>head</div><ol><li>n</li></ol>tail</div>',
    'intro<ol><li>x</li><li><br></li></ol>outro',
    '<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul><div>after</div>',
    '<div>a</div><div><br></div><div>&nbsp;</div><div>b</div>',
  ]) {
    const host = document.createElement('div')
    host.innerHTML = sanitizeHtml(html)
    const dom = tagParagraphs(host).length
    const raw = splitParagraphs(html).length
    check('rich/builds — the click count (' + raw + ') matches the paragraphs shown (' + dom + '): ' + html, raw === dom)
  }

  // --- link popover input -----------------------------------------------------
  check('rich/link — a bare host gets https://', normalizeLinkInput('example.com/x') === 'https://example.com/x')
  check('rich/link — a bare address gets mailto:', normalizeLinkInput(' someone@example.com ') === 'mailto:someone@example.com')
  check('rich/link — http, https and mailto pass as written',
    normalizeLinkInput('http://example.com/') === 'http://example.com/' &&
    normalizeLinkInput('mailto:a@b.co') === 'mailto:a@b.co')
  check('rich/link — any other scheme is refused, not rewritten',
    normalizeLinkInput('javascript:alert(1)') === null && normalizeLinkInput('ftp://example.com/') === null &&
    normalizeLinkInput('data:text/html,x') === null && normalizeLinkInput('') === null && normalizeLinkInput('   ') === null)

  // --- normalizeRuns ---------------------------------------------------------------
  const runs = document.createElement('div')
  runs.style.cssText = 'color:rgb(1, 2, 3);font-size:20px'
  runs.innerHTML = '<strike>s</strike><font color="#ff0000">f</font><font color="javascript:x">g</font>' +
    '<span style="color:rgb(1, 2, 3);font-size:20px">copy</span><span style="color:var(--sl-accent1)">slot</span>'
  document.body.appendChild(runs)
  normalizeRuns(runs)
  check('rich/runs — <strike> becomes <s>, <font> a sanitized colour span, an inherited copy unwraps, a palette slot stays: ' + runs.innerHTML,
    runs.innerHTML === '<s>s</s><span style="color: rgb(255, 0, 0);">f</span>g' +
      'copy<span style="color:var(--sl-accent1)">slot</span>')
  runs.remove()

  // --- static layer numbering -------------------------------------------------
  const page = document.createElement('div')
  page.innerHTML = '<div class="slidomingo-el"><ol><li>1<ol><li>a<ol><li>i</li></ol></li></ol></li></ol></div>'
  inlineRuntimeCss(page)
  const ols = Array.from(page.querySelectorAll('ol')) as HTMLElement[]
  check('rich/static — nested numbered lists step 1. → a. → i. without the stylesheet',
    ols[0].style.listStyleType === '' && ols[1].style.listStyleType === 'lower-alpha' && ols[2].style.listStyleType === 'lower-roman')
}
