#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
//
// The `slide_html` agent tool (slides/src/htmlslide.ts, htmlemit.ts) in a real
// browser, judged by EYE as well as by the model:
//   1. each case is a slide written as HTML/CSS through the tool; the raw HTML
//      as Chrome draws it and the slide BeeSlides drew from it are
//      screenshotted and compared pixel by pixel — the conversion is right
//      only if the slide LOOKS like the HTML;
//   2. the model is checked for what had to become what (frames from flexbox,
//      ids, rich text, table/chart/code/picture, background);
//   3. a rewrite keeps what HTML cannot say (fx) and is ONE undo step;
//   4. read hands back the remembered source; once the slide is edited it
//      generates HTML instead, and writing that back moves nothing (every
//      frame within 1px) — on the cases and on every slide of the example
//      decks (docs/examples) and the starter library;
//   5. nothing in the HTML runs or loads: no script, no handler, no request.
//   node scripts/test-slide-html-e2e.mjs [url] [--shots <dir>]
// url defaults to the built editor (npm run build:single first). --shots
// writes every screenshot, its diff and report.json (the visual report).
// Needs playwright-core (same lookup as test-icons-e2e.mjs); SKIPS with exit 0
// without it or a build. Headless.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const shotsAt = argv.indexOf('--shots')
const shots = shotsAt >= 0 ? argv.splice(shotsAt, 2)[1] : null
if (shots) mkdirSync(shots, { recursive: true })

async function loadChromium() {
  const tries = []
  if (process.env.PLAYWRIGHT_CORE) tries.push(pathToFileURL(process.env.PLAYWRIGHT_CORE).href)
  tries.push('playwright-core')
  const npx = join(homedir(), '.npm/_npx')
  if (existsSync(npx)) for (const d of readdirSync(npx)) {
    const p = join(npx, d, 'node_modules/playwright-core/index.mjs')
    if (existsSync(p)) tries.push(pathToFileURL(p).href)
  }
  for (const spec of tries) { try { return (await import(spec)).chromium } catch { /* next */ } }
  return null
}
const skip = (why) => { console.log(`test-slide-html-e2e: SKIP — ${why}`); process.exit(0) }
const built = join(root, 'slides/dist-single/BeeSlides.beeslides.html')
const url = argv[0] ?? (existsSync(built) ? pathToFileURL(built).href : null)
if (!url) skip('no build and no url given')
const chromium = await loadChromium()
if (!chromium) skip('playwright-core not found (set PLAYWRIGHT_CORE)')
let browser
try { browser = await chromium.launch({ headless: true }) } catch (e) { skip(`no browser: ${String(e.message).split('\n')[0]}`) }

let checks = 0, failures = 0
const ok = (c, m, d) => { checks++; if (c) console.log(`  ok    ${m}`); else { failures++; console.log(`  FAIL  ${m}${d === undefined ? '' : ' — ' + JSON.stringify(d).slice(0, 400)}`) } }
const report = { cases: [], roundtrips: [] }

// ---- the editor, with the desktop bridge faked (as test-agent-icons-e2e.mjs)
const page = await (await browser.newContext({ viewport: { width: 1700, height: 1050 } })).newPage()
const errors = []
const requests = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('request', (r) => { if (!/^(file|data|blob|about):/.test(r.url())) requests.push(r.url()) })
await page.addInitScript(() => {
  window.__results = {}
  window.__ran = 0
  const impl = {
    onAgentAction: (cb) => { window.__agent = cb },
    sendAgentActionResult: (r) => { window.__results[r.requestId] = r },
  }
  window.slidomingoDesktop = new Proxy(impl, { get: (t, k) => (k in t ? t[k] : () => Promise.resolve(undefined)) })
})
await page.goto(url)
await page.waitForTimeout(1500)
const blank = page.locator('button:visible:has-text("Blank")').first()
if (await blank.count()) await blank.click()
await page.waitForFunction(() => !!window.__agent && !!window.beeslides?.doc, null, { timeout: 20000 })
await page.waitForTimeout(400)
const bootErrors = errors.splice(0)

let rq = 0
async function act(verb, args) {
  const id = `r${++rq}`
  await page.evaluate(([id, verb, args]) => window.__agent({ requestId: id, verb, args }), [id, verb, args])
  await page.waitForFunction((id) => !!window.__results[id], id, { timeout: 60000 })
  return page.evaluate((id) => window.__results[id], id)
}
const doc = () => page.evaluate(() => JSON.parse(JSON.stringify(window.beeslides.doc)))
const slideOf = async (id) => (await doc()).slides.find((s) => s.id === id)
const els = async (id) => (await slideOf(id)).elements
const byId = (list) => new Map(list.map((e) => [e.id, e]))

