#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
// Untrusted-document rig: what a deck may put into the reader's DOM.
//
//   slides/node_modules/.bin/esbuild scripts/test-sanitize.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-sanitize.mjs" \
//     && node "$TMPDIR/test-sanitize.mjs"
//
// (Bundled, not run directly: render.ts imports './model' extensionless, the
// same reason the spaces undo rig is bundled in CI. Source paths below are
// therefore resolved from the REPO ROOT — import.meta.url would point at the
// bundle.)
//
// WHAT THIS PROVES. Every deck is untrusted input: mailed, downloaded, pasted,
// or delivered as a collab op into a file already open. Script running in this
// page is not a defaced slide — it holds `doc.collab.key`, the owner/writer
// private keys, the plaintext IndexedDB autosave store and the File System
// Access handle ⌘S writes through. It is the document AND the file on disk.
//
// Three places used to hand author data straight to the DOM:
//
//   1. AN `svg` ELEMENT'S MARKUP, assigned with innerHTML. Measured in Chrome
//      141 (2026-08-09): a deck whose svg element carried `<svg onload="…">`
//      ran it — from a DETACHED div, before anything was inserted anywhere.
//      The `svgAsImage` sibling path (a data-URI <img>) was inert all along,
//      which is why only the live path changed.
//   2. TABLE CELL COLOURS, PADDINGS AND ALIGNMENTS, interpolated into a `style`
//      attribute unescaped. Same measurement: a cell whose `bg` read
//      `red" onmouseover="steal()` produced a `<td>` with a real `onmouseover`
//      attribute — on the canvas, in present, in print and in every thumbnail.
//   3. `canvas.startTextEdit`, which swaps the RESOLVED text for the model's
//      raw html so the author edits `{{page:2}}` rather than "06". It assigned
//      `model.html` unsanitized, so double-clicking a text box was enough.
//
// WHY THE SVG SECTION LOOKS LIKE THIS. The first fix for (1) was a DENYLIST —
// five tags, `on*`, three url attributes — and this rig pinned it with source
// regexes over the call sites. A verifier then measured script still executing
// through the real renderSlide → renderElement → sanitizeSvg path in six ways,
// and every one of them passed all forty checks, because a source regex knows
// the sanitizer is CALLED and nothing about what it PERMITS. So:
//
//   * the policy is now an allowlist, and the allowlist itself is exercised
//     here in node, where it is pure data (SVG_TAGS, svgAttrAllowed,
//     svgHrefAllowed, svgUrlRefsAllowed, sanitizeSvgCss);
//   * the WALK is exercised in a real browser, against the real renderSlide,
//     with payloads that either run or do not. `--headless=new --dump-dom`
//     over a throwaway http server on 127.0.0.1, so a "did this deck phone
//     home" claim is answered by a request log and not by reading the code.
//
// The browser half needs Chrome. Where there is none it says so loudly and
// skips; the node half still fails on every one of the six bypasses, because
// every one of them is a question about the policy.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  renderTableHtml,
  sanitizeHtml,
  sanitizeLinkHref,
  sanitizeRunColor,
  sanitizeRunFontSize,
  sanitizeRunStyle,
  sanitizeSvgCss,
  svgAttrAllowed,
  svgHrefAllowed,
  svgUrlRefsAllowed,
  SVG_TAGS,
} from '../slides/src/render.ts'
import { defaultTable, newDoc } from '../slides/src/model.ts'
import { LIMITS, checkElementProp, sanitizeElement } from '../slides/src/untrusted.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) {
    failures++
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

const repoFile = (rel: string): string => {
  const file = path.resolve(rel)
  if (!fs.existsSync(file)) throw new Error(`run this rig from the repo root — ${rel} not found`)
  return file
}

// --- 1. the svg policy -------------------------------------------------------
//
// Pure data and pure functions, so the decisions can be inspected here while
// the walk that applies them is measured in a browser below. Both directions
// matter equally: a sanitizer that drops `url(#…)` refs renders every
// gradient-filled diagram blank, which is the failure that gets a sanitizer
// deleted again.

console.log('\nsvg tag allowlist')

ok(['svg', 'g', 'path', 'rect', 'circle', 'defs', 'pattern', 'lineargradient', 'radialgradient', 'stop',
  'clippath', 'mask', 'marker', 'filter', 'feturbulence', 'fecolormatrix', 'fegaussianblur',
  'text', 'tspan', 'use', 'image', 'style', 'animate'].every((t) => SVG_TAGS.has(t)),
  'the svg vocabulary the starter deck draws with is permitted')

for (const tag of ['script', 'foreignobject', 'iframe', 'object', 'embed', 'form', 'button', 'input',
  'meta', 'base', 'link', 'template', 'frame', 'frameset', 'audio', 'video', 'math']) {
  ok(!SVG_TAGS.has(tag), `<${tag}> is not permitted`)
}

console.log('\nsvg attribute allowlist')

ok(['id', 'class', 'd', 'viewbox', 'fill', 'stroke-width', 'transform', 'patternunits', 'stddeviation',
  'basefrequency', 'gradienttransform', 'preserveaspectratio', 'stop-color', 'clip-path', 'href',
  'xlink:href', 'attributename'].every(svgAttrAllowed),
  'the attributes real artwork carries are permitted, in the html parser’s casing too')
ok(svgAttrAllowed('viewBox') && svgAttrAllowed('attributeName') && svgAttrAllowed('stdDeviation'),
  'and matching is case-insensitive, which is how the parser’s foreign-content fixups line up')
ok(svgAttrAllowed('aria-label') && svgAttrAllowed('role'), 'aria-* and role are permitted')
ok(svgAttrAllowed('data-part'), 'a diagram’s own data-* CSS hook is permitted')

for (const attr of ['action', 'formaction', 'http-equiv', 'srcdoc', 'onclick', 'onload', 'onerror',
  'onbegin', 'formtarget', 'ping', 'rel', 'src', 'data-el-id', 'data-flip-id']) {
  ok(!svgAttrAllowed(attr), `${attr} is not permitted`)
}
// data-slidomingo is reserved as a PREFIX. The shell's own marks are the full names:
// kernel serializeBody DELETES every [data-beeslides-transient] node from the clone
// it saves, and save.ts removes [data-beeslides-preview] unconditionally. Reserving
// the bare string would have left an author element answering either query.
for (const attr of ['data-slidomingo', 'data-beeslides-transient', 'data-beeslides-preview', 'data-beeslides-state']) {
  ok(!svgAttrAllowed(attr), `${attr} is reserved to the shell, not lent to a diagram`)
}

console.log('\nsvg href policy')

ok(svgHrefAllowed('#grad-1'), 'a same-document fragment is kept — gradients and markers paint through url(#…)')
ok(svgHrefAllowed('https://example.com/a.png'), 'https is kept for an <image>')
ok(svgHrefAllowed('HTTP://EXAMPLE.COM/a.png'), 'scheme matching is case-insensitive')
ok(svgHrefAllowed('data:image/png;base64,iVBOR'), 'a data:image is kept — the browser loads it script-disabled')
ok(svgHrefAllowed('https://example.com/x', 'a'), 'and an <a> may point at the web — the reader clicks it')

ok(!svgHrefAllowed('javascript:alert(1)'), 'javascript: is refused')
ok(!svgHrefAllowed('JaVaScRiPt:alert(1)'), 'so is the mixed-case spelling')
ok(!svgHrefAllowed('  javascript:alert(1)'), 'leading whitespace does not smuggle it past')
ok(!svgHrefAllowed('java\tscript:alert(1)'), 'nor does a tab inside the scheme, which browsers ignore')
ok(!svgHrefAllowed('java\u0000script:alert(1)'), 'nor a NUL')
ok(!svgHrefAllowed('data:text/html,<svg onload=alert(1)>'), 'a data: that is not an image is refused')
ok(!svgHrefAllowed('//evil.example/x.svg'), 'protocol-relative is refused — it is a fetch out of a self-contained file')
ok(!svgHrefAllowed('sprites.svg#icon'), 'and so is the plain relative form, for the same reason')
ok(!svgHrefAllowed(''), 'an empty href is not a url')
ok(!svgHrefAllowed('https://evil.example/x.svg#s', 'use'),
  'a <use> may not instance a subtree out of another document, however ordinary the scheme')
ok(!svgHrefAllowed('https://evil.example/x.svg#g', 'lineargradient'),
  'nor may a gradient inherit from one')

console.log('\nurl() targets')

ok(svgUrlRefsAllowed('url(#bp-dots-i)'), 'fill="url(#…)" survives — it is the whole pattern/gradient idiom')
ok(svgUrlRefsAllowed('none') && svgUrlRefsAllowed('#F7A600'), 'a value with no url() at all is untouched')
ok(!svgUrlRefsAllowed('url(https://evil.example/paint.svg#g)'), 'an external paint server is refused')
ok(!svgUrlRefsAllowed("url('//evil.example/x')"), 'quoted and protocol-relative is still refused')
ok(!svgUrlRefsAllowed('url( \u0000https://evil.example/x )'), 'padding and control characters do not hide it')

console.log('\nsvg css')

ok(!/@import/i.test(sanitizeSvgCss('@import url("https://evil.example/t.css");\n.p{fill:red}')),
  '@import is removed — a live fetch out of a self-contained file, and a read receipt for a mailed deck')
ok(sanitizeSvgCss('@import "x.css";\n.p{fill:red}').includes('.p{fill:red}'),
  'the rest of the sheet survives: dropping it would cost the artwork')
ok(sanitizeSvgCss('.p{fill:url(#g)}') === '.p{fill:url(#g)}', 'url(#…) inside the sheet is untouched')
ok(sanitizeSvgCss('.p{background:url(https://evil.example/b.png)}').includes('background:none'),
  'an external url() becomes none — valid everywhere url() is legal, so the sheet still parses')
ok(!sanitizeSvgCss('@font-face{src:url(https://evil.example/f.woff2)}').includes('evil.example'),
  'and a webfont fetch goes the same way')

