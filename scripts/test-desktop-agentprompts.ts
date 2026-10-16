#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// "Send comments to Claude" message rig.
//
//   node scripts/test-desktop-agentprompts.ts
//
// WHAT THIS PROVES. The editor hands main the comments the user sent; main
// (desktop/src/main/agentprompts.ts) writes them into the Claude session as a
// readable list — into a live pty as a bracketed paste, or into a fresh
// session's single-quoted shell `initialTask`. Comment text is document text,
// so each check is one way it could escape that: a quote/dollar/backslash
// breaking the shell quoting, an ESC ending the paste early, a newline
// splitting a line, a bogus id or an unbounded list.

import { asPaste, cleanLine, drawIconsPrompt, planIconsPrompt, styleIconsPrompt, fixCommentsPrompt, fixImportPrompt, MAX_LISTED_COMMENTS, MAX_LISTED_ICONS, MAX_LISTED_IMPORT_ITEMS } from '../desktop/src/main/agentprompts.ts'
import { convertArgs, findSoffice } from '../desktop/src/main/sourcerender.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const SHELL_UNSAFE = /['$`\\]/
const nasty = "it's $HOME `x` \\ \x1b[201~ rm\r\nnext" + String.fromCharCode(0x2028) + "line\x00"

const text = fixCommentsPrompt([
  { id: 'cmt_a1', slide: 2, on: 'Q3 results', text: 'Make the title bigger' },
  { id: 'cmt_b2', slide: 2, on: 'area', text: nasty },
  { id: 'cmt_c3', slide: 5, on: '', text: 'Wrong number', feedback: 'still wrong' },
])!
ok(typeof text === 'string', 'a valid list gives a message')
ok(text.startsWith('Please fix these 3 review comments:'), 'the header counts the comments')
ok(text.includes('1. Slide 2 · on “Q3 results”: Make the title bigger  [cmt_a1]'), 'an element comment names slide, element and id')
ok(text.includes('2. Slide 2 · area: '), 'an area comment says so')
ok(text.includes('3. Slide 5: Wrong number  [cmt_c3]\n   Feedback on your last attempt: still wrong'), 'feedback after a Claude reply is listed under its comment')
ok(text.includes('subagent'), 'the message says when to use subagents')
ok(!SHELL_UNSAFE.test(text), 'no shell-quoting characters survive (initialTask stays single-quotable)')
ok(!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text.replaceAll("\n", "")), 'no control bytes or line separators survive (no early paste end)')
ok(text.split('\n').filter((l) => /^\d+\. /.test(l)).length === 3, 'every comment stays on its own single line')

ok(fixCommentsPrompt(undefined) === null, 'no list → no message')
ok(fixCommentsPrompt([{ id: 'bad id', slide: 1, text: 'x' }, { id: 'ok', slide: 0, text: 'x' }, { id: 'ok2', slide: 1, text: '  ' }]) === null,
  'bad ids, slide numbers and empty texts are dropped')
ok(fixCommentsPrompt([{ id: 'one', slide: 1, text: 'x' }])!.startsWith('Please fix this review comment:'), 'one comment reads in the singular')

// icon sets: a comment written while the icon was shown in a style
const inStyle = fixCommentsPrompt([{ id: 'cs', slide: 3, on: 'shape', text: 'lens should be blue', style: "Comic's $best" }])!
ok(inStyle.includes('1. Slide 3 · on “shape” · in the style “Comic’s ＄best”: lens should be blue  [cs]'), 'a styled comment names its style (cleaned like the text)', inStyle.split('\n')[2])
ok(inStyle.includes('icons op tweak') && inStyle.includes('icons op style'), 'and says how to change one icon in a style vs the whole style')
ok(!SHELL_UNSAFE.test(inStyle), 'a style name cannot break the shell quoting')
ok(!text.includes('icons op tweak'), 'comments without a style get no style instructions')

const many = Array.from({ length: MAX_LISTED_COMMENTS + 5 }, (_, i) => ({ id: `c${i}`, slide: 1, text: 'x' }))
const long = fixCommentsPrompt(many)!
ok(long.includes(`Please fix these ${MAX_LISTED_COMMENTS + 5} review comments:`) && long.includes('…and 5 more'), 'a long batch is capped and names the rest')
ok(cleanLine('x'.repeat(500), 300).length === 300, 'a comment text is bounded')

ok(asPaste('a\nb') === '\x1b[200~a\nb\x1b[201~', 'a multi-line message is one bracketed paste')
ok(asPaste('one line') === 'one line', 'a one-line prompt is typed as is')

// --- "Fix with Claude" after a PowerPoint import ----------------------------
// The list comes from the deck (report details, shape names from the .pptx,
// the file name), so it gets the same escaping checks as comments.
const files = { dir: '.slidomingo-context-7', source: true, pdf: true }
const imp = fixImportPrompt({
  name: "Q3 it's $big.pptx",
  items: [
    { slide: 2, slideId: 's3', code: 'graphic-dropped', shape: 'sp "Diagram 4"', detail: 'SmartArt has no importer', count: 1 },
    { slide: 4, slideId: 's5', code: 'text-overflow', elementId: 's5-12', detail: nasty, count: 1 },
    { slide: 4, slideId: 's5', code: 'table-text-flattened', detail: 'runs flattened', count: 3 },
  ],
}, files)!
ok(typeof imp === 'string' && imp.includes('these 3 items need judgement'), 'an import list gives a message that counts its items')
ok(imp.includes('1. Slide 2 · sp “Diagram 4”: SmartArt has no importer  [graphic-dropped, slide id s3]'), 'an item names deck slide, source shape, code and slide id')
ok(imp.includes('· element s5-12:'), 'a text leftover names its element')
ok(imp.includes('(×3)'), 'a repeated finding shows its count')
ok(imp.includes('./.slidomingo-context-7/import/source.pptx') && imp.includes('./.slidomingo-context-7/import/source.pdf'), 'the message points at the copied file and its PDF')
ok(imp.includes('faithful copy') && imp.includes('subagent') && imp.includes('review_slide'), 'the message says: faithful, subagents per slide, verify')
ok(!SHELL_UNSAFE.test(imp), 'no shell-quoting characters survive in an import message')
ok(!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(imp.replaceAll("\n", "")), 'no control bytes survive in an import message')
const noPdf = fixImportPrompt({ name: 'a.pptx', items: [{ slide: 1, slideId: 's1', code: 'chart-no-data', detail: 'x' }] }, { ...files, pdf: false })!
ok(noPdf.includes('no picture of the original') && !noPdf.includes('source.pdf'), 'without LibreOffice the message says there is no picture')
const noSrc = fixImportPrompt({ name: 'a.pptx', items: [{ slide: 1, slideId: 's1', code: 'chart-no-data', detail: 'x' }] }, { ...files, source: false, pdf: false })!
ok(noSrc.includes('not available') && !noSrc.includes('source.pptx'), 'without the file the message says so')
ok(fixImportPrompt({ items: [{ slide: 1, slideId: 'bad id', code: 'x', detail: 'y' }, { slide: 1, slideId: 's1', code: 'NOT A CODE', detail: 'y' }, { slide: 1, slideId: 's1', code: 'ok', detail: ' ' }] }, files) === null,
  'bad slide ids, codes and empty details are dropped')
const lots = fixImportPrompt({ items: Array.from({ length: MAX_LISTED_IMPORT_ITEMS + 3 }, () => ({ slide: 1, slideId: 's1', code: 'x', detail: 'y' })) }, files)!
ok(lots.includes('…and 3 more'), 'a long import list is capped and names the rest')

// --- "Draw with AI" in an icon set (drawIconsPrompt) -----------------------------
const icons = drawIconsPrompt({
  brief: 'Digital forensics, outline, friendly',
  icons: [
    { slide: 1, slideId: 'slide_a', name: 'fingerprint', prompt: 'a fingerprint inside a magnifier' },
    { slide: 2, slideId: 'slide_b', name: nasty, prompt: nasty },
    { slide: 3, slideId: 'slide_c' },
  ],
})!
ok(icons.startsWith('Please draw these 3 icons'), 'the header counts the icons')
ok(icons.includes('1. Slide 1 “fingerprint”: a fingerprint inside a magnifier  [slide id slide_a]'), 'each icon: slide, name, what it shows, id')
ok(icons.includes('3. Slide 3 “icon 3”  [slide id slide_c]'), 'an unnamed icon without a brief still gets a line')
ok(icons.includes('The set: Digital forensics, outline, friendly'), 'the set brief is passed on')
ok(icons.includes('pathElement') && icons.includes('No text, no pictures, no svg'), 'it says how to draw: native paths, never svg')
ok(!SHELL_UNSAFE.test(icons) && !icons.includes('\x1b') && !icons.includes('\x00'), 'document text cannot break the shell quoting or the paste')
ok(drawIconsPrompt({ icons: [{ slide: 1, slideId: 'bad id' }, { slide: 0, slideId: 'x' }] }) === null && drawIconsPrompt(null) === null, 'bad ids and slide numbers are dropped')
const manyIcons = drawIconsPrompt({ icons: Array.from({ length: MAX_LISTED_ICONS + 2 }, (_, i) => ({ slide: i + 1, slideId: `s${i}` })) })!
ok(manyIcons.includes('…and 2 more'), 'a long icon list is capped and names the rest')

// --- "Plan with AI" (planIconsPrompt) --------------------------------------------
const planned = planIconsPrompt({ request: `think about 12 icons for forensics ${nasty}`, brief: 'outline, friendly' })!
ok(planned.startsWith('Please plan icons') && planned.includes('think about 12 icons for forensics'), 'the request is passed on in the user\'s words')
ok(planned.includes('icons op plan') && planned.includes('Do NOT draw'), 'it says to write a plan and not draw')
ok(!SHELL_UNSAFE.test(planned) && !planned.includes('\x1b'), 'the request cannot break the shell quoting or the paste')
ok(planIconsPrompt({ request: '  ' }) === null && planIconsPrompt(null) === null, 'an empty request gives no message')
ok(icons.includes('iconPart'), 'drawing asks for a part on every path (for the other styles)')
ok(icons.includes('If it has examples') && icons.includes('never copy theirs') && icons.includes('the pathElement, the examples and'), 'drawing works from the example icons, passes them to subagents, never copies them')

// --- "Describe a style" (styleIconsPrompt) ----------------------------------------
const styled = styleIconsPrompt({ request: `comic, yellow, thick lines ${nasty}`, brief: 'forensics' })!
ok(styled.startsWith('Please add a style') && styled.includes('comic, yellow, thick lines'), 'the look is passed on in the user\'s words')
ok(styled.includes('icons op style') && styled.includes('Do not draw'), 'one style call, nothing redrawn')
ok(styled.includes('a style cannot do it') && styled.includes('Drawing section'), 'a look that needs other shapes is sent to the drawing style instead')
ok(!SHELL_UNSAFE.test(styled) && !styled.includes('\x1b'), 'the description cannot break the shell quoting or the paste')
ok(styleIconsPrompt({ request: '' }) === null && styleIconsPrompt(7) === null, 'an empty description gives no message')

// --- LibreOffice render (sourcerender.ts) ------------------------------------
ok(findSoffice({ PATH: '/nope' }, () => false) === null, 'no LibreOffice anywhere → null (the fix goes ahead without a picture)')
ok(findSoffice({ PATH: '/x/bin' }, (p) => p === '/x/bin/soffice' || p === '/x/bin/soffice.exe')?.startsWith('/x/bin/soffice') === true, 'soffice is found on PATH')
const argv = convertArgs('/w/import/source.pptx', '/w/import', '/tmp/prof dir')
ok(argv.includes('--headless') && argv.at(-1) === '/w/import/source.pptx' && argv.includes('/w/import'), 'headless convert of the copied file into the import folder')
ok(argv.some((a) => a.startsWith('-env:UserInstallation=file:///tmp/prof%20dir')), 'a throwaway profile (a running LibreOffice would block the convert)')
ok(argv.some((a) => a.includes('ExportHiddenSlides')), 'hidden slides are exported, so page N stays slide N')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