async function addSlide() {
  const r = await act('deck', { op: 'add', slideType: 'layout-blank' })
  const id = /\b(slide-[\w-]+)/.exec(r.summary ?? '')?.[1] ?? (await doc()).slides.at(-1).id
  return id
}

/** the slide as BeeSlides draws it, at 1280×720 */
async function slideShot(slideId) {
  const thumb = page.locator(`.ed-sidebar [data-slide-id="${slideId}"]`).first()
  if (await thumb.count()) { await thumb.scrollIntoViewIfNeeded(); await thumb.click({ position: { x: 30, y: 20 } }) }
  await page.keyboard.press('Escape')
  await page.mouse.move(2, 1040)
  await page.evaluate(() => { document.activeElement?.blur?.(); document.documentElement.classList.add('ed-capturing') })
  await page.waitForTimeout(450)
  const buf = await page.locator('.ed-stage-scale').first().screenshot()
  await page.evaluate(() => document.documentElement.classList.remove('ed-capturing'))
  return buf
}

/** the same HTML as plain Chrome draws it (the tool's base CSS + theme) */
const htmlPage = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
async function htmlShot(src) {
  const d = await doc()
  const t = d.theme
  const base = [
    `:root{--bs-w:1280px;--bs-h:720px;--bs-margin:96px;--bs-bg:${t.background};--bs-text:${t.color};--bs-accent:${t.accent};--bs-font:${t.fontFamily};--bs-heading-font:${t.headingFamily || t.fontFamily}}`,
    '*,*::before,*::after{box-sizing:border-box}',
    'html,body{margin:0;padding:0;width:1280px;height:720px;overflow:hidden}',
    'body{position:relative;font-family:var(--bs-font);color:var(--bs-text);font-size:24px;line-height:1.2;-webkit-font-smoothing:antialiased;background:var(--bs-bg)}',
    'h1,h2,h3,h4,h5,h6{font-family:var(--bs-heading-font)}',
    'ul,ol{margin:0;padding-inline-start:1.25em}li{margin:0}',
    'code{font-family:ui-monospace,SFMono-Regular,Berkeley Mono,Menlo,Consolas,monospace;font-size:.9em;padding:0 .28em;border-radius:3px;background:rgb(127 127 127/.16)}',
    'pre code{font-size:inherit;padding:0;background:none}', 'img{display:block}',
  ].join('\n')
  await htmlPage.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${base}</style><style>${src.css ?? ''}</style></head><body>${src.html}</body></html>`)
  await htmlPage.waitForTimeout(250)
  return htmlPage.screenshot()
}

/** pixel comparison at 640×360: share of pixels that differ visibly, and a
 *  heat map (differences red over the slide in grey) */
async function compare(a, b, mask = []) {
  return page.evaluate(async ([a, b, mask]) => {
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    const W = 640, H = 360
    const px = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H); return g.getImageData(0, 0, W, H) }
    const da = px(ia), db = px(ib)
    const out = new ImageData(W, H)
    let diff = 0
    const masked = (i) => { const x = (i / 4) % W * 2, y = Math.floor(i / 4 / W) * 2; return mask.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h) }
    let counted = 0
    for (let i = 0; i < da.data.length; i += 4) {
      if (masked(i)) { out.data.set([200, 200, 255, 255], i); continue }
      counted++
      const d = Math.max(Math.abs(da.data[i] - db.data[i]), Math.abs(da.data[i + 1] - db.data[i + 1]), Math.abs(da.data[i + 2] - db.data[i + 2]))
      const grey = (da.data[i] + da.data[i + 1] + da.data[i + 2]) / 3
      if (d > 60) { diff++; out.data.set([230, 40, 40, 255], i) } else out.data.set([grey * 0.5 + 127, grey * 0.5 + 127, grey * 0.5 + 127, 255], i)
    }
    const c = document.createElement('canvas'); c.width = W; c.height = H
    c.getContext('2d').putImageData(out, 0, 0)
    return { share: diff / Math.max(counted, 1), heat: c.toDataURL('image/png') }
  }, [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`, mask])
}