// The at-rule half is an ALLOWLIST because cutting `@import` by name did not
// work. Measured against the allowlist-tags build on 2026-08-09, Chrome 141:
// `@\69mport "http://…";` inside an svg <style> FETCHED — the probe server
// logged the request — because a CSS at-keyword is an ident and an ident takes
// escapes. The bare-string form has no `url(` in it either, so the url() rewrite
// above never saw it.
const escaped = sanitizeSvgCss('@\\69mport "https://evil.example/t.css";\n.p{fill:red}')
ok(!/@\\?[\\\w]*import/i.test(escaped) && escaped.includes('@beeslides-refused'),
  'an at-keyword written with a CSS escape is refused — @\\69mport is @import')
ok(escaped.includes('.p{fill:red}'), 'and the sheet around it still parses')
ok(sanitizeSvgCss('@im\\port url(x);').includes('@beeslides-refused'), 'so is @im\\port')
ok(sanitizeSvgCss('@\\49MPORT "x";').includes('@beeslides-refused'), 'and @\\49MPORT')
ok(!sanitizeSvgCss('@import "https://evil.example/t.css";').includes('evil.example')
  || sanitizeSvgCss('@import "https://evil.example/t.css";').startsWith('@beeslides-refused'),
  'the bare-STRING import is refused too — the url() rewrite cannot see that one')
ok(sanitizeSvgCss('@import "https://evil.example/t.css"\n.p{fill:red}').includes('@beeslides-refused'),
  'and so is the form with no semicolon, which the old regex required')
ok(!sanitizeSvgCss('@document url-prefix();.p{fill:red}').includes('@document'),
  'an at-rule nobody asked for is refused by default, which is the point of a list')

for (const at of ['@media screen{.p{fill:red}}', '@supports (fill:red){.p{fill:red}}',
  '@keyframes spin{to{transform:rotate(1turn)}}', '@-webkit-keyframes spin{to{opacity:0}}',
  '@font-face{font-family:X;src:local("X")}', '@layer base{.p{fill:red}}']) {
  ok(sanitizeSvgCss(at) === at, `${at.slice(0, at.indexOf(' ') > 0 ? at.indexOf(' ') : at.indexOf('{'))} is kept — motion and layout are what a diagram's sheet is for`)
}
ok(sanitizeSvgCss('.p::before{content:"a@b"}') === '.p::before{content:"a@b"}',
  'an @ that does not start a token is not an at-rule')
// A url() written with a CSS escape is still url() to the browser, and
// image-set() takes a bare string. All four FETCHED from svg css (2026-10-08
// review, Chromium request log) because the url() check is a regex for `url(`.
for (const [css, what] of [
  ['svg{background-image:u\\72l(https://evil.example/a.png)}', 'u\\72l('],
  ['svg{background-image:u\\72 l(https://evil.example/a.png)}', 'u\\72 l( (the escape eats one space)'],
  ['svg{background-image:u\\rl(https://evil.example/a.png)}', 'u\\rl('],
  ['svg{background-image:image-set("https://evil.example/a.png" 1x)}', 'image-set("…")'],
  ["svg{background-image:-webkit-image-set('https://evil.example/a.png' 1x)}", "-webkit-image-set('…')"],
]) {
  ok(sanitizeSvgCss(css).includes('beeslides-refused(') && !svgUrlRefsAllowed(css),
    `${what} is refused in a sheet and in an attribute`)
}
ok(sanitizeSvgCss('.q:not(.r){transform:translate(1px,2px) rotate(3deg)}') === '.q:not(.r){transform:translate(1px,2px) rotate(3deg)}'
  && svgUrlRefsAllowed('translate(1 2) rotate(3)'),
  'ordinary functions are untouched — the refusal is by name, not a ban on parentheses')
ok(!sanitizeSvgCss('a </style{}x>y<img src=x onerror=alert(1)>{}').includes('<'),
  'no raw < leaves the css sanitizer — an html <style> serializes its text verbatim, so </style would end it on a re-parse')
ok(sanitizeSvgCss('.p::before{content:"a<b"}') === '.p::before{content:"a\\3c b"}',
  'and the escape is the same character to CSS: \\3c plus the one space it eats')

// --- 2. the table, end to end ------------------------------------------------
//
// renderTableHtml is a string builder with no DOM in it, so the real output can
// be inspected here. Every value below is what a received deck can contain: the
// model's `string` and `number` are types, not promises.

console.log('\ntable style attribute')

const doc = newDoc()
const hostile = defaultTable()
hostile.rows[1].cells[0] = { html: 'ok', bg: 'red" onmouseover="steal()', color: '#0F0' }
hostile.rows[1].cells[1] = { html: 'two', align: 'right;background:url(https://evil.example/p)' as never }
hostile.rows[1].cells[2] = { html: 'three', color: 'expression(alert(1))' }
hostile.style.cellPadY = '0;position:fixed;inset:0' as never
hostile.style.borderColor = 'x" onclick="steal()'
hostile.style.fontFamily = 'Inter;}</sty' + 'le><b>x'
const out = renderTableHtml(hostile, doc)

/** One cell's opening tag — everything a parser reads before the first ">". */
const cellTag = (r: number, c: number) => {
  const at = out.indexOf(`<td data-r="${r}" data-c="${c}"`)
  return at < 0 ? '' : out.slice(at, out.indexOf('>', at) + 1)
}

ok(!/\son[a-z]+\s*=/i.test(out), 'no event-handler attribute is minted anywhere in the table')
ok(!out.includes('onmouseover="steal()') && !out.includes('onclick="steal()'),
  'the two handler payloads are gone, not merely renamed')
ok(!out.includes('evil.example'), 'an alignment carrying a url() cannot reach the stylesheet')
ok(!/expression\(/i.test(out), 'nor can expression()')
ok(!out.includes('position:fixed'), 'a padding that is not a number cannot add declarations')
ok(cellTag(1, 0).includes('background:transparent'), 'the rejected colour falls back rather than being "cleaned"')
ok(cellTag(1, 1).includes('text-align:left'), 'the rejected alignment falls back to the format default')
ok(out.includes('font-family:inherit'), 'and the rejected font stack falls back too')
// The structural version of the same claim, and the one that fails loudly on
// the old output: a `=` cannot occur inside a validated style value, so three
// of them is exactly data-r, data-c and style. The old cell had four.
ok((cellTag(1, 0).match(/=/g) ?? []).length === 3, 'the cell tag still carries three attributes and no fourth')

console.log('\ntable, unremarkable content')

const plain = defaultTable()
plain.rows[1].cells[0] = { html: 'Revenue', align: 'right', color: '#1E2A3A', bg: 'rgba(30,42,58,0.05)', bold: true }
const good = renderTableHtml(plain, doc)
ok(good.includes('text-align:right'), 'a real alignment survives')
ok(good.includes('color:#1E2A3A'), 'a hex colour survives')
ok(good.includes('background:rgba(30,42,58,0.05)'), 'an rgba() colour survives — the zebra stripe is one')
ok(good.includes(`font-family:${doc.theme.fontFamily.replace(/"/g, '&quot;')}`), "the deck's font stack survives")
ok(good.includes('font-size:18px') && good.includes('padding:11px 16px'), 'so do the numeric style fields')
ok(good.includes('>Revenue<'), 'and the cell text is still there')

const cjk = defaultTable()
cjk.style.fontFamily = 'ヒラギノ角ゴ ProN, sans-serif'
ok(renderTableHtml(cjk, doc).includes('ヒラギノ角ゴ'),
  'a non-ASCII font family survives — a character allowlist would have eaten it')

// --- 3. the raw-html swap ----------------------------------------------------
//
// startTextEdit shows the model's raw html so the author edits the TOKEN and
// not the computed value. Sanitizing there is only free if the two things the
// swap exists for are not markup — and they are not, which is the point.

console.log('\ntokens survive the sanitizer')

const RAW = '{{page:2}} of {{pages}} — $E=mc^2$ and $$\\frac{a}{b}$$'
ok(sanitizeHtml(RAW).includes('{{page:2}}'), 'a zero-padded page field round-trips')
ok(sanitizeHtml(RAW).includes('$E=mc^2$'), 'inline TeX source round-trips')
ok(sanitizeHtml(RAW).includes('$$\\frac{a}{b}$$'), 'display TeX source round-trips')

// --- alt text ----------------------------------------------------------------
//
// `alt` is prose a deck carries for screen readers. It reaches the DOM only as
// an attribute VALUE (img.alt, aria-label via setAttribute), so the intake
// rule is type and length, nothing else — a description may quote, use angle
// brackets, anything. The browser half below proves the attribute half.

console.log('\nalt text')

const pic = (alt: unknown) => sanitizeElement({
  id: 'p', type: 'image', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1,
  src: 'data:image/png;base64,AAAA', fit: 'cover', radius: 0, alt,
}) as { alt?: unknown } | null
ok(pic('A red bicycle against a wall')?.alt === 'A red bicycle against a wall', 'a description survives a paste')
ok(pic('')?.alt === '', 'the empty string survives — it means decorative, not missing')
ok(pic('Say "hi" <b>& bye</b>')?.alt === 'Say "hi" <b>& bye</b>',
  'quotes and angle brackets are kept verbatim — the value never becomes markup')
ok(!!pic(42) && !('alt' in pic(42)!), 'a non-string alt is dropped, the picture kept')
ok(!('alt' in pic('x'.repeat(LIMITS.alt + 1))!), 'an alt over the length cap is dropped')
ok(pic('x'.repeat(LIMITS.alt))?.alt === 'x'.repeat(LIMITS.alt), 'one at the cap is kept')
for (const type of ['image', 'svg', 'chart', 'media']) {
  ok(checkElementProp(type, 'alt', 'described').ok, `alt is an accepted property of ${type}`)
}
ok(!checkElementProp('text', 'alt', 'x').ok && !checkElementProp('shape', 'alt', 'x').ok,
  'and of nothing else — text is its own description, a shape is decoration')

console.log('\nsvg vars')

const drawing = (vars: unknown) => sanitizeElement({
  id: 'v', type: 'svg', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, markup: '<svg/>', vars,
}) as { vars?: Record<string, unknown> } | null
ok(JSON.stringify(drawing({ leaf: '#3a7d2c', wind: 0.4, tilt: '12deg', sky: 'rgb(10, 20, 30)', mode: 'none' })?.vars)
  === JSON.stringify({ leaf: '#3a7d2c', wind: 0.4, tilt: '12deg', sky: 'rgb(10, 20, 30)', mode: 'none' }),
'colours, numbers, a number with a unit and a keyword survive a paste')
const hostileVars = drawing({
  a: 'red;}body{display:none', b: 'url(https://evil.example/x.svg)', c: '"x"', d: 'var(--x)',
  e: 'rgb(1,2,3) url(x)', '--f': 1, 'g h': 1, ok: 2,
})?.vars
ok(JSON.stringify(hostileVars) === JSON.stringify({ ok: 2 }),
  'a breakout, a url(), quotes, a nested var(), a second token and a bad name all drop, alone')
ok(!!drawing({ x: 'url(a)' }) && !('vars' in drawing({ x: 'url(a)' })!), 'vars with nothing usable drop whole, the drawing stays')
ok(Object.keys(drawing(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`v${i}`, i])))?.vars ?? {}).length
  === LIMITS.svgVars, `at most ${LIMITS.svgVars} vars are kept`)
