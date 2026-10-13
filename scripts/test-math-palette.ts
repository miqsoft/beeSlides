#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Equation palette rig — pure, no DOM:
//
//   node scripts/test-math-palette.ts
//
// WHAT THIS PROVES. The palette (slides/src/editor/mathpalette.ts) is the
// fastest way to put TeX into a deck, so a snippet that does not typeset is
// a button that writes an error onto somebody's slide. Every snippet, every
// preview and every group icon must go through Temml exactly as the renderer
// calls it (math.ts, trust off, throwOnError). Then the text surgery: where
// the caret lands, what Tab jumps to, when a pick into prose gets wrapped in
// `$…$`, and that hostile TeX is refused rather than typeset.

import { MATH_PALETTE, insertSnippet, mathContextAt, nextSlot, proseSnippet, slots } from '../slides/src/editor/mathpalette.ts'
import { renderTex, texError } from '../slides/src/math.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (cond) console.log(`  ok    ${msg}`)
  else { failures++; console.log(`  FAIL  ${msg}`) }
}
function eq<T>(got: T, want: T, msg: string) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  ok(g === w, g === w ? msg : `${msg} — got ${g}, want ${w}`)
}

console.log('\nevery snippet typesets')
const ids = new Set<string>()
let n = 0
for (const g of MATH_PALETTE) {
  ok(!ids.has(g.id), `group id "${g.id}" is unique`)
  ids.add(g.id)
  ok(g.items.length > 0, `group "${g.id}" has items`)
  ok(texError(g.icon) === null, `group "${g.id}" icon typesets`)
  for (const it of g.items) {
    n++
    const err = texError(it.tex)
    ok(err === null, `${g.id}: ${it.tex}${err ? ` — ${err}` : ''}`)
    ok(renderTex(it.tex, true) !== null, `${g.id}: ${it.tex} renders (display)`)
    if (it.preview) ok(texError(it.preview) === null, `${g.id}: preview ${it.preview}`)
    // a structure with nothing to show must carry a preview, or its button is blank
    if (slots(it.tex).length) ok(!!it.preview || g.wide === true, `${g.id}: ${it.tex} has a preview`)
  }
}
ok(n >= 150, `the palette offers a real choice (${n} snippets)`)

console.log('\ninsertSnippet — caret lands in the first slot')
eq(insertSnippet('', 0, 0, '\\frac{}{}'), { text: '\\frac{}{}', selStart: 6, selEnd: 6 }, 'fraction into empty: caret in the numerator')
eq(insertSnippet('a+', 2, 2, '\\sqrt{}'), { text: 'a+\\sqrt{}', selStart: 8, selEnd: 8 }, 'root after text: caret inside the radicand')
eq(insertSnippet('x+1', 0, 3, '\\frac{}{}'), { text: '\\frac{x+1}{}', selStart: 11, selEnd: 11 }, 'selection wraps into the first slot, caret in the next')
eq(insertSnippet('ab', 1, 1, '\\pi'), { text: 'a\\pi b', selStart: 5, selEnd: 5 }, 'a control word before a letter gets a space')
eq(insertSnippet('\\alpha', 6, 6, 'x'), { text: '\\alpha x', selStart: 8, selEnd: 8 }, 'a letter after a control word gets a space')
eq(insertSnippet('\\\\', 2, 2, 'x'), { text: '\\\\x', selStart: 3, selEnd: 3 }, 'an escaped backslash (row break) is not a control word')
eq(insertSnippet('a', 1, 1, '+'), { text: 'a+', selStart: 2, selEnd: 2 }, 'no slot: caret after the snippet')
eq(insertSnippet('abc', 3, 1, '\\vec{}'), { text: 'a\\vec{bc}', selStart: 9, selEnd: 9 }, 'a backwards selection is normalised')

console.log('\nnextSlot — Tab walks the empty slots')
const frac = '\\frac{}{}'
eq(nextSlot(frac, 6), { start: 8, end: 8 }, 'numerator → denominator')
eq(nextSlot(frac, 8), { start: 6, end: 6 }, 'denominator → wraps to the numerator')
eq(nextSlot(frac, 8, true), { start: 6, end: 6 }, 'Shift+Tab goes back')
eq(nextSlot('\\frac{a}{b}', 0), null, 'no empty slot: null')
eq(nextSlot('\\frac{a}{}', 0), { start: 9, end: 9 }, 'filled slots are skipped')
eq(nextSlot('\\frac{a}{}', 9), null, 'the only empty slot is the one the caret is in: Tab has nowhere to go')
eq(nextSlot('\\{ x \\}', 0), null, 'escaped braces are not slots')
eq(nextSlot('{ }', 3), { start: 1, end: 2 }, 'a slot holding only spaces is still empty')
const mat = '\\begin{pmatrix} {} & {} \\\\ {} & {} \\end{pmatrix}'
const cells = slots(mat)
eq(cells.length, 4, 'a 2×2 matrix has four slots')
let at = cells[0].start
const visited = [at]
for (let i = 0; i < 3; i++) { at = nextSlot(mat, at)!.start; visited.push(at) }
eq(visited, cells.map((c) => c.start), 'Tab visits every matrix cell in reading order')

console.log('\nmathContextAt — is the caret in $…$?')
eq(mathContextAt('a $x', 4), 'inline', 'inside an open inline formula')
eq(mathContextAt('a $x$ b', 7), null, 'after the closing $')
eq(mathContextAt('a $', 3), 'inline', 'straight after the opening $')
eq(mathContextAt('costs $ 5', 9), null, 'a $ followed by a space is prose')
eq(mathContextAt('see \\$5 and', 10), null, 'an escaped \\$ is a literal dollar')
eq(mathContextAt('$$x + ', 6), 'display', 'inside display math')
eq(mathContextAt('$$x$$ then', 10), null, 'after display math')
eq(mathContextAt('$a$ and $b', 10), 'inline', 'the second formula of a line')
eq(mathContextAt('', 0), null, 'empty text')

console.log('\nproseSnippet — what a palette pick types into a text box')
eq(proseSnippet('\\frac{}{}', false), { text: '$\\frac{}{}$', caretBack: 4 }, 'outside math: wrapped, caret in the numerator')
eq(proseSnippet('\\alpha', false), { text: '$\\alpha$', caretBack: 1 }, 'a symbol: wrapped, caret before the closing $')
eq(proseSnippet('\\frac{}{}', true), { text: '\\frac{}{}', caretBack: 3 }, 'inside math: not wrapped again')
eq(proseSnippet('\\pi', true), { text: '\\pi', caretBack: 0 }, 'inside math, no slot: caret after it')

console.log('\nhostile TeX is refused, never typeset into markup')
for (const bad of [
  '\\href{javascript:alert(1)}{x}', '\\url{javascript:alert(1)}', '\\htmlClass{x}{y}',
  '\\htmlStyle{color:red}{y}', '\\htmlId{x}{y}', '\\htmlData{a=b}{y}', '\\includegraphics{x.png}',
]) {
  ok(texError(bad) !== null, `refused: ${bad}`)
  ok(renderTex(bad, true) === null, `nothing rendered: ${bad}`)
}
const angle = renderTex('</math><img src=x onerror=alert(1)>', true)
ok(!angle || !/<img/i.test(angle), 'markup in TeX source comes out as text, never as a tag')
ok(texError('\\def\\a{\\a\\a}\\a') !== null, 'a runaway macro is stopped (expansion limit)')
ok(texError('') === null && texError('   ') === null, 'empty TeX is not an error (validate reports it separately)')
ok(/^[^\n]+$/.test(texError('\\frac{a') ?? ''), 'an error is one line')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