function save(name, buf) {
  if (!shots) return null
  writeFileSync(join(shots, name), buf)
  return name
}
const savePng = (name, dataUrl) => save(name, Buffer.from(dataUrl.split(',')[1], 'base64'))

/** a w×h PNG with a diagonal two-colour gradient (a "photo" to place) */
function gradientPng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = Math.round(40 + 200 * t); raw[o + 1] = Math.round(90 + 60 * (1 - t)); raw[o + 2] = Math.round(200 - 120 * t)
    }
  }
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const PHOTO = `data:image/png;base64,${gradientPng(320, 200).toString('base64')}`

// ---- the cases --------------------------------------------------------------------

const CASES = [
  {
    name: 'cards',
    title: 'Title, subtitle and a flex row of three cards',
    html: `<main class="slide">
  <h1 id="title">Three reasons HTML wins</h1>
  <p id="sub" class="sub">The browser does the layout, so nobody computes a frame.</p>
  <div class="cards">
    <div class="card" id="c1"><h3 id="c1h">Flow</h3><p id="c1p">Flexbox and grid place every box.</p></div>
    <div class="card" id="c2"><h3 id="c2h">Same text engine</h3><p id="c2p">Measured where it is drawn — <b>no surprises</b>.</p></div>
    <div class="card" id="c3"><h3 id="c3h">Round trip</h3><p id="c3p">Read it back, edit, <span class="hl">write again</span>.</p></div>
  </div>
</main>`,
    css: `.slide{width:100%;height:100%;padding:72px 96px;background:#FBF7EF;display:flex;flex-direction:column;gap:20px}
h1{margin:0;font-size:56px;font-weight:800;color:#1E2A3A}
.sub{margin:0;font-size:24px;color:#5A6472}
.cards{display:flex;gap:28px;margin-top:40px}
.card{flex:1;background:#fff;border-radius:18px;padding:28px;box-shadow:0 8px 24px rgba(30,42,58,.12);border-left:6px solid #E8442E}
.card h3{margin:0 0 12px;font-size:30px;color:#1E2A3A}
.card p{margin:0;font-size:22px;line-height:1.4;color:#333}
.hl{color:#E8442E;font-weight:700}`,
    async check(sid) {
      const m = byId(await els(sid))
      const cards = ['c1', 'c2', 'c3'].map((k) => m.get(k))
      ok(cards.every(Boolean) && cards.every((c) => c.type === 'shape'), 'cards: three boxes, ids from the HTML')
      ok(cards.every((c) => c.y === cards[0].y && Math.abs(c.w - cards[0].w) < 0.01), 'cards: same top, same width (flex:1)', cards.map((c) => [c.x, c.y, c.w]))
      ok(Math.abs(cards[1].x - (cards[0].x + cards[0].w) - 28) < 0.01, 'cards: the 28px gap')
      ok(cards[0].x === 96 && Math.abs(cards[2].x + cards[2].w - 1184) < 0.01, 'cards: inside the 96px margins')
      ok(m.get('title')?.role === 'title' && m.get('title')?.fontSize === 56 && m.get('title')?.fontWeight === 800, 'title: h1 → role title, 56px/800')
      ok(/<b>.*color:#e8442e.*write again/i.test(m.get('c3p')?.html ?? ''), 'rich text: a CSS-class run → bold + colour span', m.get('c3p')?.html)
      const t = m.get('c1h'), c = m.get('c1')
      ok(t.x > c.x && t.y > c.y && t.x + t.w < c.x + c.w, 'card title sits inside its card')
      ok(m.get('c1-border-left')?.shape === 'path' && /C/.test(m.get('c1-border-left')?.d ?? ''), 'one-sided border under rounded corners → curved path')
      ok((await slideOf(sid)).background === '#FBF7EF', 'full-slide root box → slide background')
    },
  },
  {
    name: 'hero',
    title: 'Gradient hero: centred headline, pill, rotated sticker, photo',
    html: `<section class="hero">
  <div class="copy">
    <span class="pill" id="pill">NEW · 2026</span>
    <h1 id="headline">Slides from <em>plain</em> HTML</h1>
    <p id="lede">Write it like a web page. Get real, editable slide elements.</p>
  </div>
  <img id="photo" src="${PHOTO}" alt="A colourful gradient">
  <div class="sticker" id="sticker">-30% frames to compute</div>
</section>`,
    css: `.hero{width:1280px;height:720px;background:linear-gradient(135deg,#1B1F3B 0%,#3B2B6B 100%);display:flex;align-items:center;gap:56px;padding:0 96px;color:#fff}
.copy{flex:1;display:flex;flex-direction:column;gap:22px}
.pill{align-self:flex-start;display:block;background:#FFD166;color:#1B1F3B;font-weight:700;font-size:18px;letter-spacing:2px;padding:8px 18px;border-radius:999px}
h1{margin:0;font-size:72px;line-height:1.05;font-weight:800}
#lede{margin:0;font-size:26px;line-height:1.4;color:#D8D4F2}
#photo{width:420px;height:420px;object-fit:cover;border-radius:28px;box-shadow:0 30px 60px rgba(0,0,0,.35)}
.sticker{position:absolute;right:120px;top:96px;background:#EF476F;color:#fff;font-weight:800;font-size:20px;padding:14px 22px;border-radius:14px;transform:rotate(8deg)}`,
    async check(sid) {
      const s = await slideOf(sid), m = byId(s.elements)
      ok(/linear-gradient/.test(s.background), 'gradient root → slide background gradient', s.background)
      ok(m.get('pill')?.type === 'shape' && m.get('pill-text')?.type === 'text', 'pill: a box with text → <id> + <id>-text')
      ok(Math.abs(m.get('pill')?.radius - m.get('pill').h / 2) < 0.02, 'pill: radius 999px → half its height (a real pill)')
      ok(m.get('pill-text')?.letterSpacing === 2, 'letter-spacing kept')
      ok(/<i>plain<\/i>/.test(m.get('headline')?.html ?? ''), 'em → italics in the headline')
      const p = m.get('photo')
      ok(p?.type === 'image' && p.fit === 'cover' && p.radius === 28 && p.w === 420 && p.alt === 'A colourful gradient', 'img → picture: cover, radius, size, alt')
      ok(p && !!p.shadow, 'picture keeps its shadow')
      ok(Math.abs((m.get('sticker')?.rotation ?? 0) - 8) < 0.05 && Math.abs((m.get('sticker-text')?.rotation ?? 0) - 8) < 0.05, 'transform: rotate(8deg) → rotation 8 (box and text)')
      ok(Math.abs(p.y + p.h / 2 - 360) < 0.6, 'align-items:center → photo vertically centred')
    },
  },
  {
    name: 'data',
    title: 'Table, chart and code side by side (grid)',
    // the slide's table spreads its height evenly over the rows; this CSS
    // gives the header row less (the write result says so)
    tolerance: 0.035,
    html: `<div class="wrap">
  <h2 id="dtitle">Quarterly numbers</h2>
  <div class="grid">
    <table id="tbl">
      <thead><tr><th>Region</th><th class="num">Q1</th><th class="num">Q2</th></tr></thead>
      <tbody>
        <tr><td>North</td><td class="num">120</td><td class="num">180</td></tr>
        <tr><td>South</td><td class="num">90</td><td class="num">140</td></tr>
        <tr><td>East</td><td class="num">75</td><td class="num">160</td></tr>
        <tr><td colspan="2"><b>Total</b></td><td class="num">480</td></tr>
      </tbody>
    </table>
    <div id="chart" data-chart='{"preset":"bar","option":{"xAxis":{"type":"category","data":["Q1","Q2","Q3"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[285,480,520]}]}}' aria-label="Revenue per quarter"></div>
  </div>
  <pre id="code">const slide = await html(\`
  &lt;h1&gt;Hello&lt;/h1&gt;\`)</pre>
</div>`,
    css: `.wrap{position:absolute;inset:0;padding:64px 96px;display:flex;flex-direction:column;gap:24px}
h2{margin:0;font-size:44px;color:#1E2A3A}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;height:330px}
table{border-collapse:collapse;width:100%;font-size:22px;color:#1E2A3A;table-layout:fixed}
th{background:#1E2A3A;color:#fff;text-align:left;padding:12px 16px}
td{padding:12px 16px;border-bottom:1px solid #D5DAE1}
tbody tr:nth-child(even) td{background:#F1F4F8}
.num{text-align:right}
#chart{height:330px}
pre{margin:0;background:#0F172A;color:#E2E8F0;font-size:20px;line-height:1.5;padding:18px 24px;border-radius:12px}`,
    async check(sid) {
      const m = byId(await els(sid))
      const t = m.get('tbl')
      ok(t?.type === 'table' && t.header === true && t.rows.length === 5 && t.columns.length === 3, 'table: header row + 4 body rows × 3 columns', t && [t.rows.length, t.columns.length])
      ok(t?.style.headerBg === '#1E2A3A' && t.style.zebra === '#F1F4F8' && t.style.cellPadX === 16, 'table: header colour, zebra, padding from CSS', t?.style)
      ok(t?.rows[4].cells[0].colspan === 2 && t.rows[4].cells.length === 3 && t.rows[4].cells[1].html === '', 'table: colspan + the covered cell kept in the grid')
      ok(t?.rows[1].cells[1].align === 'right', 'table: per-cell alignment')
      const c = m.get('chart')
      ok(c?.type === 'chart' && c.preset === 'bar' && c.option.series[0].data[2] === 520 && c.alt === 'Revenue per quarter', 'data-chart → chart element with its data and alt')
      ok(Math.abs(c.x - (t.x + t.w + 40)) < 0.6, 'grid: chart in the second column, 40px gap')
      const code = m.get('code')
      ok(code?.type === 'code' && code.content.includes('<h1>Hello</h1>') && m.get('code-box')?.fill === '#0F172A', 'pre → code element on its own dark box')
      ok(/share its height evenly/.test(this.result ?? ''), 'the result says the table rows will share the height evenly')
    },
  },
  {
    name: 'list',
    title: 'Two columns: bulleted list and a quote',
    html: `<div class="cols">
  <div class="left">
    <h2 id="ltitle">What it handles</h2>
    <ul id="bul">
      <li><b>Boxes</b> with backgrounds, borders, shadows</li>
      <li>Text with <span style="color:#118AB2">colour</span> and <u>underline</u></li>
      <li>Lists, tables, charts, code, pictures</li>
    </ul>
  </div>
  <blockquote id="quote">“HTML in, slide elements out — and back.”<br><small id="who">— the design</small></blockquote>
</div>`,
    css: `.cols{position:absolute;inset:80px 96px;display:flex;gap:64px}
.left{flex:3}
h2{margin:0 0 24px;font-size:44px}
ul{font-size:28px;line-height:1.5;margin:0}
blockquote{flex:2;margin:0;align-self:center;font-size:34px;line-height:1.3;font-weight:600;color:#3D348B;border-left:8px solid #3D348B;padding:8px 0 8px 28px}
small{font-size:20px;font-weight:400;color:#7678ED}`,
    async check(sid) {
      const m = byId(await els(sid))
      const b = m.get('bul')
      ok(b?.type === 'text' && /<ul><li><b>Boxes<\/b>/.test(b.html) && (b.html.match(/<li>/g) ?? []).length === 3, 'ul → one text element with a real list', b?.html)
      ok(/<u>underline<\/u>/.test(b.html) && /color:#118ab2/i.test(b.html), 'inline underline + colour span kept')
      const q = m.get('quote-text') ?? m.get('quote')
      ok(q?.type === 'text' && /the design/.test(q.html) && /font-size:20px/.test(q.html), 'quote: text with a smaller run (small → size span)', q?.html)
      ok(m.get('quote-border-left')?.type === 'shape' && m.get('quote-border-left').w === 8, 'blockquote border-left → 8px bar')
    },
  },
]

console.log('-- cases: HTML → slide, compared by eye --')
for (const c of CASES) {
  const sid = await addSlide()
  const r = await act('slide_html', { op: 'write', slideId: sid, html: c.html, css: c.css })
  ok(r.ok, `${c.name}: write ok`, r.error)
  if (!r.ok) continue
  c.result = r.summary
  await c.check(sid)
  const a = await htmlShot({ html: c.html, css: c.css })
  const b = await slideShot(sid)
  // plain Chrome draws no chart and no syntax colours: those areas are BeeSlides' own
  const mask = (await els(sid)).filter((e) => e.type === 'chart' || e.type === 'code').map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }))
  const cmp = await compare(a, b, mask)
  ok(cmp.share < (c.tolerance ?? 0.02), `${c.name}: the slide looks like the HTML (${(cmp.share * 100).toFixed(2)}% of pixels differ${mask.length ? `; ${mask.length} chart/code area(s) not compared` : ''})`)
  report.cases.push({
    name: c.name, title: c.title, share: cmp.share, summary: r.summary,
    html: save(`${c.name}-html.png`, a), slide: save(`${c.name}-slide.png`, b), diff: savePng(`${c.name}-diff.png`, cmp.heat),
    source: c.html, css: c.css, elements: (await els(sid)).length,
  })
  c.sid = sid
}