ok(checkElementProp('svg', 'vars', { a: 1 }).ok && !checkElementProp('shape', 'vars', { a: 1 }).ok,
  'vars belong to svg only')

// --- 3b. rich text: the value policies ---------------------------------------
//
// Rich text phase 1 (DECISIONS 2026-10-08) lets text keep links, lists and
// coloured/sized runs. The sanitizer's walk is measured in the browser below;
// what it lets an href or a style SAY is pure functions, pinned here. Every
// value is parsed and RE-SERIALISED, so the checks below compare outputs, not
// "did it contain a bad word".

console.log('\nrich text: link hrefs')

ok(sanitizeLinkHref('https://example.com/a?b=c#d') === 'https://example.com/a?b=c#d', 'an ordinary https link is kept as written')
ok(sanitizeLinkHref('http://example.com') === 'http://example.com/', 'http is kept, in the URL parser\'s canonical form')
ok(sanitizeLinkHref('HTTPS://EXAMPLE.COM/X') === 'https://example.com/X', 'the scheme and host are case-folded by the parser, the path is not')
ok(sanitizeLinkHref('mailto:someone@example.com?subject=Hi') === 'mailto:someone@example.com?subject=Hi', 'mailto is kept')
ok(sanitizeLinkHref('  https://example.com/  ') === 'https://example.com/', 'surrounding spaces are trimmed the way the URL parser trims them')

for (const [href, why] of [
  ['javascript:alert(1)', 'javascript:'],
  ['JaVaScRiPt:alert(1)', 'mixed-case javascript:'],
  ['  javascript:alert(1)', 'leading-space javascript:'],
  ['\u0001javascript:alert(1)', 'a leading C0 control (the parser strips it — so must we, before judging)'],
  ['java\tscript:alert(1)', 'a tab inside the scheme (the parser removes tabs anywhere)'],
  ['java\nscript:alert(1)', 'a newline inside the scheme'],
  ['java\rscript:alert(1)', 'a carriage return inside the scheme'],
  ['javascript&#58;alert(1)', 'an entity left encoded (the DOM decodes; a raw string must not slip through either)'],
  ['jav&#x61;script:alert(1)', 'a hex entity in the scheme'],
  ['&#106;avascript:alert(1)', 'a decimal entity in the scheme'],
  ['javascript%3Aalert(1)', 'a percent-encoded colon'],
  ['vbscript:msgbox(1)', 'vbscript:'],
  ['data:text/html,<script>alert(1)</scr' + 'ipt>', 'data:text/html'],
  ['data:image/svg+xml,<svg onload=alert(1)>', 'data:image/svg+xml'],
  ['DATA:text/html;base64,PHNjcmlwdD4=', 'upper-case data: with base64'],
  ['file:///etc/passwd', 'file:'],
  ['blob:https://example.com/uuid', 'blob:'],
  ['about:blank', 'about:'],
  ['chrome://settings', 'a browser-internal scheme'],
  ['//evil.example/x', 'protocol-relative'],
  ['/relative/path', 'a relative path'],
  ['#slide-3', 'a fragment'],
  ['https:', 'a scheme with nothing after it'],
  ['http://', 'http with no host'],
  ['https://user:pass@evil.example/', 'credentials in the URL'],
  ['https://bank.example@evil.example/', 'the user-info trick that makes a link lie about its host'],
  ['mailto:x@y\u0000.z', 'an embedded NUL'],
  ['', 'empty'],
  ['https://example.com/' + 'a'.repeat(5000), 'a link far past the length cap'],
] as const) {
  ok(sanitizeLinkHref(href) === null, `rejected: ${why}`)
}
ok(sanitizeLinkHref(42) === null && sanitizeLinkHref(null) === null && sanitizeLinkHref({}) === null,
  'a non-string href (a hand-edited JSON) is no link')

// Characters the renderer's own string passes would read as syntax. A kept
// href goes through resolveMath ($…$) and the field markers ({{…}}) after
// sanitizing, so either one surviving would splice markup INTO the attribute.
const spliced = sanitizeLinkHref('https://example.com/$x$/?q={{title}}&r="a"&s=\'b\'&t=<i>&u=`c`')
ok(spliced !== null && !/[$"'<>`{}\\\s]/.test(spliced),
  'a kept href carries no $, {, }, quote, angle bracket, backtick or backslash — all percent-encoded')
ok(spliced!.includes('%24x%24') && spliced!.includes('%7B%7Btitle%7D%7D'),
  'and they are encoded, not dropped — the address still means the same page')
ok(sanitizeLinkHref('https://example.com\\@evil.example/') === null || !sanitizeLinkHref('https://example.com\\@evil.example/')!.includes('\\'),
  'a backslash never survives (the parser treats it as a slash for http)')

console.log('\nrich text: run styles')

ok(sanitizeRunStyle('color:#FF0000') === 'color:#ff0000', 'a hex colour is kept, lower-cased')
ok(sanitizeRunStyle('color: #abc; font-size: 24px') === 'color:#abc;font-size:24px', 'colour and size together, whitespace normalised')
ok(sanitizeRunStyle('color: rgb(255, 0, 0);') === 'color:rgb(255, 0, 0)', 'the browser\'s own rgb() spelling is kept')
ok(sanitizeRunStyle('color: rgba(0, 0, 0, 0.5)') === 'color:rgba(0, 0, 0, 0.5)', 'and rgba()')
ok(sanitizeRunStyle('color: rgb(300 0 0 / 50%)') === 'color:rgba(255, 0, 0, 0.5)', 'the space syntax is read, clamped and re-written')
ok(sanitizeRunStyle('color: var(--sl-accent1)') === 'color:var(--sl-accent1)', 'a palette slot reference is kept')
ok(sanitizeRunStyle('COLOR:#FFF;FONT-SIZE:2EM') === 'color:#fff;font-size:2em', 'property names and units are case-insensitive')
ok(sanitizeRunStyle('font-size:150%') === 'font-size:150%', 'a percentage size is kept')
ok(sanitizeRunStyle('font-size:18.333px') === 'font-size:18.33px', 'a size is rounded on the way through')
ok(sanitizeRunStyle('color:#111;color:#222') === 'color:#222', 'the last valid declaration wins, as in CSS')
ok(sanitizeRunStyle('color:#111;color:expression(alert(1))') === 'color:#111', 'an invalid later one does not erase a valid earlier one')
ok(sanitizeRunStyle(`font-family: "Iowan Old Style", 'Palatino Linotype', Georgia, serif`) === 'font-family:Iowan Old Style, Palatino Linotype, Georgia, serif', 'a font family list is kept, written without quotes')
ok(sanitizeRunStyle('font-family:"Source Sans 3", -apple-system, sans-serif') === 'font-family:-apple-system, sans-serif', 'a family name that needs quotes (a word starting with a digit) is left out of the list')
ok(sanitizeRunStyle('font-weight:650;font-style:italic;letter-spacing:.14em') === 'font-weight:650;font-style:italic;letter-spacing:0.14em', 'weight, style and letter spacing are kept')
ok(sanitizeRunStyle('font-family: Georgia, url(https://evil.example/f.woff), serif') === 'font-family:Georgia, serif', 'url() inside a family list costs only itself')
ok(sanitizeRunStyle('font-weight:bold;letter-spacing:-1.5px;font-style:normal') === 'font-weight:700;font-style:normal;letter-spacing:-1.5px', 'bold becomes 700, a negative px spacing is kept')

for (const [style, why] of [
  ['color: expression(alert(1))', 'expression()'],
  ['color: red', 'a named colour (not in the format)'],
  ['background: url(https://evil.example/x.png)', 'background with url()'],
  ['background-image:url(//evil.example/x)', 'background-image'],
  ['behavior: url(x.htc)', 'behavior'],
  ['-moz-binding: url(x.xml#xss)', '-moz-binding'],
  ['color: var(--evil)', 'a custom property that is not a palette slot'],
  ['color: var(--sl-accent1, url(https://evil.example/v.png))', 'a palette var() with a fallback'],
  ['color: var(--sl-accent9)', 'a slot that does not exist'],
  ['color: #ff0000 !important', '!important'],
  ['color: #ff000', 'a five-digit hex'],
  ['color: #ff0000/**/', 'a comment'],
  ['color: \\23 ff0000', 'a CSS escape'],
  ['col\\6fr: #ff0000', 'an escaped property name'],
  ['color: rgb(255, 0, 0) url(x)', 'rgb() with a tail'],
  ['color: rgb(calc(1), 0, 0)', 'a function inside rgb()'],
  ['color: rgb(1e3, 0, 0)', 'an exponent in a channel'],
  ['color: hsl(0, 100%, 50%)', 'hsl() (not in phase 1)'],
  ['font-size: 0px', 'a zero size'],
  ['font-size: 99999px', 'a size past the bound'],
  ['font-size: 1e3px', 'an exponent'],
  ['font-size: -12px', 'a negative size'],
  ['font-family: url(https://evil.example/f.woff)', 'url() as a family'],
  ['font-family: a$b', 'a dollar in a family'],
  ['font-family: {{page}}', 'braces in a family'],
  ['font-family: "Ev\\69l"', 'an escape in a family'],
  ['font-family: inherit', 'a CSS-wide keyword as a family'],
  ['font-family: x/**/y', 'a comment in a family'],
  ['font-weight: 1000', 'a weight past 900'],
  ['font-weight: 50', 'a weight below 100'],
  ['font-weight: bolder', 'a relative weight'],
  ['font-style: oblique 10deg', 'an oblique angle'],
  ['letter-spacing: 3em', 'a spacing past the bound'],
  ['letter-spacing: calc(1px)', 'calc() spacing'],
  ['font-size: 12pt', 'a unit not on the list'],
  ['font-size: calc(100vw)', 'calc()'],
  ['font-size: xxx-large', 'a keyword'],
  ['position: fixed; inset: 0', 'layout properties'],
  ['color:#fff" onclick="alert(1)', 'an attribute breakout'],
  ['color:#fff}</sty' + 'le><script>', 'a stylesheet breakout'],
] as const) {
  ok(sanitizeRunStyle(style) === '', `dropped whole: ${why}`)
}
ok(sanitizeRunStyle('color:#fff;}</sty' + 'le><script>') === 'color:#fff',
  'a breakout after a valid declaration costs only itself — the colour before it is re-written, the rest is gone')
ok(sanitizeRunStyle('color:#fff;background:url(https://evil.example/b.png);font-size:20px') === 'color:#fff;font-size:20px',
  'a smuggled declaration between two good ones is dropped, the good ones kept')
ok(sanitizeRunStyle('x'.repeat(5000)) === '' && sanitizeRunStyle(7) === '', 'oversized or non-string style is no style')
ok(/^[a-z0-9#(),.%:;\s-]*$/.test(sanitizeRunStyle('color: rgb(9 9 9 / .5); font-size: 3em')),
  'output is built from digits, hex, units and fixed keywords only')
ok(sanitizeRunColor('rgb(0,0,0)') === 'rgb(0, 0, 0)' && sanitizeRunFontSize('1.5em') === '1.5em',
  'the per-value helpers agree with the style parser')

// --- 4. the walk, in a browser ----------------------------------------------
//
// Everything above is a decision. This is the machinery, and the machinery is
// where the bypasses lived: a policy is only as good as the walk that reaches
// every node. So the payloads below go through the REAL renderSlide into a
// REAL document, and the ones that are supposed to run are given every chance
// to — inserted, clicked, submitted — while a local server logs whether the
// page reached for anything.
//
// The `MUST NOT execute` cases each have a number: they are the six the
// verifier measured against the denylist build (2026-08-09, Chrome 141). 1, 2
// and 3 ran or navigated for real there; 4 fetched; 5 and 6 survived the walk
// intact and were refused only by Blink's own restraint, which is not a
// security boundary.

const CHROME = [
  process.env.SLIDOMINGO_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p): p is string => !!p && fs.existsSync(p))
  ?? (spawnSync('which', ['google-chrome']).status === 0 ? 'google-chrome' : undefined)

/**
 * The page that does the work. Bundled by esbuild against the repo's own
 * render.ts, so this is the shipping code path and not a re-implementation of
 * it. Written without backticks or `${` so it can live in a template literal.
 */
const probeSource = (renderPath: string, modelPath: string, richProbePath: string) => `
import { renderSlide, sanitizeHtml } from ${JSON.stringify(renderPath)}
import { newDoc } from ${JSON.stringify(modelPath)}
import { richTextProbe } from ${JSON.stringify(richProbePath)}

const O = location.origin
const pwned: number[] = []
;(window as any).__pwn = (n: number) => { pwned.push(n) }

const results: Array<[string, boolean]> = []
const check = (name: string, pass: boolean) => { results.push([name, pass]) }

/** The shipping path: model → renderSlide → renderElement → sanitizeSvg. */
function draw(markup: string, css?: string): HTMLElement {
  const doc = newDoc()
  const slide = doc.slides[0]
  slide.elements = [{
    id: 'sv1', type: 'svg', x: 0, y: 0, w: 200, h: 200,
    rotation: 0, opacity: 1, markup, ...(css ? { css } : {}),
  } as any]
  const surface = renderSlide(slide, doc)
  document.body.appendChild(surface)
  return surface
}

if (location.pathname === '/meta.html') {
  // Finding 2, the live half: if the meta survives the walk, Chrome navigates
  // this document to /pwned.html and the dumped DOM is somebody else's page.
  draw('<svg><rect width="10" height="10"/><meta http-equiv="refresh" content="0;url=/pwned.html"></svg>')
  draw('<div>x</div><meta http-equiv="refresh" content="0;url=/pwned.html">')
} else {
  try {
    const baseBefore = document.baseURI

    // Several payloads below open with a throwaway <div>, and it is not padding:
    // a LEADING <link>, <meta>, <base> or <template> is hoisted into <head> by
    // DOMParser, and the walk only ever sees parsed.body. Tested at the front of
    // the string, every one of them passes against a sanitizer that does nothing
    // — measured on the denylist build, which "passed" three of these until the
    // div went in. One line of body content is what puts them in the walk's way.

    // --- 1. form-driven javascript: (action / formaction / input type=image) ---
    const shot = draw(
      '<form action="javascript:window.__pwn(11)"><button type="submit">go</button></form>' +
      '<form><button type="submit" formaction="javascript:window.__pwn(12)">go</button></form>' +
      '<form action="javascript:window.__pwn(13)">' +
      '<input type="image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></form>'
    )
    check('1 — no <form>, <button> or <input> survives the walk',
      shot.querySelectorAll('form, button, input').length === 0)

    // --- 2. meta refresh (structure here, navigation in the second run) --------
    const metas = draw('<svg><rect width="10" height="10"/><meta http-equiv="refresh" content="0;url=/pwned.html"></svg>' +
      '<div>x</div><meta http-equiv="refresh" content="0;url=/pwned.html">')
    check('2 — no <meta> survives the walk', metas.querySelectorAll('meta').length === 0)

    // --- 3. base href ----------------------------------------------------------
    const based = draw('<div>x</div><base href="' + O + '/evil/"><svg><rect width="10" height="10"/></svg>')
    check('3 — no <base> survives the walk', based.querySelectorAll('base').length === 0)
    check('3 — relative urls still resolve against this document', document.baseURI === baseBefore)

    // --- 4. network out of a self-contained file -------------------------------
    draw('<div>x</div><link rel="stylesheet" href="' + O + '/tracker.css">' +
      '<svg><style>@import url("' + O + '/imported.css");.q{fill:red}</sty' + 'le>' +
      '<rect class="q" width="10" height="10" fill="url(' + O + '/paint.svg#g)"/></svg>')
    draw('<svg><rect width="10" height="10"/></svg>', '@import url("' + O + '/model-css.css");.z{fill:red}')

    // 4, the spellings that beat a regex written around the word "import".
    // Both of these FETCHED against the build that cut @import by name
    // (2026-08-09, Chrome 141): an at-keyword is an ident, and an ident takes
    // escapes; and the string form carries no url( for the url() rewrite to
    // find. This is why CSS at-rules are an allowlist now.
    draw('<svg><style>@\\\\69mport "' + O + '/esc-import.css";.q{fill:red}</sty' + 'le>' +
      '<rect width="10" height="10"/></svg>')
    draw('<svg><style>@import "' + O + '/str-import.css";.q{fill:red}</sty' + 'le>' +
      '<rect width="10" height="10"/></svg>')
    // no semicolon where the parser wants one, and a <style> in HTML context
    // rather than inside the svg — same sheet, same policy, different route in.
    draw('<svg><style>@import "' + O + '/nosemi-import.css"\\n.q{fill:red}</sty' + 'le></svg>')
    draw('<div>x</div><style>@\\\\69mport "' + O + '/html-style.css";</style>')

    // 4, the spellings that beat a regex written around the word "url(":
    // a CSS escape in the function name, and image-set's bare string. All four
    // fetched from a deck before the 2026-10-08 fix.
    draw('<svg width="10" height="10"><style>svg{background-image:u\\\\72l(' + O + '/esc-style.png)}</sty' + 'le>' +
      '<rect width="10" height="10"/></svg>')
    draw('<svg width="10" height="10"><style>svg{background-image:image-set("' + O + '/imageset-style.png" 1x)}</sty' + 'le>' +
      '<rect width="10" height="10"/></svg>')
    draw('<svg width="10" height="10" style="background-image:u\\\\rl(' + O + '/esc-attr.png)"><rect width="10" height="10"/></svg>')
    draw('<svg width="10" height="10" style="background-image:-webkit-image-set(\\'' + O + '/imageset-attr.png\\' 1x)">' +
      '<rect width="10" height="10"/></svg>')
    draw('<svg width="10" height="10"><rect width="10" height="10"/></svg>', 'svg{background-image:u\\\\72l(' + O + '/esc-model-css.png)}')

    // and the sheet a real diagram writes still animates
    const sheet = draw('<svg><style>@keyframes bp-spin{to{transform:rotate(1turn)}}' +
      '@media (min-width:1px){.q{fill:url(#g)}}</sty' + 'le>' +
      '<rect class="q" width="10" height="10"/></svg>')
    check('a diagram keeps @keyframes and @media — the allowlist is not a ban on CSS',
      (sheet.querySelector('style')?.textContent ?? '').includes('@keyframes bp-spin') &&
      (sheet.querySelector('style')?.textContent ?? '').includes('@media (min-width:1px)'))

    // --- 5. SMIL retargeting ---------------------------------------------------
    const smil = draw('<svg><rect id="sm" width="10" height="10">' +
      '<set attributeName="onclick" to="window.__pwn(51)"/>' +
      '<animate attributeName="href" to="javascript:window.__pwn(52)" dur="1s" fill="freeze"/>' +
      '</rect></svg>')
    check('5 — an animation that would write an on* handler is gone',
      smil.querySelectorAll('set, animate').length === 0)
    check('5 — and nothing in the subtree carries an onclick',
      !Array.from(smil.querySelectorAll('*')).some((e) => e.hasAttribute('onclick')))

    // --- 6. template ------------------------------------------------------------
    const tpl = draw('<div>x</div><template><img src="x" onerror="window.__pwn(61)"><svg onload="window.__pwn(62)"></svg></template>')
    check('6 — no <template> survives, so nothing hides in .content',
      tpl.querySelectorAll('template').length === 0 && !tpl.innerHTML.includes('__pwn'))

    // --- 7. the xlink spelling of everything above -----------------------------
    //
    // href and xlink:href are the same attribute to a browser, and a policy
    // that only knows the short name is a policy with a second door in it.
    const xl = draw('<svg xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<a id="xa" xlink:href="javascript:window.__pwn(81)"><rect width="10" height="10"/></a>' +
      '<image id="xi" xlink:href="' + O + '/xlink-remote.png" width="10" height="10"/>' +
      '<use id="xu" xlink:href="' + O + '/xlink.svg#s"/>' +
      '<rect id="xr" width="10" height="10"><animate attributeName="xlink:href" to="javascript:window.__pwn(82)" dur="1s"/></rect>' +
      '</svg>')
    check('7 — a javascript: xlink:href loses its href just as a plain one does',
      !!xl.querySelector('#xa') && !xl.querySelector('#xa')!.hasAttribute('xlink:href'))
    check('7 — a <use> reaching out of the document by xlink:href is dropped whole',
      !xl.querySelector('#xu'))
    check('7 — an animation retargeting xlink:href is gone',
      xl.querySelectorAll('animate').length === 0)

    // --- 8. the html integration points --------------------------------------
    //
    // <desc>, <title> and <foreignObject> are where the parser LEAVES foreign
    // content and resumes html rules, so a <script> written inside one is a real
    // html script element and not svg text. The walk has to recurse into them.
    const desc = draw('<svg><desc><scr' + 'ipt>window.__pwn(91)</scr' + 'ipt>' +
      '<img src="' + O + '/desc-img.png" onerror="window.__pwn(92)"></desc>' +
      '<title><img src="' + O + '/title-img.png"></title><rect width="10" height="10"/></svg>')
    check('8 — nothing survives inside <desc> or <title>, where html parsing resumes',
      desc.querySelectorAll('script, img').length === 0 && !!desc.querySelector('rect'))

    // --- 9. an svg carried as a data: image ------------------------------------
    //
    // data:image/ is allowed on an <image> href on purpose. An svg loaded THAT
    // way is script-disabled by the browser, and this is the check that says so
    // rather than assuming it.
    draw('<svg><image width="99" height="99" href="data:image/svg+xml,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="99" height="99" onload="top.__pwn(101)">' +
        '<rect width="9" height="9" fill="red"/></svg>') + '"/></svg>')

    // --- 0. the case round one did fix, still fixed ----------------------------
    const classic = draw('<svg onload="window.__pwn(1)"><rect id="clicky" width="10" height="10" onclick="window.__pwn(2)"/>' +
      '<scr' + 'ipt>window.__pwn(3)</scr' + 'ipt>' +
      '<foreignObject><img src="x" onerror="window.__pwn(4)"></foreignObject></svg>')
    check('0 — script and foreignObject are gone and no on* handler is left',
      classic.querySelectorAll('script, foreignObject').length === 0 &&
      !Array.from(classic.querySelectorAll('*')).some((e) =>
        Array.from(e.attributes).some((a) => a.name.toLowerCase().startsWith('on'))))

    // --- 10. rich text: tags nested inside an unwrapped wrapper ----------------
    //
    // sanitizeHtml UNWRAPS a tag it does not know (font, x, a) and keeps its
    // children. It used to walk a snapshot taken before the move, so whatever
    // it hoisted out was never looked at: the img below came out with its
    // onerror intact, and ran three times on one text box (2026-10-08 review).
    // It also serialized through a div of the LIVE document, where an <img>
    // starts loading the moment it exists, so the handler fired inside
    // sanitizeHtml itself, before anything was inserted. data:,x never decodes,
    // so onerror is guaranteed to fire if the img is real.
    const richOut = [
      sanitizeHtml('<font><img src="data:,x" onerror="window.__pwn(201)"></font>hello'),
      sanitizeHtml('<x><svg onload="window.__pwn(202)"><rect width="1" height="1"/></svg></x>'),
      sanitizeHtml('<a href="#"><b><font><i><span><u><img src="data:,x" onerror="window.__pwn(203)"></u></span></i></font></b></a>'),
      sanitizeHtml('<table><tr><td><img src="data:,x" onerror="window.__pwn(204)">cell</td></tr></table>'),
    ]
    check('10 — nothing nested inside an unwrapped tag survives the rich-text sanitizer',
      richOut.every((h) => !/<(img|svg)|onerror|onload/i.test(h)))
    check('10 — the text and the allowed tags around it are kept',
      richOut[0] === 'hello' && richOut[2] === '<b><i><span><u></u></span></i></b>' && richOut[3] === 'cell')
    const rich = newDoc()
    rich.slides[0].elements = [{
      id: 'tx1', type: 'text', x: 0, y: 0, w: 300, h: 100, rotation: 0, opacity: 1,
      html: '<font><img src="data:,x" onerror="window.__pwn(205)"></font>hello', fontSize: 20,
      fontFamily: '', fontWeight: 400, color: '#000', align: 'left', valign: 'top', lineHeight: 1.2,
    } as any]
    const richSurface = renderSlide(rich.slides[0], rich)
    document.body.appendChild(richSurface)
    check('10 — and a text element rendered from it holds no <img>',
      richSurface.querySelectorAll('img').length === 0)

    // --- 11. a sanitized svg must survive a serialize/parse round trip ---------
    //
    // present.ts used to replay svg animations with host.innerHTML =
    // host.innerHTML. The <style> below is OUTSIDE the svg, so it is an html
    // <style>, whose text serializes verbatim; scopeCss turned the inert
    // '</style{' into a real end tag ('</style {'), and the re-parse closed the
    // element early and made the img after it live (2026-10-08 review). The
    // present path clones now; this pins the sanitizer half: its output has to
    // be the same nodes after a round trip, whoever serializes it next.
    const mx = draw('x<style>a </style{}x>y<img src="data:,x" onerror="window.__pwn(211)">{}</style>' +
      '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
    const mxHost = mx.querySelector('.beeslides-el-svg') as HTMLElement
    mxHost.innerHTML = mxHost.innerHTML
    check('11 — a sanitized svg re-parses to no new elements (no html <style> breakout)',
      mxHost.querySelectorAll('img').length === 0 && mxHost.querySelectorAll('style').length === 1)

    // --- 12. model values that reach CSS from an opened deck -------------------
    //
    // untrusted.ts guards a paste, but a deck opened from a file never goes
    // through it. slide.background is a CSS shorthand and an image's fit and
    // radius were interpolated into cssText, so both of these fetched — with
    // offline mode on (2026-10-08 review).
    const css = newDoc()
    css.slides[0].background = 'url(' + O + '/slide-bg.png)'
    css.slides[0].elements = [{
      id: 'im1', type: 'image', x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1,
      src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
      fit: 'contain;background-image:url(' + O + '/image-fit.png)',
      radius: '0px;background-image:url(' + O + '/image-radius.png)',
    } as any]
    const cssSurface = renderSlide(css.slides[0], css)
    document.body.appendChild(cssSurface)
    const cssImg = cssSurface.querySelector('img') as HTMLImageElement
    check('12 — a url() slide background is not applied', !cssSurface.style.background.includes('url'))
    check('12 — a fit that smuggles a declaration falls back to contain',
      cssImg.style.objectFit === 'contain' && !cssImg.style.backgroundImage)
    const grad = newDoc()
    grad.slides[0].background = 'linear-gradient(135deg, #0D1B2E 0%, rgba(20, 40, 80, 0.5) 100%)'
    check('12 — a gradient background still draws',
      renderSlide(grad.slides[0], grad).style.background.includes('linear-gradient'))

    // --- refs -------------------------------------------------------------------
    const refs = draw('<svg><a id="ok" href="https://example.com/x">t</a>' +
      '<a id="bad" href="javascript:window.__pwn(71)">t</a>' +
      '<image id="img" href="' + O + '/remote.png" width="10" height="10"/>' +
      '<image id="jsimg" href="javascript:window.__pwn(72)" width="10" height="10"/>' +
      '<use id="localuse" href="#ok"/><use id="remoteuse" href="' + O + '/x.svg#s"/></svg>')
    check('an <a> to the web is kept', refs.querySelector('#ok')!.getAttribute('href') === 'https://example.com/x')
    check('a javascript: <a> loses its href but keeps its place in the layout',
      !!refs.querySelector('#bad') && !refs.querySelector('#bad')!.hasAttribute('href'))
    check('an http <image> is kept', !!refs.querySelector('#img'))
    check('a javascript: <image> loses its href', !refs.querySelector('#jsimg')!.hasAttribute('href'))
    check('a same-document <use> is kept', !!refs.querySelector('#localuse'))
    check('a <use> pointing out of this document is dropped whole', !refs.querySelector('#remoteuse'))

    // --- the artwork that has to keep drawing ----------------------------------
    const art = draw('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" preserveAspectRatio="none">' +
      '<defs><pattern id="bp-dots-i" width="28" height="28" patternUnits="userSpaceOnUse">' +
      '<circle cx="1.5" cy="1.5" r="1.4" fill="#FFFFFF" opacity="0.07"/></pattern>' +
      '<radialGradient id="bp-ga-am"><stop offset="0" stop-color="#FFEED6" stop-opacity="0.15"/></radialGradient>' +
      '<filter id="bp-grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>' +
      '<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.045 0"/></filter></defs>' +
      '<sty' + 'le>.dot{fill:url(#bp-ga-am)}</sty' + 'le>' +
      '<rect width="1280" height="720" fill="url(#bp-dots-i)" filter="url(#bp-grain)"/></svg>')
    check('a pattern keeps its id — url(#…) resolves document-globally',
      !!art.querySelector('pattern#bp-dots-i') && !!art.querySelector('radialGradient#bp-ga-am'))
    check('and the rect still points at it', art.querySelector('rect')!.getAttribute('fill') === 'url(#bp-dots-i)')
    check('feTurbulence keeps baseFrequency and feColorMatrix keeps values',
      art.querySelector('feTurbulence')!.getAttribute('baseFrequency') === '0.9' &&
      !!art.querySelector('feColorMatrix')!.getAttribute('values'))
    check('viewBox and preserveAspectRatio survive the parser round-trip',
      art.querySelector('svg')!.getAttribute('viewBox') === '0 0 1280 720')
    // The <style> INSIDE the markup is kept because removing it breaks real
    // decks, and its content is filtered by sanitizeSvgCss. This check asserts
    // only that the RULES SURVIVE — deliberately NOT whether they are scoped,
    // because that is changing underneath it: on main the markup sheet is
    // unscoped (scopeCss's one call site takes el.css, not the markup), and
    // PR #402 scopes it. Claiming either state here would make this rig a
    // hostage to that PR's merge order.
    //
    // Hence the whitespace squash, which is the whole reason this is not a plain
    // includes(): scopeCss emits the scope, a space, the selector, then a space
    // before the brace — so scoping rewrites '.dot{fill:...}' as
    // '[data-el-id="..."] .dot {fill:...}' and a literal substring test fails on
    // ONE INSERTED SPACE while the rules are perfectly intact. Measured both
    // ways. The two checks below cover the scoping question properly, on el.css,
    // which is the field scopeCss actually guards.
    //
    // NOTE, and this cost a build: everything here is inside probeSource's
    // template literal. A backtick or a dollar-brace in a COMMENT is still code
    // to the parser and ends the template early.
    // NOTE the DOUBLED backslash: this line lives inside probeSource's template
    // literal, where a single backslash-s is an escape that collapses to a bare
    // 's' — the regex became /s+/g and stripped the letter s out of the markup
    // (the element id 'sv1' came back as 'v1', which is how it was caught).
    const squash = (css) => css.replace(/\\s+/g, '')
    check('the svg <style> inside the markup is kept, with its rules intact',
      squash(art.querySelector('style')?.textContent ?? '').includes(squash('.dot{fill:url(#bp-ga-am)}')))

    const scoped = draw('<svg viewBox="0 0 20 20"><rect id="sc" width="10" height="10"/></svg>',
      '.z{fill:red}@keyframes k{to{opacity:0}}')
    const elSheet = scoped.querySelector('svg > style')?.textContent ?? ''
    check('el.css IS scoped to the element — this is what keeps one diagram out of another',
      elSheet.includes('[data-el-id="sv1"] .z') && elSheet.trim().indexOf('.z') !== 0)
    check('and @keyframes stays top-level — a prefixed keyframes name resolves to nothing',
      elSheet.includes('@keyframes k') && !elSheet.includes('[data-el-id="sv1"] @keyframes'))

    const sloppy = draw('<svg viewBox="0 0 20 20"><rect width="10" height="10"><circle cx="5" cy="5" r="2"/></svg>')
    check('an unclosed tag still draws — text/html, not the fatal xml parser',
      !!sloppy.querySelector('svg') && !!sloppy.querySelector('circle'))

    // --- alt text: an attribute value, never markup ----------------------------
    const HOSTILE = '"><img src=x onerror="window.__pwn(91)"><svg onload="window.__pwn(92)">'
    const altDoc = newDoc()
    const altSlide = altDoc.slides[0]
    const box = { x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1 }
    altSlide.elements = [
      { id: 'ai', type: 'image', ...box, src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', fit: 'cover', radius: 0, alt: HOSTILE },
      { id: 'ac', type: 'chart', ...box, option: { series: [] }, alt: HOSTILE },
      { id: 'as', type: 'svg', ...box, markup: '<svg viewBox="0 0 1 1"></svg>', alt: '' },
      { id: 'av', type: 'media', kind: 'video', ...box, src: 'data:video/mp4;base64,AAAA', alt: 'A cat' },
      { id: 'ad', type: 'image', ...box, src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', fit: 'cover', radius: 0, alt: '' },
    ] as any
    const altLive = renderSlide(altSlide, altDoc)
    const altThumb = renderSlide(altSlide, altDoc, { svgAsImage: true })
    document.body.append(altLive, altThumb)
    const imgOf = (root, id) => root.querySelector('[data-el-id="' + id + '"] img')
    check('alt — an image carries its alt verbatim as the img alt', imgOf(altLive, 'ai')?.alt === HOSTILE)
    check('alt — and it stays ONE img: the value did not open a tag',
      altLive.querySelectorAll('[data-el-id="ai"] img').length === 1 && !altLive.querySelector('img[src="x"]'))
    const chartNode = altLive.querySelector('[data-el-id="ac"]')
    check('alt — a chart is role=img with the alt as its aria-label',
      chartNode?.getAttribute('role') === 'img' && chartNode?.getAttribute('aria-label') === HOSTILE)
    check('alt — an empty alt hides a decorative svg from assistive tech',
      altLive.querySelector('[data-el-id="as"]')?.getAttribute('aria-hidden') === 'true')
    check('alt — the thumbnail svg-as-image gets alt="" too', imgOf(altThumb, 'as')?.getAttribute('alt') === '')
    // The saved no-JS layer swaps every stored <img> for a div[role=img] and
    // carries only a NON-empty alt over (kernel save.ts storePictures), so a
    // decorative picture must be hidden on its wrapper, which the swap leaves.
    check('alt — a decorative image is hidden on its WRAPPER too (survives the no-JS img swap)',
      altLive.querySelector('[data-el-id="ad"]')?.getAttribute('aria-hidden') === 'true' &&
      imgOf(altLive, 'ad')?.getAttribute('alt') === '' &&
      altThumb.querySelector('[data-el-id="as"]')?.getAttribute('aria-hidden') === 'true')
    check('alt — a described image is not hidden', !altLive.querySelector('[data-el-id="ai"]')?.hasAttribute('aria-hidden'))
    check('alt — a live video is labelled but stays a control (no role=img)',
      altLive.querySelector('[data-el-id="av"] video')?.getAttribute('aria-label') === 'A cat' &&
      !altLive.querySelector('[data-el-id="av"] video')?.hasAttribute('role'))
    check('alt — its still (thumbnails, no-JS layer) is role=img with the label',
      altThumb.querySelector('[data-el-id="av"] [role="img"]')?.getAttribute('aria-label') === 'A cat')

    // --- the slide title is a heading (a11y) ----------------------------------
    // role:'title' text renders as role=heading aria-level=2 on its text box,
    // in every render (canvas, thumbnails/no-JS layer/preview = svgAsImage);
    // any other text stays a plain box.
    const hdDoc = newDoc()
    const hdSlide = hdDoc.slides[0]
    const tbox = { x: 0, y: 0, w: 600, h: 100, rotation: 0, opacity: 1, fontSize: 24, fontFamily: 'sans-serif',
      fontWeight: 400, color: '#111111', align: 'left', valign: 'top', lineHeight: 1.2 }
    hdSlide.elements = [
      { id: 'ht', type: 'text', ...tbox, role: 'title', html: 'Quarterly results' },
      { id: 'hb', type: 'text', ...tbox, role: 'body', html: 'Body copy' },
      { id: 'hp', type: 'text', ...tbox, html: 'Plain' },
    ] as any
    for (const [label, opts] of [['live', {}], ['still', { svgAsImage: true, hidePlaceholders: true }]] as const) {
      const s = renderSlide(hdSlide, hdDoc, opts as any)
      const inner = (id) => s.querySelector('[data-el-id="' + id + '"] .beeslides-text-inner')
      check('heading (' + label + ') — the title text is role=heading aria-level=2',
        inner('ht')?.getAttribute('role') === 'heading' && inner('ht')?.getAttribute('aria-level') === '2' &&
        inner('ht')?.textContent === 'Quarterly results')
      check('heading (' + label + ') — body and role-less text are not headings',
        !inner('hb')?.hasAttribute('role') && !inner('hp')?.hasAttribute('role') &&
        s.querySelectorAll('[role="heading"]').length === 1)
    }

    // --- rich text (phase 1, DECISIONS 2026-10-08) ----------------------------
    //
    // Text html through the REAL renderSlide: sanitizeHtml, then the field and
    // math string passes, then innerHTML. Numbers 2xx are rich-text payloads;
    // a 2xx in the pwned list means one ran.
    const text = (html: string): HTMLElement => {
      const doc = newDoc()
      const slide = doc.slides[0]
      slide.elements = [{
        id: 'tx1', type: 'text', x: 0, y: 0, w: 600, h: 400, rotation: 0, opacity: 1,
        html, fontSize: 24, fontFamily: 'sans-serif', fontWeight: 400, color: '#111111',
        align: 'left', valign: 'top', lineHeight: 1.2,
      } as any]
      const surface = renderSlide(slide, doc)
      document.body.appendChild(surface)
      return surface.querySelector('.beeslides-text-inner') as HTMLElement
    }
    const allowedAttrs: Record<string, string[]> = { A: ['href', 'target', 'rel'], SPAN: ['style'] }
    const onlyAllowed = (root: Element) => Array.from(root.querySelectorAll('*')).every((e) =>
      e.closest('math') || Array.from(e.attributes).every((a) => (allowedAttrs[e.tagName] ?? []).includes(a.name)))

    const hrefs = text(
      '<a id="h1" href="javascript:window.__pwn(201)">a</a>' +
      '<a href="jav&#x61;script:window.__pwn(202)">b</a>' +
      '<a href="&#106;avascript:window.__pwn(203)">c</a>' +
      '<a href=" javascript:window.__pwn(204)">d</a>' +
      '<a href="java&#9;script:window.__pwn(205)">e</a>' +
      '<a href="java&#10;script:window.__pwn(206)">f</a>' +
      '<a href="&#1;javascript:window.__pwn(207)">g</a>' +
      '<a href="JaVaScRiPt:window.__pwn(208)">h</a>' +
      '<a href="vbscript:msgbox(209)">i</a>' +
      '<a href="data:text/html,%3Cscript%3Ewindow.opener.__pwn(210)%3C/script%3E">j</a>' +
      '<a href="//' + location.host + '/proto-rel">k</a>' +
      '<a href="/relative">l</a>' +
      '<a href="https://user:pw@example.com/">m</a>' +
      '<a href="https://example.com/ok">ok</a>' +
      '<a href="mailto:someone@example.com">mail</a>')
    const keptHrefs = Array.from(hrefs.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    check('rich — only the https and mailto links keep an anchor: ' + keptHrefs.join(' '),
      keptHrefs.length === 2 && keptHrefs[0] === 'https://example.com/ok' && keptHrefs[1] === 'mailto:someone@example.com')
    check('rich — every refused link keeps its words', (hrefs.textContent ?? '').replace(/\\s/g, '') === 'abcdefghijklmokmail')
    check('rich — a kept link always opens apart: target=_blank rel="noopener noreferrer"',
      Array.from(hrefs.querySelectorAll('a')).every((a) => a.getAttribute('target') === '_blank' && a.getAttribute('rel') === 'noopener noreferrer'))

    const smuggle = text(
      '<a href="https://example.com/" onclick="window.__pwn(211)" onmouseover="window.__pwn(212)" ' +
        'target="_self" rel="opener" ping="' + O + '/ping" style="position:fixed;inset:0" id="x1" class="c" data-x="1">s</a>' +
      '<span style="color:#00ff00" onclick="window.__pwn(213)" id="sp" class="sl-field" title="t" lang="x">t</span>' +
      '<b onclick="window.__pwn(214)" style="color:red">u</b>' +
      '<ul onclick="window.__pwn(215)" type="disc"><li value="9" onclick="window.__pwn(216)">v</li></ul>' +
      '<span style="color:#fff" STYLE="font-size:999999px">w</span>' +
      '<img src="x" onerror="window.__pwn(217)"><svg onload="window.__pwn(218)"><a href="javascript:window.__pwn(219)">z</a></svg>')
    check('rich — no attribute survives that is not on its tag\\'s list (on*, id, class, target/rel/ping as written, style on b)',
      onlyAllowed(smuggle))
    check('rich — target and rel are OURS, whatever the deck wrote',
      smuggle.querySelector('a')?.getAttribute('target') === '_blank' && smuggle.querySelector('a')?.getAttribute('rel') === 'noopener noreferrer')
    check('rich — a span keeps exactly its parsed colour', smuggle.querySelector('span')?.getAttribute('style') === 'color:#00ff00')
    check('rich — no img and no svg reach the text', !smuggle.querySelector('img, svg'))

    const styles = text(
      '<span id="s1" style="color: expression(window.__pwn(220))">a</span>' +
      '<span style="background:url(' + O + '/style-url.png)">b</span>' +
      '<span style="color:#fff;background-image:url(' + O + '/bg-image.png);font-size:20px">c</span>' +
      '<span style="behavior:url(' + O + '/behavior.htc)">d</span>' +
      '<span style="-moz-binding:url(' + O + '/binding.xml#x)">e</span>' +
      '<span style="color:var(--sl-accent1, url(' + O + '/var-fallback.png))">f</span>' +
      '<span style="font-size:12px;background:u\\\\72l(' + O + '/escaped-url.png)">g</span>' +
      '<span style="color:red/**/;list-style-image:url(' + O + '/list-image.png)">h</span>' +
      '<span style="font-size:99999px">i</span>')
    const styleAttrs = Array.from(styles.querySelectorAll('[style]')).map((e) => e.getAttribute('style') ?? '')
    check('rich — every surviving style is colour/size only: ' + styleAttrs.join(' | '),
      styleAttrs.every((v) => /^(color:(#[0-9a-f]+|rgba?\\([0-9., ]+\\)|var\\(--sl-[a-zA-Z0-9]+\\)))?;?(font-size:[0-9.]+(px|em|%))?$/.test(v)))
    check('rich — the smuggled background between two good declarations is gone, the good ones kept',
      styleAttrs.includes('color:#fff;font-size:20px'))

    const unwrapped = text('<x-foo><img src="' + O + '/unwrap-img.png" onerror="window.__pwn(221)"></x-foo>' +
      '<font color="red"><svg><image href="x" onerror="window.__pwn(222)"/></svg></font>' +
      '<custom-el><a href="javascript:window.__pwn(223)">k</a><span onclick="window.__pwn(224)">m</span></custom-el>' +
      '<div><table><tr><td><iframe src="' + O + '/frame.html"></iframe>cell</td></tr></table></div>')
    check('rich — an unwrapped element\\'s children are walked too: no img/svg/iframe, no handler, no javascript: href',
      !unwrapped.querySelector('img, svg, iframe') && onlyAllowed(unwrapped) && !unwrapped.querySelector('a'))
    check('rich — and their words are still there', (unwrapped.textContent ?? '').includes('k') && (unwrapped.textContent ?? '').includes('cell'))

    let bomb = ''
    for (let i = 0; i < 300; i++) bomb += '<ul><li>' + i
    const t0 = performance.now()
    const deep = text(bomb)
    const deepMs = performance.now() - t0
    let maxDepth = 0
    for (const li of Array.from(deep.querySelectorAll('li'))) {
      let d = 0
      for (let n: Element | null = li; n && n !== deep; n = n.parentElement) if (n.tagName === 'UL' || n.tagName === 'OL') d++
      maxDepth = Math.max(maxDepth, d)
    }
    check('rich — a 300-deep list bomb is cut to six levels (' + maxDepth + ') in ' + Math.round(deepMs) + 'ms',
      maxDepth <= 6 && maxDepth >= 1 && deepMs < 2000)
    check('rich — and the bomb\\'s words survive as text', (deep.textContent ?? '').includes('299'))
    let bold = ''
    for (let i = 0; i < 2000; i++) bold += '<b><i>'
    const deepInline = text(bold + 'core')
    check('rich — a 4000-deep inline nest renders, flattened, with its text', (deepInline.textContent ?? '').includes('core'))

    const model = text('<ul><li>a</li><ul><li>b</li></ul>stray<li>c</li></ul><li>orphan</li><ol> <li>n</li> </ol>')
    const ul = model.querySelector('ul')!
    check('rich — the list model: a nested list moves INTO the item before it',
      ul.children[0]?.tagName === 'LI' && ul.children[0].querySelector(':scope > ul > li')?.textContent === 'b')
    check('rich — stray text in a list becomes an item, a list holds only items',
      Array.from(ul.children).every((c) => c.tagName === 'LI') && Array.from(ul.children).some((c) => c.textContent === 'stray'))
    check('rich — an item outside any list is unwrapped', !Array.from(model.querySelectorAll('li')).some((li) => !li.parentElement || !/^(UL|OL)$/.test(li.parentElement.tagName)))

    const lined = text('<div>x<ul><li>a</li></ul>y</div><div><div><ol><li>n</li></ol></div></div><ul><li><div>in</div><div><ul><li>keep</li></ul></div></li></ul>')
    check('rich — a list is lifted out of the line div the browser built it in (x | list | y): ' + lined.innerHTML,
      lined.innerHTML.startsWith('<div>x</div><ul><li>a</li></ul><div>y</div><ol><li>n</li></ol><ul><li>'))
    check('rich — but a block inside a list item stays where it is', !!lined.querySelector('li > div > ul > li'))

    const nested = text('<a href="https://a.example/">x<b><a href="https://b.example/">y</a></b></a>')
    check('rich — no link inside a link', !nested.querySelector('a a'))

    // the string passes AFTER the sanitizer: math and field markers
    const math = text('<a id="m1" href="https://example.com/$x$/{{title}}">$y$ and {{page}}</a>')
    const ma = math.querySelector('a')
    check('rich — $…$ and {{…}} in an href cannot splice markup into the attribute',
      !!ma && Array.from(ma.attributes).map((a) => a.name).sort().join(',') === 'href,rel,target' &&
      (ma.getAttribute('href') ?? '').includes('%24x%24'))
    check('rich — while the same tokens in the link text still render', !!ma?.querySelector('math'))

    const good = text('<span style="color:#ff0000;font-size:30px">red</span> <a href="https://example.com/">link</a> ' +
      '<ol><li>one<ul><li>sub</li></ul></li><li>two</li></ol>')
    check('rich — a real coloured, sized run renders its colour',
      getComputedStyle(good.querySelector('span')!).color === 'rgb(255, 0, 0)' && getComputedStyle(good.querySelector('span')!).fontSize === '30px')
    check('rich — and a real list renders as one', good.querySelectorAll('ol > li').length === 2 && !!good.querySelector('ol > li > ul > li'))

    // the editor/markdown/builds half, which needs a DOM but no payloads
    // (scripts/lib/rich-text-probe.ts)
    richTextProbe(check)

    // --- equations (2026-10-09): the math element and $…$ in table cells ---
    // Both splice Temml output into the DOM, so hostile TeX must come out as
    // text. 3xx in the pwned list means one ran. (BS: a backslash without
    // fighting this template literal's escaping.)
    const BS = String.fromCharCode(92)
    const eqDraw = (tex: string): HTMLElement => {
      const doc = newDoc()
      const slide = doc.slides[0]
      slide.elements = [{
        id: 'eq1', type: 'math', x: 0, y: 0, w: 600, h: 200, rotation: 0, opacity: 1,
        tex, fontSize: 40, color: '#111111', align: 'center', valign: 'middle',
      } as any]
      const surface = renderSlide(slide, doc)
      document.body.appendChild(surface)
      return surface.querySelector('.beeslides-math-box') as HTMLElement
    }
    const cellDraw = (html: string): HTMLElement => {
      const doc = newDoc()
      const slide = doc.slides[0]
      slide.elements = [{
        id: 'tb1', type: 'table', x: 0, y: 0, w: 600, h: 200, rotation: 0, opacity: 1,
        columns: [{ w: 1 }], header: false, rows: [{ cells: [{ html }] }],
        style: { fontSize: 20, color: '#111111', borderColor: '#999999', borderWidth: 1, cellPadX: 8, cellPadY: 4 },
      } as any]
      const surface = renderSlide(slide, doc)
      document.body.appendChild(surface)
      return surface.querySelector('.beeslides-cell-inner') as HTMLElement
    }
    const noHandlers = (root: Element) => Array.from(root.querySelectorAll('*')).every((e) =>
      Array.from(e.attributes).every((a) => !a.name.startsWith('on') && !/javascript:/i.test(a.value)))
    const okEq = eqDraw('x = ' + BS + 'frac{-b ' + BS + 'pm ' + BS + 'sqrt{b^2-4ac}}{2a}')
    check('math — an equation typesets to MathML carrying its source', !!okEq.querySelector('math[data-tex]') && noHandlers(okEq))
    const hrefEq = eqDraw(BS + 'href{javascript:window.__pwn(301)}{click}')
    check('math — ' + BS + 'href is refused (trust off): source shown as text, no link',
      !hrefEq.querySelector('a, [href]') && hrefEq.classList.contains('beeslides-math-error') && (hrefEq.textContent ?? '').includes('javascript'))
    const tagEq = eqDraw('x</math><img src="data:,x" onerror="window.__pwn(302)"><svg onload="window.__pwn(303)">')
    check('math — markup in TeX never becomes a tag', !tagEq.querySelector('img, svg, script') && noHandlers(tagEq))
    const quoteEq = eqDraw('a < b " onmouseover="window.__pwn(304)" & c')
    check('math — quotes and < in TeX cannot break out of the data-tex attribute', noHandlers(quoteEq) && !quoteEq.querySelector('[onmouseover]'))
    const htmlEq = eqDraw(BS + 'htmlClass{x}{y} ' + BS + 'htmlStyle{background:url(' + O + '/eq-bg.png)}{y} ' + BS + 'includegraphics{' + O + '/eq-img.png}')
    check('math — ' + BS + 'html… and ' + BS + 'includegraphics are refused', !htmlEq.querySelector('math') && !htmlEq.querySelector('img, [style*="url"]'))
    const okCell = cellDraw('area $' + BS + 'pi r^2$')
    check('math — $…$ typesets in a table cell', !!okCell.querySelector('math[data-tex]') && noHandlers(okCell))
    const tagCell = cellDraw('$</math><img src="data:,x" onerror="window.__pwn(305)">$ and <img src="data:,x" onerror="window.__pwn(306)">')
    check('math — a cell: markup inside or outside $…$ never becomes a tag', !tagCell.querySelector('img, svg, script') && noHandlers(tagCell))
    const hrefCell = cellDraw('$' + BS + 'href{javascript:window.__pwn(307)}{x}$')
    check('math — a cell: hostile TeX stays literal', !hrefCell.querySelector('a, math') && (hrefCell.textContent ?? '').includes('href'))

    // Give every payload its chance: insertion alone is not the only trigger.
    // Measured on the pre-sanitizer build, where the difference showed: a
    // form-driven javascript: needs the submit button CLICKED, and an
    // onclick on a rect needs a click dispatched at the rect. Only the
    // javascript: anchors are clicked — clicking an ordinary one navigates the
    // probe away and it reports nothing at all.
    for (const el of Array.from(document.querySelectorAll('button, input'))) (el as HTMLElement).click()
    for (const f of Array.from(document.querySelectorAll('form'))) {
      try { (f as HTMLFormElement).requestSubmit() } catch { /* no submitter */ }
    }
    for (const a of Array.from(document.querySelectorAll('a'))) {
      const href = (a.getAttribute('href') ?? a.getAttribute('xlink:href') ?? '').toLowerCase()
      if (href.startsWith('javascript:')) (a as HTMLElement).click()
    }
    // Never inside an <a>: a click that bubbles to the ALLOWED
    // https://example.com anchor navigates, and a probe that navigated reports
    // nothing at all (measured — the dump held the rendered slides and no
    // results block).
    for (const el of Array.from(document.querySelectorAll('#clicky, [onclick], [onmouseover]'))) {
      if (!el.closest('a')) el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }

  } catch (err) {
    // A probe that dies half way through would otherwise report only the
    // checks it reached, all of them passing.
    check('the probe ran to the end (it threw: ' + String(err) + ')', false)
  }

  setTimeout(() => {
    check('nothing executed: ' + (pwned.length ? pwned.join(',') : 'clean'), pwned.length === 0)
    const pre = document.createElement('pre')
    pre.id = 'beeslides-results'
    // btoa is Latin-1 only and every check name here has an em dash in it:
    // encode to utf-8 bytes first or this throws and the rig reports nothing.
    const utf8 = new TextEncoder().encode(JSON.stringify(results))
    pre.textContent = 'SLIDOMINGO-RESULTS:' + btoa(String.fromCharCode(...utf8)) + ':END'
    document.body.appendChild(pre)
  }, 400)
}
`

async function runBrowserSection(chrome: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slidomingo-sanitize-'))
  const entry = path.join(tmp, 'probe.ts')
  fs.writeFileSync(entry, probeSource(repoFile('slides/src/render.ts'), repoFile('slides/src/model.ts'), repoFile('scripts/lib/rich-text-probe.ts')))
  execFileSync(repoFile('slides/node_modules/.bin/esbuild'), [
    entry, '--bundle', '--format=esm', '--outfile=' + path.join(tmp, 'probe.js'),
  ], { stdio: 'pipe' })
  const bundle = fs.readFileSync(path.join(tmp, 'probe.js'), 'utf8')

  // Written by concatenation: never a literal script-close in a source file
  // (AGENTS.md #1). This one is not spliced into a deck, but the habit is the
  // rule.
  // The trailing <img> is a LOAD GATE, and it is load-bearing: the new headless
  // ignores --virtual-time-budget, so `--dump-dom` fires at the load event and
  // a probe that reports from a timer reports nothing at all (measured — the
  // dump held every rendered slide and no results block). The server answers
  // /slow.gif late, load waits for it, and the probe's timer lands first.
  const page = (marker: string) =>
    '<!doctype html><meta charset="utf-8"><title>slidomingo sanitize probe</title>' +
    '<body>' + marker +
    '<scr' + 'ipt type="module" src="/probe.js"></scr' + 'ipt>' +
    '<img src="/slow.gif" width="1" height="1" alt=""></body>'

  const hits: string[] = []
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    hits.push(url)
    if (url === '/probe.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle); return }
    if (url === '/probe.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('SLIDOMINGO-PROBE')); return }
    if (url === '/meta.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('SLIDOMINGO-STAYED')); return }
    if (url === '/pwned.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html>SLIDOMINGO-NAVIGATED'); return }
    if (url.endsWith('.css')) { res.writeHead(200, { 'content-type': 'text/css' }); res.end('.tracked{fill:red}'); return }
    const gif = () => {
      res.writeHead(200, { 'content-type': 'image/gif' })
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'))
    }
    if (url === '/slow.gif') { setTimeout(gif, 1500); return }
    gif()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  // spawn, never spawnSync: the server above lives in THIS process, so a
  // synchronous child blocks the event loop that has to answer Chrome's
  // request for /probe.js — measured as a hang, not as a failure.
  const load = (route: string) => new Promise<string>((resolve) => {
    const child = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--disable-default-apps',
      '--user-data-dir=' + path.join(tmp, 'profile'),
      '--virtual-time-budget=4000', '--dump-dom',
      `http://127.0.0.1:${port}${route}`,
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let dom = ''
    child.stdout.on('data', (b: Buffer) => { dom += b.toString('utf8') })
    const done = setTimeout(() => child.kill('SIGKILL'), 45_000)
    child.on('close', () => { clearTimeout(done); resolve(dom) })
  })

  try {
    const dom = await load('/probe.html')
    const blob = /SLIDOMINGO-RESULTS:([A-Za-z0-9+/=]+):END/.exec(dom)
    if (!blob) {
      const dumped = path.join(os.tmpdir(), 'slidomingo-sanitize-dump.html')
      fs.writeFileSync(dumped, dom)
      ok(false, `the browser probe reported results (it did not — dumped DOM in ${dumped})`)
    } else {
      for (const [name, pass] of JSON.parse(Buffer.from(blob[1], 'base64').toString('utf8')) as Array<[string, boolean]>) {
        ok(pass, name)
      }
    }

    // Finding 2's live half. A page that navigated is somebody else's page.
    const metaDom = await load('/meta.html')
    ok(!metaDom.includes('SLIDOMINGO-NAVIGATED') && metaDom.includes('SLIDOMINGO-STAYED'),
      '2 — a meta refresh in a deck does not navigate the reader off the document')

    ok(!hits.includes('/tracker.css'), '4 — a <link rel=stylesheet> in a deck never fetches')
    ok(!hits.includes('/imported.css'), '4 — nor does @import inside the svg <style>')
    ok(!hits.includes('/model-css.css'), "4 — nor @import in the model's own css field")
    ok(!hits.includes('/paint.svg'), '4 — nor an external paint server in fill="url(…)"')
    ok(!hits.includes('/esc-import.css'), '4 — nor @\\69mport, which fetched until at-rules became an allowlist')
    ok(!hits.includes('/str-import.css'), '4 — nor the bare-string @import, which carries no url() to rewrite')
    ok(!hits.includes('/nosemi-import.css'), '4 — nor the form with no semicolon')
    ok(!hits.includes('/html-style.css'), '4 — nor a <style> that reached the body in html context')
    ok(!hits.includes('/esc-style.png') && !hits.includes('/esc-attr.png') && !hits.includes('/esc-model-css.png'),
      '4 — nor a url() spelled with a CSS escape, in a <style>, a style attribute or the css field')
    ok(!hits.includes('/imageset-style.png') && !hits.includes('/imageset-attr.png'),
      "4 — nor image-set()'s bare string url")
    ok(!hits.includes('/slide-bg.png') && !hits.includes('/image-fit.png') && !hits.includes('/image-radius.png'),
      "12 — nor a slide background, an image's fit or its radius from an opened deck")
    ok(!hits.includes('/desc-img.png') && !hits.includes('/title-img.png'),
      '8 — nothing inside <desc> or <title> fetches either')
    ok(!hits.includes('/xlink.svg'), '7 — nor an xlink:href <use> pointing out of the document')
    ok(hits.includes('/remote.png'), 'an <image href="http(s)://…"> still loads — that one is allowed on purpose')
    ok(hits.includes('/xlink-remote.png'), 'and so does the xlink:href spelling of it — the policy is not a ban on pictures')
    for (const path of ['/style-url.png', '/bg-image.png', '/behavior.htc', '/binding.xml', '/var-fallback.png',
      '/escaped-url.png', '/list-image.png', '/unwrap-img.png', '/frame.html', '/ping']) {
      ok(!hits.includes(path), `rich — a text run never fetches ${path}`)
    }
  } finally {
    server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\nthe walk, in a browser')
if (!CHROME) {
  console.log('  ⚠ SKIPPED — no Chrome found. Set SLIDOMINGO_CHROME to a binary to run this section;')
  console.log('    it is the only half that can prove a payload does not RUN.')
} else {
  await runBrowserSection(CHROME)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