console.log('-- rewrite: in place, keeps fx, one undo step --')
{
  const cards = CASES[0]
  await act('elements', { op: 'edit', slideId: cards.sid, changes: [{ id: 'c1h', fx: { enter: 'fade-up' } }, { id: 'c2', link: CASES[1].sid }] })
  const before = await els(cards.sid)
  const html2 = cards.html.replace('>Flow<', '>Flow, rewritten<').replace(/\s*<div class="card" id="c3">.*?<\/div>\n/s, '\n')
  const r = await act('slide_html', { op: 'write', slideId: cards.sid, html: html2, css: cards.css })
  const m = byId(await els(cards.sid))
  ok(r.ok && /updated in place/.test(r.summary) && /removed \(c3, c3-border-left, c3h, c3p\)/.test(r.summary), 'rewrite reports updated + removed ids', r.summary?.split('\n')[0])
  ok(m.get('c1h')?.html === 'Flow, rewritten' && m.get('c1h')?.fx?.enter === 'fade-up', 'same id: new text, the animation kept')
  ok(m.get('c2')?.link === CASES[1].sid, 'same id: the link kept')
  ok(!m.has('c3') && m.get('c2').w > before.find((e) => e.id === 'c2').w, 'card 3 gone, flex:1 widens the other two')
  await page.evaluate(() => window.beeslides.undo())
  await page.waitForTimeout(300)
  const undone = await els(cards.sid)
  ok(JSON.stringify(undone.map((e) => [e.id, e.x, e.w])) === JSON.stringify(before.map((e) => [e.id, e.x, e.w])), 'one undo restores the slide before the rewrite')
}

console.log('-- read: remembered, then generated --')
{
  const hero = CASES[1]
  const r = await act('slide_html', { op: 'read', slideId: hero.sid })
  ok(r.ok && /the source it was written from/.test(r.summary) && r.summary.includes('<em>plain</em>'), 'read right after a write: the author\'s own HTML')
  ok(!r.summary.includes('data:image/png'), 'remembered source refers to the picture by id, no second copy of its bytes')
  await act('elements', { op: 'edit', slideId: hero.sid, changes: [{ id: 'photo', x: 700 }] })
  const g = await act('slide_html', { op: 'read', slideId: hero.sid })
  ok(g.ok && /generated from the slide/.test(g.summary) && !/land differently/.test(g.summary), 'after an edit: generated, verified HTML', g.summary.split('\n')[0])
  ok(/src="element:photo"/.test(g.summary), 'generated HTML points at the picture (element:photo)')
}

/** read → write back the generated HTML → every frame where it was */
async function roundTrip(sid, label) {
  const before = await els(sid)
  const shotA = await slideShot(sid)
  const r = await act('slide_html', { op: 'read', slideId: sid })
  if (!r.ok) return { ok: false, why: r.error }
  const text = r.summary
  const css = text.slice(text.indexOf('<style>\n') + 8, text.indexOf('\n</style>'))
  const html = text.slice(text.indexOf('\n</style>\n') + 10)
  const exact = !/land differently/.test(text)
  const w = await act('slide_html', { op: 'write', slideId: sid, html, css, reflow: false })
  if (!w.ok) return { ok: false, why: w.error }
  const after = byId(await els(sid))
  let worst = 0, worstId = '', missing = []
  for (const e of before) {
    const a = after.get(e.id)
    if (!a) { missing.push(e.id); continue }
    const d = Math.max(Math.abs(a.x - e.x), Math.abs(a.y - e.y), Math.abs(a.w - e.w), Math.abs(a.h - e.h))
    if (d > worst) { worst = d; worstId = e.id }
  }
  const shotB = await slideShot(sid)
  const cmp = await compare(shotA, shotB)
  const groups = Number(/\((\d+) flex row\/column group/.exec(text)?.[1] ?? 0)
  return { ok: true, exact, worst, worstId, missing, share: cmp.share, groups, label, shotA, shotB, heat: cmp.heat, html }
}

console.log('-- round trip on the cases --')
for (const c of CASES.slice(1)) {
  // make the remembered source stale first, so read has to generate
  const first = (await els(c.sid))[0]
  await act('elements', { op: 'edit', slideId: c.sid, changes: [{ id: first.id, opacity: 0.99 }] })
  const rt = await roundTrip(c.sid, c.name)
  ok(rt.ok && rt.exact && rt.worst <= 1 && !rt.missing.length, `${c.name}: generated HTML written back moves nothing (worst ${rt.worst?.toFixed?.(2)}px ${rt.worstId}, ${rt.groups} flex groups)`, rt.why ?? rt.missing)
}

console.log('-- round trip on real decks --')
const decks = [
  ...readdirSync(join(root, 'docs/examples')).filter((f) => f.endsWith('.beeslides.html')).map((f) => join(root, 'docs/examples', f)),
  ...readdirSync(join(root, 'scripts/starter-library')).filter((f) => /\.(beeslides|slidomingo)\.html$/.test(f)).map((f) => join(root, 'scripts/starter-library', f)),
]
for (const file of decks) {
  const text = readFileSync(file, 'utf8')
  const m = /<script type="application\/(?:beeslides|slidomingo)\+json" id="(?:beeslides|slidomingo)-doc">([\s\S]*?)<\/script>/.exec(text)
  if (!m) { console.log(`  skip  ${file} (no plaintext doc block)`); continue }
  await page.evaluate((json) => window.beeslides.loadDoc(json), m[1])
  await page.waitForTimeout(600)
  const d = await doc()
  const name = file.split('/').pop()
  let exact = 0, total = 0, worst = 0, groups = 0
  for (const s of d.slides.slice(0, 40)) {
    if (s.hidden) continue
    total++
    const rt = await roundTrip(s.id, `${name} · ${s.name || s.id}`)
    if (!rt.ok) { ok(false, `${name} ${s.id}: round trip`, rt.why); continue }
    if (rt.exact && rt.worst <= 1 && !rt.missing.length) exact++
    else console.log(`        ${s.id}: worst ${rt.worst.toFixed(2)}px (${rt.worstId}), missing ${rt.missing.length}, verified ${rt.exact}`)
    worst = Math.max(worst, rt.worst)
    groups += rt.groups
    if (report.roundtrips.length < 24 && shots) {
      const k = report.roundtrips.length
      report.roundtrips.push({ label: rt.label, share: rt.share, worst: rt.worst, groups: rt.groups, before: save(`rt${k}-before.png`, rt.shotA), after: save(`rt${k}-after.png`, rt.shotB), diff: savePng(`rt${k}-diff.png`, rt.heat), html: rt.html.slice(0, 4000) })
    }
  }
  ok(exact === total, `${name}: ${exact}/${total} slides read → write back with every frame within 1px (worst ${worst.toFixed(2)}px; ${groups} flex groups found)`)
}

console.log('-- nothing runs, nothing loads --')
{
  const sid = await addSlide()
  requests.length = 0
  const evil = `<div id="a" style="background:url(https://example.com/x.png);width:200px;height:100px">Hi</div>
<img id="b" src="https://example.com/track.png" onerror="window.__ran++">
<script>window.__ran++</script><iframe src="https://example.com"></iframe>
<svg><circle r="10"/></svg>
<div id="c" onclick="window.__ran++" style="width:100px;height:40px;background:#123456"></div>`
  const r = await act('slide_html', { op: 'write', slideId: sid, html: evil, css: '@import url(https://example.com/a.css); #a{color:red}' })
  await page.waitForTimeout(500)
  ok(r.ok, 'hostile HTML still writes what is safe')
  ok(await page.evaluate(() => window.__ran) === 0, 'no script or handler ran')
  ok(requests.length === 0, 'no network request was made', requests)
  ok(/left out/.test(r.summary) && /svg/i.test(r.summary), 'the result says what was left out')
  const m = byId(await els(sid))
  ok(!m.has('b') && m.get('c')?.fill === '#123456' && m.get('a')?.type === 'text', 'external picture dropped, safe boxes kept')
}

ok(!errors.length, 'no page errors while working', errors)
if (bootErrors.length) console.log(`  note  page errors while booting (not from this tool): ${bootErrors.join(' | ')}`)

if (shots) writeFileSync(join(shots, 'report.json'), JSON.stringify(report, null, 1))
await browser.close()
console.log(`\ntest-slide-html-e2e: ${checks - failures}/${checks} checks passed${shots ? ` — screenshots in ${shots}` : ''}`)
process.exit(failures ? 1 : 0)
